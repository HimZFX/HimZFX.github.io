// content.test.mjs — 双语内容模型（content.js）、图片文件名工具（images.js 纯函数）
// 以及 drafts.js 在没有 IndexedDB 时的降级行为。
//
// 运行：node --test tests/admin/content.test.mjs

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  parseContentPath, groupPages, resolveForLang, variantLabel, languageStatus, statusText,
  isPost, variantPath, slugify, suggestSlug, isValidSlug, imageDirFor, sitePathFor,
  shadowWarnings, isDraftFm,
} from '../../static/admin/js/content.js';
import { safeFileName, timestampName, extOf } from '../../static/admin/js/images.js';
import * as drafts from '../../static/admin/js/drafts.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const LANGS = ['zh', 'en'];
const ctxLike = {
  langs: LANGS,
  langName: (l) => ({ zh: '中文', en: '英文' }[l] || l),
};

function gitContentFiles() {
  const out = execFileSync('git', ['-C', REPO_ROOT, 'ls-files', '-z', 'content/'], { encoding: 'utf8' });
  return out.split('\0').filter(Boolean);
}

function group(paths, langs = LANGS) {
  const gs = groupPages(paths.map((p) => ({ path: p, sha: 'x', size: 1 })), langs);
  assert.equal(gs.length, 1, `expected one group for ${paths.join(', ')}`);
  return gs[0];
}

// ---------------------------------------------------------------------------
describe('parseContentPath', () => {
  test('spec examples', () => {
    assert.deepEqual(parseContentPath('content/posts/a.en.md', LANGS),
      { dir: 'content/posts', base: 'a', lang: 'en', isIndex: false });
    assert.deepEqual(parseContentPath('content/posts/a.md', LANGS),
      { dir: 'content/posts', base: 'a', lang: null, isIndex: false });
    assert.deepEqual(parseContentPath('content/research/_index.zh.md', LANGS),
      { dir: 'content/research', base: '_index', lang: 'zh', isIndex: true });
    assert.equal(parseContentPath('content/posts/a.txt', LANGS), null);
    assert.equal(parseContentPath('static/images/a.png', LANGS), null);
  });

  test('unknown language suffix is part of the base (like new_post.py split_name)', () => {
    assert.deepEqual(parseContentPath('content/posts/a.fr.md', LANGS),
      { dir: 'content/posts', base: 'a.fr', lang: null, isIndex: false });
    assert.equal(parseContentPath('content/posts/a.fr.md', ['zh', 'en', 'fr']).lang, 'fr');
  });

  test('edge names', () => {
    assert.deepEqual(parseContentPath('content/posts/en.md', LANGS),
      { dir: 'content/posts', base: 'en', lang: null, isIndex: false });
    assert.equal(parseContentPath('content/posts/.hidden.md', LANGS), null);
    assert.equal(parseContentPath('content/posts/.md', LANGS), null);
    assert.equal(parseContentPath('content/posts/a.MD', LANGS), null);
    assert.equal(parseContentPath(undefined, LANGS), null);
    assert.deepEqual(parseContentPath('content/a/b/c/d.en.md', LANGS),
      { dir: 'content/a/b/c', base: 'd', lang: 'en', isIndex: false });
    assert.deepEqual(parseContentPath('content/v1.2.md', LANGS),
      { dir: 'content', base: 'v1.2', lang: null, isIndex: false });
  });
});

// ---------------------------------------------------------------------------
describe('groupPages against the real repo', () => {
  const files = gitContentFiles();
  const groups = groupPages(files.map((p) => ({ path: p })), LANGS);
  const byKey = Object.fromEntries(groups.map((g) => [g.key, g]));

  test('every .md file belongs to exactly one group', () => {
    const md = files.filter((f) => f.endsWith('.md'));
    const seen = groups.flatMap((g) => Object.values(g.variants));
    assert.deepEqual([...seen].sort(), [...md].sort());
  });

  test('sorted by key', () => {
    const keys = groups.map((g) => g.key);
    assert.deepEqual(keys, [...keys].sort());
  });

  test('known pages', () => {
    // 仓库现有：about(.en), courses/_index(.en), posts/_index(.en), posts/first-physics-note(.en), research/_index(.en)
    if (files.includes('content/about.md')) {
      assert.deepEqual(byKey['content/about'].variants, {
        shared: 'content/about.md',
        ...(files.includes('content/about.en.md') ? { en: 'content/about.en.md' } : {}),
      });
      assert.equal(byKey['content/about'].dir, 'content');
      assert.equal(isPost(byKey['content/about']), false);
      assert.equal(imageDirFor(byKey['content/about']), 'static/images/pages/about');
    }
    const idx = byKey['content/posts/_index'];
    if (idx) {
      assert.equal(idx.isIndex, true);
      assert.equal(isPost(idx), false);
      assert.equal(imageDirFor(idx), 'static/images/pages/posts');
    }
    const note = byKey['content/posts/first-physics-note'];
    if (note) {
      assert.equal(isPost(note), true);
      assert.equal(imageDirFor(note), 'static/images/posts/first-physics-note');
      assert.equal(resolveForLang(note, 'zh'), note.variants.zh || note.variants.shared);
    }
  });

  test('statuses mirror new_post.py --status', () => {
    for (const g of groups) {
      const st = languageStatus(g, LANGS);
      for (const l of LANGS) {
        assert.equal(st.perLang[l], g.variants[l] || g.variants.shared || null);
      }
      // 仓库里的每一页都是 xxx.md + xxx.en.md → 中英分开
      if (g.variants.shared && g.variants.en && !g.variants.zh) {
        assert.equal(st.kind, 'split');
        assert.equal(statusText(st, ctxLike), '中英分开');
      }
    }
  });
});

// ---------------------------------------------------------------------------
describe('synthetic bilingual cases', () => {
  test('shared only', () => {
    const g = group(['content/posts/a.md']);
    assert.equal(resolveForLang(g, 'zh'), 'content/posts/a.md');
    assert.equal(resolveForLang(g, 'en'), 'content/posts/a.md');
    const st = languageStatus(g, LANGS);
    assert.equal(st.kind, 'shared');
    assert.deepEqual(st.missing, []);
    assert.equal(st.sharedUnused, false);
    assert.equal(statusText(st, ctxLike), '中英共用');
  });

  test('shared + en', () => {
    const g = group(['content/posts/a.en.md', 'content/posts/a.md']);
    assert.deepEqual(g.variants, { shared: 'content/posts/a.md', en: 'content/posts/a.en.md' });
    assert.equal(resolveForLang(g, 'zh'), 'content/posts/a.md');
    assert.equal(resolveForLang(g, 'en'), 'content/posts/a.en.md');
    const st = languageStatus(g, LANGS);
    assert.equal(st.kind, 'split');
    assert.equal(statusText(st, ctxLike), '中英分开');
  });

  test('shared + zh', () => {
    const g = group(['content/posts/a.md', 'content/posts/a.zh.md']);
    assert.equal(resolveForLang(g, 'zh'), 'content/posts/a.zh.md');
    assert.equal(resolveForLang(g, 'en'), 'content/posts/a.md');
    assert.equal(languageStatus(g, LANGS).kind, 'split');
  });

  test('en only → page missing on zh site', () => {
    const g = group(['content/posts/a.en.md']);
    assert.equal(resolveForLang(g, 'zh'), null);
    assert.equal(resolveForLang(g, 'en'), 'content/posts/a.en.md');
    const st = languageStatus(g, LANGS);
    assert.equal(st.kind, 'partial');
    assert.deepEqual(st.missing, ['zh']);
    assert.deepEqual(st.perLang, { zh: null, en: 'content/posts/a.en.md' });
    assert.equal(statusText(st, ctxLike), '仅英文');
    // ctxLike 缺省时用内置名称
    assert.equal(statusText(st), '仅英文');
  });

  test('zh only', () => {
    const st = languageStatus(group(['content/posts/a.zh.md']), LANGS);
    assert.equal(statusText(st, ctxLike), '仅中文');
  });

  test('zh + en without shared', () => {
    const g = group(['content/posts/a.zh.md', 'content/posts/a.en.md']);
    const st = languageStatus(g, LANGS);
    assert.equal(st.kind, 'split');
    assert.equal(st.sharedUnused, false);
    assert.equal(statusText(st, ctxLike), '中英分开');
  });

  test('shared + zh + en → shared file unused', () => {
    const g = group(['content/posts/a.zh.md', 'content/posts/a.en.md', 'content/posts/a.md']);
    const st = languageStatus(g, LANGS);
    assert.equal(st.kind, 'split');
    assert.equal(st.sharedUnused, true);
  });

  test('_index sections and nested dirs', () => {
    const gs = groupPages([
      'content/_index.md',
      'content/research/_index.md', 'content/research/_index.en.md',
      'content/research/hi/_index.md',
      'content/research/hi/survey.md', 'content/research/hi/survey.en.md',
      'content/research/hi/survey.png', // 非 md：忽略
      'content/posts/bundle/index.md', // leaf bundle
    ].map((p) => ({ path: p })), LANGS);
    assert.deepEqual(gs.map((g) => g.key), [
      'content/_index', 'content/posts/bundle/index', 'content/research/_index',
      'content/research/hi/_index', 'content/research/hi/survey',
    ]);
    const [home, bundle, research, hi, survey] = gs;
    assert.equal(home.dir, 'content');
    assert.equal(home.isIndex, true);
    assert.equal(imageDirFor(home), 'static/images/pages/home');
    assert.equal(imageDirFor(bundle), 'static/images/pages/posts/bundle');
    assert.equal(isPost(bundle), false);
    assert.equal(research.isIndex, true);
    assert.equal(imageDirFor(research), 'static/images/pages/research');
    assert.equal(imageDirFor(hi), 'static/images/pages/research/hi');
    assert.equal(survey.isIndex, false);
    assert.equal(isPost(survey), false);
    assert.equal(imageDirFor(survey), 'static/images/pages/research/hi/survey');
    assert.equal(languageStatus(survey, LANGS).kind, 'split');
  });

  test('accepts plain string entries and ignores junk', () => {
    const gs = groupPages(['content/posts/a.md', null, undefined, { path: 'x.txt' }], LANGS);
    assert.equal(gs.length, 1);
    assert.deepEqual(groupPages(undefined, LANGS), []);
  });

  test('three languages', () => {
    const L = ['zh', 'en', 'ja'];
    const names = { langName: (l) => ({ zh: '中文', en: '英文', ja: '日文' }[l]) };
    const g = group(['content/posts/a.md', 'content/posts/a.ja.md'], L);
    const st = languageStatus(g, L);
    assert.equal(st.kind, 'split');
    assert.equal(statusText(st, names), '中英日分开');
    const p = languageStatus(group(['content/posts/b.zh.md', 'content/posts/b.en.md'], L), L);
    assert.equal(p.kind, 'partial');
    assert.deepEqual(p.missing, ['ja']);
    assert.equal(statusText(p, names), '仅中英');
  });

  test('resolveForLang tolerates missing group', () => {
    assert.equal(resolveForLang(null, 'zh'), null);
  });
});

// ---------------------------------------------------------------------------
describe('labels and paths', () => {
  test('variantLabel', () => {
    assert.equal(variantLabel('shared', ctxLike), '共用版本');
    assert.equal(variantLabel('en', ctxLike), '英文专属');
    assert.equal(variantLabel('zh', ctxLike), '中文专属');
    assert.equal(variantLabel('en'), '英文专属');
    assert.equal(variantLabel('xx'), 'xx专属');
  });

  test('variantPath', () => {
    assert.equal(variantPath('content/posts', 'a', 'en'), 'content/posts/a.en.md');
    assert.equal(variantPath('content/posts', 'a', null), 'content/posts/a.md');
    assert.equal(variantPath('content/posts', 'a', 'shared'), 'content/posts/a.md');
    assert.equal(variantPath('content', '_index', 'zh'), 'content/_index.zh.md');
    // 往返一致
    for (const p of ['content/posts/a.en.md', 'content/x/_index.md', 'content/about.zh.md']) {
      const i = parseContentPath(p, LANGS);
      assert.equal(variantPath(i.dir, i.base, i.lang), p);
    }
  });

  test('isPost', () => {
    assert.equal(isPost({ dir: 'content/posts', base: 'a', isIndex: false }), true);
    assert.equal(isPost({ dir: 'content/posts', base: '_index', isIndex: true }), false);
    assert.equal(isPost({ dir: 'content/posts/sub', base: 'a', isIndex: false }), false);
    assert.equal(isPost({ dir: 'content', base: 'about', isIndex: false }), false);
    assert.equal(isPost(null), false);
  });

  test('sitePathFor', () => {
    assert.equal(sitePathFor('static/images/x.jpg'), '/images/x.jpg');
    assert.equal(sitePathFor('static/images/posts/a/20261031-172005-图.jpg'),
      '/images/posts/a/20261031-172005-图.jpg');
    assert.equal(sitePathFor('static/avatar.jpg'), '/avatar.jpg');
    assert.equal(sitePathFor('/static/documents/a.pdf'), '/documents/a.pdf');
    assert.equal(sitePathFor('static'), '/');
  });
});

// ---------------------------------------------------------------------------
describe('slugs', () => {
  test('slugify', () => {
    assert.equal(slugify('Neutral Hydrogen in Dark Galaxies'), 'neutral-hydrogen-in-dark-galaxies');
    assert.equal(slugify('  Hello,   World!! '), 'hello-world');
    assert.equal(slugify('暗星系中的中性氢'), '');
    assert.equal(slugify('暗物质 Dark Matter 101'), 'dark-matter-101');
    assert.equal(slugify('Café déjà vu'), 'cafe-deja-vu');
    assert.equal(slugify("Don't panic"), 'dont-panic');
    assert.equal(slugify('a--b__c'), 'a-b-c');
    assert.equal(slugify('ＦＵＬＬ　ｗｉｄｔｈ'), 'full-width');
    assert.equal(slugify(null), '');
    assert.equal(slugify('---'), '');
    const long = slugify('word '.repeat(40));
    assert.ok(long.length <= 60 && isValidSlug(long) && !long.endsWith('-'), long);
    assert.ok(isValidSlug(slugify('x'.repeat(200))));
  });

  test('isValidSlug', () => {
    for (const s of ['a', 'abc', 'a-b', '2026-notes', 'x'.repeat(81)]) assert.equal(isValidSlug(s), true, s);
    for (const s of ['', '-a', 'A', 'a_b', 'a b', '中文', 'a.b', 'x'.repeat(82), null, 3]) {
      assert.equal(isValidSlug(s), false, String(s));
    }
  });

  test('suggestSlug', () => {
    const now = new Date(2026, 9, 31, 17, 20, 5);
    assert.equal(suggestSlug('Dark Galaxy', [], now), 'dark-galaxy');
    assert.equal(suggestSlug('Dark Galaxy', ['dark-galaxy'], now), 'dark-galaxy-2');
    assert.equal(suggestSlug('Dark Galaxy', new Set(['dark-galaxy', 'dark-galaxy-2']), now), 'dark-galaxy-3');
    assert.equal(suggestSlug('暗星系', [], now), 'post-20261031');
    assert.equal(suggestSlug('', ['post-20261031'], now), 'post-20261031-2');
    assert.equal(suggestSlug(undefined, undefined, now), 'post-20261031');
    assert.ok(isValidSlug(suggestSlug('x'.repeat(300), ['x'.repeat(60)], now)));
  });
});

// ---------------------------------------------------------------------------
describe('shadowWarnings', () => {
  const g = group(['content/posts/a.md', 'content/posts/a.en.md', 'content/posts/a.zh.md']);
  const S = 'content/posts/a.md';
  const E = 'content/posts/a.en.md';
  const Z = 'content/posts/a.zh.md';

  test('specific draft while shared published → warning', () => {
    assert.deepEqual(shadowWarnings(g, { [S]: { draft: false }, [E]: { draft: true }, [Z]: {} }, LANGS),
      [{ lang: 'en', path: E }]);
    assert.deepEqual(shadowWarnings(g, { [S]: {}, [E]: { draft: true }, [Z]: { draft: true } }, LANGS),
      [{ lang: 'zh', path: Z }, { lang: 'en', path: E }]);
  });

  test('no warning when shared is draft too, or missing', () => {
    assert.deepEqual(shadowWarnings(g, { [S]: { draft: true }, [E]: { draft: true } }, LANGS), []);
    const noShared = group(['content/posts/b.en.md', 'content/posts/b.zh.md']);
    assert.deepEqual(shadowWarnings(noShared, {
      'content/posts/b.en.md': { draft: true }, 'content/posts/b.zh.md': {},
    }, LANGS), []);
  });

  test('no warning when specifics are published', () => {
    assert.deepEqual(shadowWarnings(g, { [S]: {}, [E]: { draft: false }, [Z]: {} }, LANGS), []);
  });

  test('missing front matter counts as not draft; Hugo-style string booleans', () => {
    assert.deepEqual(shadowWarnings(g, {}, LANGS), []);
    assert.deepEqual(shadowWarnings(g, { [E]: { draft: 'true' } }, LANGS), [{ lang: 'en', path: E }]);
    assert.equal(isDraftFm({ draft: 'True' }), true);
    assert.equal(isDraftFm({ draft: 'false' }), false);
    assert.equal(isDraftFm({ draft: null }), false);
    // YAML 1.1 truthy words: the pinned Hugo hides `draft: yes` / `on` / `y` pages
    for (const v of ['yes', 'Yes', 'YES', 'y', 'Y', 'on', 'On']) assert.equal(isDraftFm({ draft: v }), true, v);
    for (const v of ['no', 'off', 'n', 'false', '0']) assert.equal(isDraftFm({ draft: v }), false, v);
    assert.equal(isDraftFm(null), false);
  });
});

// ---------------------------------------------------------------------------
describe('images.js pure helpers', () => {
  test('safeFileName basics', () => {
    assert.equal(safeFileName('photo.JPG'), 'photo.jpg');
    assert.equal(safeFileName('我的 照片(1).JPG'), '我的-照片-1.jpg');
    assert.equal(safeFileName('暗物质笔记.pdf'), '暗物质笔记.pdf');
    assert.equal(safeFileName('a   b\tc.png'), 'a-b-c.png');
    assert.equal(safeFileName('report_v2-final.PDF'), 'report_v2-final.pdf');
    assert.equal(safeFileName('a&b#c?d%e.txt'), 'a-b-c-d-e.txt');
    assert.equal(safeFileName('emoji😀party.png'), 'emoji-party.png');
    assert.equal(safeFileName('ノート.md'), 'ノート.md');
    assert.equal(safeFileName('a.tar.gz'), 'a.tar.gz');
    assert.equal(safeFileName('Dr. Smith 笔记'), 'Dr.-Smith-笔记');
  });

  test('safeFileName never empty, strips leading dots and paths', () => {
    assert.equal(safeFileName(''), 'file');
    assert.equal(safeFileName(undefined), 'file');
    assert.equal(safeFileName('...'), 'file');
    assert.equal(safeFileName('???.jpg'), 'file.jpg');
    assert.equal(safeFileName('.gitignore'), 'gitignore');
    assert.equal(safeFileName('..hidden.txt'), 'hidden.txt');
    assert.equal(safeFileName('C:\\fakepath\\简历.pdf'), '简历.pdf');
    assert.equal(safeFileName('../../etc/passwd'), 'passwd');
    assert.equal(safeFileName('-dash-.png'), 'dash.png');
  });

  test('safeFileName NFC-normalizes (macOS NFD names)', () => {
    assert.equal(safeFileName('Cafe\u0301.png'), 'Caf\u00e9.png');
  });

  test('safeFileName long names keep the extension', () => {
    const long = safeFileName('a'.repeat(300) + '.JPEG');
    assert.ok(long.endsWith('.jpeg'));
    assert.ok([...long].length <= 120, String(long.length));
    const cjk = safeFileName('中'.repeat(300) + '.png');
    assert.ok(cjk.endsWith('.png'));
    assert.ok([...cjk].length <= 120);
    assert.ok(Buffer.byteLength(timestampName(cjk), 'utf8') <= 255);
    assert.ok(Buffer.byteLength(timestampName('😀'.repeat(200) + 'x'.repeat(300) + '.png'), 'utf8') <= 255);
  });

  test('safeFileName is idempotent', () => {
    for (const n of ['我的 照片(1).JPG', 'a'.repeat(300) + '.png', '.x', 'Dr. Smith 笔记', '中'.repeat(200)]) {
      const once = safeFileName(n);
      assert.equal(safeFileName(once), once, n);
    }
  });

  test('extOf', () => {
    assert.equal(extOf('a.JPG'), 'jpg');
    assert.equal(extOf('a.tar.gz'), 'gz');
    assert.equal(extOf('noext'), '');
    assert.equal(extOf('.gitignore'), '');
    assert.equal(extOf('trailing.'), '');
    assert.equal(extOf('dir.v2/file'), '');
    assert.equal(extOf('Dr. Smith 笔记'), '');
    assert.equal(extOf(''), '');
  });

  test('timestampName uses local time', () => {
    const now = new Date(2026, 9, 31, 17, 20, 5);
    assert.equal(timestampName('我的 照片.PNG', now), '20261031-172005-我的-照片.png');
    assert.equal(timestampName('', new Date(2026, 0, 2, 3, 4, 5)), '20260102-030405-file');
  });
});

// ---------------------------------------------------------------------------
describe('drafts.js without IndexedDB (Node / private mode)', () => {
  test('never throws, resolves empty', async () => {
    assert.equal(typeof globalThis.indexedDB, 'undefined');
    assert.equal(await drafts.saveDraft('k', { title: 't', markdown: 'm', images: {} }), false);
    assert.equal(await drafts.loadDraft('k'), undefined);
    assert.equal(await drafts.deleteDraft('k'), undefined);
    assert.deepEqual(await drafts.listDrafts(), []);
    const cache = drafts.idbBlobCache();
    assert.equal(await cache.get('abc'), undefined);
    await cache.set('abc', new Uint8Array([1, 2, 3]));
    assert.equal(await cache.get('abc'), undefined);
  });

  test('indexedDB getter that throws (SecurityError) is tolerated', async () => {
    Object.defineProperty(globalThis, 'indexedDB', {
      configurable: true, get() { throw new Error('SecurityError'); },
    });
    try {
      assert.deepEqual(await drafts.listDrafts(), []);
      assert.equal(await drafts.loadDraft('k'), undefined);
    } finally {
      delete globalThis.indexedDB;
    }
  });

  test('indexedDB.open throwing / erroring is tolerated', async () => {
    globalThis.indexedDB = { open() { throw new Error('InvalidStateError'); } };
    try {
      assert.equal(await drafts.saveDraft('k', {}), false);
    } finally {
      delete globalThis.indexedDB;
    }
    globalThis.indexedDB = {
      open() {
        const req = {};
        setTimeout(() => req.onerror && req.onerror({ preventDefault() {} }), 0);
        return req;
      },
    };
    try {
      assert.deepEqual(await drafts.listDrafts(), []);
    } finally {
      delete globalThis.indexedDB;
    }
  });

  test('keys', () => {
    assert.equal(drafts.draftKeyForPath('content/posts/a.md'), 'file:content/posts/a.md');
    const a = drafts.newDraftKey();
    const b = drafts.newDraftKey();
    assert.match(a, /^new:.+/);
    assert.notEqual(a, b);
  });
});
