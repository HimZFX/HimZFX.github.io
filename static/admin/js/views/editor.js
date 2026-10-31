/**
 * views/editor.js — 文章 / 页面编辑器（ADMIN_SPEC §6.2）。
 *
 * 路由：
 *   #/edit?path=<仓库路径>         打开已有文件（同一页面的所有语言版本作为标签页）
 *   #/edit?new=post                写新文章（共用版本 content/posts/<文件名>.md）
 *   #/edit?new=page&dir=<目录>     新建栏目首页（<目录>/_index.md）
 *   #/edit?draft=<草稿 key>        继续编辑一份本机草稿（drafts.js）
 *
 * 数据模型：一个「页面组」（content.groupPages）的每个版本（共用 / 中文专属 / 英文专属）是一个 variant，
 * 各自保存：原始 front matter 文本（fmText，保存时用 frontmatter.setFields 只改动变化的键，注释原样保留）、
 * 原始正文（rawBody，没改正文时原样写回，保证字节级不变）、表单字段（form / baseForm）、编辑中的 Markdown。
 *
 * 图片：粘贴 / 拖入 / 上传的图片先压缩，以 Blob 形式留在内存（media），编辑器里用 blob: 地址显示；
 * 保存时把 blob 地址换成网站路径 /images/posts/<文件名>/<图片名>，图片和文章在同一次提交里上传。
 * 本机自动保存时 blob 地址换成 admin-pending://<图片名> 占位，图片 Blob 一起存进 IndexedDB。
 *
 * 安全（§2.3）：界面全部用 h() / textContent 生成；正文 HTML 只由 Vditor 自己渲染（例外 c），
 * 预览只写进无脚本的沙箱 iframe（preview.js，例外 b）。
 *
 * @module views/editor
 */

import {
  h, svgIcon, render, toast, modal, confirmDialog, debounce, withBusy, errorMessage, loadingState,
  errorState, formatDate, formatBytes, badge,
} from '../ui.js';
import { VDITOR_CDN, PATHS, LIMITS } from '../config.js';
import * as C from '../content.js';
import {
  splitDocument, parseFrontMatter, setFields, buildDocument, newFrontMatter, FrontMatterError,
} from '../frontmatter.js';
import { compressImage, timestampName, safeFileName, extOf } from '../images.js';
import * as drafts from '../drafts.js';
import { parseToml } from '../tomlpatch.js';
import { renderPreview, ensureVditor, loadIconScript } from '../preview.js';

// ---------------------------------------------------------------------------
// 常量

const PENDING = 'admin-pending://';
const IMAGE_EXTS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'avif', 'bmp', 'heic', 'heif']);
const MB = 1024 * 1024;

/**
 * 本次会话里刚上传过的图片：网站路径 → Blob。
 * 发表后网站要 1–2 分钟才会部署好，这期间重新打开文章时，用这里的 Blob 显示图片（而不是一张裂图）。
 */
const recentUploads = new Map();

// 工具栏自定义按钮的图标（写死的 SVG 字符串，ADMIN_SPEC §2.3 例外 a）
const ICON_FORMULA = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 5H7l6 7-6 7h11"/></svg>';
const ICON_DOCS = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="M12 17v-6M9.5 13.5L12 11l2.5 2.5"/></svg>';

const pad2 = (n) => String(n).padStart(2, '0');

/** Date → 'YYYY-MM-DDTHH:mm:ss+08:00'（使用浏览器的时区偏移）。 */
function hugoDate(d = new Date()) {
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const abs = Math.abs(off);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}` +
    `${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`;
}

/** front matter 里的日期字符串 → datetime-local 输入框的值（本地时间）；无法解析 → ''。 */
function toLocalInput(s) {
  const str = String(s || '').trim();
  if (!str) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(str);
  if (m) return `${m[1]}-${m[2]}-${m[3]}T00:00`;
  const d = new Date(str);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

const isPlainObject = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
const str = (v) => (v == null ? '' : typeof v === 'string' ? v : String(v));
const strList = (v) => (Array.isArray(v) ? v.map(str).filter(Boolean) : typeof v === 'string' && v ? [v] : []);
const clone = (v) => JSON.parse(JSON.stringify(v ?? null));
const sameList = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

/** Go 模板 `if .Param "math"` 的真假判断（字符串非空即为真）。 */
function goTruthy(v) {
  if (v == null) return false;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') return v !== '';
  return true;
}

/** 只允许 http(s)、blob、站内路径作为 img src（防止仓库内容里写 javascript: 之类的地址）。 */
function safeUrl(u, siteUrl) {
  const s = String(u || '').trim();
  if (!s) return null;
  if (/^(https?:|blob:)/i.test(s)) return s;
  if (/^[a-z][a-z0-9+.-]*:/i.test(s)) return null;
  try { return new URL(s.replace(/^\/+/, ''), siteUrl).href; } catch { return null; }
}

function isImageFile(file) {
  return (file.type || '').startsWith('image/') || IMAGE_EXTS.has(extOf(file.name || ''));
}

/** 文件名去掉扩展名（用作图片的替代文字）。 */
function stemOf(name) {
  const n = String(name || '').replace(/^.*[\\/]/, '');
  const i = n.lastIndexOf('.');
  return (i > 0 ? n.slice(0, i) : n) || 'image';
}

/** Markdown 链接文字里的 [ ] 会破坏语法。 */
const linkText = (s) => String(s || '').replace(/[[\]\n\r]/g, ' ').trim() || '文件';

// ---------------------------------------------------------------------------
// 入口

/**
 * @param {HTMLElement} container
 * @param {Record<string,string>} params
 * @param {object} ctx
 */
export default async function mount(container, params, ctx) {
  container.classList.add('editor-view');
  render(container, h('div', { class: 'card ed-loading' }, loadingState('正在打开编辑器…')));
  const ed = new Editor(container, params || {}, ctx);
  try {
    await ed.init();
  } catch (err) {
    console.error('[editor] open failed', err);
    if (err && err.status === 401) throw err; // 交给外壳处理登录失效
    ed.destroy();
    ed.renderFatal(err && err.userTitle ? err.userTitle : '没能打开这篇内容', errorMessage(err));
    return {};
  }
  return {
    unmount: () => ed.destroy(),
    canLeave: () => ed.canLeave(),
    isDirty: () => ed.isDirty(),
  };
}

function userError(title, message) {
  const e = new Error(message);
  e.userTitle = title;
  return e;
}

// ---------------------------------------------------------------------------

class Editor {
  constructor(container, params, ctx) {
    this.container = container;
    this.params = params;
    this.ctx = ctx;
    this.repo = ctx.repo;
    this.langs = ctx.langs && ctx.langs.length ? ctx.langs : ['zh', 'en'];
    /** @type {Map<string, any>} 'shared' | 'zh' | 'en' → variant */
    this.variants = new Map();
    this.activeKey = null;
    this.kind = 'post';               // 'post' | 'page'
    this.isNewGroup = false;          // 还没保存过的新文章 / 新页面
    this.group = null;                // { key, dir, base, isIndex, variants }
    this.slug = { value: '', touched: false };
    this.newKey = null;               // 新文章的草稿 key（new:…）
    this.orphanDrafts = [];           // 尚不存在的语言版本的本机草稿
    /** @type {Map<string, { blob: Blob, url: string|null, kind: 'image'|'doc', committed: boolean }>} */
    this.media = new Map();
    this.urlToName = new Map();
    this.vd = null;
    this.els = {};
    this.destroyed = false;
    this.leaving = false;
    this.saving = false;
    this.autosaveOk = true;
    this.lastAutosave = null;
    this.siteDefaults = { math: true, comments: false, effect: '' };
    this.effects = [];
    this.effectNames = {};
    this.autosave = debounce(() => { this.autosaveNow(); }, 1000);
    this.onKeyDown = this.onKeyDown.bind(this);
    this.onHidden = (e) => { if (e.type === 'pagehide' || document.visibilityState === 'hidden') this.flushAutosave(); };
    this.mq = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null;
  }

  // =========================================================================
  // 打开

  async init() {
    const p = this.params;
    const [defaults] = await Promise.all([this.readSiteDefaults(), ensureVditor()]);
    this.siteDefaults = defaults;
    this.effects = this.repo.list(PATHS.effects + '/')
      .map((e) => e.path.slice(PATHS.effects.length + 1))
      .filter((n) => n.endsWith('.js') && !n.includes('/'))
      .map((n) => n.slice(0, -3));
    this.collectBases();

    let autoRestore = null;
    if (p.draft) {
      const rec = await drafts.loadDraft(p.draft);
      if (!rec) throw userError('找不到这份本机草稿', '它可能已经发表、被丢弃，或者是在另一台设备 / 另一个浏览器里保存的。');
      const f = rec.fields || {};
      const draftPath = p.draft.startsWith('file:') ? p.draft.slice(5) : '';
      const groupExists = draftPath && C.groupPages(this.repo.list(PATHS.content + '/'), this.langs)
        .some((g) => Object.values(g.variants).length && g.key === this.groupKeyOf(draftPath));
      if (draftPath && groupExists) {
        autoRestore = rec;
        await this.openPath(draftPath);
      } else if (draftPath && !(f.newGroup && f.kind === 'page')) {
        throw userError('这份草稿对应的文件已经不存在了', `「${draftPath}」可能已经被删除或改名。可以在「文章」列表里丢弃这份本机草稿。`);
      } else {
        this.openNewFromDraft(p.draft, rec);
      }
    } else if (p.path) {
      await this.openPath(p.path);
    } else if (p.new === 'page') {
      const dir = this.normalizeDir(p.dir);
      const index = `${dir}/_index.md`;
      if (this.repo.has(index)) {
        await this.openPath(index);
      } else {
        this.openNewPage(dir);
      }
    } else {
      this.openNewPost();
    }

    this.buildLayout();
    await this.createVditor();
    if (this.destroyed) return;
    this.activate(this.activeKey, { initial: true });
    if (autoRestore) {
      const v = this.variants.get(this.keyForPath(autoRestore.path || p.draft.slice(5)));
      if (v && v.localDraft) this.applyDraft(v, v.localDraft, { silent: true });
      else {
        const o = this.orphanDrafts.find((d) => d.key === p.draft);
        if (o) this.restoreOrphan(o);
      }
    }
    document.addEventListener('keydown', this.onKeyDown, true);
    document.addEventListener('visibilitychange', this.onHidden);
    window.addEventListener('pagehide', this.onHidden);
    this.ctx.setTitle(this.isNewGroup ? (this.kind === 'post' ? '写新文章' : '新建页面') : (this.kind === 'post' ? '编辑文章' : '编辑页面'));
    this.loadEffectNames();
    this.leaving = false;
  }

  /** params.toml 里的全站默认值（数学公式 / 评论区 / 背景效果）。 */
  async readSiteDefaults() {
    const out = { math: true, comments: false, effect: '' };
    try {
      if (!this.repo.has(PATHS.params)) return out;
      const cfg = parseToml(await this.repo.readText(PATHS.params));
      if (cfg.math !== undefined) out.math = goTruthy(cfg.math);
      if (cfg.comments !== undefined) out.comments = goTruthy(cfg.comments);
      if (cfg.background && typeof cfg.background.effect === 'string') out.effect = cfg.background.effect;
    } catch (err) {
      console.warn('[editor] could not read params.toml', err);
    }
    return out;
  }

  /** 背景效果的中文名（效果文件第 2 行 ` * 背景效果：<中文名>`），读不到就用文件名。 */
  async loadEffectNames() {
    for (const name of this.effects) {
      try {
        const text = await this.repo.readText(`${PATHS.effects}/${name}.js`);
        const m = /背景效果[：:]\s*(.+)/.exec(text.split('\n').slice(0, 4).join('\n'));
        if (m) this.effectNames[name] = m[1].trim();
      } catch { /* 用文件名 */ }
      if (this.destroyed) return;
    }
    this.updateEffectLabels();
  }

  effectLabel(n) {
    return this.effectNames[n] ? `${this.effectNames[n]}（${n}）` : n;
  }

  updateEffectLabels() {
    const sel = this.els.effectSelect;
    if (!sel || !sel.isConnected) return;
    for (const opt of sel.options) {
      if (opt.value) opt.textContent = this.effectLabel(opt.value);
      else {
        const d = this.siteDefaults.effect;
        opt.textContent = d ? `跟随全站设置（${this.effectNames[d] || d}）` : '跟随全站设置';
      }
    }
  }

  collectBases() {
    const bases = new Set();
    for (const e of this.repo.list(PATHS.posts + '/')) {
      const rest = e.path.slice(PATHS.posts.length + 1);
      if (rest.includes('/')) { bases.add(rest.split('/')[0].toLowerCase()); continue; }
      const info = C.parseContentPath(e.path, this.langs);
      if (info) bases.add(info.base.toLowerCase());
    }
    this.existingBases = bases;
  }

  normalizeDir(dir) {
    let d = String(dir || '').trim().replace(/^\/+|\/+$/g, '');
    if (!d) return PATHS.content;
    if (d !== PATHS.content && !d.startsWith(PATHS.content + '/')) d = `${PATHS.content}/${d}`;
    if (/(^|\/)\.\.?(\/|$)/.test(d)) throw userError('地址不正确', `目录「${dir}」不是有效的内容目录。`);
    return d;
  }

  groupKeyOf(path) {
    const info = C.parseContentPath(path, this.langs);
    if (!info) return null;
    return info.dir ? `${info.dir}/${info.base}` : info.base;
  }

  keyForPath(path) {
    const info = C.parseContentPath(path, this.langs);
    return info ? (info.lang || 'shared') : null;
  }

  async openPath(rawPath) {
    const path = String(rawPath || '').replace(/^\/+/, '');
    const info = C.parseContentPath(path, this.langs);
    if (!info || !(path === PATHS.content || path.startsWith(PATHS.content + '/'))) {
      throw userError('无法编辑这个文件', `「${path}」不是 content/ 目录下的 Markdown 文件。`);
    }
    const groupKey = info.dir ? `${info.dir}/${info.base}` : info.base;
    const group = C.groupPages(this.repo.list(PATHS.content + '/'), this.langs).find((g) => g.key === groupKey);
    if (!group) {
      throw userError('找不到这个文件', `「${path}」不存在，可能已经被删除或改名。`);
    }
    this.group = { ...group, variants: { ...group.variants } };
    this.kind = C.isPost(group) ? 'post' : 'page';

    const keys = Object.keys(group.variants);
    const texts = await Promise.all(keys.map((k) => this.repo.readText(group.variants[k])));
    keys.forEach((k, i) => {
      const p = group.variants[k];
      let doc;
      try {
        doc = splitDocument(texts[i]);
      } catch (err) {
        throw userError('这个文件的格式有问题', `${p}：${errorMessage(err)}`);
      }
      if (doc.kind === 'toml') {
        throw userError('暂不支持编辑这个文件',
          `${p} 开头的设置区使用的是 TOML 格式（+++ 包围），后台只支持 YAML 格式（--- 包围）。请在 GitHub 网页上编辑这个文件。`);
      }
      let fm;
      try { fm = parseFrontMatter(doc.fmText); } catch (err) {
        throw userError('这个文件的设置区有错误', `${p}：${errorMessage(err)}`);
      }
      this.variants.set(k, this.makeVariant({ key: k, path: p, exists: true, sha: this.repo.entry(p)?.sha ?? null, fmText: doc.fmText, fm, body: doc.body }));
    });
    // 固定的标签顺序：共用版本、然后按站点语言顺序
    this.sortVariants();

    const requested = info.lang || 'shared';
    this.activeKey = this.variants.has(requested) ? requested : [...this.variants.keys()][0];

    // 本机草稿：已有版本 + 尚未创建的语言版本
    const checks = [];
    for (const v of this.variants.values()) {
      checks.push(drafts.loadDraft(v.draftKey).then((rec) => { if (rec && this.draftDiffers(v, rec)) v.localDraft = rec; }));
    }
    for (const lang of this.langs) {
      if (group.variants[lang]) continue;
      const vp = C.variantPath(group.dir, group.base, lang);
      const key = drafts.draftKeyForPath(vp);
      checks.push(drafts.loadDraft(key).then((rec) => { if (rec) this.orphanDrafts.push({ key, lang, path: vp, rec }); }));
    }
    if (!group.variants.shared) {
      const vp = C.variantPath(group.dir, group.base, null);
      const key = drafts.draftKeyForPath(vp);
      checks.push(drafts.loadDraft(key).then((rec) => { if (rec) this.orphanDrafts.push({ key, lang: 'shared', path: vp, rec }); }));
    }
    await Promise.all(checks);
  }

  /** 草稿和文件当前内容是否真的不同（自动保存后又发表了的草稿会被删除，这里只是兜底）。 */
  draftDiffers(v, rec) {
    const f = (rec.fields && rec.fields.form) || {};
    const md = String(rec.markdown || '').trim();
    if (md !== v.markdown.trim()) return true;
    return JSON.stringify(this.formKeys(f)) !== JSON.stringify(this.formKeys(v.form));
  }

  formKeys(f) {
    const keys = ['title', 'date', 'description', 'tags', 'categories', 'cover', 'math', 'comments', 'effect', 'linkTitle', 'inMenu', 'weight'];
    return keys.map((k) => (f[k] === undefined ? null : f[k]));
  }

  openNewPost() {
    this.isNewGroup = true;
    this.kind = 'post';
    this.newKey = drafts.newDraftKey();
    this.group = { key: null, dir: PATHS.posts, base: '', isIndex: false, variants: {} };
    const form = this.defaultForm({ date: hugoDate() });
    const v = this.makeVariant({ key: 'shared', path: null, exists: false, sha: null, fmText: null, fm: {}, body: '' });
    v.form = form;
    v.baseForm = clone(form);
    v.isNew = true;
    v.draftKey = this.newKey;
    this.variants.set('shared', v);
    this.activeKey = 'shared';
    this.slug = { value: C.suggestSlug('', this.existingBases), touched: false };
  }

  openNewPage(dir) {
    this.isNewGroup = true;
    this.kind = 'page';
    const groupKey = `${dir}/_index`;
    this.group = { key: groupKey, dir, base: '_index', isIndex: true, variants: {} };
    const path = `${dir}/_index.md`;
    // 菜单顺序默认排在现有菜单项后面
    const v = this.makeVariant({ key: 'shared', path, exists: false, sha: null, fmText: null, fm: {}, body: '' });
    v.form = this.defaultForm({ inMenu: true, weight: '' });
    v.baseForm = clone(v.form);
    v.isNew = true;
    this.variants.set('shared', v);
    this.activeKey = 'shared';
    this.suggestWeight(v);
    drafts.loadDraft(v.draftKey).then((rec) => {
      if (rec && !this.destroyed) { v.localDraft = rec; this.renderBanners(); }
    });
  }

  async suggestWeight(v) {
    let max = 0;
    const groups = C.groupPages(this.repo.list(PATHS.content + '/'), this.langs).filter((g) => !C.isPost(g));
    for (const g of groups) {
      const p = g.variants.shared || g.variants[this.ctx.defaultLang] || Object.values(g.variants)[0];
      try {
        const fm = parseFrontMatter(splitDocument(await this.repo.readText(p)).fmText);
        const w = Number(fm.menu && fm.menu.main && fm.menu.main.weight);
        if (Number.isFinite(w)) max = Math.max(max, w);
      } catch { /* 忽略格式有问题的文件 */ }
    }
    if (!v.form.weight) {
      v.form.weight = String(max + 10);
      v.baseForm.weight = v.form.weight;
      if (!this.destroyed && this.activeKey === v.key && this.els.settingsBody) this.renderSettings();
    }
  }

  openNewFromDraft(key, rec) {
    const f = rec.fields || {};
    this.isNewGroup = true;
    this.kind = f.kind === 'page' ? 'page' : 'post';
    this.newKey = key;
    if (this.kind === 'page') {
      const dir = this.normalizeDir(f.dir || PATHS.content);
      this.group = { key: `${dir}/_index`, dir, base: '_index', isIndex: true, variants: {} };
    } else {
      this.group = { key: null, dir: PATHS.posts, base: '', isIndex: false, variants: {} };
      this.slug = { value: str(f.slug), touched: !!f.slugTouched };
    }
    const v = this.makeVariant({ key: 'shared', path: this.kind === 'page' ? `${this.group.dir}/_index.md` : null, exists: false, sha: null, fmText: null, fm: {}, body: '' });
    v.form = this.defaultForm({ date: hugoDate() });
    v.baseForm = clone(v.form);
    v.isNew = true;
    v.draftKey = key;
    v.localDraft = rec;
    this.variants.set('shared', v);
    this.activeKey = 'shared';
    this.pendingAutoApply = true;
  }

  defaultForm(extra = {}) {
    return {
      title: '', date: '', description: '', tags: [], categories: [], cover: '',
      math: this.siteDefaults.math, comments: this.siteDefaults.comments, effect: '',
      linkTitle: '', inMenu: false, weight: '',
      ...extra,
    };
  }

  formFromFm(fm) {
    const menu = fm.menu;
    let inMenu = false;
    let weight = '';
    if (isPlainObject(menu)) {
      inMenu = Object.prototype.hasOwnProperty.call(menu, 'main');
      if (isPlainObject(menu.main) && menu.main.weight != null) weight = String(menu.main.weight);
    } else if (typeof menu === 'string') inMenu = menu === 'main';
    else if (Array.isArray(menu)) inMenu = menu.includes('main');
    const cover = isPlainObject(fm.cover) ? str(fm.cover.image) : '';
    const bg = isPlainObject(fm.background) ? fm.background : null;
    return {
      title: str(fm.title),
      date: fm.date == null ? '' : str(fm.date),
      description: str(fm.description),
      tags: strList(fm.tags),
      categories: strList(fm.categories),
      cover,
      math: fm.math === undefined ? this.siteDefaults.math : goTruthy(fm.math),
      comments: fm.comments === undefined ? this.siteDefaults.comments : goTruthy(fm.comments),
      effect: bg && typeof bg.effect === 'string' ? bg.effect : '',
      linkTitle: str(fm.linkTitle),
      inMenu,
      weight,
    };
  }

  makeVariant({ key, path, exists, sha, fmText, fm, body }) {
    const form = this.formFromFm(fm || {});
    const display = this.displayBody(body);
    return {
      _display: display,         // 打开时的显示正文（判断「没改过」用）
      key, path, exists, sha,
      fmText,                    // 原始 front matter 文本（null = 文件没有设置区）
      fm: fm || {},              // 解析结果
      rawBody: body,             // 结束分隔线之后的原文（没改正文时原样写回）
      form,
      baseForm: clone(form),
      markdown: display,         // 编辑中的正文（图片可能是 blob: 地址）
      baseMarkdown: undefined,   // 第一次放进编辑器后 Vditor 规范化的正文，用来判断是否改过
      published: !!exists && !C.isDraftFm(fm || {}),
      isNew: !exists,
      restored: false,
      touched: false,
      stale: false,
      conflict: null,
      localDraft: null,
      draftKey: path ? drafts.draftKeyForPath(path) : null,
      draftWritten: false,
      needsAutosave: false,
    };
  }

  sortVariants() {
    const order = ['shared', ...this.langs];
    const entries = [...this.variants.entries()].sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]));
    this.variants = new Map(entries);
  }

  /** 文件正文 → 编辑器里显示的正文：去掉开头空行；刚上传、网站还没部署好的图片用 blob 地址显示。 */
  displayBody(body) {
    let md = String(body || '').replace(/^(?:[ \t]*\n)+/, '');
    for (const [sitePath, blob] of recentUploads) {
      if (!md.includes(`(${sitePath}`)) continue;
      const name = sitePath.slice(sitePath.lastIndexOf('/') + 1);
      const m = this.addMedia(name, blob, 'image', { committed: true, exactName: true });
      md = md.split(`(${sitePath}`).join(`(${m.url}`);
    }
    return md;
  }

  // =========================================================================
  // 媒体（待上传的图片 / 资料）

  /**
   * 登记一个待上传文件，返回 { name, url }。名字和已登记的冲突时自动加 -2、-3 …
   * exactName：用于恢复草稿 / 已上传的图片，名字必须保持不变。
   */
  addMedia(name, blob, kind, { committed = false, exactName = false } = {}) {
    let finalName = name;
    if (!exactName) {
      const dot = name.lastIndexOf('.');
      const stem = dot > 0 ? name.slice(0, dot) : name;
      const ext = dot > 0 ? name.slice(dot) : '';
      const taken = (n) => this.media.has(n) || (kind === 'doc' && this.repo.has(`${PATHS.documents}/${n}`));
      for (let i = 2; taken(finalName); i++) finalName = `${stem}-${i}${ext}`;
    } else if (this.media.has(name)) {
      const existing = this.media.get(name);
      if (existing.blob === blob || existing.blob.size === blob.size) {
        if (committed) existing.committed = true;
        return { name, url: existing.url, kind: existing.kind };
      }
    }
    const url = kind === 'image' ? URL.createObjectURL(blob) : null;
    this.media.set(finalName, { blob, url, kind, committed });
    if (url) this.urlToName.set(url, finalName);
    return { name: finalName, url, kind };
  }

  imageDir() {
    if (this.kind === 'post') {
      const base = this.isNewGroup ? this.slug.value : this.group.base;
      return C.imageDirFor({ dir: PATHS.posts, base, isIndex: false });
    }
    return C.imageDirFor(this.group);
  }

  imageSitePath(name, imgDir = this.imageDir()) {
    return C.sitePathFor(`${imgDir}/${name}`);
  }

  docSitePath(name) {
    return C.sitePathFor(`${PATHS.documents}/${name}`);
  }

  /** 草稿用：blob 地址 → admin-pending://名字 */
  toDraftMarkdown(md) {
    let out = md;
    for (const [url, name] of this.urlToName) {
      const m = this.media.get(name);
      // 已经提交到仓库的图片直接写网站路径；还没上传的用占位符，图片本身存进草稿
      const target = m && m.committed ? this.imageSitePath(name) : PENDING + name;
      out = out.split(url).join(target);
    }
    return out;
  }

  /** 草稿恢复：admin-pending://名字 → 新的 blob 地址 */
  fromDraftMarkdown(md, images) {
    let out = String(md || '');
    for (const [key, blob] of Object.entries(images || {})) {
      if (!(blob instanceof Blob)) continue;
      if (key.startsWith('doc:')) {
        this.addMedia(key.slice(4), blob, 'doc', { exactName: true });
        continue;
      }
      const m = this.addMedia(key, blob, 'image', { exactName: true });
      out = out.split(PENDING + key).join(m.url);
    }
    return out;
  }

  /** 某段正文 + 封面引用了哪些待上传文件。 */
  referencedMedia(md, cover) {
    const used = [];
    for (const [name, m] of this.media) {
      if (m.kind === 'image') {
        if ((m.url && md.includes(m.url)) || md.includes(PENDING + name) || cover === PENDING + name) used.push(name);
      } else if (md.includes(this.docSitePath(name))) {
        used.push(name);
      }
    }
    return used;
  }

  coverDisplayUrl(cover) {
    if (!cover) return null;
    if (cover.startsWith(PENDING)) {
      const m = this.media.get(cover.slice(PENDING.length));
      return m ? m.url : null;
    }
    if (recentUploads.has(cover)) {
      const name = cover.slice(cover.lastIndexOf('/') + 1);
      return this.addMedia(name, recentUploads.get(cover), 'image', { committed: true, exactName: true }).url;
    }
    return safeUrl(cover, this.ctx.siteUrl);
  }

  // =========================================================================
  // 布局

  buildLayout() {
    const els = this.els;
    els.back = h('button', {
      type: 'button', class: 'btn btn-ghost btn-sm ed-back', dataset: { testid: 'editor-back' },
      'aria-label': '返回列表', on: { click: () => this.goBack() },
    }, svgIcon('back'), h('span', {}, '返回'));
    els.tabs = h('div', { class: 'tabs ed-tabs', role: 'tablist', 'aria-label': '语言版本' });
    els.status = h('span', { class: 'ed-status', dataset: { testid: 'editor-status' } });
    els.explain = h('div', { class: 'ed-explain muted small', dataset: { testid: 'editor-explain' } });
    els.banners = h('div', { class: 'ed-banners stack-sm' });

    els.title = h('textarea', {
      class: 'ed-title', rows: 1, placeholder: '请在这里输入标题', maxlength: 200,
      'aria-label': '标题', dataset: { testid: 'editor-title' },
    });
    els.title.addEventListener('input', () => {
      els.title.value = els.title.value.replace(/[\r\n]+/g, ' ');
      this.active.form.title = els.title.value;
      this.fitTitle();
      els.titleError.hidden = true;
      if (this.isNewGroup && this.kind === 'post' && !this.slug.touched) this.updateSlugSuggestion();
      this.changed();
    });
    els.title.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); this.focusEditor(); }
    });
    els.titleError = h('div', { class: 'error ed-title-error', role: 'alert' }, '请先填写标题');
    els.titleError.hidden = true;

    els.vditor = h('div', { class: 'ed-vditor', dataset: { testid: 'editor-body' } });

    const mainCard = h('div', { class: 'card ed-card' },
      h('div', { class: 'ed-head' }, els.back, els.tabs, els.status),
      els.explain,
      els.banners,
      els.title,
      els.titleError,
      els.vditor);

    els.settingsBody = h('div', { class: 'ed-settings-body stack' });
    els.settingsToggle = h('button', {
      type: 'button', class: 'ed-settings-toggle show-mobile', 'aria-expanded': 'false',
      dataset: { testid: 'editor-settings-toggle' },
      on: { click: () => this.toggleSettings() },
    }, svgIcon('settings'), h('span', { class: 'grow' }, this.kind === 'post' ? '文章设置' : '页面设置'),
    h('span', { class: 'ed-settings-summary muted small' }), svgIcon('chevron-down', { class: 'ed-chevron' }));
    els.side = h('aside', { class: 'ed-side is-collapsed', 'aria-label': this.kind === 'post' ? '文章设置' : '页面设置' },
      h('div', { class: 'card ed-settings' },
        els.settingsToggle,
        h('h2', { class: 'card-title hide-mobile' }, svgIcon('settings'), this.kind === 'post' ? '文章设置' : '页面设置'),
        els.settingsBody));

    // 底部操作栏
    els.autosave = h('span', { class: 'ed-autosave muted small', dataset: { testid: 'editor-autosave-status' }, 'aria-live': 'polite' });
    els.previewBtn = h('button', {
      type: 'button', class: 'btn ed-btn-preview', dataset: { testid: 'editor-preview' },
      'aria-label': '手机预览', title: '手机预览', on: { click: () => this.openPreview() },
    }, svgIcon('phone'), h('span', { class: 'ed-btn-text' }, '手机预览'));
    els.moreBtn = h('button', {
      type: 'button', class: 'btn btn-icon ed-btn-more', dataset: { testid: 'editor-more' },
      'aria-label': '更多操作', title: '更多操作', 'aria-haspopup': 'menu', 'aria-expanded': 'false',
      on: { click: (e) => { e.stopPropagation(); this.toggleMore(); } },
    }, svgIcon('more'));
    els.moreWrap = h('div', { class: 'ed-more-wrap' }, els.moreBtn);
    els.draftBtn = h('button', {
      type: 'button', class: 'btn ed-btn-draft', dataset: { testid: 'editor-save-draft' },
      on: { click: () => this.save('draft') },
    }, svgIcon('save'), h('span', { class: 'ed-btn-text' }, '保存草稿'));
    els.publishBtn = h('button', {
      type: 'button', class: 'btn btn-primary ed-btn-publish', dataset: { testid: 'editor-publish' },
      on: { click: () => this.save('publish') },
    }, svgIcon('send'), h('span', { class: 'ed-publish-text' }, '发表'));
    els.bar = h('div', { class: 'ed-bar', role: 'toolbar', 'aria-label': '保存与发表' },
      h('div', { class: 'ed-bar-inner' },
        els.autosave,
        h('div', { class: 'ed-bar-actions' }, els.previewBtn, els.moreWrap, els.draftBtn, els.publishBtn)));

    render(this.container,
      h('div', { class: 'ed-layout' }, h('div', { class: 'ed-main' }, mainCard), els.side),
      els.bar);
  }

  renderFatal(title, detail) {
    const back = this.kind === 'page' ? '#/pages' : '#/posts';
    render(this.container,
      h('div', { class: 'card ed-fatal', dataset: { testid: 'editor-error' } },
        errorState(title, { detail }),
        h('div', { class: 'row', style: { justifyContent: 'center', paddingBottom: '12px' } },
          h('a', { class: 'btn btn-primary', href: back }, svgIcon('back'), this.kind === 'page' ? '返回页面列表' : '返回文章列表'))));
  }

  get active() {
    return this.variants.get(this.activeKey);
  }

  fitTitle() {
    const t = this.els.title;
    if (!t) return;
    t.style.height = 'auto';
    t.style.height = `${t.scrollHeight}px`;
  }

  toggleSettings(force) {
    const side = this.els.side;
    const open = force ?? side.classList.contains('is-collapsed');
    side.classList.toggle('is-collapsed', !open);
    this.els.settingsToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
  }

  // =========================================================================
  // Vditor

  isDarkUI() {
    return !!(this.mq && this.mq.matches);
  }

  async createVditor() {
    await loadIconScript(); // 见 preview.js：避免 Vditor 用内联脚本加载图标（会被 CSP 拦截）
    const Vditor = window.Vditor;
    const dark = this.isDarkUI();
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) { settled = true; reject(new Error('编辑器加载超时，请刷新页面重试')); }
      }, 30000);
      try {
        this.vd = new Vditor(this.els.vditor, {
          mode: 'wysiwyg',
          lang: 'zh_CN',
          cdn: VDITOR_CDN,
          icon: 'ant',
          theme: dark ? 'dark' : 'classic',
          cache: { enable: false },
          value: '',
          minHeight: 480,
          placeholder: '从这里开始写正文…',
          counter: { enable: true },
          toolbarConfig: { pin: true },
          outline: { enable: false, position: 'right' },
          toolbar: [
            'headings', 'bold', 'italic', 'strike', '|',
            'line', 'quote', 'list', 'ordered-list', 'check', '|',
            'code', 'inline-code', 'table', 'link', 'upload',
            { name: 'formula', tip: '插入公式', tipPosition: 'n', icon: ICON_FORMULA, click: () => this.insertFormula() },
            { name: 'documents', tip: '插入资料链接', tipPosition: 'n', icon: ICON_DOCS, click: () => this.openDocuments() },
            '|', 'undo', 'redo', '|', 'edit-mode', 'outline', 'fullscreen',
          ],
          preview: {
            math: { engine: 'KaTeX', inlineDigit: true },
            hljs: { style: dark ? 'github-dark' : 'github', lineNumber: false },
            theme: { current: dark ? 'dark' : 'light', path: VDITOR_CDN + '/dist/css/content-theme' },
          },
          hint: { emojiPath: VDITOR_CDN + '/dist/images/emoji' },
          upload: {
            multiple: true,
            handler: (files) => this.onFiles(files),
          },
          input: (md) => this.onEditorInput(md),
          after: () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve();
          },
        });
        this.els.vditor._vditor = this.vd; // 方便自动化测试直接读写正文
      } catch (err) {
        settled = true;
        clearTimeout(timer);
        reject(err);
      }
    });
  }

  getEditorValue() {
    try { return this.vd ? this.vd.getValue() : this.active.markdown; } catch { return this.active.markdown; }
  }

  focusEditor() {
    try { this.vd && this.vd.focus(); } catch { /* ignore */ }
  }

  /**
   * 光标在代码块 / 公式块里时（例如刚插入公式），把它移到这个块后面，
   * 否则 Vditor 会把图片、链接的 Markdown 当成代码插进块里。
   */
  moveCaretOutOfBlock() {
    try {
      const mode = this.vd.getCurrentMode ? this.vd.getCurrentMode() : 'wysiwyg';
      if (mode !== 'wysiwyg') return;
      const internal = this.vd.vditor && this.vd.vditor.wysiwyg;
      const root = this.els.vditor.querySelector('.vditor-wysiwyg .vditor-reset');
      const sel = getSelection();
      let range = sel.rangeCount && root.contains(sel.getRangeAt(0).startContainer) ? sel.getRangeAt(0) : internal && internal.range;
      if (!range || !root.contains(range.startContainer)) return;
      const start = range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement;
      // 注意：Vditor 的编辑区本身就是 <pre class="vditor-reset">，不能把它当成代码块
      const block = start && start.closest('.vditor-wysiwyg__block, pre:not(.vditor-reset)');
      if (!block || block === root || !root.contains(block)) return;
      const top = [...root.children].find((c) => c.contains(block)) || block;
      let after = top.nextElementSibling;
      if (!after) {
        after = document.createElement('p');
        after.setAttribute('data-block', '0');
        after.appendChild(document.createTextNode('\u200b'));
        top.after(after);
      }
      // 收起公式 / 代码的编辑框
      const pre = top.querySelector('pre:not(.vditor-wysiwyg__preview)');
      if (pre && top.querySelector('.vditor-wysiwyg__preview')) pre.style.display = 'none';
      range = document.createRange();
      range.setStart(after, 0);
      range.collapse(true);
      sel.removeAllRanges();
      sel.addRange(range);
      if (internal) internal.range = range;
    } catch (err) {
      console.warn('[editor] caret move failed', err);
    }
  }

  insertMarkdown(md) {
    if (!this.vd) return;
    try {
      this.vd.insertValue(md);
    } catch (err) {
      console.error(err);
      toast('插入失败，请重试', { type: 'error' });
    }
  }

  insertFormula() {
    const sel = '.vditor-wysiwyg .vditor-reset .vditor-wysiwyg__block[data-type="math-block"]';
    const before = new Set(this.els.vditor.querySelectorAll(sel));
    this.moveCaretOutOfBlock();
    this.insertMarkdown('\n$$\n\n$$\n');
    // 所见即所得模式下，空的公式块是看不见的：直接打开它的编辑框，光标放进去
    try {
      if (this.vd.getCurrentMode && this.vd.getCurrentMode() !== 'wysiwyg') return;
      const blocks = [...this.els.vditor.querySelectorAll(sel)];
      const block = blocks.find((b) => !before.has(b)) ||
        blocks.reverse().find((b) => !(b.querySelector('pre > code') || {}).textContent?.trim());
      const preview = block && block.querySelector('.vditor-wysiwyg__preview');
      if (preview) preview.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    } catch (err) {
      console.warn('[editor] could not open the formula block', err);
    }
  }

  onEditorInput(md) {
    const v = this.active;
    if (!v || this.settingValue) return;
    v.markdown = md;
    v.touched = true;
    if (v.localDraft && !this.warnedPending) {
      this.warnedPending = true;
      toast('请先在上方选择「恢复」或「丢弃」本机草稿，之后的修改才会自动保存', { type: 'warning' });
    }
    this.changed();
  }

  /** 把编辑器里的正文写回当前版本。 */
  syncActive() {
    const v = this.active;
    if (v && this.vd) v.markdown = this.getEditorValue();
  }

  /** 切换到某个语言版本（各版本的修改都保留在内存里）。 */
  activate(key, { initial = false } = {}) {
    if (!this.variants.has(key)) return;
    if (!initial) this.syncActive();
    this.closeMore();
    this.activeKey = key;
    const v = this.active;
    this.setEditorValue(v.markdown);
    if (v.baseMarkdown === undefined) {
      const normalized = this.getEditorValue();
      if (!v.isNew && !v.restored) {
        // Vditor 会做一些无损的格式整理（例如单行 $$…$$ 变成多行）；以整理后的结果为「未修改」基准
        v.baseMarkdown = normalized;
        v.markdown = normalized;
      } else {
        v.baseMarkdown = null;
      }
    }
    this.els.title.value = v.form.title;
    requestAnimationFrame(() => this.fitTitle());
    this.els.titleError.hidden = true;
    if (this.pendingAutoApply && v.localDraft) {
      this.pendingAutoApply = false;
      this.applyDraft(v, v.localDraft, { silent: true });
      return;
    }
    this.renderAll();
  }

  setEditorValue(md) {
    if (!this.vd) return;
    this.settingValue = true;
    try {
      this.vd.setValue(md || '', true);
    } finally {
      this.settingValue = false;
    }
  }

  // =========================================================================
  // 状态

  /** 某个版本是否有未保存（未提交到 GitHub）的修改。 */
  variantDirty(v) {
    if (v.isNew || v.restored) return true;
    if (JSON.stringify(this.formKeys(v.form)) !== JSON.stringify(this.formKeys(v.baseForm))) return true;
    const md = v === this.active && this.vd ? this.getEditorValue() : v.markdown;
    if (v.baseMarkdown === undefined) return md !== this.displayBodyCached(v);
    return md !== v.baseMarkdown;
  }

  displayBodyCached(v) {
    if (v._display === undefined) v._display = String(v.rawBody || '').replace(/^(?:[ \t]*\n)+/, '');
    return v._display;
  }

  isDirty() {
    if (this.leaving || this.destroyed) return false;
    for (const v of this.variants.values()) {
      // 新建但完全没动过的文章不算「有修改」
      if (v.isNew && this.isNewGroup && !v.touched && !v.restored && !v.form.title.trim() && !this.getVariantMarkdown(v).trim()) continue;
      if (this.variantDirty(v)) return true;
    }
    return false;
  }

  getVariantMarkdown(v) {
    return v === this.active && this.vd ? this.getEditorValue() : v.markdown;
  }

  changed() {
    const v = this.active;
    if (v) { v.needsAutosave = true; v.touched = true; }
    this.renderTabs();
    this.renderStatus();
    this.autosave();
  }

  // =========================================================================
  // 自动保存（IndexedDB）

  async autosaveNow() {
    if (this.destroyed && !this.flushing) return;
    this.syncActive();
    let saved = false;
    for (const v of this.variants.values()) {
      if (!v.needsAutosave || v.localDraft) continue;
      v.needsAutosave = false;
      if (!v.draftKey) continue;
      if (this.variantDirty(v) && (v.touched || v.restored)) {
        const md = this.getVariantMarkdown(v);
        const images = {};
        for (const name of this.referencedMedia(md, v.form.cover)) {
          const m = this.media.get(name);
          if (m && !m.committed) images[m.kind === 'doc' ? `doc:${name}` : name] = m.blob;
        }
        const ok = await drafts.saveDraft(v.draftKey, {
          title: v.form.title.trim() || '（无标题）',
          markdown: this.toDraftMarkdown(md),
          fields: {
            form: clone(v.form),
            kind: this.kind,
            dir: this.group.dir,
            variantKey: v.key,
            isNewVariant: v.isNew,
            newGroup: this.isNewGroup,
            slug: this.slug.value,
            slugTouched: this.slug.touched,
          },
          images,
          path: v.path || undefined,
          baseSha: v.exists ? v.sha : null,
          groupKey: this.group.key || undefined,
          updatedAt: Date.now(),
        });
        this.autosaveOk = ok;
        if (ok) { v.draftWritten = true; saved = true; }
      } else if (v.draftWritten) {
        await drafts.deleteDraft(v.draftKey);
        v.draftWritten = false;
      }
    }
    if (saved) this.lastAutosave = new Date();
    if (!this.destroyed) this.renderStatus();
  }

  /** 立即把待保存的内容写进本机（离开页面 / 登录失效 / 发布前调用）。 */
  flushAutosave() {
    if (this.autosave.pending()) return this.autosave.flush();
    return undefined;
  }

  // =========================================================================
  // 草稿恢复

  applyDraft(v, rec, { silent = false } = {}) {
    const f = (rec.fields && rec.fields.form) || {};
    const base = this.defaultForm();
    v.form = { ...base, ...v.form, ...clone(f) };
    v.form.tags = strList(v.form.tags);
    v.form.categories = strList(v.form.categories);
    v.markdown = this.fromDraftMarkdown(rec.markdown, rec.images);
    if (this.isNewGroup && rec.fields) {
      if (rec.fields.slug) this.slug = { value: str(rec.fields.slug), touched: !!rec.fields.slugTouched };
    }
    v.restored = true;
    v.touched = true;
    v.localDraft = null;
    v.draftWritten = true;
    v.stale = !this.isNewGroup && (rec.baseSha ?? null) !== (v.exists ? v.sha : null);
    v.restoredAt = rec.updatedAt;
    if (v === this.active) {
      this.setEditorValue(v.markdown);
      this.els.title.value = v.form.title;
      this.fitTitle();
    }
    this.renderAll();
    if (!silent) toast('已恢复本机保存的修改', { type: 'success' });
  }

  async discardDraft(v) {
    const ok = await confirmDialog({
      title: '丢弃本机草稿？',
      message: '这份在本机自动保存、还没有发表的修改会被删除，不能恢复。',
      okText: '丢弃', danger: true,
    });
    if (!ok) return;
    await drafts.deleteDraft(v.draftKey);
    v.localDraft = null;
    this.renderBanners();
    toast('已丢弃本机草稿', { type: 'success' });
  }

  /** 恢复一个还不存在的语言版本的草稿（例如上次没发表的英文版）。 */
  restoreOrphan(o) {
    const lang = o.lang;
    if (this.variants.has(lang)) return;
    const src = this.variants.get('shared') || this.active;
    const v = this.makeVariant({ key: lang, path: o.path, exists: false, sha: null, fmText: src.fmText, fm: src.fm, body: '' });
    v.isNew = true;
    v.draftKey = o.key;
    this.variants.set(lang, v);
    this.sortVariants();
    this.orphanDrafts = this.orphanDrafts.filter((x) => x !== o);
    this.applyDraft(v, o.rec, { silent: true });
    this.activate(lang);
    toast(`已恢复本机保存的${C.variantLabel(lang, this.ctx)}版本`, { type: 'success' });
  }

  async discardOrphan(o) {
    const ok = await confirmDialog({
      title: '丢弃本机草稿？',
      message: `本机保存的「${C.variantLabel(o.lang, this.ctx)}」草稿会被删除，不能恢复。`,
      okText: '丢弃', danger: true,
    });
    if (!ok) return;
    await drafts.deleteDraft(o.key);
    this.orphanDrafts = this.orphanDrafts.filter((x) => x !== o);
    this.renderBanners();
  }

  // =========================================================================
  // 渲染

  renderAll() {
    if (this.destroyed) return;
    this.renderTabs();
    this.renderExplain();
    this.renderBanners();
    this.renderSettings();
    this.renderStatus();
  }

  renderTabs() {
    const els = this.els;
    if (!els.tabs) return;
    const tabs = [];
    for (const v of this.variants.values()) {
      const active = v.key === this.activeKey;
      const dirty = this.variantDirty(v) && !(this.isNewGroup && !v.touched && !v.restored);
      tabs.push(h('button', {
        type: 'button', role: 'tab', class: ['tab', active && 'active'],
        'aria-selected': active ? 'true' : 'false',
        dataset: { testid: `editor-tab-${v.key}` },
        on: { click: () => { if (!active) this.activate(v.key); } },
      },
      C.variantLabel(v.key, this.ctx),
      dirty ? h('span', { class: 'ed-dot', title: '有未发表的修改', 'aria-label': '有未发表的修改' }) : null));
    }
    // 「＋ 单独写英文版」
    const canTranslate = !this.isNewGroup && [...this.variants.values()].some((v) => v.exists);
    if (canTranslate) {
      const hasShared = this.variants.has('shared');
      const specific = this.langs.filter((l) => this.variants.has(l));
      for (const lang of this.langs) {
        if (this.variants.has(lang)) continue;
        if (!hasShared && specific.length === 0) continue;
        tabs.push(h('button', {
          type: 'button', class: 'tab ed-tab-add', dataset: { testid: `editor-add-${lang}` },
          title: hasShared
            ? `复制当前内容，为${this.ctx.siteLabel(lang)}单独写一个版本`
            : `为${this.ctx.siteLabel(lang)}写一个版本`,
          on: { click: () => this.createVariant(lang) },
        }, svgIcon('plus'), hasShared ? `单独写${this.ctx.langName(lang)}版` : `写${this.ctx.langName(lang)}版`));
      }
    }
    render(els.tabs, tabs);
  }

  renderExplain() {
    const parts = [];
    for (const lang of this.langs) {
      const v = this.variants.get(lang) || this.variants.get('shared');
      let text;
      if (!v) text = '没有这一页';
      else {
        text = C.variantLabel(v.key, this.ctx);
        if (!v.exists) text += '（未发表）';
        else if (!v.published) text += '（草稿，暂不显示）';
      }
      parts.push(`${this.ctx.siteLabel(lang)}显示：${text}`);
    }
    this.els.explain.textContent = parts.join(' · ');
  }

  banner(kind, icon, text, actions = [], testid) {
    return h('div', { class: ['banner', `banner-${kind}`], dataset: { testid } },
      svgIcon(icon),
      h('span', {}, text),
      actions.length ? h('div', { class: 'banner-actions' }, actions) : null);
  }

  renderBanners() {
    const els = this.els;
    if (!els.banners) return;
    const v = this.active;
    const list = [];

    if (v.conflict) {
      list.push(this.banner('error', 'warning',
        'GitHub 上的这个文件刚刚被修改过（可能来自另一台设备或 GitHub 网页）。你的修改还保留在编辑器里，也已保存在本机。请选择：',
        [
          h('button', { type: 'button', class: 'btn btn-sm', dataset: { testid: 'editor-conflict-reload' }, on: { click: () => this.reloadVariant(v) } }, '加载最新版本（放弃我的修改）'),
          h('button', { type: 'button', class: 'btn btn-sm btn-primary', dataset: { testid: 'editor-conflict-keep' }, on: { click: () => this.keepMine(v) } }, '保留我的修改'),
        ], 'editor-conflict'));
    }

    if (v.localDraft) {
      const rec = v.localDraft;
      const when = rec.updatedAt ? formatDate(new Date(rec.updatedAt)) : '';
      const changedRemote = !this.isNewGroup && (rec.baseSha ?? null) !== (v.exists ? v.sha : null);
      list.push(this.banner('warning', 'clock',
        `发现本机未发布的修改（${when}）。` + (changedRemote ? '注意：保存这份草稿之后，GitHub 上的文件又被修改过，恢复后发表会覆盖那些修改。' : ''),
        [
          h('button', { type: 'button', class: 'btn btn-sm btn-ghost', dataset: { testid: 'editor-discard-draft' }, on: { click: () => this.discardDraft(v) } }, '丢弃'),
          h('button', { type: 'button', class: 'btn btn-sm btn-primary', dataset: { testid: 'editor-restore' }, on: { click: () => this.applyDraft(v, rec) } }, '恢复'),
        ], 'editor-draft-banner'));
    } else if (v.restored && v.stale) {
      list.push(this.banner('warning', 'warning',
        '已恢复的草稿基于旧版本：保存草稿之后 GitHub 上的文件又被修改过。发表会用你的版本覆盖那些修改。',
        [h('button', { type: 'button', class: 'btn btn-sm btn-ghost', on: { click: () => this.reloadVariant(v, { confirmText: '放弃恢复的草稿，加载 GitHub 上的最新版本？' }) } }, '改为加载最新版本')],
        'editor-stale'));
    }

    for (const o of this.orphanDrafts) {
      const when = o.rec.updatedAt ? formatDate(new Date(o.rec.updatedAt)) : '';
      list.push(this.banner('warning', 'clock',
        `发现本机未发表的「${C.variantLabel(o.lang, this.ctx)}」草稿（${when}）。`,
        [
          h('button', { type: 'button', class: 'btn btn-sm btn-ghost', on: { click: () => this.discardOrphan(o) } }, '丢弃'),
          h('button', { type: 'button', class: 'btn btn-sm btn-primary', dataset: { testid: `editor-restore-${o.lang}` }, on: { click: () => this.restoreOrphan(o) } }, '恢复'),
        ], 'editor-orphan-banner'));
    }

    // 专属版本是草稿、共用版本已发表 → 该语言站点上这一页会消失
    const fmByPath = {};
    for (const x of this.variants.values()) if (x.exists) fmByPath[x.path] = x.fm;
    const repoGroup = { ...this.group, variants: {} };
    for (const x of this.variants.values()) if (x.exists) repoGroup.variants[x.key] = x.path;
    for (const w of C.shadowWarnings(repoGroup, fmByPath, this.langs)) {
      list.push(this.banner('warning', 'warning',
        `${this.ctx.siteLabel(w.lang)}现在看不到这一页：${C.variantLabel(w.lang, this.ctx)}版本是草稿，而且不会改回显示共用版本。发表${this.ctx.langName(w.lang)}版，或删除这个版本即可恢复。`,
        [], 'editor-shadow-warning'));
    }

    if (v.isNew && !this.isNewGroup && v.key !== 'shared' && this.variants.has('shared')) {
      list.push(this.banner('info', 'info',
        `这是新的${C.variantLabel(v.key, this.ctx)}版本（已复制共用版本的内容）。改好后点「发表」，${this.ctx.siteLabel(v.key)}就会显示这个版本。`,
        [], 'editor-new-variant'));
    }
    render(els.banners, list);
    els.banners.hidden = list.length === 0;
  }

  renderStatus() {
    const els = this.els;
    if (!els.status) return;
    const v = this.active;
    let b;
    if (!v.exists) b = badge('未发表', 'orange');
    else if (v.published) b = badge('已发表', 'green');
    else b = badge('草稿', 'gray');
    render(els.status, b);

    // 发表按钮文字：已发表的文件 → 「更新」
    const label = v.exists && v.published ? '更新' : '发表';
    els.publishBtn.querySelector('.ed-publish-text').textContent = label;
    els.publishBtn.title = v.exists && v.published ? '把修改更新到网站上（Ctrl/⌘+S）' : '发表到网站上';
    els.draftBtn.title = v.exists && v.published ? '改为草稿：网站上将不再显示' : '保存为草稿（不会在网站上显示，Ctrl/⌘+S）';

    // 自动保存状态
    const dirty = this.isDirty();
    let text = '';
    let cls = '';
    if (!this.autosaveOk) {
      text = '这个浏览器无法自动保存到本机，请及时保存';
      cls = 'text-danger';
    } else if (dirty && this.lastAutosave && !this.autosave.pending()) {
      text = `已自动保存到本机 · ${pad2(this.lastAutosave.getHours())}:${pad2(this.lastAutosave.getMinutes())}`;
    } else if (dirty && this.autosave.pending()) {
      text = '正在自动保存…';
    } else if (dirty) {
      text = '有未发表的修改';
    } else if (v.exists) {
      text = v.published ? '已是网站上的最新内容' : '已保存为草稿';
    }
    els.autosave.textContent = text;
    els.autosave.className = ['ed-autosave', 'small', cls || 'muted'].join(' ');

    // 手机端设置摘要
    const sum = this.els.settingsToggle && this.els.settingsToggle.querySelector('.ed-settings-summary');
    if (sum) {
      sum.textContent = this.kind === 'post'
        ? [v.form.tags.length ? `${v.form.tags.length} 个标签` : '', v.form.date ? formatDate(v.form.date).slice(0, 10) : ''].filter(Boolean).join(' · ')
        : (v.form.inMenu ? `菜单顺序 ${v.form.weight || '—'}` : '不在菜单中');
    }
  }

  // ----- 设置面板 -----

  field(label, control, { hint, id, error, optional } = {}) {
    if (id && control && !control.id) control.id = id;
    return h('div', { class: 'field' },
      h('label', { htmlFor: id || undefined }, label, optional ? h('span', { class: 'optional' }, '（可选）') : null),
      control,
      hint ? h('div', { class: 'hint' }, hint) : null,
      error || null);
  }

  switchField(label, checked, onChange, { hint, testid } = {}) {
    const input = h('input', { type: 'checkbox', checked, dataset: { testid }, 'aria-label': label });
    input.addEventListener('change', () => onChange(input.checked));
    return h('div', { class: 'field ed-switch-field' },
      h('div', { class: 'row row-between row-nowrap' },
        h('span', { class: 'label' }, label),
        h('label', { class: 'switch' }, input, h('span'))),
      hint ? h('div', { class: 'hint' }, hint) : null);
  }

  chipInput(values, onChange, { placeholder, testid, id }) {
    const chips = h('div', { class: 'chips ed-chip-list' });
    const input = h('input', {
      class: 'ed-chip-input', type: 'text', placeholder, id, autocomplete: 'off', enterkeyhint: 'done',
      dataset: { testid },
    });
    let list = [...values];
    const draw = () => {
      render(chips, list.map((t, i) => h('span', { class: 'chip' },
        h('span', {}, t),
        h('button', {
          type: 'button', 'aria-label': `删除「${t}」`,
          on: { click: () => { list.splice(i, 1); draw(); onChange([...list]); input.focus(); } },
        }, svgIcon('close')))));
    };
    const add = () => {
      const parts = input.value.split(/[,，、;；]/).map((s) => s.trim()).filter(Boolean);
      if (!parts.length) { input.value = ''; return false; }
      let added = false;
      for (const p of parts) if (!list.includes(p)) { list.push(p); added = true; }
      input.value = '';
      draw();
      if (added) onChange([...list]);
      return true;
    };
    input.addEventListener('keydown', (e) => {
      if (e.isComposing) return;
      if (e.key === 'Enter') { e.preventDefault(); add(); } else if (e.key === 'Backspace' && !input.value && list.length) {
        list.pop(); draw(); onChange([...list]);
      }
    });
    input.addEventListener('input', () => { if (/[,，、;；]/.test(input.value)) add(); });
    input.addEventListener('blur', () => add());
    draw();
    const wrap = h('div', { class: 'input ed-chips', on: { click: (e) => { if (e.target === wrap || e.target === chips) input.focus(); } } }, chips, input);
    return wrap;
  }

  renderSettings() {
    const els = this.els;
    if (!els.settingsBody) return;
    const v = this.active;
    const f = v.form;
    const set = (key, val) => { f[key] = val; this.changed(); };
    const items = [];

    if (this.kind === 'post') {
      if (this.isNewGroup) {
        const slugInput = h('input', {
          class: 'input mono', type: 'text', value: this.slug.value, placeholder: 'my-first-post',
          autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', maxlength: 81,
          dataset: { testid: 'editor-slug' },
        });
        const urlHint = h('div', { class: 'hint' });
        const err = h('div', { class: 'error', role: 'alert', dataset: { testid: 'editor-slug-error' } });
        const update = () => {
          const e = this.slugError();
          err.textContent = e || '';
          err.hidden = !e || !this.slug.value;
          slugInput.setAttribute('aria-invalid', e && this.slug.value ? 'true' : 'false');
          urlHint.textContent = `网址：/posts/${this.slug.value || '…'}/ · 只能用小写字母、数字和 -`;
        };
        slugInput.addEventListener('input', () => {
          const raw = slugInput.value;
          const cleaned = raw.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-{2,}/g, '-');
          if (cleaned !== raw) slugInput.value = cleaned;
          this.slug.value = cleaned.replace(/^-+/, '');
          this.slug.touched = this.slug.value !== '';
          if (!this.slug.touched) this.updateSlugSuggestion();
          update();
          this.changed();
        });
        slugInput.addEventListener('blur', () => {
          const t = this.slug.value.replace(/-+$/, '');
          if (t !== this.slug.value) { this.slug.value = t; slugInput.value = t; update(); }
        });
        els.slugInput = slugInput;
        els.slugUpdate = update;
        update();
        items.push(h('div', { class: 'field' },
          h('label', { htmlFor: 'ed-slug' }, '文件名（网址）'),
          Object.assign(slugInput, { id: 'ed-slug' }), urlHint, err));
      } else {
        items.push(h('div', { class: 'field' },
          h('span', { class: 'label' }, '文件'),
          h('div', { class: 'ed-path mono small', title: v.path || '' }, v.path || '（保存后生成）')));
      }

      const dateInput = h('input', {
        class: 'input', type: 'datetime-local', id: 'ed-date', value: toLocalInput(f.date), step: 60,
        dataset: { testid: 'editor-date' },
      });
      dateInput.addEventListener('change', () => {
        if (!dateInput.value) { set('date', v.baseForm.date); return; }
        const d = new Date(dateInput.value);
        if (Number.isNaN(d.getTime())) return;
        set('date', hugoDate(d));
      });
      items.push(this.field('日期', dateInput, { id: 'ed-date', hint: f.date && !toLocalInput(f.date) ? `原值：${f.date}` : null }));

      const desc = h('textarea', { class: 'input', id: 'ed-desc', rows: 3, value: f.description, placeholder: '一两句话介绍这篇文章，会显示在文章列表里', dataset: { testid: 'editor-description' } });
      desc.addEventListener('input', () => set('description', desc.value));
      items.push(this.field('摘要', desc, { id: 'ed-desc', optional: true }));

      items.push(this.field('标签', this.chipInput(f.tags, (list) => set('tags', list), { placeholder: '输入后按回车添加', testid: 'editor-tags', id: 'ed-tags' }), { id: 'ed-tags', optional: true }));
      items.push(this.field('分类', this.chipInput(f.categories, (list) => set('categories', list), { placeholder: '输入后按回车添加', testid: 'editor-categories', id: 'ed-cats' }), { id: 'ed-cats', optional: true }));

      items.push(this.coverField(v));

      items.push(this.switchField('数学公式', f.math, (on) => set('math', on), {
        testid: 'editor-math',
        hint: `全站默认${this.siteDefaults.math ? '开启' : '关闭'}；关闭后页面不加载公式组件。`,
      }));
      items.push(this.switchField('评论区', f.comments, (on) => set('comments', on), {
        testid: 'editor-comments',
        hint: `全站默认${this.siteDefaults.comments ? '开启' : '关闭'}。`,
      }));

      const sel = h('select', { class: 'input', id: 'ed-effect', dataset: { testid: 'editor-effect' } });
      const defName = this.siteDefaults.effect ? (this.effectNames[this.siteDefaults.effect] || this.siteDefaults.effect) : '';
      sel.appendChild(h('option', { value: '' }, defName ? `跟随全站设置（${defName}）` : '跟随全站设置'));
      const names = [...this.effects];
      if (f.effect && !names.includes(f.effect)) names.push(f.effect);
      for (const n of names) sel.appendChild(h('option', { value: n }, this.effectLabel(n)));
      sel.value = f.effect;
      sel.addEventListener('change', () => set('effect', sel.value));
      els.effectSelect = sel;
      const bgOff = isPlainObject(v.fm.background) && v.fm.background.enabled === false;
      items.push(this.field('背景动画', sel, { id: 'ed-effect', hint: bgOff ? '这篇文章设置了 background.enabled: false（不显示背景动画）。' : null }));
    } else {
      items.push(h('div', { class: 'field' },
        h('span', { class: 'label' }, '文件'),
        h('div', { class: 'ed-path mono small', title: v.path || '' }, v.path || '')));
      const lt = h('input', { class: 'input', type: 'text', id: 'ed-linktitle', value: f.linkTitle, placeholder: f.title || '和标题相同', dataset: { testid: 'editor-linktitle' } });
      lt.addEventListener('input', () => set('linkTitle', lt.value));
      items.push(this.field('菜单名称', lt, { id: 'ed-linktitle', hint: '顶部菜单里显示的名字，留空则使用标题。', optional: true }));

      const weight = h('input', { class: 'input', type: 'number', id: 'ed-weight', step: 1, inputmode: 'numeric', value: f.weight, dataset: { testid: 'editor-weight' } });
      const weightField = this.field('菜单顺序', weight, { id: 'ed-weight', hint: '数字越小越靠左。只修改当前这个语言版本。' });
      weightField.hidden = !f.inMenu;
      weight.addEventListener('input', () => set('weight', weight.value.trim()));
      items.push(this.switchField('显示在顶部菜单', f.inMenu, (on) => {
        f.inMenu = on;
        weightField.hidden = !on;
        this.changed();
      }, { testid: 'editor-inmenu' }));
      items.push(weightField);

      const desc = h('textarea', { class: 'input', id: 'ed-desc', rows: 3, value: f.description, dataset: { testid: 'editor-description' } });
      desc.addEventListener('input', () => set('description', desc.value));
      items.push(this.field('描述', desc, { id: 'ed-desc', optional: true }));
    }
    render(els.settingsBody, items);
    this.renderStatus();
  }

  coverField(v) {
    const f = v.form;
    const fileInput = h('input', { type: 'file', accept: 'image/*', hidden: true, dataset: { testid: 'editor-cover-input' } });
    fileInput.addEventListener('change', async () => {
      const file = fileInput.files && fileInput.files[0];
      fileInput.value = '';
      if (!file) return;
      const added = await this.prepareImage(file);
      if (!added) return;
      f.cover = PENDING + added.name;
      this.changed();
      this.renderSettings();
    });
    const url = this.coverDisplayUrl(f.cover);
    const pick = h('button', { type: 'button', class: 'btn btn-sm', dataset: { testid: 'editor-cover-upload' }, on: { click: () => fileInput.click() } },
      svgIcon('upload'), f.cover ? '更换' : '上传封面图');
    const remove = f.cover ? h('button', {
      type: 'button', class: 'btn btn-sm btn-ghost btn-danger', dataset: { testid: 'editor-cover-remove' },
      on: { click: () => { f.cover = ''; this.changed(); this.renderSettings(); } },
    }, svgIcon('trash'), '移除') : null;
    const thumb = f.cover
      ? h('div', { class: 'ed-cover-thumb' },
        url ? h('img', { src: url, alt: '封面图预览' }) : h('span', { class: 'muted small' }, '无法预览'),
      )
      : h('div', { class: 'ed-cover-empty muted small', on: { click: () => fileInput.click() } }, svgIcon('image'), '没有封面图');
    return h('div', { class: 'field' },
      h('span', { class: 'label' }, '封面图', h('span', { class: 'optional' }, '（可选）')),
      thumb,
      h('div', { class: 'row' }, pick, remove, fileInput),
      f.cover && !f.cover.startsWith(PENDING) ? h('div', { class: 'hint mono truncate', title: f.cover }, f.cover) : null);
  }

  updateSlugSuggestion() {
    this.slug.value = C.suggestSlug(this.active.form.title, this.existingBases);
    if (this.els.slugInput) {
      this.els.slugInput.value = this.slug.value;
      this.els.slugUpdate && this.els.slugUpdate();
    }
  }

  slugError() {
    const s = this.slug.value;
    if (!s) return '请填写文件名（只用小写字母、数字和 -）';
    if (!C.isValidSlug(s)) return '文件名只能包含小写字母、数字和 -，并以字母或数字开头';
    if (this.existingBases.has(s.toLowerCase())) return '已经有同名的文章了，请换一个文件名';
    return null;
  }

  // =========================================================================
  // 图片与资料

  /** 压缩并登记一张图片；返回 { name, url } 或 null。 */
  async prepareImage(file) {
    const ext = extOf(file.name || '');
    let result;
    try {
      result = await compressImage(file, { maxWidth: LIMITS.imageMaxWidth, quality: LIMITS.imageQuality });
    } catch (err) {
      console.warn('[editor] compress failed', err);
      result = { blob: file, ext: ext || 'jpg', changed: false };
    }
    const blob = result.blob;
    if (blob.size >= LIMITS.maxFileMB * MB) {
      toast(`图片「${file.name}」太大（${formatBytes(blob.size)}），超过 ${LIMITS.maxFileMB} MB，无法上传`, { type: 'error' });
      return null;
    }
    if (blob.size >= LIMITS.warnFileMB * MB) {
      toast(`图片「${file.name}」比较大（${formatBytes(blob.size)}），网页打开会变慢`, { type: 'warning' });
    }
    if ((ext === 'heic' || ext === 'heif') && !result.changed) {
      toast('HEIC 格式的照片很多浏览器显示不了，建议在手机上导出为 JPG 后再上传', { type: 'warning', timeout: 8000 });
    }
    const outExt = result.ext || ext || 'jpg';
    const name = timestampName(`${stemOf(file.name || 'image')}.${outExt}`);
    return this.addMedia(name, blob, 'image');
  }

  /** 资料（非图片文件）：放进 static/documents/，与文章一起提交。 */
  prepareDocument(file) {
    if (file.size >= LIMITS.maxFileMB * MB) {
      toast(`文件「${file.name}」太大（${formatBytes(file.size)}），超过 ${LIMITS.maxFileMB} MB，无法上传`, { type: 'error' });
      return null;
    }
    if (file.size >= LIMITS.warnFileMB * MB) {
      toast(`文件「${file.name}」比较大（${formatBytes(file.size)}），上传会慢一些`, { type: 'warning' });
    }
    return this.addMedia(safeFileName(file.name || 'file'), file, 'doc');
  }

  /** Vditor 的上传入口：工具栏上传按钮、粘贴、拖入都会走这里。 */
  async onFiles(files) {
    const list = [...(files || [])];
    if (!list.length) return null;
    const parts = [];
    let busy = null;
    if (list.length > 1 || list.some((f) => f.size > 2 * MB)) busy = toast('正在处理图片…', { type: 'info', timeout: 0 });
    try {
      for (const file of list) {
        if (isImageFile(file)) {
          const m = await this.prepareImage(file);
          if (m) parts.push(`![${linkText(stemOf(file.name))}](${m.url})`);
        } else {
          const m = this.prepareDocument(file);
          if (m) parts.push(`[${linkText(file.name)}](${this.docSitePath(m.name)})`);
        }
      }
    } finally {
      if (busy) busy.close();
    }
    if (parts.length) {
      this.moveCaretOutOfBlock();
      this.insertMarkdown(parts.join('\n\n') + '\n');
      toast(parts.length > 1 ? `已插入 ${parts.length} 个文件，发表时一起上传` : '已插入，发表时一起上传', { type: 'success' });
    }
    return null;
  }

  /** 「资料」按钮：选择 static/documents/ 里的文件插入链接，或上传新资料。 */
  openDocuments() {
    const files = this.repo.list(PATHS.documents + '/');
    const pending = [...this.media.entries()].filter(([, m]) => m.kind === 'doc' && !m.committed).map(([name]) => ({ path: `${PATHS.documents}/${name}`, size: this.media.get(name).blob.size, pending: true }));
    const all = [...pending, ...files];
    const search = h('input', { class: 'input', type: 'search', placeholder: '搜索资料…', 'aria-label': '搜索资料', dataset: { testid: 'editor-docs-search' } });
    const listEl = h('div', { class: 'list ed-doc-list' });
    let m;
    const insert = (path) => {
      const name = path.slice(path.lastIndexOf('/') + 1);
      m.close();
      this.moveCaretOutOfBlock();
      this.insertMarkdown(`[${linkText(name)}](${C.sitePathFor(path)})`);
    };
    const draw = () => {
      const q = search.value.trim().toLowerCase();
      const shown = all.filter((f) => !q || f.path.toLowerCase().includes(q));
      if (!shown.length) {
        render(listEl, h('div', { class: 'empty ed-doc-empty' }, h('div', { class: 'empty-text' }, all.length ? '没有找到匹配的资料' : '资料库还是空的。可以先上传一个文件。')));
        return;
      }
      render(listEl, shown.slice(0, 200).map((f) => h('button', {
        type: 'button', class: 'list-item ed-doc-item', dataset: { testid: 'editor-doc-item' }, on: { click: () => insert(f.path) },
      },
      h('div', { class: 'list-item-main' },
        h('div', { class: 'list-item-title' }, f.path.slice(PATHS.documents.length + 1)),
        h('div', { class: 'list-item-meta' }, C.sitePathFor(f.path), ' · ', formatBytes(f.size), f.pending ? badge('待上传', 'orange') : null)),
      svgIcon('plus'))));
    };
    search.addEventListener('input', draw);
    const upload = h('input', { type: 'file', multiple: true, hidden: true, dataset: { testid: 'editor-docs-upload' } });
    upload.addEventListener('change', () => {
      const chosen = [...(upload.files || [])];
      upload.value = '';
      if (!chosen.length) return;
      const parts = [];
      for (const file of chosen) {
        const added = this.prepareDocument(file);
        if (added) parts.push(`[${linkText(file.name)}](${this.docSitePath(added.name)})`);
      }
      m.close();
      if (parts.length) {
        this.moveCaretOutOfBlock();
        this.insertMarkdown(parts.join('\n\n') + '\n');
        toast('已插入资料链接，发表时一起上传', { type: 'success' });
      }
    });
    draw();
    m = modal({
      title: '插入资料链接',
      content: h('div', { class: 'stack-sm stack' },
        h('p', { class: 'muted small' }, '资料放在 static/documents/ 里，点一下插入链接；也可以上传新文件（随文章一起发表）。'),
        search, listEl, upload),
      actions: [
        { text: '取消', kind: 'ghost' },
        { text: '上传新资料…', kind: 'primary', testid: 'editor-docs-upload-btn', onClick: () => { upload.click(); } },
      ],
    });
  }

  // =========================================================================
  // 语言版本

  createVariant(lang) {
    if (this.variants.has(lang)) { this.activate(lang); return; }
    this.syncActive();
    const src = this.active;
    const path = C.variantPath(this.group.dir, this.group.base, lang);
    const v = this.makeVariant({ key: lang, path, exists: false, sha: null, fmText: src.fmText, fm: src.fm, body: '' });
    v.form = clone(src.form);
    v.markdown = src.markdown;
    v.isNew = true;
    v.touched = true;
    v.needsAutosave = true;
    this.variants.set(lang, v);
    this.sortVariants();
    this.activate(lang);
    this.changed();
    toast(`已复制当前内容作为${C.variantLabel(lang, this.ctx)}版本，修改后点「发表」`, { type: 'success' });
    this.els.title.focus();
  }

  // =========================================================================
  // 保存 / 发表

  onKeyDown(e) {
    if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
    if ((e.key || '').toLowerCase() !== 's') return;
    e.preventDefault();
    e.stopPropagation();
    if (document.documentElement.classList.contains('ui-locked')) return; // 有弹窗打开时忽略
    const v = this.active;
    this.save(v.exists && v.published ? 'publish' : 'draft');
  }

  sharedPublished() {
    const s = this.variants.get('shared');
    return !!(s && s.exists && s.published);
  }

  /** 生成要写入的正文和用到的待上传文件。 */
  finalBody(v, imgDir) {
    const current = this.getVariantMarkdown(v);
    const unchanged = !v.isNew && !v.restored && (v.baseMarkdown === undefined || v.baseMarkdown === null
      ? current === this.displayBodyCached(v)
      : current === v.baseMarkdown);
    const used = this.referencedMedia(current, v.form.cover);
    if (unchanged) return { body: v.rawBody, unchanged: true, used: used.filter((n) => v.form.cover === PENDING + n), current };
    let md = current;
    for (const name of used) {
      const m = this.media.get(name);
      if (m.kind !== 'image') continue;
      const site = this.imageSitePath(name, imgDir);
      if (m.url) md = md.split(m.url).join(site);
      md = md.split(PENDING + name).join(site);
    }
    // 没有登记过的 blob 地址（理论上不会出现）不能写进文件
    if (/\]\(blob:/.test(md)) {
      throw new Error('正文里有图片还没有处理完（blob 地址）。请删除这些图片后重新插入。');
    }
    return { body: md, unchanged: false, used, current };
  }

  computeUpdates(v, mode, imgDir) {
    const u = {};
    const f = v.form;
    const b = v.baseForm;
    const fm = v.fm || {};
    const wantDraft = mode === 'draft';
    if (C.isDraftFm(fm) !== wantDraft) u.draft = wantDraft;
    if (f.title !== b.title) u.title = f.title.trim();
    if (f.description !== b.description) u.description = f.description.trim() ? f.description.trim() : undefined;
    if (this.kind === 'post') {
      if (f.date !== b.date) u.date = f.date || undefined;
      if (!sameList(f.tags, b.tags)) u.tags = f.tags.length ? [...f.tags] : undefined;
      if (!sameList(f.categories, b.categories)) u.categories = f.categories.length ? [...f.categories] : undefined;
      if (f.cover !== b.cover) {
        const cover = isPlainObject(fm.cover) ? { ...fm.cover } : {};
        const val = this.resolveCover(f.cover, imgDir);
        if (val) cover.image = val; else delete cover.image;
        u.cover = Object.keys(cover).length ? cover : undefined;
      }
      if (f.math !== b.math) u.math = f.math;
      if (f.comments !== b.comments) u.comments = f.comments;
      if (f.effect !== b.effect) {
        const bg = isPlainObject(fm.background) ? { ...fm.background } : {};
        if (f.effect) bg.effect = f.effect; else delete bg.effect;
        u.background = Object.keys(bg).length ? bg : undefined;
      }
    } else {
      if (f.linkTitle !== b.linkTitle) u.linkTitle = f.linkTitle.trim() ? f.linkTitle.trim() : undefined;
      if (f.inMenu !== b.inMenu || f.weight !== b.weight) u.menu = buildMenu(fm.menu, f.inMenu, f.weight);
    }
    return u;
  }

  newFields(v, mode, imgDir) {
    const f = v.form;
    const out = { title: f.title.trim() };
    if (this.kind === 'post') {
      out.date = f.date || hugoDate();
      out.draft = mode === 'draft';
      if (f.description.trim()) out.description = f.description.trim();
      if (f.tags.length) out.tags = [...f.tags];
      if (f.categories.length) out.categories = [...f.categories];
      const cover = this.resolveCover(f.cover, imgDir);
      if (cover) out.cover = { image: cover };
      if (f.math !== this.siteDefaults.math) out.math = f.math;
      if (f.comments !== this.siteDefaults.comments) out.comments = f.comments;
      if (f.effect) out.background = { effect: f.effect };
    } else {
      if (f.linkTitle.trim()) out.linkTitle = f.linkTitle.trim();
      out.draft = mode === 'draft';
      if (f.description.trim()) out.description = f.description.trim();
      const menu = buildMenu(undefined, f.inMenu, f.weight);
      if (menu) out.menu = menu;
    }
    return out;
  }

  resolveCover(cover, imgDir) {
    if (!cover) return '';
    if (cover.startsWith(PENDING)) return this.imageSitePath(cover.slice(PENDING.length), imgDir);
    return cover;
  }

  validate(v) {
    if (!v.form.title.trim()) {
      this.els.titleError.hidden = false;
      this.els.title.focus();
      toast('请先填写标题', { type: 'warning' });
      return false;
    }
    if (this.isNewGroup && this.kind === 'post') {
      const err = this.slugError();
      if (err) {
        this.toggleSettings(true);
        if (this.els.slugInput) {
          this.els.slugInput.focus();
          this.els.slugUpdate && this.els.slugUpdate();
        }
        toast(err, { type: 'warning' });
        return false;
      }
    }
    if (this.kind === 'page' && v.form.inMenu && v.form.weight && !/^-?\d+$/.test(v.form.weight)) {
      this.toggleSettings(true);
      toast('菜单顺序请填写整数', { type: 'warning' });
      return false;
    }
    return true;
  }

  async save(mode) {
    if (this.saving) return;
    if (this.ctx.isPublishing && this.ctx.isPublishing()) {
      toast('正在发布，请稍候', { type: 'warning' });
      return;
    }
    const btn = mode === 'draft' ? this.els.draftBtn : this.els.publishBtn;
    this.saving = true;
    try {
      await withBusy(btn, () => this.doSave(mode));
    } finally {
      this.saving = false;
    }
  }

  async doSave(mode) {
    this.syncActive();
    const v = this.active;
    if (v.conflict) {
      toast('请先在上方选择「保留我的修改」或「加载最新版本」', { type: 'warning' });
      return;
    }
    if (!this.validate(v)) return;

    // 确认：专属版本存为草稿会让该语言站点上的页面消失；已发表的文章改为草稿会下线
    if (mode === 'draft') {
      if (v.key !== 'shared' && this.sharedPublished()) {
        const ok = await confirmDialog({
          title: `${this.ctx.siteLabel(v.key)}上将看不到这一页`,
          message: `把${C.variantLabel(v.key, this.ctx)}版本保存为草稿后，${this.ctx.siteLabel(v.key)}上这一页会消失 —— 它不会改回显示共用版本。\n\n如果只是想暂存修改，不用担心：修改已经自动保存在这台设备上。`,
          okText: '仍然保存为草稿', danger: true,
        });
        if (!ok) return;
      } else if (v.exists && v.published) {
        const ok = await confirmDialog({
          title: '改为草稿？',
          message: '这一页已经发表了。保存为草稿后，网站上将不再显示它，直到你再次发表。',
          okText: '改为草稿', danger: true,
        });
        if (!ok) return;
      }
    }

    const path = this.isNewGroup && this.kind === 'post'
      ? C.variantPath(PATHS.posts, this.slug.value, null)
      : v.path;
    if (this.isNewGroup && this.repo.has(path)) {
      toast('已经有同名的文件了，请换一个文件名', { type: 'warning' });
      return;
    }
    const imgDir = this.imageDir();

    let content;
    let body;
    let used;
    let newFm;
    try {
      const fb = this.finalBody(v, imgDir);
      body = fb.body;
      used = fb.used;
      if (v.isNew && v.fmText === null) {
        newFm = newFrontMatter(this.newFields(v, mode, imgDir));
      } else {
        const updates = this.computeUpdates(v, mode, imgDir);
        const hasUpdates = Object.keys(updates).length > 0;
        newFm = v.fmText === null && !hasUpdates ? null : setFields(v.fmText ?? '', updates);
      }
      if (fb.unchanged && newFm !== null) {
        // 正文没改：保留结束分隔线之后的原文（逐字节不变）
        const fmPart = newFm.replace(/\n+$/, '');
        content = fmPart ? `---\n${fmPart}\n---\n${v.rawBody}` : `---\n---\n${v.rawBody}`;
      } else if (fb.unchanged && newFm === null) {
        content = v.rawBody;
      } else {
        content = buildDocument(newFm, body);
      }
    } catch (err) {
      console.error('[editor] build failed', err);
      toast(err instanceof FrontMatterError ? err.message : errorMessage(err), { type: 'error', timeout: 9000 });
      return;
    }

    // 什么都没改：不产生提交（文件末尾少一个换行之类的差别也不值得一次提交）
    if (v.exists && !v.isNew && !v.restored && content !== undefined && newFm === v.fmText && body === v.rawBody &&
        !used.some((n) => this.media.get(n) && !this.media.get(n).committed)) {
      toast('内容和网站上的一样，不需要发表', { type: 'info' });
      v.touched = false;
      this.renderAll();
      return;
    }

    const changes = [{ path, content, baseSha: v.exists ? v.sha : null }];
    let imageCount = 0;
    let docCount = 0;
    for (const name of used) {
      const m = this.media.get(name);
      if (!m || m.committed) continue;
      if (m.kind === 'image') {
        changes.push({ path: `${imgDir}/${name}`, content: m.blob });
        imageCount++;
      } else {
        changes.push({ path: `${PATHS.documents}/${name}`, content: m.blob, baseSha: null });
        docCount++;
      }
    }
    const title = v.form.title.trim();
    const verb = mode === 'draft' ? '保存草稿' : (v.exists && v.published ? '更新' : '发表');
    const label = this.variants.size > 1 || v.key !== 'shared' ? `（${C.variantLabel(v.key, this.ctx)}）` : '';
    const summary = [`${verb}：${path}`];
    if (imageCount) summary.push(`上传图片 ${imageCount} 张`);
    if (docCount) summary.push(`上传资料 ${docCount} 个`);

    this.flushAutosave();
    let res;
    try {
      res = await this.ctx.publish({ message: `admin: ${verb}《${title}》${label}`, changes, summary });
    } catch (err) {
      // 外壳已经提示过错误；修改仍在编辑器里和本机草稿中
      console.warn('[editor] publish failed', err);
      return;
    }
    if (this.destroyed) return;
    if (res && res.conflict) {
      this.onConflict(v, res);
      return;
    }

    // ---- 成功 ----
    const sha = (res.shas && res.shas[path]) || this.repo.entry(path)?.sha || v.sha;
    const parsed = splitDocument(content);
    v.path = path;
    v.exists = true;
    v.sha = sha;
    v.fmText = parsed.fmText;
    v.fm = parseFrontMatter(parsed.fmText);
    v.rawBody = parsed.body;
    v._display = undefined;
    if (v.form.cover && v.form.cover.startsWith(PENDING)) v.form.cover = this.resolveCover(v.form.cover, imgDir);
    if (this.isNewGroup && !v.form.date) v.form.date = v.fm.date ? str(v.fm.date) : '';
    v.form = { ...this.formFromFm(v.fm), ...v.form, date: v.fm.date == null ? '' : str(v.fm.date) };
    v.baseForm = clone(v.form);
    v.baseMarkdown = v === this.active ? this.getEditorValue() : v.markdown;
    v.markdown = v.baseMarkdown;
    v.published = mode !== 'draft';
    v.isNew = false;
    v.restored = false;
    v.stale = false;
    v.touched = false;
    v.needsAutosave = false;
    for (const name of used) {
      const m = this.media.get(name);
      if (!m) continue;
      m.committed = true;
      if (m.kind === 'image') recentUploads.set(this.imageSitePath(name, imgDir), m.blob);
    }
    const oldKey = v.draftKey;
    v.draftKey = drafts.draftKeyForPath(path);
    await drafts.deleteDraft(oldKey);
    if (oldKey !== v.draftKey) await drafts.deleteDraft(v.draftKey);
    v.draftWritten = false;
    this.group.variants[v.key] = path;

    if (this.isNewGroup) {
      this.leaving = true;
      this.ctx.navigate('#/edit?path=' + encodeURIComponent(path), { replace: true });
      return;
    }
    this.renderAll();
  }

  onConflict(v, res) {
    this.flushOthers(null);
    if (!res.reloaded) {
      toast('没有发布。你的修改还保留在编辑器里（也已自动保存在本机）。', { type: 'info', timeout: 6000 });
      return;
    }
    // 外壳已经重新读取了仓库：记下文件现在的版本，让用户选择怎么处理
    for (const x of this.variants.values()) {
      if (!x.path) continue;
      const latest = this.repo.entry(x.path);
      const latestSha = latest ? latest.sha : null;
      const expected = x.exists ? x.sha : null;
      if (latestSha !== expected) x.conflict = { sha: latestSha };
    }
    if (!v.conflict) {
      // 冲突出在别的文件（例如同名图片）：直接再试一次即可
      toast('已读取最新版本，请再点一次发表', { type: 'info' });
    }
    this.renderAll();
  }

  keepMine(v) {
    if (!v.conflict) return;
    v.sha = v.conflict.sha;
    v.exists = v.conflict.sha !== null;
    v.conflict = null;
    v.restored = true; // 保证下次发表会写入我们的完整内容
    this.renderAll();
    toast('好的。再点一次「发表 / 更新」，就会用你的版本覆盖 GitHub 上的修改', { type: 'info', timeout: 6000 });
  }

  async reloadVariant(v, { confirmText } = {}) {
    const ok = await confirmDialog({
      title: '加载最新版本？',
      message: confirmText || '你在这个版本里做的、还没有发表的修改会被丢弃（本机草稿也会删除）。',
      okText: '加载最新版本', danger: true,
    });
    if (!ok) return;
    if (!this.repo.has(v.path)) {
      await drafts.deleteDraft(v.draftKey);
      v.conflict = null;
      toast('这个文件已经在 GitHub 上被删除了', { type: 'warning' });
      this.leaving = true;
      this.ctx.navigate(this.listHash(), { replace: true });
      return;
    }
    try {
      const text = await this.repo.readText(v.path);
      const doc = splitDocument(text);
      if (doc.kind === 'toml') throw new Error('这个文件现在使用 TOML 格式的设置区，无法在后台编辑');
      const fm = parseFrontMatter(doc.fmText);
      const fresh = this.makeVariant({ key: v.key, path: v.path, exists: true, sha: this.repo.entry(v.path).sha, fmText: doc.fmText, fm, body: doc.body });
      await drafts.deleteDraft(v.draftKey);
      this.variants.set(v.key, fresh);
      if (this.activeKey === v.key) this.activate(v.key, { initial: true });
      else this.renderAll();
      toast('已加载最新版本', { type: 'success' });
    } catch (err) {
      toast(`读取失败：${errorMessage(err)}`, { type: 'error' });
    }
  }

  // =========================================================================
  // 更多菜单

  toggleMore() {
    if (this.menuEl) { this.closeMore(); return; }
    const items = this.moreItems();
    const menu = h('div', { class: 'ed-menu', role: 'menu', dataset: { testid: 'editor-more-menu' } }, items);
    this.els.moreWrap.appendChild(menu);
    this.els.moreBtn.setAttribute('aria-expanded', 'true');
    this.menuEl = menu;
    const onDoc = (e) => { if (!menu.contains(e.target)) this.closeMore(); };
    const onKey = (e) => { if (e.key === 'Escape') { this.closeMore(); this.els.moreBtn.focus(); } };
    setTimeout(() => document.addEventListener('click', onDoc), 0);
    document.addEventListener('keydown', onKey);
    this.menuCleanup = () => {
      document.removeEventListener('click', onDoc);
      document.removeEventListener('keydown', onKey);
    };
    const first = menu.querySelector('a, button');
    if (first) first.focus();
  }

  closeMore() {
    if (!this.menuEl) return;
    this.menuEl.remove();
    this.menuEl = null;
    if (this.menuCleanup) this.menuCleanup();
    this.menuCleanup = null;
    if (this.els.moreBtn) this.els.moreBtn.setAttribute('aria-expanded', 'false');
  }

  moreItems() {
    const items = [];
    const item = (icon, text, onClick, { testid, danger, disabled } = {}) => h('button', {
      type: 'button', role: 'menuitem', class: ['ed-menu-item', danger && 'is-danger'], disabled: !!disabled,
      dataset: { testid }, on: { click: () => { this.closeMore(); onClick(); } },
    }, svgIcon(icon), h('span', {}, text));

    // 在网站上查看（只列出已发表的语言）
    for (const lang of this.langs) {
      const url = this.siteUrlFor(lang);
      if (!url) continue;
      items.push(h('a', {
        role: 'menuitem', class: 'ed-menu-item', href: url, target: '_blank', rel: 'noopener noreferrer',
        dataset: { testid: `editor-view-${lang}` }, on: { click: () => this.closeMore() },
      }, svgIcon('external'), h('span', {}, `在${this.ctx.siteLabel(lang)}查看`)));
    }
    if (!items.length) {
      items.push(h('div', { class: 'ed-menu-note muted small' }, '发表后可以在网站上查看'));
    }
    items.push(h('div', { class: 'ed-menu-sep', role: 'separator' }));
    const v = this.active;
    const existing = [...this.variants.values()].filter((x) => x.exists);
    if (v.exists && existing.length > 1) {
      items.push(item('trash', `删除此版本（${C.variantLabel(v.key, this.ctx)}）`, () => this.deleteVariant(), { testid: 'editor-delete-variant', danger: true }));
    } else if (!v.exists && !this.isNewGroup) {
      items.push(item('close', '放弃这个新版本', () => this.deleteVariant(), { testid: 'editor-delete-variant', danger: true }));
    }
    if (existing.length) {
      items.push(item('trash', this.kind === 'post' ? '删除整篇文章' : '删除整个页面', () => this.deleteAll(), { testid: 'editor-delete-all', danger: true }));
    } else if (this.isNewGroup) {
      items.push(item('trash', '放弃这篇新文章', () => this.discardNew(), { testid: 'editor-discard-new', danger: true }));
    }
    return items;
  }

  /** 某个语言站点上这一页的网址（只有已发表时才返回）。 */
  siteUrlFor(lang) {
    const own = this.variants.get(lang);
    const v = own && own.exists ? own : this.variants.get('shared');
    if (!v || !v.exists || !v.published) return null;
    const fm = v.fm || {};
    const prefix = lang === this.ctx.defaultLang ? '' : `${lang}/`;
    let rel;
    if (typeof fm.url === 'string' && fm.url.trim()) {
      const raw = fm.url.trim();
      // 只接受站内路径：任何「协议:」开头（包括 javascript:）或 // 开头的地址都不生成链接
      if (/^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith('//')) return null;
      rel = raw.replace(/^\/+/, '');
      const href = new URL(prefix + rel, this.ctx.siteUrl).href;
      return /^https?:/i.test(href) ? href : null;
    }
    const dir = this.group.dir === PATHS.content ? '' : this.group.dir.slice(PATHS.content.length + 1);
    if (this.group.isIndex) rel = dir ? `${dir}/` : '';
    else {
      const base = typeof fm.slug === 'string' && fm.slug.trim() ? fm.slug.trim() : this.group.base;
      rel = `${dir ? dir + '/' : ''}${base}/`;
    }
    return new URL(prefix + rel.toLowerCase(), this.ctx.siteUrl).href;
  }

  listHash() {
    return this.kind === 'post' ? '#/posts' : '#/pages';
  }

  goBack() {
    this.ctx.navigate(this.listHash());
  }

  async discardNew() {
    const ok = await confirmDialog({ title: '放弃这篇新文章？', message: '还没有发表的内容和本机草稿都会被删除。', okText: '放弃', danger: true });
    if (!ok) return;
    this.autosave.cancel();
    for (const v of this.variants.values()) if (v.draftKey) await drafts.deleteDraft(v.draftKey);
    this.leaving = true;
    this.ctx.navigate(this.listHash(), { replace: true });
  }

  async deleteVariant() {
    const v = this.active;
    const label = C.variantLabel(v.key, this.ctx);
    if (!v.exists) {
      const ok = await confirmDialog({ title: '放弃这个新版本？', message: `还没有发表的「${label}」内容和它的本机草稿都会被删除。`, okText: '放弃', danger: true });
      if (!ok) return;
      if (v.draftKey) await drafts.deleteDraft(v.draftKey);
      this.variants.delete(v.key);
      this.activate([...this.variants.keys()][0], { initial: true });
      return;
    }
    let message;
    if (v.key !== 'shared') {
      message = this.variants.get('shared')?.exists
        ? `删除后，${this.ctx.siteLabel(v.key)}将改回显示共用版本。`
        : `删除后，${this.ctx.siteLabel(v.key)}上将不再有这一页。`;
    } else {
      const lose = this.langs.filter((l) => !(this.variants.get(l) && this.variants.get(l).exists));
      const keep = this.langs.filter((l) => this.variants.get(l) && this.variants.get(l).exists);
      message = '只删除共用版本这一个文件。';
      if (lose.length) message += `删除后，${lose.map((l) => this.ctx.siteLabel(l)).join('、')}上将不再有这一页；`;
      if (keep.length) message += `${keep.map((l) => this.ctx.siteLabel(l)).join('、')}继续显示各自的专属版本。`;
    }
    const ok = await confirmDialog({ title: `删除${label}？`, message: `${message}\n\n文件：${v.path}`, okText: '删除', danger: true });
    if (!ok) return;
    let res;
    try {
      res = await this.ctx.publish({
        message: `admin: 删除《${v.form.title.trim() || this.group.base}》的${label}`,
        changes: [{ path: v.path, delete: true, baseSha: v.sha }],
        summary: [`删除：${v.path}`],
      });
    } catch { return; }
    if (res && res.conflict) { this.onConflict(v, res); return; }
    this.autosave.cancel();
    if (v.draftKey) await drafts.deleteDraft(v.draftKey);
    await this.flushOthers(v);
    const remaining = [...this.variants.values()].find((x) => x !== v && x.exists);
    this.leaving = true;
    this.ctx.navigate(remaining ? '#/edit?path=' + encodeURIComponent(remaining.path) : this.listHash(), { replace: true });
  }

  /** 离开前确保其他版本未发表的修改已经写进本机草稿。 */
  async flushOthers(except) {
    for (const x of this.variants.values()) if (x !== except && this.variantDirty(x)) x.needsAutosave = true;
    this.autosave.cancel();
    await this.autosaveNow();
  }

  async deleteAll() {
    const existing = [...this.variants.values()].filter((x) => x.exists);
    const imgDir = this.imageDir();
    const images = this.repo.list(imgDir + '/');
    const title = this.active.form.title.trim() || this.group.base;
    const cb = h('input', { type: 'checkbox', dataset: { testid: 'editor-delete-images' } });
    const what = this.kind === 'post' ? '文章' : '页面';
    const content = h('div', { class: 'stack-sm stack' },
      h('p', { class: 'modal-message' }, `《${title}》的所有语言版本都会从网站上删除：`),
      h('ul', { class: 'conflict-list' }, existing.map((x) => h('li', {}, h('code', {}, x.path)))),
      images.length ? h('label', { class: 'checkbox' }, cb, `同时删除这篇${what}的图片文件夹 ${imgDir}/（${images.length} 个文件）`) : null,
      h('p', { class: 'muted small' }, '删除后可以在 GitHub 的提交历史里找回。'));
    let confirmed = false;
    await new Promise((resolve) => {
      modal({
        title: `删除整${this.kind === 'post' ? '篇文章' : '个页面'}？`,
        content,
        actions: [
          { text: '取消', kind: 'ghost', testid: 'confirm-cancel' },
          { text: '删除', kind: 'danger', testid: 'confirm-ok', onClick: (close) => { confirmed = true; close(); } },
        ],
        onClose: resolve,
      });
    });
    if (!confirmed) return;
    const changes = existing.map((x) => ({ path: x.path, delete: true, baseSha: x.sha }));
    if (cb.checked) for (const e of images) changes.push({ path: e.path, delete: true });
    let res;
    try {
      res = await this.ctx.publish({
        message: `admin: 删除《${title}》`,
        changes,
        summary: [`删除 ${existing.length} 个文件${cb.checked && images.length ? `和 ${images.length} 张图片` : ''}`],
      });
    } catch { return; }
    if (res && res.conflict) { this.onConflict(this.active, res); return; }
    this.autosave.cancel();
    for (const x of this.variants.values()) if (x.draftKey) await drafts.deleteDraft(x.draftKey);
    for (const o of this.orphanDrafts) await drafts.deleteDraft(o.key);
    this.leaving = true;
    this.ctx.navigate(this.listHash(), { replace: true });
  }

  // =========================================================================
  // 手机预览

  openPreview() {
    this.syncActive();
    const multi = this.langs.length > 1 && this.variants.size > 1;
    let lang = this.activeKey === 'shared' ? this.ctx.defaultLang : this.activeKey;
    let dark = this.isDarkUI();
    const iframe = h('iframe', {
      class: 'ed-phone-frame', sandbox: 'allow-same-origin', title: '手机预览', referrerpolicy: 'no-referrer',
      dataset: { testid: 'preview-iframe', state: 'loading' },
    });
    const loading = h('div', { class: 'ed-phone-loading' }, h('span', { class: 'spinner' }), '正在生成预览…');
    const themeBtns = [
      { val: false, text: '浅色', icon: 'sun', testid: 'preview-light' },
      { val: true, text: '深色', icon: 'moon', testid: 'preview-dark' },
    ].map((o) => h('button', {
      type: 'button', class: 'tab', dataset: { testid: o.testid },
      on: { click: () => { dark = o.val; update(); } },
    }, svgIcon(o.icon), o.text));
    const langBtns = multi ? this.langs.map((l) => h('button', {
      type: 'button', class: 'tab', dataset: { testid: `preview-lang-${l}` },
      on: { click: () => { lang = l; update(); } },
    }, this.ctx.siteLabel(l))) : [];
    const note = h('div', { class: 'muted small ed-preview-note' });
    const content = h('div', { class: 'ed-preview' },
      h('div', { class: 'ed-preview-controls' },
        h('div', { class: 'tabs tabs-pill', role: 'group', 'aria-label': '颜色' }, themeBtns),
        multi ? h('div', { class: 'tabs tabs-pill', role: 'group', 'aria-label': '站点' }, langBtns) : null),
      h('div', { class: 'ed-phone' }, h('div', { class: 'ed-phone-screen' }, iframe, loading)),
      note);
    modal({ title: '手机预览', content, className: 'ed-preview-modal' });

    let seq = 0;
    const update = async () => {
      const my = ++seq;
      themeBtns.forEach((b, i) => b.classList.toggle('active', (i === 1) === dark));
      langBtns.forEach((b, i) => b.classList.toggle('active', this.langs[i] === lang));
      const v = this.variants.get(lang) || this.variants.get('shared');
      if (!v) {
        note.textContent = `${this.ctx.siteLabel(lang)}上没有这一页。`;
        return;
      }
      note.textContent = `${this.ctx.siteLabel(lang)} · ${C.variantLabel(v.key, this.ctx)}${this.variantDirty(v) ? '（含未发表的修改）' : ''} · 实际效果以发表后的网站为准`;
      loading.hidden = false;
      iframe.dataset.state = 'loading';
      try {
        await renderPreview(iframe, {
          title: v.form.title,
          date: v.form.date ? formatDate(v.form.date) : '',
          description: this.kind === 'post' ? v.form.description : '',
          markdown: this.getVariantMarkdown(v),
          dark,
          lang,
          cover: this.coverDisplayUrl(v.form.cover) || '',
          siteUrl: this.ctx.siteUrl,
        });
      } catch (err) {
        if (my === seq) toast(`预览失败：${errorMessage(err)}`, { type: 'error' });
      }
      if (my !== seq) return;
      loading.hidden = true;
      iframe.dataset.state = 'ready';
      iframe.dataset.lang = lang;
      iframe.dataset.theme = dark ? 'dark' : 'light';
    };
    update();
  }

  // =========================================================================
  // 离开 / 卸载

  async canLeave() {
    if (this.leaving || !this.isDirty()) return true;
    this.syncActive();
    for (const v of this.variants.values()) if (this.variantDirty(v)) v.needsAutosave = true;
    this.autosave.cancel();
    await this.autosaveNow();
    const ok = await confirmDialog({
      title: '还有修改没有发表',
      message: this.autosaveOk
        ? '这些修改已经自动保存在这台设备上，下次打开时可以恢复。确定要离开吗？'
        : '这个浏览器无法保存本机草稿，离开后这些修改会丢失。确定要离开吗？',
      okText: '离开', cancelText: '继续编辑', danger: !this.autosaveOk,
    });
    if (ok) this.leaving = true;
    return ok;
  }

  destroy() {
    if (this.destroyed) return;
    // 立即写入本机草稿（例如登录失效、关闭标签页之前切换视图）
    try {
      this.syncActive();
      if (this.autosave.pending()) {
        this.flushing = true;
        this.autosave.flush();
      }
    } catch (err) { console.warn(err); }
    this.destroyed = true;
    this.closeMore();
    document.removeEventListener('keydown', this.onKeyDown, true);
    document.removeEventListener('visibilitychange', this.onHidden);
    window.removeEventListener('pagehide', this.onHidden);
    try { if (this.vd) this.vd.destroy(); } catch { /* ignore */ }
    this.vd = null;
    // blob 地址不再需要（图片本身在 recentUploads / 本机草稿里）。稍后再释放，避免正在保存的草稿读不到。
    const urls = [...this.urlToName.keys()];
    setTimeout(() => urls.forEach((u) => { try { URL.revokeObjectURL(u); } catch { /* ignore */ } }), 5000);
  }
}

/** 根据「显示在菜单 / 顺序」生成新的 menu 值（保留其他菜单和 main 下的其他键）。 */
function buildMenu(orig, inMenu, weight) {
  let m;
  if (isPlainObject(orig)) m = clone(orig);
  else if (typeof orig === 'string') m = orig === 'main' || !orig ? {} : { [orig]: {} };
  else if (Array.isArray(orig)) m = Object.fromEntries(orig.filter((x) => typeof x === 'string' && x !== 'main').map((x) => [x, {}]));
  else m = {};
  if (inMenu) {
    const main = isPlainObject(m.main) ? { ...m.main } : {};
    const w = Number.parseInt(String(weight).trim(), 10);
    if (String(weight).trim() !== '' && Number.isFinite(w)) main.weight = w;
    else delete main.weight;
    m.main = main;
  } else {
    delete m.main;
  }
  return Object.keys(m).length ? m : undefined;
}
