// tests/admin/e2e-lang.mjs — the website's language setup, end to end, with the pinned Hugo + Chromium:
//
//   - English is the default language at /, Chinese lives under /zh/ (config/_default/hugo.toml, languages.toml);
//     <html lang>, hreflang alternates, the language switch and the nav menus follow;
//   - old English URLs /en/<path>/ are sent to /<path>/ by the script in layouts/404.html (query + hash kept,
//     location.replace, no loop for pages that really do not exist), served like GitHub Pages does: the mock's
//     static server answers unknown paths with 404.html;
//   - the language hint (layouts/partials/features/lang-hint.html + assets/js/lang-hint.js): a Chinese-preferring
//     browser on an English page that has a Chinese version sees 「本页有中文版 →」 (and the reverse for English
//     readers on /zh/ pages), never redirected; not shown otherwise; × remembers the choice in
//     localStorage['lang-hint-dismissed'] (no admin.* key is touched); fixed position (no layout shift),
//     theme colours in light and dark mode, phone width without sideways scroll.
//
// The real content/ is never changed: two extra pages (one English-only, one Chinese-only) are added to the
// mock's copy before it is exported and built.
//
// Run from the repo root:   node tests/admin/e2e-lang.mjs
// Env:
//   LANG_E2E_DIR   where the export, the build and the screenshots go (default: $ADMIN_TEST_TMP/e2e-lang or <os tmp>/admin-e2e-lang)
//   HUGO_BIN       Hugo binary (see mock-github.mjs)
//   ONLY=<substr>  run only tests whose name contains this

import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startMock, buildSite } from './mock-github.mjs';

const { chromium } = createRequire(import.meta.url)('playwright');

const OUT = path.resolve(process.env.LANG_E2E_DIR || path.join(process.env.ADMIN_TEST_TMP || os.tmpdir(), 'admin-e2e-lang'));
const SITE_DIR = path.join(OUT, 'site');
const EXPORT_DIR = path.join(OUT, 'export');
const SHOTS = path.join(OUT, 'screenshots');
fs.mkdirSync(SHOTS, { recursive: true });

const POST = '/posts/first-physics-note/'; // first-physics-note.md (shared, Chinese) + .en.md (English)
const EN_ONLY = '/posts/lang-e2e-english-only/';
const ZH_ONLY = '/posts/lang-e2e-chinese-only/';
const HINT_KEY = 'lang-hint-dismissed';

const results = [];
async function test(name, fn) {
  if (process.env.ONLY && !name.includes(process.env.ONLY)) return;
  const t0 = Date.now();
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  ✓ ${name} (${Date.now() - t0} ms)`);
  } catch (err) {
    results.push({ name, ok: false });
    console.log(`  ✗ ${name}\n      ${String(err && err.stack || err).split('\n').slice(0, 8).join('\n      ')}`);
  }
}

const read = (p) => fs.readFileSync(path.join(SITE_DIR, p.replace(/^\//, ''), p.endsWith('/') ? 'index.html' : ''), 'utf8');
const exists = (p) => fs.existsSync(path.join(SITE_DIR, p.replace(/^\//, ''), 'index.html'));
const htmlLang = (html) => (/<html lang="?([^" >]+)/.exec(html) || [])[1];
const alternates = (html) => [...html.matchAll(/<link rel="?alternate"? hreflang="?([a-z-]+)"? href="?([^" >]+)"?>/g)].map((m) => [m[1], m[2]]);

async function main() {
  console.log(`e2e-lang → ${OUT}`);
  const mock = await startMock({ siteDir: SITE_DIR });
  const U = mock.url;
  mock.setFile('content/posts/lang-e2e-english-only.en.md', '---\ntitle: "English Only Page"\ndate: 2026-01-02\ndraft: false\n---\n\nOnly in English.\n');
  mock.setFile('content/posts/lang-e2e-chinese-only.zh.md', '---\ntitle: "只有中文的页面"\ndate: 2026-01-03\ndraft: false\n---\n\n只有中文。\n');
  fs.rmSync(EXPORT_DIR, { recursive: true, force: true });
  mock.exportTo(EXPORT_DIR);
  const built = await buildSite({ repoDir: EXPORT_DIR, outDir: SITE_DIR, baseURL: U + '/' });
  console.log(`  site built in ${built.ms} ms, served at ${U}`);

  const browser = await chromium.launch();
  const problems = [];
  const external = [];
  /** A browser context like a visitor's, with the given languages; CDN requests (KaTeX) are blocked and recorded. */
  async function visitor(opts = {}, label = 'visitor') {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, ...opts });
    await context.route('**/*', (route) => {
      const u = route.request().url();
      if (u.startsWith(U + '/') || u.startsWith('data:')) return route.continue();
      external.push(u);
      return route.abort();
    });
    await context.addInitScript(() => {
      window.__storage = [];
      const P = Storage.prototype;
      for (const fn of ['getItem', 'setItem', 'removeItem']) {
        const orig = P[fn];
        P[fn] = function (...a) { window.__storage.push(`${fn}:${a[0]}`); return orig.apply(this, a); };
      }
    });
    context.on('page', (p) => {
      p.on('pageerror', (e) => problems.push(`${label}: ${e.message}`));
      p.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|ERR_FAILED|ERR_BLOCKED/.test(m.text())) problems.push(`${label}: ${m.text()}`); });
    });
    return context;
  }
  const hint = (page) => page.evaluate(() => {
    const b = document.querySelector('.lang-hint');
    if (!b) return null;
    const a = b.querySelector('a');
    const r = b.getBoundingClientRect();
    const cs = getComputedStyle(b);
    return {
      text: a.textContent.trim(), href: a.getAttribute('href'), hreflang: a.getAttribute('hreflang'), lang: b.getAttribute('lang'),
      close: b.querySelector('button').getAttribute('aria-label'), position: cs.position, bg: cs.backgroundColor, color: cs.color,
      rect: { left: r.left, right: r.right, top: r.top, bottom: r.bottom }, vw: document.documentElement.clientWidth, vh: innerHeight,
    };
  });
  /** Deferred scripts have run once the window load event has fired. */
  const settled = (page) => page.waitForFunction(() => document.readyState === 'complete');

  try {
    // -------------------------------------------------------------------------------------------- build

    await test('build: English (default language) at /, Chinese at /zh/, nothing under /en/ but Hugo’s redirect page', async () => {
      assert.ok(!/WARN|ERROR/.test(built.stdout + built.stderr), built.stdout + built.stderr);
      for (const p of ['/', '/about/', '/posts/', POST, '/research/', '/courses/']) {
        assert.ok(exists(p), p);
        assert.equal(htmlLang(read(p)), 'en', p);
        assert.ok(exists('/zh' + p), '/zh' + p);
        assert.equal(htmlLang(read('/zh' + p)), 'zh', '/zh' + p);
      }
      const enDir = fs.readdirSync(path.join(SITE_DIR, 'en')).sort();
      assert.deepEqual(enDir, ['index.html', 'sitemap.xml'], 'only the alias and the per-language sitemap under /en/');
      assert.match(read('/en/'), new RegExp(`http-equiv="?refresh"? content="0; url=${U}/"`));
      // the English pages use the .en.md versions, the Chinese pages the shared files
      assert.match(read(POST), /Metric Tensor in GR/);
      assert.match(read('/zh' + POST), /广义相对论中的度规张量/);
      assert.match(read('/about/'), /About Me/);
      assert.match(read('/zh/about/'), /关于我/);
      // one-language pages exist only on their own site
      assert.ok(exists(EN_ONLY) && !exists('/zh' + EN_ONLY));
      assert.ok(exists('/zh' + ZH_ONLY) && !exists(ZH_ONLY));
    });

    await test('hreflang alternates, the language switch and the nav menus point at the right language', async () => {
      for (const [p, en, zh] of [['/', `${U}/`, `${U}/zh/`], [POST, `${U}${POST}`, `${U}/zh${POST}`], ['/about/', `${U}/about/`, `${U}/zh/about/`]]) {
        for (const page of [p, '/zh' + p]) assert.deepEqual(alternates(read(page)), [['en', en], ['zh', zh]], page);
      }
      // a page without a translation only lists itself (PaperMod's existing behaviour, unchanged)
      assert.deepEqual(alternates(read(EN_ONLY)), [['en', `${U}${EN_ONLY}`]]);
      assert.deepEqual(alternates(read('/zh' + ZH_ONLY)), [['zh', `${U}/zh${ZH_ONLY}`]]);
      // PaperMod's switch (site.Home.Translations): the other language's home page
      const sw = (html) => [...(/<ul class="?lang-switch"?>([\s\S]*?)<\/ul>/.exec(html) || ['', ''])[1].matchAll(/href="?([^" >]+)"?/g)].map((m) => m[1]);
      assert.deepEqual(sw(read(POST)), [`${U}/zh/`]);
      assert.deepEqual(sw(read('/zh' + POST)), [`${U}/`]);
      const menu = (html) => [...(/<ul id="?menu"?[^>]*>([\s\S]*?)<\/ul>/.exec(html) || ['', ''])[1].matchAll(/href="?([^" >]+)"?/g)].map((m) => new URL(m[1]).pathname);
      assert.ok(menu(read('/')).every((x) => !x.startsWith('/zh/') && !x.startsWith('/en/')), menu(read('/')).join(' '));
      assert.ok(menu(read('/zh/')).length && menu(read('/zh/')).every((x) => x.startsWith('/zh/')), menu(read('/zh/')).join(' '));
      // the home page's buttons are relative ("research/"), so each site stays in its own language
      const btn = (html) => [...html.matchAll(/<a class="?button"? href="?([^" >]+)"?/g)].map((m) => m[1]);
      assert.ok(btn(read('/')).includes('research/'), btn(read('/')).join(' '));
    });

    // -------------------------------------------------------------------------------------------- 404 redirect

    await test('old /en/<path>/ links land on /<path>/ (query + hash kept, replace, no loop); real 404s stay put', async () => {
      const ctx = await visitor({}, '404');
      const page = await ctx.newPage();
      // the mock answers unknown paths with 404.html and status 404, like GitHub Pages
      const r = await page.request.get(`${U}/en${POST}`);
      assert.equal(r.status(), 404);
      assert.match(await r.text(), /class="?not-found"?>404</);

      await page.goto(`${U}/posts/`);
      const h0 = await page.evaluate(() => history.length);
      await page.goto(`${U}/en${POST}?from=old#metric`);
      await page.waitForURL(`${U}${POST}?from=old#metric`);
      await page.waitForSelector('.post-title');
      assert.match(await page.textContent('.post-title'), /Metric Tensor in GR/);
      assert.equal(await page.evaluate(() => history.length), h0 + 1, 'the 404 page left no history entry (location.replace)');
      await page.goBack();
      assert.equal(new URL(page.url()).pathname, '/posts/');

      for (const [from, to] of [['/en/about/', '/about/'], ['/en/zh-not-a-prefix/', '/zh-not-a-prefix/'], ['/en/', '/'], ['/en', '/']]) {
        await page.goto(U + from);
        await page.waitForURL(U + to);
      }
      // pages that do not exist anywhere: the 404 page stays (no redirect loop, no redirect for other prefixes)
      for (const p of ['/en/does-not-exist/', '/does-not-exist/', '/zh/does-not-exist/', '/english/', '/EN/about/']) {
        const resp = await page.goto(U + p);
        await page.waitForTimeout(300);
        const want = p.startsWith('/en/') ? p.slice(3) : p;
        assert.equal(new URL(page.url()).pathname, want, p);
        assert.equal(await page.textContent('.not-found'), '404', p);
        if (!p.startsWith('/en/')) assert.equal(resp.status(), 404);
      }
      await ctx.close();
    });

    // -------------------------------------------------------------------------------------------- language hint

    await test('hint: a Chinese-preferring browser on an English page with a translation sees 「本页有中文版 →」 (no redirect)', async () => {
      const ctx = await visitor({ locale: 'zh-CN' }, 'hint-zh');
      const page = await ctx.newPage();
      await page.goto(U + POST);
      await page.waitForSelector('.lang-hint');
      await settled(page);
      assert.equal(new URL(page.url()).pathname, POST, 'never redirects');
      const h = await hint(page);
      assert.equal(h.text, '本页有中文版 →');
      assert.equal(h.href, `/zh${POST}`);
      assert.equal(h.hreflang, 'zh');
      assert.equal(h.lang, 'zh-CN');
      assert.equal(h.close, '关闭');
      assert.equal(h.position, 'fixed', 'out of the flow: no layout shift');
      // the page around it is laid out exactly as for a reader who gets no hint
      const layout = (p) => p.evaluate(() => ({ main: document.querySelector('main').getBoundingClientRect().toJSON(), h: document.documentElement.scrollHeight }));
      const plain = await visitor({ locale: 'en-US' }, 'hint-layout');
      const pp = await plain.newPage();
      await pp.goto(U + POST);
      await settled(pp);
      assert.equal(await hint(pp), null);
      assert.deepEqual(await layout(page), await layout(pp));
      await plain.close();
      assert.ok(h.rect.left >= 0 && h.rect.right <= h.vw && h.rect.bottom <= h.vh && h.rect.top > h.vh / 2, JSON.stringify(h));
      // light theme colours (PaperMod variables)
      assert.equal(h.bg, 'rgb(255, 255, 255)');
      assert.equal(h.color, 'rgb(30, 30, 30)');
      await new Promise((r) => setTimeout(r, 400)); // let the fade-in finish
      await page.screenshot({ path: path.join(SHOTS, 'hint-zh-on-en-post.png') });
      // the home page too
      await page.goto(U + '/');
      await page.waitForSelector('.lang-hint');
      assert.equal((await hint(page)).href, '/zh/');
      // following the hint goes to the Chinese version, where nothing is shown
      await page.click('.lang-hint a');
      await page.waitForURL(`${U}/zh/`);
      await settled(page);
      assert.equal(await hint(page), null);
      await page.goto(`${U}/zh${POST}`);
      await settled(page);
      assert.equal(await hint(page), null, 'no hint on the page in the reader’s language');
      await ctx.close();
    });

    await test('hint: not shown for English readers on English pages, nor on pages without a translation', async () => {
      const en = await visitor({ locale: 'en-US' }, 'hint-en');
      const page = await en.newPage();
      for (const p of ['/', POST, '/about/', EN_ONLY]) {
        await page.goto(U + p);
        await settled(page);
        assert.equal(await hint(page), null, p);
      }
      await en.close();
      const zh = await visitor({ locale: 'zh-CN' }, 'hint-zh-2');
      const zp = await zh.newPage();
      await zp.goto(U + EN_ONLY);
      await settled(zp);
      assert.equal(await hint(zp), null, 'English-only page: nothing to offer');
      assert.equal(await zp.locator('script[data-hints]').count(), 0, 'no hint script without a translation');
      await zh.close();
      // navigator.languages is walked in order: the first site language wins
      for (const [langs, want] of [[['en-GB', 'zh-CN'], null], [['fr-FR', 'zh-TW', 'en'], '本页有中文版 →'], [['de-DE', 'fr'], null]]) {
        const c = await visitor({}, 'hint-langs');
        await c.addInitScript((l) => { Object.defineProperty(Navigator.prototype, 'languages', { get: () => l }); Object.defineProperty(Navigator.prototype, 'language', { get: () => l[0] }); }, langs);
        const cp = await c.newPage();
        await cp.goto(U + POST);
        await settled(cp);
        const h = await hint(cp);
        assert.equal(h && h.text, want, JSON.stringify(langs));
        await c.close();
      }
    });

    await test('hint: the reverse for English-preferring readers on /zh/ pages; not after switching languages on purpose', async () => {
      const ctx = await visitor({ locale: 'en-US' }, 'hint-rev');
      const page = await ctx.newPage();
      await page.goto(`${U}/zh${POST}`);
      await page.waitForSelector('.lang-hint');
      const h = await hint(page);
      assert.equal(h.text, 'This page is also available in English →');
      assert.equal(h.href, POST);
      assert.equal(h.lang, 'en');
      assert.equal(h.close, 'Dismiss');
      await page.goto(`${U}/zh${ZH_ONLY}`);
      await settled(page);
      assert.equal(await hint(page), null, 'Chinese-only page');
      await ctx.close();
      // came from the Chinese version of this very page (the language switch) → the reader chose English on purpose
      const zh = await visitor({ locale: 'zh-CN' }, 'hint-ref');
      const zp = await zh.newPage();
      await zp.goto(`${U}/`, { referer: `${U}/zh/` });
      await settled(zp);
      assert.equal(await hint(zp), null, 'no hint right after switching from /zh/');
      await zp.goto(`${U}/`, { referer: `${U}/zh/about/` });
      await zp.waitForSelector('.lang-hint');
      await zh.close();
    });

    await test('hint: × hides it and remembers the choice (localStorage, not an admin key); dark mode; phone width', async () => {
      const ctx = await visitor({ locale: 'zh-CN', colorScheme: 'dark' }, 'hint-dismiss');
      const page = await ctx.newPage();
      await page.goto(U + POST);
      await page.waitForSelector('.lang-hint');
      const h = await hint(page);
      // dark theme colours (PaperMod: --entry rgb(46, 46, 51), --primary rgb(218, 218, 219))
      assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'dark');
      assert.equal(h.bg, 'rgb(46, 46, 51)');
      assert.equal(h.color, 'rgb(218, 218, 219)');
      await new Promise((r) => setTimeout(r, 400)); // let the fade-in finish
      await page.screenshot({ path: path.join(SHOTS, 'hint-dark.png') });
      await page.click('.lang-hint button');
      assert.equal(await page.locator('.lang-hint').count(), 0);
      assert.equal(await page.evaluate((k) => localStorage.getItem(k), HINT_KEY), 'zh');
      const keys = await page.evaluate(() => [...new Set(window.__storage.map((s) => s.split(':').slice(1).join(':')))].sort());
      assert.ok(keys.includes(HINT_KEY), keys.join(' '));
      assert.deepEqual(keys.filter((k) => k.startsWith('admin')), [], 'never touches the admin’s keys');
      assert.deepEqual(await page.evaluate(() => window.__storage.filter((s) => s.startsWith('setItem:'))), [`setItem:${HINT_KEY}`]);
      for (const p of [POST, '/', '/about/']) {
        await page.goto(U + p);
        await settled(page);
        assert.equal(await hint(page), null, `${p}: dismissed for good`);
      }
      await page.reload();
      await settled(page);
      assert.equal(await hint(page), null, 'after a reload');
      await ctx.close();

      // phone: fits, no sideways scroll, does not cover the background switch (bottom left)
      for (const width of [390, 360]) {
        const pctx = await visitor({ locale: 'zh-CN', viewport: { width, height: 760 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }, 'hint-phone');
        const pp = await pctx.newPage();
        await pp.goto(U + POST);
        await pp.waitForSelector('.lang-hint');
        await settled(pp);
        const ph = await hint(pp);
        const sw = await pp.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
        assert.ok(sw, 'no horizontal scroll');
        assert.ok(ph.rect.left >= 0 && ph.rect.right <= ph.vw, JSON.stringify(ph));
        const toggle = await pp.evaluate(() => {
          const b = [...document.querySelectorAll('body > button')].find((x) => /background/i.test(x.getAttribute('aria-label') || ''));
          if (!b) return null;
          const r = b.getBoundingClientRect();
          return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
        });
        if (toggle) {
          const overlap = !(toggle.right <= ph.rect.left || toggle.left >= ph.rect.right || toggle.bottom <= ph.rect.top || toggle.top >= ph.rect.bottom);
          assert.ok(!overlap, `hint covers the background switch: ${JSON.stringify({ toggle, hint: ph.rect })}`);
        }
        if (width === 390) {
          await new Promise((r) => setTimeout(r, 400)); // let the fade-in finish
          await pp.screenshot({ path: path.join(SHOTS, 'hint-phone.png') });
        }
        await pctx.close();
      }
    });

    await test('no page errors; the only blocked requests are the KaTeX CDN', async () => {
      assert.deepEqual(problems, []);
      assert.deepEqual(external.filter((u) => !u.startsWith('https://cdn.jsdelivr.net/npm/katex@')), []);
    });
  } finally {
    await browser.close();
    await mock.close();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n[e2e-lang] ${results.length - failed.length}/${results.length} passed; screenshots in ${SHOTS}`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
