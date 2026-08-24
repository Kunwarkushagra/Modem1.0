import type { AiInsightPayload, AiInsightResult, InsightStance, RadarCandidate } from "./types";
import { getInsight, putInsight } from "./cache";
import { fmtIST, roundTick } from "./utils";
import { COSTS } from "./backtest";

/**
 * AI INSIGHT — additive OPINION layer. It consumes the structured signal payload
 * only (no raw candles, no extra market data) and can therefore never alter entry
 * gates, validators, scoring, validity, reasoning, backtests or signal generation.
 *
 * Transport order:
 *  1. POST /api/ai-insight (serverless route — reads GEMINI_API_KEY from env, key
 *     never reaches the browser; see server/api-ai-insight.ts). Detected by a
 *     JSON content-type response; a static host returning index.html is ignored.
 *  2. Direct Gemini call with the locally stored key (static-build fallback;
 *     key stays in this browser and is never logged).
 */

export const INSIGHT_DISCLAIMER = "Opinion only — not an order. Final decision and risk are the trader's.";

export const INSIGHT_INSTRUCTION = `You are a risk reviewer for a systematic scalp signal. Use ONLY the structured signal data provided below. NEVER invent prices, patterns, news, or any data not present in the payload. Do not add levels. Judge whether the stated plan is coherent: direction vs HTF bias, entry location vs confluences, risk/reward after costs, invalidation definition, session context, and validity window.
If the data is insufficient to form an opinion, return {"stance":"NEUTRAL","confidence":0,"summary":"INSUFFICIENT CONTEXT","keyRisks":[],"invalidationRestated":"","disclaimer":""}.
Respond with ONLY this JSON object, no markdown, no extra keys:
{"stance":"AGREE|DISAGREE|NEUTRAL","confidence":<0-100 integer>,"summary":"<max 3 lines, plain text>","keyRisks":["<max 3 bullets>"],"invalidationRestated":"<the exact invalidation level copied from the payload>","disclaimer":"Opinion only — not an order. Final decision and risk are the trader's."}`;

const GEMINI_ENDPOINT = (model: string, key: string) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;

/* ---------------- payload ---------------- */

export function buildInsightPayload(c: RadarCandidate, mode: "quality" | "quantity"): AiInsightPayload {
  const s = c.setup;
  const r = s.reasoning;
  const sig = s.signal;
  const risk = Math.abs(s.entry_price - s.stop_loss) || 1;
  // round-trip execution cost in R from the shared SCALP-1.0 cost model (≈, at planned TP1 exit)
  const costInR = (s.entry_price * COSTS.entryPct + s.take_profit1 * COSTS.exitPct) / risk;
  const fbClass = s.isBreakout
    ? "confirmed-breakout"
    : r?.sweep?.fakeoutReversal ? "fakeout-reversal"
    : r?.sweep ? "liquidity-sweep"
    : "neutral";
  const reasoningText = [
    `HTF bias ${r?.htfBias ?? c.htfBiasAtGeneration}: ${r?.htfRationale ?? "n/a"}`,
    r?.liquidity ? `Liquidity grade ${r.liquidity.grade} (${r.liquidity.source}, ${r.liquidity.distanceAtr.toFixed(2)} ATR away)` : "No engineered liquidity nearby",
    r?.sweep ? `Sweep: depth ${r.sweep.depthAtr.toFixed(2)} ATR, reclaim ${r.sweep.reclaim ? "yes" : "no"}, displacement ${r.sweep.displacementAtr.toFixed(2)} ATR, trap score ${r.sweep.trapScore}${r.sweep.dryUp ? ", volume dry-up" : ""}${r.sweep.fakeoutReversal ? ", fakeout-reversal displacement" : ""}` : "No sweep evidence",
    r?.structureEvent ? `Structure: ${r.structureEvent.type} ${r.structureEvent.dir} @ ${r.structureEvent.level.toPrecision(6)}` : "No fresh BOS/CHoCH",
    r?.zone ? `Zone: ${r.zone.kind} grade ${r.zone.grade}, ${r.zone.distanceAtr.toFixed(2)} ATR from entry` : "No qualifying zone",
    r?.patternCtx ? `Pattern: ${r.patternCtx.name} (location factor ${r.patternCtx.factor})` : null,
    r?.amdPhase ? `AMD phase: ${r.amdPhase}` : null,
    `Session ${r?.session.name ?? "n/a"} (bonus ${r?.session.bonus ?? 0}) · planned RR ${r?.plannedRR ?? s.risk_reward_ratio} · ${r?.entryModel ?? ""}`,
  ].filter(Boolean).join("\n");

  return {
    signalId: c.key,
    symbol: c.symbol,
    timeframe: c.timeframe.toUpperCase(),
    direction: s.direction,
    score: c.score.total,
    scoreBreakdown: c.score,
    confluences: s.confluences,
    // all prices rounded to symbol tick precision — the model must never see (or restate) a 17-digit float
    entry: roundTick(s.entry_price, c.assetType),
    stopLoss: roundTick(s.stop_loss, c.assetType),
    takeProfit1: roundTick(s.take_profit1, c.assetType),
    takeProfit2: roundTick(s.take_profit2, c.assetType),
    invalidationLevel: roundTick(s.invalidation_level, c.assetType),
    costInR: Number(costInR.toFixed(3)),
    session: r?.session.name ?? "unknown",
    liquidityGrade: r?.liquidity?.grade ?? null,
    falseBreakoutClass: fbClass,
    htfBias: c.htfBiasAtGeneration,
    validityWindow: {
      type: sig?.type ?? "zone",
      candles: sig?.validCandles ?? 0,
      generatedAtIST: sig ? fmtIST(sig.generatedAt) : "",
      validTillIST: sig ? fmtIST(sig.validTillTs) : "",
    },
    reasoningText,
    mode,
  };
}

/* ---------------- strict response schema ---------------- */

function enforceSchema(raw: unknown, fallbackInvalidation: string): AiInsightResult {
  const o = (raw ?? {}) as Record<string, unknown>;
  const stanceRaw = String(o.stance ?? "").toUpperCase();
  const stance: InsightStance = stanceRaw === "AGREE" || stanceRaw === "DISAGREE" ? stanceRaw : "NEUTRAL";
  const confidence = Math.max(0, Math.min(100, Math.round(Number(o.confidence) || 0)));
  const summary = String(o.summary ?? "")
    .split("\n").map((l) => l.trim()).filter(Boolean).slice(0, 3).join("\n") || "No summary returned.";
  const risksRaw = Array.isArray(o.keyRisks) ? o.keyRisks : [];
  const keyRisks = risksRaw.map((x) => String(x).trim()).filter(Boolean).slice(0, 3);
  const invalidationRestated = String(o.invalidationRestated ?? "").trim() || fallbackInvalidation;
  return {
    stance,
    confidence,
    summary,
    keyRisks,
    invalidationRestated,
    disclaimer: INSIGHT_DISCLAIMER, // fixed — never model-supplied
    generatedAt: Date.now(),
    cached: false,
    source: "local",
  };
}

function parseGeminiText(text: string): unknown {
  let t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) t = fence[1];
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("model returned no JSON object");
  return JSON.parse(t.slice(start, end + 1));
}

/* ---------------- transport ---------------- */

const DEFAULT_MODEL = "gemini-3-flash-preview";
/** Auto-fallback chain on 404 (MODEL_NOT_FOUND / retired model): each hop is logged. */
const MODEL_FALLBACK_CHAIN = ["gemini-3-flash-preview", "gemini-2.5-flash", "gemini-2.5-flash-lite"];

/** Typed transport error: exact HTTP status + machine-readable code for the debug chip. */
class AiCallError extends Error {
  status: number | null; // null = network/parse failure (no HTTP round trip completed)
  code: string;          // e.g. MODEL_NOT_FOUND, API_KEY_INVALID, RESOURCE_EXHAUSTED, NETWORK ERROR
  constructor(status: number | null, code: string, detail?: string) {
    super(detail ?? `${status ?? "NET"} ${code}`);
    this.status = status;
    this.code = code;
  }
}

/** Exact failure chip text: "404 MODEL_NOT_FOUND", "400 API_KEY_INVALID", "NETWORK ERROR"… */
function failChip(e: unknown): string {
  if (e instanceof AiCallError) return e.status != null ? `${e.status} ${e.code}` : e.code;
  return "ERROR " + (e instanceof Error ? e.message.slice(0, 48) : "UNKNOWN");
}

async function geminiOnce(payload: AiInsightPayload, key: string, model: string): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(GEMINI_ENDPOINT(model, key), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: INSIGHT_INSTRUCTION + "\n\nSIGNAL PAYLOAD (JSON):\n" + JSON.stringify(payload) }] }],
        generationConfig: { temperature: 0.2, responseMimeType: "application/json" },
      }),
    });
  } catch {
    throw new AiCallError(null, "NETWORK ERROR"); // fetch rejected — offline/CORS/DNS
  }
  if (!res.ok) {
    // Gemini error body: {"error":{"code":404,"message":"…","status":"MODEL_NOT_FOUND"}}
    let code = (res.statusText || "HTTP_ERROR").toUpperCase().replace(/[\s-]+/g, "_");
    let msg = "";
    try {
      const j = (await res.json()) as { error?: { status?: string; message?: string } };
      if (j.error?.status) code = j.error.status.toUpperCase().replace(/[\s-]+/g, "_");
      msg = j.error?.message ?? "";
    } catch { /* non-JSON error body */ }
    console.warn(`[ai-insight] ${model} → HTTP ${res.status} ${code}${msg ? ` — ${msg.slice(0, 140)}` : ""}`);
    throw new AiCallError(res.status, code, msg || undefined);
  }
  const j = (await res.json()) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
  const text = j.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
  if (!text) throw new AiCallError(200, "EMPTY_RESPONSE");
  return parseGeminiText(text);
}

/**
 * Browser fallback call. Endpoint is the documented v1beta shape:
 * POST https://generativelanguage.googleapis.com/v1beta/models/<model>:generateContent?key=<key>
 * On 404 (MODEL_NOT_FOUND / retired model) it walks the fallback chain:
 * gemini-3-flash-preview → gemini-2.5-flash → gemini-2.5-flash-lite.
 */
async function callGeminiDirect(payload: AiInsightPayload, key: string, model: string): Promise<unknown> {
  const requested = model || DEFAULT_MODEL;
  const chain = [requested, ...MODEL_FALLBACK_CHAIN].filter((m, i, arr) => arr.indexOf(m) === i);
  for (let i = 0; i < chain.length; i++) {
    try {
      return await geminiOnce(payload, key, chain[i]);
    } catch (e) {
      if (e instanceof AiCallError && e.status === 404 && i < chain.length - 1) {
        console.info(`[ai-insight] ${chain[i]} unavailable (404 ${e.code}) — auto-fallback → ${chain[i + 1]}`);
        continue;
      }
      throw e;
    }
  }
  // unreachable — the loop always returns or throws — kept for exhaustiveness
  throw new AiCallError(404, "MODEL_NOT_FOUND");
}

async function callServerRoute(payload: AiInsightPayload): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch("/api/ai-insight", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch {
    throw new AiCallError(null, "NETWORK ERROR");
  }
  const isJson = (res.headers.get("content-type") ?? "").includes("application/json");
  if (!isJson) throw new Error("no server route"); // static host served index.html — fall through to local key
  if (!res.ok) {
    const code = res.status === 403 ? "NO_KEY" : res.status === 429 ? "RATE_LIMITED" : res.status >= 500 ? "SERVER_ERROR" : `HTTP_${res.status}`;
    throw new AiCallError(res.status, code);
  }
  return await res.json();
}

/* ---------------- concurrency guard: max 1 call in flight globally ---------------- */

let inflight: Promise<AiInsightResult> | null = null;

export interface InsightOptions { localKey: string; model: string }

/**
 * Fetch (or replay from cache) an AI insight for one signal.
 * Never throws — returns a tagged failure string the UI renders as a chip.
 */
export function requestInsight(
  payload: AiInsightPayload,
  opts: InsightOptions,
): { promise: Promise<AiInsightResult | { unavailable: string }> } {
  const run = async (): Promise<AiInsightResult | { unavailable: string }> => {
    // 1) cache replay
    try {
      const hit = await getInsight(payload.signalId);
      if (hit) {
        const r = enforceSchema(hit.result, String(payload.invalidationLevel));
        return { ...r, cached: true, source: "cache" };
      }
    } catch { /* fall through */ }

    // 2) server route (env-held key), then local-key fallback.
    //    Failures surface as EXACT debug chips ("404 MODEL_NOT_FOUND", "429 RATE_LIMITED",
    //    "NETWORK ERROR"…) — never a generic message — and never block the card.
    let parsed: unknown = null;
    let source: AiInsightResult["source"] = "server";
    try {
      parsed = await callServerRoute(payload);
    } catch (e) {
      const status = e instanceof AiCallError ? e.status : undefined;
      if (status === 429 || (status != null && status >= 500)) {
        return { unavailable: failChip(e) }; // e.g. "429 RATE_LIMITED" · "502 SERVER_ERROR"
      }
      if (status === 403 && !opts.localKey) {
        return { unavailable: "403 NO_KEY — AI DISABLED" };
      }
      if (!opts.localKey) {
        return { unavailable: "AI DISABLED — NO KEY (add one in Settings, or deploy /api/ai-insight)" };
      }
      try {
        parsed = await callGeminiDirect(payload, opts.localKey, opts.model);
        source = "local";
      } catch (e2) {
        console.error(`[ai-insight] ${payload.symbol} insight failed —`, e2 instanceof Error ? e2.message : e2);
        return { unavailable: failChip(e2) }; // e.g. "404 MODEL_NOT_FOUND" · "400 API_KEY_INVALID" · "429 RESOURCE_EXHAUSTED" · "NETWORK ERROR"
      }
    }

    const result = enforceSchema(parsed, String(payload.invalidationLevel));
    result.source = source;
    await putInsight(payload.signalId, result);
    return result;
  };

  // serialize all insight calls — max 1 concurrent
  inflight = (inflight ? inflight.catch(() => null).then(run) : run()) as Promise<AiInsightResult>;
  return { promise: inflight as Promise<AiInsightResult | { unavailable: string }> };
}
