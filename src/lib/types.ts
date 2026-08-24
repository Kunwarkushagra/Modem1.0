import type { TmVariantId } from "./tmVariant";

export type AssetType = "crypto" | "stock" | "forex";
export type Timeframe = "5m" | "15m" | "30m" | "1h" | "4h" | "1d";
export type Bias = "bullish" | "bearish" | "ranging";
export type Direction = "Long" | "Short";
export type { TmVariantId };

export interface Candle { t: number; o: number; h: number; l: number; c: number; v: number }

export interface IndicatorSet {
  rsi: number[];
  ema50: number[];
  ema200: number[];
  macd: number[];
  macdSignal: number[];
  macdHist: number[];
  atr: number[];
  bbUpper: number[];
  bbMid: number[];
  bbLower: number[];
  stochK: number[];
  stochD: number[];
  vwap: number[];
  adx: number[];
  volMA: number[];
  obv: number[];
}

export type SwingKind = "high" | "low";
export interface SwingPoint { i: number; t: number; price: number; kind: SwingKind; major: boolean }
export interface StructureEvent { i: number; t: number; type: "BOS" | "CHoCH"; dir: "bull" | "bear"; level: number }

export type ZoneKind =
  | "bull_ob" | "bear_ob"
  | "breaker_bull" | "breaker_bear"
  | "bull_fvg" | "bear_fvg"
  | "imbalance"
  | "sl_hunt";

export interface Zone {
  kind: ZoneKind;
  top: number;
  bottom: number;
  startI: number;
  t: number;
  active: boolean;
  mitigated: boolean;
  note?: string;
}

export interface LiquidityPool {
  side: "buy" | "sell";
  price: number;
  kind: "equal_highs" | "equal_lows" | "swing_high" | "swing_low";
  touches: number;
  formedI: number;
  /** eff2-slg: min(100, touches×25 + equal-cluster 20 + swept-within-8-bars 10) — ≥ 60 earns the pool-significance boost */
  significance?: number;
}

export interface SweepEvent {
  i: number; t: number; side: "buy" | "sell"; price: number;
  /** adv v1.2.0 soft layers — undefined on baseline/TM variants */
  dryUp?: boolean;                            // avg volume of the 20 candles preceding the sweep < 0.7 × VolMA20
  fakeoutReversal?: boolean;                  // displacement close back through the level within 3 candles of the sweep
  amdPhase?: "Manipulation" | null;           // 20-bar range (≤ 2×ATR) whose extreme was swept
  /** eff2-slg v1.0.0 ranking fields (soft layers) */
  reclaimStrengthAtr?: number;                // sweep-candle close back inside the level, in ATR (≥ 0.2 → reclaim-strength boost)
  reclaimFast?: boolean;                      // decisive reclaim (≥ 0.2×ATR inside) within 2 candles of the sweep → trap score +3
}
export interface SRLevel { price: number; touches: number; kind: "support" | "resistance"; strength: number }
export interface PatternHit {
  i: number; t: number; name: string; dir: "bull" | "bear" | "neutral";
  /** adv v1.2.0: 1.0 at a valid zone (≤0.5×ATR of OB/FVG edge, ≤0.3×ATR of S/R or pool) · 0.5 far away · undefined on non-adv variants */
  locFactor?: number;
}
export interface BreakoutInfo { level: number; dir: "bull" | "bear"; state: "confirmed" | "unconfirmed" | "false"; volOk: boolean; closesBeyond: number }
export interface TrendLine { x1: number; y1: number; x2: number; y2: number; kind: "support" | "resistance" }

export interface PremiumDiscount {
  rangeHigh: number;
  rangeLow: number;
  eq: number;
  premium: [number, number];
  discount: [number, number];
  oteHigh: [number, number];
  oteLow: [number, number];
  position: "premium" | "equilibrium" | "discount";
}

export interface SMCAnalysis {
  swings: SwingPoint[];
  structure: StructureEvent[];
  trend: "bull" | "bear" | "range";
  zones: Zone[];
  liquidity: LiquidityPool[];
  sweeps: SweepEvent[];
  inducement: SwingPoint[];
  pd: PremiumDiscount;
  slHuntZones: Zone[];
  patterns: PatternHit[];
  sr: SRLevel[];
  breakouts: BreakoutInfo[];
  trendlines: TrendLine[];
}

export interface NewsItem { title: string; source: string; url: string; publishedAt: number; summary: string }
export interface Sentiment { value: number; label: string }

export interface ConfluenceStat { confluence: string; trades: number; wins: number; winRate: number; avgRR: number }

export interface PerformanceSummary {
  total: number; wins: number; losses: number; breakeven: number;
  winRate: number; avgWinPct: number; avgLossPct: number;
  profitFactor: number; sharpe: number; maxDrawdown: number;
  bestConfluences: ConfluenceStat[]; worstConfluences: ConfluenceStat[];
  recent: { trades: number; winRate: number; tilt: boolean };
  equity: number[];
}

export type SignalType = "sweep" | "zone" | "structure";

export interface SignalInfo {
  type: SignalType;
  generatedAt: number;        // UTC ms of confirming candle CLOSE
  displayTimeIST: string;     // Asia/Kolkata render
  validCandles: number;       // 15 sweep / 30 zone / 45 structure
  validTillTs: number;        // generatedAt + validCandles * stepMs (event expiry may precede)
  stepMs: number;
  reclaimLevel: number | null;   // close beyond this against direction → EXPIRED
  zoneTop: number | null;        // zone-based: close through far edge → fully mitigated
  zoneBottom: number | null;
  expiryRules: string;
}

export interface Reasoning {
  htfBias: Bias;
  htfRationale: string;
  liquidity: { grade: "A" | "B" | "C"; source: string; distanceAtr: number; significance?: number } | null;
  sweep: { depthAtr: number; reclaim: boolean; displacementAtr: number; trapScore: number; dryUp?: boolean; fakeoutReversal?: boolean; reclaimStrengthAtr?: number; reclaimFast?: boolean } | null;
  structureEvent: { type: "BOS" | "CHoCH"; dir: "bull" | "bear"; ts: number; level: number } | null;
  zone: { kind: string; grade: "A" | "B"; distanceAtr: number } | null;
  session: { name: string; bonus: number };
  plannedRR: number;
  entryModel: string;
  rejectionReason: string | null;
  /** adv v1.2.0 soft layers */
  patternCtx?: { name: string; factor: number } | null;   // pattern location quality (1.0 at level · 0.5 far)
  amdPhase?: "Manipulation" | null;                        // accumulation/manipulation tag → +5 radar score
}

export interface TradeSetup {
  id: string;
  direction: Direction;
  entry_price: number;
  stop_loss: number;
  take_profit1: number;
  take_profit2: number;
  risk_reward_ratio: number;
  estimated_win_rate_percent: number;
  confidence_score_0_100: number;
  invalidation_level: number;
  trade_rationale: string;
  confluences: string[];
  news_caution: string | null;
  risk_management_note: string | null;
  isBreakout?: boolean;
  validation: { passed: boolean; checks: ValidationCheck[] };
  position?: PositionSizing;
  source: string;
  signal?: SignalInfo;
  reasoning?: Reasoning;
  /** TP derived from a real level (pool/SR/range extreme) rather than a pure R multiple — used by tm110 runner selection */
  tp1_objective?: boolean;
  tp2_objective?: boolean;
}

export interface ValidationCheck { name: string; passed: boolean; detail: string }

export interface PositionSizing {
  riskAmount: number;
  positionSize: number;
  notional: number;
  profitAtTp1: number;
  profitAtTp2: number;
  lossAtSl: number;
}

export interface KeyLevel { type: string; price: number; description: string }

export interface AnalysisResult {
  id: string;
  symbol: string;
  displaySymbol: string;
  assetType: AssetType;
  timeframe: Timeframe;
  htf: Timeframe;
  ltf: Timeframe;
  generatedAt: number;
  dataSource: string;
  simulated: boolean;
  lastPrice: number;
  changePct: number;
  candles: Candle[];
  htfCandles: Candle[];
  ltfCandles: Candle[];
  indicators: IndicatorSet;
  htfIndicators: IndicatorSet;
  ltfIndicators: IndicatorSet;
  smc: SMCAnalysis;
  htfSmc: SMCAnalysis;
  htf_bias: Bias;
  stf_bias: Bias;
  ltf_bias: Bias;
  summary: string;
  self_learning_note: string;
  key_levels: KeyLevel[];
  liquidity_pools: { side: "buy" | "sell"; price: number }[];
  news_summary: string;
  news: NewsItem[];
  sentiment: Sentiment | null;
  setups: TradeSetup[];
  rejectedSetups: TradeSetup[];
  confirmedOnly: boolean;
  engine: string;
  performance: PerformanceSummary;
  accountSize: number;
  riskPercent: number;
  durationMs: number;
}

export interface AnalyzeParams {
  symbol: string;
  assetType: AssetType;
  timeframe: Timeframe;
  accountSize: number;
  riskPercent: number;
}

export type TradeOutcome = "win" | "loss" | "breakeven";
export type TradeStatus = "pending" | "closed";
export type TradeSource = "ai" | "manual" | "backtest" | "radar";

/** Trade-management variant. Entry logic is identical for both — only exit management differs. */
export type TmMode = "classic" | "tm110" | "eff2slg" | "runner";
export type ExitKind = "target" | "be" | "stop" | "time" | "stale" | "struct";

/** Journal exit-reason tag — attached to every closed trade */
export type ExitReason = "SL" | "TP1" | "TP2" | "BE" | "time-exit" | "invalidation" | "manual";

/* ---------------- Top Setups Radar (display layer only — engine untouched) ---------------- */

export type RadarTf = "5m" | "15m" | "1h" | "4h";

/* ---- Universe hygiene guards v2 (data-level, display layer only) ---- */

/** One row of the Binance 24h ticker, pre-guard. */
export interface RawUniverseEntry {
  symbol: string;      // e.g. BTCUSDT
  base: string;        // e.g. BTC
  lastPrice: number;
  highPrice: number;
  lowPrice: number;
  quoteVolume: number; // 24h, in quote asset (USDT)
  changePct: number;   // 24h price change %
}

export interface RadarScoreBreakdown {
  htfBias: number;          // /20 aligned 20 · ranging 8 · against 0
  liquidity: number;        // /20 grade A 20 · B 13 · C 7 · none 0, distance penalty up to −4
  sweep: number;            // /15 trapScore scaled; no sweep evidence → 0
  structure: number;        // /15 CHoCH 15 · BOS 12 · none 0
  zone: number;             // /10 grade A 10 · B 7 · none 0
  session: number;          // /10 LDN/NY overlap 10 · London or NY 7 · Asia 3 · off 0
  falseBreakout: number;    // /10 breakout 10 · fakeout-reversal 10 · liquidity sweep 7 · neutral 6 (adv v1.2.0)
  amd: number;              // adv v1.2.0: +5 when AMD manipulation phase precedes the sweep
  total: number;            // 0–100 (capped) — BASE score; radar floors filter on this (frequency-neutral)
  eff2: number;             // eff2-slg v1.0.0: positive-only boosts, capped at +15 (ranking only)
  ranked: number;           // min(100, total + eff2) — used ONLY for ordering/display, never for floors or gates
}

export type InvalidCheckId = "reclaim" | "mitigation" | "oppositeStructure" | "htfFlip" | "dataStale";

/* ---------------- AI Insight (additive opinion layer — never part of signal generation) ---------------- */

export type InsightStance = "AGREE" | "DISAGREE" | "NEUTRAL";

/** Exact fields accepted by /api/ai-insight — structured signal payload only, no raw candles */
export interface AiInsightPayload {
  signalId: string;
  symbol: string;
  timeframe: string;
  direction: "Long" | "Short";
  score: number;
  scoreBreakdown: RadarScoreBreakdown;
  confluences: string[];
  entry: number;
  stopLoss: number;
  takeProfit1: number;
  takeProfit2: number;
  invalidationLevel: number;
  costInR: number;                 // round-trip fees+slippage expressed in R (≈, from the shared cost model)
  session: string;
  liquidityGrade: "A" | "B" | "C" | null;
  falseBreakoutClass: string;      // confirmed-breakout | fakeout-reversal | liquidity-sweep | neutral
  htfBias: Bias;
  validityWindow: { type: SignalType; candles: number; generatedAtIST: string; validTillIST: string };
  reasoningText: string;
  mode: "quality" | "quantity";
}

export interface AiInsightResult {
  stance: InsightStance;
  confidence: number;              // 0–100, clamped
  summary: string;                 // ≤ 3 lines, enforced
  keyRisks: string[];              // ≤ 3 bullets, enforced
  invalidationRestated: string;
  disclaimer: string;              // fixed constant, enforced client-side
  generatedAt: number;
  cached: boolean;
  source: "server" | "local" | "cache";
}

export type InsightState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "done"; result: AiInsightResult }
  | { status: "unavailable"; message: string };

/* ---------------- AI Chart Review (additive, display-only) ---------------- */

export type ChartAgreement = "AGREE" | "DISAGREE" | "NEUTRAL";

/** Compact structured payload sent with the PNG snapshots (mode: "chartReview"). */
export interface ChartReviewPayload {
  mode: "chartReview";
  signalId: string;
  chartHash: string;               // hash of the confirmed candles rendered (cache key part)
  symbol: string;
  timeframe: string;
  direction: "Long" | "Short";
  score: number;
  confluences: string[];
  entry: number;
  stopLoss: number;
  takeProfit1: number;
  takeProfit2: number;
  invalidationLevel: number;
  costInR: number;
  session: string;
  htfBias: Bias;
  /** two small PNG snapshots (base64, quality 0.6); empty in the text-only fallback */
  stfPng?: string;
  htfPng?: string;
  /** text-only fallback: last 20 confirmed candles + engine levels */
  textOnly?: { candles: string[]; levels: string[] };
}

export interface ChartRefinement { price: number | null; reason: string }

export interface ChartReviewResult {
  structureCheck: string;                      // free-text read of visible structure
  refineEntry: ChartRefinement | null;         // price/reason or null
  refineInvalidation: (ChartRefinement & { rejected?: boolean }) | null; // "rejected" if wider than engine SL
  agreement: ChartAgreement;
  confidence: number;                          // 0–100, clamped
  risks: string[];                             // ≤ 3 bullets, enforced
  disclaimer: string;                          // fixed constant, enforced client-side
  textOnly: boolean;                           // true when the text fallback was used
  generatedAt: number;
  cached: boolean;
  source: "server" | "local" | "cache";
}

export type ChartReviewState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "done"; result: ChartReviewResult }
  | { status: "unavailable"; message: string };

export interface InvalidCheck { id: InvalidCheckId; label: string; hit: boolean; detail: string }

export type RadarStatus = "active" | "invalidated" | "expired";

export interface RadarCandidate {
  key: string;                    // symbol:setupId
  symbol: string;
  assetType: AssetType;
  timeframe: RadarTf;
  setup: TradeSetup;
  score: RadarScoreBreakdown;
  status: RadarStatus;
  invalidReason: string | null;
  invalidChecks: InvalidCheck[];
  htfBiasAtGeneration: Bias;
  dataStale: boolean;
  lastCheckedAt: number;
  archivedAt: number | null;      // set when moved to Recently Expired
  insightStance?: InsightStance | "none"; // captured at log time; also drives the card stamp
}

export interface SymbolScanState {
  symbol: string;
  status: "idle" | "scanning" | "live" | "stale";
  lastScanAt: number;
  lastCloseEpoch: number;         // last setup-TF confirmed close processed
  lastPrice: number | null;
  error: string | null;
  candidatesFound: number;        // candidates that cleared gates + floor on the last scan
}

/** per-stage counts so the DEBUG box shows exactly where candidates die */
export interface ScanFunnel {
  generated: number;              // raw setups from the engine (pre-validation)
  passedGates: number;            // survived validators V1–V6
  passedFloor: number;            // survived the quality floor → shown to the radar
}

export interface Trade {
  id: string;
  symbol: string;
  assetType: AssetType;
  timeframe: string;
  direction: Direction;
  entry: number;
  stopLoss: number;
  tp1: number;
  tp2: number;
  rr: number;
  confidence: number;
  confluences: string[];
  rationale: string;
  status: TradeStatus;
  outcome: TradeOutcome | null;
  exitPrice: number | null;
  pnlPct: number | null;
  pnlR: number | null;
  createdAt: number;
  closedAt: number | null;
  notes: string;
  source: TradeSource;
  signalType?: SignalType;
  signalGeneratedAt?: number;
  signalDisplayIST?: string;
  signalValidTill?: number;
  /** why the trade ended — tagged on every closed trade */
  exitReason?: ExitReason | null;
  /** AI Insight stance at log time — to measure insight accuracy later */
  insightStance?: InsightStance | "none";
  /** AI Chart Review agreement at log time (only when chart review was used) */
  chartAgreement?: ChartAgreement | "none";
}

export interface AlertRule {
  id: string;
  symbol: string;
  side: "above" | "below";
  price: number;
  active: boolean;
  createdAt: number;
  triggeredAt: number | null;
}

export type AiProvider = "local" | "openai" | "anthropic" | "qwen" | "openrouter";

export interface Settings {
  provider: AiProvider;
  apiKey: string;
  model: string;
  accountSize: number;
  riskPercent: number;
  telegramToken: string;
  telegramChatId: string;
  autoRefresh: boolean;
  /* ---- Top Setups Radar (display layer) ---- */
  radarSymbols: string[];       // user additions / custom watchlist
  radarTimeframe: RadarTf;
  radarMode: "auto" | "quality" | "quantity"; // display mode — never touches generation
  radarQualityFloor: number;    // QUALITY mode + scan floor, 0–100, default 65
  quantityFloor: number;        // QUANTITY mode floor, 0–100, default 50
  radarUseTop30: boolean;       // merge Binance top-30 USDT by 24h quote volume (6h cache)
  radarSound: boolean;
  radarTmVariant: TmVariantId;  // which management variant the radar cards describe
  /* ---- AI Insight (opinion layer; server route reads GEMINI_API_KEY from env in production) ---- */
  aiInsightEnabled: boolean;
  geminiApiKey: string;         // static-build fallback only; stays in this browser, never logged
  geminiModel: string;          // default gemini-3-flash-preview (404 → 2.5-flash → 2.5-flash-lite)
  /* ---- Universe hygiene guards (data-level, pre-scan; user-tunable, never auto-tuned) ----
     Exclusions = stablecoins ONLY by default (hard list + extras). The numeric guards are
     OPTIONAL toggles — DEFAULT OFF — retained so they can be re-enabled later. No warm-up gating. */
  universeExtraExcludes: string;          // comma-separated extra bases on top of the hard stablecoin list
  universeMinQuoteVolumeEnabled: boolean; // opt-in: 24h quote-volume floor (default off)
  universeMinQuoteVolume: number;         // floor value, USDT (default 50M)
  universeVolFloorEnabled: boolean;       // opt-in: 24h high-low range floor (default off)
  universeVolFloorPct: number;            // floor value, % (default 1.5)
  universeChangeCapEnabled: boolean;      // opt-in: |24h change| cap (default off)
  universeChangeCapPct: number;           // cap value, % (default 25)
}

export interface BacktestTrade {
  i: number; t: number; direction: Direction; entry: number; sl: number; tp1: number; tp2: number;
  rr: number; outcome: TradeOutcome;
  grossR: number;      // price movement only
  feesR: number;       // maker entry + taker exit + slippage both legs, in R
  pnlR: number;        // NET = grossR - feesR (the ledger of record)
  confluences: string[];
  signalType: SignalType;
  generatedAt: number;
  partialHit: boolean; // tm110/eff2slg/runner: 50% partial filled at +1.0R (always false on baseline)
  exitKind: ExitKind;  // target = objective/trail filled · be = breakeven stop · stop = full stop-out · time = bar mark · stale = pre-partial cut · struct = opposite BOS/CHoCH (runner)
  holdBars?: number;   // candles from entry fill to final close (runner smoke analytics)
}

export interface ExpiryLogItem { i: number; t: number; direction: Direction; signalType: SignalType; reason: string }

export interface BacktestFunnel {
  generated: number;
  expiredBeforeTrigger: number;
  entered: number;
  wins: number;
  losses: number;
  breakeven: number;
}

export interface CostModel { makerPct: number; takerPct: number; slippagePct: number; entryPct: number; exitPct: number }

export interface BacktestResult {
  params: { symbol: string; assetType: AssetType; timeframe: Timeframe; days: number };
  tmMode: TmMode;
  totalCandles: number;
  trades: BacktestTrade[];
  skippedInvalid: number;
  funnel: BacktestFunnel;
  expiryLog: ExpiryLogItem[];
  costs: CostModel;
  winRate: number;
  profitFactor: number;
  expectancyR: number;
  maxDrawdownR: number;
  sharpe: number;
  netR: number;
  grossR: number;
  equityR: number[];   // NET equity curve
  // per-trade aggregates (net ledger)
  grossPerTrade: number;
  costPerTrade: number;
  netPerTrade: number;
  partialRate: number;   // % of trades where the +1R partial filled (tm110/runner)
  beAfterPartialRate: number; // runner: % losses that became BE/small after the partial (tag be)
  avgRunnerHoldBars: number;  // runner: avg candles the runner leg stayed open (partial-fill trades)
  beRate: number;        // % closed at breakeven stop
  stopOutRate: number;   // % fully stopped out
  avgWinR: number;
  avgLossR: number;
  longs: number;
  shorts: number;
  /** eff2-slg v1.0.0 SL-Shield counters (0 on baseline/tm110) */
  missNoConfirm: number;     // entry skipped: no confirmation within 3 exec-TF candles
  missLimitChase: number;    // maker limit cancelled: price ran ≥ 0.5R unfilled
  missLimitUnfilled: number; // maker limit never filled inside the confirmation window
  staleExits: number;        // stale-momentum exits (+0.5R not reached within 12 candles)
  durationMs: number;
  dataSource: string;
}

/* ---------------- variant benchmark ---------------- */

export type BenchSegment = "CAL" | "VAL" | "OOS";

export interface SegmentStats {
  segment: BenchSegment;
  trades: number;
  wins: number;
  losses: number;
  be: number;
  winRate: number;
  grossPerTrade: number;
  costPerTrade: number;
  netPerTrade: number;
  pf: number;
  maxDDR: number;
  partialRate: number;
  beRate: number;
  stopOutRate: number;
  avgWinR: number;
  avgLossR: number;
  longs: number;
  shorts: number;
  tradesPerMonth: number;
}

export interface ThresholdCheck {
  id: string;
  label: string;
  detail: string;
  pass: boolean;
}

export interface BenchWindowSpec {
  symbol: string;
  assetType: AssetType;
  timeframe: Timeframe;
  days: number;
  label: string;
  /** legacy windows are contaminated — excluded from all runs and decisions */
  contaminated?: boolean;
  /** frozen window anchor (epoch ms) — history ends AT this instant for reproducible benches */
  endTs?: number;
}

export interface BenchWindowReport {
  window: BenchWindowSpec;
  candles: number;
  dataSource: string;
  segments: Record<TmVariantId, SegmentStats[]>; // [CAL, VAL, OOS], keyed by variant id
  checks: ThresholdCheck[];
  verdict: "PASS" | "FAIL" | "INSUFFICIENT";
  valTrades: number; // variant VAL sample size
  baselineValTrades: number;
  /** FREQUENCY GUARD — full-run closed trades must stay ≥ max(0.8 × baseline, 50), else the variant FAILS and its soft additions are suspended */
  freqGuard: { baselineTrades: number; advTrades: number; floor: number; pass: boolean };
  /** convenience mirror of freqGuard.pass */
  frequencyGuardPassed: boolean;
  elapsedMs: number;
}

export interface BenchReport {
  ranAt: number;
  elapsedMs: number;
  aborted: boolean;
  windows: BenchWindowReport[];
  /**
   * Aggregate FREQUENCY GUARD verdict for the advanced variant across all windows.
   * true  = every window kept adv full-run trades ≥ max(0.8 × baseline, 50) → adv soft layers stay live.
   * false = at least one window collapsed frequency → adv soft layers are REVERTED (suspended) everywhere.
   * null  = no conclusive evidence yet (never ran, aborted, or empty) → guard pending, adv allowed.
   */
  advFrequencyOk: boolean | null;
}

export interface LogLine { t: number; msg: string; kind: "info" | "ok" | "warn" | "err" }

/* ---------------- eff2-slg smoke test ---------------- */

export interface SmokeArm {
  variantId: string;
  entries: number;          // funnel.entered — the runner guard compares EXACT equality on this
  trades: number;
  winRate: number;
  slHitRate: number;        // % of closed trades fully stopped out
  grossPerTrade: number;
  costPerTrade: number;
  netPerTrade: number;
  profitFactor: number;
  maxDrawdownR: number;
  avgWinR: number;
  avgLossR: number;
  partialRate: number;      // % of trades whose +1R partial filled
  beAfterPartialRate: number; // % losses that became BE/small after the partial (tag be, net ≥ −fees)
  avgRunnerHoldBars: number;  // avg candles the runner leg stayed open (partial-fill trades only)
  missNoConfirm: number;
  missLimitChase: number;
  missLimitUnfilled: number;
  staleExits: number;
}

export interface SmokeReport {
  ranAt: number;
  window: string;           // "BTC+ETH+SOL · 15M · 30D"
  baseline: SmokeArm;
  variant: SmokeArm;
  floor: number;            // max(0.8 × baseline, min(30, baseline)) — corrected guard
  freqPass: boolean;
  slPass: boolean;          // variant SL-hit rate ≤ baseline
  overallPass: boolean;
  dataSource: string;
}

/* ---------------- runner-v1.0.0 smoke (exit-management variant) ---------------- */

export interface RunnerSmokeReport {
  ranAt: number;
  window: string;              // "BTC+ETH+SOL · 15M · 30D (frozen)"
  baseline: SmokeArm;
  variant: SmokeArm;
  /** FREQUENCY GUARD: exact equality — variant entry count must equal baseline */
  entriesEqual: boolean;
  overallPass: boolean;        // = entriesEqual (revert on any drift)
  dataSource: string;
}
