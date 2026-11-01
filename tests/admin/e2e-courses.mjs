// tests/admin/e2e-courses.mjs — Playwright end-to-end test for the 「课程」 view (views/courses.js) and the
// course-related bits of the editor / 页面 / 文章 views.
//
// Covers: create a course (中文 + English → _index.md + _index.en.md, exact front matter, slug from the English name,
// free-text group + datalist), batch upload (2 PDFs + 1 PNG, one PDF only into 资料) → ONE commit (PDFs byte-exact,
// PNG compressed to JPEG, 2 sub-posts with the expected front matter / bodies / weights), the 资料 list (sorted by
// name, 「用在」 links, preview links), refused file types (.html / .svg) with the Chinese explanation, reorder
// sub-posts (weights patched surgically, comments preserved), conflict on reorder (reload keeps the new order),
// ＋ 新子推文 via the editor (weight after the max, no menu, no date), editing the course intro keeps group / weight,
// delete a sub-post, change a course's group + rename a group across courses, reorder courses (group order),
// 页面 / 文章 not polluted, phone 390×844 + 360 without horizontal scroll, and finally a Hugo build of the exported
// repo: /courses/<course>/ lists the sub-posts in order + the materials, and both /courses/<course>/<item>/ and
// /en/courses/<course>/<item>/ embed the viewer.
//
// Run from the repo root:   node tests/admin/e2e-courses.mjs
// Env:
//   COURSES_E2E_DIR   where the Hugo builds + screenshots go (default: $ADMIN_TEST_TMP/e2e-courses or <os tmp>/admin-e2e-courses)
//   HUGO_BIN          Hugo binary (see mock-github.mjs)
//   ONLY=<substr>     run only tests whose name contains this (tests share state; use for debugging only)

import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { startMock, buildSite, openAdmin, REPO_ROOT } from './mock-github.mjs';

const { chromium } = createRequire(import.meta.url)('playwright');

const OUT = path.resolve(process.env.COURSES_E2E_DIR
  || (process.env.ADMIN_TEST_TMP ? path.join(process.env.ADMIN_TEST_TMP, 'e2e-courses') : path.join(os.tmpdir(), 'admin-e2e-courses')));
const SITE_DIR = path.join(OUT, 'site');
const EXPORT_DIR = path.join(OUT, 'export');
const BUILD2_DIR = path.join(OUT, 'site-after');
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
    await Promise.race([fn(), new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('test timed out after 120 s')), 120000); })]);
    clearTimeout(timer);
    results.push({ name, ok: true });
    console.log(`  ✓ ${name} (${Date.now() - t0} ms)`);
  } catch (err) {
    clearTimeout(timer);
    results.push({ name, ok: false, err });
    console.log(`  ✗ ${name}\n      ${String((err && err.stack) || err).split('\n').slice(0, 10).join('\n      ')}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(cond, { timeout = 20000, msg = 'condition' } = {}) {
  const t0 = Date.now();
  for (;;) {
    const v = await cond();
    if (v) return v;
    if (Date.now() - t0 > timeout) throw new Error(`timed out waiting for ${msg}`);
    await sleep(100);
  }
}

// ---------------------------------------------------------------------------
// fixtures

const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
/** Opaque RGB PNG with a gradient + noise. */
function makePng(w, hgt, seed = 1) {
  const raw = Buffer.alloc((w * 3 + 1) * hgt);
  let s = seed;
  const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) % 32);
  for (let y = 0; y < hgt; y++) {
    const row = y * (w * 3 + 1);
    raw[row] = 0;
    for (let x = 0; x < w; x++) {
      const o = row + 1 + x * 3;
      raw[o] = (x * 255 / w + rnd()) & 0xff;
      raw[o + 1] = (y * 255 / hgt + rnd()) & 0xff;
      raw[o + 2] = (128 + rnd()) & 0xff;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(hgt, 4);
  ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr), pngChunk('IDAT', zlib.deflateSync(raw)), pngChunk('IEND', Buffer.alloc(0)),
  ]);
}
function jpegSize(buf) {
  let i = 2;
  while (i < buf.length) {
    if (buf[i] !== 0xff) { i++; continue; }
    const m = buf[i + 1];
    const len = buf.readUInt16BE(i + 2);
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    i += 2 + len;
  }
  return null;
}
/** Binary-ish "PDF": CRLFs, NULs and high bytes must survive byte-exact. */
function pdfLike(tag) {
  const head = Buffer.from(`%PDF-1.4\r\n%\xe2\xe3\xcf\xd3\r\n1 0 obj << /Title (${tag}) >> endobj\r\n`, 'latin1');
  const bin = Buffer.alloc(2500);
  for (let i = 0; i < bin.length; i++) bin[i] = (i * 31 + tag.length) & 0xff;
  return Buffer.concat([head, bin, Buffer.from('\r\n%%EOF', 'latin1')]);
}

const PDF1 = pdfLike('photoelectric');
const PDF2 = pdfLike('franck-hertz raw data');
const PDF3 = pdfLike('extra');
const BIG_PNG = makePng(2400, 300, 5);

const SLUG = 'modern-physics-lab';
const CDIR = `content/courses/${SLUG}`;
const MDIR = `static/documents/courses/${SLUG}`;
const ZH = `${CDIR}/_index.md`;
const EN = `${CDIR}/_index.en.md`;
const ITEM1 = `${CDIR}/item-1.md`;
const ITEM_PHOTO = `${CDIR}/setup-photo.md`;
const NEW_ITEM = `${CDIR}/experiment-3-millikan.md`;

// ---------------------------------------------------------------------------
// helpers

const sel = (id) => `[data-testid="${id}"]`;
const itemRow = (p) => `${sel('item-row')}[data-path="${p}"]`;
const courseRow = (s) => `${sel('course-row')}[data-slug="${s}"]`;

async function waitCourses(page, which = 'list') {
  await page.waitForSelector('body[data-view-ready="courses"]', { state: 'attached', timeout: 20000 });
  await page.waitForSelector(`body[data-courses-ready="${which}"]`, { state: 'attached', timeout: 20000 });
}
async function go(page, hash, which) {
  await page.evaluate((h) => { delete document.body.dataset.viewReady; delete document.body.dataset.coursesReady; location.hash = h; }, hash);
  await waitCourses(page, which);
}
async function waitNoOverlay(page) {
  await page.waitForSelector(sel('overlay'), { state: 'detached', timeout: 30000 });
}
async function closeToasts(page) {
  await page.evaluate(() => document.querySelectorAll('.toast').forEach((t) => t.remove()));
}
async function noHorizontalScroll(page) {
  return page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
}
async function commitAfter(page, mock, action) {
  const n = mock.commits.length;
  await action();
  await until(() => mock.commits.length > n, { msg: 'a commit' });
  await waitNoOverlay(page);
  assert.equal(mock.commits.length, n + 1, 'exactly one commit');
  return mock.commits.at(-1);
}
function changedPaths(c) { return c.changes.map((x) => x.path).sort(); }
function splitMd(text) {
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
  assert.ok(m, 'front matter: ' + text.slice(0, 80));
  return { fm: m[1], body: m[2] };
}

async function waitEditor(page) {
  await page.waitForSelector('body[data-view-ready="edit"]', { state: 'attached', timeout: 30000 });
  await page.waitForSelector('[data-testid="editor-body"] .vditor-wysiwyg', { timeout: 30000 });
}
async function typeAtEnd(page, text) {
  await page.evaluate(() => {
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
  });
  await page.keyboard.press('End');
  await page.keyboard.type(text, { delay: 5 });
}

// ---------------------------------------------------------------------------
// setup

console.log(`[e2e-courses] output: ${OUT}`);
const mock = await startMock({ siteDir: SITE_DIR, adminDir: ADMIN_DIR, runDelayMs: 300 });
const t0 = Date.now();
await buildSite({ repoDir: REPO_ROOT, outDir: SITE_DIR, baseURL: mock.url + '/' });
console.log(`[e2e-courses] site built in ${Date.now() - t0} ms; mock at ${mock.url}`);
const LANDING_ZH = mock.readFile('content/courses/_index.md');
const LANDING_EN = mock.readFile('content/courses/_index.en.md');

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(mock.url).origin });
const page = await context.newPage();
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
if (process.env.DEBUG) page.on('console', (m) => console.log('    [console]', m.type(), m.text()));
const { blocked } = await openAdmin(page, mock, { path: '/admin/#/courses' });

// ---------------------------------------------------------------------------

await test('课程 nav item → empty state + landing note', async () => {
  await waitCourses(page, 'list');
  assert.equal(await page.getAttribute(sel('nav-courses'), 'aria-current'), 'page');
  assert.equal(await page.textContent('#page-title'), '课程');
  assert.ok(await page.isVisible(sel('courses-empty')));
  assert.match(await page.textContent(sel('courses-landing')), /课程资料/);
  assert.equal(await page.getAttribute(sel('courses-edit-landing'), 'href'), '#/edit?path=' + encodeURIComponent('content/courses/_index.md'));
});

await test('create a course (中文 + English) → one commit, exact _index.md + _index.en.md', async () => {
  await page.click(sel('courses-new'));
  await page.waitForSelector(sel('new-course'));
  await page.fill(sel('new-course-name-zh'), '近代物理实验');
  await page.fill(sel('new-course-name-en'), 'Modern Physics Lab');
  assert.equal(await page.inputValue(sel('new-course-slug')), SLUG, 'address suggested from the English name');
  assert.match(await page.textContent(sel('new-course-url')), /\/courses\/modern-physics-lab\/.*\/en\/courses\/modern-physics-lab\//);
  await page.fill(sel('new-course-group'), '实验课');
  await page.fill(sel('new-course-desc'), '大三上学期，每个实验一篇报告');
  await page.fill(sel('new-course-desc-en'), 'Junior year: one report per experiment');
  const c = await commitAfter(page, mock, () => page.click(sel('new-course-ok')));
  assert.equal(c.message, 'admin: 新建课程《近代物理实验》');
  assert.deepEqual(changedPaths(c), [EN, ZH].sort());
  assert.equal(mock.readFile(ZH), '---\ntitle: "近代物理实验"\ndescription: "大三上学期，每个实验一篇报告"\ngroup: "实验课"\nweight: 10\n---\n');
  assert.equal(mock.readFile(EN), '---\ntitle: "Modern Physics Lab"\ndescription: "Junior year: one report per experiment"\ngroup: "实验课"\nweight: 10\n---\n');
  await waitCourses(page, 'detail');
  assert.equal(await page.evaluate(() => location.hash), '#/courses?course=' + SLUG);
  assert.equal(await page.textContent(sel('course-heading')), '近代物理实验');
  assert.ok(await page.isVisible(sel('items-empty')));
  assert.ok(await page.isVisible(sel('materials-empty')));
  assert.equal(await page.getAttribute(sel('nav-courses'), 'aria-current'), 'page');
});

await test('second course without English / group: slug validation, list shows 实验课 + 其他 groups, datalist', async () => {
  await go(page, '#/courses', 'list');
  await page.click(sel('courses-new'));
  await page.waitForSelector(sel('new-course'));
  // the existing group is offered in the datalist
  const options = await page.$$eval(`${sel('new-course')} datalist option`, (els) => els.map((o) => o.value));
  assert.deepEqual(options, ['实验课']);
  await page.fill(sel('new-course-name-zh'), '光学');
  assert.equal(await page.inputValue(sel('new-course-slug')), '', 'pure Chinese name → no suggestion');
  await page.click(sel('new-course-ok'));
  assert.match(await page.textContent(`${sel('new-course')} .error:not([hidden])`), /请填写网址/);
  await page.fill(sel('new-course-slug'), SLUG);
  await page.click(sel('new-course-ok'));
  assert.match(await page.textContent(`${sel('new-course')} .error:not([hidden])`), /已经有一门课用了这个网址/);
  await page.fill(sel('new-course-slug'), 'Optics!');
  await page.click(sel('new-course-ok'));
  assert.match(await page.textContent(`${sel('new-course')} .error:not([hidden])`), /只能用小写英文字母/);
  await page.fill(sel('new-course-slug'), 'optics');
  await page.fill(sel('new-course-desc'), '光学笔记');
  const c = await commitAfter(page, mock, () => page.click(sel('new-course-ok')));
  assert.deepEqual(changedPaths(c), ['content/courses/optics/_index.md']);
  assert.equal(mock.readFile('content/courses/optics/_index.md'), '---\ntitle: "光学"\ndescription: "光学笔记"\nweight: 20\n---\n');
  await waitCourses(page, 'detail');
  await go(page, '#/courses', 'list');
  const groups = await page.$$eval(sel('courses-group'), (els) => els.map((e) => e.dataset.name));
  assert.deepEqual(groups, ['实验课', '其他']);
  const rows = await page.$$eval(sel('course-row'), (els) => els.map((e) => [e.dataset.slug, e.querySelector('[data-testid="course-count-items"]').textContent]));
  assert.deepEqual(rows, [[SLUG, '0 篇子推文'], ['optics', '0 篇子推文']]);
});

await test('batch upload 3 files (2 PDFs + 1 PNG, one PDF only into 资料) → ONE commit with 2 sub-posts', async () => {
  await go(page, '#/courses?course=' + SLUG, 'detail');
  assert.equal(await page.isChecked(sel('course-compress')), true, 'compression on by default');
  // seed an existing (hand-made) sub-post so the batch continues after its weight
  await page.setInputFiles(sel('course-files-input'), [
    { name: '实验1-光电效应.pdf', mimeType: 'application/pdf', buffer: PDF1 },
    { name: '实验2_弗兰克-赫兹 原始数据.pdf', mimeType: 'application/pdf', buffer: PDF2 },
    { name: 'Setup Photo.png', mimeType: 'image/png', buffer: BIG_PNG },
  ]);
  await page.waitForSelector(sel('course-batch'), { timeout: 30000 });
  const rows = await page.$$eval(sel('batch-row'), (els) => els.map((e) => [e.dataset.name, e.dataset.mode, e.querySelector('[data-testid="batch-title"]').value]));
  assert.deepEqual(rows, [
    ['实验1-光电效应.pdf', 'item', '实验1 光电效应'],
    ['实验2_弗兰克-赫兹-原始数据.pdf', 'item', '实验2 弗兰克 赫兹 原始数据'],
    ['Setup-Photo.jpg', 'item', 'Setup Photo'],
  ], 'default titles from file names, PNG already compressed to JPG, everything defaults to 生成子推文');
  assert.match(await page.textContent(sel('batch-summary')), /将上传 3 个文件.*生成 3 篇子推文/);
  // PDF 2 → 只放进资料列表；the photo gets a Chinese title
  await page.check(`${sel('batch-row')}[data-name="实验2_弗兰克-赫兹-原始数据.pdf"] ${sel('batch-mode-materials')}`);
  assert.equal(await page.isVisible(`${sel('batch-row')}[data-name="实验2_弗兰克-赫兹-原始数据.pdf"] ${sel('batch-title')}`), false);
  await page.fill(`${sel('batch-row')}[data-name="Setup-Photo.jpg"] ${sel('batch-title')}`, '');
  await page.click(sel('batch-submit'));
  assert.match(await page.textContent(`${sel('batch-row')}[data-name="Setup-Photo.jpg"] .error`), /请填写标题/);
  await page.fill(`${sel('batch-row')}[data-name="Setup-Photo.jpg"] ${sel('batch-title')}`, '实验装置照片');
  assert.match(await page.textContent(sel('batch-summary')), /将上传 3 个文件到 static\/documents\/courses\/modern-physics-lab\/，并生成 2 篇子推文/);
  await page.screenshot({ path: path.join(SHOTS, 'courses-batch-dialog.png') });
  const c = await commitAfter(page, mock, () => page.click(sel('batch-submit')));
  assert.equal(c.message, 'admin: 课程《近代物理实验》上传 3 个文件，新增 2 篇子推文');
  assert.deepEqual(changedPaths(c), [
    ITEM1, ITEM_PHOTO,
    `${MDIR}/Setup-Photo.jpg`, `${MDIR}/实验1-光电效应.pdf`, `${MDIR}/实验2_弗兰克-赫兹-原始数据.pdf`,
  ].sort());
  assert.ok(mock.readBytes(`${MDIR}/实验1-光电效应.pdf`).equals(PDF1), 'PDF 1 byte-exact');
  assert.ok(mock.readBytes(`${MDIR}/实验2_弗兰克-赫兹-原始数据.pdf`).equals(PDF2), 'PDF 2 byte-exact');
  const jpg = mock.readBytes(`${MDIR}/Setup-Photo.jpg`);
  assert.deepEqual([...jpg.subarray(0, 3)], [0xff, 0xd8, 0xff], 'compressed to JPEG');
  assert.deepEqual(jpegSize(jpg), { width: 1920, height: 240 });
  assert.equal(mock.readFile(ITEM1),
    '---\ntitle: "实验1 光电效应"\nweight: 10\ndraft: false\n---\n\n{{< pdf "/documents/courses/modern-physics-lab/实验1-光电效应.pdf" >}}\n');
  assert.equal(mock.readFile(ITEM_PHOTO),
    '---\ntitle: "实验装置照片"\nweight: 20\ndraft: false\n---\n\n![实验装置照片](/documents/courses/modern-physics-lab/Setup-Photo.jpg)\n');
  // the detail page now lists the sub-posts in order and the materials sorted by name
  await page.waitForSelector(itemRow(ITEM1));
  assert.deepEqual(await page.$$eval(sel('item-row'), (els) => els.map((e) => e.dataset.path)), [ITEM1, ITEM_PHOTO]);
  assert.deepEqual(await page.$$eval(sel('material-name'), (els) => els.map((e) => e.textContent)),
    ['Setup-Photo.jpg', '实验1-光电效应.pdf', '实验2_弗兰克-赫兹-原始数据.pdf']);
  // 「用在《…》」 links to the sub-post that embeds / shows the file
  await page.waitForSelector(`${sel('material-row')}[data-path="${MDIR}/实验1-光电效应.pdf"] ${sel('material-used')}`);
  assert.equal(await page.textContent(`${sel('material-row')}[data-path="${MDIR}/实验1-光电效应.pdf"] ${sel('material-used')}`), '《实验1 光电效应》');
  assert.equal(await page.textContent(`${sel('material-row')}[data-path="${MDIR}/Setup-Photo.jpg"] ${sel('material-used')}`), '《实验装置照片》');
  assert.equal(await page.$(`${sel('material-row')}[data-path="${MDIR}/实验2_弗兰克-赫兹-原始数据.pdf"] ${sel('material-used')}`), null);
  // PDFs: 复制预览链接 + 打开 = viewer
  const pdfRow = `${sel('material-row')}[data-path="${MDIR}/实验1-光电效应.pdf"]`;
  assert.equal(await page.getAttribute(`${pdfRow} ${sel('material-open')}`, 'href'),
    mock.url + '/viewer/?file=' + encodeURIComponent('/documents/courses/modern-physics-lab/实验1-光电效应.pdf'));
  await closeToasts(page);
  await page.click(`${pdfRow} ${sel('material-copy-preview')}`);
  await page.waitForSelector(sel('toast-success'));
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()),
    mock.url + '/viewer/?file=' + encodeURIComponent('/documents/courses/modern-physics-lab/实验1-光电效应.pdf'));
  assert.equal(await page.getAttribute(sel('course-files-link'), 'href'), '#/files?dir=' + encodeURIComponent(MDIR));
  await page.screenshot({ path: path.join(SHOTS, 'courses-detail-desktop.png'), fullPage: true });
});

await test('refused types: .html / .svg (Chinese explanation, PNG suggestion); 上传资料 puts files only into 资料', async () => {
  const before = mock.commits.length;
  // only refused files → alert, no commit
  await page.setInputFiles(sel('course-files-input'), [
    { name: 'notes.html', mimeType: 'text/html', buffer: Buffer.from('<script>alert(1)</script>') },
    { name: 'logo.SVG', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>') },
  ]);
  await page.waitForSelector(sel('upload-refused'));
  const text = await page.textContent(sel('upload-refused'));
  assert.match(text, /notes\.html.*不能上传 \.html 文件/);
  assert.match(text, /logo\.SVG.*SVG.*转换成 PNG/);
  assert.match(await page.textContent(sel('upload-blocked-explain')), /以本站的身份运行.*登录令牌/);
  await page.click(sel('confirm-ok'));
  assert.equal(mock.commits.length, before, 'nothing uploaded');
  // 上传资料 (file chooser) → svg skipped with explanation, the PDF goes into 资料 only
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click(sel('course-upload-materials'))]);
  await chooser.setFiles([
    { name: 'x.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg/>') },
    { name: '补充 材料.pdf', mimeType: 'application/pdf', buffer: PDF3 },
  ]);
  await page.waitForSelector(sel('course-batch'));
  assert.ok(await page.isVisible(sel('files-warn-refused')));
  assert.match(await page.textContent(sel('files-warn-refused')), /x\.svg.*转换成 PNG/);
  assert.deepEqual(await page.$$eval(sel('batch-row'), (els) => els.map((e) => [e.dataset.name, e.dataset.mode])), [['补充-材料.pdf', 'materials']]);
  const c = await commitAfter(page, mock, () => page.click(sel('batch-submit')));
  assert.equal(c.message, 'admin: 课程《近代物理实验》上传资料 补充-材料.pdf');
  assert.deepEqual(changedPaths(c), [`${MDIR}/补充-材料.pdf`]);
  assert.ok(mock.readBytes(`${MDIR}/补充-材料.pdf`).equals(PDF3));
  assert.equal(mock.readFile(`${MDIR}/x.svg`), undefined);
  await page.waitForSelector(`${sel('material-row')}[data-path="${MDIR}/补充-材料.pdf"]`);
});

await test('reorder sub-posts → one commit, weights patched surgically (comments preserved)', async () => {
  // the user annotated the files on GitHub; the admin re-reads them
  const a = '---\ntitle: "实验1 光电效应"\nweight: 10 # 第一个实验\n# 下面是草稿开关\ndraft: false\n---\n\n{{< pdf "/documents/courses/modern-physics-lab/实验1-光电效应.pdf" >}}\n\n手写的说明。\n';
  const b = '---\ntitle: "实验装置照片"   # 标题\nweight: 20 # 照片\ndraft: false\n---\n\n![实验装置照片](/documents/courses/modern-physics-lab/Setup-Photo.jpg)\n';
  mock.setFile(ITEM1, a);
  mock.setFile(ITEM_PHOTO, b);
  await page.click(sel('courses-refresh'));
  await page.waitForSelector(sel('toast-success'));
  await closeToasts(page);
  assert.equal(await page.isVisible(sel('items-savebar')), false);
  await page.click(`${itemRow(ITEM1)} ${sel('item-down')}`);
  assert.deepEqual(await page.$$eval(sel('item-row'), (els) => els.map((e) => e.dataset.path)), [ITEM_PHOTO, ITEM1]);
  assert.match(await page.textContent(sel('items-savebar')), /调整了 2 篇的顺序/);
  const c = await commitAfter(page, mock, () => page.click(sel('items-save-order')));
  assert.equal(c.message, 'admin: 调整课程《近代物理实验》的子推文顺序');
  assert.deepEqual(changedPaths(c), [ITEM1, ITEM_PHOTO].sort());
  assert.equal(mock.readFile(ITEM1), a.replace('weight: 10 # 第一个实验', 'weight: 20 # 第一个实验'));
  assert.equal(mock.readFile(ITEM_PHOTO), b.replace('weight: 20 # 照片', 'weight: 10 # 照片'));
  await page.waitForSelector(sel('items-savebar'), { state: 'detached' });
  assert.deepEqual(await page.$$eval(sel('item-row'), (els) => els.map((e) => e.dataset.path)), [ITEM_PHOTO, ITEM1]);
});

await test('conflict on reorder: file changed on GitHub → reload keeps the new order → save again', async () => {
  await page.click(`${itemRow(ITEM1)} ${sel('item-up')}`);
  assert.deepEqual(await page.$$eval(sel('item-row'), (els) => els.map((e) => e.dataset.path)), [ITEM1, ITEM_PHOTO]);
  // someone edits the photo post on GitHub meanwhile (adds a description)
  const remote = mock.readFile(ITEM_PHOTO).replace('draft: false\n', 'draft: false\ndescription: "在 GitHub 上加的"\n');
  mock.setFile(ITEM_PHOTO, remote);
  const before = mock.commits.length;
  await page.click(sel('items-save-order'));
  await page.waitForSelector(sel('conflict-reload'));
  assert.equal(mock.commits.length, before, 'nothing committed on conflict');
  await page.click(sel('conflict-reload'));
  await waitNoOverlay(page);
  await page.waitForSelector(sel('items-savebar'));
  assert.deepEqual(await page.$$eval(sel('item-row'), (els) => els.map((e) => e.dataset.path)), [ITEM1, ITEM_PHOTO], 'my order is kept');
  const c = await commitAfter(page, mock, () => page.click(sel('items-save-order')));
  assert.deepEqual(changedPaths(c), [ITEM1, ITEM_PHOTO].sort());
  assert.equal(mock.readFile(ITEM_PHOTO), remote.replace('weight: 10 # 照片', 'weight: 20 # 照片'), 'their description is kept');
  assert.match(mock.readFile(ITEM1), /^weight: 10 # 第一个实验$/m);
});

await test('＋ 新子推文 via the editor → weight after the max, no menu, no date', async () => {
  await page.click(sel('course-new-item'));
  await waitEditor(page);
  assert.equal(await page.evaluate(() => location.hash), '#/edit?new=page&dir=' + encodeURIComponent(CDIR));
  assert.equal(await page.getAttribute(sel('nav-courses'), 'aria-current'), 'page');
  assert.equal(await page.textContent('#page-title'), '新子推文');
  assert.ok(await page.isVisible(sel('editor-course-note')));
  assert.equal(await page.$(sel('editor-inmenu')), null, 'no menu switch for course sub-posts');
  await page.fill(sel('editor-title'), 'Experiment 3 Millikan');
  assert.equal(await page.inputValue(sel('editor-slug')), 'experiment-3-millikan');
  await typeAtEnd(page, '油滴实验的报告。');
  await page.fill(sel('editor-description'), '密立根油滴');
  const c = await commitAfter(page, mock, () => page.click(sel('editor-publish')));
  assert.deepEqual(changedPaths(c), [NEW_ITEM]);
  const { fm, body } = splitMd(mock.readFile(NEW_ITEM));
  assert.equal(fm, 'title: "Experiment 3 Millikan"\nweight: 30\ndescription: "密立根油滴"\ndraft: false');
  assert.match(body, /油滴实验的报告。/);
  // the editor reopens the published file; back → the course
  await page.waitForFunction((p) => location.hash === '#/edit?path=' + encodeURIComponent(p), NEW_ITEM);
  await waitEditor(page);
  await page.click(sel('editor-back'));
  await waitCourses(page, 'detail');
  assert.equal(await page.evaluate(() => location.hash), '#/courses?course=' + SLUG);
  assert.deepEqual(await page.$$eval(sel('item-row'), (els) => els.map((e) => e.dataset.path)), [ITEM1, ITEM_PHOTO, NEW_ITEM]);
});

await test('edit course info in the editor keeps group / weight (and their comments) untouched', async () => {
  mock.setFile(ZH, '---\ntitle: "近代物理实验"\ndescription: "大三上学期，每个实验一篇报告"\ngroup: "实验课"  # 分组\nweight: 10 # 课程顺序\n---\n');
  await page.click(sel('courses-refresh'));
  await page.waitForSelector(sel('toast-success'));
  await closeToasts(page);
  await page.click(sel('course-edit'));
  await waitEditor(page);
  assert.ok(await page.isVisible(sel('editor-course-note')));
  assert.equal(await page.$(sel('editor-inmenu')), null);
  await page.fill(sel('editor-description'), '大三上学期，每个实验一篇报告（2026 秋）');
  await typeAtEnd(page, '课程介绍：实验安排见下。');
  const c = await commitAfter(page, mock, () => page.click(sel('editor-publish')));
  assert.deepEqual(changedPaths(c), [ZH]);
  const { fm, body } = splitMd(mock.readFile(ZH));
  assert.equal(fm, 'title: "近代物理实验"\ndescription: "大三上学期，每个实验一篇报告（2026 秋）"\ngroup: "实验课"  # 分组\nweight: 10 # 课程顺序');
  assert.match(body, /课程介绍：实验安排见下。/);
  assert.equal(mock.readFile(EN), '---\ntitle: "Modern Physics Lab"\ndescription: "Junior year: one report per experiment"\ngroup: "实验课"\nweight: 10\n---\n', 'English version untouched');
  await page.click(sel('editor-back'));
  await waitCourses(page, 'detail');
});

await test('delete a sub-post (all versions) after confirm; its materials stay', async () => {
  await page.click(`${itemRow(NEW_ITEM)} ${sel('item-delete')}`);
  await page.waitForSelector(sel('confirm-ok'));
  assert.match(await page.textContent('.modal'), /experiment-3-millikan\.md/);
  assert.match(await page.textContent('.modal'), /资料不会被删除/);
  const c = await commitAfter(page, mock, () => page.click(sel('confirm-ok')));
  assert.equal(c.message, 'admin: 删除子推文《Experiment 3 Millikan》');
  assert.deepEqual(c.changes.map((x) => [x.path, x.status]), [[NEW_ITEM, 'removed']]);
  assert.equal(mock.readFile(NEW_ITEM), undefined);
  await page.waitForSelector(itemRow(NEW_ITEM), { state: 'detached' });
  assert.ok(mock.readBytes(`${MDIR}/实验1-光电效应.pdf`));
});

await test('change a course group; rename a group across zh + en in one commit', async () => {
  await go(page, '#/courses', 'list');
  await page.click(`${courseRow('optics')} ${sel('course-group')}`);
  await page.waitForSelector(sel('course-group-dialog'));
  assert.deepEqual(await page.$$eval(`${sel('course-group-dialog')} datalist option`, (els) => els.map((o) => o.value)), ['实验课']);
  await page.fill(sel('course-group-input'), '理论课');
  let c = await commitAfter(page, mock, () => page.click(sel('course-group-ok')));
  assert.equal(c.message, 'admin: 课程《光学》分组改为「理论课」');
  assert.equal(mock.readFile('content/courses/optics/_index.md'), '---\ntitle: "光学"\ndescription: "光学笔记"\nweight: 20\ngroup: "理论课"\n---\n');
  await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="courses-group"]')].map((e) => e.dataset.name).join('|') === '实验课|理论课');
  // rename 实验课 → 实验（both language versions of the lab course）
  await page.click(`${sel('courses-group')}[data-name="实验课"] ${sel('group-rename')}`);
  await page.waitForSelector(sel('prompt-input'));
  await page.fill(sel('prompt-input'), '实验');
  c = await commitAfter(page, mock, () => page.click(sel('prompt-ok')));
  assert.equal(c.message, 'admin: 课程分组「实验课」改名为「实验」');
  assert.deepEqual(changedPaths(c), [EN, ZH].sort());
  assert.match(mock.readFile(ZH), /^group: "实验"  # 分组$/m, 'comment kept');
  assert.match(mock.readFile(EN), /^group: "实验"$/m);
  await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="courses-group"]')].map((e) => e.dataset.name).join('|') === '实验|理论课');
});

await test('reorder courses: move a whole group → weights swapped in every language version', async () => {
  await page.click(`${sel('courses-group')}[data-name="理论课"] ${sel('group-up')}`);
  assert.deepEqual(await page.$$eval(sel('courses-group'), (els) => els.map((e) => e.dataset.name)), ['理论课', '实验']);
  assert.match(await page.textContent(sel('courses-savebar')), /调整了 2 门课的顺序/);
  const c = await commitAfter(page, mock, () => page.click(sel('courses-save-order')));
  assert.equal(c.message, 'admin: 调整课程顺序');
  assert.deepEqual(changedPaths(c), [EN, ZH, 'content/courses/optics/_index.md'].sort());
  assert.match(mock.readFile(ZH), /^weight: 20 # 课程顺序$/m);
  assert.match(mock.readFile(EN), /^weight: 20$/m);
  assert.match(mock.readFile('content/courses/optics/_index.md'), /^weight: 10$/m);
  await page.waitForSelector(sel('courses-savebar'), { state: 'detached' });
  assert.deepEqual(await page.$$eval(sel('course-row'), (els) => els.map((e) => e.dataset.slug)), ['optics', SLUG]);
  // ↑ / ↓ inside a group: only one course per group → disabled
  assert.equal(await page.isDisabled(`${courseRow('optics')} ${sel('course-up')}`), true);
  await page.screenshot({ path: path.join(SHOTS, 'courses-list-desktop.png'), fullPage: true });
});

await test('页面 shows only the 课程资料 landing (with a link), 文章 has no course pages', async () => {
  await page.evaluate(() => { delete document.body.dataset.viewReady; location.hash = '#/pages'; });
  await page.waitForSelector('body[data-view-ready="pages"]', { state: 'attached' });
  await page.waitForSelector(`${sel('page-row')}[data-key="content/courses/_index"]`);
  const keys = await page.$$eval(sel('page-row'), (els) => els.map((e) => e.dataset.key));
  assert.ok(!keys.some((k) => k.startsWith('content/courses/') && k !== 'content/courses/_index'), keys.join(', '));
  assert.match(await page.textContent(`${sel('page-row')}[data-key="content/courses/_index"] ${sel('page-courses-link')}`), /2 门课程/);
  await page.evaluate(() => { delete document.body.dataset.viewReady; location.hash = '#/posts'; });
  await page.waitForSelector('body[data-view-ready="posts"]', { state: 'attached' });
  await page.waitForSelector('[data-testid="post-row"]');
  const posts = await page.$$eval('[data-testid="post-row"]', (els) => els.map((e) => e.textContent).join('\n'));
  assert.ok(!/光电效应|实验装置照片|近代物理实验/.test(posts), 'no course pages among posts');
  // the landing page's own text is untouched by all of the above
  assert.equal(mock.readFile('content/courses/_index.md'), LANDING_ZH);
  assert.equal(mock.readFile('content/courses/_index.en.md'), LANDING_EN);
});

await test('phone 390×844 and 360: list, detail and batch dialog without horizontal scroll', async () => {
  const m = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  m.on('pageerror', (e) => pageErrors.push(e.message));
  await openAdmin(m, mock, { path: '/admin/#/courses' });
  await waitCourses(m, 'list');
  assert.ok(await m.isVisible(sel('nav-courses')), 'tab bar has 课程');
  assert.ok(await noHorizontalScroll(m), 'list at 390');
  await m.screenshot({ path: path.join(SHOTS, 'courses-list-mobile.png'), fullPage: true });
  await go(m, '#/courses?course=' + SLUG, 'detail');
  assert.ok(await noHorizontalScroll(m), 'detail at 390');
  await m.screenshot({ path: path.join(SHOTS, 'courses-detail-mobile.png'), fullPage: true });
  await m.setInputFiles(sel('course-files-input'), [
    { name: '实验4-塞曼效应-一个很长很长的文件名-报告.pdf', mimeType: 'application/pdf', buffer: pdfLike('zeeman') },
    { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('x') },
  ]);
  await m.waitForSelector(sel('course-batch'));
  await m.waitForTimeout(350);
  assert.ok(await noHorizontalScroll(m), 'batch dialog at 390');
  const box = await m.evaluate(() => { const r = document.querySelector('[data-testid="course-batch"]').getBoundingClientRect(); return { l: r.left, r: r.right, w: innerWidth }; });
  assert.ok(box.l >= 0 && box.r <= box.w + 1, 'dialog fits: ' + JSON.stringify(box));
  await m.screenshot({ path: path.join(SHOTS, 'courses-batch-mobile.png') });
  await m.setViewportSize({ width: 360, height: 740 });
  await m.waitForTimeout(200);
  assert.ok(await noHorizontalScroll(m), 'batch dialog at 360');
  const before = mock.commits.length;
  await m.click(sel('batch-cancel'));
  await m.waitForSelector(sel('course-batch'), { state: 'detached' });
  assert.equal(mock.commits.length, before, 'cancel uploads nothing');
  assert.ok(await noHorizontalScroll(m), 'detail at 360');
  await m.screenshot({ path: path.join(SHOTS, 'courses-detail-360.png'), fullPage: true });
  await go(m, '#/courses', 'list');
  assert.ok(await noHorizontalScroll(m), 'list at 360');
  await m.close();
});

await test('exported repo builds: course page lists sub-posts in order + materials; zh + en sub-posts embed the viewer', async () => {
  mock.exportTo(EXPORT_DIR);
  await buildSite({ repoDir: EXPORT_DIR, outDir: BUILD2_DIR, baseURL: mock.url + '/' });
  const read = (...p) => fs.readFileSync(path.join(BUILD2_DIR, ...p, 'index.html'), 'utf8');
  const unit = read('courses', SLUG);
  // sub-posts in weight order (实验1 = 10, 照片 = 20), linked
  const i1 = unit.indexOf('实验1 光电效应');
  const i2 = unit.indexOf('实验装置照片');
  assert.ok(i1 > 0 && i2 > 0 && i1 < i2, `sub-posts listed in order (${i1}, ${i2})`);
  assert.ok(unit.includes(`/courses/${SLUG}/item-1/`) && unit.includes(`/courses/${SLUG}/setup-photo/`), 'sub-post links');
  assert.ok(!unit.includes('experiment-3-millikan'), 'the deleted sub-post is gone');
  // the materials list (built from static/documents/courses/<course>/ at build time), sorted by name, with viewer links for PDFs / images
  const names = ['Setup-Photo.jpg', '实验1-光电效应.pdf', '实验2_弗兰克-赫兹-原始数据.pdf', '补充-材料.pdf'];
  const pos = names.map((n) => unit.lastIndexOf(n));
  assert.ok(pos.every((p) => p > 0), 'all materials listed: ' + pos.join(','));
  assert.deepEqual([...pos].sort((a, b) => a - b), pos, 'materials sorted by name');
  assert.match(unit, /\/viewer\/\?file=%2[Ff]documents%2[Ff]courses%2[Ff]modern-physics-lab%2[Ff]/, 'materials open in the viewer');
  assert.ok(unit.includes('课程介绍：实验安排见下。'), 'the intro written in the editor');
  // sub-post: embedded viewer (zh default UI) / English site: lang=en
  const zhItem = read('courses', SLUG, 'item-1');
  assert.match(zhItem, /<iframe[^>]+\/viewer\/\?file=%2[Ff]documents%2[Ff]courses%2[Ff]modern-physics-lab%2[Ff]/, 'zh sub-post embeds the viewer');
  assert.ok(!/<iframe[^>]+lang=en/.test(zhItem));
  const enItem = read('en', 'courses', SLUG, 'item-1');
  assert.match(enItem, /<iframe[^>]+\/viewer\/\?file=%2[Ff]documents%2[Ff]courses%2[Ff]modern-physics-lab%2[Ff][^"]*lang=en/, 'en sub-post embeds the English viewer');
  const photo = read('courses', SLUG, 'setup-photo');
  assert.ok(photo.includes('/documents/courses/modern-physics-lab/Setup-Photo.jpg'), 'photo sub-post shows the image');
  assert.ok(fs.readFileSync(path.join(BUILD2_DIR, 'documents', 'courses', SLUG, '实验1-光电效应.pdf')).equals(PDF1), 'PDF served byte-exact');
  // the landing page lists both courses (理论课 group first after the reorder), keeping the user's text
  const landing = read('courses');
  // (the user's intro text above the cards also mentions 光学, so look for the card links)
  const lo = landing.search(/href="?\/courses\/optics\/"?/);
  const ll = landing.search(/href="?\/courses\/modern-physics-lab\/"?/);
  assert.ok(lo > 0 && ll > 0 && lo < ll, `landing lists 光学 before 近代物理实验 (${lo}, ${ll})`);
  const g1 = landing.search(/>\s*理论课\s*</);
  const g2 = landing.search(/>\s*实验\s*</);
  assert.ok(g1 > 0 && g1 < lo && g2 > lo && g2 < ll, `group headings in order (${g1}, ${g2})`);
  assert.ok(landing.includes('资料使用说明'), "the user's intro text is kept");
  const enLanding = read('en', 'courses');
  assert.ok(enLanding.includes('Modern Physics Lab'), 'English course title on the English landing');
});

// ---------------------------------------------------------------------------
// adversarial round (verifier): hand-written / odd content, 30-file batch, slug collisions, group spellings,
// draft course, delete a whole course, then build again

const BUILD3_DIR = path.join(OUT, 'site-adversarial');
const EXPORT3_DIR = path.join(OUT, 'export-adversarial');
const BULK = 'bulk-lab';
async function goEdit(pg, repoPath) {
  await pg.evaluate((h) => { delete document.body.dataset.viewReady; location.hash = h; }, '#/edit?path=' + encodeURIComponent(repoPath));
  await waitEditor(pg);
}
const SECRET = 'secret-course';

await test('hand-written courses (no weight / group, nested folder, TOML, broken YAML, loose page) do not break the admin', async () => {
  mock.setFile('content/courses/handmade/_index.md', '---\ntitle: "手写课程"\n---\n\n手写的介绍。\n');
  mock.setFile('content/courses/handmade/notes.md', '---\ntitle: "笔记"\n---\n\n笔记正文\n');
  mock.setFile('content/courses/handmade/deep/_index.md', '---\ntitle: "更深一层"\nweight: 5\n---\n');
  mock.setFile('content/courses/handmade/deep/x.md', '---\ntitle: "深层子页"\nweight: 10\n---\n\n深层\n');
  mock.setFile('content/courses/tomlcourse/_index.md', '+++\ntitle = "TOML 课程"\ngroup = "理论课"\nweight = 30\n+++\n');
  mock.setFile('content/courses/loose.md', '---\ntitle: "散页"\nweight: 90\n---\n\n不在任何课程里的页面。\n');
  mock.setFile('content/courses/broken/_index.md', '---\ntitle: [\n---\n');
  mock.setFile('content/courses/broken/a.md', '---\ntitle: "坏课程的子推文"\nweight: 10\n---\n');
  mock.setFile('content/courses/broken/sub/b.md', '---\ntitle: "坏课程的深层页"\n---\n');
  mock.setFile('static/documents/courses/broken/x.pdf', '%PDF-1.4 broken course material');
  mock.setFile('static/documents/courses/broken/old/y.pdf', '%PDF-1.4 nested material');
  mock.setFile('static/images/pages/courses/broken/a/p.jpg', 'jpeg');
  mock.setFile('static/documents/courses/broken-2/keep.pdf', '%PDF-1.4 neighbour with the same prefix');
  await go(page, '#/courses', 'list');
  await page.click(sel('courses-refresh'));
  await page.waitForSelector(`${courseRow('handmade')}`);
  const rows = await page.$$eval(sel('course-row'), (els) => els.map((e) => e.dataset.slug));
  for (const s of ['handmade', 'tomlcourse', 'broken', 'optics', SLUG]) assert.ok(rows.includes(s), `${s} listed: ${rows}`);
  assert.ok(!rows.includes('loose') && !rows.includes('deep'), 'a loose page / nested folder is not a course');
  assert.match(await page.textContent(courseRow('broken')), /设置区有问题/);
  assert.match(await page.textContent(courseRow('tomlcourse')), /设置区有问题/);
  await go(page, '#/courses?course=handmade', 'detail');
  assert.deepEqual(await page.$$eval(`${sel('item-row')}`, (els) => els.map((e) => e.dataset.slug)), ['notes'], 'nested folder not listed as a sub-post');
  assert.match(await page.textContent(sel('item-row')), /没有顺序/);
  await go(page, '#/courses?course=broken', 'detail');
  assert.ok(await page.isVisible(sel('course-heading')));
  assert.deepEqual(pageErrors, []);
});

await test('new course: slug collisions (existing course, loose page, language code), Chinese-only name, group spelling snaps to the existing group', async () => {
  await go(page, '#/courses', 'list');
  await page.click(sel('courses-new'));
  await page.waitForSelector(sel('new-course'));
  await page.fill(sel('new-course-name-zh'), '大批量实验');
  assert.equal(await page.inputValue(sel('new-course-slug')), '', 'Chinese-only name → no suggested address');
  const err = () => page.textContent(`${sel('new-course')} .error:not([hidden])`);
  for (const [slugTry, re] of [['handmade', /已经有一门课用了这个网址/], ['loose', /同名的页面/], ['en', /保留/], ['page', /保留/], ['-x', /只能用小写英文字母/]]) {
    await page.fill(sel('new-course-slug'), slugTry);
    await page.click(sel('new-course-ok'));
    assert.match(await err(), re, slugTry);
  }
  await page.fill(sel('new-course-slug'), BULK);
  await page.fill(sel('new-course-group'), ' 理 论课 '); // differs from the existing 理论课 only by spaces
  const c = await commitAfter(page, mock, () => page.click(sel('new-course-ok')));
  assert.equal(mock.readFile(`content/courses/${BULK}/_index.md`), '---\ntitle: "大批量实验"\ngroup: "理论课"\nweight: 30\n---\n');
  assert.deepEqual(changedPaths(c), [`content/courses/${BULK}/_index.md`]);
  await waitCourses(page, 'detail');
});

await test('batch upload of 30 files (odd names, same titles) → ONE commit, progress counter, unique names / slugs, weights 10…300', async () => {
  const files = [];
  for (let i = 1; i <= 26; i++) files.push({ name: `lab ${String(i).padStart(2, '0')}.pdf`, mimeType: 'application/pdf', buffer: pdfLike(`lab-${i}`) });
  files.push({ name: '实验 #3 50%+😀.pdf', mimeType: 'application/pdf', buffer: pdfLike('odd') });
  files.push({ name: 'Report.pdf', mimeType: 'application/pdf', buffer: pdfLike('r1') });
  files.push({ name: 'report (1).PDF', mimeType: 'application/pdf', buffer: pdfLike('r2') });
  files.push({ name: '数据.txt', mimeType: 'text/plain', buffer: Buffer.from('1 2 3\n') });
  assert.equal(files.length, 30);
  mock.setApiDelay(25); // so the progress counter is visible
  await page.setInputFiles(sel('course-files-input'), files);
  await page.waitForSelector(sel('course-batch'));
  assert.equal((await page.$$(sel('batch-row'))).length, 30);
  // two files get the same title on purpose
  await page.fill(`${sel('batch-row')}[data-name="report-1.pdf"] ${sel('batch-title')}`, 'Report');
  assert.match(await page.textContent(sel('batch-summary')), /将上传 30 个文件.*生成 30 篇子推文/);
  const n = mock.commits.length;
  await page.click(sel('batch-submit'));
  const progress = await until(async () => {
    const t = await page.evaluate(() => { const o = document.querySelector('[data-testid="overlay"] .overlay-text'); return o ? o.textContent : ''; });
    return /正在上传文件（\d+\/\d+）/.test(t) ? t : null;
  }, { msg: 'upload progress counter', timeout: 30000 });
  assert.match(progress, /\/60）/, 'progress counts all 60 files (30 materials + 30 sub-posts): ' + progress);
  await until(() => mock.commits.length > n, { msg: 'the batch commit', timeout: 60000 });
  await waitNoOverlay(page);
  mock.setApiDelay(0);
  assert.equal(mock.commits.length, n + 1, 'exactly one commit');
  const c = mock.commits.at(-1);
  assert.equal(c.message, 'admin: 课程《大批量实验》上传 30 个文件，新增 30 篇子推文');
  assert.equal(c.changes.length, 60);
  const items = c.changes.map((x) => x.path).filter((p) => p.startsWith(`content/courses/${BULK}/`));
  const mats = c.changes.map((x) => x.path).filter((p) => p.startsWith(`static/documents/courses/${BULK}/`));
  assert.equal(items.length, 30);
  assert.equal(mats.length, 30);
  assert.equal(new Set(items).size, 30, 'unique sub-post files');
  for (const m of ['实验-3-50.pdf', 'Report.pdf', 'report-1.pdf', '数据.txt', 'lab-01.pdf', 'lab-26.pdf']) assert.ok(mats.includes(`static/documents/courses/${BULK}/${m}`), m + ' in ' + mats.join(','));
  const reportItems = items.filter((p) => /\/report(-\d+)?\.md$/.test(p)).sort();
  assert.deepEqual(reportItems, [`content/courses/${BULK}/report-2.md`, `content/courses/${BULK}/report.md`], 'same title → -2');
  const weights = items.map((p) => Number(/^weight: (\d+)$/m.exec(mock.readFile(p))[1])).sort((a, b) => a - b);
  assert.deepEqual(weights, Array.from({ length: 30 }, (_, i) => (i + 1) * 10));
  const odd = items.map((p) => mock.readFile(p)).find((t) => t.includes('实验-3-50.pdf'));
  assert.match(odd, /^title: "实验 #3 50%\+😀"$/m, 'title keeps the original characters');
  assert.ok(odd.includes(`{{< pdf "/documents/courses/${BULK}/实验-3-50.pdf" >}}`));
  const txt = items.map((p) => mock.readFile(p)).find((t) => t.includes('数据.txt'));
  assert.ok(txt.includes(`[下载 数据.txt](/documents/courses/${BULK}/数据.txt)`), txt);
  await waitCourses(page, 'detail');
  await until(async () => (await page.$$(sel('item-row'))).length === 30, { msg: '30 sub-posts listed' });
});

await test('draft course via the editor: cascade hides its sub-posts too; badge in the list; publish again removes it', async () => {
  // a second small course, then make it a draft
  await go(page, '#/courses', 'list');
  await page.click(sel('courses-new'));
  await page.fill(sel('new-course-name-zh'), '保密课程');
  await page.fill(sel('new-course-slug'), SECRET);
  await commitAfter(page, mock, () => page.click(sel('new-course-ok')));
  await waitCourses(page, 'detail');
  await page.setInputFiles(sel('course-files-input'), [{ name: 'secret-report.pdf', mimeType: 'application/pdf', buffer: pdfLike('secret') }]);
  await page.waitForSelector(sel('course-batch'));
  await commitAfter(page, mock, () => page.click(sel('batch-submit')));
  assert.ok(mock.readFile(`content/courses/${SECRET}/secret-report.md`));
  await waitCourses(page, 'detail');
  await page.click(sel('course-edit'));
  await waitEditor(page);
  await page.click(sel('editor-save-draft'));
  await page.waitForSelector(sel('confirm-ok'));
  assert.match(await page.textContent('.modal'), /课程页和它的全部子推文都不再显示/);
  const c = await commitAfter(page, mock, () => page.click(sel('confirm-ok')));
  assert.deepEqual(changedPaths(c), [`content/courses/${SECRET}/_index.md`]);
  const text = mock.readFile(`content/courses/${SECRET}/_index.md`);
  assert.match(text, /^draft: true$/m);
  assert.match(text, /^cascade: \{ build: \{ render: "never", list: "never" \} \}$/m);
  await page.click(sel('editor-back'));
  await waitCourses(page, 'detail');
  await go(page, '#/courses', 'list');
  assert.match(await page.textContent(`${courseRow(SECRET)} ${sel('course-draft')}`), /草稿/);
  // publish → draft:false and the cascade disappears (byte-identical apart from draft)
  mock.setFile(`content/courses/${SECRET}-tmp/_index.md`, text.replace('保密课程', '临时'));
  await page.click(sel('courses-refresh'));
  await page.waitForSelector(courseRow(`${SECRET}-tmp`));
  await goEdit(page, `content/courses/${SECRET}-tmp/_index.md`);
  const c2 = await commitAfter(page, mock, () => page.click(sel('editor-publish')));
  assert.deepEqual(changedPaths(c2), [`content/courses/${SECRET}-tmp/_index.md`]);
  const back = mock.readFile(`content/courses/${SECRET}-tmp/_index.md`);
  assert.ok(!/cascade/.test(back), back);
  assert.match(back, /^draft: false$/m);
  await page.click(sel('editor-back'));
  await waitCourses(page, 'detail');
});

await test('editor: 删除整个页面 on a course intro with sub-posts points to 删除课程 instead of orphaning them', async () => {
  const n = mock.commits.length;
  await goEdit(page, 'content/courses/handmade/_index.md');
  await page.click(sel('editor-more'));
  await page.click(sel('editor-delete-all'));
  await page.waitForSelector(sel('editor-delete-course-note'));
  assert.match(await page.textContent(sel('editor-delete-course-note')), /还有 3 个其他文件.*删除课程/);
  await page.click(sel('confirm-ok'));
  await waitCourses(page, 'detail');
  assert.equal(await page.evaluate(() => location.hash), '#/courses?course=handmade');
  assert.equal(mock.commits.length, n, 'nothing deleted');
  assert.ok(mock.readFile('content/courses/handmade/_index.md'));
});

await test('删除课程: accurate confirm (counts, materials optional, outside references) → ONE commit; neighbours untouched', async () => {
  // a page outside the course links one of its materials
  mock.setFile('content/research/uses-broken.md', '---\ntitle: "引用"\n---\n\n[x](/documents/courses/broken/x.pdf)\n');
  await page.click(sel('courses-refresh'));
  await page.waitForSelector(sel('toast-success'));
  await closeToasts(page);
  await go(page, '#/courses?course=broken', 'detail');
  await page.click(sel('course-delete'));
  await page.waitForSelector(sel('course-delete-dialog'));
  const t = await page.textContent(sel('course-delete-dialog'));
  assert.match(t, /content\/courses\/broken\/ 里的 3 个文件/);
  assert.match(t, /子推文 1 篇：《坏课程的子推文》/);
  assert.match(t, /其他文件 1 个/);
  assert.match(t, /图片 1 张（static\/images\/pages\/courses\/broken\/）/);
  assert.match(t, /同时删除资料文件夹 static\/documents\/courses\/broken\/（2 个文件/);
  assert.match(await page.textContent(sel('course-delete-refs')), /content\/research\/uses-broken\.md/);
  await page.check(sel('course-delete-materials'));
  const c = await commitAfter(page, mock, () => page.click(sel('confirm-ok')));
  assert.equal(c.message, 'admin: 删除课程《broken》');
  assert.deepEqual(c.changes.map((x) => [x.path, x.status]).sort(), [
    ['content/courses/broken/_index.md', 'removed'], ['content/courses/broken/a.md', 'removed'], ['content/courses/broken/sub/b.md', 'removed'],
    ['static/documents/courses/broken/old/y.pdf', 'removed'], ['static/documents/courses/broken/x.pdf', 'removed'],
    ['static/images/pages/courses/broken/a/p.jpg', 'removed'],
  ]);
  assert.ok(mock.readFile('static/documents/courses/broken-2/keep.pdf'), 'a folder with the same prefix stays');
  await waitCourses(page, 'list');
  assert.equal(await page.$(courseRow('broken')), null);
  mock.setFile('content/research/uses-broken.md', null);
  // a second course: keep the materials (default) → only content + images go
  await go(page, '#/courses?course=handmade', 'detail');
  mock.setFile('static/documents/courses/handmade/h.pdf', '%PDF-1.4 handmade');
  await page.click(sel('courses-refresh'));
  await page.waitForSelector(sel('toast-success'));
  await closeToasts(page);
  await page.click(sel('course-delete'));
  await page.waitForSelector(sel('course-delete-dialog'));
  assert.match(await page.textContent(sel('course-delete-dialog')), /4 个文件/);
  assert.equal(await page.isChecked(sel('course-delete-materials')), false, 'materials are kept unless ticked');
  const c2 = await commitAfter(page, mock, () => page.click(sel('confirm-ok')));
  assert.deepEqual(changedPaths(c2), ['content/courses/handmade/_index.md', 'content/courses/handmade/deep/_index.md', 'content/courses/handmade/deep/x.md', 'content/courses/handmade/notes.md']);
  assert.ok(mock.readFile('static/documents/courses/handmade/h.pdf'), 'materials kept');
  mock.setFile('static/documents/courses/handmade/h.pdf', null);
  await waitCourses(page, 'list');
});

await test('rename a group to a spelling of another group merges them; groups differing only by case collapse in the admin', async () => {
  mock.setFile('content/courses/caselab/_index.md', '---\ntitle: "大小写"\ngroup: "LABS"\nweight: 70\n---\n');
  await page.click(sel('courses-refresh'));
  await page.waitForSelector(`${sel('courses-group')}[data-name="LABS"]`);
  await page.click(`${sel('courses-group')}[data-name="LABS"] ${sel('group-rename')}`);
  await page.waitForSelector(sel('prompt-input'));
  await page.fill(sel('prompt-input'), '理论 课');
  const c = await commitAfter(page, mock, () => page.click(sel('prompt-ok')));
  assert.equal(c.message, 'admin: 课程分组「LABS」改名为「理论课」');
  assert.match(mock.readFile('content/courses/caselab/_index.md'), /^group: "理论课"$/m);
  await page.waitForSelector(`${sel('courses-group')}[data-name="LABS"]`, { state: 'detached' });
});

await test('a course folder without an intro page: 创建介绍页 in the editor → no menu entry (courses never go into the nav)', async () => {
  mock.setFile('content/courses/noindex/a.md', '---\ntitle: "孤儿子推文"\nweight: 10\n---\n\n正文\n');
  await waitCourses(page, 'list'); // still on the list after the rename
  await page.click(sel('courses-refresh'));
  await page.waitForSelector(courseRow('noindex'));
  assert.match(await page.textContent(courseRow('noindex')), /没有介绍页/);
  await go(page, '#/courses?course=noindex', 'detail');
  assert.equal(await page.getAttribute(sel('course-edit'), 'href'), '#/edit?new=page&dir=' + encodeURIComponent('content/courses/noindex'));
  await page.click(sel('course-edit'));
  await waitEditor(page);
  assert.equal(await page.$(sel('editor-inmenu')), null, 'no menu switch for a course intro');
  await page.fill('[data-testid="editor-title"]', '无介绍页课程');
  const c = await commitAfter(page, mock, () => page.click(sel('editor-publish')));
  assert.deepEqual(changedPaths(c), ['content/courses/noindex/_index.md']);
  const text = mock.readFile('content/courses/noindex/_index.md');
  assert.ok(!/menu/.test(text), text);
  assert.match(text, /^title: "无介绍页课程"$/m);
});

await test('adversarial build: grouping, 30 sub-posts, draft course + its sub-posts hidden, deleted courses gone, odd names linked, no warnings', async () => {
  fs.rmSync(EXPORT3_DIR, { recursive: true, force: true });
  mock.exportTo(EXPORT3_DIR);
  const built = await buildSite({ repoDir: EXPORT3_DIR, outDir: BUILD3_DIR, baseURL: mock.url + '/' });
  assert.ok(!/WARN|ERROR/.test(built.stderr + built.stdout), 'no Hugo warnings:\n' + built.stderr + built.stdout);
  const has = (...p) => fs.existsSync(path.join(BUILD3_DIR, ...p, 'index.html'));
  const read = (...p) => fs.readFileSync(path.join(BUILD3_DIR, ...p, 'index.html'), 'utf8');
  // draft course: neither the unit page nor its sub-posts, on either site; not in feeds / sitemaps
  for (const pre of [[], ['en']]) {
    assert.equal(has(...pre, 'courses', SECRET), false, 'draft course hidden');
    assert.equal(has(...pre, 'courses', SECRET, 'secret-report'), false, 'draft course sub-post hidden');
    assert.equal(has(...pre, 'courses', `${SECRET}-tmp`), true, 'the re-published course is back');
  }
  for (const f of ['index.xml', 'en/index.xml', 'sitemap.xml', 'en/sitemap.xml']) {
    const x = fs.readFileSync(path.join(BUILD3_DIR, f), 'utf8');
    assert.ok(!x.includes(`/courses/${SECRET}/`), `${f} does not mention the draft course`);
  }
  assert.equal(has('courses', 'broken'), false);
  assert.equal(has('courses', 'handmade'), false);
  // landing: 理论课 (TOML weight 30 → min weight 10 from optics) → 实验 → 其他 (the loose page); ids unique
  const landing = read('courses');
  const groups = [...landing.matchAll(/<h2 class="?course-group-title"? id="?([^" >]+)"?>([^<]+)</g)].map((m) => [m[1], m[2].trim()]);
  assert.deepEqual(groups.map((g) => g[1]), ['理论课', '实验', '其他']);
  assert.equal(new Set(groups.map((g) => g[0])).size, groups.length, 'unique group ids');
  const cards = [...landing.matchAll(/class="?course-card-title"?><a href="?([^" >]+)"?>/g)].map((m) => m[1]);
  assert.deepEqual(cards, ['/courses/optics/', '/courses/tomlcourse/', `/courses/${BULK}/`, '/courses/caselab/', `/courses/${SLUG}/`, `/courses/${SECRET}-tmp/`, '/courses/loose/', '/courses/noindex/'],
    'cards: ' + cards.join(' '));
  assert.ok(landing.includes('资料使用说明'), "the user's intro text is kept");
  // the nav menu still has only the site's own sections (no course got a menu entry)
  const menu = /<ul id="?menu"?[^>]*>([\s\S]*?)<\/ul>/.exec(read(''))[1];
  assert.deepEqual([...menu.matchAll(/href="?([^" >]+)/g)].map((m) => new URL(m[1], mock.url).pathname).sort(), ['/about/', '/courses/', '/posts/', '/research/']);
  assert.ok(!/noindex|bulk-lab|secret/.test(menu), menu);
  // the bulk course: 30 sub-posts in weight order, 30 materials, odd name linked to its sub-post
  const bulk = read('courses', BULK);
  assert.equal([...bulk.matchAll(/class="?course-post-title"?/g)].length, 30);
  assert.equal([...bulk.matchAll(/class="?course-material"? /g)].length, 30);
  const oddRow = /<li class="?course-material"?[^>]*>(?:(?!<\/li>)[\s\S])*实验-3-50\.pdf(?:(?!<\/li>)[\s\S])*<\/li>/.exec(bulk);
  assert.ok(oddRow && /course-material-post/.test(oddRow[0]), 'odd file name linked to its sub-post');
  const item = read('courses', BULK, 'lab-01');
  assert.match(item, /class="?paginav course-paginav"?/);
  assert.ok(has('en', 'courses', BULK, 'lab-26'));
});

await test('no page errors, nothing left the mock origin except blocked CDNs', async () => {
  assert.deepEqual(pageErrors, []);
  const bad = blocked.filter((u) => !/cdn\.jsdelivr\.net|github\.io/.test(u));
  assert.deepEqual(bad, [], 'unexpected external requests');
});

await browser.close();
await mock.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n[e2e-courses] ${results.length - failed.length}/${results.length} passed; screenshots in ${SHOTS}`);
process.exit(failed.length ? 1 : 0);
