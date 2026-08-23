import type { Candle } from "./types";

/**
 * Tiny IndexedDB candle cache (store: "candles", key: `${symbol}:${tf}:${epochBucket}`).
 * Falls back to an in-memory Map when IndexedDB is unavailable (private mode, etc.).
 * Used by the Top Setups Radar so a transient feed failure degrades to "DATA STALE"
 * instead of a hard error, while other symbols keep scanning.
 */

const DB_NAME = "tv-radar-cache";
const STORE = "candles";

export interface CachedCandles { candles: Candle[]; ts: number }

let dbPromise: Promise<IDBDatabase | null> | null = null;
const mem = new Map<string, CachedCandles>();

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    try {
      if (typeof indexedDB === "undefined") { resolve(null); return; }
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbPromise;
}

export async function putCandles(key: string, candles: Candle[]): Promise<void> {
  const value: CachedCandles = { candles, ts: Date.now() };
  mem.set(key, value);
  const db = await openDb();
  if (!db) return;
  try {
    await new Promise<void>((resolve) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    });
  } catch { /* non-fatal */ }
}

export async function getCandles(key: string): Promise<CachedCandles | null> {
  const memHit = mem.get(key);
  const db = await openDb();
  if (!db) return memHit ?? null;
  try {
    const val = await new Promise<CachedCandles | null>((resolve) => {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).get(key);
      req.onsuccess = () => resolve((req.result as CachedCandles) ?? null);
      req.onerror = () => resolve(null);
    });
    return val ?? memHit ?? null;
  } catch {
    return memHit ?? null;
  }
}
