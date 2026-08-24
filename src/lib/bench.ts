import type {
  BacktestTrade, BenchReport, BenchSegment, BenchWindowReport, BenchWindowSpec, RunnerSmokeReport,
  SegmentStats, SmokeArm, ThresholdCheck, Timeframe,
} from "./types";
import { contaminationNotice, COURSEEDGE_SMOKE, describeConfig, describeVariantSmoke, RUNNER_SMOKE, SMOKE_CONFIG } from "./benchConfig";
import type { PhaseConfig, VariantSmokeConfig } from "./benchConfig";
import { fetchHistory } from "./marketData";
import { collectEngineSetups, runBacktestOnCandles } from "./backtest";
import { scoreCourseEdge } from "./courseEdge";
import { BASELINE_VARIANT, freqFloor, LS_BENCH_KEY, LS_COURSEEDGE_KEY, LS_RUNNER_KEY, MIN_VAL_TRADES, PASS_THRESHOLDS, TEST_VARIANT, TM_VARIANTS, variantById } from "./tmVariant";
import type { TmVariantId } from "./tmVariant";
import { last, loadLS, saveLS, TF_MINUTES } from "./utils";

type Log = (msg: string, kind?: "info" | "ok" | "warn" | "err") => void;

/**
 * Legacy 90d windows — CONTAMINATED. Excluded from all runs and decisions; nothing may
 * auto-revert based on them. The eff2-slg protocol uses the fresh frozen SMOKE/POWERED
 * windows defined in benchConfig.ts instead.
 */
export const BENCH_WINDOWS: BenchWindowSpec[] = [
  { symbol: "BTCUSDT", assetType: "crypto", timeframe: "1h", days: 90, label: "BTC · 1H · 90D", contaminated: true },
  { symbol: "ETHUSDT", assetType: "crypto", timeframe: "1h", days: 90, label: "ETH · 1H · 90D", contaminated: true },
  { symbol: "SOLUSDT", assetType: "crypto", timeframe: "1h", days: 90, label: "SOL · 1H · 90D", contaminated: true },
  { symbol: "BTCUSDT", assetType: "crypto", timeframe: "15m", days: 90, label: "BTC · 15M · 90D", contaminated: true },
];

const SEG_ORDER: BenchSegment[] = ["CAL", "VAL", "OOS"];

export function loadBenchReport(): BenchReport | null {
  return loadLS<BenchReport | null>(LS_BENCH_KEY, null);
}

function saveBenchReport(r: BenchReport): void {
  saveLS(LS_BENCH_KEY, r);
}

/** Chronological 60/20/20 split by trade entry time. OOS is evaluated once, never iterated on. */
export function splitTrades(trades: BacktestTrade[], t0: number, tEnd: number): Record<BenchSegment, BacktestTrade[]> {
  const span = Math.max(1, tEnd - t0);
  const s1 = t0 + span * 0.6;
  const s2 = t0 + span * 0.8;
  const out: Record<BenchSegment, BacktestTrade[]> = { CAL: [], VAL: [], OOS: [] };
  for (const t of trades) {
    if (t.t < s1) out.CAL.push(t);
    else if (t.t < s2) out.VAL.push(t);
    else out.OOS.push(t);
  }
  return out;
}

export function computeSegmentStats(segment: BenchSegment, trades: BacktestTrade[], segmentDays: number): SegmentStats {
  const n = trades.length;
  const wins = trades.filter((t) => t.outcome === "win");
  const losses = trades.filter((t) => t.outcome === "loss");
  const be = trades.filter((t) => t.outcome === "breakeven");
  const decided = wins.length + losses.length;
  const grossW = wins.reduce((s, t) => s + t.pnlR, 0);
  const grossL = Math.abs(losses.reduce((s, t) => s + t.pnlR, 0));
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

  // within-segment net drawdown
  let cum = 0, peak = 0, maxDD = 0;
  for (const t of trades) { cum += t.pnlR; peak = Math.max(peak, cum); maxDD = Math.max(maxDD, peak - cum); }

  return {
    segment,
    trades: n,
    wins: wins.length,
    losses: losses.length,
    be: be.length,
    winRate: decided ? (wins.length / decided) * 100 : 0,
    grossPerTrade: mean(trades.map((t) => t.grossR)),
    costPerTrade: mean(trades.map((t) => t.feesR)),
    netPerTrade: mean(trades.map((t) => t.pnlR)),
    pf: grossL > 0 ? Math.min(99, grossW / grossL) : grossW > 0 ? 99 : 0,
    maxDDR: maxDD,
    partialRate: n ? (trades.filter((t) => t.partialHit).length / n) * 100 : 0,
    beRate: n ? (trades.filter((t) => t.exitKind === "be").length / n) * 100 : 0,
    stopOutRate: n ? (trades.filter((t) => t.exitKind === "stop").length / n) * 100 : 0,
    avgWinR: mean(wins.map((t) => t.pnlR)),
    avgLossR: mean(losses.map((t) => t.pnlR)),
    longs: trades.filter((t) => t.direction === "Long").length,
    shorts: trades.filter((t) => t.direction === "Short").length,
    tradesPerMonth: segmentDays > 0 ? n / (segmentDays / 30.44) : 0,
  };
}

function evaluateThresholds(v: SegmentStats, b: SegmentStats, minVal: number = MIN_VAL_TRADES): { checks: ThresholdCheck[]; verdict: BenchWindowReport["verdict"] } {
  const f2 = (x: number) => (x >= 0 ? "+" : "") + x.toFixed(3);
  const checks: ThresholdCheck[] = [
    {
      id: PASS_THRESHOLDS[0].id, label: PASS_THRESHOLDS[0].label,
      detail: `variant VAL net/t ${f2(v.netPerTrade)}`,
      pass: v.netPerTrade > 0,
    },
    {
      id: PASS_THRESHOLDS[1].id, label: PASS_THRESHOLDS[1].label,
      detail: `${f2(v.netPerTrade)} vs baseline ${f2(b.netPerTrade)}`,
      pass: v.netPerTrade > b.netPerTrade,
    },
    {
      id: PASS_THRESHOLDS[2].id, label: PASS_THRESHOLDS[2].label,
      detail: `${v.trades} trades in VAL → ${v.tradesPerMonth.toFixed(1)}/month`,
      pass: v.tradesPerMonth >= 8,
    },
    {
      id: PASS_THRESHOLDS[3].id, label: PASS_THRESHOLDS[3].label,
      detail: `${f2(v.grossPerTrade)} vs 0.9 × ${f2(b.grossPerTrade)} = ${f2(0.9 * b.grossPerTrade)}`,
      pass: v.grossPerTrade >= 0.9 * b.grossPerTrade,
    },
  ];
  const insufficient = v.trades < minVal;
  const verdict: BenchWindowReport["verdict"] = insufficient
    ? "INSUFFICIENT"
    : checks.every((c) => c.pass) ? "PASS" : "FAIL";
  return { checks, verdict };
}

export interface WindowOpts {
  /** config-driven frequency floor; default = legacy max(0.8 × baseline, 50) */
  floorFn?: (baselineTrades: number) => number;
  /** override the INSUFFICIENT sample gate (default MIN_VAL_TRADES) */
  minValTrades?: number;
}

async function runBenchWindow(
  w: BenchWindowSpec,
  log: Log,
  onRunProgress?: (pct: number) => void,
  opts: WindowOpts = {},
): Promise<BenchWindowReport> {
  const t0 = performance.now();
  log(`── window ${w.label}: fetching shared candles${w.endTs ? ` (frozen, ends ${new Date(w.endTs).toISOString().slice(0, 10)})` : ""}…`);
  // candle budget sized for the window (365d × 15M ≈ 35k) so long frozen windows aren't truncated
  const maxCandles = Math.min(60000, Math.ceil((w.days * 1440) / TF_MINUTES[w.timeframe]) + 400);
  const hist = await fetchHistory(w.symbol, w.assetType, w.timeframe, w.days, log, maxCandles, w.endTs);
  const candles = hist.candles;
  const stepMs = TF_MINUTES[w.timeframe] * 60_000;
  const t0ts = candles[0].t;
  const tEnd = candles[candles.length - 1].t + stepMs;
  log(`window ${w.label}: ${candles.length} candles from ${hist.source} — all variants run on this exact series`, "ok");

  const segments = {} as Record<TmVariantId, SegmentStats[]>;
  const fullRun = {} as Record<TmVariantId, number>;
  for (const v of TM_VARIANTS) {
    const res = await runBacktestOnCandles(
      candles,
      { symbol: w.symbol, assetType: w.assetType, timeframe: w.timeframe, days: w.days },
      v.mode,
      log,
      (p) => onRunProgress?.(p),
      hist.source,
      v.advQuality,
      v.slShield,
    );
    fullRun[v.id] = res.trades.length; // full-run closed trades (incl. time-marked) — pre-split
    log(`window ${w.label}: ${v.short} → ${res.trades.length} trades · WR ${res.winRate.toFixed(0)}% · net/t ${res.netPerTrade.toFixed(3)}R${v.slShield ? ` · misses ${res.missNoConfirm + res.missLimitChase + res.missLimitUnfilled} · stale ${res.staleExits}` : ""}`);
    const split = splitTrades(res.trades, t0ts, tEnd);
    segments[v.id] = SEG_ORDER.map((seg) => computeSegmentStats(seg, split[seg], w.days * (seg === "CAL" ? 0.6 : 0.2)));
  }

  // variant under test = newest in the registry; reference = BASELINE v1.0.0
  const vVal = segments[TEST_VARIANT.id][1];
  const bVal = segments[BASELINE_VARIANT.id][1];
  const { checks, verdict: valVerdict } = evaluateThresholds(vVal, bVal, opts.minValTrades ?? MIN_VAL_TRADES);

  /* ---- FREQUENCY GUARD: full-run closed trades must stay ≥ config floor (mechanism unchanged) ---- */
  const baselineTrades = fullRun[BASELINE_VARIANT.id];
  const advTrades = fullRun[TEST_VARIANT.id];
  const floor = (opts.floorFn ?? freqFloor)(baselineTrades);
  const guardPass = advTrades >= floor;
  const freqGuard = { baselineTrades, advTrades, floor: Number(floor.toFixed(1)), pass: guardPass };
  checks.push({
    id: "T5",
    label: `FREQUENCY GUARD — full-run trades ≥ max(0.8 × baseline, min(${opts.floorFn ? "config cap" : "50"}, baseline))`,
    detail: `${advTrades} variant vs ${baselineTrades} baseline · floor ${floor.toFixed(1)}`,
    pass: guardPass,
  });
  const verdict: BenchWindowReport["verdict"] = !guardPass ? "FAIL" : valVerdict;

  log(
    `window ${w.label}: VAL net/t ${BASELINE_VARIANT.short} ${bVal.netPerTrade.toFixed(3)} vs ${TEST_VARIANT.short} ${vVal.netPerTrade.toFixed(3)} → ${valVerdict}` +
      (valVerdict === "INSUFFICIENT" ? ` (VAL sample ${vVal.trades} < ${MIN_VAL_TRADES} — NO CONCLUSION)` : ""),
    valVerdict === "FAIL" ? "warn" : "info",
  );
  log(
    `window ${w.label}: FREQUENCY GUARD — adv ${advTrades} / baseline ${baselineTrades} (floor ${floor.toFixed(1)}) → ${guardPass ? "PASS" : "FAIL — ADV SOFT LAYERS WILL BE SUSPENDED"}`,
    guardPass ? "ok" : "err",
  );

  return {
    window: w,
    candles: candles.length,
    dataSource: hist.source,
    segments,
    checks,
    verdict,
    valTrades: vVal.trades,
    baselineValTrades: bVal.trades,
    freqGuard,
    frequencyGuardPassed: guardPass,
    elapsedMs: performance.now() - t0,
  };
}

/**
 * Aggregate FREQUENCY GUARD verdict from the windows completed so far.
 * null while there is no conclusive evidence (aborted run or zero windows).
 */
export function computeAdvFrequencyOk(report: Pick<BenchReport, "aborted" | "windows">): boolean | null {
  if (report.aborted || report.windows.length === 0) return null;
  return report.windows.every((w) => w.frequencyGuardPassed);
}

/**
 * Full benchmark: 4 windows × 3 variants, identical candles per window,
 * chronological 60/20/20 (CAL/VAL/OOS, OOS touched once), thresholds on VAL,
 * plus the FREQUENCY GUARD (adv full-run trades ≥ max(0.8 × baseline, 50)).
 * A guard failure marks the advanced variant FAIL and — via loadFrequencyGate() —
 * suspends its soft additions in live signal generation until a passing run is stored.
 */
const baseOf = (s: string) => s.replace(/USDT$/, "");

/** Build the frozen window list for a phase: one window per symbol on the primary TF, plus a secondary-TF window per symbol when configured. */
export function buildPhaseWindows(c: PhaseConfig): BenchWindowSpec[] {
  const out: BenchWindowSpec[] = [];
  const mk = (sym: string, tf: Timeframe, tag: string): BenchWindowSpec => ({
    symbol: sym, assetType: "crypto", timeframe: tf, days: c.days,
    label: `${baseOf(sym)} · ${tf.toUpperCase()} · ${c.days}D${tag}`,
    endTs: c.anchorEnd,
  });
  for (const s of c.symbols) out.push(mk(s, c.timeframe, ""));
  if (c.secondaryTimeframe) for (const s of c.symbols) out.push(mk(s, c.secondaryTimeframe, " · 2ND"));
  return out;
}

export async function runBenchmark(
  log: Log,
  onWindow: (report: BenchWindowReport, index: number) => void,
  onRunProgress?: (windowIndex: number, pct: number) => void,
  isAborted?: () => boolean,
  config: PhaseConfig = SMOKE_CONFIG,
): Promise<BenchReport> {
  const t0 = performance.now();
  const report: BenchReport = { ranAt: Date.now(), elapsedMs: 0, aborted: false, windows: [], advFrequencyOk: null };

  // print the ACTIVE CONFIG (variant slot, windows, TF, floor) BEFORE any run
  log(contaminationNotice(), "warn");
  for (const line of describeConfig(config)) log(line, "info");

  const windows = buildPhaseWindows(config);
  log(`bench: ${windows.length} frozen window(s) queued for ${config.variantSlot} vs ${config.baselineSlot}`, "info");

  for (let wi = 0; wi < windows.length; wi++) {
    if (isAborted?.()) { report.aborted = true; break; }
    try {
      const wr = await runBenchWindow(
        windows[wi], log, (p) => onRunProgress?.(wi, p),
        { floorFn: config.floor, minValTrades: config.minValTrades ?? MIN_VAL_TRADES },
      );
      report.windows.push(wr);
      report.advFrequencyOk = computeAdvFrequencyOk(report);
      saveBenchReport(report);
      onWindow(wr, wi);
    } catch (e) {
      log(`window ${windows[wi].label} failed: ${e instanceof Error ? e.message : "unknown"}`, "err");
      report.aborted = true;
      break;
    }
  }
  report.advFrequencyOk = computeAdvFrequencyOk(report);
  report.elapsedMs = performance.now() - t0;
  report.ranAt = Date.now();
  saveBenchReport(report);
  if (report.advFrequencyOk === false) {
    log(`FREQUENCY GUARD FAILED — ${config.variantSlot} additions are REVERTED in live scanning until a passing benchmark`, "err");
  } else if (report.advFrequencyOk === true) {
    log(`FREQUENCY GUARD PASSED — ${config.variantSlot} additions remain live`, "ok");
  }
  return report;
}

/* ================= runner-v1.0.0 smoke test (exit-management variant) ================= */

interface ArmAcc { entries: number; trades: BacktestTrade[]; missNoConfirm: number; missLimitChase: number; missLimitUnfilled: number; staleExits: number }

function armFromAcc(variantId: string, acc: ArmAcc): SmokeArm {
  const trades = acc.trades;
  const n = trades.length;
  const wins = trades.filter((t) => t.outcome === "win");
  const losses = trades.filter((t) => t.outcome === "loss");
  const decided = wins.length + losses.length;
  const grossW = wins.reduce((s, t) => s + t.pnlR, 0);
  const grossL = Math.abs(losses.reduce((s, t) => s + t.pnlR, 0));
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  let cum = 0, peak = 0, dd = 0;
  for (const t of trades) { cum += t.pnlR; peak = Math.max(peak, cum); dd = Math.max(dd, peak - cum); }
  const partials = trades.filter((t) => t.partialHit);
  return {
    variantId,
    entries: acc.entries,
    trades: n,
    winRate: decided ? (wins.length / decided) * 100 : 0,
    slHitRate: n ? (trades.filter((t) => t.exitKind === "stop").length / n) * 100 : 0,
    grossPerTrade: mean(trades.map((t) => t.grossR)),
    costPerTrade: mean(trades.map((t) => t.feesR)),
    netPerTrade: mean(trades.map((t) => t.pnlR)),
    profitFactor: grossL > 0 ? Math.min(99, grossW / grossL) : grossW > 0 ? 99 : 0,
    maxDrawdownR: dd,
    avgWinR: mean(wins.map((t) => t.pnlR)),
    avgLossR: mean(losses.map((t) => t.pnlR)),
    partialRate: n ? (partials.length / n) * 100 : 0,
    beAfterPartialRate: n ? (trades.filter((t) => t.partialHit && t.exitKind === "be").length / n) * 100 : 0,
    avgRunnerHoldBars: mean(partials.map((t) => t.holdBars ?? 0)),
    missNoConfirm: acc.missNoConfirm,
    missLimitChase: acc.missLimitChase,
    missLimitUnfilled: acc.missLimitUnfilled,
    staleExits: acc.staleExits,
  };
}

/**
 * Runner smoke: baseline vs runner on a fresh frozen window (BTC/ETH/SOL · 15M · 30d).
 * Both arms run the IDENTICAL entry pipeline; only exit management differs (runner mode).
 * GUARD = exact entry-count equality. Any drift means the shared entry path was disturbed → revert.
 */
export async function runRunnerSmoke(
  log: Log,
  onProgress?: (pct: number) => void,
  isAborted?: () => boolean,
): Promise<RunnerSmokeReport> {
  const t0 = performance.now();
  const cfg = RUNNER_SMOKE;
  log(contaminationNotice(), "warn");
  for (const line of describeRunnerConfig(cfg)) log(line, "info");

  const baseDef = variantById(cfg.baselineSlot as TmVariantId);
  const varDef = variantById(cfg.variantSlot as TmVariantId);
  const base: ArmAcc = { entries: 0, trades: [], missNoConfirm: 0, missLimitChase: 0, missLimitUnfilled: 0, staleExits: 0 };
  const vari: ArmAcc = { entries: 0, trades: [], missNoConfirm: 0, missLimitChase: 0, missLimitUnfilled: 0, staleExits: 0 };
  let dataSource = "—";

  for (let si = 0; si < cfg.symbols.length; si++) {
    if (isAborted?.()) break;
    const symbol = cfg.symbols[si];
    log(`── ${symbol}: fetching frozen ${cfg.days}d ${cfg.timeframe} candles…`);
    const hist = await fetchHistory(symbol, "crypto", cfg.timeframe, cfg.days, log, 60000, cfg.anchorEnd);
    dataSource = hist.source;
    log(`${symbol}: ${hist.candles.length} candles from ${hist.source} — both arms on this exact series`, "ok");
    for (const [def, acc] of [[baseDef, base], [varDef, vari]] as const) {
      const res = await runBacktestOnCandles(
        hist.candles,
        { symbol, assetType: "crypto", timeframe: cfg.timeframe, days: cfg.days },
        def.mode, log,
        (p) => onProgress?.(Math.round(((si + (def === baseDef ? 0 : 0.5)) / cfg.symbols.length) * 100)),
        hist.source, def.advQuality, def.slShield,
      );
      acc.entries += res.funnel.entered;
      acc.trades.push(...res.trades);
      acc.missNoConfirm += res.missNoConfirm; acc.missLimitChase += res.missLimitChase;
      acc.missLimitUnfilled += res.missLimitUnfilled; acc.staleExits += res.staleExits;
      log(`${symbol} · ${def.short}: ${res.trades.length} trades · entries ${res.funnel.entered} · WR ${res.winRate.toFixed(0)}% · net/t ${res.netPerTrade.toFixed(3)}R${def.mode === "runner" ? ` · partials ${res.partialRate.toFixed(0)}% · stale ${res.staleExits}` : ""}`);
    }
  }
  onProgress?.(100);

  const baseline = armFromAcc(cfg.baselineSlot, base);
  const variant = armFromAcc(cfg.variantSlot, vari);
  const entriesEqual = baseline.entries === variant.entries && baseline.entries > 0;
  const overallPass = entriesEqual;

  log(`RUNNER SMOKE · entries: baseline ${baseline.entries} vs runner ${variant.entries} → ${entriesEqual ? "EXACT EQUALITY ✓" : "DRIFT ✗ (revert)"}`, entriesEqual ? "ok" : "err");
  log(`RUNNER SMOKE · net/t: baseline ${baseline.netPerTrade.toFixed(3)}R vs runner ${variant.netPerTrade.toFixed(3)}R · WR ${baseline.winRate.toFixed(0)}% vs ${variant.winRate.toFixed(0)}% · avgWin ${variant.avgWinR.toFixed(2)}R · avgLoss ${variant.avgLossR.toFixed(2)}R`, "info");

  const report: RunnerSmokeReport = {
    ranAt: Date.now(),
    window: `${cfg.symbols.map((s) => s.replace("USDT", "")).join("+")} · ${cfg.timeframe.toUpperCase()} · ${cfg.days}D (frozen)`,
    baseline, variant, entriesEqual, overallPass, dataSource,
  };
  saveLS(LS_RUNNER_KEY, report);
  log(`runner gate stored → ${overallPass ? "PASS (variant qualified for radar)" : "FAIL (variant stays a bench slot / reverted)"}`, overallPass ? "ok" : "warn");
  log(`runner smoke done in ${((performance.now() - t0) / 1000).toFixed(1)}s`, "ok");
  return report;
}

export function loadRunnerSmoke(): RunnerSmokeReport | null {
  return loadLS<RunnerSmokeReport | null>(LS_RUNNER_KEY, null);
}
