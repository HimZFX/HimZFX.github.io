/**
 * 背景效果：三体运动
 * 若干星体在 N 体引力下运动，带 3D 透视投影、镜头旋转和渐变拖尾。
 * 接口约定见 ../core.js。
 */
window.BG_System.loadCassette({
    // --- 🌟 核心数据 ---
    stars: [],
    angleOffset: 0,
    width: window.innerWidth,
    height: window.innerHeight,

    // --- ⚙️ 物理参数 (可调整) ---
    STAR_COUNT: 3,         // 星体数量
    G: 0.5,                // 引力常数
    SOFTENING: 100,       // 软化因子 (越大运动越平滑)
    TRAIL_LENGTH: 600,     // 拖尾长度
    FRICTION: 0.99999,     // 阻尼 (极低摩擦，接近真空)
    CENTER_PULL: 0.00001, // 微弱向心力 (防止飞散太快)
    ESCAPE_RADIUS: 2000,   // 逃逸半径 (飞出多远重置)
    
    // --- 🎥 相机参数 ---
    ROTATION_SPEED: 0.001, // 镜头旋转速度
    SCALE: 0.8,            // 缩放比例
    Z_DEPTH: 800,          // 景深因子 (控制近大远小)

    // --- 🎨 颜色配置 ---
    colors: {
        dark: [
            { color: '#00f2ff', glow: '#00f2ff' }, // 青
            { color: '#ff0055', glow: '#ff0055' }, // 洋红
            { color: '#ffe600', glow: '#ffe600' }  // 金
        ],
        light: [
            { color: '#003366', glow: 'transparent' }, // 深蓝
            { color: '#800000', glow: 'transparent' }, // 深红
            { color: '#2F4F4F', glow: 'transparent' }  // 深灰
        ]
    },

    // --- 📥 初始化接口 ---
    onInit: function(w, h) {
        this.width = w;
        this.height = h;
        this.stars = [];
        // 创建初始星体
        for (let i = 0; i < this.STAR_COUNT; i++) {
            this.stars.push(this.createStar(i));
        }
    },

    // --- 📐 窗口调整接口 ---
    onResize: function(w, h) {
        this.width = w;
        this.height = h;
    },

    // --- 🔄 物理更新接口 (每帧调用) ---
    onUpdate: function(isDark) {
        // 1. 旋转镜头
        this.angleOffset += this.ROTATION_SPEED;

        // 2. 物理计算
        for (let star of this.stars) {
            // A. N体引力
            for (let other of this.stars) {
                if (star === other) continue;
                const dx = other.x - star.x;
                const dy = other.y - star.y;
                const dz = other.z - star.z;
                const distSq = dx*dx + dy*dy + dz*dz;
                const dist = Math.sqrt(distSq);
                
                // F = G * m1 * m2 / r^2
                const force = (this.G * star.mass * other.mass) / (distSq + this.SOFTENING);
                
                star.vx += (force * dx / dist) / star.mass;
                star.vy += (force * dy / dist) / star.mass;
                star.vz += (force * dz / dist) / star.mass;
            }

            // B. 环境力 (向心 + 摩擦)
            star.vx += (0 - star.x) * this.CENTER_PULL;
            star.vy += (0 - star.y) * this.CENTER_PULL;
            star.vz += (0 - star.z) * this.CENTER_PULL;
            
            star.vx *= this.FRICTION;
            star.vy *= this.FRICTION;
            star.vz *= this.FRICTION;

            // C. 更新位置
            star.x += star.vx;
            star.y += star.vy;
            star.z += star.vz;

            // D. 边界检查 (飞出重置)
            const distSqFromCenter = star.x*star.x + star.y*star.y + star.z*star.z;
            if (distSqFromCenter > this.ESCAPE_RADIUS * this.ESCAPE_RADIUS) {
                this.resetStar(star);
                continue; // 重置后跳过本次轨迹记录
            }

            // E. 记录轨迹
            star.history.push({x: star.x, y: star.y, z: star.z});
            if (star.history.length > this.TRAIL_LENGTH) star.history.shift();
        }
    },

    // --- 🖌️ 渲染接口 (每帧调用) ---
    onDraw: function(ctx, w, h, isDark) {
        const cx = w / 2;
        const cy = h / 2;
        
        // 按照 Z 轴深度排序，保证遮挡关系正确 (选做，为了完美)
        // this.stars.sort((a, b) => {
        //     const pA = this.project(a.x, a.y, a.z);
        //     const pB = this.project(b.x, b.y, b.z);
        //     return pA.zIndex - pB.zIndex;
        // });

        for (let star of this.stars) {
            const theme = isDark ? this.colors.dark : this.colors.light;
            const style = theme[star.index % theme.length];

            // 1. 投影当前位置
            const proj = this.project(star.x, star.y, star.z, cx, cy);
            const currentRadius = star.baseRadius * proj.scale;
            const baseAlpha = Math.max(0.2, Math.min(1.0, proj.scale));

            // 2. 绘制渐变拖尾
            // 采样率：每隔2个点画一次，提升性能
            const sampleRate = 2; 
            
            // 技巧：为了画出渐变色，我们需要一段一段地画
            // 为了避免 stroke() 调用过多影响性能，这里我们分批次画或者只画关键段
            // 这里使用“循环绘制法”以保证完美的渐变效果
            for (let i = 0; i < star.history.length - sampleRate; i += sampleRate) {
                const p3d1 = star.history[i];
                const p3d2 = star.history[i+sampleRate];
                
                const p1 = this.project(p3d1.x, p3d1.y, p3d1.z, cx, cy);
                const p2 = this.project(p3d2.x, p3d2.y, p3d2.z, cx, cy);
                
                const ratio = i / star.history.length; // 0 (尾) -> 1 (头)
                
                ctx.beginPath();
                ctx.moveTo(p1.x, p1.y);
                ctx.lineTo(p2.x, p2.y);
                
                const finalAlpha = baseAlpha * ratio;
                
                if (isDark) {
                    // 黑夜：白色发光拖尾
                    ctx.strokeStyle = `rgba(255, 255, 255, ${finalAlpha * 0.4})`;
                    ctx.lineWidth = ratio * 3 * p1.scale;
                } else {
                    // 白天：黑色淡墨拖尾
                    ctx.strokeStyle = `rgba(0, 0, 0, ${finalAlpha * 0.15})`;
                    ctx.lineWidth = ratio * 2 * p1.scale;
                }
                
                ctx.lineCap = 'round';
                ctx.stroke();
            }

            // 3. 绘制星体 (只在视野前方绘制)
            if (proj.scale > 0) {
                ctx.beginPath();
                ctx.arc(proj.x, proj.y, currentRadius, 0, Math.PI * 2);
                ctx.fillStyle = style.color;
                
                ctx.globalAlpha = baseAlpha;
                if (isDark) {
                    ctx.shadowBlur = 20 * proj.scale;
                    ctx.shadowColor = style.glow;
                }
                ctx.fill();
                
                // 重置状态
                ctx.shadowBlur = 0;
                ctx.globalAlpha = 1.0;
            }
        }
    },

    // --- 🛠️ 内部工具函数 ---

    // 3D 投影算法
    project: function(x, y, z, cx, cy) {
        const cosA = Math.cos(this.angleOffset);
        const sinA = Math.sin(this.angleOffset);
        
        // 绕 Y 轴旋转
        const rotX = x * cosA - z * sinA;
        const rotZ = x * sinA + z * cosA;
        const rotY = y;

        // 透视除法
        let depthScale = this.Z_DEPTH / (this.Z_DEPTH + rotZ);
        depthScale = Math.max(0.1, Math.min(2.0, depthScale));

        const screenX = cx + rotX * this.SCALE * depthScale;
        const screenY = cy + rotY * this.SCALE * depthScale;

        return { x: screenX, y: screenY, scale: depthScale, zIndex: rotZ };
    },

    // 创建新星体对象
    createStar: function(index) {
        const s = { index: index, history: [] };
        this.resetStar(s);
        return s;
    },

    // 重置星体状态
    resetStar: function(s) {
        // 在屏幕中心区域随机生成
        const spread = Math.min(this.width, this.height) * 0.75;
        
        s.x = (Math.random() - 0.5) * spread;
        s.y = (Math.random() - 0.5) * spread;
        s.z = (Math.random() - 0.5) * spread;
        
        s.vx = (Math.random() - 0.5) * 1.5;
        s.vy = (Math.random() - 0.5) * 1.5;
        s.vz = (Math.random() - 0.5) * 1.5;
        
        s.mass = 100 + Math.random() * 100;
        s.baseRadius = Math.sqrt(8 + s.mass/100);
        s.history = [];
        
        // 预填充历史轨迹，避免重生时闪烁
        for(let i=0; i<this.TRAIL_LENGTH; i++) {
            s.history.push({x: s.x, y: s.y, z: s.z});
        }
    }
});
