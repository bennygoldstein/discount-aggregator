// Provider-agnostic page reader for the daily robot.
//
// The daily job can use ANY of these to read a pricing page and return the strict
// quote JSON — pick with LLM_PROVIDER (or just set the matching key):
//
//   gemini      GEMINI_API_KEY      Google AI Studio free tier. Native API with JSON schema output;
//                                   research mode uses Gemini's built-in google_search + url_context tools.
//   groq        GROQ_API_KEY        Free tier, OpenAI-compatible, JSON mode.
//   openrouter  OPENROUTER_API_KEY  Free ":free" models, OpenAI-compatible, JSON schema; research mode
//                                   appends the ":online" web plugin.
//   mistral     MISTRAL_API_KEY     Free experiment tier, OpenAI-compatible, JSON mode.
//   cerebras    CEREBRAS_API_KEY    Free tier, OpenAI-compatible, JSON schema.
//   custom      LLM_API_KEY + LLM_BASE_URL + LLM_MODEL   any OpenAI-compatible server.
//   anthropic   ANTHROPIC_API_KEY   (paid) handled in extract.mjs; kept for completeness.
//
// Every path returns the same shape as extractWithClaude() so refresh.mjs does not care.

import { focusText, normalizeLlm, systemPrompt, QUOTE_SCHEMA } from "./extract.mjs";

// minIntervalMs keeps a serial daily job under each free tier's per-minute cap.
// OpenRouter's web plugin is NOT free even on ":free" models ($0.007/request) — research
// mode there is opt-in with OPENROUTER_WEB=1; otherwise the Tavily fallback is used.
const PROVIDERS = {
  // gemini-3.5-flash-lite: free of charge (input, output and URL-context tool), JSON-schema output, ~500 requests/day
  // reported on the free tier; Google Search grounding is free only on the 2.5 models, so research mode uses
  // url_context on 3.x and adds google_search when a 2.5 model is chosen.
  gemini: { keyEnv: "GEMINI_API_KEY", native: "gemini", model: "gemini-3.5-flash-lite", research: true, minIntervalMs: 7000 },
  // Groq free plan: 1,000 req/day but only 8K tokens/minute and 200K tokens/day on the text models — so pages are
  // trimmed harder (maxChars) and calls are spaced a minute apart; ~30 pages/day fit. Fine as a backup, not first choice.
  groq: { keyEnv: "GROQ_API_KEY", base: "https://api.groq.com/openai/v1", model: "openai/gpt-oss-120b", json: "json_schema", minIntervalMs: 61000, maxChars: 18000 },
  openrouter: { keyEnv: "OPENROUTER_API_KEY", base: "https://openrouter.ai/api/v1", model: "nvidia/nemotron-3-super-120b-a12b:free", fallbacks: ["openrouter/free"], json: "json_schema", research: process.env.OPENROUTER_WEB === "1", minIntervalMs: 3500 },
  mistral: { keyEnv: "MISTRAL_API_KEY", base: "https://api.mistral.ai/v1", model: "mistral-small-latest", json: "json_schema", minIntervalMs: 1500 },
  cerebras: { keyEnv: "CEREBRAS_API_KEY", base: "https://api.cerebras.ai/v1", model: "llama-3.3-70b", json: "json_schema", minIntervalMs: 2500 },
  custom: { keyEnv: "LLM_API_KEY", base: process.env.LLM_BASE_URL || "", model: process.env.LLM_MODEL || "", json: "json_object", minIntervalMs: 0 },
};

let lastCallAt = 0;
async function pace(p) {
  const wait = lastCallAt + (p.minIntervalMs || 0) - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCallAt = Date.now();
}

/** Decide which free/paid reader to use from the environment. Returns null when no key is present. */
export function pickProvider(env = process.env) {
  let name = (env.LLM_PROVIDER || "").toLowerCase();
  if (!name) {
    for (const [k, p] of Object.entries(PROVIDERS)) if (env[p.keyEnv]) { name = k; break; }
  }
  if (!name || !PROVIDERS[name]) return null;
  const p = PROVIDERS[name];
  const apiKey = env[p.keyEnv] || env.LLM_API_KEY;
  if (!apiKey) return null;
  const model = env.LLM_MODEL || p.model;
  const base = env.LLM_BASE_URL || p.base;
  if (name === "custom" && !base) return null;
  return { name, apiKey, model, base, native: p.native || null, json: p.json || "json_object", research: !!p.research, minIntervalMs: Number(env.LLM_MIN_INTERVAL_MS) || p.minIntervalMs || 0, fallbacks: env.LLM_MODEL ? [] : p.fallbacks || [], maxChars: Number(env.LLM_MAX_CHARS) || p.maxChars || 36000 };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** POST JSON with retries on 429/5xx (free tiers are rate-limited per minute). */
async function postJsonRetry(url, body, headers, { tries = 4, timeoutMs = 90000 } = {}) {
  let last;
  for (let i = 0; i < tries; i++) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body), signal: ctl.signal });
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch { /* not json */ }
      if (res.status === 429 || res.status >= 500) {
        last = new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
        const retryAfter = Number(res.headers.get("retry-after")) || 0;
        await sleep(Math.max(retryAfter * 1000, 4000 * (i + 1)));
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
      return json ?? text;
    } catch (e) {
      if (e.name === "AbortError") { last = new Error("timeout"); continue; }
      throw e;
    } finally {
      clearTimeout(t);
    }
  }
  throw last || new Error("request failed");
}

/** Pull the first JSON object out of a model reply (tolerates ```json fences and chatter). */
function parseJsonLoose(text) {
  if (text == null) return null;
  if (typeof text === "object") return text;
  const s = String(text).trim();
  try { return JSON.parse(s); } catch { /* continue */ }
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) { try { return JSON.parse(fence[1]); } catch { /* continue */ } }
  const a = s.indexOf("{"), b = s.lastIndexOf("}");
  if (a >= 0 && b > a) { try { return JSON.parse(s.slice(a, b + 1)); } catch { /* continue */ } }
  return null;
}

// ---------- prompts (same wording as the Claude path, plus "answer with JSON only") ----------
function userPrompt({ quote, model, aggregator, recipe }, pageText, url, maxChars = 36000) {
  const creditLine = recipe?.credit_usd ? `This provider bills in credits; 1 credit = $${recipe.credit_usd}.` : "";
  return `PROVIDER: ${aggregator.name} (${aggregator.url})
PAGE URL: ${url}
MODEL TO PRICE: ${model.name} — spec: ${model.spec}
Tier/mode/audio/resolution basis for this quote: mode=${quote.mode || "any"}, audio=${quote.audio || "as specified"}, 720p-column basis=${quote.resolution_basis || "720p"}.
${creditLine}
Last known raw billing text (for orientation only; do NOT copy): "${quote.raw_billing_text || ""}"

PAGE TEXT (cleaned, may be truncated):
"""
${focusText(pageText, maxChars)}
"""

Report the current price for exactly this model/tier. Answer with ONE JSON object only, matching this schema (every key present; use null for unknown numbers, "" for unknown strings):
${JSON.stringify(QUOTE_SCHEMA.properties, null, 0)}`;
}

function researchPrompt({ quote, model, aggregator, recipe }, hintUrl) {
  const creditLine = recipe?.credit_usd ? `This provider bills in credits; 1 credit = $${recipe.credit_usd}.` : "";
  const host = new URL(aggregator.url).hostname.replace(/^www\./, "");
  return `Find TODAY's price on ${aggregator.name} (${aggregator.url}) for exactly: ${model.name} — spec: ${model.spec}. mode=${quote.mode || "any"}, audio=${quote.audio || "as specified"}, 720p-column basis=${quote.resolution_basis || "720p"}.
${creditLine}
Start from ${hintUrl} and only trust pages on ${host} (model pages, pricing, docs). Use your search / URL tools to open the provider's own pages. If you cannot read a number on the provider's own site, set found=false.
Answer with ONE JSON object only, matching this schema (every key present; null/"" for unknown):
${JSON.stringify(QUOTE_SCHEMA.properties, null, 0)}`;
}

// ---------- OpenAI-compatible path (Groq, OpenRouter, Mistral, Cerebras, custom, Gemini-compat) ----------
async function chatOpenAI(p, messages, { research = false } = {}) {
  await pace(p);
  const body = { model: p.model, messages, temperature: 0, max_tokens: 1200 };
  if (p.name === "openrouter" && p.fallbacks?.length) body.models = [p.model, ...p.fallbacks];
  if (p.json === "json_schema") body.response_format = { type: "json_schema", json_schema: { name: "quote", schema: QUOTE_SCHEMA, strict: true } };
  else body.response_format = { type: "json_object" };
  if (research && p.name === "openrouter") body.plugins = [{ id: "web", max_results: 5 }];
  const headers = { authorization: `Bearer ${p.apiKey}` };
  if (p.name === "openrouter") { headers["HTTP-Referer"] = "https://bennygoldstein.github.io/discount-aggregator/"; headers["X-Title"] = "Discount Aggregator Aggregator"; }
  let out;
  try {
    out = await postJsonRetry(`${p.base.replace(/\/$/, "")}/chat/completions`, body, headers);
  } catch (e) {
    // some servers reject json_schema; fall back to plain json_object once
    if (p.json === "json_schema" && /response_format|json_schema|unsupported|400/i.test(e.message)) {
      body.response_format = { type: "json_object" };
      out = await postJsonRetry(`${p.base.replace(/\/$/, "")}/chat/completions`, body, headers);
    } else throw e;
  }
  const content = out?.choices?.[0]?.message?.content;
  return parseJsonLoose(Array.isArray(content) ? content.map((c) => c.text || "").join("") : content);
}

// ---------- Gemini native path (JSON schema output; search + URL tools for research) ----------
function geminiSchema(schema) {
  // Gemini's responseSchema is an OpenAPI subset: no additionalProperties, no type arrays.
  const conv = (s) => {
    if (!s || typeof s !== "object") return s;
    const o = {};
    let type = s.type;
    let nullable = false;
    if (Array.isArray(type)) { nullable = type.includes("null"); type = type.find((t) => t !== "null") || "string"; }
    if (type) o.type = type.toUpperCase();
    if (nullable) o.nullable = true;
    if (s.enum) o.enum = s.enum;
    if (s.description) o.description = s.description;
    if (s.properties) { o.properties = {}; for (const [k, v] of Object.entries(s.properties)) o.properties[k] = conv(v); }
    if (s.required) o.required = s.required;
    if (s.items) o.items = conv(s.items);
    return o;
  };
  return conv(schema);
}

async function chatGemini(p, systemText, userText, { research = false } = {}) {
  await pace(p);
  const url = `${(process.env.GEMINI_API_BASE || "https://generativelanguage.googleapis.com/v1beta").replace(/\/$/, "")}/models/${encodeURIComponent(p.model)}:generateContent`;
  const body = {
    system_instruction: { parts: [{ text: systemText }] },
    contents: [{ role: "user", parts: [{ text: userText }] }],
    generationConfig: { temperature: 0, maxOutputTokens: 1500 },
  };
  if (research) {
    // tools and responseSchema cannot be combined; ask for JSON in the prompt instead and parse loosely.
    // url_context is free on every free-tier model; google_search grounding is free only on gemini-2.5-*.
    body.tools = /^gemini-2\.5/.test(p.model) ? [{ url_context: {} }, { google_search: {} }] : [{ url_context: {} }];
  } else {
    body.generationConfig.responseMimeType = "application/json";
    body.generationConfig.responseSchema = geminiSchema(QUOTE_SCHEMA);
  }
  const out = await postJsonRetry(url, body, { "x-goog-api-key": p.apiKey });
  const parts = out?.candidates?.[0]?.content?.parts || [];
  const text = parts.map((x) => x.text || "").join("");
  return parseJsonLoose(text);
}

// ---------- public API (same return shape as extractWithClaude / researchWithClaude) ----------
export async function extractWithLlm(p, ctx, pageText, url) {
  const sys = systemPrompt();
  const user = userPrompt(ctx, pageText, url, p.maxChars);
  const obj = p.native === "gemini" ? await chatGemini(p, sys, user) : await chatOpenAI(p, [{ role: "system", content: sys }, { role: "user", content: user }]);
  if (!obj || typeof obj !== "object") return { found: false, notes: "model did not return JSON", per_minute: {} };
  return normalizeLlm(fillDefaults(obj), ctx.recipe);
}

/**
 * Free search fallback for readers with no web tool (Groq, Mistral, Cerebras, custom):
 * Tavily (1,000 free credits/month, no card) finds the provider's current page for the model,
 * returns its cleaned text, and the reader extracts from that. Needs TAVILY_API_KEY.
 */
async function tavilyResearch(p, ctx, hintUrl) {
  const key = process.env.TAVILY_API_KEY;
  if (!key) return null;
  const { model, aggregator } = ctx;
  const host = new URL(aggregator.url).hostname.replace(/^www\./, "");
  const body = { query: `${model.name} API pricing per second ${aggregator.name}`, max_results: 4, include_domains: [host], include_raw_content: true, search_depth: "basic", api_key: key };
  const out = await postJsonRetry("https://api.tavily.com/search", body, { authorization: `Bearer ${key}` }, { tries: 2, timeoutMs: 60000 });
  const hits = (out?.results || []).filter((r) => r.url && (r.raw_content || r.content));
  for (const hit of hits.slice(0, 2)) {
    const text = hit.raw_content || hit.content;
    const r = await extractWithLlm(p, ctx, text, hit.url);
    if (r.found) return { ...r, notes: `via Tavily → ${hit.url}. ${r.notes || ""}`.trim() };
  }
  return { found: false, notes: hits.length ? `Tavily found ${hits.length} page(s) on ${host} but none showed the exact tier` : `Tavily found nothing on ${host}`, per_minute: {} };
}

export async function researchWithLlm(p, ctx, hintUrl) {
  if (!p.research) {
    const viaSearch = await tavilyResearch(p, ctx, hintUrl).catch((e) => ({ found: false, notes: `Tavily error: ${e.message}`, per_minute: {} }));
    return viaSearch || { found: false, notes: `${p.name} has no web tool and TAVILY_API_KEY is not set; research mode skipped`, per_minute: {} };
  }
  const sys = systemPrompt();
  const user = researchPrompt(ctx, hintUrl);
  const obj = p.native === "gemini" ? await chatGemini(p, sys, user, { research: true }) : await chatOpenAI(p, [{ role: "system", content: sys }, { role: "user", content: user }], { research: true });
  if (!obj || typeof obj !== "object") return { found: false, notes: "model did not return JSON", per_minute: {} };
  return normalizeLlm(fillDefaults(obj), ctx.recipe);
}

/** Free models sometimes omit keys; give normalizeLlm the full shape. */
function fillDefaults(o) {
  const res = { "480p": null, "720p": null, "768p": null, "1080p": null };
  return {
    found: !!o.found,
    per_second_usd: { ...res, ...(o.per_second_usd || {}) },
    per_minute_usd: { ...res, ...(o.per_minute_usd || {}) },
    fixed_usd_per_clip: Number(o.fixed_usd_per_clip) || 0,
    clip_basis_seconds: Number(o.clip_basis_seconds) || 0,
    max_clip_seconds: Number(o.max_clip_seconds) || 0,
    raw_billing_text: o.raw_billing_text || "",
    promo_active: !!o.promo_active,
    promo_label: o.promo_label || "",
    promo_discount_pct: Number(o.promo_discount_pct) || 0,
    promo_ends_at: o.promo_ends_at || "",
    regular_per_minute_usd_720p: o.regular_per_minute_usd_720p == null ? null : Number(o.regular_per_minute_usd_720p),
    confidence: ["high", "medium", "low"].includes(o.confidence) ? o.confidence : "medium",
    notes: o.notes || "",
  };
}
