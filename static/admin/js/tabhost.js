/**
 * tabhost.js — 分组导航项的标签页外壳（#/about、#/research、#/settings 用）。
 *
 * 一个路由下放几个标签页，每个标签页是一个普通的视图（export default mount(container, params, ctx)，
 * 返回 { unmount?, canLeave?, isDirty? }），例如「设置」下的 首页 / 背景动画 / 菜单与页面 就是原来的三个视图。
 *
 * - 标签栏 role="tablist"，← → Home End 切换（自动激活），选中的那个 tabindex=0；
 * - 切换标签页：先问当前标签页的 canLeave()（有没保存的修改会弹确认框，选「留下」就不切换）→ unmount →
 *   挂载新的那个；地址用 ctx.replaceHash 改成 #/<路由>?tab=<id>（不新增历史记录，外壳和侧栏不重新挂载）；
 * - 整个视图的 canLeave / isDirty / unmount 都转给当前标签页（离开整个分组时同样会提醒）；
 * - 标签页模块加载失败 / 挂载出错：在标签页里显示友好的错误和「重试」，不影响其他标签页；
 * - 标签页挂载完成后：外壳根元素 data-tab-ready=<id>，body 上 data-tab-ready=<路由>:<id>（测试等它）。
 *
 * 标签页的 ctx 和外壳的一样，只是 setTitle 不改顶栏标题（顶栏显示分组的名字，例如「设置」）。
 *
 * @module tabhost
 */

import { h, svgIcon, render, loadingState, errorMessage } from './ui.js';

/**
 * @param {HTMLElement} container
 * @param {Record<string,string>} params 路由参数（tab = 标签页 id；其余参数交给第一次挂载的标签页）
 * @param {object} ctx
 * @param {object} opts
 * @param {string} opts.route       路由名（地址 #/<route>?tab=…、testid 前缀 <route>-tab-<id>）
 * @param {string} opts.title       顶栏标题
 * @param {string} opts.label       标签栏的 aria-label
 * @param {Array<{ id: string, label: string, icon?: string, load?: () => Promise<any>, mount?: Function,
 *                 count?: () => (number|null), params?: object }>} opts.tabs
 */
export async function mountTabHost(container, params, ctx, { route, title, label, tabs }) {
  ctx.setTitle(title);
  const st = {
    tab: tabs.some((t) => t.id === params.tab) ? params.tab : tabs[0].id,
    instance: null,
    seq: 0,
    switching: false,
    disposed: false,
  };
  const subCtx = { ...ctx, setTitle: () => {} };
  const firstParams = { ...params };
  delete firstParams.tab;

  const btns = {};
  const tabBar = h('div', { class: 'tabs tabhost-tabs', role: 'tablist', 'aria-label': label, dataset: { testid: `${route}-tabs` } },
    tabs.map((t) => {
      const b = h('button', {
        type: 'button', class: 'tab', role: 'tab', id: `${route}-tab-${t.id}`, 'aria-controls': `${route}-panel`,
        dataset: { testid: `${route}-tab-${t.id}`, tab: t.id },
      },
        t.icon ? svgIcon(t.icon) : null,
        h('span', { class: 'tabhost-label' }, t.label),
        t.count ? h('span', { class: 'badge badge-gray tabhost-count', dataset: { testid: `${route}-count-${t.id}` } }) : null);
      b.addEventListener('click', () => select(t.id));
      btns[t.id] = b;
      return b;
    }));
  tabBar.addEventListener('keydown', (e) => {
    const ids = tabs.map((t) => t.id);
    const i = ids.indexOf(st.tab);
    let next = null;
    if (e.key === 'ArrowRight') next = ids[(i + 1) % ids.length];
    else if (e.key === 'ArrowLeft') next = ids[(i - 1 + ids.length) % ids.length];
    else if (e.key === 'Home') next = ids[0];
    else if (e.key === 'End') next = ids[ids.length - 1];
    if (!next) return;
    e.preventDefault();
    select(next, { focus: true });
  });
  const panel = h('div', { class: 'tabhost-panel', id: `${route}-panel`, role: 'tabpanel', tabindex: '-1' });
  const root = h('div', { class: 'tabhost stack', dataset: { testid: `${route}-view` } }, tabBar, panel);
  render(container, root);

  function paintTabs() {
    for (const t of tabs) {
      const b = btns[t.id];
      const on = t.id === st.tab;
      b.classList.toggle('active', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
      b.tabIndex = on ? 0 : -1;
      if (on) b.setAttribute('aria-current', 'page');
      else b.removeAttribute('aria-current');
    }
    panel.setAttribute('aria-labelledby', `${route}-tab-${st.tab}`);
    paintCounts();
  }

  function paintCounts() {
    for (const t of tabs) {
      if (!t.count) continue;
      const el = btns[t.id].querySelector('.tabhost-count');
      let n = null;
      try { n = t.count(); } catch { n = null; }
      el.textContent = n ? String(n) : '';
      el.hidden = !n;
    }
  }

  let changeTimer = null;
  const unsubscribe = ctx.repo && typeof ctx.repo.onChange === 'function'
    ? ctx.repo.onChange(() => { clearTimeout(changeTimer); changeTimer = setTimeout(() => { if (!st.disposed) paintCounts(); }, 0); })
    : () => {};

  function unmountCurrent() {
    const inst = st.instance;
    st.instance = null;
    if (inst && typeof inst.unmount === 'function') {
      try { inst.unmount(); } catch (err) { console.error('[tabhost] unmount failed', err); }
    }
  }

  async function mountTab(id, tabParams) {
    const mySeq = ++st.seq;
    unmountCurrent();
    delete root.dataset.tabReady;
    if (document.body.dataset.tabReady && document.body.dataset.tabReady.startsWith(route + ':')) delete document.body.dataset.tabReady;
    const def = tabs.find((t) => t.id === id);
    const inner = h('div', { class: 'tabhost-view', dataset: { tab: id } });
    render(panel, inner);
    const loadingTimer = setTimeout(() => { if (mySeq === st.seq && !inner.firstChild) inner.appendChild(loadingState('正在打开…')); }, 150);
    const retry = () => mountTab(id, {});
    const done = () => {
      clearTimeout(loadingTimer);
      if (mySeq !== st.seq || st.disposed) return;
      root.dataset.tabReady = id;
      document.body.dataset.tabReady = `${route}:${id}`;
    };
    let mount = def.mount;
    if (!mount) {
      try {
        const mod = await def.load();
        mount = mod && (mod.default || mod.mount);
        if (typeof mount !== 'function') throw new Error('视图模块没有导出 mount()');
      } catch (err) {
        if (mySeq !== st.seq || st.disposed) return;
        clearTimeout(loadingTimer);
        console.error(`[tabhost] loading tab "${id}" failed`, err);
        render(inner, errorCard('这个页面暂时打不开', `没能加载「${def.label}」模块。可能是功能还没上线，或者网络不稳定。`, retry));
        done();
        return;
      }
    }
    if (mySeq !== st.seq || st.disposed) return;
    try {
      inner.replaceChildren();
      const inst = await mount(inner, { ...(def.params || {}), ...(tabParams || {}) }, subCtx);
      if (mySeq !== st.seq || st.disposed) {
        if (inst && typeof inst.unmount === 'function') { try { inst.unmount(); } catch { /* ignore */ } }
        return;
      }
      st.instance = inst || null;
    } catch (err) {
      if (mySeq !== st.seq || st.disposed) return;
      console.error(`[tabhost] mount "${id}" failed`, err);
      render(inner, errorCard('页面加载出错', errorMessage(err), retry));
    }
    done();
  }

  async function select(id, { focus = false } = {}) {
    if (st.disposed || st.switching) return;
    if (id === st.tab) { if (focus) btns[id].focus(); return; }
    st.switching = true;
    try {
      const inst = st.instance;
      if (inst && typeof inst.canLeave === 'function') {
        let ok = true;
        try { ok = (await inst.canLeave()) !== false; } catch (err) { console.error('[tabhost] canLeave failed', err); }
        if (!ok || st.disposed) { btns[st.tab].focus(); return; }
      }
      st.tab = id;
      const hash = `#/${route}?tab=${encodeURIComponent(id)}`;
      if (typeof ctx.replaceHash === 'function') ctx.replaceHash(hash);
      else { try { history.replaceState(history.state, '', hash); } catch { /* ignore */ } }
      paintTabs();
      if (focus) btns[id].focus();
      await mountTab(id, {});
    } finally {
      st.switching = false;
    }
  }

  paintTabs();
  await mountTab(st.tab, firstParams);

  return {
    isDirty() {
      const inst = st.instance;
      return !!(inst && typeof inst.isDirty === 'function' && inst.isDirty());
    },
    async canLeave() {
      const inst = st.instance;
      if (!inst || typeof inst.canLeave !== 'function') return true;
      return (await inst.canLeave()) !== false;
    },
    unmount() {
      st.disposed = true;
      st.seq++;
      clearTimeout(changeTimer);
      unsubscribe();
      unmountCurrent();
      if (document.body.dataset.tabReady && document.body.dataset.tabReady.startsWith(route + ':')) delete document.body.dataset.tabReady;
    },
  };
}

function errorCard(title, detail, retry) {
  return h('div', { class: 'card view-error', dataset: { testid: 'view-error' } },
    h('div', { class: 'error-state' },
      h('div', { class: 'error-state-icon' }, svgIcon('warning')),
      h('div', { class: 'error-state-title' }, title),
      h('div', { class: 'error-state-detail muted' }, detail),
      h('div', { class: 'row error-state-actions' },
        h('button', { type: 'button', class: 'btn btn-primary', on: { click: retry } }, svgIcon('refresh'), '重试'))));
}

/**
 * 「关于我」「概览」标签页：一个页面的各语言版本（文件），每个一行：哪个版本、在哪些站点显示、标题、「编辑」「在网站上查看」。
 * @param {object} opts
 * @param {string} opts.groupKey 页面组 key（content.groupPages），如 'content/about'、'content/research/_index'
 * @param {string} opts.title    卡片标题
 * @param {string} opts.desc     说明
 * @param {string} opts.testid
 * @returns {(container, params, ctx) => Promise<object>}
 */
export function pageVersionsPanel({ groupKey, title, desc, testid }) {
  return async function mount(container, params, ctx) {
    const [{ groupPages, languageStatus, variantLabel, statusText, isDraftFm }, { readFrontMatters, pageUrl, editHash }] = await Promise.all([
      import('./content.js'), import('./views/posts.js'),
    ]);
    const langs = ctx.langs && ctx.langs.length ? ctx.langs : ['en', 'zh'];
    const host = h('section', { class: 'card tabhost-pages', dataset: { testid } });
    render(container, host);
    let disposed = false;
    async function load() {
      const group = groupPages(ctx.repo.list('content/'), langs).find((g) => g.key === groupKey);
      if (!group) {
        render(host, h('div', { class: 'card-header' }, h('h2', { class: 'card-title' }, svgIcon('page'), title)),
          h('p', { class: 'muted' }, '网站上还没有这个页面的文件。'));
        return;
      }
      const fms = await readFrontMatters(ctx.repo, Object.values(group.variants));
      if (disposed) return;
      const status = languageStatus(group, langs);
      const order = ['shared', ...langs];
      const keys = Object.keys(group.variants).sort((a, b) => order.indexOf(a) - order.indexOf(b));
      const rows = keys.map((key) => {
        const path = group.variants[key];
        const r = fms.get(path) || { fm: {} };
        const fm = r.fm || {};
        const shownOn = langs.filter((l) => status.perLang[l] === path);
        const pageTitle = [fm.title, fm.linkTitle].find((t) => typeof t === 'string' && t.trim()) || group.base;
        const views = shownOn.filter(() => !isDraftFm(fm)).map((l) => h('a', {
          class: 'btn btn-ghost btn-sm', href: pageUrl(group, l, fm, ctx), target: '_blank', rel: 'noopener noreferrer',
          dataset: { testid: 'page-version-view', lang: l }, title: `在${ctx.siteLabel(l)}查看（新标签页）`,
        }, svgIcon('external'), shownOn.length > 1 ? `在${ctx.siteLabel(l)}查看` : '在网站上查看'));
        return h('li', { class: 'list-item tabhost-version', dataset: { testid: 'page-version', path } },
          h('div', { class: 'list-item-main' },
            h('a', { class: 'list-item-title', href: editHash(path) }, pageTitle),
            h('div', { class: 'list-item-meta' },
              h('span', { class: 'badge badge-gray' }, variantLabel(key, ctx)),
              h('span', { class: 'muted small' }, shownOn.length ? `显示在：${shownOn.map((l) => ctx.siteLabel(l)).join('、')}` : '没有站点在用这个文件（每种语言都有专属版本）'),
              isDraftFm(fm) ? h('span', { class: 'badge badge-gray' }, '草稿') : null,
              r.error ? h('span', { class: 'badge badge-red', title: r.error }, '设置区有问题') : null,
              h('code', { class: 'mono small muted' }, path))),
          h('div', { class: 'list-item-actions' },
            h('a', { class: 'btn btn-sm', href: editHash(path), dataset: { testid: 'page-version-edit' } }, svgIcon('edit'), '编辑'),
            views));
      });
      render(host,
        h('div', { class: 'card-header' },
          h('h2', { class: 'card-title' }, svgIcon('page'), title),
          h('span', { class: 'badge badge-gray' }, statusText(status, ctx))),
        h('p', { class: 'muted small tabhost-desc' }, desc),
        h('ul', { class: 'list' }, rows));
    }
    render(host, loadingState('正在读取…'));
    await load();
    const unsubscribe = ctx.repo.onChange(() => { if (!disposed) load(); });
    return { unmount() { disposed = true; unsubscribe(); } };
  };
}
