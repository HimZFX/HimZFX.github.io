// tomlpatch.js — 保留注释的 TOML 精确修改（用于 config/_default/*.toml）。
//
// 配置文件里有大量中文注释，是用户的说明书。这里从不「解析再整体重写」，而是：
//   1. 用一个只认结构的小扫描器找到要改的那几行（表头、键值、多行数组、多行字符串都能识别）；
//   2. 只替换值所在的那一段文字，键名、对齐空格、行尾注释、其他所有行原样保留；
//   3. 用 smol-toml 重新解析结果，和「原内容 + 本次修改」逐项比对，不一致就抛 TomlPatchError。
//
// 本模块在导入时不访问 window / document（单元测试在 Node 里直接导入）。

import { parse as smolParse } from '../vendor/smol-toml/index.js';

/** 所有面向用户的错误都用这个类型；message 是中文。 */
export class TomlPatchError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'TomlPatchError';
  }
}

const PARSE_OPTIONS = { integersAsBigInt: 'asNeeded' };
const VERIFY_FAILED = '自动修改配置文件时校验未通过。为避免写错文件，本次修改已取消（文件没有被改动）';
const UNSUPPORTED = '这个配置项的写法比较特殊，无法自动修改，请直接编辑配置文件';
const BOM = String.fromCharCode(0xfeff);

// ---------------------------------------------------------------------------
// 公共 API
// ---------------------------------------------------------------------------

/**
 * 解析 TOML，返回普通对象（不是 null 原型对象，方便调用方使用）。
 * @param {string} text
 * @returns {object}
 * @throws {TomlPatchError} 语法错误（message 为中文，含行号）
 */
export function parseToml(text) {
  return toPlain(parseRaw(String(text ?? '')));
}

/**
 * 按路径取值。getIn(obj, ['profileMode', 'title'])；也接受 'profileMode.title'。
 * @param {object} obj
 * @param {string[]|string} pathArray
 * @returns {any} 找不到时为 undefined
 */
export function getIn(obj, pathArray) {
  let cur = obj;
  for (const k of toPath(pathArray)) {
    if (cur === null || typeof cur !== 'object' || !Object.prototype.hasOwnProperty.call(cur, k)) return undefined;
    cur = cur[k];
  }
  return cur;
}

/**
 * 设置 / 删除一个键的值，保留文件里的所有其他内容。
 *
 * @param {string} text 原文件内容
 * @param {string|string[]} tablePath '' = 根（第一个表头之前的键）；'profileMode'；'en.params.profileMode'
 * @param {string|string[]} key 键名（数组表示带点的键）
 * @param {any} value 字符串 / 数字 / 布尔 / 数组 / 对象（内联表）；undefined = 删除该键
 * @returns {string} 新内容；没有实际变化时原样返回 text
 * @throws {TomlPatchError}
 */
export function setValue(text, tablePath, key, value) {
  const doc = prepare(text);
  const tpath = toPath(tablePath);
  const kpath = Array.isArray(key) ? key.map(String) : [String(key)];
  if (!kpath.length || kpath.some((k) => k === '')) throw new TomlPatchError('配置项的名字不能为空');
  return finish(doc, setValueSrc(doc.src, tpath, kpath, value));
}

/**
 * 用 items 重新生成一组 `[[name]]` 表（如 profileMode.buttons、socialIcons）。
 * 只替换这组表头及其键值行；第一个表头上方的注释、最后一个键之后的空行 / 注释都保留。
 * 内容没变的项原样保留（包括其中的注释），只改了部分字段的项只改那几行。
 * items 为 [] 时删除整组。原来没有这组表时，插到上级表的最后一个键之后（根级时追加到文件末尾）。
 *
 * @param {string} text
 * @param {string|string[]} name
 * @param {object[]} items
 * @returns {string}
 * @throws {TomlPatchError}
 */
export function replaceArrayOfTables(text, name, items) {
  const doc = prepare(text);
  const src = doc.src;
  const path = toPath(name);
  if (!path.length) throw new TomlPatchError('表格名不能为空');
  if (!Array.isArray(items) || !items.every(isPlainObject)) {
    throw new TomlPatchError('列表的每一项都必须是「名称 = 值」的对象');
  }
  const norm = items.map((it, i) => normalizeValue(it, `${path.join('.')}[${i + 1}]`));
  const before = parseRaw(src);
  const cur = getIn(before, path);
  if ((cur === undefined && !norm.length) || (cur !== undefined && deepEqual(cur, norm))) return text;

  const stmts = scan(src);
  const regions = buildRegions(stmts);
  const style = styleOf(stmts, regions);
  const nameStr = path.map(tomlKey).join('.');
  const first = stmts.findIndex((s) => s.type === 'arrayTable' && eqPath(s.path, path));
  let out;

  if (first >= 0) {
    const blocks = collectRun(stmts, first, path);
    if (!Array.isArray(cur) || cur.length !== blocks.length) throw new TomlPatchError(UNSUPPORTED);
    const firstHeader = stmts[blocks[0].headerIdx];
    const firstKv = blocks.map((b) => stmts.slice(b.headerIdx + 1, b.lastIdx + 1).find((s) => s.type === 'kv'))
      .find(Boolean);
    const hIndent = firstHeader.indent;
    const kIndent = firstKv ? firstKv.indent : hIndent + ' '.repeat(style.keyDelta);
    const blockText = (b) => ensureNl(src.slice(stmts[b.headerIdx].start, stmts[b.lastIdx].next));
    const prefixText = (b) => (b.prefixFrom >= 0 && b.prefixFrom < b.headerIdx
      ? src.slice(stmts[b.prefixFrom].start, stmts[b.headerIdx].start) : '');
    // 新块之间的分隔沿用文件风格：第二个块上方开头的那几个空行（紧挨着写的文件就是空串）
    const defaultSep = blocks.length > 1 ? /^(?:[ \t]*\r?\n)*/.exec(prefixText(blocks[1]))[0] : '';
    const fresh = (item) => freshBlock(item, hIndent, kIndent, nameStr);
    const match = matchItems(cur, norm);
    const pieces = norm.map((item, j) => {
      const m = match[j];
      let prefix = '';
      let body;
      if (m) {
        const b = blocks[m.i];
        prefix = prefixText(b);
        body = m.exact ? blockText(b) : (patchBlock(src, stmts, b, cur[m.i], item, kIndent) ?? fresh(item));
      } else {
        body = fresh(item);
      }
      if (j === 0) prefix = prefix.replace(/^(?:[ \t]*\r?\n)+/, '');
      else if (!prefix) prefix = defaultSep;
      return prefix + body;
    });
    const runStart = firstHeader.start;
    const runEnd = stmts[blocks[blocks.length - 1].lastIdx].next;
    out = src.slice(0, runStart) + pieces.join('') + src.slice(runEnd);
  } else if (cur !== undefined) {
    // 这组数据是用内联写法定义的（如 buttons = [ {...} ]）：改那个值即可。
    const parent = path.slice(0, -1);
    const last = path[path.length - 1];
    return finish(doc, setValueSrc(src, parent, [last], norm.length ? norm : undefined));
  } else {
    // 原来没有：插到上级表最后一个键之后（若上级表末尾有「属于它自己」的注释，插在注释之后）。
    const parent = path.slice(0, -1);
    const pr = parent.length
      ? regions.tables.find((r) => r.header.type === 'table' && eqPath(r.header.path, parent)) : null;
    if (pr) {
      const own = pr.items.map((i) => stmts[i]);
      const kvs = own.filter((s) => s.type === 'kv');
      const lastKvPos = kvs.length ? own.lastIndexOf(kvs[kvs.length - 1]) : -1;
      const tail = own.slice(lastKvPos + 1);
      const regionLast = pr.items.length ? pr.items[pr.items.length - 1] : pr.headerIdx;
      let cut = tail.length;
      if (regionLast + 1 < stmts.length) {
        // 紧贴下一个表头的注释（及其上方的空行）属于下一个表
        while (cut > 0 && tail[cut - 1].type === 'comment') cut--;
        while (cut > 0 && tail[cut - 1].type === 'blank') cut--;
      }
      const ownTail = tail.slice(0, cut);
      const lastComment = ownTail.filter((s) => s.type === 'comment').pop();
      const anchor = lastComment || (kvs.length ? kvs[kvs.length - 1] : pr.header);
      const hIndent = kvs.length ? kvs[0].indent : pr.header.indent + ' '.repeat(style.keyDelta);
      const kIndent = hIndent + ' '.repeat(style.keyDelta);
      const text = norm.map((it) => freshBlock(it, hIndent, kIndent, nameStr)).join('');
      out = insertRaw(src, anchor.next, (anchor.type === 'comment' ? '' : '\n') + text);
    } else {
      const text = norm.map((it) => freshBlock(it, '', ' '.repeat(style.keyDelta), nameStr)).join('');
      out = src === '' ? text : ensureNl(src) + '\n' + text;
    }
  }

  const expected = cloneValue(before);
  if (norm.length) setIn(expected, path, norm);
  else deleteIn(expected, path);
  verify(out, expected, (actual) => { if (!norm.length) pruneEmptyAncestors(expected, path, actual); });
  return finish(doc, out);
}

/**
 * 表头 `[tablePath]` 下没有任何键时删掉这个表头（以及它上方紧挨着的一个空行）。
 * 与 setValue 自动新建表的写法正好相反：新建 → 删光键 → removeTableIfEmpty 可以还原成原文件。
 * @param {string} text
 * @param {string|string[]} tablePath
 * @returns {string}
 */
export function removeTableIfEmpty(text, tablePath) {
  const doc = prepare(text);
  const src = doc.src;
  const tpath = toPath(tablePath);
  if (!tpath.length) return text;
  const before = parseRaw(src);
  const stmts = scan(src);
  const regions = buildRegions(stmts);
  const r = regions.tables.find((t) => t.header.type === 'table' && eqPath(t.header.path, tpath));
  if (!r || r.items.some((i) => stmts[i].type === 'kv')) return text;
  let from = r.header.start;
  if (r.headerIdx > 0 && stmts[r.headerIdx - 1].type === 'blank') from = stmts[r.headerIdx - 1].start;
  const out = src.slice(0, from) + src.slice(r.header.next);
  const expected = cloneValue(before);
  const tv = getIn(before, tpath);
  const wasEmpty = isPlainObject(tv) && Object.keys(tv).length === 0;
  if (wasEmpty) deleteIn(expected, tpath);
  verify(out, expected, (actual) => { if (wasEmpty) pruneEmptyAncestors(expected, tpath, actual); });
  return finish(doc, out);
}

// ---------------------------------------------------------------------------
// setValue 的核心（在已规范化的文本上工作）
// ---------------------------------------------------------------------------

function setValueSrc(src, tpath, kpath, value) {
  const before = parseRaw(src);
  const full = [...tpath, ...kpath];
  const label = full.join('.');
  const norm = value === undefined ? undefined : normalizeValue(value, label);
  const cur = getIn(before, full);
  if (value === undefined ? cur === undefined : (cur !== undefined && deepEqual(cur, norm))) return src;

  const stmts = scan(src);
  const regions = buildRegions(stmts);
  const style = styleOf(stmts, regions);
  let region;
  if (!tpath.length) {
    region = regions.root;
  } else {
    if (regions.tables.some((r) => r.header.type === 'arrayTable' && eqPath(r.header.path, tpath))) {
      throw new TomlPatchError(`「${tpath.join('.')}」是一组表格，请整体替换`);
    }
    region = regions.tables.find((r) => r.header.type === 'table' && eqPath(r.header.path, tpath));
  }

  const keyStr = kpath.map(tomlKey).join('.');
  let out = src;
  if (region) {
    const kvs = region.items.map((i) => stmts[i]).filter((s) => s.type === 'kv');
    const kv = kvs.find((s) => eqPath(s.key, kpath));
    if (kv) {
      out = value === undefined
        ? src.slice(0, kv.start) + src.slice(kv.next)
        : src.slice(0, kv.valueStart) + valueTextFor(src, kv, cur, norm) + src.slice(kv.valueEnd);
    } else if (value !== undefined) {
      if (kvs.length) {
        // 插在本表最后一个键之后（在它后面的空行 / 注释之前），沿用本表键的缩进
        const ind = kvs[0].indent;
        out = insertLines(src, kvs[kvs.length - 1].next, [`${ind}${keyStr} = ${tomlValue(norm, ind)}`]);
      } else if (region.header) {
        const ind = region.header.indent + ' '.repeat(style.keyDelta);
        out = insertLines(src, region.header.next, [`${ind}${keyStr} = ${tomlValue(norm, ind)}`]);
      } else {
        // 根区域还没有键：插在第一个表头（及紧贴它的注释）之前，后面空一行
        const line = `${keyStr} = ${tomlValue(norm, '')}`;
        const h = stmts.findIndex(isHeader);
        if (h < 0) {
          out = insertLines(src, src.length, [line]);
        } else {
          let a = h;
          while (a > 0 && stmts[a - 1].type === 'comment') a--;
          out = insertLines(src, stmts[a].start, [line, '']);
        }
      }
    }
  } else if (value !== undefined) {
    // 表不存在：新建。有上级表时放在上级表这一族的最后，缩进与文件风格一致；否则追加到末尾。
    const nameStr = tpath.map(tomlKey).join('.');
    const anc = nearestAncestor(regions.tables, tpath);
    if (anc) {
      const hIndent = anc.header.indent + ' '.repeat(style.nestDelta);
      const kIndent = hIndent + ' '.repeat(style.keyDelta);
      const family = regions.tables.filter((r) => startsWithPath(r.header.path, anc.header.path));
      const last = family[family.length - 1];
      const lastKv = last.items.map((i) => stmts[i]).filter((s) => s.type === 'kv').pop();
      out = insertLines(src, (lastKv || last.header).next,
        ['', `${hIndent}[${nameStr}]`, `${kIndent}${keyStr} = ${tomlValue(norm, kIndent)}`]);
    } else {
      const kIndent = ' '.repeat(style.keyDelta);
      const lines = [`[${nameStr}]`, `${kIndent}${keyStr} = ${tomlValue(norm, kIndent)}`];
      out = src === '' ? lines.join('\n') + '\n' : ensureNl(src) + '\n' + lines.join('\n') + '\n';
    }
  }

  const expected = cloneValue(before);
  if (value === undefined) deleteIn(expected, full);
  else setIn(expected, full, norm);
  verify(out, expected);
  return out;
}

/** 生成键值行里「值」那一段的新文字。多行的「内联表数组」尽量沿用原来每一行（含行尾注释）。 */
function valueTextFor(src, kv, oldVal, newVal) {
  if (Array.isArray(newVal) && newVal.length && newVal.every(isPlainObject) && Array.isArray(oldVal)) {
    const rebuilt = rebuildArray(src, kv, oldVal, newVal);
    if (rebuilt !== null) return rebuilt;
  }
  return tomlValue(newVal, kv.indent);
}

function rebuildArray(src, kv, oldVal, newVal) {
  const lay = arrayLayout(src, kv.valueStart, kv.valueEnd);
  if (!lay || lay.elems.length !== oldVal.length) return null;
  const match = matchItems(oldVal, newVal);
  const defaultIndent = lay.elems.length ? lay.elems[0].indent : kv.indent + '  ';
  let out = lay.open + '\n';
  newVal.forEach((v, j) => {
    const m = match[j];
    if (m) {
      const e = lay.elems[m.i];
      out += `${e.leading}${e.indent}${m.exact ? e.text : inlineValue(v)},${e.tail}\n`;
    } else {
      out += `${defaultIndent}${inlineValue(v)},\n`;
    }
  });
  return out + lay.trailing + lay.closeIndent + ']';
}

/**
 * 识别「每行一个元素」的多行数组：
 *   [            ← 可带注释
 *     元素,      # 注释
 *   ]
 * 返回每个元素的缩进、原文、逗号之后的行尾（含注释）以及它上方的独立注释 / 空行；其他写法返回 null。
 */
function arrayLayout(src, vs, ve) {
  if (src[vs] !== '[') return null;
  let j = skipWs(src, vs + 1);
  if (src[j] === '#') j = indexOfNl(src, j);
  else if (src[j] === '\r' && src[j + 1] === '\n') j++;
  if (src[j] !== '\n') return null;
  const open = src.slice(vs, j);
  let i = j + 1;
  const elems = [];
  let pending = '';
  for (;;) {
    if (i >= ve) return null;
    const ls = i;
    const k = skipWs(src, i);
    const le = indexOfNl(src, k);
    const ch = src[k];
    if (ch === '\n' || ch === '#' || (ch === '\r' && src[k + 1] === '\n')) {
      if (le >= ve) return null;
      pending += src.slice(ls, le + 1);
      i = le + 1;
      continue;
    }
    if (ch === ']') {
      if (k + 1 !== ve) return null;
      return { open, elems, trailing: pending, closeIndent: src.slice(ls, k) };
    }
    const es = k;
    const ee = scanValue(src, k);
    if (src.slice(es, ee).includes('\n')) return null;
    let m = skipWs(src, ee);
    let tailStart = ee;
    if (src[m] === ',') { m++; tailStart = m; }
    let t = skipWs(src, m);
    if (src[t] === '#') t = indexOfNl(src, t);
    else if (src[t] === '\r' && src[t + 1] === '\n') t++;
    if (src[t] !== '\n') return null;
    elems.push({ indent: src.slice(ls, es), text: src.slice(es, ee), tail: src.slice(tailStart, t), leading: pending });
    pending = '';
    i = t + 1;
  }
}

// ---------------------------------------------------------------------------
// [[name]] 块
// ---------------------------------------------------------------------------

/** 从第一个 [[path]] 开始收集连续的一组块；遇到子表或不连续的同名块就拒绝处理。 */
function collectRun(stmts, first, path) {
  const blocks = [];
  let i = first;
  let prefixFrom = -1;
  for (;;) {
    let j = i + 1;
    let lastKv = i;
    while (j < stmts.length && !isHeader(stmts[j])) {
      if (stmts[j].type === 'kv') lastKv = j;
      j++;
    }
    blocks.push({ headerIdx: i, lastIdx: lastKv, prefixFrom });
    if (j < stmts.length) {
      const h = stmts[j];
      if (h.type === 'arrayTable' && eqPath(h.path, path)) { prefixFrom = lastKv + 1; i = j; continue; }
      if (h.path.length > path.length && startsWithPath(h.path, path)) throw new TomlPatchError(UNSUPPORTED);
    }
    for (let k = j; k < stmts.length; k++) {
      if (stmts[k].type === 'arrayTable' && eqPath(stmts[k].path, path)) throw new TomlPatchError(UNSUPPORTED);
    }
    return blocks;
  }
}

/** 在原块的基础上只改变化的键：没变的行原样保留，删掉的键去掉，新增的键加在最后。 */
function patchBlock(src, stmts, block, oldItem, newItem, defaultKIndent) {
  const body = stmts.slice(block.headerIdx + 1, block.lastIdx + 1);
  if (body.some((s) => s.type === 'kv' && s.key.length !== 1)) return null;
  if (!isPlainObject(oldItem)) return null;
  const h = stmts[block.headerIdx];
  let out = ensureNl(src.slice(h.start, h.next));
  const seen = new Set();
  let kIndent = null;
  for (const s of body) {
    const lineText = ensureNl(src.slice(s.start, s.next));
    if (s.type !== 'kv') { out += lineText; continue; }
    const k = s.key[0];
    seen.add(k);
    if (kIndent === null) kIndent = s.indent;
    if (!Object.prototype.hasOwnProperty.call(newItem, k)) continue;
    if (deepEqual(oldItem[k], newItem[k])) out += lineText;
    else {
      out += src.slice(s.start, s.valueStart) + valueTextFor(src, s, oldItem[k], newItem[k]) +
        ensureNl(src.slice(s.valueEnd, s.next));
    }
  }
  if (kIndent === null) kIndent = defaultKIndent;
  for (const k of Object.keys(newItem)) {
    if (!seen.has(k)) out += `${kIndent}${tomlKey(k)} = ${tomlValue(newItem[k], kIndent)}\n`;
  }
  return out;
}

function freshBlock(item, hIndent, kIndent, nameStr) {
  let out = `${hIndent}[[${nameStr}]]\n`;
  for (const k of Object.keys(item)) out += `${kIndent}${tomlKey(k)} = ${tomlValue(item[k], kIndent)}\n`;
  return out;
}

/**
 * 新旧两组数据配对，用来尽量沿用原来的文字：
 * 先找完全相同的项；剩下的按「相同字段数」最多（相同时位置最近）配对；都不像的算新项。
 * @returns {Array<{i: number, exact: boolean}|null>}
 */
function matchItems(oldVals, newVals) {
  const used = new Set();
  const res = newVals.map(() => null);
  newVals.forEach((nv, j) => {
    for (let i = 0; i < oldVals.length; i++) {
      if (!used.has(i) && deepEqual(oldVals[i], nv)) { res[j] = { i, exact: true }; used.add(i); return; }
    }
  });
  newVals.forEach((nv, j) => {
    if (res[j] || !isPlainObject(nv)) return;
    let best = -1;
    let bestScore = 0;
    for (let i = 0; i < oldVals.length; i++) {
      if (used.has(i) || !isPlainObject(oldVals[i])) continue;
      const score = Object.keys(nv).filter((k) =>
        Object.prototype.hasOwnProperty.call(oldVals[i], k) && deepEqual(oldVals[i][k], nv[k])).length;
      if (score > bestScore || (score === bestScore && score > 0 && Math.abs(i - j) < Math.abs(best - j))) {
        best = i;
        bestScore = score;
      }
    }
    if (best >= 0 && bestScore > 0) { res[j] = { i: best, exact: false }; used.add(best); }
  });
  return res;
}

// ---------------------------------------------------------------------------
// 扫描器：把文本切成「语句」（空行 / 注释 / 表头 / 表数组头 / 键值），每条语句占整行。
// ---------------------------------------------------------------------------

/**
 * @typedef {object} Stmt
 * @property {'blank'|'comment'|'table'|'arrayTable'|'kv'} type
 * @property {number} start 行首偏移
 * @property {number} end   最后一行的 '\n' 的偏移（或文本长度）
 * @property {number} next  下一条语句的行首偏移
 * @property {string} indent
 * @property {string[]} [path]  表头路径
 * @property {string[]} [key]   键路径
 * @property {number} [valueStart]
 * @property {number} [valueEnd]
 */

function scan(src) {
  const n = src.length;
  const stmts = [];
  let p = 0;
  while (p < n) {
    const start = p;
    const q = skipWs(src, p);
    const indent = src.slice(p, q);
    const c = src[q];
    let st;
    if (q >= n || c === '\n' || (c === '\r' && (q + 1 >= n || src[q + 1] === '\n'))) {
      st = { type: 'blank', start, end: indexOfNl(src, q) };
    } else if (c === '#') {
      st = { type: 'comment', start, end: indexOfNl(src, q) };
    } else if (c === '[') {
      const isArr = src[q + 1] === '[';
      const k = scanKey(src, q + (isArr ? 2 : 1));
      let i = skipWs(src, k.end);
      if (src[i] !== ']' || (isArr && src[i + 1] !== ']')) fail(src, i);
      i += isArr ? 2 : 1;
      st = { type: isArr ? 'arrayTable' : 'table', path: k.path, start, end: endOfLine(src, i) };
    } else {
      const k = scanKey(src, q);
      let i = skipWs(src, k.end);
      if (src[i] !== '=') fail(src, i);
      i = skipWs(src, i + 1);
      const valueStart = i;
      const valueEnd = scanValue(src, i);
      st = { type: 'kv', key: k.path, start, end: endOfLine(src, valueEnd), valueStart, valueEnd };
    }
    st.indent = indent;
    st.next = st.end < n ? st.end + 1 : n;
    stmts.push(st);
    p = st.next;
  }
  return stmts;
}

/** 值之后只能有空白和注释，然后是行尾。返回行尾 '\n' 的位置（或文本长度）。 */
function endOfLine(src, i) {
  i = skipWs(src, i);
  if (src[i] === '#') i = indexOfNl(src, i);
  else if (src[i] === '\r' && src[i + 1] === '\n') i++;
  if (i < src.length && src[i] !== '\n') fail(src, i);
  return i;
}

function scanKey(src, i) {
  const path = [];
  for (;;) {
    i = skipWs(src, i);
    const c = src[i];
    if (c === '"') {
      const e = scanBasicString(src, i);
      path.push(decodeBasic(src.slice(i + 1, e - 1)));
      i = e;
    } else if (c === "'") {
      const e = src.indexOf("'", i + 1);
      if (e < 0 || src.slice(i, e).includes('\n')) fail(src, i);
      path.push(src.slice(i + 1, e));
      i = e + 1;
    } else {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_-]/.test(src[j])) j++;
      if (j === i) fail(src, i);
      path.push(src.slice(i, j));
      i = j;
    }
    i = skipWs(src, i);
    if (src[i] === '.') { i++; continue; }
    return { path, end: i };
  }
}

/** 返回值结束的位置（不含）。识别字符串（含多行）、数组、内联表和裸值。 */
function scanValue(src, p) {
  const n = src.length;
  if (p >= n) fail(src, p);
  const c = src[p];
  if (src.startsWith('"""', p) || src.startsWith("'''", p)) {
    const q = src[p];
    let i = p + 3;
    for (;;) {
      if (i >= n) fail(src, p);
      if (q === '"' && src[i] === '\\') { i += 2; continue; }
      if (src.startsWith(q.repeat(3), i)) {
        let e = i + 3;
        // 结束分隔符前可以紧挨着最多两个引号（属于内容）
        for (let extra = 0; extra < 2 && src[e] === q; extra++) e++;
        return e;
      }
      i++;
    }
  }
  if (c === '"') return scanBasicString(src, p);
  if (c === "'") {
    const e = src.indexOf("'", p + 1);
    if (e < 0 || src.slice(p, e).includes('\n')) fail(src, p);
    return e + 1;
  }
  if (c === '[') {
    let i = p + 1;
    for (;;) {
      i = skipVoid(src, i);
      if (src[i] === ']') return i + 1;
      i = skipVoid(src, scanValue(src, i));
      if (src[i] === ',') { i++; continue; }
      if (src[i] === ']') return i + 1;
      fail(src, i);
    }
  }
  if (c === '{') {
    let i = p + 1;
    for (;;) {
      i = skipVoid(src, i);
      if (src[i] === '}') return i + 1;
      i = skipWs(src, scanKey(src, i).end);
      if (src[i] !== '=') fail(src, i);
      i = skipVoid(src, scanValue(src, skipWs(src, i + 1)));
      if (src[i] === ',') { i++; continue; }
      if (src[i] === '}') return i + 1;
      fail(src, i);
    }
  }
  // 裸值：数字、布尔、日期时间（日期和时间之间可以是空格）
  let i = p;
  while (i < n && !',]}#\n'.includes(src[i])) i++;
  while (i > p && ' \t\r'.includes(src[i - 1])) i--;
  if (i === p) fail(src, p);
  return i;
}

function scanBasicString(src, p) {
  let i = p + 1;
  while (i < src.length && src[i] !== '"') {
    if (src[i] === '\n') fail(src, p);
    if (src[i] === '\\') i++;
    i++;
  }
  if (i >= src.length) fail(src, p);
  return i + 1;
}

function decodeBasic(s) {
  const simple = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', e: '\x1b', '"': '"', '\\': '\\' };
  return s.replace(/\\(?:u([0-9a-fA-F]{4})|U([0-9a-fA-F]{8})|x([0-9a-fA-F]{2})|([\s\S]))/g, (m, u4, u8, x2, ch) => {
    const hex = u4 || u8 || x2;
    if (hex) return String.fromCodePoint(parseInt(hex, 16));
    return Object.prototype.hasOwnProperty.call(simple, ch) ? simple[ch] : m;
  });
}

function skipWs(src, i) {
  while (i < src.length && (src[i] === ' ' || src[i] === '\t')) i++;
  return i;
}

/** 跳过空白、换行和注释（数组 / 内联表内部用）。 */
function skipVoid(src, i) {
  for (;;) {
    while (i < src.length && ' \t\r\n'.includes(src[i])) i++;
    if (src[i] === '#') { i = indexOfNl(src, i); continue; }
    return i;
  }
}

function indexOfNl(src, i) {
  const k = src.indexOf('\n', i);
  return k < 0 ? src.length : k;
}

function fail(src, at) {
  const line = src.slice(0, at).split('\n').length;
  throw new TomlPatchError(`${UNSUPPORTED}（第 ${line} 行）`);
}

function isHeader(s) { return s.type === 'table' || s.type === 'arrayTable'; }

function buildRegions(stmts) {
  const root = { header: null, headerIdx: -1, items: [] };
  const tables = [];
  let cur = root;
  stmts.forEach((s, i) => {
    if (isHeader(s)) { cur = { header: s, headerIdx: i, items: [] }; tables.push(cur); }
    else cur.items.push(i);
  });
  return { root, tables };
}

/** 文件的缩进风格：键相对表头缩进多少；子表表头相对上级表头缩进多少。 */
function styleOf(stmts, regions) {
  let keyDelta = null;
  for (const r of regions.tables) {
    const kv = r.items.map((i) => stmts[i]).find((s) => s.type === 'kv');
    if (kv) { keyDelta = kv.indent.length - r.header.indent.length; break; }
  }
  if (keyDelta === null || keyDelta < 0) keyDelta = 2;
  let nestDelta = null;
  for (const r of regions.tables) {
    const anc = nearestAncestor(regions.tables, r.header.path);
    if (anc && anc !== r) { nestDelta = r.header.indent.length - anc.header.indent.length; break; }
  }
  if (nestDelta === null || nestDelta < 0) nestDelta = keyDelta ? 2 : 0;
  return { keyDelta, nestDelta };
}

function nearestAncestor(tables, path) {
  for (let len = path.length - 1; len >= 1; len--) {
    const anc = tables.find((t) => t.header.type === 'table' && eqPath(t.header.path, path.slice(0, len)));
    if (anc) return anc;
  }
  return null;
}

// ---------------------------------------------------------------------------
// 文本拼接
// ---------------------------------------------------------------------------

/** 在行首偏移 at 处插入若干行（at = 文本长度时追加到末尾，必要时先补换行）。 */
function insertLines(src, at, lines) {
  return insertRaw(src, at, lines.join('\n') + '\n');
}

function insertRaw(src, at, text) {
  if (at >= src.length) return (src && !src.endsWith('\n') ? src + '\n' : src) + text;
  return src.slice(0, at) + text + src.slice(at);
}

function ensureNl(s) { return s.endsWith('\n') ? s : s + '\n'; }

/** 去掉 BOM；纯 CRLF 文件转成 LF 处理，写回时再转回去（混合换行的文件按原样处理）。 */
function prepare(text) {
  let s = String(text ?? '');
  const bom = s.startsWith(BOM);
  if (bom) s = s.slice(1);
  const crlf = s.includes('\r\n') && !/(^|[^\r])\n/.test(s);
  if (crlf) s = s.replace(/\r\n/g, '\n');
  return { original: text, src: s, bom, crlf };
}

function finish(doc, out) {
  if (out === doc.src) return doc.original;
  let r = doc.crlf ? out.replace(/\n/g, '\r\n') : out;
  if (doc.bom) r = BOM + r;
  return r;
}

// ---------------------------------------------------------------------------
// 值的序列化
// ---------------------------------------------------------------------------

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const DEL_ESCAPE = '\\u' + '007f';

function tomlString(s) {
  if (LONE_SURROGATE.test(s)) throw new TomlPatchError('文字里有无法保存的特殊字符，请删掉后重试');
  // JSON 的转义（\" \\ \n \t \uXXXX …）都是合法的 TOML 基本字符串转义；TOML 另外要求转义 DEL。
  return JSON.stringify(s).replace(/\x7f/g, DEL_ESCAPE);
}

function tomlKey(k) { return /^[A-Za-z0-9_-]+$/.test(k) ? k : tomlString(k); }

/** 值的文字。非空的对象数组写成多行（每行一个内联表），indent 是键所在行的缩进。 */
function tomlValue(v, indent) {
  if (Array.isArray(v) && v.length && v.every(isPlainObject)) {
    const inner = indent + '  ';
    return `[\n${v.map((x) => `${inner}${inlineValue(x)},`).join('\n')}\n${indent}]`;
  }
  return inlineValue(v);
}

function inlineValue(v) {
  if (typeof v === 'string') return tomlString(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'bigint') return String(v);
  if (typeof v === 'number') {
    if (Number.isNaN(v)) return 'nan';
    if (v === Infinity) return 'inf';
    if (v === -Infinity) return '-inf';
    if (Object.is(v, -0)) return '0';
    const s = String(v);
    // 超出安全范围的整数按浮点写，否则 TOML 解析器会把它当成（不同的）大整数
    if (Number.isInteger(v) && !Number.isSafeInteger(v) && !/[e.]/.test(s)) return s + '.0';
    return s;
  }
  if (v instanceof Date) return v.toISOString();
  if (Array.isArray(v)) return `[${v.map(inlineValue).join(', ')}]`;
  if (isPlainObject(v)) {
    const parts = Object.keys(v).map((k) => `${tomlKey(k)} = ${inlineValue(v[k])}`);
    return parts.length ? `{ ${parts.join(', ')} }` : '{}';
  }
  throw new TomlPatchError('配置值的类型不支持');
}

/** 复制并检查值：去掉对象里 undefined 的键；null 等 TOML 表示不了的值直接报错。 */
function normalizeValue(v, label) {
  if (typeof v === 'string') { tomlString(v); return v; }
  if (typeof v === 'boolean' || typeof v === 'number' || typeof v === 'bigint') return v;
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) throw new TomlPatchError(`「${label}」的日期无效`);
    return v;
  }
  if (Array.isArray(v)) {
    return v.map((x, i) => {
      if (x === undefined || x === null) throw new TomlPatchError(`「${label}」的列表里有空值`);
      return normalizeValue(x, `${label}[${i + 1}]`);
    });
  }
  if (isPlainObject(v)) {
    const out = {};
    for (const k of Object.keys(v)) {
      if (v[k] === undefined) continue;
      if (v[k] === null) throw new TomlPatchError(`「${label}.${k}」不能为空值（不需要时请删除这一项）`);
      out[k] = normalizeValue(v[k], `${label}.${k}`);
    }
    return out;
  }
  if (v === null) throw new TomlPatchError(`「${label}」不能为空值（不需要时请删除这一项）`);
  throw new TomlPatchError(`「${label}」的值类型不支持`);
}

// ---------------------------------------------------------------------------
// 解析、校验与对象工具
// ---------------------------------------------------------------------------

function parseRaw(src) {
  try {
    return smolParse(src, PARSE_OPTIONS);
  } catch (e) {
    const where = e && typeof e.line === 'number' ? `（第 ${e.line} 行）` : '';
    const reason = String(e && e.message || e).split('\n')[0].replace(/^Invalid TOML document:\s*/, '');
    throw new TomlPatchError(`配置文件格式有误${where}：${reason}`, { cause: e });
  }
}

function verify(out, expected, adjust) {
  let actual;
  try {
    actual = smolParse(out, PARSE_OPTIONS);
  } catch (e) {
    throw new TomlPatchError(VERIFY_FAILED, { cause: e });
  }
  if (adjust) adjust(actual);
  if (!deepEqual(actual, expected)) {
    const err = new TomlPatchError(VERIFY_FAILED);
    err.detail = { expected, actual };
    throw err;
  }
}

function toPath(p) {
  if (Array.isArray(p)) return p.map(String);
  const s = String(p ?? '').trim();
  return s === '' ? [] : s.split('.').map((x) => x.trim());
}

function eqPath(a, b) { return a.length === b.length && a.every((x, i) => x === b[i]); }
function startsWithPath(a, prefix) { return prefix.length <= a.length && prefix.every((x, i) => x === a[i]); }

function setIn(obj, path, value) {
  let cur = obj;
  for (let i = 0; i < path.length - 1; i++) {
    const k = path[i];
    if (!isPlainObject(cur[k])) defineOwn(cur, k, {});
    cur = cur[k];
  }
  defineOwn(cur, path[path.length - 1], cloneValue(value));
}

function deleteIn(obj, path) {
  const parent = getIn(obj, path.slice(0, -1));
  if (parent && typeof parent === 'object') delete parent[path[path.length - 1]];
}

/** 删掉 expected 里因为本次删除而变空、并且在实际结果里也不存在的上级表（它们原本只是隐式存在）。 */
function pruneEmptyAncestors(expected, path, actual) {
  for (let len = path.length - 1; len >= 1; len--) {
    const p = path.slice(0, len);
    const v = getIn(expected, p);
    if (isPlainObject(v) && Object.keys(v).length === 0 && getIn(actual, p) === undefined) deleteIn(expected, p);
    else break;
  }
}

function defineOwn(obj, k, v) {
  Object.defineProperty(obj, k, { value: v, enumerable: true, writable: true, configurable: true });
}

function cloneValue(v) {
  if (Array.isArray(v)) return v.map(cloneValue);
  if (isPlainObject(v)) {
    const out = {};
    for (const k of Object.keys(v)) defineOwn(out, k, cloneValue(v[k]));
    return out;
  }
  return v;
}

/** smol-toml 返回 null 原型对象；转成普通对象（__proto__ 之类的键按普通属性保存）。 */
function toPlain(v) { return cloneValue(v); }

function isPlainObject(v) {
  if (v === null || typeof v !== 'object') return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a === 'number' && typeof b === 'number') return Number.isNaN(a) && Number.isNaN(b);
  if (a instanceof Date || b instanceof Date) {
    if (!(a instanceof Date) || !(b instanceof Date)) return false;
    try { return a.toISOString() === b.toISOString(); } catch { return false; }
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
