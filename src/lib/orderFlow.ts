import type { Candle, FlowSettings, FlowSnapshot, FlowState, FlowTimeframe } from "./types";

const BINANCE_BASES = ["https://data-api.binance.vision", "https://api.binance.com"];

/* ---------------- REST helpers ---------------- */

async function fetchWithTimeout(url: string, ms: number): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJSON<T>(url: string, timeoutMs = 8000): Promise<T> {
  let lastErr: unknown = null;
  for (const base of BINANCE_BASES) {
    try {
      const res = await fetchWithTimeout(`${base}${url}`, timeoutMs);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (await res.json()) as T;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("fetch failed");
}

/* ---------------- klines ---------------- */

const TF_TO_MS: Record<FlowTimeframe, number> = { "1m": 60_000, "5m": 300_000, "15m": 900_000 };

export async function fetchKlines(symbol: string, tf: FlowTimeframe, limit: number): Promise<Candle[]> {
  const url = `/api/v3/klines?symbol=${symbol}&interval=${tf}&limit=${limit}`;
  const data = await fetchJSON<Array<Array<string | number>>>(url);
  return data.map((k) => ({
    t: Number(k[0]),
    o: Number(k[1]),
    h: Number(k[2]),
    l: Number(k[3]),
    c: Number(k[4]),
    v: Number(k[5]),
  }));
}

/* ---------------- aggTrades ---------------- */

interface AggTrade {
  a: number; // aggregate trade ID
  p: string; // price
  q: string; // quantity
  f: number; // first trade ID
  l: number; // last trade ID
  T: number; // timestamp
  m: boolean; // is buyer the maker?
}

export async function fetchAggTrades(symbol: string, fromId?: number, limit = 1000): Promise<AggTrade[]> {
  const url = `/api/v3/aggTrades?symbol=${symbol}&limit=${limit}${fromId ? `&fromId=${fromId}` : ""}`;
  return await fetchJSON<AggTrade[]>(url);
}

/* ---------------- depth ---------------- */

interface DepthLevel {
  price: string;
  qty: string;
}

interface DepthResponse {
  lastUpdateId: number;
  bids: DepthLevel[];
  asks: DepthLevel[];
}

export async function fetchDepth(symbol: string, limit = 15): Promise<{ bids: DepthLevel[]; asks: DepthLevel[] }> {
  const url = `/api/v3/depth?symbol=${symbol}&limit=${limit}`;
  const data = await fetchJSON<DepthResponse>(url);
  return { bids: data.bids, asks: data.asks };
}

/* ---------------- WS manager ---------------- */

type WSHandler = (data: unknown) => void;

class WSManager {
  private ws: WebSocket | null = null;
  private handlers: Map<string, WSHandler> = new Map();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;
  private reconnectDelay = 2000;

  connect(streams: string[], onMessage: (stream: string, data: unknown) => void): void {
    this.disconnect();

    const streamStr = streams.join("/");
    const url = `wss://stream.binance.com:9443/stream?streams=${streamStr}`;

    try {
      this.ws = new WebSocket(url);

      this.ws.onopen = () => {
        console.info(`[flow] WS connected: ${streamStr}`);
        this.reconnectAttempts = 0;
      };

      this.ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg.stream && msg.data) {
            onMessage(msg.stream, msg.data);
          }
        } catch (e) {
          console.error("[flow] WS parse error:", e);
        }
      };

      this.ws.onerror = (e) => {
        console.error("[flow] WS error:", e);
      };

      this.ws.onclose = () => {
        console.info("[flow] WS closed");
        this.scheduleReconnect(streams, onMessage);
      };
    } catch (e) {
      console.error("[flow] WS connect failed:", e);
      this.scheduleReconnect(streams, onMessage);
    }
  }

  private scheduleReconnect(streams: string[], onMessage: (stream: string, data: unknown) => void): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.warn("[flow] max reconnect attempts reached");
      return;
    }

    this.reconnectAttempts++;
    const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1);
    console.info(`[flow] reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);

    this.reconnectTimer = setTimeout(() => {
      this.connect(streams, onMessage);
    }, delay);
  }

  disconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.reconnectAttempts = 0;
  }
}

export const wsManager = new WSManager();

/* ---------------- condition detectors ---------------- */

interface SweepResult {
  pass: boolean;
  value: string;
  direction: "LONG" | "SHORT" | null;
}

export function detectSweep(candles: Candle[], settings: FlowSettings): SweepResult {
  const lookback = Math.min(settings.lookbackCandles, candles.length - 1);
  if (lookback < 3) return { pass: false, value: "insufficient data", direction: null };

  const recent = candles.slice(-lookback);
  const lastCandle = candles[candles.length - 1];

  // find swing low/high
  let swingLow = Infinity;
  let swingHigh = -Infinity;
  for (const c of recent.slice(0, -1)) {
    swingLow = Math.min(swingLow, c.l);
    swingHigh = Math.max(swingHigh, c.h);
  }

  // check for sweep below swing low
  const sweepBelow = lastCandle.l < swingLow;
  const sweepDepth = sweepBelow ? ((swingLow - lastCandle.l) / swingLow) * 100 : 0;

  if (sweepBelow && sweepDepth >= settings.sweepPercent) {
    // check if price closed back above within 3 candles
    const reclaimWindow = candles.slice(-4);
    const reclaimed = reclaimWindow.some((c, i) => i > 0 && c.c > swingLow);
    if (reclaimed) {
      return { pass: true, value: `${sweepDepth.toFixed(3)}% below ${swingLow.toFixed(2)}`, direction: "LONG" };
    }
  }

  // check for sweep above swing high
  const sweepAbove = lastCandle.h > swingHigh;
  const sweepDepthAbove = sweepAbove ? ((lastCandle.h - swingHigh) / swingHigh) * 100 : 0;

  if (sweepAbove && sweepDepthAbove >= settings.sweepPercent) {
    const reclaimWindow = candles.slice(-4);
    const reclaimed = reclaimWindow.some((c, i) => i > 0 && c.c < swingHigh);
    if (reclaimed) {
      return { pass: true, value: `${sweepDepthAbove.toFixed(3)}% above ${swingHigh.toFixed(2)}`, direction: "SHORT" };
    }
  }

  return { pass: false, value: sweepBelow ? `${sweepDepth.toFixed(3)}% (no reclaim)` : "no sweep", direction: null };
}

interface CVDResult {
  pass: boolean;
  value: string;
  direction: "LONG" | "SHORT" | null;
}

export function detectCVD(trades: AggTrade[], candles: Candle[]): CVDResult {
  if (trades.length < 10 || candles.length < 2) {
    return { pass: false, value: "insufficient data", direction: null };
  }

  // filter trades to last 30 minutes
  const cutoff = Date.now() - 30 * 60 * 1000;
  const recentTrades = trades.filter((t) => t.T >= cutoff);

  if (recentTrades.length < 10) {
    return { pass: false, value: "insufficient recent trades", direction: null };
  }

  // calculate CVD (cumulative volume delta)
  let cvd = 0;
  const cvdPoints: Array<{ t: number; cvd: number }> = [];

  for (const trade of recentTrades) {
    const qty = parseFloat(trade.q);
    const delta = trade.m ? -qty : qty; // m=true means buyer is maker (sell)
    cvd += delta;
    cvdPoints.push({ t: trade.T, cvd });
  }

  // check for divergence with price
  const lastCandle = candles[candles.length - 1];
  const prevCandle = candles[candles.length - 2];

  const priceLowerLow = lastCandle.l < prevCandle.l;
  const priceHigherHigh = lastCandle.h > prevCandle.h;

  // CVD trend (last 10% of points)
  const recentCVD = cvdPoints.slice(-Math.floor(cvdPoints.length * 0.1));
  if (recentCVD.length < 2) {
    return { pass: false, value: "insufficient CVD data", direction: null };
  }

  const cvdStart = recentCVD[0].cvd;
  const cvdEnd = recentCVD[recentCVD.length - 1].cvd;
  const cvdTrend = cvdEnd - cvdStart;

  // bullish divergence: price lower low + CVD higher low (positive trend)
  if (priceLowerLow && cvdTrend > 0) {
    return { pass: true, value: `bullish div (price LL, CVD +${cvdTrend.toFixed(0)})`, direction: "LONG" };
  }

  // bearish divergence: price higher high + CVD lower high (negative trend)
  if (priceHigherHigh && cvdTrend < 0) {
    return { pass: true, value: `bearish div (price HH, CVD ${cvdTrend.toFixed(0)})`, direction: "SHORT" };
  }

  // delta flip: CVD flips positive while price near swept low
  if (cvdStart < 0 && cvdEnd > 0 && priceLowerLow) {
    return { pass: true, value: `delta flip (+${cvdTrend.toFixed(0)})`, direction: "LONG" };
  }

  if (cvdStart > 0 && cvdEnd < 0 && priceHigherHigh) {
    return { pass: true, value: `delta flip (${cvdTrend.toFixed(0)})`, direction: "SHORT" };
  }

  return { pass: false, value: `CVD ${cvdTrend >= 0 ? "+" : ""}${cvdTrend.toFixed(0)}`, direction: null };
}

interface AbsorptionResult {
  pass: boolean;
  value: string;
  direction: "LONG" | "SHORT" | null;
}

export function detectAbsorption(
  depth: { bids: DepthLevel[]; asks: DepthLevel[] },
  trades: AggTrade[],
  candles: Candle[],
  settings: FlowSettings,
): AbsorptionResult {
  const { bids, asks } = depth;
  if (bids.length < 15 || asks.length < 15 || candles.length < 2) {
    return { pass: false, value: "insufficient data", direction: null };
  }

  const top15Bids = bids.slice(0, 15).map((b) => parseFloat(b.qty));
  const top15Asks = asks.slice(0, 15).map((a) => parseFloat(a.qty));

  const medianBid = top15Bids.sort((a, b) => a - b)[Math.floor(top15Bids.length / 2)];
  const medianAsk = top15Asks.sort((a, b) => a - b)[Math.floor(top15Asks.length / 2)];

  // check for bid walls (LONG absorption)
  const bidWalls = top15Bids.filter((qty) => qty >= medianBid * settings.wallMultiplier);
  const bidWallCount = bidWalls.length;

  // check for ask walls (SHORT absorption)
  const askWalls = top15Asks.filter((qty) => qty >= medianAsk * settings.wallMultiplier);
  const askWallCount = askWalls.length;

  // check for negative delta bursts with small price move
  const lastCandle = candles[candles.length - 1];
  const prevCandle = candles[candles.length - 2];
  const priceMove = Math.abs(((lastCandle.c - prevCandle.c) / prevCandle.c) * 100);

  // filter trades to last candle
  const recentTrades = trades.filter((t) => t.T >= lastCandle.t);
  let delta = 0;
  for (const trade of recentTrades) {
    const qty = parseFloat(trade.q);
    delta += trade.m ? -qty : qty;
  }

  const negativeDelta = delta < 0;
  const smallPriceMove = priceMove < settings.absorptionThreshold;

  // LONG absorption: bid walls + negative delta + small price move
  if (bidWallCount >= 2 && negativeDelta && smallPriceMove) {
    return {
      pass: true,
      value: `${bidWallCount} bid walls, delta ${delta.toFixed(0)}, move ${priceMove.toFixed(3)}%`,
      direction: "LONG",
    };
  }

  // SHORT absorption: ask walls + positive delta + small price move
  if (askWallCount >= 2 && !negativeDelta && smallPriceMove) {
    return {
      pass: true,
      value: `${askWallCount} ask walls, delta +${delta.toFixed(0)}, move ${priceMove.toFixed(3)}%`,
      direction: "SHORT",
    };
  }

  return {
    pass: false,
    value: `bids ${bidWallCount}, asks ${askWallCount}, delta ${delta >= 0 ? "+" : ""}${delta.toFixed(0)}`,
    direction: null,
  };
}

/* ---------------- main update ---------------- */

export async function updateFlow(
  state: FlowState,
  settings: FlowSettings,
): Promise<FlowSnapshot> {
  const sweep = detectSweep(state.candles, settings);
  const cvd = detectCVD(state.trades, state.candles);
  const absorption = detectAbsorption(state.depth, state.trades, state.candles, settings);

  const score = [sweep.pass, cvd.pass, absorption.pass].filter(Boolean).length;

  // determine direction only if all 3 pass and agree
  let direction: "LONG" | "SHORT" | null = null;
  if (score === 3) {
    const directions = [sweep.direction, cvd.direction, absorption.direction];
    const longCount = directions.filter((d) => d === "LONG").length;
    const shortCount = directions.filter((d) => d === "SHORT").length;
    if (longCount === 3) direction = "LONG";
    else if (shortCount === 3) direction = "SHORT";
  }

  return {
    symbol: state.symbol,
    timeframe: state.timeframe,
    timestamp: Date.now(),
    sweep,
    cvd,
    absorption,
    score,
    direction,
  };
}
