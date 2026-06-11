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

// VeriScan webhook bearer token. Generated once by the operator
// (`openssl rand -hex 32`), pasted into VeriScan's webhook
// `Authorization: Bearer <token>` custom header on both Bronx and
// Midtown sites, and stored as an agenix-encrypted secret on
// vps-nixos-3 (Nicponskis/nixos-sbc N1). Exposed to helios-server via
// the systemd EnvironmentFile as `VERISCAN_WEBHOOK_TOKEN`. The
// helios webhook handler refuses any POST whose bearer doesn't
// constant-time match this value; an unset env var means every
// /wh/{bx,mh}/veriscan/checkin POST is rejected as 503 (server has
// no configured bearer to compare against). See
// virusdave/top-level#9 / FreshlyBakedNYC/automation#31 A1.
const VERISCAN_WEBHOOK_TOKEN_SECRET_FILE_PATHS = buildDefaultSecretFilePaths(
  'veriscan/webhook-token',
  'veriscan/webhook-token.env',
)

// Private-LLM gateway (Bedrock-mantle) credentials, mirrored from
// the worker-side env so the server-side review-sentiment gate
// (issue #13 / A2) can call the OpenAI-compatible /chat/completions
// endpoint directly from the POST /v1/reviews/submit handler. The
// worker uses the same env vars; this is intentional — they're
// process-level and the same secret is fine for both processes.
const BEDROCK_MANTLE_BEARER_TOKEN_SECRET_FILE_PATHS = buildDefaultSecretFilePaths(
  'bedrock/mantle-bearer-token',
  'bedrock/mantle-bearer-token.env',
)

// Unified-landing-engine event-ingest bearer token (parent epic
// virusdave/top-level#13 / child FreshlyBakedNYC/automation#42, P1).
// The mostly-static-sites landing runtime authenticates its
// `POST /v1/lp-events/batch` flushes with this long-lived bearer; the
// Helios ingest handler refuses any batch whose bearer doesn't
// constant-time match. Unset → the route 503s every request
// (fail-closed, see routes/lpEvents.ts). Stored alongside the other
// agenix-encrypted secrets and exposed via the systemd EnvironmentFile
// as LP_EVENTS_INGEST_TOKEN.
const LP_EVENTS_INGEST_TOKEN_SECRET_FILE_PATHS = buildDefaultSecretFilePaths(
  'lp-events/ingest-token',
  'lp-events/ingest-token.env',
)

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
  // VeriScan webhook bearer token. See
  // VERISCAN_WEBHOOK_TOKEN_SECRET_FILE_PATHS above for the
  // why/where; null when unset (server-side fail-closed default —
  // every webhook POST returns 503 in that state, see
  // helios/src/server/routes/visitorScans.ts).
  veriscanWebhookToken: string | null
  // Unified-landing-engine event-ingest bearer token. See
  // LP_EVENTS_INGEST_TOKEN_SECRET_FILE_PATHS above; null when unset
  // (fail-closed — POST /v1/lp-events/batch returns 503 in that state,
  // see routes/lpEvents.ts).
  lpEventsIngestToken: string | null
  communicationsPolicyPacketDir: string
  // Customer-Sentiment Capture (issue #13).  Default off so a deploy
  // can't accidentally start accepting public POST /v1/reviews/submit
  // calls before the operator has flipped the per-site
  // review_drawing_enabled / review_llm_gate_enabled flags.  Set
  // HELIOS_REVIEWS_CAPTURE_V1=1 to enable.  See
  // docs/helios/customer-sentiment/EPIC_PLAN.md.
  reviewsCaptureV1Enabled: boolean
  // Private-LLM gateway endpoint (OpenAI-compatible chat.completions
  // shape). Used by the review-sentiment gate (A2) and any other
  // server-side LLM caller. Same env vars / values as the worker.
  bedrockMantleBaseUrl: string
  bedrockMantleBearerToken: string | null
  llmRequestTimeoutMs: number
  // Customer-Sentiment Capture (issue #13, A3 phase) — email pipeline.
  // Sender address used as From: on outbound review notifications.
  // Mailbox provisioning is owned by the nixos-sbc child epic; until
  // that lands we still queue rows in review_emails so the operator
  // page can surface the would-be sends.
  reviewsEmailFromAddress: string
  // Optional SMTP relay. Unset → every send returns 'queued' (no
  // actual delivery attempted). Set → A3 attempts a minimal plain-
  // TCP SMTP exchange; transport failures land as 'failed' with the
  // error captured on review_emails.send_error.
  reviewsSmtpHost: string | null
  reviewsSmtpPort: number
  reviewsSmtpTimeoutMs: number
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
    veriscanWebhookToken: readOptionalSecretEnv('VERISCAN_WEBHOOK_TOKEN', {
      defaultFilePaths: VERISCAN_WEBHOOK_TOKEN_SECRET_FILE_PATHS,
    }),
    lpEventsIngestToken: readOptionalSecretEnv('LP_EVENTS_INGEST_TOKEN', {
      defaultFilePaths: LP_EVENTS_INGEST_TOKEN_SECRET_FILE_PATHS,
    }),
    communicationsPolicyPacketDir:
      readOptionalEnv('COMMUNICATIONS_POLICY_PACKET_DIR') ??
      '/Users/dave/tmp/scratch/fbnyc/sweed/automation/ads/google/policy',
    reviewsCaptureV1Enabled: readBoolEnv('HELIOS_REVIEWS_CAPTURE_V1', false),
    bedrockMantleBaseUrl:
      readOptionalEnv('BEDROCK_MANTLE_BASE_URL') ?? 'https://bedrock-mantle.us-east-2.api.aws/v1',
    bedrockMantleBearerToken: readOptionalSecretEnv('BEDROCK_MANTLE_BEARER_TOKEN', {
      defaultFilePaths: BEDROCK_MANTLE_BEARER_TOKEN_SECRET_FILE_PATHS,
    }),
    llmRequestTimeoutMs: readNumberEnv('LLM_REQUEST_TIMEOUT_MS', 120000),
    reviewsEmailFromAddress:
      readOptionalEnv('REVIEWS_EMAIL_FROM') ?? 'reviews@freshlybaked.us',
    reviewsSmtpHost: readOptionalEnv('REVIEWS_SMTP_HOST'),
    reviewsSmtpPort: readNumberEnv('REVIEWS_SMTP_PORT', 25),
    reviewsSmtpTimeoutMs: readNumberEnv('REVIEWS_SMTP_TIMEOUT_MS', 10000),
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

  const defaults = [
    new URL(appBaseUrl).origin,
    // Customer-Sentiment Capture (virusdave/top-level#3): the public
    // review landing pages live at
    // `https://freshlybaked.nyc/go/<location-code>/review` and call
    // the public `/v1/reviews/submit` + `/v1/reviews/:id/drawing-entry`
    // endpoints from a customer's browser. Both production hosts are
    // baked into the defaults so a stock Helios prod install accepts
    // those preflights without per-deploy env tweaking.
    'https://freshlybaked.nyc',
    'https://www.freshlybaked.nyc',
  ]

  if (nodeEnv !== 'production') {
    defaults.push(
      'http://localhost:5173',
      'http://127.0.0.1:5173',
      'http://localhost:5174',
      'http://127.0.0.1:5174',
      // mss freshlybaked-site dev/staging hosts (cf. apps/freshlybaked
      // -site/site.config.ts and packages/config in
      // Nicponskis/mostly-static-sites).
      'https://staging.freshlybaked.nyc',
      'http://localhost:4330',
      'http://freshlybaked.local.test:4330',
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
