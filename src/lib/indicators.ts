import type { Candle, IndicatorSet, SRLevel } from "./types";

function sma(src: number[], period: number): number[] {
  const out = new Array(src.length).fill(NaN);
  let sum = 0;
  for (let i = 0; i < src.length; i++) {
    sum += src[i];
    if (i >= period) sum -= src[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

export function ema(src: number[], period: number): number[] {
  const out = new Array(src.length).fill(NaN);
  if (src.length < period) return out;
  const k = 2 / (period + 1);
  let seed = 0;
  for (let i = 0; i < period; i++) seed += src[i];
  out[period - 1] = seed / period;
  for (let i = period; i < src.length; i++) out[i] = src[i] * k + out[i - 1] * (1 - k);
  return out;
}

export function rsi(closes: number[], period = 14): number[] {
  const out = new Array(closes.length).fill(NaN);
  if (closes.length <= period) return out;
  let avgG = 0, avgL = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) avgG += d; else avgL -= d;
  }
  avgG /= period; avgL /= period;
  out[period] = avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL);
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgG = (avgG * (period - 1) + Math.max(d, 0)) / period;
    avgL = (avgL * (period - 1) + Math.max(-d, 0)) / period;
    out[i] = avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL);
  }
  return out;
}

function macdCalc(closes: number[], fast: number, slow: number, signalP: number) {
  const fastE = ema(closes, fast);
  const slowE = ema(closes, slow);
  const line = closes.map((_, i) => (isFinite(fastE[i]) && isFinite(slowE[i]) ? fastE[i] - slowE[i] : NaN));
  const valid = line.map((v) => (isFinite(v) ? v : 0));
  const sigRaw = ema(valid, signalP);
  const signal = line.map((v, i) => (isFinite(v) && isFinite(sigRaw[i]) && i >= slow - 1 ? sigRaw[i] : NaN));
  const hist = line.map((v, i) => (isFinite(v) && isFinite(signal[i]) ? v - signal[i] : NaN));
  return { line, signal, hist };
}

function trueRanges(candles: Candle[]): number[] {
  return candles.map((c, i) => {
    if (i === 0) return c.h - c.l;
    const prev = candles[i - 1].c;
    return Math.max(c.h - c.l, Math.abs(c.h - prev), Math.abs(c.l - prev));
  });
}

function wilder(src: number[], period: number): number[] {
  const out = new Array(src.length).fill(NaN);
  if (src.length < period) return out;
  let sum = 0;
  for (let i = 0; i < period; i++) sum += src[i];
  out[period - 1] = sum / period;
  for (let i = period; i < src.length; i++) out[i] = (out[i - 1] * (period - 1) + src[i]) / period;
  return out;
}

export function atr(candles: Candle[], period = 14): number[] {
  return wilder(trueRanges(candles), period);
}

function bollinger(closes: number[], period = 20, mult = 2) {
  const mid = sma(closes, period);
  const upper = new Array(closes.length).fill(NaN);
  const lower = new Array(closes.length).fill(NaN);
  for (let i = period - 1; i < closes.length; i++) {
    let s = 0;
    for (let j = i - period + 1; j <= i; j++) s += (closes[j] - mid[i]) ** 2;
    const sd = Math.sqrt(s / period);
    upper[i] = mid[i] + mult * sd;
    lower[i] = mid[i] - mult * sd;
  }
  return { upper, mid, lower };
}

function stochRsi(closes: number[], rsiP = 14, stochP = 14, kP = 3, dP = 3) {
  const r = rsi(closes, rsiP);
  const raw = new Array(closes.length).fill(NaN);
  for (let i = 0; i < closes.length; i++) {
    if (i < stochP - 1) continue;
    let hi = -Infinity, lo = Infinity, ok = true;
    for (let j = i - stochP + 1; j <= i; j++) {
      if (!isFinite(r[j])) { ok = false; break; }
      hi = Math.max(hi, r[j]); lo = Math.min(lo, r[j]);
    }
    if (ok && hi > lo) raw[i] = ((r[i] - lo) / (hi - lo)) * 100;
    else if (ok) raw[i] = 50;
  }
  const k = sma(raw.map((v) => (isFinite(v) ? v : NaN)), kP).map((v, i) => (isFinite(raw[i]) ? v : NaN));
  const dSrc = k.map((v) => (isFinite(v) ? v : NaN));
  const d = sma(dSrc.map((v) => (isFinite(v) ? v : 0)), dP).map((v, i) => (isFinite(k[i]) && i >= 0 && isFinite(dSrc[i]) ? v : NaN));
  return { k, d };
}

function vwap(candles: Candle[]): number[] {
  const out = new Array(candles.length).fill(NaN);
  let cumPV = 0, cumV = 0;
  for (let i = 0; i < candles.length; i++) {
    const tp = (candles[i].h + candles[i].l + candles[i].c) / 3;
    cumPV += tp * candles[i].v;
    cumV += candles[i].v;
    out[i] = cumV > 0 ? cumPV / cumV : candles[i].c;
  }
  return out;
}

function adxCalc(candles: Candle[], period = 14): number[] {
  const out = new Array(candles.length).fill(NaN);
  if (candles.length < period * 2 + 1) return out;
  const plusDM: number[] = [0];
  const minusDM: number[] = [0];
  const tr: number[] = [candles[0].h - candles[0].l];
  for (let i = 1; i < candles.length; i++) {
    const up = candles[i].h - candles[i - 1].h;
    const dn = candles[i - 1].l - candles[i].l;
    plusDM.push(up > dn && up > 0 ? up : 0);
    minusDM.push(dn > up && dn > 0 ? dn : 0);
    tr.push(Math.max(candles[i].h - candles[i].l, Math.abs(candles[i].h - candles[i - 1].c), Math.abs(candles[i].l - candles[i - 1].c)));
  }
  const trS = wilder(tr, period);
  const plusS = wilder(plusDM, period);
  const minusS = wilder(minusDM, period);
  const dx = new Array(candles.length).fill(NaN);
  for (let i = period - 1; i < candles.length; i++) {
    if (!isFinite(trS[i]) || trS[i] === 0) continue;
    const pdi = (100 * plusS[i]) / trS[i];
    const mdi = (100 * minusS[i]) / trS[i];
    const s = pdi + mdi;
    dx[i] = s === 0 ? 0 : (100 * Math.abs(pdi - mdi)) / s;
  }
  let prev = NaN;
  let seedSum = 0, seeded = 0;
  for (let i = 0; i < candles.length; i++) {
    if (!isFinite(dx[i])) continue;
    if (!isFinite(prev)) {
      seedSum += dx[i]; seeded++;
      if (seeded === period) { prev = seedSum / period; out[i] = prev; }
      continue;
    }
    prev = (prev * (period - 1) + dx[i]) / period;
    out[i] = prev;
  }
  return out;
}

function obv(candles: Candle[]): number[] {
  const out = new Array(candles.length).fill(0);
  for (let i = 1; i < candles.length; i++) {
    out[i] = out[i - 1] + (candles[i].c > candles[i - 1].c ? candles[i].v : candles[i].c < candles[i - 1].c ? -candles[i].v : 0);
  }
  return out;
}

export function computeIndicators(candles: Candle[]): IndicatorSet {
  const closes = candles.map((c) => c.c);
  const vols = candles.map((c) => c.v);
  const macd = macdCalc(closes, 12, 26, 9);
  const bb = bollinger(closes, 20, 2);
  const stoch = stochRsi(closes, 14, 14, 3, 3);
  return {
    rsi: rsi(closes, 14),
    ema50: ema(closes, 50),
    ema200: ema(closes, 200),
    macd: macd.line,
    macdSignal: macd.signal,
    macdHist: macd.hist,
    atr: atr(candles, 14),
    bbUpper: bb.upper,
    bbMid: bb.mid,
    bbLower: bb.lower,
    stochK: stoch.k,
    stochD: stoch.d,
    vwap: vwap(candles),
    adx: adxCalc(candles, 14),
    volMA: sma(vols, 20),
    obv: obv(candles),
  };
}

export function findSR(candles: Candle[], atrArr: number[], maxLevels = 8): SRLevel[] {
  const k = 3;
  const pivots: Array<{ price: number; kind: "high" | "low"; i: number }> = [];
  for (let i = k; i < candles.length - k; i++) {
    let isH = true, isL = true;
    for (let j = i - k; j <= i + k; j++) {
      if (candles[j].h > candles[i].h) isH = false;
      if (candles[j].l < candles[i].l) isL = false;
    }
    if (isH) pivots.push({ price: candles[i].h, kind: "high", i });
    if (isL) pivots.push({ price: candles[i].l, kind: "low", i });
  }
  const lastAtr = [...atrArr].reverse().find((v) => isFinite(v)) ?? (candles[candles.length - 1]?.c ?? 1) * 0.01;
  const tol = Math.max(lastAtr * 0.45, (candles[candles.length - 1]?.c ?? 1) * 0.0015);
  const clusters: Array<{ sum: number; n: number; highs: number; lows: number }> = [];
  for (const p of pivots) {
    const c = clusters.find((cl) => Math.abs(cl.sum / cl.n - p.price) <= tol);
    if (c) { c.sum += p.price; c.n++; if (p.kind === "high") c.highs++; else c.lows++; }
    else clusters.push({ sum: p.price, n: 1, highs: p.kind === "high" ? 1 : 0, lows: p.kind === "low" ? 1 : 0 });
  }
  const lastC = candles[candles.length - 1]?.c ?? 0;
  return clusters
    .filter((c) => c.n >= 2)
    .map((c) => {
      const price = c.sum / c.n;
      return {
        price,
        touches: c.n,
        kind: price >= lastC ? ("resistance" as const) : ("support" as const),
        strength: Math.min(100, c.n * 18 + Math.min(c.highs, c.lows) * 10),
      };
    })
    .sort((a, b) => b.strength - a.strength)
    .slice(0, maxLevels);
}
