// static/viewer/theme.js — runs before first paint (classic script, no inline code because of the CSP).
// Same rule as the main site (PaperMod): localStorage 'pref-theme' = 'dark' | 'light' wins, otherwise the
// system setting. This is the ONLY localStorage key the viewer ever reads; it never writes any.
(function () {
  var root = document.documentElement;
  function pref() {
    try {
      var v = window.localStorage.getItem('pref-theme');
      return v === 'dark' || v === 'light' ? v : null;
    } catch (e) {
      return null;
    }
  }
  function systemDark() {
    try {
      return window.matchMedia('(prefers-color-scheme: dark)').matches;
    } catch (e) {
      return false;
    }
  }
  function apply() {
    var p = pref();
    root.setAttribute('data-theme', p ? p : systemDark() ? 'dark' : 'light');
  }
  apply();
  // The main site's theme toggle (also in the page that embeds us) writes pref-theme → follow it live.
  window.addEventListener('storage', function (e) {
    if (e.key === null || e.key === 'pref-theme') apply();
  });
  try {
    var mq = window.matchMedia('(prefers-color-scheme: dark)');
    if (mq.addEventListener) mq.addEventListener('change', apply);
    else if (mq.addListener) mq.addListener(apply);
  } catch (e) {
    /* ignore */
  }
})();
