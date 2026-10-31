/**
 * 背景动画引擎（"游戏机"）
 *
 * 负责所有效果共用的部分：画布尺寸、动画循环、深浅色检测、左下角开关按钮。
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
 * <script defer data-autoplay="true|false"> 的形式引入，执行时页面已解析完毕。
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
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.setAttribute('aria-label', 'Toggle background animation');
    btn.style.cssText = 'position:fixed;bottom:20px;left:20px;z-index:999;background:transparent;border:none;cursor:pointer;opacity:0.6;transition:all 0.3s;padding:5px;';
    const iconOn = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a10 10 0 1 0 10 10 4 4 0 0 1-5-5 4 4 0 0 1-5-5c3.2 0 5.2-2.3 5.2-2.3 0-3.2-2.3-5.2-2.3-5.2S12 5.5 12 2Z"/></svg>`;
    const iconOff = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="1" y1="1" x2="23" y2="23"></line><path d="M16.72 11.06A10.94 10.94 0 0 1 19 12.55"></path><path d="M5 6.44a4 4 0 0 1 2.28-2.68"></path><path d="M12.6 3.35A10 10 0 0 1 12 2c3.2 0 5.2 2.3 5.2 2.3a10.36 10.36 0 0 1 1.7 1.3"></path><path d="M20.47 16.5a10 10 0 0 1-3.27 3.7"></path><path d="M10 19.3a10 10 0 0 1-5.3-2.8"></path><circle cx="12" cy="12" r="10"></circle></svg>`;

    function updateBtn() {
        btn.innerHTML = userEnabled ? iconOn : iconOff;
        btn.style.opacity = userEnabled ? '1' : '0.6';
        btn.setAttribute('aria-pressed', String(userEnabled));
    }
    updateBtn();

    btn.onclick = function () {
        userEnabled = !userEnabled;
        updateBtn();
        if (userEnabled) start(); else stop();
    };
    btn.onmouseenter = function () { btn.style.transform = 'scale(1.1)'; };
    btn.onmouseleave = function () { btn.style.transform = 'scale(1)'; };
    document.body.appendChild(btn);

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
