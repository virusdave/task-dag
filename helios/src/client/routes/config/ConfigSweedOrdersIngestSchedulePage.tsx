import { useState } from 'react'
import { useLoaderData, useRevalidator } from 'react-router-dom'

import {
  ConfigBackgroundTaskDetailResponseSchema,
  ConfigBackgroundTaskRunNowResponseSchema,
  type ConfigBackgroundTaskDetailResponse,
} from '../../../shared/contracts/index.js'
import { loadJson, mutateJson } from '../../app/fetchJson.js'
import { Pill, type PillProps } from '../../components/Pill.js'
import { useRegisterConfigSidebarSubtree } from './configSidebarSubtree.js'
import { describeWindow } from './schedulingFormat.js'

export async function configSweedOrdersIngestScheduleLoader(): Promise<ConfigBackgroundTaskDetailResponse> {
  return loadJson(
    '/api/config/workers/schedules/workers.scheduling.sweed_orders_ingest',
    ConfigBackgroundTaskDetailResponseSchema,
  )
}

/**
 * Threshold above which the highwater is considered "stale" enough to
 * page an operator. The scheduler runs every 5 minutes when healthy, so
 * 30 minutes without a successful poll is the canonical alarm threshold
 * called for by R2 ("alarm-on-stale highwater") in
 * FreshlyBakedNYC/automation#22.
 */
const STALE_HIGHWATER_THRESHOLD_MS = 30 * 60 * 1000

export function ConfigSweedOrdersIngestSchedulePage() {
  useRegisterConfigSidebarSubtree()
  const data = useLoaderData() as ConfigBackgroundTaskDetailResponse
  const revalidator = useRevalidator()
  const [runningNow, setRunningNow] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  async function handleRunNow() {
    setErrorMessage(null)
    setNotice(null)
    setRunningNow(true)
    try {
      const response = await mutateJson(
        '/api/config/workers/schedules/workers.scheduling.sweed_orders_ingest/run-now',
        ConfigBackgroundTaskRunNowResponseSchema,
        {
          method: 'POST',
          body: JSON.stringify({ taskKey: 'workers.scheduling.sweed_orders_ingest' }),
        },
      )
      setNotice(`Queued Sweed orders ingest job #${response.jobId}.`)
      revalidator.revalidate()
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Failed to queue Sweed orders ingest.')
    } finally {
      setRunningNow(false)
    }
  }

  const dealers = data.sweedOrdersIngest?.dealers ?? []
  const recentRuns = data.sweedOrdersIngest?.recentRuns ?? []

  return (
    <section>
      <div className="page-header">
        <div>
          <p className="eyebrow">Config / Workers / Scheduling</p>
          <h2>Sweed orders ingest</h2>
          <p className="subtle-copy">
            Per-dealer highwater + ingest health for the worker that materialises completed Sweed
            invoices into the helios-owned <code>sweed_orders</code> table. Backs the real-data
            implementations of every P2–P6 metric on <a href="/metrics">/metrics</a>.
          </p>
        </div>
        <Pill tone="success">live</Pill>
      </div>

      {notice ? <p className="success-copy">{notice}</p> : null}
      {errorMessage ? <p className="error-copy">{errorMessage}</p> : null}

      <article className="mini-card">
        <header>
          <strong>Schedule windows</strong>
          <span className="subtle-copy">
            Last enqueued: {data.schedule.lastEnqueuedAt ? new Date(data.schedule.lastEnqueuedAt).toLocaleString() : 'never'}
          </span>
        </header>
        {data.schedule.windows.length === 0 ? (
          <p className="subtle-copy">No windows configured.</p>
        ) : (
          <ul className="subtle-copy">
            {data.schedule.windows.map((window, index) => (
              <li key={window.id ?? index}>{describeWindow(window)}</li>
            ))}
          </ul>
        )}
        <div className="inline-row wrap-row" style={{ marginTop: '0.5rem' }}>
          <button type="button" onClick={handleRunNow} disabled={runningNow}>
            {runningNow ? 'Queueing...' : 'Run now'}
          </button>
        </div>
      </article>

      <article className="mini-card">
        <header>
          <strong>Per-dealer highwater</strong>
        </header>
        {dealers.length === 0 ? (
          <p className="subtle-copy">No dealer rows in <code>sweed_orders_ingest_highwater</code> yet.</p>
        ) : (
          <table className="dense-table">
            <thead>
              <tr>
                <th>Dealer</th>
                <th>Site</th>
                <th>Highwater</th>
                <th>Last poll</th>
                <th>Highwater age</th>
                <th>Backfill cursor</th>
                <th>Empty polls</th>
                <th>Orders</th>
                <th>Earliest</th>
                <th>Latest</th>
              </tr>
            </thead>
            <tbody>
              {dealers.map((dealer) => {
                const highwaterAgeMs = Date.now() - new Date(dealer.highwaterPayTime).getTime()
                const stale = highwaterAgeMs > STALE_HIGHWATER_THRESHOLD_MS
                return (
                  <tr key={dealer.dealerId}>
                    <td>{dealer.dealerId}</td>
                    <td>{dealer.siteLabel ?? '-'}</td>
                    <td>{new Date(dealer.highwaterPayTime).toLocaleString()}</td>
                    <td>{new Date(dealer.lastPolledAt).toLocaleString()}</td>
                    <td>
                      <Pill tone={stale ? 'danger' : 'success'}>{describeRelative(highwaterAgeMs)}</Pill>
                    </td>
                    <td>
                      {dealer.backfillCursorDay
                        ? `${formatDay(dealer.backfillCursorDay)} (toward ${formatDay(dealer.minPayTime)})`
                        : 'complete'}
                    </td>
                    <td>{dealer.consecutiveEmptyPolls}</td>
                    <td>{dealer.orderRowCount.toLocaleString()}</td>
                    <td>{dealer.earliestOrderPayTime ? formatDay(dealer.earliestOrderPayTime) : '-'}</td>
                    <td>{dealer.latestOrderPayTime ? new Date(dealer.latestOrderPayTime).toLocaleString() : '-'}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
        <p className="subtle-copy">
          Healthy steady-state: highwater age ≤ 30 min, consecutive empty polls bounded
          (slow stores can sit at 1–10 between transactions), backfill cursor null on both
          dealers once the per-dealer min_pay_time has been reached.
        </p>
      </article>

      <article className="mini-card">
        <header>
          <strong>Recent ingest runs</strong>
        </header>
        {recentRuns.length === 0 ? (
          <p className="subtle-copy">No runs recorded yet.</p>
        ) : (
          <table className="dense-table">
            <thead>
              <tr>
                <th>Job</th>
                <th>Status</th>
                <th>Trigger</th>
                <th>Run-at</th>
                <th>Started</th>
                <th>Finished</th>
                <th>Attempts</th>
                <th>Error</th>
              </tr>
            </thead>
            <tbody>
              {recentRuns.map((run) => (
                <tr key={run.jobId}>
                  <td>{run.jobId}</td>
                  <td>
                    <Pill tone={runStatusTone(run.status)}>{run.status}</Pill>
                  </td>
                  <td>{run.trigger ?? '-'}</td>
                  <td>{new Date(run.runAt).toLocaleString()}</td>
                  <td>{run.startedAt ? new Date(run.startedAt).toLocaleString() : '-'}</td>
                  <td>{run.finishedAt ? new Date(run.finishedAt).toLocaleString() : '-'}</td>
                  <td>{run.attemptCount}</td>
                  <td>{run.error ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </article>

      <details className="mini-card">
        <summary><strong>About this page</strong></summary>
        <p className="subtle-copy">
          This page is the operator surface for{' '}
          <a href="https://github.com/FreshlyBakedNYC/automation/issues/22" target="_blank" rel="noreferrer">
            FreshlyBakedNYC/automation#22
          </a>'s R2 phase: schedule cadence, per-dealer highwater + backfill cursor,
          stale-highwater alarm, and a manual "Run now" knob for catch-ups. The
          underlying worker is{' '}
          <code>helios/src/worker/jobs/configWorkersSweedOrdersIngestJob.ts</code>{' '}
          and the highwater table is <code>sweed_orders_ingest_highwater</code>.
        </p>
      </details>
    </section>
  )
}

function describeRelative(ms: number): string {
  const absMs = Math.abs(ms)
  if (absMs < 60_000) {
    return `${Math.round(absMs / 1_000)}s`
  }
  if (absMs < 3_600_000) {
    return `${Math.round(absMs / 60_000)}m`
  }
  if (absMs < 86_400_000) {
    return `${(absMs / 3_600_000).toFixed(1)}h`
  }
  return `${(absMs / 86_400_000).toFixed(1)}d`
}

function formatDay(iso: string): string {
  return iso.slice(0, 10)
}

function runStatusTone(status: SweedOrdersIngestRunStatus): PillProps['tone'] {
  if (status === 'succeeded') return 'success'
  if (status === 'failed' || status === 'dead_letter') return 'danger'
  if (status === 'running') return 'warning'
  return 'warning'
}

// Internal helper: the run status enum from the contracts module typed
// narrowly so the tone-mapping switch stays exhaustive if the contracts
// add a new status later.
type SweedOrdersIngestRunStatus = NonNullable<
  ConfigBackgroundTaskDetailResponse['sweedOrdersIngest']
>['recentRuns'][number]['status']
