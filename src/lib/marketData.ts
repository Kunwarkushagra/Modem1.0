import type { AssetType, Candle, Timeframe } from "./types";
import { fetchWithTimeout, hashStr, mulberry32, normSymbol, okxInstId, stooqSymbol, TF_MINUTES, withRetries, yahooSymbol } from "./utils";

export interface FetchResult { candles: Candle[]; source: string; simulated: boolean }

const BINANCE_BASES = ["https://data-api.binance.vision", "https://api.binance.com"];

const BINANCE_TF: Record<Timeframe, string> = { "5m": "5m", "15m": "15m", "30m": "30m", "1h": "1h", "4h": "4h", "1d": "1d" };
const OKX_TF: Record<Timeframe, string> = { "5m": "5m", "15m": "15m", "30m": "30m", "1h": "1H", "4h": "4H", "1d": "1D" };

function yahooParams(tf: Timeframe): { interval: string; range: string } {
  switch (tf) {
    case "5m": return { interval: "5m", range: "1mo" };
    case "15m": return { interval: "15m", range: "1mo" };
    case "30m": return { interval: "30m", range: "3mo" };
    case "1h": return { interval: "1h", range: "3mo" };
    case "4h": return { interval: "1h", range: "6mo" };
    case "1d": return { interval: "1d", range: "2y" };
  }
}

function aggregate(candles: Candle[], factor: number): Candle[] {
  if (factor <= 1) return candles;
  const out: Candle[] = [];
  for (let i = 0; i + factor <= candles.length; i += factor) {
    const chunk = candles.slice(i, i + factor);
    out.push({
      t: chunk[0].t,
      o: chunk[0].o,
      c: chunk[chunk.length - 1].c,
      h: Math.max(...chunk.map((c) => c.h)),
      l: Math.min(...chunk.map((c) => c.l)),
      v: chunk.reduce((s, c) => s + c.v, 0),
    });
  }
  return out;
}

function sliceTail(candles: Candle[], limit: number): Candle[] {
  return candles.length > limit ? candles.slice(candles.length - limit) : candles;
}

async function binanceFetch(symbol: string, tf: Timeframe, limit: number, endTime?: number): Promise<Candle[]> {
  let err: unknown = null;
  for (const base of BINANCE_BASES) {
    try {
      const url = `${base}/api/v3/klines?symbol=${symbol}&interval=${BINANCE_TF[tf]}&limit=${Math.min(limit, 1000)}${endTime ? `&endTime=${endTime}` : ""}`;
      const res = await fetchWithTimeout(url, 9000);
      if (!res.ok) throw new Error(`binance ${res.status}`);
      const data = (await res.json()) as unknown[];
      return (data as Array<Array<string | number>>).map((k) => ({
        t: Number(k[0]), o: Number(k[1]), h: Number(k[2]), l: Number(k[3]), c: Number(k[4]), v: Number(k[5]),
      }));
    } catch (e) { err = e; }
  }
  throw err instanceof Error ? err : new Error("binance unreachable");
}

async function okxFetch(symbol: string, tf: Timeframe, limit: number): Promise<Candle[]> {
  const url = `https://www.okx.com/api/v5/market/candles?instId=${okxInstId(symbol)}&bar=${OKX_TF[tf]}&limit=${Math.min(limit, 300)}`;
  const res = await fetchWithTimeout(url, 9000);
  if (!res.ok) throw new Error(`okx ${res.status}`);
  const json = (await res.json()) as { code?: string; data?: string[][] };
  if (json.code !== "0" || !json.data) throw new Error("okx error " + (json.code ?? "?"));
  // OKX returns newest first: [ts, o, h, l, c, vol, ...]
  return json.data
    .map((k) => ({ t: Number(k[0]), o: Number(k[1]), h: Number(k[2]), l: Number(k[3]), c: Number(k[4]), v: Number(k[5]) }))
    .reverse();
}

async function yahooFetch(symbol: string, asset: AssetType, tf: Timeframe, limit: number): Promise<Candle[]> {
  const { interval, range } = yahooParams(tf);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${yahooSymbol(symbol, asset)}?interval=${interval}&range=${range}`;
  const res = await fetchWithTimeout(url, 9000);
  if (!res.ok) throw new Error(`yahoo ${res.status}`);
  const json = (await res.json()) as {
    chart?: { result?: Array<{ timestamp?: number[]; indicators?: { quote?: Array<{ open?: Array<number | null>; high?: Array<number | null>; low?: Array<number | null>; close?: Array<number | null>; volume?: Array<number | null> }> } }> };
  };
  const r = json.chart?.result?.[0];
  if (!r?.timestamp) throw new Error("yahoo empty");
  const q = r.indicators?.quote?.[0];
  if (!q) throw new Error("yahoo no quote");
  const out: Candle[] = [];
  for (let i = 0; i < r.timestamp.length; i++) {
    const o = q.open?.[i], h = q.high?.[i], l = q.low?.[i], c = q.close?.[i];
    if (o == null || h == null || l == null || c == null) continue;
    out.push({ t: r.timestamp[i] * 1000, o, h, l, c, v: q.volume?.[i] ?? 0 });
  }
  if (out.length < 30) throw new Error("yahoo too few candles");
  const factor = tf === "4h" ? 4 : 1;
  return sliceTail(aggregate(out, factor), limit);
}

async function stooqFetch(symbol: string, asset: AssetType, limit: number): Promise<Candle[]> {
  const proxied = `https://api.allorigins.win/raw?url=${encodeURIComponent(`https://stooq.com/q/d/l/?s=${stooqSymbol(symbol, asset)}&i=d`)}`;
  const res = await fetchWithTimeout(proxied, 10000);
  if (!res.ok) throw new Error(`stooq ${res.status}`);
  const text = await res.text();
  const lines = text.trim().split("\n");
  if (lines.length < 3 || !lines[0].toLowerCase().startsWith("date")) throw new Error("stooq bad csv");
  const out: Candle[] = [];
  for (let i = 1; i < lines.length; i++) {
    const p = lines[i].split(",");
    if (p.length < 5) continue;
    const t = Date.parse(p[0]);
    const o = Number(p[1]), h = Number(p[2]), l = Number(p[3]), c = Number(p[4]);
    if (!isFinite(t) || !isFinite(c)) continue;
    out.push({ t, o, h, l, c, v: Number(p[5] ?? 0) });
  }
  if (out.length < 30) throw new Error("stooq too few rows");
  return sliceTail(out, limit);
}

const SIM_BASE: Record<AssetType, number> = { crypto: 64000, stock: 190, forex: 1.085 };

function simulate(symbol: string, asset: AssetType, tf: Timeframe, limit: number): Candle[] {
  const rnd = mulberry32(hashStr(symbol + tf + asset));
  const stepMs = TF_MINUTES[tf] * 60_000;
  const end = Math.floor(Date.now() / stepMs) * stepMs;
  let price = (SIM_BASE[asset] ?? 100) * (0.6 + rnd() * 1.4);
  if (asset === "forex") price = 0.5 + rnd() * 1.6;
  const vol = asset === "crypto" ? 0.011 : asset === "forex" ? 0.0016 : 0.006;
  const out: Candle[] = [];
  let drift = 0;
  for (let i = 0; i < limit; i++) {
    if (i % 42 === 0) drift = (rnd() - 0.48) * vol * 1.6;
    const o = price;
    const shock = (rnd() - 0.5) * 2 * vol * price;
    const c = Math.max(o + drift * price + shock, price * 0.9);
    const h = Math.max(o, c) + rnd() * vol * price * 0.7;
    const l = Math.min(o, c) - rnd() * vol * price * 0.7;
    const v = (asset === "forex" ? 900 : asset === "stock" ? 420_000 : 130) * (0.4 + rnd() * 1.8) * (1 + Math.abs(shock) / (vol * price));
    out.push({ t: end - (limit - 1 - i) * stepMs, o, h, l: Math.max(l, 0.000001), c, v: Math.round(v) });
    price = c;
  }
  return out;
}

export async function fetchCandles(
  rawSymbol: string,
  asset: AssetType,
  tf: Timeframe,
  limit = 300,
  log?: (msg: string, kind?: "info" | "ok" | "warn" | "err") => void,
): Promise<FetchResult> {
  const symbol = normSymbol(rawSymbol, asset);
  const chain: Array<{ name: string; run: () => Promise<Candle[]> }> =
    asset === "crypto"
      ? [
          { name: "Binance", run: () => binanceFetch(symbol, tf, limit) },
          { name: "OKX", run: () => okxFetch(symbol, tf, limit) },
        ]
      : [
          { name: "Yahoo Finance", run: () => yahooFetch(symbol, asset, tf, limit) },
          { name: "Stooq", run: () => stooqFetch(symbol, asset, limit) },
        ];

  for (const src of chain) {
    try {
      log?.(`fetch ${symbol} ${tf} ← ${src.name}…`);
      const candles = await withRetries(src.run, 1, src.name);
      if (candles.length >= 30) {
        log?.(`${src.name}: ${candles.length} candles ✓`, "ok");
        return { candles: sliceTail(candles, limit), source: src.name, simulated: false };
      }
      log?.(`${src.name}: insufficient data (${candles.length})`, "warn");
    } catch (e) {
      log?.(`${src.name} failed: ${e instanceof Error ? e.message : "network"}`, "warn");
    }
  }
  log?.(`all feeds unreachable → simulated reference feed`, "warn");
  return { candles: simulate(symbol, asset, tf, limit), source: "SIM", simulated: true };
}

export async function fetchHistory(
  rawSymbol: string,
  asset: AssetType,
  tf: Timeframe,
  days: number,
  log?: (msg: string, kind?: "info" | "ok" | "warn" | "err") => void,
): Promise<FetchResult> {
  const symbol = normSymbol(rawSymbol, asset);
  const need = Math.min(Math.ceil((days * 1440) / TF_MINUTES[tf]) + 220, 1600);

  if (asset === "crypto") {
    try {
      log?.(`history ${symbol} ${tf} ← Binance (${days}d)…`);
      const stepMs = TF_MINUTES[tf] * 60_000;
      const end = Date.now();
      const collected: Candle[] = [];
      let cursor = end;
      while (collected.length < need) {
        const chunk = await binanceFetch(symbol, tf, 1000, cursor - 1);
        if (!chunk.length) break;
        collected.unshift(...chunk);
        cursor = chunk[0].t - stepMs;
        if (chunk.length < 500) break;
      }
      const cutoff = end - days * 86_400_000 - 220 * stepMs;
      const trimmed = collected.filter((c) => c.t >= cutoff);
      if (trimmed.length >= 260) {
        log?.(`Binance history: ${trimmed.length} candles ✓`, "ok");
        return { candles: sliceTail(trimmed, need), source: "Binance", simulated: false };
      }
      throw new Error("short history");
    } catch (e) {
      log?.(`Binance history failed (${e instanceof Error ? e.message : "?"}) → range fetch`, "warn");
    }
  }
  // non-crypto or crypto fallback: use standard 300-candle fetch window (covers range per timeframe)
  return fetchCandles(symbol, asset, tf, Math.min(need, asset === "crypto" ? 1000 : 300), log);
}

export async function fetchLastPrice(rawSymbol: string, asset: AssetType, tf: Timeframe): Promise<number | null> {
  const symbol = normSymbol(rawSymbol, asset);
  try {
    if (asset === "crypto") {
      const res = await fetchWithTimeout(`${BINANCE_BASES[0]}/api/v3/klines?symbol=${symbol}&interval=${BINANCE_TF[tf]}&limit=1`, 5000);
      if (res.ok) {
        const d = (await res.json()) as Array<Array<string | number>>;
        if (d.length) return Number(d[0][4]);
      }
      throw new Error("binance");
    }
    const res = await fetchWithTimeout(`https://query1.finance.yahoo.com/v8/finance/chart/${yahooSymbol(symbol, asset)}?interval=5m&range=1d`, 5000);
    if (!res.ok) throw new Error("yahoo");
    const j = (await res.json()) as { chart?: { result?: Array<{ meta?: { regularMarketPrice?: number } }> } };
    return j.chart?.result?.[0]?.meta?.regularMarketPrice ?? null;
  } catch {
    return null;
  }
}

export interface TickerQuote { symbol: string; label: string; price: number; changePct: number; asset: AssetType }

export async function fetchTickerBatch(): Promise<TickerQuote[]> {
  const quotes: TickerQuote[] = [];
  try {
    const syms = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT"];
    const res = await fetchWithTimeout(`${BINANCE_BASES[0]}/api/v3/ticker/24hr?symbols=${encodeURIComponent(JSON.stringify(syms))}`, 6000);
    if (res.ok) {
      const data = (await res.json()) as Array<{ symbol: string; lastPrice: string; priceChangePercent: string }>;
      for (const d of data) {
        quotes.push({ symbol: d.symbol, label: d.symbol.replace("USDT", "/USDT"), price: Number(d.lastPrice), changePct: Number(d.priceChangePercent), asset: "crypto" });
      }
    }
  } catch { /* ignore */ }
  try {
    const res = await fetchWithTimeout("https://query1.finance.yahoo.com/v8/finance/spark?symbols=AAPL%2CSPY%2CEURUSD%3DX%2CGBPUSD%3DX&range=1d&interval=5m", 6000);
    if (res.ok) {
      const j = (await res.json()) as { spark?: { result?: Array<{ symbol: string; response?: Array<{ meta?: { regularMarketPrice?: number; previousClose?: number } }> }> } };
      for (const r of j.spark?.result ?? []) {
        const meta = r.response?.[0]?.meta;
        if (meta?.regularMarketPrice != null) {
          const prev = meta.previousClose ?? meta.regularMarketPrice;
          const label = r.symbol.includes("=") ? r.symbol.replace("=X", "") : r.symbol;
          quotes.push({ symbol: r.symbol, label, price: meta.regularMarketPrice, changePct: prev ? ((meta.regularMarketPrice - prev) / prev) * 100 : 0, asset: r.symbol.includes("=") ? "forex" : "stock" });
        }
      }
    }
  } catch { /* ignore */ }
  return quotes;
}
