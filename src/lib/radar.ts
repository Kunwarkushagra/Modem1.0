import type {
  AssetType, Bias, Candle, InvalidCheck, PerformanceSummary, RadarCandidate, RadarScoreBreakdown,
  RadarTf, SymbolScanState, TradeSetup,
} from "./types";
import { fetchCandles } from "./marketData";
import { computeIndicators } from "./indicators";
import { analyzeSMC } from "./smc";
import { deriveBias, localSetups, validateSetup } from "./ai";
import type { EngineCtx } from "./ai";
import { getCandles, putCandles } from "./cache";
import { detectSession, fmtPrice, HTF_MAP, last, normSymbol, TF_MINUTES } from "./utils";

const EMPTY_PERF: PerformanceSummary = {
  total: 0, wins: 0, losses: 0, breakeven: 0, winRate: 0, avgWinPct: 0, avgLossPct: 0,
  profitFactor: 0, sharpe: 0, maxDrawdown: 0, bestConfluences: [], worstConfluences: [],
  recent: { trades: 0, winRate: 0, tilt: false }, equity: [100],
};

/* ------------------------------------------------ scoring (Σ = 100) */

export function scoreCandidate(setup: TradeSetup, htfBias: Bias, generatedAt: number): RadarScoreBreakdown {
  const r = setup.reasoning;
  const dir = setup.direction;

  const aligned = (htfBias === "bullish" && dir === "Long") || (htfBias === "bearish" && dir === "Short");
  const htfBiasScore = aligned ? 20 : htfBias === "ranging" ? 8 : 0;

  let liquidityScore = 0;
  if (r?.liquidity) {
    liquidityScore = r.liquidity.grade === "A" ? 20 : r.liquidity.grade === "B" ? 13 : 7;
    liquidityScore -= Math.min(4, Math.max(0, Math.round((r.liquidity.distanceAtr - 1) * 2)));
    liquidityScore = Math.max(0, liquidityScore);
  }

  const sweepScore = r?.sweep ? Math.round((r.sweep.trapScore / 100) * 15) : 0;

  let structureScore = 0;
  if (r?.structureEvent) {
    const evAligned = (r.structureEvent.dir === "bull" && dir === "Long") || (r.structureEvent.dir === "bear" && dir === "Short");
    structureScore = evAligned ? (r.structureEvent.type === "CHoCH" ? 15 : 12) : 0;
  }

  const zoneScore = r?.zone ? (r.zone.grade === "A" ? 10 : 7) : 0;

  const sess = detectSession(generatedAt);
  const h = new Date(generatedAt).getUTCHours();
  const overlap = h >= 12 && h < 16; // London close × New York open killzone
  const sessionScore = overlap ? 10 : sess.name === "London" || sess.name === "New York" ? 7 : sess.name === "Asia" ? 3 : 0;

  const falseBreakoutScore = setup.isBreakout ? 10 : 6; // confirmed breakouts max out; non-breakouts take the neutral line

  const total = Math.max(0, Math.min(100, htfBiasScore + liquidityScore + sweepScore + structureScore + zoneScore + sessionScore + falseBreakoutScore));
  return { htfBias: htfBiasScore, liquidity: liquidityScore, sweep: sweepScore, structure: structureScore, zone: zoneScore, session: sessionScore, falseBreakout: falseBreakoutScore, total };
}

/* ------------------------------------------------ per-symbol scan (confirmed candles only) */

export interface ScanOutcome {
  state: SymbolScanState;
  candidates: RadarCandidate[];   // validated, scored, floor applied by caller
  htfBias: Bias;
}

export async function scanSymbol(symbolRaw: string, tf: RadarTf, qualityFloor: number): Promise<ScanOutcome> {
  const symbol = normSymbol(symbolRaw, "crypto");
  const asset: AssetType = "crypto";
  const base: SymbolScanState = { symbol, status: "scanning", lastScanAt: Date.now(), lastCloseEpoch: 0, lastPrice: null, error: null };

  let stf: Candle[] | null = null;
  let stale = false;

  // STF with IndexedDB fallback
  const stfKey = `${symbol}:${tf}`;
  try {
    const res = await fetchCandles(symbol, asset, tf, 300);
    stf = res.candles;
    await putCandles(stfKey, stf);
  } catch {
    const cached = await getCandles(stfKey);
    if (cached && Date.now() - cached.ts < TF_MINUTES[tf] * 60_000 * 4) { stf = cached.candles; stale = true; }
  }
  if (!stf || stf.length < 90) {
    return { state: { ...base, status: "stale", error: "no reachable feed and no fresh cache" }, candidates: [], htfBias: "ranging" };
  }

  // HTF (best-effort; on failure reuse STF so the scan still runs, flagged if stale already)
  const htfTf = HTF_MAP[tf];
  let htfC: Candle[] = stf;
  if (htfTf !== tf) {
    try {
      const res = await fetchCandles(symbol, asset, htfTf, 300);
      htfC = res.candles;
    } catch { stale = true; }
  }

  // SCALP-1.0 rule: analysis on CONFIRMED candles only — the forming candle is chart-only
  const drop = (arr: Candle[]) => (arr.length > 80 ? arr.slice(0, -1) : arr);
  const stfC = drop(stf), htfCD = drop(htfC);
  const stepMs = TF_MINUTES[tf] * 60_000;
  const generatedAt = last(stfC).t + stepMs;

  const ind = computeIndicators(stfC);
  const smc = analyzeSMC(stfC);
  const htfInd = computeIndicators(htfCD);
  const htfSmc = analyzeSMC(htfCD);
  const htfBias = deriveBias(htfSmc, htfInd, htfCD);

  const ctx: EngineCtx = {
    params: { symbol, assetType: asset, timeframe: tf, accountSize: 10000, riskPercent: 1 },
    candles: stfC, ind, smc, htfSmc, htfInd, htfCandles: htfCD,
    htfBias, perf: EMPTY_PERF, newsCount: 0, generatedAt, stepMs,
  };

  const candidates: RadarCandidate[] = [];
  for (const raw of localSetups(ctx)) {
    const setup = validateSetup(raw, ctx);
    if (!setup.validation.checks.every((ch) => ch.passed)) continue; // existing gates — unchanged
    if (!setup.signal) continue;
    const score = scoreCandidate(setup, htfBias, generatedAt);
    if (score.total < qualityFloor) continue;                        // quality floor (Settings)
    candidates.push({
      key: `${symbol}:${setup.id}`,
      symbol, assetType: asset, timeframe: tf,
      setup, score,
      status: "active",
      invalidReason: null,
      invalidChecks: buildInvalidChecks(setup, htfBias, htfBias, last(stfC).c, stale),
      htfBiasAtGeneration: htfBias,
      dataStale: stale,
      lastCheckedAt: Date.now(),
      archivedAt: null,
    });
  }

  return {
    state: { ...base, status: stale ? "stale" : "live", lastCloseEpoch: generatedAt, lastPrice: last(stfC).c },
    candidates,
    htfBias,
  };
}

/* ------------------------------------------------ INVALID-IF checklist */

export function buildInvalidChecks(
  setup: TradeSetup,
  htfBiasNow: Bias,
  htfBiasAtGen: Bias,
  lastClose: number,
  dataStale: boolean,
): InvalidCheck[] {
  const sig = setup.signal;
  const r = setup.reasoning;
  const long = setup.direction === "Long";

  const reclaimHit = sig?.reclaimLevel != null && (long ? lastClose < sig.reclaimLevel : lastClose > sig.reclaimLevel);
  const mitHit =
    sig?.zoneTop != null && sig.zoneBottom != null &&
    (long ? lastClose < sig.zoneBottom : lastClose > sig.zoneTop);
  const touchesNote = r?.zone ? `zone ${r.zone.kind.replace(/_/g, " ")}` : "zone";
  const oppositeHit =
    r?.structureEvent != null &&
    ((long && r.structureEvent.dir === "bear") || (!long && r.structureEvent.dir === "bull"));
  const htfFlipHit = htfBiasNow !== htfBiasAtGen && ((long && htfBiasNow === "bearish") || (!long && htfBiasNow === "bullish"));

  return [
    {
      id: "reclaim",
      label: "Level reclaimed against direction",
      hit: reclaimHit,
      detail: sig?.reclaimLevel != null
        ? `reclaim ${long ? "below" : "above"} ${fmtPrice(sig.reclaimLevel, "crypto")} · last close ${fmtPrice(lastClose, "crypto")}`
        : "no reclaim level defined",
    },
    {
      id: "mitigation",
      label: "Zone fully mitigated / touched twice",
      hit: mitHit,
      detail: sig?.zoneTop != null
        ? `${touchesNote} [${fmtPrice(sig.zoneBottom ?? 0, "crypto")}–${fmtPrice(sig.zoneTop, "crypto")}] vs close ${fmtPrice(lastClose, "crypto")}`
        : "structure-type signal — no zone body",
    },
    {
      id: "oppositeStructure",
      label: "Opposite BOS/CHoCH after generation",
      hit: oppositeHit,
      detail: r?.structureEvent
        ? `latest event ${r.structureEvent.type} ${r.structureEvent.dir} @ ${fmtPrice(r.structureEvent.level, "crypto")}`
        : "no fresh structure print",
    },
    {
      id: "htfFlip",
      label: "HTF bias flipped against direction",
      hit: htfFlipHit,
      detail: `HTF at generation ${htfBiasAtGen} → now ${htfBiasNow}`,
    },
    {
      id: "dataStale",
      label: "Data stale",
      hit: dataStale,
      detail: dataStale ? "serving from cache — feed unreachable" : "feed fresh",
    },
  ];
}

/** Re-evaluate an existing candidate; returns a mutated copy. Any hit (pre-entry) → INVALIDATED with the exact reason. */
export function revalidateCandidate(
  c: RadarCandidate,
  lastClose: number,
  htfBiasNow: Bias,
  dataStale: boolean,
): RadarCandidate {
  const checks = buildInvalidChecks(c.setup, htfBiasNow, c.htfBiasAtGeneration, lastClose, dataStale);
  const hit = checks.find((ch) => ch.hit);
  const now = Date.now();

  if (c.status !== "active") return { ...c, invalidChecks: checks, dataStale, lastCheckedAt: now };
  if (now > (c.setup.signal?.validTillTs ?? 0)) {
    return { ...c, status: "expired", invalidChecks: checks, dataStale, lastCheckedAt: now, archivedAt: now, invalidReason: `validTill passed (${c.setup.signal?.validCandles ?? 0} setup-candles)` };
  }
  if (hit) {
    return { ...c, status: "invalidated", invalidChecks: checks, dataStale, lastCheckedAt: now, archivedAt: now, invalidReason: `${hit.label} — ${hit.detail}` };
  }
  return { ...c, invalidChecks: checks, dataStale, lastCheckedAt: now };
}

/* ------------------------------------------------ notifications */

let audioCtx: AudioContext | null = null;

export function radarBeep(top: boolean): void {
  try {
    audioCtx = audioCtx ?? new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
    const ctx = audioCtx;
    if (ctx.state === "suspended") void ctx.resume();
    const play = (freq: number, at: number, dur: number) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = "sine";
      o.frequency.value = freq;
      g.gain.setValueAtTime(0.0001, ctx.currentTime + at);
      g.gain.exponentialRampToValueAtTime(0.06, ctx.currentTime + at + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + at + dur);
      o.connect(g).connect(ctx.destination);
      o.start(ctx.currentTime + at);
      o.stop(ctx.currentTime + at + dur + 0.05);
    };
    play(880, 0, 0.12);
    if (top) play(1318.5, 0.14, 0.16);
  } catch { /* audio unavailable */ }
}
