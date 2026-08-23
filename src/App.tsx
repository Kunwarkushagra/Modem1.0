import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import type { AssetType, Settings, Timeframe } from "./lib/types";
import { fetchTickerBatch } from "./lib/marketData";
import type { TickerQuote } from "./lib/marketData";
import { loadSettings, loadTrades, saveSettings } from "./lib/journal";
import type { Trade } from "./lib/types";
import { fmtMoney, fmtPrice, cls } from "./lib/utils";
import { Badge, IBook, ICandles, IGear, ILogo, IRadar, IFlask, IShield, ToastProvider } from "./components/ui";
import { TerminalView } from "./components/TerminalView";
import { RadarView } from "./components/RadarView";
import { JournalView } from "./components/JournalView";
import { BacktestView } from "./components/BacktestView";
import { RiskView, SettingsView } from "./components/RiskSettingsView";

type View = "terminal" | "radar" | "journal" | "backtest" | "risk" | "settings";

const NAV: Array<{ v: View; label: string; icon: (p: { size?: number; className?: string }) => ReactNode }> = [
  { v: "terminal", label: "Terminal", icon: ICandles },
  { v: "radar", label: "Radar", icon: IRadar },
  { v: "journal", label: "Journal", icon: IBook },
  { v: "backtest", label: "Backtest", icon: IFlask },
  { v: "risk", label: "Risk", icon: IShield },
  { v: "settings", label: "Settings", icon: IGear },
];

function Clock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  return (
    <span className="hidden font-mono text-[10.5px] tracking-widest text-fog-400 lg:block">
      {now.toLocaleTimeString("en-US", { hour12: false, timeZone: "UTC" })} UTC
    </span>
  );
}

function TickerTape() {
  const [quotes, setQuotes] = useState<TickerQuote[]>([]);
  useEffect(() => {
    let live = true;
    const load = async () => {
      const q = await fetchTickerBatch();
      if (live && q.length) setQuotes(q);
    };
    void load();
    const t = setInterval(() => void load(), 60_000);
    return () => { live = false; clearInterval(t); };
  }, []);
  if (!quotes.length) return <span className="font-mono text-[10px] tracking-widest text-fog-500">CONNECTING TO FEEDS…</span>;
  const items = [...quotes, ...quotes];
  return (
    <div className="relative flex-1 overflow-hidden" style={{ maskImage: "linear-gradient(90deg, transparent, black 6%, black 94%, transparent)" }}>
      <div className="tv-marquee flex w-max items-center gap-7 py-1">
        {items.map((q, i) => (
          <span key={i} className="flex items-center gap-2 font-mono text-[10.5px] whitespace-nowrap">
            <span className="font-bold tracking-wider text-fog-300">{q.label}</span>
            <span className="text-fog-100">{fmtPrice(q.price, q.asset)}</span>
            <span className={q.changePct >= 0 ? "text-bull-400" : "text-bear-400"}>{q.changePct >= 0 ? "▲" : "▼"} {Math.abs(q.changePct).toFixed(2)}%</span>
          </span>
        ))}
      </div>
    </div>
  );
}

function Shell() {
  const [view, setView] = useState<View>("terminal");
  const [settings, setSettings] = useState<Settings>(() => loadSettings());
  const [trades, setTrades] = useState<Trade[]>(() => loadTrades());
  const [btPrefill, setBtPrefill] = useState<{ symbol: string; assetType: AssetType; timeframe: Timeframe; runId: number } | null>(null);
  const [termHandoff, setTermHandoff] = useState<{ symbol: string; assetType: AssetType; timeframe: Timeframe; runId: number } | null>(null);

  const reloadTrades = useCallback(() => setTrades(loadTrades()), []);
  const persistSettings = useCallback((s: Settings) => { setSettings(s); saveSettings(s); }, []);

  const patchSettings = useCallback((patch: Partial<Settings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...patch };
      saveSettings(next);
      return next;
    });
  }, []);

  const gotoBacktest = useCallback((p: { symbol: string; assetType: AssetType; timeframe: Timeframe }) => {
    setBtPrefill({ ...p, runId: Date.now() });
    setView("backtest");
  }, []);

  const openInTerminal = useCallback((p: { symbol: string; assetType: AssetType; timeframe: Timeframe }) => {
    setTermHandoff({ ...p, runId: Date.now() });
    setView("terminal");
  }, []);

  const openCount = useMemo(() => trades.filter((t) => t.status === "pending").length, [trades]);

  return (
    <div className="flex min-h-screen flex-col">
      {/* top bar */}
      <header className="sticky top-0 z-40 border-b border-ink-600/80 bg-ink-900/85 backdrop-blur-md">
        <div className="flex items-center gap-4 px-4 py-2.5">
          <div className="flex shrink-0 items-center gap-2.5">
            <span className="flex h-8 w-8 items-center justify-center rounded-md border border-gold-600/50 bg-gold-500/12 text-gold-400">
              <ILogo size={19} />
            </span>
            <div className="leading-none">
              <div className="font-display text-[15px] font-extrabold tracking-tight text-fog-100">
                TRADEVISION<span className="text-gold-400"> AI</span>
              </div>
              <div className="font-mono text-[8.5px] tracking-[0.3em] text-fog-500">ULTIMATE PRO · SMC/ICT</div>
            </div>
          </div>
          <div className="hidden min-w-0 flex-1 items-center md:flex"><TickerTape /></div>
          <div className="ml-auto flex shrink-0 items-center gap-3">
            <Clock />
            <Badge tone={openCount ? "gold" : "dim"}>{openCount} OPEN</Badge>
            <span className="hidden items-center gap-1.5 rounded-md border border-ink-500 bg-ink-800/70 px-2.5 py-1 font-mono text-[10.5px] text-fog-300 sm:flex">
              <span className="tv-live-dot inline-block h-1.5 w-1.5 rounded-full bg-bull-500" />
              {fmtMoney(settings.accountSize, true)} · {settings.riskPercent}%
            </span>
          </div>
        </div>
        {/* nav */}
        <nav className="flex items-center gap-1 overflow-x-auto px-3 pb-2">
          {NAV.map((n) => (
            <button key={n.v} type="button" onClick={() => setView(n.v)}
              className={cls("tv-btn flex shrink-0 items-center gap-1.5 rounded-md px-3 py-1.5 font-display text-xs font-bold tracking-wide",
                view === n.v ? "bg-gold-500 text-ink-950" : "text-fog-400 hover:bg-ink-700 hover:text-fog-100")}>
              {n.icon({ size: 14 })}
              {n.label.toUpperCase()}
              {n.v === "journal" && openCount > 0 && <span className={cls("rounded-full px-1.5 font-mono text-[9px]", view === n.v ? "bg-ink-950/20" : "bg-gold-500/20 text-gold-300")}>{openCount}</span>}
            </button>
          ))}
          <span className="ml-auto hidden shrink-0 font-mono text-[9px] tracking-[0.22em] text-fog-500 md:block">
            ENGINE: {settings.provider === "local" ? "OFFLINE DETERMINISTIC" : settings.provider.toUpperCase()}
          </span>
        </nav>
      </header>

      {/* main */}
      <main className="mx-auto w-full max-w-[1560px] flex-1 px-4 py-4">
        {view === "terminal" && (
          <TerminalView settings={settings} onTradesChanged={reloadTrades} onGotoBacktest={gotoBacktest} onOpenSettings={() => setView("settings")} handoff={termHandoff} />
        )}
        {view === "radar" && (
          <RadarView settings={settings} onSettingsChange={patchSettings} onOpenInTerminal={openInTerminal} />
        )}
        {view === "journal" && <JournalView trades={trades} onChanged={reloadTrades} />}
        {view === "backtest" && <BacktestView prefill={btPrefill} />}
        {view === "risk" && <RiskView settings={settings} onSave={persistSettings} trades={trades} onTradesChanged={reloadTrades} />}
        {view === "settings" && <SettingsView settings={settings} onSave={persistSettings} onTradesChanged={reloadTrades} />}
      </main>

      <footer className="border-t border-ink-600/60 px-4 py-3">
        <div className="mx-auto flex max-w-[1560px] flex-wrap items-center gap-x-4 gap-y-1 font-mono text-[9.5px] tracking-widest text-fog-500">
          <span>TRADEVISION AI ULTIMATE PRO</span>
          <span className="hidden sm:inline">·</span>
          <span>SMC / ICT / IOC / SL-HUNT PIPELINE</span>
          <span className="hidden sm:inline">·</span>
          <span>ANTI-HALLUCINATION VALIDATOR ARMED</span>
          <span className="ml-auto text-gold-600/80">ANALYTICS ARE NOT FINANCIAL ADVICE</span>
        </div>
      </footer>
    </div>
  );
}

export default function App() {
  return (
    <ToastProvider>
      <Shell />
    </ToastProvider>
  );
}
