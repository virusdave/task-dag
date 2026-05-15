import type { QueryResultRow } from 'pg'

import type { LlmRunDetailResponse } from '../../../shared/contracts/api/llm.js'
import type { JsonValue } from '../../../shared/contracts/common/json.js'
import type { Queryable } from '../pool.js'
import { toIsoString } from './helpers.js'

interface LlmRunRow extends QueryResultRow {
  brand_name: string | null
  catalog_group_id: number
  category_name: string | null
  created_at: Date
  created_by_user: string | null
  forced_refresh: boolean
  group_name: string
  id: number
  input_json: JsonValue
  parsed_output_json: JsonValue | null
  prompt_version: string
  proposal_batch_id: number | null
  proposal_row_id: number | null
  purpose: string
  raw_output_text: string
  status: string
  subcategory_name: string | null
  supersedes_run_id: number | null
  validation_issues_json: JsonValue
}

interface LineItemIdRow extends QueryResultRow {
  id: number
}

export async function getLlmRunDetail(db: Queryable, llmRunId: number): Promise<LlmRunDetailResponse | null> {
  const result = await db.query<LlmRunRow>(
    `
      select
        lr.id,
        lr.catalog_group_id,
        lr.proposal_row_id,
        lr.purpose,
        lr.status,
        lr.forced_refresh,
        lr.model,
        lr.prompt_version,
        lr.created_at,
        lr.input_json,
        lr.raw_output_text,
        lr.parsed_output_json,
        lr.validation_issues_json,
        lr.supersedes_run_id,
        u.name as created_by_user,
        cg.group_name,
        cg.brand_name,
        cg.category_name,
        cg.subcategory_name,
        pr.proposal_batch_id
      from llm_runs lr
      inner join catalog_groups cg on cg.id = lr.catalog_group_id
      left join users u on u.id = lr.created_by_user_id
      left join proposal_rows pr on pr.id = lr.proposal_row_id
      where lr.id = $1
    `,
    [llmRunId],
  )

  const row = result.rows[0]
  if (!row) {
    return null
  }

  let lineItemIds: number[] = []
  if (row.proposal_row_id !== null) {
    const lineItemResult = await db.query<LineItemIdRow>(
      `
        select id
        from proposal_line_items
        where proposal_row_id = $1
        order by id asc
      `,
      [row.proposal_row_id],
    )
    lineItemIds = lineItemResult.rows.map((lineItemRow) => lineItemRow.id)
  }

  return {
    groupSummary: {
      brandName: row.brand_name,
      catalogGroupId: row.catalog_group_id,
      categoryName: row.category_name,
      groupName: row.group_name,
      subcategoryName: row.subcategory_name,
    },
    proposalContext: row.proposal_row_id && row.proposal_batch_id
      ? {
          lineItemIds,
          proposalBatchId: row.proposal_batch_id,
          proposalRowId: row.proposal_row_id,
        }
      : null,
    run: {
      catalogGroupId: row.catalog_group_id,
      createdAt: toIsoString(row.created_at) ?? new Date(0).toISOString(),
      createdByUser: row.created_by_user,
      forcedRefresh: row.forced_refresh,
      inputJson: row.input_json,
      llmRunId: row.id,
      model: row.model,
      parsedOutputJson: row.parsed_output_json,
      promptVersion: row.prompt_version,
      purpose: row.purpose,
      rawOutputText: row.raw_output_text,
      status: row.status,
      supersedesRunId: row.supersedes_run_id,
      validationIssues: row.validation_issues_json,
    },
  }
}
