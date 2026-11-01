/**
 * courses.js — 「课程」的内容模型（纯函数，无 DOM，可在 Node 里导入测试）。
 *
 * 约定（网站的 layouts 和后台共同遵守，见 docs/admin-architecture.md「课程」一节）：
 *
 *   content/courses/_index.md                 「课程资料」总页（导航栏里的栏目，属于「页面」）
 *   content/courses/<课程>/_index.md (+ .en.md) 一门课 = 一个单元页。front matter：
 *       title、description（一句话，显示在卡片上）、group（可选，自由填写的分组名）、weight（课程之间的顺序）、
 *       可选 materialsDir（默认 static/documents/courses/<课程>/）、showMaterials（默认 true）；没有 menu。
 *   content/courses/<课程>/<子推文>.md         子推文：title、weight（课程里的顺序）、可选 description、draft: false。
 *   static/documents/courses/<课程>/           这门课的资料（网站构建时自动列在课程页上）。
 *
 * 排序：课程按 weight、再按标题；有分组时每组一个标题，组按组内最小的 weight 排（相同时按组名），
 * 没有分组的课程放在最后的「其他」组。子推文按 weight、再按标题。weight 缺省（或 0）的排在最后（和 Hugo 一样）。
 *
 * @module courses
 */

import { groupPages, slugify, isValidSlug, sitePathFor, isPdfPath, isViewerFilePath, PREVIEW_IMAGE_EXTS } from './content.js';
import { splitDocument, parseFrontMatter, setFields, newFrontMatter, FrontMatterError } from './frontmatter.js';

/** 课程所在的目录。 */
export const COURSES_DIR = 'content/courses';
/** 课程资料的默认目录（static/ 下）。 */
export const COURSE_MATERIALS_ROOT = 'static/documents/courses';
/** 没有分组的课程归到这个组（中文后台显示）。 */
export const OTHER_GROUP = '其他';

/**
 * 仓库路径属于哪门课：'content/courses/modern-physics-lab/exp-1.md' → 'modern-physics-lab'。
 * content/courses/_index.md 本身（课程资料总页）和更深的子目录返回 null。
 * @param {string} path
 */
export function courseSlugOf(path) {
  const p = String(path || '');
  if (!p.startsWith(COURSES_DIR + '/')) return null;
  const rest = p.slice(COURSES_DIR.length + 1).split('/');
  if (rest.length !== 2 || !rest[0] || !rest[1]) return null;
  return rest[0];
}

/** 这个内容目录是某门课的目录（content/courses/<课程>）。 */
export function isCourseDir(dir) {
  const d = String(dir || '').replace(/\/+$/, '');
  if (!d.startsWith(COURSES_DIR + '/')) return false;
  const rest = d.slice(COURSES_DIR.length + 1);
  return !!rest && !rest.includes('/');
}

/** 是课程里的页面（课程单元页或子推文），而不是「课程资料」总页。 */
export function isInCourse(path) {
  return courseSlugOf(path) !== null;
}

/**
 * 把内容文件整理成课程：每门课的单元页（各语言版本）和子推文（页面组）。
 * 只认 content/courses/<课程>/ 里直接的 .md 文件；没有 _index 的目录也列出来（hasIndex: false）。
 * @param {Array<{path:string}|string>} entries repo.list('content/')
 * @param {string[]} langs
 * @returns {Array<{ slug: string, dir: string, index: object|null, items: object[], hasIndex: boolean }>} 按 slug 排序
 */
export function collectCourses(entries, langs) {
  const groups = groupPages((entries || []).filter((e) => courseSlugOf(typeof e === 'string' ? e : e.path)), langs);
  const map = new Map();
  for (const g of groups) {
    if (!isCourseDir(g.dir)) continue;
    const slug = g.dir.slice(COURSES_DIR.length + 1);
    if (!map.has(slug)) map.set(slug, { slug, dir: g.dir, index: null, items: [], hasIndex: false });
    const c = map.get(slug);
    if (g.isIndex) { c.index = g; c.hasIndex = true; } else if (g.base !== 'index') c.items.push(g);
  }
  return [...map.values()].sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
}

/** front matter 里的 weight → 有效数字或 null（Hugo：0 = 没有设置）。 */
export function weightOf(fm) {
  const v = fm && fm.weight;
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) && n !== 0 ? n : null;
}

/** 分组名（去掉首尾空白；空 → ''）。 */
export function groupOf(fm) {
  const g = fm && fm.group;
  return typeof g === 'string' ? g.trim() : typeof g === 'number' ? String(g) : '';
}

function cmpTitle(a, b) {
  return String(a || '').localeCompare(String(b || ''), 'zh-CN');
}

/**
 * 按 weight、再按标题排序（weight 为 null 的排在最后）。
 * @template T
 * @param {T[]} list
 * @param {(x: T) => { weight: number|null, title: string }} get
 * @returns {T[]} 新数组
 */
export function sortByWeight(list, get = (x) => x) {
  return [...list].sort((a, b) => {
    const A = get(a);
    const B = get(b);
    const fa = A.weight != null;
    const fb = B.weight != null;
    if (fa !== fb) return fa ? -1 : 1;
    if (fa && A.weight !== B.weight) return A.weight - B.weight;
    return cmpTitle(A.title, B.title);
  });
}

/**
 * 课程分组（和网站 /courses/ 页的规则一致）。
 * 没有任何课程设置分组 → 一个没有标题的组 [{ name: null, courses }]；
 * 否则每个分组一组，按组内最小的 weight 排（相同按组名），组内按 weight、标题；没有分组的放进最后的 otherName 组。
 * @template T
 * @param {T[]} courses
 * @param {(c: T) => { weight: number|null, title: string, group: string }} get
 * @param {string} [otherName]
 * @returns {Array<{ name: string|null, other?: boolean, courses: T[] }>}
 */
export function groupCourses(courses, get = (x) => x, otherName = OTHER_GROUP) {
  const sorted = sortByWeight(courses, get);
  if (!sorted.some((c) => get(c).group)) return [{ name: null, courses: sorted }];
  const groups = new Map();
  const others = [];
  for (const c of sorted) {
    const g = get(c).group;
    if (!g) { others.push(c); continue; }
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(c);
  }
  const minW = (list) => {
    const ws = list.map((c) => get(c).weight).filter((w) => w != null);
    return ws.length ? Math.min(...ws) : Infinity;
  };
  const named = [...groups.entries()].map(([name, list]) => ({ name, courses: list, min: minW(list) }))
    .sort((a, b) => (a.min !== b.min ? (a.min < b.min ? -1 : 1) : cmpTitle(a.name, b.name)))
    .map(({ name, courses: list }) => ({ name, courses: list }));
  if (others.length) named.push({ name: otherName, other: true, courses: others });
  return named;
}

/**
 * 调整顺序后给每一项分配新的 weight：原来的 weight 都是不同的有效数字时，把它们从小到大依次分给新顺序
 * （交换相邻两项只改这两项）；否则（有缺省或重复）按 10、20、30… 重新编号。
 * @param {string[]} orderedKeys 新顺序
 * @param {Map<string, number|null>|Record<string, number|null>} oldWeights
 * @returns {Map<string, number>} key → 新 weight（包含没有变化的）
 */
export function reweight(orderedKeys, oldWeights) {
  const get = (k) => (oldWeights instanceof Map ? oldWeights.get(k) : oldWeights[k]);
  const ws = orderedKeys.map(get);
  const valid = ws.every((w) => typeof w === 'number' && Number.isFinite(w) && w !== 0) && new Set(ws).size === ws.length;
  const out = new Map();
  if (valid) {
    const sorted = [...ws].sort((a, b) => a - b);
    orderedKeys.forEach((k, i) => out.set(k, sorted[i]));
  } else {
    orderedKeys.forEach((k, i) => out.set(k, (i + 1) * 10));
  }
  return out;
}

/**
 * 接在现有最大 weight 后面的 n 个新 weight：最大 20 → 30, 40, …；最大 25 → 30, 40, …；没有 → 10, 20, …
 * @param {Array<number|null>} existing
 * @param {number} n
 */
export function nextWeights(existing, n = 1) {
  const ws = (existing || []).filter((w) => typeof w === 'number' && Number.isFinite(w));
  const max = ws.length ? Math.max(...ws) : 0;
  const start = Math.floor(max / 10) * 10 + 10;
  return Array.from({ length: n }, (_, i) => start + i * 10);
}

// ---------------------------------------------------------------------------
// 文件名 → 标题 / 网址

/**
 * 从文件名得到默认标题：去掉扩展名，- 和 _ 换成空格，合并空白；中文、开头的编号（实验1）原样保留。
 * @example titleFromFileName('实验1-光电效应_报告.pdf')  // '实验1 光电效应 报告'
 * @param {string} name
 */
export function titleFromFileName(name) {
  let s = String(name || '').replace(/^.*[\\/]/, '').normalize('NFC');
  const dot = s.lastIndexOf('.');
  if (dot > 0 && /^[A-Za-z0-9]{1,10}$/.test(s.slice(dot + 1))) s = s.slice(0, dot);
  s = s.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
  return s || '未命名';
}

/**
 * 子推文的文件名（网址）：标题转出来有英文字母就用它；否则用文件名；还不行就是 item（带上标题里的数字，如 item-1）。
 * 和 taken（已占用，小写）重复时加 -2、-3。
 * @param {string} title
 * @param {string} [fileName]
 * @param {Iterable<string>} [taken]
 */
export function itemSlugFor(title, fileName = '', taken = []) {
  const used = new Set([...taken].map((t) => String(t).toLowerCase()));
  const hasLetter = (s) => /[a-z]/.test(s);
  let base = slugify(title);
  if (!hasLetter(base)) {
    const fromFile = slugify(titleFromFileName(fileName));
    if (hasLetter(fromFile)) base = fromFile;
    else {
      const digits = (String(title).match(/\d+/g) || []).join('-');
      base = digits ? `item-${digits}` : 'item';
    }
  }
  base = base.slice(0, 60).replace(/-+$/, '') || 'item';
  if (!isValidSlug(base)) base = 'item';
  if (!used.has(base) && base !== 'index') return base;
  for (let i = 2; ; i++) {
    const c = `${base}-${i}`;
    if (!used.has(c)) return c;
  }
}

/** 课程的网址名建议（来自英文名，其次中文名里的字母数字）。 */
export function courseSlugSuggestion(enName, zhName) {
  return slugify(enName) || slugify(zhName) || '';
}

// ---------------------------------------------------------------------------
// 资料目录

/**
 * 课程资料目录（仓库路径，不带结尾 /）。front matter 的 materialsDir 是 static/ 下的合法目录时用它，
 * 否则用默认的 static/documents/courses/<课程>。
 * @param {string} slug
 * @param {object} [fm]
 */
export function materialsDirFor(slug, fm) {
  const raw = fm && typeof fm.materialsDir === 'string' ? fm.materialsDir.trim() : '';
  if (raw) {
    let s = raw.replace(/\/{2,}/g, '/').replace(/^\/+|\/+$/g, '');
    if (!s.startsWith('static/')) s = 'static/' + s;
    const parts = s.split('/');
    const ok = parts.length >= 2 && parts.slice(1).every((seg) => seg && seg !== '.' && seg !== '..' && !seg.startsWith('.') && /^[\p{L}\p{N}_.-]+$/u.test(seg)) &&
      parts[1].toLowerCase() !== 'admin' && parts[1].toLowerCase() !== 'viewer';
    if (ok) return parts.join('/');
  }
  return `${COURSE_MATERIALS_ROOT}/${slug}`;
}

/** 资料列表是否显示在课程页上（showMaterials 默认 true）。 */
export function showMaterialsOf(fm) {
  const v = fm && fm.showMaterials;
  if (v === false) return false;
  if (typeof v === 'string' && /^(false|f|0|no|n|off)$/i.test(v.trim())) return false;
  return true;
}

// ---------------------------------------------------------------------------
// 新文件

/** splitDocument 的严格逆运算：正文原样保留。 */
export function joinDocument(fmText, body) {
  return fmText === '' ? `---\n---\n${body}` : `---\n${fmText}\n---\n${body}`;
}

/**
 * 课程单元页（_index.md）的全文。
 * @param {{ title: string, description?: string, group?: string, weight: number }} f
 * @param {string} [body]
 */
export function courseIndexDocument({ title, description, group, weight }, body = '') {
  const fields = { title: String(title).trim() };
  if (description && description.trim()) fields.description = description.trim();
  if (group && group.trim()) fields.group = group.trim();
  fields.weight = weight;
  const fmText = newFrontMatter(fields, ['title', 'description', 'group', 'weight']);
  return joinDocument(fmText, body ? `\n${body.replace(/^\n+/, '')}` : '');
}

/**
 * 子推文的全文。
 * @param {{ title: string, weight: number, description?: string }} f
 * @param {string} body Markdown 正文
 */
export function itemDocument({ title, weight, description }, body) {
  const fields = { title: String(title).trim(), weight };
  if (description && description.trim()) fields.description = description.trim();
  fields.draft = false;
  const fmText = newFrontMatter(fields, ['title', 'weight', 'description', 'draft']);
  return joinDocument(fmText, `\n${String(body || '').replace(/^\n+/, '').replace(/\n*$/, '\n')}`);
}

/** Markdown 链接地址：空格、括号等编码（和编辑器的 mdDest 相同）。 */
export function mdDest(sitePath) {
  return String(sitePath || '').replace(/%(?![0-9A-Fa-f]{2})|[\s#?()<>[\]"'\\^`{}|]/g,
    (c) => (c === ' ' ? '%20' : encodeURIComponent(c).replace(/[()'!*]/g, (x) => `%${x.charCodeAt(0).toString(16).toUpperCase()}`)));
}

/** Markdown 链接文字里的 [ ] \ 转义。 */
function linkText(s) {
  return String(s || '').replace(/[\\[\]]/g, '\\$&').replace(/[\r\n]+/g, ' ');
}

/** 能写进 {{< pdf "…" >}} 的网站路径。 */
export function canEmbedPdf(sitePath) {
  return isPdfPath(sitePath) && isViewerFilePath(sitePath) && !/["\r\n{}<>`\\]/.test(sitePath);
}

/**
 * 批量上传生成的子推文正文：PDF → {{< pdf "…" >}}；图片 → ![标题](…)；其他 → 下载链接。
 * @param {string} staticPath 文件的仓库路径（static/…）
 * @param {string} title
 */
export function itemBodyFor(staticPath, title) {
  const sitePath = sitePathFor(staticPath);
  const name = sitePath.slice(sitePath.lastIndexOf('/') + 1);
  if (canEmbedPdf(sitePath)) return `{{< pdf "${sitePath}" >}}`;
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : '';
  if (PREVIEW_IMAGE_EXTS.includes(ext)) return `![${linkText(title)}](${mdDest(sitePath)})`;
  return `[下载 ${linkText(name)}](${mdDest(sitePath)})`;
}

/**
 * 只改一个文件 front matter 里的几个顶层键（注释、其他行、正文原样保留）。
 * @param {string} text 全文
 * @param {Record<string, any>} updates undefined = 删除该键
 * @param {string} [path] 报错用
 * @returns {string}
 * @throws {FrontMatterError}
 */
export function patchFields(text, updates, path = '') {
  const doc = splitDocument(text);
  if (doc.kind !== 'yaml') {
    throw new FrontMatterError(`${path ? `「${path}」` : '这个文件'}的设置区不是 YAML 格式（---），后台无法自动修改，请在 GitHub 上手动改`);
  }
  const fmText = setFields(doc.fmText, updates);
  const out = fmText === doc.fmText ? text : joinDocument(fmText, doc.body);
  const again = splitDocument(out);
  if (again.body !== doc.body) throw new FrontMatterError(`修改 ${path || '文件'} 时校验未通过，已取消（文件没有被改动）`);
  return out;
}

/** 解析全文的 front matter（TOML / 解析失败 → 抛错）。 */
export function frontMatterOf(text) {
  const doc = splitDocument(text);
  if (doc.kind === 'toml') return { fm: {}, kind: 'toml' };
  return { fm: parseFrontMatter(doc.fmText), kind: doc.kind };
}

// ---------------------------------------------------------------------------
// 分组名规范化

/** 分组名的比较键：去掉所有空白（包括全角空格）、不区分大小写。 */
export function groupKey(name) {
  return String(name || '').normalize('NFKC').replace(/\s+/gu, '').toLowerCase();
}

/**
 * 用户输入的分组名 → 要写进 front matter 的分组名：首尾空白去掉、中间连续空白合并成一个空格；
 * 和已有分组只差大小写 / 空格（「Labs」和「labs 」、「实验 课」和「实验课」）时用已有的写法，避免网站上出现两个几乎一样的分组。
 * @param {string} value
 * @param {Iterable<string>} existing 已有的分组名
 * @returns {string} '' = 不分组
 */
export function canonicalGroup(value, existing = []) {
  const v = String(value || '').replace(/\s+/gu, ' ').trim();
  if (!v) return '';
  const k = groupKey(v);
  for (const g of existing) {
    if (g && groupKey(g) === k) return String(g);
  }
  return v;
}

// ---------------------------------------------------------------------------
// 草稿课程

/**
 * 课程设为草稿时写进 _index.md 的 cascade：Hugo 不会因为课程是草稿就隐藏它下面的子推文，
 * 所以用 build 选项把子推文一起隐藏（不生成页面、不出现在任何列表里）。课程恢复发布时去掉。
 */
export const DRAFT_CASCADE = Object.freeze({ build: Object.freeze({ render: 'never', list: 'never' }) });

/** front matter 的 cascade 是不是后台写的 DRAFT_CASCADE（只有它的时候才自动去掉）。 */
export function isDraftCascade(c) {
  if (!c || typeof c !== 'object' || Array.isArray(c)) return false;
  const keys = Object.keys(c);
  if (keys.length !== 1 || keys[0] !== 'build') return false;
  const b = c.build;
  if (!b || typeof b !== 'object' || Array.isArray(b)) return false;
  const bk = Object.keys(b).sort();
  return bk.length === 2 && bk[0] === 'list' && bk[1] === 'render' && b.render === 'never' && b.list === 'never';
}

/**
 * 课程介绍页（_index）保存时 cascade 要怎么改：设为草稿且没有 cascade → 加上 DRAFT_CASCADE；
 * 恢复发布且 cascade 正是 DRAFT_CASCADE → 去掉。用户自己写的 cascade 不动。
 * @param {object} fm 现在的 front matter
 * @param {boolean} draft 保存后是不是草稿
 * @returns {{ change: boolean, value?: object, conflict?: boolean }} value undefined = 删除
 */
export function draftCascadeUpdate(fm, draft) {
  const c = fm ? fm.cascade : undefined;
  if (draft) {
    if (c === undefined || c === null) return { change: true, value: { build: { render: 'never', list: 'never' } } };
    if (isDraftCascade(c)) return { change: false };
    return { change: false, conflict: true };
  }
  if (isDraftCascade(c)) return { change: true, value: undefined };
  return { change: false };
}

// ---------------------------------------------------------------------------
// 删除整门课

/**
 * 删除一门课时要删的文件：content/courses/<课程>/ 下的全部文件（介绍页、子推文、更深的子文件夹）、
 * 这门课的图片文件夹 static/images/pages/courses/<课程>/，以及（可选）资料文件夹。
 * @param {Array<{path:string}>} entries repo.list('')
 * @param {string} slug
 * @param {string} materialsDir materialsDirFor(...)
 */
export function courseDeletionPlan(entries, slug, materialsDir) {
  const dir = `${COURSES_DIR}/${slug}/`;
  const imgDir = `static/images/pages/courses/${slug}/`;
  const mat = String(materialsDir || `${COURSE_MATERIALS_ROOT}/${slug}`).replace(/\/+$/, '') + '/';
  const content = [];
  const images = [];
  const materials = [];
  for (const e of entries || []) {
    const p = typeof e === 'string' ? e : e.path;
    if (p.startsWith(dir)) content.push(e);
    else if (p.startsWith(imgDir)) images.push(e);
    else if (p.startsWith(mat)) materials.push(e);
  }
  const byPath = (a, b) => ((a.path || a) < (b.path || b) ? -1 : 1);
  return { dir, imgDir, materialsDir: mat, content: content.sort(byPath), images: images.sort(byPath), materials: materials.sort(byPath) };
}
