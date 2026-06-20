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
//     step (see promoteCandidate) — not something this function does.
//   - The candidate pointer is staged to a unique pending file,
//     validated, and only then atomically promoted to the canonical
//     `current.candidate.json`. A candidate that fails validation never
//     lands at the canonical name, so P6 promotion can never pick up an
//     invalid candidate. Any previously-good `current.candidate.json`
//     is left untouched on failure.
//   - The existing live `current.json` and its bundles are left frozen
//     as the last-known-good fallback ("legacy manifests frozen").
//   - The legacy cross-repo commit producer is gated behind
//     `crossRepoCommitProducerEnabled` and defaults to OFF. There is no
//     legacy producer implementation in Helios (content historically
//     flowed via humans/scripts authoring into the mss repo), so this is
//     a policy marker / rollback lever, not an executable path here.

import { rmSync } from 'node:fs'
import { join } from 'node:path'

import { compileBundle, type CompileInput } from './compile.js'
import type { DisabledVariant, Manifest } from './contracts.js'
import type { BrandingOpaqueRegistry } from './registryCheck.js'
import { durableRename, publishBundle, type LpEnvironment } from './publish.js'
import { validateBundle, type ValidationResult } from './validate.js'

export interface ApprovedContentCandidateOptions {
  /** The approved landing-page content, ready to compile into a bundle. */
  readonly approvedContent: CompileInput
  readonly privateKeyPem: string
  /**
   * Public key to self-validate the candidate. For prod candidates this
   * MUST be the key the mss runtime trusts (pass `--pubkey`), so that
   * signing with the wrong private key is caught here rather than
   * silently rejected by mss later.
   */
  readonly publicKeyPem: string
  readonly artifactRoot: string
  readonly environment: LpEnvironment
  readonly minRendererVersion: string
  readonly automationGitSha: string
  readonly generatedFrom: Manifest['generated_from']
  readonly previousBundleId?: string
  readonly disabledVariants?: readonly DisabledVariant[]
  /**
   * Opaque branding refs mss can serve (from the published branding manifest).
   * Threaded into BOTH the compile and the self-validation so a candidate that
   * emits a branding ref the registry can't resolve fails closed at compile
   * AND can never pass its own validation (P3 parity guard).
   */
  readonly brandingRegistry?: BrandingOpaqueRegistry
  /**
   * The renderer version to self-validate against. MUST be the version
   * actually deployed in the mss runtime, so a candidate that needs a
   * newer renderer than is live is rejected now (no permissive sentinel).
   */
  readonly verifyRendererVersion: string
  /**
   * Legacy cross-repo commit producer. Default `false` — disabled. When
   * `false`, content flows ONLY through the published bundle candidate.
   * `true` is the documented P5 rollback lever; it is a policy marker
   * here (Helios contains no legacy producer to run).
   */
  readonly crossRepoCommitProducerEnabled?: boolean
  readonly now?: Date
}

export interface ApprovedContentCandidateResult {
  readonly ok: boolean
  readonly bundleId: string
  readonly version: number
  /** Canonical candidate pointer path (only written when validation passed). */
  readonly candidatePointerPath: string
  readonly bundleDir: string
  readonly validation: ValidationResult
  /** Whether the legacy cross-repo commit producer was requested. */
  readonly crossRepoCommitProducerEnabled: boolean
  /** Operator's likely next step (canon §3 user-efficiency). */
  readonly promoteHint: string
  readonly errors: string[]
}

/**
 * Operator-approval-triggered dual-publish-candidate. Compiles the
 * approved content, stages a candidate (never the live pointer),
 * fail-closed validates it, and only on success atomically promotes the
 * staged pointer to the canonical `current.candidate.json`. Throws
 * `CompileError` if the approved content does not compile; returns
 * `ok:false` with the validation errors if the candidate fails.
 */
export function publishApprovedContentCandidate(
  opts: ApprovedContentCandidateOptions,
): ApprovedContentCandidateResult {
  const crossRepoCommitProducerEnabled = opts.crossRepoCommitProducerEnabled === true

  // Single source of truth for the kill-list: prefer the explicit option,
  // else whatever the approved content carries. The same value is both
  // compiled (validated against the registry) and signed into the pointer.
  const disabledVariants = opts.disabledVariants ?? opts.approvedContent.disabledVariants ?? []

  // The same registry is used to compile AND to self-validate below.
  const brandingRegistry = opts.brandingRegistry ?? opts.approvedContent.brandingRegistry

  const compiled = compileBundle({ ...opts.approvedContent, disabledVariants, brandingRegistry })

  const envDir = join(opts.artifactRoot, opts.environment)
  const stagingName = `current.candidate.pending.${compiled.bundleId}.json`
  const canonicalCandidatePath = join(envDir, 'current.candidate.json')

  // Stage the candidate pointer to a unique pending file (atomic write),
  // alongside the immutable bundle artifacts.
  const published = publishBundle({
    compiled,
    privateKeyPem: opts.privateKeyPem,
    artifactRoot: opts.artifactRoot,
    environment: opts.environment,
    minRendererVersion: opts.minRendererVersion,
    automationGitSha: opts.automationGitSha,
    generatedFrom: opts.generatedFrom,
    previousBundleId: opts.previousBundleId,
    disabledVariants,
    candidateOnly: true,
    candidatePointerName: stagingName,
    now: opts.now,
  })

  // Fail-closed validate the staged pointer against the trusted key and
  // the actually-deployed renderer version.
  const validation = validateBundle({
    artifactRoot: opts.artifactRoot,
    pointerPath: published.pointerPath,
    publicKeyPem: opts.publicKeyPem,
    runningRendererVersion: opts.verifyRendererVersion,
    brandingRegistry,
  })

  if (!validation.ok) {
    // Quarantine: drop the invalid staging pointer; leave any existing
    // good candidate and the live pointer untouched.
    rmSync(published.pointerPath, { force: true })
    return {
      ok: false,
      bundleId: published.bundleId,
      version: published.version,
      candidatePointerPath: canonicalCandidatePath,
      bundleDir: published.bundleDir,
      validation,
      crossRepoCommitProducerEnabled,
      promoteHint:
        `candidate ${published.bundleId} did NOT validate; staged pointer discarded and ` +
        `the live pointer left frozen (fail-closed). Fix the content/policy and re-run ` +
        `before any promotion.`,
      errors: ['candidate self-validation failed:', ...validation.errors.map((e) => `  - ${e}`)],
    }
  }

  // Valid → atomically promote the staged pointer to the canonical name.
  durableRename(published.pointerPath, canonicalCandidatePath, envDir)

  return {
    ok: true,
    bundleId: published.bundleId,
    version: published.version,
    candidatePointerPath: canonicalCandidatePath,
    bundleDir: published.bundleDir,
    validation,
    crossRepoCommitProducerEnabled,
    promoteHint:
      `candidate ${published.bundleId} v${published.version} is built & validated at ` +
      `${canonicalCandidatePath}; promote to live traffic with ` +
      `\`lp-bundle promote-candidate\` (operator-gated P6 canary), not by editing ` +
      `current.json by hand.`,
    errors: [],
  }
}
