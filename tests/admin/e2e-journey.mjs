// tests/admin/e2e-journey.mjs — one realistic user journey across ALL admin views on a single mock:
//
//   log in (real login form) → write + publish a shared post with math and an image → add its English
//   version → upload a (real, 3-page) PDF in 资料 (copy its online-preview link) → link AND embed it in both
//   versions of the post with the editor's 资料 button (插入链接 → /viewer/?file=…, 嵌入阅读器 → {{< pdf >}})
//   → change the avatar and the subtitle → switch the background cassette → reorder the menu → save a draft post and delete it
//   from the list → discard a local (browser) draft → export + Hugo build → check the BUILT site (both
//   languages, served by the mock) reflects every change, and every original config comment survived →
//   as a visitor on /posts/<slug>/ and /en/posts/<slug>/: the preview link opens the viewer, which renders the
//   PDF, and the embedded reader renders it too (in the page's language), never touching the admin token.
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
const PDF_VIEWER = `/viewer/?file=%2Fdocuments%2F${PDF_NAME}`; // the online preview (works in WeChat / on Android)
const PDF_EMBED = `{{< pdf "/documents/${PDF_NAME}" >}}`; // the embedded reader (layouts/shortcodes/pdf.html)
const PDF_PAGES = 3;
let PDF_BYTES; // a real PDF made by Chromium (see makePdf), so the built site's viewer can render it
const SUBTITLE = '北京大学 · 物理与天体物理 · 旅程测试';
const DRAFT_SLUG = 'throwaway-draft';
// 课程：一门课 = 一个单元页，批量上传两份实验报告 → 两篇子推文（标题来自文件名，正文是 {{< pdf >}}）
const COURSE = 'modern-physics-lab';
const COURSE_ZH = '近代物理实验';
const COURSE_EN = 'Modern Physics Lab';
const COURSE_GROUP = '实验课';
const REPORTS = [
  { file: '实验1-光电效应.pdf', title: '实验1 光电效应', slug: 'item-1' },
  { file: '实验2 弗兰克-赫兹实验.pdf', title: '实验2 弗兰克 赫兹实验', slug: 'item-2', saved: '实验2-弗兰克-赫兹实验.pdf' },
];
let REPORT_BYTES = [];

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

/** A real 3-page PDF (Chinese text + a coloured bar per page) printed by Chromium. */
async function makePdf(browser) {
  const ctx = await browser.newContext();
  const pg = await ctx.newPage();
  const pages = Array.from({ length: PDF_PAGES }, (_, i) => `<section><h1>广义相对论讲义 · 第 ${i + 1} 页</h1>
    <div style="height:40px;background:hsl(${120 * i} 75% 45%)"></div><p>${'时空弯曲告诉物质如何运动，物质告诉时空如何弯曲。'.repeat(8)}</p></section>`);
  await pg.setContent(`<!doctype html><meta charset="utf-8"><style>section{page-break-after:always;padding:40px}h1{font-size:28px}p{font-size:17px;line-height:1.8}</style>${pages.join('')}`);
  const pdf = await pg.pdf({ format: 'A4', printBackground: true });
  await ctx.close();
  return pdf;
}

/** Pixel stats of page n's canvas in a viewer frame (non-blank + the coloured bar). */
const canvasStats = (frame, n) => frame.evaluate((n) => {
  const c = document.querySelector(`.page[data-page-number="${n}"] canvas`);
  if (!c) return null;
  const s = document.createElement('canvas');
  s.width = 100;
  s.height = 140;
  const g = s.getContext('2d');
  g.drawImage(c, 0, 0, s.width, s.height);
  const d = g.getImageData(0, 0, s.width, s.height).data;
  let dark = 0;
  let colored = 0;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i] + d[i + 1] + d[i + 2] < 384) dark++;
    if (Math.max(d[i], d[i + 1], d[i + 2]) - Math.min(d[i], d[i + 1], d[i + 2]) > 60) colored++;
  }
  return { dark, colored };
}, n);

/** Wait until a viewer (page or iframe) is ready and page 1 is drawn; returns its state. */
async function viewerRendered(frame) {
  await frame.waitForFunction(() => document.documentElement.getAttribute('data-ready') === '1' || document.documentElement.hasAttribute('data-error'), null, { timeout: 30000 });
  assert.equal(await frame.evaluate(() => document.documentElement.getAttribute('data-error')), null, 'the viewer reported an error');
  await frame.waitForFunction(() => { const d = document.querySelector('.page[data-page-number="1"]'); return d && d.classList.contains('rendered') && d.querySelector('canvas'); }, null, { timeout: 30000 });
  const stats = await canvasStats(frame, 1);
  assert.ok(stats.dark > 20 && stats.colored > 100, 'page 1 is drawn (text + coloured bar): ' + JSON.stringify(stats));
  return frame.evaluate(() => ({
    pages: Number(document.documentElement.getAttribute('data-pages')),
    lang: document.documentElement.lang,
    embed: document.documentElement.classList.contains('embed'),
    download: document.getElementById('download').getAttribute('href'),
    downloadText: document.getElementById('download').textContent.trim(),
  }));
}

/** Insert a PDF with the editor's 资料 button: how = 'link' | 'embed'. */
async function insertPdf(page, how) {
  await page.click('[data-testid="editor-body"] .vditor-toolbar [data-type="documents"]');
  await page.waitForSelector(tid('editor-docs-search'));
  await page.fill(tid('editor-docs-search'), 'lecture');
  const item = page.locator(tid('editor-doc-item'), { hasText: PDF_NAME });
  await item.waitFor();
  await item.click();
  await page.click(tid(how === 'embed' ? 'editor-doc-insert-embed' : 'editor-doc-insert-link'));
}

const noHScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

// ---------------------------------------------------------------------------

async function main() {
  const mock = await startMock({ siteDir: SITE_DIR, adminDir: ADMIN_DIR, runDelayMs: 500 });
  console.log(`[e2e-journey] mock at ${mock.url}, output in ${OUT}`);
  const built = await buildSite({ repoDir: REPO_ROOT, outDir: SITE_DIR, baseURL: mock.url + '/' });
  console.log(`  initial site built in ${built.ms} ms\n`);

  const browser = await chromium.launch();
  PDF_BYTES = await makePdf(browser);
  REPORT_BYTES = [PDF_BYTES, await makePdf(browser)];
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
      // the PDF's 「打开」 opens the online viewer; 「复制文件链接」 still gives the file itself
      assert.equal(await page.getAttribute(`${tid('files-row')}[data-path="static/documents/${PDF_NAME}"] ${tid('files-open')}`, 'href'), mock.url + PDF_VIEWER);
      assert.ok(await page.isVisible(`${tid('files-row')}[data-path="static/documents/${PDF_NAME}"] ${tid('files-copy-preview')}`));
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
      await insertPdf(page, 'link');
      await until(async () => (await vditor.get(page)).includes(`(${PDF_VIEWER})`), { msg: 'PDF link inserted' });
      // …and embed the reader below it (its own paragraph)
      await insertPdf(page, 'embed');
      await until(async () => (await vditor.get(page)).includes(PDF_EMBED), { msg: 'PDF reader embedded' });
      const commit = await clickAndCommit(page, mock, tid('editor-publish'));
      // with two variants the editor names the one it updated
      assert.equal(commit.message, `admin: 更新《${TITLE_ZH}》（共用版本）`);
      assert.deepEqual(commit.changes.map((c) => c.path), [POST], 'the PDF is already in the repo → only the post');
      const { body } = splitMd(mock.readFile(POST));
      assert.ok(body.includes(`[${PDF_NAME}](${PDF_VIEWER})`), body);
      assert.ok(body.includes(`\n\n${PDF_EMBED}\n`), 'the embed is its own paragraph:\n' + body);
      assert.match(body, /讲义下载/);
      assert.match(body, new RegExp(`/images/posts/${SLUG}/`), 'image link kept');
      assert.match(body, /\$\$\nds\^2/, 'math kept');
    });

    // -----------------------------------------------------------------------
    await step('English version: link + embed the PDF too → 更新 (viewer link carries lang=en)', async () => {
      await page.click(tid('editor-tab-en'));
      await page.waitForSelector(`${tid('editor-tab-en')}.active`);
      await until(async () => (await vditor.get(page)).includes('tie geometry to matter'), { msg: 'the English body is shown' });
      await vditor.caretToEnd(page);
      await page.keyboard.type(' Lecture notes:', { delay: 5 });
      await insertPdf(page, 'link');
      await until(async () => (await vditor.get(page)).includes(`(${PDF_VIEWER}&lang=en)`), { msg: 'English PDF link inserted' });
      await insertPdf(page, 'embed');
      await until(async () => (await vditor.get(page)).includes(PDF_EMBED), { msg: 'PDF reader embedded (en)' });
      const commit = await clickAndCommit(page, mock, tid('editor-publish'));
      assert.match(commit.message, /^admin: 更新《/);
      assert.deepEqual(commit.changes.map((c) => c.path), [POST_EN], 'only the English file');
      const { body } = splitMd(mock.readFile(POST_EN));
      assert.ok(body.includes(`(${PDF_VIEWER}&lang=en)`), body);
      assert.ok(body.includes(`\n\n${PDF_EMBED}\n`), body);
      assert.ok(!splitMd(mock.readFile(POST)).body.includes('Lecture notes'), 'the shared version is untouched');
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
    await step('课程: create 近代物理实验 (group 实验课, + English) → batch upload 2 reports → 2 sub-posts in ONE commit', async () => {
      await nav(page, 'courses');
      await page.waitForSelector('body[data-courses-ready="list"]', { state: 'attached' });
      await page.click(tid('courses-new'));
      await page.fill(tid('new-course-name-zh'), COURSE_ZH);
      await page.fill(tid('new-course-name-en'), COURSE_EN);
      assert.equal(await page.inputValue(tid('new-course-slug')), COURSE);
      await page.fill(tid('new-course-group'), COURSE_GROUP);
      await page.fill(tid('new-course-desc'), '大三上学期 · 每个实验一篇报告');
      await page.fill(tid('new-course-desc-en'), 'One report per experiment');
      const c1 = await clickAndCommit(page, mock, tid('new-course-ok'));
      assert.deepEqual(c1.changes.map((x) => x.path).sort(), [`content/courses/${COURSE}/_index.en.md`, `content/courses/${COURSE}/_index.md`]);
      // exactly the front matter the site layouts read: title / description / group / weight, no menu
      assert.equal(mock.readFile(`content/courses/${COURSE}/_index.md`),
        `---\ntitle: "${COURSE_ZH}"\ndescription: "大三上学期 · 每个实验一篇报告"\ngroup: "${COURSE_GROUP}"\nweight: 10\n---\n`);
      assert.equal(mock.readFile(`content/courses/${COURSE}/_index.en.md`),
        `---\ntitle: "${COURSE_EN}"\ndescription: "One report per experiment"\ngroup: "${COURSE_GROUP}"\nweight: 10\n---\n`);
      await page.waitForSelector('body[data-courses-ready="detail"]', { state: 'attached' });
      assert.equal(await page.evaluate(() => location.hash), `#/courses?course=${COURSE}`);

      // batch upload: both reports become sub-posts (default), titles from the file names
      await page.setInputFiles(tid('course-files-input'), REPORTS.map((r, i) => ({ name: r.file, mimeType: 'application/pdf', buffer: REPORT_BYTES[i] })));
      await page.waitForSelector(tid('course-batch'));
      const rows = await page.$$eval(tid('batch-row'), (els) => els.map((e) => [e.dataset.mode, e.querySelector('[data-testid="batch-title"]').value]));
      assert.deepEqual(rows, REPORTS.map((r) => ['item', r.title]));
      assert.match(await page.textContent(tid('batch-summary')), /将上传 2 个文件.*生成 2 篇子推文/);
      const c2 = await clickAndCommit(page, mock, tid('batch-submit'));
      const MAT = `static/documents/courses/${COURSE}`;
      assert.deepEqual(c2.changes.map((x) => x.path).sort(), [
        ...REPORTS.map((r) => `content/courses/${COURSE}/${r.slug}.md`),
        ...REPORTS.map((r) => `${MAT}/${r.saved || r.file}`),
      ].sort());
      REPORTS.forEach((r, i) => {
        assert.equal(Buffer.compare(mock.readBytes(`${MAT}/${r.saved || r.file}`), REPORT_BYTES[i]), 0, `${r.file} byte-exact`);
        assert.equal(mock.readFile(`content/courses/${COURSE}/${r.slug}.md`),
          `---\ntitle: "${r.title}"\nweight: ${(i + 1) * 10}\ndraft: false\n---\n\n{{< pdf "/documents/courses/${COURSE}/${r.saved || r.file}" >}}\n`);
      });
      await page.waitForSelector('body[data-courses-ready="detail"]', { state: 'attached' });
      await until(async () => (await page.$$(tid('item-row'))).length === 2, { msg: 'two sub-posts listed' });
      assert.deepEqual(await page.$$eval(`${tid('item-row')} ${tid('item-title')}`, (els) => els.map((e) => e.textContent)), REPORTS.map((r) => r.title));
      assert.deepEqual(await page.$$eval(tid('material-name'), (els) => els.map((e) => e.textContent)), REPORTS.map((r) => r.saved || r.file).sort());
      await until(async () => (await page.$$(tid('material-used'))).length === 2, { msg: '「用在」 links' });
    });

    // -----------------------------------------------------------------------
    await step('every view fits a phone (390x844 and 360x740) without horizontal scroll; screenshots', async () => {
      const views = [['#/posts', 'posts'], ['#/edit?path=' + encodeURIComponent(POST), 'edit'], ['#/pages', 'pages'],
        ['#/courses', 'courses'], [`#/courses?course=${COURSE}`, 'courses'],
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
          if (route === 'courses') await mp.waitForSelector(`body[data-courses-ready="${hash.includes('?') ? 'detail' : 'list'}"]`, { state: 'attached' });
          await sleep(400);
          assert.ok(await noHScroll(mp), `no horizontal scroll on ${hash} at ${w}px`);
          // nothing sticks out of the viewport on the right (clipped buttons etc.)
          const wide = await mp.evaluate(() => [...document.querySelectorAll('.view button, .view a.btn, .view input, .view select, .view textarea, .view h1')]
            .filter((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.right > window.innerWidth + 1 && !el.closest('.tabs, .vditor-toolbar, .ed-tabs, [data-scroll-x]'); })
            .map((el) => `${el.tagName}.${el.className} "${(el.textContent || el.value || '').trim().slice(0, 20)}"`));
          assert.deepEqual(wide, [], `elements past the right edge on ${hash} at ${w}px`);
          await mp.screenshot({ path: path.join(SHOTS, `${label}-${route}${hash.includes('course=') ? '-detail' : ''}.png`) });
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
      assert.ok(zhHtml.includes(PDF_VIEWER), 'zh post links the PDF’s online preview');
      assert.ok(enHtml.includes(`${PDF_VIEWER}&amp;lang=en`), 'en post links the English online preview');
      for (const [html, lang] of [[zhHtml, 'zh'], [enHtml, 'en']]) {
        // the shortcode became an <iframe> to the viewer in embed mode, in the page's language
        const m = /<iframe class="?pdf-embed-frame"? src="?([^" >]+)/.exec(html);
        assert.ok(m, `${lang} post has the embedded reader`);
        assert.equal(m[1].replace(/&amp;/g, '&'), `/viewer/?file=%2Fdocuments%2F${PDF_NAME}&lang=${lang}&embed=1`);
      }
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
      // …and the online viewer the post links to is part of the site
      if (fs.existsSync(path.join(REPO_ROOT, 'static', 'viewer', 'index.html'))) {
        assert.equal((await fetchSite(mock, PDF_VIEWER)).status, 200, 'viewer page served');
      }

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
    await step('visitor: 课程资料 landing → 实验课 → 近代物理实验 (2 sub-posts + 资料) → sub-post viewer renders, prev/next in the course; en labels', async () => {
      const externalBefore = external.length;
      const vp = await context.newPage();
      vp.on('pageerror', (e) => pageErrors.push(`course visitor: ${e.message}`));
      vp.on('console', (m) => { if (/CSP-VIOLATION|Content Security Policy/.test(m.text())) cspErrors.push(m.text()); });
      const LANDING_TEXT = { zh: '资料使用说明', en: 'How to Use' };
      const L = {
        zh: { contents: '内容', materials: '资料', used: '收录于', prev: '« 上一篇', next: '下一篇 »', crumbs: ['课程资料', COURSE_ZH], title: COURSE_ZH },
        en: { contents: 'Contents', materials: 'Materials', used: 'Used in', prev: '« Previous', next: 'Next »', crumbs: ['Course Materials', COURSE_EN], title: COURSE_EN },
      };
      for (const [prefix, lang] of [['', 'zh'], ['/en', 'en']]) {
        const l = L[lang];
        // 1. landing: the user's intro text first, then the card under its group heading
        await vp.goto(`${mock.url}${prefix}/courses/`, { waitUntil: 'domcontentloaded' });
        const landing = await vp.evaluate(() => ({
          intro: document.querySelector('.post-content') ? document.querySelector('.post-content').textContent : '',
          groups: [...document.querySelectorAll('.course-group')].map((g) => [g.querySelector('.course-group-title').textContent.trim(),
            [...g.querySelectorAll('.course-card-title a')].map((a) => [a.textContent.trim(), a.getAttribute('href')])]),
          introBeforeCards: !!document.querySelector('.post-content') && !!document.querySelector('.course-index') &&
            !!(document.querySelector('.post-content').compareDocumentPosition(document.querySelector('.course-index')) & Node.DOCUMENT_POSITION_FOLLOWING),
        }));
        assert.ok(landing.intro.includes(LANDING_TEXT[lang]), `${lang}: the existing landing text is kept`);
        assert.ok(landing.introBeforeCards, `${lang}: intro above the cards`);
        assert.deepEqual(landing.groups, [[COURSE_GROUP, [[l.title, `${prefix}/courses/${COURSE}/`]]]], `${lang}: the course sits under the 实验课 heading`);
        // 2. click the card → the unit page
        await Promise.all([vp.waitForURL(new RegExp(`${prefix}/courses/${COURSE}/$`)), vp.click('.course-card-title a')]);
        const unit = await vp.evaluate(() => ({
          crumbs: [...document.querySelectorAll('.course-breadcrumbs a, .course-breadcrumbs [aria-current]')].map((a) => a.textContent.trim()),
          sections: [...document.querySelectorAll('.course-section-title')].map((x) => x.textContent.trim()),
          posts: [...document.querySelectorAll('.course-post-title a')].map((a) => [a.textContent.trim(), a.getAttribute('href')]),
          materials: [...document.querySelectorAll('.course-material')].map((m) => ({
            name: m.querySelector('.course-material-name').textContent.trim(),
            href: m.querySelector('.course-material-name').getAttribute('href'),
            used: m.querySelector('.course-material-post') ? m.querySelector('.course-material-post').textContent.replace(/\s+/g, ' ').trim() : '',
          })),
          dates: document.querySelectorAll('main time, main .post-meta').length,
        }));
        assert.deepEqual(unit.crumbs, l.crumbs);
        assert.deepEqual(unit.sections, [l.contents, l.materials]);
        assert.deepEqual(unit.posts, REPORTS.map((r) => [r.title, `${prefix}/courses/${COURSE}/${r.slug}/`]));
        const sorted = [...REPORTS].sort((a, b) => ((a.saved || a.file) < (b.saved || b.file) ? -1 : 1));
        assert.deepEqual(unit.materials, sorted.map((r) => ({
          name: r.saved || r.file,
          href: `/viewer/?file=${encodeURIComponent(`/documents/courses/${COURSE}/${r.saved || r.file}`)}${lang === 'en' ? '&lang=en' : ''}`,
          used: `${l.used} ${r.title}`,
        })));
        assert.equal(unit.dates, 0, 'no dates in courses');
        // the materials list links work (viewer page + the file itself)
        for (const m of unit.materials) assert.equal((await fetchSite(mock, m.href)).status, 200, m.href);
        // 3. first sub-post: breadcrumbs, the embedded viewer renders the PDF, prev/next stay in the course
        await Promise.all([vp.waitForURL(new RegExp(`/courses/${COURSE}/${REPORTS[0].slug}/$`)), vp.click('.course-post-title a >> nth=0')]);
        const crumbs = await vp.$$eval('.course-breadcrumbs a, .course-breadcrumbs [aria-current]', (as) => as.map((a) => a.textContent.trim()));
        assert.deepEqual(crumbs, [...l.crumbs, REPORTS[0].title]);
        const handle = await vp.waitForSelector('figure.pdf-embed iframe');
        await handle.scrollIntoViewIfNeeded();
        const frame = await handle.contentFrame();
        const emb = await viewerRendered(frame);
        assert.equal(emb.pages, PDF_PAGES);
        assert.equal(emb.lang, lang === 'en' ? 'en' : 'zh-CN');
        assert.equal(emb.download, `/documents/courses/${COURSE}/${encodeURIComponent(REPORTS[0].file)}`);
        const pager = () => vp.$$eval('.course-paginav a', (as) => as.map((a) => [a.className, a.querySelector('.title').textContent.trim(), a.querySelector('span:last-child').textContent.trim(), new URL(a.href).pathname]));
        assert.deepEqual(await pager(), [['next', l.next, REPORTS[1].title, `${prefix}/courses/${COURSE}/${REPORTS[1].slug}/`]]);
        assert.equal(await vp.$$eval('main time, main .post-meta', (x) => x.length), 0, 'no date on the sub-post');
        await vp.screenshot({ path: path.join(SHOTS, `visitor-${lang}-course-item.png`) });
        await Promise.all([vp.waitForURL(new RegExp(`/courses/${COURSE}/${REPORTS[1].slug}/$`)), vp.click('.course-paginav a.next')]);
        assert.deepEqual(await pager(), [['prev', l.prev, REPORTS[0].title, `${prefix}/courses/${COURSE}/${REPORTS[0].slug}/`]]);
        await vp.waitForSelector('figure.pdf-embed iframe');
      }
      // the blog post is not touched by the course pager
      await vp.goto(`${mock.url}/posts/${SLUG}/`, { waitUntil: 'domcontentloaded' });
      assert.equal(await vp.$$eval('.course-paginav, .course-breadcrumbs', (x) => x.length), 0);
      await vp.close();
      // site pages load KaTeX from the CDN (math is on site-wide; blocked in this test) — nothing else may leave the site
      const added = external.splice(externalBefore);
      assert.deepEqual(added.filter((u) => !u.startsWith('https://cdn.jsdelivr.net/npm/katex@')), [], 'unexpected external requests');
    });

    // -----------------------------------------------------------------------
    await step('visitor (zh + en): the preview link opens a viewer that renders the PDF; the embedded reader renders it', async () => {
      const externalBefore = external.length;
      const viewerExternal = [];
      for (const [prefix, lang] of [['', 'zh'], ['/en', 'en']]) {
        // same browser profile as the admin (the token is remembered in localStorage on this origin)
        const vp = await context.newPage();
        vp.on('pageerror', (e) => pageErrors.push(`${lang} visitor: ${e.message}`));
        vp.on('console', (m) => { if (/CSP-VIOLATION|Content Security Policy/.test(m.text())) cspErrors.push(m.text()); });
        vp.on('request', (req) => {
          if (req.url().includes(mock.token)) tokenLeaks.push(`visitor url: ${req.url()}`);
          let fromViewer = false;
          try { fromViewer = new URL(req.frame().url()).pathname.startsWith('/viewer/'); } catch { /* detached frame */ }
          if (fromViewer && !req.url().startsWith(mock.url + '/')) viewerExternal.push(req.url());
          if (req.headers().authorization) tokenLeaks.push(`visitor auth header: ${req.url()}`);
        });
        await vp.addInitScript(() => {
          // record every storage key the site's scripts touch (the viewer may only read pref-theme)
          window.__storage = [];
          const P = Storage.prototype;
          for (const fn of ['getItem', 'setItem', 'removeItem', 'key', 'clear']) {
            const orig = P[fn];
            P[fn] = function (...a) { if (location.pathname.startsWith('/viewer/')) window.__storage.push(`${fn}:${a[0]}`); return orig.apply(this, a); };
          }
        });
        await vp.goto(`${mock.url}${prefix}/posts/${SLUG}/`, { waitUntil: 'domcontentloaded' });
        assert.equal(await vp.evaluate(() => localStorage.getItem('admin.token')), mock.token, 'precondition: token remembered on this origin');

        // 1. the embedded reader
        const handle = await vp.waitForSelector('figure.pdf-embed iframe');
        await handle.scrollIntoViewIfNeeded();
        const frame = await handle.contentFrame();
        const emb = await viewerRendered(frame);
        assert.equal(emb.pages, PDF_PAGES);
        assert.equal(emb.embed, true);
        assert.equal(emb.lang, lang === 'en' ? 'en' : 'zh-CN');
        assert.equal(emb.download, `/documents/${PDF_NAME}`);
        assert.equal(emb.downloadText, lang === 'en' ? 'Download' : '下载');
        const caption = await vp.$$eval('figure.pdf-embed figcaption a', (as) => as.map((a) => [a.textContent.trim(), a.getAttribute('href')]));
        assert.deepEqual(caption, [[lang === 'en' ? 'Open in new tab' : '在新页面打开', `/viewer/?file=%2Fdocuments%2F${PDF_NAME}&lang=${lang}`],
          [lang === 'en' ? 'Download' : '下载', `/documents/${PDF_NAME}`]]);
        assert.deepEqual(await frame.evaluate(() => window.__storage), ['getItem:pref-theme'], 'embedded viewer storage access');
        await vp.screenshot({ path: path.join(SHOTS, `visitor-${lang}-embed.png`) });

        // 2. the preview link in the text → the viewer page (same tab), then back to the post
        const link = vp.locator(`.post-content a[href^="/viewer/?file="]:not(figure a)`);
        assert.equal(await link.count(), 1, 'one preview link in the text');
        await link.scrollIntoViewIfNeeded();
        await Promise.all([vp.waitForURL(/\/viewer\/\?file=/), link.click()]);
        const v = await viewerRendered(vp);
        assert.equal(v.pages, PDF_PAGES);
        assert.equal(v.embed, false);
        assert.equal(v.lang, lang === 'en' ? 'en' : 'zh-CN');
        assert.equal(v.download, `/documents/${PDF_NAME}`);
        assert.equal(await vp.title(), PDF_NAME);
        assert.deepEqual(await vp.evaluate(() => window.__storage), ['getItem:pref-theme'], 'viewer storage access');
        await vp.screenshot({ path: path.join(SHOTS, `visitor-${lang}-viewer.png`) });
        await vp.goBack();
        assert.equal(new URL(vp.url()).pathname, `${prefix}/posts/${SLUG}/`, 'back returns to the post');
        await vp.close();
      }
      assert.deepEqual(viewerExternal, [], 'the viewer requested nothing outside the site');
      // the theme's own post page loads KaTeX from the CDN (blocked in this test) — that is not the viewer's doing
      const added = external.splice(externalBefore);
      assert.deepEqual(added.filter((u) => !u.startsWith('https://cdn.jsdelivr.net/npm/katex@')), [], 'unexpected external requests');
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
      // one commit per publish: 2 post + 1 upload + 2 link/embed (zh, en) + 1 profile + 1 background + 1 menu + 1 draft + 1 delete
      // + 1 new course + 1 batch upload
      assert.equal(mock.commits.length, 12, mock.commits.map((c) => c.message).join('\n'));
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
