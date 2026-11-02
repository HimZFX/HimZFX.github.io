// static/viewer/lang.js — picks the viewer's interface language before anything is drawn.
// Classic ES5 script (no inline code because of the CSP; also runs in browsers too old for modules, where
// nomodule.js uses the result). Loaded after site.js, which Hugo generates at build time
// (layouts/partials/features/viewer-site.html) from config/_default/: the site's default language and the
// URL prefix of every language, e.g. { defaultLang: "en", languages: [{ lang: "en", prefix: "" }, { lang: "zh", prefix: "zh" }] }.
//
// Order (first match wins):
//   1. ?lang=<code> in the viewer's own address, when the viewer has strings for it (zh, en). The site's templates
//      ({{< pdf >}}, the course materials list) always write it — lang = the page's language — and so does the
//      admin for links that belong to one language;
//   2. the page the visitor came from (document.referrer, same origin only): /zh/… → zh, any other page of the
//      site (no language prefix) → the default language. Links that serve every language (a shared xxx.md,
//      「复制预览链接」) carry no lang, so this keeps the viewer in the language of the page they were opened from;
//   3. the browser's preferred languages (navigator.languages);
//   4. the site's default language (English when site.js is missing).
// Results: window.VIEWER_LANG ("zh" | "en"), window.ViewerLang = { pick, homePath, UI_LANGS } (also exported
// for Node tests through require()), and <html lang> is set right away.
(function (root) {
  var UI_LANGS = ['zh', 'en']; // languages viewer.js has strings for
  var FALLBACK_SITE = { defaultLang: 'en', languages: [] };

  function primary(tag) {
    return String(tag || '').toLowerCase().split(/[-_]/)[0];
  }

  function supported(tag) {
    var p = primary(tag);
    for (var i = 0; i < UI_LANGS.length; i++) if (UI_LANGS[i] === p) return p;
    return null;
  }

  function siteOr(site) {
    if (!site || typeof site !== 'object' || typeof site.defaultLang !== 'string') return FALLBACK_SITE;
    var langs = [];
    var list = Object.prototype.toString.call(site.languages) === '[object Array]' ? site.languages : [];
    for (var i = 0; i < list.length; i++) {
      var l = list[i];
      if (l && typeof l.lang === 'string') langs.push({ lang: l.lang, prefix: typeof l.prefix === 'string' ? l.prefix.replace(/^\/+|\/+$/g, '') : '' });
    }
    return { defaultLang: site.defaultLang, languages: langs };
  }

  /** "?a=1&lang=en" → "en" (no URLSearchParams: also used by very old browsers). */
  function queryParam(search, name) {
    var q = String(search || '').replace(/^\?/, '').split('&');
    for (var i = 0; i < q.length; i++) {
      var kv = q[i].split('=');
      if (kv[0] === name) {
        try {
          return decodeURIComponent((kv[1] || '').replace(/\+/g, ' '));
        } catch (e) {
          return kv[1] || '';
        }
      }
    }
    return null;
  }

  /** The site's root path as seen from the viewer: "/viewer/" → "/", "/sub/viewer/index.html" → "/sub/". */
  function sitePath(pathname) {
    var m = /^(.*\/)viewer\/(index\.html)?$/.exec(String(pathname || ''));
    return m ? m[1] : '/';
  }

  /** Language of a same-origin referrer, from its URL prefix; null when it says nothing. */
  function fromReferrer(referrer, loc, site) {
    if (!referrer || !site.languages.length || !loc) return null;
    var origin = loc.protocol + '//' + loc.host;
    if (referrer.indexOf(origin + '/') !== 0) return null;
    var path = referrer.slice(origin.length).split(/[?#]/)[0];
    var base = sitePath(loc.pathname);
    if (path.indexOf(base) !== 0) return null;
    var first = path.slice(base.length).split('/')[0];
    try {
      first = decodeURIComponent(first);
    } catch (e) { /* keep it */ }
    if (/^(admin|viewer)$/i.test(first)) return null; // the admin / another viewer page: not a page of the site
    var atRoot = null;
    for (var i = 0; i < site.languages.length; i++) {
      var l = site.languages[i];
      if (l.prefix && l.prefix === first) return supported(l.lang);
      if (!l.prefix) atRoot = l.lang;
    }
    return atRoot ? supported(atRoot) : null;
  }

  /**
   * @param {{ search?: string, referrer?: string, location?: { protocol: string, host: string, pathname: string },
   *           languages?: string[], site?: object }} o
   * @returns {string} one of UI_LANGS
   */
  function pick(o) {
    o = o || {};
    var site = siteOr(o.site);
    var explicit = supported(queryParam(o.search, 'lang'));
    if (explicit) return explicit;
    var ref = fromReferrer(o.referrer, o.location, site);
    if (ref) return ref;
    var prefs = o.languages || [];
    for (var i = 0; i < prefs.length; i++) {
      var p = supported(prefs[i]);
      if (p) return p;
    }
    return supported(site.defaultLang) || 'en';
  }

  /** The site's home page for a language, relative to /viewer/: "../" (default language) or "../zh/". */
  function homePath(lang, siteData) {
    var site = siteOr(siteData);
    for (var i = 0; i < site.languages.length; i++) {
      if (site.languages[i].lang === lang) return '../' + (site.languages[i].prefix ? site.languages[i].prefix + '/' : '');
    }
    return '../';
  }

  var api = { pick: pick, homePath: homePath, UI_LANGS: UI_LANGS };
  if (typeof module === 'object' && module && module.exports) {
    module.exports = api;
    return;
  }
  root.ViewerLang = api;
  var nav = root.navigator || {};
  var lang = pick({
    search: root.location.search,
    referrer: root.document.referrer,
    location: root.location,
    languages: nav.languages && nav.languages.length ? nav.languages : [nav.language || nav.userLanguage || ''],
    site: root.SITE_LANGUAGES,
  });
  root.VIEWER_LANG = lang;
  try {
    root.document.documentElement.lang = lang === 'zh' ? 'zh-CN' : lang;
  } catch (e) { /* ignore */ }
})(this);
