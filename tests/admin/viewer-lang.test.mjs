// viewer-lang.test.mjs — the viewer's interface language (static/viewer/lang.js, a classic script that also
// exports its pure functions for Node) and its agreement with the admin's viewerUrlFor / the viewer's viewerHref.
//
// Run: node --test tests/admin/viewer-lang.test.mjs

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

import { viewerUrlFor } from '../../static/admin/js/content.js';
import { viewerHref } from '../../static/viewer/path.js';

const { pick, homePath, UI_LANGS } = createRequire(import.meta.url)('../../static/viewer/lang.js');

// What layouts/partials/features/viewer-site.html writes to /viewer/site.js for this repository.
const SITE = { defaultLang: 'en', languages: [{ lang: 'en', prefix: '' }, { lang: 'zh', prefix: 'zh' }] };
const LOC = { protocol: 'https:', host: 'himzfx.github.io', pathname: '/viewer/' };
const ORIGIN = 'https://himzfx.github.io';
const base = { location: LOC, site: SITE };

describe('viewer: interface language (lang.js)', () => {
  test('supported interface languages', () => {
    assert.deepEqual(UI_LANGS, ['zh', 'en']);
  });

  test('1. explicit ?lang= wins over everything', () => {
    for (const [search, want] of [['?file=%2Fa.pdf&lang=zh', 'zh'], ['?lang=en&file=x', 'en'], ['?lang=zh-CN', 'zh'], ['?lang=EN', 'en']]) {
      assert.equal(pick({ ...base, search, referrer: `${ORIGIN}/zh/posts/a/`, languages: ['zh-CN'] }), want, search);
      assert.equal(pick({ ...base, search, referrer: `${ORIGIN}/posts/a/`, languages: ['en-US'] }), want, search);
    }
  });

  test('an unknown ?lang= is ignored (falls through to the next rule)', () => {
    assert.equal(pick({ ...base, search: '?lang=fr', languages: ['zh-CN'] }), 'zh');
    assert.equal(pick({ ...base, search: '?lang=', languages: ['de'] }), 'en');
  });

  test('2. same-origin referrer: /zh/… → zh, any other page of the site → the default language (en)', () => {
    assert.equal(pick({ ...base, search: '?file=x', referrer: `${ORIGIN}/zh/posts/a/`, languages: ['en-US'] }), 'zh');
    assert.equal(pick({ ...base, search: '?file=x', referrer: `${ORIGIN}/zh/`, languages: ['en-US'] }), 'zh');
    assert.equal(pick({ ...base, search: '?file=x', referrer: `${ORIGIN}/zh`, languages: ['en-US'] }), 'zh');
    assert.equal(pick({ ...base, search: '?file=x', referrer: `${ORIGIN}/posts/a/`, languages: ['zh-CN'] }), 'en');
    assert.equal(pick({ ...base, search: '?file=x', referrer: `${ORIGIN}/`, languages: ['zh-CN'] }), 'en');
    assert.equal(pick({ ...base, search: '?file=x', referrer: `${ORIGIN}/courses/lab/?x=1#y`, languages: ['zh'] }), 'en');
    // "zhang/" is not the /zh/ prefix
    assert.equal(pick({ ...base, search: '', referrer: `${ORIGIN}/zhang/`, languages: ['zh'] }), 'en');
  });

  test('referrers that say nothing about the language are skipped', () => {
    // other origin, the admin, another viewer page, no referrer → browser languages
    for (const referrer of ['https://evil.example/zh/x/', `${ORIGIN}/admin/`, `${ORIGIN}/viewer/?file=x&lang=en`, '', undefined, 'not a url']) {
      assert.equal(pick({ ...base, search: '?file=x', referrer, languages: ['zh-TW', 'en'] }), 'zh', String(referrer));
      assert.equal(pick({ ...base, search: '?file=x', referrer, languages: ['en-GB', 'zh'] }), 'en', String(referrer));
    }
    // http vs https is another origin
    assert.equal(pick({ ...base, referrer: 'http://himzfx.github.io/zh/', languages: ['en'] }), 'en');
  });

  test('3. browser languages: first supported one in preference order', () => {
    assert.equal(pick({ ...base, languages: ['fr-FR', 'zh-Hans-CN', 'en'] }), 'zh');
    assert.equal(pick({ ...base, languages: ['de', 'en_US'] }), 'en');
  });

  test('4. otherwise the site default language; English when site.js is missing or broken', () => {
    assert.equal(pick({ ...base, languages: ['de', 'fr'] }), 'en');
    assert.equal(pick({ ...base, site: { defaultLang: 'zh', languages: [{ lang: 'zh', prefix: '' }, { lang: 'en', prefix: 'en' }] }, languages: ['de'] }), 'zh');
    for (const site of [undefined, null, 'x', { languages: [] }, { defaultLang: 1 }]) {
      assert.equal(pick({ location: LOC, site, languages: [] }), 'en', JSON.stringify(site));
      // without language data the referrer cannot be interpreted → browser language
      assert.equal(pick({ location: LOC, site, referrer: `${ORIGIN}/zh/x/`, languages: ['zh'] }), 'zh');
      assert.equal(pick({ location: LOC, site, referrer: `${ORIGIN}/zh/x/`, languages: ['de'] }), 'en');
    }
    assert.equal(pick(), 'en');
  });

  test('a zh-default configuration (zh at /, en under /en/) is followed too', () => {
    const zhSite = { defaultLang: 'zh', languages: [{ lang: 'zh', prefix: '' }, { lang: 'en', prefix: 'en' }] };
    assert.equal(pick({ location: LOC, site: zhSite, referrer: `${ORIGIN}/posts/a/`, languages: ['en'] }), 'zh');
    assert.equal(pick({ location: LOC, site: zhSite, referrer: `${ORIGIN}/en/posts/a/`, languages: ['zh'] }), 'en');
    assert.equal(homePath('en', zhSite), '../en/');
    assert.equal(homePath('zh', zhSite), '../');
  });

  test('sub-path baseURL: the site root is the folder that holds viewer/', () => {
    const loc = { protocol: 'http:', host: '127.0.0.1:8080', pathname: '/site/viewer/index.html' };
    assert.equal(pick({ location: loc, site: SITE, referrer: 'http://127.0.0.1:8080/site/zh/posts/a/', languages: ['en'] }), 'zh');
    assert.equal(pick({ location: loc, site: SITE, referrer: 'http://127.0.0.1:8080/site/posts/a/', languages: ['zh'] }), 'en');
    // outside the site's folder → no information
    assert.equal(pick({ location: loc, site: SITE, referrer: 'http://127.0.0.1:8080/zh/posts/a/', languages: ['en'] }), 'en');
  });

  test('home page per language: default language at ../, others at ../<prefix>/', () => {
    assert.equal(homePath('en', SITE), '../');
    assert.equal(homePath('zh', SITE), '../zh/');
    assert.equal(homePath('fr', SITE), '../');
    assert.equal(homePath('zh', undefined), '../');
  });
});

describe('viewer links: the admin, the site templates and the viewer agree on lang', () => {
  test('lang is written for every language when given (default language too), omitted otherwise', () => {
    for (const lang of ['en', 'zh']) {
      const admin = viewerUrlFor('/documents/a b.pdf', { lang, embed: true, page: 2 });
      assert.equal(admin, `/viewer/?file=%2Fdocuments%2Fa%20b.pdf&lang=${lang}&embed=1&page=2`);
      assert.equal('/viewer/' + viewerHref('/documents/a b.pdf', { lang, embed: true, page: 2 }), admin);
      // what the viewer picks for such a link, wherever it is opened from
      const search = admin.slice(admin.indexOf('?'));
      assert.equal(pick({ ...base, search, referrer: `${ORIGIN}/`, languages: ['de'] }), lang);
      assert.equal(pick({ ...base, search, referrer: `${ORIGIN}/zh/`, languages: ['de'] }), lang);
    }
    assert.equal(viewerUrlFor('/documents/a.pdf'), '/viewer/?file=%2Fdocuments%2Fa.pdf');
    assert.equal(viewerHref('/documents/a.pdf', {}), '?file=%2Fdocuments%2Fa.pdf');
  });
});
