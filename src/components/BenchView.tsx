import { useCallback, useEffect, useRef, useState } from "react";
import type { BenchReport, BenchSegment, BenchWindowReport, LogLine, SegmentStats, TmVariantId } from "../lib/types";
import { BENCH_WINDOWS, loadBenchReport, runBenchmark } from "../lib/bench";
import {
  BASELINE_VARIANT, FREQUENCY_GUARD, loadFrequencyGate, MIN_VAL_TRADES, PASS_THRESHOLDS,
  TEST_VARIANT, TM_VARIANTS, variantById,
} from "../lib/tmVariant";
import { cls, fmtIST } from "../lib/utils";
import { Badge, Btn, Card, ICheck, IFlask, IPlay, IScale, IWarn, IX, useToast } from "./ui";

const SEG_ORDER: BenchSegment[] = ["CAL", "VAL", "OOS"];
const f3 = (x: number) => (x >= 0 ? "+" : "") + x.toFixed(3);

function CheckChip({ pass, id, label, detail }: { pass: boolean; id: string; label: string; detail: string }) {
  return (
    <div className={cls("rounded border px-2 py-1.5", pass ? "border-bull-600/40 bg-bull-500/8" : "border-bear-600/50 bg-bear-500/10")}>
      <div className="flex items-center gap-1.5">
        <span className={cls("flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full", pass ? "bg-bull-500 text-ink-950" : "bg-bear-500 text-ink-950")}>
          {pass ? <ICheck size={9} /> : <IX size={9} />}
        </span>
        <span className={cls("font-mono text-[9px] font-bold tracking-wider", pass ? "text-bull-400" : "text-bear-400")}>{id}</span>
        <span className="truncate text-[9.5px] text-fog-300" title={label}>{label}</span>
      </div>
      <div className="mt-0.5 pl-5 font-mono text-[8.5px] text-fog-500">{detail}</div>
    </div>
  );
}

function SegmentTable({ variantId, stats }: { variantId: TmVariantId; stats: SegmentStats[] }) {
  const v = variantById(variantId);
  const isTest = variantId === TEST_VARIANT.id;
  return (
    <div className="overflow-x-auto rounded border border-ink-600/60">
      <table className="w-full min-w-[560px] font-mono text-[10px]">
        <thead>
          <tr className="border-b border-ink-600/70 bg-ink-750/60 text-[8.5px] tracking-[0.12em] text-fog-500">
            <th className="px-2 py-1.5 text-left font-medium">{v.short}</th>
            {SEG_ORDER.map((s) => <th key={s} className="px-2 py-1.5 text-center font-medium">{s}</th>)}
          </tr>
        </thead>
        <tbody>
          {([
            ["TRADES", (x: SegmentStats) => String(x.trades)],
            ["WIN %", (x: SegmentStats) => x.winRate.toFixed(0)],
            ["GROSS/T", (x: SegmentStats) => f3(x.grossPerTrade)],
            ["NET/T", (x: SegmentStats) => f3(x.netPerTrade)],
            ["PF", (x: SegmentStats) => x.pf.toFixed(2)],
            ["MAXDD R", (x: SegmentStats) => "−" + x.maxDDR.toFixed(1)],
            ["PARTIAL %", (x: SegmentStats) => x.partialRate.toFixed(0)],
            ["/MONTH", (x: SegmentStats) => x.tradesPerMonth.toFixed(1)],
          ] as Array<[string, (x: SegmentStats) => string]>).map(([label, fn]) => (
            <tr key={label} className="border-b border-ink-600/30 last:border-0">
              <td className="px-2 py-1 text-[8.5px] tracking-wider text-fog-500">{label}</td>
              {stats.map((s) => {
                const val = fn(s);
                const isNet = label === "NET/T";
                const neg = isNet && val.startsWith("-");
                return (
                  <td key={s.segment} className={cls("px-2 py-1 text-center", isNet ? (neg ? "text-bear-400" : "text-bull-400") : "text-fog-300", isTest && "font-bold")}>
                    {val}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function WindowCard({ w }: { w: BenchWindowReport }) {
  const verdictTone = w.verdict === "PASS" ? "bull" : w.verdict === "FAIL" ? "bear" : "warn";
  const fg = w.freqGuard;
  return (
    <Card
      icon={<IFlask size={15} />}
      title={w.window.label}
      right={<div className="flex items-center gap-1.5">
        <span className="font-mono text-[8.5px] text-fog-500">{w.candles}c · {w.dataSource}</span>
        <Badge tone={verdictTone} className="text-[10px] font-bold">{w.verdict}</Badge>
      </div>}
    >
      {/* frequency guard strip */}
      <div className={cls("mb-3 flex flex-wrap items-center gap-x-4 gap-y-1 rounded border px-3 py-2 font-mono text-[10px]",
        fg.pass ? "border-bull-600/40 bg-bull-500/8" : "border-bear-600/60 bg-bear-500/12")}>
        <span className={cls("font-bold tracking-wider", fg.pass ? "text-bull-400" : "text-bear-400 tv-blink")}>
          FREQ GUARD {fg.pass ? "PASS" : "FAIL"}
        </span>
        <span className="text-fog-300">adv <b className={fg.pass ? "text-bull-300" : "text-bear-300"}>{fg.advTrades}</b> / baseline {fg.baselineTrades}</span>
        <span className="text-fog-500">floor {fg.floor.toFixed(0)}</span>
        {!fg.pass && <span className="text-bear-300">→ adv soft layers reverted</span>}
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        <div>
          <div className="mb-1.5 font-mono text-[9px] tracking-[0.14em] text-fog-500">SEGMENTS · {BASELINE_VARIANT.short} vs {TEST_VARIANT.short}</div>
          <div className="space-y-2">
            <SegmentTable variantId={BASELINE_VARIANT.id} stats={w.segments[BASELINE_VARIANT.id]} />
            <SegmentTable variantId={TEST_VARIANT.id} stats={w.segments[TEST_VARIANT.id]} />
          </div>
        </div>
        <div>
          <div className="mb-1.5 font-mono text-[9px] tracking-[0.14em] text-fog-500">PASS THRESHOLDS (VAL) + GUARD</div>
          <div className="grid gap-1.5">
            {w.checks.map((c) => <CheckChip key={c.id} pass={c.pass} id={c.id} label={c.label} detail={c.detail} />)}
          </div>
        </div>
      </div>
    </Card>
  );
}

export function BenchView() {
  const toast = useToast();
  const [report, setReport] = useState<BenchReport | null>(() => loadBenchReport());
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<{ wi: number; pct: number } | null>(null);
  const abortRef = useRef(false);
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => { if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight; }, [logs]);

  const pushLog = useCallback((msg: string, kind: LogLine["kind"] = "info") => {
    setLogs((l) => [...l.slice(-120), { t: Date.now(), msg, kind }]);
  }, []);

  const run = useCallback(async () => {
    if (running) return;
    setRunning(true);
    abortRef.current = false;
    setLogs([]);
    setProgress({ wi: 0, pct: 0 });
    pushLog(`benchmark start — ${BENCH_WINDOWS.length} windows × ${TM_VARIANTS.length} variants · shared candles per window`);
    pushLog(`frequency guard armed: adv full-run trades must stay ≥ max(${FREQUENCY_GUARD.ratio}×baseline, ${FREQUENCY_GUARD.minTrades})`);
    try {
      const r = await runBenchmark(
        (msg, kind) => pushLog(msg, kind ?? "info"),
        (wr) => setReport((prev) => ({ ...(prev as BenchReport), ranAt: Date.now(), elapsedMs: 0, aborted: false, windows: [...(prev?.windows ?? []).filter((x) => x.window.label !== wr.window.label), wr], advFrequencyOk: prev?.advFrequencyOk ?? null })),
        (wi, pct) => setProgress({ wi, pct }),
        () => abortRef.current,
      );
      setReport(r);
      if (r.advFrequencyOk === false) toast.push("err", "Frequency guard FAILED — adv v1.2.0 soft layers reverted in live scanning");
      else if (r.advFrequencyOk === true) toast.push("ok", "Frequency guard PASSED — adv v1.2.0 soft layers stay live");
      else toast.push("info", "Benchmark finished — guard inconclusive (aborted or empty)");
    } catch (e) {
      pushLog(`benchmark error: ${e instanceof Error ? e.message : "unknown"}`, "err");
    } finally {
      setRunning(false);
      setProgress(null);
    }
  }, [running, pushLog, toast]);

  const gate = loadFrequencyGate();
  const advLive = gate.ok !== false;

  return (
    <div className="flex flex-col gap-4">
      {/* header / guard banner */}
      <div className="tv-panel flex flex-col gap-3 px-4 py-3.5">
        <div className="flex flex-wrap items-center gap-3">
          <span className="flex h-9 w-9 items-center justify-center rounded-md border border-gold-600/50 bg-gold-500/12 text-gold-400"><IScale size={18} /></span>
          <div className="leading-tight">
            <div className="font-display text-base font-extrabold tracking-tight text-fog-100">VARIANT BENCHMARK</div>
            <div className="font-mono text-[8.5px] tracking-[0.24em] text-fog-500">{BASELINE_VARIANT.label} vs {TEST_VARIANT.label} · 60/20/20 · NET LEDGER</div>
          </div>
          <div className="ml-auto flex items-center gap-2">
            {running && progress && (
              <span className="font-mono text-[10px] text-gold-300">
                {BENCH_WINDOWS[progress.wi]?.label ?? ""} · {progress.pct}%
              </span>
            )}
            <Btn variant="primary" size="sm" onClick={() => void run()} disabled={running}>
              {running ? <span className="tv-blink">RUNNING…</span> : <><IPlay size={13} /> RUN BENCHMARK</>}
            </Btn>
            {running && <Btn variant="ghost" size="sm" onClick={() => { abortRef.current = true; }}><IX size={12} /> ABORT</Btn>}
          </div>
        </div>

        {/* the guard, stated plainly */}
        <div className={cls("flex flex-wrap items-center gap-x-5 gap-y-1.5 rounded-md border px-3.5 py-2.5",
          gate.ok === false ? "border-bear-600/60 bg-bear-500/12" : gate.ok === true ? "border-bull-600/40 bg-bull-500/8" : "border-ink-500 bg-ink-800/50")}>
          <span className={cls("flex items-center gap-2 font-display text-sm font-extrabold tracking-tight",
            gate.ok === false ? "text-bear-300" : gate.ok === true ? "text-bull-300" : "text-fog-300")}>
            {gate.ok === false ? <IWarn size={16} /> : <IScale size={16} />}
            FREQUENCY GUARD — {gate.ok === false ? "ADV REVERTED" : gate.ok === true ? "ADV LIVE" : "PENDING"}
          </span>
          <span className="font-mono text-[10px] text-fog-400">
            rule: adv full-run closed trades ≥ max({FREQUENCY_GUARD.ratio} × baseline, {FREQUENCY_GUARD.minTrades}) per window · else variant FAILS and all soft additions revert
          </span>
          <span className={cls("ml-auto font-mono text-[10px] font-bold tracking-wider", advLive ? "text-bull-400" : "text-bear-400")}>
            SOFT LAYERS: {advLive ? "ACTIVE" : "SUSPENDED"}
          </span>
        </div>
        <p className="font-mono text-[9px] leading-relaxed text-fog-500">
          {gate.detail} · VAL pass needs ≥ {MIN_VAL_TRADES} trades else INSUFFICIENT — NO CONCLUSION · thresholds {PASS_THRESHOLDS.map((t) => t.id).join(" / ")} evaluated on VAL, guard on the full run.
        </p>
      </div>

      {/* windows */}
      {!report || report.windows.length === 0 ? (
        <div className="tv-panel flex flex-col items-center gap-2 px-6 py-16 text-center">
          <IScale size={30} className="text-fog-500" />
          <p className="font-display text-lg font-extrabold tracking-tight text-fog-200">NO BENCHMARK YET</p>
          <p className="max-w-lg text-sm leading-relaxed text-fog-400">
            Run the benchmark to pit {TEST_VARIANT.label} against {BASELINE_VARIANT.label} on {BENCH_WINDOWS.length} identical windows.
            The frequency guard decides whether the advanced soft layers stay live or get reverted.
          </p>
        </div>
      ) : (
        <>
          {report.windows.map((w) => <WindowCard key={w.window.label} w={w} />)}
          <div className="font-mono text-[9px] text-fog-500">
            ran {fmtIST(report.ranAt)} · {(report.elapsedMs / 1000).toFixed(1)}s{report.aborted ? " · ABORTED" : ""} · aggregate guard:{" "}
            <b className={report.advFrequencyOk === false ? "text-bear-400" : report.advFrequencyOk === true ? "text-bull-400" : "text-fog-400"}>
              {report.advFrequencyOk === false ? "FAIL" : report.advFrequencyOk === true ? "PASS" : "INCONCLUSIVE"}
            </b>
          </div>
        </>
      )}

      {/* console */}
      <Card icon={<IFlask size={15} />} title="Benchmark Console" bodyClass="p-0">
        <div ref={logRef} className="max-h-56 overflow-y-auto px-3.5 py-2.5 font-mono text-[10px] leading-relaxed">
          {logs.length === 0 && <p className="text-fog-500">Run the benchmark to stream window-by-window results here.</p>}
          {logs.map((l, i) => (
            <div key={i} className={cls("whitespace-pre-wrap",
              l.kind === "err" ? "text-bear-400" : l.kind === "warn" ? "text-gold-400" : l.kind === "ok" ? "text-bull-400" : "text-fog-400")}>
              <span className="mr-2 text-fog-600 text-fog-500">{new Date(l.t).toLocaleTimeString("en-US", { hour12: false })}</span>{l.msg}
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}
