import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import type { LowInventoryResponse } from '../../../shared/contracts/index.js'
import { LowInventoryView, type LowInventoryViewState } from './LowInventoryView.js'

function response(overrides?: Partial<LowInventoryResponse>): LowInventoryResponse {
  return {
    data: {
      dealerId: 210705,
      snapshotObservedAt: '2026-07-10T14:30:00.000Z',
      threshold: 2,
      locationGroups: [
        {
          location: { kind: 'shelf', label: 'FLOWER-A-03' },
          skus: [
            {
              combinedAvailableQty: 2,
              packages: [
                {
                  availableQty: 1,
                  currentQty: 1,
                  holdQty: 0,
                  internalTrackCode: 'FLOWER-A-03',
                  inventoryItemId: 'inventory-1',
                  metrcTag: '1A400000000000000001',
                  observedAt: '2026-07-10T14:30:00.000Z',
                  productId: 101,
                  productName: 'A deliberately long product name that must wrap cleanly on a narrow phone screen',
                  stockLocation: 'FOR SALE - Main Floor',
                },
                {
                  availableQty: 0,
                  currentQty: 2,
                  holdQty: 1,
                  internalTrackCode: null,
                  inventoryItemId: 'inventory-item-with-a-long-identifier-that-must-wrap',
                  metrcTag: null,
                  observedAt: '2026-07-10T14:30:00.000Z',
                  productId: 101,
                  productName: null,
                  stockLocation: 'FOR SALE - Main Floor',
                },
              ],
              productIds: [101],
              productName: 'A deliberately long product name that must wrap cleanly on a narrow phone screen',
              productSku: 'VERY-LONG-SKU-THAT-MUST-WRAP-ON-MOBILE',
            },
          ],
        },
        {
          location: { kind: 'stock-room', label: 'FOR SALE - Vault Overflow With A Long Location Name' },
          skus: [
            {
              combinedAvailableQty: 2,
              packages: [{
                availableQty: 1,
                currentQty: null,
                holdQty: null,
                internalTrackCode: null,
                inventoryItemId: 'inventory-2',
                metrcTag: '   ',
                observedAt: '2026-07-10T14:30:00.000Z',
                productId: 101,
                productName: null,
                stockLocation: 'FOR SALE - Vault Overflow With A Long Location Name',
              }],
              productIds: [101],
              productName: 'A deliberately long product name that must wrap cleanly on a narrow phone screen',
              productSku: 'VERY-LONG-SKU-THAT-MUST-WRAP-ON-MOBILE',
            },
          ],
        },
      ],
    },
    freshness: { isStale: false, staleAfterMinutes: 15 },
    site: { dealerId: 210705, siteKey: 'midtown', siteLabel: 'Midtown' },
    ...overrides,
  }
}

function render(state: LowInventoryViewState): string {
  return renderToStaticMarkup(<LowInventoryView siteLabel="Midtown" state={state} onRetry={() => undefined} />)
}

describe('LowInventoryView', () => {
  it('renders location-first groups, long names, and every package without controls that write inventory', () => {
    const html = render({ kind: 'ready', response: response() })
    expect(html).toContain('FLOWER-A-03')
    expect(html).toContain('Stock room')
    expect(html).toContain('A deliberately long product name')
    expect(html).toContain('inventory-item-with-a-long-identifier')
    expect(html).toContain('inventory-2')
    expect(html).toContain('3 packages')
    expect(html).toContain('1 SKU')
    expect(html).toContain('at this location')
    expect(html.match(/<small>2 site-wide<\/small>/g)).toHaveLength(2)
    expect(html).not.toContain('<input')
    expect(html).not.toContain('<form')
  })

  it.each([
    [{ kind: 'loading' } as const, 'Loading Midtown inventory'],
    [{ kind: 'error', message: 'Request failed safely.' } as const, 'Request failed safely.'],
  ])('renders the %s state accessibly', (state, expected) => {
    const html = render(state)
    expect(html).toContain(expected)
    expect(html).toMatch(/role="(status|alert)"/)
  })

  it('renders a stale warning with the snapshot time in New York', () => {
    const stale = response({ freshness: { isStale: true, staleAfterMinutes: 15 } })
    const html = render({ kind: 'ready', response: stale })
    expect(html).toContain('Stock snapshot is stale')
    expect(html).toContain('2026-07-10 10:30 New York time')
    expect(html).toContain('Do not use this list for a floor check')
  })

  it('renders an honest empty state', () => {
    const empty = response({ data: { ...response().data, locationGroups: [] } })
    const html = render({ kind: 'ready', response: empty })
    expect(html).toContain('No low-inventory items')
    expect(html).toContain('between 1 and 2 available')
  })
})
