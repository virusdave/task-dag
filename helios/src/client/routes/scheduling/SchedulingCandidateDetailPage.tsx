import { useState } from 'react'
import { Link, useLoaderData, useRevalidator } from 'react-router-dom'

import {
  MutationAcceptedResponseSchema,
  SelectSchedulingCandidateRequestSchema,
  SchedulingRunDetailResponseSchema,
  buildHeliosModulePath,
  type SchedulingRunDetailResponse,
} from '../../../shared/contracts/index.js'
import { loadJson, mutateJson } from '../../app/fetchJson.js'
import { Pill } from '../../components/Pill.js'
import { SchedulingCandidateResults } from './SchedulingCandidateResults.js'
import {
  buildSchedulingCandidatePresentation,
  buildSchedulingCandidateSummaryText,
  formatCurrencyWithTotal,
  formatHoursWithTotal,
} from './schedulingResultsPresenter.js'
import { formatScheduleWeekLabel } from './schedulingWeek.js'

export async function schedulingCandidateDetailLoader({ params }: { params: Record<string, string | undefined> }) {
  const detail = await loadJson(`/api/scheduling/runs/${params.schedulingRunId}`, SchedulingRunDetailResponseSchema)
  const candidateId = Number(params.candidateId)
  const candidate = detail.candidates.find((item) => item.id === candidateId)
  if (!candidate) {
    throw new Response('Scheduling candidate not found.', { status: 404 })
  }

  return {
    candidate,
    detail,
  }
}

export function SchedulingCandidateDetailPage() {
  const data = useLoaderData() as { candidate: SchedulingRunDetailResponse['candidates'][number]; detail: SchedulingRunDetailResponse }
  const revalidator = useRevalidator()
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [isSelecting, setIsSelecting] = useState(false)
  const normalizedInput = data.detail.run.normalizedInput

  if (!normalizedInput) {
    return (
      <section className="detail-panel">
        <p className="error-text">This run does not have a normalized input yet.</p>
      </section>
    )
  }

  const presentation = buildSchedulingCandidatePresentation({
    candidateId: data.candidate.id,
    normalizedInput,
    runId: data.detail.run.id,
    schedule: data.candidate.schedule,
  })
  const candidateSummary = buildSchedulingCandidateSummaryText({ presentation, schedule: data.candidate.schedule })

  async function handleSelectCandidate() {
    setIsSelecting(true)
    setErrorMessage(null)

    try {
      await mutateJson(
        `/api/scheduling/runs/${data.detail.run.id}/select-candidate`,
        MutationAcceptedResponseSchema,
        {
          body: JSON.stringify(SelectSchedulingCandidateRequestSchema.parse({ candidateId: data.candidate.id })),
          method: 'POST',
        },
      )
      await revalidator.revalidate()
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Could not select this candidate.')
    } finally {
      setIsSelecting(false)
    }
  }

  return (
    <section>
      <div className="page-header">
        <div>
          <p className="eyebrow">Scheduling Candidate</p>
          <h2>{data.candidate.schedule.label}</h2>
          <p className="subtle-copy">{candidateSummary}</p>
          <p className="subtle-copy">Run #{data.detail.run.id} · {data.detail.run.title}</p>
          <p className="subtle-copy">Window: {formatScheduleWeekLabel(data.detail.run.scheduleWeek)}</p>
        </div>
        <div className="inline-row wrap-row">
          {data.detail.run.selectedCandidateId === data.candidate.id ? <Pill tone="success">Selected</Pill> : null}
          <button className="ghost-button" disabled={isSelecting} onClick={() => void handleSelectCandidate()} type="button">
            {isSelecting ? 'Selecting...' : 'Select candidate'}
          </button>
          <Link className="ghost-button like-button" to={buildHeliosModulePath('scheduling', `runs/${data.detail.run.id}`)}>
            Back to run
          </Link>
        </div>
      </div>

      {errorMessage ? <p className="error-text">{errorMessage}</p> : null}

      <div className="pricing-metric-grid" style={{ marginBottom: '1rem' }}>
        <div className="value-panel">
          <span>Scheduled hours</span>
          <p>{formatHoursWithTotal(presentation.hoursCostSummary.averageScheduledHoursPerWeek, presentation.hoursCostSummary.totalScheduledHours)}</p>
        </div>
        <div className="value-panel">
          <span>Payroll cost</span>
          <p>{formatCurrencyWithTotal(presentation.hoursCostSummary.averageLaborCostPerWeek, presentation.hoursCostSummary.totalLaborCost)}</p>
        </div>
        <div className="value-panel">
          <span>Fairness</span>
          <p>{data.candidate.schedule.metrics.fairnessScore.toFixed(1)}</p>
        </div>
        <div className="value-panel">
          <span>Preference</span>
          <p>{data.candidate.schedule.metrics.preferenceScore.toFixed(1)}</p>
        </div>
        <div className="value-panel">
          <span>Coverage warnings</span>
          <p>{data.candidate.schedule.metrics.coverageWarningCount}</p>
        </div>
      </div>

      <details className="detail-panel" style={{ marginBottom: '1rem' }}>
        <summary className="scheduling-candidate-summary">
          <div>
            <h3 style={{ margin: 0, fontSize: '1rem' }}>Hours and costs</h3>
            <div className="scheduling-candidate-summary-grid">
              <span className="subtle-copy">Scheduled hours: {formatHoursWithTotal(presentation.hoursCostSummary.averageScheduledHoursPerWeek, presentation.hoursCostSummary.totalScheduledHours)}</span>
              <span className="subtle-copy">Payroll cost: {formatCurrencyWithTotal(presentation.hoursCostSummary.averageLaborCostPerWeek, presentation.hoursCostSummary.totalLaborCost)}</span>
            </div>
          </div>
          <span className="subtle-copy">Expand details</span>
        </summary>

        <div style={{ marginTop: '1rem' }}>
          <p className="subtle-copy">Top two scheduled hours/week: {formatHoursSummaryEmployees(presentation.hoursSummary.topEmployees)}</p>
          <p className="subtle-copy">Bottom two scheduled hours/week: {formatHoursSummaryEmployees(presentation.hoursSummary.bottomEmployees)}</p>

          <div className="data-table-wrapper" style={{ marginTop: '1rem' }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">Employee</th>
                  <th scope="col">Per week</th>
                  <th scope="col">Hours</th>
                  <th scope="col">Payroll cost</th>
                </tr>
              </thead>
              <tbody>
                {presentation.hoursCostSummary.employees.map((entry) => (
                  <tr key={entry.employee.id}>
                    <td>
                      <strong>{entry.employee.name}</strong>
                    </td>
                    <td>
                      <div style={{ display: 'grid', gap: '0.45rem' }}>
                        {entry.weeks.map((week) => (
                          <div key={week.weekStartDate}>
                            <strong>{week.weekLabel}</strong>
                            <div className="subtle-copy">
                              {formatHours(week.scheduledHours)} · {formatCurrency(week.laborCost)}
                            </div>
                          </div>
                        ))}
                      </div>
                    </td>
                    <td>
                      <div>{formatHoursWithTotal(entry.averageHoursPerWeek, entry.totalScheduledHours)}</div>
                    </td>
                    <td>
                      <div>{formatCurrencyWithTotal(entry.averageLaborCostPerWeek, entry.totalLaborCost)}</div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </details>

      <SchedulingCandidateResults
        candidateId={data.candidate.id}
        normalizedInput={normalizedInput}
        runId={data.detail.run.id}
        schedule={data.candidate.schedule}
      />
    </section>
  )
}

function formatHoursSummaryEmployees(employees: ReturnType<typeof buildSchedulingCandidatePresentation>['hoursSummary']['topEmployees']): string {
  if (employees.length === 0) {
    return 'None'
  }

  return employees.map((entry) => `${entry.employee.name} ${entry.averageHoursPerWeek.toFixed(1)}h`).join(', ')
}

function formatHours(value: number): string {
  return `${value.toFixed(1)}h`
}

function formatCurrency(value: number): string {
  return `$${value.toFixed(2)}`
}
