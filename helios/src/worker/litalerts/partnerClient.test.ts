import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    readFileSync: vi.fn(actual.readFileSync),
  }
})

import { readFileSync } from 'node:fs'

import { RetryableWorkerError } from '../runtime/errors.js'
import {
  listBrandsForState,
  listRetailerProducts,
  resetLitAlertsPartnerClientCachesForTest,
  tryLoadPartnerApiToken,
} from './partnerClient.js'

const readFileSyncMock = vi.mocked(readFileSync)

const ORIGINAL_TOKEN_ENV = process.env.LITALERTS_PARTNER_API_TOKEN

beforeEach(() => {
  process.env.LITALERTS_PARTNER_API_TOKEN = 'partner-token-test'
  resetLitAlertsPartnerClientCachesForTest()
})

afterEach(() => {
  if (ORIGINAL_TOKEN_ENV === undefined) {
    delete process.env.LITALERTS_PARTNER_API_TOKEN
  } else {
    process.env.LITALERTS_PARTNER_API_TOKEN = ORIGINAL_TOKEN_ENV
  }
  readFileSyncMock.mockReset()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('listBrandsForState', () => {
  it('unwraps the {data: [...]} envelope and parses comma-separated states', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          data: [
            { id: 42, name: 'Fernway', states: 'NY, NJ ,MA' },
            { id: 91, name: 'Ayrloom', states: 'NY' },
          ],
        }),
        { headers: { 'content-type': 'application/json' }, status: 200 },
      ),
    )
    vi.stubGlobal('fetch', fetchMock)

    const brands = await listBrandsForState('NY')

    expect(brands).toEqual([
      { id: 42, name: 'Fernway', states: ['NY', 'NJ', 'MA'] },
      { id: 91, name: 'Ayrloom', states: ['NY'] },
    ])
    const requestUrl = fetchMock.mock.calls[0]?.[0] as string
    expect(requestUrl).toBe('https://partnerapi.litalerts.com/v1/brands?state=NY')
    const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit
    expect((requestInit.headers as Record<string, string>).authorization).toBe('Bearer partner-token-test')
  })

  it('caches the brands response per state for 10 minutes', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({ data: [{ id: 1, name: 'Brand', states: 'NY' }] }),
        { headers: { 'content-type': 'application/json' }, status: 200 },
      ),
    )
    vi.stubGlobal('fetch', fetchMock)

    await listBrandsForState('NY')
    await listBrandsForState('NY')

    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('listRetailerProducts', () => {
  it('parses retailer product rows with their configs', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          data: [
            {
              id: 7001,
              name: 'Fernway Stylus Pod 0.5g',
              brand: 'Fernway',
              brandId: 42,
              retailerId: 1234,
              medicalURL: null,
              recreationalURL: 'https://example.com/stylus',
              category: 'Vaporizers',
              configs: [
                {
                  amount: 0.5,
                  units: 'g',
                  recreational: true,
                  medical: false,
                  normalPrice: 50,
                  salePrice: 45,
                  currentStock: 12,
                },
              ],
            },
          ],
        }),
        { headers: { 'content-type': 'application/json' }, status: 200 },
      ),
    )
    vi.stubGlobal('fetch', fetchMock)

    const products = await listRetailerProducts(1234, 'NY')

    expect(products).toHaveLength(1)
    expect(products[0]?.name).toBe('Fernway Stylus Pod 0.5g')
    expect(products[0]?.recreationalURL).toBe('https://example.com/stylus')
    expect(products[0]?.configs).toHaveLength(1)
    expect(products[0]?.configs[0]?.normalPrice).toBe(50)
    expect(products[0]?.configs[0]?.salePrice).toBe(45)
    expect(products[0]?.configs[0]?.currentStock).toBe(12)
    const requestUrl = fetchMock.mock.calls[0]?.[0] as string
    expect(requestUrl).toBe('https://partnerapi.litalerts.com/v1/retailers/1234/products?state=NY')
  })

  it('encodes a multi-brand filter as repeated brandIds params (not comma-joined)', async () => {
    // The partner API binds arrays as repeated query params; the comma-joined
    // form (`brandIds=42,77`) returns HTTP 400 for multi-id lists. Guard the
    // encoding so we never regress back to the broken form.
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ data: [] }), {
        headers: { 'content-type': 'application/json' },
        status: 200,
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    await listRetailerProducts(1234, { stateCode: 'NY', brandIds: [42, 77] })

    const requestUrl = fetchMock.mock.calls[0]?.[0] as string
    expect(requestUrl).toBe(
      'https://partnerapi.litalerts.com/v1/retailers/1234/products?state=NY&brandIds=42&brandIds=77',
    )
    expect(requestUrl).not.toContain('brandIds=42%2C77')
    expect(requestUrl).not.toContain('brandIds=42,77')
  })
})

describe('token loading', () => {
  it('throws RetryableWorkerError when no token is configured and no fallback file exists', async () => {
    delete process.env.LITALERTS_PARTNER_API_TOKEN

    // Force the file-fallback to be absent. tryLoadPartnerApiToken reads the
    // home-directory secret file; stub readFileSync to fail so we exercise the
    // "no token anywhere" path deterministically regardless of the host
    // machine's filesystem.
    readFileSyncMock.mockImplementation(() => {
      const error = new Error('ENOENT: no such file')
      ;(error as NodeJS.ErrnoException).code = 'ENOENT'
      throw error
    })

    expect(tryLoadPartnerApiToken()).toBeNull()

    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    await expect(listBrandsForState('NY')).rejects.toBeInstanceOf(RetryableWorkerError)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
