import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  geocodeViaCensus,
  looksDefinitelyNonUS,
  parseCensusResponse,
  resetCensusRateLimiterForTest,
} from './census.js'

beforeEach(() => {
  resetCensusRateLimiterForTest()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('looksDefinitelyNonUS', () => {
  it('returns false for a normal US address', () => {
    expect(looksDefinitelyNonUS('123 main st brooklyn ny 11201')).toBe(false)
  })

  it('returns true when the string names a non-US country', () => {
    expect(looksDefinitelyNonUS('221b baker st london uk')).toBe(true)
    expect(looksDefinitelyNonUS('1 elm road toronto canada')).toBe(true)
  })

  it('returns true when there is no US state code and no 5-digit zip', () => {
    expect(looksDefinitelyNonUS('some place far away')).toBe(true)
  })

  it('returns false when a US state code is present even without a zip', () => {
    expect(looksDefinitelyNonUS('123 main st brooklyn ny')).toBe(false)
  })

  it('returns false when a 5-digit zip is present even without a state code', () => {
    expect(looksDefinitelyNonUS('somewhere 11201')).toBe(false)
  })
})

describe('parseCensusResponse', () => {
  const okPayload = {
    result: {
      addressMatches: [
        {
          coordinates: { x: -73.99, y: 40.7 },
          addressComponents: { city: 'BROOKLYN', state: 'NY', zip: '11201' },
          geographies: {
            Counties: [{ NAME: 'Kings County', BASENAME: 'Kings' }],
          },
        },
      ],
    },
  }

  it('extracts lat/lng/zip/city/state/county from a typical addressMatches[0]', () => {
    expect(parseCensusResponse(okPayload)).toEqual({
      latitude: 40.7,
      longitude: -73.99,
      zip5: '11201',
      city: 'BROOKLYN',
      county: 'Kings County',
      stateCode: 'NY',
      status: 'ok',
    })
  })

  it('falls back to BASENAME when Counties[0].NAME is absent', () => {
    const payload = JSON.parse(JSON.stringify(okPayload))
    payload.result.addressMatches[0].geographies.Counties[0].NAME = undefined
    expect(parseCensusResponse(payload).county).toBe('Kings')
  })

  it('coerces numeric coordinates supplied as strings', () => {
    const payload = JSON.parse(JSON.stringify(okPayload))
    payload.result.addressMatches[0].coordinates = { x: '-73.99', y: '40.7' }
    const out = parseCensusResponse(payload)
    expect(out.latitude).toBe(40.7)
    expect(out.longitude).toBe(-73.99)
    expect(out.status).toBe('ok')
  })

  it('returns "failed" when there are no addressMatches', () => {
    const out = parseCensusResponse({ result: { addressMatches: [] } })
    expect(out.status).toBe('failed')
    expect(out.latitude).toBeNull()
    expect(out.longitude).toBeNull()
  })

  it('returns "failed" when the payload is shaped weirdly', () => {
    expect(parseCensusResponse(null).status).toBe('failed')
    expect(parseCensusResponse({}).status).toBe('failed')
    expect(parseCensusResponse({ result: 'oops' }).status).toBe('failed')
  })

  it('returns "failed" when lat/lng are missing even though a match came back', () => {
    const payload = JSON.parse(JSON.stringify(okPayload))
    payload.result.addressMatches[0].coordinates = {}
    expect(parseCensusResponse(payload).status).toBe('failed')
  })

  it('drops a zip that has fewer than 5 digits', () => {
    const payload = JSON.parse(JSON.stringify(okPayload))
    payload.result.addressMatches[0].addressComponents.zip = '112'
    expect(parseCensusResponse(payload).zip5).toBeNull()
  })
})

describe('geocodeViaCensus', () => {
  it('returns "failed" on empty input without issuing a fetch', async () => {
    const fetchImpl = vi.fn()
    const out = await geocodeViaCensus('', { fetchImpl, skipRateLimit: true })
    expect(out.status).toBe('failed')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('returns "not_us" without fetching when the input looks non-US', async () => {
    const fetchImpl = vi.fn()
    const out = await geocodeViaCensus('221b baker st london uk', {
      fetchImpl,
      skipRateLimit: true,
    })
    expect(out.status).toBe('not_us')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('hits the Census geographies endpoint with benchmark + vintage + the address', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            result: {
              addressMatches: [
                {
                  coordinates: { x: -73.99, y: 40.7 },
                  addressComponents: { city: 'BROOKLYN', state: 'NY', zip: '11201' },
                  geographies: { Counties: [{ NAME: 'Kings County' }] },
                },
              ],
            },
          }),
        ),
    )
    const out = await geocodeViaCensus('123 main st brooklyn ny 11201', {
      fetchImpl,
      skipRateLimit: true,
    })
    expect(out).toEqual({
      latitude: 40.7,
      longitude: -73.99,
      zip5: '11201',
      city: 'BROOKLYN',
      county: 'Kings County',
      stateCode: 'NY',
      status: 'ok',
    })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const requestedUrl = fetchImpl.mock.calls[0]![0] as string
    expect(requestedUrl).toContain('geocoding.geo.census.gov')
    expect(requestedUrl).toContain('geographies/onelineaddress')
    expect(requestedUrl).toContain('benchmark=Public_AR_Current')
    expect(requestedUrl).toContain('vintage=Current_Current')
    expect(requestedUrl).toContain('address=')
  })

  it('returns "failed" on a non-2xx response (and does not throw)', async () => {
    const fetchImpl = vi.fn(async () => new Response('boom', { status: 503 }))
    const out = await geocodeViaCensus('123 main st brooklyn ny 11201', {
      fetchImpl,
      skipRateLimit: true,
    })
    expect(out.status).toBe('failed')
  })

  it('returns "failed" on a fetch-level network error (and does not throw)', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNRESET')
    })
    const out = await geocodeViaCensus('123 main st brooklyn ny 11201', {
      fetchImpl,
      skipRateLimit: true,
    })
    expect(out.status).toBe('failed')
  })

  it('returns "failed" on malformed JSON body', async () => {
    const fetchImpl = vi.fn(
      async () => new Response('definitely not json{{{', { status: 200 }),
    )
    const out = await geocodeViaCensus('123 main st brooklyn ny 11201', {
      fetchImpl,
      skipRateLimit: true,
    })
    expect(out.status).toBe('failed')
  })

  it('rate-limits to ~1 RPS across concurrent callers', async () => {
    vi.useFakeTimers()
    try {
      const okBody = JSON.stringify({
        result: {
          addressMatches: [
            {
              coordinates: { x: -73.99, y: 40.7 },
              addressComponents: { city: 'X', state: 'NY', zip: '11201' },
              geographies: { Counties: [{ NAME: 'Y County' }] },
            },
          ],
        },
      })
      const fetchImpl = vi.fn(async () => new Response(okBody, { status: 200 }))

      // Fire three calls back-to-back without skipRateLimit. The
      // first lands immediately; the next two each need ≥1s gaps.
      const p1 = geocodeViaCensus('123 main st brooklyn ny 11201', { fetchImpl })
      const p2 = geocodeViaCensus('456 main st brooklyn ny 11201', { fetchImpl })
      const p3 = geocodeViaCensus('789 main st brooklyn ny 11201', { fetchImpl })

      // Let the first call's microtasks settle so its fetch fires.
      await vi.advanceTimersByTimeAsync(0)
      expect(fetchImpl).toHaveBeenCalledTimes(1)

      // After 999ms total, second call still gated.
      await vi.advanceTimersByTimeAsync(999)
      expect(fetchImpl).toHaveBeenCalledTimes(1)

      // Cross the 1-second boundary: second call releases.
      await vi.advanceTimersByTimeAsync(2)
      expect(fetchImpl).toHaveBeenCalledTimes(2)

      // Another full second for the third call.
      await vi.advanceTimersByTimeAsync(1000)
      expect(fetchImpl).toHaveBeenCalledTimes(3)

      await Promise.all([p1, p2, p3])
    } finally {
      vi.useRealTimers()
    }
  })
})
