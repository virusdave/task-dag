// CI gate (3) for the FBUS SEO FAQ child epic (#46): bundle-validation
// tests — the FAQ `content_sha256` that lands in a published, signed,
// validatable bundle MUST be exactly the content the approval ledger
// blessed, and content that fails the approval/hash check must never
// reach a bundle at all.
//
// The per-row ledger verification edge cases (missing ledger join, wrong
// content_ref, ledger-hash != stored fingerprint, content mutated after
// approval, wrong approval_kind, null approval_id) are already exhausted
// as unit tests in faqBundleSource.test.ts. This file instead pins the
// END-TO-END boundary the gate is really about: the approval ledger →
// loadApprovedFaqSetsForBundle → compileSeoBundle → publishSeoBundle →
// validateSeoBundle chain, proving (a) approved content flows through to
// a valid signed bundle whose content.json carries exactly the approved
// FAQ payload, and (b) a content_sha256/approval mismatch fails CLOSED
// before anything is published (no bundle dir, no pointer).
//
// Satisfies: virusdave/top-level#17 · Phase: P1

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { QueryResult, QueryResultRow } from 'pg'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { compileSeoBundle } from './compile.js'
import { FaqBundleSourceError, loadApprovedFaqSetsForBundle } from './faqBundleSource.js'
import { faqSetContentSha256, type FaqItemInput } from './faqContent.js'
import { publishSeoBundle, type SeoPublishResult } from './publish.js'
import { validateSeoBundle } from './validate.js'
import { validCompileInput } from './__tests__/fixtures.js'
import { generateEd25519Pem } from '../lp/signing.js'
import type { Queryable } from '../db/pool.js'

const { publicKeyPem, privateKeyPem } = generateEd25519Pem()

// Match the fixture's SEOFAQFold widget (faq_nyc → faq_general @ fb_nyc)
// so the compiled bundle is cross-consistent and we exercise the gate,
// not an unrelated consistency failure.
const FAQ_SET_ID = 'faq_general'
const SCOPE = 'fb_nyc'

const items: FaqItemInput[] = [
  {
    question: 'Hours?',
    answer_raw: 'Open daily for recreational cannabis.',
    answer_sanitized: 'Open daily.',
  },
]

/** A fully-verifiable approved FAQ row (ledger fingerprint == content hash). */
function approvedFaqRow(overrides: Record<string, unknown> = {}) {
  const content_sha256 = faqSetContentSha256({ faq_set_id: FAQ_SET_ID, scope: SCOPE, items })
  return {
    faq_set_id: FAQ_SET_ID,
    scope: SCOPE,
    items,
    content_sha256,
    approval_id: 'seoapr_faq',
    approval_kind: 'faq_set',
    approval_ref: FAQ_SET_ID,
    approval_sha256: content_sha256,
    ...overrides,
  }
}

function fakeDb(rows: Array<Record<string, unknown>>): Queryable {
  return {
    query: async <T extends QueryResultRow>(): Promise<QueryResult<T>> =>
      ({ rows: rows as T[], rowCount: rows.length, command: '', oid: 0, fields: [] }) as QueryResult<T>,
  }
}

function publishFromDb(
  db: Queryable,
  artifactRoot: string,
): Promise<{ faqSets: Awaited<ReturnType<typeof loadApprovedFaqSetsForBundle>>; result: SeoPublishResult }> {
  return loadApprovedFaqSetsForBundle(db).then((faqSets) => {
    const base = validCompileInput()
    const compiled = compileSeoBundle({
      ...base,
      content: { ...base.content, faq_sets: faqSets },
    })
    const result = publishSeoBundle({
      compiled,
      privateKeyPem,
      artifactRoot,
      environment: 'nonprod',
      minRendererVersion: 'mss-seo-runtime>=0.1.0',
      automationGitSha: 'abc1234',
      generatedFrom: { seo_policy_version_id: base.policy.seo_policy_version_id, approval_snapshot_id: 7 },
    })
    return { faqSets, result }
  })
}

describe('FAQ approval → bundle validation (CI gate 3: content_sha256 must match approval)', () => {
  let root: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'seo-faq-approval-'))
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('publishes a valid signed bundle carrying exactly the approved FAQ content', async () => {
    const { faqSets, result } = await publishFromDb(fakeDb([approvedFaqRow()]), root)

    const v = validateSeoBundle({
      artifactRoot: root,
      pointerPath: result.pointerPath,
      publicKeyPem,
      runningRendererVersion: '0.1.0',
    })
    expect(v.errors).toEqual([])
    expect(v.ok).toBe(true)

    // The content that landed in the signed, validated bundle is byte-for-byte
    // the ledger-approved FAQ payload (content_sha256 is intentionally NOT
    // carried in the bundle; the gate is that the published items === approved).
    const published = JSON.parse(readFileSync(join(result.bundleDir, 'content.json'), 'utf8')) as {
      faq_sets: unknown
    }
    expect(published.faq_sets).toEqual(faqSets)
    expect(faqSets).toHaveLength(1)
    expect(faqSets[0]!.items).toEqual(items)
  })

  it('fails closed BEFORE publishing when the FAQ content_sha256 disagrees with the approval ledger', async () => {
    await expect(
      publishFromDb(fakeDb([approvedFaqRow({ approval_sha256: 'f'.repeat(64) })]), root),
    ).rejects.toBeInstanceOf(FaqBundleSourceError)

    // Nothing was published: no immutable bundle dir and no live pointer.
    expect(existsSync(join(root, 'bundles'))).toBe(false)
    expect(existsSync(join(root, 'nonprod', 'current.json'))).toBe(false)
  })

  it('fails closed BEFORE publishing when the content was mutated after approval', async () => {
    const mutated = [{ ...items[0]!, answer_sanitized: 'Open 24/7.' }]
    await expect(
      publishFromDb(fakeDb([approvedFaqRow({ items: mutated })]), root),
    ).rejects.toBeInstanceOf(FaqBundleSourceError)
    expect(existsSync(join(root, 'bundles'))).toBe(false)
    expect(existsSync(join(root, 'nonprod', 'current.json'))).toBe(false)
  })
})
