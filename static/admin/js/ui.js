/**
 * ui.js — DOM 小工具与对话框（ADMIN_SPEC §5.2）。
 *
 * 安全约定：这里所有用字符串生成界面的地方都走 textContent / createTextNode，
 * 唯一使用 innerHTML 的地方是 svgIcon() —— 它只解析本文件里写死的图标字符串。
 *
 * 导入时不访问 document（全部懒加载），方便在 Node 里导入纯函数做测试。
 *
 * @module ui
 */

// ---------------------------------------------------------------------------
// h(): 建 DOM 元素

/** 作为 DOM 属性（property）而不是 attribute 设置的键 */
const PROP_KEYS = new Set(['value', 'checked', 'disabled', 'selected', 'htmlFor', 'indeterminate', 'multiple', 'readOnly', 'required']);
/** 绝不允许通过 h() 设置的键（防止有人把字符串当 HTML 塞进来） */
const FORBIDDEN_KEYS = new Set(['innerHTML', 'outerHTML', 'srcdoc', 'insertAdjacentHTML']);

/**
 * 创建一个 HTML 元素。
 *
 * @param {string} tag 标签名，例如 'div'
 * @param {object} [attrs]
 *   - class: string | string[]（空值被丢弃）；className 同义
 *   - style: string | object（对象键可以是 camelCase 或 '--css-var'）
 *   - dataset: object → data-* 属性
 *   - on: { click: fn, ... } 事件监听；也接受 onClick: fn 这种写法
 *   - value / checked / disabled / selected / htmlFor …：作为 property 设置
 *   - 其他键 → setAttribute（true → ''，false / null / undefined → 跳过）
 * @param {...any} children 字符串 / 数字（文本节点）、Node、数组（会展开）、null / undefined / false（跳过）
 * @returns {HTMLElement}
 */
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  if (attrs != null && (typeof attrs !== 'object' || attrs instanceof Node || Array.isArray(attrs))) {
    // 允许省略 attrs：h('p', '文字')
    children.unshift(attrs);
    attrs = {};
  }
  for (const [key, val] of Object.entries(attrs || {})) {
    if (FORBIDDEN_KEYS.has(key)) throw new Error(`h(): "${key}" is not allowed`);
    if (key === 'class' || key === 'className') {
      const cls = classList(val);
      if (cls) el.className = cls;
    } else if (key === 'style') {
      if (val == null || val === false) continue;
      if (typeof val === 'string') el.setAttribute('style', val);
      else {
        for (const [k, v] of Object.entries(val)) {
          if (v == null || v === false) continue;
          if (k.startsWith('--') || k.includes('-')) el.style.setProperty(k, String(v));
          else el.style[k] = v;
        }
      }
    } else if (key === 'dataset') {
      for (const [k, v] of Object.entries(val || {})) {
        if (v != null && v !== false) el.dataset[k] = v === true ? '' : String(v);
      }
    } else if (key === 'on') {
      for (const [type, fn] of Object.entries(val || {})) {
        if (typeof fn === 'function') el.addEventListener(type, fn);
      }
    } else if (/^on[A-Z]/.test(key) && typeof val === 'function') {
      el.addEventListener(key.slice(2).toLowerCase(), val);
    } else if (PROP_KEYS.has(key)) {
      if (val === undefined) continue;
      el[key] = key === 'value' ? (val == null ? '' : String(val)) : val;
    } else {
      if (val == null || val === false) continue;
      if (typeof val === 'function') continue; // 绝不把函数转成字符串属性（如 onclick="…"）
      el.setAttribute(key, val === true ? '' : String(val));
    }
  }
  appendChildren(el, children);
  return el;
}

function classList(val) {
  if (!val) return '';
  if (Array.isArray(val)) return val.flat(Infinity).filter(Boolean).join(' ');
  if (typeof val === 'object') return Object.entries(val).filter(([, on]) => on).map(([c]) => c).join(' ');
  return String(val);
}

function appendChildren(el, children) {
  for (const c of children) {
    if (c == null || c === false || c === true) continue;
    if (Array.isArray(c)) appendChildren(el, c);
    else if (c instanceof Node) el.appendChild(c);
    else el.appendChild(document.createTextNode(String(c)));
  }
}

/** 清空元素的所有子节点。 */
export function clear(el) {
  if (!el) return el;
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

/** 清空后追加子节点（参数规则同 h() 的 children）。 */
export function render(el, ...children) {
  clear(el);
  appendChildren(el, children);
  return el;
}

// ---------------------------------------------------------------------------
// 图标：写死的 SVG 字符串（24×24，描边风格，currentColor）

const ICONS = {
  post: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="M9 13h6M9 17h4"/>',
  page: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M8 4v5"/>',
  home: '<path d="M3 11l9-7 9 7"/><path d="M5 10v10h5v-6h4v6h5V10"/>',
  background: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="9.5" r="1.5"/><path d="M3 17c3-3 5-4 8-1 2-2 4-3 7-1l3 2"/><path d="M15 3l.5 1.5L17 5l-1.5.5L15 7l-.5-1.5L13 5l1.5-.5z" />',
  files: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13.5 6.5l4 4"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6"/><path d="M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  upload: '<path d="M12 16V4M7 9l5-5 5 5"/><path d="M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3"/>',
  download: '<path d="M12 4v12M7 11l5 5 5-5"/><path d="M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  back: '<path d="M15 5l-7 7 7 7"/>',
  'chevron-right': '<path d="M9 5l7 7-7 7"/>',
  'chevron-down': '<path d="M5 9l7 7 7-7"/>',
  more: '<circle cx="5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="19" cy="12" r="1.3"/>',
  refresh: '<path d="M20 11a8 8 0 0 0-14.3-4.9L4 8"/><path d="M4 3v5h5"/><path d="M4 13a8 8 0 0 0 14.3 4.9L20 16"/><path d="M20 21v-5h-5"/>',
  phone: '<rect x="6" y="2.5" width="12" height="19" rx="2.5"/><path d="M11 18.5h2"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',
  external: '<path d="M14 4h6v6M20 4l-9 9"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
  warning: '<path d="M12 3.5L2.5 20h19z"/><path d="M12 10v4.5M12 17.2v.3"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5.5M12 7.8v.2"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.7 3.8 5.7 3.8 9s-1.3 6.3-3.8 9c-2.5-2.7-3.8-5.7-3.8-9S9.5 5.7 12 3z"/>',
  logout: '<path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3"/><path d="M10 8l-4 4 4 4M6 12h10"/>',
  image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="9.5" r="1.8"/><path d="M21 16l-5-5-9 9"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 3.6-7 8-7s8 3 8 7"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="M11 12l9-9M17 6l3 3M14 9l2 2"/>',
  lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/>',
  drag: '<circle cx="9" cy="6" r="1.2"/><circle cx="15" cy="6" r="1.2"/><circle cx="9" cy="12" r="1.2"/><circle cx="15" cy="12" r="1.2"/><circle cx="9" cy="18" r="1.2"/><circle cx="15" cy="18" r="1.2"/>',
  up: '<path d="M12 19V5M6 11l6-6 6 6"/>',
  down: '<path d="M12 5v14M6 13l6 6 6-6"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  send: '<path d="M21 3L10 14"/><path d="M21 3l-7 18-4-7-7-4z"/>',
  save: '<path d="M5 3h11l4 4v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 1-2z"/><path d="M8 3v5h7V3M8 21v-7h8v7"/>',
  tag: '<path d="M3 12V4a1 1 0 0 1 1-1h8l9 9-9 9z"/><circle cx="8" cy="8" r="1.5"/>',
  palette: '<path d="M12 3a9 9 0 1 0 0 18c1 0 1.7-.8 1.7-1.7 0-.5-.2-.9-.5-1.2a1.7 1.7 0 0 1 1.3-2.8H17a4 4 0 0 0 4-4C21 6.6 17 3 12 3z"/><circle cx="7.5" cy="11" r="1.2"/><circle cx="10" cy="7" r="1.2"/><circle cx="15" cy="7" r="1.2"/>',
};

const iconCache = new Map();

/**
 * 内置图标（SVG 元素，颜色跟随 currentColor，默认 1.15em 大小）。
 * @param {string} name 见 ICONS；未知名称返回一个空白占位图标
 * @param {{ size?: number|string, class?: string }} [opts]
 * @returns {SVGElement}
 */
export function svgIcon(name, opts = {}) {
  let tpl = iconCache.get(name);
  if (!tpl) {
    const known = Object.prototype.hasOwnProperty.call(ICONS, name);
    const body = known ? ICONS[name] : '';
    if (!known) console.warn(`[ui] unknown icon "${name}"`);
    tpl = document.createElement('template');
    // 安全：body 只来自上面写死的 ICONS 常量（ADMIN_SPEC §2.3 例外 a）
    tpl.innerHTML =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
      'stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' +
      body + '</svg>';
    iconCache.set(name, tpl);
  }
  const svg = /** @type {SVGElement} */ (tpl.content.firstChild.cloneNode(true));
  svg.setAttribute('class', ['icon', `icon-${name}`, opts.class].filter(Boolean).join(' '));
  if (opts.size) {
    const s = typeof opts.size === 'number' ? opts.size + 'px' : opts.size;
    svg.style.width = s;
    svg.style.height = s;
  }
  return svg;
}

/** 已知的图标名（方便其他模块检查）。 */
export const ICON_NAMES = Object.freeze(Object.keys(ICONS));

// ---------------------------------------------------------------------------
// 浮层管理：模态框 / 遮罩共用。最上层的浮层获得焦点陷阱，主界面被设为 inert。

const layers = [];      // [{ el, kind, trap: boolean, onEscape?: fn }]
let layersRoot = null;
let globalKeysBound = false;

function getLayersRoot() {
  if (layersRoot && layersRoot.isConnected) return layersRoot;
  layersRoot = document.getElementById('ui-layers');
  if (!layersRoot) {
    layersRoot = h('div', { id: 'ui-layers' });
    document.body.appendChild(layersRoot);
  }
  return layersRoot;
}

function appRoot() {
  return document.getElementById('app');
}

function syncInert() {
  const app = appRoot();
  const blocking = layers.length > 0;
  if (app) {
    if (blocking) app.setAttribute('inert', '');
    else app.removeAttribute('inert');
  }
  document.documentElement.classList.toggle('ui-locked', blocking);
  // 只有最上层可以交互
  layers.forEach((l, i) => {
    if (i === layers.length - 1) l.el.removeAttribute('inert');
    else l.el.setAttribute('inert', '');
  });
}

function pushLayer(layer) {
  bindGlobalKeys();
  layer.returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  layers.push(layer);
  getLayersRoot().appendChild(layer.el);
  syncInert();
}

function popLayer(layer) {
  const i = layers.indexOf(layer);
  if (i < 0) return;
  layers.splice(i, 1);
  layer.el.remove();
  syncInert();
  // 关闭后把焦点还给打开前的元素（如果它还在页面上且可交互）
  const target = layer.returnFocus;
  if (target && target.isConnected && !target.closest('[inert]')) {
    try { target.focus({ preventScroll: true }); } catch { /* ignore */ }
  } else if (layers.length) {
    focusFirst(layers[layers.length - 1].el);
  }
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), iframe, [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';

function focusables(root) {
  return [...root.querySelectorAll(FOCUSABLE)].filter((el) => el.getClientRects().length > 0 && !el.closest('[inert]'));
}

function focusFirst(root) {
  const preferred = root.querySelector('[autofocus]') || root.querySelector('[data-autofocus]');
  const list = focusables(root);
  const target = preferred || list.find((el) => !el.classList.contains('modal-close')) || list[0] || root;
  try { target.focus({ preventScroll: true }); } catch { /* ignore */ }
}

function bindGlobalKeys() {
  if (globalKeysBound) return;
  globalKeysBound = true;
  document.addEventListener('keydown', (e) => {
    const top = layers[layers.length - 1];
    if (!top) return;
    if (e.key === 'Escape') {
      if (top.onEscape) {
        e.preventDefault();
        e.stopPropagation();
        top.onEscape();
      }
      return;
    }
    if (e.key === 'Tab' && top.trap) {
      const list = focusables(top.el);
      if (!list.length) { e.preventDefault(); top.el.focus(); return; }
      const first = list[0];
      const last = list[list.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && (active === first || !top.el.contains(active))) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && (active === last || !top.el.contains(active))) { e.preventDefault(); first.focus(); }
    }
  }, true);
  // 焦点跑到浮层外面（比如点击了地址栏再回来）时拉回来
  document.addEventListener('focusin', (e) => {
    const top = layers[layers.length - 1];
    if (top && top.trap && !top.el.contains(e.target) && !(e.target instanceof Node && isToast(e.target))) {
      focusFirst(top.el);
    }
  });
}

function isToast(node) {
  return !!(node.parentElement && node.parentElement.closest && node.parentElement.closest('.toast-stack'));
}

/**
 * （扩展）关闭所有模态框和遮罩（例如登录失效、整页切换时）。模态框的 onClose 会被调用。
 */
export function closeAllLayers() {
  for (const l of [...layers].reverse()) {
    try { l.close ? l.close() : popLayer(l); } catch (err) { console.error(err); popLayer(l); }
  }
}

// ---------------------------------------------------------------------------
// 按钮忙碌状态

const busyPromises = new WeakMap();

/**
 * 运行 fn() 期间禁用按钮并显示转圈；返回 fn 的结果（异常会继续抛出）。
 * 按钮已经在忙时再次调用，直接返回正在进行的那个 Promise（防止连点重复提交）。
 * @template T
 * @param {HTMLButtonElement|null} button
 * @param {() => T | Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function withBusy(button, fn) {
  if (!button) return fn();
  const pending = busyPromises.get(button);
  if (pending) return pending;
  const wasDisabled = button.disabled;
  button.disabled = true;
  button.classList.add('is-busy');
  button.setAttribute('aria-busy', 'true');
  const p = (async () => {
    try {
      return await fn();
    } finally {
      busyPromises.delete(button);
      button.classList.remove('is-busy');
      button.removeAttribute('aria-busy');
      button.disabled = wasDisabled;
    }
  })();
  busyPromises.set(button, p);
  return p;
}

// ---------------------------------------------------------------------------
// 模态框

let modalSeq = 0;

/**
 * 打开一个模态框。
 * @param {{ title?: string, content?: Node|string|Array, actions?: Array<{ text: string, kind?: 'primary'|'danger'|'ghost', onClick?: (close: Function) => any, testid?: string, autofocus?: boolean }>,
 *           wide?: boolean, onClose?: Function, dismissible?: boolean, className?: string }} opts
 *   - actions[].onClick(close) 可以是 async；Promise 未完成时按钮显示忙碌；抛错会以 toast 提示且不关闭。
 *     没有 onClick 的按钮直接关闭。
 *   - dismissible（扩展，默认 true）：false 时 Esc / 点背景 / × 都不能关闭。
 * @returns {{ el: HTMLElement, body: HTMLElement, footer: HTMLElement, close: () => void }}
 */
export function modal({ title = '', content, actions = [], wide = false, onClose, dismissible = true, className } = {}) {
  const id = `modal-${++modalSeq}`;
  let closed = false;
  const body = h('div', { class: 'modal-body' });
  if (content != null) appendChildren(body, [content]);

  const close = () => {
    if (closed) return;
    closed = true;
    backdrop.classList.add('is-closing');
    popLayer(layer);
    try { onClose && onClose(); } catch (err) { console.error(err); }
  };

  const footer = h('div', { class: 'modal-footer' },
    actions.map((a) => {
      const btn = h('button', {
        type: 'button',
        class: ['btn', a.kind ? `btn-${a.kind}` : '', a.className],
        dataset: { testid: a.testid },
        'data-autofocus': a.autofocus ? true : undefined,
      }, a.text);
      btn.addEventListener('click', async () => {
        if (!a.onClick) { close(); return; }
        try {
          await withBusy(btn, () => a.onClick(close));
        } catch (err) {
          console.error(err);
          toast(errorMessage(err), { type: 'error' });
        }
      });
      return btn;
    }));
  if (!actions.length) footer.hidden = true;

  const closeBtn = dismissible
    ? h('button', { type: 'button', class: 'btn btn-ghost btn-icon modal-close', 'aria-label': '关闭', dataset: { testid: 'modal-close' }, on: { click: close } }, svgIcon('close'))
    : null;

  const dialog = h('div', {
    class: ['modal', wide && 'modal-wide', className],
    role: 'dialog',
    'aria-modal': 'true',
    'aria-labelledby': title ? `${id}-title` : undefined,
    tabindex: '-1',
  },
    (title || closeBtn) ? h('div', { class: 'modal-header' },
      h('h2', { class: 'modal-title', id: `${id}-title` }, title),
      closeBtn) : null,
    body,
    footer);

  const backdrop = h('div', { class: 'modal-backdrop' }, dialog);
  // 只有在背景上按下并松开才关闭（避免在输入框里拖选文字时误关）
  let downOnBackdrop = false;
  backdrop.addEventListener('mousedown', (e) => { downOnBackdrop = e.target === backdrop; });
  backdrop.addEventListener('click', (e) => {
    if (dismissible && downOnBackdrop && e.target === backdrop) close();
    downOnBackdrop = false;
  });

  const layer = { el: backdrop, kind: 'modal', trap: true, onEscape: dismissible ? close : () => {}, close };
  pushLayer(layer);
  requestAnimationFrame(() => { if (!closed) focusFirst(dialog); });
  return { el: dialog, body, footer, close };
}

/**
 * 确认框。
 * @param {{ title?: string, message?: string|Node, okText?: string, cancelText?: string, danger?: boolean }} opts
 * @returns {Promise<boolean>}
 */
export function confirmDialog({ title = '请确认', message = '', okText = '确定', cancelText = '取消', danger = false } = {}) {
  return new Promise((resolve) => {
    let result = false;
    modal({
      title,
      content: typeof message === 'string' ? h('p', { class: 'modal-message' }, message) : message,
      actions: [
        { text: cancelText, kind: 'ghost', testid: 'confirm-cancel', onClick: (close) => { result = false; close(); } },
        { text: okText, kind: danger ? 'danger' : 'primary', testid: 'confirm-ok', autofocus: true, onClick: (close) => { result = true; close(); } },
      ],
      onClose: () => resolve(result),
    });
  });
}

/**
 * 输入框对话框。
 * @param {{ title?: string, label?: string, value?: string, placeholder?: string, validate?: (v: string) => string|null, okText?: string, hint?: string }} opts
 * @returns {Promise<string|null>} 取消时为 null
 */
export function promptDialog({ title = '', label = '', value = '', placeholder = '', validate, okText = '确定', hint } = {}) {
  return new Promise((resolve) => {
    let result = null;
    const inputId = `prompt-${++modalSeq}`;
    const input = h('input', { class: 'input', id: inputId, type: 'text', value, placeholder, autocomplete: 'off', 'data-autofocus': true, dataset: { testid: 'prompt-input' } });
    const error = h('div', { class: 'error', role: 'alert' });
    error.hidden = true;
    const check = () => {
      const msg = validate ? validate(input.value) : null;
      error.textContent = msg || '';
      error.hidden = !msg;
      input.setAttribute('aria-invalid', msg ? 'true' : 'false');
      return !msg;
    };
    input.addEventListener('input', () => { if (!error.hidden) check(); });
    const m = modal({
      title,
      content: h('div', { class: 'field' },
        label ? h('label', { htmlFor: inputId }, label) : null,
        input,
        hint ? h('div', { class: 'hint' }, hint) : null,
        error),
      actions: [
        { text: '取消', kind: 'ghost', testid: 'prompt-cancel', onClick: (close) => close() },
        { text: okText, kind: 'primary', testid: 'prompt-ok', onClick: (close) => { if (check()) { result = input.value; close(); } } },
      ],
      onClose: () => resolve(result),
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.isComposing) {
        e.preventDefault();
        if (check()) { result = input.value; m.close(); }
      }
    });
    requestAnimationFrame(() => { try { input.select(); } catch { /* ignore */ } });
  });
}

// ---------------------------------------------------------------------------
// 全屏遮罩（发布中…）

/**
 * 全屏阻塞遮罩（带转圈和文字）。
 * @param {string} text
 * @returns {{ update(text: string, detail?: string): void, close(): void }}
 */
export function showOverlay(text) {
  const label = h('div', { class: 'overlay-text' }, text || '请稍候…');
  const detail = h('div', { class: 'overlay-detail muted' });
  detail.hidden = true;
  const box = h('div', { class: 'overlay-box', role: 'status', 'aria-live': 'polite', tabindex: '-1' },
    h('span', { class: 'spinner spinner-lg', 'aria-hidden': 'true' }), label, detail);
  const el = h('div', { class: 'overlay', dataset: { testid: 'overlay' } }, box);
  let closed = false;
  const layer = { el, kind: 'overlay', trap: true, onEscape: () => {}, close: () => { if (!closed) { closed = true; popLayer(layer); } } };
  pushLayer(layer);
  requestAnimationFrame(() => { try { box.focus({ preventScroll: true }); } catch { /* ignore */ } });
  return {
    update(t, d) {
      if (closed) return;
      if (t != null) label.textContent = t;
      if (d !== undefined) { detail.textContent = d || ''; detail.hidden = !d; }
    },
    close() {
      if (closed) return;
      closed = true;
      popLayer(layer);
    },
  };
}

// ---------------------------------------------------------------------------
// Toast

let toastStack = null;

function getToastStack() {
  if (toastStack && toastStack.isConnected) return toastStack;
  toastStack = h('div', { class: 'toast-stack', 'aria-live': 'polite', 'aria-relevant': 'additions' });
  document.body.appendChild(toastStack);
  return toastStack;
}

const TOAST_ICONS = { info: 'info', success: 'check', error: 'warning', warning: 'warning' };
const MAX_TOASTS = 4;

/**
 * 轻提示。错误默认显示更久（6 秒）；timeout = 0 表示一直显示直到点击。
 * @param {string} message
 * @param {{ type?: 'info'|'success'|'error'|'warning', timeout?: number }} [opts]
 * @returns {{ close(): void }}
 */
export function toast(message, { type = 'info', timeout } = {}) {
  if (!TOAST_ICONS[type]) type = 'info';
  const ms = timeout ?? (type === 'error' ? 6000 : type === 'warning' ? 4500 : 3000);
  const stack = getToastStack();
  const el = h('div', {
    class: ['toast', `toast-${type}`],
    role: type === 'error' ? 'alert' : 'status',
    dataset: { testid: `toast-${type}` },
  },
    h('span', { class: 'toast-icon' }, svgIcon(TOAST_ICONS[type])),
    h('span', { class: 'toast-text' }, String(message ?? '')),
    h('button', { type: 'button', class: 'toast-close', 'aria-label': '关闭提示' }, svgIcon('close')));
  let timer = null;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    el.classList.add('is-leaving');
    setTimeout(() => el.remove(), 200);
  };
  el.querySelector('.toast-close').addEventListener('click', close);
  // 鼠标悬停时暂停计时，方便看完长错误信息
  const arm = () => { if (ms > 0) timer = setTimeout(close, ms); };
  el.addEventListener('mouseenter', () => clearTimeout(timer));
  el.addEventListener('mouseleave', () => { if (!closed) { clearTimeout(timer); arm(); } });
  stack.appendChild(el);
  // 太多时移除最早的
  const live = [...stack.querySelectorAll('.toast:not(.is-leaving)')];
  if (live.length > MAX_TOASTS) live.slice(0, live.length - MAX_TOASTS).forEach((t) => t.remove());
  arm();
  return { close };
}

/** 把任意错误转成给用户看的一句中文。 */
export function errorMessage(err) {
  if (!err) return '出错了，请重试';
  if (typeof err === 'string') return err;
  const msg = err.message || String(err);
  if (/Failed to fetch|NetworkError|Load failed/i.test(msg)) return '网络错误，请检查网络后重试';
  return msg;
}

// ---------------------------------------------------------------------------
// 格式化

/**
 * 1536 → '1.5 KB'
 * @param {number} n
 */
export function formatBytes(n) {
  n = Number(n);
  if (!Number.isFinite(n) || n < 0) return '';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1).replace(/\.0$/, '')} ${units[i]}`;
}

const pad2 = (x) => String(x).padStart(2, '0');

function toDate(v) {
  if (v instanceof Date) return v;
  if (typeof v === 'number') return new Date(v);
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (!s) return null;
  // 'YYYY-MM-DD'：按本地日期理解，不要被当成 UTC 零点
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return new Date(s);
}

/**
 * 日期显示：'2026-10-31 17:20'；只有日期的字符串显示 '2026-10-31'；无法解析时原样返回。
 * @param {string|Date|number} isoOrDateString
 */
export function formatDate(isoOrDateString) {
  if (isoOrDateString == null || isoOrDateString === '') return '';
  if (typeof isoOrDateString === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(isoOrDateString.trim())) return isoOrDateString.trim();
  const d = toDate(isoOrDateString);
  if (!d || Number.isNaN(d.getTime())) return String(isoOrDateString);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/**
 * 相对时间：'刚刚' / '3 分钟前' / '2 小时前' / '昨天 17:20' / '5 天前' / '2026-01-02'
 * @param {string|Date|number} date
 */
export function timeAgo(date) {
  const d = toDate(date);
  if (!d || Number.isNaN(d.getTime())) return '';
  const now = new Date();
  const diff = (now.getTime() - d.getTime()) / 1000;
  if (diff < 45) return '刚刚';
  if (diff < 3600) return `${Math.max(1, Math.round(diff / 60))} 分钟前`;
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (diff < 6 * 3600 || d.getTime() >= startOfToday) return `${Math.max(1, Math.floor(diff / 3600))} 小时前`;
  if (d.getTime() >= startOfToday - 86400000) return `昨天 ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  const days = Math.floor((startOfToday - d.getTime()) / 86400000) + 1;
  if (days < 30) return `${days} 天前`;
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/**
 * 防抖。返回的函数带 cancel() 和 flush()。
 * @template {Function} F
 * @param {F} fn
 * @param {number} ms
 */
export function debounce(fn, ms) {
  let timer = null;
  let lastArgs = null;
  let lastThis = null;
  const run = () => {
    timer = null;
    const args = lastArgs;
    lastArgs = null;
    return fn.apply(lastThis, args);
  };
  const debounced = function (...args) {
    lastArgs = args;
    lastThis = this;
    clearTimeout(timer);
    timer = setTimeout(run, ms);
  };
  debounced.cancel = () => { clearTimeout(timer); timer = null; lastArgs = null; };
  debounced.flush = () => { if (timer) { clearTimeout(timer); return run(); } return undefined; };
  debounced.pending = () => timer !== null;
  return debounced;
}

// ---------------------------------------------------------------------------
// 小组件

/**
 * 徽标。
 * @param {string} text
 * @param {'green'|'gray'|'blue'|'orange'|'red'} [kind='gray']
 */
export function badge(text, kind = 'gray') {
  return h('span', { class: ['badge', `badge-${kind || 'gray'}`] }, text);
}

/**
 * 空状态（居中的灰色提示，可带一个按钮）。
 * @param {string|Node} text
 * @param {Node | { text: string, onClick?: Function, href?: string, icon?: string, kind?: string }} [action]
 * @param {{ icon?: string }} [opts]
 */
export function emptyState(text, action, opts = {}) {
  let actionEl = null;
  if (action instanceof Node) actionEl = action;
  else if (action && action.text) {
    const children = [action.icon ? svgIcon(action.icon) : null, action.text];
    actionEl = action.href
      ? h('a', { class: ['btn', `btn-${action.kind || 'primary'}`], href: action.href }, children)
      : h('button', { type: 'button', class: ['btn', `btn-${action.kind || 'primary'}`], on: { click: action.onClick } }, children);
  }
  return h('div', { class: 'empty' },
    h('div', { class: 'empty-icon' }, svgIcon(opts.icon || 'post')),
    h('div', { class: 'empty-text' }, text),
    actionEl ? h('div', { class: 'empty-action' }, actionEl) : null);
}

/**
 * 区块内的加载提示（转圈 + 文字）。
 * @param {string} [text]
 */
export function loadingState(text = '加载中…') {
  return h('div', { class: 'loading-state', role: 'status' }, h('span', { class: 'spinner' }), h('span', {}, text));
}

/**
 * 区块内的错误提示（带「重试」按钮）。
 * @param {string} title
 * @param {{ detail?: string, retry?: Function, retryText?: string }} [opts]
 */
export function errorState(title, { detail, retry, retryText = '重试' } = {}) {
  return h('div', { class: 'error-state', role: 'alert' },
    h('div', { class: 'error-state-icon' }, svgIcon('warning')),
    h('div', { class: 'error-state-title' }, title),
    detail ? h('div', { class: 'error-state-detail muted' }, detail) : null,
    retry ? h('button', { type: 'button', class: 'btn', on: { click: retry } }, svgIcon('refresh'), retryText) : null);
}

// ---------------------------------------------------------------------------
// 资源加载

const scriptCache = new Map();
const styleCache = new Map();

/**
 * 加载一个外部脚本（同一 src 只加载一次；失败后允许重试）。
 * @param {string} src
 * @returns {Promise<void>}
 */
export function loadScript(src) {
  const url = new URL(src, document.baseURI).href;
  if (scriptCache.has(url)) return scriptCache.get(url);
  const p = new Promise((resolve, reject) => {
    const el = document.createElement('script');
    el.src = url;
    el.async = true;
    el.onload = () => resolve();
    el.onerror = () => {
      scriptCache.delete(url);
      el.remove();
      reject(new Error(`脚本加载失败：${url}`));
    };
    document.head.appendChild(el);
  });
  scriptCache.set(url, p);
  return p;
}

/**
 * 加载一个样式表（同一 href 只加载一次；失败后允许重试）。
 * @param {string} href
 * @returns {Promise<void>}
 */
export function loadStyle(href) {
  const url = new URL(href, document.baseURI).href;
  if (styleCache.has(url)) return styleCache.get(url);
  const existing = [...document.querySelectorAll('link[rel="stylesheet"]')].find((l) => l.href === url);
  if (existing) {
    const done = Promise.resolve();
    styleCache.set(url, done);
    return done;
  }
  const p = new Promise((resolve, reject) => {
    const el = document.createElement('link');
    el.rel = 'stylesheet';
    el.href = url;
    el.onload = () => resolve();
    el.onerror = () => {
      styleCache.delete(url);
      el.remove();
      reject(new Error(`样式加载失败：${url}`));
    };
    document.head.appendChild(el);
  });
  styleCache.set(url, p);
  return p;
}

/**
 * 复制文字到剪贴板（不支持 Clipboard API 时用 execCommand 兜底）。
 * @param {string} text
 * @returns {Promise<void>}
 */
export async function copyText(text) {
  text = String(text ?? '');
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return;
    }
  } catch {
    // 落到兜底方案
  }
  const ta = h('textarea', { value: text, readonly: true, style: { position: 'fixed', top: '-1000px', left: '0', opacity: '0' } });
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { ok = false; }
  ta.remove();
  if (!ok) throw new Error('复制失败，请手动选中复制');
}
