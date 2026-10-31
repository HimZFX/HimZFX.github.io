# 个人主页编辑指南

这份文档是编辑个人主页时的对照手册。网站基于 **Hugo**（静态网站生成器）+ **PaperMod** 主题，托管在 GitHub Pages 上。

> **最重要的一条**：一个页面只写一份 `xxx.md`，中英文站就都会显示它；
> 只有当你另外写了 `xxx.en.md`（或 `xxx.zh.md`）时，对应语言才会换成专属版本。
> 详见第 3 节。

---

## 目录

1. [项目结构总览](#1-项目结构总览)
2. [日常操作：本地预览与发布](#2-日常操作本地预览与发布)
3. [★ 双语机制](#3--双语机制)
4. [写博客文章](#4-写博客文章)
5. [编辑各个页面](#5-编辑各个页面)
6. [导航菜单](#6-导航菜单)
7. [配置文件速查](#7-配置文件速查)
8. [上传文件（PDF、图片等）](#8-上传文件pdf图片等)
9. [数学公式](#9-数学公式)
10. [背景动画](#10-背景动画)
11. [评论区](#11-评论区)
12. [扩展：添加新功能](#12-扩展添加新功能)
13. [常见问题排查](#13-常见问题排查)

---

## 1. 项目结构总览

```
├── config/_default/          ← 网站配置（按用途拆分，Hugo 自动合并）
│   ├── hugo.toml             ← 网址、标题、主题、默认语言
│   ├── languages.toml        ← 语言列表，以及各语言的差异项
│   ├── module.toml           ← ★ 双语共享机制（一般不用改）
│   ├── params.toml           ← 首页、社交链接、背景动画、评论、节日图标等参数
│   └── markup.toml           ← Markdown 与数学公式渲染
├── content/                  ← ★ 最常编辑的地方：所有页面内容
│   ├── about.md / about.en.md
│   ├── posts/                ← 博客
│   │   ├── _index.md         ← 博客列表页（含菜单项）
│   │   ├── xxx.md            ← 某篇文章（共用版本）
│   │   └── xxx.en.md         ← 该文章的英文专属版本（可选）
│   ├── research/_index.md    ← 科研页
│   └── courses/_index.md     ← 课程资料页
├── static/                   ← 原样发布的文件（头像、PDF、图片）
├── assets/                   ← 会被 Hugo 处理（打包、压缩）的资源
│   ├── css/extended/         ← 自定义 CSS，自动并入主题样式表
│   └── js/background/        ← 背景动画：core.js 引擎 + effects/ 各效果
├── layouts/                  ← 页面模板（一般不需要动）
│   ├── partials/
│   │   ├── extend_head.html  ← PaperMod 钩子，只负责引入下面的功能
│   │   ├── extend_footer.html← PaperMod 钩子（目前为空，见第 12 节的注意事项）
│   │   ├── comments.html     ← PaperMod 钩子，引入评论区
│   │   └── features/         ← 每个功能一个文件：math / background / giscus / holiday-favicon
│   └── shortcodes/gallery.html ← 图片画廊短代码
├── archetypes/default.md     ← `hugo new` 的文章模板
├── new_post.py               ← 新建文章 / 补翻译 / 查看双语状态
└── themes/PaperMod/          ← 主题（git 子模块，不要直接改）
```

### 核心原则

| 想做什么 | 去哪里 |
|---|---|
| 写内容 | `content/` 下的 `.md` 文件 |
| 改设置 | `config/_default/` 下对应的文件 |
| 放文件 | `static/` |
| 改样式 | `assets/css/extended/` 下新建或编辑 `.css` |
| 不要动 | `themes/`（主题更新时会被覆盖） |

---

## 2. 日常操作：本地预览与发布

### 首次克隆

主题是 git 子模块，克隆后需要拉取一次：

```bash
git submodule update --init --recursive
```

### 本地预览

```bash
hugo server -D
```

- `-D` 表示也显示 `draft: true` 的草稿
- 浏览器访问 http://localhost:1313 ，英文站在 http://localhost:1313/en/
- 保存文件后浏览器自动刷新；按 `Ctrl+C` 停止

### 发布

```bash
git add .
git commit -m "描述你改了什么"
git push
```

推送到 `main` 分支后，GitHub Actions 会自动构建并部署，大约 1–2 分钟后生效。

---

## 3. ★ 双语机制

网站有中文站（`/`）和英文站（`/en/`）。Hugo 靠**文件名后缀**决定一个文件属于哪种语言：

| 文件 | 含义 | 中文站显示 | 英文站显示 |
|---|---|---|---|
| `xxx.md` | **共用版本** | ✅ | ✅ |
| `xxx.en.md` | 英文专属版本 | — | ✅（替换共用版本） |
| `xxx.zh.md` | 中文专属版本 | ✅（替换共用版本） | — |

规则只有一句话：**某个语言有专属版本就用专属版本，没有就用共用版本。**

### 常见场景

| 你写了哪些文件 | 中文站 | 英文站 |
|---|---|---|
| 只有 `xxx.md`（中文写的） | `xxx.md` | `xxx.md`（显示中文内容） |
| 只有 `xxx.md`（英文写的） | `xxx.md`（显示英文内容） | `xxx.md` |
| `xxx.md` + `xxx.en.md` | `xxx.md` | `xxx.en.md` |
| `xxx.md` + `xxx.zh.md` | `xxx.zh.md` | `xxx.md` |
| 只有 `xxx.en.md` | 没有这一页 | `xxx.en.md` |

所以：

- **精力有限时**：只写一份 `xxx.md`，用哪种语言写都行，两个站点都会有。
- **以后有空补翻译**：再加一个 `xxx.en.md`（或 `xxx.zh.md`），对应站点自动换成新版本，另一个站点不受影响。两个版本自动互为翻译：文章信息栏里的「翻译」链接、搜索引擎用的 hreflang 都会指向对方。（顶栏的语言切换按钮是 PaperMod 的固定行为，总是跳到另一语言的首页。）
- **只想在某个语言发布**：只写带后缀的文件，例如 `xxx.en.md`。

> 已有的 `about.md` + `about.en.md`、`_index.md` + `_index.en.md` 等文件正好符合这套规则，不需要改名。

### 三个要点

1. **专属版本是"整体替换"**，不是只替换正文。front matter（标题、日期、`menu`、`draft` 等）也要写全。用 `new_post.py --translate` 补翻译时会自动复制原文的 front matter。
2. **不要把专属版本单独设为 `draft: true`**。专属版本一旦存在，即使是草稿也会"占位"，结果是该语言站点上这篇会**消失**，而不是退回显示共用版本。翻译没写完时，要么先别把文件放进 `content/`，要么直接以"英文标题 + 原文"的状态发布（效果和没有专属版本时差不多）。
3. **文件名（slug）要一致**：`dark-galaxy.md` 和 `dark-galaxy.en.md` 才是同一篇。

### 查看双语状态

```bash
python new_post.py --status
```

会列出每个页面在中文站、英文站分别显示的是哪个文件，并提示上面第 2 点那种"草稿占位"的情况。

### 它是怎么实现的

`config/_default/module.toml` 把同一个 `content/` 目录同时挂载给中文和英文：不带后缀的文件在两种语言下各出现一次；带后缀的文件只属于对应语言，并且 Hugo 总是让它优先于共用文件。这完全是 Hugo 的原生行为，没有自定义模板逻辑，所以列表页、RSS、sitemap、hreflang、翻译链接都天然正确。

以后如果要加第三种语言（比如日语）：在 `languages.toml` 里加上 `[ja]`，再在 `module.toml` 里照样加一条 `lang = "ja"` 的挂载即可。

---

## 4. 写博客文章

### 用脚本（推荐）

```bash
# 只写一份，中英文站都显示（最省事）
python new_post.py dark-galaxy "暗星系中的中性氢"

# 同时建中英两个版本
python new_post.py dark-galaxy "暗星系中的中性氢" "Neutral Hydrogen in Dark Galaxies"

# 以后给已有文章补英文版（复制原文作为翻译底稿，只改标题）
python new_post.py dark-galaxy --translate en "Neutral Hydrogen in Dark Galaxies"

# 如果原文是用英文写的，想补一份中文版
python new_post.py dark-galaxy --translate zh "暗星系中的中性氢"
```

加 `--section <目录>` 可以在 `posts` 以外的栏目操作，例如 `--section research`。

新文章默认是 `draft: true`（草稿），写完后改成 `draft: false` 才会发布。

### 手动创建

在 `content/posts/` 下新建 `文章名.md`：

```markdown
---
title: "你的标题"
date: 2026-06-04T10:00:00+08:00
draft: true
categories: []
tags: ["标签1", "标签2"]
---

正文内容……
```

### front matter 常用字段

| 字段 | 说明 |
|---|---|
| `draft: true / false` | 草稿只在本地 `hugo server -D` 可见；`false` 才会发布 |
| `math: false` | 本页没有公式时关闭 KaTeX（全站默认开启） |
| `comments: true` | 开启评论区（全站默认关闭） |
| `background: { effect: lorenz }` | 本页换一种背景动画（见第 10 节） |

文件名建议用英文小写 + 连字符：`dark-galaxy-research.md` ✓，`我的研究.md` ✗。

---

## 5. 编辑各个页面

### 首页（Profile 模式）

首页不是 `.md` 文件，而是在 `config/_default/params.toml` 的 `[profileMode]` 里配置：名字、简介、头像、按钮。

- **换头像**：把图片放到 `static/`，修改 `imageUrl`
- **按钮链接**：站内页面写成**不以 `/` 开头**的相对路径（如 `"research/"`），这样中文首页跳到 `/research/`，英文首页自动跳到 `/en/research/`
- **中英文首页想显示不同的简介**：在 `languages.toml` 里覆盖，例如

  ```toml
  [en.params.profileMode]
    subtitle = "Peking University | ..."
  ```

  只写要改的项，其余自动沿用 `params.toml`。

### 其他页面

| 页面 | 文件 |
|---|---|
| 关于我 | `content/about.md`（英文：`about.en.md`） |
| 科研 | `content/research/_index.md`（英文：`_index.en.md`） |
| 课程资料 | `content/courses/_index.md`（英文：`_index.en.md`） |
| 博客列表页 | `content/posts/_index.md`（英文：`_index.en.md`） |

列表页（栏目首页）必须叫 `_index.md`，前面有下划线；普通文章不要用这个名字。

想让某个页面中英文共用？删掉它的 `.en.md` 即可，英文站会自动显示共用版本。

---

## 6. 导航菜单

菜单项写在**页面自己的 front matter** 里，而不是配置文件：

```yaml
---
title: "科研"
menu:
  main:
    weight: 20     # 顺序：数字越小越靠左
---
```

- 菜单显示的名字 = 页面的 `linkTitle`（没写就用 `title`）。例如 `about.md` 的标题是"关于我"，但用 `linkTitle: "关于"` 让菜单里显示"关于"。
- 因为菜单跟着页面走，所以它也遵守双语机制：共用页面会同时出现在中英文菜单里，有专属版本时各用各的名字，链接自动指向对应语言。

当前顺序：关于 10、科研 20、博客 30、课程资料 40。

### 新增一个栏目（例如"项目"）

只需要一个文件 `content/projects/_index.md`：

```yaml
---
title: "项目"
menu:
  main:
    weight: 35
---
```

中英文站的导航栏都会出现它。以后想让英文菜单显示 "Projects"，再加一个 `content/projects/_index.en.md`（`title: "Projects"`，同样带上 `menu`）。

---

## 7. 配置文件速查

所有配置在 `config/_default/` 下，TOML 语法要点：字符串加引号，布尔值不加，注释用 `#`。

> ⚠ TOML 里写在某个 `[表头]` 之后的键都属于那张表。所以 `params.toml` 顶部的全局开关（`math`、`comments` 等）必须放在第一个 `[表头]` 之前。

| 想改什么 | 文件 | 位置 |
|---|---|---|
| 网站标题、网址 | `hugo.toml` | `title`、`baseURL` |
| 默认语言 | `hugo.toml` | `defaultContentLanguage` |
| 语言名称、顺序 | `languages.toml` | `[zh]`、`[en]` |
| 某个语言的参数差异 | `languages.toml` | `[en.params.xxx]` |
| 首页名字 / 简介 / 头像 / 按钮 | `params.toml` | `[profileMode]` |
| 社交链接 | `params.toml` | `[[socialIcons]]` |
| 背景动画 | `params.toml` | `[background]` |
| 评论区 | `params.toml` | `comments`、`[giscus]` |
| 节日图标 | `params.toml` | `[holidayFavicon]` |
| 导航菜单 | 各页面 front matter | 见第 6 节 |

### 添加社交链接

```toml
[[socialIcons]]
  name = "linkedin"
  url = "https://linkedin.com/in/xxx"
```

PaperMod 支持的图标名：`github`、`email`、`linkedin`、`twitter`、`facebook`、`instagram`、`youtube`、`orcid`、`googlescholar` 等。

### 节日图标

在指定日期把浏览器标签页图标换成 emoji，规则全在 `params.toml` 里：

```toml
[holidayFavicon]
  enabled = true
  rules = [
    { emoji = "🎂", from = "01-22", to = "01-22" },
    { emoji = "🎄", from = "12-20", to = "12-31" },
  ]
```

日期格式 `MM-DD`，首尾都包含；`from` 晚于 `to` 表示跨年（如 `12-25` 到 `01-05`）。按顺序匹配，第一条命中的生效。

---

## 8. 上传文件（PDF、图片等）

`static/` 下的文件按原路径发布：

```
static/documents/my-paper.pdf  →  /documents/my-paper.pdf
static/images/photo.jpg        →  /images/photo.jpg
```

在文章中引用（路径以 `/` 开头，中英文站通用）：

```markdown
[下载我的论文](/documents/my-paper.pdf)
![图片说明](/images/photo.jpg)
```

### 图片画廊

```markdown
{{</* gallery "/images/photo1.jpg" "/images/photo2.jpg" "/images/photo3.jpg" */>}}
```

样式在 `assets/css/extended/gallery.css`。

---

## 9. 数学公式

网站使用 KaTeX，**全站默认开启**。确定某页没有公式时，可以在 front matter 写 `math: false` 少加载一些资源。

公式内容会被原样交给 KaTeX，不会被 Markdown 误处理（例如矩阵换行的 `\\`、下标的 `_` 都能正常使用）。

```markdown
行内公式：$E = mc^2$，或 \(E = mc^2\)

独立公式：
$$
R_{\mu\nu} - \frac{1}{2}R g_{\mu\nu} = \frac{8\pi G}{c^4} T_{\mu\nu}
$$
```

| 想写的 | LaTeX 代码 |
|---|---|
| 分数 | `\frac{a}{b}` |
| 上 / 下标 | `x^2`、`x_i` |
| 求和 / 积分 | `\sum_{i=1}^{n}`、`\int_0^{\infty}` |
| 希腊字母 | `\alpha, \beta, \gamma` |
| 矢量 | `\vec{v}` |
| 矩阵 | `\begin{pmatrix} a & b \\ c & d \end{pmatrix}` |

---

## 10. 背景动画

背景动画由一个"游戏机"加若干"卡带"组成：

- `assets/js/background/core.js`：引擎，负责画布、动画循环、深浅色检测、左下角开关按钮
- `assets/js/background/effects/*.js`：效果（卡带），只负责怎么动、怎么画

构建时只打包选中的那一个效果，其他效果不会被加载。

### 切换效果

修改 `params.toml`：

```toml
[background]
  enabled = true
  effect = "three-body"   # three-body 三体运动 | lorenz 洛伦兹吸引子 | flow-field 流场粒子
  autoplay = "home"       # home 仅首页自动播放 | all 所有页面 | none 不自动播放
```

单个页面也可以覆盖：

```yaml
background:
  effect: lorenz      # 本页换效果
  # enabled: false    # 或者本页关闭
```

效果名写错时，构建会报错并列出所有可用的效果。

### 调参数

每个效果文件顶部都是参数区，例如 `effects/three-body.js`：

```javascript
STAR_COUNT: 3,         // 星体数量
G: 0.5,                // 引力常数
TRAIL_LENGTH: 600,     // 拖尾长度
ROTATION_SPEED: 0.001, // 镜头旋转速度
```

### 新增一个效果

在 `effects/` 下新建 `my-effect.js`：

```javascript
window.BG_System.loadCassette({
    onInit(width, height) { /* 初始化 */ },
    onResize(width, height) { /* 窗口尺寸变化 */ },
    onUpdate(isDark) { /* 每帧：更新状态 */ },
    onDraw(ctx, width, height, isDark) { /* 每帧：绘制 */ },
    // keepTrails: true,  // 不每帧清屏，自己做拖尾淡出（参考 lorenz.js）
});
```

然后把 `effect` 改成 `"my-effect"`。完整接口说明见 `core.js` 顶部注释。

---

## 11. 评论区

基于 giscus（GitHub Discussions）。全站默认关闭，在需要评论的文章 front matter 里写 `comments: true`。

仓库、分类等 ID 在 `params.toml` 的 `[giscus]` 中配置：

- `lang`：评论区界面语言，中文站 `zh-CN`，英文站在 `languages.toml` 中覆盖为 `en`
- `sharedThread = true`：同一篇文章的中英文页面**共用一个评论区**（推荐）；设为 `false` 则按网址区分，中英文各自独立

---

## 12. 扩展：添加新功能

自定义功能都按同一个模式组织：

1. 在 `layouts/partials/features/` 下新建一个 partial，例如 `analytics.html`
2. 在 `layouts/partials/extend_head.html` 里加一行 `{{- partial "features/analytics.html" . -}}`
3. 需要配置项就加在 `params.toml` 里，模板中用 `site.Params.xxx` 读取；需要允许页面覆盖就用 `.Param "xxx"`

> ⚠ **不要把按页面变化的内容放进 `extend_footer.html`**。PaperMod 会缓存整个页脚，缓存只区分页面类型，不区分具体页面，所以页脚里依赖 `.Param`、`.Title`、front matter 的内容会随机"串页"。需要在页面底部执行的脚本，放到 `extend_head.html` 并加 `defer` 即可。

自定义样式直接在 `assets/css/extended/` 下新建 `.css` 文件，会被自动打包，无需手动引用。

---

## 13. 常见问题排查

### 改了文件但网页没更新

1. 本地：确认 `hugo server -D` 在运行
2. 线上：确认已 `git push`，在 GitHub 仓库的 Actions 页查看构建是否成功
3. 浏览器缓存：`Cmd+Shift+R`（Mac）强制刷新

### 文章发布后看不到

检查 front matter 中的 `draft: false`。

### 英文站某篇文章不见了 / 某个页面只有一个语言有

运行 `python new_post.py --status` 查看。常见原因：

- 该文章的 `.en.md` 是 `draft: true`（见第 3 节要点 2）
- 文章只有带后缀的文件（如只有 `xxx.zh.md`），想让两边都显示，把它改名为 `xxx.md`

### 英文站某个菜单项不见了

该页面的 `.en.md` 里没有写 `menu`。专属版本会整体替换共用版本，`menu` 也要写上。

### 数学公式没渲染

确认该页没有写 `math: false`；检查公式分隔符是否成对。

### `hugo server` 报错

- TOML 语法错误（漏了引号、多了逗号）——看报错中的文件名和行号
- `themes/PaperMod` 是空的——运行 `git submodule update --init --recursive`

### 图片 / PDF 显示不出来

- 确认文件在 `static/` 下
- 路径以 `/` 开头：`/documents/file.pdf`，而不是 `documents/file.pdf`
