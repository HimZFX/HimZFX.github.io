# 第三方库（本地副本）

管理后台用到的库都放在这里，不从 CDN 加载：国内访问 CDN 不稳定，而且管理页面持有能写仓库的令牌，
不应运行任何第三方服务器上的脚本。升级时整体替换对应目录即可。

| 目录 | 库 | 版本 | 许可证 | 来源 |
|---|---|---|---|---|
| `vditor/` | Vditor（Markdown 编辑器） | 3.11.3 | MIT（`vditor/LICENSE`） | npm `vditor` |
| `vditor/dist/js/lute/` | Lute（Vditor 的 Markdown 引擎） | 随 Vditor 3.11.3 | 木兰宽松许可证 v2 | https://github.com/88250/lute |
| `vditor/dist/js/katex/` | KaTeX（公式渲染） | 随 Vditor 3.11.3 | MIT | https://github.com/KaTeX/KaTeX |
| `vditor/dist/js/highlight.js/` | highlight.js（代码高亮） | 随 Vditor 3.11.3 | BSD-3-Clause（目录内 `LICENSE`） | https://github.com/highlightjs/highlight.js |
| `js-yaml/` | js-yaml（front matter 解析） | 4.1.1 | MIT（`js-yaml/LICENSE`） | npm `js-yaml` |
| `smol-toml/` | smol-toml（配置文件解析） | 1.9.1 | BSD-3-Clause（`smol-toml/LICENSE`） | npm `smol-toml` |

`vditor/` 只保留了用到的部分：编辑器本体、Lute、中英文语言包、图标、KaTeX（仅 woff2 字体）、
highlight.js（github 浅色 / 深色样式）、内容主题。Mermaid、ECharts、MathJax 等未包含；
正文里出现这些图表代码块时只是不渲染，不影响编辑和保存。
