// FBUS FAQ source-key model (child #46 P1). Pure, I/O-free, exhaustively
// unit-tested. Foundational for the rest of P1/P5: the approval-time
// FBUS-strict denylist (CI gate 2), the bundle-validation check
// (CI gate 3), and the hybrid sync/change-detection job all key off the
// source key to decide which FAQ sets are FBUS sanitized-mode.
//
// A *source key* is the STABLE, logical identity of an FAQ set's source,
// distinct from:
//   • `faq_set_id` — a minted, timestamp+random id that changes every time
//     a set is (re)created, so it can't be used to find "the same source"
//     across a regeneration / re-import; and
//   • `scope` — the bundle's site-id scope (a render-placement concept).
//
// The source key survives regeneration/re-import, so the sync loop
// (#46 P1, path (b)) can recompute a source's `content_sha256` and update
// THE SAME draft when an upstream source changes, and it encodes the HOST
// NAMESPACE so the control plane knows a set is FBUS (`.us`) sanitized-mode
// directly from the key — without consulting the manifest's site→mode map.
//
// Shape: `<host-ns>-<family>-faq`, all lowercase kebab, e.g.:
//   fbus-global-faq       — the shared/global FBUS set (not an LP family)
//   fbus-deliverance-faq  — an LP-family set
//   fbus-dedicated-faq    — the dedicated `/faq` page set (not an LP family)
//
// The `<family>` segment is an OPAQUE kebab slug here on purpose. The
// canonical LP-family list lives in exactly ONE place — the mss P0
// LP-family registry artifact, consumed by automation P5 (parent
// EPIC_PLAN §1 Q1) — so this model must NOT become a second, hand-edited
// family list. It only parses/validates the key STRUCTURE and classifies
// the host namespace; P5 builds per-family keys via `fbusFaqSourceKey()`
// from the registry's family ids.
//
// Satisfies: virusdave/top-level#17 · Phase: P1

import { z } from 'zod'

import type { SeoMode } from './contracts.js'

// ── host namespaces ───────────────────────────────────────────────────
//
// The host-namespace segment of a source key maps to the render mode every
// FAQ set under it MUST satisfy. FBUS (`freshlybaked.us`) is the
// SEO-sanitized host, so every `fbus-*` set is sanitized-mode and is held
// to the stricter FBUS denylist (`findFbusLeaks`, faqContent.ts) rather
// than the host-agnostic `RAW_ONLY_TERMS`. Add a namespace here (and the
// regex below picks it up automatically) when another host's FAQ sources
// are brought under the control plane.

export const FBUS_FAQ_SOURCE_NAMESPACE = 'fbus'

const FAQ_SOURCE_NAMESPACE_MODE: Readonly<Record<string, SeoMode>> = {
  [FBUS_FAQ_SOURCE_NAMESPACE]: 'sanitized',
}

// ── key grammar ───────────────────────────────────────────────────────
//
// `<host-ns>-<family>-faq`: a recognized host namespace (no internal
// hyphen), a kebab-slug family (one or more `-`-joined lowercase-alnum
// segments), and the literal `-faq` suffix that keeps keys self-describing.
// The namespace alternation is derived from the mode map above so the two
// can never drift.
const HOST_NAMESPACE_ALT = Object.keys(FAQ_SOURCE_NAMESPACE_MODE)
  .map((ns) => ns.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  .join('|')

export const FAQ_SOURCE_KEY_RE = new RegExp(
  `^(${HOST_NAMESPACE_ALT})-([a-z0-9]+(?:-[a-z0-9]+)*)-faq$`,
)

export interface ParsedFaqSourceKey {
  /** The full source key, echoed back for convenience. */
  readonly sourceKey: string
  /** The host-namespace segment, e.g. `fbus`. */
  readonly hostNamespace: string
  /** The opaque family slug, e.g. `global`, `deliverance`, `dedicated`. */
  readonly family: string
  /** The render mode every set under this key must satisfy. */
  readonly mode: SeoMode
  /** True iff this is an FBUS (`.us`, sanitized) source key. */
  readonly isFbus: boolean
}

/**
 * Parse `value` as a FAQ source key. Returns the parsed parts, or `null`
 * if `value` is not a structurally-valid key under a recognized host
 * namespace.
 */
export function parseFaqSourceKey(value: string): ParsedFaqSourceKey | null {
  const m = FAQ_SOURCE_KEY_RE.exec(value)
  if (!m) {
    return null
  }
  const hostNamespace = m[1]!
  const family = m[2]!
  return {
    sourceKey: value,
    hostNamespace,
    family,
    mode: FAQ_SOURCE_NAMESPACE_MODE[hostNamespace]!,
    isFbus: hostNamespace === FBUS_FAQ_SOURCE_NAMESPACE,
  }
}

/** True iff `value` is a structurally-valid FAQ source key. */
export function isFaqSourceKey(value: string): boolean {
  return FAQ_SOURCE_KEY_RE.test(value)
}

/** True iff `value` is an FBUS (`.us`, sanitized-mode) FAQ source key. */
export function isFbusFaqSourceKey(value: string): boolean {
  const parsed = parseFaqSourceKey(value)
  return parsed !== null && parsed.isFbus
}

/**
 * Build the canonical FBUS source key for an LP `family` slug
 * (`fbus-<family>-faq`). Throws on a malformed family so callers mint a
 * junk key loudly rather than silently. `family` must be lowercase
 * kebab-case (e.g. `deliverance`, `global`, `dedicated`).
 */
export function fbusFaqSourceKey(family: string): string {
  const key = `${FBUS_FAQ_SOURCE_NAMESPACE}-${family}-faq`
  if (!isFbusFaqSourceKey(key)) {
    throw new Error(
      `Invalid FBUS FAQ family slug ${JSON.stringify(family)} ` +
        `(must be lowercase kebab-case, e.g. "deliverance").`,
    )
  }
  return key
}

/** The family slug of `value`, or `null` if it is not a valid source key. */
export function familyFromFaqSourceKey(value: string): string | null {
  return parseFaqSourceKey(value)?.family ?? null
}

/**
 * The render mode every FAQ set under `value` must satisfy, or `null` if
 * `value` is not a recognized source key. `'sanitized'` => the set is held
 * to the stricter FBUS denylist (`findFbusLeaks`).
 */
export function seoModeForFaqSourceKey(value: string): SeoMode | null {
  return parseFaqSourceKey(value)?.mode ?? null
}

// ── well-known structural keys ────────────────────────────────────────
//
// `global` and `dedicated` are NOT LP families — they are the shared/global
// FBUS set and the dedicated `/faq` page set named in the epic. They are
// safe to pin here because they are structural, not part of the LP-family
// list (which stays single-sourced in the mss registry). Per-family keys
// are built at runtime via `fbusFaqSourceKey(familyId)`.

/** The shared/global FBUS FAQ set. */
export const FBUS_GLOBAL_FAQ_SOURCE_KEY = fbusFaqSourceKey('global')
/** The dedicated `/faq` page FBUS FAQ set. */
export const FBUS_DEDICATED_FAQ_SOURCE_KEY = fbusFaqSourceKey('dedicated')

// ── zod schemas ───────────────────────────────────────────────────────

/** Any structurally-valid FAQ source key. */
export const FaqSourceKeySchema = z.string().regex(FAQ_SOURCE_KEY_RE)
/** Specifically an FBUS (`.us`, sanitized) source key. */
export const FbusFaqSourceKeySchema = z
  .string()
  .refine(isFbusFaqSourceKey, {
    message: 'must be an FBUS FAQ source key of the form fbus-<family>-faq',
  })
