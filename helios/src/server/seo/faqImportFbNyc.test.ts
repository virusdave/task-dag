import { describe, expect, it } from 'vitest'
import type { QueryResult, QueryResultRow } from 'pg'

import type { Queryable } from '../db/pool.js'
import {
  importFaqSetBySourceKey,
  type ImportFaqSetBySourceKeyResult,
} from '../db/queries/seoFaqQueries.js'
import { findAdsPolicyViolations } from './adsPolicy.js'
import {
  checkFaqSetApprovable,
  faqSetContentSha256,
  hasFbusLeak,
} from './faqContent.js'
import {
  DEFAULT_FAQ_GOVERNANCE_POLICY,
  checkFaqSetGovernance,
} from './faqGovernance.js'
import { isFbusFaqSourceKey } from './faqSourceKey.js'
import {
  FB_NYC_FAQ_ITEMS,
  FB_NYC_FAQ_KNOWN_RAW_ADS_FLAGS,
  FB_NYC_FAQ_SCOPE,
  FB_NYC_FAQ_SOURCE_KEY,
  FB_NYC_FAQ_SOURCE_PROVENANCE,
  fbNycFaqImportMeta,
  fbNycFaqItemInputs,
} from './faqImportFbNyc.js'

const ADS_PROBLEM_MARKER = 'forbidden ads-policy claim'

describe('FB-NYC FAQ import data', () => {
  it('imports all 22 source items with non-empty fields', () => {
    expect(FB_NYC_FAQ_ITEMS).toHaveLength(22)
    for (const item of FB_NYC_FAQ_ITEMS) {
      expect(item.question.trim().length).toBeGreaterThan(0)
      expect(item.answer_raw.trim().length).toBeGreaterThan(0)
      expect(item.answer_sanitized.trim().length).toBeGreaterThan(0)
      expect(item.sourceQuestion.trim().length).toBeGreaterThan(0)
    }
  })

  it('fbNycFaqItemInputs() strips the provenance-only sourceQuestion field', () => {
    const inputs = fbNycFaqItemInputs()
    expect(inputs).toHaveLength(22)
    for (const input of inputs) {
      expect(Object.keys(input).sort()).toEqual([
        'answer_raw',
        'answer_sanitized',
        'question',
      ])
    }
  })

  it('targets the FBUS global source key and the reserved global scope', () => {
    expect(FB_NYC_FAQ_SOURCE_KEY).toBe('fbus-global-faq')
    expect(isFbusFaqSourceKey(FB_NYC_FAQ_SOURCE_KEY)).toBe(true)
    expect(FB_NYC_FAQ_SCOPE).toBe('all')
  })

  it('every shared question and sanitized answer is FBUS-clean (no .us-host leak)', () => {
    FB_NYC_FAQ_ITEMS.forEach((item, i) => {
      expect(hasFbusLeak(item.question), `question ${i + 1} leaks`).toBe(false)
      expect(hasFbusLeak(item.answer_sanitized), `sanitized answer ${i + 1} leaks`).toBe(false)
    })
  })

  it('raw answers are the un-sanitized .nyc variant (brand / cannabis copy retained)', () => {
    // The locations answer is the clearest example: brand phrase, "dispensary",
    // and a .nyc email all live in the raw variant and none in the sanitized.
    const locations = FB_NYC_FAQ_ITEMS[9]!
    expect(hasFbusLeak(locations.answer_raw)).toBe(true)
    expect(hasFbusLeak(locations.answer_sanitized)).toBe(false)
    // At least several raw answers carry FBUS-forbidden copy overall.
    const rawWithLeak = FB_NYC_FAQ_ITEMS.filter((it) => hasFbusLeak(it.answer_raw)).length
    expect(rawWithLeak).toBeGreaterThanOrEqual(5)
  })

  it('the ONLY approval problems are the documented verbatim-raw ads-policy flags', () => {
    const problems = checkFaqSetApprovable(fbNycFaqItemInputs(), {
      sourceKey: FB_NYC_FAQ_SOURCE_KEY,
    })
    const adsProblems = problems.filter((p) => p.message.includes(ADS_PROBLEM_MARKER))
    const otherProblems = problems.filter((p) => !p.message.includes(ADS_PROBLEM_MARKER))

    // No structural gaps and no FBUS leak on the shared question / sanitized
    // answer — those would be import bugs.
    expect(otherProblems).toEqual([])

    // The ads-policy flags are exactly the documented set, all on raw copy.
    expect(adsProblems).toHaveLength(FB_NYC_FAQ_KNOWN_RAW_ADS_FLAGS.length)
    for (const p of adsProblems) {
      expect(p.field).toBe('answer_raw')
      expect(p.itemIndex).toBe(FB_NYC_FAQ_KNOWN_RAW_ADS_FLAGS[0]!.itemIndex)
    }
  })

  it('each documented raw ads-policy flag really fires on its raw answer', () => {
    for (const flag of FB_NYC_FAQ_KNOWN_RAW_ADS_FLAGS) {
      const item = FB_NYC_FAQ_ITEMS[flag.itemIndex]!
      const hits = findAdsPolicyViolations(item[flag.field])
      expect(hits).toContainEqual({ category: flag.category, phrase: flag.phrase })
    }
  })

  it('stays within the default governance size budget', () => {
    const { maxItems, maxQuestionChars, maxAnswerChars } = DEFAULT_FAQ_GOVERNANCE_POLICY
    expect(FB_NYC_FAQ_ITEMS.length).toBeLessThanOrEqual(maxItems)
    for (const item of FB_NYC_FAQ_ITEMS) {
      expect(item.question.length).toBeLessThanOrEqual(maxQuestionChars)
      expect(item.answer_raw.length).toBeLessThanOrEqual(maxAnswerChars)
      expect(item.answer_sanitized.length).toBeLessThanOrEqual(maxAnswerChars)
    }
  })

  it('has no draft-artifact / duplicate-question governance problems', () => {
    const problems = checkFaqSetGovernance(fbNycFaqItemInputs())
    const blocking = problems.filter(
      (p) => p.category === 'forbidden_term' || p.category === 'duplicate_question',
    )
    expect(blocking).toEqual([])
  })

  it('records a 40-hex commit + blob provenance sha', () => {
    expect(FB_NYC_FAQ_SOURCE_PROVENANCE.commitSha).toMatch(/^[0-9a-f]{40}$/)
    expect(FB_NYC_FAQ_SOURCE_PROVENANCE.blobSha).toMatch(/^[0-9a-f]{40}$/)
    expect(fbNycFaqImportMeta(new Date('2026-06-17T00:00:00Z'))).toMatchObject({
      kind: 'fb-nyc-faq-import',
      itemCount: 22,
    })
  })
})

// ── importFaqSetBySourceKey idempotency (mocked db) ────────────────────

function mockDb(rowsByCall: (callIndex: number) => QueryResultRow[]): {
  db: Queryable
  calls: { text: string; params: unknown[] | undefined }[]
} {
  const calls: { text: string; params: unknown[] | undefined }[] = []
  const db: Queryable = {
    async query<T extends QueryResultRow>(text: string, params?: unknown[]) {
      const idx = calls.length
      calls.push({ text, params })
      const rows = rowsByCall(idx) as T[]
      return { command: '', fields: [], oid: 0, rowCount: rows.length, rows } as QueryResult<T>
    },
  }
  return { db, calls }
}

function faqRow(overrides: Record<string, unknown>): QueryResultRow {
  return {
    faq_set_id: 'faqset_2026-06-17_000000_abcdef',
    scope: FB_NYC_FAQ_SCOPE,
    source_key: FB_NYC_FAQ_SOURCE_KEY,
    status: 'draft',
    source: 'manual',
    items: fbNycFaqItemInputs(),
    content_sha256: 'f'.repeat(64),
    approval_id: null,
    generation_meta: null,
    created_by_user_id: 7,
    updated_by_user_id: 7,
    created_at: new Date('2026-06-17T00:00:00Z'),
    updated_at: new Date('2026-06-17T00:00:00Z'),
    approved_by_user_id: null,
    approved_at: null,
    approval_note: null,
    ...overrides,
  }
}

describe('importFaqSetBySourceKey', () => {
  const items = fbNycFaqItemInputs()

  it('CREATEs a draft when no set exists for the source key', async () => {
    // call 0: getSeoFaqSetBySourceKey → none; call 1: insert → created row.
    const { db, calls } = mockDb((i) => (i === 0 ? [] : [faqRow({})]))
    const result: ImportFaqSetBySourceKeyResult = await importFaqSetBySourceKey(db, {
      sourceKey: FB_NYC_FAQ_SOURCE_KEY,
      scope: FB_NYC_FAQ_SCOPE,
      items,
      source: 'manual',
      userId: 7,
    })
    expect(result.kind).toBe('created')
    expect(calls).toHaveLength(2)
    expect(calls[1]!.text).toContain('insert into seo_faq_sets')
  })

  it('is a NO-OP (unchanged) when the existing content fingerprint matches', async () => {
    const faqSetId = 'faqset_2026-06-17_000000_abcdef'
    const sha = faqSetContentSha256({ faq_set_id: faqSetId, scope: FB_NYC_FAQ_SCOPE, items })
    const { db, calls } = mockDb((i) =>
      i === 0 ? [faqRow({ faq_set_id: faqSetId, content_sha256: sha })] : [],
    )
    const result = await importFaqSetBySourceKey(db, {
      sourceKey: FB_NYC_FAQ_SOURCE_KEY,
      scope: FB_NYC_FAQ_SCOPE,
      items,
      userId: 7,
    })
    expect(result.kind).toBe('unchanged')
    // Only the lookup ran — no write.
    expect(calls).toHaveLength(1)
  })

  it('UPDATEs (resetting to draft) when the source content changed', async () => {
    const faqSetId = 'faqset_2026-06-17_000000_abcdef'
    const { db, calls } = mockDb((i) =>
      i === 0
        ? [faqRow({ faq_set_id: faqSetId, content_sha256: '0'.repeat(64) })]
        : [faqRow({ faq_set_id: faqSetId, status: 'draft', approval_id: null })],
    )
    const result = await importFaqSetBySourceKey(db, {
      sourceKey: FB_NYC_FAQ_SOURCE_KEY,
      scope: FB_NYC_FAQ_SCOPE,
      items,
      userId: 7,
    })
    expect(result.kind).toBe('updated')
    expect(calls).toHaveLength(2)
    expect(calls[1]!.text).toContain('update seo_faq_sets')
  })
})
