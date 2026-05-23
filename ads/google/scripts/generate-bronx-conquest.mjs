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

// Keyword targets per ad group. Search campaigns will not serve at
// all without ≥1 enabled positive keyword per ad group — this is the
// "you don't have any enabled keywords" failure the operator hit.
//
// Strategy:
//   * a handful of EXACT match for highest-intent queries
//   * more PHRASE match for mid-intent traffic
//   * a chunk of NEGATIVE keywords to block obviously-wasted spend
//     (we deliberately block "free", "synthetic", "k2", "spice"
//     because clicks from those queries don't convert at a licensed
//     retailer and burn through the daily budget fast).
const POSITIVE_EXACT_KEYWORDS_PER_GROUP = 5;
const POSITIVE_PHRASE_KEYWORDS_PER_GROUP = 12;
const NEGATIVE_KEYWORDS_PER_GROUP = 10;

// Ad-group-level Max CPC bid (USD). Carried through for historical
// reference / fallback, but under our default Target ROAS smart-
// bidding strategy (see TARGET_ROAS_PCT below) Google Ads ignores
// per-ad-group Max CPC entirely — bids are auction-time and decided
// by the algorithm. We still emit the column so the operator can
// flip to Manual CPC in Editor without re-deriving a bid floor.
const AD_GROUP_MAX_CPC_USD = '2.00';

// Default bidding strategy: "Maximize conversion value" with a
// Target ROAS of 300% (i.e. $3 in conversion value per $1 spent).
// Operator standing rule: every new campaign we emit must be on a
// fully-automated bid strategy out of the box — Google was warning
// "Your campaign is using manual bidding. Use a fully automated
// bidding strategy to bid more efficiently." on every Manual CPC
// campaign we shipped.
//
// In Ads Editor's CSV schema (support.google.com/google-ads/editor/
// answer/94241), "Maximize conversion value WITH a target ROAS" is
// encoded as `Bid Strategy Type = Target ROAS` plus a `Target ROAS`
// column carrying the percentage (e.g. "300.00%"). The bare
// `Maximize conversion value` value is the no-target variant; we
// always want the target attached.
//
// Caveat the operator has been warned about: Smart Bidding wants
// ≥50 conversions in the trailing 30 days before it's reliable. New
// accounts may underperform until that backlog exists; switch to
// Maximize Conversions (no target) if learning stalls.
const BID_STRATEGY_TYPE = 'Target ROAS';
const TARGET_ROAS_PCT = '300.00%';

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

You ALSO generate the keyword list a Search ad group needs to
actually trigger. Without keywords, none of the ads ever serve. Per
the operator's request, generate keyword sets sized as follows:

- exactly N positive EXACT-match keywords (highest-intent: the user
  is searching for the *exact* thing we sell or for a competitor we
  want to conquest). Examples for this campaign:
    * "smoke shop bronx"           (conquest)
    * "weed delivery 10458"        (transactional intent)
    * "licensed dispensary bronx"  (high-trust intent)
- exactly M positive PHRASE-match keywords (mid-intent: queries
  containing our phrase plus modifiers). Examples:
    * "smoke shop near me"
    * "where to buy weed bronx"
    * "fordham cannabis store"
- exactly K NEGATIVE keywords (block obviously-wasted traffic and
  policy-risky queries). Examples:
    * synthetic
    * k2
    * spice
    * free weed
    * cbd only
    * jobs
    * wholesale
    * medical card

Keyword constraints you MUST follow:

- Each keyword is 1-10 words. Single-word keywords like "weed" or
  "cannabis" alone are too broad and forbidden.
- No quotes, brackets, plus signs, or other match-type symbols in
  the keyword text itself. Match type is a separate field.
- Lowercase. No punctuation. No emojis.
- Keep keywords RELEVANT to a brick-and-mortar / delivery cannabis
  retailer in 10458 conquesting recently-raided unlicensed smoke
  shop foot traffic. Don't drift into unrelated topics.

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
  ],
  "keywords": {
    "exact":    ["...", "...", ...],   // exactly N strings
    "phrase":   ["...", "...", ...],   // exactly M strings
    "negative": ["...", "...", ...]    // exactly K strings
  }
}

You will be asked for a specific number of ads and a specific
keyword set size. Each ad should pursue a DIFFERENT angle (raid
conquest, licensed-vs-illegal trust, neighborhood proximity to
10458, pricing/value, potency/lab-tested, selection breadth,
hours/convenience, loyalty/regulars). Do not duplicate angles, and
do not duplicate keywords across the exact / phrase lists.`;

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

For the keyword set, populate the JSON \`keywords\` object as:

  exact:    N = ${POSITIVE_EXACT_KEYWORDS_PER_GROUP} keywords
  phrase:   M = ${POSITIVE_PHRASE_KEYWORDS_PER_GROUP} keywords
  negative: K = ${NEGATIVE_KEYWORDS_PER_GROUP} keywords

The same keyword set will be used in every ad group across all ${Math.ceil(TARGET_AD_COUNT / MAX_ADS_PER_CAMPAIGN)}
campaigns (because they all share the same conquest theme and same
zip-${TARGET_ZIP} geo target). Maximize relevance: every keyword
should plausibly come from a Bronx 10458 user looking for a
licensed cannabis retailer or who is about to lose their unlicensed
smoke shop. Avoid generic "weed" / "cannabis" single words; favor
multi-word, location-tied or transaction-tied queries.

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

/**
 * Normalize one keyword string. Returns null if the keyword is
 * unusable (empty / too long / has match-type symbols / single word
 * that is too generic).
 *
 * "single word too generic" rule: the LLM is told to avoid bare
 * "weed" / "cannabis" / "dispensary" because they're way too broad
 * for a 10458-only campaign. We enforce that here so a sloppy LLM
 * response can't sneak them through.
 */
const TOO_GENERIC_SINGLE_WORDS = new Set([
  'weed', 'cannabis', 'marijuana', 'dispensary', 'shop', 'flower',
  'smoke', 'edibles', 'vape', 'thc', 'cbd', 'bud',
]);

function normalizeKeyword(raw) {
  if (typeof raw !== 'string') return null;
  // Strip any match-type symbols the LLM might have included
  // despite instructions ("[exact]", "\"phrase\"", "+modified").
  let s = raw.trim().replace(/^["[+]+|["\]+]+$/g, '').trim();
  s = s.replace(/[",[\]]/g, '').trim();
  s = s.toLowerCase();
  if (!s) return null;
  // Keyword length cap per Google: 80 characters or 10 words.
  if (s.length > 80) return null;
  const words = s.split(/\s+/).filter(Boolean);
  if (words.length === 0 || words.length > 10) return null;
  if (words.length === 1 && TOO_GENERIC_SINGLE_WORDS.has(words[0])) return null;
  return s;
}

function validateKeywords(rawKeywords) {
  const errs = [];
  const buckets = { exact: [], phrase: [], negative: [] };
  const seenAcrossPositive = new Set();

  for (const matchType of ['exact', 'phrase', 'negative']) {
    const list = Array.isArray(rawKeywords?.[matchType]) ? rawKeywords[matchType] : [];
    for (const raw of list) {
      const k = normalizeKeyword(raw);
      if (!k) continue;
      if (matchType !== 'negative') {
        // Reject duplicates that appear in both exact and phrase.
        if (seenAcrossPositive.has(k)) continue;
        seenAcrossPositive.add(k);
      }
      buckets[matchType].push(k);
    }
  }

  // Operator's hard requirement: at least one positive keyword,
  // else the campaign serves nothing.
  if (buckets.exact.length + buckets.phrase.length === 0) {
    errs.push(
      'KEYWORDS: LLM produced zero usable positive keywords — campaign would not serve.',
    );
  }
  // Soft warnings for "less than requested".
  if (buckets.exact.length < POSITIVE_EXACT_KEYWORDS_PER_GROUP) {
    errs.push(
      `KEYWORDS: only ${buckets.exact.length} exact-match keywords kept (asked for ${POSITIVE_EXACT_KEYWORDS_PER_GROUP}).`,
    );
  }
  if (buckets.phrase.length < POSITIVE_PHRASE_KEYWORDS_PER_GROUP) {
    errs.push(
      `KEYWORDS: only ${buckets.phrase.length} phrase-match keywords kept (asked for ${POSITIVE_PHRASE_KEYWORDS_PER_GROUP}).`,
    );
  }
  if (buckets.negative.length < NEGATIVE_KEYWORDS_PER_GROUP) {
    errs.push(
      `KEYWORDS: only ${buckets.negative.length} negative keywords kept (asked for ${NEGATIVE_KEYWORDS_PER_GROUP}).`,
    );
  }

  return { keywords: buckets, warnings: errs };
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

function buildCsvFiles(ads, keywords) {
  // Operator rule: no more than MAX_ADS_PER_CAMPAIGN RSAs per
  // campaign. Chunk the ads into N campaigns, each with its own
  // skeleton (campaign row + ad group row + location row).
  const chunks = chunkAds(ads, MAX_ADS_PER_CAMPAIGN);
  const campaignCount = chunks.length;

  // ── File 1: campaign skeletons (all N campaigns + ad groups + location) ────
  // Status convention (per oracle audit):
  //   * Campaign  = Paused  (operator flips ONE switch to launch)
  //   * Ad Group  = Enabled
  //   * Keywords  = Enabled (in keywords CSV)
  //   * Ads       = Enabled (in ads CSV)
  // That way "operator enables campaign" is the entire launch action.
  //
  // Bidding: every campaign defaults to "Maximize conversion value"
  // with Target ROAS = 300% (see BID_STRATEGY_TYPE / TARGET_ROAS_PCT).
  // Under Smart Bidding the per-ad-group Max CPC is ignored by Google;
  // we still emit it so a manual-bidding fallback is one Editor edit
  // away.
  const skeletonColumns = [
    'Campaign',
    'Ad Group',
    'Campaign Type',
    'Status',
    'Budget',
    'Budget type',
    'Bid Strategy Type',
    // Target ROAS percentage (e.g. "300.00%") — only meaningful when
    // Bid Strategy Type is "Target ROAS". See BID_STRATEGY_TYPE /
    // TARGET_ROAS_PCT constants and Editor docs answer/94241.
    'Target ROAS',
    'Networks',
    'Languages',
    'Location',
    'Max CPC',
    // Required on every new campaign since Sep 2025 (EU Political Ads
    // Regulation 2024/900). Without an explicit declaration, the Google
    // Ads API rejects mutate calls with FieldError.REQUIRED and the UI
    // surfaces "missing EU political ads declaration" warnings. We are
    // a NY cannabis retailer with zero EU political intent, so this is
    // always `false` for every campaign this generator emits. Editor
    // matches column headers case/space-insensitively, so 'EU political
    // ads' is the same as 'eupoliticalads'.
    // Ref: https://developers.google.com/google-ads/api/docs/api-policy/eu-par
    'EU political ads',
    'Comment',
  ];
  const skeletonRows = [];
  for (let ci = 0; ci < campaignCount; ci++) {
    const campaign = campaignNameFor(ci);
    const adGroup = adGroupNameFor(ci);
    skeletonRows.push({
      Campaign: campaign,
      'Campaign Type': 'Search',
      // Status policy:
      //   We import everything Enabled so the bundle is truly
      //   turn-key. The operator's previous workflow had me default
      //   to Paused "for safety review," but that meant every
      //   downstream entity that inherited or copied the Paused
      //   state became an eligibility blocker the operator had to
      //   chase. If review is desired, pause in Ads Editor before
      //   clicking Post — that's safer than leaving switches off
      //   and surprising the operator with non-serving campaigns.
      Status: 'Enabled',
      Budget: PER_CAMPAIGN_DAILY_BUDGET_USD,
      'Budget type': 'Daily',
      'Bid Strategy Type': BID_STRATEGY_TYPE,
      'Target ROAS': TARGET_ROAS_PCT,
      Networks: 'Google search',
      // ISO-639-1 'en' is what Ads Editor accepts; 'English' is
      // not always resolved in CSV import.
      Languages: 'en',
      'EU political ads': 'false',
      Comment: `Conquest campaign ${ci + 1} of ${campaignCount} (max ${MAX_ADS_PER_CAMPAIGN} RSAs/campaign). EU political ads = false (NY cannabis retailer, no EU political intent).`,
    });
    skeletonRows.push({
      Campaign: campaign,
      'Ad Group': adGroup,
      Status: 'Enabled',
      'Max CPC': AD_GROUP_MAX_CPC_USD,
      Comment: `Holds ${chunks[ci].length} RSA variant${chunks[ci].length === 1 ? '' : 's'} for campaign ${campaign}. Max CPC = $${AD_GROUP_MAX_CPC_USD}.`,
    });
    skeletonRows.push({
      Campaign: campaign,
      Location: `${TARGET_ZIP}, New York, United States`,
      Comment: `Geo restrict to zip ${TARGET_ZIP} (${TARGET_NEIGHBORHOOD}).`,
    });
  }

  // ── File 2: keywords (positive + negative, per ad group) ─────────────────
  // The "you don't have any enabled keywords" bug was caused by
  // omitting this file entirely. Every Search ad group needs ≥1
  // enabled positive keyword to serve. We attach the same keyword
  // set to every ad group across all campaigns because they all
  // share the same conquest theme.
  const keywordColumns = ['Campaign', 'Ad Group', 'Keyword', 'Match Type', 'Status'];
  const keywordRows = [];
  for (let ci = 0; ci < campaignCount; ci++) {
    const campaign = campaignNameFor(ci);
    const adGroup = adGroupNameFor(ci);
    const pushKw = (text, matchType) => {
      keywordRows.push({
        Campaign: campaign,
        'Ad Group': adGroup,
        Keyword: text,
        // "Match Type" values Ads Editor accepts: Exact, Phrase,
        // Broad. Negatives use 'Negative exact' or 'Negative phrase';
        // we use 'Negative phrase' for ad-group-level negatives so
        // the broad coverage of phrase blocking applies.
        'Match Type': matchType,
        Status: 'Enabled',
      });
    };
    for (const k of keywords.exact) pushKw(k, 'Exact');
    for (const k of keywords.phrase) pushKw(k, 'Phrase');
    for (const k of keywords.negative) pushKw(k, 'Negative phrase');
  }

  // ── File 3: ads (RSAs only, spread across the N campaigns) ───────────────
  // Uniform schema, one row per ad. Status = Enabled (the operator
  // only needs to flip the parent campaign). Headlines/Descriptions
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
        Status: 'Enabled',
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
    keywords: renderCsv(keywordColumns, keywordRows),
    ads: renderCsv(adColumns, adRows),
    notes: renderCsv(noteColumns, noteRows),
    campaignCount,
    chunks,
    keywordCounts: {
      exact: keywords.exact.length,
      phrase: keywords.phrase.length,
      negative: keywords.negative.length,
    },
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
  const keywordsB64 = Buffer.from(csvs.keywords, 'utf-8').toString('base64');
  const adsB64 = Buffer.from(csvs.ads, 'utf-8').toString('base64');
  const notesB64 = Buffer.from(csvs.notes, 'utf-8').toString('base64');
  const kwTotal = csvs.keywordCounts.exact + csvs.keywordCounts.phrase;
  const kwNegTotal = csvs.keywordCounts.negative;
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
      <dt>Keywords (per ad group)</dt><dd>${csvs.keywordCounts.exact} exact + ${csvs.keywordCounts.phrase} phrase = ${kwTotal} positive, plus ${kwNegTotal} negative</dd>
      <dt>Bidding</dt><dd>Maximize conversion value, Target ROAS ${TARGET_ROAS_PCT} (Smart Bidding — fully automated). Per-ad-group Max CPC of $${AD_GROUP_MAX_CPC_USD} is emitted for fallback only and is ignored while Target ROAS is active.</dd>
      <dt>Initial state</dt><dd>Campaigns, ad groups, keywords, and ads are <strong>all Enabled</strong>. The bundle is turn-key — clicking Post in Ads Editor launches immediately. If you want a review pass, pause in Editor before posting.</dd>
      <dt>Initial budget</dt><dd>$${PER_CAMPAIGN_DAILY_BUDGET_USD}/day <em>per campaign</em> (edit in Ads Editor before posting)</dd>
    </dl>
    <a class="download" download="01-${CAMPAIGN_BASE_NAME}-skeleton.csv"
       href="data:text/csv;base64,${skeletonB64}">⬇ 01 — ${csvs.campaignCount} Campaigns + Ad Groups + Locations (${(csvs.skeleton.length / 1024).toFixed(1)} KB)</a>
    <a class="download" download="02-${CAMPAIGN_BASE_NAME}-keywords.csv"
       href="data:text/csv;base64,${keywordsB64}">⬇ 02 — Keywords (${kwTotal} positive + ${kwNegTotal} negative per ad group, ${(csvs.keywords.length / 1024).toFixed(1)} KB)</a>
    <a class="download" download="03-${CAMPAIGN_BASE_NAME}-ads.csv"
       href="data:text/csv;base64,${adsB64}">⬇ 03 — ${ads.length} RSAs (${(csvs.ads.length / 1024).toFixed(1)} KB)</a>
    <a class="download" download="04-${CAMPAIGN_BASE_NAME}-ad-notes.csv"
       href="data:text/csv;base64,${notesB64}">⬇ 04 — Ad labels &amp; angles (reference only, ${(csvs.notes.length / 1024).toFixed(1)} KB)</a>
  </div>

  <div class="instructions">
    <h3 style="margin-top:0">How to use this in Ads Editor</h3>
    <p><strong>Important: if you've already imported a previous BronxSmokShopCon bundle,
       delete those campaigns first to avoid conflicts.</strong> In Ads Editor:
       Campaigns tab → filter <code>BronxSmokShopCon</code> → select all → Delete →
       Post. (Or just rename the previous campaigns if you want to keep historical
       data around for comparison.) Then import this bundle fresh.</p>
    <p><strong>Import files 01, 02, 03 in order. Skip 04 — it's reference only.</strong></p>
    <ol>
      <li>Download all three importable CSVs (01-skeleton, 02-keywords, 03-ads).</li>
      <li>In Google Ads Editor: <strong>Account → Import → From file…</strong> and pick file 01 first.</li>
      <li>Review &amp; post: this creates ${csvs.campaignCount} <strong>Enabled</strong> campaigns
          (<code>${csvs.chunks.map((_, i) => campaignNameFor(i)).join('</code>, <code>')}</code>),
          one Enabled ad group per campaign (Maximize conversion value @ Target ROAS ${TARGET_ROAS_PCT}; fallback Max CPC $${AD_GROUP_MAX_CPC_USD}), and the 10458 location target on each.</li>
      <li>Import file 02: this creates ${kwTotal} Enabled positive keywords + ${kwNegTotal} negatives in every ad group. <strong>Without this file the campaign serves nothing.</strong></li>
      <li>Import file 03: this creates ${ads.length} Enabled RSAs spread across the ${csvs.campaignCount} ad groups (max ${MAX_ADS_PER_CAMPAIGN} per campaign).</li>
      <li><strong>Click Post.</strong> The campaigns are live the moment Post completes — no further switches to flip.</li>
    </ol>
    <p><strong>Eligibility checklist (per oracle audit):</strong>
       ✓ Campaign Type=Search, Budget&gt;0, Bid Strategy=Target ROAS @ ${TARGET_ROAS_PCT} (Maximize conversion value), Networks=Google search, Languages=en;
       ✓ Ad Group Status=Enabled (Smart Bidding sets bids — fallback Max CPC=$${AD_GROUP_MAX_CPC_USD});
       ✓ ≥1 enabled positive keyword per ad group (we have ${kwTotal});
       ✓ ≥1 enabled RSA per ad group (each meets the 3-headline / 2-description RSA minima);
       ✓ Final URL set on every ad;
       ✓ Location targeting via zip ${TARGET_ZIP}.</p>
    <p><em>Note (also per oracle):</em> Google policy classifies recreational cannabis sales
       as a restricted vertical that may not be eligible to serve on Google Search even with
       a perfectly-structured campaign. If the campaigns import cleanly but stay
       <code>Eligible (limited)</code> or get disapproved, that is a policy issue, not a CSV issue.</p>
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
  <h3>02 — Keywords</h3>
  <pre class="csv">${escapeHtml(csvs.keywords)}</pre>
  <h3>03 — Ads (RSAs)</h3>
  <pre class="csv">${escapeHtml(csvs.ads)}</pre>
  <h3>04 — Ad notes (reference)</h3>
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
  const adWarnings = validated.flatMap((a) => a.errors);

  if (goodAds.length === 0) {
    throw new Error(`No valid ads after RSA-minima filter. Warnings:\n  - ${adWarnings.join('\n  - ')}`);
  }

  const { keywords, warnings: kwWarnings } = validateKeywords(parsed?.keywords);
  const warnings = [...adWarnings, ...kwWarnings];

  // Hard guard: refuse to emit a bundle the operator would have to
  // come back and re-fix. If the LLM produced no positive keywords,
  // the campaign cannot serve, so we fail loudly rather than ship a
  // CSV that would re-create the "no enabled keywords" complaint.
  if (keywords.exact.length + keywords.phrase.length === 0) {
    throw new Error(
      `Generator refuses to emit a bundle with zero positive keywords (would not serve).\n` +
        `LLM keyword response:\n${JSON.stringify(parsed?.keywords, null, 2)}`,
    );
  }

  console.log(
    `[bronx-conquest] LLM returned ${adsIn.length} ads; ${goodAds.length} valid; ` +
      `keywords: ${keywords.exact.length} exact + ${keywords.phrase.length} phrase + ${keywords.negative.length} negative; ` +
      `${warnings.length} warning(s)`,
  );

  const csvs = buildCsvFiles(goodAds, keywords);
  const html = buildHTML({
    ads: goodAds,
    csvs,
    generatedAt: new Date().toISOString(),
    warnings,
  });

  const skeletonPath = path.join(outDir, `${stamp}-01-${CAMPAIGN_BASE_NAME}-skeleton.csv`);
  const keywordsPath = path.join(outDir, `${stamp}-02-${CAMPAIGN_BASE_NAME}-keywords.csv`);
  const adsPath = path.join(outDir, `${stamp}-03-${CAMPAIGN_BASE_NAME}-ads.csv`);
  const notesPath = path.join(outDir, `${stamp}-04-${CAMPAIGN_BASE_NAME}-ad-notes.csv`);
  const htmlPath = path.join(outDir, `${stamp}-${CAMPAIGN_BASE_NAME}.html`);
  const jsonPath = path.join(outDir, `${stamp}-${CAMPAIGN_BASE_NAME}.json`);

  await fs.writeFile(skeletonPath, csvs.skeleton);
  await fs.writeFile(keywordsPath, csvs.keywords);
  await fs.writeFile(adsPath, csvs.ads);
  await fs.writeFile(notesPath, csvs.notes);
  await fs.writeFile(htmlPath, html);
  await fs.writeFile(jsonPath, JSON.stringify({ ads: goodAds, keywords, warnings, raw: parsed }, null, 2));

  console.log('\n✅ Done.');
  console.log(`  CSV 01 (skeleton): ${skeletonPath}`);
  console.log(`  CSV 02 (keywords): ${keywordsPath}`);
  console.log(`  CSV 03 (ads):      ${adsPath}`);
  console.log(`  CSV 04 (notes):    ${notesPath}`);
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
