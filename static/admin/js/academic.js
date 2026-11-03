/**
 * academic.js — 「学术」（论文 / 报告与海报 / 近况）的内容模型（纯函数，Node 里可以直接导入测试）。
 *
 * 数据放在 data/ 下，每条一个 YAML 文件（文件名 = id），Hugo 里是 site.Data.<目录>：
 *   data/publications/<id>.yaml   论文
 *   data/talks/<id>.yaml          报告与海报
 *   data/news/<YYYY-MM-DD>-<slug>.yaml   近况
 * 字段约定见 docs/admin-architecture.md 第 15 节（与网站模板共用的约定，两边都按它来）。
 *
 * 本模块包含：
 *   - BibTeX 解析（parseBibtex）、LaTeX 转义 / 重音解码（decodeLatex）、作者名规范化（formatAuthor）、
 *     ADS 期刊缩写宏（JOURNAL_MACROS）、一条 BibTeX → 论文字段（bibToPublication）
 *   - 确定性的 YAML 写法（dumpYaml / entryFileText：字符串一律双引号、列表逐行、多行文字用 |-）
 *   - 文件名（id）、排序 / 分组、日期、作者高亮
 *   - 社交链接的网址补全与检查（normalizeSocialUrl / socialUrlWarning，「首页设置」用）
 *   - 顶部菜单的小工具（menuWithoutMain、academicIndexDocument）
 *
 * @module academic
 */

import * as yaml from '../vendor/js-yaml/js-yaml.mjs';
import { setFields } from './frontmatter.js';

// ---------------------------------------------------------------------------
// 常量

/** 三类条目：数据目录、网站页面目录、上传目录、界面名称。 */
export const SECTIONS = Object.freeze({
  publications: Object.freeze({
    key: 'publications', dataDir: 'data/publications', pageDir: 'content/publications', uploadDir: 'static/documents/papers',
    label: '论文', titles: Object.freeze({ en: 'Publications', zh: '论文' }),
    descriptions: Object.freeze({ en: 'Papers, preprints and other writing.', zh: '论文、预印本与其他写作。' }),
  }),
  talks: Object.freeze({
    key: 'talks', dataDir: 'data/talks', pageDir: 'content/talks', uploadDir: 'static/documents/talks',
    label: '报告与海报', titles: Object.freeze({ en: 'Talks & Posters', zh: '报告与海报' }),
    descriptions: Object.freeze({ en: 'Talks, posters and seminars.', zh: '学术报告、海报与讨论班。' }),
  }),
  news: Object.freeze({
    key: 'news', dataDir: 'data/news', pageDir: 'content/news', uploadDir: null,
    label: '近况', titles: Object.freeze({ en: 'News', zh: '近况' }),
    descriptions: Object.freeze({ en: 'Recent updates.', zh: '最近的动态。' }),
  }),
});
export const SECTION_KEYS = Object.freeze(['publications', 'talks', 'news']);

/** 简历 PDF 的上传目录。 */
export const CV_DIR = 'static/documents/cv';

export const PUB_STATUSES = Object.freeze(['published', 'accepted', 'submitted', 'in-prep']);
export const PUB_STATUS_LABELS = Object.freeze({ published: '已发表', accepted: '已接收', submitted: '已投稿', 'in-prep': '准备中' });
export const PUB_KINDS = Object.freeze(['refereed', 'proceedings', 'preprint', 'thesis', 'other']);
export const PUB_KIND_LABELS = Object.freeze({ refereed: '期刊论文', proceedings: '会议论文', preprint: '预印本', thesis: '学位论文', other: '其他' });
export const TALK_KINDS = Object.freeze(['talk', 'poster', 'seminar', 'invited', 'outreach', 'other']);
export const TALK_KIND_LABELS = Object.freeze({ talk: '报告', poster: '海报', seminar: '讨论班', invited: '特邀报告', outreach: '科普', other: '其他' });
/** 论文列表的分组方式（params.toml 的 [publications] groupBy）。 */
export const GROUP_BY = Object.freeze(['kind', 'year']);
export const GROUP_BY_LABELS = Object.freeze({ kind: '按类型（同行评审 / 已投稿与准备中 / 会议论文与其他）', year: '按年份' });

/** 每类文件里键的顺序（写新文件 / 重写本后台写的文件时）。 */
export const FIELD_ORDER = Object.freeze({
  publications: Object.freeze(['id', 'title', 'authors', 'year', 'month', 'venue', 'volume', 'pages', 'status', 'kind', 'selected',
    'arxiv', 'ads', 'doi', 'pdf', 'code', 'slides', 'note', 'bibtex']),
  talks: Object.freeze(['id', 'title', 'event', 'location', 'date', 'kind', 'slides', 'video', 'url', 'abstract', 'note']),
  news: Object.freeze(['date', 'text', 'text_en', 'text_zh', 'link']),
});

const INT_FIELDS = new Set(['year', 'month']);
const BOOL_FIELDS = new Set(['selected']);
const LIST_FIELDS = new Set(['authors']);

// ---------------------------------------------------------------------------
// BibTeX

/**
 * @typedef {object} BibEntry
 * @property {string} type  小写，如 'article'
 * @property {string} key   引用键（ADS 导出时就是 bibcode）
 * @property {Record<string,string>} fields  字段名小写；值是去掉最外层 {} / "" 之后的原文（LaTeX 未解码）
 * @property {string} raw   这一条的原文（从 @ 到结尾的括号）
 * @property {number} line  从第几行开始（1 起）
 */

const MONTH_NAMES = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/**
 * 解析 BibTeX 文本。容错：条目之间的任何文字（% 注释、说明）都忽略；@comment / @preamble 跳过；
 * 支持 @string 宏、"…" 和 {…} 值（可嵌套）、# 拼接、( ) 作为条目括号；某一条格式坏了就记进 errors 并跳到下一条。
 * @param {string} text
 * @returns {{ entries: BibEntry[], errors: Array<{ line: number, message: string }> }}
 */
export function parseBibtex(text) {
  const s = String(text ?? '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const entries = [];
  const errors = [];
  const strings = Object.create(null);
  let i = 0;
  const lineAt = (pos) => s.slice(0, pos).split('\n').length;

  while (i < s.length) {
    const at = s.indexOf('@', i);
    if (at < 0) break;
    const start = at;
    let p = at + 1;
    const typeM = /^[ \t]*([A-Za-z][A-Za-z0-9_-]*)[ \t\n]*/.exec(s.slice(p));
    if (!typeM) { i = at + 1; continue; }
    const type = typeM[1].toLowerCase();
    p += typeM[0].length;
    const open = s[p];
    if (open !== '{' && open !== '(') { i = at + 1; continue; }
    const close = open === '{' ? '}' : ')';
    p++;
    try {
      if (type === 'comment' || type === 'preamble') {
        i = skipBalanced(s, p - 1, open) + 1;
        continue;
      }
      if (type === 'string') {
        p = skipWs(s, p);
        const nm = /^[^\s=,{}()"#]+/.exec(s.slice(p));
        if (!nm) throw new BibError('@string 里缺少名字', p);
        p = skipWs(s, p + nm[0].length);
        if (s[p] !== '=') throw new BibError('@string 里缺少 =', p);
        const v = readValue(s, p + 1, close, strings);
        strings[nm[0].toLowerCase()] = v.value;
        p = skipWs(s, v.end);
        if (s[p] !== close) throw new BibError('@string 没有正确结束', p);
        i = p + 1;
        continue;
      }
      // 普通条目：键
      p = skipWs(s, p);
      const keyEnd = findKeyEnd(s, p, close);
      const key = s.slice(p, keyEnd).trim();
      p = keyEnd;
      const fields = {};
      for (;;) {
        p = skipWs(s, p);
        if (s[p] === ',') { p++; continue; }
        if (s[p] === close) break;
        if (p >= s.length) throw new BibError('条目没有结束（缺少右括号）', start);
        if (s[p] === '@') throw new BibError('条目没有结束（缺少右括号）', start);
        const fm = /^[^\s=,{}()"#]+/.exec(s.slice(p));
        if (!fm) throw new BibError(`无法识别的内容「${s.slice(p, p + 12)}」`, p);
        const name = fm[0].toLowerCase();
        p = skipWs(s, p + fm[0].length);
        if (s[p] !== '=') throw new BibError(`字段 ${fm[0]} 后面缺少 =`, p);
        const v = readValue(s, p + 1, close, strings);
        if (!(name in fields)) fields[name] = v.value; // 重复字段：第一个为准（和 BibTeX 一样）
        p = v.end;
      }
      entries.push({ type, key, fields, raw: s.slice(start, p + 1), line: lineAt(start) });
      i = p + 1;
    } catch (err) {
      if (!(err instanceof BibError)) throw err;
      errors.push({ line: lineAt(err.pos ?? start), message: err.message });
      // 跳到下一个出现在行首的 @
      const next = s.slice(start + 1).search(/\n[ \t]*@/);
      i = next < 0 ? s.length : start + 1 + next + 1;
    }
  }
  return { entries, errors };
}

class BibError extends Error {
  constructor(message, pos) { super(message); this.pos = pos; }
}

function skipWs(s, p) {
  while (p < s.length && /\s/.test(s[p])) p++;
  return p;
}

/** s[p] 是 open：返回与之匹配的 close 的位置（{…} 按花括号配对，(…) 按圆括号配对）。 */
function skipBalanced(s, p, open) {
  if (open === '{') return matchBrace(s, p);
  let depth = 0;
  for (let i = p; i < s.length; i++) {
    if (s[i] === '(') depth++;
    else if (s[i] === ')') { depth--; if (depth === 0) return i; }
  }
  throw new BibError('括号没有配对', p);
}

function findKeyEnd(s, p, close) {
  let i = p;
  while (i < s.length && s[i] !== ',' && s[i] !== close && s[i] !== '\n') i++;
  if (s[i] === '\n') {
    // 键后面换行再写逗号（少见）：跳过空白后必须是逗号或右括号
    const j = skipWs(s, i);
    if (s[j] === ',' || s[j] === close) return j;
    throw new BibError('引用键后面缺少逗号', i);
  }
  if (i >= s.length) throw new BibError('条目没有结束（缺少右括号）', p);
  return i;
}

/** 读一个字段值（可以是若干部分用 # 拼起来）。返回 { value, end }，end 指向值后面的第一个字符。 */
function readValue(s, p, close, strings) {
  const parts = [];
  for (;;) {
    p = skipWs(s, p);
    const c = s[p];
    if (c === '{') {
      const end = matchBrace(s, p);
      parts.push(s.slice(p + 1, end));
      p = end + 1;
    } else if (c === '"') {
      let depth = 0;
      let j = p + 1;
      for (; j < s.length; j++) {
        const ch = s[j];
        if (ch === '\\') { j++; continue; }
        if (ch === '{') depth++;
        else if (ch === '}') depth--;
        else if (ch === '"' && depth === 0) break;
      }
      if (j >= s.length) throw new BibError('引号没有配对', p);
      parts.push(s.slice(p + 1, j));
      p = j + 1;
    } else {
      const m = /^[^\s,#{}()"=]+/.exec(s.slice(p));
      if (!m) throw new BibError('字段缺少值', p);
      const word = m[0];
      const lower = word.toLowerCase();
      if (/^\d+$/.test(word)) parts.push(word);
      else if (lower in strings) parts.push(strings[lower]);
      else parts.push(word); // 未定义的宏（例如月份 jan）：保留名字
      p += word.length;
    }
    const q = skipWs(s, p);
    if (s[q] === '#') { p = q + 1; continue; }
    return { value: parts.join(''), end: q };
  }
}

function matchBrace(s, p) {
  let depth = 0;
  for (let i = p; i < s.length; i++) {
    const c = s[i];
    if (c === '\\') { i++; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return i; }
  }
  throw new BibError('花括号没有配对', p);
}

// ---------------------------------------------------------------------------
// LaTeX → 纯文字

const ACCENT_SYMBOLS = {
  "'": '\u0301', '`': '\u0300', '^': '\u0302', '"': '\u0308', '~': '\u0303', '=': '\u0304', '.': '\u0307',
};
const ACCENT_LETTERS = {
  u: '\u0306', v: '\u030C', H: '\u030B', c: '\u0327', k: '\u0328', r: '\u030A', d: '\u0323', b: '\u0331', t: '\u0361',
};
const SPECIAL_LETTERS = {
  o: 'ø', O: 'Ø', ae: 'æ', AE: 'Æ', oe: 'œ', OE: 'Œ', aa: 'å', AA: 'Å', ss: 'ß', l: 'ł', L: 'Ł', i: 'ı', j: 'ȷ',
  dh: 'ð', DH: 'Ð', th: 'þ', TH: 'Þ', ng: 'ŋ', NG: 'Ŋ', dj: 'đ', DJ: 'Đ',
};
const TEXT_SYMBOLS = {
  textless: '<', textgreater: '>', textendash: '–', textemdash: '—', textquoteright: '’', textquoteleft: '‘',
  textquotedblleft: '“', textquotedblright: '”', textbackslash: '\\', textasciitilde: '~', textunderscore: '_',
  textbullet: '•', ldots: '…', dots: '…', textellipsis: '…', S: '§', P: '¶', copyright: '©', textcopyright: '©',
  textregistered: '®', texttrademark: '™', textdegree: '°', degree: '°', pounds: '£', euro: '€', textasciicircum: '^',
  TeX: 'TeX', LaTeX: 'LaTeX', BibTeX: 'BibTeX', textbar: '|', textperiodcentered: '·', textdagger: '†', dag: '†',
  textpm: '±', textmu: 'µ', textsterling: '£', guillemotleft: '«', guillemotright: '»', textexclamdown: '¡',
  textquestiondown: '¿', ss: 'ß', odot: '⊙', sun: '☉', earth: '⊕', arcsec: '″', arcmin: '′',
};
/** 只是改变字体 / 字号的开关命令：去掉（\sc 另外处理：后面的字母变大写）。 */
const SWITCHES = new Set(['it', 'bf', 'em', 'rm', 'sl', 'tt', 'sf', 'up', 'md', 'normalfont', 'tiny', 'scriptsize',
  'footnotesize', 'small', 'normalsize', 'large', 'Large', 'LARGE', 'huge', 'Huge', 'relax', 'protect', 'noopsort',
  'nobreak', 'hfill', 'quad', 'qquad', 'newblock', 'itshape', 'bfseries', 'upshape', 'scshape']);

/**
 * 把 BibTeX 里的 LaTeX 转成纯文字：重音（\'{e} \"o {\o} \v{c} …）、特殊字母、转义（\& \% \_ …）、
 * --/---、``''、~、{} 保护括号、\textit{…} 等格式命令、ADS 常见的 \ion{H}{i}、{\sc i}。
 * $…$ / \(…\) 里的数学公式原样保留（网站用 KaTeX 显示）。连续空白合并成一个空格。
 * @param {string} input
 * @returns {string}
 */
export function decodeLatex(input) {
  const s = String(input ?? '');
  const out = decodeRange(s, 0, s.length, { upper: false });
  return out
    .replace(/---/g, '—')
    .replace(/--/g, '–')
    .replace(/``/g, '“')
    .replace(/''/g, '”')
    .replace(/[ \t\n\r\f\v\u00a0]+/g, ' ')
    .trim()
    .normalize('NFC');
}

function decodeRange(s, from, to, state) {
  let out = '';
  let i = from;
  const st = { upper: state.upper };
  const push = (txt) => { out += st.upper ? txt.toUpperCase() : txt; };
  while (i < to) {
    const c = s[i];
    if (c === '$') {
      // 数学公式：$…$ 或 $$…$$，原样保留
      const dbl = s[i + 1] === '$';
      const delim = dbl ? '$$' : '$';
      let j = i + delim.length;
      while (j < to && !(s.startsWith(delim, j) && s[j - 1] !== '\\')) j++;
      out += s.slice(i, Math.min(to, j + delim.length));
      i = j + delim.length;
      continue;
    }
    if (c === '\\' && (s[i + 1] === '(' || s[i + 1] === '[')) {
      const endTok = s[i + 1] === '(' ? '\\)' : '\\]';
      const j = s.indexOf(endTok, i + 2);
      const end = j < 0 || j >= to ? to : j + 2;
      out += s.slice(i, end);
      i = end;
      continue;
    }
    if (c === '{') {
      const end = safeMatch(s, i, to);
      out += decodeRange(s, i + 1, end, st);
      i = end + 1;
      continue;
    }
    if (c === '}') { i++; continue; }
    if (c === '~') { out += ' '; i++; continue; }
    if (c !== '\\') { push(c); i++; continue; }

    // 反斜杠命令
    const n = s[i + 1];
    if (n === undefined) { i++; continue; }
    if (ACCENT_SYMBOLS[n] !== undefined) {
      const arg = readArg(s, i + 2, to);
      out += applyAccent(decodeRange(s, arg.from, arg.to, st), ACCENT_SYMBOLS[n]);
      i = arg.next;
      continue;
    }
    if (/[A-Za-z]/.test(n)) {
      const m = /^[A-Za-z]+/.exec(s.slice(i + 1, to));
      const name = m[0];
      let j = i + 1 + name.length;
      if (name.length === 1 && ACCENT_LETTERS[name] !== undefined && !/[A-Za-z]/.test(s[j] || '')) {
        const arg = readArg(s, j, to);
        out += applyAccent(decodeRange(s, arg.from, arg.to, st), ACCENT_LETTERS[name]);
        i = arg.next;
        continue;
      }
      // 控制词后面的空白被 TeX 吃掉
      const afterWs = () => { let k = j; while (k < to && (s[k] === ' ' || s[k] === '\t' || s[k] === '\n')) k++; return k; };
      if (SPECIAL_LETTERS[name] !== undefined) {
        push(SPECIAL_LETTERS[name]);
        i = s[j] === '{' && s[j + 1] === '}' ? j + 2 : afterWs();
        continue;
      }
      if (TEXT_SYMBOLS[name] !== undefined) {
        push(TEXT_SYMBOLS[name]);
        i = s[j] === '{' && s[j + 1] === '}' ? j + 2 : afterWs();
        continue;
      }
      if (name === 'ion') {
        // AASTeX：\ion{H}{i} → H I
        const a = readArg(s, afterWs(), to);
        const b = readArg(s, a.next, to);
        out += `${decodeRange(s, a.from, a.to, st)} ${decodeRange(s, b.from, b.to, st).toUpperCase()}`;
        i = b.next;
        continue;
      }
      if (name === 'sc' || name === 'scshape') { st.upper = true; i = afterWs(); continue; }
      if (name === 'textsc' || name === 'MakeUppercase' || name === 'uppercase') {
        const a = readArg(s, afterWs(), to);
        out += decodeRange(s, a.from, a.to, st).toUpperCase();
        i = a.next;
        continue;
      }
      if (SWITCHES.has(name)) { i = afterWs(); continue; }
      // 其他命令：有 {参数} 就保留参数内容（\textit{x} → x、\href{url}{text} 取最后一个），没有就去掉命令名
      let k = afterWs();
      if (s[k] === '{') {
        let last = null;
        while (s[k] === '{') {
          const end = safeMatch(s, k, to);
          last = { from: k + 1, to: end };
          k = end + 1;
        }
        out += decodeRange(s, last.from, last.to, st);
        i = k;
      } else {
        i = k;
      }
      continue;
    }
    // \ 后面是符号
    const SYM = { '&': '&', '%': '%', $: '$', '#': '#', _: '_', '{': '{', '}': '}', ' ': ' ', ',': ' ', ';': ' ', ':': ' ', '!': '', '\\': ' ', '-': '', '/': '', '@': '', '\n': ' ', '|': '‖' };
    if (SYM[n] !== undefined) { out += SYM[n]; i += 2; continue; }
    push(n);
    i += 2;
  }
  return out;
}

function safeMatch(s, p, to) {
  let depth = 0;
  for (let i = p; i < to; i++) {
    const c = s[i];
    if (c === '\\') { i++; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return i; }
  }
  return to; // 不配对：当作到结尾
}

/** 重音命令的参数：{…}、单个字符，或 \i \j 这类命令。 */
function readArg(s, p, to) {
  let k = p;
  while (k < to && (s[k] === ' ' || s[k] === '\t')) k++;
  if (s[k] === '{') {
    const end = safeMatch(s, k, to);
    return { from: k + 1, to: end, next: end + 1 };
  }
  if (s[k] === '\\' && /[A-Za-z]/.test(s[k + 1] || '')) {
    const m = /^[A-Za-z]+/.exec(s.slice(k + 1, to));
    return { from: k, to: k + 1 + m[0].length, next: k + 1 + m[0].length };
  }
  if (k >= to) return { from: k, to: k, next: k };
  const cp = s.codePointAt(k);
  const len = cp > 0xffff ? 2 : 1;
  return { from: k, to: k + len, next: k + len };
}

function applyAccent(text, mark) {
  if (!text) return mark.trim();
  // 无点的 ı / ȷ 加重音时换回普通 i / j（\'{\i} → í）
  const chars = [...text];
  let first = chars[0];
  if (first === 'ı') first = 'i';
  if (first === 'ȷ') first = 'j';
  return (first + mark).normalize('NFC') + chars.slice(1).join('');
}

// ---------------------------------------------------------------------------
// 作者

/** 按顶层的 and 拆开作者列表（括号里的 and 不算）。 */
export function splitAuthors(raw) {
  const s = String(raw ?? '').replace(/\s+/g, ' ').trim();
  if (!s) return [];
  const out = [];
  let depth = 0;
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\') { cur += c + (s[i + 1] ?? ''); i++; continue; }
    if (c === '{') depth++;
    else if (c === '}') depth = Math.max(0, depth - 1);
    if (depth === 0 && /\s/.test(c) && /^and\s/i.test(s.slice(i + 1)) && cur.trim()) {
      out.push(cur.trim());
      cur = '';
      i += 4; // ' and'
      continue;
    }
    cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** 在顶层（不在 {} 里）按 sep 拆开。 */
function splitTop(s, re) {
  const out = [];
  let depth = 0;
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\') { cur += c + (s[i + 1] ?? ''); i++; continue; }
    if (c === '{') depth++;
    else if (c === '}') depth = Math.max(0, depth - 1);
    if (depth === 0 && re.test(c)) { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  out.push(cur);
  return out;
}

function wholeBraced(s) {
  if (!s.startsWith('{') || !s.endsWith('}')) return false;
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\') { i++; continue; }
    if (s[i] === '{') depth++;
    else if (s[i] === '}') { depth--; if (depth === 0 && i < s.length - 1) return false; }
  }
  return true;
}

/** 'Fangxiong' → 'F.'；'Jean-Pierre' / 'J. -P.' → 'J.-P.'；'Mary Ann' → 'M. A.'；'Yu. N.' 原样；中日韩文字的名字原样。 */
export function initialsOf(first) {
  const s = String(first ?? '').replace(/\s*-\s*/g, '-').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  return s.split(' ').map((tok) => tok.split('-').filter(Boolean).map((piece) => {
    if (/\.$/.test(piece)) return piece; // 已经是缩写（F. / Yu. / Th.）
    if (/[\p{Script=Han}\p{Script=Hangul}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(piece)) return piece; // 中日韩的名字不缩写
    const ch = [...piece].find((x) => /\p{L}/u.test(x));
    return ch ? ch.toUpperCase() + '.' : piece;
  }).join('-')).filter(Boolean).join(' ');
}

/**
 * 一位作者 → 'Last, F.'（姓原样，名缩写成首字母）。
 *   '{Zhong}, Fangxiong' → 'Zhong, F.'；'{van der Berg}, J. -P.' → 'van der Berg, J.-P.'；
 *   'Fangxiong Zhong' → 'Zhong, F.'；'Ludwig van Beethoven' → 'van Beethoven, L.'；
 *   '{LIGO Scientific Collaboration}' → 'LIGO Scientific Collaboration'；'Smith, Jr., John' → 'Smith, J., Jr.'
 * @param {string} raw BibTeX 里的一个名字（未解码）
 */
export function formatAuthor(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return '';
  if (wholeBraced(s)) return decodeLatex(s);
  const parts = splitTop(s, /,/).map((x) => x.trim());
  let last;
  let first = '';
  let jr = '';
  if (parts.length === 1) {
    const toks = splitTop(parts[0], /\s/).filter(Boolean);
    if (toks.length === 1) return decodeLatex(toks[0]);
    let k = -1;
    for (let t = 1; t < toks.length - 1; t++) {
      const d = decodeLatex(toks[t]);
      const ch = [...d].find((x) => /\p{L}/u.test(x));
      if (ch && ch === ch.toLowerCase() && ch !== ch.toUpperCase() && !toks[t].startsWith('{')) { k = t; break; }
    }
    if (k < 0) k = toks.length - 1;
    last = toks.slice(k).join(' ');
    first = toks.slice(0, k).join(' ');
  } else if (parts.length === 2) {
    [last, first] = parts;
  } else {
    last = parts[0];
    jr = parts[1];
    first = parts.slice(2).join(' ');
  }
  const L = decodeLatex(last);
  const F = initialsOf(decodeLatex(first));
  const J = decodeLatex(jr);
  return [L, F, J].filter(Boolean).join(', ');
}

/** 整个 author 字段 → 规范化的作者列表；'and others' → 'et al.'。 */
export function parseAuthors(raw) {
  return splitAuthors(raw).map((a) => (/^others$/i.test(a.trim()) ? 'et al.' : formatAuthor(a))).filter(Boolean);
}

// ---------------------------------------------------------------------------
// 期刊

/** ADS / AASTeX 的期刊宏 → 常用缩写。 */
export const JOURNAL_MACROS = Object.freeze({
  aj: 'AJ', actaa: 'Acta Astron.', araa: 'ARA&A', apj: 'ApJ', apjl: 'ApJL', apjs: 'ApJS', ao: 'Appl. Opt.', apss: 'Ap&SS',
  aap: 'A&A', aapr: 'A&A Rv', aaps: 'A&AS', azh: 'AZh', baas: 'BAAS', bain: 'Bull. Astron. Inst. Netherlands',
  caa: 'Chinese Astron. Astrophys.', cjaa: 'Chinese J. Astron. Astrophys.', icarus: 'Icarus', jcap: 'JCAP', jrasc: 'JRASC',
  memras: 'MmRAS', mnras: 'MNRAS', na: 'New A', nar: 'New A Rev.', pasa: 'PASA', pra: 'Phys. Rev. A', prb: 'Phys. Rev. B',
  prc: 'Phys. Rev. C', prd: 'Phys. Rev. D', pre: 'Phys. Rev. E', prl: 'Phys. Rev. Lett.', pasj: 'PASJ', pasp: 'PASP',
  psj: 'PSJ', qjras: 'QJRAS', rmxaa: 'Rev. Mexicana Astron. Astrofis.', skytel: 'S&T', solphys: 'Sol. Phys.',
  sovast: 'Soviet Ast.', ssr: 'Space Sci. Rev.', zap: 'ZAp', nat: 'Nature', natas: 'Nature Astronomy', sci: 'Science',
  iaucirc: 'IAU Circ.', aplett: 'Astrophys. Lett.', apspr: 'Astrophys. Space Phys. Res.', fcp: 'Fund. Cosmic Phys.',
  gca: 'Geochim. Cosmochim. Acta', grl: 'Geophys. Res. Lett.', jcp: 'J. Chem. Phys.', jgr: 'J. Geophys. Res.',
  jqsrt: 'J. Quant. Spectrosc. Radiat. Transfer', memsai: 'Mem. Soc. Astron. Italiana', nphysa: 'Nucl. Phys. A',
  physrep: 'Phys. Rep.', physscr: 'Phys. Scr.', planss: 'Planet. Space Sci.', procspie: 'Proc. SPIE', rnaas: 'RNAAS',
});

/** 期刊字段（原文）→ 显示用的名字：'\apj' → 'ApJ'；'{Physical Review D}' → 'Physical Review D'。 */
export function journalName(raw) {
  const t = String(raw ?? '').replace(/[{}\s]/g, '');
  const m = /^\\([A-Za-z]+)$/.exec(t);
  if (m) return JOURNAL_MACROS[m[1].toLowerCase()] || JOURNAL_MACROS[m[1]] || m[1];
  return decodeLatex(raw);
}

// ---------------------------------------------------------------------------
// 标识符

/** 'arXiv:2603.01234v2' / 'https://arxiv.org/abs/2603.01234' → '2603.01234'；老格式 astro-ph/0601001 也认。 */
export function normalizeArxiv(v) {
  let s = String(v ?? '').trim();
  if (!s) return '';
  s = s.replace(/^https?:\/\/(?:www\.|export\.)?arxiv\.org\/(?:abs|pdf)\//i, '').replace(/\.pdf$/i, '');
  s = s.replace(/^arxiv:\s*/i, '');
  const m = /^(\d{4}\.\d{4,5}|[a-z-]+(?:\.[A-Z]{2})?\/\d{7})(?:v\d+)?$/i.exec(s);
  return m ? m[1] : s;
}

const ARXIV_ID_RE = /^(\d{4}\.\d{4,5}|[a-z][a-z.-]*(?:\.[A-Z]{2})?\/\d{7})$/i;
/** 是不是 arXiv 编号（normalizeArxiv 之后）：2603.01234、astro-ph/0601001。和网站模板（academic/pub.html）的规则相同。 */
export function isArxivId(s) {
  return typeof s === 'string' && ARXIV_ID_RE.test(s);
}

const DOI_RE = /^10\.\d{4,9}\/\S+$/;
/** 是不是 DOI（normalizeDoi 之后）：10.xxxx/…。和网站模板的规则相同。 */
export function isDoi(s) {
  return typeof s === 'string' && DOI_RE.test(s);
}

/** 网站模板（academic/pub.html）认作 bibcode 的写法（比 isBibcode 宽一点，也允许 : 和 +）。 */
const SITE_BIBCODE_RE = /^\d{4}[A-Za-z0-9&.:+]{14}[A-Za-z.]$/;

/** 完整的 http(s) 网址（没有空格、引号、尖括号）。网站模板只接受这种网址。 */
export function isHttpUrl(s) {
  return typeof s === 'string' && /^https?:\/\/[^\s"'<>\\]+$/i.test(s);
}

/**
 * 论文的 arXiv / ADS / DOI 填得对不对：空、标识符或 http(s) 网址都可以；其他（javascript: 之类、乱填的文字）返回提示。
 * @param {'arxiv'|'ads'|'doi'} field
 * @param {string} value 表单里的原值
 * @returns {string|null} 错误提示；没问题时 null
 */
export function identifierError(field, value) {
  const v = String(value ?? '').trim();
  if (!v) return null;
  if (field === 'arxiv') return isArxivId(normalizeArxiv(v)) || isHttpUrl(v) ? null : 'arXiv 编号的格式是 2603.01234（或 astro-ph/0601001），也可以填 https:// 网址';
  if (field === 'ads') return SITE_BIBCODE_RE.test(normalizeAdsBibcode(v)) || isHttpUrl(v) ? null : 'ADS 填 19 位的 bibcode（例如 2024ApJ...960..101Z）或 https:// 网址';
  if (field === 'doi') return isDoi(normalizeDoi(v)) || (isHttpUrl(v) && /doi\.org\//i.test(v)) ? null : 'DOI 的格式是 10.xxxx/…（例如 10.3847/1538-4357/ad0b1c），也可以填 https://doi.org/… 网址';
  return null;
}

/** 'https://doi.org/10.3847/x' / 'doi:10.3847/x' → '10.3847/x'。 */
export function normalizeDoi(v) {
  let s = String(v ?? '').trim();
  s = s.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '').replace(/^doi:\s*/i, '');
  try { if (/%[0-9A-Fa-f]{2}/.test(s)) s = decodeURIComponent(s); } catch { /* 原样 */ }
  return s;
}

const BIBCODE_RE = /^\d{4}[A-Za-z&.]{5}[A-Za-z0-9.&]{4}[A-Za-z0-9.][A-Za-z0-9.]{4}[A-Za-z.]$/;
/** 是不是 ADS bibcode（19 个字符，例如 2024ApJ...960..101Z）。 */
export function isBibcode(s) {
  return typeof s === 'string' && s.length === 19 && BIBCODE_RE.test(s);
}

/** ADS 网址或 bibcode → bibcode：'https://ui.adsabs.harvard.edu/abs/2024A%26A...681A..12Z/abstract' → '2024A&A...681A..12Z'。 */
export function normalizeAdsBibcode(v) {
  let s = String(v ?? '').trim();
  if (!s) return '';
  const m = /adsabs\.harvard\.edu\/(?:#?abs|abs)\/([^/?#\s]+)/i.exec(s);
  if (m) s = m[1];
  try { s = decodeURIComponent(s); } catch { /* 原样 */ }
  return s;
}

function parseMonth(raw) {
  const t = decodeLatex(raw).toLowerCase().replace(/\./g, '');
  if (/^\d{1,2}$/.test(t)) {
    const n = Number(t);
    return n >= 1 && n <= 12 ? n : null;
  }
  const idx = MONTH_NAMES.indexOf(t.slice(0, 3));
  return idx >= 0 ? idx + 1 : null;
}

/**
 * 一条 BibTeX → 论文表单的字段。
 * @param {BibEntry} entry
 * @returns {{ title: string, authors: string[], year: number|null, month: number|null, venue: string, volume: string,
 *   pages: string, status: string, kind: string, arxiv: string, ads: string, doi: string, bibtex: string, key: string }}
 */
export function bibToPublication(entry) {
  const f = entry.fields || {};
  const get = (k) => (f[k] != null ? String(f[k]) : '');
  const type = String(entry.type || '').toLowerCase();
  const yearM = /\d{4}/.exec(decodeLatex(get('year')));
  let venue = '';
  if (get('journal')) venue = journalName(get('journal'));
  else if (get('booktitle')) venue = decodeLatex(get('booktitle'));
  else if (get('school')) venue = decodeLatex(get('school'));
  else if (get('howpublished')) venue = decodeLatex(get('howpublished'));
  else if (get('publisher')) venue = decodeLatex(get('publisher'));
  else if (get('institution')) venue = decodeLatex(get('institution'));

  let pages = decodeLatex(get('pages')) || decodeLatex(get('eid'));
  let arxiv = '';
  const eprint = decodeLatex(get('eprint'));
  const prefix = decodeLatex(get('archiveprefix') || get('eprinttype'));
  if (eprint && (!prefix || /arxiv/i.test(prefix))) arxiv = normalizeArxiv(eprint);
  if (/^arxiv:/i.test(pages)) {
    if (!arxiv) arxiv = normalizeArxiv(pages);
    pages = '';
  }
  if (!isArxivId(arxiv)) arxiv = ''; // eprint = {javascript:…} 之类不是编号的值不要
  const isEprintJournal = /^arxiv\b|e-?prints?$/i.test(venue);

  let kind = 'other';
  let status = 'published';
  if (type === 'phdthesis' || type === 'mastersthesis' || type === 'thesis') kind = 'thesis';
  else if (type === 'inproceedings' || type === 'proceedings' || type === 'conference' || type === 'incollection') kind = 'proceedings';
  else if (isEprintJournal || ((type === 'misc' || type === 'unpublished' || type === 'online') && arxiv)) { kind = 'preprint'; status = 'submitted'; }
  else if (type === 'article') kind = 'refereed';
  if (type === 'unpublished' && !arxiv) status = 'in-prep';

  let ads = normalizeAdsBibcode(decodeLatexKeepAmp(get('adsurl')));
  if (!isBibcode(ads)) ads = isBibcode(entry.key) ? entry.key : (ads && /adsabs/i.test(get('adsurl')) ? ads : '');
  if (ads && !SITE_BIBCODE_RE.test(ads)) ads = ''; // 网站只认 bibcode（或 http(s) 网址），其他的值不要
  const doi = normalizeDoi(decodeLatex(get('doi')));

  return {
    title: decodeLatex(get('title')),
    authors: parseAuthors(get('author') || get('editor')),
    year: yearM ? Number(yearM[0]) : null,
    month: get('month') ? parseMonth(get('month')) : null,
    venue,
    volume: decodeLatex(get('volume')),
    pages,
    status,
    kind,
    arxiv,
    ads,
    doi: isDoi(doi) ? doi : '',
    bibtex: String(entry.raw || '').trim(),
    key: String(entry.key || ''),
  };
}

/** adsurl 里的 \& 之类：只去掉反斜杠转义（网址不做 -- → – 之类的替换）。 */
function decodeLatexKeepAmp(s) {
  return String(s ?? '').replace(/\\([&%_#$])/g, '$1').replace(/[{}]/g, '').trim();
}

// ---------------------------------------------------------------------------
// 文件名（id）

/** id 的规则：小写字母或数字开头，只含 [a-z0-9-]，最长 80。 */
export function isValidId(s) {
  return typeof s === 'string' && /^[a-z0-9][a-z0-9-]{0,79}$/.test(s);
}

/** 任意文字 → id 片段（ASCII 小写；去重音；其他字符变 -）。 */
export function slugId(text, max = 60) {
  let s = String(text ?? '')
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[øØ]/g, 'o').replace(/[łŁ]/g, 'l').replace(/ß/g, 'ss').replace(/[æÆ]/g, 'ae').replace(/[œŒ]/g, 'oe')
    .toLowerCase().replace(/['’]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (s.length > max) {
    s = s.slice(0, max);
    const cut = s.lastIndexOf('-');
    if (cut >= max / 2) s = s.slice(0, cut);
    s = s.replace(/-+$/, '');
  }
  return s;
}

/** 不和 taken 重复：base、base-2、base-3 … */
export function uniqueId(base, taken) {
  const set = new Set([...(taken || [])].map((x) => String(x).toLowerCase()));
  const b = base || 'item';
  if (!set.has(b)) return b;
  for (let i = 2; ; i++) if (!set.has(`${b}-${i}`)) return `${b}-${i}`;
}

const STOP_WORDS = new Set(['a', 'an', 'the', 'on', 'of', 'in', 'for', 'and', 'to', 'with', 'from', 'at', 'by', 'is', 'are']);

/**
 * 新论文的 id：有 ADS bibcode 用它（2024ApJ...960..101Z → 2024apj-960-101z）；否则 arXiv 号（arxiv-2603-01234）；
 * 否则「第一作者姓 + 年份 + 标题第一个实词」（zhong2024neutral）。
 */
export function publicationIdFor(pub, taken = []) {
  let base = '';
  if (pub.ads && isBibcode(pub.ads)) base = slugId(pub.ads);
  if (!base && pub.arxiv) base = slugId('arxiv-' + normalizeArxiv(pub.arxiv));
  if (!base) {
    const first = Array.isArray(pub.authors) && pub.authors[0] ? String(pub.authors[0]).split(',')[0] : '';
    const word = String(pub.title || '').split(/\s+/).map((w) => slugId(w)).find((w) => w && !STOP_WORDS.has(w)) || '';
    base = slugId(`${slugId(first).replace(/-/g, '')}${pub.year || ''}${word}`);
  }
  if (!base || !/^[a-z0-9]/.test(base)) base = 'paper' + (base ? '-' + base : '');
  return uniqueId(base.slice(0, 70).replace(/-+$/, ''), taken);
}

/** 报告的 id：'<日期>-<会议或标题>'，例如 2026-03-14-aas-247。 */
export function talkIdFor(talk, taken = []) {
  const d = isIsoDate(talk.date) ? talk.date : '';
  const word = slugId(talk.event || talk.title || '', 40) || 'talk';
  return uniqueId(d ? `${d}-${word}` : word, taken);
}

/** 近况的文件名：'<日期>-<英文文字的前几个词>'，中文文字转不出来时用 news。 */
export function newsIdFor(item, taken = []) {
  const d = isIsoDate(item.date) ? item.date : todayISO();
  const word = slugId(stripMarkdown(item.text_en || item.text || ''), 32) || 'news';
  return uniqueId(`${d}-${word}`, taken);
}

function stripMarkdown(s) {
  return String(s ?? '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[*_`~#>]/g, '');
}

// ---------------------------------------------------------------------------
// 日期

const pad2 = (n) => String(n).padStart(2, '0');

/** 本地时间的今天 'YYYY-MM-DD'。 */
export function todayISO(now = new Date()) {
  return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
}

/** 'YYYY-MM-DD' 而且是真实存在的日期。 */
export function isIsoDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s ?? ''));
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]);
}

/** YAML 里的日期可能被写成别的样子（手改的文件）：'2026-3-5'、Date 对象 → 'YYYY-MM-DD'；认不出来原样返回。 */
export function dateString(v) {
  if (v instanceof Date && !Number.isNaN(v.getTime())) return v.toISOString().slice(0, 10);
  const s = String(v ?? '').trim();
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ].*)?$/.exec(s);
  return m ? `${m[1]}-${pad2(m[2])}-${pad2(m[3])}` : s;
}

// ---------------------------------------------------------------------------
// YAML（确定性写法）

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const YAML_ESCAPE = new RegExp('[\\x7F-\\x9F' + [0x2028, 0x2029, 0xfeff, 0xfffe, 0xffff].map((c) => String.fromCharCode(c)).join('') + ']', 'g');

export class AcademicDataError extends Error {
  constructor(message) { super(message); this.name = 'AcademicDataError'; }
}

function quoted(s) {
  if (LONE_SURROGATE.test(s)) throw new AcademicDataError('文字里有无法保存的特殊字符，请删掉后重试');
  return JSON.stringify(s).replace(YAML_ESCAPE, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
}

/** 多行文字能不能安全地写成 |- 块（没有制表符 / 控制字符，行尾没有空白，首行不以空格开头）。 */
function blockSafe(s) {
  if (!s.includes('\n')) return false;
  if (/[\t\r\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f\u2028\u2029\ufeff]/.test(s)) return false;
  if (/^[ \n]/.test(s) || /\n$/.test(s)) return false;
  if (/ \n|[ ]$/.test(s)) return false;
  return true;
}

function scalarText(v) {
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new AcademicDataError('数字无效');
    return String(v);
  }
  if (v === null) return 'null';
  return quoted(String(v));
}

/**
 * 把一个（一层）对象写成 YAML：order 里的键在前，其余按对象顺序；undefined / '' / null 的键跳过。
 * 字符串双引号（JSON 转义）；多行字符串（安全时）用 |- 块；字符串数组每项一行（- "…"）；
 * 嵌套对象 / 其他数组写成单行 JSON（也是合法 YAML）。结果以换行结尾，并重新解析校验。
 * @param {Record<string, any>} obj
 * @param {readonly string[]} [order]
 * @returns {string}
 */
export function dumpYaml(obj, order = []) {
  const own = Object.keys(obj || {});
  const keys = [...order.filter((k) => own.includes(k)), ...own.filter((k) => !order.includes(k))];
  const lines = [];
  const expected = {};
  for (const k of keys) {
    const v = obj[k];
    if (v === undefined || v === null || v === '') continue;
    if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(k)) throw new AcademicDataError(`字段名「${k}」不支持`);
    expected[k] = v;
    if (Array.isArray(v)) {
      if (!v.length) { lines.push(`${k}: []`); continue; }
      if (v.every((x) => typeof x === 'string' || typeof x === 'number' || typeof x === 'boolean')) {
        lines.push(`${k}:`);
        for (const x of v) lines.push(`  - ${scalarText(x)}`);
      } else {
        lines.push(`${k}: ${jsonFlow(v)}`);
      }
      continue;
    }
    if (v && typeof v === 'object') { lines.push(`${k}: ${jsonFlow(v)}`); continue; }
    if (typeof v === 'string' && blockSafe(v)) {
      lines.push(`${k}: |-`);
      for (const l of v.split('\n')) lines.push(l === '' ? '' : `  ${l}`);
      continue;
    }
    lines.push(`${k}: ${scalarText(v)}`);
  }
  const out = lines.join('\n') + '\n';
  const back = parseYamlEntry(out);
  if (!deepEqual(back, expected)) throw new AcademicDataError('生成的文件校验未通过，已取消（文件没有被改动）');
  return out;
}

function jsonFlow(v) {
  // JSON 是 YAML 的子集；字符串部分用 quoted 处理特殊字符
  if (Array.isArray(v)) return `[${v.map(jsonFlow).join(', ')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).map((k) => `${quoted(k)}: ${jsonFlow(v[k])}`).join(', ')}}`;
  return scalarText(v);
}

/**
 * 解析一个数据文件（CORE_SCHEMA：日期保持字符串）。
 * @throws {AcademicDataError}
 */
export function parseYamlEntry(text) {
  let data;
  try {
    data = yaml.load(String(text ?? '').replace(/^\uFEFF/, ''), { schema: yaml.CORE_SCHEMA });
  } catch (e) {
    const line = e && e.mark && typeof e.mark.line === 'number' ? `（第 ${e.mark.line + 1} 行）` : '';
    throw new AcademicDataError(`文件格式有误${line}：${(e && e.reason) || (e && e.message) || e}`);
  }
  if (data === null || data === undefined) return {};
  if (typeof data !== 'object' || Array.isArray(data)) throw new AcademicDataError('文件不是「键: 值」的格式');
  return data;
}

/**
 * 表单的值 → 要写进文件的对象（按 FIELD_ORDER；去掉空值；年 / 月转数字；selected 只在 true 时写）。
 * @param {'publications'|'talks'|'news'} kind
 * @param {Record<string, any>} values
 */
export function cleanEntry(kind, values) {
  const order = FIELD_ORDER[kind];
  const out = {};
  for (const k of order) {
    let v = values[k];
    if (v === undefined || v === null) continue;
    if (LIST_FIELDS.has(k)) {
      const list = (Array.isArray(v) ? v : String(v).split('\n')).map((x) => String(x).trim()).filter(Boolean);
      if (list.length) out[k] = list;
      continue;
    }
    if (INT_FIELDS.has(k)) {
      const n = typeof v === 'number' ? v : String(v).trim() === '' ? NaN : Number(String(v).trim());
      if (Number.isInteger(n)) out[k] = n;
      continue;
    }
    if (BOOL_FIELDS.has(k)) {
      if (v === true || v === 'true') out[k] = true;
      continue;
    }
    const s = String(v).replace(/\r\n?/g, '\n');
    const t = k === 'bibtex' || k === 'abstract' || k === 'text' || k === 'text_en' || k === 'text_zh' || k === 'note'
      ? s.replace(/[ \t]+(?=\n|$)/g, '').replace(/^\n+|\s+$/g, '') : s.trim();
    if (t !== '') out[k] = t;
  }
  return out;
}

/**
 * 生成数据文件的新内容。
 *   - 新文件（oldText 为空）：dumpYaml(cleanEntry(…))。
 *   - 已有文件、而且是本后台的标准写法：整份重写（不认识的键保留在后面）。
 *   - 已有文件、被手改过（有注释、别的写法）：只改变化了的键（frontmatter.setFields，注释和其他行原样保留）。
 * @param {'publications'|'talks'|'news'} kind
 * @param {Record<string, any>} values 表单的值
 * @param {string|null} [oldText]
 * @returns {string}
 */
export function entryFileText(kind, values, oldText = null) {
  const order = FIELD_ORDER[kind];
  const next = cleanEntry(kind, values);
  if (oldText == null || String(oldText).trim() === '') return dumpYaml(next, order);
  const src = String(oldText).replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  const old = parseYamlEntry(src);
  const unknown = {};
  for (const k of Object.keys(old)) if (!order.includes(k)) unknown[k] = old[k];
  if (isCanonical(src, old, order)) return dumpYaml({ ...next, ...unknown }, order);
  const updates = {};
  for (const k of order) {
    const has = Object.prototype.hasOwnProperty.call(old, k);
    if (k in next) {
      if (!has || !deepEqual(normalizeOld(k, old[k]), next[k])) updates[k] = next[k];
    } else if (has && !(BOOL_FIELDS.has(k) && old[k] === false)) {
      updates[k] = undefined;
    }
  }
  if (!Object.keys(updates).length) return src;
  try {
    const out = setFields(src.replace(/\n$/, ''), updates);
    return out.endsWith('\n') ? out : out + '\n';
  } catch (err) {
    throw new AcademicDataError(`这个文件是手动写的，自动修改时校验未通过，已取消：${err && err.message ? err.message : err}`);
  }
}

/** 旧文件里的值和表单比较前先统一（手写的 year: "2024"、date: 2026-03-05 等）。 */
function normalizeOld(k, v) {
  if (INT_FIELDS.has(k) && typeof v === 'string' && /^\d+$/.test(v.trim())) return Number(v.trim());
  if (typeof v === 'string' && !LIST_FIELDS.has(k)) return v;
  return v;
}

function isCanonical(src, old, order) {
  try { return dumpYaml(old, order) === (src.endsWith('\n') ? src : src + '\n'); } catch { return false; }
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    return ka.length === kb.length && ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && deepEqual(a[k], b[k]));
  }
  return false;
}

/**
 * 读出来的数据文件 → 表单值（所有字段都变成字符串 / 数组 / 布尔，缺的为空）。
 * @param {'publications'|'talks'|'news'} kind
 * @param {Record<string, any>} data
 */
export function formValues(kind, data) {
  const out = {};
  for (const k of FIELD_ORDER[kind]) {
    const v = data ? data[k] : undefined;
    if (LIST_FIELDS.has(k)) out[k] = Array.isArray(v) ? v.map((x) => String(x)) : v == null || v === '' ? [] : [String(v)];
    else if (BOOL_FIELDS.has(k)) out[k] = v === true || v === 'true';
    else if (k === 'date') out[k] = v == null ? '' : dateString(v);
    else out[k] = v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
  }
  return out;
}

/** 'data/publications/abc.yaml' → 'abc'（不是这个目录下的 .yaml / .yml 返回 null）。 */
export function idFromPath(path, dataDir) {
  const p = String(path || '');
  if (!p.startsWith(dataDir + '/')) return null;
  const rest = p.slice(dataDir.length + 1);
  const m = /^([^/]+)\.ya?ml$/i.exec(rest);
  return m ? m[1] : null;
}

// ---------------------------------------------------------------------------
// 排序与分组

/** 按类型分组时的三组（和网站 layouts/partials/academic/publications.html 一样）。 */
export const PUB_GROUPS = Object.freeze(['refereed', 'pending', 'other']);
export const PUB_GROUP_LABELS = Object.freeze({ refereed: '同行评审', pending: '已投稿与准备中', other: '会议论文与其他' });

/** 一篇论文在「按类型」分组时属于哪一组：status 是 submitted / in-prep → pending；kind = refereed → refereed；其余 other。 */
export function pubGroupOf(p) {
  const status = String(p.status || 'published').toLowerCase();
  if (status === 'submitted' || status === 'in-prep') return 'pending';
  let kind = String(p.kind || '').toLowerCase();
  if (!kind) kind = String(p.venue || '').toLowerCase() === 'arxiv e-prints' ? 'preprint' : 'refereed';
  return kind === 'refereed' ? 'refereed' : 'other';
}

/** 排序键：'YYYY-MM'；没写年份的排在最前（通常是准备中的论文），和网站一样。 */
function pubSortKey(p) {
  const y = Number(p.year) || 0;
  const m = Number(p.month) || 0;
  return y > 0 ? `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}` : '9999-99';
}

function pubCompare(a, b) {
  const ka = pubSortKey(a);
  const kb = pubSortKey(b);
  if (ka !== kb) return ka < kb ? 1 : -1;
  return String(a.title || '').localeCompare(String(b.title || '')) || String(a.id || '').localeCompare(String(b.id || ''));
}

/**
 * 论文分组（和网站一样）：'kind' = 同行评审 / 已投稿与准备中 / 会议论文与其他；'year' = 按年份从新到旧（没有年份的在最前）。
 * 每组里按年、月从新到旧（没有年份的在最前），同一个月按标题。空的组不返回。
 * @param {Array<object>} list 每项至少有 year / month / title / kind / status
 * @param {string} groupBy
 * @returns {Array<{ key: string, label: string, items: object[] }>}
 */
export function groupPublications(list, groupBy = 'kind') {
  const sorted = [...(list || [])].sort(pubCompare);
  const groups = new Map();
  const byYear = String(groupBy || '').toLowerCase() === 'year';
  for (const p of sorted) {
    const key = byYear ? (Number(p.year) > 0 ? String(Number(p.year)) : '') : pubGroupOf(p);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(p);
  }
  const keys = byYear ? [...groups.keys()] : PUB_GROUPS.filter((k) => groups.has(k));
  return keys.map((key) => ({
    key,
    label: byYear ? (key || '年份未填') : PUB_GROUP_LABELS[key],
    items: groups.get(key),
  }));
}

/** 报告分成「即将进行」（今天及以后，从近到远）和「过去的」（从近到远）。 */
export function splitTalks(list, today = todayISO()) {
  const upcoming = [];
  const past = [];
  for (const t of list || []) (dateString(t.date) >= today ? upcoming : past).push(t);
  const byDate = (a, b) => dateString(a.date).localeCompare(dateString(b.date)) || String(a.id || '').localeCompare(String(b.id || ''));
  upcoming.sort(byDate);
  past.sort((a, b) => byDate(b, a));
  return { upcoming, past };
}

/** 近况从新到旧。 */
export function sortNews(list) {
  return [...(list || [])].sort((a, b) => dateString(b.date).localeCompare(dateString(a.date)) || String(b.id || '').localeCompare(String(a.id || '')));
}

function nameKey(s) {
  return String(s ?? '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

/** 作者是不是「我」（和 myNames 里任何一种写法相同，忽略大小写、空格、点和重音）。 */
export function isMyName(author, myNames) {
  const k = nameKey(author);
  return !!k && (myNames || []).some((n) => nameKey(n) === k);
}

// ---------------------------------------------------------------------------
// 社交链接（首页设置）

/** 每种学术图标的网址提示（输入框的 placeholder）。 */
export const SOCIAL_HINTS = Object.freeze({
  orcid: '0000-0000-0000-0000 或 https://orcid.org/…',
  googlescholar: 'https://scholar.google.com/citations?user=…',
  ads: 'ADS 检索 / 文献库网址，或直接写署名如 Zhong, F.',
  arxiv: 'https://arxiv.org/a/… 或 arXiv 作者号如 zhong_f_1',
  cv: '/documents/cv/….pdf（建议用上面的「简历 CV」卡片上传）',
  bluesky: '@name.bsky.social 或 https://bsky.app/profile/…',
  mastodon: '@用户名@实例 或 https://实例/@用户名',
  linkedin: 'https://www.linkedin.com/in/…',
  researchgate: 'https://www.researchgate.net/profile/…',
  github: 'https://github.com/…',
  email: 'mailto:me@example.com',
});

const ORCID_ID = /^(\d{4})-?(\d{4})-?(\d{4})-?(\d{3}[\dXx])$/;

/** ORCID 的校验位（ISO 7064 11,2）对不对。 */
export function orcidChecksumOk(id) {
  const digits = String(id).replace(/-/g, '').toUpperCase();
  if (!/^\d{15}[\dX]$/.test(digits)) return false;
  let total = 0;
  for (let i = 0; i < 15; i++) total = (total + Number(digits[i])) * 2;
  const r = (12 - (total % 11)) % 11;
  return digits[15] === (r === 10 ? 'X' : String(r));
}

/**
 * 根据图标把用户填的东西补成完整网址（离开输入框时调用）：
 *   orcid '0000-0002-1825-0097' → 'https://orcid.org/0000-0002-1825-0097'；
 *   googlescholar 'AbCdEfGAAAAJ' → 'https://scholar.google.com/citations?user=AbCdEfGAAAAJ'；
 *   ads 'Zhong, F.' → ADS 作者检索；arxiv 'zhong_f_1' → 'https://arxiv.org/a/zhong_f_1'；
 *   bluesky '@x.bsky.social' → 'https://bsky.app/profile/x.bsky.social'；mastodon '@me@astro.social' → 'https://astro.social/@me'；
 *   linkedin 'in/me' / 'me' → 'https://www.linkedin.com/in/me'；researchgate 'First-Last' → 'https://www.researchgate.net/profile/First-Last'；
 *   email 'me@x.org' → 'mailto:me@x.org'。认不出来就只去掉首尾空白。
 */
export function normalizeSocialUrl(name, value) {
  const v = String(value ?? '').trim();
  if (!v) return v;
  const n = String(name || '').toLowerCase();
  const isUrl = /^(https?:|mailto:|tel:)/i.test(v) || v.startsWith('/');
  const bareHost = (re) => (re.test(v) ? 'https://' + v.replace(/^\/+/, '') : null);
  switch (n) {
    case 'email':
      return /^[^@\s:/]+@[^@\s/]+\.[^@\s/]+$/.test(v) ? 'mailto:' + v : v;
    case 'orcid': {
      const id = v.replace(/^https?:\/\/(?:www\.)?orcid\.org\//i, '').replace(/^orcid\.org\//i, '').replace(/\/+$/, '');
      const m = ORCID_ID.exec(id);
      return m ? `https://orcid.org/${m[1]}-${m[2]}-${m[3]}-${m[4].toUpperCase()}` : v;
    }
    case 'googlescholar': {
      if (isUrl) return v;
      const host = bareHost(/^scholar\.google\./i);
      if (host) return host;
      const id = v.replace(/^user=/i, '');
      return /^[A-Za-z0-9_-]{12}$/.test(id) ? `https://scholar.google.com/citations?user=${id}` : v;
    }
    case 'ads': {
      if (isUrl) return v;
      const host = bareHost(/^ui\.adsabs\.harvard\.edu\//i);
      if (host) return host;
      if (/^[^,]+,\s*\S/.test(v)) return `https://ui.adsabs.harvard.edu/search/q=${encodeURIComponent(`author:"${v}"`)}&sort=date%20desc`;
      return v;
    }
    case 'arxiv': {
      if (isUrl) return v;
      const host = bareHost(/^arxiv\.org\//i);
      if (host) return host;
      return /^[a-z][a-z0-9_]*_\d+$/i.test(v) ? `https://arxiv.org/a/${v.toLowerCase()}` : v;
    }
    case 'bluesky': {
      if (isUrl) return v;
      const h = v.replace(/^@/, '');
      return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(h) ? `https://bsky.app/profile/${h}` : v;
    }
    case 'mastodon': {
      if (isUrl) return v;
      const m = /^@?([A-Za-z0-9_]+)@([a-z0-9-]+(?:\.[a-z0-9-]+)+)$/i.exec(v);
      return m ? `https://${m[2]}/@${m[1]}` : v;
    }
    case 'linkedin': {
      if (isUrl) return v;
      const host = bareHost(/^(?:www\.)?linkedin\.com\//i);
      if (host) return host;
      const slug = v.replace(/^in\//i, '').replace(/\/+$/, '');
      return /^[A-Za-z0-9_%-]+$/.test(slug) ? `https://www.linkedin.com/in/${slug}` : v;
    }
    case 'researchgate': {
      if (isUrl) return v;
      const host = bareHost(/^(?:www\.)?researchgate\.net\//i);
      if (host) return host;
      const slug = v.replace(/^profile\//i, '');
      return /^[A-Za-z0-9_-]+$/.test(slug) ? `https://www.researchgate.net/profile/${slug}` : v;
    }
    case 'github': {
      if (isUrl) return v;
      const host = bareHost(/^github\.com\//i);
      return host || v;
    }
    default:
      return v;
  }
}

function hostOf(u) {
  try { return new URL(u).hostname.toLowerCase(); } catch { return ''; }
}

/** 学术图标的网址看起来不对时的提醒（不阻止保存）。没问题返回 null。 */
export function socialUrlWarning(name, url) {
  const u = String(url ?? '').trim();
  if (!u) return null;
  const n = String(name || '').toLowerCase();
  const host = hostOf(u);
  switch (n) {
    case 'orcid': {
      const m = /^https:\/\/orcid\.org\/(\d{4}-\d{4}-\d{4}-\d{3}[\dX])$/.exec(u);
      if (!m) return 'ORCID 链接应该是 https://orcid.org/0000-0000-0000-0000 这样（16 位数字，最后一位可能是 X）';
      if (!orcidChecksumOk(m[1])) return 'ORCID 号码的校验位不对，请对照 orcid.org 上的号码再检查一遍';
      return null;
    }
    case 'googlescholar':
      return /^scholar\.google\./.test(host) ? null : 'Google 学术的链接应该在 scholar.google.com 上（个人主页地址里有 user=…）';
    case 'ads':
      return host === 'ui.adsabs.harvard.edu' || host.endsWith('adsabs.harvard.edu') ? null : 'NASA ADS 的链接应该在 ui.adsabs.harvard.edu 上';
    case 'arxiv':
      return host === 'arxiv.org' || host.endsWith('.arxiv.org') ? null : 'arXiv 的链接应该在 arxiv.org 上';
    case 'bluesky':
      return host === 'bsky.app' || /^https:\/\//.test(u) ? null : 'Bluesky 的链接一般是 https://bsky.app/profile/…';
    case 'linkedin':
      return /(^|\.)linkedin\.com$/.test(host) ? null : 'LinkedIn 的链接应该在 linkedin.com 上';
    case 'researchgate':
      return /(^|\.)researchgate\.net$/.test(host) ? null : 'ResearchGate 的链接应该在 researchgate.net 上';
    case 'mastodon':
      return /^https:\/\/[^/]+\/@[^/]+/.test(u) ? null : 'Mastodon 的链接一般是 https://实例/@用户名';
    case 'cv':
      return u.startsWith('/') || /^https?:/i.test(u) ? null : '简历链接请写网站路径（/documents/cv/…）或 https:// 网址';
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// 顶部菜单

/** 去掉 menu 里的 main（其他菜单保留）；去掉后什么都不剩时返回 undefined（= 删除 menu 键）。 */
export function menuWithoutMain(menu) {
  if (menu == null) return undefined;
  if (typeof menu === 'string') return menu === 'main' ? undefined : menu;
  if (Array.isArray(menu)) {
    const rest = menu.filter((m) => m !== 'main');
    return rest.length ? rest : undefined;
  }
  if (typeof menu === 'object') {
    const out = { ...menu };
    delete out.main;
    return Object.keys(out).length ? out : undefined;
  }
  return menu;
}

/** 排在已有菜单项后面的顺序值：最大值 + 10（取整到 10）；没有时 10。 */
export function nextMenuWeight(weights) {
  const nums = (weights || []).filter((w) => typeof w === 'number' && Number.isFinite(w));
  if (!nums.length) return 10;
  return Math.floor(Math.max(...nums) / 10) * 10 + 10;
}

/**
 * 页面不存在时新建的 _index 文件（和网站自带的 content/<栏目>/_index*.md 的中性文字一样）。
 * @param {'publications'|'talks'|'news'} section
 * @param {string} lang 'en' / 'zh'（其他语言用英文）
 * @param {number|null} weight null = 不加菜单
 */
export function academicIndexDocument(section, lang, weight = null) {
  const def = SECTIONS[section];
  const title = def.titles[lang] || def.titles.en;
  const description = def.descriptions[lang] || def.descriptions.en;
  let fm = `title: ${quoted(title)}\ndescription: ${quoted(description)}`;
  if (weight != null) fm += `\nmenu:\n  main:\n    weight: ${Number(weight)}`;
  return `---\n${fm}\n---\n`;
}
