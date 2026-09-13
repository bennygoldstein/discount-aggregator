#!/usr/bin/env node
// Renders index.html from templates/index.template.html + data/prices.json.
// The table and matrix are pre-rendered server-side so that agents (and
// browsers without JavaScript) get the numbers from plain HTML; the charts
// are drawn client-side from the inlined JSON.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { computeCheapest, computeDeals, buildCheapestFeed, col720, col480, daysUntil } from "./lib/normalize.mjs";
import { writeSpreadsheets } from "./lib/spreadsheet.mjs";

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
  if (/may vary/.test(t)) return "May vary";
  if (/(unspecified|unknown|not separately|no (audio|sound|native-audio) (toggle|param|setting|option|control|flag)|check setting|not stated|n\/a)/.test(t)) return "Check setting";
  if (/^\s*(off|silent|no audio|none|false|disabled|without audio|audio off)/.test(t)) return "Off";
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
    const verified = !!(q?.verification && !q.verification.price?.refuted && !q.verification.comparability?.refuted);
    return `<tr data-model="${esc(m.id)}" id="m-${esc(m.id)}" data-agg="${esc(a.id)}" data-text="${esc((m.name + " " + a.name + " " + (m.vendor || "")).toLowerCase())}">
  <td class="rank" data-v="${i + 1}">${i < 3 ? `<span class="medal">${["🥇", "🥈", "🥉"][i]}</span>` : i + 1}</td>
  <td class="model" data-v="${esc(m.name)}"><a href="${esc(c.model_page_url || a.url)}" target="_blank" rel="noopener">${esc(m.name)}</a>${verified ? ' <span class="vbadge sm" title="Price and comparability re-checked by two independent verifiers">✓</span>' : ""}${flags.length ? ` <span class="flag" title="${esc(flags.join("; "))}">⚑</span>` : ""}</td>
  <td class="prov" data-v="${esc(a.name)}"><span class="swatch" data-agg="${esc(a.id)}"></span>${esc(a.name)}</td>
  <td class="num" data-v="${c.per_min_480p ?? ""}">${money(c.per_min_480p)}</td>
  <td class="num strong" data-v="${c.per_min_720p}">${money(c.per_min_720p)}${c.resolution_basis === "768p" ? '<sup title="768p, not exact 720p">768p</sup>' : ""}</td>
  <td class="num" data-v="${c.max_clip_s ?? ""}">${c.max_clip_s ?? ""}</td>
  <td title="${esc(c.audio || "")}" data-v="${esc(audioLabel(c.audio))}">${esc(audioLabel(c.audio))}</td>
  <td class="sale" data-v="${esc(saleText(q))}" title="${esc(saleText(q))}${promoEnds(c) ? " — ends " + esc(promoEnds(c)) : ""}">${esc(saleText(q).length > 42 ? saleText(q).slice(0, 40).trimEnd() + "…" : saleText(q))}${promoEnds(c) ? `<span class="ends">Sale ends ${esc(promoEnds(c))}</span>` : ""}</td>
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

// ---- history: make sure today has a snapshot, then load the series ----
const histDir = path.join(DATA, "history");
fs.mkdirSync(histDir, { recursive: true });
const today = new Date().toISOString().slice(0, 10);
const snapPath = path.join(histDir, `${today}.json`);
if (!fs.existsSync(snapPath)) {
  fs.writeFileSync(
    snapPath,
    JSON.stringify({
      date: today,
      cheapest: Object.fromEntries(Object.entries(data.cheapest).map(([m, c]) => [m, { aggregator_id: c.aggregator_id, per_min_720p: c.per_min_720p }])),
      quotes: Object.fromEntries(data.quotes.map((q) => [q.id, col720(q)])),
    }, null, 2) + "\n"
  );
}
const allDates = fs.readdirSync(histDir).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).map((f) => f.slice(0, 10)).sort();
fs.writeFileSync(path.join(histDir, "index.json"), JSON.stringify({ dates: allDates }, null, 2) + "\n");
const dates = allDates.slice(-90);
const history = dates.map((d) => {
  const s = readJson(path.join(histDir, `${d}.json`), {});
  return { date: d, cheapest: s.cheapest || {} };
});

// ---- day-over-day change per model (vs the most recent earlier snapshot) ----
const prevDate = allDates.filter((d) => d < today).slice(-1)[0] || null;
const prevSnap = prevDate ? readJson(path.join(histDir, `${prevDate}.json`), {}) : null;
const changes = {};
for (const [mid, c] of Object.entries(data.cheapest)) {
  const p = prevSnap?.cheapest?.[mid];
  if (!p || p.per_min_720p == null) continue;
  const pct = ((c.per_min_720p - p.per_min_720p) / p.per_min_720p) * 100;
  changes[mid] = { previous_date: prevDate, previous_usd_per_min_720p: p.per_min_720p, previous_aggregator_id: p.aggregator_id, change_pct: Math.round(pct * 10) / 10, provider_changed: p.aggregator_id !== c.aggregator_id };
}
// expose the deltas in the agent feed too
{
  const feedPath = path.join(DATA, "cheapest.json");
  const feed = readJson(feedPath);
  if (feed) {
    for (const [mid, ch] of Object.entries(changes)) if (feed.models[mid]) Object.assign(feed.models[mid], { previous_date: ch.previous_date, previous_usd_per_min_720p: ch.previous_usd_per_min_720p, change_pct: ch.change_pct, provider_changed: ch.provider_changed });
    feed.history_days = allDates.length;
    fs.writeFileSync(feedPath, JSON.stringify(feed, null, 2) + "\n");
  }
}

// ---- ticker items (pre-rendered so the strip works without JavaScript) ----
const tickerItems = ranked
  .map(({ m, c }) => {
    const ch = changes[m.id];
    let delta = `<span class="delta flat" title="first day of tracking">•</span>`;
    if (ch) {
      const cls = ch.change_pct > 0.5 ? "up" : ch.change_pct < -0.5 ? "down" : "flat";
      const arrow = cls === "up" ? "▲" : cls === "down" ? "▼" : "•";
      delta = `<span class="delta ${cls}" title="vs ${ch.previous_date}: ${money(ch.previous_usd_per_min_720p)}">${arrow} ${Math.abs(ch.change_pct).toFixed(1)}%</span>`;
    }
    return `<a class="tk" href="#m-${esc(m.id)}"><span class="swatch" data-agg="${esc(c.aggregator_id)}"></span><b>${esc(m.name)}</b><span class="agg">${esc(aggs[c.aggregator_id]?.name || "")}</span><span class="price">${money(c.per_min_720p)}<small>/min</small></span>${delta}</a>`;
  })
  .concat(
    data.deals.filter((d) => d.kind === "sale" && d.ends_at).map((d) => {
      const days = daysUntil(d.ends_at);
      const when = days == null ? "" : days <= 0 ? "ends today" : `${days} day${days === 1 ? "" : "s"} left`;
      return `<a class="tk deal" href="#deals"><span class="swatch" data-agg="${esc(d.aggregator_id)}"></span><b>${esc(models[d.model_id]?.name)}</b><span class="agg">${esc(d.label)} · ${esc(aggs[d.aggregator_id]?.name)}</span><span class="price">${money(d.per_min_720p)}<small>/min</small></span><span class="delta warn">⏳ ${esc(when)}</span></a>`;
    })
  )
  .join('<span class="sep">·</span>');

// ---- footnotes ----
const footnotes = (data.footnotes || []).map((f) => `<li>${esc(f)}</li>`).join("\n");

// ---- last run summary ----
const lr = data.last_run || {};
const lastRunText = lr.date
  ? `Last automatic check ${lr.date}: ${lr.checked} quotes checked, ${lr.updated} updated, ${lr.not_found} not verified, ${lr.needs_review} flagged for review.`
  : "First edition — built from a live multi-agent research pass; the daily robot takes over from here.";

// ---- verification badges, medals ----
const isVerified = (q) => !!(q?.verification && !q.verification.price?.refuted && !q.verification.comparability?.refuted);
const verifiedWinners = ranked.filter(({ c }) => isVerified(quoteById[c.quote_id])).length;
const MEDAL = ["🥇", "🥈", "🥉"];

// ---- model answer cards (one per tracked model; agent- and SEO-friendly plain-English answer) ----
const humanDate = (iso) => new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", year: "numeric" }).format(new Date(iso.length === 10 ? iso + "T12:00:00Z" : iso));
const modelCards = ranked
  .map(({ m, c }, i) => {
    const q = quoteById[c.quote_id];
    const a = aggs[c.aggregator_id];
    const all = data.quotes.filter((x) => x.model_id === m.id && col720(x) != null).sort((x, y) => col720(x) - col720(y));
    const clip = c.max_clip_s || 5;
    const clipCost = (c.per_min_720p * clip) / 60;
    const range = all.length > 1 ? `${money(col720(all[0]))}–${money(col720(all[all.length - 1]))}` : money(c.per_min_720p);
    const audio = audioLabel(c.audio).toLowerCase();
    const promo = c.promo ? ` <span class="pill-mini warn">${esc(c.promo.label)}${c.promo.ends_at ? " · ends " + esc(c.promo.ends_at.slice(0, 10)) : ""}</span>` : "";
    const chips = all
      .map((x) => `<a class="qchip${x.id === c.quote_id ? " win" : ""}${x.ranked === false ? " ex" : ""}" href="${esc(x.model_page_url || x.source_url || aggs[x.aggregator_id]?.url)}" target="_blank" rel="noopener" title="${esc(x.raw_billing_text || "")}${x.ranked === false ? " (excluded from ranking)" : ""}"><span class="swatch" data-agg="${esc(x.aggregator_id)}"></span>${esc(aggs[x.aggregator_id]?.name)} <b>${money(col720(x))}</b>${x.ranked === false ? "*" : ""}</a>`)
      .join("");
    return `<article class="mcard" id="model-${esc(m.id)}" data-model="${esc(m.id)}" data-agg="${esc(c.aggregator_id)}" data-text="${esc((m.name + " " + a.name + " " + (m.vendor || "")).toLowerCase())}">
  <div class="mcard-head"><span class="rank-badge">${i < 3 ? MEDAL[i] : "#" + (i + 1)}</span><h3>${esc(m.name)}</h3>${isVerified(q) ? '<span class="vbadge" title="Price and comparability re-checked by two independent verifiers">✓ verified</span>' : ""}</div>
  <p class="answer">As of ${esc(humanDate(c.checked_at || data.checked_at))}, the cheapest verified <b>${esc(m.name)}</b> rate is <b class="hi">${money(c.per_min_720p)}/min on ${esc(a.name)}</b> (${esc(c.resolution_basis)}, audio ${esc(audio)}), so a ${clip}-second clip costs about <b class="hi">${money(clipCost)}</b>.${all.length > 1 ? ` Across ${all.length} aggregators it runs ${range} per minute.` : " Only one aggregator quotes it."}${promo}</p>
  <div class="mstats">
    <div><b>${money(c.per_min_720p)}</b><span>per minute</span></div>
    <div><b>${money(clipCost)}</b><span>per ${clip}s clip</span></div>
    <div><b>${all.length}</b><span>aggregator${all.length === 1 ? "" : "s"}</span></div>
    <div class="wide"><b>${esc(range)}</b><span>range across aggregators</span></div>
    <div><b>${c.savings_pct_vs_max ? Math.round(c.savings_pct_vs_max) + "%" : "—"}</b><span>saved vs priciest</span></div>
  </div>
  <div class="qchips">${chips}</div>
  <div class="mlinks"><a href="${esc(c.model_page_url || a.url)}" target="_blank" rel="noopener">cheapest source ↗</a>${a.api_docs_url ? ` · <a href="${esc(a.api_docs_url)}" target="_blank" rel="noopener">${esc(a.name)} API docs ↗</a>` : ""}${c.endpoint_id ? ` · endpoint <code>${esc(c.endpoint_id)}</code>` : ""} · <span class="muted">feed id <code>${esc(m.id)}</code></span></div>
</article>`;
  })
  .join("\n");

// ---- what moved (from data/changes.json) ----
const moves = readJson(path.join(DATA, "changes.json"), []).slice(0, 14);
const moveRows = moves
  .map((ch) => {
    const d = esc(ch.date);
    const why = ch.note ? `<span class="why">${esc(ch.note)}</span>` : "";
    if (ch.field === "cheapest") return `<li><span class="mv down">▼</span><span class="d">${d}</span><span class="body"><b>${esc(ch.model)}</b> cheapest moved <span class="old">${esc(ch.old)}</span> → <b>${esc(ch.new)}</b>${why}</span></li>`;
    if (ch.field === "tracking") return `<li><span class="mv flat">●</span><span class="d">${d}</span><span class="body"><b>${esc(ch.new)}</b>${why}</span></li>`;
    if (/^per_min/.test(ch.field)) {
      const up = ch.old != null && ch.new != null && ch.new > ch.old;
      return `<li><span class="mv ${up ? "up" : "down"}">${up ? "▲" : "▼"}</span><span class="d">${d}</span><span class="body"><b>${esc(ch.model)}</b> @ ${esc(ch.aggregator)} ${esc(ch.field.replace("per_min.", ""))} <span class="old">${money(ch.old)}</span> → <b>${money(ch.new)}</b>${why}</span></li>`;
    }
    return `<li><span class="mv flat">●</span><span class="d">${d}</span><span class="body"><b>${esc(ch.model)}</b> @ ${esc(ch.aggregator)} ${esc(ch.field)}: ${esc(String(ch.old))} → ${esc(String(ch.new))}${why}</span></li>`;
  })
  .join("\n");

// ---- price index (median of the cheapest 720p rate across tracked models) ----
const medianOf = (arr) => { const s = [...arr].sort((a, b) => a - b); const n = s.length; return n ? (n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2) : null; };
const indexToday = medianOf(ranked.map(({ c }) => c.per_min_720p));
const spreadMax = ranked.filter(({ c }) => c.n_quotes > 1).map(({ m, c }) => ({ name: m.name, x: c.max_per_min_720p / c.per_min_720p })).sort((a, b) => b.x - a.x)[0] || null;

// ---- ending-soon banner ----
const soon = data.deals.filter((d) => d.kind === "sale" && d.ends_at).map((d) => ({ d, days: daysUntil(d.ends_at) })).filter((x) => x.days != null && x.days >= 0 && x.days <= 3).sort((a, b) => a.days - b.days);
const endingSoon = soon.length
  ? `<div class="banner"><span class="banner-ic">⏳</span><div><b>Ending soon:</b> ${soon.map(({ d, days }) => `${esc(models[d.model_id]?.name)} on ${esc(aggs[d.aggregator_id]?.name)} — ${esc(d.label)} at <b>${money(d.per_min_720p)}/min</b> ends ${days === 0 ? "today" : "in " + days + " day" + (days === 1 ? "" : "s")}${d.regular_per_min_720p ? ", then " + money(d.regular_per_min_720p) + "/min" : ""}`).join("; ")}.</div></div>`
  : "";

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
  TICKER_ITEMS: tickerItems,
  MODEL_CARDS: modelCards,
  MOVES: moveRows || `<li><span class="mv flat">●</span><span class="d">${esc(today)}</span><span class="body">No price moves recorded yet.</span></li>`,
  INDEX_VALUE: indexToday == null ? "—" : money(indexToday),
  SPREAD_MAX: spreadMax ? `${spreadMax.x.toFixed(1)}×` : "—",
  SPREAD_MODEL: spreadMax ? esc(spreadMax.name) : "",
  VERIFIED_WINNERS: String(verifiedWinners),
  ENDING_SOON: endingSoon,
  HISTORY_DAYS: String(allDates.length),
  HISTORY_DAYS_PLURAL: allDates.length === 1 ? "" : "s",
  DATA_JSON: jsonForScript(pageData),
  HISTORY_JSON: jsonForScript(history),
  CHANGES_JSON: jsonForScript(changes),
};
html = html.replace(/\{\{([A-Z_]+)\}\}/g, (m, k) => (k in fill ? fill[k] : m));
fs.writeFileSync(path.join(ROOT, "index.html"), html);

// spreadsheets (CSV + XLSX) — regenerated on every build so the download is always today's data
const sheets = await writeSpreadsheets({ data, ranked, aggs, models, DATA, SITE_URL, checkedHuman, changes: readJson(path.join(DATA, "changes.json"), []) });
console.log(`Spreadsheets: ${path.basename(sheets.xlsx)} (${sheets.models} models, ${sheets.quotes} quotes), prices.csv, cheapest.csv`);

// sitemap
const lastmod = (data.checked_at || data.generated_at).slice(0, 10);
const urls = ["", "data/cheapest.json", "data/prices.json", "data/cheapest.csv", "data/prices.csv", "data/discount-aggregator-aggregator.xlsx", "data/changes.json", "llms.txt"];
fs.writeFileSync(
  path.join(ROOT, "sitemap.xml"),
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map((u) => `  <url><loc>${SITE_URL}${u}</loc><lastmod>${lastmod}</lastmod><changefreq>daily</changefreq></url>`).join("\n")}\n</urlset>\n`
);
console.log(`Built index.html (${(html.length / 1024).toFixed(0)} KB), ${ranked.length} models, ${data.quotes.length} quotes, ${history.length} history days.`);
