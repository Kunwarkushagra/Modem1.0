export type AssetType = "crypto" | "stock" | "forex";
export type Timeframe = "5m" | "15m" | "30m" | "1h" | "4h" | "1d";
export type Bias = "bullish" | "bearish" | "ranging";
export type Direction = "Long" | "Short";

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
}

export interface SweepEvent { i: number; t: number; side: "buy" | "sell"; price: number }
export interface SRLevel { price: number; touches: number; kind: "support" | "resistance"; strength: number }
export interface PatternHit { i: number; t: number; name: string; dir: "bull" | "bear" | "neutral" }
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
export type TradeSource = "ai" | "manual" | "backtest";

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
}

export interface BacktestTrade {
  i: number; t: number; direction: Direction; entry: number; sl: number; tp1: number; tp2: number;
  rr: number; outcome: TradeOutcome; pnlR: number; confluences: string[];
}

export interface BacktestResult {
  params: { symbol: string; assetType: AssetType; timeframe: Timeframe; days: number };
  totalCandles: number;
  trades: BacktestTrade[];
  skippedInvalid: number;
  winRate: number;
  profitFactor: number;
  expectancyR: number;
  maxDrawdownR: number;
  sharpe: number;
  netR: number;
  equityR: number[];
  durationMs: number;
  dataSource: string;
}

export interface LogLine { t: number; msg: string; kind: "info" | "ok" | "warn" | "err" }
