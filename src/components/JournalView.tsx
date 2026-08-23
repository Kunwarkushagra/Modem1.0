import { useMemo, useState } from "react";
import type { AssetType, Direction, ExitReason, Trade, TradeOutcome } from "../lib/types";
import { addTrade, deleteTrade, updateTrade } from "../lib/journal";
import { computePerformance } from "../lib/performance";
import { fmtNum, fmtPct, fmtTime, cls } from "../lib/utils";
import { Badge, Btn, Card, IBook, ICheck, IPlus, Modal, PctCell, Segmented, SparkLine, Stat, useToast } from "./ui";

const EXIT_REASONS: ExitReason[] = ["SL", "TP1", "TP2", "BE", "time-exit", "invalidation", "manual"];
const defaultReason = (o: TradeOutcome): ExitReason => (o === "win" ? "TP1" : o === "loss" ? "SL" : "BE");

function pnlOf(t: { direction: Direction; entry: number; stopLoss: number; tp1: number }, exit: number, outcome: TradeOutcome) {
  const dir = t.direction === "Long" ? 1 : -1;
  const pnlPct = ((exit - t.entry) / t.entry) * 100 * dir;
  const risk = Math.abs(t.entry - t.stopLoss);
  let pnlR = risk > 0 ? ((exit - t.entry) / risk) * dir : 0;
  if (outcome === "win") pnlR = Math.max(pnlR, Math.abs(t.tp1 - t.entry) / Math.max(risk, 1e-9));
  return { pnlPct: Number(pnlPct.toFixed(2)), pnlR: Number(pnlR.toFixed(2)) };
}

const EMPTY_FORM = { symbol: "BTCUSDT", assetType: "crypto" as AssetType, timeframe: "1h", direction: "Long" as Direction, entry: "", sl: "", tp1: "", tp2: "", notes: "" };

export function JournalView(props: { trades: Trade[]; onChanged: () => void }) {
  const toast = useToast();
  const [fSymbol, setFSymbol] = useState("");
  const [fDir, setFDir] = useState<"all" | Direction>("all");
  const [fOutcome, setFOutcome] = useState<"all" | "open" | TradeOutcome>("all");
  const [closing, setClosing] = useState<Trade | null>(null);
  const [closeForm, setCloseForm] = useState({ outcome: "win" as TradeOutcome, exit: "", notes: "", exitReason: "TP1" as ExitReason });
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);

  const perf = useMemo(() => computePerformance(props.trades), [props.trades]);

  const filtered = useMemo(() => props.trades.filter((t) => {
    if (fSymbol && !t.symbol.toLowerCase().includes(fSymbol.toLowerCase())) return false;
    if (fDir !== "all" && t.direction !== fDir) return false;
    if (fOutcome === "open" && t.status !== "pending") return false;
    if (fOutcome !== "all" && fOutcome !== "open" && t.outcome !== fOutcome) return false;
    return true;
  }), [props.trades, fSymbol, fDir, fOutcome]);

  const doClose = () => {
    if (!closing) return;
    const exit = Number(closeForm.exit);
    if (!isFinite(exit) || exit <= 0) { toast.push("err", "Enter a valid exit price"); return; }
    const { pnlPct, pnlR } = pnlOf(closing, exit, closeForm.outcome);
    updateTrade(closing.id, {
      status: "closed", outcome: closeForm.outcome, exitPrice: exit,
      pnlPct: closeForm.outcome === "breakeven" ? 0 : pnlPct,
      pnlR: closeForm.outcome === "breakeven" ? 0 : pnlR,
      closedAt: Date.now(), notes: closeForm.notes,
      exitReason: closeForm.exitReason,
    });
    props.onChanged();
    setClosing(null);
    toast.push("ok", `${closing.symbol} closed as ${closeForm.outcome.toUpperCase()} (${fmtPct(closeForm.outcome === "breakeven" ? 0 : pnlPct)}) — engine will learn from this trade`);
  };

  const doAdd = () => {
    const entry = Number(form.entry), sl = Number(form.sl), tp1 = Number(form.tp1), tp2 = Number(form.tp2 || form.tp1);
    if (!form.symbol || !isFinite(entry) || entry <= 0 || !isFinite(sl) || sl <= 0 || !isFinite(tp1) || tp1 <= 0) {
      toast.push("err", "Fill symbol, entry, SL and TP1 with valid numbers"); return;
    }
    const risk = Math.abs(entry - sl);
    const rr = risk > 0 ? Math.abs(tp1 - entry) / risk : 0;
    addTrade({
      symbol: form.symbol.toUpperCase(), assetType: form.assetType, timeframe: form.timeframe,
      direction: form.direction, entry, stopLoss: sl, tp1, tp2,
      rr: Number(rr.toFixed(2)), confidence: 50, confluences: ["Manual"], rationale: form.notes || "Manually logged trade.",
      status: "pending", outcome: null, exitPrice: null, pnlPct: null, pnlR: null, closedAt: null, notes: form.notes, source: "manual",
    });
    props.onChanged();
    setAdding(false);
    setForm(EMPTY_FORM);
    toast.push("ok", "Manual trade logged to journal");
  };

  const outcomeBadge = (t: Trade) => {
    if (t.status === "pending") return <Badge tone="gold">OPEN</Badge>;
    return t.outcome === "win" ? <Badge tone="bull">WIN</Badge> : t.outcome === "loss" ? <Badge tone="bear">LOSS</Badge> : <Badge tone="dim">BE</Badge>;
  };

  const inp = "w-full rounded-md border border-ink-500 bg-ink-900 px-2.5 py-1.5 font-mono text-xs text-fog-100 outline-none focus:border-gold-600/70";

  return (
    <div className="flex flex-col gap-4">
      {/* metrics */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <Stat label="Win Rate" value={perf.total ? perf.winRate.toFixed(1) + "%" : "—"} sub={`${perf.wins}W / ${perf.losses}L / ${perf.breakeven}BE`} tone={perf.winRate >= 50 ? "bull" : "dim"} />
        <Stat label="Avg Win" value={perf.total ? fmtPct(perf.avgWinPct) : "—"} tone="bull" sub="per closed trade" />
        <Stat label="Avg Loss" value={perf.total ? fmtPct(perf.avgLossPct) : "—"} tone="bear" sub="per closed trade" />
        <Stat label="Profit Factor" value={perf.total ? perf.profitFactor.toFixed(2) : "—"} tone="gold" sub="gross win / gross loss" />
        <Stat label="Sharpe (trade)" value={perf.total ? perf.sharpe.toFixed(2) : "—"} sub={`max DD ${perf.total ? perf.maxDrawdown.toFixed(1) : "0"}%`} />
        <Stat label="Closed Trades" value={String(perf.total)} sub="fuel for self-learning" />
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <Card className="xl:col-span-2" icon={<IBook size={15} />} title="Equity Curve (compounded, 100 base)"
          right={perf.equity.length > 1 ? <PctCell v={(perf.equity[perf.equity.length - 1] - 100)} /> : undefined}>
          {perf.equity.length > 2 ? (
            <div className="flex items-center gap-4">
              <SparkLine values={perf.equity} width={520} height={90} baseline={100} />
              <div className="hidden font-mono text-[11px] leading-relaxed text-fog-400 sm:block">
                <div>EQUITY <span className={cls("font-bold", perf.equity[perf.equity.length - 1] >= 100 ? "text-bull-400" : "text-bear-400")}>{perf.equity[perf.equity.length - 1].toFixed(1)}</span></div>
                <div>PEAK DD <span className="text-bear-400">−{perf.maxDrawdown.toFixed(1)}%</span></div>
                <div>LAST 10 WR <span className={perf.recent.winRate >= 50 ? "text-bull-400" : "text-gold-400"}>{perf.recent.trades ? perf.recent.winRate.toFixed(0) + "%" : "—"}</span>{perf.recent.tilt && <span className="ml-1 text-gold-400">· TILT</span>}</div>
              </div>
            </div>
          ) : (
            <p className="py-6 text-center font-mono text-xs text-fog-500">Close trades to grow the curve — every result retrains the engine's confluence weighting.</p>
          )}
        </Card>

        <Card icon={<ISparkle size={15} />} title="Confluence Edge Map">
          {perf.bestConfluences.length === 0 && perf.worstConfluences.length === 0 ? (
            <p className="font-mono text-xs text-fog-500">Needs ≥ 2 closed trades per confluence to mine an edge.</p>
          ) : (
            <div className="space-y-1.5">
              {[...perf.bestConfluences.slice(0, 3), ...perf.worstConfluences.slice(0, 2)].map((c, i) => {
                const best = i < Math.min(3, perf.bestConfluences.length);
                return (
                  <div key={c.confluence + i} className="flex items-center justify-between rounded border border-ink-600/60 bg-ink-800/40 px-2.5 py-1.5">
                    <div>
                      <div className="text-[11px] font-semibold text-fog-200">{c.confluence}</div>
                      <div className="font-mono text-[9.5px] text-fog-500">{c.trades} trades · avg RR {c.avgRR.toFixed(1)}</div>
                    </div>
                    <Badge tone={best ? (c.winRate >= 60 ? "bull" : "dim") : c.winRate < 45 ? "bear" : "dim"}>{c.winRate.toFixed(0)}% WR</Badge>
                  </div>
                );
              })}
            </div>
          )}
        </Card>
      </div>

      {/* table */}
      <Card
        icon={<IBook size={15} />} title={`Trade Journal · ${filtered.length}`}
        right={<Btn variant="primary" size="sm" onClick={() => setAdding(true)}><IPlus size={13} /> LOG MANUAL TRADE</Btn>}
        bodyClass="p-0"
      >
        <div className="flex flex-wrap items-center gap-2 border-b border-ink-600/70 px-4 py-2.5">
          <input value={fSymbol} onChange={(e) => setFSymbol(e.target.value)} placeholder="Filter symbol…" className="w-32 rounded border border-ink-500 bg-ink-900 px-2 py-1 font-mono text-[11px] text-fog-200 outline-none focus:border-gold-600/60" />
          <Segmented size="sm" options={[{ v: "all" as const, label: "ALL" }, { v: "Long" as Direction, label: "LONG" }, { v: "Short" as Direction, label: "SHORT" }]} value={fDir} onChange={setFDir} />
          <Segmented size="sm" options={[{ v: "all" as const, label: "ANY" }, { v: "open" as const, label: "OPEN" }, { v: "win" as TradeOutcome, label: "W" }, { v: "loss" as TradeOutcome, label: "L" }, { v: "breakeven" as TradeOutcome, label: "BE" }]} value={fOutcome} onChange={setFOutcome} />
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[860px] text-left font-mono text-[11px]">
            <thead>
              <tr className="border-b border-ink-600/70 text-[9.5px] tracking-[0.14em] text-fog-500">
                <th className="px-4 py-2 font-medium">OPENED</th>
                <th className="px-2 py-2 font-medium">SYMBOL</th>
                <th className="px-2 py-2 font-medium">DIR</th>
                <th className="px-2 py-2 font-medium">ENTRY</th>
                <th className="px-2 py-2 font-medium">SL</th>
                <th className="px-2 py-2 font-medium">TP1</th>
                <th className="px-2 py-2 font-medium">RR</th>
                <th className="px-2 py-2 font-medium">CONFLUENCES</th>
                <th className="px-2 py-2 font-medium">RESULT</th>
                <th className="px-2 py-2 font-medium">EXIT</th>
                <th className="px-2 py-2 font-medium">PNL</th>
                <th className="px-2 py-2" />
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 && (
                <tr><td colSpan={12} className="px-4 py-10 text-center text-fog-500">No trades match. Take a validated setup from the terminal or log one manually.</td></tr>
              )}
              {filtered.map((t) => (
                <tr key={t.id} className="border-b border-ink-600/40 transition-colors hover:bg-ink-750/60">
                  <td className="px-4 py-2 text-fog-400">{fmtTime(t.createdAt)}</td>
                  <td className="px-2 py-2 font-bold text-fog-100">
                    {t.symbol}<span className="ml-1 text-[9px] text-fog-500">{t.timeframe}·{t.source.toUpperCase()}</span>
                    {t.signalType && (
                      <span
                        className="mt-0.5 block text-[8.5px] font-normal tracking-wide text-gold-500/90"
                        title={`Signal generated ${t.signalDisplayIST ?? ""}${t.signalValidTill ? ` · valid till ${new Date(t.signalValidTill).toUTCString()}` : ""}`}
                      >
                        {t.signalType.toUpperCase()} SIGNAL · {t.signalDisplayIST ?? "n/a"}
                      </span>
                    )}
                  </td>
                  <td className="px-2 py-2"><Badge tone={t.direction === "Long" ? "bull" : "bear"}>{t.direction === "Long" ? "LONG" : "SHORT"}</Badge></td>
                  <td className="px-2 py-2 text-gold-300">{fmtNum(t.entry, t.entry < 10 ? 5 : 2)}</td>
                  <td className="px-2 py-2 text-bear-400">{fmtNum(t.stopLoss, t.stopLoss < 10 ? 5 : 2)}</td>
                  <td className="px-2 py-2 text-bull-400">{fmtNum(t.tp1, t.tp1 < 10 ? 5 : 2)}</td>
                  <td className="px-2 py-2 text-fog-200">{t.rr.toFixed(1)}</td>
                  <td className="max-w-[180px] truncate px-2 py-2 text-fog-400" title={t.confluences.join(", ")}>{t.confluences.join(", ")}</td>
                  <td className="px-2 py-2">{outcomeBadge(t)}</td>
                  <td className="px-2 py-2">{t.status === "closed" && t.exitReason
                    ? <Badge tone={t.exitReason === "invalidation" ? "bear" : t.exitReason === "SL" ? "bear" : t.exitReason === "manual" ? "dim" : "info"}>{t.exitReason}</Badge>
                    : <span className="text-fog-500">—</span>}</td>
                  <td className="px-2 py-2"><PctCell v={t.pnlPct} />{t.pnlR != null && t.status === "closed" && <span className="ml-1 text-[9px] text-fog-500">{t.pnlR > 0 ? "+" : ""}{t.pnlR}R</span>}</td>
                  <td className="px-2 py-2">
                    <div className="flex gap-1">
                      {t.status === "pending" && <Btn size="xs" variant="success" onClick={() => { setClosing(t); setCloseForm({ outcome: "win", exit: String(t.tp1), notes: "", exitReason: "TP1" }); }}><ICheck size={11} /> CLOSE</Btn>}
                      <Btn size="xs" variant="ghost" title="Delete" onClick={() => { deleteTrade(t.id); props.onChanged(); toast.push("info", `${t.symbol} trade deleted`); }}><ITrash size={11} /></Btn>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      {/* close modal */}
      <Modal open={!!closing} onClose={() => setClosing(null)} title={closing ? `Close ${closing.symbol} ${closing.direction}` : ""}>
        {closing && (
          <div className="space-y-3">
            <div className="grid grid-cols-3 gap-2">
              {(["win", "loss", "breakeven"] as TradeOutcome[]).map((o) => (
                <button key={o} type="button" onClick={() => setCloseForm((f) => ({ ...f, outcome: o, exitReason: defaultReason(o) }))}
                  className={cls("tv-btn rounded-md border px-3 py-2.5 font-mono text-xs font-bold uppercase",
                    closeForm.outcome === o
                      ? o === "win" ? "border-bull-600 bg-bull-500/15 text-bull-300" : o === "loss" ? "border-bear-600 bg-bear-500/15 text-bear-300" : "border-ink-400 bg-ink-600/40 text-fog-100"
                      : "border-ink-600 text-fog-400 hover:text-fog-200")}>
                  {o}
                </button>
              ))}
            </div>
            <div>
              <span className="mb-1 block font-mono text-[10px] tracking-widest text-fog-500">EXIT REASON (how did it end?)</span>
              <div className="flex flex-wrap gap-1.5">
                {EXIT_REASONS.map((r) => (
                  <button key={r} type="button" onClick={() => setCloseForm((f) => ({ ...f, exitReason: r }))}
                    className={cls("tv-btn rounded border px-2 py-1 font-mono text-[10px] font-bold uppercase tracking-wider",
                      closeForm.exitReason === r ? "border-gold-600 bg-gold-500/15 text-gold-300" : "border-ink-600 text-fog-400 hover:text-fog-200")}>
                    {r}
                  </button>
                ))}
              </div>
            </div>
            <label className="block">
              <span className="mb-1 block font-mono text-[10px] tracking-widest text-fog-500">EXIT PRICE</span>
              <input value={closeForm.exit} onChange={(e) => setCloseForm((f) => ({ ...f, exit: e.target.value }))} className={inp} />
            </label>
            {(() => {
              const ex = Number(closeForm.exit);
              if (!isFinite(ex) || ex <= 0) return null;
              const { pnlPct, pnlR } = pnlOf(closing, ex, closeForm.outcome);
              return <div className="rounded border border-ink-600 bg-ink-800/60 px-3 py-2 font-mono text-[11px] text-fog-300">→ {fmtPct(pnlPct)} · {pnlR > 0 ? "+" : ""}{pnlR}R vs risk</div>;
            })()}
            <label className="block">
              <span className="mb-1 block font-mono text-[10px] tracking-widest text-fog-500">NOTES (what did the market teach you?)</span>
              <textarea value={closeForm.notes} onChange={(e) => setCloseForm((f) => ({ ...f, notes: e.target.value }))} rows={2} className={inp} />
            </label>
            <div className="flex justify-end gap-2">
              <Btn variant="ghost" onClick={() => setClosing(null)}>CANCEL</Btn>
              <Btn variant="primary" onClick={doClose}>RECORD OUTCOME</Btn>
            </div>
          </div>
        )}
      </Modal>

      {/* add modal */}
      <Modal open={adding} onClose={() => setAdding(false)} title="Log Manual Trade">
        <div className="grid grid-cols-2 gap-3">
          <label className="block"><span className="mb-1 block font-mono text-[10px] tracking-widest text-fog-500">SYMBOL</span><input value={form.symbol} onChange={(e) => setForm({ ...form, symbol: e.target.value.toUpperCase() })} className={inp} /></label>
          <label className="block"><span className="mb-1 block font-mono text-[10px] tracking-widest text-fog-500">ASSET</span>
            <select value={form.assetType} onChange={(e) => setForm({ ...form, assetType: e.target.value as AssetType })} className={inp}>
              <option value="crypto">Crypto</option><option value="stock">Stock</option><option value="forex">Forex</option>
            </select>
          </label>
          <label className="block"><span className="mb-1 block font-mono text-[10px] tracking-widest text-fog-500">DIRECTION</span>
            <select value={form.direction} onChange={(e) => setForm({ ...form, direction: e.target.value as Direction })} className={inp}>
              <option>Long</option><option>Short</option>
            </select>
          </label>
          <label className="block"><span className="mb-1 block font-mono text-[10px] tracking-widest text-fog-500">TIMEFRAME</span><input value={form.timeframe} onChange={(e) => setForm({ ...form, timeframe: e.target.value })} className={inp} /></label>
          <label className="block"><span className="mb-1 block font-mono text-[10px] tracking-widest text-fog-500">ENTRY</span><input value={form.entry} onChange={(e) => setForm({ ...form, entry: e.target.value })} className={inp} placeholder="0.00" /></label>
          <label className="block"><span className="mb-1 block font-mono text-[10px] tracking-widest text-fog-500">STOP LOSS</span><input value={form.sl} onChange={(e) => setForm({ ...form, sl: e.target.value })} className={inp} placeholder="0.00" /></label>
          <label className="block"><span className="mb-1 block font-mono text-[10px] tracking-widest text-fog-500">TP1</span><input value={form.tp1} onChange={(e) => setForm({ ...form, tp1: e.target.value })} className={inp} placeholder="0.00" /></label>
          <label className="block"><span className="mb-1 block font-mono text-[10px] tracking-widest text-fog-500">TP2 (optional)</span><input value={form.tp2} onChange={(e) => setForm({ ...form, tp2: e.target.value })} className={inp} placeholder="0.00" /></label>
        </div>
        <label className="mt-3 block"><span className="mb-1 block font-mono text-[10px] tracking-widest text-fog-500">RATIONALE / CONFLUENCES</span><textarea rows={2} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} className={inp} placeholder="e.g. Bullish OB + FVG after SSL sweep…" /></label>
        <div className="mt-4 flex justify-end gap-2">
          <Btn variant="ghost" onClick={() => setAdding(false)}>CANCEL</Btn>
          <Btn variant="primary" onClick={doAdd}>ADD TO JOURNAL</Btn>
        </div>
      </Modal>
    </div>
  );
}

// local glyphs used only here
export function ISparkle(p: { size?: number; className?: string }) {
  return (
    <svg width={p.size ?? 15} height={p.size ?? 15} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" className={p.className}>
      <path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z" />
      <path d="M19 16l.9 2.1L22 19l-2.1.9L19 22l-.9-2.1L16 19l2.1-.9z" />
    </svg>
  );
}

export function ITrash(p: { size?: number; className?: string }) {
  return (
    <svg width={p.size ?? 15} height={p.size ?? 15} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className={p.className}>
      <path d="M4 7h16M9.5 7V4.5h5V7M6.5 7l1 13h9l1-13M10 11v6M14 11v6" />
    </svg>
  );
}
