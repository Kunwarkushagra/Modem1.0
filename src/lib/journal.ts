import type { AlertRule, Settings, Trade } from "./types";
import { loadLS, saveLS, uid } from "./utils";

/**
 * Storage layer.
 * DEV  → localStorage (this build). Each function maps 1:1 to a REST endpoint
 *        when ported to Next.js API routes (see README "Server port map").
 * PROD → swap bodies with Postgres/Supabase calls (DATABASE_URL); signatures stay identical.
 */

const K_TRADES = "tv_trades_v1";
const K_ALERTS = "tv_alerts_v1";
const K_SETTINGS = "tv_settings_v1";

export const DEFAULT_SETTINGS: Settings = {
  provider: "local",
  apiKey: "",
  model: "",
  accountSize: 10000,
  riskPercent: 1,
  telegramToken: "",
  telegramChatId: "",
  autoRefresh: true,
  radarSymbols: ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "LINKUSDT", "XRPUSDT"],
  radarTimeframe: "15m",
  radarQualityFloor: 55,
  radarSound: false,
  radarTmVariant: "scalp10-adv-v1.2.0",
};

/** Validate + normalise the radar universe: uppercase, trim, dedupe, force USDT/USDC quote for crypto. */
export function normaliseRadarSymbols(raw: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const token of raw.toUpperCase().split(/[\s,;\n]+/)) {
    const s = token.replace(/[^A-Z0-9]/g, "");
    if (s.length < 4 || s.length > 12) continue;
    let sym = s;
    if (!/(USDT|USDC|FDUSD)$/.test(sym)) sym = sym + "USDT";
    if (!seen.has(sym)) { seen.add(sym); out.push(sym); }
  }
  return out.slice(0, 14);
}

export function loadTrades(): Trade[] {
  return loadLS<Trade[]>(K_TRADES, []);
}

export function saveTrades(trades: Trade[]): void {
  saveLS(K_TRADES, trades);
}

export function addTrade(trade: Omit<Trade, "id" | "createdAt">): Trade {
  const full: Trade = { ...trade, id: uid(), createdAt: Date.now() };
  saveTrades([full, ...loadTrades()]);
  return full;
}

export function updateTrade(id: string, patch: Partial<Trade>): void {
  saveTrades(loadTrades().map((t) => (t.id === id ? { ...t, ...patch } : t)));
}

export function deleteTrade(id: string): void {
  saveTrades(loadTrades().filter((t) => t.id !== id));
}

export function loadAlerts(): AlertRule[] {
  return loadLS<AlertRule[]>(K_ALERTS, []);
}

export function saveAlerts(alerts: AlertRule[]): void {
  saveLS(K_ALERTS, alerts);
}

export function addAlert(symbol: string, side: "above" | "below", price: number): AlertRule {
  const a: AlertRule = { id: uid(), symbol, side, price, active: true, createdAt: Date.now(), triggeredAt: null };
  saveAlerts([a, ...loadAlerts()]);
  return a;
}

export function removeAlert(id: string): void {
  saveAlerts(loadAlerts().filter((a) => a.id !== id));
}

export function markAlertTriggered(id: string): void {
  saveAlerts(loadAlerts().map((a) => (a.id === id ? { ...a, active: false, triggeredAt: Date.now() } : a)));
}

export function loadSettings(): Settings {
  return { ...DEFAULT_SETTINGS, ...loadLS<Partial<Settings>>(K_SETTINGS, {}) };
}

export function saveSettings(s: Settings): void {
  saveLS(K_SETTINGS, s);
}
