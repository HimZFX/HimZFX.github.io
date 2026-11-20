// tests/admin/menu.test.mjs — 下拉菜单（menu.main.parent）、博客分类（categories）、后台导航的旧地址跳转。
// static/admin/js/sitemenu.js、navmap.js，以及 academic.academicIndexDocument / pages.sectionFrontMatter 的菜单写法。

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { splitDocument, parseFrontMatter } from '../../static/admin/js/frontmatter.js';
import {
  TOP_MENU, TOP_IDS, PARENT_LABELS, SECTION_MENU_DEFAULTS, CATEGORY_KEYS, CATEGORY_LABELS,
  mainMenuEntry, isFixedTop, menuWithMain, menuWithoutMain, patchMainMenu, menuWeightError,
  categoriesOf, categoryLabel, categoryChoice, sameCategories, tidyCategoriesLine, setCategoriesFm, patchCategories,
} from '../../static/admin/js/sitemenu.js';
import { legacyRedirect, pageHome, newPageHome } from '../../static/admin/js/navmap.js';
import { academicIndexDocument, menuWithoutMain as academicMenuWithoutMain } from '../../static/admin/js/academic.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const bodyOf = (text) => splitDocument(text).body;
const fmOf = (text) => parseFrontMatter(splitDocument(text).fmText);

describe('sitemenu: constants (shared contract with the site)', () => {
  test('4 fixed top-level items in order, with the parent labels used by the site menu', () => {
    assert.deepEqual(TOP_IDS, ['about', 'research', 'posts', 'courses']);
    assert.deepEqual(TOP_MENU.map((t) => t.label), ['About', 'Research', 'Blog', 'Course Materials']);
    assert.deepEqual(PARENT_LABELS, { about: 'About', research: 'Research', posts: 'Blog', courses: 'Course Materials' });
  });
  test('academic sections default under Research (publications 10, talks 20) and About (news 10)', () => {
    assert.deepEqual(JSON.parse(JSON.stringify(SECTION_MENU_DEFAULTS)), {
      publications: { parent: 'research', weight: 10 },
      talks: { parent: 'research', weight: 20 },
      news: { parent: 'about', weight: 10 },
    });
  });
  test('categories: notes = 科研笔记, essays = 随笔', () => {
    assert.deepEqual(CATEGORY_KEYS, ['notes', 'essays']);
    assert.deepEqual({ ...CATEGORY_LABELS }, { notes: '科研笔记', essays: '随笔' });
    assert.equal(categoryLabel('notes'), '科研笔记');
    assert.equal(categoryLabel('physics'), 'physics');
  });
  test('the repository content follows the contract (identifiers on the 4 top items, children off)', () => {
    for (const [file, id, w] of [['content/about.md', 'about', 10], ['content/about.en.md', 'about', 10],
      ['content/research/_index.md', 'research', 20], ['content/research/_index.en.md', 'research', 20],
      ['content/posts/_index.md', 'posts', 30], ['content/posts/_index.en.md', 'posts', 30],
      ['content/courses/_index.md', 'courses', 40], ['content/courses/_index.en.md', 'courses', 40]]) {
      const e = mainMenuEntry(fmOf(read(file)));
      assert.deepEqual(e, { inMenu: true, weight: w, parent: null, identifier: id }, file);
      assert.ok(isFixedTop(e), file);
    }
    for (const file of ['content/publications/_index.md', 'content/publications/_index.zh.md', 'content/talks/_index.md', 'content/talks/_index.zh.md', 'content/news/_index.md', 'content/news/_index.zh.md']) {
      assert.equal(mainMenuEntry(fmOf(read(file))).inMenu, false, file);
    }
    assert.deepEqual(categoriesOf(fmOf(read('content/posts/first-physics-note.md'))), ['notes']);
    assert.deepEqual(categoriesOf(fmOf(read('content/posts/first-physics-note.en.md'))), ['notes']);
  });
});

describe('sitemenu: mainMenuEntry / isFixedTop / menuWithMain', () => {
  test('the three Hugo spellings and parent / identifier', () => {
    assert.deepEqual(mainMenuEntry({}), { inMenu: false, weight: null, parent: null, identifier: null });
    assert.deepEqual(mainMenuEntry({ menu: 'main', weight: 5 }), { inMenu: true, weight: 5, parent: null, identifier: null });
    assert.deepEqual(mainMenuEntry({ menu: ['footer', 'main'] }), { inMenu: true, weight: null, parent: null, identifier: null });
    assert.deepEqual(mainMenuEntry({ menu: { footer: {} } }).inMenu, false);
    assert.deepEqual(mainMenuEntry({ menu: { main: { parent: 'research', weight: '20' } } }), { inMenu: true, weight: 20, parent: 'research', identifier: null });
    assert.deepEqual(mainMenuEntry({ menu: { main: null } }), { inMenu: true, weight: null, parent: null, identifier: null });
  });
  test('isFixedTop: identifier of the 4 items, no parent', () => {
    assert.ok(isFixedTop(mainMenuEntry({ menu: { main: { identifier: 'research', weight: 20 } } })));
    assert.ok(!isFixedTop(mainMenuEntry({ menu: { main: { identifier: 'projects', weight: 50 } } })));
    assert.ok(!isFixedTop(mainMenuEntry({ menu: { main: { identifier: 'about', parent: 'research', weight: 50 } } })));
    assert.ok(!isFixedTop(mainMenuEntry({})));
  });
  test('menuWithMain keeps other keys and other menus; parent null = top level', () => {
    assert.deepEqual(menuWithMain(undefined, { parent: 'research', weight: 10 }), { main: { parent: 'research', weight: 10 } });
    assert.deepEqual(Object.keys(menuWithMain(undefined, { parent: 'research', weight: 10 }).main), ['parent', 'weight']);
    assert.deepEqual(menuWithMain({ main: { identifier: 'x', weight: 3, pre: 'i' }, footer: { weight: 1 } }, { parent: 'about', weight: 7 }),
      { main: { identifier: 'x', weight: 7, pre: 'i', parent: 'about' }, footer: { weight: 1 } });
    assert.deepEqual(menuWithMain({ main: { parent: 'about', weight: 7 } }, { parent: null, weight: 8 }), { main: { weight: 8 } });
    assert.deepEqual(menuWithMain('main', { parent: 'research', weight: 1 }), { main: { parent: 'research', weight: 1 } });
    assert.deepEqual(menuWithMain(['footer', 'main'], { weight: 2 }), { footer: {}, main: { weight: 2 } });
  });
  test('menuWithoutMain (also re-exported by academic.js)', () => {
    assert.equal(academicMenuWithoutMain, menuWithoutMain);
    assert.equal(menuWithoutMain({ main: { weight: 1 } }), undefined);
    assert.deepEqual(menuWithoutMain({ main: {}, footer: {} }), { footer: {} });
    assert.equal(menuWithoutMain('main'), undefined);
    assert.deepEqual(menuWithoutMain(['main', 'footer']), ['footer']);
  });
});

describe('sitemenu: patchMainMenu (surgical, comments kept, body untouched)', () => {
  const pub = '---\ntitle: "Publications"\ndescription: "Papers, preprints and other writing."\n---\n';
  test('no menu → block appended at the end, exactly as the contract writes it', () => {
    const out = patchMainMenu(pub, { parent: 'research', weight: 10 }, 'content/publications/_index.md');
    assert.equal(out, '---\ntitle: "Publications"\ndescription: "Papers, preprints and other writing."\nmenu:\n  main:\n    parent: research\n    weight: 10\n---\n');
    // and back off again → the original file
    assert.equal(patchMainMenu(out, null), pub);
  });
  test('old single-line top-level entry is migrated in place to the block form', () => {
    const old = '---\ntitle: "论文"\nmenu: { main: { weight: 50 } }\ndescription: "论文、预印本与其他写作。"\n---\n\n正文\n';
    const out = patchMainMenu(old, { parent: 'research', weight: 10 });
    assert.equal(out, '---\ntitle: "论文"\nmenu:\n  main:\n    parent: research\n    weight: 10\ndescription: "论文、预印本与其他写作。"\n---\n\n正文\n');
  });
  test('block menu: only the changed child lines move; comments and identifier stay', () => {
    const about = read('content/about.md');
    const out = patchMainMenu(about, { parent: null, weight: 15 }, 'content/about.md');
    assert.equal(out, about.replace('weight: 10    #', 'weight: 15    #'));
    assert.equal(bodyOf(out), bodyOf(about));
    // giving a block entry a parent adds one line (unquoted id) after the existing children
    const child = '---\ntitle: "Projects"\nmenu:\n  main:   # 菜单\n    weight: 50   # 顺序\n---\nbody\n';
    assert.equal(patchMainMenu(child, { parent: 'research', weight: 30 }),
      '---\ntitle: "Projects"\nmenu:\n  main:   # 菜单\n    weight: 30   # 顺序\n    parent: research\n---\nbody\n');
    // and moving it back to the top level removes just that line
    assert.equal(patchMainMenu(patchMainMenu(child, { parent: 'research', weight: 50 }), { parent: null, weight: 50 }), child);
  });
  test('removing keeps other menus; unchanged → same text', () => {
    const t = '---\ntitle: x\nmenu:\n  main:\n    parent: about\n    weight: 10\n  footer:\n    weight: 2\n---\n';
    assert.equal(patchMainMenu(t, null), '---\ntitle: x\nmenu:\n  footer:\n    weight: 2\n---\n');
    assert.equal(patchMainMenu(t, { parent: 'about', weight: 10 }), t);
    assert.equal(patchMainMenu(pub, null), pub);
  });
  test('TOML front matter is refused with a Chinese message', () => {
    assert.throws(() => patchMainMenu('+++\ntitle = "x"\n+++\n', { weight: 1 }, 'content/x/_index.md'), /不是 YAML/);
  });
  test('weights: only non-zero integers (Hugo weights are ints, 0 = unset → sorted last)', () => {
    for (const w of ['10', '-5', ' 7 ', '007', 1, 1000000]) assert.equal(menuWeightError(w), null, String(w));
    for (const w of ['', ' ', '1.5', '1e21', 'abc', '0', '-0', 0, '10000001', null, undefined]) assert.ok(menuWeightError(w), String(w));
    const t = '---\ntitle: x\n---\n';
    for (const w of [1.5, 1e21, NaN, 'x', undefined]) assert.throws(() => patchMainMenu(t, { parent: 'about', weight: w }), /整数/, String(w));
  });
  test('file without front matter gets one', () => {
    assert.equal(patchMainMenu('Hello\n', { parent: 'about', weight: 10 }), '---\nmenu:\n  main:\n    parent: about\n    weight: 10\n---\nHello\n');
  });
  test('academicIndexDocument / sectionFrontMatter write the same block', () => {
    assert.equal(academicIndexDocument('publications', 'en', 10, 'research'),
      '---\ntitle: "Publications"\ndescription: "Papers, preprints and other writing."\nmenu:\n  main:\n    parent: research\n    weight: 10\n---\n');
    assert.equal(academicIndexDocument('talks', 'zh', 20), '---\ntitle: "报告与海报"\ndescription: "学术报告、海报与讨论班。"\nmenu:\n  main:\n    weight: 20\n---\n');
    assert.equal(academicIndexDocument('news', 'en'), '---\ntitle: "News"\ndescription: "Recent updates."\n---\n');
  });
});

describe('sitemenu: blog categories', () => {
  test('categoriesOf accepts a list or a single string', () => {
    assert.deepEqual(categoriesOf({ categories: ['notes'] }), ['notes']);
    assert.deepEqual(categoriesOf({ categories: 'essays' }), ['essays']);
    assert.deepEqual(categoriesOf({ categories: [] }), []);
    assert.deepEqual(categoriesOf({}), []);
    assert.deepEqual(categoriesOf({ categories: ['notes', ' physics ', ''] }), ['notes', 'physics']);
  });
  test('categoryChoice: "" / notes / essays / keep', () => {
    assert.equal(categoryChoice([]), '');
    assert.equal(categoryChoice(['notes']), 'notes');
    assert.equal(categoryChoice(['essays']), 'essays');
    assert.equal(categoryChoice(['physics']), 'keep');
    assert.equal(categoryChoice(['notes', 'essays']), 'keep');
    assert.ok(sameCategories(['a'], ['a']) && !sameCategories(['a'], ['b']) && !sameCategories([], ['a']));
  });
  test('tidyCategoriesLine writes [notes] like the contract, only when the value is unchanged', () => {
    assert.equal(tidyCategoriesLine('title: x\ncategories: ["notes"]\ndraft: false'), 'title: x\ncategories: [notes]\ndraft: false');
    assert.equal(tidyCategoriesLine('categories: ["notes", "essays"]'), 'categories: [notes, essays]');
    assert.equal(tidyCategoriesLine('categories: ["true"]'), 'categories: ["true"]', 'reserved words stay quoted');
    assert.equal(tidyCategoriesLine('categories: ["物理"]'), 'categories: ["物理"]');
    // a trailing comment is kept (regression: it used to leave the line as ["essays"])
    assert.equal(tidyCategoriesLine('categories: ["essays"]   # 分类'), 'categories: [essays]   # 分类');
    assert.equal(patchCategories('---\ntitle: x\ncategories: [notes]  # 分类\n---\nb\n', ['essays']), '---\ntitle: x\ncategories: [essays]  # 分类\n---\nb\n');
  });
  test('setCategoriesFm: add / change / remove, comments kept; string form counts as the same', () => {
    const fm = 'title: "x"\ndate: 2025-12-05\ndraft: false  # <--- 重要！\nmath: true';
    assert.equal(setCategoriesFm(fm, ['notes']), fm + '\ncategories: [notes]');
    const withNotes = 'title: "x"\ndraft: false  # 注释\ncategories: [notes]\nmath: true';
    assert.equal(setCategoriesFm(withNotes, ['essays']), 'title: "x"\ndraft: false  # 注释\ncategories: [essays]\nmath: true');
    assert.equal(setCategoriesFm(withNotes, []), 'title: "x"\ndraft: false  # 注释\nmath: true');
    assert.equal(setCategoriesFm(withNotes, ['notes']), withNotes);
    assert.equal(setCategoriesFm('categories: notes', ['notes']), 'categories: notes');
    assert.equal(setCategoriesFm('title: x', []), 'title: x');
  });
  test('patchCategories on the real post: only the categories line changes', () => {
    for (const file of ['content/posts/first-physics-note.md', 'content/posts/first-physics-note.en.md']) {
      const text = read(file);
      const out = patchCategories(text, ['essays'], file);
      assert.equal(out, text.replace('categories: [notes]', 'categories: [essays]'), file);
      assert.equal(patchCategories(text, ['notes'], file), text, 'unchanged → same text');
      const none = patchCategories(text, [], file);
      assert.equal(none, text.replace('categories: [notes]\n', ''));
      assert.equal(bodyOf(none), bodyOf(text));
    }
    assert.throws(() => patchCategories('+++\ntitle = "x"\n+++\n', ['notes']), /不是 YAML/);
  });
});

describe('navmap: old addresses and where a page belongs', () => {
  test('legacyRedirect', () => {
    assert.equal(legacyRedirect('academic', { tab: 'publications' }), '#/research?tab=publications');
    assert.equal(legacyRedirect('academic', { tab: 'talks' }), '#/research?tab=talks');
    assert.equal(legacyRedirect('academic', { tab: 'news' }), '#/about?tab=news');
    assert.equal(legacyRedirect('academic', {}), '#/research');
    assert.equal(legacyRedirect('academic', { tab: 'bogus' }), '#/research');
    assert.equal(legacyRedirect('profile', {}), '#/settings?tab=home');
    assert.equal(legacyRedirect('background', {}), '#/settings?tab=background');
    assert.equal(legacyRedirect('pages', {}), '#/settings?tab=pages');
    for (const r of ['posts', 'about', 'research', 'settings', 'files', 'courses', 'edit', 'login', 'nope']) assert.equal(legacyRedirect(r, {}), null, r);
  });
  test('pageHome / newPageHome', () => {
    assert.deepEqual(pageHome('content/about.md'), { route: 'about', hash: '#/about?tab=me' });
    assert.deepEqual(pageHome('content/about.en.md'), { route: 'about', hash: '#/about?tab=me' });
    assert.deepEqual(pageHome('content/research/_index.zh.md'), { route: 'research', hash: '#/research?tab=overview' });
    assert.deepEqual(pageHome('content/publications/_index.md'), { route: 'research', hash: '#/research?tab=publications' });
    assert.deepEqual(pageHome('content/talks/_index.zh.md'), { route: 'research', hash: '#/research?tab=talks' });
    assert.deepEqual(pageHome('content/news/_index.md'), { route: 'about', hash: '#/about?tab=news' });
    for (const p of ['content/posts/_index.md', 'content/courses/_index.en.md', 'content/projects/_index.md', 'content/categories/notes/_index.zh.md', 'content/aboutme.md', 'content/research/x.md']) {
      assert.deepEqual(pageHome(p), { route: 'settings', hash: '#/settings?tab=pages' }, p);
    }
    assert.equal(newPageHome('content/research').route, 'research');
    assert.equal(newPageHome('projects').route, 'settings');
    assert.equal(newPageHome('').route, 'settings');
  });
});
