// P6 "Canary cutover" primitives (parent EPIC_PLAN §10 P6): promote a
// validated candidate to the live `current.json`, and roll back to a
// previous known-good bundle. Both produce a NEW, higher-versioned,
// freshly-signed live pointer (never a rewrite of an old version), so
// mss's monotonic-version + signature checks accept them.
//
// IMPORTANT operational boundary (canon §1, Oracle review): flipping the
// live pointer affects live ad traffic and revenue. These functions are
// the mechanism, but RUNNING them against the prod `/cloud` artifact
// root — and any LP_RUNTIME_MODE/percent/allowlist change — is an
// OPERATOR action, gated on the P6 canary ramp + revenue guardrail. An
// autonomous agent builds and tests this tooling; it does not execute it
// against prod.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { CurrentPointerSchema, type CurrentPointer, type DisabledVariant } from './contracts.js'
import { sha256Hex } from './hash.js'
import { resolveArtifactPath } from './paths.js'
import {
  buildSignedPointerBytes,
  manifestUrlFor,
  readPointerVersion,
  writeFileAtomic,
  type LpEnvironment,
} from './publish.js'
import { validateBundle, type ValidationResult } from './validate.js'

export interface PromoteCandidateOptions {
  readonly artifactRoot: string
  readonly environment: LpEnvironment
  readonly privateKeyPem: string
  /** Trusted (mss-side) public key to validate against. */
  readonly publicKeyPem: string
  /** Actually-deployed mss renderer version to validate against. */
  readonly runningRendererVersion: string
  /**
   * Allow promoting a candidate whose version != live+1 (stale because
   * the live pointer advanced since the candidate was built). Off by
   * default — the safe path is to re-run publish-candidate.
   */
  readonly allowVersionRebase?: boolean
  readonly now?: Date
}

export interface PromoteResult {
  readonly ok: boolean
  readonly bundleId?: string
  readonly fromVersion: number
  readonly toVersion?: number
  readonly previousBundleId?: string
  readonly livePointerPath: string
  readonly validation?: ValidationResult
  readonly rollbackHint?: string
  readonly errors: string[]
}

function readPointer(path: string): CurrentPointer | null {
  try {
    const parsed = CurrentPointerSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

/**
 * Promote `current.candidate.json` to the live `current.json`. Validates
 * the candidate fail-closed against the trusted key + deployed renderer,
 * enforces version monotonicity, writes a fresh signed live pointer
 * atomically, and re-validates the result.
 */
export function promoteCandidate(opts: PromoteCandidateOptions): PromoteResult {
  const envDir = join(opts.artifactRoot, opts.environment)
  const livePath = join(envDir, 'current.json')
  const candidatePath = join(envDir, 'current.candidate.json')

  const fromVersion = readPointerVersion(livePath)
  const live = readPointer(livePath)
  if (fromVersion > 0 && live === null) {
    return {
      ok: false,
      fromVersion,
      livePointerPath: livePath,
      errors: ['live current.json exists but is unparseable; refusing to promote (fail-closed)'],
    }
  }

  const candidate = readPointer(candidatePath)
  if (candidate === null) {
    return {
      ok: false,
      fromVersion,
      livePointerPath: livePath,
      errors: [`no valid candidate at ${candidatePath}; run lp-bundle publish-candidate first`],
    }
  }

  // Fail-closed: the candidate must validate against the trusted key and
  // the deployed renderer before it can be promoted.
  const candidateValidation = validateBundle({
    artifactRoot: opts.artifactRoot,
    pointerPath: candidatePath,
    publicKeyPem: opts.publicKeyPem,
    runningRendererVersion: opts.runningRendererVersion,
  })
  if (!candidateValidation.ok) {
    return {
      ok: false,
      bundleId: candidate.bundle_id,
      fromVersion,
      livePointerPath: livePath,
      validation: candidateValidation,
      errors: ['candidate failed validation; not promoting:', ...candidateValidation.errors.map((e) => `  - ${e}`)],
    }
  }

  // Version monotonicity: a candidate built against the current live
  // pointer has version == live+1. A mismatch means the live pointer
  // moved underneath it (stale candidate).
  const expected = fromVersion + 1
  if (candidate.version !== expected && !opts.allowVersionRebase) {
    return {
      ok: false,
      bundleId: candidate.bundle_id,
      fromVersion,
      livePointerPath: livePath,
      errors: [
        `stale candidate: version ${candidate.version} != live+1 (${expected}); ` +
          `the live pointer advanced since this candidate was built. Re-run ` +
          `publish-candidate, or pass --allow-version-rebase to override.`,
      ],
    }
  }

  const toVersion = expected
  const livePointerBytes = buildSignedPointerBytes({
    environment: opts.environment,
    bundleId: candidate.bundle_id,
    manifestUrl: candidate.manifest_url,
    manifestSha256: candidate.manifest_sha256,
    version: toVersion,
    previousBundleId: live?.bundle_id,
    disabledVariants: candidate.disabled_variants ?? [],
    publishedAt: (opts.now ?? new Date()).toISOString(),
    privateKeyPem: opts.privateKeyPem,
  })
  writeFileAtomic(livePath, envDir, `current.json.tmp.${toVersion}`, livePointerBytes)

  // Re-validate the freshly-written live pointer.
  const liveValidation = validateBundle({
    artifactRoot: opts.artifactRoot,
    pointerPath: livePath,
    publicKeyPem: opts.publicKeyPem,
    runningRendererVersion: opts.runningRendererVersion,
  })

  return {
    ok: liveValidation.ok,
    bundleId: candidate.bundle_id,
    fromVersion,
    toVersion,
    previousBundleId: live?.bundle_id,
    livePointerPath: livePath,
    validation: liveValidation,
    rollbackHint: live
      ? `to roll back: lp-bundle rollback --to-bundle ${live.bundle_id} (publishes a new ` +
        `higher version pointing at the previous good bundle).`
      : `first live publish for this environment; no previous bundle to roll back to.`,
    errors: liveValidation.ok ? [] : liveValidation.errors,
  }
}

export interface RollbackOptions {
  readonly artifactRoot: string
  readonly environment: LpEnvironment
  /** The previous known-good bundle to point at. */
  readonly toBundleId: string
  readonly privateKeyPem: string
  readonly publicKeyPem: string
  readonly runningRendererVersion: string
  /**
   * Kill-list for the rolled-back pointer. Defaults to preserving the
   * CURRENT live pointer's kill-list (a content rollback should not drop
   * an active ROI safety overlay).
   */
  readonly disabledVariants?: readonly DisabledVariant[]
  readonly now?: Date
}

/**
 * Roll back to a previous known-good bundle by publishing a NEW,
 * higher-versioned, freshly-signed live pointer that references it
 * (never a rewrite of an old pointer — that would be rejected by mss's
 * monotonic-version guard). Parent §5: rollback is a forward publish.
 */
export function rollbackToBundle(opts: RollbackOptions): PromoteResult {
  const envDir = join(opts.artifactRoot, opts.environment)
  const livePath = join(envDir, 'current.json')

  const fromVersion = readPointerVersion(livePath)
  const live = readPointer(livePath)
  if (fromVersion > 0 && live === null) {
    return {
      ok: false,
      fromVersion,
      livePointerPath: livePath,
      errors: ['live current.json exists but is unparseable; refusing to roll back (fail-closed)'],
    }
  }

  // Resolve + hash the target bundle's manifest (path-safe).
  const manifestRel = manifestUrlFor(opts.toBundleId)
  const manifestPath = resolveArtifactPath(opts.artifactRoot, manifestRel)
  if (manifestPath === null) {
    return {
      ok: false,
      fromVersion,
      livePointerPath: livePath,
      errors: [`unsafe or invalid bundle id '${opts.toBundleId}'`],
    }
  }
  let manifestSha256: string
  try {
    manifestSha256 = sha256Hex(readFileSync(manifestPath, 'utf8'))
  } catch {
    return {
      ok: false,
      fromVersion,
      livePointerPath: livePath,
      errors: [`target bundle '${opts.toBundleId}' has no readable manifest at ${manifestRel}`],
    }
  }

  const toVersion = fromVersion + 1
  const disabledVariants = opts.disabledVariants ?? live?.disabled_variants ?? []
  const pointerBytes = buildSignedPointerBytes({
    environment: opts.environment,
    bundleId: opts.toBundleId,
    manifestUrl: manifestRel,
    manifestSha256,
    version: toVersion,
    previousBundleId: live?.bundle_id,
    disabledVariants,
    publishedAt: (opts.now ?? new Date()).toISOString(),
    privateKeyPem: opts.privateKeyPem,
  })
  writeFileAtomic(livePath, envDir, `current.json.tmp.${toVersion}`, pointerBytes)

  const liveValidation = validateBundle({
    artifactRoot: opts.artifactRoot,
    pointerPath: livePath,
    publicKeyPem: opts.publicKeyPem,
    runningRendererVersion: opts.runningRendererVersion,
  })

  return {
    ok: liveValidation.ok,
    bundleId: opts.toBundleId,
    fromVersion,
    toVersion,
    previousBundleId: live?.bundle_id,
    livePointerPath: livePath,
    validation: liveValidation,
    errors: liveValidation.ok ? [] : liveValidation.errors,
  }
}
