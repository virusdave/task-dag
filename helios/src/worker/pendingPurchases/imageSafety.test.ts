import { describe, expect, it } from 'vitest'

import {
  describeUnsupportedImageFormat,
  detectImageContentTypeFromBytes,
  UnsupportedImageFormatError,
  validatePendingPurchaseImageBytes,
  validatePendingPurchaseImageContentType,
  validatePendingPurchaseImageUrl,
} from './imageSafety.js'

// Minimal ISO base media file format header: 4-byte box size, "ftyp" box type,
// then the 4-char major brand. This is the shape the real failing images had —
// an AVIF file the CDN mislabeled as image/png.
function isoBmffHeader(brand: string): Uint8Array {
  const bytes = new Uint8Array(12)
  bytes.set([0x00, 0x00, 0x00, 0x20], 0)
  bytes.set([0x66, 0x74, 0x79, 0x70], 4) // "ftyp"
  for (let i = 0; i < 4; i += 1) {
    bytes[8 + i] = brand.charCodeAt(i)
  }
  return bytes
}

describe('validatePendingPurchaseImageUrl', () => {
  it('accepts https urls that resolve to public addresses', async () => {
    await expect(validatePendingPurchaseImageUrl('https://cdn.example.com/file.png', {
      lookupFn: async () => [{ address: '93.184.216.34', family: 4 }],
    })).resolves.toBeInstanceOf(URL)
  })

  it('rejects localhost and private network addresses', async () => {
    await expect(validatePendingPurchaseImageUrl('https://localhost/file.png')).rejects.toThrow('not allowed')
    await expect(validatePendingPurchaseImageUrl('https://10.0.0.12/file.png')).rejects.toThrow('not public')
    await expect(validatePendingPurchaseImageUrl('https://internal.example/file.png', {
      lookupFn: async () => [{ address: '192.168.1.20', family: 4 }],
    })).rejects.toThrow('non-public address')
  })

  it('rejects non-https urls', async () => {
    await expect(validatePendingPurchaseImageUrl('http://cdn.example.com/file.png', {
      lookupFn: async () => [{ address: '93.184.216.34', family: 4 }],
    })).rejects.toThrow('must use HTTPS')
  })
})

describe('validatePendingPurchaseImageContentType', () => {
  it('normalizes allowed jpeg content types', () => {
    expect(validatePendingPurchaseImageContentType('image/jpg; charset=binary')).toBe('image/jpeg')
  })

  it('rejects unsupported image content types', () => {
    expect(() => validatePendingPurchaseImageContentType('image/svg+xml')).toThrow('unsupported content type')
  })
})

describe('validatePendingPurchaseImageBytes', () => {
  it('accepts jpeg and png signatures', () => {
    expect(() => validatePendingPurchaseImageBytes(new Uint8Array([0xff, 0xd8, 0xff, 0xdb]), 'image/jpeg')).not.toThrow()
    expect(() => validatePendingPurchaseImageBytes(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), 'image/png')).not.toThrow()
  })

  it('rejects bytes that do not match the declared image type', () => {
    expect(() => validatePendingPurchaseImageBytes(new Uint8Array([0x47, 0x49, 0x46, 0x38]), 'image/png')).toThrow('did not match')
  })
})

describe('detectImageContentTypeFromBytes', () => {
  it('detects jpeg, png, gif, and webp from magic bytes regardless of header', () => {
    expect(detectImageContentTypeFromBytes(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg')
    expect(detectImageContentTypeFromBytes(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe('image/png')
    expect(detectImageContentTypeFromBytes(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]))).toBe('image/gif')
    expect(detectImageContentTypeFromBytes(new Uint8Array([
      0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
    ]))).toBe('image/webp')
  })

  it('returns null when no supported image signature matches', () => {
    expect(detectImageContentTypeFromBytes(new Uint8Array([0x00, 0x01, 0x02, 0x03]))).toBeNull()
    expect(detectImageContentTypeFromBytes(new Uint8Array(0))).toBeNull()
  })

  it('does not treat AVIF (an unsupported ISO-BMFF format) as a supported type', () => {
    expect(detectImageContentTypeFromBytes(isoBmffHeader('avif'))).toBeNull()
  })
})

describe('describeUnsupportedImageFormat', () => {
  it('identifies AVIF from the ftyp box brand (the real packet-55 failure)', () => {
    expect(describeUnsupportedImageFormat(isoBmffHeader('avif'))).toBe('AVIF')
    expect(describeUnsupportedImageFormat(isoBmffHeader('avis'))).toBe('AVIF')
  })

  it('identifies HEIF/HEIC brands', () => {
    expect(describeUnsupportedImageFormat(isoBmffHeader('heic'))).toBe('HEIF/HEIC')
    expect(describeUnsupportedImageFormat(isoBmffHeader('mif1'))).toBe('HEIF/HEIC')
  })

  it('identifies other well-known non-web formats', () => {
    expect(describeUnsupportedImageFormat(new Uint8Array([0x42, 0x4d, 0x00, 0x00]))).toBe('BMP')
    expect(describeUnsupportedImageFormat(new Uint8Array([0x49, 0x49, 0x2a, 0x00]))).toBe('TIFF')
  })

  it('returns null for bytes it cannot identify', () => {
    expect(describeUnsupportedImageFormat(new Uint8Array([0x00, 0x01, 0x02, 0x03]))).toBeNull()
  })
})

describe('UnsupportedImageFormatError', () => {
  it('produces an actionable message naming the real format and the misleading header', () => {
    const error = new UnsupportedImageFormatError('AVIF', 'image/png')
    expect(error).toBeInstanceOf(Error)
    expect(error.detectedFormat).toBe('AVIF')
    expect(error.headerContentType).toBe('image/png')
    expect(error.message).toContain('AVIF')
    expect(error.message).toContain('image/png')
    expect(error.message).toContain('Sweed does not accept')
  })
})
