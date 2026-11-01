# PDF.js（本地副本）

资料在线预览页（`static/viewer/`）用来显示 PDF 的库。和管理后台的第三方库一样放在本地、不从 CDN 加载：
国内访问 CDN 不稳定，而且预览页与 `/admin/` 同源，不应运行第三方服务器上的脚本。

| 项目 | 内容 |
|---|---|
| 库 | PDF.js（Mozilla），npm 包 `pdfjs-dist` |
| 版本 | 6.4.299 |
| 许可证 | Apache-2.0（本目录 `LICENSE`）；字体与解码器的许可证见各子目录里的 `LICENSE_*` |
| 来源 | https://www.npmjs.com/package/pdfjs-dist/v/6.4.299 （仓库 https://github.com/mozilla/pdf.js ） |

## 复制了哪些文件

| 本目录 | 包内路径 | 用途 |
|---|---|---|
| `build/pdf.min.mjs` | `legacy/build/pdf.min.mjs` | 主库。用 **legacy** 版本：带兼容代码，老的安卓 / 微信内置浏览器也能运行 |
| `build/pdf.worker.min.mjs` | `legacy/build/pdf.worker.min.mjs` | 解析 PDF 的 Web Worker |
| `cmaps/` | `cmaps/` | 字符映射表。**中文 PDF 没有嵌入字体时必须有**（例如用「宋体 STSong-Light」的文件），否则中文显示不出来 |
| `standard_fonts/` | `standard_fonts/` | 没有嵌入的标准西文字体（Times、Helvetica、Courier…）的替代字体 |
| `wasm/` | `wasm/`（**不含** `quickjs-eval.*`） | JPEG 2000 / JBIG2 图片解码器（扫描版讲义常用）和 ICC 颜色管理，在 Worker 里运行；`*_nowasm_fallback.js` 是不支持 WebAssembly 时的备用实现 |
| `iccs/` | `iccs/` | CMYK 颜色配置文件 |
| `LICENSE` | `LICENSE` | Apache-2.0 |

**刻意没有复制**：`pdf.sandbox*.mjs` 和 `wasm/quickjs-eval.*`（PDF 里的 JavaScript 脚本引擎——预览页不执行 PDF 脚本）、
`web/`（PDF.js 自带的完整阅读器界面，我们自己写了轻量界面 `viewer.js`）、非 legacy 版本、`*.map`、类型定义。

## 升级

1. 下载新版本：`npm pack pdfjs-dist@<版本>`，解压得到 `package/`（可以对照 npm 上公布的 integrity 校验）。
2. 按上表整体替换本目录对应文件（先删除旧的 `cmaps/` 等目录，避免残留）；记得不要复制 `quickjs-eval.*` 和 `pdf.sandbox*`。
3. 更新本文件里的版本号。
4. 查看新版本 `legacy/build/pdf.mjs` 里 `getDocument` 的参数是否有变化（`cMapUrl`、`standardFontDataUrl`、`wasmUrl`、`iccUrl`），
   以及 `TextLayer`、`page.render` 的用法；`static/viewer/viewer.js` 里的 `getDocument({...})` 要跟着改。
5. 跑一遍测试：`node tests/admin/e2e-viewer.mjs`（含中文非嵌入字体、懒加载、内容安全策略检查）。
