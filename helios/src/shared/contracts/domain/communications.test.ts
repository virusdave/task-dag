import { describe, expect, it } from 'vitest'

import {
  computePolicyReplacementItemIds,
  normalizePolicyReplacementItems,
  PolicyReplacementPacketSchema,
} from './communications.js'

const fixturePacket = PolicyReplacementPacketSchema.parse({
  packetId: 'asset-policy-limited-replacement-plan-2026-05-05_110134',
  generatedAt: '2026-05-05T11:01:34Z',
  visualReplacementPlans: [{}, {}, {}],
  llmCopy: {
    headlines: Array.from({ length: 4 }, () => ({})),
    longHeadlines: [{}, {}],
    descriptions: [{}],
    templateFamilies: [{}, {}, {}],
  },
  textReplacementMappings: [
    { mappingId: 'text-map-1' },
    { mappingId: 'text-map-2' },
  ],
})

describe('computePolicyReplacementItemIds', () => {
  it('mirrors the Python allowed_item_ids enumeration', () => {
    const ids = computePolicyReplacementItemIds(fixturePacket)
    expect(ids.size).toBe(3 + 4 + 2 + 1 + 3 + 2)
    expect(ids.has('visual-1')).toBe(true)
    expect(ids.has('visual-3')).toBe(true)
    expect(ids.has('headline-4')).toBe(true)
    expect(ids.has('long-headline-2')).toBe(true)
    expect(ids.has('description-1')).toBe(true)
    expect(ids.has('template-family-3')).toBe(true)
    expect(ids.has('text-map-1')).toBe(true)
    expect(ids.has('text-map-2')).toBe(true)
    expect(ids.has('text-map-3')).toBe(false)
    expect(ids.has('headline-5')).toBe(false)
  })
})

describe('normalizePolicyReplacementItems', () => {
  const allowedIds = computePolicyReplacementItemIds(fixturePacket)

  it('drops unknown ids, unknown decisions, and oversize fields', () => {
    const normalized = normalizePolicyReplacementItems(
      {
        'headline-1': { decision: 'accepted', fields: { text: 'ok', note: 'safe' } },
        'headline-99': { decision: 'accepted', fields: {} },
        'visual-1': { decision: 'reviewed-bogus', fields: { sourceId: 'anchor-7' } },
        'text-map-1': {
          decision: 'rejected',
          fields: { replacementCategory: 'price', text: 'x'.repeat(2000) },
        },
        'text-map-2': { decision: 'unreviewed', fields: {} },
        'description-1': { decision: 'hold', fields: { replacementCategory: 'totally-bogus' } },
      },
      allowedIds,
    )

    expect(Object.keys(normalized).sort()).toEqual([
      'description-1',
      'headline-1',
      'text-map-1',
      'visual-1',
    ])
    expect(normalized['headline-1']).toEqual({
      decision: 'accepted',
      fields: { text: 'ok', note: 'safe' },
    })
    expect(normalized['visual-1']).toEqual({
      decision: 'unreviewed',
      fields: { sourceId: 'anchor-7' },
    })
    expect(normalized['text-map-1'].decision).toBe('rejected')
    expect(normalized['text-map-1'].fields.text?.length).toBe(1000)
    expect(normalized['text-map-1'].fields.replacementCategory).toBe('price')
    expect(normalized['description-1']).toEqual({ decision: 'hold', fields: {} })
  })

  it('drops pure unreviewed entries with no fields', () => {
    const normalized = normalizePolicyReplacementItems(
      {
        'headline-1': { decision: 'unreviewed', fields: {} },
        'text-map-2': { decision: 'unreviewed' },
      },
      allowedIds,
    )
    expect(normalized).toEqual({})
  })

  it('returns an empty object for non-object input', () => {
    expect(normalizePolicyReplacementItems(null, allowedIds)).toEqual({})
    expect(normalizePolicyReplacementItems('nope', allowedIds)).toEqual({})
    expect(normalizePolicyReplacementItems([1, 2, 3], allowedIds)).toEqual({})
  })
})
