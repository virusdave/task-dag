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

import { buildDefaultSecretFilePaths, readOptionalSecretEnv } from '../../shared/config/runtimeEnv.js'
import { nonProductionFallbackPublicTokenSecret } from './opaqueRef.js'
import type { SecretSource } from './manifest.js'

export const FRESHLYBAKEDUS_PUBLIC_TOKEN_SECRET_ENV = 'FRESHLYBAKEDUS_PUBLIC_TOKEN_SECRET'

// Canonical provisioning (ownership decision A, automation#48): the real
// production secret is the SAME value mss derives opaque public refs with
// (mss `FRESHLYBAKEDUS_PUBLIC_TOKEN_SECRET`). On vps-nixos-3 it is stored as
// an agenix-encrypted secret (Nicponskis/nixos-sbc) and exposed to the
// helios processes via the systemd EnvironmentFile as
// `FRESHLYBAKEDUS_PUBLIC_TOKEN_SECRET`, exactly like the veriscan /
// lp-events / bedrock bearers in `server/config/env.ts`. For one-off CLI
// runs (`branding-opaque-manifest publish`) the same value may instead be
// dropped into one of these `~/.secret/` fallback files. Either way the env
// var / file holds the raw secret; an unset value (or the mss non-production
// fallback) is treated as non-production and the prod publish path refuses
// it (see `requireProductionBrandingSecret` + `publish.ts`).
export const FRESHLYBAKEDUS_PUBLIC_TOKEN_SECRET_FILE_PATHS = buildDefaultSecretFilePaths(
  'freshlybakedus/public-token-secret',
  'freshlybakedus/public-token-secret.env',
)

export interface ResolvedBrandingSecret {
  readonly secret: string
  readonly source: SecretSource
}

/**
 * Resolve the secret from the environment (and, for the real process env,
 * the canonical agenix/`.secret/` fallback files). A configured value that
 * differs from the deterministic fallback is `production`; an unset/blank
 * value, or one that equals the fallback, is `nonproduction-fallback`. Never
 * throws — callers that must have a prod secret use
 * `requireProductionBrandingSecret`.
 */
export function resolveBrandingOpaqueSecret(
  env: NodeJS.ProcessEnv = process.env,
): ResolvedBrandingSecret {
  const trimmed = readRawBrandingSecret(env)?.trim() ?? ''

  if (trimmed.length > 0 && trimmed !== nonProductionFallbackPublicTokenSecret) {
    return { secret: trimmed, source: 'production' }
  }
  return { secret: nonProductionFallbackPublicTokenSecret, source: 'nonproduction-fallback' }
}

/**
 * Read the raw secret string. The direct env var is always honoured (so unit
 * tests can inject a plain `env` object hermetically); the `_FILE`
 * indirection + canonical `.secret/` fallback files are consulted only when
 * resolving the real `process.env`, so tests never touch the filesystem.
 */
function readRawBrandingSecret(env: NodeJS.ProcessEnv): string | null {
  const direct = env[FRESHLYBAKEDUS_PUBLIC_TOKEN_SECRET_ENV]?.trim()
  if (direct) return direct
  if (env === process.env) {
    return readOptionalSecretEnv(FRESHLYBAKEDUS_PUBLIC_TOKEN_SECRET_ENV, {
      defaultFilePaths: FRESHLYBAKEDUS_PUBLIC_TOKEN_SECRET_FILE_PATHS,
    })
  }
  return null
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
