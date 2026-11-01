# 管理后台技术说明（维护者文档）

> 这份文档写给以后要修改管理后台代码的人（包括未来的自己或 AI 助手）。
> 只想**使用**后台，请看 [SITE_GUIDE.md 第 3 节](../SITE_GUIDE.md#3-管理后台网页版)。

管理后台位于 `static/admin/`，Hugo 原样发布到 https://himzfx.github.io/admin/ 。它是一个纯静态网页应用：
在浏览器里用用户自己的 GitHub 细粒度令牌调用 GitHub REST API，把修改直接提交到 `main` 分支，
随后由现有的 GitHub Actions（`.github/workflows/hugo.yml`）构建并部署网站。

---

## 1. 目标与约束

| 约束 | 原因 / 做法 |
|---|---|
| **没有构建步骤** | 原生 ES 模块（ES2020+）、DOM API、`fetch`。没有 npm、打包器、框架。改完文件提交即上线。 |
| **没有后端** | 只有 GitHub Pages 静态托管 + GitHub API。不存在任何自建服务器，也就没有能泄露令牌的中间人。 |
| **第三方库本地化** | 全部放在 `static/admin/vendor/`，不从 CDN 加载（国内 CDN 不稳定；持有写仓库令牌的页面不应执行第三方服务器上的脚本）。 |
| **永不丢失用户的修改** | 编辑器、首页设置、背景动画都会在本机自动保存；发布失败、冲突、令牌过期时修改都保留。 |
| **永不写坏文件** | YAML front matter 和 TOML 配置只做"外科手术式"修改，并在写入前重新解析校验（见第 5 节）。 |
| **一次操作 = 一个提交** | 每次发布用 Git Data API 生成一个原子提交，带冲突检查（见第 3 节）。 |
| **界面全中文、手机可用** | ≤ 760px 时左侧导航变成底部标签栏；所有面向用户的报错都是中文。 |

---

## 2. 文件地图

```
static/admin/
├── index.html              外壳 HTML：CSP、noindex、no-referrer；引入 css/admin.css 和全部 css/views/*.css，只加载 js/main.js
├── cassette-frame.html     背景动画预览的沙箱页面（无内联脚本，只引入 js/cassette-frame.js）
├── css/
│   ├── admin.css           设计变量（颜色、间距、深浅色）+ 公共组件（按钮、卡片、对话框、标签页、徽章……）
│   └── views/*.css         每个界面自己的样式（editor / posts（也用于 pages）/ profile / background / files / courses）
├── js/
│   ├── config.js           全局常量：REPO、apiBase()、STORAGE_KEYS、PATHS、LIMITS、站点与语言名称、令牌创建页地址
│   ├── main.js             入口：登录状态、启动加载、整体布局、传给视图的 ctx、ctx.publish（含冲突对话框）、
│   │                       部署状态指示器、401 处理（重新登录对话框）、防嵌入、离开前提醒
│   ├── router.js           hash 路由：canLeave → unmount → 动态 import('./views/<name>.js') → mount
│   ├── ui.js               DOM 工具 h()/render()、图标、toast、modal/confirmDialog/promptDialog、遮罩、格式化函数
│   ├── github.js           GitHubClient + GitHubError：极简 REST 客户端，错误统一成中文 message
│   ├── repo.js             Repo：main 分支文件树的本地视图、读取（带 blob 缓存）、原子提交 + 冲突检查、watchDeploy
│   ├── frontmatter.js      YAML front matter 的拆分 / 解析 / 精确修改 / 拼装
│   ├── tomlpatch.js        保留注释的 TOML 精确修改
│   ├── content.js          双语内容模型（纯函数）：页面组、各语言显示哪个文件、网址 slug、图片目录；
│   │                       资料在线预览链接 viewerUrlFor / isViewerFilePath（规则与网站 static/viewer/path.js 一致）
│   ├── courses.js          「课程」的内容模型（纯函数）：collectCourses、排序 / 分组 / reweight / nextWeights、
│   │                       文件名 → 标题 / 网址、资料目录、新文件模板、批量上传的子推文正文、草稿课程的 cascade（第 13 节）
│   ├── uploads.js          往 static/ 上传的共用逻辑：拒绝会执行脚本的类型（uploadBlockReason）、.gitignore 匹配、
│   │                       图片压缩、同批重名改名、上传前检查与确认框内容、文件 / 预览网址、引用检查与删除（第 13 节）
│   ├── images.js           图片压缩、正方形裁剪、安全文件名
│   ├── drafts.js           IndexedDB：编辑器自动保存的草稿 + GitHub 文件内容（blob）缓存
│   ├── preview.js          编辑器「手机预览」的渲染（写进无脚本的沙箱 iframe）
│   ├── cassette-frame.js   背景动画沙箱 iframe 里的脚本（postMessage 协议）
│   └── views/
│       ├── login.js        登录页 + 创建令牌的 5 步说明
│       ├── posts.js        「文章」列表、本机草稿卡片；也导出列表页共用的工具（pages.js 使用）
│       ├── pages.js        「页面」列表、导航菜单排序、「新建栏目」
│       ├── editor.js       文章 / 页面编辑器（Vditor），多语言版本标签页、图片 / 资料、自动保存、发表
│       ├── profile.js      「首页设置」：头像裁剪、名字简介、按钮、社交链接、节日图标
│       ├── background.js   「背景动画」：卡带列表、实时预览、参数微调
│       ├── courses.js      「课程」：课程列表（分组、顺序）、新建课程、一门课的子推文 / 资料、批量上传、删除课程（第 13 节）
│       └── files.js        「资料」：static/ 下文件的上传、复制链接（PDF：复制预览链接 /viewer/?file=…）、删除（上传 / 删除逻辑在 uploads.js）
└── vendor/                 第三方库本地副本（见第 10 节）

tests/admin/                单元测试 + 端到端测试（见第 9 节）
```

### 路由

| 地址 | 视图 | 参数 |
|---|---|---|
| `#/posts`（默认） | `views/posts.js` | `filter=all\|published\|draft`（可选） |
| `#/edit` | `views/editor.js` | `path=<仓库路径>` 打开已有文件；`new=post`；`new=page&dir=<目录>`（`<目录>` 是已有介绍页的课程 `content/courses/<课程>` 时 = 新子推文）；`draft=<草稿 key>` |
| `#/pages` | `views/pages.js` | |
| `#/courses` | `views/courses.js` | `course=<课程网址名>`（可选；有 = 打开这门课） |
| `#/profile` | `views/profile.js` | |
| `#/background` | `views/background.js` | |
| `#/files` | `views/files.js` | `dir=<static 下的目录>`（可选） |
| `#/login` | `views/login.js` | 未登录时由外壳自动跳转 |

路由名到模块名的映射在 `main.js` 的 `ROUTES`（例如 `edit` → `editor`）。编辑器里打开课程的页面（`content/courses/<课程>/…`，或新子推文）时，导航高亮「课程」（`activeNavRoute`）；「课程资料」总页 `content/courses/_index.md` 仍属于「页面」。

---

## 3. 数据流

```
启动
  令牌（sessionStorage / localStorage）
   → GitHubClient：getUser() + getRepo()（要求 permissions.push）
   → checkWriteAccess()：POST 一个空 blob，确认细粒度令牌真的有 Contents 写权限
   → Repo.load()：读 main 的 head 提交 + 递归文件树（只保留文件，记住子模块）
   → 读 languages.toml / hugo.toml 得到语言列表和默认语言（失败回退 ['zh','en'] / 'zh'）
   → router.start()，视图挂载

编辑（各视图）
   repo.list() / repo.entry() 同步查询文件树
   repo.readText() / readBytes() 读取内容（按 sha 缓存在内存 + IndexedDB，内容寻址，永不过期）
   用户修改 → 本机自动保存（见第 7 节）

发布：ctx.publish({ message, changes, summary, viewUrl?, viewLabel? })
   → 全屏遮罩「正在发布…」（显示进度：准备 / 检查最新版本 / 上传 n/m / 提交）
   → Repo.commit()（见下）
   → 成功：toast「已发布，正在部署…」，启动部署指示器
   → ConflictError：对话框「有文件在你编辑期间被修改了」→「重新加载最新版本」= repo.load()，返回 { conflict: true }
   → 其他错误：toast 中文错误并抛出（视图保留用户的修改）

部署：repo.watchDeploy(commitSha, onUpdate)
   每 5 秒查询 actions/runs?head_sha=…，最多 15 分钟
   → pending / running →「部署中…」
   → success →「已上线 ✓」（链接到刚发布的页面或首页）
   → failure →「部署失败」（链接到 Actions 运行记录）
   → unknown →「已提交，约 1–2 分钟后生效」（令牌没有 Actions 权限、3 分钟内没有运行记录、运行被取消、超时）
```

### Repo.commit：原子提交与冲突检查

每一项 change 是 `{ path, content, baseSha? }`（写入）或 `{ path, delete: true, baseSha? }`（删除）。
`baseSha` 的含义：`undefined` = 不检查；`null` = 文件必须不存在；`'<sha>'` = 文件现在必须是这个 sha。
视图在读取文件时记下 sha，发布时作为 `baseSha` 传入。

步骤（串行执行，同一时刻只有一个 load/commit）：

1. 读取**最新**的分支 head 和完整树（冲突检查基于"现在"，而不是 `load()` 时）。树被截断时拒绝发布。
2. 结构检查：不能写子模块（`themes/PaperMod`）里的文件；文件 / 文件夹不能互相覆盖。
3. 冲突检查：每个 `baseSha` 必须符合。"文件现在恰好已经是我们要写的内容"不算冲突（上一次发布其实成功了、只是响应丢了）。
4. 上传 blob（最多 4 个并发；内容没变的文件跳过）。单个文件 > 100 MB 直接拒绝。
5. 以最新树为 `base_tree` 建树；树没变就不产生空提交（返回 `unchanged: true`）。
6. 建提交（父提交 = 最新 head）→ `PATCH git/refs/heads/main`（`force: false`）。
   - 409 / 422（分支在这期间被移动）：整个流程自动重来一次。
   - 网络中断 / 5xx：请求可能已经成功。记下这次写入的内容，多读几次分支指针确认；仍无法确认时抛出 `uncertain` 错误，提示用户稍后再点一次发布——届时第 3 步会识别出"已经是我们写的内容"，不会重复发布。
7. 成功后用本地记账更新文件树（等于最新树 + 本次修改），触发 `onChange`。

提交信息统一以 `admin: ` 开头（例如 `admin: 发表《标题》`、`admin: 删除资料 xxx.pdf`、`admin: 课程《近代物理实验》上传 3 个文件，新增 2 篇子推文`），方便在 git log 里区分。

---

## 4. 安全模型

令牌能写整个网站仓库（包括 Actions 工作流），所以后台按"页面上任何来自仓库的内容都不可信"来设计。

**令牌存储与发送**

- 勾选「在此设备上记住」→ `localStorage['admin.token']`；不勾选（默认）→ `sessionStorage['admin.token']`，关标签页即删除。退出登录两者都删。
- 令牌只发往 `config.apiBase()`：正式环境永远是 `https://api.github.com`。只有页面运行在 `localhost` / `127.0.0.1` 时，才允许 `localStorage['admin.apiBase']` 覆盖（测试和本地开发用）。**绝不**从网址、查询参数、hash 或仓库内容读取 API 地址，否则别人能构造链接把令牌骗走。
- 令牌不出现在 URL、日志里。`main.js` 的 `guardedFetch` 只观察状态码：会话中任何请求返回 401 → 弹出「登录已失效」对话框，粘贴新令牌后继续，页面上未发布的修改保留。
- 记住的令牌在 `himzfx.github.io` 整个源共用的存储里，网站页面上加载的第三方脚本（KaTeX、giscus）理论上能读到——这是默认不勾选的原因，登录页也如实告知。
  网站上带脚本的独立页面（目前只有资料预览页 `/viewer/`）也在这个源里，必须按[第 12 节](#12-资料在线预览页viewer属于网站)的方式加固。

**CSP（`index.html` 的 meta）**

```
default-src 'self'; script-src 'self' 'unsafe-eval'; style-src 'self' 'unsafe-inline';
img-src 'self' data: blob: https:; font-src 'self' data:; connect-src 'self' https://api.github.com;
frame-src 'self' blob:; worker-src 'self' blob:; object-src 'none'; base-uri 'self'; form-action 'none'
```

- 没有任何第三方脚本源；`connect-src` 只允许本站和 `api.github.com`，即使出现注入，令牌也发不到别处。
- `'unsafe-eval'` 是给 vendored 的 Vditor / Lute / KaTeX 用的（它们内部用到 `Function` / `eval`）；`index.html` 里没有内联脚本。
- `tests/admin/e2e-shell.mjs` 会逐字检查这条 CSP，修改时要同步更新测试并说明理由。
- 另有 `<meta name="robots" content="noindex, nofollow">` 和 `<meta name="referrer" content="no-referrer">`。

**防嵌入（点击劫持）**：GitHub Pages 不能发送 `X-Frame-Options`，`frame-ancestors` 写在 meta 里也无效，所以 `main.js` 检测 `window.top !== window.self` 时不启动，只显示「在新标签页打开管理后台」按钮。

**不用 innerHTML 拼数据**：界面一律用 `ui.h()` / `textContent` 生成。只有三个例外：
(a) `svgIcon()` 和编辑器工具栏里写死在代码中的 SVG 字符串；
(b) 手机预览 iframe 的 `srcdoc`（`preview.js`，标题等文字先转义）；
(c) Vditor 自己渲染的编辑区——`editor.js` 的 `neutralizeEmbeds` 会把 Lute 输出里的 `<iframe>` 等嵌入元素换成不加载任何东西的占位，否则文章里一个指向同源页面的 iframe 就能读到令牌。
仓库里来的链接只允许 `http(s)`（`posts.js` 的 `safeHref`）。

**不能上传会以本站身份执行脚本的文件**：`static/` 里的文件和后台同源，GitHub Pages 按扩展名给 Content-Type，
一个 `.html` / `.svg` / `.xml` 被直接打开时，里面的脚本能读到记住的令牌。所以 `uploads.js` 的 `uploadBlockReason(原文件名, 处理后的文件名)`
拒绝 `BLOCKED_UPLOAD_EXTS`（`html htm xhtml xht shtml xml xsl xslt svg svgz js mjs`，不区分大小写，结尾的空白 / 点去掉后再看），
并给出中文说明 `BLOCKED_UPLOAD_EXPLAIN`（SVG 建议转成 PNG，网页 / 文档导出成 PDF）。所有上传入口都经过它：
「资料」和「课程」的上传走 `checkUploads`（列为「不能上传，会被跳过」），编辑器的图片 / 资料 / 封面 / 粘贴拖入走 `refuseUpload`（提示后拒绝）。
新增上传入口时必须同样检查；不要为了某个文件放宽这份清单（真需要时用户自己用 git 提交）。

**沙箱 iframe**

| 用途 | sandbox | 说明 |
|---|---|---|
| 文章手机预览（`preview.js`） | `allow-same-origin`，**没有** `allow-scripts` | 里面的任何脚本都不会运行；需要同源才能用本站样式和图片 |
| 背景动画预览（`cassette-frame.html`） | `allow-scripts`，**没有** `allow-same-origin` | 卡带代码能运行，但源是 `null`，读不到后台的存储和令牌。代码通过 `postMessage` 传入；`cassette-frame.js` 只接受来自父窗口、且源等于后台的消息，并且只在 `self.origin === 'null'` 时工作 |

---

## 5. 精确修改 YAML / TOML 的保证

配置文件和 front matter 里有大量中文注释，是用户的说明书，所以**从不"解析再整体重写"**。

**`frontmatter.js`（YAML front matter）**

- `splitDocument()` 拆出 front matter 和正文；`+++` 的 TOML front matter 标记为 `kind: 'toml'`，后台拒绝编辑（只提示去 GitHub 改）。
- `setFields(fmText, updates)` 只替换被修改的顶层键所在的那几行（`undefined` = 删除该键；不存在则追加到末尾），其他行（包括注释）原样保留；单行标量换成标量时保留行尾 `# 注释`。
- **写入前校验**：用 js-yaml（`CORE_SCHEMA`，日期保持字符串）重新解析结果，必须与"原内容 + 本次修改"逐项相等，否则抛 `FrontMatterError`，绝不返回悄悄写错的文件。
- 编辑器没改正文时，原始正文原样写回，保证字节级不变。

**`tomlpatch.js`（`config/_default/*.toml`）**

- `setValue(text, tablePath, key, value)`、`replaceArrayOfTables(text, name, items)`、`removeTableIfEmpty(text, tablePath)`。
- 用一个只认结构的小扫描器定位表头、键值、多行数组、多行字符串；只替换值那一段文字，键名、对齐空格、行尾注释、其他行不动。
- **写入前校验**：用 smol-toml 重新解析，必须与"原内容 + 本次修改"一致（且没有别的变化），否则抛 `TomlPatchError`，视图取消发布、文件不变。

**背景动画参数**：`background.js` 只识别卡带里形如 `    NAME: 123.4,  // 说明` 的行（大写键名、纯数字字面量，`8 / 3` 这类表达式跳过），发布时只替换那个数字；定位或校验失败就取消，不写文件。

---

## 6. 双语映射

规则与 [SITE_GUIDE.md 第 4 节](../SITE_GUIDE.md#4--双语机制)、`new_post.py --status` 完全一致，实现在 `content.js`：

| 文件 | 编辑器标签页（`variantLabel`） | 显示在 |
|---|---|---|
| `xxx.md` | 共用版本 | 所有没有专属版本的语言 |
| `xxx.en.md` | 英文专属 | 英文站（整体替换共用版本，含 front matter） |
| `xxx.zh.md` | 中文专属 | 中文站 |

- 语言列表来自 `languages.toml` 的顶层表（按 `weight` 排序），默认语言来自 `hugo.toml` 的 `defaultContentLanguage`。语言后缀只有在是站点语言时才算数（站点没有 `fr` 时，`a.fr.md` 是名为 `a.fr` 的共用页面）。
- `groupPages()` 把同一页面的各版本归成一个"页面组"；`resolveForLang()` = 专属版本 > 共用版本 > 无；`languageStatus()` / `statusText()` 给出「中英共用 / 中英分开 / 仅中文 / 仅英文」。
- `shadowWarnings()`：专属版本是 `draft: true` 而共用版本已发表 → 该语言站点上这一页会消失，列表和编辑器都会警告。
- 编辑器「单独写英文版」= 复制当前内容新建 `xxx.en.md`（发表时才创建文件）；删除专属版本 = 该语言改回显示共用版本。
- 首页设置里「英文站单独设置」写入 `languages.toml` 的 `[en.params.profileMode]`；留空 = 删除该键，表空了就删表头。
- 新建栏目：`content/<网址>/_index.md`，填了英文名称时再加 `_index.en.md`。
- 课程：同样的规则（新建课程填了英文名称 → `_index.en.md`；批量上传的子推文只写共用版本）。网站读 `group`、`weight`、`materialsDir`、`showMaterials` 时，
  语言专属版本没写就沿用共用版本（`layouts/partials/courses/param.html`），反过来不行；后台改分组时，其他语言版本自己写了不同的分组名就不动它。

---

## 7. 本机存储（草稿与缓存）

本机存储只是"保险"：所有读写失败都安静地返回空结果，绝不影响正常使用。

| 存储 | 内容 | 位置 |
|---|---|---|
| IndexedDB `himzfx-admin` / `drafts` | 编辑器自动保存：`{ key, title, markdown, fields, images: { 文件名: Blob }, path, baseSha, groupKey, updatedAt }`。key 为 `file:<路径>` 或 `new:<随机>` | `drafts.js` |
| IndexedDB `himzfx-admin` / `blobs` | GitHub 文件内容缓存（按 blob sha 寻址，永不过期；总量约 80 MB、单个 20 MB 上限） | `drafts.js` 的 `idbBlobCache()`，传给 `Repo` |
| IndexedDB `himzfx-admin-profile` | 首页设置未发布的修改（含裁剪好的新头像）。单独建库，免得被文章列表当成文章草稿 | `profile.js` |
| `localStorage['admin.bg.unpublished']` | 背景动画未发布的设置和参数输入（无敏感信息） | `background.js` |
| `localStorage['admin.bg.preview']` | 背景预览的偏好（电脑 / 手机、浅色 / 深色） | `background.js` |
| `sessionStorage['admin.returnHash']` | 登录后要回到的地址 | `main.js` |

编辑器细节：

- 粘贴 / 拖入的图片先压缩（`images.compressImage`，最宽 1920、质量 0.85），以 Blob 留在内存，编辑区用 `blob:` 地址显示；发表时换成 `/images/posts/<文件名>/<图片名>`，图片和文章在**同一个提交**里上传。
- 自动保存时 `blob:` 地址换成 `admin-pending://<图片名>` 占位，图片 Blob 一起存进 IndexedDB，恢复时再换回来。
- 草稿记下保存时文件的 `baseSha`；恢复时如果 GitHub 上的文件已经变了，会提示"恢复后发表会覆盖那些修改"。
- 发表成功后只删除本编辑器实例写的、或打开前就存在的草稿（另一个标签页里同一篇文章的自动保存不会被删掉）。
- Markdown 扩展和网站保持一致：`preview.js` 导出 `VDITOR_MARKDOWN`（目前是 `{ mark: true }`），编辑器的 `preview.markdown` 和手机预览的 `md2html` 都用它；对应网站 `markup.toml` 的 `goldmark.extensions.extras.mark`（`==文字==` → `<mark>`，样式在 `assets/css/extended/mark.css`）。以后在一边开新扩展，另一边也要开。
- 工具栏「高亮」（`toggleMark`，`Ctrl/⌘+Shift+M`）：所见即所得模式下直接把选区包进 `<mark data-marker="==">`（或拆掉已有的），再用 `vd.insertValue('')` 让 Vditor 按「输入」重新整理那一段（触发 input 回调、可撤销）；源码 / 即时渲染模式按文字加减 `==`。`==` 和 `**` 一样受 CommonMark 左右侧规则限制：里侧紧挨标点或格式符号（`，“`、`**`、`` ` ``、`[`）而外侧紧挨文字时不算高亮（中文里很常见，例如 `文字==**粗体**==文字`、`文字**==粗体==**文字` 都会坏，后者连加粗也丢了；Lute 和 goldmark 规则一致）。所以加高亮前先在副本上用 Lute 试（`planMark` / `markTextCandidates`）：原样 → 两头的标点放到 `==` 外面 → 挪到加粗 / 链接外面 → 在需要的一侧加一个空格（会提示），都不行就不加并提示。公式 / 代码里的 `==` 不受影响（Lute 先识别 `$…$` 和代码）；`\(…\)`、`\[…\]` 在 Vditor 里只是普通文字，里面成对的 `==` 在编辑区会显示成高亮，但保存时原样写回，网站上仍是公式。

---

## 8. 视图约定（ctx）

每个视图模块 `export default async function mount(container, params, ctx)`，可以返回
`{ unmount?(), canLeave?(): boolean | Promise<boolean>, isDirty?(): boolean }`。
路由离开前调用 `canLeave()`，`beforeunload` 使用同步的 `isDirty()`。

`ctx`（`main.js` 的 `appCtx()`）：

| 字段 | 说明 |
|---|---|
| `client` / `repo` / `user` | GitHubClient、已加载的 Repo、`{ login, avatarUrl }` |
| `langs` / `defaultLang` | 例如 `['zh', 'en']` / `'zh'` |
| `siteLabel(lang)` / `langName(lang)` | 「中文站 / 英文站」/「中文 / 英文」 |
| `siteUrl` | `location.origin + '/'` |
| `navigate(hash, { replace })` | 跳转；跳到当前地址时重新挂载 |
| `setTitle(text)` | 设置顶栏标题和 `document.title` |
| `publish({ message, changes, summary, viewUrl?, viewLabel? })` | **视图提交修改的唯一入口**（见第 3 节） |
| `isPublishing()` | 当前是否正在发布 |

---

## 9. 运行测试

详见 [tests/admin/README.md](../tests/admin/README.md)。全部只用 Node 内置模块 + 预装的 Playwright（Chromium），**不需要 `npm install`**，也不访问真正的 GitHub：所有请求打到 `tests/admin/mock-github.mjs`（内存里的 git 仓库，SHA 与真实 git 一致，并同源托管 Hugo 构建出的网站）。

```bash
# 在仓库根目录
node --test tests/admin/            # 单元测试：content / courses（含 uploads）/ formats / github / mark / mock（index.js 负责加载全部 *.test.mjs）

node tests/admin/e2e-shell.mjs       # 登录、导航、退出、401、CSP、手机布局
node tests/admin/e2e-editor.mjs      # 编辑器：发表 / 更新、英文版、自动保存与恢复、冲突、手机预览、高亮
node tests/admin/e2e-lists.mjs       # 文章列表、页面与菜单排序、新建栏目
node tests/admin/e2e-profile.mjs     # 首页设置、头像裁剪
node tests/admin/e2e-background.mjs  # 背景动画预览与参数
node tests/admin/e2e-files.mjs       # 资料上传 / 删除（含拒绝 .html / .svg）
node tests/admin/e2e-courses.mjs     # 「课程」：新建课程、批量上传（一个提交）、只放进资料、顺序、分组、冲突、新子推文、删除课程，最后 Hugo 构建
node tests/admin/e2e-courses-site.mjs # 网站的课程资料模板：总页分组与顺序、单元页、构建时的资料列表、面包屑、课程内上一篇 / 下一篇、英文站
node tests/admin/e2e-journey.mjs     # 跨界面的完整使用流程，最后用 Hugo 构建并检查两种语言的网站（含访客打开资料预览 / 嵌入阅读器）
node tests/admin/e2e-viewer.mjs      # 网站的资料在线预览页 static/viewer/ 与 {{< pdf >}} 短代码
```

| 环境变量 | 作用 |
|---|---|
| `HUGO_BIN` | Hugo 可执行文件，需与 CI 相同（0.147.4 extended）；找不到时依赖 Hugo 的测试自动跳过 |
| `ADMIN_TEST_TMP` | 测试输出的根目录（默认系统临时目录）；`ADMIN_TEST_KEEP=1` 让 `mock.test.mjs` 保留导出 / 构建结果 |
| `SHELL_E2E_DIR`、`EDITOR_E2E_DIR`、`LISTS_E2E_DIR`、`PROFILE_E2E_DIR`、`BG_E2E_DIR`、`FILES_E2E_DIR`、`COURSES_E2E_DIR`、`COURSES_SITE_E2E_DIR`、`JOURNEY_E2E_DIR`、`VIEWER_E2E_DIR` | 各 e2e 脚本放 Hugo 构建结果和截图的目录 |
| `ONLY=<子串>` | 只跑名字包含这个子串的用例（`e2e-shell` / `e2e-editor` / `e2e-files` / `e2e-courses` / `e2e-courses-site`；编辑器和课程的后续用例依赖前面的，只用来调试） |
| `SKIP_BUILD=1` | 复用上一次的初始构建（`e2e-shell` / `e2e-lists` / `e2e-profile`） |
| `DEBUG=1` | 打印浏览器控制台输出（`e2e-editor` / `e2e-journey` / `e2e-courses`） |

注意：不要用 `hugo -d /dev/null` 之类的命令做构建检查；e2e 脚本会把构建结果放到上面的目录里。

---

## 10. 升级第三方库

清单、版本、许可证见 [static/admin/vendor/README.md](../static/admin/vendor/README.md)：Vditor 3.11.3（含 Lute、KaTeX、highlight.js）、js-yaml 4.1.1、smol-toml 1.9.1。

1. 从 npm 包取出新版本，**整体替换**对应目录（`vendor/vditor/`、`vendor/js-yaml/`、`vendor/smol-toml/`），保留 `LICENSE`。
2. `vditor/` 只保留用到的部分：`dist/index.min.js`、`dist/index.css`、`dist/js/lute/`、中英文语言包（`dist/js/i18n/`）、图标（`dist/js/icons/`）、KaTeX（只要 woff2 字体）、highlight.js（github 浅色 / 深色样式）、内容主题。Mermaid、ECharts、MathJax 等不要放进来。
3. 入口路径不能变：`config.js` 的 `VDITOR_CDN` 指向 `vendor/vditor`（结尾不带 `/`，Vditor 用它加载 Lute 等子资源）；`frontmatter.js` 导入 `vendor/js-yaml/js-yaml.mjs`；`tomlpatch.js` 和 `main.js` 导入 `vendor/smol-toml/index.js`。
4. 更新 `vendor/README.md` 的版本号。
5. 跑一遍全部单元测试和 e2e（尤其 `e2e-editor.mjs` 和 `formats.test.mjs`）。新版本如果需要新的 CSP 来源，说明它试图访问外部资源——应该把那份资源也本地化，而不是放宽 CSP。

---

## 11. 新增一个界面

以「统计」界面 `#/stats` 为例：

1. 新建 `static/admin/js/views/stats.js`：

   ```js
   import { h, render } from '../ui.js';

   export default async function mount(container, params, ctx) {
     ctx.setTitle('统计');
     render(container, h('div', { class: 'card' }, `共有 ${ctx.repo.list('content/posts/').length} 个文件`));
     return {
       unmount() {},
       // 有未发布的修改时：canLeave() 弹确认框，isDirty() 返回 true
     };
   }
   ```

2. 在 `main.js` 里登记：`ROUTES` 加 `stats: 'stats'`（路由名 → `views/` 下的模块名），`ROUTE_TITLES` 加 `stats: '统计'`；
   要出现在左侧 / 底部导航里，再往 `NAV` 加一项（`route`、`label`、`short`、`icon`（`ui.svgIcon` 已有的图标名）、`testid`）。
3. 需要样式就建 `static/admin/css/views/stats.css`，并在 `index.html` 里加一行 `<link rel="stylesheet">`；尽量复用 `admin.css` 的公共组件。
4. 写入仓库只能通过 `ctx.publish()`，每个修改的文件都带读取时的 `baseSha`；改 TOML 用 `tomlpatch`，改 front matter 用 `frontmatter.setFields`。
5. 遵守第 4 节的规则：界面用 `h()` / `textContent` 生成，不把仓库内容写进 `innerHTML`，不引入外部脚本。
6. 写 `tests/admin/e2e-stats.mjs`（参考 tests/admin/README.md 里的推荐写法：`startMock` + `buildSite` + `openAdmin`），并在 README 里登记。

---

## 12. 资料在线预览页（/viewer/，属于网站）

安卓手机、尤其是微信内置浏览器打不开 PDF（只能下载），所以网站有一个独立的静态预览页 `static/viewer/`，
后台的「复制预览链接」和编辑器的「插入链接（点开在线预览）」都指向它，`{{< pdf >}}` 短代码把它嵌进 iframe。
它不是后台的一部分（不用令牌、不调 GitHub API），但**和后台同源**，所以写在这里。详细说明见
[static/viewer/README.md](../static/viewer/README.md)，使用方法见 [SITE_GUIDE.md 第 9 节](../SITE_GUIDE.md#在线预览点开就能看不用先下载)。

**文件**

| 文件 | 作用 |
|---|---|
| `static/viewer/index.html` | 页面骨架 + CSP；不经过 Hugo 模板，不加载主题、KaTeX、giscus、背景动画 |
| `static/viewer/viewer.js` | 主逻辑（ES 模块）：参数校验、PDF 懒加载渲染、缩放、页码、图片、中英文界面、错误提示 |
| `static/viewer/path.js` | `?file=` 的校验 `parseFileParam`（纯函数）和 `viewerHref` |
| `static/viewer/theme.js`、`nomodule.js`、`viewer.css` | 深浅色（只读 `pref-theme`）、老浏览器提示、样式 |
| `static/viewer/vendor/pdfjs/` | PDF.js 本地副本，见下文 |
| `layouts/shortcodes/pdf.html` + `assets/css/extended/pdf-embed.css` | 嵌入短代码：`iframe`（`embed=1`、`lang` = 页面语言、`loading="lazy"`）+「在新页面打开」「下载」 |

**URL 约定**（网站和后台必须一致）

```
/viewer/?file=<encodeURIComponent(网站路径)>[&lang=en][&embed=1][&page=N]
```

- 后台只通过 `content.js` 的 `viewerUrlFor(sitePath, { lang, embed, absolute, siteUrl, page })` 生成链接，
  `isViewerFilePath` 判断路径能否预览；规则与 `path.js` 一致，改一边必须同步另一边（`content.test.mjs` 和 `e2e-viewer.mjs` 都有覆盖）。
- `file` 接受：以 `/` 开头且不是 `//`；没有反斜杠、控制字符；解码前后（最多 3 轮）都没有空段、`.`、`..`、编码的 `/`；
  不在 `/admin/`、`/viewer/` 下（不区分大小写）。`.pdf` → PDF.js；`.png .jpg .jpeg .gif .webp .avif .svg` → `<img>`；
  其他 → 下载提示。不合格时只显示错误，**不发请求、不跳转**。
- 后台引用检查（删除资料前的提示）把直接链接、预览链接、`{{< pdf >}}` 都算作引用。

**安全加固**（后台的令牌可能在同源 `localStorage` 里，见第 4 节）

- CSP：`default-src 'self'; script-src 'self'; worker-src 'self'; style-src 'self'; connect-src 'self'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'` 等。
  比后台更严：没有 `'unsafe-eval'`、`'unsafe-inline'`，没有内联脚本。不需要 `'wasm-unsafe-eval'`——WebAssembly 解码器只在 Worker 里运行。
- 只读 `localStorage['pref-theme']`，不碰其他存储；`<meta name="referrer" content="no-referrer">`。
- PDF.js：不带 `pdf.sandbox`、`quickjs-eval`（不执行 PDF 里的脚本），`enableXfa: false`、`isEvalSupported: false`；
  PDF 里的链接只保留 `http(s)`、`mailto` 和文档内跳转，外链 `target=_blank` + `noopener noreferrer`。
- 页面内容一律用 DOM API / `textContent` 生成，不用 `innerHTML`（文件名可能含 HTML 字符）。
- 后台编辑器里的 `{{< pdf >}}` 和手机预览都只显示为卡片，不在后台里加载 iframe（第 4 节的 `neutralizeEmbeds` 规则不变）。

**PDF.js（本地副本）**：`pdfjs-dist` 6.4.299，Apache-2.0，用 **legacy** 版本（老的安卓 / 微信 WebView 也能跑）。
复制了 `build/pdf.min.mjs`、`build/pdf.worker.min.mjs`、`cmaps/`（中文 PDF 没有嵌入字体时必须有）、`standard_fonts/`、
`wasm/`（不含 `quickjs-eval.*`）、`iccs/`、`LICENSE`。升级步骤见 [static/viewer/vendor/pdfjs/README.md](../static/viewer/vendor/pdfjs/README.md)：
`npm pack pdfjs-dist@<版本>` → 整体替换这些目录 → 核对 `legacy/build/pdf.mjs` 里 `getDocument` 的参数
（`cMapUrl`、`standardFontDataUrl`、`wasmUrl`、`iccUrl`）和 `TextLayer`、`page.render` 的用法，同步 `viewer.js` → 更新 README 版本号 → 跑测试。
新版本如果要求放宽 CSP，应该先找原因，而不是直接放宽。

**测试**：`node tests/admin/e2e-viewer.mjs`（`VIEWER_E2E_DIR` 放构建结果和截图）。用固定版本的 Hugo 构建一份导出的仓库副本，
覆盖：多页中文 PDF 的懒加载与缩放、非嵌入中文字体（检查 cmaps）、PDF 里的 `javascript:` 链接被丢弃、加密 / 损坏的 PDF、
图片和其他文件、各种非法 `file` 参数（不发出任何请求）、含 `#`、`%`、HTML 字符的文件名、CSP，以及中英文站的 `{{< pdf >}}` 短代码。

---

## 13. 课程（#/courses）

「课程资料」像博客：每门课是一个 Hugo section（单元页），里面可以有子推文。网站的模板和后台**共同遵守**下面的约定，
改一边必须同步另一边（`courses.test.mjs`、`e2e-courses.mjs`、`e2e-courses-site.mjs` 都有覆盖）。
使用方法见 [SITE_GUIDE.md 第 6 节「课程资料」](../SITE_GUIDE.md#课程资料课程单元与子推文)。

**内容约定**

| 路径 | 内容 |
|---|---|
| `content/courses/_index.md`（+ `.en.md`） | 「课程资料」总页：用户写的说明文字 + 导航菜单项。属于「页面」，不属于「课程」 |
| `content/courses/<课程>/_index.md`（+ 可选 `_index.en.md`） | 课程单元页。`title`、`description`（一句话，卡片上显示）、可选 `group`（自由文字，原样显示）、`weight`（课程之间的顺序）；可选 `materialsDir`（默认 `static/documents/courses/<课程>/`）、`showMaterials`（默认 `true`）。**没有 `menu`** |
| `content/courses/<课程>/<篇>.md` | 子推文：`title`、`weight`（课程里的顺序）、可选 `description`、`draft: false`。不需要 `date`（课程里不显示日期） |
| `static/documents/courses/<课程>/` | 资料文件夹，网址 `/documents/courses/<课程>/…` |

- 排序：`weight` 再标题；`weight` 缺省或 0 排在最后（和 Hugo 一致）。
- 分组：没有课程写 `group` → 一个没有标题的列表；否则每组一个标题，组按组内最小 `weight`（相同按组名），组内按 `weight`、标题，没有分组的放进最后的「其他」/ Other。
  后台的 `courses.groupCourses` 和网站的 `layouts/partials/courses/landing.html` 实现同一个规则。没有任何"年级"之类的固定概念。

**网站这一侧**（不属于后台，写在这里是因为约定是共同的）

| 文件 | 作用 |
|---|---|
| `layouts/courses/list.html` | `/courses/` → `partials/courses/landing.html`（说明文字 + 课程卡片）；`/courses/<课程>/` → `partials/courses/unit.html`（面包屑、介绍、子推文卡片、资料列表） |
| `layouts/courses/single.html` | 子推文：面包屑、无日期 / 阅读时间；所在课程是草稿时 `warnf` 提醒 |
| `layouts/partials/courses/info.html` | 一门课的汇总：分组、子推文（`sort.html`）、资料列表 |
| `layouts/partials/courses/{param,sort,card,breadcrumbs,size}.html` | 带语言版本回退的参数读取、排序、卡片、面包屑、文件大小 |
| `layouts/partials/post_nav_links.html` | 覆盖 PaperMod：课程子推文的上一篇 / 下一篇只在同一门课里按 `weight`；其他页面是原版的逐字拷贝 |
| `i18n/zh.yaml`、`i18n/en.yaml` | `courses_*` 界面文字；PaperMod 自带的条目照常合并 |
| `assets/css/extended/courses.css` | 样式（只用主题的颜色变量，深浅色自动） |

资料列表在**构建时**生成：`os.ReadDir` 读资料文件夹（相对项目根目录，在 Hugo 0.147.4 和 mock 导出的仓库副本里都可用），
跳过子文件夹和以 `.` 开头的文件，按文件名排序。PDF / 图片链接到 `/viewer/?file=…`（非默认语言加 `&lang=`），其他文件直接链接（逐段编码）；
某篇子推文的正文引用了这个文件（原样路径、编码路径、预览链接）时显示「收录于」那一篇。所以后台上传资料**不需要改任何 .md**。

**后台：`views/courses.js`**

- 列表页 `#/courses`：`collectCourses(repo.list('content/'))` + `readFrontMatters` → 按 `groupCourses` 显示（和网站顺序一致）。
  ↑ ↓ 只在组内交换，分组的 ↑ ↓ 整组移动；「保存顺序」用 `reweight`（原 weight 都是不同的有效数字时只是重新分配这些数字，交换两项只改两个文件；否则按 10、20、30… 重编）
  → 一个提交，每个文件只用 `patchFields`（= `frontmatter.setFields` + 正文不变校验）改 `weight` 那一行，所有语言版本一起改。
  「分组」= 改 `group`（`canonicalGroup`：只差大小写 / 空白时沿用已有写法）；分组「改名」= 所有分组名等于旧名字的文件一起改。
- 「新建课程」：`_index.md`（+ 填了英文名称时 `_index.en.md`），`weight` = `nextWeights` 接在最大值后面，`baseSha: null`（网址被占用 → 冲突提示换网址）。
- 详情页 `#/courses?course=<课程>`：子推文（顺序、编辑、删除全部语言版本）、资料（复制预览链接 / 复制链接、打开、删除——`uploads.deleteStaticFile`，先列出引用）、
  「删除课程」（`courseDeletionPlan`：课程文件夹全部文件 + `static/images/pages/courses/<课程>/`；资料文件夹只在勾选、且是默认文件夹时删除；一个提交）。
- 编辑器配合（`editor.js`）：`#/edit?new=page&dir=content/courses/<课程>` 在课程已有介绍页时 = 新子推文（填文件名；第一次发表时 `weight` = 本课最大值之后；
  front matter 顺序 `title, weight, description, draft`；没有日期和菜单）；课程里的页面不显示菜单字段；「资料」按钮上传到这门课的资料文件夹；
  课程介绍页改为草稿时用 `draftCascadeUpdate` 加上 `cascade: { build: { render: never, list: never } }`（Hugo 不会因为 section 是草稿就隐藏子页面），
  恢复发表时只去掉这份后台写的 cascade；只删介绍页而文件夹里还有子推文时，引导到「删除课程」。`pages.js` 不列课程目录，只在总页那一行放一个「在「课程」里管理」的链接。

**批量上传的提交形状**

流程：选文件 / 拖放 → 去掉系统垃圾文件 → 可选压缩 JPG / PNG（`prepareUpload`）→ `assignUniqueNames`（同批重名加 -2）→ 路径 `<资料目录>/<文件名>`
→ `checkUploads`（拒绝类型、≥ 95 MB、和文件夹重名；提醒 ≥ 25 MB、替换、`.gitignore`、HEIC）→ 对话框（每个文件「生成子推文」/「只放进资料列表」、标题）
→ **一次** `ctx.publish`：

```js
{
  message: 'admin: 课程《近代物理实验》上传 3 个文件，新增 2 篇子推文',
  // 只放进资料：'admin: 课程《…》上传资料 a.pdf' / 'admin: 课程《…》上传资料 a.pdf 等 3 个文件'
  changes: [
    { path: 'static/documents/courses/modern-physics-lab/photoelectric.pdf', content: Blob, baseSha: null },  // 替换已有文件时是它的 sha
    { path: 'static/documents/courses/modern-physics-lab/franck-hertz.pdf',  content: Blob, baseSha: null },
    { path: 'static/documents/courses/modern-physics-lab/实验数据.xlsx',     content: Blob, baseSha: null },
    { path: 'content/courses/modern-physics-lab/photoelectric.md', content: itemDocument(…), baseSha: null },
    { path: 'content/courses/modern-physics-lab/franck-hertz.md',  content: itemDocument(…), baseSha: null },
  ],
  summary: ['上传 …（大小）', …, '新增子推文 …《标题》', …],
  viewUrl: '<站点>/courses/modern-physics-lab/', viewLabel: '查看课程',
}
```

- 子推文：`weight` = `nextWeights(现有 weight, n)`（最大 20 → 30、40…；没有 → 10、20…）；文件名 = `itemSlugFor(标题, 原文件名, 已占用)`
  （标题有英文字母就用标题，否则用文件名，再不行 `item-<标题里的数字>`；重名加 -2）；正文 = `itemBodyFor`：PDF → `{{< pdf "<网站路径>" >}}`，
  图片 → `![标题](路径)`，其他 → `[下载 文件名](路径)`。front matter 由 `itemDocument` 生成（`title, weight, description?, draft: false`）。
- 冲突或失败：这一批保留在 `state.pendingBatch`，页面顶部出现「重新检查并上传」/「放弃」；重试时从压缩后的名字重新检查（必要时先 `repo.load()`），
  不会重复上传已成功的提交（第 3 节）。有未完成的一批时 `canLeave` 会确认。

**共用模块**

- `uploads.js`：「资料」页（`files.js`）、「课程」页、编辑器共用。新增上传入口时请复用 `checkUploads` / `uploadReviewSections` / `refusedContent`，
  至少调用 `uploadBlockReason`（第 4 节）。`files.js` 仍然导出 `parseGitignore` / `createIgnoreMatcher`（实现已移到这里），旧测试不用改。
- `courses.js`：纯函数，Node 里可直接导入测试；视图只做界面和 `ctx.publish`。

**测试**

- 单元：`tests/admin/courses.test.mjs`（路径、排序 / 分组 / reweight / nextWeights、标题和网址、新文件模板、子推文正文、草稿 cascade、删除计划，以及 `uploads: blocked types`）。
- `node tests/admin/e2e-courses.mjs`（`COURSES_E2E_DIR`）：后台「课程」页的完整流程，检查提交内容（字节级的 PDF、精确的 front matter、只改 weight 那一行），最后用 Hugo 构建导出的仓库。
- `node tests/admin/e2e-courses-site.mjs`（`COURSES_SITE_E2E_DIR`）：只测网站模板，用 mock 写入固定的课程夹具（不碰真实 `content/`），构建「有分组」「无分组」两个版本和一个边界情况版本（草稿课程、嵌套子栏目、`materialsDir`、只差大小写的分组名……），并要求构建没有 WARN / ERROR。
- 拒绝上传的类型：`e2e-files.mjs`、`e2e-courses.mjs`、`e2e-editor.mjs` 都有用例；`e2e-journey.mjs` 里也有新建「近代物理实验」并批量上传两份实验报告的步骤。
