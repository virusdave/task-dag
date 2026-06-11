import type { QueryResult, QueryResultRow } from 'pg'
import { describe, expect, it } from 'vitest'

import { FaqBundleSourceError, loadApprovedFaqSetsForBundle } from './faqBundleSource.js'
import { faqSetContentSha256, type FaqItemInput } from './faqContent.js'
import type { Queryable } from '../db/pool.js'

const items: FaqItemInput[] = [
  {
    question: 'What are your hours?',
    answer_raw: 'Open 9-9 with fresh cannabis daily.',
    answer_sanitized: 'Open 9-9 with fresh products daily.',
  },
]

function approvedRow(overrides: Record<string, unknown> = {}) {
  const faq_set_id = 'faqset_a'
  const scope = 'all'
  const content_sha256 = faqSetContentSha256({ faq_set_id, scope, items })
  return {
    faq_set_id,
    scope,
    items,
    content_sha256,
    approval_id: 'seoapr_a',
    approval_kind: 'faq_set',
    approval_ref: faq_set_id,
    approval_sha256: content_sha256,
    ...overrides,
  }
}

function fakeDb(rows: Array<Record<string, unknown>>): Queryable {
  return {
    query: async <T extends QueryResultRow>(): Promise<QueryResult<T>> =>
      ({ rows: rows as T[], rowCount: rows.length, command: '', oid: 0, fields: [] }) as QueryResult<T>,
  }
}

describe('loadApprovedFaqSetsForBundle', () => {
  it('maps a verified approved row into a contract FaqSet', async () => {
    const out = await loadApprovedFaqSetsForBundle(fakeDb([approvedRow()]))
    expect(out).toHaveLength(1)
    expect(out[0]!.faq_set_id).toBe('faqset_a')
    expect(out[0]!.approval_id).toBe('seoapr_a')
    expect(out[0]!.items).toHaveLength(1)
  })

  it('fails when an approved row has no ledger join', async () => {
    await expect(
      loadApprovedFaqSetsForBundle(
        fakeDb([approvedRow({ approval_kind: null, approval_ref: null, approval_sha256: null })]),
      ),
    ).rejects.toBeInstanceOf(FaqBundleSourceError)
  })

  it('fails when the ledger content_ref points at another set', async () => {
    await expect(
      loadApprovedFaqSetsForBundle(fakeDb([approvedRow({ approval_ref: 'faqset_other' })])),
    ).rejects.toBeInstanceOf(FaqBundleSourceError)
  })

  it('fails when the ledger hash disagrees with the stored fingerprint', async () => {
    await expect(
      loadApprovedFaqSetsForBundle(
        fakeDb([approvedRow({ approval_sha256: 'f'.repeat(64) })]),
      ),
    ).rejects.toBeInstanceOf(FaqBundleSourceError)
  })

  it('fails when the actual content no longer hashes to the approved fingerprint', async () => {
    const mutated = [{ ...items[0]!, answer_raw: 'tampered after approval' }]
    await expect(
      loadApprovedFaqSetsForBundle(fakeDb([approvedRow({ items: mutated })])),
    ).rejects.toBeInstanceOf(FaqBundleSourceError)
  })

  it('fails when the approval_kind is wrong', async () => {
    await expect(
      loadApprovedFaqSetsForBundle(fakeDb([approvedRow({ approval_kind: 'post' })])),
    ).rejects.toBeInstanceOf(FaqBundleSourceError)
  })

  it('returns an empty array when there are no approved rows', async () => {
    expect(await loadApprovedFaqSetsForBundle(fakeDb([]))).toEqual([])
  })
})
