// tests/admin/mock.test.mjs — tests for the mock GitHub server itself.
// Run: node --test tests/admin/mock.test.mjs
// Env: HUGO_BIN (Hugo 0.147.4 extended), ADMIN_TEST_TMP (where builds go; default: OS temp dir),
//      ADMIN_TEST_KEEP=1 (keep the exported/built dirs for inspection).

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { startMock, buildSite, openAdmin, REPO_ROOT, hugoBin, mimeType } from './mock-github.mjs';

const OWNER = 'HimZFX';
const REPO = 'HimZFX.github.io';
const R = `/repos/${OWNER}/${REPO}`;

const TMP = (() => {
  const base = process.env.ADMIN_TEST_TMP || os.tmpdir();
  fs.mkdirSync(base, { recursive: true });
  return fs.mkdtempSync(path.join(base, 'mock-test-'));
})();

// Remove this run's exports/builds afterwards (set ADMIN_TEST_KEEP=1 to inspect them).
after(() => {
  if (!process.env.ADMIN_TEST_KEEP) fs.rmSync(TMP, { recursive: true, force: true });
});

/** fetch the mock API like GitHubClient does. */
async function api(mock, method, p, body, { token = mock.token, scheme = 'Bearer', headers = {} } = {}) {
  const res = await fetch(mock.apiBase + p, {
    method,
    cache: 'no-store',
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(token ? { Authorization: `${scheme} ${token}` } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }
  return { status: res.status, headers: res.headers, json, text };
}

async function head(mock) {
  const ref = await api(mock, 'GET', `${R}/git/ref/heads/main`);
  assert.equal(ref.status, 200);
  const commit = await api(mock, 'GET', `${R}/git/commits/${ref.json.object.sha}`);
  assert.equal(commit.status, 200);
  return { commitSha: ref.json.object.sha, treeSha: commit.json.tree.sha };
}

/** Commit via the Git Data API (blobs → tree → commit → ref), like Repo.commit. */
async function commitFiles(mock, message, files, { parent } = {}) {
  const h = await head(mock);
  const tree = [];
  for (const [p, content] of Object.entries(files)) {
    if (content === null) {
      tree.push({ path: p, mode: '100644', type: 'blob', sha: null });
      continue;
    }
    const blob = await api(mock, 'POST', `${R}/git/blobs`, {
      content: Buffer.from(content).toString('base64'),
      encoding: 'base64',
    });
    assert.equal(blob.status, 201, blob.text);
    tree.push({ path: p, mode: '100644', type: 'blob', sha: blob.json.sha });
  }
  const t = await api(mock, 'POST', `${R}/git/trees`, { base_tree: h.treeSha, tree });
  assert.equal(t.status, 201, t.text);
  const c = await api(mock, 'POST', `${R}/git/commits`, { message, tree: t.json.sha, parents: [parent || h.commitSha] });
  assert.equal(c.status, 201, c.text);
  const ref = await api(mock, 'PATCH', `${R}/git/refs/heads/main`, { sha: c.json.sha, force: false });
  return { ref, commitSha: c.json.sha, treeSha: t.json.sha };
}

const gitBlobSha = (buf) => crypto.createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex');

// -----------------------------------------------------------------------------
describe('API (seeded from the repository)', () => {
  let mock;
  before(async () => {
    mock = await startMock({ runDelayMs: 400 });
  });
  after(() => mock.close());

  test('GET /user and /repos: shapes, permissions.push, rate limit header', async () => {
    const u = await api(mock, 'GET', '/user');
    assert.equal(u.status, 200);
    assert.equal(u.json.login, OWNER);
    assert.match(u.json.avatar_url, /^http:\/\/127\.0\.0\.1:\d+\//);
    const r = await api(mock, 'GET', R);
    assert.equal(r.status, 200);
    assert.equal(r.json.permissions.push, true);
    assert.equal(r.json.default_branch, 'main');
    assert.equal(r.json.full_name, `${OWNER}/${REPO}`);
    const remaining = Number(r.headers.get('x-ratelimit-remaining'));
    assert.ok(remaining > 0 && remaining < 5000, `x-ratelimit-remaining=${remaining}`);
    assert.equal(r.headers.get('x-ratelimit-limit'), '5000');
    // owner/repo are case-insensitive like on GitHub
    assert.equal((await api(mock, 'GET', `/repos/himzfx/himzfx.GITHUB.io`)).status, 200);
    assert.equal((await api(mock, 'GET', `/repos/${OWNER}/other-repo`)).status, 404);
  });

  test('auth: missing / bad token → 401, "token" scheme accepted, setToken revokes', async () => {
    const missing = await api(mock, 'GET', '/user', undefined, { token: null });
    assert.equal(missing.status, 401);
    assert.equal(missing.json.message, 'Requires authentication');
    const bad = await api(mock, 'GET', `${R}/git/ref/heads/main`, undefined, { token: 'nope' });
    assert.equal(bad.status, 401);
    assert.equal(bad.json.message, 'Bad credentials');
    assert.equal(bad.json.documentation_url.startsWith('https://docs.github.com/'), true);
    assert.equal((await api(mock, 'GET', '/user', undefined, { scheme: 'token' })).status, 200);
    mock.setToken('rotated');
    assert.equal((await api(mock, 'GET', '/user')).status, 401);
    mock.setToken(mock.token);
    assert.equal((await api(mock, 'GET', '/user')).status, 200);
    // the request log never contains the token
    assert.ok(mock.requests.length > 0);
    assert.ok(!JSON.stringify(mock.requests).includes(mock.token));
  });

  test('read head → recursive tree → blob (real git SHA-1s, GitHub-style base64)', async () => {
    const h = await head(mock);
    assert.deepEqual(h, mock.head());
    const t = await api(mock, 'GET', `${R}/git/trees/${h.treeSha}?recursive=1`);
    assert.equal(t.status, 200);
    assert.equal(t.json.truncated, false);
    const byPath = new Map(t.json.tree.map((e) => [e.path, e]));
    const params = byPath.get('config/_default/params.toml');
    assert.equal(params.type, 'blob');
    assert.equal(params.mode, '100644');
    const disk = fs.readFileSync(path.join(REPO_ROOT, 'config/_default/params.toml'));
    assert.equal(params.sha, gitBlobSha(disk));
    assert.equal(params.size, disk.length);
    // same blob id as `git hash-object`
    assert.equal(params.sha, execFileSync('git', ['-C', REPO_ROOT, 'hash-object', 'config/_default/params.toml']).toString().trim());
    // directories are tree entries; the theme submodule is a `commit` entry; no theme files
    assert.equal(byPath.get('config/_default').type, 'tree');
    assert.equal(byPath.get('themes/PaperMod')?.type, 'commit');
    assert.equal(byPath.get('themes/PaperMod').mode, '160000');
    assert.ok(![...byPath.keys()].some((p) => p.startsWith('themes/PaperMod/')));
    // a fully committed directory has the same tree sha as in real git
    const realConfigTree = execFileSync('git', ['-C', REPO_ROOT, 'rev-parse', 'HEAD:archetypes']).toString().trim();
    const dirty = execFileSync('git', ['-C', REPO_ROOT, 'status', '--porcelain', 'archetypes']).toString().trim();
    if (!dirty) assert.equal(byPath.get('archetypes').sha, realConfigTree);

    const b = await api(mock, 'GET', `${R}/git/blobs/${params.sha}`);
    assert.equal(b.status, 200);
    assert.equal(b.json.encoding, 'base64');
    assert.equal(b.json.size, disk.length);
    const lines = b.json.content.split('\n');
    assert.equal(lines.pop(), '', 'base64 ends with a newline');
    assert.ok(lines.length > 1 && lines.every((l) => l.length <= 60), 'wrapped at 60 chars');
    assert.ok(lines.slice(0, -1).every((l) => l.length === 60));
    assert.deepEqual(Buffer.from(b.json.content.replace(/\n/g, ''), 'base64'), disk);

    // non-recursive listing: top level only
    const top = await api(mock, 'GET', `${R}/git/trees/${h.treeSha}`);
    assert.ok(top.json.tree.every((e) => !e.path.includes('/')));
    // unknown objects → 404
    assert.equal((await api(mock, 'GET', `${R}/git/blobs/${'0'.repeat(40)}`)).status, 404);
    assert.equal((await api(mock, 'GET', `${R}/git/commits/${'1'.repeat(40)}`)).status, 404);
    assert.equal((await api(mock, 'GET', `${R}/git/trees/${'2'.repeat(40)}`)).status, 404);
    assert.equal((await api(mock, 'GET', `${R}/git/ref/heads/nope`)).status, 404);
  });

  test('GET responses are cacheable like api.github.com (ETag → 304)', async () => {
    const r1 = await api(mock, 'GET', `${R}/git/ref/heads/main`);
    assert.match(r1.headers.get('cache-control'), /max-age=60/);
    const etag = r1.headers.get('etag');
    assert.ok(etag);
    const r2 = await api(mock, 'GET', `${R}/git/ref/heads/main`, undefined, { headers: { 'If-None-Match': etag } });
    assert.equal(r2.status, 304);
  });

  test('write flow: blobs → tree(base_tree + deletion) → commit → ref', async () => {
    const before = await head(mock);
    const delPath = 'content/posts/first-physics-note.en.md';
    assert.ok(mock.readFile(delPath) !== undefined);
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3, 255]);

    // utf-8 encoded blob
    const md = '---\ntitle: "测试"\n---\n\n你好 mock\n';
    const b1 = await api(mock, 'POST', `${R}/git/blobs`, { content: md, encoding: 'utf-8' });
    assert.equal(b1.status, 201);
    assert.equal(b1.json.sha, gitBlobSha(Buffer.from(md)));
    // base64 blob (binary), with line breaks like GitHub produces
    const b64 = png.toString('base64');
    const b2 = await api(mock, 'POST', `${R}/git/blobs`, { content: b64.slice(0, 4) + '\n' + b64.slice(4), encoding: 'base64' });
    assert.equal(b2.status, 201);
    assert.equal(b2.json.sha, gitBlobSha(png));

    const t = await api(mock, 'POST', `${R}/git/trees`, {
      base_tree: before.treeSha,
      tree: [
        { path: 'content/posts/mock-new.md', mode: '100644', type: 'blob', sha: b1.json.sha },
        { path: 'static/images/posts/mock-new/a.png', mode: '100644', type: 'blob', sha: b2.json.sha },
        { path: delPath, mode: '100644', type: 'blob', sha: null },
      ],
    });
    assert.equal(t.status, 201, t.text);
    assert.notEqual(t.json.sha, before.treeSha);
    const c = await api(mock, 'POST', `${R}/git/commits`, { message: 'admin: 发表《测试》', tree: t.json.sha, parents: [before.commitSha] });
    assert.equal(c.status, 201);
    assert.equal(c.json.tree.sha, t.json.sha);
    assert.deepEqual(c.json.parents.map((p) => p.sha), [before.commitSha]);
    assert.equal(c.json.message, 'admin: 发表《测试》');
    // not on the branch until the ref moves
    assert.equal(mock.readFile('content/posts/mock-new.md'), undefined);

    const ref = await api(mock, 'PATCH', `${R}/git/refs/heads/main`, { sha: c.json.sha, force: false });
    assert.equal(ref.status, 200);
    assert.equal(ref.json.ref, 'refs/heads/main');
    assert.equal(ref.json.object.sha, c.json.sha);

    const after = await head(mock);
    assert.equal(after.commitSha, c.json.sha);
    assert.equal(mock.readFile('content/posts/mock-new.md'), md);
    assert.deepEqual(mock.files().get('static/images/posts/mock-new/a.png'), png);
    assert.equal(mock.readFile(delPath), undefined);
    assert.equal(mock.shaOf('content/posts/mock-new.md'), b1.json.sha);
    const last = mock.commits.at(-1);
    assert.equal(last.sha, c.json.sha);
    assert.equal(last.message, 'admin: 发表《测试》');
    assert.deepEqual(last.changes, [
      { path: 'content/posts/first-physics-note.en.md', status: 'removed' },
      { path: 'content/posts/mock-new.md', status: 'added' },
      { path: 'static/images/posts/mock-new/a.png', status: 'added' },
    ]);
    // recursive tree reflects it (new directories exist as tree entries)
    const tree = await api(mock, 'GET', `${R}/git/trees/${after.treeSha}?recursive=1`);
    const paths = tree.json.tree.map((e) => e.path);
    assert.ok(paths.includes('static/images/posts/mock-new'));
    assert.ok(!paths.includes(delPath));
  });

  test('delete a file; empty directories disappear', async () => {
    const r = await commitFiles(mock, 'admin: 删除图片', { 'static/images/posts/mock-new/a.png': null });
    assert.equal(r.ref.status, 200);
    assert.equal(mock.readBytes('static/images/posts/mock-new/a.png'), undefined);
    const tree = await api(mock, 'GET', `${R}/git/trees/${r.treeSha}?recursive=1`);
    assert.ok(!tree.json.tree.some((e) => e.path.startsWith('static/images/posts')));
    assert.deepEqual(mock.commits.at(-1).changes, [{ path: 'static/images/posts/mock-new/a.png', status: 'removed' }]);
  });

  test('createTree validation (strict like GitHub)', async () => {
    const h = await head(mock);
    const bad = async (tree, base = h.treeSha) => api(mock, 'POST', `${R}/git/trees`, { base_tree: base, tree });
    const missing = await bad([{ path: 'no/such/file.md', mode: '100644', type: 'blob', sha: null }]);
    assert.equal(missing.status, 422);
    assert.equal((await bad([{ path: '/abs.md', mode: '100644', type: 'blob', sha: null }])).status, 422);
    assert.equal((await bad([{ path: 'a/../b.md', mode: '100644', type: 'blob', content: 'x' }])).status, 422);
    assert.equal((await bad([{ path: 'x.md', mode: '100644', type: 'blob', sha: 'f'.repeat(40) }])).status, 422);
    assert.equal((await bad([{ path: 'x.md', mode: '644', type: 'blob', content: 'x' }])).status, 422);
    assert.equal((await bad([{ path: 'x.md', mode: '100644', type: 'blob', content: 'x' }], 'e'.repeat(40))).status, 422);
    // a file cannot become a parent directory
    assert.equal((await bad([{ path: 'SITE_GUIDE.md/x.md', mode: '100644', type: 'blob', content: 'x' }])).status, 422);
    // content instead of sha works
    const ok = await bad([{ path: 'inline.txt', mode: '100644', type: 'blob', content: 'hi' }]);
    assert.equal(ok.status, 201);
    // bad base64 (e.g. a data: URL prefix or url-safe alphabet) is rejected
    const b = await api(mock, 'POST', `${R}/git/blobs`, { content: 'data:image/png;base64,AAAA', encoding: 'base64' });
    assert.equal(b.status, 422);
    assert.equal((await api(mock, 'POST', `${R}/git/blobs`, { content: 'a-b_', encoding: 'base64' })).status, 422);
    assert.equal((await api(mock, 'POST', `${R}/git/blobs`, { encoding: 'base64' })).status, 422);
    // commit validation
    assert.equal((await api(mock, 'POST', `${R}/git/commits`, { message: 'x', tree: 'a'.repeat(40), parents: [h.commitSha] })).status, 422);
    assert.equal((await api(mock, 'POST', `${R}/git/commits`, { message: 'x', tree: h.treeSha, parents: ['b'.repeat(40)] })).status, 422);
    // nothing moved
    assert.deepEqual(await head(mock), h);
  });

  test('updateRef: non-fast-forward → 422 "Update is not a fast forward"', async () => {
    const base = await head(mock);
    const first = await commitFiles(mock, 'admin: A', { 'content/posts/ff-a.md': 'A\n' });
    assert.equal(first.ref.status, 200);
    // A second writer that still believes `base` is the head:
    const stale = await commitFiles(mock, 'admin: B', { 'content/posts/ff-b.md': 'B\n' }, { parent: base.commitSha });
    assert.equal(stale.ref.status, 422);
    assert.equal(stale.ref.json.message, 'Update is not a fast forward');
    assert.equal(mock.readFile('content/posts/ff-b.md'), undefined);
    assert.equal(mock.head().commitSha, first.commitSha);
    // moving the ref back to an ancestor is also not a fast forward
    const back = await api(mock, 'PATCH', `${R}/git/refs/heads/main`, { sha: base.commitSha, force: false });
    assert.equal(back.status, 422);
    // unknown sha
    const unknown = await api(mock, 'PATCH', `${R}/git/refs/heads/main`, { sha: 'c'.repeat(40) });
    assert.equal(unknown.status, 422);
    // updating to the current head is a no-op success
    const same = await api(mock, 'PATCH', `${R}/git/refs/heads/main`, { sha: first.commitSha, force: false });
    assert.equal(same.status, 200);
  });

  test('setFile simulates an external push (and is not recorded in mock.commits)', async () => {
    const p = 'config/_default/params.toml';
    const oldSha = mock.shaOf(p);
    const nCommits = mock.commits.length;
    const before = mock.head().commitSha;
    const newCommit = mock.setFile(p, mock.readFile(p) + '\n# changed elsewhere\n');
    assert.equal(mock.head().commitSha, newCommit);
    const h = await head(mock);
    assert.equal(h.commitSha, newCommit);
    const c = await api(mock, 'GET', `${R}/git/commits/${newCommit}`);
    assert.deepEqual(c.json.parents.map((x) => x.sha), [before]);
    const t = await api(mock, 'GET', `${R}/git/trees/${h.treeSha}?recursive=1`);
    const e = t.json.tree.find((x) => x.path === p);
    assert.notEqual(e.sha, oldSha);
    assert.match(mock.readFile(p), /# changed elsewhere/);
    assert.equal(mock.commits.length, nCommits);
    // an API commit based on the old head now fails as non-fast-forward
    const stale = await commitFiles(mock, 'admin: stale', { 'x.md': 'x' }, { parent: before });
    assert.equal(stale.ref.status, 422);
    // setFile(path, null) deletes
    mock.setFile('content/posts/ff-a.md', null);
    assert.equal(mock.readFile('content/posts/ff-a.md'), undefined);
  });

  test('actions runs progress queued → in_progress → completed/success over runDelayMs', async () => {
    const r = await commitFiles(mock, 'admin: deploy me', { 'content/posts/deploy.md': 'x\n' });
    assert.equal(r.ref.status, 200);
    const seen = [];
    const t0 = Date.now();
    for (;;) {
      const runs = await api(mock, 'GET', `${R}/actions/runs?head_sha=${r.commitSha}&per_page=10`);
      assert.equal(runs.status, 200);
      assert.equal(runs.json.total_count, 1);
      const run = runs.json.workflow_runs[0];
      assert.equal(run.head_sha, r.commitSha);
      assert.match(run.html_url, /^https:\/\/github\.com\/HimZFX\/HimZFX\.github\.io\/actions\/runs\/\d+$/);
      assert.equal(typeof run.id, 'number');
      assert.ok(run.name);
      if (seen.at(-1) !== run.status) seen.push(run.status);
      if (run.status === 'completed') {
        assert.equal(run.conclusion, 'success');
        break;
      }
      assert.equal(run.conclusion, null);
      assert.ok(Date.now() - t0 < 5000, 'run never completed');
      await new Promise((res) => setTimeout(res, 40));
    }
    assert.deepEqual(seen, ['queued', 'in_progress', 'completed']);
    // unknown sha → empty list
    const none = await api(mock, 'GET', `${R}/actions/runs?head_sha=${'d'.repeat(40)}`);
    assert.deepEqual(none.json, { total_count: 0, workflow_runs: [] });
    // failure conclusion and missing Actions permission
    mock.setRunConclusion('failure');
    mock.setRunDelay(0);
    const f = await commitFiles(mock, 'admin: will fail', { 'content/posts/deploy.md': 'y\n' });
    const fr = await api(mock, 'GET', `${R}/actions/runs?head_sha=${f.commitSha}`);
    assert.equal(fr.json.workflow_runs[0].conclusion, 'failure');
    mock.setActionsAccess(false);
    assert.equal((await api(mock, 'GET', `${R}/actions/runs?head_sha=${f.commitSha}`)).status, 403);
    mock.setActionsAccess(true);
    mock.setRunConclusion('success');
  });

  test('rate limit exhaustion → 403 with x-ratelimit-remaining: 0; failNext injection', async () => {
    mock.setRateLimitRemaining(0);
    const r = await api(mock, 'GET', '/user');
    assert.equal(r.status, 403);
    assert.equal(r.headers.get('x-ratelimit-remaining'), '0');
    assert.match(r.json.message, /rate limit/);
    mock.setRateLimitRemaining(4000);
    assert.equal((await api(mock, 'GET', '/user')).headers.get('x-ratelimit-remaining'), '3999');

    mock.failNext({ method: 'PATCH', path: '/git/refs/' }, { status: 409, message: 'Reference update failed' });
    const c = await commitFiles(mock, 'admin: injected', { 'content/posts/inj.md': 'i\n' });
    assert.equal(c.ref.status, 409);
    assert.equal(c.ref.json.message, 'Reference update failed');
    assert.equal(mock.readFile('content/posts/inj.md'), undefined);
    mock.failNext({ path: '/user' }, { network: true });
    await assert.rejects(api(mock, 'GET', '/user'));
    assert.equal((await api(mock, 'GET', '/user')).status, 200);
  });
});

// -----------------------------------------------------------------------------
describe('static serving', () => {
  let mock;
  let site;
  before(async () => {
    site = path.join(TMP, 'static-site');
    const w = (p, c) => {
      fs.mkdirSync(path.dirname(path.join(site, p)), { recursive: true });
      fs.writeFileSync(path.join(site, p), c);
    };
    w('index.html', '<!doctype html><title>home</title>');
    w('404.html', '<!doctype html><title>not found page</title>');
    w('posts/a/index.html', '<!doctype html><title>post a</title>');
    w('admin/index.html', '<!doctype html><title>admin</title>');
    w('admin/js/main.js', 'export const x = 1;\n');
    w('admin/js/lib.mjs', 'export default 2;\n');
    w('admin/css/admin.css', 'body{}');
    w('fonts/k.woff2', Buffer.from([1, 2, 3]));
    w('img/i.svg', '<svg xmlns="http://www.w3.org/2000/svg"/>');
    w('dir-without-index/file.txt', 'x');
    fs.writeFileSync(path.join(TMP, 'secret.txt'), 'TOP SECRET');
    fs.symlinkSync(path.join(TMP, 'secret.txt'), path.join(site, 'leak.txt'));
    mock = await startMock({ seedDir: null, seedFiles: { 'a.md': 'a\n' }, siteDir: site });
  });
  after(() => mock.close());

  const get = (p) => fetch(mock.url + p, { redirect: 'manual' });
  /** raw request: fetch/URL would normalize '..' before sending. */
  const raw = (p) =>
    new Promise((resolve, reject) => {
      const u = new URL(mock.url);
      const req = http.request({ host: u.hostname, port: u.port, path: p, method: 'GET' }, (res) => {
        let body = '';
        res.on('data', (d) => (body += d));
        res.on('end', () => resolve({ status: res.statusCode, body }));
      });
      req.on('error', reject);
      req.end();
    });

  test('MIME types for an ES-module app', async () => {
    const cases = {
      '/': 'text/html; charset=utf-8',
      '/admin/': 'text/html; charset=utf-8',
      '/admin/js/main.js': 'text/javascript; charset=utf-8',
      '/admin/js/lib.mjs': 'text/javascript; charset=utf-8',
      '/admin/css/admin.css': 'text/css; charset=utf-8',
      '/fonts/k.woff2': 'font/woff2',
      '/img/i.svg': 'image/svg+xml',
    };
    for (const [p, type] of Object.entries(cases)) {
      const r = await get(p);
      assert.equal(r.status, 200, p);
      assert.equal(r.headers.get('content-type'), type, p);
      assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    }
    assert.equal(await (await get('/posts/a/')).text(), '<!doctype html><title>post a</title>');
    assert.equal(mimeType('x.JPG'), 'image/jpeg');
    assert.equal(mimeType('x.unknown'), 'application/octet-stream');
  });

  test('directories: redirect to trailing slash, index.html, 404 without index', async () => {
    const r = await get('/posts/a?x=1');
    assert.equal(r.status, 301);
    assert.equal(r.headers.get('location'), '/posts/a/?x=1');
    const admin = await get('/admin');
    assert.equal(admin.status, 301);
    assert.equal(admin.headers.get('location'), '/admin/');
    const nf = await get('/dir-without-index/');
    assert.equal(nf.status, 404);
    const missing = await get('/no/such/file.js');
    assert.equal(missing.status, 404);
    assert.match(await missing.text(), /not found page/);
    assert.equal((await fetch(mock.url + '/', { method: 'POST' })).status, 405);
  });

  test('no directory traversal outside siteDir', async () => {
    for (const p of ['/../secret.txt', '/%2e%2e/secret.txt', '/admin/..%2f..%2fsecret.txt', '/..%5csecret.txt', '/a%00b', '/%E0%A4%A']) {
      const r = await raw(p);
      assert.ok(r.status === 400 || r.status === 404, `${p} → ${r.status}`);
      assert.ok(!r.body.includes('TOP SECRET'), p);
    }
    const leak = await raw('/leak.txt'); // symlink pointing outside the root
    assert.equal(leak.status, 404);
    assert.ok(!leak.body.includes('TOP SECRET'));
  });

  test('API and site share one origin; unknown API path → GitHub-style 404', async () => {
    assert.equal(new URL(mock.apiBase).origin, new URL(mock.url).origin);
    const r = await api(mock, 'GET', '/repos/HimZFX/HimZFX.github.io/nope');
    assert.equal(r.status, 404);
    assert.equal(r.json.message, 'Not Found');
    const pre = await fetch(mock.apiBase + '/user', { method: 'OPTIONS' });
    assert.equal(pre.status, 204);
    assert.match(pre.headers.get('access-control-allow-headers'), /Authorization/);
  });

  test('seedDir: null + seedFiles gives a tiny repo', async () => {
    assert.deepEqual([...mock.files().keys()], ['a.md']);
  });

  test('without admin/ in siteDir, /admin/ falls back to the repo static/admin', async () => {
    const m2 = await startMock({ seedDir: null, siteDir: path.join(site, 'posts') });
    try {
      const r = await fetch(m2.url + '/admin/vendor/js-yaml/js-yaml.mjs');
      assert.equal(r.status, 200);
      assert.equal(r.headers.get('content-type'), 'text/javascript; charset=utf-8');
    } finally {
      await m2.close();
    }
  });
});

// -----------------------------------------------------------------------------
describe('exportTo + buildSite (pinned Hugo)', { skip: !fs.existsSync(hugoBin()) && `Hugo not found at ${hugoBin()}` }, () => {
  const listFiles = (dir) => {
    const out = [];
    const walk = (rel) => {
      for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) walk(r);
        else out.push(r);
      }
    };
    walk('');
    return out.sort();
  };

  test('export of the seed builds the same site as the repository itself', async () => {
    const lockBefore = fs.statSync(path.join(REPO_ROOT, '.hugo_build.lock'), { throwIfNoEntry: false })?.mtimeMs;
    const hadResources = fs.existsSync(path.join(REPO_ROOT, 'resources'));
    const mock = await startMock({});
    let exportDir;
    try {
      exportDir = mock.exportTo(path.join(TMP, 'export'));
    } finally {
      await mock.close();
    }
    assert.ok(fs.lstatSync(path.join(exportDir, 'themes/PaperMod')).isSymbolicLink());
    assert.ok(fs.existsSync(path.join(exportDir, 'config/_default/hugo.toml')));
    assert.throws(() => mock.exportTo(path.join(REPO_ROOT, 'public')), /refusing/);
    assert.throws(() => mock.exportTo(path.dirname(REPO_ROOT)), /refusing/);

    const [fromExport, fromRepo] = await Promise.all([
      buildSite({ repoDir: exportDir, outDir: path.join(TMP, 'site-export') }),
      buildSite({ repoDir: REPO_ROOT, outDir: path.join(TMP, 'site-repo') }),
    ]);
    // static/admin is being edited concurrently by other agents → compare everything else.
    const a = listFiles(fromExport.outDir).filter((p) => !p.startsWith('admin/'));
    const b = listFiles(fromRepo.outDir).filter((p) => !p.startsWith('admin/'));
    assert.deepEqual(a, b);
    const pages = a.filter((p) => p.endsWith('.html'));
    assert.ok(pages.includes('index.html') && pages.includes('en/index.html'), pages.join(', '));
    assert.ok(pages.includes('posts/first-physics-note/index.html'));
    // identical rendered home page (fingerprinted CSS/JS hashes included)
    assert.equal(fs.readFileSync(path.join(fromExport.outDir, 'index.html'), 'utf8'), fs.readFileSync(path.join(fromRepo.outDir, 'index.html'), 'utf8'));
    // building never writes into the source repository
    assert.equal(fs.existsSync(path.join(REPO_ROOT, 'resources')), hadResources);
    assert.equal(fs.statSync(path.join(REPO_ROOT, '.hugo_build.lock'), { throwIfNoEntry: false })?.mtimeMs, lockBefore);
    await assert.rejects(buildSite({ repoDir: exportDir, outDir: path.join(REPO_ROOT, 'public') }), /refusing/);
  });

  test('a post committed through the API shows up on both language sites after export + build', async () => {
    const mock = await startMock({});
    try {
      const r = await commitFiles(mock, 'admin: 发表《Mock 文章》', {
        'content/posts/mock-roundtrip.md': '---\ntitle: "Mock 文章"\ndate: 2026-10-31T12:00:00+08:00\ndraft: false\n---\n\n正文 mock roundtrip\n',
      });
      assert.equal(r.ref.status, 200);
      const dir = mock.exportTo(path.join(TMP, 'export-roundtrip'));
      // Recipe for e2e tests: start the server first (siteDir is read lazily), then build with its URL
      // as baseURL so the site's absolute links point at the mock instead of himzfx.github.io.
      const siteDir = path.join(TMP, 'site-roundtrip');
      const m2 = await startMock({ seedDir: null, siteDir });
      try {
        const { outDir } = await buildSite({ repoDir: dir, outDir: siteDir, baseURL: m2.url + '/' });
        const zh = fs.readFileSync(path.join(outDir, 'posts/mock-roundtrip/index.html'), 'utf8');
        assert.match(zh, /正文 mock roundtrip/);
        assert.ok(fs.existsSync(path.join(outDir, 'en/posts/mock-roundtrip/index.html')));
        const page = await fetch(m2.url + '/posts/mock-roundtrip/');
        assert.equal(page.status, 200);
        const html = await page.text();
        assert.match(html, /Mock 文章/);
        assert.ok(html.includes(m2.url + '/'), 'links use the mock origin');
        assert.ok(!/himzfx\.github\.io\//i.test(html.replace(/https:\/\/github\.com\/HimZFX\/HimZFX\.github\.io/gi, '')));
      } finally {
        await m2.close();
      }
      await assert.rejects(buildSite({ repoDir: dir, outDir: siteDir, baseURL: '/' }), /baseURL must be absolute/);
    } finally {
      await mock.close();
    }
  });
});

// -----------------------------------------------------------------------------
const playwright = (() => {
  try {
    return createRequire(import.meta.url)('playwright');
  } catch {
    return null;
  }
})();

describe('openAdmin (Playwright, fake admin page)', { skip: !playwright && 'playwright not available' }, () => {
  let browser;
  let mock;
  before(async () => {
    const site = path.join(TMP, 'fake-admin-site');
    fs.mkdirSync(path.join(site, 'admin'), { recursive: true });
    fs.writeFileSync(
      path.join(site, 'admin/index.html'),
      '<!doctype html><meta charset="utf-8"><title>fake admin</title>' +
        '<img src="https://cdn.jsdelivr.net/npm/x/should-be-blocked.png" alt="">' +
        '<script type="module" src="./app.mjs"></script><body></body>',
    );
    // Minimal stand-in for the SHELL: reads the documented storage keys, calls GET /user.
    fs.writeFileSync(
      path.join(site, 'admin/app.mjs'),
      `const base = localStorage.getItem('admin.apiBase');
const remembered = localStorage.getItem('admin.token');
const token = remembered || sessionStorage.getItem('admin.token');
if (base && token) {
  const r = await fetch(base + '/user', { cache: 'no-store', headers: { Authorization: 'Bearer ' + token } });
  const u = await r.json();
  document.body.textContent = (remembered ? 'local:' : 'session:') + u.login;
  document.body.dataset.testid = 'app-ready';
} else {
  document.body.textContent = 'login';
}
`,
    );
    mock = await startMock({ seedDir: null, seedFiles: { 'a.md': 'a\n' }, siteDir: site });
    browser = await playwright.chromium.launch();
  });
  after(async () => {
    await browser?.close();
    await mock?.close();
  });

  test('remember=true stores the token in localStorage and waits for app-ready', async () => {
    const page = await browser.newPage();
    const { blocked } = await openAdmin(page, mock);
    assert.equal(await page.textContent('body'), `local:${OWNER}`);
    assert.equal(await page.evaluate(() => localStorage.getItem('admin.apiBase')), mock.apiBase);
    assert.ok(blocked.some((u) => u.includes('cdn.jsdelivr.net')), 'external request blocked');
    await page.close();
  });

  test('remember=false stores the token in sessionStorage only', async () => {
    const page = await browser.newPage();
    await openAdmin(page, mock, { remember: false });
    assert.equal(await page.textContent('body'), `session:${OWNER}`);
    assert.equal(await page.evaluate(() => localStorage.getItem('admin.token')), null);
    await page.close();
  });

  test('a page that never becomes ready fails with a helpful message', async () => {
    const page = await browser.newPage();
    await assert.rejects(openAdmin(page, mock, { path: '/admin/missing/', timeout: 1500 }), /did not become ready/);
    await page.close();
  });
});
