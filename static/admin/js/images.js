// images.js — 图片压缩 / 裁剪 / 文件名工具。
//
// 纯函数（safeFileName / timestampName / extOf）在 Node 里也能用；
// 浏览器相关的函数（compressImage / loadImage / cropToBlob）只在调用时才接触
// canvas / createImageBitmap / Image，导入本模块不会访问 window / document。

// ---------------------------------------------------------------------------
// 文件名（纯函数）
// ---------------------------------------------------------------------------

const NAME_MAX_CHARS = 120;
// 仓库会被 clone 到各种文件系统上，单个文件名通常限制 255 字节；
// 中文每字 3 字节，再给 timestampName 的 16 字符前缀留出余量。
const NAME_MAX_BYTES = 200;

function utf8Length(s) {
  let n = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0);
    n += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4;
  }
  return n;
}

/** 按「字符数 + 字节数」双重上限截断，不会切断代理对。 */
function truncate(s, maxChars, maxBytes) {
  let out = '';
  let chars = 0;
  let bytes = 0;
  for (const ch of s) {
    const b = utf8Length(ch);
    if (chars + 1 > maxChars || bytes + b > maxBytes) break;
    out += ch;
    chars += 1;
    bytes += b;
  }
  return out;
}

/** 只取路径的最后一段（防止 'C:\\fakepath\\a.jpg' 或 'a/b.jpg' 之类的输入）。 */
function baseName(name) {
  const s = String(name ?? '');
  const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
  return i >= 0 ? s.slice(i + 1) : s;
}

/**
 * 小写扩展名（不含点）；没有扩展名时返回 ''。隐藏文件 '.gitignore' 视为没有扩展名。
 * @example extOf('照片.JPG')   // 'jpg'
 * @example extOf('a.tar.gz')   // 'gz'
 * @param {string} name
 */
export function extOf(name) {
  const file = baseName(name).replace(/^\.+/, '');
  const dot = file.lastIndexOf('.');
  if (dot <= 0 || dot === file.length - 1) return '';
  const ext = file.slice(dot + 1).trim().toLowerCase();
  // 与 safeFileName 一致：只有 1–10 位字母数字才算扩展名
  return /^[a-z0-9]{1,10}$/.test(ext) ? ext : '';
}

/** 只保留字母（含中日韩）、数字、组合符号、'.'、'-'、'_'，其余（含空格）变成 '-' 并合并。 */
function cleanPart(s) {
  return s
    .replace(/[^\p{L}\p{N}\p{M}._-]+/gu, '-')
    .replace(/-{2,}/g, '-')
    .replace(/\.{2,}/g, '.');
}

/**
 * 把用户的文件名变成适合放进仓库和网址的名字。
 *   保留字母/数字（包括中文）、'.'、'-'、'_'；空格和其他字符 → '-'，连续的合并；
 *   扩展名转小写；去掉开头的点；绝不返回空串（兜底 'file'）；最长 120 个字符（保留扩展名）。
 * @example safeFileName('我的 照片(1).JPG')  // '我的-照片-1.jpg'
 * @param {string} name
 * @returns {string}
 */
export function safeFileName(name) {
  let file = baseName(name).normalize('NFC').trim();
  file = file.replace(/^\.+/, ''); // 不生成隐藏文件
  let stem = file;
  let ext = '';
  const dot = file.lastIndexOf('.');
  if (dot > 0 && dot < file.length - 1) {
    const rawExt = file.slice(dot + 1).trim().toLowerCase();
    // 只有像扩展名的才当扩展名（'Dr. Smith 笔记' 里的 ' Smith 笔记' 不是）
    if (/^[a-z0-9]{1,10}$/.test(rawExt)) {
      stem = file.slice(0, dot);
      ext = rawExt;
    }
  }
  stem = cleanPart(stem).replace(/^[.-]+|[.-]+$/g, '');
  const extPart = ext ? `.${ext}` : '';
  if (!stem) stem = 'file';
  const maxChars = NAME_MAX_CHARS - [...extPart].length;
  const maxBytes = NAME_MAX_BYTES - utf8Length(extPart);
  stem = truncate(stem, maxChars, maxBytes).replace(/[.-]+$/g, '') || 'file';
  return stem + extPart;
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

/**
 * 带时间戳的安全文件名（本地时间）：'20261031-172005-<safeFileName>'。
 * @param {string} name
 * @param {Date} [now]
 */
export function timestampName(name, now = new Date()) {
  const d = now;
  const stamp = `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-` +
    `${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
  return `${stamp}-${safeFileName(name)}`;
}

// ---------------------------------------------------------------------------
// 二进制工具
// ---------------------------------------------------------------------------

/**
 * Blob / File → Uint8Array。（也接受 Uint8Array / ArrayBuffer，原样返回。）
 * @param {Blob|Uint8Array|ArrayBuffer} blob
 * @returns {Promise<Uint8Array>}
 */
export async function blobToBytes(blob) {
  if (blob instanceof Uint8Array) return blob;
  if (blob instanceof ArrayBuffer) return new Uint8Array(blob);
  if (blob && typeof blob.arrayBuffer === 'function') {
    return new Uint8Array(await blob.arrayBuffer());
  }
  // 旧版 Safari 兜底
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(new Uint8Array(r.result));
    r.onerror = () => reject(r.error || new Error('读取文件失败'));
    r.readAsArrayBuffer(blob);
  });
}

async function headBytes(blob, n) {
  return blobToBytes(blob.size > n ? blob.slice(0, n) : blob);
}

function ascii(bytes, start, len) {
  let s = '';
  for (let i = start; i < start + len && i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return s;
}

/** 通过文件头判断真实格式（扩展名 / MIME 可能是错的）。 */
function sniffType(b) {
  if (b.length >= 8 && b[0] === 0x89 && ascii(b, 1, 3) === 'PNG') return 'image/png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (ascii(b, 0, 4) === 'GIF8') return 'image/gif';
  if (ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP') return 'image/webp';
  if (ascii(b, 4, 4) === 'ftyp') {
    const brand = ascii(b, 8, 4);
    if (/^(avif|avis)$/.test(brand)) return 'image/avif';
    if (/^(heic|heix|hevc|hevx|mif1|msf1)$/.test(brand)) return 'image/heic';
  }
  if (ascii(b, 0, 2) === 'BM') return 'image/bmp';
  return '';
}

/** 动画 WebP：VP8X 块的 flags 第 2 位（0x02）是动画标志，或出现 ANIM 块。 */
function isAnimatedWebp(b) {
  if (ascii(b, 12, 4) === 'VP8X' && (b[20] & 0x02)) return true;
  return ascii(b, 0, Math.min(b.length, 4096)).includes('ANIM');
}

/** APNG：在第一个 IDAT 之前出现 acTL 块。 */
function isAnimatedPng(b) {
  let i = 8;
  while (i + 8 <= b.length) {
    const len = ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
    const type = ascii(b, i + 4, 4);
    if (type === 'acTL') return true;
    if (type === 'IDAT' || type === 'IEND') return false;
    i += 12 + len;
  }
  return false;
}

/** PNG 头里的颜色类型：0 灰度、2 RGB、3 调色板、4 灰度+透明、6 RGBA；以及是否有 tRNS 块。 */
function pngMayHaveAlpha(b) {
  const colorType = b[25];
  if (colorType === 4 || colorType === 6) return true;
  let i = 8;
  while (i + 8 <= b.length) {
    const len = ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
    const type = ascii(b, i + 4, 4);
    if (type === 'tRNS') return true;
    if (type === 'IDAT' || type === 'IEND') return false;
    i += 12 + len;
  }
  return false;
}

/** JPEG 是否带 EXIF（可能含 GPS 位置等隐私信息）。 */
function jpegHasExif(b) {
  let i = 2;
  while (i + 4 <= b.length && b[i] === 0xff) {
    const marker = b[i + 1];
    if (marker === 0xda || marker === 0xd9) break; // 图像数据开始
    const len = (b[i + 2] << 8) | b[i + 3];
    if (marker === 0xe1 && ascii(b, i + 4, 4) === 'Exif') return true;
    i += 2 + len;
  }
  return false;
}

const EXT_BY_TYPE = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp',
  'image/svg+xml': 'svg', 'image/avif': 'avif', 'image/heic': 'heic', 'image/bmp': 'bmp',
};

// ---------------------------------------------------------------------------
// 浏览器：解码 / 绘制 / 编码
// ---------------------------------------------------------------------------

/**
 * 解码图片。优先 createImageBitmap（按 EXIF 方向旋转），失败时退回 <img>（例如 SVG）。
 * @param {Blob|File} fileOrBlob
 * @returns {Promise<ImageBitmap|HTMLImageElement>} 用 .width / .height 取尺寸
 */
export async function loadImage(fileOrBlob) {
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(fileOrBlob, { imageOrientation: 'from-image' });
    } catch {
      /* 退回 <img> */
    }
  }
  const url = URL.createObjectURL(fileOrBlob);
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    if (typeof img.decode === 'function') {
      await img.decode();
    } else {
      await new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = () => reject(new Error('图片无法解码'));
      });
    }
    return img;
  } catch {
    throw new Error('这个图片格式浏览器无法读取');
  } finally {
    // 解码完成后即可释放；已解码的 <img> 仍可绘制
    URL.revokeObjectURL(url);
  }
}

function dimsOf(image) {
  return {
    width: image.naturalWidth || image.width || 0,
    height: image.naturalHeight || image.height || 0,
  };
}

function makeCanvas(w, h) {
  if (typeof OffscreenCanvas === 'function') {
    try {
      const c = new OffscreenCanvas(w, h);
      if (c.getContext('2d')) return c;
    } catch {
      /* 退回 DOM canvas */
    }
  }
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

function canvasToBlob(canvas, type, quality) {
  if (typeof canvas.convertToBlob === 'function') {
    return canvas.convertToBlob({ type, quality });
  }
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('图片编码失败'))), type, quality);
  });
}

function draw(image, w, h, { opaque, src } = {}) {
  const canvas = makeCanvas(w, h);
  const g = canvas.getContext('2d', { willReadFrequently: false });
  if (opaque) {
    // JPEG 没有透明通道：先铺白底，否则透明处会变黑
    g.fillStyle = '#fff';
    g.fillRect(0, 0, w, h);
  }
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = 'high';
  if (src) g.drawImage(image, src.sx, src.sy, src.sw, src.sh, 0, 0, w, h);
  else g.drawImage(image, 0, 0, w, h);
  return { canvas, g };
}

/** 是否真的有半透明像素（缩小到 ≤256 宽再检查，避免大图耗时）。 */
function hasAlphaPixels(image, w, h) {
  const scale = Math.min(1, 256 / Math.max(w, h));
  const sw = Math.max(1, Math.round(w * scale));
  const sh = Math.max(1, Math.round(h * scale));
  const { g } = draw(image, sw, sh);
  const data = g.getImageData(0, 0, sw, sh).data;
  for (let i = 3; i < data.length; i += 4) if (data[i] < 255) return true;
  return false;
}

function closeImage(image) {
  if (image && typeof image.close === 'function') {
    try { image.close(); } catch { /* ignore */ }
  }
}

/**
 * 上传前压缩图片。
 *   GIF / SVG / 动画 WebP / 动画 PNG：原样返回（重新编码会丢动画或矢量）；
 *   带透明的 PNG（及其他带透明的格式）：输出 PNG，宽于 maxWidth 时缩小；
 *   其他：输出 JPEG（quality），宽于 maxWidth 时缩小。
 *   不需要缩小且结果反而更大时，返回原文件（但带 EXIF 的 JPEG 总是重新编码，以去掉位置信息）。
 *   浏览器无法解码的格式（如部分浏览器上的 HEIC）也原样返回。
 *
 * @param {Blob|File} fileOrBlob
 * @param {{ maxWidth?: number, quality?: number }} [opts]
 * @returns {Promise<{ blob: Blob, ext: string, width: number, height: number, changed: boolean }>}
 *   ext 不含点（'jpg' / 'png' / 'gif' …）；尺寸未知时 width/height 为 0。
 */
export async function compressImage(fileOrBlob, { maxWidth = 1920, quality = 0.85 } = {}) {
  const head = await headBytes(fileOrBlob, 64 * 1024);
  const declared = (fileOrBlob.type || '').toLowerCase();
  const type = sniffType(head) || declared ||
    (extOf(fileOrBlob.name || '') === 'svg' ? 'image/svg+xml' : '');
  const asIsExt = EXT_BY_TYPE[type] || extOf(fileOrBlob.name || '') || 'bin';

  const asIs = async () => {
    let width = 0;
    let height = 0;
    if (type === 'image/gif' && head.length >= 10) {
      width = head[6] | (head[7] << 8);
      height = head[8] | (head[9] << 8);
    } else {
      try {
        const img = await loadImage(fileOrBlob);
        ({ width, height } = dimsOf(img));
        closeImage(img);
      } catch { /* 尺寸未知 */ }
    }
    return { blob: fileOrBlob, ext: asIsExt, width, height, changed: false };
  };

  const isSvg = type === 'image/svg+xml' || /<svg[\s>]/i.test(ascii(head, 0, 1024));
  if (type === 'image/gif' || isSvg) return asIs();
  if (type === 'image/webp' && isAnimatedWebp(head)) return asIs();
  if (type === 'image/png' && isAnimatedPng(head)) return asIs();
  if (type && !type.startsWith('image/')) return asIs();

  let image;
  try {
    image = await loadImage(fileOrBlob);
  } catch {
    return asIs(); // 解码失败：不压缩，原样上传
  }
  try {
    const { width: w0, height: h0 } = dimsOf(image);
    if (!w0 || !h0) return { blob: fileOrBlob, ext: asIsExt, width: 0, height: 0, changed: false };
    const resize = w0 > maxWidth;
    const width = resize ? Math.round(maxWidth) : w0;
    const height = resize ? Math.max(1, Math.round((h0 * width) / w0)) : h0;

    const mayAlpha = type === 'image/png' ? pngMayHaveAlpha(head) : type !== 'image/jpeg';
    const keepAlpha = mayAlpha && hasAlphaPixels(image, w0, h0);
    const outType = keepAlpha ? 'image/png' : 'image/jpeg';
    const { canvas } = draw(image, width, height, { opaque: !keepAlpha });
    const blob = await canvasToBlob(canvas, outType, keepAlpha ? undefined : quality);

    const mustReencode = type === 'image/jpeg' && jpegHasExif(head);
    const browserFriendly = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(type);
    if (!resize && !mustReencode && browserFriendly && blob.size >= fileOrBlob.size) {
      return { blob: fileOrBlob, ext: asIsExt, width: w0, height: h0, changed: false };
    }
    return { blob, ext: keepAlpha ? 'png' : 'jpg', width, height, changed: true };
  } finally {
    closeImage(image);
  }
}

/**
 * 从图片中裁出一个正方形并缩放到 outSize×outSize（头像 / 网站图标）。
 * 源区域超出图片的部分填白色（JPEG）或透明（PNG）。
 *
 * @param {ImageBitmap|HTMLImageElement|HTMLCanvasElement} image loadImage 的结果
 * @param {{ sx: number, sy: number, sSize: number }} rect 源图坐标系里的正方形
 * @param {number} outSize 输出边长（像素）
 * @param {string} [type]
 * @param {number} [quality]
 * @returns {Promise<Blob>}
 */
export async function cropToBlob(image, { sx, sy, sSize }, outSize, type = 'image/jpeg', quality = 0.9) {
  const size = Math.max(1, Math.round(outSize));
  const opaque = type === 'image/jpeg';
  const canvas = makeCanvas(size, size);
  const g = canvas.getContext('2d');
  if (opaque) {
    g.fillStyle = '#fff';
    g.fillRect(0, 0, size, size);
  }
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = 'high';
  // 手动裁剪到图片范围内：不同浏览器对超界源矩形的处理不完全一致
  const { width: iw, height: ih } = dimsOf(image);
  const k = size / sSize;
  const x0 = Math.max(0, sx);
  const y0 = Math.max(0, sy);
  const x1 = Math.min(iw, sx + sSize);
  const y1 = Math.min(ih, sy + sSize);
  if (x1 > x0 && y1 > y0) {
    g.drawImage(image, x0, y0, x1 - x0, y1 - y0,
      (x0 - sx) * k, (y0 - sy) * k, (x1 - x0) * k, (y1 - y0) * k);
  }
  return canvasToBlob(canvas, type, opaque ? quality : undefined);
}
