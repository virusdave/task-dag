import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { compileBundle, CompileError, type CompileInput } from './compile.js'
import { publishBundle } from './publish.js'
import { publishApprovedContentCandidate } from './publishCandidate.js'
import { generateEd25519Pem } from './signing.js'

const { publicKeyPem, privateKeyPem } = generateEd25519Pem()

function approvedContent(): CompileInput {
  return {
    sites: { midtown: { host: 'midtown.freshlybaked.us', purpose_max_variant: { deliverance: 4 } } },
    families: { 'weed-delivery-near-me': { purpose: 'deliverance', slots: ['X1', 'X2'] } },
    components: { trust_anchor_cash_debit_v1: { component_id: 'trust_anchor_cash_debit_v1', frozen: true } },
    variants: [
      { variant_id: 'hero_a', slot: 'X1', source: 'existing', approval_status: 'approved' },
      { variant_id: 'hero_b', slot: 'X1', source: 'generated', approval_status: 'approved' },
    ],
    policy: {
      policy_version_id: 'polv_1',
      selection_algorithm_version: 'hmac-bucket-weighted-v1',
      rules: [
        {
          policy_rule_id: 'r1',
          match: { family: 'weed-delivery-near-me' },
          assignment_key: ['site', 'family'],
          experiment_id: 'e1',
          experiment_salt: 's1',
          exploration_rate_bps: 500,
          slots: {
            X1: { exploit: 'hero_a', explore: [{ variant_id: 'hero_b', weight: 60 }] },
            X2: { fixed: 'trust_anchor_cash_debit_v1' },
          },
        },
      ],
    },
  }
}

function candidateOpts(root: string, extra: Record<string, unknown> = {}) {
  return {
    approvedContent: approvedContent(),
    privateKeyPem,
    publicKeyPem,
    artifactRoot: root,
    environment: 'prod' as const,
    minRendererVersion: 'mss-lp-runtime>=0.4.0',
    automationGitSha: '6c9e1f2',
    generatedFrom: { policy_version_id: 'polv_1' },
    verifyRendererVersion: '0.4.0',
    ...extra,
  }
}

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'lp-candidate-test-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('P5 publishApprovedContentCandidate', () => {
  it('builds + validates a candidate and writes a candidate pointer only', () => {
    const res = publishApprovedContentCandidate(candidateOpts(root))
    expect(res.ok).toBe(true)
    expect(res.validation.ok).toBe(true)
    expect(res.errors).toEqual([])
    expect(res.candidatePointerPath.endsWith('current.candidate.json')).toBe(true)
    // The live pointer is NEVER created by a candidate publish.
    expect(() => readFileSync(join(root, 'prod', 'current.json'), 'utf8')).toThrow()
    expect(res.promoteHint).toContain('P6 canary')
  })

  it('defaults the legacy cross-repo commit producer to disabled', () => {
    const off = publishApprovedContentCandidate(candidateOpts(root))
    expect(off.crossRepoCommitProducerEnabled).toBe(false)

    const on = publishApprovedContentCandidate(candidateOpts(root, { crossRepoCommitProducerEnabled: true }))
    expect(on.crossRepoCommitProducerEnabled).toBe(true)
  })

  it('leaves an existing live pointer frozen as fallback (legacy manifests frozen)', () => {
    // Establish a genuine live prod pointer (current.json) first.
    const live = publishBundle({
      compiled: compileBundle(approvedContent()),
      privateKeyPem,
      artifactRoot: root,
      environment: 'prod',
      minRendererVersion: 'mss-lp-runtime>=0.4.0',
      automationGitSha: '6c9e1f2',
      generatedFrom: { policy_version_id: 'polv_1' },
    })
    const livePointer = join(root, 'prod', 'current.json')
    expect(live.dryRun).toBe(false)
    const beforeBytes = readFileSync(livePointer, 'utf8')

    // Operator approves new content → candidate publish.
    const res = publishApprovedContentCandidate(candidateOpts(root))
    expect(res.ok).toBe(true)

    // The live pointer is byte-for-byte unchanged (frozen fallback).
    expect(readFileSync(livePointer, 'utf8')).toBe(beforeBytes)
  })

  it('a failed candidate does not clobber a previously-staged good candidate', () => {
    const good = publishApprovedContentCandidate(candidateOpts(root))
    expect(good.ok).toBe(true)
    const goodCandidateBytes = readFileSync(join(root, 'prod', 'current.candidate.json'), 'utf8')

    // A second approval whose self-validation fails (renderer too old).
    const bad = publishApprovedContentCandidate(candidateOpts(root, { verifyRendererVersion: '0.1.0' }))
    expect(bad.ok).toBe(false)

    // The canonical candidate still holds the prior good one; no pending
    // staging file was left behind.
    expect(readFileSync(join(root, 'prod', 'current.candidate.json'), 'utf8')).toBe(goodCandidateBytes)
    const leftover = readdirSync(join(root, 'prod')).filter((f) => f.includes('pending'))
    expect(leftover).toEqual([])
  })

  it('throws CompileError on content that does not compile', () => {
    const bad = candidateOpts(root)
    ;(bad.approvedContent as CompileInput).policy.rules[0].slots.X1 = { exploit: 'ghost' }
    expect(() => publishApprovedContentCandidate(bad)).toThrow(CompileError)
  })

  it('fails closed (ok:false) when self-validation cannot be satisfied', () => {
    // Self-validate against a renderer older than the bundle requires → fails.
    const res = publishApprovedContentCandidate(
      candidateOpts(root, { minRendererVersion: 'mss-lp-runtime>=0.4.0', verifyRendererVersion: '0.1.0' }),
    )
    expect(res.ok).toBe(false)
    expect(res.validation.ok).toBe(false)
    expect(res.errors.length).toBeGreaterThan(0)
    expect(res.promoteHint).toContain('did NOT validate')
  })
})
