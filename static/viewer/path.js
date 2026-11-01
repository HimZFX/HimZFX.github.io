// static/viewer/path.js — validation of the viewer's ?file= parameter (pure, no DOM; also used by tests).
//
// The viewer lives on the same origin as /admin/, whose GitHub token may be remembered in localStorage,
// so it must only ever open files of this site. Accepted: a root-relative site path such as
// "/documents/讲义-第1章.pdf" (raw or percent-encoded), that
//   - starts with "/" but not "//", and contains no backslash and no control characters;
//   - has no empty, "." or ".." segments — also after percent-decoding (up to 3 rounds, so %2e%2e,
//     %252e%252e … are refused) — and no encoded "/" or "\" inside a segment;
//   - is not under /admin/ or /viewer/ (case-insensitive).
// Anything else is rejected and the viewer neither fetches nor navigates anywhere.

export const PDF_EXTS = ['pdf'];
export const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'svg'];
const FORBIDDEN_TOP = ['admin', 'viewer'];
const MAX_LENGTH = 2048;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

function decodeOnce(s) {
  try {
    return decodeURIComponent(s);
  } catch (e) {
    return null; // not valid percent-encoding: the segment is taken literally
  }
}

/** Every decoding stage of one segment (raw first), stopping when nothing changes any more. */
function decodingStages(seg) {
  const out = [seg];
  let cur = seg;
  for (let i = 0; i < 3; i++) {
    const next = decodeOnce(cur);
    if (next === null || next === cur) break;
    out.push(next);
    cur = next;
  }
  return out;
}

/**
 * @param {string|null|undefined} raw  the value of ?file= (already decoded once by URLSearchParams)
 * @param {string} [origin]  if given, the result is also checked with the URL parser against this origin
 * @returns {{ ok: true, path: string, href: string, name: string, ext: string, kind: 'pdf'|'image'|'other' }
 *          | { ok: false, reason: string }}
 *   path = canonical decoded site path ("/documents/讲义.pdf"), href = the same, percent-encoded per segment.
 */
export function parseFileParam(raw, origin) {
  if (typeof raw !== 'string' || raw === '') return { ok: false, reason: 'empty' };
  if (raw.length > MAX_LENGTH) return { ok: false, reason: 'too-long' };
  if (raw.charAt(0) !== '/' || raw.charAt(1) === '/') return { ok: false, reason: 'not-root-relative' };
  if (raw.indexOf('\\') !== -1) return { ok: false, reason: 'backslash' };
  if (CONTROL.test(raw)) return { ok: false, reason: 'control-char' };

  const rawSegs = raw.slice(1).split('/');
  const segs = [];
  for (const seg of rawSegs) {
    if (seg === '') return { ok: false, reason: 'empty-segment' };
    const stages = decodingStages(seg);
    for (const s of stages) {
      if (s === '' || s === '.' || s === '..') return { ok: false, reason: 'dot-segment' };
      if (s.trim() === '.' || s.trim() === '..') return { ok: false, reason: 'dot-segment' };
      if (s.indexOf('\\') !== -1) return { ok: false, reason: 'backslash' };
      if (CONTROL.test(s)) return { ok: false, reason: 'control-char' };
    }
    const decoded = decodeOnce(seg);
    const value = decoded === null ? seg : decoded;
    if (value.indexOf('/') !== -1) return { ok: false, reason: 'encoded-slash' };
    // A later decoding stage that contains "/" would only matter to a server that decodes twice; refuse anyway.
    if (stages.some((s) => s.indexOf('/') !== -1)) return { ok: false, reason: 'encoded-slash' };
    segs.push(value);
  }
  if (FORBIDDEN_TOP.indexOf(segs[0].toLowerCase()) !== -1) return { ok: false, reason: 'forbidden-dir' };

  const name = segs[segs.length - 1];
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
  const path = '/' + segs.join('/');
  const href = '/' + segs.map((s) => encodeURIComponent(s)).join('/');

  if (origin) {
    let u;
    try {
      u = new URL(href, origin);
    } catch (e) {
      return { ok: false, reason: 'bad-url' };
    }
    if (u.origin !== new URL(origin).origin || u.pathname !== href || u.search || u.hash) {
      return { ok: false, reason: 'bad-url' };
    }
  }

  let kind = 'other';
  if (PDF_EXTS.indexOf(ext) !== -1) kind = 'pdf';
  else if (IMAGE_EXTS.indexOf(ext) !== -1) kind = 'image';
  return { ok: true, path, href, name, ext, kind };
}

/** Viewer link for a validated site path (same shape as the admin's viewerUrlFor). */
export function viewerHref(path, { lang, embed, page } = {}) {
  let q = '?file=' + encodeURIComponent(path);
  if (lang === 'en') q += '&lang=en';
  if (embed) q += '&embed=1';
  if (page && page > 1) q += '&page=' + page;
  return q;
}
