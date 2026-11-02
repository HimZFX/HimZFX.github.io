// tests/admin/e2e-academic.mjs — Playwright end-to-end test for the 「学术」 view (views/academic.js), the 简历 CV card and
// the academic social icons in 首页设置 (views/profile.js).
//
// Covers: paste a real-looking NASA ADS BibTeX export (2 entries) → every field filled → pick the other entry and back →
// upload the paper PDF (same commit) → save → data/publications/<id>.yaml is EXACTLY the expected text; a second paper
// typed by hand (validation, auto file name, 已投稿与准备中 group); edit (one commit, only the YAML); conflict on save
// (someone else changed the same file → reload keeps my edit AND takes their untouched field); 论文设置 written
// surgically to params.toml (myNames bold, ORCID normalised, groupBy year regroups the list); 「在顶部菜单显示」 patches
// both _index files surgically (weight after the existing menu items, comments and body kept), creates missing pages,
// removes the entry again, warns while there are no entries; talks CRUD (upcoming / past, slides PDF upload into
// static/documents/talks/, delete together with the PDF); news CRUD (quick add, per-language override, Chinese-only
// text → file name, edit, delete, homeCount); 简历 CV upload (safe original file name, params.cv, preview link), replace
// (old file deleted), social icons ORCID / NASA ADS added through the 首页设置 form (normalised URLs); phone 390 / 360
// without horizontal scroll; finally exportTo + Hugo build: /, /zh/, /publications/, /zh/publications/, /talks/, /news/
// show the entries (skipped with a notice when the site templates are not there yet).
//
// Run from the repo root:   node tests/admin/e2e-academic.mjs
// Env:
//   ACADEMIC_E2E_DIR  where the Hugo build + screenshots go (default: $ADMIN_TEST_TMP/e2e-academic or <os tmp>/admin-e2e-academic)
//   HUGO_BIN          Hugo binary (see mock-github.mjs)
//   ONLY=<substr>     run only steps whose name contains this (steps share state; debugging only)

import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startMock, buildSite, openAdmin, REPO_ROOT } from './mock-github.mjs';
import { parse as parseToml } from '../../static/admin/vendor/smol-toml/index.js';
import * as yaml from '../../static/admin/vendor/js-yaml/js-yaml.mjs';
import { newsIdFor, todayISO } from '../../static/admin/js/academic.js';

const { chromium } = createRequire(import.meta.url)('playwright');

const OUT = path.resolve(process.env.ACADEMIC_E2E_DIR
  || (process.env.ADMIN_TEST_TMP ? path.join(process.env.ADMIN_TEST_TMP, 'e2e-academic') : path.join(os.tmpdir(), 'admin-e2e-academic')));
const SITE_DIR = path.join(OUT, 'site');
const EXPORT_DIR = path.join(OUT, 'export');
const BUILD_DIR = path.join(OUT, 'site-after');
const SHOTS = path.join(OUT, 'screenshots');
const ADMIN_DIR = path.join(REPO_ROOT, 'static', 'admin');
const ONLY = process.env.ONLY || '';
fs.rmSync(SITE_DIR, { recursive: true, force: true });
fs.mkdirSync(SITE_DIR, { recursive: true });
fs.mkdirSync(SHOTS, { recursive: true });

const P_PARAMS = 'config/_default/params.toml';
const TODAY = todayISO();

// ---------------------------------------------------------------------------
// tiny runner (sequential; later steps build on earlier ones)

const results = [];
async function step(name, fn) {
  if (ONLY && !name.includes(ONLY)) return;
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
    console.log(`  ✗ ${name}\n      ${String((err && err.stack) || err).split('\n').slice(0, 12).join('\n      ')}`);
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

const tid = (id) => `[data-testid="${id}"]`;
const loadCore = (t) => yaml.load(t, { schema: yaml.CORE_SCHEMA });

function pdfBytes(tag) {
  return Buffer.concat([
    Buffer.from(`%PDF-1.4\n%\xe2\xe3\xcf\xd3\n1 0 obj << /Title (${tag}) >> endobj\n`, 'latin1'),
    Buffer.alloc(2048, 0x20),
    Buffer.from('\n%%EOF\n', 'latin1'),
  ]);
}

/** Front matter + body of a Markdown file (minimal; good enough for the files the admin writes). */
function fmOf(text) {
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
  return m ? { fm: loadCore(m[1]) || {}, fmText: m[1], body: m[2] } : null;
}

function mainWeight(fm) {
  const m = fm && fm.menu;
  if (m && typeof m === 'object' && !Array.isArray(m) && m.main) return typeof m.main === 'object' && m.main.weight != null ? Number(m.main.weight) : (fm.weight ?? null);
  if (m === 'main' || (Array.isArray(m) && m.includes('main'))) return fm.weight ?? null;
  return undefined;
}

// ---------------------------------------------------------------------------
// fixtures

const ADS_EXPORT = String.raw`@ARTICLE{2024ApJ...960..101Z,
       author = {{Zhong}, Fangxiong and {M{\"u}ller}, J{\"o}rg and {van der Berg}, J. -P. and {{\O}stergaard}, Ren{\'e}e and {LIGO Scientific Collaboration} and others},
        title = "{Hydrostatic Equilibrium of {\ion{H}{i}} Gas in Dark Galaxies}",
      journal = {\apj},
     keywords = {Astrophysics - Astrophysics of Galaxies},
         year = 2024,
        month = jan,
       volume = {960},
       number = {2},
          eid = {101},
        pages = {101},
          doi = {10.3847/1538-4357/ad0b1c},
archivePrefix = {arXiv},
       eprint = {2310.01234},
 primaryClass = {astro-ph.GA},
       adsurl = {https://ui.adsabs.harvard.edu/abs/2024ApJ...960..101Z},
      adsnote = {Provided by the SAO/NASA Astrophysics Data System}
}

@ARTICLE{2026arXiv260301234Z,
       author = {{Zhong}, Fangxiong and {Wang}, Xiao-Ming},
        title = "{A Preprint on Dark Galaxies}",
      journal = {arXiv e-prints},
         year = 2026,
        month = mar,
          eid = {arXiv:2603.01234},
        pages = {arXiv:2603.01234},
archivePrefix = {arXiv},
       eprint = {2603.01234},
       adsurl = {https://ui.adsabs.harvard.edu/abs/2026arXiv260301234Z},
}
`;
const FIRST_RAW = ADS_EXPORT.slice(0, ADS_EXPORT.indexOf('\n\n@ARTICLE{2026'));
const PUB1 = 'data/publications/2024apj-960-101z.yaml';
const PAPER_PDF = 'static/documents/papers/Zhong-2024-dark-galaxies.pdf';
const PUB1_TEXT = [
  'id: "2024apj-960-101z"',
  'title: "Hydrostatic Equilibrium of H I Gas in Dark Galaxies"',
  'authors:',
  '  - "Zhong, F."',
  '  - "Müller, J."',
  '  - "van der Berg, J.-P."',
  '  - "Østergaard, R."',
  '  - "LIGO Scientific Collaboration"',
  '  - "et al."',
  'year: 2024',
  'month: 1',
  'venue: "ApJ"',
  'volume: "960"',
  'pages: "101"',
  'status: "published"',
  'kind: "refereed"',
  'selected: true',
  'arxiv: "2310.01234"',
  'ads: "2024ApJ...960..101Z"',
  'doi: "10.3847/1538-4357/ad0b1c"',
  'pdf: "/documents/papers/Zhong-2024-dark-galaxies.pdf"',
  'bibtex: |-',
  ...FIRST_RAW.split('\n').map((l) => (l ? '  ' + l : '')),
  '',
].join('\n');

const PUB_INDEX_EN = '---\ntitle: "Publications"\n# shown at the top of the page\ndescription: "Papers, preprints and other writing."\n---\n\nSelected papers are marked with a star.\n';
const PUB_INDEX_ZH = '---\ntitle: "论文"\ndescription: "论文、预印本与其他写作。"\n---\n';

// ---------------------------------------------------------------------------

let mock;
let browser;
let page;
const pageErrors = [];

async function gotoAcademic(tab = 'publications') {
  await page.evaluate(() => { location.hash = '#/posts'; });
  await page.waitForSelector('body[data-view-ready="posts"]', { state: 'attached' });
  await page.evaluate((t) => { location.hash = `#/academic?tab=${t}`; }, tab);
  await page.waitForSelector('body[data-view-ready="academic"]', { state: 'attached' });
  await page.waitForSelector(tid(`academic-list-${tab}`));
}

async function waitCommits(n, timeout = 20000) {
  await until(() => mock.commits.length >= n, { timeout, msg: `${n} commits (have ${mock.commits.length})` });
  await page.waitForSelector(tid('overlay'), { state: 'detached', timeout: 15000 }).catch(() => {});
}

const lastCommit = () => mock.commits[mock.commits.length - 1];
const changedPaths = (c) => c.changes.map((x) => `${x.status} ${x.path}`);

async function pickFile(buttonSel, file) {
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click(buttonSel)]);
  await chooser.setFiles(file);
}

async function rowCount(testid) {
  return page.$$eval(tid(testid), (els) => els.length);
}

try {
  mock = await startMock({ siteDir: SITE_DIR, adminDir: ADMIN_DIR, runDelayMs: 300 });
  // a known starting point for the menu tests: publications pages hand-written (with a comment and a body),
  // talks pages missing (the switch has to create them), news pages as shipped
  const seed = { 'content/publications/_index.md': PUB_INDEX_EN, 'content/publications/_index.zh.md': PUB_INDEX_ZH };
  for (const p of ['content/talks/_index.md', 'content/talks/_index.zh.md']) if (mock.readFile(p) !== undefined) seed[p] = null;
  mock.setFiles(seed, 'test: seed academic pages');
  browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'zh-CN' });
  page = await context.newPage();
  page.on('pageerror', (e) => pageErrors.push(e.message));
  if (process.env.DEBUG) page.on('console', (m) => console.log('[console]', m.type(), m.text()));
  await openAdmin(page, mock);

  await step('navigation: 学术 in the sidebar; empty states and menu hints', async () => {
    await page.click(tid('nav-academic'));
    await page.waitForSelector('body[data-view-ready="academic"]', { state: 'attached' });
    assert.equal(await page.getAttribute(tid('nav-academic'), 'aria-current'), 'page');
    assert.equal(await page.textContent('#page-title'), '学术');
    assert.equal(await page.getAttribute(tid('academic-tab-publications'), 'aria-selected'), 'true');
    assert.match(await page.textContent(tid('academic-list-publications')), /还没有论文/);
    assert.ok(await page.isVisible(tid('academic-menu-hint-publications')), 'hint: add content first');
    assert.equal(await page.isChecked(tid('academic-menu-publications')), false);
    await page.click(tid('academic-tab-talks'));
    await page.waitForSelector(tid('academic-list-talks'));
    assert.equal(await page.evaluate(() => location.hash), '#/academic?tab=talks');
    assert.match(await page.textContent(tid('academic-list-talks')), /还没有报告/);
    await page.click(tid('academic-tab-news'));
    await page.waitForSelector(tid('news-empty'));
    await page.click(tid('academic-tab-publications'));
    await page.screenshot({ path: path.join(SHOTS, 'empty.png'), fullPage: true });
  });

  await step('paper: paste ADS BibTeX → fields filled; pick the other entry and back', async () => {
    await page.click(tid('pub-add'));
    await page.waitForSelector(tid('pub-form'));
    await page.fill(tid('pub-bibtex'), ADS_EXPORT);
    await until(async () => (await page.inputValue(tid('pub-title'))) !== '', { msg: 'auto-parse' });
    const v = async (k) => page.inputValue(tid(`pub-${k}`));
    assert.equal(await v('title'), 'Hydrostatic Equilibrium of H I Gas in Dark Galaxies');
    assert.equal(await v('authors'), 'Zhong, F.\nMüller, J.\nvan der Berg, J.-P.\nØstergaard, R.\nLIGO Scientific Collaboration\net al.');
    assert.deepEqual([await v('year'), await v('month'), await v('venue'), await v('volume'), await v('pages'), await v('status'), await v('kind')],
      ['2024', '1', 'ApJ', '960', '101', 'published', 'refereed']);
    assert.deepEqual([await v('arxiv'), await v('ads'), await v('doi'), await v('id')],
      ['2310.01234', '2024ApJ...960..101Z', '10.3847/1538-4357/ad0b1c', '2024apj-960-101z']);
    assert.equal(await page.inputValue(tid('pub-bibtex-raw')), FIRST_RAW);
    assert.match(await page.textContent(tid('pub-bibtex-status')), /已填入/);
    // two entries → a picker
    await page.selectOption(tid('pub-bibtex-pick'), '1');
    assert.equal(await v('title'), 'A Preprint on Dark Galaxies');
    assert.deepEqual([await v('kind'), await v('status'), await v('arxiv'), await v('pages'), await v('id')], ['preprint', 'submitted', '2603.01234', '', '2026arxiv260301234z']);
    await page.selectOption(tid('pub-bibtex-pick'), '0');
    assert.equal(await v('id'), '2024apj-960-101z');
    await page.check(tid('pub-selected'));
  });

  await step('paper: upload the PDF (refuses non-PDF), save → ONE commit with the exact YAML + the PDF', async () => {
    // a non-PDF is refused with a message
    await pickFile(tid('pub-pdf-upload'), { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') });
    await page.waitForSelector('.toast >> text=只能上传 PDF');
    assert.equal(await page.inputValue(tid('pub-pdf')), '');
    const pdf = pdfBytes('paper');
    await pickFile(tid('pub-pdf-upload'), { name: 'Zhong 2024 dark galaxies.pdf', mimeType: 'application/pdf', buffer: pdf });
    await until(async () => (await page.inputValue(tid('pub-pdf'))) === '/documents/papers/Zhong-2024-dark-galaxies.pdf', { msg: 'pdf path' });
    assert.match(await page.textContent(tid('pub-pdf-note')), /待发布/);
    await page.screenshot({ path: path.join(SHOTS, 'paper-form.png'), fullPage: true });
    const n = mock.commits.length;
    await page.click(tid('pub-form-save'));
    await waitCommits(n + 1);
    await page.waitForSelector(tid('pub-form'), { state: 'detached' });
    const c = lastCommit();
    assert.equal(c.message, 'admin: 添加论文《Hydrostatic Equilibrium of H I Gas in Dark Galaxies》');
    assert.deepEqual(changedPaths(c), [`added ${PUB1}`, `added ${PAPER_PDF}`]);
    assert.equal(mock.readFile(PUB1), PUB1_TEXT);
    assert.ok(mock.readBytes(PAPER_PDF).equals(pdf), 'PDF byte-exact');
    await page.waitForSelector(`${tid('pub-row')}[data-id="2024apj-960-101z"]`);
    assert.equal(await page.textContent(`${tid('academic-count-publications')}`), '1');
  });

  await step('paper: typed by hand → validation, auto file name, in-prep goes to 已投稿与准备中', async () => {
    await page.click(tid('pub-add'));
    await page.waitForSelector(tid('pub-form'));
    const n = mock.commits.length;
    await page.click(tid('pub-form-save'));
    await page.waitForSelector(`${tid('err-title')}:not([hidden])`);
    assert.match(await page.textContent(tid('err-authors')), /至少/);
    assert.match(await page.textContent(tid('err-year')), /年份/);
    assert.equal(mock.commits.length, n, 'nothing published');
    // identifiers that the site would drop are refused here (regression: javascript: / junk used to be saved as is)
    await page.fill(tid('pub-doi'), 'javascript:alert(1)');
    await page.fill(tid('pub-arxiv'), 'see the paper');
    await page.click(tid('pub-form-save'));
    await page.waitForSelector(`${tid('err-doi')}:not([hidden])`);
    assert.match(await page.textContent(tid('err-doi')), /10\.xxxx/);
    assert.match(await page.textContent(tid('err-arxiv')), /2603\.01234/);
    assert.equal(mock.commits.length, n, 'nothing published');
    await page.fill(tid('pub-doi'), '');
    await page.fill(tid('pub-arxiv'), '');
    await page.fill(tid('pub-title'), 'Neutral Hydrogen Census of Nearby Dark Galaxies');
    await page.fill(tid('pub-authors'), 'Zhong, F.\nDoe, J.');
    await page.selectOption(tid('pub-status'), 'in-prep');
    await page.fill(tid('pub-note'), 'Draft available on request');
    await page.click(tid('pub-title'));
    await until(async () => (await page.inputValue(tid('pub-id'))) === 'zhongneutral', { msg: 'auto id' });
    await page.click(tid('pub-form-save'));
    await waitCommits(n + 1);
    await page.waitForSelector(tid('pub-form'), { state: 'detached' });
    assert.equal(mock.readFile('data/publications/zhongneutral.yaml'), [
      'id: "zhongneutral"', 'title: "Neutral Hydrogen Census of Nearby Dark Galaxies"', 'authors:', '  - "Zhong, F."', '  - "Doe, J."',
      'status: "in-prep"', 'kind: "refereed"', 'note: "Draft available on request"', '',
    ].join('\n'));
    const groups = await page.$$eval(tid('pub-group'), (els) => els.map((g) => [g.dataset.key, [...g.querySelectorAll('[data-testid="pub-row"]')].map((r) => r.dataset.id)]));
    assert.deepEqual(groups, [['refereed', ['2024apj-960-101z']], ['pending', ['zhongneutral']]]);
  });

  await step('paper: edit → one commit, only the YAML, canonical rewrite', async () => {
    await page.click(`${tid('pub-row')}[data-id="2024apj-960-101z"] ${tid('pub-edit')}`);
    await page.waitForSelector(tid('pub-form'));
    assert.equal(await page.inputValue(tid('pub-id')), '2024apj-960-101z');
    assert.equal(await page.getAttribute(tid('pub-id'), 'readonly'), '');
    assert.equal(await page.inputValue(tid('pub-bibtex')), '', 'the paste box starts empty when editing');
    await page.fill(tid('pub-note'), 'Highlighted by AAS Nova');
    await page.fill(tid('pub-code'), 'https://github.com/HimZFX/hi-dark');
    const n = mock.commits.length;
    await page.click(tid('pub-form-save'));
    await waitCommits(n + 1);
    const c = lastCommit();
    assert.equal(c.message, 'admin: 修改论文《Hydrostatic Equilibrium of H I Gas in Dark Galaxies》');
    assert.deepEqual(changedPaths(c), [`modified ${PUB1}`]);
    const want = PUB1_TEXT.replace('pdf: "/documents/papers/Zhong-2024-dark-galaxies.pdf"\n',
      'pdf: "/documents/papers/Zhong-2024-dark-galaxies.pdf"\ncode: "https://github.com/HimZFX/hi-dark"\nnote: "Highlighted by AAS Nova"\n');
    assert.equal(mock.readFile(PUB1), want);
  });

  await step('paper: conflict on save → reload keeps my edit and takes their untouched field', async () => {
    await page.click(`${tid('pub-row')}[data-id="2024apj-960-101z"] ${tid('pub-edit')}`);
    await page.waitForSelector(tid('pub-form'));
    await page.fill(tid('pub-venue'), 'The Astrophysical Journal');
    // someone else edits the same file on GitHub meanwhile
    mock.setFile(PUB1, mock.readFile(PUB1).replace('note: "Highlighted by AAS Nova"', 'note: "AAS Nova highlight (edited on GitHub)"'));
    const n = mock.commits.length;
    await page.click(tid('pub-form-save'));
    await page.waitForSelector(tid('conflict-reload'));
    assert.match(await page.textContent('.modal'), new RegExp(PUB1.replace(/\./g, '\\.')));
    await page.click(tid('conflict-reload'));
    await until(async () => (await page.inputValue(tid('pub-note'))) === 'AAS Nova highlight (edited on GitHub)', { msg: 'merged form' });
    assert.equal(await page.inputValue(tid('pub-venue')), 'The Astrophysical Journal', 'my edit kept');
    assert.equal(mock.commits.length, n, 'nothing published by the conflicting attempt');
    await page.click(tid('pub-form-save'));
    await waitCommits(n + 1);
    await page.waitForSelector(tid('pub-form'), { state: 'detached' });
    const data = loadCore(mock.readFile(PUB1));
    assert.equal(data.venue, 'The Astrophysical Journal');
    assert.equal(data.note, 'AAS Nova highlight (edited on GitHub)');
  });

  await step('论文设置: myNames / ORCID / groupBy written surgically to params.toml; list regrouped, my name bold', async () => {
    const before = mock.readFile(P_PARAMS);
    await page.click(`${tid('academic-settings-publications')} summary`);
    await page.fill(tid('pub-myNames'), 'Zhong, F.\nZhong, Fangxiong\n');
    await page.fill(tid('pub-orcid'), '0000-0002-1825-0097');
    await page.click(tid('pub-scholar'));
    assert.equal(await page.inputValue(tid('pub-orcid')), 'https://orcid.org/0000-0002-1825-0097');
    await page.selectOption(tid('pub-groupBy'), 'year');
    const n = mock.commits.length;
    await page.click(tid('academic-settings-save-publications'));
    await waitCommits(n + 1);
    const c = lastCommit();
    assert.equal(c.message, 'admin: 更新论文设置');
    assert.deepEqual(changedPaths(c), [`modified ${P_PARAMS}`]);
    const after = mock.readFile(P_PARAMS);
    const cfg = parseToml(after);
    assert.deepEqual(cfg.publications.myNames, ['Zhong, F.', 'Zhong, Fangxiong']);
    assert.equal(cfg.publications.orcid, 'https://orcid.org/0000-0002-1825-0097');
    assert.equal(cfg.publications.groupBy, 'year');
    // every other line of params.toml is untouched (comments included)
    const beforeLines = before.split('\n').filter((l) => !/^\s*(myNames|orcid|groupBy)\s*=/.test(l));
    const afterLines = after.split('\n');
    for (const l of beforeLines) assert.ok(afterLines.includes(l), `line lost: ${l}`);
    const oldCfg = parseToml(before);
    for (const k of Object.keys(oldCfg)) if (k !== 'publications') assert.deepEqual(cfg[k], oldCfg[k], `[${k}] unchanged`);
    await until(async () => (await page.$$eval(tid('pub-group'), (els) => els.map((g) => g.dataset.key))).join() === ',2024', { msg: 'grouped by year' });
    assert.ok(await page.isVisible(`${tid('pub-row')}[data-id="2024apj-960-101z"] .ac-me`), 'my name in bold');
    assert.equal(await page.textContent(`${tid('pub-row')}[data-id="2024apj-960-101z"] .ac-me`), 'Zhong, F.');
  });

  let menuWeight;
  await step('menu switch: publications → both _index files patched surgically (weight after the others)', async () => {
    const files = mock.files();
    const weights = [];
    for (const [p, buf] of files) {
      if (!/^content\/([^/]+\.md|[^/]+\/_index(\.[a-z]+)?\.md)$/.test(p) || p.startsWith('content/publications/')) continue;
      const w = mainWeight((fmOf(buf.toString('utf8')) || {}).fm);
      if (typeof w === 'number') weights.push(w);
    }
    menuWeight = Math.floor(Math.max(...weights) / 10) * 10 + 10;
    const n = mock.commits.length;
    await page.click(tid('academic-menu-publications'));
    await waitCommits(n + 1);
    const c = lastCommit();
    assert.equal(c.message, 'admin: 在顶部菜单显示「论文」');
    assert.deepEqual(changedPaths(c), ['modified content/publications/_index.md', 'modified content/publications/_index.zh.md']);
    assert.equal(mock.readFile('content/publications/_index.md'),
      `---\ntitle: "Publications"\n# shown at the top of the page\ndescription: "Papers, preprints and other writing."\nmenu: { main: { weight: ${menuWeight} } }\n---\n\nSelected papers are marked with a star.\n`);
    assert.equal(fmOf(mock.readFile('content/publications/_index.zh.md')).fm.menu.main.weight, menuWeight);
    await until(() => page.isChecked(tid('academic-menu-publications')), { msg: 'switch on' });
    assert.equal(await page.$(tid('academic-menu-empty-publications')), null, 'has entries → no warning');
  });

  await step('menu switch: talks pages are missing → created with the menu entry; warning while empty; off again', async () => {
    await page.click(tid('academic-tab-talks'));
    await page.waitForSelector(tid('academic-list-talks'));
    let n = mock.commits.length;
    await page.click(tid('academic-menu-talks'));
    await waitCommits(n + 1);
    let c = lastCommit();
    assert.equal(c.message, 'admin: 在顶部菜单显示「报告与海报」');
    assert.deepEqual(changedPaths(c), ['added content/talks/_index.md', 'added content/talks/_index.zh.md']);
    const en = fmOf(mock.readFile('content/talks/_index.md'));
    assert.deepEqual(en.fm, { title: 'Talks & Posters', description: 'Talks, posters and seminars.', menu: { main: { weight: menuWeight + 10 } } });
    assert.deepEqual(fmOf(mock.readFile('content/talks/_index.zh.md')).fm.title, '报告与海报');
    await page.waitForSelector(tid('academic-menu-empty-talks'));
    assert.match(await page.textContent(tid('academic-menu-empty-talks')), /还没有任何报告/);
    // off again: only the menu lines go
    n = mock.commits.length;
    await page.click(tid('academic-menu-talks'));
    await waitCommits(n + 1);
    c = lastCommit();
    assert.equal(c.message, 'admin: 从顶部菜单移除「报告与海报」');
    assert.equal(mock.readFile('content/talks/_index.md'), '---\ntitle: "Talks & Posters"\ndescription: "Talks, posters and seminars."\n---\n');
    assert.equal(fmOf(mock.readFile('content/talks/_index.zh.md')).fm.menu, undefined);
    await until(async () => !(await page.isChecked(tid('academic-menu-talks'))), { msg: 'switch off' });
  });

  await step('talks: add an upcoming talk and a past poster with an uploaded PDF; exact YAML; upcoming / past lists', async () => {
    await page.click(tid('talk-add'));
    await page.waitForSelector(tid('talk-form'));
    await page.fill(tid('talk-title'), 'Dark Galaxies with FAST');
    await page.fill(tid('talk-date'), '2099-01-08');
    await page.fill(tid('talk-event'), 'AAS 393');
    await page.fill(tid('talk-location'), 'Phoenix, AZ');
    await page.selectOption(tid('talk-kind'), 'invited');
    await page.fill(tid('talk-slides'), 'https://example.org/slides');
    await until(async () => (await page.inputValue(tid('talk-id'))) === '2099-01-08-aas-393', { msg: 'talk id' });
    let n = mock.commits.length;
    await page.click(tid('talk-form-save'));
    await waitCommits(n + 1);
    await page.waitForSelector(tid('talk-form'), { state: 'detached' });
    assert.equal(mock.readFile('data/talks/2099-01-08-aas-393.yaml'), [
      'id: "2099-01-08-aas-393"', 'title: "Dark Galaxies with FAST"', 'event: "AAS 393"', 'location: "Phoenix, AZ"', 'date: "2099-01-08"',
      'kind: "invited"', 'slides: "https://example.org/slides"', '',
    ].join('\n'));

    await page.click(tid('talk-add'));
    await page.waitForSelector(tid('talk-form'));
    await page.fill(tid('talk-title'), 'HI in Dark Galaxies (poster)');
    await page.fill(tid('talk-date'), '2025-06-10');
    await page.fill(tid('talk-event'), 'Cosmic Dawn 2025');
    await page.selectOption(tid('talk-kind'), 'poster');
    await page.fill(tid('talk-abstract'), 'First line.\n\nSecond paragraph.');
    const pdf = pdfBytes('poster');
    await pickFile(tid('talk-slides-upload'), { name: 'poster v2.pdf', mimeType: 'application/pdf', buffer: pdf });
    await until(async () => (await page.inputValue(tid('talk-slides'))) === '/documents/talks/poster-v2.pdf', { msg: 'slides path' });
    n = mock.commits.length;
    await page.click(tid('talk-form-save'));
    await waitCommits(n + 1);
    await page.waitForSelector(tid('talk-form'), { state: 'detached' });
    const c = lastCommit();
    assert.equal(c.message, 'admin: 添加报告《HI in Dark Galaxies (poster)》');
    assert.deepEqual(changedPaths(c), ['added data/talks/2025-06-10-cosmic-dawn-2025.yaml', 'added static/documents/talks/poster-v2.pdf']);
    assert.equal(mock.readFile('data/talks/2025-06-10-cosmic-dawn-2025.yaml'), [
      'id: "2025-06-10-cosmic-dawn-2025"', 'title: "HI in Dark Galaxies (poster)"', 'event: "Cosmic Dawn 2025"', 'date: "2025-06-10"',
      'kind: "poster"', 'slides: "/documents/talks/poster-v2.pdf"', 'abstract: |-', '  First line.', '', '  Second paragraph.', '',
    ].join('\n'));
    assert.ok(mock.readBytes('static/documents/talks/poster-v2.pdf').equals(pdf));
    assert.deepEqual(await page.$$eval(`${tid('talks-upcoming')} ${tid('talk-row')}`, (els) => els.map((e) => e.dataset.id)), ['2099-01-08-aas-393']);
    assert.deepEqual(await page.$$eval(`${tid('talks-past')} ${tid('talk-row')}`, (els) => els.map((e) => e.dataset.id)), ['2025-06-10-cosmic-dawn-2025']);
    await page.waitForSelector(tid('academic-menu-hint-talks'), { state: 'detached' });
  });

  await step('talks: edit; delete one together with its uploaded PDF (one commit)', async () => {
    await page.click(`${tid('talk-row')}[data-id="2025-06-10-cosmic-dawn-2025"] ${tid('talk-edit')}`);
    await page.waitForSelector(tid('talk-form'));
    assert.equal(await page.$(tid('talk-id')), null, 'file name cannot change when editing');
    assert.ok(await page.isVisible(tid('talk-slides-preview')), 'preview link for an existing PDF');
    await page.fill(tid('talk-location'), 'Online');
    let n = mock.commits.length;
    await page.click(tid('talk-form-save'));
    await waitCommits(n + 1);
    assert.equal(loadCore(mock.readFile('data/talks/2025-06-10-cosmic-dawn-2025.yaml')).location, 'Online');
    assert.deepEqual(changedPaths(lastCommit()), ['modified data/talks/2025-06-10-cosmic-dawn-2025.yaml']);
    // a throw-away talk with a PDF, deleted together with the file
    await page.click(tid('talk-add'));
    await page.waitForSelector(tid('talk-form'));
    await page.fill(tid('talk-title'), 'Temporary seminar');
    await page.fill(tid('talk-date'), '2024-02-02');
    await pickFile(tid('talk-slides-upload'), { name: 'tmp.pdf', mimeType: 'application/pdf', buffer: pdfBytes('tmp') });
    await until(async () => (await page.inputValue(tid('talk-slides'))) === '/documents/talks/tmp.pdf', { msg: 'slides path' });
    n = mock.commits.length;
    await page.click(tid('talk-form-save'));
    await waitCommits(n + 1);
    await page.waitForSelector(tid('talk-form'), { state: 'detached' });
    await page.click(`${tid('talk-row')}[data-id="2024-02-02-temporary-seminar"] ${tid('talk-delete')}`);
    await page.waitForSelector(tid('academic-delete-file'));
    assert.equal(await page.isChecked(tid('academic-delete-file')), true);
    n = mock.commits.length;
    await page.click(tid('confirm-ok'));
    await waitCommits(n + 1);
    assert.equal(lastCommit().message, 'admin: 删除报告《Temporary seminar》');
    assert.deepEqual(changedPaths(lastCommit()), ['removed data/talks/2024-02-02-temporary-seminar.yaml', 'removed static/documents/talks/tmp.pdf']);
    await page.waitForSelector(`${tid('talk-row')}[data-id="2024-02-02-temporary-seminar"]`, { state: 'detached' });
    assert.equal(await rowCount('talk-row'), 2);
  });

  const NEWS1 = newsIdFor({ date: TODAY, text: 'Our paper on dark galaxies was accepted by **ApJ**!' });
  await step('news: quick add with a Chinese override; Chinese-only text; edit; delete; homeCount', async () => {
    await page.click(tid('academic-tab-news'));
    await page.waitForSelector(tid('news-quick'));
    assert.equal(await page.inputValue(tid('news-date')), TODAY, 'date defaults to today');
    await page.fill(tid('news-text'), 'Our paper on dark galaxies was accepted by **ApJ**!');
    await page.click(`${tid('news-langs')} summary`);
    await page.fill(tid('news-text_zh'), '关于暗星系的论文被 **ApJ** 接收了！');
    await page.fill(tid('news-link'), 'publications/');
    let n = mock.commits.length;
    await page.click(tid('news-add'));
    await waitCommits(n + 1);
    assert.equal(lastCommit().message, `admin: 添加近况（${TODAY}）`);
    assert.equal(mock.readFile(`data/news/${NEWS1}.yaml`), [
      `date: "${TODAY}"`, 'text: "Our paper on dark galaxies was accepted by **ApJ**!"', 'text_zh: "关于暗星系的论文被 **ApJ** 接收了！"', 'link: "publications/"', '',
    ].join('\n'));
    await page.waitForSelector(`${tid('news-row')}[data-id="${NEWS1}"]`);
    assert.equal(await page.inputValue(tid('news-text')), '', 'quick form cleared');

    await page.fill(tid('news-text'), '下周去 FAST 观测');
    await page.fill(tid('news-date'), '2026-10-01');
    n = mock.commits.length;
    await page.click(tid('news-add'));
    await waitCommits(n + 1);
    assert.deepEqual(changedPaths(lastCommit()), ['added data/news/2026-10-01-fast.yaml']);
    // a third one, then delete it
    await page.fill(tid('news-text'), '测试');
    await page.fill(tid('news-date'), '2026-09-09');
    n = mock.commits.length;
    await page.click(tid('news-add'));
    await waitCommits(n + 1);
    assert.deepEqual(changedPaths(lastCommit()), ['added data/news/2026-09-09-news.yaml']);
    assert.deepEqual(await page.$$eval(tid('news-row'), (els) => els.map((e) => e.dataset.id)), [NEWS1, '2026-10-01-fast', '2026-09-09-news'], 'newest first');
    await page.click(`${tid('news-row')}[data-id="2026-09-09-news"] ${tid('news-delete')}`);
    n = mock.commits.length;
    await page.click(tid('confirm-ok'));
    await waitCommits(n + 1);
    assert.deepEqual(changedPaths(lastCommit()), ['removed data/news/2026-09-09-news.yaml']);
    // edit: add an English override to the Chinese-only one
    await page.click(`${tid('news-row')}[data-id="2026-10-01-fast"] ${tid('news-edit')}`);
    await page.waitForSelector(tid('news-form'));
    await page.click(`${tid('news-form')} ${tid('news-langs')} summary`);
    await page.fill(`${tid('news-form')} ${tid('news-text_en')}`, 'Observing at FAST next week');
    n = mock.commits.length;
    await page.click(tid('news-form-save'));
    await waitCommits(n + 1);
    assert.equal(mock.readFile('data/news/2026-10-01-fast.yaml'), 'date: "2026-10-01"\ntext: "下周去 FAST 观测"\ntext_en: "Observing at FAST next week"\n');
    // homeCount
    await page.click(`${tid('academic-settings-news')} summary`);
    await page.fill(tid('news-homeCount'), '1');
    n = mock.commits.length;
    await page.click(tid('academic-settings-save-news'));
    await waitCommits(n + 1);
    assert.equal(parseToml(mock.readFile(P_PARAMS)).news.homeCount, 1);
    assert.deepEqual(changedPaths(lastCommit()), [`modified ${P_PARAMS}`]);
  });

  await step('paper: delete the hand-typed one', async () => {
    await page.click(tid('academic-tab-publications'));
    await page.waitForSelector(`${tid('pub-row')}[data-id="zhongneutral"]`);
    await page.click(`${tid('pub-row')}[data-id="zhongneutral"] ${tid('pub-delete')}`);
    await page.waitForSelector(tid('confirm-ok'));
    assert.equal(await page.$(tid('academic-delete-file')), null, 'no PDF → no file checkbox');
    const n = mock.commits.length;
    await page.click(tid('confirm-ok'));
    await waitCommits(n + 1);
    assert.equal(lastCommit().message, 'admin: 删除论文《Neutral Hydrogen Census of Nearby Dark Galaxies》');
    assert.deepEqual(changedPaths(lastCommit()), ['removed data/publications/zhongneutral.yaml']);
    await page.waitForSelector(`${tid('pub-row')}[data-id="zhongneutral"]`, { state: 'detached' });
  });

  const CV1 = 'static/documents/cv/My-CV-2026.pdf';
  const CV2 = 'static/documents/cv/Zhong_CV_Nov.pdf';
  await step('首页设置: 简历 CV upload → PDF + params.cv in one commit; preview link; replace deletes the old file', async () => {
    await page.evaluate(() => { location.hash = '#/profile'; });
    await page.waitForSelector('body[data-view-ready="profile"]', { state: 'attached' });
    await page.waitForSelector(tid('cv-empty'));
    assert.equal(await page.$(tid('preview-cv')), null, 'no CV yet → no CV button in the preview');
    const before = mock.readFile(P_PARAMS);
    const pdf = pdfBytes('cv1');
    let n = mock.commits.length;
    await pickFile(tid('cv-upload'), { name: 'My CV (2026).pdf', mimeType: 'application/pdf', buffer: pdf });
    await page.waitForSelector(tid('cv-confirm'));
    await page.click(tid('confirm-ok'));
    await waitCommits(n + 1);
    let c = lastCommit();
    assert.equal(c.message, 'admin: 上传简历 CV（My-CV-2026.pdf）');
    assert.deepEqual(changedPaths(c), [`modified ${P_PARAMS}`, `added ${CV1}`]);
    assert.ok(mock.readBytes(CV1).equals(pdf));
    const after = mock.readFile(P_PARAMS);
    assert.equal(parseToml(after).cv, '/documents/cv/My-CV-2026.pdf');
    const diff = after.split('\n').filter((l) => !before.split('\n').includes(l));
    assert.deepEqual(diff, ['cv = "/documents/cv/My-CV-2026.pdf"'], 'only the cv line changes');
    await page.waitForSelector(tid('cv-path'));
    assert.equal(await page.textContent(tid('cv-path')), '/documents/cv/My-CV-2026.pdf');
    assert.equal(await page.getAttribute(tid('cv-preview'), 'href'), `${mock.url}/viewer/?file=%2Fdocuments%2Fcv%2FMy-CV-2026.pdf`);
    assert.ok(await page.isVisible(tid('preview-cv')), 'the home preview shows the CV button');
    // replace
    n = mock.commits.length;
    await pickFile(tid('cv-replace'), { name: 'Zhong_CV_Nov.pdf', mimeType: 'application/pdf', buffer: pdfBytes('cv2') });
    await page.waitForSelector(tid('cv-delete-old'));
    assert.equal(await page.isChecked(tid('cv-delete-old')), true);
    await page.click(tid('confirm-ok'));
    await waitCommits(n + 1);
    c = lastCommit();
    assert.equal(c.message, 'admin: 更换简历 CV（Zhong_CV_Nov.pdf）');
    assert.deepEqual(changedPaths(c), [`modified ${P_PARAMS}`, `removed ${CV1}`, `added ${CV2}`]);
    assert.equal(parseToml(mock.readFile(P_PARAMS)).cv, '/documents/cv/Zhong_CV_Nov.pdf');
    await until(async () => (await page.textContent(tid('cv-path'))) === '/documents/cv/Zhong_CV_Nov.pdf', { msg: 'cv path updated' });
    assert.equal(await page.isDisabled(tid('profile-save')), true, 'the CV card does not leave unsaved changes behind');
  });

  await step('首页设置: social icons ORCID + NASA ADS (normalised, hints) saved through 保存并发布', async () => {
    const before = parseToml(mock.readFile(P_PARAMS));
    const rowsBefore = await rowCount('social-row');
    for (const [icon, input, want] of [
      ['orcid', '0000-0002-1825-0097', 'https://orcid.org/0000-0002-1825-0097'],
      ['ads', 'Zhong, F.', 'https://ui.adsabs.harvard.edu/search/q=author%3A%22Zhong%2C%20F.%22&sort=date%20desc'],
    ]) {
      await page.click(tid('social-add'));
      const row = page.locator(tid('social-row')).last();
      await row.locator(tid('social-icon')).selectOption(icon);
      const url = row.locator(tid('social-url'));
      assert.match(await url.getAttribute('placeholder'), icon === 'orcid' ? /0000-0000/ : /ADS/);
      if (icon === 'orcid') {
        // a wrong check digit warns (does not block)
        await url.fill('0000-0002-1825-0098');
        await url.blur();
        await until(async () => /校验位/.test(await row.textContent()), { msg: 'ORCID checksum warning' });
      }
      await url.fill(input);
      await url.blur();
      assert.equal(await url.inputValue(), want);
    }
    assert.equal(await rowCount('social-row'), rowsBefore + 2);
    assert.ok(!/校验位/.test(await page.locator(tid('social-row')).nth(rowsBefore).textContent()), 'warning gone once the ORCID is right');
    const n = mock.commits.length;
    await page.click(tid('profile-save'));
    await page.waitForSelector(tid('profile-confirm'));
    await page.click(tid('confirm-ok'));
    await waitCommits(n + 1);
    const cfg = JSON.parse(JSON.stringify(parseToml(mock.readFile(P_PARAMS)))); // smol-toml returns null-prototype objects
    assert.deepEqual(cfg.socialIcons.slice(0, before.socialIcons.length), JSON.parse(JSON.stringify(before.socialIcons)), 'existing links unchanged');
    assert.deepEqual(cfg.socialIcons.slice(before.socialIcons.length), [
      { name: 'orcid', url: 'https://orcid.org/0000-0002-1825-0097' },
      { name: 'ads', url: 'https://ui.adsabs.harvard.edu/search/q=author%3A%22Zhong%2C%20F.%22&sort=date%20desc' },
    ]);
    assert.equal(cfg.cv, '/documents/cv/Zhong_CV_Nov.pdf', 'CV kept');
    assert.deepEqual(cfg.profileMode, JSON.parse(JSON.stringify(before.profileMode)), 'profile untouched');
    // the icon list offers the academic icons with Chinese labels
    const opts = await page.$$eval(`${tid('social-row')} ${tid('social-icon')} option`, (els) => els.map((o) => o.value));
    for (const v of ['orcid', 'googlescholar', 'ads', 'arxiv', 'cv', 'bluesky', 'mastodon', 'linkedin', 'researchgate']) assert.ok(opts.includes(v), v);
    await page.screenshot({ path: path.join(SHOTS, 'profile-cv-social.png'), fullPage: true });
  });

  await step('phone 390 / 360: no horizontal scroll on every tab and in the paper form', async () => {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, locale: 'zh-CN' });
    const p = await ctx.newPage();
    p.on('pageerror', (e) => pageErrors.push(e.message));
    await openAdmin(p, mock);
    for (const w of [390, 360]) {
      await p.setViewportSize({ width: w, height: w === 390 ? 844 : 740 });
      for (const tab of ['publications', 'talks', 'news']) {
        await p.evaluate((t) => { location.hash = `#/academic?tab=${t}`; }, tab);
        await p.waitForSelector(`body[data-view-ready="academic"]`, { state: 'attached' });
        await p.waitForSelector(tid(`academic-list-${tab}`));
        await p.waitForTimeout(150);
        assert.ok(await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `${w} ${tab}: horizontal scroll`);
        if (w === 360) await p.screenshot({ path: path.join(SHOTS, `phone-360-${tab}.png`), fullPage: true });
      }
      await p.evaluate(() => { location.hash = '#/posts'; });
      await p.waitForSelector('body[data-view-ready="posts"]', { state: 'attached' });
      await p.evaluate(() => { location.hash = '#/academic?tab=publications'; });
      await p.waitForSelector(tid('pub-add'));
      await p.tap(tid('pub-add'));
      await p.waitForSelector(tid('pub-form'));
      await p.fill(tid('pub-bibtex'), ADS_EXPORT);
      await until(async () => (await p.inputValue(tid('pub-title'))) !== '', { msg: 'auto-parse on phone' });
      await p.waitForTimeout(300);
      const box = await p.$eval('.modal', (m) => ({ w: m.getBoundingClientRect().width, sw: m.scrollWidth, cw: m.clientWidth }));
      assert.ok(box.w <= w + 0.5 && box.sw <= box.cw + 1, `${w}: form fits ${JSON.stringify(box)}`);
      assert.ok(await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `${w}: form horizontal scroll`);
      await p.screenshot({ path: path.join(SHOTS, `phone-${w}-form.png`) });
      await p.tap(tid('pub-form-cancel'));
      await p.waitForSelector(tid('pub-form'), { state: 'detached' });
    }
    // 学术 is a bottom-bar tab on phones
    assert.ok(await p.isVisible(tid('nav-academic')));
    await ctx.close();
  });

  await step('Hugo build of the exported repo: entries on /, /zh/, /publications/, /talks/, /news/', async () => {
    mock.exportTo(EXPORT_DIR);
    const haveTemplates = fs.existsSync(path.join(REPO_ROOT, 'layouts', 'publications', 'list.html'))
      && fs.existsSync(path.join(REPO_ROOT, 'layouts', 'partials', 'index_profile.html'));
    const r = await buildSite({ repoDir: EXPORT_DIR, outDir: BUILD_DIR, baseURL: mock.url + '/' });
    if (r && r.skipped) { console.log('      (Hugo not found — build skipped)'); return; }
    const read = (p) => fs.readFileSync(path.join(BUILD_DIR, p), 'utf8');
    if (!haveTemplates) {
      console.log('      (site templates for publications / the home page are not there yet — only checked that the build succeeds)');
      return;
    }
    const pubsEn = read('publications/index.html');
    const pubsZh = read('zh/publications/index.html');
    for (const html of [pubsEn, pubsZh]) {
      assert.ok(html.includes('Hydrostatic Equilibrium of H I Gas in Dark Galaxies'), 'paper title');
      assert.ok(html.includes('The Astrophysical Journal'), 'venue');
      assert.ok(html.includes('%2Fdocuments%2Fpapers%2FZhong-2024-dark-galaxies.pdf'), 'PDF via the viewer');
      assert.ok(!html.includes('Neutral Hydrogen Census'), 'deleted paper gone');
    }
    assert.ok(/<strong[^>]*>\s*Zhong, F\.\s*<\/strong>/.test(pubsEn), 'my name bold on the site');
    const talks = read('talks/index.html');
    assert.ok(talks.includes('Dark Galaxies with FAST') && talks.includes('HI in Dark Galaxies (poster)'));
    assert.ok(!talks.includes('Temporary seminar'));
    const newsEn = read('news/index.html');
    const newsZh = read('zh/news/index.html');
    assert.ok(newsEn.includes('Our paper on dark galaxies was accepted by') && newsEn.includes('Observing at FAST next week'));
    assert.ok(newsZh.includes('关于暗星系的论文被') && newsZh.includes('下周去 FAST 观测'));
    const homeEn = read('index.html');
    const homeZh = read('zh/index.html');
    // homeCount = 1 → only the newest item on the home page, plus the 「All news」 link
    assert.ok(homeEn.includes('Our paper on dark galaxies was accepted by'), 'latest news on /');
    assert.ok(!homeEn.includes('Observing at FAST next week'), 'homeCount respected');
    assert.ok(homeZh.includes('关于暗星系的论文被'), 'Chinese override on /zh/');
    assert.match(homeEn, /class="button button-cv" href="[^"]*\/viewer\/\?file=%2Fdocuments%2Fcv%2FZhong_CV_Nov\.pdf&(amp;)?lang=en"/);
    assert.match(homeZh, /class="button button-cv" href="[^"]*\/viewer\/\?file=%2Fdocuments%2Fcv%2FZhong_CV_Nov\.pdf&(amp;)?lang=zh"/);
    // menu: publications on, talks off
    const menu = (/<ul id=["']?menu["']?>([\s\S]*?)<\/ul>/.exec(homeEn) || [])[1] || '';
    assert.match(menu, /\/publications\/[^>]*><span>Publications<\/span>/, 'publications in the menu');
    assert.ok(!menu.includes('/talks/') && !menu.includes('/news/'), 'talks / news not in the menu');
    const menuZh = (/<ul id=["']?menu["']?>([\s\S]*?)<\/ul>/.exec(homeZh) || [])[1] || '';
    assert.match(menuZh, /\/zh\/publications\/[^>]*><span>论文<\/span>/, 'publications in the Chinese menu');
    // social icons
    assert.ok(homeEn.includes('https://orcid.org/0000-0002-1825-0097'));
    assert.ok(homeEn.includes('https://ui.adsabs.harvard.edu/search/q=author%3A%22Zhong%2C%20F.%22&amp;sort=date%20desc') || homeEn.includes('https://ui.adsabs.harvard.edu/search/q=author%3A%22Zhong%2C%20F.%22&sort=date%20desc'));
    assert.ok(fs.existsSync(path.join(BUILD_DIR, 'documents', 'cv', 'Zhong_CV_Nov.pdf')));
    assert.ok(!fs.existsSync(path.join(BUILD_DIR, 'documents', 'cv', 'My-CV-2026.pdf')), 'old CV removed');
  });

  await step('简历 CV 移除: a post still links to the CV → the old file is kept by default (regression); otherwise deleted', async () => {
    mock.setFiles({ 'content/posts/cv-link.md': '---\ntitle: "CV link"\ndate: 2026-10-02\ndraft: false\n---\n\n[My CV](/documents/cv/Zhong_CV_Nov.pdf)\n' }, 'test: a post links to the CV');
    await openAdmin(page, mock);
    await page.evaluate(() => { location.hash = '#/profile'; });
    await page.waitForSelector('body[data-view-ready="profile"]', { state: 'attached' });
    await page.waitForSelector(tid('cv-remove'));
    await page.click(tid('cv-remove'));
    await page.waitForSelector(tid('cv-old-refs'));
    assert.match(await page.textContent(tid('cv-old-refs')), /content\/posts\/cv-link\.md/);
    assert.equal(await page.isChecked(tid('cv-delete-old')), false, 'referenced → keep the file by default');
    let n = mock.commits.length;
    await page.click(tid('confirm-ok'));
    await waitCommits(n + 1);
    assert.equal(lastCommit().message, 'admin: 移除简历 CV');
    assert.deepEqual(changedPaths(lastCommit()), [`modified ${P_PARAMS}`]);
    assert.equal(parseToml(mock.readFile(P_PARAMS)).cv, '');
    assert.ok(mock.readBytes(CV2), 'the linked CV file is still there');
    await page.waitForSelector(tid('cv-empty'));
    // upload again, then remove with nothing else pointing at it → the file goes too
    n = mock.commits.length;
    await pickFile(tid('cv-upload'), { name: 'Short CV.pdf', mimeType: 'application/pdf', buffer: pdfBytes('cv3') });
    await page.waitForSelector(tid('cv-confirm'));
    await page.click(tid('confirm-ok'));
    await waitCommits(n + 1);
    await page.waitForSelector(tid('cv-remove'));
    await page.click(tid('cv-remove'));
    await page.waitForSelector(tid('cv-delete-old'));
    assert.equal(await page.$(tid('cv-old-refs')), null);
    assert.equal(await page.isChecked(tid('cv-delete-old')), true);
    n = mock.commits.length;
    await page.click(tid('confirm-ok'));
    await waitCommits(n + 1);
    assert.deepEqual(changedPaths(lastCommit()), [`modified ${P_PARAMS}`, 'removed static/documents/cv/Short-CV.pdf']);
  });

  await step('delete the LAST paper → empty list + 「菜单里有但没内容」 warning; the site still builds with a friendly empty page', async () => {
    await gotoAcademic('publications');
    const ids = await page.$$eval(tid('pub-row'), (els) => els.map((e) => e.dataset.id));
    assert.deepEqual(ids, ['2024apj-960-101z'], 'one paper left');
    await page.click(`${tid('pub-row')}[data-id="2024apj-960-101z"] ${tid('pub-delete')}`);
    await page.waitForSelector(tid('confirm-ok'));
    const n = mock.commits.length;
    await page.click(tid('confirm-ok'));
    await waitCommits(n + 1);
    assert.ok(changedPaths(lastCommit()).includes('removed data/publications/2024apj-960-101z.yaml'));
    await page.waitForSelector(`${tid('pub-row')}`, { state: 'detached' });
    assert.match(await page.textContent(tid('academic-list-publications')), /还没有论文/);
    await page.waitForSelector(tid('academic-menu-empty-publications'));
    const left = [...mock.files().keys()].filter((p) => p.startsWith('data/publications/'));
    assert.deepEqual(left.filter((p) => !p.endsWith('/.gitkeep')), [], 'no data files left');
    if (!fs.existsSync(path.join(REPO_ROOT, 'layouts', 'publications', 'list.html'))) return;
    const exp = path.join(OUT, 'export-empty');
    fs.rmSync(exp, { recursive: true, force: true });
    mock.exportTo(exp);
    // also the case where git dropped the directory entirely (no .gitkeep)
    fs.rmSync(path.join(exp, 'data', 'publications'), { recursive: true, force: true });
    const out = path.join(OUT, 'site-empty');
    await buildSite({ repoDir: exp, outDir: out, baseURL: mock.url + '/' });
    const html = fs.readFileSync(path.join(out, 'publications', 'index.html'), 'utf8');
    assert.match(html, /class="?academic-empty"?/);
  });

  await step('no page errors', async () => {
    assert.deepEqual(pageErrors, []);
  });
} finally {
  if (browser) await browser.close().catch(() => {});
  if (mock) await mock.close().catch(() => {});
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} steps passed${failed.length ? ` — FAILED: ${failed.map((f) => f.name).join('; ')}` : ''}`);
console.log(`screenshots: ${SHOTS}`);
process.exitCode = failed.length ? 1 : 0;
