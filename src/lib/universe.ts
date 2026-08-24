import type { RawUniverseEntry } from "./types";

/**
 * UNIVERSE HYGIENE GUARDS v2 — data-level filters applied to the dynamic top-30
 * BEFORE anything is scanned. Purely a display/scanning-scope layer: entry gates,
 * validators V1–V6, validity, reasoning and the backtest never see these rules.
 * User-tunable only — floors are NEVER auto-tuned.
 */

/** Hard stablecoin / fiat-backed base exclusions (spec list). */
export const STABLE_BASES = [
  "USDC", "USDP", "TUSD", "FDUSD", "BUSD", "DAI", "USDE", "PYUSD",
  "EURI", "RLUSD", "AEUR", "EURC", "USD1", "USDTB",
];

export interface UniverseCfg {
  extraExcludes: string[];
  /* numeric guards are OPTIONAL toggles — applied only when enabled (default OFF) */
  minQuoteVolumeEnabled: boolean;
  minQuoteVolume: number;
  volFloorEnabled: boolean;
  volFloorPct: number;
  changeCapEnabled: boolean;
  changeCapPct: number;
}

export interface ExcludedEntry { symbol: string; tag: string; reason: string }

export interface UniverseView {
  scannable: string[];   // every top-30 symbol is scannable immediately on first refresh
  excluded: ExcludedEntry[];
}

/** Parse the user's comma/space-separated extra-exclusion list. */
export function parseExtraExcludes(raw: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const tok of raw.toUpperCase().split(/[\s,;]+/)) {
    const s = tok.replace(/[^A-Z0-9]/g, "");
    if (s.length >= 2 && s.length <= 8 && !seen.has(s)) { seen.add(s); out.push(s); }
  }
  return out;
}

/**
 * Apply guards in fixed order. Exclusions = STABLECOINS ONLY by default.
 *  1. stablecoin base (hard ∪ configured)      → tag STABLE      (always on)
 *  2. 24h high–low range < volFloor            → tag RANGE       (optional, default OFF)
 *  3. 24h quoteVolume ≤ min                    → tag VOL         (optional, default OFF)
 *  4. |24h change| > cap                       → tag Δ24H        (optional, default OFF)
 * There is NO warm-up / min-list-age gating: every surviving symbol is scannable
 * immediately on the first refresh. The user's custom watchlist bypasses all
 * guards by construction — the caller only passes top-30-derived entries through here.
 */
export function applyUniverseGuards(entries: RawUniverseEntry[], cfg: UniverseCfg): UniverseView {
  const excludeBases = new Set<string>([...STABLE_BASES, ...cfg.extraExcludes]);
  const scannable: string[] = [];
  const excluded: ExcludedEntry[] = [];

  for (const e of entries) {
    if (excludeBases.has(e.base)) {
      excluded.push({ symbol: e.symbol, tag: "STABLE", reason: `${e.base} is a stablecoin / fiat-backed base — hard exclusion` });
      continue;
    }
    if (cfg.volFloorEnabled) {
      const rangePct = e.lastPrice > 0 && e.highPrice > 0 && e.lowPrice > 0
        ? ((e.highPrice - e.lowPrice) / e.lastPrice) * 100
        : 0;
      if (!(rangePct >= cfg.volFloorPct)) {
        excluded.push({ symbol: e.symbol, tag: "RANGE", reason: `24h high–low range ${rangePct.toFixed(2)}% < ${cfg.volFloorPct}% volatility floor` });
        continue;
      }
    }
    if (cfg.minQuoteVolumeEnabled && !(e.quoteVolume > cfg.minQuoteVolume)) {
      excluded.push({ symbol: e.symbol, tag: "VOL", reason: `24h quote volume ${(e.quoteVolume / 1e6).toFixed(1)}M USDT ≤ ${(cfg.minQuoteVolume / 1e6).toFixed(0)}M floor` });
      continue;
    }
    if (cfg.changeCapEnabled && Math.abs(e.changePct) > cfg.changeCapPct) {
      excluded.push({ symbol: e.symbol, tag: "Δ24H", reason: `|24h change| ${Math.abs(e.changePct).toFixed(1)}% > ${cfg.changeCapPct}% cap` });
      continue;
    }
    scannable.push(e.symbol);
  }
  return { scannable, excluded };
}
