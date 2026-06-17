// Query layer for the SEO auto-blog SOURCE-INGESTION brick (migration 091).
//
// Helios-driven SEO widgets — auto-blog source/topic intake (parent
// EPIC_PLAN §7.1, child FreshlyBakedNYC/automation#44, P4,
// Satisfies: virusdave/top-level#15).
//
// Backs the /api/seo/source-allowlist + /api/seo/source-items routes. The
// ingest path is FAIL-CLOSED against the operator-managed allowlist (the
// §7.1 "approved sources" guardrail) and idempotent on the dedup_hash, so
// re-ingesting the same link is a no-op rather than a duplicate.

import type {
  SeoSourceAllowlistRecord,
  SeoSourceItemRecord,
  SeoSourceItemStatus,
  SeoSourceKind,
} from '../../../shared/contracts/index.js'
import {
  newSourceItemId,
  normalizeSourceUrl,
  normalizeTagList,
  sourceItemDedupHash,
} from '../../seo/sourceContent.js'
import type { Queryable } from '../pool.js'
import { withTransaction } from '../tx.js'

// ── error type ────────────────────────────────────────────────────────

export type SeoSourceIngestErrorCode = 'unknown_source' | 'disabled_source'

/** Thrown by ingest when the source_key is not an enabled allowlist entry. */
export class SeoSourceIngestError extends Error {
  readonly code: SeoSourceIngestErrorCode
  constructor(code: SeoSourceIngestErrorCode, message: string) {
    super(message)
    this.name = 'SeoSourceIngestError'
    this.code = code
  }
}

// ── shared mapping helpers ────────────────────────────────────────────

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

function toStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map((v) => String(v)) : []
}

// ── allowlist ─────────────────────────────────────────────────────────

interface SeoSourceAllowlistRow {
  source_key: string
  kind: string
  display_name: string
  homepage_url: string | null
  enabled: boolean
  note: string | null
  created_by_user_id: string | number | null
  updated_by_user_id: string | number | null
  created_at: Date | string
  updated_at: Date | string
}

const SELECT_ALLOWLIST = `
  select
    source_key, kind, display_name, homepage_url, enabled, note,
    created_by_user_id, updated_by_user_id, created_at, updated_at
  from seo_source_allowlist
`

function mapAllowlistRow(row: SeoSourceAllowlistRow): SeoSourceAllowlistRecord {
  return {
    sourceKey: row.source_key,
    kind: row.kind as SeoSourceKind,
    displayName: row.display_name,
    homepageUrl: row.homepage_url,
    enabled: row.enabled,
    note: row.note,
    createdByUserId: toNumberOrNull(row.created_by_user_id),
    updatedByUserId: toNumberOrNull(row.updated_by_user_id),
    createdAt: toIsoString(row.created_at)!,
    updatedAt: toIsoString(row.updated_at)!,
  }
}

export async function listSeoSourceAllowlist(
  db: Queryable,
): Promise<SeoSourceAllowlistRecord[]> {
  const result = await db.query<SeoSourceAllowlistRow>(
    `${SELECT_ALLOWLIST} order by source_key asc`,
  )
  return result.rows.map(mapAllowlistRow)
}

export async function getSeoSourceAllowlistEntry(
  db: Queryable,
  sourceKey: string,
): Promise<SeoSourceAllowlistRecord | null> {
  const result = await db.query<SeoSourceAllowlistRow>(
    `${SELECT_ALLOWLIST} where source_key = $1`,
    [sourceKey],
  )
  const row = result.rows[0]
  return row ? mapAllowlistRow(row) : null
}

export interface UpsertSeoSourceAllowlistInput {
  readonly sourceKey: string
  readonly kind: SeoSourceKind
  readonly displayName: string
  readonly homepageUrl?: string | null
  readonly note?: string | null
  readonly enabled?: boolean
  readonly userId: number
}

/**
 * Insert or update an approved source. On conflict (existing source_key) the
 * mutable fields are replaced; `enabled` is only changed when the caller
 * explicitly provides it (so a metadata edit doesn't silently re-enable a
 * disabled source). Write-on-change is not required here — these are rare,
 * operator-initiated governance writes.
 */
export async function upsertSeoSourceAllowlist(
  db: Queryable,
  input: UpsertSeoSourceAllowlistInput,
): Promise<SeoSourceAllowlistRecord> {
  const result = await db.query<SeoSourceAllowlistRow>(
    `
      insert into seo_source_allowlist (
        source_key, kind, display_name, homepage_url, enabled, note,
        created_by_user_id, updated_by_user_id
      )
      values ($1, $2, $3, $4, coalesce($5, true), $6, $7, $7)
      on conflict (source_key) do update
        set kind = excluded.kind,
            display_name = excluded.display_name,
            homepage_url = excluded.homepage_url,
            note = excluded.note,
            enabled = coalesce($5, seo_source_allowlist.enabled),
            updated_by_user_id = excluded.updated_by_user_id,
            updated_at = now()
      returning
        source_key, kind, display_name, homepage_url, enabled, note,
        created_by_user_id, updated_by_user_id, created_at, updated_at
    `,
    [
      input.sourceKey,
      input.kind,
      input.displayName,
      input.homepageUrl ?? null,
      input.enabled === undefined ? null : input.enabled,
      input.note ?? null,
      input.userId,
    ],
  )
  return mapAllowlistRow(result.rows[0]!)
}

export async function setSeoSourceAllowlistEnabled(
  db: Queryable,
  sourceKey: string,
  enabled: boolean,
  userId: number,
): Promise<SeoSourceAllowlistRecord | null> {
  const result = await db.query<SeoSourceAllowlistRow>(
    `
      update seo_source_allowlist
         set enabled = $2, updated_by_user_id = $3, updated_at = now()
       where source_key = $1
      returning
        source_key, kind, display_name, homepage_url, enabled, note,
        created_by_user_id, updated_by_user_id, created_at, updated_at
    `,
    [sourceKey, enabled, userId],
  )
  const row = result.rows[0]
  return row ? mapAllowlistRow(row) : null
}

// ── source items ──────────────────────────────────────────────────────

interface SeoSourceItemRow {
  source_item_id: string
  source_key: string
  url: string | null
  title: string
  published_at: Date | string | null
  summary: string | null
  topic_tags: unknown
  risk_flags: unknown
  dedup_hash: string
  status: string
  ingest_source: string
  ingest_meta: unknown
  created_by_user_id: string | number | null
  updated_by_user_id: string | number | null
  created_at: Date | string
  updated_at: Date | string
}

const SELECT_SOURCE_ITEM = `
  select
    source_item_id, source_key, url, title, published_at, summary,
    topic_tags, risk_flags, dedup_hash, status, ingest_source, ingest_meta,
    created_by_user_id, updated_by_user_id, created_at, updated_at
  from seo_source_items
`

function mapSourceItemRow(row: SeoSourceItemRow): SeoSourceItemRecord {
  return {
    sourceItemId: row.source_item_id,
    sourceKey: row.source_key,
    url: row.url,
    title: row.title,
    publishedAt: toIsoString(row.published_at),
    summary: row.summary,
    topicTags: toStringArray(row.topic_tags),
    riskFlags: toStringArray(row.risk_flags),
    dedupHash: row.dedup_hash,
    status: row.status as SeoSourceItemStatus,
    ingestSource: row.ingest_source as SeoSourceItemRecord['ingestSource'],
    ingestMeta: row.ingest_meta ?? null,
    createdByUserId: toNumberOrNull(row.created_by_user_id),
    updatedByUserId: toNumberOrNull(row.updated_by_user_id),
    createdAt: toIsoString(row.created_at)!,
    updatedAt: toIsoString(row.updated_at)!,
  }
}

export interface ListSeoSourceItemsFilter {
  readonly status?: SeoSourceItemStatus
  readonly sourceKey?: string
  readonly limit?: number
}

export async function listSeoSourceItems(
  db: Queryable,
  filter: ListSeoSourceItemsFilter = {},
): Promise<SeoSourceItemRecord[]> {
  const where: string[] = []
  const params: unknown[] = []
  if (filter.status !== undefined) {
    params.push(filter.status)
    where.push(`status = $${params.length}`)
  }
  if (filter.sourceKey !== undefined) {
    params.push(filter.sourceKey)
    where.push(`source_key = $${params.length}`)
  }
  const whereSql = where.length > 0 ? `where ${where.join(' and ')}` : ''
  const limit = filter.limit ?? 200
  params.push(limit)
  const result = await db.query<SeoSourceItemRow>(
    `${SELECT_SOURCE_ITEM} ${whereSql} order by created_at desc, id desc limit $${params.length}`,
    params,
  )
  return result.rows.map(mapSourceItemRow)
}

export async function getSeoSourceItem(
  db: Queryable,
  sourceItemId: string,
): Promise<SeoSourceItemRecord | null> {
  const result = await db.query<SeoSourceItemRow>(
    `${SELECT_SOURCE_ITEM} where source_item_id = $1`,
    [sourceItemId],
  )
  const row = result.rows[0]
  return row ? mapSourceItemRow(row) : null
}

export interface IngestSeoSourceItemInput {
  readonly sourceKey: string
  readonly title: string
  readonly url?: string | null
  readonly publishedAt?: string | null
  readonly summary?: string | null
  readonly topicTags?: readonly string[]
  readonly riskFlags?: readonly string[]
  readonly ingestSource?: 'api' | 'manual'
  readonly ingestMeta?: unknown
  readonly userId: number
  readonly now?: Date
}

export interface IngestSeoSourceItemResult {
  readonly item: SeoSourceItemRecord
  /** True iff the item already existed (deduped) rather than newly inserted. */
  readonly deduped: boolean
}

/**
 * Record a source item. FAIL-CLOSED: the source_key must exist in the
 * allowlist AND be enabled (checked inside the transaction), else throws
 * {@link SeoSourceIngestError}. Idempotent on the dedup_hash — re-ingesting
 * the same link returns the existing row with `deduped: true` instead of
 * creating a duplicate. The dedup identity is `(source_key, link)` (see
 * sourceContent.ts).
 */
export async function ingestSeoSourceItem(
  input: IngestSeoSourceItemInput,
): Promise<IngestSeoSourceItemResult> {
  const now = input.now ?? new Date()
  const url = normalizeSourceUrl(input.url)
  const dedupHash = sourceItemDedupHash({
    sourceKey: input.sourceKey,
    url,
    title: input.title,
  })
  const topicTags = normalizeTagList(input.topicTags)
  const riskFlags = normalizeTagList(input.riskFlags)

  return withTransaction(async (client) => {
    // Fail-closed allowlist gate. Lock the row so a concurrent disable can't
    // race the insert.
    const allow = await client.query<{ enabled: boolean }>(
      `select enabled from seo_source_allowlist where source_key = $1 for share`,
      [input.sourceKey],
    )
    if (allow.rows.length === 0) {
      throw new SeoSourceIngestError(
        'unknown_source',
        `source_key ${JSON.stringify(input.sourceKey)} is not on the approved-source allowlist.`,
      )
    }
    if (allow.rows[0]!.enabled !== true) {
      throw new SeoSourceIngestError(
        'disabled_source',
        `source_key ${JSON.stringify(input.sourceKey)} is on the allowlist but disabled.`,
      )
    }

    const inserted = await client.query<SeoSourceItemRow>(
      `
        insert into seo_source_items (
          source_item_id, source_key, url, title, published_at, summary,
          topic_tags, risk_flags, dedup_hash, status, ingest_source,
          ingest_meta, created_by_user_id, updated_by_user_id
        )
        values (
          $1, $2, $3, $4, $5, $6, $7::text[], $8::text[], $9, 'new', $10,
          $11::jsonb, $12, $12
        )
        on conflict (dedup_hash) do nothing
        returning
          source_item_id, source_key, url, title, published_at, summary,
          topic_tags, risk_flags, dedup_hash, status, ingest_source, ingest_meta,
          created_by_user_id, updated_by_user_id, created_at, updated_at
      `,
      [
        newSourceItemId(now),
        input.sourceKey,
        url,
        input.title.trim(),
        input.publishedAt ?? null,
        input.summary ?? null,
        topicTags,
        riskFlags,
        dedupHash,
        input.ingestSource ?? 'api',
        input.ingestMeta === undefined ? null : JSON.stringify(input.ingestMeta),
        input.userId,
      ],
    )

    if (inserted.rows.length > 0) {
      return { item: mapSourceItemRow(inserted.rows[0]!), deduped: false }
    }

    // Conflict on dedup_hash: return the pre-existing row.
    const existing = await client.query<SeoSourceItemRow>(
      `${SELECT_SOURCE_ITEM} where dedup_hash = $1`,
      [dedupHash],
    )
    return { item: mapSourceItemRow(existing.rows[0]!), deduped: true }
  })
}

export async function setSeoSourceItemStatus(
  db: Queryable,
  sourceItemId: string,
  status: SeoSourceItemStatus,
  userId: number,
): Promise<SeoSourceItemRecord | null> {
  const result = await db.query<SeoSourceItemRow>(
    `
      update seo_source_items
         set status = $2, updated_by_user_id = $3, updated_at = now()
       where source_item_id = $1
      returning
        source_item_id, source_key, url, title, published_at, summary,
        topic_tags, risk_flags, dedup_hash, status, ingest_source, ingest_meta,
        created_by_user_id, updated_by_user_id, created_at, updated_at
    `,
    [sourceItemId, status, userId],
  )
  const row = result.rows[0]
  return row ? mapSourceItemRow(row) : null
}
