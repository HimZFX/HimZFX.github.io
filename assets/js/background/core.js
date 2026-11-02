/**
 * 背景动画引擎（"游戏机"）
 *
 * 负责所有效果共用的部分：画布尺寸、动画循环、深浅色检测、开关按钮（宽屏在左下角，窄屏在页脚）。
 * 具体画什么由"卡带"决定：effects/ 下的每个文件都调用一次
 *
 *     BG_System.loadCassette({ ...卡带... })
 *
 * 卡带可以实现以下接口（全部可选）：
 *     onInit(width, height)              插入卡带时调用一次
 *     onResize(width, height)            窗口尺寸变化时调用
 *     onUpdate(isDark)                   每帧调用：更新物理状态
 *     onDraw(ctx, width, height, isDark) 每帧调用：绘制
 *     keepTrails: true                   引擎不再每帧清空画布，由卡带自己做拖尾/淡出
 *
 * 新增效果：在 effects/ 下新建一个 .js 文件，然后把 params.toml 里的
 * background.effect 改成它的文件名即可。
 *
 * 本文件由 layouts/partials/features/background.html 以
 * <script defer data-autoplay="true|false" data-label="<按钮的提示文字>"> 的形式引入，执行时页面已解析完毕。
 * 按钮的提示文字来自 i18n 的 bg_toggle（随页面语言）。
 */
window.BG_System = (function () {
    const script = document.currentScript;
    let userEnabled = !!script && script.dataset.autoplay === 'true';  // 是否自动播放由模板根据配置决定

    const canvas = document.createElement('canvas');
    canvas.id = 'bgCanvas';
    canvas.setAttribute('aria-hidden', 'true');
    canvas.style.cssText = 'position:fixed;top:0;left:0;width:100vw;height:100vh;z-index:-1;pointer-events:none;';
    document.body.appendChild(canvas);
    const ctx = canvas.getContext('2d');

    let width = 0, height = 0;
    let isRunning = false;
    let animationFrameId = null;
    let currentEffect = null;                              // 当前插入的卡带

    // ---------- 开关按钮 ----------
    // 样式在 assets/css/extended/background.css。宽屏（≥ 900px）固定在左下角，正好落在正文左边的空白里；
    // 窄屏（手机、平板竖屏）上正文几乎占满宽度，固定按钮会盖住正文，所以改放进页脚（"Powered by …" 下面），
    // 跟着页面滚动，不再遮挡任何内容。窗口宽度变化时自动在两种位置之间切换；页面没有页脚时仍固定在左下角
    // （此时按钮更小、半透明，并避开 iPhone 底部的安全区域）。
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'bg-toggle';
    btn.setAttribute('aria-label', (script && script.dataset.label) || 'Background animation');
    btn.title = btn.getAttribute('aria-label');
    const iconOn = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 2a10 10 0 1 0 10 10 4 4 0 0 1-5-5 4 4 0 0 1-5-5c3.2 0 5.2-2.3 5.2-2.3 0-3.2-2.3-5.2-2.3-5.2S12 5.5 12 2Z"/></svg>`;
    const iconOff = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="1" y1="1" x2="23" y2="23"></line><path d="M16.72 11.06A10.94 10.94 0 0 1 19 12.55"></path><path d="M5 6.44a4 4 0 0 1 2.28-2.68"></path><path d="M12.6 3.35A10 10 0 0 1 12 2c3.2 0 5.2 2.3 5.2 2.3a10.36 10.36 0 0 1 1.7 1.3"></path><path d="M20.47 16.5a10 10 0 0 1-3.27 3.7"></path><path d="M10 19.3a10 10 0 0 1-5.3-2.8"></path><circle cx="12" cy="12" r="10"></circle></svg>`;

    function updateBtn() {
        btn.innerHTML = userEnabled ? iconOn : iconOff;
        btn.setAttribute('aria-pressed', String(userEnabled));
    }
    updateBtn();

    btn.onclick = function () {
        userEnabled = !userEnabled;
        updateBtn();
        if (userEnabled) start(); else stop();
    };

    const footer = document.querySelector('body > footer.footer, footer.footer');
    const dock = document.createElement('div');                // 页脚里的位置：版权一行下面，居中
    dock.className = 'bg-toggle-dock';
    const narrow = window.matchMedia ? window.matchMedia('(max-width: 899px)') : null;

    function place() {
        const docked = !!(footer && narrow && narrow.matches);
        btn.classList.toggle('is-docked', docked);
        if (docked) {
            if (btn.parentNode !== dock) dock.appendChild(btn);
            if (dock.parentNode !== footer) footer.appendChild(dock);
        } else {
            if (dock.parentNode) dock.parentNode.removeChild(dock);
            if (btn.parentNode !== document.body) document.body.appendChild(btn);
        }
    }
    place();
    if (narrow) {
        if (narrow.addEventListener) narrow.addEventListener('change', place);
        else if (narrow.addListener) narrow.addListener(place);
    }

    // ---------- 核心功能 ----------
    function resize() {
        width = canvas.width = window.innerWidth;
        height = canvas.height = window.innerHeight;
        if (currentEffect && currentEffect.onResize) currentEffect.onResize(width, height);
    }

    // 根据页面实际背景亮度判断深浅色，兼容 PaperMod 的手动切换与跟随系统
    function getIsDark() {
        try {
            const rgb = window.getComputedStyle(document.body).backgroundColor.match(/\d+/g);
            if (rgb) {
                return ((parseInt(rgb[0]) * 299 + parseInt(rgb[1]) * 587 + parseInt(rgb[2]) * 114) / 1000) < 128;
            }
        } catch (e) {}
        return document.body.classList.contains('dark');
    }

    function loop() {
        if (!userEnabled || !currentEffect) return;

        if (!currentEffect.keepTrails) ctx.clearRect(0, 0, width, height);
        const isDark = getIsDark();

        // 调用卡带的逻辑
        if (currentEffect.onUpdate) currentEffect.onUpdate(isDark);
        if (currentEffect.onDraw) currentEffect.onDraw(ctx, width, height, isDark);

        animationFrameId = requestAnimationFrame(loop);
    }

    function start() {
        if (isRunning) return;
        isRunning = true;
        resize();
        loop();
    }

    function stop() {
        isRunning = false;
        if (animationFrameId) cancelAnimationFrame(animationFrameId);
        ctx.clearRect(0, 0, width, height);
    }

    window.addEventListener('resize', resize);
    resize();

    // ---------- 对外接口：插入卡带 ----------
    return {
        loadCassette: function (effect) {
            currentEffect = effect;
            if (currentEffect.onInit) currentEffect.onInit(width, height);
            if (userEnabled) start();
        }
    };
})();
