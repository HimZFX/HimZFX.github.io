/**
 * views/profile.js — 「首页设置」（ADMIN_SPEC §6.4）。
 *
 * 读取 params.toml / languages.toml / hugo.toml，用表单编辑首页的：
 *   - 头像（裁剪成正方形 JPEG；可同时生成浏览器标签页图标 favicon）
 *   - 名字、简介、网站标题；非默认语言（英文站）可单独设置名字 / 简介
 *     （写到 languages.toml 的 [en.params.profileMode]，留空 = 删除该键，表空了就删表头）
 *   - 首页按钮、社交链接（增删、上移下移）
 *   - 节日图标（开关 + 规则）
 * 所有修改只用 tomlpatch 做「外科手术式」修改：没改的行（包括注释）一个字节都不动。
 * 「保存并发布」= 确认改动清单 → 一次 ctx.publish（每个文件带读取时的 baseSha，防止覆盖别人的修改）。
 *
 * 数据模型：base（文件里的值，转成表单用的字符串）和 form（用户正在编辑的值）结构相同；
 * 是否有修改 = 两者比较；发布时只对「变了的字段」调用 tomlpatch。
 *
 * @module views/profile
 */

import {
  h, svgIcon, render, clear, toast, modal, confirmDialog, withBusy, badge, loadingState,
  errorState, errorMessage, formatDate,
} from '../ui.js';
import { parseToml, getIn, setValue, replaceArrayOfTables, removeTableIfEmpty } from '../tomlpatch.js';
import { loadImage, cropToBlob, extOf } from '../images.js';
import { PATHS, LIMITS } from '../config.js';

// ---------------------------------------------------------------------------
// 常量

/** 社交图标下拉框里的常用选项（名字必须是 PaperMod svg.html 支持的）。 */
const SOCIAL_CHOICES = [
  ['github', 'GitHub'], ['email', '邮箱'], ['googlescholar', 'Google Scholar'], ['orcid', 'ORCID'],
  ['researchgate', 'ResearchGate'], ['linkedin', 'LinkedIn'], ['x', 'X'], ['twitter', 'Twitter'],
  ['zhihu', '知乎'], ['bilibili', '哔哩哔哩'], ['wechat', '微信'], ['douban', '豆瓣'], ['juejin', '掘金'],
  ['qq', 'QQ'], ['telegram', 'Telegram'], ['discord', 'Discord'], ['youtube', 'YouTube'],
  ['instagram', 'Instagram'], ['facebook', 'Facebook'], ['mastodon', 'Mastodon'], ['bluesky', 'Bluesky'],
  ['medium', 'Medium'], ['stackoverflow', 'Stack Overflow'], ['kaggle', 'Kaggle'], ['leetcode', 'LeetCode'],
  ['gitlab', 'GitLab'], ['cv', '简历 CV'], ['rss', 'RSS 订阅'],
];
const SOCIAL_LABELS = Object.fromEntries(SOCIAL_CHOICES);
const OTHER = '__other__';

/** PaperMod（themes/PaperMod/layouts/partials/svg.html）支持的全部图标名，用于提示「主题里没有这个图标」。 */
const PAPERMOD_ICONS = new Set(('123rf 500px adobestock anilist ao3 archiveofourown applemusic applepodcasts bandcamp behance ' +
  'bilibili bitcoin bluesky bookwyrm bugcrowd buttondown buymeacoffee codeberg codeforces codepen credly cryptohack ctftime cv ' +
  'deezer dev deviantart discogs discord douban dreamstime dribbble dzen email ethereum exercism facebook farcaster fediverse ' +
  'firefish flickr forgejo freepik git gitea github gitlab goodreads googleplaystore googlepodcasts googlescholar gurushots ' +
  'hackerone hackerrank hackthebox imdb instagram intigriti itchio juejin kaggle kakaotalk keybase keyoxide kofi komoot lastfm ' +
  'leetcode letterboxd liberapay lichess linkedin linktree mastodon matrix medium microblog mixcloud monero neteasecloudmusic ' +
  'nextcloud nostr nuget orcid overcast patreon paypal peertube pgpkey key phone pinterest pixelfed pleroma pocketcasts printables ' +
  'qq reddit raycast researchgate rootme rss serverfault sessionmessenger shutterstock signal sketchfab slack snapchat soundcloud ' +
  'sourcehut spacehey spotify stackoverflow steam strava substack tableau telegram thingiverse threads threema tidal tiktok ' +
  'tryhackme tumblr twitch twitter unity unsplash vimeo vk vkontakte wantedly wechat whatsapp wikipedia wiki wordpress x xda xing ' +
  'xmpp ycombinator yeswehack youtube zcal zhihu jamendo').split(' '));

const BUTTON_KEYS = ['name', 'url'];
const SOCIAL_KEYS = ['name', 'url'];
const RULE_KEYS = ['emoji', 'from', 'to'];

/** 表单项对应的原始 TOML 对象（保留我们不认识的键，例如社交图标的 title）。Symbol 不会进 JSON。 */
const ORIG = Symbol('orig');

const SECTION_NAMES = {
  avatar: '头像', names: '名字与简介', buttons: '首页按钮', social: '社交链接', holiday: '节日图标',
};

let idSeq = 0;
const uid = (p) => `pf-${p}-${++idSeq}`;

// ---------------------------------------------------------------------------
// 纯函数：模型 ⇄ 文件

const str = (v) => (v == null ? '' : typeof v === 'string' ? v : String(v));
const plainObj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : null);

function itemsFrom(arr, keys) {
  if (!Array.isArray(arr)) return [];
  return arr.filter(plainObj).map((o) => {
    const it = {};
    for (const k of keys) it[k] = str(o[k]);
    it[ORIG] = o;
    return it;
  });
}

const pick = (it, keys) => keys.map((k) => it[k]);
const sameList = (a, b, keys) => JSON.stringify(a.map((x) => pick(x, keys))) === JSON.stringify(b.map((x) => pick(x, keys)));
const cloneList = (list) => list.map((it) => ({ ...it })); // 展开运算会复制 Symbol 键

/** 写回 TOML 用的对象：没改过的项原样用原对象（tomlpatch 会保留它的原文），改过的只覆盖这几个键。 */
function toOut(it, keys) {
  const o = it[ORIG];
  if (o && keys.every((k) => str(o[k]) === it[k])) return o;
  const out = { ...(o || {}) };
  for (const k of keys) out[k] = it[k];
  return out;
}

/**
 * 头像文件应该写到哪里：imageUrl 是相对路径时写到 static/<imageUrl>；
 * 是外部网址 / 不是 .jpg 时改成写 static/avatar.jpg（同目录同名 .jpg），并更新 imageUrl。
 * @returns {{ path: string, imageUrl: string }}
 */
export function avatarTarget(imageUrl) {
  const fallback = { path: PATHS.avatar, imageUrl: PATHS.avatar.replace(/^static\//, '') };
  const u = staticRel(imageUrl);
  if (!u) return fallback;
  if (/\.jpe?g$/i.test(u)) return { path: 'static/' + u, imageUrl: str(imageUrl).trim() };
  const jpg = u.replace(/\.[^./]*$/, '') + '.jpg';
  return { path: 'static/' + jpg, imageUrl: jpg };
}

/** 站内图片地址 → static/ 下的相对路径（去掉 ?#、开头的 /）；外部网址 / 不安全的路径 → null。 */
function staticRel(imageUrl) {
  let u = str(imageUrl).trim();
  if (!u || /^[a-z][a-z0-9+.-]*:/i.test(u) || u.startsWith('//')) return null;
  u = u.split(/[?#]/)[0].replace(/^\/+/, '');
  try { u = decodeURIComponent(u); } catch { /* 保持原样 */ }
  if (!u || u.endsWith('/') || u.split('/').some((seg) => seg === '..' || seg === '.' || seg === '') || u.includes('\\')) return null;
  if (/^admin\//.test(u)) return null;
  return u;
}

/**
 * 显示「当前头像」时读仓库里的哪个文件：就是 imageUrl 指向的文件（不像 avatarTarget 那样改成 .jpg）。
 * @returns {string|null} 例如 'static/avatar.png'；外部网址 → null
 */
export function avatarSourcePath(imageUrl) {
  const u = staticRel(imageUrl);
  return u ? 'static/' + u : null;
}

const IMAGE_MIME = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif',
  svg: 'image/svg+xml', bmp: 'image/bmp', ico: 'image/x-icon',
};

/** 32 位 FNV-1a → 8 位十六进制。用作图标地址里的版本号（内容变了，地址就变）。 */
export function shortHash(bytes) {
  let x = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    x ^= bytes[i];
    x = Math.imul(x, 0x01000193);
  }
  return (x >>> 0).toString(16).padStart(8, '0');
}

/**
 * [assets] 里指向我们写的 static/favicon.jpg 的图标地址，换成带版本号的新地址（'/favicon.jpg?v=1a2b3c4d'）。
 * GitHub Pages 给每个文件 10 分钟缓存，浏览器还会单独缓存标签页图标；地址不变时换了图标也看不到。
 * 指向别的文件 / 外部网址时返回 null（不改）。
 */
export function versionedFaviconHref(cur, ver) {
  const s = str(cur).trim();
  if (!s || !ver || /^[a-z][a-z0-9+.-]*:/i.test(s) || s.startsWith('//')) return null;
  const pathPart = s.split(/[?#]/)[0];
  if (pathPart.replace(/^\/+/, '') !== PATHS.favicon.replace(/^static\//, '')) return null;
  const next = `${pathPart}?v=${ver}`;
  return next === s ? null : next;
}

// ---------------------------------------------------------------------------
// 本机自动保存（IndexedDB）
//
// 首页设置的修改（含裁剪好的新头像）只在内存里的话，手机切到后台被系统回收、iOS 关标签页
// （不触发 beforeunload）、选照片时页面被重新加载、令牌失效（外壳直接卸载视图）都会让它们消失。
// 所以每次修改后（防抖）存一份到本机，下次打开「首页设置」时提示恢复。
// 用单独的数据库：drafts.js 的草稿库会被「文章 / 页面」列表当成文章草稿列出来。
// 和 drafts.js 一样：任何失败都安静地返回空结果，永远不影响正常使用。

const LOCAL_DB = 'himzfx-admin-profile';
const LOCAL_STORE = 'state';
const LOCAL_KEY = 'home';
const LOCAL_VERSION = 1;
let localDbPromise = null;

function localDb() {
  if (localDbPromise) return localDbPromise;
  localDbPromise = new Promise((resolve) => {
    let idb = null;
    try { idb = typeof indexedDB !== 'undefined' ? indexedDB : null; } catch { idb = null; }
    if (!idb) return resolve(null);
    let settled = false;
    const done = (db) => {
      if (settled) { if (db) try { db.close(); } catch { /* ignore */ } return; }
      settled = true;
      clearTimeout(timer);
      resolve(db);
    };
    const timer = setTimeout(() => done(null), 4000);
    let req;
    try { req = idb.open(LOCAL_DB, 1); } catch { return done(null); }
    req.onupgradeneeded = () => {
      try { if (!req.result.objectStoreNames.contains(LOCAL_STORE)) req.result.createObjectStore(LOCAL_STORE); } catch { /* onerror */ }
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => { try { db.close(); } catch { /* ignore */ } localDbPromise = null; };
      db.onclose = () => { localDbPromise = null; };
      done(db);
    };
    req.onerror = (e) => { if (e && e.preventDefault) e.preventDefault(); done(null); };
  }).then((db) => {
    if (!db) localDbPromise = null;
    return db;
  });
  return localDbPromise;
}

async function localOp(mode, fn, fallback) {
  const db = await localDb();
  if (!db) return fallback;
  return new Promise((resolve) => {
    let tx;
    let get;
    try {
      tx = db.transaction(LOCAL_STORE, mode);
      get = fn(tx.objectStore(LOCAL_STORE));
    } catch {
      return resolve(fallback);
    }
    tx.oncomplete = () => { try { resolve(typeof get === 'function' ? get() : get); } catch { resolve(fallback); } };
    tx.onerror = (e) => { if (e && e.preventDefault) e.preventDefault(); resolve(fallback); };
    tx.onabort = () => resolve(fallback);
  });
}

const localLoad = () => localOp('readonly', (s) => { const r = s.get(LOCAL_KEY); return () => r.result; }, undefined).catch(() => undefined);
const localPut = (rec) => localOp('readwrite', (s) => { s.put(rec, LOCAL_KEY); return () => true; }, false).catch(() => false);
const localDelete = () => localOp('readwrite', (s) => { s.delete(LOCAL_KEY); return () => true; }, false).catch(() => false);

// ---------------------------------------------------------------------------
// 发布新头像后刷新本机浏览器缓存
//
// GitHub Pages 的每个文件都带 Cache-Control: max-age=600。头像地址（/avatar.jpg）不变，
// 所以这个浏览器 10 分钟内打开网站仍会显示缓存里的旧头像，看起来像「没改成功」。
// 发布后在后台用 cache: 'reload' 重新下载它（这会更新浏览器缓存），直到网站上的文件就是新头像
// （= 部署完成），然后把各语言首页也刷新一次。只访问本站（与后台同源），不带令牌。

let warmGen = 0;

function sameBytes(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function refreshSiteCache({ url, bytes }, pages, { firstDelay = 10000, every = 15000, maxMs = 8 * 60000 } = {}) {
  if (typeof fetch !== 'function' || !bytes) return;
  const gen = ++warmGen;
  const t0 = Date.now();
  const get = async (u) => {
    const r = await fetch(u, { cache: 'reload', credentials: 'same-origin' });
    const buf = new Uint8Array(await r.arrayBuffer()); // 读完正文，缓存条目才完整
    return r.ok ? buf : null;
  };
  const tick = async () => {
    if (gen !== warmGen) return; // 又发布了新头像：由新的任务接手
    let live = false;
    try {
      const got = await get(url);
      live = !!got && sameBytes(got, bytes);
    } catch { /* 网络问题：下次再试 */ }
    if (live) {
      for (const p of pages) get(p).catch(() => {});
      return;
    }
    if (Date.now() - t0 < maxMs) setTimeout(tick, every);
  };
  setTimeout(tick, firstDelay);
}

/**
 * 从三个配置文件读出表单模型。
 * @param {{ params: object, languages: object, hugo: object }} cfg 解析后的对象
 * @param {string[]} overrideLangs 需要「单独设置」的语言
 */
function modelFrom(cfg, overrideLangs) {
  const pm = plainObj(cfg.params.profileMode) || {};
  const hf = plainObj(cfg.params.holidayFavicon) || {};
  const overrides = {};
  for (const lang of overrideLangs) {
    const o = plainObj(getIn(cfg.languages, [lang, 'params', 'profileMode'])) || {};
    overrides[lang] = { title: str(o.title), subtitle: str(o.subtitle) };
  }
  return {
    title: str(pm.title),
    subtitle: str(pm.subtitle),
    imageUrl: str(pm.imageUrl),
    siteTitle: str(cfg.hugo.title),
    overrides,
    buttons: itemsFrom(pm.buttons, BUTTON_KEYS),
    social: itemsFrom(cfg.params.socialIcons, SOCIAL_KEYS),
    holidayEnabled: hf.enabled === true,
    rules: itemsFrom(hf.rules, RULE_KEYS),
  };
}

function cloneModel(m) {
  const overrides = {};
  for (const [k, v] of Object.entries(m.overrides)) overrides[k] = { ...v };
  return { ...m, overrides, buttons: cloneList(m.buttons), social: cloneList(m.social), rules: cloneList(m.rules) };
}

const LISTS = [['buttons', BUTTON_KEYS], ['social', SOCIAL_KEYS], ['rules', RULE_KEYS]];

/** 模型 → 能存进 IndexedDB 的普通对象（Symbol 键存不进去，原始 TOML 对象放到 orig 里）。 */
function serModel(m, { withOrig = true } = {}) {
  const overrides = {};
  for (const [k, v] of Object.entries(m.overrides)) overrides[k] = { title: v.title, subtitle: v.subtitle };
  const out = { title: m.title, subtitle: m.subtitle, imageUrl: m.imageUrl, siteTitle: m.siteTitle, holidayEnabled: m.holidayEnabled, overrides };
  for (const [k, keys] of LISTS) {
    out[k] = m[k].map((it) => {
      const o = {};
      for (const key of keys) o[key] = it[key];
      if (withOrig && it[ORIG]) o.orig = it[ORIG];
      return o;
    });
  }
  return out;
}

/**
 * serModel 的反过程。没有 orig 的项，从 ref（当前文件的模型）里找内容相同的项借用它的原始对象，
 * 这样没改过的项写回时仍然原样保留（包括我们不认识的键）。
 */
function deserModel(o, ref) {
  const src = plainObj(o) || {};
  const overrides = {};
  for (const [k, v] of Object.entries(plainObj(src.overrides) || {})) {
    overrides[k] = { title: str(v && v.title), subtitle: str(v && v.subtitle) };
  }
  const m = {
    title: str(src.title), subtitle: str(src.subtitle), imageUrl: str(src.imageUrl), siteTitle: str(src.siteTitle),
    holidayEnabled: src.holidayEnabled === true, overrides,
  };
  for (const [k, keys] of LISTS) {
    const refItems = ref ? ref[k] : [];
    m[k] = (Array.isArray(src[k]) ? src[k] : []).filter(plainObj).map((x) => {
      const it = {};
      for (const key of keys) it[key] = str(x[key]);
      let orig = plainObj(x.orig);
      if (!orig) {
        const same = refItems.find((r) => keys.every((key) => r[key] === it[key]));
        orig = same ? same[ORIG] : null;
      }
      if (orig) it[ORIG] = orig;
      return it;
    });
  }
  return m;
}

/** 让 m.overrides 正好包含 langs 这些语言（缺的从 fallback 补，没有就是空）。 */
function fitOverrides(m, langs, fallback) {
  const overrides = {};
  for (const l of langs) {
    const v = m.overrides[l] || (fallback && fallback.overrides[l]) || { title: '', subtitle: '' };
    overrides[l] = { title: str(v.title), subtitle: str(v.subtitle) };
  }
  return { ...m, overrides };
}

/** 各区块是否有修改（不含头像）。 */
function changedSections(base, form) {
  const names = form.title !== base.title || form.subtitle !== base.subtitle || form.siteTitle !== base.siteTitle ||
    Object.keys(form.overrides).some((l) => ['title', 'subtitle'].some((k) => form.overrides[l][k].trim() !== base.overrides[l][k].trim()));
  return {
    names,
    buttons: !sameList(form.buttons, base.buttons, BUTTON_KEYS),
    social: !sameList(form.social, base.social, SOCIAL_KEYS),
    holiday: form.holidayEnabled !== base.holidayEnabled || !sameList(form.rules, base.rules, RULE_KEYS),
  };
}

/**
 * 用 tomlpatch 生成新的文件内容（只改变了的字段）。
 * @returns {{ params: string, languages: string, hugo: string }}
 * @throws {TomlPatchError} 中文消息
 */
function patchTexts(texts, base, form, { avatarImageUrl, assetHrefs } = {}) {
  let p = texts.params;
  if (form.title !== base.title) p = setValue(p, 'profileMode', 'title', form.title);
  for (const [key, href] of Object.entries(assetHrefs || {})) p = setValue(p, 'assets', key, href);
  if (form.subtitle !== base.subtitle) p = setValue(p, 'profileMode', 'subtitle', form.subtitle);
  if (avatarImageUrl != null && avatarImageUrl !== base.imageUrl) p = setValue(p, 'profileMode', 'imageUrl', avatarImageUrl);
  if (!sameList(form.buttons, base.buttons, BUTTON_KEYS)) {
    p = replaceArrayOfTables(p, 'profileMode.buttons', form.buttons.map((it) => toOut(it, BUTTON_KEYS)));
  }
  if (!sameList(form.social, base.social, SOCIAL_KEYS)) {
    p = replaceArrayOfTables(p, 'socialIcons', form.social.map((it) => toOut(it, SOCIAL_KEYS)));
  }
  if (form.holidayEnabled !== base.holidayEnabled) p = setValue(p, 'holidayFavicon', 'enabled', form.holidayEnabled);
  if (!sameList(form.rules, base.rules, RULE_KEYS)) {
    p = setValue(p, 'holidayFavicon', 'rules', form.rules.length ? form.rules.map((it) => toOut(it, RULE_KEYS)) : undefined);
  }

  let l = texts.languages;
  for (const lang of Object.keys(form.overrides)) {
    const tablePath = [lang, 'params', 'profileMode'];
    let touched = false;
    for (const key of ['title', 'subtitle']) {
      const v = form.overrides[lang][key].trim();
      if (v === base.overrides[lang][key].trim()) continue;
      touched = true;
      l = setValue(l, tablePath, key, v === '' ? undefined : v);
    }
    if (touched) l = removeTableIfEmpty(l, tablePath);
  }

  let hg = texts.hugo;
  if (form.siteTitle !== base.siteTitle) hg = setValue(hg, '', 'title', form.siteTitle);
  return { params: p, languages: l, hugo: hg };
}

// ---- 校验 ----

const MONTH_DAYS = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/** '1-5' / '1/5' / '1.5' / '1月5日' / '0105' → '01-05'；无法识别时原样返回（trim 后）。 */
export function normalizeMonthDay(v) {
  const s = str(v).trim();
  let m = s.match(/^(\d{1,2})\s*[-/.月]\s*(\d{1,2})\s*日?$/);
  if (!m) m = s.match(/^(\d{2})(\d{2})$/);
  if (!m) return s;
  return `${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
}

/** 'MM-DD' 是否是有效日期（允许 02-29）。 */
export function isMonthDay(s) {
  const m = /^(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const mo = Number(m[1]);
  const d = Number(m[2]);
  return mo >= 1 && mo <= 12 && d >= 1 && d <= MONTH_DAYS[mo - 1];
}

function graphemes(s) {
  try {
    if (typeof Intl !== 'undefined' && Intl.Segmenter) return [...new Intl.Segmenter('zh', { granularity: 'grapheme' }).segment(s)].length;
  } catch { /* ignore */ }
  return [...s].length;
}

const BAD_SCHEME = /^\s*(javascript|data|vbscript):/i;

function validateButton(it) {
  const errors = {};
  const warnings = {};
  if (!it.name.trim()) errors.name = '请填写按钮名称';
  const u = it.url.trim();
  if (!u) errors.url = '请填写链接';
  else if (BAD_SCHEME.test(u)) errors.url = '不支持这种链接';
  else if (/\s/.test(u)) errors.url = '链接里不能有空格';
  else if (u.startsWith('/') && !u.startsWith('//')) warnings.url = '以 / 开头的站内链接在英文站不会自动加 /en/，建议写成「' + u.replace(/^\/+/, '') + '」';
  else if (/^(www\.|[a-z0-9-]+\.(com|cn|org|net|io|edu)(\/|$))/i.test(u)) warnings.url = '外部网址请以 https:// 开头，否则会被当成站内路径';
  return { errors, warnings };
}

function validateSocial(it) {
  const errors = {};
  const warnings = {};
  const name = it.name.trim();
  if (!name) errors.name = '请选择或填写图标';
  else if (!/^[A-Za-z0-9_-]+$/.test(name)) errors.name = '图标名只能用英文字母、数字、- 和 _';
  else if (!PAPERMOD_ICONS.has(name.toLowerCase())) warnings.name = `主题里可能没有「${name}」这个图标，网站上会显示成空白`;
  const u = it.url.trim();
  if (!u) errors.url = '请填写链接';
  else if (BAD_SCHEME.test(u)) errors.url = '不支持这种链接';
  else if (/\s/.test(u)) errors.url = '链接里不能有空格';
  else if (name === 'email' && !/^mailto:/i.test(u)) warnings.url = '邮箱链接要以 mailto: 开头，例如 mailto:me@example.com';
  else if (name !== 'email' && !/^(https?:|mailto:|tel:)/i.test(u) && !u.startsWith('/')) warnings.url = '外部网址请以 https:// 开头';
  return { errors, warnings };
}

function validateRule(it) {
  const errors = {};
  const warnings = {};
  const e = it.emoji.trim();
  if (!e) errors.emoji = '请填一个 emoji';
  else if (graphemes(e) > 1) warnings.emoji = '建议只填一个 emoji（标签页图标很小）';
  if (!it.from.trim()) errors.from = '请填开始日期';
  else if (!isMonthDay(it.from.trim())) errors.from = '日期格式是 月-日，例如 01-22';
  if (!it.to.trim()) errors.to = '请填结束日期';
  else if (!isMonthDay(it.to.trim())) errors.to = '日期格式是 月-日，例如 02-15';
  return { errors, warnings };
}

/** 今天会显示哪个节日 emoji（与 layouts/partials/features/holiday-favicon.html 相同的规则）。 */
function todayHoliday(rules, now = new Date()) {
  const pad = (n) => (n < 10 ? '0' : '') + n;
  const today = `${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  for (const r of rules) {
    const from = r.from.trim();
    const to = r.to.trim() || from;
    if (!isMonthDay(from) || !isMonthDay(to)) continue;
    const hit = from <= to ? today >= from && today <= to : today >= from || today <= to;
    if (hit) return { today, emoji: r.emoji.trim() };
  }
  return { today, emoji: null };
}

// ---- 改动说明 ----

function q(s, n = 36) {
  const t = str(s).trim();
  if (!t) return '（空）';
  return `「${t.length > n ? t.slice(0, n) + '…' : t}」`;
}

function describeList(before, after, keys, labelOf) {
  if (sameList(before, after, keys)) return null;
  const parts = [];
  const bl = before.map(labelOf);
  const al = after.map(labelOf);
  const added = al.filter((x) => !bl.includes(x));
  const removed = bl.filter((x) => !al.includes(x));
  if (added.length) parts.push(`新增 ${added.map((x) => q(x, 20)).join('、')}`);
  if (removed.length) parts.push(`删除 ${removed.map((x) => q(x, 20)).join('、')}`);
  const keptB = before.filter((x) => al.includes(labelOf(x)));
  const keptA = after.filter((x) => bl.includes(labelOf(x)));
  if (keptB.map(labelOf).join('\n') !== keptA.map(labelOf).join('\n')) parts.push('调整了顺序');
  const edited = keptA.filter((a) => {
    const b = keptB.find((x) => labelOf(x) === labelOf(a));
    return b && JSON.stringify(pick(a, keys)) !== JSON.stringify(pick(b, keys));
  });
  if (edited.length) parts.push(`修改 ${edited.map((x) => q(labelOf(x), 20)).join('、')}`);
  if (!parts.length) parts.push('修改了内容');
  return parts.join('；');
}

function describeChanges(base, form, { avatar, favicon, siteLabel }) {
  const out = [];
  if (avatar) out.push(`头像：换成新图片${favicon ? '（同时更新浏览器标签页图标）' : ''}`);
  if (form.title !== base.title) out.push(`名字：${q(base.title)} → ${q(form.title)}`);
  if (form.subtitle !== base.subtitle) out.push(`简介：${q(base.subtitle)} → ${q(form.subtitle)}`);
  if (form.siteTitle !== base.siteTitle) out.push(`网站标题：${q(base.siteTitle)} → ${q(form.siteTitle)}`);
  for (const lang of Object.keys(form.overrides)) {
    for (const [key, label] of [['title', '名字'], ['subtitle', '简介']]) {
      const b = base.overrides[lang][key].trim();
      const a = form.overrides[lang][key].trim();
      if (a === b) continue;
      const what = `${siteLabel(lang)}${label}`;
      if (!a) out.push(`${what}：取消单独设置（改回与上面相同）`);
      else if (!b) out.push(`${what}：单独设置为 ${q(a)}`);
      else out.push(`${what}：${q(b)} → ${q(a)}`);
    }
  }
  const btn = describeList(base.buttons, form.buttons, BUTTON_KEYS, (x) => x.name.trim() || x.url.trim());
  if (btn) out.push(`首页按钮：${btn}`);
  const soc = describeList(base.social, form.social, SOCIAL_KEYS, (x) => SOCIAL_LABELS[x.name.trim()] || x.name.trim());
  if (soc) out.push(`社交链接：${soc}`);
  if (form.holidayEnabled !== base.holidayEnabled) out.push(`节日图标：${form.holidayEnabled ? '开启' : '关闭'}`);
  const rules = describeList(base.rules, form.rules, RULE_KEYS, (x) => `${x.emoji.trim()} ${x.from.trim()}`);
  if (rules) out.push(`节日规则：${rules}`);
  return out;
}

// ---------------------------------------------------------------------------
// 视图

/**
 * 挂载「首页设置」视图。
 * @param {HTMLElement} container
 * @param {object} params
 * @param {object} ctx 见 ADMIN_SPEC §4
 */
export default async function mount(container, params, ctx) {
  ctx.setTitle('首页设置');
  const repo = ctx.repo;
  const overrideLangsAll = ctx.langs.filter((l) => l !== ctx.defaultLang);

  const st = {
    disposed: false,
    files: null,        // { params: {path, sha, text}, languages: …, hugo: … }
    cfg: null,          // 解析后的对象
    base: null,
    form: null,
    overrideLangs: [],
    avatar: null,       // 待发布的新头像 { blob, favBlob, url, width }
    useFavicon: true,
    currentAvatarUrl: null,
    currentFaviconUrl: null,
    showRequired: false, // 点过「保存」之后才显示「必填」类错误
    urls: new Set(),
    imageShas: {},      // 读取设置时头像 / 图标文件的 sha（发布时作为 baseSha）
    previewFavUrl: null, // 预览里标签页图标用的地址
    // 本机自动保存：ready = 已确认本机没有待恢复的记录（或已经恢复 / 丢弃），之后的修改才会保存
    local: { ready: false, pending: null, timer: 0, stored: false, ok: false, warned: false, chain: Promise.resolve() },
  };

  const objectUrl = (blob) => {
    const u = URL.createObjectURL(blob);
    st.urls.add(u);
    return u;
  };
  const dropUrl = (u) => {
    if (u && st.urls.has(u)) {
      URL.revokeObjectURL(u);
      st.urls.delete(u);
    }
  };

  const root = h('div', { class: 'pf-view' });
  render(container, root);
  render(root, h('div', { class: 'page-header' }, h('div', {}, h('h1', {}, '首页设置'))), loadingState('正在读取首页设置…'));

  // ---- 读取文件 ----
  async function readFiles() {
    const defs = { params: PATHS.params, languages: PATHS.languages, hugo: PATHS.hugo };
    const files = {};
    await Promise.all(Object.entries(defs).map(async ([k, path]) => {
      const e = repo.entry(path);
      if (!e) {
        if (k === 'languages') { files[k] = { path, sha: null, text: '' }; return; }
        throw new Error(`找不到配置文件 ${path}`);
      }
      files[k] = { path, sha: e.sha, text: await repo.readText(path) };
    }));
    const cfg = {};
    const imageShas = {};
    for (const k of Object.keys(files)) {
      try {
        cfg[k] = parseToml(files[k].text);
      } catch (err) {
        const e = new Error(`${files[k].path} 的格式有误，无法在这里编辑：${errorMessage(err)}`);
        e.detail = errorMessage(err);
        throw e;
      }
    }
    const pm = plainObj(cfg.params.profileMode) || {};
    for (const p of [avatarTarget(pm.imageUrl).path, PATHS.favicon]) {
      const e = repo.entry(p);
      imageShas[p] = e ? e.sha : null;
    }
    return { files, cfg, imageShas };
  }

  /** 非默认语言总是可以单独设置；默认语言只有在文件里已经有覆盖时才显示（否则会让人困惑）。 */
  function computeOverrideLangs(cfg) {
    const out = [...overrideLangsAll];
    const d = ctx.defaultLang;
    const o = plainObj(getIn(cfg.languages, [d, 'params', 'profileMode']));
    if (o && (o.title != null || o.subtitle != null)) out.unshift(d);
    return out;
  }

  async function loadImageFromRepo(path) {
    if (!path || !repo.has(path)) return null;
    try {
      const bytes = await repo.readBytes(path);
      return objectUrl(new Blob([bytes], { type: IMAGE_MIME[extOf(path)] || 'image/jpeg' }));
    } catch (err) {
      console.warn('[profile] read image failed', path, err);
      return null;
    }
  }

  async function loadCurrentImages() {
    // 先读 imageUrl 真正指向的文件（可能是 .png），再读我们会写入的 .jpg
    const source = avatarSourcePath(st.base.imageUrl);
    const target = avatarTarget(st.base.imageUrl).path;
    const [a, f] = await Promise.all([
      loadImageFromRepo(source).then((u) => u || (target !== source ? loadImageFromRepo(target) : null)),
      loadImageFromRepo(PATHS.favicon),
    ]);
    if (st.disposed) return;
    dropUrl(st.currentAvatarUrl);
    dropUrl(st.currentFaviconUrl);
    // 仓库里读不到时退回网站上的图片（加时间戳避免缓存）
    const rel = st.base.imageUrl.replace(/^\/+/, '');
    const siteImg = /^https?:/i.test(st.base.imageUrl) ? st.base.imageUrl
      : rel ? ctx.siteUrl + rel + (rel.includes('?') ? '&' : '?') + 't=' + Date.now() : null;
    st.currentAvatarUrl = a || siteImg;
    st.currentFaviconUrl = f;
    refreshImages();
  }

  try {
    const { files, cfg, imageShas } = await readFiles();
    if (st.disposed) return {};
    st.files = files;
    st.imageShas = imageShas;
    st.cfg = cfg;
    st.overrideLangs = computeOverrideLangs(cfg);
    st.base = modelFrom(cfg, st.overrideLangs);
    st.form = cloneModel(st.base);
  } catch (err) {
    console.error('[profile] load failed', err);
    render(root,
      h('div', { class: 'page-header' }, h('div', {}, h('h1', {}, '首页设置'))),
      h('div', { class: 'card' }, errorState('首页设置读取失败', {
        detail: errorMessage(err),
        retry: () => ctx.navigate('#/profile', { replace: true }),
      })));
    return {};
  }

  // ---- 界面 ----
  const ui = {};
  buildUi();
  loadCurrentImages();
  localLoad().then(checkLocal);
  const onHidden = (e) => { if (e.type === 'pagehide' || document.visibilityState === 'hidden') flushLocal(); };
  document.addEventListener('visibilitychange', onHidden);
  window.addEventListener('pagehide', onHidden);

  function buildUi() {
    const saveBtn = h('button', { type: 'button', class: 'btn btn-primary', dataset: { testid: 'profile-save' } }, svgIcon('send'), '保存并发布');
    const resetBtn = h('button', { type: 'button', class: 'btn btn-ghost', dataset: { testid: 'profile-reset' } }, '放弃修改');
    const saveHint = h('span', { class: 'pf-savebar-text', dataset: { testid: 'profile-save-hint' } });
    saveBtn.addEventListener('click', () => withBusy(saveBtn, save));
    resetBtn.addEventListener('click', resetAll);
    ui.saveBtn = saveBtn;
    ui.resetBtn = resetBtn;
    ui.saveHint = saveHint;

    ui.cards = {};
    ui.restoreHost = h('div', { class: 'pf-restore-host' });
    const main = h('div', { class: 'pf-main stack' },
      avatarCard(), namesCard(), buttonsCard(), socialCard(), holidayCard());
    const side = h('aside', { class: 'pf-side' }, previewCard());
    render(root,
      h('div', { class: 'page-header' },
        h('div', {},
          h('h1', {}, '首页设置'),
          h('p', { class: 'page-desc' }, '网站首页的头像、名字、按钮和社交链接。改完点「保存并发布」，约 1–2 分钟后生效。'))),
      ui.restoreHost,
      h('div', { class: 'pf-layout' }, main, side),
      h('div', { class: 'pf-savebar', dataset: { testid: 'profile-savebar' } },
        saveHint, h('div', { class: 'pf-savebar-actions' }, resetBtn, saveBtn)));
    renderRestoreBanner();
    update();
  }

  function cardShell(key, title, icon, desc, ...body) {
    const changed = badge('已修改', 'orange');
    changed.hidden = true;
    changed.dataset.testid = `profile-changed-${key}`;
    const el = h('section', { class: 'card pf-card', dataset: { testid: `profile-card-${key}` } },
      h('div', { class: 'card-header' },
        h('h2', { class: 'card-title' }, svgIcon(icon), title, changed),
        desc ? h('span', { class: 'muted small pf-card-desc' }, desc) : null),
      ...body);
    ui.cards[key] = { el, changed };
    return el;
  }

  // ---------- 头像 ----------
  function avatarCard() {
    const img = h('img', { class: 'pf-avatar-img', alt: '当前头像', draggable: 'false', dataset: { testid: 'profile-avatar-img' } });
    const placeholder = h('div', { class: 'pf-avatar-empty' }, svgIcon('user', { size: 40 }));
    const pending = badge('待发布', 'orange');
    pending.dataset.testid = 'profile-avatar-pending';
    const fileInput = h('input', { type: 'file', accept: 'image/*', class: 'pf-file', tabindex: '-1', 'aria-hidden': 'true', dataset: { testid: 'profile-avatar-file' } });
    const pickBtn = h('button', { type: 'button', class: 'btn', dataset: { testid: 'profile-avatar-change' } }, svgIcon('upload'), '更换头像');
    const undoBtn = h('button', { type: 'button', class: 'btn btn-ghost', dataset: { testid: 'profile-avatar-undo' } }, '撤销');
    const favCheck = h('input', { type: 'checkbox', checked: st.useFavicon, dataset: { testid: 'profile-avatar-favicon' } });
    const favImg = h('img', { class: 'pf-fav-img', alt: '', draggable: 'false' });
    const favLabel = h('label', { class: 'checkbox pf-fav' }, favCheck, '同时用作浏览器标签页图标', favImg);
    const info = h('div', { class: 'muted small pf-avatar-info' });

    pickBtn.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', async () => {
      const file = fileInput.files && fileInput.files[0];
      fileInput.value = '';
      if (file) await withBusy(pickBtn, () => chooseAvatar(file));
    });
    undoBtn.addEventListener('click', () => {
      if (st.avatar) dropUrl(st.avatar.url);
      st.avatar = null;
      refreshImages();
      update();
    });
    favCheck.addEventListener('change', () => {
      st.useFavicon = favCheck.checked;
      refreshImages();
      update();
    });

    ui.avatar = { img, placeholder, pending, undoBtn, favLabel, favImg, info };
    return cardShell('avatar', '头像', 'user', null,
      h('div', { class: 'pf-avatar' },
        h('div', { class: 'pf-avatar-frame' }, img, placeholder),
        h('div', { class: 'pf-avatar-body stack-sm' },
          h('div', { class: 'row' }, pickBtn, undoBtn, pending, fileInput),
          favLabel,
          info,
          h('div', { class: 'hint muted small' }, '新头像发布后约 1–2 分钟生效（这台设备会自动刷新缓存；其他设备上可能要再过几分钟才显示新头像）。'))));
  }

  function refreshImages() {
    if (!ui.avatar) return;
    const a = ui.avatar;
    const url = st.avatar ? st.avatar.url : st.currentAvatarUrl;
    if (url) {
      if (a.img.getAttribute('src') !== url) a.img.src = url;
      a.img.hidden = false;
      a.placeholder.hidden = true;
    } else {
      a.img.hidden = true;
      a.placeholder.hidden = false;
    }
    a.img.alt = st.avatar ? '新头像（待发布）' : '当前头像';
    a.pending.hidden = !st.avatar;
    a.undoBtn.hidden = !st.avatar;
    a.favLabel.hidden = !st.avatar;
    const favUrl = st.avatar && st.useFavicon ? st.avatar.favUrl : st.currentFaviconUrl;
    if (st.avatar && st.useFavicon) {
      a.favImg.src = st.avatar.favUrl;
      a.favImg.hidden = false;
    } else a.favImg.hidden = true;
    a.info.textContent = st.avatar
      ? `已裁剪为 ${LIMITS.avatarSize}×${LIMITS.avatarSize}${st.useFavicon ? `，标签页图标 ${LIMITS.faviconSize}×${LIMITS.faviconSize}` : ''}。点「保存并发布」后生效。`
      : '建议用清晰的正方形照片；上传后可以拖动、缩放选取范围。';
    refreshPreview(favUrl);
  }

  async function chooseAvatar(file) {
    const ext = extOf(file.name || '');
    if (file.size > 60 * 1024 * 1024) {
      toast('图片太大了（超过 60 MB），请换一张小一点的', { type: 'error' });
      return;
    }
    let image;
    try {
      image = await loadImage(file);
    } catch {
      toast(ext === 'heic' || ext === 'heif'
        ? '这个浏览器打不开 HEIC 格式的照片。请在相册里把它导出为 JPG（或截个图）再上传'
        : '这个文件无法作为图片打开，请换成 JPG 或 PNG', { type: 'error', timeout: 8000 });
      return;
    }
    const w = image.naturalWidth || image.width;
    const hgt = image.naturalHeight || image.height;
    if (!w || !hgt) {
      toast('这个图片无法读取尺寸，请换一张', { type: 'error' });
      closeImg(image);
      return;
    }
    const result = await openCropper(image, { width: w, height: hgt });
    if (!result || st.disposed) return;
    let buf;
    let favBuf;
    try {
      [buf, favBuf] = await Promise.all([result.blob.arrayBuffer(), result.favBlob.arrayBuffer()]);
    } catch {
      toast('处理图片时出错了，请再试一次', { type: 'error' });
      return;
    }
    if (st.disposed) return;
    if (st.avatar) {
      dropUrl(st.avatar.url);
      dropUrl(st.avatar.favUrl);
    }
    st.avatar = makeAvatar(buf, favBuf);
    refreshImages();
    update();
  }

  /** 待发布的新头像。buf / favBuf 是 JPEG 字节（本机自动保存直接存它们）；favVer = 图标地址里的版本号。 */
  function makeAvatar(buf, favBuf) {
    const blob = new Blob([buf], { type: 'image/jpeg' });
    const favBlob = new Blob([favBuf], { type: 'image/jpeg' });
    return { blob, favBlob, buf, favBuf, favVer: shortHash(new Uint8Array(favBuf)), url: objectUrl(blob), favUrl: objectUrl(favBlob) };
  }

  // ---------- 名字与简介 ----------
  function namesCard() {
    const f = st.form;
    const textField = ({ label, value, placeholder, hint, testid, onInput, optional, maxlength }) => {
      const id = uid('f');
      const input = h('input', { class: 'input', id, type: 'text', value, placeholder, autocomplete: 'off', maxlength: maxlength || 300, dataset: { testid } });
      input.addEventListener('input', () => { onInput(input.value); update(); });
      return {
        input,
        el: h('div', { class: 'field' },
          h('label', { htmlFor: id }, label, optional ? h('span', { class: 'optional' }, '（可留空）') : null),
          input,
          hint ? h('div', { class: 'hint' }, hint) : null),
      };
    };
    const title = textField({ label: '名字', value: f.title, placeholder: f.siteTitle, testid: 'profile-title', hint: '首页头像下面的大字。留空时显示网站标题。', onInput: (v) => { st.form.title = v; }, optional: true });
    const subtitle = textField({ label: '简介', value: f.subtitle, testid: 'profile-subtitle', hint: '名字下面的一行小字。', onInput: (v) => { st.form.subtitle = v; }, optional: true, maxlength: 600 });
    const siteTitle = textField({ label: '网站标题', value: f.siteTitle, testid: 'profile-site-title', hint: '显示在浏览器标签页和每个页面的左上角。', onInput: (v) => { st.form.siteTitle = v; } });
    ui.names = { title: title.input, subtitle: subtitle.input, siteTitle: siteTitle.input, overrides: {} };

    const overrideBlocks = st.overrideLangs.map((lang) => {
      const o = f.overrides[lang];
      const ot = textField({ label: '名字', value: o.title, testid: `profile-override-${lang}-title`, onInput: (v) => { st.form.overrides[lang].title = v; } });
      const os = textField({ label: '简介', value: o.subtitle, testid: `profile-override-${lang}-subtitle`, onInput: (v) => { st.form.overrides[lang].subtitle = v; } });
      ui.names.overrides[lang] = { title: ot.input, subtitle: os.input };
      return h('div', { class: 'pf-override', dataset: { testid: `profile-override-${lang}` } },
        h('div', { class: 'pf-override-head' },
          svgIcon('globe'),
          h('span', {}, `${ctx.siteLabel(lang)}单独设置`),
          h('span', { class: 'muted' }, '（留空 = 与上面相同）')),
        h('div', { class: 'pf-grid-2' }, ot.el, os.el));
    });

    return cardShell('names', '名字与简介', 'edit', null,
      h('div', { class: 'stack' },
        h('div', { class: 'pf-grid-2' }, title.el, siteTitle.el),
        subtitle.el,
        overrideBlocks));
  }

  function refreshOverridePlaceholders() {
    if (!ui.names) return;
    ui.names.title.placeholder = st.form.siteTitle || '';
    for (const lang of Object.keys(ui.names.overrides)) {
      const i = ui.names.overrides[lang];
      i.title.placeholder = st.form.title || st.form.siteTitle || '';
      i.subtitle.placeholder = st.form.subtitle || '';
    }
  }

  // ---------- 列表编辑器（按钮 / 社交 / 节日规则通用） ----------
  /**
   * @param {object} o
   * @param {() => object[]} o.get          当前列表（st.form 里的数组）
   * @param {(list: object[]) => void} o.set
   * @param {Array<{ key: string, label: string, placeholder?: string, kind?: 'text'|'icon'|'emoji'|'date', normalize?: (v: string, it: object) => string, cls?: string }>} o.fields
   * @param {(it: object) => { errors: object, warnings: object }} o.validate
   * @param {() => object} o.newItem
   * @param {string} o.prefix testid 前缀
   */
  function listEditor({ get, set, fields, validate, newItem, prefix, addText, emptyText, itemName }) {
    const rowsEl = h('div', { class: 'pf-rows', dataset: { testid: `${prefix}-list` } });
    const head = h('div', { class: `pf-rows-head pf-cols-${prefix} hide-mobile`, 'aria-hidden': 'true' },
      h('span'), fields.map((f) => h('span', {}, f.label)), h('span'));
    const addBtn = h('button', { type: 'button', class: 'btn btn-ghost btn-primary pf-add', dataset: { testid: `${prefix}-add` } }, svgIcon('plus'), addText);
    const empty = h('div', { class: 'pf-rows-empty muted' }, emptyText);
    const rows = [];

    addBtn.addEventListener('click', () => {
      const list = get();
      list.push(newItem());
      set(list);
      rebuild();
      update();
      const last = rows[rows.length - 1];
      if (last) last.focusFirst();
    });

    function move(i, d, focusKey) {
      const list = get();
      const j = i + d;
      if (j < 0 || j >= list.length) return;
      [list[i], list[j]] = [list[j], list[i]];
      set(list);
      rebuild();
      update();
      const r = rows[j];
      if (r) r.focusAction(focusKey);
    }
    function remove(i) {
      const list = get();
      list.splice(i, 1);
      set(list);
      rebuild();
      update();
      const r = rows[Math.min(i, rows.length - 1)];
      if (r) r.focusAction('remove');
      else addBtn.focus();
    }

    function buildRow(it, i, n) {
      const inputs = {};
      const msgs = h('div', { class: 'pf-row-msgs' });
      const touched = new Set();
      const cells = fields.map((f) => {
        const id = uid(prefix);
        const label = h('label', { class: 'pf-mlabel show-mobile', htmlFor: id }, f.label);
        let control;
        if (f.kind === 'icon') {
          control = iconControl(it, id, () => { update(); });
          inputs[f.key] = control.input;
          control = control.el;
        } else {
          const input = h('input', {
            class: ['input', f.kind === 'emoji' && 'pf-emoji-input', f.kind === 'date' && 'pf-date-input'],
            id, type: 'text', value: it[f.key], placeholder: f.placeholder || '', autocomplete: 'off',
            'aria-label': `${itemName} ${i + 1} 的${f.label}`,
            maxlength: f.kind === 'emoji' ? 16 : f.kind === 'date' ? 10 : 500,
            dataset: { testid: `${prefix}-${f.key}` },
          });
          input.addEventListener('input', () => { it[f.key] = input.value; update(); });
          input.addEventListener('blur', () => {
            touched.add(f.key);
            if (f.normalize) {
              const v = f.normalize(input.value, it);
              if (v !== input.value) { input.value = v; it[f.key] = v; }
              if (f.after) f.after(it, inputs);
            }
            update();
          });
          inputs[f.key] = input;
          control = input;
        }
        return h('div', { class: ['pf-cell', `pf-cell-${f.key}`] }, label, control);
      });
      const act = (name, icon, label, onClick, disabled) => h('button', {
        type: 'button', class: 'btn btn-ghost btn-sm btn-icon', 'aria-label': label, title: label, disabled,
        dataset: { testid: `${prefix}-${name}`, act: name }, on: { click: onClick },
      }, svgIcon(icon));
      const actions = h('div', { class: 'pf-row-actions' },
        act('up', 'up', '上移', () => move(i, -1, 'up'), i === 0),
        act('down', 'down', '下移', () => move(i, 1, 'down'), i === n - 1),
        act('remove', 'trash', '删除', () => remove(i)));
      actions.lastChild.classList.add('btn-danger');
      const el = h('div', { class: `pf-row pf-cols-${prefix}`, dataset: { testid: `${prefix}-row`, index: i } },
        h('span', { class: 'pf-row-num', 'aria-hidden': 'true' }, String(i + 1)),
        cells, actions, msgs);
      return {
        el,
        it,
        focusFirst: () => { const first = inputs[fields[0].key]; if (first) first.focus(); },
        focusAction: (name) => {
          const b = el.querySelector(`[data-act="${name}"]`);
          if (b && !b.disabled) b.focus();
          else { const any = el.querySelector('[data-act]:not([disabled])'); if (any) any.focus(); }
        },
        validate() {
          const { errors, warnings } = validate(it);
          clear(msgs);
          let errCount = 0;
          for (const f of fields) {
            const e = errors[f.key];
            const isRequired = e && !str(it[f.key]).trim();
            const show = e && (!isRequired || st.showRequired || touched.has(f.key));
            if (e) errCount++;
            if (inputs[f.key]) inputs[f.key].setAttribute('aria-invalid', show ? 'true' : 'false');
            if (show) msgs.append(h('div', { class: 'error' }, e));
            else if (warnings[f.key]) msgs.append(h('div', { class: 'pf-warn' }, svgIcon('warning'), warnings[f.key]));
          }
          msgs.hidden = !msgs.firstChild;
          return errCount;
        },
      };
    }

    function rebuild() {
      const list = get();
      rows.length = 0;
      clear(rowsEl);
      list.forEach((it, i) => {
        const r = buildRow(it, i, list.length);
        rows.push(r);
        rowsEl.append(r.el);
      });
      empty.hidden = list.length > 0;
      head.hidden = list.length === 0;
    }
    rebuild();

    return {
      el: h('div', { class: 'pf-list' }, head, rowsEl, empty, h('div', { class: 'pf-list-foot' }, addBtn)),
      rebuild,
      validate: () => rows.reduce((n, r) => n + r.validate(), 0),
    };
  }

  /** 社交图标选择：下拉框（常用图标）+「其他」时显示文本框。 */
  function iconControl(it, id, onChange) {
    const known = SOCIAL_LABELS[it.name] != null;
    const select = h('select', { class: 'input pf-icon-select', id, 'aria-label': '图标', dataset: { testid: 'social-icon' } },
      h('option', { value: '', disabled: true, selected: !it.name }, '选择图标…'),
      SOCIAL_CHOICES.map(([v, label]) => h('option', { value: v, selected: it.name === v }, label === v ? v : `${label}`)),
      h('option', { value: OTHER, selected: !!it.name && !known }, '其他（自己填写）…'));
    const text = h('input', { class: 'input pf-icon-text', type: 'text', value: known ? '' : it.name, placeholder: '图标英文名，如 github', autocomplete: 'off', 'aria-label': '图标名', dataset: { testid: 'social-name' } });
    text.hidden = known || !it.name;
    select.addEventListener('change', () => {
      if (select.value === OTHER) {
        text.hidden = false;
        it.name = text.value.trim();
        text.focus();
      } else {
        text.hidden = true;
        it.name = select.value;
      }
      onChange();
    });
    text.addEventListener('input', () => { it.name = text.value.trim(); onChange(); });
    return { el: h('div', { class: 'pf-icon-control' }, select, text), input: select };
  }

  // ---------- 首页按钮 ----------
  function buttonsCard() {
    const editor = listEditor({
      get: () => st.form.buttons,
      set: (l) => { st.form.buttons = l; },
      fields: [
        { key: 'name', label: '名称', placeholder: '如 My Research' },
        { key: 'url', label: '链接', placeholder: '如 research/ 或 https://…', normalize: (v) => v.trim() },
      ],
      validate: validateButton,
      newItem: () => ({ name: '', url: '' }),
      prefix: 'button',
      itemName: '按钮',
      addText: '添加按钮',
      emptyText: '首页暂时没有按钮。',
    });
    ui.buttons = editor;
    return cardShell('buttons', '首页按钮', 'link', null,
      langOverrideNote(['params', 'profileMode', 'buttons'], '首页按钮'),
      editor.el,
      h('p', { class: 'hint muted small pf-card-hint' },
        '站内页面写 ', h('code', { class: 'kbd' }, 'research/'), ' 这样不以 / 开头的路径，两种语言会各自跳转；外部网址以 ',
        h('code', { class: 'kbd' }, 'https://'), ' 开头，邮箱用 ', h('code', { class: 'kbd' }, 'mailto:'), '。'));
  }

  // ---------- 社交链接 ----------
  function socialCard() {
    const editor = listEditor({
      get: () => st.form.social,
      set: (l) => { st.form.social = l; },
      fields: [
        { key: 'name', label: '图标', kind: 'icon' },
        {
          key: 'url', label: '链接', placeholder: 'https://…',
          // 选了「邮箱」又只填了邮箱地址时，自动补上 mailto:
          normalize: (v, it) => {
            const t = v.trim();
            return it.name === 'email' && /^[^@\s:/]+@[^@\s/]+\.[^@\s/]+$/.test(t) ? 'mailto:' + t : t;
          },
        },
      ],
      validate: validateSocial,
      newItem: () => ({ name: '', url: '' }),
      prefix: 'social',
      itemName: '链接',
      addText: '添加社交链接',
      emptyText: '还没有社交链接。',
    });
    ui.social = editor;
    return cardShell('social', '社交链接', 'globe', '显示在首页名字下方的一排小图标',
      langOverrideNote(['params', 'socialIcons'], '社交链接'),
      editor.el);
  }

  /** languages.toml 里某个语言单独设置了按钮 / 社交链接时提醒：这里的修改不影响那个语言。 */
  function langOverrideNote(pathInLang, what) {
    const langs = ctx.langs.filter((l) => getIn(st.cfg.languages, [l, ...pathInLang]) !== undefined);
    if (!langs.length) return null;
    return h('div', { class: 'banner banner-info pf-banner' }, svgIcon('info'),
      h('span', {}, `${langs.map((l) => ctx.siteLabel(l)).join('、')}在 languages.toml 里单独设置了${what}，这里的修改不会影响${langs.length > 1 ? '它们' : '它'}。`));
  }

  // ---------- 节日图标 ----------
  function holidayCard() {
    const sw = h('input', { type: 'checkbox', checked: st.form.holidayEnabled, 'aria-label': '启用节日图标', dataset: { testid: 'holiday-enabled' } });
    const today = h('div', { class: 'pf-today', dataset: { testid: 'holiday-today' } });
    sw.addEventListener('change', () => { st.form.holidayEnabled = sw.checked; update(); });
    const editor = listEditor({
      get: () => st.form.rules,
      set: (l) => { st.form.rules = l; },
      fields: [
        { key: 'emoji', label: 'Emoji', kind: 'emoji', placeholder: '', normalize: (v) => v.trim() },
        {
          key: 'from', label: '开始（月-日）', kind: 'date', placeholder: '月-日', normalize: normalizeMonthDay,
          after: (it, inputs) => { if (!it.to.trim() && isMonthDay(it.from)) { it.to = it.from; inputs.to.value = it.to; } },
        },
        { key: 'to', label: '结束（月-日）', kind: 'date', placeholder: '月-日', normalize: normalizeMonthDay },
      ],
      validate: validateRule,
      newItem: () => ({ emoji: '', from: '', to: '' }),
      prefix: 'rule',
      itemName: '规则',
      addText: '添加节日',
      emptyText: '还没有节日规则。',
    });
    ui.rules = editor;
    ui.holiday = { sw, today, body: null };
    const body = h('div', { class: 'stack-sm pf-holiday-body' },
      editor.el,
      h('p', { class: 'hint muted small pf-card-hint' },
        '在这些日期把浏览器标签页图标换成 emoji。首尾日期都包含；开始晚于结束表示跨年（如 12-25 到 01-05）。从上到下匹配，第一条命中的生效。'));
    ui.holiday.body = body;
    const el = cardShell('holiday', '节日图标', 'clock', null,
      h('label', { class: 'pf-switch-row' },
        h('span', { class: 'switch' }, sw, h('span')),
        h('span', { class: 'pf-switch-text' }, '在节日把标签页图标换成 emoji'),
        today),
      body);
    return el;
  }

  // ---------- 首页预览 ----------
  function previewCard() {
    const langs = ctx.langs;
    let cur = ctx.defaultLang;
    const tabs = h('div', { class: 'tabs tabs-pill pf-preview-tabs', role: 'tablist' });
    const tabBtns = langs.map((lang) => {
      const b = h('button', { type: 'button', class: ['tab', lang === cur && 'active'], role: 'tab', 'aria-selected': lang === cur ? 'true' : 'false', dataset: { testid: `profile-preview-${lang}` } }, ctx.siteLabel(lang));
      b.addEventListener('click', () => {
        cur = lang;
        tabBtns.forEach((x, i) => { const on = langs[i] === lang; x.classList.toggle('active', on); x.setAttribute('aria-selected', on ? 'true' : 'false'); });
        refreshPreview();
      });
      tabs.append(b);
      return b;
    });
    if (langs.length < 2) tabs.hidden = true;

    const favEl = h('span', { class: 'pf-tab-fav' });
    const tabTitle = h('span', { class: 'pf-tab-title truncate' });
    const avatar = h('div', { class: 'pf-pv-avatar' });
    const name = h('div', { class: 'pf-pv-name', dataset: { testid: 'profile-preview-title' } });
    const sub = h('div', { class: 'pf-pv-sub', dataset: { testid: 'profile-preview-subtitle' } });
    const social = h('div', { class: 'pf-pv-social' });
    const buttons = h('div', { class: 'pf-pv-buttons' });
    ui.preview = { get lang() { return cur; }, favEl, tabTitle, avatar, name, sub, social, buttons };
    return h('div', { class: 'card pf-preview', dataset: { testid: 'profile-preview' } },
      h('div', { class: 'card-header' }, h('h2', { class: 'card-title' }, svgIcon('eye'), '首页预览'), tabs),
      h('div', { class: 'pf-browser' },
        h('div', { class: 'pf-browser-bar' },
          h('div', { class: 'pf-browser-tab' }, favEl, tabTitle, svgIcon('close', { size: 11 }))),
        h('div', { class: 'pf-pv-page' }, avatar, name, sub, social, buttons)),
      h('p', { class: 'muted small pf-preview-note' }, '示意图，实际样式以网站为准。'));
  }

  function refreshPreview(favUrl) {
    if (!ui.preview) return;
    if (favUrl !== undefined) st.previewFavUrl = favUrl;
    const p = ui.preview;
    const f = st.form;
    const lang = p.lang;
    const o = f.overrides[lang] || { title: '', subtitle: '' };
    const langCfg = plainObj(getIn(st.cfg.languages, [lang])) || {};
    const siteTitle = str(langCfg.title).trim() || f.siteTitle.trim();

    // 标签页：节日 emoji > 新图标 > 当前图标
    const hol = f.holidayEnabled ? todayHoliday(f.rules) : { emoji: null };
    clear(p.favEl);
    if (hol.emoji) p.favEl.append(h('span', { class: 'pf-tab-emoji' }, hol.emoji));
    else if (st.previewFavUrl) p.favEl.append(h('img', { src: st.previewFavUrl, alt: '' }));
    else p.favEl.append(svgIcon('globe', { size: 14 }));
    p.tabTitle.textContent = siteTitle || '（未设置网站标题）';

    clear(p.avatar);
    const aUrl = st.avatar ? st.avatar.url : st.currentAvatarUrl;
    if (aUrl) p.avatar.append(h('img', { src: aUrl, alt: '', draggable: 'false' }));
    else p.avatar.append(svgIcon('user', { size: 34 }));
    p.name.textContent = o.title.trim() || f.title.trim() || siteTitle;
    p.sub.textContent = o.subtitle.trim() || f.subtitle;

    const langButtons = getIn(st.cfg.languages, [lang, 'params', 'profileMode', 'buttons']);
    const btnList = Array.isArray(langButtons) ? itemsFrom(langButtons, BUTTON_KEYS) : f.buttons;
    const langSocial = getIn(st.cfg.languages, [lang, 'params', 'socialIcons']);
    const socList = Array.isArray(langSocial) ? itemsFrom(langSocial, SOCIAL_KEYS) : f.social;
    render(p.social, socList.filter((x) => x.name.trim()).map((x) =>
      h('span', { class: 'pf-pv-icon', title: x.url }, SOCIAL_LABELS[x.name] || x.name)));
    render(p.buttons, btnList.filter((x) => x.name.trim()).map((x) =>
      h('span', { class: 'pf-pv-btn', title: x.url }, x.name, /:\/\//.test(x.url) ? svgIcon('external', { size: 12 }) : null)));
  }

  // ---------- 状态刷新 ----------
  function update() {
    if (!ui.saveBtn) return;
    const ch = changedSections(st.base, st.form);
    const avatarChanged = !!st.avatar;
    const flags = { avatar: avatarChanged, ...ch };
    for (const [k, c] of Object.entries(ui.cards)) c.changed.hidden = !flags[k];
    const n = Object.values(flags).filter(Boolean).length;

    const errors = (ui.buttons ? ui.buttons.validate() : 0) + (ui.social ? ui.social.validate() : 0) + (ui.rules ? ui.rules.validate() : 0);
    if (!st.form.siteTitle.trim() && (st.showRequired || st.form.siteTitle !== st.base.siteTitle)) {
      ui.names.siteTitle.setAttribute('aria-invalid', 'true');
    } else if (ui.names) ui.names.siteTitle.setAttribute('aria-invalid', 'false');

    ui.saveBtn.disabled = n === 0;
    ui.resetBtn.hidden = n === 0;
    ui.saveHint.classList.toggle('is-dirty', n > 0);
    if (n === 0) render(ui.saveHint, '没有未发布的修改');
    else {
      render(ui.saveHint,
        h('span', { class: 'hide-mobile' }, `${Object.keys(flags).filter((k) => flags[k]).map((k) => SECTION_NAMES[k]).join('、')} 有修改未发布`),
        h('span', { class: 'show-mobile' }, `${n} 处设置有修改未发布`),
        errors ? h('span', { class: 'pf-savebar-err' }, `（${errors} 处需要填写或改正）`) : null);
    }

    if (ui.holiday) {
      ui.holiday.body.classList.toggle('is-off', !st.form.holidayEnabled);
      const t = todayHoliday(st.form.rules);
      clear(ui.holiday.today);
      if (st.form.holidayEnabled && t.emoji) ui.holiday.today.append(badge(`今天（${t.today}）显示 ${t.emoji}`, 'green'));
      else ui.holiday.today.append(h('span', { class: 'muted small' }, st.form.holidayEnabled ? `今天（${t.today}）不是节日，显示普通图标` : '已关闭'));
    }
    refreshOverridePlaceholders();
    refreshPreview();
    scheduleLocal();
    return { n, errors };
  }

  // ---------- 本机自动保存 ----------
  function currentShas() {
    const out = {};
    for (const k of ['params', 'languages', 'hugo']) out[st.files[k].path] = st.files[k].sha || null;
    for (const [p, sha] of Object.entries(st.imageShas)) out[p] = sha || null;
    return out;
  }

  function localRecord(withOrig = true) {
    return {
      v: LOCAL_VERSION,
      updatedAt: Date.now(),
      shas: currentShas(),
      overrideLangs: [...st.overrideLangs],
      base: serModel(st.base, { withOrig }),
      form: serModel(st.form, { withOrig }),
      useFavicon: st.useFavicon,
      avatar: st.avatar ? { buf: st.avatar.buf, favBuf: st.avatar.favBuf, favVer: st.avatar.favVer } : null,
    };
  }

  function scheduleLocal() {
    const L = st.local;
    if (!L.ready) {
      if (L.pending && !L.warned && isDirty()) {
        L.warned = true;
        toast('请先在上方选择「恢复」或「丢弃」本机保存的修改，之后的修改才会自动保存', { type: 'warning', timeout: 7000 });
      }
      return;
    }
    clearTimeout(L.timer);
    L.timer = setTimeout(flushLocal, 700);
  }

  /** 立刻把当前状态写到本机（没有修改 = 删除本机记录）。按顺序执行，后写的一定覆盖先写的。 */
  function flushLocal() {
    const L = st.local;
    clearTimeout(L.timer);
    L.timer = 0;
    if (!L.ready || !st.base || !st.form) return L.chain;
    if (!isDirty()) {
      if (!L.stored) return L.chain;
      L.stored = false;
      L.chain = L.chain.then(() => localDelete());
      return L.chain;
    }
    let rec;
    try { rec = localRecord(); } catch (err) { console.warn('[profile] local record failed', err); return L.chain; }
    L.stored = true;
    L.chain = L.chain.then(async () => {
      // 原始 TOML 对象偶尔可能无法存入（极少见）：去掉它们再试一次
      let ok = await localPut(rec);
      if (!ok) ok = await localPut({ ...rec, base: serModel(st.base, { withOrig: false }), form: serModel(st.form, { withOrig: false }) });
      L.ok = ok;
    }).catch(() => { L.ok = false; });
    return L.chain;
  }

  /** 打开视图时：本机有上次没发布的修改 → 显示「恢复 / 丢弃」。 */
  function checkLocal(rec) {
    const L = st.local;
    if (st.disposed) return;
    const usable = rec && rec.v === LOCAL_VERSION && plainObj(rec.form) && plainObj(rec.base);
    if (usable) {
      let restored = null;
      try { restored = restoredState(rec); } catch (err) { console.warn('[profile] local record unreadable', err); }
      const changes = restored && (restored.avatar || Object.values(changedSections(restored.base, restored.form)).some(Boolean));
      if (changes) {
        L.pending = rec;
        L.stored = true;
        renderRestoreBanner();
        return;
      }
    }
    if (rec) localDelete();
    L.ready = true;
    if (isDirty()) scheduleLocal();
  }

  /** 由本机记录算出恢复后的 base / form / 头像（不改 st）。 */
  function restoredState(rec) {
    const langs = computeOverrideLangs(st.cfg);
    for (const l of Array.isArray(rec.overrideLangs) ? rec.overrideLangs : []) {
      if (!langs.includes(l) && ctx.langs.includes(l)) langs.push(l);
    }
    const base = modelFrom(st.cfg, langs);
    const savedBase = fitOverrides(deserModel(rec.base, base), langs, null);
    const savedForm = fitOverrides(deserModel(rec.form, base), langs, savedBase);
    const form = mergeKeep(savedForm, savedBase, base);
    const a = plainObj(rec.avatar);
    const avatar = a && a.buf && a.favBuf ? a : null;
    const now = currentShas();
    const then = plainObj(rec.shas) || {};
    const remoteChanged = [...new Set([...Object.keys(now), ...Object.keys(then)])].some((p) => (now[p] || null) !== (then[p] || null));
    return { langs, base, form, avatar, remoteChanged };
  }

  function renderRestoreBanner() {
    if (!ui.restoreHost) return;
    const rec = st.local.pending;
    if (!rec) { clear(ui.restoreHost); return; }
    let info = null;
    try { info = restoredState(rec); } catch { /* 按没有远端变化处理 */ }
    const when = rec.updatedAt ? formatDate(new Date(rec.updatedAt)) : '';
    const text = `发现本机未发布的首页修改（${when}）${info && info.avatar ? '，包括一张新头像' : ''}。` +
      (info && info.remoteChanged ? '注意：在那之后网站上的设置又被修改过（可能是在别的设备上）；恢复后，你没改过的地方会用最新的设置，请检查后再发布。' : '');
    render(ui.restoreHost, h('div', { class: 'banner banner-warning pf-restore', role: 'status', dataset: { testid: 'profile-restore' } },
      svgIcon('clock'),
      h('span', {}, text),
      h('div', { class: 'banner-actions' },
        h('button', { type: 'button', class: 'btn btn-sm btn-ghost', dataset: { testid: 'profile-restore-discard' }, on: { click: discardLocal } }, '丢弃'),
        h('button', { type: 'button', class: 'btn btn-sm btn-primary', dataset: { testid: 'profile-restore-apply' }, on: { click: applyLocal } }, '恢复'))));
  }

  function applyLocal() {
    const L = st.local;
    const rec = L.pending;
    if (!rec || st.disposed) return;
    let r;
    try {
      r = restoredState(rec);
    } catch (err) {
      console.error('[profile] restore failed', err);
      toast(`恢复失败：${errorMessage(err)}`, { type: 'error', timeout: 8000 });
      return;
    }
    if (st.avatar) { dropUrl(st.avatar.url); dropUrl(st.avatar.favUrl); }
    st.overrideLangs = r.langs;
    st.base = r.base;
    st.form = r.form;
    st.avatar = r.avatar ? makeAvatar(r.avatar.buf, r.avatar.favBuf) : null;
    st.useFavicon = rec.useFavicon !== false;
    st.showRequired = false;
    L.pending = null;
    L.ready = true;
    buildUi();
    refreshImages();
    flushLocal();
    toast(r.remoteChanged ? '已恢复本机保存的修改。网站上的设置在那之后被改过，请检查后再发布' : '已恢复本机保存的修改',
      { type: r.remoteChanged ? 'warning' : 'success', timeout: r.remoteChanged ? 8000 : undefined });
  }

  async function discardLocal() {
    const L = st.local;
    if (!L.pending) return;
    const ok = await confirmDialog({
      title: '丢弃本机保存的修改？',
      message: '这些在本机自动保存、还没有发布的首页修改（包括新头像）会被删除，不能恢复。',
      okText: '丢弃', danger: true,
    });
    if (!ok || st.disposed || !L.pending) return;
    L.pending = null;
    L.stored = false;
    L.chain = L.chain.then(() => localDelete());
    await L.chain;
    if (st.disposed) return;
    L.ready = true;
    renderRestoreBanner();
    if (isDirty()) flushLocal();
    toast('已丢弃本机保存的修改', { type: 'success' });
  }

  function isDirty() {
    if (!st.base || !st.form) return false;
    if (st.avatar) return true;
    return Object.values(changedSections(st.base, st.form)).some(Boolean);
  }

  async function resetAll() {
    if (!isDirty()) return;
    const ok = await confirmDialog({ title: '放弃所有修改？', message: '会恢复成网站上现在的设置，刚才的修改（包括新头像）都会丢失。', okText: '放弃修改', danger: true });
    if (!ok || st.disposed) return;
    if (st.avatar) { dropUrl(st.avatar.url); dropUrl(st.avatar.favUrl); }
    st.avatar = null;
    st.form = cloneModel(st.base);
    st.showRequired = false;
    buildUi();
    refreshImages();
    flushLocal();
  }

  // ---------- 发布 ----------
  function buildPlan() {
    const target = st.avatar ? avatarTarget(st.base.imageUrl) : null;
    // 新图标换一个地址（?v=版本号），否则浏览器会继续显示缓存里的旧图标
    const assetHrefs = {};
    if (st.avatar && st.useFavicon) {
      const assets = plainObj(st.cfg.params.assets) || {};
      for (const [key, v] of Object.entries(assets)) {
        if (typeof v !== 'string') continue;
        const next = versionedFaviconHref(v, st.avatar.favVer);
        if (next) assetHrefs[key] = next;
      }
    }
    const texts = patchTexts(
      { params: st.files.params.text, languages: st.files.languages.text, hugo: st.files.hugo.text },
      st.base, st.form, { avatarImageUrl: target ? target.imageUrl : null, assetHrefs });
    const changes = [];
    const files = [];
    for (const k of ['params', 'languages', 'hugo']) {
      if (texts[k] !== st.files[k].text) {
        changes.push({ path: st.files[k].path, content: texts[k], baseSha: st.files[k].sha });
        files.push(st.files[k].path);
      }
    }
    if (st.avatar) {
      // baseSha = 读取设置时这个文件的版本（不存在 = null），防止覆盖别处刚换的头像
      changes.push({ path: target.path, content: st.avatar.blob, baseSha: imageSha(target.path) });
      files.push(target.path);
      if (st.useFavicon) {
        changes.push({ path: PATHS.favicon, content: st.avatar.favBlob, baseSha: imageSha(PATHS.favicon) });
        files.push(PATHS.favicon);
      }
    }
    const lines = describeChanges(st.base, st.form, { avatar: !!st.avatar, favicon: !!st.avatar && st.useFavicon, siteLabel: ctx.siteLabel });
    return { texts, changes, files, lines, avatarPath: target ? target.path : null };
  }

  function imageSha(path) {
    if (Object.prototype.hasOwnProperty.call(st.imageShas, path)) return st.imageShas[path];
    const e = repo.entry(path);
    return e ? e.sha : null;
  }

  function sectionsTouched() {
    const ch = changedSections(st.base, st.form);
    const out = [];
    if (st.avatar) out.push('头像');
    if (ch.names) out.push('名字与简介');
    if (ch.buttons) out.push('按钮');
    if (ch.social) out.push('社交链接');
    if (ch.holiday) out.push('节日图标');
    return out;
  }

  async function save() {
    if (st.disposed || !isDirty()) return;
    if (ctx.isPublishing && ctx.isPublishing()) { toast('正在发布，请稍候', { type: 'info' }); return; }
    st.showRequired = true;
    const { errors } = update();
    let siteTitleMissing = !st.form.siteTitle.trim();
    if (errors || siteTitleMissing) {
      toast(siteTitleMissing && !errors ? '网站标题不能为空' : `还有 ${errors + (siteTitleMissing ? 1 : 0)} 处需要填写或改正（标红的地方）`, { type: 'warning' });
      const bad = root.querySelector('[aria-invalid="true"]');
      if (bad) { bad.scrollIntoView({ block: 'center', behavior: 'smooth' }); bad.focus({ preventScroll: true }); }
      return;
    }
    let plan;
    try {
      plan = buildPlan();
    } catch (err) {
      console.error('[profile] patch failed', err);
      toast(`没能生成新的配置文件，什么都没有改：${errorMessage(err)}`, { type: 'error', timeout: 9000 });
      return;
    }
    if (!plan.changes.length) {
      toast('这些修改和网站上现在的设置一样，不需要发布', { type: 'info' });
      return;
    }
    const ok = await confirmDialog({
      title: '确认发布这些修改？',
      message: h('div', { class: 'stack-sm pf-confirm', dataset: { testid: 'profile-confirm' } },
        h('ul', { class: 'pf-confirm-list' }, plan.lines.map((l) => h('li', {}, l))),
        h('div', { class: 'muted small' }, '将修改：', plan.files.map((f, i) => [i ? '、' : '', h('code', { class: 'kbd' }, f)]))),
      okText: '发布',
    });
    if (!ok || st.disposed) return;

    const message = `admin: 更新首页设置（${sectionsTouched().join('、')}）`;
    let res;
    try {
      res = await ctx.publish({ message, changes: plan.changes, summary: plan.lines });
    } catch {
      return; // 外壳已经提示了错误；表单保持不变，可以直接再点一次
    }
    if (st.disposed) return;
    if (res && res.conflict) {
      if (res.reloaded) {
        await reloadKeepingEdits();
        toast('已读取网站上的最新设置，你的修改还在。请检查后再点一次「保存并发布」', { type: 'info', timeout: 7000 });
      }
      return;
    }
    // 成功：以刚发布的内容为新的基准
    const shas = (res && res.shas) || {};
    for (const k of ['params', 'languages', 'hugo']) {
      const f = st.files[k];
      if (plan.texts[k] !== f.text) {
        f.text = plan.texts[k];
        const e = repo.entry(f.path);
        f.sha = shas[f.path] || (e && e.sha) || f.sha;
      }
    }
    for (const c of plan.changes) {
      if (c.path in st.imageShas || c.path === PATHS.favicon) {
        const e = repo.entry(c.path);
        st.imageShas[c.path] = shas[c.path] || (e && e.sha) || null;
      }
    }
    try {
      st.cfg = { params: parseToml(st.files.params.text), languages: parseToml(st.files.languages.text), hugo: parseToml(st.files.hugo.text) };
    } catch { /* 刚刚验证过，不会失败 */ }
    st.base = modelFrom(st.cfg, st.overrideLangs);
    st.form = mergeKeep(st.form, st.base, st.base);
    if (st.avatar && plan.avatarPath) {
      const rel = plan.avatarPath.replace(/^static\//, '');
      refreshSiteCache({ url: ctx.siteUrl + rel.split('/').map(encodeURIComponent).join('/'), bytes: new Uint8Array(st.avatar.buf) },
        [ctx.siteUrl, ...ctx.langs.filter((l) => l !== ctx.defaultLang).map((l) => `${ctx.siteUrl}${l}/`)]);
    }
    if (st.avatar) {
      dropUrl(st.currentAvatarUrl);
      st.currentAvatarUrl = st.avatar.url;
        if (st.useFavicon) { dropUrl(st.currentFaviconUrl); st.currentFaviconUrl = st.avatar.favUrl; } else dropUrl(st.avatar.favUrl);
      st.avatar = null;
    }
    st.showRequired = false;
    buildUi();
    refreshImages();
    flushLocal(); // 已发布：立刻删掉本机记录（不等防抖）
  }

  /**
   * 三方合并（字段级）：用户没动过的字段（form == oldBase）换成新内容，动过的保留用户的值。
   * 发布成功后调用时 oldBase === newBase 的语义是「form 就是新基准」——直接返回 newBase 的拷贝。
   */
  function mergeKeep(form, oldBase, newBase) {
    if (oldBase === newBase) return cloneModel(newBase);
    const out = cloneModel(form);
    for (const k of ['title', 'subtitle', 'siteTitle', 'imageUrl', 'holidayEnabled']) {
      if (form[k] === oldBase[k]) out[k] = newBase[k];
    }
    for (const [k, keys] of [['buttons', BUTTON_KEYS], ['social', SOCIAL_KEYS], ['rules', RULE_KEYS]]) {
      // 整个列表算一个字段：用户动过列表就保留用户的列表
      if (sameList(form[k], oldBase[k], keys)) out[k] = cloneList(newBase[k]);
    }
    for (const lang of Object.keys(newBase.overrides)) {
      const fo = form.overrides[lang];
      const ob = oldBase.overrides[lang];
      if (!fo || !ob) { out.overrides[lang] = { ...newBase.overrides[lang] }; continue; }
      for (const key of ['title', 'subtitle']) {
        out.overrides[lang][key] = fo[key] === ob[key] ? newBase.overrides[lang][key] : fo[key];
      }
    }
    return out;
  }

  /** 冲突后外壳已经 repo.load()：重新读取三个文件，保留用户改过的字段。 */
  async function reloadKeepingEdits() {
    let loaded;
    try {
      loaded = await readFiles();
    } catch (err) {
      toast(`读取最新设置失败：${errorMessage(err)}`, { type: 'error', timeout: 9000 });
      return;
    }
    if (st.disposed) return;
    const oldBase = st.base;
    st.files = loaded.files;
    st.cfg = loaded.cfg;
    st.imageShas = loaded.imageShas;
    const langs = computeOverrideLangs(loaded.cfg);
    for (const l of st.overrideLangs) if (!langs.includes(l)) langs.push(l);
    st.overrideLangs = langs;
    const newBase = modelFrom(loaded.cfg, langs);
    st.form = mergeKeep(st.form, oldBase, newBase);
    st.base = newBase;
    // 新头像（如果有）仍然以用户刚选的为准；baseSha 用刚读到的最新版本
    buildUi();
    loadCurrentImages();
  }

  // ---------- 头像裁剪弹窗 ----------
  function openCropper(image, { width: iw, height: ih }) {
    return new Promise((resolve) => {
      const minDim = Math.min(iw, ih);
      const maxZ = Math.max(1, Math.min(8, minDim / 48));
      const s = { z: 1, cx: iw / 2, cy: ih / 2 };
      let result = null;
      let raf = 0;

      const canvas = h('canvas', { class: 'pf-crop-canvas', 'aria-hidden': 'true' });
      const g = canvas.getContext('2d');
      const stage = h('div', {
        class: 'pf-crop-stage', tabindex: '0', role: 'img',
        'aria-label': '头像裁剪区域：拖动图片调整位置，滚轮或双指缩放；也可以用方向键移动、加号减号缩放',
        dataset: { testid: 'crop-stage' },
      }, canvas, h('div', { class: 'pf-crop-ring', 'aria-hidden': 'true' }));
      const slider = h('input', { type: 'range', class: 'pf-crop-zoom', min: '1', max: String(maxZ), step: '0.01', value: '1', 'aria-label': '缩放', dataset: { testid: 'crop-zoom' } });
      const zoomOut = h('button', { type: 'button', class: 'btn btn-ghost btn-icon btn-sm', 'aria-label': '缩小', dataset: { testid: 'crop-zoom-out' } }, h('span', { class: 'pf-pm' }, '−'));
      const zoomIn = h('button', { type: 'button', class: 'btn btn-ghost btn-icon btn-sm', 'aria-label': '放大', dataset: { testid: 'crop-zoom-in' } }, h('span', { class: 'pf-pm' }, '+'));
      const resetBtn = h('button', { type: 'button', class: 'btn btn-ghost btn-sm', dataset: { testid: 'crop-reset' } }, svgIcon('refresh'), '重置');
      const pvRound = h('canvas', { class: 'pf-crop-pv-round', width: 144, height: 144, 'aria-hidden': 'true' });
      const pvFav = h('canvas', { class: 'pf-crop-pv-fav', width: 64, height: 64, 'aria-hidden': 'true' });
      const small = minDim < LIMITS.avatarSize
        ? h('div', { class: 'banner banner-warning pf-crop-warn' }, svgIcon('warning'), h('span', {}, `这张图片比较小（${iw}×${ih}），头像可能不够清晰。`))
        : null;

      const side = () => minDim / s.z;
      const viewSize = () => stage.clientWidth || 300;
      const clampAll = () => {
        s.z = Math.min(maxZ, Math.max(1, s.z));
        const half = side() / 2;
        s.cx = Math.min(iw - half, Math.max(half, s.cx));
        s.cy = Math.min(ih - half, Math.max(half, s.cy));
      };
      const syncControls = () => {
        if (Number(slider.value) !== s.z) slider.value = String(s.z);
        zoomOut.disabled = s.z <= 1.0001;
        zoomIn.disabled = s.z >= maxZ - 0.0001;
      };
      const schedule = () => {
        syncControls();
        if (raf) return;
        raf = requestAnimationFrame(() => { raf = 0; draw(); });
      };
      function draw() {
        const V = viewSize();
        const dpr = Math.min(3, window.devicePixelRatio || 1);
        const px = Math.max(1, Math.round(V * dpr));
        if (canvas.width !== px) { canvas.width = px; canvas.height = px; }
        g.setTransform(1, 0, 0, 1, 0, 0);
        g.fillStyle = '#fff';
        g.fillRect(0, 0, px, px);
        g.imageSmoothingEnabled = true;
        g.imageSmoothingQuality = 'high';
        const k = px / side();
        g.drawImage(image, px / 2 - s.cx * k, px / 2 - s.cy * k, iw * k, ih * k);
        for (const c of [pvRound, pvFav]) {
          const cg = c.getContext('2d');
          cg.imageSmoothingQuality = 'high';
          cg.clearRect(0, 0, c.width, c.height);
          cg.drawImage(canvas, 0, 0, px, px, 0, 0, c.width, c.height);
        }
        syncControls();
      }
      const pan = (dx, dy) => {
        const scale = viewSize() / side();
        s.cx -= dx / scale;
        s.cy -= dy / scale;
        clampAll();
        schedule();
      };
      /** 缩放到 z，保持舞台上 (px, py) 处的图像点不动。 */
      const zoomAt = (z, px, py) => {
        const V = viewSize();
        const scale = V / side();
        const sx = s.cx + (px - V / 2) / scale;
        const sy = s.cy + (py - V / 2) / scale;
        s.z = Math.min(maxZ, Math.max(1, z));
        const scale2 = V / side();
        s.cx = sx - (px - V / 2) / scale2;
        s.cy = sy - (py - V / 2) / scale2;
        clampAll();
        schedule();
      };
      const zoomCenter = (z) => { const V = viewSize(); zoomAt(z, V / 2, V / 2); };

      // 拖动 / 双指缩放（Pointer Events 同时覆盖鼠标、触摸、触控笔）
      const pts = new Map();
      const local = (e) => { const r = stage.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
      stage.addEventListener('pointerdown', (e) => {
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        e.preventDefault();
        try { stage.setPointerCapture(e.pointerId); } catch { /* ignore */ }
        pts.set(e.pointerId, local(e));
        stage.classList.add('is-dragging');
        stage.focus({ preventScroll: true });
      });
      stage.addEventListener('pointermove', (e) => {
        const prev = pts.get(e.pointerId);
        if (!prev) return;
        e.preventDefault();
        const cur = local(e);
        if (pts.size === 1) {
          pan(cur.x - prev.x, cur.y - prev.y);
        } else {
          let other = null;
          for (const [id, p] of pts) if (id !== e.pointerId) { other = p; break; }
          const d0 = Math.hypot(prev.x - other.x, prev.y - other.y);
          const d1 = Math.hypot(cur.x - other.x, cur.y - other.y);
          const m0 = { x: (prev.x + other.x) / 2, y: (prev.y + other.y) / 2 };
          const m1 = { x: (cur.x + other.x) / 2, y: (cur.y + other.y) / 2 };
          if (d0 > 4) zoomAt(s.z * (d1 / d0), m0.x, m0.y);
          pan(m1.x - m0.x, m1.y - m0.y);
        }
        pts.set(e.pointerId, cur);
      });
      const endPointer = (e) => {
        pts.delete(e.pointerId);
        if (!pts.size) stage.classList.remove('is-dragging');
      };
      stage.addEventListener('pointerup', endPointer);
      stage.addEventListener('pointercancel', endPointer);
      stage.addEventListener('lostpointercapture', endPointer);
      stage.addEventListener('wheel', (e) => {
        e.preventDefault();
        const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
        const p = local(e);
        zoomAt(s.z * Math.exp(-e.deltaY * unit * 0.0015), p.x, p.y);
      }, { passive: false });
      stage.addEventListener('keydown', (e) => {
        const step = e.shiftKey ? 40 : 10;
        const map = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
        if (map[e.key]) { e.preventDefault(); pan(...map[e.key]); return; }
        if (e.key === '+' || e.key === '=') { e.preventDefault(); zoomCenter(s.z * 1.15); }
        if (e.key === '-' || e.key === '_') { e.preventDefault(); zoomCenter(s.z / 1.15); }
      });
      slider.addEventListener('input', () => zoomCenter(Number(slider.value)));
      zoomOut.addEventListener('click', () => zoomCenter(s.z / 1.25));
      zoomIn.addEventListener('click', () => zoomCenter(s.z * 1.25));
      resetBtn.addEventListener('click', () => { s.z = 1; s.cx = iw / 2; s.cy = ih / 2; clampAll(); schedule(); });

      let ro = null;
      if (typeof ResizeObserver === 'function') {
        ro = new ResizeObserver(() => schedule());
        ro.observe(stage);
      }

      modal({
        title: '调整头像',
        className: 'pf-crop-modal',
        content: h('div', { class: 'pf-crop' },
          h('div', { class: 'pf-crop-main' },
            stage,
            h('div', { class: 'pf-crop-tools' }, zoomOut, slider, zoomIn, resetBtn)),
          h('div', { class: 'pf-crop-side' },
            h('div', { class: 'pf-crop-pv' }, pvRound, h('span', { class: 'muted small' }, '首页头像')),
            h('div', { class: 'pf-crop-pv' }, pvFav, h('span', { class: 'muted small' }, '标签页图标')),
            h('p', { class: 'muted small pf-crop-tip' }, '拖动图片调整位置，用滑块、滚轮或双指缩放。圆圈内是首页显示的范围。'),
            small)),
        actions: [
          { text: '取消', kind: 'ghost', testid: 'crop-cancel' },
          {
            text: '使用这张图片',
            kind: 'primary',
            testid: 'crop-ok',
            autofocus: true,
            onClick: async (close) => {
              clampAll();
              const sz = side();
              const rect = { sx: s.cx - sz / 2, sy: s.cy - sz / 2, sSize: sz };
              const blob = await cropToBlob(image, rect, LIMITS.avatarSize, 'image/jpeg', 0.9);
              const favBlob = await cropToBlob(image, rect, LIMITS.faviconSize, 'image/jpeg', 0.92);
              result = { blob, favBlob };
              close();
            },
          },
        ],
        onClose: () => {
          if (raf) cancelAnimationFrame(raf);
          if (ro) ro.disconnect();
          closeImg(image);
          resolve(result);
        },
      });
      clampAll();
      requestAnimationFrame(() => draw());
    });
  }

  return {
    isDirty,
    async canLeave() {
      if (!isDirty()) return true;
      // 本机保存成功过（并且不是在等用户选择恢复 / 丢弃）：离开也不会丢
      const kept = st.local.ready && st.local.ok;
      return confirmDialog({
        title: '首页设置还没有发布',
        message: kept
          ? '刚才的修改（包括新头像）还没有发布到网站。离开后它们会保存在这台设备上，下次打开「首页设置」时可以恢复。确定要离开吗？'
          : '离开后，刚才的修改（包括新头像）会丢失。确定要离开吗？',
        okText: '仍然离开',
        cancelText: '留下来',
        danger: !kept,
      });
    },
    unmount() {
      // 登录失效时外壳会直接卸载视图（不问 canLeave）：先把最新的修改存到本机
      flushLocal();
      document.removeEventListener('visibilitychange', onHidden);
      window.removeEventListener('pagehide', onHidden);
      st.disposed = true;
      for (const u of st.urls) URL.revokeObjectURL(u);
      st.urls.clear();
    },
  };
}

function closeImg(image) {
  if (image && typeof image.close === 'function') {
    try { image.close(); } catch { /* ignore */ }
  }
}
