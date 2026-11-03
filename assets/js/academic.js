/**
 * 论文列表页 /publications/ 的 BibTeX「复制」按钮（本站脚本，由 layouts/publications/list.html 以 defer 引入，
 * 只在至少一篇论文写了 bibtex 时加载）。
 *
 * BibTeX 本身用 <details> 展开，不需要脚本；这里只是在每个展开区域里加一个「复制」按钮。
 * 浏览器不支持剪贴板接口（或页面不是 https / localhost）时不加按钮，读者仍可手动选中复制。
 * 按钮文字来自 <script data-copy="…" data-copied="…">（i18n 的 pub_copy / pub_copied）。
 */
(function () {
    var script = document.currentScript;
    if (!navigator.clipboard || !window.isSecureContext) return;
    var label = (script && script.dataset.copy) || 'Copy';
    var done = (script && script.dataset.copied) || 'Copied';

    var blocks = document.querySelectorAll('.pub-bibtex pre');
    for (var i = 0; i < blocks.length; i++) {
        (function (pre) {
            var btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'pub-copy';
            btn.textContent = label;
            var timer = null;
            btn.addEventListener('click', function () {
                var code = pre.querySelector('code') || pre;
                navigator.clipboard.writeText(code.textContent).then(function () {
                    btn.textContent = done;
                    clearTimeout(timer);
                    timer = setTimeout(function () { btn.textContent = label; }, 2000);
                }, function () { /* 复制被拒绝：什么也不做，读者可以手动选中 */ });
            });
            pre.parentNode.insertBefore(btn, pre.nextSibling);
        })(blocks[i]);
    }
})();
