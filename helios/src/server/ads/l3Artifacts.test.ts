import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { L3_TOP_PROPOSALS_LIMIT, readL3Artifacts } from './l3Artifacts.js'

// ---------------------------------------------------------------------------
// File-reader tests for the P6 L3 feedback-adoption read path. Every test
// builds an isolated temp "automation repo root" and injects it via
// `repoRoot` — NO prod/runtime path is ever touched. Covers the honest
// empty state (the prod-only outputs/ tree absent), addenda hashing +
// header parsing (seed vs generated), latest-evaluation selection,
// malformed-JSON skipping, and the addenda-consumption heuristic.
// ---------------------------------------------------------------------------

let root: string

const L3_DIR = ['ads', 'google', 'outputs', 'l3']
const L2_DIR = ['ads', 'google', 'outputs', 'prod', 'json']
const ADDENDA = ['ads', 'google', 'config', 'l3-addenda.md']

async function writeFileAt(segments: string[], contents: string): Promise<string> {
  const abs = path.join(root, ...segments)
  await fs.mkdir(path.dirname(abs), { recursive: true })
  await fs.writeFile(abs, contents)
  return abs
}

function evalJson(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    evaluation_id: 'eval-1',
    l2_runs_analyzed: ['run-a', 'run-b'],
    trials_analyzed: 0,
    prompt_updates: [],
    rule_updates: [],
    generated_at: '2026-06-01T00:00:00.000Z',
    requires_human_approval: true,
    ...over,
  })
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'l3-artifacts-test-'))
})
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

describe('readL3Artifacts — empty / missing tree', () => {
  it('returns an honest empty state when outputs/ does not exist', async () => {
    const res = await readL3Artifacts({ repoRoot: root })
    expect(res.available).toBe(false)
    expect(res.evaluationsIndexed).toBe(0)
    expect(res.evaluationParseErrors).toBe(0)
    expect(res.latest).toBeNull()
    expect(res.addenda.exists).toBe(false)
    expect(res.addenda.sha256).toBeNull()
    expect(res.consumption.status).toBe('unknown')
    expect(res.consumption.basis).toBe('none')
  })
})

describe('readL3Artifacts — evaluations', () => {
  it('indexes evaluations and picks the newest by generated_at', async () => {
    await writeFileAt(
      [...L3_DIR, 'eval-old-l3-evaluation.json'],
      evalJson({ evaluation_id: 'eval-old', generated_at: '2026-05-01T00:00:00.000Z' }),
    )
    await writeFileAt(
      [...L3_DIR, 'eval-new-l3-evaluation.json'],
      evalJson({
        evaluation_id: 'eval-new',
        generated_at: '2026-06-10T00:00:00.000Z',
        trials_analyzed: 3,
        prompt_updates: [
          { update_type: 'prompt', component: 'a', rationale: 'r1', expected_impact: 'i1', confidence: 0.9 },
          { update_type: 'prompt', component: 'b', rationale: 'r2', expected_impact: 'i2', confidence: 0.3 },
        ],
        rule_updates: [{ update_type: 'l1_rule', component: 'c', rationale: 'r', expected_impact: 'i', confidence: 0.5 }],
        requires_human_approval: false,
      }),
    )
    const res = await readL3Artifacts({ repoRoot: root })
    expect(res.available).toBe(true)
    expect(res.evaluationsIndexed).toBe(2)
    expect(res.latest?.evaluationId).toBe('eval-new')
    expect(res.latest?.trialsAnalyzed).toBe(3)
    expect(res.latest?.promptUpdateCount).toBe(2)
    expect(res.latest?.ruleUpdateCount).toBe(1)
    expect(res.latest?.requiresHumanApproval).toBe(false)
    // Proposals (prompt 0.9/0.3 + rule 0.5) ranked together, confidence desc.
    expect(res.latest?.topProposals.map((p) => p.confidence)).toEqual([0.9, 0.5, 0.3])
  })

  it('ranks prompt AND rule proposals together in topProposals', async () => {
    await writeFileAt(
      [...L3_DIR, 'e-l3-evaluation.json'],
      evalJson({
        prompt_updates: [
          { update_type: 'prompt', component: 'p', rationale: 'r', expected_impact: 'i', confidence: 0.4 },
        ],
        rule_updates: [
          { update_type: 'l1_rule', component: 'r', rationale: 'r', expected_impact: 'i', confidence: 0.95 },
        ],
      }),
    )
    const res = await readL3Artifacts({ repoRoot: root })
    expect(res.latest?.promptUpdateCount).toBe(1)
    expect(res.latest?.ruleUpdateCount).toBe(1)
    // The rule proposal (0.95) outranks the prompt proposal (0.4).
    expect(res.latest?.topProposals[0].updateType).toBe('l1_rule')
    expect(res.latest?.topProposals[0].confidence).toBe(0.95)
    expect(res.latest?.topProposals.length).toBe(2)
  })

  it('skips malformed JSON and counts it as a parse error', async () => {
    await writeFileAt([...L3_DIR, 'good-l3-evaluation.json'], evalJson())
    await writeFileAt([...L3_DIR, 'bad-l3-evaluation.json'], '{ not valid json ')
    const res = await readL3Artifacts({ repoRoot: root })
    expect(res.evaluationsIndexed).toBe(2)
    expect(res.evaluationParseErrors).toBe(1)
    expect(res.latest?.evaluationId).toBe('eval-1')
  })

  it('truncates topProposals at the limit and flags truncation', async () => {
    const updates = Array.from({ length: L3_TOP_PROPOSALS_LIMIT + 2 }, (_, i) => ({
      update_type: 'prompt',
      component: `c${i}`,
      rationale: `r${i}`,
      expected_impact: `i${i}`,
      confidence: (i + 1) / 100,
    }))
    await writeFileAt([...L3_DIR, 'e-l3-evaluation.json'], evalJson({ prompt_updates: updates }))
    const res = await readL3Artifacts({ repoRoot: root })
    expect(res.latest?.topProposals.length).toBe(L3_TOP_PROPOSALS_LIMIT)
    expect(res.latest?.topProposalsTruncated).toBe(true)
  })
})

describe('readL3Artifacts — addenda hashing + header parsing', () => {
  it('hashes a seed addenda (no generated header) and returns mtime + bullets', async () => {
    const seed = [
      '<!-- Seed addenda. Will be overwritten by run-l3-analysis.ts. -->',
      '',
      '### What we learned from the last batch of L2 runs',
      '',
      '- First bullet observation.',
      '- Second bullet observation.',
      '- Third bullet observation.',
      '- Fourth bullet observation.',
    ].join('\n')
    await writeFileAt(ADDENDA, seed)
    const res = await readL3Artifacts({ repoRoot: root })
    expect(res.addenda.exists).toBe(true)
    expect(res.addenda.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(res.addenda.bytes).toBe(Buffer.byteLength(seed))
    expect(res.addenda.modifiedAt).not.toBeNull()
    // No generated-by header in the seed file.
    expect(res.addenda.generatedAt).toBeNull()
    expect(res.addenda.generatedByEvaluationId).toBeNull()
    expect(res.addenda.l2RunsReferencedCount).toBeNull()
    // Top 3 bullets only.
    expect(res.addenda.topBullets).toEqual([
      'First bullet observation.',
      'Second bullet observation.',
      'Third bullet observation.',
    ])
  })

  it('parses the generated-by header (timestamp, evaluation id, L2 runs)', async () => {
    const generated = [
      '<!-- Generated by run-l3-analysis.ts at 2026-06-10T04:00:00.000Z.',
      '     Evaluation: eval-xyz over L2 runs: run-a, run-b, run-c.',
      '     DO NOT EDIT BY HAND — the next L3 run will overwrite this file.',
      '-->',
      '',
      '### What we learned from the last batch of L2 runs',
      '',
      '- Use repair, not pause.',
    ].join('\n')
    await writeFileAt(ADDENDA, generated)
    const res = await readL3Artifacts({ repoRoot: root })
    expect(res.addenda.generatedAt).toBe('2026-06-10T04:00:00.000Z')
    expect(res.addenda.generatedByEvaluationId).toBe('eval-xyz')
    expect(res.addenda.l2RunsReferencedCount).toBe(3)
  })
})

describe('readL3Artifacts — consumption heuristic', () => {
  it('marks likely_consumed when an L2 run is newer than the addenda header time', async () => {
    await writeFileAt(
      ADDENDA,
      '<!-- Generated by run-l3-analysis.ts at 2026-06-10T04:00:00.000Z.\n     Evaluation: e over L2 runs: run-a. -->\n\n- x',
    )
    await writeFileAt(
      [...L2_DIR, 'run-later-l2-output.json'],
      JSON.stringify({ run_id: 'run-later', generated_at: '2026-06-11T04:00:00.000Z' }),
    )
    const res = await readL3Artifacts({ repoRoot: root })
    expect(res.consumption.status).toBe('likely_consumed')
    expect(res.consumption.basis).toBe('addenda_header_generated_at')
    expect(res.consumption.newestL2RunId).toBe('run-later')
    expect(res.consumption.newestL2RunAt).toBe('2026-06-11T04:00:00.000Z')
  })

  it('marks not_yet_consumed when the newest L2 run predates the addenda', async () => {
    await writeFileAt(
      ADDENDA,
      '<!-- Generated by run-l3-analysis.ts at 2026-06-10T04:00:00.000Z.\n     Evaluation: e over L2 runs: run-a. -->\n\n- x',
    )
    await writeFileAt(
      [...L2_DIR, 'run-early-l2-output.json'],
      JSON.stringify({ run_id: 'run-early', generated_at: '2026-06-09T04:00:00.000Z' }),
    )
    const res = await readL3Artifacts({ repoRoot: root })
    expect(res.consumption.status).toBe('not_yet_consumed')
    expect(res.consumption.basis).toBe('addenda_header_generated_at')
  })

  it('falls back to addenda mtime when there is no generated header', async () => {
    await writeFileAt(ADDENDA, '<!-- seed -->\n\n- x')
    // An L2 run far in the future is reliably newer than the just-written
    // seed file's mtime.
    await writeFileAt(
      [...L2_DIR, 'run-future-l2-output.json'],
      JSON.stringify({ run_id: 'run-future', generated_at: '2099-01-01T00:00:00.000Z' }),
    )
    const res = await readL3Artifacts({ repoRoot: root })
    expect(res.consumption.basis).toBe('addenda_mtime')
    expect(res.consumption.status).toBe('likely_consumed')
  })

  it('is unknown when there are no L2 runs', async () => {
    await writeFileAt(ADDENDA, '<!-- seed -->\n\n- x')
    const res = await readL3Artifacts({ repoRoot: root })
    expect(res.consumption.status).toBe('unknown')
    expect(res.consumption.basis).toBe('none')
    expect(res.consumption.newestL2RunId).toBeNull()
  })
})
