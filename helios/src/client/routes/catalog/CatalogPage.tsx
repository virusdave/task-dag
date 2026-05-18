import { useState } from 'react'
import { Form, Link, useLoaderData, useRevalidator, useRouteLoaderData, useSearchParams } from 'react-router-dom'

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

const PAGE_SIZE_CHOICES = [25, 50, 100] as const

export async function catalogLoader({ request }: { request: Request }) {
  const url = new URL(request.url)
  return loadJson(`/api/catalog/groups${url.search}`, CatalogBrowserResponseSchema)
}

export function CatalogPage() {
  useRegisterCatalogSidebarSubtree()
  const data = useLoaderData() as CatalogBrowserResponse
  const session = useRouteLoaderData('root') as SessionEnvelope
  const revalidator = useRevalidator()
  const [searchParams] = useSearchParams()
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

  const currentPage = data.filters.page
  const currentPageSize = data.filters.pageSize
  const totalCount = data.totalCount
  const pageStart = totalCount === 0 ? 0 : (currentPage - 1) * currentPageSize + 1
  const pageEnd = Math.min(currentPage * currentPageSize, totalCount)
  const totalPages = totalCount === 0 ? 1 : Math.ceil(totalCount / currentPageSize)
  const hasPrev = currentPage > 1
  const hasNext = currentPage < totalPages
  const hasAnyFilter = Boolean(
    data.filters.search ||
      data.filters.brand ||
      data.filters.category ||
      data.filters.subcategory ||
      data.filters.reconcileStatus ||
      data.filters.size,
  )
  const browserPath = buildHeliosModulePath('catalog', 'browser')

  function buildPageHref(nextPage: number): string {
    const params = new URLSearchParams(searchParams)
    params.set('page', String(nextPage))
    return `${browserPath}?${params.toString()}`
  }

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
      </div>
      {errorMessage ? <p className="error-text">{errorMessage}</p> : null}
      {data.recentSalesIssue ? <p className="error-text">{data.recentSalesIssue}</p> : null}
      {generationSuccessMessage ? <p>{generationSuccessMessage}</p> : null}
      {importSuccessMessage ? <p>{importSuccessMessage}</p> : null}

      <article className="mini-card" style={{ marginBottom: '1rem' }}>
        <Form className="filter-row wrap-row" method="get">
          <label className="stack-field" style={{ minWidth: '14rem', flex: '1 1 14rem' }}>
            <span>Search</span>
            <input defaultValue={data.filters.search ?? ''} name="search" placeholder="Group or brand" />
          </label>
          <label className="stack-field" style={{ minWidth: '10rem' }}>
            <span>Brand</span>
            <select defaultValue={data.filters.brand ?? ''} name="brand">
              <option value="">All brands</option>
              {data.facets.brands.map((brand) => (
                <option key={brand} value={brand}>
                  {brand}
                </option>
              ))}
            </select>
          </label>
          <label className="stack-field" style={{ minWidth: '10rem' }}>
            <span>Category</span>
            <select defaultValue={data.filters.category ?? ''} name="category">
              <option value="">All categories</option>
              {data.facets.categories.map((category) => (
                <option key={category} value={category}>
                  {category}
                </option>
              ))}
            </select>
          </label>
          <label className="stack-field" style={{ minWidth: '10rem' }}>
            <span>Subcategory</span>
            <select defaultValue={data.filters.subcategory ?? ''} name="subcategory">
              <option value="">All subcategories</option>
              {data.facets.subcategories.map((subcategory) => (
                <option key={subcategory} value={subcategory}>
                  {subcategory}
                </option>
              ))}
            </select>
          </label>
          <label className="stack-field" style={{ minWidth: '8rem' }}>
            <span>Size</span>
            <select defaultValue={data.filters.size ?? ''} name="size">
              <option value="">Any size</option>
              {data.facets.sizes.map((size) => (
                <option key={size} value={size}>
                  {size}
                </option>
              ))}
            </select>
          </label>
          <label className="stack-field" style={{ minWidth: '9rem' }}>
            <span>Status</span>
            <select defaultValue={data.filters.reconcileStatus ?? ''} name="reconcileStatus">
              <option value="">Any status</option>
              {data.facets.reconcileStatuses.map((status) => (
                <option key={status} value={status}>
                  {status}
                </option>
              ))}
            </select>
          </label>
          <label className="stack-field" style={{ minWidth: '7rem' }}>
            <span>Per page</span>
            <select defaultValue={String(currentPageSize)} name="pageSize">
              {PAGE_SIZE_CHOICES.map((size) => (
                <option key={size} value={String(size)}>
                  {size}
                </option>
              ))}
            </select>
          </label>
          {/* Always reset to page 1 when filters change; otherwise the
              previous page param would survive a narrowed result set. */}
          <input type="hidden" name="page" value="1" />
          <div className="inline-row wrap-row" style={{ alignSelf: 'flex-end' }}>
            <button className="primary-button" type="submit">
              Apply
            </button>
            {hasAnyFilter ? (
              <Link className="ghost-button like-button" to={browserPath}>
                Clear all
              </Link>
            ) : null}
          </div>
        </Form>
      </article>

      <div className="inline-row wrap-row" style={{ alignItems: 'center', marginBottom: '0.75rem', justifyContent: 'space-between' }}>
        <span className="subtle-copy">
          {totalCount === 0
            ? 'No groups match the current filters.'
            : `Showing ${pageStart.toLocaleString()}–${pageEnd.toLocaleString()} of ${totalCount.toLocaleString()} groups`}
        </span>
        <div className="inline-row" style={{ gap: '0.25rem' }}>
          {hasPrev ? (
            <Link className="ghost-button like-button" to={buildPageHref(currentPage - 1)}>
              ← Prev
            </Link>
          ) : (
            <button className="ghost-button" disabled type="button">
              ← Prev
            </button>
          )}
          <span className="subtle-copy" style={{ padding: '0 0.5rem' }}>
            Page {currentPage} of {totalPages}
          </span>
          {hasNext ? (
            <Link className="ghost-button like-button" to={buildPageHref(currentPage + 1)}>
              Next →
            </Link>
          ) : (
            <button className="ghost-button" disabled type="button">
              Next →
            </button>
          )}
        </div>
      </div>

      <div className="data-table-wrapper">
        <table className="data-table">
          <thead>
            <tr>
              <th>Group</th>
              <th>Status</th>
              <th>Recent sales</th>
              <th>Tabs</th>
              <th>Desired</th>
              <th>Queue</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {data.items.map((item) => {
              const salesPill = describeRecentSales(item.recentSales)
              return (
                <tr key={item.catalogGroupId}>
                  <td>
                    <Link to={buildHeliosModulePath('catalog', `groups/${item.catalogGroupId}`)}>{item.groupName}</Link>
                    <div className="subtle-copy">
                      {item.brandName ?? 'No brand'} · {item.categoryName ?? 'No category'}
                      {item.subcategoryName ? ` · ${item.subcategoryName}` : ''}
                    </div>
                  </td>
                  <td>
                    <Pill tone={statusTone(item.reconcileStatus)}>{item.reconcileStatus}</Pill>
                  </td>
                  <td>
                    <Pill tone={salesPill.tone}>{salesPill.detailLabel}</Pill>
                    <div className="subtle-copy">
                      {`${formatCount(item.recentSales.onHand)} on hand · ${formatCurrency(item.recentSales.last30DaysGrossSales)} / 30d · ${formatCoverage(item.recentSales)}`}
                    </div>
                  </td>
                  <td>{item.productTabs.join(', ') || '—'}</td>
                  <td>{item.activeDesiredFieldCount}</td>
                  <td>
                    {item.pendingLineItemCount} pending / {item.approvedLineItemCount} approved
                  </td>
                  <td>
                    <button className="ghost-button" onClick={() => void handleRefresh(item.catalogGroupId)} type="button">
                      Refresh
                    </button>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {session.permissions.canEditProposals ? (
        <details className="mini-card" style={{ marginTop: '1.5rem' }}>
          <summary>
            <strong>Generate batch from visible groups</strong>{' '}
            <span className="subtle-copy">({data.items.length} on this page)</span>
          </summary>
          <p className="subtle-copy" style={{ marginTop: '0.5rem' }}>
            Queue a description or pricing proposal batch for the {data.items.length} groups currently visible on this page. Worker
            persists proposal rows and LLM diagnostics asynchronously. To act on a larger set, narrow filters and apply, then re-open this card.
          </p>
          <div className="inline-row wrap-row" style={{ gap: '1rem', marginTop: '0.75rem' }}>
            <article style={{ flex: '1 1 18rem' }}>
              <header>
                <strong>Description batch</strong> <Pill tone="warning">editor+</Pill>
              </header>
              <label className="inline-row wrap-row" style={{ margin: '0.5rem 0' }}>
                <input
                  checked={descriptionGenerationForceLiveRefresh}
                  onChange={(event) => setDescriptionGenerationForceLiveRefresh(event.currentTarget.checked)}
                  type="checkbox"
                />
                Refresh live state from Sweed first
              </label>
              <button
                className="primary-button"
                disabled={isGeneratingDescriptions || data.items.length === 0}
                onClick={() => void handleGenerateDescriptionBatch()}
                type="button"
              >
                {isGeneratingDescriptions ? 'Generating…' : `Generate for ${data.items.length} groups`}
              </button>
            </article>
            <article style={{ flex: '1 1 18rem' }}>
              <header>
                <strong>Pricing batch</strong> <Pill tone="warning">editor+</Pill>
              </header>
              <label className="inline-row wrap-row" style={{ margin: '0.5rem 0' }}>
                <input
                  checked={pricingGenerationForceLiveRefresh}
                  onChange={(event) => setPricingGenerationForceLiveRefresh(event.currentTarget.checked)}
                  type="checkbox"
                />
                Refresh live state from Sweed first
              </label>
              <button
                className="primary-button"
                disabled={isGeneratingPricing || data.items.length === 0}
                onClick={() => void handleGeneratePricingBatch()}
                type="button"
              >
                {isGeneratingPricing ? 'Generating…' : `Generate for ${data.items.length} groups`}
              </button>
            </article>
          </div>
        </details>
      ) : null}

      {session.permissions.canEditProposals || session.user?.role === 'admin' ? (
        <details className="mini-card" style={{ marginTop: '1rem' }}>
          <summary>
            <strong>Operations &amp; admin tools</strong>
          </summary>
          {session.permissions.canEditProposals ? (
            <div style={{ marginTop: '0.75rem' }}>
              <p className="subtle-copy">
                Re-run the full mirrored catalog sync. Use this when you suspect drift across many groups.
              </p>
              <button className="primary-button" disabled={isRefreshingAll} onClick={() => void handleRefreshAll()} type="button">
                {isRefreshingAll ? 'Queueing full refresh…' : 'Refresh all mirrored groups'}
              </button>
            </div>
          ) : null}
          {session.user?.role === 'admin' ? (
            <div style={{ marginTop: '1rem' }}>
              <header>
                <strong>Import review packet</strong> <Pill tone="warning">admin</Pill>
              </header>
              <p className="subtle-copy">Queue a JSON review packet import from an absolute server file path.</p>
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
                  {isImporting ? 'Importing…' : 'Import review packet'}
                </button>
              </div>
            </div>
          ) : null}
        </details>
      ) : null}
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
