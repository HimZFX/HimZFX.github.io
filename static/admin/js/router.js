/**
 * router.js — 极简 hash 路由（ADMIN_SPEC §4）。
 *
 * 地址形如 `#/<route>?<query>`（query 按 URL 编码）。每次只挂载一个视图：
 *   离开前调用旧视图的 canLeave()（返回 false 时留在原地，并把地址栏改回去）→ unmount() → 清空容器
 *   → 动态 import('./views/<name>.js') → mount(container, params, ctx)。
 *
 * 视图模块缺失或 mount 抛错时，由调用方提供的 renderError() 在容器里显示友好提示，绝不留白屏。
 *
 * @module router
 */

/**
 * 解析 hash。
 * @param {string} hash 例如 '#/edit?path=content%2Fposts%2Fa.md'
 * @returns {{ route: string, params: Record<string, string>, hash: string }}
 */
export function parseHash(hash) {
  let s = String(hash || '').replace(/^#/, '');
  if (s.startsWith('/')) s = s.slice(1);
  const q = s.indexOf('?');
  const routePart = q >= 0 ? s.slice(0, q) : s;
  const query = q >= 0 ? s.slice(q + 1) : '';
  const params = {};
  if (query) {
    for (const [k, v] of new URLSearchParams(query)) params[k] = v;
  }
  let route = '';
  try { route = decodeURIComponent(routePart).replace(/\/+$/, ''); } catch { route = routePart; }
  return { route, params, hash: '#/' + s };
}

/**
 * 生成 hash。
 * @param {string} route
 * @param {Record<string, string|number|boolean|undefined|null>} [params]
 */
export function buildHash(route, params = {}) {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {})) {
    if (v != null && v !== false) sp.set(k, String(v));
  }
  const q = sp.toString();
  return `#/${route}${q ? '?' + q : ''}`;
}

/** 规范化 hash 字符串，便于比较（'#/posts' 与 '#posts' 视为相同）。 */
function normalize(hash) {
  return parseHash(hash).hash;
}

/**
 * 创建路由器。
 * @param {object} opts
 * @param {Record<string, string>} opts.routes    路由名 → 视图模块名（views/<name>.js）
 * @param {string} opts.defaultRoute              未知 / 空路由时使用
 * @param {() => HTMLElement} opts.getContainer   放视图的元素（每次挂载前会被清空并放入新的 <div class="view">）
 * @param {(route: string, params: object) => object} opts.getCtx  传给视图的 ctx
 * @param {(info: { route: string, params: object, hash: string }) => (string|null|void)} [opts.resolve]
 *        可选的重定向钩子：返回一个 hash 则改为跳转到那里（用于未登录 → #/login）
 * @param {(info) => void} [opts.onRouteChange]   新视图开始挂载前调用（更新导航高亮等）
 * @param {(info) => void} [opts.onMounted]       视图挂载完成（或显示了错误）后调用
 * @param {(container: HTMLElement, err: any, info: object, retry: Function) => void} opts.renderError
 * @param {(container: HTMLElement, info: object) => void} [opts.renderLoading]
 * @param {(name: string) => Promise<any>} [opts.importView]  默认 import(`./views/${name}.js`)
 */
export function createRouter({
  routes, defaultRoute, getContainer, getCtx, resolve, onRouteChange, onMounted, renderError, renderLoading,
  importView = (name) => import(`./views/${name}.js`),
}) {
  let current = null;         // { route, params, hash, instance, container, seq }
  let seq = 0;
  let started = false;
  let navigating = false;
  let pendingHash = null;

  const onHashChange = () => { go(location.hash, { fromHashChange: true }); };

  /**
   * 跳转到某个 hash。
   * @param {string} hash
   * @param {{ replace?: boolean, force?: boolean, fromHashChange?: boolean, skipGuard?: boolean }} [opts]
   * @returns {Promise<boolean>} 是否真的切换了
   */
  async function go(hash, { replace = false, force = false, fromHashChange = false, skipGuard = false } = {}) {
    let info = parseHash(hash || '');
    // hasOwnProperty：'#/constructor'、'#/__proto__' 之类不能命中 Object.prototype
    if (!Object.prototype.hasOwnProperty.call(routes, info.route)) info = parseHash(buildHash(defaultRoute, {}));
    if (resolve) {
      const redirect = resolve(info);
      if (redirect && normalize(redirect) !== info.hash) {
        info = parseHash(redirect);
        replace = true;
      }
    }

    // 同一地址：不重复挂载（除非 force）
    if (current && current.hash === info.hash && !force) {
      syncUrl(info.hash, true);
      return false;
    }

    // 正在执行离开确认时又来了新的跳转：记下最后一个，确认结束后处理
    if (navigating) {
      pendingHash = { hash: info.hash, replace };
      return false;
    }

    if (current && !skipGuard) {
      navigating = true;
      let ok = true;
      try {
        ok = await canLeaveCurrent();
      } finally {
        navigating = false;
      }
      if (!ok) {
        // 留在原地：把地址栏改回当前视图（不新增历史记录、不触发 hashchange）
        syncUrl(current.hash, true);
        pendingHash = null;
        return false;
      }
      if (pendingHash) {
        const next = pendingHash;
        pendingHash = null;
        return go(next.hash, { replace: next.replace, skipGuard: true });
      }
    }

    if (!fromHashChange || normalize(location.hash) !== info.hash) syncUrl(info.hash, replace || fromHashChange);
    await mountRoute(info);
    return true;
  }

  function syncUrl(hash, replace) {
    if (normalize(location.hash) === hash && location.hash === hash) return;
    const url = location.pathname + location.search + hash;
    if (replace) history.replaceState(history.state, '', url);
    else history.pushState(null, '', url);
  }

  async function canLeaveCurrent() {
    const inst = current && current.instance;
    if (!inst || typeof inst.canLeave !== 'function') return true;
    try {
      return (await inst.canLeave()) !== false;
    } catch (err) {
      console.error('[router] canLeave failed', err);
      return true;
    }
  }

  function unmountCurrent() {
    if (!current) return;
    const { instance, container } = current;
    current = null;
    if (instance && typeof instance.unmount === 'function') {
      try { instance.unmount(); } catch (err) { console.error('[router] unmount failed', err); }
    }
    if (container) container.remove();
  }

  async function mountRoute(info) {
    unmountCurrent();
    const mySeq = ++seq;
    const host = getContainer();
    while (host.firstChild) host.removeChild(host.firstChild);
    const container = document.createElement('div');
    container.className = 'view';
    container.dataset.view = info.route;
    host.appendChild(container);
    current = { ...info, instance: null, container, seq: mySeq };
    try { onRouteChange && onRouteChange(info); } catch (err) { console.error(err); }

    const retry = () => go(info.hash, { force: true, replace: true, skipGuard: true });
    // 模块加载很快时不闪烁「加载中」
    const loadingTimer = renderLoading ? setTimeout(() => {
      if (current && current.seq === mySeq && !container.firstChild) renderLoading(container, info);
    }, 150) : null;

    let mod;
    try {
      mod = await importView(routes[info.route]);
    } catch (err) {
      clearTimeout(loadingTimer);
      if (!isCurrent(mySeq)) return;
      container.replaceChildren();
      renderError(container, Object.assign(new Error('视图模块加载失败'), { cause: err, kind: 'import' }), info, retry);
      finish(info, mySeq);
      return;
    }
    clearTimeout(loadingTimer);
    if (!isCurrent(mySeq)) return;
    // 视图拿到的必须是一个空容器（规范 §4）
    container.replaceChildren();
    const mount = mod && (mod.default || mod.mount);
    if (typeof mount !== 'function') {
      renderError(container, Object.assign(new Error('视图模块没有导出 mount()'), { kind: 'import' }), info, retry);
      finish(info, mySeq);
      return;
    }
    try {
      const ctx = getCtx(info.route, info.params);
      const instance = await mount(container, info.params, ctx);
      if (!isCurrent(mySeq)) {
        // 挂载期间用户已经去了别的页面：立即卸载这个迟到的视图
        if (instance && typeof instance.unmount === 'function') {
          try { instance.unmount(); } catch (err) { console.error(err); }
        }
        return;
      }
      current.instance = instance || null;
    } catch (err) {
      if (!isCurrent(mySeq)) return;
      console.error(`[router] mount "${info.route}" failed`, err);
      container.replaceChildren();
      renderError(container, Object.assign(err instanceof Error ? err : new Error(String(err)), { kind: err?.kind || 'mount' }), info, retry);
    }
    finish(info, mySeq);
  }

  function isCurrent(mySeq) {
    return current && current.seq === mySeq;
  }

  function finish(info, mySeq) {
    if (!isCurrent(mySeq)) return;
    try { onMounted && onMounted(info); } catch (err) { console.error(err); }
  }

  return {
    /** 开始监听 hashchange 并挂载当前地址。 */
    async start() {
      if (!started) {
        started = true;
        window.addEventListener('hashchange', onHashChange);
      }
      await go(location.hash, { replace: true, force: true, skipGuard: true });
    },
    /** 停止监听并卸载当前视图（不询问 canLeave）。 */
    stop() {
      started = false;
      window.removeEventListener('hashchange', onHashChange);
      unmountCurrent();
      seq++;
    },
    go,
    /** 重新挂载当前视图（不询问 canLeave）。 */
    reload() {
      return current ? go(current.hash, { force: true, replace: true, skipGuard: true }) : go(location.hash, { force: true, replace: true });
    },
    /** 询问当前视图是否可以离开（用于退出登录等）。 */
    canLeave: canLeaveCurrent,
    /** 当前视图是否有未保存的修改（beforeunload 用，必须同步）。 */
    isDirty() {
      const inst = current && current.instance;
      if (!inst || typeof inst.isDirty !== 'function') return false;
      try { return !!inst.isDirty(); } catch { return false; }
    },
    /** 当前路由信息 */
    get current() {
      return current ? { route: current.route, params: { ...current.params }, hash: current.hash } : null;
    },
  };
}
