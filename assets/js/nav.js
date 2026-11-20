// 顶部菜单的下拉菜单（layouts/partials/header.html 输出的 li.has-sub > a + button.nav-caret + div.nav-sub）。
// 只在至少一个菜单项有子页面时由 header.html 加载（本站脚本，defer）。样式和两种布局见 assets/css/extended/nav.css。
//
//   宽屏（≥ 769px）：鼠标移到菜单项上展开、移开收起；点 ▾ 固定展开（再点收起）。
//   手机（≤ 768px）：点 ▾ 展开 / 收起页头下面的面板，一次只展开一个。
//   键盘：Tab 到 ▾，Enter / 空格展开（↓ 也可以，并跳到第一项），↑ ↓ 在子菜单里移动；
//         Esc 收起并把焦点还给 ▾；焦点离开这一项、点页面别处也会收起。
//   aria-expanded 始终和是否展开一致。没有这个脚本时，CSS 的悬停 / :focus-within 规则兜底（#menu 没有 .nav-js）。
(function () {
  'use strict';
  var menu = document.getElementById('menu');
  if (!menu) return;
  var items = Array.prototype.slice.call(menu.querySelectorAll('li.has-sub'));
  if (!items.length) return;
  menu.classList.add('nav-js');

  var wide = window.matchMedia('(min-width: 769px)');
  var timers = [];

  function caret(li) { return li.querySelector('.nav-caret'); }
  function links(li) { return Array.prototype.slice.call(li.querySelectorAll('.nav-sub-link')); }
  function isOpen(li) { return li.classList.contains('is-open'); }

  function setOpen(li, open, pinned) {
    var i = items.indexOf(li);
    clearTimeout(timers[i]);
    li.classList.toggle('is-open', open);
    li.classList.toggle('is-pinned', !!(open && pinned));
    caret(li).setAttribute('aria-expanded', open ? 'true' : 'false');
    // 宽屏：卡片从菜单项左边往右展开，伸出窗口右边时改成右对齐（nav.css 的 .nav-sub-end）
    li.classList.remove('nav-sub-end');
    if (open && wide.matches) {
      var sub = li.querySelector('.nav-sub');
      if (sub && sub.getBoundingClientRect().right > document.documentElement.clientWidth - 8) li.classList.add('nav-sub-end');
    }
  }

  function closeAll(except) {
    items.forEach(function (li) { if (li !== except && isOpen(li)) setOpen(li, false); });
  }

  items.forEach(function (li, i) {
    var btn = caret(li);
    if (!btn) return;

    btn.addEventListener('click', function (e) {
      e.preventDefault();
      // 鼠标悬停已经展开的：点一下改为「固定展开」；已经固定的：收起。
      if (li.classList.contains('is-pinned')) {
        setOpen(li, false);
      } else {
        closeAll(li);
        setOpen(li, true, true);
      }
    });

    btn.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        closeAll(li);
        setOpen(li, true, true);
        var first = links(li)[0];
        if (first) first.focus();
      }
    });

    li.addEventListener('keydown', function (e) {
      if ((e.key !== 'ArrowDown' && e.key !== 'ArrowUp') || e.target === btn) return;
      var list = links(li);
      var at = list.indexOf(document.activeElement);
      if (at < 0) return;
      e.preventDefault();
      var next = e.key === 'ArrowDown' ? Math.min(at + 1, list.length - 1) : at - 1;
      if (next < 0) btn.focus();
      else list[next].focus();
    });

    li.addEventListener('pointerenter', function (e) {
      if (e.pointerType !== 'mouse' || !wide.matches) return;
      clearTimeout(timers[i]);
      if (!isOpen(li)) {
        closeAll(li);
        setOpen(li, true, false);
      }
    });

    li.addEventListener('pointerleave', function (e) {
      if (e.pointerType !== 'mouse' || !wide.matches) return;
      if (!isOpen(li) || li.classList.contains('is-pinned')) return;
      clearTimeout(timers[i]);
      timers[i] = setTimeout(function () {
        if (!li.classList.contains('is-pinned')) setOpen(li, false);
      }, 200);
    });

    li.addEventListener('focusout', function (e) {
      if (e.relatedTarget && li.contains(e.relatedTarget)) return;
      // 焦点去了页面别处（Tab 出去）：收起。relatedTarget 为空（点了空白处 / 切换窗口）交给下面的 click 处理。
      if (e.relatedTarget && isOpen(li)) setOpen(li, false);
    });
  });

  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape' && e.key !== 'Esc') return;
    items.forEach(function (li) {
      if (!isOpen(li)) return;
      var hadFocus = li.contains(document.activeElement);
      setOpen(li, false);
      if (hadFocus || document.activeElement === document.body) caret(li).focus();
    });
  });

  // 点 / 轻触页面别处收起。iPhone 的 Safari 点在普通文字、空白处时不会把 click 冒泡到 document，
  // 所以还要听 pointerdown（键盘触发的 click 没有 pointerdown，仍由 click 处理）。
  function closeOutside(e) {
    items.forEach(function (li) { if (isOpen(li) && !li.contains(e.target)) setOpen(li, false); });
  }
  document.addEventListener('pointerdown', closeOutside);
  document.addEventListener('click', closeOutside);

  var onChange = function () { closeAll(null); };
  if (wide.addEventListener) wide.addEventListener('change', onChange);
  else if (wide.addListener) wide.addListener(onChange);
})();
