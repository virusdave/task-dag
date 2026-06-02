import { useState } from 'react'
import { useLoaderData, useRevalidator } from 'react-router-dom'

import {
  ConfigBackgroundTaskDetailResponseSchema,
  ConfigBackgroundTaskRunNowResponseSchema,
  type ConfigBackgroundTaskDetailResponse,
} from '../../../shared/contracts/index.js'
import { loadJson, mutateJson } from '../../app/fetchJson.js'
import { Pill } from '../../components/Pill.js'
import { useRegisterConfigSidebarSubtree } from './configSidebarSubtree.js'
import { describeWindow } from './schedulingFormat.js'

export async function configSweedPurchasesIngestScheduleLoader(): Promise<ConfigBackgroundTaskDetailResponse> {
  return loadJson(
    '/api/config/workers/schedules/workers.scheduling.sweed_purchases_ingest',
    ConfigBackgroundTaskDetailResponseSchema,
  )
}

export function ConfigSweedPurchasesIngestSchedulePage() {
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
        '/api/config/workers/schedules/workers.scheduling.sweed_purchases_ingest/run-now',
        ConfigBackgroundTaskRunNowResponseSchema,
        {
          method: 'POST',
          body: JSON.stringify({ taskKey: 'workers.scheduling.sweed_purchases_ingest' }),
        },
      )
      setNotice(
        `Queued Sweed purchases ingest job #${response.jobId}. New PO arrivals, financial-status flips (Not paid → Fully paid), and the one-day catch-up backfill will land within the next ingest tick.`,
      )
      revalidator.revalidate()
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Failed to queue Sweed purchases ingest.')
    } finally {
      setRunningNow(false)
    }
  }

  return (
    <section>
      <div className="page-header">
        <div>
          <p className="eyebrow">Config / Workers / Scheduling</p>
          <h2>Sweed purchases ingest</h2>
          <p className="subtle-copy">
            Per-dealer poll of store.purchase.order.list every 15 minutes, materialising new POs,
            updated financial status (Not paid → Fully paid), and per-line items into{' '}
            <code>sweed_purchases</code> + <code>sweed_purchase_line_items</code>. Backs the
            Catalog → Purchase Sell-Through page family.
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
            Last enqueued:{' '}
            {data.schedule.lastEnqueuedAt
              ? new Date(data.schedule.lastEnqueuedAt).toLocaleString()
              : 'never'}
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
            {runningNow ? 'Queueing…' : 'Run now'}
          </button>
          <span className="subtle-copy">
            A manual run forward-polls every dealer, refreshes financial status on recently
            ingested POs, and does a one-day backwards catch-up burst on top of the steady-state
            schedule.
          </span>
        </div>
      </article>

      <details className="mini-card">
        <summary>
          <strong>About this page</strong>
        </summary>
        <p className="subtle-copy">
          The worker is{' '}
          <code>helios/src/worker/jobs/configWorkersSweedPurchasesIngestJob.ts</code>; per-dealer
          highwater state lives in <code>sweed_purchases_ingest_state</code>. The downstream
          consumer is the{' '}
          <a href="/catalog/purchases">Catalog → Purchase Sell-Through</a> page family.
        </p>
      </details>
    </section>
  )
}
