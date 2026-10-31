/**
 * views/background.js — 「背景动画」（ADMIN_SPEC §6.5，BG 维护）。
 *
 * - 列出 assets/js/background/effects/*.js 里的每个效果（"卡带"）：实时小预览、名称和说明
 *   （来自文件开头的文档注释）、「使用中」标记（params.toml 的 background.effect）。
 * - 点卡片 → 下方大预览（16:9，可切换 电脑/手机、浅色/深色，「重新开始」），
 *   「用作网站背景」把它设为 background.effect。
 * - 网站设置：启用背景动画（background.enabled）、自动播放（background.autoplay：home / all / none）。
 * - 参数微调：解析卡带里形如 `    NAME: 123.4,  // 说明` 的行（大写键名、纯数字字面量；
 *   `8 / 3` 这类表达式跳过）→ 数字输入框；改动会（防抖后）重新运行大预览；「恢复默认」回到文件里的值。
 *   发布时只替换那一行里的数字，其他字符一个不动。
 * - 「保存并发布」：params.toml（tomlpatch.setValue，保留注释）+ 调过参数的效果文件，一次 ctx.publish。
 *
 * 预览沙箱：<iframe sandbox="allow-scripts" src="cassette-frame.html">（没有 allow-same-origin），
 * 引擎 + 卡带代码通过 postMessage 传入；协议见 js/cassette-frame.js。重新运行 = 重建 iframe。
 *
 * 安全：界面全部用 h() / textContent 生成（§2 规则 3）；仓库里的代码只在沙箱 iframe 里运行。
 *
 * @module views/background
 */

import {
  h, svgIcon, render, clear, toast, confirmDialog, withBusy, badge,
  loadingState, errorState, errorMessage, debounce,
} from '../ui.js';
import { parseToml, setValue, getIn } from '../tomlpatch.js';
import { PATHS, ADMIN_BASE } from '../config.js';

const FRAME_URL = new URL('cassette-frame.html', ADMIN_BASE).href;
/** 和 layouts/partials/features/background.html 里的默认值一致 */
const DEFAULT_EFFECT = 'three-body';
const DEFAULT_AUTOPLAY = 'home';

const AUTOPLAY_OPTIONS = [
  { value: 'home', label: '仅首页', hint: '只在首页自动播放；其他页面需要点左下角的按钮才会播放。' },
  { value: 'all', label: '所有页面', hint: '每个页面打开时都自动播放。' },
  { value: 'none', label: '不自动播放', hint: '默认不播放，访客可以点左下角的按钮打开。' },
];
const AUTOPLAY_LABEL = Object.fromEntries(AUTOPLAY_OPTIONS.map((o) => [o.value, o.label]));

/** 预览「屏幕」的虚拟尺寸：效果按像素绘制，所以用真实屏幕大小运行再整体缩小，看起来和网站上一样。 */
const DEVICES = {
  desktop: { w: 1280, h: 720, label: '电脑', icon: 'page' },
  phone: { w: 390, h: 844, label: '手机', icon: 'phone' },
};
const MINI_SIZE = { w: 960, h: 540 };
const READY_TIMEOUT_MS = 10000;
const TUNE_DEBOUNCE_MS = 500;
const PREF_KEY = 'admin.bg.preview';
const BOM = new RegExp('^' + String.fromCharCode(0xfeff));

// ---------------------------------------------------------------------------
// 纯函数：解析卡带文件（导出方便测试）

/** `    NAME: 123.4,   // 说明` —— 只认纯数字字面量（可带负号 / 小数 / 指数）。 */
const PARAM_RE = /^(\s*)([A-Z][A-Z0-9_]*)(\s*:\s*)(-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)(\s*,?[ \t]*(?:\/\/[ \t]?(.*?))?[ \t]*)$/;
/** `// --- ⚙️ 物理参数 (可调整) ---` 分组标题 */
const GROUP_RE = /^\s*\/\/\s*-{2,}\s*(.*?)\s*-{2,}\s*$/;

/**
 * 从卡带文件开头的文档注释里取名称和说明。
 * 约定：第 2 行是 ` * 背景效果：<中文名>`，下一行是一句说明。
 * @param {string} text
 * @returns {{ title: string, description: string }}  找不到时 title 为 ''
 */
export function parseCassetteMeta(text) {
  const m = /^\s*\/\*\*?([\s\S]*?)\*\//.exec(String(text || '').replace(BOM, ''));
  if (!m) return { title: '', description: '' };
  const lines = m[1].split('\n').map((l) => l.replace(/^\s*\*?[ \t]?/, '').trim());
  const idx = lines.findIndex((l) => /^背景效果\s*[：:]/.test(l));
  if (idx < 0) return { title: '', description: '' };
  const title = lines[idx].replace(/^背景效果\s*[：:]\s*/, '').trim();
  const desc = [];
  for (let i = idx + 1; i < lines.length; i++) {
    const l = lines[i];
    if (!l || /^接口约定/.test(l) || /^@/.test(l)) break;
    desc.push(l);
  }
  return { title, description: desc.join('') };
}

/**
 * 找出卡带里可以调的数字参数。
 * @param {string} text
 * @returns {Array<{ key: string, line: number, raw: string, value: number, label: string, comment: string, group: string }>}
 *   line 是 0 开始的行号；重复出现的键名（含义不明确）会被跳过。
 */
export function parseCassetteParams(text) {
  const lines = String(text || '').split('\n');
  const found = [];
  const count = new Map();
  let group = '';
  let inBlock = false;
  lines.forEach((full, i) => {
    const line = full.replace(/\r$/, '');
    // 跳过 /* … */ 块注释里的内容
    if (inBlock) {
      if (line.includes('*/')) inBlock = false;
      return;
    }
    const t = line.trim();
    if (t.startsWith('/*')) {
      if (!t.includes('*/', 2)) inBlock = true;
      return;
    }
    const g = GROUP_RE.exec(line);
    if (g) { group = g[1]; return; }
    const m = PARAM_RE.exec(line);
    if (!m) return;
    const value = Number(m[4]);
    if (!Number.isFinite(value)) return;
    const comment = (m[6] || '').trim();
    count.set(m[2], (count.get(m[2]) || 0) + 1);
    found.push({ key: m[2], line: i, raw: m[4], value, label: comment || m[2], comment, group });
  });
  return found.filter((p) => count.get(p.key) === 1);
}

/**
 * 把数字写成 JS 字面量（最短的往返表示，如 0.00001、1e-7、-2.5）。
 * @param {number} n
 */
export function formatNumber(n) {
  if (Object.is(n, -0)) return '0';
  return String(n);
}

/**
 * 只改参数所在那一行的数字字面量，其他字符原样保留；改完重新解析校验。
 * @param {string} text 卡带文件原文
 * @param {Record<string, number>} values 键 → 新值（与原值相同的忽略）
 * @returns {string} 新文本；没有变化时返回原字符串（===）
 * @throws {Error} 校验失败（中文 message）
 */
export function patchCassetteParams(text, values) {
  const params = parseCassetteParams(text);
  const lines = String(text).split('\n');
  const expected = new Map();
  let changed = false;
  for (const p of params) {
    if (!Object.prototype.hasOwnProperty.call(values, p.key)) continue;
    const v = values[p.key];
    if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`参数 ${p.key} 不是有效的数字`);
    if (v === p.value) continue;
    const full = lines[p.line];
    const cr = full.endsWith('\r') ? '\r' : '';
    const m = PARAM_RE.exec(full.replace(/\r$/, ''));
    if (!m || m[2] !== p.key) throw new Error(`没能定位参数 ${p.key}，文件没有被修改`);
    lines[p.line] = m[1] + m[2] + m[3] + formatNumber(v) + m[5] + cr;
    expected.set(p.key, v);
    changed = true;
  }
  if (!changed) return text;
  const out = lines.join('\n');
  // 校验：参数列表（键、行号）不变，只有目标值变了
  const after = parseCassetteParams(out);
  const ok = after.length === params.length && after.every((q, i) => {
    const p = params[i];
    if (q.key !== p.key || q.line !== p.line) return false;
    return expected.has(q.key) ? q.value === expected.get(q.key) : q.raw === p.raw;
  });
  if (!ok) throw new Error('自动修改效果文件时校验未通过，为避免写错文件，本次修改已取消');
  return out;
}

/**
 * 从 params.toml 解析出的对象里取背景设置（语义与 Hugo 模板相同）。
 * @param {object} params
 */
export function backgroundSettings(params) {
  const bg = (params && typeof params.background === 'object' && params.background) || {};
  const autoplay = typeof bg.autoplay === 'string' && AUTOPLAY_LABEL[bg.autoplay] ? bg.autoplay
    : (bg.autoplay == null ? DEFAULT_AUTOPLAY : 'none');   // 模板里不认识的值 = 不自动播放
  return {
    enabled: !!bg.enabled,                                  // 模板：{{ if .Param "background.enabled" }}
    effect: typeof bg.effect === 'string' && bg.effect ? bg.effect : DEFAULT_EFFECT,
    autoplay,
  };
}

function parseNum(s) {
  const t = String(s ?? '').trim();
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

function stepFor(raw) {
  if (/e/i.test(raw)) return 'any';
  const dec = (raw.split('.')[1] || '').length;
  if (!dec) return '1';
  return (1 / 10 ** dec).toFixed(dec);
}

function readPrefs() {
  try {
    const v = JSON.parse(localStorage.getItem(PREF_KEY) || 'null');
    return v && typeof v === 'object' ? v : {};
  } catch { return {}; }
}

function writePrefs(p) {
  try { localStorage.setItem(PREF_KEY, JSON.stringify(p)); } catch { /* 隐私模式等 */ }
}

// ---------------------------------------------------------------------------
// 视图

/**
 * @param {HTMLElement} container
 * @param {object} params
 * @param {object} ctx
 */
export default async function mount(container, params, ctx) {
  const { repo } = ctx;
  const root = h('div', { class: 'bga-view', dataset: { testid: 'bg-view' } });
  container.appendChild(root);
  render(root, h('div', { class: 'bga-loading' }, loadingState('正在读取背景动画…')));

  const prefs = readPrefs();
  const systemDark = typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches;

  const st = {
    disposed: false,
    data: null,            // loadAll() 的结果
    base: null,            // 网站上现在的设置 { enabled, effect, autoplay }
    form: null,            // 用户正在编辑的设置
    values: new Map(),     // effect name → { KEY: '输入框里的文字' }（只记录用户动过的）
    selected: null,        // 正在大预览里看的效果
    theme: prefs.theme === 'dark' || prefs.theme === 'light' ? prefs.theme : (systemDark ? 'dark' : 'light'),
    // 没选过时：在手机上管理就默认看手机屏幕的效果
    device: DEVICES[prefs.device] ? prefs.device
      : (typeof matchMedia === 'function' && matchMedia('(max-width: 760px)').matches ? 'phone' : 'desktop'),
    previews: new Set(),
    io: null,
  };
  const ui = {};

  // 所有预览 iframe 的消息都从这里分发（按 event.source 找到对应的 iframe）
  const onWindowMessage = (ev) => {
    for (const p of st.previews) {
      if (p.iframe && ev.source === p.iframe.contentWindow) { p.handle(ev.data); return; }
    }
  };
  window.addEventListener('message', onWindowMessage);

  const restartLarge = debounce(() => { if (ui.large) ui.large.restart(); }, TUNE_DEBOUNCE_MS);

  try {
    st.data = await loadAll();
  } catch (err) {
    if (err && err.status === 401) throw err;   // 外壳会跳到登录页
    console.error('[background] load failed', err);
    if (st.disposed) return {};
    render(root, h('div', { class: 'card' }, errorState('没能读取背景动画设置', {
      detail: errorMessage(err),
      retry: () => ctx.navigate('#/background', { replace: true }),
    })));
    return cleanupOnly();
  }
  if (st.disposed) return {};
  st.base = backgroundSettings(st.data.config);
  st.form = { ...st.base };
  st.selected = pickInitialSelection();
  buildUi();

  // -------------------------------------------------------------------------
  // 读取

  /** 读取 params.toml、languages.toml、core.js 和所有效果文件。 */
  async function loadAll() {
    const paramsEntry = repo.entry(PATHS.params);
    if (!paramsEntry) throw new Error(`仓库里找不到 ${PATHS.params}`);
    const effectEntries = repo.list(PATHS.effects + '/')
      .filter((e) => /^[^/]+\.js$/.test(e.path.slice(PATHS.effects.length + 1)));
    const [paramsText, langText, coreText, effectTexts] = await Promise.all([
      repo.readText(PATHS.params),
      repo.has(PATHS.languages) ? repo.readText(PATHS.languages).catch(() => null) : Promise.resolve(null),
      repo.has(PATHS.bgCore) ? repo.readText(PATHS.bgCore) : Promise.resolve(null),
      Promise.all(effectEntries.map((e) => repo.readText(e.path))),
    ]);
    let config;
    try {
      config = parseToml(paramsText);
    } catch (err) {
      throw new Error(`${PATHS.params} 的格式有误，无法读取：${errorMessage(err)}`);
    }
    // 各语言在 languages.toml 里单独设置的背景（那里的设置优先于 params.toml）
    const overrides = [];
    if (langText) {
      try {
        const langs = parseToml(langText);
        for (const lang of ctx.langs || Object.keys(langs)) {
          const o = getIn(langs, [lang, 'params', 'background']);
          if (o && typeof o === 'object' && Object.keys(o).length) overrides.push({ lang, keys: Object.keys(o) });
        }
      } catch { /* languages.toml 有问题时外壳会提示，这里不重复 */ }
    }
    const effects = effectEntries.map((e, i) => {
      const text = effectTexts[i];
      const name = e.path.slice(PATHS.effects.length + 1).replace(/\.js$/, '');
      const meta = parseCassetteMeta(text);
      return {
        name,
        path: e.path,
        sha: e.sha,
        text,
        title: meta.title || name,
        description: meta.description,
        params: parseCassetteParams(text),
      };
    });
    return {
      params: { path: PATHS.params, sha: paramsEntry.sha, text: paramsText },
      config,
      core: coreText,
      effects,
      overrides,
    };
  }

  function pickInitialSelection() {
    const names = st.data.effects.map((e) => e.name);
    if (params && params.effect && names.includes(params.effect)) return params.effect;
    if (names.includes(st.form.effect)) return st.form.effect;
    return names[0] || null;
  }

  // -------------------------------------------------------------------------
  // 状态工具

  function effectByName(name) { return st.data.effects.find((e) => e.name === name) || null; }
  function titleOf(name) { return (effectByName(name) || {}).title || name; }

  function inputValue(eff, p) {
    const v = st.values.get(eff.name);
    return v && Object.prototype.hasOwnProperty.call(v, p.key) ? v[p.key] : p.raw;
  }

  /** 'changed' | 'invalid' | null */
  function paramState(eff, p) {
    const v = st.values.get(eff.name);
    if (!v || !Object.prototype.hasOwnProperty.call(v, p.key)) return null;
    const n = parseNum(v[p.key]);
    if (n === null) return 'invalid';
    return n === p.value ? null : 'changed';
  }

  function tunedParams(eff) {
    return eff.params.filter((p) => paramState(eff, p) !== null);
  }

  function invalidParams(eff) {
    return eff.params.filter((p) => paramState(eff, p) === 'invalid');
  }

  /** 当前输入下的卡带代码（输入有误的参数用文件里的值）。 */
  function effectText(eff) {
    const vals = {};
    for (const p of eff.params) {
      if (paramState(eff, p) === 'changed') vals[p.key] = parseNum(st.values.get(eff.name)[p.key]);
    }
    try {
      return patchCassetteParams(eff.text, vals);
    } catch (err) {
      console.warn('[background] patch failed', err);
      return eff.text;
    }
  }

  function codeFor(name) {
    const eff = effectByName(name);
    if (!eff || !st.data.core) return '';
    return st.data.core + '\n' + effectText(eff);
  }

  function settingsChanges() {
    return ['enabled', 'effect', 'autoplay'].filter((k) => st.form[k] !== st.base[k]);
  }

  function isDirty() {
    if (!st.base || !st.form || !st.data) return false;
    return settingsChanges().length > 0 || st.data.effects.some((e) => tunedParams(e).length > 0);
  }

  /** 给用户看的改动清单 */
  function changeLines() {
    const lines = [];
    for (const k of settingsChanges()) {
      if (k === 'enabled') lines.push(st.form.enabled ? '开启背景动画' : '关闭背景动画');
      if (k === 'effect') lines.push(`效果：${titleOf(st.base.effect)} → ${titleOf(st.form.effect)}`);
      if (k === 'autoplay') lines.push(`自动播放：${AUTOPLAY_LABEL[st.base.autoplay]} → ${AUTOPLAY_LABEL[st.form.autoplay]}`);
    }
    for (const eff of st.data.effects) {
      const tuned = tunedParams(eff);
      if (!tuned.length) continue;
      const parts = tuned.map((p) => {
        const raw = st.values.get(eff.name)[p.key];
        return `${p.comment || p.key} ${p.raw} → ${paramState(eff, p) === 'invalid' ? '（无效）' : String(raw).trim()}`;
      });
      lines.push(`${eff.title}参数：${parts.join('，')}`);
    }
    return lines;
  }

  // -------------------------------------------------------------------------
  // 预览 iframe

  /**
   * 在 stage 里放一个沙箱 iframe，按虚拟屏幕尺寸运行再缩放到 stage 的宽度。
   * @param {{ stage: HTMLElement, size: () => {w:number,h:number}, name: () => string|null, title: string, testid: string, onState?: Function }} opt
   */
  function createPreview(opt) {
    const status = h('div', { class: 'bga-stage-status' });
    opt.stage.appendChild(status);
    let ro = null;
    const p = {
      iframe: null,
      runId: 0,
      timer: null,
      paused: false,
      handle(data) {
        if (!data || typeof data !== 'object' || typeof data.type !== 'string') return;
        if (data.type === 'ready') {
          const code = codeFor(opt.name());
          if (!code) {
            setState('error', st.data.core ? '没有可以预览的效果' : `找不到动画引擎 ${PATHS.bgCore}，无法预览`);
            return;
          }
          post({ type: 'run', code, dark: st.theme === 'dark' });
          if (p.paused) post({ type: 'pause' });
        } else if (data.type === 'started') {
          clearTimeout(p.timer);
          setState('running');
        } else if (data.type === 'error') {
          clearTimeout(p.timer);
          setState('error', `这个效果的代码运行出错：${String(data.message || '').slice(0, 200)}`);
        }
      },
      restart() {
        if (st.disposed) return;
        clearTimeout(p.timer);
        if (p.iframe) p.iframe.remove();
        const size = opt.size();
        opt.stage.style.setProperty('--bga-vw', String(size.w));
        opt.stage.style.aspectRatio = `${size.w} / ${size.h}`;
        p.runId++;
        const iframe = h('iframe', {
          class: 'bga-frame',
          sandbox: 'allow-scripts',
          src: FRAME_URL,
          title: opt.title,
          width: String(size.w),
          height: String(size.h),
          tabindex: '-1',
          referrerpolicy: 'no-referrer',
          style: { width: `${size.w}px`, height: `${size.h}px` },
          dataset: { testid: opt.testid },
        });
        p.iframe = iframe;
        opt.stage.dataset.run = String(p.runId);
        setState('loading');
        opt.stage.insertBefore(iframe, status);
        applyScale();
        p.timer = setTimeout(() => {
          if (opt.stage.dataset.state === 'loading') setState('error', '预览没有加载出来，请点「重新开始」再试一次');
        }, READY_TIMEOUT_MS);
      },
      setPaused(paused) {
        if (p.paused === paused) return;
        p.paused = paused;
        post({ type: paused ? 'pause' : 'resume' });
      },
      destroy() {
        clearTimeout(p.timer);
        if (ro) ro.disconnect();
        if (p.iframe) p.iframe.remove();
        p.iframe = null;
        st.previews.delete(p);
      },
    };
    function post(msg) {
      try { if (p.iframe && p.iframe.contentWindow) p.iframe.contentWindow.postMessage(msg, '*'); } catch { /* ignore */ }
    }
    function setState(state, text) {
      opt.stage.dataset.state = state;
      clear(status);
      if (state === 'loading') status.append(h('span', { class: 'spinner', 'aria-hidden': 'true' }));
      if (state === 'error') status.append(svgIcon('warning'), h('span', {}, text || '预览出错'));
      status.hidden = state === 'running';
      if (opt.onState) opt.onState(state);
    }
    function applyScale() {
      const w = opt.stage.clientWidth;
      const size = opt.size();
      if (w > 0) opt.stage.style.setProperty('--bga-scale', String(w / size.w));
    }
    if (typeof ResizeObserver === 'function') {
      ro = new ResizeObserver(applyScale);
      ro.observe(opt.stage);
    }
    st.previews.add(p);
    return p;
  }

  function destroyPreviews() {
    for (const p of [...st.previews]) p.destroy();
    if (st.io) { st.io.disconnect(); st.io = null; }
    ui.large = null;
  }

  // -------------------------------------------------------------------------
  // 界面

  function buildUi() {
    destroyPreviews();
    restartLarge.cancel();
    const saveBtn = h('button', { type: 'button', class: 'btn btn-primary', dataset: { testid: 'bg-save' } }, svgIcon('send'), '保存并发布');
    const discardBtn = h('button', { type: 'button', class: 'btn btn-ghost', dataset: { testid: 'bg-discard' } }, '放弃修改');
    // save() 结束时会 refresh()，withBusy 会保留它设置的 disabled（发布成功 → 没有改动 → 禁用）
    saveBtn.addEventListener('click', () => withBusy(saveBtn, save));
    discardBtn.addEventListener('click', discardAll);
    ui.saveBtn = saveBtn;
    ui.discardBtn = discardBtn;
    ui.saveText = h('span', { class: 'bga-savebar-text', dataset: { testid: 'bg-save-hint' } });

    ui.banners = h('div', { class: 'bga-banners stack-sm' });
    ui.cards = new Map();
    const hasEffects = st.data.effects.length > 0;

    render(root,
      h('div', { class: 'page-header' },
        h('div', {},
          h('h1', {}, '背景动画'),
          h('p', { class: 'page-desc' }, '网站背景上的动态效果。选一个效果、按需微调参数，点「保存并发布」，约 1–2 分钟后生效。'))),
      ui.banners,
      settingsCard(),
      h('section', { class: 'bga-section', 'aria-labelledby': 'bga-pick-title' },
        h('div', { class: 'bga-section-head' },
          h('h2', { class: 'bga-section-title', id: 'bga-pick-title' }, '选择效果'),
          h('span', { class: 'muted small' }, hasEffects ? `共 ${st.data.effects.length} 个，点卡片在下方放大预览` : '')),
        hasEffects
          ? h('div', { class: 'bga-cards', role: 'radiogroup', 'aria-label': '预览哪个效果', dataset: { testid: 'bg-cards' } },
            st.data.effects.map(cassetteCard))
          : h('div', { class: 'card' }, h('div', { class: 'empty' },
            h('div', { class: 'empty-icon' }, svgIcon('background')),
            h('div', { class: 'empty-text' }, `${PATHS.effects}/ 里还没有效果文件`)))),
      hasEffects ? h('div', { class: 'bga-detail' }, previewCard(), tuningCard()) : null,
      ui.savebar = h('div', { class: 'bga-savebar', dataset: { testid: 'bg-savebar' } },
        ui.saveText, h('div', { class: 'bga-savebar-actions' }, discardBtn, saveBtn)));

    startMiniPreviews();
    if (ui.large) ui.large.restart();
    refresh();
  }

  // ---- 网站设置 ----
  function settingsCard() {
    const enabled = h('input', { type: 'checkbox', id: 'bga-enabled', checked: st.form.enabled, dataset: { testid: 'bg-enabled' } });
    enabled.addEventListener('change', () => {
      st.form.enabled = enabled.checked;
      refresh();
    });
    ui.enabled = enabled;
    ui.enabledHint = h('div', { class: 'hint' });

    ui.autoplay = new Map();
    const pills = h('div', { class: 'tabs tabs-pill bga-pills', role: 'radiogroup', 'aria-labelledby': 'bga-autoplay-label' },
      AUTOPLAY_OPTIONS.map((o) => {
        const b = h('button', {
          type: 'button', class: 'tab', role: 'radio', dataset: { testid: `bg-autoplay-${o.value}`, value: o.value },
        }, o.label);
        b.addEventListener('click', () => { st.form.autoplay = o.value; refresh(); });
        b.addEventListener('keydown', (e) => radioKeys(e, pills, (btn) => btn.click()));
        ui.autoplay.set(o.value, b);
        return b;
      }));
    ui.autoplayHint = h('div', { class: 'hint' });
    ui.currentEffect = h('span', { class: 'bga-current', dataset: { testid: 'bg-current-effect' } });

    return h('section', { class: 'card bga-settings', dataset: { testid: 'bg-settings' } },
      h('div', { class: 'card-header' },
        h('h2', { class: 'card-title' }, svgIcon('settings'), '网站设置'),
        ui.currentEffect),
      h('div', { class: 'bga-settings-grid' },
        h('div', { class: 'bga-setting' },
          h('div', { class: 'bga-setting-row' },
            h('label', { class: 'bga-setting-label', htmlFor: 'bga-enabled' }, '启用背景动画'),
            h('label', { class: 'switch' }, enabled, h('span', {}))),
          ui.enabledHint),
        h('div', { class: 'bga-setting' },
          h('div', { class: 'bga-setting-row' },
            h('span', { class: 'bga-setting-label', id: 'bga-autoplay-label' }, '自动播放'),
            pills),
          ui.autoplayHint)));
  }

  // ---- 效果卡片 ----
  function cassetteCard(eff) {
    const stage = h('div', { class: 'bga-stage bga-stage-mini', dataset: { testid: `bg-mini-${eff.name}` } });
    const badges = h('div', { class: 'bga-card-badges' });
    const card = h('div', {
      class: 'card bga-card',
      role: 'radio',
      tabindex: '0',
      'aria-label': `${eff.title}：${eff.description || eff.name}`,
      dataset: { testid: `bg-card-${eff.name}`, effect: eff.name },
    },
      h('div', { class: 'bga-card-media' }, stage, badges),
      h('div', { class: 'bga-card-body' },
        h('div', { class: 'bga-card-title-row' },
          h('h3', { class: 'bga-card-title', dataset: { testid: 'bg-card-title' } }, eff.title),
          h('span', { class: 'bga-card-check', 'aria-hidden': 'true' }, svgIcon('check'))),
        h('p', { class: 'bga-card-desc', dataset: { testid: 'bg-card-desc' } }, eff.description || '（文件开头没有写说明）'),
        h('div', { class: 'bga-card-file mono' }, `${eff.name}.js`)));
    card.addEventListener('click', () => select(eff.name));
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(eff.name); return; }
      radioKeys(e, card.parentElement, (el) => { el.focus(); select(el.dataset.effect); });
    });
    const preview = createPreview({
      stage,
      size: () => MINI_SIZE,
      name: () => eff.name,
      title: `${eff.title}（小预览）`,
      testid: `bg-mini-frame-${eff.name}`,
    });
    ui.cards.set(eff.name, { card, badges, preview, stage });
    return card;
  }

  function startMiniPreviews() {
    const cards = [...ui.cards.values()];
    if (typeof IntersectionObserver === 'function') {
      // 不在屏幕上的小预览暂停，手机上省电
      st.io = new IntersectionObserver((entries) => {
        for (const en of entries) {
          const c = cards.find((x) => x.stage === en.target);
          if (c) c.preview.setPaused(!en.isIntersecting);
        }
      });
      cards.forEach((c) => st.io.observe(c.stage));
    }
    cards.forEach((c) => c.preview.restart());
  }

  // ---- 大预览 ----
  function previewCard() {
    const stage = h('div', { class: 'bga-stage bga-stage-large', dataset: { testid: 'bg-stage' } });
    ui.stageWrap = h('div', { class: 'bga-stage-wrap' }, stage);
    ui.previewTitle = h('h2', { class: 'card-title bga-preview-title', dataset: { testid: 'bg-preview-title' } });
    ui.previewDesc = h('p', { class: 'bga-preview-desc muted' });
    ui.useArea = h('div', { class: 'bga-use' });

    const seg = (items, cur, testPrefix, onPick) => {
      const group = h('div', { class: 'tabs tabs-pill bga-seg', role: 'radiogroup' },
        items.map(([value, label, icon]) => {
          const b = h('button', {
            type: 'button', class: 'tab', role: 'radio', dataset: { testid: `${testPrefix}-${value}`, value },
          }, svgIcon(icon), label);
          b.addEventListener('click', () => onPick(value));
          b.addEventListener('keydown', (e) => radioKeys(e, group, (btn) => btn.click()));
          return b;
        }));
      return group;
    };
    ui.deviceSeg = seg(Object.entries(DEVICES).map(([k, d]) => [k, d.label, d.icon]),
      st.device, 'bg-device', (v) => {
        if (st.device === v) return;
        st.device = v;
        savePrefs();
        syncToggles();
        if (ui.large) ui.large.restart();
      });
    ui.deviceSeg.setAttribute('aria-label', '预览屏幕');
    ui.themeSeg = seg([['light', '浅色', 'sun'], ['dark', '深色', 'moon']], st.theme, 'bg-theme', (v) => {
      if (st.theme === v) return;
      st.theme = v;
      savePrefs();
      syncToggles();
      restartAll();
    });
    ui.themeSeg.setAttribute('aria-label', '预览配色');
    const restartBtn = h('button', {
      type: 'button', class: 'btn btn-sm bga-restart', dataset: { testid: 'bg-restart' }, title: '从头开始播放', 'aria-label': '重新开始',
    }, svgIcon('refresh'), h('span', { class: 'hide-mobile' }, '重新开始'));
    restartBtn.addEventListener('click', () => { restartLarge.cancel(); if (ui.large) ui.large.restart(); });

    const card = h('section', { class: 'card bga-preview', dataset: { testid: 'bg-preview' } },
      h('div', { class: 'card-header bga-preview-header' },
        h('div', { class: 'bga-preview-heading' }, ui.previewTitle, ui.previewBadge = h('span', {})),
        h('div', { class: 'bga-preview-tools' }, ui.deviceSeg, ui.themeSeg, restartBtn)),
      ui.stageWrap,
      h('div', { class: 'bga-preview-foot' }, ui.previewDesc, ui.useArea));

    ui.large = createPreview({
      stage,
      size: () => DEVICES[st.device],
      name: () => st.selected,
      title: '背景动画大预览',
      testid: 'bg-stage-frame',
      onState: (state) => { ui.stageWrap.dataset.state = state; },
    });
    return card;
  }

  function restartAll() {
    restartLarge.cancel();
    for (const p of st.previews) p.restart();
  }

  function savePrefs() {
    writePrefs({ theme: st.theme, device: st.device });
  }

  function syncToggles() {
    for (const b of ui.deviceSeg.querySelectorAll('.tab')) setChecked(b, b.dataset.value === st.device);
    for (const b of ui.themeSeg.querySelectorAll('.tab')) setChecked(b, b.dataset.value === st.theme);
    ui.stageWrap.dataset.device = st.device;
    root.dataset.previewTheme = st.theme;
  }

  function select(name) {
    if (!effectByName(name)) return;
    if (st.selected === name) return;
    st.selected = name;
    restartLarge.cancel();
    rebuildTuning();
    if (ui.large) ui.large.restart();
    refresh();
  }

  // ---- 参数微调 ----
  function tuningCard() {
    ui.tuneTitle = h('h2', { class: 'card-title' }, svgIcon('palette'), '参数微调');
    ui.tuneBody = h('div', { class: 'bga-tune-body' });
    ui.resetParams = h('button', { type: 'button', class: 'btn btn-sm btn-ghost', dataset: { testid: 'bg-reset-params' } }, svgIcon('refresh'), '恢复默认');
    ui.resetParams.addEventListener('click', resetParams);
    const card = h('section', { class: 'card bga-tune', dataset: { testid: 'bg-tune' } },
      h('div', { class: 'card-header' }, ui.tuneTitle, ui.resetParams),
      ui.tuneBody);
    rebuildTuning();
    return card;
  }

  function rebuildTuning() {
    if (!ui.tuneBody) return;
    const eff = effectByName(st.selected);
    ui.paramInputs = new Map();
    if (!eff) { render(ui.tuneBody); return; }
    if (!eff.params.length) {
      render(ui.tuneBody, h('p', { class: 'muted bga-tune-empty' }, '这个效果没有可以直接调整的数字参数。'));
      return;
    }
    const groups = [];
    for (const p of eff.params) {
      let g = groups[groups.length - 1];
      if (!g || g.name !== p.group) { g = { name: p.group, items: [] }; groups.push(g); }
      g.items.push(p);
    }
    render(ui.tuneBody,
      h('p', { class: 'hint bga-tune-hint' }, `改动会马上在预览里生效。发布时只改 ${eff.name}.js 里对应的那个数字。`),
      groups.map((g) => h('div', { class: 'bga-tune-group' },
        g.name ? h('div', { class: 'bga-tune-group-title' }, g.name) : null,
        h('div', { class: 'bga-tune-grid' }, g.items.map((p) => paramField(eff, p))))));
  }

  function paramField(eff, p) {
    const id = `bga-p-${eff.name}-${p.key}`;
    const input = h('input', {
      class: 'input bga-num',
      id,
      type: 'number',
      step: stepFor(p.raw),
      inputmode: 'decimal',
      autocomplete: 'off',
      value: inputValue(eff, p),
      dataset: { testid: `bg-param-${p.key}` },
    });
    const err = h('div', { class: 'error', role: 'alert' });
    err.hidden = true;
    const dflt = h('button', {
      type: 'button', class: 'bga-default', title: '恢复这个参数的默认值', dataset: { testid: `bg-param-default-${p.key}` },
    }, `默认 ${p.raw}`);
    const field = h('div', { class: 'field bga-field' },
      h('div', { class: 'bga-field-top' },
        h('label', { htmlFor: id, class: 'bga-field-label' },
          h('span', { class: 'bga-field-name' }, p.comment || p.key),
          p.comment ? h('span', { class: 'bga-field-key mono' }, p.key) : null),
        dflt),
      input,
      err);
    const onInput = () => {
      let v = st.values.get(eff.name);
      if (!v) { v = {}; st.values.set(eff.name, v); }
      v[p.key] = input.value;
      if (parseNum(input.value) === p.value) delete v[p.key];
      if (!Object.keys(v).length) st.values.delete(eff.name);
      syncParamField(eff, p);
      refresh();
      if (paramState(eff, p) !== 'invalid') restartLarge();
    };
    input.addEventListener('input', onInput);
    dflt.addEventListener('click', () => { input.value = p.raw; onInput(); });
    ui.paramInputs.set(p.key, { field, input, err, dflt });
    syncParamField(eff, p);
    return field;
  }

  function syncParamField(eff, p) {
    const f = ui.paramInputs && ui.paramInputs.get(p.key);
    if (!f) return;
    const s = paramState(eff, p);
    f.field.classList.toggle('is-changed', s === 'changed');
    f.input.setAttribute('aria-invalid', s === 'invalid' ? 'true' : 'false');
    f.err.hidden = s !== 'invalid';
    f.err.textContent = s === 'invalid' ? '请输入一个数字' : '';
    f.dflt.disabled = s === null;
  }

  function resetParams() {
    const eff = effectByName(st.selected);
    if (!eff || !st.values.has(eff.name)) return;
    st.values.delete(eff.name);
    rebuildTuning();
    restartLarge.cancel();
    if (ui.large) ui.large.restart();
    refresh();
  }

  // ---- 刷新所有依赖状态的小部件 ----
  function refresh() {
    if (st.disposed) return;
    const f = st.form;
    // 设置卡
    ui.enabled.checked = f.enabled;
    ui.enabledHint.textContent = f.enabled
      ? '网站会加载背景动画；访客随时可以点左下角的按钮开关。'
      : '已关闭：网站不会加载任何背景动画（文章里单独设置的也不生效）。';
    for (const [v, b] of ui.autoplay) {
      setChecked(b, v === f.autoplay);
      b.disabled = !f.enabled;
    }
    ui.autoplayHint.textContent = (AUTOPLAY_OPTIONS.find((o) => o.value === f.autoplay) || {}).hint || '';
    const curExists = !!effectByName(f.effect);
    render(ui.currentEffect,
      h('span', { class: 'muted' }, '网站背景：'),
      f.enabled ? h('strong', {}, titleOf(f.effect)) : h('span', { class: 'muted' }, '已关闭'),
      f.effect !== st.base.effect || f.enabled !== st.base.enabled ? badge('未发布', 'orange') : null);

    // 提示条
    clear(ui.banners);
    if (!curExists && st.data.effects.length) {
      ui.banners.append(h('div', { class: 'banner banner-warning', dataset: { testid: 'bg-missing-effect' } }, svgIcon('warning'),
        h('span', {}, `配置里的效果「${f.effect}」在 ${PATHS.effects}/ 里不存在，网站构建会失败。请在下面选一个效果，点「用作网站背景」后发布。`)));
    }
    if (!st.data.core) {
      ui.banners.append(h('div', { class: 'banner banner-warning' }, svgIcon('warning'),
        h('span', {}, `找不到动画引擎 ${PATHS.bgCore}，无法预览，网站上的背景动画也不会工作。`)));
    }
    for (const o of st.data.overrides) {
      ui.banners.append(h('div', { class: 'banner banner-info', dataset: { testid: 'bg-lang-override' } }, svgIcon('info'),
        h('span', {}, `${ctx.siteLabel ? ctx.siteLabel(o.lang) : o.lang} 在 ${PATHS.languages} 里单独设置了背景动画（${o.keys.join('、')}），那些设置在该站优先于这里。`)));
    }

    // 卡片
    for (const [name, c] of ui.cards) {
      const sel = name === st.selected;
      c.card.classList.toggle('is-selected', sel);
      c.card.setAttribute('aria-checked', sel ? 'true' : 'false');
      c.card.tabIndex = sel || (!effectByName(st.selected) && name === st.data.effects[0].name) ? 0 : -1;
      const eff = effectByName(name);
      clear(c.badges);
      if (name === st.base.effect && st.base.enabled) c.badges.append(badge('使用中', 'green'));
      else if (name === st.base.effect) c.badges.append(badge('已选（动画已关闭）', 'gray'));
      if (name === f.effect && f.effect !== st.base.effect) c.badges.append(badge('发布后启用', 'orange'));
      if (tunedParams(eff).length) c.badges.append(badge('参数已改', 'blue'));
      c.badges.querySelectorAll('.badge').forEach((b) => { b.dataset.testid = 'bg-card-badge'; });
    }

    // 大预览
    const eff = effectByName(st.selected);
    if (eff && ui.previewTitle) {
      ui.previewTitle.textContent = eff.title;
      ui.previewDesc.textContent = eff.description;
      clear(ui.previewBadge);
      if (eff.name === st.base.effect && st.base.enabled) ui.previewBadge.append(badge('使用中', 'green'));
      syncToggles();
      clear(ui.useArea);
      if (f.effect === eff.name) {
        ui.useArea.append(h('span', { class: 'bga-in-use', dataset: { testid: 'bg-in-use' } }, svgIcon('check'),
          f.effect === st.base.effect ? '网站背景正在使用这个效果' : '已选为网站背景，发布后生效'));
      } else {
        const use = h('button', { type: 'button', class: 'btn btn-primary btn-sm', dataset: { testid: 'bg-use' } }, svgIcon('check'), '用作网站背景');
        use.addEventListener('click', () => {
          st.form.effect = eff.name;
          if (!st.form.enabled) st.form.enabled = true;   // 选了效果却还关着，多半是想打开
          refresh();
        });
        ui.useArea.append(use);
      }
      ui.tuneTitle.textContent = '';
      ui.tuneTitle.append(svgIcon('palette'), '参数微调', h('span', { class: 'bga-tune-of muted' }, `· ${eff.title}`));
      ui.resetParams.disabled = !st.values.has(eff.name);
    }

    // 保存栏
    const dirty = isDirty();
    const lines = dirty ? changeLines() : [];
    ui.saveBtn.disabled = !dirty;
    if (ui.savebar) ui.savebar.classList.toggle('is-clean', !dirty);
    ui.discardBtn.hidden = !dirty;
    ui.saveText.classList.toggle('is-dirty', dirty);
    ui.saveText.textContent = dirty
      ? `有 ${lines.length} 项修改未发布：${lines.join('；')}`
      : '没有未发布的修改';
    ui.saveText.title = dirty ? lines.join('\n') : '';
  }

  // -------------------------------------------------------------------------
  // 放弃 / 发布

  async function discardAll() {
    if (!isDirty()) return;
    const ok = await confirmDialog({
      title: '放弃所有修改？',
      message: '会恢复成网站上现在的背景动画设置和参数。',
      okText: '放弃修改',
      danger: true,
    });
    if (!ok || st.disposed) return;
    st.form = { ...st.base };
    st.values.clear();
    buildUi();
  }

  function buildPlan() {
    const changes = [];
    let text = st.data.params.text;
    for (const k of settingsChanges()) text = setValue(text, 'background', k, st.form[k]);
    const patched = new Map();
    if (text !== st.data.params.text) {
      changes.push({ path: st.data.params.path, content: text, baseSha: st.data.params.sha });
    }
    for (const eff of st.data.effects) {
      if (!tunedParams(eff).length) continue;
      const vals = {};
      for (const p of eff.params) {
        if (paramState(eff, p) === 'changed') vals[p.key] = parseNum(st.values.get(eff.name)[p.key]);
      }
      const out = patchCassetteParams(eff.text, vals);
      if (out !== eff.text) {
        patched.set(eff.name, out);
        changes.push({ path: eff.path, content: out, baseSha: eff.sha });
      }
    }
    return { changes, paramsText: text, patched };
  }

  function commitMessage() {
    const parts = [];
    const ch = settingsChanges();
    if (ch.includes('effect')) parts.push(`换成「${titleOf(st.form.effect)}」`);
    if (ch.includes('enabled')) parts.push(st.form.enabled ? '开启' : '关闭');
    if (ch.includes('autoplay')) parts.push(`自动播放改为「${AUTOPLAY_LABEL[st.form.autoplay]}」`);
    const tuned = st.data.effects.filter((e) => tunedParams(e).length).map((e) => e.title);
    if (tuned.length) parts.push(`调整「${tuned.join('」「')}」参数`);
    return `admin: 背景动画${parts.length ? ' ' + parts.join('，') : '设置'}`;
  }

  async function save() {
    if (st.disposed || !isDirty()) return;
    if (ctx.isPublishing && ctx.isPublishing()) { toast('正在发布，请稍候', { type: 'info' }); return; }
    // 参数输入有误 → 先改正
    for (const eff of st.data.effects) {
      const bad = invalidParams(eff);
      if (!bad.length) continue;
      if (st.selected !== eff.name) select(eff.name);
      toast(`「${eff.title}」有 ${bad.length} 个参数不是有效的数字，请改正后再发布`, { type: 'warning' });
      const f = ui.paramInputs && ui.paramInputs.get(bad[0].key);
      if (f) { f.input.scrollIntoView({ block: 'center', behavior: 'smooth' }); f.input.focus({ preventScroll: true }); }
      return;
    }
    if (st.form.enabled && !effectByName(st.form.effect)) {
      toast(`效果「${st.form.effect}」不存在，请先选一个效果并点「用作网站背景」`, { type: 'warning' });
      return;
    }
    let plan;
    try {
      plan = buildPlan();
    } catch (err) {
      console.error('[background] patch failed', err);
      toast(`没能生成修改后的文件，什么都没有改：${errorMessage(err)}`, { type: 'error', timeout: 9000 });
      return;
    }
    if (!plan.changes.length) {
      toast('这些修改和网站上现在的一样，不需要发布', { type: 'info' });
      return;
    }
    const lines = changeLines();
    let res;
    try {
      res = await ctx.publish({ message: commitMessage(), changes: plan.changes, summary: lines });
    } catch {
      return;   // 外壳已经提示了错误；修改都还在，可以再点一次
    }
    if (st.disposed) return;
    if (res && res.conflict) {
      if (res.reloaded) await reloadKeepingEdits();
      return;
    }
    // 成功：刚发布的内容就是新的基准
    const shas = (res && res.shas) || {};
    const entrySha = (p, fallback) => shas[p] || (repo.entry(p) || {}).sha || fallback;
    if (plan.paramsText !== st.data.params.text) {
      st.data.params = { ...st.data.params, text: plan.paramsText, sha: entrySha(st.data.params.path, st.data.params.sha) };
      try { st.data.config = parseToml(plan.paramsText); } catch { /* 刚刚校验过 */ }
    }
    for (const eff of st.data.effects) {
      const out = plan.patched.get(eff.name);
      if (out == null) continue;
      eff.text = out;
      eff.sha = entrySha(eff.path, eff.sha);
      eff.params = parseCassetteParams(out);
    }
    st.base = backgroundSettings(st.data.config);
    st.form = { ...st.base };
    st.values.clear();
    rebuildTuning();
    refresh();
  }

  /** 冲突后外壳已重新读取仓库：读最新文件，保留用户改过的项。 */
  async function reloadKeepingEdits() {
    let fresh;
    try {
      fresh = await loadAll();
    } catch (err) {
      toast(`没能读取最新版本：${errorMessage(err)}`, { type: 'error' });
      return;
    }
    if (st.disposed) return;
    const oldBase = st.base;
    const newBase = backgroundSettings(fresh.config);
    const form = { ...newBase };
    for (const k of ['enabled', 'effect', 'autoplay']) {
      if (st.form[k] !== oldBase[k]) form[k] = st.form[k];
    }
    // 参数：用户动过的键，如果新文件里还有，就保留用户的输入
    const values = new Map();
    for (const eff of fresh.effects) {
      const old = st.values.get(eff.name);
      if (!old) continue;
      const keep = {};
      for (const p of eff.params) {
        if (Object.prototype.hasOwnProperty.call(old, p.key) && parseNum(old[p.key]) !== p.value) keep[p.key] = old[p.key];
      }
      if (Object.keys(keep).length) values.set(eff.name, keep);
    }
    st.data = fresh;
    st.base = newBase;
    st.form = form;
    st.values = values;
    if (!effectByName(st.selected)) st.selected = pickInitialSelection();
    buildUi();
    toast(isDirty()
      ? '已读取网站上的最新版本，你的修改还在。请检查后再点一次「保存并发布」'
      : '已读取网站上的最新版本（和你的修改相同，不需要再发布）', { type: 'info', timeout: 7000 });
  }

  // -------------------------------------------------------------------------

  function cleanupOnly() {
    return { unmount: dispose };
  }

  function dispose() {
    st.disposed = true;
    restartLarge.cancel();
    window.removeEventListener('message', onWindowMessage);
    destroyPreviews();
  }

  return {
    isDirty,
    async canLeave() {
      if (!isDirty()) return true;
      return confirmDialog({
        title: '背景动画的修改还没有发布',
        message: '离开后，刚才的修改会丢失。确定要离开吗？',
        okText: '仍然离开',
        cancelText: '留下来',
        danger: true,
      });
    },
    unmount: dispose,
  };
}

// ---------------------------------------------------------------------------
// 小工具

function setChecked(btn, on) {
  btn.classList.toggle('active', on);
  btn.setAttribute('aria-checked', on ? 'true' : 'false');
  btn.tabIndex = on ? 0 : -1;
}

/** radiogroup 的方向键切换（← → ↑ ↓ Home End）。 */
function radioKeys(e, group, activate) {
  const keys = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };
  if (!(e.key in keys) && e.key !== 'Home' && e.key !== 'End') return;
  if (!group) return;
  const items = [...group.querySelectorAll('[role="radio"]')].filter((el) => !el.disabled);
  if (!items.length) return;
  const i = items.indexOf(e.currentTarget);
  let next;
  if (e.key === 'Home') next = items[0];
  else if (e.key === 'End') next = items[items.length - 1];
  else next = items[(i + keys[e.key] + items.length) % items.length];
  e.preventDefault();
  next.focus();
  activate(next);
}
