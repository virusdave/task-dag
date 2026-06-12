// DB layer for the SEO recommendation engine (migration 077; P5 — parent
// epic virusdave/top-level#15, child epic FreshlyBakedNYC/automation#44).
//
// Idempotency / write-on-change + decision preservation (canon §1, §3): the
// generator upsert keys on the deterministic recommendation_id and only
// updates an OPEN recommendation whose rationale/title/priority actually
// changed (… is distinct from …). It NEVER resurrects a recommendation the
// operator already accepted/dismissed (the conflict WHERE gates on
// status = 'open'), and a re-run over unchanged metrics writes ZERO rows.

import type { Queryable } from '../pool.js'
import type {
  SeoRecLinkedKind,
  SeoRecStatus,
  SeoRecommendationRecord,
} from '../../../shared/contracts/index.js'
import type { RecommendationDraft } from '../../seo/recommendations.js'

interface SeoRecommendationRow {
  recommendation_id: string
  rec_type: string
  site: string
  target_query: string | null
  target_page_url: string | null
  title: string
  rationale: unknown
  priority: number
  status: string
  linked_content_kind: string | null
  linked_content_id: string | null
  decided_by_user_id: string | number | null
  decided_at: Date | string | null
  decision_note: string | null
  first_seen_at: Date | string
  updated_at: Date | string
}

function toIso(value: Date | string | null): string | null {
  if (value === null) return null
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}

function mapRow(row: SeoRecommendationRow): SeoRecommendationRecord {
  return {
    recommendationId: row.recommendation_id,
    recType: row.rec_type as SeoRecommendationRecord['recType'],
    site: row.site,
    targetQuery: row.target_query,
    targetPageUrl: row.target_page_url,
    title: row.title,
    rationale: row.rationale,
    priority: row.priority,
    status: row.status as SeoRecStatus,
    linkedContentKind: row.linked_content_kind as SeoRecLinkedKind | null,
    linkedContentId: row.linked_content_id,
    decidedByUserId: row.decided_by_user_id === null ? null : Number(row.decided_by_user_id),
    decidedAt: toIso(row.decided_at),
    decisionNote: row.decision_note,
    firstSeenAt: toIso(row.first_seen_at)!,
    updatedAt: toIso(row.updated_at)!,
  }
}

const RETURNING = `
  returning
    recommendation_id, rec_type, site, target_query, target_page_url, title,
    rationale, priority, status, linked_content_kind, linked_content_id,
    decided_by_user_id, decided_at, decision_note, first_seen_at, updated_at
`

export interface UpsertRecommendationsResult {
  readonly inserted: number
  readonly updated: number
  readonly unchanged: number
}

const UPSERT_CHUNK_SIZE = 500

const COLUMNS = [
  'recommendation_id',
  'rec_type',
  'site',
  'target_query',
  'target_page_url',
  'title',
  'rationale',
  'priority',
] as const

function draftParams(d: RecommendationDraft): unknown[] {
  return [
    d.recommendation_id,
    d.rec_type,
    d.site,
    d.target_query,
    d.target_page_url,
    d.title,
    JSON.stringify(d.rationale),
    d.priority,
  ]
}

/**
 * Upsert draft recommendations. New rows insert as `open`; an existing OPEN
 * row refreshes its rationale/title/priority only when something changed; an
 * already-decided row is left untouched (decision preserved). Caller must
 * de-dupe ids first (buildRecommendations already does).
 */
export async function upsertRecommendations(
  db: Queryable,
  drafts: readonly RecommendationDraft[],
): Promise<UpsertRecommendationsResult> {
  let inserted = 0
  let updated = 0
  let unchanged = 0
  for (let start = 0; start < drafts.length; start += UPSERT_CHUNK_SIZE) {
    const chunk = drafts.slice(start, start + UPSERT_CHUNK_SIZE)
    const params: unknown[] = []
    const tuples: string[] = []
    for (const d of chunk) {
      const base = params.length
      tuples.push(`(${COLUMNS.map((_, i) => `$${base + i + 1}`).join(',')})`)
      params.push(...draftParams(d))
    }
    const res = await db.query<{ inserted: boolean }>(
      `
        insert into seo_recommendations (${COLUMNS.join(', ')})
        values ${tuples.join(', ')}
        on conflict (recommendation_id) do update set
          title = excluded.title,
          rationale = excluded.rationale,
          priority = excluded.priority,
          updated_at = now()
        where seo_recommendations.status = 'open'
          and (seo_recommendations.title is distinct from excluded.title
               or seo_recommendations.rationale is distinct from excluded.rationale
               or seo_recommendations.priority is distinct from excluded.priority)
        returning (xmax = 0) as inserted
      `,
      params,
    )
    for (const r of res.rows) {
      if (r.inserted) inserted++
      else updated++
    }
    unchanged += chunk.length - res.rows.length
  }
  return { inserted, updated, unchanged }
}

export interface ListRecommendationsFilter {
  readonly site?: string
  readonly status?: SeoRecStatus
  readonly limit: number
}

/** List recommendations, optionally filtered by site/status, highest-priority first. */
export async function listRecommendations(
  db: Queryable,
  filter: ListRecommendationsFilter,
): Promise<SeoRecommendationRecord[]> {
  const where: string[] = []
  const params: unknown[] = []
  if (filter.site !== undefined) {
    params.push(filter.site)
    where.push(`site = $${params.length}`)
  }
  if (filter.status !== undefined) {
    params.push(filter.status)
    where.push(`status = $${params.length}`)
  }
  params.push(filter.limit)
  const limitIdx = params.length
  const res = await db.query<SeoRecommendationRow>(
    `
      select
        recommendation_id, rec_type, site, target_query, target_page_url, title,
        rationale, priority, status, linked_content_kind, linked_content_id,
        decided_by_user_id, decided_at, decision_note, first_seen_at, updated_at
      from seo_recommendations
      ${where.length > 0 ? `where ${where.join(' and ')}` : ''}
      order by priority desc, recommendation_id asc
      limit $${limitIdx}
    `,
    params,
  )
  return res.rows.map(mapRow)
}

export async function getRecommendation(
  db: Queryable,
  recommendationId: string,
): Promise<SeoRecommendationRecord | null> {
  const res = await db.query<SeoRecommendationRow>(
    `
      select
        recommendation_id, rec_type, site, target_query, target_page_url, title,
        rationale, priority, status, linked_content_kind, linked_content_id,
        decided_by_user_id, decided_at, decision_note, first_seen_at, updated_at
      from seo_recommendations
      where recommendation_id = $1
    `,
    [recommendationId],
  )
  const row = res.rows[0]
  return row ? mapRow(row) : null
}

/**
 * Mark an OPEN recommendation accepted and link the draft it spawned. Only
 * transitions from `open` (the WHERE guard), so a double-accept is a no-op
 * that returns null.
 */
export async function acceptRecommendation(
  db: Queryable,
  args: {
    recommendationId: string
    linkedContentKind: SeoRecLinkedKind
    linkedContentId: string
    userId: number
    note: string | null
  },
): Promise<SeoRecommendationRecord | null> {
  const res = await db.query<SeoRecommendationRow>(
    `
      update seo_recommendations
         set status = 'accepted',
             linked_content_kind = $2,
             linked_content_id = $3,
             decided_by_user_id = $4,
             decided_at = now(),
             decision_note = $5,
             updated_at = now()
       where recommendation_id = $1 and status = 'open'
      ${RETURNING}
    `,
    [
      args.recommendationId,
      args.linkedContentKind,
      args.linkedContentId,
      args.userId,
      args.note,
    ],
  )
  const row = res.rows[0]
  return row ? mapRow(row) : null
}

/** Mark an OPEN recommendation dismissed. No-op (null) if not open. */
export async function dismissRecommendation(
  db: Queryable,
  args: { recommendationId: string; userId: number; note: string | null },
): Promise<SeoRecommendationRecord | null> {
  const res = await db.query<SeoRecommendationRow>(
    `
      update seo_recommendations
         set status = 'dismissed',
             decided_by_user_id = $2,
             decided_at = now(),
             decision_note = $3,
             updated_at = now()
       where recommendation_id = $1 and status = 'open'
      ${RETURNING}
    `,
    [args.recommendationId, args.userId, args.note],
  )
  const row = res.rows[0]
  return row ? mapRow(row) : null
}
