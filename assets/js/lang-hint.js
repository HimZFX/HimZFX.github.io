/**
 * 语言提示（由 layouts/partials/features/lang-hint.html 以 <script defer data-lang data-hints> 引入，执行时页面已解析完毕）。
 *
 * data-lang  = 这一页的语言（例如 "en"）
 * data-hints = 这一页的其他语言版本：[{ lang, code, url, text, close }]（text / close 已经是那种语言的文字）
 *
 * 按 navigator.languages 的顺序找读者的首选语言：先遇到这一页的语言 → 不打扰；先遇到某个版本的语言 →
 * 在页面底部显示「<text> →」链接到那个版本，旁边一个 × 关闭。从不自动跳转。
 * 不显示的情况：读者关闭过这种语言的提示（localStorage['lang-hint-dismissed']，空格分隔的语言代码）、
 * 刚从那个版本过来（document.referrer 就是它，即刚用语言切换按钮选了这一页）。
 * 只用 DOM API / textContent，不用 innerHTML；读写 localStorage 失败（隐私模式）时照常工作。
 */
(function () {
    var script = document.currentScript;
    if (!script || !document.body) return;
    var KEY = 'lang-hint-dismissed';

    var hints;
    try {
        hints = JSON.parse(script.getAttribute('data-hints') || '[]');
    } catch (e) {
        return;
    }
    if (!hints || !hints.length) return;

    function primary(tag) {
        return String(tag || '').toLowerCase().split(/[-_]/)[0];
    }

    var pageLang = primary(script.getAttribute('data-lang'));
    var prefs = navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language || ''];
    var hint = null;
    for (var i = 0; i < prefs.length && !hint; i++) {
        var want = primary(prefs[i]);
        if (!want) continue;
        if (want === pageLang) return; // 读者读得懂这一页的语言
        for (var j = 0; j < hints.length; j++) {
            if (primary(hints[j].lang) === want) {
                hint = hints[j];
                break;
            }
        }
    }
    if (!hint || !hint.url) return;

    var dismissed = '';
    try {
        dismissed = window.localStorage.getItem(KEY) || '';
    } catch (e) { /* 读不到：照常显示 */ }
    if ((' ' + dismissed + ' ').indexOf(' ' + hint.lang + ' ') !== -1) return;

    // 刚从那个语言版本过来（语言切换按钮）：读者是特意选的这一页
    var target = document.createElement('a');
    target.href = hint.url;
    if (document.referrer) {
        var from = document.createElement('a');
        from.href = document.referrer;
        if (from.protocol + '//' + from.host + from.pathname === target.protocol + '//' + target.host + target.pathname) return;
    }

    var box = document.createElement('div');
    box.className = 'lang-hint';
    box.setAttribute('role', 'note');
    box.setAttribute('lang', hint.code || hint.lang);
    box.setAttribute('data-lang-hint', hint.lang);

    var link = document.createElement('a');
    link.className = 'lang-hint-link';
    link.href = hint.url;
    link.setAttribute('hreflang', hint.lang);
    link.appendChild(document.createTextNode(hint.text + ' '));
    var arrow = document.createElement('span');
    arrow.setAttribute('aria-hidden', 'true');
    arrow.textContent = '→';
    link.appendChild(arrow);

    var close = document.createElement('button');
    close.type = 'button';
    close.className = 'lang-hint-close';
    close.title = hint.close;
    close.setAttribute('aria-label', hint.close);
    close.textContent = '×';
    close.onclick = function () {
        try {
            window.localStorage.setItem(KEY, (dismissed ? dismissed + ' ' : '') + hint.lang);
        } catch (e) { /* 存不下：只在这一页关闭 */ }
        if (box.parentNode) box.parentNode.removeChild(box);
    };

    box.appendChild(link);
    box.appendChild(close);
    document.body.appendChild(box);
})();
