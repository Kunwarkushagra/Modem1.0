# TradeVision AI Ultimate Pro

Institutional-grade trading analysis & journaling terminal: **SMC / ICT / Price Action / Stop-Loss-Hunting detection across three timeframes**, live news as a side factor, **AI-generated trade setups with self-learning**, strict **anti-hallucination validation**, backtesting, paper trading, and risk management.

> **Environment note** — this workspace ships as a **Vite + React + TypeScript + Tailwind** app (the platform's build target), not Next.js. Every "backend" concern from the spec is implemented as an isolated module in `src/lib/` with the exact same responsibilities as the requested API routes, so it ports 1:1 to Next.js route handlers (map below). Market data is fetched client-side from the same public endpoints (Binance `data-api.binance.vision` is the CORS-enabled mirror of `api.binance.com`).

## Run locally

```bash
npm install
npm run dev       # local dev
npm run build     # production build → dist/
```

No keys are required for market data, news, or the default **Offline Engine** (deterministic, derives setups only from detected structure).

## AI providers (optional)

Open **Settings → Analysis Engine**, pick a provider and paste a key (stored only in `localStorage`, sent directly to the provider):

| Provider   | Get a key at                                | Default model                  |
|------------|---------------------------------------------|--------------------------------|
| OpenAI     | platform.openai.com/api-keys                | `gpt-4o`                       |
| Anthropic  | console.anthropic.com (browser access flag set automatically) | `claude-3-5-sonnet-latest` |
| Qwen-Max   | DashScope (Alibaba Cloud) — intl endpoint   | `qwen-max`                     |
| OpenRouter | openrouter.ai/keys                          | any `vendor/model`             |

The **exact institutional prompt** from the spec is used for every call. Whatever the AI returns is then forced through the local validator — an AI setup that fails a check is discarded, exactly like an offline-engine setup.

## The anti-hallucination validator

Every candidate setup (AI or offline engine) must pass **all** of:

1. Entry/SL/TP1/TP2 inside `[min(low)×0.99, max(high)×1.01]` of the STF data.
2. Direction consistency (Long: SL < entry < TP1 ≤ TP2).
3. **RR ≥ 2.0**, recomputed from raw prices.
4. Estimated win rate ≥ 60% **and** confidence ≥ 60.
5. Entry within **0.5% (crypto) / 1% (stocks & forex)** of a *detected* level — order block, FVG, liquidity pool, S/R, swing, premium/discount band. Not near a level → rejected.
6. Breakout setups only survive with **volume > 20-period MA** and **≥ 2 closes beyond the level**.

If nothing survives: *"No high-probability setup found with required confluences and filters."*

## Self-learning loop

Closed journal trades feed `PAST PERFORMANCE AND LESSONS LEARNED` into every prompt: win rate, PF, Sharpe, drawdown, **best/worst confluences**, and a **tilt detector** on the last 10 trades. The engine favors historically winning stacks, avoids losing ones, and explains its calibration in `self_learning_note`.

## Data sources (no keys)

- **Crypto**: Binance klines (300, STF/HTF/LTF) → OKX fallback → labelled simulated feed.
- **Stocks/Forex**: Yahoo Finance chart API (symbols normalized: `EURUSD → EURUSD=X`) → Stooq CSV via proxy.
- **News**: CryptoCompare (crypto) → Google News RSS; top 5 headlines stored as text.
- **Sentiment**: alternative.me Fear & Greed (crypto).
- **Telegram alerts** (optional): bot token + chat id in Settings; fires when a setup passes validation.

## Port map → Next.js (server-side)

| This build (`src/lib/`) | Next.js route                |
|--------------------------|------------------------------|
| `ai.ts → runAnalysis`    | `POST /api/analyze`          |
| `journal.ts`             | `GET/POST /api/trades`, `PUT /api/trades/[id]` |
| `performance.ts`         | `GET /api/performance`       |
| `backtest.ts`            | `POST /api/backtest`         |
| `journal.ts (alerts)`    | `POST /api/alerts`           |
| `news.ts → fetchSentiment` | `GET /api/sentiment`       |
| `smc.ts → analyzeSMC`    | `POST /api/smc-levels`       |
| `news.ts → fetchNews`    | `GET /api/news`              |

Function signatures already match the request/response shapes in the spec; move each module into `app/api/.../route.ts`, swap `localStorage` for Postgres/Supabase (`DATABASE_URL`), and read keys from `process.env` (`QWEN_API_KEY` / `OPENAI_AI_KEY` / `ANTHROPIC_API_KEY`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`).

## Deploy (Vercel)

1. Push the repo → **Import Project** in Vercel (framework: Vite).
2. No env vars needed for the base product; add AI/Telegram vars in *Project → Settings → Environment Variables* once you move providers server-side.
3. Deploy — the build is fully static (`dist/`).

**Disclaimer:** analytics are informational, not financial advice.
