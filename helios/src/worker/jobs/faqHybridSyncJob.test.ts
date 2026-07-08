import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { generateEd25519Pem, publicKeyPemFromPrivate } from '../../server/lp/signing.js'
import type { FaqSet } from '../../server/seo/contracts.js'
import { faqSetContentSha256 } from '../../server/seo/faqContent.js'
import type { FaqSyncPlan } from '../../server/seo/faqHybridSyncPlan.js'
import {
  buildFaqReviewUrl,
  resolveAppBaseUrl,
  resolveFaqHybridSyncPublishConfig,
  toFaqSyncObservation,
  verifyPublishCandidatesPresent,
  type ManagedFaqSetSnapshot,
} from './faqHybridSyncJob.js'

function snapshot(overrides: Partial<ManagedFaqSetSnapshot> = {}): ManagedFaqSetSnapshot {
  return {
    sourceKey: 'fbus-global-faq',
    faqSetId: 'faq_global_01',
    status: 'draft',
    contentSha256: 'a'.repeat(64),
    ...overrides,
  }
}

describe('toFaqSyncObservation', () => {
  it('sets approvedContentSha256 only when the set is approved', () => {
    const approved = toFaqSyncObservation(
      snapshot({ status: 'approved', contentSha256: 'c'.repeat(64) }),
      null,
      new Map(),
    )
    expect(approved.approvedContentSha256).toBe('c'.repeat(64))

    const draft = toFaqSyncObservation(snapshot({ status: 'draft' }), null, new Map())
    expect(draft.approvedContentSha256).toBeNull()
  })

  it('fills publishedContentSha256 from the live-bundle map by faqSetId', () => {
    const map = new Map([['faq_global_01', 'p'.repeat(64)]])
    const obs = toFaqSyncObservation(snapshot(), 'unchanged', map)
    expect(obs.publishedContentSha256).toBe('p'.repeat(64))
    expect(obs.importOutcome).toBe('unchanged')
  })

  it('leaves publishedContentSha256 null when the set is not in the live bundle', () => {
    const obs = toFaqSyncObservation(snapshot(), null, new Map())
    expect(obs.publishedContentSha256).toBeNull()
  })
})

function approvedSet(): FaqSet {
  return {
    faq_set_id: 'faq_global_01',
    scope: 'all',
    approval_id: 'appr_01',
    items: [
      {
        question: 'How does the rewards program work?',
        answer_raw: 'You earn points per dollar on cannabis purchases.',
        answer_sanitized: 'You earn points per dollar on purchases.',
      },
    ],
  }
}

function shaOf(set: FaqSet): string {
  return faqSetContentSha256({
    faq_set_id: set.faq_set_id,
    scope: set.scope,
    items: set.items.map((i) => ({
      question: i.question,
      answer_raw: i.answer_raw,
      answer_sanitized: i.answer_sanitized,
    })),
  })
}

function planWith(candidate: { faqSetId: string; approvedContentSha256: string }): FaqSyncPlan {
  return {
    publishCandidates: [
      { sourceKey: 'fbus-global-faq', faqSetId: candidate.faqSetId, approvedContentSha256: candidate.approvedContentSha256 },
    ],
    reviewPages: [],
    noops: [],
    shouldPublishBundle: true,
  }
}

describe('verifyPublishCandidatesPresent', () => {
  it('passes when every candidate is present with its expected fingerprint', () => {
    const set = approvedSet()
    const plan = planWith({ faqSetId: set.faq_set_id, approvedContentSha256: shaOf(set) })
    expect(verifyPublishCandidatesPresent(plan, [set])).toEqual([])
  })

  it('flags a candidate that is no longer in the approved set', () => {
    const set = approvedSet()
    const plan = planWith({ faqSetId: 'faq_vanished', approvedContentSha256: shaOf(set) })
    const problems = verifyPublishCandidatesPresent(plan, [set])
    expect(problems).toHaveLength(1)
    expect(problems[0]).toMatch(/no longer in the approved set/)
  })

  it('flags a candidate whose approved fingerprint changed after planning', () => {
    const set = approvedSet()
    const plan = planWith({ faqSetId: set.faq_set_id, approvedContentSha256: 'd'.repeat(64) })
    const problems = verifyPublishCandidatesPresent(plan, [set])
    expect(problems).toHaveLength(1)
    expect(problems[0]).toMatch(/approved fingerprint changed/)
  })
})

describe('buildFaqReviewUrl', () => {
  it('builds the absolute review deep link from a plain origin', () => {
    expect(buildFaqReviewUrl('https://helios.freshlybaked.us', 'faq_global_01')).toBe(
      'https://helios.freshlybaked.us/seo/faq/faq_global_01/review',
    )
  })

  it('honors a base path baked into the app base URL', () => {
    expect(buildFaqReviewUrl('https://example.test/helios/', 'faq_x')).toBe(
      'https://example.test/helios/seo/faq/faq_x/review',
    )
  })

  it('url-encodes the faq set id', () => {
    expect(buildFaqReviewUrl('https://helios.freshlybaked.us', 'a/b?c')).toBe(
      'https://helios.freshlybaked.us/seo/faq/a%2Fb%3Fc/review',
    )
  })
})

describe('resolveAppBaseUrl', () => {
  it('uses APP_BASE_URL when set and valid', () => {
    expect(resolveAppBaseUrl({ APP_BASE_URL: 'https://staging.test/' })).toBe(
      'https://staging.test/',
    )
  })

  it('falls back to the prod origin when unset', () => {
    expect(resolveAppBaseUrl({})).toBe('https://helios.freshlybaked.us')
  })

  it('falls back rather than throwing on a malformed value', () => {
    expect(resolveAppBaseUrl({ APP_BASE_URL: 'not a url' })).toBe(
      'https://helios.freshlybaked.us',
    )
  })
})

describe('resolveFaqHybridSyncPublishConfig', () => {
  let dir: string
  let keyPath: string

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'faq-hybrid-cfg-'))
    keyPath = join(dir, 'signing.pem')
    const { privateKeyPem } = generateEd25519Pem()
    writeFileSync(keyPath, privateKeyPem)
  })
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('returns null when no signing key is configured (customer-dark default)', () => {
    expect(resolveFaqHybridSyncPublishConfig({})).toBeNull()
  })

  it('resolves config + derives the public key from the private key', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const config = resolveFaqHybridSyncPublishConfig({ SEO_BUNDLE_SIGNING_KEY_FILE: keyPath })
    warn.mockRestore()

    expect(config).not.toBeNull()
    expect(config!.environment).toBe('prod')
    expect(config!.artifactRoot).toBe('/cloud/seo')
    // Falls back to the placeholder git sha when none is supplied.
    expect(config!.automationGitSha).toBe('0000000')
    const expectedPub = publicKeyPemFromPrivate(config!.privateKeyPem)
    expect(config!.publicKeyPem).toBe(expectedPub)
  })

  it('uses a valid SEO_BUNDLE_AUTOMATION_GIT_SHA and overrides root/env', () => {
    const config = resolveFaqHybridSyncPublishConfig({
      SEO_BUNDLE_SIGNING_KEY_FILE: keyPath,
      SEO_BUNDLE_AUTOMATION_GIT_SHA: 'deadbeef',
      SEO_ARTIFACT_ROOT: '/cloud/seo-alt',
      SEO_BUNDLE_ENVIRONMENT: 'staging',
    })
    expect(config!.automationGitSha).toBe('deadbeef')
    expect(config!.artifactRoot).toBe('/cloud/seo-alt')
    expect(config!.environment).toBe('staging')
  })
})
