// Worker-driven production migration apply engine (automation#62, leaf 4).
//
// This is the ONLY code path that mutates the production schema on behalf of the
// admin "Apply Now" flow. It shells out to `psql -f <exact reviewed artifact>`
// against the live DB, so it is written fail-closed and to the DESIGN.md
// "Gating / safety model" + canon rules/DB_PERFORMANCE.md steps 3–7.
//
// Guarantees:
//   - Runs ONLY a registered, Oracle-blessed migration whose deployed
//     artifact-closure digest still matches the blessing AND the enqueue-time
//     payload digest. Any mismatch is refused (terminal).
//   - Takes a session-level `pg_try_advisory_lock` on a dedicated pool client
//     held for the whole psql lifetime, so two applies can never race the
//     schema even if a lease is reclaimed mid-run.
//   - Inserts a `running` migration_apply_attempts row BEFORE psql launches and
//     records the full lifecycle (canon step 7) + audit_events.
//   - Live sentinel (cache bypassed) BEFORE (short-circuit already_applied
//     no-op success) and AFTER (success ONLY if the sentinel flips to applied).
//   - Single-attempt after psql starts: any post-psql failure is terminal and
//     non-retryable; a crashed prior attempt for the same job is refused rather
//     than re-running partial DDL. Only pre-psql infra failures (advisory-lock
//     contention, psql binary missing) auto-retry.
//   - psql is invoked with NO shell, an absolute closure-resolved binary,
//     `-X --no-psqlrc -v ON_ERROR_STOP=1 -f <abs>`, cwd = migrations dir, DB
//     creds via PG* env (never argv), bounded+redacted stdout/stderr.

import { spawn } from 'node:child_process'
import { isAbsolute } from 'node:path'

import type { PoolClient } from 'pg'

import type {
  AuditEventType,
  DbMigrationApplyJobPayload,
  JsonValue,
} from '../../shared/contracts/index.js'
import { appendAuditEvent } from '../../server/audit/appendAuditEvent.js'
import { getPool, type Queryable } from '../../server/db/pool.js'
import {
  resolveMigrationApplyEligibility,
  type MigrationApplyEligibility,
} from '../../server/db/migrationApplyEligibility.js'
import {
  isMigrationAppliedLive,
  resetPendingMigrationsCache,
} from '../../server/db/pendingMigrations.js'
import {
  abandonRunningAttemptsForJob,
  insertMigrationApplyAttempt,
  listMigrationApplyAttemptsForJob,
  patchMigrationApplyAttempt,
} from '../../server/db/queries/migrationApplyAttemptsQueries.js'
import { readOptionalEnv, readRequiredDatabaseUrl } from '../../shared/config/runtimeEnv.js'
import { RetryableWorkerError } from '../runtime/errors.js'
import type { JobHandlerContext } from '../runtime/jobRegistry.js'

/**
 * Fixed session-level advisory-lock key that serializes ALL migration applies
 * fleet-wide. Chosen once and never changed (changing it would defeat the
 * cross-process mutual exclusion). Arbitrary constant tagged to issue #62.
 */
export const MIGRATION_APPLY_ADVISORY_LOCK_KEY = 620462

/** Max bytes of psql stdout/stderr retained (tail) on the attempt record. */
const OUTPUT_TAIL_BYTES = 16 * 1024

/** Prior attempt states that mean psql MAY have started (crash-guard trigger). */
const PSQL_CAPABLE_PRIOR_STATES: ReadonlySet<string> = new Set(['running', 'abandoned'])

export interface PsqlRunResult {
  /** Process exit code (null if it exited via signal). */
  exitCode: number | null
  /** Terminating signal name (null if it exited normally). */
  signal: string | null
  stdoutTail: string
  stderrTail: string
  /** Set iff the process could not be spawned at all (e.g. ENOENT). */
  spawnError: string | null
}

export interface RunPsqlOptions {
  psqlBin: string
  mainFileAbsPath: string
  /** cwd for psql so `\i` (cwd-relative) includes resolve under migrations/. */
  cwd: string
  applicationName: string
  /** PG* connection env (no URL in argv, no creds logged). */
  pgEnv: Record<string, string>
  /** Substrings (e.g. the DB password) scrubbed from captured output. */
  redactValues: string[]
  outputTailBytes: number
}

export interface ApplyMigrationDeps {
  /** Check out a dedicated pool client that holds the advisory lock. */
  connect: () => Promise<PoolClient>
  /** Static (registry + blessing + digest) eligibility — no DB, no SQL exec. */
  resolveEligibility: (migrationId: string) => MigrationApplyEligibility
  /** Live sentinel check (cache bypassed) against the given client. */
  isMigrationAppliedLive: (db: Queryable, migrationId: string) => Promise<boolean>
  /** Invalidate the pending-migrations cache after every attempt. */
  invalidatePendingMigrationsCache: () => void
  appendAuditEvent: typeof appendAuditEvent
  /** Absolute path to the closure-resolved psql binary, or null if absent. */
  resolvePsqlBin: () => string | null
  /** Best-effort psql version string (recorded for the audit; may be null). */
  getPsqlVersion: (psqlBin: string) => Promise<string | null>
  /** Build the PG* connection env from DATABASE_URL. Returns env + secret list. */
  buildPgEnv: () => { env: Record<string, string>; redactValues: string[] }
  runPsql: (options: RunPsqlOptions) => Promise<PsqlRunResult>
  deployedBuildId: () => string | null
}

export interface ApplyMigrationParams {
  jobId: number
  migrationId: string
  requestedByUserId: number
  confirmMigrationId: string
  blessingArtifactSha256: string
}

/** Terminal, non-retryable failure — psql may have run; require a fresh click. */
class TerminalMigrationApplyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TerminalMigrationApplyError'
  }
}

/**
 * Registered worker handler. Wires the real dependencies and delegates to the
 * injectable {@link applyMigrationAttempt} core (which the test harness drives
 * with fakes so it never touches prod).
 */
export async function runDbMigrationApplyJob(
  context: JobHandlerContext,
  payload: DbMigrationApplyJobPayload,
): Promise<void> {
  await applyMigrationAttempt(realApplyMigrationDeps(), {
    jobId: context.id,
    migrationId: payload.migrationId,
    requestedByUserId: payload.requestedByUserId,
    confirmMigrationId: payload.confirmMigrationId,
    blessingArtifactSha256: payload.blessingArtifactSha256,
  })
}

/**
 * The apply state machine. Throws {@link RetryableWorkerError} for pre-psql
 * infra failures (job re-queues) and a plain Error for terminal failures (job
 * marked failed, no retry). Returns normally on success / already-applied.
 */
export async function applyMigrationAttempt(
  deps: ApplyMigrationDeps,
  params: ApplyMigrationParams,
): Promise<void> {
  const { jobId, migrationId, requestedByUserId, confirmMigrationId, blessingArtifactSha256 } =
    params
  const deployedBuildId = deps.deployedBuildId()

  // Pool checkout is a pre-apply infra step: no DDL can have run, so a failure
  // here is retryable. Invalidate the cache defensively and defer.
  let client: PoolClient
  try {
    client = await deps.connect()
  } catch (error) {
    try {
      deps.invalidatePendingMigrationsCache()
    } catch {
      // best effort
    }
    const message = error instanceof Error ? error.message : String(error)
    throw new RetryableWorkerError(`Failed to acquire a DB client for migration apply: ${message}`)
  }

  let lockAcquired = false
  try {
    // (A) Type-to-confirm — defense in depth (the server enforces it too).
    if (confirmMigrationId !== migrationId) {
      await recordTerminalAndAudit(deps, client, {
        params,
        state: 'failed',
        eligibility: null,
        deployedBuildId,
        psqlPath: null,
        advisoryLockAcquired: null,
        errorMessage: `confirmMigrationId "${confirmMigrationId}" does not equal migrationId "${migrationId}".`,
      })
      throw new TerminalMigrationApplyError(
        `Refusing apply: confirmMigrationId does not match migrationId (${migrationId}).`,
      )
    }

    // (B) Static eligibility: registered + blessed + deployed digest matches.
    const eligibility = deps.resolveEligibility(migrationId)
    if (!eligibility.eligible) {
      await recordTerminalAndAudit(deps, client, {
        params,
        state: 'failed',
        eligibility,
        deployedBuildId,
        psqlPath: null,
        advisoryLockAcquired: null,
        errorMessage: `ineligible (${eligibility.reason}): ${eligibility.detail}`,
      })
      throw new TerminalMigrationApplyError(
        `Refusing apply of ${migrationId}: ${eligibility.reason} — ${eligibility.detail}`,
      )
    }

    // (C) The enqueue-time payload digest must still equal the reviewed unit.
    if (blessingArtifactSha256 !== eligibility.artifact.sha256) {
      await recordTerminalAndAudit(deps, client, {
        params,
        state: 'failed',
        eligibility,
        deployedBuildId,
        psqlPath: null,
        advisoryLockAcquired: null,
        errorMessage:
          `payload blessingArtifactSha256 ${blessingArtifactSha256} does not match the ` +
          `deployed artifact digest ${eligibility.artifact.sha256}.`,
      })
      throw new TerminalMigrationApplyError(
        `Refusing apply of ${migrationId}: payload digest does not match deployed artifact.`,
      )
    }

    // (D) psql binary — closure-resolved absolute path, no ambient fallback.
    const psqlBin = deps.resolvePsqlBin()
    if (psqlBin === null || !isAbsolute(psqlBin)) {
      await recordTerminalAndAudit(deps, client, {
        params,
        state: 'failed',
        eligibility,
        deployedBuildId,
        psqlPath: psqlBin,
        advisoryLockAcquired: null,
        errorMessage:
          'HELIOS_PSQL_BIN is unset or not an absolute path; refusing to fall back to an ambient psql.',
      })
      // No DDL ran; a corrected deploy self-heals ⇒ retryable infra.
      throw new RetryableWorkerError(
        'psql binary not configured (HELIOS_PSQL_BIN absent/relative); deferring apply.',
      )
    }

    // (E) Exclusive advisory lock on this dedicated client for the whole run.
    lockAcquired = await tryAdvisoryLock(client, MIGRATION_APPLY_ADVISORY_LOCK_KEY)
    if (!lockAcquired) {
      await recordTerminalAndAudit(deps, client, {
        params,
        state: 'blocked_lock',
        eligibility,
        deployedBuildId,
        psqlPath: psqlBin,
        advisoryLockAcquired: false,
        errorMessage: 'Migration-apply advisory lock is held by another apply; backing off.',
        auditEventType: null, // benign back-off — recorded on the attempt row only
      })
      throw new RetryableWorkerError(
        'Another migration apply holds the exclusive advisory lock; deferring.',
      )
    }

    // (F) Crash-recovery guard: if a prior execution of THIS job may have
    // started psql (a `running`/`abandoned` attempt row survives), never
    // re-run partial DDL. If the migration is now applied, converge to a no-op
    // success; otherwise refuse (terminal) and require a fresh admin click.
    const priorAttempts = await listMigrationApplyAttemptsForJob(client, jobId)
    const priorPsqlCapable = priorAttempts.filter(
      (row) =>
        // A `running`/`abandoned` prior row means the process may have died
        // mid-psql. A prior row with a recorded psql exit/signal means psql
        // actually ran (even if the row was later marked `failed`): its
        // terminal job update may have been lost to a stolen lease, so a
        // re-lease must not re-run partial DDL. Pre-psql `failed`/`blocked_lock`
        // rows (no exit/signal, retryable infra) do NOT trip the guard.
        PSQL_CAPABLE_PRIOR_STATES.has(row.state) ||
        row.psql_exit_code !== null ||
        row.psql_signal !== null,
    )
    if (priorPsqlCapable.length > 0) {
      await abandonRunningAttemptsForJob(
        client,
        jobId,
        'Superseded by a crash-recovery re-run of the same job.',
      )
      const appliedNow = await deps.isMigrationAppliedLive(client, migrationId)
      if (appliedNow) {
        await recordTerminalAndAudit(deps, client, {
          params,
          state: 'already_applied',
          eligibility,
          deployedBuildId,
          psqlPath: psqlBin,
          advisoryLockAcquired: true,
          sentinelBefore: true,
          sentinelAfter: true,
          errorMessage: null,
          auditEventType: 'db.migration.apply.succeeded',
          auditExtra: { alreadyApplied: true, crashRecovery: true },
        })
        return
      }
      await recordTerminalAndAudit(deps, client, {
        params,
        state: 'failed',
        eligibility,
        deployedBuildId,
        psqlPath: psqlBin,
        advisoryLockAcquired: true,
        errorMessage:
          'A prior attempt for this job may have started psql and did not finish; refusing to ' +
          're-run (post-psql single-attempt). Review, then click Apply Now again.',
      })
      throw new TerminalMigrationApplyError(
        `Refusing to re-run ${migrationId}: prior attempt for job ${jobId} may have started psql.`,
      )
    }

    // (G) Insert the `running` attempt row BEFORE psql launches.
    const redactedCommand = buildRedactedCommand(
      psqlBin,
      eligibility.artifact.main.absPath,
      applicationName(migrationId, jobId),
    )
    const attemptId = await insertMigrationApplyAttempt(client, {
      migrationId,
      jobId,
      requestedByUserId,
      confirmMigrationId,
      blessingRef: eligibility.blessing.ref,
      artifactSha256: eligibility.artifact.sha256,
      deployedBuildId,
      psqlPath: psqlBin,
      psqlVersion: null,
      redactedCommand,
      transactionMode: eligibility.blessing.transactionMode,
      advisoryLockAcquired: true,
      sentinelBefore: null,
      sentinelAfter: null,
      psqlExitCode: null,
      psqlSignal: null,
      stdoutTail: null,
      stderrTail: null,
      errorMessage: null,
      state: 'running',
      finished: false,
    })
    await deps.appendAuditEvent(client, {
      actorType: requestedByUserId > 0 ? 'user' : 'system',
      actorUserId: requestedByUserId > 0 ? requestedByUserId : null,
      entityId: attemptId,
      entityType: 'migration_apply_attempt',
      eventType: 'db.migration.apply.started',
      module: 'config',
      payload: auditPayload(params, {
        attemptId,
        blessingRef: eligibility.blessing.ref,
        artifactSha256: eligibility.artifact.sha256,
        transactionMode: eligibility.blessing.transactionMode,
      }),
      requestId: null,
      undoPayload: null,
    })

    // (H) Live sentinel BEFORE (cache bypassed). Already applied ⇒ no-op success.
    const before = await deps.isMigrationAppliedLive(client, migrationId)
    await patchMigrationApplyAttempt(client, attemptId, { sentinelBefore: before })
    if (before) {
      await patchMigrationApplyAttempt(client, attemptId, {
        sentinelAfter: true,
        terminalState: 'already_applied',
      })
      await auditTerminal(deps, client, params, attemptId, 'db.migration.apply.succeeded', {
        alreadyApplied: true,
        sentinelBefore: true,
        sentinelAfter: true,
      })
      return
    }

    // (I) Best-effort psql version for the record.
    const psqlVersion = await deps.getPsqlVersion(psqlBin)
    if (psqlVersion !== null) {
      await patchMigrationApplyAttempt(client, attemptId, { psqlVersion })
    }

    // (J) Run the exact reviewed artifact.
    const { env: pgEnv, redactValues } = deps.buildPgEnv()
    const psqlResult = await deps.runPsql({
      psqlBin,
      mainFileAbsPath: eligibility.artifact.main.absPath,
      cwd: eligibility.artifact.migrationsRoot,
      applicationName: applicationName(migrationId, jobId),
      pgEnv,
      redactValues,
      outputTailBytes: OUTPUT_TAIL_BYTES,
    })

    if (psqlResult.spawnError !== null) {
      // psql never executed any DDL ⇒ retryable infra failure.
      await patchMigrationApplyAttempt(client, attemptId, {
        stderrTail: psqlResult.stderrTail || null,
        errorMessage: `psql failed to spawn: ${psqlResult.spawnError}`,
        terminalState: 'failed',
      })
      await auditTerminal(deps, client, params, attemptId, 'db.migration.apply.failed', {
        spawnError: psqlResult.spawnError,
      })
      throw new RetryableWorkerError(`psql failed to spawn: ${psqlResult.spawnError}; deferring.`)
    }

    await patchMigrationApplyAttempt(client, attemptId, {
      psqlExitCode: psqlResult.exitCode,
      psqlSignal: psqlResult.signal,
      stdoutTail: psqlResult.stdoutTail || null,
      stderrTail: psqlResult.stderrTail || null,
    })

    // (K) Live sentinel AFTER. Success ONLY if it flips to applied.
    const after = await deps.isMigrationAppliedLive(client, migrationId)
    await patchMigrationApplyAttempt(client, attemptId, { sentinelAfter: after })

    const psqlOk = psqlResult.exitCode === 0 && psqlResult.signal === null
    if (psqlOk && after) {
      await patchMigrationApplyAttempt(client, attemptId, { terminalState: 'succeeded' })
      await auditTerminal(deps, client, params, attemptId, 'db.migration.apply.succeeded', {
        alreadyApplied: false,
        sentinelBefore: false,
        sentinelAfter: true,
        psqlExitCode: psqlResult.exitCode,
      })
      return
    }

    // Post-psql failure ⇒ TERMINAL, non-retryable (DDL may have partially run).
    const reason = !psqlOk
      ? `psql exited with code=${String(psqlResult.exitCode)} signal=${String(psqlResult.signal)}`
      : 'psql exited 0 but the live sentinel still reports the migration NOT applied'
    await patchMigrationApplyAttempt(client, attemptId, {
      errorMessage: reason,
      terminalState: 'failed',
    })
    await auditTerminal(deps, client, params, attemptId, 'db.migration.apply.failed', {
      reason,
      psqlExitCode: psqlResult.exitCode,
      psqlSignal: psqlResult.signal,
      sentinelAfter: after,
    })
    throw new TerminalMigrationApplyError(`Migration apply failed (terminal): ${reason}`)
  } finally {
    if (lockAcquired) {
      await unlockAdvisory(client, MIGRATION_APPLY_ADVISORY_LOCK_KEY).catch((error) => {
        console.warn('[db.migration.apply] advisory unlock failed (client release will free it):', error)
      })
    }
    client.release()
    // Invalidate after EVERY attempt so the UI/banner don't invite a stale click.
    try {
      deps.invalidatePendingMigrationsCache()
    } catch (error) {
      console.warn('[db.migration.apply] cache invalidation failed:', error)
    }
  }
}

// ============================================================================
// Terminal-record helper (single insert of an already-terminal attempt row +
// optional audit event). Used for the short-circuit paths (confirm mismatch,
// ineligible, psql-missing, blocked_lock, crash-recovery).
// ============================================================================

interface RecordTerminalInput {
  params: ApplyMigrationParams
  state: 'failed' | 'blocked_lock' | 'already_applied'
  eligibility: MigrationApplyEligibility | null
  deployedBuildId: string | null
  psqlPath: string | null
  advisoryLockAcquired: boolean | null
  sentinelBefore?: boolean | null
  sentinelAfter?: boolean | null
  errorMessage: string | null
  /**
   * Audit event to emit, or `null` to skip (benign back-off). Defaults to
   * `db.migration.apply.failed` for `failed`.
   */
  auditEventType?: AuditEventType | null
  auditExtra?: Record<string, JsonValue>
}

async function recordTerminalAndAudit(
  deps: ApplyMigrationDeps,
  client: Queryable,
  input: RecordTerminalInput,
): Promise<void> {
  const { params, eligibility } = input
  const blessing = eligibility?.blessing ?? null
  const artifact = eligibility?.artifact ?? null
  const attemptId = await insertMigrationApplyAttempt(client, {
    migrationId: params.migrationId,
    jobId: params.jobId,
    requestedByUserId: params.requestedByUserId,
    confirmMigrationId: params.confirmMigrationId,
    blessingRef: blessing?.ref ?? null,
    artifactSha256: artifact?.sha256 ?? null,
    deployedBuildId: input.deployedBuildId,
    psqlPath: input.psqlPath,
    psqlVersion: null,
    redactedCommand: null,
    transactionMode: blessing?.transactionMode ?? null,
    advisoryLockAcquired: input.advisoryLockAcquired,
    sentinelBefore: input.sentinelBefore ?? null,
    sentinelAfter: input.sentinelAfter ?? null,
    psqlExitCode: null,
    psqlSignal: null,
    stdoutTail: null,
    stderrTail: null,
    errorMessage: input.errorMessage,
    state: input.state,
    finished: true,
  })

  const eventType =
    input.auditEventType === undefined
      ? input.state === 'failed'
        ? ('db.migration.apply.failed' as const)
        : null
      : input.auditEventType
  if (eventType === null) {
    return
  }
  await auditTerminal(deps, client, params, attemptId, eventType, {
    state: input.state,
    error: input.errorMessage,
    ...(input.auditExtra ?? {}),
  })
}

async function auditTerminal(
  deps: ApplyMigrationDeps,
  client: Queryable,
  params: ApplyMigrationParams,
  attemptId: string,
  eventType: AuditEventType,
  extra: Record<string, JsonValue>,
): Promise<void> {
  await deps.appendAuditEvent(client, {
    actorType: params.requestedByUserId > 0 ? 'user' : 'system',
    actorUserId: params.requestedByUserId > 0 ? params.requestedByUserId : null,
    entityId: attemptId,
    entityType: 'migration_apply_attempt',
    eventType,
    module: 'config',
    payload: auditPayload(params, { attemptId, ...extra }),
    requestId: null,
    undoPayload: null,
  })
}

function auditPayload(
  params: ApplyMigrationParams,
  extra: Record<string, JsonValue>,
): JsonValue {
  return {
    migrationId: params.migrationId,
    jobId: params.jobId,
    requestedByUserId: params.requestedByUserId,
    ...extra,
  }
}

// ============================================================================
// Advisory lock helpers (session-level, on the dedicated client).
// ============================================================================

async function tryAdvisoryLock(client: Queryable, key: number): Promise<boolean> {
  const result = await client.query<{ locked: boolean }>(
    'select pg_try_advisory_lock($1::bigint) as locked',
    [key],
  )
  return result.rows[0]?.locked === true
}

async function unlockAdvisory(client: Queryable, key: number): Promise<void> {
  await client.query('select pg_advisory_unlock($1::bigint)', [key])
}

// ============================================================================
// psql invocation + redaction.
// ============================================================================

function applicationName(migrationId: string, jobId: number): string {
  return `helios-migration-apply:${migrationId}:job:${jobId}`
}

function buildRedactedCommand(
  psqlBin: string,
  mainFileAbsPath: string,
  appName: string,
): string {
  return (
    `${psqlBin} -X --no-psqlrc -v ON_ERROR_STOP=1 -f ${mainFileAbsPath} ` +
    `(application_name=${appName}; connection via PG* env, credentials redacted)`
  )
}

/**
 * Spawn psql with no shell, absolute binary, hardened flags, cwd = migrations
 * dir, and connection via PG* env. Captures bounded, redacted stdout/stderr
 * tails. Never throws for a psql failure — the caller inspects the result.
 */
export async function spawnPsql(options: RunPsqlOptions): Promise<PsqlRunResult> {
  return new Promise<PsqlRunResult>((resolve) => {
    const child = spawn(
      options.psqlBin,
      ['-X', '--no-psqlrc', '-v', 'ON_ERROR_STOP=1', '-f', options.mainFileAbsPath],
      {
        cwd: options.cwd,
        env: {
          ...options.pgEnv,
          PGAPPNAME: options.applicationName,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )

    const stdout = new BoundedTail(options.outputTailBytes)
    const stderr = new BoundedTail(options.outputTailBytes)
    let settled = false

    child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk))
    child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk))

    child.on('error', (error) => {
      if (settled) {
        return
      }
      settled = true
      resolve({
        exitCode: null,
        signal: null,
        stdoutTail: redact(stdout.toString(), options.redactValues),
        stderrTail: redact(stderr.toString(), options.redactValues),
        spawnError: error instanceof Error ? error.message : String(error),
      })
    })

    child.on('close', (code, signal) => {
      if (settled) {
        return
      }
      settled = true
      resolve({
        exitCode: code,
        signal: signal ?? null,
        stdoutTail: redact(stdout.toString(), options.redactValues),
        stderrTail: redact(stderr.toString(), options.redactValues),
        spawnError: null,
      })
    })
  })
}

/** Retains only the last `maxBytes` of a byte stream. */
class BoundedTail {
  private chunks: Buffer[] = []
  private total = 0
  constructor(private readonly maxBytes: number) {}

  push(chunk: Buffer): void {
    this.chunks.push(chunk)
    this.total += chunk.length
    if (this.total > this.maxBytes * 2) {
      this.compact()
    }
  }

  private compact(): void {
    const joined = Buffer.concat(this.chunks)
    const tail = joined.length > this.maxBytes ? joined.subarray(joined.length - this.maxBytes) : joined
    this.chunks = [tail]
    this.total = tail.length
  }

  toString(): string {
    const joined = Buffer.concat(this.chunks)
    const tail = joined.length > this.maxBytes ? joined.subarray(joined.length - this.maxBytes) : joined
    return tail.toString('utf8')
  }
}

function redact(text: string, redactValues: string[]): string {
  let out = text
  for (const value of redactValues) {
    if (value.length === 0) {
      continue
    }
    out = out.split(value).join('«redacted»')
  }
  return out
}

async function getPsqlVersion(psqlBin: string): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    const child = spawn(psqlBin, ['--version'], { stdio: ['ignore', 'pipe', 'ignore'] })
    const out = new BoundedTail(1024)
    let settled = false
    child.stdout?.on('data', (chunk: Buffer) => out.push(chunk))
    child.on('error', () => {
      if (settled) return
      settled = true
      resolve(null)
    })
    child.on('close', () => {
      if (settled) return
      settled = true
      const text = out.toString().trim()
      resolve(text.length > 0 ? text : null)
    })
  })
}

/**
 * Parse DATABASE_URL into PG* connection env vars so psql connects without a URL
 * in argv and without the password ever appearing in a logged command line.
 */
export function buildPgEnvFromDatabaseUrl(databaseUrl: string): {
  env: Record<string, string>
  redactValues: string[]
} {
  const url = new URL(databaseUrl)
  const env: Record<string, string> = {}
  if (url.hostname) {
    env.PGHOST = url.hostname
  }
  if (url.port) {
    env.PGPORT = url.port
  }
  const database = url.pathname.replace(/^\//, '')
  if (database) {
    env.PGDATABASE = decodeURIComponent(database)
  }
  if (url.username) {
    env.PGUSER = decodeURIComponent(url.username)
  }
  const redactValues: string[] = []
  if (url.password) {
    const password = decodeURIComponent(url.password)
    env.PGPASSWORD = password
    redactValues.push(password)
  }
  const sslmode = url.searchParams.get('sslmode')
  if (sslmode) {
    env.PGSSLMODE = sslmode
  }
  return { env, redactValues }
}

function realApplyMigrationDeps(): ApplyMigrationDeps {
  return {
    connect: () => getPool().connect(),
    resolveEligibility: (migrationId) => resolveMigrationApplyEligibility(migrationId),
    isMigrationAppliedLive,
    invalidatePendingMigrationsCache: resetPendingMigrationsCache,
    appendAuditEvent,
    resolvePsqlBin: () => readOptionalEnv('HELIOS_PSQL_BIN'),
    getPsqlVersion,
    buildPgEnv: () => buildPgEnvFromDatabaseUrl(readRequiredDatabaseUrl()),
    runPsql: spawnPsql,
    deployedBuildId: () => readOptionalEnv('HELIOS_BUILD_ID'),
  }
}
