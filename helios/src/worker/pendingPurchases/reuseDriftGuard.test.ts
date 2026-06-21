import { describe, expect, it } from 'vitest'

import type { ReconciledReuseSnapshot } from './reconcilePendingPurchaseDrafts.js'
import {
  compareLiveReuse,
  detectReuseDrift,
  precheckReuseDrift,
  type LiveReuseProductFacts,
  type ParsedReuseSnapshot,
} from './reuseDriftGuard.js'

function snapshot(overrides: Partial<ReconciledReuseSnapshot> = {}): ReconciledReuseSnapshot {
  return {
    productId: 7001,
    productName: 'Untitled 2g AIO — Blue Dream',
    groupId: 5001,
    brand: 'Untitled',
    category: 'Vapes',
    subcategory: 'All In One / Disposable',
    groupName: 'Untitled 2g AIO',
    variantTab: '2g',
    strain: 'Blue Dream',
    size: '2g',
    packCount: 1,
    ...overrides,
  }
}

function live(overrides: Partial<LiveReuseProductFacts> = {}): LiveReuseProductFacts {
  return {
    productId: 7001,
    productName: 'Untitled 2g AIO — Blue Dream',
    groupId: 5001,
    brand: 'Untitled',
    category: 'Vapes',
    subcategory: 'All In One / Disposable',
    groupName: 'Untitled 2g AIO',
    variantTab: '2g',
    strain: 'Blue Dream',
    size: '2g',
    packCount: 1,
    ...overrides,
  }
}

describe('detectReuseDrift', () => {
  it('reports no drift when the live product matches the snapshot exactly', () => {
    expect(detectReuseDrift(snapshot(), live())).toEqual([])
  })

  it('ignores case- and whitespace-only differences on lane fields', () => {
    const drift = detectReuseDrift(
      snapshot(),
      live({
        productName: '  untitled   2g aio — blue dream ',
        brand: 'UNTITLED',
        category: 'vapes',
        subcategory: 'all in one / disposable',
        groupName: 'Untitled  2g   AIO',
        variantTab: '2G',
        strain: 'blue   dream',
      }),
    )
    expect(drift).toEqual([])
  })

  it('treats "3.5 g" and "3.5g" as the same size', () => {
    expect(detectReuseDrift(snapshot({ size: '3.5 g' }), live({ size: '3.5g' }))).toEqual([])
  })

  it('treats a null pack count as a single-pack (1) product', () => {
    expect(detectReuseDrift(snapshot({ packCount: 1 }), live({ packCount: null }))).toEqual([])
    expect(detectReuseDrift(snapshot({ packCount: null }), live({ packCount: 1 }))).toEqual([])
  })

  it('detects a product id change', () => {
    const drift = detectReuseDrift(snapshot(), live({ productId: 9999 }))
    expect(drift).toEqual(['product id (validated 7001, live 9999)'])
  })

  it('detects a group id change including null-aware transitions', () => {
    expect(detectReuseDrift(snapshot({ groupId: 5001 }), live({ groupId: 5002 }))).toEqual([
      'group id (validated 5001, live 5002)',
    ])
    expect(detectReuseDrift(snapshot({ groupId: 5001 }), live({ groupId: null }))).toEqual([
      'group id (validated 5001, live none)',
    ])
  })

  it('detects a genuine pack count change', () => {
    expect(detectReuseDrift(snapshot({ packCount: 1 }), live({ packCount: 3 }))).toEqual([
      'pack count (validated 1, live 3)',
    ])
  })

  it('detects each meaningful lane drift', () => {
    expect(detectReuseDrift(snapshot(), live({ productName: 'DEAD - Untitled 2g AIO' }))).toEqual([
      'product name (validated "Untitled 2g AIO — Blue Dream", live "DEAD - Untitled 2g AIO")',
    ])
    expect(detectReuseDrift(snapshot(), live({ brand: 'Other Brand' }))).toEqual([
      'brand (validated "Untitled", live "Other Brand")',
    ])
    expect(detectReuseDrift(snapshot(), live({ category: 'Flower' }))).toEqual([
      'category (validated "Vapes", live "Flower")',
    ])
    expect(detectReuseDrift(snapshot(), live({ subcategory: null }))).toEqual([
      'subcategory (validated "All In One / Disposable", live ∅)',
    ])
    expect(detectReuseDrift(snapshot(), live({ groupName: 'Different Group' }))).toEqual([
      'group name (validated "Untitled 2g AIO", live "Different Group")',
    ])
    expect(detectReuseDrift(snapshot(), live({ variantTab: '1g' }))).toEqual([
      'variant tab (validated "2g", live "1g")',
    ])
    expect(detectReuseDrift(snapshot(), live({ strain: 'OG Kush' }))).toEqual([
      'strain (validated "Blue Dream", live "OG Kush")',
    ])
    expect(detectReuseDrift(snapshot(), live({ size: '1g' }))).toEqual([
      'size (validated "2g", live "1g")',
    ])
  })

  it('reports every drifted lane at once', () => {
    const drift = detectReuseDrift(
      snapshot(),
      live({ productName: 'RETIRED - x', brand: 'Other', size: '1g', packCount: 5 }),
    )
    expect(drift).toHaveLength(4)
    expect(drift).toContain('pack count (validated 1, live 5)')
    expect(drift).toContain('product name (validated "Untitled 2g AIO — Blue Dream", live "RETIRED - x")')
    expect(drift).toContain('brand (validated "Untitled", live "Other")')
    expect(drift).toContain('size (validated "2g", live "1g")')
  })
})

describe('precheckReuseDrift', () => {
  const validSnapshot: ParsedReuseSnapshot = { kind: 'valid', snapshot: snapshot() }

  it('skips rows with no reuse (catalog-create)', () => {
    expect(
      precheckReuseDrift({
        rowId: 1,
        reuseProductId: null,
        reuseProductIdOverridePresent: false,
        snapshot: { kind: 'absent' },
      }),
    ).toEqual({ kind: 'skip' })
  })

  it('skips reviewer-forced overrides (the operator chose the product)', () => {
    expect(
      precheckReuseDrift({
        rowId: 1,
        reuseProductId: 7001,
        reuseProductIdOverridePresent: true,
        snapshot: validSnapshot,
      }),
    ).toEqual({ kind: 'skip' })
  })

  it('skips legacy generator reuse with no snapshot (pre-C8 window)', () => {
    expect(
      precheckReuseDrift({
        rowId: 1,
        reuseProductId: 7001,
        reuseProductIdOverridePresent: false,
        snapshot: { kind: 'absent' },
      }),
    ).toEqual({ kind: 'skip' })
  })

  it('blocks generator reuse with a malformed snapshot WITHOUT needing a live read', () => {
    const decision = precheckReuseDrift({
      rowId: 1,
      reuseProductId: 7001,
      reuseProductIdOverridePresent: false,
      snapshot: { kind: 'malformed', error: 'productId: Required' },
    })
    expect(decision.kind).toBe('block')
  })

  it('blocks when the snapshot product id disagrees with the row reuse id', () => {
    const decision = precheckReuseDrift({
      rowId: 1,
      reuseProductId: 8002,
      reuseProductIdOverridePresent: false,
      snapshot: validSnapshot,
    })
    expect(decision.kind).toBe('block')
  })

  it('requests a live comparison for a valid generator reuse', () => {
    const decision = precheckReuseDrift({
      rowId: 1,
      reuseProductId: 7001,
      reuseProductIdOverridePresent: false,
      snapshot: validSnapshot,
    })
    expect(decision.kind).toBe('compare-live')
    if (decision.kind === 'compare-live') {
      expect(decision.snapshot.productId).toBe(7001)
    }
  })
})

describe('compareLiveReuse', () => {
  it('blocks when the live product could not be loaded / is disabled (null facts)', () => {
    const decision = compareLiveReuse(1, 7001, snapshot(), null)
    expect(decision.kind).toBe('block')
    if (decision.kind === 'block') {
      expect(decision.reason).toContain('no longer resolves to a live, enabled product+group')
    }
  })

  it('blocks when the live product drifted', () => {
    const decision = compareLiveReuse(1, 7001, snapshot(), live({ brand: 'Rebranded' }))
    expect(decision.kind).toBe('block')
    if (decision.kind === 'block') {
      expect(decision.reason).toContain('drifted since validation')
    }
  })

  it('passes when the live product still matches', () => {
    expect(compareLiveReuse(1, 7001, snapshot(), live())).toEqual({ kind: 'pass' })
  })
})
