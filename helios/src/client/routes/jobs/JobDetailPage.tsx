import { useEffect, useState } from 'react'
import { Link, useLoaderData } from 'react-router-dom'

import {
  JobStatusResponseSchema,
  buildHeliosModulePath,
  type JobStatusResponse,
  type SweedAuthEvent,
} from '../../../shared/contracts/index.js'
import { loadJson } from '../../app/fetchJson.js'
import { isJobTerminal, loadJobStatus } from '../../app/jobPolling.js'
import { Pill, type PillProps } from '../../components/Pill.js'

export async function jobDetailLoader({ params }: { params: Record<string, string | undefined> }) {
  return loadJson(`/api/jobs/${params.jobId}`, JobStatusResponseSchema)
}

export function JobDetailPage() {
  const initialData = useLoaderData() as JobStatusResponse
  const [data, setData] = useState(initialData)

  useEffect(() => {
    setData(initialData)
  }, [initialData])

  useEffect(() => {
    if (isJobTerminal(data.job.status)) {
      return
    }

    let cancelled = false
    let timeoutId: number | undefined

    const poll = async () => {
      let terminal = false
      try {
        const next = await loadJobStatus(data.job.jobId)
        if (!cancelled) {
          setData(next)
          terminal = isJobTerminal(next.job.status)
        }
      } finally {
        if (!cancelled && !terminal) {
          timeoutId = window.setTimeout(() => {
            void poll()
          }, 1500)
        }
      }
    }

    timeoutId = window.setTimeout(() => {
      void poll()
    }, 1500)

    return () => {
      cancelled = true
      if (timeoutId !== undefined) {
        window.clearTimeout(timeoutId)
      }
    }
  }, [data.job.jobId, data.job.status])

  const packetId = data.linkedRecords.pendingPurchasePacketId
  const percentComplete = computeJobProgressPercent(data)

  return (
    <section>
      <div className="page-header">
        <div>
          <p className="eyebrow">Job Detail</p>
          <h2>{`Job #${data.job.jobId}`}</h2>
          <p className="subtle-copy">{data.job.jobType}</p>
          <p className="subtle-copy">{readJobProgressMessage(data)}</p>
        </div>
        <div className="inline-row wrap-row">
          <Pill tone={jobStatusTone(data.job.status)}>{data.job.status.replaceAll('_', ' ')}</Pill>
          <Pill tone="muted">{data.job.module}</Pill>
          <Link className="ghost-button like-button" to="/jobs">Back to jobs</Link>
        </div>
      </div>

      <article className="detail-panel job-progress-panel" style={{ marginBottom: '1rem' }}>
        <div className="job-progress-track" aria-hidden="true">
          <div className={`job-progress-fill${data.job.status === 'failed' || data.job.status === 'dead_letter' ? ' failed' : ''}`} style={{ width: `${percentComplete}%` }} />
        </div>
        <div className="pricing-metric-grid" style={{ marginTop: '0.9rem' }}>
          <ValuePanel label="Phase" value={data.progress ? `${data.progress.phase} (${data.progress.phaseIndex}/${data.progress.phaseCount})` : 'Not reported'} />
          <ValuePanel label="Progress" value={readJobProgressSummary(data)} />
          <ValuePanel label="Queued" value={formatTimestamp(data.job.createdAt)} />
          <ValuePanel label="Scheduled" value={formatTimestamp(data.job.runAt)} />
          <ValuePanel label="Started" value={formatTimestamp(data.job.startedAt)} />
          <ValuePanel label="Finished" value={formatTimestamp(data.job.finishedAt)} />
          <ValuePanel label="Requested by" value={data.job.requestedByLabel ?? (data.job.requestedByUserId ? `User #${data.job.requestedByUserId}` : 'System')} />
          <ValuePanel label="Scope" value={data.job.scope ? `${data.job.scope.entityType} ${data.job.scope.entityId}` : 'None'} />
        </div>
        {data.job.lastError ? <p className="error-text">{data.job.lastError}</p> : null}
      </article>

      <article className="detail-panel" style={{ marginBottom: '1rem' }}>
        <div className="page-header" style={{ marginBottom: '0.75rem' }}>
          <div>
            <h3 style={{ margin: 0 }}>Worker log tail</h3>
            <p className="subtle-copy">Recent worker progress lines for this job, refreshed live while it is running.</p>
          </div>
        </div>
        {data.progressLog.length > 0 ? (
          <ul className="timeline-list job-log-tail">
            {data.progressLog.map((entry, index) => (
              <li key={`${entry.createdAt}-${index}`}>
                <strong>{formatTimestamp(entry.createdAt)}</strong>
                <div className="subtle-copy job-log-message">{entry.message}</div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="empty-state">This job has not emitted any worker progress lines yet.</p>
        )}
      </article>

      <article className="detail-panel" style={{ marginBottom: '1rem' }}>
        <div className="page-header" style={{ marginBottom: '0.75rem' }}>
          <div>
            <h3 style={{ margin: 0 }}>Sweed RPC log</h3>
            <p className="subtle-copy">
              Every Sweed JSON-RPC this worker logged for this job: every auth-lifecycle call
              (login, dealer pin, initial data fetch, logout) and every RPC failure (auth-looking
              or otherwise). Use this to diagnose "Auth expired" and similar Sweed errors. See the{' '}
              <Link to="/config/sweed-auth-log">full auth log</Link> for cross-job context.
            </p>
          </div>
        </div>
        {data.sweedAuthEvents.length > 0 ? (
          <ul className="timeline-list job-sweed-rpc-log">
            {data.sweedAuthEvents.map((event) => (
              <SweedAuthEventRow key={event.id} event={event} />
            ))}
          </ul>
        ) : (
          <p className="empty-state">
            This job has not issued any Sweed auth RPCs or recorded any RPC failures yet. If you
            expected Sweed activity, verify that migration <code>011_sweed_auth_events</code> has
            been applied (the all-pages banner will warn if it hasn't) and that this job actually
            touches Sweed.
          </p>
        )}
      </article>

      <article className="detail-panel">
        <div className="page-header" style={{ marginBottom: '0.75rem' }}>
          <h3 style={{ margin: 0 }}>Related records</h3>
          {isJobTerminal(data.job.status) ? null : <p className="subtle-copy">Refreshing automatically while this job is active.</p>}
        </div>
        <div className="inline-row wrap-row module-card-links">
          {packetId ? (
            <Link to={buildHeliosModulePath('catalog', `pending-purchases?packetId=${packetId}`)}>
              Open pending-purchase packet #{packetId}
            </Link>
          ) : null}
          {data.linkedRecords.pendingPurchaseApplyRequestId ? (
            <Link to={buildHeliosModulePath('catalog', 'history?sectionLimit=8')}>
              Open catalog history for apply request #{data.linkedRecords.pendingPurchaseApplyRequestId}
            </Link>
          ) : null}
          {data.linkedRecords.proposalBatchId ? (
            <Link to={buildHeliosModulePath('pricing', `runs/${data.linkedRecords.proposalBatchId}`)}>
              Open pricing run #{data.linkedRecords.proposalBatchId}
            </Link>
          ) : null}
        </div>
        {!packetId && !data.linkedRecords.pendingPurchaseApplyRequestId && !data.linkedRecords.proposalBatchId ? (
          <p className="empty-state">This job is not linked to a first-class Helios record yet.</p>
        ) : null}
      </article>
    </section>
  )
}

function ValuePanel({ label, value }: { label: string; value: string }) {
  return (
    <div className="value-panel">
      <span>{label}</span>
      <p>{value}</p>
    </div>
  )
}

function jobStatusTone(status: JobStatusResponse['job']['status']): 'danger' | 'muted' | 'success' | 'warning' {
  switch (status) {
    case 'succeeded':
      return 'success'
    case 'failed':
    case 'dead_letter':
      return 'danger'
    case 'queued':
    case 'running':
      return 'warning'
    default:
      return 'muted'
  }
}

function computeJobProgressPercent(jobStatus: JobStatusResponse): number {
  if (jobStatus.job.status === 'succeeded') {
    return 100
  }
  if (!jobStatus.progress) {
    return jobStatus.job.status === 'queued' ? 12 : 30
  }

  const phaseOffset = (jobStatus.progress.phaseIndex - 1) / jobStatus.progress.phaseCount
  const phaseFraction = jobStatus.progress.total && jobStatus.progress.completed !== null
    ? Math.min(jobStatus.progress.completed / jobStatus.progress.total, 1)
    : 0.35
  return Math.max(5, Math.min(99, Math.round((phaseOffset + (phaseFraction / jobStatus.progress.phaseCount)) * 100)))
}

function readJobProgressMessage(jobStatus: JobStatusResponse): string {
  if (jobStatus.progress?.message) {
    return jobStatus.progress.message
  }
  switch (jobStatus.job.status) {
    case 'queued':
      return 'Queued and waiting for a worker to pick up this job.'
    case 'running':
      return 'The worker is currently running this job.'
    case 'succeeded':
      return 'This job completed successfully.'
    case 'failed':
    case 'dead_letter':
      return jobStatus.job.lastError ?? 'This job failed.'
    default:
      return 'Job status unavailable.'
  }
}

function readJobProgressSummary(jobStatus: JobStatusResponse): string {
  if (jobStatus.progress?.total && jobStatus.progress.completed !== null) {
    return `${jobStatus.progress.completed} / ${jobStatus.progress.total}`
  }
  if (jobStatus.progress) {
    return `Phase ${jobStatus.progress.phaseIndex} of ${jobStatus.progress.phaseCount}`
  }
  return jobStatus.job.status.replaceAll('_', ' ')
}

function formatTimestamp(value: string | null): string {
  return value ? new Date(value).toLocaleString() : '—'
}

function SweedAuthEventRow({ event }: { event: SweedAuthEvent }) {
  const contextEntries = Object.entries(event.context ?? {})
  return (
    <li>
      <strong>{formatTimestamp(event.createdAt)}</strong>
      <div className="inline-row wrap-row" style={{ gap: 6, marginTop: 2 }}>
        <Pill tone={sweedOutcomeTone(event.outcome)}>{event.outcome}</Pill>
        <Pill tone="muted">{sweedEventKindLabel(event.eventKind)}</Pill>
        <code>{event.rpcName}</code>
        {event.sessionOrigin ? <Pill tone="muted">{event.sessionOrigin}</Pill> : null}
        {event.httpStatus !== null ? <Pill tone="muted">{`HTTP ${event.httpStatus}`}</Pill> : null}
        {event.dealerId !== null ? <Pill tone="muted">{`dealer ${event.dealerId}`}</Pill> : null}
        {event.authTokenPrefix ? (
          <Pill tone="muted">{`tok ${event.authTokenPrefix}…`}</Pill>
        ) : null}
        <span className="subtle-copy">{sweedFormatDuration(event.durationMs)}</span>
      </div>
      {event.errorMessage ? (
        <pre
          style={{
            background: 'rgba(255,0,0,0.08)',
            padding: 8,
            borderRadius: 4,
            margin: '6px 0 0',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
          }}
        >
          {event.errorMessage}
        </pre>
      ) : null}
      {contextEntries.length > 0 ? (
        <details style={{ marginTop: 4 }}>
          <summary className="subtle-copy">context</summary>
          <pre
            style={{
              background: 'rgba(0,0,0,0.04)',
              padding: 8,
              borderRadius: 4,
              margin: '4px 0 0',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
            }}
          >
            {JSON.stringify(event.context, null, 2)}
          </pre>
        </details>
      ) : null}
    </li>
  )
}

function sweedOutcomeTone(outcome: SweedAuthEvent['outcome']): PillProps['tone'] {
  switch (outcome) {
    case 'ok':
      return 'success'
    case 'retryable':
      return 'warning'
    case 'error':
      return 'danger'
    default:
      return 'muted'
  }
}

function sweedEventKindLabel(kind: SweedAuthEvent['eventKind']): string {
  switch (kind) {
    case 'login':
      return 'Login'
    case 'logout':
      return 'Logout'
    case 'dealer_set':
      return 'Dealer pin'
    case 'initial_data':
      return 'Initial data'
    case 'rpc_auth_error':
      return 'Auth error'
    case 'rpc_error':
      return 'RPC failure'
    default:
      return kind
  }
}

function sweedFormatDuration(ms: number): string {
  if (ms < 1000) {
    return `${ms} ms`
  }
  return `${(ms / 1000).toFixed(2)} s`
}
