# Discount Aggregator Aggregator

The cheapest place to render every AI video model, checked daily across ten API aggregators.
Static site (GitHub Pages) + a daily GitHub Actions robot that re-reads every provider's price page.

- Live site: https://bennygoldstein.github.io/discount-aggregator/
- Agent feed: https://bennygoldstein.github.io/discount-aggregator/data/cheapest.json
- Full data: https://bennygoldstein.github.io/discount-aggregator/data/prices.json
- Instructions for LLMs: https://bennygoldstein.github.io/discount-aggregator/llms.txt

## Layout

| Path | What |
|---|---|
| `index.html` | Generated page (do not edit by hand — edit the template and rebuild) |
| `templates/index.template.html` | Page template: sheet-style table, charts, explainer, agent section |
| `data/prices.json` | The dataset: aggregators, models, every quote, cheapest per model, deals, footnotes |
| `data/sources.json` | Per-quote refresh recipe (URL, method, regex/unit, render flag) used by the daily robot |
| `data/cheapest.json` | Compact per-model feed for agents (generated) |
| `data/history/` | One snapshot per day + `index.json` (generated) |
| `data/changes.json` | Dated change log (generated) |
| `scripts/refresh.mjs` | The daily researcher |
| `scripts/build.mjs` | Renders `index.html`, `sitemap.xml`, `data/cheapest.json` |
| `.github/workflows/daily.yml` | Cron 10:17 UTC daily + manual run |

## Daily robot

> **Not yet armed:** the workflow file lives in `.github/workflows-pending/daily.yml` because the token used for the first
> push lacked the `workflow` scope. Move it to `.github/workflows/daily.yml` (after `gh auth refresh -h github.com -s workflow`,
> or via the GitHub web editor) and add the secrets below.

`refresh.mjs` walks every quote in `data/prices.json`, looks up its recipe in `data/sources.json`, fetches the page
(headless Chromium when `render: true` and `USE_BROWSER=1`), then:

1. `json-api` — a public JSON endpoint (`url`), the entry to pick (`list` + `match`), and per-resolution `fields`
   (`path` + `formula`, or `path` + `regex` when the field is a pricing sentence, optional `factor_path` for a
   discount percentage). Used for fal.ai (`/api/models`), OpenRouter (`/api/v1/videos/models`), WaveSpeed (`/api/models`).
2. `atlas-calc` — POSTs exact `payloads` (model, duration, resolution, generate_audio) to Atlas Cloud's free quote
   endpoint; no key needed (a key is sent when `ATLASCLOUD_API_KEY` is set).
3. `regex` — deterministic pattern with a named group `v`, converted with `unit` (`per_second`, `per_clip`,
   `credits_per_second`, `credits_per_clip`, `per_minute`) plus `credit_usd`, `clip_s`, `fixed_per_clip`.
   Used for Runware's `schema.json` pricing text, Replicate's embedded `billingConfig`, Kie.ai's `pricingDesc`.
4. `llm` — the page reader (Gemini free tier by default, or Claude `claude-opus-5` when `ANTHROPIC_API_KEY` is set)
   reads the page text and reports the exact tier as strict JSON. If nothing is found and `allow_research: true`,
   it may search/fetch the provider's own site (Gemini URL context, Claude web tools, or the Tavily fallback).
   Every deterministic recipe also falls back to this path (`fallback_url`) when it returns nothing.
5. `manual` — never auto-refreshed (kept as verified by hand).

Each deterministic recipe was validated on creation (`validated_on`, `validated_against`) by reproducing the
published price live; if a provider changes its API shape the sanity band flags the quote instead of publishing junk.

Every new figure is sanity-checked against the stored one (outside 0.2×–5× → flagged `needs_review`, old value kept).
Dated promotions that have ended are switched to `promo.regular_per_min` (or flagged if unknown).

### Running the page reader for free

Claude is optional. `scripts/lib/llm.mjs` lets any of these free tiers do the same job — set **one** key as a repo
secret and the robot picks it up (Claude wins if `ANTHROPIC_API_KEY` is also set). Verified 2026-09-13:

| Provider (secret) | Free tier, as published | Fit for ~45–70 page reads/day | Web tool for "page moved" | Notes |
|---|---|---|---|---|
| **Google Gemini** (`GEMINI_API_KEY`) — default model `gemini-3.5-flash-lite` | Input, output and the URL-context tool "free of charge"; ~500 requests/day reported; no card | **Yes** (recommended) | URL context free; Google Search grounding free only on `gemini-2.5-*` (500/day) | Free-tier prompts may be used to improve Google products — fine for public pricing pages. Key from Google AI Studio. |
| **OpenRouter** (`OPENROUTER_API_KEY`) — `nvidia/nemotron-3-super-120b-a12b:free`, fallback `openrouter/free` | $0 tokens on `:free` models; **50 requests/day** (1,000/day after a one-time $10 credit purchase); 20/min | Borderline at 50/day | Web plugin costs $0.007/request even on free models → opt-in with `OPENROUTER_WEB=1`; otherwise Tavily fallback | Enable "allow training" for free models in your OpenRouter privacy settings or many free endpoints are skipped. |
| **Groq** (`GROQ_API_KEY`) — `openai/gpt-oss-120b` | 1,000 requests/day but 8K tokens/min and 200K tokens/day; no card | ~30 pages/day (pages trimmed to 18K chars, one call/minute) | none built in for JSON mode → Tavily fallback | Backup only. No training on prompts. |
| **Mistral** (`MISTRAL_API_KEY`) — `mistral-small-latest` | "Free mode": reported ~1 request/s, 500K tokens/min, 1B tokens/month (exact figures only in your admin Limits page); no card | **Yes** (good second choice) | none in chat completions → Tavily fallback | Free-tier data may be used for training unless you opt out in the account settings. |
| **Cerebras** (`CEREBRAS_API_KEY`), any OpenAI-compatible server (`LLM_PROVIDER=custom` + `LLM_API_KEY` + `LLM_BASE_URL` + `LLM_MODEL`) | see the provider's current free plan | varies | Tavily fallback | Supported by the same code path. |
| ~~GitHub Models~~ | **Retired 2026-07-30** (endpoint returns HTTP 410) | no | — | Not an option any more. |

Optional free search for readers without a web tool: **Tavily** (`TAVILY_API_KEY`, 1,000 credits/month, no card)
finds the provider's current page and hands its text to the reader.

Overrides: `LLM_PROVIDER`, `LLM_MODEL`, `LLM_MIN_INTERVAL_MS` (pacing), `LLM_MAX_CHARS` (page trim). Every reader
returns the same strict JSON; the 0.2×–5× sanity band applies to all of them.

### Secrets (GitHub → Settings → Secrets and variables → Actions)

| Secret | Effect if set | Cost |
|---|---|---|
| `GEMINI_API_KEY` | **Recommended.** Gemini 3.5 Flash-Lite reads the pages the recipes cannot parse (see table above) | $0 |
| `TAVILY_API_KEY` | Free search so a reader without a web tool can find a page that moved | $0 |
| `MISTRAL_API_KEY` / `OPENROUTER_API_KEY` / `GROQ_API_KEY` / `CEREBRAS_API_KEY` | Alternative free readers | $0 |
| `ANTHROPIC_API_KEY` | Claude Opus 5 reads the pages instead (wins if set; best quality) | ≈ $3.50–4/day; Haiku ≈ $0.75/day via `PRICE_LLM_MODEL=claude-haiku-4-5` |
| `ATLASCLOUD_API_KEY` | Sent to Atlas's quote endpoint (works without it) | $0 |

Without any secret the robot still runs: JSON-API / Atlas / regex recipes (52 quotes, 14 of 18 winners), sale-expiry,
ranking, snapshots, spreadsheets and rebuild.

## Local

```bash
npm install
node scripts/build.mjs          # rebuild index.html from data/
DRY_RUN=1 node scripts/refresh.mjs   # try the researcher without writing
npx serve -l 4630 .              # preview at http://localhost:4630
```

## Custom domain later

1. Add a `CNAME` file containing the domain (e.g. `example.com`) to the repo root and push.
2. At the registrar (IONOS): `A @` → 185.199.108.153 / .109.153 / .110.153 / .111.153 and
   `AAAA @` → 2606:50c0:8000::153 / :8001::153 / :8002::153 / :8003::153; `CNAME www` → `bennygoldstein.github.io`.
3. GitHub → repo Settings → Pages → Custom domain → enter it, wait for the DNS check, tick "Enforce HTTPS".
4. Update `site.url` in `data/prices.json` and rebuild so the feed URLs on the page point at the new domain.

## Editing prices by hand

Edit `data/prices.json` (`quotes[]`), then `node scripts/build.mjs` and push. Set a quote's recipe to
`"method": "manual"` in `data/sources.json` if the robot should not touch it.
