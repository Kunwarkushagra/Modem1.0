import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import type { Bias } from "../lib/types";
import { cls, fmtPct } from "../lib/utils";

/* ---------- icons ---------- */

type IconProps = { size?: number; className?: string; strokeWidth?: number };

function svg(props: IconProps, children: ReactNode) {
  const { size = 18, className, strokeWidth = 1.7 } = props;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
      {children}
    </svg>
  );
}

export const ILogo = (p: IconProps) => svg(p, <><path d="M7 17v-6M7 8v1.5M7 17v2" /><rect x="5" y="9.5" width="4" height="7.5" rx="1.2" fill="currentColor" stroke="none" opacity="0.9" /><path d="M17 13V6.5M17 19.5v-2M17 13v4.5" /><rect x="15" y="4.5" width="4" height="8.5" rx="1.2" fill="currentColor" stroke="none" /></>);
export const IRadar = (p: IconProps) => svg(p, <><circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="4.5" /><path d="M12 12l6-6.5" /><circle cx="15" cy="15.5" r="1" fill="currentColor" stroke="none" /></>);
export const IBook = (p: IconProps) => svg(p, <><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v15.5H6.5A2.5 2.5 0 0 0 4 21z" /><path d="M4 18.5A2.5 2.5 0 0 1 6.5 16H20" /><path d="M9 8h7M9 11.5h5" /></>);
export const IFlask = (p: IconProps) => svg(p, <><path d="M10 3v6L4.6 18.5A2 2 0 0 0 6.4 21h11.2a2 2 0 0 0 1.8-2.5L14 9V3" /><path d="M8.5 3h7" /><path d="M7 15h10" /></>);
export const IShield = (p: IconProps) => svg(p, <><path d="M12 3l7.5 3v5.5c0 4.6-3 8-7.5 9.5-4.5-1.5-7.5-4.9-7.5-9.5V6z" /><path d="M9 12l2.2 2.2L15.5 9.5" /></>);
export const IGear = (p: IconProps) => svg(p, <><circle cx="12" cy="12" r="3.2" /><path d="M12 2.8l1.2 2.6 2.8-.7 1 2.7 2.8.7-.7 2.8 1.9 2.1-1.9 2.1.7 2.8-2.8.7-1 2.7-2.8-.7L12 21.2l-1.2-2.6-2.8.7-1-2.7-2.8-.7.7-2.8L3 12l1.9-2.1-.7-2.8 2.8-.7 1-2.7 2.8.7z" /></>);
export const INews = (p: IconProps) => svg(p, <><rect x="3.5" y="5" width="17" height="15" rx="2" /><path d="M7.5 9.5h6M7.5 13h9M7.5 16.5h9" /><rect x="15" y="8.5" width="3" height="3" rx="0.6" /></>);
export const IBell = (p: IconProps) => svg(p, <><path d="M6 9.8a6 6 0 0 1 12 0c0 4 1.5 5.4 2 6H4c.5-.6 2-2 2-6z" /><path d="M10 19a2.2 2.2 0 0 0 4 0" /></>);
export const IZap = (p: IconProps) => svg(p, <path d="M13 2.5L5 13.5h5.5L11 21.5l8-11h-5.5z" />);
export const ITarget = (p: IconProps) => svg(p, <><circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="5.2" /><circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none" /></>);
export const IUp = (p: IconProps) => svg(p, <><path d="M3.5 17.5l5.5-6 3.5 3.5 7-8" /><path d="M14.5 7h5v5" /></>);
export const IDown = (p: IconProps) => svg(p, <><path d="M3.5 6.5l5.5 6 3.5-3.5 7 8" /><path d="M14.5 17h5v-5" /></>);
export const ICheck = (p: IconProps) => svg(p, <path d="M4.5 12.5l5 5L19.5 7" />);
export const IX = (p: IconProps) => svg(p, <path d="M6 6l12 12M18 6L6 18" />);
export const IExt = (p: IconProps) => svg(p, <><path d="M14 4h6v6" /><path d="M20 4l-9 9" /><path d="M19 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h5" /></>);
export const IRefresh = (p: IconProps) => svg(p, <><path d="M20 12a8 8 0 1 1-2.3-5.6" /><path d="M20 3.5V8h-4.5" /></>);
export const IPlus = (p: IconProps) => svg(p, <path d="M12 5v14M5 12h14" />);
export const IPlay = (p: IconProps) => svg(p, <path d="M7 4.8v14.4L19 12z" />);
export const IWarn = (p: IconProps) => svg(p, <><path d="M12 3.5L22 20H2z" /><path d="M12 10v4.5" /><circle cx="12" cy="17.2" r="0.9" fill="currentColor" stroke="none" /></>);
export const ICandles = (p: IconProps) => svg(p, <><path d="M5 9V5M5 15v3" /><rect x="3.4" y="9" width="3.2" height="6" rx="1" /><path d="M12 7V3.5M12 16.5V20" /><rect x="10.4" y="7" width="3.2" height="9.5" rx="1" /><path d="M19 11V7.5M19 18v-2.5" /><rect x="17.4" y="11" width="3.2" height="4.5" rx="1" /></>);
export const ILayers = (p: IconProps) => svg(p, <><path d="M12 3l9 5-9 5-9-5z" /><path d="M3.5 12.5L12 17l8.5-4.5" /><path d="M3.5 16.5L12 21l8.5-4.5" /></>);
export const IClock = (p: IconProps) => svg(p, <><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></>);
export const IBrain = (p: IconProps) => svg(p, <><path d="M9.5 4A2.8 2.8 0 0 0 6 6.7 3.2 3.2 0 0 0 4 12a3.3 3.3 0 0 0 1.5 5.6A3 3 0 0 0 9 20.5c1 0 1.8-.4 2.4-1V5.4A2.7 2.7 0 0 0 9.5 4z" /><path d="M14.5 4A2.8 2.8 0 0 1 18 6.7 3.2 3.2 0 0 1 20 12a3.3 3.3 0 0 1-1.5 5.6 3 3 0 0 1-3.5 2.9c-1 0-1.8-.4-2.4-1V5.4A2.7 2.7 0 0 1 14.5 4z" /></>);
export const IScale = (p: IconProps) => svg(p, <><path d="M12 4v16M8 20h8M12 4l-6 3M12 4l6 3" /><path d="M6 7l-2.6 5.2a3 3 0 0 0 5.2 0z" /><path d="M18 7l-2.6 5.2a3 3 0 0 0 5.2 0z" /></>);

/* ---------- primitives ---------- */

export function Card(props: { title?: ReactNode; icon?: ReactNode; right?: ReactNode; children: ReactNode; className?: string; bodyClass?: string; tone?: "default" | "gold" }) {
  return (
    <section className={cls("tv-panel tv-panel-hover overflow-hidden", props.className)}>
      {props.title != null && (
        <header className="flex items-center justify-between gap-3 px-4 pt-3.5 pb-2.5 border-b border-ink-600/70">
          <h3 className="flex items-center gap-2 font-display text-[13px] font-bold tracking-[0.14em] uppercase text-fog-200">
            <span className="text-gold-500">{props.icon}</span>
            {props.title}
          </h3>
          {props.right}
        </header>
      )}
      <div className={cls("p-4", props.bodyClass)}>{props.children}</div>
    </section>
  );
}

type BtnVariant = "primary" | "ghost" | "outline" | "danger" | "success" | "dark";
export function Btn(props: {
  children: ReactNode; onClick?: () => void; variant?: BtnVariant; size?: "xs" | "sm" | "md";
  disabled?: boolean; className?: string; title?: string;
}) {
  const v = props.variant ?? "outline";
  const base = "tv-btn inline-flex items-center justify-center gap-1.5 font-semibold rounded-md whitespace-nowrap";
  const size = props.size === "xs" ? "text-[11px] px-2 py-1" : props.size === "sm" ? "text-xs px-2.5 py-1.5" : "text-sm px-4 py-2";
  const variant: Record<BtnVariant, string> = {
    primary: "bg-gold-500 text-ink-950 hover:bg-gold-400 shadow-[0_4px_18px_-6px_rgba(245,184,64,0.55)]",
    ghost: "text-fog-300 hover:text-fog-100 hover:bg-ink-700",
    outline: "border border-ink-500 text-fog-200 hover:border-gold-600/60 hover:text-gold-300 bg-ink-800/40",
    danger: "border border-bear-600/50 text-bear-300 hover:bg-bear-600/15",
    success: "border border-bull-600/50 text-bull-300 hover:bg-bull-600/15",
    dark: "bg-ink-700 text-fog-200 hover:bg-ink-600 border border-ink-600",
  };
  return (
    <button type="button" title={props.title} disabled={props.disabled} onClick={props.onClick}
      className={cls(base, size, variant[v], props.className)}>
      {props.children}
    </button>
  );
}

export function Badge(props: { children: ReactNode; tone?: "gold" | "bull" | "bear" | "info" | "dim" | "warn"; className?: string }) {
  const t = props.tone ?? "dim";
  const map = {
    gold: "bg-gold-500/12 text-gold-300 border-gold-600/40",
    bull: "bg-bull-500/12 text-bull-300 border-bull-600/40",
    bear: "bg-bear-500/12 text-bear-300 border-bear-600/40",
    info: "bg-info-500/12 text-info-400 border-info-500/40",
    warn: "bg-gold-500/15 text-gold-300 border-gold-600/50",
    dim: "bg-ink-700/70 text-fog-300 border-ink-500",
  };
  return <span className={cls("inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10.5px] font-mono font-medium tracking-wide", map[t], props.className)}>{props.children}</span>;
}

export function BiasPill(props: { bias: Bias; label: string }) {
  const tone = props.bias === "bullish" ? "bull" : props.bias === "bearish" ? "bear" : "dim";
  return (
    <div className="flex items-center justify-between rounded-md border border-ink-600 bg-ink-800/60 px-2.5 py-1.5">
      <span className="text-[10.5px] font-mono tracking-widest text-fog-400">{props.label}</span>
      <Badge tone={tone as "bull" | "bear" | "dim"}>{props.bias === "bullish" ? <IUp size={11} /> : props.bias === "bearish" ? <IDown size={11} /> : null}{props.bias.toUpperCase()}</Badge>
    </div>
  );
}

export function Stat(props: { label: string; value: ReactNode; sub?: ReactNode; tone?: "bull" | "bear" | "gold" | "dim" }) {
  const tone = props.tone === "bull" ? "text-bull-400" : props.tone === "bear" ? "text-bear-400" : props.tone === "gold" ? "text-gold-400" : "text-fog-100";
  return (
    <div className="rounded-md border border-ink-600/80 bg-ink-800/50 px-3 py-2.5">
      <div className="text-[10px] font-mono uppercase tracking-[0.16em] text-fog-400">{props.label}</div>
      <div className={cls("mt-1 font-mono text-lg font-semibold leading-none", tone)}>{props.value}</div>
      {props.sub && <div className="mt-1 text-[11px] text-fog-400">{props.sub}</div>}
    </div>
  );
}

export function Segmented<T extends string>(props: { options: Array<{ v: T; label: ReactNode }>; value: T; onChange: (v: T) => void; size?: "sm" | "md" }) {
  return (
    <div className="inline-flex rounded-md border border-ink-500 bg-ink-900/80 p-0.5">
      {props.options.map((o) => (
        <button key={o.v} type="button" onClick={() => props.onChange(o.v)}
          className={cls(
            "tv-btn rounded-[5px] font-mono font-semibold transition-colors",
            props.size === "sm" ? "px-2 py-1 text-[11px]" : "px-3 py-1.5 text-xs",
            props.value === o.v ? "bg-gold-500 text-ink-950 shadow" : "text-fog-300 hover:text-fog-100",
          )}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Modal(props: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    if (!props.open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") props.onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [props.open, props.onClose]);
  if (!props.open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="dialog" aria-modal>
      <div className="absolute inset-0 bg-ink-950/80 backdrop-blur-[2px]" onClick={props.onClose} />
      <div className={cls("tv-pop tv-panel relative max-h-[88vh] w-full overflow-y-auto", props.wide ? "max-w-3xl" : "max-w-lg")}>
        <header className="sticky top-0 z-10 flex items-center justify-between border-b border-ink-600 bg-ink-800/95 px-4 py-3">
          <h3 className="font-display text-sm font-bold uppercase tracking-[0.12em] text-fog-100">{props.title}</h3>
          <Btn variant="ghost" size="sm" onClick={props.onClose}><IX size={15} /></Btn>
        </header>
        <div className="p-4">{props.children}</div>
      </div>
    </div>
  );
}

/* ---------- toasts ---------- */

export interface Toast { id: string; kind: "ok" | "warn" | "err" | "info"; msg: string }
const ToastCtx = createContext<{ push: (kind: Toast["kind"], msg: string) => void }>({ push: () => undefined });
export const useToast = () => useContext(ToastCtx);

export function ToastProvider(props: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((kind: Toast["kind"], msg: string) => {
    const id = Math.random().toString(36).slice(2);
    setToasts((t) => [...t.slice(-3), { id, kind, msg }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4600);
  }, []);
  const value = useMemo(() => ({ push }), [push]);
  const icon = { ok: <ICheck size={14} />, warn: <IWarn size={14} />, err: <IX size={14} />, info: <IZap size={14} /> };
  const tone = { ok: "border-bull-600/60 text-bull-300", warn: "border-gold-600/60 text-gold-300", err: "border-bear-600/60 text-bear-300", info: "border-info-500/60 text-info-400" };
  return (
    <ToastCtx.Provider value={value}>
      {props.children}
      <div className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-[min(92vw,380px)] flex-col gap-2">
        {toasts.map((t) => (
          <div key={t.id} className={cls("tv-pop pointer-events-auto flex items-start gap-2 rounded-md border bg-ink-800/95 px-3 py-2.5 text-xs shadow-xl backdrop-blur", tone[t.kind])}>
            <span className="mt-0.5 shrink-0">{icon[t.kind]}</span>
            <span className="font-medium text-fog-100">{t.msg}</span>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

/* ---------- charts ---------- */

export function SparkLine(props: { values: number[]; width?: number; height?: number; baseline?: number }) {
  const { values, width = 120, height = 36, baseline } = props;
  if (values.length < 2) return <div className="h-9" />;
  const min = Math.min(...values), max = Math.max(...values);
  const span = max - min || 1;
  const pts = values.map((v, i) => `${((i / (values.length - 1)) * width).toFixed(1)},${(height - 3 - ((v - min) / span) * (height - 6)).toFixed(1)}`);
  const up = values[values.length - 1] >= values[0];
  const color = up ? "var(--color-bull-500)" : "var(--color-bear-500)";
  const base = baseline != null ? height - 3 - ((baseline - min) / span) * (height - 6) : null;
  return (
    <svg width={width} height={height} className="block">
      {base != null && base >= 0 && base <= height && <line x1="0" x2={width} y1={base} y2={base} stroke="var(--color-ink-500)" strokeDasharray="3 3" strokeWidth="1" />}
      <polyline points={pts.join(" ")} fill="none" stroke={color} strokeWidth="1.8" strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={pts[pts.length - 1].split(",")[0]} cy={pts[pts.length - 1].split(",")[1]} r="2.4" fill={color} />
    </svg>
  );
}

export function Meter(props: { position: number; labels?: [string, string, string] }) {
  const pct = Math.max(0, Math.min(100, props.position * 100));
  return (
    <div>
      <div className="relative h-2.5 rounded-full bg-ink-700 overflow-hidden">
        <div className="absolute inset-y-0 left-0 bg-bull-600/50" style={{ width: "29.5%" }} />
        <div className="absolute inset-y-0 left-[29.5%] bg-ink-500/60" style={{ width: "41%" }} />
        <div className="absolute inset-y-0 left-[70.5%] bg-bear-600/50" style={{ width: "29.5%" }} />
        <div className="absolute top-[-2px] h-[14px] w-[3px] rounded-full bg-gold-400 shadow-[0_0_8px_rgba(245,184,64,0.8)] transition-all duration-700" style={{ left: `calc(${pct}% - 1px)` }} />
      </div>
      {props.labels && (
        <div className="mt-1 flex justify-between font-mono text-[9.5px] tracking-widest text-fog-400">
          <span className="text-bull-400">{props.labels[0]}</span><span>{props.labels[1]}</span><span className="text-bear-400">{props.labels[2]}</span>
        </div>
      )}
    </div>
  );
}

export function ProgressBar(props: { pct: number }) {
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-ink-700">
      <div className="h-full rounded-full bg-gold-500 transition-all duration-300" style={{ width: `${Math.min(100, props.pct)}%` }} />
    </div>
  );
}

export function PctCell(props: { v: number | null }) {
  if (props.v == null || !isFinite(props.v)) return <span className="text-fog-500">—</span>;
  return <span className={props.v > 0 ? "text-bull-400" : props.v < 0 ? "text-bear-400" : "text-fog-300"}>{fmtPct(props.v)}</span>;
}
