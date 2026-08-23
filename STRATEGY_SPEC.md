# TradeVision AI — Strategy + Backtest Audit Specification

Version: 1.0 · Scope: `src/lib/smc.ts`, `src/lib/ai.ts` (local engine + validator), `src/lib/backtest.ts`, `src/lib/performance.ts`, `src/lib/indicators.ts`, `src/lib/marketData.ts`.
Every number below is quoted from shipped code, not from intent. Unknowns and biases are disclosed in §B.8.

---

## PART A — STRATEGY SPEC

### A.1 Timeframes

| Role | Mapping (STF → used TF) |
|---|---|
| Signal/execution (STF) | user-selected: `5m 15m 30m 1h 4h 1d` |
| Higher (HTF) | 5m→15m · 15m→1h · 30m→1h · 1h→4h · 4h→1d · 1d→1d |
| Lower (LTF) | 5m→5m · 15m→5m · 30m→15m · 1h→15m · 4h→1h · 1d→4h |

All detection (structure, zones, liquidity) runs on **STF**; HTF is used for bias alignment and as a confluence credit only. LTF is displayed/contextual; the deterministic engine does not gate entries on LTF candles. Window = last **300 candles per TF**.

### A.2 Pre-computed structure (STF)

```text
Swings:      fractal k=3 (major), k=2 (minor)   # ±3 bars each side
BOS/CHoCH:   major swing high > prev major high → event(level=prevHigh)
             type = CHoCH if current trend==bear else BOS; then trend:=bull
             (mirror for lows)
OrderBlock:  swing low qualifies iff max(close[i+1..i+8]) − low ≥ 1.8×ATR(14)
             OB candle = last bearish candle (c<o) within 7 bars back of swing
             bull_ob zone = [candle.low , max(open,close)]        # wick low → body top
             dedupe overlapping same-kind, keep 10 most recent
Mitigation:  bull_ob: low ≤ top → mitigated
             close ≤ bottom + 0.5×depth → zone dead
             close < bottom → flips to breaker_bear (stays active, reversed polarity)
FVG:         candles[i].low > candles[i−2].high → zone [c[i−2].high, c[i].low]
             gap > 0.55×ATR → classified "imbalance" else "fvg"
             filled when close crosses far edge → inactive
Liquidity:   tol = max(0.28×ATR, 0.0009×price)
             cluster major swings within tol → pool (touches = cluster size)
             above price → buy-side (BSL), below → sell-side (SSL)
Sweep:       pool with touches ≥ 2; first candle after formation with
             high > pool AND close < pool  → sell-side swept (mirror for buy)
SL-hunt:     ±0.32×ATR band around each pool with touches ≥ 2 (top 6)
Premium/Disc: range = last major swing high/low (fallback: 60-bar extremes)
             eq = 50% · premium band [70.5%, 92%] · discount band [8%, 29.5%]
             OTE sub-bands [70.5–79%] and [21–29.5%]
             position := premium if px ≥ 62% level · discount if px ≤ 38% level
Patterns:    last 40 bars — Doji (body ≤ 8% of range),
             Hammer/Pin (lower wick ≥ 2×body AND ≥ 62% of range, wick-low ratio < 38%),
             Shooting Star (mirror), Engulfing (body > 1.05× prev body, opposite colour,
             body engulfs prev body), Inside Bar (H ≤ prevH AND L ≥ prevL)
Breakout:    levels = top-5 S/R + top-4 liquidity pools (touches ≥ 2)
             cross within last 34 bars with prior close on other side
             closesBeyond = closes beyond level in next ≤3 bars
             confirmed ⟺ closesBeyond ≥ 2 AND break-candle volume > VolMA(20)
             else "false" if a close returns to the other side
```

### A.3 Bias model (HTF/STF/LTF)

```text
score  = trend(bull +2 / bear −2)
       + (EMA50 > EMA200 ? +1 : −1)
       + (MACD_hist > 0 ? +1 : −1)
       + (RSI14 > 56 ? +1 : RSI14 < 44 ? −1 : 0)
       + (close > VWAP ? +0.5 : −0.5)
       + Σ last-2 structure events (bull +1 / bear −1)
bias = bullish if score ≥ +2 · bearish if ≤ −2 · else ranging
```

### A.4 Entry conditions — LONG (deterministic engine)

```text
GATE:  (sell-side sweep within last 8 bars  OR  pd.position == "discount")
   AND ∃ active demand zone z ∈ {bull_ob, bull_fvg, breaker_bull}
       with  z.top ≤ price + 0.35×ATR  AND  z.bottom ≥ price − 2.6×ATR
       (take the one with highest top — nearest zone)

CONFLUENCES (each must be literally true on detected data):
   C1 zone concept            "Order Block" | "Fair Value Gap" | "Breaker Block"
   C2 "Liquidity Sweep"       if sell-side sweep in last 8 bars
   C3 "Discount Zone"         if pd.position == discount
   C4 "CHoCH" / "BOS"         last bullish structure event within 30 bars
   C5 candle pattern          last bullish pattern within 6 bars
   C6 "HTF Alignment"         htf_bias == bullish OR stf trend == bull
   C7 "Support/Resistance"    nearest support within 0.8×ATR of z.top

QUALIFY:  |C| ≥ 2 AND ( |C| ≥ 3  OR  (C2 AND (C4 OR C5)) )

ENTRY = z.top
```

### A.5 Stop loss — exact formula

```text
LONG:  slBase = C2 ? min(z.bottom, sweep.price) : z.bottom
       SL     = slBase − 0.30×ATR(14)                     # structure + wick buffer
       INVALIDATION_LEVEL = slBase − 0.60×ATR
SHORT: slBase = C2 ? max(z.top, sweep.price) : z.top
       SL     = slBase + 0.30×ATR
BREAKOUT (both dirs): SL = level ∓ 1.10×ATR  · invalidation = SL
```

### A.6 Take profit / management

```text
risk = |ENTRY − SL|

TP1 = nearest opposing liquidity pool, else nearest S/R     # LONG: first BSL above / first resistance
    fallback / floor: TP1 = ENTRY + 2.05×risk               # hard RR floor
TP2 = second opposing pool, else pd.rangeHigh               # range extreme
    floor: if TP2 − ENTRY < 2.80×risk → TP2 = ENTRY + 3.20×risk

BREAKOUT: TP1 = ENTRY ± 2.10×risk · TP2 = ENTRY ± 3.40×risk

Execution model (backtest; live journal is user-attested):
  TP1 hit          → SL moved to ENTRY (breakeven stop), position trails
  TP2 hit          → flat, credited |TP2−ENTRY|/risk  R
  SL hit pre-TP1   → flat, −1R
  SL hit post-TP1  → flat, 0R (breakeven)
  60-candle timeout→ mark-to-market, bucketed win/loss/BE at ±0.1R
  No fixed partial size at TP1 — TP1 functions as risk-off (SL→BE), not a scaled exit.
```

### A.7 Filters, vetoes, scoring (exact values)

Scoring (structural setups):

```text
est_win_rate = 58
             + 4 × max(0, |C| − 2)
             − 6  if TILT (last-10 closed trades: n ≥ 5 AND winRate < 30%)
             + 4  if any C ∈ journal best-confluences
             − 7  if any C ∈ journal worst-confluences
clamp(est, 55, 88)  ·  REQUIRE est ≥ 60  else discard
confidence = min(92, est + (3 if C6 else 0))   # breakout setups capped at 90
```

Post-generation validator (anti-hallucination; runs on **every** setup, AI or local — any single failure discards it):

```text
V1  entry, SL, TP1, TP2 ∈ [min(low)×0.99 , max(high)×1.01] of the 300-candle STF window
V2  direction consistency:  Long ⟹ SL < E < TP1 ≤ TP2   (mirror for Short)
V3  RR recomputed = |TP1−E|/|E−SL| ≥ 2.00
V4  est_win_rate ≥ 60 AND confidence ≥ 60
V5  |E − ref| / E ≤ 0.5% (crypto) | 1.0% (stock/forex) for at least one ref ∈
    { zone tops/bottoms/midpoints, SL-hunt band edges, S/R prices,
      liquidity pools, all swing prices, eq, premium/discount band edges }
V6  breakout setups only: a confirmed breakout (closesBeyond ≥ 2, volume > VolMA20,
    same direction) exists within 2× the V5 tolerance of entry
CAP max 2 setups per run, ranked by confidence.
```

Additional vetoes: breakout setup requires the **signal candle** volume > VolMA(20); breakout setups are skipped if 2 structural setups already exist.

### A.8 Session / time restrictions

**None.** The engine has no clock, session, or day-of-week filter; signals are timeframe-agnostic. News acts as an advisory `news_caution` field, never a veto. (Integrators adding session filters do so outside this codebase.)

### A.9 Risk management

```text
risk_amount    = account_size × risk_percent / 100        # default 1%
position_size  = risk_amount / |entry − SL|                # units of asset
notional       = position_size × entry
profit(TPx)    = position_size × |TPx − entry| · loss(SL) = −risk_amount
```

Max 3 concurrent open trades and correlated-pair doubling are **house rules shown in UI**; the engine does not enforce a cap and there is **no daily loss limit** implemented.

### A.10 Cost model

**Fees 0%, slippage 0%, on every leg** (entry, TP1-move, TP2, SL). All R-multiples and equity curves are gross. Limit-entry fills are assumed at the exact zone edge; see §B.8.

---

## PART B — BACKTEST METHODOLOGY

### B.1 Lookahead control

Signal at bar `i` is computed on `candles[0..i]` only — `computeIndicators`, `analyzeSMC`, `deriveBias`, `localSetups`, `validateSetup` all receive the truncated window. FVG/OB/structure detectors consume indices ≤ `i`. Trade management executes strictly on bars `> i`. **The feed's final (still-forming) candle is included** in live analyses, so a live signal can repaint until that candle closes; backtests are unaffected because the scan stops at `len − 20`.

### B.2 Costs

None — §A.10. If you need net results, apply your own haircut; the engine charges nothing on any leg.

### B.3 Engine parity

**Yes, same code path.** `backtest.ts` imports `localSetups`, `validateSetup`, `analyzeSMC`, `computeIndicators`, `deriveBias` from the live modules. Declared divergences (conservative direction unless noted):

```text
backtest.perf        = zeroed PerformanceSummary   # no self-learning weights (±4/−7/−6 terms inactive)
backtest.newsCount   = 0                           # news caution suppressed
backtest.htfSmc      = STF window's own SMC        # HTF bias derived on same window (optimistic bias)
max 1 concurrent trade vs live's soft 3-trade guidance
```

### B.4 Out-of-sample discipline

**No OOS split exists.** Single in-sample pass over the fetched window; thresholds were set a priori, not tuned on these runs, but any reported number is in-sample by construction. Treat results as a viability screen, not an edge estimate.

### B.5 Sample size

Feed- and timeframe-dependent, computed as:

```text
need   = min(ceil(days × 1440 / TF_minutes) + 220, 1600)
lookback = 220 bars (signal warm-up, never traded)
scan     = bars [220 .. len−20], step = max(4, round(len/160))
```

Typical: crypto 1h ≈ 1600 candles (Binance paginated) → ~780 candidate evaluations; crypto 1d/5d range ≈ 300 candles → ~40 evaluations. Validated-trade counts per run are small and reported per run (`trades.length`, plus `skippedInvalid` — candidates that failed V1–V6).

### B.6 Walk-forward or single

Single execution pass with **rolling re-analysis** (every `step` bars the full detector stack re-runs on the extended window — walk-forward *signal generation*), followed by one simulated management pass. No parameter re-fitting, no anchored walk-forward optimization. 3-bar cooldown after each exit; 60-bar max hold (§A.6).

### B.7 Reported results (definitions, exact)

```text
winRate        = wins / (wins + losses)              # breakevens excluded from denominator
profitFactor   = Σ(win R) / |Σ(loss R)|, capped 99
expectancy     = mean(pnlR) over ALL trades, incl. 0R breakevens and timeouts
maxDrawdown    = peak-to-trough on cumulative-R equity curve, in R
sharpe         = mean(pnlR) / sample_sd(pnlR)        # per-trade, n−1, R-units (not annualized)
netR           = final cumulative R
```

Values are per-run outputs, not constants — the engine refuses to publish fixed historical numbers.

### B.8 Known biases (read before integrating)

1. **Limit-entry fill assumed**: entry = zone edge (bounded ≤ 0.35×ATR from signal close by the zone gate) is credited without an intra-bar touch check.
2. **TP2 priority on ambiguity**: if one bar spans both TP2 and (trailing) SL, TP2 wins — optimistic.
3. **HTF collapsed onto STF** in backtests (§B.3) — the "HTF Alignment" confluence is easier to earn than live.
4. **Gross results** — no fees/slippage.
5. **In-sample only**, small samples, single-asset per run.

---

## PART C — LIVE SIGNAL FORMAT

### C.1 Signal object (one JSON per validated setup)

```text
{
  id, direction: "Long"|"Short",
  entry_price, stop_loss, take_profit1, take_profit2,
  risk_reward_ratio,            # recomputed at validation, ≥ 2.0
  estimated_win_rate_percent,   # ≥ 60
  confidence_score_0_100,       # ≥ 60, ≤ 92
  invalidation_level,
  trade_rationale, confluences: string[],
  news_caution: string|null, risk_management_note: string|null,
  isBreakout: bool,
  validation: { passed, checks: [{name, passed, detail} ×5–6] },
  position: { riskAmount, positionSize, notional, profitAtTp1, profitAtTp2, lossAtSl },
  source: "TradeVision Offline Engine" | "OPENAI" | "ANTHROPIC" | ...
}
```

Context envelope: `symbol, assetType, timeframe, htf, ltf, generatedAt (ms epoch), lastPrice, dataSource ("Binance"|"OKX"|"Yahoo Finance"|"Stooq"|"SIM"), simulated: bool, htf_bias/stf_bias/ltf_bias, key_levels[], liquidity_pools[], news[≤5], sentiment, performance summary`.

**Expiry:** no TTL field. Logical expiry = `invalidation_level` (a close beyond it voids the setup) or the next structural change; analyses auto-refresh every 90 s when enabled, so a signal older than one refresh cycle should be re-derived.

### C.2 Firing cadence

Signals fire **per analysis run** — on-demand button press or the 90-second auto-refresh — evaluated on the last closed candle (+ the forming candle, see §B.1). There is **no per-tick or streaming signal path**; price polling (5 s) drives the chart, alerts and P&L only.
