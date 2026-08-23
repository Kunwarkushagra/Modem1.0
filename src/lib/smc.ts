import type { BreakoutInfo, Candle, LiquidityPool, PatternHit, PremiumDiscount, SMCAnalysis, SRLevel, StructureEvent, SwingPoint, SweepEvent, TrendLine, Zone } from "./types";
import { atr as atrFn } from "./indicators";
import { findSR } from "./indicators";

function findSwings(candles: Candle[], k: number, major: boolean): SwingPoint[] {
  const out: SwingPoint[] = [];
  for (let i = k; i < candles.length - k; i++) {
    let isH = true, isL = true;
    for (let j = i - k; j <= i + k; j++) {
      if (candles[j].h > candles[i].h) isH = false;
      if (candles[j].l < candles[i].l) isL = false;
      if (!isH && !isL) break;
    }
    if (isH) out.push({ i, t: candles[i].t, price: candles[i].h, kind: "high", major });
    if (isL) out.push({ i, t: candles[i].t, price: candles[i].l, kind: "low", major });
  }
  return out.sort((a, b) => a.i - b.i);
}

function structureFromSwings(swings: SwingPoint[]): { events: StructureEvent[]; trend: "bull" | "bear" | "range" } {
  const events: StructureEvent[] = [];
  let trend: "bull" | "bear" | "range" = "range";
  let lastHigh: SwingPoint | null = null;
  let lastLow: SwingPoint | null = null;
  for (const s of swings) {
    if (s.kind === "high") {
      if (lastHigh && lastLow) {
        if (s.price > lastHigh.price) {
          events.push({ i: s.i, t: s.t, type: trend === "bear" ? "CHoCH" : "BOS", dir: "bull", level: lastHigh.price });
          trend = "bull";
        } else if (lastLow && trend === "bull") {
          // lower high in an uptrend — potential CHoCH if low breaks later; handled at low side
        }
      }
      lastHigh = s;
    } else {
      if (lastHigh && lastLow) {
        if (s.price < lastLow.price) {
          events.push({ i: s.i, t: s.t, type: trend === "bull" ? "CHoCH" : "BOS", dir: "bear", level: lastLow.price });
          trend = "bear";
        }
      }
      lastLow = s;
    }
  }
  return { events, trend };
}

function detectOrderBlocks(candles: Candle[], swings: SwingPoint[], atrArr: number[]): Zone[] {
  const zones: Zone[] = [];
  const n = candles.length;
  for (const s of swings) {
    const a = atrArr[Math.min(s.i, n - 1)];
    if (!isFinite(a) || a <= 0) continue;
    if (s.kind === "low") {
      // impulse up after swing low?
      let maxC = -Infinity;
      for (let j = s.i + 1; j < Math.min(s.i + 9, n); j++) maxC = Math.max(maxC, candles[j].c);
      if (maxC - s.price < 1.8 * a) continue;
      let ob = -1;
      for (let j = s.i; j >= Math.max(0, s.i - 7); j--) {
        if (candles[j].c < candles[j].o) { ob = j; break; }
      }
      if (ob < 0) ob = s.i;
      const c = candles[ob];
      zones.push({ kind: "bull_ob", top: Math.max(c.o, c.c), bottom: c.l, startI: ob, t: c.t, active: true, mitigated: false });
    } else {
      let minC = Infinity;
      for (let j = s.i + 1; j < Math.min(s.i + 9, n); j++) minC = Math.min(minC, candles[j].c);
      if (s.price - minC < 1.8 * a) continue;
      let ob = -1;
      for (let j = s.i; j >= Math.max(0, s.i - 7); j--) {
        if (candles[j].c > candles[j].o) { ob = j; break; }
      }
      if (ob < 0) ob = s.i;
      const c = candles[ob];
      zones.push({ kind: "bear_ob", top: c.h, bottom: Math.min(c.o, c.c), startI: ob, t: c.t, active: true, mitigated: false });
    }
  }
  // dedupe overlapping same-kind zones, keep most recent
  const dedup: Zone[] = [];
  for (const z of zones) {
    const clash = dedup.find((d) => d.kind === z.kind && !(z.bottom > d.top || z.top < d.bottom));
    if (!clash) dedup.push(z);
  }
  return dedup.slice(-10);
}

function trackMitigation(candles: Candle[], zones: Zone[]): void {
  for (const z of zones) {
    if (z.kind !== "bull_ob" && z.kind !== "bear_ob") continue;
    for (let j = z.startI + 1; j < candles.length; j++) {
      const c = candles[j];
      if (z.kind === "bull_ob") {
        if (c.c < z.bottom) { z.kind = "breaker_bear"; z.active = true; z.note = "failed OB → breaker"; break; }
        if (c.l <= z.top) { z.mitigated = true; if (c.c <= z.bottom + (z.top - z.bottom) * 0.5) z.active = false; }
      } else {
        if (c.c > z.top) { z.kind = "breaker_bull"; z.active = true; z.note = "failed OB → breaker"; break; }
        if (c.h >= z.bottom) { z.mitigated = true; if (c.c >= z.bottom + (z.top - z.bottom) * 0.5) z.active = false; }
      }
    }
  }
}

function detectFVG(candles: Candle[], atrArr: number[]): Zone[] {
  const zones: Zone[] = [];
  for (let i = 2; i < candles.length; i++) {
    const a = atrArr[i];
    if (!isFinite(a) || a <= 0) continue;
    const p = candles[i - 2], n1 = candles[i - 1], cur = candles[i];
    // bullish FVG: current low above the high two candles back → gap [p.h, cur.l]
    if (cur.l > p.h) {
      const gap = cur.l - p.h;
      const kind = gap > 0.55 * a ? "imbalance" : "bull_fvg";
      zones.push({ kind, top: cur.l, bottom: p.h, startI: i - 1, t: n1.t, active: true, mitigated: false });
    } else if (cur.h < p.l) {
      const gap = p.l - cur.h;
      const kind = gap > 0.55 * a ? "imbalance" : "bear_fvg";
      zones.push({ kind, top: p.l, bottom: cur.h, startI: i - 1, t: n1.t, active: true, mitigated: false });
    }
  }
  // fill tracking: a close through the zone fills it
  for (const z of zones) {
    for (let j = z.startI + 2; j < candles.length; j++) {
      const c = candles[j];
      const bullish = z.kind === "bull_fvg" || (z.kind === "imbalance" && candles[z.startI + 1]?.c > candles[z.startI]?.o);
      if (bullish && c.c < z.bottom) { z.active = false; z.mitigated = true; break; }
      if (!bullish && z.kind !== "bull_fvg" && c.c > z.top) { z.active = false; z.mitigated = true; break; }
    }
  }
  // keep recent meaningful ones
  const active = zones.filter((z) => z.active).slice(-12);
  const filled = zones.filter((z) => !z.active).slice(-4);
  return [...filled, ...active];
}

function detectLiquidity(candles: Candle[], swings: SwingPoint[], atrArr: number[]): { pools: LiquidityPool[]; sweeps: SweepEvent[] } {
  const n = candles.length;
  const lastPrice = candles[n - 1]?.c ?? 0;
  const lastAtr = [...atrArr].reverse().find((v) => isFinite(v)) ?? lastPrice * 0.01;
  const tol = Math.max(lastAtr * 0.28, lastPrice * 0.0009);
  const majors = swings.filter((s) => s.major).slice(-14);
  const pools: LiquidityPool[] = [];

  const highs = majors.filter((s) => s.kind === "high" && s.price > lastPrice);
  const lows = majors.filter((s) => s.kind === "low" && s.price < lastPrice);
  const group = (pts: SwingPoint[]) => {
    const groups: SwingPoint[][] = [];
    for (const p of pts) {
      const g = groups.find((gr) => Math.abs(gr[0].price - p.price) <= tol);
      if (g) g.push(p); else groups.push([p]);
    }
    return groups;
  };
  for (const g of group(highs)) {
    const price = Math.max(...g.map((p) => p.price));
    pools.push({ side: "buy", price, kind: g.length >= 2 ? "equal_highs" : "swing_high", touches: g.length, formedI: Math.max(...g.map((p) => p.i)) });
  }
  for (const g of group(lows)) {
    const price = Math.min(...g.map((p) => p.price));
    pools.push({ side: "sell", price, kind: g.length >= 2 ? "equal_lows" : "swing_low", touches: g.length, formedI: Math.max(...g.map((p) => p.i)) });
  }

  const sweeps: SweepEvent[] = [];
  for (const pool of pools) {
    if (pool.touches < 2) continue;
    for (let j = pool.formedI + 1; j < n; j++) {
      const c = candles[j];
      if (pool.side === "buy" && c.h > pool.price && c.c < pool.price) {
        sweeps.push({ i: j, t: c.t, side: "buy", price: pool.price });
        break;
      }
      if (pool.side === "sell" && c.l < pool.price && c.c > pool.price) {
        sweeps.push({ i: j, t: c.t, side: "sell", price: pool.price });
        break;
      }
    }
  }
  pools.sort((a, b) => b.touches - a.touches);
  return { pools: pools.slice(0, 10), sweeps: sweeps.slice(-8) };
}

function detectPatterns(candles: Candle[]): PatternHit[] {
  const out: PatternHit[] = [];
  const from = Math.max(2, candles.length - 40);
  for (let i = from; i < candles.length; i++) {
    const c = candles[i], p = candles[i - 1];
    const range = c.h - c.l;
    if (range <= 0) continue;
    const body = Math.abs(c.c - c.o);
    const upper = c.h - Math.max(c.o, c.c);
    const lower = Math.min(c.o, c.c) - c.l;
    const posLow = (Math.min(c.o, c.c) - c.l) / range;
    if (body <= range * 0.08) out.push({ i, t: c.t, name: "Doji", dir: "neutral" });
    if (lower >= body * 2 && lower >= range * 0.62 && posLow < 0.38)
      out.push({ i, t: c.t, name: posLow < 0.2 ? "Hammer" : "Bullish Pin Bar", dir: "bull" });
    if (upper >= body * 2 && upper >= range * 0.62 && 1 - (Math.max(c.o, c.c) - c.l) / range < 0.38)
      out.push({ i, t: c.t, name: upper > lower ? "Shooting Star" : "Bearish Pin Bar", dir: "bear" });
    const pBody = Math.abs(p.c - p.o);
    if (pBody > 0 && body > pBody * 1.05) {
      if (c.c > c.o && p.c < p.o && c.c >= p.o && c.o <= p.c) out.push({ i, t: c.t, name: "Bullish Engulfing", dir: "bull" });
      if (c.c < c.o && p.c > p.o && c.o >= p.c && c.c <= p.o) out.push({ i, t: c.t, name: "Bearish Engulfing", dir: "bear" });
    }
    if (c.h <= p.h && c.l >= p.l) out.push({ i, t: c.t, name: "Inside Bar", dir: "neutral" });
  }
  return out.slice(-14);
}

function detectBreakouts(candles: Candle[], sr: SRLevel[], pools: LiquidityPool[], volMA: number[]): BreakoutInfo[] {
  const out: BreakoutInfo[] = [];
  const n = candles.length;
  const levels: Array<{ price: number; dir: "bull" | "bear" }> = [
    ...sr.slice(0, 5).map((s) => ({ price: s.price, dir: (s.kind === "resistance" ? "bull" : "bear") as "bull" | "bear" })),
    ...pools.filter((p) => p.touches >= 2).slice(0, 4).map((p) => ({ price: p.price, dir: (p.side === "buy" ? "bull" : "bear") as "bull" | "bear" })),
  ];
  for (const lvl of levels) {
    for (let i = Math.max(1, n - 34); i < n - 2; i++) {
      const beyond = lvl.dir === "bull" ? candles[i].c > lvl.price : candles[i].c < lvl.price;
      const wasBefore = lvl.dir === "bull" ? candles[i - 1].c <= lvl.price : candles[i - 1].c >= lvl.price;
      if (beyond && wasBefore) {
        let closes = 1;
        for (let j = i + 1; j < Math.min(i + 4, n); j++) {
          if (lvl.dir === "bull" ? candles[j].c > lvl.price : candles[j].c < lvl.price) closes++;
        }
        const vm = volMA[i];
        const volOk = isFinite(vm) && vm > 0 && candles[i].v > vm;
        let state: BreakoutInfo["state"] = "unconfirmed";
        if (closes >= 2 && volOk) state = "confirmed";
        else {
          const back = candles.slice(i + 1, i + 4).some((c2) => (lvl.dir === "bull" ? c2.c < lvl.price : c2.c > lvl.price));
          if (back) state = "false";
        }
        out.push({ level: lvl.price, dir: lvl.dir, state, volOk, closesBeyond: closes });
        break;
      }
    }
  }
  return out;
}

function buildTrendlines(candles: Candle[], swings: SwingPoint[]): TrendLine[] {
  const out: TrendLine[] = [];
  const n = candles.length;
  const lows = swings.filter((s) => s.major && s.kind === "low").slice(-4);
  const highs = swings.filter((s) => s.major && s.kind === "high").slice(-4);
  if (lows.length >= 2) {
    const [a, b] = [lows[lows.length - 2], lows[lows.length - 1]];
    if (b.price > a.price) {
      const slope = (b.price - a.price) / Math.max(1, b.i - a.i);
      out.push({ x1: a.i, y1: a.price, x2: n - 1, y2: a.price + slope * (n - 1 - a.i), kind: "support" });
    }
  }
  if (highs.length >= 2) {
    const [a, b] = [highs[highs.length - 2], highs[highs.length - 1]];
    if (b.price < a.price) {
      const slope = (b.price - a.price) / Math.max(1, b.i - a.i);
      out.push({ x1: a.i, y1: a.price, x2: n - 1, y2: a.price + slope * (n - 1 - a.i), kind: "resistance" });
    }
  }
  return out;
}

function buildPD(candles: Candle[], swings: SwingPoint[], lastPrice: number): PremiumDiscount {
  const majors = swings.filter((s) => s.major).slice(-8);
  const highs = majors.filter((s) => s.kind === "high");
  const lows = majors.filter((s) => s.kind === "low");
  const rangeHigh = highs.length ? highs[highs.length - 1].price : Math.max(...candles.slice(-60).map((c) => c.h));
  const rangeLow = lows.length ? lows[lows.length - 1].price : Math.min(...candles.slice(-60).map((c) => c.l));
  const span = Math.max(rangeHigh - rangeLow, 1e-9);
  const f = (p: number) => rangeLow + span * p;
  const pos = lastPrice >= f(0.62) ? "premium" : lastPrice <= f(0.38) ? "discount" : "equilibrium";
  return {
    rangeHigh, rangeLow,
    eq: f(0.5),
    premium: [f(0.705), f(0.92)],
    discount: [f(0.08), f(0.295)],
    oteHigh: [f(0.705), f(0.79)],
    oteLow: [f(0.21), f(0.295)],
    position: pos as PremiumDiscount["position"],
  };
}

export function analyzeSMC(candles: Candle[]): SMCAnalysis {
  const atrArr = atrFn(candles, 14);
  const lastPrice = candles[candles.length - 1]?.c ?? 0;

  const majors = findSwings(candles, 3, true);
  const minors = findSwings(candles, 2, false).filter((m) => !majors.some((mj) => mj.i === m.i && mj.kind === m.kind));
  const { events, trend } = structureFromSwings(majors);
  const obZones = detectOrderBlocks(candles, majors, atrArr);
  trackMitigation(candles, obZones);
  const fvgZones = detectFVG(candles, atrArr);
  const { pools, sweeps } = detectLiquidity(candles, majors, atrArr);
  const lastAtr = [...atrArr].reverse().find((v) => isFinite(v)) ?? lastPrice * 0.01;
  const slHuntZones: Zone[] = pools
    .filter((p) => p.touches >= 2)
    .slice(0, 6)
    .map((p) => ({
      kind: "sl_hunt",
      top: p.side === "buy" ? p.price + lastAtr * 0.32 : p.price,
      bottom: p.side === "buy" ? p.price : p.price - lastAtr * 0.32,
      startI: p.formedI, t: candles[p.formedI]?.t ?? 0, active: true, mitigated: false,
      note: p.side === "buy" ? "buy-side stops" : "sell-side stops",
    }));
  // inducement: minor swings against trend taken out recently
  const inducement = minors
    .filter((m) => {
      if (m.i <= candles.length - 90) return false;
      for (let j = m.i + 1; j < candles.length; j++) {
        if (m.kind === "low" ? candles[j].c < m.price : candles[j].c > m.price) return true;
      }
      return false;
    })
    .slice(-4);
  const volMA = (() => {
    const out = new Array(candles.length).fill(NaN);
    let s = 0;
    for (let i = 0; i < candles.length; i++) {
      s += candles[i].v;
      if (i >= 20) s -= candles[i - 20].v;
      if (i >= 19) out[i] = s / 20;
    }
    return out;
  })();
  const sr: SRLevel[] = findSR(candles, atrArr, 8);
  const patterns = detectPatterns(candles);
  const breakouts = detectBreakouts(candles, sr, pools, volMA);
  const trendlines = buildTrendlines(candles, majors);
  const pd = buildPD(candles, majors, lastPrice);

  return {
    swings: [...majors, ...minors.slice(-10)].sort((a, b) => a.i - b.i),
    structure: events.slice(-10),
    trend,
    zones: [...obZones, ...fvgZones],
    liquidity: pools,
    sweeps,
    inducement,
    pd,
    slHuntZones,
    patterns,
    sr,
    breakouts,
    trendlines,
  };
}
