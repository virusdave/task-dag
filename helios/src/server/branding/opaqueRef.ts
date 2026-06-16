// Pure, runtime-agnostic core of the Freshly Baked US opaque-public-ref
// scheme — the Helios-side replica of the mostly-static-sites (mss)
// authoritative implementation
// (`apps/freshlybakedus-site/lib/opaque-public-ref-core.ts`).
//
// THE CROSS-REPO CONTRACT IS THE CHECKED-IN GOLDEN VECTORS, NOT shared
// code (parent EPIC_PLAN §7, top-level#19; Helios cannot import mss). The
// opaque ref *is* a published URL surface — it appears in approved
// Google-Ads final URLs and in emitted links/canonicals — so the
// algorithm, scope string, version token, truncation length, and the
// non-production fallback secret are frozen. `opaqueRef.test.ts` asserts
// the exact same known-answer vectors mss freezes; a vector failure means
// "you just broke the URL contract" and the fix is to revert, never to
// regenerate the constant.
//
// This module is deliberately pure: it reads no environment and the secret
// is always passed in, so the one authoritative derivation stays testable
// with the golden vectors. The secret-reading wrapper lives in `secret.ts`.

import { createHmac } from 'node:crypto'

/**
 * The deterministic fallback secret used in non-deployed (local/CI)
 * environments. MUST byte-match mss's
 * `nonProductionFallbackPublicTokenSecret` so golden vectors and
 * non-prod manifests agree across the two repos.
 */
export const nonProductionFallbackPublicTokenSecret =
  'freshlybakedus-nonproduction-public-token-secret'

/** Truncation length of every opaque public ref (base64url chars). */
export const freshlyBakedUsOpaquePublicRefLength = 20

/**
 * The one authoritative derivation. `HMAC-SHA256(secret, "v1\0scope\0value")`
 * base64url-encoded and truncated. The `v1` here is the *scheme* version
 * shared by every opaque surface (`/go/` redirects, image tokens, the
 * branding slug); the per-surface value may carry its own version token.
 */
export function deriveFreshlyBakedUsOpaquePublicRef(
  secret: string,
  scope: string,
  internalValue: string,
): string {
  return createHmac('sha256', secret)
    .update(`v1\u0000${scope}\u0000${internalValue}`, 'utf8')
    .digest('base64url')
    .slice(0, freshlyBakedUsOpaquePublicRefLength)
}

// --- `branding/` family opaque slug -------------------------------------
//
// The branding SLUG segment is made brand-name-free exactly as the
// compare/conquest families already are (parent EPIC_PLAN §0/§6.3). The
// ref is keyed on the **immutable Helios brand id** (`sweedBrandId`) —
// never the display name, storefront slug, array index, or any mutable
// copy — so a brand's public URL stays valid forever even if its
// name/slug changes (parent §7). The scope namespaces branding away from
// the other opaque surfaces, and the version token is a future rotation
// lever that does not require rotating the URL-stability secret.

export const freshlyBakedUsBrandOpaqueRefScope = 'fbus-branding'
export const freshlyBakedUsBrandOpaqueRefVersion = 'v1'

export function deriveFreshlyBakedUsBrandOpaqueRef(secret: string, sweedBrandId: number): string {
  return deriveFreshlyBakedUsOpaquePublicRef(
    secret,
    freshlyBakedUsBrandOpaqueRefScope,
    `${freshlyBakedUsBrandOpaqueRefVersion}\u0000${String(sweedBrandId)}`,
  )
}
