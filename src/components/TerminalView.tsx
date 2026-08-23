import { useCallback, useEffect, useRef, useState } from "react";
import type { AnalysisResult, AssetType, LogLine, Settings, Timeframe, TradeSetup } from "../lib/types";
import { runAnalysis, signalStatus } from "../lib/ai";
import { fetchLastPrice } from "../lib/marketData";
import { addAlert, addTrade, loadAlerts, markAlertTriggered } from "../lib/journal";
import { fmtAgo, fmtIST, fmtMoney, fmtPrice, fmtTime, normSymbol, TF_LIST, cls } from "../lib/utils";
import { CandleChart } from "./CandleChart";
import { Badge, BiasPill, Btn, Card, IBell, IBrain, ICandles, ICheck, IClock, IDown, IExt, IFlask, ILayers, INews, IPlay, IRadar, ITarget, IUp, IWarn, IX, IZap, Meter, PctCell, Segmented, SparkLine, Stat, useToast } from "./ui";

function SignalCountdown({ setup, result, price }: { setup: TradeSetup; result: AnalysisResult; price: number | null }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const sig = setup.signal;
  if (!sig) return null;
  const st = signalStatus(setup, result, now, price ?? result.lastPrice);
  if (st.status === "EXPIRED") return <Badge tone="bear">EXPIRED · {st.reason.toUpperCase()}</Badge>;
  const rem = Math.max(0, sig.validTillTs - now);
  const mm = Math.floor(rem / 60000);
  const ss = Math.floor((rem % 60000) / 1000);
  return (
    <span title={sig.expiryRules}>
      <Badge tone="gold">
        <IClock size={10} /> VALID TILL {fmtIST(sig.validTillTs).slice(11)} · {mm}m {ss.toString().padStart(2, "0")}s
      </Badge>
    </span>
  );
}

function ReasoningBlock({ s, result }: { s: TradeSetup; result: AnalysisResult }) {
  const r = s.reasoning;
  if (!r) return null;
  const Row = ({ k, v, tone }: { k: string; v: string; tone?: string }) => (
    <div className="rounded border border-ink-600/60 bg-ink-900/60 px-2.5 py-1.5">
      <span className="mr-2 text-fog-500">{k}</span>
      <span className={tone ?? "text-fog-200"}>{v}</span>
    </div>
  );
  return (
    <details className="group border-t border-ink-600/70 px-4 py-2">
      <summary className="cursor-pointer select-none font-mono text-[10.5px] tracking-widest text-gold-500 hover:text-gold-300">
        WHY THIS TRADE · {r.session.name.toUpperCase()} SESSION ({r.session.bonus >= 0 ? "+" : ""}{r.session.bonus} WR) · PLANNED RR {r.plannedRR}
      </summary>
      <div className="mt-2 grid gap-1.5 pb-1 font-mono text-[10.5px] leading-relaxed md:grid-cols-2">
        <Row k="HTF BIAS" v={r.htfRationale} />
        <Row k="LIQUIDITY" v={r.liquidity ? `grade ${r.liquidity.grade} · ${r.liquidity.source} · ${r.liquidity.distanceAtr} ATR from entry` : "no target pool in range"} />
        <Row k="SWEEP EVIDENCE" v={r.sweep ? `depth ${r.sweep.depthAtr} ATR · reclaim ${r.sweep.reclaim ? "yes" : "no"} · displacement ${r.sweep.displacementAtr} ATR · trap score ${r.sweep.trapScore}/100` : "no sweep — zone/PD entry"} tone={r.sweep ? "text-gold-300" : undefined} />
        <Row k="STRUCTURE" v={r.structureEvent ? `${r.structureEvent.type} ${r.structureEvent.dir} @ ${fmtPrice(r.structureEvent.level, result.assetType)} · ${fmtTime(r.structureEvent.ts, result.timeframe)}` : "no fresh BOS/CHoCH"} />
        <Row k="ZONE QUALITY" v={r.zone ? `${r.zone.kind} grade ${r.zone.grade} · ${r.zone.distanceAtr} ATR from entry` : "n/a (structure setup)"} />
        <Row k="EXECUTION" v={r.entryModel} tone="text-info-400" />
      </div>
    </details>
  );
}

const QUICK: Record<AssetType, string[]> = {
  crypto: ["BTCUSDT", "ETHUSDT", "SOLUSDT"],
  stock: ["AAPL", "NVDA", "TSLA", "SPY"],
  forex: ["EURUSD", "GBPUSD", "USDJPY"],
};

export function TerminalView(props: {
  settings: Settings;
  onTradesChanged: () => void;
  onGotoBacktest: (prefill: { symbol: string; assetType: AssetType; timeframe: Timeframe }) => void;
  onOpenSettings: () => void;
  handoff?: { symbol: string; assetType: AssetType; timeframe: Timeframe; runId: number } | null;
}) {
  const { settings } = props;
  const toast = useToast();
  const [assetType, setAssetType] = useState<AssetType>("crypto");
  const [symbolInput, setSymbolInput] = useState("BTCUSDT");
  const [timeframe, setTimeframe] = useState<Timeframe>("1h");
  const [analyzing, setAnalyzing] = useState(false);
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [showLog, setShowLog] = useState(true);
  const [result, setResult] = useState<AnalysisResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [focusSetup, setFocusSetup] = useState<string | null>(null);
  const [livePrice, setLivePrice] = useState<number | null>(null);
  const [flash, setFlash] = useState<"up" | "dn" | null>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const runIdRef = useRef(0);

  const pushLog = useCallback((msg: string, kind: LogLine["kind"] = "info") => {
    setLogs((l) => [...l.slice(-60), { t: Date.now(), msg, kind }]);
  }, []);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [logs]);

  const run = useCallback(async (silent = false) => {
    const id = ++runIdRef.current;
    setAnalyzing(true);
    setError(null);
    if (!silent) setLogs([]);
    try {
      const res = await runAnalysis(
        { symbol: normSymbol(symbolInput, assetType), assetType, timeframe, accountSize: settings.accountSize, riskPercent: settings.riskPercent },
        settings,
        (msg, kind) => { if (runIdRef.current === id) pushLog(msg, kind ?? "info"); },
      );
      if (runIdRef.current !== id) return;
      setResult(res);
      setFocusSetup(res.setups[0]?.id ?? null);
      setLivePrice(res.lastPrice);
      // evaluate local alerts
      const alerts = loadAlerts().filter((a) => a.active && a.symbol === res.symbol);
      for (const a of alerts) {
        const hit = a.side === "above" ? res.lastPrice >= a.price : res.lastPrice <= a.price;
        if (hit) {
          markAlertTriggered(a.id);
          toast.push("info", `Alert: ${a.symbol} crossed ${a.side} ${fmtPrice(a.price, res.assetType)} (now ${fmtPrice(res.lastPrice, res.assetType)})`);
        }
      }
      if (res.setups.length) toast.push("ok", `${res.setups.length} validated setup${res.setups.length > 1 ? "s" : ""} on ${res.symbol} ${res.timeframe} (RR ≥ 2, all filters passed)`);
      else toast.push("info", "Analysis complete — no setup met the strict filters this run.");
    } catch (e) {
      if (runIdRef.current === id) setError(e instanceof Error ? e.message : "analysis failed");
    } finally {
      if (runIdRef.current === id) setAnalyzing(false);
    }
  }, [symbolInput, assetType, timeframe, settings, pushLog, toast]);

  // initial auto-run
  useEffect(() => { void run(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  // auto refresh
  useEffect(() => {
    if (!settings.autoRefresh) return;
    const t = setInterval(() => { if (!analyzing) void run(true); }, 90_000);
    return () => clearInterval(t);
  }, [settings.autoRefresh, analyzing, run]);

  // radar handoff: load the symbol the radar pointed at, then run once
  const pendingHandoff = useRef(false);
  useEffect(() => {
    if (!props.handoff) return;
    setAssetType(props.handoff.assetType);
    setSymbolInput(props.handoff.symbol);
    setTimeframe(props.handoff.timeframe);
    pendingHandoff.current = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.handoff?.runId]);
  useEffect(() => {
    if (pendingHandoff.current && !analyzing) {
      pendingHandoff.current = false;
      void run();
    }
  }, [run, analyzing]);

  // live price tick
  useEffect(() => {
    const t = setInterval(async () => {
      const p = await fetchLastPrice(symbolInput, assetType, timeframe);
      if (p != null) {
        setLivePrice((prev) => {
          setFlash(p > (prev ?? p) ? "up" : p < (prev ?? p) ? "dn" : null);
          return p;
        });
      }
    }, 20_000);
    return () => clearInterval(t);
  }, [symbolInput, assetType, timeframe]);

  const takeTrade = (s: TradeSetup) => {
    if (!result) return;
    addTrade({
      symbol: result.symbol, assetType: result.assetType, timeframe: result.timeframe,
      direction: s.direction, entry: s.entry_price, stopLoss: s.stop_loss, tp1: s.take_profit1, tp2: s.take_profit2,
      rr: s.risk_reward_ratio, confidence: s.confidence_score_0_100, confluences: s.confluences,
      rationale: s.trade_rationale, status: "pending", outcome: null, exitPrice: null, pnlPct: null, pnlR: null,
      closedAt: null, notes: "", source: "ai",
      signalType: s.signal?.type, signalGeneratedAt: s.signal?.generatedAt,
      signalDisplayIST: s.signal?.displayTimeIST, signalValidTill: s.signal?.validTillTs,
    });
    props.onTradesChanged();
    toast.push("ok", `${s.direction} ${result.symbol} @ ${fmtPrice(s.entry_price, result.assetType)} added to journal as pending`);
  };

  const setAlert = (s: TradeSetup) => {
    if (!result) return;
    addAlert(result.symbol, s.direction === "Long" ? "below" : "above", s.entry_price);
    toast.push("ok", `Alert armed: ${result.symbol} ${s.direction === "Long" ? "≤" : "≥"} ${fmtPrice(s.entry_price, result.assetType)}`);
  };

  const focused = result?.setups.find((s) => s.id === focusSetup) ?? null;
  const pos = result
    ? Math.min(1, Math.max(0, (result.lastPrice - result.smc.pd.rangeLow) / Math.max(1e-9, result.smc.pd.rangeHigh - result.smc.pd.rangeLow)))
    : 0.5;

  return (
    <div className="flex flex-col gap-4">
      {/* control deck */}
      <div className="tv-panel flex flex-wrap items-center gap-3 px-4 py-3">
        <Segmented
          options={[{ v: "crypto" as AssetType, label: "CRYPTO" }, { v: "stock" as AssetType, label: "STOCKS" }, { v: "forex" as AssetType, label: "FOREX" }]}
          value={assetType}
          onChange={(v) => { setAssetType(v); setSymbolInput(QUICK[v][0]); }}
        />
        <div className="flex items-center gap-2">
          <input
            value={symbolInput}
            onChange={(e) => setSymbolInput(e.target.value.toUpperCase())}
            onKeyDown={(e) => { if (e.key === "Enter" && !analyzing) void run(); }}
            spellCheck={false}
            className="w-28 rounded-md border border-ink-500 bg-ink-900 px-3 py-1.5 font-mono text-sm font-semibold tracking-wider text-gold-300 outline-none focus:border-gold-600/70"
            aria-label="symbol"
          />
          <div className="hidden items-center gap-1 md:flex">
            {QUICK[assetType].map((q) => (
              <button key={q} type="button" onClick={() => { setSymbolInput(q); }}
                className={cls("tv-btn rounded border px-1.5 py-1 font-mono text-[10px] font-semibold", normSymbol(symbolInput, assetType) === q ? "border-gold-600/70 text-gold-300" : "border-ink-600 text-fog-400 hover:text-fog-200")}>
                {q.replace("USDT", "")}
              </button>
            ))}
          </div>
        </div>
        <Segmented size="sm" options={TF_LIST.map((t) => ({ v: t, label: t.toUpperCase() }))} value={timeframe} onChange={setTimeframe} />
        <div className="ml-auto flex items-center gap-2">
          <span className="hidden font-mono text-[10px] text-fog-500 lg:block">
            ACCT {fmtMoney(settings.accountSize, true)} · RISK {settings.riskPercent}%
          </span>
          <Btn variant="primary" onClick={() => void run()} disabled={analyzing}>
            {analyzing ? <span className="tv-blink">SCANNING…</span> : <><IPlay size={14} /> RUN ANALYSIS</>}
          </Btn>
        </div>
      </div>

      {error && (
        <div className="tv-panel flex items-center gap-2 border-bear-600/50 px-4 py-3 text-sm text-bear-300">
          <IWarn size={16} /> {error}
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        {/* chart column */}
        <div className="flex flex-col gap-4 xl:col-span-2">
          <Card
            className="tv-rise"
            icon={<ICandles size={15} />}
            title={result ? `${result.symbol} · ${result.timeframe.toUpperCase()}` : "Chart"}
            right={
              result && (
                <div className="flex items-center gap-2">
                  {result.simulated && <Badge tone="warn">SIM FEED</Badge>}
                  <Badge tone="dim">{result.dataSource.toUpperCase()}</Badge>
                  <span key={livePrice} className={cls("font-mono text-base font-bold", flash === "up" && "tv-flash-up", flash === "dn" && "tv-flash-dn")}>
                    {fmtPrice(livePrice ?? result.lastPrice, result.assetType)}
                  </span>
                  <PctCell v={result.changePct} />
                </div>
              )
            }
            bodyClass="p-2"
          >
            {result ? (
              <CandleChart candles={result.candles} ind={result.indicators} smc={result.smc} asset={result.assetType} timeframe={result.timeframe} setup={focused} />
            ) : (
              <div className={cls("flex h-[440px] items-center justify-center", analyzing && "tv-scanbar")}>
                <span className="font-mono text-xs tracking-[0.3em] text-fog-500">{analyzing ? "LOADING MARKET DATA" : "AWAITING FIRST SCAN"}</span>
              </div>
            )}
            {result && (
              <div className="grid grid-cols-3 gap-2 px-2 pb-2 pt-1">
                <BiasPill label={`HTF ${result.htf.toUpperCase()}`} bias={result.htf_bias} />
                <BiasPill label={`STF ${result.timeframe.toUpperCase()}`} bias={result.stf_bias} />
                <BiasPill label={`LTF ${result.ltf.toUpperCase()}`} bias={result.ltf_bias} />
              </div>
            )}
          </Card>

          {/* scan console */}
          <Card
            icon={<IZap size={15} />}
            title="Scan Console"
            right={
              <div className="flex items-center gap-2">
                {analyzing && <span className="tv-live-dot inline-block h-2 w-2 rounded-full bg-bull-500" />}
                <Btn variant="ghost" size="xs" onClick={() => setShowLog((v) => !v)}>{showLog ? "HIDE" : "SHOW"}</Btn>
              </div>
            }
            bodyClass="p-0"
          >
            {showLog && (
              <div ref={logRef} className="max-h-44 overflow-y-auto px-4 py-3 font-mono text-[11px] leading-[1.75]">
                {logs.length === 0 && <div className="text-fog-500">— console idle —</div>}
                {logs.map((l, i) => (
                  <div key={i} className={cls(
                    l.kind === "ok" && "text-bull-400", l.kind === "warn" && "text-gold-400", l.kind === "err" && "text-bear-400", l.kind === "info" && "text-fog-400",
                  )}>
                    <span className="mr-2 text-fog-500">{new Date(l.t).toLocaleTimeString("en-US", { hour12: false })}</span>
                    {l.msg}
                  </div>
                ))}
                {analyzing && <span className="tv-blink text-gold-400">▊</span>}
              </div>
            )}
          </Card>

          {/* setups */}
          <Card
            icon={<ITarget size={15} />}
            title={`Trade Setups · ${result?.setups.length ?? 0}`}
            right={
              <div className="flex items-center gap-1.5">
                {result?.confirmedOnly && <Badge tone="info">CONFIRMED-CANDLE SIGNALS</Badge>}
                <Badge tone={result?.setups.length ? "bull" : "dim"}>{result?.setups.length ? "VALIDATED" : "STAND ASIDE"}</Badge>
              </div>
            }
          >
            {!result && <p className="text-sm text-fog-400">Run analysis to generate setups.</p>}
            {result && result.setups.length === 0 && (
              <div className="flex flex-col items-start gap-2 rounded-md border border-ink-600 bg-ink-800/50 px-4 py-5">
                <span className="font-display text-sm font-bold text-fog-200">No high-probability setup found with required confluences and filters.</span>
                <p className="text-xs leading-relaxed text-fog-400">
                  Every candidate must clear: RR ≥ 2.0 · win-rate ≥ 60% · confidence ≥ 60% · ≥ 2 aligned SMC/ICT/PA confluences · entry anchored to a detected level · false-breakout volume &amp; close filters. Standing aside is a position.
                </p>
              </div>
            )}
            {result?.setups.map((s) => {
              const long = s.direction === "Long";
              const expired = s.signal
                ? signalStatus(s, result, Date.now(), livePrice ?? result.lastPrice).status === "EXPIRED"
                : false;
              return (
                <article key={s.id} className={cls(
                  "tv-rise mb-3 rounded-lg border bg-ink-800/40 transition-colors last:mb-0",
                  focusSetup === s.id ? (long ? "border-bull-600/60" : "border-bear-600/60") : "border-ink-600",
                  expired && "opacity-70",
                )}>
                  <div className="flex flex-wrap items-center gap-2 border-b border-ink-600/70 px-4 py-2.5">
                    <Badge tone={long ? "bull" : "bear"} className="px-2 py-1 text-[11px] font-bold">
                      {long ? <IUp size={12} /> : <IDown size={12} />} {s.direction.toUpperCase()}
                    </Badge>
                    {s.signal && (
                      <Badge tone="dim">{s.signal.type === "sweep" ? "SWEEP" : s.signal.type === "structure" ? "BOS/CHoCH" : "OB/FVG"} · {s.signal.validCandles}C</Badge>
                    )}
                    <span className="font-mono text-sm font-bold text-fog-100">{fmtPrice(s.entry_price, result.assetType)}</span>
                    <Badge tone="gold">RR {s.risk_reward_ratio.toFixed(2)}</Badge>
                    <Badge tone="info">WR {s.estimated_win_rate_percent}%</Badge>
                    <Badge tone={s.confidence_score_0_100 >= 75 ? "bull" : "dim"}>CONF {s.confidence_score_0_100}</Badge>
                    <SignalCountdown setup={s} result={result} price={livePrice} />
                    <div className="ml-auto flex items-center gap-1.5">
                      <Btn size="xs" variant={focusSetup === s.id ? "dark" : "ghost"} onClick={() => setFocusSetup(s.id)}><ICandles size={12} /> CHART</Btn>
                      <Btn size="xs" variant="success" disabled={expired} onClick={() => takeTrade(s)}>
                        <ICheck size={12} /> {expired ? "EXPIRED" : "TAKE TRADE"}
                      </Btn>
                      <Btn size="xs" variant="outline" onClick={() => props.onGotoBacktest({ symbol: result.symbol, assetType: result.assetType, timeframe: result.timeframe })}><IFlask size={12} /> BACKTEST</Btn>
                      <Btn size="xs" variant="outline" onClick={() => setAlert(s)}><IBell size={12} /> ALERT</Btn>
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-x-6 gap-y-2 px-4 py-3 font-mono text-[11.5px] md:grid-cols-4">
                    <div><div className="text-fog-500">ENTRY</div><div className="font-semibold text-gold-300">{fmtPrice(s.entry_price, result.assetType)}</div></div>
                    <div><div className="text-fog-500">STOP LOSS</div><div className="font-semibold text-bear-400">{fmtPrice(s.stop_loss, result.assetType)}</div></div>
                    <div><div className="text-fog-500">TP1</div><div className="font-semibold text-bull-400">{fmtPrice(s.take_profit1, result.assetType)}</div></div>
                    <div><div className="text-fog-500">TP2</div><div className="font-semibold text-bull-400">{fmtPrice(s.take_profit2, result.assetType)}</div></div>
                    <div><div className="text-fog-500">INVALIDATION</div><div className="text-fog-200">{fmtPrice(s.invalidation_level, result.assetType)}</div></div>
                    {s.position && (<>
                      <div><div className="text-fog-500">SIZE ({result.riskPercent}%)</div><div className="text-fog-200">{s.position.positionSize >= 100 ? s.position.positionSize.toFixed(0) : s.position.positionSize.toPrecision(4)} u</div></div>
                      <div><div className="text-fog-500">RISK $</div><div className="text-bear-400">{fmtMoney(s.position.riskAmount)}</div></div>
                      <div><div className="text-fog-500">POT. TP1 / TP2</div><div className="text-bull-400">+{fmtMoney(s.position.profitAtTp1)} / +{fmtMoney(s.position.profitAtTp2)}</div></div>
                    </>)}
                  </div>
                  <div className="flex flex-wrap gap-1.5 px-4 pb-3">
                    {s.confluences.map((c) => <Badge key={c} tone="gold">{c}</Badge>)}
                  </div>
                  <p className="px-4 pb-3 text-xs leading-relaxed text-fog-300">{s.trade_rationale}</p>
                  <ReasoningBlock s={s} result={result} />
                  {(s.news_caution || s.risk_management_note) && (
                    <div className="grid gap-2 px-4 pb-3 text-[11px] md:grid-cols-2">
                      {s.news_caution && <div className="rounded border border-gold-600/40 bg-gold-500/8 px-2.5 py-1.5 text-gold-300"><span className="mr-1 font-bold">NEWS ⚠</span>{s.news_caution}</div>}
                      {s.risk_management_note && <div className="rounded border border-info-500/40 bg-info-500/8 px-2.5 py-1.5 text-info-400"><span className="mr-1 font-bold">RISK</span>{s.risk_management_note}</div>}
                    </div>
                  )}
                  <details className="group border-t border-ink-600/70 px-4 py-2">
                    <summary className="cursor-pointer select-none font-mono text-[10.5px] tracking-widest text-fog-400 hover:text-fog-200">
                      ANTI-HALLUCINATION VALIDATION · {s.validation.checks.filter((c) => c.passed).length}/{s.validation.checks.length} PASSED
                    </summary>
                    <ul className="mt-2 space-y-1 pb-1">
                      {s.validation.checks.map((c, ci) => (
                        <li key={ci} className="flex items-center gap-2 font-mono text-[10.5px]">
                          {c.passed ? <ICheck size={11} className="text-bull-400" /> : <IX size={11} className="text-bear-400" />}
                          <span className={c.passed ? "text-fog-300" : "text-bear-300"}>{c.name}</span>
                          <span className="text-fog-500">· {c.detail}</span>
                        </li>
                      ))}
                    </ul>
                  </details>
                </article>
              );
            })}
            {result && result.rejectedSetups.length > 0 && (
              <details className="mt-3 rounded-md border border-bear-600/30 bg-ink-900/40 px-3 py-2">
                <summary className="cursor-pointer select-none font-mono text-[10.5px] tracking-widest text-bear-300 hover:text-bear-400">
                  WHY NOT · {result.rejectedSetups.length} CANDIDATE{result.rejectedSetups.length > 1 ? "S" : ""} REJECTED BY VALIDATOR
                </summary>
                <ul className="mt-2 space-y-2 pb-1">
                  {result.rejectedSetups.map((r, ri) => (
                    <li key={ri} className="rounded border border-ink-600/60 bg-ink-800/40 px-2.5 py-2">
                      <div className="flex flex-wrap items-center gap-1.5 font-mono text-[10.5px]">
                        <Badge tone={r.direction === "Long" ? "bull" : "bear"}>{r.direction.toUpperCase()}</Badge>
                        <span className="font-bold text-fog-200">{fmtPrice(r.entry_price, result.assetType)}</span>
                        <span className="text-fog-500">→ SL {fmtPrice(r.stop_loss, result.assetType)} · TP1 {fmtPrice(r.take_profit1, result.assetType)}</span>
                      </div>
                      <p className="mt-1 font-mono text-[10.5px] leading-relaxed text-bear-300">{r.reasoning?.rejectionReason ?? "failed validation"}</p>
                      <div className="mt-1 flex flex-wrap gap-1">
                        {r.validation.checks.filter((c) => !c.passed).map((c, ci) => (
                          <Badge key={ci} tone="bear">{c.name}</Badge>
                        ))}
                      </div>
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </Card>
        </div>

        {/* right column */}
        <div className="flex flex-col gap-4">
          {result && (
            <>
              <Card icon={<IRadar size={15} />} title="Market Read" right={<Badge tone="dim">{result.engine}</Badge>}>
                <p className="text-xs leading-relaxed text-fog-300">{result.summary}</p>
                <div className="mt-3">
                  <div className="mb-1 flex items-center justify-between font-mono text-[10px] tracking-widest text-fog-500">
                    <span>DEALING RANGE</span>
                    <span className="text-fog-300">{fmtPrice(result.smc.pd.rangeLow, result.assetType)} – {fmtPrice(result.smc.pd.rangeHigh, result.assetType)}</span>
                  </div>
                  <Meter position={pos} labels={["DISCOUNT", "EQ", "PREMIUM"]} />
                </div>
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {result.smc.structure.slice(-3).map((ev, i) => (
                    <Badge key={i} tone={ev.dir === "bull" ? "bull" : "bear"}>{ev.type} {ev.dir.toUpperCase()} @ {fmtPrice(ev.level, result.assetType)}</Badge>
                  ))}
                  {result.smc.sweeps.slice(-2).map((sw, i) => (
                    <Badge key={"sw" + i} tone="gold">{sw.side === "buy" ? "BSL" : "SSL"} SWEPT</Badge>
                  ))}
                  {result.smc.patterns.slice(-3).map((p, i) => (
                    <Badge key={"p" + i} tone={p.dir === "bull" ? "bull" : p.dir === "bear" ? "bear" : "dim"}>{p.name}</Badge>
                  ))}
                </div>
              </Card>

              <Card icon={<ILayers size={15} />} title="Key Levels">
                <ul className="space-y-1.5">
                  {result.key_levels.map((k, i) => (
                    <li key={i} className="flex items-baseline justify-between gap-2 rounded border border-ink-600/60 bg-ink-800/40 px-2.5 py-1.5">
                      <div className="min-w-0">
                        <div className="truncate text-[11px] font-semibold text-fog-200">{k.type}</div>
                        <div className="truncate text-[10px] text-fog-500">{k.description}</div>
                      </div>
                      <span className="shrink-0 font-mono text-[11.5px] font-bold text-gold-300">{fmtPrice(k.price, result.assetType)}</span>
                    </li>
                  ))}
                </ul>
                <div className="mt-3 border-t border-ink-600/60 pt-2">
                  <div className="mb-1 font-mono text-[10px] tracking-widest text-fog-500">LIQUIDITY POOLS</div>
                  <div className="flex flex-wrap gap-1.5">
                    {result.liquidity_pools.map((p, i) => (
                      <Badge key={i} tone={p.side === "buy" ? "bear" : "bull"}>{p.side === "buy" ? "BSL" : "SSL"} {fmtPrice(p.price, result.assetType)}</Badge>
                    ))}
                  </div>
                </div>
              </Card>

              <Card icon={<IBrain size={15} />} title="Self-Learning Note">
                <p className="text-xs leading-relaxed text-fog-300">{result.self_learning_note}</p>
                <div className="mt-3 grid grid-cols-2 gap-2">
                  <Stat label="Journal WR" value={result.performance.total ? result.performance.winRate.toFixed(0) + "%" : "—"} sub={`${result.performance.total} closed`} tone={result.performance.winRate >= 50 ? "bull" : "dim"} />
                  <Stat label="Profit Factor" value={result.performance.total ? result.performance.profitFactor.toFixed(2) : "—"} sub={`Sharpe ${result.performance.total ? result.performance.sharpe.toFixed(2) : "—"}`} tone={result.performance.profitFactor >= 1 ? "gold" : "dim"} />
                </div>
                {result.performance.equity.length > 2 && (
                  <div className="mt-2 flex items-end justify-between gap-2 rounded border border-ink-600/60 bg-ink-800/40 px-3 py-2">
                    <div>
                      <div className="font-mono text-[10px] tracking-widest text-fog-500">EQUITY (100 BASE)</div>
                      <div className={cls("font-mono text-sm font-bold", result.performance.equity[result.performance.equity.length - 1] >= 100 ? "text-bull-400" : "text-bear-400")}>
                        {result.performance.equity[result.performance.equity.length - 1].toFixed(1)}
                      </div>
                    </div>
                    <SparkLine values={result.performance.equity.slice(-30)} width={150} height={38} baseline={100} />
                  </div>
                )}
              </Card>

              <Card
                icon={<INews size={15} />} title="News Side-Factor"
                right={result.sentiment ? <Badge tone={result.sentiment.value >= 55 ? "bull" : result.sentiment.value <= 40 ? "bear" : "dim"}>F&G {result.sentiment.value} · {result.sentiment.label}</Badge> : undefined}
              >
                <p className="mb-2 text-[11px] leading-relaxed text-fog-400">{result.news_summary}</p>
                {result.news.length === 0 ? (
                  <p className="font-mono text-[11px] text-fog-500">No headlines reachable this run.</p>
                ) : (
                  <ul className="space-y-2">
                    {result.news.map((nItem, i) => (
                      <li key={i} className="group rounded border border-ink-600/60 bg-ink-800/40 px-2.5 py-2 transition-colors hover:border-ink-500">
                        <a href={nItem.url} target="_blank" rel="noreferrer" className="flex items-start justify-between gap-2 text-[11.5px] font-semibold leading-snug text-fog-200 hover:text-gold-300">
                          {nItem.title}
                          <IExt size={11} className="mt-0.5 shrink-0 text-fog-500 group-hover:text-gold-400" />
                        </a>
                        <div className="mt-0.5 flex items-center gap-2 font-mono text-[9.5px] text-fog-500">
                          <span className="text-info-400">{nItem.source}</span>·<IClock size={9} />{nItem.publishedAt ? fmtAgo(nItem.publishedAt) : "—"}
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
            </>
          )}
          {!result && analyzing && (
            <Card icon={<IRadar size={15} />} title="Initializing">
              <div className="tv-scanbar h-24 rounded bg-ink-800/60" />
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
