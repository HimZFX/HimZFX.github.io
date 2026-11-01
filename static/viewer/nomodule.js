// static/viewer/nomodule.js — only runs in browsers too old for ES modules (they cannot run PDF.js).
// ES5 only. Shows a hint instead of an endless 「正在加载…」.
(function () {
  function show() {
    var en = /[?&]lang=en(&|$)/.test(window.location.search);
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
