// Shared, dependency-free validation for post-login "return to the page
// you were trying to reach" redirects. Used by BOTH the Fastify server
// (OAuth start/callback) and the React client (login page / 401
// recovery), so it must not import anything Node- or browser-specific.
//
// The single canonical representation of a `returnTo` is an
// **in-app, app-base-path-RELATIVE** path: e.g. `/catalog/review?tab=x`.
// It never includes the deployment base path (so the server can do
// exactly one `joinBasePath(appBasePath, returnTo)` without risking a
// `/helios/helios/...` double-join) and never a full/scheme-relative
// URL (so it can never be turned into an open redirect to another host).

const MAX_RETURN_TO_LENGTH = 1024

// A throwaway origin used only to parse the candidate as a URL so we can
// reject anything that resolves to a different origin (i.e. anything
// that is not a plain same-app path). The hostname is deliberately a
// `.invalid` TLD so it can never collide with a real deployment host.
const RETURN_TO_PARSE_ORIGIN = 'https://helios.invalid'

/**
 * Validate and normalize an untrusted `returnTo` candidate.
 *
 * Returns a safe, app-relative path (always starting with a single `/`)
 * or `null` if the candidate is missing or unsafe. Callers that want a
 * guaranteed string should use {@link normalizeReturnToOrRoot}.
 *
 * Security: we reject dangerous *raw* forms BEFORE any URL parsing /
 * normalization, because path-normalization helpers can launder
 * `//evil.com` into `/evil.com` and similar. Anything that smells like a
 * scheme-relative URL, an absolute URL, a backslash, a control
 * character, a CRLF (header-injection) escape, or an encoded
 * slash/backslash in the path portion is rejected outright.
 */
export function normalizeReturnTo(raw: unknown): string | null {
  if (typeof raw !== 'string') {
    return null
  }
  if (raw.length === 0 || raw.length > MAX_RETURN_TO_LENGTH) {
    return null
  }
  // No leading/trailing whitespace — keeps the value unambiguous and
  // dodges a class of header/parse edge cases.
  if (raw !== raw.trim()) {
    return null
  }

  // Must be an absolute *path* (single leading slash), not a
  // scheme-relative (`//host`) or absolute (`https://host`) URL.
  if (!raw.startsWith('/') || raw.startsWith('//')) {
    return null
  }

  // Reject control chars and backslashes (browser/proxy ambiguity).
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\\]/.test(raw)) {
    return null
  }
  // Reject CRLF / NUL escapes anywhere (header-injection defense).
  if (/%(?:00|0d|0a)/i.test(raw)) {
    return null
  }

  const pathPart = raw.split(/[?#]/, 1)[0]!
  // Reject encoded slash/backslash in the path portion — these can be
  // used to smuggle a host past naive checks once decoded.
  if (/%(?:2f|5c)/i.test(pathPart)) {
    return null
  }

  let parsed: URL
  try {
    parsed = new URL(raw, RETURN_TO_PARSE_ORIGIN)
  } catch {
    return null
  }
  // If parsing pulled the value onto any other origin, it wasn't a
  // plain same-app path.
  if (parsed.origin !== RETURN_TO_PARSE_ORIGIN) {
    return null
  }

  const normalized = `${parsed.pathname}${parsed.search}${parsed.hash}`

  // `returnTo` must point at an app *page*, never the API surface, the
  // OAuth endpoints, or the login page itself (which would just bounce
  // the user straight back into the flow).
  if (
    normalized === '/login' ||
    normalized.startsWith('/login?') ||
    normalized === '/api' ||
    normalized.startsWith('/api/')
  ) {
    return null
  }

  return normalized
}

/**
 * Like {@link normalizeReturnTo} but always returns a usable path,
 * defaulting to the app root (`/`) for missing/invalid input. Use this
 * at the points where we actually perform a redirect.
 */
export function normalizeReturnToOrRoot(raw: unknown): string {
  return normalizeReturnTo(raw) ?? '/'
}
