import { describe, expect, it, vi } from 'vitest'

import type { TradeSampleZeroItem } from '../../shared/contracts/index.js'
import { applyTradeSampleZero, previewTradeSampleZero, tradeSampleZeroDigest, TradeSampleZeroBusyError, TradeSampleZeroStaleError, type TradeSampleZeroDeps } from './tradeSampleZeroService.js'

const dealerId = 210249
const item: TradeSampleZeroItem = { currentQty: 3.5, externalTrackCode: 'TAG-1', inventoryItemId: '44', packageLabel: null, productId: 9, productName: 'Sample Flower', productSku: 'SF' }
const groupedItem = (overrides: Record<string, unknown> = {}) => ({ id: '44', currentQty: 3.5, externalTrackCode: 'TAG-1', isTradeSample: true, ...overrides })
const row = (items = [groupedItem()], productOverrides: Record<string, unknown> = {}) => ({ product: { id: 9, name: 'Sample Flower', sku: 'SF', ...productOverrides }, items })
const page = (data: unknown[], totalCount = data.length) => ({ data, totalCount })
const detail = (overrides: Record<string, unknown> = {}) => ({ id: '44', currentQty: 3.5, externalTrackCode: 'TAG-1', isTradeSample: true, ...overrides })

function deps(responses: unknown[], overrides: Partial<TradeSampleZeroDeps> = {}): TradeSampleZeroDeps {
  return {
    audit: vi.fn().mockResolvedValue(1),
    db: { query: vi.fn() } as TradeSampleZeroDeps['db'],
    rpc: vi.fn().mockImplementation(() => Promise.resolve(responses.shift())),
    withLock: async (_dealerId, run) => run(),
    ...overrides,
  } as TradeSampleZeroDeps
}
const input = (items = [item]) => ({ actorUserId: 7, confirmation: 'ZERO TRADE SAMPLES', digest: tradeSampleZeroDigest(dealerId, items), items, requestId: 'req', siteDealerId: dealerId })

describe('trade sample zero workflow', () => {
  it('enumerates the exact full grouped feed and discovers candidates without cache', async () => {
    const first = Array.from({ length: 100 }, (_, n) => row(
      n === 0 ? [groupedItem(), groupedItem({ id: 'sold', currentQty: null, isTradeSample: false })] : [],
      { id: n === 0 ? 9 : n + 100 },
    ))
    const d = deps([page(first, 101), page([row([], { id: 101 })], 101)])
    const preview = await previewTradeSampleZero(dealerId, d)
    expect(preview.items).toEqual([item])
    expect(d.db.query).not.toHaveBeenCalled()
    expect(d.rpc).toHaveBeenNthCalledWith(1, dealerId, 'store.inventory.item.list.grouped', { page: 1, pageSize: 100, isOnStock: false })
    expect(d.rpc).toHaveBeenNthCalledWith(2, dealerId, 'store.inventory.item.list.grouped', { page: 2, pageSize: 100, isOnStock: false })
  })

  it('fails closed on incomplete pagination and conflicting duplicate IDs', async () => {
    await expect(previewTradeSampleZero(dealerId, deps([page([row()], 2)]))).rejects.toThrow('incomplete pagination')
    await expect(previewTradeSampleZero(dealerId, deps([page([row(), row([groupedItem({ currentQty: 4 })])], 2)]))).rejects.toThrow('Conflicting duplicate')
  })

  it.each([null, '', false])('fails closed on malformed grouped trade-sample quantity %j', async (currentQty) => {
    await expect(previewTradeSampleZero(
      dealerId,
      deps([page([row([groupedItem({ currentQty })])])]),
    )).rejects.toThrow()
  })

  it('fails whole-set drift before writes', async () => {
    const d = deps([page([row([groupedItem({ currentQty: 2 })])])])
    await expect(applyTradeSampleZero(input(), d)).rejects.toBeInstanceOf(TradeSampleZeroStaleError)
    expect(d.audit).not.toHaveBeenCalled()
  })

  it('preserves the exact adjust payload and requires exact post-read zero', async () => {
    const d = deps([page([row()]), detail(), {}, detail({ currentQty: 0 })])
    const result = await applyTradeSampleZero(input(), d)
    expect(d.rpc).toHaveBeenNthCalledWith(3, dealerId, 'store.inventory.item.adjust', { reasonId: 20, integrationReasonId: 197, note: 'sample use', items: [{ qty: -3.5, id: '44', externalTrackCode: 'TAG-1' }], isInternal: false })
    expect(result.counts).toEqual({
      completed: 1,
      failedUnknown: 0,
      notAppliedStale: 0,
      notAppliedAuditFailure: 0,
    })
  })

  it.each([
    detail({ currentQty: -1 }),
    { id: '44', externalTrackCode: 'TAG-1', isTradeSample: true },
    detail({ currentQty: null }),
    detail({ currentQty: '' }),
    detail({ currentQty: false }),
    detail({ externalTrackCode: 'WRONG', currentQty: 0 }),
  ])('marks invalid strict post-read as unknown', async (postRead) => {
    const d = deps([page([row()]), detail(), {}, postRead])
    expect((await applyTradeSampleZero(input(), d)).outcomes[0]?.status).toBe('failed_unknown')
  })

  it('late drift stops this and every remaining write', async () => {
    const second = { ...item, inventoryItemId: '45', externalTrackCode: 'TAG-2' }
    const d = deps([page([row([groupedItem(), groupedItem({ id: '45', externalTrackCode: 'TAG-2' })])]), detail({ currentQty: 2 })])
    const result = await applyTradeSampleZero(input([item, second]), d)
    expect(result.counts.notAppliedStale).toBe(2)
    expect(vi.mocked(d.rpc).mock.calls.filter((call) => call[1] === 'store.inventory.item.adjust')).toHaveLength(0)
  })

  it('attempted audit failure prevents the write and returns durable outcomes', async () => {
    const d = deps([page([row()]), detail()], { audit: vi.fn().mockRejectedValue(new Error('db down')) as TradeSampleZeroDeps['audit'] })
    const result = await applyTradeSampleZero(input(), d)
    expect(result.outcomes[0]?.status).toBe('not_applied_audit_failure')
    expect(vi.mocked(d.rpc).mock.calls.some((call) => call[1] === 'store.inventory.item.adjust')).toBe(false)
  })

  it('preserves earlier success when a later attempted audit fails', async () => {
    const second = { ...item, inventoryItemId: '45', externalTrackCode: 'TAG-2' }
    const audit = vi.fn().mockResolvedValueOnce(1).mockResolvedValueOnce(1).mockRejectedValueOnce(new Error('db down'))
    const d = deps([
      page([row([groupedItem(), groupedItem({ id: '45', externalTrackCode: 'TAG-2' })])]),
      detail(), {}, detail({ currentQty: 0 }),
      detail({ id: '45', externalTrackCode: 'TAG-2' }),
    ], { audit: audit as TradeSampleZeroDeps['audit'] })
    const result = await applyTradeSampleZero(input([item, second]), d)
    expect(result.outcomes.map((outcome) => outcome.status)).toEqual([
      'completed',
      'not_applied_audit_failure',
    ])
    expect(vi.mocked(d.rpc).mock.calls.filter((call) => call[1] === 'store.inventory.item.adjust')).toHaveLength(1)
  })

  it('terminal audit failure does not retry mutation or suppress later outcomes', async () => {
    const second = { ...item, inventoryItemId: '45', externalTrackCode: 'TAG-2' }
    const audit = vi.fn().mockResolvedValueOnce(1).mockRejectedValueOnce(new Error('terminal')).mockResolvedValue(1)
    const d = deps([page([row([groupedItem(), groupedItem({ id: '45', externalTrackCode: 'TAG-2' })])]), detail(), {}, detail({ currentQty: 0 }),
      detail({ id: '45', externalTrackCode: 'TAG-2' }), {}, detail({ id: '45', externalTrackCode: 'TAG-2', currentQty: 0 })], { audit: audit as TradeSampleZeroDeps['audit'] })
    const result = await applyTradeSampleZero(input([item, second]), d)
    expect(result.outcomes.map((x) => x.status)).toEqual(['failed_unknown', 'completed'])
    expect(vi.mocked(d.rpc).mock.calls.filter((call) => call[1] === 'store.inventory.item.adjust')).toHaveLength(2)
  })

  it('generic injected lock allows only one concurrent apply to enter RPC', async () => {
    let locked = false
    const withLock: TradeSampleZeroDeps['withLock'] = async (_id, run) => {
      if (locked) throw new TradeSampleZeroBusyError()
      locked = true
      try { return await run() } finally { locked = false }
    }
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const rpc = vi.fn().mockImplementation(async (_id, method) => { if (method === 'store.inventory.item.list.grouped') await gate; return page([]) })
    const d = deps([], { rpc: rpc as TradeSampleZeroDeps['rpc'], withLock })
    const emptyInput = input([])
    const first = applyTradeSampleZero(emptyInput, d)
    await Promise.resolve()
    await expect(applyTradeSampleZero(emptyInput, d)).rejects.toBeInstanceOf(TradeSampleZeroBusyError)
    release()
    await first
    expect(rpc).toHaveBeenCalledOnce()
  })
})
