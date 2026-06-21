import { describe, expect, it } from 'vitest'

import {
  PENDING_PURCHASE_CLASSIFIER_SCHEMA_VERSION,
  type PendingPurchaseLlmClassifierResult,
  type PendingPurchaseLlmDraftRow,
} from '../../shared/contracts/index.js'
import type { ClassifierRowInput } from './classifyPendingPurchasePacket.js'
import {
  PendingPurchaseReconcilerError,
  reconcilePendingPurchaseDrafts,
  type ReconcilePendingPurchaseDraftsInput,
  type ReconcilerCatalogCandidate,
} from './reconcilePendingPurchaseDrafts.js'

// ── builders ─────────────────────────────────────────────────────────────────

function row(overrides: Partial<ClassifierRowInput> = {}): ClassifierRowInput {
  return {
    rowKey: 'r1',
    distributorProductId: 'dp-1',
    distributorProductName: '1O-8F-R26-PNK',
    distributorNames: ['Stop 31 LLC'],
    quantity: 24,
    unitCost: 12.5,
    currentDistributorLinkProductId: null,
    sweedSuggestions: [],
    ...overrides,
  }
}

function draft(overrides: Partial<PendingPurchaseLlmDraftRow> = {}): PendingPurchaseLlmDraftRow {
  return {
    rowKey: 'r1',
    distributorProductId: 'dp-1',
    distributorProductName: '1O-8F-R26-PNK',
    targetBrand: 'Runtz',
    targetCategory: 'Flower',
    targetSubcategory: 'Packaged Eighth',
    targetGroupName: 'Pink Runtz',
    targetVariantName: 'Pink Runtz 3.5g',
    targetVariantTab: 'Flower',
    targetStrainName: 'Pink Runtz',
    targetSize: '3.5g',
    targetPackCount: 1,
    proposedAction: 'catalog-create',
    reuseProductIdCandidate: null,
    reuseEvidence: null,
    confidence: 0.8,
    rationale: 'Decoded from the abbreviated METRC name.',
    citedHintIds: [],
    warningFlags: [],
    ...overrides,
  }
}

function candidate(overrides: Partial<ReconcilerCatalogCandidate> = {}): ReconcilerCatalogCandidate {
  return {
    productId: 7001,
    productName: 'Pink Runtz 3.5g Flower',
    groupId: 900,
    brand: 'Runtz',
    category: 'Flower',
    subcategory: 'Packaged Eighth',
    groupName: 'Pink Runtz',
    variantTab: 'Flower',
    strain: 'Pink Runtz',
    size: '3.5g',
    packCount: 1,
    enabled: true,
    ...overrides,
  }
}

function classifierResult(drafts: PendingPurchaseLlmDraftRow[]): PendingPurchaseLlmClassifierResult {
  return {
    schemaVersion: PENDING_PURCHASE_CLASSIFIER_SCHEMA_VERSION,
    model: 'test-model',
    promptVersion: 'test-prompt',
    drafts,
  }
}

function buildInput(
  overrides: Partial<ReconcilePendingPurchaseDraftsInput> = {},
): ReconcilePendingPurchaseDraftsInput {
  return {
    classifierResult: classifierResult([draft()]),
    rows: [row()],
    catalogCandidates: [candidate()],
    allowedTaxonomy: {
      categories: ['Flower', 'Edibles', 'Vapes', 'Concentrates', 'Pre-Rolls'],
      subcategories: ['Packaged Eighth', 'Gummies'],
    },
    ...overrides,
  }
}

function only(result: ReturnType<typeof reconcilePendingPurchaseDrafts>) {
  expect(result.classifications).toHaveLength(1)
  return result.classifications[0]!
}

// ── tests ────────────────────────────────────────────────────────────────────

describe('reconcilePendingPurchaseDrafts — reuse promotion safety', () => {
  it('promotes a current distributor link the model agreed with', () => {
    const out = only(
      reconcilePendingPurchaseDrafts(
        buildInput({
          rows: [row({ currentDistributorLinkProductId: 7001 })],
          classifierResult: classifierResult([
            draft({
              proposedAction: 'mapping-only',
              reuseProductIdCandidate: 7001,
              reuseEvidence: {
                source: 'current-distributor-link',
                rationale: 'Already linked.',
                citedHintIds: [],
              },
            }),
          ]),
        }),
      ),
    )
    expect(out.actionType).toBe('mapping-only')
    expect(out.reuseProductId).toBe(7001)
    expect(out.reuseGroupId).toBe(900)
    expect(out.validatedReuseSnapshot?.productId).toBe(7001)
    // Adopts the live product's taxonomy.
    expect(out.targetBrand).toBe('Runtz')
  })

  it('blocks catalog-create when a live current link exists but the model omits it', () => {
    const out = only(
      reconcilePendingPurchaseDrafts(
        buildInput({
          rows: [row({ currentDistributorLinkProductId: 7001 })],
          classifierResult: classifierResult([draft({ proposedAction: 'catalog-create' })]),
        }),
      ),
    )
    expect(out.actionType).toBe('needs-review')
    expect(out.reuseProductId).toBeNull()
    expect(out.suggestionCandidates.map((s) => s.productId)).toContain(7001)
    expect(out.reviewFlags.join(' ')).toMatch(/distributor link not confirmed/i)
  })

  it('downgrades when the current link product is not in the candidate set', () => {
    const out = only(
      reconcilePendingPurchaseDrafts(
        buildInput({
          rows: [row({ currentDistributorLinkProductId: 8888 })],
          catalogCandidates: [candidate()],
          classifierResult: classifierResult([
            draft({
              proposedAction: 'mapping-only',
              reuseProductIdCandidate: 8888,
              reuseEvidence: {
                source: 'current-distributor-link',
                rationale: 'linked',
                citedHintIds: [],
              },
            }),
          ]),
        }),
      ),
    )
    expect(out.actionType).toBe('needs-review')
    expect(out.reuseProductId).toBeNull()
    expect(out.suggestionCandidates.map((s) => s.productId)).toContain(8888)
  })

  it('promotes a row-scoped Sweed suggestion with a full lane match', () => {
    const out = only(
      reconcilePendingPurchaseDrafts(
        buildInput({
          rows: [row({ sweedSuggestions: [{ productId: 7001, productName: 'Pink Runtz 3.5g Flower', score: 0.9 }] })],
          classifierResult: classifierResult([
            draft({
              proposedAction: 'mapping-only',
              reuseProductIdCandidate: 7001,
              reuseEvidence: {
                source: 'sweed-suggestion',
                rationale: 'matches the suggestion',
                citedHintIds: [],
              },
            }),
          ]),
        }),
      ),
    )
    expect(out.actionType).toBe('mapping-only')
    expect(out.reuseProductId).toBe(7001)
  })

  it('rejects row B reusing row A\u2019s suggestion (suggestions are row-scoped)', () => {
    const result = reconcilePendingPurchaseDrafts(
      buildInput({
        rows: [
          row({ rowKey: 'rA', distributorProductId: 'dpA', sweedSuggestions: [{ productId: 7001, productName: 'x', score: 0.9 }] }),
          row({ rowKey: 'rB', distributorProductId: 'dpB', sweedSuggestions: [] }),
        ],
        classifierResult: classifierResult([
          draft({ rowKey: 'rA', distributorProductId: 'dpA', proposedAction: 'catalog-create' }),
          draft({
            rowKey: 'rB',
            distributorProductId: 'dpB',
            proposedAction: 'mapping-only',
            reuseProductIdCandidate: 7001,
            reuseEvidence: { source: 'sweed-suggestion', rationale: 'borrowed', citedHintIds: [] },
          }),
        ]),
      }),
    )
    const rowB = result.classifications.find((c) => c.rowKey === 'rB')!
    expect(rowB.actionType).toBe('needs-review')
    expect(rowB.reuseProductId).toBeNull()
    expect(rowB.suggestionCandidates.map((s) => s.productId)).toContain(7001)
  })

  it('never promotes model-inference', () => {
    const out = only(
      reconcilePendingPurchaseDrafts(
        buildInput({
          classifierResult: classifierResult([
            draft({
              proposedAction: 'mapping-only',
              reuseProductIdCandidate: 7001,
              reuseEvidence: { source: 'model-inference', rationale: 'looks like it', citedHintIds: [] },
            }),
          ]),
        }),
      ),
    )
    expect(out.actionType).toBe('needs-review')
    expect(out.reuseProductId).toBeNull()
    expect(out.suggestionCandidates.map((s) => s.productId)).toContain(7001)
  })

  it('treats live-catalog-search as suggestion-only (no independent anchor)', () => {
    const out = only(
      reconcilePendingPurchaseDrafts(
        buildInput({
          classifierResult: classifierResult([
            draft({
              proposedAction: 'mapping-only',
              reuseProductIdCandidate: 7001,
              reuseEvidence: { source: 'live-catalog-search', rationale: 'found it', citedHintIds: [] },
            }),
          ]),
        }),
      ),
    )
    expect(out.actionType).toBe('needs-review')
    expect(out.reuseProductId).toBeNull()
  })

  // A weak/inconsistent evidence source must NOT be promotable even when the
  // proposed product happens to also be in this row's Sweed suggestions and the
  // lanes match. Only source:'sweed-suggestion' + mapping-only is anchored.
  it.each(['model-inference', 'live-catalog-search', 'sibling-po'] as const)(
    'does not promote source=%s even when the product overlaps the row Sweed suggestions',
    (source) => {
      const out = only(
        reconcilePendingPurchaseDrafts(
          buildInput({
            rows: [row({ sweedSuggestions: [{ productId: 7001, productName: 'Pink Runtz 3.5g Flower', score: 0.9 }] })],
            classifierResult: classifierResult([
              draft({
                proposedAction: 'mapping-only',
                reuseProductIdCandidate: 7001,
                reuseEvidence: { source, rationale: 'weak', citedHintIds: source === 'sibling-po' ? ['pphdoc_2026-06-21_000001_ab12cd#f1'] : [] },
              }),
            ]),
          }),
        ),
      )
      expect(out.actionType).toBe('needs-review')
      expect(out.reuseProductId).toBeNull()
      expect(out.suggestionCandidates.map((s) => s.productId)).toContain(7001)
    },
  )

  it('does not promote a needs-review draft even with a sweed-suggestion-anchored lane match', () => {
    const out = only(
      reconcilePendingPurchaseDrafts(
        buildInput({
          rows: [row({ sweedSuggestions: [{ productId: 7001, productName: 'Pink Runtz 3.5g Flower', score: 0.9 }] })],
          classifierResult: classifierResult([
            draft({
              proposedAction: 'needs-review',
              reuseProductIdCandidate: 7001,
              reuseEvidence: { source: 'sweed-suggestion', rationale: 'maybe', citedHintIds: [] },
            }),
          ]),
        }),
      ),
    )
    expect(out.actionType).toBe('needs-review')
    expect(out.reuseProductId).toBeNull()
    expect(out.suggestionCandidates.map((s) => s.productId)).toContain(7001)
  })

  it('degrades a retired/disabled candidate even with a current link', () => {
    const out = only(
      reconcilePendingPurchaseDrafts(
        buildInput({
          rows: [row({ currentDistributorLinkProductId: 7001 })],
          catalogCandidates: [candidate({ productName: 'DEAD - Pink Runtz 3.5g' })],
          classifierResult: classifierResult([
            draft({
              proposedAction: 'mapping-only',
              reuseProductIdCandidate: 7001,
              reuseEvidence: { source: 'current-distributor-link', rationale: 'linked', citedHintIds: [] },
            }),
          ]),
        }),
      ),
    )
    expect(out.actionType).toBe('needs-review')
    expect(out.reuseProductId).toBeNull()
  })

  it('rejects a suggestion-anchored reuse whose strain conflicts even if the group matches', () => {
    const out = only(
      reconcilePendingPurchaseDrafts(
        buildInput({
          rows: [row({ sweedSuggestions: [{ productId: 7001, productName: 'x', score: 0.9 }] })],
          catalogCandidates: [candidate({ strain: 'Blue Dream' })],
          classifierResult: classifierResult([
            draft({
              targetStrainName: 'Pink Runtz',
              proposedAction: 'mapping-only',
              reuseProductIdCandidate: 7001,
              reuseEvidence: { source: 'sweed-suggestion', rationale: 'same group', citedHintIds: [] },
            }),
          ]),
        }),
      ),
    )
    expect(out.actionType).toBe('needs-review')
    expect(out.reuseProductId).toBeNull()
  })
})

describe('reconcilePendingPurchaseDrafts — taxonomy / compliance guards', () => {
  it('forces needs-review and strips a prohibited house brand', () => {
    const out = only(
      reconcilePendingPurchaseDrafts(
        buildInput({
          classifierResult: classifierResult([draft({ targetBrand: 'Freshly Baked NYC' })]),
        }),
      ),
    )
    expect(out.actionType).toBe('needs-review')
    expect(out.targetBrand).toBeNull()
    expect(out.reviewFlags.join(' ')).toMatch(/house brand/i)
  })

  it('downgrades a category outside the allowed taxonomy', () => {
    const out = only(
      reconcilePendingPurchaseDrafts(
        buildInput({
          classifierResult: classifierResult([draft({ targetCategory: 'Mystery' })]),
        }),
      ),
    )
    expect(out.actionType).toBe('needs-review')
    expect(out.reviewFlags.join(' ')).toMatch(/allowed taxonomy/i)
  })

  it('splits an illegal single-piece edible above 10mg into canonical pieces', () => {
    const out = only(
      reconcilePendingPurchaseDrafts(
        buildInput({
          classifierResult: classifierResult([
            draft({
              targetCategory: 'Edibles',
              targetSubcategory: 'Gummies',
              targetSize: '100mg',
              targetPackCount: 1,
              targetVariantTab: 'Gummies',
            }),
          ]),
        }),
      ),
    )
    expect(out.targetPackCount).toBe(10)
    expect(out.targetSize).toBe('10mg')
    expect(out.reviewFlags.join(' ')).toMatch(/edible split/i)
  })

  it('flags an edible over the 100mg package cap for manual review', () => {
    const out = only(
      reconcilePendingPurchaseDrafts(
        buildInput({
          classifierResult: classifierResult([
            draft({
              targetCategory: 'Edibles',
              targetSubcategory: 'Gummies',
              targetSize: '250mg',
              targetPackCount: 1,
            }),
          ]),
        }),
      ),
    )
    expect(out.actionType).toBe('needs-review')
    expect(out.reviewFlags.join(' ')).toMatch(/100mg\/package cap/i)
  })
})

describe('reconcilePendingPurchaseDrafts — duplicate detection', () => {
  it('downgrades a catalog-create that duplicates an existing live variant', () => {
    const out = only(
      reconcilePendingPurchaseDrafts(
        buildInput({
          // model proposes a NEW product whose identity already exists live
          catalogCandidates: [candidate()],
          classifierResult: classifierResult([draft({ proposedAction: 'catalog-create' })]),
        }),
      ),
    )
    expect(out.actionType).toBe('needs-review')
    expect(out.reuseProductId).toBeNull()
    expect(out.reviewFlags.join(' ')).toMatch(/existing live variant/i)
    expect(out.suggestionCandidates.map((s) => s.productId)).toContain(7001)
  })

  it('attaches a genuinely-new variant to an existing brand+group', () => {
    const out = only(
      reconcilePendingPurchaseDrafts(
        buildInput({
          // Same brand+group, but a different size so it is NOT a duplicate variant.
          catalogCandidates: [candidate({ size: '7g' })],
          classifierResult: classifierResult([draft({ proposedAction: 'catalog-create', targetSize: '3.5g' })]),
        }),
      ),
    )
    expect(out.actionType).toBe('catalog-create')
    expect(out.reuseProductId).toBeNull()
    expect(out.reuseGroupId).toBe(900)
  })

  it('creates a brand-new product when nothing live matches', () => {
    const out = only(
      reconcilePendingPurchaseDrafts(
        buildInput({
          catalogCandidates: [],
          classifierResult: classifierResult([draft({ proposedAction: 'catalog-create' })]),
        }),
      ),
    )
    expect(out.actionType).toBe('catalog-create')
    expect(out.reuseGroupId).toBeNull()
  })

  it('does not auto-conflict when two rows reuse the same live product', () => {
    const result = reconcilePendingPurchaseDrafts(
      buildInput({
        rows: [
          row({ rowKey: 'rA', distributorProductId: 'dpA', currentDistributorLinkProductId: 7001 }),
          row({ rowKey: 'rB', distributorProductId: 'dpB', currentDistributorLinkProductId: 7001 }),
        ],
        classifierResult: classifierResult([
          draft({
            rowKey: 'rA',
            distributorProductId: 'dpA',
            proposedAction: 'mapping-only',
            reuseProductIdCandidate: 7001,
            reuseEvidence: { source: 'current-distributor-link', rationale: 'linked', citedHintIds: [] },
          }),
          draft({
            rowKey: 'rB',
            distributorProductId: 'dpB',
            proposedAction: 'mapping-only',
            reuseProductIdCandidate: 7001,
            reuseEvidence: { source: 'current-distributor-link', rationale: 'linked', citedHintIds: [] },
          }),
        ]),
      }),
    )
    expect(result.classifications.every((c) => c.actionType === 'mapping-only')).toBe(true)
    expect(result.classifications.every((c) => c.reuseProductId === 7001)).toBe(true)
  })
})

describe('reconcilePendingPurchaseDrafts — internal corruption throws', () => {
  it('throws on conflicting duplicate catalog candidates', () => {
    expect(() =>
      reconcilePendingPurchaseDrafts(
        buildInput({
          catalogCandidates: [candidate(), candidate({ brand: 'Different' })],
        }),
      ),
    ).toThrow(PendingPurchaseReconcilerError)
  })

  it('throws when a draft is missing for an input row', () => {
    expect(() =>
      reconcilePendingPurchaseDrafts(
        buildInput({
          rows: [row({ rowKey: 'rA' }), row({ rowKey: 'rB', distributorProductId: 'dpB' })],
          classifierResult: classifierResult([draft({ rowKey: 'rA' })]),
        }),
      ),
    ).toThrow(/coverage mismatch/i)
  })

  it('throws when a draft references an unknown rowKey', () => {
    expect(() =>
      reconcilePendingPurchaseDrafts(
        buildInput({
          rows: [row({ rowKey: 'rA' })],
          classifierResult: classifierResult([draft({ rowKey: 'rZ' })]),
        }),
      ),
    ).toThrow(/unknown rowKey/i)
  })

  it('throws on duplicate input rowKeys', () => {
    expect(() =>
      reconcilePendingPurchaseDrafts(
        buildInput({
          rows: [row({ rowKey: 'dup' }), row({ rowKey: 'dup', distributorProductId: 'dpB' })],
          classifierResult: classifierResult([draft({ rowKey: 'dup' })]),
        }),
      ),
    ).toThrow(/duplicate input rowkey/i)
  })
})

describe('reconcilePendingPurchaseDrafts — provenance + invariants', () => {
  it('echoes classifier provenance and stamps the reconciler version', () => {
    const result = reconcilePendingPurchaseDrafts(buildInput())
    expect(result.model).toBe('test-model')
    expect(result.promptVersion).toBe('test-prompt')
    expect(result.reconcilerVersion).toMatch(/deterministic-validator/)
  })

  it('copies distributor identity from the input row, not the model echo', () => {
    const out = only(
      reconcilePendingPurchaseDrafts(
        buildInput({
          rows: [row({ distributorProductId: 'authoritative-id', distributorProductName: 'AUTH NAME' })],
          classifierResult: classifierResult([
            draft({ distributorProductId: 'model-lied', distributorProductName: 'WRONG' }),
          ]),
        }),
      ),
    )
    expect(out.distributorProductId).toBe('authoritative-id')
    expect(out.distributorProductName).toBe('AUTH NAME')
  })
})
