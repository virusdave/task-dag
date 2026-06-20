// Publish the branding opaque manifest to the artifact root: an immutable
// content-addressed manifest file + an atomically-swapped, signed
// `current.json` pointer. Same machinery and safety properties as the
// lp-bundle publisher (`../lp/publish.ts`) — reused ed25519 signing,
// canonical-JSON, sha256, and the temp→fsync→rename→fsync-dir atomic write —
// but a SEPARATE artifact subtree, schema, version namespace, and id format
// so the two artifact kinds never collide (oracle review, 2026-06-16).
//
// Layout under <artifactRoot>:
//   branding-opaque/manifests/<manifest_id>/manifest.json   (immutable)
//   branding-opaque/<env>/current.json                      (mutable pointer)
//
// Signing keys are provided by the caller (env/operator file); this module
// never reads them from the artifact root.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'

import { canonicalJsonStringify } from '../lp/canonicalJson.js'
import { sha256Hex } from '../lp/hash.js'
import { resolveArtifactPath } from '../lp/paths.js'
import type { LpEnvironment } from '../lp/publish.js'
import { writeFileAtomic } from '../lp/publish.js'
import type { BrandingOpaqueRegistry } from '../lp/registryCheck.js'
import { signPayload, verifyPayload } from '../lp/signing.js'
import {
  BRANDING_MANIFEST_ID_RE,
  BRANDING_OPAQUE_MANIFEST_SCHEMA,
  BRANDING_OPAQUE_POINTER_SCHEMA,
  BrandingOpaqueManifestSchema,
  BrandingOpaquePointerSchema,
  checkBrandingManifestConsistency,
  type BrandingManifestBuildResult,
  type BrandingOpaqueManifest,
  type BrandingOpaqueManifestEntry,
} from './manifest.js'

const MANIFESTS_SUBDIR = 'branding-opaque/manifests'

function pad(n: number, width: number): string {
  return String(n).padStart(width, '0')
}

/** Mint a sortable `bom_YYYY-MM-DD_HHMMSS_<6 hex>` id (UTC). */
export function newBrandingManifestId(now: Date = new Date()): string {
  const id =
    `bom_${pad(now.getUTCFullYear(), 4)}-${pad(now.getUTCMonth() + 1, 2)}-${pad(now.getUTCDate(), 2)}` +
    `_${pad(now.getUTCHours(), 2)}${pad(now.getUTCMinutes(), 2)}${pad(now.getUTCSeconds(), 2)}` +
    `_${randomBytes(3).toString('hex')}`
  /* istanbul ignore next — defensive; the format above always matches */
  if (!BRANDING_MANIFEST_ID_RE.test(id)) {
    throw new Error(`newBrandingManifestId produced an invalid id: ${id}`)
  }
  return id
}

/** Canonical relative URL of a manifest within the artifact root. */
export function brandingManifestUrlFor(manifestId: string): string {
  return `${MANIFESTS_SUBDIR}/${manifestId}/manifest.json`
}

/** Signing payload for the manifest = the manifest with `signature` removed. */
export function brandingManifestSigningPayload(manifest: Omit<BrandingOpaqueManifest, 'signature'>): string {
  return canonicalJsonStringify(manifest)
}

function pointerSigningPayload(input: {
  manifestId: string
  manifestSha256: string
  version: number
  secretSource: BrandingOpaqueManifest['secret_source']
  entryCount: number
}): string {
  return canonicalJsonStringify({
    manifest_id: input.manifestId,
    manifest_sha256: input.manifestSha256,
    version: input.version,
    secret_source: input.secretSource,
    entry_count: input.entryCount,
  })
}

/** Read the monotonic version of a pointer file; 0 if absent/unparseable. */
export function readBrandingPointerVersion(pointerPath: string): number {
  try {
    const parsed = BrandingOpaquePointerSchema.safeParse(JSON.parse(readFileSync(pointerPath, 'utf8')))
    return parsed.success ? parsed.data.version : 0
  } catch {
    return 0
  }
}

export interface AssembledBrandingManifest {
  readonly manifest: BrandingOpaqueManifest
  readonly manifestBytes: string
  readonly manifestSha256: string
}

export interface AssembleBrandingManifestOptions {
  readonly buildResult: BrandingManifestBuildResult
  readonly manifestId: string
  readonly automationGitSha: string
  readonly privateKeyPem: string
}

/** Assemble + sign the manifest object and its canonical bytes. */
export function assembleSignedBrandingManifest(opts: AssembleBrandingManifestOptions): AssembledBrandingManifest {
  const manifestSansSig: Omit<BrandingOpaqueManifest, 'signature'> = {
    schema: BRANDING_OPAQUE_MANIFEST_SCHEMA,
    manifest_id: opts.manifestId,
    scheme: opts.buildResult.scheme,
    secret_source: opts.buildResult.secretSource,
    automation_git_sha: opts.automationGitSha,
    entries: [...opts.buildResult.entries],
  }
  const signature = signPayload(brandingManifestSigningPayload(manifestSansSig), opts.privateKeyPem)
  const manifest: BrandingOpaqueManifest = { ...manifestSansSig, signature }
  // Self-validate the manifest shape before anyone writes it.
  BrandingOpaqueManifestSchema.parse(manifest)
  const manifestBytes = canonicalJsonStringify(manifest)
  return { manifest, manifestBytes, manifestSha256: sha256Hex(manifestBytes) }
}

export interface PublishBrandingManifestOptions {
  readonly buildResult: BrandingManifestBuildResult
  readonly privateKeyPem: string
  readonly artifactRoot: string
  readonly environment: LpEnvironment
  readonly automationGitSha: string
  readonly previousManifestId?: string
  /** Override the monotonic version (else existing pointer version + 1). */
  readonly version?: number
  readonly manifestId?: string
  readonly now?: Date
}

export interface PublishBrandingManifestResult {
  readonly manifestId: string
  readonly version: number
  readonly manifestSha256: string
  readonly manifestDir: string
  readonly pointerPath: string
  readonly entryCount: number
}

export function publishBrandingOpaqueManifest(
  opts: PublishBrandingManifestOptions,
): PublishBrandingManifestResult {
  const now = opts.now ?? new Date()
  const manifestId = opts.manifestId ?? newBrandingManifestId(now)

  const assembled = assembleSignedBrandingManifest({
    buildResult: opts.buildResult,
    manifestId,
    automationGitSha: opts.automationGitSha,
    privateKeyPem: opts.privateKeyPem,
  })

  // 1. Write the immutable manifest file.
  const manifestDir = join(opts.artifactRoot, MANIFESTS_SUBDIR, manifestId)
  mkdirSync(manifestDir, { recursive: true })
  writeFileSync(join(manifestDir, 'manifest.json'), assembled.manifestBytes)

  // 2. Build the signed, monotonic pointer.
  const envDir = join(opts.artifactRoot, 'branding-opaque', opts.environment)
  mkdirSync(envDir, { recursive: true })
  const pointerPath = join(envDir, 'current.json')
  const version = opts.version ?? readBrandingPointerVersion(pointerPath) + 1
  const entryCount = assembled.manifest.entries.length

  const signature = signPayload(
    pointerSigningPayload({
      manifestId,
      manifestSha256: assembled.manifestSha256,
      version,
      secretSource: assembled.manifest.secret_source,
      entryCount,
    }),
    opts.privateKeyPem,
  )
  const pointer = {
    schema: BRANDING_OPAQUE_POINTER_SCHEMA as typeof BRANDING_OPAQUE_POINTER_SCHEMA,
    environment: opts.environment,
    manifest_id: manifestId,
    manifest_url: brandingManifestUrlFor(manifestId),
    manifest_sha256: assembled.manifestSha256,
    version,
    secret_source: assembled.manifest.secret_source,
    entry_count: entryCount,
    published_at: now.toISOString(),
    ...(opts.previousManifestId ? { previous_manifest_id: opts.previousManifestId } : {}),
    signature,
  }
  BrandingOpaquePointerSchema.parse(pointer)
  const pointerBytes = canonicalJsonStringify(pointer)

  // 3. Atomic pointer swap (temp → fsync → rename → fsync dir).
  writeFileAtomic(pointerPath, envDir, `current.json.tmp.${version}`, pointerBytes)

  return {
    manifestId,
    version,
    manifestSha256: assembled.manifestSha256,
    manifestDir,
    pointerPath,
    entryCount,
  }
}

export interface ValidateBrandingManifestOptions {
  readonly artifactRoot: string
  readonly environment?: string
  readonly pointerPath?: string
  readonly publicKeyPem: string
}

export interface ValidateBrandingManifestResult {
  readonly ok: boolean
  readonly errors: string[]
  readonly manifestId?: string
  readonly version?: number
  readonly entryCount?: number
}

export interface ReadValidatedBrandingManifestResult {
  readonly ok: boolean
  readonly errors: string[]
  readonly manifestId?: string
  readonly version?: number
  readonly entryCount?: number
  /** The parsed manifest — present whenever the manifest itself parsed. */
  readonly manifest?: BrandingOpaqueManifest
}

/**
 * Read a pointer + its manifest and verify everything fail-closed: pointer
 * schema + signature, manifest schema + signature, manifest sha256 matches
 * the pointer, pointer/manifest ids agree, entry count agrees, and the
 * entry-consistency guards hold. Does NOT need the opaque-ref secret. Returns
 * the parsed manifest so callers (e.g. the LP bundle parity check) can build a
 * registry from its entries only AFTER it validated.
 */
export function readValidatedBrandingOpaqueManifest(
  opts: ValidateBrandingManifestOptions,
): ReadValidatedBrandingManifestResult {
  const errors: string[] = []
  const pointerPath =
    opts.pointerPath ??
    (opts.environment
      ? join(opts.artifactRoot, 'branding-opaque', opts.environment, 'current.json')
      : undefined)
  if (pointerPath === undefined) {
    return { ok: false, errors: ['validate: provide either --pointer or --env'] }
  }

  let pointerRaw: string
  try {
    pointerRaw = readFileSync(pointerPath, 'utf8')
  } catch {
    return { ok: false, errors: [`cannot read pointer ${pointerPath}`] }
  }
  const pointerParsed = BrandingOpaquePointerSchema.safeParse(JSON.parse(pointerRaw))
  if (!pointerParsed.success) {
    return { ok: false, errors: [`pointer schema invalid: ${pointerParsed.error.message}`] }
  }
  const pointer = pointerParsed.data

  const pointerSigOk = verifyPayload(
    pointerSigningPayload({
      manifestId: pointer.manifest_id,
      manifestSha256: pointer.manifest_sha256,
      version: pointer.version,
      secretSource: pointer.secret_source,
      entryCount: pointer.entry_count,
    }),
    pointer.signature,
    opts.publicKeyPem,
  )
  if (!pointerSigOk) errors.push('pointer signature does not verify')

  const manifestFull = resolveArtifactPath(opts.artifactRoot, pointer.manifest_url)
  if (manifestFull === null) {
    errors.push(`unsafe or unresolvable manifest_url: ${pointer.manifest_url}`)
    return { ok: false, errors, manifestId: pointer.manifest_id, version: pointer.version }
  }

  let manifestRaw: string
  try {
    manifestRaw = readFileSync(manifestFull, 'utf8')
  } catch {
    errors.push(`cannot read manifest ${pointer.manifest_url}`)
    return { ok: false, errors, manifestId: pointer.manifest_id, version: pointer.version }
  }
  if (sha256Hex(manifestRaw) !== pointer.manifest_sha256) {
    errors.push('manifest sha256 does not match the pointer')
  }
  const manifestParsed = BrandingOpaqueManifestSchema.safeParse(JSON.parse(manifestRaw))
  if (!manifestParsed.success) {
    errors.push(`manifest schema invalid: ${manifestParsed.error.message}`)
    return { ok: false, errors, manifestId: pointer.manifest_id, version: pointer.version }
  }
  const manifest = manifestParsed.data

  const { signature, ...manifestSansSig } = manifest
  if (!verifyPayload(brandingManifestSigningPayload(manifestSansSig), signature, opts.publicKeyPem)) {
    errors.push('manifest signature does not verify')
  }
  if (manifest.manifest_id !== pointer.manifest_id) {
    errors.push(`manifest_id mismatch: manifest ${manifest.manifest_id} vs pointer ${pointer.manifest_id}`)
  }
  if (manifest.entries.length !== pointer.entry_count) {
    errors.push(`entry_count mismatch: manifest ${String(manifest.entries.length)} vs pointer ${String(pointer.entry_count)}`)
  }
  if (manifest.secret_source !== pointer.secret_source) {
    errors.push(`secret_source mismatch: manifest ${manifest.secret_source} vs pointer ${pointer.secret_source}`)
  }
  errors.push(...checkBrandingManifestConsistency(manifest.entries))

  return {
    ok: errors.length === 0,
    errors,
    manifestId: pointer.manifest_id,
    version: pointer.version,
    entryCount: pointer.entry_count,
    manifest,
  }
}

/**
 * Backwards-compatible thin wrapper: validate a published branding manifest
 * and return only the pass/fail summary (no parsed manifest). Used by the
 * `branding-opaque-manifest validate` CLI.
 */
export function validateBrandingOpaqueManifest(
  opts: ValidateBrandingManifestOptions,
): ValidateBrandingManifestResult {
  const { manifest: _manifest, ...summary } = readValidatedBrandingOpaqueManifest(opts)
  return summary
}

/**
 * Build the LP-bundle parity registry (site -> set of opaque refs) from
 * validated manifest entries. Pure; the caller is responsible for having
 * validated the manifest first (use `loadBrandingOpaqueRegistry`).
 */
export function buildBrandingOpaqueRegistry(
  entries: readonly BrandingOpaqueManifestEntry[],
): BrandingOpaqueRegistry {
  const bySite = new Map<string, Set<string>>()
  for (const e of entries) {
    let set = bySite.get(e.site_key)
    if (set === undefined) {
      set = new Set<string>()
      bySite.set(e.site_key, set)
    }
    set.add(e.opaque_ref)
  }
  return { bySite }
}

export interface LoadBrandingRegistryResult {
  readonly ok: boolean
  readonly errors: string[]
  /** Present only when the manifest validated fail-closed. */
  readonly registry?: BrandingOpaqueRegistry
  readonly manifestId?: string
  readonly version?: number
  readonly entryCount?: number
}

/**
 * Read + fail-closed validate the published branding manifest, then build the
 * LP-bundle parity registry from its entries. Never trusts an unsigned/corrupt
 * manifest: if validation fails, `registry` is undefined and `errors` explains
 * why (so the LP publish path can refuse to emit branding refs it can't prove
 * mss will serve).
 */
export function loadBrandingOpaqueRegistry(
  opts: ValidateBrandingManifestOptions,
): LoadBrandingRegistryResult {
  const read = readValidatedBrandingOpaqueManifest(opts)
  if (!read.ok || read.manifest === undefined) {
    return {
      ok: false,
      errors: read.errors,
      manifestId: read.manifestId,
      version: read.version,
      entryCount: read.entryCount,
    }
  }
  return {
    ok: true,
    errors: [],
    registry: buildBrandingOpaqueRegistry(read.manifest.entries),
    manifestId: read.manifestId,
    version: read.version,
    entryCount: read.entryCount,
  }
}
