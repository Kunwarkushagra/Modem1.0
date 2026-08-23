import type { AnalyzeParams, BacktestResult, BacktestTrade, PerformanceSummary } from "./types";
import { fetchHistory } from "./marketData";
import { computeIndicators } from "./indicators";
import { analyzeSMC } from "./smc";
import { deriveBias, localSetups, validateSetup } from "./ai";
import type { EngineCtx } from "./ai";

type Log = (msg: string, kind?: "info" | "ok" | "warn" | "err") => void;

const EMPTY_PERF: PerformanceSummary = {
  total: 0, wins: 0, losses: 0, breakeven: 0, winRate: 0, avgWinPct: 0, avgLossPct: 0,
  profitFactor: 0, sharpe: 0, maxDrawdown: 0, bestConfluences: [], worstConfluences: [],
  recent: { trades: 0, winRate: 0, tilt: false }, equity: [100],
};

export async function runBacktest(
  params: { symbol: string; assetType: AnalyzeParams["assetType"]; timeframe: AnalyzeParams["timeframe"]; days: number },
  log: Log,
  onProgress?: (pct: number) => void,
): Promise<BacktestResult> {
  const t0 = performance.now();
  const hist = await fetchHistory(params.symbol, params.assetType, params.timeframe, params.days, log);
  const candles = hist.candles;
  const lookback = 220;
  const forwardMax = 60;
  const end = candles.length - 20;
  const step = Math.max(4, Math.round(candles.length / 160));

  log(`walk-forward: ${candles.length} candles · window ${lookback} · step ${step}`);
  const trades: BacktestTrade[] = [];
  let skippedInvalid = 0;
  let cooldownUntil = -1;
  let open: BacktestTrade | null = null;
  let openSl = 0, openTp1 = 0, openTp2 = 0, openEntry = 0, openRisk = 0, trailing = false, openEndI = 0;

  const closeOpen = (t: BacktestTrade, outcome: BacktestTrade["outcome"], pnlR: number, i: number) => {
    t.outcome = outcome; t.pnlR = Number(pnlR.toFixed(2));
    trades.push(t);
    cooldownUntil = i + 3;
    open = null;
  };

  const totalSteps = Math.max(1, Math.floor((end - lookback) / step));
  let stepCount = 0;

  for (let i = lookback; i < end; i += step) {
    stepCount++;
    if (stepCount % 8 === 0) {
      onProgress?.(Math.round((stepCount / totalSteps) * 100));
      await new Promise((r) => setTimeout(r, 0));
    }

    // manage open trade candle by candle inside the step gap
    if (open) {
      for (let j = openEndI; j <= Math.min(i + step, candles.length - 1); j++) {
        const c = candles[j];
        const long = open.direction === "Long";
        const hitSl = long ? c.l <= openSl : c.h >= openSl;
        const hitTp1 = long ? c.h >= openTp1 : c.l <= openTp1;
        const hitTp2 = long ? c.h >= openTp2 : c.l <= openTp2;
        if (hitTp2 && (!hitSl || trailing)) { closeOpen(open, "win", Math.abs(openTp2 - openEntry) / openRisk, j); break; }
        if (hitSl) { closeOpen(open, trailing ? "breakeven" : "loss", trailing ? 0 : -1, j); break; }
        if (hitTp1 && !trailing) { trailing = true; openSl = openEntry; }
        if (trailing && (long ? c.l <= openEntry : c.h >= openEntry)) { closeOpen(open, "breakeven", 0, j); break; }
        if (j - (open.i) >= forwardMax) {
          const pnl = ((c.c - openEntry) / openRisk) * (long ? 1 : -1);
          closeOpen(open, pnl > 0.1 ? "win" : pnl < -0.1 ? "loss" : "breakeven", Math.max(-1, pnl), j);
          break;
        }
      }
      if (open) { openEndI = Math.min(i + step + 1, candles.length - 1); continue; }
    }
    if (i <= cooldownUntil) continue;

    const window = candles.slice(0, i + 1);
    const ind = computeIndicators(window);
    const smc = analyzeSMC(window);
    const bias = deriveBias(smc, ind, window);
    const ctx: EngineCtx = {
      params: { symbol: params.symbol, assetType: params.assetType, timeframe: params.timeframe, accountSize: 10000, riskPercent: 1 },
      candles: window, ind, smc, htfSmc: smc, htfBias: bias, perf: EMPTY_PERF, newsCount: 0,
    };
    const raw = localSetups(ctx).slice(0, 1);
    if (!raw.length) continue;
    const { setup, checks } = validateSetup(raw[0], ctx);
    if (!checks.every((c) => c.passed)) { skippedInvalid++; continue; }

    const risk = Math.abs(setup.entry_price - setup.stop_loss);
    if (risk <= 0) continue;
    open = {
      i, t: candles[i].t, direction: setup.direction,
      entry: setup.entry_price, sl: setup.stop_loss, tp1: setup.take_profit1, tp2: setup.take_profit2,
      rr: setup.risk_reward_ratio, outcome: "breakeven", pnlR: 0, confluences: setup.confluences,
    };
    openEntry = setup.entry_price; openSl = setup.stop_loss; openTp1 = setup.take_profit1; openTp2 = setup.take_profit2;
    openRisk = risk; trailing = false; openEndI = i + 1;
  }
  onProgress?.(100);

  // force-close anything still open at the last candle
  if (open) {
    const c = candles[candles.length - 1];
    const long = open.direction === "Long";
    const pnl = ((c.c - openEntry) / openRisk) * (long ? 1 : -1);
    closeOpen(open, pnl > 0.1 ? "win" : pnl < -0.1 ? "loss" : "breakeven", Math.max(-1, pnl), candles.length - 1);
  }

  const wins = trades.filter((t) => t.outcome === "win");
  const losses = trades.filter((t) => t.outcome === "loss");
  const grossW = wins.reduce((s, t) => s + t.pnlR, 0);
  const grossL = Math.abs(losses.reduce((s, t) => s + t.pnlR, 0));
  const decided = wins.length + losses.length;
  const equityR: number[] = [0];
  for (const t of trades) equityR.push(Number((equityR[equityR.length - 1] + t.pnlR).toFixed(2)));
  let peak = 0, maxDD = 0;
  for (const e of equityR) { peak = Math.max(peak, e); maxDD = Math.max(maxDD, peak - e); }
  const rets = trades.map((t) => t.pnlR);
  const mean = rets.length ? rets.reduce((a, b) => a + b, 0) / rets.length : 0;
  const sd = rets.length > 1 ? Math.sqrt(rets.reduce((s, r) => s + (r - mean) ** 2, 0) / (rets.length - 1)) : 0;

  log(`backtest done: ${trades.length} trades · WR ${decided ? ((wins.length / decided) * 100).toFixed(0) : 0}% · net ${equityR[equityR.length - 1].toFixed(1)}R`, "ok");

  return {
    params,
    totalCandles: candles.length,
    trades,
    skippedInvalid,
    winRate: decided ? (wins.length / decided) * 100 : 0,
    profitFactor: grossL > 0 ? grossW / grossL : grossW > 0 ? 99 : 0,
    expectancyR: mean,
    maxDrawdownR: maxDD,
    sharpe: sd > 0 ? mean / sd : 0,
    netR: equityR[equityR.length - 1] ?? 0,
    equityR,
    durationMs: performance.now() - t0,
    dataSource: hist.source,
  };
}
