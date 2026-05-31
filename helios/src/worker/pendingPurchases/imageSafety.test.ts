import { describe, expect, it } from 'vitest'

import {
  detectImageContentTypeFromBytes,
  validatePendingPurchaseImageBytes,
  validatePendingPurchaseImageContentType,
  validatePendingPurchaseImageUrl,
} from './imageSafety.js'

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
})
