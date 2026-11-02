// static/viewer/nomodule.js — only runs in browsers too old for ES modules (they cannot run PDF.js).
// ES5 only. Shows a hint instead of an endless 「正在加载…」.
(function () {
  function show() {
    // lang.js (classic script, loaded before us) already picked the interface language
    var en = window.VIEWER_LANG ? window.VIEWER_LANG === 'en' : !/[?&]lang=zh(&|$)/.test(window.location.search);
    var home = document.getElementById('site-name');
    if (home && en) home.textContent = 'Home';
    var title = document.getElementById('status-title');
    if (title) {
      title.textContent = en
        ? 'This browser is too old to preview files. Please open the link in another browser.'
        : '浏览器版本过旧，无法在线预览。请换用其他浏览器打开这个链接。';
    }
    var spinner = document.querySelector('.spinner');
    if (spinner) spinner.parentNode.removeChild(spinner);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', show);
  else show();
})();
