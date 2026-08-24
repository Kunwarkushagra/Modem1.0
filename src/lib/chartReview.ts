import type { AssetType, Candle, ChartAgreement, ChartRefinement, ChartReviewPayload, ChartReviewResult, RadarCandidate } from "./types";
import { fetchCandles } from "./marketData";
import { analyzeSMC } from "./smc";
import { getChartReview, putChartReview } from "./cache";
import { HTF_MAP } from "./utils";
import { COSTS } from "./backtest";

/**
 * AI CHART REVIEW — additive, display-only OPINION layer.
 *
 * Renders two small client-side candlestick snapshots (confirmed candles only), overlays the
 * engine's own levels (entry/SL/TP, invalidation, OB/FVG boxes, sweep markers, price axis,
 * last-price line), and asks Gemini Flash whether the picture agrees with the signal.
 *
 * It NEVER touches trade generation, confluence scoring, validators, validity, reasoning, or
 * the backtest engine — it only consumes the candidate and freshly fetched confirmed candles.
 * Smoke-test trade counts are therefore unchanged by construction.
 *
 * Transport order (mirrors AI Insight):
 *  1. POST /api/ai-insight with mode:"chartReview" (server route; env key, never in the browser).
 *  2. Direct Gemini multimodal call with the locally stored key (static-build fallback).
 *  3. If the image payload is too large or the call fails → text-only fallback (last 20
 *     confirmed candles + engine levels), flagged with a "TEXT-ONLY ANALYSIS" badge.
 */

export const CHART_DISCLAIMER = "Opinion only — not an order. Final decision and risk are the trader's.";

export const CHART_INSTRUCTION = `You are reviewing two candlestick chart snapshots (setup timeframe and higher timeframe) plus a compact structured signal payload. Analyze the provided chart snapshots ONLY. Do NOT invent levels, patterns, or prices that are not visible. If a level is visible, state its approximate price read from the axis. Judge whether the visible structure supports the signal direction.
If you cannot form an opinion, return {"structureCheck":"INSUFFICIENT CONTEXT","refineEntry":null,"refineInvalidation":null,"agreement":"NEUTRAL","confidence":0,"risks":[],"disclaimer":""}.
Respond with ONLY this JSON object, no markdown, no extra keys:
{"structureCheck":"<one short paragraph on visible structure>","refineEntry":{"price":<number|null>,"reason":"<string>"}|null,"refineInvalidation":{"price":<number|null>,"reason":"<string>","rejected":<true only if your level is WIDER than the engine stop loss, else false or omitted>}|null,"agreement":"AGREE|DISAGREE|NEUTRAL","confidence":<0-100 integer>,"risks":["<max 3 bullets>"],"disclaimer":"Opinion only — not an order. Final decision and risk are the trader's."}`;

const GEMINI_ENDPOINT = (model: string, key: string) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;

const DEFAULT_MODEL = "gemini-3-flash-preview";
const FALLBACK_MODEL = "gemini-2.5-flash";
const MAX_IMAGE_BYTES = 400_000; // combined base64 budget before falling back to text-only

/* ---------------- deterministic hash of the rendered confirmed candles ---------------- */

export function chartHash(candles: Candle[]): string {
  let h = 2166136261 >>> 0;
  for (const c of candles) {
    const s = `${c.t}|${c.o}|${c.h}|${c.l}|${c.c}`;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  }
  return (h >>> 0).toString(36);
}

/* ---------------- compact axis label ---------------- */

function axisLabel(p: number, asset: AssetType): string {
  const abs = Math.abs(p);
  const d = asset === "forex" ? (abs >= 100 ? 3 : 5) : asset === "crypto" ? (abs >= 1000 ? 0 : abs >= 1 ? 2 : 4) : abs >= 100 ? 1 : 2;
  return p.toLocaleString("en-US", { maximumFractionDigits: d });
}

/* ---------------- canvas snapshot renderer ---------------- */

interface RenderLevels {
  entry: number; sl: number; tp1: number; tp2: number; invalidation: number;
  zones: Array<{ top: number; bottom: number; bull: boolean }>;
  sweeps: Array<{ price: number; buy: boolean }>;
}

/**
 * Render `candles` (confirmed only) to an offscreen canvas and return a compressed PNG
 * (quality 0.6) as a base64 data URL. Draws candles, engine levels, OB/FVG boxes, sweep
 * markers, a readable price axis, and a last-price line.
 */
export function renderSnapshot(candles: Candle[], lv: RenderLevels, w: number, h: number, asset: AssetType): string {
  const canvas = document.createElement("canvas");
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx || candles.length < 2) return "";

  const padR = 46, padT = 6, padB = 6, padL = 4;
  const plotW = w - padL - padR, plotH = h - padT - padB;

  let lo = Infinity, hi = -Infinity;
  for (const c of candles) { lo = Math.min(lo, c.l); hi = Math.max(hi, c.h); }
  lo = Math.min(lo, lv.sl, lv.tp2); hi = Math.max(hi, lv.tp2, lv.entry);
  const pad = (hi - lo) * 0.06 || 1;
  lo -= pad; hi += pad;

  const x = (i: number) => padL + (i / (candles.length - 1)) * plotW;
  const y = (p: number) => padT + (1 - (p - lo) / (hi - lo)) * plotH;

  // background
  ctx.fillStyle = "#0c121c";
  ctx.fillRect(0, 0, w, h);

  // grid + price axis labels
  ctx.font = "8px 'JetBrains Mono', monospace";
  ctx.textBaseline = "middle";
  for (let g = 0; g <= 4; g++) {
    const p = lo + ((hi - lo) * g) / 4;
    const yy = y(p);
    ctx.strokeStyle = "rgba(154,168,191,0.12)";
    ctx.beginPath(); ctx.moveTo(padL, yy); ctx.lineTo(padL + plotW, yy); ctx.stroke();
    ctx.fillStyle = "#8a97ad";
    ctx.fillText(axisLabel(p, asset), padL + plotW + 4, yy);
  }

  // OB/FVG boxes
  for (const z of lv.zones) {
    ctx.fillStyle = z.bull ? "rgba(49,212,143,0.10)" : "rgba(245,86,107,0.10)";
    ctx.strokeStyle = z.bull ? "rgba(49,212,143,0.4)" : "rgba(245,86,107,0.4)";
    const zy = y(z.top), zh = Math.max(1.5, y(z.bottom) - y(z.top));
    ctx.fillRect(padL, zy, plotW, zh);
    ctx.strokeRect(padL, zy, plotW, zh);
  }

  // candles
  const cw = Math.max(1.2, (plotW / candles.length) * 0.6);
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const up = c.c >= c.o;
    const col = up ? "#31d48f" : "#f5566b";
    ctx.strokeStyle = col; ctx.fillStyle = col;
    const cx = x(i);
    ctx.beginPath(); ctx.moveTo(cx, y(c.h)); ctx.lineTo(cx, y(c.l)); ctx.stroke();
    const bt = y(Math.max(c.o, c.c));
    ctx.fillRect(cx - cw / 2, bt, cw, Math.max(1, Math.abs(y(c.o) - y(c.c))));
  }

  // sweep markers (diamonds on the axis side)
  for (const s of lv.sweeps) {
    const yy = y(s.price);
    ctx.strokeStyle = "#f5b840"; ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(padL + 6, yy - 4); ctx.lineTo(padL + 10, yy); ctx.lineTo(padL + 6, yy + 4); ctx.lineTo(padL + 2, yy); ctx.closePath();
    ctx.stroke();
    ctx.lineWidth = 1;
  }

  // engine level lines
  const level = (p: number, col: string, dash: number[], tag: string) => {
    const yy = y(p);
    ctx.strokeStyle = col; ctx.setLineDash(dash);
    ctx.beginPath(); ctx.moveTo(padL, yy); ctx.lineTo(padL + plotW, yy); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = col;
    ctx.fillText(tag, padL + 3, yy - 5);
  };
  level(lv.entry, "#f5b840", [], "ENTRY");
  level(lv.sl, "#f5566b", [4, 3], "SL");
  level(lv.tp1, "#31d48f", [4, 3], "TP1");
  level(lv.tp2, "#31d48f", [1, 3], "TP2");
  level(lv.invalidation, "#7cc7de", [2, 3], "INV");

  // last-price line + label
  const lastC = candles[candles.length - 1];
  const ly = y(lastC.c);
  const lpCol = lastC.c >= lastC.o ? "#31d48f" : "#f5566b";
  ctx.strokeStyle = lpCol; ctx.setLineDash([2, 2]);
  ctx.beginPath(); ctx.moveTo(padL, ly); ctx.lineTo(padL + plotW, ly); ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = lpCol;
  ctx.fillRect(padL + plotW + 2, ly - 7, padR - 4, 14);
  ctx.fillStyle = "#05080d";
  ctx.font = "bold 8px 'JetBrains Mono', monospace";
  ctx.fillText(axisLabel(lastC.c, asset), padL + plotW + 4, ly);

  return canvas.toDataURL("image/png", 0.6);
}

/* ---------------- payload assembly ---------------- */

/** Strip the data-URL prefix → raw base64 for the API. */
const stripPng = (url: string) => url.replace(/^data:image\/png;base64,/, "");

export interface ChartArtifacts {
  payload: ChartReviewPayload;
  stfCandles: Candle[];
  hash: string;
}

/**
 * Fetch confirmed STF + HTF candles, render both snapshots, and build the chart payload.
 * Returns the payload (with PNGs) plus the hash used for caching.
 */
export async function buildChartArtifacts(c: RadarCandidate, mode: "quality" | "quantity"): Promise<ChartArtifacts> {
  const stfRes = await fetchCandles(c.symbol, c.assetType, c.timeframe, 300);
  const htfTf = HTF_MAP[c.timeframe];
  const htfRes = htfTf === c.timeframe ? stfRes : await fetchCandles(c.symbol, c.assetType, htfTf, 300);

  // confirmed candles only — drop the forming candle
  const stfC = stfRes.candles.slice(0, -1).slice(-60);
  const htfC = htfRes.candles.slice(0, -1).slice(-40);
  const hash = chartHash(stfC);

  const s = c.setup;
  const smc = analyzeSMC(stfRes.candles.slice(0, -1));
  const lv: RenderLevels = {
    entry: s.entry_price, sl: s.stop_loss, tp1: s.take_profit1, tp2: s.take_profit2, invalidation: s.invalidation_level,
    zones: smc.zones.filter((z) => z.active && (z.kind.includes("ob") || z.kind.includes("fvg"))).slice(-8)
      .map((z) => ({ top: z.top, bottom: z.bottom, bull: z.kind.startsWith("bull") })),
    sweeps: smc.sweeps.slice(-6).map((sw) => ({ price: sw.price, buy: sw.side === "buy" })),
  };

  const stfPng = renderSnapshot(stfC, lv, 480, 220, c.assetType);
  const htfPng = renderSnapshot(htfC, lv, 360, 180, c.assetType);

  const r = s.reasoning;
  const risk = Math.abs(s.entry_price - s.stop_loss) || 1;
  const costInR = (s.entry_price * COSTS.entryPct + s.take_profit1 * COSTS.exitPct) / risk;

  const payload: ChartReviewPayload = {
    mode: "chartReview",
    signalId: c.key,
    chartHash: hash,
    symbol: c.symbol,
    timeframe: c.timeframe.toUpperCase(),
    direction: s.direction,
    score: c.score.total,
    confluences: s.confluences,
    entry: s.entry_price, stopLoss: s.stop_loss, takeProfit1: s.take_profit1, takeProfit2: s.take_profit2,
    invalidationLevel: s.invalidation_level,
    costInR: Number(costInR.toFixed(3)),
    session: r?.session.name ?? "unknown",
    htfBias: c.htfBiasAtGeneration,
    stfPng: stripPng(stfPng),
    htfPng: stripPng(htfPng),
  };
  void mode; // display mode does not affect the chart payload
  return { payload, stfCandles: stfC, hash };
}

/** Text-only fallback payload: last 20 confirmed candles + engine levels, no images. */
export function withTextFallback(payload: ChartReviewPayload, stfCandles: Candle[]): ChartReviewPayload {
  const last20 = stfCandles.slice(-20);
  const lvl = (n: string, p: number) => `${n}=${p.toPrecision(7)}`;
  return {
    ...payload,
    stfPng: undefined, htfPng: undefined,
    textOnly: {
      candles: last20.map((c) => `${c.t},${c.o.toPrecision(6)},${c.h.toPrecision(6)},${c.l.toPrecision(6)},${c.c.toPrecision(6)}`),
      levels: [
        lvl("entry", payload.entry), lvl("sl", payload.stopLoss), lvl("tp1", payload.takeProfit1),
        lvl("tp2", payload.takeProfit2), lvl("invalidation", payload.invalidationLevel),
      ],
    },
  };
}

/* ---------------- strict response schema ---------------- */

function refineOf(o: unknown, engineSl: number, entry: number, isInvalidation: boolean): (ChartRefinement & { rejected?: boolean }) | null {
  if (!o || typeof o !== "object") return null;
  const r = o as { price?: unknown; reason?: unknown; rejected?: unknown };
  const price = typeof r.price === "number" && isFinite(r.price) ? r.price : null;
  const reason = String(r.reason ?? "").trim();
  if (price == null && !reason) return null;
  // For the invalidation refinement, deterministically mark "rejected" when the AI's level is
  // WIDER than the engine stop loss (i.e. risks more than the engine planned). Client-enforced.
  let rejected: boolean | undefined;
  if (isInvalidation && price != null) {
    const aiWidth = Math.abs(price - entry);
    const engineWidth = Math.abs(engineSl - entry);
    rejected = aiWidth > engineWidth ? true : typeof r.rejected === "boolean" ? r.rejected : false;
  }
  return { price, reason, ...(rejected != null ? { rejected } : {}) };
}

export function enforceChartSchema(raw: unknown, engineSl: number, textOnly: boolean, entry = 0): ChartReviewResult {
  const o = (raw ?? {}) as Record<string, unknown>;
  const agreementRaw = String(o.agreement ?? "").toUpperCase();
  const agreement: ChartAgreement = agreementRaw === "AGREE" || agreementRaw === "DISAGREE" ? agreementRaw : "NEUTRAL";
  const confidence = Math.max(0, Math.min(100, Math.round(Number(o.confidence) || 0)));
  const structureCheck = String(o.structureCheck ?? "").trim() || "No structure read returned.";
  const risksRaw = Array.isArray(o.risks) ? o.risks : [];
  const risks = risksRaw.map((x) => String(x).trim()).filter(Boolean).slice(0, 3);
  return {
    structureCheck,
    refineEntry: refineOf(o.refineEntry, engineSl, entry, false),
    refineInvalidation: refineOf(o.refineInvalidation, engineSl, entry, true),
    agreement,
    confidence,
    risks,
    disclaimer: CHART_DISCLAIMER, // fixed — never model-supplied
    textOnly,
    generatedAt: Date.now(),
    cached: false,
    source: "local",
  };
}

function parseModelText(text: string): unknown {
  let t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) t = fence[1];
  const start = t.indexOf("{"); const end = t.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("model returned no JSON object");
  return JSON.parse(t.slice(start, end + 1));
}

/* ---------------- transport (max 1 concurrent; never throws) ---------------- */

class ChartCallError extends Error {
  status: number | null; code: string;
  constructor(status: number | null, code: string) { super(`${status ?? "NET"} ${code}`); this.status = status; this.code = code; }
}
const failChip = (e: unknown) => e instanceof ChartCallError ? (e.status != null ? `${e.status} ${e.code}` : e.code) : "ERROR";

async function geminiChartOnce(payload: ChartReviewPayload, key: string, model: string): Promise<unknown> {
  const hasImages = Boolean(payload.stfPng && payload.htfPng);
  const parts: Array<Record<string, unknown>> = [{ text: CHART_INSTRUCTION }];
  if (hasImages) {
    parts.push({ inline_data: { mime_type: "image/png", data: payload.stfPng } });
    parts.push({ inline_data: { mime_type: "image/png", data: payload.htfPng } });
  }
  parts.push({ text: "SIGNAL PAYLOAD (JSON):\n" + JSON.stringify(payload) });

  let res: Response;
  try {
    res = await fetch(GEMINI_ENDPOINT(model, key), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts }],
        generationConfig: { temperature: 0.2, maxOutputTokens: 400, responseMimeType: "application/json" },
      }),
    });
  } catch {
    throw new ChartCallError(null, "NETWORK ERROR");
  }
  if (!res.ok) {
    let code = (res.statusText || "HTTP_ERROR").toUpperCase().replace(/[\s-]+/g, "_");
    try {
      const j = (await res.json()) as { error?: { status?: string } };
      if (j.error?.status) code = j.error.status.toUpperCase().replace(/[\s-]+/g, "_");
    } catch { /* non-JSON body */ }
    throw new ChartCallError(res.status, code);
  }
  const j = (await res.json()) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
  const text = j.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
  if (!text) throw new ChartCallError(200, "EMPTY_RESPONSE");
  return parseModelText(text);
}

async function serverChartRoute(payload: ChartReviewPayload): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch("/api/ai-insight", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  } catch {
    throw new ChartCallError(null, "NETWORK ERROR");
  }
  const isJson = (res.headers.get("content-type") ?? "").includes("application/json");
  if (!isJson) throw new Error("no server route"); // static host served index.html
  if (!res.ok) {
    const code = res.status === 403 ? "NO_KEY" : res.status === 429 ? "RATE_LIMITED" : res.status >= 500 ? "SERVER_ERROR" : `HTTP_${res.status}`;
    throw new ChartCallError(res.status, code);
  }
  return await res.json();
}

let inflight: Promise<ChartReviewResult | { unavailable: string }> | null = null;

export interface ChartReviewOptions { localKey: string; model: string }

/**
 * Fetch (or replay from cache) a chart review for one signal. Never throws — failures resolve
 * to a tagged `{ unavailable }` chip so the card is never blocked.
 */
export function requestChartReview(
  payload: ChartReviewPayload,
  stfCandles: Candle[],
  opts: ChartReviewOptions,
): { promise: Promise<ChartReviewResult | { unavailable: string }> } {
  const engineSl = payload.stopLoss;

  const run = async (): Promise<ChartReviewResult | { unavailable: string }> => {
    // 1) cache replay (keyed by signalId + chartHash of the confirmed candles)
    try {
      const hit = await getChartReview(payload.signalId, payload.chartHash);
      if (hit) {
        const r = enforceChartSchema(hit.result, engineSl, Boolean((hit.result as ChartReviewResult)?.textOnly), payload.entry);
        return { ...r, cached: true, source: "cache" };
      }
    } catch { /* fall through */ }

    // 2) decide image vs text-only by size budget
    const tooBig = ((payload.stfPng?.length ?? 0) + (payload.htfPng?.length ?? 0)) > MAX_IMAGE_BYTES;
    let effective = tooBig ? withTextFallback(payload, stfCandles) : payload;
    let textOnly = tooBig;

    let parsed: unknown = null;
    let source: ChartReviewResult["source"] = "server";

    const attempt = async (p: ChartReviewPayload): Promise<unknown> => {
      try {
        return await serverChartRoute(p);
      } catch (e) {
        const status = e instanceof ChartCallError ? e.status : undefined;
        if (status === 429 || (status != null && status >= 500)) throw e; // surfaced as unavailable
        if (status === 403 && !opts.localKey) throw new ChartCallError(null, "NO_KEY — ADD ONE IN SETTINGS");
        if (!opts.localKey) throw new ChartCallError(null, "NO_KEY — ADD ONE IN SETTINGS");
        // direct Gemini (multimodal), with 404 → model fallback
        const requested = opts.model || DEFAULT_MODEL;
        const chain = [requested, FALLBACK_MODEL].filter((m, i, a) => a.indexOf(m) === i);
        for (let i = 0; i < chain.length; i++) {
          try {
            const out = await geminiChartOnce(p, opts.localKey, chain[i]);
            source = "local";
            return out;
          } catch (e2) {
            if (e2 instanceof ChartCallError && e2.status === 404 && i < chain.length - 1) continue;
            throw e2;
          }
        }
        throw new ChartCallError(404, "MODEL_NOT_FOUND");
      }
    };

    try {
      parsed = await attempt(effective);
    } catch (e) {
      // If the IMAGE call failed for a model/payload reason, retry once as text-only before giving up.
      const status = e instanceof ChartCallError ? e.status : undefined;
      const isNoKey = e instanceof ChartCallError && e.code.startsWith("NO_KEY");
      const retriable = !(status === 429 || (status != null && status >= 500)) && !textOnly && !isNoKey;
      if (retriable) {
        try {
          effective = withTextFallback(payload, stfCandles);
          textOnly = true;
          parsed = await attempt(effective);
        } catch (e2) {
          console.error("[chart-review] call failed —", e2 instanceof Error ? e2.message : e2);
          return { unavailable: failChip(e2) };
        }
      } else {
        console.error("[chart-review] call failed —", e instanceof Error ? e.message : e);
        return { unavailable: failChip(e) };
      }
    }

    const result = enforceChartSchema(parsed, engineSl, textOnly, payload.entry);
    result.source = source;
    result.textOnly = textOnly;
    await putChartReview(payload.signalId, payload.chartHash, result);
    return result;
  };

  inflight = (inflight ? inflight.catch(() => null).then(run) : run()) as Promise<ChartReviewResult | { unavailable: string }>;
  return { promise: inflight };
}
