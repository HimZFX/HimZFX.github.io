# 管理后台测试（tests/admin）

这里是 `/admin/` 管理后台的测试。全部只用 Node 内置模块 + 预装的 Playwright，**不需要 `npm install`**，
也**不会访问真正的 GitHub**：所有接口都打到本地的「假 GitHub」（`mock-github.mjs`）上。

## 运行

在仓库根目录执行：

```bash
# 单元测试（*.test.mjs）—— 两种写法等价
node --test tests/admin/
node --test tests/admin/*.test.mjs

# 只跑某一个
node --test tests/admin/mock.test.mjs

# 端到端测试（Playwright + Chromium，每个界面一个脚本）
node tests/admin/e2e-shell.mjs
node tests/admin/e2e-editor.mjs
# … e2e-lists / e2e-profile / e2e-background / e2e-files

# 跨界面的完整使用流程（登录 → 写文章 + 英文版 → 上传资料并在文章里链接 → 换头像和简介 →
# 换背景动画 → 调整菜单 → 删除草稿 → Hugo 构建后检查两种语言的网站）
node tests/admin/e2e-journey.mjs
```

每个 e2e 脚本都会把 Hugo 构建结果和截图放进自己的目录（默认在系统临时目录下），可以用环境变量指定：
`SHELL_E2E_DIR`、`EDITOR_E2E_DIR`、`LISTS_E2E_DIR`、`PROFILE_E2E_DIR`、`BG_E2E_DIR`、`FILES_E2E_DIR`、`JOURNEY_E2E_DIR`。

> 说明：Node 22 的 `node --test <目录>` 并不会去目录里找测试文件，而是把目录当成模块运行，
> 所以这里放了一个 `index.js`，由它依次加载本目录的全部 `*.test.mjs`。
> e2e 脚本（`e2e-*.mjs`）不是 `*.test.mjs`，不会被单元测试命令误跑。

## 环境变量

| 变量 | 作用 | 默认值 |
|---|---|---|
| `HUGO_BIN` | Hugo 可执行文件（需与 CI 相同：0.147.4 extended） | `/tmp/claude-0/-home-user-HimZFX-github-io/8c969300-4668-5db9-ba53-1e03ed6529c8/scratchpad/hugo/hugo` |
| `ADMIN_TEST_TMP` | `mock.test.mjs` 存放导出 / 构建结果的目录 | 系统临时目录 |

找不到 Hugo 时，依赖 Hugo 的测试会自动跳过；找不到 Playwright 时，浏览器测试会跳过。

## 假 GitHub（mock-github.mjs）做了什么

- **内存里的 git 仓库**：启动时把工作区文件（`git ls-files --cached --others --exclude-standard`，
  不含 `themes/` 子模块内容）放进 `main` 分支。blob / tree / commit 的 SHA-1 与真实 git 完全一致。
- **模拟 GitHub REST 接口**（挂在 `/__mockapi` 下）：`/user`、`/repos/{o}/{r}`、`git/ref`、`git/commits`、
  `git/trees`（支持 `base_tree` 与 `sha: null` 删除）、`git/blobs`（返回带换行的 base64，与 GitHub 相同）、
  `PATCH git/refs`（非快进返回 422 `Update is not a fast forward`）、`actions/runs`（部署状态在
  `runDelayMs` 内从 queued → in_progress → completed）。令牌错误返回 401，带 `x-ratelimit-remaining` 头，
  GET 响应和 GitHub 一样带 `Cache-Control: private, max-age=60`（所以会变化的数据必须用 `cache: 'no-store'` 读取）。
- **静态网站**：把 Hugo 构建结果（`siteDir`）挂在 `/`，MIME 类型正确（`.js/.mjs` → `text/javascript`），
  目录自动用 `index.html`、缺斜杠时 301 补上、防目录穿越。网站和接口同源，所以后台的 CSP 不用改。
- **辅助函数**：
  - `startMock({ seedDir, siteDir, port, token, runDelayMs })` → `{ url, apiBase, token, commits, files(), readFile(), setFile(), exportTo(), close() … }`
  - `mock.setFile(path, content)`：模拟「别人在 GitHub 上改了文件」（用于测试冲突提示）；`content = null` 表示删除。
  - `mock.commits`：后台通过接口提交的记录（含 `message` 和改动文件列表 `changes`）。
  - `exportTo(dir)` + `buildSite({ repoDir, outDir })`：把当前内容导出并用固定版本 Hugo 构建（主题自动软链接）。
  - `openAdmin(page, mock, { remember })`：在 Playwright 页面里自动登录后台，并拦截所有外部请求。
  - 错误场景开关：`setToken`、`setRateLimitRemaining`、`setActionsAccess`、`setRunConclusion`、
    `setRunDelay`、`setApiDelay`、`setPermissions`、`failNext`（让下一次请求失败或断网）。

### e2e 脚本推荐写法

```js
import { createRequire } from 'node:module';
import { startMock, buildSite, openAdmin, REPO_ROOT } from './mock-github.mjs';
const { chromium } = createRequire(import.meta.url)('playwright');

const siteDir = '/你自己的临时目录/site';            // 不要放在仓库里
const mock = await startMock({ siteDir });          // siteDir 可以稍后再构建
await buildSite({ repoDir: REPO_ROOT, outDir: siteDir, baseURL: mock.url + '/' });
const browser = await chromium.launch();
const page = await browser.newPage();
await openAdmin(page, mock);                         // 已登录，界面就绪
// … 操作界面，然后检查 mock.commits / mock.readFile(...)
await browser.close();
await mock.close();
```
