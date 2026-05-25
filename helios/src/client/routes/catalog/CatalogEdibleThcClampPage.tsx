import { useState } from 'react'
import { Link, useLoaderData, useRevalidator } from 'react-router-dom'

import {
  ConfigBackgroundTaskDetailResponseSchema,
  ConfigBackgroundTaskRunNowResponseSchema,
  buildHeliosModulePath,
  type ConfigBackgroundTaskDetailResponse,
} from '../../../shared/contracts/index.js'
import { loadJson, mutateJson } from '../../app/fetchJson.js'
import { Pill } from '../../components/Pill.js'
import { useRegisterCatalogSidebarSubtree } from './catalogSidebarSubtree.js'

/**
 * Catalog → Edible THC clamp.
 *
 * Triggers (and shows the cadence of) the `config.workers.edible_thc_clamp`
 * background job, which sweeps Bronx + Midtown edibles (category 7459) and
 * rewrites each in-stock variant's Total THC lab data so the per-package
 * figure is clamped at 100 mg. Sweed's daily-purchase-limit calc reads
 * `contentPerProduct` when it is explicitly set; leaving it implicit lets
 * Sweed fall back to `contentPercent * netWeight`, which routinely rounds
 * over 100 mg for lab-tested gummies and trips the limit guard incorrectly.
 *
 * The button below enqueues a one-off manual run via the shared
 * `/api/config/workers/schedules/.../run-now` endpoint. The same job also
 * runs every 15 minutes from the worker scheduler, so this page is for
 * "do it now" cases (a fresh lot just arrived, an operator noticed the
 * limit-guard banner on a sale, etc.) — the 15-minute background sweep is
 * the catch-all.
 */
export async function catalogEdibleThcClampLoader(): Promise<ConfigBackgroundTaskDetailResponse> {
  return loadJson(
    '/api/config/workers/schedules/workers.scheduling.edible_thc_clamp',
    ConfigBackgroundTaskDetailResponseSchema,
  )
}

export function CatalogEdibleThcClampPage() {
  useRegisterCatalogSidebarSubtree()
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
        '/api/config/workers/schedules/workers.scheduling.edible_thc_clamp/run-now',
        ConfigBackgroundTaskRunNowResponseSchema,
        {
          method: 'POST',
          body: JSON.stringify({ taskKey: 'workers.scheduling.edible_thc_clamp' }),
        },
      )
      setNotice(`Queued edible-THC-clamp job #${response.jobId}. Watch /jobs for progress.`)
      revalidator.revalidate()
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : 'Failed to queue edible-THC-clamp job.',
      )
    } finally {
      setRunningNow(false)
    }
  }

  const lastEnqueuedAt = data.schedule.lastEnqueuedAt
    ? new Date(data.schedule.lastEnqueuedAt).toLocaleString()
    : 'never'

  const windowSummary =
    data.schedule.windows.length === 0
      ? 'No windows configured.'
      : data.schedule.windows
          .map((window) => {
            const start = minuteOfDayToHHMM(window.windowStartMinute)
            const end = minuteOfDayToHHMM(window.windowEndMinute)
            const paused = window.paused ? ' (PAUSED)' : ''
            return `${start}–${end} every ${window.intervalMinutes}m${paused}`
          })
          .join(', ')

  return (
    <section>
      <div className="page-header">
        <div>
          <p className="eyebrow">Catalog Module</p>
          <h2>Edible THC clamp</h2>
          <p className="subtle-copy">
            Force-clamp every in-stock edible variant&apos;s Total THC lab data at
            100&nbsp;mg/package. Use this if a fresh lot landed mid-sweep and the
            cashier is hitting Sweed&apos;s daily-purchase-limit guard. The same job
            also runs every 15 minutes in the background.
          </p>
        </div>
        <Pill tone="success">live</Pill>
      </div>

      {notice ? <p className="success-copy">{notice}</p> : null}
      {errorMessage ? <p className="error-copy">{errorMessage}</p> : null}

      <article className="mini-card">
        <header>
          <strong>Status</strong>
          <span className="subtle-copy">
            Last enqueued: {lastEnqueuedAt}
            {data.schedule.lastEnqueuedJobId
              ? ` (job #${data.schedule.lastEnqueuedJobId})`
              : ''}
          </span>
        </header>
        <p className="subtle-copy" style={{ marginTop: '0.5rem' }}>
          Schedule: {windowSummary}
        </p>
        <div className="inline-row wrap-row" style={{ marginTop: '0.75rem' }}>
          <button
            type="button"
            className="primary-button"
            onClick={() => void handleRunNow()}
            disabled={runningNow}
          >
            {runningNow ? 'Queueing…' : 'Force clamp now'}
          </button>
          <Link
            to={buildHeliosModulePath('config', 'workers/scheduling')}
            className="ghost-button"
          >
            Edit cadence
          </Link>
        </div>
      </article>

      <article className="mini-card">
        <header>
          <strong>What it does</strong>
        </header>
        <ul style={{ marginTop: '0.25rem' }}>
          <li>Sites: Bronx + Midtown (the pending-purchase site dealers).</li>
          <li>Category: id&nbsp;7459 (Edibles). Beverages and EdiblesCB are not touched.</li>
          <li>
            Parses each product name for an advertised total mg (patterns
            <code> Nx&nbsp;Ymg</code>, <code>Nmg</code>, <code>0.Ng</code>) and
            writes <code>extendedLabData[totalTHC].contentPerProduct =
            min(parsed, 100)</code>, scaling <code>contentPerUnit</code> by
            <code>packOfSize</code>.
          </li>
          <li>
            Skips zero-stock lots (Sweed returns &quot;Barcode not found&quot;
            on depleted items and they don&apos;t affect the live limit calc)
            and noops items that are already at the target value.
          </li>
        </ul>
      </article>
    </section>
  )
}

function minuteOfDayToHHMM(minutes: number): string {
  const normalized = ((minutes % 1440) + 1440) % 1440
  const hour = Math.floor(normalized / 60)
  const minute = normalized % 60
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
}
