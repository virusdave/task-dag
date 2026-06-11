import { describe, expect, it } from 'vitest'

import { generateEd25519Pem, publicKeyPemFromPrivate, signPayload, verifyPayload } from './signing.js'

describe('ed25519 signing', () => {
  const { publicKeyPem, privateKeyPem } = generateEd25519Pem()

  it('signs and verifies a payload roundtrip', () => {
    const sig = signPayload('hello world', privateKeyPem)
    expect(sig.startsWith('ed25519:')).toBe(true)
    expect(verifyPayload('hello world', sig, publicKeyPem)).toBe(true)
  })

  it('fails verification when the payload is tampered', () => {
    const sig = signPayload('hello world', privateKeyPem)
    expect(verifyPayload('hello w0rld', sig, publicKeyPem)).toBe(false)
  })

  it('fails verification against a different public key', () => {
    const other = generateEd25519Pem()
    const sig = signPayload('msg', privateKeyPem)
    expect(verifyPayload('msg', sig, other.publicKeyPem)).toBe(false)
  })

  it('returns false (never throws) on malformed signature strings', () => {
    expect(verifyPayload('msg', 'not-a-sig', publicKeyPem)).toBe(false)
    expect(verifyPayload('msg', 'ed25519:', publicKeyPem)).toBe(false)
    expect(verifyPayload('msg', 'ed25519:!!!notbase64', publicKeyPem)).toBe(false)
  })

  it('derives the public key from the private key', () => {
    const derived = publicKeyPemFromPrivate(privateKeyPem)
    const sig = signPayload('x', privateKeyPem)
    expect(verifyPayload('x', sig, derived)).toBe(true)
  })
})
