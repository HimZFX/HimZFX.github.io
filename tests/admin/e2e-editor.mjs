// tests/admin/e2e-editor.mjs — Playwright end-to-end test for the post/page editor
// (views/editor.js + preview.js): new post with math + images → 发表, reopen → 更新,
// English variant, autosave + restore, conflicts, lossless update of an existing post,
// page fields with comment-preserving front matter, phone preview (KaTeX), Hugo build checks.
//
// Run from the repo root:   node tests/admin/e2e-editor.mjs
// Env:
//   EDITOR_E2E_DIR  where the Hugo builds + screenshots go (default: $ADMIN_TEST_TMP/admin-e2e-editor
//                   or <os tmp>/admin-e2e-editor)
//   ONLY=<substr>   run only tests whose name contains this (later tests depend on earlier ones)
//   HUGO_BIN        Hugo binary (see mock-github.mjs)
//
// Every request that leaves the mock origin (cdn.jsdelivr.net, *.github.io, api.github.com …) is aborted.

import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startMock, buildSite, openAdmin, REPO_ROOT } from './mock-github.mjs';

const { chromium } = createRequire(import.meta.url)('playwright');

const OUT = path.resolve(process.env.EDITOR_E2E_DIR || path.join(process.env.ADMIN_TEST_TMP || os.tmpdir(), 'admin-e2e-editor'));
const SITE_DIR = path.join(OUT, 'site');
const SHOTS = path.join(OUT, 'screenshots');
const ADMIN_DIR = path.join(REPO_ROOT, 'static', 'admin');
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
    await Promise.race([fn(), new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('test timed out after 180 s')), 180000); })]);
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

/** Navigate inside the admin and wait for the editor to be mounted. */
async function gotoEdit(page, hash) {
  const same = await page.evaluate((h) => {
    if (location.hash === h) return true;
    delete document.body.dataset.viewReady;
    location.hash = h;
    return false;
  }, hash);
  if (same) {
    // already there: reload so the editor re-reads the file
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('body[data-testid="app-ready"]', { state: 'attached' });
  }
  await waitEditor(page);
}

async function waitEditor(page) {
  try {
    await page.waitForSelector('body[data-view-ready="edit"]', { state: 'attached', timeout: 30000 });
  } catch (e) {
    const modalText = await page.evaluate(() => [...document.querySelectorAll('.modal')].map((m) => m.textContent).join(' | ')).catch(() => '');
    throw new Error(`${e.message.split('\n')[0]} (hash ${await page.evaluate(() => location.hash).catch(() => '?')}; open dialogs: ${modalText || 'none'})`);
  }
  await page.waitForSelector('[data-testid="editor-body"] .vditor-wysiwyg', { timeout: 30000 });
}

const vditor = {
  get: (page) => page.evaluate(() => document.querySelector('[data-testid="editor-body"]')._vditor.getValue()),
  insert: (page, md) => page.evaluate((m) => {
    const v = document.querySelector('[data-testid="editor-body"]')._vditor;
    v.focus();
    // caret at the end of the document
    const el = document.querySelector('[data-testid="editor-body"] .vditor-wysiwyg .vditor-reset');
    const r = document.createRange();
    r.selectNodeContents(el);
    r.collapse(false);
    const s = getSelection();
    s.removeAllRanges();
    s.addRange(r);
    v.insertValue(m);
  }, md),
};

/** Put the caret at the end of the WYSIWYG area and type with the real keyboard. */
async function typeAtEnd(page, text) {
  await page.evaluate(() => {
    const el = document.querySelector('[data-testid="editor-body"] .vditor-wysiwyg .vditor-reset');
    el.focus();
    // the last paragraph (typing into a code block / math block lands in Vditor's preview part)
    const ps = el.querySelectorAll(':scope > p');
    const last = ps[ps.length - 1] || el.lastElementChild || el;
    const r = document.createRange();
    r.selectNodeContents(last);
    r.collapse(false);
    const s = getSelection();
    s.removeAllRanges();
    s.addRange(r);
  });
  await page.keyboard.press('End');
  await page.keyboard.type(text, { delay: 5 });
}

/** Click a publish-type button and wait for the resulting API commit. */
async function clickAndCommit(page, mock, selector, { expectCommit = true } = {}) {
  const n = mock.commits.length;
  await page.click(selector);
  if (expectCommit) {
    await until(() => mock.commits.length > n, { msg: `a commit after clicking ${selector}` });
  }
  // the blocking overlay goes away when publish() finishes
  await page.waitForSelector('[data-testid="overlay"]', { state: 'detached', timeout: 30000 });
  return mock.commits[mock.commits.length - 1];
}

/** A real PNG/JPEG made by the browser's canvas (so compressImage has something to chew on). */
async function canvasImage(page, { w = 900, h = 600, type = 'image/png', label = 'A' } = {}) {
  const b64 = await page.evaluate(({ w, h, type, label }) => {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const g = c.getContext('2d');
    const grad = g.createLinearGradient(0, 0, w, h);
    grad.addColorStop(0, '#07c160');
    grad.addColorStop(1, '#3370ff');
    g.fillStyle = grad;
    g.fillRect(0, 0, w, h);
    g.fillStyle = '#fff';
    g.font = `${Math.round(h / 3)}px sans-serif`;
    g.fillText(label, w / 3, (h * 2) / 3);
    return c.toDataURL(type, 0.9).split(',')[1];
  }, { w, h, type, label });
  return Buffer.from(b64, 'base64');
}

/** Split a markdown file into { fm (raw text), body }. */
function splitMd(text) {
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
  assert.ok(m, 'file has YAML front matter');
  return { fm: m[1], body: m[2] };
}

/** Collect all TeX snippets ($…$, $$…$$) in a markdown body, whitespace-normalised. */
function texOf(body) {
  const out = [];
  const block = /\$\$([\s\S]+?)\$\$/g;
  let m;
  let rest = body;
  while ((m = block.exec(body))) out.push('$$' + m[1].replace(/\s+/g, '') + '$$');
  rest = body.replace(block, '');
  const inline = /\$([^$\n]+?)\$/g;
  while ((m = inline.exec(rest))) out.push('$' + m[1].replace(/\s+/g, '') + '$');
  return out.sort();
}

const noHScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

// ---------------------------------------------------------------------------

async function main() {
  const mock = await startMock({ siteDir: SITE_DIR, adminDir: ADMIN_DIR, runDelayMs: 800 });
  console.log(`Mock at ${mock.url}`);
  console.log(`Building site into ${SITE_DIR} …`);
  // baseURL = the mock, so the preview finds the site's stylesheet on the same origin
  const built = await buildSite({ repoDir: REPO_ROOT, outDir: SITE_DIR, baseURL: mock.url + '/' });
  console.log(`  built in ${built.ms} ms\n`);

  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  context.setDefaultTimeout(20000);
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  page.on('dialog', (d) => d.accept()); // beforeunload on reload
  const cspErrors = [];
  page.on('console', (m) => {
    if (/Content Security Policy|CSP-VIOLATION/.test(m.text())) cspErrors.push(m.text());
    if (process.env.DEBUG) console.log(`      [console.${m.type()}] ${m.text().slice(0, 300)}`);
  });
  await context.addInitScript(() => document.addEventListener('securitypolicyviolation', (e) => console.warn('CSP-VIOLATION', e.violatedDirective, e.sourceFile, e.lineNumber, String(e.sample || '').slice(0, 80))));

  const SLUG = 'hello-math-world';
  const POST = `content/posts/${SLUG}.md`;
  const POST_EN = `content/posts/${SLUG}.en.md`;
  const IMGDIR = `static/images/posts/${SLUG}`;
  let blocked = [];

  try {
    await test('static: editor/preview never assign innerHTML in the live document', async () => {
      const ed = fs.readFileSync(path.join(ADMIN_DIR, 'js/views/editor.js'), 'utf8').replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
      assert.equal((ed.match(/\.(innerHTML|outerHTML|insertAdjacentHTML|srcdoc)\b|document\.write/g) || []).length, 0);
      const pv = fs.readFileSync(path.join(ADMIN_DIR, 'js/preview.js'), 'utf8').replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
      // exactly: root.innerHTML = html (inert document), root.innerHTML read, iframe.srcdoc =
      assert.equal((pv.match(/\.innerHTML\s*=/g) || []).length, 1);
      assert.equal((pv.match(/\.srcdoc\s*=/g) || []).length, 1);
      assert.match(pv, /document\.implementation\.createHTMLDocument/);
      for (const f of ['js/views/editor.js', 'js/preview.js', 'css/views/editor.css']) {
        const s = fs.readFileSync(path.join(ADMIN_DIR, f), 'utf8');
        assert.ok(!/[\u2028\u2029\uFEFF]/.test(s), `${f} contains U+2028/2029/BOM`);
      }
    });

    await test('new post: empty editor, slug suggestion, unsaved-guard', async () => {
      ({ blocked } = await openAdmin(page, mock, { path: '/admin/#/edit?new=post' }));
      await waitEditor(page);
      assert.equal(await page.textContent('.topbar-title'), '写新文章');
      assert.match(await page.inputValue('[data-testid="editor-slug"]'), /^post-\d{8}$/);
      await page.fill('[data-testid="editor-title"]', 'Hello Math World');
      assert.equal(await page.inputValue('[data-testid="editor-slug"]'), SLUG);
      assert.match(await page.textContent('.ed-settings'), /\/posts\/hello-math-world\//);
      // an existing slug is rejected
      await page.fill('[data-testid="editor-slug"]', 'first-physics-note');
      assert.match(await page.textContent('[data-testid="editor-slug-error"]'), /同名/);
      await page.fill('[data-testid="editor-slug"]', SLUG);
      // explain line
      assert.match(await page.textContent('[data-testid="editor-explain"]'), /中文站显示：共用版本.*英文站显示：共用版本/);
      await page.screenshot({ path: path.join(SHOTS, 'new-post-empty-desktop.png') });
    });

    let imgName1;
    let imgName2;
    await test('new post: content with heading/bold/list/math + uploaded and pasted images → 发表', async () => {
      await vditor.insert(page, '## 第一节\n\n这是 **加粗** 的文字。\n\n- 列表一\n- 列表二\n\n行内公式 $E=mc^2$ 和块公式：\n\n$$\n\\int_0^1 x^2\\,dx = \\frac{1}{3}\n$$\n\n');
      await typeAtEnd(page, '键盘输入的文字');
      // upload through Vditor's toolbar upload button (→ upload.handler)
      const png = await canvasImage(page, { label: 'UP' });
      await page.setInputFiles('[data-testid="editor-body"] .vditor-toolbar [data-type="upload"] input[type="file"]',
        { name: '测试 图片.png', mimeType: 'image/png', buffer: png });
      await until(async () => /!\[[^\]]*\]\(blob:/.test(await vditor.get(page)), { msg: 'uploaded image in editor' });
      // paste an image (clipboard event with a File)
      await page.evaluate(async () => {
        const c = document.createElement('canvas');
        c.width = 640; c.height = 400;
        const g = c.getContext('2d');
        g.fillStyle = '#f54a45'; g.fillRect(0, 0, 640, 400);
        const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.9));
        const file = new File([blob], 'image.jpg', { type: 'image/jpeg' });
        const dt = new DataTransfer();
        dt.items.add(file);
        const el = document.querySelector('[data-testid="editor-body"] .vditor-wysiwyg .vditor-reset');
        el.focus();
        el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
      });
      await until(async () => ((await vditor.get(page)).match(/\]\(blob:/g) || []).length >= 2, { msg: 'pasted image in editor' });
      // tags
      await page.fill('[data-testid="editor-tags"]', '物理');
      await page.press('[data-testid="editor-tags"]', 'Enter');
      await page.fill('[data-testid="editor-tags"]', '笔记');
      await page.press('[data-testid="editor-tags"]', 'Enter');
      await page.fill('[data-testid="editor-description"]', '一篇测试文章');
      await sleep(300);
      await page.screenshot({ path: path.join(SHOTS, 'new-post-filled-desktop.png') });

      const commit = await clickAndCommit(page, mock, '[data-testid="editor-publish"]');
      assert.match(commit.message, /^admin: 发表《Hello Math World》/);
      const text = mock.readFile(POST);
      assert.ok(text, `${POST} exists`);
      const { fm, body } = splitMd(text);
      assert.match(fm, /^title: "Hello Math World"$/m);
      assert.match(fm, /^date: "\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}"$/m);
      assert.match(fm, /^draft: false$/m);
      assert.match(fm, /^tags: \["物理", "笔记"\]$/m);
      assert.match(fm, /^description: "一篇测试文章"$/m);
      assert.ok(!/^math:/m.test(fm), 'math equals the site default → not written');
      assert.match(body, /^## 第一节$/m);
      assert.match(body, /\*\*加粗\*\*/);
      assert.match(body, /^[*-] 列表一$/m);
      assert.match(body, /\$E=mc\^2\$/);
      assert.match(body, /\$\$\n\\int_0\^1 x\^2\\,dx = \\frac\{1\}\{3\}\n\$\$/);
      assert.match(body, /键盘输入的文字/);
      assert.ok(!/blob:|admin-pending:/.test(body), 'no blob/pending URLs in the file');
      const imgs = [...body.matchAll(/!\[[^\]]*\]\((\/images\/posts\/hello-math-world\/([^)\s]+))\)/g)];
      assert.equal(imgs.length, 2, 'two images referenced with final site paths');
      imgName1 = imgs[0][2];
      imgName2 = imgs[1][2];
      assert.match(imgName1, /^\d{8}-\d{6}-测试-图片\.(png|jpg)$/);
      for (const [, , name] of imgs) {
        const bytes = mock.readBytes(`${IMGDIR}/${name}`);
        assert.ok(bytes && bytes.length > 100, `image ${name} committed`);
        const isPng = bytes[0] === 0x89 && bytes[1] === 0x50;
        const isJpg = bytes[0] === 0xff && bytes[1] === 0xd8;
        assert.ok(isPng || isJpg, 'image bytes look like PNG/JPEG');
      }
      const paths = commit.changes.map((c) => c.path).sort();
      assert.deepEqual(paths, [POST, `${IMGDIR}/${imgName1}`, `${IMGDIR}/${imgName2}`].sort(), 'one atomic commit with post + images');
      // the editor re-opens the saved file
      await until(async () => (await page.evaluate(() => location.hash)).includes(encodeURIComponent(POST)), { msg: 'navigate to new path' });
      await waitEditor(page);
      assert.equal(await page.textContent('[data-testid="editor-publish"]'), '更新');
      assert.equal((await page.textContent('[data-testid="editor-status"]')).trim(), '已发表');
      // freshly uploaded images still display (blob URLs) before the site is deployed
      assert.equal(await page.locator('[data-testid="editor-body"] .vditor-wysiwyg img[src^="blob:"]').count(), 2);
    });

    await test('build: new shared post exists on both /posts/<slug>/ and /en/posts/<slug>/', async () => {
      const repoDir = mock.exportTo(path.join(OUT, 'export1'));
      const out = path.join(OUT, 'build1');
      await buildSite({ repoDir, outDir: out });
      const zh = fs.readFileSync(path.join(out, 'posts', SLUG, 'index.html'), 'utf8');
      const en = fs.readFileSync(path.join(out, 'en', 'posts', SLUG, 'index.html'), 'utf8');
      assert.match(zh, /Hello Math World/);
      assert.match(en, /Hello Math World/);
      assert.ok(fs.existsSync(path.join(out, 'images', 'posts', SLUG, imgName1)), 'image deployed');
    });

    await test('reopen → edit → 更新 (baseSha conflict-free, images not re-uploaded)', async () => {
      await gotoEdit(page, '#/edit?path=' + encodeURIComponent(POST));
      const before = mock.shaOf(POST);
      await typeAtEnd(page, '（第二次修改）');
      await until(async () => (await page.textContent('[data-testid="editor-tab-shared"]')) !== null && page.locator('[data-testid="editor-tab-shared"] .ed-dot').count(), { msg: 'dirty dot' });
      const commit = await clickAndCommit(page, mock, '[data-testid="editor-publish"]');
      assert.match(commit.message, /^admin: 更新《Hello Math World》/);
      assert.deepEqual(commit.changes.map((c) => c.path), [POST]);
      assert.notEqual(mock.shaOf(POST), before);
      const { body } = splitMd(mock.readFile(POST));
      assert.match(body, /（第二次修改）/);
      assert.match(body, new RegExp(`/images/posts/${SLUG}/${imgName1.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
      assert.equal(await page.locator('[data-testid="conflict-reload"]').count(), 0);
      assert.equal(await page.locator('[data-testid="editor-tab-shared"] .ed-dot').count(), 0, 'clean after update');
      // second update right away works with the new baseSha
      await typeAtEnd(page, '再改一次');
      const c2 = await clickAndCommit(page, mock, '[data-testid="editor-publish"]');
      assert.match(c2.message, /更新/);
      assert.match(mock.readFile(POST), /再改一次/);
    });

    await test('Ctrl+S on a published post = 更新', async () => {
      await typeAtEnd(page, 'CTRLS');
      const n = mock.commits.length;
      await page.keyboard.press('Control+s');
      await until(() => mock.commits.length > n, { msg: 'commit after Ctrl+S' });
      await page.waitForSelector('[data-testid="overlay"]', { state: 'detached' });
      assert.match(mock.commits.at(-1).message, /更新/);
      assert.match(mock.readFile(POST), /CTRLS/);
    });

    await test('phone preview renders KaTeX, light/dark toggle', async () => {
      await page.click('[data-testid="editor-preview"]');
      const frameEl = await page.waitForSelector('[data-testid="preview-iframe"][data-state="ready"]', { timeout: 30000 });
      assert.equal(await frameEl.getAttribute('sandbox'), 'allow-same-origin');
      const frame = await frameEl.contentFrame();
      await frame.waitForSelector('.katex', { state: 'attached' });
      assert.ok(await frame.locator('.katex-display').count() >= 1, 'block math rendered');
      assert.ok(await frame.locator('.post-content .katex').count() >= 2, 'inline + block math rendered');
      assert.equal(await frame.textContent('.post-title'), 'Hello Math World');
      assert.equal(await frame.locator('.post-content img').count(), 2, 'both images in the preview');
      // the site stylesheet and the vendored KaTeX css are used
      const links = await frame.evaluate(() => [...document.querySelectorAll('link[rel=stylesheet]')].map((l) => l.href));
      assert.ok(links.some((h) => /\/assets\/css\/stylesheet\.[^/]+\.css$/.test(h)), 'site stylesheet linked: ' + links.join(', '));
      assert.ok(links.some((h) => h.includes('/admin/vendor/vditor/dist/js/katex/katex.min.css')));
      assert.equal(await frame.evaluate(() => document.documentElement.dataset.theme), 'light');
      await page.screenshot({ path: path.join(SHOTS, 'preview-light-desktop.png') });
      await page.click('[data-testid="preview-dark"]');
      await page.waitForFunction(() => document.querySelector('[data-testid="preview-iframe"]').dataset.theme === 'dark' && document.querySelector('[data-testid="preview-iframe"]').dataset.state === 'ready');
      const f2 = await (await page.$('[data-testid="preview-iframe"]')).contentFrame();
      assert.equal(await f2.evaluate(() => document.documentElement.dataset.theme), 'dark');
      await page.screenshot({ path: path.join(SHOTS, 'preview-dark-desktop.png') });
      // scripts can never run in the preview
      assert.equal(await f2.evaluate(() => document.querySelectorAll('script').length), 0);
      await page.click('[data-testid="modal-close"]');
    });

    await test('add 英文版 tab → 发表 → <slug>.en.md with copied front matter', async () => {
      await page.click('[data-testid="editor-add-en"]');
      await page.waitForSelector('[data-testid="editor-tab-en"].active');
      assert.equal(await page.inputValue('[data-testid="editor-title"]'), 'Hello Math World');
      assert.match(await page.textContent('[data-testid="editor-explain"]'), /英文站显示：英文专属（未发表）/);
      await page.fill('[data-testid="editor-title"]', 'Hello Math World (EN)');
      await vditor.insert(page, '\n\nEnglish paragraph.\n');
      // shadow warning: saving the English variant as a draft while the shared one is published
      await page.click('[data-testid="editor-save-draft"]');
      await page.waitForSelector('[data-testid="confirm-ok"]');
      assert.match(await page.textContent('.modal'), /英文站上将看不到这一页/);
      await page.click('[data-testid="confirm-cancel"]');
      await page.waitForSelector('.modal', { state: 'detached' });

      const commit = await clickAndCommit(page, mock, '[data-testid="editor-publish"]');
      assert.match(commit.message, /^admin: 发表《Hello Math World \(EN\)》（英文专属）/);
      const en = mock.readFile(POST_EN);
      assert.ok(en, 'en file exists');
      const zh = splitMd(mock.readFile(POST));
      const { fm, body } = splitMd(en);
      assert.match(fm, /^title: "Hello Math World \(EN\)"$/m);
      for (const key of ['date', 'draft', 'tags', 'description']) {
        const line = new RegExp(`^${key}: .*$`, 'm');
        assert.equal(fm.match(line)[0], zh.fm.match(line)[0], `${key} copied from the shared version`);
      }
      assert.match(body, /English paragraph\./);
      assert.match(body, /\$E=mc\^2\$/);
      assert.equal((await page.textContent('[data-testid="editor-status"]')).trim(), '已发表');
      assert.match(await page.textContent('[data-testid="editor-explain"]'), /中文站显示：共用版本 · 英文站显示：英文专属$/);
    });

    await test('build: /en/ shows the English version, / keeps the shared one', async () => {
      const repoDir = mock.exportTo(path.join(OUT, 'export2'));
      const out = path.join(OUT, 'build2');
      await buildSite({ repoDir, outDir: out });
      const zh = fs.readFileSync(path.join(out, 'posts', SLUG, 'index.html'), 'utf8');
      const en = fs.readFileSync(path.join(out, 'en', 'posts', SLUG, 'index.html'), 'utf8');
      assert.match(en, /Hello Math World \(EN\)/);
      assert.match(en, /English paragraph/);
      assert.ok(!/Hello Math World \(EN\)/.test(zh));
      assert.ok(!/English paragraph/.test(zh));
    });

    await test('more menu: view-on-site links per language', async () => {
      await page.click('[data-testid="editor-more"]');
      await page.waitForSelector('[data-testid="editor-more-menu"]');
      assert.equal(await page.getAttribute('[data-testid="editor-view-zh"]', 'href'), `${mock.url}/posts/${SLUG}/`);
      assert.equal(await page.getAttribute('[data-testid="editor-view-en"]', 'href'), `${mock.url}/en/posts/${SLUG}/`);
      assert.equal(await page.getAttribute('[data-testid="editor-view-en"]', 'target'), '_blank');
      await page.keyboard.press('Escape');
      await page.waitForSelector('[data-testid="editor-more-menu"]', { state: 'detached' });
    });

    await test('autosave → reload page → restore banner → 恢复 brings the content back', async () => {
      await page.click('[data-testid="editor-tab-shared"]');
      await page.waitForSelector('[data-testid="editor-tab-shared"].active');
      await typeAtEnd(page, 'AUTOSAVE-MARK');
      await page.fill('[data-testid="editor-description"]', '自动保存的摘要');
      await page.waitForFunction(() => /已自动保存到本机 · \d{2}:\d{2}/.test(document.querySelector('[data-testid="editor-autosave-status"]').textContent), null, { timeout: 10000 });
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForSelector('body[data-testid="app-ready"]', { state: 'attached' });
      await waitEditor(page);
      try {
        await page.waitForSelector('[data-testid="editor-draft-banner"]', { timeout: 8000 });
      } catch (e) {
        console.log('      drafts:', JSON.stringify(await page.evaluate(async () => (await import('/admin/js/drafts.js')).listDrafts())));
        throw e;
      }
      assert.match(await page.textContent('[data-testid="editor-draft-banner"]'), /发现本机未发布的修改/);
      assert.ok(!(await vditor.get(page)).includes('AUTOSAVE-MARK'), 'file content shown until restore');
      await page.click('[data-testid="editor-restore"]');
      await page.waitForSelector('[data-testid="editor-draft-banner"]', { state: 'detached' });
      assert.ok((await vditor.get(page)).includes('AUTOSAVE-MARK'), 'draft restored into the editor');
      assert.equal(await page.inputValue('[data-testid="editor-description"]'), '自动保存的摘要');
      // restored images still work (placeholders → blob URLs → site paths)
      await clickAndCommit(page, mock, '[data-testid="editor-publish"]');
      const { fm, body } = splitMd(mock.readFile(POST));
      assert.match(body, /AUTOSAVE-MARK/);
      assert.match(fm, /^description: "自动保存的摘要"$/m);
      assert.ok(!/blob:|admin-pending:/.test(body));
      assert.equal((body.match(/\/images\/posts\/hello-math-world\//g) || []).length, 2);
      // the local draft is gone after publishing
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForSelector('body[data-testid="app-ready"]', { state: 'attached' });
      await waitEditor(page);
      await sleep(500);
      assert.equal(await page.locator('[data-testid="editor-draft-banner"]').count(), 0);
    });

    await test('conflict: external change → 更新 → conflict modal → reload → keep mine → 更新', async () => {
      await typeAtEnd(page, 'MY-EDIT');
      const external = mock.readFile(POST).replace('AUTOSAVE-MARK', 'EXTERNAL-MARK');
      assert.notEqual(external, mock.readFile(POST));
      mock.setFile(POST, external);
      const n = mock.commits.length;
      await page.click('[data-testid="editor-publish"]');
      await page.waitForSelector('[data-testid="conflict-reload"]');
      assert.match(await page.textContent('.modal'), new RegExp(POST.replace(/[.]/g, '\\.')));
      assert.equal(mock.commits.length, n, 'nothing committed on conflict');
      await page.click('[data-testid="conflict-reload"]');
      await page.waitForSelector('[data-testid="editor-conflict"]');
      assert.ok((await vditor.get(page)).includes('MY-EDIT'), 'my edits are kept in the editor');
      await page.screenshot({ path: path.join(SHOTS, 'conflict-banner-desktop.png') });
      await page.click('[data-testid="editor-conflict-keep"]');
      await page.waitForSelector('[data-testid="editor-conflict"]', { state: 'detached' });
      const commit = await clickAndCommit(page, mock, '[data-testid="editor-publish"]');
      assert.match(commit.message, /更新/);
      assert.match(mock.readFile(POST), /MY-EDIT/);
      assert.match(mock.readFile(POST), /AUTOSAVE-MARK/, 'my version (chosen) overwrote the external one');
    });

    await test('conflict: 加载最新版本 discards my edits and shows the external version', async () => {
      await typeAtEnd(page, 'DISCARD-ME');
      mock.setFile(POST, mock.readFile(POST).replace('MY-EDIT', 'THEIR-EDIT'));
      await page.click('[data-testid="editor-publish"]');
      await page.click('[data-testid="conflict-reload"]');
      await page.click('[data-testid="editor-conflict-reload"]');
      await page.click('[data-testid="confirm-ok"]');
      await page.waitForSelector('[data-testid="editor-conflict"]', { state: 'detached' });
      const md = await vditor.get(page);
      assert.ok(md.includes('THEIR-EDIT') && !md.includes('DISCARD-ME'));
      assert.equal(await page.locator('[data-testid="editor-tab-shared"] .ed-dot').count(), 0);
    });

    const FIRST = 'content/posts/first-physics-note.md';
    await test('existing post: 更新 without edits is a no-op; a small edit keeps math/code/comments intact', async () => {
      const original = mock.readFile(FIRST);
      await gotoEdit(page, '#/edit?path=' + encodeURIComponent(FIRST));
      assert.equal(await page.textContent('[data-testid="editor-publish"]'), '更新');
      assert.match(await page.textContent('.ed-tabs'), /共用版本.*英文专属.*单独写中文版/);
      assert.equal(await page.locator('[data-testid="editor-tab-shared"] .ed-dot').count(), 0, 'opening does not make it dirty');
      const n = mock.commits.length;
      await page.click('[data-testid="editor-publish"]');
      await page.locator('[data-testid="toast-info"]', { hasText: '一样' }).waitFor();
      assert.equal(mock.commits.length, n, 'no commit');
      assert.equal(mock.readFile(FIRST), original);

      await typeAtEnd(page, '补充一句。');
      await clickAndCommit(page, mock, '[data-testid="editor-publish"]');
      const now = mock.readFile(FIRST);
      const a = splitMd(original);
      const b = splitMd(now);
      assert.equal(b.fm, a.fm, 'front matter (with its comment) unchanged byte-for-byte');
      assert.match(b.fm, /draft: false {2}# <--- 重要！/);
      assert.deepEqual(texOf(b.body), texOf(a.body), 'all TeX intact');
      assert.ok(b.body.includes('```python\nimport numpy as np'), 'code block intact');
      assert.ok(b.body.includes('def calculate_event_horizon(mass):'));
      assert.match(b.body, /补充一句。/);
      assert.match(b.body, /^## 场方程$/m);
    });

    const ABOUT = 'content/about.md';
    await test('page: about.md menu name/order → comments in front matter preserved', async () => {
      const original = mock.readFile(ABOUT);
      await gotoEdit(page, '#/edit?path=' + encodeURIComponent(ABOUT));
      assert.equal(await page.textContent('.topbar-title'), '编辑页面');
      assert.equal(await page.locator('[data-testid="editor-slug"]').count(), 0);
      assert.equal(await page.locator('[data-testid="editor-tags"]').count(), 0, 'post-only fields hidden for pages');
      assert.equal(await page.inputValue('[data-testid="editor-linktitle"]'), '关于');
      assert.equal(await page.isChecked('[data-testid="editor-inmenu"]'), true);
      assert.equal(await page.inputValue('[data-testid="editor-weight"]'), '10');
      await page.screenshot({ path: path.join(SHOTS, 'page-about-desktop.png') });
      await page.fill('[data-testid="editor-linktitle"]', '关于我们');
      await page.fill('[data-testid="editor-weight"]', '15');
      const commit = await clickAndCommit(page, mock, '[data-testid="editor-publish"]');
      assert.match(commit.message, /^admin: 更新《关于我》/);
      const now = mock.readFile(ABOUT);
      const a = splitMd(original);
      const b = splitMd(now);
      assert.equal(b.body.trimEnd(), a.body.trimEnd(), 'body untouched');
      assert.match(b.fm, /^linkTitle: "关于我们" {3}# 菜单里显示的名字$/m);
      assert.match(b.fm, /^ {4}weight: 15 {4}# 菜单顺序，数字越小越靠左$/m);
      assert.match(b.fm, /^layout: "about" {3}# 告诉 Hugo 这是一个特殊页面$/m);
      assert.match(b.fm, /^hidemeta: true {4}# 隐藏发布日期、字数统计等博客才有的信息$/m);
      const diff = b.fm.split('\n').filter((l, i) => l !== a.fm.split('\n')[i]);
      assert.equal(diff.length, 2, 'only two lines changed: ' + diff.join(' | '));
      // the English page was not touched
      assert.match(mock.readFile('content/about.en.md'), /weight: 10/);
    });

    await test('mobile: editor layout, settings drawer, no horizontal scroll', async () => {
      const mctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
      const mp = await mctx.newPage();
      mp.on('pageerror', (e) => pageErrors.push('mobile: ' + e.message));
      await openAdmin(mp, mock, { path: '/admin/#/edit?path=' + encodeURIComponent(POST) });
      await waitEditor(mp);
      assert.ok(await noHScroll(mp), 'no horizontal scroll (post)');
      assert.equal(await mp.isVisible('.sidenav'), false, 'tab bar hidden in the editor');
      assert.ok(await mp.isVisible('[data-testid="editor-back"]'));
      assert.ok(await mp.isVisible('[data-testid="editor-publish"]'));
      assert.equal(await mp.isVisible('[data-testid="editor-tags"]'), false, 'settings collapsed');
      await mp.screenshot({ path: path.join(SHOTS, 'post-mobile.png') });
      await mp.click('[data-testid="editor-settings-toggle"]');
      await mp.locator('[data-testid="editor-tags"]').scrollIntoViewIfNeeded();
      assert.ok(await mp.isVisible('[data-testid="editor-tags"]'));
      assert.ok(await noHScroll(mp), 'no horizontal scroll (settings open)');
      await mp.screenshot({ path: path.join(SHOTS, 'post-mobile-settings.png') });
      await mp.click('[data-testid="editor-preview"]');
      await mp.waitForSelector('[data-testid="preview-iframe"][data-state="ready"]', { timeout: 30000 });
      await mp.click('[data-testid="preview-lang-en"]');
      await mp.waitForFunction(() => {
        const f = document.querySelector('[data-testid="preview-iframe"]');
        return f.dataset.lang === 'en' && f.dataset.state === 'ready';
      });
      const fr = await (await mp.$('[data-testid="preview-iframe"]')).contentFrame();
      assert.equal(await fr.textContent('.post-title'), 'Hello Math World (EN)');
      await mp.screenshot({ path: path.join(SHOTS, 'preview-mobile.png') });
      await mp.click('[data-testid="modal-close"]');
      await gotoEdit(mp, '#/edit?new=post');
      assert.ok(await noHScroll(mp), 'no horizontal scroll (new post)');
      await mp.screenshot({ path: path.join(SHOTS, 'new-post-mobile.png') });
      await gotoEdit(mp, '#/edit?path=' + encodeURIComponent(ABOUT));
      await mp.click('[data-testid="editor-settings-toggle"]');
      assert.ok(await noHScroll(mp), 'no horizontal scroll (page)');
      await mp.screenshot({ path: path.join(SHOTS, 'page-mobile.png'), fullPage: true });
      await mctx.close();
    });

    await test('cover image upload + 资料 button (document upload) → one commit', async () => {
      await gotoEdit(page, '#/edit?path=' + encodeURIComponent(POST));
      const jpg = await canvasImage(page, { w: 1200, h: 630, type: 'image/jpeg', label: 'C' });
      await page.setInputFiles('[data-testid="editor-cover-input"]', { name: 'cover.jpg', mimeType: 'image/jpeg', buffer: jpg });
      await page.waitForSelector('.ed-cover-thumb img[src^="blob:"]');
      // 资料 toolbar button → modal → upload a PDF → link inserted
      await page.click('[data-testid="editor-body"] .vditor-toolbar [data-type="documents"]');
      await page.waitForSelector('[data-testid="editor-docs-search"]');
      await page.setInputFiles('[data-testid="editor-docs-upload"]', { name: '讲义 第1章.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n% test\n') });
      await page.waitForSelector('.modal', { state: 'detached' });
      await until(async () => (await vditor.get(page)).includes('/documents/讲义-第1章.pdf'), { msg: 'document link inserted' });
      const commit = await clickAndCommit(page, mock, '[data-testid="editor-publish"]');
      const paths = commit.changes.map((c) => c.path);
      assert.ok(paths.includes(POST));
      assert.ok(paths.includes('static/documents/讲义-第1章.pdf'), paths.join(', '));
      const cover = paths.find((p) => p.startsWith(IMGDIR + '/') && /cover\.jpg$/.test(p));
      assert.ok(cover, 'cover uploaded into the post image folder');
      const { fm, body } = splitMd(mock.readFile(POST));
      assert.match(fm, new RegExp(`^cover: \\{ image: "/images/posts/${SLUG}/\\d{8}-\\d{6}-cover\\.jpg" \\}$`, 'm'));
      assert.match(body, /\[讲义 第1章\.pdf\]\(\/documents\/讲义-第1章\.pdf\)/);
      assert.equal(mock.readFile('static/documents/讲义-第1章.pdf'), '%PDF-1.4\n% test\n');
      // the 资料 picker now lists the uploaded file
      await page.click('[data-testid="editor-body"] .vditor-toolbar [data-type="documents"]');
      await page.waitForSelector('[data-testid="editor-doc-item"]');
      assert.match(await page.textContent('.ed-doc-list'), /讲义-第1章\.pdf/);
      await page.click('[data-testid="modal-close"]');
      // settings toggles: math off → written; comments on → written; background effect
      await page.click('[data-testid="editor-math"]');
      await page.click('[data-testid="editor-comments"]');
      await page.selectOption('[data-testid="editor-effect"]', 'lorenz');
      await clickAndCommit(page, mock, '[data-testid="editor-publish"]');
      const fm2 = splitMd(mock.readFile(POST)).fm;
      assert.match(fm2, /^math: false$/m);
      assert.match(fm2, /^comments: true$/m);
      assert.match(fm2, /^background: \{ effect: "lorenz" \}$/m);
      await page.click('[data-testid="editor-math"]');
      await page.selectOption('[data-testid="editor-effect"]', '');
      await clickAndCommit(page, mock, '[data-testid="editor-publish"]');
      const fm3 = splitMd(mock.readFile(POST)).fm;
      assert.match(fm3, /^math: true$/m);
      assert.ok(!/^background:/m.test(fm3), '跟随全站设置 removes the key');
    });

    await test('new post autosaves locally; #/edit?draft=<key> restores it', async () => {
      await gotoEdit(page, '#/edit?new=post');
      await page.fill('[data-testid="editor-title"]', '本机草稿测试');
      await vditor.insert(page, '还没有发表的正文 $a^2$\n');
      // 公式 button: inserts a $$ block and puts the caret inside it
      await page.click('[data-testid="editor-body"] .vditor-toolbar [data-type="formula"]');
      await page.keyboard.type('x^3+y^3');
      await until(async () => /\$\$\nx\^3\+y\^3\n\$\$/.test(await vditor.get(page)), { msg: 'formula typed into the new block' });
      const png = await canvasImage(page, { w: 300, h: 200, label: 'D' });
      await page.setInputFiles('[data-testid="editor-body"] .vditor-toolbar [data-type="upload"] input[type="file"]', { name: 'draft.png', mimeType: 'image/png', buffer: png });
      await until(async () => /\]\(blob:/.test(await vditor.get(page)), { msg: 'image' });
      await page.waitForFunction(() => /已自动保存到本机/.test(document.querySelector('[data-testid="editor-autosave-status"]').textContent), null, { timeout: 10000 });
      const list = await page.evaluate(async () => (await import('/admin/js/drafts.js')).listDrafts());
      const d = list.find((x) => x.title === '本机草稿测试');
      assert.ok(d && d.key.startsWith('new:'), JSON.stringify(list));
      // leave (confirm) and come back through the draft route
      await page.evaluate(() => { location.hash = '#/posts'; });
      await page.click('[data-testid="confirm-ok"]');
      await page.waitForSelector('body[data-view-ready="posts"]', { state: 'attached' });
      await gotoEdit(page, '#/edit?draft=' + encodeURIComponent(d.key));
      assert.equal(await page.inputValue('[data-testid="editor-title"]'), '本机草稿测试');
      const md = await vditor.get(page);
      assert.ok(md.includes('还没有发表的正文'), md);
      assert.match(md, /\$\$\nx\^3\+y\^3\n\$\$/);
      assert.match(md, /!\[[^\]]*\]\(blob:/, 'draft image restored as a blob URL');
      assert.equal(await page.inputValue('[data-testid="editor-slug"]'), 'post-' + (await page.evaluate(() => { const d = new Date(); return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`; })));
      await page.fill('[data-testid="editor-slug"]', 'local-draft-test');
      const commit = await clickAndCommit(page, mock, '[data-testid="editor-save-draft"]');
      assert.match(commit.message, /保存草稿《本机草稿测试》/);
      const text = mock.readFile('content/posts/local-draft-test.md');
      assert.match(text, /^draft: true$/m);
      assert.match(text, /!\[[^\]]*\]\(\/images\/posts\/local-draft-test\/\d{8}-\d{6}-draft\.(png|jpg)\)/);
      assert.ok(commit.changes.some((c) => c.path.startsWith('static/images/posts/local-draft-test/')));
      await waitEditor(page);
      const after = await page.evaluate(async () => (await import('/admin/js/drafts.js')).listDrafts());
      assert.ok(!after.some((x) => x.key === d.key), 'new: draft removed after saving');
    });

    await test('new section page (#/edit?new=page&dir=…) → _index.md with menu', async () => {
      await gotoEdit(page, '#/edit?new=page&dir=' + encodeURIComponent('content/talks'));
      assert.equal(await page.textContent('.topbar-title'), '新建页面');
      await page.waitForFunction(() => document.querySelector('[data-testid="editor-weight"]') && document.querySelector('[data-testid="editor-weight"]').value !== '');
      const w = Number(await page.inputValue('[data-testid="editor-weight"]'));
      assert.ok(w >= 20, 'weight after existing menu items: ' + w);
      await page.fill('[data-testid="editor-title"]', '学术报告');
      await page.fill('[data-testid="editor-linktitle"]', '报告');
      await vditor.insert(page, '这里写栏目介绍。\n');
      await clickAndCommit(page, mock, '[data-testid="editor-publish"]');
      const { fm, body } = splitMd(mock.readFile('content/talks/_index.md'));
      assert.match(fm, /^title: "学术报告"$/m);
      assert.match(fm, /^linkTitle: "报告"$/m);
      assert.match(fm, new RegExp(`^menu: \\{ main: \\{ weight: ${w} \\} \\}$`, 'm'));
      assert.match(fm, /^draft: false$/m);
      assert.match(body, /这里写栏目介绍。/);
      await waitEditor(page);
    });

    await test('save draft of a new post; leave guard; 删除此版本 / 删除整篇文章', async () => {
      await gotoEdit(page, '#/edit?new=post');
      await page.fill('[data-testid="editor-title"]', 'Draft Only');
      await vditor.insert(page, '草稿正文\n');
      // leaving with unsaved work asks first
      await page.evaluate(() => { location.hash = '#/posts'; });
      await page.waitForSelector('[data-testid="confirm-cancel"]');
      assert.match(await page.textContent('.modal'), /自动保存/);
      await page.click('[data-testid="confirm-cancel"]');
      await page.waitForSelector('.modal', { state: 'detached' });
      assert.match(await page.evaluate(() => location.hash), /^#\/edit/);
      const commit = await clickAndCommit(page, mock, '[data-testid="editor-save-draft"]');
      assert.match(commit.message, /^admin: 保存草稿《Draft Only》/);
      assert.match(mock.readFile('content/posts/draft-only.md'), /^draft: true$/m);
      await waitEditor(page);
      assert.equal(await page.textContent('[data-testid="editor-publish"]'), '发表');
      assert.equal((await page.textContent('[data-testid="editor-status"]')).trim(), '草稿');

      // delete the English variant of the test post → English site falls back to the shared one
      await gotoEdit(page, '#/edit?path=' + encodeURIComponent(POST_EN));
      assert.ok(await page.isVisible('[data-testid="editor-tab-en"].active'));
      await page.click('[data-testid="editor-more"]');
      await page.click('[data-testid="editor-delete-variant"]');
      await page.waitForSelector('[data-testid="confirm-ok"]');
      assert.match(await page.textContent('.modal'), /英文站将改回显示共用版本/);
      const n = mock.commits.length;
      await page.click('[data-testid="confirm-ok"]');
      await until(() => mock.commits.length > n, { msg: 'delete commit' });
      assert.equal(mock.readFile(POST_EN), undefined);
      assert.ok(mock.readFile(POST));
      await waitEditor(page);

      // delete the whole draft post
      await gotoEdit(page, '#/edit?path=' + encodeURIComponent('content/posts/draft-only.md'));
      await page.click('[data-testid="editor-more"]');
      await page.click('[data-testid="editor-delete-all"]');
      await page.waitForSelector('[data-testid="confirm-ok"]');
      const n2 = mock.commits.length;
      await page.click('[data-testid="confirm-ok"]');
      await until(() => mock.commits.length > n2, { msg: 'delete-all commit' });
      assert.equal(mock.readFile('content/posts/draft-only.md'), undefined);
      await until(async () => (await page.evaluate(() => location.hash)).startsWith('#/posts'), { msg: 'back to the list' });
    });

    // -----------------------------------------------------------------------
    // Regression tests from the review (security / integrity / robustness / phone UX)

    /** Make the admin re-read the repository (after mock.setFile) and open a hash. */
    async function reloadTo(p, hash) {
      await p.evaluate((h) => { location.hash = h; }, hash);
      await p.reload({ waitUntil: 'domcontentloaded' });
      await p.waitForSelector('body[data-testid="app-ready"]', { state: 'attached' });
      if (hash.startsWith('#/edit')) await waitEditor(p);
    }
    const draftOf = (p, key) => p.evaluate(async (k) => {
      const d = await (await import('/admin/js/drafts.js')).loadDraft(k);
      return d ? { markdown: d.markdown, title: d.title, writer: d.fields && d.fields.writer } : null;
    }, key);
    const deleteDraftIn = (p, key) => p.evaluate(async (k) => (await import('/admin/js/drafts.js')).deleteDraft(k), key);
    const waitAutosaved = (p) => p.waitForFunction(() => /已自动保存到本机 · \d{2}:\d{2}/.test(document.querySelector('[data-testid="editor-autosave-status"]').textContent), null, { timeout: 10000 });
    const fmOf = (title, extra = '') => `---\ntitle: "${title}"\ndate: 2025-12-06\ndraft: false\n${extra}---\n\n`;

    const EMBED = 'content/posts/embed-probe.md';
    await test('security: <iframe>/<object>/<embed> in a post never load inside the editor (token stays private)', async () => {
      const probe = '<!doctype html><script>try{parent.__stolen=(parent.sessionStorage.getItem("admin.token")||parent.localStorage.getItem("admin.token")||"no-token")}catch(e){parent.__stolen="blocked:"+e.name}</script>probe';
      fs.writeFileSync(path.join(SITE_DIR, 'probe.html'), probe);
      fs.writeFileSync(path.join(SITE_DIR, 'probe2.html'), probe);
      const body = '看看这个图：\n\n<iframe src="/probe.html" width="300" height="100"></iframe>\n\n行内 <iframe src="/probe2.html"></iframe> 嵌入。\n\n<div><object data="/probe.html"></object><embed src="/probe.html"></div>\n\n最后一段。\n';
      mock.setFile(EMBED, fmOf('嵌入测试') + body);
      await reloadTo(page, '#/edit?path=' + encodeURIComponent(EMBED));
      await sleep(1500);
      const check = async (where) => {
        assert.equal(await page.evaluate(() => window.__stolen), undefined, `${where}: an embedded same-origin page ran scripts in the admin`);
        assert.equal(await page.locator('[data-testid="editor-body"] iframe, [data-testid="editor-body"] object, [data-testid="editor-body"] embed').count(), 0, `${where}: live embed in the editor DOM`);
      };
      await check('wysiwyg');
      assert.ok(await page.locator('[data-testid="editor-body"] .ed-embed-blocked').count() >= 1, 'placeholder shown');
      // the other editing modes are guarded too
      for (const mode of ['ir', 'sv', 'wysiwyg']) {
        await page.evaluate((m) => document.querySelector(`[data-testid="editor-body"] .vditor-toolbar [data-mode="${m}"]`).click(), mode);
        await sleep(800);
        await check(mode);
      }
      // nothing of the HTML is lost when the post is edited
      await typeAtEnd(page, '补充。');
      await clickAndCommit(page, mock, '[data-testid="editor-publish"]');
      const saved = splitMd(mock.readFile(EMBED)).body;
      assert.equal(saved, '\n' + body.replace('最后一段。', '最后一段。补充。'));
      await check('after publish');
    });

    const TRICKY = 'content/posts/tricky-format.md';
    const TRICKY_BODY = [
      'Intro paragraph with trailing two spaces  ', 'next line after hard break.', '',
      '## Heading with id {#custom-id}', '',
      'Here is a reference-style [link][ref] and a footnote[^1].', '',
      '[^1]: The footnote text.', '',
      '[ref]: https://example.com "Example Title"', '',
      '***', '',
      'Line ending with backslash\\', 'next line.', '',
      'Emoji shortcode :smile: and <https://x.example>.', '',
      '| Col A | Col B |', '|-------|-------|', '| x | y |', '',
      'Final line.', '',
    ].join('\n');
    await test('lossless: editing one line keeps hard breaks, {#id}, link titles, *** elsewhere byte-for-byte', async () => {
      mock.setFile(TRICKY, fmOf('Tricky') + TRICKY_BODY);
      await reloadTo(page, '#/edit?path=' + encodeURIComponent(TRICKY));
      await typeAtEnd(page, 'X');
      await clickAndCommit(page, mock, '[data-testid="editor-publish"]');
      assert.equal(mock.readFile(TRICKY), fmOf('Tricky') + TRICKY_BODY.replace('Final line.', 'Final line.X'));
      // a second edit on the reopened file (new baseline) is just as careful
      await typeAtEnd(page, 'Y');
      await clickAndCommit(page, mock, '[data-testid="editor-publish"]');
      assert.equal(mock.readFile(TRICKY), fmOf('Tricky') + TRICKY_BODY.replace('Final line.', 'Final line.XY'));
      // editing the line right after a hard break keeps the break on the line before
      const before = mock.readFile(TRICKY);
      await page.evaluate(() => {
        const p = document.querySelector('[data-testid="editor-body"] .vditor-wysiwyg .vditor-reset > p');
        const r = document.createRange();
        r.selectNodeContents(p);
        r.collapse(false);
        getSelection().removeAllRanges();
        getSelection().addRange(r);
      });
      await page.keyboard.type('!', { delay: 5 });
      await clickAndCommit(page, mock, '[data-testid="editor-publish"]');
      const after = mock.readFile(TRICKY);
      assert.match(after, /^Intro paragraph with trailing two spaces {2}$/m, 'hard break kept');
      assert.match(after, /^next line after hard break\.!$/m);
      assert.equal(after.replace('hard break.!', 'hard break.'), before);
    });

    const TWIN = 'content/posts/two-variants.md';
    const TWIN_EN = 'content/posts/two-variants.en.md';
    await test('switching variant tabs does not make a post dirty; a title-only update keeps the body', async () => {
      mock.setFiles({ [TWIN]: fmOf('两个版本') + TRICKY_BODY, [TWIN_EN]: fmOf('Two variants') + TRICKY_BODY.replace('Intro', 'English intro') });
      await reloadTo(page, '#/edit?path=' + encodeURIComponent(TWIN));
      for (const k of ['en', 'shared', 'en', 'shared']) {
        await page.click(`[data-testid="editor-tab-${k}"]`);
        await page.waitForSelector(`[data-testid="editor-tab-${k}"].active`);
      }
      await sleep(1200);
      assert.equal(await page.locator('.ed-tabs .ed-dot').count(), 0, 'no unsaved dot after switching tabs');
      assert.equal(await page.textContent('[data-testid="editor-autosave-status"]'), '已是网站上的最新内容');
      await page.fill('[data-testid="editor-title"]', '两个版本（改了标题）');
      await clickAndCommit(page, mock, '[data-testid="editor-publish"]');
      assert.equal(mock.readFile(TWIN), fmOf('两个版本（改了标题）') + TRICKY_BODY);
      assert.equal(mock.commits.at(-1).changes.length, 1);
    });

    await test('pending local draft: typing asks 恢复 / 丢弃; edits after 丢弃 are autosaved; restore works', async () => {
      const key = 'file:' + TRICKY;
      await gotoEdit(page, '#/edit?path=' + encodeURIComponent(TRICKY));
      await typeAtEnd(page, ' FIRST-EDIT');
      await waitAutosaved(page);
      assert.match((await draftOf(page, key)).markdown, /FIRST-EDIT/);
      await reloadTo(page, '#/edit?path=' + encodeURIComponent(TRICKY));
      await page.waitForSelector('[data-testid="editor-draft-banner"]');
      // ignore the banner and start editing → asked before the first keystroke
      await page.click('[data-testid="editor-body"] .vditor-reset');
      await page.waitForSelector('[data-testid="editor-pending-discard"]', { timeout: 8000 });
      assert.match(await page.textContent('.modal'), /新的修改不会自动保存/);
      assert.equal(await page.locator('.modal [data-testid="modal-close"]').count(), 0, 'must choose');
      await page.click('[data-testid="editor-pending-discard"]');
      await page.waitForSelector('[data-testid="editor-draft-banner"]', { state: 'detached' });
      await typeAtEnd(page, ' SECOND-EDIT');
      await waitAutosaved(page);
      let d = await draftOf(page, key);
      assert.ok(/SECOND-EDIT/.test(d.markdown) && !/FIRST-EDIT/.test(d.markdown), 'new edits saved: ' + d.markdown.slice(-80));
      // leave and come back → restore through the dialog
      await reloadTo(page, '#/edit?path=' + encodeURIComponent(TRICKY));
      await page.waitForSelector('[data-testid="editor-draft-banner"]');
      await page.click('[data-testid="editor-description"]');
      await page.waitForSelector('[data-testid="editor-pending-restore"]');
      await page.click('[data-testid="editor-pending-restore"]');
      await until(async () => (await vditor.get(page)).includes('SECOND-EDIT'), { msg: 'draft restored' });
      // publishing with an untouched pending draft asks first (never silently deletes it)
      d = await draftOf(page, key);
      assert.ok(d, 'draft still there');
      await reloadTo(page, '#/edit?path=' + encodeURIComponent(TRICKY));
      await page.waitForSelector('[data-testid="editor-draft-banner"]');
      await page.click('[data-testid="editor-save-draft"]');
      await page.waitForSelector('[data-testid="editor-pending-discard"]');
      await page.click('[data-testid="modal-close"]');
      await page.waitForSelector('.modal', { state: 'detached' });
      assert.ok(await draftOf(page, key), 'draft kept when the dialog is dismissed');
      await deleteDraftIn(page, key);
    });

    const twoDays = () => {
      const d = new Date(Date.now() + 2 * 86400000);
      const p2 = (n) => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}T10:00`;
    };
    await test('future date: 发表 warns; 改为现在 publishes now; 仍按这个日期 shows 定时发表', async () => {
      await gotoEdit(page, '#/edit?new=post');
      await page.fill('[data-testid="editor-title"]', 'Future Note');
      await vditor.insert(page, '明天的讲座。\n');
      await page.fill('[data-testid="editor-date"]', twoDays());
      await page.dispatchEvent('[data-testid="editor-date"]', 'change');
      const n = mock.commits.length;
      await page.click('[data-testid="editor-publish"]');
      await page.waitForSelector('[data-testid="editor-future-cancel"]');
      await page.click('[data-testid="editor-future-cancel"]');
      await sleep(300);
      assert.equal(mock.commits.length, n, 'cancel → nothing published');
      await page.click('[data-testid="editor-publish"]');
      await page.waitForSelector('[data-testid="editor-future-keep"]');
      await page.click('[data-testid="editor-future-keep"]');
      await until(() => mock.commits.length > n, { msg: 'future commit' });
      await page.waitForSelector('[data-testid="overlay"]', { state: 'detached' });
      await waitEditor(page);
      assert.match(mock.readFile('content/posts/future-note.md'), new RegExp(`^date: "${twoDays()}:00[+-]\\d\\d:\\d\\d"$`, 'm'));
      await until(async () => (await page.textContent('[data-testid="editor-status"]')).includes('定时发表'), { msg: '定时发表 badge' });
      // 改为现在并发表
      await typeAtEnd(page, '改期');
      await page.click('[data-testid="editor-publish"]');
      await page.waitForSelector('[data-testid="editor-future-now"]');
      const n2 = mock.commits.length;
      await page.click('[data-testid="editor-future-now"]');
      await until(() => mock.commits.length > n2, { msg: 'commit with date = now' });
      await page.waitForSelector('[data-testid="overlay"]', { state: 'detached' });
      const date = /^date: "([^"]+)"$/m.exec(mock.readFile('content/posts/future-note.md'))[1];
      assert.ok(Math.abs(Date.parse(date) - Date.now()) < 5 * 60000, 'date set to now: ' + date);
      assert.equal((await page.textContent('[data-testid="editor-status"]')).trim(), '已发表');
    });

    await test('images: another post\'s image keeps its own path; repo-only images load from the repo after a reload', async () => {
      const imgPath = `/images/posts/${SLUG}/${imgName1}`;
      assert.ok(mock.readFile(`${IMGDIR}/${imgName1}`) !== undefined, 'image is in the repo');
      assert.ok(!fs.existsSync(path.join(SITE_DIR, 'images', 'posts', SLUG, imgName1)), 'but not on the (old) site build');
      await gotoEdit(page, '#/edit?new=post');
      await page.fill('[data-testid="editor-title"]', 'Reuse Image');
      await vditor.insert(page, `复用图片：\n\n![fig](${imgPath})\n\n结尾。\n`);
      await clickAndCommit(page, mock, '[data-testid="editor-publish"]');
      const B = 'content/posts/reuse-image.md';
      assert.ok(mock.readFile(B).includes(`](${imgPath})`));
      // fresh page load: no in-memory upload cache any more
      await reloadTo(page, '#/edit?path=' + encodeURIComponent(B));
      await until(() => page.evaluate(() => {
        const img = document.querySelector('[data-testid="editor-body"] .vditor-reset img');
        return img && img.src.startsWith('blob:') && img.complete && img.naturalWidth > 0;
      }), { msg: 'repo-only image shown from the repo (not a broken image)' });
      await typeAtEnd(page, 'Y');
      const commit = await clickAndCommit(page, mock, '[data-testid="editor-publish"]');
      assert.deepEqual(commit.changes.map((c) => c.path), [B]);
      const body = splitMd(mock.readFile(B)).body;
      assert.ok(body.includes(`![fig](${imgPath})`), 'image path unchanged: ' + body);
      assert.ok(!body.includes('/images/posts/reuse-image/'));
      // the phone preview shows it as well
      await page.click('[data-testid="editor-preview"]');
      const fr = await (await page.waitForSelector('[data-testid="preview-iframe"][data-state="ready"]', { timeout: 30000 })).contentFrame();
      await until(() => fr.evaluate(() => { const i = document.querySelector('.post-content img'); return i && i.complete && i.naturalWidth > 0; }), { msg: 'preview image loads' });
      await page.click('[data-testid="modal-close"]');
    });

    await test('资料 picker: names with spaces, # and % become working links (and the site still builds)', async () => {
      mock.setFiles({
        'static/documents/Lecture Notes (1).pdf': '%PDF-1.4 a\n',
        'static/documents/量子 力学#2.pdf': '%PDF-1.4 b\n',
        'static/documents/50%off.pdf': '%PDF-1.4 c\n',
      });
      await reloadTo(page, '#/edit?new=post');
      await page.fill('[data-testid="editor-title"]', 'Docs Links');
      await vditor.insert(page, '资料：\n');
      for (const q of ['Lecture', '力学', '50%']) {
        await page.click('[data-testid="editor-body"] .vditor-toolbar [data-type="documents"]');
        await page.fill('[data-testid="editor-docs-search"]', q);
        await page.click('[data-testid="editor-doc-item"]');
        await page.waitForSelector('.modal', { state: 'detached' });
        await page.keyboard.type(' ');
      }
      await until(async () => (await page.locator('[data-testid="editor-body"] .vditor-reset a').count()) === 3, { msg: '3 links in the editor' });
      await clickAndCommit(page, mock, '[data-testid="editor-publish"]');
      const body = splitMd(mock.readFile('content/posts/docs-links.md')).body;
      assert.ok(body.includes('](/documents/Lecture%20Notes%20%281%29.pdf)'), body);
      assert.ok(body.includes('](/documents/量子%20力学%232.pdf)'), body);
      assert.ok(body.includes('](/documents/50%25off.pdf)'), body);
      const repoDir = mock.exportTo(path.join(OUT, 'export-docs'));
      const out = path.join(OUT, 'build-docs');
      await buildSite({ repoDir, outDir: out });
      const html = fs.readFileSync(path.join(out, 'posts', 'docs-links', 'index.html'), 'utf8');
      assert.match(html, /href="?\/documents\/Lecture%20Notes%20%281%29\.pdf/);
      assert.match(html, /href="?\/documents\/50%25off\.pdf/);
      // safety net: a hand-typed bad % link is refused before it can break the site build
      await waitEditor(page);
      await vditor.insert(page, '\n[坏链接](/documents/50%off.pdf)\n');
      if (await page.locator('.modal').count()) throw new Error('unexpected dialog: ' + await page.textContent('.modal'));
      const n = mock.commits.length;
      await page.click('[data-testid="editor-publish"]');
      await page.locator('[data-testid="toast-error"]', { hasText: '%' }).waitFor();
      assert.equal(mock.commits.length, n);
    });

    await test('删除整个页面 on a section only offers the section\'s own images (not its child pages\')', async () => {
      mock.setFiles({
        'content/lectures/_index.md': fmOf('讲义'),
        'content/lectures/optics.md': fmOf('光学'),
        'static/images/pages/lectures/banner.png': 'png-a',
        'static/images/pages/lectures/optics/fig1.png': 'png-b',
      });
      await reloadTo(page, '#/edit?path=' + encodeURIComponent('content/lectures/_index.md'));
      await page.click('[data-testid="editor-more"]');
      await page.click('[data-testid="editor-delete-all"]');
      await page.waitForSelector('[data-testid="editor-delete-images"]');
      assert.match(await page.textContent('.modal'), /（1 个文件）/);
      await page.check('[data-testid="editor-delete-images"]');
      const n = mock.commits.length;
      await page.click('[data-testid="confirm-ok"]');
      await until(() => mock.commits.length > n, { msg: 'delete commit' });
      assert.deepEqual(mock.commits.at(-1).changes.map((c) => c.path).sort(), ['content/lectures/_index.md', 'static/images/pages/lectures/banner.png']);
      assert.equal(mock.readFile('static/images/pages/lectures/optics/fig1.png'), 'png-b', "child page's image kept");
    });

    await test('a new-post draft whose post is already published offers to open it (no duplicate post)', async () => {
      await page.evaluate(async () => {
        await (await import('/admin/js/drafts.js')).saveDraft('new:already-published', {
          title: 'Hello Math World', markdown: '正文',
          fields: { kind: 'post', slug: 'hello-math-world', slugTouched: false, newGroup: true, form: { title: 'Hello Math World', tags: [], categories: [] } },
          images: {}, updatedAt: Date.now() - 60000,
        });
      });
      await gotoEdit(page, '#/edit?draft=new%3Aalready-published');
      await page.waitForSelector('[data-testid="editor-twin-banner"]');
      assert.match(await page.textContent('[data-testid="editor-twin-banner"]'), /已经发表过了/);
      await page.click('[data-testid="editor-twin-open"]');
      await page.click('[data-testid="confirm-ok"]');
      await until(async () => (await page.evaluate(() => location.hash)) === '#/edit?path=' + encodeURIComponent(POST), { msg: 'opened the published post' });
      assert.equal(await draftOf(page, 'new:already-published'), null);
      await waitEditor(page);
    });

    await test('Back during 发表 is refused; the published new post leaves no stale local draft', async () => {
      await gotoEdit(page, '#/edit?new=post');
      await page.fill('[data-testid="editor-title"]', 'Back During Publish');
      await vditor.insert(page, '发表的时候按了返回。\n');
      await waitAutosaved(page);
      mock.setApiDelay(1200);
      try {
        const n = mock.commits.length;
        await page.click('[data-testid="editor-publish"]');
        await page.waitForSelector('[data-testid="overlay"]');
        await page.evaluate(() => { location.hash = '#/posts'; });
        await page.locator('[data-testid="toast-warning"]', { hasText: '正在发表' }).waitFor();
        await until(() => mock.commits.length > n, { msg: 'commit' });
        await page.waitForSelector('[data-testid="overlay"]', { state: 'detached', timeout: 30000 });
      } finally {
        mock.setApiDelay(0);
      }
      await waitEditor(page);
      assert.match(await page.evaluate(() => location.hash), /^#\/edit\?path=content%2Fposts%2Fback-during-publish\.md$/);
      const left = await page.evaluate(async () => (await (await import('/admin/js/drafts.js')).listDrafts()).filter((d) => d.title === 'Back During Publish'));
      assert.deepEqual(left, []);
    });

    await test('after 发表, "已上线 ✓" and the success toast open the new post (not the homepage)', async () => {
      await gotoEdit(page, '#/edit?new=post');
      await page.fill('[data-testid="editor-title"]', 'Deploy Link Test');
      await page.fill('[data-testid="editor-slug"]', 'deploy-link-test');
      await vditor.insert(page, '部署完成之后，直接打开这篇文章。\n');
      const commit = await clickAndCommit(page, mock, '[data-testid="editor-publish"]');
      assert.deepEqual(commit.changes.map((c) => c.path), ['content/posts/deploy-link-test.md']);
      await page.waitForSelector('[data-testid="deploy-indicator"][data-state="success"]', { timeout: 30000 });
      const want = mock.url + '/posts/deploy-link-test/?v=' + commit.sha.slice(0, 7);
      assert.equal(await page.getAttribute('[data-testid="deploy-indicator"]', 'href'), want);
      const link = page.locator('[data-testid="toast-link"]', { hasText: '查看文章' });
      await link.waitFor();
      assert.equal(await link.getAttribute('href'), want);
    });

    await test('a new post whose first 发表 silently landed: 发表 again points to the published post instead of «换个文件名»', async () => {
      // same title + same file name as the post that is already on the site (e.g. the tab reloaded after a lost reply)
      await gotoEdit(page, '#/edit?new=post');
      await page.fill('[data-testid="editor-title"]', 'Deploy Link Test');
      await page.fill('[data-testid="editor-slug"]', 'deploy-link-test');
      await vditor.insert(page, '部署完成之后，直接打开这篇文章。\n');
      const n = mock.commits.length;
      await page.click('[data-testid="editor-publish"]');
      await page.locator('[data-testid="toast-warning"]', { hasText: '已经发表过了' }).waitFor();
      await page.waitForSelector('[data-testid="editor-twin-banner"]');
      assert.equal(mock.commits.length, n, 'nothing committed');
      await page.click('[data-testid="editor-twin-open"]');
      await page.click('[data-testid="confirm-ok"]');
      await until(async () => (await page.evaluate(() => location.hash)) === '#/edit?path=' + encodeURIComponent('content/posts/deploy-link-test.md'), { msg: 'opened the published post' });
      await waitEditor(page);
    });

    await test('two tabs on one post: publishing in tab A keeps tab B\'s unpublished work in its local draft', async () => {
      const key = 'file:' + TRICKY;
      await gotoEdit(page, '#/edit?path=' + encodeURIComponent(TRICKY));
      const pb = await context.newPage();
      pb.on('pageerror', (e) => pageErrors.push('tab B: ' + e.message));
      pb.on('dialog', (d) => d.accept());
      await openAdmin(pb, mock, { path: '/admin/#/edit?path=' + encodeURIComponent(TRICKY) });
      await waitEditor(pb);
      await typeAtEnd(pb, ' TAB-B-WORK');
      await waitAutosaved(pb);
      await typeAtEnd(page, ' TAB-A-FIX');
      await clickAndCommit(page, mock, '[data-testid="editor-publish"]');
      assert.match(mock.readFile(TRICKY), /TAB-A-FIX/);
      await until(async () => { const d = await draftOf(page, key); return d && /TAB-B-WORK/.test(d.markdown); }, { msg: "tab B's draft survives (re-saved)" });
      await pb.close();
      const d = await draftOf(page, key);
      assert.ok(d && /TAB-B-WORK/.test(d.markdown), "tab B's work is still in the local draft after closing it");
      await deleteDraftIn(page, key);
    });

    await test('typing does not make the admin re-serialise the whole document (long posts stay responsive)', async () => {
      const long = Array.from({ length: 120 }, (_, i) => `## 第 ${i + 1} 节\n\n正文 $a_${i}$ 和公式：\n\n$$\n\\int_0^{${i}} x^2\\,dx\n$$\n`).join('\n');
      mock.setFile('content/posts/long-notes.md', fmOf('长笔记') + long);
      await reloadTo(page, '#/edit?path=' + encodeURIComponent('content/posts/long-notes.md'));
      await page.evaluate(() => {
        const vd = document.querySelector('[data-testid="editor-body"]')._vditor;
        const orig = vd.getValue.bind(vd);
        window.__getValueCalls = 0;
        vd.getValue = () => { window.__getValueCalls++; return orig(); };
      });
      await typeAtEnd(page, '这是新加的一句话。');
      await waitAutosaved(page);
      const calls = await page.evaluate(() => window.__getValueCalls);
      assert.ok(calls <= 1, `admin called getValue ${calls} times while typing + autosaving`);
      await clickAndCommit(page, mock, '[data-testid="editor-publish"]');
      assert.ok(mock.readFile('content/posts/long-notes.md').includes('这是新加的一句话。'));
    });

    await test('phone: image / formula / 资料 buttons visible and ≥ 40 px; labelled 存草稿 / 预览; add-variant tab on screen', async () => {
      const mctx = await browser.newContext({ viewport: { width: 360, height: 740 }, isMobile: true, hasTouch: true });
      const mp = await mctx.newPage();
      mp.on('pageerror', (e) => pageErrors.push('mobile: ' + e.message));
      await openAdmin(mp, mock, { path: '/admin/#/edit?path=' + encodeURIComponent(FIRST) });
      await waitEditor(mp);
      const info = await mp.evaluate(() => {
        const box = (sel) => { const el = document.querySelector(sel); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x, r: r.right, w: r.width, h: r.height }; };
        const after = (sel) => getComputedStyle(document.querySelector(sel), '::after').content;
        return {
          vw: innerWidth,
          upload: box('[data-testid="editor-body"] .vditor-toolbar [data-type="upload"]'),
          formula: box('[data-testid="editor-body"] .vditor-toolbar [data-type="formula"]'),
          docs: box('[data-testid="editor-body"] .vditor-toolbar [data-type="documents"]'),
          bold: box('[data-testid="editor-body"] .vditor-toolbar [data-type="bold"]'),
          addTab: box('[data-testid^="editor-add-"]'),
          draftLabel: after('[data-testid="editor-save-draft"] .ed-btn-text'),
          previewLabel: after('[data-testid="editor-preview"] .ed-btn-text'),
          hint: document.querySelector('[data-testid="editor-body"]').classList.contains('ed-toolbar-more'),
        };
      });
      for (const k of ['upload', 'formula', 'docs', 'bold']) {
        assert.ok(info[k], `${k} button exists`);
        assert.ok(info[k].r <= info.vw && info[k].x >= 0, `${k} on screen: ${JSON.stringify(info[k])}`);
        assert.ok(info[k].w >= 40 && info[k].h >= 40, `${k} ≥ 40px: ${JSON.stringify(info[k])}`);
      }
      assert.ok(info.addTab && info.addTab.r <= info.vw, 'add-variant tab on screen: ' + JSON.stringify(info.addTab));
      assert.equal(info.draftLabel, '"转草稿"');
      assert.equal(info.previewLabel, '"预览"');
      assert.equal(info.hint, true, 'scroll hint when more buttons are off to the right');
      assert.ok(await noHScroll(mp));
      await mp.screenshot({ path: path.join(SHOTS, 'phone-toolbar.png') });
      // 全中文标题 → hint about the meaningless address, one tap to fix it
      await gotoEdit(mp, '#/edit?new=post');
      await mp.fill('[data-testid="editor-title"]', '量子力学笔记：谐振子');
      await mp.waitForSelector('[data-testid="editor-slug-hint"]:not([hidden])');
      assert.match(await mp.textContent('[data-testid="editor-slug-hint"]'), /post-\d{8}/);
      await mp.click('[data-testid="editor-slug-hint-edit"]');
      await until(() => mp.evaluate(() => document.activeElement && document.activeElement.dataset.testid === 'editor-slug'), { msg: 'slug input focused' });
      await mp.fill('[data-testid="editor-slug"]', 'harmonic-oscillator');
      await mp.waitForSelector('[data-testid="editor-slug-hint"][hidden]', { state: 'attached' });
      await mp.screenshot({ path: path.join(SHOTS, 'phone-slug-hint.png') });
      await mctx.close();
    });

    await test('layout tools: 多图并排 (gallery) + 带说明的图片 (figure) → preview + Hugo build', async () => {
      await gotoEdit(page, '#/edit?new=post');
      await page.fill('[data-testid="editor-title"]', 'Layout Tools');
      await vditor.insert(page, '排版测试。\n');
      const png1 = await canvasImage(page, { w: 400, h: 300, label: '1' });
      const png2 = await canvasImage(page, { w: 400, h: 300, label: '2' });
      let chooser = page.waitForEvent('filechooser');
      await page.click('[data-testid="editor-body"] .vditor-toolbar [data-type="gallery"]');
      await (await chooser).setFiles([{ name: 'g1.png', mimeType: 'image/png', buffer: png1 }, { name: 'g2.png', mimeType: 'image/png', buffer: png2 }]);
      await until(async () => /\{\{< gallery "admin-pending:\/\/[^"]+g1\.(png|jpg)" "admin-pending:\/\/[^"]+g2\.(png|jpg)" >\}\}/.test(await vditor.get(page)), { msg: 'gallery inserted' });
      chooser = page.waitForEvent('filechooser');
      await page.click('[data-testid="editor-body"] .vditor-toolbar [data-type="figure"]');
      await (await chooser).setFiles([{ name: 'fig.png', mimeType: 'image/png', buffer: png1 }]);
      await page.waitForSelector('.modal input');
      await page.fill('.modal input', '图：谐振子的势能曲线');
      await page.click('.modal .btn-primary');
      await until(async () => /\{\{< figure src="admin-pending:\/\/[^"]+fig\.(png|jpg)" caption="图：谐振子的势能曲线" >\}\}/.test(await vditor.get(page)), { msg: 'figure inserted' });
      // preview renders both with the pending images
      await page.click('[data-testid="editor-preview"]');
      const fr = await (await page.waitForSelector('[data-testid="preview-iframe"][data-state="ready"]', { timeout: 30000 })).contentFrame();
      await until(() => fr.evaluate(() => [...document.querySelectorAll('.gallery img, figure img')].filter((i) => i.complete && i.naturalWidth > 0).length === 3), { msg: 'preview images' });
      assert.equal(await fr.textContent('figcaption'), '图：谐振子的势能曲线');
      await page.click('[data-testid="modal-close"]');
      const commit = await clickAndCommit(page, mock, '[data-testid="editor-publish"]');
      const imgs = commit.changes.map((c) => c.path).filter((p) => p.startsWith('static/images/posts/layout-tools/'));
      assert.equal(imgs.length, 3, 'three images uploaded: ' + imgs.join(', '));
      const body = splitMd(mock.readFile('content/posts/layout-tools.md')).body;
      assert.match(body, /\{\{< gallery "\/images\/posts\/layout-tools\/[^"]+" "\/images\/posts\/layout-tools\/[^"]+" >\}\}/);
      assert.match(body, /\{\{< figure src="\/images\/posts\/layout-tools\/[^"]+" caption="图：谐振子的势能曲线" >\}\}/);
      assert.ok(!/admin-pending|blob:/.test(body));
      const repoDir = mock.exportTo(path.join(OUT, 'export-layout'));
      const out = path.join(OUT, 'build-layout');
      await buildSite({ repoDir, outDir: out });
      const html = fs.readFileSync(path.join(out, 'posts', 'layout-tools', 'index.html'), 'utf8');
      assert.match(html, /class="?gallery/);
      assert.match(html, /<figcaption>[\s\S]*图：谐振子的势能曲线/);
    });

    await test('no page errors, no CSP violations, nothing fetched from other origins', async () => {
      assert.deepEqual(pageErrors, []);
      assert.deepEqual(cspErrors, []);
      assert.deepEqual(blocked.filter((u) => !/\/__mock\//.test(u)), [], 'blocked external requests: ' + blocked.join(', '));
    });
  } finally {
    await browser.close();
    await mock.close();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed. Screenshots: ${SHOTS}`);
  if (failed.length) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
