// tests/admin/e2e-shell.mjs — Playwright end-to-end test for the admin shell
// (login, layout, navigation, router guards, ctx.publish + conflicts + deploy indicator,
//  401 handling, logout, ui.js helpers, mobile layout).
//
// Run from the repo root:   node tests/admin/e2e-shell.mjs
// Env:
//   SHELL_E2E_DIR   where the Hugo build + screenshots go (default: <os tmp>/admin-e2e-shell)
//   SKIP_BUILD=1    reuse an existing build in SHELL_E2E_DIR/site
//   HUGO_BIN        Hugo binary (see mock-github.mjs)
//   ONLY=<substr>   run only tests whose name contains this
//
// The admin JS is served live from static/admin (mock adminDir), so the build only provides the
// public site. Every request to another origin is aborted.

import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startMock, buildSite, openAdmin, REPO_ROOT } from './mock-github.mjs';

const { chromium } = createRequire(import.meta.url)('playwright');

const OUT = path.resolve(process.env.SHELL_E2E_DIR || path.join(os.tmpdir(), 'admin-e2e-shell'));
const SITE_DIR = path.join(OUT, 'site');
const SHOTS = path.join(OUT, 'screenshots');
const ADMIN_DIR = path.join(REPO_ROOT, 'static', 'admin');
const ONLY = process.env.ONLY || '';
fs.mkdirSync(SHOTS, { recursive: true });

// ---------------------------------------------------------------------------
// tiny runner

const results = [];
async function test(name, fn) {
  if (ONLY && !name.includes(ONLY)) return;
  const t0 = Date.now();
  let timer;
  try {
    // a hung test must not hang the whole run
    await Promise.race([fn(), new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('test timed out after 120 s')), 120000); })]);
    clearTimeout(timer);
    results.push({ name, ok: true });
    console.log(`  ✓ ${name} (${Date.now() - t0} ms)`);
  } catch (err) {
    clearTimeout(timer);
    results.push({ name, ok: false, err });
    console.log(`  ✗ ${name}\n      ${String(err && err.stack || err).split('\n').slice(0, 8).join('\n      ')}`);
  }
}

// ---------------------------------------------------------------------------
// helpers

/** Abort every request that leaves the mock origin; collect page errors. */
async function preparePage(page, mock) {
  const origin = new URL(mock.url).origin;
  const state = { blocked: [], pageErrors: [] };
  await page.route((u) => (u.protocol === 'http:' || u.protocol === 'https:') && u.origin !== origin, (r) => {
    state.blocked.push(r.request().url());
    return r.abort('blockedbyclient');
  });
  page.on('pageerror', (e) => state.pageErrors.push(e.message));
  return state;
}

/** Open /admin/ with the mock API base configured but no token. */
async function openLoggedOut(page, mock, { token = null, remember = true } = {}) {
  await page.goto(mock.url + '/admin/', { waitUntil: 'domcontentloaded' });
  await page.evaluate(({ apiBase, token, remember }) => {
    localStorage.clear();
    sessionStorage.clear();
    localStorage.setItem('admin.apiBase', apiBase);
    if (token) (remember ? localStorage : sessionStorage).setItem('admin.token', token);
  }, { apiBase: mock.apiBase, token, remember });
  await page.reload({ waitUntil: 'domcontentloaded' });
}

const storage = (page) => page.evaluate(() => ({
  local: localStorage.getItem('admin.token'),
  session: sessionStorage.getItem('admin.token'),
  apiBase: localStorage.getItem('admin.apiBase'),
}));

const bodyTestId = (page) => page.evaluate(() => document.body.dataset.testid || '');

async function waitViewReady(page, route, timeout = 15000) {
  await page.waitForSelector(`body[data-view-ready="${route}"]`, { state: 'attached', timeout });
}

/**
 * Replace a view module with test code (served same-origin, so CSP allows it).
 * `code` is the module source.
 */
async function fakeView(page, name, code) {
  await page.route(`**/admin/js/views/${name}.js`, (r) => r.fulfill({ status: 200, contentType: 'text/javascript; charset=utf-8', body: code }));
}

const PUBLISH_VIEW = `
import { h } from '../ui.js';
export default async function mount(container, params, ctx) {
  ctx.setTitle('测试视图');
  const out = h('pre', { dataset: { testid: 't-result' } });
  const run = async (changes, extra = {}) => {
    out.textContent = '';
    try { out.textContent = JSON.stringify(await ctx.publish({ message: 'test: shell publish', changes, summary: ['shell-test.txt'], ...extra })); }
    catch (e) { out.textContent = 'error:' + e.message; }
  };
  container.append(
    h('div', { class: 'card stack' },
      h('h1', {}, 'fake view ' + (params.n || '')),
      h('button', { class: 'btn btn-primary', dataset: { testid: 't-publish' }, on: { click: () => run([{ path: 'static/documents/shell-test.txt', content: 'hello ' + Date.now(), baseSha: undefined }]) } }, 'publish'),
      h('button', { class: 'btn', dataset: { testid: 't-conflict' }, on: { click: () => run([{ path: 'static/documents/shell-test.txt', content: 'x', baseSha: '0000000000000000000000000000000000000000' }]) } }, 'conflict'),
      h('button', { class: 'btn', dataset: { testid: 't-publish-view' }, on: { click: () => run([{ path: 'static/documents/shell-view.txt', content: 'view ' + Date.now() }], { viewUrl: ctx.siteUrl + 'posts/shell-view/', viewLabel: '查看文章' }) } }, 'publish+view'),
      h('button', { class: 'btn', dataset: { testid: 't-publish-fixed' }, on: { click: () => run([{ path: 'static/documents/shell-idem.txt', content: 'always the same bytes', baseSha: null }]) } }, 'publish fixed'),
      h('button', { class: 'btn', dataset: { testid: 't-getuser' }, on: { click: () => ctx.client.getUser().then(() => { out.textContent = 'user-ok'; }) } }, 'getUser'),
      h('button', { class: 'btn', dataset: { testid: 't-nav' }, on: { click: () => ctx.navigate('#/pages') } }, 'nav'),
      out,
      h('div', { dataset: { testid: 't-ctx' } }, JSON.stringify({ langs: ctx.langs, defaultLang: ctx.defaultLang, zh: ctx.siteLabel('zh'), en: ctx.langName('en'), fr: ctx.siteLabel('fr'), siteUrl: ctx.siteUrl, user: ctx.user && ctx.user.login, hasRepo: !!(ctx.repo && ctx.repo.list), files: ctx.repo.list('content/').length }))));
  return {
    isDirty: () => !!window.__dirty,
    canLeave: async () => !window.__dirty,
    unmount: () => { window.__unmounted = (window.__unmounted || 0) + 1; },
  };
}
`;

// ---------------------------------------------------------------------------

async function main() {
  // 1. build the public site once (the admin itself is served live from static/admin)
  if (!(process.env.SKIP_BUILD && fs.existsSync(path.join(SITE_DIR, 'index.html')))) {
    console.log(`Building site into ${SITE_DIR} …`);
    const r = await buildSite({ repoDir: REPO_ROOT, outDir: SITE_DIR });
    console.log(`  built in ${r.ms} ms`);
  }

  const mock = await startMock({ siteDir: SITE_DIR, adminDir: ADMIN_DIR, runDelayMs: 1500 });
  const browser = await chromium.launch();
  console.log(`Mock at ${mock.url}\n`);

  const newPage = async (opts = {}) => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 860 }, ...opts });
    context.setDefaultTimeout(20000);
    const page = await context.newPage();
    const st = await preparePage(page, mock);
    return { context, page, st };
  };

  try {
    await test('static: index.html has CSP, robots, referrer meta and no inline scripts', async () => {
      const html = fs.readFileSync(path.join(ADMIN_DIR, 'index.html'), 'utf8');
      assert.match(html, /<meta name="robots" content="noindex, nofollow">/);
      assert.match(html, /<meta name="referrer" content="no-referrer">/);
      const csp = /http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(html);
      assert.ok(csp, 'CSP meta missing');
      assert.equal(csp[1],
        "default-src 'self'; script-src 'self' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self' data:; connect-src 'self' https://api.github.com; frame-src 'self' blob:; worker-src 'self' blob:; object-src 'none'; base-uri 'self'; form-action 'none'");
      const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];
      assert.ok(scripts.length >= 1);
      for (const s of scripts) {
        assert.match(s[1], /\bsrc=/, 'inline <script> found');
        assert.equal(s[2].trim(), '');
      }
      for (const css of ['css/admin.css', 'css/views/editor.css', 'css/views/posts.css', 'css/views/profile.css', 'css/views/background.css', 'css/views/files.css', 'css/views/courses.css']) {
        assert.ok(html.includes(`href="${css}"`), `missing stylesheet ${css}`);
      }
    });

    await test('static: no innerHTML/outerHTML/insertAdjacentHTML/document.write in shell JS (except svgIcon template)', async () => {
      for (const f of ['js/main.js', 'js/router.js', 'js/config.js', 'js/views/login.js', 'js/ui.js']) {
        const src = fs.readFileSync(path.join(ADMIN_DIR, f), 'utf8').replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
        const hits = src.match(/\.(innerHTML|outerHTML|insertAdjacentHTML)\b|document\.write/g) || [];
        const allowed = f === 'js/ui.js' ? 1 : 0; // tpl.innerHTML in svgIcon (literal icon strings only)
        assert.ok(hits.length <= allowed, `${f}: ${hits.join(', ')}`);
      }
    });

    await test('login page appears without token', async () => {
      const { context, page, st } = await newPage();
      await openLoggedOut(page, mock);
      await page.waitForSelector('body[data-testid="login-ready"]', { state: 'attached' });
      assert.equal(await page.evaluate(() => location.hash), '#/login');
      assert.ok(await page.isVisible('[data-testid="login-token"]'));
      assert.ok(await page.isVisible('[data-testid="login-submit"]'));
      // 安全评审后改为默认不勾选：记住的令牌在 localStorage 里，整个 himzfx.github.io（含加载第三方脚本的博客页面）共用
      assert.equal(await page.isChecked('[data-testid="login-remember"]'), false, 'remember should default to unchecked');
      assert.equal(await page.getAttribute('[data-testid="login-token"]', 'type'), 'password');
      const text = await page.textContent('body');
      assert.ok(text.includes('令牌只保存在这个浏览器里，只会发送给 GitHub'));
      assert.ok(text.includes('Read and write'));
      const link = await page.getAttribute('a[href="https://github.com/settings/personal-access-tokens/new"]', 'rel');
      assert.match(link, /noopener/);
      assert.equal(await page.isVisible('.sidenav'), false, 'nav must not show on the login page');
      await page.screenshot({ path: path.join(SHOTS, 'login-desktop.png'), fullPage: true });
      assert.deepEqual(st.pageErrors, []);
      await context.close();
    });

    await test('empty and wrong token → inline error, nothing stored', async () => {
      const { context, page, st } = await newPage();
      await openLoggedOut(page, mock);
      await page.waitForSelector('[data-testid="login-submit"]');
      await page.click('[data-testid="login-submit"]');
      await page.waitForSelector('[data-testid="login-error"]:visible');
      assert.match(await page.textContent('[data-testid="login-error"]'), /请先粘贴令牌/);
      await page.fill('[data-testid="login-token"]', 'definitely-wrong');
      await page.press('[data-testid="login-token"]', 'Enter');
      await page.waitForFunction(() => /令牌不正确/.test(document.querySelector('[data-testid="login-error"]')?.textContent || ''));
      assert.equal(await page.getAttribute('[data-testid="login-token"]', 'aria-invalid'), 'true');
      const s = await storage(page);
      assert.equal(s.local, null);
      assert.equal(s.session, null);
      assert.equal(await bodyTestId(page), 'login-ready');
      // the token never appears in a URL
      assert.ok(!mock.requests.some((r) => r.path.includes('definitely-wrong')));
      assert.deepEqual(st.pageErrors, []);
      await context.close();
    });

    await test('correct token + remember → app-ready, user shown, token in localStorage', async () => {
      const { context, page, st } = await newPage();
      await openLoggedOut(page, mock);
      await page.waitForSelector('[data-testid="login-token"]');
      // 「记住」默认不勾选（记住的令牌在整个网站共用的 localStorage 里），说明文字解释了取舍
      assert.equal(await page.isChecked('[data-testid="login-remember"]'), false, 'remember is off by default');
      assert.match(await page.textContent('[data-testid="login-remember-note"]'), /第三方脚本/);
      await page.check('[data-testid="login-remember"]');
      await page.fill('[data-testid="login-token"]', '  ' + mock.token + '  ');
      await page.click('[data-testid="login-submit"]');
      await page.waitForSelector('body[data-testid="app-ready"]', { state: 'attached', timeout: 30000 });
      assert.equal(await page.evaluate(() => location.hash), '#/posts');
      assert.equal((await page.textContent('[data-testid="user-login"]')).trim(), mock.owner);
      assert.ok(await page.$('[data-testid="user-avatar"]'), 'avatar image');
      const s = await storage(page);
      assert.equal(s.local, mock.token, 'token trimmed and stored in localStorage');
      assert.equal(s.session, null);
      assert.ok(await page.isVisible('[data-testid="nav-posts"]'));
      assert.equal(await page.getAttribute('[data-testid="nav-posts"]', 'aria-current'), 'page');
      assert.match(await page.title(), /主页管理/);
      // stays logged in after reload
      await page.reload();
      await page.waitForSelector('body[data-testid="app-ready"]', { state: 'attached' });
      assert.deepEqual(st.pageErrors, []);
      await context.close();
    });

    await test('login without remember → token only in sessionStorage', async () => {
      const { context, page } = await newPage();
      await openLoggedOut(page, mock);
      await page.waitForSelector('[data-testid="login-token"]');
      await page.fill('[data-testid="login-token"]', mock.token);
      await page.uncheck('[data-testid="login-remember"]');
      await page.click('[data-testid="login-submit"]');
      await page.waitForSelector('body[data-testid="app-ready"]', { state: 'attached' });
      const s = await storage(page);
      assert.equal(s.local, null);
      assert.equal(s.session, mock.token);
      await context.close();
    });

    await test('login returns to the originally requested route', async () => {
      const { context, page } = await newPage();
      await openLoggedOut(page, mock);
      await page.goto(mock.url + '/admin/#/profile');
      await page.waitForSelector('body[data-testid="login-ready"]', { state: 'attached' });
      await page.fill('[data-testid="login-token"]', mock.token);
      await page.click('[data-testid="login-submit"]');
      await waitViewReady(page, 'profile');
      assert.equal(await page.evaluate(() => location.hash), '#/profile');
      await context.close();
    });

    await test('token without push permission → login error', async () => {
      mock.setPermissions({ push: false });
      try {
        const { context, page } = await newPage();
        await openLoggedOut(page, mock);
        await page.fill('[data-testid="login-token"]', mock.token);
        await page.click('[data-testid="login-submit"]');
        await page.waitForFunction(() => /没有写入权限/.test(document.querySelector('[data-testid="login-error"]')?.textContent || ''));
        assert.equal((await storage(page)).local, null);
        await context.close();
      } finally {
        mock.setPermissions({ push: true });
      }
    });

    await test('stored token that became invalid → login with notice, token cleared', async () => {
      const { context, page } = await newPage();
      await openLoggedOut(page, mock, { token: 'stale-token' });
      await page.waitForSelector('body[data-testid="login-ready"]', { state: 'attached' });
      assert.match(await page.textContent('[data-testid="login-notice"]'), /登录已过期/);
      const s = await storage(page);
      assert.equal(s.local, null);
      assert.equal(s.apiBase, mock.apiBase, 'apiBase setting is kept');
      await context.close();
    });

    await test('network failure at boot → friendly error screen with retry (token kept)', async () => {
      const { context, page } = await newPage();
      mock.failNext({ path: '/user' }, { network: true, times: 3 });
      await openLoggedOut(page, mock, { token: mock.token });
      await page.waitForSelector('[data-testid="boot-retry"]', { timeout: 30000 });
      assert.match(await page.textContent('body'), /网络错误/);
      assert.equal((await storage(page)).local, mock.token);
      await page.click('[data-testid="boot-retry"]');
      await page.waitForSelector('body[data-testid="app-ready"]', { state: 'attached', timeout: 30000 });
      await context.close();
    });

    await test('navigating between all routes never crashes (missing views → friendly error)', async () => {
      const { context, page, st } = await newPage();
      await openAdmin(page, mock);
      // navigation order: 文章 · 页面 · 课程 · 首页 · 背景 · 资料
      assert.deepEqual(await page.$$eval('.nav-item', (els) => els.map((a) => a.dataset.route)), ['posts', 'pages', 'courses', 'profile', 'background', 'files']);
      assert.deepEqual(await page.$$eval('.nav-item .nav-label', (els) => els.map((e) => e.textContent)), ['文章', '页面', '课程', '首页设置', '背景动画', '资料']);
      for (const [testid, route] of [['nav-pages', 'pages'], ['nav-courses', 'courses'], ['nav-profile', 'profile'], ['nav-background', 'background'], ['nav-files', 'files'], ['nav-posts', 'posts']]) {
        await page.click(`[data-testid="${testid}"]`);
        await waitViewReady(page, route);
        assert.equal(await page.evaluate(() => location.hash.split('?')[0]), '#/' + route);
        assert.equal(await page.getAttribute(`[data-testid="${testid}"]`, 'aria-current'), 'page');
        const info = await page.evaluate(() => {
          const v = document.querySelector('#main > .view');
          return { exists: !!v, children: v ? v.childElementCount : 0, error: !!document.querySelector('[data-testid="view-error"]'), title: document.querySelector('#page-title')?.textContent };
        });
        assert.ok(info.exists && info.children > 0, `${route}: view is blank`);
        assert.ok(info.title, `${route}: no page title`);
        if (info.error) console.log(`      (${route}: view module not available yet — friendly error shown)`);
      }
      // editor + unknown route
      await page.click('[data-testid="nav-new-post"]');
      await waitViewReady(page, 'edit');
      assert.equal(await page.getAttribute('[data-testid="nav-posts"]', 'aria-current'), 'page');
      await page.evaluate(() => { location.hash = '#/does-not-exist'; });
      await waitViewReady(page, 'posts');
      assert.equal(await page.evaluate(() => location.hash), '#/posts');
      // back button
      await page.goBack();
      await page.waitForFunction(() => location.hash.startsWith('#/edit') || location.hash === '#/does-not-exist');
      await page.waitForFunction(() => document.body.dataset.viewReady === 'edit' || document.body.dataset.viewReady === 'posts');
      // a page opened from a local draft key highlights 页面, a post draft 文章
      for (const [hash, nav] of [['#/edit?draft=' + encodeURIComponent('file:content/about.md'), 'nav-pages'],
        ['#/edit?draft=' + encodeURIComponent('file:content/posts/first-physics-note.md'), 'nav-posts'],
        // a course page / new course sub-post highlights 课程; the 课程资料 landing page itself stays under 页面
        ['#/edit?draft=' + encodeURIComponent('file:content/courses/lab/exp-1.md'), 'nav-courses'],
        ['#/edit?draft=' + encodeURIComponent('file:content/courses/_index.md'), 'nav-pages']]) {
        await page.evaluate((h) => { location.hash = h; }, hash);
        await page.waitForFunction((n) => document.querySelector(`[data-testid="${n}"]`)?.getAttribute('aria-current') === 'page', nav);
      }
      assert.deepEqual(st.pageErrors, []);
      await context.close();
    });

    await test('missing / throwing view module → friendly in-view error with retry', async () => {
      const { context, page, st } = await newPage();
      await page.route('**/admin/js/views/background.js', (r) => r.fulfill({ status: 404, body: 'nope' }));
      await fakeView(page, 'files', 'export default async function mount() { throw new Error("测试：挂载失败"); }');
      await openAdmin(page, mock);
      await page.click('[data-testid="nav-background"]');
      await waitViewReady(page, 'background');
      await page.waitForSelector('[data-testid="view-error"]');
      assert.match(await page.textContent('[data-testid="view-error"]'), /暂时打不开/);
      await page.click('[data-testid="nav-files"]');
      await waitViewReady(page, 'files');
      assert.match(await page.textContent('[data-testid="view-error"]'), /测试：挂载失败/);
      assert.ok(await page.isVisible('[data-testid="view-error"] button'), 'retry button');
      assert.deepEqual(st.pageErrors, []);
      await context.close();
    });

    await test('ctx: langs from languages.toml, labels, user, repo', async () => {
      const { context, page } = await newPage();
      await fakeView(page, 'files', PUBLISH_VIEW);
      await openAdmin(page, mock, { path: '/admin/#/files' });
      await waitViewReady(page, 'files');
      const ctx = JSON.parse(await page.textContent('[data-testid="t-ctx"]'));
      assert.deepEqual(ctx.langs, ['zh', 'en']);
      assert.equal(ctx.defaultLang, 'zh');
      assert.equal(ctx.zh, '中文站');
      assert.equal(ctx.en, '英文');
      assert.equal(ctx.fr, 'fr 站');
      assert.equal(ctx.siteUrl, mock.url + '/');
      assert.equal(ctx.user, mock.owner);
      assert.ok(ctx.hasRepo && ctx.files > 0);
      assert.equal((await page.textContent('#page-title')).trim(), '测试视图');
      await context.close();
    });

    await test('ctx.publish: overlay → commit → toast → deploy indicator running → success', async () => {
      const { context, page, st } = await newPage();
      mock.setApiDelay(150);
      await fakeView(page, 'files', PUBLISH_VIEW);
      await openAdmin(page, mock, { path: '/admin/#/files' });
      await waitViewReady(page, 'files');
      const before = mock.commits.length;
      await page.click('[data-testid="t-publish"]');
      await page.waitForSelector('[data-testid="overlay"]', { timeout: 5000 });
      await page.waitForSelector('[data-testid="overlay"]', { state: 'detached', timeout: 20000 });
      mock.setApiDelay(0);
      await page.waitForFunction(() => document.querySelector('[data-testid="t-result"]').textContent.length > 0);
      const result = JSON.parse(await page.textContent('[data-testid="t-result"]'));
      assert.match(result.commitSha, /^[0-9a-f]{40}$/);
      assert.ok(result.shas['static/documents/shell-test.txt']);
      assert.equal(mock.commits.length, before + 1);
      assert.equal(mock.commits.at(-1).message, 'test: shell publish');
      assert.match(mock.readFile('static/documents/shell-test.txt'), /^hello \d+\n$/);
      assert.ok(await page.isVisible('[data-testid="toast-success"]'));
      const state0 = await page.getAttribute('[data-testid="deploy-indicator"]', 'data-state');
      assert.ok(['pending', 'running', 'success'].includes(state0), state0);
      await page.screenshot({ path: path.join(SHOTS, 'deploy-running.png') });
      await page.waitForSelector('[data-testid="deploy-indicator"][data-state="success"]', { timeout: 30000 });
      // ?v=<commit> so the browser does not show a cached (≤10 min) old page
      assert.equal(await page.getAttribute('[data-testid="deploy-indicator"]', 'href'), mock.url + '/?v=' + result.commitSha.slice(0, 7));
      assert.match(await page.textContent('[data-testid="deploy-indicator"]'), /已上线/);
      assert.match(await page.getAttribute('[data-testid="deploy-indicator"]', 'title'), /刷新/);
      assert.deepEqual(st.pageErrors, []);
      await context.close();
    });

    await test('ctx.publish: deploy failure and unknown (no Actions permission) states', async () => {
      const { context, page } = await newPage();
      await fakeView(page, 'files', PUBLISH_VIEW);
      await openAdmin(page, mock, { path: '/admin/#/files' });
      await waitViewReady(page, 'files');
      mock.setRunConclusion('failure');
      await page.click('[data-testid="t-publish"]');
      await page.waitForSelector('[data-testid="deploy-indicator"][data-state="failure"]', { timeout: 30000 });
      assert.match(await page.getAttribute('[data-testid="deploy-indicator"]', 'href'), /^https:\/\/github\.com\/.+\/actions/);
      mock.setRunConclusion('success');
      mock.setActionsAccess(false);
      await page.click('[data-testid="t-publish"]');
      await page.waitForSelector('[data-testid="deploy-indicator"][data-state="unknown"]', { timeout: 30000 });
      assert.match(await page.textContent('[data-testid="deploy-indicator"]'), /约 1–2 分钟后生效/);
      mock.setActionsAccess(true);
      await context.close();
    });

    await test('ctx.publish: conflict → modal → reload → resolves {conflict: true}', async () => {
      const { context, page } = await newPage();
      await fakeView(page, 'files', PUBLISH_VIEW);
      await openAdmin(page, mock, { path: '/admin/#/files' });
      await waitViewReady(page, 'files');
      const before = mock.commits.length;
      await page.click('[data-testid="t-conflict"]');
      await page.waitForSelector('[data-testid="conflict-reload"]');
      assert.match(await page.textContent('.modal'), /static\/documents\/shell-test\.txt/);
      await page.click('[data-testid="conflict-reload"]');
      await page.waitForSelector('.modal', { state: 'detached' });
      const r = JSON.parse(await page.textContent('[data-testid="t-result"]'));
      assert.equal(r.conflict, true);
      assert.equal(r.reloaded, true);
      assert.equal(mock.commits.length, before, 'nothing committed');
      // cancel path
      await page.click('[data-testid="t-conflict"]');
      await page.click('[data-testid="conflict-cancel"]');
      await page.waitForFunction(() => /"reloaded":false/.test(document.querySelector('[data-testid="t-result"]').textContent));
      await context.close();
    });

    await test('ctx.publish: server error → error toast and rethrow', async () => {
      const { context, page } = await newPage();
      await fakeView(page, 'files', PUBLISH_VIEW);
      await openAdmin(page, mock, { path: '/admin/#/files' });
      await waitViewReady(page, 'files');
      mock.failNext({ method: 'POST', path: '/git/blobs' }, { status: 500, times: 1 }); // POSTs are never retried
      await page.click('[data-testid="t-publish"]');
      await page.waitForFunction(() => document.querySelector('[data-testid="t-result"]').textContent.startsWith('error:'), null, { timeout: 30000 });
      assert.ok(await page.isVisible('[data-testid="toast-error"]'));
      assert.match(await page.textContent('[data-testid="toast-error"]'), /发布失败/);
      assert.equal(await page.$('[data-testid="overlay"]'), null, 'overlay closed');
      await context.close();
    });

    await test('router: canLeave guard keeps the view; beforeunload warns when dirty', async () => {
      const { context, page } = await newPage();
      await fakeView(page, 'files', PUBLISH_VIEW);
      await openAdmin(page, mock, { path: '/admin/#/files' });
      await waitViewReady(page, 'files');
      await page.evaluate(() => { window.__dirty = true; });
      await page.click('[data-testid="nav-posts"]');
      await page.waitForTimeout(300);
      assert.equal(await page.evaluate(() => location.hash), '#/files');
      assert.ok(await page.isVisible('[data-testid="t-publish"]'), 'still on the dirty view');
      assert.equal(await page.getAttribute('[data-testid="nav-files"]', 'aria-current'), 'page');
      // browser back is also guarded
      let dialogType = null;
      page.on('dialog', (d) => { dialogType = d.type(); d.dismiss().catch(() => {}); });
      await page.close({ runBeforeUnload: true });
      await new Promise((r) => setTimeout(r, 500));
      assert.equal(dialogType, 'beforeunload');
      await context.close();
    });

    await test('router: ctx.navigate and unmount', async () => {
      const { context, page } = await newPage();
      await fakeView(page, 'files', PUBLISH_VIEW);
      await openAdmin(page, mock, { path: '/admin/#/files' });
      await waitViewReady(page, 'files');
      await page.click('[data-testid="t-nav"]');
      await waitViewReady(page, 'pages');
      assert.equal(await page.evaluate(() => location.hash), '#/pages');
      assert.equal(await page.evaluate(() => window.__unmounted), 1);
      await page.goBack();
      await waitViewReady(page, 'files');
      await context.close();
    });

    await test('401 from the API during use → back to login, then return after re-login', async () => {
      const { context, page, st } = await newPage();
      await fakeView(page, 'files', PUBLISH_VIEW);
      await openAdmin(page, mock, { path: '/admin/#/files?n=1' });
      await waitViewReady(page, 'files');
      mock.setToken('rotated-token');
      try {
        await page.click('[data-testid="t-getuser"]');
        await page.waitForSelector('body[data-testid="login-ready"]', { state: 'attached', timeout: 15000 });
        assert.match(await page.textContent('[data-testid="login-notice"]'), /登录已失效/);
        const s = await storage(page);
        assert.equal(s.local, null);
        assert.equal(s.session, null);
        assert.equal(await page.evaluate(() => window.__unmounted), 1, 'view was unmounted');
        await page.fill('[data-testid="login-token"]', 'rotated-token');
        await page.click('[data-testid="login-submit"]');
        await waitViewReady(page, 'files');
        assert.equal(await page.evaluate(() => location.hash), '#/files?n=1');
      } finally {
        mock.setToken(mock.token);
      }
      assert.deepEqual(st.pageErrors, []);
      await context.close();
    });

    await test('read-only fine-grained token (GET /repos says push: true, git writes are 403) → login error, nothing stored', async () => {
      mock.setContentsWrite(false);
      try {
        const { context, page } = await newPage();
        await openLoggedOut(page, mock);
        await page.fill('[data-testid="login-token"]', mock.token);
        await page.click('[data-testid="login-submit"]');
        await page.waitForFunction(() => /没有写入权限/.test(document.querySelector('[data-testid="login-error"]')?.textContent || ''), null, { timeout: 15000 });
        assert.match(await page.textContent('[data-testid="login-error"]'), /Repository access/);
        const s = await storage(page);
        assert.equal(s.local, null);
        assert.equal(s.session, null);
        await context.close();
      } finally {
        mock.setContentsWrite(true);
      }
    });

    await test('401 while the view has unsaved changes → re-login dialog over the SAME view; edits kept; publish works after', async () => {
      const { context, page, st } = await newPage();
      await fakeView(page, 'files', PUBLISH_VIEW);
      await openAdmin(page, mock, { path: '/admin/#/files?n=2' });
      await waitViewReady(page, 'files');
      await page.evaluate(() => { window.__dirty = true; });
      const before = mock.commits.length;
      mock.setToken('rotated-token');
      try {
        await page.click('[data-testid="t-publish"]');
        await page.waitForSelector('[data-testid="reauth"]', { timeout: 15000 });
        assert.match(await page.textContent('[data-testid="reauth"]'), /没有丢失/);
        assert.equal(await bodyTestId(page), 'app-ready', 'still in the app, not the login page');
        assert.equal(await page.evaluate(() => window.__unmounted || 0), 0, 'view was NOT unmounted');
        assert.equal(await page.evaluate(() => location.hash), '#/files?n=2');
        await page.waitForFunction(() => document.querySelector('[data-testid="t-result"]').textContent.startsWith('error:'));
        const s0 = await storage(page);
        assert.equal(s0.local, null, 'invalid token removed');
        // Esc does not dismiss it
        await page.keyboard.press('Escape');
        assert.ok(await page.isVisible('[data-testid="reauth"]'));
        // wrong token → inline error
        await page.fill('[data-testid="reauth-token"]', 'still-wrong');
        await page.click('[data-testid="reauth-submit"]');
        await page.waitForSelector('[data-testid="reauth-error"]:visible');
        assert.match(await page.textContent('[data-testid="reauth-error"]'), /令牌不正确/);
        // the new token → dialog closes, same view, token swapped in place
        await page.fill('[data-testid="reauth-token"]', 'rotated-token');
        await page.press('[data-testid="reauth-token"]', 'Enter');
        await page.waitForSelector('[data-testid="reauth"]', { state: 'detached' });
        assert.equal(await page.evaluate(() => window.__unmounted || 0), 0);
        assert.equal((await storage(page)).local, 'rotated-token', 'remembered like before');
        await page.click('[data-testid="t-publish"]');
        await page.waitForFunction(() => /commitSha/.test(document.querySelector('[data-testid="t-result"]').textContent), null, { timeout: 20000 });
        assert.equal(mock.commits.length, before + 1);
      } finally {
        mock.setToken(mock.token);
      }
      assert.deepEqual(st.pageErrors, []);
      await context.close();
    });

    await test('leaving a page (phone Back) closes its open dialog as "cancel"', async () => {
      const { context, page } = await newPage();
      await fakeView(page, 'background', `
import { h, confirmDialog } from '../ui.js';
export default async function mount(container) {
  container.append(h('button', { class: 'btn', dataset: { testid: 't-confirm' }, on: { click: async () => {
    window.__confirm = 'open';
    window.__confirm = await confirmDialog({ title: '删除整篇文章？', okText: '删除', danger: true });
  } } }, 'confirm'));
}`);
      await openAdmin(page, mock, { path: '/admin/#/pages' });
      await waitViewReady(page, 'pages');
      await page.click('[data-testid="nav-background"]');
      await waitViewReady(page, 'background');
      await page.click('[data-testid="t-confirm"]');
      await page.waitForSelector('.modal');
      await page.goBack();
      await waitViewReady(page, 'pages');
      await page.waitForSelector('.modal', { state: 'detached', timeout: 5000 });
      assert.equal(await page.evaluate(() => window.__confirm), false, 'confirm resolved as cancelled');
      assert.equal(await page.evaluate(() => document.getElementById('app').hasAttribute('inert')), false);
      await context.close();
    });

    await test('a dialog opened while the publish overlay is up is drawn ABOVE it (what you see is what you tap)', async () => {
      const { context, page } = await newPage();
      await openAdmin(page, mock, { path: '/admin/#/pages' });
      await waitViewReady(page, 'pages');
      const r = await page.evaluate(async () => {
        const ui = await import('/admin/js/ui.js');
        const ov = ui.showOverlay('正在发布…');
        let answer = 'pending';
        ui.confirmDialog({ title: '还有修改没有发表', okText: '离开' }).then((v) => { answer = v; });
        await new Promise((res) => setTimeout(res, 300));
        const ok = document.querySelector('[data-testid="confirm-ok"]');
        const b = ok.getBoundingClientRect();
        const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
        const zo = Number(getComputedStyle(document.querySelector('[data-testid="overlay"]')).zIndex);
        const zm = Number(getComputedStyle(ok.closest('.modal-backdrop')).zIndex);
        window.__ov = ov;
        window.__answer = () => answer;
        return { hitIsOk: !!hit && (hit === ok || ok.contains(hit)), zo, zm };
      });
      assert.ok(r.zm > r.zo, `dialog z-index ${r.zm} must be above the overlay ${r.zo}`);
      assert.ok(r.hitIsOk, 'the visible 离开 button is the element that receives the tap');
      await page.click('[data-testid="confirm-cancel"]');
      assert.equal(await page.evaluate(() => window.__answer()), false);
      // and the other way round: an overlay opened after a dialog covers the dialog
      const r2 = await page.evaluate(async () => {
        const ui = await import('/admin/js/ui.js');
        window.__ov.close();
        ui.confirmDialog({ title: 'x' });
        await new Promise((res) => setTimeout(res, 100));
        const ov = ui.showOverlay('正在发布…');
        const zo = Number(getComputedStyle(document.querySelector('[data-testid="overlay"]')).zIndex);
        const zm = Number(getComputedStyle(document.querySelector('.modal-backdrop')).zIndex);
        ov.close();
        return { zo, zm };
      });
      assert.ok(r2.zo > r2.zm, `overlay ${r2.zo} above the earlier dialog ${r2.zm}`);
      await context.close();
    });

    await test('logging out in one tab ends the session in the other tabs too', async () => {
      const { context, page } = await newPage();
      await openAdmin(page, mock, { remember: true });
      const page2 = await context.newPage();
      await preparePage(page2, mock);
      await page2.goto(mock.url + '/admin/#/pages');
      await page2.waitForSelector('body[data-testid="app-ready"]', { state: 'attached', timeout: 30000 });
      await page.click('[data-testid="logout"]');
      await page.click('[data-testid="confirm-ok"]');
      await page.waitForSelector('body[data-testid="login-ready"]', { state: 'attached' });
      await page2.waitForSelector('body[data-testid="login-ready"]', { state: 'attached', timeout: 10000 });
      assert.match(await page2.textContent('[data-testid="login-notice"]'), /其他标签页退出登录/);
      const s2 = await storage(page2);
      assert.equal(s2.local, null);
      assert.equal(s2.session, null);
      await context.close();
    });

    await test('admin embedded in an iframe refuses to start (clickjacking) and never uses the token', async () => {
      const { context, page } = await newPage();
      await openAdmin(page, mock, { remember: true });
      await page.goto(mock.url + '/');
      const n = mock.requests.length;
      await page.evaluate((src) => {
        const f = document.createElement('iframe');
        f.src = src; f.width = '800'; f.height = '600'; f.id = 'evil';
        document.body.appendChild(f);
      }, mock.url + '/admin/');
      const frame = await (await page.waitForSelector('#evil')).contentFrame();
      await frame.waitForSelector('body[data-testid="framed"]', { state: 'attached', timeout: 15000 });
      assert.match(await frame.textContent('body'), /请直接打开管理后台/);
      assert.equal(await frame.$('.topbar'), null);
      await page.waitForTimeout(500);
      assert.equal(mock.requests.slice(n).filter((r) => r.path === '/user' || r.path.includes('/repos/')).length, 0, 'no API calls from the framed admin');
      await context.close();
    });

    await test('ctx.publish viewUrl: "已上线 ✓" and the success toast link to the published page', async () => {
      const { context, page } = await newPage();
      await fakeView(page, 'files', PUBLISH_VIEW);
      await openAdmin(page, mock, { path: '/admin/#/files' });
      await waitViewReady(page, 'files');
      await page.click('[data-testid="t-publish-view"]');
      await page.waitForSelector('[data-testid="deploy-indicator"][data-state="success"]', { timeout: 30000 });
      const v = mock.commits.at(-1).sha ? '?v=' + mock.commits.at(-1).sha.slice(0, 7) : null;
      const href = await page.getAttribute('[data-testid="deploy-indicator"]', 'href');
      assert.match(href, /^.*\/posts\/shell-view\/\?v=[0-9a-f]{7}$/);
      assert.ok(href.startsWith(mock.url + '/posts/shell-view/?v='), href);
      if (v) assert.equal(href, mock.url + '/posts/shell-view/' + v);
      await page.waitForSelector('[data-testid="toast-link"]');
      assert.equal(await page.getAttribute('[data-testid="toast-link"]', 'href'), href);
      assert.match(await page.textContent('[data-testid="toast-link"]'), /查看文章/);
      assert.equal(await page.getAttribute('[data-testid="toast-link"]', 'target'), '_blank');
      await context.close();
    });

    await test('ctx.publish: ref update applied but its response lost → "无法确认" warning; publishing again is idempotent', async () => {
      const { context, page } = await newPage();
      await fakeView(page, 'files', PUBLISH_VIEW);
      await openAdmin(page, mock, { path: '/admin/#/files' });
      await waitViewReady(page, 'files');
      const before = mock.commits.length;
      let dropRefReads = false;
      await page.route(/\/git\/refs\/heads\//, async (route) => {
        if (route.request().method() !== 'PATCH') return route.continue();
        await route.fetch();          // applied on the server …
        dropRefReads = true;          // … and then the network goes away
        return route.abort('connectionreset');
      });
      await page.route(/\/git\/ref\/heads\//, (route) => (dropRefReads ? route.abort('internetdisconnected') : route.continue()));
      await page.click('[data-testid="t-publish-fixed"]');
      await page.waitForFunction(() => document.querySelector('[data-testid="t-result"]').textContent.startsWith('error:'), null, { timeout: 40000 });
      assert.equal(mock.commits.length, before + 1, 'the commit did land');
      assert.match(await page.textContent('[data-testid="toast-warning"]'), /无法确认/);
      assert.equal(await page.$('[data-testid="overlay"]'), null);
      dropRefReads = false;
      await page.unroute(/\/git\/refs\/heads\//);
      await page.click('[data-testid="t-publish-fixed"]');
      await page.waitForFunction(() => /commitSha/.test(document.querySelector('[data-testid="t-result"]').textContent), null, { timeout: 20000 });
      const r = JSON.parse(await page.textContent('[data-testid="t-result"]'));
      assert.equal(r.alreadyApplied, true);
      assert.equal(await page.$('[data-testid="conflict-reload"]'), null, 'no false conflict dialog');
      assert.equal(mock.commits.length, before + 1, 'not published twice');
      assert.match(await page.textContent('.toast-stack'), /已经发布成功/);
      await context.close();
    });

    await test('logout clears stored token (after confirm)', async () => {
      const { context, page } = await newPage();
      await openAdmin(page, mock, { remember: true });
      await page.click('[data-testid="logout"]');
      await page.waitForSelector('[data-testid="confirm-cancel"]');
      await page.click('[data-testid="confirm-cancel"]');
      await page.waitForSelector('.modal', { state: 'detached' });
      assert.equal((await storage(page)).local, mock.token, 'cancel keeps the session');
      await page.click('[data-testid="logout"]');
      await page.click('[data-testid="confirm-ok"]');
      await page.waitForSelector('body[data-testid="login-ready"]', { state: 'attached' });
      const s = await storage(page);
      assert.equal(s.local, null);
      assert.equal(s.session, null);
      assert.equal(await page.isVisible('.topbar'), false);
      // reload stays logged out
      await page.reload();
      await page.waitForSelector('body[data-testid="login-ready"]', { state: 'attached' });
      await context.close();
    });

    await test('ui.js: h(), modal focus trap + Esc, prompt validation, toasts stacking, withBusy', async () => {
      const { context, page, st } = await newPage();
      await openAdmin(page, mock);
      const r = await page.evaluate(async () => {
        const ui = await import('/admin/js/ui.js');
        const out = {};
        const el = ui.h('div', { class: ['a', null, 'b'], style: { color: 'red', '--x': '1' }, dataset: { k: 'v' }, title: '<t>', hidden: false, disabled: true },
          '<b>not html</b>', 3, null, false, [ui.h('i', {}, 'x'), ['y']]);
        out.h = { cls: el.className, html: el.innerHTML, k: el.dataset.k, color: el.style.color, x: el.style.getPropertyValue('--x'), title: el.getAttribute('title'), hidden: el.hasAttribute('hidden') };
        try { ui.h('div', { innerHTML: '<b>' }); out.innerHTMLRefused = false; } catch { out.innerHTMLRefused = true; }
        const input = ui.h('input', { value: 'v', checked: true, type: 'checkbox' });
        out.props = { value: input.value, checked: input.checked };
        out.icon = ui.svgIcon('post').tagName.toLowerCase();
        out.fmt = [ui.formatBytes(0), ui.formatBytes(1536), ui.formatBytes(5 * 1024 * 1024), ui.formatDate('2026-10-31'), ui.timeAgo(new Date(Date.now() - 3 * 60000)), ui.timeAgo(new Date())];
        for (let i = 0; i < 6; i++) ui.toast('t' + i, { timeout: 0 });
        out.toasts = document.querySelectorAll('.toast-stack .toast').length;
        document.querySelectorAll('.toast').forEach((t) => t.remove());
        const btn = ui.h('button', {}, 'b');
        document.body.append(btn);
        let release;
        const p = ui.withBusy(btn, () => new Promise((res) => { release = res; }));
        out.busy = [btn.disabled, btn.classList.contains('is-busy')];
        const p2 = ui.withBusy(btn, () => 'second');
        release(42);
        out.busyResult = [await p, await p2];
        out.after = [btn.disabled, btn.classList.contains('is-busy')];
        // fn() setting button.disabled itself (e.g. "nothing left to save") wins over the restore
        await ui.withBusy(btn, () => { btn.disabled = true; out.readInside = btn.disabled; });
        out.keptDisabled = btn.disabled;
        btn.disabled = true;
        await ui.withBusy(btn, () => { btn.disabled = false; });
        out.keptEnabled = btn.disabled === false && !Object.prototype.hasOwnProperty.call(btn, 'disabled');
        btn.remove();
        // the same toast twice in a row shows once
        ui.toast('同一条', { timeout: 0 });
        ui.toast('同一条', { timeout: 0 });
        ui.toast('同一条', { type: 'error', timeout: 0 });
        out.dupToasts = document.querySelectorAll('.toast-stack .toast').length;
        document.querySelectorAll('.toast').forEach((t) => t.remove());
        // loadScript can give the element an id
        const probe = ui.loadScript('/admin/__probe-missing.js', { id: 'probe-script' });
        out.scriptId = document.getElementById('probe-script')?.tagName === 'SCRIPT';
        await probe.catch(() => {});
        return out;
      });
      assert.equal(r.h.cls, 'a b');
      assert.equal(r.h.html, '&lt;b&gt;not html&lt;/b&gt;3<i>x</i>y');
      assert.equal(r.h.k, 'v');
      assert.equal(r.h.color, 'red');
      assert.equal(r.h.x, '1');
      assert.equal(r.h.title, '<t>');
      assert.equal(r.h.hidden, false);
      assert.equal(r.innerHTMLRefused, true);
      assert.deepEqual(r.props, { value: 'v', checked: true });
      assert.equal(r.icon, 'svg');
      assert.deepEqual(r.fmt, ['0 B', '1.5 KB', '5 MB', '2026-10-31', '3 分钟前', '刚刚']);
      assert.equal(r.toasts, 4, 'at most 4 toasts');
      assert.deepEqual(r.busy, [true, true]);
      assert.deepEqual(r.busyResult, [42, 42]);
      assert.deepEqual(r.after, [false, false]);
      assert.equal(r.readInside, true, 'still reads as disabled while busy');
      assert.equal(r.keptDisabled, true, 'disabled set inside fn is kept');
      assert.equal(r.keptEnabled, true, 'enabled set inside fn is kept, no own property left behind');
      assert.equal(r.dupToasts, 2, 'identical toast replaces the previous one (different type stays)');
      assert.equal(r.scriptId, true, 'loadScript({ id })');

      // confirm dialog: focus trapped, Esc → false, OK → true
      await page.evaluate(() => {
        window.__confirm = import('/admin/js/ui.js').then((ui) => ui.confirmDialog({ title: 'T', message: 'M', okText: '好' }));
      });
      await page.waitForSelector('[data-testid="confirm-ok"]');
      await page.waitForFunction(() => document.activeElement?.dataset?.testid === 'confirm-ok');
      for (let i = 0; i < 5; i++) {
        await page.keyboard.press('Tab');
        assert.ok(await page.evaluate(() => !!document.activeElement.closest('.modal')), 'focus escaped the modal');
      }
      assert.equal(await page.evaluate(() => document.getElementById('app').hasAttribute('inert')), true);
      await page.keyboard.press('Escape');
      await page.waitForSelector('.modal', { state: 'detached' });
      assert.equal(await page.evaluate(() => window.__confirm), false);
      assert.equal(await page.evaluate(() => document.getElementById('app').hasAttribute('inert')), false);

      await page.evaluate(() => {
        window.__prompt = import('/admin/js/ui.js').then((ui) => ui.promptDialog({ title: 'P', label: '名字', validate: (v) => (v.trim() ? null : '不能为空') }));
      });
      await page.waitForSelector('[data-testid="prompt-input"]');
      await page.click('[data-testid="prompt-ok"]');
      await page.waitForSelector('.modal .error:visible');
      await page.fill('[data-testid="prompt-input"]', 'abc');
      await page.press('[data-testid="prompt-input"]', 'Enter');
      await page.waitForSelector('.modal', { state: 'detached' });
      assert.equal(await page.evaluate(() => window.__prompt), 'abc');

      // async action: busy while pending, error keeps modal open
      await page.evaluate(() => import('/admin/js/ui.js').then((ui) => {
        window.__m = ui.modal({ title: 'A', content: 'x', actions: [{ text: 'go', kind: 'primary', testid: 'm-go', onClick: async () => { await new Promise((r) => setTimeout(r, 300)); throw new Error('不行'); } }] });
      }));
      await page.click('[data-testid="m-go"]');
      assert.equal(await page.evaluate(() => document.querySelector('[data-testid="m-go"]').classList.contains('is-busy')), true);
      await page.waitForSelector('[data-testid="toast-error"]');
      assert.ok(await page.isVisible('.modal'));
      await page.click('[data-testid="modal-close"]');
      await page.waitForSelector('.modal', { state: 'detached' });
      assert.deepEqual(st.pageErrors, []);
      await context.close();
    });

    await test('desktop screenshots (light + dark)', async () => {
      for (const scheme of ['light', 'dark']) {
        const { context, page } = await newPage({ colorScheme: scheme });
        await fakeView(page, 'files', PUBLISH_VIEW);
        await openAdmin(page, mock);
        await page.waitForTimeout(400);
        await page.screenshot({ path: path.join(SHOTS, `desktop-${scheme}.png`) });
        await page.click('[data-testid="nav-files"]');
        await waitViewReady(page, 'files');
        await page.click('[data-testid="t-publish"]');
        await page.waitForSelector('[data-testid="deploy-indicator"]:not([hidden])');
        await page.screenshot({ path: path.join(SHOTS, `desktop-${scheme}-deploy.png`) });
        await page.evaluate(() => { import('/admin/js/ui.js').then((ui) => ui.confirmDialog({ title: '删除这篇文章？', message: '删除后网站上将不再显示。', danger: true, okText: '删除' })); });
        await page.waitForSelector('.modal');
        await page.waitForTimeout(300);
        await page.screenshot({ path: path.join(SHOTS, `desktop-${scheme}-modal.png`) });
        await context.close();
      }
    });

    await test('mobile layout 390x844: bottom tab bar, no horizontal scroll, screenshots', async () => {
      const { context, page, st } = await newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
      await openLoggedOut(page, mock);
      await page.waitForSelector('body[data-testid="login-ready"]', { state: 'attached' });
      await page.screenshot({ path: path.join(SHOTS, 'login-mobile.png'), fullPage: true });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'login: horizontal scroll');
      await page.fill('[data-testid="login-token"]', mock.token);
      await page.click('[data-testid="login-submit"]');
      await page.waitForSelector('body[data-testid="app-ready"]', { state: 'attached' });
      await page.waitForTimeout(400);
      const nav = await page.evaluate(() => {
        const r = document.querySelector('.sidenav').getBoundingClientRect();
        return { bottom: Math.round(r.bottom), top: Math.round(r.top), width: Math.round(r.width), h: innerHeight, w: innerWidth, items: [...document.querySelectorAll('.nav-item')].map((a) => a.getBoundingClientRect().width > 0) };
      });
      assert.equal(nav.bottom, nav.h, 'tab bar sits at the bottom');
      assert.equal(nav.width, nav.w);
      assert.ok(nav.items.every(Boolean));
      assert.equal(await page.isVisible('[data-testid="logout"]'), true);
      await page.screenshot({ path: path.join(SHOTS, 'mobile-posts.png') });
      for (const route of ['pages', 'courses', 'profile', 'background', 'files']) {
        await page.tap(`[data-testid="nav-${route}"]`);
        await waitViewReady(page, route);
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `${route}: horizontal scroll`);
      }
      // editor route hides the tab bar
      await page.evaluate(() => { location.hash = '#/edit?new=post'; });
      await waitViewReady(page, 'edit');
      assert.equal(await page.isVisible('.sidenav'), false);
      await page.evaluate(() => { location.hash = '#/posts'; });
      await waitViewReady(page, 'posts');
      // 360px: still no horizontal scroll; bottom sheet modal
      await page.setViewportSize({ width: 360, height: 740 });
      await page.waitForTimeout(200);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), '360: horizontal scroll');
      // six tabs still fit at 360 px: every tab ≥ 56 px wide, icon + short label inside its own box, no overlap
      const tabs = await page.evaluate(() => [...document.querySelectorAll('.nav-item')].map((a) => {
        const r = a.getBoundingClientRect();
        const l = a.querySelector('.nav-label-short').getBoundingClientRect();
        const i = a.querySelector('.nav-icon').getBoundingClientRect();
        return { left: r.left, right: r.right, width: r.width, labelIn: l.left >= r.left - 0.5 && l.right <= r.right + 0.5 && l.width > 0, iconIn: i.width > 0 && i.left >= r.left && i.right <= r.right, overflow: a.scrollWidth > a.clientWidth + 1 };
      }));
      assert.equal(tabs.length, 6);
      for (const t of tabs) {
        assert.ok(t.width >= 56, `tab too narrow at 360: ${t.width}`);
        assert.ok(t.labelIn && t.iconIn && !t.overflow, 'tab content fits: ' + JSON.stringify(t));
      }
      for (let i = 1; i < tabs.length; i++) assert.ok(tabs[i].left >= tabs[i - 1].right - 0.5, 'tabs do not overlap');
      assert.ok(tabs.at(-1).right <= 360.5, 'last tab inside the viewport');
      await page.tap('[data-testid="logout"]');
      await page.waitForSelector('[data-testid="confirm-ok"]');
      await page.waitForTimeout(300);
      await page.screenshot({ path: path.join(SHOTS, 'mobile-360-modal.png') });
      await page.tap('[data-testid="confirm-cancel"]');
      assert.deepEqual(st.pageErrors, []);
      await context.close();
    });

    await test('mobile dark + deploy indicator screenshot', async () => {
      const { context, page } = await newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, colorScheme: 'dark' });
      await fakeView(page, 'files', PUBLISH_VIEW);
      await openAdmin(page, mock, { path: '/admin/#/files' });
      await waitViewReady(page, 'files');
      await page.tap('[data-testid="t-publish"]');
      await page.waitForSelector('[data-testid="deploy-indicator"]:not([hidden])');
      await page.screenshot({ path: path.join(SHOTS, 'mobile-dark-deploy.png') });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
      await context.close();
    });
  } finally {
    await browser.close();
    await mock.close();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed. Screenshots: ${SHOTS}`);
  if (failed.length) {
    console.log('Failed:\n' + failed.map((f) => '  - ' + f.name).join('\n'));
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
