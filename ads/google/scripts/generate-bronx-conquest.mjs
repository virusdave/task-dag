#!/usr/bin/env node
/**
 * One-off generator: BronxSmokShopCon conquest campaign.
 *
 * Builds a brand-new Google Ads campaign aimed at conquesting
 * customers of recently-raided / force-closed smoke shops around our
 * Bronx location (zip 10458). Output is:
 *
 *   - a single Ads Editor importable CSV that creates:
 *       * Campaign:  "BronxSmokShopCon"  (paused on import)
 *       * Ad group:  "BronxSmokShopCon - 10458 conquest"
 *       * RSAs:      LLM-generated, each meeting RSA minima
 *                    (>=3 headlines, >=2 descriptions; we aim for
 *                     >=10 headlines, 4 descriptions per ad)
 *   - an HTML preview that lists every generated ad, shows the CSV
 *     inline, and includes a one-click "Download CSV" button so the
 *     operator can grab the file from a phone or browser after we
 *     publish via mss-one-offs.
 *
 * Why standalone (no tsx / no helios dep)?  The existing morning-
 * bundle pipeline is built to *repair* an account snapshot; it has
 * no path to author a brand-new campaign from scratch. Plumbing one
 * through helios is a multi-day refactor and the operator needs
 * this CSV today. So we call the Bedrock Mantle endpoint directly
 * with fetch() and write the CSV by hand.
 *
 * Usage:
 *   node ads/google/scripts/generate-bronx-conquest.mjs \
 *       [--out-dir ads/google/outputs/bronx-conquest]
 */

import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';
import * as os from 'os';

// ─── Campaign spec ────────────────────────────────────────────────────────────

const CAMPAIGN_BASE_NAME = 'BronxSmokShopCon';
const AD_GROUP_SUFFIX = '10458 conquest';
const FINAL_URL = 'https://freshlybaked.us/bronx/branding/herb/0';
const TARGET_ZIP = '10458';
const TARGET_NEIGHBORHOOD = 'Fordham / Belmont, Bronx, NY';

// We generate this many distinct RSAs. Google allows up to ~50 ads
// per ad group; 8 gives the LLM enough variance for early A/B
// learnings without overwhelming the operator on review.
const TARGET_AD_COUNT = 8;

// Operator rule: no more than 3 RSAs per campaign. With 8 ads we
// spread them across ceil(8/3) = 3 campaigns. Each campaign gets
// its own ad group, location targeting, and budget.
const MAX_ADS_PER_CAMPAIGN = 3;

// Daily budget per campaign on import (Paused — operator edits
// before enabling).
const PER_CAMPAIGN_DAILY_BUDGET_USD = '20.00';

function campaignNameFor(index) {
  // 1-based: BronxSmokShopCon-01, -02, -03 …
  return `${CAMPAIGN_BASE_NAME}-${String(index + 1).padStart(2, '0')}`;
}

function adGroupNameFor(index) {
  return `${campaignNameFor(index)} - ${AD_GROUP_SUFFIX}`;
}

function chunkAds(ads, perCampaign) {
  const chunks = [];
  for (let i = 0; i < ads.length; i += perCampaign) {
    chunks.push(ads.slice(i, i + perCampaign));
  }
  return chunks;
}

// Per-ad targets.
const HEADLINES_PER_AD = 12; // RSA max is 15; 12 leaves headroom.
const DESCRIPTIONS_PER_AD = 4; // RSA max.

const HEADLINE_MAX_LEN = 30;
const DESCRIPTION_MAX_LEN = 90;

// ─── LLM credentials ──────────────────────────────────────────────────────────

function loadMantleToken() {
  const candidates = [
    '/home/amp-local/.secret/bedrock/mantle-bearer-token',
    path.join(os.homedir(), '.secret/bedrock/mantle-bearer-token'),
  ];
  for (const p of candidates) {
    try {
      return fsSync.readFileSync(p, 'utf-8').trim();
    } catch { /* try next */ }
  }
  throw new Error(
    `Bedrock Mantle token not found at any of: ${candidates.join(', ')}`,
  );
}

const LLM_ENDPOINT = 'https://bedrock-mantle.us-east-2.api.aws/v1';
// gemma works for the existing pipeline; use the same so the output
// distribution is consistent with what L2 produces today.
const LLM_MODEL = process.env.LLM_MODEL || 'google.gemma-3-27b-it';

// ─── Prompt construction ──────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a senior Google Ads copywriter for a licensed New York
cannabis retailer (Freshly Baked NYC). You generate Responsive Search
Ad (RSA) creatives that are aggressive about conquesting customers of
recently raided / shut-down unlicensed smoke shops, while staying
within Google Ads policies for licensed cannabis retail.

Hard constraints you MUST follow on every ad:

- Every headline must be <= 30 characters (Google Ads RSA limit).
- Every description must be <= 90 characters (Google Ads RSA limit).
- Output at least 12 distinct headlines per ad and exactly 4
  descriptions per ad. Do not repeat headlines within an ad.
- Do NOT make medical claims ("cures pain", "treats anxiety", etc).
- Do NOT use "lowest price", "cheapest", or unverifiable superlatives
  without a qualifier the operator can substantiate.
- Do NOT use ALL CAPS for whole headlines (you may capitalize a single
  short word like NYC or NEW).
- Do NOT use more than one exclamation point per asset.
- The retailer is LICENSED. Lean into that contrast vs raided /
  unlicensed shops. Examples of fair angles:
    * "Licensed. Tested. Open Today."
    * "Lab-tested flower, NY-licensed."
    * "Your shop closed? We're open."
    * "Open & licensed in 10458"
- You may reference the raids / shutdowns of unlicensed shops
  factually ("Shop got shut down?", "Local shop closed?") but do NOT
  defame any specific business by name and do NOT promise immunity
  from enforcement ("We'll never be raided" is too far; "Licensed,
  here to stay" is fine).
- You may include pricing/potency only with a clear qualifier the
  operator can stand behind. Prefer ranges. e.g. "3.5g from $25",
  "Lab-tested 25%+ THC". Mark any such headline with the variant
  label "claim" so the operator can edit if needed.

Output format: a single JSON object with this exact shape (no
markdown, no commentary, no extra keys):

{
  "ads": [
    {
      "label": "<short descriptive label, e.g. 'raid-conquest-1'>",
      "angle": "<one-sentence positioning>",
      "headlines": ["...", "...", ...],   // >= 12 strings, each <= 30 chars
      "descriptions": ["...", "...", "...", "..."]  // exactly 4 strings, each <= 90 chars
    },
    ...
  ]
}

You will be asked for a specific number of ads. Each ad should
pursue a DIFFERENT angle (raid conquest, licensed-vs-illegal trust,
neighborhood proximity to 10458, pricing/value, potency/lab-tested,
selection breadth, hours/convenience, loyalty/regulars). Do not
duplicate angles.`;

function buildUserPrompt() {
  return `Generate exactly ${TARGET_AD_COUNT} Responsive Search Ads for a
brand-new Google Ads campaign with the following parameters:

  Campaign base:    ${CAMPAIGN_BASE_NAME} (will be split into ${Math.ceil(TARGET_AD_COUNT / MAX_ADS_PER_CAMPAIGN)} campaigns of ≤${MAX_ADS_PER_CAMPAIGN} RSAs each)
  Ad group suffix:  ${AD_GROUP_SUFFIX}
  Geo target:       ${TARGET_NEIGHBORHOOD} (zip ${TARGET_ZIP} only)
  Landing page:     ${FINAL_URL}
  Goal:             Conquest the foot traffic of recently raided /
                    force-closed unlicensed smoke shops in 10458.
                    Make it obvious we are a *licensed* NY retailer
                    that is open, lab-tested, and a trustworthy
                    permanent option vs. the just-shuttered illegal
                    shops.

The operator explicitly requested aggressive angles in this style
(use as creative seed, not literal copy — keep within the hard
constraints in the system prompt):

  * "Shop just raided?"
  * "SmokeShop Shut Down?"
  * "Your local shop closed?"
  * "Licensed & still open."
  * "3.5g 30%+ tested ~$25"
  * "Walk-in. Lab-tested. Legal."

Each of the ${TARGET_AD_COUNT} ads should pursue a distinct angle
from the list in the system prompt. Within each ad, vary headline
lengths, calls to action, and proof points so Google's RSA engine
has real diversity to mix.

Return ONLY the JSON object specified in the system prompt.`;
}

// ─── LLM call ─────────────────────────────────────────────────────────────────

async function callLLM({ token, systemPrompt, userPrompt }) {
  const url = `${LLM_ENDPOINT}/chat/completions`;
  const body = {
    model: LLM_MODEL,
    use_case: 'gads-bronx-conquest-oneoff',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    temperature: 0.7, // high-ish for creative variety
    max_tokens: 8000,
    response_format: { type: 'json_object' },
  };
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(180_000),
  });
  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`LLM ${resp.status}: ${errText.slice(0, 500)}`);
  }
  const data = await resp.json();
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== 'string') {
    throw new Error(`LLM response missing choices[0].message.content: ${JSON.stringify(data).slice(0, 400)}`);
  }
  return content;
}

function parseLLMJson(raw) {
  // Strip ``` fences if the model added them despite response_format.
  let s = raw.trim();
  if (s.startsWith('```')) {
    s = s.replace(/^```(?:json)?\s*/i, '').replace(/```$/i, '').trim();
  }
  // Find first { and last } as a final fallback.
  const first = s.indexOf('{');
  const last = s.lastIndexOf('}');
  if (first > 0 || last < s.length - 1) {
    s = s.slice(first, last + 1);
  }
  return JSON.parse(s);
}

// ─── Validation ───────────────────────────────────────────────────────────────

const RSA_MIN_HEADLINES = 3;
const RSA_MIN_DESCRIPTIONS = 2;

function trimAndDedupe(arr, maxLen) {
  const seen = new Set();
  const out = [];
  for (const item of arr ?? []) {
    if (typeof item !== 'string') continue;
    const t = item.trim();
    if (!t) continue;
    if (t.length > maxLen) continue; // drop over-long instead of truncating
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
}

function validateAd(ad, idx) {
  const errs = [];
  const headlines = trimAndDedupe(ad.headlines, HEADLINE_MAX_LEN).slice(0, 15);
  const descriptions = trimAndDedupe(ad.descriptions, DESCRIPTION_MAX_LEN).slice(0, 4);
  if (headlines.length < RSA_MIN_HEADLINES) {
    errs.push(`ad #${idx + 1} (${ad.label || 'unlabelled'}): only ${headlines.length} valid headlines, need >=${RSA_MIN_HEADLINES}`);
  }
  if (descriptions.length < RSA_MIN_DESCRIPTIONS) {
    errs.push(`ad #${idx + 1} (${ad.label || 'unlabelled'}): only ${descriptions.length} valid descriptions, need >=${RSA_MIN_DESCRIPTIONS}`);
  }
  return {
    label: (ad.label || `ad-${idx + 1}`).toString().trim() || `ad-${idx + 1}`,
    angle: (ad.angle || '').toString().trim(),
    headlines,
    descriptions,
    errors: errs,
  };
}

// ─── CSV emission ─────────────────────────────────────────────────────────────

function csvEscape(v) {
  const s = v == null ? '' : String(v);
  if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

/**
 * Build CSV(s) for Ads Editor import.
 *
 * History / why we split:
 *   The previous version of this script emitted a single mixed-entity
 *   CSV with column names like "Ad status" / "Ad group status" /
 *   "Campaign status". Ads Editor's importer only recognizes the
 *   column name "Status" on each row, and it determines entity type
 *   heuristically from which other columns are populated. With our
 *   bespoke per-entity status columns, the ad rows came in with no
 *   recognizable status and Editor silently dropped them — the
 *   campaign and ad group were created but the ad group had zero
 *   ads in it. That's the "your ad group contains no ads" bug.
 *
 *   Two changes fix it:
 *     1. Every status cell goes into a single column named exactly
 *        "Status". Editor recognizes this on Campaign, Ad Group, and
 *        Ad rows.
 *     2. We split the bundle into THREE small CSVs, each containing
 *        rows of a single entity type. Mixed-entity CSVs are fragile
 *        because Editor uses column population as its entity-type
 *        heuristic and a sparsely-populated row can be misclassified.
 *        Numbered imports also match the operator's existing
 *        "import 001..005 in order" workflow.
 *
 *   We also switch "Ad group" → "Ad Group" (capital G) to match the
 *   column header Editor's own exports use (see
 *   ads/google/scripts/convert-csv-to-snapshot.py which reads real
 *   exports using exactly "Ad Group").
 */

function buildCsvFiles(ads) {
  // Operator rule: no more than MAX_ADS_PER_CAMPAIGN RSAs per
  // campaign. Chunk the ads into N campaigns, each with its own
  // skeleton (campaign row + ad group row + location row).
  const chunks = chunkAds(ads, MAX_ADS_PER_CAMPAIGN);
  const campaignCount = chunks.length;

  // ── File 1: campaign skeletons (all N campaigns + ad groups + location) ────
  const skeletonColumns = [
    'Campaign',
    'Ad Group',
    'Campaign Type',
    'Status',
    'Budget',
    'Budget type',
    'Bid Strategy Type',
    'Networks',
    'Languages',
    'Location',
    'Comment',
  ];
  const skeletonRows = [];
  for (let ci = 0; ci < campaignCount; ci++) {
    const campaign = campaignNameFor(ci);
    const adGroup = adGroupNameFor(ci);
    skeletonRows.push({
      Campaign: campaign,
      'Campaign Type': 'Search',
      Status: 'Paused',
      Budget: PER_CAMPAIGN_DAILY_BUDGET_USD,
      'Budget type': 'Daily',
      'Bid Strategy Type': 'Manual CPC',
      Networks: 'Google search',
      Languages: 'English',
      Comment: `Conquest campaign ${ci + 1} of ${campaignCount} (max ${MAX_ADS_PER_CAMPAIGN} RSAs/campaign).`,
    });
    skeletonRows.push({
      Campaign: campaign,
      'Ad Group': adGroup,
      Status: 'Enabled',
      Comment: `Holds ${chunks[ci].length} RSA variant${chunks[ci].length === 1 ? '' : 's'} for campaign ${campaign}.`,
    });
    skeletonRows.push({
      Campaign: campaign,
      Location: `${TARGET_ZIP}, New York, United States`,
      Comment: `Geo restrict to zip ${TARGET_ZIP} (${TARGET_NEIGHBORHOOD}).`,
    });
  }

  // ── File 2: ads (RSAs only, spread across the N campaigns) ───────────────
  // Uniform schema, one row per ad. Status = Paused so the operator
  // can verify in Editor before they go live. Headlines/Descriptions
  // use Editor's documented "Headline N" / "Description N" naming;
  // unused columns are dropped below.
  const adColumns = [
    'Campaign',
    'Ad Group',
    'Ad Type',
    'Status',
    'Final URL',
    ...Array.from({ length: 15 }, (_, i) => `Headline ${i + 1}`),
    ...Array.from({ length: 4 }, (_, i) => `Description ${i + 1}`),
    'Path 1',
    'Path 2',
  ];
  const adRows = [];
  for (let ci = 0; ci < campaignCount; ci++) {
    const campaign = campaignNameFor(ci);
    const adGroup = adGroupNameFor(ci);
    for (const ad of chunks[ci]) {
      const row = {
        Campaign: campaign,
        'Ad Group': adGroup,
        'Ad Type': 'Responsive search ad',
        Status: 'Paused',
        'Final URL': FINAL_URL,
        'Path 1': '',
        'Path 2': '',
      };
      ad.headlines.forEach((h, i) => {
        row[`Headline ${i + 1}`] = h;
      });
      ad.descriptions.forEach((d, i) => {
        row[`Description ${i + 1}`] = d;
      });
      adRows.push(row);
    }
  }

  // ── File 3: ad-level labels (Comment metadata) ────────────────────────
  // Separated because it's purely informational — operator doesn't
  // have to import it. We still emit so the per-ad angle / hypothesis
  // travels with the bundle.
  const noteColumns = ['Campaign', 'Ad Group', 'Ad Label', 'Angle'];
  const noteRows = [];
  for (let ci = 0; ci < campaignCount; ci++) {
    const campaign = campaignNameFor(ci);
    const adGroup = adGroupNameFor(ci);
    for (const ad of chunks[ci]) {
      noteRows.push({
        Campaign: campaign,
        'Ad Group': adGroup,
        'Ad Label': ad.label,
        Angle: ad.angle,
      });
    }
  }

  return {
    skeleton: renderCsv(skeletonColumns, skeletonRows),
    ads: renderCsv(adColumns, adRows),
    notes: renderCsv(noteColumns, noteRows),
    campaignCount,
    chunks,
  };
}

function renderCsv(columns, rows) {
  // Drop columns no row populates — keeps the CSV narrow and avoids
  // Editor seeing unexpected empty columns.
  const used = new Set();
  for (const r of rows) {
    for (const k of Object.keys(r)) {
      if (r[k] != null && String(r[k]).trim() !== '') used.add(k);
    }
  }
  const finalCols = columns.filter((c) => used.has(c));
  const lines = [finalCols.map(csvEscape).join(',')];
  for (const r of rows) {
    lines.push(finalCols.map((c) => csvEscape(r[c] ?? '')).join(','));
  }
  return lines.join('\n') + '\n';
}

// ─── HTML preview ─────────────────────────────────────────────────────────────

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function buildHTML({ ads, csvs, generatedAt, warnings }) {
  // base64 each CSV so the download buttons work on a phone without
  // any server-side endpoint.
  const skeletonB64 = Buffer.from(csvs.skeleton, 'utf-8').toString('base64');
  const adsB64 = Buffer.from(csvs.ads, 'utf-8').toString('base64');
  const notesB64 = Buffer.from(csvs.notes, 'utf-8').toString('base64');
  // Show ads grouped by their assigned campaign so the operator can
  // see at a glance which RSA lands in which campaign.
  const adBlocks = csvs.chunks.map((chunk, ci) => `
    <h3 style="margin-top:24px">Campaign <code>${escapeHtml(campaignNameFor(ci))}</code> (${chunk.length} RSA${chunk.length === 1 ? '' : 's'})</h3>
    ${chunk.map((ad, ai) => `
      <section class="ad">
        <h3>Ad ${ai + 1}: ${escapeHtml(ad.label)}</h3>
        <p class="angle"><em>${escapeHtml(ad.angle)}</em></p>
        <h4>Headlines (${ad.headlines.length})</h4>
        <ol>
          ${ad.headlines.map((h) => `<li>${escapeHtml(h)} <span class="len">(${h.length})</span></li>`).join('')}
        </ol>
        <h4>Descriptions (${ad.descriptions.length})</h4>
        <ol>
          ${ad.descriptions.map((d) => `<li>${escapeHtml(d)} <span class="len">(${d.length})</span></li>`).join('')}
        </ol>
      </section>
    `).join('\n')}
  `).join('\n');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>${CAMPAIGN_BASE_NAME} — Ads Editor bundle</title>
<meta name="viewport" content="width=device-width, initial-scale=1" />
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
         max-width: 920px; margin: 24px auto; padding: 0 16px; line-height: 1.5;
         color: #222; background: #fafafa; }
  h1 { margin-bottom: 4px; }
  .subtitle { color: #666; margin-top: 0; }
  .summary { background: #fff; border: 1px solid #ddd; padding: 12px 16px;
             border-radius: 8px; margin: 16px 0; }
  .summary dt { font-weight: 600; color: #444; }
  .summary dd { margin: 0 0 8px 0; }
  .download { display: inline-block; background: #2b6cb0; color: #fff;
              padding: 10px 18px; border-radius: 6px; text-decoration: none;
              font-weight: 600; margin: 8px 0; }
  .download:hover { background: #1e4e8c; }
  .warnings { background: #fff8e1; border: 1px solid #fbc02d; padding: 12px 16px;
              border-radius: 8px; margin: 16px 0; }
  .ad { background: #fff; border: 1px solid #ddd; padding: 16px;
        border-radius: 8px; margin-bottom: 16px; }
  .ad h3 { margin-top: 0; }
  .ad .angle { color: #555; }
  .len { color: #888; font-size: 0.85em; }
  pre.csv { background: #1e1e1e; color: #ddd; padding: 12px;
            border-radius: 8px; overflow-x: auto; font-size: 12px;
            max-height: 320px; }
  .instructions { background: #e8f4ff; border: 1px solid #b6dafd;
                  padding: 12px 16px; border-radius: 8px; margin: 16px 0; }
  code { background: #eee; padding: 1px 4px; border-radius: 3px; }
</style>
</head>
<body>
  <h1>${CAMPAIGN_BASE_NAME}</h1>
  <p class="subtitle">Brand-new conquest campaign for zip ${TARGET_ZIP} —
     generated ${escapeHtml(generatedAt)}</p>

  <div class="summary">
    <dl>
      <dt>Campaigns</dt><dd>${csvs.campaignCount} campaigns (max ${MAX_ADS_PER_CAMPAIGN} RSAs each):<ul style="margin:4px 0">${
        csvs.chunks.map((chunk, i) => `<li><code>${escapeHtml(campaignNameFor(i))}</code> → ${chunk.length} RSA${chunk.length === 1 ? '' : 's'}</li>`).join('')
      }</ul></dd>
      <dt>Geo target</dt><dd>Zip ${TARGET_ZIP} (${escapeHtml(TARGET_NEIGHBORHOOD)}) — applied to every campaign</dd>
      <dt>Landing page</dt><dd><a href="${escapeHtml(FINAL_URL)}">${escapeHtml(FINAL_URL)}</a></dd>
      <dt>Ad count</dt><dd>${ads.length} RSAs total (each ≥${RSA_MIN_HEADLINES} headlines, ≥${RSA_MIN_DESCRIPTIONS} descriptions)</dd>
      <dt>Initial state</dt><dd>Campaigns + ads imported <strong>Paused</strong> so you can review in Ads Editor before posting changes.</dd>
      <dt>Initial budget</dt><dd>$${PER_CAMPAIGN_DAILY_BUDGET_USD}/day <em>per campaign</em> (edit in Ads Editor before enabling)</dd>
    </dl>
    <a class="download" download="01-${CAMPAIGN_BASE_NAME}-skeleton.csv"
       href="data:text/csv;base64,${skeletonB64}">⬇ 01 — ${csvs.campaignCount} Campaigns + Ad Groups + Locations (${(csvs.skeleton.length / 1024).toFixed(1)} KB)</a>
    <a class="download" download="02-${CAMPAIGN_BASE_NAME}-ads.csv"
       href="data:text/csv;base64,${adsB64}">⬇ 02 — ${ads.length} RSAs (${(csvs.ads.length / 1024).toFixed(1)} KB)</a>
    <a class="download" download="03-${CAMPAIGN_BASE_NAME}-ad-notes.csv"
       href="data:text/csv;base64,${notesB64}">⬇ 03 — Ad labels &amp; angles (reference only, ${(csvs.notes.length / 1024).toFixed(1)} KB)</a>
  </div>

  <div class="instructions">
    <h3 style="margin-top:0">How to use this in Ads Editor</h3>
    <p><strong>Import the two CSVs in order. Skip the third — it's reference only.</strong></p>
    <ol>
      <li>Download <code>01-${CAMPAIGN_BASE_NAME}-skeleton.csv</code> and <code>02-${CAMPAIGN_BASE_NAME}-ads.csv</code>.</li>
      <li>In Google Ads Editor: <strong>Account → Import → From file…</strong> and pick file 01 first.</li>
      <li>Review &amp; post: this creates ${csvs.campaignCount} Paused campaigns
          (<code>${csvs.chunks.map((_, i) => campaignNameFor(i)).join('</code>, <code>')}</code>),
          one ad group per campaign, and the 10458 location target on each.</li>
      <li>Import file 02 next: this creates ${ads.length} Paused RSAs spread
          across the ${csvs.campaignCount} ad groups (max ${MAX_ADS_PER_CAMPAIGN} per campaign).</li>
      <li>Verify budget &amp; targeting on each campaign, then toggle to Enabled when ready.</li>
    </ol>
    <p>The split into ${csvs.campaignCount} campaigns honors the operator rule of
       ≤${MAX_ADS_PER_CAMPAIGN} RSAs per campaign. The per-entity CSV split (skeleton
       vs ads) avoids the "your ad group contains no ads" failure from earlier
       bundles, which was caused by mixing entity types in one CSV with bespoke
       per-entity status columns Ads Editor didn't recognize.</p>
  </div>

  ${warnings.length === 0 ? '' : `
  <div class="warnings">
    <h3 style="margin-top:0">⚠ Generator warnings (${warnings.length})</h3>
    <ul>${warnings.map((w) => `<li>${escapeHtml(w)}</li>`).join('')}</ul>
  </div>`}

  <h2>Generated ads (${ads.length})</h2>
  ${adBlocks}

  <h2>Raw CSV previews</h2>
  <h3>01 — Campaign skeleton</h3>
  <pre class="csv">${escapeHtml(csvs.skeleton)}</pre>
  <h3>02 — Ads (RSAs)</h3>
  <pre class="csv">${escapeHtml(csvs.ads)}</pre>
  <h3>03 — Ad notes (reference)</h3>
  <pre class="csv">${escapeHtml(csvs.notes)}</pre>
</body>
</html>
`;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { outDir: 'ads/google/outputs/bronx-conquest' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out-dir' && i + 1 < argv.length) {
      args.outDir = argv[i + 1];
      i++;
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = path.resolve(args.outDir);
  await fs.mkdir(outDir, { recursive: true });

  console.log(`[bronx-conquest] target ad count: ${TARGET_AD_COUNT}`);
  console.log(`[bronx-conquest] output dir: ${outDir}`);

  const token = loadMantleToken();
  console.log(`[bronx-conquest] calling ${LLM_MODEL} at ${LLM_ENDPOINT}…`);

  const raw = await callLLM({
    token,
    systemPrompt: SYSTEM_PROMPT,
    userPrompt: buildUserPrompt(),
  });

  let parsed;
  try {
    parsed = parseLLMJson(raw);
  } catch (e) {
    const dumpPath = path.join(outDir, `${stamp}-llm-raw.txt`);
    await fs.writeFile(dumpPath, raw);
    throw new Error(`LLM returned non-JSON (dumped to ${dumpPath}): ${e.message}`);
  }

  const adsIn = Array.isArray(parsed?.ads) ? parsed.ads : [];
  if (adsIn.length === 0) {
    throw new Error(`LLM returned no ads. Raw: ${JSON.stringify(parsed).slice(0, 400)}`);
  }

  const validated = adsIn.map((a, i) => validateAd(a, i));
  const goodAds = validated.filter((a) => a.errors.length === 0);
  const warnings = validated.flatMap((a) => a.errors);

  if (goodAds.length === 0) {
    throw new Error(`No valid ads after RSA-minima filter. Warnings:\n  - ${warnings.join('\n  - ')}`);
  }

  console.log(`[bronx-conquest] LLM returned ${adsIn.length} ads; ${goodAds.length} valid, ${warnings.length} warning(s)`);

  const csvs = buildCsvFiles(goodAds);
  const html = buildHTML({
    ads: goodAds,
    csvs,
    generatedAt: new Date().toISOString(),
    warnings,
  });

  const skeletonPath = path.join(outDir, `${stamp}-01-${CAMPAIGN_BASE_NAME}-skeleton.csv`);
  const adsPath = path.join(outDir, `${stamp}-02-${CAMPAIGN_BASE_NAME}-ads.csv`);
  const notesPath = path.join(outDir, `${stamp}-03-${CAMPAIGN_BASE_NAME}-ad-notes.csv`);
  const htmlPath = path.join(outDir, `${stamp}-${CAMPAIGN_BASE_NAME}.html`);
  const jsonPath = path.join(outDir, `${stamp}-${CAMPAIGN_BASE_NAME}.json`);

  await fs.writeFile(skeletonPath, csvs.skeleton);
  await fs.writeFile(adsPath, csvs.ads);
  await fs.writeFile(notesPath, csvs.notes);
  await fs.writeFile(htmlPath, html);
  await fs.writeFile(jsonPath, JSON.stringify({ ads: goodAds, warnings, raw: parsed }, null, 2));

  console.log('\n✅ Done.');
  console.log(`  CSV 01 (skeleton): ${skeletonPath}`);
  console.log(`  CSV 02 (ads):      ${adsPath}`);
  console.log(`  CSV 03 (notes):    ${notesPath}`);
  console.log(`  HTML:              ${htmlPath}`);
  console.log(`  JSON:              ${jsonPath}`);
  if (warnings.length > 0) {
    console.log('\n⚠ Warnings:');
    for (const w of warnings) console.log(`  - ${w}`);
  }
}

main().catch((err) => {
  console.error('generate-bronx-conquest.mjs: fatal error');
  console.error(err?.stack || err?.message || err);
  process.exit(1);
});
