// 单元测试：高亮（==文字== → <mark>）—— 网站配置、后台编辑器 / 预览的选项保持一致，
// 以及保存时的三方合并（mergeBody）不会动到含 == 的公式和代码。
// 运行：node --test tests/admin/mark.test.mjs
// 编辑器里真正的「选中 → 高亮 → 发表 → Hugo 构建」流程见 e2e-editor.mjs。

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseToml, getIn } from '../../static/admin/js/tomlpatch.js';
import { mergeBody, markTextCandidates } from '../../static/admin/js/views/editor.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

describe('高亮：网站和后台的设置一致', () => {
  test('markup.toml 打开 goldmark 的 mark 扩展，公式的 passthrough 不变', () => {
    const cfg = parseToml(read('config/_default/markup.toml'));
    assert.equal(getIn(cfg, ['goldmark', 'extensions', 'extras', 'mark', 'enable']), true);
    const pt = getIn(cfg, ['goldmark', 'extensions', 'passthrough']);
    assert.equal(pt.enable, true);
    assert.deepEqual(pt.delimiters.inline, [['$', '$'], ['\\(', '\\)']]);
    assert.deepEqual(pt.delimiters.block, [['$$', '$$'], ['\\[', '\\]']]);
    assert.equal(getIn(cfg, ['goldmark', 'renderer', 'unsafe']), true);
  });

  test('网站样式表里有 <mark> 的浅色 / 深色样式', () => {
    const css = read('assets/css/extended/mark.css');
    assert.match(css, /(^|\n)mark\s*\{[^}]*background/);
    assert.match(css, /\[data-theme="dark"\] mark/);
    // 禁用 JavaScript 时 PaperMod 不设 data-theme，深色系统下也要变暗
    assert.match(css, /@media \(prefers-color-scheme: dark\)\s*\{\s*:root:not\(\[data-theme="light"\]\):not\(\[data-theme="dark"\]\) mark/);
  });

  test('编辑器和手机预览都用 VDITOR_MARKDOWN（mark: true）', () => {
    const pv = read('static/admin/js/preview.js');
    assert.match(pv, /export const VDITOR_MARKDOWN = Object\.freeze\(\{ mark: true \}\)/);
    assert.match(pv, /md2html\(md, \{[^}]*markdown: \{ \.\.\.VDITOR_MARKDOWN \}/);
    const ed = read('static/admin/js/views/editor.js');
    assert.match(ed, /markdown: \{ \.\.\.VDITOR_MARKDOWN \}/);
    assert.match(ed, /name: 'mark', tip: '高亮'/);
  });
});

describe('高亮：保存时的三方合并', () => {
  const FILE = [
    '行内公式 $a==b$、\\(c==d==e\\) 和 `x==y==z`。',
    '',
    '$$',
    'x == y == z',
    '$$',
    '',
    '\\[',
    'p==q==r',
    '\\]',
    '',
    '```python',
    'if a == b == c:',
    '    pass',
    '```',
    '',
    '最后一段。',
  ].join('\n') + '\n';

  test('只改了一行（加上 ==高亮==）：其余含 == 的公式 / 代码逐字节保留', () => {
    // base / ours 是 Vditor 的输出（这里假设它把 \\[ 块改写了，以确认没改的行仍取原文）
    const base = FILE.replace('\\[\np==q==r\n\\]', '\\[\np==q==r\n\\\\]');
    const ours = base.replace('最后一段。', '最后==一段==。');
    assert.equal(mergeBody(base, ours, FILE), FILE.replace('最后一段。', '最后==一段==。'));
  });

  test('没改：原文原样返回', () => {
    assert.equal(mergeBody(FILE, FILE, FILE), FILE);
  });

  test('取消高亮：==…== 去掉后只有那一行变化', () => {
    const marked = FILE.replace('最后一段。', '最后==一段==。');
    assert.equal(mergeBody(marked, FILE, marked), FILE);
  });
});

describe('高亮：源码 / 即时渲染模式的写法（markTextCandidates）', () => {
  // CommonMark 的左右侧规则（Lute 和网站的 goldmark 都这样判断 == 和 **）
  const P = /[\p{P}\p{S}]/u;
  const ws = (c) => !c || /\s/.test(c);
  const opens = (b, a) => !ws(a) && (!P.test(a) || ws(b) || P.test(b));
  const closes = (b, a) => !ws(b) && (!P.test(b) || ws(a) || P.test(a));
  /** prev + value + next 里新加的那对 == 能不能成对（只看 == 本身） */
  function markOk(prev, c, next) {
    const line = prev.slice(0, prev.length - c.lift) + c.value + next.slice(c.lift);
    const i = line.indexOf('==', prev.length - c.lift);
    const j = line.indexOf('==', i + 2);
    return opens(line[i - 1], line[i + 2]) && closes(line[j - 1], line[j + 2]);
  }
  const first = (text, prev, next) => markTextCandidates(text, prev, next).find((c) => markOk(prev, c, next));

  test('普通文字：原样加 ==，不加空格', () => {
    assert.deepEqual(markTextCandidates('重点', '这是', '内容')[0], { value: '==重点==', spaced: false, lift: 0 });
    assert.deepEqual(first('word', 'a ', ' b'), { value: '==word==', spaced: false, lift: 0 });
  });

  test('两头是中文标点：标点放到 == 外面（这是==重点==，内容）', () => {
    assert.equal(first('重点，', '这是', '内容').value, '==重点==，');
    assert.equal(first('“引用”', '这是', '后面').value, '“==引用==”');
    assert.equal(first('“引用”', '这是', '后面').spaced, false);
  });

  test('选中加粗（含 **）且两边是文字：在两边加空格', () => {
    const c = first('**粗体**', '文字', '文字');
    assert.deepEqual(c, { value: ' ==**粗体**== ', spaced: true, lift: 0 });
  });

  test('只选中 **粗体** 里的字：把 ** 也包进来，再加空格（不会变成坏掉的 **==粗体==**）', () => {
    const all = markTextCandidates('粗体', '文字**', '**文字');
    assert.ok(all.some((c) => c.lift === 2 && c.value === ' ==**粗体**== '), JSON.stringify(all));
    // 英文里两边有空格时，原样放在加粗里面就行
    assert.equal(markTextCandidates('bold', 'a **', '** b')[0].value, '==bold==');
  });

  test('选区两头的空格留在 == 外面；空选区没有写法', () => {
    assert.equal(markTextCandidates(' 重点 ', '这是', '内容')[0].value, ' ==重点== ');
    assert.deepEqual(markTextCandidates('  ', 'a', 'b'), []);
  });
});
