// tests/admin/e2e-courses-site.mjs — end-to-end test of the website side of 课程资料 (course units):
//   layouts/courses/{list,single}.html, layouts/partials/courses/*, layouts/partials/post_nav_links.html,
//   i18n/{zh,en}.yaml, assets/css/extended/courses.css.
//
// The real content/ is never touched: fixtures are seeded into the mock GitHub (seedFiles, existing
// course folders removed so the result does not depend on the user's real courses), exported, and built
// with the pinned Hugo. Two variants are built:
//   grouped  two custom groups whose weights interleave (理论课 15/40, 实验课 20/30) + one ungrouped
//            course with the smallest weight (→ still in the final 其他 group)
//   plain    the same courses without any group → one plain list, no headings (weight tie → title)
// Fixture courses:
//   modern-lab   3 sub-posts (weights 30/10/20, i.e. not in file order) + a draft sub-post, 4 materials
//                (pdf, png, docx, "实验 报告 1.pdf") + a dotfile, an _index.en.md override (own English group)
//   optics       only materials (no sub-posts)
//   quantum      _index.en.md with title/description only (group + weight fall back to the shared file)
//   electronics  nothing at all (no intro, no sub-posts, no materials) → empty note
//   seminar      no group
//
// Run from the repo root:   node tests/admin/e2e-courses-site.mjs
// Env:
//   COURSES_SITE_E2E_DIR  where exports, builds and screenshots go
//                         (default: $ADMIN_TEST_TMP/e2e-courses-site or <os tmp>/admin-e2e-courses-site)
//   HUGO_BIN              Hugo binary (see mock-github.mjs)
//   ONLY=<substr>         run only tests whose name contains this

import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startMock, buildSite, hugoBin, REPO_ROOT } from './mock-github.mjs';
import { parseFileParam } from '../../static/viewer/path.js';

let chromium;
try {
  ({ chromium } = createRequire(import.meta.url)('playwright'));
} catch {
  console.log('SKIP: Playwright is not available');
  process.exit(0);
}
if (!fs.existsSync(hugoBin())) {
  console.log(`SKIP: Hugo not found at ${hugoBin()} (set HUGO_BIN)`);
  process.exit(0);
}

const OUT = path.resolve(process.env.COURSES_SITE_E2E_DIR
  || (process.env.ADMIN_TEST_TMP ? path.join(process.env.ADMIN_TEST_TMP, 'e2e-courses-site') : path.join(os.tmpdir(), 'admin-e2e-courses-site')));
const SHOTS = path.join(OUT, 'screenshots');
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
// fixtures

const C = '/documents/courses';
const MAT = {
  docx: `${C}/modern-lab/data.docx`,
  handout: `${C}/modern-lab/handout.pdf`,
  png: `${C}/modern-lab/spectrum.png`,
  cjk: `${C}/modern-lab/实验 报告 1.pdf`,
};

/** A small but valid PNG (solid colour, w×h). */
function png(w, h, [r, g, b]) {
  const zlib = createRequire(import.meta.url)('node:zlib');
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const x of buf) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: w }, () => [r, g, b]).flat())]);
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const fm = (obj) => '---\n' + Object.entries(obj).map(([k, v]) => `${k}: ${typeof v === 'string' ? JSON.stringify(v) : v}`).join('\n') + '\n---\n';

/** Seed files for one variant. `grouped` adds the group keys; the plain variant also makes a weight tie. */
function fixtureFiles({ grouped, pdfs }) {
  const g = (name) => (grouped ? { group: name } : {});
  const files = {
    'content/courses/modern-lab/_index.md': fm({ title: '近代物理实验', description: '大三下学期，每个实验一篇，附实验报告。', ...g('实验课'), weight: 20 })
      + '\n这门课一共做了十几个实验，这里挑了几个整理成文。\n',
    'content/courses/modern-lab/_index.en.md': fm({ title: 'Modern Physics Lab', description: 'One post per experiment, with the lab report.', ...(grouped ? { group: 'Labs' } : {}), weight: 20 })
      + '\nA few of the experiments, written up.\n',
    // file order: franck-hertz < millikan < zeeman < z-draft; weight order: millikan(10) zeeman(20) franck-hertz(30)
    'content/courses/modern-lab/franck-hertz.md': fm({ title: '弗兰克-赫兹实验', weight: 30, description: '测量汞原子的第一激发电位', draft: false })
      + `\n实验报告：\n\n{{< pdf "${MAT.cjk}" >}}\n`,
    'content/courses/modern-lab/millikan.md': fm({ title: '密立根油滴实验', weight: 10, date: '2025-03-01T10:00:00+08:00', draft: false })
      + `\n原始数据见 [data.docx](${MAT.docx})。${'正文很长。'.repeat(80)}\n`,
    'content/courses/modern-lab/zeeman.md': fm({ title: '塞曼效应', weight: 20, description: '用法布里-珀罗标准具观察汞 546.1 nm 谱线的分裂', draft: false })
      + `\n![光谱](${encodeURI(MAT.png)})\n`,
    'content/courses/modern-lab/z-draft.md': fm({ title: '还没写完的实验', weight: 15, draft: true })
      + `\n{{< pdf "${MAT.handout}" >}}\n`,
    'static/documents/courses/modern-lab/.gitkeep': '',
    ['static' + MAT.docx]: Buffer.alloc(52000, 7),
    ['static' + MAT.handout]: pdfs.handout,
    ['static' + MAT.png]: png(64, 40, [40, 120, 200]),
    ['static' + MAT.cjk]: pdfs.cjk,

    'content/courses/optics/_index.md': fm({ title: '光学', description: '笔记与期末复习', ...g('理论课'), weight: grouped ? 40 : 20 })
      + '\n赵凯华《光学》的读书笔记。\n',
    'static/documents/courses/optics/期末复习.pdf': pdfs.handout,
    'static/documents/courses/optics/习题.txt': '1. 2. 3.\n',

    'content/courses/quantum/_index.md': fm({ title: '量子力学', description: '曾谨言教材的习题解答', ...g('理论课'), weight: 15 }),
    'content/courses/quantum/_index.en.md': fm({ title: 'Quantum Mechanics', description: 'Solutions to the exercises' }),
    'content/courses/quantum/ch1.md': fm({ title: '第一章 波函数', weight: 10 }) + '\n内容\n',

    'content/courses/electronics/_index.md': fm({ title: '现代电子学实验', ...g('实验课'), weight: 30 }),
    'content/courses/electronics/_index.en.md': fm({ title: 'Modern Electronics Lab', ...(grouped ? { group: 'Labs' } : {}), weight: 30 }),

    'content/courses/seminar/_index.md': fm({ title: '平衡态统计物理讨论班', description: '讨论班的报告幻灯片', weight: 5 }),
  };
  // Remove the user's real course folders (keep content/courses/_index*.md) so the order is deterministic.
  const tracked = execFileSync('git', ['-C', REPO_ROOT, 'ls-files', '-z', '--cached', '--others', '--exclude-standard', 'content/courses', 'static/documents/courses'])
    .toString('utf8').split('\0').filter(Boolean);
  for (const p of tracked) if (!/^content\/courses\/_index(\.[a-z-]+)?\.md$/.test(p) && !(p in files)) files[p] = null;
  return files;
}

async function makePdfs(browser) {
  const page = await browser.newPage();
  const mk = async (title, n) => {
    await page.setContent(`<html><body style="font:28px serif">${Array.from({ length: n }, (_, i) => `<section style="page-break-after:always"><h1>${title}</h1><p>第 ${i + 1} 页</p></section>`).join('')}</body></html>`);
    return Buffer.from(await page.pdf({ format: 'A4' }));
  };
  const pdfs = { handout: await mk('讲义 Handout', 2), cjk: await mk('实验报告 弗兰克-赫兹', 3) };
  await page.close();
  return pdfs;
}

async function buildVariant(name, opts) {
  const dir = path.join(OUT, name);
  const mock = await startMock({ seedFiles: fixtureFiles(opts), siteDir: path.join(dir, 'site') });
  const exportDir = mock.exportTo(path.join(dir, 'export'));
  const built = await buildSite({ repoDir: exportDir, outDir: path.join(dir, 'site'), baseURL: mock.url + '/' });
  return { mock, exportDir, siteDir: path.join(dir, 'site'), built };
}

// ---------------------------------------------------------------------------
// page helpers

async function newPage(context, origins) {
  const page = await context.newPage();
  const problems = [];
  page.on('pageerror', (e) => problems.push(String(e)));
  // KaTeX / fonts / giscus come from CDNs: never leave the machine.
  await page.route('**/*', (route) => (origins.includes(new URL(route.request().url()).origin) ? route.continue() : route.abort()));
  page.problems = problems;
  return page;
}

const texts = (page, sel) => page.$$eval(sel, (els) => els.map((e) => e.textContent.replace(/\s+/g, ' ').trim()));

/** Everything a test needs to know about a course unit page. */
const unitInfo = (page) => page.evaluate(() => {
  const q = (s) => document.querySelector(s);
  return {
    crumbs: [...document.querySelectorAll('.course-breadcrumbs > *')].filter((e) => !e.classList.contains('course-breadcrumbs-sep'))
      .map((e) => ({ text: e.textContent.trim(), href: e.getAttribute('href'), current: e.getAttribute('aria-current') })),
    h1: q('main h1')?.textContent.trim(),
    intro: q('.course-intro')?.textContent.trim() || '',
    sections: [...document.querySelectorAll('.course-section-title')].map((e) => e.textContent.trim()),
    posts: [...document.querySelectorAll('.course-post')].map((li) => ({
      title: li.querySelector('.course-post-title').textContent.trim(),
      href: li.querySelector('.course-post-title a').getAttribute('href'),
      desc: li.querySelector('.course-post-desc')?.textContent.trim() || '',
    })),
    files: [...document.querySelectorAll('.course-material')].map((li) => ({
      name: li.querySelector('.course-material-name').textContent.trim(),
      href: li.querySelector('.course-material-name').getAttribute('href'),
      download: li.querySelector('.course-material-name').getAttribute('download'),
      ext: li.querySelector('.course-material-ext').textContent.trim(),
      size: li.querySelector('.course-material-size').textContent.trim(),
      used: li.querySelector('.course-material-post a') ? {
        label: li.querySelector('.course-material-post').firstChild.textContent.trim(),
        title: li.querySelector('.course-material-post a').textContent.trim(),
        href: li.querySelector('.course-material-post a').getAttribute('href'),
      } : null,
      dl: li.querySelector('.course-material-download')?.getAttribute('href') || null,
      dlText: li.querySelector('.course-material-download')?.textContent.trim() || null,
    })),
    empty: q('.course-empty')?.textContent.trim() || null,
    hasDate: !!document.querySelector('main time, main .post-meta, main .entry-footer'),
    text: q('main').innerText,
  };
});

const landingInfo = (page) => page.evaluate(() => ({
  introBeforeCards: (() => {
    const intro = document.querySelector('main .post-content');
    const idx = document.querySelector('.course-index');
    return !!intro && !!idx && !!(intro.compareDocumentPosition(idx) & Node.DOCUMENT_POSITION_FOLLOWING);
  })(),
  introText: document.querySelector('main .post-content')?.textContent || '',
  groups: [...document.querySelectorAll('.course-group')].map((s) => ({
    title: s.querySelector('.course-group-title').textContent.trim(),
    cards: [...s.querySelectorAll('.course-card-title')].map((e) => e.textContent.trim()),
  })),
  groupTitles: document.querySelectorAll('.course-group-title').length,
  lists: document.querySelectorAll('.course-list').length,
  cards: [...document.querySelectorAll('.course-card')].map((li) => ({
    title: li.querySelector('.course-card-title').textContent.trim(),
    tag: li.querySelector('.course-card-title').tagName,
    href: li.querySelector('.course-card-title a').getAttribute('href'),
    desc: li.querySelector('.course-card-desc')?.textContent.trim() || '',
    meta: li.querySelector('.course-card-meta')?.textContent.trim() || '',
  })),
  hasDate: !!document.querySelector('main time, main .post-meta, main .entry-footer'),
  crumbs: document.querySelectorAll('.course-breadcrumbs').length,
}));

const navInfo = (page) => page.evaluate(() => {
  const a = (s) => {
    const e = document.querySelector(s);
    return e ? { href: new URL(e.href).pathname, title: e.querySelector('span:last-child').textContent.trim(), label: e.querySelector('.title').textContent.trim() } : null;
  };
  return {
    prev: a('.course-paginav a.prev'),
    next: a('.course-paginav a.next'),
    navs: document.querySelectorAll('.paginav').length,
    crumbs: [...document.querySelectorAll('.course-breadcrumbs > *')].filter((e) => !e.classList.contains('course-breadcrumbs-sep'))
      .map((e) => ({ text: e.textContent.trim(), href: e.getAttribute('href') })),
    // as read aloud / seen: every item, separators included, one space apart (the gap is CSS)
    crumbText: [...(document.querySelector('.course-breadcrumbs')?.children || [])].map((e) => e.textContent.trim()).join(' '),
    h1: document.querySelector('main h1')?.textContent.trim(),
    hasDate: !!document.querySelector('main time, main .post-meta'),
    text: document.querySelector('main').innerText,
  };
});

const noHScroll = (page) => page.evaluate(() => ({
  sw: document.documentElement.scrollWidth,
  cw: document.documentElement.clientWidth,
  wide: [...document.querySelectorAll('main *')].filter((e) => e.getBoundingClientRect().right > document.documentElement.clientWidth + 0.5)
    .slice(0, 5).map((e) => `${e.tagName}.${e.className}`),
}));

function fmtSize(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1048576) { const k = n / 1024; return k < 10 ? `${k.toFixed(1)} KB` : `${k.toFixed(0)} KB`; }
  const m = n / 1048576;
  return m < 10 ? `${m.toFixed(1)} MB` : `${m.toFixed(0)} MB`;
}

const viewerHref = (sitePath, lang) => '/viewer/?file=' + encodeURIComponent(sitePath) + (lang && lang !== 'zh' ? `&lang=${lang}` : '');
const fileHref = (sitePath) => sitePath.split('/').map((s) => encodeURIComponent(s)).join('/');

// ---------------------------------------------------------------------------

async function main() {
  console.log(`e2e-courses-site → ${OUT}`);
  const browser = await chromium.launch();
  const pdfs = await makePdfs(browser);

  const G = await buildVariant('grouped', { grouped: true, pdfs });
  const P = await buildVariant('plain', { grouped: false, pdfs });
  const origin = new URL(G.mock.url).origin;
  const origins = [origin, new URL(P.mock.url).origin];
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await newPage(ctx, origins);
  const go = async (p, v = G) => {
    const res = await page.goto(v.mock.url + p, { waitUntil: 'load' });
    return res.status();
  };

  await test('build: no Hugo warnings or errors', async () => {
    for (const v of [G, P]) {
      const out = (v.built.stdout + v.built.stderr).split('\n').filter((l) => /WARN|ERROR/.test(l));
      assert.deepEqual(out, []);
    }
  });

  // ---------------- landing ----------------

  await test('landing (grouped): user intro above the cards, groups in min-weight order, 其他 last', async () => {
    assert.equal(await go('/courses/'), 200);
    const L = await landingInfo(page);
    assert.ok(L.introBeforeCards, 'the intro from content/courses/_index.md comes before the cards');
    assert.match(L.introText, /资料使用说明/);
    assert.deepEqual(L.groups, [
      { title: '理论课', cards: ['量子力学', '光学'] },
      { title: '实验课', cards: ['近代物理实验', '现代电子学实验'] },
      { title: '其他', cards: ['平衡态统计物理讨论班'] },
    ]);
    assert.equal(L.crumbs, 0, 'no breadcrumbs on the landing page');
    assert.equal(L.hasDate, false);
    await page.screenshot({ path: path.join(SHOTS, 'landing-grouped-desktop.png'), fullPage: true });
  });

  await test('landing: cards show title, description, sub-post / material counts and link to the unit', async () => {
    await go('/courses/');
    const L = await landingInfo(page);
    const by = Object.fromEntries(L.cards.map((c) => [c.title, c]));
    assert.deepEqual(by['近代物理实验'], { title: '近代物理实验', tag: 'H3', href: '/courses/modern-lab/', desc: '大三下学期，每个实验一篇，附实验报告。', meta: '3 篇 · 4 份资料' });
    assert.equal(by['光学'].meta, '2 份资料');
    assert.equal(by['量子力学'].meta, '1 篇');
    assert.equal(by['现代电子学实验'].meta, '');
    assert.equal(by['现代电子学实验'].desc, '');
    // the whole card is clickable
    const box = await page.locator('.course-card:has-text("光学") .course-card-desc').boundingBox();
    await page.mouse.click(box.x + box.width - 4, box.y + box.height / 2);
    await page.waitForURL(/\/courses\/optics\/$/);
  });

  await test('landing (plain): no group → one list, no headings, weight then title', async () => {
    assert.equal(await go('/courses/', P), 200);
    const L = await landingInfo(page);
    assert.equal(L.groupTitles, 0);
    assert.equal(L.lists, 1);
    assert.deepEqual(L.groups, []);
    // optics and modern-lab both have weight 20 → by title (光学 before 近代物理实验)
    assert.deepEqual(L.cards.map((c) => c.title), ['平衡态统计物理讨论班', '量子力学', '光学', '近代物理实验', '现代电子学实验']);
    assert.ok(L.cards.every((c) => c.tag === 'H2'));
    assert.ok(L.introBeforeCards);
    await page.screenshot({ path: path.join(SHOTS, 'landing-plain-desktop.png'), fullPage: true });
  });

  // ---------------- course unit ----------------

  await test('unit page: breadcrumbs, intro, sub-post cards by weight, draft hidden, no dates', async () => {
    assert.equal(await go('/courses/modern-lab/'), 200);
    const U = await unitInfo(page);
    assert.deepEqual(U.crumbs, [
      { text: '课程资料', href: '/courses/', current: null },
      { text: '近代物理实验', href: null, current: 'page' },
    ]);
    assert.equal(U.h1, '近代物理实验');
    assert.match(U.intro, /挑了几个整理成文/);
    assert.deepEqual(U.sections, ['内容', '资料']);
    assert.deepEqual(U.posts, [
      { title: '密立根油滴实验', href: '/courses/modern-lab/millikan/', desc: '' },
      { title: '塞曼效应', href: '/courses/modern-lab/zeeman/', desc: '用法布里-珀罗标准具观察汞 546.1 nm 谱线的分裂' },
      { title: '弗兰克-赫兹实验', href: '/courses/modern-lab/franck-hertz/', desc: '测量汞原子的第一激发电位' },
    ]);
    assert.doesNotMatch(U.text, /还没写完/);
    assert.equal(U.hasDate, false);
    assert.doesNotMatch(U.text, /2025|分钟/);
    assert.equal(U.empty, null);
    await page.screenshot({ path: path.join(SHOTS, 'unit-desktop.png'), fullPage: true });
  });

  await test('unit page: materials list (sorted, viewer vs direct links, encoding, sizes, embedding sub-post)', async () => {
    await go('/courses/modern-lab/');
    const U = await unitInfo(page);
    const size = (p) => fmtSize(fs.statSync(path.join(G.exportDir, 'static', p)).size);
    assert.deepEqual(U.files, [
      { name: 'data.docx', href: fileHref(MAT.docx), download: 'data.docx', ext: 'DOCX', size: size(MAT.docx),
        used: { label: '收录于', title: '密立根油滴实验', href: '/courses/modern-lab/millikan/' }, dl: null, dlText: null },
      // referenced only by the draft → no "收录于"
      { name: 'handout.pdf', href: viewerHref(MAT.handout), download: null, ext: 'PDF', size: size(MAT.handout),
        used: null, dl: fileHref(MAT.handout), dlText: '下载' },
      { name: 'spectrum.png', href: viewerHref(MAT.png), download: null, ext: 'PNG', size: size(MAT.png),
        used: { label: '收录于', title: '塞曼效应', href: '/courses/modern-lab/zeeman/' }, dl: fileHref(MAT.png), dlText: '下载' },
      { name: '实验 报告 1.pdf', href: viewerHref(MAT.cjk), download: null, ext: 'PDF', size: size(MAT.cjk),
        used: { label: '收录于', title: '弗兰克-赫兹实验', href: '/courses/modern-lab/franck-hertz/' }, dl: fileHref(MAT.cjk), dlText: '下载' },
    ]);
    assert.equal(fileHref(MAT.cjk), '/documents/courses/modern-lab/%E5%AE%9E%E9%AA%8C%20%E6%8A%A5%E5%91%8A%201.pdf');
    assert.equal(size(MAT.docx), '51 KB');
    // every viewer link passes the viewer's own validation and points at a file that exists
    for (const f of U.files) {
      const target = f.href.startsWith('/viewer/') ? parseFileParam(new URL(f.href, origin).searchParams.get('file'), origin) : null;
      if (target) assert.ok(target.ok, f.href);
      const url = target ? target.href : f.href;
      const r = await page.request.get(origin + url);
      assert.equal(r.status(), 200, url);
      if (f.dl) assert.equal((await page.request.get(origin + f.dl)).status(), 200, f.dl);
    }
    assert.doesNotMatch(U.text, /gitkeep/);
  });

  await test('unit page: a visitor opens the CJK-named PDF from the materials list in the viewer', async () => {
    await go('/courses/modern-lab/');
    await page.click('.course-material-name:has-text("实验 报告 1.pdf")');
    await page.waitForURL(/\/viewer\/\?file=/);
    await page.waitForFunction(() => {
      const d = document.querySelector('.page[data-page-number="1"]');
      return d && d.classList.contains('rendered') && d.querySelector('canvas');
    }, null, { timeout: 30000 });
  });

  await test('unit page: course with only materials, and an empty course render cleanly', async () => {
    assert.equal(await go('/courses/optics/'), 200);
    let U = await unitInfo(page);
    assert.deepEqual(U.sections, ['资料']);
    assert.deepEqual(U.posts, []);
    assert.deepEqual(U.files.map((f) => [f.name, f.ext, f.href]), [
      ['习题.txt', 'TXT', fileHref(`${C}/optics/习题.txt`)],
      ['期末复习.pdf', 'PDF', viewerHref(`${C}/optics/期末复习.pdf`)],
    ]);
    assert.equal(U.empty, null);
    await page.screenshot({ path: path.join(SHOTS, 'unit-materials-only-desktop.png'), fullPage: true });

    assert.equal(await go('/courses/electronics/'), 200);
    U = await unitInfo(page);
    assert.deepEqual(U.sections, []);
    assert.deepEqual(U.files, []);
    assert.equal(U.intro, '');
    assert.equal(U.empty, '这门课的内容还在整理中。');
    assert.deepEqual(U.crumbs.map((c) => c.text), ['课程资料', '现代电子学实验']);
  });

  // ---------------- sub-posts ----------------

  await test('sub-post: breadcrumbs 课程资料 › 课程 › 本篇, no date / reading time, pdf shortcode embedded', async () => {
    assert.equal(await go('/courses/modern-lab/franck-hertz/'), 200);
    const N = await navInfo(page);
    assert.equal(N.crumbText, '课程资料 › 近代物理实验 › 弗兰克-赫兹实验');
    assert.deepEqual(N.crumbs, [
      { text: '课程资料', href: '/courses/' },
      { text: '近代物理实验', href: '/courses/modern-lab/' },
      { text: '弗兰克-赫兹实验', href: null },
    ]);
    assert.equal(N.h1, '弗兰克-赫兹实验');
    assert.equal(N.hasDate, false);
    assert.equal(await page.locator('figure.pdf-embed iframe').count(), 1);
    await page.screenshot({ path: path.join(SHOTS, 'subpost-desktop.png'), fullPage: false });

    await go('/courses/modern-lab/millikan/'); // has a date in its front matter
    const M = await navInfo(page);
    assert.equal(M.hasDate, false);
    assert.doesNotMatch(M.text, /2025|分钟|min read/);
    const html = fs.readFileSync(path.join(G.siteDir, 'courses/modern-lab/millikan/index.html'), 'utf8');
    assert.doesNotMatch(html.split('<main')[1], /2025-03-01|March 1, 2025|2025年/);
  });

  await test('sub-post: prev/next stay inside the course and follow weight', async () => {
    const order = ['millikan', 'zeeman', 'franck-hertz'];
    const titles = { millikan: '密立根油滴实验', zeeman: '塞曼效应', 'franck-hertz': '弗兰克-赫兹实验' };
    for (let i = 0; i < order.length; i++) {
      await go(`/courses/modern-lab/${order[i]}/`);
      const N = await navInfo(page);
      assert.equal(N.navs, 1);
      const want = (j, label) => (j < 0 || j >= order.length ? null : { href: `/courses/modern-lab/${order[j]}/`, title: titles[order[j]], label });
      assert.deepEqual(N.prev, want(i - 1, '« 上一篇'), `prev of ${order[i]}`);
      assert.deepEqual(N.next, want(i + 1, '下一篇 »'), `next of ${order[i]}`);
    }
    // a course with a single sub-post has no pager at all
    await go('/courses/quantum/ch1/');
    assert.equal((await navInfo(page)).navs, 0);
    // following "next" really navigates
    await go('/courses/modern-lab/millikan/');
    await page.click('.course-paginav a.next');
    await page.waitForURL(/\/courses\/modern-lab\/zeeman\/$/);
  });

  await test('draft sub-post is not built and not listed (zh + en, sitemap)', async () => {
    assert.equal(await go('/courses/modern-lab/z-draft/'), 404);
    assert.equal(await go('/en/courses/modern-lab/z-draft/'), 404);
    const sitemap = fs.readFileSync(path.join(G.siteDir, 'sitemap.xml'), 'utf8')
      + fs.readFileSync(path.join(G.siteDir, 'zh', 'sitemap.xml'), 'utf8')
      + fs.readFileSync(path.join(G.siteDir, 'en', 'sitemap.xml'), 'utf8');
    assert.doesNotMatch(sitemap, /z-draft/);
    assert.match(sitemap, /\/courses\/modern-lab\/zeeman\//);
  });

  await test('posts keep PaperMod behaviour (no course pager, no course breadcrumbs)', async () => {
    assert.equal(await go('/posts/first-physics-note/'), 200);
    assert.equal(await page.locator('.course-paginav, .course-breadcrumbs').count(), 0);
  });

  // ---------------- English site ----------------

  await test('en: labels in English, own group text, en overrides, fallback group/weight', async () => {
    assert.equal(await go('/en/courses/'), 200);
    const L = await landingInfo(page);
    assert.deepEqual(L.groups, [
      { title: '理论课', cards: ['Quantum Mechanics', '光学'] }, // quantum's _index.en.md has no group/weight → shared values
      { title: 'Labs', cards: ['Modern Physics Lab', 'Modern Electronics Lab'] },
      { title: 'Other', cards: ['平衡态统计物理讨论班'] },
    ]);
    const by = Object.fromEntries(L.cards.map((c) => [c.title, c]));
    assert.equal(by['Modern Physics Lab'].meta, '3 posts · 4 files');
    assert.equal(by['Modern Physics Lab'].href, '/en/courses/modern-lab/');
    assert.equal(by['Quantum Mechanics'].meta, '1 post');
    assert.equal(by['光学'].meta, '2 files');
    assert.equal(by['Quantum Mechanics'].desc, 'Solutions to the exercises');
    assert.match(L.introText, /How to Use/);

    assert.equal(await go('/en/courses/modern-lab/'), 200);
    const U = await unitInfo(page);
    assert.deepEqual(U.crumbs.map((c) => [c.text, c.href]), [['Course Materials', '/en/courses/'], ['Modern Physics Lab', null]]);
    assert.deepEqual(U.sections, ['Contents', 'Materials']);
    assert.match(U.intro, /A few of the experiments/);
    assert.deepEqual(U.posts.map((p) => p.href), ['/en/courses/modern-lab/millikan/', '/en/courses/modern-lab/zeeman/', '/en/courses/modern-lab/franck-hertz/']);
    const cjk = U.files.find((f) => f.name === '实验 报告 1.pdf');
    assert.equal(cjk.href, viewerHref(MAT.cjk, 'en'));
    assert.deepEqual(cjk.used, { label: 'Used in', title: '弗兰克-赫兹实验', href: '/en/courses/modern-lab/franck-hertz/' });
    assert.equal(cjk.dlText, 'Download');
    assert.equal(U.files.find((f) => f.name === 'data.docx').href, fileHref(MAT.docx));
    await page.screenshot({ path: path.join(SHOTS, 'en-unit-desktop.png'), fullPage: true });

    await go('/en/courses/modern-lab/zeeman/');
    const N = await navInfo(page);
    assert.equal(N.crumbText, 'Course Materials › Modern Physics Lab › 塞曼效应');
    assert.deepEqual(N.prev, { href: '/en/courses/modern-lab/millikan/', title: '密立根油滴实验', label: '« Previous' });
    assert.deepEqual(N.next, { href: '/en/courses/modern-lab/franck-hertz/', title: '弗兰克-赫兹实验', label: 'Next »' });

    await go('/en/courses/electronics/');
    assert.equal((await unitInfo(page)).empty, 'Nothing has been posted for this course yet.');

    await go('/en/courses/', P);
    assert.equal((await landingInfo(page)).groupTitles, 0);
  });

  // ---------------- feeds ----------------

  await test('RSS and sitemaps are well-formed XML', async () => {
    const files = ['index.xml', 'courses/index.xml', 'courses/modern-lab/index.xml', 'en/courses/modern-lab/index.xml', 'sitemap.xml', 'zh/sitemap.xml', 'en/sitemap.xml'];
    for (const f of files) {
      const xml = fs.readFileSync(path.join(G.siteDir, f), 'utf8');
      const err = await page.evaluate((s) => {
        const d = new DOMParser().parseFromString(s, 'application/xml');
        return d.querySelector('parsererror')?.textContent || null;
      }, xml);
      assert.equal(err, null, f);
    }
    const rss = fs.readFileSync(path.join(G.siteDir, 'courses/modern-lab/index.xml'), 'utf8');
    assert.match(rss, /<title>塞曼效应<\/title>/);
    assert.doesNotMatch(rss, /还没写完/);
  });

  // ---------------- phone + dark ----------------

  await test('phone 390×844 and 360×740: no horizontal scroll; screenshots', async () => {
    for (const [w, h] of [[390, 844], [360, 740]]) {
      const pctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
      const pp = await newPage(pctx, origins);
      for (const [p, shot, v] of [
        ['/courses/', 'landing-grouped', G], ['/courses/', 'landing-plain', P], ['/courses/modern-lab/', 'unit', G],
        ['/courses/modern-lab/millikan/', 'subpost', G], ['/en/courses/modern-lab/', 'en-unit', G], ['/courses/optics/', 'unit-materials-only', G],
      ]) {
        await pp.goto(v.mock.url + p, { waitUntil: 'load' });
        const s = await noHScroll(pp);
        assert.ok(s.sw <= s.cw, `${p} @${w}px: scrollWidth ${s.sw} > ${s.cw} (${s.wide.join(', ')})`);
        assert.deepEqual(s.wide, [], `${p} @${w}px`);
        if (w === 390) await pp.screenshot({ path: path.join(SHOTS, `${shot}-phone.png`), fullPage: true });
      }
      assert.deepEqual(pp.problems, []);
      await pctx.close();
    }
  });

  await test('dark mode: cards and materials use the theme colours; screenshots', async () => {
    const dctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: 'dark' });
    const dp = await newPage(dctx, origins);
    for (const [p, shot] of [['/courses/', 'landing-grouped'], ['/courses/modern-lab/', 'unit'], ['/courses/modern-lab/zeeman/', 'subpost']]) {
      await dp.goto(G.mock.url + p, { waitUntil: 'load' });
      assert.equal(await dp.evaluate(() => document.documentElement.dataset.theme), 'dark');
      await dp.screenshot({ path: path.join(SHOTS, `${shot}-dark.png`), fullPage: true });
    }
    await dp.goto(G.mock.url + '/courses/modern-lab/');
    const colors = await dp.evaluate(() => {
      const bg = (s) => getComputedStyle(document.querySelector(s)).backgroundColor;
      const fg = (s) => getComputedStyle(document.querySelector(s)).color;
      return { body: getComputedStyle(document.body).backgroundColor, post: bg('.course-post'), list: bg('.course-material-list'), name: fg('.course-material-name'), title: fg('.course-post-title a') };
    });
    // PaperMod dark: --theme rgb(29,30,32), --entry rgb(46,46,51), --primary rgb(218,218,219)
    assert.deepEqual(colors, { body: 'rgb(29, 30, 32)', post: 'rgb(46, 46, 51)', list: 'rgb(46, 46, 51)', name: 'rgb(218, 218, 219)', title: 'rgb(218, 218, 219)' });
    assert.deepEqual(dp.problems, []);
    await dctx.close();
  });

  // ---------------- verifier: edge cases (third build) ----------------

  await test('edge build: draft course, nested section, en-only group, case/space-twin groups, odd link encodings, materialsDir', async () => {
    const files = fixtureFiles({ grouped: true, pdfs });
    for (const k of Object.keys(files)) if (/^(content\/courses\/[^_]|static\/documents\/courses\/)/.test(k)) files[k] = null;
    Object.assign(files, {
      // draft course WITHOUT the admin's cascade: Hugo still publishes its sub-post → the build warns about it
      'content/courses/leaky/_index.md': fm({ title: '漏出来的草稿课', group: '实验课', weight: 5, draft: true }),
      'content/courses/leaky/a.md': fm({ title: '草稿课的子推文', weight: 10 }) + '\n正文\n',
      // draft course WITH the cascade the admin writes: nothing of it is built
      'content/courses/hidden/_index.md': '---\ntitle: "隐藏的课"\ngroup: "实验课"\nweight: 6\ndraft: true\ncascade: { build: { render: "never", list: "never" } }\n---\n',
      'content/courses/hidden/b.md': fm({ title: '隐藏课的子推文', weight: 10, draft: false }) + '\n正文\n',
      // groups that differ only by case, and a group literally called "other"
      'content/courses/labs-a/_index.md': fm({ title: 'Labs A', group: 'Labs', weight: 10 }),
      'content/courses/labs-b/_index.md': fm({ title: 'Labs B', group: 'labs', weight: 20 }),
      'content/courses/odd/_index.md': fm({ title: 'Odd', group: 'other', weight: 30 }),
      'content/courses/plain/_index.md': fm({ title: '没有分组也没有顺序' }),
      // group only in the English override: must not leak onto the Chinese site
      'content/courses/enonly/_index.md': fm({ title: '只有英文分组', weight: 40 }),
      'content/courses/enonly/_index.en.md': fm({ title: 'English-only group', group: 'Seminars' }),
      // nested section + its own default materials folder (courses/nest/sub/, not a course called "sub")
      'content/courses/nest/_index.md': fm({ title: '嵌套', group: 'Labs', weight: 50 }),
      'content/courses/nest/sub/_index.md': fm({ title: '子栏目', weight: 10 }),
      'content/courses/nest/sub/y.md': fm({ title: '子栏目里的页', weight: 10 }) + '\n内容\n',
      'content/courses/nest/z.md': fm({ title: '直接的子推文', weight: 20 }) + '\n内容\n',
      'static/documents/courses/nest/sub/right.pdf': pdfs.handout,
      'static/documents/courses/sub/wrong.pdf': pdfs.handout,
      // references written the way the admin editor writes them (mdDest: spaces → %20, CJK raw; encodeURIComponent viewer links)
      'content/courses/enc/_index.md': fm({ title: '编码', weight: 60 }),
      'content/courses/enc/i1.md': fm({ title: '图片引用', weight: 10 }) + '\n![图](/documents/courses/enc/图%20一.png)\n',
      'content/courses/enc/i2.md': fm({ title: '预览链接', weight: 20 }) + `\n[看](/viewer/?file=${encodeURIComponent('/documents/courses/enc/a(1).pdf')})\n`,
      'static/documents/courses/enc/图 一.png': png(8, 8, [1, 2, 3]),
      'static/documents/courses/enc/a(1).pdf': pdfs.handout,
      // custom materialsDir (shared folder) and an invalid one
      'content/courses/custom/_index.md': fm({ title: '自定义资料', weight: 70, materialsDir: 'documents/shared/' }),
      'static/documents/shared/s.pdf': pdfs.handout,
    });
    const dir = path.join(OUT, 'edge');
    const mock = await startMock({ seedFiles: files, siteDir: path.join(dir, 'site') });
    try {
      const exportDir = mock.exportTo(path.join(dir, 'export'));
      const built = await buildSite({ repoDir: exportDir, outDir: path.join(dir, 'site'), baseURL: mock.url + '/' });
      const warns = (built.stdout + built.stderr).split('\n').filter((l) => /WARN|ERROR/.test(l));
      assert.equal(warns.length, 2, 'exactly the two draft-course warnings (zh + en):\n' + warns.join('\n'));
      assert.ok(warns.every((w) => w.includes('漏出来的草稿课') && w.includes('cascade')), warns.join('\n'));
      const site = path.join(dir, 'site');
      const has = (p) => fs.existsSync(path.join(site, p, 'index.html'));
      const read = (p) => fs.readFileSync(path.join(site, p, 'index.html'), 'utf8');
      assert.equal(has('courses/leaky'), false);
      assert.equal(has('courses/hidden'), false);
      assert.equal(has('courses/hidden/b'), false, 'the cascade hides the sub-post');
      assert.equal(has('en/courses/hidden/b'), false);
      assert.ok(!fs.readFileSync(path.join(site, 'index.xml'), 'utf8').includes('/courses/hidden/'));
      // the leaked sub-post (no cascade) at least has no dead breadcrumb link to its unpublished course
      const leak = read('courses/leaky/a');
      assert.ok(!/href=""/.test(leak) && !/<a href="?"?>漏出来的草稿课/.test(leak), 'no empty breadcrumb link');
      // landing: unique ids; Labs / labs / other are separate groups (labels shown as written), 其他 last
      const landing = read('courses');
      const groups = [...landing.matchAll(/<h2 class="?course-group-title"? id="?([^" >]+)"?>([^<]+)</g)].map((m) => [m[1], m[2].trim()]);
      assert.deepEqual(groups.map((g) => g[1]), ['Labs', 'labs', 'other', '其他']);
      assert.equal(new Set(groups.map((g) => g[0])).size, 4, 'unique ids: ' + JSON.stringify(groups));
      const otherCards = landing.slice(landing.indexOf('id=group-other>') >= 0 ? landing.indexOf('id=group-other>') : landing.indexOf('id="group-other"'));
      for (const t of ['只有英文分组', '没有分组也没有顺序', '编码', '自定义资料']) assert.ok(otherCards.includes(t), `${t} in 其他 on zh`);
      assert.ok(!landing.includes('Seminars'), 'an en-only group never shows on the Chinese site');
      assert.ok(otherCards.indexOf('自定义资料') < otherCards.indexOf('没有分组也没有顺序'), 'no weight → last');
      const enLanding = read('en/courses');
      assert.ok(/>\s*Seminars\s*</.test(enLanding), 'the English override shows its own group');
      // nested: the section is listed on its parent unit page, and its materials come from courses/nest/sub/
      const nest = read('courses/nest');
      assert.ok(nest.includes('/courses/nest/sub/') && nest.includes('/courses/nest/z/'), 'nested section + direct sub-post listed');
      const sub = read('courses/nest/sub');
      assert.ok(sub.includes('right.pdf') && !sub.includes('wrong.pdf'), 'nested section uses its own materials folder');
      // encodings written by the admin are recognised as "used in"
      const enc = read('courses/enc');
      const row = (name) => (new RegExp(`<li class="?course-material"?[^>]*>(?:(?!</li>)[\\s\\S])*${name.replace(/[()]/g, '\\$&')}(?:(?!</li>)[\\s\\S])*</li>`).exec(enc) || [''])[0];
      assert.match(row('图 一.png'), /course-material-post[\s\S]*图片引用/, 'mdDest-encoded image reference');
      assert.match(row('a(1).pdf'), /course-material-post[\s\S]*预览链接/, 'encodeURIComponent viewer link');
      // custom materialsDir
      assert.ok(read('courses/custom').includes('/documents/shared/s.pdf') || read('courses/custom').includes('%2Fdocuments%2Fshared%2Fs.pdf'));
    } finally {
      await mock.close();
    }
  });

  await test('no page errors on the desktop pages', async () => {
    assert.deepEqual(page.problems, []);
  });

  await browser.close();
  await G.mock.close();
  await P.mock.close();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed. Screenshots: ${SHOTS}`);
  if (failed.length) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
