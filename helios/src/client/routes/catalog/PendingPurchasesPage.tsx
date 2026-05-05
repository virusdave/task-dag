import { useEffect, useMemo, useState } from 'react'
import { Form, Link, useLoaderData, useRevalidator, useRouteLoaderData } from 'react-router-dom'

import {
  HELIOS_PENDING_PURCHASE_SITE_DEALERS,
  MutationAcceptedResponseSchema,
  PendingPurchaseListResponseSchema,
  QueuePendingPurchaseApplyRequestSchema,
  QueuePendingPurchasePacketGenerationRequestSchema,
  QueuePendingPurchasePacketImportRequestSchema,
  UpdatePendingPurchaseRowApprovalRequestSchema,
  UpdatePendingPurchaseRowRequestSchema,
  buildHeliosModulePath,
  type JobStatusResponse,
  type PendingPurchaseListResponse,
  type PendingPurchaseMarketListing,
  type PendingPurchaseRow,
  type SessionEnvelope,
} from '../../../shared/contracts/index.js'
import { loadJson, mutateJson } from '../../app/fetchJson.js'
import { isJobTerminal, loadJobStatus, waitForJob } from '../../app/jobPolling.js'
import { Pill } from '../../components/Pill.js'
import { useRegisterCatalogSidebarSubtree } from './catalogSidebarSubtree.js'

export async function pendingPurchasesLoader({ request }: { request: Request }) {
  const url = new URL(request.url)
  return loadJson(`/api/catalog/pending-purchases${url.search}`, PendingPurchaseListResponseSchema)
}

export function PendingPurchasesPage() {
  useRegisterCatalogSidebarSubtree()
  const data = useLoaderData() as PendingPurchaseListResponse
  const session = useRouteLoaderData('root') as SessionEnvelope
  const revalidator = useRevalidator()
  const [applySuccessMessage, setApplySuccessMessage] = useState<string | null>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [generateFromDate, setGenerateFromDate] = useState(defaultGenerateFromDate)
  const [generateSiteDealerIds, setGenerateSiteDealerIds] = useState<number[]>(
    HELIOS_PENDING_PURCHASE_SITE_DEALERS.map((dealer) => dealer.dealerId),
  )
  const [generationJobStatus, setGenerationJobStatus] = useState<JobStatusResponse | null>(data.activeGenerationJob)
  const [generateSuccessMessage, setGenerateSuccessMessage] = useState<string | null>(null)
  const [generateToDate, setGenerateToDate] = useState(defaultGenerateToDate)
  const [importFilePath, setImportFilePath] = useState('')
  const [importSuccessMessage, setImportSuccessMessage] = useState<string | null>(null)
  const [isApplying, setIsApplying] = useState(false)
  const [isGenerating, setIsGenerating] = useState(false)
  const [isImporting, setIsImporting] = useState(false)
  const [selectedRowIds, setSelectedRowIds] = useState<number[]>([])

  const canApprove = session.permissions.canApprove

  const actionOptions = useMemo(() => {
    const options = new Set<string>()
    for (const item of data.items) {
      options.add(item.actionType)
    }
    if (data.filters.actionType) {
      options.add(data.filters.actionType)
    }
    return [...options].sort()
  }, [data.filters.actionType, data.items])

  const approvedVisibleRows = useMemo(
    () => data.items.filter((item) => item.approvalStatus === 'approved' && item.lastApplyStatus !== 'applied'),
    [data.items],
  )

  const selectedApprovedRowIds = useMemo(
    () => selectedRowIds.filter((rowId) => approvedVisibleRows.some((item) => item.rowId === rowId)),
    [approvedVisibleRows, selectedRowIds],
  )
  const hierarchy = useMemo(() => buildPendingPurchaseHierarchy(data.items), [data.items])

  useEffect(() => {
    const visibleRowIds = new Set(data.items.map((item) => item.rowId))
    setSelectedRowIds((current) => current.filter((rowId) => visibleRowIds.has(rowId)))
  }, [data.items])

  useEffect(() => {
    if (!data.activeGenerationJob) {
      return
    }

    setGenerationJobStatus((current) => {
      if (!current) {
        return data.activeGenerationJob
      }
      if (current.job.jobId !== data.activeGenerationJob?.job.jobId) {
        return data.activeGenerationJob
      }
      return isJobTerminal(current.job.status) ? current : data.activeGenerationJob
    })
  }, [data.activeGenerationJob])

  useEffect(() => {
    if (!generationJobStatus || isJobTerminal(generationJobStatus.job.status)) {
      return
    }

    let cancelled = false
    let timeoutId: number | undefined

    const poll = async () => {
      try {
        const nextJobStatus = await loadJobStatus(generationJobStatus.job.jobId)
        if (cancelled) {
          return
        }

        setGenerationJobStatus(nextJobStatus)
        if (isJobTerminal(nextJobStatus.job.status)) {
          await finalizeGenerationJob(nextJobStatus)
          return
        }
      } catch (error) {
        if (!cancelled) {
          setErrorMessage(error instanceof Error ? error.message : 'Could not refresh the pending-purchase generation status.')
        }
      }

      if (!cancelled) {
        timeoutId = window.setTimeout(() => {
          void poll()
        }, 1500)
      }
    }

    timeoutId = window.setTimeout(() => {
      void poll()
    }, 1500)

    return () => {
      cancelled = true
      if (timeoutId !== undefined) {
        window.clearTimeout(timeoutId)
      }
    }
  }, [generationJobStatus, revalidator])

  async function handleImport() {
    setIsImporting(true)
    clearFeedback()

    try {
      const body = QueuePendingPurchasePacketImportRequestSchema.parse({
        filePath: importFilePath,
        reason: 'Admin pending-purchase packet import',
      })
      const response = await mutateJson('/api/catalog/pending-purchases/import', MutationAcceptedResponseSchema, {
        body: JSON.stringify(body),
        method: 'POST',
      })

      if (response.jobId) {
        const jobStatus = await waitForJob(response.jobId)
        if (jobStatus.job.status !== 'succeeded') {
          throw new Error(jobStatus.job.lastError ?? 'The pending-purchase packet import did not succeed.')
        }

        const packetId = jobStatus.linkedRecords.pendingPurchasePacketId
        setImportSuccessMessage(
          packetId
            ? `Imported pending-purchase packet #${packetId}.`
            : 'Imported the pending-purchase packet successfully.',
        )
      } else {
        setImportSuccessMessage('Queued the pending-purchase packet import successfully.')
      }

      await revalidator.revalidate()
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Could not import the pending-purchase packet.')
    } finally {
      setIsImporting(false)
    }
  }

  async function handleGenerate() {
    setIsGenerating(true)
    clearFeedback()

    try {
      const body = QueuePendingPurchasePacketGenerationRequestSchema.parse({
        fromDate: generateFromDate,
        reason: 'Admin live pending-purchase packet generation',
        siteDealerIds: generateSiteDealerIds,
        toDate: generateToDate,
      })
      const response = await mutateJson('/api/catalog/pending-purchases/generate', MutationAcceptedResponseSchema, {
        body: JSON.stringify(body),
        method: 'POST',
      })

      if (response.jobId) {
        const jobStatus = await loadJobStatus(response.jobId)
        setGenerationJobStatus(jobStatus)
        if (isJobTerminal(jobStatus.job.status)) {
          await finalizeGenerationJob(jobStatus)
        } else {
          setGenerateSuccessMessage(`Queued live pending-purchase generation as job #${response.jobId}.`)
        }
      } else {
        setGenerateSuccessMessage('Queued the live pending-purchase generation successfully.')
      }
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Could not generate the live pending-purchase packet.')
    } finally {
      setIsGenerating(false)
    }
  }

  async function handleApplySelectedRows() {
    if (!data.activePacket || selectedApprovedRowIds.length === 0) {
      return
    }

    setIsApplying(true)
    clearFeedback()

    try {
      const body = QueuePendingPurchaseApplyRequestSchema.parse({
        packetId: data.activePacket.packetId,
        reason: 'Approver pending-purchase apply',
        rowIds: selectedApprovedRowIds,
      })
      const response = await mutateJson('/api/catalog/pending-purchases/apply', MutationAcceptedResponseSchema, {
        body: JSON.stringify(body),
        method: 'POST',
      })

      if (response.jobId) {
        const jobStatus = await waitForJob(response.jobId)
        if (jobStatus.job.status !== 'succeeded') {
          throw new Error(jobStatus.job.lastError ?? 'The pending-purchase apply job did not succeed.')
        }

        const applyRequestId = jobStatus.linkedRecords.pendingPurchaseApplyRequestId
        setApplySuccessMessage(
          applyRequestId
            ? `Completed pending-purchase apply request #${applyRequestId}.`
            : 'Completed the pending-purchase apply request.',
        )
      } else {
        setApplySuccessMessage('Queued the pending-purchase apply request successfully.')
      }

      setSelectedRowIds([])
      await revalidator.revalidate()
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Could not queue the pending-purchase apply request.')
    } finally {
      setIsApplying(false)
    }
  }

  function clearFeedback() {
    setApplySuccessMessage(null)
    setErrorMessage(null)
    setGenerateSuccessMessage(null)
    setImportSuccessMessage(null)
  }

  async function finalizeGenerationJob(jobStatus: JobStatusResponse) {
    if (jobStatus.job.status === 'succeeded') {
      const packetId = jobStatus.linkedRecords.pendingPurchasePacketId
      setGenerateSuccessMessage(
        packetId
          ? `Generated live pending-purchase packet #${packetId}.`
          : 'Generated the live pending-purchase packet successfully.',
      )
      setErrorMessage(null)
    } else {
      setGenerateSuccessMessage(null)
      setErrorMessage(jobStatus.job.lastError ?? 'The live pending-purchase generation job did not succeed.')
    }

    await revalidator.revalidate()
  }

  function toggleGenerateSiteDealer(dealerId: number) {
    setGenerateSiteDealerIds((current) => (
      current.includes(dealerId)
        ? current.filter((value) => value !== dealerId)
        : [...current, dealerId].sort((left, right) => left - right)
    ))
  }

  function toggleSelectedRow(rowId: number) {
    setSelectedRowIds((current) => (
      current.includes(rowId)
        ? current.filter((candidate) => candidate !== rowId)
        : [...current, rowId].sort((left, right) => left - right)
    ))
  }

  return (
    <section>
      <div className="page-header">
        <div>
          <p className="eyebrow">Pending Purchases</p>
          <h2>Purchase-driven catalog work queued for review</h2>
          <p className="subtle-copy">
            Helios stores operator edits here first so the later apply path can stay asynchronous, audited, and worker-driven. This page is the service-backed replacement for the older packet review HTMLs.
          </p>
        </div>
        <Form className="filter-row" method="get">
          <select defaultValue={data.filters.packetId ?? ''} name="packetId">
            <option value="">Latest active packet</option>
            {data.packets.map((packet) => (
              <option key={packet.packetId} value={packet.packetId}>{packet.packetTitle}</option>
            ))}
          </select>
          <select defaultValue={data.filters.siteKey ?? ''} name="siteKey">
            <option value="">All sites</option>
            {(data.activePacket?.siteKeys ?? []).map((siteKey, index) => (
              <option key={siteKey} value={siteKey}>{data.activePacket?.siteLabels[index] ?? siteKey}</option>
            ))}
          </select>
          <select defaultValue={data.filters.actionType ?? ''} name="actionType">
            <option value="">All actions</option>
            {actionOptions.map((actionType) => (
              <option key={actionType} value={actionType}>{actionType}</option>
            ))}
          </select>
          <input defaultValue={data.filters.search ?? ''} name="search" placeholder="Search distributor, brand, or target variant" />
          <button className="ghost-button" type="submit">Filter</button>
        </Form>
      </div>
      {errorMessage ? <p className="error-text">{errorMessage}</p> : null}
      {applySuccessMessage ? <p>{applySuccessMessage}</p> : null}
      {generateSuccessMessage ? <p>{generateSuccessMessage}</p> : null}
      {importSuccessMessage ? <p>{importSuccessMessage}</p> : null}
      {generationJobStatus ? <PendingPurchaseGenerationStatusPanel jobStatus={generationJobStatus} /> : null}
      {data.activePacket ? (
        <article className="mini-card" style={{ marginBottom: '1rem' }}>
          <header>
            <strong>{data.activePacket.packetTitle}</strong>
            <div className="inline-row wrap-row">
              <Pill tone={data.activePacket.source === 'generated' ? 'success' : 'warning'}>{data.activePacket.source}</Pill>
              <Pill tone={data.activePacket.status === 'ready' ? 'success' : 'muted'}>{data.activePacket.status}</Pill>
              <Pill tone="muted">{`${data.activePacket.rowCount} rows`}</Pill>
            </div>
          </header>
          <p className="subtle-copy">
            Generated {new Date(data.activePacket.generatedAt).toLocaleString()}
            {data.activePacket.importFileName ? ` · ${data.activePacket.importFileName}` : ''}
          </p>
          {data.activePacket.sourcePath ? <p className="subtle-copy">{data.activePacket.sourcePath}</p> : null}
          <div className="inline-row wrap-row module-card-links">
            <Link to={`/catalog/history?sectionLimit=8`}>Open catalog history</Link>
          </div>
        </article>
      ) : (
        <p className="empty-state">Import a pending-purchase packet to start reviewing purchase-driven catalog candidates in Helios.</p>
      )}
      {data.latestApplyRequest ? (
        <article className="mini-card" style={{ marginBottom: '1rem' }}>
          <header>
            <strong>{`Latest apply request #${data.latestApplyRequest.requestId}`}</strong>
            <div className="inline-row wrap-row">
              <Pill tone={applyRequestTone(data.latestApplyRequest.status)}>{data.latestApplyRequest.status.replaceAll('_', ' ')}</Pill>
              <Pill tone="muted">{`${data.latestApplyRequest.appliedRowCount}/${data.latestApplyRequest.selectedRowCount} applied`}</Pill>
            </div>
          </header>
          <p className="subtle-copy">
            Requested {new Date(data.latestApplyRequest.requestedAt).toLocaleString()}
            {data.latestApplyRequest.finishedAt ? ` · Finished ${new Date(data.latestApplyRequest.finishedAt).toLocaleString()}` : ''}
            {data.latestApplyRequest.requestedByUser ? ` · ${data.latestApplyRequest.requestedByUser}` : ''}
          </p>
          <p className="subtle-copy">
            {data.latestApplyRequest.summaryText ?? 'No structured apply summary has been recorded yet.'}
          </p>
          <div className="inline-row wrap-row module-card-links">
            <Link to={`/catalog/history?sectionLimit=8`}>See apply history</Link>
          </div>
        </article>
      ) : null}
      {session.user?.role === 'admin' ? (
        <>
          <article className="mini-card" style={{ marginBottom: '1rem' }}>
            <header>
              <strong>Generate live pending-purchase packet</strong>
              <Pill tone="warning">admin</Pill>
            </header>
            <p className="subtle-copy">
              Read the current Sweed outstanding PO queue directly and persist a generated Helios review packet. This supersedes the prior ready packet without writing to Sweed synchronously.
            </p>
            <div className="filter-row" style={{ alignItems: 'center' }}>
              <label className="stack-field" style={{ minWidth: '11rem' }}>
                <span>From</span>
                <input onChange={(event) => setGenerateFromDate(event.currentTarget.value)} type="date" value={generateFromDate} />
              </label>
              <label className="stack-field" style={{ minWidth: '11rem' }}>
                <span>To</span>
                <input onChange={(event) => setGenerateToDate(event.currentTarget.value)} type="date" value={generateToDate} />
              </label>
              <div className="stack-field">
                <span>Sites</span>
                <div className="inline-row wrap-row">
                  {HELIOS_PENDING_PURCHASE_SITE_DEALERS.map((dealer) => (
                    <label className="inline-row" key={dealer.dealerId} style={{ gap: '0.35rem' }}>
                      <input
                        checked={generateSiteDealerIds.includes(dealer.dealerId)}
                        onChange={() => toggleGenerateSiteDealer(dealer.dealerId)}
                        type="checkbox"
                      />
                      <span>{dealer.siteLabel}</span>
                    </label>
                  ))}
                </div>
              </div>
              <button
                className="primary-button"
                disabled={isGenerating || generateSiteDealerIds.length === 0}
                onClick={() => void handleGenerate()}
                type="button"
              >
                {isGenerating ? 'Generating live packet…' : 'Generate live packet'}
              </button>
            </div>
          </article>

          <article className="mini-card" style={{ marginBottom: '1rem' }}>
            <header>
              <strong>Import pending-purchase packet</strong>
              <Pill tone="warning">admin</Pill>
            </header>
            <p className="subtle-copy">
              Keep the legacy JSON import path as a fallback when you need to replay an existing packet or compare against older generated artifacts.
            </p>
            <div className="filter-row">
              <input
                onChange={(event) => setImportFilePath(event.currentTarget.value)}
                placeholder="/absolute/path/to/pending_catalog_update_candidates.json"
                value={importFilePath}
              />
              <button
                className="primary-button"
                disabled={isImporting || importFilePath.trim().length === 0}
                onClick={() => void handleImport()}
                type="button"
              >
                {isImporting ? 'Importing packet…' : 'Import packet'}
              </button>
            </div>
          </article>
        </>
      ) : null}
      {canApprove && data.activePacket ? (
        <article className="mini-card" style={{ marginBottom: '1rem' }}>
          <header>
            <strong>Approve and queue apply</strong>
            <Pill tone="success">approver</Pill>
          </header>
          <p className="subtle-copy">
            Approval is the V1 gate to live execution. Select approved rows here to queue the worker-driven catalog-side apply pass without writing to Sweed from the UI.
          </p>
          <div className="inline-row wrap-row">
            <Pill tone="muted">{`${approvedVisibleRows.length} approved visible`}</Pill>
            <Pill tone="muted">{`${selectedApprovedRowIds.length} selected`}</Pill>
            <button className="ghost-button" onClick={() => setSelectedRowIds(approvedVisibleRows.map((item) => item.rowId))} type="button">
              Select approved visible rows
            </button>
            <button className="ghost-button" onClick={() => setSelectedRowIds([])} type="button">
              Clear selection
            </button>
            <button
              className="primary-button"
              disabled={isApplying || selectedApprovedRowIds.length === 0}
              onClick={() => void handleApplySelectedRows()}
              type="button"
            >
              {isApplying ? 'Applying approved rows…' : 'Queue apply for selected rows'}
            </button>
          </div>
        </article>
      ) : null}
      {data.items.length === 0 ? (
        <p className="empty-state">No rows match the current filters.</p>
      ) : (
        <div className="pending-purchase-layout">
          <aside className="pending-purchase-sidebar">
            <p className="sidebar-heading">Packet Hierarchy</p>
            <p className="subtle-copy">Jump by site, catalog lane, or brand before reviewing individual SKUs.</p>
            <div className="pending-purchase-nav-list">
              {hierarchy.map((siteGroup) => (
                <div className="pending-purchase-nav-group" key={siteGroup.id}>
                  <a href={`#${siteGroup.id}`}>{siteGroup.siteLabel}</a>
                  <span className="pending-purchase-nav-count">{siteGroup.rowCount}</span>
                  <div className="pending-purchase-nav-children">
                    {siteGroup.categories.map((categoryGroup) => (
                      <div className="pending-purchase-nav-group" key={categoryGroup.id}>
                        <a href={`#${categoryGroup.id}`}>{categoryGroup.categoryLabel}</a>
                        <span className="pending-purchase-nav-count">{categoryGroup.rowCount}</span>
                        <div className="pending-purchase-nav-children">
                          {categoryGroup.subcategories.map((subcategoryGroup) => (
                            <div className="pending-purchase-nav-group" key={subcategoryGroup.id}>
                              <a href={`#${subcategoryGroup.id}`}>{subcategoryGroup.subcategoryLabel}</a>
                              <span className="pending-purchase-nav-count">{subcategoryGroup.rowCount}</span>
                              <div className="pending-purchase-nav-children">
                                {subcategoryGroup.brands.map((brandGroup) => (
                                  <div className="pending-purchase-nav-group" key={brandGroup.id}>
                                    <a href={`#${brandGroup.id}`}>{brandGroup.brandLabel}</a>
                                    <span className="pending-purchase-nav-count">{brandGroup.rowCount}</span>
                                  </div>
                                ))}
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </aside>

          <div className="pending-purchase-content stacked-list">
            {hierarchy.map((siteGroup) => (
              <details className="pending-purchase-group" id={siteGroup.id} key={siteGroup.id} open>
                <summary className="pending-purchase-summary">
                  <span>
                    <strong>{siteGroup.siteLabel}</strong>
                    <span className="subtle-copy">{`${siteGroup.categories.length} catalog lanes`}</span>
                  </span>
                  <Pill tone="muted">{`${siteGroup.rowCount} rows`}</Pill>
                </summary>
                <div className="pending-purchase-group-body">
                  {siteGroup.categories.map((categoryGroup) => (
                    <details className="pending-purchase-group pending-purchase-group-level-2" id={categoryGroup.id} key={categoryGroup.id} open>
                      <summary className="pending-purchase-summary">
                        <span>
                          <strong>{categoryGroup.categoryLabel}</strong>
                          <span className="subtle-copy">{`${categoryGroup.subcategories.length} sub-lanes`}</span>
                        </span>
                        <Pill tone="muted">{`${categoryGroup.rowCount} rows`}</Pill>
                      </summary>
                      <div className="pending-purchase-group-body">
                        {categoryGroup.subcategories.map((subcategoryGroup) => (
                          <details className="pending-purchase-group pending-purchase-group-level-3" id={subcategoryGroup.id} key={subcategoryGroup.id} open>
                            <summary className="pending-purchase-summary">
                              <span>
                                <strong>{subcategoryGroup.subcategoryLabel}</strong>
                                <span className="subtle-copy">{`${subcategoryGroup.brands.length} brands`}</span>
                              </span>
                              <Pill tone="muted">{`${subcategoryGroup.rowCount} rows`}</Pill>
                            </summary>
                            <div className="pending-purchase-group-body">
                              {subcategoryGroup.brands.map((brandGroup) => (
                                <details className="pending-purchase-group pending-purchase-group-level-4" id={brandGroup.id} key={brandGroup.id} open>
                                  <summary className="pending-purchase-summary">
                                    <span>
                                      <strong>{brandGroup.brandLabel}</strong>
                                      <span className="subtle-copy">{brandGroup.variantNames.join(' · ')}</span>
                                    </span>
                                    <Pill tone="muted">{`${brandGroup.rowCount} rows`}</Pill>
                                  </summary>
                                  <div className="pending-purchase-group-body stacked-list">
                                    {brandGroup.items.map((item) => (
                                      <PendingPurchaseRowCard
                                        canApprove={canApprove}
                                        canEdit={session.permissions.canEditProposals}
                                        isSelected={selectedApprovedRowIds.includes(item.rowId)}
                                        item={item}
                                        key={item.rowId}
                                        onToggleSelected={() => toggleSelectedRow(item.rowId)}
                                      />
                                    ))}
                                  </div>
                                </details>
                              ))}
                            </div>
                          </details>
                        ))}
                      </div>
                    </details>
                  ))}
                </div>
              </details>
            ))}
          </div>
        </div>
      )}
    </section>
  )
}

function PendingPurchaseRowCard(
  {
    canApprove,
    canEdit,
    isSelected,
    item,
    onToggleSelected,
  }: {
    canApprove: boolean
    canEdit: boolean
    isSelected: boolean
    item: PendingPurchaseRow
    onToggleSelected: () => void
  },
) {
  const revalidator = useRevalidator()
  const [draftDescription, setDraftDescription] = useState(item.editedProposedDescription ?? item.proposedDescription ?? '')
  const [draftPrice, setDraftPrice] = useState(readDraftPrice(item))
  const [draftImageUrl, setDraftImageUrl] = useState(item.editedPrimaryImageUrl ?? item.primaryImageUrl ?? '')
  const [draftNotes, setDraftNotes] = useState(item.notes ?? '')
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [isApproving, setIsApproving] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const isApplyLocked = item.lastApplyStatus === 'queued' || item.lastApplyStatus === 'running'
  const editingLocked = item.approvalStatus === 'approved' || isApplyLocked
  const applySummaryText = readLastApplySummaryText(item)
  const verificationSummaryText = readVerificationSummaryText(item)
  const displayedPrice = resolvePendingPurchaseDisplayedPrice(draftPrice, item)
  const priceMarkerLabel = hasPendingPurchaseDraftPriceOverride(draftPrice, item) ? 'Draft' : 'Reviewed'
  const hasPricingLadder = hasPendingPurchasePricingLadder(item, displayedPrice)

  useEffect(() => {
    setDraftDescription(item.editedProposedDescription ?? item.proposedDescription ?? '')
    setDraftPrice(readDraftPrice(item))
    setDraftImageUrl(item.editedPrimaryImageUrl ?? item.primaryImageUrl ?? '')
    setDraftNotes(item.notes ?? '')
  }, [item])

  async function handleSave() {
    if (editingLocked) {
      return
    }

    setIsSaving(true)
    setErrorMessage(null)

    try {
      const parsedPrice = parseDraftPrice(draftPrice)
      const payload = UpdatePendingPurchaseRowRequestSchema.parse({
        editedPrimaryImageUrl: normalizeOptionalString(draftImageUrl),
        editedProposedDescription: normalizeOptionalString(draftDescription),
        editedProposedPrice: parsedPrice,
        expectedVersion: item.version,
        notes: normalizeOptionalString(draftNotes),
      })

      await mutateJson(`/api/catalog/pending-purchases/${item.rowId}`, MutationAcceptedResponseSchema, {
        body: JSON.stringify(payload),
        method: 'PATCH',
      })
      await revalidator.revalidate()
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Could not save the pending-purchase overrides.')
    } finally {
      setIsSaving(false)
    }
  }

  async function handleApprovalChange(approvalStatus: PendingPurchaseRow['approvalStatus']) {
    setIsApproving(true)
    setErrorMessage(null)

    try {
      const payload = UpdatePendingPurchaseRowApprovalRequestSchema.parse({
        approvalStatus,
        expectedVersion: item.version,
      })

      await mutateJson(`/api/catalog/pending-purchases/${item.rowId}/approval`, MutationAcceptedResponseSchema, {
        body: JSON.stringify(payload),
        method: 'POST',
      })
      await revalidator.revalidate()
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Could not update the pending-purchase approval state.')
    } finally {
      setIsApproving(false)
    }
  }

  return (
    <article className="review-card">
      <div className="review-card-header">
        <div>
          <strong>{item.distributorProductName}</strong>
          <p className="subtle-copy">
            {item.siteLabel} · {item.targetBrand ?? 'No brand'} · {item.targetVariantName ?? item.targetGroupName ?? 'No target variant'}
          </p>
          <p className="subtle-copy">
            <Link to={buildHeliosModulePath('catalog', `review-details/pending_purchase_row/${item.rowId}`)}>
              Review details (comments, annotations, re-run, fail)
            </Link>
          </p>
        </div>
        <div className="inline-row wrap-row">
          <Pill tone={approvalTone(item.approvalStatus)}>{item.approvalStatus}</Pill>
          <Pill tone={applyStatusTone(item.lastApplyStatus)}>{item.lastApplyStatus.replaceAll('_', ' ')}</Pill>
          <Pill tone={mappingStatusTone(item.mappingStatus)}>{item.mappingStatus.replaceAll('_', ' ')}</Pill>
          <Pill tone="muted">{`v${item.version}`}</Pill>
        </div>
      </div>

      <div className="comparison-grid">
        <PendingValuePanel label="Current price" value={formatCurrency(item.currentPrice)} />
        <PendingValuePanel label="Imported proposal" value={formatCurrency(item.proposedPrice)} />
        <PendingValuePanel label="Effective proposal" value={formatCurrency(item.effectiveProposedPrice)} />
      </div>

      {hasPricingLadder ? (
        <PendingPurchasePricingLadder
          livePrice={item.currentPrice}
          marketAveragePostTaxPrice={item.averageCompetitorPostTaxPrice}
          marketListings={item.marketListings}
          marketMedianPostTaxPrice={item.marketMedianPostTaxPrice}
          proposedLabel={priceMarkerLabel}
          proposedPrice={displayedPrice}
        />
      ) : null}

      <div className="inline-row wrap-row" style={{ marginBottom: '0.85rem' }}>
        <Pill tone="muted">{item.actionType}</Pill>
        <Pill tone="muted">{item.expectedCategory ?? 'No category'}</Pill>
        <Pill tone="muted">{item.expectedSubcategory ?? 'No subcategory'}</Pill>
        {item.targetSize ? <Pill tone="muted">{item.targetSize}</Pill> : null}
        {item.targetPackCount ? <Pill tone="muted">{`${item.targetPackCount} pack`}</Pill> : null}
        {item.targetPrevalence ? <Pill tone="muted">{item.targetPrevalence}</Pill> : null}
        {item.reviewFlags.map((flag) => (
          <Pill key={flag} tone="warning">{flag}</Pill>
        ))}
      </div>
      {item.approvedByUser ? <p className="subtle-copy">Approved by {item.approvedByUser}</p> : null}
      {applySummaryText ? <p className="subtle-copy">{applySummaryText}</p> : null}
      {verificationSummaryText && verificationSummaryText !== applySummaryText ? <p className="subtle-copy">{verificationSummaryText}</p> : null}
      {item.lastApplyError ? <p className="error-text">{item.lastApplyError}</p> : null}

      <p>{item.catalogAction}</p>
      {item.pricingReason ? <p className="subtle-copy">{item.pricingReason}</p> : null}
      {item.marketAdviceSummary ? <p className="subtle-copy">{item.marketAdviceSummary}</p> : null}
      {formatPendingPurchaseMarketReferenceText(
        item.averageCompetitorPostTaxPrice,
        item.marketMedianPostTaxPrice,
        item.averageCompetitorPrice,
      ) ? (
        <p className="subtle-copy">
          {formatPendingPurchaseMarketReferenceText(
            item.averageCompetitorPostTaxPrice,
            item.marketMedianPostTaxPrice,
            item.averageCompetitorPrice,
          )}
        </p>
      ) : null}
      {item.existingDistributorLinks ? <p className="subtle-copy">Existing distributor links: {item.existingDistributorLinks}</p> : null}
      <p className="subtle-copy">
        Orders: {item.orderIds.join(', ') || '—'} · Positions: {item.positionIds.join(', ') || '—'}
      </p>
      <details>
        <summary>Product hierarchy</summary>
        <div className="pending-purchase-hierarchy-grid">
          <PendingValuePanel label="Brand" value={item.targetBrand ?? '—'} />
          <PendingValuePanel label="Group" value={item.targetGroupName ?? '—'} />
          <PendingValuePanel label="Variant" value={item.targetVariantName ?? '—'} />
          <PendingValuePanel label="Variant tab" value={item.targetVariantTab ?? '—'} />
          <PendingValuePanel label="Category" value={item.expectedCategory ?? '—'} />
          <PendingValuePanel label="Subcategory" value={item.expectedSubcategory ?? '—'} />
          <PendingValuePanel label="Size" value={item.targetSize ?? '—'} />
          <PendingValuePanel label="Pack count" value={item.targetPackCount ? String(item.targetPackCount) : '—'} />
          <PendingValuePanel label="Strain" value={item.targetStrain ?? '—'} />
          <PendingValuePanel label="Prevalence" value={item.targetPrevalence ?? '—'} />
          <PendingValuePanel label="Reuse variant" value={item.reuseProductName ?? '—'} />
          <PendingValuePanel label="Reuse product id" value={item.reuseProductId ? String(item.reuseProductId) : '—'} />
        </div>
      </details>
      {(hasPricingLadder || item.marketListings.length > 0 || item.marketNote || item.publicSources.length > 0) ? (
        <details>
          <summary>Pricing support details</summary>
          <div className="pending-purchase-pricing-support">
            <div className="pricing-metric-grid">
              <PendingValuePanel label="Reviewed price" value={formatCurrency(displayedPrice)} />
              <PendingValuePanel label="Current price" value={formatCurrency(item.currentPrice)} />
              <PendingValuePanel label="Market avg" value={formatCurrency(item.averageCompetitorPostTaxPrice)} />
              <PendingValuePanel label="Market median" value={formatCurrency(item.marketMedianPostTaxPrice)} />
            </div>
            {hasPricingLadder ? (
              <PendingPurchasePricingLadder
                livePrice={item.currentPrice}
                marketAveragePostTaxPrice={item.averageCompetitorPostTaxPrice}
                marketListings={item.marketListings}
                marketMedianPostTaxPrice={item.marketMedianPostTaxPrice}
                proposedLabel={priceMarkerLabel}
                proposedPrice={displayedPrice}
              />
            ) : null}
            {item.marketNote ? <p className="subtle-copy">{item.marketNote}</p> : null}
            {item.marketSearchTerm ? <p className="subtle-copy">Lit Alerts search: {item.marketSearchTerm}</p> : null}
            {item.marketListings.length > 0 ? (
              <div>
                <h4 style={{ marginBottom: '0.5rem' }}>Lit Alerts competitor listings</h4>
                <ul className="timeline-list compact-list">
                  {item.marketListings.map((listing, index) => (
                    <li key={buildPendingPurchaseMarketListingKey(listing, index)}>
                      <strong>{listing.dispensaryName}</strong>
                      <div className="subtle-copy">{listing.listingName}</div>
                      <div className="subtle-copy">
                        {formatCurrency(listing.postTaxPrice)} post-tax · {formatCurrency(listing.preTaxPrice)} pre-tax · {formatPendingPurchaseDistanceBandLabel(listing.distanceBand, listing.distanceMiles)} · {listing.source}
                      </div>
                      {!listing.eligibleForPricing && listing.exclusionReason ? <div className="subtle-copy">{listing.exclusionReason}</div> : null}
                      {listing.url ? <a href={listing.url} rel="noreferrer" target="_blank">Open source listing</a> : null}
                    </li>
                  ))}
                </ul>
              </div>
            ) : item.publicSources.length > 0 ? (
              <div>
                <h4 style={{ marginBottom: '0.5rem' }}>Preserved source links</h4>
                <ul className="timeline-list compact-list">
                  {item.publicSources.map((sourceUrl) => (
                    <li key={sourceUrl}>
                      <a href={sourceUrl} rel="noreferrer" target="_blank">{sourceUrl}</a>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        </details>
      ) : null}
      {item.reviewerNotes ? <p className="subtle-copy">Source notes: {item.reviewerNotes}</p> : null}
      {item.suggestionCandidates.length > 0 ? (
        <details>
          <summary>Suggestion candidates</summary>
          <ul>
            {item.suggestionCandidates.map((candidate, index) => (
              <li key={`${candidate.productId ?? candidate.productName ?? 'candidate'}-${index}`}>
                {candidate.productName ?? 'Unnamed product'}
                {candidate.productId ? ` (product ${candidate.productId})` : ''}
                {candidate.score !== null ? ` · score ${candidate.score}` : ''}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      {canApprove && item.approvalStatus === 'approved' && item.lastApplyStatus !== 'applied' ? (
        <label className="inline-row" style={{ gap: '0.5rem', marginBottom: '0.75rem' }}>
          <input checked={isSelected} disabled={isApplyLocked} onChange={onToggleSelected} type="checkbox" />
          <span>Select for the next apply request</span>
        </label>
      ) : null}

      <label className="stack-field">
        <span>Override proposed price</span>
        <input disabled={editingLocked} inputMode="decimal" onChange={(event) => setDraftPrice(event.currentTarget.value)} type="number" value={draftPrice} />
      </label>

      <label className="stack-field">
        <span>Override proposed description</span>
        <textarea disabled={editingLocked} onChange={(event) => setDraftDescription(event.currentTarget.value)} rows={5} value={draftDescription} />
      </label>

      <label className="stack-field">
        <span>Override primary image URL</span>
        <input disabled={editingLocked} onChange={(event) => setDraftImageUrl(event.currentTarget.value)} value={draftImageUrl} />
      </label>

      <label className="stack-field">
        <span>Operator notes override</span>
        <textarea disabled={editingLocked} onChange={(event) => setDraftNotes(event.currentTarget.value)} rows={2} value={draftNotes} />
      </label>
      {editingLocked ? (
        <p className="subtle-copy">
          {isApplyLocked
            ? 'This row is already queued in an apply request. Wait for that request to finish before editing it again.'
            : 'Return this approved row to pending review before editing its overrides.'}
        </p>
      ) : null}

      {item.effectivePrimaryImageUrl ? (
        <p className="subtle-copy">
          Effective image: <a href={item.effectivePrimaryImageUrl} rel="noreferrer" target="_blank">Open image</a>
          {item.primaryImageSource ? ` · ${item.primaryImageSource}` : ''}
        </p>
      ) : null}
      {errorMessage ? <p className="error-text">{errorMessage}</p> : null}

      {canEdit ? (
        <div className="inline-row wrap-row review-actions">
          <button className="primary-button" disabled={isSaving || editingLocked} onClick={() => void handleSave()} type="button">
            {isSaving ? 'Saving…' : 'Save overrides'}
          </button>
        </div>
      ) : null}
      {canApprove ? (
        <div className="inline-row wrap-row review-actions">
          {item.approvalStatus !== 'approved' ? (
            <button className="primary-button" disabled={isApproving || isApplyLocked} onClick={() => void handleApprovalChange('approved')} type="button">
              {isApproving ? 'Updating…' : 'Approve'}
            </button>
          ) : null}
          {item.approvalStatus !== 'rejected' ? (
            <button className="ghost-button" disabled={isApproving || isApplyLocked} onClick={() => void handleApprovalChange('rejected')} type="button">
              Reject
            </button>
          ) : null}
          {item.approvalStatus !== 'pending' ? (
            <button className="ghost-button" disabled={isApproving || isApplyLocked} onClick={() => void handleApprovalChange('pending')} type="button">
              Mark pending
            </button>
          ) : null}
        </div>
      ) : null}
    </article>
  )
}

function PendingValuePanel({ label, value }: { label: string; value: string }) {
  return (
    <div className="value-panel">
      <span>{label}</span>
      <p>{value}</p>
    </div>
  )
}

function PendingPurchaseGenerationStatusPanel({ jobStatus }: { jobStatus: JobStatusResponse }) {
  const packetId = jobStatus.linkedRecords.pendingPurchasePacketId
  const percentComplete = computeJobProgressPercent(jobStatus)
  const inProgress = !isJobTerminal(jobStatus.job.status)

  return (
    <article className="detail-panel job-progress-panel" style={{ marginBottom: '1rem' }}>
      <div className="page-header" style={{ marginBottom: '0.75rem' }}>
        <div>
          <h3 style={{ margin: 0 }}>Live packet generation status</h3>
          <p className="subtle-copy">{readJobProgressMessage(jobStatus)}</p>
        </div>
        <div className="inline-row wrap-row">
          <Pill tone={jobStatusTone(jobStatus.job.status)}>{jobStatus.job.status.replaceAll('_', ' ')}</Pill>
          {jobStatus.progress ? <Pill tone="muted">{jobStatus.progress.phase}</Pill> : null}
        </div>
      </div>

      <div className="job-progress-track" aria-hidden="true">
        <div className={`job-progress-fill${jobStatus.job.status === 'failed' || jobStatus.job.status === 'dead_letter' ? ' failed' : ''}`} style={{ width: `${percentComplete}%` }} />
      </div>

      <div className="pricing-metric-grid" style={{ marginTop: '0.9rem' }}>
        <PendingValuePanel label="Job" value={`#${jobStatus.job.jobId}`} />
        <PendingValuePanel label="Progress" value={readJobProgressSummary(jobStatus)} />
        <PendingValuePanel label="Queued" value={formatTimestamp(jobStatus.job.createdAt)} />
        <PendingValuePanel label="Started" value={formatTimestamp(jobStatus.job.startedAt)} />
      </div>

      <div className="inline-row wrap-row module-card-links" style={{ marginTop: '0.9rem' }}>
        <Link to={`/jobs/${jobStatus.job.jobId}`}>Open job details</Link>
        {packetId ? (
          <Link to={buildHeliosModulePath('catalog', `pending-purchases?packetId=${packetId}`)}>
            Open generated packet
          </Link>
        ) : null}
        <Link to={buildHeliosModulePath('catalog', 'history?sectionLimit=8')}>Open catalog history</Link>
      </div>
      {jobStatus.job.lastError ? <p className="error-text">{jobStatus.job.lastError}</p> : null}
      {inProgress ? <p className="subtle-copy">This card refreshes automatically while the worker is still running.</p> : null}
    </article>
  )
}

function formatCurrency(value: number | null): string {
  return typeof value === 'number' ? `$${value.toFixed(2)}` : '—'
}

function hasPendingPurchasePricingLadder(item: PendingPurchaseRow, displayedPrice: number | null): boolean {
  const ladderPoints = [
    item.currentPrice,
    displayedPrice,
    item.averageCompetitorPostTaxPrice,
    item.marketMedianPostTaxPrice,
    ...item.marketListings.map((listing) => listing.postTaxPrice),
  ].filter((value): value is number => value !== null && Number.isFinite(value))

  return ladderPoints.length > 1
}

function resolvePendingPurchaseDisplayedPrice(draftPrice: string, item: PendingPurchaseRow): number | null {
  return readNumericDraftPrice(draftPrice) ?? item.effectiveProposedPrice
}

function hasPendingPurchaseDraftPriceOverride(draftPrice: string, item: PendingPurchaseRow): boolean {
  const draftedPrice = readNumericDraftPrice(draftPrice)
  if (draftedPrice === null) {
    return false
  }

  const persistedPrice = item.effectiveProposedPrice
  if (persistedPrice === null) {
    return true
  }

  return Math.abs(draftedPrice - persistedPrice) >= 0.005
}

function readNumericDraftPrice(value: string): number | null {
  if (value.trim().length === 0) {
    return null
  }

  const parsed = Number(value)
  if (!Number.isFinite(parsed)) {
    return null
  }

  return Math.round((parsed + Number.EPSILON) * 100) / 100
}

function PendingPurchasePricingLadder(input: {
  livePrice: number | null
  marketAveragePostTaxPrice: number | null
  marketListings: PendingPurchaseMarketListing[]
  marketMedianPostTaxPrice: number | null
  proposedLabel: string
  proposedPrice: number | null
}) {
  const points = [
    input.livePrice,
    input.proposedPrice,
    input.marketAveragePostTaxPrice,
    input.marketMedianPostTaxPrice,
    ...input.marketListings.map((listing) => listing.postTaxPrice),
  ].filter((value): value is number => value !== null && Number.isFinite(value))

  if (points.length < 2) {
    return null
  }

  const minimumPoint = Math.min(...points)
  const maximumPoint = Math.max(...points)
  const padding = Math.max((maximumPoint - minimumPoint) * 0.12, 1)
  const scaleMinimum = Math.max(0, minimumPoint - padding)
  const scaleMaximum = maximumPoint + padding
  const bandSummary = summarizePendingPurchaseListingBands(input.marketListings)

  return (
    <div className="pricing-ladder-card">
      <div className="inline-row wrap-row" style={{ justifyContent: 'space-between', marginBottom: '0.6rem' }}>
        <strong>Price ladder</strong>
        <span className="subtle-copy">{formatCurrency(scaleMinimum)} to {formatCurrency(scaleMaximum)}</span>
      </div>
      <div className="pricing-ladder-track">
        {input.marketListings.map((listing, index) => (
          <span
            className={`pricing-ladder-dot band-${listing.distanceBand}${listing.eligibleForPricing ? '' : ' is-excluded'}`}
            key={buildPendingPurchaseMarketListingKey(listing, index)}
            style={{ left: `${toPendingPurchaseLadderPercent(listing.postTaxPrice, scaleMinimum, scaleMaximum)}%`, opacity: pendingPurchaseListingOpacity(listing) }}
            title={buildPendingPurchaseMarketTooltip(listing)}
          />
        ))}
        {input.marketAveragePostTaxPrice !== null ? (
          <span className="pricing-ladder-marker average" style={{ left: `${toPendingPurchaseLadderPercent(input.marketAveragePostTaxPrice, scaleMinimum, scaleMaximum)}%` }}>
            <span>Market avg</span>
          </span>
        ) : null}
        {input.marketMedianPostTaxPrice !== null ? (
          <span className="pricing-ladder-marker median" style={{ left: `${toPendingPurchaseLadderPercent(input.marketMedianPostTaxPrice, scaleMinimum, scaleMaximum)}%` }}>
            <span>Market median</span>
          </span>
        ) : null}
        {input.livePrice !== null ? (
          <span className="pricing-ladder-marker live" style={{ left: `${toPendingPurchaseLadderPercent(input.livePrice, scaleMinimum, scaleMaximum)}%` }}>
            <span>Current</span>
          </span>
        ) : null}
        {input.proposedPrice !== null ? (
          <span className="pricing-ladder-marker proposed" style={{ left: `${toPendingPurchaseLadderPercent(input.proposedPrice, scaleMinimum, scaleMaximum)}%` }}>
            <span>{input.proposedLabel}</span>
          </span>
        ) : null}
      </div>
      <div className="pricing-ladder-legend">
        <span><i className="legend-swatch band-near" />Near</span>
        <span><i className="legend-swatch band-mid" />Mid</span>
        <span><i className="legend-swatch band-far" />Far</span>
        <span><i className="legend-swatch band-very_far" />Very far</span>
        <span><i className="legend-swatch marker-median" />Market median</span>
        <span><i className="legend-swatch marker-live" />Current</span>
        <span><i className="legend-swatch marker-proposed" />Reviewed</span>
      </div>
      {bandSummary ? <p className="subtle-copy" style={{ marginTop: '0.6rem' }}>{bandSummary}</p> : null}
    </div>
  )
}

function formatPendingPurchaseMarketReferenceText(
  averagePostTaxPrice: number | null,
  medianPostTaxPrice: number | null,
  averagePreTaxPrice: number | null,
): string | null {
  const parts = [
    averagePostTaxPrice === null ? null : `avg ${formatCurrency(averagePostTaxPrice)} post-tax`,
    medianPostTaxPrice === null ? null : `median ${formatCurrency(medianPostTaxPrice)}`,
    averagePreTaxPrice === null ? null : `${formatCurrency(averagePreTaxPrice)} pre-tax`,
  ].filter((value): value is string => value !== null)

  return parts.length > 0 ? `Lit Alerts market: ${parts.join(' · ')}` : null
}

function toPendingPurchaseLadderPercent(value: number, minimum: number, maximum: number): number {
  if (maximum <= minimum) {
    return 50
  }

  return ((value - minimum) / (maximum - minimum)) * 100
}

function pendingPurchaseListingOpacity(listing: PendingPurchaseMarketListing): number {
  const baseOpacity = (() => {
    switch (listing.distanceBand) {
      case 'near':
        return 1
      case 'mid':
        return 0.76
      case 'far':
        return 0.42
      case 'very_far':
        return listing.distanceMiles === null ? 0.32 : Math.max(0.18, 0.42 - Math.max(0, listing.distanceMiles - 10) * 0.01)
      default:
        return 0.28
    }
  })()

  return listing.eligibleForPricing ? baseOpacity : Math.max(0.18, baseOpacity * 0.75)
}

function summarizePendingPurchaseListingBands(listings: PendingPurchaseMarketListing[]): string | null {
  if (listings.length === 0) {
    return null
  }

  const summary = listings.reduce<Record<PendingPurchaseMarketListing['distanceBand'], number>>(
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

  return parts.length > 0 ? `Displayed competitor pool: ${parts.join(', ')}.` : null
}

function buildPendingPurchaseMarketTooltip(listing: PendingPurchaseMarketListing): string {
  const exclusionText = !listing.eligibleForPricing && listing.exclusionReason ? ` · ${listing.exclusionReason}` : ''
  return `${listing.dispensaryName} · ${formatCurrency(listing.postTaxPrice)} · ${formatPendingPurchaseDistanceBandLabel(listing.distanceBand, listing.distanceMiles)}${exclusionText}`
}

function buildPendingPurchaseMarketListingKey(listing: PendingPurchaseMarketListing, index: number): string {
  return `${listing.dispensaryName}-${listing.listingName}-${listing.source}-${index}`
}

function formatPendingPurchaseDistanceBandLabel(
  distanceBand: PendingPurchaseMarketListing['distanceBand'],
  distanceMiles: number | null,
): string {
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

function jobStatusTone(status: JobStatusResponse['job']['status']): 'danger' | 'muted' | 'success' | 'warning' {
  switch (status) {
    case 'succeeded':
      return 'success'
    case 'failed':
    case 'dead_letter':
      return 'danger'
    case 'queued':
    case 'running':
      return 'warning'
    default:
      return 'muted'
  }
}

function computeJobProgressPercent(jobStatus: JobStatusResponse): number {
  if (jobStatus.job.status === 'succeeded') {
    return 100
  }
  if (jobStatus.job.status === 'failed' || jobStatus.job.status === 'dead_letter') {
    return Math.max(10, computeJobProgressPercentFromStages(jobStatus.progress))
  }
  return computeJobProgressPercentFromStages(jobStatus.progress)
}

function computeJobProgressPercentFromStages(progress: JobStatusResponse['progress']): number {
  if (!progress) {
    return 12
  }

  const phaseOffset = (progress.phaseIndex - 1) / progress.phaseCount
  const phaseFraction = progress.total && progress.completed !== null
    ? Math.min(progress.completed / progress.total, 1)
    : 0.35
  return Math.max(5, Math.min(99, Math.round((phaseOffset + (phaseFraction / progress.phaseCount)) * 100)))
}

function readJobProgressMessage(jobStatus: JobStatusResponse): string {
  if (jobStatus.progress?.message) {
    return jobStatus.progress.message
  }
  switch (jobStatus.job.status) {
    case 'queued':
      return 'Queued and waiting for a worker to pick up the live packet generation job.'
    case 'running':
      return 'The live packet generation job is running now.'
    case 'succeeded':
      return 'The live packet generation job finished successfully.'
    case 'failed':
    case 'dead_letter':
      return jobStatus.job.lastError ?? 'The live packet generation job failed.'
    default:
      return 'Job status unavailable.'
  }
}

function readJobProgressSummary(jobStatus: JobStatusResponse): string {
  if (jobStatus.progress?.total && jobStatus.progress.completed !== null) {
    return `${jobStatus.progress.completed} / ${jobStatus.progress.total}`
  }
  if (jobStatus.progress) {
    return `Phase ${jobStatus.progress.phaseIndex} of ${jobStatus.progress.phaseCount}`
  }
  return jobStatus.job.status.replaceAll('_', ' ')
}

function formatTimestamp(value: string | null): string {
  return value ? new Date(value).toLocaleString() : '—'
}

function mappingStatusTone(status: PendingPurchaseRow['mappingStatus']): 'muted' | 'success' | 'warning' {
  switch (status) {
    case 'mapped_variant_ready_for_link':
      return 'success'
    case 'needs_catalog_create':
      return 'warning'
    default:
      return 'muted'
  }
}

function approvalTone(status: PendingPurchaseRow['approvalStatus']): 'muted' | 'success' | 'warning' {
  switch (status) {
    case 'approved':
      return 'success'
    case 'rejected':
      return 'warning'
    default:
      return 'muted'
  }
}

function applyRequestTone(status: NonNullable<PendingPurchaseListResponse['latestApplyRequest']>['status']): 'muted' | 'success' | 'warning' {
  switch (status) {
    case 'succeeded':
      return 'success'
    case 'partially_succeeded':
    case 'blocked':
      return 'warning'
    default:
      return 'muted'
  }
}

function applyStatusTone(status: PendingPurchaseRow['lastApplyStatus']): 'muted' | 'success' | 'warning' {
  switch (status) {
    case 'applied':
      return 'success'
    case 'failed':
    case 'blocked':
      return 'warning'
    default:
      return 'muted'
  }
}

function readLastApplySummaryText(item: PendingPurchaseRow): string | null {
  if (!item.lastApplySummary || typeof item.lastApplySummary !== 'object' || Array.isArray(item.lastApplySummary)) {
    return null
  }

  const summaryText = item.lastApplySummary.summaryText
  return typeof summaryText === 'string' && summaryText.trim().length > 0 ? summaryText : null
}

function readVerificationSummaryText(item: PendingPurchaseRow): string | null {
  if (!item.lastApplySummary || typeof item.lastApplySummary !== 'object' || Array.isArray(item.lastApplySummary)) {
    return null
  }

  const verification = item.lastApplySummary.verification
  if (!verification || typeof verification !== 'object' || Array.isArray(verification)) {
    return null
  }

  const summaryText = verification.summaryText
  return typeof summaryText === 'string' && summaryText.trim().length > 0 ? summaryText : null
}

function normalizeOptionalString(value: string): string | null {
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function parseDraftPrice(value: string): number | null {
  if (value.trim().length === 0) {
    return null
  }

  const parsed = Number(value)
  if (!Number.isFinite(parsed)) {
    throw new Error('Price overrides must be numeric.')
  }

  return Math.round((parsed + Number.EPSILON) * 100) / 100
}

function readDraftPrice(item: PendingPurchaseRow): string {
  if (typeof item.editedProposedPrice === 'number') {
    return String(item.editedProposedPrice)
  }
  if (typeof item.proposedPrice === 'number') {
    return String(item.proposedPrice)
  }
  return ''
}

interface PendingPurchaseBrandGroup {
  brandLabel: string
  id: string
  items: PendingPurchaseRow[]
  rowCount: number
  variantNames: string[]
}

interface PendingPurchaseSubcategoryGroup {
  brands: PendingPurchaseBrandGroup[]
  id: string
  rowCount: number
  subcategoryLabel: string
}

interface PendingPurchaseCategoryGroup {
  categoryLabel: string
  id: string
  rowCount: number
  subcategories: PendingPurchaseSubcategoryGroup[]
}

interface PendingPurchaseSiteGroup {
  categories: PendingPurchaseCategoryGroup[]
  id: string
  rowCount: number
  siteLabel: string
}

function buildPendingPurchaseHierarchy(items: PendingPurchaseRow[]): PendingPurchaseSiteGroup[] {
  const siteMap = new Map<string, Map<string, Map<string, Map<string, PendingPurchaseRow[]>>>>()

  for (const item of items) {
    const siteLabel = item.siteLabel
    const categoryLabel = item.expectedCategory ?? 'Unassigned category'
    const subcategoryLabel = item.expectedSubcategory ?? 'No subcategory'
    const brandLabel = item.targetBrand ?? 'No brand'

    const categoryMap = siteMap.get(siteLabel) ?? new Map<string, Map<string, Map<string, PendingPurchaseRow[]>>>()
    const subcategoryMap = categoryMap.get(categoryLabel) ?? new Map<string, Map<string, PendingPurchaseRow[]>>()
    const brandMap = subcategoryMap.get(subcategoryLabel) ?? new Map<string, PendingPurchaseRow[]>()
    const brandItems = brandMap.get(brandLabel) ?? []

    brandItems.push(item)
    brandMap.set(brandLabel, brandItems)
    subcategoryMap.set(subcategoryLabel, brandMap)
    categoryMap.set(categoryLabel, subcategoryMap)
    siteMap.set(siteLabel, categoryMap)
  }

  return [...siteMap.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([siteLabel, categoryMap]) => {
      const categories = [...categoryMap.entries()]
        .sort(([left], [right]) => compareHierarchyLabels(left, right))
        .map(([categoryLabel, subcategoryMap]) => {
          const subcategories = [...subcategoryMap.entries()]
            .sort(([left], [right]) => compareHierarchyLabels(left, right))
            .map(([subcategoryLabel, brandMap]) => {
              const brands = [...brandMap.entries()]
                .sort(([left], [right]) => compareHierarchyLabels(left, right))
                .map(([brandLabel, brandItems]) => {
                  const variantNames = [...new Set(brandItems.map((item) => item.targetVariantName ?? item.distributorProductName))]
                  return {
                    brandLabel,
                    id: buildHierarchyId(siteLabel, categoryLabel, subcategoryLabel, brandLabel),
                    items: brandItems,
                    rowCount: brandItems.length,
                    variantNames: (variantNames.length > 0 ? variantNames : ['Review rows']).slice(0, 3),
                  }
                })

              return {
                brands,
                id: buildHierarchyId(siteLabel, categoryLabel, subcategoryLabel),
                rowCount: brands.reduce((total, brand) => total + brand.rowCount, 0),
                subcategoryLabel,
              }
            })

          return {
            categoryLabel,
            id: buildHierarchyId(siteLabel, categoryLabel),
            rowCount: subcategories.reduce((total, subcategory) => total + subcategory.rowCount, 0),
            subcategories,
          }
        })

      return {
        categories,
        id: buildHierarchyId(siteLabel),
        rowCount: categories.reduce((total, category) => total + category.rowCount, 0),
        siteLabel,
      }
    })
}

function buildHierarchyId(...parts: string[]): string {
  return parts.map((part) => slugify(part)).join('-')
}

function compareHierarchyLabels(left: string, right: string): number {
  const leftRank = left.startsWith('Unassigned') || left.startsWith('No ') ? 1 : 0
  const rightRank = right.startsWith('Unassigned') || right.startsWith('No ') ? 1 : 0
  if (leftRank !== rightRank) {
    return leftRank - rightRank
  }
  return left.localeCompare(right)
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function defaultGenerateFromDate(): string {
  const now = new Date()
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString().slice(0, 10)
}

function defaultGenerateToDate(): string {
  return new Date().toISOString().slice(0, 10)
}
