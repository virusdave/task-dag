// Migration apply-eligibility resolver (automation#62, leaf 4).
//
// A single source of truth for "is this migration allowed to be applied via
// the admin Apply Now flow?" — reused by the worker engine (leaf 4) and the
// admin read/enqueue APIs (leaves 5/6). Per DESIGN.md "Gating / safety model",
// a migration is apply-eligible ONLY when ALL of the following hold:
//
//   1. it is a registered sentinel (allowlisted id → committed artifact),
//   2. it carries a complete Oracle `blessing` in the registry,
//   3. the deployed artifact-closure digest recomputed live equals the
//      blessing's `artifactSha256` (a stale blessing bound to an edited
//      include no longer matches), and
//   4. (for the worker) the payload's captured digest equals that same value.
//
// Live pending/applied state is checked SEPARATELY (via isMigrationAppliedLive)
// at apply time, cache-bypassed, because it changes over time; this module only
// answers the static (registry + artifact) half of eligibility.
//
// It is deliberately fail-closed: any resolver error, a missing blessing, or a
// digest mismatch yields an ineligible result with a machine-readable reason —
// never a silent "eligible".

import {
  MigrationArtifactError,
  readMigrationArtifactForReview,
  resolveMigrationArtifact,
  type ResolveOptions,
  type ResolvedMigrationArtifact,
} from './migrationArtifacts.js'
import {
  getMigrationSentinel,
  type MigrationBlessing,
} from './pendingMigrations.js'

export type MigrationApplyIneligibleReason =
  | 'unknown-migration-id'
  | 'not-blessed'
  | 'artifact-unresolvable'
  | 'digest-mismatch'

export interface MigrationApplyEligibilityEligible {
  readonly eligible: true
  readonly migrationId: string
  readonly blessing: MigrationBlessing
  readonly artifact: ResolvedMigrationArtifact
}

export interface MigrationApplyEligibilityIneligible {
  readonly eligible: false
  readonly migrationId: string
  readonly reason: MigrationApplyIneligibleReason
  /** Human-readable detail for surfacing to the operator / attempt record. */
  readonly detail: string
  /** Present when the artifact resolved but some later check failed. */
  readonly blessing: MigrationBlessing | null
  readonly artifact: ResolvedMigrationArtifact | null
}

export type MigrationApplyEligibility =
  | MigrationApplyEligibilityEligible
  | MigrationApplyEligibilityIneligible

/**
 * Compute the static (registry + artifact) apply-eligibility of a migration.
 * Does NOT touch the database and does NOT execute SQL — it only reads the
 * committed registry + on-disk artifact closure. Live pending/applied state is
 * the caller's separate responsibility.
 */
export function resolveMigrationApplyEligibility(
  migrationId: string,
  options: ResolveOptions = {},
): MigrationApplyEligibility {
  const sentinel = getMigrationSentinel(migrationId)
  if (sentinel === null) {
    return {
      eligible: false,
      migrationId,
      reason: 'unknown-migration-id',
      detail: `migrationId is not in the migration registry: ${migrationId}`,
      blessing: null,
      artifact: null,
    }
  }

  const blessing = sentinel.blessing ?? null
  if (blessing === null) {
    return {
      eligible: false,
      migrationId,
      reason: 'not-blessed',
      detail:
        `Migration ${migrationId} has no Oracle blessing in the registry; ` +
        'it is not apply-eligible until a blessing is recorded.',
      blessing: null,
      artifact: null,
    }
  }

  let artifact: ResolvedMigrationArtifact
  try {
    artifact = resolveMigrationArtifact(migrationId, options)
    // Apply eligibility also requires that the operator-facing review endpoint
    // can capture the entire exact artifact. Oversized or non-UTF-8 SQL must
    // never remain runnable while being impossible to inspect in Helios.
    const review = readMigrationArtifactForReview(migrationId, options)
    if (review.sha256 !== artifact.sha256) {
      throw new MigrationArtifactError(
        'review-artifact-changed',
        'Artifact changed while apply eligibility was being evaluated.',
      )
    }
  } catch (error) {
    const detail =
      error instanceof MigrationArtifactError
        ? `[${error.code}] ${error.message}`
        : error instanceof Error
          ? error.message
          : 'Unknown artifact resolution error.'
    return {
      eligible: false,
      migrationId,
      reason: 'artifact-unresolvable',
      detail,
      blessing,
      artifact: null,
    }
  }

  if (artifact.sha256 !== blessing.artifactSha256) {
    return {
      eligible: false,
      migrationId,
      reason: 'digest-mismatch',
      detail:
        `Deployed artifact digest ${artifact.sha256} does not match the ` +
        `blessing digest ${blessing.artifactSha256}; the reviewed artifact ` +
        'has changed since it was blessed.',
      blessing,
      artifact,
    }
  }

  return { eligible: true, migrationId, blessing, artifact }
}
