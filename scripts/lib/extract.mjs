// Price extraction: deterministic regex first, Claude as the robust fallback
// ("read this page and tell me the price for exactly this model/tier/resolution").

import { toPerMinute, r4 } from "./normalize.mjs";

const MODEL = process.env.PRICE_LLM_MODEL || "claude-opus-5";

/** Cut a long page down to the windows that mention prices, so the LLM call stays cheap. */
export function focusText(text, limit = 40000) {
  if (!text) return "";
  if (text.length <= limit) return text;
  const re = /(\$\s?\d|USD|credits?\b|per\s+second|\/\s?s(ec)?\b|per\s+minute|\/min\b|tokens?\b|price|pricing|discount|sale|% off|until|expires?)/gi;
  const windows = [];
  let m;
  while ((m = re.exec(text)) && windows.length < 400) {
    const start = Math.max(0, m.index - 700);
    const end = Math.min(text.length, m.index + 900);
    if (windows.length && start <= windows[windows.length - 1][1]) {
      windows[windows.length - 1][1] = Math.max(windows[windows.length - 1][1], end);
    } else {
      windows.push([start, end]);
    }
  }
  let out = text.slice(0, 6000) + "\n[...]\n";
  for (const [s, e] of windows) {
    if (out.length + (e - s) > limit) break;
    out += text.slice(s, e) + "\n[...]\n";
  }
  return out;
}

/**
 * Regex extraction. recipe.regex = { "720p": "pattern with (?<v>number)", "480p": "..." }
 * recipe.unit = per_second | per_minute | per_clip | credits_per_second | credits_per_clip
 * Optional recipe.promo_end_regex captures (?<d>date text).
 */
export function extractWithRegex(text, recipe) {
  const out = { found: false, per_minute: {}, raw: [] };
  for (const [res, pattern] of Object.entries(recipe.regex || {})) {
    let re;
    try {
      re = new RegExp(pattern, "i");
    } catch (e) {
      out.raw.push(`bad regex for ${res}: ${e.message}`);
      continue;
    }
    const m = text.match(re);
    // first participating capture group (named groups v, v2, v3… or numbered) — alternations leave the others undefined
    const v = m ? (Object.values(m.groups || {}).find((x) => x != null) ?? m.slice(1).find((x) => x != null)) : null;
    if (v == null) continue;
    const num = Number(String(v).replace(/[,$\s]/g, ""));
    if (Number.isNaN(num)) continue;
    const pm = toPerMinute(num, recipe.unit || "per_second", recipe);
    if (pm == null) continue;
    out.per_minute[res] = pm;
    out.raw.push(`${res}: matched "${m[0].slice(0, 80)}"`);
    out.found = true;
  }
  if (recipe.promo_end_regex) {
    try {
      const m = text.match(new RegExp(recipe.promo_end_regex, "i"));
      const d = m?.groups?.d ?? m?.[1];
      if (d) out.promo_ends_at_text = d;
    } catch {
      /* ignore */
    }
  }
  return out;
}

// ---------------- JSON API extraction ----------------

/** Get a nested value by dotted path; `a.b[0].c` and `a.b.0.c` both work. */
export function getPath(obj, path) {
  if (!path) return obj;
  return path
    .replace(/\[(\d+)\]/g, ".$1")
    .split(".")
    .filter(Boolean)
    .reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

/** Evaluate a tiny arithmetic formula in `v` (numbers, + - * / ( ) and v only). */
export function applyFormula(v, formula) {
  if (!formula) return v;
  if (!/^[\d\s.+\-*/()ve]+$/.test(formula)) throw new Error(`unsafe formula: ${formula}`);
  // eslint-disable-next-line no-new-func
  return Function("v", `return (${formula});`)(v);
}

/**
 * recipe.list: path to the array of entries (e.g. "data", "items"); "" for a top-level array.
 * recipe.match: { field: "model", equals: "bytedance/seedance-2.0-mini/reference-to-video" }  (or `includes`)
 * recipe.fields: { "720p": { path: "price.actual.base_price", formula: "v*60" }, "480p": {...} }
 * recipe.promo: optional { path: "price.discount", formula: "100-v", label: "…" }
 */
export function extractFromJsonApi(json, recipe) {
  const out = { found: false, per_minute: {}, raw: [] };
  let list = recipe.list ? getPath(json, recipe.list) : json;
  if (!Array.isArray(list)) {
    // single object endpoint
    list = [json];
  }
  const m = recipe.match || {};
  const entry = list.find((e) => {
    const val = getPath(e, m.field);
    if (val == null) return false;
    if (m.equals != null) return String(val) === String(m.equals);
    if (m.includes != null) return String(val).includes(m.includes);
    return false;
  });
  if (!entry) {
    out.raw.push(`no entry where ${m.field} ${m.equals != null ? "=" : "includes"} ${m.equals ?? m.includes}`);
    return out;
  }
  for (const [res, spec] of Object.entries(recipe.fields || {})) {
    let v;
    const raw = getPath(entry, spec.path);
    if (spec.regex) {
      // the field is a text blurb ("…charged **$0.1547**/second for 720p…"); pull the number out of it
      const m = String(raw ?? "").match(new RegExp(spec.regex, "i"));
      const cap = m ? (Object.values(m.groups || {}).find((x) => x != null) ?? m.slice(1).find((x) => x != null)) : null;
      if (cap == null) {
        out.raw.push(`${res}: regex did not match in ${spec.path}`);
        continue;
      }
      v = Number(String(cap).replace(/[,$\s]/g, ""));
      if (Number.isNaN(v)) continue;
      const pm = toPerMinute(v, spec.unit || "per_second", { credit_usd: recipe.credit_usd, clip_s: spec.clip_s ?? recipe.clip_s, fixed_per_clip: spec.fixed_per_clip ?? recipe.fixed_per_clip });
      if (pm == null || pm <= 0) continue;
      out.per_minute[res] = pm;
      out.raw.push(`${res}: "${m[0].slice(0, 60)}"`);
      out.found = true;
      continue;
    }
    v = Number(raw);
    if (Number.isNaN(v)) {
      out.raw.push(`${res}: nothing numeric at ${spec.path}`);
      continue;
    }
    if (spec.factor_path) {
      const f = Number(getPath(entry, spec.factor_path));
      if (!Number.isNaN(f)) v = v * applyFormula(f, spec.factor_formula || "v/100");
    }
    const pm = r4(applyFormula(v, spec.formula || "v"));
    if (pm == null || pm <= 0) continue;
    out.per_minute[res] = pm;
    out.raw.push(`${res}: ${spec.path}=${raw}`);
    out.found = true;
  }
  if (recipe.promo?.path) {
    const dv = Number(getPath(entry, recipe.promo.path));
    if (!Number.isNaN(dv)) out.discount_pct = r4(applyFormula(dv, recipe.promo.formula || "v"));
  }
  out.entry_snapshot = Object.fromEntries(Object.entries(entry).filter(([k, v]) => typeof v !== "object" || k === "price" || k === "pricing_skus").slice(0, 12));
  return out;
}

// ---------------- Claude-based extraction ----------------

const RECORD_TOOL = {
  name: "record_quote",
  description:
    "Record the price you found for exactly the requested model, tier, input mode, audio setting and output resolutions. Call this exactly once. If the page does not show a price for that exact model/tier, set found=false.",
  strict: true,
  input_schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      found: { type: "boolean" },
      per_second_usd: {
        type: "object",
        additionalProperties: false,
        properties: {
          "480p": { type: ["number", "null"] },
          "720p": { type: ["number", "null"] },
          "768p": { type: ["number", "null"] },
          "1080p": { type: ["number", "null"] },
        },
        required: ["480p", "720p", "768p", "1080p"],
      },
      per_minute_usd: {
        type: "object",
        additionalProperties: false,
        properties: {
          "480p": { type: ["number", "null"] },
          "720p": { type: ["number", "null"] },
          "768p": { type: ["number", "null"] },
          "1080p": { type: ["number", "null"] },
        },
        required: ["480p", "720p", "768p", "1080p"],
      },
      fixed_usd_per_clip: { type: "number" },
      clip_basis_seconds: { type: "number" },
      max_clip_seconds: { type: "number" },
      raw_billing_text: { type: "string" },
      promo_active: { type: "boolean" },
      promo_label: { type: "string" },
      promo_discount_pct: { type: "number" },
      promo_ends_at: { type: "string", description: "ISO date or datetime if published, else empty string" },
      regular_per_minute_usd_720p: { type: ["number", "null"] },
      confidence: { type: "string", enum: ["high", "medium", "low"] },
      notes: { type: "string" },
    },
    required: [
      "found",
      "per_second_usd",
      "per_minute_usd",
      "fixed_usd_per_clip",
      "clip_basis_seconds",
      "max_clip_seconds",
      "raw_billing_text",
      "promo_active",
      "promo_label",
      "promo_discount_pct",
      "promo_ends_at",
      "regular_per_minute_usd_720p",
      "confidence",
      "notes",
    ],
  },
};

/** JSON schema of the record (shared by the Claude tool and the OpenAI-compatible / Gemini paths). */
export const QUOTE_SCHEMA = RECORD_TOOL.input_schema;

export function systemPrompt() {
  return `You are a meticulous pricing analyst for AI video-generation APIs. You read a provider's page and report the price for EXACTLY the requested model, tier (Turbo/Fast/Mini/Lite/Standard/Pro), input mode, audio setting and output resolution. Rules:
- Never invent or estimate a number that is not on the page. If the exact tier/resolution is absent, set found=false and explain in notes.
- Report the raw billing text verbatim (e.g. "8.2 credits/s", "$0.0242/s", "$1.12/M output tokens").
- Convert to USD per second and USD per minute of generated footage where the page gives enough information: $/s × 60; $/clip ÷ clip seconds × 60; credits × the USD-per-credit rate given to you; tokens require the page's own $/s equivalent or a stated formula.
- Keep variants separate: audio on vs off, 720p vs 768p vs 540p, provider-specific modes.
- promo_active=true only if the page shows a live discount today. Give its end date only if the page states it.
- Call record_quote exactly once.`;
}

function pickToolInput(response) {
  for (const block of response.content || []) {
    if (block.type === "tool_use" && block.name === "record_quote") return block.input;
  }
  return null;
}

/** Run one extraction turn, resuming pause_turn up to 5 times (server tools). */
async function runTurn(client, params) {
  let messages = params.messages;
  let response = await client.messages.create({ ...params, messages });
  let continuations = 0;
  while (response.stop_reason === "pause_turn" && continuations < 5) {
    messages = [...messages, { role: "assistant", content: response.content }];
    response = await client.messages.create({ ...params, messages });
    continuations++;
  }
  if (response.stop_reason === "refusal") {
    throw new Error("Claude declined the request (stop_reason=refusal)");
  }
  return response;
}

export function normalizeLlm(input, recipe) {
  const per_minute = {};
  for (const res of ["480p", "720p", "768p", "1080p"]) {
    const pm = input.per_minute_usd?.[res];
    const ps = input.per_second_usd?.[res];
    if (pm != null) per_minute[res] = r4(pm);
    else if (ps != null) per_minute[res] = toPerMinute(ps, "per_second", { clip_s: input.clip_basis_seconds, fixed_per_clip: input.fixed_usd_per_clip });
  }
  return {
    found: !!input.found && Object.keys(per_minute).length > 0,
    per_minute,
    raw_billing_text: input.raw_billing_text || "",
    max_clip_s: input.max_clip_seconds || null,
    clip_basis_s: input.clip_basis_seconds || recipe?.clip_s || null,
    fixed_per_clip: input.fixed_usd_per_clip || 0,
    promo: {
      active: !!input.promo_active,
      label: input.promo_label || "",
      discount_pct: input.promo_discount_pct || null,
      ends_at: input.promo_ends_at || "",
      regular_per_min: input.regular_per_minute_usd_720p != null ? { "720p": r4(input.regular_per_minute_usd_720p) } : null,
    },
    confidence: input.confidence || "medium",
    notes: input.notes || "",
  };
}

/**
 * Ask Claude to read the (already fetched) page text.
 * ctx: { quote, model, aggregator, recipe }
 */
export async function extractWithClaude(client, ctx, pageText, url) {
  const { quote, model, aggregator, recipe } = ctx;
  const creditLine = recipe?.credit_usd ? `This provider bills in credits; 1 credit = $${recipe.credit_usd}.` : "";
  const user = `PROVIDER: ${aggregator.name} (${aggregator.url})
PAGE URL: ${url}
MODEL TO PRICE: ${model.name} — spec: ${model.spec}
Tier/mode/audio/resolution basis for this quote: mode=${quote.mode || "any"}, audio=${quote.audio || "as specified"}, 720p-column basis=${quote.resolution_basis || "720p"}.
${creditLine}
Last known raw billing text (for orientation only; do NOT copy): "${quote.raw_billing_text || ""}"

PAGE TEXT (cleaned, may be truncated):
"""
${focusText(pageText)}
"""

Report the current price for exactly this model/tier via record_quote.`;

  const response = await runTurn(client, {
    model: MODEL,
    max_tokens: 4000,
    system: systemPrompt(),
    output_config: { effort: "medium" },
    tools: [RECORD_TOOL],
    tool_choice: { type: "auto" },
    messages: [{ role: "user", content: user }],
  });
  const input = pickToolInput(response);
  if (!input) return { found: false, notes: "record_quote was not called", per_minute: {} };
  return normalizeLlm(input, recipe);
}

/**
 * Research mode: let Claude search/fetch the provider's site itself when our
 * own fetch produced nothing usable (page moved, JS shell, etc.).
 */
export async function researchWithClaude(client, ctx, hintUrl) {
  const { quote, model, aggregator, recipe } = ctx;
  const creditLine = recipe?.credit_usd ? `This provider bills in credits; 1 credit = $${recipe.credit_usd}.` : "";
  const user = `Find TODAY's price on ${aggregator.name} (${aggregator.url}) for exactly: ${model.name} — spec: ${model.spec}. mode=${quote.mode || "any"}, audio=${quote.audio || "as specified"}, 720p-column basis=${quote.resolution_basis || "720p"}.
${creditLine}
Start from ${hintUrl} and only use pages on ${new URL(aggregator.url).hostname} (model pages, pricing, docs, calculators). Use web_fetch on the pages; web_search only to locate the right page. Report via record_quote exactly once; found=false if you cannot read a number on the provider's own site.`;

  const host = new URL(aggregator.url).hostname.replace(/^www\./, "");
  const response = await runTurn(client, {
    model: MODEL,
    max_tokens: 8000,
    system: systemPrompt(),
    output_config: { effort: "medium" },
    tools: [
      { type: "web_fetch_20260209", name: "web_fetch", max_uses: 6, allowed_domains: [host] },
      { type: "web_search_20260209", name: "web_search", max_uses: 3, allowed_domains: [host] },
      RECORD_TOOL,
    ],
    tool_choice: { type: "auto" },
    messages: [{ role: "user", content: user }],
  });
  const input = pickToolInput(response);
  if (!input) return { found: false, notes: "record_quote was not called", per_minute: {} };
  return normalizeLlm(input, recipe);
}
