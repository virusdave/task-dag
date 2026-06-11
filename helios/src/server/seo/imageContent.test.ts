import { describe, expect, it } from 'vitest'

import {
  IMAGE_ASSET_ID_RE,
  checkImageAssetApprovable,
  findImageRawOnlyLeaks,
  imageAssetCanonicalPayload,
  imageAssetContentSha256,
  newImageAssetId,
  type ImageAssetContentInput,
} from './imageContent.js'

const base: ImageAssetContentInput = {
  asset_id: 'img_2026-06-11_120000_abcdef',
  asset_sha256: 'a'.repeat(64),
  role: 'hero',
  media_type: 'image/webp',
  width: 1200,
  height: 630,
  alt_text: 'A rooftop garden in Brooklyn at sunset.',
}

describe('newImageAssetId', () => {
  it('mints a sortable, well-formed id', () => {
    const id = newImageAssetId(new Date('2026-06-11T12:00:00Z'))
    expect(id).toMatch(IMAGE_ASSET_ID_RE)
    expect(id.startsWith('img_2026-06-11_120000_')).toBe(true)
  })

  it('mints distinct ids for the same instant (random suffix)', () => {
    const now = new Date('2026-06-11T12:00:00Z')
    expect(newImageAssetId(now)).not.toBe(newImageAssetId(now))
  })
})

describe('imageAssetContentSha256', () => {
  it('is a 64-char hex digest', () => {
    expect(imageAssetContentSha256(base)).toMatch(/^[0-9a-f]{64}$/)
  })

  it('is stable regardless of input key order', () => {
    const reordered: ImageAssetContentInput = {
      alt_text: base.alt_text,
      height: base.height,
      width: base.width,
      media_type: base.media_type,
      role: base.role,
      asset_sha256: base.asset_sha256,
      asset_id: base.asset_id,
    }
    expect(imageAssetContentSha256(reordered)).toBe(imageAssetContentSha256(base))
  })

  it('changes when any fingerprinted field changes', () => {
    const baseline = imageAssetContentSha256(base)
    expect(imageAssetContentSha256({ ...base, asset_id: 'img_x' })).not.toBe(baseline)
    expect(imageAssetContentSha256({ ...base, asset_sha256: 'b'.repeat(64) })).not.toBe(baseline)
    expect(imageAssetContentSha256({ ...base, role: 'og' })).not.toBe(baseline)
    expect(imageAssetContentSha256({ ...base, media_type: 'image/png' })).not.toBe(baseline)
    expect(imageAssetContentSha256({ ...base, width: 800 })).not.toBe(baseline)
    expect(imageAssetContentSha256({ ...base, height: 800 })).not.toBe(baseline)
    expect(imageAssetContentSha256({ ...base, alt_text: 'Different alt.' })).not.toBe(baseline)
  })

  it('treats null dimensions distinctly from a set value', () => {
    const withNull = imageAssetContentSha256({ ...base, width: null, height: null })
    expect(withNull).not.toBe(imageAssetContentSha256(base))
    // canonical payload renders nulls explicitly.
    expect(imageAssetCanonicalPayload({ ...base, width: null })).toContain('"width":null')
  })
})

describe('findImageRawOnlyLeaks', () => {
  it('flags whole-token raw-only terms case-insensitively', () => {
    expect(findImageRawOnlyLeaks('Premium Cannabis flower')).toContain('cannabis')
  })

  it('does not flag clean alt text', () => {
    expect(findImageRawOnlyLeaks('A rooftop garden at sunset.')).toEqual([])
  })
})

describe('checkImageAssetApprovable', () => {
  it('passes a complete, compliant asset', () => {
    expect(checkImageAssetApprovable(base)).toEqual([])
  })

  it('passes when dimensions are omitted (null)', () => {
    expect(checkImageAssetApprovable({ ...base, width: null, height: null })).toEqual([])
  })

  it('rejects an empty or malformed content hash', () => {
    expect(checkImageAssetApprovable({ ...base, asset_sha256: '' })).toEqual([
      { field: 'asset_sha256', message: 'Image content hash (sha256) is empty.' },
    ])
    const bad = checkImageAssetApprovable({ ...base, asset_sha256: 'NOTHEX' })
    expect(bad.map((p) => p.field)).toContain('asset_sha256')
  })

  it('rejects a non-image media type', () => {
    const probs = checkImageAssetApprovable({ ...base, media_type: 'application/pdf' })
    expect(probs.map((p) => p.field)).toContain('media_type')
  })

  it('rejects empty alt text', () => {
    const probs = checkImageAssetApprovable({ ...base, alt_text: '' })
    expect(probs.map((p) => p.field)).toContain('alt_text')
  })

  it('rejects alt text leaking raw-only cannabis terms onto the sanitized host', () => {
    const probs = checkImageAssetApprovable({ ...base, alt_text: 'Fresh cannabis on a shelf.' })
    const altProblem = probs.find((p) => p.field === 'alt_text')
    expect(altProblem?.message).toContain('cannabis')
  })

  it('rejects non-positive dimensions', () => {
    const probs = checkImageAssetApprovable({ ...base, width: 0, height: -5 })
    const fields = probs.map((p) => p.field)
    expect(fields).toContain('width')
    expect(fields).toContain('height')
  })
})
