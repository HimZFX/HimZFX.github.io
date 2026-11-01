// content.js — 双语内容模型（纯函数，无 DOM，可在 Node 里直接导入测试）。
//
// 网站的双语规则（与 SITE_GUIDE.md「双语机制」、new_post.py --status 完全一致）：
//   xxx.md      共用版本：每种语言的站点都显示
//   xxx.en.md   英文专属：存在时，英文站用它「整体替换」共用版本（front matter 也一起替换）
//   xxx.zh.md   中文专属：同理
//   只有 xxx.en.md 没有 xxx.md → 这一页只存在于英文站
//   专属版本是 draft: true 时，该语言站点上这一页会「消失」，不会退回显示共用版本。
//
// 语言后缀只有在它是站点配置里的语言（languages.toml）时才算数，
// 例如站点没有 fr 时，'a.fr.md' 是一个名为 'a.fr' 的共用页面（与 new_post.py 的 split_name 相同）。

/** 内部兜底的语言名，ctxLike 没给 langName 时使用。 */
const FALLBACK_LANG_NAMES = { zh: '中文', en: '英文', ja: '日文', ko: '韩文', fr: '法文', de: '德文' };
const DEFAULT_LANGS = ['zh', 'en'];

function langsOr(langs) {
  return Array.isArray(langs) && langs.length ? langs : DEFAULT_LANGS;
}

function nameOf(lang, ctxLike) {
  if (ctxLike && typeof ctxLike.langName === 'function') {
    const n = ctxLike.langName(lang);
    if (n) return String(n);
  }
  return FALLBACK_LANG_NAMES[lang] || lang;
}

function entryPath(e) {
  return typeof e === 'string' ? e : e && e.path;
}

// ---------------------------------------------------------------------------
// 路径解析与分组
// ---------------------------------------------------------------------------

/**
 * 解析一个内容文件路径。
 *
 * @param {string} path 仓库内路径，如 'content/posts/a.en.md'
 * @param {string[]} langs 站点语言列表，如 ['zh', 'en']
 * @returns {{ dir: string, base: string, lang: string|null, isIndex: boolean }|null}
 *   不是 .md 文件（或是以 '.' 开头、Hugo 会忽略的隐藏文件）时返回 null。
 * @example parseContentPath('content/posts/a.en.md', ['zh','en'])
 *   // → { dir: 'content/posts', base: 'a', lang: 'en', isIndex: false }
 */
export function parseContentPath(path, langs) {
  if (typeof path !== 'string' || !path.endsWith('.md')) return null;
  const slash = path.lastIndexOf('/');
  const dir = slash >= 0 ? path.slice(0, slash) : '';
  const file = path.slice(slash + 1);
  // Hugo 忽略以 '.' 开头的文件；'.md' 本身也不是页面
  if (!file || file.startsWith('.')) return null;
  const stem = file.slice(0, -3);
  if (!stem) return null;
  let base = stem;
  let lang = null;
  const dot = stem.lastIndexOf('.');
  if (dot > 0) {
    const suffix = stem.slice(dot + 1);
    if (langsOr(langs).includes(suffix)) {
      base = stem.slice(0, dot);
      lang = suffix;
    }
  }
  return { dir, base, lang, isIndex: base === '_index' };
}

/**
 * 把内容文件按「逻辑页面」分组：同一目录、同一文件名（去掉语言后缀）的文件是同一页的不同版本。
 *
 * @param {Array<{path:string}|string>} entries 通常是 repo.list('content/')
 * @param {string[]} langs
 * @returns {Array<{ key: string, dir: string, base: string, isIndex: boolean,
 *                   variants: { shared?: string, [lang: string]: string } }>} 按 key 排序
 */
export function groupPages(entries, langs) {
  const groups = new Map();
  for (const e of entries || []) {
    const path = entryPath(e);
    const info = parseContentPath(path, langs);
    if (!info) continue;
    const key = info.dir ? `${info.dir}/${info.base}` : info.base;
    let g = groups.get(key);
    if (!g) {
      g = { key, dir: info.dir, base: info.base, isIndex: info.isIndex, variants: {} };
      groups.set(key, g);
    }
    g.variants[info.lang || 'shared'] = path;
  }
  return [...groups.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/**
 * 某个语言的站点实际使用哪个文件：专属版本 > 共用版本 > 没有这一页。
 * @returns {string|null}
 */
export function resolveForLang(group, lang) {
  if (!group || !group.variants) return null;
  return group.variants[lang] || group.variants.shared || null;
}

/**
 * 版本标签：'shared' → '共用版本'，'en' → '英文专属'，'zh' → '中文专属'。
 * @param {string} variantKey 'shared' 或语言代码
 * @param {{ langName?(lang:string): string }} [ctxLike]
 */
export function variantLabel(variantKey, ctxLike) {
  if (!variantKey || variantKey === 'shared') return '共用版本';
  return `${nameOf(variantKey, ctxLike)}专属`;
}

/**
 * 一个页面在各语言站点上的显示情况。
 *
 * @returns {{ kind: 'shared'|'split'|'partial', missing: string[],
 *             perLang: { [lang: string]: string|null }, sharedUnused: boolean }}
 *   kind: 'shared'  = 每种语言都显示同一个文件（中英共用）
 *         'split'   = 每种语言都有这一页，但来自 ≥2 个文件（中英分开）
 *         'partial' = 有的语言没有这一页（仅中文 / 仅英文）
 *   sharedUnused: 共用文件存在，但每种语言都有专属版本，所以它不会被任何站点使用（额外字段）。
 */
export function languageStatus(group, langs) {
  const ls = langsOr(langs);
  const perLang = {};
  const missing = [];
  for (const lang of ls) {
    const p = resolveForLang(group, lang);
    perLang[lang] = p;
    if (!p) missing.push(lang);
  }
  const files = new Set(Object.values(perLang).filter(Boolean));
  let kind;
  if (missing.length) kind = 'partial';
  else if (files.size <= 1) kind = 'shared';
  else kind = 'split';
  const v = (group && group.variants) || {};
  const sharedUnused = Boolean(v.shared) && ls.every((l) => v[l]);
  return { kind, missing, perLang, sharedUnused };
}

/**
 * 语言状态的简短中文描述：'中英共用' | '中英分开' | '仅中文' | '仅英文' …
 *
 * @param {ReturnType<typeof languageStatus>} status
 * @param {{ langs?: string[], langName?(lang:string): string }} [ctxLike]
 */
export function statusText(status, ctxLike) {
  if (!status) return '';
  const langs = Object.keys(status.perLang || {}).length
    ? Object.keys(status.perLang)
    : langsOr(ctxLike && ctxLike.langs);
  const present = langs.filter((l) => !(status.missing || []).includes(l));
  if (status.kind === 'partial') {
    if (!present.length) return '各站都没有';
    return '仅' + joinNames(present, ctxLike, false);
  }
  if (langs.length === 1) return status.kind === 'shared' ? '单一版本' : '多个版本';
  const all = joinNames(langs, ctxLike, true);
  return all + (status.kind === 'shared' ? '共用' : '分开');
}

/**
 * 把语言名拼成短语。全是「X文」形式的两字名称时用简称：中、英 → '中英'；
 * 否则用顿号连接：'中文、Deutsch'。
 * compact=false 且只有一种语言时返回完整名称（'仅中文'）。
 */
function joinNames(langs, ctxLike, compact) {
  const names = langs.map((l) => nameOf(l, ctxLike));
  if (names.length === 1 && !compact) return names[0];
  const short = names.every((n) => n.length === 2 && n.endsWith('文'));
  if (short) return names.map((n) => n[0]).join('');
  return names.join('、') + (compact ? ' ' : '');
}

/** 是博客文章（content/posts/ 下、非 _index 的页面）。 */
export function isPost(group) {
  return Boolean(group) && group.dir === 'content/posts' && !group.isIndex;
}

/**
 * 某个版本的文件路径。
 * @example variantPath('content/posts', 'a', 'en')  // 'content/posts/a.en.md'
 * @example variantPath('content/posts', 'a', null)  // 'content/posts/a.md'
 * @param {string} dir
 * @param {string} base
 * @param {string|null} langOrNull null / undefined / 'shared' → 共用版本
 */
export function variantPath(dir, base, langOrNull) {
  const prefix = dir ? `${dir}/` : '';
  const lang = langOrNull && langOrNull !== 'shared' ? langOrNull : null;
  return lang ? `${prefix}${base}.${lang}.md` : `${prefix}${base}.md`;
}

// ---------------------------------------------------------------------------
// 文件名（slug）
// ---------------------------------------------------------------------------

const SLUG_MAX = 60; // slugify 的输出上限；留出 '-2' 这类后缀的空间（isValidSlug 上限 81）

/**
 * 把标题转成只含 ASCII 的网址文件名：小写，只保留 [a-z0-9-]，连续 '-' 合并，首尾 '-' 去掉。
 * 带重音的拉丁字母会去掉重音（Café → cafe）。纯中文标题返回 ''。
 * @param {string} text
 * @returns {string}
 */
export function slugify(text) {
  if (text == null) return '';
  let s = String(text)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // 去掉组合重音符
    .toLowerCase()
    .replace(/['’]/g, '') // don't → dont
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (s.length > SLUG_MAX) {
    s = s.slice(0, SLUG_MAX);
    // 尽量在单词边界截断
    const cut = s.lastIndexOf('-');
    if (cut >= SLUG_MAX / 2) s = s.slice(0, cut);
    s = s.replace(/-+$/g, '');
  }
  return s;
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

/**
 * 为新文章建议一个不重复的文件名：slugify(title)，转不出来时用 `post-YYYYMMDD`；
 * 已存在时依次加 -2、-3 …
 *
 * @param {string} title
 * @param {Iterable<string>} existingBases 已有的文件名（不含 .md / 语言后缀）
 * @param {Date} [now]
 */
export function suggestSlug(title, existingBases, now = new Date()) {
  const taken = new Set();
  for (const b of existingBases || []) taken.add(String(b).toLowerCase());
  let base = slugify(title);
  if (!base) {
    base = `post-${now.getFullYear()}${pad2(now.getMonth() + 1)}${pad2(now.getDate())}`;
  }
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) {
    const candidate = `${base}-${i}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** 合法的文件名：小写字母或数字开头，只含 [a-z0-9-]，最长 81 个字符。 */
export function isValidSlug(s) {
  return typeof s === 'string' && /^[a-z0-9][a-z0-9-]{0,80}$/.test(s);
}

// ---------------------------------------------------------------------------
// 图片目录与网址
// ---------------------------------------------------------------------------

/**
 * 页面图片放在哪个目录。
 *   文章 content/posts/a.md            → static/images/posts/a
 *   栏目 content/research/_index.md    → static/images/pages/research
 *   根页面 content/about.md            → static/images/pages/about
 *   栏目内页面 content/research/x.md   → static/images/pages/research/x
 *   首页 content/_index.md             → static/images/pages/home
 * （leaf bundle 的 index.md 与 _index 一样，用所在目录名。）
 */
export function imageDirFor(group) {
  if (isPost(group)) return `static/images/posts/${group.base}`;
  const dir = group.dir || '';
  const rel = dir === 'content' ? '' : dir.startsWith('content/') ? dir.slice('content/'.length) : dir;
  const parts = [];
  if (rel) parts.push(rel);
  if (!group.isIndex && group.base !== 'index') parts.push(group.base);
  return `static/images/pages/${parts.length ? parts.join('/') : 'home'}`;
}

/**
 * static/ 下的文件在网站上的路径：'static/images/x.jpg' → '/images/x.jpg'。
 * （Hugo 把 static/ 的内容原样复制到网站根目录。）
 */
export function sitePathFor(staticPath) {
  const p = String(staticPath || '').replace(/^\.?\/+/, '');
  if (p === 'static') return '/';
  if (p.startsWith('static/')) return '/' + p.slice('static/'.length);
  return '/' + p;
}

// ---------------------------------------------------------------------------
// 草稿占位警告
// ---------------------------------------------------------------------------

/**
 * front matter 是否为草稿。与 Hugo 一致：布尔 true，或字符串 'true'/'1'/'t'（Hugo 的 cast.ToBool）。
 * 额外导出，供列表/编辑器统一判断。
 * @param {object|null|undefined} fm 解析后的 front matter
 */
export function isDraftFm(fm) {
  if (!fm || typeof fm !== 'object') return false;
  const d = fm.draft;
  if (d === true) return true;
  if (typeof d === 'number') return d !== 0;
  // Hugo（固定版本实测）：未加引号的 YAML 1.1 布尔词 yes / y / on 也会被当成草稿。
  // js-yaml 的 CORE_SCHEMA 把它们读成字符串，分不清有没有加引号；手写时几乎不会给它们加引号，
  // 所以按草稿处理（宁可在后台显示「草稿」，也不要显示「已发表」而网站上其实看不到）。
  if (typeof d === 'string') return /^(true|t|1|yes|y|on)$/i.test(d.trim());
  return false;
}

/**
 * 找出「专属版本是草稿、而共用版本已发表」的情况：该语言站点上这一页会消失。
 *
 * @param {object} group PageGroup
 * @param {{ [path: string]: object }} fmByPath 各文件解析后的 front matter（缺失视为 {}）
 * @param {string[]} langs
 * @returns {Array<{ lang: string, path: string }>}
 */
export function shadowWarnings(group, fmByPath, langs) {
  const out = [];
  const v = (group && group.variants) || {};
  if (!v.shared) return out;
  const fm = (p) => (fmByPath && fmByPath[p]) || {};
  if (isDraftFm(fm(v.shared))) return out;
  for (const lang of langsOr(langs)) {
    const p = v[lang];
    if (p && isDraftFm(fm(p))) out.push({ lang, path: p });
  }
  return out;
}

// ---------------------------------------------------------------------------
// 在线预览（网站的 /viewer/ 页面）
//
// 安卓手机、尤其是微信内置浏览器打不开 PDF（只能下载），所以资料的链接默认指向网站自己的
// 阅读器页面：/viewer/?file=<encodeURIComponent(网站路径)>（PDF.js 渲染 PDF，图片可以放大，
// 都带「下载」按钮）。可选参数：lang=en（英文界面，默认中文）、embed=1（嵌在文章里的精简样式）、
// page=N（从第 N 页开始）。文章正文里也可以用 {{< pdf "/documents/x.pdf" >}} 直接嵌入阅读器。

/** 阅读器页面在网站上的路径。 */
export const VIEWER_PATH = '/viewer/';

/** 阅读器能直接显示的图片格式（其余文件只给下载链接）。 */
export const PREVIEW_IMAGE_EXTS = Object.freeze(['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'svg']);

/** 路径的扩展名（小写，不含点）。路径是未编码的文件路径，文件名里可以有 # 和 ?（不是网址的 query / hash）。 */
function extOfPath(path) {
  const p = String(path || '');
  const name = p.slice(p.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

/** 是 PDF（看扩展名）。 */
export function isPdfPath(path) {
  return extOfPath(path) === 'pdf';
}

/** 阅读器能直接显示（PDF 或常见图片格式）。 */
export function isPreviewable(path) {
  const ext = extOfPath(path);
  return ext === 'pdf' || PREVIEW_IMAGE_EXTS.includes(ext);
}

function safeDecode(s) {
  try { return decodeURIComponent(s); } catch { return null; }
}

/** 控制字符（含 C1）和 Unicode 行 / 段分隔符。 */
const VIEWER_BAD_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

/**
 * 阅读器接受的文件路径（与网站 static/viewer/path.js 的规则一致）：同源、以 '/' 开头（不能是 '//'）、
 * 没有反斜杠和控制字符、没有空的 / '.' / '..' 路径段（逐段按 %XX 解码后也不能有，例如 %2e%2e；
 * 段里也不能解码出 '/' 或 '\'），也不能在 /admin/ 或 /viewer/ 下。
 * @param {string} sitePath 网站路径（未编码），例如 '/documents/讲义-第1章.pdf'
 */
export function isViewerFilePath(sitePath) {
  const p = sitePath;
  if (typeof p !== 'string' || p.length > 2048 || !p.startsWith('/') || p.startsWith('//')) return false;
  if (p.includes('\\') || VIEWER_BAD_CHARS.test(p)) return false;
  const segs = p.slice(1).split('/');
  for (let i = 0; i < segs.length; i++) {
    let cur = segs[i];
    for (let round = 0; round < 4; round++) {
      if (cur === '' || cur.trim() === '.' || cur.trim() === '..') return false;
      if (round > 0 && (cur.includes('/') || cur.includes('\\') || VIEWER_BAD_CHARS.test(cur))) return false;
      const next = safeDecode(cur);
      if (next === null || next === cur) break;
      cur = next;
    }
    if (i === 0 && /^(admin|viewer)$/i.test(safeDecode(segs[0]) ?? segs[0])) return false;
  }
  return true;
}

/** encodeURIComponent 再把 ! ' ( ) * 也编码（括号会破坏 Markdown 链接）。 */
function encodeQueryValue(s) {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

/**
 * 资料的在线预览地址。
 *
 * @param {string} sitePath 网站路径（未编码），例如 '/documents/讲义-第1章.pdf'（sitePathFor 的结果）
 * @param {{ lang?: string, embed?: boolean, absolute?: boolean, siteUrl?: string, page?: number }} [opts]
 *   lang：界面语言，'zh'（默认，不写进网址）或 'en' 等；embed：嵌入文章用的精简样式；
 *   absolute：返回完整网址（需要 siteUrl，例如 ctx.siteUrl = 'https://himzfx.github.io/'）；
 *   page：从第几页开始（> 1 时才写进网址）。
 * @returns {string|null} 路径不合法时返回 null
 * @example viewerUrlFor('/documents/a b.pdf')  // '/viewer/?file=%2Fdocuments%2Fa%20b.pdf'
 * @example viewerUrlFor('/documents/a.pdf', { lang: 'en', embed: true, absolute: true, siteUrl: 'https://x.io/' })
 *   // 'https://x.io/viewer/?file=%2Fdocuments%2Fa.pdf&lang=en&embed=1'
 */
export function viewerUrlFor(sitePath, { lang, embed, absolute, siteUrl, page } = {}) {
  if (!isViewerFilePath(sitePath)) return null;
  let q = 'file=' + encodeQueryValue(sitePath);
  if (lang && lang !== 'zh') q += '&lang=' + encodeQueryValue(String(lang));
  if (embed) q += '&embed=1';
  const n = Number(page);
  if (Number.isInteger(n) && n > 1) q += '&page=' + n;
  const rel = VIEWER_PATH + '?' + q;
  if (!absolute || !siteUrl) return rel;
  return String(siteUrl).replace(/\/?$/, '/') + rel.slice(1);
}

/**
 * 正文是否引用了某个网站文件（删除资料前的提醒用）。认得这些写法：
 *   原样或编码过的路径（[x](/documents/a%20b.pdf)、![](…)、<a href>…）、
 *   阅读器链接（/viewer/?file=%2Fdocuments%2F…，file 参数解码后比较）、
 *   {{< pdf "/documents/x.pdf" >}} 短代码（位置参数或 src= / file= 参数）。
 * @param {string} text Markdown 原文
 * @param {string} sitePath 网站路径（未编码）
 */
export function referencesSitePath(text, sitePath) {
  const s = String(text || '');
  const target = String(sitePath || '');
  if (!target || !s) return false;
  if (s.includes(target) || s.includes(encodeURI(target))) return true;
  const same = (v) => {
    if (!v) return false;
    const val = v.replace(/&amp;/g, '&');
    if (val === target) return true;
    const d = safeDecode(val.split('#')[0].split('?')[0]);
    return d === target;
  };
  // 阅读器链接的 file 参数
  const fileRe = /[?&](?:amp;)?file=([^&#\s)"'<>\]]+)/g;
  let m;
  while ((m = fileRe.exec(s))) {
    const d = safeDecode(m[1].replace(/\+/g, '%20'));
    if (d === target || same(d)) return true;
  }
  // {{< pdf … >}} 短代码
  const scRe = /\{\{[<%]\s*pdf\b([\s\S]*?)[>%]\}\}/g;
  while ((m = scRe.exec(s))) {
    const argRe = /(?:(\w+)\s*=\s*)?(?:"((?:[^"\\]|\\.)*)"|'([^']*)'|`([^`]*)`|([^\s"'`=]+))/g;
    let a;
    while ((a = argRe.exec(m[1]))) {
      const key = a[1] ? a[1].toLowerCase() : null;
      if (key && key !== 'src' && key !== 'file') continue;
      const v = a[2] != null ? a[2].replace(/\\(.)/g, '$1') : (a[3] ?? a[4] ?? a[5]);
      if (same(v)) return true;
    }
  }
  // Markdown 链接 / 图片地址（可能按段编码过，例如 %20 %28）
  const linkRe = /\]\(\s*<?([^)\s>]+)|\b(?:href|src)\s*=\s*["']?([^"'\s>]+)/g;
  while ((m = linkRe.exec(s))) if (same(m[1] ?? m[2])) return true;
  return false;
}
