import type { TmMode } from "./types";
import { loadLS } from "./utils";

/**
 * Variant registry — SCALP-1.0 pre-registered changes.
 * Entry logic is FROZEN across variants: identical gates, validators V1–V6,
 * validity/expiry, reasoning, confirmed-only signals, next-open fills and the
 * base cost model. Only trade MANAGEMENT and (from v1.2.0) additive SOFT quality
 * layers differ. Soft layers never add hard vetoes.
 */
export type TmVariantId = "baseline-v1.0.0" | "scalp10-tm-v1.1.0" | "scalp10-adv-v1.2.0" | "scalp10-eff2-slg-v1.0.0";

/**
 * FREQUENCY GUARD — quality improvements must not collapse trade frequency.
 * Per window: if the advanced variant's full-run closed trades fall below
 * max(0.8 × baseline closed trades, 50), the advanced variant is marked FAIL
 * and ALL of its soft additions are suspended everywhere in live signal
 * generation (terminal + radar) until a passing benchmark is stored.
 * The benchmark itself always runs the advanced variant so the guard can recover.
 */
export const FREQUENCY_GUARD = { ratio: 0.8, minTrades: 50 };

export const LS_BENCH_KEY = "tv_bench_v1";

export function freqFloor(baselineTrades: number): number {
  return Math.max(FREQUENCY_GUARD.ratio * baselineTrades, FREQUENCY_GUARD.minTrades);
}

export interface FrequencyGate { ok: boolean | null; detail: string }

/** null = no evidence yet (never benchmarked / aborted) — adv stays allowed, guard pending. */
export function loadFrequencyGate(): FrequencyGate {
  try {
    const r = loadLS<{ aborted?: boolean; advFrequencyOk?: boolean | null } | null>(LS_BENCH_KEY, null);
    if (!r) return { ok: null, detail: "guard pending — run the benchmark to test frequency" };
    if (r.aborted) return { ok: null, detail: "guard inconclusive — last benchmark aborted" };
    if (r.advFrequencyOk == null) return { ok: null, detail: "guard pending — report has no evidence" };
    return r.advFrequencyOk
      ? { ok: true, detail: `guard passed — adv trades ≥ max(0.8×baseline, ${FREQUENCY_GUARD.minTrades})` }
      : { ok: false, detail: `guard FAILED — adv soft layers suspended until a passing benchmark` };
  } catch {
    return { ok: null, detail: "guard unreadable" };
  }
}

export interface TmVariantDef {
  id: TmVariantId;
  label: string;
  short: string;
  mode: TmMode;
  /** adv v1.2.0 soft quality layers: pattern context, AMD tag, volume dry-up, wick-inclusive OB impulse, fakeout-reversal class, IST sessions */
  advQuality: boolean;
  /** eff2-slg v1.0.0 Part A: positive-only ranking boosts, cap +15 — never a gate, never a penalty */
  eff2: boolean;
  /** eff2-slg v1.0.0 Part B: SL-Shield execution rules (confirmation trigger, maker-limit entry, stale exit) */
  slShield: boolean;
  management: string;
  partial: { atR: number; closePct: number; thenSl: "breakeven" } | null;
  runner: string;
  timeExitBars: number;
  costs: string;
  qualityLayers: string[];
}

const TM110_MANAGEMENT = "50% partial at +1.0R (conservative same-candle fill) → SL to breakeven. Runner (50%) targets TP2 logic; 60-bar time exit marks the runner.";
const TM110_RUNNER = "TP2 (2nd pool / range extreme) if objective and > 1.0R away, else original TP1 floor (2.05R)";
const COSTS_LINE = "entry 0.02% maker + 0.05% slip · exit 0.10% taker + 0.05% slip · both legs";

export const TM_VARIANTS: TmVariantDef[] = [
  {
    id: "baseline-v1.0.0",
    label: "BASELINE v1.0.0",
    short: "BASE",
    mode: "classic",
    advQuality: false,
    management: "Full position: TP1 (next liquidity/SR, floor 2.05R) → SL to breakeven → TP2 (2nd pool / range extreme, floor 2.8R→3.2R). 60-bar time mark.",
    partial: null,
    runner: "—",
    timeExitBars: 60,
    costs: COSTS_LINE + " · full weight",
    qualityLayers: [],
  },
  {
    id: "scalp10-tm-v1.1.0",
    label: "TM v1.1.0",
    short: "TM-1.1",
    mode: "tm110",
    advQuality: false,
    management: TM110_MANAGEMENT,
    partial: { atR: 1.0, closePct: 50, thenSl: "breakeven" },
    runner: TM110_RUNNER,
    timeExitBars: 60,
    costs: COSTS_LINE + " · partial and runner exit legs each carry 50% weight",
    qualityLayers: [],
  },
  {
    id: "scalp10-adv-v1.2.0",
    label: "ADV v1.2.0",
    short: "ADV-1.2",
    mode: "tm110",
    advQuality: true,
    management: TM110_MANAGEMENT,
    partial: { atR: 1.0, closePct: 50, thenSl: "breakeven" },
    runner: TM110_RUNNER,
    timeExitBars: 60,
    costs: COSTS_LINE + " · partial and runner exit legs each carry 50% weight",
    qualityLayers: [
      "Pattern context: full points only ≤0.5×ATR of OB/FVG edge or ≤0.3×ATR of S/R/pool, else 50% credit (soft)",
      "AMD tag: 20-bar range ≤2×ATR whose extreme was swept → Manipulation, +5 radar score (soft)",
      "Volume dry-up: pre-sweep 20-bar avg < 0.7×VolMA20 → trap score +5 (soft)",
      "OB impulse: max(body, wick) displacement ≥1.8×ATR (wick-inclusive detection)",
      "Fakeout-reversal class: displacement close back through swept level within 3 candles → false-BO score 10 (sweep 7, neutral 6)",
      "Sessions in IST: Asia 07:00–13:30 · London 13:30–16:30 · NY 19:00–22:00 · bonuses unchanged",
    ],
  },
];

export const variantById = (id: TmVariantId): TmVariantDef =>
  TM_VARIANTS.find((v) => v.id === id) ?? TM_VARIANTS[0];

/** The variant under test in benchmarks: newest entry; baseline is always the first. */
export const BASELINE_VARIANT = TM_VARIANTS[0];
export const TEST_VARIANT = TM_VARIANTS[TM_VARIANTS.length - 1];

/** Benchmark pass thresholds — printed automatically, evaluated on the VAL segment only. */
export const PASS_THRESHOLDS = [
  { id: "T1", label: "VAL net/trade > 0" },
  { id: "T2", label: "VAL net/trade > baseline VAL net/trade (same window)" },
  { id: "T3", label: "VAL monthly ACTIVE ≥ 8 trades/month" },
  { id: "T4", label: "VAL gross/trade ≥ 0.9 × baseline VAL gross/trade" },
] as const;

export const MIN_VAL_TRADES = 60;
