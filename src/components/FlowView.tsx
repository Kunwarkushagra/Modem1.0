import { useCallback, useEffect, useRef, useState } from "react";
import type { AggTrade, FlowSnapshot, FlowState, FlowTimeframe } from "../lib/types";
import { fetchAggTrades, fetchDepth, fetchKlines, updateFlow, wsManager } from "../lib/orderFlow";
import { getCachedFlow, setCachedFlow } from "../lib/flowCache";
import { fmtIST } from "../lib/utils";
import { Badge, Btn, Card, IFlow, IRefresh, IWarn, Segmented, useToast } from "./ui";

const TF_OPTIONS: Array<{ v: FlowTimeframe; label: string }> = [
  { v: "1m", label: "1M" },
  { v: "5m", label: "5M" },
  { v: "15m", label: "15M" },
];

interface FlowViewProps {
  symbol: string;
  onSymbolChange: (symbol: string) => void;
  settings: {
    lookbackCandles: number;
    sweepPercent: number;
    wallMultiplier: number;
    absorptionThreshold: number;
    cvdNetRatio: number;
    wallPersistMs: number;
  };
}

export function FlowView({ symbol, onSymbolChange, settings }: FlowViewProps) {
  const toast = useToast();
  const [timeframe, setTimeframe] = useState<FlowTimeframe>("1m");
  const [state, setState] = useState<FlowState | null>(null);
  const [snapshot, setSnapshot] = useState<FlowSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [wsConnected, setWsConnected] = useState(false);
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // REST polling with 2s minimum gap
  const pollData = useCallback(async () => {
    if (!symbol) return;

    setLoading(true);
    setError(null);

    try {
      // fetch klines
      const candles = await fetchKlines(symbol, timeframe, 100);

      // fetch aggTrades (max 3 calls, 1000 each)
      const trades: AggTrade[] = [];
      let fromId: number | undefined;
      for (let i = 0; i < 3; i++) {
        const batch = await fetchAggTrades(symbol, fromId, 1000);
        if (batch.length === 0) break;
        trades.unshift(...batch);
        fromId = batch[0].a + 1;
        if (batch.length < 1000) break;
      }

      // fetch depth
      const depth = await fetchDepth(symbol, 15);

      const newState: FlowState = {
        symbol,
        timeframe,
        candles,
        trades,
        depth,
        lastUpdate: Date.now(),
        error: null,
      };

      setState(newState);

      // update snapshot
      const snap = await updateFlow(newState, settings);
      setSnapshot(snap);

      // cache for radar chip
      setCachedFlow(symbol, snap);

      setLoading(false);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "fetch failed";
      setError(msg);
      setLoading(false);
      console.error("[flow] poll error:", e);
    }
  }, [symbol, timeframe, settings]);

  // WS connection (only while FLOW tab is open)
  useEffect(() => {
    if (!symbol) return;

    const streams = [`${symbol.toLowerCase()}@aggTrade`, `${symbol.toLowerCase()}@depth@100ms`];

    wsManager.connect(streams, (stream, data) => {
      if (!state) return;

      // handle aggTrade
      if (stream.includes("aggTrade")) {
        const trade = data as AggTrade;
        setState((prev) => {
          if (!prev) return prev;
          const newTrades = [...prev.trades, trade].slice(-5000); // keep last 5000
          return { ...prev, trades: newTrades, lastUpdate: Date.now() };
        });
      }

      // handle depth
      if (stream.includes("depth")) {
        const depthData = data as { bids: Array<[string, string]>; asks: Array<[string, string]> };
        setState((prev) => {
          if (!prev) return prev;
          const newDepth = {
            bids: depthData.bids.map(([price, qty]) => ({ price, qty })),
            asks: depthData.asks.map(([price, qty]) => ({ price, qty })),
          };
          return { ...prev, depth: newDepth, lastUpdate: Date.now() };
        });
      }

      setWsConnected(true);
    });

    // poll every 2s
    pollTimerRef.current = setInterval(pollData, 2000);
    pollData(); // initial poll

    return () => {
      wsManager.disconnect();
      if (pollTimerRef.current) {
        clearInterval(pollTimerRef.current);
        pollTimerRef.current = null;
      }
      setWsConnected(false);
    };
  }, [symbol, timeframe]);

  // update snapshot when state changes (from WS updates)
  useEffect(() => {
    if (!state) return;
    updateFlow(state, settings).then((snap) => {
      setSnapshot(snap);
      setCachedFlow(symbol, snap);
    });
  }, [state, settings, symbol]);

  // draw CVD chart
  useEffect(() => {
    if (!canvasRef.current || !state || state.trades.length < 10) return;

    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const width = canvas.width;
    const height = canvas.height;

    // clear
    ctx.fillStyle = "#0a0a0a";
    ctx.fillRect(0, 0, width, height);

    // calculate CVD
    const cutoff = Date.now() - 30 * 60 * 1000;
    const recentTrades = state.trades.filter((t) => t.T >= cutoff);
    if (recentTrades.length < 10) return;

    let cvd = 0;
    const points: Array<{ t: number; cvd: number }> = [];

    for (const trade of recentTrades) {
      const qty = parseFloat(trade.q);
      const delta = trade.m ? -qty : qty;
      cvd += delta;
      points.push({ t: trade.T, cvd });
    }

    if (points.length < 2) return;

    // draw CVD line
    const minT = points[0].t;
    const maxT = points[points.length - 1].t;
    const minCVD = Math.min(...points.map((p) => p.cvd));
    const maxCVD = Math.max(...points.map((p) => p.cvd));
    const cvdRange = maxCVD - minCVD || 1;

    ctx.strokeStyle = cvd >= 0 ? "#31d48f" : "#f5566b";
    ctx.lineWidth = 2;
    ctx.beginPath();

    for (let i = 0; i < points.length; i++) {
      const x = ((points[i].t - minT) / (maxT - minT)) * width;
      const y = height - ((points[i].cvd - minCVD) / cvdRange) * height;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }

    ctx.stroke();

    // draw zero line
    if (minCVD < 0 && maxCVD > 0) {
      const zeroY = height - ((0 - minCVD) / cvdRange) * height;
      ctx.strokeStyle = "#666";
      ctx.lineWidth = 1;
      ctx.setLineDash([5, 5]);
      ctx.beginPath();
      ctx.moveTo(0, zeroY);
      ctx.lineTo(width, zeroY);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }, [state]);

  // error handling
  useEffect(() => {
    if (error) {
      if (error.includes("429")) {
        toast.push("err", "FLOW: Rate limited (429) — backing off");
      } else if (error.includes("451")) {
        toast.push("err", "FLOW: Unavailable in your region (451)");
      } else {
        toast.push("err", `FLOW: ${error}`);
      }
    }
  }, [error, toast]);

  // check for cached snapshot
  useEffect(() => {
    const cached = getCachedFlow(symbol);
    if (cached && !snapshot) {
      setSnapshot(cached);
    }
  }, [symbol, snapshot]);

  const score = snapshot?.score ?? 0;
  const direction = snapshot?.direction;

  return (
    <div className="flex flex-col gap-4">
      {/* header */}
      <div className="tv-panel flex flex-wrap items-center gap-3 px-4 py-3">
        <div className="flex items-center gap-2">
          <span className="flex h-8 w-8 items-center justify-center rounded-md border border-gold-600/50 bg-gold-500/12 text-gold-400">
            <IFlow size={16} />
          </span>
          <div className="leading-none">
            <div className="font-display text-sm font-extrabold tracking-tight text-fog-100">ORDER FLOW</div>
            <div className="font-mono text-[8.5px] tracking-[0.26em] text-fog-500">INSTITUTIONAL ACTIVITY · DISPLAY ONLY</div>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <input
            value={symbol}
            onChange={(e) => onSymbolChange(e.target.value.toUpperCase())}
            placeholder="SYMBOL"
            className="w-28 rounded-md border border-ink-500 bg-ink-900 px-3 py-1.5 font-mono text-sm font-semibold text-gold-300 outline-none focus:border-gold-600/70"
          />
          <Segmented size="sm" options={TF_OPTIONS} value={timeframe} onChange={setTimeframe} />
        </div>

        <div className="ml-auto flex items-center gap-3">
          <Badge tone={wsConnected ? "bull" : "dim"}>
            {wsConnected ? "WS LIVE" : "WS OFF"}
          </Badge>
          <Btn variant="ghost" size="sm" onClick={pollData} disabled={loading}>
            <IRefresh size={12} /> {loading ? "POLLING…" : "REFRESH"}
          </Btn>
        </div>
      </div>

      {/* institutional entry zone banner */}
      {score === 3 && direction && (
        <div className={`tv-panel tv-rise border-2 px-4 py-3 ${direction === "LONG" ? "border-bull-600 bg-bull-500/10" : "border-bear-600 bg-bear-500/10"}`}>
          <div className="flex items-center gap-3">
            <span className={`text-2xl font-display font-extrabold ${direction === "LONG" ? "text-bull-400" : "text-bear-400"}`}>
              INSTITUTIONAL ENTRY ZONE — {direction}
            </span>
            <span className="font-mono text-xs text-fog-400">{fmtIST(Date.now())}</span>
          </div>
        </div>
      )}

      {/* error chip */}
      {error && (
        <div className="tv-panel flex items-center gap-2 border-bear-600/50 px-4 py-2 text-sm text-bear-300">
          <IWarn size={14} />
          <span>{error}</span>
          <Btn variant="ghost" size="xs" onClick={pollData}>
            RETRY
          </Btn>
        </div>
      )}

      {/* condition checklist */}
      {snapshot && (
        <Card icon={<IFlow size={15} />} title="CONDITIONS" bodyClass="p-3">
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="font-mono text-xs text-fog-400">1. LIQUIDITY SWEEP</span>
              <div className="flex items-center gap-2">
                <span className="font-mono text-xs text-fog-300">{snapshot.sweep.value}</span>
                <Badge tone={snapshot.sweep.pass ? "bull" : "dim"}>
                  {snapshot.sweep.pass ? "PASS" : "FAIL"}
                </Badge>
              </div>
            </div>
            <div className="flex items-center justify-between">
              <span className="font-mono text-xs text-fog-400">2. CVD DIVERGENCE</span>
              <div className="flex items-center gap-2">
                <span className="font-mono text-xs text-fog-300">{snapshot.cvd.value}</span>
                <Badge tone={snapshot.cvd.pass ? "bull" : "dim"}>
                  {snapshot.cvd.pass ? "PASS" : "FAIL"}
                </Badge>
              </div>
            </div>
            <div className="flex items-center justify-between">
              <span className="font-mono text-xs text-fog-400">3. BID/ASK ABSORPTION</span>
              <div className="flex items-center gap-2">
                <span className="font-mono text-xs text-fog-300">{snapshot.absorption.value}</span>
                <Badge tone={snapshot.absorption.pass ? "bull" : "dim"}>
                  {snapshot.absorption.pass ? "PASS" : "FAIL"}
                </Badge>
              </div>
            </div>
            <div className="mt-3 border-t border-ink-600/50 pt-2">
              <div className="flex items-center justify-between">
                <span className="font-mono text-xs font-bold text-fog-300">SCORE</span>
                <span className={`font-mono text-lg font-bold ${score === 3 ? "text-gold-400" : "text-fog-400"}`}>
                  {score}/3
                </span>
              </div>
            </div>
          </div>
        </Card>
      )}

      {/* CVD chart + depth ladder */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card icon={<IFlow size={15} />} title="CVD (30-MIN ROLLING)" bodyClass="p-2">
          <canvas ref={canvasRef} width={400} height={200} className="w-full rounded bg-ink-900" />
        </Card>

        <Card icon={<IFlow size={15} />} title="DEPTH LADDER (TOP 15)" bodyClass="p-2">
          {state && (
            <div className="grid grid-cols-2 gap-2 font-mono text-[10px]">
              <div>
                <div className="mb-1 text-center text-fog-500">BIDS</div>
                <div className="space-y-0.5">
                  {state.depth.bids.slice(0, 15).map((bid, i) => {
                    const price = parseFloat(bid.price);
                    const qty = parseFloat(bid.qty);
                    const median = state.depth.bids.slice(0, 15).map((b) => parseFloat(b.qty)).sort((a, b) => a - b)[7];
                    const isWall = qty >= median * settings.wallMultiplier;
                    return (
                      <div key={i} className={`flex justify-between px-1 ${isWall ? "bg-bull-500/20 text-bull-300 font-bold" : "text-fog-400"}`}>
                        <span>{price.toFixed(2)}</span>
                        <span>{qty.toFixed(2)}</span>
                      </div>
                    );
                  })}
                </div>
              </div>
              <div>
                <div className="mb-1 text-center text-fog-500">ASKS</div>
                <div className="space-y-0.5">
                  {state.depth.asks.slice(0, 15).map((ask, i) => {
                    const price = parseFloat(ask.price);
                    const qty = parseFloat(ask.qty);
                    const median = state.depth.asks.slice(0, 15).map((a) => parseFloat(a.qty)).sort((a, b) => a - b)[7];
                    const isWall = qty >= median * settings.wallMultiplier;
                    return (
                      <div key={i} className={`flex justify-between px-1 ${isWall ? "bg-bear-500/20 text-bear-300 font-bold" : "text-fog-400"}`}>
                        <span>{price.toFixed(2)}</span>
                        <span>{qty.toFixed(2)}</span>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
