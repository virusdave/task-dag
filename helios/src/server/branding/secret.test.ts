import { describe, expect, it } from 'vitest'

import { nonProductionFallbackPublicTokenSecret } from './opaqueRef.js'
import {
  FRESHLYBAKEDUS_PUBLIC_TOKEN_SECRET_ENV,
  MissingProductionSecretError,
  requireProductionBrandingSecret,
  resolveBrandingOpaqueSecret,
} from './secret.js'

const ENV = FRESHLYBAKEDUS_PUBLIC_TOKEN_SECRET_ENV

describe('resolveBrandingOpaqueSecret', () => {
  it('falls back when the secret is unset or blank', () => {
    expect(resolveBrandingOpaqueSecret({})).toEqual({
      secret: nonProductionFallbackPublicTokenSecret,
      source: 'nonproduction-fallback',
    })
    expect(resolveBrandingOpaqueSecret({ [ENV]: '   ' }).source).toBe('nonproduction-fallback')
  })

  it('treats an explicit fallback value as fallback, never production', () => {
    expect(resolveBrandingOpaqueSecret({ [ENV]: nonProductionFallbackPublicTokenSecret }).source).toBe(
      'nonproduction-fallback',
    )
  })

  it('treats a real configured secret as production (trimmed)', () => {
    expect(resolveBrandingOpaqueSecret({ [ENV]: '  real-prod-secret  ' })).toEqual({
      secret: 'real-prod-secret',
      source: 'production',
    })
  })
})

describe('requireProductionBrandingSecret', () => {
  it('returns the production secret when configured', () => {
    expect(requireProductionBrandingSecret({ [ENV]: 'real-prod-secret' }).source).toBe('production')
  })

  it('throws when only the fallback is available', () => {
    expect(() => requireProductionBrandingSecret({})).toThrow(MissingProductionSecretError)
    expect(() => requireProductionBrandingSecret({ [ENV]: nonProductionFallbackPublicTokenSecret })).toThrow(
      MissingProductionSecretError,
    )
  })
})
