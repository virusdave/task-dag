import { useEffect, useMemo, useState } from 'react'
import { Link, useLoaderData, useRevalidator } from 'react-router-dom'

import {
  MutationAcceptedResponseSchema,
  PricingRunDetailResponseSchema,
  buildHeliosModulePath,
  type PricingReviewItem,
  type PricingRunDetailResponse,
  type PricingRunMarketListing,
} from '../../../shared/contracts/index.js'
import { loadJson, mutateJson } from '../../app/fetchJson.js'
import { waitForJob } from '../../app/jobPolling.js'
import { Pill } from '../../components/Pill.js'
import { useRegisterCatalogSidebarSubtree } from '../catalog/catalogSidebarSubtree.js'
import { describeRecentSales, formatCount, formatCurrency } from '../catalog/recentSales.js'
import { PricingNav } from './PricingNav.js'

export async function pricingRunDetailLoader({ params }: { params: Record<string, string | undefined> }) {
  return loadJson(`/api/pricing/runs/${params.proposalBatchId}`, PricingRunDetailResponseSchema)
}

export function PricingRunDetailPage() {
  // Catalog sidebar context for the new under-Catalog placement.
  useRegisterCatalogSidebarSubtree()
  const data = useLoaderData() as PricingRunDetailResponse
  const revalidator = useRevalidator()
  const reviewQueuePath = data.run.status === 'superseded'
    ? `${buildHeliosModulePath('pricing', 'review')}?batchId=${data.run.batchId}&showSuperseded=true`
    : `${buildHeliosModulePath('pricing', 'review')}?batchId=${data.run.batchId}&approvalStatus=pending&showSuperseded=true`
  const isBuildInProgress = data.run.status === 'draft' || data.run.jobStatus === 'queued' || data.run.jobStatus === 'running'
  const requestedGroupCount = data.run.requestedGroupCount ?? data.totals.groupCount
  const generatedGroupCount = data.run.generatedGroupCount ?? data.totals.groupCount
  const generatedLineItemCount = data.run.generatedLineItemCount ?? data.totals.generatedProductCount
  const skippedProductCount = data.run.skippedProductCount ?? data.totals.skippedProductCount
  const currentGroupName = readStringField(data.run.rawSummary, 'currentGroupName')
  const [draftValues, setDraftValues] = useState<Record<number, string>>({})
  const [draftNotes, setDraftNotes] = useState<Record<number, string>>({})
  const [brandDrafts, setBrandDrafts] = useState<Record<string, string>>({})
  const [groupDrafts, setGroupDrafts] = useState<Record<number, string>>({})
  const [collapsedBrandKeys, setCollapsedBrandKeys] = useState<Set<string>>(new Set())
  const [collapsedGroupIds, setCollapsedGroupIds] = useState<Set<number>>(new Set())
  const [isSaving, setIsSaving] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [feedbackMessage, setFeedbackMessage] = useState<string | null>(null)

  const brandSections = useMemo(() => {
    const sections = new Map<string, {
      brandName: string
      groups: PricingRunDetailResponse['groups']
      key: string
      reviewItems: PricingReviewItem[]
    }>()

    for (const group of data.groups) {
      const brandName = group.brandName ?? 'Unbranded'
      const key = brandName.toLowerCase()
      const existing = sections.get(key)
      if (existing) {
        existing.groups.push(group)
        existing.reviewItems.push(...group.reviewItems)
      } else {
        sections.set(key, {
          brandName,
          groups: [group],
          key,
          reviewItems: [...group.reviewItems],
        })
      }
    }

    return [...sections.values()].sort((left, right) => left.brandName.localeCompare(right.brandName))
  }, [data.groups])

  useEffect(() => {
    if (!isBuildInProgress) {
      return
    }

    const intervalId = window.setInterval(() => {
      if (revalidator.state === 'idle') {
        void revalidator.revalidate()
      }
    }, 5000)

    return () => window.clearInterval(intervalId)
  }, [isBuildInProgress, revalidator])

  useEffect(() => {
    const nextDraftValues = Object.fromEntries(
      data.groups.flatMap((group) => group.reviewItems.map((item) => [item.lineItem.lineItemId, readEditableInputValue(item)])),
    )
    const nextDraftNotes = Object.fromEntries(
      data.groups.flatMap((group) => group.reviewItems.map((item) => [item.lineItem.lineItemId, item.lineItem.notes ?? ''])),
    )

    setDraftValues((current) => ({ ...nextDraftValues, ...current }))
    setDraftNotes((current) => ({ ...nextDraftNotes, ...current }))
  }, [data.groups])

  useEffect(() => {
    setCollapsedGroupIds((current) => {
      const next = new Set(current)
      for (const group of data.groups) {
        if (countPendingItems(group.reviewItems) === 0) {
          next.add(group.proposalRowId)
        }
      }
      return next
    })
    setCollapsedBrandKeys((current) => {
      const next = new Set(current)
      for (const brand of brandSections) {
        if (countPendingItems(brand.reviewItems) === 0) {
          next.add(brand.key)
        }
      }
      return next
    })
  }, [brandSections, data.groups])

  async function handleSaveEdit(item: PricingReviewItem) {
    setIsSaving(true)
    setErrorMessage(null)
    setFeedbackMessage(null)
    try {
      const draftValue = draftValues[item.lineItem.lineItemId] ?? ''
      const editedValue = Number(draftValue.trim())
      if (!Number.isFinite(editedValue)) {
        throw new Error('Price edits must be numeric when you save them.')
      }

      await mutateJson(`/api/proposal-line-items/${item.lineItem.lineItemId}/edit`, MutationAcceptedResponseSchema, {
        body: JSON.stringify({ editedValue: roundCurrency(editedValue), expectedVersion: item.lineItem.version }),
        method: 'PATCH',
      })
      await revalidator.revalidate()
      setFeedbackMessage(`Saved ${productLabel(item)} at ${formatMoney(editedValue)}.`)
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Could not save the pricing edit.')
    } finally {
      setIsSaving(false)
    }
  }

  async function handleSaveNote(item: PricingReviewItem) {
    setIsSaving(true)
    setErrorMessage(null)
    setFeedbackMessage(null)
    try {
      await mutateJson(`/api/proposal-line-items/${item.lineItem.lineItemId}/note`, MutationAcceptedResponseSchema, {
        body: JSON.stringify({ note: (draftNotes[item.lineItem.lineItemId] ?? '').trim() || null }),
        method: 'PATCH',
      })
      await revalidator.revalidate()
      setFeedbackMessage(`Saved note for ${productLabel(item)}.`)
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Could not save the note.')
    } finally {
      setIsSaving(false)
    }
  }

  async function handleDecision(item: PricingReviewItem, decision: 'approve' | 'reject') {
    setIsSaving(true)
    setErrorMessage(null)
    setFeedbackMessage(null)
    try {
      const response = await mutateJson(`/api/proposal-line-items/${item.lineItem.lineItemId}/${decision}`, MutationAcceptedResponseSchema, {
        body: JSON.stringify({ expectedVersion: item.lineItem.version }),
        method: 'POST',
      })
      if (response.jobId) {
        await waitForJob(response.jobId)
      }
      await revalidator.revalidate()
      setFeedbackMessage(`${decision === 'approve' ? 'Approved' : 'Excluded'} ${productLabel(item)}.`)
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : `Could not ${decision === 'approve' ? 'approve' : 'exclude'} this pricing row.`)
    } finally {
      setIsSaving(false)
    }
  }

  async function handleBatchPriceApply(items: PricingReviewItem[], draftValue: string, label: string) {
    const editableItems = items.filter((item) => item.lineItem.approvalStatus === 'pending')
    if (editableItems.length === 0) {
      setErrorMessage(`${label} has no pending pricing rows left to update.`)
      return
    }

    const editedValue = Number(draftValue.trim())
    if (!Number.isFinite(editedValue)) {
      setErrorMessage(`${label} needs a numeric price before you apply it.`)
      return
    }

    setIsSaving(true)
    setErrorMessage(null)
    setFeedbackMessage(null)
    try {
      const normalizedPrice = roundCurrency(editedValue)
      for (const item of editableItems) {
        await mutateJson(`/api/proposal-line-items/${item.lineItem.lineItemId}/edit`, MutationAcceptedResponseSchema, {
          body: JSON.stringify({ editedValue: normalizedPrice, expectedVersion: item.lineItem.version }),
          method: 'PATCH',
        })
      }
      await revalidator.revalidate()
      setFeedbackMessage(`Saved ${formatMoney(normalizedPrice)} across ${editableItems.length} pending row${editableItems.length === 1 ? '' : 's'} in ${label}.`)
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : `Could not apply the batch price for ${label}.`)
    } finally {
      setIsSaving(false)
    }
  }

  async function handleGroupDecision(items: PricingReviewItem[], decision: 'approve' | 'reject', label: string) {
    const pendingItems = items.filter((item) => item.lineItem.approvalStatus === 'pending')
    if (pendingItems.length === 0) {
      setErrorMessage(`${label} has no pending pricing rows left.`)
      return
    }

    setIsSaving(true)
    setErrorMessage(null)
    setFeedbackMessage(null)
    try {
      const jobIds: number[] = []
      for (const item of pendingItems) {
        const response = await mutateJson(`/api/proposal-line-items/${item.lineItem.lineItemId}/${decision}`, MutationAcceptedResponseSchema, {
          body: JSON.stringify({ expectedVersion: item.lineItem.version }),
          method: 'POST',
        })
        if (response.jobId) {
          jobIds.push(response.jobId)
        }
      }
      for (const jobId of jobIds) {
        await waitForJob(jobId)
      }
      await revalidator.revalidate()
      setFeedbackMessage(`${decision === 'approve' ? 'Approved' : 'Excluded'} ${pendingItems.length} pending row${pendingItems.length === 1 ? '' : 's'} in ${label}.`)
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : `Could not update the pending rows in ${label}.`)
    } finally {
      setIsSaving(false)
    }
  }

  function adjustDraftValue(item: PricingReviewItem, delta: number) {
    const currentValue = draftValues[item.lineItem.lineItemId] ?? readEditableInputValue(item)
    const baseValue = Number(currentValue)
    const nextValue = Number.isFinite(baseValue)
      ? roundCurrency(baseValue + delta)
      : roundCurrency((item.pricingContext.proposedPrice ?? numericValue(item.lineItem.effectiveValue) ?? 0) + delta)
    setDraftValues((current) => ({ ...current, [item.lineItem.lineItemId]: nextValue.toFixed(2) }))
  }

  function toggleBrandCollapsed(brandKey: string) {
    setCollapsedBrandKeys((current) => toggleSetValue(current, brandKey))
  }

  function toggleGroupCollapsed(proposalRowId: number) {
    setCollapsedGroupIds((current) => toggleSetValue(current, proposalRowId))
  }

  return (
    <section>
      <div className="page-header">
        <div>
          <p className="eyebrow">Pricing Run Review</p>
          <h2>{data.run.scopeLabel}</h2>
          <p className="subtle-copy">Run #{data.run.batchId} · {new Date(data.run.createdAt).toLocaleString()}</p>
          <p className="subtle-copy">
            {data.run.status === 'superseded'
              ? 'This run has been superseded by a newer run, but you can still review and inspect its grouped pricing rows here.'
              : isBuildInProgress
                ? 'This run is still building. Helios refreshes this page automatically so you can watch progress live.'
                : 'This is the DB-backed grouped pricing review surface for one run. Edits, notes, approvals, and exclusions write through the existing review lifecycle.'}
          </p>
        </div>
        <div className="inline-row wrap-row">
          <Pill tone={data.run.status === 'ready' ? 'success' : data.run.status === 'failed' ? 'danger' : 'warning'}>
            {displayRunStatus(data.run.status)}
          </Pill>
          <Link className="ghost-button like-button" to={reviewQueuePath}>
            Open flat review queue
          </Link>
        </div>
      </div>
      <PricingNav />

      {errorMessage ? <p className="error-text">{errorMessage}</p> : null}
      {feedbackMessage ? <p className="success-text">{feedbackMessage}</p> : null}
      {data.recentSalesIssue ? <p className="error-text">{data.recentSalesIssue}</p> : null}

      {isBuildInProgress ? (
        <article className="detail-panel" style={{ marginBottom: '1rem' }}>
          <div className="page-header" style={{ marginBottom: '0.75rem' }}>
            <div>
              <h3 style={{ margin: 0 }}>Build progress</h3>
              <p className="subtle-copy">Auto-refreshing every 5 seconds while this run is building.</p>
            </div>
            <Pill tone="warning">{displayJobStatus(data.run.jobStatus)}</Pill>
          </div>
          <p className="subtle-copy">
            {generatedGroupCount} of {requestedGroupCount} groups processed · {generatedLineItemCount} review rows · {skippedProductCount} skipped
          </p>
          {currentGroupName ? <p className="subtle-copy">Currently pricing: {currentGroupName}</p> : null}
        </article>
      ) : null}

      <details className="detail-panel" style={{ marginBottom: '1rem' }}>
        <summary style={{ cursor: 'pointer', fontWeight: 600 }}>Run summary</summary>
        <div className="pricing-metric-grid" style={{ marginTop: '1rem' }}>
          <div className="value-panel">
            <span>{isBuildInProgress ? 'Processed groups' : 'Groups'}</span>
            <p>{isBuildInProgress ? `${generatedGroupCount} / ${requestedGroupCount}` : data.totals.groupCount}</p>
          </div>
          <div className="value-panel">
            <span>Proposed changes</span>
            <p>{generatedLineItemCount}</p>
          </div>
          <div className="value-panel">
            <span>Skipped</span>
            <p>{skippedProductCount}</p>
          </div>
          <div className="value-panel">
            <span>{isBuildInProgress ? 'Job status' : 'Review status'}</span>
            <p>{isBuildInProgress ? displayJobStatus(data.run.jobStatus) : compactCountsText(data.totals.pendingLineItemCount, data.totals.approvedLineItemCount, data.totals.rejectedLineItemCount)}</p>
          </div>
        </div>
        {data.run.selectionFilters ? (
          <p className="subtle-copy" style={{ marginTop: '1rem' }}>
            Scope filters: {buildSelectionFilterSummary(data.run.selectionFilters)}
          </p>
        ) : null}
      </details>

      <div className="stacked-list">
        {brandSections.map((brand) => {
          const brandCollapsed = collapsedBrandKeys.has(brand.key)
          const brandPendingCount = countPendingItems(brand.reviewItems)
          const brandApprovedCount = countItemsWithStatus(brand.reviewItems, 'approved')
          const brandRejectedCount = countItemsWithStatus(brand.reviewItems, 'rejected')

          return (
            <article className="detail-panel" key={brand.key}>
              <div className="page-header" style={{ alignItems: 'flex-start', gap: '1rem', marginBottom: brandCollapsed ? 0 : '1rem' }}>
                <div>
                  <h3 style={{ margin: 0 }}>{brand.brandName}</h3>
                  <p className="subtle-copy">{compactCountsText(brandPendingCount, brandApprovedCount, brandRejectedCount)}</p>
                </div>
                <div className="inline-row wrap-row" style={{ justifyContent: 'flex-end' }}>
                  <input
                    inputMode="decimal"
                    onChange={(event) => setBrandDrafts((current) => ({ ...current, [brand.key]: event.currentTarget.value }))}
                    placeholder="Brand price"
                    type="text"
                    value={brandDrafts[brand.key] ?? ''}
                  />
                  <button className="ghost-button" disabled={isSaving} onClick={() => void handleBatchPriceApply(brand.reviewItems, brandDrafts[brand.key] ?? '', `${brand.brandName} brand batch`)} type="button">
                    Apply brand price
                  </button>
                  <button className="ghost-button" disabled={isSaving || brandPendingCount === 0} onClick={() => void handleGroupDecision(brand.reviewItems, 'approve', `${brand.brandName} brand batch`)} type="button">
                    Approve brand
                  </button>
                  <button className="danger-button" disabled={isSaving || brandPendingCount === 0} onClick={() => void handleGroupDecision(brand.reviewItems, 'reject', `${brand.brandName} brand batch`)} type="button">
                    Exclude brand
                  </button>
                  <button className="ghost-button" onClick={() => toggleBrandCollapsed(brand.key)} type="button">
                    {brandCollapsed ? 'Expand brand' : 'Collapse brand'}
                  </button>
                </div>
              </div>

              {brandCollapsed ? null : (
                <div className="stacked-list">
                  {brand.groups.map((group) => {
                    const groupCollapsed = collapsedGroupIds.has(group.proposalRowId)
                    const pendingCount = countPendingItems(group.reviewItems)
                    const approvedCount = countItemsWithStatus(group.reviewItems, 'approved')
                    const rejectedCount = countItemsWithStatus(group.reviewItems, 'rejected')

                    return (
                      <section className="detail-panel" key={group.proposalRowId} style={{ borderStyle: 'solid', borderWidth: '1px', margin: 0 }}>
                        <div className="page-header" style={{ alignItems: 'flex-start', gap: '1rem', marginBottom: groupCollapsed ? 0 : '1rem' }}>
                          <div>
                            <h4 style={{ margin: 0 }}>{group.groupName}</h4>
                            <p className="subtle-copy">
                              {(group.categoryName ?? 'No category')} · {(group.subcategoryName ?? 'No subcategory')} · {compactCountsText(pendingCount, approvedCount, rejectedCount)}
                            </p>
                          </div>
                          <div className="inline-row wrap-row" style={{ justifyContent: 'flex-end' }}>
                            <input
                              inputMode="decimal"
                              onChange={(event) => setGroupDrafts((current) => ({ ...current, [group.proposalRowId]: event.currentTarget.value }))}
                              placeholder="Group price"
                              type="text"
                              value={groupDrafts[group.proposalRowId] ?? ''}
                            />
                            <button className="ghost-button" disabled={isSaving} onClick={() => void handleBatchPriceApply(group.reviewItems, groupDrafts[group.proposalRowId] ?? '', group.groupName)} type="button">
                              Apply group price
                            </button>
                            <button className="ghost-button" disabled={isSaving || pendingCount === 0} onClick={() => void handleGroupDecision(group.reviewItems, 'approve', group.groupName)} type="button">
                              Approve group
                            </button>
                            <button className="danger-button" disabled={isSaving || pendingCount === 0} onClick={() => void handleGroupDecision(group.reviewItems, 'reject', group.groupName)} type="button">
                              Exclude group
                            </button>
                            <Link className="ghost-button like-button" to={buildHeliosModulePath('catalog', `groups/${group.catalogGroupId}`)}>
                              Catalog debug page
                            </Link>
                            <button className="ghost-button" onClick={() => toggleGroupCollapsed(group.proposalRowId)} type="button">
                              {groupCollapsed ? 'Expand group' : 'Collapse group'}
                            </button>
                          </div>
                        </div>

                        {groupCollapsed ? null : (
                          <>
                            {group.marketAvailability || group.marketNote ? (
                              <p className="subtle-copy" style={{ marginBottom: '1rem' }}>
                                {group.marketAvailability ?? 'market'}{group.marketNote ? ` · ${group.marketNote}` : ''}
                              </p>
                            ) : null}

                            <div className="stacked-list">
                              {group.reviewItems.map((item) => {
                                const draftValue = draftValues[item.lineItem.lineItemId] ?? readEditableInputValue(item)
                                const draftNote = draftNotes[item.lineItem.lineItemId] ?? item.lineItem.notes ?? ''
                                const reviewedPrice = resolveDisplayedPrice(draftValue, item)
                                const priceMarkerLabel = hasDraftPriceOverride(draftValue, item) ? 'Draft' : 'Reviewed'
                                const recentSalesIndicator = describeRecentSales(item.pricingContext.recentSales.summary)
                                return (
                                  <article className="detail-panel" key={item.lineItem.lineItemId} style={{ margin: 0 }}>
                                    <div className="page-header" style={{ alignItems: 'flex-start', gap: '1rem', marginBottom: '0.85rem' }}>
                                      <div>
                                        <h5 style={{ margin: 0 }}>{productLabel(item)}</h5>
                                        <p className="subtle-copy">{pricingTransitionText(item, reviewedPrice)}</p>
                                      </div>
                                      <div className="inline-row wrap-row">
                                        <span className={`velocity-indicator velocity-indicator-${recentSalesIndicator.tone}`}>{recentSalesIndicator.detailLabel}</span>
                                        <Pill tone={approvalTone(item.lineItem.approvalStatus)}>{reviewDecisionLabel(item.lineItem.approvalStatus)}</Pill>
                                        <span className="subtle-copy">Cost {formatMoney(item.pricingContext.wholesaleCost)} · {item.pricingContext.tab ?? item.lineItem.fieldPath}</span>
                                      </div>
                                    </div>

                                    <PricingLadder
                                      livePrice={numericValue(item.lineItem.baselineValue)}
                                      marketAverageLabel={item.pricingContext.marketAverageLabel}
                                      marketAveragePostTaxPrice={item.pricingContext.marketAveragePostTaxPrice}
                                      marketMedianPostTaxPrice={item.pricingContext.marketMedianPostTaxPrice}
                                      marketListings={item.pricingContext.marketListings}
                                      proposedLabel={priceMarkerLabel}
                                      proposedPrice={reviewedPrice}
                                    />

                                    {formatMarketReferenceText(
                                      item.pricingContext.marketAveragePostTaxPrice,
                                      item.pricingContext.marketMedianPostTaxPrice,
                                    ) ? (
                                      <p className="subtle-copy" style={{ marginTop: '0.35rem', marginBottom: '0.85rem' }}>
                                        {formatMarketReferenceText(
                                          item.pricingContext.marketAveragePostTaxPrice,
                                          item.pricingContext.marketMedianPostTaxPrice,
                                        )}
                                      </p>
                                    ) : null}

                                    <p className="subtle-copy" style={{ marginTop: 0, marginBottom: '0.85rem' }}>
                                      {item.pricingContext.priceReason ?? 'No structured pricing reason recorded for this row.'}
                                    </p>

                                    <div className="inline-row wrap-row" style={{ alignItems: 'center', marginBottom: '0.75rem' }}>
                                      <input
                                        inputMode="decimal"
                                        onChange={(event) => setDraftValues((current) => ({ ...current, [item.lineItem.lineItemId]: event.currentTarget.value }))}
                                        type="text"
                                        value={draftValue}
                                      />
                                      <button className="ghost-button" disabled={isSaving} onClick={() => adjustDraftValue(item, -0.25)} type="button">-0.25</button>
                                      <button className="ghost-button" disabled={isSaving} onClick={() => adjustDraftValue(item, 0.25)} type="button">+0.25</button>
                                      <button className="ghost-button" disabled={isSaving} onClick={() => void handleSaveEdit(item)} type="button">Save price</button>
                                      <button className="primary-button" disabled={isSaving || item.lineItem.approvalStatus !== 'pending'} onClick={() => void handleDecision(item, 'approve')} type="button">Approve</button>
                                      <button className="danger-button" disabled={isSaving || item.lineItem.approvalStatus !== 'pending'} onClick={() => void handleDecision(item, 'reject')} type="button">Exclude</button>
                                    </div>

                                    <label className="stack-field">
                                      <span>Review note</span>
                                      <textarea onChange={(event) => setDraftNotes((current) => ({ ...current, [item.lineItem.lineItemId]: event.currentTarget.value }))} rows={3} value={draftNote} />
                                    </label>

                                    <div className="inline-row wrap-row" style={{ marginTop: '0.75rem' }}>
                                      <button className="ghost-button" disabled={isSaving} onClick={() => void handleSaveNote(item)} type="button">Save note</button>
                                      {item.pricingContext.marketListings.length > 0 ? <span className="subtle-copy">{summarizeListingBands(item.pricingContext.marketListings)}</span> : null}
                                    </div>

                                    <div style={{ marginTop: '0.9rem' }}>
                                      <div className="sales-site-grid">
                                        {item.pricingContext.recentSales.sites.map((site) => {
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
                                  </article>
                                )
                              })}
                            </div>

                            {group.skippedProducts.length > 0 ? (
                              <details style={{ marginTop: '1rem' }}>
                                <summary>Skipped products ({group.skippedProducts.length})</summary>
                                <ul className="timeline-list" style={{ marginTop: '0.75rem' }}>
                                  {group.skippedProducts.map((product) => (
                                    <li key={product.productId}>
                                      <strong>{product.productName}</strong>
                                      <div className="subtle-copy">
                                        {product.tab} · live {formatMoney(product.currentPrice)} · cost {formatMoney(product.wholesaleCost)}
                                      </div>
                                      <p className="subtle-copy">{product.reason}</p>
                                    </li>
                                  ))}
                                </ul>
                              </details>
                            ) : null}
                          </>
                        )}
                      </section>
                    )
                  })}
                </div>
              )}
            </article>
          )
        })}
      </div>
    </section>
  )
}

function countPendingItems(items: PricingReviewItem[]): number {
  return countItemsWithStatus(items, 'pending')
}

function countItemsWithStatus(items: PricingReviewItem[], status: PricingReviewItem['lineItem']['approvalStatus']): number {
  return items.filter((item) => item.lineItem.approvalStatus === status).length
}

function compactCountsText(pendingCount: number, approvedCount: number, rejectedCount: number): string {
  return `${pendingCount} pending · ${approvedCount} approved · ${rejectedCount} excluded`
}

function buildSelectionFilterSummary(selectionFilters: PricingRunDetailResponse['run']['selectionFilters']): string {
  if (!selectionFilters) {
    return 'No saved scope filters.'
  }

  const parts: string[] = []
  if (selectionFilters.brands.length > 0) {
    parts.push(`Brands: ${selectionFilters.brands.join(', ')}`)
  }
  if (selectionFilters.categories.length > 0) {
    parts.push(`Categories: ${selectionFilters.categories.join(', ')}`)
  }
  if (selectionFilters.subcategories.length > 0) {
    parts.push(`Subcategories: ${selectionFilters.subcategories.join(', ')}`)
  }
  if (selectionFilters.search) {
    parts.push(`Search: ${selectionFilters.search}`)
  }
  const siteLabels = selectionFilters.sites
    .map((siteKey) => (siteKey === 'bronx' ? 'Bronx' : siteKey === 'midtown' ? 'Midtown' : siteKey))
  if (siteLabels.length > 0) {
    parts.push(`Sites: ${siteLabels.join(' + ')}`)
  }
  if (selectionFilters.stockOnly) parts.push('In stock')
  if (selectionFilters.includePending) parts.push('Pending purchases')
  if (selectionFilters.strict) parts.push('Strict')

  return parts.length > 0 ? parts.join(' · ') : 'No saved scope filters.'
}

function pricingTransitionText(item: PricingReviewItem, reviewedPrice: number | null): string {
  const livePrice = formatMoney(numericValue(item.lineItem.baselineValue))
  return `${livePrice} (${formatPercent(item.pricingContext.currentGmPercent)}) -> ${formatMoney(reviewedPrice)} (${formatPercent(item.pricingContext.proposedGmPercent)})`
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

function formatPercent(value: number | null): string {
  return value === null ? '—' : `${value.toFixed(2)}%`
}

function roundCurrency(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100
}

function numericValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function numericValueFromString(value: string): number | null {
  const parsed = Number(value.trim())
  return Number.isFinite(parsed) ? parsed : null
}

function resolveDisplayedPrice(draftValue: string, item: PricingReviewItem): number | null {
  return numericValueFromString(draftValue) ?? item.pricingContext.proposedPrice ?? numericValue(item.lineItem.effectiveValue)
}

function hasDraftPriceOverride(draftValue: string, item: PricingReviewItem): boolean {
  const draftedPrice = numericValueFromString(draftValue)
  if (draftedPrice === null) {
    return false
  }

  const persistedPrice = item.pricingContext.proposedPrice ?? numericValue(item.lineItem.effectiveValue)
  if (persistedPrice === null) {
    return true
  }

  return Math.abs(draftedPrice - persistedPrice) >= 0.005
}

function readEditableInputValue(item: PricingReviewItem): string {
  if (typeof item.lineItem.editedValue === 'number') {
    return item.lineItem.editedValue.toFixed(2)
  }
  if (typeof item.lineItem.effectiveValue === 'number') {
    return item.lineItem.effectiveValue.toFixed(2)
  }
  if (typeof item.lineItem.suggestedValue === 'number') {
    return item.lineItem.suggestedValue.toFixed(2)
  }
  return ''
}

function productLabel(item: PricingReviewItem): string {
  return item.pricingContext.productName ?? `Product #${item.lineItem.targetEntityId}`
}

function displayRunStatus(status: PricingRunDetailResponse['run']['status']): string {
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

function displayJobStatus(status: PricingRunDetailResponse['run']['jobStatus']): string {
  switch (status) {
    case 'queued':
      return 'Queued'
    case 'running':
      return 'Running'
    case 'succeeded':
      return 'Completed'
    case 'failed':
      return 'Failed'
    case 'dead_letter':
      return 'Stopped after retries'
    default:
      return 'Starting'
  }
}

function readStringField(value: PricingRunDetailResponse['run']['rawSummary'], key: string): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }

  const candidate = (value as Record<string, unknown>)[key]
  return typeof candidate === 'string' && candidate.trim().length > 0 ? candidate : null
}

function toggleSetValue<T>(current: Set<T>, value: T): Set<T> {
  const next = new Set(current)
  if (next.has(value)) {
    next.delete(value)
  } else {
    next.add(value)
  }
  return next
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

function PricingLadder(input: {
  livePrice: number | null
  marketAverageLabel: string | null
  marketAveragePostTaxPrice: number | null
  marketMedianPostTaxPrice: number | null
  marketListings: PricingRunMarketListing[]
  proposedLabel: string
  proposedPrice: number | null
}) {
  const points = [
    input.livePrice,
    input.proposedPrice,
    input.marketAveragePostTaxPrice,
    input.marketMedianPostTaxPrice,
    ...input.marketListings.map((listing) => listing.postTaxPrice),
  ]
    .filter((value): value is number => value !== null && Number.isFinite(value))

  if (points.length === 0) {
    return null
  }

  const minimumPoint = Math.min(...points)
  const maximumPoint = Math.max(...points)
  const padding = Math.max((maximumPoint - minimumPoint) * 0.12, 1)
  const scaleMinimum = Math.max(0, minimumPoint - padding)
  const scaleMaximum = maximumPoint + padding

  return (
    <div className="pricing-ladder-card">
      <div className="inline-row wrap-row" style={{ justifyContent: 'space-between', marginBottom: '0.6rem' }}>
        <strong>Price ladder</strong>
        <span className="subtle-copy">{formatMoney(scaleMinimum)} to {formatMoney(scaleMaximum)}</span>
      </div>
      <div className="pricing-ladder-track">
        {input.marketListings.map((listing, index) => (
          <span
            className={`pricing-ladder-dot band-${listing.distanceBand}${listing.eligibleForPricing ? '' : ' is-excluded'}`}
            key={`${listing.dispensaryName}-${listing.listingName}-${index}`}
            style={{ left: `${toLadderPercent(listing.postTaxPrice, scaleMinimum, scaleMaximum)}%`, opacity: listingOpacity(listing) }}
            title={buildListingTooltip(listing)}
          />
        ))}
        {input.marketAveragePostTaxPrice !== null ? (
          <span className="pricing-ladder-marker average" style={{ left: `${toLadderPercent(input.marketAveragePostTaxPrice, scaleMinimum, scaleMaximum)}%` }}>
            <span>Near/mid avg</span>
          </span>
        ) : null}
        {input.marketMedianPostTaxPrice !== null ? (
          <span className="pricing-ladder-marker median" style={{ left: `${toLadderPercent(input.marketMedianPostTaxPrice, scaleMinimum, scaleMaximum)}%` }}>
            <span>Near/mid median</span>
          </span>
        ) : null}
        {input.livePrice !== null ? (
          <span className="pricing-ladder-marker live" style={{ left: `${toLadderPercent(input.livePrice, scaleMinimum, scaleMaximum)}%` }}>
            <span>Live</span>
          </span>
        ) : null}
        {input.proposedPrice !== null ? (
          <span className="pricing-ladder-marker proposed" style={{ left: `${toLadderPercent(input.proposedPrice, scaleMinimum, scaleMaximum)}%` }}>
            <span>{input.proposedLabel}</span>
          </span>
        ) : null}
      </div>
      <div className="pricing-ladder-legend">
        <span><i className="legend-swatch band-near" />Near</span>
        <span><i className="legend-swatch band-mid" />Mid</span>
        <span><i className="legend-swatch band-far" />Far</span>
        <span><i className="legend-swatch band-very_far" />Very far</span>
        <span><i className="legend-swatch marker-median" />Near/mid median</span>
        <span><i className="legend-swatch marker-live" />Live</span>
        <span><i className="legend-swatch marker-proposed" />Reviewed</span>
      </div>
      {input.marketAverageLabel ? <p className="subtle-copy" style={{ marginTop: '0.6rem' }}>{input.marketAverageLabel}</p> : null}
    </div>
  )
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

function toLadderPercent(value: number, minimum: number, maximum: number): number {
  if (maximum <= minimum) {
    return 50
  }
  return ((value - minimum) / (maximum - minimum)) * 100
}

function listingOpacity(listing: PricingRunMarketListing): number {
  const baseOpacity = (() => {
    switch (listing.distanceBand) {
      case 'near':
        return 1
      case 'mid':
        return 0.76
      case 'far':
        return 0.42
      case 'very_far': {
        if (listing.distanceMiles === null) {
          return 0.32
        }
        return Math.max(0.18, 0.42 - Math.max(0, listing.distanceMiles - 10) * 0.01)
      }
      default:
        return 0.28
    }
  })()

  return listing.eligibleForPricing ? baseOpacity : Math.max(0.12, baseOpacity * 0.35)
}

function buildListingTooltip(listing: PricingRunMarketListing): string {
  return [
    listing.dispensaryName,
    formatMoney(listing.postTaxPrice),
    formatDistanceBandLabel(listing.distanceBand, listing.distanceMiles),
    `${formatMatchTierLabel(listing.matchTier)} match`,
    listing.eligibleForPricing ? 'Included in pricing comps' : listing.exclusionReason ?? 'Display only',
  ].join(' · ')
}

function formatMatchTierLabel(matchTier: PricingRunMarketListing['matchTier']): string {
  switch (matchTier) {
    case 'exact':
      return 'Exact'
    case 'fallback':
      return 'Fallback'
    default:
      return 'Weak'
  }
}

function summarizeListingBands(listings: PricingRunMarketListing[]): string {
  const eligibleCount = listings.filter((listing) => listing.eligibleForPricing).length
  const excludedCount = listings.length - eligibleCount
  const summary = listings.reduce<Record<PricingRunMarketListing['distanceBand'], number>>(
    (counts, listing) => ({
      ...counts,
      [listing.distanceBand]: counts[listing.distanceBand] + 1,
    }),
    { far: 0, mid: 0, near: 0, unknown: 0, very_far: 0 },
  )
  const parts = [
    summary.near ? `${summary.near} near` : null,
    summary.mid ? `${summary.mid} mid` : null,
    summary.far ? `${summary.far} far` : null,
    summary.very_far ? `${summary.very_far} very far` : null,
    summary.unknown ? `${summary.unknown} unknown-distance` : null,
  ].filter((value): value is string => value !== null)

  const coverageText = parts.length > 0 ? parts.join(', ') : 'no retained listings'
  if (excludedCount > 0) {
    return `${eligibleCount} pricing comp${eligibleCount === 1 ? '' : 's'} retained; ${excludedCount} weaker or distance-only listing${excludedCount === 1 ? '' : 's'} shown faded (${coverageText}).`
  }

  return `All ${eligibleCount} retained listing${eligibleCount === 1 ? '' : 's'} are pricing-eligible (${coverageText}).`
}
