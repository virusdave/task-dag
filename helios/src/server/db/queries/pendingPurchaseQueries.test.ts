import { describe, expect, it } from 'vitest'

import { readLlmClassification } from './pendingPurchaseQueries.js'

// readLlmClassification parses the prospective-classifier provenance block the
// generate job (C8) stores under raw_row_json.llmClassification and the review
// UI (C6) surfaces. It is tolerant by design: the field is absent on every
// legacy / imported row, and the values are audit/review context only (never a
// safety input), so a malformed blob must degrade to null rather than throw.
describe('readLlmClassification', () => {
  it('returns null for non-object / absent inputs', () => {
    expect(readLlmClassification(null)).toBeNull()
    expect(readLlmClassification(undefined)).toBeNull()
    expect(readLlmClassification('nope')).toBeNull()
    expect(readLlmClassification(42)).toBeNull()
    expect(readLlmClassification([{ confidence: 0.5 }])).toBeNull()
  })

  it('returns null when a finite confidence is missing (confidence is required)', () => {
    expect(readLlmClassification({})).toBeNull()
    // Rationale alone is not a real classification — confidence is required, so
    // the UI never fabricates a misleading "model 0%" pill.
    expect(readLlmClassification({ rationale: 'just a rationale' })).toBeNull()
    expect(readLlmClassification({ model: 'm', citedHintIds: ['a'] })).toBeNull()
    expect(readLlmClassification({ confidence: 'high', rationale: 'r' })).toBeNull()
  })

  it('parses a well-formed block', () => {
    expect(
      readLlmClassification({
        schemaVersion: 1,
        model: 'claude-x',
        promptVersion: 'p-2026-06-21',
        reconcilerVersion: 'r-2026-06-21',
        confidence: 0.87,
        rationale: 'Matches the distributor menu entry exactly.',
        citedHintIds: ['pphdoc_2026-06-21_000123_ab12cd#f3'],
        warningFlags: ['new-brand'],
      }),
    ).toEqual({
      schemaVersion: 1,
      model: 'claude-x',
      promptVersion: 'p-2026-06-21',
      reconcilerVersion: 'r-2026-06-21',
      confidence: 0.87,
      rationale: 'Matches the distributor menu entry exactly.',
      citedHintIds: ['pphdoc_2026-06-21_000123_ab12cd#f3'],
      warningFlags: ['new-brand'],
    })
  })

  it('clamps out-of-range confidence into [0, 1]', () => {
    expect(readLlmClassification({ confidence: 1.4, rationale: 'x' })?.confidence).toBe(1)
    expect(readLlmClassification({ confidence: -0.2, rationale: 'x' })?.confidence).toBe(0)
  })

  it('fills safe defaults for missing / wrong-typed provenance fields', () => {
    const parsed = readLlmClassification({ confidence: 0.42 })
    expect(parsed).toEqual({
      schemaVersion: 0,
      model: '',
      promptVersion: '',
      reconcilerVersion: '',
      confidence: 0.42,
      rationale: '',
      citedHintIds: [],
      warningFlags: [],
    })
  })

  it('coerces a negative / non-integer schemaVersion to 0', () => {
    expect(readLlmClassification({ confidence: 0.5, schemaVersion: -1 })?.schemaVersion).toBe(0)
    expect(readLlmClassification({ confidence: 0.5, schemaVersion: 1.5 })?.schemaVersion).toBe(0)
    expect(readLlmClassification({ confidence: 0.5, schemaVersion: 2 })?.schemaVersion).toBe(2)
  })

  it('drops non-string entries from the string arrays', () => {
    const parsed = readLlmClassification({
      confidence: 0.5,
      rationale: 'r',
      citedHintIds: ['ok', 7, null, ''],
      warningFlags: ['no-comps', {}],
    })
    expect(parsed?.citedHintIds).toEqual(['ok'])
    expect(parsed?.warningFlags).toEqual(['no-comps'])
  })

  it('treats a non-finite confidence with no rationale as absent', () => {
    expect(readLlmClassification({ confidence: Number.NaN })).toBeNull()
  })
})
