// Staged SEO bundle publish: validate BEFORE the live pointer swap
// (child FreshlyBakedNYC/automation#46, P1, task cfa2dc0).
//
// publishSeoBundle writes the live `current.json` last and atomically, but
// any self-validation it does is necessarily AFTER the live pointer already
// exists. For the autonomous hybrid-sync job we need the LP-style staged
// promotion instead: write the immutable bundle + a *pending* pointer,
// validate that pending pointer fail-closed, and only THEN atomically
// rename it onto `current.json`. If validation fails, the live pointer is
// never touched — a bad publish can never go live.
//
// This composes the existing primitives (publishSeoBundle candidate mode +
// validateSeoBundle + durableRename); it is intentionally a separate module
// so publish.ts and validate.ts keep their current (non-circular) imports.
//
// Satisfies: virusdave/top-level#17 · Phase: P1

import { unlinkSync } from 'node:fs'
import { join } from 'node:path'

import { durableRename } from '../lp/publish.js'
import type { CompiledSeoBundle } from './compile.js'
import type { Manifest, SeoEnvironment } from './contracts.js'
import { publishSeoBundle, readSeoPointerVersion } from './publish.js'
import { validateSeoBundle } from './validate.js'

export interface StagedSeoPublishOptions {
  readonly compiled: CompiledSeoBundle
  readonly privateKeyPem: string
  /** Public key to validate against — should be the key MSS trusts. */
  readonly publicKeyPem: string
  readonly artifactRoot: string
  readonly environment: SeoEnvironment
  readonly minRendererVersion: string
  readonly automationGitSha: string
  readonly generatedFrom: Manifest['generated_from']
  readonly previousBundleId?: string
  /** Renderer version used only for integrity validation (default 999.0.0). */
  readonly verifyRendererVersion?: string
  /** Pending pointer filename (default `current.pending.json`). */
  readonly pendingPointerName?: string
  readonly now?: Date
}

export interface StagedSeoPublishResult {
  readonly seoBundleId: string
  readonly version: number
  readonly bundleDir: string
  /** The live pointer path that was promoted. */
  readonly pointerPath: string
  readonly previousVersion: number
}

export class StagedSeoPublishError extends Error {
  constructor(
    message: string,
    public readonly errors: string[],
  ) {
    super(`${message}:\n  - ${errors.join('\n  - ')}`)
    this.name = 'StagedSeoPublishError'
  }
}

/**
 * Publish a compiled SEO bundle through a validated staged promotion. The
 * live `current.json` is swapped only after the pending pointer passes full
 * fail-closed validation; on any validation failure the live pointer is
 * left untouched and a StagedSeoPublishError is thrown.
 */
export function publishSeoBundleStaged(opts: StagedSeoPublishOptions): StagedSeoPublishResult {
  const verifyRenderer = opts.verifyRendererVersion ?? '999.0.0'
  // Unique per attempt so concurrent publishers never clobber each other's
  // pending pointer (the live swap is additionally CAS-guarded below).
  const pendingName =
    opts.pendingPointerName ?? `current.pending.${process.pid}.${Date.now()}.json`
  const envDir = join(opts.artifactRoot, opts.environment)
  const livePointerPath = join(envDir, 'current.json')

  const previousVersion = readSeoPointerVersion(livePointerPath)
  const nextVersion = previousVersion + 1

  // 1. Write immutable bundle artifacts + a PENDING pointer (live untouched).
  const staged = publishSeoBundle({
    compiled: opts.compiled,
    privateKeyPem: opts.privateKeyPem,
    artifactRoot: opts.artifactRoot,
    environment: opts.environment,
    minRendererVersion: opts.minRendererVersion,
    automationGitSha: opts.automationGitSha,
    generatedFrom: opts.generatedFrom,
    previousBundleId: opts.previousBundleId,
    version: nextVersion,
    candidateOnly: true,
    candidatePointerName: pendingName,
    now: opts.now,
  })

  // 2. Validate the pending pointer fail-closed, requiring a monotonic bump.
  const pendingValidation = validateSeoBundle({
    artifactRoot: opts.artifactRoot,
    pointerPath: staged.pointerPath,
    publicKeyPem: opts.publicKeyPem,
    runningRendererVersion: verifyRenderer,
    activeVersion: previousVersion,
  })
  if (!pendingValidation.ok) {
    // Live pointer never touched. Best-effort clean up the pending file.
    try {
      unlinkSync(staged.pointerPath)
    } catch {
      // ignore — a leftover pending pointer is inert (nothing reads it).
    }
    throw new StagedSeoPublishError(
      'staged SEO bundle failed pre-promotion validation; live pointer left unchanged',
      pendingValidation.errors,
    )
  }

  // 3. CAS guard: another publisher (CLI / manual) may have swapped the live
  //    pointer between our version read and now. If so, abort rather than
  //    overwrite a newer live bundle or regress its version.
  const liveVersionNow = readSeoPointerVersion(livePointerPath)
  if (liveVersionNow !== previousVersion) {
    try {
      unlinkSync(staged.pointerPath)
    } catch {
      // ignore — leftover pending pointer is inert.
    }
    throw new StagedSeoPublishError(
      'live SEO pointer changed during staged publish; aborting promotion',
      [`expected live version ${previousVersion}, found ${liveVersionNow}`],
    )
  }

  // 4. Atomically promote the validated pending pointer onto current.json.
  durableRename(staged.pointerPath, livePointerPath, envDir)

  // 5. Re-validate the now-live pointer (defense in depth).
  const liveValidation = validateSeoBundle({
    artifactRoot: opts.artifactRoot,
    pointerPath: livePointerPath,
    publicKeyPem: opts.publicKeyPem,
    runningRendererVersion: verifyRenderer,
  })
  if (!liveValidation.ok) {
    throw new StagedSeoPublishError(
      'live SEO pointer failed post-promotion validation',
      liveValidation.errors,
    )
  }

  return {
    seoBundleId: staged.seoBundleId,
    version: nextVersion,
    bundleDir: staged.bundleDir,
    pointerPath: livePointerPath,
    previousVersion,
  }
}
