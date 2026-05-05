import { useEffect } from 'react'
import { Form, Link, useLoaderData, useRevalidator } from 'react-router-dom'

import {
  PricingRunListResponseSchema,
  buildHeliosModulePath,
  type PricingRunListResponse,
} from '../../../shared/contracts/index.js'
import { loadJson } from '../../app/fetchJson.js'
import { Pill } from '../../components/Pill.js'
import { PricingNav } from './PricingNav.js'

export async function pricingRunsLoader({ request }: { request: Request }) {
  const url = new URL(request.url)
  return loadJson(`/api/pricing/runs${url.search}`, PricingRunListResponseSchema)
}

export function PricingRunsPage() {
  const data = useLoaderData() as PricingRunListResponse
  const revalidator = useRevalidator()
  const hasInProgressRun = data.items.some((item) => item.status === 'draft' || item.jobStatus === 'queued' || item.jobStatus === 'running')

  useEffect(() => {
    if (!hasInProgressRun) {
      return
    }

    const intervalId = window.setInterval(() => {
      if (revalidator.state === 'idle') {
        void revalidator.revalidate()
      }
    }, 5000)

    return () => window.clearInterval(intervalId)
  }, [hasInProgressRun, revalidator])

  return (
    <section>
      <div className="page-header">
        <div>
          <p className="eyebrow">Run History</p>
          <h2>Pricing run history</h2>
          <p className="subtle-copy">Review completed and in-progress runs here, then open a run to inspect coverage before working through its queue.</p>
        </div>
        <Link className="primary-button like-button" to={buildHeliosModulePath('pricing', 'generate')}>
          New run
        </Link>
      </div>
      <PricingNav />

      {hasInProgressRun ? <p className="subtle-copy">In-progress builds refresh automatically every 5 seconds.</p> : null}

      <Form className="filter-row" method="get" style={{ marginBottom: '1rem' }}>
        <input defaultValue={data.filters.search ?? ''} name="search" placeholder="Search label, run id, or creator" />
        <select defaultValue={data.filters.status ?? ''} name="status">
          <option value="">All statuses</option>
          <option value="draft">Building</option>
          <option value="ready">Ready for review</option>
          <option value="failed">Failed</option>
          <option value="superseded">Superseded</option>
        </select>
        <button className="ghost-button" type="submit">Filter</button>
      </Form>

      <div className="data-table-wrapper">
        <table className="data-table">
          <thead>
            <tr>
              <th>Run</th>
              <th>Scope</th>
              <th>Coverage</th>
              <th>Status</th>
              <th>Source</th>
            </tr>
          </thead>
          <tbody>
            {data.items.map((item) => (
              <tr key={item.batchId}>
                <td>
                  <Link to={buildHeliosModulePath('pricing', `runs/${item.batchId}`)}>Run #{item.batchId}</Link>
                  <div className="subtle-copy">{new Date(item.createdAt).toLocaleString()}</div>
                </td>
                <td>
                  <strong>{item.scopeLabel}</strong>
                  <div className="subtle-copy">{item.scopeKind.replace(/_/g, ' ')}</div>
                </td>
                <td>
                  {item.generatedLineItemCount ?? 0} actionable / {item.skippedProductCount ?? 0} skipped
                  <div className="subtle-copy">{item.requestedGroupCount ?? item.rowCount} groups · {item.resolvedProductCount ?? '—'} products</div>
                </td>
                <td>
                  <Pill tone={item.status === 'ready' ? 'success' : item.status === 'failed' ? 'danger' : item.status === 'superseded' ? 'muted' : 'warning'}>
                    {displayRunStatus(item.status)}
                  </Pill>
                  <div className="subtle-copy">{item.jobStatus ?? 'no job'}</div>
                </td>
                <td>
                  {item.triggerSource}
                  <div className="subtle-copy">{item.summaryText}</div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}

function displayRunStatus(status: PricingRunListResponse['items'][number]['status']): string {
  switch (status) {
    case 'draft':
      return 'Building'
    case 'ready':
      return 'Ready for review'
    case 'failed':
      return 'Failed'
    case 'superseded':
      return 'Superseded'
    default:
      return status
  }
}
