import { describe, expect, it, vi } from 'vitest'

import {
  parseThreeWayComparison,
  readLlmClassification,
  readPendingPurchaseHintBundleId,
  readPendingPurchaseOperatorNoteDocuments,
} from './pendingPurchaseQueries.js'

describe('readPendingPurchaseHintBundleId', () => {
  it('reads the attached bundle from classifier provenance', () => {
    expect(readPendingPurchaseHintBundleId({
      classifier: { hintBundleId: 'pphint_2026-07-11_010203_abcdef' },
    })).toBe('pphint_2026-07-11_010203_abcdef')
  })

  it('returns null when a packet has no valid attached bundle', () => {
    expect(readPendingPurchaseHintBundleId({})).toBeNull()
    expect(readPendingPurchaseHintBundleId({ classifier: { hintBundleId: null } })).toBeNull()
    expect(readPendingPurchaseHintBundleId({ classifier: { hintBundleId: 42 } })).toBeNull()
  })
})

describe('readPendingPurchaseOperatorNoteDocuments', () => {
  it('reads valid generation-time note snapshots', () => {
    expect(readPendingPurchaseOperatorNoteDocuments({
      classifier: {
        operatorNoteDocuments: [
          {
            contentSha256: 'a'.repeat(64),
            hintDocumentId: 'pphdoc_2026-07-11_010203_abcdef',
            sourceLabel: 'Operator context',
          },
        ],
      },
    })).toEqual([{
      contentSha256: 'a'.repeat(64),
      hintDocumentId: 'pphdoc_2026-07-11_010203_abcdef',
      sourceLabel: 'Operator context',
    }])
  })

  it('distinguishes legacy absence from an explicit empty snapshot', () => {
    expect(readPendingPurchaseOperatorNoteDocuments({ classifier: {} })).toBeNull()
    expect(readPendingPurchaseOperatorNoteDocuments({
      classifier: { operatorNoteDocuments: [] },
    })).toEqual([])
  })

  it('fails loudly rather than substituting current bundle contents for malformed provenance', () => {
    expect(() => readPendingPurchaseOperatorNoteDocuments({
      classifier: { operatorNoteDocuments: [{ hintDocumentId: 'malformed' }] },
    })).toThrow(/malformed operator-note provenance/)
  })
})

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

// parseThreeWayComparison validates the per-row 3-way (LLM vs parsekit vs
// legacy) blob the ETL Details page (C8b) reads out of raw_row_json. A present-
// but-malformed blob must degrade to an explicit `invalid` marker (fail-loud in
// the UI + a server warning) rather than throwing and 500-ing the whole page.
describe('parseThreeWayComparison', () => {
  const parsedName = {
    brand: 'Acme',
    category: 'Flower',
    groupName: 'Acme OG',
    packCount: 1,
    prevalence: null,
    searchTerm: 'acme og',
    size: '3.5g',
    strainName: 'OG Kush',
    subcategory: 'Indoor',
    variantName: 'Acme OG 3.5g',
    variantTab: 'Flower',
  }
  const llmLeg = {
    actionType: 'catalog-create',
    targetBrand: 'Acme',
    targetCategory: 'Flower',
    targetSubcategory: 'Indoor',
    targetGroupName: 'Acme OG',
    targetVariantName: 'Acme OG 3.5g',
    targetVariantTab: 'Flower',
    targetStrainName: 'OG Kush',
    targetSize: '3.5g',
    targetPackCount: 1,
    reuseProductId: null,
    reuseProductName: null,
    confidence: 0.9,
    rationale: 'Clean match.',
    reviewFlags: [],
    warningFlags: ['new-brand'],
    citedHintIds: [],
  }

  it('returns the typed comparison for a well-formed blob', () => {
    const blob = {
      schemaVersion: 1,
      llm: llmLeg,
      parsekit: { status: 'ok', output: parsedName, parserId: 'p1', ruleId: 'r1', snapshotSha: 'sha' },
      legacy: { status: 'ok', output: parsedName },
    }
    const result = parseThreeWayComparison(blob, 42)
    expect('status' in result).toBe(false)
    if (!('status' in result)) {
      expect(result.schemaVersion).toBe(1)
      expect(result.parsekit.status).toBe('ok')
      expect(result.legacy.status).toBe('ok')
      expect(result.llm.warningFlags).toEqual(['new-brand'])
    }
  })

  it('accepts non-ok parsekit / legacy legs', () => {
    const blob = {
      schemaVersion: 1,
      llm: llmLeg,
      parsekit: { status: 'no_registry' },
      legacy: { status: 'error', error: 'legacy could not parse' },
    }
    const result = parseThreeWayComparison(blob, 7)
    expect('status' in result).toBe(false)
    if (!('status' in result)) {
      expect(result.parsekit.status).toBe('no_registry')
      expect(result.legacy).toEqual({ status: 'error', error: 'legacy could not parse' })
    }
  })

  it('degrades a malformed present blob to an invalid marker and warns', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    // schemaVersion 2 is unsupported by the v1 literal — a present blob the
    // page cannot read, so it must surface as invalid rather than throw.
    const result = parseThreeWayComparison({ schemaVersion: 2, llm: {}, parsekit: {}, legacy: {} }, 99)
    expect('status' in result).toBe(true)
    if ('status' in result) {
      expect(result.status).toBe('invalid')
      expect(result.schemaVersion).toBe(2)
      expect(result.error.length).toBeGreaterThan(0)
    }
    expect(warnSpy).toHaveBeenCalledOnce()
    expect(warnSpy.mock.calls[0][0]).toContain('row 99')
    warnSpy.mockRestore()
  })

  it('reports a null schemaVersion when the blob is not an object', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const result = parseThreeWayComparison('not an object', 5)
    expect('status' in result).toBe(true)
    if ('status' in result) {
      expect(result.status).toBe('invalid')
      expect(result.schemaVersion).toBeNull()
    }
    warnSpy.mockRestore()
  })
})
