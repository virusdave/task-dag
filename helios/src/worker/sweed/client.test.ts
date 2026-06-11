import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const env = {
  BEDROCK_MANTLE_BEARER_TOKEN: 'bedrock-token',
  DATABASE_URL: 'postgres://example.invalid/db',
  SWEED_API_URL: 'https://prime.sweedpos.com/api/',
  SWEED_AUTH_TOKEN: 'test-sweed-token',
}

// The pool-claim path now talks to Postgres; stub it out so the
// in-process verify path uses a fake "db-pasted" claim and never
// tries to reach example.invalid.
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
      rowId: 1,
      claimedBy: 'test-claim',
      initialDealerId: null,
      // Recently prolonged, so withSweedSession's daily keep-alive is
      // skipped and these tests keep asserting on the job's own RPCs.
      lastProlongedAt: new Date(),
    })),
    releaseClaimedSweedToken: vi.fn(async () => undefined),
    expireClaimedSweedToken: vi.fn(async () => undefined),
  }
})

describe('verifySweedSession', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.resetModules()
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = value
      }
    }
  })

  it('omits params for store.auth.initial.data.get', async () => {
    for (const [key, value] of Object.entries(env)) {
      process.env[key] = value
    }

    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        text: async () => JSON.stringify({ id: '1', result: { ok: true } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        text: async () => JSON.stringify({ id: '2', result: { user: { currentDealerId: 210248, currentDealerName: 'Freshly Baked NY' } } }),
      })

    vi.stubGlobal('fetch', fetchMock)

    const { verifySweedSession } = await import('./client.js')
    await verifySweedSession()

    const firstCall = fetchMock.mock.calls[0]
    expect(firstCall).toBeDefined()
    const [, init] = firstCall as [string, RequestInit]
    const body = JSON.parse(String(init.body)) as Record<string, unknown>
    expect(body.name).toBe('store.auth.initial.data.get')
    expect(body).not.toHaveProperty('params')
  })

  it('accepts wrapped store.product.get payloads during price verification', async () => {
    for (const [key, value] of Object.entries(env)) {
      process.env[key] = value
    }

    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        text: async () => JSON.stringify({ id: '1', result: { user: { currentDealerId: 210248, currentDealerName: 'Freshly Baked NY' } } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        text: async () => JSON.stringify({
          id: '2',
          result: {
            product: {
              id: '42177',
              price: 32,
              priceInfo: { actualPrice: 32 },
            },
          },
        }),
      })

    vi.stubGlobal('fetch', fetchMock)

    const { waitForProductPrice } = await import('./client.js')
    await expect(waitForProductPrice(42177, 32)).resolves.toMatchObject({
      product: { id: '42177' },
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})
