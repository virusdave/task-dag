import { useState } from 'react'
import { Link } from 'react-router-dom'

import { ConfigBackgroundTaskRunNowResponseSchema } from '../../../shared/contracts/index.js'
import { mutateJson } from '../../app/fetchJson.js'
import { buildAppPath } from '../../app/paths.js'
import { Pill } from '../../components/Pill.js'
import { useRegisterCatalogSidebarSubtree } from './catalogSidebarSubtree.js'

/**
 * Canonical home for "refresh the current inventory stock"
 * (virusdave/top-level#14).
 *
 * Before the nav redesign, triggering a stock refresh could only be done
 * as a side effect of the Images & Barcodes "Fix cache" button or from
 * Config → Workers → Scheduling → Stock's "Run now" control — neither of
 * which is where an operator would think to look. This page gives the
 * action an obvious, discoverable home under Catalog & Inventory.
 *
 * It reuses the EXISTING enqueue path (the same
 * `workers.scheduling.stock` run-now endpoint that ConfigStockSchedulePage
 * uses) — there is no new backend service, table, or recurring workload.
 * Nothing is enqueued on page load; the button is disabled while a
 * request is in flight so an impatient double-click cannot queue
 * duplicate jobs.
 *
 * Per-site scoping: the underlying `workers.scheduling.stock` job has no
 * per-site `siteKey` parameter today — a run scans every site — so this
 * page accurately labels the action as all-site. A true per-site refresh
 * is a separate backend task (out of scope for v1 of this epic).
 */
export function StockRefreshPage() {
  useRegisterCatalogSidebarSubtree()
  const [running, setRunning] = useState(false)
  const [queuedJobId, setQueuedJobId] = useState<number | null>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  async function handleRefreshNow() {
    setErrorMessage(null)
    setRunning(true)
    try {
      const response = await mutateJson(
        '/api/config/workers/schedules/workers.scheduling.stock/run-now',
        ConfigBackgroundTaskRunNowResponseSchema,
        {
          method: 'POST',
          body: JSON.stringify({ taskKey: 'workers.scheduling.stock' }),
        },
      )
      setQueuedJobId(response.jobId)
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Failed to queue stock refresh.')
    } finally {
      setRunning(false)
    }
  }

  return (
    <section>
      <div className="page-header">
        <div>
          <p className="eyebrow">Catalog &amp; Inventory / Inventory</p>
          <h2>Stock refresh</h2>
          <p className="subtle-copy">
            Refresh the current inventory stock. Queues a full per-site stock
            scan (including out-of-stock items); variants transitioning from
            out-of-stock to in-stock auto-enqueue a Lit Alerts refresh.
          </p>
        </div>
        <Pill tone="success">live</Pill>
      </div>

      {errorMessage ? <p className="error-copy">{errorMessage}</p> : null}

      <article className="mini-card">
        <header>
          <strong>Refresh now</strong>
        </header>
        <p className="subtle-copy">
          This scans <strong>every site</strong> — the stock-refresh job does
          not yet take a per-site parameter, so there is one button rather
          than a per-site selector. (A true per-site refresh is tracked as a
          separate backend task.)
        </p>
        <div className="inline-row wrap-row" style={{ marginTop: '0.5rem' }}>
          <button
            type="button"
            className="primary-button"
            onClick={() => void handleRefreshNow()}
            disabled={running}
          >
            {running ? 'Queueing…' : 'Refresh stock now'}
          </button>
        </div>

        {queuedJobId !== null ? (
          <p className="success-copy" style={{ marginTop: '0.75rem' }}>
            Queued stock-refresh job #{queuedJobId}.{' '}
            <Link to={`/jobs/${queuedJobId}`}>View job →</Link>{' '}
            <Link to="/jobs">(all jobs)</Link>
          </p>
        ) : null}
      </article>

      <article className="mini-card">
        <header>
          <strong>Download snapshot</strong>
        </header>
        <p className="subtle-copy">
          Export the current inventory as CSV — one row per <strong>site × variant</strong>
          {' '}with structured attributes, pricing, on-hand quantities, the synthetic
          {' '}<code>cohort_key</code> (the same peer grouping the cohort scatter plots use),
          {' '}and <code>has_image</code>. No sales data.
        </p>
        <div className="inline-row wrap-row" style={{ marginTop: '0.5rem' }}>
          <a
            className="ghost-button like-button"
            href={buildAppPath('/api/catalog/inventory/stock-snapshot.csv')}
          >
            Download current stock CSV
          </a>
        </div>
      </article>

      <article className="mini-card">
        <header>
          <strong>Scheduling</strong>
        </header>
        <p className="subtle-copy">
          To change how often stock refreshes run automatically, edit the
          windows under{' '}
          <Link to="/config/workers/scheduling/stock">
            Admin &amp; Config → Workers → Scheduling → Stock
          </Link>
          .
        </p>
      </article>
    </section>
  )
}
