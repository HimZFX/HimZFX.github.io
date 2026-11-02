// tests/admin/e2e-profile.mjs — Playwright end-to-end test for the 首页设置 view (views/profile.js).
//
// Run from the repo root:   node tests/admin/e2e-profile.mjs
// Env:
//   PROFILE_E2E_DIR  where the Hugo builds + screenshots go (default: <os tmp>/admin-e2e-profile)
//   SKIP_BUILD=1     reuse an existing initial build in PROFILE_E2E_DIR/site (only valid for the same port; the
//                    site is only used for the admin's "查看网站" links, so a stale build is harmless)
//   HUGO_BIN         Hugo binary (see mock-github.mjs)
//
// The admin JS is served live from static/admin (mock adminDir). Every request to another origin
// (cdn.jsdelivr.net, github.io, api.github.com …) is aborted by openAdmin(). Assertions are made on the
// MOCK's resulting files (and on Hugo builds of them), not only on the UI.

import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startMock, buildSite, openAdmin, REPO_ROOT } from './mock-github.mjs';
import { parse as parseToml } from '../../static/admin/vendor/smol-toml/index.js';

const { chromium } = createRequire(import.meta.url)('playwright');

const OUT = path.resolve(process.env.PROFILE_E2E_DIR || path.join(os.tmpdir(), 'admin-e2e-profile'));
const SITE_DIR = path.join(OUT, 'site');
const SHOTS = path.join(OUT, 'screenshots');
const ADMIN_DIR = path.join(REPO_ROOT, 'static', 'admin');
fs.mkdirSync(SHOTS, { recursive: true });

const P_PARAMS = 'config/_default/params.toml';
const P_LANGS = 'config/_default/languages.toml';
const P_HUGO = 'config/_default/hugo.toml';

// ---------------------------------------------------------------------------
// tiny runner (sequential; later steps build on earlier ones)

const results = [];
async function step(name, fn) {
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
    console.log(`  ✗ ${name}\n      ${String((err && err.stack) || err).split('\n').slice(0, 10).join('\n      ')}`);
  }
}

// ---------------------------------------------------------------------------
// helpers

const tid = (id) => `[data-testid="${id}"]`;
const waitView = (page, route) => page.waitForSelector(`body[data-view-ready="${route}"]`, { state: 'attached', timeout: 20000 });

async function gotoProfile(page) {
  await page.evaluate(() => { location.hash = '#/files'; });
  await waitView(page, 'files').catch(() => {});
  await page.evaluate(() => { location.hash = '#/profile'; });
  await waitView(page, 'profile');
  await page.waitForSelector(tid('profile-save'));
}

/** Lines of `before` must appear in `after` in the same order (subsequence). Returns missing lines. */
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

/** Multiset line diff. */
function lineDiff(before, after) {
  const count = (t) => {
    const m = new Map();
    for (const l of t.split('\n')) m.set(l, (m.get(l) || 0) + 1);
    return m;
  };
  const b = count(before);
  const a = count(after);
  const removed = [];
  const added = [];
  for (const [l, n] of b) for (let i = 0; i < n - (a.get(l) || 0); i++) removed.push(l);
  for (const [l, n] of a) for (let i = 0; i < n - (b.get(l) || 0); i++) added.push(l);
  return { removed: removed.sort(), added: added.sort() };
}

const commentLines = (text) => text.split('\n').filter((l) => l.includes('#'));

async function waitCommits(mock, n, timeout = 20000) {
  const t0 = Date.now();
  while (mock.commits.length < n) {
    if (Date.now() - t0 > timeout) throw new Error(`expected ${n} commits, have ${mock.commits.length}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** Click 保存并发布, check the confirm list, confirm, wait for the commit to land and the form to settle. */
async function publish(page, mock, expectLines = []) {
  const before = mock.commits.length;
  await page.click(tid('profile-save'));
  await page.waitForSelector(tid('profile-confirm'));
  const text = await page.$eval(tid('profile-confirm'), (e) => e.innerText);
  for (const l of expectLines) assert.ok(text.includes(l), `confirm list should mention "${l}":\n${text}`);
  await page.click(tid('confirm-ok'));
  await waitCommits(mock, before + 1);
  await page.waitForSelector(`${tid('profile-save')}[disabled]`, { timeout: 15000 });
  await page.waitForSelector(tid('overlay'), { state: 'detached', timeout: 15000 });
  return { confirmText: text, commit: mock.commits[mock.commits.length - 1] };
}

/** A test PNG made by the browser: 800×600, left half red, right half blue, top 100px green. */
async function makeTestPng(page) {
  const b64 = await page.evaluate(() => {
    const c = document.createElement('canvas');
    c.width = 800;
    c.height = 600;
    const g = c.getContext('2d');
    g.fillStyle = '#ff0000'; g.fillRect(0, 0, 400, 600);
    g.fillStyle = '#0000ff'; g.fillRect(400, 0, 400, 600);
    g.fillStyle = '#00ff00'; g.fillRect(0, 0, 800, 100);
    return c.toDataURL('image/png').split(',')[1];
  });
  return Buffer.from(b64, 'base64');
}

/** Decode a JPEG with the browser: size + a few pixels. */
async function decodeJpeg(page, buf) {
  return page.evaluate(async (b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }));
    const c = new OffscreenCanvas(bmp.width, bmp.height);
    const g = c.getContext('2d');
    g.drawImage(bmp, 0, 0);
    const px = (x, y) => Array.from(g.getImageData(x, y, 1, 1).data.slice(0, 3));
    return { w: bmp.width, h: bmp.height, center: px(bmp.width >> 1, bmp.height >> 1), tl: px(4, 4), br: px(bmp.width - 5, bmp.height - 5) };
  }, Buffer.from(buf).toString('base64'));
}
const isRed = ([r, g, b]) => r > 200 && g < 70 && b < 70;

async function noHorizontalScroll(page) {
  const { sw, cw } = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
  assert.ok(sw <= cw + 1, `page scrolls horizontally: scrollWidth ${sw} > clientWidth ${cw}`);
}

const SUB_NEW = 'PKU Physics · 测试简介 2026';
// English is the default language (params.toml); the per-language override card is the Chinese site's ([zh.params.profileMode])
const SUB_ZH = '中文站单独的测试简介';
const SITE_TITLE_NEW = "HimZFX's Lab Test";
const ZHIHU = 'https://www.zhihu.com/people/himzfx-test';
let FAVICON_VER = null;

// ---------------------------------------------------------------------------

async function main() {
  const mock = await startMock({ siteDir: SITE_DIR, adminDir: ADMIN_DIR, runDelayMs: 600 });
  if (!(process.env.SKIP_BUILD && fs.existsSync(path.join(SITE_DIR, 'index.html')))) {
    console.log('  building site …');
    const r = await buildSite({ repoDir: REPO_ROOT, outDir: SITE_DIR, baseURL: mock.url + '/' });
    console.log(`  built in ${r.ms} ms`);
  }
  const ORIG = { params: mock.readFile(P_PARAMS), langs: mock.readFile(P_LANGS), hugo: mock.readFile(P_HUGO) };
  // the current subtitle as committed (the owner edits it from the admin, so it is read, not hard-coded)
  const SUB_ORIG = /^  subtitle = "([^"]*)"$/m.exec(ORIG.params)[1];
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));

  // Requests that bypass the HTTP cache (fetch with cache: 'reload' → Cache-Control: no-cache on the wire).
  // Playwright's request.headers() does not show those network-layer headers, so read them over CDP.
  const cdp = await context.newCDPSession(page);
  await cdp.send('Network.enable');
  const reqUrl = new Map();
  const reqNoCache = new Map();
  cdp.on('Network.requestWillBeSent', (e) => reqUrl.set(e.requestId, { url: e.request.url, at: Date.now() }));
  cdp.on('Network.requestWillBeSentExtraInfo', (e) => {
    const cc = Object.entries(e.headers || {}).find(([k]) => k.toLowerCase() === 'cache-control');
    if (cc && /no-cache/i.test(cc[1])) reqNoCache.set(e.requestId, true);
  });
  const reloadsOf = (pathname, since) => [...reqUrl].filter(([id, r]) => reqNoCache.has(id) && r.at >= since &&
    new URL(r.url).pathname === pathname);
  const waitReload = async (pathname, since, timeout) => {
    const end = Date.now() + timeout;
    while (!reloadsOf(pathname, since).length) {
      if (Date.now() > end) throw new Error(`no cache-bypassing request for ${pathname} within ${timeout} ms`);
      await new Promise((r) => setTimeout(r, 100));
    }
  };

  try {
    await step('open #/profile and show the current settings', async () => {
      await openAdmin(page, mock, { path: '/admin/#/profile' });
      await waitView(page, 'profile');
      await page.waitForSelector(tid('profile-save'));
      assert.equal(await page.inputValue(tid('profile-title')), 'Zhong Fangxiong');
      assert.equal(await page.inputValue(tid('profile-subtitle')), SUB_ORIG);
      assert.equal(await page.inputValue(tid('profile-site-title')), "HimZFX's Lab");
      assert.equal(await page.inputValue(tid('profile-override-zh-subtitle')), '');
      assert.equal(await page.locator(tid('profile-override-en')).count(), 0, 'no override card for the default language');
      assert.match(await page.textContent(tid('profile-override-zh')), /中文站单独设置/);
      // the preview starts on the default-language (English) site
      assert.equal(await page.getAttribute(tid('profile-preview-en'), 'aria-selected'), 'true');
      assert.deepEqual(await page.$$eval('.pf-preview-tabs [data-testid^="profile-preview-"]', (els) => els.map((e) => e.textContent)), ['英文站', '中文站']);
      assert.equal(await page.locator(tid('button-row')).count(), 2);
      assert.equal(await page.locator(tid('social-row')).count(), 2);
      assert.equal(await page.locator(tid('rule-row')).count(), 4);
      assert.equal(await page.isChecked(tid('holiday-enabled')), true);
      assert.ok(await page.isDisabled(tid('profile-save')), 'save is disabled until something changes');
      // current avatar is read from the repo
      await page.waitForFunction((s) => { const i = document.querySelector(s); return i && i.complete && i.naturalWidth > 0; }, tid('profile-avatar-img'), { timeout: 10000 });
      assert.equal(await page.textContent(tid('profile-preview-title')), 'Zhong Fangxiong');
      await page.screenshot({ path: path.join(SHOTS, 'profile-desktop.png'), fullPage: true });
    });

    await step('validation: an empty button blocks publishing', async () => {
      const n = mock.commits.length;
      await page.click(tid('button-add'));
      assert.equal(await page.locator(tid('button-row')).count(), 3);
      assert.ok(!(await page.isDisabled(tid('profile-save'))));
      await page.click(tid('profile-save'));
      await page.waitForSelector(`${tid('button-row')}[data-index="2"] .error`);
      const err = await page.textContent(`${tid('button-row')}[data-index="2"] .pf-row-msgs`);
      assert.match(err, /请填写按钮名称/);
      assert.equal(await page.locator(tid('profile-confirm')).count(), 0, 'no confirm dialog while there are errors');
      assert.equal(mock.commits.length, n);
      // a site link starting with / does not get the /zh/ prefix on the Chinese site → warning (not an error)
      await page.fill(`${tid('button-row')}[data-index="2"] ${tid('button-name')}`, 'Research');
      await page.fill(`${tid('button-row')}[data-index="2"] ${tid('button-url')}`, '/research/');
      await page.click(tid('profile-save'));
      await page.waitForFunction((s) => /不会自动加/.test(document.querySelector(s)?.textContent || ''), `${tid('button-row')}[data-index="2"] .pf-row-msgs`);
      assert.match(await page.textContent(`${tid('button-row')}[data-index="2"] .pf-row-msgs`), /以 \/ 开头的站内链接在中文站不会自动加 \/zh\/，建议写成「research\/」/);
      if (await page.locator(tid('profile-confirm')).count()) await page.click(tid('confirm-cancel'));
      assert.equal(mock.commits.length, n);
      await page.click(`${tid('button-row')}[data-index="2"] ${tid('button-remove')}`);
      assert.equal(await page.locator(tid('button-row')).count(), 2);
      assert.ok(await page.isDisabled(tid('profile-save')), 'back to clean');
    });

    await step('edit names, Chinese override, buttons, social link, holiday switch', async () => {
      await page.fill(tid('profile-subtitle'), SUB_NEW);
      await page.fill(tid('profile-site-title'), SITE_TITLE_NEW);
      await page.fill(tid('profile-override-zh-subtitle'), SUB_ZH);
      assert.equal(await page.textContent(tid('profile-preview-subtitle')), SUB_NEW);
      await page.click(tid('profile-preview-zh'));
      assert.equal(await page.textContent(tid('profile-preview-subtitle')), SUB_ZH);
      await page.click(tid('profile-preview-en'));
      assert.equal(await page.textContent(tid('profile-preview-subtitle')), SUB_NEW);

      // reorder: move "Email Me" up
      await page.click(`${tid('button-row')}[data-index="1"] ${tid('button-up')}`);
      const names = await page.$$eval(`${tid('button-row')} ${tid('button-name')}`, (els) => els.map((e) => e.value));
      assert.deepEqual(names, ['Email Me', 'My Research']);

      // add a social link (zhihu)
      await page.click(tid('social-add'));
      const row = `${tid('social-row')}[data-index="2"]`;
      await page.selectOption(`${row} ${tid('social-icon')}`, 'zhihu');
      await page.fill(`${row} ${tid('social-url')}`, ZHIHU);

      // turn holiday favicon off
      await page.locator(tid('holiday-enabled')).setChecked(false);
      assert.match(await page.textContent(tid('profile-changed-holiday')), /已修改/);
      assert.ok(await page.isVisible(tid('profile-changed-holiday')));
    });

    await step('upload + crop an avatar (pinch zoom, drag, favicon)', async () => {
      const png = await makeTestPng(page);
      fs.writeFileSync(path.join(OUT, 'test-avatar.png'), png);
      await page.setInputFiles(tid('profile-avatar-file'), { name: 'me.png', mimeType: 'image/png', buffer: png });
      await page.waitForSelector(tid('crop-stage'));
      await page.waitForTimeout(300); // modal animation
      const box = await page.locator(tid('crop-stage')).boundingBox();
      const cx = box.x + box.width / 2;
      const cy = box.y + box.height / 2;
      // synthetic two-finger pinch: fingers 100px apart → 200px apart = zoom ×2
      await page.evaluate(({ sel, cx, cy }) => {
        const el = document.querySelector(sel);
        const ev = (type, id, x, y) => el.dispatchEvent(new PointerEvent(type, { pointerId: id, pointerType: 'touch', isPrimary: id === 11, clientX: x, clientY: y, bubbles: true, cancelable: true }));
        ev('pointerdown', 11, cx - 50, cy);
        ev('pointerdown', 12, cx + 50, cy);
        ev('pointermove', 12, cx + 100, cy);
        ev('pointermove', 12, cx + 150, cy);
        ev('pointerup', 12, cx + 150, cy);
        ev('pointerup', 11, cx - 50, cy);
      }, { sel: tid('crop-stage'), cx, cy });
      const z = Number(await page.inputValue(tid('crop-zoom')));
      assert.ok(Math.abs(z - 2) < 0.02, `pinch should zoom to ×2, got ${z}`);
      // wheel zoom in then out again (net ~0)
      await page.mouse.move(cx, cy);
      await page.mouse.wheel(0, -200);
      await page.waitForTimeout(50);
      const z2 = Number(await page.inputValue(tid('crop-zoom')));
      assert.ok(z2 > z + 0.2, `wheel should zoom in (${z} → ${z2})`);
      await page.mouse.wheel(0, 200);
      await page.waitForTimeout(50);
      const z3 = Number(await page.inputValue(tid('crop-zoom')));
      assert.ok(Math.abs(z3 - z) < 0.05, `wheel back should return to ~${z}, got ${z3}`);
      // mouse drag far to the right → the crop clamps to the image's left edge (all red)
      await page.mouse.move(cx, cy);
      await page.mouse.down();
      await page.mouse.move(cx + 300, cy + 10, { steps: 12 });
      await page.mouse.up();
      await page.screenshot({ path: path.join(SHOTS, 'profile-crop-desktop.png') });
      await page.click(tid('crop-ok'));
      await page.waitForSelector(tid('profile-avatar-pending'), { state: 'visible' });
      assert.ok(await page.isChecked(tid('profile-avatar-favicon')), 'favicon checkbox defaults to on');
      await page.screenshot({ path: path.join(SHOTS, 'profile-dirty-desktop.png'), fullPage: true });
    });

    await step('保存并发布 → one commit with all five files', async () => {
      const n = mock.commits.length;
      const { confirmText, commit } = await publish(page, mock, ['头像', '简介', '网站标题', '中文站简介', '首页按钮', '社交链接', '节日图标：关闭']);
      fs.writeFileSync(path.join(OUT, 'confirm-1.txt'), confirmText);
      assert.equal(mock.commits.length, n + 1, 'exactly one commit');
      const paths = commit.changes.map((c) => c.path).sort();
      assert.deepEqual(paths, [P_LANGS, P_HUGO, P_PARAMS, 'static/avatar.jpg', 'static/favicon.jpg'].sort());
      assert.match(commit.message, /首页设置/);
      assert.ok(await page.isHidden(tid('profile-avatar-pending')));
    });

    await step('mock files: new values, comments preserved, still parse', async () => {
      const params = mock.readFile(P_PARAMS);
      const langs = mock.readFile(P_LANGS);
      const hugo = mock.readFile(P_HUGO);
      const p = parseToml(params);
      const l = parseToml(langs);
      const hg = parseToml(hugo);
      assert.equal(p.profileMode.subtitle, SUB_NEW);
      assert.equal(p.profileMode.title, 'Zhong Fangxiong');
      assert.deepEqual(p.profileMode.buttons.map((b) => b.name), ['Email Me', 'My Research']);
      assert.deepEqual(p.socialIcons.map((s) => [s.name, s.url]), [
        ['github', 'https://github.com/HimZFX'], ['email', 'mailto:himzfx@stu.pku.edu.cn'], ['zhihu', ZHIHU]]);
      assert.equal(p.holidayFavicon.enabled, false);
      assert.equal(p.holidayFavicon.rules.length, 4);
      assert.equal(l.zh.params.profileMode.subtitle, SUB_ZH);
      assert.equal(l.zh.params.profileMode.title, undefined);
      assert.equal(l.zh.params.giscus.lang, 'zh-CN');
      assert.equal(l.en.params, undefined, 'nothing written for the default language');
      assert.equal(p.giscus.lang, 'en');
      assert.equal(hg.title, SITE_TITLE_NEW);

      for (const [name, before, after] of [['params', ORIG.params, params], ['languages', ORIG.langs, langs], ['hugo', ORIG.hugo, hugo]]) {
        const missing = missingInOrder(commentLines(before), after);
        assert.deepEqual(missing, [], `${name}.toml lost comment lines`);
      }
      // params.toml: only the edited lines changed (buttons are reordered, i.e. same lines).
      // The new favicon gets a versioned address (?v=<hash of the new icon>) so browsers do not keep
      // showing the cached old icon (GitHub Pages serves everything with max-age=600).
      const d = lineDiff(ORIG.params, params);
      const FAV_RE = /^  favicon(?:16x16|32x32)? = "\/favicon\.jpg\?v=([0-9a-f]{8})"$/;
      const favAdded = d.added.filter((l) => FAV_RE.test(l));
      assert.equal(favAdded.length, 3, `favicon, favicon16x16 and favicon32x32 are versioned:\n${d.added.join('\n')}`);
      const vers = new Set(favAdded.map((l) => FAV_RE.exec(l)[1]));
      assert.equal(vers.size, 1, 'all three icon links use the same version');
      FAVICON_VER = [...vers][0];
      assert.deepEqual(d.removed, ['  enabled = true', `  subtitle = "${SUB_ORIG}"`,
        '  favicon = "/favicon.jpg"', '  favicon16x16 = "/favicon.jpg"', '  favicon32x32 = "/favicon.jpg"'].sort());
      assert.deepEqual(d.added.filter((l) => !FAV_RE.test(l)), ['  enabled = false', `  subtitle = "${SUB_NEW}"`, '[[socialIcons]]', '  name = "zhihu"', `  url = "${ZHIHU}"`].sort());
      // the avatar keeps its address (the imageUrl line, with its comment, is untouched)
      assert.equal(p.profileMode.imageUrl, 'avatar.jpg');
      const dh = lineDiff(ORIG.hugo, hugo);
      assert.deepEqual(dh.removed, ['title = "HimZFX\'s Lab"']);
      assert.deepEqual(dh.added, [`title = "${SITE_TITLE_NEW}"`]);
      const dl = lineDiff(ORIG.langs, langs);
      assert.deepEqual(dl.removed, []);
      assert.deepEqual(dl.added.filter(Boolean), ['  [zh.params.profileMode]', `    subtitle = "${SUB_ZH}"`].sort());
    });

    await step('avatar.jpg 512² and favicon.jpg 128² JPEGs of the cropped region', async () => {
      const a = mock.readBytes('static/avatar.jpg');
      const f = mock.readBytes('static/favicon.jpg');
      for (const b of [a, f]) assert.deepEqual([...b.subarray(0, 3)], [0xff, 0xd8, 0xff], 'JPEG magic');
      const da = await decodeJpeg(page, a);
      const df = await decodeJpeg(page, f);
      assert.equal(da.w, 512); assert.equal(da.h, 512);
      assert.equal(df.w, 128); assert.equal(df.h, 128);
      // zoom ×2 + drag right → crop = x 0..300, y 150..450 of the test image → entirely red (no green band, no blue)
      for (const [n, px] of Object.entries({ center: da.center, tl: da.tl, br: da.br, favCenter: df.center, favTl: df.tl })) {
        assert.ok(isRed(px), `${n} pixel should be red, got ${px}`);
      }
      // the view now shows the new avatar as the current one
      assert.equal(await page.isVisible(tid('profile-avatar-undo')), false);
    });

    await step('Hugo build: en (/) and zh (/zh/) home pages show the new subtitles, title and social link', async () => {
      const exp = path.join(OUT, 'export-1');
      const site = path.join(OUT, 'site-1');
      fs.rmSync(exp, { recursive: true, force: true });
      mock.exportTo(exp);
      await buildSite({ repoDir: exp, outDir: site, baseURL: mock.url + '/' });
      const en = fs.readFileSync(path.join(site, 'index.html'), 'utf8');
      const zh = fs.readFileSync(path.join(site, 'zh', 'index.html'), 'utf8');
      assert.match(en, /<html lang="?en"? /);
      assert.match(zh, /<html lang="?zh"? /);
      assert.ok(en.includes(SUB_NEW), 'en home (default language, /) shows the new subtitle from params.toml');
      assert.ok(!en.includes(SUB_ZH), 'en home does not show the Chinese override');
      assert.ok(zh.includes(SUB_ZH), 'zh home shows the Chinese override');
      assert.ok(!zh.includes(SUB_NEW), 'zh home does not show the default subtitle');
      for (const html of [zh, en]) {
        assert.ok(html.includes(ZHIHU), 'social link present');
        assert.ok(html.includes('HimZFX&#39;s Lab Test') || html.includes("HimZFX's Lab Test"), 'new site title');
        assert.ok(html.indexOf('Email Me') < html.indexOf('My Research'), 'buttons reordered');
      }
      // holiday favicon disabled → its inline script is gone
      for (const html of [zh, en]) assert.ok(!html.includes('link[rel~=') && !html.includes("link[rel~='icon']"), 'holiday favicon script removed');
      // the tab icon now has a new address on both sites
      for (const html of [zh, en]) {
        assert.ok(new RegExp(`<link rel=["']?icon["']?[^>]*favicon\\.jpg\\?v=${FAVICON_VER}`).test(html), 'versioned favicon link');
      }
      fs.writeFileSync(path.join(OUT, 'site-1-index.html'), en);
    });

    await step('after publishing a new avatar, this browser refreshes its cached copy once the site serves it', async () => {
      // GitHub Pages caches /avatar.jpg for 10 minutes; the admin re-fetches it with cache: 'reload' until
      // the deployed bytes are the new avatar, then refreshes the home pages too.
      const newAvatar = mock.readBytes('static/avatar.jpg');
      const t0 = Date.now();
      await waitReload('/avatar.jpg', t0, 30000);
      // "deploy": the site now serves the new avatar
      fs.copyFileSync(path.join(SITE_DIR, 'avatar.jpg'), path.join(OUT, 'site-avatar-before.jpg'));
      const t1 = Date.now();
      fs.writeFileSync(path.join(SITE_DIR, 'avatar.jpg'), newAvatar);
      await waitReload('/', t1, 40000);
      await waitReload('/zh/', t1, 40000);
      // and then it stops polling
      const t2 = Date.now();
      await page.waitForTimeout(17000);
      assert.equal(reloadsOf('/avatar.jpg', t2).length, 0, 'no more re-fetches once the new avatar is live');
      fs.copyFileSync(path.join(OUT, 'site-avatar-before.jpg'), path.join(SITE_DIR, 'avatar.jpg'));
    });

    await step('conflict: external edit while editing → reload keeps my edit and theirs', async () => {
      // someone edits params.toml on GitHub (changes the profile title)
      const ext = mock.readFile(P_PARAMS).replace('title = "Zhong Fangxiong"', 'title = "Zhong F."');
      mock.setFile(P_PARAMS, ext);
      await page.fill(tid('profile-subtitle'), SUB_NEW + '!');
      const n = mock.commits.length;
      await page.click(tid('profile-save'));
      await page.waitForSelector(tid('profile-confirm'));
      await page.click(tid('confirm-ok'));
      await page.waitForSelector(tid('conflict-reload'));
      await page.click(tid('conflict-reload'));
      await page.waitForSelector(tid('conflict-reload'), { state: 'detached' });
      await page.waitForFunction((s) => document.querySelector(s) && document.querySelector(s).value === 'Zhong F.', tid('profile-title'), { timeout: 10000 });
      assert.equal(await page.inputValue(tid('profile-subtitle')), SUB_NEW + '!', 'my edit survives the reload');
      assert.equal(mock.commits.length, n, 'nothing committed on conflict');
      await publish(page, mock, ['简介']);
      const p = parseToml(mock.readFile(P_PARAMS));
      assert.equal(p.profileMode.title, 'Zhong F.');
      assert.equal(p.profileMode.subtitle, SUB_NEW + '!');
    });

    await step('remove the Chinese override → languages.toml returns to its original text', async () => {
      await page.fill(tid('profile-override-zh-subtitle'), '');
      await publish(page, mock, ['中文站简介：取消单独设置']);
      assert.equal(mock.readFile(P_LANGS), ORIG.langs, 'languages.toml byte-identical to the original');
      const c = mock.commits[mock.commits.length - 1];
      assert.deepEqual(c.changes.map((x) => x.path), [P_LANGS]);
    });

    await step('Hugo build after removing the override: zh falls back to the shared subtitle', async () => {
      const exp = path.join(OUT, 'export-2');
      const site = path.join(OUT, 'site-2');
      fs.rmSync(exp, { recursive: true, force: true });
      mock.exportTo(exp);
      await buildSite({ repoDir: exp, outDir: site, baseURL: mock.url + '/' });
      const en = fs.readFileSync(path.join(site, 'index.html'), 'utf8');
      const zh = fs.readFileSync(path.join(site, 'zh', 'index.html'), 'utf8');
      for (const html of [zh, en]) {
        assert.ok(html.includes(SUB_NEW + '!'), 'shared subtitle on both sites');
        assert.ok(!html.includes(SUB_ZH), 'override gone');
        assert.ok(html.includes(ZHIHU), 'social link still there');
      }
    });

    await step('leave guard + 放弃修改', async () => {
      await page.fill(tid('profile-title'), 'Unsaved name');
      await page.evaluate(() => { location.hash = '#/posts'; });
      await page.waitForSelector(tid('confirm-cancel'));
      await page.click(tid('confirm-cancel'));
      await page.waitForTimeout(200);
      assert.ok(await page.evaluate(() => location.hash.startsWith('#/profile')), 'stayed on profile');
      assert.equal(await page.inputValue(tid('profile-title')), 'Unsaved name');
      await page.click(tid('profile-reset'));
      await page.click(tid('confirm-ok'));
      await page.waitForFunction((s) => document.querySelector(s) && document.querySelector(s).value === 'Zhong F.', tid('profile-title'));
      assert.ok(await page.isDisabled(tid('profile-save')));
    });

    await step('401 while editing: the edits and the cropped avatar survive re-login (local autosave)', async () => {
      const SUB_AUTO = '自动保存测试简介';
      await page.fill(tid('profile-subtitle'), SUB_AUTO);
      const png = await makeTestPng(page);
      await page.setInputFiles(tid('profile-avatar-file'), { name: 'me.png', mimeType: 'image/png', buffer: png });
      await page.waitForSelector(tid('crop-stage'));
      await page.waitForTimeout(300);
      await page.click(tid('crop-ok'));
      await page.waitForSelector(tid('profile-avatar-pending'), { state: 'visible' });
      await page.waitForTimeout(1500); // autosave debounce
      // the token is revoked; 保存并发布 gets a 401 → the view has unsaved edits, so the shell keeps it
      // mounted and shows a re-login dialog over it (nothing is torn down, nothing is committed)
      const token = mock.token;
      const n = mock.commits.length;
      mock.setToken('revoked-' + token);
      try {
        await page.click(tid('profile-save'));
        await page.waitForSelector(tid('profile-confirm'));
        await page.click(tid('confirm-ok'));
        await page.waitForSelector(tid('reauth'), { timeout: 20000 });
        assert.equal(mock.commits.length, n);
        assert.equal(await page.locator(tid('login-token')).count(), 0, 'no full login page: the view stays');
        assert.equal(await page.inputValue(tid('profile-subtitle')), SUB_AUTO, 'edits still in the form under the dialog');
        // the local autosave holds the edits too (in case the tab dies now)
        const rec = await page.evaluate(() => new Promise((resolve) => {
          const r = indexedDB.open('himzfx-admin-profile');
          r.onerror = () => resolve(null);
          r.onsuccess = () => {
            const db = r.result;
            try {
              const names = [...db.objectStoreNames];
              const tx = db.transaction(names[0], 'readonly');
              const g = tx.objectStore(names[0]).get('home');
              g.onsuccess = () => { resolve(g.result ? JSON.stringify(g.result).includes('自动保存测试简介') : false); db.close(); };
              g.onerror = () => { resolve(null); db.close(); };
            } catch { resolve(null); db.close(); }
          };
        }));
        assert.equal(rec, true, 'the unsaved subtitle is in the local autosave');
      } finally {
        mock.setToken(token);
      }
      await page.fill(tid('reauth-token'), token);
      await page.click(tid('reauth-submit'));
      await page.waitForSelector(tid('reauth'), { state: 'detached' });
      assert.equal(await page.inputValue(tid('profile-subtitle')), SUB_AUTO);
      assert.ok(await page.isVisible(tid('profile-avatar-pending')), 'the cropped avatar is back');
      assert.ok(await page.isChecked(tid('profile-avatar-favicon')));
      const { commit } = await publish(page, mock, ['头像', '简介']);
      assert.deepEqual(commit.changes.map((c) => c.path).sort(), [P_PARAMS, 'static/avatar.jpg', 'static/favicon.jpg'].sort());
      assert.equal(parseToml(mock.readFile(P_PARAMS)).profileMode.subtitle, SUB_AUTO);
      const a = await decodeJpeg(page, mock.readBytes('static/avatar.jpg'));
      assert.equal(a.w, 512);
      // published → the local copy is gone: a fresh tab shows no restore banner
      await page.waitForTimeout(500);
      const p2 = await context.newPage();
      p2.on('pageerror', (e) => pageErrors.push('p2: ' + e.message));
      await openAdmin(p2, mock, { path: '/admin/#/profile' });
      await waitView(p2, 'profile');
      await p2.waitForSelector(tid('profile-save'));
      await p2.waitForTimeout(800);
      assert.equal(await p2.locator(tid('profile-restore')).count(), 0, 'no stale local copy after publishing');
      await p2.close();
    });

    await step('tab closed with unpublished edits → a new tab offers 恢复 / 丢弃', async () => {
      await page.fill(tid('profile-title'), 'Closed-tab name');
      await page.waitForTimeout(1500);
      const p2 = await context.newPage();
      p2.on('pageerror', (e) => pageErrors.push('p2: ' + e.message));
      await openAdmin(p2, mock, { path: '/admin/#/profile' });
      await waitView(p2, 'profile');
      await p2.waitForSelector(tid('profile-restore'), { timeout: 10000 });
      await p2.click(tid('profile-restore-discard'));
      await p2.click(tid('confirm-ok'));
      await p2.waitForSelector(tid('profile-restore'), { state: 'detached' });
      assert.equal(await p2.inputValue(tid('profile-title')), 'Zhong F.');
      assert.ok(await p2.isDisabled(tid('profile-save')));
      await p2.close();
      // clean up the first tab
      await page.click(tid('profile-reset'));
      await page.click(tid('confirm-ok'));
      await page.waitForFunction((s) => document.querySelector(s) && document.querySelector(s).value === 'Zhong F.', tid('profile-title'));
      await page.waitForTimeout(1200);
      const p3 = await context.newPage();
      await openAdmin(p3, mock, { path: '/admin/#/profile' });
      await waitView(p3, 'profile');
      await p3.waitForSelector(tid('profile-save'));
      await p3.waitForTimeout(800);
      assert.equal(await p3.locator(tid('profile-restore')).count(), 0, '放弃修改 also removes the local copy');
      await p3.close();
    });

    await step('imageUrl pointing to a PNG: the current avatar is read from that file in the repo', async () => {
      const params = mock.readFile(P_PARAMS);
      const png = await makeTestPng(page);
      mock.setFiles({ [P_PARAMS]: params.replace('imageUrl = "avatar.jpg"', 'imageUrl = "avatar.png"'), 'static/avatar.png': png });
      const p2 = await context.newPage();
      p2.on('pageerror', (e) => pageErrors.push('p2: ' + e.message));
      await openAdmin(p2, mock, { path: '/admin/#/profile' });
      await waitView(p2, 'profile');
      await p2.waitForSelector(tid('profile-save'));
      await p2.waitForFunction((s) => { const i = document.querySelector(s); return i && !i.hidden && i.complete && i.naturalWidth > 0; }, tid('profile-avatar-img'), { timeout: 10000 });
      const img = await p2.$eval(tid('profile-avatar-img'), (i) => ({ src: i.src, w: i.naturalWidth, h: i.naturalHeight }));
      assert.ok(img.src.startsWith('blob:'), `read from the repo, not the deployed site: ${img.src}`);
      assert.deepEqual([img.w, img.h], [800, 600], 'the PNG itself is shown');
      await p2.close();
      mock.setFiles({ [P_PARAMS]: params, 'static/avatar.png': null });
    });

    await step('mobile layout (390×844): no horizontal scroll, crop modal works', async () => {
      const m = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
      const mp = await m.newPage();
      mp.on('pageerror', (e) => pageErrors.push('mobile: ' + e.message));
      await openAdmin(mp, mock, { path: '/admin/#/profile' });
      await waitView(mp, 'profile');
      await mp.waitForSelector(tid('profile-save'), { timeout: 8000 }).catch(async (e) => {
        await mp.screenshot({ path: path.join(SHOTS, 'profile-mobile-FAILED.png') });
        throw e;
      });
      await noHorizontalScroll(mp);
      await mp.screenshot({ path: path.join(SHOTS, 'profile-mobile.png'), fullPage: true });
      await mp.fill(tid('profile-subtitle'), 'mobile edit');
      await mp.click(tid('rule-add'));
      await noHorizontalScroll(mp);
      await mp.screenshot({ path: path.join(SHOTS, 'profile-mobile-dirty.png'), fullPage: false });
      const png = await makeTestPng(mp);
      await mp.setInputFiles(tid('profile-avatar-file'), { name: 'me.png', mimeType: 'image/png', buffer: png });
      await mp.waitForSelector(tid('crop-stage'));
      await mp.waitForTimeout(350);
      await noHorizontalScroll(mp);
      await mp.screenshot({ path: path.join(SHOTS, 'profile-mobile-crop.png') });
      await mp.click(tid('crop-cancel'));
      await mp.waitForSelector(tid('crop-stage'), { state: 'detached' });
      assert.ok(await mp.isHidden(tid('profile-avatar-pending')), 'cancel keeps the old avatar');
      // dark mode desktop screenshot for visual review
      const d = await browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: 'dark' });
      const dp = await d.newPage();
      await openAdmin(dp, mock, { path: '/admin/#/profile' });
      await waitView(dp, 'profile');
      await dp.waitForTimeout(300);
      await dp.screenshot({ path: path.join(SHOTS, 'profile-dark-desktop.png'), fullPage: true });
      await dp.waitForSelector(tid('profile-save'));
      await dp.screenshot({ path: path.join(SHOTS, 'profile-dark-desktop.png'), fullPage: true });
      await d.close();
      await m.close();
    });

    await step('no page errors', async () => {
      assert.deepEqual(pageErrors, []);
    });
  } finally {
    await browser.close();
    await mock.close();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} steps passed. Screenshots: ${SHOTS}`);
  process.exitCode = failed.length ? 1 : 0;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
