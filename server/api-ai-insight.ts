/**
 * /api/ai-insight — SCALP-1.0 AI Insight (server-side only).
 *
 * DEPLOYMENT: drop this file into a Next.js App Router project as
 *   app/api/ai-insight/route.ts
 * (or adapt `handler` to your serverless framework of choice). The client in
 * src/lib/aiInsight.ts POSTs the structured signal payload here FIRST and only
 * falls back to a browser-held key when this route is absent (static hosting).
 *
 * SECURITY:
 *  - GEMINI_API_KEY is read from process.env at request time and NEVER returned,
 *    logged, or bundled to the client.
 *  - Only the structured payload is forwarded — no candles, no account data.
 *  - Response is the strict insight JSON schema; the disclaimer is fixed.
 *
 * This file is intentionally OUTSIDE src/ so the Vite client build never
 * compiles or ships it (tsconfig include = ["src"]).
 */

const DISCLAIMER = "Opinion only — not an order. Final decision and risk are the trader's.";

const INSTRUCTION = `You are a risk reviewer for a systematic scalp signal. Use ONLY the structured signal data provided below. NEVER invent prices, patterns, news, or any data not present in the payload. Do not add levels. Judge whether the stated plan is coherent: direction vs HTF bias, entry location vs confluences, risk/reward after costs, invalidation definition, session context, and validity window.
If the data is insufficient to form an opinion, return {"stance":"NEUTRAL","confidence":0,"summary":"INSUFFICIENT CONTEXT","keyRisks":[],"invalidationRestated":"","disclaimer":""}.
Respond with ONLY this JSON object, no markdown, no extra keys:
{"stance":"AGREE|DISAGREE|NEUTRAL","confidence":<0-100 integer>,"summary":"<max 3 lines, plain text>","keyRisks":["<max 3 bullets>"],"invalidationRestated":"<the exact invalidation level copied from the payload>","disclaimer":"${DISCLAIMER}"}`;

const ALLOWED_FIELDS = [
  "signalId", "symbol", "timeframe", "direction", "score", "scoreBreakdown", "confluences",
  "entry", "stopLoss", "takeProfit1", "takeProfit2", "invalidationLevel", "costInR",
  "session", "liquidityGrade", "falseBreakoutClass", "htfBias", "validityWindow",
  "reasoningText", "mode",
] as const;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

function enforce(raw: unknown, fallbackInvalidation: string) {
  const o = (raw ?? {}) as Record<string, unknown>;
  const stanceRaw = String(o.stance ?? "").toUpperCase();
  const stance = stanceRaw === "AGREE" || stanceRaw === "DISAGREE" ? stanceRaw : "NEUTRAL";
  const confidence = Math.max(0, Math.min(100, Math.round(Number(o.confidence) || 0)));
  const summary = String(o.summary ?? "").split("\n").map((l) => l.trim()).filter(Boolean).slice(0, 3).join("\n") || "No summary returned.";
  const keyRisks = (Array.isArray(o.keyRisks) ? o.keyRisks : []).map((x) => String(x).trim()).filter(Boolean).slice(0, 3);
  const invalidationRestated = String(o.invalidationRestated ?? "").trim() || fallbackInvalidation;
  return { stance, confidence, summary, keyRisks, invalidationRestated, disclaimer: DISCLAIMER, generatedAt: Date.now() };
}

/* ---------------- AI Chart Review (mode: "chartReview") — multimodal, still server-side key ---------------- */

const CHART_INSTRUCTION = `You are reviewing two candlestick chart snapshots (setup timeframe and higher timeframe) plus a compact structured signal payload. Analyze the provided chart snapshots ONLY. Do NOT invent levels, patterns, or prices that are not visible. If a level is visible, state its approximate price read from the axis. Judge whether the visible structure supports the signal direction.
If you cannot form an opinion, return {"structureCheck":"INSUFFICIENT CONTEXT","refineEntry":null,"refineInvalidation":null,"agreement":"NEUTRAL","confidence":0,"risks":[],"disclaimer":""}.
Respond with ONLY this JSON object, no markdown, no extra keys:
{"structureCheck":"<one short paragraph on visible structure>","refineEntry":{"price":<number|null>,"reason":"<string>"}|null,"refineInvalidation":{"price":<number|null>,"reason":"<string>","rejected":<true only if your level is WIDER than the engine stop loss, else false or omitted>}|null,"agreement":"AGREE|DISAGREE|NEUTRAL","confidence":<0-100 integer>,"risks":["<max 3 bullets>"],"disclaimer":"${DISCLAIMER}"}`;

const CHART_ALLOWED_FIELDS = [
  "mode", "signalId", "chartHash", "symbol", "timeframe", "direction", "score", "confluences",
  "entry", "stopLoss", "takeProfit1", "takeProfit2", "invalidationLevel", "costInR",
  "session", "htfBias", "stfPng", "htfPng", "textOnly",
] as const;

function refineOf(o: unknown, engineSl: number, entry: number, isInvalidation: boolean) {
  if (!o || typeof o !== "object") return null;
  const r = o as { price?: unknown; reason?: unknown; rejected?: unknown };
  const price = typeof r.price === "number" && isFinite(r.price) ? r.price : null;
  const reason = String(r.reason ?? "").trim();
  if (price == null && !reason) return null;
  let rejected: boolean | undefined;
  if (isInvalidation && price != null) {
    rejected = Math.abs(price - entry) > Math.abs(engineSl - entry) ? true : typeof r.rejected === "boolean" ? r.rejected : false;
  }
  return { price, reason, ...(rejected != null ? { rejected } : {}) };
}

function enforceChart(raw: unknown, engineSl: number, entry: number, textOnly: boolean) {
  const o = (raw ?? {}) as Record<string, unknown>;
  const agreementRaw = String(o.agreement ?? "").toUpperCase();
  const agreement = agreementRaw === "AGREE" || agreementRaw === "DISAGREE" ? agreementRaw : "NEUTRAL";
  const confidence = Math.max(0, Math.min(100, Math.round(Number(o.confidence) || 0)));
  const structureCheck = String(o.structureCheck ?? "").trim() || "No structure read returned.";
  const risks = (Array.isArray(o.risks) ? o.risks : []).map((x) => String(x).trim()).filter(Boolean).slice(0, 3);
  return {
    structureCheck,
    refineEntry: refineOf(o.refineEntry, engineSl, entry, false),
    refineInvalidation: refineOf(o.refineInvalidation, engineSl, entry, true),
    agreement, confidence, risks,
    disclaimer: DISCLAIMER, textOnly, generatedAt: Date.now(),
  };
}

export async function POST(req: Request): Promise<Response> {
  const key = process.env.GEMINI_API_KEY; // read per request; never echoed, never logged
  if (!key) return json({ error: "no-key" }, 403);

  let payload: Record<string, unknown>;
  try {
    payload = (await req.json()) as Record<string, unknown>;
  } catch {
    return json({ error: "invalid-json" }, 400);
  }

  /* ---- AI CHART REVIEW branch (multimodal: two PNG snapshots + compact payload) ---- */
  if (payload.mode === "chartReview") {
    const clean: Record<string, unknown> = {};
    for (const f of CHART_ALLOWED_FIELDS) if (f in payload) clean[f] = payload[f];
    if (typeof clean.symbol !== "string" || typeof clean.direction !== "string") return json({ error: "bad-payload" }, 400);
    const { stfPng, htfPng, textOnly, ...rest } = clean as Record<string, unknown>;
    const parts: Array<Record<string, unknown>> = [{ text: CHART_INSTRUCTION }];
    if (typeof stfPng === "string" && stfPng) parts.push({ inline_data: { mime_type: "image/png", data: stfPng } });
    if (typeof htfPng === "string" && htfPng) parts.push({ inline_data: { mime_type: "image/png", data: htfPng } });
    parts.push({ text: "SIGNAL PAYLOAD (JSON):\n" + JSON.stringify(rest) });

    const model = process.env.GEMINI_MODEL || "gemini-3-flash-preview";
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contents: [{ role: "user", parts }], generationConfig: { temperature: 0.2, maxOutputTokens: 400, responseMimeType: "application/json" } }),
      });
    } catch {
      return json({ error: "upstream-network" }, 502);
    }
    if (res.status === 429) return json({ error: "rate-limited" }, 429);
    if (res.status >= 500) return json({ error: "upstream-error" }, 502);
    if (!res.ok) return json({ error: "upstream-rejected" }, 502);
    try {
      const j = (await res.json()) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
      const text = j.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
      const start = text.indexOf("{");
      const end = text.lastIndexOf("}");
      if (start < 0 || end <= start) throw new Error("no json");
      const parsed = JSON.parse(text.slice(start, end + 1));
      return json(enforceChart(parsed, Number(clean.stopLoss ?? 0), Number(clean.entry ?? 0), Boolean(textOnly)));
    } catch {
      return json(enforceChart(null, Number(clean.stopLoss ?? 0), Number(clean.entry ?? 0), Boolean(textOnly)));
    }
  }

  // accept only the structured whitelist — drop anything else
  const clean: Record<string, unknown> = {};
  for (const f of ALLOWED_FIELDS) if (f in payload) clean[f] = payload[f];
  if (typeof clean.symbol !== "string" || typeof clean.direction !== "string") {
    return json({ error: "bad-payload" }, 400);
  }

  const model = process.env.GEMINI_MODEL || "gemini-2.0-flash";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: INSTRUCTION + "\n\nSIGNAL PAYLOAD (JSON):\n" + JSON.stringify(clean) }] }],
        generationConfig: { temperature: 0.2, responseMimeType: "application/json" },
      }),
    });
  } catch {
    return json({ error: "upstream-network" }, 502);
  }

  if (res.status === 429) return json({ error: "rate-limited" }, 429);
  if (res.status >= 500) return json({ error: "upstream-error" }, 502);
  if (!res.ok) return json({ error: "upstream-rejected" }, 502);

  let text = "";
  try {
    const j = (await res.json()) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
    text = j.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start < 0 || end <= start) throw new Error("no json");
    const parsed = JSON.parse(text.slice(start, end + 1));
    return json(enforce(parsed, String(clean.invalidationLevel ?? "")));
  } catch {
    return json(enforce(null, String(clean.invalidationLevel ?? ""))); // schema-safe NEUTRAL
  }
}

// Generic export so non-Next adapters can mount `handler` directly.
export const handler = POST;
