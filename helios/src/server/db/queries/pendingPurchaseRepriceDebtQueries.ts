import type { QueryResultRow } from 'pg'

import { PENDING_PURCHASE_REPRICE_DEBT_THRESHOLD_MINUTES, type PendingPurchaseRepriceDebtResponse } from '../../../shared/contracts/index.js'
import type { Queryable } from '../pool.js'
import { PENDING_PURCHASE_TEMPORARY_UNSELLABLE_PRICE } from '../../../shared/domain/pendingPurchasePricing.js'

interface DebtRow extends QueryResultRow {
  count: number
  incomplete_creation_count: number
  oldest_age_minutes: number | null
  product_ids: number[]
  proposal_batch_ids: number[]
  recovery_job_ids: number[]
}

export async function getPendingPurchaseRepriceDebt(db: Queryable): Promise<PendingPurchaseRepriceDebtResponse> {
  const result = await db.query<DebtRow>(
    `with candidates as (
       select (ppr.last_apply_summary_json#>>'{pendingPurchaseCreatedSku,createdAt}')::timestamptz as created_at,
              ppr.last_apply_summary_json#>>'{pendingPurchaseCreatedSku,phase}' as phase,
              nullif(ppr.last_apply_summary_json#>>'{pendingPurchaseCreatedSku,productId}', '')::bigint as product_id,
              nullif(ppr.last_apply_summary_json#>>'{pendingPurchaseCreatedSku,repriceBatchId}', '')::bigint as proposal_batch_id,
              case
                when ppr.last_apply_summary_json#>>'{pendingPurchaseCreatedSku,phase}' = 'product_created'
                  then coalesce(
                    nullif(ppr.last_apply_summary_json#>>'{pendingPurchaseCreatedSku,repriceQueueJobId}', '')::bigint,
                    ppar.job_id
                  )
                else ppar.job_id
              end as recovery_job_id
       from pending_purchase_rows ppr
       left join pending_purchase_apply_requests ppar
         on ppar.id = nullif(ppr.last_apply_summary_json#>>'{pendingPurchaseCreatedSku,requestId}', '')::bigint
       where ppr.last_apply_summary_json#>>'{pendingPurchaseCreatedSku,repriceRequired}' = 'true'
     ), debt as (
       select c.* from candidates c
       left join catalog_group_products cgp on cgp.product_id = c.product_id
       where c.product_id is null or cgp.product_id is null or cgp.price = $1
     )
     select count(*)::int as count,
            count(*) filter (where phase <> 'product_created')::int as incomplete_creation_count,
            extract(epoch from (now() - min(created_at))) / 60.0 as oldest_age_minutes,
            coalesce((select array_agg(product_id order by product_id) from (select distinct product_id from debt where product_id is not null order by product_id limit 100) p), '{}') as product_ids,
            coalesce((select array_agg(proposal_batch_id order by proposal_batch_id) from (select distinct proposal_batch_id from debt where proposal_batch_id is not null order by proposal_batch_id limit 100) b), '{}') as proposal_batch_ids
            , coalesce((select array_agg(recovery_job_id order by recovery_job_id) from (select distinct recovery_job_id from debt where recovery_job_id is not null order by recovery_job_id limit 100) j), '{}') as recovery_job_ids
     from debt`,
    [PENDING_PURCHASE_TEMPORARY_UNSELLABLE_PRICE],
  )
  const row = result.rows[0]!
  const oldestAgeMinutes = row.oldest_age_minutes === null ? null : Number(row.oldest_age_minutes)
  return {
    count: row.count,
    incompleteCreationCount: row.incomplete_creation_count,
    oldestAgeMinutes,
    overdue: oldestAgeMinutes !== null && oldestAgeMinutes > PENDING_PURCHASE_REPRICE_DEBT_THRESHOLD_MINUTES,
    productIds: row.product_ids,
    proposalBatchIds: row.proposal_batch_ids,
    recoveryJobIds: row.recovery_job_ids,
    thresholdMinutes: PENDING_PURCHASE_REPRICE_DEBT_THRESHOLD_MINUTES,
  }
}
