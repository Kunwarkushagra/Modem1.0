import type { Candle, RawUniverseEntry } from "./types";

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

/* ---- universe cache: raw top-30 USDT rows by 24h quote volume (6h TTL) ----
   Raw stats are cached (not the filtered list) so every Hygiene Guard stays
   re-applicable from cache after a reload or a user floor change. */

export interface CachedTop30 { entries: RawUniverseEntry[]; ts: number }
export const TOP30_TTL_MS = 6 * 3600_000;
const TOP30_KEY = "meta:top30usdt-v2";
const memTop30 = new Map<string, CachedTop30>();

export async function putTop30(entries: RawUniverseEntry[]): Promise<void> {
  const value: CachedTop30 = { entries, ts: Date.now() };
  memTop30.set(TOP30_KEY, value);
  const db = await openDb();
  if (!db) return;
  try {
    await new Promise<void>((resolve) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(value, TOP30_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    });
  } catch { /* non-fatal */ }
}

/* ---- consecutive-refresh streaks (Universe Hygiene guard 5: min list age) ---- */

const STREAK_KEY = "meta:top30streaks";
const memStreak = new Map<string, Record<string, number>>();

export async function getStreaks(): Promise<Record<string, number>> {
  const memHit = memStreak.get(STREAK_KEY) ?? {};
  const db = await openDb();
  if (!db) return memHit;
  try {
    const val = await new Promise<Record<string, number> | null>((resolve) => {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).get(STREAK_KEY);
      req.onsuccess = () => resolve((req.result as Record<string, number>) ?? null);
      req.onerror = () => resolve(null);
    });
    return val ?? memHit;
  } catch {
    return memHit;
  }
}

export async function putStreaks(s: Record<string, number>): Promise<void> {
  memStreak.set(STREAK_KEY, s);
  const db = await openDb();
  if (!db) return;
  try {
    await new Promise<void>((resolve) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(s, STREAK_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    });
  } catch { /* non-fatal */ }
}

/**
 * Advance the consecutive-appearance streak for the freshly refreshed universe.
 * Symbols still present get +1; symbols that dropped out are removed (streak resets
 * if they return later). A symbol is scannable once its streak reaches 2.
 */
export async function advanceStreaks(currentSymbols: string[]): Promise<Record<string, number>> {
  const prev = await getStreaks();
  const next: Record<string, number> = {};
  for (const s of currentSymbols) next[s] = (prev[s] ?? 0) + 1;
  await putStreaks(next);
  return next;
}

/** Guard 5 threshold: two consecutive refreshes before scannable. */
export const MIN_SCANNABLE_STREAK = 2;

export async function getTop30(): Promise<CachedTop30 | null> {
  const memHit = memTop30.get(TOP30_KEY) ?? null;
  const db = await openDb();
  if (!db) return memHit;
  try {
    const val = await new Promise<CachedTop30 | null>((resolve) => {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).get(TOP30_KEY);
      req.onsuccess = () => {
        const r = req.result as CachedTop30 | undefined;
        resolve(r && Array.isArray(r.entries) ? r : null);
      };
      req.onerror = () => resolve(null);
    });
    return val ?? memHit;
  } catch {
    return memHit;
  }
}

export async function clearTop30(): Promise<void> {
  memTop30.delete(TOP30_KEY);
  const db = await openDb();
  if (!db) return;
  try {
    await new Promise<void>((resolve) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).delete(TOP30_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    });
  } catch { /* non-fatal */ }
}

/* ---------------- AI Insight cache (6h TTL, keyed by signalId) ---------------- */

export const INSIGHT_TTL_MS = 6 * 3600_000;
export interface CachedInsight { result: unknown; ts: number }
const memInsight = new Map<string, CachedInsight>();

export async function putInsight(signalId: string, result: unknown): Promise<void> {
  const value: CachedInsight = { result, ts: Date.now() };
  memInsight.set(signalId, value);
  const db = await openDb();
  if (!db) return;
  try {
    await new Promise<void>((resolve) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(value, `insight:${signalId}`);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    });
  } catch { /* non-fatal */ }
}

/** Fresh cached insight (< 6h) or null. */
export async function getInsight(signalId: string): Promise<CachedInsight | null> {
  const fresh = (v: CachedInsight) => (Date.now() - v.ts < INSIGHT_TTL_MS ? v : null);
  const memHit = memInsight.get(signalId);
  if (memHit) { const f = fresh(memHit); if (f) return f; }
  const db = await openDb();
  if (!db) return null;
  try {
    const val = await new Promise<CachedInsight | null>((resolve) => {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).get(`insight:${signalId}`);
      req.onsuccess = () => resolve((req.result as CachedInsight) ?? null);
      req.onerror = () => resolve(null);
    });
    return val ? fresh(val) : null;
  } catch {
    return null;
  }
}

/* ---------------- AI Chart Review cache (6h TTL, keyed by signalId + chartHash) ---------------- */

export interface CachedChartReview { result: unknown; ts: number }
const memChart = new Map<string, CachedChartReview>();

export async function putChartReview(signalId: string, chartHash: string, result: unknown): Promise<void> {
  const key = `chart:${signalId}:${chartHash}`;
  const value: CachedChartReview = { result, ts: Date.now() };
  memChart.set(key, value);
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

/** Fresh cached chart review (< 6h) for this exact signal + rendered candles, or null. */
export async function getChartReview(signalId: string, chartHash: string): Promise<CachedChartReview | null> {
  const key = `chart:${signalId}:${chartHash}`;
  const fresh = (v: CachedChartReview) => (Date.now() - v.ts < INSIGHT_TTL_MS ? v : null);
  const memHit = memChart.get(key);
  if (memHit) { const f = fresh(memHit); if (f) return f; }
  const db = await openDb();
  if (!db) return null;
  try {
    const val = await new Promise<CachedChartReview | null>((resolve) => {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).get(key);
      req.onsuccess = () => resolve((req.result as CachedChartReview) ?? null);
      req.onerror = () => resolve(null);
    });
    return val ? fresh(val) : null;
  } catch {
    return null;
  }
}
