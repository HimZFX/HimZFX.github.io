# 资料在线预览（/viewer/）

点开就能看课程资料，不用先下载：PDF 用 PDF.js 显示（安卓手机、微信内置浏览器里也能看），图片直接显示，
其他类型的文件给出下载按钮。这是一个独立的静态页面，不经过 Hugo 模板、不加载主题、数学公式、背景动画、评论区或任何第三方脚本。

## 网址

```
/viewer/?file=<encodeURIComponent(网站路径)>[&lang=en][&embed=1][&page=N]
例：/viewer/?file=%2Fdocuments%2F%E8%AE%B2%E4%B9%89.pdf     （即 /documents/讲义.pdf）
```

| 参数 | 说明 |
|---|---|
| `file` | 必填。本站文件的路径，以 `/` 开头，例如 `/documents/讲义.pdf`、`/images/板书.jpg` |
| `lang=en` | 英文界面（默认中文），左上角「主页」指向 `/en/` |
| `embed=1` | 精简模式，给文章里嵌入的 `<iframe>` 用：顶栏更窄，带「在新页面打开」和「下载」 |
| `page=N` | 从第 N 页开始显示 |

管理后台「资料」里的「复制链接」默认给出这种预览链接；文章里嵌入用短代码 `{{</* pdf "/documents/讲义.pdf" */>}}`
（见 `layouts/shortcodes/pdf.html` 和 SITE_GUIDE.md「上传文件」一节）。

| 文件类型 | 显示方式 |
|---|---|
| `.pdf` | PDF.js：只渲染屏幕附近的页（滚远了自动释放内存）、按屏幕像素密度渲染、默认适应宽度、可放大缩小（手机上双指捏合）、文字可选中复制、PDF 里的网址链接和目录跳转可点 |
| `.png .jpg .jpeg .gif .webp .avif .svg` | 直接显示图片；点一下在「适应屏幕」和「原始大小」之间切换 |
| 其他 | 提示「暂不支持在线预览」并给出下载按钮 |

## 文件

| 文件 | 作用 |
|---|---|
| `index.html` | 页面骨架 + 内容安全策略（CSP） |
| `theme.js` | 在显示前决定深浅色：与主站一致，先看 `localStorage['pref-theme']`，否则跟随系统 |
| `viewer.js` | 主逻辑（ES 模块）：参数检查、PDF 懒加载渲染、缩放、页码、图片、错误提示 |
| `path.js` | `file` 参数的校验（纯函数，测试也会直接调用） |
| `viewer.css` | 样式（颜色与主站 PaperMod 一致） |
| `nomodule.js` | 只在不支持 ES 模块的老浏览器里运行，提示换浏览器 |
| `vendor/pdfjs/` | PDF.js 6.4.299 本地副本（legacy 版），说明见其中的 README.md |

左上角的网站名称是从首页的 `og:site_name` 读出来的（读不到时显示「主页」），所以在后台改了网站标题这里会自动跟着变。

## 安全

预览页和管理后台 `/admin/` 在同一个网址下，而后台可能把 GitHub 令牌记在浏览器的 localStorage 里。所以：

- **只打开本站文件**：`file` 必须以 `/` 开头且不是 `//`，不能有反斜杠、控制字符、`.` / `..` 路径段（解码后也不行，
  `%2e%2e`、`%252e%252e` 等都会被拒绝），不能在 `/admin/` 或 `/viewer/` 下。不合格时只显示错误，不发任何请求、不跳转。
- **CSP**：`script-src 'self'`（没有内联脚本、没有 eval）、`connect-src 'self'`、`worker-src 'self'`、`style-src 'self'`、
  `object-src 'none'`、`base-uri 'none'`、`form-action 'none'`、`frame-src 'none'`。
  不需要 `'wasm-unsafe-eval'`：WebAssembly 解码器只在 PDF.js 的 Worker 里运行，Worker 不受页面 CSP 约束。
- **不读写 localStorage**，唯一的例外是读取主题偏好 `pref-theme`。
- PDF.js 关闭脚本（不带 `pdf.sandbox`）和 XFA 表单；PDF 里的链接只保留 `http(s)`、`mailto` 和文档内跳转，
  外部链接在新标签页打开并带 `noopener noreferrer`；页面内容全部用 DOM API / textContent 生成，不用 innerHTML。
- `<meta name="referrer" content="no-referrer">`：从 PDF 点出去的链接不会带上预览地址。

## 测试

```bash
node tests/admin/e2e-viewer.mjs          # 截图在 $VIEWER_E2E_DIR/screenshots（默认系统临时目录）
```
