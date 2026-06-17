// One-time (idempotent) importer for the hardcoded FB-NYC loyalty/rewards
// FAQ into the Helios SEO FAQ control plane (child
// FreshlyBakedNYC/automation#46, P1).
//
// Reads the verbatim source-of-truth captured in
// src/server/seo/faqImportFbNyc.ts (provenance pinned there) and writes a
// SINGLE control-plane DRAFT set keyed by source_key `fbus-global-faq`,
// scope `all`. It NEVER approves or publishes anything (canon §1): a human
// reviews raw+sanitized side-by-side in Marketing → "SEO · FAQ sets" and
// approves the exact content through the IRONCLAD gate; only then can the
// operator-only bundle publisher ship it.
//
// Idempotent: re-running with unchanged source content is a no-op; a changed
// source updates the same draft (resetting it to `draft` and clearing any
// stale approval).
//
// PREREQUISITE: migrations 071 (seo_faq_control_plane) and 083
// (seo_faq_sets.source_key) must already be applied to the target DB.
//
// Usage:
//   DATABASE_URL=postgres://... \
//     npx tsx scripts/import-fb-nyc-faq.ts --user-id=<heliosUserId> [--dry-run]
//
// Satisfies: virusdave/top-level#17 · Phase: P1

import { closePool, getPool } from '../src/server/db/pool.js'
import {
  getSeoFaqSetBySourceKey,
  importFaqSetBySourceKey,
} from '../src/server/db/queries/seoFaqQueries.js'
import { checkFaqSetApprovable } from '../src/server/seo/faqContent.js'
import {
  FB_NYC_FAQ_SCOPE,
  FB_NYC_FAQ_SOURCE_KEY,
  FB_NYC_FAQ_SOURCE_PROVENANCE,
  fbNycFaqImportMeta,
  fbNycFaqItemInputs,
} from '../src/server/seo/faqImportFbNyc.js'

function arg(args: string[], name: string): string | undefined {
  const prefix = `--${name}=`
  return args.find((a) => a.startsWith(prefix))?.slice(prefix.length)
}

function log(msg: string): void {
  // eslint-disable-next-line no-console
  console.log(`[import-fb-nyc-faq] ${msg}`)
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const dryRun = args.includes('--dry-run')
  const userIdRaw = arg(args, 'user-id')
  const userId = Number.parseInt(userIdRaw ?? '', 10)
  if (!Number.isInteger(userId) || userId <= 0) {
    throw new Error('missing/invalid required --user-id=<positive integer helios user id>')
  }

  const items = fbNycFaqItemInputs()
  log(
    `source ${FB_NYC_FAQ_SOURCE_PROVENANCE.repo}:${FB_NYC_FAQ_SOURCE_PROVENANCE.path} ` +
      `@ ${FB_NYC_FAQ_SOURCE_PROVENANCE.commitSha.slice(0, 12)} (${items.length} items)`,
  )
  log(`target: source_key=${FB_NYC_FAQ_SOURCE_KEY} scope=${FB_NYC_FAQ_SCOPE}`)

  // Surface compliance signal up front (advisory: the draft is still
  // imported for human review). The shared question + sanitized answers are
  // held to the stricter FBUS rule because the source key is FBUS.
  const problems = checkFaqSetApprovable(items, { sourceKey: FB_NYC_FAQ_SOURCE_KEY })
  if (problems.length === 0) {
    log('compliance: draft is currently approvable as-imported (no leak/ads-policy problems).')
  } else {
    log(`compliance: ${problems.length} problem(s) a human must resolve before approval:`)
    for (const p of problems) {
      log(`  - ${p.itemIndex < 0 ? '' : `item ${p.itemIndex + 1} (${p.field}): `}${p.message}`)
    }
  }

  const db = getPool()
  const generationMeta = fbNycFaqImportMeta()

  if (dryRun) {
    const existing = await getSeoFaqSetBySourceKey(db, FB_NYC_FAQ_SOURCE_KEY)
    log(
      existing
        ? `dry-run: a set already exists (faq_set_id=${existing.faqSetId}, status=${existing.status}); ` +
            're-import would update-on-change or no-op. No DB writes.'
        : 'dry-run: no existing set; import would CREATE a new draft. No DB writes.',
    )
    return
  }

  const result = await importFaqSetBySourceKey(db, {
    sourceKey: FB_NYC_FAQ_SOURCE_KEY,
    scope: FB_NYC_FAQ_SCOPE,
    items,
    source: 'manual',
    generationMeta,
    userId,
  })
  log(
    `${result.kind}: faq_set_id=${result.record.faqSetId} status=${result.record.status} ` +
      `content_sha256=${result.record.contentSha256.slice(0, 12)}…`,
  )
  log('done. Review + approve in Marketing → "SEO · FAQ sets"; publish stays operator-only.')
}

main()
  .then(async () => {
    await closePool()
    process.exit(0)
  })
  .catch(async (err) => {
    // eslint-disable-next-line no-console
    console.error(`[import-fb-nyc-faq] FAILED: ${err instanceof Error ? err.message : err}`)
    await closePool()
    process.exit(1)
  })
