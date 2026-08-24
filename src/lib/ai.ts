import type {
  AnalysisResult, AnalyzeParams, Bias, Candle, IndicatorSet, KeyLevel, PerformanceSummary,
  PositionSizing, Reasoning, Settings, SignalInfo, SignalType, SMCAnalysis, StructureEvent, Timeframe, TradeSetup, ValidationCheck,
} from "./types";
import { fetchCandles } from "./marketData";
import { computeIndicators } from "./indicators";
import { analyzeSMC } from "./smc";
import { fetchNews, fetchSentiment } from "./news";
import { computePerformance, performancePromptBlock } from "./performance";
import { loadTrades } from "./journal";
import { detectSession, fmtIST, fmtPrice, HTF_MAP, last, lastValid, LTF_MAP, TF_MINUTES, uid } from "./utils";

type Log = (msg: string, kind?: "info" | "ok" | "warn" | "err") => void;

export interface RawSetup {
  direction: "Long" | "Short";
  entry_price: number;
  stop_loss: number;
  take_profit1: number;
  take_profit2: number;
  estimated_win_rate_percent: number;
  confidence_score_0_100: number;
  invalidation_level: number;
  trade_rationale: string;
  confluences: string[];
  news_caution: string | null;
  risk_management_note: string | null;
  isBreakout?: boolean;
  /** true when the TP comes from a real detected level (pool/SR/range extreme), false when floored to a pure R multiple */
  tp1Objective?: boolean;
  tp2Objective?: boolean;
}

export interface EngineSetup extends RawSetup {
  reasoning: Reasoning;
  signal: SignalInfo;
}

interface AIEnvelope {
  htf_bias?: Bias; stf_bias?: Bias; ltf_bias?: Bias;
  summary?: string; self_learning_note?: string; news_summary?: string;
  key_levels?: KeyLevel[]; liquidity_pools?: Array<{ side: "buy" | "sell"; price: number }>;
  setups?: RawSetup[];
}

/** SCALP-1.0 validity windows, in setup-timeframe candles */
export const VALID_CANDLES: Record<SignalType, number> = { sweep: 15, zone: 30, structure: 45 };

/* ---------------- bias derivation ---------------- */

export function deriveBias(smc: SMCAnalysis, ind: IndicatorSet, candles: Candle[]): Bias {
  let score = 0;
  if (smc.trend === "bull") score += 2;
  if (smc.trend === "bear") score -= 2;
  const e50 = lastValid(ind.ema50), e200 = lastValid(ind.ema200), r = lastValid(ind.rsi);
  const hist = lastValid(ind.macdHist), vw = lastValid(ind.vwap);
  const price = last(candles)?.c ?? 0;
  if (isFinite(e50) && isFinite(e200)) score += e50 > e200 ? 1 : -1;
  if (isFinite(hist)) score += hist > 0 ? 1 : -1;
  if (isFinite(r)) score += r > 56 ? 1 : r < 44 ? -1 : 0;
  if (isFinite(vw) && price) score += price > vw ? 0.5 : -0.5;
  const recent = smc.structure.slice(-2);
  for (const ev of recent) score += ev.dir === "bull" ? 1 : -1;
  if (score >= 2) return "bullish";
  if (score <= -2) return "bearish";
  return "ranging";
}

export function biasRationale(smc: SMCAnalysis, ind: IndicatorSet, candles: Candle[]): string {
  const parts: string[] = [];
  parts.push(`trend=${smc.trend}`);
  const e50 = lastValid(ind.ema50), e200 = lastValid(ind.ema200), r = lastValid(ind.rsi);
  const hist = lastValid(ind.macdHist), vw = lastValid(ind.vwap);
  const price = last(candles)?.c ?? 0;
  if (isFinite(e50) && isFinite(e200)) parts.push(e50 > e200 ? "EMA50>EMA200" : "EMA50<EMA200");
  if (isFinite(hist)) parts.push(hist > 0 ? "MACD hist>0" : "MACD hist<0");
  if (isFinite(r)) parts.push(`RSI ${r.toFixed(0)}`);
  if (isFinite(vw) && price) parts.push(price > vw ? "close>VWAP" : "close<VWAP");
  const ev = smc.structure.slice(-1)[0];
  if (ev) parts.push(`last ${ev.type} ${ev.dir}`);
  return `${deriveBias(smc, ind, candles)} — ${parts.join(", ")}`;
}

/* ---------------- exact analysis prompt ---------------- */

const SYSTEM_PROMPT = `You are a highly selective institutional trader with 15+ years of experience in Price Action, Advanced Smart Money Concepts (SMC), Advanced ICT, Institutional Order Flow (IOC), and Liquidity/SL Hunting. You are also a self-learning trader who improves after every trade. You will receive:
1) Selected Timeframe (STF) OHLCV + indicators.
2) Higher Timeframe (HTF) OHLCV + indicators.
3) Lower Timeframe (LTF) OHLCV + indicators.
4) Advanced SMC/ICT/Price Action/SL Hunting detected levels (market structure, order blocks, fair value gaps, imbalances, liquidity pools, inducement, premium/discount, SL hunting zones, candlestick patterns, support/resistance, trendlines, channels, false breakout signals).
5) Live news headlines (top 5) for the asset.
6) Your past trade performance summary (trade count, win rate, best/worst confluences, recent results).

Analyze deeply:
- HTF bias: bullish/bearish/ranging, key HTF levels.
- STF structure: BOS, CHoCH, order blocks, FVG, imbalances, supply/demand, liquidity pools, stop hunts, inducement, premium/discount, candlestick patterns, trendlines, channels.
- LTF: entry precision levels, recent price action near key levels.
- Indicators: RSI, EMA, MACD, Bollinger Bands, Stochastic RSI, VWAP, ADX, ATR, volume.

Use the provided levels and patterns. A valid setup MUST have at least 2 of the following confluences aligned:
- Entry at or near an Order Block, FVG, or support/resistance level
- Liquidity sweep / SL hunting just before entry
- CHoCH or BOS confirmation with volume
- Price in premium/discount zone supporting direction
- A clear candlestick pattern (pin bar, engulfing, etc.) at the level
- Volume confirmation (above average on breakout/entry candle)
- False breakout filter satisfied (if setup is a breakout)

Also use past performance to adapt:
- Identify which confluences and setups worked well and which failed.
- Prefer setups that match historically winning patterns.
- Avoid setups that match losing patterns.
- Adjust confidence score and win rate estimate based on actual results.
- Balance: Do not be so strict that you rarely give trades. Aim for 1-3 quality setups per week per asset if market conditions allow, but do not force trades. Quality over quantity, but not over-filtering.

Live news should be treated as a side factor: if there is major upcoming news (e.g., FOMC, CPI, earnings, etc.) that could cause high volatility, mention it in the summary and add a caution note. Do not let news override technical analysis unless it is extreme. In trade rationale, if relevant, mention potential news risk.

Generate up to 2 trade setups with strict rules:
- RR >= 2.0
- Estimated win rate >= 60%
- At least 2 confluences from above
- Must pass false breakout filters
- If no setup meets criteria, return empty setups and say 'No high-probability setup found based on current data and past performance.'
- Be realistic, not optimistic.

For each valid setup, provide:
- direction: Long/Short
- entry_price
- stop_loss
- take_profit1
- take_profit2
- risk_reward_ratio
- estimated_win_rate_percent
- confidence_score_0_100
- invalidation_level
- trade_rationale: explain confluences across timeframes, indicators, SMC/ICT/Price Action levels (must mention at least two specific concepts)
- confluences: list of concepts (e.g., "Order Block", "Fair Value Gap", "Liquidity Sweep", "CHoCH", "Pin Bar", "Volume Confirmation")
- news_caution: if any major news risk, note; else null
- risk_management_note: brief suggestion if account info provided, else null

Also provide:
- key_levels: array of objects {type: string, price: number, description: string} (includes SMC/ICT/Price Action levels)
- liquidity_pools: array of objects {side: "buy"|"sell", price: number}
- news_summary: brief note on current news relevance.

Return JSON in this exact schema:
{
  "htf_bias": "bullish|bearish|ranging",
  "stf_bias": "bullish|bearish|ranging",
  "ltf_bias": "bullish|bearish|ranging",
  "summary": "string",
  "self_learning_note": "string",
  "key_levels": [
    {"type": "Bullish Order Block", "price": 0, "description": "string"}
  ],
  "liquidity_pools": [
    {"side": "buy", "price": 0}
  ],
  "news_summary": "string",
  "setups": [
    {
      "direction": "Long",
      "entry_price": 0,
      "stop_loss": 0,
      "take_profit1": 0,
      "take_profit2": 0,
      "risk_reward_ratio": 0,
      "estimated_win_rate_percent": 0,
      "confidence_score_0_100": 0,
      "invalidation_level": 0,
      "trade_rationale": "string",
      "confluences": ["string"],
      "news_caution": "string or null",
      "risk_management_note": "string or null"
    }
  ]
}
If no setups, setups array should be empty.`;

function packCandles(candles: Candle[], count: number, tf: string): string {
  const rows = candles.slice(-count).map((c) =>
    `${new Date(c.t).toISOString().slice(0, 16)},${c.o.toPrecision(7)},${c.h.toPrecision(7)},${c.l.toPrecision(7)},${c.c.toPrecision(7)},${Math.round(c.v)}`
  );
  return `${tf} OHLCV (t,o,h,l,c,v), last ${rows.length}:\n` + rows.join("\n");
}

function packIndicators(ind: IndicatorSet, tf: string): string {
  const L = (a: number[]) => lastValid(a).toFixed(4);
  return `${tf} indicators(last): RSI ${L(ind.rsi)} | EMA50 ${L(ind.ema50)} | EMA200 ${L(ind.ema200)} | MACD ${L(ind.macd)} sig ${L(ind.macdSignal)} hist ${L(ind.macdHist)} | ATR ${L(ind.atr)} | BB ${L(ind.bbLower)}–${L(ind.bbUpper)} | StochRSI K ${L(ind.stochK)} D ${L(ind.stochD)} | VWAP ${L(ind.vwap)} | ADX ${L(ind.adx)}`;
}

function packSMC(smc: SMCAnalysis, label: string): string {
  const lines: string[] = [`${label} SMC/ICT/PA levels:`];
  lines.push(`- Structure: trend=${smc.trend}; events: ${smc.structure.slice(-5).map((e) => `${e.type}(${e.dir})@${e.level.toPrecision(6)}`).join(", ") || "none"}`);
  lines.push(`- Swing points(last 8): ${smc.swings.filter((s) => s.major).slice(-8).map((s) => `${s.kind}@${s.price.toPrecision(6)}`).join(", ")}`);
  const z = smc.zones.filter((x) => x.active).slice(-8);
  lines.push(`- Active zones: ${z.map((x) => `${x.kind}[${x.bottom.toPrecision(6)}–${x.top.toPrecision(6)}]${x.mitigated ? "(partial)" : ""}`).join(", ") || "none"}`);
  lines.push(`- Liquidity pools: ${smc.liquidity.slice(0, 8).map((p) => `${p.side} ${p.kind}@${p.price.toPrecision(6)}(x${p.touches})`).join(", ") || "none"}`);
  lines.push(`- Recent sweeps: ${smc.sweeps.slice(-4).map((s) => `${s.side}-side@${s.price.toPrecision(6)}`).join(", ") || "none"}`);
  lines.push(`- Premium/Discount: range ${smc.pd.rangeLow.toPrecision(6)}–${smc.pd.rangeHigh.toPrecision(6)}; eq ${smc.pd.eq.toPrecision(6)}; current position: ${smc.pd.position}`);
  lines.push(`- Patterns(last): ${smc.patterns.slice(-6).map((p) => `${p.name}(${p.dir})`).join(", ") || "none"}`);
  lines.push(`- S/R: ${smc.sr.map((s) => `${s.kind}@${s.price.toPrecision(6)}(t${s.touches})`).join(", ") || "none"}`);
  lines.push(`- Breakouts: ${smc.breakouts.map((b) => `${b.dir}@${b.level.toPrecision(6)}=${b.state}(vol ${b.volOk ? "ok" : "low"}, ${b.closesBeyond} closes)`).join(", ") || "none"}`);
  return lines.join("\n");
}

export function buildPrompt(ctx: {
  params: AnalyzeParams; stf: Candle[]; htf: Candle[]; ltf: Candle[];
  indStf: IndicatorSet; indHtf: IndicatorSet; indLtf: IndicatorSet;
  smcStf: SMCAnalysis; smcHtf: SMCAnalysis; perf: PerformanceSummary;
  news: Array<{ title: string; source: string; publishedAt: number }>;
}): string {
  const { params } = ctx;
  const parts: string[] = [SYSTEM_PROMPT, "\n--- LIVE DATA ---", `Symbol: ${params.symbol} | Asset: ${params.assetType} | STF: ${params.timeframe} | HTF: ${HTF_MAP[params.timeframe]} | LTF: ${LTF_MAP[params.timeframe]}`];
  parts.push(packCandles(ctx.stf, 80, "STF " + params.timeframe));
  parts.push(packIndicators(ctx.indStf, "STF"));
  parts.push(packCandles(ctx.htf, 40, "HTF " + HTF_MAP[params.timeframe]));
  parts.push(packIndicators(ctx.indHtf, "HTF"));
  parts.push(packCandles(ctx.ltf, 40, "LTF " + LTF_MAP[params.timeframe]));
  parts.push(packIndicators(ctx.indLtf, "LTF"));
  parts.push(packSMC(ctx.smcStf, "STF"));
  parts.push(packSMC(ctx.smcHtf, "HTF"));
  parts.push("LIVE NEWS (top 5):");
  parts.push(ctx.news.length ? ctx.news.map((n2, i) => `${i + 1}. [${n2.source}] ${n2.title}`).join("\n") : "(no news reachable)");
  parts.push(`Account: size $${params.accountSize}, risk per trade ${params.riskPercent}%.`);
  parts.push(performancePromptBlock(ctx.perf));
  parts.push("\nReturn ONLY the JSON object, no markdown fences.");
  return parts.join("\n\n");
}

/* ---------------- providers ---------------- */

const PROVIDER_CFG: Record<string, { url: string; model: string }> = {
  openai: { url: "https://api.openai.com/v1/chat/completions", model: "gpt-4o" },
  qwen: { url: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions", model: "qwen-max" },
  openrouter: { url: "https://openrouter.ai/api/v1/chat/completions", model: "anthropic/claude-sonnet-4" },
};

export async function callAIProvider(settings: Settings, prompt: string): Promise<string> {
  if (settings.provider === "anthropic") {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": settings.apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify({
        model: settings.model || "claude-3-5-sonnet-latest",
        max_tokens: 3000,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!res.ok) throw new Error(`Claude ${res.status}: ${(await res.text()).slice(0, 140)}`);
    const j = (await res.json()) as { content?: Array<{ text?: string }> };
    return j.content?.map((c) => c.text ?? "").join("") ?? "";
  }
  const cfg = PROVIDER_CFG[settings.provider] ?? PROVIDER_CFG.openai;
  const res = await fetch(cfg.url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${settings.apiKey}` },
    body: JSON.stringify({
      model: settings.model || cfg.model,
      temperature: 0.2,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!res.ok) throw new Error(`${settings.provider} ${res.status}: ${(await res.text()).slice(0, 140)}`);
  const j = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  return j.choices?.[0]?.message?.content ?? "";
}

function parseAIJson(raw: string): AIEnvelope {
  let text = raw.trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) text = fence[1];
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("AI returned no JSON object");
  return JSON.parse(text.slice(start, end + 1)) as AIEnvelope;
}

/* ---------------- deterministic local engine ---------------- */

export interface EngineCtx {
  params: AnalyzeParams;
  candles: Candle[];
  ind: IndicatorSet;
  smc: SMCAnalysis;
  htfSmc: SMCAnalysis;
  htfInd: IndicatorSet;
  htfCandles: Candle[];
  htfBias: Bias;
  perf: PerformanceSummary;
  newsCount: number;
  generatedAt: number;  // UTC ms of confirming candle close
  stepMs: number;
}

function rrOf(e: number, sl: number, tp: number): number {
  const risk = Math.abs(e - sl);
  return risk > 0 ? Math.abs(tp - e) / risk : 0;
}

function makeSignal(type: SignalType, ctx: EngineCtx, o: { reclaimLevel: number | null; zoneTop?: number | null; zoneBottom?: number | null }): SignalInfo {
  const validCandles = VALID_CANDLES[type];
  const validTillTs = ctx.generatedAt + validCandles * ctx.stepMs;
  const rules =
    type === "sweep"
      ? "EXPIRES: sweep level reclaimed against direction · 15 setup-candles"
      : type === "zone"
        ? "EXPIRES: zone fully mitigated · touched twice pre-trigger · 30 setup-candles"
        : "EXPIRES: opposite BOS/CHoCH · level reclaimed · 45 setup-candles";
  return {
    type,
    generatedAt: ctx.generatedAt,
    displayTimeIST: fmtIST(ctx.generatedAt),
    validCandles,
    validTillTs,
    stepMs: ctx.stepMs,
    reclaimLevel: o.reclaimLevel,
    zoneTop: o.zoneTop ?? null,
    zoneBottom: o.zoneBottom ?? null,
    expiryRules: rules,
  };
}

const ENTRY_MODEL = "Execution: confirmed candles only. Backtest fills at NEXT candle OPEN after the trigger candle closes (SL/TP shifted by fill delta). Live paper: limit order at the level.";

function gradeLiquidity(touches: number): "A" | "B" | "C" { return touches >= 3 ? "A" : touches === 2 ? "B" : "C"; }

function buildReasoning(
  ctx: EngineCtx,
  direction: "Long" | "Short",
  o: { zone?: { kind: string; top: number; bottom: number; startI: number; mitigated: boolean } | null; sweepI?: number | null; sweepPrice?: number | null; pool?: { kind: string; touches: number; price: number } | null; structEv?: { type: "BOS" | "CHoCH"; dir: "bull" | "bear"; ts: number; level: number } | null; entry: number; plannedRR: number; isBreakout?: boolean; pattern?: { name: string; factor: number } | null },
): Reasoning {
  const atrV = lastValid(ctx.ind.atr) || 1;
  const session = detectSession(ctx.generatedAt);
  // adv v1.2.0: sweep event carries soft classifications (dryUp / fakeoutReversal / amdPhase) when detected
  const sweepEvent = o.sweepI != null ? ctx.smc.sweeps.find((s) => s.i === o.sweepI) ?? null : null;
  const sweep = (() => {
    if (o.sweepI == null || o.sweepPrice == null) return null;
    const sc = ctx.candles[o.sweepI];
    if (!sc) return null;
    const depthAtr = Number((Math.abs(o.sweepPrice - (direction === "Long" ? sc.l : sc.h)) / atrV).toFixed(2));
    const reclaim = direction === "Long" ? sc.c > o.sweepPrice : sc.c < o.sweepPrice;
    let disp = 0;
    for (let j = o.sweepI + 1; j <= Math.min(o.sweepI + 3, ctx.candles.length - 1); j++) {
      disp = Math.max(disp, Math.abs(ctx.candles[j].c - ctx.candles[j].o));
    }
    const displacementAtr = Number((disp / atrV).toFixed(2));
    // adv v1.2.0 soft layer: volume dry-up before the sweep adds +5 to trap score (capped 100)
    const dryUp = sweepEvent?.dryUp === true;
    const base = 40 * Math.min(1, depthAtr / 0.8) + 30 * (reclaim ? 1 : 0.2) + 30 * Math.min(1, displacementAtr / 1.2);
    const trapScore = Math.round(Math.min(100, base + (dryUp ? 5 : 0)));
    // eff2-slg v1.0.0 (Part A/B, ranking-only facts): how far the sweep candle closed back beyond the level
    const reclaimStrengthAtr = reclaim ? Number((Math.abs(sc.c - o.sweepPrice!) / atrV).toFixed(2)) : 0;
    const reclaimFast = reclaimStrengthAtr >= 0.2; // decisive reclaim → trap/speed credit in eff2 bucket
    return { depthAtr, reclaim, displacementAtr, trapScore, dryUp, fakeoutReversal: sweepEvent?.fakeoutReversal === true, reclaimStrengthAtr, reclaimFast };
  })();
  const zone = (() => {
    if (!o.zone) return null;
    const age = ctx.candles.length - 1 - o.zone.startI;
    const grade: "A" | "B" = !o.zone.mitigated && age <= 40 ? "A" : "B";
    const mid = (o.zone.top + o.zone.bottom) / 2;
    return { kind: o.zone.kind, grade, distanceAtr: Number((Math.abs(o.entry - mid) / atrV).toFixed(2)) };
  })();
  // eff2-slg v1.0.0 (Part A, ranking-only): pool significance = touches×25 + equal-cluster 20, cap 100 (≥60 earns a boost)
  const liquidity = o.pool
    ? {
        grade: gradeLiquidity(o.pool.touches),
        source: `${o.pool.kind.replace("_", " ")} ×${o.pool.touches}`,
        distanceAtr: Number((Math.abs(o.pool.price - o.entry) / atrV).toFixed(2)),
        significance: Math.min(100, o.pool.touches * 25 + (o.pool.kind.startsWith("equal") ? 20 : 0)),
      }
    : null;
  return {
    htfBias: ctx.htfBias,
    htfRationale: biasRationale(ctx.htfSmc, ctx.htfInd, ctx.htfCandles),
    liquidity, sweep,
    structureEvent: o.structEv ?? null,
    zone, session,
    plannedRR: o.plannedRR,
    entryModel: ENTRY_MODEL,
    rejectionReason: null,
    patternCtx: o.pattern ?? null,                    // adv v1.2.0: pattern location quality
    amdPhase: sweepEvent?.amdPhase ?? null,           // adv v1.2.0: AMD manipulation tag
  };
}

export function localSetups(ctx: EngineCtx): EngineSetup[] {
  const { candles, ind, smc, params } = ctx;
  const n = candles.length;
  const price = last(candles).c;
  const atrV = lastValid(ind.atr);
  if (!isFinite(atrV) || atrV <= 0) return [];
  const out: EngineSetup[] = [];
  const htfAlignBull = ctx.htfBias === "bullish" || smc.trend === "bull";
  const htfAlignBear = ctx.htfBias === "bearish" || smc.trend === "bear";
  const recentSweepSell = smc.sweeps.filter((s) => s.side === "sell" && s.i >= n - 8).slice(-1)[0];
  const recentSweepBuy = smc.sweeps.filter((s) => s.side === "buy" && s.i >= n - 8).slice(-1)[0];
  const chochBull = smc.structure.filter((e) => e.dir === "bull" && e.i >= n - 30).slice(-1)[0];
  const chochBear = smc.structure.filter((e) => e.dir === "bear" && e.i >= n - 30).slice(-1)[0];
  const patternBull = smc.patterns.filter((p) => p.dir === "bull" && p.i >= n - 6).slice(-1)[0];
  const patternBear = smc.patterns.filter((p) => p.dir === "bear" && p.i >= n - 6).slice(-1)[0];
  const inDiscount = smc.pd.position === "discount";
  const inPremium = smc.pd.position === "premium";
  const breakoutBull = smc.breakouts.filter((b) => b.dir === "bull" && b.state === "confirmed").slice(-1)[0];
  const breakoutBear = smc.breakouts.filter((b) => b.dir === "bear" && b.state === "confirmed").slice(-1)[0];
  const volAbove = isFinite(lastValid(ind.volMA)) && last(candles).v > lastValid(ind.volMA);
  const lastStruct = smc.structure.slice(-1)[0] ?? null;
  const session = detectSession(ctx.generatedAt);

  const bullZones = smc.zones.filter((z) => (z.kind === "bull_ob" || z.kind === "bull_fvg" || z.kind === "breaker_bull") && z.active && z.top <= price + 0.35 * atrV && z.bottom >= price - 2.6 * atrV).sort((a, b) => b.top - a.top);
  const bearZones = smc.zones.filter((z) => (z.kind === "bear_ob" || z.kind === "bear_fvg" || z.kind === "breaker_bear") && z.active && z.bottom >= price - 0.35 * atrV && z.top <= price + 2.6 * atrV).sort((a, b) => a.bottom - b.bottom);
  const buyLiq = smc.liquidity.filter((p) => p.side === "buy" && p.price > price).sort((a, b) => a.price - b.price);
  const sellLiq = smc.liquidity.filter((p) => p.side === "sell" && p.price < price).sort((a, b) => b.price - a.price);
  const resist = smc.sr.filter((s) => s.kind === "resistance" && s.price > price).sort((a, b) => a.price - b.price);
  const support = smc.sr.filter((s) => s.kind === "support" && s.price < price).sort((a, b) => b.price - a.price);

  // adv v1.2.0 soft layer: a candlestick pattern far from any valid zone counts as half a confluence
  // in the quality score only — the entry gates still see the full confluence list (no vetoes added).
  const boost = (conf: string[], farPattern = false) => {
    const eff = conf.length - (farPattern ? 0.5 : 0);
    let w = 58 + 4 * Math.max(0, eff - 2);
    if (ctx.perf.recent.tilt) w -= 6;
    if (ctx.perf.bestConfluences.some((b) => conf.includes(b.confluence))) w += 4;
    if (ctx.perf.worstConfluences.some((b) => conf.includes(b.confluence))) w -= 7;
    w += session.bonus;
    return Math.max(55, Math.min(88, Math.round(w)));
  };

  const newsNote = ctx.newsCount > 0 ? "Macro headlines in feed — check calendar for high-impact releases before entry; reduce size into news." : null;
  const riskNote = `Risk ${params.riskPercent}% of $${params.accountSize.toLocaleString()} = $${((params.accountSize * params.riskPercent) / 100).toFixed(2)}. Size so SL distance equals this amount; never widen SL.`;
  const structEvOf = (e: StructureEvent | null | undefined) => (e ? { type: e.type, dir: e.dir, ts: e.t, level: e.level } : lastStruct ? { type: lastStruct.type, dir: lastStruct.dir, ts: lastStruct.t, level: lastStruct.level } : null);

  // ---- LONG: sweep + discount + bullish zone ----
  if ((recentSweepSell || inDiscount) && bullZones.length) {
    const z = bullZones[0];
    const conf: string[] = [];
    conf.push(z.kind === "bull_fvg" ? "Fair Value Gap" : z.kind === "breaker_bull" ? "Breaker Block" : "Order Block");
    if (recentSweepSell) conf.push("Liquidity Sweep");
    if (inDiscount) conf.push("Discount Zone");
    if (chochBull) conf.push(chochBull.type === "CHoCH" ? "CHoCH" : "BOS");
    if (patternBull) conf.push(patternBull.name);
    if (htfAlignBull) conf.push("HTF Alignment");
    if (support[0] && Math.abs(support[0].price - z.top) < 0.8 * atrV) conf.push("Support/Resistance");
    if (conf.length >= 2 && (conf.length >= 3 || (recentSweepSell && (chochBull || patternBull)))) {
      const entry = z.top;
      const slBase = recentSweepSell ? Math.min(z.bottom, recentSweepSell.price) : z.bottom;
      const sl = slBase - 0.3 * atrV;
      const risk = entry - sl;
      if (risk > 0) {
        const tp1Raw = Math.min(buyLiq[0]?.price ?? Infinity, resist[0]?.price ?? Infinity);
        const tp1Objective = isFinite(tp1Raw) && tp1Raw - entry >= 2.05 * risk;
        const tp1 = tp1Objective ? tp1Raw : entry + 2.05 * risk;
        const tp2Raw = buyLiq[1]?.price ?? smc.pd.rangeHigh;
        const tp2Objective = tp2Raw - entry >= 2.8 * risk;
        const tp2 = tp2Objective ? tp2Raw : entry + 3.2 * risk;
        const pfBull = patternBull?.locFactor ?? 1;
        const est = boost(conf, patternBull ? pfBull < 1 : false);
        if (est >= 60) {
          const sigType: SignalType = recentSweepSell ? "sweep" : "zone";
          const signal = makeSignal(sigType, ctx, {
            reclaimLevel: recentSweepSell ? recentSweepSell.price : z.bottom,
            zoneTop: z.top, zoneBottom: z.bottom,
          });
          out.push({
            direction: "Long", entry_price: entry, stop_loss: sl, take_profit1: tp1, take_profit2: tp2,
            tp1Objective, tp2Objective,
            estimated_win_rate_percent: est, confidence_score_0_100: Math.min(92, est + (htfAlignBull ? 3 : 0)),
            invalidation_level: slBase - 0.6 * atrV,
            trade_rationale: `${recentSweepSell ? `Sell-side liquidity at ${fmtPrice(recentSweepSell.price, params.assetType)} was swept ${n - recentSweepSell.i} candles ago (SL hunt), ` : `Price is in the discount leg of the dealing range (${smc.pd.position}), `}then tapped the active ${z.kind === "bull_fvg" ? "bullish FVG" : z.kind === "breaker_bull" ? "bullish breaker" : "bullish order block"} [${fmtPrice(z.bottom, params.assetType)}–${fmtPrice(z.top, params.assetType)}]. ${chochBull ? `${chochBull.type} bullish confirmed at ${fmtPrice(chochBull.level, params.assetType)}. ` : ""}${patternBull ? `${patternBull.name} printed at the level. ` : ""}HTF bias ${ctx.htfBias}. Invalidation below the ${recentSweepSell ? "sweep low" : "block"} — a close there voids the premise.`.trim(),
            confluences: conf, news_caution: newsNote, risk_management_note: riskNote,
            signal,
            reasoning: buildReasoning(ctx, "Long", {
              zone: { kind: z.kind, top: z.top, bottom: z.bottom, startI: z.startI, mitigated: z.mitigated },
              sweepI: recentSweepSell?.i ?? null, sweepPrice: recentSweepSell?.price ?? null,
              pool: buyLiq[0] ? { kind: buyLiq[0].kind, touches: buyLiq[0].touches, price: buyLiq[0].price } : null,
              structEv: structEvOf(chochBull), entry, plannedRR: Number(rrOf(entry, sl, tp1).toFixed(2)),
              pattern: patternBull ? { name: patternBull.name, factor: pfBull } : null,
            }),
          });
        }
      }
    }
  }

  // ---- SHORT mirror ----
  if ((recentSweepBuy || inPremium) && bearZones.length) {
    const z = bearZones[0];
    const conf: string[] = [];
    conf.push(z.kind === "bear_fvg" ? "Fair Value Gap" : z.kind === "breaker_bear" ? "Breaker Block" : "Order Block");
    if (recentSweepBuy) conf.push("Liquidity Sweep");
    if (inPremium) conf.push("Premium Zone");
    if (chochBear) conf.push(chochBear.type === "CHoCH" ? "CHoCH" : "BOS");
    if (patternBear) conf.push(patternBear.name);
    if (htfAlignBear) conf.push("HTF Alignment");
    if (resist[0] && Math.abs(resist[0].price - z.bottom) < 0.8 * atrV) conf.push("Support/Resistance");
    if (conf.length >= 2 && (conf.length >= 3 || (recentSweepBuy && (chochBear || patternBear)))) {
      const entry = z.bottom;
      const slBase = recentSweepBuy ? Math.max(z.top, recentSweepBuy.price) : z.top;
      const sl = slBase + 0.3 * atrV;
      const risk = sl - entry;
      if (risk > 0) {
        const tp1Raw = Math.max(sellLiq[0]?.price ?? -Infinity, support[0]?.price ?? -Infinity);
        const tp1Objective = isFinite(tp1Raw) && entry - tp1Raw >= 2.05 * risk;
        const tp1 = tp1Objective ? tp1Raw : entry - 2.05 * risk;
        const tp2Raw = sellLiq[1]?.price ?? smc.pd.rangeLow;
        const tp2Objective = entry - tp2Raw >= 2.8 * risk;
        const tp2 = tp2Objective ? tp2Raw : entry - 3.2 * risk;
        const pfBear = patternBear?.locFactor ?? 1;
        const est = boost(conf, patternBear ? pfBear < 1 : false);
        if (est >= 60) {
          const sigType: SignalType = recentSweepBuy ? "sweep" : "zone";
          const signal = makeSignal(sigType, ctx, {
            reclaimLevel: recentSweepBuy ? recentSweepBuy.price : z.top,
            zoneTop: z.top, zoneBottom: z.bottom,
          });
          out.push({
            direction: "Short", entry_price: entry, stop_loss: sl, take_profit1: tp1, take_profit2: tp2,
            tp1Objective, tp2Objective,
            estimated_win_rate_percent: est, confidence_score_0_100: Math.min(92, est + (htfAlignBear ? 3 : 0)),
            invalidation_level: slBase + 0.6 * atrV,
            trade_rationale: `${recentSweepBuy ? `Buy-side liquidity at ${fmtPrice(recentSweepBuy.price, params.assetType)} was swept ${n - recentSweepBuy.i} candles ago (SL hunt), ` : `Price is in the premium leg of the dealing range (${smc.pd.position}), `}then rejected from the active ${z.kind === "bear_fvg" ? "bearish FVG" : z.kind === "breaker_bear" ? "bearish breaker" : "bearish order block"} [${fmtPrice(z.bottom, params.assetType)}–${fmtPrice(z.top, params.assetType)}]. ${chochBear ? `${chochBear.type} bearish confirmed at ${fmtPrice(chochBear.level, params.assetType)}. ` : ""}${patternBear ? `${patternBear.name} printed at the level. ` : ""}HTF bias ${ctx.htfBias}. Invalidation above the ${recentSweepBuy ? "sweep high" : "block"} — a close there voids the premise.`.trim(),
            confluences: conf, news_caution: newsNote, risk_management_note: riskNote,
            signal,
            reasoning: buildReasoning(ctx, "Short", {
              zone: { kind: z.kind, top: z.top, bottom: z.bottom, startI: z.startI, mitigated: z.mitigated },
              sweepI: recentSweepBuy?.i ?? null, sweepPrice: recentSweepBuy?.price ?? null,
              pool: sellLiq[0] ? { kind: sellLiq[0].kind, touches: sellLiq[0].touches, price: sellLiq[0].price } : null,
              structEv: structEvOf(chochBear), entry, plannedRR: Number(rrOf(entry, sl, tp1).toFixed(2)),
              pattern: patternBear ? { name: patternBear.name, factor: pfBear } : null,
            }),
          });
        }
      }
    }
  }

  // ---- confirmed breakout setups (structure-type signal) ----
  const bo = breakoutBull ?? breakoutBear;
  if (bo && out.length < 2 && volAbove) {
    const dir = bo.dir === "bull" ? "Long" : "Short";
    const entry = bo.level;
    const sl = bo.dir === "bull" ? bo.level - 1.1 * atrV : bo.level + 1.1 * atrV;
    const risk = Math.abs(entry - sl);
    const tp1 = bo.dir === "bull" ? entry + 2.1 * risk : entry - 2.1 * risk;
    const tp2 = bo.dir === "bull" ? entry + 3.4 * risk : entry - 3.4 * risk;
    const conf = ["Breakout Confirmation", "Volume Confirmation"];
    if (bo.dir === "bull" ? inDiscount : inPremium) conf.push(bo.dir === "bull" ? "Discount Zone" : "Premium Zone");
    if (bo.dir === "bull" ? htfAlignBull : htfAlignBear) conf.push("HTF Alignment");
    const est = boost(conf);
    if (est >= 60) {
      const signal = makeSignal("structure", ctx, { reclaimLevel: bo.level });
      out.push({
        direction: dir as "Long" | "Short", entry_price: entry, stop_loss: sl, take_profit1: tp1, take_profit2: tp2,
        estimated_win_rate_percent: est, confidence_score_0_100: Math.min(90, est),
        invalidation_level: sl,
        trade_rationale: `Confirmed breakout ${bo.dir === "bull" ? "above" : "below"} ${fmtPrice(bo.level, params.assetType)} with ${bo.closesBeyond} closes beyond the level and volume above the 20-period average (false-breakout filter passed). Retest entry at the broken level; failure to hold it invalidates.`,
        confluences: conf, news_caution: newsNote, risk_management_note: riskNote, isBreakout: true,
        tp1Objective: false, tp2Objective: false,
        signal,
        reasoning: buildReasoning(ctx, dir as "Long" | "Short", {
          zone: null, sweepI: null, sweepPrice: null,
          pool: (bo.dir === "bull" ? buyLiq[0] : sellLiq[0]) ? { kind: (bo.dir === "bull" ? buyLiq[0] : sellLiq[0]).kind, touches: (bo.dir === "bull" ? buyLiq[0] : sellLiq[0]).touches, price: (bo.dir === "bull" ? buyLiq[0] : sellLiq[0]).price } : null,
          structEv: structEvOf(undefined), entry, plannedRR: Number(rrOf(entry, sl, tp1).toFixed(2)), isBreakout: true,
        }),
      });
    }
  }

  return out.sort((a, b) => b.confidence_score_0_100 - a.confidence_score_0_100).slice(0, 2);
}

/* ---------------- anti-hallucination validation ---------------- */

export function validateSetup(raw: EngineSetup, ctx: EngineCtx): TradeSetup {
  const { candles, smc, params } = ctx;
  const minLow = Math.min(...candles.map((c) => c.l)) * 0.99;
  const maxHigh = Math.max(...candles.map((c) => c.h)) * 1.01;
  const { entry_price: e, stop_loss: sl, take_profit1: tp1, take_profit2: tp2 } = raw;
  const checks: ValidationCheck[] = [];
  const A = params.assetType;

  checks.push({
    name: "V1 price bounds",
    passed: [e, sl, tp1, tp2].every((p) => p >= minLow && p <= maxHigh),
    detail: `all prices within data range [${fmtPrice(minLow, A)}, ${fmtPrice(maxHigh, A)}]`,
  });
  const dirOk = raw.direction === "Long" ? sl < e && e < tp1 && tp1 <= tp2 : tp2 <= tp1 && tp1 < e && e < sl;
  checks.push({ name: "V2 direction consistency", passed: dirOk, detail: raw.direction === "Long" ? "SL < entry < TP1 ≤ TP2" : "TP2 ≤ TP1 < entry < SL" });

  const rr = rrOf(e, sl, tp1);
  checks.push({ name: "V3 RR ≥ 2.0 (recalculated)", passed: rr >= 2.0, detail: `RR = ${rr.toFixed(2)}` });
  checks.push({
    name: "V4 win rate ≥ 60 & confidence ≥ 60",
    passed: raw.estimated_win_rate_percent >= 60 && raw.confidence_score_0_100 >= 60,
    detail: `WR ${raw.estimated_win_rate_percent}% / conf ${raw.confidence_score_0_100}`,
  });

  const refs: number[] = [];
  for (const z of smc.zones) refs.push(z.top, z.bottom, (z.top + z.bottom) / 2);
  for (const z of smc.slHuntZones) refs.push(z.top, z.bottom);
  for (const s of smc.sr) refs.push(s.price);
  for (const p of smc.liquidity) refs.push(p.price);
  for (const s of smc.swings) refs.push(s.price);
  refs.push(smc.pd.eq, ...smc.pd.premium, ...smc.pd.discount);
  const tol = A === "crypto" ? 0.005 : 0.01;
  const near = refs.some((r) => Math.abs(e - r) / e <= tol);
  checks.push({ name: `V5 entry near detected level (≤${(tol * 100).toFixed(1)}%)`, passed: near, detail: near ? "entry anchored to SMC/PA level" : "entry not anchored" });

  if (raw.isBreakout) {
    const match = smc.breakouts.some((b) => b.state === "confirmed" && b.volOk && b.closesBeyond >= 2 && Math.abs(b.level - e) / e <= tol * 2 && ((raw.direction === "Long" && b.dir === "bull") || (raw.direction === "Short" && b.dir === "bear")));
    checks.push({ name: "V6 false-breakout filter (volume + 2 closes)", passed: match, detail: match ? "confirmed breakout with volume" : "breakout conditions not met" });
  }

  const passed = checks.every((c) => c.passed);
  const reasoning: Reasoning = {
    ...raw.reasoning,
    rejectionReason: passed ? null : `REJECTED — ${checks.filter((c) => !c.passed).map((c) => `${c.name} (${c.detail})`).join("; ")}`,
  };
  return {
    id: uid(),
    direction: raw.direction,
    entry_price: e, stop_loss: sl, take_profit1: tp1, take_profit2: tp2,
    risk_reward_ratio: Number(rr.toFixed(2)),
    estimated_win_rate_percent: raw.estimated_win_rate_percent,
    confidence_score_0_100: raw.confidence_score_0_100,
    invalidation_level: raw.invalidation_level,
    trade_rationale: raw.trade_rationale,
    confluences: raw.confluences,
    news_caution: raw.news_caution,
    risk_management_note: raw.risk_management_note,
    isBreakout: raw.isBreakout,
    validation: { passed, checks },
    source: "engine",
    signal: raw.signal,
    reasoning,
    tp1_objective: raw.tp1Objective,
    tp2_objective: raw.tp2Objective,
  };
}

/* ---------------- live signal status ---------------- */

export function signalStatus(
  setup: TradeSetup,
  result: { smc: SMCAnalysis },
  now: number,
  price: number,
): { status: "ACTIVE" | "EXPIRED"; reason: string } {
  const sig = setup.signal;
  if (!sig) return { status: "ACTIVE", reason: "no validity window attached" };
  if (now > sig.validTillTs) return { status: "EXPIRED", reason: `validity window elapsed (${sig.validCandles} setup-candles)` };
  if (sig.reclaimLevel != null) {
    const long = setup.direction === "Long";
    if (long ? price < sig.reclaimLevel : price > sig.reclaimLevel) {
      return { status: "EXPIRED", reason: "level reclaimed against direction (live price)" };
    }
  }
  if (sig.type === "structure") {
    const opposite = setup.direction === "Long" ? "bear" : "bull";
    const ev = result.smc.structure.filter((e) => e.dir === opposite && e.t > sig.generatedAt).slice(-1)[0];
    if (ev) return { status: "EXPIRED", reason: `opposite ${ev.type} printed after signal` };
  }
  return { status: "ACTIVE", reason: "valid" };
}

/* ---------------- risk ---------------- */

export function computePosition(entry: number, sl: number, tp1: number, tp2: number, accountSize: number, riskPercent: number): PositionSizing {
  const riskAmount = (accountSize * riskPercent) / 100;
  const dist = Math.abs(entry - sl);
  const positionSize = dist > 0 ? riskAmount / dist : 0;
  return {
    riskAmount,
    positionSize,
    notional: positionSize * entry,
    profitAtTp1: positionSize * Math.abs(tp1 - entry),
    profitAtTp2: positionSize * Math.abs(tp2 - entry),
    lossAtSl: -riskAmount,
  };
}

/* ---------------- key levels ---------------- */

function buildKeyLevels(smc: SMCAnalysis, A: AnalyzeParams["assetType"]): KeyLevel[] {
  const out: KeyLevel[] = [];
  for (const s of smc.sr.slice(0, 3)) out.push({ type: s.kind === "resistance" ? "Resistance" : "Support", price: s.price, description: `${s.touches} touches, strength ${s.strength}` });
  for (const z of smc.zones.filter((z) => z.active).slice(-3)) {
    const label = z.kind === "bull_ob" ? "Bullish Order Block" : z.kind === "bear_ob" ? "Bearish Order Block" : z.kind === "bull_fvg" ? "Bullish FVG" : z.kind === "bear_fvg" ? "Bearish FVG" : z.kind === "breaker_bull" ? "Bullish Breaker" : z.kind === "breaker_bear" ? "Bearish Breaker" : "Imbalance";
    out.push({ type: label, price: (z.top + z.bottom) / 2, description: `zone ${fmtPrice(z.bottom, A)}–${fmtPrice(z.top, A)}${z.mitigated ? " (partially mitigated)" : ""}` });
  }
  for (const p of smc.liquidity.filter((p) => p.touches >= 2).slice(0, 2))
    out.push({ type: p.side === "buy" ? "Buy-side Liquidity" : "Sell-side Liquidity", price: p.price, description: `${p.kind.replace("_", " ")} ×${p.touches}` });
  out.push({ type: "Equilibrium", price: smc.pd.eq, description: "50% of dealing range" });
  return out.sort((a, b) => b.price - a.price).slice(0, 9);
}

export async function sendTelegram(settings: Settings, text: string): Promise<boolean> {
  if (!settings.telegramToken || !settings.telegramChatId) return false;
  try {
    const res = await fetch(`https://api.telegram.org/bot${settings.telegramToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: settings.telegramChatId, text, disable_web_page_preview: true }),
    });
    return res.ok;
  } catch { return false; }
}

/* ---------------- orchestrator ---------------- */

function wrapAISetup(raw: RawSetup, ctx: EngineCtx): EngineSetup {
  return {
    ...raw,
    signal: makeSignal("zone", ctx, { reclaimLevel: raw.invalidation_level ?? null }),
    reasoning: {
      htfBias: ctx.htfBias,
      htfRationale: biasRationale(ctx.htfSmc, ctx.htfInd, ctx.htfCandles),
      liquidity: null, sweep: null, structureEvent: null, zone: null,
      session: detectSession(ctx.generatedAt),
      plannedRR: Number(rrOf(raw.entry_price, raw.stop_loss, raw.take_profit1).toFixed(2)),
      entryModel: ENTRY_MODEL,
      rejectionReason: null,
    },
  };
}

export async function runAnalysis(params: AnalyzeParams, settings: Settings, log: Log, advQuality = false): Promise<AnalysisResult> {
  const t0 = performance.now();
  const htf = HTF_MAP[params.timeframe];
  const ltf = LTF_MAP[params.timeframe];

  log(`pipeline start · ${params.symbol} ${params.timeframe} (HTF ${htf} · LTF ${ltf}) · confirmed-candles-only`);
  const stfRes = await fetchCandles(params.symbol, params.assetType, params.timeframe, 300, log);
  const htfRes = htf === params.timeframe ? stfRes : await fetchCandles(params.symbol, params.assetType, htf, 300, log);
  const ltfRes = ltf === params.timeframe ? stfRes : await fetchCandles(params.symbol, params.assetType, ltf, 300, log);

  // SCALP-1.0: analysis runs on CONFIRMED candles only — the forming candle is chart-only
  const drop = (arr: Candle[]) => (arr.length > 80 ? arr.slice(0, -1) : arr);
  const stfC = drop(stfRes.candles), htfC = drop(htfRes.candles), ltfC = drop(ltfRes.candles);
  const stepMs = TF_MINUTES[params.timeframe] * 60_000;
  const generatedAt = last(stfC).t + stepMs;
  log(`confirming candle closed ${fmtIST(generatedAt)} — signal clock starts`, "info");

  log("computing indicators ×3 timeframes…");
  const ind = computeIndicators(stfC);
  const indHtf = computeIndicators(htfC);
  const indLtf = computeIndicators(ltfC);

  log("detecting SMC/ICT/PA/SL-hunt levels (STF + HTF)…");
  const smc = analyzeSMC(stfC, advQuality);
  const htfSmc = analyzeSMC(htfC, advQuality);
  if (advQuality) log("adv v1.2.0 soft quality layers active (pattern ctx · AMD · dry-up · wick OB · fakeout class · IST)");

  const [news, sentiment] = await Promise.all([fetchNews(params.symbol, params.assetType, log), fetchSentiment(log)]);
  const trades = loadTrades();
  const perf = computePerformance(trades);
  log(`journal: ${perf.total} closed trades · WR ${perf.winRate.toFixed(0)}%${perf.recent.tilt ? " · TILT flag" : ""}`);

  const htf_bias = deriveBias(htfSmc, indHtf, htfC);
  const stf_bias = deriveBias(smc, ind, stfC);
  const ltf_bias = deriveBias(smc, indLtf, ltfC);
  log(`bias HTF ${htf_bias} · STF ${stf_bias} · LTF ${ltf_bias}`, "ok");

  const engineCtx: EngineCtx = {
    params, candles: stfC, ind, smc, htfSmc, htfInd: indHtf, htfCandles: htfC,
    htfBias: htf_bias, perf, newsCount: news.length, generatedAt, stepMs,
  };

  let candidates: EngineSetup[] = [];
  let engine = "TradeVision Offline Engine";
  let aiSummary: string | null = null;
  let aiSelfNote: string | null = null;
  let aiNewsSummary: string | null = null;
  let aiKeyLevels: KeyLevel[] | null = null;

  if (settings.provider !== "local" && settings.apiKey) {
    try {
      log(`prompt → ${settings.provider} (${settings.model || "default model"})…`);
      const prompt = buildPrompt({
        params, stf: stfC, htf: htfC, ltf: ltfC,
        indStf: ind, indHtf: indHtf, indLtf: indLtf, smcStf: smc, smcHtf: htfSmc,
        perf, news,
      });
      const text = await callAIProvider(settings, prompt);
      const env = parseAIJson(text);
      candidates = (env.setups ?? []).slice(0, 2).map((r) => wrapAISetup(r, engineCtx));
      aiSummary = env.summary ?? null;
      aiSelfNote = env.self_learning_note ?? null;
      aiNewsSummary = env.news_summary ?? null;
      aiKeyLevels = env.key_levels ?? null;
      engine = settings.provider.toUpperCase();
      log(`AI returned ${candidates.length} candidate setup(s) → validating…`, "ok");
    } catch (e) {
      log(`AI provider failed (${e instanceof Error ? e.message : "?"}) → offline engine fallback`, "err");
      candidates = localSetups(engineCtx);
    }
  } else {
    log("offline engine: deriving setups from detected structure…");
    candidates = localSetups(engineCtx);
  }

  const validated = candidates.map((c) => validateSetup(c, engineCtx));
  for (const v of validated) {
    const failed = v.validation.checks.filter((c) => !c.passed);
    if (failed.length) log(`setup ${v.direction}@${fmtPrice(v.entry_price, params.assetType)} rejected: ${failed.map((f) => f.name).join(", ")}`, "warn");
    else log(`setup ${v.direction}@${fmtPrice(v.entry_price, params.assetType)} passed all ${v.validation.checks.length} checks ✓`, "ok");
  }
  const setups = validated.filter((v) => v.validation.passed).map((v) => ({
    ...v,
    position: computePosition(v.entry_price, v.stop_loss, v.take_profit1, v.take_profit2, params.accountSize, params.riskPercent),
    source: engine,
  }));
  const rejectedSetups = validated.filter((v) => !v.validation.passed);

  if (setups.length && (settings.telegramToken && settings.telegramChatId)) {
    const ok = await sendTelegram(settings, `TradeVision: ${setups.length} validated setup(s) on ${params.symbol} ${params.timeframe}\n` + setups.map((s) => `${s.direction} ${fmtPrice(s.entry_price, params.assetType)} → TP1 ${fmtPrice(s.take_profit1, params.assetType)} (RR ${s.risk_reward_ratio}) · valid till ${fmtIST(s.signal?.validTillTs ?? 0)}`).join("\n"));
    log(ok ? "Telegram alert sent ✓" : "Telegram send failed (network/CORS)", ok ? "ok" : "warn");
  }

  const lastPrice = last(stfRes.candles).c;
  const refClose = stfC[Math.max(0, stfC.length - 25)]?.c ?? lastPrice;
  const localSummary = `${stf_bias === "ranging" ? "Range-bound" : stf_bias === "bullish" ? "Bullish" : "Bearish"} STF structure (trend: ${smc.trend}) under a ${htf_bias} HTF bias. Price is in the ${smc.pd.position} of the dealing range [${fmtPrice(smc.pd.rangeLow, params.assetType)}–${fmtPrice(smc.pd.rangeHigh, params.assetType)}]. ${smc.structure.slice(-2).map((e) => `${e.type} ${e.dir} @ ${fmtPrice(e.level, params.assetType)}`).join("; ") || "No fresh structure breaks"}. ${smc.zones.filter((z) => z.active).length} active OB/FVG zones, ${smc.liquidity.filter((p) => p.touches >= 2).length} engineered liquidity pool(s). ${setups.length ? "" : "No high-probability setup found with required confluences and filters."}`;
  const localSelf = perf.total === 0
    ? "No journal history yet — baseline strictness applied. Log every trade so the engine can learn your edge."
    : `Adapted from ${perf.total} closed trades (WR ${perf.winRate.toFixed(0)}%, PF ${perf.profitFactor.toFixed(2)}). ${perf.bestConfluences[0] ? `Favoring "${perf.bestConfluences[0].confluence}" stacks (${perf.bestConfluences[0].winRate.toFixed(0)}% historical WR).` : ""} ${perf.worstConfluences[0] ? `Avoiding "${perf.worstConfluences[0].confluence}" setups (${perf.worstConfluences[0].winRate.toFixed(0)}% WR).` : ""} ${perf.recent.tilt ? "Recent losses detected — confidence threshold raised, only A+ stacks offered." : perf.recent.trades >= 5 && perf.recent.winRate >= 60 ? "Recent form strong — standard strictness kept, no over-tightening." : "Steady recent form — standard strictness."}`;
  const localNews = news.length
    ? `${news.length} headlines in feed. Treat as side factor: none override the technical picture unless a high-impact release (FOMC/CPI/earnings) is imminent — check the calendar before entry.`
    : "News feeds unreachable this run; analysis is purely technical. Verify the economic calendar manually before high-impact windows.";

  const key_levels = aiKeyLevels?.length ? aiKeyLevels : buildKeyLevels(smc, params.assetType);

  return {
    id: uid(),
    symbol: params.symbol,
    displaySymbol: params.symbol,
    assetType: params.assetType,
    timeframe: params.timeframe,
    htf, ltf,
    generatedAt: Date.now(),
    dataSource: stfRes.source,
    simulated: stfRes.simulated,
    lastPrice,
    changePct: refClose ? ((lastPrice - refClose) / refClose) * 100 : 0,
    candles: stfRes.candles,
    htfCandles: htfRes.candles,
    ltfCandles: ltfRes.candles,
    indicators: ind, htfIndicators: indHtf, ltfIndicators: indLtf,
    smc, htfSmc,
    htf_bias, stf_bias, ltf_bias,
    summary: aiSummary ?? localSummary,
    self_learning_note: aiSelfNote ?? localSelf,
    key_levels,
    liquidity_pools: smc.liquidity.slice(0, 8).map((p) => ({ side: p.side, price: p.price })),
    news_summary: aiNewsSummary ?? localNews,
    news, sentiment,
    setups,
    rejectedSetups,
    confirmedOnly: true,
    engine,
    performance: perf,
    accountSize: params.accountSize,
    riskPercent: params.riskPercent,
    durationMs: performance.now() - t0,
  };
}
