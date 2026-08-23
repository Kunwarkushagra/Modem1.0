import type {
  BacktestTrade, BenchReport, BenchSegment, BenchWindowReport, BenchWindowSpec, SegmentStats,
  ThresholdCheck,
} from "./types";
import { fetchHistory } from "./marketData";
import { runBacktestOnCandles } from "./backtest";
import { BASELINE_VARIANT, freqFloor, LS_BENCH_KEY, MIN_VAL_TRADES, PASS_THRESHOLDS, TEST_VARIANT, TM_VARIANTS } from "./tmVariant";
import type { TmVariantId } from "./tmVariant";
import { loadLS, saveLS, TF_MINUTES } from "./utils";

type Log = (msg: string, kind?: "info" | "ok" | "warn" | "err") => void;

/** The four pre-registered windows — SAME windows for both variants. */
export const BENCH_WINDOWS: BenchWindowSpec[] = [
  { symbol: "BTCUSDT", assetType: "crypto", timeframe: "1h", days: 90, label: "BTC · 1H · 90D" },
  { symbol: "ETHUSDT", assetType: "crypto", timeframe: "1h", days: 90, label: "ETH · 1H · 90D" },
  { symbol: "SOLUSDT", assetType: "crypto", timeframe: "1h", days: 90, label: "SOL · 1H · 90D" },
  { symbol: "BTCUSDT", assetType: "crypto", timeframe: "15m", days: 90, label: "BTC · 15M · 90D" },
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

function evaluateThresholds(v: SegmentStats, b: SegmentStats): { checks: ThresholdCheck[]; verdict: BenchWindowReport["verdict"] } {
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
  const insufficient = v.trades < MIN_VAL_TRADES;
  const verdict: BenchWindowReport["verdict"] = insufficient
    ? "INSUFFICIENT"
    : checks.every((c) => c.pass) ? "PASS" : "FAIL";
  return { checks, verdict };
}

async function runBenchWindow(
  w: BenchWindowSpec,
  log: Log,
  onRunProgress?: (pct: number) => void,
): Promise<BenchWindowReport> {
  const t0 = performance.now();
  log(`── window ${w.label}: fetching shared candles…`);
  const hist = await fetchHistory(w.symbol, w.assetType, w.timeframe, w.days, log, 12000);
  const candles = hist.candles;
  const stepMs = TF_MINUTES[w.timeframe] * 60_000;
  const t0ts = candles[0].t;
  const tEnd = candles[candles.length - 1].t + stepMs;
  log(`window ${w.label}: ${candles.length} candles from ${hist.source} — both variants run on this exact series`, "ok");

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
    );
    fullRun[v.id] = res.trades.length; // full-run closed trades (incl. time-marked) — pre-split
    const split = splitTrades(res.trades, t0ts, tEnd);
    segments[v.id] = SEG_ORDER.map((seg) => computeSegmentStats(seg, split[seg], w.days * (seg === "CAL" ? 0.6 : 0.2)));
  }

  // variant under test = newest (ADV v1.2.0); reference = BASELINE v1.0.0
  const vVal = segments[TEST_VARIANT.id][1];
  const bVal = segments[BASELINE_VARIANT.id][1];
  const { checks, verdict: valVerdict } = evaluateThresholds(vVal, bVal);

  /* ---- FREQUENCY GUARD: full-run closed trades must stay ≥ max(0.8 × baseline, 50) ---- */
  const baselineTrades = fullRun[BASELINE_VARIANT.id];
  const advTrades = fullRun[TEST_VARIANT.id];
  const floor = freqFloor(baselineTrades);
  const guardPass = advTrades >= floor;
  const freqGuard = { baselineTrades, advTrades, floor: Number(floor.toFixed(1)), pass: guardPass };
  checks.push({
    id: "T5",
    label: `FREQUENCY GUARD — full-run trades ≥ max(0.8 × baseline, 50)`,
    detail: `${advTrades} adv vs ${baselineTrades} baseline · floor ${floor.toFixed(1)}`,
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
    elapsedMs: performance.now() - t0,
  };
}

/**
 * Full benchmark: 4 windows × 2 variants, identical candles per window,
 * chronological 60/20/20 (CAL/VAL/OOS, OOS touched once), thresholds on VAL.
 */
export async function runBenchmark(
  log: Log,
  onWindow: (report: BenchWindowReport, index: number) => void,
  onRunProgress?: (windowIndex: number, pct: number) => void,
  isAborted?: () => boolean,
): Promise<BenchReport> {
  const t0 = performance.now();
  const report: BenchReport = { ranAt: Date.now(), elapsedMs: 0, aborted: false, windows: [] };
  for (let wi = 0; wi < BENCH_WINDOWS.length; wi++) {
    if (isAborted?.()) { report.aborted = true; break; }
    try {
      const wr = await runBenchWindow(BENCH_WINDOWS[wi], log, (p) => onRunProgress?.(wi, p));
      report.windows.push(wr);
      saveBenchReport(report);
      onWindow(wr, wi);
    } catch (e) {
      log(`window ${BENCH_WINDOWS[wi].label} failed: ${e instanceof Error ? e.message : "unknown"}`, "err");
      report.aborted = true;
      break;
    }
  }
  report.elapsedMs = performance.now() - t0;
  report.ranAt = Date.now();
  saveBenchReport(report);
  return report;
}
