/**
 * 背景效果：流场粒子
 * 大量粒子沿一个由三角函数构造的向量场漂移，形成漩涡状的流线。
 * 接口约定见 ../core.js。
 */
window.BG_System.loadCassette({
    keepTrails: true,          // 不每帧清屏，靠 onDraw 里的半透明覆盖层淡出

    // --- ⚙️ 场参数 ---
    PARTICLE_COUNT: 400,       // 粒子数量
    ZOOM: 0.005,               // 场的疏密程度
    CURVE_STRENGTH: 20,        // 弯曲程度
    SPEED_MULT: 1.5,           // 速度倍率
    HISTORY_LENGTH: 10,        // 每个粒子保留的轨迹点数

    // --- 🎨 颜色方案 ---
    colors: {
        dark:  { r: 0,  g: 255, b: 200 },               // 电光青（Cyberpunk），透明度随机闪烁
        light: { r: 50, g: 60,  b: 70, alpha: 0.15 }    // 铅笔灰（素描）
    },

    onInit: function (w, h) {
        this.onResize(w, h);
    },

    // 尺寸变化时重新撒粒子
    onResize: function (w, h) {
        this.width = w;
        this.height = h;
        this.particles = [];
        for (let i = 0; i < this.PARTICLE_COUNT; i++) {
            const p = {};
            this.resetParticle(p);
            this.particles.push(p);
        }
    },

    onUpdate: function () {
        for (const p of this.particles) {
            // 当前位置的场方向：cos(x) + sin(y) 的变种，制造复杂漩涡（无需 Perlin Noise 库）
            const angle = (Math.cos(p.x * this.ZOOM) + Math.sin(p.y * this.ZOOM)) * this.CURVE_STRENGTH;
            p.x += Math.cos(angle) * this.SPEED_MULT;
            p.y += Math.sin(angle) * this.SPEED_MULT;

            p.history.push({ x: p.x, y: p.y });
            if (p.history.length > this.HISTORY_LENGTH) p.history.shift();

            // 飞出屏幕就重生
            if (p.x < 0 || p.x > this.width || p.y < 0 || p.y > this.height) this.resetParticle(p);
        }
    },

    onDraw: function (ctx, w, h, isDark) {
        // 1. 拖尾：黑夜消散得快一点，白天留痕更多
        ctx.fillStyle = isDark ? 'rgba(5, 5, 5, 0.1)' : 'rgba(245, 245, 247, 0.2)';
        ctx.fillRect(0, 0, w, h);

        // 2. 画每个粒子的短轨迹
        const c = isDark ? this.colors.dark : this.colors.light;
        ctx.lineWidth = isDark ? 1.5 : 1;   // 白天线细一点，像素描
        for (const p of this.particles) {
            if (p.history.length < 2) continue;
            ctx.beginPath();
            ctx.moveTo(p.history[0].x, p.history[0].y);
            for (let i = 1; i < p.history.length; i++) ctx.lineTo(p.history[i].x, p.history[i].y);
            const alpha = isDark ? Math.random() * 0.5 : c.alpha;
            ctx.strokeStyle = `rgba(${c.r}, ${c.g}, ${c.b}, ${alpha})`;
            ctx.stroke();
        }
    },

    resetParticle: function (p) {
        p.x = Math.random() * this.width;
        p.y = Math.random() * this.height;
        p.history = [];
    }
});
