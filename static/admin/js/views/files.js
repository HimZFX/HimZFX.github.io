/**
 * views/files.js — 「资料」：上传和管理网站上的文件（ADMIN_SPEC §6.6）。
 *
 * - 文件夹：资料（static/documents/，默认）、图片（static/images/）或 static/ 下的其他子文件夹
 *   （永远不能是 static/admin/）。地址 #/files?dir=static/xxx。
 * - 列表：递归列出文件夹里的全部文件（按子文件夹分组），显示名称、大小、网址（/documents/x.pdf），
 *   操作：复制链接 · 打开 · 删除（确认；会提示哪些文章引用了它）。可按名称搜索。
 *   PDF 的主要操作是「复制预览链接」：网站的在线阅读器 /viewer/?file=…（content.viewerUrlFor），
 *   安卓手机和微信内置浏览器打不开 PDF 文件本身（只能下载），阅读器页面能直接看；
 *   「打开」也打开阅读器；「复制文件链接」（文件本身的网址）作为次要操作保留。
 * - 上传：按钮 + 拖放（可多选）。提交前：
 *     压缩图片（勾选「压缩图片」时只处理 JPG / PNG）→ 大小检查（≥ 25 MB 提醒、≥ 95 MB 拒绝）
 *     → 同名文件（会被替换）、.gitignore 里的文件、HEIC 照片 → 合并成一个确认框 → 一次提交。
 *   文件名用 images.safeFileName（保留用户起的名字，不加时间戳）。每个文件显示自己的进度。
 *
 * 安全：界面全部用 h() / textContent 生成（§2 规则 3）；链接只由 ctx.siteUrl + 编码后的路径拼成。
 *
 * 额外导出 parseGitignore / createIgnoreMatcher（实现在 uploads.js）/ normalizeStaticDir 方便测试。
 * 不能上传的类型（.html / .svg / .js …，uploads.uploadBlockReason）在确认框里列为「不能上传」。
 *
 * @module views/files
 */

import { PATHS, LIMITS } from '../config.js';
import {
  h, svgIcon, render, clear, toast, modal, confirmDialog, withBusy, formatBytes, emptyState,
  errorMessage, debounce, copyText,
} from '../ui.js';
import { safeFileName, extOf } from '../images.js';
import { sitePathFor } from '../content.js';
import {
  MAX_BYTES, COMPRESSIBLE, isJunkFile, stemOf, baseNameOf, staticFileUrl as fullUrl, staticPreviewUrl as previewUrl, usesViewer,
  prepareUpload, assignUniqueNames, checkUploads, needsReview, gitignoreMatcher, uploadReviewSections, refusedContent,
  uploadBlockReason, deleteStaticFile,
} from '../uploads.js';

// 以前定义在这里，现在放在共用的 uploads.js（课程页和编辑器也用）；继续从这里导出，测试和旧代码不用改
export { parseGitignore, createIgnoreMatcher } from '../uploads.js';

// ---------------------------------------------------------------------------
// 常量

const MB = 1024 * 1024;

/** 预设文件夹（顺序即标签顺序）。 */
const PRESETS = [
  { key: 'documents', dir: PATHS.documents, label: '资料', icon: 'files' },
  { key: 'images', dir: PATHS.images, label: '图片', icon: 'image' },
];

const IMAGE_MIME = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp',
  svg: 'image/svg+xml', avif: 'image/avif', bmp: 'image/bmp', ico: 'image/x-icon',
};
const THUMB_MAX_BYTES = 3 * MB;

/** 扩展名 → 图标颜色类别 */
const TYPE_KIND = {
  pdf: 'pdf',
  doc: 'doc', docx: 'doc', rtf: 'doc', odt: 'doc', pages: 'doc', txt: 'doc', md: 'doc', tex: 'doc',
  ppt: 'ppt', pptx: 'ppt', key: 'ppt', odp: 'ppt',
  xls: 'xls', xlsx: 'xls', csv: 'xls', ods: 'xls', numbers: 'xls',
  zip: 'zip', rar: 'zip', '7z': 'zip', gz: 'zip', tar: 'zip', bz2: 'zip', xz: 'zip',
  mp4: 'media', mov: 'media', webm: 'media', mp3: 'media', wav: 'media', m4a: 'media', ogg: 'media',
};

const COMPRESS_PREF_KEY = 'admin.files.compress';

// ---------------------------------------------------------------------------
// 路径工具

/**
 * 把用户输入 / 地址参数里的文件夹规范成 'static/xxx'（不带结尾 /）。
 * 'slides' → 'static/slides'；'/static/documents/' → 'static/documents'。
 * @param {string} input
 * @returns {{ dir: string } | { error: string }}
 */
export function normalizeStaticDir(input) {
  let s = String(input ?? '').trim().normalize('NFC');
  if (!s) return { error: '请输入文件夹名' };
  if (s.includes('\\')) return { error: '文件夹名不能包含反斜杠 \\，请用 / 分隔' };
  s = s.replace(/\/{2,}/g, '/').replace(/^\/+|\/+$/g, '');
  if (s !== 'static' && !s.startsWith('static/')) s = 'static/' + s;
  const parts = s.split('/');
  if (parts.length < 2) return { error: '请选择 static/ 里面的一个文件夹' };
  for (const seg of parts.slice(1)) {
    if (!seg || seg === '.' || seg === '..') return { error: '文件夹名不能包含 . 或 .. 这样的路径' };
    if (seg.startsWith('.')) return { error: '文件夹名不能以 . 开头' };
    if (!/^[\p{L}\p{N}_.-]+$/u.test(seg)) return { error: '文件夹名只能包含文字、数字、- 和 _（不能有空格），多级用 / 分隔' };
    if (seg.length > 80) return { error: '文件夹名太长了' };
  }
  if (parts[1].toLowerCase() === 'admin') return { error: 'static/admin/ 是管理后台自己的文件夹，不能在这里上传文件' };
  return { dir: parts.join('/') };
}

function typeKind(ext) {
  if (IMAGE_MIME[ext] || ext === 'heic' || ext === 'heif') return 'image';
  return TYPE_KIND[ext] || 'other';
}

function readPref(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v == null ? fallback : v === '1';
  } catch { return fallback; }
}

function writePref(key, on) {
  try { localStorage.setItem(key, on ? '1' : '0'); } catch { /* 隐私模式等：忽略 */ }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// 视图

const STATUS_TEXT = {
  waiting: '等待中',
  compressing: '正在压缩…',
  ready: '准备上传',
  uploading: '正在上传…',
  done: '已上传',
  same: '和网站上的一样',
  skipped: '不上传',
  cancelled: '已取消',
  failed: '没有上传',
};

/**
 * @param {HTMLElement} container
 * @param {{ dir?: string }} params
 * @param {object} ctx
 */
export default async function mount(container, params, ctx) {
  const { repo } = ctx;
  ctx.setTitle('资料');
  container.classList.add('files-view', 'stack');

  // ---- 当前文件夹 ----
  let dir = PATHS.documents;
  if (params && params.dir) {
    const r = normalizeStaticDir(params.dir);
    if (r.error) toast(`不能打开这个文件夹：${r.error}`, { type: 'warning' });
    else dir = r.dir;
  }
  const preset = PRESETS.find((p) => p.dir === dir) || null;

  // ---- 状态 ----
  let disposed = false;
  let query = '';
  let compress = readPref(COMPRESS_PREF_KEY, true);
  /** 当前上传批次：{ dir, items: Item[], phase: 'preparing'|'confirm'|'publishing'|'done'|'cancelled'|'failed'|'conflict', banner? } */
  let batch = null;
  const thumbUrls = new Map(); // sha → objectURL
  const thumbQueue = [];
  let thumbActive = 0;
  let observer = null;

  // ---- 页面头部 ----
  const fileInput = h('input', {
    type: 'file', multiple: true, class: 'files-input', tabindex: '-1', 'aria-hidden': 'true',
    dataset: { testid: 'files-input' },
  });
  fileInput.addEventListener('change', () => {
    const list = [...(fileInput.files || [])];
    fileInput.value = ''; // 允许再次选择同一个文件（例如替换）
    if (list.length) startUpload(list);
  });
  const pickFiles = () => {
    if (isBusy()) { toast('上一批文件还没有处理完，请稍候', { type: 'warning' }); return; }
    fileInput.click();
  };

  const header = h('div', { class: 'page-header' },
    h('div', { class: 'files-heading' },
      h('h1', {}, '资料'),
      h('p', { class: 'page-desc' }, '上传 PDF、课件、图片等文件，得到一个可以分享或写进文章的网址。'),
      h('p', { class: 'page-desc files-viewer-note', dataset: { testid: 'files-viewer-note' } },
        svgIcon('info', { size: 14 }),
        h('span', {}, 'PDF 会在网页里直接打开（安卓手机和微信里也能看），页面上带「下载」按钮；用「复制预览链接」分享。'))));

  // ---- 文件夹选择 ----
  const folderTabs = h('div', { class: 'tabs tabs-pill files-folders', role: 'tablist', 'aria-label': '选择文件夹' },
    PRESETS.map((p) => h('button', {
      type: 'button', role: 'tab', class: ['tab', p.dir === dir && 'active'],
      'aria-selected': p.dir === dir ? 'true' : 'false',
      dataset: { testid: `files-folder-${p.key}` },
      on: { click: () => goDir(p.dir) },
    }, svgIcon(p.icon), p.label)),
    !preset ? h('button', {
      type: 'button', role: 'tab', class: 'tab active', 'aria-selected': 'true',
      dataset: { testid: 'files-folder-custom' }, title: dir + '/',
    }, svgIcon('folder'), h('span', { class: 'files-folder-custom-name' }, dir.slice('static/'.length))) : null,
    h('button', {
      type: 'button', class: 'tab files-folder-other', dataset: { testid: 'files-folder-other' },
      on: { click: () => chooseFolder() },
    }, preset ? '其他文件夹…' : '换一个…'));

  const folderInfo = h('div', { class: 'files-folder-info muted small', dataset: { testid: 'files-folder-info' } },
    svgIcon('link', { size: 14 }),
    h('span', {}, '网址形如'),
    h('code', { class: 'files-code' }, sitePathFor(dir) + '/文件名'),
    h('span', { class: 'hide-mobile' }, '· 保存在仓库的'),
    h('code', { class: 'files-code hide-mobile' }, dir + '/'));

  // ---- 上传区 ----
  const compressBox = h('input', {
    type: 'checkbox', checked: compress, dataset: { testid: 'files-compress' },
  });
  compressBox.addEventListener('change', () => {
    compress = compressBox.checked;
    writePref(COMPRESS_PREF_KEY, compress);
  });

  const dropzone = h('div', { class: 'dropzone files-dropzone', dataset: { testid: 'files-dropzone' } },
    h('div', { class: 'files-drop-icon' }, svgIcon('upload')),
    h('div', { class: 'files-drop-text' },
      h('div', { class: 'files-drop-title' },
        h('span', { class: 'hide-mobile' }, '把文件拖到这里上传'),
        h('span', { class: 'show-mobile' }, '上传文件到这个文件夹')),
      h('div', { class: 'files-drop-hint' },
        `可以一次选多个文件。单个文件建议小于 ${LIMITS.warnFileMB} MB，最大 ${LIMITS.maxFileMB} MB。出于安全考虑不能上传网页、脚本和 SVG 文件。`)),
    h('button', {
      type: 'button', class: 'btn btn-primary files-choose', dataset: { testid: 'files-choose' }, on: { click: pickFiles },
    }, svgIcon('upload'), '选择文件'),
    fileInput);
  dropzone.addEventListener('click', (e) => {
    // 点空白处也能选文件（按钮自己会处理）
    if (e.target === dropzone || e.target.closest('.files-drop-icon, .files-drop-text')) pickFiles();
  });

  const uploadCard = h('section', { class: 'card files-upload-card', 'aria-label': '上传文件' },
    dropzone,
    h('div', { class: 'files-options' },
      h('label', { class: 'checkbox' }, compressBox, '压缩图片'),
      h('span', { class: 'muted small' },
        `JPG / PNG 会缩小到最宽 ${LIMITS.imageMaxWidth} 像素（不透明的 PNG 可能转成 JPG）；PDF 等其他文件原样上传。`)));

  // ---- 上传进度 ----
  const batchCard = h('section', { class: 'card files-batch', dataset: { testid: 'files-batch' }, 'aria-live': 'polite' });
  batchCard.hidden = true;

  // ---- 文件列表 ----
  const searchInput = h('input', {
    type: 'search', class: 'input', placeholder: '搜索文件名', 'aria-label': '搜索文件名',
    autocomplete: 'off', dataset: { testid: 'files-search' },
  });
  const applySearch = debounce(() => { query = searchInput.value.trim().toLowerCase(); renderList(); }, 120);
  searchInput.addEventListener('input', applySearch);
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && searchInput.value) { e.preventDefault(); searchInput.value = ''; applySearch(); applySearch.flush(); }
  });

  const countEl = h('div', { class: 'files-count muted small', dataset: { testid: 'files-count' } });
  const listHost = h('div', { class: 'files-list-host' });
  const listCard = h('section', { class: 'card files-list-card', 'aria-label': '文件列表' },
    h('div', { class: 'card-header files-list-header' },
      h('div', { class: 'files-list-title' },
        h('h2', { class: 'card-title' }, '文件'),
        countEl),
      h('label', { class: 'files-search' }, svgIcon('search'), searchInput)),
    listHost);

  render(container, header, h('div', { class: 'files-toolbar stack-sm' }, folderTabs, folderInfo), uploadCard, batchCard, listCard);

  // ---- 拖放：整个视图都可以放；视图外放下时阻止浏览器直接打开文件 ----
  let dragDepth = 0;
  const hasFiles = (e) => !!e.dataTransfer && [...(e.dataTransfer.types || [])].includes('Files');
  const onDragEnter = (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth++;
    dropzone.classList.add('is-over');
  };
  const onDragOver = (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = isBusy() ? 'none' : 'copy';
  };
  const onDragLeave = (e) => {
    if (!hasFiles(e)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) dropzone.classList.remove('is-over');
  };
  const onDrop = (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.stopPropagation();
    dragDepth = 0;
    dropzone.classList.remove('is-over');
    const dt = e.dataTransfer;
    // 文件夹：浏览器会给一个大小为 0 / 4096 的「文件」，读不了内容 → 跳过并提示
    const dirNames = new Set();
    for (const item of [...(dt.items || [])]) {
      try {
        const entry = item.kind === 'file' && item.webkitGetAsEntry ? item.webkitGetAsEntry() : null;
        if (entry && entry.isDirectory) dirNames.add(entry.name);
      } catch { /* ignore */ }
    }
    const files = [...(dt.files || [])].filter((f) => !dirNames.has(f.name));
    if (dirNames.size) toast('暂不支持直接上传文件夹，请打开文件夹后选中里面的文件', { type: 'warning', timeout: 6000 });
    if (files.length) {
      if (isBusy()) { toast('上一批文件还没有处理完，请稍候', { type: 'warning' }); return; }
      startUpload(files);
    }
  };
  const blockWindowDrop = (e) => { if (hasFiles(e)) e.preventDefault(); };
  container.addEventListener('dragenter', onDragEnter);
  container.addEventListener('dragover', onDragOver);
  container.addEventListener('dragleave', onDragLeave);
  container.addEventListener('drop', onDrop);
  window.addEventListener('dragover', blockWindowDrop);
  window.addEventListener('drop', blockWindowDrop);

  const unsubscribe = repo.onChange(() => { if (!disposed) renderList(); });

  renderList();

  // -------------------------------------------------------------------------
  // 文件夹

  function goDir(target) {
    if (target === dir) return;
    ctx.navigate(target === PATHS.documents ? '#/files' : '#/files?dir=' + encodeURIComponent(target), { replace: true });
  }

  /** static/ 下已有的文件夹（含子文件夹，最多 3 层），不含 static/admin。 */
  function existingFolders() {
    const counts = new Map();
    for (const e of repo.list('static/')) {
      const parts = e.path.split('/');
      if (parts.length < 3 || parts[1] === 'admin') continue;
      for (let depth = 2; depth <= Math.min(parts.length - 1, 4); depth++) {
        const d = parts.slice(0, depth).join('/');
        counts.set(d, (counts.get(d) || 0) + 1);
      }
    }
    return [...counts.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([d, n]) => ({ dir: d, count: n }));
  }

  function chooseFolder() {
    const folders = existingFolders();
    const input = h('input', {
      class: 'input', type: 'text', placeholder: '例如 slides 或 files/2026', autocomplete: 'off',
      'aria-label': '新文件夹名', dataset: { testid: 'files-folder-input' },
    });
    const error = h('div', { class: 'error', role: 'alert', dataset: { testid: 'files-folder-error' } });
    error.hidden = true;
    let m = null;
    const open = (target) => { m.close(); goDir(target); };
    const submit = () => {
      const r = normalizeStaticDir(input.value);
      if (r.error) { error.textContent = r.error; error.hidden = false; input.setAttribute('aria-invalid', 'true'); return; }
      if (repo.has(r.dir)) {
        error.textContent = `已经有一个叫 ${r.dir} 的文件（不是文件夹），请换个名字`;
        error.hidden = false;
        return;
      }
      open(r.dir);
    };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); submit(); } });
    input.addEventListener('input', () => { error.hidden = true; input.removeAttribute('aria-invalid'); });

    const list = folders.length
      ? h('ul', { class: 'files-folder-list' }, folders.map((f) => h('li', {},
        h('button', {
          type: 'button', class: ['files-folder-option', f.dir === dir && 'is-current'],
          dataset: { testid: 'files-folder-option', dir: f.dir },
          on: { click: () => open(f.dir) },
        },
          svgIcon('folder'),
          h('span', { class: 'files-folder-option-name' }, f.dir.slice('static/'.length) + '/'),
          h('span', { class: 'muted small' }, `${f.count} 个文件`)))))
      : h('p', { class: 'muted' }, 'static/ 里还没有其他文件夹。');

    m = modal({
      title: '选择文件夹',
      content: h('div', { class: 'stack files-folder-modal' },
        h('div', { class: 'stack-sm' },
          h('div', { class: 'files-modal-label' }, '已有的文件夹'),
          list),
        h('div', { class: 'field' },
          h('label', {}, '或者新建一个文件夹'),
          h('div', { class: 'input-group' },
            h('span', { class: 'files-prefix mono' }, 'static/'),
            input,
            h('button', { type: 'button', class: 'btn btn-primary', dataset: { testid: 'files-folder-go' }, on: { click: submit } }, '打开')),
          h('div', { class: 'hint' }, '新文件夹在上传第一个文件后才会真正创建。管理后台自己的 admin/ 文件夹不能用。'),
          error)),
      actions: [],
    });
  }

  // -------------------------------------------------------------------------
  // 文件列表

  function currentFiles() {
    return repo.list(dir + '/');
  }

  function renderList() {
    if (disposed) return;
    const all = currentFiles();
    const total = all.reduce((s, e) => s + (e.size || 0), 0);
    countEl.textContent = all.length ? `共 ${all.length} 个文件 · ${formatBytes(total)}` : '';

    const shown = query
      ? all.filter((e) => e.path.slice(dir.length + 1).toLowerCase().includes(query))
      : all;

    if (observer) observer.disconnect();
    thumbQueue.length = 0;

    if (!all.length) {
      render(listHost, h('div', { dataset: { testid: 'files-empty' } },
        emptyState(
          preset && preset.key === 'documents'
            ? '这里还没有资料。把 PDF、课件等文件拖到上面就能上传。'
            : '这个文件夹里还没有文件。上传第一个文件时会自动创建它。',
          null,
          { icon: preset && preset.key === 'images' ? 'image' : 'files' })));
      return;
    }
    if (!shown.length) {
      render(listHost, h('div', { dataset: { testid: 'files-empty' } },
        emptyState(`没有找到名字里包含「${searchInput.value.trim()}」的文件`, null, { icon: 'search' })));
      return;
    }

    // 按子文件夹分组（文件夹本身的文件排在最前）
    const groups = new Map();
    for (const e of shown) {
      const rel = e.path.slice(dir.length + 1);
      const i = rel.lastIndexOf('/');
      const sub = i >= 0 ? rel.slice(0, i) : '';
      if (!groups.has(sub)) groups.set(sub, []);
      groups.get(sub).push(e);
    }
    const subs = [...groups.keys()].sort((a, b) => (a === '' ? -1 : b === '' ? 1 : a < b ? -1 : a > b ? 1 : 0));
    const showHeaders = subs.length > 1 || (subs.length === 1 && subs[0] !== '');

    observer = typeof IntersectionObserver === 'function'
      ? new IntersectionObserver((entries) => {
        for (const en of entries) {
          if (!en.isIntersecting) continue;
          observer.unobserve(en.target);
          queueThumb(en.target);
        }
      }, { rootMargin: '200px' })
      : null;

    const ul = h('ul', { class: 'list files-list', dataset: { testid: 'files-list' } });
    for (const sub of subs) {
      const items = groups.get(sub);
      if (showHeaders) {
        ul.appendChild(h('li', { class: 'files-group', dataset: { testid: 'files-group' } },
          svgIcon('folder', { size: 14 }),
          h('span', { class: 'files-group-name' }, sub ? sub + '/' : '（直接放在这个文件夹里）'),
          h('span', { class: 'muted' }, `${items.length} 个`)));
      }
      for (const e of items) ul.appendChild(fileRow(e));
    }
    render(listHost, ul);
  }

  function fileRow(e) {
    const name = baseNameOf(e.path);
    const ext = extOf(name);
    const kind = typeKind(ext);
    const sitePath = sitePathFor(e.path);
    const url = fullUrl(ctx.siteUrl, e.path);
    const viewer = usesViewer(e.path);
    const openUrl = viewer ? previewUrl(ctx.siteUrl, e.path) : url;

    const thumb = h('div', { class: ['files-thumb', `files-type-${kind}`], 'aria-hidden': 'true' },
      kind === 'image' ? svgIcon('image') : h('span', { class: 'files-ext' }, (ext || '文件').slice(0, 4).toUpperCase()));
    if (IMAGE_MIME[ext] && e.size <= THUMB_MAX_BYTES) {
      thumb.dataset.path = e.path;
      thumb.dataset.sha = e.sha;
      thumb.dataset.mime = IMAGE_MIME[ext];
      if (thumbUrls.has(e.sha)) setThumb(thumb, thumbUrls.get(e.sha));
      else if (observer) observer.observe(thumb);
      else queueThumb(thumb);
    }

    // PDF：「复制预览链接」（在线阅读器）是主要操作，文件本身的链接是次要的
    const previewBtn = viewer ? h('button', {
      type: 'button', class: 'btn btn-ghost btn-primary btn-sm',
      title: '复制在线预览的网址：点开直接在网页里看（安卓手机和微信里也能看），页面上可以下载',
      'aria-label': `复制「${name}」的预览链接`,
      dataset: { testid: 'files-copy-preview' },
    }, svgIcon('eye'), h('span', { class: 'files-action-label' }, '复制预览链接')) : null;
    if (previewBtn) previewBtn.addEventListener('click', () => copyLink(e.path, { preview: true }));

    const copyBtn = h('button', {
      type: 'button', class: ['btn btn-ghost btn-sm', viewer && 'files-copy-secondary'],
      title: viewer ? '复制文件本身的网址（安卓手机和微信里点开通常只能下载）' : '复制完整网址',
      'aria-label': viewer ? `复制「${name}」的文件链接` : `复制「${name}」的链接`,
      dataset: { testid: 'files-copy' },
    }, svgIcon('link'), h('span', { class: 'files-action-label' }, viewer ? '复制文件链接' : '复制链接'));
    copyBtn.addEventListener('click', () => copyLink(e.path));

    const openLink = h('a', {
      class: 'btn btn-ghost btn-sm', href: openUrl, target: '_blank', rel: 'noopener noreferrer',
      title: viewer
        ? '在网站的在线阅读器里打开（刚上传的文件需要等部署完成，约 1–2 分钟）'
        : '在网站上打开（刚上传的文件需要等部署完成，约 1–2 分钟）',
      'aria-label': viewer ? `在线预览「${name}」` : `在网站上打开「${name}」`,
      dataset: { testid: 'files-open' },
    }, svgIcon('external'), h('span', { class: 'files-action-label' }, '打开'));

    const delBtn = h('button', {
      type: 'button', class: 'btn btn-ghost btn-danger btn-sm', 'aria-label': `删除「${name}」`, title: '删除',
      dataset: { testid: 'files-delete' },
    }, svgIcon('trash'), h('span', { class: 'files-action-label' }, '删除'));
    delBtn.addEventListener('click', () => withBusy(delBtn, () => deleteFile(e)).catch(() => {}));

    // 手机：一个「⋯」按钮打开底部操作面板（名字和网址就有足够的宽度显示）
    const moreBtn = h('button', {
      type: 'button', class: 'btn btn-ghost btn-sm btn-icon show-mobile', 'aria-label': `「${name}」的操作`,
      dataset: { testid: 'files-more' },
    }, svgIcon('more'));
    moreBtn.addEventListener('click', () => actionSheet(e, moreBtn));

    return h('li', { class: 'list-item files-row', dataset: { testid: 'files-row', path: e.path } },
      thumb,
      h('div', { class: 'list-item-main' },
        h('div', { class: 'list-item-title files-name', title: name, dataset: { testid: 'files-name' } }, name),
        h('div', { class: 'list-item-meta' },
          h('span', { class: 'files-size' }, formatBytes(e.size)),
          h('code', { class: 'files-link', title: url, dataset: { testid: 'files-link' } }, sitePath))),
      h('div', { class: 'list-item-actions' },
        h('div', { class: 'files-actions hide-mobile' }, previewBtn, copyBtn, openLink, delBtn),
        moreBtn));
  }

  /** 手机上的操作面板（底部抽屉样式的 modal）。 */
  function actionSheet(e, anchor) {
    const name = baseNameOf(e.path);
    const viewer = usesViewer(e.path);
    const url = viewer ? previewUrl(ctx.siteUrl, e.path) : fullUrl(ctx.siteUrl, e.path);
    let m = null;
    const item = (icon, text, testid, onClick, extra = {}) => h(extra.href ? 'a' : 'button', {
      type: extra.href ? undefined : 'button',
      class: ['files-sheet-item', extra.danger && 'is-danger'],
      href: extra.href, target: extra.href ? '_blank' : undefined, rel: extra.href ? 'noopener noreferrer' : undefined,
      dataset: { testid },
      on: { click: onClick },
    }, svgIcon(icon), h('span', {}, text));
    m = modal({
      title: name,
      className: 'files-sheet',
      content: h('div', { class: 'stack-sm' },
        h('div', { class: 'files-sheet-meta muted small' },
          h('span', {}, formatBytes(e.size)),
          h('code', { class: 'files-code' }, sitePathFor(e.path))),
        viewer ? h('p', { class: 'files-sheet-note muted small' }, '预览链接在网页里直接打开 PDF，安卓手机和微信里也能看。') : null,
        h('div', { class: 'files-sheet-list' },
          viewer ? item('eye', '复制预览链接', 'files-sheet-copy-preview', () => { m.close(); copyLink(e.path, { preview: true }); }) : null,
          item('link', viewer ? '复制文件链接' : '复制链接', 'files-sheet-copy', () => { m.close(); copyLink(e.path); }),
          item('external', viewer ? '在线预览' : '在网站上打开', 'files-sheet-open', () => { m.close(); }, { href: url }),
          item('trash', '删除', 'files-sheet-delete', () => {
            m.close();
            withBusy(anchor, () => deleteFile(e)).catch(() => {});
          }, { danger: true }))),
      actions: [],
    });
  }

  // ---- 缩略图（从仓库读字节，所以刚上传、还没部署的图片也能显示） ----

  function setThumb(el, url) {
    clear(el);
    el.classList.add('has-img');
    el.appendChild(h('img', { src: url, alt: '', loading: 'lazy', decoding: 'async' }));
  }

  function queueThumb(el) {
    thumbQueue.push(el);
    pumpThumbs();
  }

  function pumpThumbs() {
    while (!disposed && thumbActive < 4 && thumbQueue.length) {
      const el = thumbQueue.shift();
      if (!el.isConnected) continue;
      const { path, sha, mime } = el.dataset;
      if (thumbUrls.has(sha)) { setThumb(el, thumbUrls.get(sha)); continue; }
      thumbActive++;
      repo.readBytes(path)
        .then((bytes) => {
          if (disposed) return;
          const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
          thumbUrls.set(sha, url);
          if (el.isConnected) setThumb(el, url);
        })
        .catch(() => { /* 读不到就保持图标 */ })
        .finally(() => { thumbActive--; pumpThumbs(); });
    }
  }

  // ---- 复制 / 删除 ----

  async function copyLink(path, { preview = false } = {}) {
    const url = preview ? previewUrl(ctx.siteUrl, path) : fullUrl(ctx.siteUrl, path);
    try {
      await copyText(url);
      toast(preview ? `已复制预览链接：${url}` : `已复制链接：${url}`, { type: 'success' });
    } catch (err) {
      toast(`${errorMessage(err)}：${url}`, { type: 'error', timeout: 9000 });
    }
  }

  async function deleteFile(e) {
    // 确认框（列出引用了它的文章 / 页面）+ 一次提交；共用 uploads.deleteStaticFile（课程页也用）
    await deleteStaticFile(ctx, e, { isDisposed: () => disposed });
  }

  // -------------------------------------------------------------------------
  // 上传

  function isBusy() {
    return !!batch && (batch.phase === 'preparing' || batch.phase === 'confirm' || batch.phase === 'publishing');
  }

  function hasUnfinished() {
    return !!batch && (isBusy() || batch.phase === 'failed' || batch.phase === 'conflict');
  }

  /**
   * 开始一批上传。
   * @param {File[]} rawFiles
   */
  async function startUpload(rawFiles) {
    if (isBusy()) { toast('上一批文件还没有处理完，请稍候', { type: 'warning' }); return; }
    const files = rawFiles.filter((f) => !isJunkFile(f.name));
    if (!files.length) return;
    batch = {
      dir,
      phase: 'preparing',
      banner: null,
      items: files.map((file) => ({
        file,
        origName: file.name,
        name: safeFileName(file.name),
        blob: file,
        origSize: file.size,
        size: file.size,
        status: 'waiting',
        note: '',
        path: '',
        existing: null,
        compressed: false,
      })),
    };
    renderBatch();

    // 1) 压缩图片（只处理 JPG / PNG）；不允许上传的类型（.html / .svg …）不处理，下面统一拒绝
    for (const it of batch.items) {
      if (disposed) return;
      if (compress && !uploadBlockReason(it.origName, it.name) && COMPRESSIBLE.has(extOf(it.name)) && it.file.size < MAX_BYTES) {
        it.status = 'compressing';
        renderBatch();
        const r = await prepareUpload(it.file, it.name, { compress });
        Object.assign(it, { blob: r.blob, name: r.name, size: r.size, compressed: r.compressed, note: r.note });
      }
      it.status = 'ready';
      renderBatch();
    }
    if (disposed) return;
    await reviewAndPublish();
  }

  /** 检查 → 确认 → 提交。重试时（冲突 / 失败之后）也从这里开始。 */
  async function reviewAndPublish() {
    if (!batch || disposed) return;
    batch.phase = 'confirm';
    batch.banner = null;
    const bdir = batch.dir;

    // 2) 最终文件名：同一批里重名的自动加 -2、-3
    const pending = batch.items.filter((it) => !(it.status === 'skipped' || it.status === 'done' || it.status === 'same'));
    for (const it of assignUniqueNames(pending)) {
      it.note = [it.note, '和同一批里的文件重名，已自动改名'].filter(Boolean).join('；');
    }
    for (const it of pending) {
      it.path = `${bdir}/${it.name}`;
      it.status = 'ready';
    }

    // 3) 不能上传的类型、大小检查、同名文件夹、.gitignore、替换、HEIC
    const ignore = await gitignoreMatcher(repo);
    if (disposed || !batch) return;
    const review = checkUploads(repo, pending, ignore);
    const { refused, ready } = review;
    for (const it of refused) it.status = 'skipped';
    renderBatch();

    if (!ready.length) {
      batch.phase = 'cancelled';
      batch.banner = { kind: 'error', text: '没有可以上传的文件。' };
      renderBatch();
      await alertDialog('无法上传', refusedContent(refused));
      return;
    }

    if (needsReview(review)) {
      const ok = await confirmDialog({
        title: review.ignored.length ? '确定要上传吗？' : '上传前请确认',
        message: h('div', { class: 'stack-sm files-confirm', dataset: { testid: 'files-review' } },
          uploadReviewSections(review),
          h('p', { class: 'muted small' }, `将上传 ${ready.length} 个文件到 ${batch.dir}/。`)),
        okText: review.ignored.length || review.large.length ? '仍然上传' : review.overwrite.length ? '替换并上传' : '继续上传',
        danger: review.ignored.length > 0,
      });
      if (disposed) return;
      if (!ok) {
        for (const it of ready) { it.status = 'cancelled'; }
        batch.phase = 'cancelled';
        batch.banner = { kind: 'info', text: '已取消，没有上传任何文件。' };
        renderBatch();
        return;
      }
    }

    // 4) 提交（一次提交）
    if (ctx.isPublishing && ctx.isPublishing()) {
      // 极少见：别的地方正在发布 → 等它结束
      for (let i = 0; i < 600 && ctx.isPublishing(); i++) await sleep(100);
    }
    if (disposed) return;
    batch.phase = 'publishing';
    for (const it of ready) it.status = 'uploading';
    renderBatch();

    const first = ready[0].name;
    const message = ready.length === 1 ? `admin: 上传资料 ${first}` : `admin: 上传资料 ${first} 等 ${ready.length} 个文件`;
    const changes = ready.map((it) => ({ path: it.path, content: it.blob, baseSha: it.existing ? it.existing.sha : null }));
    const summary = ready.map((it) => `${it.existing ? '替换' : '上传'} ${it.path}（${formatBytes(it.size)}）`);

    let res;
    try {
      res = await ctx.publish({ message, changes, summary });
    } catch (err) {
      if (!batch) return;
      for (const it of ready) { it.status = 'failed'; }
      batch.phase = 'failed';
      batch.banner = { kind: 'error', text: `上传失败：${errorMessage(err)}`, retry: true };
      renderBatch();
      return;
    }
    if (!batch) return;
    if (res && res.conflict) {
      for (const it of ready) { it.status = 'ready'; }
      batch.phase = 'conflict';
      batch.needsReload = !res.reloaded;
      batch.banner = {
        kind: 'warning',
        text: res.reloaded
          ? '网站上的文件刚刚有变化，这次没有上传。文件列表已经更新，点「重新上传」再试一次。'
          : '网站上的文件刚刚有变化，这次没有上传。点「重新上传」会先读取最新版本再试。',
        retry: true,
      };
      renderBatch();
      return;
    }
    const shas = (res && res.shas) || {};
    for (const it of ready) {
      it.status = res && res.unchanged ? 'same' : 'done';
      if (shas[it.path]) it.sha = shas[it.path];
    }
    batch.phase = 'done';
    batch.banner = {
      kind: 'success',
      text: res && res.unchanged
        ? '这些文件和网站上的完全一样，不需要上传。'
        : `已上传 ${ready.length} 个文件。网站部署完成后（约 1–2 分钟）就能通过链接打开。`,
    };
    renderBatch();
  }

  async function retryUpload() {
    if (!batch || isBusy()) return;
    if (batch.needsReload) {
      try { await repo.load(); } catch (err) { toast(`读取最新版本失败：${errorMessage(err)}`, { type: 'error' }); return; }
      batch.needsReload = false;
    }
    for (const it of batch.items) if (it.status === 'failed' || it.status === 'cancelled') it.status = 'ready';
    await reviewAndPublish();
  }

  function alertDialog(title, content) {
    return new Promise((resolve) => {
      modal({
        title,
        content,
        actions: [{ text: '知道了', kind: 'primary', testid: 'confirm-ok', autofocus: true }],
        onClose: resolve,
      });
    });
  }

  function renderBatch() {
    if (disposed) return;
    if (!batch) { batchCard.hidden = true; clear(batchCard); return; }
    batchCard.hidden = false;
    batchCard.dataset.phase = batch.phase;
    const busy = isBusy();
    const counts = batch.items.reduce((m, it) => { m[it.status] = (m[it.status] || 0) + 1; return m; }, {});
    const title = busy
      ? `正在上传到 ${batch.dir}/`
      : batch.phase === 'done' ? '上传完成' : '本次上传';

    const closeBtn = !busy
      ? h('button', {
        type: 'button', class: 'btn btn-ghost btn-sm btn-icon', 'aria-label': '关闭上传记录', title: '关闭',
        dataset: { testid: 'files-batch-close' },
        on: { click: () => { batch = null; renderBatch(); } },
      }, svgIcon('close'))
      : null;

    let bannerEl = null;
    if (batch.banner) {
      const b = batch.banner;
      const icon = b.kind === 'success' ? 'check' : b.kind === 'info' ? 'info' : 'warning';
      const retryBtn = b.retry ? h('button', {
        type: 'button', class: 'btn btn-sm btn-primary', dataset: { testid: 'files-retry' },
      }, svgIcon('refresh'), '重新上传') : null;
      if (retryBtn) retryBtn.addEventListener('click', () => withBusy(retryBtn, retryUpload));
      bannerEl = h('div', { class: ['banner', `banner-${b.kind}`], dataset: { testid: 'files-batch-banner', kind: b.kind } },
        svgIcon(icon), h('span', {}, b.text),
        retryBtn ? h('div', { class: 'banner-actions' }, retryBtn) : null);
    }

    const rows = batch.items.map((it) => {
      const kind = typeKind(extOf(it.name));
      const st = it.status;
      const done = st === 'done' || st === 'same';
      const statusEl = h('span', { class: ['files-status', `is-${st}`], dataset: { testid: 'files-batch-status' } },
        st === 'compressing' || st === 'uploading' ? h('span', { class: 'spinner spinner-sm', 'aria-hidden': 'true' }) : null,
        done ? svgIcon('check', { size: 14 }) : null,
        STATUS_TEXT[st] || st);
      const viewer = done && it.path && usesViewer(it.path);
      const copy = done && it.path ? h('button', {
        type: 'button', class: ['btn btn-ghost btn-sm', viewer && 'btn-primary'], dataset: { testid: 'files-batch-copy' },
        'aria-label': viewer ? `复制「${it.name}」的预览链接` : `复制「${it.name}」的链接`,
        title: viewer ? '复制在线预览的网址（安卓手机和微信里也能看）' : undefined,
        on: { click: () => copyLink(it.path, { preview: !!viewer }) },
      }, svgIcon(viewer ? 'eye' : 'link'), h('span', { class: 'files-action-label' }, viewer ? '复制预览链接' : '复制链接')) : null;
      return h('li', { class: 'files-batch-item', dataset: { testid: 'files-batch-item', status: st, name: it.name } },
        h('div', { class: ['files-thumb', 'files-thumb-sm', `files-type-${kind}`], 'aria-hidden': 'true' },
          kind === 'image' ? svgIcon('image') : h('span', { class: 'files-ext' }, (extOf(it.name) || '文件').slice(0, 4).toUpperCase())),
        h('div', { class: 'files-batch-main' },
          h('div', { class: 'files-batch-name truncate', title: it.path || it.name },
            it.name,
            it.name !== it.origName ? h('span', { class: 'muted small' }, `（原名 ${it.origName}）`) : null),
          h('div', { class: 'files-batch-meta muted small' },
            h('span', {}, it.compressed ? `${formatBytes(it.origSize)} → ${formatBytes(it.size)}` : formatBytes(it.size)),
            it.note && !(it.compressed && /^已压缩/.test(it.note)) ? h('span', {}, it.note) : null,
            done && it.path ? h('code', { class: 'files-link' }, sitePathFor(it.path)) : null)),
        h('div', { class: 'files-batch-side' }, statusEl, copy));
    });

    const summaryText = busy
      ? `${batch.items.length} 个文件` + (counts.compressing ? ' · 正在压缩图片' : batch.phase === 'publishing' ? ' · 正在提交到 GitHub' : '')
      : '';

    render(batchCard,
      h('div', { class: 'card-header' },
        h('div', { class: 'files-list-title' },
          h('h2', { class: 'card-title' }, title),
          summaryText ? h('span', { class: 'muted small' }, summaryText) : null),
        closeBtn),
      bannerEl,
      h('ul', { class: 'files-batch-list' }, rows));
  }

  // -------------------------------------------------------------------------

  return {
    isDirty: () => hasUnfinished(),
    async canLeave() {
      if (!hasUnfinished()) return true;
      if (batch.phase === 'publishing') {
        toast('正在上传，请等它完成', { type: 'warning' });
        return false;
      }
      return confirmDialog({
        title: '离开这个页面？',
        message: '还有文件没有上传成功。离开后需要重新选择这些文件。',
        okText: '离开',
        cancelText: '留下',
      });
    },
    unmount() {
      disposed = true;
      applySearch.cancel();
      unsubscribe && unsubscribe();
      if (observer) observer.disconnect();
      thumbQueue.length = 0;
      window.removeEventListener('dragover', blockWindowDrop);
      window.removeEventListener('drop', blockWindowDrop);
      for (const url of thumbUrls.values()) {
        try { URL.revokeObjectURL(url); } catch { /* ignore */ }
      }
      thumbUrls.clear();
      batch = null;
    },
  };
}
