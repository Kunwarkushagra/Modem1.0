import { useCallback, useEffect, useRef, useState } from "react";
import type { AssetType, BacktestResult, LogLine, Timeframe } from "../lib/types";
import { runBacktest } from "../lib/backtest";
import { fmtNum, fmtTime, normSymbol, TF_LIST, cls } from "../lib/utils";
import { Badge, Btn, Card, IFlask, IPlay, IWarn, ProgressBar, Segmented, SparkLine, Stat, useToast } from "./ui";

export function BacktestView(props: {
  prefill: { symbol: string; assetType: AssetType; timeframe: Timeframe; runId: number } | null;
}) {
  const toast = useToast();
  const [symbol, setSymbol] = useState("BTCUSDT");
  const [assetType, setAssetType] = useState<AssetType>("crypto");
  const [timeframe, setTimeframe] = useState<Timeframe>("1h");
  const [days, setDays] = useState(30);
  const [running, setRunning] = useState(false);
  const [pct, setPct] = useState(0);
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [result, setResult] = useState<BacktestResult | null>(null);
  const runIdRef = useRef(0);

  const run = useCallback(async (override?: { symbol: string; assetType: AssetType; timeframe: Timeframe }) => {
    const id = ++runIdRef.current;
    setRunning(true);
    setPct(0);
    setLogs([]);
    setResult(null);
    const sym = override?.symbol ?? symbol;
    const at = override?.assetType ?? assetType;
    const tf = override?.timeframe ?? timeframe;
    try {
      const res = await runBacktest(
        { symbol: normSymbol(sym, at), assetType: at, timeframe: tf, days },
        (msg, kind) => { if (runIdRef.current === id) setLogs((l) => [...l.slice(-30), { t: Date.now(), msg, kind: kind ?? "info" }]); },
        (p) => { if (runIdRef.current === id) setPct(p); },
      );
      if (runIdRef.current !== id) return;
      setResult(res);
      toast.push(res.trades.length ? "ok" : "info",
        res.trades.length
          ? `Backtest complete: ${res.trades.length} trades · WR ${res.winRate.toFixed(0)}% · net ${res.netR > 0 ? "+" : ""}${res.netR.toFixed(1)}R`
          : "Backtest complete — the strict validator filtered every candidate in this window.");
    } catch (e) {
      if (runIdRef.current === id) toast.push("err", `Backtest failed: ${e instanceof Error ? e.message : "unknown"}`);
    } finally {
      if (runIdRef.current === id) setRunning(false);
    }
  }, [symbol, assetType, timeframe, days, toast]);

  useEffect(() => {
    if (props.prefill) {
      setSymbol(props.prefill.symbol);
      setAssetType(props.prefill.assetType);
      setTimeframe(props.prefill.timeframe);
    }
  }, [props.prefill]);

  useEffect(() => {
    if (props.prefill) void run(props.prefill);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.prefill?.runId]);

  const hasEdge = result ? result.netR > 0 && result.winRate >= 45 : false;

  return (
    <div className="flex flex-col gap-4">
      <div className="tv-panel flex flex-wrap items-center gap-3 px-4 py-3">
        <Segmented
          options={[{ v: "crypto" as AssetType, label: "CRYPTO" }, { v: "stock" as AssetType, label: "STOCKS" }, { v: "forex" as AssetType, label: "FOREX" }]}
          value={assetType} onChange={(v) => { setAssetType(v); setSymbol(v === "crypto" ? "BTCUSDT" : v === "stock" ? "AAPL" : "EURUSD"); }}
        />
        <input value={symbol} onChange={(e) => setSymbol(e.target.value.toUpperCase())} spellCheck={false}
          className="w-28 rounded-md border border-ink-500 bg-ink-900 px-3 py-1.5 font-mono text-sm font-semibold text-gold-300 outline-none focus:border-gold-600/70" aria-label="symbol" />
        <Segmented size="sm" options={TF_LIST.map((t) => ({ v: t, label: t.toUpperCase() }))} value={timeframe} onChange={setTimeframe} />
        <div className="flex items-center gap-1">
          {[14, 30, 60, 90].map((d) => (
            <button key={d} type="button" onClick={() => setDays(d)}
              className={cls("tv-btn rounded border px-2 py-1 font-mono text-[10.5px] font-bold", days === d ? "border-gold-600/70 text-gold-300" : "border-ink-600 text-fog-400 hover:text-fog-200")}>
              {d}D
            </button>
          ))}
        </div>
        <Btn variant="primary" className="ml-auto" onClick={() => void run()} disabled={running}>
          {running ? <span className="tv-blink">CRUNCHING…</span> : <><IPlay size={14} /> RUN BACKTEST</>}
        </Btn>
      </div>

      {running && (
        <div className="tv-panel px-4 py-3">
          <div className="mb-2 flex items-center justify-between font-mono text-[10.5px] tracking-widest text-fog-400">
            <span>WALK-FORWARD · SAME PIPELINE AS LIVE ENGINE · {days} DAYS OF {timeframe.toUpperCase()}</span>
            <span className="text-gold-400">{pct}%</span>
          </div>
          <ProgressBar pct={pct} />
          <div className="mt-2 max-h-24 overflow-y-auto font-mono text-[10.5px] leading-relaxed text-fog-400">
            {logs.map((l, i) => (
              <div key={i} className={cls(l.kind === "ok" && "text-bull-400", l.kind === "warn" && "text-gold-400", l.kind === "err" && "text-bear-400")}>{l.msg}</div>
            ))}
          </div>
        </div>
      )}

      {result && (
        <>
          {/* signal funnel */}
          <div className="tv-panel flex flex-wrap items-center gap-2 px-4 py-2.5 font-mono text-[10.5px] tracking-wider">
            <span className="text-fog-500">SIGNAL FUNNEL</span>
            <Badge tone="info">{result.funnel.generated} GENERATED</Badge>
            <span className="text-fog-500">→</span>
            <Badge tone="warn">{result.funnel.expiredBeforeTrigger} EXPIRED PRE-TRIGGER</Badge>
            <span className="text-fog-500">→</span>
            <Badge tone="gold">{result.funnel.entered} ENTERED</Badge>
            <span className="text-fog-500">→</span>
            <Badge tone="bull">{result.funnel.wins}W</Badge>
            <Badge tone="bear">{result.funnel.losses}L</Badge>
            <Badge tone="dim">{result.funnel.breakeven}BE</Badge>
            <span className="ml-auto text-fog-500">
              COSTS/LEG: {result.costs.makerPct * 100}% MAKER ENTRY · {result.costs.takerPct * 100}% TAKER EXIT · {result.costs.slippagePct * 100}% SLIPPAGE — ALL METRICS NET
            </span>
          </div>

          <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-7">
            <Stat label="Entries" value={String(result.funnel.entered)} sub={`${result.skippedInvalid} failed validation`} />
            <Stat label="Win Rate (net)" value={result.winRate.toFixed(1) + "%"} tone={result.winRate >= 50 ? "bull" : "dim"} sub="BE excluded" />
            <Stat label="Profit Factor" value={result.profitFactor.toFixed(2)} tone={result.profitFactor >= 1 ? "gold" : "bear"} sub="net ledger" />
            <Stat label="Expectancy" value={(result.expectancyR > 0 ? "+" : "") + result.expectancyR.toFixed(2) + "R"} tone={result.expectancyR >= 0 ? "bull" : "bear"} sub="net / trade" />
            <Stat label="Max Drawdown" value={"−" + result.maxDrawdownR.toFixed(1) + "R"} tone="bear" sub="net equity" />
            <Stat label="Sharpe (trade)" value={result.sharpe.toFixed(2)} sub="net returns" />
            <Stat label="Net Result" value={(result.netR > 0 ? "+" : "") + result.netR.toFixed(1) + "R"} tone={result.netR >= 0 ? "bull" : "bear"} sub={`gross ${(result.grossR > 0 ? "+" : "") + result.grossR.toFixed(1)}R`} />
          </div>

          <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
            <Card className="xl:col-span-2" icon={<IFlask size={15} />} title="NET Equity Curve (R multiples)"
              right={<Badge tone={hasEdge ? "bull" : "bear"}>{hasEdge ? "EDGE DETECTED (NET)" : "NO EDGE IN WINDOW"}</Badge>}>
              <SparkLine values={result.equityR} width={680} height={120} baseline={0} />
              <p className="mt-2 text-[11px] leading-relaxed text-fog-400">
                Curve is built from the NET ledger: every entry charged 0.02% maker + 0.05% slippage, every exit 0.10% taker + 0.05% slippage.
                Fills occur at the next candle OPEN after the trigger close; TP1 moves the stop to breakeven; ambiguous candles resolve against the trade.
                {result.skippedInvalid > 0 && ` ${result.skippedInvalid} candidate(s) were discarded by the same anti-hallucination validator used live.`}
              </p>
            </Card>
            <Card icon={<IWarn size={15} />} title="Honest Read">
              <ul className="space-y-2 text-[11.5px] leading-relaxed text-fog-300">
                <li className="flex gap-2"><span className="text-gold-400">·</span>Confirmed-candles-only: signals use candles [0..i], fills at open of the next bar — no forming-candle repaint.</li>
                <li className="flex gap-2"><span className="text-gold-400">·</span>{result.funnel.expiredBeforeTrigger} of {result.funnel.generated} signals expired before trigger — validity windows are enforced, never entered after expiry.</li>
                <li className="flex gap-2"><span className="text-gold-400">·</span>Single in-sample pass: no untouched OOS split yet. Validate on a second, non-overlapping window before trusting it.</li>
                <li className="flex gap-2"><span className="text-gold-400">·</span>{result.trades.length < 10 ? "Sample size is small; treat the numbers as directional, not statistical." : "Sample size is reasonable, but regime shifts can invalidate the pattern."}</li>
                <li className="flex gap-2"><span className="text-gold-400">·</span>Feed: {result.dataSource} · duration {(result.durationMs / 1000).toFixed(1)}s.</li>
              </ul>
            </Card>
          </div>

          <Card icon={<IFlask size={15} />} title={`Simulated Trades · ${result.trades.length} · NET LEDGER`} bodyClass="p-0">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[900px] text-left font-mono text-[11px]">
                <thead>
                  <tr className="border-b border-ink-600/70 text-[9.5px] tracking-[0.14em] text-fog-500">
                    <th className="px-4 py-2 font-medium">TIME</th>
                    <th className="px-2 py-2 font-medium">DIR</th>
                    <th className="px-2 py-2 font-medium">TYPE</th>
                    <th className="px-2 py-2 font-medium">ENTRY (next open)</th>
                    <th className="px-2 py-2 font-medium">SL</th>
                    <th className="px-2 py-2 font-medium">RR</th>
                    <th className="px-2 py-2 font-medium">CONFLUENCES</th>
                    <th className="px-2 py-2 font-medium">OUTCOME</th>
                    <th className="px-2 py-2 font-medium">GROSS</th>
                    <th className="px-2 py-2 font-medium">FEES</th>
                    <th className="px-2 py-2 font-medium">NET</th>
                  </tr>
                </thead>
                <tbody>
                  {result.trades.length === 0 && <tr><td colSpan={11} className="px-4 py-8 text-center text-fog-500">No validated setups occurred in this window.</td></tr>}
                  {result.trades.map((t, i) => (
                    <tr key={i} className="border-b border-ink-600/40 hover:bg-ink-750/60">
                      <td className="px-4 py-2 text-fog-400">{fmtTime(t.t, result.params.timeframe)}</td>
                      <td className="px-2 py-2"><Badge tone={t.direction === "Long" ? "bull" : "bear"}>{t.direction === "Long" ? "LONG" : "SHORT"}</Badge></td>
                      <td className="px-2 py-2"><Badge tone="dim">{t.signalType === "sweep" ? "SWEEP" : t.signalType === "structure" ? "BOS" : "ZONE"}</Badge></td>
                      <td className="px-2 py-2 text-gold-300">{fmtNum(t.entry, t.entry < 10 ? 5 : 2)}</td>
                      <td className="px-2 py-2 text-bear-400">{fmtNum(t.sl, t.sl < 10 ? 5 : 2)}</td>
                      <td className="px-2 py-2 text-fog-200">{t.rr.toFixed(1)}</td>
                      <td className="max-w-[180px] truncate px-2 py-2 text-fog-400" title={t.confluences.join(", ")}>{t.confluences.join(", ")}</td>
                      <td className="px-2 py-2">{t.outcome === "win" ? <Badge tone="bull">WIN</Badge> : t.outcome === "loss" ? <Badge tone="bear">LOSS</Badge> : <Badge tone="dim">BE</Badge>}</td>
                      <td className={cls("px-2 py-2", t.grossR > 0 ? "text-bull-400" : t.grossR < 0 ? "text-bear-400" : "text-fog-300")}>{t.grossR > 0 ? "+" : ""}{t.grossR}R</td>
                      <td className="px-2 py-2 text-bear-300">−{t.feesR}R</td>
                      <td className={cls("px-2 py-2 font-bold", t.pnlR > 0 ? "text-bull-400" : t.pnlR < 0 ? "text-bear-400" : "text-fog-300")}>{t.pnlR > 0 ? "+" : ""}{t.pnlR}R</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>

          {result.expiryLog.length > 0 && (
            <Card icon={<IWarn size={15} />} title={`Expired Before Trigger · last ${result.expiryLog.length}`} bodyClass="p-0">
              <ul className="divide-y divide-ink-600/40">
                {result.expiryLog.map((x, i) => (
                  <li key={i} className="flex flex-wrap items-center gap-2 px-4 py-2 font-mono text-[10.5px]">
                    <span className="text-fog-500">{fmtTime(x.t, result.params.timeframe)}</span>
                    <Badge tone={x.direction === "Long" ? "bull" : "bear"}>{x.direction.toUpperCase()}</Badge>
                    <Badge tone="dim">{x.signalType === "sweep" ? "SWEEP" : x.signalType === "structure" ? "BOS" : "ZONE"}</Badge>
                    <span className="text-gold-400">{x.reason}</span>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </>
      )}

      {!result && !running && (
        <div className="tv-panel flex flex-col items-center gap-3 px-6 py-16 text-center">
          <IFlask size={34} className="text-fog-500" />
          <p className="max-w-md text-sm leading-relaxed text-fog-400">
            The backtester replays the <span className="text-fog-200">exact live pipeline</span> — indicators, SMC/ICT/PA detection, setup generation and the anti-hallucination validator — across history, then simulates each surviving setup candle-by-candle.
          </p>
          <p className="font-mono text-[10.5px] tracking-widest text-fog-500">PICK A WINDOW ABOVE AND PRESS RUN</p>
        </div>
      )}
    </div>
  );
}
