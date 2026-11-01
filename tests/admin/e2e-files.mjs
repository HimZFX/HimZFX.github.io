// tests/admin/e2e-files.mjs — Playwright end-to-end test for the 「资料」 view (views/files.js).
//
// Covers: upload (button + drag & drop), image compression on/off, exact bytes in the mock repo,
// list + links + search, copy link, PDF preview links (/viewer/?file=…) + 复制文件链接, overwrite confirm,
// .gitignore confirm, ≥25 MB warning, delete warnings for direct / viewer-link / {{< pdf >}} references,
// delete, 图片 folder, custom folder chooser (admin/ refused), mobile layout, and finally a Hugo
// build of the exported repo that must serve /documents/<file>.
//
// Run from the repo root:   node tests/admin/e2e-files.mjs
// Env:
//   FILES_E2E_DIR   where the Hugo builds + screenshots go (default: $ADMIN_TEST_TMP/e2e-files or <os tmp>/admin-e2e-files)
//   HUGO_BIN        Hugo binary (see mock-github.mjs)
//   ONLY=<substr>   run only tests whose name contains this (tests share state; use for debugging only)

import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { startMock, buildSite, openAdmin, REPO_ROOT } from './mock-github.mjs';
import { createIgnoreMatcher, normalizeStaticDir } from '../../static/admin/js/views/files.js';
import { viewerUrlFor } from '../../static/admin/js/content.js';

const { chromium } = createRequire(import.meta.url)('playwright');

const OUT = path.resolve(process.env.FILES_E2E_DIR
  || (process.env.ADMIN_TEST_TMP ? path.join(process.env.ADMIN_TEST_TMP, 'e2e-files') : path.join(os.tmpdir(), 'admin-e2e-files')));
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
    console.log(`  ✗ ${name}\n      ${String((err && err.stack) || err).split('\n').slice(0, 8).join('\n      ')}`);
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
/** Opaque RGB PNG with a gradient + noise (so it is a "photo-like" image). */
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
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}
/** Width/height from a JPEG's SOF marker. */
function jpegSize(buf) {
  let i = 2;
  while (i < buf.length) {
    if (buf[i] !== 0xff) { i++; continue; }
    const m = buf[i + 1];
    const len = buf.readUInt16BE(i + 2);
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    }
    i += 2 + len;
  }
  return null;
}
function pdfLike(tag) {
  // Binary-ish "PDF": CRLFs, NULs and high bytes must survive byte-exact (no text normalization).
  const head = Buffer.from(`%PDF-1.4\r\n%\xe2\xe3\xcf\xd3\r\n1 0 obj << /Title (${tag}) >> endobj\r\n`, 'latin1');
  const bin = Buffer.alloc(3000);
  for (let i = 0; i < bin.length; i++) bin[i] = (i * 37 + tag.length) & 0xff;
  return Buffer.concat([head, bin, Buffer.from('\r\n%%EOF', 'latin1')]); // no trailing \n on purpose
}

const PDF1 = pdfLike('report v1');
const PDF2 = pdfLike('report v2 — replaced');
const BIG_PNG = makePng(2400, 300, 7);   // wider than 1920 → resized + re-encoded as JPEG
const SMALL_PNG = makePng(40, 30, 3);
const SEED_IMG = makePng(64, 48, 11);

// ---------------------------------------------------------------------------
// helpers

const sel = (id) => `[data-testid="${id}"]`;
const rowSel = (p) => `${sel('files-row')}[data-path="${p}"]`;

async function waitView(page) {
  await page.waitForSelector('body[data-view-ready="files"]', { state: 'attached', timeout: 20000 });
  await page.waitForSelector(sel('files-dropzone'));
}

async function waitBatch(page, phase, timeout = 30000) {
  await page.waitForSelector(`${sel('files-batch')}[data-phase="${phase}"]`, { timeout });
}

async function waitNoOverlay(page) {
  await page.waitForSelector(sel('overlay'), { state: 'detached', timeout: 30000 });
}

async function setFiles(page, files) {
  await page.setInputFiles(sel('files-input'), files);
}

async function closeToasts(page) {
  await page.evaluate(() => document.querySelectorAll('.toast').forEach((t) => t.remove()));
}

async function noHorizontalScroll(page) {
  return page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
}

// ---------------------------------------------------------------------------
// unit-ish checks of the pure helpers (run in Node)

await test('gitignore matcher + folder normalization', async () => {
  const real = createIgnoreMatcher(fs.readFileSync(path.join(REPO_ROOT, '.gitignore'), 'utf8'));
  assert.equal(real('static/documents/undergraduate_thesis.pdf'), true);
  assert.equal(real('static/documents/other.pdf'), false);
  assert.equal(real('public/index.html'), true);
  const m = createIgnoreMatcher('# c\n*.log\n!keep.log\nbuild/\n/root.txt\ndocs/**/*.tmp\nsecret/**\n');
  assert.equal(m('a/b.log'), true);
  assert.equal(m('x/keep.log'), false);
  assert.equal(m('build/a.js'), true);
  assert.equal(m('src/build/a.js'), true);
  assert.equal(m('build'), false, 'trailing / matches directories only');
  assert.equal(m('root.txt'), true);
  assert.equal(m('x/root.txt'), false, 'leading / anchors to the repo root');
  assert.equal(m('docs/a/b/c.tmp'), true);
  assert.equal(m('docs/c.tmp'), true);
  assert.equal(m('secret/a/b.pdf'), true);
  assert.equal(m('# c'), false);
  assert.deepEqual(normalizeStaticDir('slides'), { dir: 'static/slides' });
  assert.deepEqual(normalizeStaticDir('/static/documents/'), { dir: 'static/documents' });
  assert.ok(normalizeStaticDir('admin').error);
  assert.ok(normalizeStaticDir('static/admin/x').error);
  assert.ok(normalizeStaticDir('a/../b').error);
  assert.ok(normalizeStaticDir('static').error);
});

// ---------------------------------------------------------------------------
// setup

console.log(`[e2e-files] output: ${OUT}`);
const mock = await startMock({
  siteDir: SITE_DIR,
  adminDir: ADMIN_DIR,
  runDelayMs: 400,
  seedFiles: { 'static/images/posts/demo/seed.png': SEED_IMG },
});
// a post that references a document → delete must warn
mock.setFile('content/posts/uses-report.md', '---\ntitle: "引用资料"\ndate: 2026-10-01\ndraft: false\n---\n\n见 [报告](/documents/report.pdf)。\n');
const t0 = Date.now();
await buildSite({ repoDir: REPO_ROOT, outDir: SITE_DIR, baseURL: mock.url + '/' });
console.log(`[e2e-files] site built in ${Date.now() - t0} ms; mock at ${mock.url}`);

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(mock.url).origin });
const page = await context.newPage();
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
const { blocked } = await openAdmin(page, mock, { path: '/admin/#/files' });
await waitView(page);

// ---------------------------------------------------------------------------

await test('empty 资料 folder shows an empty state + folder info', async () => {
  assert.ok(await page.isVisible(sel('files-empty')));
  // the page explains that PDFs open in the browser (also on Android / in WeChat)
  assert.match(await page.textContent(sel('files-viewer-note')), /PDF 会在网页里直接打开.*安卓手机和微信里也能看/);
  assert.match(await page.textContent(sel('files-viewer-note')), /复制预览链接/);
  const info = await page.textContent(sel('files-folder-info'));
  assert.match(info, /static\/documents\//);
  assert.match(info, /\/documents\//);
  assert.equal(await page.getAttribute(sel('files-folder-documents'), 'aria-selected'), 'true');
  assert.equal(await page.isChecked(sel('files-compress')), true, 'compression is on by default');
  await page.screenshot({ path: path.join(SHOTS, 'files-empty-desktop.png') });
});

await test('upload a PDF + a PNG (compressed) in one commit', async () => {
  const before = mock.commits.length;
  await setFiles(page, [
    { name: 'report.pdf', mimeType: 'application/pdf', buffer: PDF1 },
    { name: 'Chart Photo.png', mimeType: 'image/png', buffer: BIG_PNG },
  ]);
  await waitBatch(page, 'done');
  await waitNoOverlay(page);
  assert.equal(mock.commits.length, before + 1, 'exactly one commit for the batch');
  const c = mock.commits.at(-1);
  assert.equal(c.message, 'admin: 上传资料 report.pdf 等 2 个文件');
  const pdf = mock.readBytes('static/documents/report.pdf');
  assert.ok(pdf, 'pdf uploaded');
  assert.ok(pdf.equals(PDF1), 'pdf bytes are exact');
  // opaque PNG wider than 1920 → compressed, re-encoded as JPEG and renamed
  assert.equal(mock.readBytes('static/documents/Chart-Photo.png'), undefined);
  const jpg = mock.readBytes('static/documents/Chart-Photo.jpg');
  assert.ok(jpg, 'compressed image uploaded as .jpg');
  assert.deepEqual([...jpg.subarray(0, 3)], [0xff, 0xd8, 0xff], 'valid JPEG');
  const size = jpegSize(jpg);
  assert.equal(size.width, 1920);
  assert.equal(size.height, 240);
  assert.ok(jpg.length < BIG_PNG.length, 'smaller than the original');
  // per-file status in the batch card
  const statuses = await page.$$eval(sel('files-batch-item'), (els) => els.map((e) => [e.dataset.name, e.dataset.status]));
  assert.deepEqual(statuses, [['report.pdf', 'done'], ['Chart-Photo.jpg', 'done']]);
  assert.match(await page.textContent(sel('files-batch')), /原名 Chart Photo\.png/);
  // 复制 in the batch card: the PDF gives its preview link, the image its file link
  const batchItem = (name) => `${sel('files-batch-item')}[data-name="${name}"] ${sel('files-batch-copy')}`;
  assert.match(await page.textContent(batchItem('report.pdf')), /复制预览链接/);
  assert.match(await page.textContent(batchItem('Chart-Photo.jpg')), /^复制链接$/);
  await page.click(batchItem('report.pdf'));
  await page.waitForFunction(async () => /\/viewer\//.test(await navigator.clipboard.readText()));
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), mock.url + '/viewer/?file=%2Fdocuments%2Freport.pdf');
  await page.click(batchItem('Chart-Photo.jpg'));
  await page.waitForFunction(async () => /Chart-Photo\.jpg$/.test(await navigator.clipboard.readText()));
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), mock.url + '/documents/Chart-Photo.jpg');
  await page.screenshot({ path: path.join(SHOTS, 'files-uploaded-desktop.png'), fullPage: true });
});

await test('list shows both files with /documents/… links', async () => {
  await page.waitForSelector(rowSel('static/documents/report.pdf'));
  const rows = await page.$$eval(sel('files-row'), (els) => els.map((e) => ({
    path: e.dataset.path,
    name: e.querySelector('[data-testid="files-name"]').textContent,
    link: e.querySelector('[data-testid="files-link"]').textContent,
    open: e.querySelector('[data-testid="files-open"]').getAttribute('href'),
    preview: !!e.querySelector('[data-testid="files-copy-preview"]'),
    copyLabel: e.querySelector('[data-testid="files-copy"]').textContent,
  })));
  assert.deepEqual(rows.map((r) => r.link), ['/documents/Chart-Photo.jpg', '/documents/report.pdf']);
  assert.equal(rows[1].name, 'report.pdf');
  // PDF: 「打开」 opens the online viewer; 「复制预览链接」 is offered, 「复制文件链接」 stays
  assert.equal(rows[1].open, mock.url + '/viewer/?file=%2Fdocuments%2Freport.pdf');
  assert.equal(rows[1].preview, true);
  assert.equal(rows[1].copyLabel, '复制文件链接');
  // image: the direct file link (displays everywhere)
  assert.equal(rows[0].open, mock.url + '/documents/Chart-Photo.jpg');
  assert.equal(rows[0].preview, false);
  assert.equal(rows[0].copyLabel, '复制链接');
  // the preview button comes first (primary action)
  const order = await page.$$eval(`${rowSel('static/documents/report.pdf')} .files-actions > *`, (els) => els.map((e) => e.dataset.testid));
  assert.deepEqual(order, ['files-copy-preview', 'files-copy', 'files-open', 'files-delete']);
  assert.match(await page.textContent(sel('files-count')), /共 2 个文件/);
  // image row gets a thumbnail read from the repo
  await page.waitForSelector(`${rowSel('static/documents/Chart-Photo.jpg')} .files-thumb img`, { timeout: 10000 });
});

await test('search filters by name', async () => {
  await page.fill(sel('files-search'), 'chart');
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="files-row"]').length === 1);
  assert.equal(await page.getAttribute(sel('files-row'), 'data-path'), 'static/documents/Chart-Photo.jpg');
  await page.fill(sel('files-search'), 'nothing-like-this');
  await page.waitForSelector(sel('files-empty'));
  assert.match(await page.textContent(sel('files-empty')), /没有找到/);
  await page.fill(sel('files-search'), '');
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="files-row"]').length === 2);
});

await test('copy link copies the full URL', async () => {
  await closeToasts(page);
  await page.click(`${rowSel('static/documents/report.pdf')} ${sel('files-copy')}`);
  await page.waitForSelector(sel('toast-success'));
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  assert.equal(clip, mock.url + '/documents/report.pdf');
});

await test('复制预览链接 copies the online viewer URL (file param fully encoded)', async () => {
  await closeToasts(page);
  await page.click(`${rowSel('static/documents/report.pdf')} ${sel('files-copy-preview')}`);
  await page.waitForSelector(sel('toast-success'));
  assert.match(await page.textContent(sel('toast-success')), /已复制预览链接/);
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  assert.equal(clip, mock.url + '/viewer/?file=%2Fdocuments%2Freport.pdf');
  const u = new URL(clip);
  assert.equal(u.origin, mock.url);
  assert.equal(u.pathname, '/viewer/');
  assert.equal(u.searchParams.get('file'), '/documents/report.pdf');
  // the file link is still there and unchanged
  await closeToasts(page);
  await page.click(`${rowSel('static/documents/report.pdf')} ${sel('files-copy')}`);
  await page.waitForSelector(sel('toast-success'));
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), mock.url + '/documents/report.pdf');
});

await test('uploading the same name asks before replacing (cancel, then replace)', async () => {
  const before = mock.commits.length;
  await setFiles(page, [{ name: 'report.pdf', mimeType: 'application/pdf', buffer: PDF2 }]);
  await page.waitForSelector(sel('files-warn-overwrite'));
  assert.match(await page.textContent(sel('files-warn-overwrite')), /已经存在/);
  await page.click(sel('confirm-cancel'));
  await waitBatch(page, 'cancelled');
  assert.equal(mock.commits.length, before, 'cancel uploads nothing');
  assert.ok(mock.readBytes('static/documents/report.pdf').equals(PDF1));
  assert.match(await page.textContent(sel('files-batch-banner')), /没有上传任何文件/);

  await setFiles(page, [{ name: 'report.pdf', mimeType: 'application/pdf', buffer: PDF2 }]);
  await page.waitForSelector(sel('files-warn-overwrite'));
  assert.equal((await page.textContent(sel('confirm-ok'))).trim(), '替换并上传');
  await page.click(sel('confirm-ok'));
  await waitBatch(page, 'done');
  await waitNoOverlay(page);
  assert.equal(mock.commits.length, before + 1);
  assert.equal(mock.commits.at(-1).message, 'admin: 上传资料 report.pdf');
  assert.ok(mock.readBytes('static/documents/report.pdf').equals(PDF2), 'replaced byte-exact');
});

await test('.gitignore’d file: confirm, cancel uploads nothing', async () => {
  const before = mock.commits.length;
  await setFiles(page, [{ name: 'undergraduate_thesis.pdf', mimeType: 'application/pdf', buffer: pdfLike('thesis') }]);
  await page.waitForSelector(sel('files-warn-gitignore'));
  const text = await page.textContent(sel('files-warn-gitignore'));
  assert.match(text, /这个文件在 \.gitignore 里（你原本不打算公开它），确定要上传吗？/);
  assert.match(text, /static\/documents\/undergraduate_thesis\.pdf/);
  await page.waitForTimeout(350); // let the modal animation finish
  await page.screenshot({ path: path.join(SHOTS, 'files-gitignore-confirm.png') });
  await page.click(sel('confirm-cancel'));
  await waitBatch(page, 'cancelled');
  assert.equal(mock.commits.length, before);
  assert.equal(mock.readBytes('static/documents/undergraduate_thesis.pdf'), undefined);
});

await test('≥ 25 MB file dropped: warning, cancel uploads nothing', async () => {
  const before = mock.commits.length;
  const reqBefore = mock.requests.filter((r) => r.method === 'POST').length;
  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array(26 * 1024 * 1024)], '大视频.mp4', { type: 'video/mp4' }));
    const dz = document.querySelector('[data-testid="files-dropzone"]');
    dz.dispatchEvent(new DragEvent('dragenter', { dataTransfer: dt, bubbles: true, cancelable: true }));
    dz.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }));
    dz.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  });
  await page.waitForSelector(sel('files-warn-large'));
  const text = await page.textContent(sel('files-warn-large'));
  assert.match(text, /超过 25 MB/);
  assert.match(text, /大视频\.mp4/);
  assert.match(text, /26 MB/);
  await page.click(sel('confirm-cancel'));
  await waitBatch(page, 'cancelled');
  assert.equal(mock.commits.length, before);
  assert.equal(mock.requests.filter((r) => r.method === 'POST').length, reqBefore, 'no blob was even created');
  assert.equal(mock.readBytes('static/documents/大视频.mp4'), undefined);
});

await test('delete a file (warns about the referencing post)', async () => {
  await page.click(sel('files-batch-close'));
  await page.click(`${rowSel('static/documents/report.pdf')} ${sel('files-delete')}`);
  await page.waitForSelector(sel('confirm-ok'));
  await page.waitForSelector(sel('files-delete-refs'));
  assert.match(await page.textContent(sel('files-delete-refs')), /content\/posts\/uses-report\.md/);
  await page.click(sel('confirm-ok'));
  await waitNoOverlay(page);
  await page.waitForSelector(rowSel('static/documents/report.pdf'), { state: 'detached' });
  assert.equal(mock.readBytes('static/documents/report.pdf'), undefined, 'gone from the repo');
  assert.equal(mock.commits.at(-1).message, 'admin: 删除资料 report.pdf');
  assert.deepEqual(mock.commits.at(-1).changes, [{ path: 'static/documents/report.pdf', status: 'removed' }]);
  assert.ok(mock.readBytes('static/documents/Chart-Photo.jpg'), 'other file untouched');
});

const VIEWER_DOC = 'static/documents/讲义 第2章 (下).pdf';
const VIEWER_SITE_PATH = '/documents/讲义 第2章 (下).pdf';
const REF_POSTS = {
  // only an absolute viewer link (what 「复制预览链接」 gives), English UI
  'content/posts/uses-viewer-link.md': `---\ntitle: "预览链接"\ndate: 2026-10-02\ndraft: false\n---\n\n讲义见 [第2章](${viewerUrlFor(VIEWER_SITE_PATH, { absolute: true, siteUrl: 'https://himzfx.github.io/', lang: 'en' })})。\n`,
  // only the embed shortcode
  'content/posts/uses-embed.md': `---\ntitle: "嵌入阅读器"\ndate: 2026-10-03\ndraft: false\n---\n\n第2章：\n\n{{< pdf "${VIEWER_SITE_PATH}" >}}\n`,
  // a viewer link to a different file must not count
  'content/posts/other-viewer.md': `---\ntitle: "别的资料"\ndate: 2026-10-04\ndraft: false\n---\n\n[第3章](${viewerUrlFor('/documents/讲义 第3章 (下).pdf')})\n`,
};
const HAS_PDF_SHORTCODE = fs.existsSync(path.join(REPO_ROOT, 'layouts', 'shortcodes', 'pdf.html'));

await test('delete warns about posts that reference the file only via a viewer link or {{< pdf >}}', async () => {
  mock.setFiles({ [VIEWER_DOC]: '%PDF-1.4 chapter 2\n', ...REF_POSTS });
  await page.reload();
  await waitView(page);
  await page.waitForSelector(rowSel(VIEWER_DOC));
  // the preview link of a name with spaces / parentheses / Chinese
  assert.equal(await page.getAttribute(`${rowSel(VIEWER_DOC)} ${sel('files-open')}`, 'href'),
    mock.url + '/viewer/?file=%2Fdocuments%2F%E8%AE%B2%E4%B9%89%20%E7%AC%AC2%E7%AB%A0%20%28%E4%B8%8B%29.pdf');
  const before = mock.commits.length;
  await page.click(`${rowSel(VIEWER_DOC)} ${sel('files-delete')}`);
  await page.waitForSelector(sel('confirm-ok'));
  await page.waitForSelector(sel('files-delete-refs'));
  const refs = await page.textContent(sel('files-delete-refs'));
  assert.match(refs, /有 2 篇文章或页面引用了它/);
  assert.match(refs, /content\/posts\/uses-viewer-link\.md/);
  assert.match(refs, /content\/posts\/uses-embed\.md/);
  assert.doesNotMatch(refs, /other-viewer/);
  await page.click(sel('confirm-cancel'));
  await page.waitForSelector(sel('confirm-cancel'), { state: 'detached' });
  assert.equal(mock.commits.length, before, 'cancelled delete commits nothing');
  assert.ok(mock.readBytes(VIEWER_DOC));
  if (!HAS_PDF_SHORTCODE) {
    // the site's {{< pdf >}} shortcode is not in this checkout → keep the final Hugo build working
    mock.setFiles({ 'content/posts/uses-embed.md': null });
  }
});

await test('re-upload report.pdf via drag & drop (kept for the build check)', async () => {
  await page.evaluate((b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], 'report.pdf', { type: 'application/pdf' }));
    document.querySelector('[data-testid="files-dropzone"]').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  }, PDF1.toString('base64'));
  await waitBatch(page, 'done');
  await waitNoOverlay(page);
  assert.ok(mock.readBytes('static/documents/report.pdf').equals(PDF1));
});

await test('图片 folder lists static/images files; upload without compression is byte-exact', async () => {
  await page.click(sel('files-folder-images'));
  await page.waitForFunction(() => /dir=static%2Fimages/.test(location.hash));
  await waitView(page);
  assert.equal(await page.getAttribute(sel('files-folder-images'), 'aria-selected'), 'true');
  await page.waitForSelector(rowSel('static/images/posts/demo/seed.png'));
  assert.equal(await page.textContent(`${rowSel('static/images/posts/demo/seed.png')} ${sel('files-link')}`), '/images/posts/demo/seed.png');
  assert.match(await page.textContent(sel('files-group')), /posts\/demo\//);
  await page.waitForSelector(`${rowSel('static/images/posts/demo/seed.png')} .files-thumb img`, { timeout: 10000 });

  await page.uncheck(sel('files-compress'));
  await setFiles(page, [{ name: 'logo.png', mimeType: 'image/png', buffer: SMALL_PNG }]);
  await waitBatch(page, 'done');
  await waitNoOverlay(page);
  assert.ok(mock.readBytes('static/images/logo.png').equals(SMALL_PNG), 'unchanged PNG when compression is off');
  await page.waitForSelector(rowSel('static/images/logo.png'));
  await page.check(sel('files-compress'));
  await page.screenshot({ path: path.join(SHOTS, 'files-images-desktop.png') });
});

await test('custom folder chooser: admin/ refused, new folder opens', async () => {
  await page.click(sel('files-folder-other'));
  await page.waitForSelector(sel('files-folder-input'));
  const options = await page.$$eval(sel('files-folder-option'), (els) => els.map((e) => e.dataset.dir));
  assert.ok(options.includes('static/images/posts'), 'existing folders listed');
  assert.ok(!options.some((d) => d.startsWith('static/admin')), 'admin/ never offered');
  await page.fill(sel('files-folder-input'), 'admin');
  await page.click(sel('files-folder-go'));
  assert.match(await page.textContent(sel('files-folder-error')), /admin/);
  await page.fill(sel('files-folder-input'), 'slides/2026');
  await page.click(sel('files-folder-go'));
  await page.waitForFunction(() => /dir=static%2Fslides%2F2026/.test(location.hash));
  await waitView(page);
  assert.match(await page.textContent(sel('files-folder-custom')), /slides\/2026/);
  assert.ok(await page.isVisible(sel('files-empty')));
  // a hand-made URL pointing into admin/ falls back to 资料
  await page.evaluate(() => { location.hash = '#/files?dir=static/admin/js'; });
  await page.waitForFunction(() => document.querySelector('[data-testid="files-folder-documents"]')?.getAttribute('aria-selected') === 'true');
  await page.waitForSelector(sel('toast-warning'));
});

await test('conflict (file changed on GitHub meanwhile) → reload → 重新上传 works; API error → 重新上传', async () => {
  await page.waitForSelector(rowSel('static/documents/report.pdf'));
  mock.setFile('static/documents/report.pdf', 'changed elsewhere');
  const before = mock.commits.length;
  await setFiles(page, [{ name: 'report.pdf', mimeType: 'application/pdf', buffer: PDF1 }]);
  await page.waitForSelector(sel('files-warn-overwrite'));
  await page.click(sel('confirm-ok'));
  await page.waitForSelector(sel('conflict-reload'));
  await page.click(sel('conflict-reload'));
  await waitBatch(page, 'conflict');
  assert.equal(mock.commits.length, before, 'nothing committed on conflict');
  assert.equal(mock.readFile('static/documents/report.pdf'), 'changed elsewhere');
  assert.match(await page.textContent(sel('files-batch-banner')), /重新上传/);
  await page.click(sel('files-retry'));
  await page.waitForSelector(sel('files-warn-overwrite'));
  await page.click(sel('confirm-ok'));
  await waitBatch(page, 'done');
  await waitNoOverlay(page);
  assert.ok(mock.readBytes('static/documents/report.pdf').equals(PDF1));

  // a server error keeps the batch so the user can retry without re-selecting files
  mock.failNext({ method: 'POST', path: '/git/blobs' }, { status: 500, times: 1 });
  await setFiles(page, [{ name: 'flaky.pdf', mimeType: 'application/pdf', buffer: pdfLike('flaky') }]);
  await waitBatch(page, 'failed');
  await waitNoOverlay(page);
  assert.equal(await page.getAttribute(sel('files-batch-item'), 'data-status'), 'failed');
  assert.equal(mock.readBytes('static/documents/flaky.pdf'), undefined);
  await page.click(sel('files-retry'));
  await waitBatch(page, 'done');
  await waitNoOverlay(page);
  assert.ok(mock.readBytes('static/documents/flaky.pdf').equals(pdfLike('flaky')));
});

await test('mobile layout (390×844 and 360 wide): no horizontal scroll', async () => {
  const m = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  m.on('pageerror', (e) => pageErrors.push(e.message));
  await openAdmin(m, mock, { path: '/admin/#/files' });
  await waitView(m);
  await m.waitForSelector(rowSel('static/documents/report.pdf'));
  assert.ok(await noHorizontalScroll(m), 'no horizontal scroll at 390');
  await m.screenshot({ path: path.join(SHOTS, 'files-mobile.png'), fullPage: true });
  // upload panel on mobile
  await m.setInputFiles(sel('files-input'), [{ name: 'notes-for-the-seminar-with-a-long-name.pdf', mimeType: 'application/pdf', buffer: pdfLike('m') }]);
  await waitBatch(m, 'done');
  await waitNoOverlay(m);
  await m.evaluate(() => window.scrollTo(0, 0));
  await m.screenshot({ path: path.join(SHOTS, 'files-mobile-uploaded.png'), fullPage: true });
  await m.setViewportSize({ width: 360, height: 740 });
  assert.ok(await noHorizontalScroll(m), 'no horizontal scroll at 360');
  // desktop action buttons are hidden; the ⋯ sheet offers copy preview / copy file / open / delete
  assert.equal(await m.isVisible(`${rowSel('static/documents/report.pdf')} ${sel('files-delete')}`), false);
  await m.click(`${rowSel('static/documents/report.pdf')} ${sel('files-more')}`);
  await m.waitForSelector(sel('files-sheet-delete'));
  assert.equal(await m.getAttribute(sel('files-sheet-open'), 'href'), mock.url + '/viewer/?file=%2Fdocuments%2Freport.pdf');
  const sheetItems = await m.$$eval('.files-sheet-item', (els) => els.map((e) => [e.dataset.testid, e.textContent]));
  assert.deepEqual(sheetItems, [
    ['files-sheet-copy-preview', '复制预览链接'],
    ['files-sheet-copy', '复制文件链接'],
    ['files-sheet-open', '在线预览'],
    ['files-sheet-delete', '删除'],
  ]);
  assert.match(await m.textContent('.files-sheet'), /安卓手机和微信里也能看/);
  await m.waitForTimeout(350);
  await m.screenshot({ path: path.join(SHOTS, 'files-mobile-action-sheet.png') });
  await m.click(sel('files-sheet-delete'));
  await m.waitForSelector(sel('confirm-cancel'));
  await m.waitForTimeout(350);
  await m.screenshot({ path: path.join(SHOTS, 'files-mobile-delete-confirm.png') });
  const before = mock.commits.length;
  await m.click(sel('confirm-cancel'));
  await m.waitForSelector(sel('confirm-cancel'), { state: 'detached' });
  assert.equal(mock.commits.length, before, 'cancelled delete commits nothing');
  assert.ok(mock.readBytes('static/documents/report.pdf'));
  await m.close();
});

await test('exported repo builds and serves /documents/<file>', async () => {
  mock.exportTo(EXPORT_DIR);
  await buildSite({ repoDir: EXPORT_DIR, outDir: BUILD2_DIR, baseURL: mock.url + '/' });
  const served = fs.readFileSync(path.join(BUILD2_DIR, 'documents', 'report.pdf'));
  assert.ok(served.equals(PDF1), 'report.pdf served byte-exact');
  assert.ok(fs.existsSync(path.join(BUILD2_DIR, 'documents', 'Chart-Photo.jpg')));
  assert.ok(fs.readFileSync(path.join(BUILD2_DIR, 'images', 'logo.png')).equals(SMALL_PNG));
  assert.ok(!fs.existsSync(path.join(BUILD2_DIR, 'documents', 'undergraduate_thesis.pdf')));
  // the post with the absolute viewer link keeps it (Hugo may escape & as &amp;)
  const viewerPost = fs.readFileSync(path.join(BUILD2_DIR, 'posts', 'uses-viewer-link', 'index.html'), 'utf8');
  assert.ok(viewerPost.includes('https://himzfx.github.io/viewer/?file=%2Fdocuments%2F%E8%AE%B2%E4%B9%89%20%E7%AC%AC2%E7%AB%A0%20%28%E4%B8%8B%29.pdf'), 'viewer link survives the build');
  if (HAS_PDF_SHORTCODE) {
    const embedPost = fs.readFileSync(path.join(BUILD2_DIR, 'posts', 'uses-embed', 'index.html'), 'utf8');
    assert.match(embedPost, /<iframe[^>]+\/viewer\/\?file=%2[Ff]documents%2[Ff]/, 'the {{< pdf >}} shortcode renders the embedded viewer');
  } else {
    console.log('    (layouts/shortcodes/pdf.html not present: skipped the {{< pdf >}} build check)');
  }
});

await test('no page errors, nothing left the mock origin except blocked CDNs', async () => {
  assert.deepEqual(pageErrors, []);
  const bad = blocked.filter((u) => !/cdn\.jsdelivr\.net|github\.io/.test(u));
  assert.deepEqual(bad, [], 'unexpected external requests');
});

await browser.close();
await mock.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n[e2e-files] ${results.length - failed.length}/${results.length} passed; screenshots in ${SHOTS}`);
process.exit(failed.length ? 1 : 0);
