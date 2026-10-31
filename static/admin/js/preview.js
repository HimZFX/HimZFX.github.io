/**
 * preview.js — 文章的「手机预览」渲染（ADMIN_SPEC §6.2 Preview、§6.7）。
 *
 * 流程：Markdown → Vditor.md2html → 在一个「惰性」文档（document.implementation.createHTMLDocument，
 * 不加载图片、不执行脚本）里渲染公式（Vditor.mathRender / KaTeX）和代码高亮（Vditor.highlightRender），
 * 把 {{< gallery … >}} 短代码换成网站同款的图集结构，最后拼成完整 HTML 写进 iframe.srcdoc。
 *
 * 安全（§2.3 例外 b、§2.4）：这是整个后台唯一把 HTML 字符串写进页面的地方，而且只写进
 * sandbox="allow-same-origin"（没有 allow-scripts）的预览 iframe —— 里面的任何脚本都不会运行。
 * 标题 / 简介 / 日期等文字一律先转义。
 *
 * 样式：用网站自己的样式表（第一次预览时 fetch 网站首页，从 HTML 里找出
 * /assets/css/stylesheet.<hash>.css；找不到就用一份简单的内置样式），KaTeX / highlight.js 的样式
 * 用 vendor 目录里的本地副本。
 *
 * @module preview
 */

import { VDITOR_CDN } from './config.js';
import { loadScript, loadStyle } from './ui.js';

// ---------------------------------------------------------------------------
// Vditor 加载（编辑器也用这个函数，保证只加载一次）

let vditorPromise = null;

/**
 * 加载本地的 Vditor（脚本 + 样式），返回全局的 Vditor 构造函数。
 * 失败后允许重试。
 * @returns {Promise<any>}
 */
export function ensureVditor() {
  if (typeof window !== 'undefined' && window.Vditor) return Promise.resolve(window.Vditor);
  if (!vditorPromise) {
    vditorPromise = Promise.all([
      loadStyle(VDITOR_CDN + '/dist/index.css'),
      loadScript(VDITOR_CDN + '/dist/index.min.js'),
      loadIconScript(),
    ]).then(() => {
      if (!window.Vditor) throw new Error('编辑器组件加载失败');
      return window.Vditor;
    }).catch((err) => {
      vditorPromise = null;
      const e = new Error('编辑器组件加载失败，请检查网络后刷新页面重试');
      e.cause = err;
      throw e;
    });
  }
  return vditorPromise;
}

/**
 * Vditor 的工具栏图标（SVG sprite）。Vditor 构造完成后会用「同步 XHR + 内联 <script>」再加载一次
 * 图标脚本，这会被后台的 CSP（禁止内联脚本）拦截；它会先检查 id 为 vditorIconScript 的元素是否存在，
 * 所以这里提前用普通的 <script src> 加载并带上这个 id。
 * 注意 vditor.destroy() 会删除这个元素（但图标 sprite 还留在页面里），所以每次创建编辑器前都要调用：
 * sprite 已经存在时只放一个不会执行的占位元素。
 * @returns {Promise<void>}
 */
export function loadIconScript() {
  const id = 'vditorIconScript';
  if (document.getElementById(id)) return Promise.resolve();
  if (document.getElementById('vditor-icon-bold')) {
    const placeholder = document.createElement('script');
    placeholder.type = 'text/plain'; // 不会执行
    placeholder.id = id;
    document.head.appendChild(placeholder);
    return Promise.resolve();
  }
  return loadScript(VDITOR_CDN + '/dist/js/icons/ant.js', { id }).catch((err) => {
    const e = new Error('图标加载失败');
    e.cause = err;
    throw e;
  });
}

// ---------------------------------------------------------------------------
// 网站样式表

const STYLESHEET_RE = /\/assets\/css\/stylesheet\.[^"'\s>]+\.css/;
const stylesheetCache = new Map(); // siteUrl → Promise<string|null>

/**
 * 找出网站（PaperMod）编译后的样式表地址。网站首页是压缩过的 HTML（属性可能没有引号），
 * 所以只匹配路径本身，再相对网站地址解析。找不到 → null（预览使用内置样式）。
 * @param {string} siteUrl 例如 'https://himzfx.github.io/'
 * @returns {Promise<string|null>}
 */
export function discoverStylesheet(siteUrl) {
  const key = String(siteUrl || '');
  if (!stylesheetCache.has(key)) {
    const p = (async () => {
      try {
        const res = await fetch(key, { credentials: 'same-origin', cache: 'no-store' });
        if (!res.ok) return null;
        const text = await res.text();
        const m = STYLESHEET_RE.exec(text);
        return m ? new URL(m[0], key).href : null;
      } catch {
        return null;
      }
    })();
    stylesheetCache.set(key, p);
    // 失败的结果不永久缓存：下次预览再试一次
    p.then((v) => { if (!v) stylesheetCache.delete(key); });
  }
  return stylesheetCache.get(key);
}

// ---------------------------------------------------------------------------
// 工具

/** HTML 转义（用于拼接 srcdoc 的文字部分）。 */
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** 只允许 http(s)、blob（同源）、站内相对地址作为图片地址。 */
function safeSrc(src) {
  const s = String(src || '').trim();
  if (!s) return null;
  if (/^(https?:|blob:)/i.test(s)) return s;
  if (/^[a-z][a-z0-9+.-]*:/i.test(s)) return null; // javascript: data: 等其他协议
  return s;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 等待 cond() 为真（最多 timeoutMs）。Vditor 的渲染函数是「发起异步加载后立即返回」的。 */
async function waitFor(cond, timeoutMs = 4000) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) return false;
    await sleep(25);
  }
  return true;
}

/** 把 {{< gallery "a.jpg" "b.jpg" >}} 段落替换成网站同款的图集结构（layouts/shortcodes/gallery.html）。 */
function renderGalleries(doc, root) {
  const re = /^\{\{[<%]\s*gallery\s+([\s\S]*?)\s*\/?[>%]\}\}$/;
  for (const p of [...root.querySelectorAll('p')]) {
    const m = re.exec((p.textContent || '').trim());
    if (!m) continue;
    const srcs = [];
    const argRe = /"([^"]*)"|'([^']*)'|(\S+)/g;
    let a;
    while ((a = argRe.exec(m[1]))) srcs.push(a[1] ?? a[2] ?? a[3]);
    const gallery = doc.createElement('div');
    gallery.className = 'gallery';
    for (const src of srcs) {
      const ok = safeSrc(src);
      if (!ok) continue;
      const item = doc.createElement('div');
      item.className = 'gallery-item';
      const img = doc.createElement('img');
      img.setAttribute('src', ok);
      img.setAttribute('alt', 'Gallery Image');
      img.setAttribute('loading', 'lazy');
      item.appendChild(img);
      gallery.appendChild(item);
    }
    p.replaceWith(gallery);
  }
}

/** 去掉预览里用不到 / 不该出现的东西（iframe 本身已禁止脚本，这里只是保持干净）。 */
function scrub(root) {
  root.querySelectorAll('script, .vditor-copy').forEach((el) => el.remove());
  for (const el of root.querySelectorAll('*')) {
    for (const attr of [...el.attributes]) {
      if (/^on/i.test(attr.name)) el.removeAttribute(attr.name);
    }
  }
  for (const img of root.querySelectorAll('img')) {
    const ok = safeSrc(img.getAttribute('src'));
    if (!ok) img.removeAttribute('src');
  }
}

/** 内置的兜底样式（找不到网站样式表时使用），尽量接近 PaperMod 的观感。 */
const FALLBACK_CSS = `
:root{--theme:#fff;--entry:#fff;--primary:#1e1e1e;--secondary:#6c6c6c;--tertiary:#d6d6d6;--content:#1f1f1f;--code-bg:#f5f5f5;--border:#eee}
:root[data-theme=dark]{--theme:#1d1e20;--entry:#2e2e33;--primary:#dadadb;--secondary:#9b9c9d;--tertiary:#414244;--content:#c4c4c5;--code-bg:#37383e;--border:#333}
body{margin:0;background:var(--theme);color:var(--content);font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;font-size:17px;line-height:1.75}
.main{max-width:720px;margin:0 auto;padding:20px 16px}
.post-title{color:var(--primary);font-size:28px;line-height:1.3;margin:0 0 8px}
.post-description{color:var(--secondary);margin-bottom:6px}
.post-meta{color:var(--secondary);font-size:14px}
.post-content h1,.post-content h2,.post-content h3{color:var(--primary);line-height:1.35}
.post-content img{max-width:100%;border-radius:6px}
.post-content pre{background:var(--code-bg);padding:12px;border-radius:8px;overflow:auto}
.post-content code{background:var(--code-bg);padding:1px 4px;border-radius:4px}
.post-content pre code{background:none;padding:0}
.post-content blockquote{margin:0;padding:0 14px;border-left:3px solid var(--tertiary);color:var(--secondary)}
.post-content table{border-collapse:collapse;display:block;overflow:auto}
.post-content th,.post-content td{border:1px solid var(--tertiary);padding:4px 10px}
a{color:inherit}
`;

/** 预览专用的少量修正：手机宽度下不留太大边距、公式块可横向滚动、图集排版。 */
const PREVIEW_CSS = `
html,body{overflow-x:hidden}
body{min-height:100vh}
.main{padding-top:18px;padding-bottom:40px}
.post-header{margin-bottom:18px}
.post-cover{margin:0 0 18px}
.post-cover img{width:100%;border-radius:8px;display:block}
.post-content .katex-display{overflow-x:auto;overflow-y:hidden;padding:2px 0}
.post-content .language-math.vditor-reset--error{color:#f54a45}
.post-content img{max-width:100%;height:auto}
.post-content iframe{max-width:100%}
.gallery{display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:8px;margin:1em 0}
.gallery-item img{width:100%;height:100%;object-fit:cover;border-radius:6px;display:block}
.preview-empty{color:#999;font-style:italic}
`;

// ---------------------------------------------------------------------------
// 主函数

/**
 * 在 iframe 里渲染文章预览（PaperMod 文章页的结构）。
 *
 * @param {HTMLIFrameElement} iframe 必须带 sandbox="allow-same-origin"（不能有 allow-scripts）
 * @param {{ title?: string, date?: string, description?: string, markdown?: string, dark?: boolean,
 *           lang?: string, imageMap?: Record<string,string>|Map<string,string>, cover?: string,
 *           siteUrl?: string }} opts
 *   - imageMap：渲染前在 Markdown 里做的地址替换（例如 'admin-pending://a.jpg' → blob 地址）
 *   - cover（扩展）：封面图地址；siteUrl（扩展）：网站地址，默认 location.origin + '/'
 * @returns {Promise<void>} iframe 的内容写入后 resolve（不等待图片加载）
 */
export async function renderPreview(iframe, {
  title = '', date = '', description = '', markdown = '', dark = false, lang = 'zh', imageMap = null,
  cover = '', siteUrl,
} = {}) {
  if (!iframe) throw new TypeError('renderPreview: iframe is required');
  // 防御：确保预览 iframe 不能运行脚本
  const sb = iframe.getAttribute('sandbox');
  if (sb === null || /allow-scripts/.test(sb)) iframe.setAttribute('sandbox', 'allow-same-origin');

  const site = siteUrl || (location.origin + '/');
  const Vditor = await ensureVditor();

  let md = String(markdown || '');
  if (imageMap) {
    const entries = imageMap instanceof Map ? [...imageMap.entries()] : Object.entries(imageMap);
    for (const [from, to] of entries) if (from) md = md.split(from).join(to);
  }

  const mathOpts = { engine: 'KaTeX', inlineDigit: true };
  const hljsStyle = dark ? 'github-dark' : 'github';
  const [html, stylesheet] = await Promise.all([
    md.trim() ? Vditor.md2html(md, { cdn: VDITOR_CDN, math: mathOpts }) : Promise.resolve(''),
    discoverStylesheet(site),
  ]);

  // 惰性文档：在这里解析的 HTML 不会加载资源、不会执行任何脚本
  const doc = document.implementation.createHTMLDocument('preview');
  const root = doc.createElement('div');
  root.innerHTML = html; // eslint-disable-line no-unsanitized/property -- inert document, see header (§2.3 b)
  doc.body.appendChild(root);

  renderGalleries(doc, root);

  // 公式
  const mathEls = () => [...root.querySelectorAll('.language-math')];
  if (mathEls().length) {
    try {
      Vditor.mathRender(root, { cdn: VDITOR_CDN, math: mathOpts });
      await waitFor(() => mathEls().every((el) => el.hasAttribute('data-math')), 6000);
    } catch (err) {
      console.warn('[preview] math render failed', err);
    }
  }
  // 代码高亮
  const codeEls = () => [...root.querySelectorAll('pre > code')].filter((c) => !/language-(mermaid|echarts|mindmap|plantuml|graphviz|flowchart|abc|markmap|smiles)/.test(c.className));
  if (codeEls().length) {
    try {
      Vditor.highlightRender({ style: hljsStyle, enable: true, lineNumber: false }, root, VDITOR_CDN);
      await waitFor(() => codeEls().every((c) => c.classList.contains('hljs')), 4000);
    } catch (err) {
      console.warn('[preview] highlight failed', err);
    }
  }
  scrub(root);

  const coverSrc = safeSrc(cover);
  const contentHtml = root.innerHTML.trim() || '<p class="preview-empty">（正文还是空的）</p>';
  const katexCss = VDITOR_CDN + '/dist/js/katex/katex.min.css';
  const hljsCss = `${VDITOR_CDN}/dist/js/highlight.js/styles/${hljsStyle}.min.css`;
  const theme = dark ? 'dark' : 'light';

  const out = '<!doctype html>' +
    `<html lang="${esc(lang)}" data-theme="${theme}"><head><meta charset="utf-8">` +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    `<base href="${esc(site)}">` +
    (stylesheet ? `<link rel="stylesheet" href="${esc(stylesheet)}">` : `<style>${FALLBACK_CSS}</style>`) +
    `<link rel="stylesheet" href="${esc(katexCss)}">` +
    `<link rel="stylesheet" href="${esc(hljsCss)}">` +
    `<style>${PREVIEW_CSS}</style>` +
    `</head><body class="${dark ? 'dark' : ''}">` +
    '<main class="main"><article class="post-single">' +
    '<header class="post-header">' +
    `<h1 class="post-title">${esc(title || '（未填写标题）')}</h1>` +
    (description ? `<div class="post-description">${esc(description)}</div>` : '') +
    (date ? `<div class="post-meta">${esc(date)}</div>` : '') +
    '</header>' +
    (coverSrc ? `<figure class="entry-cover post-cover"><img src="${esc(coverSrc)}" alt=""></figure>` : '') +
    `<div class="post-content">${contentHtml}</div>` +
    '</article></main></body></html>';

  await new Promise((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    iframe.addEventListener('load', finish, { once: true });
    setTimeout(finish, 3000);
    iframe.srcdoc = out; // §2.3 例外 b：只写进无脚本的沙箱 iframe
  });
}
