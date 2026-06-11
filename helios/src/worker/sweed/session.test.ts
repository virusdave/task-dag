import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const env: Record<string, string> = {
  BEDROCK_MANTLE_BEARER_TOKEN: 'bedrock-token',
  DATABASE_URL: 'postgres://example.invalid/db',
  SWEED_API_URL: 'https://prime.sweedpos.com/api/',
  SWEED_AUTH_TOKEN: 'test-sweed-token',
}

// Per-test override of the claim the mocked pool hands back, so each
// case can dial in `lastProlongedAt`.
let claimLastProlongedAt: Date | null = null

const prolongSpy = vi.fn(async () => undefined)
const releaseSpy = vi.fn(async () => undefined)

// Stub the Postgres-backed pool claim/release/prolong so withSweedSession
// runs entirely in-process and never reaches example.invalid for DB work.
vi.mock('./activeSessionToken.js', async () => {
  const actual = await vi.importActual<typeof import('./activeSessionToken.js')>(
    './activeSessionToken.js',
  )
  return {
    ...actual,
    claimSweedToken: vi.fn(async () => ({
      token: 'test-sweed-token',
      tokenPrefix: 'test-swe',
      source: 'db-pasted' as const,
      rowId: 7,
      claimedBy: 'test-claim',
      initialDealerId: null,
      lastProlongedAt: claimLastProlongedAt,
    })),
    prolongClaimedSweedToken: prolongSpy,
    releaseClaimedSweedToken: releaseSpy,
    expireClaimedSweedToken: vi.fn(async () => undefined),
  }
})

function dealerListOkResponse(): { ok: true; status: number; text: () => Promise<string> } {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ id: '1', result: { dealers: [] } }),
  }
}

describe('withSweedSession keep-alive (prolongs)', () => {
  beforeEach(() => {
    vi.resetModules()
    prolongSpy.mockClear()
    releaseSpy.mockClear()
    for (const [key, value] of Object.entries(env)) {
      process.env[key] = value
    }
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.resetModules()
  })

  it('issues store.auth.dealer.list and stamps the highwater mark when never prolonged', async () => {
    claimLastProlongedAt = null
    const fetchMock = vi.fn().mockResolvedValue(dealerListOkResponse())
    vi.stubGlobal('fetch', fetchMock)

    const { withSweedSession } = await import('./session.js')
    const result = await withSweedSession(async () => 'job-ran')

    expect(result).toBe('job-ran')
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    const body = JSON.parse(String(init.body)) as Record<string, unknown>
    expect(body.name).toBe('store.auth.dealer.list')
    expect(prolongSpy).toHaveBeenCalledTimes(1)
    expect(releaseSpy).toHaveBeenCalledTimes(1)
  })

  it('issues the keep-alive when the last prolong is older than 24h', async () => {
    claimLastProlongedAt = new Date(Date.now() - 25 * 60 * 60 * 1000)
    const fetchMock = vi.fn().mockResolvedValue(dealerListOkResponse())
    vi.stubGlobal('fetch', fetchMock)

    const { withSweedSession } = await import('./session.js')
    await withSweedSession(async () => undefined)

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    const body = JSON.parse(String(init.body)) as Record<string, unknown>
    expect(body.name).toBe('store.auth.dealer.list')
    expect(prolongSpy).toHaveBeenCalledTimes(1)
  })

  it('skips the keep-alive when the token was prolonged within 24h', async () => {
    claimLastProlongedAt = new Date(Date.now() - 60 * 60 * 1000)
    const fetchMock = vi.fn().mockResolvedValue(dealerListOkResponse())
    vi.stubGlobal('fetch', fetchMock)

    const { withSweedSession } = await import('./session.js')
    await withSweedSession(async () => undefined)

    expect(fetchMock).not.toHaveBeenCalled()
    expect(prolongSpy).not.toHaveBeenCalled()
    expect(releaseSpy).toHaveBeenCalledTimes(1)
  })
})
