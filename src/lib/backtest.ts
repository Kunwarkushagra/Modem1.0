import type {
  AnalyzeParams, BacktestResult, BacktestTrade, Candle, CostModel, ExpiryLogItem, ExitKind,
  PerformanceSummary, SignalType, TmMode, TradeOutcome,
} from "./types";
import { fetchHistory } from "./marketData";
import { computeIndicators } from "./indicators";
import { analyzeSMC } from "./smc";
import { deriveBias, localSetups, validateSetup } from "./ai";
import type { EngineCtx } from "./ai";
import { TF_MINUTES } from "./utils";

type Log = (msg: string, kind?: "info" | "ok" | "warn" | "err") => void;

/** SCALP-1.0 honest cost model — charged on EVERY trade, EVERY leg (partial legs carry 50% weight of the exit leg) */
export const COSTS: CostModel = {
  makerPct: 0.0002,   // 0.02% entry leg (limit)
  takerPct: 0.001,    // 0.10% exit leg (market)
  slippagePct: 0.0005, // 0.05% per leg
  entryPct: 0.0007,   // 0.02 + 0.05
  exitPct: 0.0015,    // 0.10 + 0.05
};

const EMPTY_PERF: PerformanceSummary = {
  total: 0, wins: 0, losses: 0, breakeven: 0, winRate: 0, avgWinPct: 0, avgLossPct: 0,
  profitFactor: 0, sharpe: 0, maxDrawdown: 0, bestConfluences: [], worstConfluences: [],
  recent: { trades: 0, winRate: 0, tilt: false }, equity: [100],
};

interface PendingSignal {
  setup: ReturnType<typeof validateSetup>;
  signalType: SignalType;
  signalI: number;
  generatedAt: number;
  validTillTs: number;
  reclaimLevel: number | null;
  zoneTop: number | null;
  zoneBottom: number | null;
  touches: number;
  structCheckAt: number;
}

export interface BacktestParams {
  symbol: string;
  assetType: AnalyzeParams["assetType"];
  timeframe: AnalyzeParams["timeframe"];
  days: number;
}

/**
 * Core walk-forward engine. Entry pipeline (gates, V1–V6, validity/expiry, confirmed-only,
 * next-open fills) is IDENTICAL for every TmMode — only exit management differs:
 *  - classic  (baseline v1.0.0): TP1 → SL@BE → TP2, 60-bar mark
 *  - tm110    (scalp10-tm-v1.1.0): 50% partial @ +1.0R → SL@BE → runner to TP2-objective, 60-bar mark
 */
export async function runBacktestOnCandles(
  candles: Candle[],
  params: BacktestParams,
  tmMode: TmMode,
  log: Log,
  onProgress?: (pct: number) => void,
  dataSource = "cache",
): Promise<BacktestResult> {
  const t0 = performance.now();
  const stepMs = TF_MINUTES[params.timeframe] * 60_000;
  const lookback = 220;
  const forwardMax = 60;
  const end = candles.length - 2; // confirmed candles only: never analyze/enter on the forming candle
  const step = Math.max(4, Math.round(candles.length / 160));

  log(`[${tmMode}] walk-forward: ${candles.length} candles · confirmed-only · costs ${(COSTS.entryPct * 100).toFixed(2)}%/${(COSTS.exitPct * 100).toFixed(2)}%+slip`);

  const trades: BacktestTrade[] = [];
  const expiryLog: ExpiryLogItem[] = [];
  const funnel = { generated: 0, expiredBeforeTrigger: 0, entered: 0, wins: 0, losses: 0, breakeven: 0 };
  let skippedInvalid = 0;
  let cooldownUntil = -1;

  let pending: PendingSignal | null = null;
  let triggered = false;
  let triggerI = -1;

  let open: BacktestTrade | null = null;
  let openSl = 0, openTp1 = 0, openTp2 = 0, openFill = 0, openRisk = 0, trailing = false, openStartI = 0, manageFromI = 0;
  // tm110 state
  let tmPartial = 0, tmPartialDone = false, tmRunner = 0;

  /** Full-weight close (whole position on one leg pair). Used by classic always; tm110 for pre-partial stops and un-partialed time marks. */
  const fullClose = (t: BacktestTrade, exitPrice: number, kind: ExitKind, i: number) => {
    const long = t.direction === "Long";
    const grossR = ((exitPrice - openFill) / openRisk) * (long ? 1 : -1);
    const feesR = (openFill * COSTS.entryPct + exitPrice * COSTS.exitPct) / openRisk;
    const netR = grossR - feesR;
    const outcome: TradeOutcome = netR > 0.01 ? "win" : netR < -0.01 ? "loss" : "breakeven";
    t.grossR = Number(grossR.toFixed(3));
    t.feesR = Number(feesR.toFixed(3));
    t.pnlR = Number(netR.toFixed(3));
    t.outcome = outcome;
    t.partialHit = false;
    t.exitKind = kind;
    trades.push(t);
    funnel[outcome === "win" ? "wins" : outcome === "loss" ? "losses" : "breakeven"]++;
    cooldownUntil = i + 3;
    open = null;
  };

  /** tm110 close after the 50% partial already filled at exactly +1.0R. Runner exits at `runnerExit`. Exit legs weighted 0.5 each. */
  const tmClose = (t: BacktestTrade, runnerExit: number, kind: ExitKind, i: number) => {
    const long = t.direction === "Long";
    const partialPrice = openFill + (long ? 1 : -1) * openRisk; // +1.0R by construction
    const runnerR = ((runnerExit - openFill) / openRisk) * (long ? 1 : -1);
    const grossR = 0.5 * 1.0 + 0.5 * runnerR;
    const feesR =
      (openFill * COSTS.entryPct) / openRisk +                     // entry leg, full weight
      (0.5 * partialPrice * COSTS.exitPct) / openRisk +            // partial exit leg, 50% weight
      (0.5 * runnerExit * COSTS.exitPct) / openRisk;               // runner exit leg, 50% weight
    const netR = grossR - feesR;
    const outcome: TradeOutcome = netR > 0.01 ? "win" : netR < -0.01 ? "loss" : "breakeven";
    t.grossR = Number(grossR.toFixed(3));
    t.feesR = Number(feesR.toFixed(3));
    t.pnlR = Number(netR.toFixed(3));
    t.outcome = outcome;
    t.partialHit = true;
    t.exitKind = kind;
    trades.push(t);
    funnel[outcome === "win" ? "wins" : outcome === "loss" ? "losses" : "breakeven"]++;
    cooldownUntil = i + 3;
    open = null;
  };

  const expire = (reason: string, i: number) => {
    if (!pending) return;
    funnel.expiredBeforeTrigger++;
    expiryLog.push({ i, t: candles[i].t, direction: pending.setup.direction, signalType: pending.signalType, reason });
    if (expiryLog.length > 40) expiryLog.shift();
    pending = null;
    triggered = false;
    cooldownUntil = i + 2;
  };

  const totalSteps = Math.max(1, end - lookback);
  let yieldCounter = 0;

  for (let i = lookback; i < end; i++) {
    if (++yieldCounter % 60 === 0) {
      onProgress?.(Math.round(((i - lookback) / totalSteps) * 100));
      await new Promise((r) => setTimeout(r, 0));
    }
    const c = candles[i];
    const closeTime = c.t + stepMs;

    /* ---------- manage open position ---------- */
    if (open) {
      if (i >= manageFromI) {
        const long = open.direction === "Long";
        if (tmMode === "classic") {
          const hitSl = long ? c.l <= openSl : c.h >= openSl;
          const hitTp1 = long ? c.h >= openTp1 : c.l <= openTp1;
          const hitTp2 = long ? c.h >= openTp2 : c.l <= openTp2;
          if (hitTp2 && (!hitSl || trailing)) { fullClose(open, openTp2, "target", i); }
          else if (hitSl) { fullClose(open, trailing ? openFill : openSl, trailing ? "be" : "stop", i); }
          else if (hitTp1 && !trailing) { trailing = true; openSl = openFill; }
          if (open && trailing && (long ? c.l <= openFill : c.h >= openFill)) { fullClose(open, openFill, "be", i); }
          if (open && i - openStartI >= forwardMax) { fullClose(open, c.c, "time", i); }
        } else {
          // tm110: partial @ +1.0R (conservative same-candle fill), then runner with SL at breakeven
          if (!tmPartialDone) {
            const hitSl = long ? c.l <= openSl : c.h >= openSl;
            const hitPart = long ? c.h >= tmPartial : c.l <= tmPartial;
            if (hitSl) { fullClose(open, openSl, "stop", i); }               // adverse ambiguity: stop first
            else if (hitPart) { tmPartialDone = true; openSl = openFill; }   // book 50% @ +1R, SL → BE
          } else {
            const hitBe = long ? c.l <= openFill : c.h >= openFill;
            const hitRunner = long ? c.h >= tmRunner : c.l <= tmRunner;
            if (hitBe) { tmClose(open, openFill, "be", i); }                 // adverse ambiguity: BE before runner
            else if (hitRunner) { tmClose(open, tmRunner, "target", i); }
          }
          if (open && i - openStartI >= forwardMax) {
            if (tmPartialDone) tmClose(open, c.c, "time", i);                // time exit marks the runner
            else fullClose(open, c.c, "time", i);
          }
        }
      }
      continue;
    }

    /* ---------- pending signal: validity + trigger ---------- */
    if (pending) {
      const p = pending;
      const long = p.setup.direction === "Long";

      if (closeTime > p.validTillTs) { expire(`${p.signalType}: ${p.setup.signal?.validCandles ?? 0} setup-candles elapsed`, i); continue; }
      if (p.reclaimLevel != null && (long ? c.c < p.reclaimLevel : c.c > p.reclaimLevel)) { expire(`${p.signalType}: level reclaimed against direction (close ${c.c.toPrecision(6)})`, i); continue; }
      if (p.signalType === "zone" && p.zoneTop != null && p.zoneBottom != null) {
        if (long ? c.c < p.zoneBottom : c.c > p.zoneTop) { expire("zone: fully mitigated (close through far edge)", i); continue; }
        const intersects = long ? c.l <= p.zoneTop : c.h >= p.zoneBottom;
        if (intersects && !triggered) {
          p.touches++;
          if (p.touches >= 2) { expire("zone: touched twice before commitment", i); continue; }
        }
      }
      if (p.signalType === "structure" && i >= p.structCheckAt) {
        p.structCheckAt = i + 4;
        const smcNow = analyzeSMC(candles.slice(0, i + 1));
        const opposite = long ? "bear" : "bull";
        if (smcNow.structure.some((ev) => ev.dir === opposite && ev.t > p.generatedAt)) {
          expire(`structure: opposite ${long ? "bearish" : "bullish"} BOS/CHoCH printed`, i);
          continue;
        }
      }

      if (!triggered && (long ? c.l <= p.setup.entry_price : c.h >= p.setup.entry_price)) {
        if (closeTime <= p.validTillTs) { triggered = true; triggerI = i; }
        else { expire("trigger candle closed after validTill — entry not allowed", i); continue; }
      }

      // fill at NEXT candle open after the confirming trigger close
      if (triggered && i === triggerI + 1) {
        const fill = c.o;
        const delta = fill - p.setup.entry_price;
        const sl = p.setup.stop_loss + delta;
        const tp1 = p.setup.take_profit1 + delta;
        const tp2 = p.setup.take_profit2 + delta;
        const risk = Math.abs(fill - sl);
        if (risk <= 0) { pending = null; triggered = false; cooldownUntil = i + 2; continue; }
        open = {
          i, t: c.t, direction: p.setup.direction,
          entry: fill, sl, tp1, tp2,
          rr: p.setup.risk_reward_ratio, outcome: "breakeven",
          grossR: 0, feesR: 0, pnlR: 0,
          confluences: p.setup.confluences,
          signalType: p.signalType, generatedAt: p.generatedAt,
          partialHit: false, exitKind: "time",
        };
        openFill = fill; openSl = sl; openTp1 = tp1; openTp2 = tp2; openRisk = risk;
        trailing = false; openStartI = i; manageFromI = i;
        const long2 = open.direction === "Long";
        const dirSign = long2 ? 1 : -1;

        if (tmMode === "tm110") {
          tmPartial = fill + dirSign * risk * 1.0;                                   // TP-PARTIAL = +1.0R
          const tp2dist = Math.abs(tp2 - fill) / risk;
          // RUNNER = original TP2 logic (2nd pool / range extreme) if objective & beyond the partial, else original TP1 floor
          tmRunner = p.setup.tp2_objective && tp2dist > 1.0 ? tp2 : tp1;
          tmPartialDone = false;
        }

        funnel.entered++;
        pending = null; triggered = false;

        // manage the fill candle immediately (conservative intra-candle resolution)
        if (tmMode === "classic") {
          if (long2 ? c.l <= openSl : c.h >= openSl) fullClose(open, openSl, "stop", i);
          else if (long2 ? c.h >= openTp2 : c.l <= openTp2) fullClose(open, openTp2, "target", i);
          else if (long2 ? c.h >= openTp1 : c.l <= openTp1) { trailing = true; openSl = openFill; }
        } else {
          if (long2 ? c.l <= openSl : c.h >= openSl) fullClose(open, openSl, "stop", i);
          else if (long2 ? c.h >= tmPartial : c.l <= tmPartial) { tmPartialDone = true; openSl = openFill; }
          // no runner evaluation on the fill candle — conservative; runner management begins next candle
        }
      }
      continue;
    }

    /* ---------- idle: generate on cadence (entry pipeline — variant-agnostic) ---------- */
    if (i <= cooldownUntil || (i - lookback) % step !== 0) continue;
    const window = candles.slice(0, i + 1);
    const ind = computeIndicators(window);
    const smc = analyzeSMC(window);
    const bias = deriveBias(smc, ind, window);
    const generatedAt = c.t + stepMs;
    const ctx: EngineCtx = {
      params: { symbol: params.symbol, assetType: params.assetType, timeframe: params.timeframe, accountSize: 10000, riskPercent: 1 },
      candles: window, ind, smc, htfSmc: smc, htfInd: ind, htfCandles: window,
      htfBias: bias, perf: EMPTY_PERF, newsCount: 0,
      generatedAt, stepMs,
    };
    const raw = localSetups(ctx).slice(0, 1);
    if (!raw.length) continue;
    const setup = validateSetup(raw[0], ctx);
    if (!setup.validation.checks.every((ch) => ch.passed)) { skippedInvalid++; continue; }
    if (!setup.signal) continue;

    funnel.generated++;
    pending = {
      setup,
      signalType: setup.signal.type,
      signalI: i,
      generatedAt: setup.signal.generatedAt,
      validTillTs: setup.signal.validTillTs,
      reclaimLevel: setup.signal.reclaimLevel,
      zoneTop: setup.signal.zoneTop,
      zoneBottom: setup.signal.zoneBottom,
      touches: 0,
      structCheckAt: i + 4,
    };
    triggered = false;
  }
  onProgress?.(100);

  // force-close anything still open at the last confirmed candle
  if (open) {
    const lastC = candles[end - 1]?.c ?? openFill;
    if (tmMode === "tm110" && tmPartialDone) tmClose(open, lastC, "time", end - 1);
    else fullClose(open, lastC, "time", end - 1);
  }

  const wins = trades.filter((t) => t.outcome === "win");
  const losses = trades.filter((t) => t.outcome === "loss");
  const grossW = wins.reduce((s, t) => s + t.pnlR, 0);
  const grossL = Math.abs(losses.reduce((s, t) => s + t.pnlR, 0));
  const decided = wins.length + losses.length;

  const equityR: number[] = [0];
  for (const t of trades) equityR.push(Number((equityR[equityR.length - 1] + t.pnlR).toFixed(3)));
  let peak = 0, maxDD = 0;
  for (const e of equityR) { peak = Math.max(peak, e); maxDD = Math.max(maxDD, peak - e); }
  const rets = trades.map((t) => t.pnlR);
  const meanR = rets.length ? rets.reduce((a, b) => a + b, 0) / rets.length : 0;
  const sd = rets.length > 1 ? Math.sqrt(rets.reduce((s, r) => s + (r - meanR) ** 2, 0) / (rets.length - 1)) : 0;

  const n = trades.length;
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  const agg = {
    grossPerTrade: mean(trades.map((t) => t.grossR)),
    costPerTrade: mean(trades.map((t) => t.feesR)),
    netPerTrade: meanR,
    partialRate: n ? (trades.filter((t) => t.partialHit).length / n) * 100 : 0,
    beRate: n ? (trades.filter((t) => t.exitKind === "be").length / n) * 100 : 0,
    stopOutRate: n ? (trades.filter((t) => t.exitKind === "stop").length / n) * 100 : 0,
    avgWinR: mean(wins.map((t) => t.pnlR)),
    avgLossR: mean(losses.map((t) => t.pnlR)),
    longs: trades.filter((t) => t.direction === "Long").length,
    shorts: trades.filter((t) => t.direction === "Short").length,
  };

  log(`[${tmMode}] done: ${n} trades · WR ${decided ? ((wins.length / decided) * 100).toFixed(0) : 0}% · net ${equityR[equityR.length - 1].toFixed(1)}R · partials ${agg.partialRate.toFixed(0)}%`, "ok");

  return {
    params,
    tmMode,
    totalCandles: candles.length,
    trades,
    skippedInvalid,
    funnel,
    expiryLog,
    costs: COSTS,
    winRate: decided ? (wins.length / decided) * 100 : 0,
    profitFactor: grossL > 0 ? grossW / grossL : grossW > 0 ? 99 : 0,
    expectancyR: meanR,
    maxDrawdownR: maxDD,
    sharpe: sd > 0 ? meanR / sd : 0,
    netR: equityR[equityR.length - 1] ?? 0,
    grossR: trades.reduce((s, t) => s + t.grossR, 0),
    equityR,
    ...agg,
    durationMs: performance.now() - t0,
    dataSource,
  };
}

/** Convenience wrapper: fetch history, then run the core engine. */
export async function runBacktest(
  params: BacktestParams,
  log: Log,
  onProgress?: (pct: number) => void,
  tmMode: TmMode = "classic",
): Promise<BacktestResult> {
  const hist = await fetchHistory(params.symbol, params.assetType, params.timeframe, params.days, log);
  return runBacktestOnCandles(hist.candles, params, tmMode, log, onProgress, hist.source);
}
