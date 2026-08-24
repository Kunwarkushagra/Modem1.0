import type { AiInsightPayload, AiInsightResult, InsightStance, RadarCandidate } from "./types";
import { getInsight, putInsight } from "./cache";
import { fmtIST } from "./utils";
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
    entry: s.entry_price,
    stopLoss: s.stop_loss,
    takeProfit1: s.take_profit1,
    takeProfit2: s.take_profit2,
    invalidationLevel: s.invalidation_level,
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

async function callGeminiDirect(payload: AiInsightPayload, key: string, model: string): Promise<unknown> {
  const res = await fetch(GEMINI_ENDPOINT(model || "gemini-2.0-flash", key), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: INSIGHT_INSTRUCTION + "\n\nSIGNAL PAYLOAD (JSON):\n" + JSON.stringify(payload) }] }],
      generationConfig: { temperature: 0.2, responseMimeType: "application/json" },
    }),
  });
  if (res.status === 429) throw Object.assign(new Error("rate-limited (429)"), { status: 429 });
  if (res.status >= 500) throw Object.assign(new Error(`server error (${res.status})`), { status: res.status });
  if (!res.ok) throw Object.assign(new Error(`gemini ${res.status}`), { status: res.status });
  const j = (await res.json()) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
  const text = j.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
  if (!text) throw new Error("empty model response");
  return parseGeminiText(text);
}

async function callServerRoute(payload: AiInsightPayload): Promise<unknown> {
  const res = await fetch("/api/ai-insight", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const isJson = (res.headers.get("content-type") ?? "").includes("application/json");
  if (!isJson) throw new Error("no server route"); // static host served index.html
  if (res.status === 403) throw Object.assign(new Error("no-key"), { status: 403 });
  if (res.status === 429) throw Object.assign(new Error("rate-limited (429)"), { status: 429 });
  if (res.status >= 500) throw Object.assign(new Error(`server error (${res.status})`), { status: res.status });
  if (!res.ok) throw Object.assign(new Error(`route ${res.status}`), { status: res.status });
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

    // 2) server route (env-held key), then local-key fallback
    let parsed: unknown = null;
    let source: AiInsightResult["source"] = "server";
    try {
      parsed = await callServerRoute(payload);
    } catch (e) {
      const status = (e as { status?: number })?.status;
      if (status === 429 || (status != null && status >= 500)) {
        return { unavailable: "AI UNAVAILABLE — retry later" };
      }
      if (status === 403 && !opts.localKey) {
        return { unavailable: "AI DISABLED — no key" };
      }
      if (!opts.localKey) {
        return { unavailable: status === 403 ? "AI DISABLED — no key" : "AI DISABLED — no key (add one in Settings, or deploy /api/ai-insight)" };
      }
      try {
        parsed = await callGeminiDirect(payload, opts.localKey, opts.model);
        source = "local";
      } catch (e2) {
        const s2 = (e2 as { status?: number })?.status;
        if (s2 === 429 || (s2 != null && s2 >= 500)) return { unavailable: "AI UNAVAILABLE — retry later" };
        console.error("[ai-insight] call failed —", e2);
        return { unavailable: "AI UNAVAILABLE — retry later" };
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
