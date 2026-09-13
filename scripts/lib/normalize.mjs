// Unit conversion + ranking helpers shared by refresh.mjs and build.mjs.
// Everything is normalized to USD per MINUTE of generated footage.

export const RES_KEYS = ["480p", "720p", "1080p"];

/** Round to cents-ish precision without float noise. */
export const r4 = (x) => (x == null || Number.isNaN(x) ? null : Math.round(x * 10000) / 10000);

/**
 * Convert a raw billing figure into USD per minute.
 * unit: per_second | per_minute | per_clip | credits_per_second | credits_per_clip
 */
export function toPerMinute(value, unit, opts = {}) {
  if (value == null || Number.isNaN(Number(value))) return null;
  const v = Number(value);
  const creditUsd = opts.credit_usd ?? 0.005;
  const clipS = opts.clip_s ?? 0;
  const fixed = opts.fixed_per_clip ?? 0;
  switch (unit) {
    case "per_minute":
      return r4(v);
    case "per_second":
      return r4(v * 60 + (clipS ? (fixed / clipS) * 60 : 0));
    case "per_clip":
      if (!clipS) return null;
      return r4(((v + fixed) / clipS) * 60);
    case "credits_per_second":
      return r4(v * creditUsd * 60);
    case "credits_per_clip":
      if (!clipS) return null;
      return r4(((v * creditUsd + fixed) / clipS) * 60);
    default:
      return null;
  }
}

/** The number shown in the "720p / minute" column: 720p, else 768p, else null. */
export function col720(quote) {
  const pm = quote.per_min || {};
  if (pm["720p"] != null) return pm["720p"];
  if (pm["768p"] != null) return pm["768p"];
  return null;
}

export function col480(quote) {
  const pm = quote.per_min || {};
  return pm["480p"] ?? null;
}

const DAY = 86400000;

/** ISO date (YYYY-MM-DD) in UTC for a Date. */
export const isoDate = (d = new Date()) => d.toISOString().slice(0, 10);

/** Has this promo end date passed? Accepts "YYYY-MM-DD" or ISO datetime. Empty → false. */
export function promoExpired(endsAt, now = new Date()) {
  if (!endsAt) return false;
  const t = Date.parse(endsAt.length === 10 ? endsAt + "T23:59:59Z" : endsAt);
  if (Number.isNaN(t)) return false;
  return t < now.getTime();
}

export function daysUntil(endsAt, now = new Date()) {
  if (!endsAt) return null;
  const t = Date.parse(endsAt.length === 10 ? endsAt + "T23:59:59Z" : endsAt);
  if (Number.isNaN(t)) return null;
  return Math.ceil((t - now.getTime()) / DAY);
}

/** "Included" | "Off" | "May vary" | "Check setting" from a provider's free-text audio note. */
export function shortAudio(s) {
  const t = String(s || "").toLowerCase();
  if (!t) return "";
  if (/may vary/.test(t)) return "May vary";
  if (/(unspecified|unknown|not separately|no (audio|sound|native-audio) (toggle|param|setting|option|control|flag)|check setting|not stated|n\/a)/.test(t)) return "Check setting";
  if (/^\s*(off|silent|no audio|none|false|disabled|without audio|audio off)/.test(t)) return "Off";
  if (/(included|native|with audio|audio on|^on\b|^on \(|^true|enabled|yes|default true|default on|synchron)/.test(t)) return "Included";
  if (/(\boff\b|silent|no audio|without audio|disabled|false)/.test(t)) return "Off";
  return "Check setting";
}

/**
 * Recompute the cheapest quote per tracked model, plus runner-up, max and savings.
 * Only quotes with ranked !== false and a 720p-column price take part.
 */
export function computeCheapest(data) {
  const byModel = {};
  for (const q of data.quotes) {
    const p = col720(q);
    if (p == null || q.ranked === false) continue;
    (byModel[q.model_id] ||= []).push({ q, p });
  }
  const cheapest = {};
  for (const m of data.models) {
    const list = (byModel[m.id] || []).sort((a, b) => a.p - b.p);
    if (!list.length) continue;
    const best = list[0];
    const runner = list[1] || null;
    const max = list[list.length - 1];
    cheapest[m.id] = {
      quote_id: best.q.id,
      aggregator_id: best.q.aggregator_id,
      per_min_720p: best.p,
      per_min_480p: col480(best.q),
      resolution_basis: best.q.resolution_basis || "720p",
      endpoint_id: best.q.endpoint_id || "",
      model_page_url: best.q.model_page_url || best.q.source_url || "",
      audio: best.q.audio,
      audio_short: shortAudio(best.q.audio),
      max_clip_s: best.q.max_clip_s ?? m.max_clip_s ?? null,
      promo: best.q.promo?.active ? { label: best.q.promo.label, ends_at: best.q.promo.ends_at || "" } : null,
      runner_up: runner ? { quote_id: runner.q.id, aggregator_id: runner.q.aggregator_id, per_min_720p: runner.p } : null,
      max_per_min_720p: max.p,
      max_aggregator_id: max.q.aggregator_id,
      savings_pct_vs_max: list.length > 1 ? Math.round((1 - best.p / max.p) * 1000) / 10 : 0,
      n_quotes: list.length,
      checked_at: best.q.checked_at,
      confidence: best.q.confidence,
    };
  }
  return cheapest;
}

/** "sale" = dated or explicitly limited-time offer; "standing" = a permanent cut / "X% vs official". */
export function promoKind(promo) {
  if (!promo || !promo.active) return "";
  if (promo.kind === "sale" || promo.kind === "standing") return promo.kind;
  if (promo.ends_at) return "sale";
  return /sale|launch|limited|reduced|this week|until|expires/i.test(promo.label || "") ? "sale" : "standing";
}

/** Active dated or undated promotions, sorted by end date (dated first). */
export function computeDeals(data) {
  const deals = [];
  for (const q of data.quotes) {
    if (!q.promo || !q.promo.active) continue;
    deals.push({
      quote_id: q.id,
      model_id: q.model_id,
      aggregator_id: q.aggregator_id,
      kind: promoKind(q.promo),
      label: q.promo.label || "Discount",
      discount_pct: q.promo.discount_pct ?? null,
      ends_at: q.promo.ends_at || "",
      per_min_720p: col720(q),
      regular_per_min_720p: q.promo.regular_per_min?.["720p"] ?? q.promo.regular_per_min?.["768p"] ?? null,
      source_url: q.source_url,
    });
  }
  deals.sort((a, b) => {
    if (a.ends_at && !b.ends_at) return -1;
    if (!a.ends_at && b.ends_at) return 1;
    if (a.ends_at && b.ends_at) return a.ends_at.localeCompare(b.ends_at);
    return (a.per_min_720p ?? 1e9) - (b.per_min_720p ?? 1e9);
  });
  return deals;
}

/** Compact per-model feed for agents. */
export function buildCheapestFeed(data) {
  const aggs = Object.fromEntries(data.aggregators.map((a) => [a.id, a]));
  const models = Object.fromEntries(data.models.map((m) => [m.id, m]));
  const out = {
    schema_version: data.schema_version,
    site: data.site,
    generated_at: data.generated_at,
    checked_at: data.checked_at,
    unit: data.unit,
    how_to_use:
      "Look up your model by id or name, then call the aggregator listed under `aggregator` using `endpoint_id` at `api_base_url`. Prices are USD per minute of generated footage at the 720p column basis; multiply by clip_seconds/60 for a clip estimate. Re-fetch daily; check `promo.ends_at`.",
    models: {},
  };
  for (const [mid, c] of Object.entries(data.cheapest)) {
    const a = aggs[c.aggregator_id] || {};
    const m = models[mid] || {};
    out.models[mid] = {
      model: m.name,
      vendor: m.vendor || "",
      cheapest_aggregator: a.name,
      aggregator: {
        id: c.aggregator_id,
        name: a.name,
        url: a.url,
        api_base_url: a.api_base_url || "",
        api_docs_url: a.api_docs_url || "",
      },
      endpoint_id: c.endpoint_id,
      model_page_url: c.model_page_url,
      usd_per_min_720p: c.per_min_720p,
      usd_per_min_480p: c.per_min_480p,
      resolution_basis: c.resolution_basis,
      audio: c.audio_short || c.audio,
      audio_note: c.audio,
      max_clip_seconds: c.max_clip_s,
      promo: c.promo,
      runner_up: c.runner_up
        ? { aggregator: aggs[c.runner_up.aggregator_id]?.name || c.runner_up.aggregator_id, usd_per_min_720p: c.runner_up.per_min_720p }
        : null,
      most_expensive_usd_per_min_720p: c.max_per_min_720p,
      savings_pct_vs_most_expensive: c.savings_pct_vs_max,
      quotes_compared: c.n_quotes,
      checked_at: c.checked_at,
      confidence: c.confidence,
    };
  }
  return out;
}
