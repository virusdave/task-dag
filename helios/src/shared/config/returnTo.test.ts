import { describe, expect, it } from 'vitest'

import { normalizeReturnTo, normalizeReturnToOrRoot } from './returnTo.js'

describe('normalizeReturnTo', () => {
  it('accepts plain same-app paths and preserves query/hash', () => {
    expect(normalizeReturnTo('/catalog/review')).toBe('/catalog/review')
    expect(normalizeReturnTo('/catalog/review?tab=history')).toBe('/catalog/review?tab=history')
    expect(normalizeReturnTo('/dashboard#section')).toBe('/dashboard#section')
    expect(normalizeReturnTo('/')).toBe('/')
  })

  it('rejects non-strings and empty/oversized input', () => {
    expect(normalizeReturnTo(undefined)).toBeNull()
    expect(normalizeReturnTo(null)).toBeNull()
    expect(normalizeReturnTo(123)).toBeNull()
    expect(normalizeReturnTo('')).toBeNull()
    expect(normalizeReturnTo(`/${'a'.repeat(2000)}`)).toBeNull()
  })

  it('rejects open-redirect / off-origin forms', () => {
    expect(normalizeReturnTo('//evil.com')).toBeNull()
    expect(normalizeReturnTo('https://evil.com')).toBeNull()
    expect(normalizeReturnTo('http://evil.com/path')).toBeNull()
    expect(normalizeReturnTo('relative/no/leading/slash')).toBeNull()
  })

  it('rejects backslashes, control chars, CRLF and encoded-slash smuggling', () => {
    expect(normalizeReturnTo('/\\evil.com')).toBeNull()
    expect(normalizeReturnTo('/foo\u0000bar')).toBeNull()
    expect(normalizeReturnTo('/%2f%2fevil.com')).toBeNull()
    expect(normalizeReturnTo('/%5cevil.com')).toBeNull()
    expect(normalizeReturnTo('/%0d%0aLocation:%20https://evil.com')).toBeNull()
  })

  it('rejects whitespace-padded input', () => {
    expect(normalizeReturnTo(' /catalog')).toBeNull()
    expect(normalizeReturnTo('/catalog ')).toBeNull()
  })

  it('rejects api/auth/login targets that would bounce or leak', () => {
    expect(normalizeReturnTo('/api/session')).toBeNull()
    expect(normalizeReturnTo('/api')).toBeNull()
    expect(normalizeReturnTo('/api/auth/google/start')).toBeNull()
    expect(normalizeReturnTo('/login')).toBeNull()
    expect(normalizeReturnTo('/login?returnTo=/x')).toBeNull()
  })

  it('normalizeReturnToOrRoot falls back to root', () => {
    expect(normalizeReturnToOrRoot('//evil.com')).toBe('/')
    expect(normalizeReturnToOrRoot(undefined)).toBe('/')
    expect(normalizeReturnToOrRoot('/catalog/review')).toBe('/catalog/review')
  })
})
