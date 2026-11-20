/**
 * sitemenu.js — 网站顶部菜单（下拉）和博客分类的 front matter 约定（纯函数，Node 里可直接导入测试）。
 *
 * 约定（网站模板和后台共用，见 docs/admin-architecture.md 第 16 节）：
 *   - 顶层菜单项 = 4 个固定栏目，front matter 里写 `menu.main.identifier`（about / research / posts / courses）；
 *   - 子页面 = 它的每个语言文件都写 `menu.main.parent: <identifier>` + `menu.main.weight`；
 *   - 不在菜单 = 没有 `menu.main`（页面仍然可以通过网址打开）；
 *   - 博客分类 = Hugo 的 categories 分类法，固定的键 notes（科研笔记）/ essays（随笔），一篇文章写 `categories: [notes]`。
 *
 * 写文件一律「外科手术式」：只动 menu / categories 那几行（frontmatter.setFields 或同位置换成块状写法），
 * 结果重新解析校验，正文一字不改；校验不通过就抛 FrontMatterError。
 *
 * @module sitemenu
 */

import { splitDocument, parseFrontMatter, setFields, FrontMatterError } from './frontmatter.js';

// ---------------------------------------------------------------------------
// 常量

/** 4 个固定的顶层栏目（顺序 = 网站上默认的顺序）。group：内容文件的页面组 key（content.groupPages）。 */
export const TOP_MENU = Object.freeze([
  Object.freeze({ id: 'about', label: 'About', zh: '关于', group: 'content/about' }),
  Object.freeze({ id: 'research', label: 'Research', zh: '研究', group: 'content/research/_index' }),
  Object.freeze({ id: 'posts', label: 'Blog', zh: '博客', group: 'content/posts/_index' }),
  Object.freeze({ id: 'courses', label: 'Course Materials', zh: '课程', group: 'content/courses/_index' }),
]);
export const TOP_IDS = Object.freeze(TOP_MENU.map((t) => t.id));
/** 下拉菜单的上级在界面上的名字（和网站英文菜单一致）。 */
export const PARENT_LABELS = Object.freeze(Object.fromEntries(TOP_MENU.map((t) => [t.id, t.label])));

/** 「论文 / 报告与海报 / 近况」打开菜单开关时放在哪个上级下面、顺序是多少。 */
export const SECTION_MENU_DEFAULTS = Object.freeze({
  publications: Object.freeze({ parent: 'research', weight: 10 }),
  talks: Object.freeze({ parent: 'research', weight: 20 }),
  news: Object.freeze({ parent: 'about', weight: 10 }),
});

/** 博客分类：固定的键 → 后台显示的中文名。 */
export const CATEGORY_KEYS = Object.freeze(['notes', 'essays']);
export const CATEGORY_LABELS = Object.freeze({ notes: '科研笔记', essays: '随笔' });

/**
 * 菜单顺序（输入框里的文字）有什么问题；没问题返回 null。
 * Hugo 的菜单 weight 是整数，而且 0 表示「没有设置顺序」，会排到最后（和后台的预览不一致），所以只收不是 0 的整数。
 * @param {string|number} value
 * @returns {string|null}
 */
export function menuWeightError(value) {
  const s = String(value ?? '').trim();
  if (s === '') return '菜单顺序请填一个数字';
  if (!/^-?\d+$/.test(s)) return '菜单顺序请填整数（例如 10、20）';
  const n = Number(s);
  if (Math.abs(n) > 1e6) return '菜单顺序的数字太大了（请在 -1000000 到 1000000 之间）';
  if (n === 0) return '菜单顺序不能是 0（网站会把 0 当成「没有顺序」，排到最后）';
  return null;
}

// ---------------------------------------------------------------------------
// 读取

function numOrNull(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() && Number.isFinite(Number(v))) return Number(v);
  return null;
}

function strOrNull(v) {
  if (typeof v === 'string' && v.trim()) return v.trim();
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return null;
}

const isObj = (v) => v != null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date);

/**
 * front matter 里的 main 菜单项。Hugo 支持三种写法：`menu: main`、`menu: ["main"]`、`menu: { main: { … } }`。
 * @returns {{ inMenu: boolean, weight: number|null, parent: string|null, identifier: string|null }}
 */
export function mainMenuEntry(fm) {
  const m = fm && fm.menu;
  const none = { inMenu: false, weight: null, parent: null, identifier: null };
  if (typeof m === 'string') return m === 'main' ? { ...none, inMenu: true, weight: numOrNull(fm.weight) } : none;
  if (Array.isArray(m)) return m.includes('main') ? { ...none, inMenu: true, weight: numOrNull(fm.weight) } : none;
  if (isObj(m) && Object.prototype.hasOwnProperty.call(m, 'main')) {
    const main = isObj(m.main) ? m.main : {};
    return {
      inMenu: true,
      weight: numOrNull(main.weight) ?? numOrNull(fm.weight),
      parent: strOrNull(main.parent),
      identifier: strOrNull(main.identifier),
    };
  }
  return none;
}

/** 4 个固定顶层栏目之一（有 identifier、没有 parent）。 */
export function isFixedTop(entry) {
  return !!(entry && entry.inMenu && !entry.parent && entry.identifier && TOP_IDS.includes(entry.identifier));
}

/** 去掉 menu 里的 main，其他菜单保留；什么都不剩时返回 undefined（= 删掉 menu 键）。 */
export function menuWithoutMain(menu) {
  if (menu == null) return undefined;
  if (typeof menu === 'string') return menu === 'main' ? undefined : menu;
  if (Array.isArray(menu)) {
    const rest = menu.filter((m) => m !== 'main');
    return rest.length ? rest : undefined;
  }
  if (isObj(menu)) {
    const out = { ...menu };
    delete out.main;
    return Object.keys(out).length ? out : undefined;
  }
  return menu;
}

/**
 * 新的 menu 值：main 设为 { parent?, weight }，main 下其他键（identifier、name、pre…）和其他菜单都保留。
 * spec.parent 为 null / '' = 顶层（去掉 parent）。
 */
export function menuWithMain(menu, { parent = null, weight } = {}) {
  let base;
  if (typeof menu === 'string') base = menu && menu !== 'main' ? { [menu]: {} } : {};
  else if (Array.isArray(menu)) base = Object.fromEntries(menu.filter((x) => typeof x === 'string' && x !== 'main').map((x) => [x, {}]));
  else base = isObj(menu) ? { ...menu } : {};
  const oldMain = isObj(base.main) ? base.main : {};
  // 新写的 main：parent 在 weight 前面（和网站约定里的写法一样）；已有的键保持原来的顺序
  const main = { ...oldMain };
  if (parent) main.parent = parent;
  else delete main.parent;
  main.weight = weight;
  base.main = main;
  return base;
}

// ---------------------------------------------------------------------------
// 写入

const PLAIN_SCALAR = /^[A-Za-z_][A-Za-z0-9_-]*$/;
const RESERVED = /^(?:true|false|null|yes|no|on|off|y|n|~)$/i;

function blockScalar(v) {
  if (typeof v === 'number' || typeof v === 'boolean' || v === null) return String(v);
  if (typeof v === 'string') return PLAIN_SCALAR.test(v) && !RESERVED.test(v) ? v : JSON.stringify(v);
  return JSON.stringify(v); // 嵌套的对象 / 数组：JSON 也是合法的 YAML 流式写法
}

/** menu 值 → 块状写法的几行（`menu:` / `  main:` / `    parent: research` …）。 */
function menuBlockLines(menu) {
  if (typeof menu === 'string' || Array.isArray(menu)) return [`menu: ${JSON.stringify(menu)}`];
  const lines = ['menu:'];
  for (const [name, val] of Object.entries(menu)) {
    const key = PLAIN_SCALAR.test(name) && !RESERVED.test(name) ? name : JSON.stringify(name);
    if (isObj(val) && Object.keys(val).length) {
      lines.push(`  ${key}:`);
      for (const [k, v] of Object.entries(val)) {
        const kk = PLAIN_SCALAR.test(k) && !RESERVED.test(k) ? k : JSON.stringify(k);
        lines.push(`    ${kk}: ${blockScalar(v)}`);
      }
    } else {
      lines.push(`  ${key}: {}`);
    }
  }
  return lines;
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (a instanceof Date || b instanceof Date) return a instanceof Date && b instanceof Date && a.getTime() === b.getTime();
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  if (isObj(a) && isObj(b)) {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    return ka.length === kb.length && ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && deepEqual(a[k], b[k]));
  }
  return false;
}

function joinDocument(fmText, body) {
  return fmText === '' ? `---\n---\n${body}` : `---\n${fmText}\n---\n${body}`;
}

/** 顶层 `menu:` 那一行在 fmText 里的位置和写法。 */
function findMenuLine(lines) {
  for (let i = 0; i < lines.length; i++) {
    const m = /^(?:menu|"menu"|'menu')[ \t]*:(.*)$/.exec(lines[i]);
    if (m) return { index: i, rest: m[1] };
  }
  return null;
}

/** 块状的 `menu:` 下面有块状的 `main:`（setFields 能逐层修改、保留注释）。 */
function isBlockMenuWithBlockMain(lines) {
  const at = findMenuLine(lines);
  if (!at || !/^[ \t]*(#.*)?$/.test(at.rest)) return false;
  for (let i = at.index + 1; i < lines.length; i++) {
    const l = lines[i];
    if (/^[ \t]*(#.*)?$/.test(l)) continue;
    if (!/^\s/.test(l)) break; // 下一个顶层键
    const m = /^(\s+)(?:main|"main"|'main')[ \t]*:(.*)$/.exec(l);
    if (m) return /^[ \t]*(#.*)?$/.test(m[2]);
  }
  return false;
}

/** setFields 写出的 `parent: "research"`（4 个固定栏目之一）改成和约定一样的 `parent: research`。 */
function tidyParentLine(fmText) {
  return fmText.replace(/^([ \t]+parent:[ \t]*)"(about|research|posts|courses)"([ \t]*(?:#.*)?)$/m, '$1$2$3');
}

/**
 * 修改一个文件的 menu.main：spec = { parent, weight } 设置（parent 为 null = 顶层独立一项），spec = null 去掉。
 * 正文一字不改；front matter 只动 menu 那几行（块状写法时逐层修改，保留注释和 identifier 等其他键；
 * 原来没有 menu 时在末尾追加块状写法；原来是单行写法时在原位置换成块状写法）。
 * 结果和原文件一样时返回原文。
 * @param {string} text 文件全文
 * @param {{ parent?: string|null, weight: number } | null} spec
 * @param {string} [path] 只用于报错
 * @returns {string}
 * @throws {FrontMatterError}
 */
export function patchMainMenu(text, spec, path = '') {
  const doc = splitDocument(text);
  const where = path ? `「${path}」` : '这个文件';
  if (doc.kind === 'toml') throw new FrontMatterError(`${where}的设置区不是 YAML 格式（---），后台无法自动修改，请在 GitHub 上手动改`);
  const fmText = doc.kind === 'none' ? '' : doc.fmText;
  const fm = parseFrontMatter(fmText);
  const cur = mainMenuEntry(fm);
  if (spec && !Number.isSafeInteger(Number(spec.weight))) throw new FrontMatterError('菜单顺序必须是整数');
  const want = spec ? { parent: spec.parent || null, weight: Number(spec.weight) } : null;
  if (!want && !cur.inMenu) return text;
  const curMain = isObj(fm.menu) && isObj(fm.menu.main) ? fm.menu.main : null;
  if (want && cur.inMenu && curMain && cur.parent === want.parent && curMain.weight === want.weight) return text;

  let out;
  const expectedMenu = want ? menuWithMain(fm.menu, want) : menuWithoutMain(fm.menu);
  const lines = fmText === '' ? [] : fmText.split('\n');
  if (!want) {
    out = setFields(fmText, { menu: expectedMenu });
  } else if (fm.menu !== undefined && isBlockMenuWithBlockMain(lines) && curMain) {
    out = tidyParentLine(setFields(fmText, { menu: expectedMenu }));
  } else {
    // 没有 menu，或者是单行 / 字符串 / 列表写法：去掉原来的 menu，在同一位置写块状的 menu
    const at = findMenuLine(lines);
    const removed = fm.menu !== undefined ? setFields(fmText, { menu: undefined }) : fmText;
    const rl = removed === '' ? [] : removed.split('\n');
    // 整块重写：main 下按「其他键（identifier…）→ parent → weight」的顺序写
    const ordered = { ...expectedMenu };
    if (isObj(ordered.main)) {
      const { parent: p, weight: w, ...rest } = ordered.main;
      ordered.main = { ...rest, ...(p ? { parent: p } : {}), weight: w };
    }
    const block = menuBlockLines(ordered);
    if (at && at.index <= rl.length) rl.splice(at.index, 0, ...block);
    else {
      // 末尾的空行留在最后
      let end = rl.length;
      while (end > 0 && rl[end - 1] === '') end--;
      rl.splice(end, 0, ...block);
    }
    out = rl.join('\n');
  }
  const expected = { ...fm };
  if (expectedMenu === undefined) delete expected.menu;
  else expected.menu = expectedMenu;
  const result = joinDocument(out, doc.body);
  const again = splitDocument(result);
  let parsed;
  try { parsed = parseFrontMatter(again.fmText); } catch { parsed = null; }
  if (again.body !== doc.body || !parsed || !deepEqual(parsed, expected)) {
    throw new FrontMatterError(`修改 ${path || '文件'} 的菜单时校验未通过，已取消（文件没有被改动）`);
  }
  return result;
}

// ---------------------------------------------------------------------------
// 博客分类

/** front matter 的 categories → 字符串列表（`categories: notes` 也算一个）。 */
export function categoriesOf(fm) {
  const c = fm && fm.categories;
  if (typeof c === 'string') return c.trim() ? [c.trim()] : [];
  if (Array.isArray(c)) return c.map((x) => (typeof x === 'string' ? x.trim() : x == null ? '' : String(x))).filter(Boolean);
  return [];
}

/** 显示用的分类名：固定的键用中文名，不认识的原样。 */
export function categoryLabel(key) {
  return CATEGORY_LABELS[key] || String(key);
}

/**
 * 编辑器里「分类」下拉框的值：'' = 不分类；'notes' / 'essays'；'keep' = 写了别的（或多个），保持原样。
 */
export function categoryChoice(list) {
  const l = Array.isArray(list) ? list : [];
  if (!l.length) return '';
  if (l.length === 1 && CATEGORY_KEYS.includes(l[0])) return l[0];
  return 'keep';
}

/** 两个分类列表是否相同（顺序也算）。 */
export function sameCategories(a, b) {
  const x = Array.isArray(a) ? a : [];
  const y = Array.isArray(b) ? b : [];
  return x.length === y.length && x.every((v, i) => v === y[i]);
}

/**
 * setFields 写出的 `categories: ["notes"]`（只有简单的键时）改成和约定一样的 `categories: [notes]`。
 * 改完重新解析，值不变才用。
 */
export function tidyCategoriesLine(fmText) {
  const src = String(fmText ?? '');
  // 行尾的注释（`categories: ["notes"]   # 分类`）原样留着
  const out = src.replace(/^categories: \[((?:"[a-z][a-z0-9-]*"(?:, )?)+)\]([ \t]+#.*)?$/m, (all, inner, comment = '') => {
    const keys = inner.split(', ').map((s) => s.replace(/^"|"$/g, ''));
    if (keys.some((k) => RESERVED.test(k))) return all;
    return `categories: [${keys.join(', ')}]${comment}`;
  });
  if (out === src) return src;
  try {
    return deepEqual(parseFrontMatter(out), parseFrontMatter(src)) ? out : src;
  } catch {
    return src;
  }
}

/**
 * 把一篇文章的分类设为 list（[] = 去掉 categories 键）。值没变时原样返回（`categories: notes` 和 `[notes]` 算相同）。
 * @param {string|null} fmText
 * @param {string[]} list
 * @returns {string} 新的 fmText
 */
export function setCategoriesFm(fmText, list) {
  const src = fmText ?? '';
  const fm = parseFrontMatter(src);
  const want = Array.isArray(list) ? list.filter(Boolean) : [];
  if (sameCategories(categoriesOf(fm), want) && (want.length || fm.categories === undefined)) return src;
  return tidyCategoriesLine(setFields(src, { categories: want.length ? [...want] : undefined }));
}

/**
 * 整个文件版本：只改 categories（正文一字不改）。值没变时返回原文。
 * @throws {FrontMatterError} TOML 设置区等
 */
export function patchCategories(text, list, path = '') {
  const doc = splitDocument(text);
  if (doc.kind === 'toml') throw new FrontMatterError(`${path ? `「${path}」` : '这个文件'}的设置区不是 YAML 格式（---），后台无法自动修改分类，请在 GitHub 上手动改`);
  const fmText = doc.kind === 'none' ? '' : doc.fmText;
  const next = setCategoriesFm(fmText, list);
  if (next === fmText) return text;
  const out = joinDocument(next, doc.body);
  const again = splitDocument(out);
  if (again.body !== doc.body || !sameCategories(categoriesOf(parseFrontMatter(again.fmText)), list || [])) {
    throw new FrontMatterError(`修改 ${path || '文件'} 的分类时校验未通过，已取消（文件没有被改动）`);
  }
  return out;
}
