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

`refresh.mjs` walks every quote in `data/prices.json`, looks up its recipe in `data/sources.json`, fetches the page
(headless Chromium when `render: true` and `USE_BROWSER=1`), then:

1. `regex` — deterministic pattern with a named group `v`, converted with `unit` (`per_second`, `per_clip`,
   `credits_per_second`, `credits_per_clip`, `per_minute`) plus `credit_usd`, `clip_s`, `fixed_per_clip`.
2. `llm` — Claude (`claude-opus-5`) reads the page text and reports the exact tier via a strict tool.
   If nothing is found and `allow_research: true`, Claude may search/fetch the provider's own site.
3. `atlas-calc` — POSTs the exact payloads to Atlas Cloud's free quote endpoint (needs `ATLASCLOUD_API_KEY`).
4. `manual` — never auto-refreshed (kept as verified by hand).

Every new figure is sanity-checked against the stored one (outside 0.2×–5× → flagged `needs_review`, old value kept).
Dated promotions that have ended are switched to `promo.regular_per_min` (or flagged if unknown).

### Secrets (GitHub → Settings → Secrets and variables → Actions)

| Secret | Effect if set |
|---|---|
| `ANTHROPIC_API_KEY` | Enables Claude-based extraction and research fallback (recommended; a few cents per day) |
| `ATLASCLOUD_API_KEY` | Enables live Atlas quotes through `/api/v1/model/calculate` |

Without any secret the robot still runs: regex recipes, sale-expiry, ranking, snapshots and rebuild.

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
