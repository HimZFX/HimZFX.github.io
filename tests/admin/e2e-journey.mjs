// tests/admin/e2e-journey.mjs — one realistic user journey across ALL admin views on a single mock:
//
//   log in (real login form) → write + publish a shared post with math and an image → add its English
//   version → upload a PDF in 资料 → link it from the post with the editor's 资料 button → change the avatar
//   and the subtitle → switch the background cassette → reorder the menu → save a draft post and delete it
//   from the list → discard a local (browser) draft → export + Hugo build → check the BUILT site (both
//   languages, served by the mock) reflects every change, and every original config comment survived.
//
// After every publish the mock's files are checked. Run from the repo root:
//   node tests/admin/e2e-journey.mjs
// Env:
//   JOURNEY_E2E_DIR  where the Hugo builds + screenshots go (default: $ADMIN_TEST_TMP/admin-e2e-journey or
//                    <os tmp>/admin-e2e-journey)
//   HUGO_BIN         Hugo binary (see mock-github.mjs)
//   DEBUG=1          echo the browser console
//
// Every request that leaves the mock origin is aborted (the network blocks the CDN and github.io anyway).

import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startMock, buildSite, REPO_ROOT } from './mock-github.mjs';

const { chromium } = createRequire(import.meta.url)('playwright');

const OUT = path.resolve(process.env.JOURNEY_E2E_DIR || path.join(process.env.ADMIN_TEST_TMP || os.tmpdir(), 'admin-e2e-journey'));
const SITE_DIR = path.join(OUT, 'site');
const SHOTS = path.join(OUT, 'screenshots');
const ADMIN_DIR = path.join(REPO_ROOT, 'static', 'admin');
fs.mkdirSync(SHOTS, { recursive: true });

const CONFIG = fs.readdirSync(path.join(REPO_ROOT, 'config/_default')).filter((f) => f.endsWith('.toml')).sort()
  .map((f) => `config/_default/${f}`);
const ORIGINAL_CONFIG = Object.fromEntries(CONFIG.map((p) => [p, fs.readFileSync(path.join(REPO_ROOT, p), 'utf8')]));

const SLUG = 'journey-spacetime';
const POST = `content/posts/${SLUG}.md`;
const POST_EN = `content/posts/${SLUG}.en.md`;
const IMGDIR = `static/images/posts/${SLUG}`;
const TITLE_ZH = '穿越时空的旅程';
const TITLE_EN = 'A Journey Through Spacetime';
const PDF_NAME = 'gr-lecture-notes.pdf';
const PDF_BYTES = Buffer.from('%PDF-1.4\n% journey test\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n');
const SUBTITLE = '北京大学 · 物理与天体物理 · 旅程测试';
const DRAFT_SLUG = 'throwaway-draft';

// ---------------------------------------------------------------------------
// tiny runner (steps depend on each other: stop at the first failure)

const results = [];
let stopped = false;
async function step(name, fn) {
  if (stopped) { results.push({ name, ok: false, skipped: true }); console.log(`  - ${name} (skipped)`); return; }
  const t0 = Date.now();
  let timer;
  try {
    await Promise.race([fn(), new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('step timed out after 180 s')), 180000); })]);
    clearTimeout(timer);
    results.push({ name, ok: true });
    console.log(`  ✓ ${name} (${Date.now() - t0} ms)`);
  } catch (err) {
    clearTimeout(timer);
    results.push({ name, ok: false, err });
    stopped = true;
    console.log(`  ✗ ${name}\n      ${String((err && err.stack) || err).split('\n').slice(0, 12).join('\n      ')}`);
  }
}

// ---------------------------------------------------------------------------
// helpers

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tid = (id) => `[data-testid="${id}"]`;

async function until(cond, { timeout = 20000, msg = 'condition' } = {}) {
  const t0 = Date.now();
  for (;;) {
    const v = await cond();
    if (v) return v;
    if (Date.now() - t0 > timeout) throw new Error(`timed out waiting for ${msg}`);
    await sleep(100);
  }
}

/** Click a left-nav item (like a user would) and wait for that view to be mounted. */
async function nav(page, route) {
  await page.click(tid(`nav-${route}`));
  await page.waitForSelector(`body[data-view-ready="${route}"]`, { state: 'attached', timeout: 30000 });
}

/** Change the hash and wait for the view. */
async function go(page, hash, route) {
  await page.evaluate((h) => {
    if (location.hash === h) return; // already there
    delete document.body.dataset.viewReady;
    location.hash = h;
  }, hash);
  await page.waitForSelector(`body[data-view-ready="${route}"]`, { state: 'attached', timeout: 30000 });
}

async function waitEditor(page) {
  await page.waitForSelector('body[data-view-ready="edit"]', { state: 'attached', timeout: 30000 });
  await page.waitForSelector('[data-testid="editor-body"] .vditor-wysiwyg', { timeout: 30000 });
}

const vditor = {
  get: (page) => page.evaluate(() => document.querySelector('[data-testid="editor-body"]')._vditor.getValue()),
  /** caret at the end of the document, then insert markdown */
  insert: (page, md) => page.evaluate((m) => {
    const v = document.querySelector('[data-testid="editor-body"]')._vditor;
    v.focus();
    const el = document.querySelector('[data-testid="editor-body"] .vditor-wysiwyg .vditor-reset');
    const r = document.createRange();
    r.selectNodeContents(el);
    r.collapse(false);
    const s = getSelection();
    s.removeAllRanges();
    s.addRange(r);
    v.insertValue(m);
  }, md),
  /** caret at the end of the last paragraph */
  caretToEnd: (page) => page.evaluate(() => {
    const el = document.querySelector('[data-testid="editor-body"] .vditor-wysiwyg .vditor-reset');
    el.focus();
    const ps = el.querySelectorAll(':scope > p');
    const last = ps[ps.length - 1] || el.lastElementChild || el;
    const r = document.createRange();
    r.selectNodeContents(last);
    r.collapse(false);
    const s = getSelection();
    s.removeAllRanges();
    s.addRange(r);
  }),
};

/** Click a button that publishes and wait for the commit + the overlay to go away. */
async function clickAndCommit(page, mock, selector) {
  const n = mock.commits.length;
  await page.click(selector);
  await until(() => mock.commits.length > n, { msg: `a commit after clicking ${selector}` });
  await page.waitForSelector(tid('overlay'), { state: 'detached', timeout: 30000 });
  assert.equal(mock.commits.length, n + 1, 'exactly one commit per publish');
  return mock.commits[mock.commits.length - 1];
}

/** A real image made by the browser's canvas. */
async function canvasImage(page, { w = 900, h = 600, type = 'image/png', color = '#3370ff', label = 'J' } = {}) {
  const b64 = await page.evaluate(({ w, h, type, color, label }) => {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const g = c.getContext('2d');
    g.fillStyle = color;
    g.fillRect(0, 0, w, h);
    g.fillStyle = '#fff';
    g.font = `${Math.round(h / 3)}px sans-serif`;
    g.fillText(label, w / 3, (h * 2) / 3);
    return c.toDataURL(type, 0.92).split(',')[1];
  }, { w, h, type, color, label });
  return Buffer.from(b64, 'base64');
}

function splitMd(text) {
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
  assert.ok(m, 'file has YAML front matter');
  return { fm: m[1], body: m[2] };
}

const commentLines = (text) => text.split('\n').filter((l) => /^\s*#/.test(l) || /\s#\s/.test(l));

/** Lines of `before` must appear in `after` in the same order. Returns the missing ones. */
function missingInOrder(beforeLines, after) {
  const a = after.split('\n');
  let j = 0;
  const missing = [];
  for (const line of beforeLines) {
    let k = j;
    while (k < a.length && a[k] !== line) k++;
    if (k === a.length) missing.push(line);
    else j = k + 1;
  }
  return missing;
}

function navItems(html) {
  const m = /<ul id=["']?menu["']?[^>]*>([\s\S]*?)<\/ul>/.exec(html);
  assert.ok(m, 'nav menu not found in built page');
  return [...m[1].matchAll(/<a\b[^>]*href=["']?([^"' >]+)["']?[^>]*>([\s\S]*?)<\/a>/g)]
    .map((x) => ({ href: x[1], text: x[2].replace(/<[^>]+>/g, '').trim() }));
}

async function fetchSite(mock, p) {
  const res = await fetch(mock.url + p);
  return { status: res.status, type: res.headers.get('content-type') || '', bytes: Buffer.from(await res.arrayBuffer()) };
}

const noHScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

// ---------------------------------------------------------------------------

async function main() {
  const mock = await startMock({ siteDir: SITE_DIR, adminDir: ADMIN_DIR, runDelayMs: 500 });
  console.log(`[e2e-journey] mock at ${mock.url}, output in ${OUT}`);
  const built = await buildSite({ repoDir: REPO_ROOT, outDir: SITE_DIR, baseURL: mock.url + '/' });
  console.log(`  initial site built in ${built.ms} ms\n`);

  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  context.setDefaultTimeout(20000);
  const origin = new URL(mock.url).origin;
  const external = [];
  await context.route((u) => (u.protocol === 'http:' || u.protocol === 'https:') && u.origin !== origin,
    (r) => { external.push(r.request().url()); return r.abort('blockedbyclient'); });
  await context.addInitScript(() => document.addEventListener('securitypolicyviolation',
    (e) => console.warn('CSP-VIOLATION', e.violatedDirective, e.sourceFile, String(e.sample || '').slice(0, 80))));
  const page = await context.newPage();
  const pageErrors = [];
  const cspErrors = [];
  const tokenLeaks = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  page.on('console', (m) => {
    const t = m.text();
    if (/CSP-VIOLATION|Content Security Policy/.test(t)) cspErrors.push(t);
    if (t.includes(mock.token)) tokenLeaks.push(`console: ${t.slice(0, 120)}`);
    if (process.env.DEBUG) console.log(`      [console.${m.type()}] ${t.slice(0, 300)}`);
  });
  page.on('request', (req) => {
    // the token may only ever travel in the Authorization header to the API base — never in a URL
    if (req.url().includes(mock.token)) tokenLeaks.push(`url: ${req.url()}`);
    const auth = req.headers().authorization;
    if (auth && !req.url().startsWith(mock.apiBase)) tokenLeaks.push(`auth header sent to ${req.url()}`);
  });
  page.on('dialog', (d) => d.accept());

  let imgName;
  let avatarBytes;
  try {
    // -----------------------------------------------------------------------
    await step('log in through the login form', async () => {
      await page.goto(mock.url + '/admin/', { waitUntil: 'domcontentloaded' });
      await page.evaluate((apiBase) => { localStorage.clear(); sessionStorage.clear(); localStorage.setItem('admin.apiBase', apiBase); }, mock.apiBase);
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForSelector('body[data-testid="login-ready"]', { state: 'attached' });
      await page.fill(tid('login-token'), mock.token);
      // 「在此设备上记住」默认不勾选（安全评审）；这位用户在自己的电脑上，主动勾选
      assert.equal(await page.isChecked(tid('login-remember')), false);
      await page.check(tid('login-remember'));
      await page.click(tid('login-submit'));
      await page.waitForSelector('body[data-testid="app-ready"]', { state: 'attached', timeout: 45000 });
      await page.waitForSelector('body[data-view-ready="posts"]', { state: 'attached' });
      assert.equal(await page.evaluate(() => localStorage.getItem('admin.token')), mock.token, 'remembered on this device');
      assert.ok(!(await page.evaluate(() => location.href)).includes(mock.token), 'token not in the URL');
    });

    // -----------------------------------------------------------------------
    await step('write a shared post with math + an image → 发表', async () => {
      await page.click(tid('posts-new'));
      await waitEditor(page);
      await page.fill(tid('editor-title'), TITLE_ZH);
      await page.fill(tid('editor-slug'), SLUG);
      assert.match(await page.textContent('.ed-settings'), new RegExp(`/posts/${SLUG}/`));
      await vditor.insert(page, '## 引言\n\n爱因斯坦场方程 $G_{\\mu\\nu} = 8\\pi G T_{\\mu\\nu}$ 把几何与物质联系起来。\n\n$$\nds^2 = -c^2dt^2 + dx^2 + dy^2 + dz^2\n$$\n\n');
      await vditor.caretToEnd(page);
      await page.keyboard.type('下面是一张示意图：', { delay: 5 });
      const png = await canvasImage(page, { label: 'GR' });
      await page.setInputFiles('[data-testid="editor-body"] .vditor-toolbar [data-type="upload"] input[type="file"]',
        { name: '时空 示意图.png', mimeType: 'image/png', buffer: png });
      await until(async () => /!\[[^\]]*\]\(blob:/.test(await vditor.get(page)), { msg: 'image in the editor' });
      await page.fill(tid('editor-tags'), '广义相对论');
      await page.press(tid('editor-tags'), 'Enter');
      await page.fill(tid('editor-description'), '一次从狭义到广义相对论的旅程');
      await sleep(300);
      await page.screenshot({ path: path.join(SHOTS, '01-editor-new-post.png') });

      const commit = await clickAndCommit(page, mock, tid('editor-publish'));
      assert.equal(commit.message, `admin: 发表《${TITLE_ZH}》`);
      const { fm, body } = splitMd(mock.readFile(POST));
      assert.match(fm, new RegExp(`^title: "${TITLE_ZH}"$`, 'm'));
      assert.match(fm, /^draft: false$/m);
      assert.match(fm, /^date: "\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}"$/m);
      assert.match(fm, /^tags: \["广义相对论"\]$/m);
      assert.match(body, /\$G_\{\\mu\\nu\} = 8\\pi G T_\{\\mu\\nu\}\$/);
      assert.match(body, /\$\$\nds\^2 = -c\^2dt\^2 \+ dx\^2 \+ dy\^2 \+ dz\^2\n\$\$/);
      assert.ok(!/blob:|admin-pending:/.test(body), 'no blob/pending URLs left in the file');
      const imgs = [...body.matchAll(new RegExp(`!\\[[^\\]]*\\]\\(/images/posts/${SLUG}/([^)\\s]+)\\)`, 'g'))];
      assert.equal(imgs.length, 1, 'the image is referenced by its final site path');
      imgName = imgs[0][1];
      assert.match(imgName, /^\d{8}-\d{6}-时空-示意图\.(png|jpg)$/);
      assert.ok(mock.readBytes(`${IMGDIR}/${imgName}`)?.length > 100, 'image committed');
      assert.deepEqual(commit.changes.map((c) => c.path).sort(), [POST, `${IMGDIR}/${imgName}`].sort(), 'post + image in one commit');
      await until(async () => (await page.evaluate(() => location.hash)).includes(encodeURIComponent(POST)), { msg: 'editor reopens the saved file' });
      await waitEditor(page);
      assert.equal(await page.textContent(tid('editor-publish')), '更新');
    });

    // -----------------------------------------------------------------------
    await step('add the English version → 发表 → <slug>.en.md', async () => {
      await page.click(tid('editor-add-en'));
      await page.waitForSelector(`${tid('editor-tab-en')}.active`);
      await page.fill(tid('editor-title'), TITLE_EN);
      // replace the body with an English text (keeps the image + the math)
      await page.evaluate((md) => document.querySelector('[data-testid="editor-body"]')._vditor.setValue(md),
        `## Introduction\n\nEinstein's field equations $G_{\\mu\\nu} = 8\\pi G T_{\\mu\\nu}$ tie geometry to matter.\n\n![diagram](/images/posts/${SLUG}/${imgName})\n`);
      await vditor.caretToEnd(page);
      await page.keyboard.type(' The end.', { delay: 5 });
      await page.fill(tid('editor-description'), 'A trip from special to general relativity');
      const commit = await clickAndCommit(page, mock, tid('editor-publish'));
      assert.match(commit.message, new RegExp(`^admin: 发表《${TITLE_EN}》`));
      assert.deepEqual(commit.changes.map((c) => c.path), [POST_EN]);
      const en = splitMd(mock.readFile(POST_EN));
      assert.match(en.fm, new RegExp(`^title: "${TITLE_EN}"$`, 'm'));
      assert.match(en.fm, /^draft: false$/m);
      assert.match(en.fm, /^description: "A trip from special to general relativity"$/m);
      assert.match(en.body, /tie geometry to matter/);
      // the shared file is untouched
      assert.match(mock.readFile(POST), new RegExp(`title: "${TITLE_ZH}"`));
      assert.match(await page.textContent(tid('editor-explain')), /中文站显示：共用版本 · 英文站显示：英文专属/);
    });

    // -----------------------------------------------------------------------
    await step('posts list shows the post as 中英分开 / 已发表', async () => {
      await nav(page, 'posts');
      const row = `${tid('post-row')}[data-key="content/posts/${SLUG}"]`;
      await page.waitForSelector(row);
      const text = await page.textContent(row);
      assert.ok(text.includes(TITLE_ZH), text);
      assert.match(text, /中英分开/);
      assert.match(text, /已发表/);
      assert.equal(await page.getAttribute(`${row} ${tid('post-edit')}`, 'href'), '#/edit?path=' + encodeURIComponent(POST));
    });

    // -----------------------------------------------------------------------
    await step('资料: upload a PDF', async () => {
      await nav(page, 'files');
      await page.waitForSelector(tid('files-dropzone'));
      const n = mock.commits.length;
      await page.setInputFiles(tid('files-input'), [{ name: PDF_NAME, mimeType: 'application/pdf', buffer: PDF_BYTES }]);
      await page.waitForSelector(`${tid('files-batch')}[data-phase="done"]`, { timeout: 30000 });
      await page.waitForSelector(tid('overlay'), { state: 'detached', timeout: 30000 });
      assert.equal(mock.commits.length, n + 1);
      const c = mock.commits.at(-1);
      assert.equal(c.message, `admin: 上传资料 ${PDF_NAME}`);
      assert.deepEqual(c.changes.map((x) => x.path), [`static/documents/${PDF_NAME}`]);
      assert.ok(Buffer.compare(mock.readBytes(`static/documents/${PDF_NAME}`), PDF_BYTES) === 0, 'PDF byte-exact');
      await page.waitForSelector(`${tid('files-row')}[data-path="static/documents/${PDF_NAME}"]`);
      await page.screenshot({ path: path.join(SHOTS, '02-files.png') });
    });

    // -----------------------------------------------------------------------
    await step('link the PDF from the post with the editor’s 资料 button → 更新', async () => {
      await nav(page, 'posts');
      await page.click(`${tid('post-row')}[data-key="content/posts/${SLUG}"] ${tid('post-edit')}`);
      await waitEditor(page);
      assert.equal(await page.inputValue(tid('editor-title')), TITLE_ZH, 'the zh (shared) version opens');
      await vditor.caretToEnd(page);
      await page.keyboard.type('讲义下载：', { delay: 5 });
      await page.click('[data-testid="editor-body"] .vditor-toolbar [data-type="documents"]');
      await page.waitForSelector(tid('editor-docs-search'));
      await page.fill(tid('editor-docs-search'), 'lecture');
      const item = page.locator(tid('editor-doc-item'), { hasText: PDF_NAME });
      await item.waitFor();
      await item.click();
      await until(async () => (await vditor.get(page)).includes(`(/documents/${PDF_NAME})`), { msg: 'PDF link inserted' });
      const commit = await clickAndCommit(page, mock, tid('editor-publish'));
      // with two variants the editor names the one it updated
      assert.equal(commit.message, `admin: 更新《${TITLE_ZH}》（共用版本）`);
      assert.deepEqual(commit.changes.map((c) => c.path), [POST], 'the PDF is already in the repo → only the post');
      const { body } = splitMd(mock.readFile(POST));
      assert.match(body, new RegExp(`\\[[^\\]]*\\]\\(/documents/${PDF_NAME.replace(/\./g, '\\.')}\\)`));
      assert.match(body, /讲义下载/);
      assert.match(body, new RegExp(`/images/posts/${SLUG}/`), 'image link kept');
      assert.match(body, /\$\$\nds\^2/, 'math kept');
    });

    // -----------------------------------------------------------------------
    await step('首页设置: new avatar + subtitle → 保存并发布', async () => {
      await nav(page, 'profile');
      await page.waitForSelector(tid('profile-save'));
      assert.ok(await page.isDisabled(tid('profile-save')));
      await page.fill(tid('profile-subtitle'), SUBTITLE);
      const png = await canvasImage(page, { w: 700, h: 700, color: '#07c160', label: 'Z' });
      await page.setInputFiles(tid('profile-avatar-file'), { name: 'me.png', mimeType: 'image/png', buffer: png });
      await page.waitForSelector(tid('crop-stage'));
      await sleep(300);
      await page.click(tid('crop-ok'));
      await page.waitForSelector(tid('profile-avatar-pending'), { state: 'visible' });
      assert.ok(await page.isChecked(tid('profile-avatar-favicon')));
      await page.screenshot({ path: path.join(SHOTS, '03-profile.png'), fullPage: true });
      const n = mock.commits.length;
      await page.click(tid('profile-save'));
      await page.waitForSelector(tid('profile-confirm'));
      await page.click(tid('confirm-ok'));
      await until(() => mock.commits.length > n, { msg: 'profile commit' });
      await page.waitForSelector(`${tid('profile-save')}[disabled]`, { timeout: 15000 });
      await page.waitForSelector(tid('overlay'), { state: 'detached' });
      assert.equal(mock.commits.length, n + 1);
      const c = mock.commits.at(-1);
      assert.deepEqual(c.changes.map((x) => x.path).sort(), ['config/_default/params.toml', 'static/avatar.jpg', 'static/favicon.jpg']);
      const params = mock.readFile('config/_default/params.toml');
      assert.ok(params.includes(`subtitle = "${SUBTITLE}"`), 'subtitle written');
      assert.deepEqual(missingInOrder(commentLines(ORIGINAL_CONFIG['config/_default/params.toml']), params), [], 'params.toml comments kept');
      avatarBytes = mock.readBytes('static/avatar.jpg');
      assert.ok(avatarBytes[0] === 0xff && avatarBytes[1] === 0xd8, 'avatar is a JPEG');
      assert.notEqual(Buffer.compare(avatarBytes, fs.readFileSync(path.join(REPO_ROOT, 'static/avatar.jpg'))), 0, 'avatar changed');
    });

    // -----------------------------------------------------------------------
    await step('背景动画: switch to 洛伦兹吸引子 → 保存并发布', async () => {
      await nav(page, 'background');
      await page.waitForSelector(tid('bg-card-lorenz'));
      assert.ok(await page.isDisabled(tid('bg-save')));
      await page.click(tid('bg-card-lorenz'));
      await page.click(tid('bg-use'));
      await page.waitForSelector(tid('bg-in-use'));
      assert.ok(!(await page.isDisabled(tid('bg-save'))));
      await page.screenshot({ path: path.join(SHOTS, '04-background.png') });
      const commit = await clickAndCommit(page, mock, tid('bg-save'));
      assert.match(commit.message, /洛伦兹吸引子/);
      assert.deepEqual(commit.changes.map((x) => x.path), ['config/_default/params.toml']);
      await page.waitForSelector(`${tid('bg-save')}[disabled]`, { timeout: 15000 });
      const params = mock.readFile('config/_default/params.toml');
      assert.match(params, /^\s*effect = "lorenz"/m);
      assert.ok(params.includes(`subtitle = "${SUBTITLE}"`), 'the earlier profile change is still there');
      assert.deepEqual(missingInOrder(commentLines(ORIGINAL_CONFIG['config/_default/params.toml']), params), []);
    });

    // -----------------------------------------------------------------------
    await step('页面: put 博客 first in the menu → 保存菜单顺序', async () => {
      await nav(page, 'pages');
      const w = `${tid('page-row')}[data-key="content/posts/_index"] ${tid('page-weight')}`;
      await page.waitForSelector(w);
      await page.fill(w, '5');
      await page.press(w, 'Tab');
      await page.waitForFunction(() => !document.querySelector('[data-testid="pages-save-order"]')?.disabled);
      const n = mock.commits.length;
      await page.click(tid('pages-save-order'));
      await until(() => mock.commits.length > n, { msg: 'menu order commit' });
      await page.waitForFunction(() => document.querySelector('[data-testid="pages-save-order"]')?.disabled && !document.querySelector('[data-testid="overlay"]'));
      const c = mock.commits.at(-1);
      assert.equal(c.message, 'admin: 调整菜单顺序');
      assert.deepEqual(c.changes.map((x) => x.path).sort(), ['content/posts/_index.en.md', 'content/posts/_index.md']);
      for (const p of ['content/posts/_index.md', 'content/posts/_index.en.md']) assert.match(mock.readFile(p), /^ {4}weight: 5$/m, p);
      assert.match(mock.readFile('content/about.md'), /weight: 10 {4}# 菜单顺序/, 'about.md untouched (comment kept)');
    });

    // -----------------------------------------------------------------------
    await step('save a draft post, then delete it from the list', async () => {
      await nav(page, 'posts');
      await page.click(tid('posts-new'));
      await waitEditor(page);
      await page.fill(tid('editor-title'), '一篇要删掉的草稿');
      await page.fill(tid('editor-slug'), DRAFT_SLUG);
      await vditor.insert(page, '草稿正文。\n');
      const commit = await clickAndCommit(page, mock, tid('editor-save-draft'));
      assert.equal(commit.message, 'admin: 保存草稿《一篇要删掉的草稿》');
      assert.match(mock.readFile(`content/posts/${DRAFT_SLUG}.md`), /^draft: true$/m);
      await waitEditor(page);

      await nav(page, 'posts');
      const row = `${tid('post-row')}[data-key="content/posts/${DRAFT_SLUG}"]`;
      await page.waitForSelector(row);
      assert.match(await page.textContent(row), /草稿/);
      assert.equal(await page.$(`${row} ${tid('post-view')}`), null, 'a draft has no 查看 link');
      await page.click(`${row} ${tid('post-delete')}`);
      await page.waitForSelector(tid('delete-ok'));
      const n = mock.commits.length;
      await page.click(tid('delete-ok'));
      await page.waitForSelector(row, { state: 'detached' });
      await until(() => mock.commits.length > n, { msg: 'delete commit' });
      const c = mock.commits.at(-1);
      assert.equal(c.message, 'admin: 删除《一篇要删掉的草稿》');
      assert.deepEqual(c.changes.map((x) => `${x.status}:${x.path}`), [`removed:content/posts/${DRAFT_SLUG}.md`]);
      assert.equal(mock.readFile(`content/posts/${DRAFT_SLUG}.md`), undefined);
      assert.ok(mock.readFile(POST) && mock.readFile(POST_EN), 'the journey post is untouched');
    });

    // -----------------------------------------------------------------------
    await step('discard a local (browser) draft from the list', async () => {
      await page.click(tid('posts-new'));
      await waitEditor(page);
      await page.fill(tid('editor-title'), '只在本机的草稿');
      await vditor.insert(page, '还没想好要不要发。\n');
      await page.waitForFunction(() => /已自动保存到本机/.test(document.querySelector('[data-testid="editor-autosave-status"]')?.textContent || ''), null, { timeout: 10000 });
      const n = mock.commits.length;
      await page.click(tid('nav-posts'));
      await page.waitForSelector(tid('confirm-ok'));
      await page.click(tid('confirm-ok'));   // leave anyway — the draft stays on this device
      await page.waitForSelector('body[data-view-ready="posts"]', { state: 'attached' });
      const drow = page.locator(tid('draft-row'), { hasText: '只在本机的草稿' });
      await drow.waitFor();
      await drow.locator(tid('draft-discard')).click();
      await page.click(tid('confirm-ok'));
      await drow.waitFor({ state: 'detached' });
      const left = await page.evaluate(async () => (await import('/admin/js/drafts.js')).listDrafts());
      assert.ok(!left.some((d) => d.title === '只在本机的草稿'), JSON.stringify(left));
      assert.equal(mock.commits.length, n, 'local drafts never reach GitHub');
    });

    // -----------------------------------------------------------------------
    await step('every view fits a phone (390x844 and 360x740) without horizontal scroll; screenshots', async () => {
      const views = [['#/posts', 'posts'], ['#/edit?path=' + encodeURIComponent(POST), 'edit'], ['#/pages', 'pages'],
        ['#/profile', 'profile'], ['#/background', 'background'], ['#/files', 'files']];
      for (const [w, hgt, label] of [[1280, 800, 'desktop'], [390, 844, 'mobile'], [360, 740, 'mobile360']]) {
        const mp = await context.newPage();
        mp.on('pageerror', (e) => pageErrors.push(e.message));
        await mp.setViewportSize({ width: w, height: hgt });
        await mp.goto(mock.url + '/admin/#/posts', { waitUntil: 'domcontentloaded' });
        await mp.waitForSelector('body[data-testid="app-ready"]', { state: 'attached', timeout: 45000 });
        for (const [hash, route] of views) {
          await go(mp, hash, route);
          if (route === 'edit') await waitEditor(mp);
          await sleep(400);
          assert.ok(await noHScroll(mp), `no horizontal scroll on ${hash} at ${w}px`);
          // nothing sticks out of the viewport on the right (clipped buttons etc.)
          const wide = await mp.evaluate(() => [...document.querySelectorAll('.view button, .view a.btn, .view input, .view select, .view textarea, .view h1')]
            .filter((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.right > window.innerWidth + 1 && !el.closest('.tabs, .vditor-toolbar, .ed-tabs, [data-scroll-x]'); })
            .map((el) => `${el.tagName}.${el.className} "${(el.textContent || el.value || '').trim().slice(0, 20)}"`));
          assert.deepEqual(wide, [], `elements past the right edge on ${hash} at ${w}px`);
          await mp.screenshot({ path: path.join(SHOTS, `${label}-${route}.png`) });
        }
        await mp.close();
      }
    });

    // -----------------------------------------------------------------------
    await step('Hugo build of the final repo: both languages reflect the whole journey', async () => {
      const exp = path.join(OUT, 'export');
      fs.rmSync(exp, { recursive: true, force: true });
      mock.exportTo(exp);
      // rebuild INTO the directory the mock serves, so everything below is fetched over HTTP like a visitor
      await buildSite({ repoDir: exp, outDir: SITE_DIR, baseURL: mock.url + '/' });

      // the post, in both languages
      const zh = await fetchSite(mock, `/posts/${SLUG}/`);
      const en = await fetchSite(mock, `/en/posts/${SLUG}/`);
      assert.equal(zh.status, 200);
      assert.equal(en.status, 200);
      const zhHtml = zh.bytes.toString('utf8');
      const enHtml = en.bytes.toString('utf8');
      assert.ok(zhHtml.includes(TITLE_ZH), 'zh post has the Chinese title');
      assert.ok(enHtml.includes(TITLE_EN), 'en post has the English title');
      assert.ok(!enHtml.includes(TITLE_ZH), 'en post does not use the shared title');
      assert.ok(zhHtml.includes(`/documents/${PDF_NAME}`), 'zh post links the PDF');
      assert.ok(zhHtml.includes(`/images/posts/${SLUG}/`), 'zh post shows the image');
      assert.ok(zhHtml.includes('G_{\\mu\\nu} = 8\\pi G'), 'math source reaches the page untouched (KaTeX renders it client-side)');
      const img = await fetchSite(mock, `/images/posts/${SLUG}/${encodeURIComponent(imgName)}`);
      assert.equal(img.status, 200, 'image served');
      assert.equal(Buffer.compare(img.bytes, mock.readBytes(`${IMGDIR}/${imgName}`)), 0);
      // the draft that was deleted is not built
      assert.equal((await fetchSite(mock, `/posts/${DRAFT_SLUG}/`)).status, 404);

      // PDF served byte-exact
      const pdf = await fetchSite(mock, `/documents/${PDF_NAME}`);
      assert.equal(pdf.status, 200);
      assert.equal(Buffer.compare(pdf.bytes, PDF_BYTES), 0, 'PDF served byte-exact');

      // avatar + favicon
      const av = await fetchSite(mock, '/avatar.jpg');
      assert.equal(av.status, 200);
      assert.equal(Buffer.compare(av.bytes, avatarBytes), 0, 'the new avatar is served');
      assert.equal(Buffer.compare((await fetchSite(mock, '/favicon.jpg')).bytes, mock.readBytes('static/favicon.jpg')), 0);

      // home pages: subtitle + lorenz background, in both languages
      for (const p of ['/', '/en/']) {
        const home = (await fetchSite(mock, p)).bytes.toString('utf8');
        assert.ok(home.includes(SUBTITLE), `${p} shows the new subtitle`);
        assert.ok(home.includes('avatar.jpg'), `${p} shows the avatar`);
        const m = /<script[^>]+src=["']?([^"' >]*background-lorenz[^"' >]*\.js)["']?[^>]*>/.exec(home);
        assert.ok(m, `${p} loads the background-lorenz script`);
        assert.match(m[0], /data-autoplay=["']?true/);
        assert.ok(!/background-three-body/.test(home), `${p} no longer loads three-body`);
        const js = await fetchSite(mock, new URL(m[1], mock.url + p).pathname);
        assert.equal(js.status, 200, 'background script served');
      }

      // menu order: 博客 first, in both languages
      const zhNav = navItems((await fetchSite(mock, '/')).bytes.toString('utf8')).map((x) => `${x.text} ${x.href.replace(mock.url, '')}`);
      const enNav = navItems((await fetchSite(mock, '/en/')).bytes.toString('utf8')).map((x) => `${x.text} ${x.href.replace(mock.url, '')}`);
      assert.deepEqual(zhNav, ['博客 /posts/', '关于 /about/', '科研 /research/', '课程资料 /courses/']);
      assert.deepEqual(enNav, ['Blog /en/posts/', 'About /en/about/', 'Research /en/research/', 'Course Materials /en/courses/']);

      // the blog lists show the post in the right language
      assert.ok((await fetchSite(mock, '/posts/')).bytes.toString('utf8').includes(TITLE_ZH));
      assert.ok((await fetchSite(mock, '/en/posts/')).bytes.toString('utf8').includes(TITLE_EN));
    });

    // -----------------------------------------------------------------------
    await step('every original comment in config/_default/*.toml is still there, in order', async () => {
      const exp = path.join(OUT, 'export');
      for (const p of CONFIG) {
        const now = mock.readFile(p);
        assert.ok(now, `${p} exists`);
        const lines = commentLines(ORIGINAL_CONFIG[p]);
        assert.deepEqual(missingInOrder(lines, now), [], `${p}: comment lines lost`);
        assert.equal(fs.readFileSync(path.join(exp, p), 'utf8'), now, `${p} exported as committed`);
      }
      // files the journey never touched are byte-identical
      assert.equal(mock.readFile('config/_default/hugo.toml'), ORIGINAL_CONFIG['config/_default/hugo.toml']);
      assert.equal(mock.readFile('config/_default/languages.toml'), ORIGINAL_CONFIG['config/_default/languages.toml']);
    });

    await step('no page errors, no CSP violations, no external requests, token never leaked', async () => {
      assert.deepEqual(pageErrors, []);
      assert.deepEqual(cspErrors, []);
      assert.deepEqual(external, []);
      assert.deepEqual(tokenLeaks, []);
      // one commit per publish: 2 post + 1 upload + 1 link + 1 profile + 1 background + 1 menu + 1 draft + 1 delete
      assert.equal(mock.commits.length, 9, mock.commits.map((c) => c.message).join('\n'));
    });
  } finally {
    await browser.close();
    await mock.close();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed. Screenshots: ${SHOTS}`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
