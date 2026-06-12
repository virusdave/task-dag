import { describe, expect, it } from 'vitest'

import {
  dedupeByRowKey,
  ga4RowKey,
  gscRowKey,
  newImportBatchId,
  normalizeUrl,
  parseCsv,
  parseGa4Csv,
  parseGoogleDate,
  parseGscCsv,
} from './metricsImport.js'

describe('parseCsv', () => {
  it('parses simple rows and a trailing newline', () => {
    expect(parseCsv('a,b,c\n1,2,3\n')).toEqual([
      ['a', 'b', 'c'],
      ['1', '2', '3'],
    ])
  })

  it('handles quoted fields with embedded commas, quotes and CRLF', () => {
    const text = 'name,note\r\n"Smith, John","says ""hi"""\r\n'
    expect(parseCsv(text)).toEqual([
      ['name', 'note'],
      ['Smith, John', 'says "hi"'],
    ])
  })

  it('handles a quoted field containing a newline', () => {
    expect(parseCsv('a,b\n"line1\nline2",x\n')).toEqual([
      ['a', 'b'],
      ['line1\nline2', 'x'],
    ])
  })

  it('strips a leading UTF-8 BOM', () => {
    expect(parseCsv('\ufeffa,b\n1,2')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ])
  })
})

describe('parseGoogleDate', () => {
  it('accepts ISO and compact forms', () => {
    expect(parseGoogleDate('2026-06-01')).toBe('2026-06-01')
    expect(parseGoogleDate('20260601')).toBe('2026-06-01')
    expect(parseGoogleDate('  2026-06-01 ')).toBe('2026-06-01')
  })

  it('rejects junk and impossible dates', () => {
    expect(parseGoogleDate('Totals')).toBeNull()
    expect(parseGoogleDate('2026-13-01')).toBeNull()
    expect(parseGoogleDate('2026-02-30')).toBeNull()
    expect(parseGoogleDate('')).toBeNull()
  })
})

describe('normalizeUrl', () => {
  it('lowercases scheme + host, strips fragment, keeps path + query', () => {
    expect(normalizeUrl('HTTPS://FreshlyBaked.NYC/Whats-New/x?a=1#frag')).toBe(
      'https://freshlybaked.nyc/Whats-New/x?a=1',
    )
  })

  it('resolves a path-only value against baseUrl (GA4 exports)', () => {
    expect(normalizeUrl('/sites/all/whats-new/x', { baseUrl: 'https://freshlybaked.nyc' })).toBe(
      'https://freshlybaked.nyc/sites/all/whats-new/x',
    )
  })

  it('returns null for a path-only value without baseUrl, or blank', () => {
    expect(normalizeUrl('/foo')).toBeNull()
    expect(normalizeUrl('   ')).toBeNull()
  })
})

describe('row keys', () => {
  it('gsc row key is stable for identical dimensions and independent of metrics', () => {
    const dims = {
      source: 'gsc' as const,
      property: 'sc-domain:freshlybaked.nyc',
      source_date: '2026-06-01',
      search_type: 'web',
      device: 'all',
      country: 'all',
      query: 'weed nyc',
      page_url: 'https://freshlybaked.nyc/x',
    }
    expect(gscRowKey(dims)).toBe(gscRowKey(dims))
    expect(gscRowKey(dims)).toMatch(/^[0-9a-f]{64}$/)
    expect(gscRowKey({ ...dims, query: 'other' })).not.toBe(gscRowKey(dims))
  })

  it('ga4 row key differs by traffic scope', () => {
    const base = {
      source: 'ga4' as const,
      property: 'properties/1',
      source_date: '2026-06-01',
      traffic_scope: 'organic_search',
      page_url: 'https://freshlybaked.nyc/x',
    }
    expect(ga4RowKey(base)).not.toBe(ga4RowKey({ ...base, traffic_scope: 'all' }))
  })
})

describe('parseGscCsv', () => {
  const opts = { property: 'sc-domain:freshlybaked.nyc', site: 'all' }

  it('parses valid rows, derives nothing it should not, and tracks date range', () => {
    const csv = [
      'Date,Query,Page,Clicks,Impressions,CTR,Position',
      '2026-06-01,weed nyc,https://freshlybaked.nyc/a,5,100,5%,3.2',
      '2026-06-02,gummies,https://freshlybaked.nyc/b,"1,200","10,000",12%,1.5',
    ].join('\n')
    const res = parseGscCsv(csv, opts)
    expect(res.rowsSeen).toBe(2)
    expect(res.rowsRejected).toBe(0)
    expect(res.rows).toHaveLength(2)
    expect(res.exportStartDate).toBe('2026-06-01')
    expect(res.exportEndDate).toBe('2026-06-02')
    expect(res.rows[1]!.clicks).toBe(1200)
    expect(res.rows[1]!.impressions).toBe(10000)
    expect(res.rows[0]!.bucket_date_ny).toBe('2026-06-01')
    expect(res.rows[0]!.search_type).toBe('web')
  })

  it('re-import of identical dimensions yields identical row_keys (idempotent)', () => {
    const csv =
      'Date,Query,Page,Clicks,Impressions,Position\n2026-06-01,x,https://freshlybaked.nyc/a,1,2,3'
    const a = parseGscCsv(csv, opts).rows[0]!
    const b = parseGscCsv(
      'Date,Query,Page,Clicks,Impressions,Position\n2026-06-01,x,https://freshlybaked.nyc/a,9,99,1',
      opts,
    ).rows[0]!
    expect(a.row_key).toBe(b.row_key) // same key despite different metrics
  })

  it('rejects malformed rows (bad date, bad url, clicks>impressions) without throwing', () => {
    const csv = [
      'Date,Query,Page,Clicks,Impressions,Position',
      'Totals,x,https://freshlybaked.nyc/a,1,2,3',
      '2026-06-01,x,not-a-url,1,2,3',
      '2026-06-01,x,https://freshlybaked.nyc/a,5,2,3',
      '2026-06-01,ok,https://freshlybaked.nyc/a,1,2,3',
    ].join('\n')
    const res = parseGscCsv(csv, opts)
    expect(res.rows).toHaveLength(1)
    expect(res.rowsRejected).toBe(3)
  })

  it('throws when a required column is missing', () => {
    expect(() => parseGscCsv('Date,Query,Clicks\n2026-06-01,x,1', opts)).toThrow(/page/)
  })

  it('honors search_type/device/country overrides in the key dimensions', () => {
    const csv = 'Date,Query,Page,Clicks,Impressions,Position\n2026-06-01,x,https://a.b/c,1,2,3'
    const web = parseGscCsv(csv, opts).rows[0]!
    const img = parseGscCsv(csv, { ...opts, searchType: 'image' }).rows[0]!
    expect(web.row_key).not.toBe(img.row_key)
    expect(img.search_type).toBe('image')
  })
})

describe('parseGa4Csv', () => {
  const opts = { property: 'properties/1', site: 'all', baseUrl: 'https://freshlybaked.nyc' }

  it('skips comment/preamble + totals rows and parses path-only pages', () => {
    const csv = [
      '# ----------------------------------------',
      '# Pages and screens',
      '# Start: 20260601',
      '',
      'Page path and screen class,Sessions,Engaged sessions,Views,Date',
      '/sites/all/whats-new/a,10,7,30,20260601',
      '/sites/all/whats-new/b,4,4,8,2026-06-02',
      'Totals,14,11,38,',
    ].join('\n')
    const res = parseGa4Csv(csv, opts)
    expect(res.rows).toHaveLength(2)
    expect(res.rows[0]!.page_url).toBe('https://freshlybaked.nyc/sites/all/whats-new/a')
    expect(res.rows[0]!.sessions).toBe(10)
    expect(res.rows[0]!.engaged_sessions).toBe(7)
    expect(res.rows[0]!.screen_page_views).toBe(30)
    expect(res.rows[0]!.traffic_scope).toBe('organic_search')
    expect(res.exportStartDate).toBe('2026-06-01')
    expect(res.exportEndDate).toBe('2026-06-02')
  })

  it('defaults omitted optional metrics to 0', () => {
    const csv = 'Date,Page path,Sessions\n20260601,/x,5'
    const res = parseGa4Csv(csv, opts)
    expect(res.rows[0]!.active_users).toBe(0)
    expect(res.rows[0]!.key_events).toBe(0)
  })

  it('rejects engaged_sessions > sessions', () => {
    const csv = 'Date,Page path,Sessions,Engaged sessions\n20260601,/x,5,9'
    const res = parseGa4Csv(csv, opts)
    expect(res.rows).toHaveLength(0)
    expect(res.rowsRejected).toBe(1)
  })

  it('throws when sessions column is absent', () => {
    expect(() => parseGa4Csv('Date,Page path\n20260601,/x', opts)).toThrow(/sessions/)
  })
})

describe('dedupeByRowKey', () => {
  it('keeps the last occurrence of a duplicate key and counts collapses', () => {
    const rows = [
      { row_key: 'a', v: 1 },
      { row_key: 'b', v: 2 },
      { row_key: 'a', v: 3 },
    ]
    const out = dedupeByRowKey(rows)
    expect(out.duplicatesCollapsed).toBe(1)
    expect(out.rows).toHaveLength(2)
    expect(out.rows.find((r) => r.row_key === 'a')!.v).toBe(3)
  })
})

describe('newImportBatchId', () => {
  it('mints a sortable, well-formed id', () => {
    const id = newImportBatchId(new Date('2026-06-01T08:09:10Z'))
    expect(id).toMatch(/^seoimp_2026-06-01_080910_[0-9a-f]{6}$/)
  })
})
