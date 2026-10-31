/**
 * cassette-frame.js — 背景动画预览沙箱的脚本（由 ../cassette-frame.html 引入，BG 维护）。
 *
 * 运行环境：<iframe sandbox="allow-scripts">，没有 allow-same-origin，所以本页的源是 "null"，
 * 读不到管理后台的 localStorage / 令牌。代码只通过 postMessage 从父页面（管理后台）拿到。
 *
 * 消息协议（只接受来自 window.parent 的消息，event.source 必须是 parent）：
 *   父 → 框  { type: 'run', code: string, dark: boolean }   运行一次（引擎 core.js + '\n' + 卡带代码）；
 *                                                           同一次加载只运行一次，重新运行 = 父页面重建 iframe。
 *            { type: 'pause' } / { type: 'resume' }         暂停 / 继续动画（不在屏幕上时省电）
 *            { type: 'stats', id, probe? }                   查询运行情况（测试和诊断用）
 *   框 → 父  { type: 'ready' }                              页面加载完成，可以发送 run
 *            { type: 'started' }                            代码已插入并执行
 *            { type: 'error', message }                     卡带代码出错
 *            { type: 'stats', id, running, paused, frames, dark, width, height, painted, sampled, signature, probeFound }
 *
 * 不是 ES 模块：这是普通脚本，在 <head> 里同步执行，只注册监听。
 */
(function () {
  'use strict';

  var parentWin = window.parent;
  // 被直接打开（不在 iframe 里）时什么都不做
  if (!parentWin || parentWin === window) return;

  var ran = false;
  var code = '';
  var isDark = false;
  var frames = 0;
  var paused = false;
  var heldCallback = null;
  var reportedErrors = 0;

  function post(msg) {
    try {
      // 父页面的源对沙箱来说未知（本页源为 null），所以用 '*'；消息里不含任何敏感信息
      parentWin.postMessage(msg, '*');
    } catch (e) { /* 父页面已经关闭 */ }
  }

  // ---- 包装 requestAnimationFrame：统计帧数 + 支持暂停 ----
  var realRAF = window.requestAnimationFrame.bind(window);
  var realCAF = window.cancelAnimationFrame.bind(window);
  window.requestAnimationFrame = function (cb) {
    if (typeof cb !== 'function') return 0;
    if (paused) {
      heldCallback = cb;   // 恢复时再继续这一帧
      return 0;
    }
    return realRAF(function (t) {
      frames++;
      cb(t);
    });
  };
  window.cancelAnimationFrame = function (id) {
    heldCallback = null;
    if (id) realCAF(id);
  };

  // ---- 卡带代码出错 → 告诉父页面 ----
  window.addEventListener('error', function (ev) {
    if (reportedErrors >= 3) return;   // 每帧都报同一个错时不要刷屏
    reportedErrors++;
    var msg = (ev && ev.message) ? String(ev.message) : '未知错误';
    if (ev && ev.lineno) msg += '（第 ' + ev.lineno + ' 行）';
    post({ type: 'error', message: msg.slice(0, 300) });
  });

  function applyTheme(dark) {
    isDark = !!dark;
    document.documentElement.setAttribute('data-theme', isDark ? 'dark' : 'light');
    // 引擎根据 body 的背景色判断深浅色（和网站上 PaperMod 的配色一致）
    document.body.style.background = isDark ? 'rgb(29, 30, 32)' : '#fff';
    document.body.classList.toggle('dark', isDark);
  }

  function run(data) {
    if (ran) return;      // 每次加载只运行一次，避免两个引擎抢同一块画布
    ran = true;
    code = data.code;
    applyTheme(data.dark);
    var s = document.createElement('script');
    s.dataset.autoplay = 'true';      // core.js 读 document.currentScript.dataset.autoplay
    s.textContent = code;
    document.body.appendChild(s);
    post({ type: 'started' });
  }

  function stats(data) {
    var canvas = document.getElementById('bgCanvas');
    var out = {
      type: 'stats',
      id: data.id,
      running: ran,
      paused: paused,
      frames: frames,
      dark: isDark,
      width: 0,
      height: 0,
      painted: 0,
      sampled: 0,
      signature: 0,
      probeFound: typeof data.probe === 'string' ? code.indexOf(data.probe) !== -1 : undefined,
    };
    if (canvas && canvas.width && canvas.height) {
      out.width = canvas.width;
      out.height = canvas.height;
      try {
        var img = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
        // 和页面底色混合后，与底色明显不同的像素才算「画上了东西」
        var bg = isDark ? [29, 30, 32] : [255, 255, 255];
        var step = 3;
        var hash = 2166136261;
        for (var y = 0; y < canvas.height; y += step) {
          for (var x = 0; x < canvas.width; x += step) {
            var i = (y * canvas.width + x) * 4;
            var a = img[i + 3] / 255;
            var r = img[i] * a + bg[0] * (1 - a);
            var g = img[i + 1] * a + bg[1] * (1 - a);
            var b = img[i + 2] * a + bg[2] * (1 - a);
            out.sampled++;
            if (Math.abs(r - bg[0]) + Math.abs(g - bg[1]) + Math.abs(b - bg[2]) > 24) out.painted++;
            hash ^= (img[i] + img[i + 1] * 3 + img[i + 2] * 7 + img[i + 3] * 11);
            hash = Math.imul(hash, 16777619) >>> 0;
          }
        }
        out.signature = hash;
      } catch (e) {
        out.error = String(e && e.message || e);
      }
    }
    post(out);
  }

  window.addEventListener('message', function (ev) {
    if (ev.source !== parentWin) return;            // 只听父页面的
    var data = ev.data;
    if (!data || typeof data !== 'object' || typeof data.type !== 'string') return;
    switch (data.type) {
      case 'run':
        if (typeof data.code !== 'string' || !data.code) return;
        run({ code: data.code, dark: data.dark === true });
        break;
      case 'pause':
        paused = true;
        break;
      case 'resume':
        if (!paused) return;
        paused = false;
        if (heldCallback) {
          var cb = heldCallback;
          heldCallback = null;
          window.requestAnimationFrame(cb);
        }
        break;
      case 'stats':
        stats(data);
        break;
      default:
        break;
    }
  });

  function ready() { post({ type: 'ready' }); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ready);
  else ready();
})();
