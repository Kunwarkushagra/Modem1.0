import type { TmMode } from "./types";

/**
 * Variant registry — SCALP-1.0 pre-registered change (c).
 * Entry logic is FROZEN across variants: identical gates, validators V1–V6,
 * validity/expiry, reasoning, confirmed-only signals, next-open fills and the
 * base cost model. Only trade MANAGEMENT differs.
 */
export type TmVariantId = "baseline-v1.0.0" | "scalp10-tm-v1.1.0";

export interface TmVariantDef {
  id: TmVariantId;
  label: string;
  short: string;
  mode: TmMode;
  management: string;
  partial: { atR: number; closePct: number; thenSl: "breakeven" } | null;
  runner: string;
  timeExitBars: number;
  costs: string;
}

export const TM_VARIANTS: TmVariantDef[] = [
  {
    id: "baseline-v1.0.0",
    label: "BASELINE v1.0.0",
    short: "BASE",
    mode: "classic",
    management: "Full position: TP1 (next liquidity/SR, floor 2.05R) → SL to breakeven → TP2 (2nd pool / range extreme, floor 2.8R→3.2R). 60-bar time mark.",
    partial: null,
    runner: "—",
    timeExitBars: 60,
    costs: "entry 0.02% maker + 0.05% slip · exit 0.10% taker + 0.05% slip · both legs, full weight",
  },
  {
    id: "scalp10-tm-v1.1.0",
    label: "TM v1.1.0",
    short: "TM-1.1",
    mode: "tm110",
    management: "50% partial at +1.0R (conservative same-candle fill) → SL to breakeven. Runner (50%) targets TP2 logic; 60-bar time exit marks the runner.",
    partial: { atR: 1.0, closePct: 50, thenSl: "breakeven" },
    runner: "TP2 (2nd pool / range extreme) if objective and > 1.0R away, else original TP1 floor (2.05R)",
    timeExitBars: 60,
    costs: "same base model; partial and runner exit legs each carry 50% weight of the exit cost",
  },
];

export const variantById = (id: TmVariantId): TmVariantDef =>
  TM_VARIANTS.find((v) => v.id === id) ?? TM_VARIANTS[0];

/** Benchmark pass thresholds — printed automatically, evaluated on the VAL segment only. */
export const PASS_THRESHOLDS = [
  { id: "T1", label: "VAL net/trade > 0" },
  { id: "T2", label: "VAL net/trade > baseline VAL net/trade (same window)" },
  { id: "T3", label: "VAL monthly ACTIVE ≥ 8 trades/month" },
  { id: "T4", label: "VAL gross/trade ≥ 0.9 × baseline VAL gross/trade" },
] as const;

export const MIN_VAL_TRADES = 60;
