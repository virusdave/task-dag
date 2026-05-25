import * as fs from 'node:fs/promises'
import { createHash } from 'node:crypto'

/**
 * In-process port of ads/google/scripts/convert-csv-to-snapshot.py.
 *
 * Reads a Google Ads Editor tab-separated export, filters to
 * "Responsive search ad" rows, and emits a JSONL snapshot in the
 * format the gads experiments-viz builder expects.
 *
 * Also emits a SIDECAR `<outputPath>.issues.json` summarising:
 *   - per-(campaign, ad_group) "stupid" eligibility issues
 *     (no enabled RSAs, all RSAs paused, ads without Final URL),
 *   - per-landing-page health (#ads using URL, how many are
 *     limited / disapproved, how many have specific policy_topics
 *     vs empty), with a `landing_page_issue_confidence` score that
 *     indicates how likely the URL itself (not the creative) is
 *     what's blocking serving.
 *
 * The morning pipeline reads the sidecar to:
 *   - auto-fix ad-group emptiness (CSV 006),
 *   - emit operator-facing "fix these landing pages" report
 *     (CSV 007),
 *   - tell L2 which ads NOT to repair/pause because the URL is
 *     the real problem.
 *
 * Keep behavior bit-exact with the Python version so the rest of the
 * pipeline (build-experiments-viz.py, L2/L3 analyzers) stays
 * unchanged.
 */

const APPROVAL_TO_SERVING_STATUS: Record<string, string> = {
  Approved: 'eligible',
  'Approved limited': 'eligible_limited',
  Disapproved: 'not_eligible',
  'Pending review': 'under_review',
  'Under review': 'under_review',
}

// Google Ads Editor uses several column-name variants for the same
// policy-disapproval reason data depending on export type and version.
// We probe each row for the first variant that has content, and split
// the resulting string on common delimiters ("; ", "|", ",").
const POLICY_REASON_COLUMN_NAMES = [
  'Policy Reasons',
  'Policy reasons',
  'Policy Reason',
  'Policy reason',
  'Disapproval reasons',
  'Disapproval Reasons',
  'Limitations',
  'Policy summary',
] as const

function extractPolicyTopics(row: Record<string, string>): string[] {
  for (const col of POLICY_REASON_COLUMN_NAMES) {
    const raw = (row[col] ?? '').trim()
    if (!raw) continue
    return raw
      .split(/\s*(?:;|\||\n)\s*/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
  }
  return []
}

export interface BuildSnapshotResult {
  adCount: number
  byServingStatus: Record<string, number>
  outputPath: string
  issuesPath: string
  stupidIssueCount: number
  landingPageSuspectCount: number
}

export async function buildSnapshotFromCsv(args: {
  csvPath: string
  outputPath: string
  snapshotDate: string
}): Promise<BuildSnapshotResult> {
  // Google Ads Editor's "Export selected" actually writes a UTF-16 LE
  // file with a 0xFF 0xFE BOM (despite the .csv extension and despite
  // older comments in this repo that called it "UTF-8-SIG"). Reading
  // it as UTF-8 silently produces NUL-interleaved keys
  // ('A\0d\0 \0t\0y\0p\0e\0' instead of 'Ad type'), the
  // Responsive-search-ad filter matches zero rows, the
  // "No Responsive search ad rows" guard throws, the route returns
  // 502, and the operator sees a useless 502 in the UI.
  //
  // Detect the BOM at the byte level and decode appropriately:
  //   FF FE          -> UTF-16 LE  (the actual Ads Editor format)
  //   FE FF          -> UTF-16 BE  (defensive)
  //   EF BB BF       -> UTF-8 SIG  (some hand-edited / re-saved files)
  //   anything else  -> assume UTF-8
  const bytes = await fs.readFile(args.csvPath)
  let raw: string
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    raw = new TextDecoder('utf-16le', { ignoreBOM: false }).decode(bytes)
  } else if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    raw = new TextDecoder('utf-16be', { ignoreBOM: false }).decode(bytes)
  } else if (
    bytes.length >= 3 &&
    bytes[0] === 0xef &&
    bytes[1] === 0xbb &&
    bytes[2] === 0xbf
  ) {
    raw = bytes.toString('utf-8')
  } else {
    raw = bytes.toString('utf-8')
  }
  // TextDecoder with ignoreBOM:false strips the BOM. For UTF-8 we
  // strip the U+FEFF code point manually because Buffer.toString
  // does not.
  const stripped = raw.startsWith('\ufeff') ? raw.slice(1) : raw
  const rows = parseTsv(stripped)
  const ads: SnapshotAd[] = []
  for (const row of rows) {
    if ((row['Ad type'] ?? '').trim() !== 'Responsive search ad') {
      continue
    }
    const headlines: string[] = []
    for (let i = 1; i <= 15; i++) {
      const value = (row[`Headline ${i}`] ?? '').trim()
      if (value) {
        headlines.push(value)
      }
    }
    if (headlines.length === 0) {
      continue
    }
    const descriptions: string[] = []
    for (let i = 1; i <= 5; i++) {
      const value = (row[`Description ${i}`] ?? '').trim()
      if (value) {
        descriptions.push(value)
      }
    }
    const campaign = (row['Campaign'] ?? '').trim()
    const adGroup = (row['Ad Group'] ?? '').trim()
    const status = (row['Status'] ?? '').toLowerCase()
    const approval = (row['Approval Status'] ?? '').trim()
    const servingStatus = APPROVAL_TO_SERVING_STATUS[approval] ?? 'unknown'
    const nameLower = `${campaign} ${adGroup}`.toLowerCase()
    const familyTags: Record<string, string> = {
      creative_theme: pickCreativeTheme(nameLower),
      product_tag: pickProductTag(nameLower),
    }
    const geo = pickGeoTarget(nameLower)
    if (geo) {
      familyTags['geo_target'] = geo
    }
    const metrics = {
      impressions: parseIntOr0(row['Impressions']),
      clicks: parseIntOr0(row['Clicks']),
      conversions: parseFloatOr0(row['Conversions']),
      cost: parseFloatOr0(stripCurrency(row['Cost'])),
      ctr: parsePercentOr0(row['CTR']),
      conversion_rate: parsePercentOr0(row['Conv rate']),
    }
    // Preserve the REAL numeric Google Ads ad ID from the export.
    // Ads Editor's exports use the column "Ad ID" (sometimes also
    // exported alongside "Ad ID (Old)"). The previous version of this
    // code fabricated a synthetic id like `${adGroup}-${ads.length}`
    // unconditionally, which meant every downstream CSV referring to
    // an ad by id (the pause / repair / replace batches) was emitting
    // a string Ads Editor cannot match against any real ad — so the
    // import silently no-op'd, "re-enable disapproved ads" never
    // happened, and the operator saw zero policy state changes. We
    // now use the real id when present and only fall back to the
    // synthetic placeholder when the column is missing/blank (which
    // can legitimately happen for not-yet-uploaded draft ads from an
    // Editor session, but never for production ads).
    // Verified on a real Editor export
    // (1bGypWNOMgA5fYsQrc540rB9wo62Fm4X3 / "Freshly Baked NYC++
    // 17_Campaigns+78_Ad groups+109_Asset groups+2026-05-24.csv"):
    // the ad's numeric id lives in a column literally named "ID",
    // NOT "Ad ID" / "Ad Id" — those names produced empty lookups
    // here and forced the synthetic fallback to fire on every ad.
    //
    // In practice the "All campaigns" Editor export leaves ID empty
    // for every RSA (Editor only populates it after a
    // Get-Latest-Changes round-trip the operator hasn't done). The
    // previous synthetic fallback `${adGroup}-${ads.length}` is
    // ORDER-DEPENDENT — re-exporting in a different order assigns a
    // different id to the same ad, so the LLM's recommendations
    // referenced ids that no longer pointed at anything on the next
    // run. We replace it with a STABLE sha1 over content so the same
    // RSA gets the same id across runs. Ads Editor itself matches
    // import rows by content (Campaign + Ad group + Ad type +
    // Original Headline / Description columns added by csv-generator),
    // so the synthetic id is purely an internal join key the LLM and
    // the CSV emitter use to refer to the same snapshot row.
    const realAdId = (row['ID'] ?? '').trim()
    let adId: string
    if (realAdId) {
      adId = realAdId
    } else {
      const hashInput = [
        campaign,
        adGroup,
        'rsa',
        headlines.join('\u001f'),
        descriptions.join('\u001f'),
        (row['Final URL'] as string | undefined) ?? '',
      ].join('|')
      adId = 'csyn-' + createHash('sha1').update(hashInput).digest('hex').slice(0, 16)
    }
    // The export does NOT include separate "Campaign ID" / "Ad
    // Group ID" columns (verified by inspecting the header list).
    // The campaign/ad-group identity is the human-readable name,
    // which is what Editor matches on, so we use that directly.
    ads.push({
      account_id: ((row['Customer'] ?? 'unknown') as string).trim() || 'unknown',
      campaign_id: campaign,
      campaign_name: campaign,
      ad_group_id: adGroup,
      ad_group_name: adGroup,
      ad_id: adId,
      ad_type: 'responsive_search_ad',
      ad_status: status,
      headlines,
      descriptions,
      paths: [row['Path 1'] ?? '', row['Path 2'] ?? ''],
      final_url: row['Final URL'] ?? '',
      policy_status: approval.toLowerCase().replace(/ /g, '_'),
      policy_topics: extractPolicyTopics(row),
      serving_status: servingStatus,
      metrics,
      family_tags: familyTags,
      snapshot_date: args.snapshotDate,
    })
  }
  // Refuse to ship an empty snapshot. Before this guard, a CSV that
  // produced 0 Responsive search ad rows (wrong export type, wrong
  // delimiter, header-only file, etc.) would silently overwrite the
  // existing ads-snapshot-live.jsonl with 0 bytes — the operator's
  // ingest would report success, then the morning pipeline would
  // bail with "No usable snapshot found" because pickFreshestSnapshot
  // requires size > 0.
  if (ads.length === 0) {
    throw new Error(
      `No Responsive search ad rows found in ${args.csvPath}. ` +
        `The existing snapshot was left untouched. ` +
        `Check that the Drive file is a Google Ads Editor export ` +
        `(tab-separated, with "Ad type", "Headline 1..15", "Description 1..5" columns).`,
    )
  }
  // Atomic write: stage to a sibling temp file and rename on success,
  // so a partial write or crash mid-stream can't leave a torn live
  // snapshot for the morning pipeline to choke on.
  const lines = ads.map((ad) => JSON.stringify(ad)).join('\n') + '\n'
  const tmpPath = `${args.outputPath}.${process.pid}.${Date.now()}.tmp`
  await fs.writeFile(tmpPath, lines)
  await fs.rename(tmpPath, args.outputPath)
  const byServingStatus: Record<string, number> = {}
  for (const ad of ads) {
    byServingStatus[ad.serving_status] = (byServingStatus[ad.serving_status] ?? 0) + 1
  }

  // ── Sidecar: ad-group + landing-page issues ───────────────────
  // Compute per-(campaign, ad_group) "stupid" eligibility issues
  // and per-landing-page health, writing a sibling `.issues.json`
  // file the morning pipeline reads. Separate from the JSONL so old
  // readers that ignore the sidecar stay bit-exact.
  const issues = computeSnapshotIssues(ads)
  const issuesPath = `${args.outputPath}.issues.json`
  const issuesTmp = `${issuesPath}.${process.pid}.${Date.now()}.tmp`
  await fs.writeFile(issuesTmp, JSON.stringify(issues, null, 2))
  await fs.rename(issuesTmp, issuesPath)

  return {
    adCount: ads.length,
    byServingStatus,
    outputPath: args.outputPath,
    issuesPath,
    stupidIssueCount: issues.ad_group_issues.length,
    landingPageSuspectCount: issues.landing_page_health.filter(
      (lp) => lp.landing_page_issue_confidence >= 0.5,
    ).length,
  }
}

export interface AdGroupIssue {
  campaign_name: string
  ad_group_name: string
  issue_code:
    | 'no_enabled_rsas'
    | 'all_rsas_paused'
    | 'all_rsas_disapproved'
    | 'no_rsas_at_all'
  total_rsas: number
  enabled_rsas: number
  paused_rsas: number
  removed_rsas: number
  disapproved_rsas: number
  /** ad_ids of candidate RSAs that could be enabled/repaired. */
  candidate_ad_ids: string[]
  description: string
}

export interface LandingPageHealth {
  final_url: string
  total_ads: number
  eligible_ads: number
  limited_ads: number
  disapproved_ads: number
  under_review_ads: number
  /** Ads where Google told us a specific policy_topics[] reason. */
  impaired_with_specific_topics: number
  /** Ads that are limited/disapproved but Google gave no specific
   * topic — strong signal the URL itself is the problem. */
  impaired_without_topics: number
  /** 0..1. Higher = stronger evidence the URL is the blocker. */
  landing_page_issue_confidence: number
}

export interface SnapshotIssues {
  generated_at: string
  ad_group_issues: AdGroupIssue[]
  landing_page_health: LandingPageHealth[]
}

function computeSnapshotIssues(ads: SnapshotAd[]): SnapshotIssues {
  // ── ad-group level ──
  type GroupBucket = { campaign: string; group: string; ads: SnapshotAd[] }
  const groupBuckets = new Map<string, GroupBucket>()
  for (const ad of ads) {
    const key = `${ad.campaign_name}\u001f${ad.ad_group_name}`
    let b = groupBuckets.get(key)
    if (!b) {
      b = { campaign: ad.campaign_name, group: ad.ad_group_name, ads: [] }
      groupBuckets.set(key, b)
    }
    b.ads.push(ad)
  }

  const adGroupIssues: AdGroupIssue[] = []
  for (const b of groupBuckets.values()) {
    if (!b.group) continue
    const total = b.ads.length
    const enabled = b.ads.filter((a) => a.ad_status === 'enabled').length
    const paused = b.ads.filter((a) => a.ad_status === 'paused').length
    const removed = b.ads.filter((a) => a.ad_status === 'removed').length
    const disapproved = b.ads.filter(
      (a) => a.serving_status === 'not_eligible',
    ).length

    const base = {
      campaign_name: b.campaign,
      ad_group_name: b.group,
      total_rsas: total,
      enabled_rsas: enabled,
      paused_rsas: paused,
      removed_rsas: removed,
      disapproved_rsas: disapproved,
    }

    if (total === 0) {
      // Shouldn't happen — group buckets are derived from `ads` — but
      // keep the case explicit so downstream readers don't have to
      // guess.
      adGroupIssues.push({
        ...base,
        issue_code: 'no_rsas_at_all',
        candidate_ad_ids: [],
        description:
          'Ad group has zero RSAs in the snapshot — likely a brand-new ' +
          'group whose ads never landed in the export. Needs at least one ' +
          'RSA before it can serve.',
      })
    } else if (enabled === 0 && paused > 0) {
      // The most common "no actual ads" symptom: there ARE RSAs but
      // every one is paused. We can flip one back on with a CSV row.
      adGroupIssues.push({
        ...base,
        issue_code: 'all_rsas_paused',
        candidate_ad_ids: b.ads
          .filter((a) => a.ad_status === 'paused')
          .map((a) => a.ad_id),
        description:
          'Every RSA in this ad group is paused. Pick one and re-enable ' +
          'it via the auto-fix CSV.',
      })
    } else if (enabled === 0 && total > 0) {
      // All removed, or some other non-enabled state.
      adGroupIssues.push({
        ...base,
        issue_code: 'no_enabled_rsas',
        candidate_ad_ids: b.ads.map((a) => a.ad_id),
        description:
          'No enabled RSAs in this ad group (all are removed / other ' +
          'non-enabled). Group cannot serve.',
      })
    } else if (
      enabled > 0 &&
      disapproved === enabled &&
      // Only flag when EVERY enabled ad is disapproved — a single
      // disapproved ad among many isn't an ad-group-level emergency.
      enabled >= 1
    ) {
      adGroupIssues.push({
        ...base,
        issue_code: 'all_rsas_disapproved',
        candidate_ad_ids: b.ads
          .filter((a) => a.serving_status === 'not_eligible')
          .map((a) => a.ad_id),
        description:
          'Every enabled RSA in this ad group is disapproved. The group ' +
          'serves zero impressions until at least one is repaired or ' +
          'replaced.',
      })
    }
  }

  // ── landing-page level ──
  type LpBucket = {
    url: string
    eligible: number
    limited: number
    disapproved: number
    underReview: number
    withTopics: number
    withoutTopics: number
  }
  const lpBuckets = new Map<string, LpBucket>()
  for (const ad of ads) {
    const url = (ad.final_url ?? '').trim()
    if (!url) continue
    let lp = lpBuckets.get(url)
    if (!lp) {
      lp = {
        url,
        eligible: 0,
        limited: 0,
        disapproved: 0,
        underReview: 0,
        withTopics: 0,
        withoutTopics: 0,
      }
      lpBuckets.set(url, lp)
    }
    if (ad.serving_status === 'eligible') lp.eligible++
    else if (ad.serving_status === 'eligible_limited') lp.limited++
    else if (ad.serving_status === 'not_eligible') lp.disapproved++
    else if (ad.serving_status === 'under_review') lp.underReview++

    const impaired =
      ad.serving_status === 'eligible_limited' ||
      ad.serving_status === 'not_eligible'
    if (impaired) {
      if ((ad.policy_topics?.length ?? 0) > 0) lp.withTopics++
      else lp.withoutTopics++
    }
  }

  const landingPageHealth: LandingPageHealth[] = []
  for (const lp of lpBuckets.values()) {
    const total = lp.eligible + lp.limited + lp.disapproved + lp.underReview
    const impaired = lp.limited + lp.disapproved
    // Confidence heuristic:
    //   - need ≥2 impaired ads on this URL to claim anything
    //   - confidence = impaired_without_topics / impaired_total
    //   - scaled down slightly if eligible ads exist on the same URL
    //     (because then the URL clearly CAN serve, so the impairments
    //     are more likely creative-side)
    let confidence = 0
    if (impaired >= 2) {
      const noTopicsRatio = lp.withoutTopics / Math.max(1, impaired)
      const eligibleDamping = lp.eligible > 0 ? 0.6 : 1.0
      confidence = noTopicsRatio * eligibleDamping
    }
    landingPageHealth.push({
      final_url: lp.url,
      total_ads: total,
      eligible_ads: lp.eligible,
      limited_ads: lp.limited,
      disapproved_ads: lp.disapproved,
      under_review_ads: lp.underReview,
      impaired_with_specific_topics: lp.withTopics,
      impaired_without_topics: lp.withoutTopics,
      landing_page_issue_confidence: Math.round(confidence * 100) / 100,
    })
  }
  // Sort: highest-confidence URLs first, ties broken by impaired
  // count so the operator sees the worst-bleeding pages on top.
  landingPageHealth.sort((a, b) => {
    if (b.landing_page_issue_confidence !== a.landing_page_issue_confidence) {
      return b.landing_page_issue_confidence - a.landing_page_issue_confidence
    }
    return (
      b.limited_ads +
      b.disapproved_ads -
      (a.limited_ads + a.disapproved_ads)
    )
  })

  return {
    generated_at: new Date().toISOString(),
    ad_group_issues: adGroupIssues,
    landing_page_health: landingPageHealth,
  }
}

interface SnapshotAd {
  account_id: string
  campaign_id: string
  campaign_name: string
  ad_group_id: string
  ad_group_name: string
  ad_id: string
  ad_type: string
  ad_status: string
  headlines: string[]
  descriptions: string[]
  paths: string[]
  final_url: string
  policy_status: string
  policy_topics: string[]
  serving_status: string
  metrics: {
    impressions: number
    clicks: number
    conversions: number
    cost: number
    ctr: number
    conversion_rate: number
  }
  family_tags: Record<string, string>
  snapshot_date: string
}

function pickCreativeTheme(name: string): string {
  if (name.includes('brand')) return 'brand'
  if (name.includes('promo') || name.includes('discount')) return 'promo'
  if (name.includes('local')) return 'local'
  if (name.includes('medical')) return 'medical'
  if (name.includes('core')) return 'core'
  return 'general'
}

function pickProductTag(name: string): string {
  if (name.includes('flower') || name.includes('bud')) return 'flower'
  if (name.includes('edible')) return 'edibles'
  if (name.includes('vape') || name.includes('cart')) return 'vapes'
  if (name.includes('pre-roll') || name.includes('preroll')) return 'prerolls'
  return 'general'
}

function pickGeoTarget(name: string): string | null {
  if (name.includes('midtown')) return 'midtown'
  if (name.includes('bronx')) return 'bronx'
  if (name.includes('brooklyn')) return 'brooklyn'
  if (name.includes('queens')) return 'queens'
  if (name.includes('manhattan')) return 'manhattan'
  return null
}

function parseIntOr0(v: string | undefined): number {
  const n = parseInt((v ?? '0').replace(/,/g, ''), 10)
  return Number.isFinite(n) ? n : 0
}

function parseFloatOr0(v: string | undefined): number {
  const n = parseFloat((v ?? '0').replace(/,/g, ''))
  return Number.isFinite(n) ? n : 0
}

function stripCurrency(v: string | undefined): string {
  return (v ?? '0').replace(/\$/g, '').replace(/,/g, '')
}

function parsePercentOr0(v: string | undefined): number {
  if (!v) return 0
  const n = parseFloat(v.replace(/%/g, ''))
  return Number.isFinite(n) ? n / 100 : 0
}

/**
 * Minimal TSV parser matching Python's csv.DictReader behavior for
 * the Google Ads Editor export shape (tab delimiter, optional
 * quoted fields with escaped double-quotes inside).
 */
function parseTsv(text: string): Array<Record<string, string>> {
  const rows = splitCsvRows(text, '\t')
  if (rows.length === 0) {
    return []
  }
  const header = rows[0]!
  const out: Array<Record<string, string>> = []
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i]!
    if (row.length === 1 && row[0] === '') {
      continue
    }
    const rec: Record<string, string> = {}
    for (let j = 0; j < header.length; j++) {
      rec[header[j]!] = row[j] ?? ''
    }
    out.push(rec)
  }
  return out
}

function splitCsvRows(text: string, delimiter: string): string[][] {
  const rows: string[][] = []
  let current: string[] = []
  let field = ''
  let inQuotes = false
  let i = 0
  while (i < text.length) {
    const ch = text[i]!
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i += 2
          continue
        }
        inQuotes = false
        i++
        continue
      }
      field += ch
      i++
      continue
    }
    if (ch === '"') {
      inQuotes = true
      i++
      continue
    }
    if (ch === delimiter) {
      current.push(field)
      field = ''
      i++
      continue
    }
    if (ch === '\n') {
      current.push(field)
      rows.push(current)
      current = []
      field = ''
      i++
      continue
    }
    if (ch === '\r') {
      // Swallow \r so \r\n line endings yield a single row break.
      i++
      continue
    }
    field += ch
    i++
  }
  if (field.length > 0 || current.length > 0) {
    current.push(field)
    rows.push(current)
  }
  return rows
}
