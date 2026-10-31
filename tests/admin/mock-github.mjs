// tests/admin/mock-github.mjs
// -----------------------------------------------------------------------------
// 测试用的「假 GitHub」：一个只用 Node 内置模块写成的 HTTP 服务器，包含
//   1. 内存里的 git 对象库（真实的 git SHA-1，blob / tree / commit / ref），
//      并在 /__mockapi 下模拟管理后台用到的 GitHub REST 接口（ADMIN_SPEC §5.3）；
//   2. 静态文件服务：把一个 Hugo 构建产物目录（siteDir）挂在 / 下，
//      MIME 类型正确，可以直接跑 ES-module 写的 /admin/；
//   3. 辅助函数：exportTo（把当前仓库内容导出成目录）、buildSite（用固定版本的
//      Hugo 构建）、openAdmin（Playwright 里一键登录后台）。
//
// Mock 尽量「和 GitHub 一样严格」：同样的 JSON 字段名、状态码、带换行的 base64、
// 非快进更新返回 422、令牌错误返回 401、GET 响应带 60 秒缓存头等——这样在测试里
// 能暴露的问题，上线后就不会再遇到。
// -----------------------------------------------------------------------------

import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** Repository root (this file lives in tests/admin/). */
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The PaperMod theme checkout that exported trees symlink to. */
export const THEME_DIR = (() => {
  const local = path.join(REPO_ROOT, 'themes', 'PaperMod');
  return fs.existsSync(path.join(local, 'theme.toml')) ? local : '/home/user/HimZFX.github.io/themes/PaperMod';
})();

/** Hugo binary pinned to the CI version (override with env HUGO_BIN). */
export const DEFAULT_HUGO_BIN =
  '/tmp/claude-0/-home-user-HimZFX-github-io/8c969300-4668-5db9-ba53-1e03ed6529c8/scratchpad/hugo/hugo';

export function hugoBin() {
  return process.env.HUGO_BIN || DEFAULT_HUGO_BIN;
}

const API_PREFIX = '/__mockapi';
const DOCS_URL = 'https://docs.github.com/rest';
const RATE_LIMIT = 5000;
const SUPPORTED_API_VERSIONS = new Set(['2022-11-28']);
const MAX_BODY_BYTES = 150 * 1024 * 1024; // GitHub accepts blobs up to 100 MB (≈134 MB as base64)

// -----------------------------------------------------------------------------
// git object store (real SHA-1s)
// -----------------------------------------------------------------------------

function gitHash(type, body) {
  return crypto.createHash('sha1').update(`${type} ${body.length}\0`).update(body).digest('hex');
}

/** git sorts tree entries bytewise by name, with sub-trees compared as `name/`. */
function compareTreeEntries(a, b) {
  const ka = Buffer.from(a.type === 'tree' ? a.name + '/' : a.name);
  const kb = Buffer.from(b.type === 'tree' ? b.name + '/' : b.name);
  return Buffer.compare(ka, kb);
}

function typeForMode(mode) {
  if (mode === '040000') return 'tree';
  if (mode === '160000') return 'commit';
  return 'blob';
}

class ObjectStore {
  constructor() {
    /** @type {Map<string, any>} sha → { type:'blob', data } | { type:'tree', entries } | { type:'commit', ... } */
    this.objects = new Map();
  }

  get(sha) {
    return typeof sha === 'string' ? this.objects.get(sha.toLowerCase()) : undefined;
  }

  putBlob(data) {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const sha = gitHash('blob', buf);
    if (!this.objects.has(sha)) this.objects.set(sha, { type: 'blob', data: buf });
    return sha;
  }

  /** entries: [{ name, mode: '100644'|'100755'|'120000'|'040000'|'160000', type, sha }] */
  putTree(entries) {
    const sorted = [...entries].sort(compareTreeEntries);
    const parts = [];
    for (const e of sorted) {
      const mode = e.mode === '040000' ? '40000' : e.mode; // git writes tree mode without leading 0
      parts.push(Buffer.from(`${mode} ${e.name}\0`), Buffer.from(e.sha, 'hex'));
    }
    const sha = gitHash('tree', Buffer.concat(parts));
    if (!this.objects.has(sha)) this.objects.set(sha, { type: 'tree', entries: sorted });
    return sha;
  }

  putCommit({ tree, parents, message, author, committer }) {
    const sig = (p) => `${p.name} <${p.email}> ${Math.floor(Date.parse(p.date) / 1000)} +0000`;
    let text = `tree ${tree}\n`;
    for (const p of parents) text += `parent ${p}\n`;
    text += `author ${sig(author)}\ncommitter ${sig(committer)}\n\n${message}`;
    const sha = gitHash('commit', Buffer.from(text));
    if (!this.objects.has(sha)) {
      this.objects.set(sha, { type: 'commit', tree, parents: [...parents], message, author, committer });
    }
    return sha;
  }

  /** Flatten a tree to Map<path, { mode, type, sha }> of leaves (blobs + submodule commits). */
  flatten(treeSha, prefix = '', out = new Map()) {
    const tree = this.get(treeSha);
    if (!tree || tree.type !== 'tree') throw new Error(`not a tree: ${treeSha}`);
    for (const e of tree.entries) {
      const p = prefix + e.name;
      if (e.type === 'tree') this.flatten(e.sha, p + '/', out);
      else out.set(p, { mode: e.mode, type: e.type, sha: e.sha });
    }
    return out;
  }

  /** Recursive listing in GitHub order (pre-order, tree entry before its children). */
  listRecursive(treeSha, prefix = '', out = []) {
    const tree = this.get(treeSha);
    for (const e of tree.entries) {
      const p = prefix + e.name;
      out.push({ path: p, mode: e.mode, type: e.type, sha: e.sha });
      if (e.type === 'tree') this.listRecursive(e.sha, p + '/', out);
    }
    return out;
  }

  /** Build (and store) nested trees from a flat Map<path, leaf>. Returns the root tree sha. */
  buildTree(flat) {
    const root = new Map();
    for (const [p, leaf] of flat) {
      const segs = p.split('/');
      let dir = root;
      for (let i = 0; i < segs.length - 1; i++) {
        let node = dir.get(segs[i]);
        if (!node) {
          node = { children: new Map() };
          dir.set(segs[i], node);
        } else if (!node.children) {
          throw new HttpError(422, `tree.path ${p} conflicts with the file ${segs.slice(0, i + 1).join('/')}`);
        }
        dir = node.children;
      }
      const name = segs[segs.length - 1];
      const existing = dir.get(name);
      if (existing && existing.children) {
        throw new HttpError(422, `tree.path ${p} conflicts with an existing directory`);
      }
      dir.set(name, { leaf });
    }
    const write = (dir) => {
      const entries = [];
      for (const [name, node] of dir) {
        if (node.children) entries.push({ name, mode: '040000', type: 'tree', sha: write(node.children) });
        else entries.push({ name, mode: node.leaf.mode, type: node.leaf.type, sha: node.leaf.sha });
      }
      return this.putTree(entries);
    };
    return write(root);
  }

  isAncestor(ancestor, descendant) {
    const seen = new Set();
    const stack = [descendant];
    while (stack.length) {
      const sha = stack.pop();
      if (sha === ancestor) return true;
      if (seen.has(sha)) continue;
      seen.add(sha);
      const c = this.get(sha);
      if (c && c.type === 'commit') stack.push(...c.parents);
    }
    return false;
  }
}

// -----------------------------------------------------------------------------
// helpers
// -----------------------------------------------------------------------------

class HttpError extends Error {
  constructor(status, message, { headers, extra } = {}) {
    super(message);
    this.status = status;
    this.headers = headers || {};
    this.extra = extra || {};
  }
}

/** GitHub (Ruby `Base64.encode64`) wraps base64 at 60 chars and ends every line with '\n'. */
function githubBase64(buf) {
  const b64 = buf.toString('base64');
  let out = '';
  for (let i = 0; i < b64.length; i += 60) out += b64.slice(i, i + 60) + '\n';
  return out;
}

function isoSeconds(ms = Date.now()) {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function nodeId(prefix, sha) {
  return prefix + Buffer.from(String(sha)).toString('base64').replace(/=+$/, '').slice(0, 24);
}

function isSha(s) {
  return typeof s === 'string' && /^[0-9a-f]{40}$/i.test(s);
}

/** Valid git path: no leading/trailing slash, no empty, '.' or '..' segments, no NUL. */
function isValidGitPath(p) {
  if (typeof p !== 'string' || p === '' || p.includes('\0')) return false;
  return p.split('/').every((s) => s !== '' && s !== '.' && s !== '..' && s !== '.git');
}

function walkDir(root, rel = '', out = []) {
  for (const ent of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${ent.name}` : ent.name;
    if (['.git', 'node_modules', 'public', 'resources'].includes(ent.name) && !rel) continue;
    if (ent.isDirectory()) walkDir(root, r, out);
    else out.push(r);
  }
  return out;
}

/** Refuse to export/build into (or over) the real repository. */
function assertOutsideRepo(dir, what) {
  const abs = path.resolve(dir);
  const repo = path.resolve(REPO_ROOT);
  const rel = path.relative(repo, abs);
  const inside = rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  const ancestor = !path.relative(abs, repo).startsWith('..');
  if (inside || ancestor || abs === path.parse(abs).root) {
    throw new Error(`${what}: refusing to use ${abs} (inside or above the repository ${repo})`);
  }
  return abs;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.xml': 'application/xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.bmp': 'image/bmp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.eot': 'application/vnd.ms-fontobject',
  '.wasm': 'application/wasm',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
};

/** MIME type for a file name (exported for tests). */
export function mimeType(file) {
  return MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
}

const AVATAR_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 96 96">' +
  '<rect width="96" height="96" rx="48" fill="#07c160"/>' +
  '<text x="48" y="60" font-size="40" text-anchor="middle" fill="#fff" font-family="sans-serif">H</text></svg>';

// -----------------------------------------------------------------------------
// startMock
// -----------------------------------------------------------------------------

/**
 * Start the mock GitHub API + static site server on 127.0.0.1.
 *
 * @param {object} [opts]
 * @param {string|null} [opts.seedDir=REPO_ROOT]  working tree to seed `main` from (git ls-files
 *        --cached --others --exclude-standard, without themes/ contents). null = start empty.
 * @param {Record<string,string|Buffer>} [opts.seedFiles]  extra files merged over the seed.
 * @param {string} [opts.siteDir]   Hugo build output served at `/`.
 * @param {string} [opts.adminDir]  if set, `/admin/*` is served from here instead of siteDir
 *        (when neither has an admin/ folder, the repo's static/admin is used).
 * @param {number} [opts.port=0]
 * @param {string} [opts.token='test-token']
 * @param {number} [opts.runDelayMs=1500]  Actions runs go queued → in_progress → completed over this time.
 * @param {string} [opts.owner='HimZFX'] @param {string} [opts.repo='HimZFX.github.io'] @param {string} [opts.branch='main']
 * @param {boolean} [opts.cacheHeaders=true]  send GitHub's `Cache-Control: private, max-age=60` on GETs
 *        (browsers DO cache those — clients must use `cache: 'no-store'` for mutable reads).
 * @returns {Promise<MockGitHub>}
 */
export async function startMock({
  seedDir = REPO_ROOT,
  seedFiles,
  siteDir,
  adminDir,
  port = 0,
  token = 'test-token',
  runDelayMs = 1500,
  owner = 'HimZFX',
  repo = 'HimZFX.github.io',
  branch = 'main',
  cacheHeaders = true,
} = {}) {
  const store = new ObjectStore();
  const refs = new Map(); // 'heads/main' → commit sha
  const state = {
    token,
    rateRemaining: RATE_LIMIT,
    rateReset: Math.floor(Date.now() / 1000) + 3600,
    actionsAccess: true,
    runConclusion: 'success',
    runDelayMs,
    apiDelayMs: 0,
    permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
    contentsWrite: true,
    injections: [],
  };
  const runs = [];
  let nextRunId = 9000000001;
  const commits = [];
  const requests = [];

  const user = {
    login: owner,
    id: 87654321,
    name: owner,
    email: `${owner.toLowerCase()}@users.noreply.github.com`,
  };
  const mockAuthor = () => ({ name: user.name, email: user.email, date: isoSeconds() });

  // ---- seed ----------------------------------------------------------------
  const seedFlat = new Map();
  if (seedDir) seedFromDir(seedDir, seedFlat);
  if (seedFiles) {
    const entries = seedFiles instanceof Map ? seedFiles.entries() : Object.entries(seedFiles);
    for (const [p, content] of entries) {
      if (!isValidGitPath(p)) throw new Error(`seedFiles: bad path ${p}`);
      if (content == null) seedFlat.delete(p);
      else seedFlat.set(p, { mode: '100644', type: 'blob', sha: store.putBlob(content) });
    }
  }
  const seedTree = store.buildTree(seedFlat);
  const seedCommit = store.putCommit({
    tree: seedTree,
    parents: [],
    message: 'mock: seed from working tree',
    author: mockAuthor(),
    committer: mockAuthor(),
  });
  refs.set(`heads/${branch}`, seedCommit);

  function seedFromDir(dir, flat) {
    let paths;
    const gitlinks = new Map();
    try {
      const out = execFileSync('git', ['-C', dir, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
        maxBuffer: 64 * 1024 * 1024,
      });
      paths = out.toString('utf8').split('\0').filter(Boolean);
      const staged = execFileSync('git', ['-C', dir, 'ls-files', '-z', '-s'], { maxBuffer: 64 * 1024 * 1024 });
      for (const line of staged.toString('utf8').split('\0')) {
        const m = /^160000 ([0-9a-f]{40}) \d+\t(.+)$/.exec(line);
        if (m) gitlinks.set(m[2], m[1]);
      }
    } catch {
      paths = walkDir(dir); // not a git checkout: take every file
    }
    for (const p of [...new Set(paths)]) {
      if (gitlinks.has(p)) {
        // Submodule (themes/PaperMod): GitHub lists it as a `commit` entry; its files are not in the tree.
        flat.set(p, { mode: '160000', type: 'commit', sha: gitlinks.get(p) });
        continue;
      }
      if (p.startsWith('themes/') || !isValidGitPath(p)) continue;
      const abs = path.join(dir, p);
      let st;
      try {
        st = fs.lstatSync(abs);
      } catch {
        continue; // deleted in the working tree
      }
      if (st.isSymbolicLink()) {
        flat.set(p, { mode: '120000', type: 'blob', sha: store.putBlob(Buffer.from(fs.readlinkSync(abs))) });
      } else if (st.isFile()) {
        const mode = st.mode & 0o111 ? '100755' : '100644';
        flat.set(p, { mode, type: 'blob', sha: store.putBlob(fs.readFileSync(abs)) });
      }
    }
  }

  // ---- repo state helpers ----------------------------------------------------
  const headSha = () => refs.get(`heads/${branch}`);
  const headTree = () => store.get(headSha()).tree;

  function diffTrees(oldTree, newTree) {
    const a = store.flatten(oldTree);
    const b = store.flatten(newTree);
    const changes = [];
    for (const [p, e] of b) {
      if (!a.has(p)) changes.push({ path: p, status: 'added' });
      else if (a.get(p).sha !== e.sha || a.get(p).mode !== e.mode) changes.push({ path: p, status: 'modified' });
    }
    for (const p of a.keys()) if (!b.has(p)) changes.push({ path: p, status: 'removed' });
    return changes.sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0));
  }

  /** Move a branch; records a push (Actions run) and, for API pushes, entries in `commits`. */
  function moveRef(refName, newSha, { external = false } = {}) {
    const oldSha = refs.get(refName);
    if (oldSha === newSha) return;
    refs.set(refName, newSha);
    if (refName !== `heads/${branch}`) return;
    // Commits that became reachable, oldest first (normally exactly one).
    const landed = [];
    const seen = new Set();
    const stack = [newSha];
    while (stack.length) {
      const sha = stack.pop();
      if (seen.has(sha) || (oldSha && store.isAncestor(sha, oldSha))) continue;
      seen.add(sha);
      landed.push(sha);
      stack.push(...store.get(sha).parents);
    }
    landed.reverse();
    if (!external) {
      for (const sha of landed) {
        const c = store.get(sha);
        const parentTree = c.parents.length ? store.get(c.parents[0]).tree : store.putTree([]);
        commits.push({
          sha,
          message: c.message,
          parents: [...c.parents],
          tree: c.tree,
          changes: diffTrees(parentTree, c.tree),
          at: Date.now(),
        });
      }
    }
    const c = store.get(newSha);
    runs.push({
      id: nextRunId++,
      runNumber: runs.length + 1,
      headSha: newSha,
      title: String(c.message).split('\n')[0],
      created: Date.now(),
      conclusion: state.runConclusion,
      delay: state.runDelayMs,
      commit: c,
    });
  }

  /** Commit a set of file changes directly on the branch (an "external push"). */
  function externalCommit(changes, message) {
    const flat = store.flatten(headTree());
    for (const [p, content] of changes) {
      if (!isValidGitPath(p)) throw new Error(`setFile: bad path ${p}`);
      if (content == null) flat.delete(p);
      else flat.set(p, { mode: flat.get(p)?.mode || '100644', type: 'blob', sha: store.putBlob(content) });
    }
    const tree = store.buildTree(flat);
    const sha = store.putCommit({
      tree,
      parents: [headSha()],
      message,
      author: { name: 'someone-else', email: 'someone-else@example.com', date: isoSeconds() },
      committer: { name: 'GitHub', email: 'noreply@github.com', date: isoSeconds() },
    });
    moveRef(`heads/${branch}`, sha, { external: true });
    return sha;
  }

  // ---- JSON shapes -------------------------------------------------------------
  let apiBase = ''; // filled in after listen()
  let baseUrl = '';
  const repoApi = () => `${apiBase}/repos/${owner}/${repo}`;
  const htmlRepo = `https://github.com/${owner}/${repo}`;

  const userJson = () => ({
    login: user.login,
    id: user.id,
    node_id: nodeId('MDQ6VXNlcj', user.id),
    avatar_url: `${baseUrl}/__mock/avatar.svg`,
    gravatar_id: '',
    url: `${apiBase}/users/${user.login}`,
    html_url: `https://github.com/${user.login}`,
    type: 'User',
    site_admin: false,
    name: user.name,
  });

  const repoJson = () => ({
    id: 123456789,
    node_id: nodeId('R_', repo),
    name: repo,
    full_name: `${owner}/${repo}`,
    private: false,
    owner: { login: owner, id: user.id, type: 'User', avatar_url: `${baseUrl}/__mock/avatar.svg`, html_url: `https://github.com/${owner}` },
    html_url: htmlRepo,
    description: 'Personal Hugo site (mock)',
    fork: false,
    url: repoApi(),
    default_branch: branch,
    visibility: 'public',
    has_pages: true,
    archived: false,
    disabled: false,
    created_at: '2024-01-01T00:00:00Z',
    updated_at: isoSeconds(),
    pushed_at: isoSeconds(),
    permissions: { ...state.permissions },
  });

  const refJson = (name) => ({
    ref: `refs/${name}`,
    node_id: nodeId('REF_', name),
    url: `${repoApi()}/git/refs/${name}`,
    object: { sha: refs.get(name), type: 'commit', url: `${repoApi()}/git/commits/${refs.get(name)}` },
  });

  const commitJson = (sha) => {
    const c = store.get(sha);
    return {
      sha,
      node_id: nodeId('C_', sha),
      url: `${repoApi()}/git/commits/${sha}`,
      html_url: `${htmlRepo}/commit/${sha}`,
      author: { ...c.author },
      committer: { ...c.committer },
      tree: { sha: c.tree, url: `${repoApi()}/git/trees/${c.tree}` },
      message: c.message,
      parents: c.parents.map((p) => ({ sha: p, url: `${repoApi()}/git/commits/${p}`, html_url: `${htmlRepo}/commit/${p}` })),
      verification: { verified: false, reason: 'unsigned', signature: null, payload: null, verified_at: null },
    };
  };

  const treeEntryJson = (e) => {
    const out = { path: e.path ?? e.name, mode: e.mode, type: e.type, sha: e.sha };
    if (e.type === 'blob') {
      out.size = store.get(e.sha).data.length;
      out.url = `${repoApi()}/git/blobs/${e.sha}`;
    } else if (e.type === 'tree') {
      out.url = `${repoApi()}/git/trees/${e.sha}`;
    }
    return out;
  };

  const treeJson = (sha, recursive) => ({
    sha,
    url: `${repoApi()}/git/trees/${sha}`,
    tree: (recursive ? store.listRecursive(sha) : store.get(sha).entries).map(treeEntryJson),
    truncated: false,
  });

  function runJson(r) {
    const elapsed = Date.now() - r.created;
    let status = 'completed';
    if (elapsed < r.delay * 0.25) status = 'queued';
    else if (elapsed < r.delay) status = 'in_progress';
    const ts = isoSeconds(r.created);
    return {
      id: r.id,
      name: 'Deploy Hugo site to Pages',
      node_id: nodeId('WFR_', r.id),
      head_branch: branch,
      head_sha: r.headSha,
      path: '.github/workflows/hugo.yml',
      display_title: r.title,
      run_number: r.runNumber,
      event: 'push',
      status,
      conclusion: status === 'completed' ? r.conclusion : null,
      workflow_id: 100200300,
      url: `${repoApi()}/actions/runs/${r.id}`,
      html_url: `${htmlRepo}/actions/runs/${r.id}`,
      created_at: ts,
      updated_at: isoSeconds(status === 'completed' ? r.created + r.delay : Date.now()),
      run_attempt: 1,
      run_started_at: ts,
      head_commit: {
        id: r.headSha,
        tree_id: r.commit.tree,
        message: r.commit.message,
        timestamp: r.commit.committer.date,
        author: { name: r.commit.author.name, email: r.commit.author.email },
        committer: { name: r.commit.committer.name, email: r.commit.committer.email },
      },
    };
  }

  // ---- API routes -------------------------------------------------------------
  function resolveTreeish(id) {
    if (refs.has(`heads/${id}`)) id = refs.get(`heads/${id}`);
    const obj = store.get(id);
    if (obj?.type === 'tree') return id.toLowerCase();
    if (obj?.type === 'commit') return obj.tree;
    return null;
  }

  function apiCreateBlob(body) {
    const { content, encoding = 'utf-8' } = body;
    if (typeof content !== 'string') {
      throw new HttpError(422, "Invalid request.\n\nFor 'properties/content', nil is not a string.");
    }
    let buf;
    if (encoding === 'utf-8') buf = Buffer.from(content, 'utf8');
    else if (encoding === 'base64') {
      const clean = content.replace(/\s+/g, '');
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(clean) || clean.length % 4 === 1) {
        throw new HttpError(422, 'Invalid Base64 content: only the standard alphabet (A-Z a-z 0-9 + /) is accepted');
      }
      buf = Buffer.from(clean, 'base64');
    } else {
      throw new HttpError(422, `encoding must be "utf-8" or "base64" (got ${JSON.stringify(encoding)})`);
    }
    const sha = store.putBlob(buf);
    return { status: 201, json: { sha, url: `${repoApi()}/git/blobs/${sha}` }, headers: { location: `${repoApi()}/git/blobs/${sha}` } };
  }

  function apiCreateTree(body) {
    const { base_tree: baseTree, tree } = body;
    if (!Array.isArray(tree)) throw new HttpError(422, "Invalid request.\n\nFor 'properties/tree', nil is not an array.");
    let flat = new Map();
    if (baseTree != null) {
      const obj = store.get(baseTree);
      if (!obj || obj.type !== 'tree') throw new HttpError(422, 'base_tree is not a valid tree oid');
      flat = store.flatten(baseTree);
    }
    const under = (p) => [...flat.keys()].filter((k) => k.startsWith(p + '/'));
    for (const entry of tree) {
      if (!entry || typeof entry !== 'object') throw new HttpError(422, 'Invalid tree info');
      const { path: p, mode, type, sha } = entry;
      if (!isValidGitPath(p)) throw new HttpError(422, `tree.path ${JSON.stringify(p)} contains a malformed path component`);
      if (!['100644', '100755', '040000', '160000', '120000'].includes(mode)) {
        throw new HttpError(422, `Must supply a valid tree.mode (got ${JSON.stringify(mode)} for ${p})`);
      }
      const expectedType = typeForMode(mode);
      if (type !== undefined && type !== expectedType) {
        throw new HttpError(422, `tree.type ${JSON.stringify(type)} does not match tree.mode ${mode} for ${p}`);
      }
      const hasContent = Object.prototype.hasOwnProperty.call(entry, 'content');
      const hasSha = Object.prototype.hasOwnProperty.call(entry, 'sha');
      if (hasContent && hasSha) throw new HttpError(422, `Must supply either tree.sha or tree.content (not both) for ${p}`);
      if (!hasContent && !hasSha) throw new HttpError(422, `Must supply tree.sha or tree.content for ${p}`);

      if (hasSha && sha === null) {
        // Deletion (file or whole directory).
        if (flat.has(p)) flat.delete(p);
        else {
          const kids = under(p);
          if (!kids.length) throw new HttpError(422, `GitRPC::BadObjectState (cannot delete ${p}: path does not exist in base_tree)`);
          for (const k of kids) flat.delete(k);
        }
        continue;
      }
      let leafSha;
      if (hasContent) {
        if (typeof entry.content !== 'string' || expectedType !== 'blob') throw new HttpError(422, `Invalid tree.content for ${p}`);
        leafSha = store.putBlob(Buffer.from(entry.content, 'utf8'));
      } else {
        if (!isSha(sha)) throw new HttpError(422, `tree.sha ${JSON.stringify(sha)} is not a valid ${expectedType}`);
        leafSha = sha.toLowerCase();
        const obj = store.get(leafSha);
        if (expectedType !== 'commit' && (!obj || obj.type !== expectedType)) {
          throw new HttpError(422, `tree.sha ${sha} is not a valid ${expectedType}`);
        }
      }
      // Replace whatever was at p (file or directory).
      flat.delete(p);
      for (const k of under(p)) flat.delete(k);
      // A parent path that is a file cannot become a directory.
      const segs = p.split('/');
      for (let i = 1; i < segs.length; i++) {
        if (flat.has(segs.slice(0, i).join('/'))) {
          throw new HttpError(422, `tree.path ${p} conflicts with the file ${segs.slice(0, i).join('/')}`);
        }
      }
      if (expectedType === 'tree') {
        for (const [sub, leaf] of store.flatten(leafSha)) flat.set(`${p}/${sub}`, leaf);
      } else {
        flat.set(p, { mode, type: expectedType, sha: leafSha });
      }
    }
    const sha = store.buildTree(flat);
    return { status: 201, json: treeJson(sha, false), headers: { location: `${repoApi()}/git/trees/${sha}` } };
  }

  function apiCreateCommit(body) {
    const { message, tree, parents = [], author, committer } = body;
    if (typeof message !== 'string') throw new HttpError(422, 'Invalid request.\n\n"message" wasn\'t supplied.');
    if (typeof tree !== 'string') throw new HttpError(422, 'Invalid request.\n\n"tree" wasn\'t supplied.');
    const t = store.get(tree);
    if (!t || t.type !== 'tree') throw new HttpError(422, 'Tree SHA does not exist');
    if (!Array.isArray(parents)) throw new HttpError(422, "Invalid request.\n\nFor 'properties/parents', must be an array.");
    for (const p of parents) {
      const c = store.get(p);
      if (!c || c.type !== 'commit') throw new HttpError(422, 'Parent SHA does not exist or is not a commit object');
    }
    const sig = (s) => {
      if (s == null) return mockAuthor();
      if (typeof s.name !== 'string' || typeof s.email !== 'string') {
        throw new HttpError(422, 'Invalid request.\n\nauthor/committer must have name and email.');
      }
      const ms = s.date ? Date.parse(s.date) : Date.now();
      if (Number.isNaN(ms)) throw new HttpError(422, 'Invalid request.\n\nauthor/committer date is not a valid ISO 8601 timestamp.');
      return { name: s.name, email: s.email, date: isoSeconds(ms) };
    };
    const a = sig(author);
    const sha = store.putCommit({
      tree: tree.toLowerCase(),
      parents: parents.map((p) => p.toLowerCase()),
      message,
      author: a,
      committer: committer ? sig(committer) : a,
    });
    return { status: 201, json: commitJson(sha), headers: { location: `${repoApi()}/git/commits/${sha}` } };
  }

  function apiUpdateRef(refName, body) {
    if (!refs.has(refName)) throw new HttpError(422, 'Reference does not exist');
    const { sha, force = false } = body;
    if (typeof sha !== 'string') throw new HttpError(422, 'Invalid request.\n\n"sha" wasn\'t supplied.');
    if (typeof force !== 'boolean') throw new HttpError(422, "Invalid request.\n\nFor 'properties/force', must be a boolean.");
    const obj = store.get(sha);
    if (!obj) throw new HttpError(422, 'Object does not exist');
    if (obj.type !== 'commit') throw new HttpError(422, 'Object is not a commit');
    const target = sha.toLowerCase();
    const current = refs.get(refName);
    if (!force && !store.isAncestor(current, target)) throw new HttpError(422, 'Update is not a fast forward');
    moveRef(refName, target);
    return { status: 200, json: refJson(refName) };
  }

  function apiListRuns(query) {
    if (!state.actionsAccess) throw new HttpError(403, 'Resource not accessible by personal access token');
    let list = [...runs].reverse(); // newest first
    const headShaQ = query.get('head_sha');
    if (headShaQ) list = list.filter((r) => r.headSha === headShaQ.toLowerCase());
    const branchQ = query.get('branch');
    if (branchQ && branchQ !== branch) list = [];
    let json = list.map(runJson);
    const statusQ = query.get('status');
    if (statusQ) json = json.filter((r) => r.status === statusQ || r.conclusion === statusQ);
    const perPage = Math.min(100, Math.max(1, Number(query.get('per_page')) || 30));
    const page = Math.max(1, Number(query.get('page')) || 1);
    return { status: 200, json: { total_count: json.length, workflow_runs: json.slice((page - 1) * perPage, page * perPage) } };
  }

  /** Route one authenticated API request. Returns { status, json?, raw?, headers? }. */
  function route(method, apiPath, query, body, accept) {
    if (method === 'GET' && apiPath === '/user') return { status: 200, json: userJson() };
    if (method === 'GET' && apiPath === '/rate_limit') {
      const core = { limit: RATE_LIMIT, remaining: state.rateRemaining, reset: state.rateReset, used: RATE_LIMIT - state.rateRemaining };
      return { status: 200, json: { resources: { core }, rate: core } };
    }
    const m = /^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/.exec(apiPath);
    if (!m) throw new HttpError(404, 'Not Found');
    if (decodeURIComponent(m[1]).toLowerCase() !== owner.toLowerCase() || decodeURIComponent(m[2]).toLowerCase() !== repo.toLowerCase()) {
      throw new HttpError(404, 'Not Found');
    }
    const rest = m[3] || '';
    let r;
    if (rest === '' && method === 'GET') return { status: 200, json: repoJson() };
    // A fine-grained token with Contents: Read-only (or without this repo selected — the repo is public)
    // still sees permissions.push = true on GET /repos (that is the USER's role), but every git write fails.
    if (!state.contentsWrite && method !== 'GET' && rest.startsWith('/git/')) {
      throw new HttpError(403, 'Resource not accessible by personal access token');
    }

    // refs: GET /git/ref/heads/main, GET|PATCH /git/refs/heads/main
    if ((r = /^\/git\/refs?\/(heads\/.+)$/.exec(rest))) {
      const refName = decodeURIComponent(r[1]);
      if (method === 'GET') {
        if (!refs.has(refName)) throw new HttpError(404, 'Not Found');
        return { status: 200, json: refJson(refName) };
      }
      if (method === 'PATCH' && rest.startsWith('/git/refs/')) return apiUpdateRef(refName, body);
      throw new HttpError(404, 'Not Found');
    }
    if ((r = /^\/git\/commits\/([^/]+)$/.exec(rest)) && method === 'GET') {
      const obj = store.get(r[1]);
      if (!obj || obj.type !== 'commit') throw new HttpError(404, 'Not Found');
      return { status: 200, json: commitJson(r[1].toLowerCase()) };
    }
    if (rest === '/git/commits' && method === 'POST') return apiCreateCommit(body);
    if ((r = /^\/git\/trees\/([^/]+)$/.exec(rest)) && method === 'GET') {
      const sha = resolveTreeish(decodeURIComponent(r[1]));
      if (!sha) throw new HttpError(404, 'Not Found');
      const recursive = query.has('recursive') && !['0', 'false', ''].includes(query.get('recursive'));
      return { status: 200, json: treeJson(sha, recursive) };
    }
    if (rest === '/git/trees' && method === 'POST') return apiCreateTree(body);
    if ((r = /^\/git\/blobs\/([^/]+)$/.exec(rest)) && method === 'GET') {
      const obj = store.get(r[1]);
      if (!obj || obj.type !== 'blob') throw new HttpError(404, 'Not Found');
      const sha = r[1].toLowerCase();
      if (/application\/vnd\.github(\.v3)?\.raw/.test(accept || '')) {
        return { status: 200, raw: obj.data, headers: { 'content-type': 'application/vnd.github.raw' } };
      }
      return {
        status: 200,
        json: { sha, node_id: nodeId('B_', sha), size: obj.data.length, url: `${repoApi()}/git/blobs/${sha}`, content: githubBase64(obj.data), encoding: 'base64' },
      };
    }
    if (rest === '/git/blobs' && method === 'POST') return apiCreateBlob(body);
    if (rest === '/actions/runs' && method === 'GET') return apiListRuns(query);
    if ((r = /^\/actions\/runs\/(\d+)$/.exec(rest)) && method === 'GET') {
      if (!state.actionsAccess) throw new HttpError(403, 'Resource not accessible by personal access token');
      const run = runs.find((x) => String(x.id) === r[1]);
      if (!run) throw new HttpError(404, 'Not Found');
      return { status: 200, json: runJson(run) };
    }
    throw new HttpError(404, 'Not Found');
  }

  // ---- HTTP plumbing ----------------------------------------------------------
  function rateHeaders(authed) {
    const limit = authed ? RATE_LIMIT : 60;
    const remaining = authed ? state.rateRemaining : 59;
    return {
      'x-ratelimit-limit': String(limit),
      'x-ratelimit-remaining': String(remaining),
      'x-ratelimit-used': String(limit - remaining),
      'x-ratelimit-reset': String(state.rateReset),
      'x-ratelimit-resource': 'core',
    };
  }

  const CORS = {
    'access-control-allow-origin': '*',
    'access-control-expose-headers':
      'ETag, Link, Location, Retry-After, X-GitHub-OTP, X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Used, ' +
      'X-RateLimit-Resource, X-RateLimit-Reset, X-OAuth-Scopes, X-Accepted-OAuth-Scopes, X-Poll-Interval, ' +
      'X-GitHub-Media-Type, X-GitHub-SSO, X-GitHub-Request-Id, Deprecation, Sunset',
  };

  function readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      req.on('data', (c) => {
        size += c.length;
        if (size > MAX_BODY_BYTES) {
          reject(new HttpError(413, 'Request body too large'));
          req.destroy();
        } else chunks.push(c);
      });
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    });
  }

  function sendJson(res, status, json, headers = {}) {
    const body = status === 204 || status === 304 ? '' : JSON.stringify(json, null, 2);
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'x-github-media-type': 'github.v3; format=json',
      'x-github-api-version-selected': '2022-11-28',
      'x-github-request-id': crypto.randomBytes(8).toString('hex').toUpperCase(),
      ...CORS,
      ...headers,
    });
    res.end(body);
  }

  function errorBody(status, message, extra) {
    return { message, documentation_url: DOCS_URL, status: String(status), ...extra };
  }

  function matchInjection(method, apiPath) {
    const i = state.injections.findIndex((inj) => {
      if (inj.method && inj.method.toUpperCase() !== method) return false;
      if (inj.path instanceof RegExp) return inj.path.test(apiPath);
      if (typeof inj.path === 'string') return apiPath.includes(inj.path);
      return true;
    });
    if (i < 0) return null;
    const inj = state.injections[i];
    if (--inj.times <= 0) state.injections.splice(i, 1);
    return inj;
  }

  async function handleApi(req, res, url) {
    const method = req.method.toUpperCase();
    const apiPath = url.pathname.slice(API_PREFIX.length) || '/';
    const logEntry = { method, path: apiPath + url.search, status: 0, auth: !!req.headers.authorization, at: Date.now() };
    requests.push(logEntry);
    const finish = (status, json, headers) => {
      logEntry.status = status;
      sendJson(res, status, json, headers);
    };

    if (method === 'OPTIONS') {
      logEntry.status = 204;
      res.writeHead(204, {
        ...CORS,
        'access-control-allow-methods': 'GET, POST, PATCH, PUT, DELETE',
        'access-control-allow-headers':
          'Authorization, Content-Type, If-Match, If-Modified-Since, If-None-Match, If-Unmodified-Since, ' +
          'Accept-Encoding, X-GitHub-OTP, X-Requested-With, User-Agent, X-GitHub-Api-Version',
        'access-control-max-age': '86400',
      });
      return res.end();
    }

    let bodyBuf;
    try {
      bodyBuf = await readBody(req);
    } catch (e) {
      return finish(e.status || 400, errorBody(e.status || 400, e.message));
    }
    if (state.apiDelayMs > 0) await new Promise((r) => setTimeout(r, state.apiDelayMs));

    const inj = matchInjection(method, apiPath);
    if (inj) {
      if (inj.delayMs) await new Promise((r) => setTimeout(r, inj.delayMs));
      if (inj.network) {
        logEntry.status = -1;
        return req.socket.destroy();
      }
      if (inj.status) {
        const status = inj.status;
        return finish(status, inj.body ?? errorBody(status, inj.message || http.STATUS_CODES[status] || 'Error'), {
          ...rateHeaders(true),
          ...(inj.headers || {}),
        });
      }
    }

    // Auth: "Authorization: Bearer <token>" or "token <token>".
    const auth = /^(?:bearer|token)\s+(\S+)\s*$/i.exec(req.headers.authorization || '');
    if (!auth) return finish(401, errorBody(401, 'Requires authentication'), rateHeaders(false));
    if (auth[1] !== state.token) return finish(401, errorBody(401, 'Bad credentials'), rateHeaders(false));

    const version = req.headers['x-github-api-version'];
    if (version && !SUPPORTED_API_VERSIONS.has(version)) {
      return finish(400, errorBody(400, `API version ${version} is not supported.`), rateHeaders(true));
    }

    if (state.rateRemaining <= 0) {
      return finish(403, errorBody(403, `API rate limit exceeded for user ID ${user.id}.`), rateHeaders(true));
    }
    state.rateRemaining--;

    let body = {};
    if (bodyBuf.length) {
      try {
        body = JSON.parse(bodyBuf.toString('utf8'));
      } catch {
        return finish(400, errorBody(400, 'Problems parsing JSON'), rateHeaders(true));
      }
      if (body === null || typeof body !== 'object' || Array.isArray(body)) {
        return finish(400, errorBody(400, 'Problems parsing JSON'), rateHeaders(true));
      }
    }

    let result;
    try {
      result = route(method, apiPath, url.searchParams, body, req.headers.accept);
    } catch (e) {
      if (!(e instanceof HttpError)) {
        console.error('[mock-github] internal error', e);
        return finish(500, errorBody(500, 'Server Error'), rateHeaders(true));
      }
      return finish(e.status, errorBody(e.status, e.message, e.extra), { ...rateHeaders(true), ...e.headers });
    }

    const headers = { ...rateHeaders(true), ...(result.headers || {}) };
    if (method === 'GET') {
      // Like api.github.com: GETs are cacheable for 60 s by the browser and carry an ETag.
      const payload = result.raw ?? Buffer.from(JSON.stringify(result.json));
      const etag = `W/"${crypto.createHash('sha1').update(payload).digest('hex')}"`;
      headers.etag = etag;
      if (cacheHeaders) {
        headers['cache-control'] = 'private, max-age=60, s-maxage=60';
        headers.vary = 'Accept, Authorization, Cookie, X-GitHub-OTP, Accept-Encoding';
      }
      const inm = req.headers['if-none-match'];
      if (inm && inm.split(/\s*,\s*/).includes(etag)) {
        state.rateRemaining++; // 304s don't count against the rate limit
        headers['x-ratelimit-remaining'] = String(state.rateRemaining);
        headers['x-ratelimit-used'] = String(RATE_LIMIT - state.rateRemaining);
        logEntry.status = 304;
        res.writeHead(304, { ...CORS, ...headers });
        return res.end();
      }
    } else {
      headers['cache-control'] = 'private, max-age=0, no-cache';
    }
    if (result.raw) {
      logEntry.status = result.status;
      res.writeHead(result.status, { ...CORS, ...headers, 'content-length': result.raw.length });
      return res.end(result.raw);
    }
    return finish(result.status, result.json, headers);
  }

  // ---- static files ---------------------------------------------------------------
  const fallbackAdmin = path.join(REPO_ROOT, 'static', 'admin');
  function rootsFor(pathname) {
    if (pathname === '/admin' || pathname.startsWith('/admin/')) {
      if (adminDir) return { root: path.resolve(adminDir), rel: pathname.slice('/admin'.length) };
      if (!(siteDir && fs.existsSync(path.join(siteDir, 'admin'))) && fs.existsSync(fallbackAdmin)) {
        return { root: fallbackAdmin, rel: pathname.slice('/admin'.length) };
      }
    }
    return siteDir ? { root: path.resolve(siteDir), rel: pathname } : null;
  }

  function sendText(res, status, text, headers = {}) {
    res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', ...headers });
    res.end(text);
  }

  function send404(req, res) {
    const page = siteDir && path.join(siteDir, '404.html');
    if (page && fs.existsSync(page)) {
      const buf = fs.readFileSync(page);
      res.writeHead(404, { 'content-type': MIME['.html'], 'content-length': buf.length, 'cache-control': 'no-store' });
      return res.end(req.method === 'HEAD' ? undefined : buf);
    }
    sendText(res, 404, 'Not Found');
  }

  function handleStatic(req, res, url) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return sendText(res, 405, 'Method Not Allowed', { allow: 'GET, HEAD' });
    let pathname;
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch {
      return sendText(res, 400, 'Bad Request');
    }
    // No traversal: reject '..' segments, NUL and backslashes outright (after decoding).
    if (pathname.includes('\0') || pathname.includes('\\') || pathname.split('/').some((s) => s === '..')) {
      return sendText(res, 400, 'Bad Request');
    }
    if (pathname === '/__mock/avatar.svg') {
      res.writeHead(200, { 'content-type': MIME['.svg'], 'cache-control': 'no-store' });
      return res.end(req.method === 'HEAD' ? undefined : AVATAR_SVG);
    }
    const target = rootsFor(pathname);
    if (!target) return sendText(res, 404, 'Not Found (mock started without siteDir)');
    let realRoot;
    try {
      realRoot = fs.realpathSync(target.root);
    } catch {
      return send404(req, res);
    }
    let file = path.join(realRoot, path.posix.normalize('/' + target.rel));
    let real;
    try {
      real = fs.realpathSync(file);
    } catch {
      return send404(req, res);
    }
    if (real !== realRoot && !real.startsWith(realRoot + path.sep)) return send404(req, res);
    let st = fs.statSync(real);
    if (st.isDirectory()) {
      if (!url.pathname.endsWith('/')) {
        // Like GitHub Pages: /posts/foo → 301 /posts/foo/ (relative URLs depend on it).
        res.writeHead(301, { location: url.pathname + '/' + url.search, 'cache-control': 'no-store' });
        return res.end();
      }
      file = path.join(real, 'index.html');
      try {
        real = fs.realpathSync(file);
        st = fs.statSync(real);
      } catch {
        return send404(req, res);
      }
      if (!real.startsWith(realRoot + path.sep) || !st.isFile()) return send404(req, res);
    }
    if (!st.isFile()) return send404(req, res);
    res.writeHead(200, {
      'content-type': mimeType(real),
      'content-length': st.size,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff', // like GitHub Pages: a wrong MIME type breaks module scripts
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(real).pipe(res);
  }

  const server = http.createServer((req, res) => {
    let url;
    try {
      url = new URL(req.url, 'http://mock.local');
    } catch {
      return sendText(res, 400, 'Bad Request');
    }
    if (url.pathname === API_PREFIX || url.pathname.startsWith(API_PREFIX + '/')) {
      handleApi(req, res, url).catch((e) => {
        console.error('[mock-github] handler crashed', e);
        if (!res.headersSent) sendJson(res, 500, errorBody(500, 'Server Error'));
        else res.destroy();
      });
      return;
    }
    try {
      handleStatic(req, res, url);
    } catch (e) {
      console.error('[mock-github] static error', e);
      if (!res.headersSent) sendText(res, 500, 'Internal Server Error');
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  apiBase = baseUrl + API_PREFIX;

  // ---- public object ----------------------------------------------------------------
  const filesMap = () => {
    const out = new Map();
    for (const [p, e] of store.flatten(headTree())) {
      if (e.type === 'blob') out.set(p, Buffer.from(store.get(e.sha).data));
    }
    return out;
  };

  /** @typedef {ReturnType<typeof Object>} MockGitHub */
  const mock = {
    url: baseUrl,
    apiBase,
    token,
    owner,
    repo,
    branch,
    /** Commits that reached the branch through the API (not seed / setFile), oldest first:
     *  { sha, message, parents, tree, changes: [{ path, status: 'added'|'modified'|'removed' }], at } */
    commits,
    /** API request log: { method, path (incl. query), status, auth (header present), at }. Never contains the token. */
    requests,
    /** Current branch head. */
    head() {
      return { commitSha: headSha(), treeSha: headTree() };
    },
    /** Map<path, Buffer> of every file on the branch head. */
    files: filesMap,
    /** UTF-8 content of a file on the branch head, or undefined. */
    readFile(p) {
      const e = store.flatten(headTree()).get(p);
      return e && e.type === 'blob' ? store.get(e.sha).data.toString('utf8') : undefined;
    },
    /** Raw bytes of a file on the branch head, or undefined. */
    readBytes(p) {
      const e = store.flatten(headTree()).get(p);
      return e && e.type === 'blob' ? Buffer.from(store.get(e.sha).data) : undefined;
    },
    /** Blob sha of a file on the branch head, or undefined. */
    shaOf(p) {
      return store.flatten(headTree()).get(p)?.sha;
    },
    /** Simulate someone else pushing to the branch (content null/undefined = delete). Returns the new commit sha. */
    setFile(p, content, message = `external: update ${p}`) {
      return externalCommit([[p, content]], message);
    },
    /** Same as setFile for several files in one external commit: { path: content|null }. */
    setFiles(changes, message = 'external: update files') {
      return externalCommit(Object.entries(changes), message);
    },
    /** Write the branch head to `dir` (emptied first) with themes/PaperMod symlinked, ready for buildSite. */
    exportTo(dir) {
      const abs = assertOutsideRepo(dir, 'exportTo');
      fs.rmSync(abs, { recursive: true, force: true });
      fs.mkdirSync(abs, { recursive: true });
      for (const [p, e] of store.flatten(headTree())) {
        if (e.type !== 'blob') continue; // submodules: handled by the theme symlink below
        const dest = path.join(abs, p);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        const data = store.get(e.sha).data;
        if (e.mode === '120000') fs.symlinkSync(data.toString('utf8'), dest);
        else fs.writeFileSync(dest, data, { mode: e.mode === '100755' ? 0o755 : 0o644 });
      }
      fs.mkdirSync(path.join(abs, 'themes'), { recursive: true });
      fs.rmSync(path.join(abs, 'themes', 'PaperMod'), { recursive: true, force: true });
      fs.symlinkSync(THEME_DIR, path.join(abs, 'themes', 'PaperMod'), 'dir');
      return abs;
    },
    // ---- knobs for error-path tests (not in the spec; optional) ----
    /** Change the accepted token (e.g. to simulate a revoked token → 401). */
    setToken(t) {
      state.token = t;
    },
    /** Set x-ratelimit-remaining; 0 → every call gets 403 "API rate limit exceeded". */
    setRateLimitRemaining(n) {
      state.rateRemaining = n;
    },
    /** false → actions endpoints return 403 (token without Actions permission). */
    setActionsAccess(ok) {
      state.actionsAccess = !!ok;
    },
    /** Conclusion of future Actions runs: 'success' | 'failure' | 'cancelled'. */
    setRunConclusion(c) {
      state.runConclusion = c;
    },
    /** Duration of future Actions runs. */
    setRunDelay(ms) {
      state.runDelayMs = ms;
    },
    /** Delay every API response (to observe busy/progress UI). */
    setApiDelay(ms) {
      state.apiDelayMs = ms;
    },
    /**
     * false → the token behaves like a real read-only fine-grained PAT: GET /repos still says push: true,
     * but POST git/blobs|trees|commits and PATCH git/refs return 403 "Resource not accessible by personal access token".
     */
    setContentsWrite(ok) {
      state.contentsWrite = !!ok;
    },
    /** Repo permissions returned by GET /repos/{o}/{r} (e.g. { push: false } — the USER's role, not the token's). */
    setPermissions(p) {
      Object.assign(state.permissions, p);
    },
    /**
     * Make the next matching API call(s) fail.
     * match: { method?, path?: string (substring of the API path) | RegExp }
     * opts: { status?, message?, body?, headers?, times = 1, delayMs?, network? (drop the connection) }
     */
    failNext(match = {}, { status = 500, message, body, headers, times = 1, delayMs, network = false } = {}) {
      state.injections.push({ ...match, status: network ? 0 : status, message, body, headers, times, delayMs, network });
    },
    /** Stop the server (also drops keep-alive connections). */
    close() {
      return new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      });
    },
  };
  return mock;
}

// -----------------------------------------------------------------------------
// Hugo build
// -----------------------------------------------------------------------------

/**
 * Build a site with the pinned Hugo (env HUGO_BIN). Never writes into `repoDir`
 * (no build lock, resources/cache redirected next to outDir), so it is safe to build the
 * real repository directly. outDir must not be inside the repository.
 *
 * @param {object} o
 * @param {string} o.repoDir   Hugo source (an exportTo() dir or REPO_ROOT)
 * @param {string} o.outDir    destination (cleaned by Hugo)
 * @param {boolean} [o.minify=true]  same as CI (`hugo --minify`)
 * @param {string} [o.baseURL] override baseURL. To make the site's own links work when served by a mock,
 *        start the mock first (siteDir may not exist yet) and build with baseURL: mock.url + '/'.
 * @param {string[]} [o.extraArgs]
 * @param {number} [o.timeoutMs=300000]
 * @returns {Promise<{ outDir: string, stdout: string, stderr: string, ms: number }>}
 */
export async function buildSite({ repoDir, outDir, minify = true, baseURL, extraArgs = [], timeoutMs = 300000 } = {}) {
  if (!repoDir || !outDir) throw new Error('buildSite: repoDir and outDir are required');
  const src = path.resolve(repoDir);
  const out = assertOutsideRepo(outDir, 'buildSite');
  if (baseURL && minify && !/^https?:\/\//.test(baseURL)) {
    // PaperMod's JSON-LD becomes invalid JSON with a relative baseURL and Hugo's minifier then fails.
    throw new Error('buildSite: baseURL must be absolute when minify is on (e.g. mock.url + "/"), or pass minify: false');
  }
  const bin = hugoBin();
  if (!fs.existsSync(bin)) throw new Error(`buildSite: Hugo binary not found at ${bin} (set HUGO_BIN)`);
  if (!fs.existsSync(path.join(src, 'themes', 'PaperMod', 'theme.toml'))) {
    throw new Error(`buildSite: ${src}/themes/PaperMod is missing (use mock.exportTo(), which symlinks it)`);
  }
  const side = out.replace(/[\\/]+$/, '') + '.hugo';
  fs.mkdirSync(side, { recursive: true });
  const args = [
    '--source', src,
    '--destination', out,
    '--cleanDestinationDir',
    '--noBuildLock',
    '--cacheDir', path.join(side, 'cache'),
    '--logLevel', 'warn',
  ];
  if (minify) args.push('--minify');
  if (baseURL) args.push('--baseURL', baseURL);
  args.push(...extraArgs);
  const env = { ...process.env, HUGO_RESOURCEDIR: path.join(side, 'resources') };
  const started = Date.now();
  return await new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd: side, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve({ outDir: out, stdout, stderr, ms: Date.now() - started });
      else reject(new Error(`hugo failed (${signal || 'exit ' + code}):\n${stderr || stdout}`));
    });
  });
}

// -----------------------------------------------------------------------------
// Playwright helper
// -----------------------------------------------------------------------------

const routedPages = new WeakMap();

/**
 * Open the admin in a Playwright page, logged in against the mock:
 * goto /admin/ → set localStorage['admin.apiBase'] + the token (localStorage if remember,
 * else sessionStorage) → reload → wait for body[data-testid="app-ready"].
 *
 * By default every request to another origin (api.github.com, cdn.jsdelivr.net, *.github.io …)
 * is aborted, so a test can never hit the real GitHub; aborted URLs are returned in `blocked`.
 *
 * @param {import('playwright').Page} page
 * @param {{ url: string, apiBase: string, token: string }} mock
 * @param {{ remember?: boolean, blockExternal?: boolean, timeout?: number, path?: string }} [opts]
 * @returns {Promise<{ blocked: string[] }>}
 */
export async function openAdmin(page, mock, { remember = true, blockExternal = true, timeout = 45000, path: adminPath = '/admin/' } = {}) {
  const origin = new URL(mock.url).origin;
  let blocked = routedPages.get(page);
  if (!blocked) {
    blocked = [];
    routedPages.set(page, blocked);
    if (blockExternal) {
      await page.route(
        (u) => (u.protocol === 'http:' || u.protocol === 'https:') && u.origin !== origin,
        (r) => {
          blocked.push(r.request().url());
          return r.abort('blockedbyclient');
        },
      );
    }
  }
  const errors = [];
  const onConsole = (m) => m.type() === 'error' && errors.push(`console: ${m.text()}`);
  const onPageError = (e) => errors.push(`pageerror: ${e.message}`);
  page.on('console', onConsole);
  page.on('pageerror', onPageError);
  try {
    await page.goto(mock.url + adminPath, { waitUntil: 'domcontentloaded', timeout });
    await page.evaluate(
      ({ apiBase, token, remember }) => {
        localStorage.setItem('admin.apiBase', apiBase);
        localStorage.removeItem('admin.token');
        sessionStorage.removeItem('admin.token');
        (remember ? localStorage : sessionStorage).setItem('admin.token', token);
      },
      { apiBase: mock.apiBase, token: mock.token, remember },
    );
    errors.length = 0; // only report errors from the logged-in load
    await page.reload({ waitUntil: 'domcontentloaded', timeout });
    try {
      await page.waitForSelector('body[data-testid="app-ready"]', { state: 'attached', timeout });
    } catch (e) {
      const text = await page.evaluate(() => document.body?.innerText?.slice(0, 500) ?? '').catch(() => '');
      throw new Error(
        `openAdmin: admin did not become ready within ${timeout} ms.\n` +
          `Page text: ${text}\n${errors.join('\n')}\n(${e.message.split('\n')[0]})`,
      );
    }
  } finally {
    page.off('console', onConsole);
    page.off('pageerror', onPageError);
  }
  return { blocked };
}
