// Fail-closed validation of a published SEO bundle (parent EPIC_PLAN §5).
// This is the core of `seo-bundle validate` and is the exact contract the
// mss loader re-implements before activating a bundle: schema + sha256 +
// ed25519 signature + min_renderer_version + path safety + cross-artifact
// consistency. ANY failure ⇒ ok:false (never render unvalidated content).
//
// Reuses the #13 (`../lp/`) crypto/path/version primitives verbatim.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import type { z } from 'zod'

import { canonicalJsonStringify } from '../lp/canonicalJson.js'
import { sha256Hex } from '../lp/hash.js'
import { resolveArtifactPath } from '../lp/paths.js'
import { satisfiesRendererConstraint } from '../lp/rendererVersion.js'
import { verifyPayload } from '../lp/signing.js'
import {
  AssetsSchema,
  ContentSchema,
  CurrentPointerSchema,
  ManifestSchema,
  PolicySchema,
  SitemapsSchema,
  WidgetsSchema,
  type Assets,
  type Content,
  type CurrentPointer,
  type Manifest,
  type Policy,
  type Sitemaps,
  type Widgets,
} from './contracts.js'
import { checkSeoConsistency } from './consistency.js'
import { seoManifestSigningPayload } from './publish.js'

export interface SeoValidateOptions {
  readonly artifactRoot: string
  readonly environment?: string
  /** Explicit pointer file path (overrides `environment`). */
  readonly pointerPath?: string
  readonly publicKeyPem: string
  readonly runningRendererVersion: string
  /** If set, reject a pointer whose version is <= the active version. */
  readonly activeVersion?: number
}

export interface SeoValidationResult {
  readonly ok: boolean
  readonly seoBundleId?: string
  readonly version?: number
  readonly errors: string[]
}

function readJson(path: string): { bytes: string; json: unknown } {
  const bytes = readFileSync(path, 'utf8')
  return { bytes, json: JSON.parse(bytes) }
}

export function validateSeoBundle(opts: SeoValidateOptions): SeoValidationResult {
  const errors: string[] = []
  const fail = (msg: string): SeoValidationResult => ({ ok: false, errors: [...errors, msg] })

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
  if (!verifyPayload(seoManifestSigningPayload(manifestSansSig), manifestSig, opts.publicKeyPem)) {
    errors.push('manifest signature invalid')
  }
  const pointerPayload = canonicalJsonStringify({
    manifest_sha256: pointer.manifest_sha256,
    version: pointer.version,
    disabled_content: pointer.disabled_content ?? [],
  })
  if (!verifyPayload(pointerPayload, pointer.signature, opts.publicKeyPem)) {
    errors.push('pointer signature invalid')
  }

  // 5. seo_bundle_id agreement + renderer version.
  if (pointer.seo_bundle_id !== manifest.seo_bundle_id) {
    errors.push(`seo_bundle_id mismatch: pointer=${pointer.seo_bundle_id} manifest=${manifest.seo_bundle_id}`)
  }
  if (!satisfiesRendererConstraint(manifest.min_renderer_version, opts.runningRendererVersion)) {
    errors.push(
      `running renderer ${opts.runningRendererVersion} does not satisfy ${manifest.min_renderer_version}`,
    )
  }

  // 6. Content files: path safety + sha256 + schema.
  const bundleDir = dirname(manifestPath)
  const widgets = readContent(bundleDir, manifest.files.widgets, WidgetsSchema, 'widgets', errors)
  const content = readContent(bundleDir, manifest.files.content, ContentSchema, 'content', errors)
  const policy = readContent(bundleDir, manifest.files.policy, PolicySchema, 'policy', errors)
  const assets = readContent(bundleDir, manifest.files.assets, AssetsSchema, 'assets', errors)
  const sitemaps = readContent(bundleDir, manifest.files.sitemaps, SitemapsSchema, 'sitemaps', errors)

  // 7. Per-file seo_bundle_id agreement.
  for (const [label, file] of [
    ['widgets', widgets],
    ['content', content],
    ['assets', assets],
    ['sitemaps', sitemaps],
  ] as const) {
    if (file && file.seo_bundle_id !== manifest.seo_bundle_id) {
      errors.push(`${label}.json seo_bundle_id ${file.seo_bundle_id} != manifest ${manifest.seo_bundle_id}`)
    }
  }

  // 8. Cross-artifact consistency (scope / refs / approved-assets / routes).
  if (widgets && content && policy && assets && sitemaps) {
    errors.push(
      ...checkSeoConsistency({
        sites: manifest.sites,
        widgets,
        content,
        policy,
        assets,
        sitemaps,
        disabledContent: pointer.disabled_content ?? [],
      }),
    )
  }

  return {
    ok: errors.length === 0,
    seoBundleId: pointer.seo_bundle_id,
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

export type { Widgets, Content, Policy, Assets, Sitemaps }
