// Derive the currently-PUBLISHED FAQ content fingerprints from the live
// SEO bundle (child FreshlyBakedNYC/automation#46, P1, task cfa2dc0).
//
// The hybrid-sync planner needs, per source-keyed FAQ set, the
// `content_sha256` that is live in the published bundle, so path (a)
// (approval → publish) can decide whether an approved set still needs a
// publish or is already live. Rather than persist a "published fingerprint"
// table (which could drift from what is actually served), we DERIVE the
// published state from the live bundle itself: validate the live pointer
// fail-closed, then recompute each published FAQ set's fingerprint from its
// validated content. The live bundle is the single source of truth.
//
// Pure/IO split: faqContentShaMapFromContent is the unit-testable pure core;
// readPublishedFaqContentShas adds the validate + file-read edge.
//
// Satisfies: virusdave/top-level#17 · Phase: P1

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { resolveArtifactPath } from '../lp/paths.js'
import {
  ContentSchema,
  CurrentPointerSchema,
  ManifestSchema,
  type Content,
} from './contracts.js'
import { faqSetContentSha256 } from './faqContent.js'
import { validateSeoBundle } from './validate.js'

/**
 * Map every published FAQ set's `faq_set_id` to a freshly-recomputed
 * `content_sha256` over its published content. Pure.
 */
export function faqContentShaMapFromContent(content: Content): Map<string, string> {
  const map = new Map<string, string>()
  for (const faqSet of content.faq_sets) {
    const sha = faqSetContentSha256({
      faq_set_id: faqSet.faq_set_id,
      scope: faqSet.scope,
      items: faqSet.items.map((item) => ({
        question: item.question,
        answer_raw: item.answer_raw,
        answer_sanitized: item.answer_sanitized,
      })),
    })
    map.set(faqSet.faq_set_id, sha)
  }
  return map
}

export type PublishedFaqContentState =
  | {
      /** No live pointer exists yet — nothing has ever been published. */
      readonly status: 'absent'
      readonly shaByFaqSetId: Map<string, string>
      readonly seoBundleId: null
      readonly version: null
    }
  | {
      /**
       * A live pointer exists but FAILS validation. The caller MUST NOT
       * treat this as "nothing published" (that would cause republish
       * churn); it should surface/alert and not publish over a bundle it
       * cannot validate.
       */
      readonly status: 'invalid'
      readonly errors: string[]
      readonly shaByFaqSetId: Map<string, string>
      readonly seoBundleId: null
      readonly version: null
    }
  | {
      readonly status: 'ok'
      readonly shaByFaqSetId: Map<string, string>
      readonly seoBundleId: string
      readonly version: number
    }

export interface ReadPublishedFaqContentShasOptions {
  readonly artifactRoot: string
  readonly environment: string
  readonly publicKeyPem: string
  /** Renderer version used for validation; default a high version (we only care about integrity). */
  readonly runningRendererVersion?: string
}

/**
 * Read + validate the live SEO bundle and return the published FAQ
 * fingerprints. Fail-closed: a present-but-invalid bundle returns
 * `status:'invalid'` (never silently empty), and an absent pointer returns
 * `status:'absent'`.
 */
export function readPublishedFaqContentShas(
  opts: ReadPublishedFaqContentShasOptions,
): PublishedFaqContentState {
  const empty = new Map<string, string>()
  const pointerPath = join(opts.artifactRoot, opts.environment, 'current.json')

  let pointerRaw: string
  try {
    pointerRaw = readFileSync(pointerPath, 'utf8')
  } catch (e) {
    // Only a genuinely missing pointer is "absent" (nothing ever published).
    // Any other read error (EACCES, EISDIR, transient IO) is fail-closed
    // `invalid` — never silently treated as "nothing published", which could
    // let the executor publish over a live pointer it never validated.
    const code = typeof e === 'object' && e !== null && 'code' in e ? String(e.code) : ''
    if (code === 'ENOENT') {
      return { status: 'absent', shaByFaqSetId: empty, seoBundleId: null, version: null }
    }
    return {
      status: 'invalid',
      errors: [`pointer unreadable (${pointerPath}): ${e instanceof Error ? e.message : String(e)}`],
      shaByFaqSetId: empty,
      seoBundleId: null,
      version: null,
    }
  }

  const validation = validateSeoBundle({
    artifactRoot: opts.artifactRoot,
    environment: opts.environment,
    publicKeyPem: opts.publicKeyPem,
    runningRendererVersion: opts.runningRendererVersion ?? '999.0.0',
  })
  if (!validation.ok) {
    return {
      status: 'invalid',
      errors: validation.errors,
      shaByFaqSetId: empty,
      seoBundleId: null,
      version: null,
    }
  }

  // The validator already proved the pointer→manifest→content chain is
  // schema/hash/signature consistent; re-read content.json to recompute the
  // per-set FAQ fingerprints.
  const pointer = CurrentPointerSchema.parse(JSON.parse(pointerRaw))
  const manifestPath = resolveArtifactPath(opts.artifactRoot, pointer.manifest_url)
  if (!manifestPath) {
    return {
      status: 'invalid',
      errors: [`unsafe manifest_url: ${pointer.manifest_url}`],
      shaByFaqSetId: empty,
      seoBundleId: null,
      version: null,
    }
  }
  const manifest = ManifestSchema.parse(JSON.parse(readFileSync(manifestPath, 'utf8')))
  const contentPath = resolveArtifactPath(dirname(manifestPath), manifest.files.content.url)
  if (!contentPath) {
    return {
      status: 'invalid',
      errors: [`unsafe content url: ${manifest.files.content.url}`],
      shaByFaqSetId: empty,
      seoBundleId: null,
      version: null,
    }
  }
  const content = ContentSchema.parse(JSON.parse(readFileSync(contentPath, 'utf8')))

  return {
    status: 'ok',
    shaByFaqSetId: faqContentShaMapFromContent(content),
    seoBundleId: validation.seoBundleId ?? pointer.seo_bundle_id,
    version: validation.version ?? pointer.version,
  }
}
