import {
  buildDefaultSecretFilePaths,
  readOptionalSecretEnv,
  readOptionalEnv,
  readRequiredDatabaseUrl,
  readRequiredEnv,
} from '../../shared/config/runtimeEnv.js'
import { deriveBasePathFromAppBaseUrl, joinBasePath } from '../../shared/config/appBasePath.js'

const GOOGLE_OAUTH_CLIENT_ID_SECRET_FILE_PATHS = buildDefaultSecretFilePaths(
  'google-oauth/catalog-curation.env',
  'google-oauth/catalog-curation-client-id',
  'google-oauth/client',
)

const GOOGLE_OAUTH_CLIENT_SECRET_SECRET_FILE_PATHS = buildDefaultSecretFilePaths(
  'google-oauth/catalog-curation.env',
  'google-oauth/catalog-curation-client-secret',
  'google-oauth/client',
)

const GOOGLE_OAUTH_REDIRECT_URI_SECRET_FILE_PATHS = buildDefaultSecretFilePaths(
  'google-oauth/catalog-curation.env',
  'google-oauth/catalog-curation-redirect-uri',
  'google-oauth/client',
)

const SWEED_AUTH_TOKEN_SECRET_FILE_PATHS = buildDefaultSecretFilePaths('sweed/auth-token', 'sweed/auth-token.env')

export interface ServerEnv {
  appBasePath: string
  appBaseUrl: string
  allowedOrigins: string[]
  databaseUrl: string
  googleAllowedDomain: string
  googleAllowedEmails: string[]
  googleClientId: string | null
  googleClientSecret: string | null
  googleRedirectUri: string | null
  nodeEnv: 'development' | 'production' | 'test'
  port: number
  sessionCookieName: string
  sessionCookieSecret: string
  sweedApiUrl: string
  sweedAuthToken: string | null
  sweedStateDealerId: number
  communicationsPolicyPacketDir: string
  // Customer-Sentiment Capture (issue #13).  Default off so a deploy
  // can't accidentally start accepting public POST /v1/reviews/submit
  // calls before the operator has flipped the per-site
  // review_drawing_enabled / review_llm_gate_enabled flags.  Set
  // HELIOS_REVIEWS_CAPTURE_V1=1 to enable.  See
  // docs/helios/customer-sentiment/EPIC_PLAN.md.
  reviewsCaptureV1Enabled: boolean
}

let cachedEnv: ServerEnv | null = null

export function getServerEnv(): ServerEnv {
  if (cachedEnv !== null) {
    return cachedEnv
  }

  const nodeEnv = readNodeEnv(process.env.NODE_ENV)
  const appBaseUrl = readRequiredEnv('APP_BASE_URL')
  const appBasePath = deriveBasePathFromAppBaseUrl(appBaseUrl)
  const allowedOrigins = readAllowedOrigins(appBaseUrl, nodeEnv)

  cachedEnv = {
    appBasePath,
    appBaseUrl,
    allowedOrigins,
    databaseUrl: readRequiredDatabaseUrl(),
    googleAllowedDomain: readOptionalEnv('GOOGLE_OAUTH_ALLOWED_DOMAIN') ?? 'freshlybaked.nyc',
    googleAllowedEmails: parseEmailList(readOptionalEnv('GOOGLE_OAUTH_ALLOWED_EMAILS')),
    googleClientId: readOptionalSecretEnv('GOOGLE_OAUTH_CLIENT_ID', {
      defaultFilePaths: GOOGLE_OAUTH_CLIENT_ID_SECRET_FILE_PATHS,
    }),
    googleClientSecret: readOptionalSecretEnv('GOOGLE_OAUTH_CLIENT_SECRET', {
      defaultFilePaths: GOOGLE_OAUTH_CLIENT_SECRET_SECRET_FILE_PATHS,
    }),
    googleRedirectUri: readOptionalSecretEnv('GOOGLE_OAUTH_REDIRECT_URI', {
      defaultFilePaths: GOOGLE_OAUTH_REDIRECT_URI_SECRET_FILE_PATHS,
    }),
    nodeEnv,
    port: readNumberEnv('PORT', 3001),
    sessionCookieName: readOptionalEnv('SESSION_COOKIE_NAME') ?? 'helios-session',
    sessionCookieSecret: readRequiredEnv('SESSION_COOKIE_SECRET'),
    sweedApiUrl: readOptionalEnv('SWEED_API_URL') ?? 'https://prime.sweedpos.com/api/',
    sweedAuthToken: readOptionalSecretEnv('SWEED_AUTH_TOKEN', {
      defaultFilePaths: SWEED_AUTH_TOKEN_SECRET_FILE_PATHS,
    }),
    sweedStateDealerId: readNumberEnv('SWEED_STATE_DEALER_ID', 210248),
    communicationsPolicyPacketDir:
      readOptionalEnv('COMMUNICATIONS_POLICY_PACKET_DIR') ??
      '/Users/dave/tmp/scratch/fbnyc/sweed/automation/ads/google/policy',
    reviewsCaptureV1Enabled: readBoolEnv('HELIOS_REVIEWS_CAPTURE_V1', false),
  }

  return cachedEnv
}

export function hasGoogleOAuthConfig(env: ServerEnv = getServerEnv()): boolean {
  return Boolean(env.googleClientId && env.googleClientSecret && env.googleRedirectUri)
}

export function getGoogleOAuthConfigurationIssue(env: ServerEnv = getServerEnv()): string | null {
  if (!hasGoogleOAuthConfig(env)) {
    return 'Google OAuth is unavailable until the Google OAuth client ID, secret, and redirect URI are configured.'
  }

  const appBaseUrl = new URL(env.appBaseUrl)
  if (!isLoopbackHostname(appBaseUrl.hostname)) {
    return null
  }

  const expectedRedirectUri = new URL(joinBasePath(env.appBasePath, '/api/auth/google/callback'), env.appBaseUrl).toString()
  if (env.googleRedirectUri !== expectedRedirectUri) {
    return `Local Helios is running at ${env.appBaseUrl}, but Google OAuth redirects to ${env.googleRedirectUri}. Set GOOGLE_OAUTH_REDIRECT_URI to ${expectedRedirectUri}, or use the localhost-only dev sign-in.`
  }

  return null
}

export function isGoogleOAuthReady(env: ServerEnv = getServerEnv()): boolean {
  return getGoogleOAuthConfigurationIssue(env) === null
}

function readAllowedOrigins(appBaseUrl: string, nodeEnv: ServerEnv['nodeEnv']): string[] {
  const configuredOrigins = process.env.APP_ALLOWED_ORIGINS
    ?.split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0)

  const defaults = [new URL(appBaseUrl).origin]

  if (nodeEnv !== 'production') {
    defaults.push(
      'http://localhost:5173',
      'http://127.0.0.1:5173',
      'http://localhost:5174',
      'http://127.0.0.1:5174',
    )
  }

  return [...new Set([...(configuredOrigins ?? []), ...defaults])]
}

function isLoopbackHostname(hostname: string): boolean {
  const normalizedHostname = hostname.trim().toLowerCase()
  return normalizedHostname === 'localhost' || normalizedHostname === '127.0.0.1' || normalizedHostname === '::1'
}

function readNodeEnv(value: string | undefined): ServerEnv['nodeEnv'] {
  switch (value) {
    case 'production':
    case 'test':
      return value
    default:
      return 'development'
  }
}

function parseEmailList(raw: string | null): string[] {
  if (raw === null) {
    return []
  }
  return [
    ...new Set(
      raw
        .split(',')
        .map((value) => value.trim().toLowerCase())
        .filter((value) => value.length > 0),
    ),
  ]
}

function readBoolEnv(name: string, fallback: boolean): boolean {
  const rawValue = readOptionalEnv(name)
  if (rawValue === null) {
    return fallback
  }
  const normalized = rawValue.trim().toLowerCase()
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true
  if (['0', 'false', 'no', 'off', ''].includes(normalized)) return false
  throw new Error(`${name} must be a boolean (1/0, true/false, yes/no, on/off).`)
}

function readNumberEnv(name: string, fallback: number): number {
  const rawValue = readOptionalEnv(name)
  if (rawValue === null) {
    return fallback
  }

  const parsed = Number.parseInt(rawValue, 10)
  if (!Number.isFinite(parsed)) {
    throw new Error(`${name} must be a valid integer.`)
  }
  return parsed
}
