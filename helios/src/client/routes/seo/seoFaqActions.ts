// Shared SEO FAQ lifecycle mutations (#46 P5).
//
// Single-sources the approve / reject / submit request shapes so the editor
// and the review page can never drift on what they POST. The IRONCLAD
// approval logic itself lives server-side (re-verifies the fingerprint,
// re-runs the compliance check, writes the approval ledger); these are thin,
// correctly-shaped client callers of those endpoints.
//
// task dce1a56 (P5) · child FreshlyBakedNYC/automation#46

import { SeoFaqSetDetailResponseSchema } from '../../../shared/contracts/index.js'
import { mutateJson } from '../../app/fetchJson.js'

/**
 * APPROVE one FAQ set — the IRONCLAD human gate. Echoes the exact content
 * fingerprint the reviewer saw so the server can reject (409) if the content
 * changed after load.
 */
export function approveFaqSet(
  faqSetId: string,
  expectedContentSha256: string,
  note?: string,
): Promise<unknown> {
  return mutateJson(`/api/seo/faq-sets/${faqSetId}/approve`, SeoFaqSetDetailResponseSchema, {
    method: 'POST',
    body: JSON.stringify({ expectedContentSha256, note: note || undefined }),
  })
}

/** REJECT one FAQ set (clears any approval, marks rejected). */
export function rejectFaqSet(faqSetId: string, note?: string): Promise<unknown> {
  return mutateJson(`/api/seo/faq-sets/${faqSetId}/reject`, SeoFaqSetDetailResponseSchema, {
    method: 'POST',
    body: JSON.stringify({ note: note || undefined }),
  })
}
