// Unit tests for static/admin/js/github.js and static/admin/js/repo.js.
// Run: node --test tests/admin/github.test.mjs
//
// A FakeGitHub (in this file) simulates the parts of GitHub's REST API the admin uses:
// a real content-addressed git object store (blobs / trees / commits with git SHA-1s),
// trees created with base_tree and deletions via sha:null, refs with 422 non-fast-forward,
// Actions runs, auth, rate-limit header, and hooks to inject failures.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';

import { GitHubClient, GitHubError, encodeBase64, decodeBase64 } from '../../static/admin/js/github.js';
import { Repo, ConflictError, gitBlobSha } from '../../static/admin/js/repo.js';

const API = 'https://api.github.test';
const TOKEN = 'ghp_testtoken123';
const OWNER = 'HimZFX';
const REPO = 'HimZFX.github.io';

// ---------------------------------------------------------------------------
// Fake GitHub

function sha1(...parts) {
  const h = createHash('sha1');
  for (const p of parts) h.update(p);
  return h.digest('hex');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function json(status, body, headers = {}) {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });
}

class FakeGitHub {
  constructor({ files = {}, submodules = { 'themes/PaperMod': '1cf53273c3ba58f0593ecb7c2befe11274f51a4e' }, executables = [] } = {}) {
    this.objects = new Map();     // sha → { type, ... }
    this.requests = [];           // { method, path, body }
    this.interceptors = [];       // [{ match(req), handle(req, fake) → Response|undefined, once }]
    this.rateRemaining = 4999;
    this.blobDelayMs = 0;
    this.blobInFlight = 0;
    this.blobMaxInFlight = 0;
    this.runs = new Map();        // headSha → [run]
    this.commitCounter = 0;
    const flat = new Map();
    for (const [path, content] of Object.entries(files)) {
      flat.set(path, { type: 'blob', mode: executables.includes(path) ? '100755' : '100644', sha: this.putBlob(Buffer.from(content)) });
    }
    for (const [path, sha] of Object.entries(submodules)) flat.set(path, { type: 'commit', mode: '160000', sha });
    this.ref = this.putCommit(this.writeTree(flat), [], 'initial');
  }

  // --- object store -------------------------------------------------------

  putBlob(buf) {
    const sha = sha1(`blob ${buf.length}\0`, buf);
    this.objects.set(sha, { type: 'blob', data: Buffer.from(buf) });
    return sha;
  }

  /** flat: Map path → { type: 'blob'|'commit', mode, sha } → root tree sha (git format) */
  writeTree(flat) {
    const root = new Map();
    for (const [path, e] of flat) {
      const segs = path.split('/');
      let node = root;
      for (let i = 0; i < segs.length - 1; i++) {
        let child = node.get(segs[i]);
        if (!child) { child = { dir: new Map() }; node.set(segs[i], child); }
        if (!child.dir) throw new Error(`parent is a file: ${path}`);
        node = child.dir;
      }
      if (node.has(segs.at(-1))) throw new Error(`duplicate path: ${path}`);
      node.set(segs.at(-1), { leaf: e });
    }
    const write = (dir) => {
      const entries = [];
      for (const [name, n] of dir) {
        if (n.dir) entries.push({ name, mode: '40000', type: 'tree', sha: write(n.dir) });
        else entries.push({ name, mode: n.leaf.mode, type: n.leaf.type, sha: n.leaf.sha });
      }
      // git sorts tree entries by name, treating directories as if they had a trailing '/'
      const key = (e) => (e.type === 'tree' ? e.name + '/' : e.name);
      entries.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
      const body = Buffer.concat(entries.map((e) => Buffer.concat([
        Buffer.from(`${e.mode} ${e.name}\0`), Buffer.from(e.sha, 'hex'),
      ])));
      const sha = sha1(`tree ${body.length}\0`, body);
      this.objects.set(sha, { type: 'tree', entries });
      return sha;
    };
    return write(root);
  }

  putCommit(tree, parents, message) {
    const text = `tree ${tree}\n${parents.map((p) => `parent ${p}\n`).join('')}author fake\n#${++this.commitCounter}\n\n${message}`;
    const sha = sha1(`commit ${Buffer.byteLength(text)}\0`, text);
    this.objects.set(sha, { type: 'commit', tree, parents, message });
    return sha;
  }

  /** treeSha → Map path → { type, mode, sha } (blobs and submodules only), plus dirs list */
  flatten(treeSha) {
    const flat = new Map();
    const dirs = [];
    const walk = (sha, prefix) => {
      for (const e of this.objects.get(sha).entries) {
        const path = prefix + e.name;
        if (e.type === 'tree') { dirs.push({ path, sha: e.sha }); walk(e.sha, path + '/'); }
        else flat.set(path, { type: e.type, mode: e.mode, sha: e.sha });
      }
    };
    walk(treeSha, '');
    return { flat, dirs };
  }

  headTree() { return this.objects.get(this.ref).tree; }

  isAncestor(anc, sha) {
    const seen = new Set();
    const stack = [sha];
    while (stack.length) {
      const s = stack.pop();
      if (s === anc) return true;
      if (seen.has(s)) continue;
      seen.add(s);
      const c = this.objects.get(s);
      if (c && c.type === 'commit') stack.push(...c.parents);
    }
    return false;
  }

  // --- helpers for tests --------------------------------------------------

  readFile(path) {
    const e = this.flatten(this.headTree()).flat.get(path);
    return e && e.type === 'blob' ? this.objects.get(e.sha).data : undefined;
  }

  readText(path) {
    const b = this.readFile(path);
    return b === undefined ? undefined : b.toString('utf8');
  }

  shaOf(path) {
    const e = this.flatten(this.headTree()).flat.get(path);
    return e ? e.sha : undefined;
  }

  /** Simulate an external push (e.g. from another device). content=null deletes. */
  setFile(path, content, message = 'external') {
    const { flat } = this.flatten(this.headTree());
    if (content === null) flat.delete(path);
    else flat.set(path, { type: 'blob', mode: '100644', sha: this.putBlob(Buffer.from(content)) });
    this.ref = this.putCommit(this.writeTree(flat), [this.ref], message);
    return this.ref;
  }

  commitCount() {
    let n = 0;
    for (let s = this.ref; s; s = this.objects.get(s).parents[0]) n++;
    return n;
  }

  /** Add an interceptor; handler may return a Response to short-circuit. */
  intercept(match, handle, { once = true } = {}) {
    this.interceptors.push({ match, handle, once });
  }

  count(method, re) {
    return this.requests.filter((r) => r.method === method && re.test(r.path)).length;
  }

  client(extra = {}) {
    return new GitHubClient({
      token: TOKEN, owner: OWNER, repo: REPO, branch: 'main', apiBase: API,
      fetch: this.fetch, retryDelayMs: 0, ...extra,
    });
  }

  // --- HTTP ---------------------------------------------------------------

  fetch = async (url, init = {}) => {
    const u = new URL(url);
    assert.equal(u.origin, API, 'request must go to the API base');
    const method = (init.method || 'GET').toUpperCase();
    const headers = new Headers(init.headers || {});
    const body = init.body ? JSON.parse(init.body) : undefined;
    const req = { method, path: u.pathname, query: u.searchParams, body, headers, init };
    this.requests.push({ method, path: u.pathname + u.search, body });

    for (const it of [...this.interceptors]) {
      if (it.match(req)) {
        if (it.once) this.interceptors.splice(this.interceptors.indexOf(it), 1);
        const res = await it.handle(req, this);
        if (res) return res;
      }
    }

    if (headers.get('authorization') !== `Bearer ${TOKEN}`) {
      return json(401, { message: 'Bad credentials' });
    }
    const rl = { 'x-ratelimit-remaining': String(this.rateRemaining) };
    if (this.rateRemaining <= 0) return json(403, { message: 'API rate limit exceeded for user.' }, rl);

    const base = `/repos/${OWNER}/${REPO}`;
    const p = u.pathname;
    let m;
    if (method === 'GET' && p === '/user') return json(200, { login: 'HimZFX', avatar_url: 'https://avatars.test/u/1' }, rl);
    if (method === 'GET' && p === base) {
      return json(200, { full_name: `${OWNER}/${REPO}`, default_branch: 'main', permissions: { push: true, pull: true } }, rl);
    }
    if (!p.startsWith(base + '/')) return json(404, { message: 'Not Found' }, rl);
    const rest = p.slice(base.length);

    if (method === 'GET' && rest === '/git/ref/heads/main') {
      return json(200, { ref: 'refs/heads/main', object: { sha: this.ref, type: 'commit' } }, rl);
    }
    if (method === 'PATCH' && rest === '/git/refs/heads/main') {
      const c = this.objects.get(body.sha);
      if (!c || c.type !== 'commit') return json(422, { message: 'Object does not exist' }, rl);
      if (!body.force && !this.isAncestor(this.ref, body.sha)) {
        return json(422, { message: 'Update is not a fast forward' }, rl);
      }
      this.ref = body.sha;
      return json(200, { ref: 'refs/heads/main', object: { sha: this.ref, type: 'commit' } }, rl);
    }
    if (method === 'GET' && (m = rest.match(/^\/git\/commits\/([0-9a-f]{40})$/))) {
      const c = this.objects.get(m[1]);
      if (!c || c.type !== 'commit') return json(404, { message: 'Not Found' }, rl);
      return json(200, { sha: m[1], tree: { sha: c.tree }, parents: c.parents.map((sha) => ({ sha })), message: c.message }, rl);
    }
    if (method === 'GET' && (m = rest.match(/^\/git\/trees\/([0-9a-f]{40})$/))) {
      const t = this.objects.get(m[1]);
      if (!t || t.type !== 'tree') return json(404, { message: 'Not Found' }, rl);
      assert.equal(u.searchParams.get('recursive'), '1');
      const { flat, dirs } = this.flatten(m[1]);
      const tree = [
        ...dirs.map((d) => ({ path: d.path, mode: '040000', type: 'tree', sha: d.sha })),
        ...[...flat].map(([path, e]) => (e.type === 'blob'
          ? { path, mode: e.mode, type: 'blob', sha: e.sha, size: this.objects.get(e.sha).data.length }
          : { path, mode: e.mode, type: 'commit', sha: e.sha })),
      ].sort((a, b) => (a.path < b.path ? -1 : 1));
      return json(200, { sha: m[1], tree, truncated: false }, rl);
    }
    if (method === 'GET' && (m = rest.match(/^\/git\/blobs\/([0-9a-f]{40})$/))) {
      const b = this.objects.get(m[1]);
      if (!b || b.type !== 'blob') return json(404, { message: 'Not Found' }, rl);
      // GitHub wraps base64 at 60 columns with '\n'
      const content = b.data.toString('base64').replace(/(.{60})/g, '$1\n');
      return json(200, { sha: m[1], size: b.data.length, encoding: 'base64', content }, rl);
    }
    if (method === 'POST' && rest === '/git/blobs') {
      this.blobInFlight++;
      this.blobMaxInFlight = Math.max(this.blobMaxInFlight, this.blobInFlight);
      try {
        if (this.blobDelayMs) await sleep(this.blobDelayMs);
        if (body.encoding !== 'base64' || typeof body.content !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(body.content)) {
          return json(422, { message: 'Invalid request.' }, rl);
        }
        const sha = this.putBlob(Buffer.from(body.content, 'base64'));
        return json(201, { sha, url: `${API}${base}/git/blobs/${sha}` }, rl);
      } finally {
        this.blobInFlight--;
      }
    }
    if (method === 'POST' && rest === '/git/trees') {
      let flat = new Map();
      if (body.base_tree) {
        const t = this.objects.get(body.base_tree);
        if (!t || t.type !== 'tree') return json(422, { message: 'Invalid tree info' }, rl);
        flat = this.flatten(body.base_tree).flat;
      }
      for (const e of body.tree) {
        if (e.type !== 'blob' || !['100644', '100755'].includes(e.mode)) return json(422, { message: 'Invalid tree info' }, rl);
        if (e.sha === null) {
          // Real GitHub rejects deleting a path that does not exist in base_tree.
          if (!flat.has(e.path)) return json(422, { message: `GitHub could not delete ${e.path}` }, rl);
          flat.delete(e.path);
          continue;
        }
        const b = this.objects.get(e.sha);
        if (!b || b.type !== 'blob') return json(422, { message: `tree.sha ${e.sha} is not a valid blob` }, rl);
        for (const k of flat.keys()) {
          if (k.startsWith(e.path + '/')) return json(422, { message: 'path is a directory' }, rl);
        }
        flat.set(e.path, { type: 'blob', mode: e.mode, sha: e.sha });
      }
      let sha;
      try { sha = this.writeTree(flat); } catch (err) { return json(422, { message: err.message }, rl); }
      return json(201, { sha, tree: [], truncated: false }, rl);
    }
    if (method === 'POST' && rest === '/git/commits') {
      const t = this.objects.get(body.tree);
      if (!t || t.type !== 'tree') return json(422, { message: 'Tree SHA does not exist' }, rl);
      for (const parent of body.parents) {
        if (!this.objects.has(parent)) return json(422, { message: 'Parent SHA does not exist or is not a commit object' }, rl);
      }
      const sha = this.putCommit(body.tree, body.parents, body.message);
      return json(201, { sha, tree: { sha: body.tree }, parents: body.parents.map((s) => ({ sha: s })), message: body.message }, rl);
    }
    if (method === 'GET' && rest === '/actions/runs') {
      const runs = this.runs.get(u.searchParams.get('head_sha')) || [];
      return json(200, { total_count: runs.length, workflow_runs: runs }, rl);
    }
    return json(404, { message: 'Not Found' }, rl);
  };
}

const SEED = {
  'config/_default/params.toml': '# comment\n[profileMode]\n  enabled = true\n',
  'content/posts/hello.md': '---\ntitle: "你好"\n---\n\n正文\n',
  'content/posts/bye.md': '---\ntitle: "Bye"\n---\n',
  'content/about.md': '---\ntitle: About\n---\n',
  'static/avatar.jpg': Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]).toString('latin1'),
  'static/documents/a.pdf': '%PDF-1.4 fake',
  'tools/run.sh': '#!/bin/sh\necho hi\n',
};

function setup(opts = {}) {
  const files = { ...SEED };
  // keep avatar binary exact
  const fake = new FakeGitHub({ files: {}, executables: ['tools/run.sh'], ...opts });
  const flat = new Map();
  for (const [path, content] of Object.entries(files)) {
    const buf = path === 'static/avatar.jpg' ? Buffer.from(content, 'latin1') : Buffer.from(content);
    flat.set(path, { type: 'blob', mode: path === 'tools/run.sh' ? '100755' : '100644', sha: fake.putBlob(buf) });
  }
  flat.set('themes/PaperMod', { type: 'commit', mode: '160000', sha: '1cf53273c3ba58f0593ecb7c2befe11274f51a4e' });
  fake.ref = fake.putCommit(fake.writeTree(flat), [], 'seed');
  const client = fake.client();
  return { fake, client };
}

async function loadedRepo(opts = {}) {
  const { fake, client } = setup();
  const repo = new Repo(client, { retryDelayMs: 0, ...opts });
  await repo.load();
  return { fake, client, repo };
}

/** Assert that fn() rejects with a GitHubError and return it. */
async function rejectsGitHub(fn, check = {}) {
  let caught;
  try { await fn(); } catch (err) { caught = err; }
  assert.ok(caught, 'expected a rejection');
  assert.ok(caught instanceof GitHubError, `expected GitHubError, got ${caught && caught.name}: ${caught && caught.message}`);
  if ('status' in check) assert.equal(caught.status, check.status);
  if ('message' in check) {
    if (check.message instanceof RegExp) assert.match(caught.message, check.message);
    else assert.equal(caught.message, check.message);
  }
  return caught;
}

// ---------------------------------------------------------------------------
// base64

describe('encodeBase64 / decodeBase64', () => {
  test('RFC 4648 test vectors', () => {
    const vectors = [['', ''], ['f', 'Zg=='], ['fo', 'Zm8='], ['foo', 'Zm9v'], ['foob', 'Zm9vYg=='],
      ['fooba', 'Zm9vYmE='], ['foobar', 'Zm9vYmFy']];
    for (const [plain, b64] of vectors) {
      assert.equal(encodeBase64(new TextEncoder().encode(plain)), b64);
      assert.equal(new TextDecoder().decode(decodeBase64(b64)), plain);
    }
  });

  test('strings are UTF-8 encoded; ArrayBuffer and other views accepted', () => {
    assert.equal(encodeBase64('你好'), Buffer.from('你好').toString('base64'));
    const bytes = new Uint8Array([0, 255, 128, 7]);
    assert.equal(encodeBase64(bytes.buffer), 'AP+ABw==');
    assert.equal(encodeBase64(new DataView(bytes.buffer, 1, 2)), Buffer.from([255, 128]).toString('base64'));
  });

  test('decode ignores whitespace / newlines (GitHub wraps at 60 cols) and missing padding', () => {
    const data = randomBytes(1000);
    const wrapped = data.toString('base64').replace(/(.{60})/g, '$1\n') + '\n';
    assert.deepEqual(Buffer.from(decodeBase64(wrapped)), data);
    assert.deepEqual([...decodeBase64('Zm9vYg')], [...Buffer.from('foob')]);
    assert.deepEqual([...decodeBase64('Zm9vYmE')], [...Buffer.from('fooba')]);
    assert.equal(decodeBase64(' \r\n').length, 0);
  });

  test('decode rejects invalid input', () => {
    assert.throws(() => decodeBase64('Zm9v*'));
    assert.throws(() => decodeBase64('Zm9vY'));     // length % 4 === 1
    assert.throws(() => decodeBase64('Zg==='));
    assert.throws(() => decodeBase64(123));
  });

  test('3 MB binary round trip without stack overflow, identical to Buffer', () => {
    const data = randomBytes(3 * 1024 * 1024 + 7);
    const b64 = encodeBase64(new Uint8Array(data.buffer, data.byteOffset, data.length));
    assert.equal(b64, data.toString('base64'));
    const back = decodeBase64(b64);
    assert.ok(back instanceof Uint8Array);
    assert.equal(back.length, data.length);
    assert.ok(Buffer.from(back).equals(data));
  });

  test('chunk boundaries: every length around the chunk sizes round-trips', () => {
    for (const n of [98303, 98304, 98305, 49151, 49152, 49153, 65535, 65536, 65537]) {
      const data = randomBytes(n);
      const b64 = encodeBase64(new Uint8Array(data));
      assert.equal(b64, data.toString('base64'), `encode n=${n}`);
      assert.ok(Buffer.from(decodeBase64(b64)).equals(data), `decode n=${n}`);
    }
  });
});

// ---------------------------------------------------------------------------
// GitHubClient

describe('GitHubClient.request', () => {
  test('sends the documented headers and JSON body to apiBase only', async () => {
    const seen = [];
    const client = new GitHubClient({
      token: `  ${TOKEN}\n`, owner: OWNER, repo: REPO, branch: 'main', apiBase: API + '/',
      fetch: async (url, init) => { seen.push({ url, init }); return json(201, { ok: true }); },
    });
    const out = await client.request('POST', '/repos/x/y/git/blobs', { a: 1 });
    assert.deepEqual(out, { ok: true });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].url, `${API}/repos/x/y/git/blobs`);
    const h = new Headers(seen[0].init.headers);
    assert.equal(h.get('accept'), 'application/vnd.github+json');
    assert.equal(h.get('x-github-api-version'), '2022-11-28');
    assert.equal(h.get('authorization'), `Bearer ${TOKEN}`, 'token is trimmed');
    assert.equal(h.get('content-type'), 'application/json');
    assert.equal(seen[0].init.method, 'POST');
    assert.equal(seen[0].init.body, '{"a":1}');
    assert.ok(!seen[0].url.includes(TOKEN), 'token never in URL');
  });

  test('GET has no body; mutable reads bypass the HTTP cache', async () => {
    const seen = [];
    const client = new GitHubClient({ token: TOKEN, owner: OWNER, repo: REPO, apiBase: API,
      fetch: async (url, init) => { seen.push(init); return json(200, {}); } });
    await client.request('GET', '/user');
    assert.equal(seen[0].body, undefined);
    assert.equal(new Headers(seen[0].headers).get('content-type'), null);
    assert.equal(seen[0].cache, 'no-store');
  });

  test('empty / 204 response resolves to null', async () => {
    const client = new GitHubClient({ token: TOKEN, owner: OWNER, repo: REPO, apiBase: API,
      fetch: async () => new Response(null, { status: 204 }) });
    assert.equal(await client.request('DELETE', '/x'), null);
  });

  test('refuses paths that could escape the API origin', async () => {
    const client = new GitHubClient({ token: TOKEN, owner: OWNER, repo: REPO, apiBase: API,
      fetch: async () => { throw new Error('must not be called'); } });
    await assert.rejects(() => client.request('GET', '@evil.example/x'), TypeError);
    await assert.rejects(() => client.request('GET', '//evil.example/x'), TypeError);
    await assert.rejects(() => client.request('GET', 'https://evil.example/x'), TypeError);
  });

  test('rejects an invalid apiBase', () => {
    assert.throws(() => new GitHubClient({ token: TOKEN, owner: OWNER, repo: REPO, apiBase: 'javascript:alert(1)' }), TypeError);
    assert.throws(() => new GitHubClient({ token: TOKEN, owner: OWNER, repo: REPO, apiBase: 'not a url' }), TypeError);
  });

  test('missing or malformed token fails fast with 401 and never calls fetch', async () => {
    let called = 0;
    const f = async () => { called++; return json(200, {}); };
    const c1 = new GitHubClient({ token: '  ', owner: OWNER, repo: REPO, apiBase: API, fetch: f });
    await rejectsGitHub(() => c1.getUser(), { status: 401, message: '令牌无效或已过期，请重新登录' });
    const c2 = new GitHubClient({ token: 'ghp_中文', owner: OWNER, repo: REPO, apiBase: API, fetch: f });
    await rejectsGitHub(() => c2.getUser(), { status: 401, message: /令牌格式不正确/ });
    assert.equal(called, 0);
  });

  test('token is not exposed through enumerable props or JSON', () => {
    const c = new GitHubClient({ token: TOKEN, owner: OWNER, repo: REPO, apiBase: API, fetch: async () => json(200, {}) });
    assert.ok(!JSON.stringify(c).includes(TOKEN));
    assert.ok(!Object.values(c).some((v) => typeof v === 'string' && v.includes(TOKEN)));
    assert.equal(c.owner, OWNER);
    assert.equal(c.repo, REPO);
    assert.equal(c.branch, 'main');
  });
});

describe('GitHubClient error mapping', () => {
  const cases = [
    { name: '401', res: () => json(401, { message: 'Bad credentials' }), status: 401, message: '令牌无效或已过期，请重新登录' },
    { name: '403 rate limit (x-ratelimit-remaining: 0)', res: () => json(403, { message: 'API rate limit exceeded' }, { 'x-ratelimit-remaining': '0' }), status: 403, message: 'GitHub 接口调用次数已用完，请稍后再试' },
    { name: '429 secondary rate limit', res: () => json(429, { message: 'You have exceeded a secondary rate limit' }), status: 429, message: 'GitHub 接口调用次数已用完，请稍后再试' },
    { name: '403 secondary rate limit message', res: () => json(403, { message: 'You have exceeded a secondary rate limit.' }, { 'x-ratelimit-remaining': '4000' }), status: 403, message: 'GitHub 接口调用次数已用完，请稍后再试' },
    { name: '403 other', res: () => json(403, { message: 'Resource not accessible by personal access token' }, { 'x-ratelimit-remaining': '4999' }), status: 403, message: '令牌没有足够的权限（需要本仓库的 Contents 读写权限）' },
    { name: '404', res: () => json(404, { message: 'Not Found' }), status: 404, message: '找不到仓库或文件（请确认令牌授权了这个仓库）' },
    { name: '409 keeps GitHub message', res: () => json(409, { message: 'Git Repository is empty.' }), status: 409, message: 'Git Repository is empty.' },
    { name: '422 keeps GitHub message', res: () => json(422, { message: 'Update is not a fast forward' }), status: 422, message: 'Update is not a fast forward' },
    { name: '422 with errors[] details', res: () => json(422, { message: 'Validation Failed', errors: [{ message: 'path is invalid' }, { code: 'missing_field' }] }), status: 422, message: 'Validation Failed（path is invalid；missing_field）' },
    { name: '422 without body', res: () => new Response('', { status: 422 }), status: 422, message: 'GitHub 请求失败（422）' },
    { name: '500', res: () => json(500, { message: 'Server Error' }), status: 500, message: 'GitHub 请求失败（500）' },
    { name: '502 html body', res: () => new Response('<html>bad gateway</html>', { status: 502 }), status: 502, message: 'GitHub 请求失败（502）' },
  ];
  for (const c of cases) {
    test(c.name, async () => {
      const client = new GitHubClient({ token: TOKEN, owner: OWNER, repo: REPO, apiBase: API, retryDelayMs: 0,
        fetch: async () => c.res() });
      const err = await rejectsGitHub(() => client.request('POST', '/repos/x/y/git/trees', {}), { status: c.status, message: c.message });
      assert.equal(err.path, '/repos/x/y/git/trees');
      assert.equal(err.name, 'GitHubError');
      assert.ok(err instanceof Error);
    });
  }

  test('data of the GitHub response is preserved', async () => {
    const client = new GitHubClient({ token: TOKEN, owner: OWNER, repo: REPO, apiBase: API,
      fetch: async () => json(422, { message: 'nope', documentation_url: 'https://docs' }) });
    const err = await rejectsGitHub(() => client.request('PATCH', '/x', {}));
    assert.deepEqual(err.data, { message: 'nope', documentation_url: 'https://docs' });
  });

  test('network failure → status 0 Chinese message (GET retried once first)', async () => {
    let calls = 0;
    const client = new GitHubClient({ token: TOKEN, owner: OWNER, repo: REPO, apiBase: API, retryDelayMs: 0,
      fetch: async () => { calls++; throw new TypeError('fetch failed'); } });
    const err = await rejectsGitHub(() => client.getUser(), { status: 0, message: '网络错误，无法连接 GitHub' });
    assert.ok(err.cause instanceof TypeError);
    assert.equal(calls, 2, 'GET retried once');
  });

  test('network failure on PATCH is not retried', async () => {
    let calls = 0;
    const client = new GitHubClient({ token: TOKEN, owner: OWNER, repo: REPO, apiBase: API, retryDelayMs: 0,
      fetch: async () => { calls++; throw new TypeError('fetch failed'); } });
    await rejectsGitHub(() => client.updateRef('a'.repeat(40)), { status: 0 });
    assert.equal(calls, 1);
  });

  test('transient 503 on GET is retried and then succeeds', async () => {
    let calls = 0;
    const client = new GitHubClient({ token: TOKEN, owner: OWNER, repo: REPO, apiBase: API, retryDelayMs: 0,
      fetch: async () => (++calls === 1 ? json(503, { message: 'unavailable' }) : json(200, { login: 'me', avatar_url: 'x' })) });
    assert.deepEqual(await client.getUser(), { login: 'me', avatarUrl: 'x', name: '' });
    assert.equal(calls, 2);
  });

  test('timeout → status 0 timeout message', async () => {
    const client = new GitHubClient({ token: TOKEN, owner: OWNER, repo: REPO, apiBase: API, retryDelayMs: 0, timeoutMs: 20,
      fetch: (url, init) => new Promise((resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      }) });
    await rejectsGitHub(() => client.getUser(), { status: 0, message: /网络超时/ });
  });

  test('2xx with non-JSON body → GitHubError', async () => {
    const client = new GitHubClient({ token: TOKEN, owner: OWNER, repo: REPO, apiBase: API,
      fetch: async () => new Response('<html>', { status: 200 }) });
    await rejectsGitHub(() => client.getRepo(), { message: 'GitHub 返回了无法识别的数据' });
  });
});

describe('GitHubClient endpoints (against FakeGitHub)', () => {
  test('getRepo / getUser', async () => {
    const { client } = setup();
    const repo = await client.getRepo();
    assert.equal(repo.permissions.push, true);
    assert.equal(repo.default_branch, 'main');
    assert.deepEqual(await client.getUser(), { login: 'HimZFX', avatarUrl: 'https://avatars.test/u/1', name: '' });
  });

  test('wrong token → 401 message', async () => {
    const { fake } = setup();
    const client = fake.client({ token: 'ghp_wrong' });
    await rejectsGitHub(() => client.getUser(), { status: 401, message: '令牌无效或已过期，请重新登录' });
  });

  test('rate limit header from the fake API → rate-limit message', async () => {
    const { fake, client } = setup();
    fake.rateRemaining = 0;
    await rejectsGitHub(() => client.getBranchHead(), { status: 403, message: 'GitHub 接口调用次数已用完，请稍后再试' });
  });

  test('getBranchHead returns commit and tree sha', async () => {
    const { fake, client } = setup();
    const head = await client.getBranchHead();
    assert.equal(head.commitSha, fake.ref);
    assert.equal(head.treeSha, fake.headTree());
  });

  test('getTree drops submodule "commit" entries and maps fields', async () => {
    const { fake, client } = setup();
    const tree = await client.getTree(fake.headTree());
    assert.ok(tree.every((e) => e.type === 'blob' || e.type === 'tree'));
    assert.ok(!tree.some((e) => e.path === 'themes/PaperMod'), 'submodule dropped');
    assert.deepEqual(tree.submodules, ['themes/PaperMod']);
    assert.equal(tree.truncated, false);
    const hello = tree.find((e) => e.path === 'content/posts/hello.md');
    assert.deepEqual(Object.keys(hello).sort(), ['mode', 'path', 'sha', 'size', 'type']);
    assert.equal(hello.type, 'blob');
    assert.equal(hello.size, Buffer.byteLength(SEED['content/posts/hello.md']));
    assert.equal(hello.sha, fake.shaOf('content/posts/hello.md'));
    const dir = tree.find((e) => e.path === 'content/posts');
    assert.equal(dir.type, 'tree');
    assert.ok(tree.find((e) => e.path === 'themes'), 'parent dir of submodule is still a tree');
    // submodule entries never leak through enumeration either
    assert.ok(!JSON.stringify(tree).includes('1cf53273c3ba58f0593ecb7c2befe11274f51a4e'));
  });

  test('blob sha of the fake store is the real git sha', async () => {
    const fake = new FakeGitHub({ files: { 'a.txt': 'hello\n' }, submodules: {} });
    assert.equal(fake.shaOf('a.txt'), 'ce013625030ba8dba906f756967f9e9ca394464a');   // `git hash-object`
  });

  test('createBlob / getBlob: 3 MB binary round trip', async () => {
    const { fake, client } = setup();
    const data = randomBytes(3 * 1024 * 1024);
    const sha = await client.createBlob(new Uint8Array(data));
    assert.equal(sha, sha1(`blob ${data.length}\0`, data));
    assert.ok(fake.objects.get(sha).data.equals(data), 'stored bytes identical');
    const back = await client.getBlob(sha);
    assert.ok(back instanceof Uint8Array);
    assert.ok(Buffer.from(back).equals(data));
  });

  test('getBlob decodes the newline-wrapped base64 GitHub returns', async () => {
    const { fake, client } = setup();
    const bytes = await client.getBlob(fake.shaOf('content/posts/hello.md'));
    assert.equal(new TextDecoder().decode(bytes), SEED['content/posts/hello.md']);
  });

  test('getBlob of unknown sha → 404 message', async () => {
    const { client } = setup();
    await rejectsGitHub(() => client.getBlob('0'.repeat(40)), { status: 404, message: '找不到仓库或文件（请确认令牌授权了这个仓库）' });
  });

  test('createTree / createCommit / updateRef build a commit; deletes via sha:null', async () => {
    const { fake, client } = setup();
    const head = await client.getBranchHead();
    const blob = await client.createBlob(new TextEncoder().encode('new\n'));
    const tree = await client.createTree(head.treeSha, [
      { path: 'content/new.md', sha: blob },
      { path: 'content/about.md', sha: null },
    ]);
    const body = fake.requests.find((r) => r.method === 'POST' && r.path.endsWith('/git/trees')).body;
    assert.equal(body.base_tree, head.treeSha);
    assert.deepEqual(body.tree, [
      { path: 'content/new.md', mode: '100644', type: 'blob', sha: blob },
      { path: 'content/about.md', mode: '100644', type: 'blob', sha: null },
    ]);
    const commit = await client.createCommit('msg', tree, head.commitSha);
    const commitReq = fake.requests.find((r) => r.method === 'POST' && r.path.endsWith('/git/commits')).body;
    assert.deepEqual(commitReq, { message: 'msg', tree, parents: [head.commitSha] });
    await client.updateRef(commit);
    const patch = fake.requests.find((r) => r.method === 'PATCH').body;
    assert.deepEqual(patch, { sha: commit, force: false });
    assert.equal(fake.ref, commit);
    assert.equal(fake.readText('content/new.md'), 'new\n');
    assert.equal(fake.readFile('content/about.md'), undefined);
  });

  test('updateRef non-fast-forward → 422 GitHubError keeping the message', async () => {
    const { fake, client } = setup();
    const head = await client.getBranchHead();
    const commit = await client.createCommit('x', head.treeSha, head.commitSha);
    fake.setFile('content/x.md', 'external');
    await rejectsGitHub(() => client.updateRef(commit), { status: 422, message: 'Update is not a fast forward' });
  });

  test('listWorkflowRuns maps fields and passes head_sha', async () => {
    const { fake, client } = setup();
    fake.runs.set('abc', [{ id: 7, status: 'in_progress', conclusion: null, html_url: 'https://github.com/run/7', name: 'Deploy', extra: 1 }]);
    const runs = await client.listWorkflowRuns('abc');
    assert.deepEqual(runs, [{ id: 7, status: 'in_progress', conclusion: null, htmlUrl: 'https://github.com/run/7', name: 'Deploy' }]);
    const req = fake.requests.at(-1);
    assert.equal(req.path, `/repos/${OWNER}/${REPO}/actions/runs?head_sha=abc&per_page=10`);
  });
});

// ---------------------------------------------------------------------------
// Repo

describe('Repo reading', () => {
  test('load → list / entry / has (blobs only, sorted, prefix filtered)', async () => {
    const { fake, repo } = await loadedRepo();
    assert.equal(repo.commitSha, fake.ref);
    assert.equal(repo.treeSha, fake.headTree());
    const all = repo.list();
    assert.deepEqual(all.map((e) => e.path), Object.keys(SEED).sort());
    assert.deepEqual(repo.list('content/posts/').map((e) => e.path), ['content/posts/bye.md', 'content/posts/hello.md']);
    assert.deepEqual(repo.list('nope/'), []);
    const e = repo.entry('content/about.md');
    assert.deepEqual(e, { path: 'content/about.md', sha: fake.shaOf('content/about.md'), size: Buffer.byteLength(SEED['content/about.md']) });
    assert.equal(repo.has('content/about.md'), true);
    assert.equal(repo.has('content'), false, 'directories are not files');
    assert.equal(repo.has('themes/PaperMod'), false, 'submodule not listed');
    assert.equal(repo.entry('missing.md'), undefined);
    // returned entries are copies
    repo.list()[0].sha = 'mutated';
    assert.notEqual(repo.list()[0].sha, 'mutated');
  });

  test('readText / readBytes, 404 for unknown path', async () => {
    const { repo } = await loadedRepo();
    assert.equal(await repo.readText('content/posts/hello.md'), SEED['content/posts/hello.md']);
    const bytes = await repo.readBytes('static/avatar.jpg');
    assert.deepEqual([...bytes], [0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
    await rejectsGitHub(() => repo.readText('nope.md'), { status: 404 });
  });

  test('blob cache: hit avoids the network, miss fills it; in-memory cache + in-flight dedupe', async () => {
    const { fake, client } = setup();
    const store = new Map();
    const blobCache = { get: async (sha) => store.get(sha), set: async (sha, bytes) => { store.set(sha, bytes); } };
    const repo = new Repo(client, { blobCache, retryDelayMs: 0 });
    await repo.load();
    const sha = repo.entry('content/about.md').sha;
    const [a, b] = await Promise.all([repo.readText('content/about.md'), repo.readText('content/about.md')]);
    assert.equal(a, SEED['content/about.md']);
    assert.equal(b, a);
    assert.equal(fake.count('GET', /\/git\/blobs\//), 1, 'concurrent reads deduped');
    await sleep(0);
    assert.ok(store.has(sha), 'blob cache filled');

    // fresh Repo, same cache → no network for the blob
    const repo2 = new Repo(client, { blobCache, retryDelayMs: 0 });
    await repo2.load();
    const before = fake.count('GET', /\/git\/blobs\//);
    assert.equal(await repo2.readText('content/about.md'), SEED['content/about.md']);
    assert.equal(fake.count('GET', /\/git\/blobs\//), before);

    // mutating the returned bytes does not corrupt the cache
    const bytes = await repo.readBytes('content/about.md');
    bytes[0] = 0;
    assert.equal(await repo.readText('content/about.md'), SEED['content/about.md']);
  });

  test('broken or stale blob cache is ignored', async () => {
    const { fake, client } = setup();
    const blobCache = {
      get: async () => new Uint8Array([1, 2, 3]),   // wrong size → not trusted
      set: () => { throw new Error('quota'); },
    };
    const repo = new Repo(client, { blobCache, retryDelayMs: 0 });
    await repo.load();
    assert.equal(await repo.readText('content/about.md'), SEED['content/about.md']);
    const throwing = { get: async () => { throw new Error('idb gone'); }, set: async () => { throw new Error('idb gone'); } };
    const repo2 = new Repo(client, { blobCache: throwing, retryDelayMs: 0 });
    await repo2.load();
    assert.equal(await repo2.readText('content/posts/bye.md'), SEED['content/posts/bye.md']);
    assert.ok(fake.count('GET', /\/git\/blobs\//) >= 2);
  });

  test('onChange fires after load and can unsubscribe', async () => {
    const { client } = setup();
    const repo = new Repo(client, { retryDelayMs: 0 });
    const events = [];
    const off = repo.onChange((ev) => events.push(ev));
    await repo.load();
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'load');
    assert.equal(events[0].repo, repo);
    assert.equal(events[0].commitSha, repo.commitSha);
    off();
    await repo.load();
    assert.equal(events.length, 1);
  });

  test('load picks up external changes', async () => {
    const { fake, repo } = await loadedRepo();
    fake.setFile('content/posts/new.md', 'x\n');
    fake.setFile('content/about.md', null);
    await repo.load();
    assert.ok(repo.has('content/posts/new.md'));
    assert.ok(!repo.has('content/about.md'));
    assert.equal(repo.commitSha, fake.ref);
  });
});

describe('Repo.commit', () => {
  test('multi-file commit: string / Uint8Array / Blob / delete / skipped delete; content verified in store', async () => {
    const { fake, repo } = await loadedRepo();
    const events = [];
    repo.onChange((ev) => events.push(ev));
    const before = fake.commitCount();
    const png = new Uint8Array(randomBytes(5000));
    const pdf = new Blob([Buffer.from('%PDF-1.7 hello')], { type: 'application/pdf' });
    const res = await repo.commit({
      message: 'admin: 发表《测试》',
      changes: [
        { path: 'content/posts/test.md', content: '---\r\ntitle: "测试"\r\n---\r\n\r\n正文\r\n\r\n\r\n', baseSha: null },
        { path: 'content/posts/hello.md', content: 'updated', baseSha: repo.entry('content/posts/hello.md').sha },
        { path: 'static/images/posts/test/a.png', content: png },
        { path: 'static/documents/b.pdf', content: pdf },
        { path: 'content/about.md', delete: true, baseSha: repo.entry('content/about.md').sha },
        { path: 'content/never-existed.md', delete: true },
      ],
    });
    // store content
    assert.equal(fake.readText('content/posts/test.md'), '---\ntitle: "测试"\n---\n\n正文\n', 'CRLF → LF, exactly one trailing newline');
    assert.equal(fake.readText('content/posts/hello.md'), 'updated\n', 'trailing newline added');
    assert.ok(fake.readFile('static/images/posts/test/a.png').equals(Buffer.from(png)), 'binary unchanged');
    assert.equal(fake.readText('static/documents/b.pdf'), '%PDF-1.7 hello', 'Blob bytes unchanged (no newline added)');
    assert.equal(fake.readFile('content/about.md'), undefined, 'deleted');
    assert.equal(fake.readText('content/posts/bye.md'), SEED['content/posts/bye.md'], 'untouched file kept');
    assert.equal(fake.shaOf('themes/PaperMod'), '1cf53273c3ba58f0593ecb7c2befe11274f51a4e', 'submodule kept');
    // one atomic commit
    assert.equal(fake.commitCount(), before + 1);
    assert.equal(fake.objects.get(fake.ref).message, 'admin: 发表《测试》');
    assert.equal(res.commitSha, fake.ref);
    // missing delete was not sent to GitHub
    const treeReq = fake.requests.filter((r) => r.method === 'POST' && r.path.endsWith('/git/trees')).at(-1).body;
    assert.ok(!treeReq.tree.some((e) => e.path === 'content/never-existed.md'));
    // returned shas = blob shas in the store
    assert.deepEqual(Object.keys(res.shas).sort(), [
      'content/posts/hello.md', 'content/posts/test.md', 'static/documents/b.pdf', 'static/images/posts/test/a.png']);
    for (const [path, sha] of Object.entries(res.shas)) assert.equal(sha, fake.shaOf(path), path);
    // local tree refreshed
    assert.equal(repo.commitSha, fake.ref);
    assert.equal(repo.treeSha, fake.headTree());
    assert.equal(repo.entry('content/posts/test.md').sha, res.shas['content/posts/test.md']);
    assert.equal(repo.entry('content/posts/test.md').size, fake.readFile('content/posts/test.md').length);
    assert.equal(repo.entry('static/images/posts/test/a.png').size, 5000);
    assert.equal(repo.has('content/about.md'), false);
    assert.equal(repo.has('content/never-existed.md'), false);
    // local bookkeeping equals what a reload would produce
    const fresh = new Repo(fake.client(), { retryDelayMs: 0 });
    await fresh.load();
    assert.deepEqual(repo.list(), fresh.list());
    // reading a just-written file needs no network (cached at commit time)
    const blobGets = fake.count('GET', /\/git\/blobs\//);
    assert.equal(await repo.readText('content/posts/test.md'), '---\ntitle: "测试"\n---\n\n正文\n');
    assert.equal(fake.count('GET', /\/git\/blobs\//), blobGets);
    // onChange
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'commit');
    assert.equal(events[0].commitSha, res.commitSha);
    assert.ok(events[0].paths.includes('content/posts/test.md'));
  });

  test('text normalisation edge cases', async () => {
    const { fake, repo } = await loadedRepo();
    await repo.commit({ message: 'm', changes: [
      { path: 'a.txt', content: 'one\rtwo\r\nthree' },
      { path: 'b.txt', content: '' },
      { path: 'c.txt', content: '\n\n' },
      { path: 'd.txt', content: 'x\n' },
    ] });
    assert.equal(fake.readText('a.txt'), 'one\ntwo\nthree\n');
    assert.equal(fake.readText('b.txt'), '');
    assert.equal(fake.readText('c.txt'), '');
    assert.equal(fake.readText('d.txt'), 'x\n');
  });

  test('conflict check uses the LATEST head, not the loaded one', async () => {
    const { fake, repo } = await loadedRepo();
    const loadedSha = repo.entry('content/posts/hello.md').sha;
    fake.setFile('content/posts/hello.md', 'edited on another device\n');
    const before = fake.ref;
    let err;
    try {
      await repo.commit({ message: 'm', changes: [{ path: 'content/posts/hello.md', content: 'mine', baseSha: loadedSha }] });
    } catch (e) { err = e; }
    assert.ok(err instanceof ConflictError, `got ${err}`);
    assert.equal(err.message, '有文件在你编辑期间被修改了');
    assert.deepEqual(err.paths, ['content/posts/hello.md']);
    assert.deepEqual(err.details, [{ path: 'content/posts/hello.md', expected: loadedSha, actual: fake.shaOf('content/posts/hello.md') }]);
    assert.equal(fake.ref, before, 'nothing committed');
    assert.equal(fake.count('POST', /\/git\/blobs$/), 0, 'no blobs uploaded');
    assert.equal(fake.readText('content/posts/hello.md'), 'edited on another device\n');
  });

  test('baseSha undefined → no check (overwrites external change)', async () => {
    const { fake, repo } = await loadedRepo();
    fake.setFile('content/posts/hello.md', 'external\n');
    await repo.commit({ message: 'm', changes: [{ path: 'content/posts/hello.md', content: 'mine' }] });
    assert.equal(fake.readText('content/posts/hello.md'), 'mine\n');
  });

  test('baseSha null → file must not exist', async () => {
    const { fake, repo } = await loadedRepo();
    // exists in the loaded tree
    await assert.rejects(
      () => repo.commit({ message: 'm', changes: [{ path: 'content/about.md', content: 'x', baseSha: null }] }),
      (e) => e instanceof ConflictError && e.paths[0] === 'content/about.md' && e.details[0].expected === null);
    // created externally after load
    fake.setFile('content/posts/race.md', 'someone else\n');
    await assert.rejects(
      () => repo.commit({ message: 'm', changes: [
        { path: 'content/posts/race.md', content: 'x', baseSha: null },
        { path: 'content/posts/ok.md', content: 'y', baseSha: null },
      ] }),
      (e) => e instanceof ConflictError && e.paths.length === 1 && e.paths[0] === 'content/posts/race.md');
    assert.equal(fake.readFile('content/posts/ok.md'), undefined, 'all-or-nothing');
    // succeeds when it really does not exist
    await repo.commit({ message: 'm', changes: [{ path: 'content/posts/ok.md', content: 'y', baseSha: null }] });
    assert.equal(fake.readText('content/posts/ok.md'), 'y\n');
  });

  test('baseSha "<sha>" → must match; deleted-elsewhere file is a conflict', async () => {
    const { fake, repo } = await loadedRepo();
    const sha = repo.entry('content/posts/bye.md').sha;
    fake.setFile('content/posts/bye.md', null);
    await assert.rejects(
      () => repo.commit({ message: 'm', changes: [{ path: 'content/posts/bye.md', content: 'x', baseSha: sha }] }),
      (e) => e instanceof ConflictError && e.details[0].actual === null);
    // matching sha succeeds
    const helloSha = repo.entry('content/posts/hello.md').sha;
    const res = await repo.commit({ message: 'm', changes: [{ path: 'content/posts/hello.md', content: 'ok', baseSha: helloSha }] });
    assert.equal(fake.readText('content/posts/hello.md'), 'ok\n');
    // and the returned sha works as the next baseSha
    await repo.commit({ message: 'm', changes: [{ path: 'content/posts/hello.md', content: 'ok2', baseSha: res.shas['content/posts/hello.md'] }] });
    assert.equal(fake.readText('content/posts/hello.md'), 'ok2\n');
  });

  test('delete with baseSha mismatch → conflict; delete of missing path with baseSha null is skipped', async () => {
    const { fake, repo } = await loadedRepo();
    const sha = repo.entry('content/about.md').sha;
    fake.setFile('content/about.md', 'changed\n');
    await assert.rejects(
      () => repo.commit({ message: 'm', changes: [{ path: 'content/about.md', delete: true, baseSha: sha }] }),
      ConflictError);
    assert.equal(fake.readText('content/about.md'), 'changed\n');
    const before = fake.ref;
    const res = await repo.commit({ message: 'm', changes: [{ path: 'gone.md', delete: true, baseSha: null }] });
    assert.equal(fake.ref, before, 'nothing to do → no commit');
    assert.equal(res.commitSha, before);
    assert.equal(res.unchanged, true);
  });

  test('identical content → no empty commit', async () => {
    const { fake, repo } = await loadedRepo();
    const before = fake.ref;
    const res = await repo.commit({ message: 'm', changes: [{ path: 'content/posts/hello.md', content: SEED['content/posts/hello.md'] }] });
    assert.equal(fake.ref, before);
    assert.equal(res.commitSha, before);
    assert.equal(res.unchanged, true);
    assert.equal(res.shas['content/posts/hello.md'], fake.shaOf('content/posts/hello.md'));
  });

  test('retries once when updateRef fails with 422 (head moved), then succeeds keeping both changes', async () => {
    const { fake, repo } = await loadedRepo();
    let injected = false;
    fake.intercept((req) => req.method === 'PATCH', (req, f) => {
      // someone pushes right before our ref update → real non-fast-forward
      f.setFile('content/posts/external.md', 'external\n');
      injected = true;
    });
    const res = await repo.commit({ message: 'mine', changes: [
      { path: 'content/posts/hello.md', content: 'mine', baseSha: repo.entry('content/posts/hello.md').sha },
      { path: 'static/images/x.bin', content: new Uint8Array([1, 2, 3]) },
    ] });
    assert.ok(injected);
    assert.equal(fake.count('PATCH', /\/git\/refs\/heads\/main$/), 2);
    assert.equal(fake.count('GET', /\/git\/ref\/heads\/main$/), 3, 'load + 2 attempts');
    assert.equal(fake.count('POST', /\/git\/blobs$/), 2, 'blobs reused on retry');
    assert.equal(res.commitSha, fake.ref);
    assert.equal(fake.readText('content/posts/hello.md'), 'mine\n');
    assert.equal(fake.readText('content/posts/external.md'), 'external\n', 'external change preserved');
    const commit = fake.objects.get(fake.ref);
    assert.equal(commit.message, 'mine');
    assert.equal(fake.objects.get(commit.parents[0]).message, 'external', 'rebased on the new head');
    assert.ok(repo.has('content/posts/external.md'), 'local tree includes external change');
    assert.equal(repo.commitSha, fake.ref);
  });

  test('retry re-checks conflicts: a file changed between attempts → ConflictError', async () => {
    const { fake, repo } = await loadedRepo();
    fake.intercept((req) => req.method === 'PATCH', (req, f) => { f.setFile('content/posts/hello.md', 'theirs\n'); });
    await assert.rejects(
      () => repo.commit({ message: 'm', changes: [
        { path: 'content/posts/hello.md', content: 'mine', baseSha: repo.entry('content/posts/hello.md').sha }] }),
      ConflictError);
    assert.equal(fake.readText('content/posts/hello.md'), 'theirs\n');
  });

  test('persistent 422 → GitHubError after exactly one retry; nothing changes', async () => {
    const { fake, repo } = await loadedRepo();
    fake.intercept((req) => req.method === 'PATCH', () => json(422, { message: 'Update is not a fast forward' }), { once: false });
    const beforeRef = fake.ref;
    const beforeList = repo.list();
    const err = await rejectsGitHub(
      () => repo.commit({ message: 'm', changes: [{ path: 'content/posts/hello.md', content: 'mine' }] }),
      { status: 422, message: /发布失败/ });
    assert.match(err.message, /Update is not a fast forward/);
    assert.equal(fake.count('PATCH', /refs\/heads\/main$/), 2);
    assert.equal(fake.ref, beforeRef);
    assert.equal(repo.commitSha, beforeRef);
    assert.deepEqual(repo.list(), beforeList);
  });

  test('409 from updateRef is also retried', async () => {
    const { fake, repo } = await loadedRepo();
    fake.intercept((req) => req.method === 'PATCH', () => json(409, { message: 'Reference update failed' }));
    await repo.commit({ message: 'm', changes: [{ path: 'a.md', content: 'a' }] });
    assert.equal(fake.readText('a.md'), 'a\n');
  });

  test('network error on updateRef that actually applied → treated as success', async () => {
    const { fake, repo } = await loadedRepo();
    fake.intercept((req) => req.method === 'PATCH', async (req, f) => {
      // let the real handler apply it, then lose the response
      f.ref = req.body.sha;
      throw new TypeError('fetch failed');
    });
    const res = await repo.commit({ message: 'm', changes: [{ path: 'a.md', content: 'a' }] });
    assert.equal(res.commitSha, fake.ref);
    assert.equal(fake.readText('a.md'), 'a\n');
    assert.ok(repo.has('a.md'));
  });

  test('network error on updateRef that did not apply → network GitHubError', async () => {
    const { fake, repo } = await loadedRepo();
    const before = fake.ref;
    fake.intercept((req) => req.method === 'PATCH', async () => { throw new TypeError('fetch failed'); });
    await rejectsGitHub(() => repo.commit({ message: 'm', changes: [{ path: 'a.md', content: 'a' }] }),
      { status: 0, message: '网络错误，无法连接 GitHub' });
    assert.equal(fake.ref, before);
    assert.ok(!repo.has('a.md'));
  });

  // --- lost ref-update response (commit landed, the phone never heard back) ---------------

  /** PATCH applies on the server but the response is lost; then `refReadsDown` ref reads fail too. */
  function loseRefResponse(fake, { refReadsDown = Infinity } = {}) {
    const st = { down: 0, applied: false };
    fake.intercept((req) => req.method === 'PATCH', async (req, f) => {
      f.ref = req.body.sha;
      st.applied = true;
      st.down = refReadsDown;
      throw new TypeError('fetch failed');
    });
    fake.intercept((req) => req.method === 'GET' && req.path.endsWith('/git/ref/heads/main'), async () => {
      if (st.down > 0) { st.down--; throw new TypeError('fetch failed'); }
      return undefined;
    }, { once: false });
    return st;
  }

  test('lost updateRef response + head unreadable → "uncertain" error, and retrying is idempotent (no false conflict, no second commit)', async () => {
    const { fake, repo } = await loadedRepo();
    const st = loseRefResponse(fake, { refReadsDown: 100 });
    const changes = () => [
      { path: 'content/posts/net-drop.md', content: '---\ntitle: x\n---\nbody', baseSha: null },
      { path: 'static/documents/notes.pdf', content: new Uint8Array([37, 80, 68, 70, 1, 2]), baseSha: null },
    ];
    const err = await rejectsGitHub(() => repo.commit({ message: 'first', changes: changes() }), { status: 0 });
    assert.equal(err.uncertain, true);
    assert.match(err.message, /无法确认/);
    assert.ok(st.applied);
    const landed = fake.ref;
    const count = fake.commitCount();
    st.down = 0;   // network is back
    const res = await repo.commit({ message: 'again', changes: changes() });
    assert.equal(res.unchanged, true);
    assert.equal(res.alreadyApplied, true);
    assert.equal(res.commitSha, landed);
    assert.equal(fake.commitCount(), count, 'no duplicate commit');
    assert.equal(res.shas['content/posts/net-drop.md'], fake.shaOf('content/posts/net-drop.md'));
    assert.ok(repo.has('content/posts/net-drop.md') && repo.has('static/documents/notes.pdf'));
  });

  test('after a possibly-landed commit, publishing NEWER content over our own write is not a conflict', async () => {
    const { fake, repo } = await loadedRepo();
    const st = loseRefResponse(fake, { refReadsDown: 100 });
    await rejectsGitHub(() => repo.commit({ message: 'first', changes: [
      { path: 'content/posts/new.md', content: 'date: 10:00:01', baseSha: null }] }), { status: 0 });
    st.down = 0;
    // editor regenerated the file (e.g. a new timestamp) and still believes the file is new
    const res = await repo.commit({ message: 'second', changes: [
      { path: 'content/posts/new.md', content: 'date: 10:00:42', baseSha: null }] });
    assert.ok(!res.unchanged);
    assert.equal(fake.readText('content/posts/new.md'), 'date: 10:00:42\n');
    // but a genuinely foreign change is still a conflict
    fake.setFile('content/posts/new.md', 'someone else\n');
    await assert.rejects(() => repo.commit({ message: 'third', changes: [
      { path: 'content/posts/new.md', content: 'mine', baseSha: res.shas['content/posts/new.md'] }] }), ConflictError);
  });

  test('lost updateRef response on an existing file: same content again → no false conflict', async () => {
    const { fake, repo } = await loadedRepo();
    const base = repo.entry('content/posts/hello.md').sha;
    const st = loseRefResponse(fake, { refReadsDown: 100 });
    await rejectsGitHub(() => repo.commit({ message: 'm', changes: [
      { path: 'content/posts/hello.md', content: 'edited', baseSha: base }] }), { status: 0 });
    st.down = 0;
    const res = await repo.commit({ message: 'm', changes: [
      { path: 'content/posts/hello.md', content: 'edited', baseSha: base }] });
    assert.equal(res.alreadyApplied, true);
    assert.equal(fake.readText('content/posts/hello.md'), 'edited\n');
  });

  test('lost updateRef response, head readable after a short outage → confirmed as success', async () => {
    const { fake, repo } = await loadedRepo();
    loseRefResponse(fake, { refReadsDown: 3 });   // first confirm attempt fails (GET retried once), later ones work
    const res = await repo.commit({ message: 'm', changes: [{ path: 'a.md', content: 'a' }] });
    assert.equal(res.commitSha, fake.ref);
    assert.ok(repo.has('a.md'));
  });

  test('lost updateRef response, replica still shows the parent at first → keeps polling and confirms', async () => {
    const { fake, repo } = await loadedRepo();
    const parent = fake.ref;
    fake.intercept((req) => req.method === 'PATCH', async (req, f) => { f.ref = req.body.sha; throw new TypeError('fetch failed'); });
    fake.intercept((req) => req.method === 'GET' && req.path.endsWith('/git/ref/heads/main'),
      () => json(200, { ref: 'refs/heads/main', object: { sha: parent, type: 'commit' } }));
    const res = await repo.commit({ message: 'm', changes: [{ path: 'a.md', content: 'a' }] });
    assert.equal(res.commitSha, fake.ref);
  });

  test('gitBlobSha matches git', async () => {
    const bytes = new TextEncoder().encode('hello\n');
    assert.equal(await gitBlobSha(bytes), createHash('sha1').update('blob 6\0hello\n').digest('hex'));
    assert.equal(await gitBlobSha(new Uint8Array(0)), 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391');
  });

  test('at most 4 concurrent blob uploads', async () => {
    const { fake, repo } = await loadedRepo();
    fake.blobDelayMs = 15;
    const changes = Array.from({ length: 11 }, (_, i) => ({ path: `static/images/p/${i}.bin`, content: new Uint8Array([i, i, i]) }));
    const progress = [];
    await repo.commit({ message: 'm', changes, onProgress: (p) => progress.push(p) });
    assert.equal(fake.count('POST', /\/git\/blobs$/), 11);
    assert.ok(fake.blobMaxInFlight <= 4, `max in flight ${fake.blobMaxInFlight}`);
    assert.ok(fake.blobMaxInFlight >= 2, 'uploads actually run in parallel');
    for (let i = 0; i < 11; i++) assert.deepEqual([...fake.readFile(`static/images/p/${i}.bin`)], [i, i, i]);
    const uploads = progress.filter((p) => p.phase === 'upload');
    assert.equal(uploads.at(-1).done, 11);
    assert.equal(uploads.at(-1).total, 11);
    assert.equal(progress.at(-1).phase, 'done');
  });

  test('blob upload failure aborts the commit (no ref change)', async () => {
    const { fake, repo } = await loadedRepo();
    let n = 0;
    fake.intercept((req) => req.method === 'POST' && req.path.endsWith('/git/blobs') && ++n === 3,
      () => json(403, { message: 'Resource not accessible by personal access token' }), { once: false });
    const before = fake.ref;
    await rejectsGitHub(() => repo.commit({ message: 'm', changes: Array.from({ length: 6 }, (_, i) => ({ path: `f${i}.txt`, content: String(i) })) }),
      { status: 403, message: '令牌没有足够的权限（需要本仓库的 Contents 读写权限）' });
    assert.equal(fake.ref, before);
    assert.equal(fake.count('POST', /\/git\/trees$/), 0);
  });

  test('preserves the executable bit when overwriting an executable file', async () => {
    const { fake, repo } = await loadedRepo();
    await repo.commit({ message: 'm', changes: [{ path: 'tools/run.sh', content: '#!/bin/sh\necho bye' }] });
    assert.equal(fake.flatten(fake.headTree()).flat.get('tools/run.sh').mode, '100755');
  });

  test('concurrent commit() calls are serialised and both land', async () => {
    const { fake, repo } = await loadedRepo();
    const before = fake.commitCount();
    const [a, b] = await Promise.all([
      repo.commit({ message: 'one', changes: [{ path: 'one.md', content: '1', baseSha: null }] }),
      repo.commit({ message: 'two', changes: [{ path: 'two.md', content: '2', baseSha: null }] }),
    ]);
    assert.equal(fake.commitCount(), before + 2);
    assert.equal(fake.ref, b.commitSha);
    assert.equal(fake.objects.get(b.commitSha).parents[0], a.commitSha);
    assert.equal(fake.count('PATCH', /refs/), 2, 'no 422 retries needed');
    assert.ok(repo.has('one.md') && repo.has('two.md'));
  });

  test('stale ref read right after our own commit does not cause a false conflict', async () => {
    const { fake, repo } = await loadedRepo();
    const oldHead = fake.ref;
    const r1 = await repo.commit({ message: 'one', changes: [{ path: 'content/posts/hello.md', content: 'v1' }] });
    // GitHub read replica lags: next ref read still returns the old head
    fake.intercept((req) => req.method === 'GET' && req.path.endsWith('/git/ref/heads/main'),
      () => json(200, { ref: 'refs/heads/main', object: { sha: oldHead, type: 'commit' } }));
    const r2 = await repo.commit({ message: 'two', changes: [
      { path: 'content/posts/hello.md', content: 'v2', baseSha: r1.shas['content/posts/hello.md'] }] });
    assert.equal(fake.readText('content/posts/hello.md'), 'v2\n');
    assert.equal(fake.objects.get(r2.commitSha).parents[0], r1.commitSha);
    // load() during lag does not regress the local view either
    fake.intercept((req) => req.method === 'GET' && req.path.endsWith('/git/ref/heads/main'),
      () => json(200, { ref: 'refs/heads/main', object: { sha: r1.commitSha, type: 'commit' } }));
    await repo.load();
    assert.equal(repo.commitSha, r2.commitSha);
  });

  test('after the lag window the server ref is trusted again (e.g. branch reset on GitHub)', async () => {
    const { fake, repo } = await loadedRepo();
    const oldHead = fake.ref;
    await repo.commit({ message: 'one', changes: [{ path: 'a.md', content: 'a' }] });
    fake.ref = oldHead;   // someone force-pushed main back
    const realNow = Date.now;
    Date.now = () => realNow() + 3 * 60 * 1000;
    try {
      await repo.load();
    } finally {
      Date.now = realNow;
    }
    assert.equal(repo.commitSha, oldHead);
    assert.equal(repo.has('a.md'), false);
  });

  test('duplicate paths: last change wins, every baseSha is checked', async () => {
    const { fake, repo } = await loadedRepo();
    await repo.commit({ message: 'm', changes: [
      { path: 'x.md', content: 'first' },
      { path: 'x.md', content: 'second' },
    ] });
    assert.equal(fake.readText('x.md'), 'second\n');
    await assert.rejects(() => repo.commit({ message: 'm', changes: [
      { path: 'x.md', content: 'a', baseSha: repo.entry('x.md').sha },
      { path: 'x.md', content: 'b', baseSha: 'f'.repeat(40) },
    ] }), ConflictError);
  });

  test('rejects bad input: empty changes, bad paths, submodule paths, file/dir clashes, bad content', async () => {
    const { fake, repo } = await loadedRepo();
    const before = fake.ref;
    await assert.rejects(() => repo.commit({ message: 'm', changes: [] }), /没有需要发布的修改/);
    for (const path of ['', '../x', 'a//b', 'a/./b', 'dir/', '.git/config', 'x/.GIT/y', 'a\\b', 'a\nb.md', 'tab\t.md', 42, undefined]) {
      await assert.rejects(() => repo.commit({ message: 'm', changes: [{ path, content: 'x' }] }), undefined, `path ${path}`);
    }
    await assert.rejects(() => repo.commit({ message: 'm', changes: [{ path: 'themes/PaperMod/layouts/x.html', content: 'x' }] }), /子模块/);
    await assert.rejects(() => repo.commit({ message: 'm', changes: [{ path: 'content/posts', content: 'x' }] }), /文件夹/);
    await assert.rejects(() => repo.commit({ message: 'm', changes: [{ path: 'static/avatar.jpg/x.png', content: 'x' }] }), /是一个文件/);
    await assert.rejects(() => repo.commit({ message: 'm', changes: [{ path: 'a.md' }] }), TypeError);
    await assert.rejects(() => repo.commit({ message: 'm', changes: [{ path: 'a.md', content: 12 }] }), TypeError);
    await assert.rejects(() => repo.commit({ message: 'm', changes: [{ path: 'a.md', content: 'x', baseSha: 5 }] }), TypeError);
    assert.equal(fake.ref, before);
    // a leading slash is tolerated
    await repo.commit({ message: 'm', changes: [{ path: '/content/lead.md', content: 'x' }] });
    assert.equal(fake.readText('content/lead.md'), 'x\n');
  });

  test('a failed commit does not block the next one', async () => {
    const { fake, repo } = await loadedRepo();
    await assert.rejects(() => repo.commit({ message: 'm', changes: [{ path: 'content/about.md', content: 'x', baseSha: null }] }), ConflictError);
    await repo.commit({ message: 'm', changes: [{ path: 'ok.md', content: 'ok' }] });
    assert.equal(fake.readText('ok.md'), 'ok\n');
  });
});

// ---------------------------------------------------------------------------
// watchDeploy

/** Collect updates until a final state (or timeout). */
function watch(repo, sha, opts) {
  const updates = [];
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('watchDeploy did not finish: ' + JSON.stringify(updates))), 3000);
    const handle = repo.watchDeploy(sha, (u) => {
      updates.push(u);
      if (['success', 'failure', 'unknown'].includes(u.state)) {
        clearTimeout(timer);
        // give a stray poll a chance to (wrongly) fire
        setTimeout(() => resolve({ updates, handle }), 30);
      }
    }, { intervalMs: 5, ...opts });
  });
}

describe('Repo.watchDeploy', () => {
  test('pending → running → success', async () => {
    const { fake, repo } = await loadedRepo();
    const sha = fake.ref;
    let polls = 0;
    fake.intercept((req) => req.path.endsWith('/actions/runs'), () => {
      polls++;
      const run = (status, conclusion = null) => [{ id: 1, status, conclusion, html_url: 'https://github.com/HimZFX/HimZFX.github.io/actions/runs/1', name: 'Deploy Hugo site to Pages' }];
      const runs = polls <= 2 ? [] : polls <= 3 ? run('queued') : polls <= 5 ? run('in_progress') : run('completed', 'success');
      return json(200, { total_count: runs.length, workflow_runs: runs });
    }, { once: false });
    const { updates } = await watch(repo, sha);
    const runUrl = 'https://github.com/HimZFX/HimZFX.github.io/actions/runs/1';
    // updates are emitted when the state OR the link changes: the queued run gives pending a real link
    assert.deepEqual(updates, [
      { state: 'pending', url: 'https://github.com/HimZFX/HimZFX.github.io/actions' },   // no run yet → fallback link
      { state: 'pending', url: runUrl },
      { state: 'running', url: runUrl },
      { state: 'success', url: runUrl },
    ]);
    const states = updates.map((u) => u.state).filter((s, i, a) => s !== a[i - 1]);
    assert.deepEqual(states, ['pending', 'running', 'success']);
    const after = polls;
    await sleep(40);
    assert.equal(polls, after, 'stops polling after the final state');
    assert.ok(fake.requests.some((r) => r.path.includes(`head_sha=${sha}`)));
  });

  test('failure', async () => {
    const { fake, repo } = await loadedRepo();
    fake.runs.set(fake.ref, [{ id: 2, status: 'completed', conclusion: 'failure', html_url: 'https://github.com/run/2', name: 'Deploy' }]);
    const { updates } = await watch(repo, fake.ref);
    assert.deepEqual(updates, [{ state: 'failure', url: 'https://github.com/run/2' }]);
  });

  test('one failed run among several → failure', async () => {
    const { fake, repo } = await loadedRepo();
    fake.runs.set(fake.ref, [
      { id: 3, status: 'in_progress', conclusion: null, html_url: 'https://github.com/run/3', name: 'Other' },
      { id: 4, status: 'completed', conclusion: 'timed_out', html_url: 'https://github.com/run/4', name: 'Deploy' },
    ]);
    const { updates } = await watch(repo, fake.ref);
    assert.deepEqual(updates.map((u) => u.state), ['failure']);
    assert.equal(updates[0].url, 'https://github.com/run/4');
  });

  test("403 (token lacks Actions permission) → 'unknown' and polling stops", async () => {
    const { fake, repo } = await loadedRepo();
    let polls = 0;
    fake.intercept((req) => req.path.endsWith('/actions/runs'), () => { polls++; return json(403, { message: 'Resource not accessible by personal access token' }, { 'x-ratelimit-remaining': '4000' }); }, { once: false });
    const { updates } = await watch(repo, fake.ref);
    assert.deepEqual(updates.map((u) => u.state), ['unknown']);
    assert.equal(updates[0].url, 'https://github.com/HimZFX/HimZFX.github.io/actions');
    await sleep(30);
    assert.equal(polls, 1);
  });

  test("404 → 'unknown'", async () => {
    const { fake, repo } = await loadedRepo();
    fake.intercept((req) => req.path.endsWith('/actions/runs'), () => json(404, { message: 'Not Found' }), { once: false });
    const { updates } = await watch(repo, fake.ref);
    assert.deepEqual(updates.map((u) => u.state), ['unknown']);
  });

  test('transient errors are tolerated', async () => {
    const { fake, repo } = await loadedRepo();
    let polls = 0;
    fake.intercept((req) => req.path.endsWith('/actions/runs'), () => {
      polls++;
      if (polls <= 2) throw new TypeError('fetch failed');
      return json(200, { workflow_runs: [{ id: 9, status: 'completed', conclusion: 'success', html_url: 'https://github.com/run/9', name: 'D' }] });
    }, { once: false });
    const { updates } = await watch(repo, fake.ref);
    assert.deepEqual(updates.map((u) => u.state), ['success']);
  });

  test("never finishing within maxMs → 'unknown'", async () => {
    const { fake, repo } = await loadedRepo();
    fake.runs.set(fake.ref, [{ id: 5, status: 'in_progress', conclusion: null, html_url: 'https://github.com/run/5', name: 'D' }]);
    const { updates } = await watch(repo, fake.ref, { maxMs: 40 });
    assert.deepEqual(updates.map((u) => u.state), ['running', 'unknown']);
  });

  test("no run ever appears → 'unknown' after noRunMs", async () => {
    const { fake, repo } = await loadedRepo();
    const { updates } = await watch(repo, fake.ref, { noRunMs: 30 });
    assert.deepEqual(updates.map((u) => u.state), ['pending', 'unknown']);
  });

  test("cancelled run (superseded by a newer publish) → 'unknown', not failure", async () => {
    const { fake, repo } = await loadedRepo();
    fake.runs.set(fake.ref, [{ id: 6, status: 'completed', conclusion: 'cancelled', html_url: 'https://github.com/run/6', name: 'D' }]);
    const { updates } = await watch(repo, fake.ref);
    assert.deepEqual(updates.map((u) => u.state), ['unknown']);
  });

  test("missing commit sha → 'unknown' without querying all runs", async () => {
    const { fake, repo } = await loadedRepo();
    const { updates } = await watch(repo, undefined);
    assert.deepEqual(updates.map((u) => u.state), ['unknown']);
    assert.equal(fake.count('GET', /actions\/runs/), 0);
  });

  test('stop() halts polling and suppresses further updates', async () => {
    const { fake, repo } = await loadedRepo();
    let polls = 0;
    fake.intercept((req) => req.path.endsWith('/actions/runs'), () => { polls++; return json(200, { workflow_runs: [] }); }, { once: false });
    const updates = [];
    const handle = repo.watchDeploy(fake.ref, (u) => updates.push(u), { intervalMs: 5 });
    await sleep(30);
    handle.stop();
    const n = polls;
    await sleep(40);
    assert.ok(polls - n <= 1, 'at most the in-flight poll completes');
    assert.ok(updates.every((u) => u.state === 'pending'));
  });

  test('a throwing onUpdate does not break polling', async () => {
    const { fake, repo } = await loadedRepo();
    let polls = 0;
    fake.intercept((req) => req.path.endsWith('/actions/runs'), () => {
      polls++;
      const runs = polls === 1 ? [] : [{ id: 1, status: 'completed', conclusion: 'success', html_url: 'u', name: 'D' }];
      return json(200, { workflow_runs: runs });
    }, { once: false });
    const states = [];
    const origError = console.error;
    console.error = () => {};
    try {
      await new Promise((resolve) => {
        repo.watchDeploy(fake.ref, (u) => { states.push(u.state); if (u.state === 'success') resolve(); else throw new Error('ui bug'); }, { intervalMs: 5 });
      });
    } finally {
      console.error = origError;
    }
    assert.deepEqual(states, ['pending', 'success']);
  });
});

describe('end-to-end through Repo + FakeGitHub', () => {
  test('publish a post with an image, then edit it, then delete it', async () => {
    const { fake, repo } = await loadedRepo();
    const md = '---\ntitle: "新文章"\ndraft: false\n---\n\n![a](/images/posts/new/a.jpg)\n';
    const jpg = new Blob([randomBytes(200 * 1024)]);
    const r1 = await repo.commit({ message: 'admin: 发表《新文章》', changes: [
      { path: 'content/posts/new.md', content: md, baseSha: null },
      { path: 'static/images/posts/new/a.jpg', content: jpg, baseSha: null },
    ] });
    assert.equal(await repo.readText('content/posts/new.md'), md);
    const r2 = await repo.commit({ message: 'admin: 更新《新文章》', changes: [
      { path: 'content/posts/new.md', content: md.replace('新文章', '新文章2'), baseSha: r1.shas['content/posts/new.md'] },
    ] });
    assert.equal(fake.readText('content/posts/new.md'), md.replace('新文章', '新文章2'));
    await repo.commit({ message: 'admin: 删除《新文章2》', changes: [
      { path: 'content/posts/new.md', delete: true, baseSha: r2.shas['content/posts/new.md'] },
      ...repo.list('static/images/posts/new/').map((e) => ({ path: e.path, delete: true, baseSha: e.sha })),
    ] });
    assert.equal(fake.readFile('content/posts/new.md'), undefined);
    assert.equal(fake.readFile('static/images/posts/new/a.jpg'), undefined);
    assert.deepEqual(repo.list('static/images/posts/new/'), []);
    assert.deepEqual(fake.flatten(fake.headTree()).dirs.filter((d) => d.path.startsWith('static/images/posts/new')), [], 'empty dir pruned');
  });
});
