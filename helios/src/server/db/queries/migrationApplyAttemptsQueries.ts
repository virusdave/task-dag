// Lifecycle-record queries for the migration_apply_attempts table
// (automation#62, leaf 4). See helios/src/server/db/schema/
// migrationApplyAttempts.sql for the column rationale and states, and
// docs/helios/pending-migrations-admin-apply/DESIGN.md "Data model".
//
// A row is INSERTed (`running` or a terminal short-circuit state) and then, for
// the `running` path, patched through to exactly one terminal state. These
// helpers accept any `Queryable`, so callers can run them on the same dedicated
// advisory-lock client that holds the exclusive apply lock (keeping the audit
// record write on the same connection as the guarded work).

import type { Queryable } from '../pool.js'
import type { MigrationTransactionMode } from '../pendingMigrations.js'

export type MigrationApplyAttemptState =
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'already_applied'
  | 'blocked_lock'
  | 'abandoned'

export interface InsertMigrationApplyAttemptInput {
  migrationId: string
  jobId: number | null
  requestedByUserId: number | null
  confirmMigrationId: string | null
  blessingRef: string | null
  artifactSha256: string | null
  deployedBuildId: string | null
  psqlPath: string | null
  psqlVersion: string | null
  redactedCommand: string | null
  transactionMode: MigrationTransactionMode | null
  advisoryLockAcquired: boolean | null
  sentinelBefore: boolean | null
  sentinelAfter: boolean | null
  psqlExitCode: number | null
  psqlSignal: string | null
  stdoutTail: string | null
  stderrTail: string | null
  errorMessage: string | null
  state: MigrationApplyAttemptState
  /** Set for rows inserted directly in a terminal state (no `running` phase). */
  finished: boolean
}

interface AttemptIdRow {
  id: string
}

/**
 * Insert one migration_apply_attempts row. Callers pass the full known-at-write
 * column set; unknown-yet fields are null. `finished: true` stamps
 * `finished_at = now()` for rows that are inserted already terminal
 * (`blocked_lock`, `already_applied`, or a pre-psql `failed`).
 */
export async function insertMigrationApplyAttempt(
  db: Queryable,
  input: InsertMigrationApplyAttemptInput,
): Promise<string> {
  const result = await db.query<AttemptIdRow>(
    `
      insert into migration_apply_attempts (
        migration_id,
        job_id,
        requested_by_user_id,
        confirm_migration_id,
        blessing_ref,
        artifact_sha256,
        deployed_build_id,
        psql_path,
        psql_version,
        redacted_command,
        transaction_mode,
        advisory_lock_acquired,
        sentinel_before,
        sentinel_after,
        psql_exit_code,
        psql_signal,
        stdout_tail,
        stderr_tail,
        error_message,
        state,
        finished_at
      )
      values (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16,
        $17, $18, $19, $20,
        case when $21::boolean then now() else null end
      )
      returning id
    `,
    [
      input.migrationId,
      input.jobId,
      input.requestedByUserId,
      input.confirmMigrationId,
      input.blessingRef,
      input.artifactSha256,
      input.deployedBuildId,
      input.psqlPath,
      input.psqlVersion,
      input.redactedCommand,
      input.transactionMode,
      input.advisoryLockAcquired,
      input.sentinelBefore,
      input.sentinelAfter,
      input.psqlExitCode,
      input.psqlSignal,
      input.stdoutTail,
      input.stderrTail,
      input.errorMessage,
      input.state,
      input.finished,
    ],
  )
  return result.rows[0].id
}

export interface PatchMigrationApplyAttemptInput {
  sentinelBefore?: boolean
  sentinelAfter?: boolean
  psqlVersion?: string
  psqlExitCode?: number | null
  psqlSignal?: string | null
  stdoutTail?: string | null
  stderrTail?: string | null
  errorMessage?: string | null
  /** When set, the row transitions to this terminal state and stamps finished_at. */
  terminalState?: Exclude<MigrationApplyAttemptState, 'running'>
}

// Whitelisted column mapping — never interpolate caller strings into SQL.
const PATCH_COLUMNS: ReadonlyArray<
  readonly [keyof PatchMigrationApplyAttemptInput, string]
> = [
  ['sentinelBefore', 'sentinel_before'],
  ['sentinelAfter', 'sentinel_after'],
  ['psqlVersion', 'psql_version'],
  ['psqlExitCode', 'psql_exit_code'],
  ['psqlSignal', 'psql_signal'],
  ['stdoutTail', 'stdout_tail'],
  ['stderrTail', 'stderr_tail'],
  ['errorMessage', 'error_message'],
]

/**
 * Patch a subset of a migration_apply_attempts row's fields by id. When
 * `terminalState` is provided the row also transitions to that state and stamps
 * `finished_at = now()`. Only whitelisted columns are ever written.
 */
export async function patchMigrationApplyAttempt(
  db: Queryable,
  id: string,
  patch: PatchMigrationApplyAttemptInput,
): Promise<void> {
  const setClauses: string[] = []
  const values: unknown[] = []

  for (const [key, column] of PATCH_COLUMNS) {
    if (patch[key] !== undefined) {
      values.push(patch[key])
      setClauses.push(`${column} = $${values.length}`)
    }
  }

  if (patch.terminalState !== undefined) {
    values.push(patch.terminalState)
    setClauses.push(`state = $${values.length}`)
    setClauses.push('finished_at = now()')
  }

  if (setClauses.length === 0) {
    return
  }

  values.push(id)
  await db.query(
    `update migration_apply_attempts set ${setClauses.join(', ')} where id = $${values.length}`,
    values,
  )
}

export interface PriorAttemptRow {
  id: string
  state: MigrationApplyAttemptState
  psql_exit_code: number | null
  psql_signal: string | null
}

/**
 * Return all prior attempt rows for a job id (used by the crash-recovery guard:
 * if a previous execution of THIS job may have started psql and the process
 * died / lost its lease before it could mark the job, we must NOT re-run partial
 * DDL). We also surface `psql_exit_code`/`psql_signal` so the guard can detect a
 * prior attempt where psql actually ran even if the row was later transitioned
 * to `failed` (post-psql terminal failure whose job update was lost to a stolen
 * lease).
 */
export async function listMigrationApplyAttemptsForJob(
  db: Queryable,
  jobId: number,
): Promise<PriorAttemptRow[]> {
  const result = await db.query<PriorAttemptRow>(
    `select id, state, psql_exit_code, psql_signal
       from migration_apply_attempts
      where job_id = $1
      order by started_at asc`,
    [jobId],
  )
  return result.rows
}

/**
 * The most recent apply attempt for a migration, shaped for the admin
 * pending-migrations list API (automation#62, leaf 5). `startedAt` /
 * `finishedAt` are ISO strings; `jobId` / `requestedBy` are numbers (the pg
 * pool parses bigint→number, see db/pool.ts).
 */
export interface LatestMigrationApplyAttempt {
  migrationId: string
  jobId: number | null
  state: MigrationApplyAttemptState
  error: string | null
  startedAt: string
  finishedAt: string | null
  requestedBy: number | null
}

interface LatestAttemptRow {
  migration_id: string
  job_id: number | null
  state: MigrationApplyAttemptState
  error_message: string | null
  started_at: Date
  finished_at: Date | null
  requested_by_user_id: number | null
}

/**
 * Return the single most-recent attempt per migration id, keyed by
 * migration_id, for the given ids. Uses `distinct on (migration_id)` ordered by
 * `started_at desc` — served by the migration_apply_attempts_migration_id_started_idx
 * index. Migrations with no attempt row are simply absent from the map. An empty
 * `migrationIds` short-circuits to an empty map (no query).
 */
export async function getLatestMigrationApplyAttemptsByMigrationIds(
  db: Queryable,
  migrationIds: readonly string[],
): Promise<Map<string, LatestMigrationApplyAttempt>> {
  if (migrationIds.length === 0) {
    return new Map()
  }
  const result = await db.query<LatestAttemptRow>(
    `
      select distinct on (migration_id)
        migration_id,
        job_id,
        state,
        error_message,
        started_at,
        finished_at,
        requested_by_user_id
      from migration_apply_attempts
      where migration_id = any($1::text[])
      -- id desc is a deterministic tie-breaker when two attempts for the same
      -- migration share a started_at (the uuid PK gives a stable last row).
      order by migration_id, started_at desc, id desc
    `,
    [migrationIds as string[]],
  )
  const byMigrationId = new Map<string, LatestMigrationApplyAttempt>()
  for (const row of result.rows) {
    byMigrationId.set(row.migration_id, {
      migrationId: row.migration_id,
      jobId: row.job_id,
      state: row.state,
      error: row.error_message,
      startedAt: row.started_at.toISOString(),
      finishedAt: row.finished_at === null ? null : row.finished_at.toISOString(),
      requestedBy: row.requested_by_user_id,
    })
  }
  return byMigrationId
}

/**
 * Mark any lingering `running` attempt rows for a job as `abandoned` (crash
 * recovery). Returns the number of rows transitioned.
 */
export async function abandonRunningAttemptsForJob(
  db: Queryable,
  jobId: number,
  errorMessage: string,
): Promise<number> {
  const result = await db.query(
    `
      update migration_apply_attempts
      set state = 'abandoned',
          finished_at = now(),
          error_message = coalesce(error_message, $2)
      where job_id = $1 and state = 'running'
    `,
    [jobId, errorMessage],
  )
  return result.rowCount ?? 0
}
