import { useEffect, useMemo, useRef, useState } from 'react'
import { Form, Link, useLoaderData, useSearchParams } from 'react-router-dom'

import {
  HELIOS_MODULES,
  JOB_EXECUTION_POOL_LABELS,
  JOB_PRIORITY_BANDS,
  JobQueueMetricsResponseSchema,
  JobsResponseSchema,
  buildHeliosModulePath,
  getJobPriorityBandDefinition,
  type JobExecutionPool,
  type JobPriorityBand,
  type JobQueueMetricsCell,
  type JobQueueMetricsResponse,
  type JobsResponse,
} from '../../../shared/contracts/index.js'
import { loadJson } from '../../app/fetchJson.js'
import { Pill } from '../../components/Pill.js'

const moduleLabelByCode = new Map(HELIOS_MODULES.map((module) => [module.code, module.label]))

// Bands rendered left → right (highest priority first). Mirrors the
// JOB_PRIORITY_BANDS ordering but we recompute explicitly so the UI
// is robust against contract reordering.
const BANDS_HIGH_TO_LOW: JobPriorityBand[] = [...JOB_PRIORITY_BANDS]
  .sort((a, b) => a.sortOrder - b.sortOrder)
  .map((b) => b.code)

const POOLS_ORDER: JobExecutionPool[] = ['sweed', 'system', 'scheduling', 'ads']

const METRICS_POLL_MS = 10_000

interface JobsLoaderData {
  list: JobsResponse
  metrics: JobQueueMetricsResponse
}

export async function jobsLoader({ request }: { request: Request }): Promise<JobsLoaderData> {
  const url = new URL(request.url)
  const [list, metrics] = await Promise.all([
    loadJson(`/api/jobs${url.search}`, JobsResponseSchema),
    loadJson('/api/jobs/queue-metrics', JobQueueMetricsResponseSchema),
  ])
  return { list, metrics }
}

export function JobsPage() {
  const data = useLoaderData() as JobsLoaderData
  const [metrics, setMetrics] = useState(data.metrics)
  const [stale, setStale] = useState(false)
  const lastPolledRef = useRef<number>(Date.now())
  const [_, setTick] = useState(0)

  // Reset live metrics whenever the loader returns fresh data (e.g.
  // after applying a filter — the loader re-fetches both /api/jobs
  // and /api/jobs/queue-metrics).
  useEffect(() => {
    setMetrics(data.metrics)
    setStale(false)
    lastPolledRef.current = Date.now()
  }, [data.metrics])

  // 10-second poll for the dashboard. Keep the list as-is (the
  // operator chose its filters); only the queue snapshot is live.
  useEffect(() => {
    let cancelled = false
    let timeoutId: number | undefined

    const poll = async () => {
      try {
        const next = await loadJson('/api/jobs/queue-metrics', JobQueueMetricsResponseSchema)
        if (!cancelled) {
          setMetrics(next)
          setStale(false)
          lastPolledRef.current = Date.now()
        }
      } catch (err) {
        if (!cancelled) {
          setStale(true)
          console.warn('queue-metrics poll failed:', err)
        }
      } finally {
        if (!cancelled) {
          timeoutId = window.setTimeout(() => {
            void poll()
          }, METRICS_POLL_MS)
        }
      }
    }

    timeoutId = window.setTimeout(() => {
      void poll()
    }, METRICS_POLL_MS)

    return () => {
      cancelled = true
      if (timeoutId !== undefined) {
        window.clearTimeout(timeoutId)
      }
    }
  }, [])

  // Tick once a second so "oldest wait" durations advance smoothly
  // between server polls without re-fetching.
  useEffect(() => {
    const id = window.setInterval(() => {
      setTick((n) => (n + 1) % 1_000_000)
    }, 1_000)
    return () => window.clearInterval(id)
  }, [])

  const cellsByKey = useMemo(() => {
    const map = new Map<string, JobQueueMetricsCell>()
    for (const cell of metrics.cells) {
      map.set(`${cell.pool}::${cell.priorityBand}`, cell)
    }
    return map
  }, [metrics.cells])

  const generatedAtMs = useMemo(() => new Date(metrics.generatedAt).getTime(), [metrics.generatedAt])
  const ageSeconds = Math.max(0, Math.round((Date.now() - generatedAtMs) / 1000))

  return (
    <section>
      <QueueDashboard
        metrics={metrics}
        cellsByKey={cellsByKey}
        ageSeconds={ageSeconds}
        stale={stale}
        generatedAtMs={generatedAtMs}
      />

      <RecentJobsList list={data.list} />
    </section>
  )
}

interface QueueDashboardProps {
  metrics: JobQueueMetricsResponse
  cellsByKey: Map<string, JobQueueMetricsCell>
  ageSeconds: number
  stale: boolean
  generatedAtMs: number
}

function QueueDashboard({ metrics, cellsByKey, ageSeconds, stale }: QueueDashboardProps) {
  const totalsByBand = useMemo(() => {
    const totals = new Map<JobPriorityBand, number>()
    for (const cell of metrics.cells) {
      totals.set(cell.priorityBand, (totals.get(cell.priorityBand) ?? 0) + cell.readyCount)
    }
    return totals
  }, [metrics.cells])

  const totalRunning = metrics.pools.reduce((sum, p) => sum + p.runningCount, 0)
  const totalReady = metrics.pools.reduce((sum, p) => sum + p.readyTotal, 0)

  // Compose top heads-up pills. Order matters: most-actionable first.
  const headsUpPills: Array<{ tone: 'danger' | 'warning' | 'muted'; label: string; to?: string }> = []
  if (metrics.alerts.expiredLeaseCount > 0) {
    headsUpPills.push({
      tone: 'danger',
      label: `${metrics.alerts.expiredLeaseCount} expired lease${metrics.alerts.expiredLeaseCount === 1 ? '' : 's'}`,
      to: '/jobs?status=running',
    })
  }
  if (metrics.alerts.deadLetterLast24h > 0) {
    headsUpPills.push({
      tone: 'danger',
      label: `${metrics.alerts.deadLetterLast24h} dead-lettered (24h)`,
      to: '/jobs?status=dead_letter',
    })
  }
  if (metrics.alerts.failedLast1h > 0) {
    headsUpPills.push({
      tone: 'warning',
      label: `${metrics.alerts.failedLast1h} failed (1h)`,
      to: '/jobs?status=failed',
    })
  }
  for (const pool of metrics.pools) {
    if (pool.oldestRunningSeconds !== null && pool.oldestRunningSeconds >= 60 * 60) {
      headsUpPills.push({
        tone: 'warning',
        label: `${JOB_EXECUTION_POOL_LABELS[pool.pool]} running ${formatDuration(pool.oldestRunningSeconds)}`,
        to: pool.oldestRunningJob ? `/jobs/${pool.oldestRunningJob.jobId}` : `/jobs?status=running&pool=${pool.pool}`,
      })
    }
  }

  return (
    <div className="queue-dashboard">
      <div className="queue-dashboard-header">
        <h2 className="queue-dashboard-title">
          Queue depth · {totalReady} ready · {totalRunning} running
        </h2>
        <div className="queue-dashboard-meta">
          <span className={stale ? 'subtle-copy queue-dashboard-stale' : 'subtle-copy'}>
            {stale
              ? `stale ${ageSeconds}s · poll failing`
              : `updated ${ageSeconds}s ago · live ${METRICS_POLL_MS / 1000}s`}
          </span>
        </div>
      </div>

      {headsUpPills.length > 0 ? (
        <div className="inline-row wrap-row queue-dashboard-alerts">
          {headsUpPills.map((pill, idx) =>
            pill.to ? (
              <Link to={pill.to} key={`alert-${idx}`} className="queue-dashboard-alert-link">
                <Pill tone={pill.tone}>{pill.label}</Pill>
              </Link>
            ) : (
              <Pill tone={pill.tone} key={`alert-${idx}`}>{pill.label}</Pill>
            ),
          )}
        </div>
      ) : null}

      <table className="queue-matrix">
        <thead>
          <tr>
            <th scope="col">Pool</th>
            <th scope="col">Running</th>
            {BANDS_HIGH_TO_LOW.map((band) => {
              const def = getJobPriorityBandDefinition(band)
              const total = totalsByBand.get(band) ?? 0
              return (
                <th scope="col" key={band}>
                  <div className="queue-matrix-band-header">
                    <span>{def.label}</span>
                    <span className="subtle-copy">{total} total</span>
                  </div>
                </th>
              )
            })}
          </tr>
        </thead>
        <tbody>
          {POOLS_ORDER.map((pool) => {
            const poolHealth = metrics.pools.find((p) => p.pool === pool)
            return (
              <tr key={pool}>
                <th scope="row" className="queue-matrix-pool">
                  <div>
                    <strong>{JOB_EXECUTION_POOL_LABELS[pool]}</strong>
                  </div>
                  <div className="subtle-copy">
                    {poolHealth?.scheduledTotal ? `+${poolHealth.scheduledTotal} later` : 'all ready'}
                  </div>
                </th>
                <td className="queue-matrix-running">
                  {renderRunningCell(poolHealth, pool)}
                </td>
                {BANDS_HIGH_TO_LOW.map((band) => {
                  const cell = cellsByKey.get(`${pool}::${band}`)
                  return (
                    <td key={band} className={cellClassName(cell, band)}>
                      {renderQueueCell(cell, pool, band)}
                    </td>
                  )
                })}
              </tr>
            )
          })}
        </tbody>
      </table>

      <details className="queue-dashboard-details">
        <summary>What am I looking at?</summary>
        <p className="subtle-copy">
          One row per worker execution pool, one column per priority band. Each cell shows
          <strong> ready</strong> (queued + <code>run_at &lt;= now()</code>) jobs in that pool/band, the
          oldest ready job's wait, and p50/p95 wait over current ready jobs. Cells turn warning/danger
          tinted when the oldest wait exceeds the band's threshold:
        </p>
        <ul className="subtle-copy queue-dashboard-thresholds">
          {BANDS_HIGH_TO_LOW.map((band) => {
            const def = getJobPriorityBandDefinition(band)
            return (
              <li key={band}>
                <strong>{def.label}</strong>: warn after {formatDuration(def.warnAfterSeconds)}, danger after{' '}
                {formatDuration(def.dangerAfterSeconds)}
              </li>
            )
          })}
        </ul>
        <p className="subtle-copy">
          Lease order is <code>priority desc, run_at asc, id asc</code>. The fastlane worker loop also
          dedicates a small concurrency budget to <strong>Urgent</strong>, so urgent work never sits
          behind a full main pool.
        </p>
      </details>
    </div>
  )
}

function renderRunningCell(
  poolHealth: JobQueueMetricsResponse['pools'][number] | undefined,
  pool: JobExecutionPool,
) {
  if (!poolHealth || poolHealth.runningCount === 0) {
    return <span className="subtle-copy">idle</span>
  }
  return (
    <>
      <Link to={`/jobs?status=running&pool=${pool}`} className="queue-matrix-cell-count">
        {poolHealth.runningCount}
      </Link>
      {poolHealth.oldestRunningJob ? (
        <Link to={`/jobs/${poolHealth.oldestRunningJob.jobId}`} className="subtle-copy">
          oldest {formatDuration(poolHealth.oldestRunningSeconds ?? 0)}
        </Link>
      ) : null}
      {poolHealth.expiredLeaseCount > 0 ? (
        <span className="queue-matrix-expired">{poolHealth.expiredLeaseCount} expired</span>
      ) : null}
    </>
  )
}

function renderQueueCell(
  cell: JobQueueMetricsCell | undefined,
  pool: JobExecutionPool,
  band: JobPriorityBand,
) {
  if (!cell || cell.readyCount === 0) {
    return (
      <>
        <span className="queue-matrix-cell-count queue-matrix-cell-empty">0</span>
        <span className="subtle-copy">
          {cell && cell.scheduledCount > 0 ? `+${cell.scheduledCount} later` : 'idle'}
        </span>
      </>
    )
  }
  const filterHref = `/jobs?status=queued&pool=${pool}&priorityBand=${band}`
  return (
    <>
      <Link to={filterHref} className="queue-matrix-cell-count">
        {cell.readyCount}
      </Link>
      {cell.oldestReadyJob ? (
        <Link to={`/jobs/${cell.oldestReadyJob.jobId}`} className="queue-matrix-cell-oldest">
          oldest {formatDuration(cell.oldestReadyWaitSeconds ?? 0)}
        </Link>
      ) : (
        <span className="queue-matrix-cell-oldest">oldest {formatDuration(cell.oldestReadyWaitSeconds ?? 0)}</span>
      )}
      <span className="subtle-copy">
        p50 {formatDuration(cell.p50ReadyWaitSeconds ?? 0)} · p95 {formatDuration(cell.p95ReadyWaitSeconds ?? 0)}
      </span>
      {cell.scheduledCount > 0 ? (
        <span className="subtle-copy queue-matrix-cell-scheduled">+{cell.scheduledCount} later</span>
      ) : null}
    </>
  )
}

function cellClassName(cell: JobQueueMetricsCell | undefined, band: JobPriorityBand): string {
  const base = 'queue-matrix-cell'
  if (!cell || cell.readyCount === 0 || cell.oldestReadyWaitSeconds === null) {
    return base
  }
  const def = getJobPriorityBandDefinition(band)
  if (cell.oldestReadyWaitSeconds >= def.dangerAfterSeconds) {
    return `${base} queue-matrix-cell-danger`
  }
  if (cell.oldestReadyWaitSeconds >= def.warnAfterSeconds) {
    return `${base} queue-matrix-cell-warning`
  }
  return base
}

function RecentJobsList({ list }: { list: JobsResponse }) {
  const [searchParams] = useSearchParams()

  return (
    <div className="jobs-list-section">
      <div className="jobs-list-header">
        <h3>Recent jobs</h3>
        <Form className="filter-row" method="get">
          <select defaultValue={searchParams.get('status') ?? ''} name="status">
            <option value="">All statuses</option>
            <option value="queued">Queued</option>
            <option value="running">Running</option>
            <option value="succeeded">Succeeded</option>
            <option value="failed">Failed</option>
            <option value="dead_letter">Dead letter</option>
          </select>
          <select defaultValue={searchParams.get('pool') ?? ''} name="pool">
            <option value="">All pools</option>
            {POOLS_ORDER.map((pool) => (
              <option key={pool} value={pool}>{JOB_EXECUTION_POOL_LABELS[pool]}</option>
            ))}
          </select>
          <select defaultValue={searchParams.get('priorityBand') ?? ''} name="priorityBand">
            <option value="">All priorities</option>
            {BANDS_HIGH_TO_LOW.map((band) => {
              const def = getJobPriorityBandDefinition(band)
              return (
                <option key={band} value={band}>{def.label}</option>
              )
            })}
          </select>
          <select defaultValue={searchParams.get('module') ?? ''} name="module">
            <option value="">All modules</option>
            {HELIOS_MODULES.map((module) => (
              <option key={module.code} value={module.code}>{module.label}</option>
            ))}
          </select>
          <input defaultValue={searchParams.get('jobType') ?? ''} name="jobType" placeholder="Job type" />
          <button className="ghost-button" type="submit">
            Filter
          </button>
        </Form>
      </div>

      <div className="stacked-list">
        {list.items.map((job) => {
          const bandDef = getJobPriorityBandDefinition(job.priorityBand)
          return (
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
                  <Pill tone={priorityBandTone(job.priorityBand)}>{`${bandDef.label} · p${job.priority}`}</Pill>
                  <Pill tone="muted">{JOB_EXECUTION_POOL_LABELS[job.executionPool]}</Pill>
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
          )
        })}
        {list.items.length === 0 ? <p className="empty-state">No jobs matched the current filters.</p> : null}
      </div>
    </div>
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

function priorityBandTone(band: JobPriorityBand): 'danger' | 'muted' | 'success' | 'warning' {
  switch (band) {
    case 'urgent':
      return 'danger'
    case 'live_requested':
      return 'warning'
    case 'interactive':
      return 'success'
    default:
      return 'muted'
  }
}

function formatDuration(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) {
    return '0s'
  }
  if (totalSeconds < 60) {
    return `${Math.round(totalSeconds)}s`
  }
  if (totalSeconds < 60 * 60) {
    const m = Math.floor(totalSeconds / 60)
    const s = Math.round(totalSeconds % 60)
    return s > 0 ? `${m}m ${s}s` : `${m}m`
  }
  if (totalSeconds < 24 * 60 * 60) {
    const h = Math.floor(totalSeconds / 3600)
    const m = Math.round((totalSeconds % 3600) / 60)
    return m > 0 ? `${h}h ${m}m` : `${h}h`
  }
  const d = Math.floor(totalSeconds / (24 * 60 * 60))
  const h = Math.round((totalSeconds % (24 * 60 * 60)) / 3600)
  return h > 0 ? `${d}d ${h}h` : `${d}d`
}
