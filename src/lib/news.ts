import type { AssetType, NewsItem, Sentiment } from "./types";
import { fetchWithTimeout, normSymbol } from "./utils";

const PROXIES = [
  (u: string) => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`,
  (u: string) => `https://corsproxy.io/?url=${encodeURIComponent(u)}`,
];

async function viaProxy(url: string, timeoutMs = 9000): Promise<string> {
  let lastErr: unknown = null;
  for (const p of PROXIES) {
    try {
      const res = await fetchWithTimeout(p(url), timeoutMs);
      if (res.ok) return await res.text();
    } catch (e) { lastErr = e; }
  }
  throw lastErr instanceof Error ? lastErr : new Error("proxy unreachable");
}

function stripHtml(s: string): string {
  const el = document.createElement("div");
  el.innerHTML = s;
  return (el.textContent ?? "").replace(/\s+/g, " ").trim();
}

function parseRss(xml: string): NewsItem[] {
  try {
    const doc = new DOMParser().parseFromString(xml, "text/xml");
    const items = Array.from(doc.querySelectorAll("item"));
    return items.slice(0, 5).map((it) => {
      const title = it.querySelector("title")?.textContent ?? "Untitled";
      const link = it.querySelector("link")?.textContent ?? "#";
      const pub = it.querySelector("pubDate")?.textContent ?? "";
      const desc = stripHtml(it.querySelector("description")?.textContent ?? "").slice(0, 220);
      const sourceMatch = title.match(/^(.*?)\s+-\s+([A-Za-z0-9 .&'’-]+)$/);
      return {
        title: sourceMatch ? sourceMatch[1].trim() : title,
        source: sourceMatch ? sourceMatch[2].trim() : "Google News",
        url: link,
        publishedAt: pub ? Date.parse(pub) : Date.now(),
        summary: desc || "—",
      };
    });
  } catch {
    return [];
  }
}

async function cryptoCompareNews(): Promise<NewsItem[]> {
  const res = await fetchWithTimeout("https://min-api.cryptocompare.com/data/v2/news/?lang=EN", 8000);
  if (!res.ok) throw new Error("cryptocompare " + res.status);
  const json = (await res.json()) as { Data?: Array<{ title: string; body: string; url: string; source: string; published_on: number }> };
  if (!json.Data?.length) throw new Error("cryptocompare empty");
  return json.Data.slice(0, 5).map((d) => ({
    title: d.title,
    source: d.source,
    url: d.url,
    publishedAt: d.published_on * 1000,
    summary: stripHtml(d.body).slice(0, 220),
  }));
}

export async function fetchNews(rawSymbol: string, asset: AssetType, log?: (m: string, k?: "info" | "ok" | "warn") => void): Promise<NewsItem[]> {
  const symbol = normSymbol(rawSymbol, asset);
  if (asset === "crypto") {
    try {
      const items = await cryptoCompareNews();
      if (items.length) { log?.(`news ← CryptoCompare (${items.length}) ✓`, "ok"); return items; }
    } catch { log?.("CryptoCompare failed → Google News RSS", "warn"); }
  }
  const base = asset === "crypto" ? symbol.replace("USDT", " ") + " crypto" : asset === "forex" ? `${symbol} forex` : `${symbol} stock`;
  const rss = `https://news.google.com/rss/search?q=${encodeURIComponent(base)}&hl=en-US&gl=US&ceid=US:en`;
  try {
    const xml = await viaProxy(rss);
    const items = parseRss(xml);
    if (items.length) { log?.(`news ← Google News RSS (${items.length}) ✓`, "ok"); return items; }
    log?.("news: RSS parsed empty", "warn");
  } catch {
    log?.("news sources unreachable — analysis continues without news", "warn");
  }
  return [];
}

export async function fetchSentiment(log?: (m: string, k?: "info" | "ok" | "warn") => void): Promise<Sentiment | null> {
  try {
    const res = await fetchWithTimeout("https://api.alternative.me/fng/?limit=1", 6000);
    if (!res.ok) throw new Error("fng " + res.status);
    const j = (await res.json()) as { data?: Array<{ value: string; value_classification: string }> };
    const d = j.data?.[0];
    if (!d) throw new Error("fng empty");
    log?.(`sentiment: Fear & Greed ${d.value} (${d.value_classification}) ✓`, "ok");
    return { value: Number(d.value), label: d.value_classification };
  } catch {
    return null;
  }
}
