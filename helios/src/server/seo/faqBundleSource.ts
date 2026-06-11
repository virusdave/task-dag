// Load APPROVED FAQ sets from the control-plane DB into the shape the SEO
// bundle compiler consumes (contracts.ts FaqSet[]). This is the layer that
// turns operator-approved DB content into bundle candidates — used by the
// `seo-bundle build --faq-from-db` dry-run path.
//
// The pure compiler (compile.ts) stays I/O-free; ALL ledger verification
// lives here. We do not TRUST `seo_faq_sets.approval_id`: we join the
// append-only `seo_approvals` ledger and re-verify, for every approved row,
// that
//   • a ledger row exists for the bound approval_id,
//   • it is a `faq_set` approval for THIS faq_set_id,
//   • its recorded content_sha256 matches the row's stored fingerprint,
//   • and that fingerprint matches a freshly recomputed hash of the row's
//     actual content.
// Any mismatch fails the build LOUDLY (never silently omitted) — a broken
// approval record must stop a publish, not quietly drop content.
//
// child FreshlyBakedNYC/automation#44 (P3) · Satisfies: virusdave/top-level#15

import { FaqSetSchema, type FaqSet } from './contracts.js'
import { faqSetContentSha256, type FaqItemInput } from './faqContent.js'
import type { Queryable } from '../db/pool.js'

export class FaqBundleSourceError extends Error {
  constructor(public readonly problems: string[]) {
    super(`Approved FAQ set verification failed:\n  - ${problems.join('\n  - ')}`)
    this.name = 'FaqBundleSourceError'
  }
}

interface ApprovedFaqRow {
  faq_set_id: string
  scope: string
  items: unknown
  content_sha256: string
  approval_id: string | null
  approval_kind: string | null
  approval_ref: string | null
  approval_sha256: string | null
}

function parseItems(raw: unknown): FaqItemInput[] {
  if (!Array.isArray(raw)) {
    return []
  }
  return raw.map((item) => {
    const obj = (item ?? {}) as Record<string, unknown>
    return {
      question: typeof obj.question === 'string' ? obj.question : '',
      answer_raw: typeof obj.answer_raw === 'string' ? obj.answer_raw : '',
      answer_sanitized:
        typeof obj.answer_sanitized === 'string' ? obj.answer_sanitized : '',
    }
  })
}

/**
 * Fetch every `approved` FAQ set, verify the approval ledger join + hash
 * for each, and return them as validated contract FaqSet objects ready for
 * compileSeoBundle(). Throws FaqBundleSourceError if any approved row is
 * inconsistent.
 */
export async function loadApprovedFaqSetsForBundle(db: Queryable): Promise<FaqSet[]> {
  const result = await db.query<ApprovedFaqRow>(
    `
      select
        f.faq_set_id,
        f.scope,
        f.items,
        f.content_sha256,
        f.approval_id,
        a.content_kind as approval_kind,
        a.content_ref  as approval_ref,
        a.content_sha256 as approval_sha256
      from seo_faq_sets f
      left join seo_approvals a on a.approval_id = f.approval_id
      where f.status = 'approved'
      order by f.faq_set_id
    `,
  )

  const problems: string[] = []
  const faqSets: FaqSet[] = []

  for (const row of result.rows) {
    const id = row.faq_set_id

    if (row.approval_id === null) {
      problems.push(`${id}: status=approved but approval_id is null.`)
      continue
    }
    if (row.approval_kind === null || row.approval_ref === null || row.approval_sha256 === null) {
      problems.push(`${id}: no seo_approvals ledger row for approval_id ${row.approval_id}.`)
      continue
    }
    if (row.approval_kind !== 'faq_set') {
      problems.push(
        `${id}: approval ${row.approval_id} has content_kind '${row.approval_kind}', expected 'faq_set'.`,
      )
      continue
    }
    if (row.approval_ref !== id) {
      problems.push(
        `${id}: approval ${row.approval_id} references content_ref '${row.approval_ref}', not this set.`,
      )
      continue
    }
    if (row.approval_sha256 !== row.content_sha256) {
      problems.push(
        `${id}: stored content_sha256 ${row.content_sha256} does not match the approved fingerprint ${row.approval_sha256}.`,
      )
      continue
    }

    const items = parseItems(row.items)
    const recomputed = faqSetContentSha256({ faq_set_id: id, scope: row.scope, items })
    if (recomputed !== row.content_sha256) {
      problems.push(
        `${id}: actual content hashes to ${recomputed} but the stored/approved fingerprint is ${row.content_sha256} (content changed without re-approval).`,
      )
      continue
    }

    const parsed = FaqSetSchema.safeParse({
      faq_set_id: id,
      scope: row.scope,
      approval_id: row.approval_id,
      items,
    })
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        problems.push(`${id}: ${issue.path.join('.') || '<root>'}: ${issue.message}`)
      }
      continue
    }
    faqSets.push(parsed.data)
  }

  if (problems.length > 0) {
    throw new FaqBundleSourceError(problems)
  }
  return faqSets
}
