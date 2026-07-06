import { describe, expect, it } from 'vitest'
import type { QueryResult, QueryResultRow } from 'pg'

import type { Queryable } from '../pool.js'
import {
  getParseFeedbackById,
  insertConventionProposal,
  insertListingCorrection,
  listParseFeedback,
  loadFuzzySkuProvenance,
  updateParseFeedbackDraft,
  updateParseFeedbackStatus,
  type FuzzySkuProvenance,
} from './catalogParseFeedbackQueries.js'

// ---------------------------------------------------------------------------
// Query-layer tests for the INERT parse-feedback inbox (issue #59, T3). These
// use a recording mock `Queryable` (no DB), so they're deterministic and
// prod-resource-free. They assert the SQL/params (indexed reads, provenance
// projection, draft-only edits, kind-correct inserts) and the row→record
// mapping (discriminated union, id/date coercion).
// ---------------------------------------------------------------------------

interface Recorded {
  text: string
  params: unknown[] | undefined
}

const BASE_ROW = {
  id: '11111111-1111-4111-8111-111111111111',
  kind: 'listing_correction',
  use_case: 'litalerts',
  source_listing_id: 'listing-1',
  fuzzy_sku_id: '42',
  retailer_id: '7',
  raw_listing_name: 'Some Brand 3.5g Flower',
  input_hash: 'hash-abc',
  input_snapshot: { retailerId: '7', listingName: 'Some Brand 3.5g Flower' },
  family_key: 'fam-1',
  brand_key: 'brand-1',
  matched_catalog_product_id: '900',
  source_feedback_id: null as string | null,
  details: { issueTypes: ['size'], packCount: 1 },
  status: 'draft',
  status_changed_by: null as string | null,
  status_changed_at: null as Date | null,
  created_by: 'op@example.com',
  created_at: new Date('2026-07-06T10:00:00.000Z'),
  updated_by: 'op@example.com',
  updated_at: new Date('2026-07-06T10:00:00.000Z'),
}

function conventionRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...BASE_ROW,
    id: '22222222-2222-4222-8222-222222222222',
    kind: 'convention_proposal',
    source_feedback_id: BASE_ROW.id,
    details: { scope: 'retailer_category', note: 'brand first', examples: [], patternChips: ['brand_first'] },
    created_at: new Date('2026-07-06T11:00:00.000Z'),
    updated_at: new Date('2026-07-06T11:00:00.000Z'),
    ...overrides,
  }
}

/**
 * A mock DB that returns a queued result per matched query-shape predicate.
 * Each handler is (text) => rows | null; the first matching handler wins.
 */
function mockDb(
  handlers: Array<{ match: (text: string) => boolean; rows: Record<string, unknown>[] }>,
): { db: Queryable; calls: Recorded[] } {
  const calls: Recorded[] = []
  const db: Queryable = {
    async query<TResult extends QueryResultRow>(text: string, params?: unknown[]) {
      calls.push({ text, params })
      const handler = handlers.find((h) => h.match(text))
      const out = handler ? handler.rows : []
      return {
        command: 'SELECT',
        fields: [],
        oid: 0,
        rowCount: out.length,
        rows: out as unknown as TResult[],
      } as QueryResult<TResult>
    },
  }
  return { db, calls }
}

const PROVENANCE: FuzzySkuProvenance = {
  fuzzySkuId: 42,
  sourceListingId: 'listing-1',
  useCase: 'litalerts',
  retailerId: 7,
  rawListingName: 'Some Brand 3.5g Flower',
  inputHash: 'hash-abc',
  inputSnapshot: { retailerId: '7' },
}

describe('listParseFeedback', () => {
  it('queries only by fuzzy_sku_id when no retailerIds given', async () => {
    const { db, calls } = mockDb([{ match: (t) => /fuzzy_sku_id = any\(/.test(t), rows: [BASE_ROW] }])
    const out = await listParseFeedback(db, { fuzzySkuIds: [42], retailerIds: [] })
    expect(calls.length).toBe(1)
    expect(calls[0]!.text).toMatch(/fuzzy_sku_id = any\(\$1::bigint\[\]\)/)
    expect(calls[0]!.params).toEqual([[42]])
    expect(out).toHaveLength(1)
    expect(out[0]!.kind).toBe('listing_correction')
  })

  it('queries only by retailer_id when no fuzzySkuIds given', async () => {
    const { db, calls } = mockDb([{ match: (t) => /retailer_id = any\(/.test(t), rows: [conventionRow()] }])
    const out = await listParseFeedback(db, { fuzzySkuIds: [], retailerIds: [7] })
    expect(calls.length).toBe(1)
    expect(calls[0]!.text).toMatch(/retailer_id = any\(\$1::bigint\[\]\)/)
    expect(out).toHaveLength(1)
    expect(out[0]!.kind).toBe('convention_proposal')
  })

  it('runs two indexed queries and dedups a row matching both filters', async () => {
    const { db, calls } = mockDb([
      { match: (t) => /fuzzy_sku_id = any\(/.test(t), rows: [BASE_ROW] },
      { match: (t) => /retailer_id = any\(/.test(t), rows: [BASE_ROW, conventionRow()] },
    ])
    const out = await listParseFeedback(db, { fuzzySkuIds: [42], retailerIds: [7] })
    expect(calls.length).toBe(2)
    // BASE_ROW appears in both result sets but must be returned once.
    expect(out).toHaveLength(2)
    const ids = out.map((r) => r.id)
    expect(new Set(ids).size).toBe(2)
    // Sorted newest-first: convention (11:00) before correction (10:00).
    expect(out[0]!.id).toBe('22222222-2222-4222-8222-222222222222')
    expect(out[1]!.id).toBe(BASE_ROW.id)
  })

  it('makes no query when both id sets are empty', async () => {
    const { db, calls } = mockDb([])
    const out = await listParseFeedback(db, { fuzzySkuIds: [], retailerIds: [] })
    expect(calls.length).toBe(0)
    expect(out).toEqual([])
  })
})

describe('loadFuzzySkuProvenance', () => {
  it('projects only the needed fields and forces useCase=litalerts', async () => {
    const { db, calls } = mockDb([
      {
        match: (t) => /from fuzzy_skus/.test(t),
        rows: [
          {
            id: '42',
            source_listing_id: 'listing-1',
            raw_input_hash: 'hash-abc',
            retailer_id: '7',
            listing_name: 'Some Brand 3.5g Flower',
            input_snapshot: { retailerId: '7', listingName: 'Some Brand 3.5g Flower' },
          },
        ],
      },
    ])
    const out = await loadFuzzySkuProvenance(db, 42)
    // Never selects the whole raw_input_jsonb blob.
    expect(calls[0]!.text).not.toMatch(/select\s+[^;]*raw_input_jsonb\s*,/i)
    expect(calls[0]!.text).toMatch(/jsonb_build_object/)
    expect(out).toEqual({
      fuzzySkuId: 42,
      sourceListingId: 'listing-1',
      useCase: 'litalerts',
      retailerId: 7,
      rawListingName: 'Some Brand 3.5g Flower',
      inputHash: 'hash-abc',
      inputSnapshot: { retailerId: '7', listingName: 'Some Brand 3.5g Flower' },
    })
  })

  it('returns null for an unknown fuzzy sku id', async () => {
    const { db } = mockDb([{ match: (t) => /from fuzzy_skus/.test(t), rows: [] }])
    expect(await loadFuzzySkuProvenance(db, 999)).toBeNull()
  })
})

describe('insertListingCorrection', () => {
  it('inserts a listing_correction with server-derived provenance + serialized details', async () => {
    const { db, calls } = mockDb([{ match: (t) => /insert into litalerts_parse_feedback/.test(t), rows: [BASE_ROW] }])
    const details = { issueTypes: ['size'] as const, packCount: 1 }
    const rec = await insertListingCorrection(db, {
      provenance: PROVENANCE,
      familyKey: 'fam-1',
      brandKey: 'brand-1',
      matchedCatalogProductId: 900,
      details: {
        issueTypes: ['size'],
        packCount: 1,
        unitSizeValue: null,
        unitSizeUnit: null,
        totalSizeValue: null,
        totalSizeUnit: null,
        category: null,
        subcategory: null,
        brand: null,
        strain: null,
        nameTokens: null,
        note: null,
      },
      actor: 'op@example.com',
    })
    expect(calls[0]!.text).toMatch(/values \('listing_correction'/)
    const params = calls[0]!.params!
    expect(params[0]).toBe('litalerts') // use_case
    expect(params[1]).toBe('listing-1') // source_listing_id (server-derived)
    expect(params[2]).toBe(42) // fuzzy_sku_id
    expect(params[3]).toBe(7) // retailer_id (server-derived)
    expect(params[5]).toBe('hash-abc') // input_hash (server-derived)
    // details is serialized JSON.
    expect(typeof params[10]).toBe('string')
    expect(JSON.parse(params[10] as string)).toMatchObject({ issueTypes: ['size'], packCount: 1 })
    // created_by === updated_by ($12 bound once, referenced twice).
    expect(params[11]).toBe('op@example.com')
    expect(rec.kind).toBe('listing_correction')
    void details
  })
})

describe('insertConventionProposal', () => {
  it('inserts a convention_proposal linked to its source correction', async () => {
    const { db, calls } = mockDb([
      { match: (t) => /insert into litalerts_parse_feedback/.test(t), rows: [conventionRow()] },
    ])
    const rec = await insertConventionProposal(db, {
      provenance: PROVENANCE,
      familyKey: 'fam-1',
      brandKey: 'brand-1',
      matchedCatalogProductId: 900,
      sourceFeedbackId: BASE_ROW.id,
      details: {
        scope: 'retailer_category',
        note: 'brand first',
        examples: [],
        patternChips: ['brand_first'],
        category: null,
        subcategory: null,
        brand: null,
      },
      actor: 'op@example.com',
    })
    expect(calls[0]!.text).toMatch(/values \('convention_proposal'/)
    const params = calls[0]!.params!
    expect(params[10]).toBe(BASE_ROW.id) // source_feedback_id
    expect(JSON.parse(params[11] as string)).toMatchObject({ scope: 'retailer_category' }) // details
    expect(rec.kind).toBe('convention_proposal')
    expect(rec.sourceFeedbackId).toBe(BASE_ROW.id)
  })
})

describe('updateParseFeedbackDraft', () => {
  const detailsUpdate = {
    issueTypes: ['pack_qty' as const],
    packCount: 2,
    unitSizeValue: null,
    unitSizeUnit: null,
    totalSizeValue: null,
    totalSizeUnit: null,
    category: null,
    subcategory: null,
    brand: null,
    strain: null,
    nameTokens: null,
    note: null,
  }

  it('returns null when the row is unknown', async () => {
    const { db } = mockDb([{ match: (t) => /where id = \$1/.test(t) && /select/.test(t), rows: [] }])
    const out = await updateParseFeedbackDraft(db, BASE_ROW.id, {
      details: detailsUpdate,
      actor: 'op@example.com',
    })
    expect(out).toBeNull()
  })

  it("returns 'not-draft' when the existing row is no longer a draft", async () => {
    const { db, calls } = mockDb([
      { match: (t) => /^\s*select/.test(t) && /where id = \$1/.test(t), rows: [{ ...BASE_ROW, status: 'promoted' }] },
    ])
    const out = await updateParseFeedbackDraft(db, BASE_ROW.id, {
      details: detailsUpdate,
      actor: 'op@example.com',
    })
    expect(out).toBe('not-draft')
    // Must NOT run the UPDATE once it sees a non-draft row.
    expect(calls.some((c) => /update litalerts_parse_feedback/.test(c.text))).toBe(false)
  })

  it('updates a draft in place and guards the UPDATE with status = draft', async () => {
    const { db, calls } = mockDb([
      { match: (t) => /^\s*select/.test(t) && /where id = \$1/.test(t), rows: [BASE_ROW] },
      { match: (t) => /update litalerts_parse_feedback/.test(t), rows: [{ ...BASE_ROW, updated_by: 'op2@example.com' }] },
    ])
    const out = await updateParseFeedbackDraft(db, BASE_ROW.id, {
      details: detailsUpdate,
      matchedCatalogProductId: 901,
      actor: 'op2@example.com',
    })
    const upd = calls.find((c) => /update litalerts_parse_feedback/.test(c.text))!
    expect(upd.text).toMatch(/where id = \$\d+ and status = 'draft'/)
    expect(upd.text).toMatch(/matched_catalog_product_id = \$/)
    expect(out).not.toBeNull()
    expect(out).not.toBe('not-draft')
  })
})

describe('updateParseFeedbackStatus', () => {
  it('sets status + status_changed_* + updated_* and maps the row', async () => {
    const { db, calls } = mockDb([
      {
        match: (t) => /update litalerts_parse_feedback/.test(t),
        rows: [{ ...BASE_ROW, status: 'promotion_requested', status_changed_by: 'op@example.com', status_changed_at: new Date('2026-07-06T12:00:00.000Z') }],
      },
    ])
    const out = await updateParseFeedbackStatus(db, BASE_ROW.id, {
      status: 'promotion_requested',
      actor: 'op@example.com',
    })
    expect(calls[0]!.text).toMatch(/status_changed_by = \$2/)
    expect(calls[0]!.params).toEqual(['promotion_requested', 'op@example.com', BASE_ROW.id])
    expect(out!.status).toBe('promotion_requested')
    expect(out!.statusChangedAt).toBe('2026-07-06T12:00:00.000Z')
  })

  it('returns null when the id is unknown', async () => {
    const { db } = mockDb([{ match: (t) => /update litalerts_parse_feedback/.test(t), rows: [] }])
    expect(
      await updateParseFeedbackStatus(db, BASE_ROW.id, { status: 'rejected', actor: 'x' }),
    ).toBeNull()
  })
})

describe('getParseFeedbackById → row mapping', () => {
  it('maps a listing_correction row into a discriminated record', async () => {
    const { db } = mockDb([{ match: (t) => /where id = \$1/.test(t), rows: [BASE_ROW] }])
    const rec = await getParseFeedbackById(db, BASE_ROW.id)
    expect(rec).not.toBeNull()
    expect(rec!.kind).toBe('listing_correction')
    expect(rec!.fuzzySkuId).toBe(42)
    expect(rec!.retailerId).toBe(7)
    expect(rec!.matchedCatalogProductId).toBe(900)
    expect(rec!.createdAt).toBe('2026-07-06T10:00:00.000Z')
    if (rec!.kind === 'listing_correction') {
      expect(rec!.details.issueTypes).toEqual(['size'])
      expect(rec!.details.packCount).toBe(1)
    }
  })

  it('maps a convention_proposal row into a discriminated record', async () => {
    const { db } = mockDb([{ match: (t) => /where id = \$1/.test(t), rows: [conventionRow()] }])
    const rec = await getParseFeedbackById(db, '22222222-2222-4222-8222-222222222222')
    expect(rec!.kind).toBe('convention_proposal')
    if (rec!.kind === 'convention_proposal') {
      expect(rec!.details.scope).toBe('retailer_category')
      expect(rec!.details.patternChips).toEqual(['brand_first'])
    }
  })
})
