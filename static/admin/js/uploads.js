/**
 * uploads.js — 往 static/ 上传文件的共用逻辑（「资料」页、「课程」页的资料 / 批量上传、编辑器的「资料」按钮和图片）。
 *
 * - 安全：拒绝会在本站执行脚本的文件类型（uploadBlockReason）。static/ 里的文件和管理后台同源，
 *   一个 .html / .svg 被直接打开时，里面的脚本能读到后台「记住」的登录令牌（docs/admin-architecture.md 第 4 节）。
 * - .gitignore 匹配（parseGitignore / createIgnoreMatcher）：上传 .gitignore 里的文件前提醒。
 * - 图片压缩（prepareUpload）、同一批重名自动改名（assignUniqueNames）、上传前检查（checkUploads）
 *   和确认框内容（uploadReviewContent），网址（staticFileUrl / staticPreviewUrl / usesViewer），
 *   删除前找出引用了文件的页面（findReferences）。
 *
 * 纯函数部分不访问 DOM，可以在 Node 里导入测试；uploadReviewContent 只在调用时用 ui.h()。
 *
 * @module uploads
 */

import { PATHS, LIMITS } from './config.js';
import { h, svgIcon, formatBytes, toast, confirmDialog } from './ui.js';
import { extOf, compressImage } from './images.js';
import { sitePathFor, viewerUrlFor, isPdfPath, referencesSitePath } from './content.js';

export const MB = 1024 * 1024;
export const WARN_BYTES = LIMITS.warnFileMB * MB;
export const MAX_BYTES = LIMITS.maxFileMB * MB;

// ---------------------------------------------------------------------------
// 不允许上传的文件类型

/**
 * 浏览器直接打开时会执行脚本（或者能装进可执行的 XHTML / SVG）的扩展名。
 * GitHub Pages 按扩展名给出 Content-Type（.html → text/html、.svg → image/svg+xml、.xml → application/xml …），
 * 这些类型的页面里的脚本会以 himzfx.github.io 的身份运行。
 */
export const BLOCKED_UPLOAD_EXTS = Object.freeze([
  'html', 'htm', 'xhtml', 'xht', 'shtml', 'xml', 'xsl', 'xslt', 'svg', 'svgz', 'js', 'mjs',
]);
const BLOCKED = new Set(BLOCKED_UPLOAD_EXTS);

/** 统一的说明（显示在确认框 / 提示里）。 */
export const BLOCKED_UPLOAD_EXPLAIN =
  '出于安全考虑，管理后台不能上传网页、脚本和 SVG 文件（.html、.htm、.xhtml、.shtml、.xml、.svg、.js、.mjs 等）：' +
  '它们放在网站上被直接打开时，里面的代码会以本站的身份运行，可能读取到这台设备上记住的管理后台登录令牌。' +
  'SVG 图片请先转换成 PNG 再上传；网页或文档请导出成 PDF 再上传。';

/**
 * 这个文件名能不能上传到 static/。检查最终文件名（safeFileName 之后）和原始文件名两者，扩展名不区分大小写。
 * @param {...string} names 原始文件名、处理后的文件名……
 * @returns {null | { ext: string, svg: boolean, note: string }} null = 可以上传
 * @example uploadBlockReason('图.SVG')  // { ext: 'svg', svg: true, note: '…请先转换成 PNG 再上传' }
 */
export function uploadBlockReason(...names) {
  for (const n of names) {
    const name = String(n ?? '');
    // extOf 只认 1–10 位字母数字的扩展名；结尾的空白 / 点之类在 safeFileName 里会被去掉，这里也按去掉后的看
    const ext = extOf(name.replace(/[\s.\u200b-\u200f\ufeff]+$/u, ''));
    if (!BLOCKED.has(ext)) continue;
    const svg = ext === 'svg' || ext === 'svgz';
    return {
      ext,
      svg,
      note: svg
        ? '出于安全考虑不能上传 SVG 图片（里面可以藏脚本），请先转换成 PNG 再上传'
        : `出于安全考虑不能上传 .${ext} 文件（网页 / 脚本会以本站身份运行），请导出成 PDF 再上传`,
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// .gitignore 匹配（只实现常用写法：精确路径、* / ** / ? / [abc] 通配、结尾 / 表示文件夹、# 注释、! 取反）

/**
 * 把一条 gitignore 通配写法转成正则（不含开头的 / 和结尾的 /）。
 * @param {string} glob
 * @returns {string} 正则源码（不含 ^$）
 */
function globToRegexSource(glob) {
  let out = '';
  let i = 0;
  while (i < glob.length) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        const atStart = i === 0 || glob[i - 1] === '/';
        const atEnd = i + 2 === glob.length;
        const slashAfter = glob[i + 2] === '/';
        if (atStart && slashAfter) { out += '(?:.*/)?'; i += 3; continue; }   // **/ 或 a/**/b
        if (atStart && atEnd) { out += '.*'; i += 2; continue; }              // a/** 或单独的 **
        // 其他位置连续的 * 按普通 * 处理（与 git 一致）
        while (glob[i] === '*') i++;
        out += '[^/]*';
        continue;
      }
      out += '[^/]*';
      i++;
    } else if (c === '?') {
      out += '[^/]';
      i++;
    } else if (c === '[') {
      const close = glob.indexOf(']', i + 2);
      if (close < 0) { out += '\\['; i++; continue; }
      let body = glob.slice(i + 1, close);
      let neg = false;
      if (body[0] === '!' || body[0] === '^') { neg = true; body = body.slice(1); }
      body = body.replace(/[\\\]^]/g, (m) => '\\' + m);
      out += `[${neg ? '^' : ''}${body}]`;
      i = close + 1;
    } else if (c === '\\' && i + 1 < glob.length) {
      out += glob[i + 1].replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
      i += 2;
    } else {
      out += c.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
      i++;
    }
  }
  return out;
}

/**
 * 解析 .gitignore 文本。
 * @param {string} text
 * @returns {Array<{ pattern: string, negate: boolean, dirOnly: boolean, re: RegExp }>}
 */
export function parseGitignore(text) {
  const rules = [];
  const lines = String(text || '').replace(/^\uFEFF/, '').split(/\r?\n/);
  for (const raw of lines) {
    let line = raw;
    if (!line || line.startsWith('#')) continue;
    // 结尾空格忽略（除非用 \ 转义）
    while (/\s$/.test(line) && !/\\\s$/.test(line)) line = line.slice(0, -1);
    if (!line) continue;
    let negate = false;
    if (line.startsWith('!')) { negate = true; line = line.slice(1); }
    else if (line.startsWith('\\!') || line.startsWith('\\#')) line = line.slice(1);
    let dirOnly = false;
    if (line.endsWith('/') && !line.endsWith('\\/')) { dirOnly = true; line = line.replace(/\/+$/, ''); }
    if (!line) continue;
    // 中间或开头有 / → 相对仓库根目录；否则匹配任何一层的名字
    const anchored = line.includes('/');
    const glob = line.replace(/^\/+/, '');
    if (!glob) continue;
    const src = globToRegexSource(glob);
    const re = new RegExp(anchored ? `^${src}$` : `^(?:.*/)?${src}$`);
    rules.push({ pattern: raw.trim(), negate, dirOnly, re });
  }
  return rules;
}

/**
 * 生成匹配函数：path（仓库相对路径，文件）是否被 .gitignore 忽略。
 * 与 git 一样：上级文件夹被忽略时，里面的文件不能再用 ! 加回来。
 * @param {string} text .gitignore 内容
 * @returns {(path: string) => boolean}
 */
export function createIgnoreMatcher(text) {
  const rules = parseGitignore(text);
  const test = (p, isDir) => {
    let ignored = false;
    for (const r of rules) {
      if (r.dirOnly && !isDir) continue;
      if (r.re.test(p)) ignored = !r.negate;
    }
    return ignored;
  };
  return (path) => {
    const p = String(path || '').replace(/^\/+/, '');
    if (!rules.length || !p) return false;
    const parts = p.split('/');
    for (let i = 1; i < parts.length; i++) {
      if (test(parts.slice(0, i).join('/'), true)) return true;
    }
    return test(p, false);
  };
}

// ---------------------------------------------------------------------------
// 文件名 / 网址

/** 系统自动生成、不该上传的文件。 */
export const JUNK_NAMES = new Set(['.ds_store', 'thumbs.db', 'desktop.ini']);
export function isJunkFile(name) {
  return JUNK_NAMES.has(String(name || '').toLowerCase());
}

/** 「压缩图片」只处理这些格式（GIF / WebP 原样上传）。 */
export const COMPRESSIBLE = new Set(['jpg', 'jpeg', 'png']);

export function stemOf(name) {
  const ext = extOf(name);
  return ext ? name.slice(0, name.length - ext.length - 1) : name;
}

export function baseNameOf(p) {
  const s = String(p || '');
  const i = s.lastIndexOf('/');
  return i >= 0 ? s.slice(i + 1) : s;
}

/** 'static/documents/论文.pdf' → 'https://site/documents/%E8%AE%BA%E6%96%87.pdf' */
export function staticFileUrl(siteUrl, staticPath) {
  const rel = sitePathFor(staticPath).replace(/^\/+/, '');
  const base = String(siteUrl || '/').replace(/\/?$/, '/');
  return base + rel.split('/').map((seg) => encodeURIComponent(seg)).join('/');
}

/** PDF 的在线预览网址：'static/documents/a.pdf' → 'https://site/viewer/?file=%2Fdocuments%2Fa.pdf' */
export function staticPreviewUrl(siteUrl, staticPath) {
  return viewerUrlFor(sitePathFor(staticPath), { absolute: true, siteUrl: String(siteUrl || '/') });
}

/** 这个文件用在线阅读器打开（目前只有 PDF；图片的文件链接在哪里都能直接显示）。 */
export function usesViewer(staticPath) {
  return isPdfPath(staticPath) && !!viewerUrlFor(sitePathFor(staticPath));
}

/**
 * 同一批里重名的文件自动加 -2、-3（不区分大小写），返回改了名的项。
 * @param {Array<{ name: string }>} items 会直接修改 name
 * @param {(lowerName: string) => boolean} [alsoTaken] 额外占用的名字
 */
export function assignUniqueNames(items, alsoTaken = () => false) {
  const taken = new Set();
  const renamed = [];
  for (const it of items) {
    let name = it.name;
    const stem = stemOf(name);
    const ext = extOf(name);
    for (let n = 2; taken.has(name.toLowerCase()) || alsoTaken(name.toLowerCase()); n++) name = `${stem}-${n}${ext ? '.' + ext : ''}`;
    if (name !== it.name) { it.name = name; renamed.push(it); }
    taken.add(name.toLowerCase());
  }
  return renamed;
}

// ---------------------------------------------------------------------------
// 压缩

/**
 * 压缩一张图片（只处理 JPG / PNG，勾选「压缩图片」时）。
 * @param {File} file
 * @param {string} name 安全文件名（safeFileName 的结果）
 * @param {{ compress: boolean }} opts
 * @returns {Promise<{ blob: Blob, name: string, size: number, compressed: boolean, note: string }>}
 */
export async function prepareUpload(file, name, { compress }) {
  const ext = extOf(name);
  const out = { blob: file, name, size: file.size, compressed: false, note: '' };
  if (!compress || !COMPRESSIBLE.has(ext) || file.size >= MAX_BYTES) return out;
  try {
    const r = await compressImage(file, { maxWidth: LIMITS.imageMaxWidth, quality: LIMITS.imageQuality });
    if (r && r.changed && r.blob && r.blob.size > 0) {
      out.blob = r.blob;
      out.size = r.blob.size;
      out.compressed = true;
      const newExt = r.ext === 'jpeg' ? 'jpg' : r.ext;
      const sameFamily = (ext === 'jpeg' || ext === 'jpg') && newExt === 'jpg';
      if (newExt && newExt !== ext && !sameFamily) {
        out.name = `${stemOf(name)}.${newExt}`;
        out.note = `已压缩并转成 ${newExt.toUpperCase()}：${formatBytes(file.size)} → ${formatBytes(out.size)}`;
      } else {
        out.note = `已压缩：${formatBytes(file.size)} → ${formatBytes(out.size)}`;
      }
    } else {
      out.note = '已经足够小，不用压缩';
    }
  } catch (err) {
    console.warn('[uploads] compress failed', err);
    out.note = '压缩失败，按原文件上传';
  }
  return out;
}

// ---------------------------------------------------------------------------
// 上传前检查

/**
 * 读 .gitignore 得到匹配函数（读不到 → 什么都不忽略）。
 * @param {object} repo
 */
export async function gitignoreMatcher(repo) {
  try {
    if (repo.has(PATHS.gitignore)) return createIgnoreMatcher(await repo.readText(PATHS.gitignore));
  } catch (err) {
    console.warn('[uploads] could not read .gitignore', err);
  }
  return () => false;
}

/**
 * 把一批待上传的文件分类（items 需要有 name、path、size，可选 origName）。
 * 不能上传的（被拒绝的类型、≥ 95 MB、和文件夹重名）标上 note 放进 refused；其余放进 ready，
 * 再从 ready 里挑出需要提醒的：large（≥ 25 MB）、overwrite（同名文件会被替换，带 existing）、ignored（.gitignore）、heic。
 * @param {object} repo
 * @param {Array<{ name: string, path: string, size: number, origName?: string }>} items
 * @param {(path: string) => boolean} [ignoreMatcher]
 */
export function checkUploads(repo, items, ignoreMatcher = () => false) {
  const refused = [];
  const ready = [];
  for (const it of items) {
    const ent = repo.entry(it.path);
    it.existing = ent ? { sha: ent.sha, size: ent.size } : null;
    const blocked = uploadBlockReason(it.origName || '', it.name);
    if (blocked) { it.note = blocked.note; it.blocked = true; refused.push(it); continue; }
    if (it.size >= MAX_BYTES) { it.note = `超过 ${LIMITS.maxFileMB} MB，GitHub 不允许上传这么大的文件`; refused.push(it); continue; }
    if (repo.list(it.path + '/').length) { it.note = '已经有一个同名的文件夹，请改个文件名再上传'; refused.push(it); continue; }
    ready.push(it);
  }
  return {
    refused,
    ready,
    large: ready.filter((it) => it.size >= WARN_BYTES),
    overwrite: ready.filter((it) => it.existing),
    ignored: ready.filter((it) => ignoreMatcher(it.path)),
    heic: ready.filter((it) => ['heic', 'heif'].includes(extOf(it.name))),
  };
}

/** checkUploads 的结果里有需要用户确认的事项吗。 */
export function needsReview(r) {
  return !!(r.refused.length || r.large.length || r.overwrite.length || r.ignored.length || r.heic.length);
}

function nameList(items, renderItem = (it) => it.name) {
  const max = 6;
  return h('ul', { class: 'files-name-list' },
    items.slice(0, max).map((it) => h('li', {}, renderItem(it))),
    items.length > max ? h('li', { class: 'muted' }, `…等 ${items.length} 个`) : null);
}

function reviewSection(kind, testid, title, items, renderItem, extra) {
  return h('div', { class: ['banner', `banner-${kind}`, 'files-review'], dataset: { testid } },
    svgIcon('warning'),
    h('div', { class: 'banner-text' },
      h('div', { class: 'files-review-title' }, title),
      nameList(items, renderItem),
      extra || null));
}

/**
 * 确认框里的提醒（.gitignore / 替换 / 太大 / HEIC / 不能上传）。testid 与「资料」页一致。
 * @param {ReturnType<typeof checkUploads>} r
 * @param {{ footer?: string }} [opts]
 */
export function uploadReviewSections(r) {
  const { refused, large, overwrite, ignored, heic } = r;
  const blocked = refused.filter((it) => it.blocked);
  return [
    ignored.length ? reviewSection('error', 'files-warn-gitignore',
      ignored.length === 1
        ? '这个文件在 .gitignore 里（你原本不打算公开它），确定要上传吗？上传后任何人都能在网站和 GitHub 上看到它。'
        : `这 ${ignored.length} 个文件在 .gitignore 里（你原本不打算公开它们），确定要上传吗？上传后任何人都能在网站和 GitHub 上看到它们。`,
      ignored, (it) => h('code', {}, it.path)) : null,
    overwrite.length ? reviewSection('warning', 'files-warn-overwrite',
      '这些文件已经存在，上传会替换掉网站上的旧文件（链接不变）：',
      overwrite, (it) => [h('strong', {}, it.name), h('span', { class: 'muted' }, `（旧 ${formatBytes(it.existing.size)} → 新 ${formatBytes(it.size)}）`)]) : null,
    large.length ? reviewSection('warning', 'files-warn-large',
      `这些文件超过 ${LIMITS.warnFileMB} MB，上传会比较慢，也会让网站仓库变大。可以的话先压缩一下：`,
      large, (it) => [h('strong', {}, it.name), h('span', { class: 'muted' }, `（${formatBytes(it.size)}）`)]) : null,
    heic.length ? reviewSection('warning', 'files-warn-heic',
      'HEIC 格式的照片在大多数浏览器里无法显示，建议先在手机或电脑上导出为 JPG 再上传：',
      heic) : null,
    refused.length ? reviewSection('error', 'files-warn-refused',
      '这些文件不能上传，会被跳过：',
      refused, (it) => [h('strong', {}, it.origName && it.blocked ? it.origName : it.name), h('span', { class: 'muted' }, ` — ${it.note}`)],
      blocked.length ? h('p', { class: 'files-review-explain small', dataset: { testid: 'upload-blocked-explain' } }, BLOCKED_UPLOAD_EXPLAIN) : null) : null,
  ];
}

/** 全部文件都不能上传时的说明。 */
export function refusedContent(refused) {
  const blocked = refused.filter((it) => it.blocked);
  return h('div', { class: 'stack-sm', dataset: { testid: 'upload-refused' } },
    h('p', {}, '这些文件不能上传：'),
    nameList(refused, (it) => [h('strong', {}, it.origName && it.blocked ? it.origName : it.name), h('span', { class: 'muted' }, ` — ${it.note}`)]),
    blocked.length ? h('p', { class: 'muted small', dataset: { testid: 'upload-blocked-explain' } }, BLOCKED_UPLOAD_EXPLAIN) : null);
}

// ---------------------------------------------------------------------------
// 引用检查

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 并发受限的 map。 */
export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * 找出正文里引用了这个网站文件的文章 / 页面（最多等 5 秒，失败就当没有）。
 * 直接链接、在线预览链接（/viewer/?file=…）、{{< pdf >}} 短代码都算。
 * @param {object} repo
 * @param {string} sitePath 网站路径（未编码）
 * @returns {Promise<string[]>} 仓库路径
 */
export async function findReferences(repo, sitePath) {
  const mds = repo.list(PATHS.content + '/').filter((e) => e.path.endsWith('.md'));
  if (!mds.length || mds.length > 400) return [];
  const work = mapLimit(mds, 6, async (e) => {
    try {
      const text = await repo.readText(e.path);
      return referencesSitePath(text, sitePath) ? e.path : null;
    } catch { return null; }
  }).then((r) => r.filter(Boolean));
  return Promise.race([work, sleep(5000).then(() => [])]);
}

/**
 * 删除 static/ 下的一个文件：确认框（列出引用了它的文章 / 页面）→ 一次提交。
 * @param {object} ctx 视图的 ctx
 * @param {{ path: string, sha: string }} e repo.entry
 * @param {{ isDisposed?: () => boolean }} [opts]
 * @returns {Promise<boolean>} 是否删除了
 */
export async function deleteStaticFile(ctx, e, { isDisposed = () => false } = {}) {
  if (ctx.isPublishing && ctx.isPublishing()) { toast('正在发布，请稍候', { type: 'warning' }); return false; }
  const name = baseNameOf(e.path);
  const sitePath = sitePathFor(e.path);
  const refs = await findReferences(ctx.repo, sitePath);
  if (isDisposed()) return false;
  const message = h('div', { class: 'stack-sm files-confirm' },
    h('p', {}, '删除后，网站上的这个链接会失效：'),
    h('p', {}, h('code', { class: 'files-code' }, sitePath)),
    refs.length
      ? h('div', { class: 'banner banner-warning', dataset: { testid: 'files-delete-refs' } },
        svgIcon('warning'),
        h('div', { class: 'banner-text' },
          h('div', {}, `有 ${refs.length} 篇文章或页面引用了它，删除后那里的链接、图片或嵌入的阅读器会打不开：`),
          h('ul', { class: 'files-name-list' }, refs.slice(0, 8).map((p) => h('li', {}, h('code', {}, p)))),
          refs.length > 8 ? h('div', { class: 'muted' }, `…等 ${refs.length} 个`) : null))
      : null,
    h('p', { class: 'muted small' }, '提示：GitHub 会保留历史版本，误删了也能找回。'));
  const ok = await confirmDialog({ title: `删除「${name}」？`, message, okText: '删除', danger: true });
  if (!ok || isDisposed()) return false;
  let res;
  try {
    res = await ctx.publish({
      message: `admin: 删除资料 ${name}`,
      changes: [{ path: e.path, delete: true, baseSha: e.sha }],
      summary: `删除 ${e.path}`,
    });
  } catch {
    return false; // 外壳已经提示了错误
  }
  if (res && res.conflict) {
    if (res.reloaded) toast('文件列表已更新为最新版本，请确认后再删除', { type: 'info' });
    return false;
  }
  // 成功提示由外壳统一显示（已发布，正在部署…）
  return true;
}
