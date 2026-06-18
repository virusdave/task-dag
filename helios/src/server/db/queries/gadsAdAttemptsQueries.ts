/**
 * gads_ad_attempts — per-ad attempt history for the Google Ads
 * automation feedback loop.
 *
 * Two write paths:
 *   1. insertAttempts(...)         — called at the end of a morning
 *                                    bundle run, one row per L2
 *                                    ad_action + one per trial
 *                                    control/variant
 *   2. evaluateOpenAttempts(...)   — called after each new snapshot
 *                                    is ingested, fills in outcome_*
 *                                    columns by comparing pre/post
 *                                    serving status
 *
 * One read path:
 *   3. fetchRecentAttemptsForAds(...) — pulls history for a set of
 *                                       ad_ids so the L2 prompt-prep
 *                                       step can render
 *                                       `policy_experiences`.
 */

import type { GadsSiteKey } from '../../../shared/domain/gadsSites.js'
import type { Queryable } from '../pool.js'

export type GadsActionType =
  | 'repair'
  | 'replace'
  | 'pause'
  | 'monitor'
  | 'trial_control'
  | 'trial_variant'

export type GadsOutcome =
  | 'success'
  | 'partial'
  | 'no_change'
  | 'worse'
  | 'superseded'
  | 'ad_disappeared'
  | 'unobserved'

export interface GadsAttemptInsert {
  runId: string
  adId: string
  accountId: string | null
  campaignName: string | null
  adGroupName: string | null
  /** Derived GAds site scope: 'bronx'|'midtown', or null = unknown/cross-site. */
  site: GadsSiteKey | null
  familyKey: Record<string, unknown>
  actionType: GadsActionType
  rationale: string | null
  beforeServingStatus: string | null
  beforePolicyStatus: string | null
  beforeHeadlines: string[] | null
  beforeDescriptions: string[] | null
  beforeFinalUrl: string | null
  proposedHeadlines: string[] | null
  proposedDescriptions: string[] | null
  proposedFinalUrl: string | null
  proposedChangesJson: unknown | null
}

export interface GadsAttemptRow {
  id: number
  createdAt: string
  runId: string
  adId: string
  accountId: string | null
  campaignName: string | null
  adGroupName: string | null
  /** Derived GAds site scope: 'bronx'|'midtown', or null = unknown/cross-site. */
  site: GadsSiteKey | null
  familyKey: Record<string, unknown>
  actionType: GadsActionType
  rationale: string | null
  beforeServingStatus: string | null
  beforePolicyStatus: string | null
  beforeHeadlines: string[] | null
  beforeDescriptions: string[] | null
  beforeFinalUrl: string | null
  proposedHeadlines: string[] | null
  proposedDescriptions: string[] | null
  proposedFinalUrl: string | null
  outcomeObservedAt: string | null
  outcomeServingStatus: string | null
  outcomePolicyStatus: string | null
  outcome: GadsOutcome | null
  outcomeNotes: string | null
}

interface GadsAttemptDbRow {
  id: string | number
  created_at: Date
  run_id: string
  ad_id: string
  account_id: string | null
  campaign_name: string | null
  ad_group_name: string | null
  site: string | null
  family_key: Record<string, unknown> | null
  action_type: string
  rationale: string | null
  before_serving_status: string | null
  before_policy_status: string | null
  before_headlines: string[] | null
  before_descriptions: string[] | null
  before_final_url: string | null
  proposed_headlines: string[] | null
  proposed_descriptions: string[] | null
  proposed_final_url: string | null
  outcome_observed_at: Date | null
  outcome_serving_status: string | null
  outcome_policy_status: string | null
  outcome: string | null
  outcome_notes: string | null
}

function rowToAttempt(row: GadsAttemptDbRow): GadsAttemptRow {
  return {
    id: Number(row.id),
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    runId: row.run_id,
    adId: row.ad_id,
    accountId: row.account_id,
    campaignName: row.campaign_name,
    adGroupName: row.ad_group_name,
    site: row.site === 'bronx' || row.site === 'midtown' ? row.site : null,
    familyKey: row.family_key ?? {},
    actionType: row.action_type as GadsActionType,
    rationale: row.rationale,
    beforeServingStatus: row.before_serving_status,
    beforePolicyStatus: row.before_policy_status,
    beforeHeadlines: row.before_headlines,
    beforeDescriptions: row.before_descriptions,
    beforeFinalUrl: row.before_final_url,
    proposedHeadlines: row.proposed_headlines,
    proposedDescriptions: row.proposed_descriptions,
    proposedFinalUrl: row.proposed_final_url,
    outcomeObservedAt: row.outcome_observed_at
      ? row.outcome_observed_at.toISOString()
      : null,
    outcomeServingStatus: row.outcome_serving_status,
    outcomePolicyStatus: row.outcome_policy_status,
    outcome: row.outcome === null ? null : (row.outcome as GadsOutcome),
    outcomeNotes: row.outcome_notes,
  }
}

const ATTEMPT_SELECT_COLUMNS = `
  id,
  created_at,
  run_id,
  ad_id,
  account_id,
  campaign_name,
  ad_group_name,
  site,
  family_key,
  action_type,
  rationale,
  before_serving_status,
  before_policy_status,
  before_headlines,
  before_descriptions,
  before_final_url,
  proposed_headlines,
  proposed_descriptions,
  proposed_final_url,
  outcome_observed_at,
  outcome_serving_status,
  outcome_policy_status,
  outcome,
  outcome_notes
`

export async function insertAttempts(
  db: Queryable,
  rows: ReadonlyArray<GadsAttemptInsert>,
): Promise<number> {
  if (rows.length === 0) return 0
  let inserted = 0
  // One INSERT per row keeps this readable and resilient — the
  // morning bundle produces dozens of rows, not thousands, so we
  // don't need a multi-VALUES batch.
  for (const row of rows) {
    await db.query(
      `
      insert into gads_ad_attempts (
        run_id, ad_id, account_id, campaign_name, ad_group_name, site,
        family_key, action_type, rationale,
        before_serving_status, before_policy_status,
        before_headlines, before_descriptions, before_final_url,
        proposed_headlines, proposed_descriptions, proposed_final_url,
        proposed_changes_json
      ) values (
        $1, $2, $3, $4, $5, $6,
        $7::jsonb, $8, $9,
        $10, $11,
        $12::jsonb, $13::jsonb, $14,
        $15::jsonb, $16::jsonb, $17,
        $18::jsonb
      )
      `,
      [
        row.runId,
        row.adId,
        row.accountId,
        row.campaignName,
        row.adGroupName,
        row.site,
        JSON.stringify(row.familyKey ?? {}),
        row.actionType,
        row.rationale,
        row.beforeServingStatus,
        row.beforePolicyStatus,
        row.beforeHeadlines === null ? null : JSON.stringify(row.beforeHeadlines),
        row.beforeDescriptions === null ? null : JSON.stringify(row.beforeDescriptions),
        row.beforeFinalUrl,
        row.proposedHeadlines === null ? null : JSON.stringify(row.proposedHeadlines),
        row.proposedDescriptions === null ? null : JSON.stringify(row.proposedDescriptions),
        row.proposedFinalUrl,
        row.proposedChangesJson === null
          ? null
          : JSON.stringify(row.proposedChangesJson),
      ],
    )
    inserted += 1
  }
  return inserted
}

/**
 * Pull the recent attempt history for a batch of ad_ids. Used by
 * the L2 prompt-prep step. Newest-first per ad_id, capped at
 * `perAdLimit` rows to keep the prompt bounded.
 */
export async function fetchRecentAttemptsForAds(
  db: Queryable,
  adIds: ReadonlyArray<string>,
  opts: { perAdLimit?: number; sinceDays?: number } = {},
): Promise<Map<string, GadsAttemptRow[]>> {
  const out = new Map<string, GadsAttemptRow[]>()
  if (adIds.length === 0) return out
  const perAdLimit = Math.max(1, opts.perAdLimit ?? 6)
  const sinceDays = Math.max(1, opts.sinceDays ?? 30)
  const result = await db.query<GadsAttemptDbRow>(
    `
    select ${ATTEMPT_SELECT_COLUMNS}
    from gads_ad_attempts
    where ad_id = any($1::text[])
      and created_at >= now() - ($2 || ' days')::interval
    order by ad_id, created_at desc
    `,
    [adIds.slice(), String(sinceDays)],
  )
  for (const dbRow of result.rows) {
    const attempt = rowToAttempt(dbRow)
    const existing = out.get(attempt.adId) ?? []
    if (existing.length < perAdLimit) {
      existing.push(attempt)
      out.set(attempt.adId, existing)
    }
  }
  return out
}

/**
 * For the outcome evaluator. Returns every attempt whose outcome
 * hasn't yet been observed AND whose ad_id is present in the
 * provided list, oldest-first so superseding rules apply
 * deterministically.
 */
export async function fetchOpenAttemptsForAds(
  db: Queryable,
  adIds: ReadonlyArray<string>,
  opts: { maxAgeDays?: number } = {},
): Promise<GadsAttemptRow[]> {
  if (adIds.length === 0) return []
  const maxAgeDays = Math.max(1, opts.maxAgeDays ?? 21)
  const result = await db.query<GadsAttemptDbRow>(
    `
    select ${ATTEMPT_SELECT_COLUMNS}
    from gads_ad_attempts
    where outcome_observed_at is null
      and ad_id = any($1::text[])
      and created_at >= now() - ($2 || ' days')::interval
    order by created_at asc
    `,
    [adIds.slice(), String(maxAgeDays)],
  )
  return result.rows.map(rowToAttempt)
}

export interface OutcomeUpdate {
  id: number
  outcome: GadsOutcome
  outcomeServingStatus: string | null
  outcomePolicyStatus: string | null
  outcomeNotes: string | null
}

export async function applyOutcomes(
  db: Queryable,
  updates: ReadonlyArray<OutcomeUpdate>,
): Promise<number> {
  if (updates.length === 0) return 0
  let n = 0
  for (const u of updates) {
    const result = await db.query(
      `
      update gads_ad_attempts
      set outcome_observed_at    = now(),
          outcome                = $2,
          outcome_serving_status = $3,
          outcome_policy_status  = $4,
          outcome_notes          = $5
      where id = $1
        and outcome_observed_at is null
      `,
      [
        u.id,
        u.outcome,
        u.outcomeServingStatus,
        u.outcomePolicyStatus,
        u.outcomeNotes,
      ],
    )
    n += result.rowCount ?? 0
  }
  return n
}

/**
 * Roll-up used by the watchdog: returns the set of ad_ids that have
 * had ≥ `threshold` consecutive failed (no_change | worse |
 * partial) re-enable attempts in the last `windowDays`. The LLM is
 * told to leave these alone for a while.
 */
export async function fetchStuckAdIds(
  db: Queryable,
  candidateAdIds: ReadonlyArray<string>,
  opts: { threshold?: number; windowDays?: number } = {},
): Promise<Set<string>> {
  const stuck = new Set<string>()
  if (candidateAdIds.length === 0) return stuck
  const threshold = Math.max(2, opts.threshold ?? 3)
  const windowDays = Math.max(1, opts.windowDays ?? 14)
  const result = await db.query<{ ad_id: string; failed_count: string }>(
    `
    select ad_id, count(*)::text as failed_count
    from gads_ad_attempts
    where ad_id = any($1::text[])
      and created_at >= now() - ($2 || ' days')::interval
      and outcome in ('no_change', 'worse', 'partial')
      and action_type in ('repair', 'replace')
    group by ad_id
    having count(*) >= $3
    `,
    [candidateAdIds.slice(), String(windowDays), threshold],
  )
  for (const row of result.rows) {
    stuck.add(row.ad_id)
  }
  return stuck
}
