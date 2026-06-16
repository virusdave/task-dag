// Resolve the FB-US opaque-public-ref secret for the branding manifest
// producer. The pure derivation (`opaqueRef.ts`) never reads env; this is
// the one place the secret is sourced, mirroring mss's `server-only`
// wrapper (`app/freshlybakedus-opaque-public-ref.ts`).
//
// The opaque ref is a published URL surface: a manifest built with the
// non-production fallback secret will NOT match mss's production pages, so
// publishing such a manifest to prod would `308` live, already-approved
// Google-Ads URLs to non-existent opaque pages (404). Therefore the source
// is always labelled, and the prod publish path requires a real secret
// (see `requireProductionBrandingSecret` + `publish.ts`).

import { nonProductionFallbackPublicTokenSecret } from './opaqueRef.js'
import type { SecretSource } from './manifest.js'

export const FRESHLYBAKEDUS_PUBLIC_TOKEN_SECRET_ENV = 'FRESHLYBAKEDUS_PUBLIC_TOKEN_SECRET'

export interface ResolvedBrandingSecret {
  readonly secret: string
  readonly source: SecretSource
}

/**
 * Resolve the secret from the environment. A configured value that differs
 * from the deterministic fallback is `production`; an unset/blank value, or
 * one that equals the fallback, is `nonproduction-fallback`. Never throws —
 * callers that must have a prod secret use `requireProductionBrandingSecret`.
 */
export function resolveBrandingOpaqueSecret(
  env: NodeJS.ProcessEnv = process.env,
): ResolvedBrandingSecret {
  const raw = env[FRESHLYBAKEDUS_PUBLIC_TOKEN_SECRET_ENV]
  const trimmed = typeof raw === 'string' ? raw.trim() : ''

  if (trimmed.length > 0 && trimmed !== nonProductionFallbackPublicTokenSecret) {
    return { secret: trimmed, source: 'production' }
  }
  return { secret: nonProductionFallbackPublicTokenSecret, source: 'nonproduction-fallback' }
}

export class MissingProductionSecretError extends Error {
  constructor() {
    super(
      `${FRESHLYBAKEDUS_PUBLIC_TOKEN_SECRET_ENV} must be set to the real production secret to ` +
        `produce/publish a production branding opaque manifest (the non-production fallback would ` +
        `308 live Google-Ads URLs to 404). It is NOT the mss non-production fallback value.`,
    )
    this.name = 'MissingProductionSecretError'
  }
}

/**
 * Resolve the secret and require it be the real production one. Throws
 * `MissingProductionSecretError` otherwise. Used by the prod publish path
 * so a fallback-derived manifest can never reach live ad traffic.
 */
export function requireProductionBrandingSecret(
  env: NodeJS.ProcessEnv = process.env,
): ResolvedBrandingSecret {
  const resolved = resolveBrandingOpaqueSecret(env)
  if (resolved.source !== 'production') {
    throw new MissingProductionSecretError()
  }
  return resolved
}
