/**
 * main.js — 管理后台入口（ADMIN_SPEC §4、§6.1）。
 *
 * 负责：登录状态、启动加载（令牌校验 → 读取仓库 → 读取语言配置）、整体布局（顶栏 / 左侧导航 /
 * 手机底部标签栏）、传给每个视图的 ctx（含 ctx.publish 的冲突处理）、部署进度指示器、
 * 全局错误与 401 处理、离开页面前的未保存提醒。
 *
 * 只静态导入 SHELL 自己的模块；其他模块（github / repo / drafts / smol-toml）在启动时动态导入，
 * 这样即使某个模块暂时出错，也能显示友好的错误页而不是白屏。
 *
 * @module main
 */

import { REPO, apiBase, STORAGE_KEYS, PATHS, SITE_LABELS, LANG_NAMES, VENDOR } from './config.js';
import {
  h, svgIcon, render, toast, modal, confirmDialog, showOverlay, errorMessage, loadingState, closeAllLayers, closeModals,
} from './ui.js';
import { createRouter } from './router.js';

// ---------------------------------------------------------------------------
// 常量

const ROUTES = {
  posts: 'posts',
  edit: 'editor',
  pages: 'pages',
  courses: 'courses',
  profile: 'profile',
  background: 'background',
  files: 'files',
  login: 'login',
};
const DEFAULT_ROUTE = 'posts';

const NAV = [
  { route: 'posts', label: '文章', short: '文章', icon: 'post', testid: 'nav-posts' },
  { route: 'pages', label: '页面', short: '页面', icon: 'page', testid: 'nav-pages' },
  { route: 'courses', label: '课程', short: '课程', icon: 'course', testid: 'nav-courses' },
  { route: 'profile', label: '首页设置', short: '首页', icon: 'home', testid: 'nav-profile' },
  { route: 'background', label: '背景动画', short: '背景', icon: 'background', testid: 'nav-background' },
  { route: 'files', label: '资料', short: '资料', icon: 'files', testid: 'nav-files' },
];

const ROUTE_TITLES = {
  posts: '文章',
  edit: '编辑',
  pages: '页面',
  courses: '课程',
  profile: '首页设置',
  background: '背景动画',
  files: '资料',
  login: '登录',
};

const APP_NAME = '主页管理';
const SITE_NAME = "HimZFX's Lab";
const SITE_URL = typeof location !== 'undefined' ? location.origin + '/' : 'https://himzfx.github.io/';

// ---------------------------------------------------------------------------
// 令牌存储（安全规则 §2.2）

function readToken() {
  try {
    return localStorage.getItem(STORAGE_KEYS.token) || sessionStorage.getItem(STORAGE_KEYS.token) || '';
  } catch {
    try { return sessionStorage.getItem(STORAGE_KEYS.token) || ''; } catch { return ''; }
  }
}

function tokenRemembered() {
  try { return !!localStorage.getItem(STORAGE_KEYS.token); } catch { return false; }
}

function storeToken(token, remember) {
  clearToken();
  try {
    (remember ? localStorage : sessionStorage).setItem(STORAGE_KEYS.token, token);
  } catch {
    // 存储不可用（隐私模式）：退回到 sessionStorage，再不行就只在内存里（刷新后需重新登录）
    try { sessionStorage.setItem(STORAGE_KEYS.token, token); } catch { /* ignore */ }
  }
}

function clearToken() {
  try { localStorage.removeItem(STORAGE_KEYS.token); } catch { /* ignore */ }
  try { sessionStorage.removeItem(STORAGE_KEYS.token); } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// 登录后要回到的地址：存在 sessionStorage，刷新登录页也不会丢（不含敏感信息）

const RETURN_KEY = 'admin.returnHash';

function getReturnHash() {
  try {
    const v = sessionStorage.getItem(RETURN_KEY);
    return v && /^#\/[a-z]/.test(v) && !v.startsWith('#/login') ? v : null;
  } catch { return null; }
}

function setReturnHash(hash) {
  try {
    if (hash && /^#\/[a-z]/.test(hash) && !hash.startsWith('#/login')) sessionStorage.setItem(RETURN_KEY, hash);
    else sessionStorage.removeItem(RETURN_KEY);
  } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// 状态

/** @type {null | { id: number, token: string, remember: boolean, client: any, repo: any, user: any, langs: string[], defaultLang: string, langNames: object, ready: boolean, deployWatch?: any }} */
let session = null;
let sessionSeq = 0;
let mods = null;            // 动态导入的模块
let loginNotice = null;     // 登录页顶部的提示（如「登录已过期」）
let publishing = false;
let expiring = false;
let ctxCache = null;

const appEl = () => document.getElementById('app');
let shell = null;           // 顶栏 / 导航等元素的引用
let viewHost = null;        // 路由器把视图放在这里

// ---------------------------------------------------------------------------
// 路由

const router = createRouter({
  routes: ROUTES,
  defaultRoute: DEFAULT_ROUTE,
  getContainer: () => viewHost,
  getCtx: (route) => (route === 'login' ? loginCtx() : appCtx()),
  resolve(info) {
    const authed = !!(session && session.ready);
    if (!authed) {
      if (info.route !== 'login') {
        setReturnHash(info.hash);
        return '#/login';
      }
      return null;
    }
    if (info.route === 'login') {
      const target = getReturnHash() || '#/' + DEFAULT_ROUTE;
      setReturnHash(null);
      return target;
    }
    return null;
  },
  onRouteChange(info) {
    // 旧页面的对话框（裁剪头像、删除确认、手机预览…）不能留在新页面上：
    // 手机上用「返回」手势离开页面时，点里面的按钮会对已经关掉的页面生效（头像丢失、照样删除文章）。
    // 关闭 = 点「取消」。「正在发布…」遮罩和「登录已失效」框不受影响。
    closeModals();
    document.body.dataset.route = info.route;
    delete document.body.dataset.viewReady;
    if (info.route !== 'login') {
      setTitle(ROUTE_TITLES[info.route] || '');
      updateNav(info);
      window.scrollTo(0, 0);
    } else {
      document.title = `登录 · ${APP_NAME}`;
    }
  },
  onMounted(info) {
    document.body.dataset.viewReady = info.route;
    if (info.route === 'login') {
      document.body.dataset.testid = 'login-ready';
    } else {
      // 第一个视图挂载完成 → 测试辅助函数等待的就绪标记
      document.body.dataset.testid = 'app-ready';
    }
  },
  renderLoading(container) {
    container.appendChild(h('div', { class: 'view-loading' }, loadingState('正在打开…')));
  },
  renderError(container, err, info, retry) {
    const status = err?.status ?? err?.cause?.status;
    if (status === 401 && session && session.ready) {
      handleAuthExpired();
      return;
    }
    const isImport = err?.kind === 'import';
    const moduleName = ROUTES[info.route];
    const title = isImport ? '这个页面暂时打不开' : '页面加载出错';
    const detail = isImport
      ? `没能加载「${ROUTE_TITLES[info.route] || info.route}」模块（views/${moduleName}.js）。可能是功能还没上线，或者网络不稳定。`
      : errorMessage(err);
    render(container,
      h('div', { class: 'card view-error', dataset: { testid: 'view-error' } },
        h('div', { class: 'error-state' },
          h('div', { class: 'error-state-icon' }, svgIcon('warning')),
          h('div', { class: 'error-state-title' }, title),
          h('div', { class: 'error-state-detail muted' }, detail),
          h('div', { class: 'row error-state-actions' },
            h('button', { type: 'button', class: 'btn btn-primary', on: { click: retry } }, svgIcon('refresh'), '重试'),
            info.route !== DEFAULT_ROUTE && info.route !== 'login'
              ? h('a', { class: 'btn', href: '#/' + DEFAULT_ROUTE }, '返回文章列表')
              : null))));
  },
});

// ---------------------------------------------------------------------------
// 启动

async function boot() {
  // 防点击劫持：GitHub Pages 不能发送 X-Frame-Options，CSP 的 frame-ancestors 写在 <meta> 里也无效，
  // 所以被别的网页用 iframe 嵌入时，什么都不加载（不读令牌、不显示界面）。
  if (isFramed()) {
    showFramedNotice();
    return;
  }
  installGlobalHandlers();
  const token = readToken();
  if (!token) {
    await showLogin();
    return;
  }
  await startSession(token, { remember: tokenRemembered(), fromLogin: false });
}

function isFramed() {
  try { return window.top !== window.self; } catch { return true; }
}

function showFramedNotice() {
  const app = appEl();
  if (!app) return;
  document.body.dataset.layout = 'boot';
  document.body.dataset.testid = 'framed';
  render(app,
    h('div', { class: 'boot' },
      h('div', { class: 'card boot-card' },
        h('div', { class: 'error-state', role: 'alert' },
          h('div', { class: 'error-state-icon' }, svgIcon('warning')),
          h('div', { class: 'error-state-title' }, '请直接打开管理后台'),
          h('div', { class: 'error-state-detail muted' }, '为了安全，管理后台不能放在其他网页里使用。请点下面的按钮，在新的标签页里打开。'),
          h('div', { class: 'row error-state-actions' },
            h('a', {
              class: 'btn btn-primary', href: location.origin + location.pathname, target: '_blank', rel: 'noopener noreferrer',
              dataset: { testid: 'framed-open' },
            }, svgIcon('external'), '在新标签页打开管理后台'))))));
}

/**
 * 动态导入其他模块（失败时抛出友好错误）。
 */
async function loadModules() {
  if (mods) return mods;
  try {
    const [github, repo, drafts, toml] = await Promise.all([
      import('./github.js'),
      import('./repo.js'),
      import('./drafts.js').catch((err) => { console.warn('[main] drafts.js unavailable', err); return null; }),
      import(VENDOR + 'smol-toml/index.js').catch((err) => { console.warn('[main] smol-toml unavailable', err); return null; }),
    ]);
    mods = { github, repo, drafts, toml };
    return mods;
  } catch (err) {
    console.error('[main] failed to load core modules', err);
    const e = new Error('管理后台的核心文件加载失败，请刷新页面重试');
    e.cause = err;
    e.kind = 'modules';
    throw e;
  }
}

/**
 * 校验令牌：读取用户信息和仓库权限。
 * @returns {Promise<{ client, user, repoInfo }>}
 */
async function connect(token, id) {
  const { github } = await loadModules();
  const client = new github.GitHubClient({
    token,
    owner: REPO.owner,
    repo: REPO.repo,
    branch: REPO.branch,
    apiBase: apiBase(),
    fetch: guardedFetch(id),
  });
  const [user, repoInfo] = await Promise.all([client.getUser(), client.getRepo()]);
  if (!repoInfo || !repoInfo.permissions || !repoInfo.permissions.push) {
    const e = new Error('这个令牌没有写入权限。请在 GitHub 的令牌设置里，把 Contents 权限设为「Read and write」。');
    e.kind = 'permission';
    throw e;
  }
  // permissions.push 只说明「账号」有写权限（仓库主人永远有），不代表这个细粒度令牌有：
  // 只读令牌、没选这个仓库的令牌（公开仓库照样能读）也会通过上面的检查。实际试一次写入。
  if (typeof client.checkWriteAccess === 'function' && (await client.checkWriteAccess()) === false) {
    const e = new Error(`这个令牌没有写入权限。请在 GitHub 的令牌设置里确认：Repository access 选了 ${REPO.owner}/${REPO.repo}，并且 Contents 权限是「Read and write」（改完权限后令牌不用重新生成）。`);
    e.kind = 'permission';
    throw e;
  }
  return { client, user, repoInfo };
}

/**
 * 包装 fetch：会话进行中任何 API 请求返回 401（令牌被撤销或过期）→ 回到登录页。
 * 只观察状态码，不读取也不记录任何请求内容。
 */
function guardedFetch(id) {
  const base = globalThis.fetch.bind(globalThis);
  return async (input, init) => {
    const res = await base(input, init);
    if (res.status === 401 && session && session.id === id && session.ready) {
      queueMicrotask(handleAuthExpired);
    }
    return res;
  };
}

/** 把登录 / 启动时的错误翻译成具体可操作的中文提示。 */
function friendlyConnectError(err) {
  if (!err) return '登录失败，请重试';
  if (err.kind === 'permission' || err.kind === 'modules') return err.message;
  switch (err.status) {
    case 401:
      return '令牌不正确或已过期。请确认完整复制了令牌（通常以 github_pat_ 开头），然后重试。';
    case 404:
      return `找不到仓库 ${REPO.owner}/${REPO.repo}。请确认创建令牌时，在 Repository access 里选择了这个仓库。`;
    case 403:
      return err.message || '令牌没有足够的权限（需要本仓库的 Contents 读写权限）';
    case 0:
      return '网络错误，无法连接 GitHub。请检查网络后重试。';
    default:
      return errorMessage(err);
  }
}

/**
 * 用令牌开始一个会话：校验 → 保存令牌 → 读取网站内容 → 进入后台。
 * fromLogin 时校验错误直接抛给登录页显示；其余错误显示在启动页上。
 */
async function startSession(token, { remember, fromLogin }) {
  const id = ++sessionSeq;
  if (!fromLogin) showBootScreen('正在连接 GitHub…');

  let conn;
  try {
    conn = await connect(token, id);
  } catch (err) {
    if (id !== sessionSeq) return;
    if (fromLogin) throw new Error(friendlyConnectError(err));
    if (err.status === 401 || err.status === 404 || err.kind === 'permission') {
      // 存着的令牌已经不能用了：删掉，回到登录页并说明原因
      clearToken();
      await showLogin({
        notice: err.status === 401 ? '登录已过期或令牌已失效，请重新输入令牌。' : friendlyConnectError(err),
      });
      return;
    }
    showBootError(friendlyConnectError(err), () => startSession(token, { remember, fromLogin: false }));
    return;
  }
  if (id !== sessionSeq) return;

  storeToken(token, remember);
  if (fromLogin) {
    // 让登录按钮的「忙碌」状态先结束，再切换到加载页
    setTimeout(() => loadSite(id, token, conn, remember), 0);
    return;
  }
  await loadSite(id, token, conn, remember);
}

/** 读取仓库文件树和语言配置，然后显示后台界面。 */
async function loadSite(id, token, { client, user }, remember = tokenRemembered()) {
  if (id !== sessionSeq) return;
  router.stop();
  showBootScreen('正在读取网站内容…');
  try {
    const { repo: repoMod, drafts } = await loadModules();
    let blobCache;
    try { blobCache = drafts && drafts.idbBlobCache ? drafts.idbBlobCache() : undefined; } catch { blobCache = undefined; }
    const repo = new repoMod.Repo(client, { blobCache });
    await repo.load();
    if (id !== sessionSeq) return;
    const langInfo = await readLanguages(repo);
    if (id !== sessionSeq) return;
    session = {
      id, token, remember: !!remember, client, repo, user,
      langs: langInfo.langs,
      defaultLang: langInfo.defaultLang,
      langNames: langInfo.names,
      ready: true,
    };
    ctxCache = null;
    expiring = false;
    loginNotice = null;
    renderShell();
    await router.start();
  } catch (err) {
    if (id !== sessionSeq) return;
    console.error('[main] loading the site failed', err);
    if (err && err.status === 401) {
      clearToken();
      await showLogin({ notice: '登录已过期或令牌已失效，请重新输入令牌。' });
      return;
    }
    showBootError(friendlyConnectError(err), () => loadSite(id, token, { client, user }, remember));
  }
}

/**
 * 读取语言列表与默认语言（失败时回退到 ['zh', 'en'] / 'zh'）。
 * @returns {Promise<{ langs: string[], defaultLang: string, names: Record<string, string> }>}
 */
async function readLanguages(repo) {
  let langs = ['zh', 'en'];
  let defaultLang = 'zh';
  const names = {};
  const toml = mods && mods.toml;
  if (!toml || typeof toml.parse !== 'function') return { langs, defaultLang, names };
  try {
    if (repo.has(PATHS.languages)) {
      const obj = toml.parse(await repo.readText(PATHS.languages));
      const tables = Object.entries(obj || {})
        .filter(([, v]) => v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date))
        .map(([k, v], i) => ({ k, i, w: Number.isFinite(Number(v.weight)) && v.weight !== '' ? Number(v.weight) : Infinity, name: v.languageName }));
      tables.sort((a, b) => (a.w - b.w) || (a.i - b.i));
      if (tables.length) {
        langs = tables.map((t) => t.k);
        for (const t of tables) if (typeof t.name === 'string') names[t.k] = t.name;
      }
    }
  } catch (err) {
    console.warn('[main] could not read languages.toml', err);
  }
  try {
    if (repo.has(PATHS.hugo)) {
      const obj = toml.parse(await repo.readText(PATHS.hugo));
      if (obj && typeof obj.defaultContentLanguage === 'string' && obj.defaultContentLanguage) {
        defaultLang = obj.defaultContentLanguage;
      }
    }
  } catch (err) {
    console.warn('[main] could not read hugo.toml', err);
  }
  if (!langs.includes(defaultLang)) defaultLang = langs[0];
  return { langs, defaultLang, names };
}

// ---------------------------------------------------------------------------
// 登录 / 退出 / 过期

async function showLogin({ notice = null } = {}) {
  router.stop();
  closeAllLayers();
  endSession();
  loginNotice = notice;
  renderLoginLayout();
  await router.start();
}

function endSession() {
  sessionSeq++;
  if (session && session.deployWatch) {
    try { session.deployWatch.stop(); } catch { /* ignore */ }
  }
  session = null;
  ctxCache = null;
  shell = null;
}

function loginCtx() {
  return {
    notice: loginNotice,
    // 默认不记住：记住的令牌在 localStorage 里，整个 himzfx.github.io 共用，
    // 网站页面上加载的第三方脚本（KaTeX、giscus）理论上也能读到。
    remember: false,
    repoName: `${REPO.owner}/${REPO.repo}`,
    siteUrl: SITE_URL,
    /**
     * 登录。成功时 resolve（随后整个页面切换到后台）；失败时 reject，message 是中文提示。
     * @param {string} token
     * @param {boolean} remember
     */
    async login(token, remember) {
      token = String(token || '').trim();
      if (!token) throw new Error('请先粘贴令牌');
      if (/\s/.test(token)) throw new Error('令牌里不应该有空格或换行，请重新复制');
      await startSession(token, { remember: !!remember, fromLogin: true });
    },
  };
}

/**
 * 任何时候 API 返回 401（或在其他标签页退出了登录）：清除令牌，然后
 * - 当前页面有未发布的修改（或正在发布）：页面保持不动，弹出「登录已失效」框，粘贴新令牌后原地继续，
 *   修改一点都不会丢（首页设置、背景动画、菜单顺序这些页面没有本机草稿）；
 * - 否则：卸载当前视图 → 登录页，登录后回到原来的页面。
 * @param {{ reason?: 'expired' | 'other-tab' }} [opts]
 */
function handleAuthExpired({ reason = 'expired' } = {}) {
  if (expiring || !session || !session.ready) return;
  expiring = true;
  clearToken();
  if (reason === 'other-tab') {
    // 这个标签页里的令牌也必须立刻失效
    try { session.client.setToken(''); } catch { /* ignore */ }
  }
  if (publishing || router.isDirty()) {
    showReauthModal(reason);
    return;
  }
  const here = router.current;
  if (here && here.route !== 'login') setReturnHash(here.hash);
  const notice = reason === 'other-tab'
    ? '已在其他标签页退出登录。'
    : '登录已失效（令牌无效、被撤销或已过期），请重新输入令牌。本机自动保存的修改（文章草稿、首页设置、背景动画）不会丢失，重新登录后可以继续。';
  showLogin({ notice }).finally(() => { expiring = false; });
}

let reauthSeq = 0;

/** 「登录已失效」框：不卸载当前页面，粘贴新令牌后把它换进现有的 GitHubClient。 */
function showReauthModal(reason) {
  const s = session;
  const inputId = `reauth-token-${++reauthSeq}`;
  const input = h('input', {
    class: 'input login-token-input', id: inputId, type: 'password', autocomplete: 'off', autocapitalize: 'off',
    spellcheck: 'false', placeholder: 'github_pat_…', 'data-autofocus': true, dataset: { testid: 'reauth-token' },
  });
  const remember = h('input', { type: 'checkbox', checked: !!s.remember, dataset: { testid: 'reauth-remember' } });
  const error = h('div', { class: 'error login-error', role: 'alert', dataset: { testid: 'reauth-error' } });
  error.hidden = true;
  const showErr = (msg) => {
    error.textContent = msg || '';
    error.hidden = !msg;
    input.setAttribute('aria-invalid', msg ? 'true' : 'false');
  };
  input.addEventListener('input', () => { if (!error.hidden) showErr(''); });

  const submit = async (close) => {
    if (session !== s) { close(); return; }
    const token = input.value.trim();
    if (!token) { showErr('请先粘贴令牌'); input.focus(); return; }
    if (/\s/.test(token)) { showErr('令牌里不应该有空格或换行，请重新复制'); input.focus(); return; }
    try {
      await connect(token, -1);   // -1：校验期间的 401 不触发会话的过期处理
    } catch (err) {
      if (session === s) { showErr(friendlyConnectError(err)); input.focus(); }
      return;
    }
    if (session !== s) { close(); return; }
    s.client.setToken(token);
    s.token = token;
    s.remember = remember.checked;
    storeToken(token, s.remember);
    input.value = '';
    expiring = false;
    close();
    toast('已重新登录，可以继续了。刚才没发布成功的修改还在，请再点一次发布。', { type: 'success', timeout: 7000 });
  };

  const intro = reason === 'other-tab'
    ? '你已在其他标签页退出了登录。'
    : '令牌无效、被撤销或已经过期（GitHub 的令牌默认 30 天到期）。';
  const m = modal({
    title: '登录已失效',
    testid: 'reauth',
    dismissible: false,
    sticky: true,
    content: h('div', { class: 'stack reauth-body' },
      h('p', { class: 'modal-message' }, intro, '这一页上还没发布的修改都还在，没有丢失。粘贴一个新的令牌就能接着用，然后再点一次发布。'),
      h('p', { class: 'muted' }, '令牌过期了：到 GitHub 的令牌页面点「Regenerate token」（或新建一个），复制后粘贴到这里。'),
      h('div', { class: 'field' },
        h('label', { htmlFor: inputId }, '新的令牌'),
        input),
      h('label', { class: 'checkbox' }, remember, h('span', {}, '在此设备上记住')),
      error),
    actions: [
      {
        text: '退出登录', kind: 'ghost', testid: 'reauth-logout',
        onClick: async (close) => {
          if (session !== s) { close(); return; }
          // 有未发布的修改时，视图会问「放弃修改？」
          if (!(await router.canLeave())) return;
          close();
          setReturnHash(null);
          broadcastLogout();
          await showLogin();
          expiring = false;
        },
      },
      { text: '继续', kind: 'primary', testid: 'reauth-submit', onClick: submit },
    ],
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing) {
      e.preventDefault();
      m.footer.querySelector('[data-testid="reauth-submit"]')?.click();
    }
  });
}

// 多个标签页：在一个标签页里退出登录，其他标签页也立刻失去令牌（不传递令牌本身）。
let sessionChannel = null;

function setupSessionChannel() {
  if (sessionChannel || typeof BroadcastChannel !== 'function') return;
  try {
    sessionChannel = new BroadcastChannel('admin.session');
  } catch {
    sessionChannel = null;
    return;
  }
  sessionChannel.addEventListener('message', (e) => {
    if (e.data && e.data.type === 'logout' && session && session.ready) handleAuthExpired({ reason: 'other-tab' });
  });
}

function broadcastLogout() {
  try { if (sessionChannel) sessionChannel.postMessage({ type: 'logout' }); } catch { /* ignore */ }
}

async function logout() {
  if (publishing) {
    toast('正在发布，请稍候再退出', { type: 'warning' });
    return;
  }
  if (router.isDirty()) {
    // 视图自己会询问「放弃未保存的修改？」
    if (!(await router.canLeave())) return;
  } else {
    const ok = await confirmDialog({
      title: '退出登录？',
      message: '令牌会从这个浏览器中删除，下次需要重新粘贴令牌才能登录。本机自动保存的草稿会保留。',
      okText: '退出登录',
    });
    if (!ok) return;
    if (!(await router.canLeave())) return;
  }
  clearToken();
  setReturnHash(null);
  broadcastLogout();
  await showLogin();
  toast('已退出登录', { type: 'success' });
}

// ---------------------------------------------------------------------------
// ctx

function appCtx() {
  if (ctxCache) return ctxCache;
  const s = session;
  const names = s.langNames || {};
  ctxCache = {
    client: s.client,
    repo: s.repo,
    user: s.user,
    langs: [...s.langs],
    defaultLang: s.defaultLang,
    siteLabel: (lang) => SITE_LABELS[lang] || `${names[lang] || lang} 站`,
    langName: (lang) => LANG_NAMES[lang] || names[lang] || lang,
    siteUrl: SITE_URL,
    /**
     * 跳转。navigate('#/edit?path=…')；opts.replace = true 时不新增历史记录。
     * 跳到当前地址时重新挂载当前视图。
     */
    navigate: (hash, opts = {}) => {
      const target = String(hash || '').startsWith('#') ? String(hash) : '#' + String(hash || '');
      return router.go(target, { replace: !!opts.replace, force: true });
    },
    setTitle,
    publish,
    /** （扩展）当前是否正在发布。 */
    isPublishing: () => publishing,
  };
  return ctxCache;
}

function setTitle(text) {
  const t = String(text ?? '');
  if (shell && shell.title) shell.title.textContent = t;
  document.title = t ? `${t} · ${APP_NAME}` : `${APP_NAME} · ${SITE_NAME}`;
}

const PHASE_TEXT = {
  prepare: '正在准备文件…',
  check: '正在检查网站上的最新版本…',
  commit: '正在提交…',
  done: '发布完成',
};

/**
 * 网站上的页面地址（只接受本网站的 http(s) 地址），用于「已上线 ✓」和提示里的链接。
 * @returns {string|null}
 */
function siteLink(url) {
  if (!url) return null;
  try {
    const u = new URL(String(url), SITE_URL);
    if ((u.protocol !== 'https:' && u.protocol !== 'http:') || u.origin !== new URL(SITE_URL).origin) return null;
    return u.href;
  } catch {
    return null;
  }
}

/**
 * 视图提交修改的唯一入口（§4 ctx.publish）。
 * @param {{ message: string, changes: Array<object>, summary?: string|string[], viewUrl?: string, viewLabel?: string }} opts
 *        viewUrl / viewLabel（扩展，可选）：发布的内容在网站上的地址（例如文章页）和链接文字（默认「打开看看」）。
 *        部署完成后「已上线 ✓」指向这里，提示里也会带上这个链接；不传时指向网站首页。
 * @returns {Promise<{ commitSha: string, shas: Record<string,string>, unchanged?: boolean, alreadyApplied?: boolean } | { conflict: true, reloaded: boolean, paths: string[] }>}
 *        alreadyApplied：这些修改其实已经在网站上了（上一次发布成功了，只是没收到 GitHub 的回复）。
 */
async function publish({ message, changes, summary, viewUrl, viewLabel } = {}) {
  const s = session;
  if (!s || !s.ready) throw new Error('还没有登录');
  if (publishing) {
    const e = new Error('上一次发布还没有完成，请稍候');
    toast(e.message, { type: 'warning' });
    throw e;
  }
  publishing = true;
  const summaryText = Array.isArray(summary) ? summary.filter(Boolean).join('\n') : (summary || '');
  const overlay = showOverlay('正在发布…');
  if (summaryText) overlay.update(null, summaryText);
  let result;
  try {
    result = await s.repo.commit({
      message,
      changes,
      onProgress: (p) => {
        if (!p) return;
        if (p.phase === 'upload') {
          overlay.update(p.total > 1 ? `正在上传文件（${Math.min(p.done ?? 0, p.total)}/${p.total}）…` : '正在上传文件…');
        } else if (PHASE_TEXT[p.phase]) {
          overlay.update(PHASE_TEXT[p.phase]);
        }
      },
    });
  } catch (err) {
    overlay.close();
    publishing = false;
    if (err && (err.name === 'ConflictError' || (mods && err instanceof mods.repo.ConflictError))) {
      return conflictDialog(err);
    }
    if (err && err.status === 401) {
      handleAuthExpired();
      throw err;
    }
    if (err && err.uncertain) {
      // 「移动分支」的回复丢了：可能已经发布成功。再点一次发布是安全的（不会重复发布）。
      console.warn('[publish] outcome unknown', err);
      toast(err.message, { type: 'warning', timeout: 15000 });
      throw err;
    }
    console.error('[publish] failed', err);
    toast(`发布失败：${errorMessage(err)}`, { type: 'error', timeout: 9000 });
    throw err;
  }
  overlay.close();
  publishing = false;
  const view = { url: siteLink(viewUrl), label: String(viewLabel || '打开看看') };
  if (result.alreadyApplied) {
    toast('这些修改其实已经发布成功了（上一次只是没收到 GitHub 的回复），不会重复发布。', { type: 'success', timeout: 7000 });
    startDeployWatch(result.commitSha, view);
    return { commitSha: result.commitSha, shas: result.shas || {}, alreadyApplied: true };
  }
  if (result.unchanged) {
    toast('内容和网站上的一样，不需要发布', { type: 'info' });
    return { commitSha: result.commitSha, shas: result.shas || {}, unchanged: true };
  }
  toast(view.url ? '已发布，正在部署…约 1–2 分钟后就能在网站上看到' : '已发布，正在部署…', { type: 'success', timeout: view.url ? 5000 : undefined });
  startDeployWatch(result.commitSha, view);
  return { commitSha: result.commitSha, shas: result.shas || {} };
}

/** 冲突：列出文件，让用户选择重新加载最新版本或取消。 */
function conflictDialog(err) {
  const paths = Array.isArray(err.paths) ? err.paths : [];
  return new Promise((resolve) => {
    let reloaded = false;
    modal({
      title: '有文件在你编辑期间被修改了',
      content: h('div', { class: 'stack conflict-body' },
        h('p', {}, '这些文件在你编辑期间被修改了（可能是在另一台设备、另一个标签页或 GitHub 网页上）。为了不覆盖那些修改，这次没有发布。'),
        paths.length ? h('ul', { class: 'conflict-list' }, paths.map((p) => h('li', {}, h('code', {}, p)))) : null,
        h('p', { class: 'muted' }, '点「重新加载最新版本」读取网站上的最新内容；文章编辑器里未发布的修改会保存在本机草稿中。')),
      actions: [
        { text: '取消', kind: 'ghost', testid: 'conflict-cancel' },
        {
          text: '重新加载最新版本',
          kind: 'primary',
          testid: 'conflict-reload',
          autofocus: true,
          onClick: async (close) => {
            await session.repo.load();
            reloaded = true;
            close();
          },
        },
      ],
      onClose: () => resolve({ conflict: true, reloaded, paths }),
    });
  });
}

// ---------------------------------------------------------------------------
// 部署指示器

const DEPLOY_STATES = {
  pending: { text: '部署中…', short: '部署中', cls: 'is-running', title: '网站正在重新生成，通常需要 1–2 分钟（点击查看进度）' },
  running: { text: '部署中…', short: '部署中', cls: 'is-running', title: '网站正在重新生成，通常需要 1–2 分钟（点击查看进度）' },
  success: { text: '已上线 ✓', short: '已上线 ✓', cls: 'is-success', icon: 'globe', title: '修改已经生效（点击打开网站；如果还看到旧内容，请刷新一下页面）' },
  failure: { text: '部署失败', short: '失败', cls: 'is-failure', icon: 'warning', title: '网站生成失败，点击查看 GitHub Actions 的详细信息' },
  unknown: { text: '已提交，约 1–2 分钟后生效', short: '已提交', cls: 'is-unknown', icon: 'clock', title: '已提交到 GitHub，约 1–2 分钟后生效（令牌没有 Actions 权限时无法显示进度）' },
};
let deployHideTimer = null;
/** 最近一次发布的内容在网站上的地址：{ url, label } | null（没有时「已上线 ✓」指向首页）。 */
let deployView = null;
/** 最近一次发布的提交（「已上线 ✓」的链接带上 ?v=<提交前 7 位>，避开浏览器缓存的旧页面）。 */
let deployCommit = '';

/** 给网站地址加上 ?v=<提交>：GitHub Pages 的页面会被浏览器缓存约 10 分钟，换个地址就能看到新内容。 */
function withVersion(url, commitSha) {
  const v = String(commitSha || '').slice(0, 7);
  if (!v || !/^[0-9a-f]+$/i.test(v)) return url;
  try {
    const u = new URL(url);
    u.searchParams.set('v', v);
    return u.href;
  } catch {
    return url;
  }
}

function startDeployWatch(commitSha, view = {}) {
  const s = session;
  if (!s) return;
  if (s.deployWatch) {
    try { s.deployWatch.stop(); } catch { /* ignore */ }
  }
  deployView = view && view.url ? view : null;
  deployCommit = String(commitSha || '');
  setDeployState('pending', null);
  try {
    s.deployWatch = s.repo.watchDeploy(commitSha, ({ state, url }) => {
      if (session !== s) return;
      setDeployState(state, url);
      if (state === 'success') {
        toast('网站已更新，修改已上线 ✓', {
          type: 'success',
          timeout: deployView ? 9000 : undefined,
          link: deployView ? { text: `${deployView.label} ↗`, href: withVersion(deployView.url, deployCommit) } : undefined,
        });
      }
      if (state === 'failure') toast('网站部署失败，点击右上角「部署失败」查看原因', { type: 'error', timeout: 10000 });
    });
  } catch (err) {
    console.warn('[deploy] watch failed', err);
    setDeployState('unknown', null);
  }
}

function setDeployState(state, url) {
  if (!shell || !shell.deploy) return;
  const el = shell.deploy;
  const info = DEPLOY_STATES[state] || DEPLOY_STATES.unknown;
  clearTimeout(deployHideTimer);
  const href = state === 'success'
    ? withVersion((deployView && deployView.url) || SITE_URL, deployCommit)
    : (url || `https://github.com/${REPO.owner}/${REPO.repo}/actions`);
  el.hidden = false;
  el.dataset.state = state;
  el.className = `deploy-indicator ${info.cls}`;
  el.href = href;
  const title = state === 'success' && deployView ? '修改已经生效（点击打开刚发布的页面；如果还看到旧内容，请刷新一下）' : info.title;
  el.title = title;
  el.setAttribute('aria-label', `${info.text}。${title}`);
  render(el,
    info.icon ? svgIcon(info.icon) : h('span', { class: 'spinner spinner-sm', 'aria-hidden': 'true' }),
    h('span', { class: 'deploy-text' }, info.text),
    h('span', { class: 'deploy-text-short' }, info.short));
  if (state === 'success' || state === 'unknown') {
    // 结果显示一段时间后自动收起
    deployHideTimer = setTimeout(() => {
      if (shell && shell.deploy === el && el.dataset.state === state) {
        el.hidden = true;
        el.dataset.state = 'idle';
      }
    }, 10 * 60 * 1000);
  }
}

// ---------------------------------------------------------------------------
// 布局

function logoMark() {
  return h('span', { class: 'brand-mark', 'aria-hidden': 'true' }, 'H');
}

function showBootScreen(text) {
  const app = appEl();
  if (!app) return;
  shell = null;
  viewHost = null;
  document.body.dataset.layout = 'boot';
  render(app,
    h('div', { class: 'boot', role: 'status', 'aria-live': 'polite', dataset: { testid: 'boot' } },
      logoMark(),
      h('span', { class: 'spinner spinner-lg' }),
      h('div', { class: 'boot-text' }, text)));
}

function showBootError(message, retry) {
  const app = appEl();
  if (!app) return;
  shell = null;
  viewHost = null;
  document.body.dataset.layout = 'boot';
  document.body.dataset.testid = 'boot-error';
  const retryBtn = h('button', { type: 'button', class: 'btn btn-primary', dataset: { testid: 'boot-retry' } }, svgIcon('refresh'), '重试');
  retryBtn.addEventListener('click', () => { retry(); });
  render(app,
    h('div', { class: 'boot' },
      h('div', { class: 'card boot-card' },
        h('div', { class: 'error-state', role: 'alert' },
          h('div', { class: 'error-state-icon' }, svgIcon('warning')),
          h('div', { class: 'error-state-title' }, '暂时无法打开管理后台'),
          h('div', { class: 'error-state-detail muted' }, message),
          h('div', { class: 'row error-state-actions' },
            retryBtn,
            h('button', {
              type: 'button', class: 'btn btn-ghost', dataset: { testid: 'boot-logout' },
              on: { click: () => { clearToken(); broadcastLogout(); showLogin(); } },
            }, '退出登录'))))));
}

function renderLoginLayout() {
  const app = appEl();
  shell = null;
  document.body.dataset.layout = 'login';
  viewHost = h('main', { class: 'login-main', id: 'main' });
  render(app, h('div', { class: 'login-layout' }, viewHost));
}

function renderShell() {
  const app = appEl();
  const s = session;
  document.body.dataset.layout = 'app';

  const title = h('h1', { class: 'topbar-title', id: 'page-title' });
  const deploy = h('a', {
    class: 'deploy-indicator', target: '_blank', rel: 'noopener noreferrer',
    dataset: { testid: 'deploy-indicator', state: 'idle' },
  });
  deploy.hidden = true;

  const login = (s.user && s.user.login) || '';
  const avatar = userAvatar(s.user);

  const logoutBtn = h('button', {
    type: 'button', class: 'btn btn-ghost btn-sm topbar-logout', dataset: { testid: 'logout' },
    'aria-label': '退出登录', title: '退出登录',
  }, svgIcon('logout'), h('span', { class: 'hide-mobile' }, '退出'));
  logoutBtn.addEventListener('click', () => { logout(); });

  const topbar = h('header', { class: 'topbar' },
    h('a', { class: 'topbar-brand', href: '#/' + DEFAULT_ROUTE, 'aria-label': `${SITE_NAME} · ${APP_NAME}` },
      logoMark(),
      h('span', { class: 'brand-text' },
        h('span', { class: 'brand-name' }, SITE_NAME),
        h('span', { class: 'brand-sep', 'aria-hidden': 'true' }, '·'),
        h('span', { class: 'brand-app' }, APP_NAME))),
    title,
    h('div', { class: 'topbar-actions' },
      deploy,
      h('a', {
        class: 'btn btn-ghost btn-sm topbar-site', href: SITE_URL, target: '_blank', rel: 'noopener noreferrer',
        dataset: { testid: 'view-site' }, 'aria-label': '查看网站（新标签页）', title: '查看网站',
      }, svgIcon('external'), h('span', { class: 'hide-mobile' }, '查看网站')),
      h('span', { class: 'user-chip', dataset: { testid: 'user-chip' }, title: login ? `已登录：${login}` : '已登录' },
        avatar,
        h('span', { class: 'user-login hide-mobile', dataset: { testid: 'user-login' } }, login)),
      logoutBtn));

  const navItems = NAV.map((item) => {
    const a = h('a', {
      class: 'nav-item', href: '#/' + item.route, dataset: { testid: item.testid, route: item.route },
    },
      h('span', { class: 'nav-icon' }, svgIcon(item.icon)),
      h('span', { class: 'nav-label' }, item.label),
      item.short ? h('span', { class: 'nav-label-short' }, item.short) : null);
    return a;
  });

  const sidenav = h('nav', { class: 'sidenav', 'aria-label': '主导航' },
    h('a', { class: 'btn btn-primary nav-new', href: '#/edit?new=post', dataset: { testid: 'nav-new-post' } },
      svgIcon('plus'), '写新文章'),
    h('div', { class: 'nav-list' }, navItems),
    h('div', { class: 'sidenav-footer muted' },
      h('div', {}, '发布后约 1–2 分钟生效'),
      h('div', {}, `${REPO.owner}/${REPO.repo}`)));

  viewHost = h('main', { class: 'main', id: 'main', tabindex: '-1' });
  render(app, h('div', { class: 'shell' }, topbar, sidenav, viewHost));
  shell = { title, deploy, navItems, topbar };
  setTitle('');
}

function userAvatar(user) {
  const login = (user && user.login) || '?';
  const fallback = () => h('span', { class: 'avatar avatar-fallback', 'aria-hidden': 'true' }, login.slice(0, 1).toUpperCase());
  if (!user || !user.avatarUrl) return fallback();
  let src;
  try {
    const u = new URL(user.avatarUrl, location.href);
    if (u.protocol !== 'https:' && u.origin !== location.origin) return fallback();
    src = u.href;
  } catch {
    return fallback();
  }
  const img = h('img', { class: 'avatar', src, alt: '', width: 28, height: 28, referrerpolicy: 'no-referrer', dataset: { testid: 'user-avatar' } });
  img.addEventListener('error', () => img.replaceWith(fallback()));
  return img;
}

/** 课程里的页面（content/courses/<课程>/…；「课程资料」总页 content/courses/_index.md 本身属于「页面」）。 */
const COURSE_PAGE_RE = /^content\/courses\/[^/]+\/[^/]+$/;
const COURSE_DIR_RE = /^\/*(?:content\/)?courses\/[^/]+\/*$/;

function activeNavRoute(info) {
  if (info.route !== 'edit') return info.route;
  const p = info.params || {};
  if (p.new === 'page') return COURSE_DIR_RE.test(String(p.dir || '')) ? 'courses' : 'pages';
  // 本机草稿：file:<path> 的草稿按文件路径判断；new:… 的新草稿看不出类型，归到「文章」
  const path = p.path || (typeof p.draft === 'string' && p.draft.startsWith('file:') ? p.draft.slice(5) : '');
  if (path && COURSE_PAGE_RE.test(path)) return 'courses';
  if (path) return path.startsWith(PATHS.posts + '/') && !/\/_index(\.[a-z-]+)?\.md$/.test(path) ? 'posts' : 'pages';
  return 'posts';
}

function updateNav(info) {
  if (!shell) return;
  const active = activeNavRoute(info);
  for (const a of shell.navItems) {
    const on = a.dataset.route === active;
    a.classList.toggle('active', on);
    if (on) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
}

// ---------------------------------------------------------------------------
// 全局处理

let globalsInstalled = false;

function installGlobalHandlers() {
  if (globalsInstalled) return;
  globalsInstalled = true;

  setupSessionChannel();

  window.addEventListener('beforeunload', (e) => {
    if (publishing || router.isDirty()) {
      e.preventDefault();
      e.returnValue = '';
    }
  });

  window.addEventListener('unhandledrejection', (e) => {
    const err = e.reason;
    if (err && err.status === 401 && session && session.ready) {
      e.preventDefault();
      handleAuthExpired();
      return;
    }
    if (err && err.name === 'GitHubError') {
      e.preventDefault();
      toast(errorMessage(err), { type: 'error' });
    }
  });

  window.addEventListener('offline', () => toast('网络已断开，恢复连接后再发布', { type: 'warning', timeout: 6000 }));
  window.addEventListener('online', () => toast('网络已恢复', { type: 'success' }));
}

// ---------------------------------------------------------------------------

boot().catch((err) => {
  console.error('[main] boot failed', err);
  showBootError(errorMessage(err), () => location.reload());
});
