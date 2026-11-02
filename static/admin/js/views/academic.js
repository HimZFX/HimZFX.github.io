/**
 * views/academic.js — 「学术」：论文 / 报告与海报 / 近况（#/academic?tab=publications|talks|news）。
 *
 * - 每条记录一个 YAML 文件：data/publications/<id>.yaml、data/talks/<id>.yaml、data/news/<日期>-<slug>.yaml
 *   （字段约定见 academic.js 和 docs/admin-architecture.md 第 15 节）。保存 / 删除 = 一个提交，带 baseSha 防覆盖。
 * - 论文：粘贴 BibTeX（ADS / arXiv 导出）自动填表；PDF 上传到 static/documents/papers/（和 YAML 同一个提交）。
 * - 报告与海报：幻灯片上传到 static/documents/talks/（或填网址）。
 * - 近况：页面上直接快速添加。
 * - 每个标签页：「在顶部菜单显示」开关（只改 content/<栏目>/_index*.md 的 menu）、设置卡片（params.toml，tomlpatch 精确修改）。
 *
 * 安全：界面全部用 h() / textContent 生成；上传只接受 PDF（并经过 uploads.js 的检查）。
 *
 * @module views/academic
 */

import {
  h, svgIcon, render, clear, toast, modal, confirmDialog, withBusy, badge, emptyState, loadingState,
  errorState, errorMessage, debounce,
} from '../ui.js';
import {
  SECTIONS, SECTION_KEYS, PUB_STATUSES, PUB_STATUS_LABELS, PUB_KINDS, PUB_KIND_LABELS, TALK_KINDS, TALK_KIND_LABELS,
  GROUP_BY, GROUP_BY_LABELS, parseBibtex, bibToPublication, publicationIdFor, talkIdFor, newsIdFor, isValidId,
  entryFileText, parseYamlEntry, formValues, idFromPath, groupPublications, splitTalks, sortNews, isMyName, todayISO,
  isIsoDate, normalizeArxiv, normalizeDoi, normalizeAdsBibcode, normalizeSocialUrl, menuWithoutMain, nextMenuWeight,
  academicIndexDocument, identifierError,
} from '../academic.js';
import { parseToml, getIn, setValue } from '../tomlpatch.js';
import { splitDocument, parseFrontMatter, setFields } from '../frontmatter.js';
import { langSitePath, langSiteUrl, sitePathFor, viewerUrlFor, isPdfPath } from '../content.js';
import { safeFileName, extOf } from '../images.js';
import {
  checkUploads, needsReview, gitignoreMatcher, uploadReviewSections, refusedContent, mapLimit,
} from '../uploads.js';
import { joinDocument } from '../courses.js';
import { mainMenuOf, patchMenuWeight } from './pages.js';
import { readFrontMatters } from './posts.js';
import { PATHS } from '../config.js';

const TAB_LABELS = { publications: '论文', talks: '报告与海报', news: '近况' };
const TAB_ICONS = { publications: 'post', talks: 'clock', news: 'send' };
const ITEM_NAME = { publications: '论文', talks: '报告', news: '近况' };

let seq = 0;
const uid = (p) => `ac-${p}-${++seq}`;

/**
 * @param {HTMLElement} container
 * @param {Record<string,string>} params
 * @param {object} ctx
 */
export default async function mount(container, params, ctx) {
  ctx.setTitle('学术');
  const repo = ctx.repo;
  const langs = ctx.langs && ctx.langs.length ? ctx.langs : ['en', 'zh'];
  const st = {
    tab: SECTION_KEYS.includes(params.tab) ? params.tab : 'publications',
    disposed: false,
    entries: { publications: null, talks: null, news: null },
    menu: { publications: null, talks: null, news: null },
    params: null,       // { path, sha, text, cfg }
    loadError: null,
    openForms: 0,
    settingsOpen: null,
  };

  const root = h('div', { class: 'view ac-view stack' });
  render(container, root);

  const tabBtns = {};
  const tabBar = h('div', { class: 'tabs ac-tabs', role: 'tablist', 'aria-label': '学术内容' },
    SECTION_KEYS.map((k) => {
      const b = h('button', {
        type: 'button', class: 'tab', role: 'tab', id: `ac-tab-${k}`, 'aria-controls': 'ac-panel',
        dataset: { testid: `academic-tab-${k}` },
      }, svgIcon(TAB_ICONS[k]), TAB_LABELS[k], h('span', { class: 'badge badge-gray ac-tab-count', dataset: { testid: `academic-count-${k}` } }));
      b.addEventListener('click', () => selectTab(k));
      tabBtns[k] = b;
      return b;
    }));
  const panel = h('div', { class: 'ac-panel stack', id: 'ac-panel', role: 'tabpanel' });
  render(root,
    h('div', { class: 'page-header' },
      h('div', {},
        h('h1', {}, '学术'),
        h('p', { class: 'page-desc' }, '论文、报告与海报、近况。每条记录是一个小文件，保存后约 1–2 分钟在网站上生效。'))),
    tabBar, panel);
  render(panel, loadingState('正在读取…'));

  // 隐藏的文件选择框（上传 PDF）
  const fileInput = h('input', { type: 'file', accept: 'application/pdf,.pdf', hidden: true, dataset: { testid: 'academic-file-input' } });
  let onFilePicked = null;
  fileInput.addEventListener('change', () => {
    const f = fileInput.files && fileInput.files[0];
    fileInput.value = '';
    const cb = onFilePicked;
    onFilePicked = null;
    if (f && cb) cb(f);
  });
  root.appendChild(fileInput);

  // ---------------------------------------------------------------------------
  // 读取

  async function loadSection(kind) {
    const dir = SECTIONS[kind].dataDir;
    const files = repo.list(dir + '/').filter((e) => idFromPath(e.path, dir));
    const list = await mapLimit(files, 6, async (e) => {
      const id = idFromPath(e.path, dir);
      try {
        const text = await repo.readText(e.path);
        const data = parseYamlEntry(text);
        return { id, path: e.path, sha: e.sha, text, data, values: formValues(kind, data) };
      } catch (err) {
        return { id, path: e.path, sha: e.sha, text: null, data: null, values: null, error: errorMessage(err) };
      }
    });
    return list;
  }

  async function loadParams() {
    const path = PATHS.params;
    const e = repo.entry(path);
    if (!e) throw new Error(`找不到配置文件 ${path}`);
    const text = await repo.readText(path);
    let cfg;
    try { cfg = parseToml(text); } catch (err) { throw new Error(`${path} 的格式有误：${errorMessage(err)}`); }
    return { path, sha: e.sha, text, cfg };
  }

  /** content/<栏目>/ 下的 _index.md 和 _index.<语言>.md（只认网站的语言）。 */
  function indexPaths(kind) {
    const dir = SECTIONS[kind].pageDir;
    return [null, ...langs].map((l) => (l ? `${dir}/_index.${l}.md` : `${dir}/_index.md`)).filter((p) => repo.has(p));
  }

  async function loadMenu(kind) {
    const paths = indexPaths(kind);
    const out = [];
    for (const p of paths) {
      const e = repo.entry(p);
      const text = await repo.readText(p);
      let fm = null;
      let error = null;
      try {
        const doc = splitDocument(text);
        if (doc.kind !== 'yaml' && doc.kind !== 'none') error = '设置区不是 YAML 格式';
        fm = parseFrontMatter(doc.fmText);
      } catch (err) { error = errorMessage(err); }
      out.push({ path: p, sha: e.sha, text, fm, error, ...(fm ? mainMenuOf(fm) : { inMenu: false, weight: null }) });
    }
    return { variants: out, inMenu: out.some((v) => v.inMenu), exists: out.length > 0 };
  }

  async function loadAll() {
    st.loadError = null;
    try {
      const [pubs, talks, news, prm, m1, m2, m3] = await Promise.all([
        loadSection('publications'), loadSection('talks'), loadSection('news'), loadParams(),
        loadMenu('publications'), loadMenu('talks'), loadMenu('news'),
      ]);
      if (st.disposed) return;
      st.entries = { publications: pubs, talks, news };
      st.params = prm;
      st.menu = { publications: m1, talks: m2, news: m3 };
    } catch (err) {
      console.error('[academic] load failed', err);
      st.loadError = err;
    }
  }

  await loadAll();
  if (st.disposed) return {};
  renderAll();

  // ---------------------------------------------------------------------------
  // 渲染

  function selectTab(k) {
    if (st.tab === k) return;
    st.tab = k;
    try { history.replaceState(history.state, '', `#/academic?tab=${k}`); } catch { /* ignore */ }
    renderAll();
    tabBtns[k].focus();
  }

  function renderAll() {
    if (st.disposed) return;
    for (const k of SECTION_KEYS) {
      const on = k === st.tab;
      tabBtns[k].classList.toggle('active', on);
      tabBtns[k].setAttribute('aria-selected', on ? 'true' : 'false');
      tabBtns[k].tabIndex = on ? 0 : -1;
      const list = st.entries[k];
      const cnt = tabBtns[k].querySelector('.ac-tab-count');
      cnt.textContent = list ? String(list.length) : '';
      cnt.hidden = !list || !list.length;
    }
    panel.setAttribute('aria-labelledby', `ac-tab-${st.tab}`);
    if (st.loadError) {
      render(panel, h('div', { class: 'card' }, errorState('读取失败', {
        detail: errorMessage(st.loadError),
        retry: async () => { render(panel, loadingState('正在读取…')); await loadAll(); renderAll(); },
      })));
      return;
    }
    const kind = st.tab;
    if (kind === 'publications') render(panel, menuCard(kind), pubSettingsCard(), pubListCard());
    else if (kind === 'talks') render(panel, menuCard(kind), talkListCard());
    else render(panel, menuCard(kind), newsQuickCard(), newsListCard(), newsSettingsCard());
  }

  function entryCount(kind) {
    return (st.entries[kind] || []).filter((e) => !e.error).length;
  }

  // ---- 顶部菜单开关 ----
  function menuCard(kind) {
    const m = st.menu[kind] || { variants: [], inMenu: false, exists: false };
    const def = SECTIONS[kind];
    const sw = h('input', { type: 'checkbox', checked: m.inMenu, 'aria-label': `在网站顶部菜单显示「${def.titles.zh}」`, dataset: { testid: `academic-menu-${kind}` } });
    sw.addEventListener('change', () => {
      const want = sw.checked;
      sw.checked = !want; // 发布成功后才真正切换
      withBusy(sw, () => toggleMenu(kind, want));
    });
    const urls = langs.map((l) => langSitePath(`${kind}/`, l, ctx.defaultLang));
    const links = h('span', { class: 'ac-menu-urls muted small' }, '网站上的页面：',
      urls.map((u, i) => [i ? ' · ' : '', h('a', { href: ctx.siteUrl.replace(/\/$/, '') + u, target: '_blank', rel: 'noopener noreferrer' }, u)]));
    const n = entryCount(kind);
    let note = null;
    if (m.inMenu && n === 0) {
      note = h('div', { class: 'banner banner-warning ac-banner', dataset: { testid: `academic-menu-empty-${kind}` } }, svgIcon('warning'),
        h('span', {}, `顶部菜单里已经有「${def.titles.zh} / ${def.titles.en}」，但还没有任何${ITEM_NAME[kind]}：访客点进去只会看到一句「暂无内容」。添加第一条之后就好了。`));
    } else if (!m.inMenu && n === 0) {
      note = h('p', { class: 'muted small ac-menu-hint', dataset: { testid: `academic-menu-hint-${kind}` } },
        `还没有${ITEM_NAME[kind]}，建议先添加内容，再打开菜单开关。`);
    }
    if (m.variants.some((v) => v.error)) {
      note = h('div', { class: 'banner banner-error ac-banner' }, svgIcon('warning'),
        h('span', {}, `${m.variants.filter((v) => v.error).map((v) => v.path).join('、')} 的设置区格式有误，菜单开关暂时不能用，请在 GitHub 上检查。`));
      sw.disabled = true;
    }
    return h('section', { class: 'card ac-menu-card', dataset: { testid: `academic-menu-card-${kind}` } },
      h('div', { class: 'ac-menu-row' },
        h('label', { class: 'ac-menu-label' },
          h('span', { class: 'switch' }, sw, h('span', {})),
          h('span', { class: 'ac-menu-text' },
            h('strong', {}, '在顶部菜单显示'),
            h('span', { class: 'muted small' }, m.inMenu ? `已显示（${def.titles.en} / ${def.titles.zh}）` : '目前不显示（页面仍然可以通过网址打开）'))),
        links),
      note);
  }

  async function menuWeight(kind) {
    const own = new Set(indexPaths(kind));
    const paths = repo.list('content/').map((e) => e.path)
      .filter((p) => /^content\/[^/]+\.md$/.test(p) || /^content\/[^/]+\/_index(\.[a-z-]+)?\.md$/.test(p))
      .filter((p) => !own.has(p));
    const fms = await readFrontMatters(repo, paths);
    const weights = [];
    for (const [, r] of fms) {
      const m = r && r.fm ? mainMenuOf(r.fm) : null;
      if (m && m.inMenu && m.weight != null) weights.push(m.weight);
    }
    return nextMenuWeight(weights);
  }

  async function toggleMenu(kind, on) {
    if (ctx.isPublishing && ctx.isPublishing()) { toast('正在发布，请稍候', { type: 'info' }); return; }
    const def = SECTIONS[kind];
    const m = await loadMenu(kind);
    const changes = [];
    try {
      if (on) {
        const weight = await menuWeight(kind);
        if (!m.exists) {
          changes.push({ path: `${def.pageDir}/_index.md`, content: academicIndexDocument(kind, ctx.defaultLang, weight), baseSha: null });
          for (const l of langs) {
            if (l === ctx.defaultLang) continue;
            changes.push({ path: `${def.pageDir}/_index.${l}.md`, content: academicIndexDocument(kind, l, weight), baseSha: null });
          }
        } else {
          for (const v of m.variants) {
            if (v.inMenu) continue;
            changes.push({ path: v.path, content: patchMenuWeight(v.text, weight, v.path), baseSha: v.sha });
          }
        }
      } else {
        for (const v of m.variants) {
          if (!v.inMenu) continue;
          const doc = splitDocument(v.text);
          const fmText = setFields(doc.fmText, { menu: menuWithoutMain(v.fm.menu) });
          const out = joinDocument(fmText, doc.body);
          if (splitDocument(out).body !== doc.body || mainMenuOf(parseFrontMatter(splitDocument(out).fmText)).inMenu) {
            throw new Error(`修改 ${v.path} 时校验未通过，已取消`);
          }
          changes.push({ path: v.path, content: out, baseSha: v.sha });
        }
      }
    } catch (err) {
      toast(`没能修改菜单，什么都没有改：${errorMessage(err)}`, { type: 'error', timeout: 9000 });
      return;
    }
    if (!changes.length) { st.menu[kind] = m; renderAll(); return; }
    let res;
    try {
      res = await ctx.publish({
        message: on ? `admin: 在顶部菜单显示「${def.titles.zh}」` : `admin: 从顶部菜单移除「${def.titles.zh}」`,
        changes,
        summary: changes.map((c) => c.path),
        viewUrl: langSiteUrl(ctx.siteUrl, `${kind}/`, ctx.defaultLang, ctx.defaultLang),
        viewLabel: '打开页面',
      });
    } catch { return; }
    if (st.disposed) return;
    st.menu[kind] = await loadMenu(kind);
    renderAll();
    if (res && !res.conflict && on && entryCount(kind) === 0) {
      toast(`已加到顶部菜单。注意：还没有任何${ITEM_NAME[kind]}，页面上暂时只有一句「暂无内容」`, { type: 'warning', timeout: 8000 });
    }
  }

  // ---- 设置（params.toml） ----

  function settingsCard(kind, title, fields, onSave) {
    const saveBtn = h('button', { type: 'button', class: 'btn btn-primary btn-sm', dataset: { testid: `academic-settings-save-${kind}` } }, svgIcon('send'), '保存设置');
    saveBtn.addEventListener('click', () => withBusy(saveBtn, onSave));
    const d = h('details', { class: 'card ac-settings', open: st.settingsOpen === kind, dataset: { testid: `academic-settings-${kind}` } },
      h('summary', { class: 'ac-settings-summary' }, svgIcon('settings'), h('span', {}, title), svgIcon('chevron-down', { class: 'ac-chevron' })),
      h('div', { class: 'ac-settings-body stack-sm' }, fields, h('div', { class: 'row ac-settings-actions' }, saveBtn)));
    d.addEventListener('toggle', () => { st.settingsOpen = d.open ? kind : (st.settingsOpen === kind ? null : st.settingsOpen); });
    return d;
  }

  async function saveParams(kind, updates, label) {
    // updates: [{ table, key, value, current }]
    let text = st.params.text;
    try {
      for (const u of updates) {
        if (deepSame(u.value, u.current)) continue;
        text = setValue(text, u.table, u.key, u.value);
      }
    } catch (err) {
      toast(`没能生成新的配置，什么都没有改：${errorMessage(err)}`, { type: 'error', timeout: 9000 });
      return false;
    }
    if (text === st.params.text) { toast('设置没有变化', { type: 'info' }); return true; }
    let res;
    try {
      res = await ctx.publish({ message: `admin: 更新${label}设置`, changes: [{ path: st.params.path, content: text, baseSha: st.params.sha }], summary: [st.params.path] });
    } catch { return false; }
    if (st.disposed) return false;
    if (res && res.conflict) {
      if (res.reloaded) {
        try { st.params = await loadParams(); } catch (err) { toast(errorMessage(err), { type: 'error' }); return false; }
        toast('已读取网站上的最新设置，你填的内容还在。请检查后再点一次「保存设置」', { type: 'info', timeout: 7000 });
      }
      return false;
    }
    st.params = { ...st.params, text, sha: (res && res.shas && res.shas[st.params.path]) || (repo.entry(st.params.path) || {}).sha || st.params.sha, cfg: parseToml(text) };
    return true;
  }

  function cfgGet(path, fallback) {
    const v = getIn(st.params.cfg, path);
    return v === undefined ? fallback : v;
  }

  function field(label, control, { hint, optional, testid } = {}) {
    const id = uid('f');
    control.id = id;
    if (testid && !control.dataset.testid) control.dataset.testid = testid;
    return h('div', { class: 'field' }, h('label', { htmlFor: id }, label, optional ? h('span', { class: 'optional' }, '（可选）') : null), control,
      hint ? h('div', { class: 'hint' }, hint) : null);
  }

  function pubSettingsCard() {
    const names = cfgGet(['publications', 'myNames'], []);
    const namesIn = h('textarea', { class: 'input ac-names', rows: 3, placeholder: '每行一种写法，例如\nZhong, F.\nZhong, Fangxiong', dataset: { testid: 'pub-myNames' } });
    namesIn.value = Array.isArray(names) ? names.join('\n') : String(names || '');
    const mk = (key, placeholder, testid) => {
      const i = h('input', { class: 'input', type: 'text', autocomplete: 'off', placeholder, dataset: { testid } });
      i.value = String(cfgGet(['publications', key], '') || '');
      return i;
    };
    const ads = mk('ads', '你的 ADS 署名（如 Zhong, F.）或 ADS 检索网址', 'pub-ads-profile');
    const orcid = mk('orcid', '0000-0000-0000-0000', 'pub-orcid');
    const scholar = mk('scholar', 'Google 学术主页网址，或 user= 后面的编号', 'pub-scholar');
    orcid.addEventListener('blur', () => { orcid.value = normalizeSocialUrl('orcid', orcid.value); });
    scholar.addEventListener('blur', () => { scholar.value = normalizeSocialUrl('googlescholar', scholar.value); });
    const group = h('select', { class: 'input', dataset: { testid: 'pub-groupBy' } },
      GROUP_BY.map((g) => h('option', { value: g }, GROUP_BY_LABELS[g])));
    const curGroup = String(cfgGet(['publications', 'groupBy'], 'kind') || 'kind');
    group.value = GROUP_BY.includes(curGroup) ? curGroup : 'kind';
    return settingsCard('publications', '论文设置：我的署名写法、ADS / ORCID / Google 学术、分组方式', [
      field('我的署名写法', namesIn, { optional: true, hint: '作者列表里和这些写法相同的名字会加粗（不区分大小写、空格和点）。每行一种。' }),
      h('div', { class: 'ac-grid' },
        field('NASA ADS', ads, { optional: true }),
        field('ORCID', orcid, { optional: true }),
        field('Google 学术', scholar, { optional: true }),
        field('分组方式', group)),
      h('p', { class: 'muted small' }, '填了的链接会显示在网站论文页的最上面；不填就不显示。'),
    ], async () => {
      const list = namesIn.value.split('\n').map((x) => x.trim()).filter(Boolean);
      const curNames = cfgGet(['publications', 'myNames'], undefined);
      const ups = [
        { table: 'publications', key: 'myNames', value: list, current: curNames === undefined && !list.length ? list : curNames },
      ];
      for (const [key, input] of [['ads', ads], ['orcid', orcid], ['scholar', scholar]]) {
        const cur = cfgGet(['publications', key], undefined);
        const v = input.value.trim();
        ups.push({ table: 'publications', key, value: v, current: cur === undefined && v === '' ? '' : cur });
      }
      const curG = cfgGet(['publications', 'groupBy'], undefined);
      ups.push({ table: 'publications', key: 'groupBy', value: group.value, current: curG === undefined && group.value === 'kind' ? 'kind' : curG });
      if (await saveParams('publications', ups, '论文')) renderAll();
    });
  }

  function newsSettingsCard() {
    const cur = cfgGet(['news', 'homeCount'], 5);
    const input = h('input', { class: 'input ac-num', type: 'number', min: 0, max: 50, step: 1, inputmode: 'numeric', dataset: { testid: 'news-homeCount' } });
    input.value = String(cur);
    return settingsCard('news', '近况设置：首页显示几条', [
      field('首页显示几条近况', input, { hint: '首页头像下面显示最新的几条；更多的放在「全部近况」页。0 = 首页不显示近况。' }),
    ], async () => {
      const n = Number(input.value);
      if (!Number.isInteger(n) || n < 0 || n > 50) { toast('请填 0–50 之间的整数', { type: 'warning' }); input.focus(); return; }
      const curV = cfgGet(['news', 'homeCount'], undefined);
      if (await saveParams('news', [{ table: 'news', key: 'homeCount', value: n, current: curV === undefined && n === 5 ? 5 : curV }], '近况')) renderAll();
    });
  }

  // ---- 列表 ----

  function listCard(kind, title, addBtn, body) {
    return h('section', { class: 'card ac-list-card', dataset: { testid: `academic-list-${kind}` } },
      h('div', { class: 'card-header' }, h('h2', { class: 'card-title' }, svgIcon(TAB_ICONS[kind]), title), addBtn),
      body);
  }

  function brokenList(kind) {
    const rows = brokenRows(kind);
    return rows.length ? h('ul', { class: 'list ac-list', dataset: { testid: 'academic-broken-list' } }, rows) : null;
  }

  function brokenRows(kind) {
    return (st.entries[kind] || []).filter((e) => e.error).map((e) => h('li', { class: 'list-item ac-row is-broken', dataset: { testid: 'academic-broken' } },
      h('div', { class: 'list-item-main' },
        h('div', { class: 'list-item-title' }, h('code', {}, e.path)),
        h('div', { class: 'list-item-meta text-danger' }, `这个文件格式有误，后台无法编辑：${e.error}`)),
      h('div', { class: 'list-item-actions' }, deleteButton(kind, e))));
  }

  function rowActions(kind, e, testPrefix) {
    const edit = h('button', { type: 'button', class: 'btn btn-ghost btn-sm', dataset: { testid: `${testPrefix}-edit` } }, svgIcon('edit'), '编辑');
    edit.addEventListener('click', () => openForm(kind, e));
    return h('div', { class: 'list-item-actions ac-actions' }, edit, deleteButton(kind, e, testPrefix));
  }

  function deleteButton(kind, e, testPrefix = 'academic') {
    const del = h('button', { type: 'button', class: 'btn btn-ghost btn-sm btn-danger', 'aria-label': '删除', title: '删除', dataset: { testid: `${testPrefix}-delete` } }, svgIcon('trash'), h('span', { class: 'hide-mobile' }, '删除'));
    del.addEventListener('click', () => withBusy(del, () => deleteEntry(kind, e)));
    return del;
  }

  function authorsLine(authors) {
    const my = cfgGet(['publications', 'myNames'], []);
    const list = Array.isArray(authors) ? authors : [];
    const max = 8;
    const shown = list.length > max ? [...list.slice(0, 3), '…'] : list;
    return h('span', { class: 'ac-authors' }, shown.map((a, i) => [i ? ', ' : '', isMyName(a, my) ? h('strong', { class: 'ac-me' }, a) : a]),
      list.length > max ? ` 等 ${list.length} 人` : '');
  }

  function pubListCard() {
    const add = h('button', { type: 'button', class: 'btn btn-primary', dataset: { testid: 'pub-add' } }, svgIcon('plus'), '添加论文');
    add.addEventListener('click', () => openForm('publications', null));
    const ok = (st.entries.publications || []).filter((e) => !e.error);
    const groupBy = String(cfgGet(['publications', 'groupBy'], 'kind') || 'kind');
    const groups = groupPublications(ok.map((e) => ({ ...e.values, id: e.id, entry: e })), groupBy);
    let body;
    if (!ok.length && !brokenRows('publications').length) {
      body = emptyState('还没有论文。点「添加论文」，从 NASA ADS 或 arXiv 复制 BibTeX 粘贴进去，就能自动填好。', { text: '添加论文', icon: 'plus', onClick: () => openForm('publications', null) }, { icon: 'post' });
    } else {
      body = h('div', { class: 'ac-groups' },
        groups.map((g) => h('div', { class: 'ac-group', dataset: { testid: 'pub-group', key: g.key } },
          h('h3', { class: 'ac-group-title' }, g.label, badge(String(g.items.length), 'gray')),
          h('ul', { class: 'list ac-list' }, g.items.map((p) => pubRow(p.entry))))),
        brokenList('publications'));
    }
    return listCard('publications', '论文', add, body);
  }

  function pubRow(e) {
    const v = e.values;
    const venue = [v.venue, v.volume, v.pages].filter(Boolean).join(', ');
    const badges = [];
    if (v.status && v.status !== 'published') badges.push(badge(PUB_STATUS_LABELS[v.status] || v.status, v.status === 'accepted' ? 'green' : 'orange'));
    if (v.kind && v.kind !== 'refereed') badges.push(badge(PUB_KIND_LABELS[v.kind] || v.kind, 'gray'));
    if (v.selected) badges.push(badge('★ 代表作', 'blue'));
    if (v.pdf) badges.push(badge('PDF', 'gray'));
    return h('li', { class: 'list-item ac-row', dataset: { testid: 'pub-row', id: e.id } },
      h('div', { class: 'list-item-main' },
        h('div', { class: 'list-item-title ac-title' }, v.title || '（没有标题）'),
        h('div', { class: 'ac-sub' }, authorsLine(v.authors)),
        h('div', { class: 'list-item-meta' }, [venue, v.year].filter(Boolean).join(' · ') || '期刊未填', badges.length ? h('span', { class: 'ac-badges' }, badges) : null)),
      rowActions('publications', e, 'pub'));
  }

  function talkListCard() {
    const add = h('button', { type: 'button', class: 'btn btn-primary', dataset: { testid: 'talk-add' } }, svgIcon('plus'), '添加报告 / 海报');
    add.addEventListener('click', () => openForm('talks', null));
    const ok = (st.entries.talks || []).filter((e) => !e.error);
    const { upcoming, past } = splitTalks(ok.map((e) => ({ ...e.values, id: e.id, entry: e })), todayISO());
    let body;
    if (!ok.length && !brokenRows('talks').length) {
      body = emptyState('还没有报告或海报。点「添加报告 / 海报」，填上题目、会议和日期；幻灯片可以上传 PDF。', { text: '添加报告 / 海报', icon: 'plus', onClick: () => openForm('talks', null) }, { icon: 'clock' });
    } else {
      const sec = (label, items, testid) => (items.length ? h('div', { class: 'ac-group', dataset: { testid } },
        h('h3', { class: 'ac-group-title' }, label, badge(String(items.length), 'gray')),
        h('ul', { class: 'list ac-list' }, items.map((t) => talkRow(t.entry)))) : null);
      body = h('div', { class: 'ac-groups' }, sec('即将进行', upcoming, 'talks-upcoming'), sec('过去的', past, 'talks-past'),
        brokenList('talks'));
    }
    return listCard('talks', '报告与海报', add, body);
  }

  function talkRow(e) {
    const v = e.values;
    return h('li', { class: 'list-item ac-row', dataset: { testid: 'talk-row', id: e.id } },
      h('div', { class: 'list-item-main' },
        h('div', { class: 'list-item-title ac-title' }, v.title || '（没有题目）'),
        h('div', { class: 'list-item-meta' }, [v.date, v.event, v.location].filter(Boolean).join(' · '),
          h('span', { class: 'ac-badges' }, badge(TALK_KIND_LABELS[v.kind] || v.kind || '报告', 'gray'), v.slides ? badge('幻灯片', 'gray') : null))),
      rowActions('talks', e, 'talk'));
  }

  function newsListCard() {
    const ok = (st.entries.news || []).filter((e) => !e.error);
    const items = sortNews(ok.map((e) => ({ ...e.values, id: e.id, entry: e })));
    const body = items.length || brokenRows('news').length
      ? h('ul', { class: 'list ac-list' }, items.map((n) => newsRow(n.entry)), brokenRows('news'))
      : h('p', { class: 'muted ac-empty-line', dataset: { testid: 'news-empty' } }, '还没有近况。用上面的表单写第一条吧，例如「论文被 ApJ 接收」「下周在 AAS 做报告」。');
    return listCard('news', '全部近况', null, body);
  }

  function newsRow(e) {
    const v = e.values;
    const extras = langs.filter((l) => v[`text_${l}`]).map((l) => badge(`${ctx.langName(l)}单独写`, 'gray'));
    return h('li', { class: 'list-item ac-row', dataset: { testid: 'news-row', id: e.id } },
      h('div', { class: 'list-item-main' },
        h('div', { class: 'ac-news-text' }, v.text || v[`text_${ctx.defaultLang}`] || ''),
        h('div', { class: 'list-item-meta' }, v.date, v.link ? h('span', { class: 'mono small' }, v.link) : null, extras.length ? h('span', { class: 'ac-badges' }, extras) : null)),
      rowActions('news', e, 'news'));
  }

  function newsQuickCard() {
    const f = entryFields('news', { date: todayISO(), text: '', text_en: '', text_zh: '', link: '' }, { quick: true });
    const btn = h('button', { type: 'button', class: 'btn btn-primary', dataset: { testid: 'news-add' } }, svgIcon('send'), '发布这条近况');
    btn.addEventListener('click', () => withBusy(btn, async () => {
      const ok = await saveEntry('news', null, f);
      if (ok) renderAll();
    }));
    return h('section', { class: 'card ac-quick', dataset: { testid: 'news-quick' } },
      h('div', { class: 'card-header' }, h('h2', { class: 'card-title' }, svgIcon('plus'), '写一条近况')),
      f.el,
      h('div', { class: 'row ac-quick-actions' }, btn));
  }

  // ---------------------------------------------------------------------------
  // 表单

  /**
   * 生成一类记录的字段。返回 { el, get(), set(values, onlyUntouched?), validate(), pending, base }。
   * pending：待上传的 PDF { field, path, blob, sitePath, baseSha }。
   */
  function entryFields(kind, values, { quick = false, isNew = true, existingId = null } = {}) {
    const inputs = {};
    const touched = new Set();
    const errs = {};
    const form = { pending: null, base: { ...values }, idTouched: false };

    const mkErr = (key) => { const e = h('div', { class: 'error', role: 'alert', dataset: { testid: `err-${key}` } }); e.hidden = true; errs[key] = e; return e; };
    const wrap = (key, label, control, { hint, optional, span, extra } = {}) => {
      const id = uid(key);
      control.id = id;
      control.addEventListener('input', () => { touched.add(key); setErr(key, null); });
      control.addEventListener('change', () => { touched.add(key); });
      inputs[key] = control;
      return h('div', { class: ['field', span && 'ac-span2', `ac-f-${key}`] },
        h('label', { htmlFor: id }, label, optional ? h('span', { class: 'optional' }, '（可选）') : null),
        extra ? h('div', { class: 'input-group' }, control, extra) : control,
        hint ? h('div', { class: 'hint' }, hint) : null,
        mkErr(key));
    };
    const text = (key, ph = '', attrs = {}) => h('input', { class: 'input', type: 'text', autocomplete: 'off', placeholder: ph, dataset: { testid: `${prefix}-${key}` }, ...attrs });
    const area = (key, rows, ph = '') => h('textarea', { class: 'input', rows, placeholder: ph, dataset: { testid: `${prefix}-${key}` } });
    const select = (key, opts, allowEmpty) => h('select', { class: 'input', dataset: { testid: `${prefix}-${key}` } },
      allowEmpty ? h('option', { value: '' }, allowEmpty) : null,
      opts.map(([v, l]) => h('option', { value: v }, l)));
    const prefix = kind === 'publications' ? 'pub' : kind === 'talks' ? 'talk' : 'news';

    const uploadBtn = (key, dir) => {
      const b = h('button', { type: 'button', class: 'btn', dataset: { testid: `${prefix}-${key}-upload` } }, svgIcon('upload'), h('span', { class: 'hide-mobile' }, '上传 PDF'), h('span', { class: 'show-mobile' }, '上传'));
      b.addEventListener('click', () => {
        onFilePicked = (file) => withBusy(b, () => pickPdf(file, dir, key));
        fileInput.click();
      });
      return b;
    };
    const fileState = {};
    const fileNote = (key) => { const n = h('div', { class: 'hint ac-file-note', dataset: { testid: `${prefix}-${key}-note` } }); fileState[key] = n; return n; };

    async function pickPdf(file, dir, key) {
      const name = safeFileName(file.name || 'file.pdf');
      if (extOf(name) !== 'pdf') {
        toast('这里只能上传 PDF 文件', { type: 'warning' });
        return;
      }
      const path = `${dir}/${name}`;
      const item = { name, path, size: file.size, origName: file.name, blob: file };
      const review = checkUploads(repo, [item], await gitignoreMatcher(repo));
      if (review.refused.length) {
        await new Promise((resolve) => modal({ title: '无法上传', content: refusedContent(review.refused), actions: [{ text: '知道了', kind: 'primary', testid: 'confirm-ok', autofocus: true }], onClose: resolve }));
        return;
      }
      if (needsReview(review)) {
        const ok = await confirmDialog({ title: '确认上传这个文件？', message: h('div', { class: 'stack-sm' }, uploadReviewSections(review)), okText: '确定' });
        if (!ok) return;
      }
      const sitePath = sitePathFor(path);
      form.pending = { field: key, path, blob: file, sitePath, baseSha: item.existing ? item.existing.sha : null, name };
      inputs[key].value = sitePath;
      touched.add(key);
      refreshFileNote(key);
    }

    function refreshFileNote(key) {
      const n = fileState[key];
      if (!n) return;
      clear(n);
      const v = inputs[key].value.trim();
      if (form.pending && form.pending.field === key && form.pending.sitePath === v) {
        n.append(badge('待发布', 'orange'), ` ${form.pending.name}（${Math.max(1, Math.round(form.pending.blob.size / 1024))} KB）会在保存时一起上传`);
        return;
      }
      if (v.startsWith('/') && isPdfPath(v)) {
        const exists = repo.has('static' + v);
        const url = viewerUrlFor(v, { absolute: true, siteUrl: ctx.siteUrl });
        if (exists && url) n.append(h('a', { href: url, target: '_blank', rel: 'noopener noreferrer', dataset: { testid: `${prefix}-${key}-preview` } }, svgIcon('eye'), ' 在线预览'));
        else if (!exists) n.append(h('span', { class: 'text-danger' }, '网站上没有这个文件，请检查路径或重新上传'));
      }
    }

    let el;
    if (kind === 'publications') {
      const authors = area('authors', 4, '每行一位，例如\nZhong, F.\nDoe, J.');
      const statusSel = select('status', PUB_STATUSES.map((s) => [s, PUB_STATUS_LABELS[s]]));
      const kindSel = select('kind', PUB_KINDS.map((s) => [s, PUB_KIND_LABELS[s]]));
      const month = select('month', Array.from({ length: 12 }, (_, i) => [String(i + 1), `${i + 1} 月`]), '（不填）');
      const selected = h('input', { type: 'checkbox', dataset: { testid: 'pub-selected' } });
      const idIn = text('id', 'zhong2026neutral', { class: 'input mono', autocapitalize: 'off', spellcheck: 'false' });
      idIn.addEventListener('input', () => { form.idTouched = true; });
      if (!isNew) { idIn.readOnly = true; idIn.classList.add('is-readonly'); }
      const pdfIn = text('pdf', '/documents/papers/….pdf', { class: 'input mono' });
      pdfIn.addEventListener('input', () => refreshFileNote('pdf'));
      const bibRaw = area('bibtex', 6, '');
      bibRaw.dataset.testid = 'pub-bibtex-raw';
      bibRaw.classList.add('mono', 'ac-bib');
      el = h('div', { class: 'ac-grid ac-form' },
        wrap('title', '标题', text('title', '论文标题'), { span: true }),
        wrap('authors', '作者', authors, { span: true, hint: '每行一位，写法如 Zhong, F.；很长的合作组可以只写前几位，最后一行写 et al.' }),
        wrap('year', '年份', text('year', '2026', { inputmode: 'numeric', maxlength: 4 })),
        wrap('month', '月份', month, { optional: true }),
        wrap('venue', '期刊 / 会议', text('venue', '如 ApJ、MNRAS、arXiv e-prints'), { span: true, optional: true }),
        wrap('volume', '卷', text('volume', '960'), { optional: true }),
        wrap('pages', '页码 / 文章号', text('pages', '101'), { optional: true }),
        wrap('status', '状态', statusSel),
        wrap('kind', '类型', kindSel),
        h('div', { class: 'field ac-span2 ac-check' }, h('label', { class: 'checkbox' }, selected, ' 代表作（在网站上标出来，首页以后也可以只显示代表作）')),
        wrap('arxiv', 'arXiv 编号', text('arxiv', '2603.01234', { class: 'input mono' }), { optional: true }),
        wrap('ads', 'ADS bibcode', text('ads', '2026ApJ...999..123Z', { class: 'input mono' }), { optional: true }),
        wrap('doi', 'DOI', text('doi', '10.3847/…', { class: 'input mono' }), { optional: true, span: true }),
        h('div', { class: 'ac-span2' }, wrap('pdf', 'PDF', pdfIn, { optional: true, extra: uploadBtn('pdf', SECTIONS.publications.uploadDir), hint: '上传后访客点「PDF」会打开网站的在线阅读器。放预印本或作者版即可。' }), fileNote('pdf')),
        wrap('code', '代码', text('code', 'https://github.com/…'), { optional: true }),
        wrap('slides', '幻灯片', text('slides', '/documents/talks/….pdf 或 https://…'), { optional: true }),
        wrap('note', '备注', text('note', '如 Highlighted by AAS Nova'), { optional: true, span: true }),
        wrap('id', '文件名', idIn, { span: true, hint: isNew ? '自动生成：data/publications/<文件名>.yaml，只能用小写字母、数字和 -，以后不能改' : `data/publications/${existingId}.yaml` }),
        h('details', { class: 'ac-span2 ac-raw' }, h('summary', {}, 'BibTeX 原文（网站上「复制 BibTeX」用）'), wrap('bibtex', 'BibTeX', bibRaw, { optional: true })));
      inputs.selected = selected;
      selected.addEventListener('change', () => touched.add('selected'));
    } else if (kind === 'talks') {
      const slidesIn = text('slides', '/documents/talks/….pdf 或 https://…', { class: 'input mono' });
      slidesIn.addEventListener('input', () => refreshFileNote('slides'));
      el = h('div', { class: 'ac-grid ac-form' },
        wrap('title', '题目', text('title', '报告或海报的题目'), { span: true }),
        wrap('date', '日期', h('input', { class: 'input', type: 'date', dataset: { testid: 'talk-date' } })),
        wrap('kind', '类型', select('kind', TALK_KINDS.map((s) => [s, TALK_KIND_LABELS[s]]))),
        wrap('event', '会议 / 活动', text('event', '如 AAS 247'), { optional: true }),
        wrap('location', '地点', text('location', '如 Phoenix, AZ 或 Online'), { optional: true }),
        h('div', { class: 'ac-span2' }, wrap('slides', '幻灯片 / 海报', slidesIn, { optional: true, extra: uploadBtn('slides', SECTIONS.talks.uploadDir), hint: '上传 PDF，或者填一个网址（例如 Google Slides）' }), fileNote('slides')),
        wrap('video', '视频', text('video', 'https://…'), { optional: true }),
        wrap('url', '会议网址', text('url', 'https://…'), { optional: true }),
        wrap('abstract', '摘要', area('abstract', 4), { optional: true, span: true }),
        wrap('note', '备注', text('note', ''), { optional: true, span: true }));
      if (isNew) {
        const idIn = text('id', '2026-01-08-aas-247', { class: 'input mono', autocapitalize: 'off', spellcheck: 'false' });
        idIn.addEventListener('input', () => { form.idTouched = true; });
        el.appendChild(wrap('id', '文件名', idIn, { span: true, hint: '自动生成：data/talks/<文件名>.yaml，只能用小写字母、数字和 -，以后不能改' }));
      }
    } else {
      const others = langs.map((l) => wrap(`text_${l}`, `${ctx.siteLabel(l)}单独写`, area(`text_${l}`, 2, `只在${ctx.siteLabel(l)}显示这一句（不填 = 用上面的文字）`), { optional: true, span: true }));
      el = h('div', { class: 'ac-grid ac-form' },
        wrap('text', '内容', area('text', 2, '例如：Our paper on dark galaxies was accepted by ApJ! 可以用 **粗体** 和 [链接](https://…)'), { span: true, hint: '所有语言共用这一句；某种语言想写不一样的，展开下面「中英文分别写」。只支持 Markdown：写 HTML 标签（如 <b>）会原样显示成文字。' }),
        wrap('date', '日期', h('input', { class: 'input', type: 'date', dataset: { testid: 'news-date' } })),
        wrap('link', '链接', text('link', 'posts/x/ 或 https://…', { class: 'input mono' }), { optional: true, hint: '站内页面写 posts/x/（两种语言各自跳转），外部网址以 https:// 开头' }),
        h('details', { class: 'ac-span2 ac-raw', dataset: { testid: 'news-langs' } }, h('summary', {}, '中英文分别写（可选）'), h('div', { class: 'stack-sm' }, others)));
    }

    function setErr(key, msg) {
      const e = errs[key];
      if (!e) return;
      e.textContent = msg || '';
      e.hidden = !msg;
      if (inputs[key]) inputs[key].setAttribute('aria-invalid', msg ? 'true' : 'false');
    }

    function get() {
      const v = {};
      for (const [k, i] of Object.entries(inputs)) {
        if (i.type === 'checkbox') v[k] = i.checked;
        else if (k === 'authors') v[k] = i.value.split('\n').map((x) => x.trim()).filter(Boolean);
        else v[k] = i.value;
      }
      return v;
    }

    function setOne(k, val) {
      const i = inputs[k];
      if (!i) return;
      if (i.type === 'checkbox') i.checked = !!val;
      else if (k === 'authors') i.value = Array.isArray(val) ? val.join('\n') : String(val || '');
      else i.value = val == null ? '' : String(val);
    }

    function set(vals, { onlyUntouched = false } = {}) {
      for (const [k, val] of Object.entries(vals)) {
        if (onlyUntouched && touched.has(k)) continue;
        setOne(k, val);
      }
      refreshFileNote('pdf');
      refreshFileNote('slides');
    }

    function validate() {
      const v = get();
      let bad = 0;
      const err = (k, m) => { setErr(k, m); if (m) bad++; };
      for (const k of Object.keys(errs)) setErr(k, null);
      const checkLink = (k, { file } = {}) => {
        const u = String(v[k] || '').trim();
        if (!u) return;
        if (/^\s*(javascript|data|vbscript):/i.test(u)) err(k, '不支持这种链接');
        else if (/\s/.test(u)) err(k, '链接里不能有空格');
        else if (/^[a-z][a-z0-9+.-]*:/i.test(u) && !/^https?:\/\//i.test(u)) err(k, '只支持 https:// 网址或网站路径');
        else if (file && !/^https?:\/\//i.test(u) && !u.startsWith('/')) err(k, '网站上的文件路径要以 / 开头，例如 /documents/papers/x.pdf');
      };
      if (kind === 'publications') {
        if (!String(v.title).trim()) err('title', '请填写标题');
        if (!v.authors.length) err('authors', '请至少填一位作者');
        const y = String(v.year).trim();
        if (y && !/^\d{4}$/.test(y)) err('year', '年份写四位数字，例如 2026');
        else if (!y && (v.status === 'published' || v.status === 'accepted')) err('year', '已发表 / 已接收的论文请填写年份');
        for (const k of ['pdf', 'slides']) checkLink(k, { file: k === 'pdf' });
        checkLink('code');
        for (const k of ['arxiv', 'ads', 'doi']) { const m = identifierError(k, v[k]); if (m) err(k, m); }
      } else if (kind === 'talks') {
        if (!String(v.title).trim()) err('title', '请填写题目');
        if (!isIsoDate(v.date)) err('date', '请选择日期');
        checkLink('slides', { file: false });
        checkLink('video');
        checkLink('url');
      } else {
        const anyText = String(v.text).trim() || langs.some((l) => String(v[`text_${l}`] || '').trim());
        if (!String(v.text).trim() && !langs.every((l) => String(v[`text_${l}`] || '').trim())) {
          err('text', anyText ? `只写了一种语言时，请把它写在「内容」里（${langs.map((l) => ctx.siteLabel(l)).join('、')}都会显示）` : '请填写内容');
        }
        if (!isIsoDate(v.date)) err('date', '请选择日期');
        const l = String(v.link || '').trim();
        if (l && (/^\s*(javascript|data|vbscript):/i.test(l) || /\s/.test(l) || (/^[a-z][a-z0-9+.-]*:/i.test(l) && !/^https?:\/\//i.test(l)))) err('link', '链接写站内路径（posts/x/）或 https:// 网址');
      }
      if (inputs.id && isNew) {
        const id = String(v.id || '').trim();
        if (!isValidId(id)) err('id', '文件名只能用小写字母、数字和 -，并以字母或数字开头');
        else if ((st.entries[kind] || []).some((e) => e.id.toLowerCase() === id.toLowerCase())) err('id', '已经有一条记录用了这个文件名');
      }
      return bad;
    }

    set(values);
    form.el = el;
    form.get = get;
    form.set = set;
    form.validate = validate;
    form.inputs = inputs;
    form.touched = touched;
    form.setErr = setErr;
    form.refreshFileNote = refreshFileNote;
    form.quick = quick;
    return form;
  }

  function blankValues(kind) {
    if (kind === 'publications') return formValues('publications', { status: 'published', kind: 'refereed' });
    if (kind === 'talks') return formValues('talks', { kind: 'talk', date: todayISO() });
    return formValues('news', { date: todayISO() });
  }

  function openForm(kind, entry) {
    if (ctx.isPublishing && ctx.isPublishing()) { toast('正在发布，请稍候', { type: 'warning' }); return; }
    const isNew = !entry;
    const values = isNew ? blankValues(kind) : { ...entry.values };
    const f = entryFields(kind, values, { isNew, existingId: entry ? entry.id : null });
    const testid = kind === 'publications' ? 'pub-form' : kind === 'talks' ? 'talk-form' : 'news-form';
    let content = f.el;

    // 新 id 的建议
    const suggestId = () => {
      if (!isNew || !f.inputs.id || f.idTouched) return;
      const v = f.get();
      const taken = (st.entries[kind] || []).map((e) => e.id);
      if (kind === 'publications') f.inputs.id.value = publicationIdFor({ ...v, ads: normalizeAdsBibcode(v.ads), arxiv: normalizeArxiv(v.arxiv) }, taken);
      else if (kind === 'talks') f.inputs.id.value = talkIdFor(v, taken);
    };

    if (kind === 'publications') {
      const box = h('textarea', {
        class: 'input mono ac-bib ac-bib-paste', rows: 6, spellcheck: 'false',
        placeholder: '在 NASA ADS 的论文页点 Export → BibTeX，或在 arXiv 页面点「Export BibTeX Citation」，复制后粘贴到这里。',
        'aria-label': '粘贴 BibTeX', dataset: { testid: 'pub-bibtex' },
      });
      const status = h('div', { class: 'ac-bib-status small', role: 'status', 'aria-live': 'polite', dataset: { testid: 'pub-bibtex-status' } });
      const pickHost = h('div', { class: 'ac-bib-pick' });
      const parseBtn = h('button', { type: 'button', class: 'btn', dataset: { testid: 'pub-bibtex-parse' } }, svgIcon('check'), '识别并填入');
      let lastParsed = '';
      const applyEntry = (entryB) => {
        const p = bibToPublication(entryB);
        const vals = {
          title: p.title, authors: p.authors, year: p.year == null ? '' : String(p.year), month: p.month == null ? '' : String(p.month),
          venue: p.venue, volume: p.volume, pages: p.pages, status: p.status, kind: p.kind, arxiv: p.arxiv, ads: p.ads, doi: p.doi, bibtex: p.bibtex,
        };
        f.set(vals);
        for (const k of Object.keys(vals)) f.setErr(k, null);
        suggestId();
        render(status, svgIcon('check'), ` 已填入：${p.title || '（没有标题）'}`, p.authors.length ? `（${p.authors.length} 位作者）` : '', '。请检查下面的内容。');
        status.className = 'ac-bib-status small text-success';
      };
      const doParse = () => {
        const txt = box.value;
        if (!txt.trim()) { render(status, ''); clear(pickHost); return; }
        if (txt === lastParsed) return;
        lastParsed = txt;
        const r = parseBibtex(txt);
        const usable = r.entries.filter((e) => e.fields && (e.fields.title || e.fields.author));
        clear(pickHost);
        if (!usable.length) {
          status.className = 'ac-bib-status small text-danger';
          render(status, svgIcon('warning'), r.errors.length ? ` 没能识别：第 ${r.errors[0].line} 行，${r.errors[0].message}` : ' 没有找到 BibTeX 条目（应该以 @ARTICLE{ 这样开头）');
          return;
        }
        if (usable.length > 1) {
          const sel = h('select', { class: 'input', dataset: { testid: 'pub-bibtex-pick' }, 'aria-label': '选择要添加的论文' },
            usable.map((e, i) => h('option', { value: String(i) }, `${i + 1}. ${bibToPublication(e).title || e.key}`)));
          sel.addEventListener('change', () => applyEntry(usable[Number(sel.value)]));
          render(pickHost, h('div', { class: 'field' }, h('label', {}, `这段 BibTeX 里有 ${usable.length} 篇，选择要添加的一篇（其余的可以再点「添加论文」逐篇添加）`), sel));
        }
        applyEntry(usable[0]);
        if (r.errors.length) status.append(h('span', { class: 'text-danger' }, `（另有 ${r.errors.length} 处没能识别，已跳过）`));
      };
      parseBtn.addEventListener('click', () => { lastParsed = ''; doParse(); });
      const auto = debounce(doParse, 350);
      box.addEventListener('input', auto);
      box.addEventListener('paste', () => setTimeout(doParse, 0));
      content = h('div', { class: 'stack' },
        h('div', { class: 'ac-bib-box' },
          h('label', { class: 'ac-bib-label', htmlFor: (box.id = uid('bib')) }, svgIcon('copy'), isNew ? '粘贴 BibTeX（从 ADS / arXiv 导出）' : '粘贴新的 BibTeX 更新上面的信息（可选）'),
          box, h('div', { class: 'row ac-bib-row' }, parseBtn, status), pickHost),
        f.el);
      for (const k of ['title', 'authors', 'year', 'ads', 'arxiv']) {
        if (f.inputs[k]) f.inputs[k].addEventListener('input', debounce(suggestId, 200));
      }
      // 输入框离开时整理格式
      const norm = (k, fn) => f.inputs[k] && f.inputs[k].addEventListener('blur', () => { f.inputs[k].value = fn(f.inputs[k].value); suggestId(); });
      norm('arxiv', normalizeArxiv);
      norm('doi', normalizeDoi);
      norm('ads', normalizeAdsBibcode);
    } else if (kind === 'talks') {
      for (const k of ['title', 'event', 'date']) if (f.inputs[k]) f.inputs[k].addEventListener('input', debounce(suggestId, 200));
      if (isNew) suggestId();
    }
    if (kind === 'publications' && isNew) suggestId();

    const title = `${isNew ? '添加' : '编辑'}${kind === 'publications' ? '论文' : kind === 'talks' ? '报告 / 海报' : '近况'}`;
    st.openForms++;
    const m = modal({
      title,
      testid,
      wide: kind !== 'news',
      content,
      onClose: () => { st.openForms--; },
      actions: [
        { text: '取消', kind: 'ghost', testid: `${testid}-cancel` },
        {
          text: isNew ? '保存并发布' : '保存修改', kind: 'primary', testid: `${testid}-save`,
          onClick: async (close) => {
            const ok = await saveEntry(kind, entry, f);
            if (ok) { close(); renderAll(); }
          },
        },
      ],
    });
    return m;
  }

  /** 校验 → 生成文件 → 一次提交。返回是否成功（成功后 st.entries 已更新）。 */
  async function saveEntry(kind, entry, f) {
    if (ctx.isPublishing && ctx.isPublishing()) { toast('正在发布，请稍候', { type: 'info' }); return false; }
    // 新 id 的校验在 validate 里；报告的 id 输入框是后加的
    const bad = f.validate();
    if (bad) {
      toast(`还有 ${bad} 处需要填写或改正`, { type: 'warning' });
      const el = f.el.querySelector('[aria-invalid="true"]');
      if (el) { el.scrollIntoView({ block: 'center', behavior: 'smooth' }); el.focus({ preventScroll: true }); }
      return false;
    }
    const v = f.get();
    const def = SECTIONS[kind];
    let id;
    if (entry) id = entry.id;
    else if (kind === 'news') id = newsIdFor(v, (st.entries.news || []).map((e) => e.id));
    else id = String(v.id || '').trim();
    const path = entry ? entry.path : `${def.dataDir}/${id}.yaml`;
    const values = { ...v };
    if (kind !== 'news') values.id = id;
    if (kind === 'publications') {
      values.arxiv = normalizeArxiv(values.arxiv);
      values.doi = normalizeDoi(values.doi);
      values.ads = normalizeAdsBibcode(values.ads);
    }
    let text;
    try {
      text = entryFileText(kind, values, entry ? entry.text : null);
    } catch (err) {
      toast(`没能生成文件，什么都没有改：${errorMessage(err)}`, { type: 'error', timeout: 9000 });
      return false;
    }
    const changes = [];
    if (!entry || text !== entry.text) changes.push({ path, content: text, baseSha: entry ? entry.sha : null });
    const pend = f.pending;
    if (pend && String(v[pend.field] || '').trim() === pend.sitePath) {
      changes.push({ path: pend.path, content: pend.blob, baseSha: pend.baseSha });
    }
    if (!changes.length) { toast('没有修改', { type: 'info' }); return true; }
    const name = ITEM_NAME[kind];
    const label = kind === 'news' ? `（${v.date}）` : `《${String(v.title).trim()}》`;
    let res;
    try {
      res = await ctx.publish({
        message: `admin: ${entry ? '修改' : '添加'}${name}${label}`,
        changes,
        summary: changes.map((c) => c.path),
        viewUrl: langSiteUrl(ctx.siteUrl, kind === 'news' && !entry ? '' : `${kind}/`, ctx.defaultLang, ctx.defaultLang),
        viewLabel: kind === 'news' ? '打开网站' : '打开页面',
      });
    } catch {
      return false;
    }
    if (st.disposed) return false;
    if (res && res.conflict) {
      if (res.reloaded) await afterConflict(kind, entry, f, path);
      return false;
    }
    const sha = (res && res.shas && res.shas[path]) || (repo.entry(path) || {}).sha || null;
    const data = parseYamlEntry(text);
    const next = { id, path, sha, text, data, values: formValues(kind, data) };
    const list = (st.entries[kind] || []).filter((e) => e.path !== path);
    list.push(next);
    st.entries[kind] = list;
    if (pend) f.pending = null;
    if (f.quick) {
      f.set({ ...blankValues('news') });
      f.touched.clear();
    }
    return true;
  }

  /** 冲突后（外壳已经 repo.load()）：重新读这一类记录；正在编辑的那条，用户没动过的字段换成最新内容。 */
  async function afterConflict(kind, entry, f, path) {
    try {
      st.entries[kind] = await loadSection(kind);
      st.params = await loadParams();
    } catch (err) {
      toast(`读取最新内容失败：${errorMessage(err)}`, { type: 'error' });
      return;
    }
    if (st.disposed) return;
    if (entry) {
      const fresh = st.entries[kind].find((e) => e.path === path);
      if (!fresh) {
        toast('这条记录刚刚在别处被删除了。再点一次保存会用你填的内容重新创建它', { type: 'warning', timeout: 9000 });
        entry.sha = null;
        entry.text = null;
      } else if (fresh.error) {
        toast(`这条记录刚刚在别处被改成了后台无法读取的格式：${fresh.error}`, { type: 'error', timeout: 9000 });
      } else {
        // 三方合并：用户没改过的字段 → 最新内容
        const cur = f.get();
        const upd = {};
        for (const k of Object.keys(fresh.values)) {
          if (sameVal(cur[k], f.base[k])) upd[k] = fresh.values[k];
        }
        f.set(upd);
        f.base = { ...fresh.values };
        entry.sha = fresh.sha;
        entry.text = fresh.text;
        entry.values = fresh.values;
        toast('这条记录刚刚在别处被修改过，已读取最新版本；你改过的地方还在。请检查后再点一次保存', { type: 'info', timeout: 9000 });
      }
    } else {
      f.validate();
      toast('网站上的内容刚刚变了，已读取最新版本。请检查后再点一次保存', { type: 'info', timeout: 8000 });
    }
    renderAll();
  }

  async function deleteEntry(kind, e) {
    if (ctx.isPublishing && ctx.isPublishing()) { toast('正在发布，请稍候', { type: 'info' }); return; }
    const v = e.values || {};
    const label = kind === 'news' ? (v.text || v.date || e.id) : (v.title || e.id);
    // 本后台上传的 PDF（static/documents/papers|talks/ 下）可以一起删除；别的记录也在用时不建议删
    const fileField = kind === 'publications' ? 'pdf' : kind === 'talks' ? 'slides' : null;
    let fileBox = null;
    let filePath = null;
    if (fileField && v[fileField] && SECTIONS[kind].uploadDir) {
      const sp = String(v[fileField]).trim();
      const staticPath = 'static' + sp;
      if (sp.startsWith('/') && staticPath.startsWith(SECTIONS[kind].uploadDir + '/') && repo.has(staticPath)) {
        const usedElsewhere = SECTION_KEYS.some((k) => (st.entries[k] || []).some((o) => o !== e && o.values &&
          ['pdf', 'slides'].some((ff) => String(o.values[ff] || '').trim() === sp)));
        filePath = staticPath;
        fileBox = h('input', { type: 'checkbox', checked: !usedElsewhere, dataset: { testid: 'academic-delete-file' } });
        fileBox = h('label', { class: 'checkbox' }, fileBox, ` 同时删除文件 ${sp.split('/').pop()}${usedElsewhere ? '（别的记录也在用它，建议保留）' : ''}`);
      }
    }
    const ok = await confirmDialog({
      title: `删除这条${ITEM_NAME[kind]}？`,
      message: h('div', { class: 'stack-sm' }, h('p', {}, `「${label}」会从网站上消失（GitHub 的历史记录里仍然能找回）。`), fileBox),
      okText: '删除',
      danger: true,
    });
    if (!ok || st.disposed) return;
    const changes = [{ path: e.path, delete: true, baseSha: e.sha }];
    if (fileBox && fileBox.querySelector('input').checked && filePath) {
      const fe = repo.entry(filePath);
      if (fe) changes.push({ path: filePath, delete: true, baseSha: fe.sha });
    }
    let res;
    try {
      res = await ctx.publish({
        message: `admin: 删除${ITEM_NAME[kind]}${kind === 'news' ? `（${v.date || e.id}）` : `《${label}》`}`,
        changes,
        summary: changes.map((c) => c.path),
      });
    } catch { return; }
    if (st.disposed) return;
    if (res && res.conflict) {
      if (res.reloaded) {
        try { st.entries[kind] = await loadSection(kind); } catch { /* 下面重新渲染 */ }
        toast('这条记录刚刚在别处被修改过，已读取最新版本，请确认后再删除', { type: 'info', timeout: 8000 });
        renderAll();
      }
      return;
    }
    st.entries[kind] = (st.entries[kind] || []).filter((x) => x.path !== e.path);
    renderAll();
  }

  return {
    unmount() {
      st.disposed = true;
      onFilePicked = null;
    },
  };
}

function sameVal(a, b) {
  if (Array.isArray(a) || Array.isArray(b)) {
    const x = Array.isArray(a) ? a : [];
    const y = Array.isArray(b) ? b : [];
    return x.length === y.length && x.every((v, i) => String(v) === String(y[i]));
  }
  if (typeof a === 'boolean' || typeof b === 'boolean') return !!a === !!b;
  return String(a ?? '') === String(b ?? '');
}

function deepSame(a, b) {
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => deepSame(x, b[i]));
  return a === b;
}
