import { beforeEach, describe, expect, it, vi } from 'vitest'

const callSweedRpcRawMock = vi.hoisted(() => vi.fn())

vi.mock('../../worker/sweed/rpc.js', () => ({ callSweedRpcRaw: callSweedRpcRawMock }))
vi.mock('../../worker/sweed/session.js', () => ({
  withSweedSession: (run: () => Promise<unknown>) => run(),
}))
vi.mock('../config/env.js', () => ({
  getServerEnv: () => ({ sweedStateDealerId: 210248 }),
}))

import { fetchStateStaffDirectory, SweedComplianceUserSchema } from './fetchStateStaff.js'

beforeEach(() => {
  callSweedRpcRawMock.mockReset()
})

describe('SweedComplianceUserSchema', () => {
  it('requires Sweed to provide the authoritative blocked flag', () => {
    expect(() => SweedComplianceUserSchema.parse({ id: '17647', userStatus: 1 })).toThrow()
    expect(
      SweedComplianceUserSchema.parse({ id: '17647', blocked: false, userStatus: 1 }),
    ).toMatchObject({ blocked: false, userStatus: 1 })
  })

  it('rejects a truncated paginated response instead of advancing freshness', async () => {
    callSweedRpcRawMock
      .mockResolvedValueOnce({ user: { currentDealerId: 210248 } })
      .mockResolvedValueOnce({
        page: 1,
        pageSize: 200,
        totalCount: 2,
        data: [{ id: '17647', blocked: false, userStatus: 1 }],
      })
      .mockResolvedValueOnce({
        page: 2,
        pageSize: 200,
        totalCount: 2,
        data: [],
      })

    await expect(fetchStateStaffDirectory()).rejects.toThrow(
      'incomplete pagination: received 1 of 2',
    )
  })
})
