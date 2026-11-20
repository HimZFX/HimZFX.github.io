// tests/admin/e2e-nav-site.mjs — end-to-end test of the website's grouped top menu and blog categories:
//   layouts/partials/header.html (dropdowns: li.has-sub > a + button.nav-caret + div.nav-sub),
//   layouts/partials/nav/tree.html (menu structure shared by header and subnav), layouts/partials/subnav.html +
//   layouts/_default/baseof.html (sub-page tabs at the top of <main>), layouts/categories/{term,taxonomy}.html,
//   layouts/partials/post_meta.html (category on posts), assets/js/nav.js, assets/css/extended/nav.css, i18n/{en,zh}.yaml.
//
// Two builds with the pinned Hugo (the real content/ is never touched; fixtures go through the mock GitHub's seedFiles):
//   real     the repository as it is: About / Research / Blog / Course Materials; only Blog has sub-pages
//            (the Research Notes category has a post), publications / talks / news are not in the menu
//   grouped  publications + talks get menu.main.parent = research (weights 10 / 20), news parent = about (10),
//            plus a page content/teaching.md attached to about (20), an uncategorized post and a Chinese-only essay
//            (so 随笔 shows in the Chinese menu but Essays stays hidden in the English one)
//
// Covers: items / order / labels of every dropdown in en and zh, keyboard (Tab to ▾, Enter, ↓/↑, Esc returns focus,
// Tab out closes), mouse hover + click to pin + click outside, phone tap → full-width panel under the header (no
// horizontal scroll, one open at a time), no-JS fallback, the subnav (present / absent, aria-current), active
// underline, category pages (right posts, empty message, overview), category link on posts and cards, noindex on every
// generated page, no JS errors, desktop 769–1280 widths, phone 360 / 390 light + dark, the language hint and the
// background toggle not covered.
//
// Run from the repo root:   node tests/admin/e2e-nav-site.mjs
// Env:
//   NAV_SITE_E2E_DIR  where exports, builds and screenshots go
//                     (default: $ADMIN_TEST_TMP/e2e-nav-site or <os tmp>/admin-e2e-nav-site)
//   HUGO_BIN          Hugo binary (see mock-github.mjs)
//   ONLY=<substr>     run only tests whose name contains this

import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startMock, buildSite, hugoBin, REPO_ROOT } from './mock-github.mjs';

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

const OUT = path.resolve(process.env.NAV_SITE_E2E_DIR
  || (process.env.ADMIN_TEST_TMP ? path.join(process.env.ADMIN_TEST_TMP, 'e2e-nav-site') : path.join(os.tmpdir(), 'admin-e2e-nav-site')));
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

// ---------------------------------------------------------------------------
// fixtures

const read = (p) => fs.readFileSync(path.join(REPO_ROOT, p), 'utf8');
/** Insert a menu entry with a parent right after the opening --- (the shape the admin switch writes). */
function withParent(p, parent, weight) {
  const s = read(p);
  assert.match(s, /^---\n/, p);
  assert.doesNotMatch(s, /^menu:/m, `${p} has no menu entry in the repository (the user switched it off)`);
  return s.replace(/^---\n/, `---\nmenu:\n  main:\n    parent: ${parent}\n    weight: ${weight}\n`);
}

const GROUPED = {
  'content/publications/_index.md': withParent('content/publications/_index.md', 'research', 10),
  'content/publications/_index.zh.md': withParent('content/publications/_index.zh.md', 'research', 10),
  'content/talks/_index.md': withParent('content/talks/_index.md', 'research', 20),
  'content/talks/_index.zh.md': withParent('content/talks/_index.zh.md', 'research', 20),
  'content/news/_index.md': withParent('content/news/_index.md', 'about', 10),
  'content/news/_index.zh.md': withParent('content/news/_index.zh.md', 'about', 10),
  // any page can be attached to a parent the same way (here a plain single page, shared by both languages)
  'content/teaching.md': '---\ntitle: "Teaching"\nmenu:\n  main:\n    parent: about\n    weight: 20\nhidemeta: true\n---\n\nTeaching assistant notes.\n',
  'content/posts/plain-post.md': '---\ntitle: "Plain post without a category"\ndate: 2025-11-01\n---\n\nNo category here.\n',
  'content/posts/zh-essay.zh.md': '---\ntitle: "一篇中文随笔"\ndate: 2025-10-01\ncategories: [essays]\n---\n\n只有中文版的随笔。\n',
};

async function buildVariant(name, seedFiles) {
  const dir = path.join(OUT, name);
  fs.rmSync(dir, { recursive: true, force: true });
  const mock = await startMock({ seedFiles, siteDir: path.join(dir, 'site') });
  const exportDir = mock.exportTo(path.join(dir, 'export'));
  const built = await buildSite({ repoDir: exportDir, outDir: path.join(dir, 'site'), baseURL: mock.url + '/' });
  const warnings = (built.stdout + built.stderr).split('\n').filter((l) => /WARN|ERROR/.test(l));
  return { name, mock, exportDir, siteDir: path.join(dir, 'site'), built, warnings, origin: new URL(mock.url).origin };
}

// ---------------------------------------------------------------------------
// page helpers

async function newPage(context, origins) {
  const page = await context.newPage();
  const problems = [];
  page.on('pageerror', (e) => problems.push(`${page.url()}: ${e}`));
  page.on('console', (m) => { if (m.type() === 'error' && !/net::ERR_FAILED|Failed to load resource/.test(m.text())) problems.push(`${page.url()}: console: ${m.text()}`); });
  // KaTeX / giscus come from CDNs: never leave the machine.
  await page.route('**/*', (route) => (origins.includes(new URL(route.request().url()).origin) ? route.continue() : route.abort()));
  page.problems = problems;
  return page;
}

/** The top menu as the visitor sees it: items, carets and dropdown entries (path names only). */
const menuInfo = (page) => page.evaluate(() => [...document.querySelectorAll('#menu > li')].map((li) => {
  const a = li.querySelector(':scope > a');
  const caret = li.querySelector(':scope > .nav-caret');
  const sub = li.querySelector(':scope > .nav-sub');
  return {
    text: a.textContent.trim(),
    href: new URL(a.href).pathname,
    active: !!a.querySelector('.active'),
    caret: caret ? { label: caret.getAttribute('aria-label'), expanded: caret.getAttribute('aria-expanded'), controls: caret.getAttribute('aria-controls'), testid: caret.dataset.testid } : null,
    sub: sub ? [...sub.querySelectorAll('a.nav-sub-link')].map((x) => `${x.textContent.trim()} ${new URL(x.href).pathname}${x.getAttribute('aria-current') ? ' *' : ''}`) : null,
    subId: sub ? sub.id : null,
  };
}));

const subnavInfo = (page) => page.evaluate(() => {
  const n = document.querySelectorAll('main .subnav');
  if (!n.length) return null;
  const s = n[0];
  return {
    count: n.length,
    first: s === document.querySelector('main').firstElementChild,
    nav: s.dataset.nav,
    label: s.getAttribute('aria-label'),
    items: [...s.querySelectorAll('a.subnav-link')].map((x) => `${x.textContent.trim()} ${new URL(x.href).pathname}${x.getAttribute('aria-current') === 'page' ? ' *' : ''}`),
  };
});

const visibleSub = (page, id) => page.evaluate((id) => {
  const s = document.getElementById(`nav-sub-${id}`);
  const r = s.getBoundingClientRect();
  return getComputedStyle(s).display !== 'none' && r.width > 0 && r.height > 0;
}, id);
const openSubs = (page) => page.evaluate(() => [...document.querySelectorAll('.nav-sub')].filter((s) => getComputedStyle(s).display !== 'none').map((s) => s.id));
const expanded = (page, id) => page.getAttribute(`[data-testid="nav-caret-${id}"]`, 'aria-expanded');
const focused = (page) => page.evaluate(() => {
  const e = document.activeElement;
  return e ? (e.dataset.testid || `${e.tagName}.${e.className} ${e.textContent.trim()}`) : null;
});

const noHScroll = (page) => page.evaluate(() => ({
  sw: document.documentElement.scrollWidth,
  cw: document.documentElement.clientWidth,
  wide: [...document.querySelectorAll('body *')].filter((e) => {
    const r = e.getBoundingClientRect();
    if (!r.width || r.right <= document.documentElement.clientWidth + 0.5) return false;
    // inside a scroller of its own (the phone #menu row, the subnav row, code blocks): not a page overflow
    for (let p = e.parentElement; p && p !== document.body; p = p.parentElement) {
      const o = getComputedStyle(p).overflowX;
      if (o === 'auto' || o === 'scroll' || o === 'hidden') {
        const pr = p.getBoundingClientRect();
        if (pr.right <= document.documentElement.clientWidth + 0.5) return false;
      }
    }
    return true;
  }).slice(0, 5).map((e) => `${e.tagName}.${e.className}`),
}));

const rect = (page, sel) => page.evaluate((sel) => {
  const e = document.querySelector(sel);
  if (!e) return null;
  const r = e.getBoundingClientRect();
  return { x: r.x, y: r.y, w: r.width, h: r.height, right: r.right, bottom: r.bottom };
}, sel);
const intersects = (a, b) => !!(a && b && a.w && b.w && a.x < b.right && a.right > b.x && a.y < b.bottom && a.bottom > b.y);

/** Every page Hugo generated (static/ copies such as admin/ and viewer/ are not Hugo pages). */
function generatedPages(siteDir) {
  const out = [];
  const walk = (d) => {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (ent.name.endsWith('.html')) {
        const rel = path.relative(siteDir, p);
        if (!fs.existsSync(path.join(REPO_ROOT, 'static', rel))) out.push(rel);
      }
    }
  };
  walk(siteDir);
  return out.sort();
}

// ---------------------------------------------------------------------------

async function main() {
  console.log(`e2e-nav-site → ${OUT}`);
  const browser = await chromium.launch();
  const R = await buildVariant('real', {});
  const G = await buildVariant('grouped', GROUPED);
  const origins = [R.origin, G.origin];
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 }, locale: 'en-US' });
  const page = await newPage(ctx, origins);
  const go = async (p, v = G, pg = page) => {
    const res = await pg.goto(v.mock.url + p, { waitUntil: 'load' });
    return res.status();
  };
  const shot = (name, pg = page, full = false) => pg.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: full });

  await test('builds: no warnings', async () => {
    assert.deepEqual(R.warnings, []);
    assert.deepEqual(G.warnings, []);
  });

  // ---------------- the repository as it is ----------------

  await test('real site: 4 top items in both languages; only Blog has a ▾ (Research Notes has a post)', async () => {
    for (const [prefix, names, blog] of [
      ['', ['About', 'Research', 'Blog', 'Course Materials'], ['All posts /posts/', 'Research Notes /categories/notes/'], 'Show Blog submenu'],
      ['/zh', ['关于', '科研', '博客', '课程资料'], ['全部文章 /zh/posts/', '科研笔记 /zh/categories/notes/'], '展开「博客」子菜单'],
    ].map(([p, n, b, l]) => [p, n, { items: b, label: l }])) {
      assert.equal(await go(`${prefix}/`, R), 200);
      const M = await menuInfo(page);
      assert.deepEqual(M.map((m) => m.text), names);
      assert.deepEqual(M.map((m) => m.href), ['about', 'research', 'posts', 'courses'].map((s) => `${prefix}/${s}/`));
      assert.deepEqual(M.map((m) => !!m.caret), [false, false, true, false]);
      assert.deepEqual(M[2].sub, blog.items);
      assert.equal(M[2].caret.label, blog.label);
      assert.equal(M[2].caret.expanded, 'false');
      assert.equal(M[2].caret.controls, M[2].subId);
      assert.equal(M[2].caret.testid, 'nav-caret-posts');
      assert.ok(!M.some((m) => /publications|talks|news/.test(m.href + (m.sub || []).join(' '))));
      // the dropdown is closed until asked for
      assert.deepEqual(await openSubs(page), []);
    }
    await shot('real-home-desktop');
  });

  await test('real site: subnav only on Blog pages (posts list, category overview, category pages)', async () => {
    const expectNone = ['/', '/about/', '/research/', '/courses/', '/publications/', '/talks/', '/news/', '/posts/first-physics-note/',
      '/zh/', '/zh/about/', '/zh/research/', '/zh/courses/', '/zh/posts/first-physics-note/'];
    for (const p of expectNone) {
      assert.equal(await go(p, R), 200, p);
      assert.equal(await subnavInfo(page), null, p);
    }
    const cases = {
      '/posts/': ['All posts /posts/ *', 'Research Notes /categories/notes/'],
      '/categories/': ['All posts /posts/', 'Research Notes /categories/notes/'],
      '/categories/notes/': ['All posts /posts/', 'Research Notes /categories/notes/ *'],
      // an empty category is not in the menu, but its page still builds with the Blog row
      '/categories/essays/': ['All posts /posts/', 'Research Notes /categories/notes/'],
      '/zh/posts/': ['全部文章 /zh/posts/ *', '科研笔记 /zh/categories/notes/'],
      '/zh/categories/notes/': ['全部文章 /zh/posts/', '科研笔记 /zh/categories/notes/ *'],
    };
    for (const [p, items] of Object.entries(cases)) {
      assert.equal(await go(p, R), 200, p);
      const S = await subnavInfo(page);
      assert.ok(S, `${p}: subnav`);
      assert.equal(S.count, 1, p);
      assert.ok(S.first, `${p}: subnav is the first thing in <main>`);
      assert.equal(S.nav, 'posts');
      assert.deepEqual(S.items, items, p);
      assert.equal(S.label, p.startsWith('/zh') ? '「博客」下的页面' : 'Blog pages');
    }
    await go('/categories/essays/', R);
    assert.equal((await page.textContent('[data-testid="category-empty"]')).trim(), 'No posts in this category yet.');
    await go('/zh/categories/essays/', R);
    assert.equal((await page.textContent('[data-testid="category-empty"]')).trim(), '这个分类还没有文章。');
    assert.equal((await page.textContent('main h1')).trim(), '随笔');
  });

  await test('real site: the category shows on the post (linked) and on its card; the card link stays clickable', async () => {
    await go('/posts/first-physics-note/', R);
    const cat = await page.$eval('.post-meta .post-cat a', (a) => ({ text: a.textContent, href: new URL(a.href).pathname }));
    assert.deepEqual(cat, { text: 'Research Notes', href: '/categories/notes/' });
    await go('/zh/posts/', R);
    const card = await page.$eval('.post-entry .entry-footer .post-cat a', (a) => ({ text: a.textContent, href: new URL(a.href).pathname }));
    assert.deepEqual(card, { text: '科研笔记', href: '/zh/categories/notes/' });
    // the whole card is a link (.entry-link); the category link sits on top of it
    const hit = await page.evaluate(() => {
      const a = document.querySelector('.post-entry .post-cat a');
      const r = a.getBoundingClientRect();
      const e = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      return e === a || a.contains(e);
    });
    assert.ok(hit, 'category link is on top of the card link');
    await page.click('.post-entry .post-cat a');
    await page.waitForURL(/\/zh\/categories\/notes\/$/);
    assert.equal((await page.textContent('main h1')).trim(), '科研笔记');
    assert.deepEqual(await page.$$eval('main .post-entry h2', (h) => h.map((x) => x.textContent.trim())), ['广义相对论中的度规张量']);
  });

  // ---------------- grouped menu ----------------

  const EXPECT = {
    en: [
      { text: 'About', href: '/about/', sub: ['About me /about/', 'News /news/', 'Teaching /teaching/'], label: 'Show About submenu' },
      { text: 'Research', href: '/research/', sub: ['Overview /research/', 'Publications /publications/', 'Talks & Posters /talks/'], label: 'Show Research submenu' },
      { text: 'Blog', href: '/posts/', sub: ['All posts /posts/', 'Research Notes /categories/notes/'], label: 'Show Blog submenu' },
      { text: 'Course Materials', href: '/courses/', sub: null, label: null },
    ],
    zh: [
      { text: '关于', href: '/zh/about/', sub: ['关于我 /zh/about/', '近况 /zh/news/', 'Teaching /zh/teaching/'], label: '展开「关于」子菜单' },
      { text: '科研', href: '/zh/research/', sub: ['概览 /zh/research/', '论文 /zh/publications/', '报告与海报 /zh/talks/'], label: '展开「科研」子菜单' },
      // the Chinese-only essay makes 随笔 non-empty in Chinese (and only there)
      { text: '博客', href: '/zh/posts/', sub: ['全部文章 /zh/posts/', '科研笔记 /zh/categories/notes/', '随笔 /zh/categories/essays/'], label: '展开「博客」子菜单' },
      { text: '课程资料', href: '/zh/courses/', sub: null, label: null },
    ],
  };

  await test('grouped: carets, dropdown items / order / labels in en and zh; Course Materials unchanged', async () => {
    for (const [lang, prefix] of [['en', ''], ['zh', '/zh']]) {
      assert.equal(await go(`${prefix}/courses/`), 200);
      const M = await menuInfo(page);
      assert.deepEqual(M.map((m) => ({ text: m.text, href: m.href, sub: m.sub, label: m.caret && m.caret.label })), EXPECT[lang], lang);
      for (const m of M.filter((x) => x.caret)) {
        assert.equal(m.caret.controls, m.subId);
        assert.equal(m.caret.expanded, 'false');
      }
      // ids are unique and point at the right element
      const ids = M.filter((x) => x.subId).map((x) => x.subId);
      assert.deepEqual(ids, ['nav-sub-about', 'nav-sub-research', 'nav-sub-posts']);
      // Course Materials is exactly a plain item
      assert.equal(await page.$eval('#menu > li:last-child', (li) => li.className), '');
      assert.equal(await page.$eval('#menu > li:last-child', (li) => li.children.length), 1);
    }
  });

  await test('grouped: active underline follows the section (self, child, post, category page)', async () => {
    const cases = {
      '/': [], '/about/': ['About'], '/news/': ['About'], '/teaching/': ['About'], '/research/': ['Research'],
      '/publications/': ['Research'], '/talks/': ['Research'], '/posts/': ['Blog'], '/posts/plain-post/': ['Blog'],
      '/categories/': ['Blog'], '/categories/notes/': ['Blog'], '/categories/essays/': ['Blog'], '/courses/': ['Course Materials'],
      '/zh/news/': ['关于'], '/zh/categories/essays/': ['博客'],
    };
    for (const [p, act] of Object.entries(cases)) {
      await go(p);
      assert.deepEqual((await menuInfo(page)).filter((m) => m.active).map((m) => m.text), act, p);
    }
    // the current page is marked in the dropdown too
    await go('/talks/');
    assert.deepEqual((await menuInfo(page))[1].sub, ['Overview /research/', 'Publications /publications/', 'Talks & Posters /talks/ *']);
  });

  await test('grouped: subnav on parent and child pages with aria-current; not on home, posts, courses', async () => {
    const cases = {
      '/about/': ['about', ['About me /about/ *', 'News /news/', 'Teaching /teaching/']],
      '/news/': ['about', ['About me /about/', 'News /news/ *', 'Teaching /teaching/']],
      '/teaching/': ['about', ['About me /about/', 'News /news/', 'Teaching /teaching/ *']],
      '/research/': ['research', ['Overview /research/ *', 'Publications /publications/', 'Talks & Posters /talks/']],
      '/publications/': ['research', ['Overview /research/', 'Publications /publications/ *', 'Talks & Posters /talks/']],
      '/talks/': ['research', ['Overview /research/', 'Publications /publications/', 'Talks & Posters /talks/ *']],
      '/posts/': ['posts', ['All posts /posts/ *', 'Research Notes /categories/notes/']],
      '/categories/notes/': ['posts', ['All posts /posts/', 'Research Notes /categories/notes/ *']],
      '/categories/essays/': ['posts', ['All posts /posts/', 'Research Notes /categories/notes/']],
      '/zh/research/': ['research', ['概览 /zh/research/ *', '论文 /zh/publications/', '报告与海报 /zh/talks/']],
      '/zh/news/': ['about', ['关于我 /zh/about/', '近况 /zh/news/ *', 'Teaching /zh/teaching/']],
      '/zh/categories/essays/': ['posts', ['全部文章 /zh/posts/', '科研笔记 /zh/categories/notes/', '随笔 /zh/categories/essays/ *']],
      '/zh/categories/': ['posts', ['全部文章 /zh/posts/', '科研笔记 /zh/categories/notes/', '随笔 /zh/categories/essays/']],
    };
    for (const [p, [nav, items]] of Object.entries(cases)) {
      assert.equal(await go(p), 200, p);
      const S = await subnavInfo(page);
      assert.ok(S && S.first, `${p}: subnav first in <main>`);
      assert.equal(S.nav, nav, p);
      assert.deepEqual(S.items, items, p);
    }
    for (const p of ['/', '/zh/', '/courses/', '/zh/courses/', '/posts/plain-post/', '/posts/first-physics-note/', '/zh/posts/zh-essay/']) {
      assert.equal(await go(p), 200, p);
      assert.equal(await subnavInfo(page), null, p);
    }
    await go('/research/');
    await shot('grouped-research-subnav-desktop-light');
    await go('/publications/');
    await shot('grouped-publications-subnav-desktop-light');
    await go('/zh/categories/essays/');
    await shot('grouped-zh-category-subnav-desktop-light');
  });

  await test('grouped: category pages list the right posts; empty category hidden from the English menu; overview', async () => {
    await go('/posts/');
    const all = await page.$$eval('main .post-entry h2', (h) => h.map((x) => x.textContent.trim()));
    assert.deepEqual(all, ['Metric Tensor in GR', 'Plain post without a category']);
    await go('/categories/notes/');
    assert.deepEqual(await page.$$eval('main .post-entry h2', (h) => h.map((x) => x.textContent.trim())), ['Metric Tensor in GR']);
    assert.match(await page.textContent('main .post-description'), /Notes on physics and astrophysics/);
    await go('/categories/essays/');
    assert.equal(await page.locator('main .post-entry').count(), 0);
    assert.equal(await page.locator('[data-testid="category-empty"]').count(), 1);
    await go('/zh/categories/essays/');
    assert.deepEqual(await page.$$eval('main .post-entry h2', (h) => h.map((x) => x.textContent.trim())), ['一篇中文随笔']);
    assert.equal(await page.locator('[data-testid="category-empty"]').count(), 0);
    await go('/zh/posts/');
    assert.deepEqual(await page.$$eval('main .post-entry h2', (h) => h.map((x) => x.textContent.trim())), ['广义相对论中的度规张量', 'Plain post without a category', '一篇中文随笔']);
    // overview: every category (empty ones too) with its description and count, in weight order
    for (const [p, h1, cards] of [
      ['/categories/', 'Categories', [['notes', 'Research Notes', '1 post'], ['essays', 'Essays', '0 posts']]],
      ['/zh/categories/', '分类', [['notes', '科研笔记', '1 篇文章'], ['essays', '随笔', '1 篇文章']]],
    ]) {
      await go(p);
      assert.equal((await page.textContent('main h1')).trim(), h1);
      const C = await page.$$eval('[data-testid="category-index"] .category-card', (cs) => cs.map((c) => [c.dataset.category, c.querySelector('h2').textContent.trim(), c.querySelector('.entry-footer').textContent.trim(), new URL(c.querySelector('a.entry-link').href).pathname]));
      assert.deepEqual(C.map((c) => c.slice(0, 3)), cards, p);
      assert.deepEqual(C.map((c) => c[3]), cards.map(([k]) => `${p}${k}/`));
    }
    await shot('grouped-categories-overview-desktop-light');
  });

  await test('desktop: hover opens, leaving closes; click ▾ pins it; click outside closes; one at a time', async () => {
    await go('/research/');
    await page.hover('li[data-nav="research"] > a');
    assert.ok(await visibleSub(page, 'research'));
    assert.equal(await expanded(page, 'research'), 'true');
    // move into the dropdown: stays open
    await page.hover('#nav-sub-research a.nav-sub-link:nth-child(3)');
    await page.waitForTimeout(300);
    assert.ok(await visibleSub(page, 'research'));
    // the dropdown sits under its item, inside the viewport, above the subnav
    const sub = await rect(page, '#nav-sub-research');
    const li = await rect(page, 'li[data-nav="research"]');
    assert.ok(sub.y >= li.y + 30 && sub.x >= li.x - 20 && sub.right <= 1280, JSON.stringify({ sub, li }));
    const topEl = await page.evaluate(() => {
      const s = document.querySelector('#nav-sub-research a.nav-sub-link:nth-child(2)');
      const r = s.getBoundingClientRect();
      return document.elementFromPoint(r.x + 10, r.y + r.height / 2) === s;
    });
    assert.ok(topEl, 'dropdown is on top of the page content');
    await shot('grouped-dropdown-hover-desktop-light');
    await page.mouse.move(640, 700);
    await page.waitForTimeout(400);
    assert.equal(await visibleSub(page, 'research'), false);
    assert.equal(await expanded(page, 'research'), 'false');
    // hovering another item closes the first
    await page.hover('li[data-nav="about"] > a');
    assert.deepEqual(await openSubs(page), ['nav-sub-about']);
    await page.hover('li[data-nav="posts"] > a');
    assert.deepEqual(await openSubs(page), ['nav-sub-posts']);
    await page.mouse.move(640, 700);
    await page.waitForTimeout(400);
    assert.deepEqual(await openSubs(page), []);
    // click ▾: pinned, survives the mouse leaving
    await page.click('[data-testid="nav-caret-research"]');
    await page.mouse.move(640, 700);
    await page.waitForTimeout(400);
    assert.deepEqual(await openSubs(page), ['nav-sub-research']);
    assert.equal(await expanded(page, 'research'), 'true');
    // click outside closes
    await page.mouse.click(640, 700);
    assert.deepEqual(await openSubs(page), []);
    // click ▾ twice: open, closed
    await page.click('[data-testid="nav-caret-posts"]');
    assert.deepEqual(await openSubs(page), ['nav-sub-posts']);
    await page.click('[data-testid="nav-caret-posts"]');
    await page.mouse.move(640, 700);
    await page.waitForTimeout(300);
    assert.deepEqual(await openSubs(page), []);
    // following a dropdown link navigates
    await page.click('[data-testid="nav-caret-research"]');
    await page.click('#nav-sub-research a:has-text("Publications")');
    await page.waitForURL(/\/publications\/$/);
    assert.equal((await page.textContent('main h1')).trim(), 'Publications');
  });

  await test('desktop keyboard: Tab to ▾, Enter opens, ↓/↑ move, Esc closes and returns focus, Tab out closes', async () => {
    await go('/zh/');
    await page.mouse.move(640, 800);
    await page.focus('li[data-nav="research"] > a');
    // focusing the parent link alone does not open it (disclosure pattern: the ▾ button opens)
    assert.deepEqual(await openSubs(page), []);
    await page.keyboard.press('Tab');
    assert.equal(await focused(page), 'nav-caret-research');
    await page.keyboard.press('Enter');
    assert.ok(await visibleSub(page, 'research'));
    assert.equal(await expanded(page, 'research'), 'true');
    await page.keyboard.press('Tab');
    assert.match(await focused(page), /nav-sub-link 概览$/);
    await page.keyboard.press('ArrowDown');
    assert.match(await focused(page), /nav-sub-link 论文$/);
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('ArrowUp');
    assert.equal(await focused(page), 'nav-caret-research');
    await shot('grouped-dropdown-keyboard-zh-desktop-light');
    await page.keyboard.press('ArrowDown');
    assert.match(await focused(page), /nav-sub-link 概览$/);
    await page.keyboard.press('Escape');
    assert.deepEqual(await openSubs(page), []);
    assert.equal(await expanded(page, 'research'), 'false');
    assert.equal(await focused(page), 'nav-caret-research');
    // Space toggles too; Enter again closes
    await page.keyboard.press('Space');
    assert.ok(await visibleSub(page, 'research'));
    await page.keyboard.press('Enter');
    assert.deepEqual(await openSubs(page), []);
    // tabbing through the open dropdown and out of it closes it
    await page.keyboard.press('Enter');
    for (let i = 0; i < 3; i++) await page.keyboard.press('Tab');
    assert.match(await focused(page), /nav-sub-link 报告与海报$/);
    assert.ok(await visibleSub(page, 'research'));
    await page.keyboard.press('Tab');
    assert.match(await focused(page), /博客$/);
    assert.deepEqual(await openSubs(page), []);
    assert.equal(await expanded(page, 'research'), 'false');
    // Enter on a dropdown link follows it
    await page.keyboard.press('Tab');
    assert.equal(await focused(page), 'nav-caret-posts');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    assert.match(await focused(page), /nav-sub-link 随笔$/);
    await Promise.all([page.waitForURL(/\/zh\/categories\/essays\/$/), page.keyboard.press('Enter')]);
  });

  await test('desktop widths 769–1280, en and zh: no horizontal scroll; open dropdowns stay inside the viewport', async () => {
    for (const width of [769, 820, 1024, 1280]) {
      for (const p of ['/research/', '/zh/categories/essays/']) {
        await page.setViewportSize({ width, height: 800 });
        await go(p);
        let h = await noHScroll(page);
        assert.ok(h.sw <= h.cw, `${width} ${p}: scrollWidth ${h.sw} > ${h.cw} (${h.wide.join(', ')})`);
        for (const id of ['about', 'research', 'posts']) {
          await page.click(`[data-testid="nav-caret-${id}"]`);
          const r = await rect(page, `#nav-sub-${id}`);
          assert.ok(r.x >= 0 && r.right <= width, `${width} ${p} ${id}: ${JSON.stringify(r)}`);
          h = await noHScroll(page);
          assert.ok(h.sw <= h.cw, `${width} ${p} ${id} open: scrollWidth ${h.sw} > ${h.cw}`);
        }
        await page.keyboard.press('Escape');
      }
    }
    await page.setViewportSize({ width: 1280, height: 860 });
  });

  await test('long child names, and a dropdown on the last item (Course Materials), stay inside the viewport', async () => {
    // the admin's 「放在哪个栏目下」 can attach any page under any of the 4 items, including Course Materials (the last one)
    const L = await buildVariant('long', {
      ...GROUPED,
      'content/ta-notes.md': '---\ntitle: "Teaching Assistant Notes for Classical Electrodynamics"\nmenu:\n  main:\n    parent: courses\n    weight: 10\n---\n\nTA notes.\n',
      'content/reading.md': '---\ntitle: "Reading list of review articles on galaxy formation"\nmenu:\n  main:\n    parent: posts\n    weight: 50\n---\n\nReading.\n',
    });
    assert.deepEqual(L.warnings, []);
    const lpage = await newPage(ctx, [L.origin]);
    for (const width of [820, 1024, 1280]) {
      await lpage.setViewportSize({ width, height: 800 });
      await lpage.goto(L.mock.url + '/courses/');
      for (const id of ['about', 'research', 'posts', 'courses']) {
        await lpage.click(`[data-testid="nav-caret-${id}"]`);
        const r = await rect(lpage, `#nav-sub-${id}`);
        assert.ok(r && r.w > 0 && r.x >= 0 && r.right <= width, `${width} ${id}: ${JSON.stringify(r)}`);
        assert.ok(r.w <= 300.5, `${width} ${id}: dropdown at most 300px wide (long names wrap), got ${r.w}`);
        const h = await noHScroll(lpage);
        assert.ok(h.sw <= h.cw, `${width} ${id} open: scrollWidth ${h.sw} > ${h.cw}`);
        if (width === 1280 && id === 'courses') await shot('long-courses-dropdown-desktop', lpage);
        await lpage.keyboard.press('Escape');
      }
    }
    assert.deepEqual(lpage.problems, []);
    await lpage.close();
    await L.mock.close();
    // kept only when an assertion above failed (like the other builds)
    fs.rmSync(path.join(OUT, L.name), { recursive: true, force: true });
  });

  await test('without JavaScript: parent links work, CSS hover still opens on desktop, subnav reaches the children', async () => {
    const nctx = await browser.newContext({ viewport: { width: 1280, height: 860 }, javaScriptEnabled: false, locale: 'en-US' });
    try {
      const np = await newPage(nctx, origins);
      await go('/research/', G, np);
      assert.equal(await np.evaluate(() => document.getElementById('menu').classList.contains('nav-js')), false);
      assert.deepEqual(await openSubs(np), []);
      await np.hover('li[data-nav="research"] > a');
      assert.ok(await visibleSub(np, 'research'));
      await np.mouse.move(640, 700);
      assert.deepEqual(await openSubs(np), []);
      // keyboard focus inside the item shows it too (:focus-within)
      await np.focus('[data-testid="nav-caret-about"]');
      assert.ok(await visibleSub(np, 'about'));
      await np.click('main .subnav a:has-text("Talks & Posters")');
      await np.waitForURL(/\/talks\/$/);
      await np.click('li[data-nav="about"] > a');
      await np.waitForURL(/\/about\/$/);
      const pc = await browser.newContext({ viewport: { width: 360, height: 740 }, javaScriptEnabled: false, isMobile: true, hasTouch: true, locale: 'en-US' });
      const pp = await newPage(pc, origins);
      await go('/publications/', G, pp);
      const h = await noHScroll(pp);
      assert.ok(h.sw <= h.cw, `no-JS phone: ${h.sw} > ${h.cw} ${h.wide.join(', ')}`);
      assert.deepEqual(await openSubs(pp), []);
      assert.ok((await subnavInfo(pp)).items.length === 3);
      await pc.close();
      assert.deepEqual(np.problems, []);
    } finally {
      await nctx.close();
    }
  });

  await test('desktop dark mode: theme colours on dropdown and subnav; screenshots', async () => {
    const dctx = await browser.newContext({ viewport: { width: 1280, height: 860 }, colorScheme: 'dark', locale: 'en-US' });
    try {
      const dp = await newPage(dctx, origins);
      for (const p of ['/publications/', '/zh/about/', '/categories/notes/']) {
        await go(p, G, dp);
        assert.equal(await dp.evaluate(() => document.documentElement.dataset.theme), 'dark');
        const id = p.includes('about') ? 'about' : p.includes('categories') ? 'posts' : 'research';
        await dp.click(`[data-testid="nav-caret-${id}"]`);
        const c = await dp.evaluate((id) => ({
          sub: getComputedStyle(document.getElementById(`nav-sub-${id}`)).backgroundColor,
          link: getComputedStyle(document.querySelector(`#nav-sub-${id} .nav-sub-link`)).color,
          pill: getComputedStyle(document.querySelector('.subnav-link[aria-current="page"]')).backgroundColor,
          pillText: getComputedStyle(document.querySelector('.subnav-link[aria-current="page"]')).color,
          other: getComputedStyle(document.querySelector('.subnav-link:not([aria-current])')).backgroundColor,
        }), id);
        assert.deepEqual(c, { sub: 'rgb(46, 46, 51)', link: 'rgb(218, 218, 219)', pill: 'rgb(218, 218, 219)', pillText: 'rgb(29, 30, 32)', other: 'rgb(46, 46, 51)' }, p);
        await shot(`grouped-${p.replace(/\//g, '_').replace(/^_|_$/g, '')}-dropdown-desktop-dark`, dp);
      }
      assert.deepEqual(dp.problems, []);
    } finally {
      await dctx.close();
    }
  });

  // ---------------- phones ----------------

  for (const width of [360, 390]) {
    for (const scheme of ['light', 'dark']) {
      await test(`phone ${width} ${scheme}: tap ▾ → full-width panel under the header, one at a time, no horizontal scroll`, async () => {
        // zh-CN browser on English pages → the language hint shows at the bottom
        const pctx = await browser.newContext({ viewport: { width, height: 760 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: scheme, locale: 'zh-CN' });
        try {
          const pp = await newPage(pctx, origins);
          for (const p of ['/research/', '/publications/', '/zh/about/', '/categories/notes/', '/zh/categories/essays/', '/', '/posts/first-physics-note/', '/courses/']) {
            await go(p, G, pp);
            assert.equal(await pp.evaluate(() => document.documentElement.dataset.theme), scheme);
            let h = await noHScroll(pp);
            assert.ok(h.sw <= h.cw, `${p}: scrollWidth ${h.sw} > ${h.cw} (${h.wide.join(', ')})`);
            // every top item is fully on screen (the menu wraps to a second row instead of hiding items to the right)
            const off = await pp.evaluate(() => [...document.querySelectorAll('#menu > li')].filter((li) => {
              const r = li.getBoundingClientRect();
              return r.x < 0 || r.right > document.documentElement.clientWidth + 0.5;
            }).map((li) => li.textContent.trim()));
            assert.deepEqual(off, [], `${p}: menu items off screen`);
            const S = await subnavInfo(pp);
            if (S) {
              // the tab row scrolls inside itself, never widens the page
              const sr = await rect(pp, 'main .subnav');
              assert.ok(sr.x >= 0 && sr.right <= width, `${p} subnav ${JSON.stringify(sr)}`);
            }
            const tag = p.replace(/\//g, '_').replace(/^_|_$/g, '') || 'home';
            if (['/research/', '/zh/about/', '/zh/categories/essays/', '/'].includes(p)) await pp.screenshot({ path: path.join(SHOTS, `phone-${width}-${scheme}-${tag}.png`) });
          }

          await go('/research/', G, pp);
          const header = await rect(pp, 'header.header');
                    for (const id of ['research', 'posts', 'about']) {
            await pp.locator(`[data-testid="nav-caret-${id}"]`).scrollIntoViewIfNeeded();
            await pp.tap(`[data-testid="nav-caret-${id}"]`);
            assert.deepEqual(await openSubs(pp), [`nav-sub-${id}`], `${id} open alone`);
            assert.equal(await expanded(pp, id), 'true');
            const r = await rect(pp, `#nav-sub-${id}`);
            const cw = await pp.evaluate(() => document.documentElement.clientWidth);
            assert.ok(Math.abs(r.x) < 1 && Math.abs(r.w - cw) < 1, `${id} panel full width: ${JSON.stringify(r)} cw ${cw}`);
            assert.ok(Math.abs(r.y - header.bottom) < 2, `${id} panel right under the header: ${r.y} vs ${header.bottom}`);
            const h = await noHScroll(pp);
            assert.ok(h.sw <= h.cw, `${id} open: scrollWidth ${h.sw} > ${h.cw} (${h.wide.join(', ')})`);
            // big enough touch targets, nothing clipped: every link is the top element at its centre
            const links = await pp.evaluate((id) => [...document.querySelectorAll(`#nav-sub-${id} .nav-sub-link`)].map((a) => {
              const q = a.getBoundingClientRect();
              const e = document.elementFromPoint(q.x + q.width / 2, q.y + q.height / 2);
              return { h: q.height, top: e === a || a.contains(e) };
            }), id);
            assert.ok(links.every((l) => l.h >= 40 && l.top), `${id}: ${JSON.stringify(links)}`);
            // not over the language hint or the background toggle
            for (const other of ['.lang-hint', '.bg-toggle']) assert.ok(!intersects(r, await rect(pp, other)), `${id} panel vs ${other}`);
            if (id === 'research') await pp.waitForTimeout(300); // the ▾ turns over in 0.2 s
            if (id === 'research') await pp.screenshot({ path: path.join(SHOTS, `phone-${width}-${scheme}-panel-research.png`) });
          }
          assert.ok(await pp.locator('.lang-hint').isVisible(), 'the language hint is shown (zh-CN reader, English page)');
          // tap ▾ again closes; tap outside closes
          await pp.tap('[data-testid="nav-caret-about"]');
          assert.deepEqual(await openSubs(pp), []);
          await pp.tap('[data-testid="nav-caret-research"]');
          // (the panel covers the top of the page, so tap below it)
          await pp.touchscreen.tap(width / 2, 600);
          assert.deepEqual(await openSubs(pp), []);
          // tapping a panel link navigates
          await pp.tap('[data-testid="nav-caret-research"]');
          await Promise.all([pp.waitForURL(/\/talks\/$/), pp.tap('#nav-sub-research a:has-text("Talks & Posters")')]);
          // subnav and the docked background toggle in the footer do not collide; the hint does not cover the subnav
          const sn = await rect(pp, 'main .subnav');
          for (const other of ['.lang-hint', '.bg-toggle']) assert.ok(!intersects(sn, await rect(pp, other)), `subnav vs ${other}`);
          assert.deepEqual(pp.problems, []);
        } finally {
          await pctx.close();
        }
      });
    }
  }

  // ---------------- every page ----------------

  await test('every generated page is noindex (incl. category / taxonomy pages) and has no JSON-LD added by us', async () => {
    for (const V of [R, G]) {
      const pages = generatedPages(V.siteDir);
      assert.ok(pages.includes('categories/index.html') && pages.includes('zh/categories/notes/index.html') && pages.includes('categories/essays/index.html'), V.name);
      const bad = pages.filter((p) => !/<meta name="?robots"? content="?noindex/.test(fs.readFileSync(path.join(V.siteDir, p), 'utf8')));
      assert.deepEqual(bad, [], `${V.name}: pages without noindex`);
      // only first-party scripts: nav.js is local
      const html = fs.readFileSync(path.join(V.siteDir, 'research/index.html'), 'utf8');
      const src = /<script defer src="?([^" >]*nav[^" >]*\.js)/.exec(html);
      assert.ok(src && src[1].startsWith('/js/nav'), `${V.name}: nav.js loaded from the site (${src && src[1]})`);
    }
  });

  await test('no page errors on the desktop pages', async () => {
    assert.deepEqual(page.problems, []);
  });

  await browser.close();
  await R.mock.close();
  await G.mock.close();
  const failed = results.filter((r) => !r.ok);
  // the builds are only kept for inspecting a failure; screenshots always stay
  if (!failed.length) for (const V of [R, G]) fs.rmSync(path.join(OUT, V.name), { recursive: true, force: true });
  console.log(`\n${results.length - failed.length}/${results.length} passed. Screenshots: ${SHOTS}`);
  if (failed.length) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
