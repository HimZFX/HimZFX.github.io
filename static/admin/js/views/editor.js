/**
 * views/editor.js — 文章 / 页面编辑器（ADMIN_SPEC §6.2）。
 *
 * 路由：
 *   #/edit?path=<仓库路径>         打开已有文件（同一页面的所有语言版本作为标签页）
 *   #/edit?new=post                写新文章（共用版本 content/posts/<文件名>.md）
 *   #/edit?new=page&dir=<目录>     新建栏目首页（<目录>/_index.md）
 *   #/edit?draft=<草稿 key>        继续编辑一份本机草稿（drafts.js）
 *
 * 数据模型：一个「页面组」（content.groupPages）的每个版本（共用 / 中文专属 / 英文专属）是一个 variant，
 * 各自保存：原始 front matter 文本（fmText，保存时用 frontmatter.setFields 只改动变化的键，注释原样保留）、
 * 原始正文（rawBody，没改正文时原样写回，保证字节级不变）、表单字段（form / baseForm）、编辑中的 Markdown。
 *
 * 图片：粘贴 / 拖入 / 上传的图片先压缩，以 Blob 形式留在内存（media），编辑器里用 blob: 地址显示；
 * 保存时把 blob 地址换成网站路径 /images/posts/<文件名>/<图片名>，图片和文章在同一次提交里上传。
 * 本机自动保存时 blob 地址换成 admin-pending://<图片名> 占位，图片 Blob 一起存进 IndexedDB。
 *
 * 安全（§2.3）：界面全部用 h() / textContent 生成；正文 HTML 只由 Vditor 自己渲染（例外 c），
 * 预览只写进无脚本的沙箱 iframe（preview.js，例外 b）。
 *
 * @module views/editor
 */

import {
  h, svgIcon, render, toast, modal, confirmDialog, promptDialog, debounce, withBusy, errorMessage, loadingState,
  errorState, formatDate, formatBytes, badge,
} from '../ui.js';
import { VDITOR_CDN, PATHS, LIMITS } from '../config.js';
import * as C from '../content.js';
import {
  splitDocument, parseFrontMatter, setFields, buildDocument, newFrontMatter, FrontMatterError,
} from '../frontmatter.js';
import { compressImage, timestampName, safeFileName, extOf } from '../images.js';
import * as drafts from '../drafts.js';
import { parseToml } from '../tomlpatch.js';
import { renderPreview, ensureVditor, loadIconScript, VDITOR_MARKDOWN } from '../preview.js';

// ---------------------------------------------------------------------------
// 常量

const PENDING = 'admin-pending://';
const IMAGE_EXTS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'avif', 'bmp', 'heic', 'heif']);
const MB = 1024 * 1024;

/**
 * 本次会话里刚上传过的图片：网站路径 → Blob。
 * 发表后网站要 1–2 分钟才会部署好，这期间重新打开文章时，用这里的 Blob 显示图片（而不是一张裂图）。
 */
const recentUploads = new Map();

// 工具栏自定义按钮的图标（写死的 SVG 字符串，ADMIN_SPEC §2.3 例外 a）
const ICON_FORMULA = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 5H7l6 7-6 7h11"/></svg>';
const ICON_DOCS = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="M12 17v-6M9.5 13.5L12 11l2.5 2.5"/></svg>';

const ICON_GALLERY = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="8" height="7" rx="1"/><rect x="13" y="4" width="8" height="7" rx="1"/><rect x="3" y="13" width="8" height="7" rx="1"/><rect x="13" y="13" width="8" height="7" rx="1"/></svg>';
const ICON_FIGURE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="13" rx="2"/><path d="M3 13l5-4 4 3 3-2 6 4"/><path d="M7 20h10"/></svg>';

// 荧光笔（高亮）
const ICON_MARK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 11-6 6v3h9l3-3"/><path d="m22 12-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4"/></svg>';

const pad2 = (n) => String(n).padStart(2, '0');

// ---------------------------------------------------------------------------
// 高亮（==文字==）：在编辑区 DOM 里放 <mark>（toggleMark / planMark 用）

/** 高亮可以挪到它外面的行内格式（加粗、斜体、删除线、链接）。 */
const MARK_LIFT = new Set(['STRONG', 'B', 'EM', 'I', 'S', 'DEL', 'A']);
const MARK_WS = /[\s​]/;
const MARK_PUNCT = /[\p{P}\p{S}]/u;

/** node 在 top 里的位置（每一层的子节点序号）；node 不在 top 里时返回 null。 */
function nodePath(node, top) {
  const p = [];
  for (let n = node; n !== top; n = n.parentNode) {
    if (!n || !n.parentNode) return null;
    p.unshift(Array.prototype.indexOf.call(n.parentNode.childNodes, n));
  }
  return p;
}
function nodeAt(top, path) {
  let n = top;
  for (const i of path) n = n.childNodes[i];
  if (!n) throw new Error('node not found');
  return n;
}
const blankText = (n) => n.nodeType === 3 && !n.data.replace(/​/g, '');

/** 选区两头（文字节点里）符合 test 的字符不包进高亮。 */
function trimRangeEdges(range, test) {
  while (!range.collapsed && range.startContainer.nodeType === 3 && range.startOffset < range.startContainer.length &&
    test(range.startContainer.data[range.startOffset])) range.setStart(range.startContainer, range.startOffset + 1);
  while (!range.collapsed && range.endContainer.nodeType === 3 && range.endOffset > 0 &&
    test(range.endContainer.data[range.endOffset - 1])) range.setEnd(range.endContainer, range.endOffset - 1);
}

/** 选区正好从加粗 / 链接……的开头开始（或在结尾结束）时，把选区扩到这个格式外面。 */
function liftRange(range, top) {
  for (;;) {
    const c = range.startContainer;
    const o = range.startOffset;
    if (c.nodeType === 3) {
      if (c.data.slice(0, o).replace(/​/g, '')) break;
      range.setStartBefore(c);
      continue;
    }
    if (![...c.childNodes].slice(0, o).every(blankText) || c === top || !MARK_LIFT.has(c.nodeName)) break;
    range.setStartBefore(c);
  }
  for (;;) {
    const c = range.endContainer;
    const o = range.endOffset;
    if (c.nodeType === 3) {
      if (c.data.slice(o).replace(/​/g, '')) break;
      range.setEndAfter(c);
      continue;
    }
    if (![...c.childNodes].slice(o).every(blankText) || c === top || !MARK_LIFT.has(c.nodeName)) break;
    range.setEndAfter(c);
  }
}

/** top 里 node 前面（before = true）/ 后面紧挨着的一个字符（不算零宽空格）。 */
function charBeside(node, top, before) {
  const r = node.ownerDocument.createRange();
  if (before) { r.setStart(top, 0); r.setEndBefore(node); } else { r.setStartAfter(node); r.setEnd(top, top.childNodes.length); }
  const s = r.toString().replace(/​/g, '');
  return before ? s.slice(-1) : s.slice(0, 1);
}

/**
 * 源码 / 即时渲染模式：给选中的文字 text 加上 ==，按顺序列出几种写法（原样 → 两头的标点放到 == 外面 →
 * 把选区两边的 ** / * / ~~ 也包进来 → 在需要的一侧加空格），由调用方用 Lute 挑第一种认得出的
 * （原因见 Editor#planMark）。prev / next = 选区前后同一行的文字。
 * 返回 [{ value, spaced, lift }]：lift = 选区两边各要多换掉几个字符（包进来的格式符号）。
 */
export function markTextCandidates(text, prev = '', next = '') {
  const lead = /^\s*/.exec(text)[0];
  const rest = text.slice(lead.length);
  const tail = /\s*$/.exec(rest)[0];
  const core0 = rest.slice(0, rest.length - tail.length);
  if (!core0) return [];
  // 标点（Markdown 的格式符号除外：** ` [ ] 这些是格式本身，不能挪到 == 外面）
  const plainPunct = (c) => MARK_PUNCT.test(c) && !/[*_~=`$[\]()<>!#|\\]/.test(c);
  const out = [];
  // 选区正好在 **粗体** 里面：可以把两边的 ** 也包进来（==**粗体**==）
  const run = !lead && !tail && /(\*{1,3}|_{1,3}|~~)$/.exec(prev);
  const lifted = run && next.startsWith(run[1]) ? run[1] : '';
  for (const [before, after] of [[false, false], [true, false], [false, true], [true, true]]) {
    for (const [lift, trim] of [[false, false], [false, true], [true, false], [true, true]]) {
      if (lift && !lifted) continue;
      const w = lift ? lifted : '';
      let core = [...core0];
      let l = '';
      let r = '';
      if (trim) {
        while (core.length > 1 && (plainPunct(core[0]) || /\s/.test(core[0]))) l += core.shift();
        while (core.length > 1 && (plainPunct(core[core.length - 1]) || /\s/.test(core[core.length - 1]))) r = core.pop() + r;
        if (!l && !r) continue;
      }
      const left = prev.slice(0, prev.length - w.length) + lead + l;
      const right = r + tail + next.slice(w.length);
      const padL = before && left && !/\s$/.test(left) ? ' ' : '';
      const padR = after && right && !/^\s/.test(right) ? ' ' : '';
      if ((before && !padL) || (after && !padR)) continue;
      out.push({ value: `${lead}${l}${padL}==${w}${core.join('')}${w}==${padR}${r}${tail}`, spaced: !!(padL || padR), lift: w.length });
    }
  }
  return out;
}

/** 把选区的两头各向外扩 n 个字符（按 root 里文字节点的顺序数）。 */
function shiftRange(range, root, n) {
  const doc = root.ownerDocument;
  const offsetOf = (node, off) => { const r = doc.createRange(); r.setStart(root, 0); r.setEnd(node, off); return r.toString().length; };
  const s = offsetOf(range.startContainer, range.startOffset) - n;
  const e = offsetOf(range.endContainer, range.endOffset) + n;
  const tw = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let pos = 0;
  let gotStart = false;
  for (let t; (t = tw.nextNode());) {
    const len = t.data.length;
    if (!gotStart && s <= pos + len) { range.setStart(t, Math.max(0, s - pos)); gotStart = true; }
    if (gotStart && e <= pos + len) { range.setEnd(t, Math.max(0, e - pos)); return; }
    pos += len;
  }
}

/** 元素自己的 HTML（交给 Lute 转 Markdown；只读取，不往页面里写 HTML）。 */
function htmlOf(el) {
  return new XMLSerializer().serializeToString(el).replace(/^(<[\w-]+) xmlns="http:\/\/www\.w3\.org\/1999\/xhtml"/, '$1');
}

/**
 * md 用 Lute 渲染后的「指纹」：<mark> 个数、全部文字、加粗 / 斜体 / 删除线 / 链接 / 代码 / 公式里的文字。
 * HTML 在 DOMParser 的独立文档里解析（不显示、不加载图片、不执行脚本）。
 */
function markSignature(lute, md) {
  const body = new DOMParser().parseFromString(`<body>${lute.Md2HTML(md)}</body>`, 'text/html').body;
  const txt = (n) => n.textContent.replace(/[\s​]/g, '');
  const by = (sel) => [...body.querySelectorAll(sel)].map(txt).join('');
  return {
    marks: body.querySelectorAll('mark').length,
    text: txt(body),
    fmt: ['strong, b', 'em, i', 's, del', 'a', 'code', '.language-math'].map(by).join('\u0001'),
  };
}
/** after 比 before 正好多一个高亮，文字和其他格式都没变（没有露出 == / **，加粗也没丢）。 */
const sameMarkSignature = (before, after) =>
  after.marks === before.marks + 1 && after.text === before.text && after.fmt === before.fmt;

/**
 * 按 plan 把选区包成 <mark data-marker="==">（选区两头的空格总是不包进去：== 文字 == 不算高亮）。
 * plan.trim = 两头的标点也不包；plan.lift = 挪到加粗 / 链接等格式外面；plan.before / after = 在这一侧
 * 加一个空格（旁边是文字时）。实际加了空格时设 plan.spaced = true。返回 mark；没有可包的文字时返回 null。
 */
function applyMarkPlan(range, plan, top) {
  const isWs = (c) => MARK_WS.test(c);
  trimRangeEdges(range, isWs);
  if (plan.trim) trimRangeEdges(range, (c) => isWs(c) || MARK_PUNCT.test(c));
  if (plan.lift) liftRange(range, top);
  if (range.collapsed || !range.toString().replace(/[\s​]/g, '')) return null;
  const doc = top.ownerDocument;
  const mark = doc.createElement('mark');
  mark.setAttribute('data-marker', '==');
  mark.appendChild(range.extractContents());
  range.insertNode(mark);
  for (const side of ['before', 'after']) {
    if (!plan[side]) continue;
    const c = charBeside(mark, top, side === 'before');
    if (!c || isWs(c)) continue;
    mark.parentNode.insertBefore(doc.createTextNode(' '), side === 'before' ? mark : mark.nextSibling);
    plan.spaced = true;
  }
  return mark;
}

/** 短代码参数（"…" 里）不能有 " 和换行。 */
const scArg = (s) => String(s ?? '').replace(/[\r\n]+/g, ' ').replace(/"/g, '“').trim();

/** Date → 'YYYY-MM-DDTHH:mm:ss+08:00'（使用浏览器的时区偏移）。 */
function hugoDate(d = new Date()) {
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const abs = Math.abs(off);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}` +
    `${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`;
}

/** front matter 里的日期字符串 → datetime-local 输入框的值（本地时间）；无法解析 → ''。 */
function toLocalInput(s) {
  const str = String(s || '').trim();
  if (!str) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(str);
  if (m) return `${m[1]}-${m[2]}-${m[3]}T00:00`;
  const d = new Date(str);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

const isPlainObject = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
const str = (v) => (v == null ? '' : typeof v === 'string' ? v : String(v));
const strList = (v) => (Array.isArray(v) ? v.map(str).filter(Boolean) : typeof v === 'string' && v ? [v] : []);
const clone = (v) => JSON.parse(JSON.stringify(v ?? null));
const sameList = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

/** Go 模板 `if .Param "math"` 的真假判断（字符串非空即为真）。 */
function goTruthy(v) {
  if (v == null) return false;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') return v !== '';
  return true;
}

/** 只允许 http(s)、blob、站内路径作为 img src（防止仓库内容里写 javascript: 之类的地址）。 */
function safeUrl(u, siteUrl) {
  const s = String(u || '').trim();
  if (!s) return null;
  if (/^(https?:|blob:)/i.test(s)) return s;
  if (/^[a-z][a-z0-9+.-]*:/i.test(s)) return null;
  try { return new URL(s.replace(/^\/+/, ''), siteUrl).href; } catch { return null; }
}

function isImageFile(file) {
  return (file.type || '').startsWith('image/') || IMAGE_EXTS.has(extOf(file.name || ''));
}

/** 文件名去掉扩展名（用作图片的替代文字）。 */
function stemOf(name) {
  const n = String(name || '').replace(/^.*[\\/]/, '');
  const i = n.lastIndexOf('.');
  return (i > 0 ? n.slice(0, i) : n) || 'image';
}

/** Markdown 链接文字里的 [ ] 会破坏语法。 */
const linkText = (s) => String(s || '').replace(/[[\]\n\r]/g, ' ').trim() || '文件';

/**
 * 网站路径 → Markdown 链接 / 图片地址：把会破坏 Markdown 语法或网址的字符按段编码
 * （空格、#、?、%、括号、尖括号、引号…）。中文等非 ASCII 字符保持原样（Hugo 输出时会自动编码）。
 * 已经是 %XX 的编码不会重复编码。
 */
function mdDest(sitePath) {
  return String(sitePath || '').replace(/%(?![0-9A-Fa-f]{2})|[\s#?()<>[\]"'\\^`{}|]/g,
    (c) => (c === ' ' ? '%20' : encodeURIComponent(c).replace(/[()'!*]/g, (x) => `%${x.charCodeAt(0).toString(16).toUpperCase()}`)));
}

/** Markdown 链接地址里出现「% 后面不是两位十六进制」会让 Hugo 构建失败（invalid URL escape）。 */
function badPercentLinks(md) {
  const bad = [];
  const re = /\]\(\s*<?([^)\s>]*)|^\s{0,3}\[[^\]]+\]:\s*<?(\S+?)>?(?:\s|$)/gm;
  let m;
  while ((m = re.exec(md))) {
    const dest = m[1] ?? m[2] ?? '';
    if (/%(?![0-9A-Fa-f]{2})/.test(dest)) bad.push(dest);
  }
  return bad;
}

/**
 * 编辑区里不允许真正加载的嵌入元素（ADMIN_SPEC §2.3 例外 c 的收紧）：
 * 文章里的 <iframe src="/某个网页"> 如果在后台里真的加载，那个同源网页里的脚本就能读到登录令牌。
 * Vditor（Lute）生成的编辑区 HTML 在写进页面之前经过这里，这些标签被换成不会加载任何东西的占位 <span>。
 * 只改「显示」用的 HTML：Markdown 原文由 Lute 从源码块（已转义的文字）还原，保存时不受影响。
 */
const EMBED_TAGS = 'iframe|frame|frameset|object|embed|portal|fencedframe|meta|base|link|style';
const EMBED_TEST_RE = new RegExp(`<\\/?(?:${EMBED_TAGS})\\b`, 'i');
const EMBED_RE = new RegExp(`<(\\/?)(${EMBED_TAGS})\\b[^>]*>`, 'gi');
const VOID_EMBEDS = new Set(['embed', 'meta', 'base', 'link']);
export function neutralizeEmbeds(html) {
  if (typeof html !== 'string' || !EMBED_TEST_RE.test(html)) return html;
  return html.replace(EMBED_RE, (m, close, tag) => {
    const t = tag.toLowerCase();
    if (close) return VOID_EMBEDS.has(t) ? '' : '</span>';
    const open = `<span class="ed-embed-blocked" data-tag="${t}" contenteditable="false">`;
    return VOID_EMBEDS.has(t) ? `${open}</span>` : open;
  });
}
/** Lute 里所有「输出 HTML」的方法（编辑区三种模式 + 预览面板 + 粘贴）。 */
const LUTE_HTML_METHODS = [
  'Md2VditorDOM', 'SpinVditorDOM', 'HTML2VditorDOM',
  'Md2VditorIRDOM', 'SpinVditorIRDOM', 'HTML2VditorIRDOM',
  'Md2VditorSVDOM', 'SpinVditorSVDOM',
  'Md2HTML', 'VditorDOM2HTML', 'VditorIRDOM2HTML',
];

// ---------------------------------------------------------------------------
// 正文的「三方合并」：Vditor 会把整篇 Markdown 重新整理一遍（去掉行尾两个空格的换行、{#id}、
// 链接标题、把 *** 改成 --- …）。保存时只把用户真正改过的行换成 Vditor 的输出，没改过的行保留文件原文。

/** 两个字符串数组的最长公共子序列 → a 中每一行对应 b 的行号（没有对应为 -1）。太大时返回 null。 */
function lcsMap(a, b) {
  const map = new Int32Array(a.length).fill(-1);
  let s = 0;
  while (s < a.length && s < b.length && a[s] === b[s]) { map[s] = s; s++; }
  let ea = a.length;
  let eb = b.length;
  while (ea > s && eb > s && a[ea - 1] === b[eb - 1]) { ea--; eb--; map[ea] = eb; }
  const n = ea - s;
  const m = eb - s;
  if (n === 0 || m === 0) return map;
  if (n * m > 6e6) return null;
  // dp[i][j] = a[s+i..ea) 与 b[s+j..eb) 的 LCS 长度
  const W = m + 1;
  const dp = new Uint32Array((n + 1) * W);
  for (let i = n - 1; i >= 0; i--) {
    const ai = a[s + i];
    for (let j = m - 1; j >= 0; j--) {
      dp[i * W + j] = ai === b[s + j] ? dp[(i + 1) * W + j + 1] + 1 : Math.max(dp[(i + 1) * W + j], dp[i * W + j + 1]);
    }
  }
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[s + i] === b[s + j]) { map[s + i] = s + j; i++; j++; } else if (dp[(i + 1) * W + j] >= dp[i * W + j + 1]) i++; else j++;
  }
  return map;
}

const sameLines = (x, y) => x.length === y.length && x.every((l, i) => l === y[i]);

/**
 * 三方合并（按行）：base = 打开时 Vditor 整理过的正文，ours = 现在编辑器里的正文，theirs = 文件原文。
 * 用户没改的区域用原文；改过的区域用编辑器的结果。合并不了（太大 / 有重叠的改动）→ null。
 */
export function mergeBody(base, ours, theirs) {
  // 文末的空行不重要（保存时会统一成一个换行），先去掉，免得和最后一行的修改搅在一起
  const trim = (x) => String(x).replace(/\s+$/, '');
  base = trim(base);
  ours = trim(ours);
  theirs = trim(theirs);
  const r = merge3(base, ours, theirs);
  if (r !== null) return r + '\n';
  // Vditor 在每次编辑后会把引用链接 / 脚注的定义（[ref]: … / [^1]: …）挪到文末，和原文的位置对不上。
  // 如果用户没有改这些定义，就先把它们从 base / ours 里拿掉再合并（原文里的定义原样保留）。
  const o = stripDefs(base);
  const a = stripDefs(ours);
  if (!o.defs.length || o.defs.join('\n\n') !== a.defs.join('\n\n')) return null;
  const r2 = merge3(o.text, a.text, theirs);
  return r2 === null ? null : r2 + '\n';
}

const DEF_RE = /^ {0,3}\[\^?[^\]\n]+\]:/;
/** 去掉 Vditor 输出里的链接 / 脚注定义行（连同脚注的缩进续行），返回剩下的文字和排好序的定义。 */
function stripDefs(text) {
  const lines = text.split('\n');
  const keep = [];
  const defs = [];
  for (let i = 0; i < lines.length; i++) {
    if (DEF_RE.test(lines[i])) {
      const blk = [lines[i]];
      while (i + 1 < lines.length && /^(?: {4}|\t)/.test(lines[i + 1])) blk.push(lines[++i]);
      defs.push(blk.join('\n').replace(/\s+$/, ''));
      continue;
    }
    // 拿掉定义后留下的连续空行合成一行（base 和 ours 用同样的处理，不影响比较）
    if (lines[i] === '' && keep.length && keep[keep.length - 1] === '') continue;
    keep.push(lines[i]);
  }
  return { text: keep.join('\n').replace(/\s+$/, ''), defs: defs.sort() };
}

function merge3(base, ours, theirs) {
  const O = base.split('\n');
  const A = ours.split('\n');
  const B = theirs.split('\n');
  const mA = lcsMap(O, A);
  const mB = lcsMap(O, B);
  if (!mA || !mB) return null;
  const out = [];
  let o = 0;
  let a = 0;
  let b = 0;
  let conflict = false;
  const flush = (o1, a1, b1) => {
    const oc = O.slice(o, o1);
    const ac = A.slice(a, a1);
    const bc = B.slice(b, b1);
    if (sameLines(oc, ac)) out.push(...bc);
    else if (sameLines(oc, bc) || sameLines(ac, bc)) out.push(...ac);
    else if (oc.length === ac.length && oc.length === bc.length && oc.every((l, k) => ac[k] === l || bc[k] === l)) {
      // 同一段里两边都有变化，但每一行只有一边改过：逐行取（没改的行用原文，改过的行用编辑器的）
      for (let k = 0; k < oc.length; k++) out.push(ac[k] === oc[k] ? bc[k] : ac[k]);
    } else conflict = true;
  };
  for (let i = 0; i < O.length; i++) {
    const j = mA[i];
    const k = mB[i];
    if (j < a || k < b || j < 0 || k < 0) continue;
    flush(i, j, k);
    out.push(A[j]);
    o = i + 1;
    a = j + 1;
    b = k + 1;
  }
  flush(O.length, A.length, B.length);
  // 用户改的地方和 Vditor 整理过的地方重叠（例如移动过位置的引用链接）：
  // 拼起来可能丢行或重复，宁可整篇用编辑器的结果（格式可能有小变化，但内容完整）
  return conflict ? null : out.join('\n');
}

// ---------------------------------------------------------------------------
// 入口

/**
 * @param {HTMLElement} container
 * @param {Record<string,string>} params
 * @param {object} ctx
 */
export default async function mount(container, params, ctx) {
  container.classList.add('editor-view');
  render(container, h('div', { class: 'card ed-loading' }, loadingState('正在打开编辑器…')));
  const ed = new Editor(container, params || {}, ctx);
  try {
    await ed.init();
  } catch (err) {
    console.error('[editor] open failed', err);
    if (err && err.status === 401) throw err; // 交给外壳处理登录失效
    ed.destroy();
    ed.renderFatal(err && err.userTitle ? err.userTitle : '没能打开这篇内容', errorMessage(err));
    return {};
  }
  return {
    unmount: () => ed.destroy(),
    canLeave: () => ed.canLeave(),
    isDirty: () => ed.isDirty(),
  };
}

function userError(title, message) {
  const e = new Error(message);
  e.userTitle = title;
  return e;
}

// ---------------------------------------------------------------------------

class Editor {
  constructor(container, params, ctx) {
    this.container = container;
    this.params = params;
    this.ctx = ctx;
    this.repo = ctx.repo;
    this.langs = ctx.langs && ctx.langs.length ? ctx.langs : ['zh', 'en'];
    /** @type {Map<string, any>} 'shared' | 'zh' | 'en' → variant */
    this.variants = new Map();
    this.activeKey = null;
    this.kind = 'post';               // 'post' | 'page'
    this.isNewGroup = false;          // 还没保存过的新文章 / 新页面
    this.group = null;                // { key, dir, base, isIndex, variants }
    this.slug = { value: '', touched: false };
    this.newKey = null;               // 新文章的草稿 key（new:…）
    this.orphanDrafts = [];           // 尚不存在的语言版本的本机草稿
    /** @type {Map<string, { blob: Blob, url: string|null, kind: 'image'|'doc', committed: boolean }>} */
    this.media = new Map();
    this.urlToName = new Map();
    /** 仓库路径 → Blob：网站上还打不开、从仓库读出来的图片 */
    this.repoImageCache = new Map();
    /** 封面图网站路径 → Blob（同上） */
    this.coverBlobs = new Map();
    this.vd = null;
    this.els = {};
    this.destroyed = false;
    this.leaving = false;
    this.saving = false;
    this.autosaveOk = true;
    this.lastAutosave = null;
    this.siteDefaults = { math: true, comments: false, effect: '' };
    this.effects = [];
    this.effectNames = {};
    this.autosave = debounce(() => { this.autosaveNow(); }, 1000);
    this.onKeyDown = this.onKeyDown.bind(this);
    this.onHidden = (e) => { if (e.type === 'pagehide' || document.visibilityState === 'hidden') this.flushAutosave(); };
    this.mq = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null;
    this.phone = typeof matchMedia === 'function' && matchMedia('(max-width: 760px)').matches;
    /** 这个编辑器实例的标识：写进本机草稿，发表后只删除自己写的 / 打开前就有的草稿（另一个标签页的不删）。 */
    this.writerId = Math.random().toString(36).slice(2) + Date.now().toString(36);
    this.openedAt = Date.now();
    // 另一个标签页发表了同一篇文章、删掉了本机草稿时，通知这边立刻把自己的修改重新存一遍
    try {
      this.channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel('admin-editor-drafts') : null;
      if (this.channel) this.channel.onmessage = (e) => this.onDraftMessage(e.data);
    } catch { this.channel = null; }
  }

  onDraftMessage(d) {
    if (this.destroyed || !d || d.type !== 'draft-removed' || d.writer === this.writerId) return;
    let any = false;
    for (const v of this.variants.values()) {
      if (v.draftKey === d.key && !v.localDraft && this.variantDirty(v)) { v.needsAutosave = true; any = true; }
    }
    if (any) this.flushAutosave();
  }

  // =========================================================================
  // 打开

  async init() {
    const p = this.params;
    const [defaults] = await Promise.all([this.readSiteDefaults(), ensureVditor()]);
    this.siteDefaults = defaults;
    this.effects = this.repo.list(PATHS.effects + '/')
      .map((e) => e.path.slice(PATHS.effects.length + 1))
      .filter((n) => n.endsWith('.js') && !n.includes('/'))
      .map((n) => n.slice(0, -3));
    this.collectBases();

    let autoRestore = null;
    if (p.draft) {
      const rec = await drafts.loadDraft(p.draft);
      if (!rec) throw userError('找不到这份本机草稿', '它可能已经发表、被丢弃，或者是在另一台设备 / 另一个浏览器里保存的。');
      const f = rec.fields || {};
      const draftPath = p.draft.startsWith('file:') ? p.draft.slice(5) : '';
      const groupExists = draftPath && C.groupPages(this.repo.list(PATHS.content + '/'), this.langs)
        .some((g) => Object.values(g.variants).length && g.key === this.groupKeyOf(draftPath));
      if (draftPath && groupExists) {
        autoRestore = rec;
        await this.openPath(draftPath);
      } else if (draftPath && !(f.newGroup && f.kind === 'page')) {
        throw userError('这份草稿对应的文件已经不存在了', `「${draftPath}」可能已经被删除或改名。可以在「文章」列表里丢弃这份本机草稿。`);
      } else {
        this.openNewFromDraft(p.draft, rec);
        await this.checkPublishedTwin(rec);
      }
    } else if (p.path) {
      await this.openPath(p.path);
    } else if (p.new === 'page') {
      const dir = this.normalizeDir(p.dir);
      const index = `${dir}/_index.md`;
      if (this.repo.has(index)) {
        await this.openPath(index);
      } else {
        this.openNewPage(dir);
      }
    } else {
      this.openNewPost();
    }

    this.buildLayout();
    await this.createVditor();
    if (this.destroyed) return;
    this.activate(this.activeKey, { initial: true });
    if (autoRestore) {
      const v = this.variants.get(this.keyForPath(autoRestore.path || p.draft.slice(5)));
      if (v && v.localDraft) this.applyDraft(v, v.localDraft, { silent: true });
      else {
        const o = this.orphanDrafts.find((d) => d.key === p.draft);
        if (o) this.restoreOrphan(o);
      }
    }
    document.addEventListener('keydown', this.onKeyDown, true);
    document.addEventListener('visibilitychange', this.onHidden);
    window.addEventListener('pagehide', this.onHidden);
    this.ctx.setTitle(this.isNewGroup ? (this.kind === 'post' ? '写新文章' : '新建页面') : (this.kind === 'post' ? '编辑文章' : '编辑页面'));
    this.loadEffectNames();
    this.leaving = false;
  }

  /** params.toml 里的全站默认值（数学公式 / 评论区 / 背景效果）。 */
  async readSiteDefaults() {
    const out = { math: true, comments: false, effect: '' };
    try {
      if (!this.repo.has(PATHS.params)) return out;
      const cfg = parseToml(await this.repo.readText(PATHS.params));
      if (cfg.math !== undefined) out.math = goTruthy(cfg.math);
      if (cfg.comments !== undefined) out.comments = goTruthy(cfg.comments);
      if (cfg.background && typeof cfg.background.effect === 'string') out.effect = cfg.background.effect;
    } catch (err) {
      console.warn('[editor] could not read params.toml', err);
    }
    return out;
  }

  /** 背景效果的中文名（效果文件第 2 行 ` * 背景效果：<中文名>`），读不到就用文件名。 */
  async loadEffectNames() {
    for (const name of this.effects) {
      try {
        const text = await this.repo.readText(`${PATHS.effects}/${name}.js`);
        const m = /背景效果[：:]\s*(.+)/.exec(text.split('\n').slice(0, 4).join('\n'));
        if (m) this.effectNames[name] = m[1].trim();
      } catch { /* 用文件名 */ }
      if (this.destroyed) return;
    }
    this.updateEffectLabels();
  }

  effectLabel(n) {
    return this.effectNames[n] ? `${this.effectNames[n]}（${n}）` : n;
  }

  updateEffectLabels() {
    const sel = this.els.effectSelect;
    if (!sel || !sel.isConnected) return;
    for (const opt of sel.options) {
      if (opt.value) opt.textContent = this.effectLabel(opt.value);
      else {
        const d = this.siteDefaults.effect;
        opt.textContent = d ? `跟随全站设置（${this.effectNames[d] || d}）` : '跟随全站设置';
      }
    }
  }

  collectBases() {
    const bases = new Set();
    for (const e of this.repo.list(PATHS.posts + '/')) {
      const rest = e.path.slice(PATHS.posts.length + 1);
      if (rest.includes('/')) { bases.add(rest.split('/')[0].toLowerCase()); continue; }
      const info = C.parseContentPath(e.path, this.langs);
      if (info) bases.add(info.base.toLowerCase());
    }
    this.existingBases = bases;
  }

  normalizeDir(dir) {
    let d = String(dir || '').trim().replace(/^\/+|\/+$/g, '');
    if (!d) return PATHS.content;
    if (d !== PATHS.content && !d.startsWith(PATHS.content + '/')) d = `${PATHS.content}/${d}`;
    if (/(^|\/)\.\.?(\/|$)/.test(d)) throw userError('地址不正确', `目录「${dir}」不是有效的内容目录。`);
    return d;
  }

  groupKeyOf(path) {
    const info = C.parseContentPath(path, this.langs);
    if (!info) return null;
    return info.dir ? `${info.dir}/${info.base}` : info.base;
  }

  keyForPath(path) {
    const info = C.parseContentPath(path, this.langs);
    return info ? (info.lang || 'shared') : null;
  }

  async openPath(rawPath) {
    const path = String(rawPath || '').replace(/^\/+/, '');
    const info = C.parseContentPath(path, this.langs);
    if (!info || !(path === PATHS.content || path.startsWith(PATHS.content + '/'))) {
      throw userError('无法编辑这个文件', `「${path}」不是 content/ 目录下的 Markdown 文件。`);
    }
    const groupKey = info.dir ? `${info.dir}/${info.base}` : info.base;
    const group = C.groupPages(this.repo.list(PATHS.content + '/'), this.langs).find((g) => g.key === groupKey);
    if (!group) {
      throw userError('找不到这个文件', `「${path}」不存在，可能已经被删除或改名。`);
    }
    this.group = { ...group, variants: { ...group.variants } };
    this.kind = C.isPost(group) ? 'post' : 'page';

    const keys = Object.keys(group.variants);
    const texts = await Promise.all(keys.map((k) => this.repo.readText(group.variants[k])));
    keys.forEach((k, i) => {
      const p = group.variants[k];
      let doc;
      try {
        doc = splitDocument(texts[i]);
      } catch (err) {
        throw userError('这个文件的格式有问题', `${p}：${errorMessage(err)}`);
      }
      if (doc.kind === 'toml') {
        throw userError('暂不支持编辑这个文件',
          `${p} 开头的设置区使用的是 TOML 格式（+++ 包围），后台只支持 YAML 格式（--- 包围）。请在 GitHub 网页上编辑这个文件。`);
      }
      let fm;
      try { fm = parseFrontMatter(doc.fmText); } catch (err) {
        throw userError('这个文件的设置区有错误', `${p}：${errorMessage(err)}`);
      }
      this.variants.set(k, this.makeVariant({ key: k, path: p, exists: true, sha: this.repo.entry(p)?.sha ?? null, fmText: doc.fmText, fm, body: doc.body }));
    });
    // 固定的标签顺序：共用版本、然后按站点语言顺序
    this.sortVariants();

    const requested = info.lang || 'shared';
    this.activeKey = this.variants.has(requested) ? requested : [...this.variants.keys()][0];

    // 本机草稿：已有版本 + 尚未创建的语言版本
    const checks = [];
    for (const v of this.variants.values()) {
      checks.push(drafts.loadDraft(v.draftKey).then((rec) => { if (rec && this.draftDiffers(v, rec)) v.localDraft = rec; }));
    }
    for (const lang of this.langs) {
      if (group.variants[lang]) continue;
      const vp = C.variantPath(group.dir, group.base, lang);
      const key = drafts.draftKeyForPath(vp);
      checks.push(drafts.loadDraft(key).then((rec) => { if (rec) this.orphanDrafts.push({ key, lang, path: vp, rec }); }));
    }
    if (!group.variants.shared) {
      const vp = C.variantPath(group.dir, group.base, null);
      const key = drafts.draftKeyForPath(vp);
      checks.push(drafts.loadDraft(key).then((rec) => { if (rec) this.orphanDrafts.push({ key, lang: 'shared', path: vp, rec }); }));
    }
    await Promise.all(checks);
    await this.resolveRepoImages();
  }

  /** 草稿和文件当前内容是否真的不同（自动保存后又发表了的草稿会被删除，这里只是兜底）。 */
  draftDiffers(v, rec) {
    const f = (rec.fields && rec.fields.form) || {};
    const md = String(rec.markdown || '').trim();
    if (md !== v.markdown.trim()) return true;
    return JSON.stringify(this.formKeys(f)) !== JSON.stringify(this.formKeys(v.form));
  }

  formKeys(f) {
    const keys = ['title', 'date', 'description', 'tags', 'categories', 'cover', 'math', 'comments', 'effect', 'linkTitle', 'inMenu', 'weight'];
    return keys.map((k) => (f[k] === undefined ? null : f[k]));
  }

  openNewPost() {
    this.isNewGroup = true;
    this.kind = 'post';
    this.newKey = drafts.newDraftKey();
    this.group = { key: null, dir: PATHS.posts, base: '', isIndex: false, variants: {} };
    const form = this.defaultForm({ date: hugoDate() });
    const v = this.makeVariant({ key: 'shared', path: null, exists: false, sha: null, fmText: null, fm: {}, body: '' });
    v.form = form;
    v.baseForm = clone(form);
    v.isNew = true;
    v.draftKey = this.newKey;
    this.variants.set('shared', v);
    this.activeKey = 'shared';
    this.slug = { value: C.suggestSlug('', this.existingBases), touched: false };
  }

  openNewPage(dir) {
    this.isNewGroup = true;
    this.kind = 'page';
    const groupKey = `${dir}/_index`;
    this.group = { key: groupKey, dir, base: '_index', isIndex: true, variants: {} };
    const path = `${dir}/_index.md`;
    // 菜单顺序默认排在现有菜单项后面
    const v = this.makeVariant({ key: 'shared', path, exists: false, sha: null, fmText: null, fm: {}, body: '' });
    v.form = this.defaultForm({ inMenu: true, weight: '' });
    v.baseForm = clone(v.form);
    v.isNew = true;
    this.variants.set('shared', v);
    this.activeKey = 'shared';
    this.suggestWeight(v);
    drafts.loadDraft(v.draftKey).then((rec) => {
      if (rec && !this.destroyed) { v.localDraft = rec; this.renderBanners(); }
    });
  }

  async suggestWeight(v) {
    let max = 0;
    const groups = C.groupPages(this.repo.list(PATHS.content + '/'), this.langs).filter((g) => !C.isPost(g));
    for (const g of groups) {
      const p = g.variants.shared || g.variants[this.ctx.defaultLang] || Object.values(g.variants)[0];
      try {
        const fm = parseFrontMatter(splitDocument(await this.repo.readText(p)).fmText);
        const w = Number(fm.menu && fm.menu.main && fm.menu.main.weight);
        if (Number.isFinite(w)) max = Math.max(max, w);
      } catch { /* 忽略格式有问题的文件 */ }
    }
    if (!v.form.weight) {
      v.form.weight = String(max + 10);
      v.baseForm.weight = v.form.weight;
      if (!this.destroyed && this.activeKey === v.key && this.els.settingsBody) this.renderSettings();
    }
  }

  openNewFromDraft(key, rec) {
    const f = rec.fields || {};
    this.isNewGroup = true;
    this.kind = f.kind === 'page' ? 'page' : 'post';
    this.newKey = key;
    if (this.kind === 'page') {
      const dir = this.normalizeDir(f.dir || PATHS.content);
      this.group = { key: `${dir}/_index`, dir, base: '_index', isIndex: true, variants: {} };
    } else {
      this.group = { key: null, dir: PATHS.posts, base: '', isIndex: false, variants: {} };
      this.slug = { value: str(f.slug), touched: !!f.slugTouched };
    }
    const v = this.makeVariant({ key: 'shared', path: this.kind === 'page' ? `${this.group.dir}/_index.md` : null, exists: false, sha: null, fmText: null, fm: {}, body: '' });
    v.form = this.defaultForm({ date: hugoDate() });
    v.baseForm = clone(v.form);
    v.isNew = true;
    v.draftKey = key;
    v.localDraft = rec;
    this.variants.set('shared', v);
    this.activeKey = 'shared';
    this.pendingAutoApply = true;
  }

  /**
   * 新文章的草稿，但同名文件已经在仓库里了：多半是发表成功后页面被关掉 / 切到后台，草稿没来得及删除。
   * 提示用户打开已发表的文章，而不是换个文件名再发表一遍（那样会出现两篇一样的文章）。
   */
  async checkPublishedTwin(rec) {
    if (this.kind !== 'post' || !this.slug.value) return;
    const path = C.variantPath(PATHS.posts, this.slug.value, null);
    if (!this.repo.has(path)) return;
    let same = false;
    try {
      const fm = parseFrontMatter(splitDocument(await this.repo.readText(path)).fmText);
      const draftTitle = str(rec.fields && rec.fields.form && rec.fields.form.title).trim();
      same = !!draftTitle && str(fm.title).trim() === draftTitle;
    } catch { /* 读不到就当作不同 */ }
    this.publishedTwin = { path, same };
  }

  async openTwin({ discard }) {
    const t = this.publishedTwin;
    if (!t) return;
    if (discard) {
      const ok = await confirmDialog({
        title: '丢弃这份草稿？', message: '这份本机草稿会被删除，不能恢复。已经发表的文章不受影响。', okText: '丢弃', danger: true,
      });
      if (!ok) return;
      this.autosave.cancel();
      this.discarded = true;
      await drafts.deleteDraft(this.newKey);
    }
    this.leaving = true;
    this.ctx.navigate(discard ? '#/edit?path=' + encodeURIComponent(t.path) : this.listHash(), { replace: true });
  }

  defaultForm(extra = {}) {
    return {
      title: '', date: '', description: '', tags: [], categories: [], cover: '',
      math: this.siteDefaults.math, comments: this.siteDefaults.comments, effect: '',
      linkTitle: '', inMenu: false, weight: '',
      ...extra,
    };
  }

  formFromFm(fm) {
    const menu = fm.menu;
    let inMenu = false;
    let weight = '';
    if (isPlainObject(menu)) {
      inMenu = Object.prototype.hasOwnProperty.call(menu, 'main');
      if (isPlainObject(menu.main) && menu.main.weight != null) weight = String(menu.main.weight);
    } else if (typeof menu === 'string') inMenu = menu === 'main';
    else if (Array.isArray(menu)) inMenu = menu.includes('main');
    const cover = isPlainObject(fm.cover) ? str(fm.cover.image) : '';
    const bg = isPlainObject(fm.background) ? fm.background : null;
    return {
      title: str(fm.title),
      date: fm.date == null ? '' : str(fm.date),
      description: str(fm.description),
      tags: strList(fm.tags),
      categories: strList(fm.categories),
      cover,
      math: fm.math === undefined ? this.siteDefaults.math : goTruthy(fm.math),
      comments: fm.comments === undefined ? this.siteDefaults.comments : goTruthy(fm.comments),
      effect: bg && typeof bg.effect === 'string' ? bg.effect : '',
      linkTitle: str(fm.linkTitle),
      inMenu,
      weight,
    };
  }

  makeVariant({ key, path, exists, sha, fmText, fm, body }) {
    const form = this.formFromFm(fm || {});
    const display = this.displayBody(body);
    return {
      _display: display,         // 打开时的显示正文（判断「没改过」用）
      key, path, exists, sha,
      fmText,                    // 原始 front matter 文本（null = 文件没有设置区）
      fm: fm || {},              // 解析结果
      rawBody: body,             // 结束分隔线之后的原文（没改正文时原样写回）
      form,
      baseForm: clone(form),
      markdown: display,         // 编辑中的正文（图片可能是 blob: 地址）
      baseMarkdown: undefined,   // 第一次放进编辑器后 Vditor 规范化的正文，用来判断是否改过
      published: !!exists && !C.isDraftFm(fm || {}),
      isNew: !exists,
      restored: false,
      bodyEdited: false,         // 用户改过正文（输入 / 插入 / 上传）
      copyBase: null,            // 复制出来的新版本：来源版本的基准正文和原文（保存时用来保留原文格式）
      copyRaw: null,
      touched: false,
      stale: false,
      conflict: null,
      localDraft: null,
      draftKey: path ? drafts.draftKeyForPath(path) : null,
      draftWritten: false,
      needsAutosave: false,
    };
  }

  sortVariants() {
    const order = ['shared', ...this.langs];
    const entries = [...this.variants.entries()].sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]));
    this.variants = new Map(entries);
  }

  /** 文件正文 → 编辑器里显示的正文：去掉开头空行；刚上传、网站还没部署好的图片用 blob 地址显示。 */
  displayBody(body) {
    let md = String(body || '').replace(/^(?:[ \t]*\n)+/, '');
    for (const [sitePath, blob] of recentUploads) md = this.swapImage(md, sitePath, blob);
    return md;
  }

  /**
   * 正文里 ](网站路径 的图片换成 blob 地址显示。登记的媒体记住原来的网站路径（sitePath），
   * 保存时原样写回 —— 不会被改成当前文章的图片目录（图片可能属于另一篇文章）。
   */
  swapImage(md, sitePath, blob) {
    const forms = [...new Set([mdDest(sitePath), sitePath])].filter((f) => md.includes(`](${f}`));
    if (!forms.length) return md;
    const m = this.addMedia(sitePath, blob, 'image', { committed: true, sitePath: forms[0] });
    for (const f of forms) md = md.split(`](${f}`).join(`](${m.url}`);
    return md;
  }

  /**
   * 仓库里有、但网站上（还）打不开的图片（刚发表还没部署好 / 部署失败 / 从「资料」页上传的），
   * 从仓库读出来用 blob 地址显示，避免编辑器和手机预览里出现裂图。
   * @param {string[]} sitePaths 网站路径（/images/…，可以是编码过的）
   * @returns {Promise<Map<string, Blob>>} 网站路径 → Blob（只包含需要替换的）
   */
  async fetchRepoImages(sitePaths) {
    const out = new Map();
    const todo = [];
    for (const p of new Set(sitePaths)) {
      if (!p.startsWith('/') || p.startsWith('//')) continue;
      let rel;
      try { rel = decodeURIComponent(p.split(/[?#]/)[0]); } catch { continue; }
      const repoPath = 'static' + rel;
      if (recentUploads.has(rel)) { out.set(p, recentUploads.get(rel)); continue; }
      if (this.repoImageCache.has(repoPath)) { out.set(p, this.repoImageCache.get(repoPath)); continue; }
      if (!IMAGE_EXTS.has(extOf(rel)) || !this.repo.has(repoPath)) continue;
      todo.push({ p, repoPath });
    }
    await Promise.all(todo.slice(0, 60).map(async ({ p, repoPath }) => {
      try {
        let ok = false;
        try {
          const ctl = typeof AbortController === 'function' ? new AbortController() : null;
          const timer = ctl ? setTimeout(() => ctl.abort(), 4000) : null;
          const res = await fetch(new URL(p.replace(/^\/+/, ''), this.ctx.siteUrl).href, {
            method: 'HEAD', cache: 'no-store', credentials: 'omit', signal: ctl ? ctl.signal : undefined,
          });
          if (timer) clearTimeout(timer);
          ok = res.ok;
        } catch { ok = false; }
        if (ok) return;
        const bytes = await this.repo.readBytes(repoPath);
        const ext = extOf(repoPath);
        const type = ext === 'svg' ? 'image/svg+xml' : ext === 'jpg' ? 'image/jpeg' : `image/${ext}`;
        const blob = new Blob([bytes], { type });
        this.repoImageCache.set(repoPath, blob);
        out.set(p, blob);
      } catch (err) {
        console.warn('[editor] could not load repo image', repoPath, err);
      }
    }));
    return out;
  }

  /** 正文里引用的站内图片地址：![…](/x) 和 {{< gallery "/x" >}} / {{< figure src="/x" >}} 的参数。 */
  imagePathsIn(md) {
    const out = [];
    const re = /!\[[^\]\n]*\]\(\s*<?(\/[^)\s>]+)/g;
    let m;
    while ((m = re.exec(md))) out.push(m[1]);
    const sc = /\{\{[<%]\s*(?:gallery|figure)\b([^}]*)[>%]\}\}/g;
    while ((m = sc.exec(md))) {
      const arg = /"(\/[^"]+)"|'(\/[^']+)'/g;
      let a;
      while ((a = arg.exec(m[1]))) out.push(a[1] || a[2]);
    }
    return out;
  }

  /** 打开文件后：所有版本正文 / 封面里还没部署好的图片换成 blob 地址（在放进编辑器之前）。 */
  async resolveRepoImages() {
    const paths = [];
    for (const v of this.variants.values()) {
      paths.push(...this.imagePathsIn(v.markdown));
      if (v.form.cover && v.form.cover.startsWith('/')) paths.push(v.form.cover);
    }
    if (!paths.length) return;
    const found = await this.fetchRepoImages(paths);
    if (!found.size) return;
    for (const v of this.variants.values()) {
      let md = v.markdown;
      for (const [p, blob] of found) md = this.swapImage(md, p, blob);
      if (md !== v.markdown) { v.markdown = md; v._display = md; }
      if (v.form.cover && found.has(v.form.cover)) this.coverBlobs.set(v.form.cover, found.get(v.form.cover));
    }
  }

  // =========================================================================
  // 媒体（待上传的图片 / 资料）

  /**
   * 登记一个待上传文件，返回 { name, url }。名字和已登记的冲突时自动加 -2、-3 …
   * exactName：用于恢复草稿 / 已上传的图片，名字必须保持不变。
   */
  addMedia(name, blob, kind, { committed = false, exactName = false, sitePath } = {}) {
    let finalName = name;
    if (sitePath) {
      // 已经在仓库里的图片：以网站路径为键（不同文章里的同名图片互不影响）
      const existing = this.media.get(name);
      if (existing) return { name, url: existing.url, kind: existing.kind };
      const url = URL.createObjectURL(blob);
      this.media.set(name, { blob, url, kind: 'image', committed: true, sitePath });
      this.urlToName.set(url, name);
      return { name, url, kind: 'image' };
    }
    if (!exactName) {
      const dot = name.lastIndexOf('.');
      const stem = dot > 0 ? name.slice(0, dot) : name;
      const ext = dot > 0 ? name.slice(dot) : '';
      const taken = (n) => this.media.has(n) || (kind === 'doc' && this.repo.has(`${PATHS.documents}/${n}`));
      for (let i = 2; taken(finalName); i++) finalName = `${stem}-${i}${ext}`;
    } else if (this.media.has(name)) {
      const existing = this.media.get(name);
      if (existing.blob === blob || existing.blob.size === blob.size) {
        if (committed) existing.committed = true;
        return { name, url: existing.url, kind: existing.kind };
      }
    }
    const url = kind === 'image' ? URL.createObjectURL(blob) : null;
    this.media.set(finalName, { blob, url, kind, committed });
    if (url) this.urlToName.set(url, finalName);
    return { name: finalName, url, kind };
  }

  imageDir() {
    if (this.kind === 'post') {
      const base = this.isNewGroup ? this.slug.value : this.group.base;
      return C.imageDirFor({ dir: PATHS.posts, base, isIndex: false });
    }
    return C.imageDirFor(this.group);
  }

  /** 图片在网站上的路径（写进 front matter 用，不编码）。 */
  imageSitePath(name, imgDir = this.imageDir()) {
    return C.sitePathFor(`${imgDir}/${name}`);
  }

  /** 媒体在 Markdown 正文里的地址：已在仓库里的用它原来的网站路径，待上传的放进当前文章的图片目录。 */
  mediaDest(name, imgDir = this.imageDir()) {
    const m = this.media.get(name);
    if (m && m.sitePath) return m.sitePath;
    return mdDest(this.imageSitePath(name, imgDir));
  }

  docSitePath(name) {
    return mdDest(C.sitePathFor(`${PATHS.documents}/${name}`));
  }

  /** 草稿用：blob 地址 → admin-pending://名字 */
  toDraftMarkdown(md) {
    let out = md;
    for (const [url, name] of this.urlToName) {
      const m = this.media.get(name);
      // 已经提交到仓库的图片直接写网站路径；还没上传的用占位符，图片本身存进草稿
      const target = m && m.committed ? this.mediaDest(name) : PENDING + name;
      out = out.split(url).join(target);
    }
    return out;
  }

  /** 草稿恢复：admin-pending://名字 → 新的 blob 地址 */
  fromDraftMarkdown(md, images) {
    let out = String(md || '');
    for (const [key, blob] of Object.entries(images || {})) {
      if (!(blob instanceof Blob)) continue;
      if (key.startsWith('doc:')) {
        this.addMedia(key.slice(4), blob, 'doc', { exactName: true });
        continue;
      }
      const m = this.addMedia(key, blob, 'image', { exactName: true });
      out = out.split(PENDING + key).join(m.url);
    }
    return out;
  }

  /** 某段正文 + 封面引用了哪些待上传文件。 */
  referencedMedia(md, cover) {
    const used = [];
    for (const [name, m] of this.media) {
      if (m.kind === 'image') {
        if ((m.url && md.includes(m.url)) || md.includes(PENDING + name) || cover === PENDING + name) used.push(name);
      } else if (md.includes(this.docSitePath(name))) {
        used.push(name);
      }
    }
    return used;
  }

  coverDisplayUrl(cover) {
    if (!cover) return null;
    if (cover.startsWith(PENDING)) {
      const m = this.media.get(cover.slice(PENDING.length));
      return m ? m.url : null;
    }
    const blob = recentUploads.get(cover) || this.coverBlobs.get(cover);
    if (blob) return this.addMedia(cover, blob, 'image', { committed: true, sitePath: mdDest(cover) }).url;
    return safeUrl(cover, this.ctx.siteUrl);
  }

  // =========================================================================
  // 布局

  buildLayout() {
    const els = this.els;
    els.back = h('button', {
      type: 'button', class: 'btn btn-ghost btn-sm ed-back', dataset: { testid: 'editor-back' },
      'aria-label': '返回列表', on: { click: () => this.goBack() },
    }, svgIcon('back'), h('span', {}, '返回'));
    els.tabs = h('div', { class: 'tabs ed-tabs', role: 'tablist', 'aria-label': '语言版本' });
    els.status = h('span', { class: 'ed-status', dataset: { testid: 'editor-status' } });
    els.explain = h('div', { class: 'ed-explain muted small', dataset: { testid: 'editor-explain' } });
    els.banners = h('div', { class: 'ed-banners stack-sm' });

    els.title = h('textarea', {
      class: 'ed-title', rows: 1, placeholder: '请在这里输入标题', maxlength: 200,
      'aria-label': '标题', dataset: { testid: 'editor-title' },
    });
    els.title.addEventListener('input', () => {
      els.title.value = els.title.value.replace(/[\r\n]+/g, ' ');
      this.active.form.title = els.title.value;
      this.fitTitle();
      els.titleError.hidden = true;
      if (this.isNewGroup && this.kind === 'post' && !this.slug.touched) this.updateSlugSuggestion();
      this.changed();
    });
    els.title.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); this.focusEditor(); }
    });
    els.titleError = h('div', { class: 'error ed-title-error', role: 'alert' }, '请先填写标题');
    els.titleError.hidden = true;
    els.slugHint = h('div', { class: 'ed-slug-hint small', dataset: { testid: 'editor-slug-hint' } });
    els.slugHint.hidden = true;

    els.vditor = h('div', { class: 'ed-vditor', dataset: { testid: 'editor-body' } });

    const mainCard = h('div', { class: 'card ed-card' },
      h('div', { class: 'ed-head' }, els.back, els.tabs, els.status),
      els.explain,
      els.banners,
      els.title,
      els.titleError,
      els.slugHint,
      els.vditor);

    els.settingsBody = h('div', { class: 'ed-settings-body stack' });
    els.settingsToggle = h('button', {
      type: 'button', class: 'ed-settings-toggle show-mobile', 'aria-expanded': 'false',
      dataset: { testid: 'editor-settings-toggle' },
      on: { click: () => this.toggleSettings() },
    }, svgIcon('settings'), h('span', { class: 'grow' }, this.kind === 'post' ? '文章设置' : '页面设置'),
    h('span', { class: 'ed-settings-summary muted small' }), svgIcon('chevron-down', { class: 'ed-chevron' }));
    els.side = h('aside', { class: 'ed-side is-collapsed', 'aria-label': this.kind === 'post' ? '文章设置' : '页面设置' },
      h('div', { class: 'card ed-settings' },
        els.settingsToggle,
        h('h2', { class: 'card-title hide-mobile' }, svgIcon('settings'), this.kind === 'post' ? '文章设置' : '页面设置'),
        els.settingsBody));

    // 底部操作栏
    els.autosave = h('span', { class: 'ed-autosave muted small', dataset: { testid: 'editor-autosave-status' }, 'aria-live': 'polite' });
    els.previewBtn = h('button', {
      type: 'button', class: 'btn ed-btn-preview', dataset: { testid: 'editor-preview' },
      'aria-label': '手机预览', title: '手机预览', on: { click: () => this.openPreview() },
    }, svgIcon('phone'), h('span', { class: 'ed-btn-text' }, '手机预览'));
    els.moreBtn = h('button', {
      type: 'button', class: 'btn btn-icon ed-btn-more', dataset: { testid: 'editor-more' },
      'aria-label': '更多操作', title: '更多操作', 'aria-haspopup': 'menu', 'aria-expanded': 'false',
      on: { click: (e) => { e.stopPropagation(); this.toggleMore(); } },
    }, svgIcon('more'));
    els.moreWrap = h('div', { class: 'ed-more-wrap' }, els.moreBtn);
    els.draftBtn = h('button', {
      type: 'button', class: 'btn ed-btn-draft', dataset: { testid: 'editor-save-draft' },
      on: { click: () => this.save('draft') },
    }, svgIcon('save'), h('span', { class: 'ed-btn-text' }, '保存草稿'));
    els.publishBtn = h('button', {
      type: 'button', class: 'btn btn-primary ed-btn-publish', dataset: { testid: 'editor-publish' },
      on: { click: () => this.save('publish') },
    }, svgIcon('send'), h('span', { class: 'ed-publish-text' }, '发表'));
    els.bar = h('div', { class: 'ed-bar', role: 'toolbar', 'aria-label': '保存与发表' },
      h('div', { class: 'ed-bar-inner' },
        els.autosave,
        h('div', { class: 'ed-bar-actions' }, els.previewBtn, els.moreWrap, els.draftBtn, els.publishBtn)));

    render(this.container,
      h('div', { class: 'ed-layout' }, h('div', { class: 'ed-main' }, mainCard), els.side),
      els.bar);
    // 有还没处理的本机草稿时，开始编辑之前（获得焦点时）就问清楚，而不是等到打字打到一半弹出对话框
    const askOnFocus = (e) => {
      const v = this.active;
      if (!v || !v.localDraft || this.pendingAsk || this.destroyed) return;
      if (e.target && e.target.closest && e.target.closest('.banner, .ed-back, .ed-tabs, .ed-settings-toggle')) return;
      this.askPendingDraft(v);
    };
    mainCard.addEventListener('focusin', askOnFocus);
    els.settingsBody.addEventListener('focusin', askOnFocus);
  }

  renderFatal(title, detail) {
    const back = this.kind === 'page' ? '#/pages' : '#/posts';
    render(this.container,
      h('div', { class: 'card ed-fatal', dataset: { testid: 'editor-error' } },
        errorState(title, { detail }),
        h('div', { class: 'row', style: { justifyContent: 'center', paddingBottom: '12px' } },
          h('a', { class: 'btn btn-primary', href: back }, svgIcon('back'), this.kind === 'page' ? '返回页面列表' : '返回文章列表'))));
  }

  get active() {
    return this.variants.get(this.activeKey);
  }

  fitTitle() {
    const t = this.els.title;
    if (!t) return;
    t.style.height = 'auto';
    t.style.height = `${t.scrollHeight}px`;
  }

  toggleSettings(force) {
    const side = this.els.side;
    const open = force ?? side.classList.contains('is-collapsed');
    side.classList.toggle('is-collapsed', !open);
    this.els.settingsToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
  }

  // =========================================================================
  // Vditor

  isDarkUI() {
    return !!(this.mq && this.mq.matches);
  }

  async createVditor() {
    await loadIconScript(); // 见 preview.js：避免 Vditor 用内联脚本加载图标（会被 CSP 拦截）
    const Vditor = window.Vditor;
    const dark = this.isDarkUI();
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) { settled = true; reject(new Error('编辑器加载超时，请刷新页面重试')); }
      }, 30000);
      try {
        this.vd = new Vditor(this.els.vditor, {
          mode: 'wysiwyg',
          lang: 'zh_CN',
          cdn: VDITOR_CDN,
          icon: 'ant',
          theme: dark ? 'dark' : 'classic',
          cache: { enable: false },
          value: '',
          minHeight: 480,
          placeholder: '从这里开始写正文…',
          counter: { enable: true },
          toolbarConfig: { pin: true },
          outline: { enable: false, position: 'right' },
          toolbar: this.toolbarItems(),
          preview: {
            math: { engine: 'KaTeX', inlineDigit: true },
            // ==文字== = 高亮（和网站 markup.toml 里 goldmark 的 mark 扩展一致）
            markdown: { ...VDITOR_MARKDOWN },
            hljs: { style: dark ? 'github-dark' : 'github', lineNumber: false },
            theme: { current: dark ? 'dark' : 'light', path: VDITOR_CDN + '/dist/css/content-theme' },
          },
          hint: { emojiPath: VDITOR_CDN + '/dist/images/emoji' },
          upload: {
            multiple: true,
            handler: (files) => this.onFiles(files),
          },
          input: (md) => this.onEditorInput(md),
          after: () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            // 安全：编辑区里的 <iframe> 等嵌入内容一律不加载（见 neutralizeEmbeds）
            if (!this.guardLute()) {
              reject(new Error('编辑器组件加载失败（安全检查没有通过），请刷新页面重试'));
              return;
            }
            this.setupToolbarHint();
            resolve();
          },
        });
        this.els.vditor._vditor = this.vd; // 方便自动化测试直接读写正文
        this.els.vditor._editor = this; // 同上（只用于测试里检查内部状态）
      } catch (err) {
        settled = true;
        clearTimeout(timer);
        reject(err);
      }
    });
  }

  /** 工具栏：手机上把常用的（图片、公式、资料、标题…）放在最前面，不常用的收进「更多」。 */
  toolbarItems() {
    const formula = { name: 'formula', tip: '插入公式', tipPosition: 'n', icon: ICON_FORMULA, click: () => this.insertFormula() };
    const docs = { name: 'documents', tip: '插入资料链接', tipPosition: 'n', icon: ICON_DOCS, click: () => this.openDocuments() };
    const gallery = { name: 'gallery', tip: '多图并排', tipPosition: 'n', icon: ICON_GALLERY, click: () => this.pickImages('gallery') };
    const figure = { name: 'figure', tip: '带说明的图片', tipPosition: 'n', icon: ICON_FIGURE, click: () => this.pickImages('figure') };
    // 高亮 = ==文字==（Ctrl/⌘ + Shift + M；Vditor 会把快捷键自动写进提示里）
    const mark = { name: 'mark', tip: '高亮', tipPosition: 'n', icon: ICON_MARK, hotkey: '⇧⌘M', click: () => this.toggleMark() };
    if (this.phone) {
      return [
        { name: 'upload', tip: '插入图片', tipPosition: 'n' }, figure, gallery, formula, docs, 'headings', 'bold', mark, 'quote', 'list',
        'ordered-list', 'line', 'link', 'table', 'undo', 'redo',
        { name: 'more', tip: '更多', tipPosition: 'n', toolbar: ['italic', 'strike', 'check', 'code', 'inline-code', 'edit-mode', 'outline', 'fullscreen'] },
      ];
    }
    return [
      'headings', 'bold', mark, 'italic', 'strike', '|',
      'line', 'quote', 'list', 'ordered-list', 'check', '|',
      'code', 'inline-code', 'table', 'link', 'upload', figure, gallery,
      formula, docs,
      '|', 'undo', 'redo', '|', 'edit-mode', 'outline', 'fullscreen',
    ];
  }

  /** 把 Lute 输出 HTML 的方法包一层 neutralizeEmbeds。返回是否成功。 */
  guardLute() {
    const lute = this.vd && this.vd.vditor && this.vd.vditor.lute;
    if (!lute) return false;
    if (lute.__adminGuarded) return true;
    try {
      for (const name of LUTE_HTML_METHODS) {
        const orig = lute[name];
        if (typeof orig !== 'function') continue;
        lute[name] = (...args) => neutralizeEmbeds(orig.apply(lute, args));
      }
      lute.__adminGuarded = true;
      // 自检：包装真的生效
      return !/<iframe/i.test(String(lute.Md2VditorDOM('<iframe src="/x"></iframe>\n')));
    } catch (err) {
      console.error('[editor] could not guard lute', err);
      return false;
    }
  }

  /** 手机上工具栏横向滑动：右边还有按钮时显示渐隐提示。 */
  setupToolbarHint() {
    const bar = this.els.vditor.querySelector('.vditor-toolbar');
    if (!bar) return;
    const update = () => {
      const more = bar.scrollWidth - bar.clientWidth - bar.scrollLeft > 4;
      this.els.vditor.classList.toggle('ed-toolbar-more', more);
    };
    bar.addEventListener('scroll', update, { passive: true });
    window.addEventListener('resize', update);
    this.toolbarCleanup = () => window.removeEventListener('resize', update);
    requestAnimationFrame(update);
  }

  getEditorValue() {
    try { return this.vd ? this.vd.getValue() : this.active.markdown; } catch { return this.active.markdown; }
  }

  focusEditor() {
    try { this.vd && this.vd.focus(); } catch { /* ignore */ }
  }

  /** 当前编辑模式的编辑区元素。 */
  editRoot() {
    try {
      const mode = this.vd && this.vd.getCurrentMode ? this.vd.getCurrentMode() : 'wysiwyg';
      return { mode, internal: this.vd.vditor[mode], root: this.vd.vditor[mode].element };
    } catch { return null; }
  }

  /** 记下光标位置（打开对话框之前调用：对话框里的输入框会把光标拿走）。 */
  saveCaret() {
    const r = this.editRoot();
    if (!r || !r.root) return null;
    try {
      const sel = getSelection();
      if (sel.rangeCount && r.root.contains(sel.getRangeAt(0).startContainer)) return sel.getRangeAt(0).cloneRange();
      if (r.internal.range && r.root.contains(r.internal.range.startContainer)) return r.internal.range.cloneRange();
    } catch { /* ignore */ }
    return null;
  }

  /** 把焦点和光标放回 saveCaret() 记下的位置（之后的插入就会插在那里）。 */
  restoreCaret(range) {
    const r = this.editRoot();
    if (!r || !r.root) return;
    try {
      r.root.focus({ preventScroll: true });
      if (range && r.root.contains(range.startContainer)) {
        const sel = getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        r.internal.range = range;
      }
    } catch { /* ignore */ }
  }

  /**
   * 光标在代码块 / 公式块里时（例如刚插入公式），把它移到这个块后面，
   * 否则 Vditor 会把图片、链接的 Markdown 当成代码插进块里。
   */
  moveCaretOutOfBlock() {
    try {
      const mode = this.vd.getCurrentMode ? this.vd.getCurrentMode() : 'wysiwyg';
      if (mode !== 'wysiwyg') return;
      const internal = this.vd.vditor && this.vd.vditor.wysiwyg;
      const root = this.els.vditor.querySelector('.vditor-wysiwyg .vditor-reset');
      const sel = getSelection();
      let range = sel.rangeCount && root.contains(sel.getRangeAt(0).startContainer) ? sel.getRangeAt(0) : internal && internal.range;
      if (!range || !root.contains(range.startContainer)) return;
      const start = range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement;
      // 注意：Vditor 的编辑区本身就是 <pre class="vditor-reset">，不能把它当成代码块
      const block = start && start.closest('.vditor-wysiwyg__block, pre:not(.vditor-reset)');
      if (!block || block === root || !root.contains(block)) return;
      const top = [...root.children].find((c) => c.contains(block)) || block;
      let after = top.nextElementSibling;
      if (!after) {
        after = document.createElement('p');
        after.setAttribute('data-block', '0');
        after.appendChild(document.createTextNode('\u200b'));
        top.after(after);
      }
      // 收起公式 / 代码的编辑框
      const pre = top.querySelector('pre:not(.vditor-wysiwyg__preview)');
      if (pre && top.querySelector('.vditor-wysiwyg__preview')) pre.style.display = 'none';
      range = document.createRange();
      range.setStart(after, 0);
      range.collapse(true);
      sel.removeAllRanges();
      sel.addRange(range);
      if (internal) internal.range = range;
    } catch (err) {
      console.warn('[editor] caret move failed', err);
    }
  }

  insertMarkdown(md) {
    if (!this.vd) return;
    try {
      this.vd.insertValue(md);
    } catch (err) {
      console.error(err);
      toast('插入失败，请重试', { type: 'error' });
    }
  }

  insertFormula() {
    const sel = '.vditor-wysiwyg .vditor-reset .vditor-wysiwyg__block[data-type="math-block"]';
    const before = new Set(this.els.vditor.querySelectorAll(sel));
    this.moveCaretOutOfBlock();
    this.insertMarkdown('\n$$\n\n$$\n');
    // 所见即所得模式下，空的公式块是看不见的：直接打开它的编辑框，光标放进去
    try {
      if (this.vd.getCurrentMode && this.vd.getCurrentMode() !== 'wysiwyg') return;
      const blocks = [...this.els.vditor.querySelectorAll(sel)];
      const block = blocks.find((b) => !before.has(b)) ||
        blocks.reverse().find((b) => !(b.querySelector('pre > code') || {}).textContent?.trim());
      const preview = block && block.querySelector('.vditor-wysiwyg__preview');
      if (preview) preview.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    } catch (err) {
      console.warn('[editor] could not open the formula block', err);
    }
  }

  /**
   * 「高亮」按钮：把选中的文字包成 ==文字==（<mark>）；选区在已有的高亮里（或包含高亮）时取消高亮。
   * 所见即所得模式下直接改编辑区的 DOM（保留选区里的加粗、链接等格式），再让 Vditor 按「输入」重新整理
   * 这一段（和打字一样：会触发 input 回调、可以撤销）。源码 / 即时渲染模式下按文字处理。
   */
  toggleMark() {
    const r = this.editRoot();
    const range = this.saveCaret();
    if (!r || !r.root || !range) { toast('先选中要高亮的文字', { type: 'info' }); return; }
    if (r.mode !== 'wysiwyg') { this.toggleMarkText(r, range); return; }
    const root = r.root;
    const elOf = (n) => (n && n.nodeType === 1 ? n : n && n.parentElement);
    const inRoot = (el) => el && el !== root && root.contains(el);
    const markOf = (n) => { const m = elOf(n) && elOf(n).closest('mark'); return inRoot(m) ? m : null; };
    // 代码、公式、HTML 里不能加高亮（Hugo 也不会把那里的 == 当成高亮）
    const NO_MARK = 'code, pre:not(.vditor-reset), .vditor-wysiwyg__block, [data-type="html-inline"], [data-type="html-entity"], .ed-embed-blocked';
    const blocked = (n) => { const b = elOf(n) && elOf(n).closest(NO_MARK); return inRoot(b); };
    const BLOCK = 'p, li, h1, h2, h3, h4, h5, h6, td, th, blockquote, div';
    const blockOf = (n) => { const b = elOf(n) && elOf(n).closest(BLOCK); return inRoot(b) ? b : null; };

    // 取消：选区（或光标）碰到的高亮全部去掉
    const block = blockOf(range.startContainer);
    const hits = new Set([markOf(range.startContainer), markOf(range.endContainer)].filter(Boolean));
    if (!range.collapsed && block) {
      for (const m of block.querySelectorAll('mark')) if (range.intersectsNode(m)) hits.add(m);
    }
    if (hits.size) {
      let last = null;
      for (const m of hits) {
        const parent = m.parentNode;
        last = m.lastChild || last;
        while (m.firstChild) parent.insertBefore(m.firstChild, m);
        m.remove();
      }
      this.afterMarkEdit(r, last);
      return;
    }

    if (range.collapsed) { toast('先选中要高亮的文字', { type: 'info' }); return; }
    if (blocked(range.startContainer) || blocked(range.endContainer) || blocked(range.commonAncestorContainer)) {
      toast('代码和公式里不能加高亮', { type: 'info' });
      return;
    }
    if (!block || block !== blockOf(range.endContainer)) {
      toast('高亮只能用在同一段文字里，请分段选择', { type: 'info' });
      return;
    }
    // 先在这一段的副本上试出一种网站认得出的放法（见 planMark），再改真正的编辑区
    let top = block;
    while (top.parentNode !== root) top = top.parentNode;
    const plan = this.planMark(top, range);
    if (plan === null) { toast('先选中要高亮的文字', { type: 'info' }); return; }
    if (!plan) { toast('这里加不了高亮，请换一段文字选择', { type: 'info' }); return; }
    const mark = applyMarkPlan(range, plan, top);
    if (!mark) { toast('先选中要高亮的文字', { type: 'info' }); return; }
    if (plan.spaced) toast('高亮紧挨着标点或加粗、链接等格式，已在旁边加了空格，网站才能认出高亮', { type: 'info' });
    this.afterMarkEdit(r, mark);
  }

  /**
   * 在 top（编辑区里的一个顶层块）的副本上依次试几种放 <mark> 的方法，返回第一种
   * 「用 Lute 转成 Markdown 再解析回来，高亮还在、文字和加粗 / 斜体 / 链接 / 代码 / 公式都没变」的方法。
   * 原因：== 和 ** 一样受 CommonMark 的左右侧规则限制——== 里侧紧挨标点（，“ 或 **、`、[ 等格式符号）
   * 而外侧紧挨文字时不算高亮。中文里很常见：文字==**粗体**==文字、文字**==粗体==**文字 都会坏
   * （网站和编辑器都把 ==、** 原样显示出来，加粗也丢了）。Lute 和网站的 goldmark 在这点上规则一致。
   * 试的顺序：原样 → 去掉两头的标点 → 把高亮挪到加粗 / 斜体 / 链接外面 → 再在需要的一侧加空格。
   * 返回 plan（交给 applyMarkPlan）；null = 没有可高亮的文字；false = 怎么放都不行。
   */
  planMark(top, range) {
    const PLAIN = { lift: false, trim: false, before: false, after: false, spaced: false };
    const lute = this.vd && this.vd.vditor && this.vd.vditor.lute;
    if (!lute) return PLAIN;
    const sig = (md) => markSignature(lute, md);
    let base;
    try { base = sig(lute.VditorDOM2Md(htmlOf(top))); } catch { return PLAIN; }
    const sPath = nodePath(range.startContainer, top);
    const ePath = nodePath(range.endContainer, top);
    if (!sPath || !ePath) return PLAIN;
    let empty = true;
    for (const [before, after] of [[false, false], [true, false], [false, true], [true, true]]) {
      for (const [lift, trim] of [[false, false], [false, true], [true, false], [true, true]]) {
        const plan = { lift, trim, before, after, spaced: false };
        const copy = top.cloneNode(true);
        const rr = document.createRange();
        try {
          rr.setStart(nodeAt(copy, sPath), range.startOffset);
          rr.setEnd(nodeAt(copy, ePath), range.endOffset);
        } catch { return PLAIN; }
        if (!applyMarkPlan(rr, plan, copy)) continue;
        empty = false;
        if ((before || after) && !plan.spaced) continue; // 旁边本来就是空格 / 段首段尾：和前面试过的一样
        let s;
        try { s = sig(lute.VditorDOM2Md(htmlOf(copy))); } catch { continue; }
        if (sameMarkSignature(base, s)) return plan;
      }
    }
    return empty ? null : false;
  }

  /** 高亮的 DOM 改完之后：光标放到 node 后面，让 Vditor 重新整理这一段（和用户打字一样）。 */
  afterMarkEdit(r, node) {
    try {
      const range = document.createRange();
      if (node && r.root.contains(node)) range.setStartAfter(node);
      else { range.selectNodeContents(r.root); range.collapse(false); }
      range.collapse(true);
      this.restoreCaret(range);
      this.vd.insertValue(''); // 插入空内容 = 只触发 Vditor 的 input 处理（重新渲染这一段 + 撤销记录 + input 回调）
    } catch (err) {
      console.error('[editor] highlight failed', err);
      toast('高亮失败，请重试', { type: 'error' });
    }
  }

  /** 源码 / 即时渲染模式：按文字给选区加上或去掉两边的 ==。 */
  toggleMarkText(r, range) {
    // 选区（或光标）在已有的高亮里：把两边的 == 也选进来，下面就会去掉高亮
    const el = range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement;
    const ir = el && el.closest('.vditor-ir__node[data-type="mark"]');
    const sv = el && el.closest('.vditor-sv .mark:not(.vditor-sv__marker)');
    if (ir && r.root.contains(ir) && ir.contains(range.endContainer)) range.selectNodeContents(ir);
    else if (sv && r.root.contains(sv) && sv.contains(range.endContainer)) {
      const prev = sv.previousElementSibling;
      const next = sv.nextElementSibling;
      if (prev && next && prev.textContent === '==' && next.textContent === '==') {
        range.setStartBefore(prev);
        range.setEndAfter(next);
      }
    }
    const text = range.toString();
    if (!text.trim()) { toast('先选中要高亮的文字', { type: 'info' }); return; }
    const m = /^==([\s\S]+)==$/.exec(text.trim());
    const lead = /^\s*/.exec(text)[0];
    const tail = /\s*$/.exec(text)[0];
    let next = m ? lead + m[1] + tail : null;
    let spaced = false;
    if (!m) {
      if (/\n[ \t]*\n/.test(text.trim())) { toast('高亮只能用在同一段文字里，请分段选择', { type: 'info' }); return; }
      // 选区前后同一行的文字：用 Lute 检查加上 == 之后这一行还认不认得出高亮（见 planMark）
      const beside = (before) => {
        try {
          const el = (before ? range.startContainer : range.endContainer);
          const blk = (el.nodeType === 1 ? el : el.parentElement).closest('[data-block="0"]');
          const top = blk && r.root.contains(blk) ? blk : r.root;
          const rr = document.createRange();
          if (before) { rr.setStart(top, 0); rr.setEnd(range.startContainer, range.startOffset); } else { rr.setStart(range.endContainer, range.endOffset); rr.setEnd(top, top.childNodes.length); }
          const s = rr.toString();
          return before ? s.slice(s.lastIndexOf('\n') + 1) : s.split('\n')[0];
        } catch { return ''; }
      };
      const prevText = beside(true);
      const nextText = beside(false);
      const lute = this.vd && this.vd.vditor && this.vd.vditor.lute;
      const cands = markTextCandidates(text, prevText, nextText);
      let pick = cands[0];
      if (lute) {
        try {
          const base = markSignature(lute, prevText + text + nextText);
          pick = cands.find((c) => sameMarkSignature(base,
            markSignature(lute, prevText.slice(0, prevText.length - c.lift) + c.value + nextText.slice(c.lift))));
        } catch { /* 检查不了就按原样加 */ }
      }
      if (!pick) { toast('这里加不了高亮：选区紧挨着加粗等格式时，请把格式的符号（如 **）也选进来', { type: 'info' }); return; }
      next = pick.value;
      spaced = pick.spaced;
      if (pick.lift) shiftRange(range, r.root, pick.lift);
    }
    try {
      this.restoreCaret(range);
      range.deleteContents();
      const esc = next.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
      this.vd.insertValue(esc); // insertValue 把参数当 HTML 插入，所以先转义
      if (spaced) toast('高亮紧挨着标点或加粗、链接等格式，已在旁边加了空格，网站才能认出高亮', { type: 'info' });
    } catch (err) {
      console.error('[editor] highlight failed', err);
      toast('高亮失败，请重试', { type: 'error' });
    }
  }

  /**
   * Vditor 的 input 回调（停止输入 0.8 秒后触发，md 是 Vditor 自己刚生成的 Markdown）。
   * 这里直接用 md，不再调用 getValue()：长文章里每次 getValue 都要把整篇重新转换一遍。
   */
  onEditorInput(md) {
    const v = this.active;
    if (!v || this.settingValue || md === v.markdown) return;
    v.markdown = md;
    this.noteBodyEdit(v);
    this.changed();
  }

  /** 记下「正文被用户改过」（而不是靠比较 Vditor 的输出：它的整理并不稳定）。 */
  noteBodyEdit(v) {
    v.bodyEdited = true;
    v.touched = true;
    v.needsAutosave = true;
  }

  /**
   * 把编辑器里的正文写回当前版本（需要准确快照时调用：保存、离开、切换版本、预览）。
   * Vditor 的 input 回调有 0.8 秒延迟，这里也能发现还没报告的修改。
   */
  syncActive() {
    const v = this.active;
    if (!v || !this.vd) return;
    const cur = this.getEditorValue();
    if (cur !== v.markdown) {
      v.markdown = cur;
      if (!this.settingValue) this.noteBodyEdit(v);
    }
  }

  /** 切换到某个语言版本（各版本的修改都保留在内存里）。 */
  activate(key, { initial = false } = {}) {
    if (!this.variants.has(key)) return;
    if (!initial) this.syncActive();
    this.closeMore();
    this.activeKey = key;
    const v = this.active;
    this.setEditorValue(v.markdown);
    const normalized = this.getEditorValue();
    if (!v.isNew && !v.restored && (v.baseMarkdown === undefined || !v.bodyEdited)) {
      // Vditor 会整理格式（例如单行 $$…$$ 变成多行）；以整理后的结果为「未修改」基准。
      // 没改过的版本每次放回编辑器都重新取基准（Vditor 的整理不是每次都一样）。
      v.baseMarkdown = normalized;
    } else if (v.baseMarkdown === undefined) {
      v.baseMarkdown = null;
    }
    v.markdown = normalized;
    this.els.title.value = v.form.title;
    requestAnimationFrame(() => this.fitTitle());
    this.els.titleError.hidden = true;
    if (this.pendingAutoApply && v.localDraft) {
      this.pendingAutoApply = false;
      this.applyDraft(v, v.localDraft, { silent: true });
      return;
    }
    this.renderAll();
  }

  setEditorValue(md) {
    if (!this.vd) return;
    this.settingValue = true;
    try {
      this.vd.setValue(md || '', true);
    } finally {
      this.settingValue = false;
    }
  }

  // =========================================================================
  // 状态

  /** 某个版本是否有未保存（未提交到 GitHub）的修改。 */
  variantDirty(v) {
    if (v.isNew || v.restored) return true;
    if (JSON.stringify(this.formKeys(v.form)) !== JSON.stringify(this.formKeys(v.baseForm))) return true;
    return this.bodyChanged(v);
  }

  /** 正文是否改过：用户确实编辑过，而且和打开时（Vditor 整理后）的内容不同。不调用 getValue()。 */
  bodyChanged(v) {
    if (!v.bodyEdited) return false;
    if (v.baseMarkdown == null) return v.markdown !== this.displayBodyCached(v);
    return v.markdown !== v.baseMarkdown;
  }

  displayBodyCached(v) {
    if (v._display === undefined) v._display = String(v.rawBody || '').replace(/^(?:[ \t]*\n)+/, '');
    return v._display;
  }

  isDirty() {
    if (this.leaving || this.destroyed) return false;
    for (const v of this.variants.values()) {
      // 新建但完全没动过的文章不算「有修改」
      if (v.isNew && this.isNewGroup && !v.touched && !v.restored && !v.form.title.trim() && !this.getVariantMarkdown(v).trim()) continue;
      if (this.variantDirty(v)) return true;
    }
    return false;
  }

  getVariantMarkdown(v) {
    return v.markdown;
  }

  changed() {
    const v = this.active;
    if (v) { v.needsAutosave = true; v.touched = true; }
    this.autosave(); // 先排队，状态栏才会显示「正在自动保存…」而不是上一次的保存时间
    this.renderTabs();
    this.renderStatus();
    // 有一份还没处理的本机草稿时，新的修改不会自动保存 → 马上让用户选「恢复」还是「丢弃」
    if (v && v.localDraft && !this.pendingAsk && !this.destroyed) this.askPendingDraft(v);
  }

  /**
   * 询问怎么处理一份还没恢复 / 丢弃的本机草稿。
   * @returns {Promise<'restore'|'discard'|null>} null = 关掉了对话框（什么都没做）
   */
  askPendingDraft(v, { publishing = false } = {}) {
    if (this.pendingAsk) return this.pendingAsk;
    const rec = v.localDraft;
    if (!rec) return Promise.resolve('discard');
    const when = rec.updatedAt ? formatDate(new Date(rec.updatedAt)) : '';
    const ask = new Promise((resolve) => {
      let choice = null;
      modal({
        title: '先处理本机未发布的修改',
        dismissible: publishing,
        content: h('div', { class: 'stack-sm stack' },
          h('p', { class: 'modal-message' }, `这台设备上还保存着这一页没有发表的修改（${when}）。` +
            (publishing ? '发表之前，请先决定怎么处理它。' : '在你做出选择之前，新的修改不会自动保存。')),
          h('p', { class: 'muted small' }, '「恢复」会用本机保存的版本替换编辑器里现在的内容；「丢弃」会删除本机保存的版本，之后的修改照常自动保存。')),
        actions: [
          { text: '丢弃本机修改', kind: 'ghost', testid: 'editor-pending-discard', onClick: (close) => { choice = 'discard'; close(); } },
          { text: '恢复本机修改', kind: 'primary', testid: 'editor-pending-restore', autofocus: true, onClick: (close) => { choice = 'restore'; close(); } },
        ],
        onClose: () => resolve(choice),
      });
    }).then(async (choice) => {
      if (!this.destroyed && v.localDraft === rec) {
        if (choice === 'restore') {
          this.applyDraft(v, rec);
        } else if (choice === 'discard') {
          await drafts.deleteDraft(v.draftKey);
          v.localDraft = null;
          if (this.variantDirty(v)) { v.needsAutosave = true; this.autosave(); }
          this.renderBanners();
          this.renderStatus();
          toast('已丢弃本机草稿', { type: 'success' });
        }
      }
      this.pendingAsk = null;
      return choice;
    });
    this.pendingAsk = ask;
    return ask;
  }

  /** 日期在未来时确认。@returns {Promise<'now'|'keep'|null>} */
  askFutureDate(date) {
    return new Promise((resolve) => {
      let choice = null;
      modal({
        title: '文章日期在未来',
        content: h('div', { class: 'stack-sm stack' },
          h('p', { class: 'modal-message' }, `这篇文章的日期是 ${formatDate(date)}，还没到。网站只显示日期已经到了的文章：现在发表的话，要等到这个时间之后网站再次更新，它才会出现。`),
          h('p', { class: 'muted small' }, '如果只是想现在发表，请选「改为现在并发表」。')),
        actions: [
          { text: '取消', kind: 'ghost', testid: 'editor-future-cancel', onClick: (close) => { choice = null; close(); } },
          { text: '仍按这个日期', testid: 'editor-future-keep', onClick: (close) => { choice = 'keep'; close(); } },
          { text: '改为现在并发表', kind: 'primary', testid: 'editor-future-now', autofocus: true, onClick: (close) => { choice = 'now'; close(); } },
        ],
        onClose: () => resolve(choice),
      });
    });
  }

  /** 日期是否在未来（Hugo 默认不显示这样的文章）。 */
  isFuture(date) {
    if (this.kind !== 'post') return false;
    const t = Date.parse(date);
    return Number.isFinite(t) && t > Date.now() + 60 * 1000;
  }

  /**
   * 发表成功后删除本机草稿：只删这个编辑器写的、或打开之前就存在（已经处理过）的草稿。
   * 同一篇文章在另一个标签页里打开时，那边的自动保存不会被这边的发表删掉。
   */
  async cleanupDrafts(keys) {
    for (const key of new Set(keys.filter(Boolean))) {
      const rec = await drafts.loadDraft(key);
      if (!rec) continue;
      const writer = rec.fields && rec.fields.writer;
      if (writer === this.writerId || !(Number(rec.updatedAt) > this.openedAt)) {
        await drafts.deleteDraft(key);
        try { if (this.channel) this.channel.postMessage({ type: 'draft-removed', key, writer: this.writerId }); } catch { /* ignore */ }
      }
    }
  }

  // =========================================================================
  // 自动保存（IndexedDB）

  async autosaveNow() {
    if ((this.destroyed && !this.flushing) || this.discarded) return;
    let saved = false;
    for (const v of this.variants.values()) {
      if (!v.needsAutosave || v.localDraft) continue;
      v.needsAutosave = false;
      if (!v.draftKey) continue;
      if (this.variantDirty(v) && (v.touched || v.restored)) {
        const md = this.getVariantMarkdown(v);
        const images = {};
        for (const name of this.referencedMedia(md, v.form.cover)) {
          const m = this.media.get(name);
          if (m && !m.committed) images[m.kind === 'doc' ? `doc:${name}` : name] = m.blob;
        }
        const ok = await drafts.saveDraft(v.draftKey, {
          title: v.form.title.trim() || '（无标题）',
          markdown: this.toDraftMarkdown(md),
          fields: {
            writer: this.writerId,
            form: clone(v.form),
            kind: this.kind,
            dir: this.group.dir,
            variantKey: v.key,
            isNewVariant: v.isNew,
            newGroup: this.isNewGroup,
            slug: this.slug.value,
            slugTouched: this.slug.touched,
          },
          images,
          path: v.path || undefined,
          baseSha: v.exists ? v.sha : null,
          groupKey: this.group.key || undefined,
          updatedAt: Date.now(),
        });
        this.autosaveOk = ok;
        if (ok) { v.draftWritten = true; saved = true; }
      } else if (v.draftWritten) {
        await drafts.deleteDraft(v.draftKey);
        v.draftWritten = false;
      }
    }
    if (saved) this.lastAutosave = new Date();
    if (!this.destroyed) this.renderStatus();
  }

  /** 立即把待保存的内容写进本机（离开页面 / 登录失效 / 发布前调用）。 */
  flushAutosave() {
    try { this.syncActive(); } catch (err) { console.warn(err); }
    if (this.autosave.pending() || [...this.variants.values()].some((x) => x.needsAutosave)) {
      this.autosave.cancel();
      return this.autosaveNow();
    }
    return undefined;
  }

  // =========================================================================
  // 草稿恢复

  applyDraft(v, rec, { silent = false } = {}) {
    const f = (rec.fields && rec.fields.form) || {};
    const base = this.defaultForm();
    v.form = { ...base, ...v.form, ...clone(f) };
    v.form.tags = strList(v.form.tags);
    v.form.categories = strList(v.form.categories);
    v.markdown = this.fromDraftMarkdown(rec.markdown, rec.images);
    v.bodyEdited = true;
    if (this.isNewGroup && rec.fields) {
      if (rec.fields.slug) this.slug = { value: str(rec.fields.slug), touched: !!rec.fields.slugTouched };
    }
    v.restored = true;
    v.touched = true;
    v.localDraft = null;
    v.draftWritten = true;
    v.stale = !this.isNewGroup && (rec.baseSha ?? null) !== (v.exists ? v.sha : null);
    v.restoredAt = rec.updatedAt;
    if (v === this.active) {
      this.setEditorValue(v.markdown);
      this.els.title.value = v.form.title;
      this.fitTitle();
    }
    this.renderAll();
    if (!silent) toast('已恢复本机保存的修改', { type: 'success' });
    this.resolveImagesLater(v);
  }

  /** 恢复的草稿里引用的、网站上还打不开的图片：读出来后换成 blob 地址（用户还没接着改时）。 */
  async resolveImagesLater(v) {
    const before = v.markdown;
    const found = await this.fetchRepoImages(this.imagePathsIn(before));
    if (!found.size || this.destroyed || v.markdown !== before) return;
    let md = before;
    for (const [p, blob] of found) md = this.swapImage(md, p, blob);
    if (md === before) return;
    v.markdown = md;
    if (v === this.active) {
      this.setEditorValue(md);
      v.markdown = this.getEditorValue();
    }
  }

  async discardDraft(v) {
    const ok = await confirmDialog({
      title: '丢弃本机草稿？',
      message: '这份在本机自动保存、还没有发表的修改会被删除，不能恢复。',
      okText: '丢弃', danger: true,
    });
    if (!ok) return;
    await drafts.deleteDraft(v.draftKey);
    v.localDraft = null;
    this.renderBanners();
    toast('已丢弃本机草稿', { type: 'success' });
  }

  /** 恢复一个还不存在的语言版本的草稿（例如上次没发表的英文版）。 */
  restoreOrphan(o) {
    const lang = o.lang;
    if (this.variants.has(lang)) return;
    const src = this.variants.get('shared') || this.active;
    const v = this.makeVariant({ key: lang, path: o.path, exists: false, sha: null, fmText: src.fmText, fm: src.fm, body: '' });
    v.isNew = true;
    v.draftKey = o.key;
    this.variants.set(lang, v);
    this.sortVariants();
    this.orphanDrafts = this.orphanDrafts.filter((x) => x !== o);
    this.applyDraft(v, o.rec, { silent: true });
    this.activate(lang);
    toast(`已恢复本机保存的${C.variantLabel(lang, this.ctx)}版本`, { type: 'success' });
  }

  async discardOrphan(o) {
    const ok = await confirmDialog({
      title: '丢弃本机草稿？',
      message: `本机保存的「${C.variantLabel(o.lang, this.ctx)}」草稿会被删除，不能恢复。`,
      okText: '丢弃', danger: true,
    });
    if (!ok) return;
    await drafts.deleteDraft(o.key);
    this.orphanDrafts = this.orphanDrafts.filter((x) => x !== o);
    this.renderBanners();
  }

  // =========================================================================
  // 渲染

  renderAll() {
    if (this.destroyed) return;
    this.renderTabs();
    this.renderExplain();
    this.renderBanners();
    this.renderSettings();
    this.renderStatus();
    this.renderSlugHint();
  }

  renderTabs() {
    const els = this.els;
    if (!els.tabs) return;
    const tabs = [];
    for (const v of this.variants.values()) {
      const active = v.key === this.activeKey;
      const dirty = this.variantDirty(v) && !(this.isNewGroup && !v.touched && !v.restored);
      tabs.push(h('button', {
        type: 'button', role: 'tab', class: ['tab', active && 'active'],
        'aria-selected': active ? 'true' : 'false',
        dataset: { testid: `editor-tab-${v.key}` },
        on: { click: () => { if (!active) this.activate(v.key); } },
      },
      C.variantLabel(v.key, this.ctx),
      dirty ? h('span', { class: 'ed-dot', title: '有未发表的修改', 'aria-label': '有未发表的修改' }) : null));
    }
    // 「＋ 单独写英文版」
    const canTranslate = !this.isNewGroup && [...this.variants.values()].some((v) => v.exists);
    if (canTranslate) {
      const hasShared = this.variants.has('shared');
      const specific = this.langs.filter((l) => this.variants.has(l));
      for (const lang of this.langs) {
        if (this.variants.has(lang)) continue;
        if (!hasShared && specific.length === 0) continue;
        tabs.push(h('button', {
          type: 'button', class: 'tab ed-tab-add', dataset: { testid: `editor-add-${lang}` },
          title: hasShared
            ? `复制当前内容，为${this.ctx.siteLabel(lang)}单独写一个版本`
            : `为${this.ctx.siteLabel(lang)}写一个版本`,
          on: { click: () => this.createVariant(lang) },
        }, svgIcon('plus'), hasShared ? `单独写${this.ctx.langName(lang)}版` : `写${this.ctx.langName(lang)}版`));
      }
    }
    render(els.tabs, tabs);
  }

  renderExplain() {
    const parts = [];
    for (const lang of this.langs) {
      const v = this.variants.get(lang) || this.variants.get('shared');
      let text;
      if (!v) text = '没有这一页';
      else {
        text = C.variantLabel(v.key, this.ctx);
        if (!v.exists) text += '（未发表）';
        else if (!v.published) text += '（草稿，暂不显示）';
      }
      parts.push(`${this.ctx.siteLabel(lang)}显示：${text}`);
    }
    this.els.explain.textContent = parts.join(' · ');
  }

  banner(kind, icon, text, actions = [], testid) {
    return h('div', { class: ['banner', `banner-${kind}`], dataset: { testid } },
      svgIcon(icon),
      h('span', {}, text),
      actions.length ? h('div', { class: 'banner-actions' }, actions) : null);
  }

  renderBanners() {
    const els = this.els;
    if (!els.banners) return;
    const v = this.active;
    const list = [];

    if (v.conflict) {
      list.push(this.banner('error', 'warning',
        'GitHub 上的这个文件刚刚被修改过（可能来自另一台设备或 GitHub 网页）。你的修改还保留在编辑器里，也已保存在本机。请选择：',
        [
          h('button', { type: 'button', class: 'btn btn-sm', dataset: { testid: 'editor-conflict-reload' }, on: { click: () => this.reloadVariant(v) } }, '加载最新版本（放弃我的修改）'),
          h('button', { type: 'button', class: 'btn btn-sm btn-primary', dataset: { testid: 'editor-conflict-keep' }, on: { click: () => this.keepMine(v) } }, '保留我的修改'),
        ], 'editor-conflict'));
    }

    if (v.localDraft) {
      const rec = v.localDraft;
      const when = rec.updatedAt ? formatDate(new Date(rec.updatedAt)) : '';
      const changedRemote = !this.isNewGroup && (rec.baseSha ?? null) !== (v.exists ? v.sha : null);
      list.push(this.banner('warning', 'clock',
        `发现本机未发布的修改（${when}）。` + (changedRemote ? '注意：保存这份草稿之后，GitHub 上的文件又被修改过，恢复后发表会覆盖那些修改。' : ''),
        [
          h('button', { type: 'button', class: 'btn btn-sm btn-ghost', dataset: { testid: 'editor-discard-draft' }, on: { click: () => this.discardDraft(v) } }, '丢弃'),
          h('button', { type: 'button', class: 'btn btn-sm btn-primary', dataset: { testid: 'editor-restore' }, on: { click: () => this.applyDraft(v, rec) } }, '恢复'),
        ], 'editor-draft-banner'));
    } else if (v.restored && v.stale) {
      list.push(this.banner('warning', 'warning',
        '已恢复的草稿基于旧版本：保存草稿之后 GitHub 上的文件又被修改过。发表会用你的版本覆盖那些修改。',
        [h('button', { type: 'button', class: 'btn btn-sm btn-ghost', on: { click: () => this.reloadVariant(v, { confirmText: '放弃恢复的草稿，加载 GitHub 上的最新版本？' }) } }, '改为加载最新版本')],
        'editor-stale'));
    }

    if (this.publishedTwin && this.isNewGroup) {
      const t = this.publishedTwin;
      list.push(this.banner('warning', 'warning',
        t.same
          ? `这篇文章看起来已经发表过了（${t.path}），这份是发表时没来得及删除的本机草稿。再发表一次会出现两篇一样的文章。`
          : `文件名「${this.slug.value}」已经被一篇已发表的文章（${t.path}）使用了。如果这篇其实已经发表过，请打开那篇文章；否则请在文章设置里换一个文件名。`,
        [
          h('button', { type: 'button', class: 'btn btn-sm btn-primary', dataset: { testid: 'editor-twin-open' }, on: { click: () => this.openTwin({ discard: true }) } }, t.same ? '丢弃草稿，打开已发表的文章' : '丢弃草稿并打开那篇文章'),
        ], 'editor-twin-banner'));
    }

    for (const o of this.orphanDrafts) {
      const when = o.rec.updatedAt ? formatDate(new Date(o.rec.updatedAt)) : '';
      list.push(this.banner('warning', 'clock',
        `发现本机未发表的「${C.variantLabel(o.lang, this.ctx)}」草稿（${when}）。`,
        [
          h('button', { type: 'button', class: 'btn btn-sm btn-ghost', on: { click: () => this.discardOrphan(o) } }, '丢弃'),
          h('button', { type: 'button', class: 'btn btn-sm btn-primary', dataset: { testid: `editor-restore-${o.lang}` }, on: { click: () => this.restoreOrphan(o) } }, '恢复'),
        ], 'editor-orphan-banner'));
    }

    // 专属版本是草稿、共用版本已发表 → 该语言站点上这一页会消失
    const fmByPath = {};
    for (const x of this.variants.values()) if (x.exists) fmByPath[x.path] = x.fm;
    const repoGroup = { ...this.group, variants: {} };
    for (const x of this.variants.values()) if (x.exists) repoGroup.variants[x.key] = x.path;
    for (const w of C.shadowWarnings(repoGroup, fmByPath, this.langs)) {
      list.push(this.banner('warning', 'warning',
        `${this.ctx.siteLabel(w.lang)}现在看不到这一页：${C.variantLabel(w.lang, this.ctx)}版本是草稿，而且不会改回显示共用版本。发表${this.ctx.langName(w.lang)}版，或删除这个版本即可恢复。`,
        [], 'editor-shadow-warning'));
    }

    if (v.isNew && !this.isNewGroup && v.key !== 'shared' && this.variants.has('shared')) {
      list.push(this.banner('info', 'info',
        `这是新的${C.variantLabel(v.key, this.ctx)}版本（已复制共用版本的内容）。改好后点「发表」，${this.ctx.siteLabel(v.key)}就会显示这个版本。`,
        [], 'editor-new-variant'));
    }
    render(els.banners, list);
    els.banners.hidden = list.length === 0;
  }

  renderStatus() {
    const els = this.els;
    if (!els.status) return;
    const v = this.active;
    let b;
    if (!v.exists) b = badge('未发表', 'orange');
    else if (v.published && this.isFuture(v.baseForm.date)) {
      b = badge('定时发表', 'blue');
      b.title = '日期还没到：到了这个时间之后，网站再次更新时才会显示';
    } else if (v.published) b = badge('已发表', 'green');
    else b = badge('草稿', 'gray');
    render(els.status, b);

    // 发表按钮文字：已发表的文件 → 「更新」
    const label = v.exists && v.published ? '更新' : '发表';
    els.publishBtn.querySelector('.ed-publish-text').textContent = label;
    els.publishBtn.title = v.exists && v.published ? '把修改更新到网站上（Ctrl/⌘+S）' : '发表到网站上';
    els.draftBtn.title = v.exists && v.published ? '改为草稿：网站上将不再显示' : '保存为草稿（不会在网站上显示，Ctrl/⌘+S）';
    els.draftBtn.setAttribute('aria-label', v.exists && v.published ? '改为草稿（网站上将不再显示）' : '保存草稿');
    const draftText = els.draftBtn.querySelector('.ed-btn-text');
    if (draftText) {
      draftText.textContent = v.exists && v.published ? '改为草稿' : '保存草稿';
      draftText.dataset.short = v.exists && v.published ? '转草稿' : '存草稿';
    }

    // 自动保存状态
    const dirty = this.isDirty();
    let text = '';
    let cls = '';
    if (!this.autosaveOk) {
      text = '这个浏览器无法自动保存到本机，请及时保存';
      cls = 'text-danger';
    } else if (dirty && [...this.variants.values()].some((x) => x.localDraft && this.variantDirty(x))) {
      text = '修改还没有自动保存：请先处理上方的本机草稿';
      cls = 'text-danger';
    } else if (dirty && this.lastAutosave && !this.autosave.pending()) {
      text = `已自动保存到本机 · ${pad2(this.lastAutosave.getHours())}:${pad2(this.lastAutosave.getMinutes())}`;
    } else if (dirty && this.autosave.pending()) {
      text = '正在自动保存…';
    } else if (dirty) {
      text = '有未发表的修改';
    } else if (v.exists) {
      text = v.published ? '已是网站上的最新内容' : '已保存为草稿';
    }
    els.autosave.textContent = text;
    els.autosave.className = ['ed-autosave', 'small', cls || 'muted'].join(' ');

    // 手机端设置摘要
    const sum = this.els.settingsToggle && this.els.settingsToggle.querySelector('.ed-settings-summary');
    if (sum) {
      sum.textContent = this.kind === 'post'
        ? [v.form.tags.length ? `${v.form.tags.length} 个标签` : '', v.form.date ? formatDate(v.form.date).slice(0, 10) : ''].filter(Boolean).join(' · ')
        : (v.form.inMenu ? `菜单顺序 ${v.form.weight || '—'}` : '不在菜单中');
    }
  }

  // ----- 设置面板 -----

  field(label, control, { hint, id, error, optional } = {}) {
    if (id && control && !control.id) control.id = id;
    return h('div', { class: 'field' },
      h('label', { htmlFor: id || undefined }, label, optional ? h('span', { class: 'optional' }, '（可选）') : null),
      control,
      hint ? h('div', { class: 'hint' }, hint) : null,
      error || null);
  }

  switchField(label, checked, onChange, { hint, testid } = {}) {
    const input = h('input', { type: 'checkbox', checked, dataset: { testid }, 'aria-label': label });
    input.addEventListener('change', () => onChange(input.checked));
    return h('div', { class: 'field ed-switch-field' },
      h('div', { class: 'row row-between row-nowrap' },
        h('span', { class: 'label' }, label),
        h('label', { class: 'switch' }, input, h('span'))),
      hint ? h('div', { class: 'hint' }, hint) : null);
  }

  chipInput(values, onChange, { placeholder, testid, id }) {
    const chips = h('div', { class: 'chips ed-chip-list' });
    const input = h('input', {
      class: 'ed-chip-input', type: 'text', placeholder, id, autocomplete: 'off', enterkeyhint: 'done',
      dataset: { testid },
    });
    let list = [...values];
    const draw = () => {
      render(chips, list.map((t, i) => h('span', { class: 'chip' },
        h('span', {}, t),
        h('button', {
          type: 'button', 'aria-label': `删除「${t}」`,
          on: { click: () => { list.splice(i, 1); draw(); onChange([...list]); input.focus(); } },
        }, svgIcon('close')))));
    };
    const add = () => {
      const parts = input.value.split(/[,，、;；]/).map((s) => s.trim()).filter(Boolean);
      if (!parts.length) { input.value = ''; return false; }
      let added = false;
      for (const p of parts) if (!list.includes(p)) { list.push(p); added = true; }
      input.value = '';
      draw();
      if (added) onChange([...list]);
      return true;
    };
    input.addEventListener('keydown', (e) => {
      if (e.isComposing) return;
      if (e.key === 'Enter') { e.preventDefault(); add(); } else if (e.key === 'Backspace' && !input.value && list.length) {
        list.pop(); draw(); onChange([...list]);
      }
    });
    input.addEventListener('input', () => { if (/[,，、;；]/.test(input.value)) add(); });
    input.addEventListener('blur', () => add());
    draw();
    const wrap = h('div', { class: 'input ed-chips', on: { click: (e) => { if (e.target === wrap || e.target === chips) input.focus(); } } }, chips, input);
    return wrap;
  }

  renderSettings() {
    const els = this.els;
    if (!els.settingsBody) return;
    const v = this.active;
    const f = v.form;
    const set = (key, val) => { f[key] = val; this.changed(); };
    const items = [];

    if (this.kind === 'post') {
      if (this.isNewGroup) {
        const slugInput = h('input', {
          class: 'input mono', type: 'text', value: this.slug.value, placeholder: 'my-first-post',
          autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', maxlength: 81,
          dataset: { testid: 'editor-slug' },
        });
        const urlHint = h('div', { class: 'hint' });
        const err = h('div', { class: 'error', role: 'alert', dataset: { testid: 'editor-slug-error' } });
        const update = () => {
          const e = this.slugError();
          err.textContent = e || '';
          err.hidden = !e || !this.slug.value;
          slugInput.setAttribute('aria-invalid', e && this.slug.value ? 'true' : 'false');
          urlHint.textContent = `网址：/posts/${this.slug.value || '…'}/ · 只能用小写字母、数字和 -`;
        };
        slugInput.addEventListener('input', () => {
          const raw = slugInput.value;
          const cleaned = raw.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-{2,}/g, '-');
          if (cleaned !== raw) slugInput.value = cleaned;
          this.slug.value = cleaned.replace(/^-+/, '');
          this.slug.touched = this.slug.value !== '';
          if (!this.slug.touched) this.updateSlugSuggestion();
          update();
          this.renderSlugHint();
          this.changed();
        });
        slugInput.addEventListener('blur', () => {
          const t = this.slug.value.replace(/-+$/, '');
          if (t !== this.slug.value) { this.slug.value = t; slugInput.value = t; update(); }
        });
        els.slugInput = slugInput;
        els.slugUpdate = update;
        update();
        items.push(h('div', { class: 'field' },
          h('label', { htmlFor: 'ed-slug' }, '文件名（网址）'),
          Object.assign(slugInput, { id: 'ed-slug' }), urlHint, err));
      } else {
        items.push(h('div', { class: 'field' },
          h('span', { class: 'label' }, '文件'),
          h('div', { class: 'ed-path mono small', title: v.path || '' }, v.path || '（保存后生成）')));
      }

      const dateInput = h('input', {
        class: 'input', type: 'datetime-local', id: 'ed-date', value: toLocalInput(f.date), step: 60,
        dataset: { testid: 'editor-date' },
      });
      dateInput.addEventListener('change', () => {
        if (!dateInput.value) { set('date', v.baseForm.date); return; }
        const d = new Date(dateInput.value);
        if (Number.isNaN(d.getTime())) return;
        set('date', hugoDate(d));
      });
      items.push(this.field('日期', dateInput, { id: 'ed-date', hint: f.date && !toLocalInput(f.date) ? `原值：${f.date}` : null }));

      const desc = h('textarea', { class: 'input', id: 'ed-desc', rows: 3, value: f.description, placeholder: '一两句话介绍这篇文章，会显示在文章列表里', dataset: { testid: 'editor-description' } });
      desc.addEventListener('input', () => set('description', desc.value));
      items.push(this.field('摘要', desc, { id: 'ed-desc', optional: true }));

      items.push(this.field('标签', this.chipInput(f.tags, (list) => set('tags', list), { placeholder: '输入后按回车添加', testid: 'editor-tags', id: 'ed-tags' }), { id: 'ed-tags', optional: true }));
      items.push(this.field('分类', this.chipInput(f.categories, (list) => set('categories', list), { placeholder: '输入后按回车添加', testid: 'editor-categories', id: 'ed-cats' }), { id: 'ed-cats', optional: true }));

      items.push(this.coverField(v));

      items.push(this.switchField('数学公式', f.math, (on) => set('math', on), {
        testid: 'editor-math',
        hint: `全站默认${this.siteDefaults.math ? '开启' : '关闭'}；关闭后页面不加载公式组件。`,
      }));
      items.push(this.switchField('评论区', f.comments, (on) => set('comments', on), {
        testid: 'editor-comments',
        hint: `全站默认${this.siteDefaults.comments ? '开启' : '关闭'}。`,
      }));

      const sel = h('select', { class: 'input', id: 'ed-effect', dataset: { testid: 'editor-effect' } });
      const defName = this.siteDefaults.effect ? (this.effectNames[this.siteDefaults.effect] || this.siteDefaults.effect) : '';
      sel.appendChild(h('option', { value: '' }, defName ? `跟随全站设置（${defName}）` : '跟随全站设置'));
      const names = [...this.effects];
      if (f.effect && !names.includes(f.effect)) names.push(f.effect);
      for (const n of names) sel.appendChild(h('option', { value: n }, this.effectLabel(n)));
      sel.value = f.effect;
      sel.addEventListener('change', () => set('effect', sel.value));
      els.effectSelect = sel;
      const bgOff = isPlainObject(v.fm.background) && v.fm.background.enabled === false;
      items.push(this.field('背景动画', sel, { id: 'ed-effect', hint: bgOff ? '这篇文章设置了 background.enabled: false（不显示背景动画）。' : null }));
    } else {
      items.push(h('div', { class: 'field' },
        h('span', { class: 'label' }, '文件'),
        h('div', { class: 'ed-path mono small', title: v.path || '' }, v.path || '')));
      const lt = h('input', { class: 'input', type: 'text', id: 'ed-linktitle', value: f.linkTitle, placeholder: f.title || '和标题相同', dataset: { testid: 'editor-linktitle' } });
      lt.addEventListener('input', () => set('linkTitle', lt.value));
      items.push(this.field('菜单名称', lt, { id: 'ed-linktitle', hint: '顶部菜单里显示的名字，留空则使用标题。', optional: true }));

      const weight = h('input', { class: 'input', type: 'number', id: 'ed-weight', step: 1, inputmode: 'numeric', value: f.weight, dataset: { testid: 'editor-weight' } });
      const weightField = this.field('菜单顺序', weight, { id: 'ed-weight', hint: '数字越小越靠左。只修改当前这个语言版本。' });
      weightField.hidden = !f.inMenu;
      weight.addEventListener('input', () => set('weight', weight.value.trim()));
      items.push(this.switchField('显示在顶部菜单', f.inMenu, (on) => {
        f.inMenu = on;
        weightField.hidden = !on;
        this.changed();
      }, { testid: 'editor-inmenu' }));
      items.push(weightField);

      const desc = h('textarea', { class: 'input', id: 'ed-desc', rows: 3, value: f.description, dataset: { testid: 'editor-description' } });
      desc.addEventListener('input', () => set('description', desc.value));
      items.push(this.field('描述', desc, { id: 'ed-desc', optional: true }));
    }
    render(els.settingsBody, items);
    this.renderStatus();
  }

  coverField(v) {
    const f = v.form;
    const fileInput = h('input', { type: 'file', accept: 'image/*', hidden: true, dataset: { testid: 'editor-cover-input' } });
    fileInput.addEventListener('change', async () => {
      const file = fileInput.files && fileInput.files[0];
      fileInput.value = '';
      if (!file) return;
      const added = await this.prepareImage(file);
      if (!added) return;
      f.cover = PENDING + added.name;
      this.changed();
      this.renderSettings();
    });
    const url = this.coverDisplayUrl(f.cover);
    const pick = h('button', { type: 'button', class: 'btn btn-sm', dataset: { testid: 'editor-cover-upload' }, on: { click: () => fileInput.click() } },
      svgIcon('upload'), f.cover ? '更换' : '上传封面图');
    const remove = f.cover ? h('button', {
      type: 'button', class: 'btn btn-sm btn-ghost btn-danger', dataset: { testid: 'editor-cover-remove' },
      on: { click: () => { f.cover = ''; this.changed(); this.renderSettings(); } },
    }, svgIcon('trash'), '移除') : null;
    const thumb = f.cover
      ? h('div', { class: 'ed-cover-thumb' },
        url ? h('img', { src: url, alt: '封面图预览' }) : h('span', { class: 'muted small' }, '无法预览'),
      )
      : h('div', { class: 'ed-cover-empty muted small', on: { click: () => fileInput.click() } }, svgIcon('image'), '没有封面图');
    return h('div', { class: 'field' },
      h('span', { class: 'label' }, '封面图', h('span', { class: 'optional' }, '（可选）')),
      thumb,
      h('div', { class: 'row' }, pick, remove, fileInput),
      f.cover && !f.cover.startsWith(PENDING) ? h('div', { class: 'hint mono truncate', title: f.cover }, f.cover) : null);
  }

  updateSlugSuggestion() {
    this.slug.value = C.suggestSlug(this.active.form.title, this.existingBases);
    if (this.els.slugInput) {
      this.els.slugInput.value = this.slug.value;
      this.els.slugUpdate && this.els.slugUpdate();
    }
    this.renderSlugHint();
  }

  /**
   * 全中文标题时自动生成的网址是 post-日期，没有意义；而手机上网址输入框藏在折叠的设置里。
   * 在标题下面提示一下（不拦着发表）。
   */
  renderSlugHint() {
    const el = this.els.slugHint;
    if (!el) return;
    const show = this.isNewGroup && this.kind === 'post' && !this.slug.touched &&
      /^post-\d{8}(-\d+)?$/.test(this.slug.value) && !!this.active.form.title.trim();
    el.hidden = !show;
    if (!show) return;
    render(el,
      svgIcon('info'),
      h('span', {}, `网址会是 /posts/${this.slug.value}/。建议改成英文或拼音（如 harmonic-oscillator），发表后就不能改了。`),
      h('button', {
        type: 'button', class: 'btn btn-ghost btn-sm', dataset: { testid: 'editor-slug-hint-edit' },
        on: { click: () => this.focusSlug() },
      }, '修改网址'));
  }

  focusSlug() {
    this.toggleSettings(true);
    const input = this.els.slugInput;
    if (!input) return;
    input.scrollIntoView({ block: 'center', behavior: 'smooth' });
    input.focus({ preventScroll: true });
    input.select();
  }

  slugError() {
    const s = this.slug.value;
    if (!s) return '请填写文件名（只用小写字母、数字和 -）';
    if (!C.isValidSlug(s)) return '文件名只能包含小写字母、数字和 -，并以字母或数字开头';
    if (this.existingBases.has(s.toLowerCase())) return '已经有同名的文章了，请换一个文件名';
    return null;
  }

  // =========================================================================
  // 图片与资料

  /** 压缩并登记一张图片；返回 { name, url } 或 null。 */
  async prepareImage(file) {
    const ext = extOf(file.name || '');
    let result;
    try {
      result = await compressImage(file, { maxWidth: LIMITS.imageMaxWidth, quality: LIMITS.imageQuality });
    } catch (err) {
      console.warn('[editor] compress failed', err);
      result = { blob: file, ext: ext || 'jpg', changed: false };
    }
    const blob = result.blob;
    if (blob.size >= LIMITS.maxFileMB * MB) {
      toast(`图片「${file.name}」太大（${formatBytes(blob.size)}），超过 ${LIMITS.maxFileMB} MB，无法上传`, { type: 'error' });
      return null;
    }
    if (blob.size >= LIMITS.warnFileMB * MB) {
      toast(`图片「${file.name}」比较大（${formatBytes(blob.size)}），网页打开会变慢`, { type: 'warning' });
    }
    if ((ext === 'heic' || ext === 'heif') && !result.changed) {
      toast('HEIC 格式的照片很多浏览器显示不了，建议在手机上导出为 JPG 后再上传', { type: 'warning', timeout: 8000 });
    }
    const outExt = result.ext || ext || 'jpg';
    const name = timestampName(`${stemOf(file.name || 'image')}.${outExt}`);
    return this.addMedia(name, blob, 'image');
  }

  /** 资料（非图片文件）：放进 static/documents/，与文章一起提交。 */
  prepareDocument(file) {
    if (file.size >= LIMITS.maxFileMB * MB) {
      toast(`文件「${file.name}」太大（${formatBytes(file.size)}），超过 ${LIMITS.maxFileMB} MB，无法上传`, { type: 'error' });
      return null;
    }
    if (file.size >= LIMITS.warnFileMB * MB) {
      toast(`文件「${file.name}」比较大（${formatBytes(file.size)}），上传会慢一些`, { type: 'warning' });
    }
    return this.addMedia(safeFileName(file.name || 'file'), file, 'doc');
  }

  /** Vditor 的上传入口：工具栏上传按钮、粘贴、拖入都会走这里。 */
  async onFiles(files) {
    const list = [...(files || [])];
    if (!list.length) return null;
    const parts = [];
    let busy = null;
    if (list.length > 1 || list.some((f) => f.size > 2 * MB)) busy = toast('正在处理图片…', { type: 'info', timeout: 0 });
    try {
      for (const file of list) {
        if (isImageFile(file)) {
          const m = await this.prepareImage(file);
          if (m) parts.push(`![${linkText(stemOf(file.name))}](${m.url})`);
        } else {
          const m = this.prepareDocument(file);
          if (m) parts.push(`[${linkText(file.name)}](${this.docSitePath(m.name)})`);
        }
      }
    } finally {
      if (busy) busy.close();
    }
    if (parts.length) {
      this.moveCaretOutOfBlock();
      this.insertMarkdown(parts.join('\n\n') + '\n');
      toast(parts.length > 1 ? `已插入 ${parts.length} 个文件，发表时一起上传` : '已插入，发表时一起上传', { type: 'success' });
    }
    return null;
  }

  /**
   * 「多图并排」/「带说明的图片」：选图片 → 压缩 → 插入网站的 {{< gallery >}} / Hugo 自带的 {{< figure >}} 短代码。
   * 图片先用 admin-pending://名字 占位，发表时换成网站路径（和普通图片一样随文章一起上传）。
   */
  pickImages(kind) {
    const caret = this.saveCaret();
    const input = h('input', { type: 'file', accept: 'image/*', multiple: kind === 'gallery', hidden: true, dataset: { testid: `editor-${kind}-input` } });
    this.els.pickInput && this.els.pickInput.remove();
    this.els.pickInput = input;
    this.els.vditor.after(input);
    input.addEventListener('change', async () => {
      const files = [...(input.files || [])].filter(isImageFile);
      input.remove();
      if (!files.length) return;
      const list = [];
      for (const f of files) {
        const m = await this.prepareImage(f);
        if (m) list.push(m);
      }
      if (!list.length || this.destroyed) return;
      let md;
      if (kind === 'figure') {
        const caption = await promptDialog({
          title: '图片说明', label: '显示在图片下方的说明文字', placeholder: '图：……', okText: '插入',
          hint: '可以留空。发表后网站上会显示在图片正下方。',
        });
        if (caption === null || this.destroyed) return;
        md = `{{< figure src="${PENDING}${list[0].name}"` + (caption.trim() ? ` caption="${scArg(caption)}"` : '') + ' >}}';
      } else {
        md = `{{< gallery ${list.map((m) => `"${PENDING}${m.name}"`).join(' ')} >}}`;
      }
      this.restoreCaret(caret);
      this.moveCaretOutOfBlock();
      this.insertMarkdown(`\n${md}\n`);
      toast(kind === 'gallery' ? `已插入 ${list.length} 张并排的图片（点「手机预览」看效果），发表时一起上传` : '已插入带说明的图片（点「手机预览」看效果），发表时一起上传', { type: 'success', timeout: 6000 });
    });
    input.click();
  }

  /** 「资料」按钮：选择 static/documents/ 里的文件插入链接，或上传新资料。 */
  openDocuments() {
    const files = this.repo.list(PATHS.documents + '/');
    const pending = [...this.media.entries()].filter(([, m]) => m.kind === 'doc' && !m.committed).map(([name]) => ({ path: `${PATHS.documents}/${name}`, size: this.media.get(name).blob.size, pending: true }));
    const all = [...pending, ...files];
    const search = h('input', { class: 'input', type: 'search', placeholder: '搜索资料…', 'aria-label': '搜索资料', dataset: { testid: 'editor-docs-search' } });
    const listEl = h('div', { class: 'list ed-doc-list' });
    let m;
    const caret = this.saveCaret();
    const insertAtCaret = (md) => {
      // 对话框里的搜索框拿走了光标、关闭时焦点又回到了工具栏按钮（m.close() 是同步的）：
      // 先把焦点和光标放回打开对话框之前的位置再插入（否则会插到文章开头，再按空格还会重新打开对话框）
      if (this.destroyed) return;
      this.restoreCaret(caret);
      this.moveCaretOutOfBlock();
      this.insertMarkdown(md);
    };
    const insert = (path) => {
      const name = path.slice(path.lastIndexOf('/') + 1);
      m.close();
      insertAtCaret(`[${linkText(name)}](${mdDest(C.sitePathFor(path))})`);
    };
    const draw = () => {
      const q = search.value.trim().toLowerCase();
      const shown = all.filter((f) => !q || f.path.toLowerCase().includes(q));
      if (!shown.length) {
        render(listEl, h('div', { class: 'empty ed-doc-empty' }, h('div', { class: 'empty-text' }, all.length ? '没有找到匹配的资料' : '资料库还是空的。可以先上传一个文件。')));
        return;
      }
      render(listEl, shown.slice(0, 200).map((f) => h('button', {
        type: 'button', class: 'list-item ed-doc-item', dataset: { testid: 'editor-doc-item' }, on: { click: () => insert(f.path) },
      },
      h('div', { class: 'list-item-main' },
        h('div', { class: 'list-item-title' }, f.path.slice(PATHS.documents.length + 1)),
        h('div', { class: 'list-item-meta' }, C.sitePathFor(f.path), ' · ', formatBytes(f.size), f.pending ? badge('待上传', 'orange') : null)),
      svgIcon('plus'))));
    };
    search.addEventListener('input', draw);
    const upload = h('input', { type: 'file', multiple: true, hidden: true, dataset: { testid: 'editor-docs-upload' } });
    upload.addEventListener('change', () => {
      const chosen = [...(upload.files || [])];
      upload.value = '';
      if (!chosen.length) return;
      const parts = [];
      for (const file of chosen) {
        const added = this.prepareDocument(file);
        if (added) parts.push(`[${linkText(file.name)}](${this.docSitePath(added.name)})`);
      }
      m.close();
      if (parts.length) {
        insertAtCaret(parts.join('\n\n') + '\n');
        toast('已插入资料链接，发表时一起上传', { type: 'success' });
      }
    });
    draw();
    m = modal({
      title: '插入资料链接',
      content: h('div', { class: 'stack-sm stack' },
        h('p', { class: 'muted small' }, '资料放在 static/documents/ 里，点一下插入链接；也可以上传新文件（随文章一起发表）。'),
        search, listEl, upload),
      actions: [
        { text: '取消', kind: 'ghost' },
        { text: '上传新资料…', kind: 'primary', testid: 'editor-docs-upload-btn', onClick: () => { upload.click(); } },
      ],
    });
  }

  // =========================================================================
  // 语言版本

  createVariant(lang) {
    if (this.variants.has(lang)) { this.activate(lang); return; }
    this.syncActive();
    const src = this.active;
    const path = C.variantPath(this.group.dir, this.group.base, lang);
    const v = this.makeVariant({ key: lang, path, exists: false, sha: null, fmText: src.fmText, fm: src.fm, body: '' });
    v.form = clone(src.form);
    v.markdown = src.markdown;
    if (!src.isNew && !src.restored && typeof src.baseMarkdown === 'string') {
      v.copyBase = src.baseMarkdown;
      v.copyRaw = src.rawBody;
    } else if (src.copyBase != null) {
      v.copyBase = src.copyBase;
      v.copyRaw = src.copyRaw;
    }
    v.bodyEdited = true;
    v.isNew = true;
    v.touched = true;
    v.needsAutosave = true;
    this.variants.set(lang, v);
    this.sortVariants();
    this.activate(lang);
    this.changed();
    toast(`已复制当前内容作为${C.variantLabel(lang, this.ctx)}版本，修改后点「发表」`, { type: 'success' });
    this.els.title.focus();
  }

  // =========================================================================
  // 保存 / 发表

  onKeyDown(e) {
    if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
    if ((e.key || '').toLowerCase() !== 's') return;
    e.preventDefault();
    e.stopPropagation();
    if (document.documentElement.classList.contains('ui-locked')) return; // 有弹窗打开时忽略
    const v = this.active;
    this.save(v.exists && v.published ? 'publish' : 'draft');
  }

  sharedPublished() {
    const s = this.variants.get('shared');
    return !!(s && s.exists && s.published);
  }

  /** blob 地址 / 占位符 → 网站路径。 */
  toSiteMarkdown(md, names, imgDir) {
    let out = md;
    for (const name of names) {
      const m = this.media.get(name);
      if (!m || m.kind !== 'image') continue;
      const site = this.mediaDest(name, imgDir);
      if (m.url) out = out.split(m.url).join(site);
      out = out.split(PENDING + name).join(site);
    }
    return out;
  }

  /** 生成要写入的正文和用到的待上传文件。 */
  finalBody(v, imgDir) {
    const current = v.markdown;
    const unchanged = !v.isNew && !v.restored && !this.bodyChanged(v);
    const used = this.referencedMedia(current, v.form.cover);
    if (unchanged) return { body: v.rawBody, unchanged: true, used: used.filter((n) => v.form.cover === PENDING + n), current };
    let md = this.toSiteMarkdown(current, used, imgDir);
    // 没有登记过的 blob 地址（理论上不会出现）不能写进文件
    if (/\]\(blob:|["']blob:/.test(md)) {
      throw new Error('正文里有图片还没有处理完（blob 地址）。请删除这些图片后重新插入。');
    }
    // 只把真正改过的行换成 Vditor 的输出，其余保留文件原文（行尾两个空格的换行、{#id}、链接标题…）
    const base = !v.isNew && typeof v.baseMarkdown === 'string' ? v.baseMarkdown : v.copyBase;
    const raw = !v.isNew && typeof v.baseMarkdown === 'string' ? v.rawBody : v.copyRaw;
    if (typeof base === 'string' && typeof raw === 'string') {
      const baseSite = this.toSiteMarkdown(base, [...this.media.keys()], imgDir);
      const theirs = String(raw).replace(/^(?:[ \t]*\n)+/, '');
      const merged = mergeBody(baseSite, md, theirs);
      if (merged !== null) {
        if (!v.isNew && merged.replace(/\s+$/, '') === theirs.replace(/\s+$/, '')) {
          return { body: v.rawBody, unchanged: true, used: used.filter((n) => v.form.cover === PENDING + n), current };
        }
        md = merged;
      }
    }
    return { body: md, unchanged: false, used, current };
  }

  computeUpdates(v, mode, imgDir) {
    const u = {};
    const f = v.form;
    const b = v.baseForm;
    const fm = v.fm || {};
    const wantDraft = mode === 'draft';
    if (C.isDraftFm(fm) !== wantDraft) u.draft = wantDraft;
    if (f.title !== b.title) u.title = f.title.trim();
    if (f.description !== b.description) u.description = f.description.trim() ? f.description.trim() : undefined;
    if (this.kind === 'post') {
      if (f.date !== b.date) u.date = f.date || undefined;
      if (!sameList(f.tags, b.tags)) u.tags = f.tags.length ? [...f.tags] : undefined;
      if (!sameList(f.categories, b.categories)) u.categories = f.categories.length ? [...f.categories] : undefined;
      if (f.cover !== b.cover) {
        const cover = isPlainObject(fm.cover) ? { ...fm.cover } : {};
        const val = this.resolveCover(f.cover, imgDir);
        if (val) cover.image = val; else delete cover.image;
        u.cover = Object.keys(cover).length ? cover : undefined;
      }
      if (f.math !== b.math) u.math = f.math;
      if (f.comments !== b.comments) u.comments = f.comments;
      if (f.effect !== b.effect) {
        const bg = isPlainObject(fm.background) ? { ...fm.background } : {};
        if (f.effect) bg.effect = f.effect; else delete bg.effect;
        u.background = Object.keys(bg).length ? bg : undefined;
      }
    } else {
      if (f.linkTitle !== b.linkTitle) u.linkTitle = f.linkTitle.trim() ? f.linkTitle.trim() : undefined;
      if (f.inMenu !== b.inMenu || f.weight !== b.weight) u.menu = buildMenu(fm.menu, f.inMenu, f.weight);
    }
    return u;
  }

  newFields(v, mode, imgDir) {
    const f = v.form;
    const out = { title: f.title.trim() };
    if (this.kind === 'post') {
      out.date = f.date || hugoDate();
      out.draft = mode === 'draft';
      if (f.description.trim()) out.description = f.description.trim();
      if (f.tags.length) out.tags = [...f.tags];
      if (f.categories.length) out.categories = [...f.categories];
      const cover = this.resolveCover(f.cover, imgDir);
      if (cover) out.cover = { image: cover };
      if (f.math !== this.siteDefaults.math) out.math = f.math;
      if (f.comments !== this.siteDefaults.comments) out.comments = f.comments;
      if (f.effect) out.background = { effect: f.effect };
    } else {
      if (f.linkTitle.trim()) out.linkTitle = f.linkTitle.trim();
      out.draft = mode === 'draft';
      if (f.description.trim()) out.description = f.description.trim();
      const menu = buildMenu(undefined, f.inMenu, f.weight);
      if (menu) out.menu = menu;
    }
    return out;
  }

  resolveCover(cover, imgDir) {
    if (!cover) return '';
    if (cover.startsWith(PENDING)) return this.imageSitePath(cover.slice(PENDING.length), imgDir);
    return cover;
  }

  validate(v) {
    if (!v.form.title.trim()) {
      this.els.titleError.hidden = false;
      this.els.title.focus();
      toast('请先填写标题', { type: 'warning' });
      return false;
    }
    if (this.isNewGroup && this.kind === 'post') {
      const err = this.slugError();
      if (err) {
        this.toggleSettings(true);
        if (this.els.slugInput) {
          this.els.slugInput.focus();
          this.els.slugUpdate && this.els.slugUpdate();
        }
        toast(err, { type: 'warning' });
        return false;
      }
    }
    if (this.kind === 'page' && v.form.inMenu && v.form.weight && !/^-?\d+$/.test(v.form.weight)) {
      this.toggleSettings(true);
      toast('菜单顺序请填写整数', { type: 'warning' });
      return false;
    }
    return true;
  }

  async save(mode) {
    if (this.saving) return;
    if (this.ctx.isPublishing && this.ctx.isPublishing()) {
      toast('正在发布，请稍候', { type: 'warning' });
      return;
    }
    const btn = mode === 'draft' ? this.els.draftBtn : this.els.publishBtn;
    this.saving = true;
    try {
      await withBusy(btn, () => this.doSave(mode));
    } finally {
      this.saving = false;
    }
  }

  async doSave(mode) {
    this.syncActive();
    const v = this.active;
    if (v.conflict) {
      toast('请先在上方选择「保留我的修改」或「加载最新版本」', { type: 'warning' });
      return;
    }
    // 还没处理的本机草稿：发表后会被删除，先让用户决定
    if (v.localDraft) {
      const choice = await this.askPendingDraft(v, { publishing: true });
      if (choice !== 'discard') return;
    }
    // 新文章的文件名已经被一篇「同标题」的已发表文章占用：多半是上一次发表其实成功了（发表途中网络断了、
    // 页面被关掉）。给出打开那篇文章的按钮，而不是只让用户换个文件名（那样会出现两篇一样的文章）。
    if (this.isNewGroup && this.kind === 'post' && this.slug.value && this.repo.has(C.variantPath(PATHS.posts, this.slug.value, null))) {
      const prev = this.publishedTwin;
      await this.checkPublishedTwin({ fields: { form: v.form } });
      if (this.destroyed) return;
      if (this.publishedTwin && this.publishedTwin.same) {
        this.renderBanners();
        toast('这篇文章看起来已经发表过了（网站上有同名、同标题的文章）。请点上方的按钮打开它，不要换文件名再发表一次。', { type: 'warning', timeout: 9000 });
        return;
      }
      this.publishedTwin = prev;
    }
    if (!this.validate(v)) return;

    // 日期在未来：Hugo 默认不构建未来日期的文章，网站上会暂时看不到
    if (mode === 'publish' && this.isFuture(v.form.date)) {
      const choice = await this.askFutureDate(v.form.date);
      if (!choice) return;
      if (choice === 'now') {
        v.form.date = hugoDate();
        this.renderSettings();
      }
    }

    // 确认：专属版本存为草稿会让该语言站点上的页面消失；已发表的文章改为草稿会下线
    if (mode === 'draft') {
      if (v.key !== 'shared' && this.sharedPublished()) {
        const ok = await confirmDialog({
          title: `${this.ctx.siteLabel(v.key)}上将看不到这一页`,
          message: `把${C.variantLabel(v.key, this.ctx)}版本保存为草稿后，${this.ctx.siteLabel(v.key)}上这一页会消失 —— 它不会改回显示共用版本。\n\n如果只是想暂存修改，不用担心：修改已经自动保存在这台设备上。`,
          okText: '仍然保存为草稿', danger: true,
        });
        if (!ok) return;
      } else if (v.exists && v.published) {
        const ok = await confirmDialog({
          title: '改为草稿？',
          message: '这一页已经发表了。保存为草稿后，网站上将不再显示它，直到你再次发表。',
          okText: '改为草稿', danger: true,
        });
        if (!ok) return;
      }
    }

    const path = this.isNewGroup && this.kind === 'post'
      ? C.variantPath(PATHS.posts, this.slug.value, null)
      : v.path;
    if (this.isNewGroup && this.repo.has(path)) {
      toast('已经有同名的文件了，请换一个文件名', { type: 'warning' });
      return;
    }
    // 新文章第一次发表时把日期固定下来：万一这次发表的结果没收到（网络中断），再点一次发表的内容逐字节相同，
    // 不会被当成「别人改过」
    if (this.kind === 'post' && v.isNew && !v.form.date) {
      v.form.date = hugoDate();
      v.needsAutosave = true;
    }
    const imgDir = this.imageDir();

    let content;
    let body;
    let used;
    let newFm;
    let bodyUnchanged = false;
    try {
      const fb = this.finalBody(v, imgDir);
      body = fb.body;
      used = fb.used;
      bodyUnchanged = fb.unchanged;
      if (v.isNew && v.fmText === null) {
        newFm = newFrontMatter(this.newFields(v, mode, imgDir));
      } else {
        const updates = this.computeUpdates(v, mode, imgDir);
        const hasUpdates = Object.keys(updates).length > 0;
        newFm = v.fmText === null && !hasUpdates ? null : setFields(v.fmText ?? '', updates);
      }
      if (fb.unchanged && newFm !== null) {
        // 正文没改：保留结束分隔线之后的原文（逐字节不变）
        const fmPart = newFm.replace(/\n+$/, '');
        content = fmPart ? `---\n${fmPart}\n---\n${v.rawBody}` : `---\n---\n${v.rawBody}`;
      } else if (fb.unchanged && newFm === null) {
        content = v.rawBody;
      } else {
        content = buildDocument(newFm, body);
      }
    } catch (err) {
      console.error('[editor] build failed', err);
      toast(err instanceof FrontMatterError ? err.message : errorMessage(err), { type: 'error', timeout: 9000 });
      return;
    }
    if (!bodyUnchanged) {
      const bad = badPercentLinks(body);
      if (bad.length) {
        toast(`正文里的链接地址「${bad[0]}」含有单独的「%」，网站会因此无法更新。请把这个链接删掉后重新插入（或把 % 改成 %25）。`, { type: 'error', timeout: 12000 });
        return;
      }
    }

    // 什么都没改：不产生提交（文件末尾少一个换行之类的差别也不值得一次提交）
    if (v.exists && !v.isNew && !v.restored && content !== undefined && newFm === v.fmText && body === v.rawBody &&
        !used.some((n) => this.media.get(n) && !this.media.get(n).committed)) {
      toast('内容和网站上的一样，不需要发表', { type: 'info' });
      v.touched = false;
      this.renderAll();
      return;
    }

    const changes = [{ path, content, baseSha: v.exists ? v.sha : null }];
    let imageCount = 0;
    let docCount = 0;
    for (const name of used) {
      const m = this.media.get(name);
      if (!m || m.committed) continue;
      if (m.kind === 'image') {
        changes.push({ path: `${imgDir}/${name}`, content: m.blob });
        imageCount++;
      } else {
        changes.push({ path: `${PATHS.documents}/${name}`, content: m.blob, baseSha: null });
        docCount++;
      }
    }
    const title = v.form.title.trim();
    const verb = mode === 'draft' ? '保存草稿' : (v.exists && v.published ? '更新' : '发表');
    const label = this.variants.size > 1 || v.key !== 'shared' ? `（${C.variantLabel(v.key, this.ctx)}）` : '';
    const summary = [`${verb}：${path}`];
    if (imageCount) summary.push(`上传图片 ${imageCount} 张`);
    if (docCount) summary.push(`上传资料 ${docCount} 个`);

    this.flushAutosave();
    let res;
    try {
      const view = mode === 'draft' ? null : this.publishedUrlFor(v, content);
      res = await this.ctx.publish({
        message: `admin: ${verb}《${title}》${label}`, changes, summary,
        viewUrl: view || undefined, viewLabel: view ? (this.kind === 'post' ? '查看文章' : '查看页面') : undefined,
      });
    } catch (err) {
      // 外壳已经提示过错误；修改仍在编辑器里和本机草稿中
      console.warn('[editor] publish failed', err);
      return;
    }
    if (res && res.conflict) {
      if (!this.destroyed) this.onConflict(v, res);
      return;
    }
    // ---- 成功 ----
    // 先清理本机草稿（即使编辑器已经关掉了，例如发表途中离开），否则会留下一份「未发表」的旧草稿
    const oldKey = v.draftKey;
    const newKey = drafts.draftKeyForPath(path);
    await this.cleanupDrafts([oldKey, newKey]);
    if (this.destroyed) return;

    const sha = (res.shas && res.shas[path]) || this.repo.entry(path)?.sha || v.sha;
    const parsed = splitDocument(content);
    v.path = path;
    v.exists = true;
    v.sha = sha;
    v.fmText = parsed.fmText;
    v.fm = parseFrontMatter(parsed.fmText);
    v.rawBody = parsed.body;
    v._display = undefined;
    if (v.form.cover && v.form.cover.startsWith(PENDING)) v.form.cover = this.resolveCover(v.form.cover, imgDir);
    if (this.isNewGroup && !v.form.date) v.form.date = v.fm.date ? str(v.fm.date) : '';
    v.form = { ...this.formFromFm(v.fm), ...v.form, date: v.fm.date == null ? '' : str(v.fm.date) };
    v.baseForm = clone(v.form);
    v.baseMarkdown = v.markdown;
    v.published = mode !== 'draft';
    v.isNew = false;
    v.restored = false;
    v.stale = false;
    v.touched = false;
    v.needsAutosave = false;
    v.bodyEdited = false;
    v.copyBase = null;
    v.copyRaw = null;
    for (const name of used) {
      const m = this.media.get(name);
      if (!m) continue;
      if (m.kind === 'image' && !m.sitePath) {
        recentUploads.set(this.imageSitePath(name, imgDir), m.blob);
        m.sitePath = mdDest(this.imageSitePath(name, imgDir));
      }
      m.committed = true;
    }
    v.draftKey = newKey;
    v.draftWritten = false;
    this.group.variants[v.key] = path;

    if (this.isNewGroup) {
      this.leaving = true;
      this.ctx.navigate('#/edit?path=' + encodeURIComponent(path), { replace: true });
      return;
    }
    this.renderAll();
  }

  onConflict(v, res) {
    this.flushOthers(null);
    if (!res.reloaded) {
      const saved = this.autosaveOk && ![...this.variants.values()].some((x) => x.localDraft && this.variantDirty(x));
      toast(saved ? '没有发布。你的修改还保留在编辑器里（也已自动保存在本机）。' : '没有发布。你的修改还保留在编辑器里。', { type: 'info', timeout: 6000 });
      return;
    }
    // 外壳已经重新读取了仓库：记下文件现在的版本，让用户选择怎么处理
    for (const x of this.variants.values()) {
      if (!x.path) continue;
      const latest = this.repo.entry(x.path);
      const latestSha = latest ? latest.sha : null;
      const expected = x.exists ? x.sha : null;
      if (latestSha !== expected) x.conflict = { sha: latestSha };
    }
    if (!v.conflict) {
      // 冲突出在别的文件（例如同名图片）：直接再试一次即可
      toast('已读取最新版本，请再点一次发表', { type: 'info' });
    }
    this.renderAll();
  }

  keepMine(v) {
    if (!v.conflict) return;
    v.sha = v.conflict.sha;
    v.exists = v.conflict.sha !== null;
    v.conflict = null;
    v.restored = true; // 保证下次发表会写入我们的完整内容
    this.renderAll();
    toast('好的。再点一次「发表 / 更新」，就会用你的版本覆盖 GitHub 上的修改', { type: 'info', timeout: 6000 });
  }

  async reloadVariant(v, { confirmText } = {}) {
    const ok = await confirmDialog({
      title: '加载最新版本？',
      message: confirmText || '你在这个版本里做的、还没有发表的修改会被丢弃（本机草稿也会删除）。',
      okText: '加载最新版本', danger: true,
    });
    if (!ok) return;
    if (!this.repo.has(v.path)) {
      v.needsAutosave = false;
      v.bodyEdited = false;
      v.draftKey = null;
      await drafts.deleteDraft(drafts.draftKeyForPath(v.path));
      v.conflict = null;
      toast('这个文件已经在 GitHub 上被删除了', { type: 'warning' });
      this.leaving = true;
      this.ctx.navigate(this.listHash(), { replace: true });
      return;
    }
    try {
      const text = await this.repo.readText(v.path);
      const doc = splitDocument(text);
      if (doc.kind === 'toml') throw new Error('这个文件现在使用 TOML 格式的设置区，无法在后台编辑');
      const fm = parseFrontMatter(doc.fmText);
      const fresh = this.makeVariant({ key: v.key, path: v.path, exists: true, sha: this.repo.entry(v.path).sha, fmText: doc.fmText, fm, body: doc.body });
      await drafts.deleteDraft(v.draftKey);
      this.variants.set(v.key, fresh);
      if (this.activeKey === v.key) this.activate(v.key, { initial: true });
      else this.renderAll();
      toast('已加载最新版本', { type: 'success' });
    } catch (err) {
      toast(`读取失败：${errorMessage(err)}`, { type: 'error' });
    }
  }

  // =========================================================================
  // 更多菜单

  toggleMore() {
    if (this.menuEl) { this.closeMore(); return; }
    const items = this.moreItems();
    const menu = h('div', { class: 'ed-menu', role: 'menu', dataset: { testid: 'editor-more-menu' } }, items);
    this.els.moreWrap.appendChild(menu);
    this.els.moreBtn.setAttribute('aria-expanded', 'true');
    this.menuEl = menu;
    const onDoc = (e) => { if (!menu.contains(e.target)) this.closeMore(); };
    const onKey = (e) => { if (e.key === 'Escape') { this.closeMore(); this.els.moreBtn.focus(); } };
    setTimeout(() => document.addEventListener('click', onDoc), 0);
    document.addEventListener('keydown', onKey);
    this.menuCleanup = () => {
      document.removeEventListener('click', onDoc);
      document.removeEventListener('keydown', onKey);
    };
    const first = menu.querySelector('a, button');
    if (first) first.focus();
  }

  closeMore() {
    if (!this.menuEl) return;
    this.menuEl.remove();
    this.menuEl = null;
    if (this.menuCleanup) this.menuCleanup();
    this.menuCleanup = null;
    if (this.els.moreBtn) this.els.moreBtn.setAttribute('aria-expanded', 'false');
  }

  moreItems() {
    const items = [];
    const item = (icon, text, onClick, { testid, danger, disabled } = {}) => h('button', {
      type: 'button', role: 'menuitem', class: ['ed-menu-item', danger && 'is-danger'], disabled: !!disabled,
      dataset: { testid }, on: { click: () => { this.closeMore(); onClick(); } },
    }, svgIcon(icon), h('span', {}, text));

    // 在网站上查看（只列出已发表的语言）
    for (const lang of this.langs) {
      const url = this.siteUrlFor(lang);
      if (!url) continue;
      items.push(h('a', {
        role: 'menuitem', class: 'ed-menu-item', href: url, target: '_blank', rel: 'noopener noreferrer',
        dataset: { testid: `editor-view-${lang}` }, on: { click: () => this.closeMore() },
      }, svgIcon('external'), h('span', {}, `在${this.ctx.siteLabel(lang)}查看`)));
    }
    if (!items.length) {
      items.push(h('div', { class: 'ed-menu-note muted small' }, '发表后可以在网站上查看'));
    }
    items.push(h('div', { class: 'ed-menu-sep', role: 'separator' }));
    const v = this.active;
    const existing = [...this.variants.values()].filter((x) => x.exists);
    if (v.exists && existing.length > 1) {
      items.push(item('trash', `删除此版本（${C.variantLabel(v.key, this.ctx)}）`, () => this.deleteVariant(), { testid: 'editor-delete-variant', danger: true }));
    } else if (!v.exists && !this.isNewGroup) {
      items.push(item('close', '放弃这个新版本', () => this.deleteVariant(), { testid: 'editor-delete-variant', danger: true }));
    }
    if (existing.length) {
      items.push(item('trash', this.kind === 'post' ? '删除整篇文章' : '删除整个页面', () => this.deleteAll(), { testid: 'editor-delete-all', danger: true }));
    } else if (this.isNewGroup) {
      items.push(item('trash', '放弃这篇新文章', () => this.discardNew(), { testid: 'editor-discard-new', danger: true }));
    }
    return items;
  }

  /**
   * 即将发表的这个版本在网站上的地址（发表成功后「已上线 ✓」和提示里的链接用）。
   * 共用版本：取第一个没有专属版本的语言站点；日期在未来时网站暂时不会显示，不给链接。
   */
  publishedUrlFor(v, content) {
    try {
      let fm;
      try { fm = parseFrontMatter(splitDocument(content).fmText) || {}; } catch { fm = {}; }
      if (this.kind === 'post' && fm.date != null && this.isFuture(str(fm.date))) return null;
      let lang = v.key;
      if (lang === 'shared') {
        lang = this.langs.find((l) => { const o = this.variants.get(l); return !(o && o.exists); });
        if (!lang) return null;
      }
      return this.siteUrlFor(lang, fm);
    } catch {
      return null;
    }
  }

  /** 某个语言站点上这一页的网址（只有已发表时才返回；传入 fmOverride 时按这份 front matter 计算，不检查是否已发表）。 */
  siteUrlFor(lang, fmOverride) {
    let fm;
    if (fmOverride) fm = fmOverride;
    else {
      const own = this.variants.get(lang);
      const v = own && own.exists ? own : this.variants.get('shared');
      if (!v || !v.exists || !v.published) return null;
      fm = v.fm || {};
    }
    const prefix = lang === this.ctx.defaultLang ? '' : `${lang}/`;
    let rel;
    if (typeof fm.url === 'string' && fm.url.trim()) {
      const raw = fm.url.trim();
      // 只接受站内路径：任何「协议:」开头（包括 javascript:）或 // 开头的地址都不生成链接
      if (/^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith('//')) return null;
      rel = raw.replace(/^\/+/, '');
      const href = new URL(prefix + rel, this.ctx.siteUrl).href;
      return /^https?:/i.test(href) ? href : null;
    }
    const dir = this.group.dir === PATHS.content ? '' : this.group.dir.slice(PATHS.content.length + 1);
    if (this.group.isIndex) rel = dir ? `${dir}/` : '';
    else {
      const fileBase = this.isNewGroup && this.kind === 'post' ? this.slug.value : this.group.base;
      const base = typeof fm.slug === 'string' && fm.slug.trim() ? fm.slug.trim() : fileBase;
      if (!base) return null;
      rel = `${dir ? dir + '/' : ''}${base}/`;
    }
    return new URL(prefix + rel.toLowerCase(), this.ctx.siteUrl).href;
  }

  listHash() {
    return this.kind === 'post' ? '#/posts' : '#/pages';
  }

  goBack() {
    this.ctx.navigate(this.listHash());
  }

  async discardNew() {
    const ok = await confirmDialog({ title: '放弃这篇新文章？', message: '还没有发表的内容和本机草稿都会被删除。', okText: '放弃', danger: true });
    if (!ok) return;
    this.autosave.cancel();
    this.discarded = true;
    for (const v of this.variants.values()) if (v.draftKey) await drafts.deleteDraft(v.draftKey);
    this.leaving = true;
    this.ctx.navigate(this.listHash(), { replace: true });
  }

  async deleteVariant() {
    const v = this.active;
    const label = C.variantLabel(v.key, this.ctx);
    if (!v.exists) {
      const ok = await confirmDialog({ title: '放弃这个新版本？', message: `还没有发表的「${label}」内容和它的本机草稿都会被删除。`, okText: '放弃', danger: true });
      if (!ok) return;
      v.needsAutosave = false;
      if (v.draftKey) await drafts.deleteDraft(v.draftKey);
      this.variants.delete(v.key);
      this.activate([...this.variants.keys()][0], { initial: true });
      return;
    }
    let message;
    if (v.key !== 'shared') {
      message = this.variants.get('shared')?.exists
        ? `删除后，${this.ctx.siteLabel(v.key)}将改回显示共用版本。`
        : `删除后，${this.ctx.siteLabel(v.key)}上将不再有这一页。`;
    } else {
      const lose = this.langs.filter((l) => !(this.variants.get(l) && this.variants.get(l).exists));
      const keep = this.langs.filter((l) => this.variants.get(l) && this.variants.get(l).exists);
      message = '只删除共用版本这一个文件。';
      if (lose.length) message += `删除后，${lose.map((l) => this.ctx.siteLabel(l)).join('、')}上将不再有这一页；`;
      if (keep.length) message += `${keep.map((l) => this.ctx.siteLabel(l)).join('、')}继续显示各自的专属版本。`;
    }
    const ok = await confirmDialog({ title: `删除${label}？`, message: `${message}\n\n文件：${v.path}`, okText: '删除', danger: true });
    if (!ok) return;
    let res;
    try {
      res = await this.ctx.publish({
        message: `admin: 删除《${v.form.title.trim() || this.group.base}》的${label}`,
        changes: [{ path: v.path, delete: true, baseSha: v.sha }],
        summary: [`删除：${v.path}`],
      });
    } catch { return; }
    if (res && res.conflict) { this.onConflict(v, res); return; }
    this.autosave.cancel();
    v.needsAutosave = false;
    if (v.draftKey) await drafts.deleteDraft(v.draftKey);
    v.draftKey = null;
    await this.flushOthers(v);
    const remaining = [...this.variants.values()].find((x) => x !== v && x.exists);
    this.leaving = true;
    this.ctx.navigate(remaining ? '#/edit?path=' + encodeURIComponent(remaining.path) : this.listHash(), { replace: true });
  }

  /** 离开前确保其他版本未发表的修改已经写进本机草稿。 */
  async flushOthers(except) {
    for (const x of this.variants.values()) if (x !== except && this.variantDirty(x)) x.needsAutosave = true;
    this.autosave.cancel();
    await this.autosaveNow();
  }

  async deleteAll() {
    const existing = [...this.variants.values()].filter((x) => x.exists);
    const imgDir = this.imageDir();
    // 只删这一页自己的图片：子目录如果是另一页的图片目录（例如栏目首页 courses/_index.md 的目录
    // static/images/pages/courses 里有子页面 courses/optics.md 的 static/images/pages/courses/optics），保留
    const others = C.groupPages(this.repo.list(PATHS.content + '/'), this.langs)
      .filter((g) => g.key !== this.group.key)
      .map((g) => C.imageDirFor(g) + '/')
      .filter((d) => d.startsWith(imgDir + '/'));
    const images = this.repo.list(imgDir + '/').filter((e) => !others.some((d) => e.path.startsWith(d)));
    const title = this.active.form.title.trim() || this.group.base;
    const cb = h('input', { type: 'checkbox', dataset: { testid: 'editor-delete-images' } });
    const what = this.kind === 'post' ? '文章' : '页面';
    const content = h('div', { class: 'stack-sm stack' },
      h('p', { class: 'modal-message' }, `《${title}》的所有语言版本都会从网站上删除：`),
      h('ul', { class: 'conflict-list' }, existing.map((x) => h('li', {}, h('code', {}, x.path)))),
      images.length ? h('label', { class: 'checkbox' }, cb, `同时删除这篇${what}的图片文件夹 ${imgDir}/（${images.length} 个文件）`) : null,
      h('p', { class: 'muted small' }, '删除后可以在 GitHub 的提交历史里找回。'));
    let confirmed = false;
    await new Promise((resolve) => {
      modal({
        title: `删除整${this.kind === 'post' ? '篇文章' : '个页面'}？`,
        content,
        actions: [
          { text: '取消', kind: 'ghost', testid: 'confirm-cancel' },
          { text: '删除', kind: 'danger', testid: 'confirm-ok', onClick: (close) => { confirmed = true; close(); } },
        ],
        onClose: resolve,
      });
    });
    if (!confirmed) return;
    const changes = existing.map((x) => ({ path: x.path, delete: true, baseSha: x.sha }));
    if (cb.checked) for (const e of images) changes.push({ path: e.path, delete: true });
    let res;
    try {
      res = await this.ctx.publish({
        message: `admin: 删除《${title}》`,
        changes,
        summary: [`删除 ${existing.length} 个文件${cb.checked && images.length ? `和 ${images.length} 张图片` : ''}`],
      });
    } catch { return; }
    if (res && res.conflict) { this.onConflict(this.active, res); return; }
    this.autosave.cancel();
    this.discarded = true;
    for (const x of this.variants.values()) if (x.draftKey) await drafts.deleteDraft(x.draftKey);
    for (const o of this.orphanDrafts) await drafts.deleteDraft(o.key);
    this.leaving = true;
    this.ctx.navigate(this.listHash(), { replace: true });
  }

  // =========================================================================
  // 手机预览

  openPreview() {
    this.syncActive();
    const multi = this.langs.length > 1 && this.variants.size > 1;
    let lang = this.activeKey === 'shared' ? this.ctx.defaultLang : this.activeKey;
    let dark = this.isDarkUI();
    const iframe = h('iframe', {
      class: 'ed-phone-frame', sandbox: 'allow-same-origin', title: '手机预览', referrerpolicy: 'no-referrer',
      dataset: { testid: 'preview-iframe', state: 'loading' },
    });
    const loading = h('div', { class: 'ed-phone-loading' }, h('span', { class: 'spinner' }), '正在生成预览…');
    const themeBtns = [
      { val: false, text: '浅色', icon: 'sun', testid: 'preview-light' },
      { val: true, text: '深色', icon: 'moon', testid: 'preview-dark' },
    ].map((o) => h('button', {
      type: 'button', class: 'tab', dataset: { testid: o.testid },
      on: { click: () => { dark = o.val; update(); } },
    }, svgIcon(o.icon), o.text));
    const langBtns = multi ? this.langs.map((l) => h('button', {
      type: 'button', class: 'tab', dataset: { testid: `preview-lang-${l}` },
      on: { click: () => { lang = l; update(); } },
    }, this.ctx.siteLabel(l))) : [];
    const note = h('div', { class: 'muted small ed-preview-note' });
    const content = h('div', { class: 'ed-preview' },
      h('div', { class: 'ed-preview-controls' },
        h('div', { class: 'tabs tabs-pill', role: 'group', 'aria-label': '颜色' }, themeBtns),
        multi ? h('div', { class: 'tabs tabs-pill', role: 'group', 'aria-label': '站点' }, langBtns) : null),
      h('div', { class: 'ed-phone' }, h('div', { class: 'ed-phone-screen' }, iframe, loading)),
      note);
    modal({ title: '手机预览', content, className: 'ed-preview-modal' });

    let seq = 0;
    const update = async () => {
      const my = ++seq;
      themeBtns.forEach((b, i) => b.classList.toggle('active', (i === 1) === dark));
      langBtns.forEach((b, i) => b.classList.toggle('active', this.langs[i] === lang));
      const v = this.variants.get(lang) || this.variants.get('shared');
      if (!v) {
        note.textContent = `${this.ctx.siteLabel(lang)}上没有这一页。`;
        return;
      }
      note.textContent = `${this.ctx.siteLabel(lang)} · ${C.variantLabel(v.key, this.ctx)}${this.variantDirty(v) ? '（含未发表的修改）' : ''} · 实际效果以发表后的网站为准`;
      loading.hidden = false;
      iframe.dataset.state = 'loading';
      try {
        const markdown = this.getVariantMarkdown(v);
        const imageMap = await this.previewImageMap(markdown, v.form.cover);
        if (my !== seq) return;
        await renderPreview(iframe, {
          title: v.form.title,
          date: v.form.date ? formatDate(v.form.date) : '',
          description: this.kind === 'post' ? v.form.description : '',
          markdown,
          dark,
          lang,
          imageMap,
          cover: this.coverDisplayUrl(v.form.cover) || '',
          siteUrl: this.ctx.siteUrl,
        });
      } catch (err) {
        if (my === seq) toast(`预览失败：${errorMessage(err)}`, { type: 'error' });
      }
      if (my !== seq) return;
      loading.hidden = true;
      iframe.dataset.state = 'ready';
      iframe.dataset.lang = lang;
      iframe.dataset.theme = dark ? 'dark' : 'light';
    };
    update();
  }

  /**
   * 预览用的地址替换：待上传图片的占位符（短代码里）→ blob 地址；
   * 仓库里有、网站上还打不开的图片 → 从仓库读出的 blob 地址。
   */
  async previewImageMap(md, cover) {
    const map = new Map();
    for (const [name, m] of this.media) {
      if (m.kind === 'image' && m.url && !m.sitePath) map.set(PENDING + name, m.url);
    }
    const paths = this.imagePathsIn(md);
    if (cover && cover.startsWith('/')) paths.push(cover);
    try {
      const found = await this.fetchRepoImages(paths);
      for (const [p, blob] of found) {
        const m = this.addMedia(p, blob, 'image', { committed: true, sitePath: p });
        // 只替换完整的地址（后面是引号或右括号），避免改到更长的路径
        for (const end of ['"', ')', "'", ' ']) map.set(p + end, m.url + end);
      }
    } catch (err) {
      console.warn('[editor] preview images', err);
    }
    return map;
  }

  // =========================================================================
  // 离开 / 卸载

  async canLeave() {
    if (this.leaving) return true;
    if (this.saving || (this.ctx.isPublishing && this.ctx.isPublishing())) {
      toast('正在发表，请稍候再离开', { type: 'warning' });
      return false;
    }
    try { this.syncActive(); } catch (err) { console.warn(err); }
    if (!this.isDirty()) return true;
    for (const v of this.variants.values()) if (this.variantDirty(v)) v.needsAutosave = true;
    this.autosave.cancel();
    await this.autosaveNow();
    const blocked = [...this.variants.values()].some((x) => x.localDraft && this.variantDirty(x));
    const saved = this.autosaveOk && !blocked;
    const ok = await confirmDialog({
      title: '还有修改没有发表',
      message: saved
        ? '这些修改已经自动保存在这台设备上，下次打开时可以恢复。确定要离开吗？'
        : blocked
          ? '有修改还没有自动保存：这一页还有一份没有处理的本机草稿（上方的「恢复 / 丢弃」）。离开后，刚才的修改会丢失。确定要离开吗？'
          : '这个浏览器无法保存本机草稿，离开后这些修改会丢失。确定要离开吗？',
      okText: '离开', cancelText: '继续编辑', danger: !saved,
    });
    if (ok) this.leaving = true;
    return ok;
  }

  destroy() {
    if (this.destroyed) return;
    // 立即写入本机草稿（例如登录失效、关闭标签页之前切换视图）
    try {
      this.syncActive();
      if (!this.discarded && (this.autosave.pending() || [...this.variants.values()].some((x) => x.needsAutosave))) {
        this.flushing = true;
        this.autosave.cancel();
        this.autosaveNow();
      }
    } catch (err) { console.warn(err); }
    this.destroyed = true;
    this.closeMore();
    document.removeEventListener('keydown', this.onKeyDown, true);
    document.removeEventListener('visibilitychange', this.onHidden);
    window.removeEventListener('pagehide', this.onHidden);
    if (this.toolbarCleanup) this.toolbarCleanup();
    // 关闭频道稍后进行：上面的自动保存可能还在写
    const ch = this.channel;
    if (ch) setTimeout(() => { try { ch.close(); } catch { /* ignore */ } }, 3000);
    try { if (this.vd) this.vd.destroy(); } catch { /* ignore */ }
    this.vd = null;
    // blob 地址不再需要（图片本身在 recentUploads / 本机草稿里）。稍后再释放，避免正在保存的草稿读不到。
    const urls = [...this.urlToName.keys()];
    setTimeout(() => urls.forEach((u) => { try { URL.revokeObjectURL(u); } catch { /* ignore */ } }), 5000);
  }
}

/** 根据「显示在菜单 / 顺序」生成新的 menu 值（保留其他菜单和 main 下的其他键）。 */
function buildMenu(orig, inMenu, weight) {
  let m;
  if (isPlainObject(orig)) m = clone(orig);
  else if (typeof orig === 'string') m = orig === 'main' || !orig ? {} : { [orig]: {} };
  else if (Array.isArray(orig)) m = Object.fromEntries(orig.filter((x) => typeof x === 'string' && x !== 'main').map((x) => [x, {}]));
  else m = {};
  if (inMenu) {
    const main = isPlainObject(m.main) ? { ...m.main } : {};
    const w = Number.parseInt(String(weight).trim(), 10);
    if (String(weight).trim() !== '' && Number.isFinite(w)) main.weight = w;
    else delete main.weight;
    m.main = main;
  } else {
    delete m.main;
  }
  return Object.keys(m).length ? m : undefined;
}
