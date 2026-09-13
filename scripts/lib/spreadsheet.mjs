// Daily spreadsheet exports: two CSVs (every quote / cheapest per model) and one
// Excel workbook with every table on its own sheet — for people who want to
// download it and for AI agents that read a sheet faster than a web page.

import fs from "node:fs";
import path from "node:path";
import ExcelJS from "exceljs";
import { col720, col480, promoKind, shortAudio } from "./normalize.mjs";

const csvCell = (v) => {
  if (v == null) return "";
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const toCsv = (header, rows) => [header, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";

export async function writeSpreadsheets({ data, ranked, aggs, models, DATA, SITE_URL, checkedHuman, changes = [] }) {
  const today = (data.checked_at || data.generated_at).slice(0, 10);

  // ---------- 1. cheapest per model (the "Best prices" sheet) ----------
  const bestHeader = ["rank", "model_id", "model", "vendor", "cheapest_aggregator", "aggregator_id", "usd_per_min_480p", "usd_per_min_720p", "resolution_basis", "max_clip_seconds", "audio", "sale_or_discount", "sale_ends", "runner_up_aggregator", "runner_up_usd_per_min_720p", "most_expensive_usd_per_min_720p", "savings_pct_vs_most_expensive", "aggregators_quoting", "endpoint_id", "api_base_url", "api_docs_url", "model_page_url", "verified_by_two_checkers", "checked_at", "confidence"];
  const quoteById = Object.fromEntries(data.quotes.map((q) => [q.id, q]));
  const bestRows = ranked.map(({ m, c }, i) => {
    const q = quoteById[c.quote_id] || {};
    const a = aggs[c.aggregator_id] || {};
    const verified = !!(q.verification && !q.verification.price?.refuted && !q.verification.comparability?.refuted);
    return [i + 1, m.id, m.name, m.vendor || "", a.name, c.aggregator_id, c.per_min_480p ?? "", c.per_min_720p, c.resolution_basis, c.max_clip_s ?? "", shortAudio(c.audio), q.promo?.active ? q.promo.label : "", c.promo?.ends_at ? c.promo.ends_at.slice(0, 10) : "", c.runner_up ? aggs[c.runner_up.aggregator_id]?.name : "", c.runner_up ? c.runner_up.per_min_720p : "", c.max_per_min_720p, c.savings_pct_vs_max, c.n_quotes, c.endpoint_id || "", a.api_base_url || "", a.api_docs_url || "", c.model_page_url || "", verified ? "yes" : "no", c.checked_at || "", c.confidence || ""];
  });

  // ---------- 2. every quote ----------
  const qHeader = ["quote_id", "model_id", "model", "vendor", "aggregator_id", "aggregator", "is_cheapest_for_model", "ranked", "usd_per_min_480p", "usd_per_min_720p", "usd_per_min_1080p", "resolution_basis", "usd_per_second_720p", "fixed_usd_per_clip", "clip_basis_seconds", "max_clip_seconds", "audio", "audio_note", "mode", "raw_billing_text", "promo_active", "promo_kind", "promo_label", "promo_discount_pct", "promo_ends_at", "regular_usd_per_min_720p", "endpoint_id", "model_page_url", "source_url", "checked_at", "method", "confidence", "verified_price", "verified_comparability", "needs_review", "notes"];
  const qRows = data.quotes
    .filter((q) => q.per_min && Object.keys(q.per_min).length)
    .sort((x, y) => (models[x.model_id]?.name || "").localeCompare(models[y.model_id]?.name || "") || (col720(x) ?? 1e9) - (col720(y) ?? 1e9))
    .map((q) => {
      const m = models[q.model_id] || {};
      const a = aggs[q.aggregator_id] || {};
      const best = data.cheapest[q.model_id]?.quote_id === q.id;
      return [q.id, q.model_id, m.name, m.vendor || "", q.aggregator_id, a.name, best ? "yes" : "no", q.ranked === false ? "no" : "yes", col480(q) ?? "", col720(q) ?? "", q.per_min?.["1080p"] ?? "", q.resolution_basis || "720p", q.per_second?.["720p"] ?? q.per_second?.["768p"] ?? "", q.fixed_per_clip || 0, q.clip_basis_s ?? "", q.max_clip_s ?? "", shortAudio(q.audio), q.audio || "", q.mode || "", q.raw_billing_text || "", q.promo?.active ? "yes" : "no", promoKind(q.promo), q.promo?.label || "", q.promo?.discount_pct ?? "", q.promo?.ends_at || "", q.promo?.regular_per_min?.["720p"] ?? q.promo?.regular_per_min?.["768p"] ?? "", q.endpoint_id || "", q.model_page_url || "", q.source_url || "", q.checked_at || "", q.method || "", q.confidence || "", q.verification ? (q.verification.price?.refuted ? "refuted" : "ok") : "", q.verification ? (q.verification.comparability?.refuted ? "refuted" : "ok") : "", q.needs_review ? "yes" : "no", q.notes || ""];
    });

  // ---------- 3. compare matrix ----------
  const mHeader = ["model", ...data.aggregators.map((a) => a.name), "cheapest_aggregator"];
  const mRows = ranked.map(({ m, c }) => [m.name, ...data.aggregators.map((a) => { const q = data.quotes.find((x) => x.model_id === m.id && x.aggregator_id === a.id); const v = q ? col720(q) : null; return v == null ? "" : v; }), aggs[c.aggregator_id]?.name]);

  // ---------- 4. deals ----------
  const dHeader = ["kind", "model", "aggregator", "offer", "usd_per_min_720p_now", "regular_usd_per_min_720p", "discount_pct", "ends_at", "source_url"];
  const dRows = data.deals.map((d) => [d.kind, models[d.model_id]?.name, aggs[d.aggregator_id]?.name, d.label, d.per_min_720p ?? "", d.regular_per_min_720p ?? "", d.discount_pct ?? "", d.ends_at || "", d.source_url || ""]);

  // ---------- 5. aggregators / models / changes ----------
  const aHeader = ["aggregator_id", "aggregator", "website", "api_base_url", "api_docs_url", "billing_model", "status", "role", "models_won_today"];
  const wins = Object.values(data.cheapest).reduce((acc, c) => ((acc[c.aggregator_id] = (acc[c.aggregator_id] || 0) + 1), acc), {});
  const aRows = data.aggregators.map((a) => [a.id, a.name, a.url, a.api_base_url || "", a.api_docs_url || "", a.billing_model || "", a.status || "", a.role || "", wins[a.id] || 0]);
  const moHeader = ["model_id", "model", "vendor", "spec", "max_clip_seconds", "720p_column_basis"];
  const moRows = data.models.map((m) => [m.id, m.name, m.vendor || "", m.spec || "", m.max_clip_s ?? "", m.col720_basis || "720p"]);
  const cHeader = ["date", "model", "aggregator", "field", "old", "new", "note"];
  const cRows = changes.map((ch) => [ch.date, ch.model || "", ch.aggregator || "", ch.field, ch.old ?? "", ch.new ?? "", ch.note || ""]);

  // ---------- write CSVs ----------
  const csvQuotes = path.join(DATA, "prices.csv");
  const csvCheapest = path.join(DATA, "cheapest.csv");
  fs.writeFileSync(csvQuotes, toCsv(qHeader, qRows));
  fs.writeFileSync(csvCheapest, toCsv(bestHeader, bestRows));

  // ---------- write XLSX ----------
  const wb = new ExcelJS.Workbook();
  wb.creator = "Discount Aggregator Aggregator";
  wb.created = new Date();
  wb.title = `AI video API prices across aggregators — ${today}`;

  const readme = wb.addWorksheet("README");
  readme.columns = [{ width: 110 }];
  [
    `Discount Aggregator Aggregator — AI video model prices across ${data.aggregators.length} API aggregators`,
    `Updated ${checkedHuman}. Regenerated once a day (about 06:20 America/New_York). Source: ${SITE_URL}`,
    "",
    "FOR AI AGENTS: this workbook (or data/prices.csv) holds everything on the website in one pass — read it instead of parsing the page.",
    "Unit everywhere: US dollars per MINUTE of generated video at the 720p column basis (768p for the MiniMax H3 family). Per-clip cost = usd_per_min × clip_seconds ÷ 60.",
    "",
    "Sheets:",
    "  Best prices     — one row per tracked model: the cheapest verified aggregator today, runner-up, most expensive, savings, API endpoint id.",
    "  All quotes      — every price we hold, one row per model × aggregator, with raw billing text, promo, source URL, verification and notes.",
    "  Compare 720p    — the model × aggregator matrix (USD/min); blank = not offered or no verifiable price.",
    "  Deals           — limited-time sales (kind = sale) and standing discounts (kind = standing) with end dates.",
    "  Aggregators     — the ten platforms, their API base URLs and docs, and how many models each wins today.",
    "  Models          — the tracked models and the exact tier/spec each row means.",
    "  Changes         — dated log of price moves, new winners and expired sales.",
    "",
    "Notes: 'per minute' means accumulated generated footage, not one continuous 60-second clip; max_clip_seconds is the longest single clip the endpoint allows.",
    "Token-billed models (Seedance on some providers) are estimates for 16:9 output. Provider-specific tiers (Kie.ai Veo 'Lite mode', Atlas Grok 'Developer') are separate rows on purpose.",
    "Every quote links to the provider page it was read from (source_url) and carries the date it was verified (checked_at). Verify before a large job.",
    `Machine-readable twins: ${SITE_URL}data/cheapest.json (per model), ${SITE_URL}data/prices.json (everything), ${SITE_URL}llms.txt (instructions).`,
    "Licence: CC BY 4.0 — attribution 'Discount Aggregator Aggregator'.",
  ].forEach((line, i) => {
    const row = readme.addRow([line]);
    if (i === 0) row.font = { bold: true, size: 14 };
    if (/^FOR AI AGENTS/.test(line)) row.font = { bold: true };
    row.alignment = { wrapText: true, vertical: "top" };
  });

  const addSheet = (name, header, rows, widths = {}) => {
    const ws = wb.addWorksheet(name, { views: [{ state: "frozen", ySplit: 1 }] });
    ws.columns = header.map((h) => ({ header: h, key: h, width: widths[h] || Math.min(48, Math.max(12, h.length + 4)) }));
    rows.forEach((r) => ws.addRow(r));
    ws.getRow(1).font = { bold: true };
    ws.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F2937" } };
    ws.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
    ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: header.length } };
    header.forEach((h, i) => {
      if (/usd|pct|seconds|rank|won|discount/.test(h)) ws.getColumn(i + 1).numFmt = /usd/.test(h) ? "$#,##0.00##" : "0.##";
    });
    return ws;
  };
  addSheet("Best prices", bestHeader, bestRows, { model: 26, cheapest_aggregator: 18, sale_or_discount: 34, endpoint_id: 44, api_base_url: 34, api_docs_url: 34, model_page_url: 60 });
  addSheet("All quotes", qHeader, qRows, { model: 26, aggregator: 16, raw_billing_text: 60, audio_note: 40, promo_label: 34, endpoint_id: 44, model_page_url: 60, source_url: 60, notes: 80 });
  addSheet("Compare 720p", mHeader, mRows, { model: 26 });
  addSheet("Deals", dHeader, dRows, { model: 26, offer: 48, source_url: 60 });
  addSheet("Aggregators", aHeader, aRows, { website: 44, api_base_url: 34, api_docs_url: 44, billing_model: 70, role: 50 });
  addSheet("Models", moHeader, moRows, { model: 26, vendor: 22, spec: 80 });
  addSheet("Changes", cHeader, cRows, { model: 26, note: 90, old: 22, new: 26 });

  const xlsx = path.join(DATA, "discount-aggregator-aggregator.xlsx");
  await wb.xlsx.writeFile(xlsx);
  return { csvQuotes, csvCheapest, xlsx, quotes: qRows.length, models: bestRows.length };
}
