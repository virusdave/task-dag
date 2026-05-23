import * as fs from 'node:fs/promises'

/**
 * In-process port of ads/google/scripts/convert-csv-to-snapshot.py.
 *
 * Reads a Google Ads Editor tab-separated export, filters to
 * "Responsive search ad" rows, and emits a JSONL snapshot in the
 * format the gads experiments-viz builder expects.
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

export interface BuildSnapshotResult {
  adCount: number
  byServingStatus: Record<string, number>
  outputPath: string
}

export async function buildSnapshotFromCsv(args: {
  csvPath: string
  outputPath: string
  snapshotDate: string
}): Promise<BuildSnapshotResult> {
  const raw = await fs.readFile(args.csvPath, 'utf-8')
  // Ads Editor exports as UTF-8-SIG (with BOM). strip a leading BOM
  // so the first header key isn't '\ufeffCampaign' (which silently
  // produced campaign-name-less snapshots before the python fix).
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
    const realAdId = (row['Ad ID'] ?? row['Ad Id'] ?? row['Ad id'] ?? '').trim()
    const adId = realAdId || `${adGroup}-${ads.length}`
    // Same fix for campaign/ad-group IDs — Editor exports include
    // "Campaign ID" and "Ad Group ID" alongside the human-readable
    // names. The downstream pause/repair CSVs need at least the
    // human-readable name to match (since Editor matches on name
    // when the id column is absent), but preserving the real id
    // when available lets future work address ads by numeric id.
    const realCampaignId = (row['Campaign ID'] ?? row['Campaign Id'] ?? '').trim()
    const realAdGroupId = (row['Ad Group ID'] ?? row['Ad group ID'] ?? row['Ad Group Id'] ?? '').trim()
    ads.push({
      account_id: ((row['Customer ID'] ?? row['Customer'] ?? 'unknown') as string).trim() || 'unknown',
      campaign_id: realCampaignId || campaign,
      campaign_name: campaign,
      ad_group_id: realAdGroupId || adGroup,
      ad_group_name: adGroup,
      ad_id: adId,
      ad_type: 'responsive_search_ad',
      ad_status: status,
      headlines,
      descriptions,
      paths: [row['Path 1'] ?? '', row['Path 2'] ?? ''],
      final_url: row['Final URL'] ?? '',
      policy_status: approval.toLowerCase().replace(/ /g, '_'),
      policy_topics: [],
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
  return { adCount: ads.length, byServingStatus, outputPath: args.outputPath }
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
