import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { generateEd25519Pem } from '../lp/signing.js'
import { compileSeoBundle } from './compile.js'
import type { Content, FaqSet } from './contracts.js'
import { buildFaqHybridBundleInput } from './faqHybridSyncBundleInput.js'
import { faqSetContentSha256 } from './faqContent.js'
import {
  faqContentShaMapFromContent,
  readPublishedFaqContentShas,
} from './faqPublishedState.js'
import { publishSeoBundle } from './publish.js'

const { publicKeyPem, privateKeyPem } = generateEd25519Pem()

function globalFaqSet(): FaqSet {
  return {
    faq_set_id: 'faq_global_pub',
    scope: 'all',
    approval_id: 'appr_pub',
    items: [
      {
        question: 'How does the rewards program work?',
        answer_raw: 'You earn points per dollar on cannabis purchases.',
        answer_sanitized: 'You earn points per dollar on purchases.',
      },
    ],
  }
}

describe('faqContentShaMapFromContent', () => {
  it('maps each faq_set_id to its recomputed content fingerprint', () => {
    const set = globalFaqSet()
    const content: Content = {
      schema: 'freshlybaked.seo.content.v1',
      seo_bundle_id: 'seob_2026-06-11_120000_abcd12',
      faq_sets: [set],
      posts: [],
      related_link_sets: [],
      heads: [],
    }
    const map = faqContentShaMapFromContent(content)
    const expected = faqSetContentSha256({
      faq_set_id: set.faq_set_id,
      scope: set.scope,
      items: set.items.map((i) => ({
        question: i.question,
        answer_raw: i.answer_raw,
        answer_sanitized: i.answer_sanitized,
      })),
    })
    expect(map.get(set.faq_set_id)).toBe(expected)
  })
})

describe('readPublishedFaqContentShas', () => {
  let root: string

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'seo-published-state-'))
  })
  afterAll(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('returns "absent" when no live pointer exists', () => {
    const state = readPublishedFaqContentShas({
      artifactRoot: root,
      environment: 'preview', // never published in this test
      publicKeyPem,
    })
    expect(state.status).toBe('absent')
    expect(state.shaByFaqSetId.size).toBe(0)
  })

  it('returns the published fingerprints from a valid live bundle', () => {
    const set = globalFaqSet()
    const input = buildFaqHybridBundleInput({
      approvedFaqSets: [set],
      globalFaqSetId: set.faq_set_id,
    })
    const compiled = compileSeoBundle(input)
    publishSeoBundle({
      compiled,
      privateKeyPem,
      artifactRoot: root,
      environment: 'prod',
      minRendererVersion: 'mss-seo-runtime>=0.1.0',
      automationGitSha: 'abc1234',
      generatedFrom: { seo_policy_version_id: input.policy.seo_policy_version_id },
    })

    const state = readPublishedFaqContentShas({
      artifactRoot: root,
      environment: 'prod',
      publicKeyPem,
    })
    expect(state.status).toBe('ok')
    const expected = faqSetContentSha256({
      faq_set_id: set.faq_set_id,
      scope: set.scope,
      items: set.items.map((i) => ({
        question: i.question,
        answer_raw: i.answer_raw,
        answer_sanitized: i.answer_sanitized,
      })),
    })
    expect(state.shaByFaqSetId.get(set.faq_set_id)).toBe(expected)
  })

  it('returns "invalid" (never silently empty) for a tampered live bundle', () => {
    // Validate against a DIFFERENT public key → signature check fails.
    const other = generateEd25519Pem()
    const state = readPublishedFaqContentShas({
      artifactRoot: root,
      environment: 'prod',
      publicKeyPem: other.publicKeyPem,
    })
    expect(state.status).toBe('invalid')
    expect(state.shaByFaqSetId.size).toBe(0)
  })
})
