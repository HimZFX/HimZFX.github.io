# 个人主页编辑指南

这份文档是你编辑个人主页时的对照手册。网站基于 **Hugo**（一个静态网站生成器）+ **PaperMod** 主题，托管在 GitHub Pages 上。

---

## 目录

1. [项目结构总览](#1-项目结构总览)
2. [日常操作：本地预览与发布](#2-日常操作本地预览与发布)
3. [写博客文章（最常用）](#3-写博客文章最常用)
4. [双语页面编辑要点](#4-双语页面编辑要点)
5. [编辑各个页面的方法](#5-编辑各个页面的方法)
6. [配置文件 hugo.toml 速查](#6-配置文件-hugotoml-速查)
7. [上传文件（PDF、图片等）](#7-上传文件pdf图片等)
8. [数学公式写法](#8-数学公式写法)
9. [背景动画相关](#9-背景动画相关)
10. [常见问题排查](#10-常见问题排查)

---

## 1. 项目结构总览

```
mysite/
├── hugo.toml              ← 网站总配置（改标题、菜单、社交链接都在这）
├── new_post.py            ← Python 脚本：一键创建双语文章
├── content/               ← ★ 你最常编辑的地方：所有页面内容
│   ├── about.md           ← "关于我"中文版
│   ├── about.en.md        ← "关于我"英文版
│   ├── posts/             ← 博客文章目录
│   │   ├── xxx.md         ← 某篇文章的中文版
│   │   └── xxx.en.md      ← 某篇文章的英文版
│   ├── research/          ← 科研页面
│   │   ├── _index.md      ← 科研页中文版
│   │   └── _index.en.md   ← 科研页英文版
│   └── courses/           ← 课程资料页面
│       ├── _index.md      ← 课程资料中文版
│       └── _index.en.md   ← 课程资料英文版
├── static/                ← 静态资源（图片、PDF、CSS）
│   ├── avatar.jpg         ← 你的头像
│   ├── favicon.jpg        ← 浏览器标签页小图标
│   ├── css/gallery.css    ← 图片画廊样式
│   └── documents/         ← 存放 PDF 等文件
├── layouts/               ← 页面模板（一般不需要动）
│   ├── partials/
│   │   ├── extend_head.html    ← 自定义 <head> 内容（KaTeX、节日图标等）
│   │   ├── extend_footer.html  ← 自定义页脚（背景动画）
│   │   └── bg_core.html        ← 背景动画引擎
│   └── shortcodes/
│       └── gallery.html        ← 图片画廊短代码
├── themes/PaperMod/       ← 主题文件（不要直接改里面的东西）
├── archetypes/default.md  ← 新文章的模板
└── .github/workflows/     ← GitHub Actions 自动部署配置
```

### 核心原则

- **写内容** → 编辑 `content/` 下的 `.md` 文件
- **改配置** → 编辑根目录的 `hugo.toml`
- **放文件** → 放到 `static/` 目录下
- **不要动** → `themes/` 目录（改了会在主题更新时丢失）

---

## 2. 日常操作：本地预览与发布

### 本地预览（写完先看看效果）

在终端中 `cd` 到项目目录，然后运行：

```bash
hugo server -D
```

- `-D` 表示也显示 `draft: true` 的草稿文章
- 打开浏览器访问 http://localhost:1313 即可看到效果
- **实时刷新**：你保存文件后，浏览器会自动更新，不需要重启
- 按 `Ctrl+C` 停止

### 发布到 GitHub Pages

```bash
git add .
git commit -m "描述你改了什么"
git push
```

推送到 GitHub 后，GitHub Actions 会自动构建并部署。大约等 1-2 分钟，刷新 https://HimZFX.github.io/ 即可看到更新。

---

## 3. 写博客文章（最常用）

### 方法一：用 Python 脚本（推荐，自动创建双语文件）

```bash
python new_post.py my-slug "中文标题" "English Title"
```

例如：

```bash
python new_post.py dark-galaxy "暗星系中的中性氢" "Neutral Hydrogen in Dark Galaxies"
```

会自动创建：
- `content/posts/dark-galaxy.md`（中文版）
- `content/posts/dark-galaxy.en.md`（英文版）

然后分别编辑这两个文件的正文内容即可。

### 方法二：手动创建

**第一步：创建中文版** `content/posts/文章名.md`

```markdown
---
title: "你的中文标题"
date: 2026-06-04T10:00:00+08:00
draft: true
categories: ["博客"]
tags: ["标签1", "标签2"]
math: false
---

正文内容写在这里...
```

**第二步：创建英文版** `content/posts/文章名.en.md`

```markdown
---
title: "Your English Title"
date: 2026-06-04T10:00:00+08:00
draft: true
categories: ["Blog"]
tags: ["tag1", "tag2"]
math: false
---

English content goes here...
```

### 关键规则

| 规则 | 说明 |
|------|------|
| 文件名 | 中英文版的**文件名相同**，英文版只是多了 `.en` 后缀 |
| `draft: true` | 草稿状态，本地预览看得到，发布后看不到 |
| `draft: false` | **发布状态**，写完确认无误后改成 false |
| `date` | 两个文件的日期要一致 |
| `math: true` | 如果文章里有数学公式，设为 true |

### 文章命名建议

用英文小写 + 连字符，例如：
- `dark-galaxy-research.md` ✓
- `我的研究.md` ✗（中文文件名可能导致 URL 问题）

---

## 4. 双语页面编辑要点

你的网站默认语言是中文。Hugo 靠**文件名后缀**区分语言：

| 文件 | 语言 | 说明 |
|------|------|------|
| `xxx.md` | 中文 | 无后缀 = 默认语言（中文）|
| `xxx.en.md` | English | `.en` 后缀 = 英文版 |

### 三种页面类型的双语写法

**1. 普通页面（about、单篇文章）**

```
content/
├── about.md        ← 中文"关于我"
└── about.en.md     ← English "About Me"
```

**2. 博客文章**

```
content/posts/
├── my-post.md      ← 中文版
└── my-post.en.md   ← 英文版
```

**3. 列表页面（科研、课程资料等 section）**

列表页面必须用 `_index.md` 这个特殊文件名：

```
content/research/
├── _index.md       ← 中文版列表页
└── _index.en.md    ← 英文版列表页
```

> 注意：`_index.md` 前面有下划线，这是 Hugo 的规定。普通文章不要用这个名字。

### 省事技巧

如果某篇文章你暂时不想写英文版，可以只创建 `.md` 文件。英文页面虽然不会显示这篇文章，但网站不会报错。等以后有空了再补 `.en.md` 文件。

---

## 5. 编辑各个页面的方法

### 首页（Profile 模式）

首页不是一个 `.md` 文件，而是在 `hugo.toml` 里配置的：

```toml
[params.profileMode]
    enabled = true
    title = "Zhong Fangxiong"                           # 你的名字
    subtitle = "Peking University | Physics & ..."       # 一行简介
    imageUrl = "avatar.jpg"                              # 头像文件名（放在 static/ 下）
```

**换头像**：把新图片放到 `static/` 下，然后改 `imageUrl` 的值。

**改首页按钮**：

```toml
[[params.profileMode.buttons]]
    name = "My Research"          # 按钮文字
    url = "/research/"            # 点击跳转的地址
```

### "关于我"页面

- 中文：编辑 `content/about.md`
- 英文：编辑 `content/about.en.md`

### 科研页面

- 中文：编辑 `content/research/_index.md`
- 英文：编辑 `content/research/_index.en.md`

### 课程资料页面

- 中文：编辑 `content/courses/_index.md`
- 英文：编辑 `content/courses/_index.en.md`

### 导航菜单

菜单在 `hugo.toml` 的 `[languages]` 部分配置。如果要**新增一个菜单项**，中英文都要加：

```toml
# 中文菜单
[[languages.zh.menu.main]]
    name = "新页面"
    url = "/new-section/"
    weight = 5            # 数字越小越靠左

# 英文菜单
[[languages.en.menu.main]]
    name = "New Page"
    url = "/new-section/"
    weight = 5
```

然后在 `content/new-section/` 下创建 `_index.md` 和 `_index.en.md`。

---

## 6. 配置文件 hugo.toml 速查

这个文件是 TOML 格式，语法要点：
- 字符串用引号包裹：`title = "Hello"`
- 布尔值不加引号：`math = true`
- 注释用 `#`

### 常改的地方

| 想改什么 | 改哪里 |
|----------|--------|
| 网站标题 | `title = "HimZFX's Lab"` |
| 首页名字/简介 | `[params.profileMode]` 下的 `title` 和 `subtitle` |
| 头像 | `imageUrl = "avatar.jpg"` （图片放 `static/` 下）|
| 社交链接 | `[[params.socialIcons]]` 部分 |
| 导航菜单 | `[languages.zh.menu]` 和 `[languages.en.menu]` |
| 首页按钮 | `[[params.profileMode.buttons]]` |

### 添加社交链接

```toml
[[params.socialIcons]]
    name = "linkedin"                     # 图标名（PaperMod 支持的图标列表见主题文档）
    url = "https://linkedin.com/in/xxx"
```

PaperMod 支持的社交图标名：`github`, `email`, `linkedin`, `twitter`, `facebook`, `instagram`, `youtube`, `orcid`, `googlescholar` 等。

---

## 7. 上传文件（PDF、图片等）

### 放置位置

所有静态文件放在 `static/` 目录下。`static/` 下的文件在网站中可以直接通过根路径访问：

```
static/documents/my-paper.pdf  →  网址：/documents/my-paper.pdf
static/images/photo.jpg        →  网址：/images/photo.jpg
```

### 在文章中引用

```markdown
<!-- 链接到 PDF -->
[下载我的论文](/documents/my-paper.pdf)

<!-- 插入图片 -->
![图片说明](/images/photo.jpg)
```

### 用画廊展示多张图片

在文章中使用 gallery 短代码：

```markdown
{{</* gallery "/images/photo1.jpg" "/images/photo2.jpg" "/images/photo3.jpg" */>}}
```

---

## 8. 数学公式写法

网站已配置 KaTeX 支持。在需要公式的文章中，确保 frontmatter 里有 `math: true`。

### 行内公式

```markdown
爱因斯坦的质能方程 $E = mc^2$ 是物理学最著名的公式。
```

### 独立公式块

```markdown
$$
R_{\mu\nu} - \frac{1}{2}R g_{\mu\nu} = \frac{8\pi G}{c^4} T_{\mu\nu}
$$
```

### 常用语法速查

| 想写的 | LaTeX 代码 | 效果 |
|--------|-----------|------|
| 分数 | `\frac{a}{b}` | a/b |
| 上标 | `x^2` | x² |
| 下标 | `x_i` | xᵢ |
| 求和 | `\sum_{i=1}^{n}` | Σ |
| 积分 | `\int_0^{\infty}` | ∫ |
| 希腊字母 | `\alpha, \beta, \gamma` | α, β, γ |
| 矢量 | `\vec{v}` | v→ |
| 矩阵 | `\begin{pmatrix} a & b \\ c & d \end{pmatrix}` | 2x2矩阵 |

---

## 9. 背景动画相关

首页的三体运动背景动画代码在 `layouts/partials/extend_footer.html` 中。

### 调参数

打开 `extend_footer.html`，找到这些参数可以调整效果：

```javascript
STAR_COUNT: 3,         // 星体数量
G: 0.5,                // 引力常数（越大吸引越强）
TRAIL_LENGTH: 600,     // 拖尾长度
ROTATION_SPEED: 0.001, // 镜头旋转速度
```

### 关闭动画

动画默认只在首页显示。页面左下角有一个小按钮可以手动开关。

---

## 10. 常见问题排查

### "我改了文件但网页没更新"

1. **本地预览**：确认 `hugo server -D` 在运行，保存文件后等几秒
2. **线上发布**：确认已经 `git push`，等 1-2 分钟 GitHub Actions 构建完成
3. **浏览器缓存**：按 `Cmd+Shift+R`（Mac）强制刷新

### "文章发布后看不到"

检查文章 frontmatter 中的 `draft` 字段：

```yaml
draft: false   # ← 必须是 false 才会在线上显示
```

### "英文版页面是空白的"

确认对应的 `.en.md` 文件存在且 `draft: false`。

### "数学公式没渲染"

确认文章 frontmatter 中有 `math: true`。

### "hugo server 报错"

常见原因：
- TOML 语法错误（漏了引号、多了逗号）—— 看报错信息中的行号
- 文件名拼写错误

### "图片/PDF 显示不出来"

- 确认文件放在 `static/` 目录下
- 路径以 `/` 开头，例如 `/documents/file.pdf` 而不是 `documents/file.pdf`

---

## 附录：完整工作流示例

**场景：写一篇新的双语博客文章**

```bash
# 1. 创建双语文件
python new_post.py neutron-star "中子星的内部结构" "Internal Structure of Neutron Stars"

# 2. 编辑中文版
#    打开 content/posts/neutron-star.md，写中文内容

# 3. 编辑英文版
#    打开 content/posts/neutron-star.en.md，写英文内容

# 4. 本地预览
hugo server -D

# 5. 确认没问题后，把两个文件的 draft: true 改成 draft: false

# 6. 发布
git add content/posts/neutron-star.md content/posts/neutron-star.en.md
git commit -m "add: neutron star blog post"
git push
```

**场景：更新"关于我"页面**

```bash
# 1. 编辑中文版
#    打开 content/about.md，修改内容

# 2. 编辑英文版
#    打开 content/about.en.md，同步修改英文内容

# 3. 本地预览确认
hugo server -D

# 4. 发布
git add content/about.md content/about.en.md
git commit -m "update about page"
git push
```

**场景：在导航栏新增一个"项目"页面**

```bash
# 1. 在 hugo.toml 中添加菜单项（中英文都要加，参考第 5 节）

# 2. 创建内容文件
mkdir -p content/projects
# 创建 content/projects/_index.md （中文版）
# 创建 content/projects/_index.en.md （英文版）

# 3. 预览 → 发布（同上）
```
