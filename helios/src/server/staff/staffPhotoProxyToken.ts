// Opaque, HMAC-signed proxy-token format used to keep the upstream
// Sweed photo URL out of the public freshlybaked.nyc HTML.
//
// Wire format: `<payloadB64Url>.<signatureB64Url>` where payload is
// `JSON.stringify({ v: 1, url })` and signature is HMAC-SHA256 over
// the payload bytes using a shared secret. The mostly-static-sites
// proxy route (`/api/staff-photo/[token]`) decodes the same token
// with the same secret, re-verifies the HMAC, SSRF-guards the
// hostname, and only then fetches and streams the bytes.
//
// Why not just hash the URL? The proxy needs to recover the
// upstream URL from the token without an extra DB round-trip; a
// pure one-way hash would force a per-photo allowlist sync between
// helios and the FBNYC site. Including the URL in a signed payload
// keeps the proxy stateless while still preventing arbitrary-URL
// proxying (signature check + SSRF allowlist).

import { createHmac, timingSafeEqual } from 'crypto'

import { readOptionalEnv } from '../../shared/config/runtimeEnv.js'

const SECRET_ENV_VAR = 'STAFF_PHOTO_PROXY_SECRET'
const NON_PRODUCTION_FALLBACK_SECRET =
  'staff-photo-proxy-nonproduction-secret-do-not-deploy'

function readSecret(): string {
  const configured = readOptionalEnv(SECRET_ENV_VAR)
  if (configured !== null && configured.trim().length > 0) {
    return configured.trim()
  }
  // Helios runs in many environments (dev, CI, prod). We don't have
  // a single ironclad "is-production" probe here; the secret is
  // required when the helios-worker reaches production via the
  // nixos-sbc module which always wires it. A fallback keeps unit
  // tests + local dev unblocked.
  if (process.env.NODE_ENV === 'production') {
    throw new Error(`${SECRET_ENV_VAR} must be set in production environments.`)
  }
  return NON_PRODUCTION_FALLBACK_SECRET
}

function base64UrlEncode(bytes: Buffer): string {
  return bytes.toString('base64url')
}

function base64UrlDecode(value: string): Buffer {
  return Buffer.from(value, 'base64url')
}

export function buildStaffPhotoProxyToken(sweedUrl: string): string {
  const payload = JSON.stringify({ v: 1, url: sweedUrl })
  const payloadBytes = Buffer.from(payload, 'utf8')
  const payloadEncoded = base64UrlEncode(payloadBytes)
  const signature = createHmac('sha256', readSecret()).update(payloadBytes).digest()
  return `${payloadEncoded}.${base64UrlEncode(signature)}`
}

export interface VerifiedStaffPhotoProxyToken {
  sweedUrl: string
}

export function verifyStaffPhotoProxyToken(token: string): VerifiedStaffPhotoProxyToken | null {
  const dotIndex = token.indexOf('.')
  if (dotIndex <= 0 || dotIndex === token.length - 1) {
    return null
  }
  const payloadPart = token.slice(0, dotIndex)
  const signaturePart = token.slice(dotIndex + 1)

  let payloadBytes: Buffer
  let signatureBytes: Buffer
  try {
    payloadBytes = base64UrlDecode(payloadPart)
    signatureBytes = base64UrlDecode(signaturePart)
  } catch {
    return null
  }

  const expected = createHmac('sha256', readSecret()).update(payloadBytes).digest()
  if (expected.length !== signatureBytes.length) return null
  if (!timingSafeEqual(expected, signatureBytes)) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(payloadBytes.toString('utf8'))
  } catch {
    return null
  }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    (parsed as { v?: unknown }).v !== 1 ||
    typeof (parsed as { url?: unknown }).url !== 'string'
  ) {
    return null
  }
  return { sweedUrl: (parsed as { url: string }).url }
}
