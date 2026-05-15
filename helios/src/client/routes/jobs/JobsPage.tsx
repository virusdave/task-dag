import { Form, Link, useLoaderData } from 'react-router-dom'

import { HELIOS_MODULES, JobsResponseSchema, buildHeliosModulePath, type JobsResponse } from '../../../shared/contracts/index.js'
import { loadJson } from '../../app/fetchJson.js'
import { Pill } from '../../components/Pill.js'

const moduleLabelByCode = new Map(HELIOS_MODULES.map((module) => [module.code, module.label]))

export async function jobsLoader({ request }: { request: Request }) {
  const url = new URL(request.url)
  return loadJson(`/api/jobs${url.search}`, JobsResponseSchema)
}

export function JobsPage() {
  const data = useLoaderData() as JobsResponse

  return (
    <section>
      <div className="page-header">
        <div>
          <p className="eyebrow">Global Jobs</p>
          <h2>Queue activity across every Helios module</h2>
        </div>
        <Form className="filter-row" method="get">
          <select defaultValue={data.filters.module ?? ''} name="module">
            <option value="">All modules</option>
            {HELIOS_MODULES.map((module) => (
              <option key={module.code} value={module.code}>{module.label}</option>
            ))}
          </select>
          <select defaultValue={data.filters.status ?? ''} name="status">
            <option value="">All statuses</option>
            <option value="queued">Queued</option>
            <option value="running">Running</option>
            <option value="succeeded">Succeeded</option>
            <option value="failed">Failed</option>
            <option value="dead_letter">Dead letter</option>
          </select>
          <input defaultValue={data.filters.jobType ?? ''} name="jobType" placeholder="Job type" />
          <button className="ghost-button" type="submit">
            Filter
          </button>
        </Form>
      </div>

      <div className="stacked-list">
        {data.items.map((job) => (
          <article className="history-card" key={job.jobId}>
            <div className="history-card-topline">
              <div>
                <strong>{job.jobType}</strong>
                <p className="subtle-copy">
                  queued {new Date(job.createdAt).toLocaleString()} · scheduled {new Date(job.runAt).toLocaleString()}
                </p>
              </div>
              <div className="inline-row wrap-row">
                <Pill tone={statusTone(job.status)}>{job.status}</Pill>
                <Pill tone="muted">{moduleLabelByCode.get(job.module) ?? job.module}</Pill>
                {job.module === 'catalog' && job.scope?.entityType === 'catalog_group' ? (
                  <Link to={buildHeliosModulePath('catalog', `groups/${job.scope.entityId}`)}>Group detail</Link>
                ) : null}
              </div>
            </div>
            <p>
              {job.requestedByLabel ? `Requested by ${job.requestedByLabel}` : 'System-triggered job'} · attempt {job.attemptCount + 1}
              {job.scope ? ` · ${job.scope.entityType} ${job.scope.entityId}` : ''}
            </p>
            {job.startedAt ? <p className="subtle-copy">Started {new Date(job.startedAt).toLocaleString()}</p> : null}
            {job.finishedAt ? <p className="subtle-copy">Finished {new Date(job.finishedAt).toLocaleString()}</p> : null}
            <div className="inline-row wrap-row module-card-links">
              <Link to={`/jobs/${job.jobId}`}>Open job details</Link>
            </div>
            {job.lastError ? <p className="error-text">{job.lastError}</p> : null}
          </article>
        ))}
        {data.items.length === 0 ? <p className="empty-state">No jobs matched the current filters.</p> : null}
      </div>
    </section>
  )
}

function statusTone(status: JobsResponse['items'][number]['status']): 'danger' | 'muted' | 'success' | 'warning' {
  switch (status) {
    case 'succeeded':
      return 'success'
    case 'failed':
    case 'dead_letter':
      return 'danger'
    case 'running':
    case 'queued':
      return 'warning'
    default:
      return 'muted'
  }
}
