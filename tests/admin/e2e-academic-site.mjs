// tests/admin/e2e-academic-site.mjs — end-to-end test of the website side of the academic modules:
//   layouts/publications|talks|news/list.html, layouts/partials/academic/*, layouts/partials/index_profile.html
//   (home news + CV button), layouts/partials/social_icons.html (ads / arxiv icons), i18n/{en,zh}.yaml,
//   assets/css/extended/{academic,background}.css, assets/js/academic.js (BibTeX copy) and the background
//   animation toggle (assets/js/background/core.js: fixed bottom-left on wide screens, docked in the footer below 900px).
//
// The real data/ and config are never touched: fixtures are seeded into the mock GitHub (seedFiles: data/*.yaml,
// a patched params.toml, a demo course and small PDFs), exported and built with the pinned Hugo. Three builds:
//   full   groupBy = "kind", myNames, ads / orcid / scholar, cv, 3 extra social icons, 9 publications, 5 talks, 9 news
//   year   the same data with groupBy = "year" and [news] homeCount = 0
//   empty  the repository as it is (no data entries) → empty states, no news block, no CV button
// Fixture highlights: a 40-author paper with the user 15th (… + name + et al.), a 10-author one with the user 5th
// (shown up to the user), the user as last of 12 (no et al.), a LaTeX/&/<…> title, an A&A bibcode, a pdf without the
// leading slash, javascript: links that must be dropped (with a build warning), a future talk with an unquoted YAML date,
// per-language news text, language-aware links and a markdown link with javascript: in the text.
//
// Languages: English (default) at /, Chinese at /zh/. Viewer links always carry lang=<page language>.
//
// Run from the repo root:   node tests/admin/e2e-academic-site.mjs
// Env:
//   ACADEMIC_SITE_E2E_DIR  where exports, builds and screenshots go
//                          (default: $ADMIN_TEST_TMP/e2e-academic-site or <os tmp>/admin-e2e-academic-site)
//   HUGO_BIN               Hugo binary (see mock-github.mjs)
//   ONLY=<substr>          run only tests whose name contains this

import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
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

const OUT = path.resolve(process.env.ACADEMIC_SITE_E2E_DIR
  || (process.env.ADMIN_TEST_TMP ? path.join(process.env.ADMIN_TEST_TMP, 'e2e-academic-site') : path.join(os.tmpdir(), 'admin-e2e-academic-site')));
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

const day = (offset) => new Date(Date.now() + offset * 864e5).toISOString().slice(0, 10);
const FUTURE = day(45);
const FUTURE2 = day(120);
const yaml = (obj) => Object.entries(obj).map(([k, v]) => {
  if (Array.isArray(v)) return `${k}:\n${v.map((x) => `  - ${JSON.stringify(x)}`).join('\n')}`;
  if (v && typeof v === 'object' && v.raw !== undefined) return `${k}: ${v.raw}`;
  if (typeof v === 'string' && v.includes('\n')) return `${k}: |\n${v.replace(/\n$/, '').split('\n').map((l) => '  ' + l).join('\n')}`;
  return `${k}: ${typeof v === 'string' ? JSON.stringify(v) : v}`;
}).join('\n') + '\n';

const names = (n, prefix) => Array.from({ length: n }, (_, i) => `${prefix}${String.fromCharCode(65 + (i % 26))}${i >= 26 ? i : ''}, X.`);
const big = names(40, 'Author');
big[14] = 'Zhong, F.';
const near = names(10, 'Near');
near[4] = 'Zhong, Fangxiong';
const last = names(12, 'Last');
last[11] = 'Zhong, F.';

const BIB = '@ARTICLE{2026MNRAS.545.1234Z,\n  author = {{Zhong}, F. and {Smith}, J.},\n  title = "{Neutral hydrogen in dark galaxies}",\n  journal = {MNRAS},\n  year = 2026\n}';
const TEX_TITLE = 'Constraints on $\\Lambda$CDM from <dark> galaxies & H I';

const PUBS = {
  '2026-zhong-hi': {
    id: '2026-zhong-hi', title: 'Neutral hydrogen in dark galaxies', authors: ['Zhong, F.', 'Smith, J.'], year: 2026, month: 3,
    venue: 'MNRAS', volume: '545', pages: '1234', status: 'published', kind: 'refereed', arxiv: '2603.01234', ads: '2026MNRAS.545.1234Z',
    doi: '10.1093/mnras/stag001', pdf: '/documents/papers/zhong2026.pdf', code: 'https://github.com/example/hi-code', selected: true, bibtex: BIB,
  },
  '2025-big-collab': {
    title: TEX_TITLE, authors: big, year: 2025, month: 7, venue: 'ApJ', volume: '990', pages: '12', kind: 'refereed', arxiv: 'arXiv:2507.00001v2',
  },
  '2025-near': { title: 'A survey of nearby dwarfs', authors: near, year: 2025, month: 1, venue: 'A&A', ads: '2025A&A...693A..12N', kind: 'refereed' },
  '2023-last': { title: 'Last author paper', authors: last, year: 2023, venue: 'AJ', kind: 'refereed', doi: 'https://doi.org/10.3847/1538-3881/ab0001' },
  '2026-submitted': { title: 'A submitted paper', authors: ['Zhong, F.'], year: 2026, month: 9, status: 'submitted', kind: 'refereed', arxiv: '2609.04321' },
  'hi-inprep': { title: 'Work in progress', authors: ['Zhong, F.', 'Advisor, A.'], status: 'in prep' },
  '2024-aas-proc': { title: 'A proceedings contribution', authors: ['Zhong, F.'], year: 2024, kind: 'proceedings', venue: 'IAU Symposium', slides: '/documents/talks/aas.pdf' },
  '2024-thesis': { title: 'Undergraduate thesis', authors: ['Zhong, F.'], year: 2024, kind: 'thesis', venue: 'Peking University', pdf: 'documents/papers/thesis.pdf', note: 'In Chinese, with an English abstract.' },
  '2022-bad-links': { title: 'Paper with bad links', authors: ['Other, O.'], year: 2022, kind: 'refereed', code: 'javascript:alert(1)', pdf: 'data:text/html,hi', doi: 'not-a-doi' },
};

const TALKS = {
  'future-invited': { title: 'Invited review of HI in dark galaxies', event: 'Future Conference', location: 'Pasadena, CA', date: { raw: FUTURE }, kind: 'invited', url: 'https://example.org/conf' },
  'future-far': { title: 'Second upcoming talk', event: 'Later Workshop', date: FUTURE2, kind: 'talk' },
  '2025-06-aas': { title: 'Dark galaxies with FAST', event: 'AAS 246', location: 'Anchorage, AK', date: '2025-06-10', kind: 'talk', slides: '/documents/talks/aas.pdf', video: 'https://example.org/video', abstract: 'We present\nnew results.' },
  '2025-02-seminar': { title: 'Group seminar', event: 'Caltech', date: '2025-02-01', kind: 'seminar' },
  '2024-poster': { title: 'A poster', event: 'Summer School', date: '2024-08-15', kind: 'poster', slides: 'https://example.org/poster.pdf' },
  // regression: an impossible date used to stop the whole build (cond evaluated int (substr "" 0 4))
  'talk-bad-date': { title: 'Talk with an impossible date', event: 'Nowhere', date: '2025-02-30', kind: 'talk' },
};

const NEWS = {
  // the link's query has & — regression: it used to come out as &amp;amp; (the text is HTML-escaped before Markdown)
  '2026-10-01-one': { date: '2026-10-01', text: 'Paper **accepted** in [MNRAS](https://example.org/mnras?a=1&b=2).', link: '/publications/' },
  '2026-09-15-two': { date: '2026-09-15', text: 'Shared text two', text_zh: '中文第二条', text_en: 'English two' },
  '2026-08-01-three': { date: '2026-08-01', text: 'Gave a talk', link: 'talks/' },
  '2026-07-01-four': { date: { raw: '2026-07-01' }, text: 'Escaped <b>html</b> & stuff' },
  '2026-06-01-five': { date: '2026-06-01', text: 'Bad [link](javascript:alert(1)) removed' },
  '2026-05-01-six': { date: '2026-05-01', text: 'Six', text_zh: '第六条' },
  '2025-12-01-seven': { date: '2025-12-01', text: 'Seven $H_0$' },
  '2025-01-01-eight': { date: '2025-01-01', text: 'Eight', link: 'https://example.org/eight' },
  '2025-01-01-nine-bad-date': { date: '2025-02-30', text: 'never shown' },
};

const realParams = fs.readFileSync(path.join(REPO_ROOT, 'config/_default/params.toml'), 'utf8');
function patchedParams({ groupBy = 'kind', homeCount = 5 } = {}) {
  let s = realParams;
  const set = (re, val) => {
    assert.match(s, re, `params.toml has ${re}`);
    s = s.replace(re, val);
  };
  set(/^cv = ""/m, 'cv = "/documents/cv.pdf"');
  set(/^(\s*)myNames = \[\]/m, '$1myNames = ["Zhong, F.", "Zhong, Fangxiong"]');
  set(/^(\s*)ads = ""/m, '$1ads = "Zhong, F."');
  set(/^(\s*)orcid = ""/m, '$1orcid = "0000-0002-1825-0097"');
  set(/^(\s*)scholar = ""/m, '$1scholar = "AbCdEf123456"');
  set(/^(\s*)groupBy = "kind"/m, `$1groupBy = "${groupBy}"`);
  set(/^(\s*)homeCount = 5/m, `$1homeCount = ${homeCount}`);
  s += '\n[[socialIcons]]\n  name = "ads"\n  url = "https://ui.adsabs.harvard.edu/example"\n'
    + '[[socialIcons]]\n  name = "arxiv"\n  url = "https://arxiv.org/a/example_1"\n'
    + '[[socialIcons]]\n  name = "orcid"\n  url = "https://orcid.org/0000-0002-1825-0097"\n';
  return s;
}

async function makePdfs(browser) {
  const page = await browser.newPage();
  const mk = async (title) => {
    await page.setContent(`<html><body style="font:28px serif"><h1>${title}</h1></body></html>`);
    return Buffer.from(await page.pdf({ format: 'A4' }));
  };
  const out = { paper: await mk('Paper'), cv: await mk('Curriculum Vitae'), slides: await mk('Slides') };
  await page.close();
  return out;
}

function fixtureFiles(pdfs, opts) {
  const files = { 'config/_default/params.toml': patchedParams(opts) };
  for (const [k, v] of Object.entries(PUBS)) files[`data/publications/${k}.yaml`] = yaml(v);
  for (const [k, v] of Object.entries(TALKS)) files[`data/talks/${k}.yaml`] = yaml(v);
  for (const [k, v] of Object.entries(NEWS)) files[`data/news/${k}.yaml`] = yaml(v);
  files['static/documents/papers/zhong2026.pdf'] = pdfs.paper;
  files['static/documents/papers/thesis.pdf'] = pdfs.paper;
  files['static/documents/talks/aas.pdf'] = pdfs.slides;
  files['static/documents/cv.pdf'] = pdfs.cv;
  // a course with a materials list (the background toggle used to cover its badges on phones)
  files['content/courses/demo-lab/_index.md'] = '---\ntitle: "Demo Lab"\ndescription: "A demo course."\nweight: 1\n---\n\nIntro.\n';
  for (let i = 1; i <= 8; i++) files[`static/documents/courses/demo-lab/report-${i}.pdf`] = pdfs.slides;
  return files;
}

async function buildVariant(name, seedFiles) {
  const dir = path.join(OUT, name);
  const mock = await startMock({ seedFiles, siteDir: path.join(dir, 'site') });
  const exportDir = mock.exportTo(path.join(dir, 'export'));
  const built = await buildSite({ repoDir: exportDir, outDir: path.join(dir, 'site'), baseURL: mock.url + '/' });
  const warnings = (built.stdout + built.stderr).split('\n').filter((l) => /WARN|ERROR/.test(l));
  return { mock, exportDir, siteDir: path.join(dir, 'site'), built, warnings, origin: new URL(mock.url).origin };
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

const pubInfo = (page) => page.evaluate(() => [...document.querySelectorAll('.pub-group')].map((g) => ({
  title: g.querySelector('.pub-group-title').firstChild.textContent.trim(),
  count: g.querySelector('.pub-group-count')?.textContent.trim(),
  items: [...g.querySelectorAll('.pub')].map((li) => ({
    id: li.id,
    title: li.querySelector('.pub-title').textContent,
    titleHTML: li.querySelector('.pub-title').innerHTML,
    authors: li.querySelector('.pub-authors')?.textContent.replace(/\s+/g, ' ').trim() || '',
    me: [...li.querySelectorAll('.pub-me')].map((e) => e.textContent),
    meta: li.querySelector('.pub-meta').textContent.replace(/\s+/g, ' ').trim(),
    badges: [...li.querySelectorAll('.pub-badge')].map((e) => e.textContent.trim()),
    note: li.querySelector('.pub-note')?.textContent || '',
    selected: li.classList.contains('pub-selected'),
    chips: Object.fromEntries([...li.querySelectorAll('.pub-links > a.pub-chip')].map((a) => [a.textContent.trim(), { href: a.getAttribute('href'), target: a.getAttribute('target') }])),
    bibtex: li.querySelector('.pub-bibtex pre')?.textContent ?? null,
  })),
})));

const talkInfo = (page) => page.evaluate(() => [...document.querySelectorAll('.talk-group')].map((g) => ({
  title: g.querySelector('.pub-group-title').textContent.trim(),
  items: [...g.querySelectorAll('.talk')].map((li) => ({
    title: li.querySelector('.talk-title').textContent,
    date: li.querySelector('.talk-date')?.getAttribute('datetime') || '',
    dateText: li.querySelector('.talk-date')?.textContent || '',
    kind: li.querySelector('.talk-kind')?.textContent.trim() || '',
    place: li.querySelector('.talk-place')?.textContent || '',
    chips: Object.fromEntries([...li.querySelectorAll('.pub-links > a.pub-chip')].map((a) => [a.textContent.trim(), a.getAttribute('href')])),
    abstract: li.querySelector('.pub-abstract p')?.textContent ?? null,
  })),
})));

const newsInfo = (page, root = 'main') => page.evaluate((root) => [...document.querySelectorAll(`${root} .news-item`)].map((li) => ({
  date: li.querySelector('.news-date').getAttribute('datetime'),
  dateText: li.querySelector('.news-date').textContent,
  text: li.querySelector('.news-text').textContent.replace(/\s+/g, ' ').trim(),
  html: li.querySelector('.news-text').innerHTML,
  more: li.querySelector('.news-more')?.getAttribute('href') || null,
  links: [...li.querySelectorAll('.news-text a')].map((a) => a.getAttribute('href')),
})), root);

const noHScroll = (page) => page.evaluate(() => ({
  sw: document.documentElement.scrollWidth,
  cw: document.documentElement.clientWidth,
  wide: [...document.querySelectorAll('body *')].filter((e) => {
    const r = e.getBoundingClientRect();
    return r.width && r.right > document.documentElement.clientWidth + 0.5 && !e.closest('.pub-bibtex pre');
  }).slice(0, 5).map((e) => `${e.tagName}.${e.className}`),
}));

/** Everything about the background toggle, plus the elements of <main> it overlaps. */
const toggleInfo = (page) => page.evaluate(() => {
  const b = document.querySelector('.bg-toggle');
  if (!b) return null;
  const r = b.getBoundingClientRect();
  const cs = getComputedStyle(b);
  const hit = (e) => {
    const q = e.getBoundingClientRect();
    return q.width && q.height && q.left < r.right && q.right > r.left && q.top < r.bottom && q.bottom > r.top;
  };
  const leaves = [...document.querySelectorAll('main *, .lang-hint, .top-link')].filter((e) => !e.children.length || e.matches('a, button, .lang-hint'));
  return {
    docked: b.classList.contains('is-docked'),
    inFooter: !!b.closest('footer.footer'),
    position: cs.position,
    rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
    pressed: b.getAttribute('aria-pressed'),
    label: b.getAttribute('aria-label'),
    overlaps: leaves.filter(hit).map((e) => `${e.tagName}.${e.className}`).slice(0, 5),
    footerText: document.querySelector('footer.footer')?.textContent.replace(/\s+/g, ' ').trim(),
  };
});

const vhref = (p, lang) => `/viewer/?file=${encodeURIComponent(p)}&lang=${lang}`;

// ---------------------------------------------------------------------------

async function main() {
  console.log(`e2e-academic-site → ${OUT}`);
  const browser = await chromium.launch();
  const pdfs = await makePdfs(browser);

  const F = await buildVariant('full', fixtureFiles(pdfs, {}));
  const Y = await buildVariant('year', fixtureFiles(pdfs, { groupBy: 'year', homeCount: 0 }));
  const E = await buildVariant('empty', {});
  const origins = [F.origin, Y.origin, E.origin];
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'en-US' });
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: F.origin });
  const page = await newPage(ctx, origins);
  const go = async (p, v = F) => (await page.goto(v.mock.url + p, { waitUntil: 'load' })).status();

  await test('build: only the expected warnings (bad links / bad date in the fixtures), none for the empty site', async () => {
    assert.deepEqual(E.warnings, []);
    for (const v of [F, Y]) {
      const w = v.warnings.join('\n');
      assert.match(w, /2022-bad-links code：链接 "javascript:alert\(1\)"/);
      assert.match(w, /2022-bad-links pdf：链接 "data:text\/html,hi"/);
      assert.match(w, /2022-bad-links：doi "not-a-doi"/);
      assert.match(w, /2025-01-01-nine-bad-date：date "2025-02-30"/);
      assert.match(w, /2026-06-01-five：text 里有不安全的链接/);
      assert.match(w, /talk-bad-date：date "2025-02-30"/);
      const unexpected = v.warnings.filter((l) => !/2022-bad-links|nine-bad-date|2026-06-01-five|talk-bad-date/.test(l));
      assert.deepEqual(unexpected, []);
    }
  });

  // ---------------- publications ----------------

  await test('publications (kind): groups, newest first, counts', async () => {
    assert.equal(await go('/publications/'), 200);
    const G = await pubInfo(page);
    assert.deepEqual(G.map((g) => [g.title, g.count]), [['Refereed publications', '5'], ['Submitted & in preparation', '2'], ['Proceedings & other', '2']]);
    assert.deepEqual(G[0].items.map((i) => i.id), ['pub-2026-zhong-hi', 'pub-2025-big-collab', 'pub-2025-near', 'pub-2023-last', 'pub-2022-bad-links']);
    // undated (in prep) sorts as the newest
    assert.deepEqual(G[1].items.map((i) => i.id), ['pub-hi-inprep', 'pub-2026-submitted']);
    // same year and month → by title
    assert.deepEqual(G[2].items.map((i) => i.id), ['pub-2024-aas-proc', 'pub-2024-thesis']);
    await page.screenshot({ path: path.join(SHOTS, 'publications-desktop.png'), fullPage: true });
  });

  await test('publications: bold names, truncation keeps the user visible, last author → no et al.', async () => {
    await go('/publications/');
    const all = Object.fromEntries((await pubInfo(page)).flatMap((g) => g.items).map((i) => [i.id.replace(/^pub-/, ''), i]));
    assert.equal(all['2026-zhong-hi'].authors, 'Zhong, F., Smith, J.');
    assert.deepEqual(all['2026-zhong-hi'].me, ['Zhong, F.']);
    assert.equal(all['2025-big-collab'].authors, `${big[0]}, ${big[1]}, ${big[2]}, …, Zhong, F., et al. (40 authors)`);
    assert.deepEqual(all['2025-big-collab'].me, ['Zhong, F.']);
    assert.equal(all['2025-near'].authors, `${near.slice(0, 4).join(', ')}, Zhong, Fangxiong, et al. (10 authors)`);
    assert.deepEqual(all['2025-near'].me, ['Zhong, Fangxiong']);
    assert.equal(all['2023-last'].authors, `${last.slice(0, 3).join(', ')}, …, Zhong, F.`);
    assert.equal(all['2022-bad-links'].me.length, 0);
    assert.equal(all['2022-bad-links'].authors, 'Other, O.');
  });

  await test('publications: title escaping (LaTeX, &, <…>), venue line, badges, note, selected', async () => {
    await go('/publications/');
    const all = Object.fromEntries((await pubInfo(page)).flatMap((g) => g.items).map((i) => [i.id.replace(/^pub-/, ''), i]));
    // KaTeX is blocked in the test (CDN) → the raw text is shown; <dark> is text, not an element
    assert.equal(all['2025-big-collab'].title, TEX_TITLE);
    assert.match(all['2025-big-collab'].titleHTML, /&lt;dark&gt; galaxies &amp; H I/);
    assert.equal(all['2026-zhong-hi'].meta, 'MNRAS, 545, 1234 (2026) Selected');
    assert.deepEqual(all['2026-zhong-hi'].badges, ['Selected']);
    assert.ok(all['2026-zhong-hi'].selected);
    assert.equal(all['2025-near'].meta, 'A&A (2025)');
    assert.deepEqual(all['2026-submitted'].badges, ['Submitted']);
    assert.equal(all['2026-submitted'].meta, '2026 Submitted');
    assert.deepEqual(all['hi-inprep'].badges, ['In preparation']);
    assert.equal(all['hi-inprep'].meta, 'In preparation');
    assert.deepEqual(all['2024-thesis'].badges, ['Thesis']);
    assert.deepEqual(all['2024-aas-proc'].badges, ['Proceedings']);
    assert.equal(all['2024-thesis'].note, 'In Chinese, with an English abstract.');
    assert.ok(!all['2025-near'].selected);
  });

  await test('publications: link chips (arXiv / ADS / DOI / PDF → viewer / Code / Slides), bad links dropped', async () => {
    for (const [prefix, lang] of [['', 'en'], ['/zh', 'zh']]) {
      await go(`${prefix}/publications/`);
      const all = Object.fromEntries((await pubInfo(page)).flatMap((g) => g.items).map((i) => [i.id.replace(/^pub-/, ''), i]));
      const code = lang === 'zh' ? '代码' : 'Code';
      const slides = lang === 'zh' ? '幻灯片' : 'Slides';
      assert.deepEqual(all['2026-zhong-hi'].chips, {
        arXiv: { href: 'https://arxiv.org/abs/2603.01234', target: '_blank' },
        ADS: { href: 'https://ui.adsabs.harvard.edu/abs/2026MNRAS.545.1234Z/abstract', target: '_blank' },
        DOI: { href: 'https://doi.org/10.1093/mnras/stag001', target: '_blank' },
        PDF: { href: vhref('/documents/papers/zhong2026.pdf', lang), target: null },
        [code]: { href: 'https://github.com/example/hi-code', target: '_blank' },
      });
      assert.equal(all['2025-big-collab'].chips.arXiv.href, 'https://arxiv.org/abs/2507.00001v2');
      assert.equal(all['2025-near'].chips.ADS.href, 'https://ui.adsabs.harvard.edu/abs/2025A%26A...693A..12N/abstract');
      assert.equal(all['2023-last'].chips.DOI.href, 'https://doi.org/10.3847/1538-3881/ab0001');
      assert.deepEqual(all['2024-thesis'].chips, { PDF: { href: vhref('/documents/papers/thesis.pdf', lang), target: null } });
      assert.deepEqual(all['2024-aas-proc'].chips, { [slides]: { href: vhref('/documents/talks/aas.pdf', lang), target: null } });
      assert.deepEqual(all['2022-bad-links'].chips, {});
      assert.deepEqual(all['hi-inprep'].chips, {});
      const bad = await page.$$eval('a[href], [src]', (els) => els.map((e) => e.getAttribute('href') || e.getAttribute('src')).filter((h) => /^\s*(javascript|data):/i.test(h)));
      assert.deepEqual(bad, []);
    }
    // viewer links pass the viewer's own validation, and the files exist
    await go('/publications/');
    for (const href of await page.$$eval('a.pub-chip[href^="/viewer/"]', (as) => as.map((a) => a.getAttribute('href')))) {
      const t = parseFileParam(new URL(href, F.origin).searchParams.get('file'), F.origin);
      assert.ok(t.ok, href);
      assert.equal((await page.request.get(F.origin + t.href)).status(), 200, t.href);
    }
  });

  await test('publications: profile links (ADS author query, ORCID, Scholar)', async () => {
    await go('/publications/');
    const links = await page.$$eval('.pub-profiles a', (as) => as.map((a) => [a.textContent.trim(), a.getAttribute('href'), !!a.querySelector('svg')]));
    assert.deepEqual(links, [
      ['NASA ADS', 'https://ui.adsabs.harvard.edu/search/q=author%3A%22Zhong%2C%20F.%22&sort=date%20desc%2C%20bibcode%20desc', true],
      ['ORCID', 'https://orcid.org/0000-0002-1825-0097', true],
      ['Google Scholar', 'https://scholar.google.com/citations?user=AbCdEf123456', true],
    ]);
    assert.equal(await page.getAttribute('.pub-profiles', 'aria-label'), 'Publication lists elsewhere');
  });

  await test('publications: BibTeX in <details> (closed → open), copy button copies the raw entry', async () => {
    await go('/publications/');
    const d = page.locator('#pub-2026-zhong-hi .pub-bibtex');
    assert.equal(await d.evaluate((e) => e.open), false);
    assert.equal(await page.locator('#pub-2026-zhong-hi .pub-bibtex pre').isVisible(), false);
    await d.locator('summary').click();
    assert.equal(await d.evaluate((e) => e.open), true);
    assert.equal(await d.locator('pre').textContent(), BIB);
    const btn = d.locator('button.pub-copy');
    assert.equal(await btn.textContent(), 'Copy');
    await btn.click();
    await page.waitForFunction(() => document.querySelector('#pub-2026-zhong-hi .pub-copy').textContent === 'Copied');
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), BIB);
    await page.screenshot({ path: path.join(SHOTS, 'publications-bibtex-open.png'), fullPage: false });
    // only one paper has a bibtex entry; the script is loaded once
    assert.equal(await page.locator('.pub-bibtex').count(), 1);
    assert.equal(await page.locator('script[src*="/js/academic"]').count(), 1);
  });

  await test('publications (zh): Chinese labels and et al.', async () => {
    await go('/zh/publications/');
    const G = await pubInfo(page);
    assert.deepEqual(G.map((g) => g.title), ['同行评审论文', '已投稿与准备中', '会议论文与其他']);
    const all = Object.fromEntries(G.flatMap((g) => g.items).map((i) => [i.id.replace(/^pub-/, ''), i]));
    assert.equal(all['2025-big-collab'].authors, `${big[0]}, ${big[1]}, ${big[2]}, …, Zhong, F. 等（共 40 位作者）`);
    assert.deepEqual(all['2026-submitted'].badges, ['已投稿']);
    assert.deepEqual(all['hi-inprep'].badges, ['准备中']);
    assert.deepEqual(all['2026-zhong-hi'].badges, ['代表作']);
    assert.equal(await page.textContent('main h1'), '论文');
    await page.screenshot({ path: path.join(SHOTS, 'publications-zh-desktop.png'), fullPage: true });
  });

  await test('publications (year): undated first, then years descending; kind badges', async () => {
    assert.equal(await go('/publications/', Y), 200);
    const G = await pubInfo(page);
    assert.deepEqual(G.map((g) => [g.title, g.count]), [['Undated', '1'], ['2026', '2'], ['2025', '2'], ['2024', '2'], ['2023', '1'], ['2022', '1']]);
    assert.deepEqual(G[1].items.map((i) => i.id), ['pub-2026-submitted', 'pub-2026-zhong-hi']);
    await go('/zh/publications/', Y);
    assert.equal((await pubInfo(page))[0].title, '未注明年份');
  });

  // ---------------- talks ----------------

  await test('talks: upcoming (soonest first) then past by year; kind badges; slides → viewer; dates', async () => {
    for (const [prefix, lang] of [['', 'en'], ['/zh', 'zh']]) {
      assert.equal(await go(`${prefix}/talks/`), 200);
      const T = await talkInfo(page);
      const up = lang === 'zh' ? '即将进行' : 'Upcoming';
      assert.deepEqual(T.map((g) => g.title), [up, '2025', '2024', lang === 'zh' ? '未注明日期' : 'Undated']);
      assert.deepEqual(T[3].items.map((i) => [i.title, i.date]), [['Talk with an impossible date', '']], 'an invalid date → undated, last');
      assert.deepEqual(T[0].items.map((i) => i.date), [FUTURE, FUTURE2]);
      assert.deepEqual(T[1].items.map((i) => i.title), ['Dark galaxies with FAST', 'Group seminar']);
      const fast = T[1].items[0];
      assert.equal(fast.kind, lang === 'zh' ? '报告' : 'Talk');
      assert.equal(fast.place, 'AAS 246 · Anchorage, AK');
      assert.equal(fast.dateText, lang === 'zh' ? '2025年6月10日' : 'Jun 10, 2025');
      assert.deepEqual(fast.chips, lang === 'zh'
        ? { 幻灯片: vhref('/documents/talks/aas.pdf', 'zh'), 视频: 'https://example.org/video' }
        : { Slides: vhref('/documents/talks/aas.pdf', 'en'), Video: 'https://example.org/video' });
      assert.equal(fast.abstract, 'We present\nnew results.');
      assert.equal(T[0].items[0].kind, lang === 'zh' ? '特邀报告' : 'Invited talk');
      assert.equal(T[2].items[0].kind, lang === 'zh' ? '海报' : 'Poster');
      assert.equal(T[2].items[0].chips[lang === 'zh' ? '幻灯片' : 'Slides'], 'https://example.org/poster.pdf');
      await page.screenshot({ path: path.join(SHOTS, `talks-${lang}-desktop.png`), fullPage: true });
    }
  });

  // ---------------- news ----------------

  await test('news page: by year, newest first, per-language text, safe markdown, links', async () => {
    assert.equal(await go('/news/'), 200);
    assert.deepEqual(await page.$$eval('.news-group .pub-group-title', (h) => h.map((e) => e.textContent.trim())), ['2026', '2025']);
    const N = await newsInfo(page);
    assert.deepEqual(N.map((n) => n.date), ['2026-10-01', '2026-09-15', '2026-08-01', '2026-07-01', '2026-06-01', '2026-05-01', '2025-12-01', '2025-01-01']);
    assert.equal(N[0].dateText, 'Oct 1, 2026');
    assert.match(N[0].html, /Paper <strong>accepted<\/strong> in <a href="https:\/\/example.org\/mnras\?a=1&amp;b=2"/);
    assert.deepEqual(N[0].links.slice(0, 1), ['https://example.org/mnras?a=1&b=2'], 'the link URL keeps its & (no double escaping)');
    assert.equal(N[0].more, '/publications/');
    assert.equal(N[1].text, 'English two');
    assert.equal(N[2].more, '/talks/');
    assert.equal(N[3].text, 'Escaped <b>html</b> & stuff');
    assert.doesNotMatch(N[3].html, /<b>/);
    assert.deepEqual(N[4].links, [], 'the javascript: link is reduced to its text');
    assert.match(N[4].text, /Bad link removed/);
    assert.equal(N[5].text, 'Six');
    assert.equal(N[7].more, 'https://example.org/eight');
    await page.screenshot({ path: path.join(SHOTS, 'news-en-desktop.png'), fullPage: true });

    await go('/zh/news/');
    const Z = await newsInfo(page);
    assert.equal(Z.length, 8);
    assert.equal(Z[1].text, '中文第二条');
    assert.equal(Z[5].text, '第六条');
    assert.equal(Z[0].more, '/publications/');
    assert.equal(Z[2].more, '/zh/talks/');
    assert.equal(Z[0].dateText, '2026年10月1日');
    assert.equal(await page.textContent('main h1'), '近况');
  });

  // ---------------- home ----------------

  await test('home: latest 5 news + All news link, CV button after the configured buttons, academic icons', async () => {
    for (const [prefix, lang] of [['', 'en'], ['/zh', 'zh']]) {
      assert.equal(await go(`${prefix}/`), 200);
      const N = await newsInfo(page, '.home-news');
      assert.equal(N.length, 5);
      assert.equal(N[0].date, '2026-10-01');
      assert.equal(await page.textContent('.home-news-title'), lang === 'zh' ? '近况' : 'News');
      const all = page.locator('.home-news-all');
      assert.equal(await all.getAttribute('href'), `${prefix}/news/`);
      assert.equal((await all.textContent()).trim(), lang === 'zh' ? '全部近况 →' : 'All news →');
      const buttons = await page.$$eval('.profile .buttons a.button', (as) => as.map((a) => [a.textContent.trim(), a.getAttribute('href'), a.className]));
      const cv = buttons[buttons.length - 1];
      assert.deepEqual(cv, [lang === 'zh' ? '简历' : 'CV', vhref('/documents/cv.pdf', lang), 'button button-cv']);
      assert.ok(buttons.length >= 2, 'configured buttons are kept');
      const icons = await page.$$eval('.social-icons a', (as) => as.map((a) => [a.getAttribute('title'), a.getAttribute('href'), !!a.querySelector('svg')]));
      assert.deepEqual(icons.slice(-3), [
        ['NASA ADS', 'https://ui.adsabs.harvard.edu/example', true],
        ['arXiv', 'https://arxiv.org/a/example_1', true],
        ['ORCID', 'https://orcid.org/0000-0002-1825-0097', true],
      ]);
      // icons have the same size as PaperMod's
      const sizes = await page.$$eval('.social-icons a svg', (s) => s.map((e) => `${Math.round(e.getBoundingClientRect().width)}x${Math.round(e.getBoundingClientRect().height)}`));
      assert.equal(new Set(sizes).size, 1, sizes.join(' '));
      await page.screenshot({ path: path.join(SHOTS, `home-${lang}-desktop.png`), fullPage: true });
    }
    // the CV opens in the viewer
    await go('/');
    await page.click('.button-cv');
    await page.waitForURL(/\/viewer\/\?file=/);
    assert.match(page.url(), /lang=en/);
    await page.waitForSelector('canvas, .viewer-error, [data-state]', { timeout: 20000 });
  });

  await test('home (year build, homeCount = 0): no news block', async () => {
    await go('/', Y);
    assert.equal(await page.locator('.home-news').count(), 0);
    assert.equal(await page.locator('.button-cv').count(), 1);
  });

  // ---------------- empty site (the real repository) ----------------

  await test('empty site: friendly empty states, no news block, no CV button, no menu entries', async () => {
    for (const [prefix, texts] of [['', ['No publications listed yet.', 'No talks listed yet.', 'Nothing here yet.']], ['/zh', ['这里还没有列出论文。', '这里还没有列出报告。', '暂时还没有近况。']]]) {
      for (const [i, sec] of ['publications', 'talks', 'news'].entries()) {
        assert.equal(await go(`${prefix}/${sec}/`, E), 200);
        assert.equal((await page.textContent('.academic-empty')).trim(), texts[i]);
        assert.equal(await page.locator('.pub, .talk, .news-item, .pub-profiles').count(), 0);
        if (!prefix) await page.screenshot({ path: path.join(SHOTS, `empty-${sec}.png`) });
      }
      await go(`${prefix}/`, E);
      assert.equal(await page.locator('.home-news, .button-cv').count(), 0);
      const menu = await page.$$eval('#menu a', (as) => as.map((a) => a.getAttribute('href')));
      assert.ok(!menu.some((h) => /publications|talks|news/.test(h)), menu.join(' '));
    }
    const titles = [];
    for (const p of ['/publications/', '/talks/', '/news/', '/zh/publications/', '/zh/talks/', '/zh/news/']) {
      await go(p, E);
      titles.push(await page.textContent('main h1'));
    }
    assert.deepEqual(titles.map((t) => t.trim()), ['Publications', 'Talks & Posters', 'News', '论文', '报告与海报', '近况']);
  });

  // ---------------- background toggle ----------------

  await test('background toggle: desktop fixed bottom-left (unchanged); phones docked in the footer, never over content', async () => {
    await go('/');
    let T = await toggleInfo(page);
    assert.equal(T.position, 'fixed');
    assert.equal(T.docked, false);
    assert.deepEqual([T.rect.x, T.rect.w], [20, 34]);
    assert.equal(T.rect.y + T.rect.h, 900 - 20);
    assert.equal(T.label, 'Background animation');
    assert.equal(T.pressed, 'true', 'autoplay on the home page');
    assert.deepEqual(T.overlaps, []);
    await page.click('.bg-toggle');
    assert.equal((await toggleInfo(page)).pressed, 'false');
    // resizing below 900px docks it into the footer
    await page.setViewportSize({ width: 800, height: 900 });
    await page.waitForFunction(() => document.querySelector('.bg-toggle').classList.contains('is-docked'));
    T = await toggleInfo(page);
    assert.ok(T.docked && T.inFooter && T.position === 'static', JSON.stringify(T));
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.waitForFunction(() => !document.querySelector('.bg-toggle').classList.contains('is-docked'));
    assert.equal((await toggleInfo(page)).position, 'fixed');
    await go('/zh/');
    assert.equal((await toggleInfo(page)).label, '背景动画');
  });

  for (const vp of [{ width: 360, height: 740 }, { width: 390, height: 844 }]) {
    for (const scheme of ['light', 'dark']) {
      await test(`phone ${vp.width}x${vp.height} ${scheme}: no horizontal scroll, toggle docked and clear of content; screenshots`, async () => {
        const pctx = await browser.newContext({ viewport: vp, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: scheme, locale: 'en-US' });
        const pp = await newPage(pctx, origins);
        try {
          const pages = [['/', 'home'], ['/zh/', 'home-zh'], ['/publications/', 'publications'], ['/zh/publications/', 'publications-zh'], ['/talks/', 'talks'],
            ['/news/', 'news'], ['/zh/news/', 'news-zh'], ['/courses/demo-lab/', 'course'], ['/posts/first-physics-note/', 'post']];
          for (const [p, shot] of pages) {
            assert.equal((await pp.goto(F.mock.url + p, { waitUntil: 'load' })).status(), 200, p);
            if (p === '/publications/') await pp.click('#pub-2026-zhong-hi .pub-bibtex summary');
            assert.equal(await pp.evaluate(() => document.documentElement.dataset.theme || (document.body.classList.contains('dark') ? 'dark' : 'light')), scheme, p);
            const h = await noHScroll(pp);
            assert.ok(h.sw <= h.cw, `${p}: scrollWidth ${h.sw} > ${h.cw} (${h.wide.join(', ')})`);
            assert.deepEqual(h.wide, [], p);
            const T = await toggleInfo(pp);
            assert.ok(T.docked && T.inFooter, `${p}: toggle docked in the footer`);
            assert.deepEqual(T.overlaps, [], p);
            assert.ok(T.rect.w >= 32 && T.rect.h >= 32, `${p}: touch target ${T.rect.w}x${T.rect.h}`);
            // scroll through the page: the (docked) toggle never covers a material badge or any other leaf of <main>
            // (the fixed language hint may pass over the footer while scrolling; at the very bottom the footer clears it)
            for (const y of [0, 400, 800, 100000]) {
              await pp.evaluate((y) => window.scrollTo(0, y), y);
              const o = (await toggleInfo(pp)).overlaps;
              assert.deepEqual(y === 100000 ? o : o.filter((x) => x !== 'DIV.lang-hint'), [], `${p} @${y}`);
            }
            await pp.evaluate(() => window.scrollTo(0, 0));
            await pp.screenshot({ path: path.join(SHOTS, `${shot}-${vp.width}-${scheme}.png`), fullPage: true });
          }
          // the theme colours are used (dark mode reads well)
          if (scheme === 'dark') {
            await pp.goto(F.mock.url + '/publications/', { waitUntil: 'load' });
            const c = await pp.evaluate(() => ({
              title: getComputedStyle(document.querySelector('.pub-title')).color,
              chip: getComputedStyle(document.querySelector('.pub-chip')).backgroundColor,
              body: getComputedStyle(document.body).backgroundColor,
            }));
            assert.deepEqual(c, { title: 'rgb(218, 218, 219)', chip: 'rgb(46, 46, 51)', body: 'rgb(29, 30, 32)' });
          }
          assert.deepEqual(pp.problems, []);
        } finally {
          await pctx.close();
        }
      });
    }
  }

  await test('no page errors on the desktop pages', async () => {
    assert.deepEqual(page.problems, []);
  });

  await browser.close();
  await F.mock.close();
  await Y.mock.close();
  await E.mock.close();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed. Screenshots: ${SHOTS}`);
  if (failed.length) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
