/**
 * views/posts.js — 「文章」列表（ADMIN_SPEC §6.3）。
 *
 * - 顶部：标题 + 「写新文章」+ 刷新；本机未发布的草稿（drafts.listDrafts）。
 * - 筛选 全部 / 已发表 / 草稿 + 标题搜索；文章按日期倒序（没有日期的排最后）。
 * - 每行：标题（默认语言站点显示的那个文件）、日期、发表状态（各语言不同时分别显示）、
 *   语言情况（中英共用 / 中英分开 / 仅中文 …）、草稿遮挡警告（专属版本是草稿 → 该语言站点上文章消失）、
 *   操作 编辑 / 查看 / 删除（删除全部版本，可选同时删除图片文件夹）。
 *
 * 这里也导出几个列表页共用的小工具（pages.js 会用）：readFrontMatters、pageUrl、safeHref。
 *
 * 安全：所有界面都用 h() / textContent 生成（§2 规则 3）；仓库里来的链接只允许 http(s)。
 *
 * @module views/posts
 */

import {
  h, svgIcon, render, clear, toast, modal, confirmDialog, withBusy, badge, emptyState,
  errorState, errorMessage, formatDate, timeAgo, debounce,
} from '../ui.js';
import {
  groupPages, languageStatus, statusText, isPost, isDraftFm, shadowWarnings,
  imageDirFor, parseContentPath,
} from '../content.js';
import { splitDocument, parseFrontMatter } from '../frontmatter.js';
import { listDrafts, deleteDraft, draftKeyForPath } from '../drafts.js';
import { PATHS } from '../config.js';

// ---------------------------------------------------------------------------
// 共用工具（pages.js 也会用）

/** 按 blob sha 缓存解析结果：sha 由内容决定，所以永远不会过期。 */
const fmCache = new Map(); // sha → { fm, kind, error }
const FM_CACHE_MAX = 2000;

/**
 * 读取并解析一组文件的 front matter（最多 concurrency 个并发，按 sha 缓存）。
 * 单个文件失败不会让整体失败：该文件的结果带 error（中文说明）。
 *
 * @param {object} repo ctx.repo
 * @param {string[]} paths
 * @param {{ concurrency?: number }} [opts]
 * @returns {Promise<Map<string, { fm: object, kind: string, error?: string, sha?: string, status?: number }>>}
 */
export async function readFrontMatters(repo, paths, { concurrency = 6 } = {}) {
  const out = new Map();
  const queue = [...new Set(paths)];
  const worker = async () => {
    while (queue.length) {
      const path = queue.shift();
      const entry = repo.entry(path);
      if (!entry) { out.set(path, { fm: {}, kind: 'none', error: '文件不存在' }); continue; }
      const cached = fmCache.get(entry.sha);
      if (cached) { out.set(path, { ...cached, sha: entry.sha }); continue; }
      let result;
      try {
        const text = await repo.readText(path);
        try {
          const doc = splitDocument(text);
          result = { fm: doc.kind === 'yaml' ? parseFrontMatter(doc.fmText) : {}, kind: doc.kind };
          if (doc.kind === 'toml') result.error = '这个文件的设置区是 TOML 格式（+++），后台只能读写 YAML 格式（---）';
        } catch (err) {
          result = { fm: {}, kind: 'yaml', error: errorMessage(err), parseError: true };
        }
        if (fmCache.size > FM_CACHE_MAX) fmCache.clear();
        fmCache.set(entry.sha, result);
      } catch (err) {
        // 读取失败（网络等）不缓存，下次刷新再试
        out.set(path, { fm: {}, kind: 'none', error: errorMessage(err), readError: true, status: err && err.status, sha: entry.sha });
        continue;
      }
      out.set(path, { ...result, sha: entry.sha });
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, queue.length)) }, worker));
  return out;
}

/**
 * 只允许 http(s) 链接（以及相对链接），其余（javascript: 等）返回 null。
 * @param {string} url
 * @param {string} [base]
 */
export function safeHref(url, base) {
  try {
    const u = new URL(String(url), base || location.href);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
  } catch {
    return null;
  }
}

/** 某语言的网址前缀：默认语言在根目录 ''，其他语言 'en/'。 */
export function langPrefix(lang, ctx) {
  return !lang || lang === ctx.defaultLang ? '' : `${lang}/`;
}

/**
 * 一个页面在某语言站点上的网址（按 Hugo 的默认规则推算）。
 *   content/posts/a.md            → /posts/a/      （英文站 /en/posts/a/）
 *   content/about.md              → /about/
 *   content/research/_index.md    → /research/
 *   content/_index.md             → /
 * front matter 里有 url 时用它；有 slug 时替换最后一段。
 *
 * @param {object} group PageGroup
 * @param {string} lang
 * @param {object} fm 该语言实际使用的文件的 front matter
 * @param {object} ctx
 * @returns {string} 相对网站根的路径，如 '/en/posts/a/'
 */
export function pagePath(group, lang, fm, ctx) {
  const prefix = '/' + langPrefix(lang, ctx);
  const f = fm || {};
  if (typeof f.url === 'string' && f.url.trim()) {
    const u = f.url.trim();
    if (/^[a-z][a-z0-9+.-]*:/i.test(u) || u.startsWith('//')) return prefix; // 不理会奇怪的绝对网址
    return prefix + u.replace(/^\/+/, '');
  }
  const rel = group.dir === 'content' ? '' : group.dir.startsWith('content/') ? group.dir.slice('content/'.length) : group.dir;
  const parts = rel ? rel.split('/') : [];
  if (!group.isIndex && group.base !== 'index') {
    const slug = typeof f.slug === 'string' && f.slug.trim() ? f.slug.trim() : group.base;
    parts.push(slug);
  }
  const path = parts.map((p) => encodeURIComponent(p)).join('/');
  return prefix + (path ? path + '/' : '');
}

/** pagePath 的完整网址版本（基于 ctx.siteUrl）。 */
export function pageUrl(group, lang, fm, ctx) {
  return safeHref(pagePath(group, lang, fm, ctx).replace(/^\//, ''), ctx.siteUrl) || ctx.siteUrl;
}

/** front matter 里的日期 → 毫秒时间戳（无法解析 → NaN）。'YYYY-MM-DD' 按本地日期理解。 */
export function dateValue(v) {
  if (v instanceof Date) return v.getTime();
  if (typeof v !== 'string') return NaN;
  const s = v.trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
  return s ? Date.parse(s) : NaN;
}

/** 草稿记录属于文章（而不是普通页面）吗？新文章草稿（没有路径）也算文章。 */
export function draftIsPost(d, langs) {
  const p = d.path || d.groupKey;
  if (!p) return true;
  const path = d.path || `${d.groupKey}.md`;
  const info = parseContentPath(path, langs);
  if (!info) return String(p).startsWith(PATHS.posts + '/');
  return info.dir === PATHS.posts && !info.isIndex;
}

/** 「编辑」的地址。 */
export function editHash(path) {
  return '#/edit?path=' + encodeURIComponent(path);
}

/**
 * 本机草稿卡片（文章页和页面页共用）。
 * @param {object} ctx
 * @param {Array} drafts listDrafts() 的结果（已按归属过滤）
 * @param {{ onChanged: Function, describe?: (d) => string|null }} opts
 */
export function draftsCard(ctx, drafts, { onChanged, describe } = {}) {
  if (!drafts.length) return null;
  const rows = drafts.map((d) => {
    const title = (d.title || '').trim() || '（无标题）';
    const fileGone = d.key && d.key.startsWith('file:') && d.path && !ctx.repo.has(d.path);
    const what = describe ? describe(d) : null;
    const discardBtn = h('button', {
      type: 'button', class: 'btn btn-ghost btn-sm btn-danger', dataset: { testid: 'draft-discard' },
    }, '丢弃');
    discardBtn.addEventListener('click', async () => {
      const ok = await confirmDialog({
        title: '丢弃这份本机草稿？',
        message: `《${title}》在这台设备上未发布的修改会被删除，无法恢复。网站上已发布的内容不受影响。`,
        okText: '丢弃',
        danger: true,
      });
      if (!ok) return;
      await withBusy(discardBtn, () => deleteDraft(d.key));
      toast('已丢弃本机草稿', { type: 'success' });
      onChanged && onChanged();
    });
    return h('li', { class: 'list-item draft-row', dataset: { testid: 'draft-row', key: d.key } },
      h('div', { class: 'list-item-main' },
        h('a', { class: 'list-item-title', href: '#/edit?draft=' + encodeURIComponent(d.key), dataset: { testid: 'draft-title' } }, title),
        h('div', { class: 'list-item-meta' },
          h('span', { class: 'lists-meta-item' }, svgIcon('clock'), d.updatedAt ? `保存于 ${timeAgo(d.updatedAt)}` : '保存时间未知'),
          what ? h('span', { class: 'lists-meta-item' }, what) : null,
          fileGone ? badge('网站上的原文件已不存在', 'orange') : null)),
      h('div', { class: 'list-item-actions' },
        h('a', {
          class: 'btn btn-sm', href: '#/edit?draft=' + encodeURIComponent(d.key), dataset: { testid: 'draft-continue' },
        }, svgIcon('edit'), '继续编辑'),
        discardBtn));
  });
  return h('section', { class: 'card lists-drafts', dataset: { testid: 'drafts-section' } },
    h('div', { class: 'card-header' },
      h('h2', { class: 'card-title' }, svgIcon('save'), `本机未发布的草稿 (${drafts.length})`),
      h('span', { class: 'muted small' }, '只保存在这台设备的浏览器里，发表后才会出现在网站上')),
    h('ul', { class: 'list' }, rows));
}

/** 骨架行（加载中）。 */
export function skeletonRows(n = 3) {
  return Array.from({ length: n }, (_, i) => h('li', { class: 'list-item lists-skeleton-row', 'aria-hidden': 'true' },
    h('div', { class: 'list-item-main' },
      h('span', { class: 'skeleton skeleton-title', style: { width: `${[46, 34, 52, 40][i % 4]}%` } }),
      h('span', { class: 'skeleton skeleton-text', style: { width: `${[28, 36, 24, 32][i % 4]}%` } })),
    h('div', { class: 'list-item-actions' }, h('span', { class: 'skeleton lists-skeleton-btn' }))));
}

// ---------------------------------------------------------------------------
// 文章列表

const FILTERS = [
  { id: 'all', label: '全部' },
  { id: 'published', label: '已发表' },
  { id: 'draft', label: '草稿' },
];

/**
 * @param {HTMLElement} container
 * @param {Record<string,string>} params  filter = all | published | draft
 * @param {object} ctx
 */
export default async function mount(container, params, ctx) {
  const repo = ctx.repo;
  const langs = ctx.langs && ctx.langs.length ? ctx.langs : ['zh', 'en'];
  const state = {
    filter: FILTERS.some((f) => f.id === params.filter) ? params.filter : 'all',
    query: '',
    rows: null,        // 计算好的行数据；null = 还在加载
    loadError: null,
    readErrors: 0,
    drafts: [],
    disposed: false,
    loadSeq: 0,
  };

  ctx.setTitle('文章');

  // ---- 骨架 ----
  const refreshBtn = h('button', {
    type: 'button', class: 'btn btn-ghost btn-icon', 'aria-label': '刷新（重新读取网站内容）', title: '刷新',
    dataset: { testid: 'posts-refresh' },
  }, svgIcon('refresh'));
  const header = h('div', { class: 'page-header' },
    h('div', {},
      h('h1', {}, '文章'),
      h('p', { class: 'page-desc' }, '博客文章都在这里。点标题就能编辑，发表后约 1–2 分钟在网站上生效。')),
    h('div', { class: 'actions' },
      refreshBtn,
      h('a', { class: 'btn btn-primary', href: '#/edit?new=post', dataset: { testid: 'posts-new' } }, svgIcon('plus'), '写新文章')));

  const draftsHost = h('div', { class: 'lists-drafts-host' });
  const tabs = h('div', { class: 'tabs tabs-pill', role: 'tablist', 'aria-label': '按状态筛选' });
  const search = h('input', {
    class: 'input', type: 'search', placeholder: '搜索标题', 'aria-label': '搜索文章标题', autocomplete: 'off',
    enterkeyhint: 'search', dataset: { testid: 'posts-search' },
  });
  const toolbar = h('div', { class: 'lists-toolbar' },
    tabs,
    h('label', { class: 'lists-search' }, svgIcon('search'), search));
  const noticeHost = h('div', { class: 'lists-notice' });
  const list = h('ul', { class: 'list lists-list', dataset: { testid: 'posts-list' }, 'aria-busy': 'true' }, skeletonRows(3));
  const listHost = h('div', { class: 'lists-list-host' }, list);
  const countLine = h('div', { class: 'lists-count muted small', 'aria-live': 'polite' });

  render(container,
    h('div', { class: 'lists-view posts-view stack' },
      header,
      draftsHost,
      h('section', { class: 'stack stack-sm' }, toolbar, noticeHost, listHost, countLine)));

  // ---- 事件 ----
  const doSearch = debounce(() => { state.query = search.value.trim(); renderList(); }, 150);
  search.addEventListener('input', doSearch);
  search.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && search.value) { search.value = ''; doSearch.cancel(); state.query = ''; renderList(); }
  });
  refreshBtn.addEventListener('click', () => withBusy(refreshBtn, async () => {
    try {
      await repo.load(); // onChange 会触发重新计算
      await refreshDrafts();
      toast('已是最新内容', { type: 'success' });
    } catch (err) {
      toast(`刷新失败：${errorMessage(err)}`, { type: 'error' });
    }
  }));

  // 仓库内容变化（发布成功、冲突后重新加载、刷新）→ 重新计算列表
  let changeTimer = null;
  const unsubscribe = repo.onChange(() => {
    clearTimeout(changeTimer);
    changeTimer = setTimeout(() => { if (!state.disposed) loadRows(); }, 0);
  });

  // ---- 数据 ----
  async function refreshDrafts() {
    const all = await listDrafts();
    if (state.disposed) return;
    state.drafts = all.filter((d) => draftIsPost(d, langs));
    renderDrafts();
    if (state.rows) renderList();
  }

  function renderDrafts() {
    render(draftsHost, draftsCard(ctx, state.drafts, {
      onChanged: refreshDrafts,
      describe: (d) => {
        if (!d.path) return '新文章，还没有发表过';
        const info = parseContentPath(d.path, langs);
        const which = info && info.lang ? `${ctx.langName(info.lang)}专属版本` : '共用版本';
        return `${which} · ${d.path.replace(/^content\/posts\//, '')}`;
      },
    }));
  }

  async function loadRows() {
    const seq = ++state.loadSeq;
    const groups = groupPages(repo.list(PATHS.posts + '/'), langs).filter(isPost);
    const paths = groups.flatMap((g) => Object.values(g.variants));
    if (!state.rows) list.setAttribute('aria-busy', 'true');
    let fms;
    try {
      fms = await readFrontMatters(repo, paths);
    } catch (err) {
      if (state.disposed || seq !== state.loadSeq) return;
      state.loadError = err;
      renderList();
      return;
    }
    if (state.disposed || seq !== state.loadSeq) return;
    state.loadError = null;
    state.readErrors = [...fms.values()].filter((r) => r.readError).length;
    state.rows = groups.map((g) => buildRow(g, fms));
    state.rows.sort(compareRows);
    renderList();
  }

  function buildRow(group, fms) {
    const fmOf = (p) => (p && fms.get(p) ? fms.get(p).fm : {});
    const status = languageStatus(group, langs);
    const present = langs.filter((l) => status.perLang[l]);
    const mainLang = status.perLang[ctx.defaultLang] ? ctx.defaultLang : present[0] || ctx.defaultLang;
    const mainPath = status.perLang[mainLang] || Object.values(group.variants)[0];
    const fm = fmOf(mainPath);
    const perLang = present.map((lang) => {
      const p = status.perLang[lang];
      return { lang, path: p, draft: isDraftFm(fmOf(p)), fm: fmOf(p) };
    });
    const fmByPath = {};
    for (const p of Object.values(group.variants)) fmByPath[p] = fmOf(p);
    const titles = [...new Set(Object.values(group.variants).map((p) => fmOf(p).title).filter((t) => typeof t === 'string' && t.trim()))];
    const title = (typeof fm.title === 'string' && fm.title.trim()) || titles[0] || group.base;
    const errors = Object.values(group.variants)
      .map((p) => ({ path: p, r: fms.get(p) }))
      .filter((x) => x.r && x.r.error);
    return {
      group,
      title,
      searchText: [title, ...titles, group.base].join('\n').toLowerCase(),
      date: fm.date,
      dateMs: dateValue(fm.date),
      mainLang,
      mainPath,
      perLang,
      status,
      warnings: shadowWarnings(group, fmByPath, langs),
      published: perLang.some((x) => !x.draft),
      drafted: perLang.some((x) => x.draft),
      errors,
    };
  }

  function compareRows(a, b) {
    const ha = Number.isFinite(a.dateMs);
    const hb = Number.isFinite(b.dateMs);
    if (ha !== hb) return ha ? -1 : 1;
    if (ha && a.dateMs !== b.dateMs) return b.dateMs - a.dateMs;
    return a.title.localeCompare(b.title, 'zh-CN');
  }

  // ---- 渲染 ----
  function renderTabs() {
    const rows = state.rows || [];
    const counts = {
      all: rows.length,
      published: rows.filter((r) => r.published).length,
      draft: rows.filter((r) => r.drafted).length,
    };
    render(tabs, FILTERS.map((f) => {
      const on = state.filter === f.id;
      const b = h('button', {
        type: 'button', role: 'tab', class: ['tab', on && 'active'], 'aria-selected': on ? 'true' : 'false',
        dataset: { testid: `posts-filter-${f.id}` },
      }, f.label, state.rows ? h('span', { class: 'lists-tab-count' }, String(counts[f.id])) : null);
      b.addEventListener('click', () => {
        if (state.filter === f.id) return;
        state.filter = f.id;
        renderList();
      });
      return b;
    }));
  }

  function renderList() {
    if (state.disposed) return;
    renderTabs();
    clear(noticeHost);
    if (state.loadError) {
      list.removeAttribute('aria-busy');
      render(listHost, h('div', { class: 'card' }, errorState('文章列表读取失败', {
        detail: errorMessage(state.loadError),
        retry: () => { render(listHost, list); render(list, skeletonRows(3)); loadRows(); },
      })));
      countLine.textContent = '';
      return;
    }
    if (!state.rows) return; // 仍在加载：保留骨架
    if (listHost.firstChild !== list) render(listHost, list);
    list.removeAttribute('aria-busy');
    if (state.readErrors) {
      const retry = h('button', { type: 'button', class: 'btn btn-sm' }, svgIcon('refresh'), '重试');
      retry.addEventListener('click', () => withBusy(retry, loadRows));
      noticeHost.appendChild(h('div', { class: 'banner banner-error', role: 'alert' },
        svgIcon('warning'),
        h('span', {}, `有 ${state.readErrors} 个文件暂时读取失败，它们的标题和状态可能不准确。`),
        h('div', { class: 'banner-actions' }, retry)));
    }

    if (!state.rows.length) {
      render(listHost, h('div', { class: 'card', dataset: { testid: 'posts-empty' } },
        emptyState('还没有文章，写第一篇吧', { text: '写新文章', href: '#/edit?new=post', icon: 'plus' }, { icon: 'post' })));
      countLine.textContent = '';
      return;
    }

    const q = state.query.toLowerCase();
    const visible = state.rows.filter((r) => {
      if (state.filter === 'published' && !r.published) return false;
      if (state.filter === 'draft' && !r.drafted) return false;
      if (q && !r.searchText.includes(q)) return false;
      return true;
    });
    if (!visible.length) {
      render(list, h('li', { class: 'lists-no-match', dataset: { testid: 'posts-no-match' } },
        emptyState(q ? `没有标题包含「${state.query}」的文章` : state.filter === 'draft' ? '没有草稿' : '还没有已发表的文章', null, { icon: 'search' })));
    } else {
      render(list, visible.map(rowEl));
    }
    countLine.textContent = visible.length === state.rows.length
      ? `共 ${state.rows.length} 篇`
      : `显示 ${visible.length} 篇 / 共 ${state.rows.length} 篇`;
  }

  function rowEl(r) {
    const g = r.group;
    const draftPaths = new Set(state.drafts.map((d) => d.path).filter(Boolean));
    const hasLocalDraft = Object.values(g.variants).some((p) => draftPaths.has(p));

    // 发表状态：各语言一致时一个徽标，不一致时分别显示
    const uniform = r.perLang.every((x) => x.draft === r.perLang[0].draft);
    const statusBadges = !r.perLang.length ? [] : uniform
      ? [r.perLang[0].draft ? badge('草稿', 'gray') : badge('已发表', 'green')]
      : r.perLang.map((x) => badge(`${ctx.langName(x.lang)}${x.draft ? '草稿' : '已发表'}`, x.draft ? 'gray' : 'green'));

    const langText = statusText(r.status, ctx);
    const langBadge = badge(langText, r.status.kind === 'split' ? 'blue' : 'gray');
    langBadge.dataset.testid = 'post-lang';
    langBadge.title = langTitle(r);

    const warnBadges = r.warnings.map((w) => {
      const b = badge('', 'orange');
      b.append(svgIcon('warning'), `${ctx.siteLabel(w.lang)}看不到这篇`);
      b.dataset.testid = 'post-warning';
      b.title = `${ctx.langName(w.lang)}专属版本是草稿，而共用版本已发表：${ctx.siteLabel(w.lang)}上这篇文章会消失（不会改为显示共用版本）。发表${ctx.langName(w.lang)}版本，或删除它改回共用版本。`;
      return b;
    });
    const errBadges = r.errors.length ? [(() => {
      const b = badge('', 'red');
      b.append(svgIcon('warning'), r.errors.some((e) => e.r.readError) ? '读取失败'
        : r.errors.some((e) => e.r.kind === 'toml') ? 'TOML 格式，只能在 GitHub 上改' : '设置区格式有误');
      b.title = r.errors.map((e) => `${e.path}：${e.r.error}`).join('\n');
      b.dataset.testid = 'post-error';
      return b;
    })()] : [];

    const statusWrap = h('span', { class: 'lists-badges', dataset: { testid: 'post-status' } }, statusBadges);

    // 查看：默认语言已发表就看默认语言，否则看第一个已发表的语言
    const pub = r.perLang.find((x) => x.lang === ctx.defaultLang && !x.draft) || r.perLang.find((x) => !x.draft);
    const viewHref = pub ? pageUrl(g, pub.lang, pub.fm, ctx) : null;

    const delBtn = h('button', {
      type: 'button', class: 'btn btn-ghost btn-sm btn-danger', dataset: { testid: 'post-delete' }, 'aria-label': `删除《${r.title}》`,
    }, svgIcon('trash'), h('span', { class: 'lists-btn-text' }, '删除'));
    delBtn.addEventListener('click', () => deletePost(r, delBtn));

    return h('li', { class: 'list-item lists-row', dataset: { testid: 'post-row', key: g.key } },
      h('div', { class: 'list-item-main' },
        h('a', { class: 'list-item-title', href: editHash(r.mainPath), dataset: { testid: 'post-title' }, title: r.title }, r.title),
        h('div', { class: 'list-item-meta' },
          h('span', { class: 'lists-meta-item', dataset: { testid: 'post-date' } },
            r.date ? formatDate(r.date) : h('span', { class: 'muted' }, '没有日期')),
          statusWrap,
          langBadge,
          warnBadges,
          errBadges,
          hasLocalDraft ? (() => { const b = badge('本机有未发布的修改', 'blue'); b.dataset.testid = 'post-local-draft'; return b; })() : null)),
      h('div', { class: 'list-item-actions' },
        h('a', { class: 'btn btn-sm', href: editHash(r.mainPath), dataset: { testid: 'post-edit' } }, svgIcon('edit'), '编辑'),
        viewHref ? h('a', {
          class: 'btn btn-ghost btn-sm', href: viewHref, target: '_blank', rel: 'noopener noreferrer',
          dataset: { testid: 'post-view' }, title: `在${ctx.siteLabel(pub.lang)}查看（新标签页）`,
        }, svgIcon('external'), h('span', { class: 'lists-btn-text' }, '查看')) : null,
        delBtn));
  }

  function langTitle(r) {
    const parts = langs.map((l) => {
      const p = r.status.perLang[l];
      if (!p) return `${ctx.siteLabel(l)}：没有这篇`;
      const info = parseContentPath(p, langs);
      return `${ctx.siteLabel(l)}：${info && info.lang ? `${ctx.langName(info.lang)}专属版本` : '共用版本'}`;
    });
    if (r.status.sharedUnused) parts.push('（共用版本目前没有被任何站点使用）');
    return parts.join('\n');
  }

  // ---- 删除 ----
  async function deletePost(r, btn) {
    const g = r.group;
    const paths = Object.values(g.variants).filter((p) => repo.has(p)).sort();
    const imgDir = imageDirFor(g);
    const images = repo.list(imgDir + '/');
    const imgBox = h('input', { type: 'checkbox', dataset: { testid: 'delete-images' } });

    const confirmed = await new Promise((resolve) => {
      let ok = false;
      modal({
        title: '删除这篇文章？',
        content: h('div', { class: 'stack stack-sm lists-delete' },
          h('p', { class: 'modal-message' },
            `《${r.title}》会从${langs.map((l) => ctx.siteLabel(l)).join('和')}上删除（所有语言版本）。`),
          h('div', { class: 'muted small' }, '将删除这些文件：'),
          h('ul', { class: 'lists-file-list' }, paths.map((p) => h('li', {}, h('code', {}, p)))),
          images.length ? h('label', { class: 'checkbox' }, imgBox,
            h('span', {}, `同时删除这篇文章的图片文件夹（${imgDir}/，共 ${images.length} 个文件）`)) : null,
          h('p', { class: 'muted small' }, '误删了也不用慌：GitHub 的提交历史里可以找回。')),
        actions: [
          { text: '取消', kind: 'ghost', testid: 'confirm-cancel' },
          { text: '删除', kind: 'danger', testid: 'delete-ok', onClick: (close) => { ok = true; close(); } },
        ],
        onClose: () => resolve(ok),
      });
    });
    if (!confirmed) return;

    const withImages = images.length > 0 && imgBox.checked;
    const changes = paths.map((p) => ({ path: p, delete: true, baseSha: repo.entry(p).sha }));
    if (withImages) for (const e of images) changes.push({ path: e.path, delete: true, baseSha: e.sha });
    const summary = [...paths, withImages ? `${imgDir}/（${images.length} 个图片）` : null].filter(Boolean);

    await withBusy(btn, async () => {
      let res;
      try {
        res = await ctx.publish({ message: `admin: 删除《${r.title}》`, changes, summary });
      } catch {
        return; // 外壳已经提示了错误
      }
      if (res && res.conflict) return; // 外壳已经说明；重新加载后 onChange 会刷新列表
      // 这篇文章已经没了：对应的本机草稿也一起清掉
      await Promise.all(paths.map((p) => deleteDraft(draftKeyForPath(p))));
      await refreshDrafts();
      // 成功提示（已发布，正在部署…）由外壳统一显示
    });
  }

  // ---- 首次加载 ----
  renderTabs();
  await Promise.all([refreshDrafts(), loadRows()]);

  return {
    unmount() {
      state.disposed = true;
      clearTimeout(changeTimer);
      doSearch.cancel();
      unsubscribe();
    },
  };
}
