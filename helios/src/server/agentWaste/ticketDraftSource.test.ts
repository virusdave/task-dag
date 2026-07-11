import { describe, expect, it } from 'vitest'

import {
  AgentWasteTicketDraftRequestSchema,
  type AgentWasteObservation,
} from '../../shared/contracts/api/agentWaste.js'
import {
  canonicalTicketObservation,
  renderTicketEvidence,
  ticketFilingKey,
  ticketReportFingerprint,
  verifyTicketDraftSource,
} from './ticketDraftSource.js'

function obs(overrides: Partial<AgentWasteObservation> = {}): AgentWasteObservation {
  return {
    time: '2026-07-11T01:02:03Z',
    kind: 'tool_footgun',
    id: 'large-action-lock-double-invocation',
    ...overrides,
  }
}

describe('AgentWasteTicketDraftRequestSchema', () => {
  it('accepts a non-empty strict cluster source', () => {
    expect(
      AgentWasteTicketDraftRequestSchema.parse({ clusterLabel: 'Deploy lock friction', reports: [obs()] }),
    ).toEqual({ clusterLabel: 'Deploy lock friction', reports: [obs()] })
    expect(() =>
      AgentWasteTicketDraftRequestSchema.parse({ clusterLabel: 'x', reports: [obs()], surprise: true }),
    ).toThrow()
    expect(() =>
      AgentWasteTicketDraftRequestSchema.parse({
        clusterLabel: 'x',
        reports: [{ ...obs(), future_identity_field: 'must-not-be-stripped' }],
      }),
    ).toThrow()
    expect(() => AgentWasteTicketDraftRequestSchema.parse({ clusterLabel: 'x', reports: [] })).toThrow()
  })
})

describe('ticket report identity', () => {
  it('covers every observation field explicitly', () => {
    expect(
      canonicalTicketObservation(
        obs({
          severity: 'high',
          repo: 'virusdave/nixos-sbc',
          task_sha: 'a'.repeat(40),
          estimated_wasted_tokens: 12,
          estimated_wasted_seconds: 34,
          note: 'nested lock',
          host: 'vps-nixos-3',
        }),
      ),
    ).toEqual({
      time: '2026-07-11T01:02:03Z',
      kind: 'tool_footgun',
      id: 'large-action-lock-double-invocation',
      severity: 'high',
      repo: 'virusdave/nixos-sbc',
      task_sha: 'a'.repeat(40),
      estimated_wasted_tokens: 12,
      estimated_wasted_seconds: 34,
      note: 'nested lock',
      host: 'vps-nixos-3',
    })
  })

  it('is order-independent, excludes the label, and preserves multiplicity', () => {
    const a = obs({ id: 'a' })
    const b = obs({ id: 'b' })
    expect(ticketFilingKey([a, b])).toBe(ticketFilingKey([b, a]))
    expect(ticketFilingKey([a, b])).not.toBe(ticketFilingKey([a, a, b]))
    expect(ticketReportFingerprint(a)).not.toBe(ticketReportFingerprint(b))
  })

  it('changes when any declared observation field changes', () => {
    const base = obs()
    const variants: AgentWasteObservation[] = [
      { ...base, time: '2026-07-11T01:02:04Z' },
      { ...base, kind: 'startup_waste' },
      { ...base, id: 'other' },
      { ...base, severity: 'high' },
      { ...base, repo: 'virusdave/top-level' },
      { ...base, task_sha: 'a'.repeat(40) },
      { ...base, estimated_wasted_tokens: 1 },
      { ...base, estimated_wasted_seconds: 1 },
      { ...base, note: 'detail' },
      { ...base, host: 'vps-nixos-3' },
    ]
    for (const variant of variants) {
      expect(ticketReportFingerprint(variant)).not.toBe(ticketReportFingerprint(base))
    }
  })
})

describe('verifyTicketDraftSource', () => {
  it('verifies duplicate multiplicity and recomputes aggregates from live reports', () => {
    const duplicate = obs({ estimated_wasted_tokens: 100, estimated_wasted_seconds: 10 })
    const request = { clusterLabel: 'Repeated lock use', reports: [duplicate, duplicate] }
    const result = verifyTicketDraftSource(request, [duplicate, duplicate, obs({ id: 'other' })])
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.source.reportCount).toBe(2)
    expect(result.source.aggregateWastedTokens).toBe(200)
    expect(result.source.aggregateWastedSeconds).toBe(20)
    expect(result.source.filingKey).toBe(ticketFilingKey(request.reports))
  })

  it('fails when the current backlog does not contain the requested multiplicity', () => {
    const duplicate = obs()
    const result = verifyTicketDraftSource(
      { clusterLabel: 'Repeated lock use', reports: [duplicate, duplicate] },
      [duplicate],
    )
    expect(result).toEqual({
      ok: false,
      missingReportFingerprints: [ticketReportFingerprint(duplicate)],
    })
  })
})

describe('renderTicketEvidence', () => {
  it('is deterministic, links valid task commits, and escapes report-authored markup', () => {
    const first = obs({
      id: 'b',
      repo: 'virusdave/nixos-sbc',
      task_sha: 'a'.repeat(40),
      severity: 'high',
      note: '<script>alert(1)</script>\n@virusdave [link](https://example.invalid) ![image](x)',
      estimated_wasted_tokens: 50,
    })
    const second = obs({ id: 'a' })
    const evidence = renderTicketEvidence([first, second])
    expect(evidence).toBe(renderTicketEvidence([second, first]))
    expect(evidence).toContain(`https://github.com/virusdave/nixos-sbc/commit/${'a'.repeat(40)}`)
    expect(evidence).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(evidence).not.toContain('<script>')
    expect(evidence).toContain('<pre><code>')
    expect(evidence).toContain('50 tokens; not reported')
  })

  it('does not link malformed repository names', () => {
    const evidence = renderTicketEvidence([obs({ repo: 'owner/repo)#fragment', task_sha: 'a'.repeat(40) })])
    expect(evidence).not.toContain('https://github.com/')
  })
})
