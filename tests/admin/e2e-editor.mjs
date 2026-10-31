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
  await page.waitForSelector('body[data-view-ready="edit"]', { state: 'attached', timeout: 30000 });
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
