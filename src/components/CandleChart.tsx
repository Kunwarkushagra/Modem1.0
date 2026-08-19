import { useEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as RPointerEvent, RefObject } from "react";
import type { AssetType, Candle, IndicatorSet, SMCAnalysis, TradeSetup } from "../lib/types";
import { fmtPrice, fmtTime, cls } from "../lib/utils";

const C = {
  bull: "#31d48f", bear: "#f5566b", grid: "rgba(154,168,191,0.09)",
  ema50: "#f5b840", ema200: "#56b8d8", text: "#8a97ad",
};

function useWidth<T extends HTMLElement>(): [RefObject<T>, number] {
  const ref = useRef<T>(null);
  const [w, setW] = useState(900);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver((es) => setW(Math.max(320, es[0].contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

const ZONE_STYLE: Record<string, { fill: string; stroke: string; label: string }> = {
  bull_ob: { fill: "rgba(49,212,143,0.10)", stroke: "rgba(49,212,143,0.45)", label: "OB+" },
  bear_ob: { fill: "rgba(245,86,107,0.10)", stroke: "rgba(245,86,107,0.45)", label: "OB−" },
  breaker_bull: { fill: "rgba(49,212,143,0.16)", stroke: "rgba(49,212,143,0.7)", label: "BRK+" },
  breaker_bear: { fill: "rgba(245,86,107,0.16)", stroke: "rgba(245,86,107,0.7)", label: "BRK−" },
  bull_fvg: { fill: "rgba(86,184,216,0.10)", stroke: "rgba(86,184,216,0.4)", label: "FVG" },
  bear_fvg: { fill: "rgba(124,199,222,0.10)", stroke: "rgba(124,199,222,0.4)", label: "FVG" },
  imbalance: { fill: "rgba(245,184,64,0.12)", stroke: "rgba(245,184,64,0.45)", label: "IMB" },
  sl_hunt: { fill: "rgba(245,184,64,0.06)", stroke: "rgba(245,184,64,0.28)", label: "SL$" },
};

export function CandleChart(props: {
  candles: Candle[];
  ind: IndicatorSet;
  smc: SMCAnalysis;
  asset: AssetType;
  timeframe?: string;
  setup?: TradeSetup | null;
  height?: number;
  showZones?: boolean;
}) {
  const { candles, ind, smc, asset, setup } = props;
  const height = props.height ?? 440;
  const [wrapRef, width] = useWidth<HTMLDivElement>();
  const n = candles.length;
  const [view, setView] = useState({ s: Math.max(0, n - 130), e: n });
  const [hover, setHover] = useState<{ x: number; y: number; i: number } | null>(null);
  const dragRef = useRef<{ x: number; s: number; e: number } | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  useEffect(() => { setView({ s: Math.max(0, n - 130), e: n }); }, [n]);

  const padL = 8, padR = 64, padT = 12, padB = 22;
  const plotW = Math.max(80, width - padL - padR);
  const plotH = height - padT - padB;
  const { s, e } = view;
  const span = Math.max(2, e - s);

  const [minP, maxP] = useMemo(() => {
    let lo = Infinity, hi = -Infinity;
    for (let i = Math.max(0, s); i < Math.min(n, e); i++) { lo = Math.min(lo, candles[i].l); hi = Math.max(hi, candles[i].h); }
    if (setup) {
      lo = Math.min(lo, setup.stop_loss, setup.take_profit2);
      hi = Math.max(hi, setup.stop_loss, setup.take_profit2);
    }
    for (const z of smc.zones) {
      if (z.startI >= s - 40 && z.top > lo && z.bottom < hi) { lo = Math.min(lo, z.bottom); hi = Math.max(hi, z.top); }
    }
    const pad = (hi - lo) * 0.06 || 1;
    return [lo - pad, hi + pad];
  }, [candles, s, e, n, setup, smc.zones]);

  const x = (i: number) => padL + ((i - s) / span) * plotW;
  const y = (p: number) => padT + (1 - (p - minP) / (maxP - minP)) * plotH;
  const cw = Math.max(1.4, (plotW / span) * 0.66);

  const idxFromClientX = (clientX: number) => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return s;
    const px = clientX - rect.left;
    return Math.round(s + ((px - padL) / plotW) * span);
  };

  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const onWheel = (ev: WheelEvent) => {
      ev.preventDefault();
      const center = idxFromClientX(ev.clientX);
      setView((v) => {
        const cur = v.e - v.s;
        const next = Math.max(25, Math.min(n, Math.round(cur * (ev.deltaY > 0 ? 1.18 : 0.85))));
        const ratio = (center - v.s) / cur;
        let ns = Math.round(center - ratio * next);
        ns = Math.max(0, Math.min(n - next, ns));
        return { s: ns, e: ns + next };
      });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  });

  const onPointerDown = (ev: RPointerEvent) => {
    dragRef.current = { x: ev.clientX, s, e };
    (ev.target as Element).setPointerCapture?.(ev.pointerId);
  };
  const onPointerMove = (ev: RPointerEvent) => {
    const i = Math.max(s, Math.min(e - 1, idxFromClientX(ev.clientX)));
    const rect = svgRef.current?.getBoundingClientRect();
    setHover(rect ? { x: ev.clientX - rect.left, y: ev.clientY - rect.top, i } : null);
    if (dragRef.current) {
      const d = dragRef.current;
      const dIdx = Math.round(((d.x - ev.clientX) / plotW) * (d.e - d.s));
      const ns = Math.max(0, Math.min(n - (d.e - d.s), d.s + dIdx));
      setView({ s: ns, e: ns + (d.e - d.s) });
    }
  };
  const endDrag = () => { dragRef.current = null; };

  const gridLines = useMemo(() => {
    const rows: number[] = [];
    for (let g = 0; g <= 5; g++) rows.push(minP + ((maxP - minP) * g) / 5);
    return rows;
  }, [minP, maxP]);

  const emaPts = (arr: number[]) => {
    const pts: string[] = [];
    for (let i = Math.max(0, s); i < Math.min(n, e); i++) {
      if (isFinite(arr[i])) pts.push(`${x(i).toFixed(1)},${y(arr[i]).toFixed(1)}`);
    }
    return pts.join(" ");
  };

  const zones = props.showZones === false ? [] : smc.zones.filter((z) => z.active || z.kind.startsWith("breaker")).slice(-16);
  const lastC = candles[n - 1];
  const hoverC = hover ? candles[Math.min(hover.i, n - 1)] : null;

  return (
    <div ref={wrapRef} className="relative w-full select-none" style={{ height }}>
      <svg
        ref={svgRef} width={width} height={height} className="block cursor-crosshair"
        onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={endDrag} onPointerLeave={() => { setHover(null); endDrag(); }}
      >
        {/* grid + axis */}
        {gridLines.map((p, gi) => (
          <g key={gi}>
            <line x1={padL} x2={padL + plotW} y1={y(p)} y2={y(p)} stroke={C.grid} strokeWidth="1" />
            <text x={padL + plotW + 6} y={y(p) + 3} fontSize="9.5" fill={C.text} fontFamily="JetBrains Mono, monospace">{fmtPrice(p, asset)}</text>
          </g>
        ))}
        {[0, 0.25, 0.5, 0.75, 1].map((f, ti) => {
          const i = Math.round(s + span * f);
          const c2 = candles[Math.min(i, n - 1)];
          if (!c2) return null;
          return <text key={ti} x={x(i)} y={height - 7} fontSize="9" textAnchor="middle" fill={C.text} fontFamily="JetBrains Mono, monospace">{fmtTime(c2.t, props.timeframe as never)}</text>;
        })}

        {/* premium/discount shading */}
        <rect x={padL} y={y(smc.pd.rangeHigh)} width={plotW} height={Math.max(0, y(smc.pd.premium[0]) - y(smc.pd.rangeHigh))} fill="rgba(245,86,107,0.035)" />
        <rect x={padL} y={y(smc.pd.discount[1])} width={plotW} height={Math.max(0, y(smc.pd.rangeLow) - y(smc.pd.discount[1]))} fill="rgba(49,212,143,0.035)" />
        <line x1={padL} x2={padL + plotW} y1={y(smc.pd.eq)} y2={y(smc.pd.eq)} stroke="rgba(233,238,247,0.14)" strokeDasharray="2 5" />
        <text x={padL + 4} y={y(smc.pd.eq) - 3} fontSize="8.5" fill="rgba(233,238,247,0.4)" fontFamily="JetBrains Mono, monospace">EQ</text>

        {/* zones */}
        {zones.map((z, zi) => {
          const st = ZONE_STYLE[z.kind] ?? ZONE_STYLE.bull_fvg;
          const x1 = x(Math.max(z.startI, s));
          return (
            <g key={zi}>
              <rect x={x1} y={y(z.top)} width={Math.max(2, padL + plotW - x1)} height={Math.max(1.5, y(z.bottom) - y(z.top))} fill={st.fill} stroke={st.stroke} strokeWidth="0.8" />
              <text x={x1 + 3} y={y(z.top) + 9} fontSize="8" fill={st.stroke} fontFamily="JetBrains Mono, monospace">{st.label}</text>
            </g>
          );
        })}

        {/* SL hunt zones */}
        {smc.slHuntZones.slice(0, 4).map((z, zi) => {
          const st = ZONE_STYLE.sl_hunt;
          const x1 = x(Math.max(z.startI, s));
          return <rect key={"h" + zi} x={x1} y={y(z.top)} width={Math.max(2, padL + plotW - x1)} height={Math.max(1, y(z.bottom) - y(z.top))} fill={st.fill} stroke={st.stroke} strokeWidth="0.6" strokeDasharray="4 3" />;
        })}

        {/* liquidity pools */}
        {smc.liquidity.filter((p) => p.touches >= 2).slice(0, 6).map((p, pi) => {
          const col = p.side === "buy" ? "rgba(245,86,107,0.65)" : "rgba(49,212,143,0.65)";
          const x1 = x(Math.max(p.formedI, s));
          return (
            <g key={"lq" + pi}>
              <line x1={x1} x2={padL + plotW} y1={y(p.price)} y2={y(p.price)} stroke={col} strokeWidth="1" strokeDasharray="7 4" />
              <text x={x1 + 3} y={y(p.price) - 3} fontSize="8" fill={col} fontFamily="JetBrains Mono, monospace">{p.side === "buy" ? "BSL" : "SSL"} ×{p.touches}</text>
            </g>
          );
        })}

        {/* S/R */}
        {smc.sr.slice(0, 5).map((lv, li) => (
          <g key={"sr" + li}>
            <line x1={padL} x2={padL + plotW} y1={y(lv.price)} y2={y(lv.price)} stroke="rgba(154,168,191,0.22)" strokeWidth="1" strokeDasharray="1 4" />
            <text x={padL + plotW - 4} y={y(lv.price) - 3} fontSize="8" textAnchor="end" fill="rgba(154,168,191,0.55)" fontFamily="JetBrains Mono, monospace">{lv.kind === "support" ? "S" : "R"}{lv.touches}</text>
          </g>
        ))}

        {/* structure events */}
        {smc.structure.slice(-6).filter((ev) => ev.i >= s && ev.i < e).map((ev, ei) => (
          <g key={"st" + ei}>
            <line x1={x(ev.i) - 34} x2={x(ev.i)} y1={y(ev.level)} y2={y(ev.level)} stroke={ev.dir === "bull" ? C.bull : C.bear} strokeWidth="1.1" />
            <text x={x(ev.i) - 36} y={y(ev.level) + 3} fontSize="8.5" textAnchor="end" fill={ev.dir === "bull" ? C.bull : C.bear} fontFamily="JetBrains Mono, monospace" fontWeight="700">{ev.type}</text>
          </g>
        ))}

        {/* sweeps */}
        {smc.sweeps.filter((sw) => sw.i >= s && sw.i < e).map((sw, si) => (
          <g key={"sw" + si}>
            <path d={`M ${x(sw.i)} ${y(sw.price) - 7} l 5 7 l -5 7 l -5 -7 Z`} fill="none" stroke="#f5b840" strokeWidth="1.3" />
            <text x={x(sw.i)} y={y(sw.price) - 10} fontSize="7.5" textAnchor="middle" fill="#f5b840" fontFamily="JetBrains Mono, monospace">$</text>
          </g>
        ))}

        {/* candles */}
        {candles.map((c, i) => {
          if (i < s || i >= e) return null;
          const up = c.c >= c.o;
          const col = up ? C.bull : C.bear;
          const cx = x(i);
          const bodyTop = y(Math.max(c.o, c.c));
          const bodyH = Math.max(1, Math.abs(y(c.o) - y(c.c)));
          return (
            <g key={i}>
              <line x1={cx} x2={cx} y1={y(c.h)} y2={y(c.l)} stroke={col} strokeWidth="1" />
              <rect x={cx - cw / 2} y={bodyTop} width={cw} height={bodyH} fill={col} rx={cw > 4 ? 1 : 0} opacity={hover?.i === i ? 1 : 0.92} />
            </g>
          );
        })}

        {/* EMAs */}
        <polyline points={emaPts(ind.ema50)} fill="none" stroke={C.ema50} strokeWidth="1.3" opacity="0.85" />
        <polyline points={emaPts(ind.ema200)} fill="none" stroke={C.ema200} strokeWidth="1.3" opacity="0.8" />

        {/* trendlines */}
        {smc.trendlines.map((tl, ti) => (
          <line key={"tl" + ti} x1={x(Math.max(tl.x1, s))} y1={y(tl.y1 + (tl.y2 - tl.y1) * ((Math.max(tl.x1, s) - tl.x1) / Math.max(1, tl.x2 - tl.x1)))} x2={x(Math.min(tl.x2, e - 1))} y2={y(tl.y2)} stroke={tl.kind === "support" ? "rgba(49,212,143,0.4)" : "rgba(245,86,107,0.4)"} strokeWidth="1" strokeDasharray="5 4" />
        ))}

        {/* setup overlay */}
        {setup && (() => {
          const long = setup.direction === "Long";
          const slY = y(setup.stop_loss), enY = y(setup.entry_price), t1 = y(setup.take_profit1), t2 = y(setup.take_profit2);
          return (
            <g>
              <rect x={padL} y={Math.min(enY, slY)} width={plotW} height={Math.abs(slY - enY)} fill="rgba(245,86,107,0.07)" />
              <rect x={padL} y={Math.min(enY, t2)} width={plotW} height={Math.abs(t2 - enY)} fill="rgba(49,212,143,0.06)" />
              <line x1={padL} x2={padL + plotW} y1={enY} y2={enY} stroke="#f5b840" strokeWidth="1.4" />
              <line x1={padL} x2={padL + plotW} y1={slY} y2={slY} stroke={C.bear} strokeWidth="1.2" strokeDasharray="6 4" />
              <line x1={padL} x2={padL + plotW} y1={t1} y2={t1} stroke={C.bull} strokeWidth="1.2" strokeDasharray="6 4" />
              <line x1={padL} x2={padL + plotW} y1={t2} y2={t2} stroke={C.bull} strokeWidth="1" strokeDasharray="2 5" />
              <text x={padL + 5} y={enY - 4} fontSize="9" fill="#f5b840" fontFamily="JetBrains Mono, monospace" fontWeight="700">ENTRY {fmtPrice(setup.entry_price, asset)}</text>
              <text x={padL + 5} y={slY + (long ? 11 : -4)} fontSize="9" fill={C.bear} fontFamily="JetBrains Mono, monospace" fontWeight="700">SL {fmtPrice(setup.stop_loss, asset)}</text>
              <text x={padL + 5} y={t1 + (long ? -4 : 11)} fontSize="9" fill={C.bull} fontFamily="JetBrains Mono, monospace" fontWeight="700">TP1 · RR {setup.risk_reward_ratio}</text>
            </g>
          );
        })()}

        {/* last price */}
        {lastC && (
          <g>
            <line x1={padL} x2={padL + plotW} y1={y(lastC.c)} y2={y(lastC.c)} stroke={lastC.c >= lastC.o ? "rgba(49,212,143,0.5)" : "rgba(245,86,107,0.5)"} strokeWidth="1" strokeDasharray="2 3" />
            <rect x={padL + plotW + 2} y={y(lastC.c) - 8} width={padR - 4} height={16} rx="3" fill={lastC.c >= lastC.o ? C.bull : C.bear} />
            <text x={padL + plotW + 5} y={y(lastC.c) + 3.5} fontSize="9.5" fill="#05080d" fontWeight="700" fontFamily="JetBrains Mono, monospace">{fmtPrice(lastC.c, asset)}</text>
          </g>
        )}

        {/* crosshair */}
        {hover && hoverC && (
          <g>
            <line x1={x(hover.i)} x2={x(hover.i)} y1={padT} y2={padT + plotH} stroke="rgba(233,238,247,0.2)" strokeWidth="1" />
            <line x1={padL} x2={padL + plotW} y1={hover.y} y2={hover.y} stroke="rgba(233,238,247,0.2)" strokeWidth="1" />
          </g>
        )}
      </svg>

      {/* tooltip */}
      {hover && hoverC && (
        <div className="pointer-events-none absolute z-10 rounded-md border border-ink-500 bg-ink-900/95 px-2.5 py-2 font-mono text-[10.5px] leading-relaxed shadow-xl backdrop-blur"
          style={{ left: Math.min(hover.x + 14, width - 170), top: Math.max(4, hover.y - 84) }}>
          <div className="mb-0.5 font-semibold text-fog-200">{fmtTime(hoverC.t, props.timeframe as never)}</div>
          <div className="grid grid-cols-2 gap-x-3 text-fog-400">
            <span>O <span className="text-fog-100">{fmtPrice(hoverC.o, asset)}</span></span>
            <span>H <span className="text-bull-400">{fmtPrice(hoverC.h, asset)}</span></span>
            <span>L <span className="text-bear-400">{fmtPrice(hoverC.l, asset)}</span></span>
            <span>C <span className={cls(hoverC.c >= hoverC.o ? "text-bull-400" : "text-bear-400")}>{fmtPrice(hoverC.c, asset)}</span></span>
            <span className="col-span-2">V <span className="text-fog-100">{hoverC.v >= 1e6 ? (hoverC.v / 1e6).toFixed(2) + "M" : hoverC.v.toLocaleString()}</span></span>
          </div>
        </div>
      )}

      {/* legend */}
      <div className="pointer-events-none absolute left-2 top-1.5 flex items-center gap-3 font-mono text-[9px] tracking-wider text-fog-400">
        <span className="flex items-center gap-1"><i className="inline-block h-[2px] w-4" style={{ background: C.ema50 }} />EMA50</span>
        <span className="flex items-center gap-1"><i className="inline-block h-[2px] w-4" style={{ background: C.ema200 }} />EMA200</span>
        <span className="flex items-center gap-1"><i className="inline-block h-2 w-3 rounded-[2px]" style={{ background: "rgba(49,212,143,0.25)", border: "1px solid rgba(49,212,143,0.5)" }} />OB</span>
        <span className="flex items-center gap-1"><i className="inline-block h-2 w-3 rounded-[2px]" style={{ background: "rgba(86,184,216,0.25)", border: "1px solid rgba(86,184,216,0.5)" }} />FVG</span>
        <span className="flex items-center gap-1"><i className="inline-block h-[2px] w-4" style={{ background: "rgba(245,86,107,0.65)" }} />BSL</span>
        <span className="flex items-center gap-1"><i className="inline-block h-[2px] w-4" style={{ background: "rgba(49,212,143,0.65)" }} />SSL</span>
      </div>
    </div>
  );
}
