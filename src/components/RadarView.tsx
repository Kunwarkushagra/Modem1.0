import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AssetType, Bias, InsightState, RadarCandidate, RadarTf, ScanFunnel, Settings, SymbolScanState, Timeframe, Trade } from "../lib/types";
import { radarBeep, revalidateCandidate, scanSymbol, scanUniverse } from "../lib/radar";
import type { BatchProgress } from "../lib/radar";
import { buildInsightPayload, requestInsight } from "../lib/aiInsight";
import { fetchLastPrice, fetchTop30Usdt } from "../lib/marketData";
import { advanceStreaks, getTop30, MIN_SCANNABLE_STREAK, putTop30, TOP30_TTL_MS } from "../lib/cache";
import { addTrade, loadTrades } from "../lib/journal";
import { loadFrequencyGate, TM_VARIANTS, variantById } from "../lib/tmVariant";
import { cls, fmtIST, fmtPrice, fmtTime, TF_MINUTES } from "../lib/utils";
import { Badge, Btn, Card, IBrain, ICheck, IPlus, IRadar, IRefresh, IWarn, IX, Segmented, useToast } from "./ui";

const blank = (symbol: string): SymbolScanState => ({ symbol, status: "idle", lastScanAt: 0, lastCloseEpoch: 0, lastPrice: null, error: null, candidatesFound: 0 });
const ZERO_FUNNEL: ScanFunnel = { generated: 0, passedGates: 0, passedFloor: 0 };

/* ---------------- tiny pieces ---------------- */

function ScoreDial({ score }: { score: number }) {
  const R = 23, C = 2 * Math.PI * R;
  const col = score >= 80 ? "var(--color-bull-400)" : score >= 65 ? "var(--color-gold-400)" : "var(--color-fog-300)";
  return (
    <div className="relative h-14 w-14 shrink-0">
      <svg viewBox="0 0 56 56" className="h-14 w-14 -rotate-90">
        <circle cx="28" cy="28" r={R} fill="none" stroke="var(--color-ink-600)" strokeWidth="4.5" />
        <circle cx="28" cy="28" r={R} fill="none" stroke={col} strokeWidth="4.5" strokeLinecap="round"
          strokeDasharray={`${(score / 100) * C} ${C}`} style={{ transition: "stroke-dasharray 0.7s cubic-bezier(0.2,0.7,0.2,1)" }} />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center leading-none">
        <span className="font-mono text-[15px] font-bold" style={{ color: col }}>{score}</span>
        <span className="font-mono text-[7px] tracking-widest text-fog-500">/100</span>
      </div>
    </div>
  );
}

function Countdown({ validTill, now, stepMs }: { validTill: number; now: number; stepMs: number }) {
  const ms = validTill - now;
  const mm = Math.max(0, Math.floor(ms / 60000));
  const ss = Math.max(0, Math.floor((ms % 60000) / 1000));
  const candles = Math.max(0, Math.ceil(ms / stepMs));
  const urgent = ms < 5 * 60000;
  return (
    <span className={cls("font-mono text-[11px] font-bold tracking-wider", urgent ? "text-bear-400 tv-blink" : "text-gold-300")}>
      {mm}:{String(ss).padStart(2, "0")} · {candles}C LEFT
    </span>
  );
}

function Row({ k, v, tone }: { k: string; v: string; tone?: string }) {
  return (
    <div className="flex gap-2"><span className="w-24 shrink-0 text-fog-500">{k}</span><span className={cls("min-w-0", tone ?? "text-fog-300")}>{v}</span></div>
  );
}

function ScoreBars({ c }: { c: RadarCandidate }) {
  const rows: Array<[string, number, number]> = [
    ["HTF BIAS", c.score.htfBias, 20], ["LIQUIDITY", c.score.liquidity, 20], ["SWEEP", c.score.sweep, 15],
    ["STRUCTURE", c.score.structure, 15], ["ZONE", c.score.zone, 10], ["SESSION", c.score.session, 10], ["FALSE-BO", c.score.falseBreakout, 10],
  ];
  return (
    <div className="space-y-1">
      {rows.map(([k, v, max]) => (
        <div key={k} className="flex items-center gap-2 font-mono text-[9.5px]">
          <span className="w-20 shrink-0 tracking-wider text-fog-500">{k}</span>
          <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-ink-700">
            <div className="h-full rounded-full bg-gold-500/80 transition-all duration-500" style={{ width: `${(v / max) * 100}%` }} />
          </div>
          <span className="w-10 shrink-0 text-right text-fog-300">{v}/{max}</span>
        </div>
      ))}
    </div>
  );
}

/* ---------------- candidate card ---------------- */

function RadarCard(props: {
  c: RadarCandidate; rank: number; now: number; settings: Settings;
  inTrade: boolean; archived?: boolean; mode: "quality" | "quantity";
  onOpenInTerminal: (h: { symbol: string; assetType: AssetType; timeframe: Timeframe }) => void;
  onLogged: () => void;
}) {
  const { c, rank, now, settings, inTrade, archived, mode } = props;
  const toast = useToast();
  const s = c.setup;
  const long = s.direction === "Long";
  const sig = s.signal;
  const r = s.reasoning;
  const stepMs = TF_MINUTES[c.timeframe] * 60000;
  const risk = Math.abs(s.entry_price - s.stop_loss);
  const v = variantById(settings.radarTmVariant);
  const tm = v.mode === "tm110";
  const partial = s.entry_price + (long ? 1 : -1) * risk;
  const runner = s.tp2_objective ? s.take_profit2 : s.take_profit1;
  const invalidated = c.status === "invalidated";
  const expired = c.status === "expired";
  const A = c.assetType;

  /* ---- AI Insight (additive opinion layer — never feeds back into the signal) ---- */
  const [insight, setInsight] = useState<InsightState>({ status: "idle" });
  const insightBusy = insight.status === "loading";
  const insightOff = !settings.aiInsightEnabled;
  const insightBlocked = invalidated || expired || !!archived || insightOff;

  const fetchInsight = async () => {
    if (insightBusy || insightBlocked) return; // debounced by state; global max-1 concurrency in the module
    setInsight({ status: "loading" });
    const payload = buildInsightPayload(c, mode);
    const { promise } = requestInsight(payload, { localKey: settings.geminiApiKey, model: settings.geminiModel });
    const out = await promise;
    if ("unavailable" in out) setInsight({ status: "unavailable", message: out.unavailable });
    else setInsight({ status: "done", result: out });
  };

  const logPaper = () => {
    if (inTrade || invalidated || expired || archived) return;
    addTrade({
      symbol: c.symbol, assetType: c.assetType, timeframe: c.timeframe,
      direction: s.direction, entry: s.entry_price, stopLoss: s.stop_loss, tp1: s.take_profit1, tp2: s.take_profit2,
      rr: s.risk_reward_ratio, confidence: c.score.total, confluences: s.confluences,
      rationale: s.trade_rationale, status: "pending", outcome: null, exitPrice: null, pnlPct: null, pnlR: null,
      closedAt: null, notes: `radar ${mode} mode · score ${c.score.total}`, source: "radar",
      signalType: s.signal?.type, signalGeneratedAt: s.signal?.generatedAt,
      signalDisplayIST: s.signal?.displayTimeIST, signalValidTill: s.signal?.validTillTs,
      insightStance: insight.status === "done" ? insight.result.stance : "none",
    });
    props.onLogged();
    toast.push("ok", `${s.direction} ${c.symbol} logged to journal (paper) · insight stance: ${insight.status === "done" ? insight.result.stance : "none"}`);
  };

  return (
    <article className={cls(
      "tv-rise relative flex flex-col overflow-hidden rounded-lg border bg-ink-800/45 transition-colors",
      invalidated ? "border-bear-600/70" : expired ? "border-ink-600 opacity-75" : rank === 0 ? "border-gold-600/70 shadow-[0_0_34px_-14px_rgba(245,184,64,0.45)]" : "border-ink-600 hover:border-ink-500",
    )}>
      {rank === 0 && !archived && !invalidated && !expired && (
        <div className="absolute right-0 top-0 rounded-bl-md bg-gold-500 px-2 py-0.5 font-display text-[9.5px] font-extrabold tracking-widest text-ink-950">TOP SETUP</div>
      )}

      {/* header */}
      <div className={cls("flex items-center gap-3 border-b px-3.5 py-2.5", invalidated ? "border-bear-600/40" : "border-ink-600/70")}>
        <ScoreDial score={c.score.total} />
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="font-display text-[15px] font-extrabold tracking-tight text-fog-100">{c.symbol}</span>
            <Badge tone={long ? "bull" : "bear"}>{long ? "LONG" : "SHORT"}</Badge>
            <Badge tone="dim">{c.timeframe.toUpperCase()}</Badge>
            <span className="font-mono text-[9px] text-fog-500">#{rank + 1}</span>
          </div>
          <div className="mt-0.5 font-mono text-[9.5px] tracking-wider text-fog-500">
            GEN {sig ? fmtIST(sig.generatedAt) : "—"} · CONF {s.confidence_score_0_100} · WR {s.estimated_win_rate_percent}%
          </div>
        </div>
        <div className="ml-auto text-right">
          {invalidated ? (
            <Badge tone="bear" className="px-2 py-1 text-[10px] font-bold">INVALIDATED — DO NOT ENTER</Badge>
          ) : expired ? (
            <Badge tone="dim" className="px-2 py-1 text-[10px] font-bold">EXPIRED</Badge>
          ) : inTrade ? (
            <Badge tone="info" className="px-2 py-1 text-[10px] font-bold">IN TRADE</Badge>
          ) : (
            <Badge tone="gold" className="px-2 py-1 text-[10px] font-bold">LIVE</Badge>
          )}
          {c.dataStale && <div className="mt-1"><Badge tone="warn" className="text-[9px]">DATA STALE</Badge></div>}
        </div>
      </div>

      {/* status strip */}
      <div className={cls("border-b px-3.5 py-1.5 font-mono text-[10.5px]", invalidated ? "border-bear-600/40 bg-bear-500/8 text-bear-300" : "border-ink-600/70 bg-ink-900/40")}>
        {invalidated || expired ? (
          <span className="flex items-center gap-1.5"><IX size={11} /> {c.invalidReason ?? "no longer valid"}</span>
        ) : inTrade ? (
          <span className="flex flex-wrap items-center gap-x-2 text-info-400">
            <ICheck size={11} /> IN TRADE — managed by trade rules.
            <span className="text-fog-500">Signal validity was for ENTRY timing only. Do NOT close a running trade because the entry countdown expired.</span>
          </span>
        ) : sig ? (
          <span className="flex flex-wrap items-center gap-x-3 text-fog-300">
            <span>VALID TILL <span className="text-gold-300">{fmtIST(sig.validTillTs)}</span></span>
            <Countdown validTill={sig.validTillTs} now={now} stepMs={stepMs} />
            <span className="text-fog-500">{sig.expiryRules}</span>
          </span>
        ) : null}
      </div>

      {/* prices */}
      <div className="grid grid-cols-4 gap-x-3 gap-y-1.5 px-3.5 py-2.5 font-mono text-[11px]">
        <div><div className="text-[9px] tracking-widest text-fog-500">ENTRY</div><div className="font-bold text-gold-300">{fmtPrice(s.entry_price, A)}</div></div>
        <div><div className="text-[9px] tracking-widest text-fog-500">STOP</div><div className="font-bold text-bear-400">{fmtPrice(s.stop_loss, A)}</div></div>
        {tm ? (<>
          <div><div className="text-[9px] tracking-widest text-fog-500">PARTIAL +1R·50%</div><div className="font-bold text-bull-400">{fmtPrice(partial, A)}</div></div>
          <div><div className="text-[9px] tracking-widest text-fog-500">RUNNER {s.tp2_objective ? "(TP2)" : "(TP1 FLR)"}</div><div className="font-bold text-bull-400">{fmtPrice(runner, A)}</div></div>
        </>) : (<>
          <div><div className="text-[9px] tracking-widest text-fog-500">TP1</div><div className="font-bold text-bull-400">{fmtPrice(s.take_profit1, A)}</div></div>
          <div><div className="text-[9px] tracking-widest text-fog-500">TP2</div><div className="font-bold text-bull-400">{fmtPrice(s.take_profit2, A)}</div></div>
        </>)}
        <div><div className="text-[9px] tracking-widest text-fog-500">RR</div><div className="text-fog-200">{s.risk_reward_ratio.toFixed(2)}</div></div>
        <div><div className="text-[9px] tracking-widest text-fog-500">INVALIDATION</div><div className="text-fog-200">{fmtPrice(s.invalidation_level, A)}</div></div>
        <div className="col-span-2"><div className="text-[9px] tracking-widest text-fog-500">MGMT ({v.short})</div><div className="truncate text-fog-400" title={v.management}>{tm ? "partial +1R → SL@BE → runner · 60-bar mark" : "TP1 → SL@BE → TP2 · 60-bar mark"}</div></div>
      </div>

      {/* INVALID-IF checklist */}
      {!archived && (
        <div className="border-t border-ink-600/70 px-3.5 py-2">
          <div className="mb-1 font-mono text-[9px] tracking-[0.18em] text-fog-500">{inTrade ? "STRUCTURAL INVALIDATION (PREMISE VOID → EXIT)" : "INVALID IF (PRE-ENTRY)"}</div>
          <ul className="space-y-0.5">
            {c.invalidChecks.map((ch) => (
              <li key={ch.id} className="flex items-start gap-1.5 font-mono text-[10px] leading-snug">
                {ch.hit ? <IX size={10} className="mt-0.5 shrink-0 text-bear-400" /> : <ICheck size={10} className="mt-0.5 shrink-0 text-bull-500/70" />}
                <span className={ch.hit ? "text-bear-300" : "text-fog-400"}>{ch.label}</span>
                <span className="ml-auto hidden pl-2 text-right text-[9px] text-fog-500 sm:block">{ch.detail}</span>
              </li>
            ))}
            {inTrade && (
              <li className="flex items-start gap-1.5 font-mono text-[10px] leading-snug">
                <IX size={10} className="mt-0.5 shrink-0 text-fog-500" />
                <span className="text-fog-400">Close beyond structural invalidation {fmtPrice(s.invalidation_level, A)} = premise void → exit</span>
              </li>
            )}
          </ul>
        </div>
      )}

      {/* confluences */}
      <div className="flex flex-wrap gap-1 px-3.5 pb-2">
        {s.confluences.map((cf) => <Badge key={cf} tone="gold" className="text-[9px]">{cf}</Badge>)}
      </div>

      {/* reasoning */}
      {r && (
        <details className="group border-t border-ink-600/70 px-3.5 py-1.5">
          <summary className="cursor-pointer select-none font-mono text-[9.5px] tracking-widest text-gold-500 hover:text-gold-300">
            {invalidated || expired ? "WHY NOT" : "WHY THIS TRADE"} · {r.session.name.toUpperCase()} ({r.session.bonus >= 0 ? "+" : ""}{r.session.bonus})
          </summary>
          <div className="mt-1.5 space-y-1 pb-1 font-mono text-[10px] leading-relaxed">
            <Row k="HTF BIAS" v={r.htfRationale} />
            <Row k="LIQUIDITY" v={r.liquidity ? `grade ${r.liquidity.grade} · ${r.liquidity.source} · ${r.liquidity.distanceAtr} ATR` : "no target pool in range"} />
            <Row k="SWEEP" v={r.sweep ? `depth ${r.sweep.depthAtr} ATR · reclaim ${r.sweep.reclaim ? "yes" : "no"} · trap ${r.sweep.trapScore}/100` : "no sweep — zone/PD entry"} tone={r.sweep ? "text-gold-300" : undefined} />
            <Row k="STRUCTURE" v={r.structureEvent ? `${r.structureEvent.type} ${r.structureEvent.dir} @ ${fmtPrice(r.structureEvent.level, A)} · ${fmtTime(r.structureEvent.ts, c.timeframe)}` : "no fresh BOS/CHoCH"} />
            <Row k="ZONE" v={r.zone ? `${r.zone.kind} grade ${r.zone.grade} · ${r.zone.distanceAtr} ATR away` : "n/a (structure setup)"} />
            <p className="pt-1 text-fog-300">{s.trade_rationale}</p>
          </div>
        </details>
      )}

      {/* score breakdown + actions */}
      <details className="group border-t border-ink-600/70 px-3.5 py-1.5">
        <summary className="cursor-pointer select-none font-mono text-[9.5px] tracking-widest text-fog-400 hover:text-fog-200">SCORE BREAKDOWN</summary>
        <div className="py-1.5"><ScoreBars c={c} /></div>
      </details>

      {/* AI INSIGHT result */}
      {insight.status !== "idle" && (
        <div className="tv-pop border-t border-ink-600/70 px-3.5 py-2">
          {insight.status === "loading" && (
            <div className="tv-scanbar flex items-center gap-2 rounded-md border border-ink-600 bg-ink-900/50 px-3 py-2 font-mono text-[10px] tracking-widest text-gold-300">
              <IBrain size={13} className="tv-blink" /> REVIEWING SIGNAL — STRUCTURED PAYLOAD ONLY…
            </div>
          )}
          {insight.status === "unavailable" && (
            <div className="flex items-center justify-between gap-2 rounded-md border border-bear-600/40 bg-bear-500/8 px-3 py-2">
              <span className="font-mono text-[10px] font-bold tracking-widest text-bear-300">{insight.message}</span>
              <Btn size="xs" variant="ghost" onClick={() => setInsight({ status: "idle" })}><IX size={10} /></Btn>
            </div>
          )}
          {insight.status === "done" && (() => {
            const r2 = insight.result;
            const tone = r2.stance === "AGREE" ? "bull" : r2.stance === "DISAGREE" ? "bear" : "dim";
            return (
              <div className={cls("rounded-md border bg-ink-900/55", r2.stance === "AGREE" ? "border-bull-600/50" : r2.stance === "DISAGREE" ? "border-bear-600/50" : "border-ink-500")}>
                <div className="flex flex-wrap items-center gap-2 border-b border-ink-600/60 px-3 py-1.5">
                  <IBrain size={13} className="text-fog-400" />
                  <span className="font-mono text-[9.5px] font-bold tracking-[0.18em] text-fog-400">AI INSIGHT</span>
                  <Badge tone={tone} className="text-[10px] font-bold">{r2.stance}</Badge>
                  <span className="font-mono text-[9.5px] text-fog-500">CONF {r2.confidence}/100</span>
                  <div className="h-1 w-16 overflow-hidden rounded-full bg-ink-700">
                    <div className={cls("h-full rounded-full", r2.stance === "AGREE" ? "bg-bull-500" : r2.stance === "DISAGREE" ? "bg-bear-500" : "bg-ink-400")} style={{ width: `${r2.confidence}%` }} />
                  </div>
                  {r2.cached && <Badge tone="info" className="text-[8.5px]">CACHED</Badge>}
                  <span className="ml-auto font-mono text-[8.5px] tracking-wider text-fog-500">{fmtIST(r2.generatedAt)} · {r2.source.toUpperCase()}</span>
                </div>
                <div className="space-y-1.5 px-3 py-2 font-mono text-[10px] leading-relaxed">
                  <p className="whitespace-pre-line text-fog-200">{r2.summary}</p>
                  {r2.keyRisks.length > 0 && (
                    <ul className="space-y-0.5">
                      {r2.keyRisks.map((k, i) => (
                        <li key={i} className="flex items-start gap-1.5 text-warn-400 text-gold-300/90"><IWarn size={10} className="mt-0.5 shrink-0" /><span>{k}</span></li>
                      ))}
                    </ul>
                  )}
                  <p className="text-fog-400">INVALIDATION (RESTATED): <span className="text-fog-100">{r2.invalidationRestated}</span></p>
                  <p className="border-t border-ink-600/50 pt-1.5 text-[9px] italic text-fog-500">{r2.disclaimer}</p>
                </div>
              </div>
            );
          })()}
        </div>
      )}

      <div className="mt-auto flex flex-wrap items-center gap-1.5 border-t border-ink-600/70 px-3.5 py-2">
        <span className="mr-auto font-mono text-[9px] text-fog-500">DISPLAY ONLY — NO AUTO-TRADE, NO SIZE ADVICE</span>
        <Btn size="xs" variant={insightOff ? "ghost" : "outline"} disabled={insightBlocked || insightBusy}
          title={insightOff ? "Enable AI Insight in Settings" : expired || invalidated ? "Signal no longer valid — insight disabled" : "Independent opinion on this exact signal (structured payload only)"}
          onClick={() => void fetchInsight()}>
          <IBrain size={11} /> {insightOff ? "AI OFF" : insightBusy ? "REVIEWING…" : "GET AI INSIGHT"}
        </Btn>
        <Btn size="xs" variant="ghost" disabled={inTrade || invalidated || expired || !!archived}
          title="Log this signal to the paper journal with the current insight stance"
          onClick={logPaper}>
          <IPlus size={11} /> LOG
        </Btn>
        <Btn size="xs" variant="ghost" onClick={() => props.onOpenInTerminal({ symbol: c.symbol, assetType: c.assetType, timeframe: c.timeframe })}>
          <IRadar size={11} /> TERMINAL
        </Btn>
      </div>
    </article>
  );
}

/* ---------------- main panel ---------------- */

export function RadarView(props: {
  settings: Settings;
  onSettingsChange: (patch: Partial<Settings>) => void;
  onOpenInTerminal: (h: { symbol: string; assetType: AssetType; timeframe: Timeframe }) => void;
}) {
  const { settings } = props;
  const toast = useToast();
  const tf = settings.radarTimeframe;
  // SCAN floor = the lower of the two display floors so both modes have candidates to filter.
  // Display filtering (QUALITY/QUANTITY/AUTO) happens AFTER scanning — generation is untouched.
  const scanFloor = Math.min(settings.radarQualityFloor, settings.quantityFloor);
  const stepMs = TF_MINUTES[tf] * 60000;

  /* dynamic universe: Binance top-30 USDT by 24h quote volume (6h IndexedDB cache) ∪ user watchlist, max 30.
     Universe Hygiene Guards v2 filter the list BEFORE scanning: stablecoins, volatility floor,
     min quote volume, price-change cap (in fetchTop30Usdt) + min list age (streaks, here). */
  const [top30, setTop30] = useState<string[]>([]);
  const [warming, setWarming] = useState<string[]>([]); // symbols in top-30 but streak < MIN_SCANNABLE_STREAK
  const [top30Age, setTop30Age] = useState<number | null>(null);
  const guardCfg = useMemo(
    () => ({ excludedBases: settings.universeExcludedBases, minQuoteVolume: settings.universeMinQuoteVolume }),
    [settings.universeExcludedBases, settings.universeMinQuoteVolume],
  );
  useEffect(() => {
    let live = true;
    (async () => {
      if (!settings.radarUseTop30) { setTop30([]); setWarming([]); setTop30Age(null); return; }
      const cached = await getTop30();
      if (cached && live) { setTop30(cached.items); setWarming(cached.warming ?? []); setTop30Age(cached.ts); }
      if (cached && Date.now() - cached.ts < TOP30_TTL_MS) return;
      try {
        const items = await fetchTop30Usdt(guardCfg);
        const streaks = await advanceStreaks(items);
        const warmingNow = items.filter((s) => (streaks[s] ?? 0) < MIN_SCANNABLE_STREAK);
        await putTop30(items, warmingNow);
        if (live) { setTop30(items); setWarming(warmingNow); setTop30Age(Date.now()); }
      } catch (e) {
        console.error("[radar] top-30 universe fetch failed —", e);
      }
    })();
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.radarUseTop30]);

  /* symbols actually scanned: scannable top-30 (streak >= 2) ∪ user watchlist, capped at 30 */
  const scannableTop30 = useMemo(
    () => top30.filter((s) => !warming.includes(s)),
    [top30, warming],
  );
  const symbols = useMemo(() => {
    const merged = settings.radarUseTop30 ? [...scannableTop30, ...settings.radarSymbols] : [...settings.radarSymbols];
    return [...new Set(merged)].slice(0, 30);
  }, [scannableTop30, settings.radarSymbols, settings.radarUseTop30]);
  /* full strip list = scannable ∪ warming (warming rendered with a chip, never scanned) */
  const stripList = useMemo(
    () => [...new Set([...symbols, ...(settings.radarUseTop30 ? warming : [])])],
    [symbols, warming, settings.radarUseTop30],
  );

  const [universe, setUniverse] = useState<Record<string, SymbolScanState>>({});
  const [candidates, setCandidates] = useState<RadarCandidate[]>([]);
  const [pending, setPending] = useState<Trade[]>([]);
  const [now, setNow] = useState(() => Date.now());
  const [funnels, setFunnels] = useState<Record<string, ScanFunnel>>({});
  const [lastFullScanAt, setLastFullScanAt] = useState<number | null>(null);
  const [manualScanning, setManualScanning] = useState(false);

  const universeRef = useRef(universe); universeRef.current = universe;
  const candidatesRef = useRef(candidates); candidatesRef.current = candidates;
  const htfRef = useRef<Record<string, Bias>>({});
  const prevTopRef = useRef<string[]>([]);
  const firstRender = useRef(true);
  const scanningRef = useRef(false);

  /* 1s clock: countdowns + time-based expiry */
  useEffect(() => {
    const t = setInterval(() => {
      const ts = Date.now();
      setNow(ts);
      setCandidates((prev) => prev.map((c) =>
        c.status === "active" && ts > (c.setup.signal?.validTillTs ?? 0)
          ? { ...c, status: "expired", archivedAt: ts, invalidReason: `validTill passed — ${c.setup.signal?.validCandles ?? 0} setup-candles elapsed` }
          : c,
      ));
    }, 1000);
    return () => clearInterval(t);
  }, []);

  const mergeCandidates = useCallback((prev: RadarCandidate[], sym: string, fresh: RadarCandidate[]): RadarCandidate[] => {
    const ts = Date.now();
    const replaced: RadarCandidate[] = [];
    const kept: RadarCandidate[] = [];
    for (const old of prev) {
      if (old.symbol !== sym || old.status !== "active") { kept.push(old); continue; }
      const twin = fresh.find((f) => f.setup.direction === old.setup.direction &&
        Math.abs(f.setup.entry_price - old.setup.entry_price) / old.setup.entry_price < 0.0015);
      if (twin) replaced.push({ ...old, status: "expired", archivedAt: ts, invalidReason: "re-formed at same zone → replaced by NEW signal with own timestamps" });
      else kept.push(old);
    }
    return [...kept, ...replaced, ...fresh].slice(-80);
  }, []);

  const [progress, setProgress] = useState<BatchProgress | null>(null);

  /* shared batch plumbing — FREQUENCY GUARD: adv v1.2.0 soft layers are reverted (run without them)
     when the last conclusive benchmark failed max(0.8 × baseline, 50) full-run trades in any window. */
  const advActive = variantById(settings.radarTmVariant).advQuality && loadFrequencyGate().ok !== false;
  const onScanResult = useCallback((res: ReturnType<typeof scanSymbol> extends Promise<infer R> ? R : never) => {
    htfRef.current[res.state.symbol] = res.htfBias;
    setUniverse((u) => ({ ...u, [res.state.symbol]: res.state }));
    setFunnels((f) => ({ ...f, [res.state.symbol]: res.funnel }));
    setCandidates((prev) => mergeCandidates(prev, res.state.symbol, res.candidates));
  }, [mergeCandidates]);
  const onScanFail = useCallback((sym: string, msg: string) => {
    setUniverse((u) => ({ ...u, [sym]: { ...(u[sym] ?? blank(sym)), status: "stale", error: msg } }));
  }, []);

  const batchScan = useCallback(async (list: string[], manual: boolean) => {
    if (scanningRef.current || !list.length) return { ok: 0, failed: 0 };
    scanningRef.current = true;
    if (manual) setManualScanning(true);
    setProgress({ done: 0, total: list.length, current: list[0] });
    const res = await scanUniverse(
      list, tf, scanFloor, advActive,
      onScanResult,
      (p) => setProgress(p),
      onScanFail,
      () => false,
      4, // concurrency limit — 30 symbols never block the UI
    );
    setLastFullScanAt(Date.now());
    scanningRef.current = false;
    if (manual) setManualScanning(false);
    window.setTimeout(() => setProgress(null), 1100);
    return res;
  }, [tf, scanFloor, advActive, onScanResult, onScanFail]);

  /* SCAN NOW — full immediate pass on confirmed candles (no waiting for the next close) */
  const scanNow = useCallback(async () => {
    const { ok, failed } = await batchScan(symbols, true);
    const activeN = candidatesRef.current.filter((c) => c.status === "active").length;
    toast.push("ok", `Scan complete · ${ok}/${symbols.length} symbols OK${failed ? ` · ${failed} failed` : ""} · ${activeN} active candidate${activeN === 1 ? "" : "s"}`);
  }, [symbols, batchScan, toast]);

  /* scanner loop — immediate batched pass on mount, then batched re-scan of symbols whose
     setup-TF confirmed close just landed (epoch check, never more than one batch at a time) */
  useEffect(() => {
    let cancelled = false;
    firstRender.current = true;
    setUniverse((u) => Object.fromEntries(symbols.map((s) => [s, u[s] ?? blank(s)])) as Record<string, SymbolScanState>);
    if (!symbols.length) return () => { cancelled = true; };

    void batchScan(symbols, false);

    const t = setInterval(() => {
      if (cancelled || scanningRef.current) return;
      const epoch = Math.floor(Date.now() / stepMs) * stepMs;
      const stale = symbols.filter((sym) => {
        const st = universeRef.current[sym];
        return st && st.status !== "scanning" && epoch > st.lastCloseEpoch;
      });
      if (stale.length) void batchScan(stale, false);
    }, 3000);

    return () => { cancelled = true; clearInterval(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbols.join("|"), tf, scanFloor, advActive]);

  /* lightweight re-validation every 5s: price vs INVALID-IF checklist + journal sync */
  useEffect(() => {
    const t = setInterval(async () => {
      setPending(loadTrades().filter((tr) => tr.status === "pending"));
      const act = candidatesRef.current.filter((c) => c.status === "active");
      if (!act.length) return;
      const prices: Record<string, number | null> = {};
      for (const sym of [...new Set(act.map((c) => c.symbol))]) {
        prices[sym] = await fetchLastPrice(sym, "crypto", tf);
      }
      setCandidates((prev) => prev.map((c) => {
        if (c.status !== "active") return c;
        const p = prices[c.symbol];
        if (p == null) return { ...c, lastCheckedAt: Date.now() }; // single poll miss ≠ stale; keep last known
        return revalidateCandidate(c, p, htfRef.current[c.symbol] ?? c.htfBiasAtGeneration, c.dataStale);
      }));
    }, 5000);
    return () => clearInterval(t);
  }, [tf]);

  useEffect(() => { setPending(loadTrades().filter((tr) => tr.status === "pending")); }, []);

  /* ---- display modes (pure view filtering — the candidate store and scoring are untouched) ----
     QUALITY  : score ≥ qualityFloor (default 65), max 5 cards
     QUANTITY : score ≥ quantityFloor (default 50), max 8 cards
     AUTO     : QUALITY if it yields ≥1 card, else QUANTITY + fallback banner (never mixed) */
  const active = useMemo(() => candidates.filter((c) => c.status === "active").sort((a, b) => b.score.total - a.score.total), [candidates]);
  const qualityList = useMemo(() => active.filter((c) => c.score.total >= settings.radarQualityFloor).slice(0, 5), [active, settings.radarQualityFloor]);
  const quantityList = useMemo(() => active.filter((c) => c.score.total >= settings.quantityFloor).slice(0, 8), [active, settings.quantityFloor]);
  const mode = settings.radarMode;
  const autoFallback = mode === "auto" && qualityList.length === 0;
  const top = mode === "quality" ? qualityList : mode === "quantity" ? quantityList : qualityList.length ? qualityList : quantityList;

  /* TOP SETUP change notifications (keyed on the visible board) */
  useEffect(() => {
    const keys = top.map((c) => c.key);
    const prev = prevTopRef.current;
    prevTopRef.current = keys;
    if (firstRender.current) { firstRender.current = false; return; }
    if (!prev || keys.join() === prev.join()) return;
    const topNow = top[0];
    const topChanged = topNow && prev[0] !== topNow.key;
    const newcomer = top.find((c) => !prev.includes(c.key));
    if (topChanged && topNow) {
      toast.push("ok", `TOP SETUP → ${topNow.symbol} ${topNow.setup.direction} @ ${fmtPrice(topNow.setup.entry_price, "crypto")} · score ${topNow.score.total}`);
      if (settings.radarSound) radarBeep(true);
    } else if (newcomer) {
      toast.push("info", `Radar: ${newcomer.symbol} ${newcomer.setup.direction} entered the board · score ${newcomer.score.total}`);
      if (settings.radarSound) radarBeep(false);
    }
  }, [top, toast, settings.radarSound]);

  const archived = useMemo(
    () => candidates.filter((c) => c.status !== "active" && c.archivedAt).sort((a, b) => (b.archivedAt ?? 0) - (a.archivedAt ?? 0)).slice(0, 24),
    [candidates],
  );
  const anyScanning = Object.values(universe).some((u) => u.status === "scanning");
  const nextScanS = Math.max(0, Math.ceil((stepMs - (now % stepMs)) / 1000));
  const inTradeFor = (c: RadarCandidate) => pending.some((t) => t.symbol === c.symbol && t.direction === c.setup.direction);
  const activeCount = active.length;

  /* DEBUG funnel aggregates — where candidates die */
  const agg = useMemo(() => {
    const g = Object.values(funnels).reduce((a, f) => ({ generated: a.generated + f.generated, passedGates: a.passedGates + f.passedGates, passedFloor: a.passedFloor + f.passedFloor }), { ...ZERO_FUNNEL });
    return {
      ...g,
      expired: candidates.filter((c) => c.status === "expired").length,
      invalidated: candidates.filter((c) => c.status === "invalidated").length,
      shown: top.length,
    };
  }, [funnels, candidates, top]);

  const chipFor = (u: SymbolScanState | undefined): { label: string; tone: "bull" | "bear" | "warn" | "dim" | "gold" } => {
    if (!u || u.status === "idle") return { label: "IDLE", tone: "dim" };
    if (u.status === "scanning") return { label: "SCANNING", tone: "gold" };
    if (u.status === "stale") return u.error ? { label: "ERROR", tone: "bear" } : { label: "DATA STALE", tone: "warn" };
    return u.candidatesFound > 0 ? { label: `OK · ${u.candidatesFound}`, tone: "bull" } : { label: "NO CANDIDATE", tone: "dim" };
  };

  return (
    <div className="flex flex-col gap-4">
      {/* control deck */}
      <div className="tv-panel flex flex-wrap items-center gap-3 px-4 py-3">
        <div className="flex items-center gap-2">
          <span className="flex h-8 w-8 items-center justify-center rounded-md border border-gold-600/50 bg-gold-500/12 text-gold-400"><IRadar size={16} /></span>
          <div className="leading-none">
            <div className="font-display text-sm font-extrabold tracking-tight text-fog-100">TOP SETUPS RADAR</div>
            <div className="font-mono text-[8.5px] tracking-[0.26em] text-fog-500">DISPLAY LAYER · SHARED LIVE ENGINE</div>
          </div>
        </div>
        <Segmented size="sm" options={[{ v: "5m" as RadarTf, label: "5M" }, { v: "15m" as RadarTf, label: "15M" }, { v: "1h" as RadarTf, label: "1H" }, { v: "4h" as RadarTf, label: "4H" }]}
          value={tf} onChange={(v) => props.onSettingsChange({ radarTimeframe: v })} />
        <div className="flex items-center gap-1">
          <span className="font-mono text-[9px] tracking-widest text-fog-500">MODE</span>
          <Segmented size="sm"
            options={[{ v: "auto" as const, label: "AUTO" }, { v: "quality" as const, label: "QUALITY" }, { v: "quantity" as const, label: "QUANTITY" }]}
            value={settings.radarMode} onChange={(v) => props.onSettingsChange({ radarMode: v })} />
        </div>
        <div className="flex items-center gap-1">
          <span className="font-mono text-[9px] tracking-widest text-fog-500">TM</span>
          {TM_VARIANTS.map((v) => (
            <button key={v.id} type="button" title={v.management}
              onClick={() => props.onSettingsChange({ radarTmVariant: v.id })}
              className={cls("tv-btn rounded border px-2 py-1 font-mono text-[9.5px] font-bold tracking-wider",
                settings.radarTmVariant === v.id ? "border-gold-600 bg-gold-500/12 text-gold-300" : "border-ink-600 text-fog-400 hover:text-fog-200")}>
              {v.short}
            </button>
          ))}
        </div>
        {(() => {
          const adv = variantById(settings.radarTmVariant);
          if (!adv.advQuality) return null;
          const gate = loadFrequencyGate();
          if (gate.ok === false)
            return <span title={gate.detail}><Badge tone="bear" className="tv-blink">FREQ GUARD · ADV REVERTED</Badge></span>;
          if (gate.ok === true)
            return <span title={gate.detail}><Badge tone="bull">FREQ GUARD · PASS</Badge></span>;
          return <span title={gate.detail}><Badge tone="warn">FREQ GUARD · PENDING</Badge></span>;
        })()}
        <button type="button" onClick={() => props.onSettingsChange({ radarSound: !settings.radarSound })}
          className={cls("tv-btn rounded border px-2 py-1 font-mono text-[9.5px] font-bold tracking-wider",
            settings.radarSound ? "border-bull-600 bg-bull-500/12 text-bull-400" : "border-ink-600 text-fog-400 hover:text-fog-200")}>
          SOUND {settings.radarSound ? "ON" : "OFF"}
        </button>
        <Btn variant="primary" size="sm" onClick={() => void scanNow()} disabled={manualScanning}>
          {manualScanning ? <span className="tv-blink">SCANNING…</span> : <><IRefresh size={13} /> SCAN NOW</>}
        </Btn>
        <div className="ml-auto flex items-center gap-3 font-mono text-[10px] tracking-wider text-fog-400">
          <span title="Set both floors in Settings → Radar"><Badge tone="dim">Q ≥{settings.radarQualityFloor} · N ≥{settings.quantityFloor}</Badge></span>
          <span className="text-fog-500">{lastFullScanAt ? `LAST SCAN ${fmtIST(lastFullScanAt)}` : "NEVER SCANNED"}</span>
          <span className={cls(anyScanning && "tv-blink text-gold-300")}>{anyScanning ? "SCANNING…" : `NEXT CLOSE IN ${Math.floor(nextScanS / 60)}:${String(nextScanS % 60).padStart(2, "0")}`}</span>
        </div>
      </div>

      {/* batch progress */}
      {progress && (
        <div className="tv-panel px-4 py-2">
          <div className="flex items-center justify-between font-mono text-[10px] tracking-widest text-fog-400">
            <span className="tv-blink text-gold-300">SCANNING {progress.done}/{progress.total}{progress.current ? ` · ${progress.current}` : ""} · 4-WAY BATCH</span>
            <span>{Math.round((progress.done / Math.max(1, progress.total)) * 100)}%</span>
          </div>
          <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-ink-600">
            <div className="h-full rounded-full bg-gold-500 transition-all duration-300" style={{ width: `${(progress.done / Math.max(1, progress.total)) * 100}%` }} />
          </div>
        </div>
      )}

      {/* visible status line */}
      <div className="tv-panel flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2 font-mono text-[10.5px] tracking-wider">
        <span className="flex items-center gap-1.5 text-fog-300">
          <span className={cls("tv-live-dot inline-block h-1.5 w-1.5 rounded-full", anyScanning ? "bg-gold-400" : "bg-bull-500")} />
          SCANNING {symbols.length} SYMBOLS{settings.radarUseTop30 ? " · TOP-30 USDT ∪ WATCHLIST" : ""}
        </span>
        <span className="text-fog-400">TF {tf.toUpperCase()}{tf === "4h" ? " · HTF 1D · EXEC 1H" : ""}</span>
        <span className="text-fog-400">MODE {mode.toUpperCase()}{autoFallback ? "→QUANTITY" : ""}</span>
        {settings.radarUseTop30 && (
          <span className="text-fog-500" title="Universe Hygiene Guards v2: stablecoins excluded, 24h range ≥1.5%, quoteVolume > min, |change| ≤25%, min 2 refreshes">
            HYGIENE ✓{warming.length > 0 ? <span className="text-info-400"> · {warming.length} WARMING</span> : ""}
          </span>
        )}
        <span className={cls("font-bold", activeCount > 0 ? "text-gold-300" : "text-fog-500")}>CANDIDATES FOUND: {activeCount}</span>
        <span className={cls("font-bold", top.length > 0 ? "text-bull-400" : "text-fog-500")}>SHOWING: {top.length}{mode === "quality" || (mode === "auto" && !autoFallback) ? "/5" : "/8"}</span>
        <span className="ml-auto text-fog-500">CONFIRMED-CANDLES ONLY · SHARED LIVE ENGINE</span>
      </div>

      {/* universe strip — per-symbol status */}
      <div className={cls("tv-panel flex flex-wrap items-center gap-2 px-3 py-2", anyScanning && "tv-scanbar")}>
        <span className="font-mono text-[9px] tracking-[0.2em] text-fog-500">UNIVERSE</span>
        {stripList.map((sym) => {
          const isWarming = warming.includes(sym);
          const u = universe[sym];
          const chip = chipFor(u);
          const dot = u?.status === "live" ? "bg-bull-500" : u?.status === "scanning" ? "bg-gold-400 tv-blink" : u?.status === "stale" ? "bg-bear-500" : "bg-ink-400";
          return (
            <span key={sym} className={cls("flex items-center gap-1.5 rounded border px-2 py-1 font-mono text-[10px]",
              isWarming ? "border-info-500/50 text-info-400" : u?.status === "stale" ? "border-bear-600/50 text-bear-300" : "border-ink-600 text-fog-300")}
              title={isWarming
                ? `New listing — needs ${MIN_SCANNABLE_STREAK} consecutive 6h refreshes before scanning`
                : `${u?.error ? "ERROR: " + u.error + " · " : ""}last scan ${u?.lastScanAt ? fmtIST(u.lastScanAt) : "—"}`}>
              <span className={cls("tv-live-dot inline-block h-1.5 w-1.5 rounded-full", isWarming ? "bg-info-400 tv-blink" : dot)} />
              <span className="font-bold tracking-wider">{sym}</span>
              {!isWarming && <span className="text-fog-500">{u?.lastPrice != null ? fmtPrice(u.lastPrice, "crypto") : "—"}</span>}
              {isWarming
                ? <Badge tone="info" className="tv-blink text-[8px]">NEW — WARMING UP</Badge>
                : <Badge tone={chip.tone} className="text-[8px]">{chip.label}</Badge>}
            </span>
          );
        })}
      </div>

      {/* DEBUG box — per-stage counts: where candidates die */}
      <details className="tv-panel px-4 py-2.5" open>
        <summary className="cursor-pointer select-none font-mono text-[10px] font-bold tracking-[0.2em] text-fog-400 hover:text-fog-200">
          DEBUG · PIPELINE FUNNEL (LAST SCAN PASS)
        </summary>
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 font-mono text-[10.5px] tracking-wider">
          <span className="text-fog-400">GENERATED <b className="text-fog-100">{agg.generated}</b></span>
          <span className="text-fog-500">→</span>
          <span className="text-fog-400">PASSED GATES V1–V6 <b className="text-info-400">{agg.passedGates}</b></span>
          <span className="text-fog-500">→</span>
          <span className="text-fog-400">PASSED SCAN FLOOR {scanFloor} <b className="text-gold-300">{agg.passedFloor}</b></span>
          <span className="mx-1 hidden h-4 w-px bg-ink-500 sm:block" />
          <span className="text-fog-400">EXPIRED <b className="text-fog-200">{agg.expired}</b></span>
          <span className="text-fog-400">INVALIDATED <b className="text-bear-400">{agg.invalidated}</b></span>
          <span className="text-fog-400">SHOWN <b className="text-bull-400">{agg.shown}</b></span>
          <span className="ml-auto text-fog-500">per-symbol detail in browser console · [radar] prefix</span>
        </div>
      </details>

      {/* AUTO fallback banner */}
      {autoFallback && quantityList.length > 0 && (
        <div className="tv-panel tv-rise flex items-center gap-2.5 border-l-2 border-l-gold-500 px-4 py-2.5 font-mono text-[11px] tracking-wider text-gold-300">
          <IWarn size={14} />
          <span><b>QUALITY MODE: no setups — showing QUANTITY mode</b></span>
          <span className="text-fog-400">· {quantityList.length} candidate{quantityList.length === 1 ? "" : "s"} ≥ {settings.quantityFloor} · quality floor is {settings.radarQualityFloor}</span>
        </div>
      )}
      {mode === "quality" && qualityList.length === 0 && quantityList.length > 0 && (
        <div className="tv-panel flex items-center gap-2.5 border-l-2 border-l-info-500 px-4 py-2.5 font-mono text-[11px] tracking-wider text-info-400">
          <IWarn size={14} />
          <span>QUALITY floor ({settings.radarQualityFloor}) not met — {quantityList.length} candidate{quantityList.length === 1 ? "" : "s"} sit between {settings.quantityFloor} and {settings.radarQualityFloor}. Switch to QUANTITY or AUTO to see them.</span>
        </div>
      )}

      {/* top candidates */}
      {top.length > 0 ? (
        <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
          {top.map((c, i) => (
            <RadarCard key={c.key} c={c} rank={i} now={now} settings={settings} inTrade={inTradeFor(c)}
              mode={mode === "auto" ? (autoFallback ? "quantity" : "quality") : mode}
              onLogged={() => setPending(loadTrades().filter((tr) => tr.status === "pending"))}
              onOpenInTerminal={props.onOpenInTerminal} />
          ))}
        </div>
      ) : (
        <div className="tv-panel relative flex flex-col items-center gap-3 overflow-hidden px-6 py-14 text-center">
          <div className={cls("absolute inset-x-0 top-0 h-px", anyScanning && "tv-scanbar")} />
          <IRadar size={34} className={cls("text-fog-500", anyScanning && "tv-blink text-gold-500")} />
          <p className="font-display text-lg font-extrabold tracking-tight text-fog-200">NO LIVE SETUPS — MARKET QUIET</p>
          <p className="max-w-lg text-sm leading-relaxed text-fog-400">
            Zero candidates cleared the existing gates <span className="text-fog-200">and</span> the {mode === "quantity" ? "quantity" : "quality"} floor ({mode === "quantity" ? settings.quantityFloor : settings.radarQualityFloor}) on the last scan pass.
            The radar re-runs the full confirmed-candle pipeline for all {symbols.length} symbols on each {tf.toUpperCase()} close — standing aside is the default state, not a fault.
          </p>
          <div className="flex flex-wrap items-center justify-center gap-2 font-mono text-[10px] tracking-widest text-fog-500">
            <span>{lastFullScanAt ? `LAST SCAN ${fmtIST(lastFullScanAt)}` : "FIRST SCAN RUNNING"}</span>
            <span>·</span>
            <span>NEXT CLOSE IN {Math.floor(nextScanS / 60)}:{String(nextScanS % 60).padStart(2, "0")}</span>
            <span>·</span>
            <button type="button" onClick={() => void scanNow()} className="tv-btn font-bold text-gold-400 hover:text-gold-300">RE-SCAN NOW ↻</button>
          </div>
        </div>
      )}

      {/* validity doctrine */}
      <Card icon={<IWarn size={15} />} title="Validity Doctrine — entry clock vs trade rules">
        <div className="grid gap-3 text-[11.5px] leading-relaxed text-fog-300 md:grid-cols-2">
          <p><span className="font-mono text-[10px] font-bold tracking-widest text-gold-300">PRE-ENTRY ·</span> the countdown and the INVALID-IF checklist govern <span className="text-fog-100">entry timing only</span>. Any checklist hit before entry flips the card to INVALIDATED and archives it.</p>
          <p><span className="font-mono text-[10px] font-bold tracking-widest text-info-400">POST-ENTRY ·</span> the countdown <span className="text-fog-100">no longer applies</span>. A running trade is managed by {variantById(settings.radarTmVariant).short} rules — {variantById(settings.radarTmVariant).management} Never close a running trade because the entry countdown expired.</p>
        </div>
      </Card>

      {/* recently expired */}
      {archived.length > 0 && (
        <details className="tv-panel px-4 py-2.5">
          <summary className="cursor-pointer select-none font-mono text-[10.5px] tracking-widest text-fog-400 hover:text-fog-200">
            RECENTLY EXPIRED / INVALIDATED · {archived.length}
          </summary>
          <ul className="mt-2 space-y-1.5 pb-1">
            {archived.map((c) => (
              <li key={c.key + (c.archivedAt ?? 0)} className="flex flex-wrap items-center gap-2 rounded border border-ink-600/60 bg-ink-800/40 px-2.5 py-1.5 font-mono text-[10.5px]">
                <span className="text-fog-500">{c.archivedAt ? new Date(c.archivedAt).toLocaleTimeString() : ""}</span>
                <span className="font-bold text-fog-200">{c.symbol}</span>
                <Badge tone={c.setup.direction === "Long" ? "bull" : "bear"}>{c.setup.direction.toUpperCase()}</Badge>
                <Badge tone={c.status === "invalidated" ? "bear" : "dim"}>{c.status.toUpperCase()}</Badge>
                <span className="text-fog-500">score {c.score.total} · entry {fmtPrice(c.setup.entry_price, c.assetType)}</span>
                <span className="ml-auto max-w-[46%] truncate text-right text-fog-400" title={c.invalidReason ?? ""}>{c.invalidReason}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
