import { Form, Link, useLoaderData } from 'react-router-dom'

import {
  SchedulingRunListResponseSchema,
  buildHeliosModulePath,
  type SchedulingRunListResponse,
} from '../../../shared/contracts/index.js'
import { loadJson } from '../../app/fetchJson.js'
import { Pill } from '../../components/Pill.js'
import { SchedulingNav } from './SchedulingNav.js'
import { formatScheduleWeekLabel } from './schedulingWeek.js'

export async function schedulingRunsLoader({ request }: { request: Request }) {
  const url = new URL(request.url)
  return loadJson(`/api/scheduling/runs${url.search}`, SchedulingRunListResponseSchema)
}

export function SchedulingRunsPage() {
  const data = useLoaderData() as SchedulingRunListResponse

  return (
    <section>
      <div className="page-header">
        <div>
          <p className="eyebrow">Scheduling</p>
          <h2>Scheduling run history</h2>
          <p className="subtle-copy">
            Queue a natural-language scheduling run, review the normalized input, then compare candidate schedules before selecting one.
          </p>
        </div>
        <Link className="primary-button like-button" to={buildHeliosModulePath('scheduling', 'new')}>
          New scheduling run
        </Link>
      </div>

      <SchedulingNav />

      <article className="detail-panel" style={{ marginBottom: '1rem' }}>
        <Form className="inline-row wrap-row" method="get">
          <input defaultValue={data.filters.search ?? ''} name="search" placeholder="Search title or source text" />
          <select defaultValue={data.filters.status ?? ''} name="status">
            <option value="">All statuses</option>
            <option value="queued">Queued</option>
            <option value="extracting">Extracting</option>
            <option value="needs_review">Needs review</option>
            <option value="generating">Generating</option>
            <option value="ready">Ready</option>
            <option value="failed">Failed</option>
          </select>
          <button className="ghost-button" type="submit">Apply filters</button>
        </Form>
      </article>

      <div className="stacked-list">
        {data.items.map((run) => (
          <article className="detail-panel" key={run.id}>
            <div className="page-header" style={{ marginBottom: '0.75rem' }}>
              <div>
                <h3 style={{ margin: 0 }}>
                  <Link to={buildHeliosModulePath('scheduling', `runs/${run.id}`)}>{run.title}</Link>
                </h3>
                <p className="subtle-copy">
                  Run #{run.id} · {new Date(run.createdAt).toLocaleString()} · {run.createdByUser ?? 'Unknown user'}
                </p>
                {run.scheduleWeek ? <p className="subtle-copy">Window: {formatScheduleWeekLabel(run.scheduleWeek)}</p> : null}
              </div>
              <div className="inline-row wrap-row">
                <Pill tone={toneForStatus(run.status)}>{labelForStatus(run.status)}</Pill>
                {run.pageOnExtractionResult ? <Pill tone="warning">Pages on result</Pill> : null}
                {run.selectedCandidateId ? <Pill tone="success">Selected candidate</Pill> : null}
              </div>
            </div>

            <p className="subtle-copy" style={{ marginBottom: '0.75rem' }}>{run.sourceTextPreview}</p>

            <div className="inline-row wrap-row" style={{ marginBottom: '0.75rem' }}>
              <span className="subtle-copy">Candidates: {run.candidateCount}</span>
              <span className="subtle-copy">Requested: {run.requestedCandidateCount}</span>
              <span className="subtle-copy">Validation issues: {run.validationIssues.length}</span>
              {run.currentJobStatus ? <span className="subtle-copy">Job: {run.currentJobStatus}</span> : null}
              {run.approvedByUser ? <span className="subtle-copy">Selected by {run.approvedByUser}</span> : null}
            </div>

            {run.latestError ? <p className="error-text">{run.latestError}</p> : null}

            <Link className="ghost-button like-button" to={buildHeliosModulePath('scheduling', `runs/${run.id}`)}>
              Open run detail
            </Link>
          </article>
        ))}
        {data.items.length === 0 ? (
          <article className="detail-panel">
            <p className="subtle-copy">No scheduling runs matched the current filters.</p>
          </article>
        ) : null}
      </div>
    </section>
  )
}

function toneForStatus(status: SchedulingRunListResponse['items'][number]['status']): 'danger' | 'muted' | 'success' | 'warning' {
  switch (status) {
    case 'ready':
      return 'success'
    case 'failed':
      return 'danger'
    default:
      return 'warning'
  }
}

function labelForStatus(status: SchedulingRunListResponse['items'][number]['status']): string {
  switch (status) {
    case 'needs_review':
      return 'Needs review'
    default:
      return status.replace(/_/g, ' ')
  }
}
