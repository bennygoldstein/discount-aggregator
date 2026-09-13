#!/usr/bin/env node
// Renders index.html from templates/index.template.html + data/prices.json.
// The table and matrix are pre-rendered server-side so that agents (and
// browsers without JavaScript) get the numbers from plain HTML; the charts
// are drawn client-side from the inlined JSON.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { computeCheapest, computeDeals, buildCheapestFeed, col720, col480, daysUntil } from "./lib/normalize.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "..");
const DATA = path.join(ROOT, "data");
const readJson = (p, fb = null) => (fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : fb);

const data = readJson(path.join(DATA, "prices.json"));
if (!data) throw new Error("data/prices.json missing");
data.cheapest = computeCheapest(data);
data.deals = computeDeals(data);
data.generated_at = new Date().toISOString();
// keep the published dataset self-consistent (cheapest + deals are derived fields)
fs.writeFileSync(path.join(DATA, "prices.json"), JSON.stringify(data, null, 2) + "\n");
fs.writeFileSync(path.join(DATA, "cheapest.json"), JSON.stringify(buildCheapestFeed(data), null, 2) + "\n");

const aggs = Object.fromEntries(data.aggregators.map((a) => [a.id, a]));
const models = Object.fromEntries(data.models.map((m) => [m.id, m]));
const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const money = (v) => (v == null ? "" : "$" + (v < 10 ? v.toFixed(2) : v.toFixed(2)));
const SITE_URL = data.site?.url || "https://bennygoldstein.github.io/discount-aggregator/";

// ---- human date in New York time, like the sheet title ----
function humanET(iso) {
  const d = new Date(iso);
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", month: "long", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", hour12: true }).formatToParts(d);
  const get = (t) => parts.find((p) => p.type === t)?.value || "";
  const ampm = get("dayPeriod").toLowerCase().replace("am", "a.m.").replace("pm", "p.m.");
  return `${get("month")} ${get("day")}, ${get("year")}, ${get("hour")}:${get("minute")} ${ampm} ET`;
}
const checkedHuman = humanET(data.checked_at || data.generated_at);
const checkedDate = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", year: "numeric" }).format(new Date(data.checked_at || data.generated_at));

// ---- top table rows (cheapest per model, sorted by 720p) ----
const ranked = data.models
  .map((m) => ({ m, c: data.cheapest[m.id] }))
  .filter((x) => x.c)
  .sort((a, b) => a.c.per_min_720p - b.c.per_min_720p);

const promoEnds = (c) => (c.promo?.ends_at ? c.promo.ends_at.slice(0, 10) : "");
const saleText = (q) => {
  if (!q) return "";
  if (q.promo?.active) return q.promo.label || "Discount";
  return q.promo?.label && !q.promo.active ? "No dated sale verified" : "No dated sale verified";
};
const quoteById = Object.fromEntries(data.quotes.map((q) => [q.id, q]));
// Short audio label for the table (the full provider wording stays in the tooltip/title).
const audioLabel = (s) => {
  const t = String(s || "").toLowerCase();
  if (!t) return "";
  if (/^(included|off|silent|check setting|may vary)$/.test(t)) return s.charAt(0).toUpperCase() + s.slice(1);
  if (/^\s*(off|silent|no audio|none|false|disabled|without audio|audio off)/.test(t)) return "Off";
  if (/(may vary|unspecified|unknown|not separately|no audio toggle|no native-audio|no sound param|check setting|not stated|n\/a)/.test(t)) return /may vary/.test(t) ? "May vary" : "Check setting";
  if (/(included|native|with audio|audio on|^on\b|^on \(|^true|enabled|yes|default true|default on|synchron)/.test(t)) return "Included";
  if (/(\boff\b|silent|no audio|without audio|disabled|false)/.test(t)) return "Off";
  return "Check setting";
};

const tableRows = ranked
  .map(({ m, c }, i) => {
    const q = quoteById[c.quote_id];
    const a = aggs[c.aggregator_id];
    const flags = [];
    if (q?.needs_review) flags.push("needs review");
    if (q?.stale_days > 7) flags.push(`last verified ${q.checked_at}`);
    if (q?.confidence === "low") flags.push("low confidence");
    return `<tr data-model="${esc(m.id)}">
  <td class="rank">${i + 1}</td>
  <td class="model"><a href="${esc(c.model_page_url || a.url)}" target="_blank" rel="noopener">${esc(m.name)}</a>${flags.length ? ` <span class="flag" title="${esc(flags.join("; "))}">⚑</span>` : ""}</td>
  <td class="prov"><span class="swatch" data-agg="${esc(a.id)}"></span>${esc(a.name)}</td>
  <td class="num">${money(c.per_min_480p)}</td>
  <td class="num strong">${money(c.per_min_720p)}${c.resolution_basis === "768p" ? '<sup title="768p, not exact 720p">768p</sup>' : ""}</td>
  <td class="num">${c.max_clip_s ?? ""}</td>
  <td title="${esc(c.audio || "")}">${esc(audioLabel(c.audio))}</td>
  <td>${esc(saleText(q))}</td>
  <td>${esc(promoEnds(c))}</td>
</tr>`;
  })
  .join("\n");

// ---- aggregator list ----
const aggList = data.aggregators
  .map((a) => `<tr><td><span class="swatch" data-agg="${esc(a.id)}"></span><a href="${esc(a.url)}" target="_blank" rel="noopener">${esc(a.name)}</a></td><td class="muted">${esc(a.role || "")}</td><td><a class="muted" href="${esc(a.url)}" target="_blank" rel="noopener">${esc(a.url)}</a></td></tr>`)
  .join("\n");

// ---- matrix table (no-JS twin of the heatmap) ----
const matrixHead = data.aggregators.map((a) => `<th>${esc(a.name)}</th>`).join("");
const matrixRows = ranked
  .map(({ m, c }) => {
    const cells = data.aggregators
      .map((a) => {
        const q = data.quotes.find((x) => x.model_id === m.id && x.aggregator_id === a.id);
        const v = q ? col720(q) : null;
        if (v == null) return `<td class="num empty" title="${esc(q?.unavailable_reason || "not offered / no verifiable price")}">${q ? "n/v" : "—"}</td>`;
        const best = c.quote_id === q.id;
        return `<td class="num${best ? " best" : ""}${q.ranked === false ? " excluded" : ""}" title="${esc(q.raw_billing_text || "")}">${money(v)}${q.ranked === false ? "*" : ""}</td>`;
      })
      .join("");
    return `<tr><th class="model">${esc(m.name)}</th>${cells}</tr>`;
  })
  .join("\n");

// ---- deals (dated / limited-time sales) and standing discounts ----
const dealRow = (d) => {
    const days = daysUntil(d.ends_at);
    let when = d.ends_at ? `Ends ${d.ends_at.slice(0, 10)}` : "No published end date";
    if (days != null) when += days >= 0 ? ` (${days === 0 ? "today" : days + " day" + (days === 1 ? "" : "s") + " left"})` : " (expired)";
    return `<tr><td>${esc(models[d.model_id]?.name)}</td><td><span class="swatch" data-agg="${esc(d.aggregator_id)}"></span>${esc(aggs[d.aggregator_id]?.name)}</td><td>${esc(d.label)}</td><td class="num strong">${money(d.per_min_720p)}</td><td class="num">${money(d.regular_per_min_720p)}</td><td>${esc(when)}</td><td><a href="${esc(d.source_url)}" target="_blank" rel="noopener">source</a></td></tr>`;
};
const dealsRows = data.deals.filter((d) => d.kind === "sale").map(dealRow).join("\n");
const standingRows = data.deals.filter((d) => d.kind !== "sale").map(dealRow).join("\n");

// ---- extra models + candidate aggregators (scouted, not ranked) ----
const extraRows = (data.extra_models || [])
  .map((x) => `<tr><td>${esc(x.name)}</td><td>${esc(x.cheapest_on || "")}</td><td class="num">${money(x.per_min_720p)}</td><td>${esc(x.confidence || "")}</td><td><a href="${esc(x.evidence_url)}" target="_blank" rel="noopener">source</a></td></tr>`)
  .join("\n");
const candidateRows = (data.candidate_aggregators || [])
  .map((x) => `<tr><td><a href="${esc(x.url)}" target="_blank" rel="noopener">${esc(x.name)}</a></td><td>${esc(x.note || "")}</td><td class="num">${money(x.per_min_720p)}</td><td>${esc(x.model || "")}</td></tr>`)
  .join("\n");

// ---- history series for the page ----
const histDir = path.join(DATA, "history");
const dates = fs.existsSync(histDir) ? fs.readdirSync(histDir).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).map((f) => f.slice(0, 10)).sort().slice(-90) : [];
const history = dates.map((d) => {
  const s = readJson(path.join(histDir, `${d}.json`), {});
  return { date: d, cheapest: s.cheapest || {} };
});

// ---- footnotes ----
const footnotes = (data.footnotes || []).map((f) => `<li>${esc(f)}</li>`).join("\n");

// ---- last run summary ----
const lr = data.last_run || {};
const lastRunText = lr.date
  ? `Last automatic check ${lr.date}: ${lr.checked} quotes checked, ${lr.updated} updated, ${lr.not_found} not verified, ${lr.needs_review} flagged for review.`
  : "First edition — built from a live multi-agent research pass; the daily robot takes over from here.";

// ---- assemble ----
let html = fs.readFileSync(path.join(ROOT, "templates", "index.template.html"), "utf8");
const jsonForScript = (o) => JSON.stringify(o).replace(/<\//g, "<\\/").replace(/<!--/g, "<\\!--");
// The page only needs what it draws; the research trail, scrape notes and long verdict texts stay in data/prices.json.
const pageData = {
  ...data,
  quotes: data.quotes.map(({ research, verification, ...q }) => ({ ...q, ...(verification ? { verified: { price: !verification.price?.refuted, comparability: !verification.comparability?.refuted } } : {}) })),
  aggregators: data.aggregators.map(({ research_notes, pricing_page_urls, ...a }) => a),
  extra_models: (data.extra_models || []).map(({ note, ...x }) => x),
};
delete pageData.scrapeability;
delete pageData.promo_status_check;
delete pageData.last_run;
const fill = {
  SITE_URL,
  CHECKED_HUMAN: checkedHuman,
  CHECKED_DATE: checkedDate,
  CHECKED_ISO: data.checked_at || data.generated_at,
  BUILD_ISO: new Date().toISOString(),
  TABLE_ROWS: tableRows,
  AGG_LIST: aggList,
  AGG_COUNT: String(data.aggregators.length),
  MODEL_COUNT: String(Object.keys(data.cheapest).length),
  QUOTE_COUNT: String(data.quotes.filter((q) => col720(q) != null).length),
  MATRIX_HEAD: matrixHead,
  MATRIX_ROWS: matrixRows,
  DEALS_ROWS: dealsRows || `<tr><td colspan="7" class="muted">No dated or limited-time sale verified today.</td></tr>`,
  STANDING_ROWS: standingRows || `<tr><td colspan="7" class="muted">None recorded.</td></tr>`,
  EXTRA_ROWS: extraRows || `<tr><td colspan="5" class="muted">None recorded yet.</td></tr>`,
  CANDIDATE_ROWS: candidateRows || `<tr><td colspan="4" class="muted">None recorded yet.</td></tr>`,
  FOOTNOTES: footnotes,
  LAST_RUN: lastRunText,
  DATA_JSON: jsonForScript(pageData),
  HISTORY_JSON: jsonForScript(history),
};
html = html.replace(/\{\{([A-Z_]+)\}\}/g, (m, k) => (k in fill ? fill[k] : m));
fs.writeFileSync(path.join(ROOT, "index.html"), html);

// sitemap
fs.writeFileSync(
  path.join(ROOT, "sitemap.xml"),
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n  <url><loc>${SITE_URL}</loc><lastmod>${(data.checked_at || data.generated_at).slice(0, 10)}</lastmod><changefreq>daily</changefreq></url>\n  <url><loc>${SITE_URL}data/cheapest.json</loc><changefreq>daily</changefreq></url>\n  <url><loc>${SITE_URL}data/prices.json</loc><changefreq>daily</changefreq></url>\n  <url><loc>${SITE_URL}llms.txt</loc></url>\n</urlset>\n`
);
console.log(`Built index.html (${(html.length / 1024).toFixed(0)} KB), ${ranked.length} models, ${data.quotes.length} quotes, ${history.length} history days.`);
