import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('review transaction attribution migration', () => {
  it('keeps historical rows not_attempted and enforces matched snapshot state', () => {
    const schema = readFileSync(resolve('src/server/db/schema/customerReviews.sql'), 'utf8')
    expect(schema).toContain("default 'not_attempted'")
    expect(schema).toContain("invoice_match_status in ('not_attempted', 'matched', 'unmatched')")
    expect(schema).toContain("invoice_match_status in ('not_attempted', 'unmatched')")
    expect(schema).toContain("invoice_match_status = 'matched' and matched_invoice_id is not null")
  })

  it('has a narrow idempotent forward migration and a complete destructive down path', () => {
    const forward = readFileSync(resolve('src/server/db/migrations/105_review_transaction_attribution.sql'), 'utf8')
    const down = readFileSync(resolve('src/server/db/migrations/105_review_transaction_attribution.down.sql'), 'utf8')
    expect(forward).not.toMatch(/\\i(?:r)?\s/)
    expect(forward).toContain('alter table review_submissions')
    expect(forward).toContain('add column if not exists invoice_match_status')
    expect(forward).not.toContain('insert into site_review_settings')
    for (const column of ['invoice_match_status', 'matched_invoice_id', 'matched_cashier_user_id', 'matched_at']) {
      expect(down).toContain(`drop column if exists ${column}`)
    }
  })
})
