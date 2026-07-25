import { z } from 'zod'

import {
  FORCE_WITHOUT_REVIEW_APPROVAL,
  HELIOS_PRODUCTION_TARGET,
} from '../domain/migrationApplyAuthorization.js'

// Admin pending-migrations page API contracts (automation#62, leaf 5).
//
// Backs GET /api/admin/pending-migrations — the admin-only list the SPA
// (leaf 7) renders, one row per LIVE-pending migration. See
// docs/helios/pending-migrations-admin-apply/DESIGN.md "API contract".
//
// Every field is computed LIVE at request time (the sentinel/eligibility
// checks bypass the ~30s getPendingMigrations cache), so the operator never
// acts on a stale row. Names are `AdminPendingMigration*`-prefixed to avoid
// colliding with the all-pages banner's `PendingMigration` (api/session.ts)
// in the shared contracts barrel.

// The lifecycle state of the most recent apply attempt for a migration.
// Mirrors migration_apply_attempts.state (see schema/migrationApplyAttempts.sql
// + queries/migrationApplyAttemptsQueries.ts MigrationApplyAttemptState).
export const AdminPendingMigrationAttemptStateSchema = z.enum([
  'running',
  'succeeded',
  'failed',
  'already_applied',
  'blocked_lock',
  'abandoned',
])
export type AdminPendingMigrationAttemptState = z.infer<
  typeof AdminPendingMigrationAttemptStateSchema
>

// How the reviewed artifact handles transactions, surfaced from the registry
// blessing. Mirrors the server-side MigrationTransactionMode.
export const AdminMigrationTransactionModeSchema = z.enum([
  'transactional',
  'nontransactional-cic',
  'mixed',
])
export type AdminMigrationTransactionMode = z.infer<
  typeof AdminMigrationTransactionModeSchema
>

// The subset of the registry blessing safe to surface to the admin UI. The
// digest itself is intentionally NOT included (artifactDigestMatch reports the
// live comparison result instead), so the page can't imply a match that the
// runtime never verified.
export const AdminPendingMigrationBlessingSchema = z.object({
  ref: z.string(),
  note: z.string().nullable(),
  transactionMode: AdminMigrationTransactionModeSchema,
  operatorExplanation: z.string().min(1),
})
export type AdminPendingMigrationBlessing = z.infer<
  typeof AdminPendingMigrationBlessingSchema
>

// The most recent apply attempt for a migration (or null if never attempted).
export const AdminPendingMigrationAttemptSchema = z.object({
  jobId: z.number().int().nullable(),
  state: AdminPendingMigrationAttemptStateSchema,
  error: z.string().nullable(),
  startedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime().nullable(),
  requestedBy: z.number().int().nullable(),
})
export type AdminPendingMigrationAttempt = z.infer<
  typeof AdminPendingMigrationAttemptSchema
>

export const AdminPendingMigrationRowSchema = z.object({
  migrationId: z.string(),
  label: z.string(),
  // Live sentinel state. Rows are only emitted for pending migrations, so this
  // is 'pending' today; 'applied' is kept in the union for forward-compat.
  sentinelState: z.enum(['pending', 'applied']),
  // Apply-eligible == blessed in the registry AND the deployed artifact-closure
  // digest still matches the blessing (the row is already live-pending, so the
  // static resolver's verdict is the full verdict here).
  eligible: z.boolean(),
  // Human-readable reason a migration is not eligible, else null.
  ineligibleReason: z.string().nullable(),
  blessing: AdminPendingMigrationBlessingSchema.nullable(),
  // Whether the runtime-recomputed artifact-closure digest equals the blessing
  // digest. False whenever there is no blessing / the artifact is unresolvable.
  artifactDigestMatch: z.boolean(),
  // Current deployed closure digest when it resolved, else null. Apply binds
  // the operator's request to this exact value and rejects a later deploy.
  artifactSha256: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
  reviewApprovalState: z.enum(['current', 'missing', 'stale', 'artifact-unavailable']),
  forceEligible: z.boolean(),
  lastAttempt: AdminPendingMigrationAttemptSchema.nullable(),
})
export type AdminPendingMigrationRow = z.infer<typeof AdminPendingMigrationRowSchema>

export const AdminPendingMigrationsResponseSchema = z.object({
  migrations: z.array(AdminPendingMigrationRowSchema),
})
export type AdminPendingMigrationsResponse = z.infer<
  typeof AdminPendingMigrationsResponseSchema
>

// POST /api/admin/pending-migrations/:id/apply request/response (automation#62,
// leaf 6). The type-to-confirm value the admin typed; the server rejects unless
// it exactly equals the path `:id` (the deliberate operator "go"). See
// docs/helios/pending-migrations-admin-apply/DESIGN.md "API contract" +
// "Gating / safety model" item 3.
export const AdminPendingMigrationApplyRequestSchema = z.object({
  confirmMigrationId: z.string().min(1),
  expectedArtifactSha256: z.string().regex(/^[0-9a-f]{64}$/),
}).strict()
export type AdminPendingMigrationApplyRequest = z.infer<
  typeof AdminPendingMigrationApplyRequestSchema
>

export const AdminPendingMigrationForceApplyRequestSchema = z.object({
  action: z.literal(FORCE_WITHOUT_REVIEW_APPROVAL),
  confirmationPhrase: z.literal(FORCE_WITHOUT_REVIEW_APPROVAL),
  target: z.literal(HELIOS_PRODUCTION_TARGET),
  confirmMigrationId: z.string().min(1),
  acknowledgedWithoutReview: z.literal(true),
  expectedArtifactSha256: z.string().regex(/^[0-9a-f]{64}$/),
}).strict()
export type AdminPendingMigrationForceApplyRequest = z.infer<
  typeof AdminPendingMigrationForceApplyRequestSchema
>

// On success the endpoint returns the enqueued (or in-flight, deduped) urgent
// `db.migration.apply` job id; the SPA (leaf 7) polls GET /api/jobs/:jobId with
// it. The apply itself runs entirely in the worker.
export const AdminPendingMigrationApplyResponseSchema = z.object({
  jobId: z.number().int(),
})
export type AdminPendingMigrationApplyResponse = z.infer<
  typeof AdminPendingMigrationApplyResponseSchema
>

export const AdminPendingMigrationApplyConflictSchema = z.object({
  error: z.string().min(1),
  existingJobId: z.number().int(),
})
export type AdminPendingMigrationApplyConflict = z.infer<
  typeof AdminPendingMigrationApplyConflictSchema
>

export const AdminPendingMigrationArtifactFileSchema = z.object({
  role: z.enum(['main', 'include']),
  relPath: z.string(),
  byteLength: z.number().int().nonnegative(),
  text: z.string(),
})

export const AdminPendingMigrationArtifactSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('available'),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    totalBytes: z.number().int().nonnegative(),
    files: z.array(AdminPendingMigrationArtifactFileSchema),
  }),
  z.object({
    status: z.literal('unavailable'),
    code: z.string(),
    message: z.string(),
  }),
])

export const AdminPendingMigrationDetailsResponseSchema = z.object({
  migration: AdminPendingMigrationRowSchema,
  explanation: z.discriminatedUnion('status', [
    z.object({ status: z.literal('current'), text: z.string().min(1) }),
    z.object({ status: z.literal('stale'), text: z.string().min(1) }),
    z.object({ status: z.literal('unavailable'), text: z.null() }),
  ]),
  artifact: AdminPendingMigrationArtifactSchema,
  checkedAt: z.iso.datetime(),
})
export type AdminPendingMigrationDetailsResponse = z.infer<
  typeof AdminPendingMigrationDetailsResponseSchema
>
