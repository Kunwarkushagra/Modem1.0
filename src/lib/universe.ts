import type { RawUniverseEntry, Roster } from "./types";

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
  minQuoteVolume: number;
  volFloorPct: number;
  changeCapPct: number;
}

export interface ExcludedEntry { symbol: string; tag: string; reason: string }

export interface UniverseView {
  scannable: string[];
  warming: Array<{ symbol: string; sightings: number }>;
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
 * Apply guards in fixed order:
 *  1. stablecoin base (hard ∪ configured)      → tag STABLE
 *  2. 24h high–low range < volFloor            → tag RANGE
 *  3. 24h quoteVolume ≤ min                    → tag VOL
 *  4. |24h change| > cap                       → tag Δ24H
 *  5. fewer than 2 consecutive 6h sightings    → WARMING (not excluded)
 * The user's custom watchlist bypasses all guards by construction — the caller
 * only passes top-30-derived entries through here.
 */
export function applyUniverseGuards(entries: RawUniverseEntry[], cfg: UniverseCfg, roster: Roster): UniverseView {
  const excludeBases = new Set<string>([...STABLE_BASES, ...cfg.extraExcludes]);
  const scannable: string[] = [];
  const warming: Array<{ symbol: string; sightings: number }> = [];
  const excluded: ExcludedEntry[] = [];

  for (const e of entries) {
    if (excludeBases.has(e.base)) {
      excluded.push({ symbol: e.symbol, tag: "STABLE", reason: `${e.base} is a stablecoin / fiat-backed base — hard exclusion` });
      continue;
    }
    const rangePct = e.lastPrice > 0 && e.highPrice > 0 && e.lowPrice > 0
      ? ((e.highPrice - e.lowPrice) / e.lastPrice) * 100
      : 0;
    if (!(rangePct >= cfg.volFloorPct)) {
      excluded.push({ symbol: e.symbol, tag: "RANGE", reason: `24h high–low range ${rangePct.toFixed(2)}% < ${cfg.volFloorPct}% volatility floor` });
      continue;
    }
    if (!(e.quoteVolume > cfg.minQuoteVolume)) {
      excluded.push({ symbol: e.symbol, tag: "VOL", reason: `24h quote volume ${(e.quoteVolume / 1e6).toFixed(1)}M USDT ≤ ${(cfg.minQuoteVolume / 1e6).toFixed(0)}M floor` });
      continue;
    }
    if (Math.abs(e.changePct) > cfg.changeCapPct) {
      excluded.push({ symbol: e.symbol, tag: "Δ24H", reason: `|24h change| ${Math.abs(e.changePct).toFixed(1)}% > ${cfg.changeCapPct}% cap` });
      continue;
    }
    const sightings = roster[e.symbol]?.consecutive ?? 1;
    if (sightings < 2) { warming.push({ symbol: e.symbol, sightings }); continue; }
    scannable.push(e.symbol);
  }
  return { scannable, warming, excluded };
}

/**
 * Advance the sighting roster after a successful refresh.
 * Symbols that drop out of the list are removed entirely, so a return counts as
 * a fresh entry (1 sighting → warming again). The very first snapshot ever
 * seeds the baseline at 2 so the initial universe is usable on day one — the
 * guard exists for genuine new entrants, and that is logged.
 */
export function advanceRoster(roster: Roster, current: string[], now: number): Roster {
  const fresh = Object.keys(roster).length === 0;
  if (fresh) console.info("[universe] first snapshot — baseline seeded (consecutive=2); warm-up applies to later entrants");
  const next: Roster = {};
  for (const sym of current) {
    const prev = roster[sym];
    next[sym] = {
      consecutive: fresh ? 2 : prev ? prev.consecutive + 1 : 1,
      firstSeenAt: prev?.firstSeenAt ?? now,
      lastSeenAt: now,
    };
  }
  return next;
}

/** Human-readable summary of the last guard pass (for the status line). */
export function hygieneSummary(v: UniverseView): string {
  return `${v.scannable.length}✓ · ${v.warming.length} WARM · ${v.excluded.length} CUT`;
}
