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
  /** Dry run: write artifacts + a candidate pointer, never touch current.json. */
  readonly dryRun?: boolean
  readonly now?: Date
}

export interface PublishResult {
  readonly bundleId: string
  readonly version: number
  readonly manifestSha256: string
  readonly bundleDir: string
  readonly pointerPath: string
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

function readExistingVersion(envDir: string): number {
  try {
    const raw = readFileSync(join(envDir, 'current.json'), 'utf8')
    const parsed = CurrentPointerSchema.safeParse(JSON.parse(raw))
    return parsed.success ? parsed.data.version : 0
  } catch {
    return 0
  }
}

function writeFileAtomic(targetPath: string, dir: string, tmpName: string, data: string): void {
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
  const version = opts.version ?? readExistingVersion(envDir) + 1
  const pointerSignature = signPayload(
    pointerSigningPayload(manifestSha256, version, disabledVariants),
    opts.privateKeyPem,
  )
  const pointer = {
    schema: 'freshlybaked.lp.current.v1' as const,
    environment,
    bundle_id: compiled.bundleId,
    manifest_url: `bundles/${compiled.bundleId}/manifest.json`,
    manifest_sha256: manifestSha256,
    version,
    published_at: now.toISOString(),
    ...(opts.previousBundleId ? { previous_bundle_id: opts.previousBundleId } : {}),
    signature: pointerSignature,
    ...(disabledVariants.length > 0 ? { disabled_variants: disabledVariants } : {}),
  }
  // Self-validate the pointer before writing it.
  CurrentPointerSchema.parse(pointer)
  const pointerBytes = canonicalJsonStringify(pointer)

  // 4. Write the pointer. Dry run → candidate file; real → atomic swap.
  const pointerName = opts.dryRun ? 'current.candidate.json' : 'current.json'
  const pointerPath = join(envDir, pointerName)
  if (opts.dryRun) {
    writeFileSync(pointerPath, pointerBytes)
  } else {
    writeFileAtomic(pointerPath, envDir, `current.json.tmp.${version}`, pointerBytes)
  }

  return {
    bundleId: compiled.bundleId,
    version,
    manifestSha256,
    bundleDir,
    pointerPath,
    dryRun: opts.dryRun === true,
  }
}
