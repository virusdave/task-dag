import type { FastifyInstance } from 'fastify'

import {
  AdminPendingMigrationApplyRequestSchema,
  AdminPendingMigrationApplyResponseSchema,
  AdminPendingMigrationsResponseSchema,
  type AdminPendingMigrationRow,
} from '../../shared/contracts/index.js'
import { requireSessionUser } from '../auth/requireSession.js'
import { getPool } from '../db/pool.js'
import { resolveMigrationApplyEligibility } from '../db/migrationApplyEligibility.js'
import { isMigrationAppliedLive, listPendingMigrationsLive } from '../db/pendingMigrations.js'
import { getLatestMigrationApplyAttemptsByMigrationIds } from '../db/queries/migrationApplyAttemptsQueries.js'
import { enqueueJob, JOB_PRIORITY_URGENT } from '../jobs/enqueueJob.js'

// Admin pending-migrations read/list API (automation#62, leaf 5).
//
// GET /api/admin/pending-migrations — one row per LIVE-pending migration, with
// its blessing/eligibility (recomputed at request time from the committed
// registry + on-disk artifact closure) and the most-recent apply attempt. The
// SPA (leaf 7) renders this table; the enqueue endpoint (leaf 6) re-validates
// eligibility server-side before running anything, so this route is read-only
// and never mutates the schema.
//
// Everything is computed LIVE (the sentinel + eligibility bypass the ~30s
// getPendingMigrations cache) so an admin never acts on a stale row.
export async function registerPendingMigrationsAdminRoutes(
  server: FastifyInstance,
): Promise<void> {
  server.get('/api/admin/pending-migrations', async (request, reply) => {
    const actor = await requireSessionUser(request, reply, 'admin')
    if (!actor) {
      return
    }

    const pool = getPool()
    // Live (cache-bypassed) pending set + the latest attempt per pending id.
    const pending = await listPendingMigrationsLive(pool)
    const lastAttempts = await getLatestMigrationApplyAttemptsByMigrationIds(
      pool,
      pending.map((migration) => migration.migrationId),
    )

    const migrations: AdminPendingMigrationRow[] = pending.map(({ migrationId, label }) => {
      // Static (registry + artifact) eligibility. Because the row is already
      // live-pending, this static verdict is the full apply-eligibility.
      const eligibility = resolveMigrationApplyEligibility(migrationId)
      const blessing = eligibility.blessing
      // The digest is only recomputed-and-matched on the eligible path; any
      // ineligible reason (no blessing, unresolvable artifact, mismatch) means
      // the deployed artifact did not verify against a blessing.
      const artifactDigestMatch = eligibility.eligible
      const lastAttempt = lastAttempts.get(migrationId) ?? null

      return {
        migrationId,
        label,
        sentinelState: 'pending',
        eligible: eligibility.eligible,
        ineligibleReason: eligibility.eligible ? null : eligibility.detail,
        blessing:
          blessing === null
            ? null
            : {
                ref: blessing.ref,
                note: blessing.note ?? null,
                transactionMode: blessing.transactionMode,
              },
        artifactDigestMatch,
        lastAttempt,
      }
    })

    // Stable, deterministic order (zero-padded NNN_ prefix sorts naturally).
    migrations.sort((a, b) => a.migrationId.localeCompare(b.migrationId))

    return reply.send(AdminPendingMigrationsResponseSchema.parse({ migrations }))
  })

  // POST /api/admin/pending-migrations/:id/apply — enqueue the worker-driven
  // apply of a single migration (automation#62, leaf 6). See DESIGN.md
  // "API contract" + "Gating / safety model".
  //
  // This endpoint is the operator "go": an admin clicks "Apply Now" and
  // type-to-confirms the id. It re-validates eligibility LIVE and server-side
  // (never trusting the SPA's stale row), then enqueues an URGENT
  // `db.migration.apply` job. The worker re-validates EVERYTHING again before
  // touching the schema (payload is untrusted, never a source of SQL) and does
  // the actual apply + live sentinel verification — so these checks are a
  // fast-fail gate, not the last line of defense.
  //
  // Status codes:
  //  - 400 if `confirmMigrationId` !== `:id` (type-to-confirm mismatch).
  //  - 404 if the id is not in the migration registry.
  //  - 409 if the migration is not apply-eligible (unblessed / digest mismatch
  //        / unresolvable artifact) or is already applied (live sentinel).
  //  - 200 with { jobId } on enqueue. The dedupe index means a repeat click
  //        while an apply is in flight returns the SAME in-flight jobId.
  server.post('/api/admin/pending-migrations/:id/apply', async (request, reply) => {
    const actor = await requireSessionUser(request, reply, 'admin')
    if (!actor) {
      return
    }

    const migrationId = (request.params as { id: string }).id
    // ZodError from a malformed body is turned into a 400 by the global error
    // handler in buildServer.ts.
    const { confirmMigrationId } = AdminPendingMigrationApplyRequestSchema.parse(request.body)

    // Type-to-confirm: the operator must have typed the exact id. The worker
    // re-checks this too (defense in depth).
    if (confirmMigrationId !== migrationId) {
      return reply.status(400).send({
        error: 'confirmMigrationId does not match the migration id.',
      })
    }

    // Static (registry + artifact-closure digest) eligibility, recomputed live
    // from the committed registry + deployed artifact. Fail-closed.
    const eligibility = resolveMigrationApplyEligibility(migrationId)
    if (!eligibility.eligible) {
      // A bad id is a 404; every other ineligible reason (unblessed, digest
      // mismatch, unresolvable artifact) is a 409 conflict with the deployed
      // state.
      const status = eligibility.reason === 'unknown-migration-id' ? 404 : 409
      return reply.status(status).send({ error: eligibility.detail })
    }

    // Live pending state (cache-bypassed) — never enqueue an apply for a
    // migration that is already applied.
    const pool = getPool()
    const alreadyApplied = await isMigrationAppliedLive(pool, migrationId)
    if (alreadyApplied) {
      return reply.status(409).send({
        error: `Migration ${migrationId} is already applied; nothing to do.`,
      })
    }

    // Enqueue the URGENT apply job. The partial dedupe index on
    // (dedupe_key) where status in ('queued','running') guarantees at most one
    // live apply per migration — a repeat click returns the in-flight id. The
    // concurrency key serializes applies fleet-wide so two migrations never
    // race the schema at once.
    const jobId = await enqueueJob(pool, {
      jobType: 'db.migration.apply',
      module: 'config',
      payload: {
        migrationId,
        requestedByUserId: actor.id,
        confirmMigrationId,
        blessingArtifactSha256: eligibility.blessing.artifactSha256,
      },
      priority: JOB_PRIORITY_URGENT,
      dedupeKey: `migration-apply:${migrationId}`,
      concurrencyKey: 'migration-apply',
      requestedByUserId: actor.id,
      scope: null,
    })

    return reply.send(AdminPendingMigrationApplyResponseSchema.parse({ jobId }))
  })
}
