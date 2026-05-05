import { afterEach, describe, expect, it, vi } from 'vitest'

const env = {
  BEDROCK_MANTLE_BEARER_TOKEN: 'bedrock-token',
  DATABASE_URL: 'postgres://example.invalid/db',
  SWEED_API_URL: 'https://prime.sweedpos.com/api/',
  SWEED_AUTH_TOKEN: 'test-sweed-token',
}

describe('verifySweedSession', () => {
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
