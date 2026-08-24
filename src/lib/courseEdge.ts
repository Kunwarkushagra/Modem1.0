import type { Bias, Candle, CourseEdgeHits, SMCAnalysis } from "./types";

/**
 * scalp10-courseedge-v1.0.0 — POSITIVE-ONLY pattern boosts, computed on the setup TF
 * (confirmed candles only). Pure ranking/display layer:
 *   - never a gate, never a penalty, never feeds entry/validators/SL-TP/backtest
 *   - compression +8 · wedge exhaustion +8 · round number +5   → bucket, capped +20
 *   - double sweep +10 → routed into the existing TRAP score (sweep bucket) when a
 *     sweep exists, else into the bucket (still under the +20 cap)
 */

export const CE_COMPRESSION_BONUS = 8;
export const CE_WEDGE_BONUS = 8;
export const CE_ROUND_BONUS = 5;
export const CE_DOUBLE_SWEEP_BONUS = 10;
export const CE_BUCKET_CAP = 20;

/* ---------------- shared math ---------------- */

function linreg(ys: number[]): { slope: number; intercept: number; r2: number } {
  const n = ys.length;
  if (n < 3) return { slope: 0, intercept: ys[n - 1] ?? 0, r2: 0 };
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (let i = 0; i < n; i++) { sx += i; sy += ys[i]; sxx += i * i; sxy += i * ys[i]; }
  const denom = n * sxx - sx * sx || 1;
  const slope = (n * sxy - sx * sy) / denom;
  const intercept = (sy - slope * sx) / n;
  const mean = sy / n;
  let ssRes = 0, ssTot = 0;
  for (let i = 0; i < n; i++) {
    const fit = intercept + slope * i;
    ssRes += (ys[i] - fit) ** 2;
    ssTot += (ys[i] - mean) ** 2;
  }
  return { slope, intercept, r2: ssTot > 0 ? 1 - ssRes / ssTot : 0 };
}

/** trailing percentile rank of the current ATR within the last `lookback` values (0–100) */
function atrPercentile(atrArr: number[], lookback = 100): number | null {
  const n = atrArr.length;
  const cur = atrArr[n - 1];
  if (!isFinite(cur) || cur <= 0) return null;
  const from = Math.max(0, n - lookback);
  const sample = atrArr.slice(from, n).filter((v) => isFinite(v) && v > 0);
  if (sample.length < 40) return null; // not enough history to rank against
  const below = sample.filter((v) => v <= cur).length;
  return (below / sample.length) * 100;
}

/* ---------------- 1. compression / squeeze continuation ---------------- */

interface CompressionHit { dir: "bull" | "bear"; curveMoveAtr: number; r2: number; bonus: number }

/**
 * Slow curve over the last 15 confirmed candles with low volatility (ATR percentile < 40):
 * linear fit must be a genuine gentle curve (R² ≥ 0.35, total move 0.5–4×ATR). The LAST candle
 * must close beyond the curve in the HTF trend direction with body > 0.8×ATR.
 */
export function detectCompression(candles: Candle[], atrArr: number[], htfBias: Bias): CompressionHit | null {
  const n = candles.length;
  const W = 15;
  if (n < W + 1) return null;
  const a = atrArr[n - 1];
  if (!isFinite(a) || a <= 0) return null;

  const pct = atrPercentile(atrArr, 100);
  if (pct == null || pct >= 40) return null; // volatility not compressed

  const closes = candles.slice(n - W).map((c) => c.c);
  const { slope, intercept, r2 } = linreg(closes);
  if (r2 < 0.35) return null; // no clean curve
  const curveMove = Math.abs(slope) * (W - 1);
  if (curveMove < 0.5 * a || curveMove > 4 * a) return null; // flat noise or impulsive — not a squeeze curve

  const ascending = slope > 0;
  if (ascending && htfBias !== "bullish") return null;
  if (!ascending && htfBias !== "bearish") return null;

  const last = candles[n - 1];
  const fitted = intercept + slope * (W - 1);
  const body = Math.abs(last.c - last.o);
  const brokeOut = ascending ? last.c > fitted : last.c < fitted;
  if (!brokeOut || body <= 0.8 * a) return null;

  return { dir: ascending ? "bull" : "bear", curveMoveAtr: Number((curveMove / a).toFixed(2)), r2: Number(r2.toFixed(2)), bonus: CE_COMPRESSION_BONUS };
}

/* ---------------- 2. wedge exhaustion ---------------- */

interface WedgeHit { kind: "rising" | "falling"; breakDir: "bull" | "bear"; bonus: number }

/** local extrema (k=2) inside a window — index-relative to the window start */
function windowSwings(candles: Candle[], from: number, to: number): { highs: Array<{ i: number; p: number }>; lows: Array<{ i: number; p: number }> } {
  const highs: Array<{ i: number; p: number }> = [];
  const lows: Array<{ i: number; p: number }> = [];
  for (let i = from + 2; i <= to - 2; i++) {
    let isH = true, isL = true;
    for (let k = i - 2; k <= i + 2; k++) {
      if (candles[k].h > candles[i].h) isH = false;
      if (candles[k].l < candles[i].l) isL = false;
    }
    if (isH) highs.push({ i, p: candles[i].h });
    if (isL) lows.push({ i, p: candles[i].l });
  }
  return { highs, lows };
}

/**
 * Rising wedge (HH + HL converging) breaking DOWN through its lower boundary, or falling wedge
 * (LH + LL converging) breaking UP through its upper boundary, on a strong candle (body > 1.0×ATR)
 * closing beyond the extrapolated boundary. Convergence = high-line slope < low-line slope.
 */
export function detectWedge(candles: Candle[], atrArr: number[]): WedgeHit | null {
  const n = candles.length;
  const W = 20;
  if (n < W + 1) return null;
  const a = atrArr[n - 1];
  if (!isFinite(a) || a <= 0) return null;

  const from = n - W, to = n - 1;
  const { highs, lows } = windowSwings(candles, from, to);
  if (highs.length < 2 || lows.length < 2) return null;
  const h1 = highs[highs.length - 2], h2 = highs[highs.length - 1];
  const l1 = lows[lows.length - 2], l2 = lows[lows.length - 1];
  if (h2.i <= h1.i || l2.i <= l1.i) return null;

  const hSlope = (h2.p - h1.p) / (h2.i - h1.i);
  const lSlope = (l2.p - l1.p) / (l2.i - l1.i);
  if (!(hSlope < lSlope)) return null; // boundaries must converge
  if (h1.p - l1.p < 1.0 * a) return null; // no real wedge depth at the start

  const last = candles[n - 1];
  const body = Math.abs(last.c - last.o);
  if (body <= 1.0 * a) return null; // weak candle — no exhaustion impulse

  const rising = lSlope > 0 && hSlope > -1e-12 && h2.p > h1.p && l2.p > l1.p;
  const falling = hSlope < 0 && lSlope < 1e-12 && h2.p < h1.p && l2.p < l1.p;
  if (!rising && !falling) return null;

  const lastI = to;
  if (rising) {
    const lExt = l2.p + lSlope * (lastI - l2.i);
    if (last.c < lExt) return { kind: "rising", breakDir: "bear", bonus: CE_WEDGE_BONUS };
  } else {
    const hExt = h2.p + hSlope * (lastI - h2.i);
    if (last.c > hExt) return { kind: "falling", breakDir: "bull", bonus: CE_WEDGE_BONUS };
  }
  return null;
}

/* ---------------- 3. replicate / double sweep ---------------- */

interface DoubleSweepHit { side: "buy" | "sell"; barsApart: number; bonus: number }

/**
 * Same liquidity level swept twice within the last 20 candles: an earlier sweep, price returning,
 * and a second sweep of the same level (|Δprice| within the pool clustering tolerance).
 */
export function detectDoubleSweep(smc: SMCAnalysis, atr: number, price: number, candleCount: number, windowBars = 20): DoubleSweepHit | null {
  const cutoff = candleCount > 0 ? candleCount - windowBars : -Infinity;
  const tol = Math.max(0.28 * (isFinite(atr) && atr > 0 ? atr : 0), 0.0009 * price);
  for (const side of ["buy", "sell"] as const) {
    const list = smc.sweeps.filter((s) => s.side === side && s.i >= cutoff).sort((x, y) => x.i - y.i);
    for (let i2 = 1; i2 < list.length; i2++) {
      const a2 = list[i2 - 1], b2 = list[i2];
      if (b2.i - a2.i < 2) continue; // need an actual return leg between sweeps
      if (Math.abs(a2.price - b2.price) <= tol) {
        return { side, barsApart: b2.i - a2.i, bonus: CE_DOUBLE_SWEEP_BONUS };
      }
    }
  }
  return null;
}

/* ---------------- 4. psychological round numbers ---------------- */

interface RoundHit { level: number; relDistPct: number; bonus: number }

const ROUND_SCALES = [10, 100, 1000, 10000];

/** nearest dynamic round number across 10/100/1k/10k scales; within 0.2% of price counts */
export function detectRoundNumber(price: number, tolPct = 0.2): RoundHit | null {
  if (!isFinite(price) || price <= 0) return null;
  let best: RoundHit | null = null;
  for (const s of ROUND_SCALES) {
    const level = Math.round(price / s) * s;
    if (level <= 0) continue;
    const rel = (Math.abs(price - level) / price) * 100;
    if (rel <= tolPct && (!best || rel < best.relDistPct)) {
      best = { level, relDistPct: Number(rel.toFixed(3)), bonus: CE_ROUND_BONUS };
    }
  }
  return best;
}

/* ---------------- composition ---------------- */

/**
 * Score all four patterns. `hasSweepEvidence` decides where the double-sweep bonus lands:
 * with sweep evidence it boosts the existing trap score (sweep bucket); otherwise it joins
 * the bucket. Bucket total is capped at +20. Returns null when nothing fired.
 */
export function scoreCourseEdge(
  candles: Candle[],
  atrArr: number[],
  smc: SMCAnalysis,
  htfBias: Bias,
  price: number,
  hasSweepEvidence: boolean,
): CourseEdgeHits | null {
  const compression = detectCompression(candles, atrArr, htfBias) ?? undefined;
  const wedge = detectWedge(candles, atrArr) ?? undefined;
  const doubleSweepRaw = detectDoubleSweep(smc, atrArr[atrArr.length - 1], price, candles.length);
  const roundNumber = detectRoundNumber(price) ?? undefined;

  let bucket = (compression?.bonus ?? 0) + (wedge?.bonus ?? 0) + (roundNumber?.bonus ?? 0);
  let doubleSweep: CourseEdgeHits["doubleSweep"] | undefined;
  if (doubleSweepRaw) {
    if (hasSweepEvidence) {
      doubleSweep = { ...doubleSweepRaw, routedVia: "trap" }; // +10 to trap score (sweep bucket via existing conversion)
    } else {
      doubleSweep = { ...doubleSweepRaw, routedVia: "bucket" };
      bucket += doubleSweepRaw.bonus;
    }
  }
  bucket = Math.min(CE_BUCKET_CAP, bucket);

  if (!compression && !wedge && !doubleSweep && !roundNumber) return null;
  return { compression, wedge, doubleSweep, roundNumber, totalBonus: bucket };
}
