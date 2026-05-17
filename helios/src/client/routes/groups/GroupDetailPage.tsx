import { useState } from 'react'
import { useLoaderData, useRevalidator } from 'react-router-dom'

import {
  GroupDetailResponseSchema,
  LlmRunDetailResponseSchema,
  MutationAcceptedResponseSchema,
  type GroupDetailResponse,
  type GroupProductMarketEvidence,
  type LlmRunDetailResponse,
  type PendingPurchaseMarketListing,
} from '../../../shared/contracts/index.js'
import type { CompetitorListing } from '../../../shared/ui/pricing-ladder/index.js'
import { loadJson, mutateJson } from '../../app/fetchJson.js'
import { waitForJob } from '../../app/jobPolling.js'
import { CanonicalPricingLadder } from '../../components/CanonicalPricingLadder.js'
import { Pill } from '../../components/Pill.js'
import { useRegisterCatalogSidebarSubtree } from '../catalog/catalogSidebarSubtree.js'
import { describeRecentSales, formatCount, formatCoverage, formatCurrency } from '../catalog/recentSales.js'

export async function groupDetailLoader({ params }: { params: Record<string, string | undefined> }) {
  const catalogGroupId = params.catalogGroupId
  return loadJson(`/api/catalog/groups/${catalogGroupId}`, GroupDetailResponseSchema)
}

export function GroupDetailPage() {
  useRegisterCatalogSidebarSubtree()
  const data = useLoaderData() as GroupDetailResponse
  const revalidator = useRevalidator()
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [llmRunDetails, setLlmRunDetails] = useState<Record<number, LlmRunDetailResponse | null>>({})
  const [llmRunLoadingId, setLlmRunLoadingId] = useState<number | null>(null)
  const recentSalesIndicator = describeRecentSales(data.recentSales.summary)

  async function runGroupRefresh() {
    setErrorMessage(null)
    try {
      const response = await mutateJson(
        `/api/catalog-groups/${data.group.catalogGroupId}/refresh`,
        MutationAcceptedResponseSchema,
        {
          body: JSON.stringify({ reason: 'Operator detail refresh' }),
          method: 'POST',
        },
      )
      if (response.jobId) {
        await waitForJob(response.jobId)
      }
      await revalidator.revalidate()
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Could not refresh the group.')
    }
  }

  async function requestGenerationRerun(purpose: 'description' | 'pricing') {
    setErrorMessage(null)
    try {
      const response = await mutateJson(
        `/api/catalog-groups/${data.group.catalogGroupId}/llm-reruns`,
        MutationAcceptedResponseSchema,
        {
          body: JSON.stringify({ forceLiveRefresh: true, purpose }),
          method: 'POST',
        },
      )
      if (response.jobId) {
        await waitForJob(response.jobId)
      }
      await revalidator.revalidate()
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Could not enqueue the generation rerun.')
    }
  }

  async function toggleLlmRunDetail(llmRunId: number) {
    setErrorMessage(null)
    if (llmRunDetails[llmRunId]) {
      setLlmRunDetails((current) => ({ ...current, [llmRunId]: null }))
      return
    }

    setLlmRunLoadingId(llmRunId)
    try {
      const detail = await loadJson(`/api/llm/runs/${llmRunId}`, LlmRunDetailResponseSchema)
      setLlmRunDetails((current) => ({ ...current, [llmRunId]: detail }))
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Could not load the LLM run detail.')
    } finally {
      setLlmRunLoadingId((current) => (current === llmRunId ? null : current))
    }
  }

  return (
    <section>
      <div className="page-header">
        <div>
          <p className="eyebrow">Group Detail</p>
          <h2>{data.group.groupName}</h2>
          <div className="inline-row wrap-row">
            <Pill tone="muted">{`#${data.group.sweedGroupId}`}</Pill>
            <Pill tone={data.group.reconcileStatus === 'in_sync' ? 'success' : 'warning'}>{data.group.reconcileStatus}</Pill>
            <Pill tone={recentSalesIndicator.tone}>{recentSalesIndicator.detailLabel}</Pill>
          </div>
        </div>
        <div className="inline-row wrap-row">
          <button className="ghost-button" onClick={() => void runGroupRefresh()} type="button">
            Refresh live snapshot
          </button>
          <button className="primary-button" onClick={() => void requestGenerationRerun('description')} type="button">
            Force description rerun
          </button>
          <button className="ghost-button" onClick={() => void requestGenerationRerun('pricing')} type="button">
            Force pricing rerun
          </button>
        </div>
      </div>

      {errorMessage ? <p className="error-text">{errorMessage}</p> : null}
      {data.recentSalesIssue ? <p className="error-text">{data.recentSalesIssue}</p> : null}

      <div className="detail-grid">
        <section className="detail-panel wide-panel">
          <div className="page-header">
            <div>
              <h3>Recent Sales</h3>
              <p className="subtle-copy">
                {`Across Bronx + Midtown from ${data.recentSales.reportSource} · ${formatCoverage(data.recentSales.summary)}`}
              </p>
            </div>
            <Pill tone={recentSalesIndicator.tone}>{recentSalesIndicator.detailLabel}</Pill>
          </div>

          <div className="comparison-grid">
            <div className="value-panel">
              <span>Units / day</span>
              <p>{formatCount(data.recentSales.summary.unitsPerDay)}</p>
            </div>
            <div className="value-panel">
              <span>Days / unit</span>
              <p>{formatCount(data.recentSales.summary.daysPerUnit)}</p>
            </div>
            <div className="value-panel">
              <span>On hand</span>
              <p>{formatCount(data.recentSales.summary.onHand)}</p>
            </div>
            <div className="value-panel">
              <span>Gross sales / 30d</span>
              <p>{formatCurrency(data.recentSales.summary.last30DaysGrossSales)}</p>
            </div>
            <div className="value-panel">
              <span>Report date</span>
              <p>{data.recentSales.summary.reportDate ? new Date(data.recentSales.summary.reportDate).toLocaleString() : '—'}</p>
            </div>
            <div className="value-panel">
              <span>Coverage</span>
              <p>{formatCoverage(data.recentSales.summary)}</p>
            </div>
          </div>

          <div className="sales-site-grid">
            {data.recentSales.sites.map((site) => {
              const siteIndicator = describeRecentSales(site.summary)
              return (
                <article className="mini-card" key={site.siteDealerId}>
                  <header>
                    <strong>{site.siteLabel}</strong>
                    <Pill tone={siteIndicator.tone}>{siteIndicator.detailLabel}</Pill>
                  </header>
                  <div className="subtle-copy" style={{ marginTop: '0.5rem' }}>
                    {`${formatCount(site.summary.onHand)} on hand · ${formatCurrency(site.summary.last30DaysGrossSales)} gross / 30d · ${formatCoverage(site.summary)}`}
                  </div>
                </article>
              )
            })}
          </div>

          <div className="data-table-wrapper" style={{ marginTop: '1rem' }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Site</th>
                  <th>Product</th>
                  <th>Recent pace</th>
                  <th>On hand</th>
                  <th>Gross / 30d</th>
                  <th>Report date</th>
                </tr>
              </thead>
              <tbody>
                {data.recentSales.productRows.map((row) => {
                  const rowIndicator = describeRecentSales({
                    combinationCount: 1,
                    coverageCount: row.hasCoverage ? 1 : 0,
                    daysPerUnit: row.daysPerUnit,
                    last30DaysGrossSales: row.last30DaysGrossSales,
                    onHand: row.onHand,
                    reportDate: row.reportDate,
                    unitsPerDay: row.unitsPerDay,
                  })

                  return (
                    <tr key={`${row.siteDealerId}-${row.productId}`}>
                      <td>{row.siteLabel}</td>
                      <td>
                        <strong>{row.productName}</strong>
                        <div className="subtle-copy">{row.productTab}</div>
                      </td>
                      <td>
                        <Pill tone={rowIndicator.tone}>{rowIndicator.detailLabel}</Pill>
                      </td>
                      <td>{formatCount(row.onHand)}</td>
                      <td>{formatCurrency(row.last30DaysGrossSales)}</td>
                      <td>{row.reportDate ? new Date(row.reportDate).toLocaleString() : '—'}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </section>

        <MarketResearchPanel evidence={data.marketEvidence} />

        <section className="detail-panel">
          <h3>Live Snapshot</h3>
          <pre>{JSON.stringify(data.liveSnapshot?.stateJson ?? null, null, 2)}</pre>
        </section>

        <section className="detail-panel">
          <h3>Desired State</h3>
          <ul className="timeline-list">
            {data.desiredState.map((revision) => (
              <li key={revision.revisionId}>
                <strong>{revision.fieldPath}</strong>
                <div className="subtle-copy">{revision.active ? 'active' : 'inactive'} · {revision.paused ? 'paused' : 'enforcing'}</div>
                <pre>{JSON.stringify(revision.desiredValue, null, 2)}</pre>
              </li>
            ))}
            {data.desiredState.length === 0 ? <li className="empty-state">No desired-state revisions yet.</li> : null}
          </ul>
        </section>

        <section className="detail-panel wide-panel">
          <h3>Proposal History</h3>
          <div className="stacked-list">
            {data.proposalRows.map((row) => (
              <article className="mini-card" key={row.proposalRowId}>
                <header>
                  <strong>{row.rowTitle}</strong>
                  <span className="subtle-copy">Batch #{row.proposalBatchId}</span>
                </header>
                {row.lineItems.map((lineItem) => (
                  <div className="mini-card-row" key={lineItem.lineItemId}>
                    <div>
                      <strong>{lineItem.fieldPath}</strong>
                      <p className="subtle-copy">{lineItem.valuePreview.effectiveText}</p>
                    </div>
                    <Pill tone={lineItem.approvalStatus === 'approved' ? 'success' : lineItem.approvalStatus === 'rejected' ? 'danger' : 'warning'}>
                      {lineItem.approvalStatus}
                    </Pill>
                  </div>
                ))}
              </article>
            ))}
          </div>
        </section>

        <section className="detail-panel">
          <h3>Generation Diagnostics</h3>
          <ul className="timeline-list">
            {data.llmRuns.map((run) => (
              <li key={run.llmRunId}>
                <strong>{run.purpose}</strong>
                <div className="subtle-copy">{run.model} · {run.promptVersion}</div>
                <div className="inline-row wrap-row">
                  <Pill tone={run.status === 'succeeded' ? 'success' : run.status === 'failed' ? 'danger' : 'warning'}>
                    {run.status}
                  </Pill>
                  {run.forcedRefresh ? <Pill tone="warning">forced refresh</Pill> : null}
                </div>
                {Array.isArray(run.validationIssues) && run.validationIssues.length > 0 ? (
                  <pre>{JSON.stringify(run.validationIssues, null, 2)}</pre>
                ) : null}
                <button className="ghost-button" onClick={() => void toggleLlmRunDetail(run.llmRunId)} type="button">
                  {llmRunDetails[run.llmRunId] ? 'Hide prompt and output' : llmRunLoadingId === run.llmRunId ? 'Loading…' : 'Inspect prompt and output'}
                </button>
                {llmRunDetails[run.llmRunId] ? (
                  <div className="stacked-list">
                    <div>
                      <strong>Input</strong>
                      <pre>{JSON.stringify(llmRunDetails[run.llmRunId]?.run.inputJson ?? null, null, 2)}</pre>
                    </div>
                    <div>
                      <strong>Structured Output</strong>
                      <pre>{JSON.stringify(llmRunDetails[run.llmRunId]?.run.parsedOutputJson ?? null, null, 2)}</pre>
                    </div>
                    <div>
                      <strong>Raw Trace</strong>
                      <pre>{llmRunDetails[run.llmRunId]?.run.rawOutputText ?? ''}</pre>
                    </div>
                  </div>
                ) : null}
              </li>
            ))}
            {data.llmRuns.length === 0 ? <li className="empty-state">No generation runs recorded yet.</li> : null}
          </ul>
        </section>

        <section className="detail-panel">
          <h3>Jobs and Writes</h3>
          <ul className="timeline-list compact-list">
            {data.recentJobs.map((job) => (
              <li key={`job-${job.jobId}`}>
                <strong>{job.jobType}</strong>
                <div className="subtle-copy">{job.status}{job.lastError ? ` · ${job.lastError}` : ''}</div>
              </li>
            ))}
            {data.writeOperations.map((operation) => (
              <li key={`write-${operation.writeOperationId}`}>
                <strong>{operation.operationType}</strong>
                <div className="subtle-copy">{operation.status}{operation.error ? ` · ${operation.error}` : ''}</div>
              </li>
            ))}
          </ul>
        </section>

        <section className="detail-panel wide-panel">
          <h3>Audit Timeline</h3>
          <ul className="timeline-list compact-list">
            {data.recentAuditEvents.map((event) => (
              <li key={event.eventId}>
                <strong>{event.eventType}</strong>
                <div className="subtle-copy">{event.actorLabel} · {new Date(event.createdAt).toLocaleString()}</div>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </section>
  )
}

interface MarketResearchPanelProps {
  evidence: GroupProductMarketEvidence[]
}

function MarketResearchPanel({ evidence }: MarketResearchPanelProps) {
  const showWarning = evidence.some((entry) => entry.freshness !== 'fresh')
  const [acknowledgedExpired, setAcknowledgedExpired] = useState<Record<number, boolean>>({})
  const expiredEntries = evidence.filter((entry) => entry.freshness === 'expired')
  const unacknowledgedExpiredCount = expiredEntries.reduce(
    (count, entry) => count + (acknowledgedExpired[entry.productId] ? 0 : 1),
    0,
  )

  function toggleAcknowledged(productId: number) {
    setAcknowledgedExpired((current) => ({ ...current, [productId]: !current[productId] }))
  }

  return (
    <section className="detail-panel wide-panel">
      <h3>Market Research</h3>
      {showWarning ? (
        <p className="error-text">
          Live market refresh is currently broken (legacy Lit Alerts bearer expired); the evidence below is whatever was last successfully cached. The catalog-wide partner-API refresh is task-B phase 1.
        </p>
      ) : null}
      {unacknowledgedExpiredCount > 0 ? (
        <p className="error-text" data-market-evidence-apply-block="true">
          {`Apply actions are blocked — ${unacknowledgedExpiredCount} product${unacknowledgedExpiredCount === 1 ? '' : 's'} ` +
            `have expired competitor evidence. Either Refresh now or Acknowledge expired evidence per-product to proceed.`}
        </p>
      ) : null}
      {evidence.length === 0 ? (
        <p className="empty-state">No in-group products to research.</p>
      ) : (
        <div className="stacked-list">
          {evidence.map((entry) => (
            <MarketResearchProductCard
              acknowledgeExpired={acknowledgedExpired[entry.productId] === true}
              entry={entry}
              key={entry.productId}
              onToggleAcknowledgeExpired={() => toggleAcknowledged(entry.productId)}
            />
          ))}
        </div>
      )}
      <p className="subtle-copy" style={{ marginTop: '0.75rem', fontSize: '0.8rem' }}>
        Evidence sourced from helios.litalerts_competitor_observations (most recent succeeded observation per product).
      </p>
    </section>
  )
}

interface MarketResearchProductCardProps {
  entry: GroupProductMarketEvidence
  acknowledgeExpired: boolean
  onToggleAcknowledgeExpired: () => void
}

function MarketResearchProductCard({ entry, acknowledgeExpired, onToggleAcknowledgeExpired }: MarketResearchProductCardProps) {
  const freshness = describeMarketEvidenceFreshness(entry)
  const competitorListings = mapMarketListingsToCompetitorListings(entry.matchedListings)
  const visibleListings = entry.matchedListings.slice(0, 25)
  const remaining = entry.matchedListings.length - visibleListings.length

  return (
    <article className="mini-card">
      <header className="inline-row wrap-row" style={{ justifyContent: 'space-between' }}>
        <div>
          <strong>{entry.productName}</strong>
          <div className="subtle-copy inline-row wrap-row">
            {entry.productTab ? <span>{entry.productTab}</span> : null}
            <Pill tone="muted">{`#${entry.productId}`}</Pill>
            <span>{entry.livePrice !== null ? `Live ${formatCurrency(entry.livePrice)}` : 'Live —'}</span>
          </div>
        </div>
        <div className="inline-row wrap-row" style={{ gap: '0.5rem' }}>
          <Pill tone={freshness.tone}>{freshness.label}</Pill>
          {entry.freshness === 'expired' ? (
            <label className="inline-row" style={{ gap: '0.25rem', fontSize: '0.75rem' }}>
              <input
                checked={acknowledgeExpired}
                onChange={onToggleAcknowledgeExpired}
                type="checkbox"
              />
              Acknowledge expired evidence
            </label>
          ) : null}
        </div>
      </header>

      {entry.freshness === 'absent' ? (
        <p className="empty-state" style={{ marginTop: '0.75rem' }}>
          No cached competitor evidence for this product yet. Will be picked up by the partner-API sweep once task-B phase 1 lands.
        </p>
      ) : (
        <>
          <div style={{ marginTop: '0.75rem' }}>
            <CanonicalPricingLadder
              acknowledgeExpiredEvidence={acknowledgeExpired}
              competitorListings={competitorListings}
              freshness={entry.freshness}
              freshnessAgeDays={entry.ageDays}
              livePrice={entry.livePrice}
              marketAveragePostTax={entry.averagePostTaxPrice}
              marketMedianPostTax={entry.medianPostTaxPrice}
              productId={entry.productId}
              proposedPrice={null}
              variant="compact"
            />
          </div>

          <div className="subtle-copy inline-row wrap-row" style={{ marginTop: '0.5rem' }}>
            <span>{`${entry.listingCount} listing${entry.listingCount === 1 ? '' : 's'}`}</span>
            <span>{`${entry.eligibleListingCount} eligible`}</span>
            {entry.searchTermLabel ? <span>{`search: ${entry.searchTermLabel}`}</span> : null}
            {entry.brandName ? <span>{`brand: ${entry.brandName}`}</span> : null}
            {entry.availability ? <span>{`availability: ${entry.availability}`}</span> : null}
            {entry.capturedAt ? <span>{`captured: ${new Date(entry.capturedAt).toLocaleString()}`}</span> : null}
          </div>
          {entry.notes ? <p className="subtle-copy" style={{ marginTop: '0.25rem' }}>{entry.notes}</p> : null}

          {visibleListings.length === 0 ? (
            <p className="empty-state" style={{ marginTop: '0.5rem' }}>
              Observation has no matched listings.
            </p>
          ) : (
            <ul className="stacked-list compact-list" style={{ marginTop: '0.5rem' }}>
              {visibleListings.map((listing, index) => (
                <li key={`${listing.dispensaryName}-${listing.listingName}-${listing.source}-${index}`} className="mini-card-row">
                  <div>
                    <strong>{listing.dispensaryName}</strong>
                    <div className="subtle-copy">{listing.listingName}</div>
                  </div>
                  <div className="subtle-copy inline-row wrap-row">
                    <span>{formatCurrency(listing.postTaxPrice)} post-tax</span>
                    <span>
                      {listing.distanceMiles !== null
                        ? `${listing.distanceMiles.toFixed(1)} mi (${listing.distanceBand})`
                        : listing.distanceBand}
                    </span>
                    <Pill tone={listing.source === 'nearby' ? 'success' : 'muted'}>{listing.source}</Pill>
                    <Pill tone={listing.eligibleForPricing ? 'success' : 'warning'}>
                      {listing.eligibleForPricing ? 'eligible' : listing.exclusionReason ?? 'excluded'}
                    </Pill>
                    {listing.url ? (
                      <a href={listing.url} target="_blank" rel="noopener noreferrer">view</a>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          )}
          {remaining > 0 ? <p className="subtle-copy">{`and ${remaining} more`}</p> : null}
        </>
      )}
    </article>
  )
}

function describeMarketEvidenceFreshness(entry: GroupProductMarketEvidence): {
  label: string
  tone: 'success' | 'warning' | 'danger' | 'muted'
} {
  switch (entry.freshness) {
    case 'fresh': {
      const hours = entry.ageDays !== null ? Math.max(0, Math.round(entry.ageDays * 24)) : 0
      return { label: `fresh (${hours}h)`, tone: 'success' }
    }
    case 'stale':
      return { label: `stale (${(entry.ageDays ?? 0).toFixed(1)}d)`, tone: 'warning' }
    case 'very_stale':
      return { label: `very stale (${(entry.ageDays ?? 0).toFixed(1)}d)`, tone: 'danger' }
    case 'expired':
      return { label: `expired (${(entry.ageDays ?? 0).toFixed(1)}d)`, tone: 'danger' }
    case 'absent':
    default:
      return { label: 'no cached market evidence', tone: 'muted' }
  }
}

function mapMarketListingsToCompetitorListings(marketListings: PendingPurchaseMarketListing[]): CompetitorListing[] {
  return marketListings.map((listing, index) => ({
    listingId: `${listing.dispensaryName}-${listing.listingName}-${listing.source}-${index}`,
    postTaxPrice: listing.postTaxPrice,
    distanceMiles: listing.distanceMiles,
    dispensaryName: listing.dispensaryName,
    dispensaryAddress: null,
    listingName: listing.listingName,
    url: null,
    eligibleForPricing: listing.eligibleForPricing,
  }))
}
