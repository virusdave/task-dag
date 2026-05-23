/**
 * Per-ad attempt-history "feedback loop" glue for the Google Ads
 * morning pipeline. Three jobs:
 *
 *  1. preparePolicyExperiences(snapshotPath) — read the snapshot,
 *     pull recent attempt history for each ad_id, and render the
 *     `policy_experiences` text the L2 prompt expects. The text is
 *     written to a temp file whose path is passed to run-analysis
 *     via the GADS_POLICY_EXPERIENCES_FILE env var. We also surface
 *     a "do not retry — N consecutive failures" watchdog list so
 *     the LLM stops grinding the same broken creative.
 *
 *  2. recordAttemptsFromL2Output(l2JsonPath, snapshotPath, runId) —
 *     after run-analysis writes its l2-output.json, walk every
 *     family.ad_actions[] + family.trial_plans[].controls/variants
 *     and insert one gads_ad_attempts row per item. Best-effort:
 *     failures here MUST NOT block the bundle from shipping (the
 *     CSVs and HTML packet are already on disk).
 *
 *  3. evaluateOutcomesAgainstSnapshot(snapshotPath) — called by
 *     runAdsIngest right after a fresh snapshot is built. Walks
 *     every open attempt whose ad_id is in the new snapshot and
 *     fills in outcome_* columns by comparing pre/post serving
 *     status. This is what closes the loop.
 *
 * Everything is intentionally tolerant of an empty / missing DB
 * table (we log and continue) so the pipeline still works on hosts
 * where migration 025 hasn't been applied yet.
 */

import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'

import { getPool } from '../db/pool.js'
import {
  applyOutcomes,
  fetchOpenAttemptsForAds,
  fetchRecentAttemptsForAds,
  fetchStuckAdIds,
  insertAttempts,
  type GadsActionType,
  type GadsAttemptInsert,
  type GadsAttemptRow,
  type GadsOutcome,
  type OutcomeUpdate,
} from '../db/queries/gadsAdAttemptsQueries.js'

interface SnapshotAd {
  ad_id: string
  account_id?: string | null
  campaign_id?: string | null
  campaign_name?: string | null
  ad_group_id?: string | null
  ad_group_name?: string | null
  headlines?: string[]
  descriptions?: string[]
  final_url?: string | null
  policy_status?: string | null
  serving_status?: string | null
  family_tags?: Record<string, string>
}

async function readSnapshotJsonl(snapshotPath: string): Promise<SnapshotAd[]> {
  const raw = await fs.readFile(snapshotPath, 'utf-8')
  const out: SnapshotAd[] = []
  for (const line of raw.split('\n')) {
    const t = line.trim()
    if (!t) continue
    try {
      const parsed = JSON.parse(t) as SnapshotAd
      if (parsed && typeof parsed.ad_id === 'string') out.push(parsed)
    } catch {
      // skip malformed lines
    }
  }
  return out
}

function indexSnapshot(ads: SnapshotAd[]): Map<string, SnapshotAd> {
  const m = new Map<string, SnapshotAd>()
  for (const ad of ads) {
    if (ad.ad_id) m.set(ad.ad_id, ad)
  }
  return m
}

// ---------------------------------------------------------------------------
// 1. Pre-analysis: render policy_experiences text from prior attempts
// ---------------------------------------------------------------------------

export interface PolicyExperiencesPrepared {
  /** Absolute path to the temp text file the analysis script reads. */
  filePath: string
  /** Free for the caller to put into env: GADS_POLICY_EXPERIENCES_FILE */
  envName: 'GADS_POLICY_EXPERIENCES_FILE'
  /** Number of ad_ids the rendered text covers. */
  adsCovered: number
  /** Number of ads the watchdog flagged as "do not retry". */
  doNotRetryCount: number
}

export async function preparePolicyExperiences(
  snapshotPath: string,
  opts: { onLog?: (line: string) => void } = {},
): Promise<PolicyExperiencesPrepared | null> {
  const onLog = opts.onLog ?? (() => {})
  let ads: SnapshotAd[]
  try {
    ads = await readSnapshotJsonl(snapshotPath)
  } catch (err) {
    onLog(`policy_experiences: cannot read snapshot (${(err as Error).message}); skipping`)
    return null
  }
  if (ads.length === 0) {
    onLog('policy_experiences: snapshot has 0 ads; skipping')
    return null
  }
  const adIds = ads.map((a) => a.ad_id).filter((x): x is string => typeof x === 'string' && x !== '')
  if (adIds.length === 0) {
    onLog('policy_experiences: no ad_ids in snapshot; skipping')
    return null
  }

  let attemptsByAd: Map<string, GadsAttemptRow[]> = new Map()
  let stuck: Set<string> = new Set()
  try {
    const db = getPool()
    attemptsByAd = await fetchRecentAttemptsForAds(db, adIds, { perAdLimit: 6, sinceDays: 30 })
    stuck = await fetchStuckAdIds(db, adIds, { threshold: 3, windowDays: 14 })
  } catch (err) {
    onLog(
      `policy_experiences: DB query failed (${(err as Error).message}); ` +
        `the analysis will run without prior-attempt context (likely cause: migration 025 not yet applied)`,
    )
    return null
  }

  const text = renderPolicyExperiencesText(ads, attemptsByAd, stuck)
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'helios-gads-policy-exp-'))
  const filePath = path.join(tmpDir, 'policy_experiences.txt')
  await fs.writeFile(filePath, text, 'utf-8')
  onLog(
    `policy_experiences: ${attemptsByAd.size} ads with history, ` +
      `${stuck.size} flagged do-not-retry → ${filePath}`,
  )
  return {
    filePath,
    envName: 'GADS_POLICY_EXPERIENCES_FILE',
    adsCovered: attemptsByAd.size,
    doNotRetryCount: stuck.size,
  }
}

function renderPolicyExperiencesText(
  snapshotAds: SnapshotAd[],
  attemptsByAd: Map<string, GadsAttemptRow[]>,
  stuck: Set<string>,
): string {
  const lines: string[] = []
  lines.push('# Prior attempts and outcomes')
  lines.push('')
  lines.push(
    'Each ad below has had one or more re-enable / repair / replace attempts',
  )
  lines.push(
    'in the last 30 days. Use this to AVOID re-proposing changes that already',
  )
  lines.push('failed, and to BUILD ON changes that succeeded.')
  lines.push('')
  if (stuck.size > 0) {
    lines.push('## Watchdog: do-not-retry ads (≥3 failed attempts in 14 days)')
    lines.push('')
    lines.push(
      'For each ad_id below, DO NOT propose another repair/replace this run.',
    )
    lines.push('Either pause it, design a trial in a sibling ad group, or leave it for')
    lines.push('a human to inspect. Continuing to grind on these is destroying value:')
    lines.push('')
    for (const adId of [...stuck].sort()) {
      lines.push(`  - ${adId}`)
    }
    lines.push('')
  }
  if (attemptsByAd.size === 0) {
    lines.push('## Per-ad history')
    lines.push('')
    lines.push('(No prior attempts on file for ads in this snapshot.)')
    return lines.join('\n')
  }
  lines.push('## Per-ad history')
  lines.push('')
  const snapshotByAd = indexSnapshot(snapshotAds)
  const sortedAdIds = [...attemptsByAd.keys()].sort()
  for (const adId of sortedAdIds) {
    const history = attemptsByAd.get(adId) ?? []
    if (history.length === 0) continue
    const live = snapshotByAd.get(adId)
    const currentStatus = live?.serving_status ?? 'unknown'
    lines.push(`### Ad ${adId}`)
    if (live) {
      lines.push(
        `  current_serving_status: ${currentStatus}  ` +
          `(campaign: ${live.campaign_name ?? '?'}, ` +
          `ad_group: ${live.ad_group_name ?? '?'})`,
      )
    }
    if (stuck.has(adId)) {
      lines.push('  WATCHDOG: do-not-retry on this ad.')
    }
    for (const attempt of history) {
      const when = attempt.createdAt.slice(0, 10)
      const result =
        attempt.outcome === null
          ? 'pending'
          : `${attempt.outcome}` +
            (attempt.outcomeServingStatus
              ? ` (→ ${attempt.outcomeServingStatus})`
              : '')
      lines.push(
        `  - ${when} ${attempt.actionType} (${attempt.beforeServingStatus ?? '?'} → ?) ` +
          `result: ${result}`,
      )
      if (attempt.rationale) {
        lines.push(`      rationale: ${truncate(attempt.rationale, 200)}`)
      }
      // Surface a compact creative diff so the LLM sees what was
      // changed. We only show the first headline difference and the
      // first description difference to keep the prompt bounded.
      const diff = compactCreativeDiff(attempt)
      if (diff) lines.push(`      change: ${diff}`)
    }
    lines.push('')
  }
  return lines.join('\n')
}

function compactCreativeDiff(attempt: GadsAttemptRow): string | null {
  const beforeH = attempt.beforeHeadlines ?? []
  const proposedH = attempt.proposedHeadlines ?? []
  for (let i = 0; i < Math.max(beforeH.length, proposedH.length); i++) {
    if (beforeH[i] !== proposedH[i]) {
      return `headline ${i + 1}: "${truncate(beforeH[i] ?? '', 60)}" → "${truncate(proposedH[i] ?? '', 60)}"`
    }
  }
  const beforeD = attempt.beforeDescriptions ?? []
  const proposedD = attempt.proposedDescriptions ?? []
  for (let i = 0; i < Math.max(beforeD.length, proposedD.length); i++) {
    if (beforeD[i] !== proposedD[i]) {
      return `description ${i + 1}: "${truncate(beforeD[i] ?? '', 80)}" → "${truncate(proposedD[i] ?? '', 80)}"`
    }
  }
  return null
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s
  return s.slice(0, n - 1) + '…'
}

// ---------------------------------------------------------------------------
// 2. Post-analysis: persist this run's attempts to the DB
// ---------------------------------------------------------------------------

interface L2Output {
  run_id: string
  families: Array<{
    family_key: Record<string, unknown>
    ad_actions?: Array<{
      ad_id?: string
      action_type?: string
      rationale?: string
      justification?: string
      changes?: unknown
      suggested_new_creatives?: Array<{
        headlines?: string[]
        descriptions?: string[]
        final_url?: string
      }>
    }>
    trial_plans?: Array<{
      trial_id?: string
      trial_group_name?: string
      original_campaign_name?: string
      controls?: unknown[]
      control_ads?: unknown[]
      variants?: unknown[]
      variant_creatives?: unknown[]
      hypothesis?: string
    }>
  }>
}

export async function recordAttemptsFromL2Output(args: {
  l2JsonPath: string
  snapshotPath: string
  runId: string
  onLog?: (line: string) => void
}): Promise<{ inserted: number; skipped: number } | null> {
  const onLog = args.onLog ?? (() => {})
  let snapshotAds: SnapshotAd[]
  try {
    snapshotAds = await readSnapshotJsonl(args.snapshotPath)
  } catch (err) {
    onLog(`adAttempts.insert: cannot read snapshot (${(err as Error).message}); skipping`)
    return null
  }
  const snapshotByAd = indexSnapshot(snapshotAds)
  let l2: L2Output
  try {
    const raw = await fs.readFile(args.l2JsonPath, 'utf-8')
    l2 = JSON.parse(raw) as L2Output
  } catch (err) {
    onLog(`adAttempts.insert: cannot read l2 json (${(err as Error).message}); skipping`)
    return null
  }
  const inserts: GadsAttemptInsert[] = []
  let skipped = 0
  for (const family of l2.families ?? []) {
    for (const action of family.ad_actions ?? []) {
      const adId = (action.ad_id ?? '').toString().trim()
      if (!adId) {
        skipped += 1
        continue
      }
      const live = snapshotByAd.get(adId)
      if (!live) {
        // Hallucinated ad_id — record nothing; the CSV generator
        // would have dropped this row anyway. We don't want to
        // pollute the history with fake ads.
        skipped += 1
        continue
      }
      const actionType = normalizeActionType(action.action_type)
      if (!actionType) {
        skipped += 1
        continue
      }
      const creative = action.suggested_new_creatives?.[0]
      inserts.push({
        runId: args.runId,
        adId,
        accountId: live.account_id ?? null,
        campaignName: live.campaign_name ?? null,
        adGroupName: live.ad_group_name ?? null,
        familyKey: (family.family_key ?? {}) as Record<string, unknown>,
        actionType,
        rationale: action.rationale ?? action.justification ?? null,
        beforeServingStatus: live.serving_status ?? null,
        beforePolicyStatus: live.policy_status ?? null,
        beforeHeadlines: live.headlines ?? null,
        beforeDescriptions: live.descriptions ?? null,
        beforeFinalUrl: live.final_url ?? null,
        proposedHeadlines: creative?.headlines ?? null,
        proposedDescriptions: creative?.descriptions ?? null,
        proposedFinalUrl: creative?.final_url ?? null,
        proposedChangesJson: action.changes ?? null,
      })
    }
    // Trial controls / variants — record them so a future evaluation
    // can credit the "trial worked" or "trial didn't move the needle"
    // outcome. We only record entries that resolve to a real ad_id
    // (string form like "Core-1 (safe flower ad)" with no matching
    // snapshot ad is dropped).
    for (const trial of family.trial_plans ?? []) {
      const groupName = trial.trial_group_name ?? null
      const campaign =
        trial.original_campaign_name ??
        (groupName
          ? snapshotByAd.get(
              [...snapshotByAd.values()].find((a) =>
                a.ad_group_name === groupName.replace(/-trial-\d+$/i, ''),
              )?.ad_id ?? '',
            )?.campaign_name ?? null
          : null)
      const controls = trial.control_ads ?? trial.controls ?? []
      const variants = trial.variant_creatives ?? trial.variants ?? []
      for (const c of controls) {
        const ins = trialEntryToInsert({
          raw: c,
          actionType: 'trial_control',
          runId: args.runId,
          family,
          snapshotByAd,
          campaignName: campaign ?? null,
          adGroupName: groupName,
          rationale: trial.hypothesis ?? null,
        })
        if (ins) inserts.push(ins)
        else skipped += 1
      }
      for (const v of variants) {
        const ins = trialEntryToInsert({
          raw: v,
          actionType: 'trial_variant',
          runId: args.runId,
          family,
          snapshotByAd,
          campaignName: campaign ?? null,
          adGroupName: groupName,
          rationale: trial.hypothesis ?? null,
        })
        if (ins) inserts.push(ins)
        else skipped += 1
      }
    }
  }
  if (inserts.length === 0) {
    onLog(`adAttempts.insert: nothing to record (skipped ${skipped})`)
    return { inserted: 0, skipped }
  }
  try {
    const db = getPool()
    const inserted = await insertAttempts(db, inserts)
    onLog(`adAttempts.insert: wrote ${inserted} rows (skipped ${skipped})`)
    return { inserted, skipped }
  } catch (err) {
    onLog(
      `adAttempts.insert: DB write failed (${(err as Error).message}); ` +
        `bundle still shipped, but this run's history is lost`,
    )
    return null
  }
}

function normalizeActionType(s: unknown): GadsActionType | null {
  if (typeof s !== 'string') return null
  const v = s.trim().toLowerCase()
  if (v === 'repair' || v === 'replace' || v === 'pause' || v === 'monitor') return v
  return null
}

function trialEntryToInsert(args: {
  raw: unknown
  actionType: 'trial_control' | 'trial_variant'
  runId: string
  family: { family_key: Record<string, unknown> }
  snapshotByAd: Map<string, SnapshotAd>
  campaignName: string | null
  adGroupName: string | null
  rationale: string | null
}): GadsAttemptInsert | null {
  const adIdRef = extractAdIdRefFromTrialEntry(args.raw)
  if (!adIdRef) return null
  const live = args.snapshotByAd.get(adIdRef)
  if (!live) return null
  return {
    runId: args.runId,
    adId: adIdRef,
    accountId: live.account_id ?? null,
    campaignName: args.campaignName ?? live.campaign_name ?? null,
    adGroupName: args.adGroupName ?? live.ad_group_name ?? null,
    familyKey: (args.family.family_key ?? {}) as Record<string, unknown>,
    actionType: args.actionType,
    rationale: args.rationale,
    beforeServingStatus: live.serving_status ?? null,
    beforePolicyStatus: live.policy_status ?? null,
    beforeHeadlines: live.headlines ?? null,
    beforeDescriptions: live.descriptions ?? null,
    beforeFinalUrl: live.final_url ?? null,
    proposedHeadlines: null,
    proposedDescriptions: null,
    proposedFinalUrl: null,
    proposedChangesJson: { trial_raw: args.raw },
  }
}

function extractAdIdRefFromTrialEntry(raw: unknown): string | null {
  if (typeof raw === 'string') {
    const m = raw.match(/^\s*([^()|]+(?:\|[^()]+)?)/)
    if (!m) return null
    return m[1].trim() || null
  }
  if (raw && typeof raw === 'object') {
    const o = raw as Record<string, unknown>
    if (typeof o.source_ad_id === 'string') return o.source_ad_id
    if (typeof o.ad_id === 'string') return o.ad_id
  }
  return null
}

// ---------------------------------------------------------------------------
// 3. Post-ingest: evaluate open attempts against the new snapshot
// ---------------------------------------------------------------------------

export async function evaluateOutcomesAgainstSnapshot(
  snapshotPath: string,
  opts: { onLog?: (line: string) => void } = {},
): Promise<{ updated: number } | null> {
  const onLog = opts.onLog ?? (() => {})
  let snapshotAds: SnapshotAd[]
  try {
    snapshotAds = await readSnapshotJsonl(snapshotPath)
  } catch (err) {
    onLog(`adAttempts.eval: cannot read snapshot (${(err as Error).message}); skipping`)
    return null
  }
  const snapshotByAd = indexSnapshot(snapshotAds)
  const adIds = [...snapshotByAd.keys()]
  if (adIds.length === 0) return null
  let open: GadsAttemptRow[]
  try {
    const db = getPool()
    open = await fetchOpenAttemptsForAds(db, adIds, { maxAgeDays: 21 })
  } catch (err) {
    onLog(`adAttempts.eval: DB read failed (${(err as Error).message}); skipping`)
    return null
  }
  if (open.length === 0) {
    onLog('adAttempts.eval: 0 open attempts to evaluate')
    return { updated: 0 }
  }
  // Build {ad_id -> [attempts]} so we can apply "superseded" within
  // the same ad: only the NEWEST attempt against an ad gets a real
  // outcome; older open attempts on the same ad are superseded.
  const byAd = new Map<string, GadsAttemptRow[]>()
  for (const a of open) {
    const arr = byAd.get(a.adId) ?? []
    arr.push(a)
    byAd.set(a.adId, arr)
  }
  const updates: OutcomeUpdate[] = []
  for (const [adId, attempts] of byAd.entries()) {
    const live = snapshotByAd.get(adId)
    if (!live) {
      for (const a of attempts) {
        updates.push({
          id: a.id,
          outcome: 'ad_disappeared',
          outcomeServingStatus: null,
          outcomePolicyStatus: null,
          outcomeNotes: 'ad_id no longer present in snapshot',
        })
      }
      continue
    }
    // newest last after asc sort -> latest is the one we'll grade
    const latest = attempts[attempts.length - 1]
    for (const a of attempts) {
      if (a.id !== latest.id) {
        updates.push({
          id: a.id,
          outcome: 'superseded',
          outcomeServingStatus: live.serving_status ?? null,
          outcomePolicyStatus: live.policy_status ?? null,
          outcomeNotes: `superseded by attempt #${latest.id} (${latest.actionType})`,
        })
        continue
      }
      const outcome = gradeOutcome(a.beforeServingStatus, live.serving_status ?? null)
      updates.push({
        id: a.id,
        outcome,
        outcomeServingStatus: live.serving_status ?? null,
        outcomePolicyStatus: live.policy_status ?? null,
        outcomeNotes: null,
      })
    }
  }
  try {
    const db = getPool()
    const updated = await applyOutcomes(db, updates)
    onLog(`adAttempts.eval: graded ${updated} attempts`)
    return { updated }
  } catch (err) {
    onLog(`adAttempts.eval: DB write failed (${(err as Error).message}); skipping`)
    return null
  }
}

function statusScore(s: string | null | undefined): number {
  switch ((s ?? '').toLowerCase()) {
    case 'not_eligible':
      return 0
    case 'eligible_limited':
      return 1
    case 'under_review':
      return 2
    case 'eligible':
      return 3
    default:
      return -1
  }
}

function gradeOutcome(before: string | null, after: string | null): GadsOutcome {
  const b = statusScore(before)
  const a = statusScore(after)
  if (b < 0 || a < 0) return 'no_change'
  if (a === b) return 'no_change'
  if (a > b) {
    if (a === 3) return 'success' // any → eligible
    return 'partial'
  }
  return 'worse'
}
