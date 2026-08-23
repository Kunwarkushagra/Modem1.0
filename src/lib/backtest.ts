import type {
  AnalyzeParams, BacktestResult, BacktestTrade, CostModel, ExpiryLogItem, PerformanceSummary, SignalType, TradeOutcome,
} from "./types";
import { fetchHistory } from "./marketData";
import { computeIndicators } from "./indicators";
import { analyzeSMC } from "./smc";
import { deriveBias, localSetups, validateSetup } from "./ai";
import type { EngineCtx } from "./ai";
import { TF_MINUTES } from "./utils";

type Log = (msg: string, kind?: "info" | "ok" | "warn" | "err") => void;

/** SCALP-1.0 honest cost model — charged on EVERY trade, BOTH legs */
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

export async function runBacktest(
  params: { symbol: string; assetType: AnalyzeParams["assetType"]; timeframe: AnalyzeParams["timeframe"]; days: number },
  log: Log,
  onProgress?: (pct: number) => void,
): Promise<BacktestResult> {
  const t0 = performance.now();
  const hist = await fetchHistory(params.symbol, params.assetType, params.timeframe, params.days, log);
  const candles = hist.candles;
  const stepMs = TF_MINUTES[params.timeframe] * 60_000;
  const lookback = 220;
  const forwardMax = 60;
  const end = candles.length - 2; // confirmed candles only: never analyze/enter on the forming candle
  const step = Math.max(4, Math.round(candles.length / 160));

  log(`walk-forward: ${candles.length} candles · confirmed-only · costs ${COSTS.makerPct * 100}%/${COSTS.takerPct * 100}%+${COSTS.slippagePct * 100}% slip`);

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

  const closeOpen = (t: BacktestTrade, exitPrice: number, i: number) => {
    const long = t.direction === "Long";
    const grossR = ((exitPrice - openFill) / openRisk) * (long ? 1 : -1);
    const feesR = (openFill * COSTS.entryPct + exitPrice * COSTS.exitPct) / openRisk;
    const netR = grossR - feesR;
    const outcome: TradeOutcome = netR > 0.01 ? "win" : netR < -0.01 ? "loss" : "breakeven";
    t.grossR = Number(grossR.toFixed(3));
    t.feesR = Number(feesR.toFixed(3));
    t.pnlR = Number(netR.toFixed(3));
    t.outcome = outcome;
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
        const hitSl = long ? c.l <= openSl : c.h >= openSl;
        const hitTp1 = long ? c.h >= openTp1 : c.l <= openTp1;
        const hitTp2 = long ? c.h >= openTp2 : c.l <= openTp2;
        if (hitTp2 && (!hitSl || trailing)) { closeOpen(open, openTp2, i); }
        else if (hitSl) { closeOpen(open, trailing ? openFill : openSl, i); }
        else if (hitTp1 && !trailing) { trailing = true; openSl = openFill; }
        if (open && trailing && (long ? c.l <= openFill : c.h >= openFill)) { closeOpen(open, openFill, i); }
        if (open && i - openStartI >= forwardMax) { closeOpen(open, c.c, i); }
      }
      continue;
    }

    /* ---------- pending signal: validity + trigger ---------- */
    if (pending) {
      const p = pending;
      const long = p.setup.direction === "Long";

      // event expiry (per candle)
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

      // trigger: price reaches entry; entry allowed only if trigger candle CLOSE <= validTill
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
        };
        openFill = fill; openSl = sl; openTp1 = tp1; openTp2 = tp2; openRisk = risk;
        trailing = false; openStartI = i; manageFromI = i;
        funnel.entered++;
        pending = null; triggered = false;
        // manage this fill candle immediately (conservative: SL checked intra-candle)
        const long2 = open.direction === "Long";
        if (long2 ? c.l <= openSl : c.h >= openSl) closeOpen(open, openSl, i);
        else if (long2 ? c.h >= openTp2 : c.l <= openTp2) closeOpen(open, openTp2, i);
        else if ((long2 ? c.h >= openTp1 : c.l <= openTp1)) { trailing = true; openSl = openFill; }
      }
      continue;
    }

    /* ---------- idle: generate on cadence ---------- */
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
  if (open) closeOpen(open, candles[end - 1]?.c ?? openFill, end - 1);

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
  const mean = rets.length ? rets.reduce((a, b) => a + b, 0) / rets.length : 0;
  const sd = rets.length > 1 ? Math.sqrt(rets.reduce((s, r) => s + (r - mean) ** 2, 0) / (rets.length - 1)) : 0;

  const netR = equityR[equityR.length - 1] ?? 0;
  const grossR = trades.reduce((s, t) => s + t.grossR, 0);
  log(`done: ${funnel.generated} signals → ${funnel.expiredBeforeTrigger} expired pre-trigger → ${funnel.entered} entries · NET ${netR.toFixed(2)}R (gross ${grossR.toFixed(2)}R)`, "ok");

  return {
    params,
    totalCandles: candles.length,
    trades,
    skippedInvalid,
    funnel,
    expiryLog: expiryLog.slice(-20).reverse(),
    costs: COSTS,
    winRate: decided ? (wins.length / decided) * 100 : 0,
    profitFactor: grossL > 0 ? grossW / grossL : grossW > 0 ? 99 : 0,
    expectancyR: mean,
    maxDrawdownR: maxDD,
    sharpe: sd > 0 ? mean / sd : 0,
    netR,
    grossR,
    equityR,
    durationMs: performance.now() - t0,
    dataSource: hist.source,
  };
}
