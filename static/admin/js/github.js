/**
 * github.js — 极简 GitHub REST API 客户端（管理后台专用）。
 *
 * 设计要点：
 * - 令牌只发往 apiBase（由调用方按安全规则计算后传入），从不出现在 URL / 日志里。
 * - 所有错误统一成 GitHubError，message 是给用户看的中文提示，status 保留 HTTP 状态码
 *   （网络错误 status = 0）。
 * - 导入时不访问 window / document，可在 Node 22 测试中直接使用。
 *
 * @module github
 */

const DEFAULT_API_BASE = 'https://api.github.com';
const API_VERSION = '2022-11-28';

/** 可变资源（分支指针、Actions 状态、用户信息）绝不能读到浏览器缓存里的旧值。 */
const CACHE_FRESH = 'no-store';
/** 按 sha 寻址的 git 对象永不改变，允许浏览器缓存。 */
const CACHE_IMMUTABLE = 'default';

/** 读取 / 上传文件内容的请求可能很大，不设超时（慢网络下上传 50 MB 也要能完成）。 */
const NO_TIMEOUT = 0;

/**
 * GitHub 接口错误。message 是可以直接展示给用户的中文。
 */
export class GitHubError extends Error {
  /**
   * @param {string} message 面向用户的中文提示
   * @param {{ status?: number, path?: string, data?: any, cause?: any }} [info]
   */
  constructor(message, { status, path, data, cause } = {}) {
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = 'GitHubError';
    /** HTTP 状态码；网络错误为 0 */
    this.status = status;
    /** 出错的 API 路径或仓库文件路径 */
    this.path = path;
    /** GitHub 返回的 JSON（若有） */
    this.data = data;
  }
}

/**
 * GitHub REST API 客户端。
 *
 * 额外（非规范要求、可选）的构造参数：
 * - retryDelayMs：GET 等幂等请求遇到网络错误 / 502-504 时，重试前的等待（默认 800ms）。
 * - timeoutMs：普通请求的超时（默认 60s；读取/上传文件内容的请求不设超时）。
 */
export class GitHubClient {
  #token;
  #fetch;
  #apiBase;
  #retryDelayMs;
  #timeoutMs;

  /**
   * @param {{ token: string, owner: string, repo: string, branch?: string, apiBase?: string,
   *           fetch?: typeof fetch, retryDelayMs?: number, timeoutMs?: number }} options
   */
  constructor({ token, owner, repo, branch = 'main', apiBase = DEFAULT_API_BASE, fetch,
                retryDelayMs = 800, timeoutMs = 60000 } = {}) {
    if (!owner || !repo) throw new TypeError('GitHubClient: owner and repo are required');
    this.owner = String(owner);
    this.repo = String(repo);
    this.branch = String(branch || 'main');
    // 用户粘贴令牌时常带空格/换行，去掉。
    this.#token = String(token == null ? '' : token).trim();

    const base = String(apiBase || DEFAULT_API_BASE).replace(/\/+$/, '');
    let parsed;
    try { parsed = new URL(base); } catch { parsed = null; }
    if (!parsed || (parsed.protocol !== 'https:' && parsed.protocol !== 'http:')) {
      throw new TypeError('GitHubClient: invalid apiBase');
    }
    this.#apiBase = base;

    const impl = fetch || (typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : null);
    // 以普通函数调用，避免未绑定的 window.fetch 抛 "Illegal invocation"。
    this.#fetch = impl ? (...args) => impl(...args) : null;
    this.#retryDelayMs = Math.max(0, Number(retryDelayMs) || 0);
    this.#timeoutMs = Math.max(0, Number(timeoutMs) || 0);
  }

  /** API 根地址（只读）。 */
  get apiBase() { return this.#apiBase; }

  /** 不要让 console.log / JSON.stringify 意外带出令牌（私有字段本身就不会被序列化）。 */
  toJSON() { return { owner: this.owner, repo: this.repo, branch: this.branch, apiBase: this.#apiBase }; }

  /** `/repos/{owner}/{repo}` 前缀 */
  get #repoPath() {
    return `/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}`;
  }

  /** `heads/<branch>`，分支名中的 '/' 保留 */
  get #headRef() {
    return 'heads/' + this.branch.split('/').map(encodeURIComponent).join('/');
  }

  /**
   * 发送一个 JSON 请求。
   * @param {string} method  'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'
   * @param {string} path    以 '/' 开头的 API 路径，例如 `/repos/o/r/git/trees/<sha>`
   * @param {any} [body]     会被 JSON 编码
   * @param {{ cache?: RequestCache, retry?: number, timeoutMs?: number }} [opts] 内部使用的调优参数
   * @returns {Promise<any>} 解析后的 JSON（无内容时为 null）
   */
  async request(method, path, body, opts = {}) {
    method = String(method || 'GET').toUpperCase();
    if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//')) {
      throw new TypeError('GitHubClient.request: path must start with a single "/"');
    }
    const url = this.#apiBase + path;
    // 防御：拼出来的地址必须仍然指向 apiBase（令牌绝不发往别处）。
    if (new URL(url).origin !== new URL(this.#apiBase).origin) {
      throw new TypeError('GitHubClient.request: refusing to send token to another origin');
    }
    if (!this.#token) {
      throw new GitHubError('令牌无效或已过期，请重新登录', { status: 401, path });
    }
    if (/[^\x21-\x7e]/.test(this.#token)) {
      // 含中文/全角字符的令牌会让 fetch 直接抛 TypeError，提前给出清楚的提示。
      throw new GitHubError('令牌格式不正确，请重新复制粘贴', { status: 401, path });
    }
    if (!this.#fetch) throw new GitHubError('网络错误，无法连接 GitHub', { status: 0, path });

    const headers = {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': API_VERSION,
      Authorization: `Bearer ${this.#token}`,
    };
    let payload;
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const retries = opts.retry ?? (method === 'GET' ? 1 : 0);
    const timeoutMs = opts.timeoutMs ?? this.#timeoutMs;

    for (let attempt = 0; ; attempt++) {
      const timer = makeTimeout(timeoutMs);
      const init = {
        method,
        headers,
        body: payload,
        cache: opts.cache || CACHE_FRESH,
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
      };
      if (timer.signal) init.signal = timer.signal;

      let res;
      let text;
      try {
        res = await this.#fetch(url, init);
        text = await res.text();
      } catch (err) {
        timer.clear();
        if (attempt < retries) { await sleep(this.#retryDelayMs * (attempt + 1)); continue; }
        const timedOut = timer.fired || (err && (err.name === 'AbortError' || err.name === 'TimeoutError'));
        throw new GitHubError(timedOut ? '网络超时，GitHub 没有响应，请稍后再试' : '网络错误，无法连接 GitHub',
          { status: 0, path, cause: err });
      }
      timer.clear();

      let data = null;
      let parseFailed = false;
      if (text) {
        try { data = JSON.parse(text); } catch { parseFailed = true; data = text; }
      }

      if (res.ok) {
        if (parseFailed) throw new GitHubError('GitHub 返回了无法识别的数据', { status: res.status, path });
        return data;
      }
      if ((res.status === 502 || res.status === 503 || res.status === 504) && attempt < retries) {
        await sleep(this.#retryDelayMs * (attempt + 1));
        continue;
      }
      throw new GitHubError(errorMessage(res.status, res.headers, data), { status: res.status, path, data });
    }
  }

  /** GET /repos/{o}/{r} → 原始 JSON（含 permissions.push、default_branch） */
  async getRepo() {
    return this.request('GET', this.#repoPath);
  }

  /** GET /user → { login, avatarUrl, name } */
  async getUser() {
    const u = await this.request('GET', '/user');
    return { login: u && u.login, avatarUrl: (u && u.avatar_url) || '', name: (u && u.name) || '' };
  }

  /**
   * 当前分支最新提交。
   * @returns {Promise<{ commitSha: string, treeSha: string }>}
   */
  async getBranchHead() {
    const ref = await this.request('GET', `${this.#repoPath}/git/ref/${this.#headRef}`);
    const commitSha = ref && ref.object && ref.object.sha;
    if (!commitSha) throw new GitHubError('GitHub 返回了无法识别的数据', { status: 200, path: 'ref', data: ref });
    const commit = await this.request('GET', `${this.#repoPath}/git/commits/${encodeURIComponent(commitSha)}`,
      undefined, { cache: CACHE_IMMUTABLE });
    const treeSha = commit && commit.tree && commit.tree.sha;
    if (!treeSha) throw new GitHubError('GitHub 返回了无法识别的数据', { status: 200, path: 'commit', data: commit });
    return { commitSha, treeSha };
  }

  /**
   * 递归读取整棵树。只保留 blob 和 tree（子模块的 'commit' 条目被丢弃）。
   * 返回的数组额外带两个属性：`truncated`（GitHub 是否截断了结果）和
   * `submodules`（被丢弃的子模块路径，供 Repo 拒绝写入子模块）。
   * @param {string} treeSha
   * @returns {Promise<Array<{ path: string, type: 'blob'|'tree', sha: string, size?: number, mode: string }>>}
   */
  async getTree(treeSha) {
    const data = await this.request('GET',
      `${this.#repoPath}/git/trees/${encodeURIComponent(treeSha)}?recursive=1`, undefined,
      { cache: CACHE_IMMUTABLE, timeoutMs: NO_TIMEOUT });
    const out = [];
    const submodules = [];
    for (const e of (data && Array.isArray(data.tree) ? data.tree : [])) {
      if (e.type === 'blob' || e.type === 'tree') {
        const item = { path: e.path, type: e.type, sha: e.sha, mode: e.mode };
        if (e.type === 'blob') item.size = typeof e.size === 'number' ? e.size : 0;
        out.push(item);
      } else if (e.type === 'commit') {
        submodules.push(e.path);
      }
    }
    Object.defineProperty(out, 'truncated', { value: !!(data && data.truncated) });
    Object.defineProperty(out, 'submodules', { value: submodules });
    return out;
  }

  /**
   * 读取文件内容（按 blob sha）。
   * @param {string} sha
   * @returns {Promise<Uint8Array>}
   */
  async getBlob(sha) {
    const data = await this.request('GET', `${this.#repoPath}/git/blobs/${encodeURIComponent(sha)}`,
      undefined, { cache: CACHE_IMMUTABLE, timeoutMs: NO_TIMEOUT });
    if (!data || typeof data.content !== 'string') {
      throw new GitHubError('GitHub 返回了无法识别的数据', { status: 200, path: sha, data });
    }
    if (data.encoding === 'utf-8' || data.encoding === 'utf8') return new TextEncoder().encode(data.content);
    try {
      return decodeBase64(data.content);
    } catch (err) {
      throw new GitHubError('GitHub 返回了无法识别的数据', { status: 200, path: sha, cause: err });
    }
  }

  /**
   * 上传文件内容，返回 blob sha。
   * @param {Uint8Array|ArrayBuffer|string} bytes
   * @returns {Promise<string>}
   */
  async createBlob(bytes) {
    const data = await this.request('POST', `${this.#repoPath}/git/blobs`,
      { content: encodeBase64(bytes), encoding: 'base64' },
      // blob 是内容寻址的，重复创建无副作用，网络抖动时可以安全重试一次。
      { retry: 1, timeoutMs: NO_TIMEOUT });
    return requireSha(data, 'blob');
  }

  /**
   * 基于 baseTreeSha 创建新树。
   * @param {string|null} baseTreeSha
   * @param {Array<{ path: string, sha: string|null, mode?: string }>} entries sha=null 表示删除；
   *        mode 默认 '100644'（可选扩展：传入 '100755' 保留可执行位）
   * @returns {Promise<string>} 新树的 sha
   */
  async createTree(baseTreeSha, entries) {
    const tree = (entries || []).map((e) => {
      if (e.sha === undefined) throw new TypeError(`createTree: entry ${e.path} has no sha`);
      return { path: e.path, mode: e.mode || '100644', type: 'blob', sha: e.sha };
    });
    const body = { tree };
    if (baseTreeSha) body.base_tree = baseTreeSha;
    const data = await this.request('POST', `${this.#repoPath}/git/trees`, body, { retry: 1 });
    return requireSha(data, 'tree');
  }

  /**
   * 创建提交对象（作者默认为令牌所属用户）。
   * @param {string} message
   * @param {string} treeSha
   * @param {string|null} parentSha
   * @returns {Promise<string>} 新提交的 sha
   */
  async createCommit(message, treeSha, parentSha) {
    const data = await this.request('POST', `${this.#repoPath}/git/commits`,
      { message, tree: treeSha, parents: parentSha ? [parentSha] : [] },
      // 未被引用的提交对象只是垃圾，重试安全。
      { retry: 1 });
    return requireSha(data, 'commit');
  }

  /**
   * 把分支指向新提交（非强制，必须是快进）。分支已被别人更新时 GitHub 返回 422。
   * @param {string} commitSha
   */
  async updateRef(commitSha) {
    return this.request('PATCH', `${this.#repoPath}/git/refs/${this.#headRef}`,
      { sha: commitSha, force: false }, { retry: 0 });
  }

  /**
   * 某个提交触发的 Actions 运行。
   * @param {string} headSha
   * @returns {Promise<Array<{ id: number, status: string, conclusion: string|null, htmlUrl: string, name: string }>>}
   */
  async listWorkflowRuns(headSha) {
    const data = await this.request('GET',
      `${this.#repoPath}/actions/runs?head_sha=${encodeURIComponent(headSha)}&per_page=10`);
    const runs = data && Array.isArray(data.workflow_runs) ? data.workflow_runs : [];
    return runs.map((r) => ({
      id: r.id,
      status: r.status,
      conclusion: r.conclusion == null ? null : r.conclusion,
      htmlUrl: r.html_url || '',
      name: r.name || '',
    }));
  }
}

// ---------------------------------------------------------------------------
// 错误信息

function errorMessage(status, headers, data) {
  const ghMessage = data && typeof data === 'object' && typeof data.message === 'string' ? data.message : '';
  if (status === 401) return '令牌无效或已过期，请重新登录';
  if (isRateLimited(status, headers, ghMessage)) return 'GitHub 接口调用次数已用完，请稍后再试';
  if (status === 403) return '令牌没有足够的权限（需要本仓库的 Contents 读写权限）';
  if (status === 404) return '找不到仓库或文件（请确认令牌授权了这个仓库）';
  if (status === 409 || status === 422) return describeGitHubMessage(data) || `GitHub 请求失败（${status}）`;
  return `GitHub 请求失败（${status}）`;
}

function isRateLimited(status, headers, ghMessage) {
  if (status !== 403 && status !== 429) return false;
  const remaining = headers && typeof headers.get === 'function' ? headers.get('x-ratelimit-remaining') : null;
  if (remaining !== null && remaining !== undefined && String(remaining).trim() === '0') return true;
  if (status === 429) return true;
  // 二级限流：403 + "You have exceeded a secondary rate limit"
  return /rate limit/i.test(ghMessage);
}

/** 保留 GitHub 原始信息，并附上 errors[] 中的细节（422 Validation Failed 时有用）。 */
function describeGitHubMessage(data) {
  if (!data || typeof data !== 'object') return '';
  const msg = typeof data.message === 'string' ? data.message : '';
  const details = Array.isArray(data.errors)
    ? data.errors.map((e) => (typeof e === 'string' ? e : e && (e.message || e.code))).filter(Boolean)
    : [];
  if (details.length && msg) return `${msg}（${details.join('；')}）`;
  return msg || details.join('；');
}

function requireSha(data, what) {
  if (!data || typeof data.sha !== 'string') {
    throw new GitHubError('GitHub 返回了无法识别的数据', { status: 200, path: what, data });
  }
  return data.sha;
}

// ---------------------------------------------------------------------------
// 工具

function sleep(ms) {
  return ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve();
}

function makeTimeout(ms) {
  if (!ms || typeof AbortController !== 'function') return { signal: null, clear() {}, fired: false };
  const ctrl = new AbortController();
  const t = { signal: ctrl.signal, fired: false, clear() { clearTimeout(id); } };
  const id = setTimeout(() => { t.fired = true; ctrl.abort(); }, ms);
  return t;
}

/** @returns {Uint8Array} */
function toUint8Array(input) {
  if (input instanceof Uint8Array) return input;
  if (typeof input === 'string') return new TextEncoder().encode(input);
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  throw new TypeError('expected Uint8Array, ArrayBuffer or string');
}

// 每块字节数是 3 的倍数，这样各块的 base64 可以直接拼接（中间不会出现 '='）。
const ENCODE_CHUNK = 3 * 0x8000;       // 98 304 字节
// String.fromCharCode.apply 的参数个数要远小于调用栈上限。
const APPLY_CHUNK = 0x2000;            // 8192
// 解码时每块字符数是 4 的倍数。
const DECODE_CHUNK = 4 * 0x4000;       // 65 536 字符

/**
 * 字节 → base64（分块处理，几十 MB 也不会爆栈）。
 * @param {Uint8Array|ArrayBuffer|string} input 字符串按 UTF-8 编码
 * @returns {string}
 */
export function encodeBase64(input) {
  const bytes = toUint8Array(input);
  if (typeof bytes.toBase64 === 'function') return bytes.toBase64();   // 新浏览器原生实现
  const parts = [];
  for (let i = 0; i < bytes.length; i += ENCODE_CHUNK) {
    const chunk = bytes.subarray(i, Math.min(i + ENCODE_CHUNK, bytes.length));
    let bin = '';
    for (let j = 0; j < chunk.length; j += APPLY_CHUNK) {
      bin += String.fromCharCode.apply(null, chunk.subarray(j, Math.min(j + APPLY_CHUNK, chunk.length)));
    }
    parts.push(btoa(bin));
  }
  return parts.join('');
}

/**
 * base64 → 字节。会忽略空白（GitHub 每 60 个字符插入一个换行），允许省略末尾的 '='。
 * @param {string} b64
 * @returns {Uint8Array}
 */
export function decodeBase64(b64) {
  if (typeof b64 !== 'string') throw new TypeError('decodeBase64: expected a string');
  const s = b64.replace(/\s+/g, '');
  let end = s.length;
  while (end > 0 && s.charCodeAt(end - 1) === 61 /* '=' */) end--;
  if (s.length - end > 2 || end % 4 === 1 || /[^A-Za-z0-9+/]/.test(s.slice(0, end))) {
    throw new Error('无效的 base64 数据');
  }
  const out = new Uint8Array(Math.floor((end * 3) / 4));
  let o = 0;
  for (let i = 0; i < end; i += DECODE_CHUNK) {
    const bin = atob(s.slice(i, Math.min(i + DECODE_CHUNK, end)));
    for (let j = 0; j < bin.length; j++) out[o++] = bin.charCodeAt(j);
  }
  return out;
}
