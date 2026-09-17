import type { FlowSnapshot, FlowSettings } from "./types";

const STORAGE_KEY = "tv_flow_signals";
const MAX_RECORDS = 2000;

export interface FlowSignalLog {
  id: string;
  symbol: string;
  tf: string;
  tsUTC: number;
  tsIST: string;
  direction: "LONG" | "SHORT";
  entry: number;
  stop: number;
  sweepDepth: number;
  cvdTrend: number;
  netRatio: number;
  wallCount: number;
  priceMove: number;
  r5?: number;
  r15?: number;
  r30?: number;
  r60?: number;
  netR60?: number;
}

export function logFlowSignal(
  snapshot: FlowSnapshot,
  candles: Array<{ t: number; c: number; l: number; h: number }>,
  settings: FlowSettings,
): string | null {
  if (snapshot.score !== 3 || !snapshot.direction) return null;

  const lastCandle = candles[candles.length - 1];
  const entry = lastCandle.c;
  
  // Determine stop based on direction
  const recentLows = candles.slice(-20).map((c) => c.l);
  const recentHighs = candles.slice(-20).map((c) => c.h);
  const stop = snapshot.direction === "LONG" 
    ? Math.min(...recentLows)
    : Math.max(...recentHighs);

  const id = `flow_${snapshot.symbol}_${snapshot.timestamp}`;
  
  const record: FlowSignalLog = {
    id,
    symbol: snapshot.symbol,
    tf: snapshot.timeframe,
    tsUTC: snapshot.timestamp,
    tsIST: new Date(snapshot.timestamp).toLocaleString("en-CA", { timeZone: "Asia/Kolkata" }),
    direction: snapshot.direction,
    entry,
    stop,
    sweepDepth: parseFloat(snapshot.sweep.value) || 0,
    cvdTrend: parseFloat(snapshot.cvd.value.split(",")[0]?.replace(/[^0-9.-]/g, "") || "0"),
    netRatio: parseFloat(snapshot.cvd.value.split("ratio")[1]?.trim() || "0"),
    wallCount: parseInt(snapshot.absorption.value.split(" ")[0] || "0"),
    priceMove: parseFloat(snapshot.absorption.value.split("move")[1]?.replace("%", "").trim() || "0"),
  };

  // Load existing signals
  const signals = loadSignals();
  
  // Check for duplicate
  if (signals.some((s) => s.id === id)) return id;
  
  // Add new signal
  signals.push(record);
  
  // Cap at MAX_RECORDS
  if (signals.length > MAX_RECORDS) {
    signals.splice(0, signals.length - MAX_RECORDS);
  }
  
  // Save
  saveSignals(signals);
  
  // Schedule forward return calculations
  scheduleForwardReturns(record, settings);
  
  return id;
}

function loadSignals(): FlowSignalLog[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveSignals(signals: FlowSignalLog[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(signals));
  } catch {
    console.error("[flowLog] Failed to save signals to localStorage");
  }
}

export function getLoggedSignals(): FlowSignalLog[] {
  return loadSignals();
}

function scheduleForwardReturns(signal: FlowSignalLog, settings: FlowSettings): void {
  const intervals = [
    { minutes: 5, key: "r5" },
    { minutes: 15, key: "r15" },
    { minutes: 30, key: "r30" },
    { minutes: 60, key: "r60" },
  ];

  for (const { minutes, key } of intervals) {
    const targetTime = signal.tsUTC + minutes * 60 * 1000;
    const delay = targetTime - Date.now();
    
    if (delay > 0) {
      setTimeout(() => {
        calculateForwardReturn(signal.id, minutes, key as keyof FlowSignalLog, settings);
      }, delay);
    } else {
      // Already past the target time, backfill
      calculateForwardReturn(signal.id, minutes, key as keyof FlowSignalLog, settings);
    }
  }
}

async function calculateForwardReturn(
  signalId: string,
  minutes: number,
  key: keyof FlowSignalLog,
  settings: FlowSettings,
): Promise<void> {
  const signals = loadSignals();
  const signal = signals.find((s) => s.id === signalId);
  if (!signal) return;

  try {
    // Fetch klines for the target time
    const targetTime = signal.tsUTC + minutes * 60 * 1000;
    const interval = minutes <= 5 ? "1m" : minutes <= 15 ? "5m" : minutes <= 30 ? "15m" : "1h";
    const url = `/api/v3/klines?symbol=${signal.symbol}&interval=${interval}&startTime=${targetTime - 60000}&limit=1`;
    
    // Use a simple fetch (no API key needed for public endpoints)
    const response = await fetch(`https://api.binance.com${url}`);
    if (!response.ok) return;
    
    const data = await response.json();
    if (!data || data.length === 0) return;
    
    const close = parseFloat(data[0][4]);
    
    // Calculate R multiple
    const risk = Math.abs(signal.entry - signal.stop);
    const reward = signal.direction === "LONG" 
      ? close - signal.entry
      : signal.entry - close;
    const rMultiple = risk > 0 ? reward / risk : 0;
    
    // Apply fees and slippage
    const feeSlippage = (settings.feeBps + settings.slippageBps) * 2 / 10000; // entry + exit
    const netR = rMultiple - feeSlippage;
    
    // Update signal
    (signal as any)[key] = rMultiple;
    if (key === "r60") {
      signal.netR60 = netR;
    }
    
    saveSignals(signals);
  } catch (error) {
    console.error(`[flowLog] Failed to calculate forward return for ${signalId}:`, error);
  }
}

export function calculateEdgeMetrics(): {
  totalSignals: number;
  signalsPerDay: number;
  winRate: number;
  expectancy: number;
  maxDrawdown: number;
  perTF: Record<string, { count: number; winRate: number; expectancy: number }>;
  perSymbol: Record<string, { count: number; winRate: number; expectancy: number }>;
} {
  const signals = loadSignals();
  const withReturns = signals.filter((s) => s.netR60 !== undefined);
  
  if (withReturns.length === 0) {
    return {
      totalSignals: 0,
      signalsPerDay: 0,
      winRate: 0,
      expectancy: 0,
      maxDrawdown: 0,
      perTF: {},
      perSymbol: {},
    };
  }

  // Calculate time span for signals per day
  const firstSignal = withReturns[0].tsUTC;
  const lastSignal = withReturns[withReturns.length - 1].tsUTC;
  const days = Math.max(1, (lastSignal - firstSignal) / (24 * 60 * 60 * 1000));
  
  // Win rate (netR60 > 0)
  const wins = withReturns.filter((s) => (s.netR60 ?? 0) > 0).length;
  const winRate = wins / withReturns.length;
  
  // Expectancy (mean netR60)
  const expectancy = withReturns.reduce((sum, s) => sum + (s.netR60 ?? 0), 0) / withReturns.length;
  
  // Max drawdown of cumulative netR60 curve
  let cumulative = 0;
  let peak = 0;
  let maxDrawdown = 0;
  for (const signal of withReturns) {
    cumulative += signal.netR60 ?? 0;
    peak = Math.max(peak, cumulative);
    maxDrawdown = Math.max(maxDrawdown, peak - cumulative);
  }
  
  // Per-TF breakdown
  const perTF: Record<string, { count: number; winRate: number; expectancy: number }> = {};
  for (const signal of withReturns) {
    if (!perTF[signal.tf]) {
      perTF[signal.tf] = { count: 0, winRate: 0, expectancy: 0 };
    }
    perTF[signal.tf].count++;
  }
  for (const tf in perTF) {
    const tfSignals = withReturns.filter((s) => s.tf === tf);
    perTF[tf].winRate = tfSignals.filter((s) => (s.netR60 ?? 0) > 0).length / tfSignals.length;
    perTF[tf].expectancy = tfSignals.reduce((sum, s) => sum + (s.netR60 ?? 0), 0) / tfSignals.length;
  }
  
  // Per-symbol breakdown
  const perSymbol: Record<string, { count: number; winRate: number; expectancy: number }> = {};
  for (const signal of withReturns) {
    if (!perSymbol[signal.symbol]) {
      perSymbol[signal.symbol] = { count: 0, winRate: 0, expectancy: 0 };
    }
    perSymbol[signal.symbol].count++;
  }
  for (const symbol in perSymbol) {
    const symbolSignals = withReturns.filter((s) => s.symbol === symbol);
    perSymbol[symbol].winRate = symbolSignals.filter((s) => (s.netR60 ?? 0) > 0).length / symbolSignals.length;
    perSymbol[symbol].expectancy = symbolSignals.reduce((sum, s) => sum + (s.netR60 ?? 0), 0) / symbolSignals.length;
  }
  
  return {
    totalSignals: withReturns.length,
    signalsPerDay: withReturns.length / days,
    winRate,
    expectancy,
    maxDrawdown,
    perTF,
    perSymbol,
  };
}

export function exportToCSV(): string {
  const signals = loadSignals();
  if (signals.length === 0) return "";
  
  const headers = [
    "id", "symbol", "tf", "tsUTC", "tsIST", "direction", "entry", "stop",
    "sweepDepth", "cvdTrend", "netRatio", "wallCount", "priceMove",
    "r5", "r15", "r30", "r60", "netR60"
  ];
  
  const rows = signals.map((s) => [
    s.id, s.symbol, s.tf, s.tsUTC, s.tsIST, s.direction, s.entry, s.stop,
    s.sweepDepth, s.cvdTrend, s.netRatio, s.wallCount, s.priceMove,
    s.r5 ?? "", s.r15 ?? "", s.r30 ?? "", s.r60 ?? "", s.netR60 ?? ""
  ]);
  
  return [headers.join(","), ...rows.map((r) => r.join(","))].join("\n");
}

export function backfillMissingReturns(settings: FlowSettings): void {
  const signals = loadSignals();
  const now = Date.now();
  
  for (const signal of signals) {
    const intervals = [
      { minutes: 5, key: "r5" },
      { minutes: 15, key: "r15" },
      { minutes: 30, key: "r30" },
      { minutes: 60, key: "r60" },
    ];
    
    for (const { minutes, key } of intervals) {
      const targetTime = signal.tsUTC + minutes * 60 * 1000;
      if (now >= targetTime && signal[key as keyof FlowSignalLog] === undefined) {
        calculateForwardReturn(signal.id, minutes, key as keyof FlowSignalLog, settings);
      }
    }
  }
}
