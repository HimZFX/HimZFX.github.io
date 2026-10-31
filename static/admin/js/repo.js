/**
 * repo.js — 仓库的本地视图 + 原子提交 + 部署状态轮询。
 *
 * - load() 读取 main 分支最新提交的完整文件树（只保留文件），之后 list/entry/has 都是同步的。
 * - commit() 把一组修改作为「一个」提交推到 main：
 *     最新 head → 最新树 → 冲突检查（baseSha）→ 上传 blob（最多 4 个并发）→ 建树 → 建提交 → 移动分支。
 *   分支在这期间被别人移动（409/422）时，整个流程自动重来一次。
 * - watchDeploy() 轮询 GitHub Actions，告诉界面「部署中 / 已上线 / 失败」。
 *
 * 导入时不访问 window / document。
 *
 * @module repo
 */

import { GitHubError } from './github.js';

/** 单个文件上限（GitHub Git Data API 的硬限制是 100 MB）。 */
const MAX_BLOB_BYTES = 100 * 1024 * 1024;
/** 内存里缓存的单个文件上限，以及总预算（避免一直占着几十 MB 的图片）。 */
const MEM_CACHE_MAX_ITEM = 1024 * 1024;
const MEM_CACHE_BUDGET = 24 * 1024 * 1024;
/** 同时上传的 blob 数量上限。 */
const UPLOAD_CONCURRENCY = 4;
/** GitHub 读副本的延迟通常只有几秒；超过这个时间就完全相信服务器返回的分支指针。 */
const STALE_REF_WINDOW_MS = 2 * 60 * 1000;

/**
 * 文件在你编辑期间被别人（或另一个浏览器标签页）改过。
 * `paths`：冲突的文件路径；`details`：[{ path, expected, actual }]（actual=null 表示文件现在不存在）。
 */
export class ConflictError extends Error {
  /**
   * @param {string[]} paths
   * @param {Array<{ path: string, expected: string|null, actual: string|null }>} [details]
   */
  constructor(paths = [], details = []) {
    super('有文件在你编辑期间被修改了');
    this.name = 'ConflictError';
    this.paths = paths;
    this.details = details;
  }
}

/**
 * 仓库（main 分支）的本地视图。
 */
export class Repo {
  /**
   * @param {import('./github.js').GitHubClient} client
   * @param {{ blobCache?: { get(sha: string): Promise<Uint8Array|undefined>, set(sha: string, bytes: Uint8Array): any },
   *           retryDelayMs?: number }} [options]
   *        retryDelayMs（可选扩展）：分支被移动后重试前的等待，默认 1000ms，测试里设为 0。
   */
  constructor(client, { blobCache, retryDelayMs = 1000 } = {}) {
    if (!client) throw new TypeError('Repo: client is required');
    this.client = client;
    /** 当前 head 提交 sha（load 之前为 null） */
    this.commitSha = null;
    /** 当前 head 的根树 sha */
    this.treeSha = null;

    this._blobs = new Map();          // path → { path, sha, size, mode }
    this._sorted = null;              // 排序后的缓存，修改树时置空
    this._submodules = [];
    this._truncated = false;
    this._blobCache = blobCache || null;
    this._mem = new Map();            // sha → Uint8Array（小文件）
    this._memBytes = 0;
    this._inflight = new Map();       // sha → Promise<Uint8Array>
    this._listeners = new Set();
    this._queue = Promise.resolve();  // load/commit 串行执行
    this._superseded = new Map();     // 被我们自己的提交「快进」掉的旧 head → 时间（用于识别读到的旧分支指针）
    this._maybeLanded = new Map();    // 「移动分支」的响应丢了的提交写入的内容：path → blob sha（null = 删除）
    this._retryDelayMs = Math.max(0, Number(retryDelayMs) || 0);
  }

  // -------------------------------------------------------------------------
  // 读取

  /**
   * 读取最新 head 和完整文件树，替换本地缓存。
   * @returns {Promise<Repo>}
   */
  async load() {
    return this._exclusive(async () => {
      const head = await this._latestHead();
      const tree = await this.client.getTree(head.treeSha);
      if (tree.truncated) console.warn('[repo] GitHub truncated the tree listing; some files are not shown');
      this._setState(head, blobMapFromTree(tree), tree.submodules || [], !!tree.truncated);
      this._emit({ type: 'load', commitSha: this.commitSha, paths: [] });
      return this;
    });
  }

  /**
   * 以 prefix 开头的文件（目录前缀请以 '/' 结尾），按路径排序。
   * @param {string} [prefix]
   * @returns {Array<{ path: string, sha: string, size: number }>}
   */
  list(prefix = '') {
    if (!this._sorted) {
      this._sorted = [...this._blobs.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    }
    const p = String(prefix || '').replace(/^\/+/, '');
    const out = [];
    for (const e of this._sorted) {
      if (e.path.startsWith(p)) out.push({ path: e.path, sha: e.sha, size: e.size });
    }
    return out;
  }

  /**
   * @param {string} path
   * @returns {{ path: string, sha: string, size: number } | undefined}
   */
  entry(path) {
    const e = this._blobs.get(stripLeadingSlash(path));
    return e ? { path: e.path, sha: e.sha, size: e.size } : undefined;
  }

  /** 文件是否存在（只针对文件，不针对文件夹）。 */
  has(path) {
    return this._blobs.has(stripLeadingSlash(path));
  }

  /**
   * 读取文件字节（先查内存 / blobCache，再请求 GitHub）。
   * @param {string} path
   * @returns {Promise<Uint8Array>}
   */
  async readBytes(path) {
    const p = stripLeadingSlash(path);
    const e = this._blobs.get(p);
    if (!e) throw new GitHubError(`找不到文件：${p}`, { status: 404, path: p });
    return this._readBlob(e.sha, e.size);
  }

  /**
   * 读取文本文件（UTF-8）。
   * @param {string} path
   * @returns {Promise<string>}
   */
  async readText(path) {
    return new TextDecoder('utf-8').decode(await this.readBytes(path));
  }

  // -------------------------------------------------------------------------
  // 提交

  /**
   * 把一组修改作为一个提交发布到分支。
   *
   * changes 的每一项：
   *   { path, content: string | Uint8Array | ArrayBuffer | Blob, baseSha? }   写入
   *   { path, delete: true, baseSha? }                                       删除
   * baseSha：undefined = 不检查；null = 文件必须不存在；'<sha>' = 文件当前必须是这个 sha。
   * 同一路径出现多次时，以最后一次为准（每一次的 baseSha 都会检查）。
   *
   * 可选扩展：onProgress({ phase: 'prepare'|'check'|'upload'|'commit'|'done', done?, total?, path? })。
   *
   * @param {{ message: string, changes: Array<object>, onProgress?: Function }} params
   * @returns {Promise<{ commitSha: string, shas: Record<string, string>, unchanged?: boolean }>}
   * @throws {ConflictError} 有 baseSha 不符合
   * @throws {GitHubError}   GitHub 接口错误（message 为中文）
   */
  async commit({ message, changes, onProgress } = {}) {
    const progress = safeCallback(onProgress);
    const msg = String(message == null ? '' : message).trim() || 'admin: 更新网站内容';
    if (!Array.isArray(changes) || changes.length === 0) throw new Error('没有需要发布的修改');
    progress({ phase: 'prepare' });
    // 在拿锁之前把 Blob 读成字节、检查路径，避免持锁时间过长。
    const prepared = await prepareChanges(changes);
    return this._exclusive(() => this._commitLocked(msg, prepared, progress));
  }

  async _commitLocked(message, { ops, checks }, progress) {
    const uploaded = new Map();   // path → blob sha（重试时复用，不必重新上传）
    const finalOps = new Map(ops.map((o) => [o.path, o]));

    for (let attempt = 0; ; attempt++) {
      if (attempt > 0) await sleep(this._retryDelayMs);
      progress({ phase: 'check' });

      // 1. 最新 head + 最新树（冲突检查必须基于「现在」的分支，而不是 load() 时的）
      const head = await this._latestHead();
      const tree = await this.client.getTree(head.treeSha);
      if (tree.truncated) {
        throw new GitHubError('仓库文件太多，无法安全地检查冲突，已取消发布', { status: 0 });
      }
      const latest = blobMapFromTree(tree);
      const dirs = new Set(tree.filter((e) => e.type === 'tree').map((e) => e.path));
      const submodules = tree.submodules || [];

      // 2. 结构检查（子模块、文件/文件夹冲突）——这些是程序错误或误操作，直接拒绝
      for (const op of ops) {
        const sm = submodules.find((s) => op.path === s || op.path.startsWith(s + '/'));
        if (sm) throw new Error(`不能修改子模块（${sm}）里的文件：${op.path}`);
        if (op.delete) continue;
        if (dirs.has(op.path)) throw new Error(`「${op.path}」是一个文件夹，不能当作文件写入`);
        const segs = op.path.split('/');
        for (let i = 1; i < segs.length; i++) {
          const parent = segs.slice(0, i).join('/');
          if (latest.has(parent)) throw new Error(`「${parent}」是一个文件，不能在它下面创建「${op.path}」`);
        }
      }

      // 3. 冲突检查
      //    「已经是我们想要的结果」不算冲突：上一次发布其实成功了、只是响应在路上丢了（手机断网、
      //    GitHub 502），用户再点一次发布时，文件现在的版本就是我们自己写进去的。
      //    同理，文件现在的版本是我们那次「不确定是否成功」的提交写入的，也不算别人的修改。
      const conflicts = [];
      let matched = 0;
      for (const c of checks) {
        const cur = latest.get(c.path);
        let ok = c.baseSha === null ? !cur : !!cur && cur.sha === c.baseSha;
        if (!ok && (alreadyAs(finalOps.get(c.path), cur) || this._isOwnEarlierWrite(c.path, cur))) {
          ok = true;
          matched++;
        }
        if (!ok) conflicts.push({ path: c.path, expected: c.baseSha, actual: cur ? cur.sha : null });
      }
      if (conflicts.length) {
        throw new ConflictError([...new Set(conflicts.map((c) => c.path))], conflicts);
      }

      const writes = ops.filter((o) => !o.delete);
      // 删除不存在的文件：静默跳过（GitHub 对这种条目会报错）。
      const deletes = ops.filter((o) => o.delete && latest.has(o.path));

      // 4. 上传 blob（最多 4 个并发）；网站上已经是这份内容的文件不必再上传
      for (const w of writes) {
        const cur = latest.get(w.path);
        if (!uploaded.has(w.path) && w.sha && cur && cur.sha === w.sha) uploaded.set(w.path, w.sha);
      }
      const pending = writes.filter((w) => !uploaded.has(w.path));
      let done = writes.length - pending.length;
      if (pending.length) progress({ phase: 'upload', done, total: writes.length });
      await runPool(pending, UPLOAD_CONCURRENCY, async (w) => {
        const sha = await this.client.createBlob(w.bytes);
        uploaded.set(w.path, sha);
        done++;
        progress({ phase: 'upload', done, total: writes.length, path: w.path });
      });

      const shas = {};
      for (const w of writes) shas[w.path] = uploaded.get(w.path);

      const treeEntries = [
        ...writes
          .filter((w) => { const cur = latest.get(w.path); return !cur || cur.sha !== uploaded.get(w.path) || cur.mode !== writeMode(cur); })
          .map((w) => ({ path: w.path, sha: uploaded.get(w.path), mode: writeMode(latest.get(w.path)) })),
        ...deletes.map((d) => ({ path: d.path, sha: null, mode: latest.get(d.path).mode || '100644' })),
      ];

      // 5. 建树；树没变（内容和现在完全一样）就不产生空提交
      progress({ phase: 'commit' });
      const newTreeSha = treeEntries.length ? await this.client.createTree(head.treeSha, treeEntries) : head.treeSha;
      if (newTreeSha === head.treeSha) {
        this._setState(head, latest, submodules, false);
        this._emit({ type: 'commit', commitSha: head.commitSha, paths: [] });
        progress({ phase: 'done' });
        // alreadyApplied：有文件的 baseSha 对不上，但网站上已经正是这次要发布的内容（上一次其实成功了）
        return matched ? { commitSha: head.commitSha, shas, unchanged: true, alreadyApplied: true }
          : { commitSha: head.commitSha, shas, unchanged: true };
      }

      // 6. 建提交 + 移动分支
      const newCommitSha = await this.client.createCommit(message, newTreeSha, head.commitSha);
      try {
        await this.client.updateRef(newCommitSha);
      } catch (err) {
        const status = err && err.status;
        if ((status === 409 || status === 422) && attempt === 0) continue;   // 分支被移动：整体重来一次
        if (!(status === 0 || status >= 500)) throw friendlyRefError(err, this.client.branch);
        // 网络断了 / 5xx：请求可能其实已经成功了。记下这次写入的内容（再次发布时不会把它当成别人的修改），
        // 然后多读几次分支指针确认（读副本可能还是旧的）。
        for (const w of writes) this._maybeLanded.set(w.path, uploaded.get(w.path));
        for (const d of deletes) this._maybeLanded.set(d.path, null);
        const landed = await this._confirmHead(newCommitSha, head.commitSha);
        if (landed === false) throw friendlyRefError(err, this.client.branch);
        if (landed === null) {
          const e = new GitHubError(
            '网络中断，暂时无法确认这次是否已经发布成功。请稍等一会儿再点一次发布：如果其实已经发布了，不会重复发布。',
            { status: 0, path: err.path, cause: err });
          e.uncertain = true;
          throw e;
        }
      }

      // 7. 成功：用本地记账更新文件树（结果与 GitHub 上完全一致：最新树 + 本次修改）
      const next = new Map(latest);
      for (const w of writes) {
        next.set(w.path, { path: w.path, sha: uploaded.get(w.path), size: w.bytes.length, mode: writeMode(latest.get(w.path)) });
      }
      for (const d of deletes) next.delete(d.path);
      this._superseded.set(head.commitSha, Date.now());
      for (const o of ops) this._maybeLanded.delete(o.path);
      this._setState({ commitSha: newCommitSha, treeSha: newTreeSha }, next, submodules, false);
      for (const w of writes) this._cacheBlob(uploaded.get(w.path), w.bytes);

      this._emit({ type: 'commit', commitSha: newCommitSha, paths: ops.map((o) => o.path) });
      progress({ phase: 'done' });
      return { commitSha: newCommitSha, shas };
    }
  }

  // -------------------------------------------------------------------------
  // 部署状态

  /**
   * 轮询某个提交的 GitHub Actions 运行状态。
   * onUpdate({ state: 'pending'|'running'|'success'|'failure'|'unknown', url }) 只在状态或链接变化时调用。
   * - 'success' / 'failure' / 'unknown' 是最终状态，之后不再轮询。
   * - 403/404/401（令牌没有 Actions 权限）→ 'unknown'。
   * - 超过 maxMs 仍未结束，或 noRunMs 内一直没有出现运行记录 → 'unknown'。
   * - 运行被取消（通常是被更新的一次发布顶替）→ 'unknown'。
   *
   * @param {string} commitSha
   * @param {(u: { state: string, url: string }) => void} onUpdate
   * @param {{ intervalMs?: number, maxMs?: number, noRunMs?: number }} [options]
   * @returns {{ stop(): void }}
   */
  watchDeploy(commitSha, onUpdate, { intervalMs = 5000, maxMs = 15 * 60 * 1000, noRunMs = 3 * 60 * 1000 } = {}) {
    const fallbackUrl = `https://github.com/${encodeURIComponent(this.client.owner)}/${encodeURIComponent(this.client.repo)}/actions`;
    const start = Date.now();
    let stopped = false;
    let timer = null;
    let lastKey = null;
    let errors = 0;

    const stop = () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
    };
    const emit = (state, url) => {
      if (stopped) return;
      const key = `${state}\n${url}`;
      if (key === lastKey) return;
      lastKey = key;
      try { onUpdate && onUpdate({ state, url }); } catch (err) { console.error(err); }
    };
    const finish = (state, url) => { emit(state, url || fallbackUrl); stop(); };
    const schedule = () => {
      if (stopped) return;
      if (Date.now() - start + intervalMs > maxMs) { finish('unknown', fallbackUrl); return; }
      timer = setTimeout(tick, intervalMs);
    };
    const tick = async () => {
      timer = null;
      if (stopped) return;
      let runs;
      try {
        runs = await this.client.listWorkflowRuns(commitSha);
        errors = 0;
      } catch (err) {
        if (stopped) return;
        const status = err && err.status;
        if (status === 401 || status === 403 || status === 404) { finish('unknown', fallbackUrl); return; }
        if (++errors >= 5) { finish('unknown', fallbackUrl); return; }   // 连续网络错误
        schedule();
        return;
      }
      if (stopped) return;
      const s = summarizeRuns(runs || []);
      if (s.final) { finish(s.state, s.url); return; }
      if (!runs.length && Date.now() - start >= noRunMs) { finish('unknown', fallbackUrl); return; }
      emit(s.state, s.url || fallbackUrl);
      schedule();
    };

    if (!commitSha) {
      // 没有提交 sha 就无从查询（空 head_sha 会返回所有运行记录，结果会误导）。
      Promise.resolve().then(() => finish('unknown', fallbackUrl));
    } else {
      tick();
    }
    return { stop };
  }

  // -------------------------------------------------------------------------
  // 事件

  /**
   * 在 load() 和成功的 commit() 之后调用 fn({ type: 'load'|'commit', commitSha, paths, repo })。
   * @param {(event: { type: string, commitSha: string, paths: string[], repo: Repo }) => void} fn
   * @returns {() => void} 取消订阅
   */
  onChange(fn) {
    if (typeof fn !== 'function') return () => {};
    this._listeners.add(fn);
    return () => { this._listeners.delete(fn); };
  }

  // -------------------------------------------------------------------------
  // 内部

  _emit(event) {
    const ev = { ...event, repo: this };
    for (const fn of [...this._listeners]) {
      try { fn(ev); } catch (err) { console.error(err); }
    }
  }

  /** load/commit 串行执行，避免两个提交互相打架、或 load 覆盖刚提交的结果。 */
  _exclusive(fn) {
    const run = this._queue.then(() => fn());
    this._queue = run.then(() => {}, () => {});
    return run;
  }

  _setState(head, blobs, submodules, truncated) {
    this.commitSha = head.commitSha;
    this.treeSha = head.treeSha;
    this._blobs = blobs;
    this._sorted = null;
    this._submodules = submodules;
    this._truncated = truncated;
  }

  /**
   * 最新 head。GitHub 的读副本偶尔会在分支更新后的几秒内返回旧指针；
   * 如果读到的是我们自己刚「快进」掉的旧提交，就以本地记录的（更新的）head 为准。
   */
  async _latestHead() {
    const head = await this.client.getBranchHead();
    const at = this._superseded.get(head.commitSha);
    if (this.commitSha && head.commitSha !== this.commitSha && at !== undefined &&
        Date.now() - at < STALE_REF_WINDOW_MS) {
      return { commitSha: this.commitSha, treeSha: this.treeSha };
    }
    return head;
  }

  /**
   * 「移动分支」的响应丢失后，确认分支现在是否指向 target。
   * 按 0、1、2、4 倍 retryDelayMs 的间隔读几次（读副本可能还停在 parent 上）。
   * @returns {Promise<boolean|null>} true = 已经成功；false = 没有成功；null = 一直读不到，无法确定
   */
  async _confirmHead(target, parent) {
    let sawParent = false;
    for (const factor of [0, 1, 2, 4]) {
      await sleep(this._retryDelayMs * factor);
      let head;
      try {
        head = await this.client.getBranchHead();
      } catch {
        continue;
      }
      if (head.commitSha === target) return true;
      if (head.commitSha !== parent) return false;   // 分支已经被移到别处：我们的提交没有生效
      sawParent = true;
    }
    return sawParent ? false : null;
  }

  /** 文件现在的版本是我们那次「不确定是否成功」的提交写入的。 */
  _isOwnEarlierWrite(path, cur) {
    if (!this._maybeLanded.has(path)) return false;
    const sha = this._maybeLanded.get(path);
    return sha === null ? !cur : !!cur && cur.sha === sha;
  }

  async _readBlob(sha, expectedSize) {
    const mem = this._mem.get(sha);
    if (mem) return mem.slice();
    let p = this._inflight.get(sha);
    if (!p) {
      p = this._fetchBlob(sha, expectedSize);
      this._inflight.set(sha, p);
      p.then(() => this._inflight.delete(sha), () => this._inflight.delete(sha));
    }
    const bytes = await p;
    // 小文件返回副本：调用方修改返回值不应污染缓存（大文件不进内存缓存，直接返回）。
    return bytes.length <= MEM_CACHE_MAX_ITEM ? bytes.slice() : bytes;
  }

  async _fetchBlob(sha, expectedSize) {
    let bytes;
    if (this._blobCache) {
      try {
        const v = await this._blobCache.get(sha);
        if (v) bytes = toUint8(v);
      } catch { /* 缓存坏了就当没有 */ }
      // 缓存内容与文件树记录的大小不一致 → 不信任缓存
      if (bytes && typeof expectedSize === 'number' && expectedSize > 0 && bytes.length !== expectedSize) bytes = undefined;
    }
    if (!bytes) {
      bytes = await this.client.getBlob(sha);
      this._persistBlob(sha, bytes);
    }
    this._remember(sha, bytes);
    return bytes;
  }

  _cacheBlob(sha, bytes) {
    if (!sha || !bytes) return;
    // bytes 可能是调用方传进来的数组，复制一份再缓存。
    const copy = bytes.slice();
    this._remember(sha, copy);
    this._persistBlob(sha, copy);
  }

  _persistBlob(sha, bytes) {
    if (!this._blobCache) return;
    try {
      Promise.resolve(this._blobCache.set(sha, bytes)).catch(() => {});
    } catch { /* ignore */ }
  }

  _remember(sha, bytes) {
    if (bytes.length > MEM_CACHE_MAX_ITEM || this._mem.has(sha)) return;
    this._mem.set(sha, bytes);
    this._memBytes += bytes.length;
    // 超出预算：按插入顺序淘汰最旧的
    for (const [k, v] of this._mem) {
      if (this._memBytes <= MEM_CACHE_BUDGET) break;
      this._mem.delete(k);
      this._memBytes -= v.length;
    }
  }
}

// ---------------------------------------------------------------------------
// 帮助函数

function stripLeadingSlash(path) {
  return String(path == null ? '' : path).replace(/^\/+/, '');
}

/** 规范化并校验仓库内路径；非法路径直接抛错（绝不提交到奇怪的位置）。 */
function normalizeRepoPath(path) {
  if (typeof path !== 'string') throw new TypeError('变更缺少文件路径');
  const p = stripLeadingSlash(path);
  const segs = p.split('/');
  if (!p || /[\x00-\x1f\x7f\\]/.test(p) ||
      segs.some((s) => s === '' || s === '.' || s === '..' || s.toLowerCase() === '.git')) {
    throw new Error(`文件路径不合法：${path}`);
  }
  return p;
}

/**
 * 文本规范化：换行统一为 '\n'，结尾恰好一个 '\n'（空文本保持为空）。
 * @param {string} text
 */
function normalizeText(text) {
  const s = text.replace(/\r\n?/g, '\n').replace(/\n+$/, '');
  return s === '' ? '' : s + '\n';
}

function toUint8(v) {
  if (v instanceof Uint8Array) return v;
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  return undefined;
}

async function contentToBytes(content, path) {
  if (typeof content === 'string') return new TextEncoder().encode(normalizeText(content));
  const direct = toUint8(content);
  if (direct) return direct;
  if (content && typeof content.arrayBuffer === 'function') {   // Blob / File
    return new Uint8Array(await content.arrayBuffer());
  }
  throw new TypeError(`不支持的文件内容类型：${path}`);
}

async function prepareChanges(changes) {
  const byPath = new Map();
  const checks = [];
  for (const ch of changes) {
    if (!ch || typeof ch !== 'object') throw new TypeError('变更格式不正确');
    const path = normalizeRepoPath(ch.path);
    if (ch.baseSha !== undefined) {
      if (ch.baseSha !== null && (typeof ch.baseSha !== 'string' || !ch.baseSha)) {
        throw new TypeError(`baseSha 格式不正确：${path}`);
      }
      checks.push({ path, baseSha: ch.baseSha });
    }
    if (ch.delete === true) {
      byPath.set(path, { path, delete: true });
    } else if (ch.content !== undefined && ch.content !== null) {
      const bytes = await contentToBytes(ch.content, path);
      if (bytes.length > MAX_BLOB_BYTES) {
        throw new GitHubError(
          `文件「${path}」太大（${(bytes.length / 1024 / 1024).toFixed(1)} MB），GitHub 单个文件不能超过 100 MB`,
          { status: 413, path });
      }
      byPath.set(path, { path, bytes, sha: await gitBlobSha(bytes) });
    } else {
      throw new TypeError(`变更缺少内容：${path}`);
    }
  }
  return { ops: [...byPath.values()], checks };
}

/** 这个修改是否已经是现在的状态（写入：内容 sha 相同；删除：文件已经不存在）。 */
function alreadyAs(op, cur) {
  if (!op) return false;
  if (op.delete) return !cur;
  return !!cur && !!op.sha && cur.sha === op.sha;
}

/**
 * 在本地计算 git blob sha（sha1('blob <长度>\0' + 内容)），与 GitHub 上的完全一致。
 * 没有 WebCrypto（非安全上下文）时返回 null —— 只是少了「重复发布」识别，不影响发布。
 * @param {Uint8Array} bytes
 * @returns {Promise<string|null>}
 */
export async function gitBlobSha(bytes) {
  const subtle = globalThis.crypto && globalThis.crypto.subtle;
  if (!subtle) return null;
  try {
    const header = new TextEncoder().encode(`blob ${bytes.length}\0`);
    const buf = new Uint8Array(header.length + bytes.length);
    buf.set(header, 0);
    buf.set(bytes, header.length);
    const digest = new Uint8Array(await subtle.digest('SHA-1', buf));
    let hex = '';
    for (const b of digest) hex += b.toString(16).padStart(2, '0');
    return hex;
  } catch {
    return null;
  }
}

function blobMapFromTree(tree) {
  const m = new Map();
  for (const e of tree) {
    if (e.type !== 'blob') continue;
    m.set(e.path, { path: e.path, sha: e.sha, size: typeof e.size === 'number' ? e.size : 0, mode: e.mode || '100644' });
  }
  return m;
}

/** 覆盖已有的可执行文件时保留可执行位，其余一律普通文件。 */
function writeMode(existing) {
  return existing && existing.mode === '100755' ? '100755' : '100644';
}

function friendlyRefError(err, branch) {
  if (!(err instanceof GitHubError)) return err;
  if (err.status === 409 || err.status === 422) {
    return new GitHubError(
      `发布失败：GitHub 拒绝更新 ${branch} 分支（${err.message}）。可能是网站内容刚刚在别处被更新了，请稍后再试一次。`,
      { status: err.status, path: err.path, data: err.data, cause: err });
  }
  return err;
}

const FAILED = new Set(['failure', 'timed_out', 'startup_failure', 'action_required']);

/** 把多个 workflow run 汇总成一个状态。 */
function summarizeRuns(runs) {
  if (!runs.length) return { state: 'pending', url: '', final: false };
  const failed = runs.find((r) => r.status === 'completed' && FAILED.has(r.conclusion));
  if (failed) return { state: 'failure', url: failed.htmlUrl, final: true };
  const active = runs.find((r) => r.status !== 'completed');
  if (active) return { state: active.status === 'in_progress' ? 'running' : 'pending', url: active.htmlUrl, final: false };
  const cancelled = runs.find((r) => r.conclusion === 'cancelled');
  if (cancelled) return { state: 'unknown', url: cancelled.htmlUrl, final: true };
  return { state: 'success', url: runs[0].htmlUrl, final: true };
}

/** 有限并发地执行 worker；任何一个失败都会让整体失败（其余的会跑完当前这一个）。 */
async function runPool(items, limit, worker) {
  let next = 0;
  let failed = null;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length && !failed) {
      const item = items[next++];
      try {
        await worker(item);
      } catch (err) {
        failed = failed || err;
      }
    }
  });
  await Promise.all(runners);
  if (failed) throw failed;
}

function safeCallback(fn) {
  return (info) => {
    if (typeof fn !== 'function') return;
    try { fn(info); } catch (err) { console.error(err); }
  };
}

function sleep(ms) {
  return ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve();
}
