// P5 "Dual-publish; stop cross-repo writes" (parent EPIC_PLAN §10 P5,
// child FreshlyBakedNYC/automation#42, top-level virusdave/top-level#13).
//
// This is the Helios-side operator-approval entrypoint: when a human
// approves new landing-page content, that approval triggers a single
// sanctioned action — **build + validate + publish a candidate bundle**
// — and the legacy cross-repo commit producer (the path that authored
// content directly into mostly-static-sites) is OFF by default.
//
// Critical safety properties (canon §1 "never auto-publish user-visible
// content without explicit human approval", parent §10 P5 "legacy
// served"):
//
//   - A candidate publish writes the immutable, content-addressed
//     bundle files and a *candidate* pointer (`current.candidate.json`).
//     It NEVER swaps the live `current.json`. Promotion of a candidate
//     to the live pointer is the separate, operator-gated P6 canary
//     step — not something this function does.
//   - The existing live `current.json` and its bundles are therefore
//     left frozen as the last-known-good fallback ("legacy manifests
//     frozen for fallback").
//   - The legacy cross-repo commit producer is gated behind
//     `crossRepoCommitProducerEnabled` and defaults to OFF. Re-enabling
//     it is the documented rollback lever (parent §10 P5 "re-enable
//     legacy commit path"); this module refuses to take that path
//     unless explicitly told to.

import { compileBundle, type CompileInput } from './compile.js'
import type { DisabledVariant, Manifest } from './contracts.js'
import { publishBundle, type LpEnvironment } from './publish.js'
import { validateBundle, type ValidationResult } from './validate.js'

export interface ApprovedContentCandidateOptions {
  /** The approved landing-page content, ready to compile into a bundle. */
  readonly approvedContent: CompileInput
  readonly privateKeyPem: string
  /** Public key used to self-validate the candidate we just wrote. */
  readonly publicKeyPem: string
  readonly artifactRoot: string
  readonly environment: LpEnvironment
  readonly minRendererVersion: string
  readonly automationGitSha: string
  readonly generatedFrom: Manifest['generated_from']
  readonly previousBundleId?: string
  readonly disabledVariants?: readonly DisabledVariant[]
  /** Renderer version to self-validate against (defaults to the floor). */
  readonly verifyRendererVersion?: string
  /**
   * Legacy cross-repo commit producer. Default `false` — disabled. When
   * `false`, content flows ONLY through the published bundle candidate.
   * Set `true` only as the documented P5 rollback lever (parent §10).
   */
  readonly crossRepoCommitProducerEnabled?: boolean
  readonly now?: Date
}

export interface ApprovedContentCandidateResult {
  readonly ok: boolean
  readonly bundleId: string
  readonly version: number
  /** Path to `current.candidate.json` (the live pointer is untouched). */
  readonly candidatePointerPath: string
  readonly bundleDir: string
  readonly validation: ValidationResult
  /** Whether the legacy cross-repo commit producer was engaged. */
  readonly crossRepoCommitProducerEnabled: boolean
  /** Operator's likely next step (canon §3 user-efficiency). */
  readonly promoteHint: string
  readonly errors: string[]
}

/**
 * Operator-approval-triggered dual-publish-candidate. Compiles the
 * approved content, publishes a candidate (never the live pointer), and
 * fail-closed self-validates it. Throws `CompileError` if the approved
 * content does not compile; returns `ok:false` with the validation
 * errors if the candidate fails validation.
 */
export function publishApprovedContentCandidate(
  opts: ApprovedContentCandidateOptions,
): ApprovedContentCandidateResult {
  const crossRepoCommitProducerEnabled = opts.crossRepoCommitProducerEnabled === true

  const compiled = compileBundle(opts.approvedContent)

  // Candidate publish: writes immutable bundle files + current.candidate.json
  // only. `dryRun` is publish.ts's name for exactly this "write a
  // candidate pointer, never touch current.json" behaviour.
  const published = publishBundle({
    compiled,
    privateKeyPem: opts.privateKeyPem,
    artifactRoot: opts.artifactRoot,
    environment: opts.environment,
    minRendererVersion: opts.minRendererVersion,
    automationGitSha: opts.automationGitSha,
    generatedFrom: opts.generatedFrom,
    previousBundleId: opts.previousBundleId,
    disabledVariants: opts.disabledVariants,
    dryRun: true,
    now: opts.now,
  })

  const validation = validateBundle({
    artifactRoot: opts.artifactRoot,
    pointerPath: published.pointerPath,
    publicKeyPem: opts.publicKeyPem,
    runningRendererVersion: opts.verifyRendererVersion ?? '999.0.0',
  })

  const errors = validation.ok
    ? []
    : [`candidate self-validation failed:`, ...validation.errors.map((e) => `  - ${e}`)]

  const promoteHint = validation.ok
    ? `candidate ${published.bundleId} v${published.version} is built & validated at ` +
      `${published.pointerPath}; promote to live traffic via the P6 canary ` +
      `(operator-gated pointer flip), not by editing current.json by hand.`
    : `candidate ${published.bundleId} did NOT validate; live pointer left frozen ` +
      `(fail-closed). Fix the content/policy and re-run before any promotion.`

  return {
    ok: validation.ok,
    bundleId: published.bundleId,
    version: published.version,
    candidatePointerPath: published.pointerPath,
    bundleDir: published.bundleDir,
    validation,
    crossRepoCommitProducerEnabled,
    promoteHint,
    errors,
  }
}
