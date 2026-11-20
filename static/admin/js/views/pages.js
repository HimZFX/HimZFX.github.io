/**
 * views/pages.js — 「菜单与页面」（「设置」里的标签页 #/settings?tab=pages；旧地址 #/pages 自动跳到这里）。
 *
 * - 网站顶部菜单是一棵两层的树（网站约定见 docs/admin-architecture.md 第 16 节）：
 *   4 个固定栏目 About / Research / Blog / Course Materials（front matter 里有 menu.main.identifier），
 *   每个栏目的下拉菜单里挂着 menu.main.parent = <identifier> 的页面；也可以有不带 parent 的「顶层独立一项」。
 * - 这里把树画出来：顶层按顺序，每个栏目下面是它的子页面。同一层里改顺序（数字输入 + 上移 / 下移），
 *   非固定的页面用「放在哪个栏目下」选择：不在菜单 / About / Research / Blog / Course Materials / 顶层（独立一项）。
 *   4 个固定栏目只能改顺序（不能去掉 identifier、不能挂到别的栏目下面）。
 * - 「保存菜单」= 一个提交，只包含改动了的文件；同一页面的所有语言版本一起改（patchMainMenu：只动 menu 那几行，注释原样保留）。
 * - 「新建栏目」：英文名称（必填，默认语言）、中文名称（可选）、网址、放在哪个栏目下（默认不在菜单）、顺序
 *   → content/<网址>/_index.md（有中文名称时再加 _index.zh.md）→ 打开编辑器。
 * - 不在菜单里的页面列在「其他页面」；博客分类页（content/categories/…）只列出来，不能放进菜单（网站自动把有文章的分类放进 Blog ▾）。
 *
 * @module views/pages
 */

import {
  h, svgIcon, render, clear, toast, modal, confirmDialog, withBusy, badge, emptyState,
  errorState, errorMessage,
} from '../ui.js';
import {
  groupPages, languageStatus, statusText, isPost, isDraftFm, isValidSlug, slugify, variantPath, langSitePath,
} from '../content.js';
import { splitDocument, parseFrontMatter, setFields, FrontMatterError } from '../frontmatter.js';
import { listDrafts } from '../drafts.js';
import { PATHS } from '../config.js';
import { isCourseDir, collectCourses } from '../courses.js';
import {
  mainMenuEntry, patchMainMenu, isFixedTop, menuWeightError, TOP_MENU, TOP_IDS, PARENT_LABELS,
} from '../sitemenu.js';
import { nextMenuWeight } from '../academic.js';
import {
  readFrontMatters, pagePath, pageUrl, editHash, draftsCard, draftIsPost, skeletonRows,
} from './posts.js';

/** 新建栏目对话框里各语言名称的示例、新文件正文的占位文字（按这一栏的语言，不按哪个是默认语言）。 */
const SECTION_EXAMPLE = { zh: '例如：项目', en: 'e.g. Projects' };
const SECTION_INTRO = { zh: '这里写栏目介绍…', en: 'Write the section introduction here…' };

/** 不能用作栏目网址的名字（Hugo 自带的页面、语言代码、static/ 下已有的网址等）。 */
const RESERVED_SLUGS = new Set([
  'posts', 'tags', 'categories', 'series', 'search', 'archives', 'archive', 'page', 'admin', 'images',
  'documents', 'assets', 'css', 'js', 'fonts', 'static', 'index', 'sitemap', 'rss', 'feed', 'home',
]);

// ---------------------------------------------------------------------------
// 菜单 front matter 的小工具

/**
 * 解析 front matter 里的 main 菜单项（实现在 sitemenu.mainMenuEntry）。
 * Hugo 支持三种写法：`menu: main`、`menu: ["main"]`、`menu: { main: { weight: 10 } }`。
 * @returns {{ inMenu: boolean, weight: number|null, parent: string|null, identifier: string|null }}
 */
export function mainMenuOf(fm) {
  return mainMenuEntry(fm);
}

/**
 * 给 menu 字段设置 main 的 weight，返回新的整个 menu 值（交给 setFields）。
 * 其他菜单、main 下的其他键都保留。
 */
export function menuWithWeight(menu, weight) {
  if (typeof menu === 'string') return { [menu]: menu === 'main' ? { weight } : {}, ...(menu === 'main' ? {} : { main: { weight } }) };
  if (Array.isArray(menu)) {
    const out = {};
    for (const name of menu) out[name] = name === 'main' ? { weight } : {};
    if (!out.main) out.main = { weight };
    return out;
  }
  const base = menu && typeof menu === 'object' ? menu : {};
  const main = base.main && typeof base.main === 'object' ? base.main : {};
  return { ...base, main: { ...main, weight } };
}

/** splitDocument 的严格逆运算：正文原样保留（只有分隔线和 front matter 是我们写的）。 */
function joinDocument(fmText, body) {
  return fmText === '' ? `---\n---\n${body}` : `---\n${fmText}\n---\n${body}`;
}

/**
 * 修改一个文件 menu.main.weight，返回新全文。正文一字不改；front matter 只动 menu 那几行。
 * @throws {FrontMatterError|Error} 中文说明
 */
export function patchMenuWeight(text, weight, path = '') {
  const doc = splitDocument(text);
  if (doc.kind !== 'yaml') {
    throw new FrontMatterError(`${path ? `「${path}」` : '这个文件'}的设置区不是 YAML 格式（---），后台无法自动修改，请在 GitHub 上手动改`);
  }
  const fm = parseFrontMatter(doc.fmText);
  const fmText = setFields(doc.fmText, { menu: menuWithWeight(fm.menu, weight) });
  const out = joinDocument(fmText, doc.body);
  // 再检查一遍：正文没变、菜单顺序确实是新值
  const again = splitDocument(out);
  if (again.body !== doc.body || mainMenuOf(parseFrontMatter(again.fmText)).weight !== weight) {
    throw new FrontMatterError(`修改 ${path || '文件'} 的菜单顺序时校验未通过，已取消（文件没有被改动）`);
  }
  return out;
}

/**
 * 新栏目的 front matter（块状写法，和现有文件风格一致），返回 fmText。
 * @param {string} title
 * @param {number|null} weight null = 不在菜单
 * @param {string|null} [parent] 放在哪个栏目的下拉菜单里；null = 顶层独立一项
 */
export function sectionFrontMatter(title, weight, parent = null) {
  let fmText = `title: ${JSON.stringify(title)}`;
  if (weight != null) fmText += `\nmenu:\n  main:\n${parent ? `    parent: ${parent}\n` : ''}    weight: ${weight}`;
  const fm = parseFrontMatter(fmText);
  const m = mainMenuEntry(fm);
  if (fm.title !== title || (weight != null && (m.weight !== weight || m.parent !== (parent || null))) || (weight == null && m.inMenu)) {
    throw new Error('生成栏目设置时出错，请换一个名称再试');
  }
  return fmText;
}

/** 「放在哪个栏目下」的选项（值：'none' / 4 个栏目的 identifier / 'top'）。 */
export const PLACE_OPTIONS = Object.freeze([
  ['none', '不在菜单'],
  ...TOP_MENU.map((t) => [t.id, `${t.label} ▾（${t.zh}）`]),
  ['top', '顶层（独立一项）'],
]);

/** 一个页面在菜单里的位置：'none' | 'top' | 上级的 identifier。 */
function placeOf(entry) {
  if (!entry || !entry.inMenu) return 'none';
  return entry.parent || 'top';
}

const CATEGORY_DIR_RE = /^content\/categories(\/|$)/;

// ---------------------------------------------------------------------------


/**
 * @param {HTMLElement} container
 * @param {Record<string,string>} params
 * @param {object} ctx
 */
export default async function mount(container, params, ctx) {
  const repo = ctx.repo;
  const langs = ctx.langs && ctx.langs.length ? ctx.langs : ['zh', 'en'];
  const state = {
    rows: null,          // 行数据；null = 加载中
    loadError: null,
    readErrors: 0,
    edits: new Map(),    // group key → { place?: string, weight?: string }（weight 是输入框里的文字）
    drafts: [],
    disposed: false,
    loadSeq: 0,
    saving: false,
  };

  ctx.setTitle('菜单与页面');

  const refreshBtn = h('button', {
    type: 'button', class: 'btn btn-ghost btn-icon', 'aria-label': '刷新（重新读取网站内容）', title: '刷新',
    dataset: { testid: 'pages-refresh' },
  }, svgIcon('refresh'));
  const newBtn = h('button', { type: 'button', class: 'btn btn-primary', dataset: { testid: 'pages-new-section' } }, svgIcon('plus'), '新建栏目');
  const header = h('div', { class: 'page-header' },
    h('div', {},
      h('h1', {}, '菜单与页面'),
      h('p', { class: 'page-desc' }, '网站顶部菜单有 4 个栏目，每个栏目可以有一个下拉菜单（例如 Research ▾ 下的论文）。同一层里数字越小越靠前（靠左 / 靠上）。')),
    h('div', { class: 'actions' }, refreshBtn, newBtn));

  const draftsHost = h('div');
  const navPreview = h('div', { class: 'card lists-nav-preview', dataset: { testid: 'nav-preview' } });
  const menuList = h('ul', { class: 'list lists-list lists-tree', dataset: { testid: 'pages-list' }, 'aria-busy': 'true' }, skeletonRows(4));
  const saveBtn = h('button', { type: 'button', class: 'btn btn-primary', dataset: { testid: 'pages-save-order' } }, svgIcon('check'), '保存菜单');
  const resetBtn = h('button', { type: 'button', class: 'btn btn-ghost', dataset: { testid: 'pages-reset-order' } }, '撤销修改');
  const saveHint = h('span', { class: 'muted small lists-save-hint' });
  const saveBar = h('div', { class: 'lists-savebar', dataset: { testid: 'pages-savebar' } },
    saveHint, h('div', { class: 'row' }, resetBtn, saveBtn));
  const menuSection = h('section', { class: 'stack stack-sm' },
    h('div', { class: 'row row-between lists-section-head' },
      h('h2', { class: 'lists-section-title' }, '顶部菜单'),
      h('span', { class: 'muted small' }, '改好后点「保存菜单」，一次发布')),
    menuList,
    saveBar);
  const otherList = h('ul', { class: 'list lists-list', dataset: { testid: 'pages-other-list' } });
  const otherSection = h('section', { class: 'stack stack-sm' },
    h('div', { class: 'row row-between lists-section-head' },
      h('h2', { class: 'lists-section-title' }, '其他页面'),
      h('span', { class: 'muted small' }, '不在菜单里，可以通过链接访问；用「放在哪个栏目下」加进菜单')),
    otherList);
  otherSection.hidden = true;
  const noticeHost = h('div');
  const body = h('div', { class: 'stack' }, noticeHost, navPreview, menuSection, otherSection);

  render(container, h('div', { class: 'lists-view pages-view stack' }, header, draftsHost, body));
  navPreview.hidden = true;
  updateSaveBar();

  // ---- 事件 ----
  refreshBtn.addEventListener('click', () => withBusy(refreshBtn, async () => {
    if (state.edits.size && !(await confirmDialog({
      title: '放弃没保存的菜单修改？', message: '刷新会重新读取网站上的内容，你刚才改的菜单还没有保存。', okText: '放弃并刷新', danger: true,
    }))) return;
    try {
      state.edits.clear();
      await repo.load();
      await refreshDrafts();
      toast('已是最新内容', { type: 'success' });
    } catch (err) {
      toast(`刷新失败：${errorMessage(err)}`, { type: 'error' });
    }
  }));
  newBtn.addEventListener('click', () => openNewSection());
  saveBtn.addEventListener('click', () => withBusy(saveBtn, saveMenu));
  resetBtn.addEventListener('click', () => { state.edits.clear(); renderAll(); });

  let changeTimer = null;
  const unsubscribe = repo.onChange(() => {
    clearTimeout(changeTimer);
    changeTimer = setTimeout(() => { if (!state.disposed) loadRows(); }, 0);
  });

  // ---- 数据 ----
  async function refreshDrafts() {
    const all = await listDrafts();
    if (state.disposed) return;
    state.drafts = all.filter((d) => !draftIsPost(d, langs));
    render(draftsHost, draftsCard(ctx, state.drafts, {
      onChanged: refreshDrafts,
      describe: (d) => (d.path ? d.path : d.groupKey ? `新页面 · ${d.groupKey}` : null),
    }));
  }

  async function loadRows() {
    const seq = ++state.loadSeq;
    // 课程单元页和子推文（content/courses/<课程>/…）在「课程」里管理，这里只列「课程资料」总页本身
    const groups = groupPages(repo.list(PATHS.content + '/'), langs).filter((g) => !isPost(g) && !isCourseDir(g.dir));
    let fms;
    try {
      fms = await readFrontMatters(repo, groups.flatMap((g) => Object.values(g.variants)));
    } catch (err) {
      if (state.disposed || seq !== state.loadSeq) return;
      state.loadError = err;
      renderAll();
      return;
    }
    if (state.disposed || seq !== state.loadSeq) return;
    state.loadError = null;
    state.readErrors = [...fms.values()].filter((r) => r.readError).length;
    state.rows = groups.map((g) => buildRow(g, fms));
    // 文件已经不存在的修改丢掉；其余保留（冲突后重新加载时用户的修改不丢）
    for (const key of [...state.edits.keys()]) {
      const row = state.rows.find((r) => r.group.key === key);
      if (!row) { state.edits.delete(key); continue; }
      // 固定栏目、分类页不能换位置（只保留顺序的修改）
      const e = state.edits.get(key);
      if (row.locked) { state.edits.delete(key); continue; }
      if ((row.fixed || row.isCategory) && e.place !== undefined) storeEdit(row, { ...e, place: undefined });
    }
    renderAll();
  }

  function buildRow(group, fms) {
    const fmOf = (p) => (p && fms.get(p) ? fms.get(p).fm : {});
    const status = languageStatus(group, langs);
    const present = langs.filter((l) => status.perLang[l]);
    const mainLang = status.perLang[ctx.defaultLang] ? ctx.defaultLang : present[0] || ctx.defaultLang;
    const mainPath = status.perLang[mainLang] || Object.values(group.variants)[0];
    const perLang = present.map((lang) => {
      const p = status.perLang[lang];
      const fm = fmOf(p);
      const menu = mainMenuEntry(fm);
      const name = [fm.linkTitle, fm.title].find((t) => typeof t === 'string' && t.trim());
      return { lang, path: p, fm, name: name ? name.trim() : '', draft: isDraftFm(fm), ...menu };
    });
    const main = perLang.find((x) => x.lang === mainLang) || perLang[0] || { fm: {}, weight: null };
    const menuVariants = perLang.filter((x) => x.inMenu);
    const ref = main.inMenu ? main : menuVariants[0] || null;
    const weight = ref ? (ref.weight ?? (menuVariants.find((x) => x.weight != null) || {}).weight ?? null) : null;
    const errors = Object.values(group.variants).map((p) => ({ path: p, r: fms.get(p) })).filter((x) => x.r && x.r.error);
    const identifier = (menuVariants.find((x) => x.identifier) || {}).identifier || null;
    return {
      group, status, perLang, mainLang, mainPath, errors,
      title: main.name || group.base,
      inMenu: menuVariants.length > 0,
      place: placeOf(ref),
      weight,
      identifier,
      // 4 个固定栏目：只能改顺序
      fixed: !!ref && isFixedTop(ref),
      isCategory: CATEGORY_DIR_RE.test(group.dir),
      // 有语言文件的设置区读不了 / 改不了（TOML、格式错误、读取失败）：不提供位置和顺序的修改（保存时只会被跳过或报错）
      locked: errors.length > 0,
      // 各语言的顺序 / 位置不一致时提示一下（保存时会统一）
      mixedWeights: new Set(menuVariants.map((x) => x.weight)).size > 1,
      mixedPlaces: new Set(perLang.map((x) => placeOf(x))).size > 1,
    };
  }

  /** 修改后的位置。 */
  function effPlace(row) {
    const e = state.edits.get(row.group.key);
    return e && e.place !== undefined ? e.place : row.place;
  }

  /** 修改后的顺序（数字；输入无效 → NaN；不在菜单 → null）。 */
  function effWeight(row) {
    if (effPlace(row) === 'none') return null;
    const e = state.edits.get(row.group.key);
    if (!e || e.weight === undefined) return row.weight;
    const s = String(e.weight).trim();
    return s === '' ? NaN : Number(s);
  }

  function rowChanged(r) {
    const p = effPlace(r);
    if (p !== r.place) return true;
    return p !== 'none' && state.edits.has(r.group.key) && effWeight(r) !== r.weight;
  }

  function changedRows() {
    return (state.rows || []).filter(rowChanged);
  }

  /** 改过的顺序有什么问题（不是整数、是 0 …）；没改过或没问题返回 null。 */
  function weightError(r) {
    const e = state.edits.get(r.group.key);
    if (effPlace(r) === 'none' || !e || e.weight === undefined) return null;
    return menuWeightError(e.weight);
  }

  function invalidRows() {
    return (state.rows || []).filter((r) => weightError(r));
  }

  function byWeight(a, b) {
    const wa = effWeight(a);
    const wb = effWeight(b);
    const fa = Number.isFinite(wa);
    const fb = Number.isFinite(wb);
    if (fa !== fb) return fa ? -1 : 1;
    if (fa && wa !== wb) return wa - wb;
    return a.title.localeCompare(b.title, 'zh-CN');
  }

  /** 同一层的页面（按修改后的顺序）。level：'top' 或上级的 identifier。 */
  function levelRows(level) {
    return (state.rows || []).filter((r) => effPlace(r) === level).sort(byWeight);
  }

  /** 顶层：固定栏目 + 独立的顶层页面；上级不存在的子页面也放在顶层显示（带提示）。 */
  function treeRows() {
    const top = levelRows('top');
    const ids = new Set(top.map((r) => r.identifier).filter(Boolean));
    const orphans = (state.rows || []).filter((r) => { const p = effPlace(r); return p !== 'none' && p !== 'top' && !ids.has(p); }).sort(byWeight);
    const out = [];
    for (const r of top) {
      out.push({ row: r, level: 'top' });
      if (r.identifier) for (const c of levelRows(r.identifier)) out.push({ row: c, level: r.identifier, child: true });
    }
    for (const r of orphans) out.push({ row: r, level: effPlace(r), orphan: true });
    return out;
  }

  // ---- 渲染 ----
  // 重新渲染会移走带着没提交数字的顺序输入框 → 它失焦时的 change 又要渲染：这时跳过（外层正在按最新状态渲染）
  let rendering = false;
  function renderAll() {
    if (state.disposed || rendering) return;
    rendering = true;
    try { renderAllNow(); } finally { rendering = false; }
  }

  function renderAllNow() {
    clear(noticeHost);
    if (state.loadError) {
      render(body, h('div', { class: 'card' }, errorState('页面列表读取失败', {
        detail: errorMessage(state.loadError),
        retry: () => { render(body, noticeHost, navPreview, menuSection, otherSection); render(menuList, skeletonRows(4)); loadRows(); },
      })));
      return;
    }
    if (!state.rows) return;
    menuList.removeAttribute('aria-busy');
    if (state.readErrors) {
      noticeHost.appendChild(h('div', { class: 'banner banner-error', role: 'alert' }, svgIcon('warning'),
        h('span', {}, `有 ${state.readErrors} 个文件暂时读取失败，菜单名称和顺序可能不准确。可以点右上角刷新重试。`)));
    }
    const tree = treeRows();
    const others = state.rows.filter((r) => effPlace(r) === 'none').sort((a, b) => a.group.key.localeCompare(b.group.key));
    if (!tree.length) {
      render(menuList, h('li', {}, emptyState('菜单里还没有页面。新建一个栏目，它就会出现在网站顶部。', { text: '新建栏目', onClick: () => openNewSection(), icon: 'plus' }, { icon: 'page' })));
    } else {
      const out = [];
      for (const item of tree) {
        const sib = item.orphan ? levelRows(item.level) : levelRows(item.level);
        out.push(rowEl(item.row, { level: item.level, child: !!item.child, orphan: !!item.orphan, index: sib.indexOf(item.row), count: sib.length, siblings: sib }));
        // 固定栏目下面还没有子页面：一句说明
        if (item.level === 'top' && item.row.identifier && TOP_IDS.includes(item.row.identifier) && !levelRows(item.row.identifier).length) {
          out.push(h('li', { class: 'lists-tree-empty muted small', dataset: { testid: 'page-children-empty', parent: item.row.identifier } },
            `${PARENT_LABELS[item.row.identifier]} ▾ 下拉菜单里还没有别的页面（只有「${item.row.title}」本身）`));
        }
      }
      render(menuList, out);
    }
    otherSection.hidden = !others.length;
    render(otherList, others.map((r) => rowEl(r, { level: 'none' })));
    renderNavPreview(tree);
    updateSaveBar();
  }

  function renderNavPreview(tree) {
    navPreview.hidden = !tree.length;
    render(navPreview,
      h('div', { class: 'lists-nav-head' }, svgIcon('eye'), h('span', {}, '菜单预览'),
        changedRows().length ? h('span', { class: 'muted small' }, '（含未保存的修改）') : null),
      h('div', { class: 'lists-nav-rows' }, langs.map((lang) => {
        const nameOf = (r) => { const x = r.perLang.find((v) => v.lang === lang); return x && !x.draft ? (x.name || '（无名称）') : null; };
        const items = [];
        for (const item of tree) {
          if (item.child || item.orphan) continue;
          const name = nameOf(item.row);
          if (!name) continue;
          const kids = item.row.identifier ? levelRows(item.row.identifier).map(nameOf).filter(Boolean) : [];
          items.push(h('span', { class: 'lists-nav-item', dataset: { testid: 'nav-preview-item' } }, name,
            kids.length ? h('span', { class: 'lists-nav-kids muted' }, ` ▾ ${kids.join(' · ')}`) : null));
        }
        return h('div', { class: 'lists-nav-row', dataset: { testid: `nav-preview-${lang}` } },
          h('span', { class: 'lists-nav-label' }, ctx.siteLabel(lang)),
          h('div', { class: 'lists-nav-items' },
            items.length ? items : h('span', { class: 'muted small' }, '（没有菜单项）')));
      })),
      h('p', { class: 'muted small lists-nav-note' }, 'Blog ▾ 下拉菜单里还会自动出现有文章的博客分类（科研笔记 / 随笔），不用在这里设置。'));
  }

  function updateSaveBar() {
    const changed = changedRows();
    const invalid = invalidRows();
    saveBar.hidden = !state.rows;
    saveBtn.disabled = state.saving || !changed.length || invalid.length > 0;
    resetBtn.hidden = !state.edits.size;
    saveBar.classList.toggle('is-dirty', changed.length > 0);
    saveHint.textContent = invalid.length
      ? `「${invalid[0].title}」：${weightError(invalid[0])}`
      : changed.length ? `已修改 ${changed.length} 个页面，还没有保存` : '菜单没有修改';
    saveHint.classList.toggle('text-danger', invalid.length > 0);
  }

  function placeLabel(place) {
    if (place === 'none') return '不在菜单';
    if (place === 'top') return '顶层';
    return PARENT_LABELS[place] ? `${PARENT_LABELS[place]} ▾` : place;
  }

  function rowEl(r, { level, child = false, orphan = false, index = 0, count = 0, siblings = [] }) {
    const g = r.group;
    const place = effPlace(r);
    const names = h('div', { class: 'lists-names' }, langs.map((lang) => {
      const v = r.perLang.find((x) => x.lang === lang);
      const inMenu = place !== 'none';
      return h('div', { class: 'lists-name', dataset: { testid: `page-name-${lang}` } },
        h('span', { class: 'lists-name-lang' }, ctx.langName(lang)),
        v ? h('span', { class: ['lists-name-text', !v.inMenu && inMenu && r.inMenu && 'muted'] }, v.name || '（无标题）',
          !v.inMenu && inMenu && r.inMenu ? h('span', { class: 'muted small' }, '（不在菜单）') : null)
          : h('span', { class: 'lists-name-text muted' }, '没有这一页'));
    }));

    const mainV = r.perLang.find((x) => x.lang === r.mainLang);
    const href = mainV && !mainV.draft ? pageUrl(g, r.mainLang, mainV.fm, ctx) : null;
    const urlText = pagePath(g, r.mainLang, mainV ? mainV.fm : {}, ctx);

    const langBadge = badge(statusText(r.status, ctx), r.status.kind === 'split' ? 'blue' : 'gray');
    langBadge.dataset.testid = 'page-lang';
    const tip = (b, text, testid) => { b.title = text; if (testid) b.dataset.testid = testid; return b; };
    const meta = h('div', { class: 'list-item-meta' },
      href ? h('a', { class: 'lists-url mono', href, target: '_blank', rel: 'noopener noreferrer', title: '在网站上打开（新标签页）' }, urlText, svgIcon('external'))
        : h('span', { class: 'lists-url mono' }, urlText),
      langBadge,
      r.fixed ? tip(badge('固定栏目', 'blue'), '网站顶部菜单的 4 个固定栏目之一（有菜单编号 identifier）：只能调整顺序。', 'page-fixed') : null,
      orphan ? tip(badge(`上级「${place}」不存在`, 'orange'), `这个页面写了 menu.main.parent: ${place}，但没有哪个顶层栏目的菜单编号是 ${place}，网站上不会显示它。用右边的选择框换一个栏目。`, 'page-orphan') : null,
      r.perLang.some((x) => x.draft) ? badge(r.perLang.every((x) => x.draft) ? '草稿' : `${r.perLang.filter((x) => x.draft).map((x) => ctx.langName(x.lang)).join('、')}草稿`, 'gray') : null,
      r.mixedWeights ? tip(badge('各语言顺序不同', 'orange'), r.perLang.filter((x) => x.inMenu).map((x) => `${ctx.siteLabel(x.lang)}：${x.weight ?? '未设置'}`).join('\n') + '\n保存时会统一成同一个数字。') : null,
      r.mixedPlaces ? tip(badge('各语言位置不同', 'orange'), r.perLang.map((x) => `${ctx.siteLabel(x.lang)}：${placeLabel(placeOf(x))}`).join('\n') + '\n用「放在哪个栏目下」重新选一次，所有语言版本会改成一样。', 'page-mixed-place') : null,
      r.errors.length ? tip(badge('设置区有问题', 'red'), r.errors.map((e) => `${e.path}：${e.r.error}`).join('\n')) : null,
      r.isCategory ? h('span', { class: 'muted small', dataset: { testid: 'page-category-note' } }, '博客分类页：有文章时网站自动把它放进 Blog ▾') : null,
      g.key === `${PATHS.content}/courses/_index` ? (() => {
        const n = collectCourses(repo.list(PATHS.content + '/'), langs).length;
        return h('a', { class: 'lists-meta-item', href: '#/courses', dataset: { testid: 'page-courses-link' } },
          svgIcon('course'), n ? `${n} 门课程 · 在「课程」里管理` : '在「课程」里添加课程');
      })() : null);

    // 放在哪个栏目下（固定栏目、分类页没有）
    let placeEl = null;
    if (r.locked) {
      placeEl = h('span', { class: 'muted small', dataset: { testid: 'page-locked' } }, '菜单位置和顺序请在 GitHub 上改（这个页面的设置区后台改不了）');
    } else if (!r.fixed && !r.isCategory) {
      const sel = h('select', {
        class: ['input', 'lists-place', place !== r.place && 'is-changed'], 'aria-label': `「${r.title}」放在哪个栏目下`,
        dataset: { testid: 'page-place' },
      }, PLACE_OPTIONS.map(([v, l]) => h('option', { value: v }, l)),
      !PLACE_OPTIONS.some(([v]) => v === place) ? h('option', { value: place }, `${place}（不存在）`) : null);
      sel.value = place;
      sel.addEventListener('change', () => { setPlace(r, sel.value); renderAllKeepFocus(g.key, 'page-place'); });
      placeEl = h('label', { class: 'lists-place-wrap' }, h('span', { class: 'lists-order-label muted small' }, '放在'), sel);
    }

    let orderEl = null;
    if (place !== 'none' && !r.locked) {
      const e = state.edits.get(g.key);
      const cur = e && e.weight !== undefined ? e.weight : (effWeight(r) ?? '');
      const changed = rowChanged(r) && effWeight(r) !== r.weight;
      const input = h('input', {
        class: ['input', 'lists-weight', changed && 'is-changed'], type: 'number', step: 1, inputmode: 'numeric',
        value: String(cur), 'aria-label': `「${r.title}」的菜单顺序`, dataset: { testid: 'page-weight' },
        'aria-invalid': weightError(r) ? 'true' : 'false', title: weightError(r) || undefined,
      });
      input.addEventListener('input', () => {
        setWeight(r, input.value);
        input.classList.toggle('is-changed', effWeight(r) !== r.weight);
        input.setAttribute('aria-invalid', weightError(r) ? 'true' : 'false');
        updateSaveBar();
      });
      // 输入完成（失焦 / 回车 / 方向键）后再重新排序，避免打字时行跳来跳去
      input.addEventListener('change', () => { renderAllKeepFocus(g.key, 'page-weight'); });
      const dirWord = child ? ['往上移', '往下移'] : ['往前移（更靠左）', '往后移（更靠右）'];
      const up = h('button', {
        type: 'button', class: 'btn btn-ghost btn-sm btn-icon', 'aria-label': `把「${r.title}」${dirWord[0]}`, title: dirWord[0],
        dataset: { testid: 'page-up' }, disabled: index <= 0,
      }, svgIcon('up'));
      const down = h('button', {
        type: 'button', class: 'btn btn-ghost btn-sm btn-icon', 'aria-label': `把「${r.title}」${dirWord[1]}`, title: dirWord[1],
        dataset: { testid: 'page-down' }, disabled: index < 0 || index >= count - 1,
      }, svgIcon('down'));
      up.addEventListener('click', () => move(siblings, index, -1, 'page-up'));
      down.addEventListener('click', () => move(siblings, index, +1, 'page-down'));
      orderEl = h('div', { class: 'lists-order' },
        h('span', { class: 'lists-order-label muted small' }, '顺序'), input, up, down);
    }

    return h('li', {
      class: ['list-item', 'lists-row', 'lists-page-row', place !== 'none' && 'is-menu', child && 'is-child', orphan && 'is-orphan'],
      dataset: { testid: 'page-row', key: g.key, level: child ? 'child' : level === 'none' ? 'none' : 'top', parent: child || orphan ? level : undefined },
    },
      h('div', { class: 'list-item-main' },
        h('a', { class: 'list-item-title', href: editHash(r.mainPath), dataset: { testid: 'page-title' } },
          child ? h('span', { class: 'lists-tree-branch', 'aria-hidden': 'true' }, '└') : null, r.title),
        names,
        meta),
      h('div', { class: 'list-item-actions lists-page-actions' },
        placeEl,
        orderEl,
        h('a', { class: 'btn btn-sm', href: editHash(r.mainPath), dataset: { testid: 'page-edit' } }, svgIcon('edit'), '编辑')));
  }

  function editOf(r) {
    return { ...(state.edits.get(r.group.key) || {}) };
  }

  function storeEdit(r, e) {
    // 和原来一样的修改去掉
    if (e.place === r.place) delete e.place;
    if (e.weight !== undefined && e.place === undefined) {
      const s = String(e.weight).trim();
      if (s !== '' && Number(s) === r.weight) delete e.weight;
    }
    if (e.place === undefined && e.weight === undefined) state.edits.delete(r.group.key);
    else state.edits.set(r.group.key, e);
  }

  function setWeight(r, value) {
    const e = editOf(r);
    e.weight = String(value);
    storeEdit(r, e);
  }

  /** 换一个位置：顺序默认排在那一层的最后。 */
  function setPlace(r, place) {
    if (r.fixed || r.isCategory || r.locked) return;
    if (place !== 'none' && place !== 'top' && !TOP_IDS.includes(place) && place !== r.place) return;
    const e = editOf(r);
    if (place === r.place) {
      delete e.place;
      delete e.weight;
    } else {
      e.place = place;
      if (place === 'none') delete e.weight;
      else {
        const ws = levelRows(place).filter((x) => x !== r).map(effWeight).filter((w) => Number.isFinite(w));
        e.weight = String(nextMenuWeight(ws) || 1); // 0 在网站上 = 没有顺序（排到最后）
      }
    }
    storeEdit(r, e);
  }

  /** 和同一层相邻的页面交换位置（交换两者的顺序数字；数字相同时让移动的那个多/少 1）。 */
  function move(siblings, index, dir, focusId) {
    const a = siblings[index];
    const b = siblings[index + dir];
    if (!a || !b) return;
    if (a.locked || b.locked) {
      toast(`「${(a.locked ? a : b).title}」的设置区后台改不了，不能和它交换位置；可以直接改顺序数字`, { type: 'warning' });
      return;
    }
    let wa = effWeight(a);
    let wb = effWeight(b);
    if (!Number.isFinite(wa) || !Number.isFinite(wb)) {
      toast('请先把菜单顺序填成数字', { type: 'warning' });
      return;
    }
    if (wa === wb) wa = wb + dir;
    else [wa, wb] = [wb, wa];
    setWeight(a, String(wa));
    setWeight(b, String(wb));
    renderAllKeepFocus(a.group.key, focusId);
  }

  function renderAllKeepFocus(key, testid) {
    renderAll();
    const row = [...container.querySelectorAll('[data-testid="page-row"]')].find((el) => el.dataset.key === key);
    let target = row && row.querySelector(`[data-testid="${testid}"]`);
    if (target && target.disabled) target = row.querySelector('[data-testid="page-weight"]') || row.querySelector('[data-testid="page-place"]');
    if (target) try { target.focus({ preventScroll: true }); } catch { /* ignore */ }
  }

  // ---- 保存菜单 ----
  async function saveMenu() {
    const changed = changedRows();
    if (!changed.length || invalidRows().length) return;
    state.saving = true;
    updateSaveBar();
    try {
      const changes = [];
      const summary = [];
      const skipped = []; // TOML front matter：只能在 GitHub 上手动改
      let placeChanged = false;
      for (const r of changed) {
        const place = effPlace(r);
        const w = effWeight(r);
        const moved = place !== r.place;
        if (moved) placeChanged = true;
        if (r.fixed && moved) throw new Error(`「${r.title}」是固定栏目，不能移动到别的栏目下`);
        for (const path of Object.values(r.group.variants)) {
          const entry = repo.entry(path);
          if (!entry) continue;
          const text = await repo.readText(path);
          const doc = splitDocument(text);
          if (doc.kind === 'toml') { skipped.push(path); continue; }
          const cur = mainMenuEntry(parseFrontMatter(doc.kind === 'yaml' ? doc.fmText : ''));
          let spec;
          if (moved) {
            // 换了位置：所有语言版本都改成一样
            spec = place === 'none' ? null : { parent: place === 'top' ? null : place, weight: w };
            if (spec && spec.parent && cur.identifier && TOP_IDS.includes(cur.identifier) && !cur.parent) {
              throw new Error(`「${r.title}」是固定栏目，不能移动到别的栏目下`);
            }
          } else {
            // 只改顺序：不在菜单里的版本不擅自加菜单，各版本的上级保持不变
            if (!cur.inMenu || cur.weight === w) continue;
            spec = { parent: cur.parent, weight: w };
          }
          const out = patchMainMenu(text, spec, path);
          if (out !== text) changes.push({ path, content: out, baseSha: entry.sha });
        }
        if (moved) summary.push(`${r.title}：${placeLabel(r.place)} → ${placeLabel(place)}${place !== 'none' ? `（顺序 ${w}）` : ''}`);
        else summary.push(`${r.title}：顺序 ${r.weight ?? '未设置'} → ${w}`);
      }
      if (!changes.length) {
        state.edits.clear();
        renderAll();
        toast('菜单和网站上的一样，不需要发布', { type: 'info' });
        return;
      }
      let res;
      try {
        res = await ctx.publish({ message: placeChanged ? 'admin: 调整菜单' : 'admin: 调整菜单顺序', changes, summary });
      } catch {
        return; // 外壳已提示；修改保留，可以再点一次
      }
      if (res && res.conflict) {
        // 重新加载后 onChange 会重新读取；用户的修改（state.edits）保留，可以再保存一次
        if (res.reloaded) toast('已读取最新内容，你改的菜单还在，确认后再点一次「保存菜单」', { type: 'info', timeout: 6000 });
        return;
      }
      // 先用新值更新界面（随后 repo.onChange 会重新读取文件，结果相同），避免旧顺序闪一下
      for (const r of changed) {
        const place = effPlace(r);
        const w = effWeight(r);
        r.place = place;
        r.weight = w;
        r.inMenu = place !== 'none';
        r.mixedWeights = false;
        for (const v of r.perLang) if (v.inMenu || place !== 'none') v.weight = w;
      }
      state.edits.clear();
      if (skipped.length) {
        toast(`这些文件的设置区不是 YAML 格式，没有自动修改，请在 GitHub 上手动改：${skipped.join('、')}`, { type: 'warning', timeout: 10000 });
      }
      renderAll();
    } catch (err) {
      console.error(err);
      toast(errorMessage(err), { type: 'error', timeout: 8000 });
    } finally {
      state.saving = false;
      updateSaveBar();
    }
  }

  // ---- 新建栏目 ----
  function slugTaken(slug) {
    if (repo.list(`${PATHS.content}/${slug}/`).length) return '这个网址已经被一个栏目用了';
    for (const lang of [null, ...langs]) {
      if (repo.has(variantPath(PATHS.content, slug, lang))) return '已经有同名的页面了';
    }
    if (repo.list(`static/${slug}/`).length || repo.has(`static/${slug}`)) return '这个网址和网站上的文件夹重名了，换一个吧';
    if (RESERVED_SLUGS.has(slug) || langs.includes(slug)) return '这个网址是网站保留的，换一个吧';
    return null;
  }

  function openNewSection() {
    const others = langs.filter((l) => l !== ctx.defaultLang);
    let slugTouched = false;
    let weightTouched = false;

    const mkField = (id, labelText, input, hint, optional) => {
      const err = h('div', { class: 'error', role: 'alert' });
      err.hidden = true;
      input.id = id;
      const hintEl = h('div', { class: 'hint' }, hint || '');
      return {
        el: h('div', { class: 'field' },
          h('label', { htmlFor: id }, labelText, optional ? h('span', { class: 'optional' }, '（可选）') : null),
          input, hintEl, err),
        hintEl,
        setError(msg) { err.textContent = msg || ''; err.hidden = !msg; input.setAttribute('aria-invalid', msg ? 'true' : 'false'); },
      };
    };

    const nameInputs = {};
    const nameFields = [ctx.defaultLang, ...others].map((lang) => {
      const input = h('input', {
        class: 'input', type: 'text', autocomplete: 'off', maxlength: 60,
        placeholder: SECTION_EXAMPLE[lang] || '',
        dataset: { testid: `new-section-name-${lang}` }, 'data-autofocus': lang === ctx.defaultLang ? true : undefined,
      });
      nameInputs[lang] = input;
      const hint = lang === ctx.defaultLang
        ? `显示在菜单里的名字。${others.length ? `不填${others.map((l) => ctx.langName(l)).join('、')}名称时，所有语言都显示这个名字。` : ''}`
        : `填了就单独生成${ctx.langName(lang)}版本，${ctx.siteLabel(lang)}菜单显示这个名字`;
      return { lang, ...mkField(`ns-name-${lang}`, `${ctx.langName(lang)}名称`, input, hint, lang !== ctx.defaultLang) };
    });

    const slugInput = h('input', {
      class: 'input mono', type: 'text', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', maxlength: 81,
      placeholder: '例如：projects', dataset: { testid: 'new-section-slug' },
    });
    const urlPreview = h('div', { class: 'hint lists-url-preview', dataset: { testid: 'new-section-url' } });
    const slugField = mkField('ns-slug', '网址', slugInput, '只能用小写英文字母、数字和 -，例如 projects、teaching', false);
    slugField.el.appendChild(urlPreview);

    const placeSelect = h('select', { class: 'input', dataset: { testid: 'new-section-place' } },
      PLACE_OPTIONS.map(([v, l]) => h('option', { value: v }, l)));
    placeSelect.value = 'none';
    const placeField = mkField('ns-place', '放在哪个栏目下', placeSelect, '「不在菜单」：页面只能通过网址或链接打开，以后可以在这里的列表里再放进菜单。', false);

    const weightInput = h('input', {
      class: 'input lists-weight-lg', type: 'number', step: 1, inputmode: 'numeric', value: '',
      dataset: { testid: 'new-section-weight' },
    });
    const weightField = mkField('ns-weight', '菜单顺序', weightInput, '', false);

    const levelWeights = (place) => levelRows(place).map(effWeight).filter((w) => Number.isFinite(w));
    const updateWeight = () => {
      const place = placeSelect.value;
      weightField.el.hidden = place === 'none';
      if (place === 'none') return;
      const ws = levelWeights(place);
      const next = nextMenuWeight(ws) || 1; // 0 在网站上 = 没有顺序
      if (!weightTouched) weightInput.value = String(next);
      const max = ws.length ? Math.max(...ws) : null;
      weightField.hintEl.textContent = place === 'top'
        ? `数字越小越靠左。顶层现在最靠右的是 ${max ?? '—'}，填 ${next} 就排在最后。`
        : `${PARENT_LABELS[place]} ▾ 下拉菜单里数字越小越靠上。${max == null ? '现在里面还没有别的页面。' : `现在最下面的是 ${max}，填 ${next} 就排在最后。`}`;
    };
    placeSelect.addEventListener('change', () => { placeField.setError(null); updateWeight(); });
    updateWeight();

    const updatePreview = () => {
      const s = slugInput.value.trim();
      if (!s) { urlPreview.textContent = ''; return; }
      urlPreview.textContent = '网站上的地址：' + langs.map((l) => langSitePath(`${s}/`, l, ctx.defaultLang)).join('  ·  ');
    };
    const suggest = () => {
      if (slugTouched) return;
      const fromOther = others.map((l) => slugify(nameInputs[l].value)).find(Boolean);
      slugInput.value = fromOther || slugify(nameInputs[ctx.defaultLang].value) || '';
      updatePreview();
    };
    for (const f of nameFields) f.el.querySelector('input').addEventListener('input', () => { f.setError(null); suggest(); });
    slugInput.addEventListener('input', () => {
      slugTouched = slugInput.value.trim() !== '';
      slugField.setError(null);
      updatePreview();
    });
    weightInput.addEventListener('input', () => { weightTouched = true; weightField.setError(null); });

    const validate = () => {
      let ok = true;
      const main = nameInputs[ctx.defaultLang].value.trim();
      nameFields[0].setError(main ? null : `请填写${ctx.langName(ctx.defaultLang)}名称`);
      if (!main) ok = false;
      const slug = slugInput.value.trim();
      let slugErr = null;
      if (!slug) slugErr = '请填写网址（小写英文字母、数字和 -）';
      else if (!isValidSlug(slug)) slugErr = '网址只能用小写英文字母、数字和 -，并且以字母或数字开头';
      else slugErr = slugTaken(slug);
      slugField.setError(slugErr);
      if (slugErr) ok = false;
      const place = placeSelect.value;
      let w = null;
      if (place !== 'none') {
        const ws = weightInput.value.trim();
        w = Number(ws);
        const wErr = menuWeightError(ws);
        weightField.setError(wErr);
        if (wErr) ok = false;
      } else weightField.setError(null);
      return ok ? {
        names: Object.fromEntries(langs.map((l) => [l, nameInputs[l].value.trim()])), slug,
        weight: w, parent: place !== 'none' && place !== 'top' ? place : null,
      } : null;
    };

    const form = h('form', { class: 'stack lists-new-form', novalidate: true },
      nameFields.map((f) => f.el), slugField.el, placeField.el, weightField.el,
      h('p', { class: 'muted small' }, '创建后会打开编辑器，可以接着写栏目介绍。'));
    let m;
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const btn = m && m.footer.querySelector('[data-testid="new-section-ok"]');
      if (btn) btn.click();
    });
    // 回车提交
    form.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.isComposing && e.target instanceof HTMLInputElement) {
        e.preventDefault();
        const btn = m && m.footer.querySelector('[data-testid="new-section-ok"]');
        if (btn && !btn.disabled) btn.click();
      }
    });

    m = modal({
      title: '新建栏目',
      content: form,
      actions: [
        { text: '取消', kind: 'ghost', testid: 'new-section-cancel' },
        {
          text: '创建并发布', kind: 'primary', testid: 'new-section-ok',
          onClick: async (close) => {
            const v = validate();
            if (!v) {
              const bad = form.querySelector('[aria-invalid="true"]');
              if (bad) bad.focus();
              return;
            }
            const created = await createSection(v);
            if (created) {
              close();
              ctx.navigate(editHash(created));
            }
          },
        },
      ],
    });
  }

  async function createSection({ names, slug, weight, parent }) {
    const dir = `${PATHS.content}/${slug}`;
    const changes = [];
    const mainPath = variantPath(dir, '_index', null);
    const intro = (lang) => SECTION_INTRO[lang] || SECTION_INTRO.zh;
    changes.push({ path: mainPath, content: joinDocument(sectionFrontMatter(names[ctx.defaultLang], weight, parent), `\n${intro(ctx.defaultLang)}\n`), baseSha: null });
    for (const lang of langs) {
      if (lang === ctx.defaultLang || !names[lang]) continue;
      changes.push({ path: variantPath(dir, '_index', lang), content: joinDocument(sectionFrontMatter(names[lang], weight, parent), `\n${intro(lang)}\n`), baseSha: null });
    }
    let res;
    try {
      res = await ctx.publish({
        message: `admin: 新建栏目《${names[ctx.defaultLang]}》${parent ? `（${PARENT_LABELS[parent]} ▾ 下）` : ''}`,
        changes,
        summary: changes.map((c) => c.path),
      });
    } catch {
      return null; // 外壳已提示
    }
    if (!res || res.conflict) {
      // 同名文件刚被别处创建了
      toast('这个网址刚刚已经被占用了，请换一个网址', { type: 'warning' });
      return null;
    }
    return mainPath; // 成功提示由外壳统一显示
  }

  // ---- 首次加载 ----
  await Promise.all([refreshDrafts(), loadRows()]);

  return {
    isDirty: () => changedRows().length > 0,
    async canLeave() {
      if (!changedRows().length || state.saving) return true;
      return confirmDialog({
        title: '菜单还没有保存',
        message: '你改的菜单（位置或顺序）还没有发布，离开后这些修改会丢失。确定离开吗？',
        okText: '离开',
        cancelText: '留下',
        danger: true,
      });
    },
    unmount() {
      state.disposed = true;
      clearTimeout(changeTimer);
      unsubscribe();
    },
  };
}
