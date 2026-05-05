import { useState } from 'react'
import { Form, Link, useLoaderData, useRevalidator, useRouteLoaderData } from 'react-router-dom'

import {
  CatalogBrowserResponseSchema,
  MutationAcceptedResponseSchema,
  QueueProposalBatchRequestSchema,
  QueueReviewPacketImportRequestSchema,
  buildHeliosModulePath,
  type CatalogBrowserResponse,
  type SessionEnvelope,
} from '../../../shared/contracts/index.js'
import { loadJson, mutateJson } from '../../app/fetchJson.js'
import { waitForJob } from '../../app/jobPolling.js'
import { Pill } from '../../components/Pill.js'
import { useRegisterCatalogSidebarSubtree } from './catalogSidebarSubtree.js'
import { describeRecentSales, formatCount, formatCoverage, formatCurrency } from './recentSales.js'

export async function catalogLoader({ request }: { request: Request }) {
  const url = new URL(request.url)
  return loadJson(`/api/catalog/groups${url.search}`, CatalogBrowserResponseSchema)
}

export function CatalogPage() {
  useRegisterCatalogSidebarSubtree()
  const data = useLoaderData() as CatalogBrowserResponse
  const session = useRouteLoaderData('root') as SessionEnvelope
  const revalidator = useRevalidator()
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [importFilePath, setImportFilePath] = useState('')
  const [importSuccessMessage, setImportSuccessMessage] = useState<string | null>(null)
  const [isImporting, setIsImporting] = useState(false)
  const [isGeneratingDescriptions, setIsGeneratingDescriptions] = useState(false)
  const [isGeneratingPricing, setIsGeneratingPricing] = useState(false)
  const [isRefreshingAll, setIsRefreshingAll] = useState(false)
  const [descriptionGenerationForceLiveRefresh, setDescriptionGenerationForceLiveRefresh] = useState(false)
  const [pricingGenerationForceLiveRefresh, setPricingGenerationForceLiveRefresh] = useState(false)
  const [generationSuccessMessage, setGenerationSuccessMessage] = useState<string | null>(null)

  async function handleRefresh(catalogGroupId: number) {
    setErrorMessage(null)
    try {
      const response = await mutateJson(
        `/api/catalog-groups/${catalogGroupId}/refresh`,
        MutationAcceptedResponseSchema,
        {
          body: JSON.stringify({ reason: 'Manual operator refresh' }),
          method: 'POST',
        },
      )

      if (response.jobId) {
        await waitForJob(response.jobId)
      }
      await revalidator.revalidate()
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Could not refresh this catalog group.')
    }
  }

  async function handleRefreshAll() {
    setIsRefreshingAll(true)
    setErrorMessage(null)

    try {
      const response = await mutateJson('/api/catalog/refresh', MutationAcceptedResponseSchema, {
        body: JSON.stringify({ reason: 'Manual full-catalog drift sweep' }),
        method: 'POST',
      })

      if (response.jobId) {
        await waitForJob(response.jobId)
      }
      await revalidator.revalidate()
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Could not queue the full catalog refresh.')
    } finally {
      setIsRefreshingAll(false)
    }
  }

  async function handleImportReviewPacket() {
    setIsImporting(true)
    setErrorMessage(null)
    setImportSuccessMessage(null)
    setGenerationSuccessMessage(null)

    try {
      const body = QueueReviewPacketImportRequestSchema.parse({
        filePath: importFilePath,
        reason: 'Admin review-packet import',
      })
      const response = await mutateJson('/api/proposal-imports/review-json', MutationAcceptedResponseSchema, {
        body: JSON.stringify(body),
        method: 'POST',
      })

      if (response.jobId) {
        const jobStatus = await waitForJob(response.jobId)
        if (jobStatus.job.status !== 'succeeded') {
          throw new Error(jobStatus.job.lastError ?? 'The review packet import job did not succeed.')
        }

        const proposalBatchId = jobStatus.linkedRecords.proposalBatchId
        setImportSuccessMessage(
          proposalBatchId
            ? `Imported review packet into proposal batch #${proposalBatchId}.`
            : 'Imported review packet successfully.',
        )
      } else {
        setImportSuccessMessage('Queued the review packet import successfully.')
      }

      await revalidator.revalidate()
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Could not import the review packet.')
    } finally {
      setIsImporting(false)
    }
  }

  async function handleGenerateDescriptionBatch() {
    setIsGeneratingDescriptions(true)
    setErrorMessage(null)
    setImportSuccessMessage(null)
    setGenerationSuccessMessage(null)

    try {
      const body = QueueProposalBatchRequestSchema.parse({
        catalogGroupIds: data.items.map((item) => item.catalogGroupId),
        forceLiveRefresh: descriptionGenerationForceLiveRefresh,
        proposalType: 'description',
        reason: 'Generate description proposals for currently visible catalog groups',
      })
      const response = await mutateJson('/api/proposal-batches', MutationAcceptedResponseSchema, {
        body: JSON.stringify(body),
        method: 'POST',
      })

      if (response.jobId) {
        const jobStatus = await waitForJob(response.jobId)
        if (jobStatus.job.status !== 'succeeded') {
          throw new Error(jobStatus.job.lastError ?? 'The description generation batch did not succeed.')
        }

        const proposalBatchId = jobStatus.linkedRecords.proposalBatchId
        setGenerationSuccessMessage(
          proposalBatchId
            ? `Generated description proposal batch #${proposalBatchId} for ${body.catalogGroupIds.length} visible groups.`
            : 'Generated the visible description proposal batch successfully.',
        )
      } else {
        setGenerationSuccessMessage('Queued the description proposal batch successfully.')
      }

      await revalidator.revalidate()
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Could not queue the description proposal batch.')
    } finally {
      setIsGeneratingDescriptions(false)
    }
  }

  async function handleGeneratePricingBatch() {
    setIsGeneratingPricing(true)
    setErrorMessage(null)
    setImportSuccessMessage(null)
    setGenerationSuccessMessage(null)

    try {
      const body = QueueProposalBatchRequestSchema.parse({
        catalogGroupIds: data.items.map((item) => item.catalogGroupId),
        forceLiveRefresh: pricingGenerationForceLiveRefresh,
        proposalType: 'pricing',
        reason: 'Generate pricing proposals for currently visible catalog groups',
      })
      const response = await mutateJson('/api/proposal-batches', MutationAcceptedResponseSchema, {
        body: JSON.stringify(body),
        method: 'POST',
      })

      if (response.jobId) {
        const jobStatus = await waitForJob(response.jobId)
        if (jobStatus.job.status !== 'succeeded') {
          throw new Error(jobStatus.job.lastError ?? 'The pricing generation batch did not succeed.')
        }

        const proposalBatchId = jobStatus.linkedRecords.proposalBatchId
        setGenerationSuccessMessage(
          proposalBatchId
            ? `Generated pricing proposal batch #${proposalBatchId} for ${body.catalogGroupIds.length} visible groups.`
            : 'Generated the visible pricing proposal batch successfully.',
        )
      } else {
        setGenerationSuccessMessage('Queued the pricing proposal batch successfully.')
      }

      await revalidator.revalidate()
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Could not queue the pricing proposal batch.')
    } finally {
      setIsGeneratingPricing(false)
    }
  }

  return (
    <section>
      <div className="page-header">
        <div>
          <p className="eyebrow">Catalog Browser</p>
          <h2>Mirrored groups and managed-field status</h2>
        </div>
        <div className="inline-row wrap-row">
          <Form className="filter-row" method="get">
            <input defaultValue={data.filters.search ?? ''} name="search" placeholder="Search group or brand" />
            <button className="ghost-button" type="submit">
              Filter
            </button>
          </Form>
          {session.permissions.canEditProposals ? (
            <button className="primary-button" disabled={isRefreshingAll} onClick={() => void handleRefreshAll()} type="button">
              {isRefreshingAll ? 'Queueing full refresh…' : 'Refresh all mirrored groups'}
            </button>
          ) : null}
        </div>
      </div>
      {errorMessage ? <p className="error-text">{errorMessage}</p> : null}
      {data.recentSalesIssue ? <p className="error-text">{data.recentSalesIssue}</p> : null}
      {generationSuccessMessage ? <p>{generationSuccessMessage}</p> : null}
      {importSuccessMessage ? <p>{importSuccessMessage}</p> : null}
      {session.permissions.canEditProposals ? (
        <article className="mini-card" style={{ marginBottom: '1rem' }}>
          <header>
            <strong>Generate visible description batch</strong>
            <Pill tone="warning">editor+</Pill>
          </header>
          <p className="subtle-copy">
            Queue a description proposal batch for the groups on the current catalog page. The worker persists proposal rows and
            LLM diagnostics asynchronously.
          </p>
          <label className="inline-row wrap-row" style={{ marginBottom: '0.75rem' }}>
            <input
              checked={descriptionGenerationForceLiveRefresh}
              onChange={(event) => setDescriptionGenerationForceLiveRefresh(event.currentTarget.checked)}
              type="checkbox"
            />
            Refresh live state from Sweed before generating
          </label>
          <button
            className="primary-button"
            disabled={isGeneratingDescriptions || data.items.length === 0}
            onClick={() => void handleGenerateDescriptionBatch()}
            type="button"
          >
            {isGeneratingDescriptions ? 'Generating descriptions…' : `Generate for ${data.items.length} visible groups`}
          </button>
        </article>
      ) : null}
      {session.permissions.canEditProposals ? (
        <article className="mini-card" style={{ marginBottom: '1rem' }}>
          <header>
            <strong>Generate visible pricing batch</strong>
            <Pill tone="warning">editor+</Pill>
          </header>
          <p className="subtle-copy">
            Queue pricing proposals for the groups on the current catalog page. The worker reads persisted live price and cost
            snapshots, then emits actionable `products.price` line items for out-of-band margins.
          </p>
          <label className="inline-row wrap-row" style={{ marginBottom: '0.75rem' }}>
            <input
              checked={pricingGenerationForceLiveRefresh}
              onChange={(event) => setPricingGenerationForceLiveRefresh(event.currentTarget.checked)}
              type="checkbox"
            />
            Refresh live state from Sweed before generating
          </label>
          <button
            className="primary-button"
            disabled={isGeneratingPricing || data.items.length === 0}
            onClick={() => void handleGeneratePricingBatch()}
            type="button"
          >
            {isGeneratingPricing ? 'Generating pricing…' : `Generate for ${data.items.length} visible groups`}
          </button>
        </article>
      ) : null}
      {session.user?.role === 'admin' ? (
        <article className="mini-card" style={{ marginBottom: '1rem' }}>
          <header>
            <strong>Import review packet</strong>
            <Pill tone="warning">admin</Pill>
          </header>
          <p className="subtle-copy">Queue a JSON review packet import from an absolute server file path. This only writes app state and proposal history.</p>
          <div className="filter-row">
            <input
              onChange={(event) => setImportFilePath(event.currentTarget.value)}
              placeholder="/absolute/path/to/catalog_description_mass_update_review.json"
              value={importFilePath}
            />
            <button
              className="primary-button"
              disabled={isImporting || importFilePath.trim().length === 0}
              onClick={() => void handleImportReviewPacket()}
              type="button"
            >
              {isImporting ? 'Importing review packet…' : 'Import review packet'}
            </button>
          </div>
        </article>
      ) : null}
      <div className="data-table-wrapper">
        <table className="data-table">
          <thead>
            <tr>
              <th>Group</th>
              <th>Status</th>
              <th>Tabs</th>
              <th>Desired</th>
              <th>Queue</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {data.items.map((item) => (
              <tr key={item.catalogGroupId}>
                <td>
                  <Link to={buildHeliosModulePath('catalog', `groups/${item.catalogGroupId}`)}>{item.groupName}</Link>
                  <div className="subtle-copy">{item.brandName ?? 'No brand'} · {item.categoryName ?? 'No category'}</div>
                  <div className="catalog-recent-sales-row">
                    <Pill tone={describeRecentSales(item.recentSales).tone}>{describeRecentSales(item.recentSales).detailLabel}</Pill>
                    <span className="subtle-copy">
                      {`${formatCount(item.recentSales.onHand)} on hand · ${formatCurrency(item.recentSales.last30DaysGrossSales)} gross / 30d · ${formatCoverage(item.recentSales)}`}
                    </span>
                  </div>
                </td>
                <td><Pill tone={statusTone(item.reconcileStatus)}>{item.reconcileStatus}</Pill></td>
                <td>{item.productTabs.join(', ') || '—'}</td>
                <td>{item.activeDesiredFieldCount}</td>
                <td>{item.pendingLineItemCount} pending / {item.approvedLineItemCount} approved</td>
                <td>
                  <button className="ghost-button" onClick={() => void handleRefresh(item.catalogGroupId)} type="button">
                    Refresh
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}

function statusTone(status: string): 'danger' | 'muted' | 'success' | 'warning' {
  switch (status) {
    case 'in_sync':
      return 'success'
    case 'drifted':
    case 'error':
      return 'danger'
    case 'queued':
    case 'applying':
      return 'warning'
    default:
      return 'muted'
  }
}
