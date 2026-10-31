/**
 * views/pages.js — 「页面」与导航栏栏目（ADMIN_SPEC §6.3）。
 *
 * - 列出所有不是博客文章的页面：根目录页面（about 等）和每个栏目的 _index。
 *   每行显示各语言的菜单名称（linkTitle || title）、网址、语言情况、菜单顺序（menu.main.weight）。
 * - 导航栏里的页面可以直接改顺序（数字输入 + 上移/下移），「保存菜单顺序」= 一个提交，
 *   只修改顺序变了的那些文件的 menu（frontmatter.setFields，块状写法和注释原样保留）。
 * - 「新建栏目」：中文名称、英文名称（可选）、网址、菜单顺序 → content/<网址>/_index.md
 *   （有英文名称时再加 _index.en.md）→ 打开编辑器。
 *
 * @module views/pages
 */

import {
  h, svgIcon, render, clear, toast, modal, confirmDialog, withBusy, badge, emptyState,
  errorState, errorMessage,
} from '../ui.js';
import {
  groupPages, languageStatus, statusText, isPost, isDraftFm, isValidSlug, slugify, variantPath,
} from '../content.js';
import { splitDocument, parseFrontMatter, setFields, FrontMatterError } from '../frontmatter.js';
import { listDrafts } from '../drafts.js';
import { PATHS } from '../config.js';
import {
  readFrontMatters, pagePath, pageUrl, editHash, draftsCard, draftIsPost, skeletonRows,
} from './posts.js';

/** 不能用作栏目网址的名字（Hugo 自带的页面、语言代码、static/ 下已有的网址等）。 */
const RESERVED_SLUGS = new Set([
  'posts', 'tags', 'categories', 'series', 'search', 'archives', 'archive', 'page', 'admin', 'images',
  'documents', 'assets', 'css', 'js', 'fonts', 'static', 'index', 'sitemap', 'rss', 'feed', 'home',
]);

// ---------------------------------------------------------------------------
// 菜单 front matter 的小工具

/**
 * 解析 front matter 里的 main 菜单项。
 * Hugo 支持三种写法：`menu: main`、`menu: ["main"]`、`menu: { main: { weight: 10 } }`。
 * @returns {{ inMenu: boolean, weight: number|null }}
 */
export function mainMenuOf(fm) {
  const m = fm && fm.menu;
  if (typeof m === 'string') return { inMenu: m === 'main', weight: numOrNull(fm.weight) };
  if (Array.isArray(m)) return { inMenu: m.includes('main'), weight: numOrNull(fm.weight) };
  if (m && typeof m === 'object' && Object.prototype.hasOwnProperty.call(m, 'main')) {
    const main = m.main;
    const w = main && typeof main === 'object' ? numOrNull(main.weight) : null;
    return { inMenu: true, weight: w ?? numOrNull(fm.weight) };
  }
  return { inMenu: false, weight: null };
}

function numOrNull(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() && Number.isFinite(Number(v))) return Number(v);
  return null;
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

/** 新栏目的 front matter（块状写法，和现有文件风格一致），返回 fmText。 */
export function sectionFrontMatter(title, weight) {
  const fmText = `title: ${JSON.stringify(title)}\nmenu:\n  main:\n    weight: ${weight}`;
  const fm = parseFrontMatter(fmText);
  if (fm.title !== title || mainMenuOf(fm).weight !== weight) throw new Error('生成栏目设置时出错，请换一个名称再试');
  return fmText;
}

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
    edits: new Map(),    // group key → 新的菜单顺序（字符串，来自输入框）
    drafts: [],
    disposed: false,
    loadSeq: 0,
    saving: false,
  };

  ctx.setTitle('页面');

  const refreshBtn = h('button', {
    type: 'button', class: 'btn btn-ghost btn-icon', 'aria-label': '刷新（重新读取网站内容）', title: '刷新',
    dataset: { testid: 'pages-refresh' },
  }, svgIcon('refresh'));
  const newBtn = h('button', { type: 'button', class: 'btn btn-primary', dataset: { testid: 'pages-new-section' } }, svgIcon('plus'), '新建栏目');
  const header = h('div', { class: 'page-header' },
    h('div', {},
      h('h1', {}, '页面'),
      h('p', { class: 'page-desc' }, '设置了菜单顺序的页面会出现在网站顶部的导航栏里，数字越小越靠左。')),
    h('div', { class: 'actions' }, refreshBtn, newBtn));

  const draftsHost = h('div');
  const navPreview = h('div', { class: 'card lists-nav-preview', dataset: { testid: 'nav-preview' } });
  const menuList = h('ul', { class: 'list lists-list', dataset: { testid: 'pages-list' }, 'aria-busy': 'true' }, skeletonRows(4));
  const saveBtn = h('button', { type: 'button', class: 'btn btn-primary', dataset: { testid: 'pages-save-order' } }, svgIcon('check'), '保存菜单顺序');
  const resetBtn = h('button', { type: 'button', class: 'btn btn-ghost', dataset: { testid: 'pages-reset-order' } }, '撤销修改');
  const saveHint = h('span', { class: 'muted small lists-save-hint' });
  const saveBar = h('div', { class: 'lists-savebar', dataset: { testid: 'pages-savebar' } },
    saveHint, h('div', { class: 'row' }, resetBtn, saveBtn));
  const menuSection = h('section', { class: 'stack stack-sm' },
    h('div', { class: 'row row-between lists-section-head' },
      h('h2', { class: 'lists-section-title' }, '导航栏里的页面'),
      h('span', { class: 'muted small' }, '改好数字后点「保存菜单顺序」，一次发布')),
    menuList,
    saveBar);
  const otherList = h('ul', { class: 'list lists-list', dataset: { testid: 'pages-other-list' } });
  const otherSection = h('section', { class: 'stack stack-sm' },
    h('div', { class: 'row row-between lists-section-head' },
      h('h2', { class: 'lists-section-title' }, '其他页面'),
      h('span', { class: 'muted small' }, '不在导航栏里，可以通过链接访问')),
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
      title: '放弃没保存的菜单顺序？', message: '刷新会重新读取网站上的内容，你刚才改的菜单顺序还没有保存。', okText: '放弃并刷新', danger: true,
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
  saveBtn.addEventListener('click', () => withBusy(saveBtn, saveOrder));
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
    const groups = groupPages(repo.list(PATHS.content + '/'), langs).filter((g) => !isPost(g));
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
      if (!row || !row.inMenu) state.edits.delete(key);
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
      const menu = mainMenuOf(fm);
      const name = [fm.linkTitle, fm.title].find((t) => typeof t === 'string' && t.trim());
      return { lang, path: p, fm, name: name ? name.trim() : '', draft: isDraftFm(fm), ...menu };
    });
    const main = perLang.find((x) => x.lang === mainLang) || perLang[0] || { fm: {}, weight: null };
    const menuVariants = perLang.filter((x) => x.inMenu);
    const weight = (main.inMenu ? main.weight : null) ?? (menuVariants.find((x) => x.weight != null) || {}).weight ?? null;
    const errors = Object.values(group.variants).map((p) => ({ path: p, r: fms.get(p) })).filter((x) => x.r && x.r.error);
    return {
      group, status, perLang, mainLang, mainPath, errors,
      title: main.name || group.base,
      inMenu: menuVariants.length > 0,
      weight,
      // 各语言的顺序不一致时提示一下（保存时会统一成同一个数字）
      mixedWeights: new Set(menuVariants.map((x) => x.weight)).size > 1,
    };
  }

  /** 输入框里的值 → 数字（无效 → NaN）；没改过 → 原值。 */
  function effectiveWeight(row) {
    if (!state.edits.has(row.group.key)) return row.weight;
    const s = String(state.edits.get(row.group.key)).trim();
    return s === '' ? NaN : Number(s);
  }

  function changedRows() {
    return (state.rows || []).filter((r) => r.inMenu && state.edits.has(r.group.key) && effectiveWeight(r) !== r.weight);
  }

  function invalidRows() {
    return (state.rows || []).filter((r) => r.inMenu && state.edits.has(r.group.key) && !Number.isFinite(effectiveWeight(r)));
  }

  function sortedMenuRows() {
    const rows = (state.rows || []).filter((r) => r.inMenu);
    return rows.sort((a, b) => {
      const wa = effectiveWeight(a);
      const wb = effectiveWeight(b);
      const fa = Number.isFinite(wa);
      const fb = Number.isFinite(wb);
      if (fa !== fb) return fa ? -1 : 1;
      if (fa && wa !== wb) return wa - wb;
      return a.title.localeCompare(b.title, 'zh-CN');
    });
  }

  // ---- 渲染 ----
  function renderAll() {
    if (state.disposed) return;
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
    const menuRows = sortedMenuRows();
    const others = state.rows.filter((r) => !r.inMenu).sort((a, b) => a.group.key.localeCompare(b.group.key));
    if (!menuRows.length) {
      render(menuList, h('li', {}, emptyState('导航栏里还没有页面。新建一个栏目，它就会出现在网站顶部。', { text: '新建栏目', onClick: () => openNewSection(), icon: 'plus' }, { icon: 'page' })));
    } else {
      render(menuList, menuRows.map((r, i) => rowEl(r, { index: i, count: menuRows.length, menuRows })));
    }
    otherSection.hidden = !others.length;
    render(otherList, others.map((r) => rowEl(r, {})));
    renderNavPreview(menuRows);
    updateSaveBar();
  }

  function renderNavPreview(menuRows) {
    navPreview.hidden = !menuRows.length;
    render(navPreview,
      h('div', { class: 'lists-nav-head' }, svgIcon('eye'), h('span', {}, '导航栏预览'),
        state.edits.size ? h('span', { class: 'muted small' }, '（含未保存的修改）') : null),
      h('div', { class: 'lists-nav-rows' }, langs.map((lang) => {
        const items = menuRows
          .map((r) => r.perLang.find((x) => x.lang === lang))
          .filter((x) => x && x.inMenu && !x.draft);
        return h('div', { class: 'lists-nav-row', dataset: { testid: `nav-preview-${lang}` } },
          h('span', { class: 'lists-nav-label' }, ctx.siteLabel(lang)),
          h('div', { class: 'lists-nav-items' },
            items.length ? items.map((x) => h('span', { class: 'lists-nav-item' }, x.name || '（无名称）'))
              : h('span', { class: 'muted small' }, '（没有菜单项）')));
      })));
  }

  function updateSaveBar() {
    const changed = changedRows();
    const invalid = invalidRows();
    saveBar.hidden = !state.rows || !(state.rows || []).some((r) => r.inMenu);
    saveBtn.disabled = state.saving || !changed.length || invalid.length > 0;
    resetBtn.hidden = !state.edits.size;
    saveBar.classList.toggle('is-dirty', changed.length > 0);
    saveHint.textContent = invalid.length
      ? '菜单顺序必须是数字'
      : changed.length ? `已修改 ${changed.length} 个页面的顺序，还没有保存` : '菜单顺序没有修改';
    saveHint.classList.toggle('text-danger', invalid.length > 0);
  }

  function rowEl(r, { index, count, menuRows }) {
    const g = r.group;
    const names = h('div', { class: 'lists-names' }, langs.map((lang) => {
      const v = r.perLang.find((x) => x.lang === lang);
      return h('div', { class: 'lists-name', dataset: { testid: `page-name-${lang}` } },
        h('span', { class: 'lists-name-lang' }, ctx.langName(lang)),
        v ? h('span', { class: ['lists-name-text', !v.inMenu && r.inMenu && 'muted'] }, v.name || '（无标题）',
          !v.inMenu && r.inMenu ? h('span', { class: 'muted small' }, '（不在菜单）') : null)
          : h('span', { class: 'lists-name-text muted' }, '没有这一页'));
    }));

    const mainV = r.perLang.find((x) => x.lang === r.mainLang);
    const href = mainV && !mainV.draft ? pageUrl(g, r.mainLang, mainV.fm, ctx) : null;
    const urlText = pagePath(g, r.mainLang, mainV ? mainV.fm : {}, ctx);

    const langBadge = badge(statusText(r.status, ctx), r.status.kind === 'split' ? 'blue' : 'gray');
    langBadge.dataset.testid = 'page-lang';
    const meta = h('div', { class: 'list-item-meta' },
      href ? h('a', { class: 'lists-url mono', href, target: '_blank', rel: 'noopener noreferrer', title: '在网站上打开（新标签页）' }, urlText, svgIcon('external'))
        : h('span', { class: 'lists-url mono' }, urlText),
      langBadge,
      r.perLang.some((x) => x.draft) ? badge(r.perLang.every((x) => x.draft) ? '草稿' : `${r.perLang.filter((x) => x.draft).map((x) => ctx.langName(x.lang)).join('、')}草稿`, 'gray') : null,
      r.mixedWeights ? (() => { const b = badge('各语言顺序不同', 'orange'); b.title = r.perLang.filter((x) => x.inMenu).map((x) => `${ctx.siteLabel(x.lang)}：${x.weight ?? '未设置'}`).join('\n') + '\n保存菜单顺序时会统一成同一个数字。'; return b; })() : null,
      r.errors.length ? (() => { const b = badge('设置区有问题', 'red'); b.title = r.errors.map((e) => `${e.path}：${e.r.error}`).join('\n'); return b; })() : null);

    let orderEl = null;
    if (r.inMenu) {
      const cur = state.edits.has(g.key) ? state.edits.get(g.key) : (r.weight ?? '');
      const changed = state.edits.has(g.key) && effectiveWeight(r) !== r.weight;
      const input = h('input', {
        class: ['input', 'lists-weight', changed && 'is-changed'], type: 'number', step: 'any', inputmode: 'numeric',
        value: String(cur), 'aria-label': `「${r.title}」的菜单顺序`, dataset: { testid: 'page-weight' },
        'aria-invalid': state.edits.has(g.key) && !Number.isFinite(effectiveWeight(r)) ? 'true' : 'false',
      });
      input.addEventListener('input', () => {
        setEdit(r, input.value);
        input.classList.toggle('is-changed', state.edits.has(g.key) && effectiveWeight(r) !== r.weight);
        input.setAttribute('aria-invalid', state.edits.has(g.key) && !Number.isFinite(effectiveWeight(r)) ? 'true' : 'false');
        updateSaveBar();
      });
      // 输入完成（失焦 / 回车 / 方向键）后再重新排序，避免打字时行跳来跳去
      input.addEventListener('change', () => { renderAllKeepFocus(g.key, 'page-weight'); });
      const up = h('button', {
        type: 'button', class: 'btn btn-ghost btn-sm btn-icon', 'aria-label': `把「${r.title}」往前移`, title: '往前移（更靠左）',
        dataset: { testid: 'page-up' }, disabled: index === 0,
      }, svgIcon('up'));
      const down = h('button', {
        type: 'button', class: 'btn btn-ghost btn-sm btn-icon', 'aria-label': `把「${r.title}」往后移`, title: '往后移（更靠右）',
        dataset: { testid: 'page-down' }, disabled: index === count - 1,
      }, svgIcon('down'));
      up.addEventListener('click', () => move(menuRows, index, -1, 'page-up'));
      down.addEventListener('click', () => move(menuRows, index, +1, 'page-down'));
      orderEl = h('div', { class: 'lists-order' },
        h('span', { class: 'lists-order-label muted small' }, '顺序'), input, up, down);
    }

    return h('li', { class: ['list-item', 'lists-row', 'lists-page-row', r.inMenu && 'is-menu'], dataset: { testid: 'page-row', key: g.key } },
      h('div', { class: 'list-item-main' },
        h('a', { class: 'list-item-title', href: editHash(r.mainPath), dataset: { testid: 'page-title' } }, r.title),
        names,
        meta),
      h('div', { class: 'list-item-actions lists-page-actions' },
        orderEl,
        h('a', { class: 'btn btn-sm', href: editHash(r.mainPath), dataset: { testid: 'page-edit' } }, svgIcon('edit'), '编辑')));
  }

  function setEdit(r, value) {
    const s = String(value).trim();
    if (s !== '' && Number(s) === r.weight) state.edits.delete(r.group.key);
    else state.edits.set(r.group.key, s);
  }

  /** 和相邻的页面交换位置（交换两者的顺序数字；数字相同时让移动的那个多/少 1）。 */
  function move(menuRows, index, dir, focusId) {
    const a = menuRows[index];
    const b = menuRows[index + dir];
    if (!a || !b) return;
    let wa = effectiveWeight(a);
    let wb = effectiveWeight(b);
    if (!Number.isFinite(wa) || !Number.isFinite(wb)) {
      toast('请先把菜单顺序填成数字', { type: 'warning' });
      return;
    }
    if (wa === wb) wa = wb + dir;
    else [wa, wb] = [wb, wa];
    setEdit(a, String(wa));
    setEdit(b, String(wb));
    renderAllKeepFocus(a.group.key, focusId);
  }

  function renderAllKeepFocus(key, testid) {
    renderAll();
    const row = [...menuList.querySelectorAll('[data-testid="page-row"]')].find((el) => el.dataset.key === key);
    let target = row && row.querySelector(`[data-testid="${testid}"]`);
    if (target && target.disabled) target = row.querySelector('[data-testid="page-weight"]');
    if (target) try { target.focus({ preventScroll: true }); } catch { /* ignore */ }
  }

  // ---- 保存菜单顺序 ----
  async function saveOrder() {
    const changed = changedRows();
    if (!changed.length || invalidRows().length) return;
    state.saving = true;
    updateSaveBar();
    try {
      const changes = [];
      const summary = [];
      const skipped = []; // TOML front matter：只能在 GitHub 上手动改
      for (const r of changed) {
        const w = effectiveWeight(r);
        for (const path of Object.values(r.group.variants)) {
          const entry = repo.entry(path);
          if (!entry) continue;
          const text = await repo.readText(path);
          const doc = splitDocument(text);
          if (doc.kind !== 'yaml') { skipped.push(path); continue; }
          const menu = mainMenuOf(parseFrontMatter(doc.fmText));
          if (!menu.inMenu || menu.weight === w) continue; // 不在菜单里的版本不擅自加菜单
          changes.push({ path, content: patchMenuWeight(text, w, path), baseSha: entry.sha });
        }
        summary.push(`${r.title}：${r.weight ?? '未设置'} → ${w}`);
      }
      if (!changes.length) {
        state.edits.clear();
        renderAll();
        toast('菜单顺序和网站上的一样，不需要发布', { type: 'info' });
        return;
      }
      let res;
      try {
        res = await ctx.publish({ message: 'admin: 调整菜单顺序', changes, summary });
      } catch {
        return; // 外壳已提示；修改保留在输入框里，可以再点一次
      }
      if (res && res.conflict) {
        // 重新加载后 onChange 会重新读取；用户的修改（state.edits）保留，可以再保存一次
        if (res.reloaded) toast('已读取最新内容，你改的顺序还在，确认后再点一次「保存菜单顺序」', { type: 'info', timeout: 6000 });
        return;
      }
      // 先用新数字更新界面（随后 repo.onChange 会重新读取文件，结果相同），避免旧顺序闪一下
      for (const r of changed) {
        const w = effectiveWeight(r);
        r.weight = w;
        r.mixedWeights = false;
        for (const v of r.perLang) if (v.inMenu) v.weight = w;
      }
      state.edits.clear();
      if (skipped.length) {
        toast(`这些文件的设置区不是 YAML 格式，没有自动修改，请在 GitHub 上手动改：${skipped.join('、')}`, { type: 'warning', timeout: 10000 });
      }
      // 提交成功后 repo.onChange 会重新读取；先用新数字立即刷新界面
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
    const maxW = Math.max(0, ...(state.rows || []).filter((r) => r.inMenu).map((r) => r.weight).filter((w) => Number.isFinite(w)));
    const defaultWeight = Math.floor(maxW / 10) * 10 + 10;
    let slugTouched = false;

    const mkField = (id, labelText, input, hint, optional) => {
      const err = h('div', { class: 'error', role: 'alert' });
      err.hidden = true;
      input.id = id;
      return {
        el: h('div', { class: 'field' },
          h('label', { htmlFor: id }, labelText, optional ? h('span', { class: 'optional' }, '（可选）') : null),
          input, hint ? h('div', { class: 'hint' }, hint) : null, err),
        setError(msg) { err.textContent = msg || ''; err.hidden = !msg; input.setAttribute('aria-invalid', msg ? 'true' : 'false'); },
      };
    };

    const nameInputs = {};
    const nameFields = [ctx.defaultLang, ...others].map((lang) => {
      const input = h('input', {
        class: 'input', type: 'text', autocomplete: 'off', maxlength: 60,
        placeholder: lang === ctx.defaultLang ? '例如：项目' : lang === 'en' ? 'e.g. Projects' : '',
        dataset: { testid: `new-section-name-${lang}` }, 'data-autofocus': lang === ctx.defaultLang ? true : undefined,
      });
      nameInputs[lang] = input;
      const hint = lang === ctx.defaultLang
        ? `显示在导航栏里的名字。${others.length ? `不填${others.map((l) => ctx.langName(l)).join('、')}名称时，所有语言都显示这个名字。` : ''}`
        : `填了就单独生成${ctx.langName(lang)}版本，${ctx.siteLabel(lang)}导航栏显示这个名字`;
      return { lang, ...mkField(`ns-name-${lang}`, `${ctx.langName(lang)}名称`, input, hint, lang !== ctx.defaultLang) };
    });

    const slugInput = h('input', {
      class: 'input mono', type: 'text', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', maxlength: 81,
      placeholder: '例如：projects', dataset: { testid: 'new-section-slug' },
    });
    const urlPreview = h('div', { class: 'hint lists-url-preview', dataset: { testid: 'new-section-url' } });
    const slugField = mkField('ns-slug', '网址', slugInput, '只能用小写英文字母、数字和 -，例如 projects、teaching', false);
    slugField.el.appendChild(urlPreview);

    const weightInput = h('input', {
      class: 'input lists-weight-lg', type: 'number', step: 'any', inputmode: 'numeric', value: String(defaultWeight),
      dataset: { testid: 'new-section-weight' },
    });
    const weightField = mkField('ns-weight', '菜单顺序', weightInput, `数字越小越靠左。现在最靠右的是 ${maxW || '—'}，填 ${defaultWeight} 就排在最后。`, false);

    const updatePreview = () => {
      const s = slugInput.value.trim();
      if (!s) { urlPreview.textContent = ''; return; }
      urlPreview.textContent = '网站上的地址：' + langs.map((l) => `/${l === ctx.defaultLang ? '' : l + '/'}${s}/`).join('  ·  ');
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
    weightInput.addEventListener('input', () => weightField.setError(null));

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
      const ws = weightInput.value.trim();
      const w = Number(ws);
      const wErr = ws === '' || !Number.isFinite(w) ? '菜单顺序请填一个数字' : null;
      weightField.setError(wErr);
      if (wErr) ok = false;
      return ok ? { names: Object.fromEntries(langs.map((l) => [l, nameInputs[l].value.trim()])), slug, weight: w } : null;
    };

    const form = h('form', { class: 'stack lists-new-form', novalidate: true },
      nameFields.map((f) => f.el), slugField.el, weightField.el,
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

  async function createSection({ names, slug, weight }) {
    const dir = `${PATHS.content}/${slug}`;
    const changes = [];
    const mainPath = variantPath(dir, '_index', null);
    changes.push({ path: mainPath, content: joinDocument(sectionFrontMatter(names[ctx.defaultLang], weight), '\n这里写栏目介绍…\n'), baseSha: null });
    for (const lang of langs) {
      if (lang === ctx.defaultLang || !names[lang]) continue;
      const placeholder = lang === 'en' ? 'Write the section introduction here…' : '这里写栏目介绍…';
      changes.push({ path: variantPath(dir, '_index', lang), content: joinDocument(sectionFrontMatter(names[lang], weight), `\n${placeholder}\n`), baseSha: null });
    }
    let res;
    try {
      res = await ctx.publish({
        message: `admin: 新建栏目《${names[ctx.defaultLang]}》`,
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
        title: '菜单顺序还没有保存',
        message: '你改的菜单顺序还没有发布，离开后这些修改会丢失。确定离开吗？',
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
