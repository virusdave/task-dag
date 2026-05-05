import { randomUUID } from 'node:crypto'

import type { QueryResultRow } from 'pg'

import type { SchedulingExtractConstraintsJobPayload } from '../../shared/contracts/index.js'
import { appendAuditEvent } from '../../server/audit/appendAuditEvent.js'
import { getPool } from '../../server/db/pool.js'
import { withTransaction } from '../../server/db/tx.js'
import { pageDave } from '../runtime/pageDave.js'
import { extractSchedulingConstraints } from '../scheduling/extractConstraints.js'

interface SchedulingRunRow extends QueryResultRow {
  id: number
  page_on_extraction_result: boolean
  schedule_week_end_date: string | null
  schedule_week_start_date: string | null
  source_text: string
  status: string
  title: string
}

export async function runSchedulingExtractConstraintsJob(
  context: { id: number },
  payload: SchedulingExtractConstraintsJobPayload,
): Promise<void> {
  const run = await loadSchedulingRun(payload.schedulingRunId)
  if (run.status === 'needs_review' || run.status === 'ready') {
    return
  }

  const startResult = await getPool().query(
    `
      update scheduling_runs
      set status = 'extracting',
          latest_error = null,
          current_job_id = $2,
          updated_at = now()
      where id = $1
        and current_job_id = $2
        and status in ('queued', 'extracting')
    `,
    [payload.schedulingRunId, context.id],
  )
  if (startResult.rowCount === 0) {
    return
  }

  try {
    if (!run.schedule_week_start_date || !run.schedule_week_end_date) {
      throw new Error('Scheduling extraction requires a Sunday-through-Saturday scheduling week.')
    }

    const extraction = await extractSchedulingConstraints({
      scheduleWeek: {
        endDate: run.schedule_week_end_date,
        startDate: run.schedule_week_start_date,
      },
      sourceText: run.source_text,
    })
    const persistedExtraction = await withTransaction(async (db) => {
      const ownershipResult = await db.query<QueryResultRow>(
        `
          select 1
          from scheduling_runs
          where id = $1
            and current_job_id = $2
            and status = 'extracting'
          for update
        `,
        [payload.schedulingRunId, context.id],
      )
      if (ownershipResult.rowCount === 0) {
        return false
      }

      await db.query(
        `
          update scheduling_runs
          set status = 'needs_review',
              extraction_model = $2,
              extraction_prompt_version = $3,
              extracted_constraints_json = $4::jsonb,
              normalized_input_json = $5::jsonb,
              validation_issues_json = $6::jsonb,
              latest_error = null,
              updated_at = now()
          where id = $1
        `,
        [
          payload.schedulingRunId,
          extraction.model,
          extraction.promptVersion,
          JSON.stringify(extraction.extractedConstraints),
          JSON.stringify(extraction.normalizedInput),
          JSON.stringify(extraction.validationIssues),
        ],
      )

      await appendAuditEvent(db, {
        actorType: 'system',
        actorUserId: null,
        entityId: String(payload.schedulingRunId),
        entityType: 'scheduling_run',
        eventType: 'scheduling.run.extracted',
        module: 'scheduling',
        payload: {
          extractedEmployeeCount: extraction.extractedConstraints.employees.length,
          extractedShiftRequirementCount: extraction.extractedConstraints.shiftRequirements.length,
          model: extraction.model,
          promptVersion: extraction.promptVersion,
          scheduleWeek: extraction.normalizedInput.scheduleWeek,
          schedulingRunId: payload.schedulingRunId,
          validationIssueCount: extraction.validationIssues.length,
        },
        requestId: randomUUID(),
        scope: {
          entityId: String(payload.schedulingRunId),
          entityType: 'scheduling_run',
        },
        undoPayload: null,
      })

      return true
    })

    if (!persistedExtraction) {
      return
    }

    await maybePageExtractionResult(run, {
      result: `Extraction finished for scheduling run ${payload.schedulingRunId} (${run.title}). ${extraction.extractedConstraints.employees.length} employees, ${extraction.extractedConstraints.shiftRequirements.length} weekly shift templates, ${extraction.validationIssues.length} validation issue${extraction.validationIssues.length === 1 ? '' : 's'}.`,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown scheduling extraction error.'
    const failureResult = await getPool().query(
      `
        update scheduling_runs
        set status = 'failed',
            latest_error = $2,
            updated_at = now()
        where id = $1
          and current_job_id = $3
      `,
      [payload.schedulingRunId, message, context.id],
    )
    if (failureResult.rowCount === 0) {
      return
    }

    await maybePageExtractionResult(run, {
      result: `Extraction failed for scheduling run ${payload.schedulingRunId} (${run.title}). ${message}`,
    })
    throw error
  }
}

async function loadSchedulingRun(schedulingRunId: number): Promise<SchedulingRunRow> {
  const result = await getPool().query<SchedulingRunRow>(
    `
      select id, page_on_extraction_result, source_text, status, title, schedule_week_start_date::text, schedule_week_end_date::text
      from scheduling_runs
      where id = $1
    `,
    [schedulingRunId],
  )

  const row = result.rows[0]
  if (!row) {
    throw new Error(`Scheduling run ${schedulingRunId} not found.`)
  }
  return row
}

async function maybePageExtractionResult(
  run: Pick<SchedulingRunRow, 'id' | 'page_on_extraction_result' | 'title'>,
  input: { result: string },
): Promise<void> {
  if (!run.page_on_extraction_result) {
    return
  }

  try {
    await pageDave(input.result)
  } catch (error) {
    console.error(`Failed to page Dave for scheduling run ${run.id}:`, error)
  }
}
