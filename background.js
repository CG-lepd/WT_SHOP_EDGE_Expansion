/**
 * Background Service Worker
 *
 * 职责：
 * 1. 管理扩展生命周期
 * 2. 缓存管理（IndexedDB）
 * 3. 与 content script 通信中转
 * 4. Token 变更监听
 */

// ─── IndexedDB 缓存 ─────────────────────────────────────

const DB_NAME = 'GaijinEnhancerCache';
const DB_VERSION = 2;
const STORE = {
  TRADE: 'tradeHistory',   // 交易历史缓存
  ASSET: 'assetInfo',      // 物品信息缓存
  META: 'meta'             // 元信息（最新同步时间等）
};

let _db = null;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE.TRADE)) {
        const store = db.createObjectStore(STORE.TRADE, { keyPath: 'id' });
        store.createIndex('ts', 'ts', { unique: false });
      }
      if (!db.objectStoreNames.contains(STORE.ASSET)) {
        const store = db.createObjectStore(STORE.ASSET, { keyPath: 'itemdefid' });
        store.createIndex('ts', 'ts', { unique: false });
      }
      if (!db.objectStoreNames.contains(STORE.META)) {
        db.createObjectStore(STORE.META, { keyPath: 'key' });
      }
    };
    req.onsuccess = (e) => { _db = e.target.result; resolve(_db); };
    req.onerror = (e) => { _db = null; reject(e.target.error); };
  });
}

async function dbWrite(storeName, data) {
  if (!_db) await openDB();
  return new Promise((resolve, reject) => {
    const tx = _db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    store.put(data);
    tx.oncomplete = () => resolve();
    tx.onerror = (e) => reject(e.target.error);
  });
}

async function dbRead(storeName, key) {
  if (!_db) await openDB();
  return new Promise((resolve, reject) => {
    const tx = _db.transaction(storeName, 'readonly');
    const store = tx.objectStore(storeName);
    const req = store.get(key);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = (e) => reject(e.target.error);
  });
}

async function dbReadAll(storeName) {
  if (!_db) await openDB();
  return new Promise((resolve, reject) => {
    const tx = _db.transaction(storeName, 'readonly');
    const store = tx.objectStore(storeName);
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = (e) => reject(e.target.error);
  });
}

async function dbClear(storeName) {
  if (!_db) await openDB();
  return new Promise((resolve, reject) => {
    const tx = _db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    store.clear();
    tx.oncomplete = () => resolve();
    tx.onerror = (e) => reject(e.target.error);
  });
}

// 清理过期缓存（超过24小时的数据）
async function cleanExpiredCache() {
  // API 事件中的 ts 是 Unix 秒时间戳，需要统一单位
  const cutoff = Math.floor(Date.now() / 1000) - 24 * 60 * 60;
  for (const storeName of [STORE.TRADE, STORE.ASSET]) {
    if (!_db) await openDB();
    const tx = _db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    const index = store.index('ts');
    const range = IDBKeyRange.upperBound(cutoff);
    const req = index.openCursor(range);
    req.onsuccess = (e) => {
      const cursor = e.target.result;
      if (cursor) {
        cursor.delete();
        cursor.continue();
      }
    };
  }
}

// ─── 监听来自 content script 的消息 ────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // 异步响应
  (async () => {
    switch (message.type) {
      case 'GET_STORED_HISTORY':
        return { data: await dbReadAll(STORE.TRADE) };

      case 'STORE_TRADE_BATCH': {
        const { events } = message;
        for (const evt of events) {
          await dbWrite(STORE.TRADE, {
            ...evt,
            id: evt.id || `${evt.orderId}_${evt.ts}`,
            ts_stored: Date.now()
          });
        }
        // 更新元信息
        const meta = await dbRead(STORE.META, 'lastSync');
        const lastSync = {
          key: 'lastSync',
          time: Date.now(),
          total: (meta?.total || 0) + events.length
        };
        await dbWrite(STORE.META, lastSync);
        return { ok: true, count: events.length };
      }

      case 'GET_META':
        return { meta: await dbReadAll(STORE.META) };

      case 'CLEAR_CACHE':
        await dbClear(STORE.TRADE);
        await dbClear(STORE.ASSET);
        await dbClear(STORE.META);
        return { ok: true };

      case 'CLEAN_EXPIRED':
        await cleanExpiredCache();
        return { ok: true };

      case 'PING':
        return { ok: true, version: '2.0.0', runtime: 'service_worker' };

      default:
        return { error: `Unknown message type: ${message.type}` };
    }
  })().then(sendResponse);

  return true; // 保持消息通道打开
});

// ─── 安装与生命周期 ─────────────────────────────────────

chrome.runtime.onInstalled.addListener(async (details) => {
  await openDB();

  if (details.reason === 'install') {
    console.log('[GaijinEnhancer] 首次安装');
    await dbWrite(STORE.META, {
      key: 'installed',
      time: Date.now(),
      version: '1.0.0'
    });
  }

  // 清理过期缓存（每天一次）
  setInterval(cleanExpiredCache, 60 * 60 * 1000);
  cleanExpiredCache();
});

chrome.runtime.onStartup.addListener(async () => {
  await openDB();
});

console.log('[GaijinEnhancer] Service Worker 已启动');
