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
const SUB_EN = 'English-only subtitle for the test';
const SITE_TITLE_NEW = "HimZFX's Lab Test";
const ZHIHU = 'https://www.zhihu.com/people/himzfx-test';

// ---------------------------------------------------------------------------

async function main() {
  const mock = await startMock({ siteDir: SITE_DIR, adminDir: ADMIN_DIR, runDelayMs: 600 });
  if (!(process.env.SKIP_BUILD && fs.existsSync(path.join(SITE_DIR, 'index.html')))) {
    console.log('  building site …');
    const r = await buildSite({ repoDir: REPO_ROOT, outDir: SITE_DIR, baseURL: mock.url + '/' });
    console.log(`  built in ${r.ms} ms`);
  }
  const ORIG = { params: mock.readFile(P_PARAMS), langs: mock.readFile(P_LANGS), hugo: mock.readFile(P_HUGO) };
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));

  try {
    await step('open #/profile and show the current settings', async () => {
      await openAdmin(page, mock, { path: '/admin/#/profile' });
      await waitView(page, 'profile');
      await page.waitForSelector(tid('profile-save'));
      assert.equal(await page.inputValue(tid('profile-title')), 'Zhong Fangxiong');
      assert.equal(await page.inputValue(tid('profile-subtitle')), 'Peking University | Physics & Astrophysics | Quant Trading');
      assert.equal(await page.inputValue(tid('profile-site-title')), "HimZFX's Lab");
      assert.equal(await page.inputValue(tid('profile-override-en-subtitle')), '');
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
      await page.click(`${tid('button-row')}[data-index="2"] ${tid('button-remove')}`);
      assert.equal(await page.locator(tid('button-row')).count(), 2);
      assert.ok(await page.isDisabled(tid('profile-save')), 'back to clean');
    });

    await step('edit names, English override, buttons, social link, holiday switch', async () => {
      await page.fill(tid('profile-subtitle'), SUB_NEW);
      await page.fill(tid('profile-site-title'), SITE_TITLE_NEW);
      await page.fill(tid('profile-override-en-subtitle'), SUB_EN);
      assert.equal(await page.textContent(tid('profile-preview-subtitle')), SUB_NEW);
      await page.click(tid('profile-preview-en'));
      assert.equal(await page.textContent(tid('profile-preview-subtitle')), SUB_EN);
      await page.click(tid('profile-preview-zh'));

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
      const { confirmText, commit } = await publish(page, mock, ['头像', '简介', '网站标题', '英文站简介', '首页按钮', '社交链接', '节日图标：关闭']);
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
      assert.equal(l.en.params.profileMode.subtitle, SUB_EN);
      assert.equal(l.en.params.profileMode.title, undefined);
      assert.equal(l.en.params.giscus.lang, 'en');
      assert.equal(hg.title, SITE_TITLE_NEW);

      for (const [name, before, after] of [['params', ORIG.params, params], ['languages', ORIG.langs, langs], ['hugo', ORIG.hugo, hugo]]) {
        const missing = missingInOrder(commentLines(before), after);
        assert.deepEqual(missing, [], `${name}.toml lost comment lines`);
      }
      // params.toml: only the edited lines changed (buttons are reordered, i.e. same lines)
      const d = lineDiff(ORIG.params, params);
      assert.deepEqual(d.removed, ['  enabled = true', '  subtitle = "Peking University | Physics & Astrophysics | Quant Trading"'].sort());
      assert.deepEqual(d.added, ['  enabled = false', `  subtitle = "${SUB_NEW}"`, '[[socialIcons]]', '  name = "zhihu"', `  url = "${ZHIHU}"`].sort());
      const dh = lineDiff(ORIG.hugo, hugo);
      assert.deepEqual(dh.removed, ['title = "HimZFX\'s Lab"']);
      assert.deepEqual(dh.added, [`title = "${SITE_TITLE_NEW}"`]);
      const dl = lineDiff(ORIG.langs, langs);
      assert.deepEqual(dl.removed, []);
      assert.deepEqual(dl.added.filter(Boolean), ['  [en.params.profileMode]', `    subtitle = "${SUB_EN}"`].sort());
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

    await step('Hugo build: zh/en home pages show the new subtitles, title and social link', async () => {
      const exp = path.join(OUT, 'export-1');
      const site = path.join(OUT, 'site-1');
      fs.rmSync(exp, { recursive: true, force: true });
      mock.exportTo(exp);
      await buildSite({ repoDir: exp, outDir: site, baseURL: mock.url + '/' });
      const zh = fs.readFileSync(path.join(site, 'index.html'), 'utf8');
      const en = fs.readFileSync(path.join(site, 'en', 'index.html'), 'utf8');
      assert.ok(zh.includes(SUB_NEW), 'zh home shows new subtitle');
      assert.ok(!zh.includes(SUB_EN), 'zh home does not show the English override');
      assert.ok(en.includes(SUB_EN), 'en home shows English override');
      assert.ok(!en.includes(SUB_NEW), 'en home does not show the zh subtitle');
      for (const html of [zh, en]) {
        assert.ok(html.includes(ZHIHU), 'social link present');
        assert.ok(html.includes('HimZFX&#39;s Lab Test') || html.includes("HimZFX's Lab Test"), 'new site title');
        assert.ok(html.indexOf('Email Me') < html.indexOf('My Research'), 'buttons reordered');
      }
      // holiday favicon disabled → its inline script is gone
      assert.ok(!zh.includes('link[rel~=') && !zh.includes("link[rel~='icon']"), 'holiday favicon script removed');
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

    await step('remove the English override → languages.toml returns to its original text', async () => {
      await page.fill(tid('profile-override-en-subtitle'), '');
      await publish(page, mock, ['英文站简介：取消单独设置']);
      assert.equal(mock.readFile(P_LANGS), ORIG.langs, 'languages.toml byte-identical to the original');
      const c = mock.commits[mock.commits.length - 1];
      assert.deepEqual(c.changes.map((x) => x.path), [P_LANGS]);
    });

    await step('Hugo build after removing the override: en falls back to the shared subtitle', async () => {
      const exp = path.join(OUT, 'export-2');
      const site = path.join(OUT, 'site-2');
      fs.rmSync(exp, { recursive: true, force: true });
      mock.exportTo(exp);
      await buildSite({ repoDir: exp, outDir: site, baseURL: mock.url + '/' });
      const zh = fs.readFileSync(path.join(site, 'index.html'), 'utf8');
      const en = fs.readFileSync(path.join(site, 'en', 'index.html'), 'utf8');
      for (const html of [zh, en]) {
        assert.ok(html.includes(SUB_NEW + '!'), 'shared subtitle on both sites');
        assert.ok(!html.includes(SUB_EN), 'override gone');
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
