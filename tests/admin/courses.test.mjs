// courses.test.mjs — 课程模型（static/admin/js/courses.js）和上传共用逻辑（static/admin/js/uploads.js）的纯函数。
//
// 运行：node --test tests/admin/courses.test.mjs

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  COURSES_DIR, courseSlugOf, isCourseDir, isInCourse, collectCourses, weightOf, groupOf, sortByWeight, groupCourses,
  reweight, nextWeights, titleFromFileName, itemSlugFor, courseSlugSuggestion, materialsDirFor, showMaterialsOf,
  courseIndexDocument, itemDocument, itemBodyFor, patchFields, frontMatterOf, canEmbedPdf,
  groupKey, canonicalGroup, DRAFT_CASCADE, isDraftCascade, draftCascadeUpdate, courseDeletionPlan,
} from '../../static/admin/js/courses.js';
import {
  uploadBlockReason, BLOCKED_UPLOAD_EXTS, BLOCKED_UPLOAD_EXPLAIN, assignUniqueNames, checkUploads, needsReview,
  createIgnoreMatcher, isJunkFile, staticFileUrl, staticPreviewUrl, usesViewer,
} from '../../static/admin/js/uploads.js';
import { createIgnoreMatcher as fromFiles } from '../../static/admin/js/views/files.js';
import { safeFileName } from '../../static/admin/js/images.js';
import { splitDocument, parseFrontMatter, setFields } from '../../static/admin/js/frontmatter.js';

const LANGS = ['zh', 'en'];

describe('courses: paths', () => {
  test('courseSlugOf / isCourseDir / isInCourse', () => {
    assert.equal(COURSES_DIR, 'content/courses');
    assert.equal(courseSlugOf('content/courses/modern-lab/_index.md'), 'modern-lab');
    assert.equal(courseSlugOf('content/courses/modern-lab/exp-1.en.md'), 'modern-lab');
    assert.equal(courseSlugOf('content/courses/_index.md'), null, 'the landing page is not a course');
    assert.equal(courseSlugOf('content/courses/a/b/c.md'), null, 'deeper files are not course pages');
    assert.equal(courseSlugOf('content/posts/a.md'), null);
    assert.equal(isCourseDir('content/courses/x'), true);
    assert.equal(isCourseDir('content/courses/x/'), true);
    assert.equal(isCourseDir('content/courses'), false);
    assert.equal(isCourseDir('content/courses/x/y'), false);
    assert.equal(isInCourse('content/courses/x/a.md'), true);
    assert.equal(isInCourse('content/courses/_index.en.md'), false);
  });

  test('collectCourses groups index + items per course', () => {
    const entries = [
      'content/courses/_index.md', 'content/courses/_index.en.md',
      'content/courses/lab/_index.md', 'content/courses/lab/_index.en.md',
      'content/courses/lab/exp-1.md', 'content/courses/lab/exp-1.en.md', 'content/courses/lab/exp-2.md',
      'content/courses/optics/_index.md',
      'content/courses/orphan/note.md',
      'content/courses/lab/sub/deep.md',
      'content/posts/a.md',
    ].map((path) => ({ path }));
    const cs = collectCourses(entries, LANGS);
    assert.deepEqual(cs.map((c) => c.slug), ['lab', 'optics', 'orphan']);
    const lab = cs[0];
    assert.equal(lab.hasIndex, true);
    assert.deepEqual(lab.index.variants, { shared: 'content/courses/lab/_index.md', en: 'content/courses/lab/_index.en.md' });
    assert.deepEqual(lab.items.map((g) => g.base), ['exp-1', 'exp-2']);
    assert.deepEqual(lab.items[0].variants, { shared: 'content/courses/lab/exp-1.md', en: 'content/courses/lab/exp-1.en.md' });
    assert.equal(cs[2].hasIndex, false);
  });

  test('materialsDirFor / showMaterialsOf', () => {
    assert.equal(materialsDirFor('lab'), 'static/documents/courses/lab');
    assert.equal(materialsDirFor('lab', { materialsDir: 'static/documents/lab-reports/' }), 'static/documents/lab-reports');
    assert.equal(materialsDirFor('lab', { materialsDir: 'documents/x' }), 'static/documents/x');
    assert.equal(materialsDirFor('lab', { materialsDir: 'static/../config' }), 'static/documents/courses/lab', 'no ..');
    assert.equal(materialsDirFor('lab', { materialsDir: 'static/admin/x' }), 'static/documents/courses/lab', 'never admin/');
    assert.equal(materialsDirFor('lab', { materialsDir: '/static/viewer' }), 'static/documents/courses/lab', 'never viewer/');
    assert.equal(showMaterialsOf({}), true);
    assert.equal(showMaterialsOf({ showMaterials: false }), false);
    assert.equal(showMaterialsOf({ showMaterials: 'false' }), false);
    assert.equal(showMaterialsOf({ showMaterials: true }), true);
  });
});

describe('courses: ordering and grouping', () => {
  test('weightOf / groupOf', () => {
    assert.equal(weightOf({ weight: 10 }), 10);
    assert.equal(weightOf({ weight: '20' }), 20);
    assert.equal(weightOf({ weight: 0 }), null, 'Hugo: 0 = no weight');
    assert.equal(weightOf({}), null);
    assert.equal(groupOf({ group: ' 实验课 ' }), '实验课');
    assert.equal(groupOf({}), '');
  });

  test('sortByWeight: weight, then title; unweighted last', () => {
    const list = [
      { title: '乙', weight: 20 }, { title: '甲', weight: 20 }, { title: 'Z', weight: null }, { title: 'A', weight: 5 },
    ];
    assert.deepEqual(sortByWeight(list).map((x) => x.title), ['A', '甲', '乙', 'Z']);
  });

  test('groupCourses: no groups → one plain list', () => {
    const r = groupCourses([{ title: 'B', weight: 20, group: '' }, { title: 'A', weight: 10, group: '' }]);
    assert.equal(r.length, 1);
    assert.equal(r[0].name, null);
    assert.deepEqual(r[0].courses.map((c) => c.title), ['A', 'B']);
  });

  test('groupCourses: groups by min weight (ties by name), ungrouped last in 其他', () => {
    const r = groupCourses([
      { title: 'A', weight: 30, group: '实验课' },
      { title: 'B', weight: 10, group: '理论课' },
      { title: 'C', weight: 20, group: '' },
      { title: 'D', weight: 5, group: '实验课' },
      { title: 'E', weight: 40, group: 'b组' },
      { title: 'F', weight: 40, group: 'a组' },
    ]);
    assert.deepEqual(r.map((g) => [g.name, g.courses.map((c) => c.title)]),
      [['实验课', ['D', 'A']], ['理论课', ['B']], ['a组', ['F']], ['b组', ['E']], ['其他', ['C']]]);
    assert.equal(r.at(-1).other, true);
    assert.equal(groupCourses([{ title: 'X', weight: 1, group: '' }, { title: 'Y', weight: 2, group: 'g' }], (x) => x, 'Other').at(-1).name, 'Other');
  });

  test('reweight: swaps keep distinct weights, otherwise renumber 10, 20, …', () => {
    assert.deepEqual([...reweight(['b', 'a', 'c'], { a: 10, b: 20, c: 30 })], [['b', 10], ['a', 20], ['c', 30]]);
    assert.deepEqual([...reweight(['a', 'b'], new Map([['a', 5], ['b', 5]]))], [['a', 10], ['b', 20]], 'duplicates → renumber');
    assert.deepEqual([...reweight(['a', 'b'], { a: null, b: 3 })], [['a', 10], ['b', 20]], 'missing → renumber');
  });

  test('nextWeights continues after the current max in steps of 10', () => {
    assert.deepEqual(nextWeights([], 3), [10, 20, 30]);
    assert.deepEqual(nextWeights([10, 20], 2), [30, 40]);
    assert.deepEqual(nextWeights([25, null], 1), [30]);
    assert.deepEqual(nextWeights([30], 1), [40]);
  });
});

describe('courses: names, slugs and new files', () => {
  test('titleFromFileName', () => {
    assert.equal(titleFromFileName('实验1-光电效应_报告.pdf'), '实验1 光电效应 报告');
    assert.equal(titleFromFileName('Lab_2--Franck-Hertz.PDF'), 'Lab 2 Franck Hertz');
    assert.equal(titleFromFileName('C:\\fakepath\\图 3.png'), '图 3');
    assert.equal(titleFromFileName('README'), 'README');
    assert.equal(titleFromFileName('.pdf'), '.pdf');
    assert.equal(titleFromFileName('---.pdf'), '未命名');
  });

  test('itemSlugFor: from title, then file name, then item-<digits>; unique', () => {
    assert.equal(itemSlugFor('Experiment 2: Franck-Hertz'), 'experiment-2-franck-hertz');
    assert.equal(itemSlugFor('实验1 光电效应', '实验1-光电效应.pdf'), 'item-1');
    assert.equal(itemSlugFor('光电效应', 'photoelectric.pdf'), 'photoelectric');
    assert.equal(itemSlugFor('报告', '报告.pdf'), 'item');
    assert.equal(itemSlugFor('实验1', '', ['item-1']), 'item-1-2');
    assert.equal(itemSlugFor('Lab', '', ['LAB', 'lab-2']), 'lab-3');
  });

  test('courseSlugSuggestion prefers the English name', () => {
    assert.equal(courseSlugSuggestion('Modern Physics Lab', '近代物理实验'), 'modern-physics-lab');
    assert.equal(courseSlugSuggestion('', '近代物理实验'), '');
    assert.equal(courseSlugSuggestion('', 'C++ 程序设计'), 'c');
  });

  test('courseIndexDocument: contract front matter, no menu', () => {
    const doc = courseIndexDocument({ title: '近代物理实验', description: '每个实验一篇报告', group: '实验课', weight: 30 });
    assert.equal(doc, '---\ntitle: "近代物理实验"\ndescription: "每个实验一篇报告"\ngroup: "实验课"\nweight: 30\n---\n');
    const fm = frontMatterOf(doc).fm;
    assert.deepEqual(fm, { title: '近代物理实验', description: '每个实验一篇报告', group: '实验课', weight: 30 });
    assert.equal(courseIndexDocument({ title: 'X', weight: 10 }), '---\ntitle: "X"\nweight: 10\n---\n', 'no empty group / description');
    assert.ok(!/menu/.test(courseIndexDocument({ title: 'menu', weight: 1 }).split('\n').slice(1, -2).join('\n').replace('"menu"', '')));
  });

  test('itemDocument + itemBodyFor', () => {
    const body = itemBodyFor('static/documents/courses/lab/实验1-光电效应.pdf', '实验1 光电效应');
    assert.equal(body, '{{< pdf "/documents/courses/lab/实验1-光电效应.pdf" >}}');
    const doc = itemDocument({ title: '实验1 光电效应', weight: 30 }, body);
    assert.equal(doc, '---\ntitle: "实验1 光电效应"\nweight: 30\ndraft: false\n---\n\n{{< pdf "/documents/courses/lab/实验1-光电效应.pdf" >}}\n');
    assert.deepEqual(parseFrontMatter(splitDocument(doc).fmText), { title: '实验1 光电效应', weight: 30, draft: false });
    assert.equal(itemBodyFor('static/documents/courses/lab/装置.jpg', '装置 [1]'), '![装置 \\[1\\]](/documents/courses/lab/装置.jpg)');
    assert.equal(itemBodyFor('static/documents/courses/lab/data.xlsx', '数据'), '[下载 data.xlsx](/documents/courses/lab/data.xlsx)');
    assert.equal(itemBodyFor('static/documents/courses/lab/a b.zip', 'x'), '[下载 a b.zip](/documents/courses/lab/a%20b.zip)');
    assert.equal(canEmbedPdf('/documents/a"b.pdf'), false);
    assert.equal(canEmbedPdf('/admin/a.pdf'), false);
    assert.match(itemDocument({ title: 'T', weight: 10, description: '一句话' }, 'x'), /^---\ntitle: "T"\nweight: 10\ndescription: "一句话"\ndraft: false\n---\n\nx\n$/);
  });

  test('patchFields: surgical weight / group edits keep comments and body', () => {
    const text = '---\ntitle: "近代物理实验"  # 课程名\ngroup: "实验课" # 分组\nweight: 20 # 顺序\nmaterialsDir: "static/documents/x/"\n---\n\n正文 **不变**\n';
    const out = patchFields(text, { weight: 10 });
    assert.equal(out, text.replace('weight: 20 # 顺序', 'weight: 10 # 顺序'));
    const g = patchFields(text, { group: '实验' });
    assert.equal(g, text.replace('group: "实验课" # 分组', 'group: "实验" # 分组'));
    const del = patchFields(text, { group: undefined });
    assert.ok(!del.includes('group:'));
    assert.ok(del.endsWith('---\n\n正文 **不变**\n'));
    assert.equal(patchFields(text, { weight: 20 }), text, 'unchanged value → identical text');
    assert.throws(() => patchFields('+++\ntitle = "x"\n+++\n', { weight: 1 }), /YAML/);
  });
});

describe('uploads: blocked types (same-origin scripts)', () => {
  test('html / xml / svg / js are refused, with a clear Chinese note', () => {
    for (const ext of ['html', 'htm', 'xhtml', 'shtml', 'xml', 'svg', 'js', 'mjs']) {
      assert.ok(BLOCKED_UPLOAD_EXTS.includes(ext), ext);
      const r = uploadBlockReason(`a.${ext}`);
      assert.ok(r, ext);
      assert.equal(r.ext, ext);
    }
    assert.match(uploadBlockReason('图.SVG').note, /SVG.*转换成 PNG/);
    assert.equal(uploadBlockReason('图.SVG').svg, true);
    assert.match(uploadBlockReason('page.HTML').note, /\.html.*PDF/);
    assert.match(BLOCKED_UPLOAD_EXPLAIN, /登录令牌/);
    assert.match(BLOCKED_UPLOAD_EXPLAIN, /PNG/);
  });

  test('tricky names: trailing dots / spaces / zero-width, and checking the final safe name', () => {
    assert.ok(uploadBlockReason('x.html.'));
    assert.ok(uploadBlockReason('x.html '));
    assert.ok(uploadBlockReason('x.HTML\u200b'));
    // safeFileName turns a non-extension suffix into part of the stem: the *final* name is what gets served
    const odd = 'evil.Html\u200b';
    assert.equal(safeFileName(odd), 'evil.Html');
    assert.ok(uploadBlockReason('whatever.pdf', safeFileName(odd)));
    assert.equal(uploadBlockReason('report.pdf'), null);
    assert.equal(uploadBlockReason('photo.png', 'photo.jpg'), null);
    assert.equal(uploadBlockReason('notes.html.pdf'), null, 'served as application/pdf');
    assert.equal(uploadBlockReason('README'), null);
    assert.equal(uploadBlockReason('data.json'), null);
  });

  test('checkUploads: refused / ready / warnings', () => {
    const repo = {
      entries: new Map([['static/documents/old.pdf', { sha: 'abc', size: 10 }]]),
      entry(p) { return this.entries.get(p) || null; },
      list(prefix) { return prefix === 'static/documents/dir.pdf/' ? [{ path: 'static/documents/dir.pdf/x' }] : []; },
    };
    const items = [
      { name: 'a.pdf', path: 'static/documents/a.pdf', size: 100 },
      { name: 'old.pdf', path: 'static/documents/old.pdf', size: 100 },
      { name: 'x.svg', origName: 'x.svg', path: 'static/documents/x.svg', size: 100 },
      { name: 'big.zip', path: 'static/documents/big.zip', size: 96 * 1024 * 1024 },
      { name: 'mid.zip', path: 'static/documents/mid.zip', size: 30 * 1024 * 1024 },
      { name: 'dir.pdf', path: 'static/documents/dir.pdf', size: 1 },
      { name: 'p.heic', path: 'static/documents/p.heic', size: 1 },
      { name: 'secret.pdf', path: 'static/documents/secret.pdf', size: 1 },
    ];
    const r = checkUploads(repo, items, createIgnoreMatcher('static/documents/secret.pdf\n'));
    assert.deepEqual(r.refused.map((i) => i.name), ['x.svg', 'big.zip', 'dir.pdf']);
    assert.equal(items[2].blocked, true);
    assert.match(items[2].note, /PNG/);
    assert.deepEqual(r.ready.map((i) => i.name), ['a.pdf', 'old.pdf', 'mid.zip', 'p.heic', 'secret.pdf']);
    assert.deepEqual(r.overwrite.map((i) => i.name), ['old.pdf']);
    assert.deepEqual(r.overwrite[0].existing, { sha: 'abc', size: 10 });
    assert.deepEqual(r.large.map((i) => i.name), ['mid.zip']);
    assert.deepEqual(r.heic.map((i) => i.name), ['p.heic']);
    assert.deepEqual(r.ignored.map((i) => i.name), ['secret.pdf']);
    assert.equal(needsReview(r), true);
    assert.equal(needsReview(checkUploads(repo, [{ name: 'n.pdf', path: 'static/documents/n.pdf', size: 1 }])), false);
  });

  test('assignUniqueNames (case-insensitive), junk files, URLs, files.js re-export', () => {
    const items = [{ name: 'a.pdf' }, { name: 'A.pdf' }, { name: 'a.pdf' }, { name: 'b.png' }];
    const renamed = assignUniqueNames(items);
    assert.deepEqual(items.map((i) => i.name), ['a.pdf', 'A-2.pdf', 'a-3.pdf', 'b.png']);
    assert.equal(renamed.length, 2);
    assert.equal(isJunkFile('.DS_Store'), true);
    assert.equal(isJunkFile('Thumbs.db'), true);
    assert.equal(isJunkFile('a.pdf'), false);
    assert.equal(staticFileUrl('https://x.io/', 'static/documents/courses/lab/报告 1.pdf'), 'https://x.io/documents/courses/lab/%E6%8A%A5%E5%91%8A%201.pdf');
    assert.equal(staticPreviewUrl('https://x.io/', 'static/documents/courses/lab/a.pdf'), 'https://x.io/viewer/?file=%2Fdocuments%2Fcourses%2Flab%2Fa.pdf');
    assert.equal(usesViewer('static/documents/a.pdf'), true);
    assert.equal(usesViewer('static/documents/a.png'), false);
    assert.equal(fromFiles, createIgnoreMatcher, 'files.js keeps exporting the shared matcher');
  });
});

describe('courses: verifier regressions', () => {
  test('canonicalGroup: groups that differ only by case / spaces snap to the existing spelling', () => {
    assert.equal(groupKey(' La bs\u3000'), 'labs');
    assert.equal(canonicalGroup(' labs ', ['Labs', '实验课']), 'Labs');
    assert.equal(canonicalGroup('实验  课', ['实验课']), '实验课');
    assert.equal(canonicalGroup('实验课\u3000', ['实验课']), '实验课', 'full-width space');
    assert.equal(canonicalGroup('  Lab   Courses ', []), 'Lab Courses', 'inner runs of spaces collapse');
    assert.equal(canonicalGroup('   ', ['x']), '');
    assert.equal(canonicalGroup('理论课', ['实验课']), '理论课');
  });

  test('draft course cascade: added when drafting, removed only when it is exactly ours', () => {
    assert.deepEqual(DRAFT_CASCADE, { build: { render: 'never', list: 'never' } });
    assert.deepEqual(draftCascadeUpdate({}, true), { change: true, value: { build: { render: 'never', list: 'never' } } });
    assert.deepEqual(draftCascadeUpdate({ cascade: { build: { list: 'never', render: 'never' } } }, true), { change: false });
    assert.deepEqual(draftCascadeUpdate({ cascade: { params: { x: 1 } } }, true), { change: false, conflict: true });
    assert.deepEqual(draftCascadeUpdate({ cascade: { build: { render: 'never', list: 'never' } } }, false), { change: true, value: undefined });
    assert.deepEqual(draftCascadeUpdate({ cascade: { params: { x: 1 } } }, false), { change: false }, 'a hand-written cascade stays');
    assert.deepEqual(draftCascadeUpdate({}, false), { change: false });
    assert.equal(isDraftCascade({ build: { render: 'never', list: 'never', publishResources: false } }), false);
    // round trip through the surgical YAML patcher: comments stay, the file is byte-identical afterwards
    const fm = 'title: "近代物理实验"\ngroup: "实验课"  # 分组\nweight: 10\ndraft: false';
    const drafted = setFields(fm, { draft: true, cascade: draftCascadeUpdate(parseFrontMatter(fm), true).value });
    assert.match(drafted, /^cascade: \{ build: \{ render: "never", list: "never" \} \}$/m);
    assert.deepEqual(parseFrontMatter(drafted).cascade, DRAFT_CASCADE);
    const back = setFields(drafted, { draft: false, cascade: draftCascadeUpdate(parseFrontMatter(drafted), false).value });
    assert.equal(back, fm);
  });

  test('courseDeletionPlan: course folder (incl. nested), its image folder, materials; never a neighbour with the same prefix', () => {
    const entries = [
      'content/courses/_index.md',
      'content/courses/lab/_index.md', 'content/courses/lab/_index.en.md', 'content/courses/lab/e1.md',
      'content/courses/lab/sub/_index.md', 'content/courses/lab/sub/y.md',
      'content/courses/lab2/_index.md',
      'static/images/pages/courses/lab/e1/a.jpg', 'static/images/pages/courses/lab2/x.jpg',
      'static/documents/courses/lab/r.pdf', 'static/documents/courses/lab/old/s.pdf', 'static/documents/courses/lab2/q.pdf',
      'static/documents/x.pdf',
    ].map((path) => ({ path, sha: 'x', size: 1 }));
    const plan = courseDeletionPlan(entries, 'lab', 'static/documents/courses/lab');
    assert.deepEqual(plan.content.map((e) => e.path), [
      'content/courses/lab/_index.en.md', 'content/courses/lab/_index.md', 'content/courses/lab/e1.md',
      'content/courses/lab/sub/_index.md', 'content/courses/lab/sub/y.md',
    ]);
    assert.deepEqual(plan.images.map((e) => e.path), ['static/images/pages/courses/lab/e1/a.jpg']);
    assert.deepEqual(plan.materials.map((e) => e.path), ['static/documents/courses/lab/old/s.pdf', 'static/documents/courses/lab/r.pdf']);
    assert.equal(plan.materialsDir, 'static/documents/courses/lab/');
  });
});
