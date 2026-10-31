// tests/admin/e2e-lists.mjs — Playwright end-to-end test for the 文章 (posts.js) and 页面 (pages.js) views.
//
// Run from the repo root:   node tests/admin/e2e-lists.mjs
// Env:
//   LISTS_E2E_DIR   where the Hugo builds + screenshots go (default: <os tmp>/admin-e2e-lists)
//   SKIP_BUILD=1    reuse an existing build in LISTS_E2E_DIR/site
//   HUGO_BIN        Hugo binary (see mock-github.mjs)
//
// The admin JS is served live from static/admin (mock adminDir); the build only provides the public
// site. Every request to another origin (cdn.jsdelivr.net, github.io, api.github.com …) is aborted.
// Assertions are made on the MOCK's resulting files, not only on the UI.

import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startMock, buildSite, openAdmin, REPO_ROOT } from './mock-github.mjs';

const { chromium } = createRequire(import.meta.url)('playwright');

const OUT = path.resolve(process.env.LISTS_E2E_DIR || path.join(os.tmpdir(), 'admin-e2e-lists'));
const SITE_DIR = path.join(OUT, 'site');
const SHOTS = path.join(OUT, 'screenshots');
const ADMIN_DIR = path.join(REPO_ROOT, 'static', 'admin');
fs.mkdirSync(SHOTS, { recursive: true });

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

const waitView = (page, route) => page.waitForSelector(`body[data-view-ready="${route}"]`, { state: 'attached', timeout: 20000 });

async function goto(page, hash, route) {
  await page.evaluate((h) => { location.hash = h; }, hash);
  await waitView(page, route);
}

/** Re-mount a view (navigate away and back) so it re-reads drafts / repo state. */
async function remount(page, hash, route) {
  await goto(page, '#/files', 'files').catch(() => {});
  await goto(page, hash, route);
}

const innerText = (page, sel) => page.$eval(sel, (e) => e.innerText.replace(/\s+/g, ' ').trim());

/** Wait until the list shows exactly these row keys (in order). */
async function waitRows(page, keys, listTestId = 'posts-list', rowTestId = 'post-row') {
  await page.waitForFunction(({ keys, l, r }) => {
    const got = [...document.querySelectorAll(`[data-testid="${l}"] [data-testid="${r}"]`)].map((e) => e.dataset.key);
    return JSON.stringify(got) === JSON.stringify(keys);
  }, { keys, l: listTestId, r: rowTestId }, { timeout: 5000 }).catch(() => {});
  assert.deepEqual(await rowKeys(page, listTestId, rowTestId), keys);
}

const rowKeys = (page, listTestId = 'posts-list', rowTestId = 'post-row') =>
  page.$$eval(`[data-testid="${listTestId}"] [data-testid="${rowTestId}"]`, (els) => els.map((e) => e.dataset.key));

async function rowText(page, key, rowTestId = 'post-row') {
  return page.$eval(`[data-testid="${rowTestId}"][data-key="${key}"]`, (e) => e.innerText.replace(/\s+/g, ' '));
}

async function noHorizontalScroll(page) {
  const r = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, w: window.innerWidth }));
  assert.ok(r.sw <= r.w + 1, `horizontal scroll: scrollWidth ${r.sw} > ${r.w}`);
}

/** Extract the PaperMod top-nav items (text + href) from a built page. */
function navItems(html) {
  const m = /<ul id=["']?menu["']?[^>]*>([\s\S]*?)<\/ul>/.exec(html);
  assert.ok(m, 'nav menu not found in built page');
  return [...m[1].matchAll(/<a\b[^>]*href=["']?([^"' >]+)["']?[^>]*>([\s\S]*?)<\/a>/g)]
    .map((x) => ({ href: x[1], text: x[2].replace(/<[^>]+>/g, '').trim() }));
}

function bodyOf(text) {
  const i = text.indexOf('\n---\n', 4);
  return text.slice(i + 5);
}

// ---------------------------------------------------------------------------

async function main() {
  const mock = await startMock({ siteDir: SITE_DIR, adminDir: ADMIN_DIR, runDelayMs: 600 });
  if (!(process.env.SKIP_BUILD && fs.existsSync(path.join(SITE_DIR, 'index.html')))) {
    console.log(`Building site into ${SITE_DIR} …`);
    const r = await buildSite({ repoDir: REPO_ROOT, outDir: SITE_DIR, baseURL: mock.url + '/' });
    console.log(`  built in ${r.ms} ms`);
  }
  const browser = await chromium.launch();
  console.log(`Mock at ${mock.url}\n`);

  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  context.setDefaultTimeout(20000);
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|ERR_BLOCKED_BY_CLIENT/.test(m.text())) pageErrors.push('console: ' + m.text()); });
  // The editor is another agent's view: replace it with a stub so this test only checks that our
  // links navigate to the right #/edit routes (and never gets stuck on an editor's leave guard).
  await page.route('**/admin/js/views/editor.js', (r) => r.fulfill({
    status: 200,
    contentType: 'text/javascript; charset=utf-8',
    body: "export default async function mount(c, params) { const p = document.createElement('pre'); p.dataset.testid = 'editor-stub'; p.textContent = JSON.stringify(params); c.append(p); }",
  }));
  // belt and braces: never hit the CDN or the real site
  await page.route((u) => /(^|\.)(jsdelivr\.net|github\.io|github\.com)$/.test(u.hostname), (r) => r.abort('blockedbyclient'));

  const aboutOrig = mock.readFile('content/about.md');
  const aboutEnOrig = mock.readFile('content/about.en.md');
  const postsIndexOrig = mock.readFile('content/posts/_index.md');

  try {
    await step('posts: existing post shows title, date, status and 中英分开', async () => {
      const { blocked } = await openAdmin(page, mock, { path: '/admin/#/posts' });
      await waitView(page, 'posts');
      assert.deepEqual(await rowKeys(page), ['content/posts/first-physics-note']);
      const row = '[data-testid="post-row"][data-key="content/posts/first-physics-note"]';
      assert.equal(await page.textContent(`${row} [data-testid="post-title"]`), '广义相对论中的度规张量');
      assert.equal(await page.textContent(`${row} [data-testid="post-date"]`), '2025-12-05');
      assert.equal((await page.textContent(`${row} [data-testid="post-status"]`)).trim(), '已发表');
      assert.equal(await page.textContent(`${row} [data-testid="post-lang"]`), '中英分开');
      assert.equal(await page.$(`${row} [data-testid="post-warning"]`), null);
      assert.equal(await page.getAttribute(`${row} [data-testid="post-edit"]`, 'href'), '#/edit?path=content%2Fposts%2Ffirst-physics-note.md');
      const view = await page.getAttribute(`${row} [data-testid="post-view"]`, 'href');
      assert.equal(view, mock.url + '/posts/first-physics-note/');
      assert.equal(await page.getAttribute(`${row} [data-testid="post-view"]`, 'target'), '_blank');
      const res = await page.request.get(view);
      assert.equal(res.status(), 200, 'view link should point at the built post');
      assert.ok(await page.isVisible('[data-testid="posts-new"]'));
      assert.equal(await page.getAttribute('[data-testid="posts-new"]', 'href'), '#/edit?new=post');
      assert.equal(await page.$('[data-testid="drafts-section"]'), null, 'no drafts yet');
      assert.ok(!blocked.some((u) => u.startsWith(mock.url)));
    });

    await step('posts: seeded posts → 中英共用 / 仅英文 / shadow warning, sorted by date', async () => {
      mock.setFile('content/posts/shared-only.md', '---\ntitle: "共用文章"\ndate: 2026-01-10T09:00:00+08:00\ndraft: false\n---\n\n正文\n');
      mock.setFile('content/posts/en-only.en.md', '---\ntitle: "English Only Note"\ndate: 2026-02-01\ndraft: true\n---\n\nBody\n');
      mock.setFile('content/posts/shadowed.md', '---\ntitle: "被遮住的文章"\ndate: 2025-12-20\ndraft: false\n---\n\n共用正文\n');
      mock.setFile('content/posts/shadowed.en.md', '---\ntitle: "Shadowed (EN draft)"\ndate: 2025-12-20\ndraft: true\n---\n\nEnglish draft\n');
      mock.setFile('content/posts/no-date.md', '---\ntitle: "没有日期的文章"\ndraft: "false"\n---\n\nx\n');
      mock.setFile('static/images/posts/shared-only/a.jpg', Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
      mock.setFile('static/images/posts/shared-only/sub/b.png', Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      await page.reload();
      await page.waitForSelector('body[data-testid="app-ready"]', { state: 'attached' });
      await waitView(page, 'posts');
      assert.deepEqual(await rowKeys(page), [
        'content/posts/en-only', 'content/posts/shared-only', 'content/posts/shadowed',
        'content/posts/first-physics-note', 'content/posts/no-date',
      ]);
      const lang = (k) => page.textContent(`[data-testid="post-row"][data-key="${k}"] [data-testid="post-lang"]`);
      assert.equal(await lang('content/posts/shared-only'), '中英共用');
      assert.equal(await lang('content/posts/en-only'), '仅英文');
      assert.equal(await lang('content/posts/shadowed'), '中英分开');
      const enOnly = await rowText(page, 'content/posts/en-only');
      assert.ok(enOnly.includes('English Only Note') && enOnly.includes('草稿'), enOnly);
      assert.equal(await page.$('[data-testid="post-row"][data-key="content/posts/en-only"] [data-testid="post-view"]'), null, 'draft has no 查看');
      const sh = '[data-testid="post-row"][data-key="content/posts/shadowed"]';
      assert.equal(await page.textContent(`${sh} [data-testid="post-warning"]`), '英文站看不到这篇');
      assert.ok(await page.$eval(`${sh} [data-testid="post-warning"]`, (e) => e.classList.contains('badge-orange')));
      assert.equal(await innerText(page, `${sh} [data-testid="post-status"]`), '中文已发表 英文草稿');
      // shared-only + first post: no warnings
      assert.equal(await page.$$eval('[data-testid="post-warning"]', (els) => els.length), 1);
      const nd = await rowText(page, 'content/posts/no-date');
      assert.ok(nd.includes('没有日期') && nd.includes('已发表'), nd); // draft: "false" is a string → not draft
      await page.screenshot({ path: path.join(SHOTS, 'posts-desktop.png'), fullPage: true });
    });

    await step('posts: filter tabs and title search', async () => {
      assert.match(await page.textContent('[data-testid="posts-filter-all"]'), /全部\s*5/);
      assert.match(await page.textContent('[data-testid="posts-filter-draft"]'), /草稿\s*2/);
      await page.click('[data-testid="posts-filter-draft"]');
      assert.deepEqual(await rowKeys(page), ['content/posts/en-only', 'content/posts/shadowed']);
      await page.click('[data-testid="posts-filter-published"]');
      assert.deepEqual(await rowKeys(page), ['content/posts/shared-only', 'content/posts/shadowed', 'content/posts/first-physics-note', 'content/posts/no-date']);
      await page.click('[data-testid="posts-filter-all"]');
      await page.fill('[data-testid="posts-search"]', '度规');
      await waitRows(page, ['content/posts/first-physics-note']);
      await page.fill('[data-testid="posts-search"]', 'english only');
      await waitRows(page, ['content/posts/en-only']);
      // English variant title of a split post is searchable too
      await page.fill('[data-testid="posts-search"]', 'metric tensor');
      await waitRows(page, ['content/posts/first-physics-note']);
      await page.fill('[data-testid="posts-search"]', 'zzz-nothing');
      await page.waitForSelector('[data-testid="posts-no-match"]');
      assert.equal((await rowKeys(page)).length, 0);
      await page.fill('[data-testid="posts-search"]', '');
      await page.waitForFunction(() => document.querySelectorAll('[data-testid="post-row"]').length === 5);
    });

    await step('posts: 编辑 and 写新文章 navigate to the editor routes', async () => {
      await page.click('[data-testid="post-row"][data-key="content/posts/shadowed"] [data-testid="post-edit"]');
      await page.waitForFunction(() => location.hash.startsWith('#/edit'));
      assert.equal(await page.evaluate(() => location.hash), '#/edit?path=content%2Fposts%2Fshadowed.md');
      await goto(page, '#/posts', 'posts');
      await page.click('[data-testid="posts-new"]');
      await page.waitForFunction(() => location.hash.startsWith('#/edit'));
      assert.equal(await page.evaluate(() => location.hash), '#/edit?new=post');
      await goto(page, '#/posts', 'posts');
    });

    await step('posts: delete (all variants + images folder) → mock files gone, one commit', async () => {
      const before = mock.commits.length;
      // cancel first: nothing happens
      await page.click('[data-testid="post-row"][data-key="content/posts/shared-only"] [data-testid="post-delete"]');
      await page.waitForSelector('[data-testid="delete-ok"]');
      await page.click('[data-testid="confirm-cancel"]');
      await page.waitForSelector('[data-testid="delete-ok"]', { state: 'detached' });
      assert.equal(mock.commits.length, before);

      await page.click('[data-testid="post-row"][data-key="content/posts/shared-only"] [data-testid="post-delete"]');
      await page.waitForSelector('[data-testid="delete-images"]');
      const modalText = await page.textContent('.modal');
      assert.ok(modalText.includes('content/posts/shared-only.md'), modalText);
      assert.ok(modalText.includes('static/images/posts/shared-only/') && modalText.includes('共 2 个文件'), modalText);
      assert.equal(await page.isChecked('[data-testid="delete-images"]'), false, 'images checkbox defaults to off');
      await page.check('[data-testid="delete-images"]');
      await page.click('[data-testid="delete-ok"]');
      await page.waitForSelector('[data-testid="post-row"][data-key="content/posts/shared-only"]', { state: 'detached' });
      assert.equal(mock.commits.length, before + 1);
      const c = mock.commits[mock.commits.length - 1];
      assert.equal(c.message, 'admin: 删除《共用文章》');
      assert.deepEqual(c.changes.map((x) => `${x.status}:${x.path}`).sort(), [
        'removed:content/posts/shared-only.md',
        'removed:static/images/posts/shared-only/a.jpg',
        'removed:static/images/posts/shared-only/sub/b.png',
      ]);
      assert.equal(mock.readFile('content/posts/shared-only.md'), undefined);
      assert.equal(mock.readFile('static/images/posts/shared-only/a.jpg'), undefined);

      // split post: both variants deleted, images checkbox absent (no image folder)
      await page.click('[data-testid="post-row"][data-key="content/posts/shadowed"] [data-testid="post-delete"]');
      await page.waitForSelector('[data-testid="delete-ok"]');
      assert.equal(await page.$('[data-testid="delete-images"]'), null);
      await page.click('[data-testid="delete-ok"]');
      await page.waitForSelector('[data-testid="post-row"][data-key="content/posts/shadowed"]', { state: 'detached' });
      const c2 = mock.commits[mock.commits.length - 1];
      assert.deepEqual(c2.changes.map((x) => x.path).sort(), ['content/posts/shadowed.en.md', 'content/posts/shadowed.md']);
      assert.equal(mock.readFile('content/posts/shadowed.md'), undefined);
      assert.equal(mock.readFile('content/posts/shadowed.en.md'), undefined);
      assert.ok(mock.readFile('content/posts/first-physics-note.md'), 'other posts untouched');
      assert.deepEqual(await rowKeys(page), ['content/posts/en-only', 'content/posts/first-physics-note', 'content/posts/no-date']);
    });

    await step('posts: local drafts section (继续编辑 / 丢弃)', async () => {
      await page.evaluate(async () => {
        const d = await import('/admin/js/drafts.js');
        const now = Date.now();
        await d.saveDraft('new:e2e-lists-1', { title: '本机新草稿', markdown: '你好', fields: {}, images: {}, updatedAt: now - 5 * 60 * 1000 });
        await d.saveDraft(d.draftKeyForPath('content/posts/first-physics-note.md'), {
          title: '广义相对论中的度规张量（改）', markdown: 'x', fields: {}, images: {},
          path: 'content/posts/first-physics-note.md', groupKey: 'content/posts/first-physics-note', updatedAt: now,
        });
        // a page draft belongs to the 页面 view, not here
        await d.saveDraft(d.draftKeyForPath('content/about.md'), { title: '关于我（改）', markdown: 'x', fields: {}, images: {}, path: 'content/about.md', groupKey: 'content/about', updatedAt: now });
      });
      await remount(page, '#/posts', 'posts');
      await page.waitForSelector('[data-testid="drafts-section"]');
      assert.match(await page.textContent('[data-testid="drafts-section"] .card-title'), /本机未发布的草稿 \(2\)/);
      const keys = await page.$$eval('[data-testid="draft-row"]', (els) => els.map((e) => e.dataset.key));
      assert.deepEqual(keys, ['file:content/posts/first-physics-note.md', 'new:e2e-lists-1'], 'newest first, page draft excluded');
      assert.ok(await page.$('[data-testid="post-row"][data-key="content/posts/first-physics-note"] [data-testid="post-local-draft"]'));
      const cont = '[data-testid="draft-row"][data-key="new:e2e-lists-1"] [data-testid="draft-continue"]';
      assert.equal(await page.getAttribute(cont, 'href'), '#/edit?draft=new%3Ae2e-lists-1');
      await page.screenshot({ path: path.join(SHOTS, 'posts-drafts-desktop.png'), fullPage: true });
      await page.click(cont);
      await page.waitForFunction(() => location.hash.startsWith('#/edit'));
      assert.equal(await page.evaluate(() => location.hash), '#/edit?draft=new%3Ae2e-lists-1');
      await goto(page, '#/posts', 'posts');

      await page.click('[data-testid="draft-row"][data-key="new:e2e-lists-1"] [data-testid="draft-discard"]');
      await page.click('[data-testid="confirm-ok"]');
      await page.waitForSelector('[data-testid="draft-row"][data-key="new:e2e-lists-1"]', { state: 'detached' });
      const left = await page.evaluate(async () => (await (await import('/admin/js/drafts.js')).listDrafts()).map((d) => d.key).sort());
      assert.deepEqual(left, ['file:content/about.md', 'file:content/posts/first-physics-note.md']);
      assert.match(await page.textContent('[data-testid="drafts-section"] .card-title'), /\(1\)/);
    });

    await step('posts: mobile layout (390 and 360 wide) has no horizontal scroll', async () => {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.waitForTimeout(150);
      assert.ok(await page.isVisible('[data-testid="posts-new"]'), 'mobile needs its own 写新文章');
      await noHorizontalScroll(page);
      await page.screenshot({ path: path.join(SHOTS, 'posts-mobile.png'), fullPage: true });
      await page.setViewportSize({ width: 360, height: 740 });
      await page.waitForTimeout(150);
      await noHorizontalScroll(page);
      await page.setViewportSize({ width: 1280, height: 800 });
    });

    await step('pages: lists sections sorted by menu weight with zh/en names', async () => {
      await goto(page, '#/pages', 'pages');
      assert.deepEqual(await rowKeys(page, 'pages-list', 'page-row'), [
        'content/about', 'content/research/_index', 'content/posts/_index', 'content/courses/_index',
      ]);
      const names = async (key) => {
        const r = `[data-testid="pages-list"] [data-testid="page-row"][data-key="${key}"]`;
        return [await innerText(page, `${r} [data-testid="page-name-zh"]`), await innerText(page, `${r} [data-testid="page-name-en"]`)];
      };
      assert.deepEqual(await names('content/about'), ['中文 关于', '英文 About']);
      assert.deepEqual(await names('content/research/_index'), ['中文 科研', '英文 Research']);
      assert.deepEqual(await names('content/posts/_index'), ['中文 博客', '英文 Blog']);
      assert.deepEqual(await names('content/courses/_index'), ['中文 课程资料', '英文 Course Materials']);
      const weights = await page.$$eval('[data-testid="pages-list"] [data-testid="page-weight"]', (els) => els.map((e) => e.value));
      assert.deepEqual(weights, ['10', '20', '30', '40']);
      const about = await rowText(page, 'content/about', 'page-row');
      assert.ok(about.includes('/about/') && about.includes('中英分开'), about);
      assert.equal(await page.getAttribute('[data-testid="page-row"][data-key="content/research/_index"] [data-testid="page-edit"]', 'href'),
        '#/edit?path=content%2Fresearch%2F_index.md');
      assert.equal(await page.isDisabled('[data-testid="pages-save-order"]'), true, 'nothing to save yet');
      assert.equal(await innerText(page, '[data-testid="nav-preview-en"]'), '英文站 About Research Blog Course Materials');
      // the page draft saved earlier shows up here
      assert.deepEqual(await page.$$eval('[data-testid="draft-row"]', (els) => els.map((e) => e.dataset.key)), ['file:content/about.md']);
      await page.screenshot({ path: path.join(SHOTS, 'pages-desktop.png'), fullPage: true });
    });

    await step('pages: change menu order → one commit patching every changed variant, comments kept', async () => {
      const before = mock.commits.length;
      // 关于 ↓ (swaps with 科研: 关于 20, 科研 10), then 课程资料 = 5
      await page.click('[data-testid="page-row"][data-key="content/about"] [data-testid="page-down"]');
      assert.deepEqual(await rowKeys(page, 'pages-list', 'page-row'), [
        'content/research/_index', 'content/about', 'content/posts/_index', 'content/courses/_index',
      ]);
      const w = '[data-testid="page-row"][data-key="content/courses/_index"] [data-testid="page-weight"]';
      await page.fill(w, '');
      assert.equal(await page.isDisabled('[data-testid="pages-save-order"]'), true, 'empty weight is invalid');
      await page.fill(w, '5');
      await page.press(w, 'Tab'); // change → re-sort
      assert.deepEqual(await rowKeys(page, 'pages-list', 'page-row'), [
        'content/courses/_index', 'content/research/_index', 'content/about', 'content/posts/_index',
      ]);
      assert.match(await page.textContent('[data-testid="pages-savebar"]'), /已修改 3 个页面/);
      assert.equal(await innerText(page, '[data-testid="nav-preview-zh"]'), '中文站 课程资料 科研 关于 博客');
      await page.screenshot({ path: path.join(SHOTS, 'pages-dirty-desktop.png'), fullPage: true });

      // leaving with unsaved order asks first
      await page.click('[data-testid="nav-posts"]');
      await page.waitForSelector('[data-testid="confirm-cancel"]');
      await page.click('[data-testid="confirm-cancel"]');
      assert.equal(await page.evaluate(() => location.hash), '#/pages');

      await page.click('[data-testid="pages-save-order"]');
      await page.waitForFunction((n) => document.querySelector('[data-testid="pages-save-order"]')?.disabled && !document.querySelector('[data-testid="overlay"]'), before);
      await page.waitForFunction(() => /没有修改/.test(document.querySelector('[data-testid="pages-savebar"]')?.textContent || ''));
      assert.equal(mock.commits.length, before + 1, 'exactly one commit');
      const c = mock.commits[mock.commits.length - 1];
      assert.equal(c.message, 'admin: 调整菜单顺序');
      assert.deepEqual(c.changes.map((x) => `${x.status}:${x.path}`).sort(), [
        'modified:content/about.en.md', 'modified:content/about.md',
        'modified:content/courses/_index.en.md', 'modified:content/courses/_index.md',
        'modified:content/research/_index.en.md', 'modified:content/research/_index.md',
      ]);
      const about = mock.readFile('content/about.md');
      assert.ok(about.includes('weight: 20    # 菜单顺序，数字越小越靠左'), about);
      assert.ok(about.includes('linkTitle: "关于"   # 菜单里显示的名字'), about);
      assert.ok(about.includes('layout: "about"   # 告诉 Hugo 这是一个特殊页面'), about);
      assert.ok(about.includes('hidemeta: true    # 隐藏发布日期、字数统计等博客才有的信息'), about);
      // (Repo.commit normalizes text files to end with exactly one newline; about.md had none)
      const eol = (t) => t.replace(/\n*$/, '\n');
      assert.equal(about, eol(aboutOrig.replace('weight: 10    #', 'weight: 20    #')), 'only the weight changed in about.md');
      assert.equal(mock.readFile('content/about.en.md'), eol(aboutEnOrig.replace('weight: 10', 'weight: 20')));
      assert.equal(bodyOf(about), eol(bodyOf(aboutOrig)), 'body untouched');
      assert.match(mock.readFile('content/research/_index.md'), /menu:\n  main:\n    weight: 10\n/);
      assert.match(mock.readFile('content/research/_index.en.md'), /menu:\n  main:\n    weight: 10\n/);
      const courses = mock.readFile('content/courses/_index.md');
      assert.match(courses, /menu:\n  main:\n    weight: 5\n/);
      assert.ok(courses.includes('hidemeta: true  # 列表页隐藏日期等信息'));
      assert.match(mock.readFile('content/courses/_index.en.md'), /weight: 5\n/);
      assert.equal(mock.readFile('content/posts/_index.md'), postsIndexOrig, 'unchanged page not rewritten');
      const weights = await page.$$eval('[data-testid="pages-list"] [data-testid="page-weight"]', (els) => els.map((e) => e.value));
      assert.deepEqual(weights, ['5', '10', '20', '30']);
    });

    await step('pages: conflict while saving order → reload keeps the typed order, external edit kept', async () => {
      const before = mock.commits.length;
      const w = '[data-testid="page-row"][data-key="content/about"] [data-testid="page-weight"]';
      await page.fill(w, '25');
      await page.press(w, 'Tab');
      // someone edits about.md on GitHub meanwhile
      mock.setFile('content/about.md', mock.readFile('content/about.md').replace('summary: "about"', 'summary: "about me"'));
      await page.click('[data-testid="pages-save-order"]');
      await page.waitForSelector('[data-testid="conflict-reload"]');
      assert.match(await page.textContent('.modal'), /content\/about\.md/);
      await page.click('[data-testid="conflict-reload"]');
      await page.waitForSelector('[data-testid="conflict-reload"]', { state: 'detached' });
      assert.equal(mock.commits.length, before, 'nothing committed on conflict');
      await page.waitForFunction(() => /已修改 1 个页面/.test(document.querySelector('[data-testid="pages-savebar"]')?.textContent || ''));
      assert.equal(await page.inputValue(w), '25', 'typed order survives the reload');
      await page.click('[data-testid="pages-save-order"]');
      await page.waitForFunction(() => /没有修改/.test(document.querySelector('[data-testid="pages-savebar"]')?.textContent || ''));
      assert.equal(mock.commits.length, before + 1);
      assert.deepEqual(mock.commits.at(-1).changes.map((x) => x.path).sort(), ['content/about.en.md', 'content/about.md']);
      const about = mock.readFile('content/about.md');
      assert.ok(about.includes('summary: "about me"'), 'external edit kept');
      assert.ok(about.includes('weight: 25    # 菜单顺序，数字越小越靠左'), about);
      assert.match(mock.readFile('content/about.en.md'), /weight: 25\n/);
    });

    await step('pages: 新建栏目 validates and creates _index.md + _index.en.md, then opens the editor', async () => {
      const before = mock.commits.length;
      await page.click('[data-testid="pages-new-section"]');
      await page.waitForSelector('[data-testid="new-section-name-zh"]');
      assert.equal(await page.inputValue('[data-testid="new-section-weight"]'), '40', 'default = max + 10');
      // validation: empty
      await page.click('[data-testid="new-section-ok"]');
      await page.waitForSelector('.modal .error:not([hidden])');
      assert.match(await page.textContent('.modal'), /请填写中文名称/);
      await page.fill('[data-testid="new-section-name-zh"]', '项目');
      await page.fill('[data-testid="new-section-name-en"]', 'My Projects');
      assert.equal(await page.inputValue('[data-testid="new-section-slug"]'), 'my-projects', 'slug suggested from the English name');
      // taken / reserved slugs are refused
      for (const [slug, re] of [['about', /已经有同名的页面/], ['research', /已经被一个栏目用了/], ['images', /重名|保留/], ['en', /保留/], ['Bad Slug', /小写英文字母/]]) {
        await page.fill('[data-testid="new-section-slug"]', slug);
        await page.click('[data-testid="new-section-ok"]');
        await page.waitForFunction((r) => new RegExp(r).test(document.querySelector('.modal')?.textContent || ''), re.source);
      }
      assert.equal(mock.commits.length, before, 'invalid input → no commit');
      await page.fill('[data-testid="new-section-slug"]', 'projects');
      assert.match(await page.textContent('[data-testid="new-section-url"]'), /\/projects\/.*\/en\/projects\//);
      await page.fill('[data-testid="new-section-weight"]', '35');
      await page.screenshot({ path: path.join(SHOTS, 'pages-new-section-desktop.png') });
      await page.click('[data-testid="new-section-ok"]');
      await page.waitForFunction(() => location.hash.startsWith('#/edit'));
      assert.equal(await page.evaluate(() => location.hash), '#/edit?path=content%2Fprojects%2F_index.md');
      assert.equal(mock.commits.length, before + 1);
      const c = mock.commits[mock.commits.length - 1];
      assert.equal(c.message, 'admin: 新建栏目《项目》');
      assert.deepEqual(c.changes.map((x) => `${x.status}:${x.path}`).sort(), ['added:content/projects/_index.en.md', 'added:content/projects/_index.md']);
      assert.equal(mock.readFile('content/projects/_index.md'), '---\ntitle: "项目"\nmenu:\n  main:\n    weight: 35\n---\n\n这里写栏目介绍…\n');
      assert.equal(mock.readFile('content/projects/_index.en.md'), '---\ntitle: "My Projects"\nmenu:\n  main:\n    weight: 35\n---\n\nWrite the section introduction here…\n');
    });

    await step('pages: section without English name → only shared _index.md', async () => {
      await goto(page, '#/pages', 'pages');
      assert.deepEqual(await rowKeys(page, 'pages-list', 'page-row'), [
        'content/courses/_index', 'content/research/_index', 'content/about', 'content/posts/_index', 'content/projects/_index',
      ]);
      await page.click('[data-testid="pages-new-section"]');
      await page.fill('[data-testid="new-section-name-zh"]', '教学');
      assert.equal(await page.inputValue('[data-testid="new-section-slug"]'), '', 'Chinese-only name → no ASCII suggestion');
      await page.fill('[data-testid="new-section-slug"]', 'teaching');
      assert.equal(await page.inputValue('[data-testid="new-section-weight"]'), '40');
      await page.click('[data-testid="new-section-ok"]');
      await page.waitForFunction(() => location.hash === '#/edit?path=content%2Fteaching%2F_index.md');
      assert.equal(mock.readFile('content/teaching/_index.md'), '---\ntitle: "教学"\nmenu:\n  main:\n    weight: 40\n---\n\n这里写栏目介绍…\n');
      assert.equal(mock.readFile('content/teaching/_index.en.md'), undefined);
      await goto(page, '#/pages', 'pages');
      const t = await rowText(page, 'content/teaching/_index', 'page-row');
      assert.ok(t.includes('中英共用') && t.includes('英文 教学'), t);
    });

    await step('pages: mobile layout has no horizontal scroll', async () => {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.waitForTimeout(150);
      await noHorizontalScroll(page);
      await page.screenshot({ path: path.join(SHOTS, 'pages-mobile.png'), fullPage: true });
      await page.click('[data-testid="pages-new-section"]');
      await page.waitForSelector('[data-testid="new-section-name-zh"]');
      await page.waitForTimeout(300);
      await page.screenshot({ path: path.join(SHOTS, 'pages-new-section-mobile.png') });
      await page.click('[data-testid="new-section-cancel"]');
      await page.setViewportSize({ width: 360, height: 740 });
      await page.waitForTimeout(150);
      await noHorizontalScroll(page);
      await page.setViewportSize({ width: 1280, height: 800 });
    });

    await step('dark mode screenshots', async () => {
      await page.emulateMedia({ colorScheme: 'dark' });
      await goto(page, '#/posts', 'posts');
      await page.screenshot({ path: path.join(SHOTS, 'posts-dark-desktop.png'), fullPage: true });
      await goto(page, '#/pages', 'pages');
      await page.screenshot({ path: path.join(SHOTS, 'pages-dark-desktop.png'), fullPage: true });
      await page.emulateMedia({ colorScheme: 'light' });
    });

    await step('build: new sections appear in BOTH languages’ nav menus, in the new order', async () => {
      const exp = path.join(OUT, 'export');
      fs.rmSync(exp, { recursive: true, force: true });
      mock.exportTo(exp);
      const site2 = path.join(OUT, 'site-after');
      await buildSite({ repoDir: exp, outDir: site2, baseURL: mock.url + '/' });
      const zh = navItems(fs.readFileSync(path.join(site2, 'index.html'), 'utf8'));
      const en = navItems(fs.readFileSync(path.join(site2, 'en', 'index.html'), 'utf8'));
      const rel = (items) => items.map((x) => `${x.text} ${x.href.replace(mock.url, '')}`);
      assert.deepEqual(rel(zh), ['课程资料 /courses/', '科研 /research/', '关于 /about/', '博客 /posts/', '项目 /projects/', '教学 /teaching/']);
      assert.deepEqual(rel(en), ['Course Materials /en/courses/', 'Research /en/research/', 'About /en/about/', 'Blog /en/posts/', 'My Projects /en/projects/', '教学 /en/teaching/']);
      assert.ok(fs.existsSync(path.join(site2, 'projects', 'index.html')));
      assert.ok(fs.existsSync(path.join(site2, 'en', 'projects', 'index.html')));
      // deleted posts are gone from the built site
      assert.ok(!fs.existsSync(path.join(site2, 'posts', 'shared-only', 'index.html')));
    });

    await step('no page errors', async () => {
      assert.deepEqual(pageErrors, []);
    });
  } finally {
    await browser.close();
    await mock.close();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed. Screenshots: ${SHOTS}`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
