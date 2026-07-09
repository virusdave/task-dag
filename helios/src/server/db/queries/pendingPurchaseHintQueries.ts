// Query layer for the prospective pending-purchase classifier's HINT BUNDLE
// storage (migration 094, child FreshlyBakedNYC/automation#54, task C2).
//
// Backs the /api/catalog/pending-purchases/hint-bundles admin routes and the
// generate-route validation that a referenced hintBundleId exists + is
// active. v1 = pasted arbitrary hint TEXT only; documents are treated as
// untrusted DATA, never instructions. Adding a document is idempotent on the
// per-bundle content hash, so re-pasting identical text is a no-op.
//
// Satisfies: virusdave/top-level#33

import type {
  PendingPurchaseHintBundleDetail,
  PendingPurchaseHintBundleFact,
  PendingPurchaseHintBundleGlossaryEntry,
  PendingPurchaseHintBundleRecord,
  PendingPurchaseHintBundleStatus,
  PendingPurchaseHintDocumentKind,
  PendingPurchaseHintDocumentRecord,
  PendingPurchaseHintExtractionStatus,
  PendingPurchaseHintIntent,
} from '../../../shared/contracts/index.js'
import { PendingPurchaseHintExtractedFactsSchema } from '../../../shared/contracts/index.js'
import { newHintBundleId, newHintDocumentId } from '../../pendingPurchases/hintContent.js'
import type { Queryable } from '../pool.js'
import { withTransaction } from '../tx.js'

// ── error type ────────────────────────────────────────────────────────

export type HintBundleMutationErrorCode = 'bundle_not_found' | 'bundle_archived'

/** Thrown when a document is added to a missing or archived bundle. */
export class HintBundleMutationError extends Error {
  readonly code: HintBundleMutationErrorCode
  constructor(code: HintBundleMutationErrorCode, message: string) {
    super(message)
    this.name = 'HintBundleMutationError'
    this.code = code
  }
}

// ── shared mapping helpers ────────────────────────────────────────────

function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}

function toNumberOrNull(value: string | number | null): number | null {
  if (value === null) {
    return null
  }
  return typeof value === 'number' ? value : Number.parseInt(value, 10)
}

// ── bundles ───────────────────────────────────────────────────────────

interface HintBundleRow {
  hint_bundle_id: string
  label: string
  note: string | null
  status: string
  document_count: string | number
  created_by_user_id: string | number | null
  updated_by_user_id: string | number | null
  created_at: Date | string
  updated_at: Date | string
}

function mapBundleRow(row: HintBundleRow): PendingPurchaseHintBundleRecord {
  return {
    hintBundleId: row.hint_bundle_id,
    label: row.label,
    note: row.note,
    status: row.status as PendingPurchaseHintBundleStatus,
    documentCount:
      typeof row.document_count === 'number'
        ? row.document_count
        : Number.parseInt(row.document_count, 10),
    createdByUserId: toNumberOrNull(row.created_by_user_id),
    updatedByUserId: toNumberOrNull(row.updated_by_user_id),
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
  }
}

const SELECT_BUNDLE_WITH_COUNT = `
  select
    b.hint_bundle_id, b.label, b.note, b.status,
    coalesce(d.document_count, 0) as document_count,
    b.created_by_user_id, b.updated_by_user_id, b.created_at, b.updated_at
  from pending_purchase_hint_bundles b
  left join (
    select bundle_id, count(*) as document_count
      from pending_purchase_hint_documents
     group by bundle_id
  ) d on d.bundle_id = b.id
`

export interface ListHintBundlesFilter {
  readonly status?: PendingPurchaseHintBundleStatus
  readonly limit?: number
}

export async function listPendingPurchaseHintBundles(
  db: Queryable,
  filter: ListHintBundlesFilter = {},
): Promise<PendingPurchaseHintBundleRecord[]> {
  const params: unknown[] = []
  let whereSql = ''
  if (filter.status !== undefined) {
    params.push(filter.status)
    whereSql = `where b.status = $${params.length}`
  }
  const limit = filter.limit ?? 200
  params.push(limit)
  const result = await db.query<HintBundleRow>(
    `${SELECT_BUNDLE_WITH_COUNT} ${whereSql}
       order by b.created_at desc, b.id desc
       limit $${params.length}`,
    params,
  )
  return result.rows.map(mapBundleRow)
}

export async function getPendingPurchaseHintBundle(
  db: Queryable,
  hintBundleId: string,
): Promise<PendingPurchaseHintBundleRecord | null> {
  const result = await db.query<HintBundleRow>(
    `${SELECT_BUNDLE_WITH_COUNT} where b.hint_bundle_id = $1`,
    [hintBundleId],
  )
  const row = result.rows[0]
  return row ? mapBundleRow(row) : null
}

export async function getPendingPurchaseHintBundleDetail(
  db: Queryable,
  hintBundleId: string,
): Promise<PendingPurchaseHintBundleDetail | null> {
  const bundle = await getPendingPurchaseHintBundle(db, hintBundleId)
  if (!bundle) {
    return null
  }
  const documents = await listPendingPurchaseHintDocuments(db, hintBundleId)
  return { ...bundle, documents }
}

export interface CreateHintBundleInput {
  readonly label: string
  readonly note?: string | null
  readonly userId: number
  readonly now?: Date
}

export async function createPendingPurchaseHintBundle(
  db: Queryable,
  input: CreateHintBundleInput,
): Promise<PendingPurchaseHintBundleRecord> {
  const now = input.now ?? new Date()
  const result = await db.query<HintBundleRow>(
    `
      with inserted as (
        insert into pending_purchase_hint_bundles (
          hint_bundle_id, label, note, created_by_user_id, updated_by_user_id
        )
        values ($1, $2, $3, $4, $4)
        returning
          id, hint_bundle_id, label, note, status,
          created_by_user_id, updated_by_user_id, created_at, updated_at
      )
      select
        hint_bundle_id, label, note, status, 0 as document_count,
        created_by_user_id, updated_by_user_id, created_at, updated_at
      from inserted
    `,
    [newHintBundleId(now), input.label.trim(), input.note ?? null, input.userId],
  )
  return mapBundleRow(result.rows[0]!)
}

export interface UpdateHintBundleInput {
  readonly label?: string
  readonly note?: string | null
  readonly status?: PendingPurchaseHintBundleStatus
  readonly userId: number
}

/**
 * Sparse update of a bundle's mutable fields. A field is changed only when
 * the caller provides the key (coalesce-on-null param), so a note-only edit
 * never resets the label or status. Low-rate admin governance write —
 * last-write-wins, no optimistic version.
 */
export async function updatePendingPurchaseHintBundle(
  db: Queryable,
  hintBundleId: string,
  input: UpdateHintBundleInput,
): Promise<PendingPurchaseHintBundleRecord | null> {
  const result = await db.query<{ hint_bundle_id: string }>(
    `
      update pending_purchase_hint_bundles
         set label = coalesce($2, label),
             note = case when $3::boolean then $4 else note end,
             status = coalesce($5, status),
             updated_by_user_id = $6,
             updated_at = now()
       where hint_bundle_id = $1
      returning hint_bundle_id
    `,
    [
      hintBundleId,
      input.label === undefined ? null : input.label.trim(),
      input.note !== undefined,
      input.note ?? null,
      input.status ?? null,
      input.userId,
    ],
  )
  if (result.rows.length === 0) {
    return null
  }
  return getPendingPurchaseHintBundle(db, hintBundleId)
}

// ── documents ─────────────────────────────────────────────────────────

interface HintDocumentRow {
  hint_document_id: string
  bundle_public_id: string
  kind: string
  source_label: string | null
  content_sha256: string
  storage_backend: string
  byte_size: string | number
  hint_intent: string | null
  extraction_status: string
  extraction_error: string | null
  extracted_facts: unknown
  created_by_user_id: string | number | null
  updated_by_user_id: string | number | null
  created_at: Date | string
  updated_at: Date | string
}

function mapDocumentRow(row: HintDocumentRow): PendingPurchaseHintDocumentRecord {
  return {
    hintDocumentId: row.hint_document_id,
    bundleId: row.bundle_public_id,
    kind: row.kind as PendingPurchaseHintDocumentKind,
    sourceLabel: row.source_label,
    // Pointer metadata only — the bytes live out-of-band, and storage_uri (an
    // internal path) is deliberately NOT exposed in the API record.
    contentSha256: row.content_sha256,
    storageBackend: row.storage_backend as PendingPurchaseHintDocumentRecord['storageBackend'],
    byteSize: typeof row.byte_size === 'number' ? row.byte_size : Number.parseInt(row.byte_size, 10),
    hintIntent: row.hint_intent,
    extractionStatus: row.extraction_status as PendingPurchaseHintExtractionStatus,
    extractionError: row.extraction_error,
    extractedFacts: row.extracted_facts ?? null,
    createdByUserId: toNumberOrNull(row.created_by_user_id),
    updatedByUserId: toNumberOrNull(row.updated_by_user_id),
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
  }
}

const SELECT_DOCUMENT = `
  select
    d.hint_document_id, b.hint_bundle_id as bundle_public_id, d.kind,
    d.source_label, d.content_sha256, d.storage_backend, d.byte_size,
    d.hint_intent, d.extraction_status, d.extraction_error, d.extracted_facts,
    d.created_by_user_id, d.updated_by_user_id, d.created_at, d.updated_at
  from pending_purchase_hint_documents d
  join pending_purchase_hint_bundles b on b.id = d.bundle_id
`

export async function listPendingPurchaseHintDocuments(
  db: Queryable,
  hintBundleId: string,
): Promise<PendingPurchaseHintDocumentRecord[]> {
  const result = await db.query<HintDocumentRow>(
    `${SELECT_DOCUMENT} where b.hint_bundle_id = $1 order by d.created_at desc, d.id desc`,
    [hintBundleId],
  )
  return result.rows.map(mapDocumentRow)
}

export interface AddHintDocumentInput {
  readonly hintBundleId: string
  readonly kind: PendingPurchaseHintDocumentKind
  readonly sourceLabel?: string | null
  // Out-of-band blob pointer — the caller (route) has already written the
  // bytes to the content-addressed store and passes the resulting pointer.
  readonly contentSha256: string
  readonly storageBackend: 'fs' | 's3'
  readonly storageUri: string
  readonly byteSize: number
  readonly userId: number
  readonly now?: Date
}

export interface AddHintDocumentResult {
  readonly document: PendingPurchaseHintDocumentRecord
  /** True iff identical text already existed in the bundle (deduped). */
  readonly deduped: boolean
}

/**
 * Insert a pointer row for a hint document already written to the out-of-band
 * blob store. Fail-closed: the bundle must exist AND be active (locked FOR
 * SHARE so a concurrent archive can't race the insert), else throws
 * {@link HintBundleMutationError}. Idempotent on the per-bundle content hash —
 * re-adding identical text returns the existing row with `deduped: true`
 * instead of a 23505 (and the blob, being content-addressed, is the same).
 */
export async function addPendingPurchaseHintDocument(
  input: AddHintDocumentInput,
): Promise<AddHintDocumentResult> {
  const now = input.now ?? new Date()

  return withTransaction(async (client) => {
    const bundle = await client.query<{ id: string; status: string }>(
      `select id, status from pending_purchase_hint_bundles where hint_bundle_id = $1 for share`,
      [input.hintBundleId],
    )
    if (bundle.rows.length === 0) {
      throw new HintBundleMutationError(
        'bundle_not_found',
        `hint bundle ${JSON.stringify(input.hintBundleId)} was not found.`,
      )
    }
    if (bundle.rows[0]!.status !== 'active') {
      throw new HintBundleMutationError(
        'bundle_archived',
        `hint bundle ${JSON.stringify(input.hintBundleId)} is archived; un-archive it before adding documents.`,
      )
    }
    const bundleId = bundle.rows[0]!.id

    const inserted = await client.query<HintDocumentRow>(
      `
        with ins as (
          insert into pending_purchase_hint_documents (
            hint_document_id, bundle_id, kind, source_label, content_sha256,
            storage_backend, storage_uri, byte_size,
            created_by_user_id, updated_by_user_id
          )
          values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)
          on conflict (bundle_id, content_sha256) do nothing
          returning *
        )
        select
          ins.hint_document_id, $10 as bundle_public_id, ins.kind,
          ins.source_label, ins.content_sha256, ins.storage_backend, ins.byte_size,
          ins.hint_intent, ins.extraction_status, ins.extraction_error, ins.extracted_facts,
          ins.created_by_user_id, ins.updated_by_user_id, ins.created_at, ins.updated_at
        from ins
      `,
      [
        newHintDocumentId(now),
        bundleId,
        input.kind,
        input.sourceLabel ?? null,
        input.contentSha256,
        input.storageBackend,
        input.storageUri,
        input.byteSize,
        input.userId,
        input.hintBundleId,
      ],
    )

    if (inserted.rows.length > 0) {
      return { document: mapDocumentRow(inserted.rows[0]!), deduped: false }
    }

    // Conflict on (bundle_id, content_sha256): return the pre-existing row.
    const existing = await client.query<HintDocumentRow>(
      `${SELECT_DOCUMENT} where d.bundle_id = $1 and d.content_sha256 = $2`,
      [bundleId, input.contentSha256],
    )
    return { document: mapDocumentRow(existing.rows[0]!), deduped: true }
  })
}

export interface HintDocumentPointer {
  readonly contentSha256: string
  readonly storageBackend: 'fs' | 's3'
  readonly storageUri: string
  readonly byteSize: number
}

/**
 * Fetch the out-of-band blob pointer for one document, scoped by BOTH the
 * bundle and document public ids (so a mismatched URL can't read an unrelated
 * document). Used by the content endpoint to read bytes back from the store.
 */
export async function getPendingPurchaseHintDocumentPointer(
  db: Queryable,
  hintBundleId: string,
  hintDocumentId: string,
): Promise<HintDocumentPointer | null> {
  const result = await db.query<{
    content_sha256: string
    storage_backend: string
    storage_uri: string
    byte_size: string | number
  }>(
    `
      select d.content_sha256, d.storage_backend, d.storage_uri, d.byte_size
        from pending_purchase_hint_documents d
        join pending_purchase_hint_bundles b on b.id = d.bundle_id
       where b.hint_bundle_id = $1 and d.hint_document_id = $2
    `,
    [hintBundleId, hintDocumentId],
  )
  const row = result.rows[0]
  if (!row) {
    return null
  }
  return {
    contentSha256: row.content_sha256,
    storageBackend: row.storage_backend as 'fs' | 's3',
    storageUri: row.storage_uri,
    byteSize: typeof row.byte_size === 'number' ? row.byte_size : Number.parseInt(row.byte_size, 10),
  }
}

/**
 * Hard-delete a single document, scoped by BOTH the bundle and document
 * public ids so a mismatched URL can never delete an unrelated document.
 * Returns true iff a row was removed.
 */
export async function deletePendingPurchaseHintDocument(
  db: Queryable,
  hintBundleId: string,
  hintDocumentId: string,
): Promise<boolean> {
  const result = await db.query(
    `
      delete from pending_purchase_hint_documents d
       using pending_purchase_hint_bundles b
       where d.bundle_id = b.id
         and b.hint_bundle_id = $1
         and d.hint_document_id = $2
    `,
    [hintBundleId, hintDocumentId],
  )
  return (result.rowCount ?? 0) > 0
}

// ── extraction (C3) ───────────────────────────────────────────────────

export interface RecordHintDocumentExtractionInput {
  readonly hintDocumentId: string
  readonly hintIntent: PendingPurchaseHintIntent | null
  readonly extractionStatus: PendingPurchaseHintExtractionStatus
  readonly extractionError: string | null
  /**
   * The validated `extracted_facts` payload, or null. On a `failed`/`skipped`
   * outcome pass null so a prior successful payload is CLEARED — C4 must never
   * read stale facts off a document that later failed re-extraction.
   */
  readonly extractedFacts: unknown
  readonly userId?: number | null
  /**
   * When false (a non-forced pass), the write is GUARDED: it will not
   * overwrite a row another job already moved to `extracted`. This stops a
   * slow stale job (e.g. one that started before the Mantle token was
   * restored) from clobbering a newer successful extraction. When true (an
   * operator force re-extract), the row is always overwritten.
   */
  readonly force?: boolean
}

/**
 * Persist the result of one document's extraction pass (C3). Scoped by the
 * document public id; returns true iff a row was written (false when the
 * non-force guard declined an already-extracted row, or the doc is missing).
 */
export async function recordPendingPurchaseHintDocumentExtraction(
  db: Queryable,
  input: RecordHintDocumentExtractionInput,
): Promise<boolean> {
  const result = await db.query(
    `
      update pending_purchase_hint_documents
         set hint_intent = $2,
             extraction_status = $3,
             extraction_error = $4,
             extracted_facts = $5::jsonb,
             updated_by_user_id = coalesce($6, updated_by_user_id),
             updated_at = now()
       where hint_document_id = $1
         and ($7::boolean or extraction_status <> 'extracted')
    `,
    [
      input.hintDocumentId,
      input.hintIntent,
      input.extractionStatus,
      input.extractionError,
      input.extractedFacts === null || input.extractedFacts === undefined
        ? null
        : JSON.stringify(input.extractedFacts),
      input.userId ?? null,
      input.force ?? false,
    ],
  )
  return (result.rowCount ?? 0) > 0
}

interface HintFactDocumentRow {
  hint_document_id: string
  bundle_public_id: string
  kind: string
  source_label: string | null
  content_sha256: string
  extracted_facts: unknown
}

export interface PendingPurchaseHintExtractionProgress {
  /** Total documents in the bundle. */
  readonly total: number
  /** Documents still awaiting extraction (extraction_status = 'pending'). */
  readonly pending: number
  /** Documents that produced usable facts. */
  readonly extracted: number
  /** Documents whose extraction failed. */
  readonly failed: number
  /** Documents deliberately skipped (e.g. unsupported content). */
  readonly skipped: number
}

/**
 * Cheap status roll-up for a bundle's documents (no facts pulled). Lets the
 * generate job distinguish "extraction still in flight" (defer + retry) from
 * "extraction finished but produced nothing" (fail loud). This closes the
 * enqueue race where a packet-generation job is queued by the same operator
 * action that just added a hint document — before the async C3 extraction job
 * has run.
 */
export async function getPendingPurchaseHintExtractionProgress(
  db: Queryable,
  hintBundleId: string,
): Promise<PendingPurchaseHintExtractionProgress> {
  const result = await db.query<{
    total: string | number
    pending: string | number
    extracted: string | number
    failed: string | number
    skipped: string | number
  }>(
    `
      select
        count(*) as total,
        count(*) filter (where d.extraction_status = 'pending') as pending,
        count(*) filter (where d.extraction_status = 'extracted') as extracted,
        count(*) filter (where d.extraction_status = 'failed') as failed,
        count(*) filter (where d.extraction_status = 'skipped') as skipped
      from pending_purchase_hint_documents d
      join pending_purchase_hint_bundles b on b.id = d.bundle_id
      where b.hint_bundle_id = $1
    `,
    [hintBundleId],
  )
  const row = result.rows[0]
  const toInt = (value: string | number | null | undefined): number =>
    typeof value === 'number' ? value : Number.parseInt(value ?? '0', 10)
  return {
    total: toInt(row?.total),
    pending: toInt(row?.pending),
    extracted: toInt(row?.extracted),
    failed: toInt(row?.failed),
    skipped: toInt(row?.skipped),
  }
}

/**
 * Flatten every successfully-extracted fact across an active bundle's
 * documents, attaching the owning-document context each citation needs. This
 * is the read surface the classifier (C4) consumes. Documents that are still
 * pending / failed / skipped — or whose stored payload no longer matches the
 * current contract — contribute nothing rather than poisoning the result.
 */
export async function loadExtractedPendingPurchaseHintFactsForBundle(
  db: Queryable,
  hintBundleId: string,
): Promise<PendingPurchaseHintBundleFact[]> {
  const result = await db.query<HintFactDocumentRow>(
    `
      select
        d.hint_document_id, b.hint_bundle_id as bundle_public_id, d.kind,
        d.source_label, d.content_sha256, d.extracted_facts
      from pending_purchase_hint_documents d
      join pending_purchase_hint_bundles b on b.id = d.bundle_id
      where b.hint_bundle_id = $1
        and d.extraction_status = 'extracted'
        and d.extracted_facts is not null
      order by d.created_at asc, d.id asc
    `,
    [hintBundleId],
  )

  const flattened: PendingPurchaseHintBundleFact[] = []
  for (const row of result.rows) {
    const parsed = PendingPurchaseHintExtractedFactsSchema.safeParse(row.extracted_facts)
    if (!parsed.success) {
      // A stored payload that no longer matches the contract is a defect to
      // surface (re-extract), not silent garbage to feed the classifier.
      console.warn(
        `[hintFacts] document ${row.hint_document_id} has extracted_facts that fail the current contract; skipping.`,
      )
      continue
    }
    for (const fact of parsed.data.facts) {
      flattened.push({
        hintBundleId: row.bundle_public_id,
        hintDocumentId: row.hint_document_id,
        // The DB kind check constrains this to the document-kind enum.
        kind: row.kind as PendingPurchaseHintDocumentKind,
        sourceLabel: row.source_label,
        contentSha256: row.content_sha256,
        intent: parsed.data.intent,
        extractor: parsed.data.extractor,
        fact,
      })
    }
  }
  return flattened
}

/**
 * The out-of-band blob pointer for one `operator_note` document, plus the
 * public id / source label the classifier needs to label the guidance. Unlike
 * facts/glossary this carries a pointer, not extracted text: an operator note
 * is TRUSTED operator guidance fed to C4 VERBATIM, so it must survive even when
 * C3 extraction produced no structured facts (the #69 failure mode).
 */
export interface PendingPurchaseHintOperatorNotePointer {
  readonly hintDocumentId: string
  readonly sourceLabel: string | null
  readonly pointer: HintDocumentPointer
}

/**
 * Fetch the blob pointers for every `operator_note`-kind document in a bundle,
 * ordered oldest-first. Only `operator_note` is authored by the authenticated
 * operator via the admin hint UI, so only this kind is elevated to trusted
 * verbatim guidance for C4; `distributor_menu` / `sibling_purchase_order` /
 * `other` are pasted external material and stay untrusted (structured facts
 * only). Extraction status is intentionally NOT filtered: an operator note
 * whose C3 pass produced 0 facts / 0 glossary (or failed/skipped) must still
 * reach the classifier as guidance.
 */
export async function loadPendingPurchaseHintOperatorNotesForBundle(
  db: Queryable,
  hintBundleId: string,
): Promise<PendingPurchaseHintOperatorNotePointer[]> {
  const result = await db.query<{
    hint_document_id: string
    source_label: string | null
    content_sha256: string
    storage_backend: string
    storage_uri: string
    byte_size: string | number
  }>(
    `
      select
        d.hint_document_id, d.source_label,
        d.content_sha256, d.storage_backend, d.storage_uri, d.byte_size
      from pending_purchase_hint_documents d
      join pending_purchase_hint_bundles b on b.id = d.bundle_id
      where b.hint_bundle_id = $1
        and d.kind = 'operator_note'
      order by d.created_at asc, d.id asc
    `,
    [hintBundleId],
  )
  return result.rows.map((row) => ({
    hintDocumentId: row.hint_document_id,
    sourceLabel: row.source_label,
    pointer: {
      contentSha256: row.content_sha256,
      storageBackend: row.storage_backend as 'fs' | 's3',
      storageUri: row.storage_uri,
      byteSize: typeof row.byte_size === 'number' ? row.byte_size : Number.parseInt(row.byte_size, 10),
    },
  }))
}

/**
 * Flatten every successfully-extracted glossary / acronym-expansion entry
 * across an active bundle's documents, attaching the owning-document context
 * each citation needs. This is a SEPARATE read surface from
 * loadExtractedPendingPurchaseHintFactsForBundle: glossary entries are cited,
 * inert INTERPRETATION evidence (e.g. "PR = Preroll", "METRC = …") the C4
 * classifier uses to decode abbreviated line-item names, never product facts.
 * Same skip-on-contract-mismatch posture: a v1 payload (no glossaryEntries)
 * and any row failing the current contract simply contribute nothing.
 */
export async function loadExtractedPendingPurchaseHintGlossaryForBundle(
  db: Queryable,
  hintBundleId: string,
): Promise<PendingPurchaseHintBundleGlossaryEntry[]> {
  const result = await db.query<HintFactDocumentRow>(
    `
      select
        d.hint_document_id, b.hint_bundle_id as bundle_public_id, d.kind,
        d.source_label, d.content_sha256, d.extracted_facts
      from pending_purchase_hint_documents d
      join pending_purchase_hint_bundles b on b.id = d.bundle_id
      where b.hint_bundle_id = $1
        and d.extraction_status = 'extracted'
        and d.extracted_facts is not null
      order by d.created_at asc, d.id asc
    `,
    [hintBundleId],
  )

  const flattened: PendingPurchaseHintBundleGlossaryEntry[] = []
  for (const row of result.rows) {
    const parsed = PendingPurchaseHintExtractedFactsSchema.safeParse(row.extracted_facts)
    if (!parsed.success) {
      // A stored payload that no longer matches the contract is a defect to
      // surface (re-extract), not silent garbage to feed the classifier.
      console.warn(
        `[hintFacts] document ${row.hint_document_id} has extracted_facts that fail the current contract; skipping (glossary).`,
      )
      continue
    }
    for (const entry of parsed.data.glossaryEntries) {
      flattened.push({
        hintBundleId: row.bundle_public_id,
        hintDocumentId: row.hint_document_id,
        // The DB kind check constrains this to the document-kind enum.
        kind: row.kind as PendingPurchaseHintDocumentKind,
        sourceLabel: row.source_label,
        contentSha256: row.content_sha256,
        intent: parsed.data.intent,
        extractor: parsed.data.extractor,
        entry,
      })
    }
  }
  return flattened
}
