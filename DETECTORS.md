# SCALP-1.0 — SMC / ICT / Price Action / SL-Hunting Detector Catalog

Every threshold below is quoted verbatim from source. Files: `src/lib/smc.ts` (detectors),
`src/lib/ai.ts` (consumption, scoring, validation), `src/lib/radar.ts` (display-layer scoring),
`src/lib/indicators.ts` (S/R, ATR), `src/lib/utils.ts` (sessions).

---

## 1. Market Structure (`smc.ts`)

### 1.1 Swing points — `findSwings(candles, k, major)`
Fractal definition, strict inequality: bar `i` is a swing high iff every high in
`[i−k, i+k]` is `≤ candles[i].h`; swing low iff every low is `≥ candles[i].l`.
- **Majors**: `k = 3` (confirmed 3 bars after the extreme — no future data at detection).
- **Minors**: `k = 2`, minus any point already classified as major.
- Output: `{i, t, price, kind, major}`. Last 8 majors drive structure; all majors +
  last 10 minors are exposed.

### 1.2 BOS / CHoCH — `structureFromSwings(majors)`
Iterates major swings in time order tracking `lastHigh` / `lastLow`:
- Close-side swing high above `lastHigh.price` → event
  `{type: trend === "bear" ? "CHoCH" : "BOS", dir: "bull", level: lastHigh.price}`, then `trend = "bull"`.
- Swing low below `lastLow.price` → mirror (`"CHoCH"` when `trend === "bull"`).
- `trend` output: last break direction (`bull` / `bear` / initial `range`).
- Engine keeps last 10 events; radar/setup engine read the most recent ones with `t` (UTC ms).

### 1.3 Trendlines — `buildTrendlines`
Last 4 major lows / last 4 major highs. Support line iff second-newest low > previous
(slope per bar, extrapolated to the last bar index); resistance iff second-newest high < previous.

---

## 2. Order Blocks & Breakers — `detectOrderBlocks` + `trackMitigation`

### Detection (anchored to every major swing)
For a major swing **low** with local ATR `a` (must be finite & > 0):
1. **Impulse test**: max *close* over the next 8 bars (`j ∈ s.i+1 … s.i+8`) minus swing
   price must be `≥ 1.8 × a`, else no OB.
2. **OB candle**: the nearest bearish candle (`close < open`) searching back up to 7 bars
   from the swing (`j ∈ s.i … s.i−7`); fallback = the swing candle itself.
3. **Zone**: `bull_ob = [candle.low, max(open, close)]`.

Major swing **high** is the mirror: min close over next 8 bars must be `≤ −1.8 × a`;
nearest bullish candle back ≤ 7 bars; `bear_ob = [min(open, close), candle.high]`.

- Overlapping same-kind zones deduped (first occurrence wins); last **10** kept.

### Mitigation / breaker conversion (candle-by-candle after `startI`)
- `bull_ob`: close `< bottom` → converts to **`breaker_bear`** ("failed OB → breaker"),
  stays active. Else low `≤ top` → `mitigated = true`; close through the zone's 50% depth
  (`bottom + 0.5 × height`) → `active = false` (consumed).
- `bear_ob`: mirror (`close > top` → `breaker_bull`).

---

## 3. Fair Value Gaps & Imbalances — `detectFVG`

Three-candle pattern at index `i` (needs `i ≥ 2`), ATR `a` at `i`:
- **Bullish gap**: `cur.low > candles[i−2].high` → zone `[candles[i−2].high, cur.low]`.
- **Bearish gap**: `cur.high < candles[i−2].low` → zone `[cur.high, candles[i−2].low]`.
- **Classification**: gap size `> 0.55 × a` → `imbalance`, else `bull_fvg` / `bear_fvg`.

**Fill tracking** (from `startI + 2`): bullish zone fills when a close drops below its
bottom; bearish when a close rises above its top (imbalance polarity inferred from the
direction of the candle at `startI + 1`). Filled → `active = false, mitigated = true`.
Kept: last 12 active + last 4 filled.

---

## 4. Liquidity Pools & Sweeps (SL Hunting) — `detectLiquidity`

### Pools
- Tolerance: `tol = max(0.28 × lastATR, 0.0009 × lastPrice)`.
- Source: last **14** major swings. Highs *above* current price → buy-side candidates;
  lows *below* → sell-side.
- Clustering: a swing joins a group when its price is within `tol` of the group's first
  member. Pool price = group extreme (max of highs / min of lows);
  `kind = touches ≥ 2 ? equal_highs/equal_lows : swing_high/swing_low`;
  `formedI = max index in group`.
- Sorted by touches desc, top **10** exposed.

### Sweeps (the actual SL-hunt events)
Only pools with `touches ≥ 2`. First candle after `formedI` where:
- **Buy-side sweep**: `high > pool.price` **and** `close < pool.price` (wick through, close back inside).
- **Sell-side sweep**: `low < pool.price` **and** `close > pool.price`.
Recorded once per pool `{i, t, side, price}`; last **8** exposed.

### SL-hunt zones (stop clusters)
Top 6 engineered pools (`touches ≥ 2`): a `±0.32 × lastATR` band on the outside of the pool —
buy side `[price, price + 0.32·ATR]`, sell side `[price − 0.32·ATR, price]`,
labelled "buy-side stops" / "sell-side stops".

### Inducement
Minor swings within the last 90 bars whose level is later taken out by an opposite
*close* (minor low with a later close below it, etc.). Last **4** exposed.

---

## 5. Premium / Discount — `buildPD`

Range = newest major swing high / newest major swing low (fallback: 60-bar extremes).
With `f(p) = rangeLow + span × p`:
- `eq = f(0.5)`
- premium band `[f(0.705), f(0.92)]`, discount band `[f(0.08), f(0.295)]`
- OTE premium `[f(0.705), f(0.79)]`, OTE discount `[f(0.21), f(0.295)]`
- **Position**: price `≥ f(0.62)` → `premium`; `≤ f(0.38)` → `discount`; else `equilibrium`.

---

## 6. Candlestick Patterns — `detectPatterns` (last 40 bars, last 14 kept)

With `range = h − l`, `body = |c − o|`:
| Pattern | Exact rule | Direction |
|---|---|---|
| Doji | `body ≤ 0.08 × range` | neutral |
| Hammer | `lower ≥ 2×body` **and** `lower ≥ 0.62×range` **and** body-bottom position `< 0.20` | bull |
| Bullish Pin Bar | same as Hammer with body-bottom position `∈ [0.20, 0.38)` | bull |
| Shooting Star | `upper ≥ 2×body` **and** `upper ≥ 0.62×range` **and** top in upper 38% **and** `upper > lower` | bear |
| Bearish Pin Bar | same geometry with `upper ≤ lower` | bear |
| Bullish Engulfing | `body > 1.05 × prevBody`, prior bearish, `c ≥ p.o` **and** `o ≤ p.c` | bull |
| Bearish Engulfing | mirror | bear |
| Inside Bar | `h ≤ prev.h` **and** `l ≥ prev.l` | neutral |

---

## 7. Support / Resistance — `indicators.ts · findSR(candles, atrArr, 8)`

- Pivots: same fractal as swings, `k = 3`.
- Cluster tolerance: `max(0.45 × lastATR, 0.0015 × lastPrice)`; a pivot joins a cluster
  within `tol` of the cluster mean.
- Only clusters with `≥ 2` touches survive. `kind`: mean ≥ last close → resistance, else support.
- `strength = min(100, touches × 18 + min(highs, lows) × 10)` — mixed-side clusters rank higher.
- Top **8** by strength.

---

## 8. Breakouts & False-Breakout Filters — `detectBreakouts`

Levels = top 5 S/R + top 4 liquidity pools with `touches ≥ 2`. For each level, scan
**confirmed** candles only (`i < n − 2`) over the last 34 bars; first cross candle where
close crosses the level and the prior close was on the opposite side:
- `closesBeyond` = 1 + further closes beyond the level within the next 3 bars.
- `volOk` = cross-candle volume `>` 20-bar volume SMA at `i`.
- **State**: `closesBeyond ≥ 2` **and** `volOk` → `confirmed`; else if any of the next 3
  closes returns across the level → `false`; else `unconfirmed`.

**Usage**: validator V6 accepts only `confirmed` (re-checked per setup); the engine's
breakout branch additionally requires the *current* candle volume above VolMA20.

---

## 9. Volume — inline 20-bar SMA (`volMA`) in `analyzeSMC`
Feeds `volOk` (breakouts) and the "Volume Confirmation" confluence
(`last candle volume > volMA[last]`).

---

## 10. How the engine consumes detectors (`ai.ts · localSetups`)

- **Long gate**: (sell-side sweep within last **8** bars) **OR** PD position = discount;
  AND an active demand zone (`bull_ob`/`bull_fvg`/`breaker_bull`) with
  `top ≤ price + 0.35·ATR` and `bottom ≥ price − 2.6·ATR`. Entry = zone top.
  **Qualification**: ≥ 2 confluences AND (≥ 3 total, OR sweep + CHoCH/BOS/pattern).
- **SL** = `min(zone.bottom, sweepPrice) − 0.30·ATR` (zone only: `bottom − 0.30·ATR`).
  **TP1** = next buy-side pool/resistance, floor **2.05R**; **TP2** = 2nd pool / range
  extreme, floor **2.8R → 3.2R**. Shorts mirror.
- **WR score**: `58 + 4·max(0, conf−2) − 6·tilt + 4·(best confluence match) − 7·(worst match)`,
  clamped `[55, 88]`, must be `≥ 60`; confidence `≤ 92` (+3 if HTF aligned).
- **Breakout branch**: entry at level, SL `±1.1·ATR`, TPs 2.1R / 3.4R.
- **Validators V1–V6**: bounds `0.99–1.01×` range; direction consistency; RR ≥ 2.0
  recomputed; WR & confidence ≥ 60; entry within **0.5%** (crypto) / **1%** (stocks/forex)
  of any detected level (zone edges/mid, SL-hunt edges, S/R, pools, swings, eq, PD bands);
  breakout filter re-verified.
- **Validity windows**: sweep **15** / zone **30** / structure **45** setup-candles from the
  confirming close; instant expiry on reclaim close, full mitigation / 2 touches (zone),
  opposite BOS/CHoCH (structure).

## 11. Sweep-evidence scoring (trap score, `buildReasoning`)

- `depthAtr = |sweepPrice − sweep-candle extreme| / ATR`
- `reclaim = sweep candle closes back inside the pool`
- `displacementAtr = max body of the next 3 candles / ATR`
- **`trapScore = round(min(100, 40·min(1, depth/0.8) + 30·(reclaim ? 1 : 0.2) + 30·min(1, disp/1.2)))`**

## 12. Zone & liquidity grades (`buildReasoning`)

- **Zone**: grade `A` iff `!mitigated && age ≤ 40 bars`, else `B`; distance = |entry − zone mid| / ATR.
- **Liquidity**: grade `A` ≥ 3 touches, `B` = 2, `C` = 1; distance = |pool − entry| / ATR.

## 13. Sessions (`utils.ts · detectSession`, UTC hours)

| Window | Session | WR bonus |
|---|---|---|
| 00–07 | Asia | 0 |
| 07–12 | London | +2 |
| 12–21 | New York | +2 |
| 21–24 | Off-session | −2 |

Radar killzone: **12–16 UTC** (London close × NY open) scores 10/10.

## 14. Radar display score (`radar.ts · scoreCandidate`, Σ = 100, floor default 55)

| Component | Max | Rule |
|---|---|---|
| HTF bias | 20 | aligned 20 · ranging 8 · against 0 |
| Liquidity | 20 | A 20 / B 13 / C 7 − `min(4, max(0, round((dist−1)·2)))` |
| Sweep | 15 | `round(trapScore/100 × 15)` |
| Structure | 15 | aligned CHoCH 15 · BOS 12 · else 0 |
| Zone | 10 | A 10 · B 7 · none 0 |
| Session | 10 | overlap 10 · London/NY 7 · Asia 3 · off 0 |
| False-breakout | 10 | breakout setup 10 · non-breakout neutral 6 |
