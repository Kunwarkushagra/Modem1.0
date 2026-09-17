import type { FlowCacheEntry, FlowSnapshot } from "./types";

const FLOW_CACHE_KEY = "tv_flow_cache_v1";
const FLOW_CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

interface FlowCache {
  [symbol: string]: FlowCacheEntry;
}

export function loadFlowCache(): FlowCache {
  try {
    const raw = localStorage.getItem(FLOW_CACHE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

export function saveFlowCache(cache: FlowCache): void {
  try {
    localStorage.setItem(FLOW_CACHE_KEY, JSON.stringify(cache));
  } catch {
    // quota exceeded or other storage error - silently ignore
  }
}

export function getCachedFlow(symbol: string): FlowSnapshot | null {
  const cache = loadFlowCache();
  const entry = cache[symbol];
  if (!entry) return null;
  if (Date.now() - entry.cachedAt > FLOW_CACHE_TTL_MS) {
    // expired - remove from cache
    delete cache[symbol];
    saveFlowCache(cache);
    return null;
  }
  return entry.snapshot;
}

export function setCachedFlow(symbol: string, snapshot: FlowSnapshot): void {
  const cache = loadFlowCache();
  cache[symbol] = {
    snapshot,
    cachedAt: Date.now(),
  };
  saveFlowCache(cache);
}

export function clearFlowCache(): void {
  try {
    localStorage.removeItem(FLOW_CACHE_KEY);
  } catch {
    // silently ignore
  }
}
