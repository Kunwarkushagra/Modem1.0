import { useMemo, useState } from "react";
import type { Settings, Trade } from "../lib/types";
import { computePosition, sendTelegram } from "../lib/ai";
import { clearTop30 } from "../lib/cache";
import { deleteTrade, normaliseRadarSymbols } from "../lib/journal";
import { fmtMoney, fmtNum, saveLS, cls } from "../lib/utils";
import { Badge, Btn, Card, IGear, IRadar, IShield, IZap, Stat, useToast } from "./ui";

const inp = "w-full rounded-md border border-ink-500 bg-ink-900 px-2.5 py-1.5 font-mono text-xs text-fog-100 outline-none focus:border-gold-600/70";
const lbl = "mb-1 block font-mono text-[10px] tracking-widest text-fog-500";

/* ---------------- Risk Management ---------------- */

export function RiskView(props: { settings: Settings; onSave: (s: Settings) => void; trades: Trade[]; onTradesChanged: () => void }) {
  const toast = useToast();
  const { settings } = props;
  const [size, setSize] = useState(String(settings.accountSize));
  const [risk, setRisk] = useState(String(settings.riskPercent));
  const [calc, setCalc] = useState({ entry: "", sl: "", tp1: "", tp2: "" });

  const pending = props.trades.filter((t) => t.status === "pending");
  const openExposure = useMemo(() => pending.reduce((s, t) => {
    const riskAmt = (settings.accountSize * settings.riskPercent) / 100;
    return s + riskAmt;
  }, 0), [pending, settings]);

  const saveAccount = () => {
    const a = Number(size), r = Number(risk);
    if (!isFinite(a) || a <= 0 || !isFinite(r) || r <= 0 || r > 10) { toast.push("err", "Account must be positive; risk between 0 and 10%"); return; }
    props.onSave({ ...settings, accountSize: a, riskPercent: r });
    toast.push("ok", `Risk profile saved: ${fmtMoney(a)} account, ${r}% per trade`);
  };

  const pos = (() => {
    const e = Number(calc.entry), sl = Number(calc.sl), t1 = Number(calc.tp1 || calc.entry), t2 = Number(calc.tp2 || calc.tp1 || calc.entry);
    if (!isFinite(e) || e <= 0 || !isFinite(sl) || sl <= 0 || e === sl) return null;
    return computePosition(e, sl, t1, t2, settings.accountSize, settings.riskPercent);
  })();

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <Card icon={<IShield size={15} />} title="Account & Risk Profile">
          <label className="block"><span className={lbl}>ACCOUNT SIZE ($)</span><input value={size} onChange={(e) => setSize(e.target.value)} className={inp} /></label>
          <label className="mt-3 block"><span className={lbl}>RISK PER TRADE (%)</span><input value={risk} onChange={(e) => setRisk(e.target.value)} className={inp} /></label>
          <Btn variant="primary" className="mt-4 w-full" onClick={saveAccount}>SAVE PROFILE</Btn>
          <div className="mt-4 grid grid-cols-2 gap-2">
            <Stat label="Risk $" value={fmtMoney((settings.accountSize * settings.riskPercent) / 100)} tone="gold" sub="per trade, hard cap" />
            <Stat label="Open Trades" value={String(pending.length)} sub={`${fmtMoney(openExposure)} at risk`} tone={pending.length > 3 ? "bear" : "dim"} />
          </div>
        </Card>

        <Card icon={<IZap size={15} />} title="Position Size Calculator">
          <div className="grid grid-cols-2 gap-2">
            <label className="block"><span className={lbl}>ENTRY</span><input value={calc.entry} onChange={(e) => setCalc({ ...calc, entry: e.target.value })} className={inp} placeholder="64000" /></label>
            <label className="block"><span className={lbl}>STOP LOSS</span><input value={calc.sl} onChange={(e) => setCalc({ ...calc, sl: e.target.value })} className={inp} placeholder="63200" /></label>
            <label className="block"><span className={lbl}>TP1</span><input value={calc.tp1} onChange={(e) => setCalc({ ...calc, tp1: e.target.value })} className={inp} placeholder="65600" /></label>
            <label className="block"><span className={lbl}>TP2</span><input value={calc.tp2} onChange={(e) => setCalc({ ...calc, tp2: e.target.value })} className={inp} placeholder="67200" /></label>
          </div>
          {pos ? (
            <div className="mt-4 space-y-1.5 rounded-md border border-ink-600 bg-ink-800/50 p-3 font-mono text-[11.5px]">
              <div className="flex justify-between"><span className="text-fog-400">RISK AMOUNT</span><span className="font-bold text-bear-400">{fmtMoney(pos.riskAmount)}</span></div>
              <div className="flex justify-between"><span className="text-fog-400">POSITION SIZE</span><span className="font-bold text-gold-300">{pos.positionSize >= 100 ? pos.positionSize.toFixed(1) : pos.positionSize.toPrecision(4)} units</span></div>
              <div className="flex justify-between"><span className="text-fog-400">NOTIONAL</span><span className="text-fog-200">{fmtMoney(pos.notional)}</span></div>
              <div className="flex justify-between"><span className="text-fog-400">IF SL HIT</span><span className="text-bear-400">{fmtMoney(pos.lossAtSl)}</span></div>
              <div className="flex justify-between"><span className="text-fog-400">IF TP1 HIT</span><span className="text-bull-400">+{fmtMoney(pos.profitAtTp1)}</span></div>
              <div className="flex justify-between"><span className="text-fog-400">IF TP2 HIT</span><span className="text-bull-400">+{fmtMoney(pos.profitAtTp2)}</span></div>
            </div>
          ) : (
            <p className="mt-4 font-mono text-[11px] text-fog-500">Enter entry + SL → size is risk$ ÷ stop distance.</p>
          )}
        </Card>

        <Card icon={<IShield size={15} />} title="House Rules">
          <ul className="space-y-2.5 text-[11.5px] leading-relaxed text-fog-300">
            {[
              ["1%", "Never risk more than the configured percent on one idea — sizing is computed from stop distance, never conviction."],
              ["2R", "Setups below RR 2.0 are rejected by the engine before you ever see them."],
              ["SL", "The stop is the thesis. Moving it further away converts a trade into a donation."],
              ["3+", "Three open positions max; correlated pairs (BTC+ETH) count double."],
              ["NEWS", "Flat or half-size through FOMC / CPI / earnings unless the setup explicitly budgets for it."],
              ["TILT", "Two straight losses → walk away. The engine already raises its threshold after losing streaks; you should too."],
            ].map(([k, v]) => (
              <li key={k} className="flex gap-2.5">
                <span className="mt-0.5 h-fit shrink-0 rounded border border-gold-600/50 bg-gold-500/10 px-1.5 font-mono text-[9.5px] font-bold text-gold-300">{k}</span>
                <span>{v}</span>
              </li>
            ))}
          </ul>
        </Card>
      </div>

      <Card icon={<IShield size={15} />} title={`Open Exposure · ${pending.length} pending trade(s)`} bodyClass="p-0">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[680px] text-left font-mono text-[11px]">
            <thead>
              <tr className="border-b border-ink-600/70 text-[9.5px] tracking-[0.14em] text-fog-500">
                <th className="px-4 py-2 font-medium">SYMBOL</th><th className="px-2 py-2 font-medium">DIR</th>
                <th className="px-2 py-2 font-medium">ENTRY</th><th className="px-2 py-2 font-medium">SL</th>
                <th className="px-2 py-2 font-medium">STOP DIST</th><th className="px-2 py-2 font-medium">RISK $</th>
                <th className="px-2 py-2 font-medium">SUGGESTED SIZE</th><th className="px-2 py-2" />
              </tr>
            </thead>
            <tbody>
              {pending.length === 0 && <tr><td colSpan={8} className="px-4 py-8 text-center text-fog-500">No open paper positions. Take a validated setup from the terminal.</td></tr>}
              {pending.map((t) => {
                const dist = Math.abs(t.entry - t.stopLoss);
                const p = computePosition(t.entry, t.stopLoss, t.tp1, t.tp2, settings.accountSize, settings.riskPercent);
                return (
                  <tr key={t.id} className="border-b border-ink-600/40 hover:bg-ink-750/60">
                    <td className="px-4 py-2 font-bold text-fog-100">{t.symbol}</td>
                    <td className="px-2 py-2"><Badge tone={t.direction === "Long" ? "bull" : "bear"}>{t.direction.toUpperCase()}</Badge></td>
                    <td className="px-2 py-2 text-gold-300">{fmtNum(t.entry, t.entry < 10 ? 5 : 2)}</td>
                    <td className="px-2 py-2 text-bear-400">{fmtNum(t.stopLoss, t.stopLoss < 10 ? 5 : 2)}</td>
                    <td className="px-2 py-2 text-fog-300">{fmtNum(dist, dist < 1 ? 5 : 2)}</td>
                    <td className="px-2 py-2 text-bear-400">{fmtMoney(p.riskAmount)}</td>
                    <td className="px-2 py-2 text-fog-200">{p.positionSize >= 100 ? p.positionSize.toFixed(1) : p.positionSize.toPrecision(4)} u</td>
                    <td className="px-2 py-2"><Btn size="xs" variant="ghost" onClick={() => { deleteTrade(t.id); props.onTradesChanged(); }}>CANCEL</Btn></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

/* ---------------- Settings ---------------- */

const PROVIDERS: Array<{ v: Settings["provider"]; label: string; modelHint: string }> = [
  { v: "local", label: "OFFLINE ENGINE", modelHint: "deterministic — no key needed" },
  { v: "openai", label: "GPT-4o", modelHint: "gpt-4o" },
  { v: "anthropic", label: "CLAUDE", modelHint: "claude-3-5-sonnet-latest" },
  { v: "qwen", label: "QWEN-MAX", modelHint: "qwen-max (DashScope)" },
  { v: "openrouter", label: "OPENROUTER", modelHint: "any/model-id" },
];

export function SettingsView(props: { settings: Settings; onSave: (s: Settings) => void; onTradesChanged: () => void }) {
  const toast = useToast();
  const [s, setS] = useState<Settings>(props.settings);
  const [tgTesting, setTgTesting] = useState(false);

  const save = (patch: Partial<Settings> | null, msg?: string) => {
    const next = patch ? { ...s, ...patch } : s;
    setS(next);
    props.onSave(next);
    if (msg) toast.push("ok", msg);
  };

  const testTelegram = async () => {
    if (!s.telegramToken || !s.telegramChatId) { toast.push("err", "Set bot token and chat id first"); return; }
    setTgTesting(true);
    const ok = await sendTelegram(s, "TradeVision AI test ✓ — setup alerts will arrive here when the engine validates a trade (RR≥2, filters passed).");
    setTgTesting(false);
    toast.push(ok ? "ok" : "err", ok ? "Telegram test message sent" : "Send failed — check token/chat id (browser CORS may also block; server relay recommended)");
  };

  const clearJournal = () => {
    saveLS("tv_trades_v1", []);
    props.onTradesChanged();
    toast.push("info", "Journal cleared — the engine starts learning from zero");
  };

  return (
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
      <Card icon={<IGear size={15} />} title="Analysis Engine">
        <span className={lbl}>PROVIDER</span>
        <div className="flex flex-wrap gap-1.5">
          {PROVIDERS.map((p) => (
            <button key={p.v} type="button" onClick={() => save({ provider: p.v, model: "" }, `Engine: ${p.label}`)}
              className={cls("tv-btn rounded border px-2.5 py-1.5 font-mono text-[10.5px] font-bold tracking-wider",
                s.provider === p.v ? "border-gold-600 bg-gold-500/12 text-gold-300" : "border-ink-600 text-fog-400 hover:text-fog-200")}>
              {p.label}
            </button>
          ))}
        </div>
        {s.provider !== "local" && (
          <div className="mt-3 space-y-3">
            <label className="block"><span className={lbl}>API KEY (stored only in this browser)</span>
              <input type="password" value={s.apiKey} onChange={(e) => setS({ ...s, apiKey: e.target.value })} onBlur={() => save(null, "API key saved locally")} className={inp} placeholder="sk-…" />
            </label>
            <label className="block"><span className={lbl}>MODEL</span>
              <input value={s.model} onChange={(e) => setS({ ...s, model: e.target.value })} onBlur={() => save(null)} className={inp} placeholder={PROVIDERS.find((p) => p.v === s.provider)?.modelHint} />
            </label>
            <p className="text-[11px] leading-relaxed text-fog-400">
              Keys are sent directly to the provider from your browser and never touch a server. The exact institutional prompt (SMC/ICT/IOC, confluence rules, RR ≥ 2, WR ≥ 60%, false-breakout filters, past-performance adaptation) is used for every call, and every AI setup still passes through the local anti-hallucination validator before display.
            </p>
          </div>
        )}
        {s.provider === "local" && (
          <p className="mt-3 text-[11px] leading-relaxed text-fog-400">
            The offline engine derives setups <span className="text-fog-200">only</span> from detected structure — sweeps, order blocks, FVGs, CHoCH/BOS, premium/discount — and can never invent a level that isn't in the data. Connect a provider above for narrative-grade rationale.
          </p>
        )}
        <div className="mt-4 flex items-center justify-between rounded-md border border-ink-600 bg-ink-800/50 px-3 py-2">
          <span className="font-mono text-[10.5px] tracking-widest text-fog-400">AUTO-REFRESH ANALYSIS (90s)</span>
          <button type="button" onClick={() => save({ autoRefresh: !s.autoRefresh }, `Auto-refresh ${!s.autoRefresh ? "on" : "off"}`)}
            className={cls("tv-btn relative h-5 w-9 rounded-full transition-colors", s.autoRefresh ? "bg-bull-600" : "bg-ink-500")}>
            <span className={cls("absolute top-0.5 h-4 w-4 rounded-full bg-ink-950 transition-all", s.autoRefresh ? "left-[18px]" : "left-0.5")} />
          </button>
        </div>
      </Card>

      <div className="flex flex-col gap-4">
        <Card icon={<IZap size={15} />} title="Telegram Setup Alerts (optional)">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className="block"><span className={lbl}>BOT TOKEN</span><input value={s.telegramToken} onChange={(e) => setS({ ...s, telegramToken: e.target.value })} onBlur={() => save(null, "Telegram settings saved")} className={inp} placeholder="123456:ABC-…" /></label>
            <label className="block"><span className={lbl}>CHAT ID</span><input value={s.telegramChatId} onChange={(e) => setS({ ...s, telegramChatId: e.target.value })} onBlur={() => save(null)} className={inp} placeholder="-100…" /></label>
          </div>
          <div className="mt-3 flex items-center gap-2">
            <Btn variant="outline" size="sm" onClick={() => void testTelegram()} disabled={tgTesting}>{tgTesting ? "SENDING…" : "SEND TEST MESSAGE"}</Btn>
            <Badge tone="dim">fires when a setup passes all validation checks</Badge>
          </div>
        </Card>

        <Card icon={<IRadar size={15} />} title="Top Setups Radar (display layer)">
          <label className="block">
            <span className={lbl}>CUSTOM WATCHLIST · additions to the top-30 (one per line / comma-separated, uppercase, deduped)</span>
            <textarea rows={4} defaultValue={s.radarSymbols.join("\n")}
              onBlur={(e) => {
                const list = normaliseRadarSymbols(e.target.value);
                e.target.value = list.join("\n");
                if (!list.length) { toast.push("err", "Universe needs at least one valid symbol"); return; }
                save({ radarSymbols: list }, `Radar universe: ${list.length} symbols`);
              }}
              className={cls(inp, "leading-relaxed")} spellCheck={false} />
          </label>
          <div className="mt-3 grid grid-cols-2 gap-3">
            <label className="block">
              <span className={lbl}>QUALITY FLOOR (0–100 · default 65)</span>
              <input type="number" min={0} max={100} defaultValue={s.radarQualityFloor}
                onBlur={(e) => {
                  const v = Math.max(0, Math.min(100, Number(e.target.value) || 65));
                  e.target.value = String(v);
                  save({ radarQualityFloor: v }, `Radar quality floor: ${v}`);
                }} className={inp} />
            </label>
            <label className="block">
              <span className={lbl}>QUANTITY FLOOR (0–100 · default 50)</span>
              <input type="number" min={0} max={100} defaultValue={s.quantityFloor}
                onBlur={(e) => {
                  const v = Math.max(0, Math.min(100, Number(e.target.value) || 50));
                  e.target.value = String(v);
                  save({ quantityFloor: v }, `Radar quantity floor: ${v}`);
                }} className={inp} />
            </label>
          </div>

          <div className="mt-4 border-t border-ink-600/60 pt-3">
            <div className="mb-2 flex items-center gap-2">
              <span className="font-mono text-[10px] font-bold tracking-[0.18em] text-fog-300">UNIVERSE HYGIENE GUARDS v2</span>
              <Badge tone="info" className="text-[8px]">DATA-LEVEL · DISPLAY ONLY</Badge>
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <label className="block">
                <span className={lbl}>EXTRA EXCLUDED BASES (comma-separated · stables USDC…USDTB always cut)</span>
                <input defaultValue={s.universeExtraExcludes}
                  onBlur={(e) => {
                    const v = e.target.value.toUpperCase();
                    e.target.value = v;
                    save({ universeExtraExcludes: v }, v.trim() ? "Extra exclusions saved" : "Extra exclusions cleared");
                  }} className={inp} placeholder="e.g. SHIB, PEPE" />
              </label>
              <label className="block">
                <span className={lbl}>MIN 24H QUOTE VOLUME (USDT · default 50M)</span>
                <input type="number" min={0} step={1_000_000} defaultValue={s.universeMinQuoteVolume}
                  onBlur={(e) => {
                    const v = Math.max(0, Number(e.target.value) || 50_000_000);
                    e.target.value = String(v);
                    save({ universeMinQuoteVolume: v }, `Min quote volume: ${v >= 1e6 ? (v / 1e6).toFixed(0) + "M" : v}`);
                  }} className={inp} />
              </label>
              <label className="block">
                <span className={lbl}>24H RANGE FLOOR (% · default 1.5)</span>
                <input type="number" min={0} step={0.1} defaultValue={s.universeVolFloorPct}
                  onBlur={(e) => {
                    const v = Math.max(0, Number(e.target.value) || 1.5);
                    e.target.value = String(v);
                    save({ universeVolFloorPct: v }, `Volatility floor: ${v}%`);
                  }} className={inp} />
              </label>
              <label className="block">
                <span className={lbl}>|24H CHANGE| CAP (% · default 25)</span>
                <input type="number" min={1} step={1} defaultValue={s.universeChangeCapPct}
                  onBlur={(e) => {
                    const v = Math.max(1, Number(e.target.value) || 25);
                    e.target.value = String(v);
                    save({ universeChangeCapPct: v }, `Change cap: ±${v}%`);
                  }} className={inp} />
              </label>
            </div>
            <p className="mt-2 text-[10px] leading-relaxed text-fog-500">
              Applied to the top-30 universe <span className="text-fog-300">before scanning</span>: stablecoins/fiat pegs excluded (hard list + your extras), 24h range ≥ 1.5%, quoteVolume &gt; min, |24h change| ≤ 25%. New listings need <span className="text-fog-300">2 consecutive 6h refreshes</span> before they're scannable (shown as “NEW — WARMING UP”). RESYNC is manual and never auto-tunes these floors. Strategy, validators, and backtest are untouched.
            </p>
          </div>

          <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
            <button type="button" onClick={() => save({ radarUseTop30: !s.radarUseTop30 }, `Top-30 universe ${!s.radarUseTop30 ? "on" : "off"}`)}
              className={cls("tv-btn flex items-center justify-between rounded-md border px-3 py-2 font-mono text-[10.5px] font-bold tracking-widest",
                s.radarUseTop30 ? "border-bull-600 bg-bull-500/12 text-bull-400" : "border-ink-600 text-fog-400")}>
              <span>TOP-30 USDT UNIVERSE</span><span>{s.radarUseTop30 ? "ON" : "OFF"}</span>
            </button>
            <button type="button" onClick={() => {
              void clearTop30().then(() => {
                window.dispatchEvent(new Event("tv-universe-resync"));
                toast.push("info", "Universe cache cleared — refetching now (manual resync; floors untouched)");
              });
            }}
              className="tv-btn flex items-center justify-between rounded-md border border-ink-600 px-3 py-2 font-mono text-[10.5px] font-bold tracking-widest text-fog-400 hover:border-gold-600 hover:text-gold-300">
              <span>RESYNC TOP-30 NOW</span><span>↻</span>
            </button>
            <button type="button" onClick={() => save({ radarSound: !s.radarSound }, `Radar sound ${!s.radarSound ? "on" : "off"}`)}
              className={cls("tv-btn flex items-center justify-between rounded-md border px-3 py-2 font-mono text-[10.5px] font-bold tracking-widest sm:col-span-2",
                s.radarSound ? "border-bull-600 bg-bull-500/12 text-bull-400" : "border-ink-600 text-fog-400")}>
              <span>ALERT SOUND</span><span>{s.radarSound ? "ON" : "OFF"}</span>
            </button>
          </div>
          <p className="mt-3 text-[11px] leading-relaxed text-fog-400">
            Universe = Binance <span className="text-fog-200">top-30 USDT pairs by 24h quote volume</span> (cached 6h, refreshed automatically) merged with your custom list above, deduped, capped at 30. The radar re-runs the <span className="text-fog-200">same live engine</span> (confirmed candles only) for every symbol on each setup-TF close, batched 4-way so the UI never freezes. Modes are display-only — QUALITY shows up to 5 cards ≥ quality floor, QUANTITY up to 8 ≥ quantity floor, AUTO falls back with a banner. No auto-trade, no position sizing; generation, journal and backtests are never touched by mode filtering.
          </p>

          <div className="mt-4 border-t border-ink-600/60 pt-3">
            <div className="mb-2 flex items-center justify-between">
              <span className="font-mono text-[10px] font-bold tracking-[0.18em] text-fog-300">AI INSIGHT · OPINION LAYER</span>
              <button type="button" onClick={() => save({ aiInsightEnabled: !s.aiInsightEnabled }, `AI Insight ${!s.aiInsightEnabled ? "enabled" : "disabled"}`)}
                className={cls("tv-btn relative h-5 w-9 rounded-full transition-colors", s.aiInsightEnabled ? "bg-bull-600" : "bg-ink-500")}>
                <span className={cls("absolute top-0.5 h-4 w-4 rounded-full bg-ink-950 transition-all", s.aiInsightEnabled ? "left-[18px]" : "left-0.5")} />
              </button>
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <label className="block"><span className={lbl}>GEMINI API KEY (static-build fallback)</span>
                <input type="password" value={s.geminiApiKey} onChange={(e) => setS({ ...s, geminiApiKey: e.target.value })} onBlur={() => save(null, s.geminiApiKey ? "Gemini key saved locally" : undefined)} className={inp} placeholder="AIza…" />
              </label>
              <label className="block"><span className={lbl}>MODEL</span>
                <input value={s.geminiModel} onChange={(e) => setS({ ...s, geminiModel: e.target.value })} onBlur={() => save(null)} className={inp} placeholder="gemini-2.0-flash" />
              </label>
            </div>
            <p className="mt-2 text-[10.5px] leading-relaxed text-fog-500">
              Production: deploy <span className="font-mono text-fog-300">server/api-ai-insight.ts</span> as <span className="font-mono text-fog-300">/api/ai-insight</span> — it reads <span className="font-mono text-fog-300">GEMINI_API_KEY</span> from env, whitelists the payload fields, and the key never reaches the browser (cards pick the route up automatically). In this static build the key above stays in your browser and goes straight to Gemini. Insights are cached 6h per signal, one call at a time, and are <span className="text-fog-300">opinion only</span> — they never touch gates, scoring, validity, or the backtest.
            </p>
          </div>
        </Card>

        <Card icon={<IGear size={15} />} title="Data & Storage">
          <ul className="space-y-2 text-[11.5px] leading-relaxed text-fog-300">
            <li><span className="font-mono text-gold-300">MARKET</span> — Binance public klines → OKX fallback (crypto); Yahoo Finance chart → Stooq CSV (stocks/forex). A labelled simulated feed engages only if every source fails.</li>
            <li><span className="font-mono text-gold-300">NEWS</span> — CryptoCompare (crypto) → Google News RSS; Fear &amp; Greed via alternative.me. News is a side factor, never the signal.</li>
            <li><span className="font-mono text-gold-300">JOURNAL</span> — stored in this browser. In the Next.js port (README) the same calls map to /api/trades backed by Postgres/Supabase via DATABASE_URL.</li>
          </ul>
          <div className="mt-4 border-t border-ink-600/60 pt-3">
            <Btn variant="danger" size="sm" onClick={clearJournal}>CLEAR JOURNAL & LEARNING HISTORY</Btn>
          </div>
        </Card>
      </div>
    </div>
  );
}
