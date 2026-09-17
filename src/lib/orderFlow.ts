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

  // PATCH 1 FIX: Identify sweepIndex - the candle that actually swept the low
  // Check last 4 candles for sweep (l < swingLow by >= sweepPercent)
  let sweepIndex = -1;
  let sweepDepth = 0;
  for (let i = candles.length - 4; i < candles.length; i++) {
    if (i < 0) continue;
    const c = candles[i];
    if (c.l < swingLow) {
      const depth = ((swingLow - c.l) / swingLow) * 100;
      if (depth >= settings.sweepPercent) {
        sweepIndex = i;
        sweepDepth = depth;
        break; // take first sweep found
      }
    }
  }

  // PATCH 1 FIX: If sweep found, check if reclaimed AFTER sweep (not before)
  if (sweepIndex >= 0) {
    // Check if any candle from sweepIndex onwards closed above swingLow
    const reclaimed = candles.slice(sweepIndex).some((c) => c.c > swingLow);
    
    // PATCH 1 FIX: If last candle closes below swingLow, it's a breakdown, not a sweep
    if (lastCandle.c < swingLow) {
      return { pass: false, value: `${sweepDepth.toFixed(3)}% breakdown (close below)`, direction: null };
    }
    
    if (reclaimed) {
      return { pass: true, value: `${sweepDepth.toFixed(3)}% below ${swingLow.toFixed(2)}`, direction: "LONG" };
    }
  }

  // check for sweep above swing high (mirror logic)
  let sweepIndexHigh = -1;
  let sweepDepthAbove = 0;
  for (let i = candles.length - 4; i < candles.length; i++) {
    if (i < 0) continue;
    const c = candles[i];
    if (c.h > swingHigh) {
      const depth = ((c.h - swingHigh) / swingHigh) * 100;
      if (depth >= settings.sweepPercent) {
        sweepIndexHigh = i;
        sweepDepthAbove = depth;
        break;
      }
    }
  }

  if (sweepIndexHigh >= 0) {
    const reclaimed = candles.slice(sweepIndexHigh).some((c) => c.c < swingHigh);
    
    // If last candle closes above swingHigh, it's a breakdown, not a sweep
    if (lastCandle.c > swingHigh) {
      return { pass: false, value: `${sweepDepthAbove.toFixed(3)}% breakdown (close above)`, direction: null };
    }
    
    if (reclaimed) {
      return { pass: true, value: `${sweepDepthAbove.toFixed(3)}% above ${swingHigh.toFixed(2)}`, direction: "SHORT" };
    }
  }

  return { pass: false, value: sweepDepth > 0 ? `${sweepDepth.toFixed(3)}% (no reclaim)` : "no sweep", direction: null };
}

interface CVDResult {
  pass: boolean;
  value: string;
  direction: "LONG" | "SHORT" | null;
}

export function detectCVD(trades: AggTrade[], candles: Candle[], settings: FlowSettings): CVDResult {
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
  let grossVolume = 0;
  const cvdPoints: Array<{ t: number; cvd: number }> = [];

  for (const trade of recentTrades) {
    const qty = parseFloat(trade.q);
    const delta = trade.m ? -qty : qty; // m=true means buyer is maker (sell)
    cvd += delta;
    grossVolume += qty;
    cvdPoints.push({ t: trade.T, cvd });
  }

  // PATCH 2 FIX: priceLowerLow compares to min of last 5 candles, not just previous
  const lastCandle = candles[candles.length - 1];
  const priorLows = candles.slice(-6, -1).map((c) => c.l);
  const minPriorLow = Math.min(...priorLows);
  const priceLowerLow = lastCandle.l < minPriorLow;
  
  const priorHighs = candles.slice(-6, -1).map((c) => c.h);
  const maxPriorHigh = Math.max(...priorHighs);
  const priceHigherHigh = lastCandle.h > maxPriorHigh;

  // CVD trend (last 10% of points)
  const recentCVD = cvdPoints.slice(-Math.floor(cvdPoints.length * 0.1));
  if (recentCVD.length < 2) {
    return { pass: false, value: "insufficient CVD data", direction: null };
  }

  const cvdStart = recentCVD[0].cvd;
  const cvdEnd = recentCVD[recentCVD.length - 1].cvd;
  const cvdTrend = cvdEnd - cvdStart;

  // PATCH 2 FIX: Calculate netRatio with tolerance check
  const netRatio = grossVolume > 0 ? Math.abs(cvdTrend) / grossVolume : 0;
  const cvdNetRatioThreshold = settings.cvdNetRatio ?? 0.10;

  // bullish divergence: price lower low + CVD higher low (positive trend) with tolerance
  if (priceLowerLow && cvdTrend > 0 && netRatio >= cvdNetRatioThreshold) {
    return { pass: true, value: `bullish div (price LL, CVD +${cvdTrend.toFixed(0)}, ratio ${netRatio.toFixed(2)})`, direction: "LONG" };
  }

  // bearish divergence: price higher high + CVD lower high (negative trend) with tolerance
  if (priceHigherHigh && cvdTrend < 0 && netRatio >= cvdNetRatioThreshold) {
    return { pass: true, value: `bearish div (price HH, CVD ${cvdTrend.toFixed(0)}, ratio ${netRatio.toFixed(2)})`, direction: "SHORT" };
  }

  // PATCH 2 FIX: delta flip requires proximity to sweepLow (within 0.10%)
  // Find recent sweep low for proximity check
  const recentLows = candles.slice(-20).map((c) => c.l);
  const sweepLow = Math.min(...recentLows);
  const proximityToSweepLow = Math.abs((lastCandle.c - sweepLow) / sweepLow) * 100;
  const proximityThreshold = 0.10; // 0.10%

  if (cvdStart < 0 && cvdEnd > 0 && priceLowerLow && proximityToSweepLow <= proximityThreshold) {
    return { pass: true, value: `delta flip (+${cvdTrend.toFixed(0)}, ${proximityToSweepLow.toFixed(2)}% from sweep)`, direction: "LONG" };
  }

  const recentHighs = candles.slice(-20).map((c) => c.h);
  const sweepHigh = Math.max(...recentHighs);
  const proximityToSweepHigh = Math.abs((lastCandle.c - sweepHigh) / sweepHigh) * 100;

  if (cvdStart > 0 && cvdEnd < 0 && priceHigherHigh && proximityToSweepHigh <= proximityThreshold) {
    return { pass: true, value: `delta flip (${cvdTrend.toFixed(0)}, ${proximityToSweepHigh.toFixed(2)}% from sweep)`, direction: "SHORT" };
  }

  return { pass: false, value: `CVD ${cvdTrend >= 0 ? "+" : ""}${cvdTrend.toFixed(0)}, ratio ${netRatio.toFixed(2)}`, direction: null };
}

interface AbsorptionResult {
  pass: boolean;
  value: string;
  direction: "LONG" | "SHORT" | null;
}

// PATCH 3: Wall registry for persistence tracking
interface WallEntry {
  firstSeen: number;
  lastSeen: number;
  size: number;
  price: number;
}

const wallRegistry = new Map<string, WallEntry>();

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

  const now = Date.now();
  const wallPersistMs = settings.wallPersistMs ?? 3000;

  // PATCH 3 FIX: Use const sorted = [...array].sort() to avoid in-place mutation
  const top15Bids = bids.slice(0, 15).map((b) => ({ price: parseFloat(b.price), qty: parseFloat(b.qty) }));
  const top15Asks = asks.slice(0, 15).map((a) => ({ price: parseFloat(a.price), qty: parseFloat(a.qty) }));

  const sortedBids = [...top15Bids].sort((a, b) => a.qty - b.qty);
  const sortedAsks = [...top15Asks].sort((a, b) => a.qty - b.qty);

  const medianBid = sortedBids[Math.floor(sortedBids.length / 2)].qty;
  const medianAsk = sortedAsks[Math.floor(sortedAsks.length / 2)].qty;

  // PATCH 3: Update wall registry with current snapshot
  const wallThresholdBid = medianBid * settings.wallMultiplier;
  const wallThresholdAsk = medianAsk * settings.wallMultiplier;

  // Track bid walls
  for (const bid of top15Bids) {
    if (bid.qty >= wallThresholdBid) {
      const key = `bid_${bid.price.toFixed(2)}`;
      const existing = wallRegistry.get(key);
      if (existing) {
        // PATCH 3: Step-up logic - wall size must be >= firstSeen * 1.05 or be a new wall
        if (bid.qty >= existing.size * 1.05) {
          existing.lastSeen = now;
          existing.size = bid.qty;
        }
      } else {
        wallRegistry.set(key, { firstSeen: now, lastSeen: now, size: bid.qty, price: bid.price });
      }
    }
  }

  // Track ask walls
  for (const ask of top15Asks) {
    if (ask.qty >= wallThresholdAsk) {
      const key = `ask_${ask.price.toFixed(2)}`;
      const existing = wallRegistry.get(key);
      if (existing) {
        if (ask.qty >= existing.size * 1.05) {
          existing.lastSeen = now;
          existing.size = ask.qty;
        }
      } else {
        wallRegistry.set(key, { firstSeen: now, lastSeen: now, size: ask.qty, price: ask.price });
      }
    }
  }

  // PATCH 3: Count only persistent walls (lastSeen - firstSeen >= wallPersistMs)
  const persistentBidWalls = Array.from(wallRegistry.values()).filter(
    (w) => w.price && now - w.firstSeen >= wallPersistMs && now - w.lastSeen < 1000 // still present
  );
  const bidWallCount = persistentBidWalls.length;

  const persistentAskWalls = Array.from(wallRegistry.values()).filter(
    (w) => w.price && now - w.firstSeen >= wallPersistMs && now - w.lastSeen < 1000
  );
  const askWallCount = persistentAskWalls.length;

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
      value: `${bidWallCount} persistent bid walls, delta ${delta.toFixed(0)}, move ${priceMove.toFixed(3)}%`,
      direction: "LONG",
    };
  }

  // SHORT absorption: ask walls + positive delta + small price move
  if (askWallCount >= 2 && !negativeDelta && smallPriceMove) {
    return {
      pass: true,
      value: `${askWallCount} persistent ask walls, delta +${delta.toFixed(0)}, move ${priceMove.toFixed(3)}%`,
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
  const cvd = detectCVD(state.trades, state.candles, settings);
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
