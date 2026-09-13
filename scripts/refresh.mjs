#!/usr/bin/env node
// Daily researcher. Walks every quote in data/prices.json, re-reads its source
// (per data/sources.json), updates prices/promos with sanity checks, expires
// dated sales, recomputes the cheapest aggregator per model, and writes:
//   data/prices.json, data/cheapest.json, data/history/YYYY-MM-DD.json,
//   data/history/index.json, data/changes.json, data/last-run.json
//
// Env:  ANTHROPIC_API_KEY  (optional, paid) Claude reads pages the recipes cannot parse
//       GEMINI_API_KEY / GROQ_API_KEY / OPENROUTER_API_KEY / MISTRAL_API_KEY / CEREBRAS_API_KEY
//                          (optional, FREE tiers) same job with a free model — see scripts/lib/llm.mjs
//       LLM_PROVIDER / LLM_MODEL / LLM_BASE_URL / LLM_API_KEY  override or point at any OpenAI-compatible server
//       ATLASCLOUD_API_KEY (optional) enables Atlas Cloud's free quote endpoint
//       USE_BROWSER=1      (optional) render JS pages with Playwright/Chromium
//       DRY_RUN=1          compute but do not write files
//       ONLY=<quote_id>    refresh a single quote (debugging)

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fetchPage, postJson, closeBrowser } from "./lib/fetch.mjs";
import { extractWithRegex, extractFromJsonApi, extractWithClaude, researchWithClaude } from "./lib/extract.mjs";
import { pickProvider, extractWithLlm, researchWithLlm } from "./lib/llm.mjs";
import { computeCheapest, computeDeals, buildCheapestFeed, col720, isoDate, promoExpired, promoKind, r4 } from "./lib/normalize.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "..");
const DATA = path.join(ROOT, "data");
const readJson = (p, fallback = null) => (fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : fallback);
const writeJson = (p, obj) => {
  if (process.env.DRY_RUN === "1") return;
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + "\n");
};

const now = new Date();
const today = isoDate(now);
const data = readJson(path.join(DATA, "prices.json"));
if (!data) {
  console.error("data/prices.json not found");
  process.exit(1);
}
const sources = readJson(path.join(DATA, "sources.json"), {});
const changes = readJson(path.join(DATA, "changes.json"), []);
const aggs = Object.fromEntries(data.aggregators.map((a) => [a.id, a]));
const models = Object.fromEntries(data.models.map((m) => [m.id, m]));

// ---- which page reader? Claude (paid) if ANTHROPIC_API_KEY, else any free-tier key (Gemini, Groq, OpenRouter, Mistral, Cerebras, custom) ----
let reader = null; // { name, extract(ctx, text, url), research(ctx, url) }
if (process.env.ANTHROPIC_API_KEY) {
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const client = new Anthropic();
  reader = { name: "anthropic", extract: (ctx, text, url) => extractWithClaude(client, ctx, text, url), research: (ctx, url) => researchWithClaude(client, ctx, url) };
} else {
  const p = pickProvider();
  if (p) reader = { name: `${p.name}:${p.model}`, extract: (ctx, text, url) => extractWithLlm(p, ctx, text, url), research: (ctx, url) => researchWithLlm(p, ctx, url) };
}
console.log(reader ? `Page reader: ${reader.name}` : "Page reader: none (no LLM key) — JSON-API / Atlas-calc / regex / expiry checks only");
const client = reader; // legacy name used below

const run = { date: today, started_at: now.toISOString(), checked: 0, updated: 0, unchanged: 0, not_found: 0, needs_review: 0, errors: 0, skipped: 0, log: [] };
const say = (s) => {
  console.log(s);
  run.log.push(s);
};

function recordChange(q, field, oldV, newV, note) {
  changes.unshift({ date: today, quote_id: q.id, model: models[q.model_id]?.name, aggregator: aggs[q.aggregator_id]?.name, field, old: oldV, new: newV, note });
}

/** Merge a per-minute result into the quote with sanity bounds. Returns true if any price changed. */
function applyPrices(q, perMinute, meta) {
  let changed = false;
  let flagged = false;
  q.per_min ||= {};
  for (const [res, val] of Object.entries(perMinute || {})) {
    if (val == null) continue;
    const old = q.per_min[res];
    if (old == null) {
      q.per_min[res] = r4(val);
      recordChange(q, `per_min.${res}`, null, r4(val), "new resolution quote");
      changed = true;
      continue;
    }
    const ratio = val / old;
    if (ratio < 0.2 || ratio > 5) {
      flagged = true;
      q.needs_review = { date: today, field: `per_min.${res}`, seen: r4(val), kept: old, why: "outside 0.2x–5x sanity band" };
      say(`  !! ${q.id} ${res}: saw $${r4(val)}/min vs kept $${old}/min — outside sanity band, kept old value (needs review)`);
      continue;
    }
    if (Math.abs(ratio - 1) > 0.005) {
      recordChange(q, `per_min.${res}`, old, r4(val), meta.note || "price changed");
      q.per_min[res] = r4(val);
      changed = true;
    }
  }
  if (!flagged) delete q.needs_review;
  return changed;
}

function applyPromo(q, promo) {
  if (!promo) return;
  const was = q.promo?.active ? `${q.promo.label}|${q.promo.ends_at}` : "none";
  const isNow = promo.active ? `${promo.label}|${promo.ends_at}` : "none";
  if (was !== isNow) recordChange(q, "promo", was, isNow, promo.active ? "promo changed" : "promo removed");
  q.promo = {
    active: !!promo.active,
    kind: promo.active ? promoKind({ active: true, ends_at: promo.ends_at || "", label: promo.label || "" }) : "",
    label: promo.label || "",
    discount_pct: promo.discount_pct ?? q.promo?.discount_pct ?? null,
    ends_at: promo.ends_at || "",
    regular_per_min: promo.regular_per_min || q.promo?.regular_per_min || null,
  };
}

const jsonCache = {};
async function fetchJsonCached(url) {
  try {
    const page = await fetchPage(url, { render: false });
    let json = null;
    try {
      json = JSON.parse(page.html);
    } catch {
      /* not JSON */
    }
    return { status: page.status, json };
  } catch (e) {
    return { status: 0, json: null, error: e.message };
  }
}

/**
 * Atlas Cloud's free quote endpoint (works without a key; a key is sent when present).
 * recipe: { url, payloads: { "720p": {model, duration, resolution, ...}, "480p": {...} }, price_path?: "data.price", discount_path?: "data.discount" }
 */
async function refreshAtlasCalc(q, recipe) {
  const key = process.env.ATLASCLOUD_API_KEY;
  const headers = key ? { authorization: `Bearer ${key}` } : {};
  const perMinute = {};
  const raw = [];
  let discountPaid = null;
  for (const [res, payload] of Object.entries(recipe.payloads || {})) {
    const { status, json } = await postJson(recipe.url || "https://api.atlascloud.ai/api/v1/model/calculate", payload, headers);
    if (status !== 200 || !json) {
      raw.push(`${res}: HTTP ${status}`);
      continue;
    }
    const pricePath = recipe.price_path || "data.price";
    const price = Number(pricePath.split(".").reduce((o, k) => (o == null ? undefined : o[k]), json));
    const seconds = Number(payload[recipe.duration_field || "duration"]);
    if (!Number.isNaN(price) && seconds) {
      perMinute[res] = r4((price / seconds) * 60);
      raw.push(`${res}: ${seconds}s = $${price}`);
      const d = Number((recipe.discount_path || "data.discount").split(".").reduce((o, k) => (o == null ? undefined : o[k]), json));
      if (!Number.isNaN(d)) discountPaid = d;
    } else raw.push(`${res}: no price at ${pricePath}`);
  }
  const out = { found: Object.keys(perMinute).length > 0, per_minute: perMinute, raw_billing_text: `Atlas /calculate: ${raw.join("; ")}`, confidence: "high", method: "atlas-calc" };
  if (discountPaid != null && discountPaid < 100 && q.promo?.label) out.promo = { ...q.promo, active: true, discount_pct: 100 - discountPaid };
  return out;
}

async function refreshQuote(q) {
  const recipe = sources[q.id];
  const model = models[q.model_id];
  const aggregator = aggs[q.aggregator_id];
  if (!recipe || recipe.method === "manual") return { skipped: "manual" };
  if (recipe.method === "atlas-calc") return refreshAtlasCalc(q, recipe);

  // 0) public JSON API (deterministic, preferred where the provider exposes one)
  if (recipe.method === "json-api") {
    const cached = jsonCache[recipe.url] || (jsonCache[recipe.url] = await fetchJsonCached(recipe.url));
    if (cached.json) {
      const r = extractFromJsonApi(cached.json, recipe);
      if (r.found) {
        const res = { found: true, per_minute: r.per_minute, method: "json-api", confidence: "high", raw_billing_text: q.raw_billing_text };
        if (r.discount_pct != null && recipe.promo?.label) res.promo = { active: r.discount_pct > 0, label: r.discount_pct > 0 ? recipe.promo.label.replace("{pct}", String(Math.round(r.discount_pct))) : "", discount_pct: r.discount_pct, ends_at: q.promo?.ends_at || "", regular_per_min: q.promo?.regular_per_min || null };
        return res;
      }
      say(`  -- ${q.id}: json-api gave nothing (${r.raw.join(" | ")})`);
    } else say(`  -- ${q.id}: json-api HTTP ${cached.status}`);
    if (!recipe.fallback_url && !client) return { found: false, notes: "json-api failed, no fallback" };
    // fall through to page + LLM using fallback_url
  }

  const url = recipe.fallback_url || (recipe.method === "json-api" ? q.model_page_url || q.source_url : recipe.url || q.source_url);
  const page = await fetchPage(url, { render: !!recipe.render });
  if (page.status >= 400 || !page.text) {
    say(`  -- ${q.id}: HTTP ${page.status} / empty page`);
    if (client && recipe.allow_research !== false) {
      const r = await reader.research({ quote: q, model, aggregator, recipe }, url);
      return { ...r, method: "llm-research" };
    }
    return { found: false, notes: `HTTP ${page.status}` };
  }

  // 1) deterministic regex
  if (recipe.regex && Object.keys(recipe.regex).length) {
    const r = extractWithRegex(page.text + "\n" + page.html, recipe);
    if (r.found) {
      return { found: true, per_minute: r.per_minute, method: "regex", confidence: "high", raw_billing_text: q.raw_billing_text, promo_ends_at_text: r.promo_ends_at_text };
    }
    say(`  -- ${q.id}: regex did not match (${r.raw.join(" | ") || "no groups"})`);
  }

  // 2) Claude reads the page
  if (client) {
    const r = await reader.extract({ quote: q, model, aggregator, recipe }, page.text, page.url);
    if (r.found) return { ...r, method: "llm" };
    say(`  -- ${q.id}: Claude found no exact price on page (${r.notes?.slice(0, 120) || ""})`);
    if (recipe.allow_research) {
      const rr = await reader.research({ quote: q, model, aggregator, recipe }, url);
      if (rr.found) return { ...rr, method: "llm-research" };
      return { found: false, notes: rr.notes };
    }
    return { found: false, notes: r.notes };
  }
  return { found: false, notes: "no extractor available" };
}

// ---------------- main loop ----------------
const only = process.env.ONLY;
for (const q of data.quotes) {
  if (only && q.id !== only) continue;
  run.checked++;
  const label = `${models[q.model_id]?.name} @ ${aggs[q.aggregator_id]?.name}`;
  try {
    const res = await refreshQuote(q);
    if (res.skipped) {
      run.skipped++;
      continue;
    }
    if (res.found) {
      const changed = applyPrices(q, res.per_minute, { note: res.method });
      if (res.promo) applyPromo(q, res.promo);
      if (res.raw_billing_text) q.raw_billing_text = res.raw_billing_text;
      if (res.max_clip_s) q.max_clip_s = res.max_clip_s;
      q.checked_at = today;
      q.method = res.method;
      q.confidence = res.confidence || q.confidence;
      q.stale_days = 0;
      delete q.last_error;
      if (changed) {
        run.updated++;
        say(`  ✓ ${label}: updated → 720p $${col720(q)}/min`);
      } else {
        run.unchanged++;
        say(`  = ${label}: unchanged ($${col720(q)}/min)`);
      }
    } else {
      run.not_found++;
      const last = Date.parse(q.checked_at || today);
      q.stale_days = Math.max(0, Math.round((now.getTime() - last) / 86400000));
      q.last_error = { date: today, note: (res.notes || "price not found").slice(0, 200) };
      say(`  ? ${label}: not verified today (stale ${q.stale_days}d)`);
    }
  } catch (e) {
    run.errors++;
    q.last_error = { date: today, note: String(e.message || e).slice(0, 200) };
    say(`  x ${label}: ${e.message}`);
  }
}
await closeBrowser();

// ---------------- promo expiry ----------------
for (const q of data.quotes) {
  if (q.promo?.active && promoExpired(q.promo.ends_at, now)) {
    say(`  ⏰ ${models[q.model_id]?.name} @ ${aggs[q.aggregator_id]?.name}: promo "${q.promo.label}" ended ${q.promo.ends_at}`);
    recordChange(q, "promo", `${q.promo.label}|${q.promo.ends_at}`, "ended", "dated promotion expired");
    if (q.promo.regular_per_min) {
      for (const [res, val] of Object.entries(q.promo.regular_per_min)) {
        if (val == null) continue;
        recordChange(q, `per_min.${res}`, q.per_min?.[res] ?? null, val, "promo ended → regular price");
        q.per_min[res] = val;
      }
    } else {
      q.needs_review = { date: today, field: "promo", why: "promo expired but regular price unknown" };
    }
    q.promo = { ...q.promo, active: false, ended_on: q.promo.ends_at };
  }
}

// ---------------- recompute + write ----------------
data.cheapest = computeCheapest(data);
data.deals = computeDeals(data);
data.generated_at = new Date().toISOString();
if (run.updated + run.unchanged > 0) data.checked_at = data.generated_at;
run.needs_review = data.quotes.filter((q) => q.needs_review).length;
run.finished_at = new Date().toISOString();
data.last_run = { date: run.date, checked: run.checked, updated: run.updated, unchanged: run.unchanged, not_found: run.not_found, needs_review: run.needs_review, errors: run.errors, reader: reader ? reader.name : null, browser: process.env.USE_BROWSER === "1" };

writeJson(path.join(DATA, "prices.json"), data);
writeJson(path.join(DATA, "cheapest.json"), buildCheapestFeed(data));
writeJson(path.join(DATA, "changes.json"), changes.slice(0, 300));
writeJson(path.join(DATA, "last-run.json"), run);

const snapshot = {
  date: today,
  cheapest: Object.fromEntries(Object.entries(data.cheapest).map(([m, c]) => [m, { aggregator_id: c.aggregator_id, per_min_720p: c.per_min_720p }])),
  quotes: Object.fromEntries(data.quotes.map((q) => [q.id, col720(q)])),
};
writeJson(path.join(DATA, "history", `${today}.json`), snapshot);
const histDir = path.join(DATA, "history");
const dates = fs.existsSync(histDir) ? fs.readdirSync(histDir).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).map((f) => f.slice(0, 10)).sort() : [today];
writeJson(path.join(histDir, "index.json"), { dates });

console.log(`\nDone. checked=${run.checked} updated=${run.updated} unchanged=${run.unchanged} not_found=${run.not_found} needs_review=${run.needs_review} errors=${run.errors} skipped=${run.skipped}`);
