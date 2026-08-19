import type { ConfluenceStat, PerformanceSummary, Trade } from "./types";

export function computePerformance(trades: Trade[]): PerformanceSummary {
  const closed = trades.filter((t) => t.status === "closed" && t.outcome);
  const wins = closed.filter((t) => t.outcome === "win");
  const losses = closed.filter((t) => t.outcome === "loss");
  const breakeven = closed.filter((t) => t.outcome === "breakeven");

  const winRate = closed.length ? (wins.length / closed.length) * 100 : 0;
  const avgWinPct = wins.length ? wins.reduce((s, t) => s + (t.pnlPct ?? 0), 0) / wins.length : 0;
  const avgLossPct = losses.length ? losses.reduce((s, t) => s + (t.pnlPct ?? 0), 0) / losses.length : 0;
  const grossWin = wins.reduce((s, t) => s + Math.max(0, t.pnlPct ?? 0), 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + Math.min(0, t.pnlPct ?? 0), 0));
  const profitFactor = grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? 99 : 0;

  const rets = closed.map((t) => t.pnlPct ?? 0);
  const mean = rets.length ? rets.reduce((a, b) => a + b, 0) / rets.length : 0;
  const sd = rets.length > 1 ? Math.sqrt(rets.reduce((s, r) => s + (r - mean) ** 2, 0) / (rets.length - 1)) : 0;
  const sharpe = sd > 0 ? mean / sd : 0;

  // equity curve compounded from pnl%
  const equity: number[] = [100];
  for (const t of [...closed].reverse()) equity.push(equity[equity.length - 1] * (1 + (t.pnlPct ?? 0) / 100));
  let peak = equity[0], maxDD = 0;
  for (const e of equity) { peak = Math.max(peak, e); maxDD = Math.max(maxDD, ((peak - e) / peak) * 100); }

  // confluence mining
  const byConf = new Map<string, { trades: number; wins: number; rr: number }>();
  for (const t of closed) {
    for (const c of t.confluences) {
      const e = byConf.get(c) ?? { trades: 0, wins: 0, rr: 0 };
      e.trades++; if (t.outcome === "win") e.wins++; e.rr += t.rr;
      byConf.set(c, e);
    }
  }
  const stats: ConfluenceStat[] = Array.from(byConf.entries())
    .filter(([, v]) => v.trades >= 2)
    .map(([confluence, v]) => ({
      confluence, trades: v.trades, wins: v.wins,
      winRate: (v.wins / v.trades) * 100, avgRR: v.rr / v.trades,
    }))
    .sort((a, b) => b.winRate - a.winRate);

  const recentTrades = closed.slice(0, 10);
  const recentWins = recentTrades.filter((t) => t.outcome === "win").length;
  const recentWinRate = recentTrades.length ? (recentWins / recentTrades.length) * 100 : 0;
  const tilt = recentTrades.length >= 5 && recentWinRate < 30;

  return {
    total: closed.length,
    wins: wins.length,
    losses: losses.length,
    breakeven: breakeven.length,
    winRate, avgWinPct, avgLossPct, profitFactor, sharpe,
    maxDrawdown: maxDD,
    bestConfluences: stats.slice(0, 4),
    worstConfluences: [...stats].sort((a, b) => a.winRate - b.winRate).slice(0, 4),
    recent: { trades: recentTrades.length, winRate: recentWinRate, tilt },
    equity,
  };
}

export function performancePromptBlock(p: PerformanceSummary): string {
  if (p.total === 0) {
    return "PAST PERFORMANCE AND LESSONS LEARNED:\nNo closed trades yet. Treat this as a fresh account: apply standard strict criteria, no historical adaptation available.";
  }
  const lines: string[] = ["PAST PERFORMANCE AND LESSONS LEARNED:"];
  lines.push(`- Closed trades: ${p.total} | Wins: ${p.wins} | Losses: ${p.losses} | Breakeven: ${p.breakeven} | Win rate: ${p.winRate.toFixed(1)}%`);
  lines.push(`- Average win: +${p.avgWinPct.toFixed(2)}% | Average loss: ${p.avgLossPct.toFixed(2)}% | Profit factor: ${p.profitFactor.toFixed(2)} | Sharpe (per-trade): ${p.sharpe.toFixed(2)} | Max drawdown: ${p.maxDrawdown.toFixed(1)}%`);
  if (p.bestConfluences.length)
    lines.push(`- Best confluences: ${p.bestConfluences.map((c) => `"${c.confluence}" ${c.winRate.toFixed(0)}% WR over ${c.trades} trades`).join("; ")}`);
  if (p.worstConfluences.length)
    lines.push(`- Worst confluences: ${p.worstConfluences.map((c) => `"${c.confluence}" ${c.winRate.toFixed(0)}% WR over ${c.trades} trades`).join("; ")}`);
  lines.push(`- Last ${p.recent.trades} trades win rate: ${p.recent.winRate.toFixed(0)}%${p.recent.tilt ? " — TILT DETECTED: be noticeably more conservative, raise confidence threshold, prefer only A+ confluence stacks." : p.recent.trades >= 5 && p.recent.winRate >= 60 ? " — hot streak: you may be slightly less conservative, but keep strict filters." : ""}`);
  lines.push("- Adapt: favor historically winning confluences, avoid losing ones, and calibrate confidence from these actual results.");
  return lines.join("\n");
}
