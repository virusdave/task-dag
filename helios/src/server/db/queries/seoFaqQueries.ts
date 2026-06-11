// Query layer for the SEO FAQ control plane (migration 071).
//
// Helios-driven SEO widgets — FAQ MVP (parent EPIC_PLAN §6.1/§7,
// child FreshlyBakedNYC/automation#44, P3, Satisfies: virusdave/top-level#15).
//
// Backs the /api/seo/faq-sets routes and the approved-FAQ bundle loader.
// The approve path is the IRONCLAD human-approval gate (canon §1): it runs
// under a row lock, re-checks the fingerprint the reviewer saw, writes an
// append-only ledger row, and binds the FAQ set to that approval. Any edit
// recomputes the fingerprint and resets the set to `draft`.

import type { PoolClient } from 'pg'

import type {
  SeoFaqItem,
  SeoFaqSetRecord,
  SeoFaqSource,
} from '../../../shared/contracts/index.js'
import {
  checkFaqSetApprovable,
  faqSetContentSha256,
  newFaqSetId,
  newSeoApprovalId,
  type FaqItemInput,
} from '../../seo/faqContent.js'
import type { Queryable } from '../pool.js'
import { withTransaction } from '../tx.js'

interface SeoFaqSetRow {
  faq_set_id: string
  scope: string
  status: string
  source: string
  items: unknown
  content_sha256: string
  approval_id: string | null
  generation_meta: unknown
  created_by_user_id: string | number | null
  updated_by_user_id: string | number | null
  created_at: Date | string
  updated_at: Date | string
  // from the seo_approvals join
  approved_by_user_id: string | number | null
  approved_at: Date | string | null
  approval_note: string | null
}

const SELECT_FAQ_SET = `
  select
    f.faq_set_id,
    f.scope,
    f.status,
    f.source,
    f.items,
    f.content_sha256,
    f.approval_id,
    f.generation_meta,
    f.created_by_user_id,
    f.updated_by_user_id,
    f.created_at,
    f.updated_at,
    a.approved_by_user_id,
    a.approved_at,
    a.note as approval_note
  from seo_faq_sets f
  left join seo_approvals a on a.approval_id = f.approval_id
`

function toIsoString(value: Date | string | null): string | null {
  if (value === null) {
    return null
  }
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}

function toNumberOrNull(value: string | number | null): number | null {
  if (value === null) {
    return null
  }
  return typeof value === 'number' ? value : Number.parseInt(value, 10)
}

function parseItems(raw: unknown): SeoFaqItem[] {
  if (!Array.isArray(raw)) {
    return []
  }
  return raw.map((item) => {
    const obj = (item ?? {}) as Record<string, unknown>
    return {
      question: typeof obj.question === 'string' ? obj.question : '',
      answer_raw: typeof obj.answer_raw === 'string' ? obj.answer_raw : '',
      answer_sanitized:
        typeof obj.answer_sanitized === 'string' ? obj.answer_sanitized : '',
    }
  })
}

function mapRow(row: SeoFaqSetRow): SeoFaqSetRecord {
  return {
    faqSetId: row.faq_set_id,
    scope: row.scope,
    status: row.status as SeoFaqSetRecord['status'],
    source: row.source as SeoFaqSource,
    items: parseItems(row.items),
    contentSha256: row.content_sha256,
    approvalId: row.approval_id,
    approvedByUserId: toNumberOrNull(row.approved_by_user_id),
    approvedAt: toIsoString(row.approved_at),
    approvalNote: row.approval_note,
    generationMeta: row.generation_meta ?? null,
    createdByUserId: toNumberOrNull(row.created_by_user_id),
    updatedByUserId: toNumberOrNull(row.updated_by_user_id),
    createdAt: toIsoString(row.created_at)!,
    updatedAt: toIsoString(row.updated_at)!,
  }
}

// Items as the fingerprint helper expects them (already the same shape).
function toItemInputs(items: readonly SeoFaqItem[]): FaqItemInput[] {
  return items.map((item) => ({
    question: item.question,
    answer_raw: item.answer_raw,
    answer_sanitized: item.answer_sanitized,
  }))
}

export async function listSeoFaqSets(db: Queryable): Promise<SeoFaqSetRecord[]> {
  const result = await db.query<SeoFaqSetRow>(`${SELECT_FAQ_SET} order by f.updated_at desc`)
  return result.rows.map(mapRow)
}

export async function getSeoFaqSet(
  db: Queryable,
  faqSetId: string,
): Promise<SeoFaqSetRecord | null> {
  const result = await db.query<SeoFaqSetRow>(
    `${SELECT_FAQ_SET} where f.faq_set_id = $1`,
    [faqSetId],
  )
  const row = result.rows[0]
  return row ? mapRow(row) : null
}

export interface CreateSeoFaqSetInput {
  readonly scope: string
  readonly items: readonly SeoFaqItem[]
  readonly source?: SeoFaqSource
  readonly generationMeta?: unknown
  readonly userId: number
  readonly now?: Date
}

export async function createSeoFaqSet(
  db: Queryable,
  input: CreateSeoFaqSetInput,
): Promise<SeoFaqSetRecord> {
  const now = input.now ?? new Date()
  const faqSetId = newFaqSetId(now)
  const items = toItemInputs(input.items)
  const contentSha256 = faqSetContentSha256({ faq_set_id: faqSetId, scope: input.scope, items })
  const result = await db.query<SeoFaqSetRow>(
    `
      insert into seo_faq_sets (
        faq_set_id, scope, status, items, source, generation_meta,
        content_sha256, approval_id, created_by_user_id, updated_by_user_id
      )
      values ($1, $2, 'draft', $3::jsonb, $4, $5::jsonb, $6, null, $7, $7)
      returning
        faq_set_id, scope, status, source, items, content_sha256, approval_id,
        generation_meta, created_by_user_id, updated_by_user_id, created_at, updated_at,
        null::bigint as approved_by_user_id, null::timestamptz as approved_at,
        null::text as approval_note
    `,
    [
      faqSetId,
      input.scope,
      JSON.stringify(input.items),
      input.source ?? 'manual',
      input.generationMeta === undefined ? null : JSON.stringify(input.generationMeta),
      contentSha256,
      input.userId,
    ],
  )
  return mapRow(result.rows[0]!)
}

export interface UpdateSeoFaqSetInput {
  readonly scope: string
  readonly items: readonly SeoFaqItem[]
  readonly userId: number
}

/**
 * Replace a FAQ set's scope + items. Always resets the set to `draft` and
 * clears its approval (so an approval can never silently cover edited
 * content) and recomputes the content fingerprint. Returns null if the set
 * does not exist.
 */
export async function updateSeoFaqSet(
  db: Queryable,
  faqSetId: string,
  input: UpdateSeoFaqSetInput,
): Promise<SeoFaqSetRecord | null> {
  const items = toItemInputs(input.items)
  const contentSha256 = faqSetContentSha256({ faq_set_id: faqSetId, scope: input.scope, items })
  const result = await db.query<SeoFaqSetRow>(
    `
      update seo_faq_sets
         set scope = $2,
             items = $3::jsonb,
             content_sha256 = $4,
             status = 'draft',
             approval_id = null,
             updated_by_user_id = $5,
             updated_at = now()
       where faq_set_id = $1
      returning
        faq_set_id, scope, status, source, items, content_sha256, approval_id,
        generation_meta, created_by_user_id, updated_by_user_id, created_at, updated_at,
        null::bigint as approved_by_user_id, null::timestamptz as approved_at,
        null::text as approval_note
    `,
    [faqSetId, input.scope, JSON.stringify(input.items), contentSha256, input.userId],
  )
  const row = result.rows[0]
  return row ? mapRow(row) : null
}

export type FaqSetStatusTransition = 'needs_review' | 'rejected'

/**
 * Move a non-approved set to `needs_review` (submit for review) or
 * `rejected`. Never touches content or approval bindings; rejecting an
 * approved set first clears the approval. Returns null if not found.
 */
export async function setSeoFaqSetStatus(
  db: Queryable,
  faqSetId: string,
  status: FaqSetStatusTransition,
  userId: number,
): Promise<SeoFaqSetRecord | null> {
  const result = await db.query<SeoFaqSetRow>(
    `
      update seo_faq_sets
         set status = $2,
             approval_id = null,
             updated_by_user_id = $3,
             updated_at = now()
       where faq_set_id = $1
      returning
        faq_set_id, scope, status, source, items, content_sha256, approval_id,
        generation_meta, created_by_user_id, updated_by_user_id, created_at, updated_at,
        null::bigint as approved_by_user_id, null::timestamptz as approved_at,
        null::text as approval_note
    `,
    [faqSetId, status, userId],
  )
  const row = result.rows[0]
  return row ? mapRow(row) : null
}

export type ApproveFaqSetResult =
  | { kind: 'ok'; record: SeoFaqSetRecord }
  | { kind: 'not_found' }
  | { kind: 'stale'; currentSha256: string }
  | { kind: 'not_compliant'; problems: string[] }

export interface ApproveFaqSetInput {
  readonly expectedContentSha256: string
  readonly note?: string
  readonly userId: number
  readonly now?: Date
}

/**
 * The IRONCLAD human-approval gate (canon §1). Under a row lock:
 *   1. load the current row + recompute its fingerprint,
 *   2. reject if the reviewer's `expectedContentSha256` no longer matches
 *      (stale review — content changed after the page loaded),
 *   3. re-run the structural + sanitized-host compliance checks,
 *   4. mint a server-side approval id, write the append-only ledger row,
 *   5. bind the set to that approval (status='approved').
 */
export async function approveSeoFaqSet(
  faqSetId: string,
  input: ApproveFaqSetInput,
): Promise<ApproveFaqSetResult> {
  return withTransaction(async (client: PoolClient) => {
    const locked = await client.query<{
      faq_set_id: string
      scope: string
      items: unknown
    }>(
      `select faq_set_id, scope, items from seo_faq_sets where faq_set_id = $1 for update`,
      [faqSetId],
    )
    const lockedRow = locked.rows[0]
    if (!lockedRow) {
      return { kind: 'not_found' }
    }

    const items = parseItems(lockedRow.items)
    const itemInputs = toItemInputs(items)
    const currentSha256 = faqSetContentSha256({
      faq_set_id: lockedRow.faq_set_id,
      scope: lockedRow.scope,
      items: itemInputs,
    })
    if (currentSha256 !== input.expectedContentSha256) {
      return { kind: 'stale', currentSha256 }
    }

    const problems = checkFaqSetApprovable(itemInputs)
    if (problems.length > 0) {
      return {
        kind: 'not_compliant',
        problems: problems.map((p) =>
          p.itemIndex < 0 ? p.message : `Item ${p.itemIndex + 1} (${p.field}): ${p.message}`,
        ),
      }
    }

    const approvalId = newSeoApprovalId(input.now ?? new Date())
    await client.query(
      `
        insert into seo_approvals (
          approval_id, content_kind, content_ref, content_sha256,
          approved_by_user_id, note
        )
        values ($1, 'faq_set', $2, $3, $4, $5)
      `,
      [approvalId, faqSetId, currentSha256, input.userId, input.note ?? null],
    )

    const updated = await client.query<SeoFaqSetRow>(
      `
        update seo_faq_sets
           set status = 'approved',
               approval_id = $2,
               content_sha256 = $3,
               updated_by_user_id = $4,
               updated_at = now()
         where faq_set_id = $1
        returning
          faq_set_id, scope, status, source, items, content_sha256, approval_id,
          generation_meta, created_by_user_id, updated_by_user_id, created_at, updated_at,
          (select approved_by_user_id from seo_approvals where approval_id = $2) as approved_by_user_id,
          (select approved_at from seo_approvals where approval_id = $2) as approved_at,
          (select note from seo_approvals where approval_id = $2) as approval_note
      `,
      [faqSetId, approvalId, currentSha256, input.userId],
    )
    return { kind: 'ok', record: mapRow(updated.rows[0]!) }
  })
}
