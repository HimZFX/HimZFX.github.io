// drafts.js — 本机存储（IndexedDB）：编辑器自动保存的草稿 + GitHub 文件内容缓存。
//
// 数据库 'himzfx-admin'（版本 1）：
//   drafts  keyPath 'key'  → { key, title, markdown, fields, images: { [fileName]: Blob }, path,
//                              baseSha, groupKey, updatedAt }
//   blobs   keyPath 'sha'  → { sha, bytes: Uint8Array, size, at }
//
// 原则：本机存储只是「保险」，绝不能让它的失败影响正常使用。
// 浏览器不支持 / 隐私模式禁用 / 被其他标签页阻塞 / 空间不足时，
// 所有函数都安静地返回空结果（undefined / [] / false），永远不抛异常。
// 导入本模块不会访问 window / document / indexedDB。

const DB_NAME = 'himzfx-admin';
const DB_VERSION = 1;
const DRAFTS = 'drafts';
const BLOBS = 'blobs';
const OPEN_TIMEOUT_MS = 4000;

// blob 缓存的容量控制：内容按 sha 寻址，永不过期，但不能无限增长。
const BLOB_CACHE_MAX_BYTES = 80 * 1024 * 1024;
const BLOB_CACHE_MAX_ITEM = 20 * 1024 * 1024;

let dbPromise = null;

function getIDB() {
  try {
    return typeof indexedDB !== 'undefined' && indexedDB ? indexedDB : null;
  } catch {
    return null; // 某些浏览器在禁用存储时，连访问 indexedDB 都会抛 SecurityError
  }
}

/** 打开数据库；失败时得到 null（并允许下次重试）。 */
function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    const idb = getIDB();
    if (!idb) return resolve(null);
    let settled = false;
    const done = (db) => {
      if (settled) {
        // 超时之后才打开成功：关掉，避免泄漏
        if (db) try { db.close(); } catch { /* ignore */ }
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(db);
    };
    const timer = setTimeout(() => done(null), OPEN_TIMEOUT_MS);
    if (timer && typeof timer.unref === 'function') timer.unref();
    let req;
    try {
      req = idb.open(DB_NAME, DB_VERSION);
    } catch {
      return done(null);
    }
    req.onupgradeneeded = () => {
      try {
        const db = req.result;
        if (!db.objectStoreNames.contains(DRAFTS)) db.createObjectStore(DRAFTS, { keyPath: 'key' });
        if (!db.objectStoreNames.contains(BLOBS)) db.createObjectStore(BLOBS, { keyPath: 'sha' });
      } catch { /* onerror 会接着触发 */ }
    };
    req.onsuccess = () => {
      const db = req.result;
      // 其他标签页要升级数据库时让路；之后的调用会重新打开
      db.onversionchange = () => {
        try { db.close(); } catch { /* ignore */ }
        dbPromise = null;
      };
      db.onclose = () => { dbPromise = null; };
      done(db);
    };
    req.onerror = (e) => {
      if (e && typeof e.preventDefault === 'function') e.preventDefault();
      done(null);
    };
    req.onblocked = () => { /* 等待；超时后放弃 */ };
  }).then((db) => {
    if (!db) dbPromise = null; // 失败不缓存，下次再试
    return db;
  });
  return dbPromise;
}

/**
 * 在一个事务里执行操作。fn(store) 可以发起请求并返回一个「取结果」的函数；
 * 事务完成后 resolve 那个结果。任何失败 → resolve(fallback)。
 */
async function withStore(storeName, mode, fn, fallback) {
  const db = await openDB();
  if (!db) return fallback;
  return new Promise((resolve) => {
    let tx;
    let getResult;
    try {
      tx = db.transaction(storeName, mode);
      getResult = fn(tx.objectStore(storeName));
    } catch {
      return resolve(fallback);
    }
    tx.oncomplete = () => {
      try {
        resolve(typeof getResult === 'function' ? getResult() : getResult);
      } catch {
        resolve(fallback);
      }
    };
    tx.onerror = (e) => {
      if (e && typeof e.preventDefault === 'function') e.preventDefault();
      resolve(fallback);
    };
    tx.onabort = () => resolve(fallback);
  });
}

function reqResult(req) {
  return () => req.result;
}

// ---------------------------------------------------------------------------
// Blob 兼容：极少数浏览器（旧版 Safari）不能把 Blob 存进 IndexedDB。
// 正常情况下直接存 Blob；只有 put 失败（DataCloneError）时才转成 ArrayBuffer 再存，
// 读出时转回 Blob，调用方看到的始终是 Blob。
// ---------------------------------------------------------------------------

const PACKED = '__adminPackedBlob';

async function packImages(images) {
  const out = {};
  for (const [name, b] of Object.entries(images || {})) {
    if (b && typeof b.arrayBuffer === 'function') {
      out[name] = { [PACKED]: true, type: b.type || '', buf: await b.arrayBuffer() };
    } else {
      out[name] = b;
    }
  }
  return out;
}

function unpackImages(images) {
  if (!images || typeof images !== 'object') return {};
  const out = {};
  for (const [name, v] of Object.entries(images)) {
    out[name] = v && v[PACKED] ? new Blob([v.buf], { type: v.type }) : v;
  }
  return out;
}

function putRecord(record) {
  return withStore(DRAFTS, 'readwrite', (store) => {
    store.put(record);
    return () => true;
  }, false);
}

// ---------------------------------------------------------------------------
// 草稿
// ---------------------------------------------------------------------------

/**
 * 保存（覆盖）一份本机草稿。
 * @param {string} key draftKeyForPath(path) 或 newDraftKey()
 * @param {{ title?: string, markdown?: string, fields?: object, images?: { [fileName: string]: Blob },
 *           path?: string, baseSha?: string|null, groupKey?: string, updatedAt?: number }} draft
 * @returns {Promise<boolean>} 是否保存成功（额外返回值；失败不抛异常）
 */
export async function saveDraft(key, draft) {
  if (!key) return false;
  try {
    const record = { ...(draft || {}), key, updatedAt: (draft && draft.updatedAt) || Date.now() };
    record.images = { ...((draft && draft.images) || {}) };
    if (await putRecord(record)) return true;
    // 可能是 DataCloneError（不能存 Blob）：改用 ArrayBuffer 再试一次
    const packed = { ...record, images: await packImages(record.images) };
    if (await putRecord(packed)) return true;
    // 仍然失败（例如 fields 里有无法克隆的值）：退化为 JSON 能表示的部分
    const plain = JSON.parse(JSON.stringify({ ...record, images: undefined }));
    plain.images = packed.images;
    return await putRecord(plain);
  } catch {
    return false;
  }
}

/**
 * 读取一份草稿；没有或读取失败 → undefined。images 里始终是 Blob。
 * @param {string} key
 */
export async function loadDraft(key) {
  if (!key) return undefined;
  try {
    const rec = await withStore(DRAFTS, 'readonly', (s) => reqResult(s.get(key)), undefined);
    if (!rec) return undefined;
    return { ...rec, images: unpackImages(rec.images) };
  } catch {
    return undefined;
  }
}

/** 删除一份草稿（不存在也没关系）。 */
export async function deleteDraft(key) {
  if (!key) return;
  try {
    await withStore(DRAFTS, 'readwrite', (s) => { s.delete(key); }, undefined);
  } catch { /* ignore */ }
}

/**
 * 列出所有本机草稿（新的在前）。不返回正文和图片。
 * @returns {Promise<Array<{ key: string, title: string, path: string|undefined,
 *                           groupKey: string|undefined, updatedAt: number }>>}
 */
export async function listDrafts() {
  try {
    const list = await withStore(DRAFTS, 'readonly', (store) => {
      const items = [];
      const req = store.openCursor();
      req.onsuccess = () => {
        const cur = req.result;
        if (!cur) return;
        const v = cur.value || {};
        items.push({
          key: v.key,
          title: v.title || '',
          path: v.path,
          groupKey: v.groupKey,
          updatedAt: Number(v.updatedAt) || 0,
          // 新文章草稿的文件名（列表用来判断「是不是其实已经发表了」）
          slug: v.fields && typeof v.fields.slug === 'string' ? v.fields.slug : undefined,
        });
        cur.continue();
      };
      return () => items;
    }, []);
    return list.sort((a, b) => b.updatedAt - a.updatedAt);
  } catch {
    return [];
  }
}

/** 已有文件的草稿 key。 */
export function draftKeyForPath(path) {
  return `file:${path}`;
}

/** 新文章的草稿 key（随机）。 */
export function newDraftKey() {
  let id = '';
  try {
    if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') {
      id = globalThis.crypto.randomUUID();
    }
  } catch { /* ignore */ }
  if (!id) id = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  return `new:${id}`;
}

// ---------------------------------------------------------------------------
// Blob 缓存（给 Repo 用）
// ---------------------------------------------------------------------------

let pruneScheduled = false;

/** 超出容量时删掉最早写入的条目。每次页面加载最多做一次，放在后台。 */
function schedulePrune() {
  if (pruneScheduled) return;
  pruneScheduled = true;
  const t = setTimeout(() => {
    withStore(BLOBS, 'readwrite', (store) => {
      const rows = [];
      const req = store.openCursor();
      req.onsuccess = () => {
        const cur = req.result;
        if (cur) {
          const v = cur.value || {};
          rows.push({ sha: v.sha, size: Number(v.size) || 0, at: Number(v.at) || 0 });
          cur.continue();
          return;
        }
        let total = rows.reduce((n, r) => n + r.size, 0);
        if (total <= BLOB_CACHE_MAX_BYTES) return;
        rows.sort((a, b) => a.at - b.at);
        for (const r of rows) {
          if (total <= BLOB_CACHE_MAX_BYTES * 0.75) break;
          store.delete(r.sha);
          total -= r.size;
        }
      };
    }, undefined).catch(() => {});
  }, 3000);
  // 不要因为这个后台任务让 Node 测试进程多等
  if (t && typeof t.unref === 'function') t.unref();
}

/**
 * 按 git blob sha 缓存文件内容。sha 由内容决定，所以缓存永远不会过期。
 * @returns {{ get(sha: string): Promise<Uint8Array|undefined>, set(sha: string, bytes: Uint8Array): Promise<void> }}
 */
export function idbBlobCache() {
  return {
    async get(sha) {
      if (!sha) return undefined;
      try {
        const rec = await withStore(BLOBS, 'readonly', (s) => reqResult(s.get(sha)), undefined);
        if (!rec || rec.bytes == null) return undefined;
        const b = rec.bytes;
        if (b instanceof Uint8Array) return b;
        if (b instanceof ArrayBuffer) return new Uint8Array(b);
        if (typeof Blob !== 'undefined' && b instanceof Blob) return new Uint8Array(await b.arrayBuffer());
        return undefined;
      } catch {
        return undefined;
      }
    },
    async set(sha, bytes) {
      if (!sha || bytes == null) return;
      try {
        const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
        if (u8.byteLength > BLOB_CACHE_MAX_ITEM) return;
        // 复制一份：调用方之后改动自己的数组也不影响缓存
        const copy = u8.slice();
        const ok = await withStore(BLOBS, 'readwrite', (s) => {
          s.put({ sha, bytes: copy, size: copy.byteLength, at: Date.now() });
          return () => true;
        }, false);
        if (ok) schedulePrune();
      } catch { /* ignore */ }
    },
  };
}
