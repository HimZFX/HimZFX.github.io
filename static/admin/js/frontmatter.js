// frontmatter.js — YAML front matter：拆分 / 解析 / 精确修改 / 重新拼装。
//
// 设计原则：用户的文件比我们的代码重要。
//   * 只改动被要求修改的键所在的行，其余行（尤其是注释）原样保留。
//   * 每次写入后都用 js-yaml 重新解析结果，与「期望结果」逐项比对；
//     不一致就抛出 FrontMatterError，绝不返回一个悄悄写错的文件。
//
// 本模块在导入时不访问 window / document（单元测试在 Node 里直接导入）。

import * as yaml from '../vendor/js-yaml/js-yaml.mjs';

/** 所有面向用户的错误都用这个类型；message 是中文。 */
export class FrontMatterError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'FrontMatterError';
  }
}

const FM_NAME = '文章开头的设置区（front matter）';
const VERIFY_FAILED =
  '自动修改文章设置时校验未通过。为避免写错文件，本次修改已取消（文件没有被改动）。' +
  '可以检查文件开头 --- 之间的格式，或改用手动编辑。';

const DEFAULT_ORDER = ['title', 'linkTitle', 'date', 'draft', 'description', 'tags', 'categories',
  'cover', 'menu', 'math', 'comments', 'background'];

// ---------------------------------------------------------------------------
// 拆分与拼装
// ---------------------------------------------------------------------------

/**
 * 把一个 Markdown 文件拆成 front matter 和正文。
 *
 * 规范化：去掉开头的 BOM，'\r\n' 统一成 '\n'（之后 buildDocument 写回时就是 LF）。
 *
 * @param {string} text 文件全文
 * @returns {{ fmText: string|null, body: string, kind: 'yaml'|'toml'|'none' }}
 *   fmText 不含上下两条分隔线；body 是结束分隔线之后的全部内容（原样，可能以空行开头）。
 * @throws {FrontMatterError} 有开头的 --- / +++ 却找不到结束分隔线
 */
export function splitDocument(text) {
  const s = normalizeNewlines(stripBom(String(text ?? '')));
  for (const [delim, kind] of [['---', 'yaml'], ['+++', 'toml']]) {
    const firstNl = s.indexOf('\n');
    if (firstNl < 0 || !isDelimiterLine(s.slice(0, firstNl), delim)) continue;
    // 结束分隔线：之后第一条只包含 --- (或 +++) 的行（允许行尾空白）。逐行找，不用多行正则，
    // 以免 U+2028 之类的字符被正则当成换行。
    let lineStart = firstNl + 1;
    while (lineStart <= s.length) {
      let lineEnd = s.indexOf('\n', lineStart);
      if (lineEnd < 0) lineEnd = s.length;
      if (isDelimiterLine(s.slice(lineStart, lineEnd), delim)) {
        const fmText = lineStart === firstNl + 1 ? '' : s.slice(firstNl + 1, lineStart - 1);
        const body = lineEnd < s.length ? s.slice(lineEnd + 1) : '';
        return { fmText, body, kind };
      }
      if (lineEnd >= s.length) break;
      lineStart = lineEnd + 1;
    }
    throw new FrontMatterError(`${FM_NAME}缺少结束的 ${delim} 行`);
  }
  return { fmText: null, body: s, kind: 'none' };
}

/**
 * 拼装文件：'---\n' + fmText（去掉末尾换行）+ '\n---\n\n' + 正文（去掉开头空行，末尾恰好一个 '\n'）。
 * fmText 为 null → 只输出正文。正文为空时文件以 '---\n' 结尾（不留多余空行）。
 *
 * @param {string|null} fmText
 * @param {string} body
 * @returns {string}
 */
export function buildDocument(fmText, body) {
  let b = normalizeNewlines(String(body ?? ''));
  let end = b.length; // 去掉末尾空白（手写循环，避免长空白串让正则回溯变慢）
  while (end > 0 && (b[end - 1] === ' ' || b[end - 1] === '\t' || b[end - 1] === '\n')) end--;
  b = b.slice(0, end);
  if (fmText === null || fmText === undefined) {
    return b ? b + '\n' : '';
  }
  b = b.replace(/^(?:[ \t]*\n)+/, '');
  const fm = normalizeNewlines(stripBom(String(fmText))).replace(/\n+$/, '');
  const head = fm === '' ? '---\n---\n' : `---\n${fm}\n---\n`;
  return b ? `${head}\n${b}\n` : head;
}

// ---------------------------------------------------------------------------
// 解析
// ---------------------------------------------------------------------------

/**
 * 解析 YAML front matter（CORE_SCHEMA：日期保持为字符串）。null / 空 → {}。
 * @param {string|null} fmText
 * @returns {object}
 * @throws {FrontMatterError} YAML 语法错误，或顶层不是「键: 值」映射
 */
export function parseFrontMatter(fmText) {
  if (fmText === null || fmText === undefined) return {};
  const src = normalizeNewlines(stripBom(String(fmText)));
  let data;
  try {
    data = yaml.load(src, { schema: yaml.CORE_SCHEMA });
  } catch (e) {
    throw new FrontMatterError(`${FM_NAME}格式有误：${yamlReason(e)}`, { cause: e });
  }
  if (data === null || data === undefined) return {};
  if (!isPlainObject(data)) {
    throw new FrontMatterError(`${FM_NAME}不是「键: 值」的格式`);
  }
  return data;
}

// ---------------------------------------------------------------------------
// 精确修改
// ---------------------------------------------------------------------------

/**
 * 修改顶层字段，其余行原样保留。
 *
 * - updates 的每个键：值为 undefined → 删除该键；与文件里现有值相同 → 不动那一行（保留原写法）；
 *   键已存在 → 替换它的整个范围（键所在行 + 属于它的缩进行 / 列表项）；单行值被替换成单行值时
 *   保留行尾 `# 注释`；键不存在 → 追加到末尾。
 * - 例外（为了保留注释）：旧值是块状映射（如 `menu:\n  main:\n    weight: 10  # 注释`）且新值也是
 *   对象时，逐层只改变化的子键，而不是把整块改写成一行。
 * - 序列化（单行、合法 YAML）：字符串 → 双引号（JSON 转义）；布尔 / 数字 → 字面量；null → null；
 *   数组 → `["a", "b"]`；对象 → `{ key: value }`（可嵌套）。
 * - 校验：重新解析结果，必须等于 { ...原内容, ...updates（去掉 undefined） }，否则抛错。
 *
 * @param {string|null} fmText
 * @param {Record<string, any>} updates
 * @returns {string} 新的 fmText（换行统一为 '\n'）
 * @throws {FrontMatterError}
 */
export function setFields(fmText, updates) {
  const src = normalizeNewlines(stripBom(String(fmText ?? '')));
  const before = parseFrontMatter(src);
  if (!updates || typeof updates !== 'object') return src;

  const lines = src.split('\n');
  // 如果文本以 '\n' 结尾，split 的最后一个元素是 ''，它只是行终止符，不参与扫描。
  const hasTerminator = src.endsWith('\n');
  const contentEnd = hasTerminator ? lines.length - 1 : lines.length;
  const entries = scanEntries(lines, 0, contentEnd, 0);

  const ops = [];      // { start, end, lines: string[] } —— 用新行替换 [start, end)
  const appends = [];  // 新键，追加到末尾
  const expected = { ...before };

  for (const key of Object.keys(updates)) {
    const value = updates[key];
    const has = Object.prototype.hasOwnProperty.call(before, key);
    const entry = entries.find((e) => e.key === key);
    if (value === undefined) {
      if (!has) continue; // 本来就没有这个键：什么都不做
      delete expected[key];
      // 找不到对应的行时不动文本，交给校验报错（不能假装删掉了）
      if (entry) ops.push({ start: entry.start, end: entry.end, lines: [] });
      continue;
    }
    const norm = normalizeValue(value, key);
    expected[key] = norm;
    if (has && deepEqual(before[key], norm)) continue; // 值没变：原样保留（引号风格、注释都不动）
    if (!entry) {
      appends.push(`${yamlKey(key)}: ${yamlValue(norm, key)}`);
      continue;
    }
    patchEntry(lines, entry, 0, before[key], norm, key, ops);
  }
  if (!ops.length && !appends.length && !deepEqual(expected, before)) {
    // 有改动却一行都没动（例如要删的键找不到所在行）：拒绝，而不是悄悄忽略
    verify(src, expected);
  }

  if (!ops.length && !appends.length) return src;

  // 从后往前应用。起点相同时：先处理非空范围，再处理插入（插入落在范围之前）；
  // 同一位置的多个插入，后登记的（外层映射的新键）先插，先登记的（内层新键）后插、排在它前面。
  ops.forEach((op, i) => { op.seq = i; });
  ops.sort((a, b) => (b.start - a.start) || (b.end - a.end) || (b.seq - a.seq));
  for (const op of ops) lines.splice(op.start, op.end - op.start, ...op.lines);
  if (appends.length) {
    const at = hasTerminator ? lines.length - 1 : lines.length;
    // 空文本（且没有行终止符）时 lines 是 ['']，直接替换掉这个空行
    if (!hasTerminator && lines.length === 1 && lines[0] === '') lines.splice(0, 1, ...appends);
    else lines.splice(at, 0, ...appends);
  }
  const out = lines.join('\n');
  verify(out, expected);
  return out;
}

/**
 * 为新文件生成 fmText。order 中的键排在前面，其余按对象自身顺序；undefined 的键跳过。
 * @param {Record<string, any>} fields
 * @param {string[]} [order]
 * @returns {string}
 */
export function newFrontMatter(fields, order = DEFAULT_ORDER) {
  const f = fields || {};
  const own = Object.keys(f);
  const keys = [...order.filter((k) => own.includes(k)), ...own.filter((k) => !order.includes(k))]
    .filter((k) => f[k] !== undefined);
  const expected = {};
  const lines = keys.map((k) => {
    const norm = normalizeValue(f[k], k);
    expected[k] = norm;
    return `${yamlKey(k)}: ${yamlValue(norm, k)}`;
  });
  const out = lines.join('\n');
  verify(out, expected);
  return out;
}

// ---------------------------------------------------------------------------
// 内部：按行扫描映射
// ---------------------------------------------------------------------------

/**
 * 在 lines[from, to) 中找出缩进恰好为 indent 的映射键，每个键的范围包括：
 * 键所在行、之后更深缩进的行、同缩进的 `- ` 列表项、以及夹在这些行之间的空行和注释行。
 * 键范围末尾的空行 / 注释行不算在内（它们可能属于下一个键）。
 */
function scanEntries(lines, from, to, indent) {
  const entries = [];
  let cur = null;
  let lastContent = -1;
  for (let i = from; i < to; i++) {
    const line = lines[i];
    const ind = countSpaces(line);
    const t = line.slice(ind);
    const blank = /^[ \t]*$/.test(t);
    const comment = !blank && t[0] === '#';
    if (blank) continue;
    if (comment) {
      // 块标量（| 或 >）里以 # 开头的缩进行是内容，不是注释
      if (cur && cur.blockScalar && ind > indent) lastContent = i;
      continue;
    }
    if (ind === indent && t[0] !== '\t') {
      const k = matchKey(t);
      if (k) {
        if (cur) { cur.end = lastContent + 1; entries.push(cur); }
        const rest = t.slice(k.colonEnd);
        cur = {
          key: k.key, keyRaw: k.raw, start: i, end: i + 1, indent,
          rest, blockScalar: /^[ \t]*[|>]/.test(rest),
        };
        lastContent = i;
        continue;
      }
    }
    // 其他行（更深缩进、`- ` 列表项、多行标量的续行）都属于当前键
    if (cur) lastContent = i;
  }
  if (cur) { cur.end = lastContent + 1; entries.push(cur); }
  return entries;
}

/**
 * 生成替换 entry 的操作（追加到 ops）。旧值和新值都是对象、且旧值是块状映射时逐层修改；
 * 否则整段替换为一行 `key: <value>`。
 */
function patchEntry(lines, entry, indent, oldVal, newVal, path, ops) {
  if (isPlainObject(oldVal) && isPlainObject(newVal) &&
      Object.keys(oldVal).length && Object.keys(newVal).length &&
      entry.end - entry.start > 1 && /^[ \t]*(#.*)?$/.test(entry.rest)) {
    const childIndent = firstContentIndent(lines, entry.start + 1, entry.end);
    if (childIndent > indent) {
      const children = scanEntries(lines, entry.start + 1, entry.end, childIndent);
      const names = children.map((c) => c.key);
      const oldKeys = Object.keys(oldVal);
      const consistent = names.length === oldKeys.length && new Set(names).size === names.length &&
        names.every((n) => Object.prototype.hasOwnProperty.call(oldVal, n));
      // 第一个子键之前、或子键之间不应有不认识的内容；scanEntries 已把它们并入子键范围。
      if (consistent && children.length && children[0].start === firstContentLine(lines, entry.start + 1, entry.end)) {
        for (const child of children) {
          const k = child.key;
          if (!Object.prototype.hasOwnProperty.call(newVal, k)) {
            ops.push({ start: child.start, end: child.end, lines: [] });
          } else if (!deepEqual(oldVal[k], newVal[k])) {
            patchEntry(lines, child, childIndent, oldVal[k], newVal[k], `${path}.${k}`, ops);
          }
        }
        const pad = ' '.repeat(childIndent);
        const added = Object.keys(newVal)
          .filter((k) => !Object.prototype.hasOwnProperty.call(oldVal, k))
          .map((k) => `${pad}${yamlKey(k)}: ${yamlValue(newVal[k], `${path}.${k}`)}`);
        if (added.length) {
          const at = children[children.length - 1].end;
          ops.push({ start: at, end: at, lines: added });
        }
        return;
      }
    }
  }
  // 整段替换成一行
  const pad = ' '.repeat(indent);
  const gapMatch = /^[ \t]*/.exec(entry.rest)[0];
  const restTrim = entry.rest.slice(gapMatch.length);
  const gap = gapMatch && restTrim && restTrim[0] !== '#' ? gapMatch : ' ';
  let comment = '';
  if (entry.end - entry.start === 1) {
    const c = splitTrailingComment(lines[entry.start].slice(indent));
    if (c) comment = c.comment;
  }
  const line = `${pad}${entry.keyRaw}:${gap}${yamlValue(newVal, path)}${comment}`;
  ops.push({ start: entry.start, end: entry.end, lines: [line] });
}

function firstContentLine(lines, from, to) {
  for (let i = from; i < to; i++) {
    const t = lines[i].replace(/^[ \t]+/, '');
    if (t !== '' && t[0] !== '#') return i;
  }
  return -1;
}

function firstContentIndent(lines, from, to) {
  const i = firstContentLine(lines, from, to);
  return i < 0 ? -1 : countSpaces(lines[i]);
}

/**
 * 识别一行（已去掉缩进）开头的映射键。返回 { key, raw, colonEnd } 或 null。
 * 支持普通键、双引号键、单引号键；不识别 `- `、`? ` 等复杂写法（交给校验兜底）。
 */
function matchKey(s) {
  if (!s) return null;
  const c = s[0];
  if (c === '"' || c === "'") {
    let i = 1;
    if (c === '"') {
      while (i < s.length && s[i] !== '"') { if (s[i] === '\\') i++; i++; }
    } else {
      while (i < s.length) {
        if (s[i] === "'") { if (s[i + 1] === "'") { i += 2; continue; } break; }
        i++;
      }
    }
    if (i >= s.length) return null;
    const raw = s.slice(0, i + 1);
    let j = i + 1;
    while (s[j] === ' ' || s[j] === '\t') j++;
    if (s[j] !== ':') return null;
    if (j + 1 < s.length && s[j + 1] !== ' ' && s[j + 1] !== '\t') return null;
    let key;
    try {
      key = c === '"' ? yaml.load(raw, { schema: yaml.CORE_SCHEMA }) : raw.slice(1, -1).replace(/''/g, "'");
    } catch {
      return null;
    }
    if (typeof key !== 'string') return null;
    return { key, raw, colonEnd: j + 1 };
  }
  if ('#,[]{}&*!|>%@`'.includes(c)) return null;
  if ((c === '-' || c === '?' || c === ':') && (s.length === 1 || s[1] === ' ' || s[1] === '\t')) return null;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '#' && i > 0 && (s[i - 1] === ' ' || s[i - 1] === '\t')) return null;
    if (ch === ':' && (i + 1 === s.length || s[i + 1] === ' ' || s[i + 1] === '\t')) {
      const raw = s.slice(0, i).replace(/[ \t]+$/, '');
      if (!raw) return null;
      return { key: raw, raw, colonEnd: i + 1 };
    }
  }
  return null;
}

/**
 * 找出单行 `key: value   # 注释` 的行尾注释（含它前面的空白）。
 * 做法：依次尝试在每个「空白 + #」处截断，第一个使解析结果不变的位置就是注释的起点；
 * 字符串里的 # 会让截断后的文本解析失败或得到不同的值，因此不会被误判。
 */
function splitTrailingComment(lineBody) {
  let full;
  try { full = yaml.load(lineBody, { schema: yaml.CORE_SCHEMA }); } catch { return null; }
  const re = /[ \t]+#/g;
  let m;
  while ((m = re.exec(lineBody))) {
    const cut = lineBody.slice(0, m.index);
    try {
      if (deepEqual(yaml.load(cut, { schema: yaml.CORE_SCHEMA }), full)) {
        return { valueEnd: m.index, comment: lineBody.slice(m.index) };
      }
    } catch { /* 截在字符串中间，继续找下一个 */ }
  }
  return null;
}

// ---------------------------------------------------------------------------
// 内部：序列化与校验
// ---------------------------------------------------------------------------

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/;
// js-yaml 拒绝的「不可打印」字符，以及容易被当成换行的字符：一律写成 \uXXXX 转义。
const YAML_ESCAPE = new RegExp('[\\x7F-\\x9F' + [0x2028, 0x2029, 0xfeff, 0xfffe, 0xffff]
  .map((c) => String.fromCharCode(c)).join('') + ']', 'g');

function yamlString(s) {
  if (LONE_SURROGATE.test(s)) throw new FrontMatterError('文字里有无法保存的特殊字符，请删掉后重试');
  return JSON.stringify(s).replace(YAML_ESCAPE, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
}

const YAML_RESERVED = /^(?:true|false|null|yes|no|on|off|y|n|~)$/i;
function yamlKey(k) {
  return /^[A-Za-z_][A-Za-z0-9_-]*$/.test(k) && !YAML_RESERVED.test(k) ? k : yamlString(k);
}

function yamlValue(v, path) {
  if (typeof v === 'string') return yamlString(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (v === null) return 'null';
  if (typeof v === 'number') {
    if (Number.isNaN(v)) return '.nan';
    if (v === Infinity) return '.inf';
    if (v === -Infinity) return '-.inf';
    return Object.is(v, -0) ? '0' : String(v);
  }
  if (Array.isArray(v)) return `[${v.map((x, i) => yamlValue(x, `${path}[${i}]`)).join(', ')}]`;
  if (isPlainObject(v)) {
    const parts = Object.keys(v).map((k) => `${yamlKey(k)}: ${yamlValue(v[k], `${path}.${k}`)}`);
    return parts.length ? `{ ${parts.join(', ')} }` : '{}';
  }
  throw new FrontMatterError(`字段「${path}」的值类型不支持`);
}

/** 复制一份值：去掉对象里值为 undefined 的键；遇到不支持的类型直接报错。 */
function normalizeValue(v, path) {
  if (v === null || typeof v === 'string' || typeof v === 'boolean' || typeof v === 'number') return v;
  if (Array.isArray(v)) {
    return v.map((x, i) => {
      if (x === undefined) throw new FrontMatterError(`字段「${path}」的列表里有空值`);
      return normalizeValue(x, `${path}[${i}]`);
    });
  }
  if (isPlainObject(v)) {
    const out = {};
    for (const k of Object.keys(v)) {
      if (v[k] !== undefined) out[k] = normalizeValue(v[k], `${path}.${k}`);
    }
    return out;
  }
  throw new FrontMatterError(`字段「${path}」的值类型不支持`);
}

function verify(out, expected) {
  let actual;
  try {
    actual = parseFrontMatter(out);
  } catch (e) {
    throw new FrontMatterError(VERIFY_FAILED, { cause: e });
  }
  if (!deepEqual(actual, expected)) {
    const err = new FrontMatterError(VERIFY_FAILED);
    err.detail = { expected, actual };
    throw err;
  }
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a === 'number' && typeof b === 'number') return Number.isNaN(a) && Number.isNaN(b);
  if (a instanceof Date || b instanceof Date) {
    return a instanceof Date && b instanceof Date && a.getTime() === b.getTime();
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((x, i) => deepEqual(x, b[i]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    return ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && deepEqual(a[k], b[k]));
  }
  return false;
}

function isPlainObject(v) {
  if (v === null || typeof v !== 'object') return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function stripBom(s) { return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s; }
function normalizeNewlines(s) { return s.replace(/\r\n/g, '\n'); }
function isDelimiterLine(line, delim) {
  return line.startsWith(delim) && /^[ \t]*$/.test(line.slice(delim.length));
}
function countSpaces(line) { let i = 0; while (line[i] === ' ') i++; return i; }
function yamlReason(e) {
  const reason = e && e.reason ? e.reason : String(e && e.message || e);
  const line = e && e.mark && typeof e.mark.line === 'number' ? `（第 ${e.mark.line + 1} 行）` : '';
  return reason + line;
}
