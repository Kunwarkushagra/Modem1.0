import type { Timeframe } from "./types";
import { EFF2_POWERED, EFF2_SMOKE, eff2Floor } from "./tmVariant";

/**
 * BENCH CONFIG — printed verbatim into the bench header BEFORE any run.
 *
 * Variant slot under test is scalp10-eff2-slg-v1.0.0 (baseline stays runnable as the
 * reference arm). The legacy 90d windows are CONTAMINATED: they are excluded from all
 * runs and decisions, and nothing may auto-revert based on them. SMOKE and POWERED use
 * fresh FROZEN windows (fixed end anchor) that were never used before, so results are
 * reproducible and untainted by the contaminated runs.
 */

export const VARIANT_SLOT = "scalp10-eff2-slg-v1.0.0";
export const BASELINE_SLOT = "baseline-v1.0.0";

/** Legacy windows — contaminated. Excluded from every run and decision; no auto-revert based on these. */
export const CONTAMINATED_WINDOWS = [
  "BTC · 1H · 90D",
  "ETH · 1H · 90D",
  "SOL · 1H · 90D",
  "BTC · 15M · 90D",
] as const;

/** Fresh frozen anchors (epoch ms). Fixed at compile time → reproducible, never reused. */
const SMOKE_ANCHOR = Date.UTC(2026, 1, 1, 0, 0, 0); // 2026-02-01 00:00 UTC
const POWERED_ANCHOR = Date.UTC(2026, 1, 1, 0, 0, 0);

export interface PhaseConfig {
  phase: "SMOKE" | "POWERED";
  variantSlot: string;
  baselineSlot: string;
  symbols: string[];
  timeframe: Timeframe;
  secondaryTimeframe: Timeframe | null;
  days: number;
  anchorEnd: number;
  /** frequency floor = max(0.8 × baseline trades, min(cap, baseline trades)) */
  floor: (baselineTrades: number) => number;
  floorCap: number;
  minValTrades: number | null;
  gatedOn: string | null;
}

export const SMOKE_CONFIG: PhaseConfig = {
  phase: "SMOKE",
  variantSlot: VARIANT_SLOT,
  baselineSlot: BASELINE_SLOT,
  symbols: ["BTCUSDT", "ETHUSDT", "SOLUSDT"],
  timeframe: "15m",
  secondaryTimeframe: null,
  days: 30,
  anchorEnd: SMOKE_ANCHOR,
  floor: (b) => eff2Floor(b, "smoke"),
  floorCap: EFF2_SMOKE.cap,
  minValTrades: null,
  gatedOn: null,
};

export const POWERED_SYMBOLS = [
  "BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT",
  "LINKUSDT", "DOGEUSDT", "ADAUSDT", "AVAXUSDT", "SUIUSDT",
];

export const POWERED_CONFIG: PhaseConfig = {
  phase: "POWERED",
  variantSlot: VARIANT_SLOT,
  baselineSlot: BASELINE_SLOT,
  symbols: POWERED_SYMBOLS,
  timeframe: "15m",
  secondaryTimeframe: "1h",
  days: 365,
  anchorEnd: POWERED_ANCHOR,
  floor: (b) => eff2Floor(b, "powered"),
  floorCap: EFF2_POWERED.cap,
  minValTrades: EFF2_POWERED.minValTrades,
  gatedOn: "SMOKE",
};

const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Human-readable active-config block, printed BEFORE any run. */
export function describeConfig(c: PhaseConfig): string[] {
  const start = c.anchorEnd - c.days * 86_400_000;
  const lines = [
    `PHASE ${c.phase} · VARIANT SLOT: ${c.variantSlot} · BASELINE: ${c.baselineSlot}`,
    `FROZEN WINDOW: ${iso(start)} → ${iso(c.anchorEnd)} (${c.days}d, anchor ${c.anchorEnd})`,
    `SYMBOLS (${c.symbols.length}): ${c.symbols.join(" ")}`,
    `SETUP TF: ${c.timeframe.toUpperCase()}${c.secondaryTimeframe ? ` + SECONDARY ${c.secondaryTimeframe.toUpperCase()}` : ""}`,
    `FREQ FLOOR: max(0.8 × baseline, min(${c.floorCap}, baseline)) trades`,
  ];
  if (c.minValTrades) lines.push(`VAL SAMPLE: n ≥ ${c.minValTrades}, else INSUFFICIENT — NO CONCLUSION`);
  if (c.gatedOn) lines.push(`GATED ON: ${c.gatedOn} PASS`);
  return lines;
}

export function contaminationNotice(): string {
  return `CONTAMINATED — excluded from all runs & decisions, no auto-revert: ${CONTAMINATED_WINDOWS.join(" · ")}`;
}

/* ---------------- runner-v1.0.0 smoke (exit-management variant) ----------------
 * Fresh frozen window distinct from the eff2 SMOKE/POWERED anchors, never used before.
 * Guard = EXACT entry-count equality vs baseline (the entry pipeline must be untouched).
 */
const RUNNER_ANCHOR = Date.UTC(2026, 2, 1, 0, 0, 0); // 2026-03-01 00:00 UTC (fresh)
const COURSEEDGE_ANCHOR = RUNNER_ANCHOR;             // same fresh window → directly comparable

/**
 * Variant smoke config. `kind` describes what the variant changes vs baseline:
 *   - "exit":    exit-management only (runner) — equality guard still applies
 *   - "scoring": positive-only radar scoring boosts (courseedge) — entry pipeline byte-identical
 * Either way the GUARD is exact entry-count equality vs baseline.
 */
export interface VariantSmokeConfig {
  phase: string;
  kind: "exit" | "scoring";
  variantSlot: string;
  baselineSlot: string;
  symbols: string[];
  timeframe: Timeframe;
  days: number;
  anchorEnd: number;
}
export type RunnerSmokeConfig = VariantSmokeConfig; // back-compat alias

export const RUNNER_SMOKE: VariantSmokeConfig = {
  phase: "RUNNER-SMOKE",
  kind: "exit",
  variantSlot: "scalp10-runner-v1.0.0",
  baselineSlot: BASELINE_SLOT,
  symbols: ["BTCUSDT", "ETHUSDT", "SOLUSDT"],
  timeframe: "15m",
  days: 30,
  anchorEnd: RUNNER_ANCHOR,
};

export const COURSEEDGE_SMOKE: VariantSmokeConfig = {
  phase: "COURSEEDGE-SMOKE",
  kind: "scoring",
  variantSlot: "scalp10-courseedge-v1.0.0",
  baselineSlot: BASELINE_SLOT,
  symbols: ["BTCUSDT", "ETHUSDT", "SOLUSDT"],
  timeframe: "15m",
  days: 30,
  anchorEnd: COURSEEDGE_ANCHOR,
};

export function describeVariantSmoke(c: VariantSmokeConfig): string[] {
  const start = c.anchorEnd - c.days * 86_400_000;
  return [
    `PHASE ${c.phase} · VARIANT SLOT: ${c.variantSlot} · BASELINE: ${c.baselineSlot}`,
    `FROZEN WINDOW: ${iso(start)} → ${iso(c.anchorEnd)} (${c.days}d, anchor ${c.anchorEnd})`,
    `SYMBOLS (${c.symbols.length}): ${c.symbols.join(" ")}`,
    `SETUP TF: ${c.timeframe.toUpperCase()} · ${c.kind === "exit" ? "EXIT-MANAGEMENT ONLY" : "SCORING-ONLY (radar boosts)"} — entry pipeline = baseline`,
    `GUARD: EXACT entry-count equality vs baseline — any drift reverts the variant`,
  ];
}
export const describeRunnerConfig = describeVariantSmoke; // back-compat
