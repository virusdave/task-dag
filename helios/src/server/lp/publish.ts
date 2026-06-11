// Publish a compiled bundle to the artifact root: content-addressed
// immutable files + a signed manifest + an atomically-swapped, signed
// `current.json` pointer (parent EPIC_PLAN §5).
//
// - Bundle files are immutable; only current.json is mutable and is
//   written via same-dir write-temp → fsync(file) → fsync(dir) →
//   rename(), so a reader never sees a torn pointer.
// - `version` is monotonic: a dry-run / real publish reads the existing
//   pointer and increments. Rollback is a NEW higher version pointing at
//   a previous bundle_id (never a rewrite) — callers pass that bundle_id.
// - Signing keys are provided by the caller (env/operator file); this
//   module never reads them from the artifact root.

import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { canonicalJsonStringify } from './canonicalJson.js'
import { CurrentPointerSchema, type DisabledVariant, type Manifest } from './contracts.js'
import type { CompiledBundle } from './compile.js'
import { sha256Hex } from './hash.js'
import { signPayload } from './signing.js'

export type LpEnvironment = 'prod' | 'preview' | 'staging' | 'nonprod'

export interface PublishOptions {
  readonly compiled: CompiledBundle
  readonly privateKeyPem: string
  readonly artifactRoot: string
  readonly environment: LpEnvironment
  readonly minRendererVersion: string
  readonly automationGitSha: string
  readonly generatedFrom: Manifest['generated_from']
  readonly previousBundleId?: string
  readonly disabledVariants?: readonly DisabledVariant[]
  /** Override the monotonic version (else existing pointer version + 1). */
  readonly version?: number
  /**
   * Candidate-only publish: write the immutable bundle artifacts + a
   * *candidate* pointer, and never touch the live `current.json`. The
   * live pointer stays frozen as last-known-good. (This is the P5
   * dual-publish path.)
   */
  readonly candidateOnly?: boolean
  /**
   * Override the candidate pointer filename within the env dir. Lets the
   * caller stage to a unique pending file, validate it, then atomically
   * promote it to the canonical `current.candidate.json` only on success.
   * Ignored unless `candidateOnly` (or the `dryRun` alias) is set.
   */
  readonly candidatePointerName?: string
  /** @deprecated Back-compat alias for {@link candidateOnly}. */
  readonly dryRun?: boolean
  readonly now?: Date
}

export interface PublishResult {
  readonly bundleId: string
  readonly version: number
  readonly manifestSha256: string
  readonly bundleDir: string
  readonly pointerPath: string
  /** True when this was a candidate-only publish (live pointer untouched). */
  readonly candidate: boolean
  /** @deprecated Back-compat alias for {@link candidate}. */
  readonly dryRun: boolean
}

function pointerSigningPayload(
  manifestSha256: string,
  version: number,
  disabledVariants: readonly DisabledVariant[],
): string {
  return canonicalJsonStringify({
    manifest_sha256: manifestSha256,
    version,
    disabled_variants: disabledVariants,
  })
}

/** Signing payload for the manifest = the manifest with `signature` removed. */
export function manifestSigningPayload(manifest: Omit<Manifest, 'signature'>): string {
  return canonicalJsonStringify(manifest)
}

/** Read the monotonic version of a pointer file; 0 if absent/unparseable. */
export function readPointerVersion(pointerPath: string): number {
  try {
    const raw = readFileSync(pointerPath, 'utf8')
    const parsed = CurrentPointerSchema.safeParse(JSON.parse(raw))
    return parsed.success ? parsed.data.version : 0
  } catch {
    return 0
  }
}

/** Canonical relative URL of a bundle's manifest within the artifact root. */
export function manifestUrlFor(bundleId: string): string {
  return `bundles/${bundleId}/manifest.json`
}

export interface SignedPointerInput {
  readonly environment: LpEnvironment
  readonly bundleId: string
  readonly manifestUrl: string
  readonly manifestSha256: string
  readonly version: number
  readonly previousBundleId?: string
  readonly disabledVariants: readonly DisabledVariant[]
  readonly publishedAt: string
  readonly privateKeyPem: string
}

/**
 * Build the canonical, signed `current.json` pointer bytes. Single source
 * of truth for the pointer shape + signing payload, shared by initial
 * publish, candidate publish, P6 promotion, and rollback so every pointer
 * is byte-identical in structure and signed the same way.
 */
export function buildSignedPointerBytes(input: SignedPointerInput): string {
  const signature = signPayload(
    pointerSigningPayload(input.manifestSha256, input.version, input.disabledVariants),
    input.privateKeyPem,
  )
  const pointer = {
    schema: 'freshlybaked.lp.current.v1' as const,
    environment: input.environment,
    bundle_id: input.bundleId,
    manifest_url: input.manifestUrl,
    manifest_sha256: input.manifestSha256,
    version: input.version,
    published_at: input.publishedAt,
    ...(input.previousBundleId ? { previous_bundle_id: input.previousBundleId } : {}),
    signature,
    ...(input.disabledVariants.length > 0 ? { disabled_variants: input.disabledVariants } : {}),
  }
  // Self-validate the pointer before anyone writes it.
  CurrentPointerSchema.parse(pointer)
  return canonicalJsonStringify(pointer)
}

export function writeFileAtomic(targetPath: string, dir: string, tmpName: string, data: string): void {
  const tmpPath = join(dir, tmpName)
  const fd = openSync(tmpPath, 'w')
  try {
    writeFileSync(fd, data)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(tmpPath, targetPath)
  // fsync the directory so the rename is durable.
  const dirFd = openSync(dir, 'r')
  try {
    fsyncSync(dirFd)
  } finally {
    closeSync(dirFd)
  }
}

/**
 * Atomically move `fromPath` → `toPath` within the same directory and
 * fsync the directory so the rename is durable. POSIX `rename(2)` is
 * atomic, so a reader sees either the old or the new file, never a torn
 * one. Used to promote a validated staging pointer to its canonical name.
 */
export function durableRename(fromPath: string, toPath: string, dir: string): void {
  renameSync(fromPath, toPath)
  const dirFd = openSync(dir, 'r')
  try {
    fsyncSync(dirFd)
  } finally {
    closeSync(dirFd)
  }
}

export function publishBundle(opts: PublishOptions): PublishResult {
  const { compiled, artifactRoot, environment } = opts
  const now = opts.now ?? new Date()
  const disabledVariants = opts.disabledVariants ?? []

  const bundleDir = join(artifactRoot, 'bundles', compiled.bundleId)
  mkdirSync(bundleDir, { recursive: true })

  // 1. Write immutable content files (canonical bytes) and hash them.
  const bundleBytes = canonicalJsonStringify(compiled.bundle)
  const policyBytes = canonicalJsonStringify(compiled.policy)
  const assetsBytes = canonicalJsonStringify(compiled.assets)
  writeFileSync(join(bundleDir, 'bundle.json'), bundleBytes)
  writeFileSync(join(bundleDir, 'policy.json'), policyBytes)
  writeFileSync(join(bundleDir, 'assets.json'), assetsBytes)

  // 2. Build + sign the manifest, then write it and hash its bytes.
  const manifestSansSig: Omit<Manifest, 'signature'> = {
    schema: 'freshlybaked.lp.bundle-manifest.v1',
    bundle_id: compiled.bundleId,
    min_renderer_version: opts.minRendererVersion,
    automation_git_sha: opts.automationGitSha,
    generated_from: opts.generatedFrom,
    files: {
      bundle: { url: 'bundle.json', sha256: sha256Hex(bundleBytes) },
      policy: { url: 'policy.json', sha256: sha256Hex(policyBytes) },
      assets: { url: 'assets.json', sha256: sha256Hex(assetsBytes) },
    },
  }
  const manifestSignature = signPayload(manifestSigningPayload(manifestSansSig), opts.privateKeyPem)
  const manifest: Manifest = { ...manifestSansSig, signature: manifestSignature }
  const manifestBytes = canonicalJsonStringify(manifest)
  writeFileSync(join(bundleDir, 'manifest.json'), manifestBytes)
  const manifestSha256 = sha256Hex(manifestBytes)

  // 3. Build the signed pointer.
  const envDir = join(artifactRoot, environment)
  mkdirSync(envDir, { recursive: true })
  const version = opts.version ?? readPointerVersion(join(envDir, 'current.json')) + 1
  const pointerBytes = buildSignedPointerBytes({
    environment,
    bundleId: compiled.bundleId,
    manifestUrl: manifestUrlFor(compiled.bundleId),
    manifestSha256,
    version,
    previousBundleId: opts.previousBundleId,
    disabledVariants,
    publishedAt: now.toISOString(),
    privateKeyPem: opts.privateKeyPem,
  })

  // 4. Write the pointer atomically (temp → fsync → rename → fsync dir),
  //    so a reader never sees a torn pointer. Candidate-only publishes
  //    write a candidate file and never touch the live `current.json`.
  const candidate = opts.candidateOnly === true || opts.dryRun === true
  const pointerName = candidate
    ? opts.candidatePointerName ?? 'current.candidate.json'
    : 'current.json'
  const pointerPath = join(envDir, pointerName)
  writeFileAtomic(pointerPath, envDir, `${pointerName}.tmp.${version}`, pointerBytes)

  return {
    bundleId: compiled.bundleId,
    version,
    manifestSha256,
    bundleDir,
    pointerPath,
    candidate,
    dryRun: candidate,
  }
}
