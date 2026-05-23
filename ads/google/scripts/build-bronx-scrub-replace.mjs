#!/usr/bin/env node
/**
 * Build a combined "scrub + replace" CSV bundle for BronxSmokShopCon.
 *
 * Inputs:
 *   --live <path>       UTF-8 TSV converted from the operator's Drive
 *                       export (the helios "current state" of the
 *                       BronxSmokShopCon campaigns).
 *   --new-ads <path>    The latest v* ads CSV emitted by
 *                       generate-bronx-conquest.mjs (policy-filtered).
 *   --out-dir <path>    Where to write the combined bundle.
 *
 * Output:
 *   <out-dir>/<ts>-BronxSmokShopCon-scrub-and-replace.csv
 *   <out-dir>/<ts>-BronxSmokShopCon-scrub-and-replace.html
 *
 * The combined CSV is identifiable to Ads Editor as an Ads-only
 * update: it carries Campaign + Ad Group + Ad Type + every headline
 * + every description + Status. Editor matches RSAs by content when
 * no ID is present (identifying columns are: Campaign, Ad Group, Ad
 * Type, all populated Headlines, all populated Descriptions), so
 * setting Status=Removed on a row that mirrors a live ad's headline
 * set tells Editor "delete this ad". The new ad rows have entirely
 * different headline content, so Editor treats them as additions.
 *
 * The keywords CSV from generate-bronx-conquest.mjs is unchanged
 * by this script — the keywords currently in the account are still
 * "Pending review" (normal latency) and don't need a rewrite.
 */

import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';

// ─── Argv parsing ─────────────────────────────────────────────────────────────
function parseArgs() {
  const out = { live: '', newAds: '', outDir: 'ads/google/outputs/bronx-conquest' };
  const a = process.argv.slice(2);
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '--live') out.live = a[++i];
    else if (a[i] === '--new-ads') out.newAds = a[++i];
    else if (a[i] === '--out-dir') out.outDir = a[++i];
  }
  if (!out.live || !out.newAds) {
    console.error('Usage: build-bronx-scrub-replace.mjs --live <tsv> --new-ads <csv> [--out-dir <dir>]');
    process.exit(2);
  }
  return out;
}

// ─── Minimal CSV/TSV parser ───────────────────────────────────────────────────
function parseDelimited(text, delim) {
  // RFC-4180-ish: handles quoted fields with embedded delimiters
  // and doubled quotes.
  const rows = [];
  let row = [];
  let field = '';
  let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQ = false;
      } else {
        field += c;
      }
    } else {
      if (c === '"') inQ = true;
      else if (c === delim) { row.push(field); field = ''; }
      else if (c === '\r') { /* ignore */ }
      else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
      else field += c;
    }
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

function rowsToObjects(rows) {
  if (rows.length === 0) return [];
  const hdr = rows[0];
  return rows.slice(1).filter((r) => r.length > 1 || (r.length === 1 && r[0].trim()))
    .map((r) => Object.fromEntries(hdr.map((h, i) => [h, r[i] ?? ''])));
}

// ─── CSV emitter ──────────────────────────────────────────────────────────────
function csvCell(v) {
  const s = (v ?? '').toString();
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}
function csvLine(values) { return values.map(csvCell).join(','); }

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const args = parseArgs();
  const live = await fs.readFile(args.live, 'utf-8');
  const liveRows = rowsToObjects(parseDelimited(live, '\t'));

  // Pick ad rows: rows that have an "Ad type" value (most reliable
  // discriminator for an RSA row in an Editor export with #Original
  // columns interleaved). Filter to BronxSmokShopCon.
  const liveAds = liveRows.filter((r) =>
    /BronxSmokShopCon/.test(r['Campaign'] || '') &&
    (r['Ad type'] || '').toLowerCase().includes('responsive search ad')
  );

  if (liveAds.length === 0) {
    console.error('No live RSAs found in the export — nothing to scrub.');
    process.exit(3);
  }

  // Load the new ads CSV (comma-delimited, simple).
  const newAdsRaw = await fs.readFile(args.newAds, 'utf-8');
  const newAds = rowsToObjects(parseDelimited(newAdsRaw, ','));

  // ─ Combined output columns ────────────────────────────────────────────────
  // The minimum identifying set Editor needs to match an existing RSA
  // when no ID is present is: Campaign, Ad Group, Ad Type, headlines,
  // descriptions. We also include Final URL because Editor uses it as
  // an identifying column on text/responsive ads.
  const COLS = [
    'Campaign', 'Ad Group', 'Ad Type', 'Status', 'Final URL',
    ...Array.from({ length: 15 }, (_, i) => `Headline ${i + 1}`),
    ...Array.from({ length: 4 }, (_, i) => `Description ${i + 1}`),
    'Comment',
  ];

  const outRows = [];

  // ─ Section A: remove every live RSA in the 3 campaigns ────────────────────
  for (const r of liveAds) {
    const row = {};
    for (const c of COLS) row[c] = '';
    row['Campaign'] = r['Campaign'];
    row['Ad Group'] = r['Ad Group'];
    row['Ad Type'] = 'Responsive search ad';
    row['Status'] = 'Removed';
    row['Final URL'] = r['Final URL'] || '';
    for (let i = 1; i <= 15; i++) {
      const v = (r[`Headline ${i}`] || '').trim();
      if (v) row[`Headline ${i}`] = v;
    }
    for (let i = 1; i <= 4; i++) {
      const v = (r[`Description ${i}`] || '').trim();
      if (v) row[`Description ${i}`] = v;
    }
    row['Comment'] = 'SCRUB: remove "Approved limited" ad with policy-triggering copy (THC%, $price, claim/raid/shutdown).';
    outRows.push(row);
  }

  // ─ Section B: enable the v* policy-safe replacements ─────────────────────
  for (const r of newAds) {
    const row = {};
    for (const c of COLS) row[c] = '';
    for (const c of Object.keys(r)) {
      if (COLS.includes(c)) row[c] = r[c];
    }
    row['Ad Type'] = 'Responsive search ad';
    row['Status'] = 'Enabled';
    row['Comment'] = 'REPLACE: policy-safe RSA generated by generate-bronx-conquest.mjs (POLICY_FORBIDDEN_PATTERNS filter active).';
    outRows.push(row);
  }

  // ─ Write CSV ──────────────────────────────────────────────────────────────
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  await fs.mkdir(args.outDir, { recursive: true });
  const csvPath = path.join(args.outDir, `${ts}-BronxSmokShopCon-scrub-and-replace.csv`);
  const lines = [csvLine(COLS), ...outRows.map((r) => csvLine(COLS.map((c) => r[c])))];
  await fs.writeFile(csvPath, lines.join('\n') + '\n', 'utf-8');

  // ─ Write HTML preview ─────────────────────────────────────────────────────
  const csvText = await fs.readFile(csvPath, 'utf-8');
  const b64 = Buffer.from(csvText, 'utf-8').toString('base64');
  const escHtml = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const adBlock = (r, action) => {
    const hs = Array.from({ length: 15 }, (_, i) => r[`Headline ${i + 1}`]).filter(Boolean);
    const ds = Array.from({ length: 4 }, (_, i) => r[`Description ${i + 1}`]).filter(Boolean);
    return `<div class="ad ${action}"><div class="head"><strong>${escHtml(action.toUpperCase())}</strong> · ${escHtml(r['Campaign'])} / ${escHtml(r['Ad Group'])}</div>
      <div class="hh">Headlines (${hs.length}):</div><ul>${hs.map((h) => `<li>${escHtml(h)}</li>`).join('')}</ul>
      <div class="hh">Descriptions (${ds.length}):</div><ul>${ds.map((d) => `<li>${escHtml(d)}</li>`).join('')}</ul></div>`;
  };
  const removeBlocks = outRows.filter((r) => r['Status'] === 'Removed').map((r) => adBlock(r, 'remove')).join('');
  const addBlocks = outRows.filter((r) => r['Status'] === 'Enabled').map((r) => adBlock(r, 'add')).join('');
  const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>BronxSmokShopCon — scrub & replace</title>
<style>
  body { font-family: -apple-system, system-ui, sans-serif; max-width: 880px; margin: 24px auto; padding: 0 16px; color: #222; }
  h1 { margin-bottom: 4px; } .subtitle { color: #666; margin-top: 0; }
  .download { display: inline-block; padding: 10px 14px; background: #2563eb; color: white; border-radius: 8px; text-decoration: none; font-weight: 600; margin: 8px 8px 8px 0; }
  .ad { border: 1px solid #ddd; border-radius: 8px; padding: 12px 16px; margin: 10px 0; }
  .ad.remove { background: #fff5f5; border-color: #fbb; }
  .ad.add    { background: #f3fff3; border-color: #bdf2bd; }
  .head { margin-bottom: 6px; font-size: 0.9em; color: #555; }
  .hh   { font-weight: 600; margin: 6px 0 2px; }
  ul    { margin: 4px 0 4px 18px; padding: 0; } li { margin: 1px 0; }
  pre.csv { background: #1e1e1e; color: #ddd; padding: 12px; border-radius: 8px; overflow-x: auto; font-size: 12px; max-height: 360px; }
  code { background: #eee; padding: 1px 4px; border-radius: 3px; }
  .instructions { background: #e8f4ff; border: 1px solid #b6dafd; padding: 12px 16px; border-radius: 8px; margin: 16px 0; }
</style></head><body>
<h1>BronxSmokShopCon — scrub &amp; replace</h1>
<p class="subtitle">Single import. ${outRows.filter((r) => r['Status'] === 'Removed').length} live RSAs removed, ${outRows.filter((r) => r['Status'] === 'Enabled').length} policy-safe RSAs added.</p>

<div class="instructions">
  <p><strong>How to use:</strong> download the CSV, open Ads Editor, then
  <strong>Account &rarr; Import &rarr; From file&hellip;</strong>, pick the CSV, review the
  pending changes (should show ${outRows.filter((r) => r['Status'] === 'Removed').length} ad removals + ${outRows.filter((r) => r['Status'] === 'Enabled').length} ad additions), and Post.</p>
  <p>Editor matches the existing ads by their full headline+description content (no ID column needed). Keywords, campaigns, ad groups, location targeting, bidding, and budgets are NOT touched.</p>
</div>

<a class="download" download="BronxSmokShopCon-scrub-and-replace.csv" href="data:text/csv;base64,${b64}">&darr; Download scrub-and-replace CSV (${(csvText.length / 1024).toFixed(1)} KB)</a>

<h2>Ads being removed (${outRows.filter((r) => r['Status'] === 'Removed').length})</h2>
${removeBlocks}

<h2>Ads being added (${outRows.filter((r) => r['Status'] === 'Enabled').length})</h2>
${addBlocks}

<h2>Raw CSV</h2>
<pre class="csv">${escHtml(csvText)}</pre>
</body></html>`;
  const htmlPath = csvPath.replace(/\.csv$/, '.html');
  await fs.writeFile(htmlPath, html, 'utf-8');

  console.error(`✅ Wrote ${csvPath} (${outRows.length} rows: ${outRows.filter((r) => r['Status'] === 'Removed').length} removals + ${outRows.filter((r) => r['Status'] === 'Enabled').length} additions)`);
  console.error(`✅ Wrote ${htmlPath}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
