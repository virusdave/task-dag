#!/usr/bin/env node
/**
 * Regenerate every currently-pending description proposal under the
 * latest `DEFAULT_DESCRIPTION_PROMPT_VERSION`.
 *
 * One-off operator script. Pulls every distinct `catalog_group_id`
 * that still has a `proposal_line_items` row with
 * `field_path = 'description'` and `approval_status = 'pending'`,
 * chunks them into N-group description batches, and enqueues a
 * `proposal.generate.description_batch` job per chunk.
 *
 * Run on the helios prod host (vps-nixos-3) so the env config + DB
 * URL match the live worker / server:
 *
 *   cd /var/lib/helios/automation/helios
 *   node scripts/regenerate-pending-descriptions.mjs                 # dry-run
 *   node scripts/regenerate-pending-descriptions.mjs --apply         # actually enqueue
 *   node scripts/regenerate-pending-descriptions.mjs --apply --chunkSize=25
 *
 * Requires the helios server tree to have been built (`npm run
 * build:server`) so this script can import the compiled enqueue +
 * pool helpers without spinning up tsx.
 */
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { existsSync } from 'node:fs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const heliosRoot = resolve(__dirname, '..')

function parseArgs(argv) {
  const out = { apply: false, chunkSize: 50, reason: 'prompt-version-bump' }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--apply') {
      out.apply = true
      continue
    }
    if (arg.startsWith('--chunkSize=')) {
      out.chunkSize = Number.parseInt(arg.slice('--chunkSize='.length), 10)
      if (!Number.isFinite(out.chunkSize) || out.chunkSize < 1) {
        throw new Error(`Invalid --chunkSize: ${arg}`)
      }
      continue
    }
    if (arg.startsWith('--reason=')) {
      out.reason = arg.slice('--reason='.length)
      continue
    }
    throw new Error(`Unknown argument: ${arg}`)
  }
  return out
}

async function main() {
  const args = parseArgs(process.argv.slice(2))

  const distIndicator = resolve(heliosRoot, 'dist/server/server/db/pool.js')
  if (!existsSync(distIndicator)) {
    throw new Error(
      `Built helios server tree not found at ${distIndicator}. ` +
        `Run \`npm run build:server\` inside helios/ first.`,
    )
  }

  const { getPool, closePool } = await import(distIndicator)
  const { withTransaction } = await import(
    resolve(heliosRoot, 'dist/server/server/db/tx.js')
  )
  const { enqueueJob } = await import(
    resolve(heliosRoot, 'dist/server/server/jobs/enqueueJob.js')
  )
  const { appendAuditEvent } = await import(
    resolve(heliosRoot, 'dist/server/server/audit/appendAuditEvent.js')
  )
  const {
    DEFAULT_DESCRIPTION_LLM_MODEL,
    DEFAULT_DESCRIPTION_PROMPT_VERSION,
  } = await import(
    resolve(heliosRoot, 'dist/server/shared/domain/descriptionGeneration.js')
  )

  try {
    const pool = getPool()
    const pendingGroups = await pool.query(
      `
        select distinct catalog_group_id
        from proposal_line_items
        where field_path = 'description'
          and approval_status = 'pending'
          and catalog_group_id is not null
        order by catalog_group_id
      `,
    )

    /** @type {number[]} */
    const groupIds = pendingGroups.rows.map((r) => Number(r.catalog_group_id))
    process.stdout.write(
      `[regen] ${groupIds.length} catalog groups have a pending description proposal_line_item.\n`,
    )
    process.stdout.write(
      `[regen] target prompt version: ${DEFAULT_DESCRIPTION_PROMPT_VERSION}\n`,
    )
    process.stdout.write(
      `[regen] target model:          ${DEFAULT_DESCRIPTION_LLM_MODEL}\n`,
    )

    if (groupIds.length === 0) {
      process.stdout.write('[regen] nothing to do.\n')
      return
    }

    /** @type {number[][]} */
    const chunks = []
    for (let i = 0; i < groupIds.length; i += args.chunkSize) {
      chunks.push(groupIds.slice(i, i + args.chunkSize))
    }
    process.stdout.write(
      `[regen] will enqueue ${chunks.length} description batches (chunkSize=${args.chunkSize}).\n`,
    )

    if (!args.apply) {
      process.stdout.write(
        '[regen] DRY RUN — re-run with --apply to actually enqueue jobs.\n',
      )
      return
    }

    let totalEnqueued = 0
    for (const [chunkIndex, chunkGroupIds] of chunks.entries()) {
      const { proposalBatchId, jobId } = await withTransaction(async (db) => {
        const proposalBatchInsert = await db.query(
          `
            insert into proposal_batches (
              type,
              source,
              trigger_mode,
              status,
              prompt_version,
              model,
              summary_json,
              config_json,
              created_by_user_id
            )
            values ('description', 'generated', 'ui', 'draft', $1, $2, $3::jsonb, $4::jsonb, null)
            returning id
          `,
          [
            DEFAULT_DESCRIPTION_PROMPT_VERSION,
            DEFAULT_DESCRIPTION_LLM_MODEL,
            JSON.stringify({
              generatedGroupCount: 0,
              generatedLineItemCount: 0,
              requestedGroupCount: chunkGroupIds.length,
              regenReason: args.reason,
            }),
            JSON.stringify({
              catalogGroupIds: chunkGroupIds,
              forceLiveRefresh: false,
            }),
          ],
        )
        const batchId = Number(proposalBatchInsert.rows[0].id)

        const newJobId = await enqueueJob(db, {
          concurrencyKey: null,
          dedupeKey: `proposal.generate.description_batch:${batchId}`,
          jobType: 'proposal.generate.description_batch',
          module: 'catalog',
          payload: {
            forceLiveRefresh: false,
            proposalBatchId: batchId,
            requestedByUserId: null,
            trigger: 'regenerate-pending',
          },
          requestedByUserId: null,
        })

        await db.query(
          'update proposal_batches set job_id = $2 where id = $1',
          [batchId, newJobId],
        )

        await appendAuditEvent(db, {
          actorType: 'system',
          actorUserId: null,
          entityId: String(batchId),
          entityType: 'proposal_batch',
          eventType: 'proposal.batch.generation_requested',
          module: 'catalog',
          payload: {
            catalogGroupIds: chunkGroupIds,
            forceLiveRefresh: false,
            proposalBatchId: batchId,
            proposalType: 'description',
            queuedJobId: newJobId,
            requestedReason: args.reason,
            triggeredBy: 'regenerate-pending-descriptions.mjs',
          },
          requestId: `regen-descriptions-${Date.now()}-${chunkIndex}`,
          undoPayload: null,
        })

        return { proposalBatchId: batchId, jobId: newJobId }
      })

      totalEnqueued += chunkGroupIds.length
      process.stdout.write(
        `[regen] chunk ${chunkIndex + 1}/${chunks.length}: proposal_batch=${proposalBatchId} job=${jobId} groups=${chunkGroupIds.length}\n`,
      )
    }

    process.stdout.write(
      `[regen] enqueued ${chunks.length} batches covering ${totalEnqueued} catalog groups.\n`,
    )
  } finally {
    await closePool()
  }
}

main().catch((error) => {
  process.stderr.write(
    `regenerate-pending-descriptions failed: ${error?.stack ?? error}\n`,
  )
  process.exit(1)
})
