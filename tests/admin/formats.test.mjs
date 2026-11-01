// 单元测试：static/admin/js/frontmatter.js 与 static/admin/js/tomlpatch.js
// 运行：node --test tests/admin/formats.test.mjs
//
// 尽量用仓库里真实的 content/**/*.md 和 config/_default/*.toml 做测试；
// 断言按内容动态定位行号，所以以后修改这些文件也不会让测试失效。

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  FrontMatterError, splitDocument, parseFrontMatter, setFields, buildDocument, newFrontMatter,
} from '../../static/admin/js/frontmatter.js';
import {
  TomlPatchError, parseToml, getIn, setValue, replaceArrayOfTables, removeTableIfEmpty,
} from '../../static/admin/js/tomlpatch.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const BOM = String.fromCharCode(0xfeff);
const LS = String.fromCharCode(0x2028); // LINE SEPARATOR
const NEL = String.fromCharCode(0x85);

function listMarkdown(dir) {
  const out = [];
  for (const ent of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${ent.name}`;
    if (ent.isDirectory()) out.push(...listMarkdown(rel));
    else if (ent.name.endsWith('.md')) out.push(rel);
  }
  return out.sort();
}
const MD_FILES = listMarkdown('content');

// ---------------------------------------------------------------------------
// 测试工具
// ---------------------------------------------------------------------------

/** 最小 LCS 行级 diff：返回原文中被删的行号、以及新文中新增的行号。 */
function lineDiff(a, b) {
  const A = a.split('\n');
  const B = b.split('\n');
  const n = A.length;
  const m = B.length;
  const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const removed = [];
  const added = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) { i++; j++; } else if (dp[i + 1][j] >= dp[i][j + 1]) removed.push(i++); else added.push(j++);
  }
  while (i < n) removed.push(i++);
  while (j < m) added.push(j++);
  return { removed, added, A, B, removedLines: removed.map((k) => A[k]), addedLines: added.map((k) => B[k]) };
}

/** 原文 [from, to) 之外的所有行必须原样保留在开头和结尾（逐字节）。 */
function assertOnlyRegionReplaced(orig, out, from, to) {
  const A = orig.split('\n');
  const B = out.split('\n');
  assert.deepEqual(B.slice(0, from), A.slice(0, from), '替换区域之前的行必须原样保留');
  const tailA = A.slice(to);
  assert.deepEqual(B.slice(B.length - tailA.length), tailA, '替换区域之后的行必须原样保留');
  assert.ok(B.length - tailA.length >= from);
}

/** 原文中替换区域之外的注释行，必须按原顺序全部出现在结果里。 */
function assertCommentsKept(orig, out, from = 0, to = 0) {
  const A = orig.split('\n');
  const B = out.split('\n');
  const comments = A.filter((l, i) => (i < from || i >= to) && /#/.test(l) && /^\s*#/.test(l));
  let k = 0;
  for (const line of B) if (k < comments.length && line === comments[k]) k++;
  assert.equal(k, comments.length, `注释行丢失或乱序：${comments[k]}`);
}

/** 行内注释（`键 = 值   # 注释`）也要保留：找出原文替换区域之外带行尾注释的行，逐一检查。 */
function assertInlineCommentsKept(orig, out, from = 0, to = 0) {
  const A = orig.split('\n');
  const B = new Set(out.split('\n'));
  A.forEach((l, i) => {
    if ((i < from || i >= to) && /\S.*\s#/.test(l) && !/^\s*#/.test(l)) assert.ok(B.has(l), `行尾注释丢失：${l}`);
  });
}

function findLine(lines, re, from = 0) {
  for (let i = from; i < lines.length; i++) if (re.test(lines[i])) return i;
  return -1;
}

/** 找某个 [表] 里某个键所在的行号（0 起）。 */
function tomlKeyLine(text, header, key) {
  const lines = text.split('\n');
  let start = 0;
  if (header) {
    const re = new RegExp(`^\\s*\\[\\s*${header.replace(/\./g, '\\s*\\.\\s*')}\\s*\\]\\s*(#.*)?$`);
    start = findLine(lines, re);
    if (start < 0) return -1;
    start += 1;
  }
  for (let i = start; i < lines.length; i++) {
    if (/^\s*\[/.test(lines[i])) break;
    if (new RegExp(`^\\s*${key}\\s*=`).test(lines[i])) return i;
  }
  return -1;
}

/** [[name]] 这一组块在原文里的行范围 [from, to)：从第一个表头到最后一个键所在行。 */
function arrayRunRange(text, name) {
  const lines = text.split('\n');
  const hdr = new RegExp(`^\\s*\\[\\[\\s*${name.replace(/\./g, '\\s*\\.\\s*')}\\s*\\]\\]`);
  const from = findLine(lines, hdr);
  if (from < 0) return null;
  let last = from;
  for (let i = from + 1; i < lines.length; i++) {
    const l = lines[i];
    if (/^\s*\[/.test(l)) { if (hdr.test(l)) { last = i; continue; } break; }
    if (/^\s*[^#\s]/.test(l)) last = i;
  }
  return [from, last + 1];
}

function clone(v) { return JSON.parse(JSON.stringify(v)); }

/** 取一行的行尾注释（含前面的空白），跳过字符串里的 #。没有则返回 null。 */
function trailingComment(line) {
  let q = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (q === '"' && c === '\\') i++;
      else if (c === q) q = null;
    } else if (c === '"' || c === "'") {
      q = c;
    } else if (c === '#' && i > 0 && /[ \t]/.test(line[i - 1])) {
      let j = i;
      while (j > 0 && /[ \t]/.test(line[j - 1])) j--;
      return line.slice(j);
    }
  }
  return null;
}

/** frontmatter 往返的「约定规范化」：去 BOM、CRLF→LF、--- 与正文之间恰好一个空行、末尾恰好一个换行。 */
function canonicalDocument(text) {
  let s = text.startsWith(BOM) ? text.slice(1) : text;
  s = s.replace(/\r\n/g, '\n');
  const lines = s.split('\n');
  assert.match(lines[0], /^---\s*$/);
  const close = lines.findIndex((l, i) => i > 0 && /^---\s*$/.test(l));
  const fm = lines.slice(1, close).join('\n');
  const bodyLines = lines.slice(close + 1);
  while (bodyLines.length && bodyLines[0].trim() === '') bodyLines.shift();
  const body = bodyLines.join('\n').replace(/[ \t\n]+$/, '');
  return `---\n${fm}\n---\n` + (body ? `\n${body}\n` : '');
}

// ===========================================================================
// frontmatter.js
// ===========================================================================

describe('frontmatter: 仓库里的每个 content/**/*.md', () => {
  test('找到了内容文件', () => {
    assert.ok(MD_FILES.length >= 5, MD_FILES.join(', '));
    assert.ok(MD_FILES.includes('content/about.md'));
  });

  for (const file of MD_FILES) {
    describe(file, () => {
      const text = read(file);
      const doc = splitDocument(text);
      const fm = parseFrontMatter(doc.fmText);
      const lines = doc.fmText.split('\n');

      test('splitDocument → buildDocument 往返一致（仅有约定的规范化）', () => {
        assert.equal(doc.kind, 'yaml');
        assert.equal(doc.fmText.split('\n').some((l) => /^---\s*$/.test(l)), false);
        const rebuilt = buildDocument(doc.fmText, doc.body);
        assert.equal(rebuilt, canonicalDocument(text));
        // 已是规范形式的文件必须逐字节相同
        if (canonicalDocument(text) === text) assert.equal(rebuilt, text);
        // 不动点：再拆再拼不再变化
        const again = splitDocument(rebuilt);
        assert.equal(again.fmText, doc.fmText);
        assert.equal(buildDocument(again.fmText, again.body), rebuilt);
        // 正文内容（去掉首尾空白）不变
        assert.equal(again.body.trim(), doc.body.trim());
      });

      test('parseFrontMatter：普通对象，日期保持字符串', () => {
        assert.equal(typeof fm, 'object');
        assert.equal(typeof fm.title, 'string');
        assert.ok(fm.title.length > 0);
        if ('date' in fm) assert.equal(typeof fm.date, 'string');
      });

      test('内容相同的更新不改动任何字节', () => {
        assert.equal(setFields(doc.fmText, { ...fm }), doc.fmText);
        assert.equal(setFields(doc.fmText, {}), doc.fmText);
      });

      test('改 title：只改动 title 那一行，其他行（含注释）原样', () => {
        const out = setFields(doc.fmText, { title: `新标题 "${file}" # 不是注释` });
        assert.deepEqual(parseFrontMatter(out), { ...fm, title: `新标题 "${file}" # 不是注释` });
        const d = lineDiff(doc.fmText, out);
        assert.equal(d.removed.length, 1);
        assert.equal(d.added.length, 1);
        assert.match(d.removedLines[0], /^title:/);
        assert.match(d.addedLines[0], /^title: "新标题 \\"/);
        assertCommentsKept(doc.fmText, out);
        assertInlineCommentsKept(doc.fmText, out);
      });

      test('改 / 加 description', () => {
        const out = setFields(doc.fmText, { description: '一段\n两行的摘要：含 # 号与 "引号"' });
        assert.deepEqual(parseFrontMatter(out), { ...fm, description: '一段\n两行的摘要：含 # 号与 "引号"' });
        const d = lineDiff(doc.fmText, out);
        assert.equal(d.added.length, 1);
        assert.equal(d.removed.length, 'description' in fm ? 1 : 0);
        if (!('description' in fm)) assert.equal(out, `${doc.fmText}\ndescription: "一段\\n两行的摘要：含 # 号与 \\"引号\\""`);
        assertInlineCommentsKept(doc.fmText, out);
      });

      test('加 tags（追加在末尾，flow 列表）', () => {
        const out = setFields(doc.fmText, { tags: ['广义相对论', 'GR', '🎂'] });
        assert.deepEqual(parseFrontMatter(out), { ...fm, tags: ['广义相对论', 'GR', '🎂'] });
        if (!('tags' in fm)) assert.equal(out, `${doc.fmText}\ntags: ["广义相对论", "GR", "🎂"]`);
      });

      test('切换 draft：保留行尾注释', () => {
        const next = !(fm.draft === true);
        const out = setFields(doc.fmText, { draft: next });
        assert.deepEqual(parseFrontMatter(out), { ...fm, draft: next });
        const idx = lines.findIndex((l) => /^draft:/.test(l));
        if (idx >= 0) {
          const d = lineDiff(doc.fmText, out);
          assert.deepEqual(d.removed, [idx]);
          const comment = trailingComment(lines[idx]);
          const expectedLine = `draft: ${next}` + (comment ? comment : '');
          assert.equal(out.split('\n')[idx], expectedLine);
        } else {
          assert.equal(out, `${doc.fmText}\ndraft: ${next}`);
        }
      });

      test('删除一个键（undefined）只删那一行', () => {
        const key = Object.keys(fm).find((k) => k !== 'menu' && typeof fm[k] !== 'object');
        const out = setFields(doc.fmText, { [key]: undefined, notThere: undefined });
        const expected = { ...fm };
        delete expected[key];
        assert.deepEqual(parseFrontMatter(out), expected);
        const d = lineDiff(doc.fmText, out);
        assert.equal(d.added.length, 0);
        assert.equal(d.removed.length, 1);
        assert.ok(d.removedLines[0].startsWith(`${key}:`));
        assertInlineCommentsKept(doc.fmText, out, d.removed[0], d.removed[0] + 1);
      });

      test('加封面 cover: { image }', () => {
        const out = setFields(doc.fmText, { cover: { image: '/images/posts/a/封面 1.jpg', alt: undefined } });
        assert.deepEqual(parseFrontMatter(out), { ...fm, cover: { image: '/images/posts/a/封面 1.jpg' } });
        assert.ok(out.endsWith('\ncover: { image: "/images/posts/a/封面 1.jpg" }'));
      });

      if (fm.menu && fm.menu.main && typeof fm.menu.main.weight === 'number') {
        test('改菜单顺序 menu.main.weight：块状写法逐层修改，只动 weight 那一行', () => {
          const menu = clone(fm.menu);
          menu.main.weight += 5;
          const out = setFields(doc.fmText, { menu });
          assert.deepEqual(parseFrontMatter(out), { ...fm, menu });
          const d = lineDiff(doc.fmText, out);
          assert.equal(d.removed.length, 1);
          assert.equal(d.added.length, 1);
          assert.match(d.removedLines[0], /^\s+weight:/);
          const comment = trailingComment(d.removedLines[0]);
          if (comment) assert.ok(d.addedLines[0].endsWith(comment), '保留 weight 的行尾注释');
          assertCommentsKept(doc.fmText, out);
          assertInlineCommentsKept(doc.fmText, out, d.removed[0], d.removed[0] + 1);
        });

        test('整体替换 menu（加子键、删子键、换成别的结构）', () => {
          const m1 = { main: { weight: 99, name: '菜单 #1' }, footer: { weight: 1 } };
          const o1 = setFields(doc.fmText, { menu: m1 });
          assert.deepEqual(parseFrontMatter(o1), { ...fm, menu: m1 });
          const m2 = { footer: { weight: 2 } };
          const o2 = setFields(o1, { menu: m2 });
          assert.deepEqual(parseFrontMatter(o2), { ...fm, menu: m2 });
          const o3 = setFields(doc.fmText, { menu: 'main' });
          assert.deepEqual(parseFrontMatter(o3), { ...fm, menu: 'main' });
          const o4 = setFields(doc.fmText, { menu: undefined });
          const e4 = { ...fm };
          delete e4.menu;
          assert.deepEqual(parseFrontMatter(o4), e4);
          assert.equal(/^\s+weight:/m.test(o4), false, 'menu 的子行也被删除');
          for (const o of [o1, o2, o3, o4]) assertInlineCommentsKept(doc.fmText, o, ...menuRange(lines));
        });
      }

      test('一次改多个字段', () => {
        const updates = {
          title: '标题', description: '摘要', tags: ['a'], categories: [], draft: true,
          cover: { image: '/x.jpg' }, math: false, background: { effect: 'lorenz' },
        };
        const out = setFields(doc.fmText, updates);
        assert.deepEqual(parseFrontMatter(out), { ...fm, ...updates });
        const rebuilt = buildDocument(out, doc.body);
        assert.deepEqual(parseFrontMatter(splitDocument(rebuilt).fmText), { ...fm, ...updates });
        assert.equal(splitDocument(rebuilt).body.trim(), doc.body.trim());
      });
    });
  }
});

function menuRange(lines) {
  const from = lines.findIndex((l) => /^menu:/.test(l));
  let to = from + 1;
  while (to < lines.length && /^\s/.test(lines[to])) to++;
  return [from, to];
}

describe('frontmatter: content/about.md 的注释', () => {
  const doc = splitDocument(read('content/about.md'));
  const commented = doc.fmText.split('\n').filter((l) => /\s#\s/.test(l));

  test('about.md 带行内注释的行（如 layout / hidemeta）在各种修改后都保留', () => {
    assert.ok(commented.some((l) => /^layout:/.test(l)), 'about.md 应有 layout 行尾注释');
    assert.ok(commented.some((l) => /^hidemeta:/.test(l)), 'about.md 应有 hidemeta 行尾注释');
    const variants = [
      { title: 'X' }, { draft: true }, { tags: ['t'] }, { summary: undefined },
      { menu: { main: { weight: 3 } } }, { description: 'd' }, { linkTitle: '关于' },
    ];
    for (const u of variants) {
      const out = setFields(doc.fmText, u);
      for (const l of commented) {
        const key = /^\s*([^:]+):/.exec(l)[1];
        if (Object.keys(u).includes(key)) continue;
        if (key === 'weight' && u.menu) continue;
        assert.ok(out.split('\n').includes(l), `修改 ${JSON.stringify(u)} 后丢了：${l}`);
      }
    }
  });

  test('替换带注释的标量：保留注释', () => {
    const out = setFields(doc.fmText, { layout: 'list', hidemeta: false });
    const ol = out.split('\n');
    const layoutOld = commented.find((l) => /^layout:/.test(l));
    const hidemetaOld = commented.find((l) => /^hidemeta:/.test(l));
    assert.ok(ol.includes(`layout: "list"${trailingComment(layoutOld)}`));
    assert.ok(ol.includes(`hidemeta: false${trailingComment(hidemetaOld)}`));
  });

  test('值不变时保留原写法（例如未加引号的日期）', () => {
    const fm = 'title: x\ndate: 2025-12-05\nweight: 1   # c';
    assert.equal(setFields(fm, { date: '2025-12-05', weight: 1, title: 'x' }), fm);
  });
});

describe('frontmatter: 块状写法', () => {
  const fm = [
    'title: "x"',
    'tags:',
    '  - 物理',
    '  # 列表中间的注释',
    '  - GR   # 注释',
    '',
    'categories:',
    '- a',
    '- b',
    '# 顶格注释，属于下一个键之前',
    'summary: |',
    '  第一行',
    '  # 这是块文本的内容，不是注释',
    '',
    '  第三行',
    'draft: true  # 保留',
  ].join('\n');
  const parsed = parseFrontMatter(fm);

  test('解析正确', () => {
    assert.deepEqual(parsed.tags, ['物理', 'GR']);
    assert.deepEqual(parsed.categories, ['a', 'b']);
    assert.equal(parsed.summary, '第一行\n# 这是块文本的内容，不是注释\n\n第三行\n');
  });

  test('替换缩进的列表 tags', () => {
    const out = setFields(fm, { tags: ['新'] });
    assert.deepEqual(parseFrontMatter(out), { ...parsed, tags: ['新'] });
    const ol = out.split('\n');
    assert.equal(ol[1], 'tags: ["新"]');
    assert.equal(ol[2], '', '列表之后的空行保留');
    assert.equal(ol[3], 'categories:');
    assert.equal(ol.at(-1), 'draft: true  # 保留');
  });

  test('替换顶格的列表 categories（- 在第 0 列）', () => {
    const out = setFields(fm, { categories: ['c', 'd'] });
    assert.deepEqual(parseFrontMatter(out), { ...parsed, categories: ['c', 'd'] });
    assert.ok(out.includes('categories: ["c", "d"]\n# 顶格注释，属于下一个键之前\nsummary: |'));
  });

  test('替换块文本 summary（含空行和 # 开头的内容行）', () => {
    const out = setFields(fm, { summary: '一行' });
    assert.deepEqual(parseFrontMatter(out), { ...parsed, summary: '一行' });
    assert.ok(out.endsWith('summary: "一行"\ndraft: true  # 保留'));
  });

  test('删除列表键', () => {
    const out = setFields(fm, { tags: undefined, categories: undefined });
    const e = { ...parsed };
    delete e.tags;
    delete e.categories;
    assert.deepEqual(parseFrontMatter(out), e);
    assert.ok(out.includes('# 顶格注释，属于下一个键之前'));
  });

  test('多行 flow 值与多行引号字符串', () => {
    const f = 'tags: ["a",\n  "b"]\ntitle: "很长的\n  标题"\ndraft: false';
    const p = parseFrontMatter(f);
    const out = setFields(f, { tags: ['z'], title: 't' });
    assert.deepEqual(parseFrontMatter(out), { ...p, tags: ['z'], title: 't' });
    assert.equal(out, 'tags: ["z"]\ntitle: "t"\ndraft: false');
  });

  test('引号键名', () => {
    const f = '"title": "a"\n\'linkTitle\': b  # c';
    const out = setFields(f, { title: 'x', linkTitle: 'y' });
    assert.equal(out, '"title": "x"\n\'linkTitle\': "y"  # c');
  });
});

describe('frontmatter: 特殊字符与边界情况', () => {
  const tricky = [
    'He said "hi" \\ C:\\dir\\file # not a comment',
    '第一行\n第二行\t制表符',
    'emoji 🎂🏮 ü é 中文「」',
    '# 开头就是井号',
    'colon: in value',
    "single ' quote",
    '',
    ' 前后空格 ',
    'yes',
    'null',
    '123',
    '2025-12-05',
    `控制符\x01\x7f${NEL}与分隔符${LS}以及${BOM}BOM`,
    '{ not: a map }',
    '- not a list',
  ];

  test('字符串往返（双引号 + 转义）', () => {
    for (const s of tricky) {
      const out = setFields('title: x', { title: s });
      assert.deepEqual(parseFrontMatter(out), { title: s }, JSON.stringify(s));
      assert.equal(out.split('\n').length, 1, '始终是单行');
      const fresh = newFrontMatter({ title: s, tags: [s], cover: { image: s } });
      assert.deepEqual(parseFrontMatter(fresh), { title: s, tags: [s], cover: { image: s } });
    }
  });

  test('值里的 # 不会被当成注释；真正的注释保留', () => {
    const f = 'title: "a # b"   # 真注释\ndescription: \'x # y\'  # 注释2\nplain: a#b # 注释3';
    const out = setFields(f, { title: 'c # d', description: 'e', plain: 'f' });
    assert.equal(out, 'title: "c # d"   # 真注释\ndescription: "e"  # 注释2\nplain: "f" # 注释3');
    const again = setFields(out, { title: 'g' });
    assert.equal(again.split('\n')[0], 'title: "g"   # 真注释');
  });

  test('数字、布尔、null、嵌套对象与数组', () => {
    const updates = {
      n: 0, neg: -1.5, big: 1e21, t: true, f: false, z: null,
      arr: [1, 'two', true, null, [3], { a: 'b' }],
      obj: { 'key with space': 1, nested: { deep: ['x'] }, true: 'reserved key' },
      empty: [], emptyObj: {},
    };
    const out = setFields('title: x', updates);
    assert.deepEqual(parseFrontMatter(out), { title: 'x', ...updates });
  });

  test('CRLF 输入：拆分、修改后统一为 LF', () => {
    const text = read('content/about.md').replace(/\n/g, '\r\n');
    const doc = splitDocument(text);
    assert.equal(doc.kind, 'yaml');
    assert.equal(doc.fmText.includes('\r'), false);
    assert.equal(doc.body.includes('\r'), false);
    const plain = splitDocument(read('content/about.md'));
    assert.equal(doc.fmText, plain.fmText);
    const out = setFields(doc.fmText.replace(/\n/g, '\r\n'), { draft: true });
    assert.equal(out.includes('\r'), false);
    assert.equal(parseFrontMatter(out).draft, true);
    assert.equal(buildDocument(doc.fmText, doc.body), buildDocument(plain.fmText, plain.body));
  });

  test('BOM：拆分时去掉', () => {
    const text = BOM + read('content/posts/_index.md');
    const doc = splitDocument(text);
    assert.equal(doc.kind, 'yaml');
    assert.equal(buildDocument(doc.fmText, doc.body), read('content/posts/_index.md'));
    assert.deepEqual(parseFrontMatter(BOM + 'a: 1'), { a: 1 });
  });

  test('没有 front matter / TOML front matter / 空 front matter', () => {
    assert.deepEqual(splitDocument('# 标题\n正文'), { fmText: null, body: '# 标题\n正文', kind: 'none' });
    assert.deepEqual(splitDocument('+++\ntitle = "x"\n+++\n\n正文\n'),
      { fmText: 'title = "x"', body: '\n正文\n', kind: 'toml' });
    assert.deepEqual(splitDocument('---\n---\n正文'), { fmText: '', body: '正文', kind: 'yaml' });
    assert.deepEqual(splitDocument('---  \ntitle: x\n---   \nbody'), { fmText: 'title: x', body: 'body', kind: 'yaml' });
    assert.deepEqual(splitDocument('---\ntitle: x\n---'), { fmText: 'title: x', body: '', kind: 'yaml' });
    assert.deepEqual(parseFrontMatter(''), {});
    assert.deepEqual(parseFrontMatter(null), {});
    assert.deepEqual(parseFrontMatter('# 只有注释'), {});
    assert.equal(buildDocument('', 'x'), '---\n---\n\nx\n');
    assert.equal(buildDocument(null, '正文\n\n\n'), '正文\n');
    assert.equal(buildDocument('a: 1\n\n', '\n\n  缩进代码\n'), '---\na: 1\n---\n\n  缩进代码\n');
  });

  test('正文里的 --- 分隔线不会被当成 front matter 结束', () => {
    const doc = splitDocument(read('content/research/_index.md'));
    assert.ok(doc.body.includes('\n---\n'));
    assert.equal(parseFrontMatter(doc.fmText).layout, 'list');
  });

  test('缺少结束分隔线 / 语法错误 / 顶层不是映射 → FrontMatterError', () => {
    assert.throws(() => splitDocument('---\ntitle: x\n正文'), FrontMatterError);
    assert.throws(() => parseFrontMatter('title: [unclosed'), FrontMatterError);
    assert.throws(() => parseFrontMatter('a: 1\na: 2'), FrontMatterError);
    assert.throws(() => parseFrontMatter('- a\n- b'), FrontMatterError);
    assert.throws(() => setFields('title: [x', { title: 'y' }), FrontMatterError);
    try {
      parseFrontMatter('a: [');
      assert.fail('should throw');
    } catch (e) {
      assert.ok(e instanceof FrontMatterError);
      assert.match(e.message, /front matter/);
    }
  });

  test('undefined 删除键；删除不存在的键不改动', () => {
    assert.equal(setFields('a: 1\nb: 2  # c\nc: 3', { b: undefined }), 'a: 1\nc: 3');
    assert.equal(setFields('a: 1', { zz: undefined }), 'a: 1');
    assert.equal(setFields('a: 1\n', { a: undefined, b: 2 }), 'b: 2\n');
    assert.equal(setFields('', { title: 'x' }), 'title: "x"');
    assert.equal(setFields(null, { title: 'x' }), 'title: "x"');
  });

  test('不支持的值类型 / 孤立代理字符 → FrontMatterError', () => {
    assert.throws(() => setFields('a: 1', { a: new Date() }), FrontMatterError);
    assert.throws(() => setFields('a: 1', { a: () => 1 }), FrontMatterError);
    assert.throws(() => setFields('a: 1', { a: [undefined] }), FrontMatterError);
    assert.throws(() => setFields('a: 1', { a: 'bad \uD800 char' }), FrontMatterError);
    assert.throws(() => newFrontMatter({ a: 10n }), FrontMatterError);
  });

  test('校验失败的路径：结构被误判时抛错而不是写错文件', () => {
    // 多行引号字符串的续行顶格写，看起来像一个 title: 键 —— 行扫描会误判，校验必须兜住。
    const f1 = 'description: "第一行\ntitle: 其实是字符串的一部分"\ntitle: 真标题';
    assert.deepEqual(parseFrontMatter(f1), { description: '第一行 title: 其实是字符串的一部分', title: '真标题' });
    assert.throws(() => setFields(f1, { title: '新' }), (e) => e instanceof FrontMatterError && /校验未通过/.test(e.message));
    // 锚点被替换掉后别名失效
    const f2 = 'title: &t "x"\nlinkTitle: *t';
    assert.throws(() => setFields(f2, { title: 'y' }), FrontMatterError);
    // 根是 flow 映射，找不到键所在行 → 追加会造成重复键
    assert.throws(() => setFields('{ title: x }', { title: 'y' }), FrontMatterError);
  });

  test('newFrontMatter：按约定顺序输出，可被解析', () => {
    const fields = {
      foo: 'bar', draft: true, title: '新文章', date: '2026-10-31T17:20:05+08:00', tags: [],
      menu: { main: { weight: 50 } }, description: undefined, cover: { image: '/a.jpg' },
    };
    const out = newFrontMatter(fields);
    assert.equal(out, [
      'title: "新文章"', 'date: "2026-10-31T17:20:05+08:00"', 'draft: true', 'tags: []',
      'cover: { image: "/a.jpg" }', 'menu: { main: { weight: 50 } }', 'foo: "bar"',
    ].join('\n'));
    const expected = { ...fields };
    delete expected.description;
    assert.deepEqual(parseFrontMatter(out), expected);
    assert.equal(newFrontMatter({}), '');
    assert.equal(newFrontMatter({ b: 1, a: 2 }, ['a']), 'a: 2\nb: 1');
    const doc = buildDocument(out, '这里写栏目介绍…');
    assert.equal(splitDocument(doc).body, '\n这里写栏目介绍…\n');
  });
});

// ===========================================================================
// tomlpatch.js
// ===========================================================================

const PARAMS = read('config/_default/params.toml');
const LANGS = read('config/_default/languages.toml');
const HUGO = read('config/_default/hugo.toml');
const P = parseToml(PARAMS);

/** setValue 后的通用断言：解析结果符合预期、只有那个键的行变化、区域外注释都在。 */
function checkSetValue(text, table, key, value, { region } = {}) {
  const out = setValue(text, table, key, value);
  const expected = clone(parseToml(text));
  const tpath = table ? table.split('.') : [];
  let target = expected;
  for (const k of tpath) target = target[k] ??= {};
  if (value === undefined) delete target[key]; else target[key] = clone(value);
  assert.deepEqual(clone(parseToml(out)), expected);
  const line = tomlKeyLine(text, table, key);
  const [from, to] = region || (line >= 0 ? [line, line + 1] : [0, 0]);
  if (line >= 0) assertOnlyRegionReplaced(text, out, from, to);
  assertCommentsKept(text, out, from, to);
  assertInlineCommentsKept(text, out, from, to);
  return out;
}

describe('tomlpatch: params.toml 的 setValue', () => {
  test('parseToml / getIn', () => {
    assert.equal(typeof getIn(P, ['profileMode', 'title']), 'string');
    assert.equal(getIn(P, 'profileMode.title'), P.profileMode.title);
    assert.equal(getIn(P, ['profileMode', 'nope', 'x']), undefined);
    assert.equal(Object.getPrototypeOf(P), Object.prototype, 'parseToml 返回普通对象');
    assert.equal(Object.getPrototypeOf(P.profileMode), Object.prototype);
    assert.throws(() => parseToml('a = '), TomlPatchError);
  });

  for (const [key, value] of [
    ['title', '钟方雄 "Zhong" \\ 🎂'],
    ['subtitle', 'Peking University | 物理 # 不是注释'],
    ['imageUrl', 'images/avatar-2026.jpg'],
  ]) {
    test(`profileMode.${key}`, () => {
      const out = checkSetValue(PARAMS, 'profileMode', key, value);
      const idx = tomlKeyLine(PARAMS, 'profileMode', key);
      const oldLine = PARAMS.split('\n')[idx];
      const newLine = out.split('\n')[idx];
      const comment = trailingComment(oldLine);
      if (comment) assert.ok(newLine.endsWith(comment), '保留行尾注释');
      assert.equal(newLine.slice(0, newLine.indexOf('=')), oldLine.slice(0, oldLine.indexOf('=')), '键名与缩进不变');
    });
  }

  test('background.effect / enabled / autoplay', () => {
    let t = checkSetValue(PARAMS, 'background', 'effect', 'lorenz');
    t = checkSetValue(t, 'background', 'enabled', !P.background.enabled);
    t = checkSetValue(t, 'background', 'autoplay', 'all');
    assert.deepEqual(parseToml(t).background, { ...P.background, effect: 'lorenz', enabled: !P.background.enabled, autoplay: 'all' });
    assert.equal(lineDiff(PARAMS, t).removed.length, 3);
  });

  test('值相同 → 原样返回同一个字符串', () => {
    assert.equal(setValue(PARAMS, 'profileMode', 'title', P.profileMode.title), PARAMS);
    assert.equal(setValue(PARAMS, 'holidayFavicon', 'rules', clone(P.holidayFavicon.rules)), PARAMS);
    assert.equal(setValue(PARAMS, 'profileMode', 'notThere', undefined), PARAMS);
  });

  test('holidayFavicon.enabled', () => {
    checkSetValue(PARAMS, 'holidayFavicon', 'enabled', !P.holidayFavicon.enabled);
  });

  describe('holidayFavicon.rules（多行的内联表数组）', () => {
    const rules = clone(P.holidayFavicon.rules);
    const lines = PARAMS.split('\n');
    const from = tomlKeyLine(PARAMS, 'holidayFavicon', 'rules');
    const to = findLine(lines, /^\s*\]/, from) + 1;
    const ruleLines = lines.slice(from + 1, to - 1).filter((l) => /\{/.test(l));
    const region = [from, to];

    test('文件里有多条规则（测试前提）', () => {
      assert.ok(rules.length >= 2);
      assert.equal(ruleLines.length, rules.length);
    });

    test('修改一条：只有那一行变化，其行尾注释保留', () => {
      const next = clone(rules);
      next[1].to = next[1].to === '02-20' ? '02-21' : '02-20';
      const out = checkSetValue(PARAMS, 'holidayFavicon', 'rules', next, { region });
      const d = lineDiff(PARAMS, out);
      assert.equal(d.removed.length, 1);
      assert.equal(d.added.length, 1);
      assert.equal(d.removedLines[0], ruleLines[1]);
      const comment = trailingComment(ruleLines[1]);
      if (comment) assert.ok(d.addedLines[0].endsWith(comment));
      assert.ok(d.addedLines[0].includes(`to = "${next[1].to}"`));
    });

    test('新增一条（emoji、特殊字符）', () => {
      const next = [...clone(rules), { emoji: '🐉"\\', from: '06-01', to: '06-02' }];
      const out = checkSetValue(PARAMS, 'holidayFavicon', 'rules', next, { region });
      const d = lineDiff(PARAMS, out);
      assert.equal(d.removed.length, 0);
      assert.deepEqual(d.addedLines, ['    { emoji = "🐉\\"\\\\", from = "06-01", to = "06-02" },']);
    });

    test('删除一条：其他规则行（含注释）原样', () => {
      const next = clone(rules);
      next.splice(0, 1);
      const out = checkSetValue(PARAMS, 'holidayFavicon', 'rules', next, { region });
      const d = lineDiff(PARAMS, out);
      assert.deepEqual(d.removedLines, [ruleLines[0]]);
      assert.equal(d.added.length, 0);
    });

    test('调换顺序：每一行原样移动', () => {
      const next = clone(rules).reverse();
      const out = checkSetValue(PARAMS, 'holidayFavicon', 'rules', next, { region });
      const outRules = out.split('\n').filter((l) => ruleLines.includes(l));
      assert.deepEqual(outRules, [...ruleLines].reverse());
    });

    test('清空后再重新填入', () => {
      const empty = checkSetValue(PARAMS, 'holidayFavicon', 'rules', [], { region });
      assert.match(empty, /\n {2}rules = \[\]\n/);
      const refill = setValue(empty, 'holidayFavicon', 'rules', [{ emoji: '🎂', from: '01-22', to: '01-22' }]);
      assert.deepEqual(parseToml(refill).holidayFavicon.rules, [{ emoji: '🎂', from: '01-22', to: '01-22' }]);
      assert.match(refill, /\n {2}rules = \[\n {4}\{ emoji = "🎂", from = "01-22", to = "01-22" \},\n {2}\]\n/);
    });

    test('删除整个 rules 键', () => {
      checkSetValue(PARAMS, 'holidayFavicon', 'rules', undefined, { region });
    });
  });

  test('新增键：插在本表最后一个键之后、表后的空行与注释之前', () => {
    const out = checkSetValue(PARAMS, 'profileMode', 'imageAlt', '头像');
    const idx = tomlKeyLine(PARAMS, 'profileMode', 'imageTitle');
    const ol = out.split('\n');
    assert.equal(ol[idx + 1], '  imageAlt = "头像"');
    assert.equal(lineDiff(PARAMS, out).removed.length, 0);
    const root = checkSetValue(PARAMS, '', 'newRootKey', true);
    const lastRoot = tomlKeyLine(PARAMS, '', 'comments');
    assert.equal(root.split('\n')[lastRoot + 1], 'newRootKey = true');
  });

  test('删除键', () => {
    const out = checkSetValue(PARAMS, 'profileMode', 'imageWidth', undefined);
    assert.equal(lineDiff(PARAMS, out).removed.length, 1);
  });

  test('表不存在 → 在文件末尾新建', () => {
    const out = checkSetValue(PARAMS, 'brandNew.sub', 'k', 'v');
    assert.ok(out.startsWith(PARAMS.endsWith('\n') ? PARAMS : PARAMS + '\n'));
    assert.ok(out.endsWith('\n\n[brandNew.sub]\n  k = "v"\n'));
    const sub = checkSetValue(PARAMS, 'profileMode.extra', 'x', 1);
    assert.deepEqual(parseToml(sub).profileMode.buttons, P.profileMode.buttons);
  });

  test('对表格数组用 setValue → 报错', () => {
    assert.throws(() => setValue(PARAMS, 'socialIcons', 'name', 'x'), TomlPatchError);
  });
});

describe('tomlpatch: replaceArrayOfTables', () => {
  for (const name of ['profileMode.buttons', 'socialIcons']) {
    describe(name, () => {
      const items = clone(getIn(P, name));
      const region = arrayRunRange(PARAMS, name);
      const check = (next) => {
        const out = replaceArrayOfTables(PARAMS, name, next);
        const expected = clone(P);
        const parts = name.split('.');
        let t = expected;
        for (const k of parts.slice(0, -1)) t = t[k];
        if (next.length) t[parts.at(-1)] = clone(next); else delete t[parts.at(-1)];
        assert.deepEqual(clone(parseToml(out)), expected);
        assertOnlyRegionReplaced(PARAMS, out, region[0], region[1]);
        assertCommentsKept(PARAMS, out, region[0], region[1]);
        assertInlineCommentsKept(PARAMS, out, region[0], region[1]);
        return out;
      };

      test('测试前提：至少两项', () => {
        assert.ok(items.length >= 2);
        assert.ok(region);
      });

      test('内容不变 → 原样返回', () => {
        assert.equal(replaceArrayOfTables(PARAMS, name, clone(items)), PARAMS);
      });

      test('修改一项的一个字段：只改那一行', () => {
        const next = clone(items);
        next[0].name = `${next[0].name} · 改 "引号" # 号`;
        const out = check(next);
        const d = lineDiff(PARAMS, out);
        assert.equal(d.removed.length, 1);
        assert.equal(d.added.length, 1);
        assert.match(d.addedLines[0], /^\s+name = /);
      });

      test('新增一项（沿用缩进风格）', () => {
        const next = [...clone(items), { name: 'zhihu', url: 'https://www.zhihu.com/people/x' }];
        const out = check(next);
        const d = lineDiff(PARAMS, out);
        assert.equal(d.removed.length, 0);
        const hdr = PARAMS.split('\n')[region[0]];
        const keyIndent = /^\s*/.exec(PARAMS.split('\n')[region[0] + 1])[0];
        assert.deepEqual(d.addedLines, [hdr.replace(/\s*#.*$/, ''), `${keyIndent}name = "zhihu"`,
          `${keyIndent}url = "https://www.zhihu.com/people/x"`]);
      });

      test('删除一项', () => {
        const out = check(clone(items).slice(1));
        assert.equal(lineDiff(PARAMS, out).added.length, 0);
      });

      test('调换顺序', () => {
        const out = check(clone(items).reverse());
        assert.equal(out.split('\n').length, PARAMS.split('\n').length);
      });

      test('清空（删掉所有块），之后再加回来', () => {
        const empty = check([]);
        assert.equal(getIn(parseToml(empty), name), undefined);
        assert.equal(lineDiff(PARAMS, empty).added.length, 0);
        const back = replaceArrayOfTables(empty, name, clone(items));
        assert.deepEqual(clone(parseToml(back)), clone(P));
        assertCommentsKept(PARAMS, back);
        assertInlineCommentsKept(PARAMS, back);
        if (name === 'profileMode.buttons') assert.equal(back, PARAMS, '上级表有自己的注释时，放回原来的位置');
      });

      test('项里的字段增减与多种类型', () => {
        const next = clone(items);
        delete next[0].url;
        next[0].weight = 3;
        next[0].tags = ['a', 'b'];
        next[0].extra = { a: 1 };
        next[1] = { ...next[1], name: undefined, title: '新' }; // undefined 的字段会被忽略
        check(next);
      });
    });
  }

  test('原来没有这组表时插到上级表最后一个键之后 / 根级追加到末尾', () => {
    const out = replaceArrayOfTables(PARAMS, 'giscus.extra', [{ a: 1 }]);
    assert.deepEqual(parseToml(out).giscus.extra, [{ a: 1 }]);
    assertCommentsKept(PARAMS, out);
    const root = replaceArrayOfTables(PARAMS, 'menuLinks', [{ name: 'x', url: 'y' }]);
    assert.ok(root.endsWith('\n\n[[menuLinks]]\n  name = "x"\n  url = "y"\n'));
    assert.equal(replaceArrayOfTables(PARAMS, 'nothing', []), PARAMS);
  });

  test('不支持的结构 → 报错', () => {
    const split = '[[a]]\n  x = 1\n[b]\n  y = 2\n[[a]]\n  x = 2\n';
    assert.throws(() => replaceArrayOfTables(split, 'a', [{ x: 3 }]), TomlPatchError);
    const sub = '[[a]]\n  x = 1\n  [a.sub]\n    z = 1\n';
    assert.throws(() => replaceArrayOfTables(sub, 'a', [{ x: 3 }]), TomlPatchError);
    assert.throws(() => replaceArrayOfTables('', 'a', [1]), TomlPatchError);
    assert.throws(() => replaceArrayOfTables('', 'a', [{ x: null }]), TomlPatchError);
  });

  test('内联写法的数组（buttons = [...]）也能整体替换', () => {
    const t = '[profileMode]\n  buttons = [{ name = "a", url = "b" }]   # 注释\n';
    const out = replaceArrayOfTables(t, 'profileMode.buttons', [{ name: 'c', url: 'd' }]);
    assert.deepEqual(parseToml(out).profileMode.buttons, [{ name: 'c', url: 'd' }]);
    assert.ok(out.includes('# 注释'));
  });

  test('块之间有空行 / 注释时保留', () => {
    const t = '# 头\n[[s]]\n  n = 1\n\n# 第二个\n[[s]]\n  n = 2\n\n[x]\n  y = 1\n';
    const out = replaceArrayOfTables(t, 's', [{ n: 1 }, { n: 2 }, { n: 3 }]);
    assert.equal(out, '# 头\n[[s]]\n  n = 1\n\n# 第二个\n[[s]]\n  n = 2\n\n[[s]]\n  n = 3\n\n[x]\n  y = 1\n');
    const rev = replaceArrayOfTables(t, 's', [{ n: 2 }, { n: 1 }]);
    assert.deepEqual(parseToml(rev).s, [{ n: 2 }, { n: 1 }]);
    assert.ok(rev.startsWith('# 头\n# 第二个\n[[s]]\n  n = 2\n'));
  });
});

describe('tomlpatch: languages.toml 的语言覆盖', () => {
  const L = parseToml(LANGS);
  const giscusLine = LANGS.split('\n').find((l) => /^\s*lang\s*=/.test(l) && /en/.test(l));

  test('新增 [en.params.profileMode] 的 title / subtitle', () => {
    let t = setValue(LANGS, 'en.params.profileMode', 'subtitle', 'Peking University | Physics');
    t = setValue(t, 'en.params.profileMode', 'title', 'Zhong Fangxiong');
    const expected = clone(L);
    expected.en.params.profileMode = { subtitle: 'Peking University | Physics', title: 'Zhong Fangxiong' };
    assert.deepEqual(clone(parseToml(t)), expected);
    assert.deepEqual(parseToml(t).en.params.giscus, L.en.params.giscus);
    assert.ok(t.startsWith(LANGS.endsWith('\n') ? LANGS : LANGS + '\n'), '原有内容一个字节都不变');
    assert.ok(t.split('\n').includes(giscusLine));
    assert.match(t, /\n {2}\[en\.params\.profileMode\]\n {4}subtitle = "Peking University \| Physics"\n {4}title = "Zhong Fangxiong"\n$/);
    assertCommentsKept(LANGS, t);
  });

  test('再删掉它们 + removeTableIfEmpty → 与原文件完全相同', () => {
    let t = setValue(LANGS, 'en.params.profileMode', 'subtitle', 'x');
    t = setValue(t, 'en.params.profileMode', 'title', 'y');
    t = setValue(t, 'en.params.profileMode', 'subtitle', undefined);
    assert.equal(removeTableIfEmpty(t, 'en.params.profileMode'), t, '还有键时不删');
    t = setValue(t, 'en.params.profileMode', 'title', undefined);
    t = removeTableIfEmpty(t, 'en.params.profileMode');
    assert.equal(t, LANGS);
  });

  test('removeTableIfEmpty：不存在的表 / 有键的表 → 原样', () => {
    assert.equal(removeTableIfEmpty(LANGS, 'en.params.nope'), LANGS);
    assert.equal(removeTableIfEmpty(LANGS, 'en.params.giscus'), LANGS);
    assert.equal(removeTableIfEmpty(LANGS, ''), LANGS);
    const t = '[a]\n  x = 1\n\n[b]\n\n[c]\n  y = 2\n';
    assert.equal(removeTableIfEmpty(t, 'b'), '[a]\n  x = 1\n\n[c]\n  y = 2\n');
    const nested = '[a.b]\n[a.b.c]\n  z = 1\n';
    const r = removeTableIfEmpty(nested, 'a.b');
    assert.deepEqual(parseToml(r), { a: { b: { c: { z: 1 } } } });
  });

  test('根区域没有键时，新键插在第一个表头之前', () => {
    const out = setValue(LANGS, '', 'foo', 1);
    assert.deepEqual(clone(parseToml(out)), { ...clone(L), foo: 1 });
    assert.match(out, /\nfoo = 1\n\n\[zh\]/);
    assertCommentsKept(LANGS, out);
  });

  test('已有语言表里新增键', () => {
    const out = setValue(LANGS, 'en', 'title', 'HimZFX Lab');
    assert.equal(parseToml(out).en.title, 'HimZFX Lab');
    const d = lineDiff(LANGS, out);
    assert.equal(d.removed.length, 0);
    assert.equal(d.addedLines[0], '  title = "HimZFX Lab"');
  });
});

describe('tomlpatch: hugo.toml 根键', () => {
  test('修改 title（第一个表头之前的根区域）', () => {
    const out = checkSetValue(HUGO, '', 'title', "Zhong's Lab · 实验室");
    assert.equal(parseToml(out).title, "Zhong's Lab · 实验室");
    assert.equal(lineDiff(HUGO, out).removed.length, 1);
    assert.equal(parseToml(out).defaultContentLanguage, parseToml(HUGO).defaultContentLanguage);
  });
});

describe('tomlpatch: 特殊字符与边界情况', () => {
  const tricky = [
    'quote " and \\ backslash', '第一行\n第二行\r\n第三行\t制表', '🎂 emoji ü 中文', 'a # b # c', '"#"',
    "it's", '', 'C:\\path\\to', `del\x7fchar ${LS} ${NEL} ${BOM}`, '\x00\x1f',
  ];

  test('字符串往返', () => {
    for (const s of tricky) {
      const out = setValue('[a]\n  k = "x"   # 注释\n', 'a', 'k', s);
      assert.equal(parseToml(out).a.k, s, JSON.stringify(s));
      assert.equal(out.split('\n').length, 3, '仍然是单行');
      assert.ok(out.includes('   # 注释'));
    }
  });

  test('字符串里的 # 不影响下一次修改', () => {
    let t = '[a]\n  k = "x"   # 注释\n  j = 1\n';
    t = setValue(t, 'a', 'k', 'has # hash "and" quotes');
    t = setValue(t, 'a', 'k', 'second # time');
    assert.equal(t, '[a]\n  k = "second # time"   # 注释\n  j = 1\n');
    t = setValue("[a]\n  k = 'lit # eral'  # c\n", 'a', 'k', 'z');
    assert.equal(t, '[a]\n  k = "z"  # c\n');
  });

  test('数字 / 布尔 / 数组 / 内联表', () => {
    const t = '[a]\n  x = 1\n';
    for (const v of [0, -3, 1.5, 1e21, 2 ** 60, true, false, ['a', 'b'], [1, 2], [], { p: 1, 'q r': 'x' },
      [{ a: 1 }, { a: 2, b: [1] }], Infinity, -Infinity]) {
      const out = setValue(t, 'a', 'x', v);
      assert.deepEqual(clone({ v: parseToml(out).a.x }), clone({ v }), JSON.stringify(v));
    }
    assert.ok(Number.isNaN(parseToml(setValue(t, 'a', 'x', NaN)).a.x));
    assert.equal(setValue(t, 'a', 'x', ['a', 'b']), '[a]\n  x = ["a", "b"]\n');
    assert.equal(setValue(t, 'a', 'x', [{ a: 1 }]), '[a]\n  x = [\n    { a = 1 },\n  ]\n');
  });

  test('null / 孤立代理字符 / 不支持的类型 → 报错', () => {
    assert.throws(() => setValue('[a]\n', 'a', 'x', null), TomlPatchError);
    assert.throws(() => setValue('[a]\n', 'a', 'x', 'bad \uD800'), TomlPatchError);
    assert.throws(() => setValue('[a]\n', 'a', 'x', () => 1), TomlPatchError);
    assert.throws(() => setValue('[a]\n', 'a', 'x', [null]), TomlPatchError);
    assert.throws(() => setValue('[a]\n', 'a', '', 1), TomlPatchError);
  });

  test('CRLF：保持 CRLF，原有行逐字节不变', () => {
    const crlf = PARAMS.replace(/\n/g, '\r\n');
    const out = setValue(crlf, 'profileMode', 'title', '新');
    assert.equal(out.replace(/\r\n/g, '').includes('\n'), false, '没有混入 LF');
    assert.equal(out, setValue(PARAMS, 'profileMode', 'title', '新').replace(/\n/g, '\r\n'));
    const added = setValue(crlf, 'profileMode', 'newKey', 1);
    assert.equal(added.replace(/\r\n/g, '').includes('\n'), false);
    const arr = replaceArrayOfTables(crlf, 'socialIcons', [{ name: 'x', url: 'y' }]);
    assert.equal(arr.replace(/\r\n/g, '').includes('\n'), false);
    assert.deepEqual(parseToml(arr).socialIcons, [{ name: 'x', url: 'y' }]);
    // 混合换行：不统一，只保证结果正确、原有行不变
    const mixed = '[a]\r\n  x = 1\n  y = 2\r\n';
    const m = setValue(mixed, 'a', 'x', 5);
    assert.equal(m, '[a]\r\n  x = 5\n  y = 2\r\n');
    assert.equal(setValue(mixed, 'a', 'y', 6), '[a]\r\n  x = 1\n  y = 6\r\n');
  });

  test('BOM：保留', () => {
    const out = setValue(BOM + HUGO, '', 'title', 'x');
    assert.ok(out.startsWith(BOM));
    assert.equal(out.slice(1), setValue(HUGO, '', 'title', 'x'));
    assert.equal(parseToml(out).title, 'x');
  });

  test('多行字符串里像表头 / 键值的内容不会被误认', () => {
    const t = [
      '[a]',
      '  s = """',
      '[fake]',
      'x = 1 # 不是注释',
      '"""',
      "  lit = '''",
      '[[fake2]]',
      "'''",
      '  t = \'lit\'   # c',
      '  arr = [',
      '    "]",  # 方括号在字符串里',
      '    # 数组里的注释',
      '    "x" ,',
      '  ]',
      '[b]',
      '  y = 2',
    ].join('\n') + '\n';
    const before = parseToml(t);
    assert.equal(before.fake, undefined);
    let out = setValue(t, 'a', 't', 'new');
    assert.deepEqual(lineDiff(t, out).removedLines, ["  t = 'lit'   # c"]);
    assert.ok(out.includes('  t = "new"   # c'));
    out = setValue(t, 'a', 'z', 1);
    assert.equal(lineDiff(t, out).addedLines[0], '  z = 1');
    assert.equal(out.split('\n').indexOf('  z = 1'), t.split('\n').indexOf('  ]') + 1);
    out = setValue(t, 'fake', 'x', 2);
    assert.ok(out.endsWith('\n[fake]\n  x = 2\n'));
    out = setValue(t, 'a', 'arr', ['q']);
    assert.deepEqual(parseToml(out).a.arr, ['q']);
    assert.ok(out.includes('  arr = ["q"]\n[b]'));
    out = setValue(t, 'b', 'y', undefined);
    assert.deepEqual(clone(parseToml(out)), { ...clone(before), b: {} });
  });

  test('带点的键、引号键名、表头里的空白', () => {
    const t = '[ "my table" . sub ]\n  "key one" = 1\n  plain.dotted = 2\n';
    let out = setValue(t, ['my table', 'sub'], 'key one', 5);
    assert.equal(out, '[ "my table" . sub ]\n  "key one" = 5\n  plain.dotted = 2\n');
    out = setValue(t, ['my table', 'sub'], ['plain', 'dotted'], 3);
    assert.equal(parseToml(out)['my table'].sub.plain.dotted, 3);
    out = setValue(t, ['my table', 'sub'], 'new key', 'v');
    assert.ok(out.endsWith('  "new key" = "v"\n'));
  });

  test('空文件 / 没有结尾换行', () => {
    assert.equal(setValue('', '', 'a', 1), 'a = 1\n');
    assert.equal(setValue('', 't', 'a', 1), '[t]\n  a = 1\n');
    assert.equal(setValue('x = 1', '', 'y', 2), 'x = 1\ny = 2\n');
    assert.equal(setValue('[t]\n  x = 1', 't', 'x', 2), '[t]\n  x = 2');
    assert.equal(setValue('[t]', 't', 'x', 2), '[t]\n  x = 2\n');
    assert.equal(setValue('# 只有注释', '', 'x', 1), '# 只有注释\nx = 1\n');
  });

  test('校验失败的路径：写出来会改变别的值或无法解析时抛错', () => {
    // 键已用带点写法定义成表，再插入同名键会冲突
    assert.throws(() => setValue('[a]\n  b.c = 1\n', 'a', 'b', 5),
      (e) => e instanceof TomlPatchError && /校验未通过/.test(e.message));
    // 表是内联表定义的，不能再新建 [p] 表头
    assert.throws(() => setValue('p = { title = "x" }\n', 'p', 'subtitle', 'y'), TomlPatchError);
    // 表由带点的键隐式定义：删不掉那一行，校验会发现键还在
    assert.throws(() => setValue('[en]\n  params.title = "x"\n', 'en.params', 'title', undefined), TomlPatchError);
    // 原文件本身有错
    assert.throws(() => setValue('[a\n', 'a', 'x', 1), TomlPatchError);
    assert.throws(() => replaceArrayOfTables('x = [', 'a', []), TomlPatchError);
  });
});

// ===========================================================================
// 全量扫描：真实文件里的每一个键都改一遍
// ===========================================================================

/** 给一个值造一个「同类型但不同」的新值。 */
function variantOf(v) {
  if (typeof v === 'string') return `${v}·改 "#" \\`;
  if (typeof v === 'boolean') return !v;
  if (typeof v === 'number') return v + 7;
  if (Array.isArray(v)) return [...clone(v), typeof v[0] === 'number' ? 1 : 'x'];
  return undefined;
}

describe('全量：每个 content 文件的每个顶层键', () => {
  for (const file of MD_FILES) {
    test(file, () => {
      const { fmText } = splitDocument(read(file));
      const fm = parseFrontMatter(fmText);
      const lines = fmText.split('\n');
      for (const key of Object.keys(fm)) {
        const nv = variantOf(fm[key]);
        if (nv === undefined) continue;
        const out = setFields(fmText, { [key]: nv });
        assert.deepEqual(parseFrontMatter(out), { ...fm, [key]: nv }, `${file} ${key}`);
        const d = lineDiff(fmText, out);
        const idx = lines.findIndex((l) => l.startsWith(`${key}:`));
        assert.deepEqual(d.removed, [idx], `${file} ${key} 只改一行`);
        const comment = trailingComment(lines[idx]);
        if (comment) assert.ok(d.addedLines[0].endsWith(comment), `${file} ${key} 保留注释`);
        const del = setFields(fmText, { [key]: undefined });
        const e = { ...fm };
        delete e[key];
        assert.deepEqual(parseFrontMatter(del), e);
      }
    });
  }
});

/** 列出 TOML 里所有「普通表」中的标量 / 数组键：[[表格数组]] 的内容除外。 */
function leafKeys(obj, prefix = []) {
  const out = [];
  for (const [k, v] of Object.entries(obj)) {
    if (Array.isArray(v) && v.length && v.every((x) => x && typeof x === 'object' && !Array.isArray(x))) continue;
    if (v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date)) out.push(...leafKeys(v, [...prefix, k]));
    else out.push([prefix, k, v]);
  }
  return out;
}

describe('全量：config/_default/*.toml 的每个键', () => {
  const files = fs.readdirSync(path.join(ROOT, 'config/_default')).filter((f) => f.endsWith('.toml')).sort();
  for (const f of files) {
    test(f, () => {
      const text = read(`config/_default/${f}`);
      const obj = parseToml(text);
      const leaves = leafKeys(obj);
      assert.ok(leaves.length > 0 || f === 'module.toml');
      for (const [table, key, v] of leaves) {
        const nv = variantOf(v);
        if (nv === undefined) continue;
        const tableStr = table.join('.');
        const out = setValue(text, tableStr, key, nv);
        const expected = clone(obj);
        let t = expected;
        for (const k of table) t = t[k];
        t[key] = clone(nv);
        assert.deepEqual(clone(parseToml(out)), expected, `${f} ${tableStr}.${key}`);
        const line = tomlKeyLine(text, tableStr, key);
        assert.ok(line >= 0, `${f} 找到 ${tableStr}.${key} 所在行`);
        const d = lineDiff(text, out);
        assert.deepEqual(d.removed, [line], `${f} ${tableStr}.${key} 只改一行`);
        assert.equal(d.added.length, 1);
        const comment = trailingComment(text.split('\n')[line]);
        if (comment) assert.ok(d.addedLines[0].endsWith(comment), `${f} ${tableStr}.${key} 保留注释`);
        // 删除再加回：结果可解析且值正确
        const del = setValue(text, tableStr, key, undefined);
        assert.equal(getIn(parseToml(del), [...table, key]), undefined);
        const back = setValue(del, tableStr, key, v instanceof Date ? v : clone(v));
        assert.deepEqual(clone(parseToml(back)), clone(obj));
      }
    });
  }

  test('module.toml 的 [[mounts]]：修改 / 增加 / 删除', () => {
    const text = read('config/_default/module.toml');
    const mounts = clone(parseToml(text).mounts);
    assert.ok(mounts.length >= 1);
    const region = arrayRunRange(text, 'mounts');
    const add = [...mounts, { source: 'content', target: 'content', lang: 'ja' }];
    const out = replaceArrayOfTables(text, 'mounts', add);
    assert.deepEqual(clone(parseToml(out)).mounts, add);
    assertOnlyRegionReplaced(text, out, region[0], region[1]);
    assertCommentsKept(text, out, region[0], region[1]);
    // 块之间原本有空行：新块也空一行
    if (mounts.length >= 2) assert.ok(out.includes('\n\n[[mounts]]\n  source = "content"\n  target = "content"\n  lang = "ja"\n'));
    const back = replaceArrayOfTables(out, 'mounts', mounts);
    assert.equal(back, text);
  });
});

// ===========================================================================
// 随机组合（固定种子，可复现）：任何一步要么结果完全正确，要么抛出对应的错误类型
// ===========================================================================

function makeRandom(seed) {
  let s = seed;
  const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const STR = ['', 'a', 'x # y', '"q"', '\\', '中文', '🎂', 'line\nbreak', "it's", ' sp ', '[x]', 'k = v', '{a}', 'yes', '1'];
  const value = (d = 0) => {
    const t = rnd();
    if (t < 0.4) return pick(STR);
    if (t < 0.55) return Math.floor(rnd() * 1000) - 500;
    if (t < 0.65) return rnd() < 0.5;
    if (t < 0.75) return Math.round(rnd() * 1000) / 8;
    if (t < 0.88 && d < 2) return Array.from({ length: Math.floor(rnd() * 3) }, () => value(d + 1));
    if (d < 2) {
      const o = {};
      for (let i = 0; i < Math.floor(rnd() * 3); i++) o[pick(['a', 'b', 'name', 'k k'])] = value(d + 1);
      return o;
    }
    return 'z';
  };
  return { rnd, pick, value, STR };
}

/** 与键顺序无关的比较 */
function sameData(a, b) {
  const norm = (v) => {
    if (Array.isArray(v)) return v.map(norm);
    if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, norm(v[k])]));
    return v;
  };
  return JSON.stringify(norm(a)) === JSON.stringify(norm(b));
}

function commentLinesKept(orig, out) {
  const comments = orig.split('\n').filter((l) => /^\s*#/.test(l));
  let k = 0;
  for (const l of out.split('\n')) if (k < comments.length && l === comments[k]) k++;
  return k === comments.length;
}

describe('随机组合修改', () => {
  test('TOML：随机 setValue / replaceArrayOfTables / removeTableIfEmpty', () => {
    const { rnd, pick, value, STR } = makeRandom(20261031);
    const files = ['params.toml', 'languages.toml', 'hugo.toml', 'markup.toml', 'module.toml']
      .map((f) => read(`config/_default/${f}`));
    let applied = 0;
    for (let iter = 0; iter < 60; iter++) {
      const orig = pick(files);
      let text = orig;
      for (let step = 0; step < 8; step++) {
        const obj = parseToml(text);
        const expected = clone(obj);
        const tables = [''];
        (function walk(o, p) {
          for (const [k, v] of Object.entries(o)) {
            if (v && typeof v === 'object' && !Array.isArray(v)) { tables.push([...p, k].join('.')); walk(v, [...p, k]); }
          }
        })(obj, []);
        try {
          const r = rnd();
          if (r < 0.6) {
            const table = rnd() < 0.85 ? pick(tables) : pick(['newt', 'en.params.profileMode', 'zz.yy']);
            const t = getIn(obj, table ? table.split('.') : []) || {};
            const keys = Object.keys(t).filter((k) => typeof t[k] !== 'object' || (Array.isArray(t[k]) && !t[k].some((x) => x && typeof x === 'object' && !Array.isArray(x))));
            const key = keys.length && rnd() < 0.7 ? pick(keys) : pick(['newKey', 'title']);
            const v = rnd() < 0.15 ? undefined : value();
            const out = setValue(text, table, key, v);
            if (v !== undefined) {
              let tt = expected;
              for (const k of (table ? table.split('.') : [])) { if (!tt[k] || typeof tt[k] !== 'object') tt[k] = {}; tt = tt[k]; }
              tt[key] = clone(v);
            } else {
              const tt = getIn(expected, table ? table.split('.') : []);
              if (tt && typeof tt === 'object') delete tt[key];
            }
            assert.ok(sameData(parseToml(out), expected), `setValue ${table} ${key} ${JSON.stringify(v)}`);
            text = out;
          } else if (r < 0.9) {
            const name = pick(['profileMode.buttons', 'socialIcons', 'mounts', 'newarr']);
            const cur = getIn(obj, name);
            let items = Array.isArray(cur) ? clone(cur) : [];
            const op = rnd();
            if (op < 0.25 && items.length) items.splice(Math.floor(rnd() * items.length), 1);
            else if (op < 0.5) items.splice(Math.floor(rnd() * (items.length + 1)), 0, { name: pick(STR), url: pick(STR) });
            else if (op < 0.7 && items.length) { const i = Math.floor(rnd() * items.length); items[i] = { ...items[i], [pick(['name', 'url', 'extra'])]: value() }; }
            else if (op < 0.85) items.reverse();
            else items = [];
            const out = replaceArrayOfTables(text, name, items);
            const parts = name.split('.');
            if (items.length) {
              let tt = expected;
              for (const k of parts.slice(0, -1)) tt = tt[k] ??= {};
              tt[parts.at(-1)] = clone(items);
            } else {
              const tt = getIn(expected, parts.slice(0, -1));
              if (tt) delete tt[parts.at(-1)];
              // 上级表原本只是隐式存在（没有自己的表头），删光后它也随之消失
              if (parts.length > 1 && tt && !Object.keys(tt).length && getIn(parseToml(out), parts.slice(0, -1)) === undefined) {
                delete getIn(expected, parts.slice(0, -2))[parts.at(-2)];
              }
            }
            assert.ok(sameData(parseToml(out), expected), `replaceArrayOfTables ${name}`);
            text = out;
          } else {
            const out = removeTableIfEmpty(text, pick([...tables.filter(Boolean), 'en.params.profileMode']));
            parseToml(out);
            text = out;
          }
          applied++;
        } catch (e) {
          if (!(e instanceof TomlPatchError)) throw e;
          // 拒绝修改时文件保持原样，不会写坏
        }
      }
      assert.ok(commentLinesKept(orig, text), '独立的注释行都还在、顺序不变');
    }
    assert.ok(applied > 300, `应用了 ${applied} 次修改`);
  });

  test('YAML：随机 setFields', () => {
    const { rnd, pick, value, STR } = makeRandom(4242);
    const docs = MD_FILES.map((f) => splitDocument(read(f)).fmText);
    let applied = 0;
    for (let iter = 0; iter < 60; iter++) {
      const orig = pick(docs);
      let fmText = orig;
      for (let step = 0; step < 8; step++) {
        const cur = parseFrontMatter(fmText);
        const upd = {};
        for (let i = 0; i < 1 + Math.floor(rnd() * 3); i++) {
          const key = rnd() < 0.6 ? pick(Object.keys(cur)) : pick(['tags', 'cover', 'menu', 'x y', 'true', 'description']);
          upd[key] = rnd() < 0.15 ? undefined
            : key === 'menu' && rnd() < 0.6
              ? { main: { weight: Math.floor(rnd() * 100), ...(rnd() < 0.3 ? { name: pick(STR) } : {}) }, ...(rnd() < 0.3 ? { footer: { weight: 1 } } : {}) }
              : value();
        }
        const out = setFields(fmText, upd);
        const exp = { ...cur };
        for (const [k, v] of Object.entries(upd)) { if (v === undefined) delete exp[k]; else exp[k] = clone(v); }
        assert.ok(sameData(parseFrontMatter(out), exp), JSON.stringify(upd));
        fmText = out;
        applied++;
      }
      assert.ok(commentLinesKept(orig, fmText));
    }
    assert.equal(applied, 480);
  });
});
