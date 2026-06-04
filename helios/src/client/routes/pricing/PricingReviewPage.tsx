import { useEffect, useMemo, useState } from 'react'
import { Form, Link, useLoaderData, useRevalidator } from 'react-router-dom'

import {
  MutationAcceptedResponseSchema,
  type PricingRunMarketListing,
  PricingReviewResponseSchema,
  PricingRunListResponseSchema,
  buildHeliosModulePath,
  type PricingReviewItem,
  type PricingReviewResponse,
  type PricingRunListResponse,
} from '../../../shared/contracts/index.js'
import { loadJson, mutateJson } from '../../app/fetchJson.js'
import { waitForJob } from '../../app/jobPolling.js'
import type { CompetitorListing } from '../../../shared/ui/pricing-ladder/index.js'
import { CanonicalPricingLadder } from '../../components/CanonicalPricingLadder.js'
import { HoverZoomImage } from '../../components/HoverZoomImage.js'
import { Pill } from '../../components/Pill.js'
import { useRegisterCatalogSidebarSubtree } from '../catalog/catalogSidebarSubtree.js'
import { describeRecentSales, formatCount, formatCoverage, formatCurrency } from '../catalog/recentSales.js'
import { PricingNav } from './PricingNav.js'

export async function pricingReviewLoader({ request }: { request: Request }) {
  const url = new URL(request.url)
  const [review, runs] = await Promise.all([
    loadJson(`/api/pricing/review${url.search}`, PricingReviewResponseSchema),
    loadJson('/api/pricing/runs?pageSize=100', PricingRunListResponseSchema),
  ])

  return { review, runs }
}

export function PricingReviewPage() {
  // Pricing now lives under Catalog in the sidebar; keep the catalog
  // subtree registered so navigation context is consistent.
  useRegisterCatalogSidebarSubtree()
  const data = useLoaderData() as { review: PricingReviewResponse; runs: PricingRunListResponse }
  const revalidator = useRevalidator()
  const selectedRun = data.review.filters.batchId
    ? data.runs.items.find((run) => run.batchId === data.review.filters.batchId) ?? null
    : null
  const [activeLineItemId, setActiveLineItemId] = useState<number | null>(data.review.items[0]?.lineItem.lineItemId ?? null)
  const [selectedLineItemIds, setSelectedLineItemIds] = useState<number[]>([])
  const [draftValue, setDraftValue] = useState('')
  const [bulkDraftValue, setBulkDraftValue] = useState('')
  const [draftNote, setDraftNote] = useState('')
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [feedbackMessage, setFeedbackMessage] = useState<string | null>(null)
  const [isSaving, setIsSaving] = useState(false)

  const selectedItem = useMemo(
    () => data.review.items.find((item) => item.lineItem.lineItemId === activeLineItemId) ?? data.review.items[0] ?? null,
    [activeLineItemId, data.review.items],
  )
  const selectedItemRecentSalesIndicator = selectedItem
    ? describeRecentSales(selectedItem.pricingContext.recentSales.summary)
    : null
  const selectedDisplayedPrice = selectedItem ? resolveDisplayedPrice(draftValue, selectedItem) : null
  // Memoized on the stable selectedItem reference so the canonical ladder
  // doesn't rebuild its DOM (and drop an in-flight drag) on every draft
  // keystroke — see CanonicalPricingLadder's drag-survival comment.
  const selectedCompetitorListings = useMemo(
    () => (selectedItem ? mapMarketListingsToCompetitorListings(selectedItem.pricingContext.marketListings) : []),
    [selectedItem],
  )
  const selectedItems = useMemo(
    () => data.review.items.filter((item) => selectedLineItemIds.includes(item.lineItem.lineItemId)),
    [data.review.items, selectedLineItemIds],
  )
  const allVisibleSelected = data.review.items.length > 0 && selectedItems.length === data.review.items.length

  useEffect(() => {
    if (!selectedItem) {
      setDraftValue('')
      setDraftNote('')
      return
    }

    setDraftValue(readEditableInputValue(selectedItem))
    setDraftNote(selectedItem.lineItem.notes ?? '')
  }, [selectedItem])

  useEffect(() => {
    const availableIds = new Set(data.review.items.map((item) => item.lineItem.lineItemId))
    setSelectedLineItemIds((current) => current.filter((lineItemId) => availableIds.has(lineItemId)))
    if (!selectedItem && data.review.items[0]) {
      setActiveLineItemId(data.review.items[0].lineItem.lineItemId)
    }
  }, [data.review.items, selectedItem])

  async function handleSaveEdit() {
    if (!selectedItem) {
      return
    }

    setIsSaving(true)
    setErrorMessage(null)
    setFeedbackMessage(null)
    try {
      if (draftValue.trim().length === 0) {
        throw new Error('Enter a price before saving.')
      }
      const editedValue = Number(draftValue.trim())
      if (!Number.isFinite(editedValue)) {
        throw new Error('Price edits must be numeric.')
      }

      await mutateJson(`/api/proposal-line-items/${selectedItem.lineItem.lineItemId}/edit`, MutationAcceptedResponseSchema, {
        body: JSON.stringify({ editedValue: Math.round((editedValue + Number.EPSILON) * 100) / 100, expectedVersion: selectedItem.lineItem.version }),
        method: 'PATCH',
      })
      await revalidator.revalidate()
      setFeedbackMessage(`Saved ${productLabel(selectedItem)} at ${formatMoney(editedValue)}.`)
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Could not save the pricing edit.')
    } finally {
      setIsSaving(false)
    }
  }

  async function handleSaveNote() {
    if (!selectedItem) {
      return
    }

    setIsSaving(true)
    setErrorMessage(null)
    setFeedbackMessage(null)
    try {
      await mutateJson(`/api/proposal-line-items/${selectedItem.lineItem.lineItemId}/note`, MutationAcceptedResponseSchema, {
        body: JSON.stringify({ note: draftNote || null }),
        method: 'PATCH',
      })
      await revalidator.revalidate()
      setFeedbackMessage(`Saved note for ${productLabel(selectedItem)}.`)
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Could not save the note.')
    } finally {
      setIsSaving(false)
    }
  }

  async function handleDecision(decision: 'approve' | 'reject') {
    if (!selectedItem) {
      return
    }

    setIsSaving(true)
    setErrorMessage(null)
    setFeedbackMessage(null)
    try {
      const response = await mutateJson(`/api/proposal-line-items/${selectedItem.lineItem.lineItemId}/${decision}`, MutationAcceptedResponseSchema, {
        body: JSON.stringify({ expectedVersion: selectedItem.lineItem.version }),
        method: 'POST',
      })
      if (response.jobId) {
        await waitForJob(response.jobId)
      }
      await revalidator.revalidate()
      setFeedbackMessage(`${decision === 'approve' ? 'Approved' : 'Excluded'} ${productLabel(selectedItem)}.`)
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : `Could not ${decision === 'approve' ? 'approve' : 'exclude'} this pricing row.`)
    } finally {
      setIsSaving(false)
    }
  }

  async function handleBulkPriceSave() {
    if (selectedItems.length === 0) {
      setErrorMessage('Select at least one pricing row for a bulk price change.')
      return
    }

    const editedValue = Number(bulkDraftValue.trim())
    if (!Number.isFinite(editedValue)) {
      setErrorMessage('Bulk price edits must be numeric.')
      return
    }

    const editableItems = selectedItems.filter((item) => item.lineItem.approvalStatus !== 'approved')
    if (editableItems.length === 0) {
      setErrorMessage('Approved pricing rows must be superseded instead of edited in place.')
      return
    }

    setIsSaving(true)
    setErrorMessage(null)
    setFeedbackMessage(null)
    try {
      const normalizedPrice = Math.round((editedValue + Number.EPSILON) * 100) / 100
      for (const item of editableItems) {
        await mutateJson(`/api/proposal-line-items/${item.lineItem.lineItemId}/edit`, MutationAcceptedResponseSchema, {
          body: JSON.stringify({ editedValue: normalizedPrice, expectedVersion: item.lineItem.version }),
          method: 'PATCH',
        })
      }
      await revalidator.revalidate()
      const skippedCount = selectedItems.length - editableItems.length
      setFeedbackMessage(
        skippedCount > 0
          ? `Saved ${formatMoney(normalizedPrice)} on ${editableItems.length} selected row${editableItems.length === 1 ? '' : 's'} and skipped ${skippedCount} approved row${skippedCount === 1 ? '' : 's'}.`
          : `Saved ${formatMoney(normalizedPrice)} on ${editableItems.length} selected row${editableItems.length === 1 ? '' : 's'}.`,
      )
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Could not save the bulk pricing edit.')
    } finally {
      setIsSaving(false)
    }
  }

  async function handleBulkExclude() {
    if (selectedItems.length === 0) {
      setErrorMessage('Select at least one pricing row to exclude.')
      return
    }

    setIsSaving(true)
    setErrorMessage(null)
    setFeedbackMessage(null)
    try {
      for (const item of selectedItems) {
        await mutateJson(`/api/proposal-line-items/${item.lineItem.lineItemId}/reject`, MutationAcceptedResponseSchema, {
          body: JSON.stringify({ expectedVersion: item.lineItem.version }),
          method: 'POST',
        })
      }
      await revalidator.revalidate()
      setFeedbackMessage(`Excluded ${selectedItems.length} selected row${selectedItems.length === 1 ? '' : 's'} from eventual apply.`)
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Could not exclude the selected pricing rows.')
    } finally {
      setIsSaving(false)
    }
  }

  function toggleSelected(lineItemId: number) {
    setSelectedLineItemIds((current) => (
      current.includes(lineItemId)
        ? current.filter((candidate) => candidate !== lineItemId)
        : [...current, lineItemId]
    ))
  }

  function toggleSelectAllVisible() {
    setSelectedLineItemIds((current) => {
      if (allVisibleSelected) {
        return current.filter((lineItemId) => !data.review.items.some((item) => item.lineItem.lineItemId === lineItemId))
      }

      const merged = new Set(current)
      for (const item of data.review.items) {
        merged.add(item.lineItem.lineItemId)
      }
      return Array.from(merged)
    })
  }

  return (
    <section>
      <div className="page-header">
        <div>
          <p className="eyebrow">Pricing Review</p>
          <h2>Review proposed price changes</h2>
          <p className="subtle-copy">Approve or exclude proposed prices here. Saving edits keeps them in review. Approved changes are applied later in the background.</p>
        </div>
        <Link className="primary-button like-button" to={buildHeliosModulePath('pricing', 'generate')}>
          New run
        </Link>
      </div>
      <PricingNav />

      <Form className="filter-row" method="get" style={{ marginBottom: '1rem' }}>
        <input defaultValue={data.review.filters.search ?? ''} name="search" placeholder="Search product, group, or brand" />
        <select defaultValue={data.review.filters.batchId ? String(data.review.filters.batchId) : ''} name="batchId">
          <option value="">All runs</option>
          {data.runs.items.map((run) => (
            <option key={run.batchId} value={run.batchId}>{`#${run.batchId} · ${run.scopeLabel}`}</option>
          ))}
        </select>
        <select defaultValue={data.review.filters.approvalStatus ?? ''} name="approvalStatus">
          <option value="">All decisions</option>
          <option value="pending">Pending</option>
          <option value="approved">Approved</option>
          <option value="rejected">Excluded</option>
        </select>
        <label className="inline-row" style={{ gap: '0.4rem' }}>
          <input defaultChecked={data.review.filters.showSuperseded} name="showSuperseded" type="checkbox" value="true" />
          Show superseded rows
        </label>
        <button className="ghost-button" type="submit">Filter</button>
      </Form>

      {selectedRun && data.review.filters.showSuperseded ? (
        <p className="subtle-copy" style={{ marginBottom: '1rem' }}>
          Viewing all rows for run #{selectedRun.batchId}, including superseded pricing rows from older runs.
        </p>
      ) : null}

      {errorMessage ? <p className="error-text">{errorMessage}</p> : null}
      {feedbackMessage ? <p className="success-text">{feedbackMessage}</p> : null}
      {data.review.recentSalesIssue ? <p className="error-text">{data.review.recentSalesIssue}</p> : null}

      <div className="detail-panel bulk-action-bar">
        <div>
          <strong>{selectedItems.length} selected</strong>
          <div className="subtle-copy">Use bulk actions for straightforward rows. Excluded rows will not be applied.</div>
        </div>
        <div className="bulk-action-controls">
          <input
            inputMode="decimal"
            onChange={(event) => setBulkDraftValue(event.currentTarget.value)}
            placeholder="New price"
            step="0.01"
            type="number"
            value={bulkDraftValue}
          />
          <button className="ghost-button" disabled={isSaving || selectedItems.length === 0} onClick={() => void handleBulkPriceSave()} type="button">Apply price to selected</button>
          <button className="danger-button" disabled={isSaving || selectedItems.length === 0} onClick={() => void handleBulkExclude()} type="button">Exclude selected</button>
        </div>
      </div>

      <div className="pricing-review-layout">
        <div className="detail-panel">
          <div className="data-table-wrapper">
            <table className="data-table pricing-table">
              <thead>
                <tr>
                  <th>
                    <input aria-label="Select all visible pricing rows" checked={allVisibleSelected} onChange={() => toggleSelectAllVisible()} type="checkbox" />
                  </th>
                  <th>Product</th>
                  <th>Run</th>
                  <th>Live</th>
                  <th>Proposed</th>
                  <th>Delta</th>
                  <th>GM</th>
                  <th>Cost</th>
                  <th>Market</th>
                  <th>Decision</th>
                </tr>
              </thead>
              <tbody>
                {data.review.items.map((item) => {
                  const isActive = item.lineItem.lineItemId === selectedItem?.lineItem.lineItemId
                  const isChecked = selectedLineItemIds.includes(item.lineItem.lineItemId)
                  const livePrice = numericValue(item.lineItem.baselineValue)
                  const proposedPrice = item.pricingContext.proposedPrice ?? numericValue(item.lineItem.effectiveValue)
                  const delta = livePrice !== null && proposedPrice !== null ? proposedPrice - livePrice : null
                  const recentSalesIndicator = describeRecentSales(item.pricingContext.recentSales.summary)
                  return (
                    <tr className={isActive ? 'selected-table-row' : ''} key={item.lineItem.lineItemId} onClick={() => setActiveLineItemId(item.lineItem.lineItemId)}>
                      <td>
                        <input
                          aria-label={`Select ${productLabel(item)}`}
                          checked={isChecked}
                          onChange={() => toggleSelected(item.lineItem.lineItemId)}
                          onClick={(event) => event.stopPropagation()}
                          type="checkbox"
                        />
                      </td>
                      <td>
                        <strong>{productLabel(item)}</strong>
                        <div>{item.lineItem.groupSummary.groupName}</div>
                        <div className="subtle-copy">{item.lineItem.groupSummary.brandName ?? 'No brand'} · {item.pricingContext.tab ?? item.lineItem.fieldPath}</div>
                        <div className="velocity-summary-row">
                          <span className={`velocity-indicator velocity-indicator-${recentSalesIndicator.tone}`}>{recentSalesIndicator.detailLabel}</span>
                          <span className="subtle-copy">{formatCoverage(item.pricingContext.recentSales.summary)}</span>
                        </div>
                      </td>
                      <td>
                        <Link onClick={(event) => event.stopPropagation()} to={buildHeliosModulePath('pricing', `runs/${item.batchId}`)}>{`#${item.batchId}`}</Link>
                        <div className="subtle-copy">{item.pricingContext.scopeLabel}</div>
                      </td>
                      <td>{formatMoney(livePrice)}</td>
                      <td>{formatMoney(proposedPrice)}</td>
                      <td>{delta === null ? '—' : formatSignedMoney(delta)}</td>
                      <td>{formatPercent(item.pricingContext.currentGmPercent)} {'->'} {formatPercent(item.pricingContext.proposedGmPercent)}</td>
                      <td>{formatMoney(item.pricingContext.wholesaleCost)}</td>
                      <td>
                        {formatMarketReferenceText(
                          item.pricingContext.marketAveragePostTaxPrice,
                          item.pricingContext.marketMedianPostTaxPrice,
                        ) ?? '—'}
                        <div className="subtle-copy">{item.pricingContext.marketAverageLabel ?? 'No near/mid average'}</div>
                      </td>
                      <td>
                        <Pill tone={approvalTone(item.lineItem.approvalStatus)}>{reviewDecisionLabel(item.lineItem.approvalStatus)}</Pill>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>

        <aside className="detail-panel">
          {selectedItem ? (
            <>
              <div className="page-header" style={{ marginBottom: '1rem' }}>
                <div>
                  <h3 style={{ margin: 0 }}>{productLabel(selectedItem)}</h3>
                  <p className="subtle-copy" style={{ margin: '0.3rem 0 0' }}>{selectedItem.lineItem.groupSummary.groupName}</p>
                  <p className="subtle-copy">Run #{selectedItem.batchId} · {selectedItem.pricingContext.scopeLabel}</p>
                </div>
                <div className="velocity-header-stack">
                  <span className={`velocity-indicator velocity-indicator-${selectedItemRecentSalesIndicator?.tone ?? 'muted'}`}>{selectedItemRecentSalesIndicator?.detailLabel ?? 'No sales data'}</span>
                  <Pill tone={approvalTone(selectedItem.lineItem.approvalStatus)}>{reviewDecisionLabel(selectedItem.lineItem.approvalStatus)}</Pill>
                </div>
              </div>

              <div className="pricing-metric-grid" style={{ marginBottom: '1rem' }}>
                <div className="value-panel">
                  <span>Live</span>
                  <p>{formatMoney(numericValue(selectedItem.lineItem.baselineValue))}</p>
                </div>
                <div className="value-panel">
                  <span>Proposed</span>
                  <p>{formatMoney(selectedDisplayedPrice)}</p>
                </div>
                <div className="value-panel">
                  <span>Cost</span>
                  <p>{formatMoney(selectedItem.pricingContext.wholesaleCost)}</p>
                </div>
                <div className="value-panel">
                  <span>Market avg</span>
                  <p>{formatMoney(selectedItem.pricingContext.marketAveragePostTaxPrice)}</p>
                </div>
                <div className="value-panel">
                  <span>Market median</span>
                  <p>{formatMoney(selectedItem.pricingContext.marketMedianPostTaxPrice)}</p>
                </div>
                <div className="value-panel">
                  <span>Velocity</span>
                  <p>{selectedItemRecentSalesIndicator?.detailLabel ?? 'No sales data'}</p>
                </div>
              </div>

              <CanonicalPricingLadder
                competitorListings={selectedCompetitorListings}
                livePrice={numericValue(selectedItem.lineItem.baselineValue)}
                marketAveragePostTax={selectedItem.pricingContext.marketAveragePostTaxPrice}
                marketMedianPostTax={selectedItem.pricingContext.marketMedianPostTaxPrice}
                onProposedPriceChange={(next) => setDraftValue(next.toFixed(2))}
                productId={selectedItem.lineItem.targetEntityId}
                proposedPrice={selectedDisplayedPrice}
                variant="detail"
              />

              {formatMarketReferenceText(
                selectedItem.pricingContext.marketAveragePostTaxPrice,
                selectedItem.pricingContext.marketMedianPostTaxPrice,
              ) ? (
                <p className="subtle-copy" style={{ marginTop: '0.6rem', marginBottom: 0 }}>
                  {formatMarketReferenceText(
                    selectedItem.pricingContext.marketAveragePostTaxPrice,
                    selectedItem.pricingContext.marketMedianPostTaxPrice,
                  )}
                </p>
              ) : null}

              <p className="subtle-copy" style={{ marginTop: '0.6rem', marginBottom: '1rem' }}>
                {selectedItem.pricingContext.priceReason ?? 'No structured pricing reason recorded for this row.'}
              </p>

              {selectedItem.pricingContext.marketListingCount ? (
                <p className="subtle-copy" style={{ marginTop: '-0.4rem', marginBottom: '1rem' }}>
                  {selectedItem.pricingContext.marketAverageLabel ?? 'Market evidence retained for display only'}
                  {selectedItem.pricingContext.marketDispensaryCount ? ` across ${selectedItem.pricingContext.marketDispensaryCount} dispensary${selectedItem.pricingContext.marketDispensaryCount === 1 ? '' : 'ies'}` : ''}.
                </p>
              ) : null}

              <label className="stack-field">
                <span>Adjust proposed price</span>
                <input inputMode="decimal" onChange={(event) => setDraftValue(event.currentTarget.value)} step="0.01" type="number" value={draftValue} />
              </label>

              <label className="stack-field">
                <span>Review note</span>
                <textarea onChange={(event) => setDraftNote(event.currentTarget.value)} rows={3} value={draftNote} />
              </label>

              <div className="inline-row wrap-row review-actions" style={{ marginBottom: '1rem' }}>
                <button className="ghost-button" disabled={isSaving} onClick={() => void handleSaveEdit()} type="button">Save price</button>
                <button className="ghost-button" disabled={isSaving} onClick={() => void handleSaveNote()} type="button">Save note</button>
                <button className="primary-button" disabled={isSaving} onClick={() => void handleDecision('approve')} type="button">Approve</button>
                <button className="danger-button" disabled={isSaving} onClick={() => void handleDecision('reject')} type="button">Exclude</button>
              </div>

              <div style={{ marginBottom: '1rem' }}>
                <h4 style={{ marginBottom: '0.5rem' }}>Recent sales</h4>
                <div className="sales-site-grid">
                  {selectedItem.pricingContext.recentSales.sites.map((site) => {
                    const siteIndicator = describeRecentSales({
                      combinationCount: 1,
                      coverageCount: site.hasCoverage ? 1 : 0,
                      daysPerUnit: site.daysPerUnit,
                      last30DaysGrossSales: site.last30DaysGrossSales,
                      onHand: site.onHand,
                      reportDate: site.reportDate,
                      unitsPerDay: site.unitsPerDay,
                    })
                    return (
                      <article className="mini-card" key={`${site.siteDealerId}-${site.productId}`}>
                        <header>
                          <strong>{site.siteLabel}</strong>
                          <span className={`velocity-indicator velocity-indicator-${siteIndicator.tone}`}>{siteIndicator.detailLabel}</span>
                        </header>
                        <div className="subtle-copy" style={{ marginTop: '0.4rem' }}>
                          {`${formatCount(site.onHand)} on hand · ${formatCurrency(site.last30DaysGrossSales)} gross / 30d`}
                        </div>
                      </article>
                    )
                  })}
                </div>
              </div>

              {selectedItem.pricingContext.marketListings.length > 0 ? (
                <div>
                  <h4>Supporting market listings</h4>
                  <ul className="timeline-list compact-list">
                    {selectedItem.pricingContext.marketListings.map((listing, index) => (
                      <li key={`${listing.dispensaryName}-${listing.listingName}-${index}`} style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-start' }}>
                        {listing.imageUrl ? (
                          <HoverZoomImage
                            alt=""
                            openHref={listing.url ?? listing.imageUrl}
                            openTitle={listing.url ? 'Open source listing in a new tab' : 'Open image in a new tab'}
                            src={listing.imageUrl}
                            style={{ width: '2.25rem', height: '2.25rem', objectFit: 'cover', borderRadius: '3px', border: '1px solid #ddd', flex: '0 0 auto' }}
                          />
                        ) : null}
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <strong>{listing.dispensaryName}</strong>
                          <div className="subtle-copy">{listing.listingName}</div>
                          <div className="subtle-copy">{formatMoney(listing.postTaxPrice)} post-tax · {formatDistanceBandLabel(listing.distanceBand, listing.distanceMiles)} · {listing.source}</div>
                          {listing.url ? <a href={listing.url} rel="noreferrer" target="_blank">Open source listing</a> : null}
                        </div>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </>
          ) : (
            <p className="empty-state">
              {selectedRun
                ? `Run #${selectedRun.batchId} has no pricing rows for the current filters.`
                : 'No pricing rows matched the current filters.'}
            </p>
          )}
        </aside>
      </div>
    </section>
  )
}

function approvalTone(status: string): 'danger' | 'muted' | 'success' | 'warning' {
  switch (status) {
    case 'approved':
      return 'success'
    case 'rejected':
      return 'danger'
    case 'pending':
      return 'warning'
    default:
      return 'muted'
  }
}

function reviewDecisionLabel(status: string): string {
  switch (status) {
    case 'rejected':
      return 'Excluded'
    case 'approved':
      return 'Approved'
    case 'pending':
      return 'Pending'
    default:
      return status
  }
}

function formatMoney(value: number | null): string {
  return value === null ? '—' : `$${value.toFixed(2)}`
}

function formatSignedMoney(value: number): string {
  return `${value >= 0 ? '+' : '-'}$${Math.abs(value).toFixed(2)}`
}

function formatPercent(value: number | null): string {
  return value === null ? '—' : `${value.toFixed(2)}%`
}

function numericValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function resolveDisplayedPrice(draftValue: string, item: PricingReviewItem): number | null {
  return numericValueFromString(draftValue) ?? item.pricingContext.proposedPrice ?? numericValue(item.lineItem.effectiveValue)
}

function numericValueFromString(value: string): number | null {
  const parsed = Number(value.trim())
  return Number.isFinite(parsed) ? parsed : null
}

function readEditableInputValue(item: PricingReviewItem): string {
  if (typeof item.lineItem.editedValue === 'number') {
    return String(item.lineItem.editedValue)
  }
  if (typeof item.lineItem.effectiveValue === 'number') {
    return String(item.lineItem.effectiveValue)
  }
  if (typeof item.lineItem.suggestedValue === 'number') {
    return String(item.lineItem.suggestedValue)
  }
  return ''
}

function productLabel(item: PricingReviewItem): string {
  return item.pricingContext.productName ?? `Product #${item.lineItem.targetEntityId}`
}

function formatDistanceBandLabel(distanceBand: PricingRunMarketListing['distanceBand'], distanceMiles: number | null): string {
  const distanceText = distanceMiles === null ? null : `${distanceMiles.toFixed(2)}mi`
  switch (distanceBand) {
    case 'near':
      return distanceText ? `Near · ${distanceText}` : 'Near'
    case 'mid':
      return distanceText ? `Mid · ${distanceText}` : 'Mid'
    case 'far':
      return distanceText ? `Far · ${distanceText}` : 'Far'
    case 'very_far':
      return distanceText ? `Very far · ${distanceText}` : 'Very far'
    default:
      return distanceText ? `Unknown · ${distanceText}` : 'Unknown distance'
  }
}

function mapMarketListingsToCompetitorListings(listings: PricingRunMarketListing[]): CompetitorListing[] {
  return listings.map((listing, index) => ({
    listingId: `${listing.dispensaryName}-${listing.listingName}-${listing.source}-${index}`,
    postTaxPrice: listing.postTaxPrice,
    distanceMiles: listing.distanceMiles,
    dispensaryName: listing.dispensaryName,
    listingName: listing.listingName,
    url: listing.url,
    eligibleForPricing: listing.eligibleForPricing,
    matchTier: listing.matchTier,
  }))
}

function formatMarketReferenceText(averagePrice: number | null, medianPrice: number | null): string | null {
  if (averagePrice === null && medianPrice === null) {
    return null
  }

  const parts = [
    averagePrice === null ? null : `avg ${formatMoney(averagePrice)}`,
    medianPrice === null ? null : `median ${formatMoney(medianPrice)}`,
  ].filter((value): value is string => value !== null)

  return parts.length > 0 ? `Near/mid ${parts.join(' · ')}` : null
}


