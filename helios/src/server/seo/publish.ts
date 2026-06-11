// Publish a compiled SEO bundle to the artifact root: content-addressed
// immutable files (widgets/content/policy/assets/sitemaps.json) + a
// signed manifest + an atomically-swapped, signed `current.json` pointer
// (parent EPIC_PLAN §5).
//
// This REUSES the unified-landing-engine (#13) crypto/encoding/atomic-IO
// primitives verbatim (`../lp/`): deterministic canonical JSON, sha256,
// ed25519 signing, safe path resolution, and the temp→fsync→rename→
// fsync-dir atomic pointer write. The SEO bundle is a SEPARATE, signed,
// independently-versioned bundle — same machinery, different contract.
//
// - Bundle files are immutable; only current.json is mutable and is
//   written atomically so a reader never sees a torn pointer.
// - `version` is monotonic: a publish reads the existing pointer and
//   increments. Rollback is a NEW higher version pointing at a previous
//   bundle (never a rewrite).
// - Signing keys are provided by the caller (env/operator file); this
//   module never reads them from the artifact root.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { canonicalJsonStringify } from '../lp/canonicalJson.js'
import { sha256Hex } from '../lp/hash.js'
import { writeFileAtomic } from '../lp/publish.js'
import { signPayload } from '../lp/signing.js'
import {
  CurrentPointerSchema,
  type DisabledContent,
  type Manifest,
  type SeoEnvironment,
  type SeoSite,
} from './contracts.js'
import type { CompiledSeoBundle } from './compile.js'

export interface SeoPublishOptions {
  readonly compiled: CompiledSeoBundle
  readonly privateKeyPem: string
  readonly artifactRoot: string
  readonly environment: SeoEnvironment
  readonly minRendererVersion: string
  readonly automationGitSha: string
  readonly generatedFrom: Manifest['generated_from']
  readonly previousBundleId?: string
  readonly disabledContent?: readonly DisabledContent[]
  /** Override the monotonic version (else existing pointer version + 1). */
  readonly version?: number
  /**
   * Candidate/dry-run publish: write the immutable bundle artifacts + a
   * *candidate* pointer, never touching the live `current.json`. This is
   * the P1 dry-run path (publish to a non-prod path, nothing consumes it).
   */
  readonly candidateOnly?: boolean
  /** Override the candidate pointer filename within the env dir. */
  readonly candidatePointerName?: string
  /** Back-compat alias for {@link candidateOnly}. */
  readonly dryRun?: boolean
  readonly now?: Date
}

export interface SeoPublishResult {
  readonly seoBundleId: string
  readonly version: number
  readonly manifestSha256: string
  readonly bundleDir: string
  readonly pointerPath: string
  /** True when this was a candidate/dry-run publish (live pointer untouched). */
  readonly candidate: boolean
}

function pointerSigningPayload(
  manifestSha256: string,
  version: number,
  disabledContent: readonly DisabledContent[],
): string {
  return canonicalJsonStringify({
    manifest_sha256: manifestSha256,
    version,
    disabled_content: disabledContent,
  })
}

/** Signing payload for the manifest = the manifest with `signature` removed. */
export function seoManifestSigningPayload(manifest: Omit<Manifest, 'signature'>): string {
  return canonicalJsonStringify(manifest)
}

/** Signing payload for the pointer — single source of truth (publish + validate). */
export function seoPointerSigningPayload(
  manifestSha256: string,
  version: number,
  disabledContent: readonly DisabledContent[],
): string {
  return pointerSigningPayload(manifestSha256, version, disabledContent)
}

/** Read the monotonic version of a pointer file; 0 if absent/unparseable. */
export function readSeoPointerVersion(pointerPath: string): number {
  try {
    const raw = readFileSync(pointerPath, 'utf8')
    const parsed = CurrentPointerSchema.safeParse(JSON.parse(raw))
    return parsed.success ? parsed.data.version : 0
  } catch {
    return 0
  }
}

/** Canonical relative URL of a bundle's manifest within the artifact root. */
export function seoManifestUrlFor(seoBundleId: string): string {
  return `bundles/${seoBundleId}/manifest.json`
}

export interface SeoSignedPointerInput {
  readonly environment: SeoEnvironment
  readonly seoBundleId: string
  readonly manifestUrl: string
  readonly manifestSha256: string
  readonly version: number
  readonly previousBundleId?: string
  readonly disabledContent: readonly DisabledContent[]
  readonly publishedAt: string
  readonly privateKeyPem: string
}

/** Build the canonical, signed `current.json` pointer bytes. */
export function buildSeoSignedPointerBytes(input: SeoSignedPointerInput): string {
  const signature = signPayload(
    pointerSigningPayload(input.manifestSha256, input.version, input.disabledContent),
    input.privateKeyPem,
  )
  const pointer = {
    schema: 'freshlybaked.seo.current.v1' as const,
    environment: input.environment,
    seo_bundle_id: input.seoBundleId,
    manifest_url: input.manifestUrl,
    manifest_sha256: input.manifestSha256,
    version: input.version,
    published_at: input.publishedAt,
    ...(input.previousBundleId ? { previous_bundle_id: input.previousBundleId } : {}),
    signature,
    ...(input.disabledContent.length > 0 ? { disabled_content: input.disabledContent } : {}),
  }
  // Self-validate the pointer before anyone writes it.
  CurrentPointerSchema.parse(pointer)
  return canonicalJsonStringify(pointer)
}

export function publishSeoBundle(opts: SeoPublishOptions): SeoPublishResult {
  const { compiled, artifactRoot, environment } = opts
  const now = opts.now ?? new Date()
  const disabledContent = opts.disabledContent ?? []

  const bundleDir = join(artifactRoot, 'bundles', compiled.seoBundleId)
  mkdirSync(bundleDir, { recursive: true })

  // 1. Write immutable content files (canonical bytes) and hash them.
  const widgetsBytes = canonicalJsonStringify(compiled.widgets)
  const contentBytes = canonicalJsonStringify(compiled.content)
  const policyBytes = canonicalJsonStringify(compiled.policy)
  const assetsBytes = canonicalJsonStringify(compiled.assets)
  const sitemapsBytes = canonicalJsonStringify(compiled.sitemaps)
  writeFileSync(join(bundleDir, 'widgets.json'), widgetsBytes)
  writeFileSync(join(bundleDir, 'content.json'), contentBytes)
  writeFileSync(join(bundleDir, 'policy.json'), policyBytes)
  writeFileSync(join(bundleDir, 'assets.json'), assetsBytes)
  writeFileSync(join(bundleDir, 'sitemaps.json'), sitemapsBytes)

  // 2. Build + sign the manifest, then write it and hash its bytes.
  const manifestSansSig: Omit<Manifest, 'signature'> = {
    schema: 'freshlybaked.seo.bundle-manifest.v1',
    seo_bundle_id: compiled.seoBundleId,
    min_renderer_version: opts.minRendererVersion,
    automation_git_sha: opts.automationGitSha,
    generated_from: opts.generatedFrom,
    sites: compiled.sites as Record<string, SeoSite>,
    files: {
      widgets: { url: 'widgets.json', sha256: sha256Hex(widgetsBytes) },
      content: { url: 'content.json', sha256: sha256Hex(contentBytes) },
      policy: { url: 'policy.json', sha256: sha256Hex(policyBytes) },
      assets: { url: 'assets.json', sha256: sha256Hex(assetsBytes) },
      sitemaps: { url: 'sitemaps.json', sha256: sha256Hex(sitemapsBytes) },
    },
  }
  const manifestSignature = signPayload(seoManifestSigningPayload(manifestSansSig), opts.privateKeyPem)
  const manifest: Manifest = { ...manifestSansSig, signature: manifestSignature }
  const manifestBytes = canonicalJsonStringify(manifest)
  writeFileSync(join(bundleDir, 'manifest.json'), manifestBytes)
  const manifestSha256 = sha256Hex(manifestBytes)

  // 3. Build the signed pointer.
  const envDir = join(artifactRoot, environment)
  mkdirSync(envDir, { recursive: true })
  const version = opts.version ?? readSeoPointerVersion(join(envDir, 'current.json')) + 1
  const pointerBytes = buildSeoSignedPointerBytes({
    environment,
    seoBundleId: compiled.seoBundleId,
    manifestUrl: seoManifestUrlFor(compiled.seoBundleId),
    manifestSha256,
    version,
    previousBundleId: opts.previousBundleId,
    disabledContent,
    publishedAt: now.toISOString(),
    privateKeyPem: opts.privateKeyPem,
  })

  // 4. Write the pointer atomically. Candidate/dry-run publishes write a
  //    candidate file and never touch the live `current.json`.
  const candidate = opts.candidateOnly === true || opts.dryRun === true
  const pointerName = candidate
    ? opts.candidatePointerName ?? 'current.candidate.json'
    : 'current.json'
  const pointerPath = join(envDir, pointerName)
  writeFileAtomic(pointerPath, envDir, `${pointerName}.tmp.${version}`, pointerBytes)

  return {
    seoBundleId: compiled.seoBundleId,
    version,
    manifestSha256,
    bundleDir,
    pointerPath,
    candidate,
  }
}
