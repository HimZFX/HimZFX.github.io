// static/viewer/viewer.js — 资料在线预览：/viewer/?file=/documents/讲义.pdf[&lang=en][&embed=1][&page=N]
//
// PDF → PDF.js (vendor/pdfjs, legacy build so it also works in old Android / WeChat WebViews), pages are
// rendered lazily near the viewport and freed when far away; images → <img>; anything else → download.
// Security (same origin as /admin/ and its remembered token): the file parameter is validated by path.js
// before anything is fetched; no innerHTML with data; PDF.js runs without scripting/XFA/eval; only
// http(s)/mailto links and in-document jumps from PDF link annotations are turned into links.
// See README.md in this folder.

import { parseFileParam, viewerHref } from './path.js';

// ---------------------------------------------------------------------------------------------- strings

const STRINGS = {
  zh: {
    home: '主页',
    loading: '正在加载…',
    loadingPct: '正在加载… {0}%',
    loadingBytes: '正在加载… {0}',
    download: '下载',
    openNew: '在新页面打开',
    zoomIn: '放大',
    zoomOut: '缩小',
    fitWidth: '适应宽度',
    pageInput: '跳到第几页',
    pageLabel: '第 {0} 页',
    noFile: '没有指定要预览的文件',
    noFileDetail: '链接里缺少 file 参数，请检查链接是否完整。',
    badParam: '无法预览这个链接',
    badParamDetail: '只能预览本站上传的资料（例如 /documents/ 下的文件）。',
    missing: '文件不存在或已被删除',
    missingDetail: '请确认链接是否正确，或者联系作者。',
    password: '这个 PDF 设有密码，无法在线预览',
    passwordDetail: '请下载后用 PDF 阅读器打开并输入密码。',
    invalid: '文件已损坏，或者不是有效的 PDF',
    invalidDetail: '可以尝试下载后用其他软件打开。',
    network: '加载失败，网络好像不太稳定',
    networkDetail: '请检查网络后重试，或直接下载文件。',
    generic: '预览失败',
    genericDetail: '可以直接下载文件查看。',
    retry: '重试',
    unsupported: '这种文件暂不支持在线预览',
    unsupportedDetail: '请下载后查看：{0}',
    imageMissing: '图片不存在或已被删除',
    pageError: '这一页显示失败',
    tooOld: '浏览器版本过旧，无法在线预览。请换用其他浏览器打开这个链接。',
    imageAlt: '{0}',
    viewerTitle: '资料预览',
  },
  en: {
    home: 'Home',
    loading: 'Loading…',
    loadingPct: 'Loading… {0}%',
    loadingBytes: 'Loading… {0}',
    download: 'Download',
    openNew: 'Open in new tab',
    zoomIn: 'Zoom in',
    zoomOut: 'Zoom out',
    fitWidth: 'Fit width',
    pageInput: 'Go to page',
    pageLabel: 'Page {0}',
    noFile: 'No file specified',
    noFileDetail: 'The link is missing its file parameter. Please check that the link is complete.',
    badParam: 'This link cannot be previewed',
    badParamDetail: 'Only files uploaded to this site (e.g. under /documents/) can be previewed.',
    missing: 'File not found — it may have been deleted',
    missingDetail: 'Please check the link, or contact the author.',
    password: 'This PDF is password-protected and cannot be previewed',
    passwordDetail: 'Please download it and open it in a PDF reader.',
    invalid: 'The file is damaged or not a valid PDF',
    invalidDetail: 'Try downloading it and opening it with another app.',
    network: 'Loading failed — the network seems unstable',
    networkDetail: 'Check your connection and retry, or download the file directly.',
    generic: 'Preview failed',
    genericDetail: 'You can download the file instead.',
    retry: 'Retry',
    unsupported: 'This file type cannot be previewed online',
    unsupportedDetail: 'Please download it: {0}',
    imageMissing: 'Image not found — it may have been deleted',
    pageError: 'This page could not be displayed',
    tooOld: 'This browser is too old to preview files. Please open the link in another browser.',
    imageAlt: '{0}',
    viewerTitle: 'File preview',
  },
};

// ---------------------------------------------------------------------------------------------- setup

const params = new URLSearchParams(window.location.search);
const LANG = params.get('lang') === 'en' ? 'en' : 'zh';
const EMBED = params.get('embed') === '1';
const START_PAGE = /^[1-9][0-9]{0,5}$/.test(params.get('page') || '') ? parseInt(params.get('page'), 10) : 1;
const T = STRINGS[LANG];
const root = document.documentElement;

const $ = (id) => document.getElementById(id);
const els = {
  bar: $('bar'),
  home: $('home'),
  siteName: $('site-name'),
  fileName: $('file-name'),
  pager: $('pager'),
  pageInput: $('page-input'),
  pageCount: $('page-count'),
  zoom: $('zoom'),
  zoomOut: $('zoom-out'),
  zoomIn: $('zoom-in'),
  zoomFit: $('zoom-fit'),
  zoomLabel: $('zoom-label'),
  openNew: $('open-new'),
  download: $('download'),
  progress: $('progress'),
  progressFill: $('progress-fill'),
  main: $('main'),
  pages: $('pages'),
  status: $('status'),
};

function fmt(s, ...args) {
  return String(s).replace(/\{(\d)\}/g, (_, i) => (args[i] === undefined ? '' : String(args[i])));
}

/** Small DOM helper: h('a', { class, href, text, attrs… }, ...children). Never uses innerHTML. */
function h(tag, props, ...children) {
  const el = document.createElement(tag);
  if (props) {
    for (const k of Object.keys(props)) {
      const v = props[k];
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k === 'on') for (const ev of Object.keys(v)) el.addEventListener(ev, v[ev]);
      else el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  for (const c of children) if (c) el.append(c);
  return el;
}

/** el.replaceChildren(...) for older WebViews (Chrome < 86). */
function setChildren(el, ...children) {
  while (el.firstChild) el.removeChild(el.firstChild);
  for (const c of children) el.append(c);
}

const SVG_NS = 'http://www.w3.org/2000/svg';
function icon(paths) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'icon');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  for (const d of paths) {
    const p = document.createElementNS(SVG_NS, 'path');
    p.setAttribute('d', d);
    svg.append(p);
  }
  return svg;
}
const ICONS = {
  alert: ['M12 8v5', 'M12 16.5v.5', 'M10.3 3.9 2.6 17.2A2 2 0 0 0 4.3 20h15.4a2 2 0 0 0 1.7-2.8L13.7 3.9a2 2 0 0 0-3.4 0z'],
  file: ['M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z', 'M14 3v5h5'],
  lock: ['M6 11h12v9H6z', 'M8 11V8a4 4 0 0 1 8 0v3'],
  download: ['M12 4v11', 'M7 10l5 5 5-5', 'M5 20h14'],
  retry: ['M20 11a8 8 0 1 0-2.3 5.7', 'M20 5v6h-6'],
};

function applyStrings() {
  root.lang = LANG === 'en' ? 'en' : 'zh-CN';
  for (const el of document.querySelectorAll('[data-i18n]')) el.textContent = T[el.getAttribute('data-i18n')];
  for (const el of document.querySelectorAll('[data-i18n-title]')) {
    const s = T[el.getAttribute('data-i18n-title')];
    el.title = s;
    el.setAttribute('aria-label', s);
  }
  document.title = T.viewerTitle;
}

/** The site's home page ("/" or "/en/"), resolved relative to /viewer/ so a sub-path baseURL also works. */
const HOME_URL = new URL(LANG === 'en' ? '../en/' : '../', window.location.href).href;

/** Decode the few HTML character references that can appear in an attribute / <title> (no DOM parsing). */
function decodeEntities(s) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  return s.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
    }
    return Object.prototype.hasOwnProperty.call(named, e.toLowerCase()) ? named[e.toLowerCase()] : m;
  });
}

/**
 * Replace 「主页」 by the real site name (og:site_name, else <title> of the home page). Best effort, same
 * origin. Plain text matching on purpose: a DOMParser document would inherit our CSP and report every
 * inline style of the theme's page as a violation.
 */
async function loadSiteName() {
  try {
    const res = await fetch(HOME_URL, { credentials: 'same-origin', cache: 'force-cache' });
    if (!res.ok || !/text\/html/i.test(res.headers.get('content-type') || '')) return;
    const html = (await res.text()).slice(0, 65536);
    const og = /<meta\s[^>]*property=["']?og:site_name["']?[^>]*>/i.exec(html);
    let name = '';
    if (og) {
      const c = /\scontent=(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(og[0]);
      if (c) name = c[1] || c[2] || c[3] || '';
    }
    if (!name) {
      const t = /<title[^>]*>([^<]*)<\/title>/i.exec(html);
      if (t) name = t[1];
    }
    name = decodeEntities(name).replace(/\s+/g, ' ').trim();
    if (name && name.length <= 60) {
      els.siteName.textContent = name;
      els.home.title = name;
      els.home.setAttribute('aria-label', name);
    }
  } catch (e) {
    /* keep 「主页」 */
  }
}

// ---------------------------------------------------------------------------------------------- status

function setProgress(fraction) {
  if (fraction === null) {
    els.progress.hidden = true;
    return;
  }
  els.progress.hidden = false;
  if (fraction < 0) {
    els.progress.classList.add('indeterminate');
    els.progressFill.style.width = '';
  } else {
    els.progress.classList.remove('indeterminate');
    els.progressFill.style.width = Math.round(Math.min(1, fraction) * 100) + '%';
  }
}

function showLoading(text) {
  els.status.hidden = false;
  els.status.className = 'status';
  setChildren(els.status, h('div', { class: 'spinner', 'aria-hidden': 'true' }), h('p', { class: 'status-title', id: 'status-title', text: text || T.loading }));
}

function updateLoadingText(text) {
  const t = document.getElementById('status-title');
  if (t) t.textContent = text;
}

function hideStatus() {
  els.status.hidden = true;
  setChildren(els.status);
}

/**
 * Show a message instead of the document.
 * @param {{ kind: string, title: string, detail?: string, download?: object|null, retry?: Function }} o
 */
function showMessage({ kind, title, detail, download, retry }) {
  setProgress(null);
  els.status.hidden = false;
  els.status.className = 'status' + (kind === 'error' ? ' is-error' : '');
  els.status.setAttribute('data-state', kind);
  const actions = h('div', { class: 'status-actions' });
  if (retry) {
    actions.append(h('button', { type: 'button', class: 'btn', 'data-testid': 'viewer-retry', on: { click: retry } }, icon(ICONS.retry), h('span', { text: T.retry })));
  }
  if (download) {
    actions.append(h('a', { class: 'btn btn-primary', href: download.href, download: download.name, 'data-testid': 'viewer-message-download' }, icon(ICONS.download), h('span', { text: T.download })));
  }
  const iconName = kind === 'password' ? 'lock' : kind === 'unsupported' ? 'file' : 'alert';
  const parts = [
    h('div', { class: 'status-icon' }, icon(ICONS[iconName])),
    h('p', { class: 'status-title', id: 'status-title', text: title }),
  ];
  if (detail) parts.push(h('p', { class: 'status-detail', text: detail }));
  if (actions.childNodes.length) parts.push(actions);
  setChildren(els.status, ...parts);
}

function fileUrlFor(file) {
  return new URL(file.href, window.location.origin).href;
}

function setupFileChrome(file) {
  document.title = file.name;
  els.fileName.textContent = file.name;
  els.fileName.title = file.path;
  els.download.href = file.href;
  els.download.setAttribute('download', file.name);
  els.download.hidden = false;
  if (EMBED) {
    els.openNew.hidden = false;
    updateOpenNew(START_PAGE);
  }
}

function updateOpenNew(page) {
  if (!EMBED || !current.file) return;
  els.openNew.href = viewerHref(current.file.path, { lang: LANG, page });
}

// ---------------------------------------------------------------------------------------------- image

function showImage(file) {
  hideStatus();
  const wrap = h('div', { class: 'image-wrap', 'data-testid': 'viewer-image-wrap' });
  const img = h('img', { src: file.href, alt: fmt(T.imageAlt, file.name), decoding: 'async', 'data-testid': 'viewer-image' });
  img.addEventListener('load', () => root.setAttribute('data-ready', '1'));
  img.addEventListener('error', () => {
    wrap.remove();
    showMessage({ kind: 'error', title: T.imageMissing, detail: T.missingDetail });
    els.download.hidden = true;
    root.setAttribute('data-error', 'missing');
  });
  // Tap / click toggles 「fit the screen」 ↔ 「actual size」; pinch-zoom is the browser's own.
  img.addEventListener('click', () => {
    wrap.classList.toggle('natural');
  });
  wrap.append(img);
  els.pages.replaceWith(wrap);
  els.pages = wrap;
}

// ---------------------------------------------------------------------------------------------- PDF

const CSS_UNITS = 96 / 72; // 100% = the PDF's real size on screen
const ZOOM_STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5];
const MIN_ZOOM = 0.25;
const MAX_ZOOM = 5;
const MAX_FIT_WIDTH = 1000; // CSS px: on wide desktop screens 「fit width」 stops growing here
const COARSE = (() => {
  try {
    return window.matchMedia('(pointer: coarse)').matches;
  } catch (e) {
    return false;
  }
})();
// Canvas pixel budget per page (phones / WeChat have little memory; iOS caps a canvas at 16.7 Mpx).
const MAX_CANVAS_PIXELS = COARSE ? 2 ** 23 : 2 ** 24;
const VENDOR = new URL('./vendor/pdfjs/', import.meta.url);
// On touch devices a document wider than the screen makes mobile browsers widen the layout viewport, which
// pushes the fixed top bar off-screen. There the pages area scrolls sideways by itself (html.hscroll-main);
// on desktop the document scrolls sideways as usual.
const HSCROLL_MAIN = COARSE;
const scrollLeftOf = () => (HSCROLL_MAIN ? els.main.scrollLeft : window.scrollX);

const current = {
  file: null,
  pdf: null,
  lib: null,
  pages: [],
  zoom: 1,
  scale: CSS_UNITS,
  fit: true,
  currentPage: 1,
  visible: new Set(),
  rendering: 0,
  nearObserver: null,
  keepObserver: null,
};

function classifyError(e) {
  const name = (e && e.name) || '';
  if (name === 'PasswordException') return 'password';
  if (name === 'InvalidPDFException' || name === 'FormatError') return 'invalid';
  if (name === 'MissingPDFException') return 'missing';
  if (name === 'ResponseException') {
    if (e.missing || e.status === 404 || e.status === 410) return 'missing';
    return 'network';
  }
  if (name === 'UnexpectedResponseException') return 'network';
  if (e instanceof TypeError && /fetch|network|load/i.test(e.message || '')) return 'network';
  return 'generic';
}

function formatBytes(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB';
  return (n / 1024 / 1024).toFixed(1) + ' MB';
}

async function openPdf(file) {
  root.classList.add('mode-pdf');
  if (HSCROLL_MAIN) root.classList.add('hscroll-main');
  showLoading(T.loading);
  setProgress(-1);
  let lib = current.lib;
  try {
    if (!lib) {
      lib = await import('./vendor/pdfjs/build/pdf.min.mjs');
      lib.GlobalWorkerOptions.workerSrc = new URL('build/pdf.worker.min.mjs', VENDOR).href;
      current.lib = lib;
    }
  } catch (e) {
    showMessage({ kind: 'error', title: T.generic, detail: T.tooOld, download: file });
    return;
  }
  const task = lib.getDocument({
    url: fileUrlFor(file),
    withCredentials: false,
    cMapUrl: new URL('cmaps/', VENDOR).href, // Chinese PDFs with non-embedded fonts need these
    cMapPacked: true,
    standardFontDataUrl: new URL('standard_fonts/', VENDOR).href,
    wasmUrl: new URL('wasm/', VENDOR).href, // JPEG 2000 / JBIG2 decoders and ICC colour (run in the worker)
    iccUrl: new URL('iccs/', VENDOR).href,
    isEvalSupported: false, // (older PDF.js option; 6.x never evals — kept as a belt-and-braces default)
    enableXfa: false,
    stopAtErrors: false,
    verbosity: lib.VerbosityLevel ? lib.VerbosityLevel.ERRORS : 0,
  });
  task.onProgress = ({ loaded, total }) => {
    if (total > 0) {
      setProgress(loaded / total);
      updateLoadingText(fmt(T.loadingPct, Math.min(100, Math.round((loaded / total) * 100))));
    } else if (loaded > 0) {
      updateLoadingText(fmt(T.loadingBytes, formatBytes(loaded)));
    }
  };
  let pdf;
  try {
    pdf = await task.promise;
  } catch (e) {
    const kind = classifyError(e);
    const retry = kind === 'network' || kind === 'generic' ? () => openPdf(file) : null;
    const msg = {
      missing: [T.missing, T.missingDetail],
      password: [T.password, T.passwordDetail],
      invalid: [T.invalid, T.invalidDetail],
      network: [T.network, T.networkDetail],
      generic: [T.generic, T.genericDetail],
    }[kind];
    if (kind === 'missing') els.download.hidden = true;
    showMessage({
      kind: kind === 'password' ? 'password' : 'error',
      title: msg[0],
      detail: msg[1],
      download: kind === 'missing' ? null : file,
      retry,
    });
    root.setAttribute('data-error', kind);
    return;
  }
  current.pdf = pdf;
  try {
    await setupPages(pdf);
  } catch (e) {
    showMessage({ kind: 'error', title: T.generic, detail: T.genericDetail, download: file, retry: () => window.location.reload() });
    return;
  }
  setProgress(null);
  hideStatus();
}

async function setupPages(pdf) {
  const first = await pdf.getPage(1);
  const vp1 = first.getViewport({ scale: 1 });
  const n = pdf.numPages;
  const frag = document.createDocumentFragment();
  current.pages = [];
  for (let i = 1; i <= n; i++) {
    const div = h('div', { class: 'page', 'data-page-number': String(i), 'data-testid': 'viewer-page', role: 'region', 'aria-label': fmt(T.pageLabel, i) });
    const p = { num: i, div, w: vp1.width, h: vp1.height, page: i === 1 ? first : null, sized: i === 1, canvas: null, task: null, renderedScale: 0, gen: 0, textLayer: null, textDiv: null, links: null, failed: false };
    div._viewerPage = p;
    current.pages.push(p);
    frag.append(div);
  }
  setChildren(els.pages, frag);
  els.pageCount.textContent = String(n);
  els.pageInput.value = String(Math.min(START_PAGE, n));
  els.pager.hidden = false;
  els.zoom.hidden = false;
  root.setAttribute('data-pages', String(n));

  current.fit = true;
  current.zoom = fitZoom();
  current.scale = current.zoom * CSS_UNITS;
  layoutPages();
  updateZoomUi();

  setupObservers();
  setupControls();
  if (START_PAGE > 1) scrollToPage(Math.min(START_PAGE, n), false);
  updateCurrentPage();
  root.setAttribute('data-ready', '1');
}

/** Width available for a page (fit width), in CSS px. */
function availableWidth() {
  const pad = parseFloat(window.getComputedStyle(els.pages).paddingLeft) || 0;
  const w = document.documentElement.clientWidth - 2 * pad;
  return Math.max(120, Math.min(w, MAX_FIT_WIDTH));
}

function fitZoom() {
  const p = current.pages[current.currentPage - 1] || current.pages[0];
  if (!p) return 1;
  return clampZoom(availableWidth() / (p.w * CSS_UNITS));
}

function clampZoom(z) {
  return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, z));
}

function layoutPages() {
  const s = current.scale;
  for (const p of current.pages) {
    p.div.style.width = Math.floor(p.w * s) + 'px';
    p.div.style.height = Math.floor(p.h * s) + 'px';
    p.div.style.setProperty('--total-scale-factor', String(s));
    p.div.style.setProperty('--scale-factor', String(s));
  }
}

function updateZoomUi() {
  els.zoomLabel.textContent = Math.round(current.zoom * 100) + '%';
  els.zoomOut.disabled = current.zoom <= MIN_ZOOM + 1e-6;
  els.zoomIn.disabled = current.zoom >= MAX_ZOOM - 1e-6;
  root.setAttribute('data-zoom', current.zoom.toFixed(3));
  root.setAttribute('data-scale', current.scale.toFixed(4));
  root.setAttribute('data-fit', current.fit ? '1' : '0');
}

function barHeight() {
  return els.bar.getBoundingClientRect().height;
}

/** Index of the page at client y (binary search over the page rects). */
function pageIndexAtY(y) {
  const pages = current.pages;
  let lo = 0;
  let hi = pages.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (pages[mid].div.getBoundingClientRect().top <= y) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** Remember which point of which page sits at client (x, y), to put it back there after a zoom. */
function captureAnchor(x, y) {
  const idx = pageIndexAtY(y);
  const r = current.pages[idx].div.getBoundingClientRect();
  return { idx, fx: (x - r.left) / r.width, fy: (y - r.top) / r.height, x, y };
}

function restoreAnchor(a) {
  const r = current.pages[a.idx].div.getBoundingClientRect();
  const left = scrollLeftOf() + r.left + a.fx * r.width - a.x;
  const top = window.scrollY + r.top + a.fy * r.height - a.y;
  if (HSCROLL_MAIN) {
    els.main.scrollLeft = Math.max(0, left);
    window.scrollTo(window.scrollX, Math.max(0, top));
  } else {
    window.scrollTo(Math.max(0, left), Math.max(0, top));
  }
}

function setZoom(z, { fit = false, anchorX, anchorY } = {}) {
  z = clampZoom(z);
  const bh = barHeight();
  const x = anchorX === undefined ? document.documentElement.clientWidth / 2 : anchorX;
  const y = anchorY === undefined ? bh + Math.min(40, (window.innerHeight - bh) / 3) : anchorY;
  const anchor = captureAnchor(x, Math.max(y, bh + 1));
  current.fit = fit;
  if (Math.abs(z - current.zoom) > 1e-4) {
    current.zoom = z;
    current.scale = z * CSS_UNITS;
    layoutPages();
    restoreAnchor(anchor);
    pump();
  }
  updateZoomUi();
}

function stepZoom(dir) {
  const z = current.zoom;
  let next;
  if (dir > 0) next = ZOOM_STEPS.find((s) => s > z + 0.005) || MAX_ZOOM;
  else next = ZOOM_STEPS.slice().reverse().find((s) => s < z - 0.005) || MIN_ZOOM;
  setZoom(next);
}

function scrollToPage(num, smooth) {
  const p = current.pages[num - 1];
  if (!p) return;
  const top = window.scrollY + p.div.getBoundingClientRect().top - barHeight() - (EMBED ? 6 : 8);
  window.scrollTo({ left: window.scrollX, top: Math.max(0, top), behavior: smooth ? 'smooth' : 'auto' });
  setCurrentPage(num);
}

function setCurrentPage(num) {
  if (num === current.currentPage && root.getAttribute('data-current-page') === String(num)) return;
  current.currentPage = num;
  if (document.activeElement !== els.pageInput) els.pageInput.value = String(num);
  root.setAttribute('data-current-page', String(num));
  updateOpenNew(num);
}

function updateCurrentPage() {
  if (!current.pages.length) return;
  const bh = barHeight();
  const y = bh + (window.innerHeight - bh) * 0.35;
  // At the very bottom the last page counts as current even if it is short.
  const atEnd = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2;
  setCurrentPage(atEnd ? current.pages.length : pageIndexAtY(y) + 1);
}

// ---- lazy rendering ------------------------------------------------------------------------------

function observerRoot() {
  // Inside the embed <iframe>, `root: null` would mean the TOP page's viewport (and ignore our margins);
  // the iframe's own document is the right root. Older browsers without Document roots fall back to null.
  try {
    const io = new IntersectionObserver(() => {}, { root: document });
    io.disconnect();
    return document;
  } catch (e) {
    return null;
  }
}

function setupObservers() {
  const rootEl = observerRoot();
  current.nearObserver = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        const p = e.target._viewerPage;
        if (e.isIntersecting) current.visible.add(p);
        else current.visible.delete(p);
      }
      pump();
    },
    { root: rootEl, rootMargin: '100% 0px 100% 0px' },
  );
  current.keepObserver = new IntersectionObserver(
    (entries) => {
      for (const e of entries) if (!e.isIntersecting) releasePage(e.target._viewerPage);
    },
    { root: rootEl, rootMargin: '300% 0px 300% 0px' },
  );
  for (const p of current.pages) {
    current.nearObserver.observe(p.div);
    current.keepObserver.observe(p.div);
  }
}

/** Render the nearest visible page that is missing or at a stale scale; one at a time. */
function pump() {
  if (current.rendering > 0 || !current.pdf) return;
  let best = null;
  let bestDist = Infinity;
  for (const p of current.visible) {
    if (p.failed || Math.abs(p.renderedScale - current.scale) < 1e-6) continue;
    const d = Math.abs(p.num - current.currentPage);
    if (d < bestDist) {
      best = p;
      bestDist = d;
    }
  }
  if (!best) return;
  current.rendering++;
  renderPage(best)
    .catch(() => {})
    .then(() => {
      current.rendering--;
      pump();
    });
}

function freeCanvas(c) {
  if (!c) return;
  c.width = 0; // releases the bitmap memory right away (important on phones)
  c.height = 0;
  c.remove();
}

function releasePage(p) {
  if (!p) return;
  current.visible.delete(p);
  p.gen++;
  if (p.task) {
    try {
      p.task.cancel();
    } catch (e) {
      /* ignore */
    }
    p.task = null;
  }
  if (p.textLayer) {
    try {
      p.textLayer.cancel();
    } catch (e) {
      /* ignore */
    }
    p.textLayer = null;
  }
  if (p.textDiv) {
    p.textDiv.remove();
    p.textDiv = null;
  }
  if (p.canvas) {
    freeCanvas(p.canvas);
    p.canvas = null;
    p.div.classList.remove('rendered');
    p.div.removeAttribute('data-rendered-scale');
    if (p.page) p.page.cleanup();
  }
  p.renderedScale = 0;
}

async function renderPage(p) {
  const gen = ++p.gen;
  const scale = current.scale;
  if (!p.page) p.page = await current.pdf.getPage(p.num);
  if (gen !== p.gen) return;
  const page = p.page;
  if (!p.sized) {
    const v1 = page.getViewport({ scale: 1 });
    p.sized = true;
    if (Math.abs(v1.width - p.w) > 0.5 || Math.abs(v1.height - p.h) > 0.5) {
      p.w = v1.width;
      p.h = v1.height;
      p.div.style.width = Math.floor(p.w * scale) + 'px';
      p.div.style.height = Math.floor(p.h * scale) + 'px';
    }
  }
  const viewport = page.getViewport({ scale });
  const cssW = Math.floor(viewport.width);
  const cssH = Math.floor(viewport.height);
  let ratio = window.devicePixelRatio || 1;
  const maxRatio = Math.sqrt(MAX_CANVAS_PIXELS / Math.max(1, cssW * cssH));
  if (ratio > maxRatio) ratio = maxRatio;
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.floor(viewport.width * ratio));
  canvas.height = Math.max(1, Math.floor(viewport.height * ratio));
  canvas.setAttribute('aria-hidden', 'true');
  const ctx = canvas.getContext('2d', { alpha: false });
  const sx = canvas.width / viewport.width;
  const sy = canvas.height / viewport.height;
  const task = page.render({
    canvasContext: ctx,
    canvas,
    viewport,
    transform: sx !== 1 || sy !== 1 ? [sx, 0, 0, sy, 0, 0] : null,
  });
  p.task = task;
  try {
    await task.promise;
  } catch (e) {
    freeCanvas(canvas);
    if (e && e.name === 'RenderingCancelledException') return;
    if (gen === p.gen) {
      p.failed = true;
      p.div.classList.add('rendered');
      p.div.append(h('div', { class: 'page-error', text: T.pageError }));
    }
    return;
  } finally {
    if (p.task === task) p.task = null;
  }
  if (gen !== p.gen || Math.abs(scale - current.scale) > 1e-6 && !current.visible.has(p)) {
    freeCanvas(canvas);
    return;
  }
  if (p.canvas) freeCanvas(p.canvas);
  p.div.prepend(canvas);
  p.canvas = canvas;
  p.renderedScale = scale;
  p.div.classList.add('rendered');
  p.div.setAttribute('data-rendered-scale', scale.toFixed(4));
  renderTextLayer(p, viewport, gen);
  renderLinks(p);
}

function renderTextLayer(p, viewport, gen) {
  const lib = current.lib;
  if (!lib.TextLayer) return;
  if (p.textLayer) {
    try {
      p.textLayer.cancel();
    } catch (e) {
      /* ignore */
    }
  }
  const div = h('div', { class: 'textLayer' });
  try {
    const tl = new lib.TextLayer({ textContentSource: p.page.streamTextContent(), container: div, viewport });
    p.textLayer = tl;
    tl.render()
      .then(() => {
        if (gen !== p.gen) return div.remove();
        if (p.textDiv && p.textDiv !== div) p.textDiv.remove();
        div.append(h('div', { class: 'endOfContent' }));
        p.div.append(div);
        p.textDiv = div;
        setupSelectionClass(div);
      })
      .catch(() => div.remove());
  } catch (e) {
    /* text selection is optional — the page itself is already visible */
  }
}

function setupSelectionClass(div) {
  // Same trick as PDF.js: while dragging a selection, stretch .endOfContent so the selection doesn't jump.
  div.addEventListener('mousedown', () => div.classList.add('selecting'));
  div.addEventListener('mouseup', () => div.classList.remove('selecting'));
}

const SAFE_PROTOCOLS = ['http:', 'https:', 'mailto:'];

function renderLinks(p) {
  if (p.links) return; // positions are in %, so they survive zooming
  p.links = 'pending';
  buildLinks(p).catch(() => {
    p.links = 'none'; // links are optional: never break the page over them
  });
}

async function buildLinks(p) {
  let annots;
  try {
    annots = await p.page.getAnnotations({ intent: 'display' });
  } catch (e) {
    p.links = null;
    return;
  }
  const v1 = p.page.getViewport({ scale: 1 });
  const layer = h('div', { class: 'linkLayer' });
  for (const a of annots) {
    if (a.subtype !== 'Link' || !Array.isArray(a.rect)) continue;
    const p1 = v1.convertToViewportPoint(a.rect[0], a.rect[1]);
    const p2 = v1.convertToViewportPoint(a.rect[2], a.rect[3]);
    const r = [p1[0], p1[1], p2[0], p2[1]];
    const left = Math.min(r[0], r[2]);
    const top = Math.min(r[1], r[3]);
    const width = Math.abs(r[2] - r[0]);
    const height = Math.abs(r[3] - r[1]);
    if (!(width > 0 && height > 0)) continue;
    let link = null;
    if (typeof a.url === 'string' && a.url) {
      let u = null;
      try {
        u = new URL(a.url);
      } catch (e) {
        u = null;
      }
      if (u && SAFE_PROTOCOLS.indexOf(u.protocol) !== -1) {
        link = h('a', { href: u.href, target: '_blank', rel: 'noopener noreferrer nofollow', title: u.href });
      }
    } else if (a.dest) {
      const dest = a.dest;
      link = h('a', { href: '#', 'data-dest': '1' });
      link.addEventListener('click', (ev) => {
        ev.preventDefault();
        goToDest(dest);
      });
    } else if (a.action && ['NextPage', 'PrevPage', 'FirstPage', 'LastPage'].indexOf(a.action) !== -1) {
      const action = a.action;
      link = h('a', { href: '#', 'data-action': action });
      link.addEventListener('click', (ev) => {
        ev.preventDefault();
        const n = current.pages.length;
        const target = { NextPage: p.num + 1, PrevPage: p.num - 1, FirstPage: 1, LastPage: n }[action];
        scrollToPage(Math.max(1, Math.min(n, target)), false);
      });
    }
    if (!link) continue;
    link.style.left = (100 * left) / v1.width + '%';
    link.style.top = (100 * top) / v1.height + '%';
    link.style.width = (100 * width) / v1.width + '%';
    link.style.height = (100 * height) / v1.height + '%';
    layer.append(link);
  }
  if (layer.childNodes.length) {
    p.div.append(layer);
    p.links = layer;
  } else {
    p.links = 'none';
  }
}

async function goToDest(dest) {
  try {
    let explicit = dest;
    if (typeof dest === 'string') explicit = await current.pdf.getDestination(dest);
    if (!Array.isArray(explicit) || !explicit.length) return;
    const ref = explicit[0];
    let index;
    if (ref && typeof ref === 'object') index = await current.pdf.getPageIndex(ref);
    else if (Number.isInteger(ref)) index = ref;
    if (Number.isInteger(index) && index >= 0 && index < current.pages.length) scrollToPage(index + 1, false);
  } catch (e) {
    /* broken destination: ignore */
  }
}

// ---- controls ------------------------------------------------------------------------------------

let controlsReady = false;
function setupControls() {
  if (controlsReady) return;
  controlsReady = true;
  els.zoomIn.addEventListener('click', () => stepZoom(1));
  els.zoomOut.addEventListener('click', () => stepZoom(-1));
  els.zoomFit.addEventListener('click', () => {
    current.fit = true;
    setZoom(fitZoom(), { fit: true });
  });

  const go = () => {
    const n = parseInt(els.pageInput.value, 10);
    if (Number.isInteger(n)) scrollToPage(Math.max(1, Math.min(current.pages.length, n)), false);
    els.pageInput.value = String(current.currentPage);
  };
  els.pageInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      go();
      els.pageInput.blur();
    }
  });
  els.pageInput.addEventListener('change', go);
  els.pageInput.addEventListener('focus', () => els.pageInput.select());

  let scrollQueued = false;
  window.addEventListener(
    'scroll',
    () => {
      if (scrollQueued) return;
      scrollQueued = true;
      window.requestAnimationFrame(() => {
        scrollQueued = false;
        updateCurrentPage();
      });
    },
    { passive: true },
  );

  // Rotating a phone / resizing the window keeps 「fit width」 fitted (height-only changes — the mobile
  // address bar showing/hiding — are ignored).
  let lastWidth = document.documentElement.clientWidth;
  let resizeTimer = 0;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      const w = document.documentElement.clientWidth;
      if (w === lastWidth) return;
      lastWidth = w;
      if (current.fit) setZoom(fitZoom(), { fit: true });
    }, 150);
  });

  // Ctrl/⌘ + / − / 0 zoom the document instead of the whole page.
  window.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
    if (e.key === '+' || e.key === '=') stepZoom(1);
    else if (e.key === '-') stepZoom(-1);
    else if (e.key === '0') setZoom(fitZoom(), { fit: true });
    else return;
    e.preventDefault();
  });
  // Ctrl + wheel / trackpad pinch on desktop.
  window.addEventListener(
    'wheel',
    (e) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      const factor = Math.exp(-e.deltaY / 300);
      setZoom(current.zoom * factor, { anchorX: e.clientX, anchorY: e.clientY });
    },
    { passive: false },
  );

  setupPinch();
}

/** Two-finger pinch on phones: scale the pages with a CSS transform while pinching, re-render sharply after. */
function setupPinch() {
  let start = null;
  let ratio = 1;
  const dist = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
  const mid = (t) => ({ x: (t[0].clientX + t[1].clientX) / 2, y: (t[0].clientY + t[1].clientY) / 2 });
  els.main.addEventListener(
    'touchstart',
    (e) => {
      if (e.touches.length !== 2) return;
      const m = mid(e.touches);
      const box = els.pages.getBoundingClientRect();
      start = { d: dist(e.touches) || 1, x: m.x, y: m.y };
      ratio = 1;
      els.pages.style.transformOrigin = m.x - box.left + 'px ' + (m.y - box.top) + 'px';
    },
    { passive: true },
  );
  els.main.addEventListener(
    'touchmove',
    (e) => {
      if (!start || e.touches.length !== 2) return;
      e.preventDefault();
      const z = clampZoom(current.zoom * (dist(e.touches) / start.d));
      ratio = z / current.zoom;
      els.pages.style.transform = 'scale(' + ratio + ')';
    },
    { passive: false },
  );
  const end = () => {
    if (!start) return;
    const s = start;
    start = null;
    els.pages.style.transform = '';
    els.pages.style.transformOrigin = '';
    if (Math.abs(ratio - 1) > 0.01) setZoom(current.zoom * ratio, { anchorX: s.x, anchorY: s.y });
  };
  els.main.addEventListener('touchend', (e) => {
    if (e.touches.length < 2) end();
  });
  els.main.addEventListener('touchcancel', end);
}

// ---------------------------------------------------------------------------------------------- main

function main() {
  applyStrings();
  if (EMBED) root.classList.add('embed');
  els.home.href = HOME_URL;
  if (!EMBED) loadSiteName();

  const raw = params.get('file');
  if (!raw) {
    root.setAttribute('data-error', 'no-file');
    showMessage({ kind: 'error', title: T.noFile, detail: T.noFileDetail });
    return;
  }
  const file = parseFileParam(raw, window.location.origin);
  if (!file.ok) {
    root.setAttribute('data-error', 'bad-param');
    showMessage({ kind: 'error', title: T.badParam, detail: T.badParamDetail });
    return;
  }
  current.file = file;
  root.setAttribute('data-kind', file.kind);
  setupFileChrome(file);
  if (file.kind === 'pdf') openPdf(file);
  else if (file.kind === 'image') showImage(file);
  else {
    root.setAttribute('data-error', 'unsupported');
    showMessage({ kind: 'unsupported', title: T.unsupported, detail: fmt(T.unsupportedDetail, file.name), download: file });
  }
}

main();
