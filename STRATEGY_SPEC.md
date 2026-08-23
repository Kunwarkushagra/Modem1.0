# STRATEGY_SPEC v2 — TradeVision AI Ultimate Pro (SCALP-1.0)

> Canonical specification of the trading logic shipped in this codebase.
> Source of truth: `src/lib/ai.ts` (gates, scoring, validator V1–V6, validity, reasoning),
> `src/lib/smc.ts` (structure/zone/liquidity constants), `src/lib/backtest.ts` (execution + cost model).
> Every threshold below is the exact value used in code.

---

## PART A — CORE STRATEGY RULES

### A.1 Timeframes
| Role | Value |
|---|---|
| Setup TF (STF) | user-selected ∈ {5m, 15m, 30m, 1h, 4h, 1d} |
| HTF map | 5m→15m, 15m→1h, 30m→1h, 1h→4h, 4h→1d, 1d→1d |
| LTF map | 5m→5m, 15m→5m, 30m→15m, 1h→15m, 4h→1h, 1d→4h |
| Candle window | 300 per timeframe |
| Backtest warm-up lookback | 220 candles; scan stops at `len − 2` |

### A.2 Detection constants (smc.ts)
```
swing fractal k        = 3 (major), 2 (minor)
order block impulse    ≥ 1.8 × ATR(14) within 8 candles of swing
OB source candle       = last opposite-color candle within 7 bars before swing (fallback: swing candle)
FVG                    3-candle gap; gap > 0.55 × ATR ⇒ reclassified "imbalance"
liquidity cluster tol  = max(0.28 × ATR, 0.0009 × price)
SL-hunt zone width     = 0.32 × ATR beyond pool
breakout confirmed     ⇔ closes_beyond ≥ 2 AND volume > VolMA(20)
premium/discount       range = last 8 major swings; bands 0.705/0.79 (OTE high), 0.21/0.295 (OTE low)
position classification: premium ⇔ price ≥ 62% of range; discount ⇔ ≤ 38%
structure: BOS = break in trend direction; CHoCH = break against trend
mitigation: OB touched ⇒ partial; close through 50% of OB ⇒ inactive; close through far edge ⇒ breaker (flipped)
```

### A.3 Entry gates (exact, ai.ts `localSetups`)
```
LONG gate:
  (sell_side_sweep within last 8 candles  OR  pd.position == "discount")
  AND exists active demand zone Z ∈ {bull_ob, bull_fvg, breaker_bull} with
        Z.top ≤ price + 0.35×ATR  AND  Z.bottom ≥ price − 2.6×ATR
  entry = Z.top

qualify ⇔ |confluences| ≥ 2 AND (|confluences| ≥ 3 OR (sweep AND (CHoCH|BOS|pattern)))

confluence set (each binary):
  Zone type (OB / FVG / Breaker)          — always present by construction
  Liquidity Sweep                          — sweep within 8 bars
  Discount/Premium Zone                    — pd position supports direction
  CHoCH or BOS (dir-aligned, ≤ 30 bars)
  Candlestick pattern (dir-aligned, ≤ 6 bars)
  HTF Alignment                            — htf_bias aligned OR stf trend aligned
  Support/Resistance                       — S/R within 0.8×ATR of zone edge
```
SHORT is the exact mirror (buy-side sweep / premium / bear zones / entry = Z.bottom).

Breakout branch (max 1, only if <2 reversal setups already):
```
requires: confirmed breakout (≥2 closes beyond + volume > VolMA20)
          AND current volume > VolMA20
entry = breakout level; SL = level ∓ 1.1×ATR; TP1 = 2.1R; TP2 = 3.4R
```

### A.4 Stop loss (exact formulas)
```
reversal:  SL = zone_far_edge_or_sweep_extreme ∓ 0.3×ATR
           (long: min(Z.bottom, sweep.price) − 0.3×ATR; short: max(Z.top, sweep.price) + 0.3×ATR)
breakout:  SL = breakout_level ∓ 1.1×ATR
invalidation_level = SL_base ∓ 0.6×ATR (thesis-void line, beyond SL)
```

### A.5 Take profits / management
```
TP1 = min(nearest opposite liquidity pool, nearest S/R);  floor = entry + 2.05×risk
TP2 = 2nd liquidity pool, else dealing-range extreme;      floor = 2.8×risk → use 3.2×risk
management (live + backtest):
  TP1 hit  ⇒ stop moves to breakeven (fill price)
  BE stop hit ⇒ close at fill (0R gross)
  TP2 hit  ⇒ full close
  timeout  ⇒ 60 candles after fill ⇒ close at market
no fixed partials; no trailing beyond BE
```

### A.6 Scoring (WR estimate & confidence)
```
WR% = clamp( 58
           + 4 × max(0, |confluences| − 2)
           − 6 × tilt                        // tilt ⇔ last ≥5 closed trades, WR < 30%
           + 4 × bestConfluencePresent       // journal-mined, ≥2 samples
           − 7 × worstConfluencePresent
           + session_bonus,                  // Asia 0 | London +2 | New York +2 | Off-session(21–24 UTC) −2
           55, 88)
gate: WR% ≥ 60 required to emit
confidence = min(92, WR% + 3×HTF_aligned)   // breakout setups capped at 90
```

### A.7 Validator V1–V6 (anti-hallucination; any fail ⇒ discard)
```
V1 bounds:        entry, SL, TP1, TP2 ∈ [min(low)×0.99, max(high)×1.01] of STF data
V2 consistency:   Long: SL < entry < TP1 ≤ TP2 ; Short: TP2 ≤ TP1 < entry < SL
V3 RR ≥ 2.0       recomputed from prices
V4 WR ≥ 60 AND confidence ≥ 60
V5 entry anchored: ∃ detected level (OB/FVG zone edge|mid, SL-hunt edge, S/R, liquidity,
                  swing, EQ, premium/discount bands) with |entry − level|/entry ≤ tol,
                  tol = 0.5% crypto | 1% stock/forex
V6 (breakouts only): matching confirmed breakout with volOk AND closes_beyond ≥ 2
```
Rejected setups are retained with the exact failing gate string (`reasoning.rejectionReason`) and surfaced as "WHY NOT".

### A.8 Session rules
```
UTC hours → session:  [0–7) Asia (+0) | [7–12) London (+2) | [12–21) New York (+2) | [21–24) Off (−2)
bonus applied inside the WR formula (A.6). No hard time-of-day trade veto.
```

### A.9 Risk management
```
risk_amount    = account_size × risk_percent%        // default 1%
position_size  = risk_amount / |entry − SL|
max open       = 3 (advisory; UI surfaces exposure)
no daily loss limit enforced in code (house rules are advisory text)
```

---

## PART B — SIGNAL VALIDITY (SCALP-1.0)

### B.1 Signal object (every gate-passing setup)
```
{
  type:            "sweep" | "zone" | "structure"
  generatedAt:     UTC ms of the CONFIRMING candle CLOSE (= candle.t + stepMs)
  displayTimeIST:  "YYYY-MM-DD HH:mm IST" (Asia/Kolkata)
  validCandles:    sweep=15 | zone=30 | structure=45   (setup-TF candles)
  validTillTs:     generatedAt + validCandles × stepMs
  reclaimLevel:    sweep→pool price | zone→far edge | structure→breakout level
  zoneTop/Bottom:  zone-type only
}
type assignment: sweep present ⇒ "sweep"; breakout ⇒ "structure"; else "zone"
```

### B.2 Expiry rules (evaluated on confirmed closes)
```
sweep:     EXPIRED ⇔ close crosses reclaimLevel against direction
           OR age > 15 setup-candles
zone:      EXPIRED ⇔ close through far edge (fully mitigated)
           OR zone touched twice before trigger
           OR age > 30 setup-candles
structure: EXPIRED ⇔ opposite-direction BOS/CHoCH printed after generatedAt
           OR level reclaimed (close back through breakout level)
           OR age > 45 setup-candles
```

### B.3 Entry permission
```
entry allowed ⇔ trigger candle CLOSE time ≤ validTillTs
trigger candle = first candle after signal with low ≤ entry (long) / high ≥ entry (short)
past validTill ⇒ EXPIRED badge; TAKE TRADE disabled; backtest counts expiredBeforeTrigger
re-formation at the same zone later ⇒ NEW signal object with its own generatedAt/validTill
```

### B.4 Live status evaluation (per second in UI; re-validated each refresh)
```
EXPIRED ⇔ now > validTillTs
        OR price crosses reclaimLevel against direction (live tick)
        OR (type=structure) opposite structure event with t > generatedAt in latest analysis
UI: "VALID TILL HH:mm IST · Xm Ys" countdown; EXPIRED badge with reason
```

---

## PART C — TRADE REASONING (stored per setup: accepted, expired, rejected)

```
{
  htfBias, htfRationale:   bias + contributing factors string
                           (trend, EMA50/200 stack, MACD hist sign, RSI, VWAP side, last BOS/CHoCH)
  liquidity:  { grade: A(≥3 touches)|B(2)|C(1), source: "equal_lows ×N", distanceAtr } | null
  sweep:      { depthAtr: |pool − wick_extreme|/ATR,
                reclaim: close back inside (bool),
                displacementAtr: max body of next 3 candles / ATR,
                trapScore: round(min(100, 40·min(1,depth/0.8) + 30·(reclaim?1:0.2)
                                     + 30·min(1,displacement/1.2))) } | null
  structureEvent: { type: BOS|CHoCH, dir, ts, level } | null
  zone:       { kind, grade: A(active ∧ unmitigated ∧ age≤40) | B, distanceAtr } | null
  session:    { name, bonus }                      // per A.8
  plannedRR:  |TP1 − entry| / |entry − SL|
  entryModel: execution contract string (Part D)
  rejectionReason: exact failing gate(s) + detail, else null
}
```
UI renders an expandable **"WHY THIS TRADE / WHY NOT"** block per setup card, plus a
collapsed "WHY NOT · N candidates rejected" list with the exact gate strings.

---

## PART D — HONEST EXECUTION MODEL (mandatory, live + backtest)

### D.1 Confirmation & fills
```
1. Analysis consumes CONFIRMED candles only: the forming (last) candle is dropped
   from indicators/SMC/setup generation (chart-only). No repaint path remains.
2. generatedAt = close time of the confirming candle.
3. Trigger candle = first confirmed candle reaching entry.
4. Fill = OPEN of the candle AFTER the trigger close.
   SL/TP1/TP2 are shifted by (fill − planned_entry), preserving planned R geometry.
5. Live paper account places a limit at the level; the next-open fill is the
   backtest contract (both documented in reasoning.entryModel).
```

### D.2 Cost model — charged on EVERY trade, BOTH legs
```
entry leg:  0.02% maker  + 0.05% slippage = 0.07% of entry notional
exit leg:   0.10% taker  + 0.05% slippage = 0.15% of exit notional
round trip: 0.22% of notional
feesR = (fill × 0.0007 + exit × 0.0015) / |fill − SL|
netR  = grossR − feesR                      ← ledger of record
```

### D.3 Net ledger & metrics
```
outcome:  netR > +0.01 ⇒ win | netR < −0.01 ⇒ loss | else breakeven
win rate: wins / (wins + losses)            // BE excluded
PF:       Σ net wins / |Σ net losses|       // capped 99
expectancy, Sharpe, equity curve, max drawdown: ALL computed from netR series
grossR retained per trade for display (GROSS / FEES / NET columns)
```

---

## PART E — BACKTEST METHODOLOGY

```
lookahead prevention:
  - signal generated on candles[0..i] (i ≤ len−2; forming candle never analyzed)
  - trigger/entry/management read candles > i only; fill at open[i_trigger+1]
  - expiry events (reclaim/mitigation/touch/opposite-BOS) evaluated on confirmed closes
costs:        D.2 applied to every simulated trade, both legs
live parity:  identical code path — localSetups() + validateSetup() imported from ai.ts
  declared divergences: learning weights zeroed (EMPTY_PERF), newsCount=0,
  HTF collapsed onto STF (htfSmc = stf smc), max 1 concurrent position
funnel:       generated → expiredBeforeTrigger → entered → W/L/BE
              (expired never enter; re-formed signals are new generations)
cadence:      generation every step = max(4, round(len/160)) candles while idle;
              validity checks every candle while pending; opposite-structure
              re-scan every 4 candles (structure signals); cooldown 3 bars post-exit,
              2 bars post-expiry; forward management cap 60 candles
walk-forward: rolling signal generation; single execution pass
OOS:          NO untouched out-of-sample split — in-sample; user must validate on a
              second non-overlapping window (documented in UI "Honest Read")
known biases: limit-entry assumed reachable within 0.35×ATR band; TP2 checked before
              SL on same-bar ambiguity except when trailing; BE exits now realize
              −fees (honestly booked as small losses via the ±0.01R band)
metrics:      winRate (net, BE excluded), PF (net, cap 99), expectancy = mean(netR)
              incl. 0R trades, maxDrawdown in R from net equity, Sharpe = mean/std(netR)
sample:       per-run — symbol/TF/days selected by user; crypto history via Binance
              pagination, stocks/forex bounded by feed range (Yahoo ≤ 3mo intraday)
```

---

## PART F — LIVE SIGNAL FORMAT

### F.1 Signal payload (per validated setup)
```
setup {
  id, direction: "Long"|"Short",
  entry_price, stop_loss, take_profit1, take_profit2,   // planned levels
  risk_reward_ratio (recomputed), estimated_win_rate_percent, confidence_score_0_100,
  invalidation_level, trade_rationale, confluences[], news_caution?, risk_management_note?,
  validation: { passed, checks: V1..V6 [{name, passed, detail}] },
  position: { riskAmount, positionSize, notional, profitAtTp1/2, lossAtSl },
  signal:   Part B object (type, generatedAt UTC, displayTimeIST, validCandles,
            validTillTs, reclaimLevel, zoneTop/Bottom, expiryRules),
  reasoning: Part C object
}
envelope {
  symbol, assetType, timeframe, htf, ltf,
  dataSource ("Binance"|"OKX"|"Yahoo Finance"|"Stooq"|"SIM"),
  simulated: bool, confirmedOnly: true,
  htf_bias/stf_bias/ltf_bias, key_levels[], liquidity_pools[],
  news[≤5], sentiment (Fear&Greed) | null,
  rejectedSetups[] (with reasoning.rejectionReason),
  performance (journal learning block)
}
```
Expiry semantics: no fixed TTL field — expiry is `validTillTs` + event rules (B.2);
UI shows live IST countdown and flips to EXPIRED with the exact reason.

### F.2 Timing
```
signals fire per ANALYSIS RUN: on-demand scan button + optional 90s auto-refresh.
generation uses the newest CONFIRMED candle close; never intrabar.
price polling (15s) drives chart/alerts/live expiry checks only — not signal generation.
alerts: optional Telegram push when a setup passes V1–V6; price alerts evaluated on poll.
```

---

## INTEGRATION CHECKLIST (for another terminal)

1. Implement A.2 detection exactly (constants are the edge, not decoration).
2. Keep A.3–A.7 ordering: gates → scoring → validator; discards are observable.
3. Adopt B validity verbatim — the expiredBeforeTrigger funnel stage is mandatory.
4. Adopt D costs verbatim; report net and gross separately; never net-of-nothing.
5. Reproduce E cadence (step, cooldowns, 60-bar forward cap) before comparing numbers.
6. Do not trust a backtest until it survives a non-overlapping OOS window (E).
