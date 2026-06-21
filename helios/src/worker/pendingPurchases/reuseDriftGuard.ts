// Apply-time generated-reuse drift guard — the C7 safety check
// (child FreshlyBakedNYC/automation#54, task C7, parent virusdave/top-level#33).
//
// The C5 deterministic validator (reconcilePendingPurchaseDrafts.ts) only
// promotes an LLM-proposed reuse to an authoritative `reuseProductId` after the
// candidate survives lane-by-lane validation against the LIVE catalog, and it
// freezes a `ReconciledReuseSnapshot` of that live product at validation time.
//
// The apply job runs much later — after the operator reviews and approves the
// packet. Between validation and apply the live Sweed product can DRIFT: it can
// be renamed, re-branded, moved to a different group/category, resized,
// re-packed, re-tabbed, or soft-retired (renamed to start with DEAD/RETIRED/…).
// Linking a delivery line onto a product whose identity no longer matches what
// the validator confirmed would silently mis-map a regulated catalog record.
//
// This module is the deterministic gate that catches that. It is a PURE
// function: no DB, no network, no clock. `detectReuseDrift` returns one
// human-readable description per drifted identity lane (empty ⇒ no drift). The
// apply job blocks the row (requires a reviewer to re-confirm the link) when the
// result is non-empty.
//
// It deliberately compares ONLY identity lanes — never operational fields the
// apply is allowed to mutate (price, ecommerce visibility, allowed sale type,
// packed state, image, description). Equality uses the EXACT same normalization
// the validator uses (`laneKey` / `sizeKey`), so a purely cosmetic case- or
// whitespace-difference between the catalog-cache snapshot and the apply-time
// RPC read is never a false drift.
//
// Satisfies: virusdave/top-level#33

import type { ReconciledReuseSnapshot } from './reconcilePendingPurchaseDrafts.js'
import { laneKey, sizeKey } from './reconcilePendingPurchaseDrafts.js'

/**
 * The live product identity, read from Sweed at apply time, in the same field
 * vocabulary as {@link ReconciledReuseSnapshot}. The apply job builds this from
 * the `store.product.get` + `store.product.group.get` reads it already performs
 * for a reuse row; the builder lives there because it depends on the Sweed
 * response schemas. Strings must already be trimmed-or-null (empty ⇒ null) and
 * `packCount` must be a positive integer or null.
 */
export interface LiveReuseProductFacts {
  readonly productId: number
  readonly productName: string | null
  readonly groupId: number | null
  readonly brand: string | null
  readonly category: string | null
  readonly subcategory: string | null
  readonly groupName: string | null
  readonly variantTab: string | null
  readonly strain: string | null
  readonly size: string | null
  readonly packCount: number | null
}

/**
 * Normalize a pack count for comparison. Sweed/Helios treat an absent pack
 * count as a single-unit product, so `null` and `1` are the same identity. This
 * matches the generator's live-product summary (`packOfSize ?? 1`) so a
 * single-pack product never falsely drifts `null` vs `1`. A genuine 1→N (or
 * N→M) change is still caught.
 */
function normalizedPackCount(value: number | null): number {
  return value !== null && Number.isInteger(value) && value > 0 ? value : 1
}

/** Render a nullable lane value for an operator-facing drift message. */
function display(value: string | null): string {
  return value === null ? '∅' : `"${value}"`
}

/**
 * Compare the validator's frozen reuse snapshot against the live product read at
 * apply time. Returns one description per drifted identity lane; an empty array
 * means the live product still matches what was validated.
 *
 * Compares every identity lane the snapshot carries:
 *   - product id (exact),
 *   - group id (exact, null-aware),
 *   - pack count (exact, null≡1),
 *   - product name / brand / category / subcategory / group name / variant tab /
 *     strain (case- and whitespace-insensitive, via `laneKey`),
 *   - size (whitespace-collapsed, via `sizeKey`).
 */
export function detectReuseDrift(
  snapshot: ReconciledReuseSnapshot,
  live: LiveReuseProductFacts,
): string[] {
  const drifts: string[] = []

  if (snapshot.productId !== live.productId) {
    drifts.push(`product id (validated ${snapshot.productId}, live ${live.productId})`)
  }

  if ((snapshot.groupId ?? null) !== (live.groupId ?? null)) {
    drifts.push(`group id (validated ${snapshot.groupId ?? 'none'}, live ${live.groupId ?? 'none'})`)
  }

  if (normalizedPackCount(snapshot.packCount) !== normalizedPackCount(live.packCount)) {
    drifts.push(`pack count (validated ${snapshot.packCount ?? 1}, live ${live.packCount ?? 1})`)
  }

  const laneFields: ReadonlyArray<readonly [string, string | null, string | null]> = [
    ['product name', snapshot.productName, live.productName],
    ['brand', snapshot.brand, live.brand],
    ['category', snapshot.category, live.category],
    ['subcategory', snapshot.subcategory, live.subcategory],
    ['group name', snapshot.groupName, live.groupName],
    ['variant tab', snapshot.variantTab, live.variantTab],
    ['strain', snapshot.strain, live.strain],
  ]
  for (const [label, snapshotValue, liveValue] of laneFields) {
    if (laneKey(snapshotValue) !== laneKey(liveValue)) {
      drifts.push(`${label} (validated ${display(snapshotValue)}, live ${display(liveValue)})`)
    }
  }

  if (sizeKey(snapshot.size) !== sizeKey(live.size)) {
    drifts.push(`size (validated ${display(snapshot.size)}, live ${display(live.size)})`)
  }

  return drifts
}

/**
 * Three-state result of reading `raw_row_json.validatedReuseSnapshot` (parsed by
 * the apply job, which owns the persistence/zod boundary):
 *  - `absent`: no snapshot. Allowed ONLY for pre-C8 legacy generator rows so the
 *    current live apply path keeps working through the C7→C8 window.
 *  - `valid`: a parseable snapshot to compare against live state.
 *  - `malformed`: present but unreadable — untrustworthy safety metadata.
 */
export type ParsedReuseSnapshot =
  | { kind: 'absent' }
  | { kind: 'valid'; snapshot: ReconciledReuseSnapshot }
  | { kind: 'malformed'; error: string }

/** A `block` verdict carries the operator-facing reason thrown by the apply job. */
export type ReuseDriftBlock = { kind: 'block'; reason: string }

/**
 * Result of the RPC-INDEPENDENT precheck (run BEFORE any Sweed read):
 *  - `skip`: not a generator reuse (catalog-create / reviewer override) or a
 *    legacy snapshot-absent row — no guard, proceed normally.
 *  - `block`: a deterministic, row-level block (malformed snapshot, or a
 *    snapshot whose productId disagrees with the row). These never depend on a
 *    live read, so they must be decided before the Sweed RPCs so a transient RPC
 *    failure can't mask them (turning a deterministic `blocked` into `failed`).
 *  - `compare-live`: a guarded generator reuse with a valid snapshot — the apply
 *    job must load the live product+group and call {@link compareLiveReuse}.
 */
export type ReuseDriftPrecheck =
  | { kind: 'skip' }
  | ReuseDriftBlock
  | { kind: 'compare-live'; snapshot: ReconciledReuseSnapshot }

export interface ReuseDriftPrecheckInput {
  readonly rowId: number
  readonly reuseProductId: number | null
  readonly reuseProductIdOverridePresent: boolean
  readonly snapshot: ParsedReuseSnapshot
}

/**
 * Decide, WITHOUT any live read, whether a row needs the live drift comparison,
 * can be skipped, or must be blocked outright. The guard runs ONLY for
 * generator-supplied reuse; a reviewer-forced override is trusted (the operator
 * deliberately chose the product in the review UI) and a legacy snapshot-absent
 * row keeps today's behavior through the C7→C8 window.
 */
export function precheckReuseDrift(input: ReuseDriftPrecheckInput): ReuseDriftPrecheck {
  if (input.reuseProductId === null || input.reuseProductIdOverridePresent) {
    return { kind: 'skip' }
  }
  switch (input.snapshot.kind) {
    case 'absent':
      return { kind: 'skip' }
    case 'malformed':
      return {
        kind: 'block',
        reason: `Pending-purchase row ${input.rowId} carries an unreadable validatedReuseSnapshot (${input.snapshot.error}); refusing to apply the generated reuse to product ${input.reuseProductId}. A reviewer must re-confirm the link.`,
      }
    case 'valid': {
      const snapshot = input.snapshot.snapshot
      if (snapshot.productId !== input.reuseProductId) {
        return {
          kind: 'block',
          reason: `Pending-purchase row ${input.rowId} reuse snapshot product ${snapshot.productId} disagrees with the row's reuse product ${input.reuseProductId}; refusing to apply. A reviewer must re-confirm the link.`,
        }
      }
      return { kind: 'compare-live', snapshot }
    }
  }
}

/** Result of the live comparison: `pass` to proceed, `block` to refuse the row. */
export type ReuseDriftComparison = { kind: 'pass' } | ReuseDriftBlock

/**
 * Compare a confirmed-valid snapshot against the live product read at apply
 * time. The apply job passes `liveFacts: null` when the validated reuse target
 * no longer resolves to a live, ENABLED product+group (deleted, disabled, or
 * the misleading Sweed "does not exist / no permission" error) — that is itself
 * a block, because the validator only ever confirmed reuse onto a live product.
 * A non-null `liveFacts` is compared lane-by-lane via {@link detectReuseDrift}.
 */
export function compareLiveReuse(
  rowId: number,
  reuseProductId: number,
  snapshot: ReconciledReuseSnapshot,
  liveFacts: LiveReuseProductFacts | null,
): ReuseDriftComparison {
  if (liveFacts === null) {
    return {
      kind: 'block',
      reason: `Pending-purchase row ${rowId} validated reuse product ${reuseProductId} no longer resolves to a live, enabled product+group at apply time (it may have been deleted or disabled). A reviewer must re-confirm the link.`,
    }
  }
  const drift = detectReuseDrift(snapshot, liveFacts)
  if (drift.length > 0) {
    return {
      kind: 'block',
      reason: `Pending-purchase row ${rowId} reuse target product ${reuseProductId} drifted since validation: ${drift.join('; ')}. A reviewer must re-confirm the link before apply.`,
    }
  }
  return { kind: 'pass' }
}
