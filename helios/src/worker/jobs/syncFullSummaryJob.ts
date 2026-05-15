import type { CatalogSyncFullSummaryJobPayload } from '../../shared/contracts/domain/jobs.js'
import { getPool } from '../../server/db/pool.js'
import { SWEED_SESSION_CONCURRENCY_KEY } from '../../server/jobs/concurrency.js'

export async function runCatalogSyncFullSummaryJob(payload: CatalogSyncFullSummaryJobPayload): Promise<void> {
  await getPool().query(
    `
      insert into job_queue (
        job_type,
        dedupe_key,
        concurrency_key,
        module_code,
        scope_entity_type,
        scope_entity_id,
        catalog_group_id,
        payload_json,
        status,
        run_at,
        requested_by_user_id
      )
      select
        'catalog.sync.group_detail',
        'catalog.sync.group_detail:' || cg.id,
        $2,
        'catalog',
        'catalog_group',
        cg.id::text,
        cg.id,
        jsonb_build_object(
          'catalogGroupId',
          cg.id,
          'forceLiveRefresh',
          true,
          'requestedByUserId',
          $1::bigint,
          'trigger',
          'full_summary'
        ),
        'queued',
        now(),
        $1::bigint
      from catalog_groups cg
      where cg.deleted_at is null
      on conflict do nothing
    `,
    [payload.requestedByUserId ?? null, SWEED_SESSION_CONCURRENCY_KEY],
  )
}
