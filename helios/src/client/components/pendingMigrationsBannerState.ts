// Pure, DOM-free state logic for <PendingMigrationsBanner />. Extracted
// so it can be unit-tested under the repo's node-only vitest setup (there
// is no jsdom test environment), and so the "dismiss for this session"
// decision is provably correct.
//
// The warning is operationally important: a pending migration means the
// deployed server code expects schema the live DB does not have, so some
// routes 500 until an agent applies it manually. We therefore let a user
// dismiss the *current* set of pending migrations for their browser tab,
// but we must re-surface it if a NEW/different migration set appears. We
// achieve that by keying the dismissal on a stable signature of the
// pending migration ids and storing it in sessionStorage (resets per tab/
// session, never permanent).

import type { PendingMigration } from '../../shared/contracts/index.js'

// Versioned so a future change to the dismissal semantics can invalidate
// stale stored values without surprising open tabs.
export const DISMISSED_SIGNATURE_STORAGE_KEY = 'helios.pendingMigrationsBanner.dismissed.v1'

export type PendingMigrationsBannerMode = 'hidden' | 'expanded' | 'collapsed'

// A storage surface we can read/write/clear. Narrowed from the DOM
// Storage type so tests can pass a trivial fake and so we never depend on
// `window` in this pure module.
export type SignatureStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

// Stable signature of the pending set: order-independent (the API may
// return migrations in any order) and null when nothing is pending.
export function buildPendingMigrationsSignature(
  pending: ReadonlyArray<Pick<PendingMigration, 'migrationId'>>,
): string | null {
  if (pending.length === 0) {
    return null
  }
  return JSON.stringify(pending.map((migration) => migration.migrationId).sort())
}

// The single source of truth for what the banner shows:
// - nothing pending                       -> hidden
// - user just tapped the pill to peek      -> expanded (transient)
// - user dismissed this exact set this tab -> collapsed (small pill)
// - otherwise (new/never-dismissed set)    -> expanded
export function getPendingMigrationsBannerMode(args: {
  signature: string | null
  dismissedSignature: string | null
  manuallyExpandedSignature: string | null
}): PendingMigrationsBannerMode {
  if (args.signature === null) {
    return 'hidden'
  }
  if (args.manuallyExpandedSignature === args.signature) {
    return 'expanded'
  }
  if (args.dismissedSignature === args.signature) {
    return 'collapsed'
  }
  return 'expanded'
}

// Storage helpers — every access is wrapped because sessionStorage can
// throw (privacy modes, disabled storage). On any failure we fail safe to
// "not dismissed" so the warning is shown rather than silently hidden.
export function readDismissedSignature(storage: SignatureStorage | null): string | null {
  if (storage === null) {
    return null
  }
  try {
    return storage.getItem(DISMISSED_SIGNATURE_STORAGE_KEY)
  } catch {
    return null
  }
}

export function writeDismissedSignature(
  storage: SignatureStorage | null,
  signature: string,
): void {
  if (storage === null) {
    return
  }
  try {
    storage.setItem(DISMISSED_SIGNATURE_STORAGE_KEY, signature)
  } catch {
    // Best-effort persistence; React state still collapses for this mount.
  }
}

export function clearDismissedSignature(storage: SignatureStorage | null): void {
  if (storage === null) {
    return
  }
  try {
    storage.removeItem(DISMISSED_SIGNATURE_STORAGE_KEY)
  } catch {
    // Ignore — nothing to surface to the user.
  }
}
