import { useEffect, useState } from 'react'
import { Link, useLoaderData, useRevalidator } from 'react-router-dom'

import {
  DEFAULT_SCHEDULING_WEEK_DEFINITION,
  NormalizedSolverInputSchema,
  MutationAcceptedResponseSchema,
  QueueSchedulingCandidateGenerationAcceptedResponseSchema,
  QueueSchedulingCandidateGenerationRequestSchema,
  SaveSchedulingNormalizedInputRequestSchema,
  SchedulingRunDetailResponseSchema,
  SelectSchedulingCandidateRequestSchema,
  buildHeliosModulePath,
  type NormalizedSolverInput,
  type SchedulingRunDetailResponse,
} from '../../../shared/contracts/index.js'
import { loadJson, mutateJson } from '../../app/fetchJson.js'
import { Pill } from '../../components/Pill.js'
import { SchedulingCandidateResults } from './SchedulingCandidateResults.js'
import { SchedulingConstraintReview } from './SchedulingConstraintReview.js'
import {
  buildSchedulingCandidatePresentation,
  buildSchedulingCandidateSummaryText,
  formatCurrencyWithTotal,
  formatHoursWithTotal,
} from './schedulingResultsPresenter.js'
import { SchedulingNav } from './SchedulingNav.js'
import { formatScheduleWeekLabel } from './schedulingWeek.js'

export async function schedulingRunDetailLoader({ params }: { params: Record<string, string | undefined> }) {
  return loadJson(`/api/scheduling/runs/${params.schedulingRunId}`, SchedulingRunDetailResponseSchema)
}

export function SchedulingRunDetailPage() {
  const data = useLoaderData() as SchedulingRunDetailResponse
  const revalidator = useRevalidator()
  const reviewedNormalizedInput = data.run.normalizedInput ?? buildDraftNormalizedInput(data)
  const [copySourceNotesState, setCopySourceNotesState] = useState<'copied' | 'idle'>('idle')
  const [normalizedInputText, setNormalizedInputText] = useState(toPrettyJson(buildDraftNormalizedInput(data)))
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [isSaving, setIsSaving] = useState(false)
  const [isGenerating, setIsGenerating] = useState(false)
  const [isCancelling, setIsCancelling] = useState(false)
  const [isRunningNow, setIsRunningNow] = useState(false)
  const [selectingCandidateId, setSelectingCandidateId] = useState<number | null>(null)
  const isBackgroundWorkRunning = data.run.status === 'queued' || data.run.status === 'extracting' || data.run.status === 'generating'

  useEffect(() => {
    setNormalizedInputText(toPrettyJson(buildDraftNormalizedInput(data)))
  }, [data.run.extractedConstraints, data.run.normalizedInput, data.run.scheduleWeek])

  useEffect(() => {
    if (!isBackgroundWorkRunning) {
      return
    }

    const intervalId = window.setInterval(() => {
      if (revalidator.state === 'idle') {
        void revalidator.revalidate()
      }
    }, 5000)

    return () => window.clearInterval(intervalId)
  }, [isBackgroundWorkRunning, revalidator])

  async function handleSaveNormalizedInput() {
    setIsSaving(true)
    setErrorMessage(null)

    try {
      const normalizedInput = NormalizedSolverInputSchema.parse(parseNormalizedInputText(normalizedInputText))
      await mutateJson(
        `/api/scheduling/runs/${data.run.id}/normalized-input`,
        MutationAcceptedResponseSchema,
        {
          body: JSON.stringify(SaveSchedulingNormalizedInputRequestSchema.parse({ normalizedInput })),
          method: 'PUT',
        },
      )
      await revalidator.revalidate()
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Could not save the normalized input.')
    } finally {
      setIsSaving(false)
    }
  }

  async function handleGenerateCandidates() {
    setIsGenerating(true)
    setErrorMessage(null)

    try {
      await mutateJson(
        `/api/scheduling/runs/${data.run.id}/generate-candidates`,
        QueueSchedulingCandidateGenerationAcceptedResponseSchema,
        {
          body: JSON.stringify(QueueSchedulingCandidateGenerationRequestSchema.parse({
            reason: 'Generate schedule candidates from reviewed normalized input',
          })),
          method: 'POST',
        },
      )
      await revalidator.revalidate()
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Could not queue candidate generation.')
    } finally {
      setIsGenerating(false)
    }
  }

  async function handleCancelRun() {
    const confirmed = window.confirm('Cancel the current scheduling work and mark this run as failed?')
    if (!confirmed) {
      return
    }

    setIsCancelling(true)
    setErrorMessage(null)

    try {
      await mutateJson(
        `/api/scheduling/runs/${data.run.id}/cancel`,
        MutationAcceptedResponseSchema,
        {
          method: 'POST',
        },
      )
      await revalidator.revalidate()
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Could not cancel the current scheduling work.')
    } finally {
      setIsCancelling(false)
    }
  }

  async function handleRunNow() {
    setIsRunningNow(true)
    setErrorMessage(null)

    try {
      await mutateJson(
        `/api/scheduling/runs/${data.run.id}/run-now`,
        MutationAcceptedResponseSchema,
        {
          method: 'POST',
        },
      )
      await revalidator.revalidate()
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Could not make the queued scheduling job runnable now.')
    } finally {
      setIsRunningNow(false)
    }
  }

  async function handleSelectCandidate(candidateId: number) {
    setSelectingCandidateId(candidateId)
    setErrorMessage(null)

    try {
      await mutateJson(
        `/api/scheduling/runs/${data.run.id}/select-candidate`,
        MutationAcceptedResponseSchema,
        {
          body: JSON.stringify(SelectSchedulingCandidateRequestSchema.parse({ candidateId })),
          method: 'POST',
        },
      )
      await revalidator.revalidate()
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Could not select this candidate.')
    } finally {
      setSelectingCandidateId(null)
    }
  }

  async function handleCopySourceNotes() {
    await navigator.clipboard.writeText(data.run.sourceText)
    setCopySourceNotesState('copied')
    window.setTimeout(() => setCopySourceNotesState('idle'), 2000)
  }

  return (
    <section>
      <div className="page-header">
        <div>
          <p className="eyebrow">Scheduling Run</p>
          <h2>{data.run.title}</h2>
          <p className="subtle-copy">
            Run #{data.run.id} · {new Date(data.run.createdAt).toLocaleString()} · {data.run.createdByUser ?? 'Unknown user'}
          </p>
          {data.run.scheduleWeek ? <p className="subtle-copy">Window: {formatScheduleWeekLabel(data.run.scheduleWeek)}</p> : null}
          <p className="subtle-copy">
            Review the extracted constraints, correct the normalized input JSON if needed, then generate candidate schedules.
          </p>
        </div>
        <div className="inline-row wrap-row">
          <Pill tone={toneForStatus(data.run.status)}>{labelForStatus(data.run.status)}</Pill>
          {data.run.pageOnExtractionResult ? <Pill tone="warning">Page on extraction result</Pill> : null}
          {data.run.selectedCandidateId ? <Pill tone="success">Final candidate selected</Pill> : null}
          {isBackgroundWorkRunning ? (
            <button className="ghost-button" disabled={isCancelling} onClick={() => void handleCancelRun()} type="button">
              {isCancelling ? 'Cancelling...' : 'Cancel'}
            </button>
          ) : null}
          <Link className="ghost-button like-button" to={buildHeliosModulePath('scheduling')}>
            Back to run history
          </Link>
        </div>
      </div>

      <SchedulingNav />

      {errorMessage ? <p className="error-text">{errorMessage}</p> : null}
      {data.run.latestError ? <p className="error-text">{data.run.latestError}</p> : null}

      <div className="pricing-metric-grid" style={{ marginBottom: '1rem' }}>
        <div className="value-panel">
          <span>Scheduling window</span>
          <p style={{ fontSize: '1rem' }}>{formatScheduleWeekLabel(data.run.scheduleWeek)}</p>
        </div>
        <div className="value-panel">
          <span>Requested candidates</span>
          <p>{data.run.requestedCandidateCount}</p>
        </div>
        <div className="value-panel">
          <span>Paging</span>
          <p>{data.run.pageOnExtractionResult ? 'On extraction result' : 'Off'}</p>
        </div>
        <div className="value-panel">
          <span>Employees</span>
          <p>{data.run.normalizedInput?.employees.length ?? data.run.extractedConstraints?.employees.length ?? 0}</p>
        </div>
        <div className="value-panel">
          <span>Weekly shift templates</span>
          <p>{data.run.normalizedInput?.shiftRequirements.length ?? data.run.extractedConstraints?.shiftRequirements.length ?? 0}</p>
        </div>
        <div className="value-panel">
          <span>Validation issues</span>
          <p>{data.run.validationIssues.length}</p>
        </div>
        <div className="value-panel">
          <span>Candidates</span>
          <p>{data.candidates.length}</p>
        </div>
      </div>

      <div className="detail-grid">
        <article className="detail-panel">
          <div className="page-header" style={{ marginBottom: '0.75rem' }}>
            <h3 style={{ margin: 0 }}>Source notes</h3>
            <button className="ghost-button" onClick={() => void handleCopySourceNotes()} type="button">
              {copySourceNotesState === 'copied' ? 'Copied' : 'Copy'}
            </button>
          </div>
          <pre style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{data.run.sourceText}</pre>
        </article>

        <article className="detail-panel">
          <h3>Extraction summary</h3>
          {data.run.extractedConstraints ? (
            <>
              <p className="subtle-copy">
                {data.run.extractedConstraints.employees.length} employees · {data.run.extractedConstraints.shiftRequirements.length} weekly shift templates
              </p>
              <p className="subtle-copy">Weekly hour limits and preferences are interpreted inside each Sunday-through-Saturday week across the selected scheduling window.</p>
              <p className="subtle-copy">If weekly max hours were omitted, Helios applies the company default of preference 32 hours and hard max 35 hours unless an operator explicitly overrides it.</p>
              {data.run.extractedConstraints.unknownEntities.length > 0 ? (
                <div style={{ marginBottom: '1rem' }}>
                  <strong>Unknown entities</strong>
                  <ul className="timeline-list" style={{ marginTop: '0.5rem' }}>
                    {data.run.extractedConstraints.unknownEntities.map((entity) => <li key={entity}>{entity}</li>)}
                  </ul>
                </div>
              ) : null}
              {data.run.validationIssues.length > 0 ? (
                <div>
                  <strong>Validation issues</strong>
                  <ul className="timeline-list" style={{ marginTop: '0.5rem' }}>
                    {data.run.validationIssues.map((issue) => (
                      <li key={`${issue.code}-${issue.message}`}>
                        <strong>{issue.severity}</strong> · {issue.message}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : (
                <p className="subtle-copy">No validation issues recorded yet.</p>
              )}
            </>
          ) : (
            <p className="subtle-copy">
              {isBackgroundWorkRunning ? 'Extraction is still running. This page refreshes automatically.' : 'No extraction result has been stored yet.'}
            </p>
          )}
        </article>
      </div>

      {data.run.extractedConstraints ? (
        <SchedulingConstraintReview
          extractedConstraints={data.run.extractedConstraints}
          normalizedInput={data.run.normalizedInput}
        />
      ) : null}

      <article className="detail-panel" style={{ marginTop: '1rem' }}>
        <div className="page-header" style={{ marginBottom: '0.75rem' }}>
          <div>
            <h3 style={{ margin: 0 }}>Queue and debug status</h3>
            <p className="subtle-copy">Use this to understand what the current scheduling job is waiting on, what happened most recently, and whether it is actually runnable.</p>
          </div>
          <div className="inline-row wrap-row">
            {data.debug.currentJob?.status === 'queued' ? (
              <button className="ghost-button" disabled={isRunningNow} onClick={() => void handleRunNow()} type="button">
                {isRunningNow ? 'Making runnable...' : 'Run now'}
              </button>
            ) : null}
            <Link
              className="ghost-button like-button"
              to={buildHeliosModulePath('scheduling', `../jobs?module=scheduling&scopeEntityType=scheduling_run&scopeEntityId=${data.run.id}`)}
            >
              Related jobs
            </Link>
            <Link
              className="ghost-button like-button"
              to={buildHeliosModulePath('scheduling', `../history?module=scheduling&scopeEntityType=scheduling_run&scopeEntityId=${data.run.id}`)}
            >
              Related history
            </Link>
          </div>
        </div>

        <div className="pricing-metric-grid" style={{ marginBottom: '1rem' }}>
          <div className="value-panel">
            <span>Current job</span>
            <p>{data.debug.currentJob ? `#${data.debug.currentJob.jobId}` : 'None'}</p>
          </div>
          <div className="value-panel">
            <span>Job status</span>
            <p>{data.debug.currentJob?.status ?? 'None'}</p>
          </div>
          <div className="value-panel">
            <span>Waiting reason</span>
            <p>{formatWaitingReason(data.debug.queue.waitingReason)}</p>
          </div>
          <div className="value-panel">
            <span>Queue ahead</span>
            <p>{data.debug.queue.queueAheadCount}</p>
          </div>
          <div className="value-panel">
            <span>Running jobs</span>
            <p>{data.debug.queue.runningJobCount}</p>
          </div>
          <div className="value-panel">
            <span>Eligible now</span>
            <p>{data.debug.queue.eligibleToRun ? 'Yes' : 'No'}</p>
          </div>
        </div>

        {data.debug.currentJob ? (
          <div style={{ marginBottom: '1rem' }}>
            <p className="subtle-copy">
              {data.debug.currentJob.jobType} · queued {formatTimestamp(data.debug.currentJob.createdAt)} · scheduled {formatTimestamp(data.debug.currentJob.runAt)}
            </p>
            {data.debug.currentJob.startedAt ? <p className="subtle-copy">Started {formatTimestamp(data.debug.currentJob.startedAt)}</p> : null}
            {data.debug.currentJob.finishedAt ? <p className="subtle-copy">Finished {formatTimestamp(data.debug.currentJob.finishedAt)}</p> : null}
            <p className="subtle-copy">Attempt {data.debug.currentJob.attemptCount + 1}</p>
            {data.debug.currentJob.lastError ? <p className="error-text">{data.debug.currentJob.lastError}</p> : null}
          </div>
        ) : null}

        <div className="detail-grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))' }}>
          <div>
            <strong>Blocking jobs</strong>
            <ul className="timeline-list" style={{ marginTop: '0.5rem' }}>
              {data.debug.queue.blockingJobs.map((job) => (
                <li key={job.jobId}>
                  <strong>#{job.jobId}</strong> · {job.jobType} · {job.status}
                  <div className="subtle-copy">{job.scope ? `${job.scope.entityType} ${job.scope.entityId}` : 'No scope'} · scheduled {formatTimestamp(job.runAt)}</div>
                </li>
              ))}
              {data.debug.queue.blockingJobs.length === 0 ? <li className="empty-state">No jobs are ahead of this run right now.</li> : null}
            </ul>
          </div>

          <div>
            <strong>Recent progress</strong>
            <ul className="timeline-list" style={{ marginTop: '0.5rem' }}>
              {data.debug.recentEvents.map((event) => (
                <li key={event.eventId}>
                  <strong>{event.eventType}</strong>
                  <div className="subtle-copy">{formatTimestamp(event.createdAt)} · {event.actorLabel}</div>
                </li>
              ))}
              {data.debug.recentEvents.length === 0 ? <li className="empty-state">No scheduling audit events recorded for this run yet.</li> : null}
            </ul>
          </div>
        </div>
      </article>

      <article className="detail-panel" style={{ marginTop: '1rem' }}>
        <div className="page-header" style={{ marginBottom: '0.75rem' }}>
          <div>
            <h3 style={{ margin: 0 }}>Normalized input review</h3>
            <p className="subtle-copy">Edit the reviewed JSON directly. Candidate generation uses this normalized input, not the raw text.</p>
          </div>
          <div className="inline-row wrap-row">
            <button className="ghost-button" disabled={isSaving} onClick={() => void handleSaveNormalizedInput()} type="button">
              {isSaving ? 'Saving...' : 'Save normalized input'}
            </button>
            <button
              className="primary-button"
              disabled={isGenerating || isBackgroundWorkRunning || isCancelling}
              onClick={() => void handleGenerateCandidates()}
              type="button"
            >
              {isGenerating ? `Queueing ${data.run.requestedCandidateCount} candidates...` : `Generate ${data.run.requestedCandidateCount} candidates`}
            </button>
          </div>
        </div>
        <textarea
          onChange={(event) => setNormalizedInputText(event.currentTarget.value)}
          rows={22}
          spellCheck={false}
          style={{ width: '100%', resize: 'vertical' }}
          value={normalizedInputText}
        />
        <p className="subtle-copy" style={{ marginTop: '0.75rem' }}>
          This field must stay valid JSON. If text inside a JSON string needs quotes or line breaks, escape them as `\"` and `\n`.
        </p>
      </article>

      <section style={{ marginTop: '1rem' }}>
        <div className="page-header" style={{ marginBottom: '0.75rem' }}>
          <div>
            <h3 style={{ margin: 0 }}>Candidate schedules</h3>
            <p className="subtle-copy">Compare the summary header and month-long calendar here, then open a candidate in a new tab for swimlanes, day-by-day detail, and exports.</p>
          </div>
        </div>

        <div className="stacked-list">
          {data.candidates.map((candidate, index) => {
            const presentation = buildSchedulingCandidatePresentation({
              candidateId: candidate.id,
              normalizedInput: reviewedNormalizedInput,
              runId: data.run.id,
              schedule: candidate.schedule,
            })
            const candidateSummary = buildSchedulingCandidateSummaryText({ presentation, schedule: candidate.schedule })
            const detailPath = buildHeliosModulePath('scheduling', `runs/${data.run.id}/candidates/${candidate.id}`)

            return (
              <details className="detail-panel scheduling-candidate-shell" key={candidate.id} open={data.run.selectedCandidateId === candidate.id || index === 0}>
                <summary className="scheduling-candidate-summary">
                  <div>
                    <div className="inline-row wrap-row" style={{ marginBottom: '0.5rem' }}>
                      <h4 style={{ margin: 0 }}>{candidate.schedule.label}</h4>
                      {data.run.selectedCandidateId === candidate.id ? <Pill tone="success">Selected</Pill> : null}
                    </div>
                    <p className="subtle-copy">{candidateSummary}</p>
                    <div className="scheduling-candidate-summary-grid">
                      <span className="subtle-copy">Scheduled hours: {formatHoursWithTotal(presentation.hoursCostSummary.averageScheduledHoursPerWeek, presentation.hoursCostSummary.totalScheduledHours)}</span>
                      <span className="subtle-copy">Top two/week: {formatHoursSummaryEmployees(presentation.hoursSummary.topEmployees)}</span>
                      <span className="subtle-copy">Bottom two/week: {formatHoursSummaryEmployees(presentation.hoursSummary.bottomEmployees)}</span>
                    </div>
                    <div className="scheduling-candidate-summary-grid">
                      <span className="subtle-copy">Payroll cost: {formatCurrencyWithTotal(presentation.hoursCostSummary.averageLaborCostPerWeek, presentation.hoursCostSummary.totalLaborCost)}</span>
                      <span className="subtle-copy">Fairness: {candidate.schedule.metrics.fairnessScore.toFixed(1)}</span>
                      <span className="subtle-copy">Preference: {candidate.schedule.metrics.preferenceScore.toFixed(1)}</span>
                      <span className="subtle-copy">Coverage warnings: {candidate.schedule.metrics.coverageWarningCount}</span>
                    </div>
                  </div>
                  <span className="subtle-copy">{data.run.selectedCandidateId === candidate.id ? 'Open selected candidate' : 'Open candidate'}</span>
                </summary>

                <div className="inline-row wrap-row" style={{ marginBottom: '0.85rem' }}>
                  <Link className="ghost-button like-button" rel="noreferrer" target="_blank" to={detailPath}>
                    Open full details in new tab
                  </Link>
                  <button
                    className="ghost-button"
                    disabled={selectingCandidateId === candidate.id}
                    onClick={() => void handleSelectCandidate(candidate.id)}
                    type="button"
                  >
                    {selectingCandidateId === candidate.id ? 'Selecting...' : 'Select candidate'}
                  </button>
                </div>

                <SchedulingCandidateResults
                  candidateId={candidate.id}
                  mode="calendar-only"
                  normalizedInput={reviewedNormalizedInput}
                  runId={data.run.id}
                  schedule={candidate.schedule}
                />
              </details>
            )
          })}

          {data.candidates.length === 0 ? (
            <article className="detail-panel">
              <p className="subtle-copy">
                {isBackgroundWorkRunning ? 'Candidates are being generated. This page refreshes automatically.' : 'No candidates have been generated yet.'}
              </p>
            </article>
          ) : null}
        </div>
      </section>
    </section>
  )
}

function toneForStatus(status: SchedulingRunDetailResponse['run']['status']): 'danger' | 'success' | 'warning' {
  switch (status) {
    case 'ready':
      return 'success'
    case 'failed':
      return 'danger'
    default:
      return 'warning'
  }
}

function labelForStatus(status: SchedulingRunDetailResponse['run']['status']): string {
  switch (status) {
    case 'needs_review':
      return 'Needs review'
    default:
      return status.replace(/_/g, ' ')
  }
}

function formatHoursSummaryEmployees(employees: ReturnType<typeof buildSchedulingCandidatePresentation>['hoursSummary']['topEmployees']): string {
  if (employees.length === 0) {
    return 'None'
  }

  return employees.map((entry) => `${entry.employee.name} ${entry.averageHoursPerWeek.toFixed(1)}h`).join(', ')
}

function formatTimestamp(value: string | null): string {
  if (!value) {
    return 'Not yet'
  }

  return new Date(value).toLocaleString()
}

function formatWaitingReason(value: SchedulingRunDetailResponse['debug']['queue']['waitingReason']): string {
  switch (value) {
    case 'scheduled_for_future':
      return 'Scheduled for later'
    case 'queued_behind_other_jobs':
      return 'Queued behind other jobs'
    case 'waiting_for_worker':
      return 'Waiting for a worker'
    case 'running':
      return 'Running now'
    case 'not_queued':
      return 'Job is not queued'
    default:
      return 'No current job'
  }
}

function toPrettyJson(value: unknown): string {
  return JSON.stringify(value, null, 2)
}

function parseNormalizedInputText(value: string): unknown {
  try {
    return JSON.parse(value) as unknown
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`Normalized input is not valid JSON. ${error.message} If you intended a line break or quote inside a string value, escape it as \\n or \\\".`)
    }

    throw error
  }
}

function buildDraftNormalizedInput(data: SchedulingRunDetailResponse): NormalizedSolverInput {
  if (data.run.normalizedInput) {
    return data.run.normalizedInput
  }

  const fallbackScheduleWeek = data.run.scheduleWeek ?? data.run.extractedConstraints?.scheduleWeek
  if (fallbackScheduleWeek) {
    return {
      employees: [],
      issues: [],
      notes: [],
      scheduleWeek: fallbackScheduleWeek,
      shiftRequirements: [],
      unknownEntities: [],
      weekDefinition: DEFAULT_SCHEDULING_WEEK_DEFINITION,
    }
  }

  return {
    employees: [],
    issues: [],
    notes: [],
    scheduleWeek: {
      endDate: '1970-01-03',
      startDate: '1969-12-28',
    },
    shiftRequirements: [],
    unknownEntities: [],
    weekDefinition: DEFAULT_SCHEDULING_WEEK_DEFINITION,
  }
}
