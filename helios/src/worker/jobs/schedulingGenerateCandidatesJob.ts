import { randomUUID } from 'node:crypto'

import type { QueryResultRow } from 'pg'

import {
  NormalizedSolverInputSchema,
  applySchedulingWeeklyHoursPolicy,
  type SchedulingGenerateCandidatesJobPayload,
} from '../../shared/contracts/index.js'
import { appendAuditEvent } from '../../server/audit/appendAuditEvent.js'
import { getPool } from '../../server/db/pool.js'
import { withTransaction } from '../../server/db/tx.js'
import { buildScheduleCandidates } from '../scheduling/engine.js'

interface SchedulingRunRow extends QueryResultRow {
  id: number
  normalized_input_json: unknown
  requested_candidate_count: number
}

export async function runSchedulingGenerateCandidatesJob(
  context: { id: number },
  payload: SchedulingGenerateCandidatesJobPayload,
): Promise<void> {
  const startResult = await getPool().query(
    `
      update scheduling_runs
      set status = 'generating',
          latest_error = null,
          current_job_id = $2,
          updated_at = now()
      where id = $1
        and current_job_id = $2
        and status = 'generating'
    `,
    [payload.schedulingRunId, context.id],
  )
  if (startResult.rowCount === 0) {
    return
  }

  try {
    const run = await loadSchedulingRun(payload.schedulingRunId)
    const normalizedInput = applySchedulingWeeklyHoursPolicy(NormalizedSolverInputSchema.parse(run.normalized_input_json))
    if (normalizedInput.employees.length === 0 || normalizedInput.shiftRequirements.length === 0) {
      throw new Error('Scheduling candidate generation requires at least one employee and one shift requirement.')
    }

    const candidates = buildScheduleCandidates(normalizedInput, run.requested_candidate_count)
    if (candidates.length === 0) {
      throw new Error('Scheduling candidate generation could not produce any candidates from the current normalized input.')
    }

    await withTransaction(async (db) => {
      const ownershipResult = await db.query<QueryResultRow>(
        `
          select 1
          from scheduling_runs
          where id = $1
            and current_job_id = $2
            and status = 'generating'
          for update
        `,
        [payload.schedulingRunId, context.id],
      )
      if (ownershipResult.rowCount === 0) {
        return
      }

      await db.query('delete from scheduling_candidates where scheduling_run_id = $1', [payload.schedulingRunId])

      for (const [index, candidate] of candidates.entries()) {
        await db.query(
          `
            insert into scheduling_candidates (
              scheduling_run_id,
              rank,
              candidate_code,
              label,
              summary,
              metrics_json,
              schedule_json
            )
            values ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb)
          `,
          [
            payload.schedulingRunId,
            index + 1,
            candidate.candidateCode,
            candidate.label,
            candidate.summary,
            JSON.stringify(candidate.metrics),
            JSON.stringify(candidate),
          ],
        )
      }

      await db.query(
        `
          update scheduling_runs
          set status = 'ready',
              selected_candidate_id = null,
              latest_error = null,
              updated_at = now()
          where id = $1
        `,
        [payload.schedulingRunId],
      )

      await appendAuditEvent(db, {
        actorType: 'system',
        actorUserId: null,
        entityId: String(payload.schedulingRunId),
        entityType: 'scheduling_run',
        eventType: 'scheduling.run.candidates_generated',
        module: 'scheduling',
        payload: {
          candidateCount: candidates.length,
          requestedCandidateCount: run.requested_candidate_count,
          schedulingRunId: payload.schedulingRunId,
        },
        requestId: randomUUID(),
        scope: {
          entityId: String(payload.schedulingRunId),
          entityType: 'scheduling_run',
        },
        undoPayload: null,
      })
    })
  } catch (error) {
    const failureResult = await getPool().query(
      `
        update scheduling_runs
        set status = 'failed',
            latest_error = $2,
            updated_at = now()
        where id = $1
          and current_job_id = $3
      `,
      [payload.schedulingRunId, error instanceof Error ? error.message : 'Unknown scheduling generation error.', context.id],
    )
    if (failureResult.rowCount === 0) {
      return
    }
    throw error
  }
}

async function loadSchedulingRun(schedulingRunId: number): Promise<SchedulingRunRow> {
  const result = await getPool().query<SchedulingRunRow>(
    `
      select id, normalized_input_json
      , requested_candidate_count
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
