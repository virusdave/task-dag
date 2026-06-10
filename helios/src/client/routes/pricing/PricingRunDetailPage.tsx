import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useLoaderData, useRevalidator } from 'react-router-dom'

import {
  MutationAcceptedResponseSchema,
  PricingRunDetailResponseSchema,
  buildHeliosModulePath,
  type PricingReviewItem,
  type PricingRunDetailResponse,
  type PricingRunGroupSummary,
  type PricingRunMarketListing,
} from '../../../shared/contracts/index.js'
import { calculateGmPercent } from '../../../shared/domain/pricingGeneration.js'
import { loadJson, mutateJson } from '../../app/fetchJson.js'
import { waitForJob } from '../../app/jobPolling.js'
import type { CompetitorListing } from '../../../shared/ui/pricing-ladder/index.js'
import { CanonicalPricingLadder } from '../../components/CanonicalPricingLadder.js'
import { CanonicalProductRow } from '../../components/canonicalProductRow/index.js'
import { Pill } from '../../components/Pill.js'
import { useRegisterCatalogSidebarSubtree } from '../catalog/catalogSidebarSubtree.js'
import { describeRecentSales, formatCount, formatCurrency } from '../catalog/recentSales.js'
import { PricingNav } from './PricingNav.js'

export async function pricingRunDetailLoader({ params }: { params: Record<string, string | undefined> }) {
  return loadJson(`/api/pricing/runs/${params.proposalBatchId}`, PricingRunDetailResponseSchema)
}

/**
 * Handlers a section/row needs to mutate the server. They are created once
 * (stable identities via `useCallback`) in the page component so the memoized
 * section/row subtrees below never re-render just because the operator typed a
 * character somewhere else on the page. Draft text, collapse state, and the
 * per-section "saving" lock all live INSIDE the leaf components now, so a
 * keystroke only re-renders the one input the operator is touching.
 */
interface SectionHandlers {
  onBatchPriceApply: (items: PricingReviewItem[], draftValue: string, label: string) => Promise<boolean>
  onDecision: (item: PricingReviewItem, decision: 'approve' | 'reject') => Promise<void>
  onGroupDecision: (items: PricingReviewItem[], decision: 'approve' | 'reject', label: string) => Promise<void>
  onSaveEdit: (item: PricingReviewItem, draftValue: string) => Promise<boolean>
  onSaveNote: (item: PricingReviewItem, draftNote: string) => Promise<boolean>
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
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [feedbackMessage, setFeedbackMessage] = useState<string | null>(null)

  const categorySections = useMemo(() => {
    return buildPricingReviewHierarchy(data.groups)
  }, [data.groups])

  // Keep a stable reference to `revalidate` so the mutation handlers below can
  // be created with empty dependency arrays. `useRevalidator()` returns a new
  // object whenever its state flips (idle ↔ loading), and we don't want that
  // churn to bust the stable handler identities the memoized subtree relies on.
  const revalidateRef = useRef(revalidator.revalidate)
  revalidateRef.current = revalidator.revalidate

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

  const handleSaveEdit = useCallback(async (item: PricingReviewItem, draftValue: string): Promise<boolean> => {
    setErrorMessage(null)
    setFeedbackMessage(null)
    try {
      if (draftValue.trim().length === 0) {
        throw new Error('Enter a price before saving.')
      }
      const editedValue = Number(draftValue.trim())
      if (!Number.isFinite(editedValue)) {
        throw new Error('Price edits must be numeric when you save them.')
      }

      await mutateJson(`/api/proposal-line-items/${item.lineItem.lineItemId}/edit`, MutationAcceptedResponseSchema, {
        body: JSON.stringify({ editedValue: roundCurrency(editedValue), expectedVersion: item.lineItem.version }),
        method: 'PATCH',
      })
      await revalidateRef.current()
      setFeedbackMessage(`Saved ${productLabel(item)} at ${formatMoney(roundCurrency(editedValue))}.`)
      return true
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Could not save the pricing edit.')
      return false
    }
  }, [])

  const handleSaveNote = useCallback(async (item: PricingReviewItem, draftNote: string): Promise<boolean> => {
    setErrorMessage(null)
    setFeedbackMessage(null)
    try {
      await mutateJson(`/api/proposal-line-items/${item.lineItem.lineItemId}/note`, MutationAcceptedResponseSchema, {
        body: JSON.stringify({ note: draftNote.trim() || null }),
        method: 'PATCH',
      })
      await revalidateRef.current()
      setFeedbackMessage(`Saved note for ${productLabel(item)}.`)
      return true
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Could not save the note.')
      return false
    }
  }, [])

  // Watch the background reconcile/Sweed-sync job(s) a decision enqueues
  // WITHOUT blocking the UI. The approval/exclusion itself is already
  // committed server-side once the POST returns, so we revalidate + free
  // the buttons first, then poll the job here with a bound. A failed sync
  // (e.g. Sweed rejecting the product edit) is surfaced as a non-blocking
  // error instead of silently doing nothing or freezing the page forever.
  const watchReconcileJobs = useCallback(async (jobIds: number[], context: string) => {
    if (jobIds.length === 0) {
      return
    }
    const failures: string[] = []
    for (const jobId of jobIds) {
      try {
        const status = await waitForJob(jobId, { timeoutMs: 120_000 })
        if (status.job.status !== 'succeeded') {
          failures.push(`job #${jobId} ${status.job.status}: ${status.job.lastError ?? 'no detail provided'}`)
        }
      } catch (error) {
        failures.push(error instanceof Error ? error.message : `job #${jobId} status unknown`)
      }
    }
    if (failures.length > 0) {
      setErrorMessage(`${context} recorded in Helios, but the Sweed sync did not complete: ${failures[0]}${failures.length > 1 ? ` (+${failures.length - 1} more)` : ''}`)
    } else {
      await revalidateRef.current()
    }
  }, [])

  const handleDecision = useCallback(async (item: PricingReviewItem, decision: 'approve' | 'reject'): Promise<void> => {
    setErrorMessage(null)
    setFeedbackMessage(null)
    let jobId: number | null = null
    try {
      const response = await mutateJson(`/api/proposal-line-items/${item.lineItem.lineItemId}/${decision}`, MutationAcceptedResponseSchema, {
        body: JSON.stringify({ expectedVersion: item.lineItem.version }),
        method: 'POST',
      })
      jobId = response.jobId ?? null
      await revalidateRef.current()
      setFeedbackMessage(`${decision === 'approve' ? 'Approved' : 'Excluded'} ${productLabel(item)}.`)
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : `Could not ${decision === 'approve' ? 'approve' : 'exclude'} this pricing row.`)
      return
    }
    // Don't block the page (or the row's buttons) on the Sweed sync; watch the
    // job in the background and surface any sync failure non-blockingly.
    void watchReconcileJobs(jobId === null ? [] : [jobId], `${decision === 'approve' ? 'Approval of' : 'Exclusion of'} ${productLabel(item)}`)
  }, [watchReconcileJobs])

  const handleBatchPriceApply = useCallback(async (items: PricingReviewItem[], draftValue: string, label: string): Promise<boolean> => {
    const editableItems = items.filter((item) => item.lineItem.approvalStatus === 'pending')
    if (editableItems.length === 0) {
      setErrorMessage(`${label} has no pending pricing rows left to update.`)
      return false
    }

    if (draftValue.trim().length === 0) {
      setErrorMessage(`${label} needs a price before you apply it.`)
      return false
    }
    const editedValue = Number(draftValue.trim())
    if (!Number.isFinite(editedValue)) {
      setErrorMessage(`${label} needs a numeric price before you apply it.`)
      return false
    }

    setErrorMessage(null)
    setFeedbackMessage(null)
    try {
      const normalizedPrice = roundCurrency(editedValue)
      const failures: string[] = []
      let successCount = 0
      for (const item of editableItems) {
        try {
          await mutateJson(`/api/proposal-line-items/${item.lineItem.lineItemId}/edit`, MutationAcceptedResponseSchema, {
            body: JSON.stringify({ editedValue: normalizedPrice, expectedVersion: item.lineItem.version }),
            method: 'PATCH',
          })
          successCount += 1
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Unknown error'
          console.warn('[pricing] family price edit failed', {
            lineItemId: item.lineItem.lineItemId,
            productId: item.lineItem.targetEntityId,
            message,
          })
          failures.push(`${productLabel(item)}: ${message}`)
        }
      }
      await revalidateRef.current()
      setFeedbackMessage(`Saved ${formatMoney(normalizedPrice)} across ${successCount}/${editableItems.length} pending row${editableItems.length === 1 ? '' : 's'} in ${label}.`)
      if (failures.length > 0) {
        setErrorMessage(`Failed ${failures.length} row${failures.length === 1 ? '' : 's'}; page state was refreshed. First failure: ${failures[0]}`)
      }
      return failures.length === 0
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : `Could not apply the batch price for ${label}.`)
      return false
    }
  }, [])

  const handleGroupDecision = useCallback(async (items: PricingReviewItem[], decision: 'approve' | 'reject', label: string): Promise<void> => {
    const pendingItems = items.filter((item) => item.lineItem.approvalStatus === 'pending')
    if (pendingItems.length === 0) {
      setErrorMessage(`${label} has no pending pricing rows left.`)
      return
    }

    setErrorMessage(null)
    setFeedbackMessage(null)
    const jobIds: number[] = []
    try {
      const failures: string[] = []
      let successCount = 0
      for (const item of pendingItems) {
        try {
          const response = await mutateJson(`/api/proposal-line-items/${item.lineItem.lineItemId}/${decision}`, MutationAcceptedResponseSchema, {
            body: JSON.stringify({ expectedVersion: item.lineItem.version }),
            method: 'POST',
          })
          successCount += 1
          if (response.jobId) {
            jobIds.push(response.jobId)
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Unknown error'
          console.warn('[pricing] family decision failed', {
            decision,
            lineItemId: item.lineItem.lineItemId,
            productId: item.lineItem.targetEntityId,
            message,
          })
          failures.push(`${productLabel(item)}: ${message}`)
        }
      }
      await revalidateRef.current()
      setFeedbackMessage(`${decision === 'approve' ? 'Approved' : 'Excluded'} ${successCount}/${pendingItems.length} pending row${pendingItems.length === 1 ? '' : 's'} in ${label}.`)
      if (failures.length > 0) {
        setErrorMessage(`Failed ${failures.length} row${failures.length === 1 ? '' : 's'}; page state was refreshed. First failure: ${failures[0]}`)
      }
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : `Could not update the pending rows in ${label}.`)
      return
    }
    // Don't block the page on Sweed sync; watch the jobs in the
    // background and surface any sync failure non-blockingly.
    void watchReconcileJobs(jobIds, `${decision === 'approve' ? 'Approval' : 'Exclusion'} of ${label}`)
  }, [watchReconcileJobs])

  const sectionHandlers = useMemo<SectionHandlers>(() => ({
    onBatchPriceApply: handleBatchPriceApply,
    onDecision: handleDecision,
    onGroupDecision: handleGroupDecision,
    onSaveEdit: handleSaveEdit,
    onSaveNote: handleSaveNote,
  }), [handleBatchPriceApply, handleDecision, handleGroupDecision, handleSaveEdit, handleSaveNote])

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
        {categorySections.map((category) => (
          <CategorySectionView key={category.key} category={category} handlers={sectionHandlers} />
        ))}
      </div>
    </section>
  )
}

/**
 * Category → subcategory → tab levels are pure display (a heading + rollup
 * counts). They're memoized on the stable hierarchy slice + stable handler
 * bundle so that a save-triggered page re-render (which only flips the
 * error/feedback banners) doesn't reconcile the whole tree underneath. The
 * heavy interactive subtree (`BrandFamilySectionView` and below) bails out of
 * re-rendering unless its own slice of `data.groups` actually changed.
 */
const CategorySectionView = memo(function CategorySectionView({
  category,
  handlers,
}: {
  category: CategorySection
  handlers: SectionHandlers
}): JSX.Element {
  return (
    <article className="detail-panel">
      <div className="page-header" style={{ alignItems: 'flex-start', gap: '1rem', marginBottom: '1rem' }}>
        <div>
          <h3 style={{ margin: 0 }}>{category.categoryName}</h3>
          <p className="subtle-copy">{compactCountsText(category.pendingCount, category.approvedCount, category.rejectedCount)}</p>
        </div>
      </div>

      <div className="stacked-list">
        {category.subcategories.map((subcategory) => (
          <section className="detail-panel" key={subcategory.key} style={{ borderStyle: 'solid', borderWidth: '1px', margin: 0 }}>
            <h4 style={{ margin: '0 0 0.35rem' }}>{subcategory.subcategoryName}</h4>
            <p className="subtle-copy" style={{ marginTop: 0 }}>{compactCountsText(subcategory.pendingCount, subcategory.approvedCount, subcategory.rejectedCount)}</p>

            <div className="stacked-list">
              {subcategory.tabs.map((tabSection) => (
                <section className="detail-panel" key={tabSection.key} style={{ borderStyle: 'solid', borderWidth: '1px', margin: 0 }}>
                  <h5 style={{ margin: '0 0 0.35rem' }}>{tabSection.tab}</h5>
                  <p className="subtle-copy" style={{ marginTop: 0 }}>{compactCountsText(tabSection.pendingCount, tabSection.approvedCount, tabSection.rejectedCount)}</p>

                  <div className="stacked-list">
                    {tabSection.brands.map((brand) => (
                      <BrandFamilySectionView key={brand.key} brand={brand} handlers={handlers} />
                    ))}
                  </div>
                </section>
              ))}
            </div>
          </section>
        ))}
      </div>
    </article>
  )
})

/**
 * One brand/family leaf: the "Family price" batch input, family-wide
 * approve/exclude, and the collapse toggle. Owns its own draft text, collapse
 * state, and saving lock so typing a family price only re-renders this header,
 * not every sibling family or the line-item cards underneath.
 */
const BrandFamilySectionView = memo(function BrandFamilySectionView({
  brand,
  handlers,
}: {
  brand: BrandFamilySection
  handlers: SectionHandlers
}): JSX.Element {
  const pendingCount = countPendingItems(brand.reviewItems)
  const approvedCount = countItemsWithStatus(brand.reviewItems, 'approved')
  const rejectedCount = countItemsWithStatus(brand.reviewItems, 'rejected')
  const leafLabel = `${brand.categoryName} · ${brand.subcategoryName} · ${brand.tab} · ${brand.brandName}`

  const [collapsed, setCollapsed] = useState(() => pendingCount === 0)
  const [draft, setDraft] = useState('')
  const [isSaving, setIsSaving] = useState(false)

  // Auto-collapse a family once it has no pending rows left, but never fight a
  // manual expand: this only fires when `pendingCount` itself changes.
  useEffect(() => {
    if (pendingCount === 0) {
      setCollapsed(true)
    }
  }, [pendingCount])

  async function applyFamilyPrice() {
    setIsSaving(true)
    try {
      await handlers.onBatchPriceApply(brand.reviewItems, draft, leafLabel)
    } finally {
      setIsSaving(false)
    }
  }

  async function decideFamily(decision: 'approve' | 'reject') {
    setIsSaving(true)
    try {
      await handlers.onGroupDecision(brand.reviewItems, decision, leafLabel)
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <article className="detail-panel" style={{ borderStyle: 'solid', borderWidth: '1px', margin: 0 }}>
      <div className="page-header" style={{ alignItems: 'flex-start', gap: '1rem', marginBottom: collapsed ? 0 : '1rem' }}>
        <div>
          <h5 style={{ margin: 0 }}>{brand.brandName}</h5>
          <p className="subtle-copy">{compactCountsText(pendingCount, approvedCount, rejectedCount)} · {marketSummaryForItems(brand.reviewItems)}</p>
        </div>
        <div className="inline-row wrap-row" style={{ justifyContent: 'flex-end' }}>
          <input
            inputMode="decimal"
            onChange={(event) => setDraft(event.currentTarget.value)}
            placeholder="Family price"
            type="text"
            value={draft}
          />
          <button className="ghost-button" disabled={isSaving} onClick={() => void applyFamilyPrice()} type="button">
            Apply family price
          </button>
          <button className="ghost-button" disabled={isSaving || pendingCount === 0} onClick={() => void decideFamily('approve')} type="button">
            Approve family
          </button>
          <button className="danger-button" disabled={isSaving || pendingCount === 0} onClick={() => void decideFamily('reject')} type="button">
            Exclude family
          </button>
          <button className="ghost-button" onClick={() => setCollapsed((value) => !value)} type="button">
            {collapsed ? 'Expand family' : 'Collapse family'}
          </button>
        </div>
      </div>

      {collapsed ? null : (
        <div className="stacked-list">
          {brand.groups.map((group) => (
            <GroupSectionView key={group.key} group={group} handlers={handlers} />
          ))}
        </div>
      )}
    </article>
  )
})

/**
 * One pricing group within a family: the "Group price" batch input,
 * group-wide approve/exclude, the catalog link, and the collapse toggle. Owns
 * its own draft/collapse/saving state for the same isolation reason as the
 * family level above.
 */
const GroupSectionView = memo(function GroupSectionView({
  group,
  handlers,
}: {
  group: PricingReviewGroupSlice
  handlers: SectionHandlers
}): JSX.Element {
  const pendingCount = countPendingItems(group.reviewItems)
  const approvedCount = countItemsWithStatus(group.reviewItems, 'approved')
  const rejectedCount = countItemsWithStatus(group.reviewItems, 'rejected')

  // Groups start collapsed. A single run can carry dozens of groups, each
  // with item rows + market-evidence ladders; rendering them all up front is
  // what makes the page crawl (see issue/perf notes). The operator expands
  // only the group they're working on, and the per-group counts in the header
  // tell them where pending work lives without expanding anything.
  const [collapsed, setCollapsed] = useState(true)
  const [draft, setDraft] = useState('')
  const [isSaving, setIsSaving] = useState(false)

  useEffect(() => {
    if (pendingCount === 0) {
      setCollapsed(true)
    }
  }, [pendingCount])

  async function applyGroupPrice() {
    setIsSaving(true)
    try {
      await handlers.onBatchPriceApply(group.reviewItems, draft, group.groupName)
    } finally {
      setIsSaving(false)
    }
  }

  async function decideGroup(decision: 'approve' | 'reject') {
    setIsSaving(true)
    try {
      await handlers.onGroupDecision(group.reviewItems, decision, group.groupName)
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <section className="detail-panel" style={{ borderStyle: 'solid', borderWidth: '1px', margin: 0 }}>
      <div className="page-header" style={{ alignItems: 'flex-start', gap: '1rem', marginBottom: collapsed ? 0 : '1rem' }}>
        <div>
          <h4 style={{ margin: 0 }}>{group.groupName}</h4>
          <p className="subtle-copy">
            {(group.categoryName ?? 'No category')} · {(group.subcategoryName ?? 'No subcategory')} · {compactCountsText(pendingCount, approvedCount, rejectedCount)}
          </p>
        </div>
        <div className="inline-row wrap-row" style={{ justifyContent: 'flex-end' }}>
          <input
            inputMode="decimal"
            onChange={(event) => setDraft(event.currentTarget.value)}
            placeholder="Group price"
            type="text"
            value={draft}
          />
          <button className="ghost-button" disabled={isSaving} onClick={() => void applyGroupPrice()} type="button">
            Apply group price
          </button>
          <button className="ghost-button" disabled={isSaving || pendingCount === 0} onClick={() => void decideGroup('approve')} type="button">
            Approve group
          </button>
          <button className="danger-button" disabled={isSaving || pendingCount === 0} onClick={() => void decideGroup('reject')} type="button">
            Exclude group
          </button>
          <Link className="ghost-button like-button" rel="noreferrer" target="_blank" to={buildHeliosModulePath('catalog', `groups/${group.catalogGroupId}`)}>
            Open catalog
          </Link>
          <button className="ghost-button" onClick={() => setCollapsed((value) => !value)} type="button">
            {collapsed ? 'Expand group' : 'Collapse group'}
          </button>
        </div>
      </div>

      {collapsed ? null : (
        <>
          {group.marketAvailability || group.marketNote ? (
            <p className="subtle-copy" style={{ marginBottom: '1rem' }}>
              {group.marketAvailability ?? 'market'}{group.marketNote ? ` · ${group.marketNote}` : ''}
            </p>
          ) : null}

          <div className="stacked-list">
            {group.reviewItems.map((item) => (
              <PricingRunItemRow
                item={item}
                key={item.lineItem.lineItemId}
                onDecision={handlers.onDecision}
                onSaveEdit={handlers.onSaveEdit}
                onSaveNote={handlers.onSaveNote}
              />
            ))}
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
                      {product.wholesaleCostSource === 'package_snapshot' ? (
                        <span
                          style={{ marginLeft: '0.35rem', fontStyle: 'italic' }}
                          title="Sweed's per-product wholesaleCost was blank/zero for this SKU; cost taken from the most recent sweed_package_snapshots row."
                        >
                          (from PO)
                        </span>
                      ) : null}
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
})

/**
 * One pricing-run review item, rendered with the shared canonical
 * reviewer "middle part" (`CanonicalProductRow` shell + draggable
 * `CanonicalPricingLadder`) so this surface matches `/catalog/review`
 * and `/catalog/pending-purchases` instead of carrying its own bespoke
 * card + static price ladder.
 *
 * Memoized, and owns its own price/note draft + saving state. That keeps a
 * keystroke (or a ladder drag) local to this one card instead of re-rendering
 * the entire run, and keeps the canonical ladder's `competitorListings`
 * identity stable across those local re-renders (it deliberately excludes the
 * proposed price from its rebuild deps to keep a drag alive, but WILL rebuild
 * and drop an in-flight drag if `competitorListings` changes identity).
 *
 * Drafts re-seed from the server value after a revalidation only while the
 * operator hasn't touched the field — a `dirty` flag protects in-progress
 * typing from being clobbered by a background refresh.
 */
const PricingRunItemRow = memo(function PricingRunItemRow({
  item,
  onDecision,
  onSaveEdit,
  onSaveNote,
}: {
  item: PricingReviewItem
  onDecision: (item: PricingReviewItem, decision: 'approve' | 'reject') => Promise<void>
  onSaveEdit: (item: PricingReviewItem, draftValue: string) => Promise<boolean>
  onSaveNote: (item: PricingReviewItem, draftNote: string) => Promise<boolean>
}): JSX.Element {
  const serverDraftValue = readEditableInputValue(item)
  const serverNote = item.lineItem.notes ?? ''

  const [draftValue, setDraftValue] = useState(serverDraftValue)
  const [draftNote, setDraftNote] = useState(serverNote)
  const [priceDirty, setPriceDirty] = useState(false)
  const [noteDirty, setNoteDirty] = useState(false)
  const [isSaving, setIsSaving] = useState(false)

  useEffect(() => {
    if (!priceDirty) {
      setDraftValue(serverDraftValue)
    }
  }, [serverDraftValue, priceDirty])

  useEffect(() => {
    if (!noteDirty) {
      setDraftNote(serverNote)
    }
  }, [serverNote, noteDirty])

  const reviewedPrice = resolveDisplayedPrice(draftValue, item)
  const recentSalesIndicator = describeRecentSales(item.pricingContext.recentSales.summary)
  const competitorListings = useMemo(
    () => mapMarketListingsToCompetitorListings(item.pricingContext.marketListings),
    [item.pricingContext.marketListings],
  )
  const marketReferenceText = formatMarketReferenceText(
    item.pricingContext.marketAveragePostTaxPrice,
    item.pricingContext.marketMedianPostTaxPrice,
  )

  function changeDraftValue(value: string) {
    setPriceDirty(true)
    setDraftValue(value)
  }

  function changeDraftNote(value: string) {
    setNoteDirty(true)
    setDraftNote(value)
  }

  function adjustDraftValue(delta: number) {
    const trimmed = draftValue.trim()
    const baseValue = Number(trimmed)
    const nextValue = trimmed.length > 0 && Number.isFinite(baseValue)
      ? roundCurrency(baseValue + delta)
      : roundCurrency((item.pricingContext.proposedPrice ?? numericValue(item.lineItem.effectiveValue) ?? 0) + delta)
    changeDraftValue(nextValue.toFixed(2))
  }

  async function savePrice() {
    setIsSaving(true)
    try {
      const ok = await onSaveEdit(item, draftValue)
      if (ok) {
        setPriceDirty(false)
      }
    } finally {
      setIsSaving(false)
    }
  }

  async function saveNote() {
    setIsSaving(true)
    try {
      const ok = await onSaveNote(item, draftNote)
      if (ok) {
        setNoteDirty(false)
      }
    } finally {
      setIsSaving(false)
    }
  }

  async function decide(decision: 'approve' | 'reject') {
    setIsSaving(true)
    try {
      await onDecision(item, decision)
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <CanonicalProductRow
      className="detail-panel"
      headerClassName="page-header"
      title={<h5 style={{ margin: 0 }}>{productLabel(item)}</h5>}
      subtitle={pricingTransitionText(item, reviewedPrice)}
      statusPills={
        <>
          <span className={`velocity-indicator velocity-indicator-${recentSalesIndicator.tone}`}>{recentSalesIndicator.detailLabel}</span>
          <Pill tone={approvalTone(item.lineItem.approvalStatus)}>{reviewDecisionLabel(item.lineItem.approvalStatus)}</Pill>
          <span className="subtle-copy">
            Cost {formatMoney(item.pricingContext.wholesaleCost)}
            {item.pricingContext.wholesaleCostSource === 'package_snapshot' ? (
              <span
                className="subtle-copy"
                style={{ marginLeft: '0.35rem', fontStyle: 'italic' }}
                title="Sweed's per-product wholesaleCost was blank/zero for this SKU; cost taken from the most recent sweed_package_snapshots row."
              >
                (from PO)
              </span>
            ) : null}
            {' · '}{item.pricingContext.tab ?? item.lineItem.fieldPath}
          </span>
        </>
      }
      pricingLadder={
        <CanonicalPricingLadder
          competitorListings={competitorListings}
          livePrice={numericValue(item.lineItem.baselineValue)}
          marketAveragePostTax={item.pricingContext.marketAveragePostTaxPrice}
          marketMedianPostTax={item.pricingContext.marketMedianPostTaxPrice}
          onProposedPriceChange={(next) => changeDraftValue(next.toFixed(2))}
          productId={item.lineItem.targetEntityId}
          proposedPrice={reviewedPrice}
          variant="detail"
        />
      }
      bodyExtras={
        <>
          {marketReferenceText ? <p className="subtle-copy" style={{ marginTop: '0.35rem', marginBottom: '0.5rem' }}>{marketReferenceText}</p> : null}
          <p className="subtle-copy" style={{ marginTop: 0, marginBottom: '0.5rem' }}>
            {item.pricingContext.priceReason ?? 'No structured pricing reason recorded for this row.'}
          </p>
          {item.pricingContext.marketListings.length > 0 ? (
            <p className="subtle-copy" style={{ marginTop: 0 }}>{summarizeListingBands(item.pricingContext.marketListings)}</p>
          ) : null}
          {item.pricingContext.marketListings.length > 0 ? (
            <details style={{ marginTop: '0.5rem' }}>
              <summary>Market listings ({item.pricingContext.marketListings.length})</summary>
              <ul className="timeline-list" style={{ marginTop: '0.75rem' }}>
                {item.pricingContext.marketListings.map((listing, index) => (
                  <li key={`${listing.dispensaryName}-${listing.listingName}-${index}`}>
                    {listing.url ? (
                      <a href={listing.url} rel="noreferrer" target="_blank"><strong>{listing.dispensaryName}</strong></a>
                    ) : (
                      <strong>{listing.dispensaryName}</strong>
                    )}
                    <div className="subtle-copy">
                      {listing.listingName} · {formatMoney(listing.postTaxPrice)} post-tax · {formatDistanceBandLabel(listing.distanceBand, listing.distanceMiles)} · {formatMatchTierLabel(listing.matchTier)} match
                    </div>
                    {!listing.eligibleForPricing ? <p className="subtle-copy">Display only: {listing.exclusionReason ?? 'not pricing eligible'}</p> : null}
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
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
        </>
      }
      overrides={
        <>
          <div className="inline-row wrap-row" style={{ alignItems: 'center', marginBottom: '0.6rem' }}>
            <input
              inputMode="decimal"
              onChange={(event) => changeDraftValue(event.currentTarget.value)}
              type="text"
              value={draftValue}
            />
            <button className="ghost-button" disabled={isSaving} onClick={() => adjustDraftValue(-0.25)} type="button">-0.25</button>
            <button className="ghost-button" disabled={isSaving} onClick={() => adjustDraftValue(0.25)} type="button">+0.25</button>
          </div>
          <label className="stack-field">
            <span>Review note</span>
            <textarea onChange={(event) => changeDraftNote(event.currentTarget.value)} rows={3} value={draftNote} />
          </label>
        </>
      }
      decisions={
        <div className="inline-row wrap-row review-actions">
          <button className="ghost-button" disabled={isSaving} onClick={() => void savePrice()} type="button">Save price</button>
          <button className="primary-button" disabled={isSaving || item.lineItem.approvalStatus !== 'pending'} onClick={() => void decide('approve')} type="button">Approve</button>
          <button className="danger-button" disabled={isSaving || item.lineItem.approvalStatus !== 'pending'} onClick={() => void decide('reject')} type="button">Exclude</button>
          <button className="ghost-button" disabled={isSaving} onClick={() => void saveNote()} type="button">Save note</button>
        </div>
      }
    />
  )
})

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

interface PricingReviewGroupSlice extends Omit<PricingRunGroupSummary, 'reviewItems'> {
  key: string
  reviewItems: PricingReviewItem[]
}

interface BrandFamilySection {
  approvedCount: number
  brandName: string
  categoryName: string
  groups: PricingReviewGroupSlice[]
  key: string
  pendingCount: number
  rejectedCount: number
  reviewItems: PricingReviewItem[]
  subcategoryName: string
  tab: string
}

interface TabSection {
  approvedCount: number
  brands: BrandFamilySection[]
  key: string
  pendingCount: number
  rejectedCount: number
  tab: string
}

interface SubcategorySection {
  approvedCount: number
  key: string
  pendingCount: number
  rejectedCount: number
  subcategoryName: string
  tabs: TabSection[]
}

interface CategorySection {
  approvedCount: number
  categoryName: string
  key: string
  pendingCount: number
  rejectedCount: number
  subcategories: SubcategorySection[]
}

function buildPricingReviewHierarchy(groups: PricingRunDetailResponse['groups']): CategorySection[] {
  const categoryMap = new Map<string, CategorySection>()

  for (const group of groups) {
    const categoryName = group.categoryName ?? 'No category'
    const subcategoryName = group.subcategoryName ?? 'No subcategory'
    const brandName = group.brandName ?? 'Unbranded'

    for (const item of group.reviewItems) {
      const tab = variantTabLabel(item)
      const category = getOrInsert(categoryMap, categoryName, () => ({
        approvedCount: 0,
        categoryName,
        key: categoryName,
        pendingCount: 0,
        rejectedCount: 0,
        subcategories: [],
      }))
      const subcategoryKey = `${category.key}|${subcategoryName}`
      const subcategory = getOrInsertSection(category.subcategories, subcategoryKey, () => ({
        approvedCount: 0,
        key: subcategoryKey,
        pendingCount: 0,
        rejectedCount: 0,
        subcategoryName,
        tabs: [],
      }))
      const tabKey = `${subcategory.key}|${tab}`
      const tabSection = getOrInsertSection(subcategory.tabs, tabKey, () => ({
        approvedCount: 0,
        brands: [],
        key: tabKey,
        pendingCount: 0,
        rejectedCount: 0,
        tab,
      }))
      const brandKey = `${tabSection.key}|${brandName}`
      const brand = getOrInsertSection(tabSection.brands, brandKey, () => ({
        approvedCount: 0,
        brandName,
        categoryName,
        groups: [],
        key: brandKey,
        pendingCount: 0,
        rejectedCount: 0,
        reviewItems: [],
        subcategoryName,
        tab,
      }))
      const groupSlice = getOrInsertSection(brand.groups, `${brand.key}|${group.proposalRowId}`, () => ({
        ...group,
        key: `${brand.key}|${group.proposalRowId}`,
        reviewItems: [],
      }))

      brand.reviewItems.push(item)
      groupSlice.reviewItems.push(item)
    }
  }

  for (const category of categoryMap.values()) {
    for (const subcategory of category.subcategories) {
      for (const tab of subcategory.tabs) {
        for (const brand of tab.brands) {
          applyCounts(brand, brand.reviewItems)
        }
        tab.brands.sort(comparePendingThenLabel((section) => section.brandName))
        rollupCounts(tab, tab.brands)
      }
      subcategory.tabs.sort(comparePendingThenLabel((section) => section.tab))
      rollupCounts(subcategory, subcategory.tabs)
    }
    category.subcategories.sort(comparePendingThenLabel((section) => section.subcategoryName))
    rollupCounts(category, category.subcategories)
  }

  return [...categoryMap.values()].sort(comparePendingThenLabel((section) => section.categoryName))
}

function getOrInsert<K, V>(map: Map<K, V>, key: K, build: () => V): V {
  const existing = map.get(key)
  if (existing) return existing
  const next = build()
  map.set(key, next)
  return next
}

function getOrInsertSection<T extends { key: string }>(sections: T[], key: string, build: () => T): T {
  const existing = sections.find((section) => section.key === key)
  if (existing) return existing
  const next = build()
  sections.push(next)
  return next
}

function applyCounts(target: { approvedCount: number; pendingCount: number; rejectedCount: number }, items: PricingReviewItem[]): void {
  target.pendingCount = countPendingItems(items)
  target.approvedCount = countItemsWithStatus(items, 'approved')
  target.rejectedCount = countItemsWithStatus(items, 'rejected')
}

function rollupCounts(target: { approvedCount: number; pendingCount: number; rejectedCount: number }, children: Array<{ approvedCount: number; pendingCount: number; rejectedCount: number }>): void {
  target.pendingCount = children.reduce((sum, child) => sum + child.pendingCount, 0)
  target.approvedCount = children.reduce((sum, child) => sum + child.approvedCount, 0)
  target.rejectedCount = children.reduce((sum, child) => sum + child.rejectedCount, 0)
}

function comparePendingThenLabel<T>(label: (value: T) => string): (left: T & { pendingCount: number }, right: T & { pendingCount: number }) => number {
  return (left, right) => {
    if (right.pendingCount !== left.pendingCount) return right.pendingCount - left.pendingCount
    return label(left).localeCompare(label(right))
  }
}

function variantTabLabel(item: PricingReviewItem): string {
  return item.pricingContext.tab ?? 'Unknown variant tab'
}

function marketSummaryForItems(items: PricingReviewItem[]): string {
  const listingCount = items.reduce((sum, item) => sum + (item.pricingContext.marketListingCount ?? item.pricingContext.marketListings.length), 0)
  const eligibleCount = items.reduce((sum, item) => sum + (item.pricingContext.marketEligibleListingCount ?? 0), 0)
  const prices = items
    .map((item) => item.pricingContext.marketMedianPostTaxPrice ?? item.pricingContext.marketAveragePostTaxPrice)
    .filter((value): value is number => value !== null)
  const marketText = prices.length > 0
    ? `market ${formatMoney(roundCurrency(prices.reduce((sum, value) => sum + value, 0) / prices.length))}`
    : 'no market average'
  const thinCompText = eligibleCount > 0 && eligibleCount < Math.max(3, items.length) ? ' · thin comps' : ''
  return `${marketText} · ${eligibleCount}/${listingCount} pricing comps${thinCompText}`
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
  if (selectionFilters.distributorNames.length > 0) {
    parts.push(`Distributors: ${selectionFilters.distributorNames.join(', ')}`)
  }
  if (selectionFilters.categories.length > 0) {
    parts.push(`Categories: ${selectionFilters.categories.join(', ')}`)
  }
  if (selectionFilters.subcategories.length > 0) {
    parts.push(`Subcategories: ${selectionFilters.subcategories.join(', ')}`)
  }
  if (selectionFilters.unitSizes.length > 0) {
    parts.push(`Variant sizes: ${selectionFilters.unitSizes.join(', ')}`)
  }
  if (selectionFilters.packSizes.length > 0) {
    parts.push(`Pack sizes: ${selectionFilters.packSizes.map(formatPackSizeLabel).join(', ')}`)
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
  // GM% MUST be derived from the price actually on screen (which reflects the
  // operator's live edit / ladder drag), not the generation-time percentages
  // stored in evidence_json. The stored proposedGmPercent was computed against
  // the originally-generated price, so pairing it with an edited price produced
  // impossible transitions like "$25.00 (57.06%) -> $22.50 (58.71%)" — a lower
  // price appearing to raise GM. Recompute both ends from the displayed prices
  // and the same wholesale cost via the canonical shared helper.
  const cost = item.pricingContext.wholesaleCost
  const livePriceValue = numericValue(item.lineItem.baselineValue)
  const currentGmPercent = calculateGmPercent(cost, livePriceValue)
  const proposedGmPercent = calculateGmPercent(cost, reviewedPrice)
  return `${formatMoney(livePriceValue)} (${formatPercent(currentGmPercent)}) -> ${formatMoney(reviewedPrice)} (${formatPercent(proposedGmPercent)})`
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

function formatPackSizeLabel(value: string): string {
  const numeric = Number(value)
  if (Number.isInteger(numeric) && numeric > 0) {
    return numeric === 1 ? '1 per pkg' : `${numeric}-pack`
  }
  return value
}

function roundCurrency(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100
}

function numericValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function numericValueFromString(value: string): number | null {
  const trimmed = value.trim()
  if (trimmed.length === 0) {
    return null
  }
  const parsed = Number(trimmed)
  return Number.isFinite(parsed) ? parsed : null
}

function resolveDisplayedPrice(draftValue: string, item: PricingReviewItem): number | null {
  return numericValueFromString(draftValue) ?? item.pricingContext.proposedPrice ?? numericValue(item.lineItem.effectiveValue)
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
