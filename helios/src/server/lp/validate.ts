// Fail-closed validation of a published bundle (parent EPIC_PLAN §5
// step 2-3, §11). This is the core of `helios lp-bundle validate` and is
// the exact contract the mss loader re-implements before activating a
// bundle: schema + sha256 + ed25519 signature + min_renderer_version +
// path safety + cross-artifact consistency. ANY failure ⇒ ok:false.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import type { z } from 'zod'

import { canonicalJsonStringify } from './canonicalJson.js'
import {
  AssetsSchema,
  BundleSchema,
  CurrentPointerSchema,
  ManifestSchema,
  PolicySchema,
  type Assets,
  type Bundle,
  type CurrentPointer,
  type Manifest,
  type Policy,
} from './contracts.js'
import { sha256Hex } from './hash.js'
import { resolveArtifactPath } from './paths.js'
import { checkBundleConsistency } from './registryCheck.js'
import { satisfiesRendererConstraint } from './rendererVersion.js'
import { manifestSigningPayload } from './publish.js'
import { verifyPayload } from './signing.js'

export interface ValidateOptions {
  readonly artifactRoot: string
  readonly environment?: string
  /** Explicit pointer file path (overrides `environment`). */
  readonly pointerPath?: string
  readonly publicKeyPem: string
  readonly runningRendererVersion: string
  /** If set, reject a pointer whose version is <= the active version. */
  readonly activeVersion?: number
}

export interface ValidationResult {
  readonly ok: boolean
  readonly bundleId?: string
  readonly version?: number
  readonly errors: string[]
}

function readJson(path: string): { bytes: string; json: unknown } {
  const bytes = readFileSync(path, 'utf8')
  return { bytes, json: JSON.parse(bytes) }
}

export function validateBundle(opts: ValidateOptions): ValidationResult {
  const errors: string[] = []
  const fail = (msg: string): ValidationResult => ({ ok: false, errors: [...errors, msg] })

  const pointerPath =
    opts.pointerPath ?? join(opts.artifactRoot, opts.environment ?? 'prod', 'current.json')

  // 1. Pointer: read + schema.
  let pointer: CurrentPointer
  try {
    const { json } = readJson(pointerPath)
    const parsed = CurrentPointerSchema.safeParse(json)
    if (!parsed.success) return fail(`pointer schema invalid: ${zodMsg(parsed.error)}`)
    pointer = parsed.data
  } catch (e) {
    return fail(`pointer unreadable (${pointerPath}): ${errMsg(e)}`)
  }

  // 2. Monotonic version gate.
  if (opts.activeVersion !== undefined && pointer.version <= opts.activeVersion) {
    errors.push(`pointer version ${pointer.version} <= active ${opts.activeVersion} (stale)`)
  }

  // 3. Manifest path safety + read + sha256 + schema.
  const manifestPath = resolveArtifactPath(opts.artifactRoot, pointer.manifest_url)
  if (!manifestPath) return fail(`unsafe manifest_url: ${pointer.manifest_url}`)
  let manifest: Manifest
  let manifestBytes: string
  try {
    const r = readJson(manifestPath)
    manifestBytes = r.bytes
    const parsed = ManifestSchema.safeParse(r.json)
    if (!parsed.success) return fail(`manifest schema invalid: ${zodMsg(parsed.error)}`)
    manifest = parsed.data
  } catch (e) {
    return fail(`manifest unreadable: ${errMsg(e)}`)
  }

  const manifestSha = sha256Hex(manifestBytes)
  if (manifestSha !== pointer.manifest_sha256) {
    errors.push(`manifest_sha256 mismatch: pointer=${pointer.manifest_sha256} actual=${manifestSha}`)
  }

  // 4. Signatures.
  const { signature: manifestSig, ...manifestSansSig } = manifest
  if (!verifyPayload(manifestSigningPayload(manifestSansSig), manifestSig, opts.publicKeyPem)) {
    errors.push('manifest signature invalid')
  }
  const pointerPayload = canonicalJsonStringify({
    manifest_sha256: pointer.manifest_sha256,
    version: pointer.version,
    disabled_variants: pointer.disabled_variants ?? [],
  })
  if (!verifyPayload(pointerPayload, pointer.signature, opts.publicKeyPem)) {
    errors.push('pointer signature invalid')
  }

  // 5. bundle_id agreement + renderer version.
  if (pointer.bundle_id !== manifest.bundle_id) {
    errors.push(`bundle_id mismatch: pointer=${pointer.bundle_id} manifest=${manifest.bundle_id}`)
  }
  if (!satisfiesRendererConstraint(manifest.min_renderer_version, opts.runningRendererVersion)) {
    errors.push(
      `running renderer ${opts.runningRendererVersion} does not satisfy ${manifest.min_renderer_version}`,
    )
  }

  // 6. Content files: path safety + sha256 + schema.
  const bundleDir = dirname(manifestPath)
  const bundle = readContent(bundleDir, manifest.files.bundle, BundleSchema, 'bundle', errors)
  const policy = readContent(bundleDir, manifest.files.policy, PolicySchema, 'policy', errors)
  const assets = readContent(bundleDir, manifest.files.assets, AssetsSchema, 'assets', errors)

  // 7. Cross-artifact consistency (registry / NUM guardrails).
  if (bundle && policy && assets) {
    if (bundle.bundle_id !== manifest.bundle_id) {
      errors.push(`bundle.json bundle_id ${bundle.bundle_id} != manifest ${manifest.bundle_id}`)
    }
    errors.push(...checkBundleConsistency(bundle, policy, assets, pointer.disabled_variants ?? []))
  }

  return {
    ok: errors.length === 0,
    bundleId: pointer.bundle_id,
    version: pointer.version,
    errors,
  }
}

function readContent<T>(
  bundleDir: string,
  ref: { url: string; sha256: string },
  schema: z.ZodType<T>,
  label: string,
  errors: string[],
): T | null {
  const path = resolveArtifactPath(bundleDir, ref.url)
  if (!path) {
    errors.push(`unsafe ${label} url: ${ref.url}`)
    return null
  }
  let bytes: string
  let json: unknown
  try {
    const r = readJson(path)
    bytes = r.bytes
    json = r.json
  } catch (e) {
    errors.push(`${label} unreadable: ${errMsg(e)}`)
    return null
  }
  const actual = sha256Hex(bytes)
  if (actual !== ref.sha256) {
    errors.push(`${label} sha256 mismatch: manifest=${ref.sha256} actual=${actual}`)
  }
  const parsed = schema.safeParse(json)
  if (!parsed.success) {
    errors.push(`${label} schema invalid: ${zodMsg(parsed.error)}`)
    return null
  }
  return parsed.data
}

function zodMsg(error: z.ZodError): string {
  return error.issues.map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`).join('; ')
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

// Re-export the content types for callers that want them.
export type { Bundle, Policy, Assets }
