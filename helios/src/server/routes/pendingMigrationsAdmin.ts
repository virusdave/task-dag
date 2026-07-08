import type { FastifyInstance } from 'fastify'

import {
  AdminPendingMigrationsResponseSchema,
  type AdminPendingMigrationRow,
} from '../../shared/contracts/index.js'
import { requireSessionUser } from '../auth/requireSession.js'
import { getPool } from '../db/pool.js'
import { resolveMigrationApplyEligibility } from '../db/migrationApplyEligibility.js'
import { listPendingMigrationsLive } from '../db/pendingMigrations.js'
import { getLatestMigrationApplyAttemptsByMigrationIds } from '../db/queries/migrationApplyAttemptsQueries.js'

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
}
