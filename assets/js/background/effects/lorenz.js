/**
 * 背景效果：洛伦兹吸引子
 * 数值积分 Lorenz 方程，绕 Y 轴缓慢旋转视角；用半透明覆盖层制造长曝光拖尾。
 * 接口约定见 ../core.js。
 */
window.BG_System.loadCassette({
    keepTrails: true,          // 不每帧清屏，靠 onDraw 里的半透明覆盖层淡出

    // --- ⚙️ 混沌参数（经典洛伦兹参数） ---
    SIGMA: 10,
    RHO: 28,
    BETA: 8 / 3,
    DT: 0.008,                 // 时间步长（越小越平滑）
    STEPS_PER_FRAME: 2,        // 每帧积分几步（绘制速度）
    MAX_POINTS: 2000,          // 轨迹最多保留的点数（性能）

    // --- 🎥 相机参数 ---
    SCALE: 12,                 // 缩放大小
    ROTATION_SPEED: 0.002,     // 视角旋转速度
    OFFSET_Y: 20,              // 竖直方向微调，让图形居中

    // --- 🎨 颜色方案 ---
    colors: {
        dark:  { hueStart: 180, hueEnd: 320 },   // 青 -> 洋红（霓虹）
        light: { hueStart: 240, hueEnd: 340 }    // 深蓝 -> 深紫（墨水感）
    },

    onInit: function () {
        this.points = [];
        this.angle = 0;
        this.x = 0.1; this.y = 0; this.z = 0;
    },

    onUpdate: function () {
        for (let i = 0; i < this.STEPS_PER_FRAME; i++) {
            const dx = this.SIGMA * (this.y - this.x) * this.DT;
            const dy = (this.x * (this.RHO - this.z) - this.y) * this.DT;
            const dz = (this.x * this.y - this.BETA * this.z) * this.DT;
            this.x += dx; this.y += dy; this.z += dz;
            this.points.push({ x: this.x, y: this.y, z: this.z });
            if (this.points.length > this.MAX_POINTS) this.points.shift();
        }
        this.angle += this.ROTATION_SPEED;
    },

    onDraw: function (ctx, w, h, isDark) {
        // 1. 拖尾：极低不透明度的覆盖层 = 极长的拖尾
        ctx.fillStyle = isDark ? 'rgba(5, 5, 5, 0.03)' : 'rgba(245, 245, 247, 0.05)';
        ctx.fillRect(0, 0, w, h);

        // 2. 投影（绕 Y 轴旋转）并连线
        const cosA = Math.cos(this.angle);
        const sinA = Math.sin(this.angle);
        ctx.beginPath();
        this.points.forEach(function (p, i) {
            const px = p.x * cosA - p.z * sinA;
            const sx = w / 2 + px * this.SCALE;
            const sy = h / 2 + p.y * this.SCALE + this.OFFSET_Y;
            if (i === 0) ctx.moveTo(sx, sy); else ctx.lineTo(sx, sy);
        }, this);

        // 3. 上色
        const gradient = ctx.createLinearGradient(0, 0, w, h);
        if (isDark) {
            // 黑夜：霓虹渐变 + 光晕
            gradient.addColorStop(0, `hsl(${this.colors.dark.hueStart}, 100%, 50%)`);
            gradient.addColorStop(1, `hsl(${this.colors.dark.hueEnd}, 100%, 50%)`);
            ctx.lineWidth = 1.5;
            ctx.shadowBlur = 10;
            ctx.shadowColor = `hsla(${this.colors.dark.hueStart}, 100%, 50%, 0.5)`;
        } else {
            // 白天：钢笔墨水，线条更细
            gradient.addColorStop(0, `hsla(${this.colors.light.hueStart}, 80%, 30%, 0.6)`);
            gradient.addColorStop(1, `hsla(${this.colors.light.hueEnd}, 80%, 30%, 0.6)`);
            ctx.lineWidth = 1.0;
            ctx.shadowBlur = 0;
        }
        ctx.strokeStyle = gradient;
        ctx.stroke();
        ctx.shadowBlur = 0;   // 复位，避免下一帧的覆盖层也带上昂贵的阴影
    }
});
