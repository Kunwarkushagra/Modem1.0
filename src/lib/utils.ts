import type { AssetType, Timeframe } from "./types";

export function cls(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

export function uid(): string {
  return Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-4);
}

export const TF_LIST: Timeframe[] = ["5m", "15m", "30m", "1h", "4h", "1d"];

export const HTF_MAP: Record<Timeframe, Timeframe> = {
  "5m": "15m", "15m": "1h", "30m": "1h", "1h": "4h", "4h": "1d", "1d": "1d",
};
export const LTF_MAP: Record<Timeframe, Timeframe> = {
  "5m": "5m", "15m": "5m", "30m": "15m", "1h": "15m", "4h": "1h", "1d": "4h",
};

export const TF_MINUTES: Record<Timeframe, number> = {
  "5m": 5, "15m": 15, "30m": 30, "1h": 60, "4h": 240, "1d": 1440,
};

/** Tick precision per asset/price magnitude — single source of truth for display rounding. */
export function tickDigits(n: number, asset?: AssetType): number {
  const abs = Math.abs(n);
  if (asset === "forex") return abs >= 100 ? 3 : 5;
  if (asset === "crypto") return abs >= 1000 ? 2 : abs >= 1 ? 4 : abs >= 0.1 ? 5 : 6;
  return abs >= 100 ? 2 : 3;
}

/** Round to symbol tick precision — never let a 17-digit float reach the UI or the AI payload. */
export function roundTick(n: number, asset?: AssetType): number {
  if (!isFinite(n)) return n;
  const f = 10 ** tickDigits(n, asset);
  return Math.round(n * f) / f;
}

export function fmtPrice(n: number, asset?: AssetType): string {
  if (!isFinite(n)) return "—";
  const digits = tickDigits(n, asset);
  return n.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function fmtMoney(n: number, compact = false): string {
  if (!isFinite(n)) return "—";
  if (compact && Math.abs(n) >= 10000) {
    return (n < 0 ? "-$" : "$") + (Math.abs(n) / 1000).toFixed(1) + "k";
  }
  return n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });
}

export function fmtPct(n: number, signed = true): string {
  if (!isFinite(n)) return "—";
  const s = signed && n > 0 ? "+" : "";
  return s + n.toFixed(2) + "%";
}

export function fmtNum(n: number, d = 2): string {
  if (!isFinite(n)) return "—";
  return n.toFixed(d);
}

export function fmtTime(t: number, tf?: Timeframe): string {
  const d = new Date(t);
  if (tf === "1d") return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "2-digit" });
  return d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
}

export function fmtIST(ts: number): string {
  try {
    const d = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hour12: false,
    }).formatToParts(new Date(ts));
    const g = (t: string) => d.find((p) => p.type === t)?.value ?? "";
    return `${g("year")}-${g("month")}-${g("day")} ${g("hour")}:${g("minute")} IST`;
  } catch {
    return new Date(ts).toISOString().slice(0, 16).replace("T", " ") + " UTC";
  }
}

export interface SessionInfo { name: "Asia" | "London" | "New York" | "Off-session"; bonus: number }

/**
 * Sessions defined directly in IST (Asia/Kolkata = UTC+5:30) — adv v1.2.0 mapping.
 * Asia 07:00–13:30 IST · London 13:30–16:30 IST · New York 19:00–22:00 IST · rest off.
 */
export function detectSession(ts: number): SessionInfo {
  const d = new Date(ts);
  const ist = (d.getUTCHours() * 60 + d.getUTCMinutes() + 330) % 1440;
  if (ist >= 420 && ist < 810) return { name: "Asia", bonus: 0 };
  if (ist >= 810 && ist < 990) return { name: "London", bonus: 2 };
  if (ist >= 1140 && ist < 1320) return { name: "New York", bonus: 2 };
  return { name: "Off-session", bonus: -2 };
}

export function fmtAgo(t: number): string {
  const s = Math.max(1, Math.floor((Date.now() - t) / 1000));
  if (s < 60) return s + "s ago";
  if (s < 3600) return Math.floor(s / 60) + "m ago";
  if (s < 86400) return Math.floor(s / 3600) + "h ago";
  return Math.floor(s / 86400) + "d ago";
}

export function normSymbol(raw: string, asset: AssetType): string {
  const s = raw.trim().toUpperCase().replace(/[\s/]/g, "");
  if (asset === "crypto") {
    if (!s) return "BTCUSDT";
    if (/^(BTC|ETH|SOL|BNB|XRP|ADA|DOGE|AVAX|LINK|DOT|LTC|MATIC|TON|TRX)$/.test(s)) return s + "USDT";
    if (!s.endsWith("USDT") && !s.endsWith("USDC") && !s.endsWith("FDUSD")) return s + "USDT";
    return s;
  }
  if (asset === "forex") {
    const clean = s.replace(/[=X]/g, "").replace(/-/, "").slice(0, 6);
    return clean.length >= 6 ? clean : s;
  }
  return s.replace(/[^A-Z.\-]/g, "") || "AAPL";
}

export function yahooSymbol(symbol: string, asset: AssetType): string {
  if (asset === "forex") return symbol.replace(/-/, "").toUpperCase() + "=X";
  return symbol.toUpperCase();
}

export function okxInstId(symbol: string): string {
  const s = symbol.toUpperCase();
  if (s.endsWith("USDT")) return s.slice(0, -4) + "-USDT";
  if (s.endsWith("USDC")) return s.slice(0, -4) + "-USDC";
  return s + "-USDT";
}

export function stooqSymbol(symbol: string, asset: AssetType): string {
  const s = symbol.toLowerCase().replace(/[=]/g, "").replace(/-/, "");
  if (asset === "stock") return s + ".us";
  return s;
}

export async function fetchWithTimeout(url: string, ms: number, init?: RequestInit): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal, headers: { Accept: "application/json,text/csv,*/*", ...(init?.headers || {}) } });
  } finally {
    clearTimeout(timer);
  }
}

export async function withRetries<T>(fn: () => Promise<T>, retries: number, label: string, onAttempt?: (msg: string) => void): Promise<T> {
  let lastErr: unknown = null;
  for (let i = 0; i <= retries; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (i < retries) onAttempt?.(`retry ${label} (${i + 1}/${retries})…`);
      await new Promise((r) => setTimeout(r, 350 * (i + 1)));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(label));
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

export function last<T>(arr: T[]): T { return arr[arr.length - 1]; }

export function lastValid(arr: number[]): number {
  for (let i = arr.length - 1; i >= 0; i--) if (isFinite(arr[i])) return arr[i];
  return NaN;
}

export function loadLS<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch { return fallback; }
}

export function saveLS<T>(key: string, value: T): void {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* quota */ }
}
