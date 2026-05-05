import { describe, expect, it } from 'vitest'

import { ReviewPacketSchema } from './reviewPacketImport.js'

describe('ReviewPacketSchema', () => {
  it('normalizes legacy string validation issues into typed objects', () => {
    const packet = ReviewPacketSchema.parse({
      dealerId: 210248,
      dealerName: 'Freshly Baked NYC',
      generatedAt: '2026-04-10T00:00:00.000Z',
      rows: [
        {
          generatedAt: '2026-04-10T00:00:00.000Z',
          groupId: 42,
          groupName: 'Example Group',
          proposedDescription: 'A bright citrus profile with a smooth finish.',
          validationIssues: ['paragraph 1 word count out of range: 49'],
        },
      ],
      summary: {},
    })

    expect(packet.rows[0]?.validationIssues).toEqual([
      {
        code: 'imported-issue',
        detail: 'paragraph 1 word count out of range: 49',
        severity: 'warning',
      },
    ])
  })
})
