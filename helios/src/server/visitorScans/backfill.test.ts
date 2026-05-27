import { describe, expect, it } from 'vitest'

import {
  parseBackfillFile,
  reshapeFlatRowToData,
  parseCsv,
} from './backfill.js'
import { VeriScanDataSchema, envelopeToRowInput } from './envelope.js'

const SAMPLE_HASH = '11111111-2222-3333-4444-555555555555'

describe('parseBackfillFile - json-array', () => {
  it('parses a JSON array of flat objects', () => {
    const buf = Buffer.from(JSON.stringify([{ HashId: SAMPLE_HASH, FirstName: 'Ada' }]))
    const rows = parseBackfillFile(buf, 'json-array')
    expect(rows).toEqual([{ HashId: SAMPLE_HASH, FirstName: 'Ada' }])
  })

  it('rejects non-array top-level JSON', () => {
    const buf = Buffer.from(JSON.stringify({ HashId: SAMPLE_HASH }))
    expect(() => parseBackfillFile(buf, 'json-array')).toThrow(/array/)
  })
})

describe('parseBackfillFile - ndjson', () => {
  it('parses one JSON object per line, ignoring blank lines', () => {
    const buf = Buffer.from(
      `{"HashId":"${SAMPLE_HASH}","FirstName":"Ada"}\n\n{"HashId":"${SAMPLE_HASH}","FirstName":"Bo"}\n`,
    )
    const rows = parseBackfillFile(buf, 'ndjson')
    expect(rows).toHaveLength(2)
    expect(rows[1].FirstName).toBe('Bo')
  })
})

describe('parseCsv', () => {
  it('handles header + quoted commas + escaped quotes + CRLF', () => {
    const text = `HashId,FirstName,Address\r\n"${SAMPLE_HASH}","Ada","123 Main St., Apt ""4B"""\r\n`
    const rows = parseCsv(text)
    expect(rows).toEqual([{ HashId: SAMPLE_HASH, FirstName: 'Ada', Address: '123 Main St., Apt "4B"' }])
  })

  it('returns an empty array for an empty input', () => {
    expect(parseCsv('')).toEqual([])
  })
})

describe('reshapeFlatRowToData', () => {
  it('canonicalises lowercase / snake_case / kebab-case keys to PascalCase', () => {
    const out = reshapeFlatRowToData({
      hash_id: SAMPLE_HASH,
      'first-name': 'Ada',
      LastName: 'Lovelace',
      State: 'NY',
      postalcode: '10001',
    })
    expect(out).toEqual({
      HashId: SAMPLE_HASH,
      FirstName: 'Ada',
      LastName: 'Lovelace',
      State: 'NY',
      PostalCode: '10001',
    })
  })

  it('preserves unknown keys verbatim so raw_envelope is lossless', () => {
    const out = reshapeFlatRowToData({ HashId: SAMPLE_HASH, X_Op_Note: 'manual import' })
    expect(out.X_Op_Note).toBe('manual import')
  })

  it('splits AttachmentLinks string cells back into an array', () => {
    const out = reshapeFlatRowToData({
      HashId: SAMPLE_HASH,
      AttachmentLinks: 'https://a/x.png|https://b/y.png',
    })
    expect(out.AttachmentLinks).toEqual(['https://a/x.png', 'https://b/y.png'])
  })

  it('treats empty AttachmentLinks as null', () => {
    const out = reshapeFlatRowToData({ HashId: SAMPLE_HASH, AttachmentLinks: '' })
    expect(out.AttachmentLinks).toBeNull()
  })
})

describe('envelope round-trip', () => {
  it('produces equal row inputs for the same Data via webhook vs backfill paths', () => {
    const data = VeriScanDataSchema.parse({
      HashId: SAMPLE_HASH,
      FirstName: 'Ada',
      LastName: 'Lovelace',
      State: 'NY',
      PostalCode: '10001',
      Latitude: '40.7128',
      Longitude: '-74.0060',
      DocumentIsValid: 'true',
    })
    const envelope = {
      Type: 'CreateCard',
      EventId: 12345,
      WebHookId: 0,
      Created: '2026-05-27T00:00:00Z',
      Sent: '2026-05-27T00:00:00Z',
      Data: data,
    }
    const webhook = envelopeToRowInput({
      envelope,
      ingestSource: 'webhook',
      siteSlug: 'bx',
      provider: 'veriscan',
      rawEnvelope: envelope,
    })
    const backfill = envelopeToRowInput({
      envelope,
      ingestSource: 'backfill',
      siteSlug: 'bx',
      provider: 'veriscan',
      rawEnvelope: envelope,
    })
    // The two diverge only in ingestSource — every other column is
    // derived from the (identical) envelope.
    expect({ ...webhook, ingestSource: 'X' }).toEqual({ ...backfill, ingestSource: 'X' })
    expect(webhook.documentIsValid).toBe(true)
    expect(webhook.latitude).toBeCloseTo(40.7128, 4)
  })
})
