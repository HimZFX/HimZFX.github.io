# 个人主页编辑指南

这份文档是编辑个人主页时的对照手册。网站基于 **Hugo**（静态网站生成器）+ **PaperMod** 主题，托管在 GitHub Pages 上。

> **最重要的一条**：一个页面只写一份 `xxx.md`，中英文站就都会显示它；
> 只有当你另外写了 `xxx.en.md`（或 `xxx.zh.md`）时，对应语言才会换成专属版本。
> 详见第 4 节。
>
> **不想碰命令行？** 用网页版管理后台 https://himzfx.github.io/admin/ ，手机上也能发文章、换头像，见第 3 节。

---

## 目录

1. [项目结构总览](#1-项目结构总览)
2. [日常操作：本地预览与发布](#2-日常操作本地预览与发布)
3. [管理后台（网页版）](#3-管理后台网页版)
4. [★ 双语机制](#4--双语机制)
5. [写博客文章](#5-写博客文章)
6. [编辑各个页面](#6-编辑各个页面)
7. [导航菜单](#7-导航菜单)
8. [配置文件速查](#8-配置文件速查)
9. [上传文件（PDF、图片等）](#9-上传文件pdf图片等)
10. [数学公式](#10-数学公式)
11. [背景动画](#11-背景动画)
12. [评论区](#12-评论区)
13. [扩展：添加新功能](#13-扩展添加新功能)
14. [常见问题排查](#14-常见问题排查)

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
│   └── admin/                ← 网页版管理后台（第 3 节），发布在 /admin/
├── assets/                   ← 会被 Hugo 处理（打包、压缩）的资源
│   ├── css/extended/         ← 自定义 CSS，自动并入主题样式表
│   └── js/background/        ← 背景动画：core.js 引擎 + effects/ 各效果
├── layouts/                  ← 页面模板（一般不需要动）
│   ├── partials/
│   │   ├── extend_head.html  ← PaperMod 钩子，只负责引入下面的功能
│   │   ├── extend_footer.html← PaperMod 钩子（目前为空，见第 13 节的注意事项）
│   │   ├── comments.html     ← PaperMod 钩子，引入评论区
│   │   └── features/         ← 每个功能一个文件：math / background / giscus / holiday-favicon
│   └── shortcodes/gallery.html ← 图片画廊短代码
├── archetypes/default.md     ← `hugo new` 的文章模板
├── new_post.py               ← 新建文章 / 补翻译 / 查看双语状态
├── docs/admin-architecture.md← 管理后台的技术说明（维护者看）
├── tests/admin/              ← 管理后台的自动化测试（不会发布到网站）
└── themes/PaperMod/          ← 主题（git 子模块，不要直接改）
```

### 核心原则

| 想做什么 | 去哪里 |
|---|---|
| 写内容 | `content/` 下的 `.md` 文件 |
| 改设置 | `config/_default/` 下对应的文件 |
| 放文件 | `static/` |
| 改样式 | `assets/css/extended/` 下新建或编辑 `.css` |
| 不想用命令行 | 网页版管理后台 https://himzfx.github.io/admin/ （第 3 节） |
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

> 用管理后台（第 3 节）发布时，它会替你完成"提交 + 推送"这一步，效果和上面一样。
> 两种方式可以混着用：在电脑上 `git push` 之前先 `git pull`，把后台发布的修改拉下来。

---

## 3. 管理后台（网页版）

管理后台是放在网站里的一个网页：**https://himzfx.github.io/admin/** 。在浏览器（电脑或手机）里打开它，就能写文章、换头像、换背景动画、上传资料，不用装任何软件，也不用命令行。

它的原理很简单：你在网页上改完点「发表」或「保存并发布」，后台会用你的 GitHub 令牌把修改直接提交到仓库的 `main` 分支——和你自己 `git push` 完全一样，之后 GitHub Actions 自动部署。

### 第一次使用：创建令牌（只需做一次）

后台用 GitHub 的**细粒度个人访问令牌**（fine-grained personal access token）登录。登录页右侧也有同样的 5 步说明。

1. 打开 https://github.com/settings/personal-access-tokens/new （登录页上的「打开创建页面」按钮也是这个地址）。
2. **Token name**：随便填，例如「主页管理」。
3. **Expiration**（有效期）：建议设为 **1 年**左右（选 `Custom`，填一年后的日期）。到期后后台会提示令牌已过期 / 已失效，到 GitHub 的令牌页面点 `Regenerate token`（或按这几步重新建一个），把新令牌粘贴进去即可。可以在日历里记一下到期日。
4. **Repository access**：选 `Only select repositories`，然后**只勾选** `HimZFX/HimZFX.github.io`。
5. **Repository permissions**（新版页面是点 `Add permissions` 搜索添加）：
   - `Contents` → `Read and write`（必需，用来发布）
   - `Actions` → `Read-only`（可选，用来在后台显示「部署中 / 已上线」）
   - `Metadata: Read-only` 会自动加上，是必需的，保持不动
6. 点 `Generate token`，**复制**生成的令牌（以 `github_pat_` 开头，只显示这一次）。

### 登录与「在此设备上记住」

把令牌粘贴到登录页的「访问令牌」框里，点「登录」。

- **不勾选**「在此设备上记住」（默认）：关掉这个标签页后令牌就会从浏览器里删除，下次再粘贴一次。在别人的电脑、公用电脑上**一定不要勾选**。
- **勾选**：下次打开不用再粘贴。**只在你自己的手机 / 电脑上勾选**。
- 右上角「退出」会把令牌从这个浏览器里删除（本机自动保存的草稿会保留）。

### 界面一览

左侧（手机上是底部）有 5 个栏目：**文章 / 页面 / 首页设置 / 背景动画 / 资料**。右上角是「查看网站」和部署状态。

**文章**——写博客，体验接近微信公众号后台：

- 点「写新文章」：上面是大标题输入框，中间是所见即所得的编辑区，右侧是「文章设置」（手机上点「文章设置」展开）：文件名（网址）、日期、标签、分类、摘要、封面图、数学公式 / 评论区开关、本页背景动画。
- **文件名（网址）**决定文章地址 `/posts/<文件名>/`，只能用小写英文、数字和 `-`，**发表后就不能改了**。标题全是中文时会自动生成 `post-日期`，后台会提示你改成英文或拼音。
- 底部按钮：
  - 「**发表**」：发布到网站。已发表的文章这个按钮叫「**更新**」。
  - 「**保存草稿**」：也会提交到 GitHub，但文章是 `draft: true`，网站上不显示。对已发表的文章，这个按钮叫「改为草稿」，点了文章会从网站上消失。
  - 「**手机预览**」：用网站自己的样式预览，可以切换浅色 / 深色；有英文专属版本时还能切换中文站 / 英文站。
  - 「⋯」（更多操作）：在网站上查看、删除此版本、删除整篇文章。
  - 快捷键 `Ctrl/⌘+S`：已发表的文章 = 更新，草稿 = 保存草稿。
- **图片**：直接粘贴、拖进编辑区，或点工具栏的「插入图片」。图片会自动压缩（最宽 1920 像素），点「发表」时和文章一起上传到 `static/images/posts/<文件名>/`。工具栏还有「带说明的图片」（图片下方带一行说明）和「多图并排」（画廊）。
- **公式**：工具栏的「插入公式」插入一个公式块；行内公式直接输入 `$...$`。写法见第 10 节。
- **资料**：工具栏的「插入资料链接」，从「资料」里选一个已有文件插入链接，或点「上传新资料…」上传新文件（随文章一起发表）。
- **自动保存**：边写边自动保存在这台设备上（底部显示「已自动保存到本机 · 时间」）。浏览器崩溃、手机切后台、不小心关掉都不怕：下次打开这篇文章时顶部会出现「发现本机未发布的修改」，点「恢复」即可；「文章」列表顶部也会列出这些「本机有未发布的修改」，点「继续编辑」。注意：本机草稿只在这台设备的浏览器里，换设备看不到。
- **文章列表**：可按「全部 / 已发表 / 草稿」筛选、按标题搜索；每行有「编辑 / 查看 / 删除」，还显示语言情况（中英共用 / 中英分开 / 仅中文……）。删除后可以在 GitHub 的提交历史里找回。

**页面**——关于、科研、课程资料这类栏目页，以及顶部导航菜单：

- 「导航栏里的页面」：改「顺序」里的数字（数字越小越靠左）或点旁边的箭头移动，最后点「**保存菜单顺序**」，一次发布。
- 「**新建栏目**」：填中文名称、英文名称（可选，填了会另外生成英文版）、网址、菜单顺序，点「创建并发布」，然后接着在编辑器里写栏目介绍。效果和第 7 节手动新建 `content/<网址>/_index.md` 相同。
- 点「编辑」打开页面，编辑方式和文章一样（右侧是「页面设置」，可以改菜单名称、菜单顺序、是否显示在顶部菜单）。

**首页设置**——对应 `params.toml` 的 `[profileMode]` 等：

- **头像**：点「更换头像」选一张照片，在「调整头像」里拖动、缩放（圆圈内是首页显示的范围），点「使用这张图片」。勾选「同时用作浏览器标签页图标」会一起更新 favicon。
- **名字与简介**：名字、简介、网站标题。下面的「**英文站单独设置**」可以给英文首页另写名字 / 简介（留空 = 与上面相同），保存在 `languages.toml` 的 `[en.params.profileMode]`。
- **首页按钮**：「添加按钮」、上移 / 下移、删除。站内页面写 `research/` 这种不以 `/` 开头的路径（两种语言会各自跳转），外部网址以 `https://` 开头。
- **社交链接**：「添加社交链接」，从下拉框选图标（GitHub、邮箱、Google Scholar、ORCID、知乎……），填链接。邮箱要写成 `mailto:me@example.com`。
- **节日图标**：「启用节日图标」开关 + 「添加节日」（emoji、开始 / 结束日期 `月-日`），规则同第 8 节。
- 右侧「首页预览」是示意图。改完点「**保存并发布**」，会先列出将修改的内容让你确认。没发布就离开也不怕：修改（包括新头像）会保存在本机，下次打开时提示「恢复」。

**背景动画**——选卡带、调参数：

- 每张卡片是一个效果（卡带），带实时小预览；标「使用中」的是网站现在用的。
- 点一张卡片，下方出现大预览，可切换「电脑 / 手机」「浅色 / 深色」，「重新开始」从头播放。满意就点「**用作网站背景**」。
- 「网站设置」：「启用背景动画」开关，「自动播放」选「仅首页 / 所有页面 / 不自动播放」。
- 「参数微调」：卡带文件顶部的数字参数（星体数量、引力常数……）变成输入框，改了大预览会自动重跑；「恢复默认」回到文件里的值。
- 点「**保存并发布**」生效。发布时只改那几个数字，文件里其他内容（包括注释）不动。

**资料**——上传 PDF、课件、图片，得到一个可以分享或写进文章的网址：

- 顶部选文件夹：「资料」（`static/documents/`，网址 `/documents/…`）、「图片」（`static/images/`）或「其他文件夹…」。
- 点「上传文件」或把文件拖进来（可以多选）。勾选「压缩图片」会把 JPG / PNG 缩小到最宽 1920 像素；PDF 等原样上传。同名文件会提示「替换」（链接不变）。
- 每个文件有「复制链接」「打开」「删除」。删除前会提示哪些文章引用了它。

### 双语在后台里怎么体现

编辑器顶部的标签页就是第 4 节的几个文件：

| 标签页 | 对应文件 | 显示在 |
|---|---|---|
| 共用版本 | `xxx.md` | 两个站点（除非某个语言有专属版本） |
| 英文专属 | `xxx.en.md` | 英文站（替换共用版本） |
| 中文专属 | `xxx.zh.md` | 中文站（替换共用版本） |

- 新文章默认只有「共用版本」，中英文站都显示——最省事。
- 想给英文站单独写一版：点标签栏上的「**单独写英文版**」，会复制当前内容作为底稿，改好后点「发表」，英文站就换成这一版。
- 不想要英文版了：切到「英文专属」，在「⋯」里点「删除此版本（英文专属）」，英文站会改回显示共用版本。
- 后台会提醒第 4 节"要点 2"那种情况：专属版本是草稿时，该语言站点上这一页会**消失**，而不是退回显示共用版本。

### 发布之后

- 发布后右上角显示「**部署中…**」，通常 1–2 分钟后变成「**已上线 ✓**」（点它打开网站）。看到旧内容时刷新一下页面。
- 「部署失败」：点它查看 GitHub Actions 的详细原因（常见的是手动改配置文件时格式写错了，见第 14 节）。
- 「已提交，约 1–2 分钟后生效」：令牌没有 Actions 权限，看不到进度，但已经发布成功了。

### 冲突：别处也改了同一个文件

如果你在编辑期间，同一个文件在另一台设备、另一个标签页或 GitHub 网页上被改过，后台**不会覆盖**它：

- 弹出「有文件在你编辑期间被修改了」：点「重新加载最新版本」读取最新内容（文章编辑器里没发布的修改会保存在本机草稿中）。
- 编辑器里会出现提示条，二选一：「保留我的修改」（再点一次「发表 / 更新」就会用你的版本覆盖）或「加载最新版本（放弃我的修改）」。
- 发布时断网也不要紧：再点一次发布即可，已经发布成功的不会重复发布。

### 限制与注意事项

- **文件大小**：单个文件 ≥ 25 MB 会提醒（上传慢、仓库变大），≥ 95 MB 拒绝上传（GitHub 的上限是 100 MB）。
- **不能改的地方**：`themes/`（主题子模块）、`static/admin/`（后台自己）。front matter 用 `+++`（TOML 格式）写的文件只能在 GitHub 上改。
- **手动编辑照常可用**：本地改文件 + `git push`、在 GitHub 网页上改都没问题。后台每次打开都读取最新内容，而且只改动你改过的那几行——配置文件和 front matter 里的注释、排版都原样保留。
- 后台只有中文界面；它本身不会被搜索引擎收录。

### 安全

- 令牌**只保存在你的浏览器里**，只会发送给 `api.github.com`，不会经过任何别的服务器，也不会出现在网址里。
- 令牌能修改网站仓库里的所有文件，请像密码一样保管，不要发给别人、不要截图。
- 勾选「在此设备上记住」时，令牌存在这个浏览器里，网站页面上加载的第三方脚本（数学公式、评论区）理论上也能读到它——所以只在自己的设备上勾选，公用 / 别人的电脑上用完点「退出」。
- **手机或电脑丢了**：立刻到 https://github.com/settings/personal-access-tokens 找到这个令牌，点 `Revoke`（撤销），然后新建一个。撤销后旧令牌立刻失效。
- 后台不能被别的网页嵌入使用（防止点击劫持）；如果看到「请直接打开管理后台」，点按钮在新标签页打开即可。

---

## 4. ★ 双语机制

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

## 5. 写博客文章

> 在网页上写更省事：管理后台的「文章」→「写新文章」，见第 3 节。下面是命令行 / 手动的做法。

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
| `background: { effect: lorenz }` | 本页换一种背景动画（见第 11 节） |

文件名建议用英文小写 + 连字符：`dark-galaxy-research.md` ✓，`我的研究.md` ✗。

---

## 6. 编辑各个页面

### 首页（Profile 模式）

首页不是 `.md` 文件，而是在 `config/_default/params.toml` 的 `[profileMode]` 里配置：名字、简介、头像、按钮。管理后台的「首页设置」改的就是这些（见第 3 节）。

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

## 7. 导航菜单

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

## 8. 配置文件速查

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
| 导航菜单 | 各页面 front matter | 见第 7 节 |

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

## 9. 上传文件（PDF、图片等）

管理后台的「资料」可以直接上传并复制链接（见第 3 节）。手动放文件时，`static/` 下的文件按原路径发布：

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

## 10. 数学公式

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

## 11. 背景动画

背景动画由一个"游戏机"加若干"卡带"组成：

- `assets/js/background/core.js`：引擎，负责画布、动画循环、深浅色检测、左下角开关按钮
- `assets/js/background/effects/*.js`：效果（卡带），只负责怎么动、怎么画

构建时只打包选中的那一个效果，其他效果不会被加载。

管理后台的「背景动画」可以预览每个效果、切换、调参数（见第 3 节）；新增效果仍然要按下面的方法写代码。

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

## 12. 评论区

基于 giscus（GitHub Discussions）。全站默认关闭，在需要评论的文章 front matter 里写 `comments: true`。

仓库、分类等 ID 在 `params.toml` 的 `[giscus]` 中配置：

- `lang`：评论区界面语言，中文站 `zh-CN`，英文站在 `languages.toml` 中覆盖为 `en`
- `sharedThread = true`：同一篇文章的中英文页面**共用一个评论区**（推荐）；设为 `false` 则按网址区分，中英文各自独立

---

## 13. 扩展：添加新功能

自定义功能都按同一个模式组织：

1. 在 `layouts/partials/features/` 下新建一个 partial，例如 `analytics.html`
2. 在 `layouts/partials/extend_head.html` 里加一行 `{{- partial "features/analytics.html" . -}}`
3. 需要配置项就加在 `params.toml` 里，模板中用 `site.Params.xxx` 读取；需要允许页面覆盖就用 `.Param "xxx"`

> ⚠ **不要把按页面变化的内容放进 `extend_footer.html`**。PaperMod 会缓存整个页脚，缓存只区分页面类型，不区分具体页面，所以页脚里依赖 `.Param`、`.Title`、front matter 的内容会随机"串页"。需要在页面底部执行的脚本，放到 `extend_head.html` 并加 `defer` 即可。

自定义样式直接在 `assets/css/extended/` 下新建 `.css` 文件，会被自动打包，无需手动引用。

---

## 14. 常见问题排查

### 改了文件但网页没更新

1. 本地：确认 `hugo server -D` 在运行
2. 线上：确认已 `git push`，在 GitHub 仓库的 Actions 页查看构建是否成功
3. 浏览器缓存：`Cmd+Shift+R`（Mac）强制刷新

### 文章发布后看不到

检查 front matter 中的 `draft: false`。

### 管理后台：发布后网站上看不到修改

1. 看右上角的部署状态：「部署中…」就再等 1–2 分钟；变成「已上线 ✓」后刷新网页（手机上可以下拉刷新）。
2. 「部署失败」：点它看 GitHub Actions 的报错，通常是某个配置文件格式写错了（见下面「`hugo server` 报错」）。
3. 文章在列表里是「草稿」：打开它点「发表」。
4. 文章日期在未来（「定时发表」）：Hugo 不会显示未来日期的文章，到了那个时间、网站再次更新时才会出现。想现在就发，把日期改成现在。
5. 只在英文站看不到：多半是有一个「英文专属」版本还是草稿（见第 4 节要点 2），编辑器顶部会有提示。
6. 新头像 / 标签页图标：GitHub Pages 有几分钟缓存，其他设备上可能要再过几分钟才显示。

### 管理后台：登录提示令牌无效 / 没有写入权限

- 「令牌不正确或已过期」：确认完整复制了令牌（`github_pat_` 开头，前后没有空格）；令牌过期了就到 https://github.com/settings/personal-access-tokens 点 `Regenerate token`，或按第 3 节新建一个。
- 「这个令牌没有写入权限」：到 GitHub 的令牌设置里检查 Repository access 是否选了 `HimZFX/HimZFX.github.io`，`Contents` 是否为 `Read and write`。改完权限令牌不用重新生成，直接再登录一次。
- 用着用着弹出「登录已失效」：令牌过期或被撤销了。这一页上没发布的修改都还在，粘贴新令牌点「继续」，再点一次发布即可。
- 一直显示「已提交，约 1–2 分钟后生效」、看不到部署进度：令牌没有 `Actions: Read-only` 权限。不影响发布，想看进度就把这个权限加上。

### 英文站某篇文章不见了 / 某个页面只有一个语言有

运行 `python new_post.py --status` 查看。常见原因：

- 该文章的 `.en.md` 是 `draft: true`（见第 4 节要点 2）
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
