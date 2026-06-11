import { randomBytes } from 'node:crypto'

import { SEO_BUNDLE_ID_RE } from './contracts.js'

function pad(n: number, width: number): string {
  return String(n).padStart(width, '0')
}

/**
 * Mint a fresh, sortable SEO bundle id of the canonical form
 * `seob_YYYY-MM-DD_HHMMSS_<6 hex>` (parent EPIC_PLAN §5), in UTC. The
 * 6-hex suffix disambiguates two publishes in the same second.
 */
export function newSeoBundleId(now: Date = new Date()): string {
  const y = pad(now.getUTCFullYear(), 4)
  const mo = pad(now.getUTCMonth() + 1, 2)
  const d = pad(now.getUTCDate(), 2)
  const h = pad(now.getUTCHours(), 2)
  const mi = pad(now.getUTCMinutes(), 2)
  const s = pad(now.getUTCSeconds(), 2)
  const suffix = randomBytes(3).toString('hex')
  const id = `seob_${y}-${mo}-${d}_${h}${mi}${s}_${suffix}`
  /* istanbul ignore next — defensive; the format above always matches */
  if (!SEO_BUNDLE_ID_RE.test(id)) {
    throw new Error(`newSeoBundleId produced an invalid id: ${id}`)
  }
  return id
}

export function isSeoBundleId(value: string): boolean {
  return SEO_BUNDLE_ID_RE.test(value)
}
