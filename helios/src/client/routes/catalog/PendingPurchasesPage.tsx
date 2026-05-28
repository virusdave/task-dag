import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
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
  type PendingPurchasePacketListItem,
  type PendingPurchaseRow,
  type SessionEnvelope,
} from '../../../shared/contracts/index.js'
import { loadJson, mutateJson } from '../../app/fetchJson.js'
import { isJobTerminal, loadJobStatus, waitForJob } from '../../app/jobPolling.js'
import { CanonicalPricingLadder } from '../../components/CanonicalPricingLadder.js'
import {
  CanonicalProductRow,
  StructuredOverrideField,
  areStructuredOverridesEqual,
  buildStructuredOverridePayload,
  effectiveStructured,
  effectiveStructuredPackCount,
  hasStructuredOverride,
  readInitialDraftStructured,
  type StructuredOverrideKey,
} from '../../components/canonicalProductRow/index.js'
import { Pill } from '../../components/Pill.js'
import type { TreeNavNode } from '../../components/TreeNav.js'
import { type CompetitorListing } from '../../../shared/ui/pricing-ladder/index.js'
import { calculateGmPercent, PRICING_GM_FORMULA } from '../../../shared/domain/pricingGeneration.js'
import { useRegisterCatalogSidebarSubtree } from './catalogSidebarSubtree.js'

export async function pendingPurchasesLoader({ request }: { request: Request }) {
  const url = new URL(request.url)
  return loadJson(`/api/catalog/pending-purchases${url.search}`, PendingPurchaseListResponseSchema)
}

// Issue #35 — family-grouped pending-purchase rows.
//
// A "family" is the (brand × category × subcategory × size) tuple
// /catalog/review uses as its grouping unit. We use the EFFECTIVE
// values (reviewer override ?? parser value) so a row regroups
// under the corrected family the moment the reviewer fixes a
// mis-parsed brand or size — matching what apply will actually
// write. Empty string is the placeholder for an unknown field;
// it sorts before populated values so unattributed rows surface
// at the top of the queue.
// Family-level bulk price set (Issue follow-up: "set the price on an
// entire variant brand family at once"). Each row registers its
// `setDraftPrice` setter into this registry on mount and unregisters
// on unmount. The family-header bulk-set widget iterates over the
// row IDs in its group and applies the same draft price string to
// each, so the reviewer can set/snap a whole brand-family in one
// click and then fine-tune individual rows from there.
//
// Locked rows (approved or apply-queued) intentionally do NOT register
// — bulk-set silently skips them, matching the per-row override input
// which is disabled in those states.
interface PendingPurchaseDraftPriceRegistry {
  register(rowId: number, setDraftPrice: (price: string) => void): () => void
  setForRows(rowIds: readonly number[], price: string): number
}

const PendingPurchaseDraftPriceRegistryContext =
  createContext<PendingPurchaseDraftPriceRegistry | null>(null)

function usePendingPurchaseDraftPriceRegistry(): PendingPurchaseDraftPriceRegistry {
  const settersRef = useRef(new Map<number, (price: string) => void>())
  return useMemo<PendingPurchaseDraftPriceRegistry>(
    () => ({
      register(rowId, setDraftPrice) {
        settersRef.current.set(rowId, setDraftPrice)
        return () => {
          // Only delete if it's still the same setter — guards against
          // a stale cleanup deleting a fresh registration if the row
          // remounts with the same ID.
          if (settersRef.current.get(rowId) === setDraftPrice) {
            settersRef.current.delete(rowId)
          }
        }
      },
      setForRows(rowIds, price) {
        let applied = 0
        for (const rowId of rowIds) {
          const setter = settersRef.current.get(rowId)
          if (setter) {
            setter(price)
            applied += 1
          }
        }
        return applied
      },
    }),
    [],
  )
}

interface FamilyKey {
  brand: string
  category: string
  subcategory: string
  size: string
}

interface FamilyGroup {
  familyKey: FamilyKey
  familyKeyString: string
  familyLabel: string
  rows: PendingPurchaseRow[]
}

function resolveEffectiveFamilyKey(item: PendingPurchaseRow): FamilyKey {
  const o = item.editedStructuredFields ?? null
  const pick = (override: string | null | undefined, parsed: string | null): string => {
    // `null` override = explicit clear; `undefined` = no override.
    if (override === null) return ''
    if (override === undefined) return (parsed ?? '').trim()
    return override.trim()
  }
  return {
    brand: pick(o?.targetBrand, item.targetBrand),
    category: pick(o?.expectedCategory, item.expectedCategory),
    subcategory: pick(o?.expectedSubcategory, item.expectedSubcategory),
    size: pick(o?.targetSize, item.targetSize),
  }
}

function buildFamilyKeyString(key: FamilyKey): string {
  return [key.brand || '∅', key.category || '∅', key.subcategory || '∅', key.size || '∅'].join('|')
}

function buildFamilyLabel(key: FamilyKey): string {
  const parts = [key.brand, key.category, key.subcategory, key.size].filter(
    (v): v is string => !!v && v.length > 0,
  )
  return parts.length > 0 ? parts.join(' · ') : 'Unattributed family'
}

function buildFamilyGroups(items: readonly PendingPurchaseRow[]): FamilyGroup[] {
  const groups = new Map<string, FamilyGroup>()
  for (const item of items) {
    const familyKey = resolveEffectiveFamilyKey(item)
    const familyKeyString = buildFamilyKeyString(familyKey)
    const existing = groups.get(familyKeyString)
    if (existing) {
      existing.rows.push(item)
    } else {
      groups.set(familyKeyString, {
        familyKey,
        familyKeyString,
        familyLabel: buildFamilyLabel(familyKey),
        rows: [item],
      })
    }
  }
  // Sort: unattributed (empty brand) first so they don't get buried,
  // then alphabetical by familyLabel for stable, scannable ordering.
  return [...groups.values()].sort((a, b) => {
    const aEmpty = a.familyKey.brand === '' ? 0 : 1
    const bEmpty = b.familyKey.brand === '' ? 0 : 1
    if (aEmpty !== bEmpty) return aEmpty - bEmpty
    return a.familyLabel.localeCompare(b.familyLabel)
  })
}
export function PendingPurchasesPage() {
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
  const isAdmin = session.user?.role === 'admin'
  const mode = data.mode
  const filters = data.filters

  // Keep the sidebar-subtree registration but as a leaf only; the deep
  // packet/site/category/brand hierarchy that used to live in the catalog
  // sidebar has been removed in the redesign — the reviewer scrolls and
  // filters in-page now instead of jumping via a sidebar tree.
  useRegisterCatalogSidebarSubtree(undefined)

  // Selection housekeeping: drop any selected row that's no longer visible
  // in the current row page (filter change, packet switch, pagination).
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

  const approvedVisibleRows = useMemo(
    () => data.items.filter((item) => item.approvalStatus === 'approved' && item.lastApplyStatus !== 'applied'),
    [data.items],
  )

  const selectedApprovedRowIds = useMemo(
    () => selectedRowIds.filter((rowId) => approvedVisibleRows.some((item) => item.rowId === rowId)),
    [approvedVisibleRows, selectedRowIds],
  )

  // Family grouping for rows mode (issue #35): group rows by
  // (brand × category × subcategory × size) — the same family-key
  // shape /catalog/review uses. The reviewer can scan all rows for
  // "Cookies · flower · indica · 3.5g" in one panel rather than
  // hunting them across the per-site site-label sections. Each row
  // card still carries its own site-label chip so per-distributor
  // context isn't lost. Replaces the prior site-only grouping.
  //
  // Effective values are used (override-when-present ?? parsed) so a
  // reviewer-corrected row regroups under the corrected family
  // immediately, matching what apply will actually write.
  const rowsByFamily = useMemo(() => buildFamilyGroups(data.items), [data.items])

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

  const packetsHref = buildPendingPurchasesHref(filters, { mode: 'packets', packetId: null, page: 1 })
  const rowsHref = data.activePacket
    ? buildPendingPurchasesHref(filters, { mode: 'rows', packetId: data.activePacket.packetId, page: 1 })
    : null

  const totalLabel = mode === 'packets'
    ? `${data.totalCount} packet${data.totalCount === 1 ? '' : 's'}`
    : `${data.totalCount} row${data.totalCount === 1 ? '' : 's'}`

  return (
    <section className="pending-purchases-page">
      {/* Reviewer-first chrome: tight title, the canonical answer (packets
          archive or rows for a packet) is the only thing prominent at the
          top. Generation / import / job status / methodology all live in
          the collapsed "Admin & methodology" block at the bottom. */}
      <header className="pp-header">
        <div>
          <p className="eyebrow">Catalog</p>
          <h2 className="pp-title">Pending purchases</h2>
        </div>
        <div className="pp-header-meta inline-row wrap-row">
          <span className="subtle-copy">{totalLabel}</span>
          {generationJobStatus && !isJobTerminal(generationJobStatus.job.status) ? (
            <Pill tone="warning">
              {`Generation ${generationJobStatus.job.status.replaceAll('_', ' ')}`}
            </Pill>
          ) : null}
          {isAdmin ? <a className="ghost-button" href="#pp-admin">Admin</a> : null}
        </div>
      </header>

      <nav className="pp-mode-tabs" aria-label="Pending purchases view">
        <Link
          className={`pp-mode-tab ${mode === 'packets' ? 'pp-mode-tab-active' : ''}`}
          to={packetsHref}
        >
          Packets
        </Link>
        {rowsHref ? (
          <Link
            className={`pp-mode-tab ${mode === 'rows' ? 'pp-mode-tab-active' : ''}`}
            to={rowsHref}
          >
            Rows
            {data.activePacket ? <span className="pp-mode-tab-meta">{` · packet #${data.activePacket.packetId}`}</span> : null}
          </Link>
        ) : (
          <span className="pp-mode-tab pp-mode-tab-disabled" title="Open a packet to review rows">Rows</span>
        )}
      </nav>

      {applySuccessMessage ? <p className="pp-toast pp-toast-success">{applySuccessMessage}</p> : null}
      {generateSuccessMessage ? <p className="pp-toast pp-toast-success">{generateSuccessMessage}</p> : null}
      {importSuccessMessage ? <p className="pp-toast pp-toast-success">{importSuccessMessage}</p> : null}
      {errorMessage ? <p className="pp-toast pp-toast-error">{errorMessage}</p> : null}

      {mode === 'packets' ? (
        <PendingPurchasesPacketsView
          data={data}
        />
      ) : (
        <PendingPurchasesRowsView
          canApprove={canApprove}
          canEdit={session.permissions.canEditProposals}
          data={data}
          isApplying={isApplying}
          onClearSelection={() => setSelectedRowIds([])}
          onQueueApply={() => void handleApplySelectedRows()}
          onSelectApprovedVisible={() => setSelectedRowIds(approvedVisibleRows.map((item) => item.rowId))}
          onToggleSelected={toggleSelectedRow}
          rowsByFamily={rowsByFamily}
          approvedVisibleRowCount={approvedVisibleRows.length}
          selectedApprovedRowIds={selectedApprovedRowIds}
          selectedRowIds={selectedRowIds}
        />
      )}

      <details className="pp-admin-details" id="pp-admin">
        <summary>Admin &amp; methodology</summary>
        <div className="pp-admin-body stacked-list">
          <p className="subtle-copy">
            Helios stores operator edits here first so the later apply path stays asynchronous, audited, and worker-driven. This page is the service-backed replacement for the older packet review HTMLs. Generate or import a packet to populate the archive above; queue apply from inside a packet's row review.
          </p>

          {generationJobStatus ? (
            <PendingPurchaseGenerationStatusPanel jobStatus={generationJobStatus} />
          ) : null}

          {data.latestApplyRequest ? (
            <article className="mini-card">
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

          {data.activePacket ? (
            <article className="mini-card">
              <header>
                <strong>{data.activePacket.packetTitle}</strong>
                <div className="inline-row wrap-row">
                  {/*
                    A non-terminal generation job means this active
                    packet is about to be superseded by the in-flight
                    generation. Surface that loudly so the green
                    'ready' / 'live' pill doesn't read as 'fresh'.
                    The full generation progress panel above (when
                    expanded) still carries the detail; this is the
                    at-a-glance flag on the packet itself.
                  */}
                  {generationJobStatus && !isJobTerminal(generationJobStatus.job.status) ? (
                    <Pill tone="warning">{`regenerating · ${generationJobStatus.job.status.replaceAll('_', ' ')}`}</Pill>
                  ) : null}
                  <Pill tone={data.activePacket.status === 'ready' ? 'success' : 'muted'}>{data.activePacket.status}</Pill>
                  <Pill tone="muted">{`${data.activePacket.rowCount} rows`}</Pill>
                  {/*
                    Source ('generated' vs 'import') is metadata, not a
                    status — render it muted so it doesn't look like a
                    green 'all good' badge.
                  */}
                  <Pill tone="muted">{`source: ${data.activePacket.source}`}</Pill>
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
          ) : null}

          {isAdmin ? (
            <article className="mini-card">
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
          ) : null}

          {isAdmin ? (
            <article className="mini-card">
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
          ) : null}
        </div>
      </details>
    </section>
  )
}

interface PendingPurchasesPacketsViewProps {
  data: PendingPurchaseListResponse
}

function PendingPurchasesPacketsView({ data }: PendingPurchasesPacketsViewProps) {
  const filters = data.filters
  const prevHref = data.page > 1
    ? buildPendingPurchasesHref(filters, { mode: 'packets', page: data.page - 1 })
    : null
  const nextHref = data.hasNextPage
    ? buildPendingPurchasesHref(filters, { mode: 'packets', page: data.page + 1 })
    : null

  return (
    <>
      <PendingPurchasesFilterBar mode="packets" filters={filters} />

      {data.packets.length === 0 ? (
        <p className="empty-state">No packets match the current filters. Generate or import a packet from the admin section below.</p>
      ) : (
        <div className="pp-packet-list">
          {data.packets.map((packet) => (
            <PendingPurchasePacketCard key={packet.packetId} filters={filters} packet={packet} />
          ))}
        </div>
      )}

      <nav className="pp-pager" aria-label="Pagination">
        {prevHref ? <Link className="ghost-button" to={prevHref}>← Previous</Link> : <span />}
        <span className="subtle-copy">Page {data.page}</span>
        {nextHref ? <Link className="ghost-button" to={nextHref}>Next →</Link> : <span />}
      </nav>
    </>
  )
}

interface PendingPurchasesRowsViewProps {
  approvedVisibleRowCount: number
  canApprove: boolean
  canEdit: boolean
  data: PendingPurchaseListResponse
  isApplying: boolean
  onClearSelection: () => void
  onQueueApply: () => void
  onSelectApprovedVisible: () => void
  onToggleSelected: (rowId: number) => void
  rowsByFamily: FamilyGroup[]
  selectedApprovedRowIds: number[]
  selectedRowIds: number[]
}

function PendingPurchasesRowsView({
  approvedVisibleRowCount,
  canApprove,
  canEdit,
  data,
  isApplying,
  onClearSelection,
  onQueueApply,
  onSelectApprovedVisible,
  onToggleSelected,
  rowsByFamily,
  selectedApprovedRowIds,
  selectedRowIds,
}: PendingPurchasesRowsViewProps) {
  const filters = data.filters
  const packetsHref = buildPendingPurchasesHref(filters, { mode: 'packets', packetId: null, page: 1 })
  const activePacket = data.activePacket
  const draftPriceRegistry = usePendingPurchaseDraftPriceRegistry()

  return (
    <PendingPurchaseDraftPriceRegistryContext.Provider value={draftPriceRegistry}>
      <div className="pp-breadcrumb inline-row wrap-row">
        <Link className="ghost-button" to={packetsHref}>← All packets</Link>
        {activePacket ? (
          <span className="subtle-copy">
            Packet #{activePacket.packetId} · {activePacket.packetTitle}
          </span>
        ) : null}
      </div>

      <PendingPurchasesFilterBar mode="rows" filters={filters} />

      {data.items.length === 0 ? (
        <p className="empty-state">No rows in this packet match the current filters.</p>
      ) : (
        <div className="pp-rows-list stacked-list">
          {rowsByFamily.map((group) => (
            <section key={group.familyKeyString} className="pp-rows-family-group">
              <header className="pp-rows-family-header">
                <div className="pp-rows-family-title">
                  <strong>{group.familyLabel}</strong>
                  <Pill tone="muted">{`${group.rows.length} row${group.rows.length === 1 ? '' : 's'}`}</Pill>
                </div>
                {canEdit ? (
                  <FamilyBulkPriceControl
                    rowIds={group.rows.map((row) => row.rowId)}
                  />
                ) : null}
              </header>
              <div className="stacked-list">
                {group.rows.map((item) => (
                  <PendingPurchaseRowCard
                    canApprove={canApprove}
                    canEdit={canEdit}
                    isSelected={selectedApprovedRowIds.includes(item.rowId)}
                    item={item}
                    key={item.rowId}
                    onToggleSelected={() => onToggleSelected(item.rowId)}
                  />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}

      {canApprove && activePacket && (selectedRowIds.length > 0 || approvedVisibleRowCount > 0) ? (
        <div className="pp-apply-bar" role="region" aria-label="Queue apply">
          <div className="inline-row wrap-row pp-apply-bar-meta">
            <Pill tone="muted">{`${approvedVisibleRowCount} approved visible`}</Pill>
            <Pill tone={selectedApprovedRowIds.length > 0 ? 'success' : 'muted'}>{`${selectedApprovedRowIds.length} selected`}</Pill>
          </div>
          <div className="inline-row wrap-row">
            <button className="ghost-button" onClick={onSelectApprovedVisible} type="button">
              Select approved visible
            </button>
            <button className="ghost-button" onClick={onClearSelection} type="button" disabled={selectedRowIds.length === 0}>
              Clear
            </button>
            <button
              className="primary-button"
              disabled={isApplying || selectedApprovedRowIds.length === 0}
              onClick={onQueueApply}
              type="button"
            >
              {isApplying ? 'Applying…' : 'Queue apply'}
            </button>
          </div>
        </div>
      ) : null}
    </PendingPurchaseDraftPriceRegistryContext.Provider>
  )
}

function FamilyBulkPriceControl({ rowIds }: { rowIds: readonly number[] }) {
  const registry = useContext(PendingPurchaseDraftPriceRegistryContext)
  const [value, setValue] = useState('')
  const [feedback, setFeedback] = useState<string | null>(null)

  const apply = useCallback(() => {
    if (!registry) return
    const trimmed = value.trim()
    if (!trimmed) {
      setFeedback('Enter a price first')
      return
    }
    const parsed = Number.parseFloat(trimmed)
    if (!Number.isFinite(parsed) || parsed <= 0) {
      setFeedback('Price must be a positive number')
      return
    }
    // Snap to quarter-dollar to match the ladder & override input step.
    const snapped = Math.round(parsed * 4) / 4
    const applied = registry.setForRows(rowIds, snapped.toFixed(2))
    const skipped = rowIds.length - applied
    setFeedback(
      `Set $${snapped.toFixed(2)} on ${applied} row${applied === 1 ? '' : 's'}` +
        (skipped > 0 ? ` · skipped ${skipped} locked` : ''),
    )
  }, [registry, rowIds, value])

  return (
    <div className="pp-rows-family-bulk-price inline-row wrap-row" style={{ gap: '0.4rem' }}>
      <label className="inline-row" style={{ gap: '0.35rem', alignItems: 'center' }}>
        <span className="subtle-copy">Set whole family →</span>
        <input
          inputMode="decimal"
          min={0}
          onChange={(event) => setValue(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              apply()
            }
          }}
          placeholder="$"
          step={0.25}
          style={{ width: '5.5rem' }}
          type="number"
          value={value}
        />
      </label>
      <button className="ghost-button" onClick={apply} type="button">
        Apply to family
      </button>
      {feedback ? <span className="subtle-copy">{feedback}</span> : null}
    </div>
  )
}

interface PendingPurchasesFilterBarProps {
  filters: PendingPurchaseListResponse['filters']
  mode: 'packets' | 'rows'
}

function PendingPurchasesFilterBar({ filters, mode }: PendingPurchasesFilterBarProps) {
  return (
    <Form className="pp-filter-bar" method="get">
      {/* Preserve mode + packetId across filter changes via hidden inputs.
          Reset to page=1 on any submission (omitted = default 1). */}
      <input type="hidden" name="mode" value={mode} />
      {mode === 'rows' && filters.packetId != null ? (
        <input type="hidden" name="packetId" value={String(filters.packetId)} />
      ) : null}
      <div className="pp-filter-row">
        <input
          className="pp-filter-search"
          defaultValue={filters.search ?? ''}
          name="search"
          placeholder={mode === 'packets' ? 'Search packet title' : 'Search distributor, brand, or target variant'}
        />
        <button className="ghost-button" type="submit">Filter</button>
      </div>
      <details className="pp-filter-advanced" open={hasAdvancedFilters(filters, mode)}>
        <summary>Filters</summary>
        <div className="pp-filter-grid">
          <label className="stack-field">
            <span>Site</span>
            <select defaultValue={filters.siteKey ?? ''} name="siteKey">
              <option value="">All sites</option>
              {HELIOS_PENDING_PURCHASE_SITE_DEALERS.map((dealer) => (
                <option key={dealer.siteKey} value={dealer.siteKey}>{dealer.siteLabel}</option>
              ))}
            </select>
          </label>
          {mode === 'packets' ? (
            <>
              <label className="stack-field">
                <span>Status</span>
                <select defaultValue={filters.status ?? ''} name="status">
                  <option value="">All</option>
                  <option value="ready">Ready (live)</option>
                  <option value="superseded">Superseded</option>
                </select>
              </label>
              <label className="stack-field">
                <span>Source</span>
                <select defaultValue={filters.source ?? ''} name="source">
                  <option value="">All</option>
                  <option value="generated">Generated</option>
                  <option value="import">Imported</option>
                </select>
              </label>
              <label className="stack-field">
                <span>Generated on or after</span>
                <input defaultValue={filters.after ?? ''} name="after" type="date" />
              </label>
              <label className="stack-field">
                <span>Generated on or before</span>
                <input defaultValue={filters.before ?? ''} name="before" type="date" />
              </label>
              <label className="stack-field">
                <span>Per page</span>
                <select defaultValue={String(filters.pageSize)} name="pageSize">
                  <option value="25">25</option>
                  <option value="50">50</option>
                  <option value="100">100</option>
                </select>
              </label>
            </>
          ) : null}
          {mode === 'rows' ? (
            <>
              <label className="stack-field">
                <span>Approval</span>
                <select defaultValue={filters.approvalStatus ?? ''} name="approvalStatus">
                  <option value="">All</option>
                  <option value="pending">Pending</option>
                  <option value="approved">Approved</option>
                  <option value="rejected">Rejected</option>
                </select>
              </label>
              <label className="stack-field">
                <span>Apply</span>
                <select defaultValue={filters.applyStatus ?? ''} name="applyStatus">
                  <option value="">All</option>
                  <option value="not_requested">Not requested</option>
                  <option value="queued">Queued</option>
                  <option value="running">Running</option>
                  <option value="applied">Applied</option>
                  <option value="failed">Failed</option>
                  <option value="blocked">Blocked</option>
                </select>
              </label>
              <label className="stack-field">
                <span>Mapping</span>
                <select defaultValue={filters.mappingStatus ?? ''} name="mappingStatus">
                  <option value="">All</option>
                  <option value="mapped_variant_ready_for_link">Mapped (ready for link)</option>
                  <option value="needs_catalog_create">Needs catalog create</option>
                  <option value="needs_review">Needs review</option>
                </select>
              </label>
              <label className="stack-field">
                <span>Action</span>
                <input defaultValue={filters.actionType ?? ''} name="actionType" placeholder="e.g. price_change" />
              </label>
            </>
          ) : null}
        </div>
        <div className="inline-row wrap-row pp-filter-actions">
          <button className="primary-button" type="submit">Apply filters</button>
          <Link className="ghost-button" to={buildPendingPurchasesHref(
            { actionType: undefined, after: undefined, applyStatus: undefined, approvalStatus: undefined, before: undefined, mappingStatus: undefined, mode: undefined, packetId: undefined, page: 1, pageSize: 25, search: undefined, siteKey: undefined, source: undefined, status: undefined },
            { mode, packetId: mode === 'rows' ? filters.packetId : null, page: 1 },
          )}>Reset</Link>
        </div>
      </details>
    </Form>
  )
}

interface PendingPurchasePacketCardProps {
  filters: PendingPurchaseListResponse['filters']
  packet: PendingPurchasePacketListItem
}

function PendingPurchasePacketCard({ filters, packet }: PendingPurchasePacketCardProps) {
  const openHref = buildPendingPurchasesHref(filters, { mode: 'rows', packetId: packet.packetId, page: 1 })
  const generated = new Date(packet.generatedAt)
  const generatedAbs = generated.toLocaleString()
  const apply = packet.applyCounts
  const approval = packet.approvalCounts
  const inFlightApply = apply.queued + apply.running
  const remainingApply = apply.notRequested + apply.failed + apply.blocked
  const latestApply = packet.latestApplyRequest

  return (
    <article className="pp-packet-card">
      <header className="pp-packet-card-header">
        <div className="pp-packet-card-title">
          <Link to={openHref} className="pp-packet-card-title-link">
            <strong>{packet.packetTitle}</strong>
          </Link>
          <span className="subtle-copy">Packet #{packet.packetId} · generated {generatedAbs}</span>
        </div>
        <div className="inline-row wrap-row pp-packet-card-status">
          <Pill tone={packet.status === 'ready' ? 'success' : 'muted'}>{packet.status === 'ready' ? 'live' : packet.status}</Pill>
          {/*
            Source is metadata, not a status — muted so it doesn't
            look like a green 'all good' badge alongside the actual
            status pill.
          */}
          <Pill tone="muted">{`source: ${packet.source}`}</Pill>
          {packet.siteLabels.map((label) => <Pill key={label} tone="muted">{label}</Pill>)}
        </div>
      </header>
      <div className="pp-packet-card-grid">
        <PendingPurchaseCountStat label="Rows" value={packet.rowCount} />
        <PendingPurchaseCountStat label="Approved" value={approval.approved} tone={approval.approved > 0 ? 'success' : 'muted'} />
        <PendingPurchaseCountStat label="Pending" value={approval.pending} tone={approval.pending > 0 ? 'warning' : 'muted'} />
        <PendingPurchaseCountStat label="Rejected" value={approval.rejected} tone="muted" />
        <PendingPurchaseCountStat label="Applied" value={apply.applied} tone={apply.applied > 0 ? 'success' : 'muted'} />
        <PendingPurchaseCountStat label="In-flight" value={inFlightApply} tone={inFlightApply > 0 ? 'warning' : 'muted'} />
        <PendingPurchaseCountStat label="Not applied" value={remainingApply} tone="muted" />
      </div>
      {latestApply ? (
        <p className="subtle-copy pp-packet-card-apply">
          Latest apply: <Pill tone={applyRequestTone(latestApply.status)}>{latestApply.status.replaceAll('_', ' ')}</Pill>
          {` · ${latestApply.appliedRowCount}/${latestApply.selectedRowCount} applied`}
          {latestApply.requestedByUser ? ` · ${latestApply.requestedByUser}` : ''}
          {latestApply.finishedAt ? ` · finished ${new Date(latestApply.finishedAt).toLocaleString()}` : ''}
        </p>
      ) : null}
      <div className="inline-row wrap-row pp-packet-card-actions">
        <Link className="primary-button" to={openHref}>Review rows</Link>
        {packet.importFileName ? <span className="subtle-copy">{packet.importFileName}</span> : null}
      </div>
    </article>
  )
}

interface PendingPurchaseCountStatProps {
  label: string
  tone?: 'muted' | 'success' | 'warning'
  value: number
}

function PendingPurchaseCountStat({ label, tone = 'muted', value }: PendingPurchaseCountStatProps) {
  const valueColor = tone === 'success'
    ? 'var(--accent-strong, #0a7a35)'
    : tone === 'warning'
      ? 'var(--warning-strong, #b06800)'
      : 'inherit'
  return (
    <div className="pp-count-stat">
      <span className="pp-count-stat-value" style={{ color: valueColor }}>{value}</span>
      <span className="pp-count-stat-label subtle-copy">{label}</span>
    </div>
  )
}

function hasAdvancedFilters(filters: PendingPurchaseListResponse['filters'], mode: 'packets' | 'rows'): boolean {
  if (mode === 'packets') {
    return Boolean(filters.siteKey || filters.status || filters.source || filters.after || filters.before)
  }
  return Boolean(filters.siteKey || filters.approvalStatus || filters.applyStatus || filters.mappingStatus || filters.actionType)
}

function buildPendingPurchasesHref(
  filters: PendingPurchaseListResponse['filters'],
  overrides: Partial<{
    mode: 'packets' | 'rows' | null
    packetId: number | null
    page: number | null
  }> = {},
): string {
  const params = new URLSearchParams()
  const mode = overrides.mode === undefined ? filters.mode : overrides.mode
  if (mode) params.set('mode', mode)
  const packetId = overrides.packetId === undefined ? filters.packetId : overrides.packetId
  if (packetId != null) params.set('packetId', String(packetId))
  if (filters.status) params.set('status', filters.status)
  if (filters.source) params.set('source', filters.source)
  if (filters.siteKey) params.set('siteKey', filters.siteKey)
  if (filters.search) params.set('search', filters.search)
  if (filters.after) params.set('after', filters.after)
  if (filters.before) params.set('before', filters.before)
  if (filters.approvalStatus) params.set('approvalStatus', filters.approvalStatus)
  if (filters.applyStatus) params.set('applyStatus', filters.applyStatus)
  if (filters.mappingStatus) params.set('mappingStatus', filters.mappingStatus)
  if (filters.actionType) params.set('actionType', filters.actionType)
  const page = overrides.page === undefined ? filters.page : overrides.page
  if (page && page > 1) params.set('page', String(page))
  if (filters.pageSize && filters.pageSize !== 25) params.set('pageSize', String(filters.pageSize))
  const query = params.toString()
  return query.length > 0 ? `/catalog/pending-purchases?${query}` : '/catalog/pending-purchases'
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
  // Issue #35: structured-taxonomy overrides drafted by the reviewer.
  // The display value for each field is initialised to the effective
  // value (override-when-present ?? parsed) and the diff against the
  // parsed value is what gets PATCHed back to the server.
  const [draftStructured, setDraftStructured] = useState<Record<StructuredOverrideKey, string>>(
    () => readInitialDraftStructured(item),
  )
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [isApproving, setIsApproving] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  // Collapse-on-decision (issue #35): once the reviewer approves or
  // rejects a row, fold the card down to a one-line summary so they
  // can scroll past 50 finished decisions in a single viewport. The
  // reviewer can still reopen any row with a single click. The local
  // collapsed state is re-seeded from `isFinalized` whenever the row
  // version bumps (i.e. after a server-side state change), so a row
  // that flips back to pending auto-expands and a row that was just
  // approved auto-collapses without the approve handler having to
  // poke a separate setState.
  const isFinalized = item.approvalStatus === 'approved' || item.approvalStatus === 'rejected'
  const [isCollapsed, setIsCollapsed] = useState(isFinalized)
  const isApplyLocked = item.lastApplyStatus === 'queued' || item.lastApplyStatus === 'running'
  const editingLocked = item.approvalStatus === 'approved' || isApplyLocked

  // Register this row's draft-price setter with the family-bulk
  // registry so the family-header's "Apply to family" button can
  // drive every editable row's draft price in one click. Locked
  // rows skip registration so bulk-set never overwrites a queued
  // or approved row's price.
  const draftPriceRegistry = useContext(PendingPurchaseDraftPriceRegistryContext)
  useEffect(() => {
    if (!draftPriceRegistry) return
    if (editingLocked) return
    return draftPriceRegistry.register(item.rowId, setDraftPrice)
  }, [draftPriceRegistry, editingLocked, item.rowId])

  // Refs that remember the most recently-synced server values for each
  // drafted field. The reset effect below uses them to detect whether
  // the reviewer has edited a field since the last sync — if so, the
  // user's draft is preserved across React-Router revalidations.
  //
  // WHY THIS EXISTS (regression discovered May 2026):
  // Previously, the `[item]` reset effect unconditionally re-seeded
  // every draft field on every revalidation. That clobbered any
  // unsaved drafts the moment another card's save triggered a router
  // revalidate — which is exactly the path the "Apply to family" bulk
  // price action hit: row 1 saves, revalidates, and rows 2..N silently
  // lose the bulk-set price they had received seconds earlier. The
  // user observed this as "Apply to family only TRULY applies to the
  // first item in the family." With these refs, drafts persist until
  // the reviewer themselves saves them (which is when handleSave
  // updates the refs).
  const lastSyncedPriceRef = useRef<string>(readDraftPrice(item))
  const lastSyncedDescriptionRef = useRef<string>(item.editedProposedDescription ?? item.proposedDescription ?? '')
  const lastSyncedImageRef = useRef<string>(item.editedPrimaryImageUrl ?? item.primaryImageUrl ?? '')
  const lastSyncedNotesRef = useRef<string>(item.notes ?? '')
  const lastSyncedStructuredRef = useRef<string>(JSON.stringify(readInitialDraftStructured(item)))

  const applySummaryText = readLastApplySummaryText(item)
  const verificationSummaryText = readVerificationSummaryText(item)
  const displayedPrice = resolvePendingPurchaseDisplayedPrice(draftPrice, item)
  const priceMarkerLabel = hasPendingPurchaseDraftPriceOverride(draftPrice, item) ? 'Draft' : 'Reviewed'
  // Live GM% — recomputed from `displayedPrice` (which already reflects
  // the reviewer's draft override) and `effectiveUnitCost` (server-side
  // wholesale unit cost, family-average fallback already applied per
  // pricingGeneration). Reviewers need this to update INSTANTLY as they
  // drag the pricing ladder slider or edit the override price input,
  // not just after a Save round-trip — that's the missing piece called
  // out in the issue.
  const liveGmPercent = calculateGmPercent(item.effectiveUnitCost, displayedPrice)
  const liveGmDisplay = liveGmPercent === null ? '—' : `${liveGmPercent.toFixed(1)}%`
  const liveGmTitle = `${PRICING_GM_FORMULA}` + (
    item.effectiveUnitCost === null
      ? ' · no wholesale cost available'
      : ` · cost ${formatCurrency(item.effectiveUnitCost)}/unit${item.effectiveUnitCostSource ? ` (${item.effectiveUnitCostSource})` : ''}`
  )
  const hasPricingLadder = hasPendingPurchasePricingLadder(item, displayedPrice)

  useEffect(() => {
    // Per-field "preserve user edits across revalidation" pattern.
    // For each drafted field, only re-seed from the server-derived
    // value if the local draft still matches the last-synced server
    // value (i.e. the reviewer didn't touch it since last sync). If
    // it differs, the reviewer has an unsaved edit — keep it.
    //
    // The refs are then updated to the new server-derived values so
    // subsequent revalidations can detect dirtiness against the
    // freshest baseline.
    const nextDescription = item.editedProposedDescription ?? item.proposedDescription ?? ''
    setDraftDescription((current) =>
      current === lastSyncedDescriptionRef.current ? nextDescription : current,
    )
    lastSyncedDescriptionRef.current = nextDescription

    const nextPrice = readDraftPrice(item)
    setDraftPrice((current) =>
      current === lastSyncedPriceRef.current ? nextPrice : current,
    )
    lastSyncedPriceRef.current = nextPrice

    const nextImage = item.editedPrimaryImageUrl ?? item.primaryImageUrl ?? ''
    setDraftImageUrl((current) =>
      current === lastSyncedImageRef.current ? nextImage : current,
    )
    lastSyncedImageRef.current = nextImage

    const nextNotes = item.notes ?? ''
    setDraftNotes((current) =>
      current === lastSyncedNotesRef.current ? nextNotes : current,
    )
    lastSyncedNotesRef.current = nextNotes

    const nextStructured = readInitialDraftStructured(item)
    const nextStructuredJson = JSON.stringify(nextStructured)
    setDraftStructured((current) =>
      JSON.stringify(current) === lastSyncedStructuredRef.current ? nextStructured : current,
    )
    lastSyncedStructuredRef.current = nextStructuredJson

    // Re-sync the collapsed-after-decision state with the freshest
    // approval status. Without this, a row the reviewer manually
    // reopened would stay open after a backend revalidate that
    // didn't change the status, but a server-side flip back to
    // pending wouldn't auto-expand the card.
    setIsCollapsed(item.approvalStatus === 'approved' || item.approvalStatus === 'rejected')
  }, [item])

  async function handleSave() {
    if (editingLocked) {
      return
    }

    setIsSaving(true)
    setErrorMessage(null)

    try {
      const parsedPrice = parseDraftPrice(draftPrice)
      const nextStructured = buildStructuredOverridePayload(item, draftStructured)
      const structuredChanged = !areStructuredOverridesEqual(
        item.editedStructuredFields ?? null,
        nextStructured,
      )
      const payload = UpdatePendingPurchaseRowRequestSchema.parse({
        editedPrimaryImageUrl: normalizeOptionalString(draftImageUrl),
        editedProposedDescription: normalizeOptionalString(draftDescription),
        editedProposedPrice: parsedPrice,
        // Only include `editedStructuredFields` when the reviewer
        // actually changed something — otherwise the route would treat
        // the unchanged blob as a write and re-validate, churning the
        // audit log. The PATCH route does a FULL replace when the key
        // is present (sparse merging is the caller's responsibility).
        ...(structuredChanged ? { editedStructuredFields: nextStructured } : {}),
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

  // Detect whether the reviewer has any in-flight override drafts so we
  // can default the "Overrides" details to open in that case (otherwise
  // it stays collapsed to keep the row scannable on mobile).
  const hasDraftStructuredOverrides = !areStructuredOverridesEqual(
    item.editedStructuredFields ?? null,
    buildStructuredOverridePayload(item, draftStructured),
  )
  const hasDraftOverrides = (
    draftPrice !== readDraftPrice(item)
    || draftDescription !== (item.editedProposedDescription ?? item.proposedDescription ?? '')
    || draftImageUrl !== (item.editedPrimaryImageUrl ?? item.primaryImageUrl ?? '')
    || draftNotes !== (item.notes ?? '')
    || hasDraftStructuredOverrides
  )
  const reviewDetailsHref = buildHeliosModulePath('catalog', `review-details/pending_purchase_row/${item.rowId}`)

  // Effective price chip used in the collapsed one-line summary
  // (issue #35). Shows the price that would actually be written on
  // apply (override ?? proposal), so a finalized card communicates
  // the decision the reviewer made at a glance.
  const collapsedSummaryPrice = formatCurrency(item.effectiveProposedPrice)

  const headerActions = (
    <>
      {isFinalized ? (
        <button
          className="ghost-button"
          onClick={() => setIsCollapsed((prev) => !prev)}
          title={
            isCollapsed
              ? 'Reopen this finalized row to inspect or change the decision.'
              : 'Collapse this finalized row to a one-line summary.'
          }
          type="button"
        >
          {isCollapsed ? 'Reopen ▾' : 'Collapse ▴'}
        </button>
      ) : null}
      <a
        className="ghost-button review-card-open-details"
        href={reviewDetailsHref}
        target="_blank"
        rel="noopener noreferrer"
        title="Open the full per-row details page (comments, annotations, re-run, fail) in a new tab"
      >
        Open details ↗
      </a>
    </>
  )

  const statusPills = (
    <>
      <Pill tone={approvalTone(item.approvalStatus)}>{item.approvalStatus}</Pill>
      <Pill tone={applyStatusTone(item.lastApplyStatus)}>{item.lastApplyStatus.replaceAll('_', ' ')}</Pill>
      <Pill tone={mappingStatusTone(item.mappingStatus)}>{item.mappingStatus.replaceAll('_', ' ')}</Pill>
      <Pill tone="muted">{`v${item.version}`}</Pill>
    </>
  )

  const summaryTiles = (
    <>
      <PendingValuePanel label="Current price" value={formatCurrency(item.currentPrice)} />
      <PendingValuePanel label="Imported proposal" value={formatCurrency(item.proposedPrice)} />
      <PendingValuePanel label="Effective proposal" value={formatCurrency(item.effectiveProposedPrice)} />
      <PendingValuePanel label={`GM% @ ${formatCurrency(displayedPrice)}`} value={liveGmDisplay} />
    </>
  )

  const pricingLadderSlot = hasPricingLadder ? (
    <CanonicalPricingLadder
      productId={item.rowId}
      livePrice={item.currentPrice}
      proposedPrice={displayedPrice}
      marketAveragePostTax={item.averageCompetitorPostTaxPrice}
      marketMedianPostTax={item.marketMedianPostTaxPrice}
      competitorListings={mapToCompetitorListings(item.marketListings)}
      variant="compact"
      onProposedPriceChange={editingLocked ? undefined : (next) => setDraftPrice(next.toFixed(2))}
    />
  ) : null

  const bodyExtras = (
    <>
      <PendingPurchasePictureOptions
        currentImageUrl={item.effectivePrimaryImageUrl}
        disabled={editingLocked}
        draftImageUrl={draftImageUrl}
        marketListings={item.marketListings}
        onPick={setDraftImageUrl}
      />

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
      {/*
        Reviewer-efficiency: the per-row "why this price" rationale,
        market-reference numbers, existing distributor links, and the
        order/position id trail are all useful AT MOST once per row
        (per helios/AGENTS.md guidance) — the rest of the time they
        eat reviewer screen space above the pricing ladder. Tuck them
        into a single collapsed "Rationale & references" disclosure
        so the default view stays focused on the action / ladder /
        picture choice.
      */}
      {(item.pricingReason
        || item.marketAdviceSummary
        || formatPendingPurchaseMarketReferenceText(
            item.averageCompetitorPostTaxPrice,
            item.marketMedianPostTaxPrice,
            item.averageCompetitorPrice,
          )
        || item.existingDistributorLinks
        || item.orderIds.length > 0
        || item.positionIds.length > 0
      ) ? (
        <details className="pending-purchase-rationale">
          <summary>Rationale &amp; references</summary>
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
          {(item.orderIds.length > 0 || item.positionIds.length > 0) ? (
            <p className="subtle-copy">
              Orders: {item.orderIds.join(', ') || '—'} · Positions: {item.positionIds.join(', ') || '—'}
            </p>
          ) : null}
        </details>
      ) : null}
      <details open={item.needsNewBrand || item.needsNewGroup || item.needsNewVariant}>
        <summary>
          Product hierarchy{' '}
          {item.needsNewBrand || item.needsNewGroup || item.needsNewVariant ? (
            <Pill tone="danger">
              {[
                item.needsNewBrand ? 'new brand' : null,
                item.needsNewGroup ? 'new group' : null,
                item.needsNewVariant ? 'new variant' : null,
              ]
                .filter((label): label is string => label != null)
                .join(' · ')}
            </Pill>
          ) : null}
        </summary>
        <div className="pending-purchase-hierarchy-grid">
          {/*
            * Issue #35: when the reviewer has overridden a structured
            * field via the "Override structured data" panel below, the
            * displayed value here is the EFFECTIVE value (override
            * wins) and the cell gets the amber `--overridden`
            * background + `edited` pill. The original parser value is
            * still visible in the override-edit panel as the
            * `parser: …` hint.
            */}
          <PendingValuePanel
            label="Brand"
            value={effectiveStructured(item, 'targetBrand') ?? '—'}
            highlight={item.needsNewBrand}
            overridden={hasStructuredOverride(item, 'targetBrand')}
          />
          <PendingValuePanel
            label="Group"
            value={effectiveStructured(item, 'targetGroupName') ?? '—'}
            highlight={item.needsNewGroup}
            overridden={hasStructuredOverride(item, 'targetGroupName')}
          />
          <PendingValuePanel
            label="Variant"
            value={effectiveStructured(item, 'targetVariantName') ?? '—'}
            highlight={item.needsNewVariant}
            overridden={hasStructuredOverride(item, 'targetVariantName')}
          />
          <PendingValuePanel
            label="Variant tab"
            value={effectiveStructured(item, 'targetVariantTab') ?? '—'}
            overridden={hasStructuredOverride(item, 'targetVariantTab')}
          />
          <PendingValuePanel
            label="Category"
            value={effectiveStructured(item, 'expectedCategory') ?? '—'}
            overridden={hasStructuredOverride(item, 'expectedCategory')}
          />
          <PendingValuePanel
            label="Subcategory"
            value={effectiveStructured(item, 'expectedSubcategory') ?? '—'}
            overridden={hasStructuredOverride(item, 'expectedSubcategory')}
          />
          <PendingValuePanel
            label="Size"
            value={effectiveStructured(item, 'targetSize') ?? '—'}
            overridden={hasStructuredOverride(item, 'targetSize')}
          />
          <PendingValuePanel
            label="Pack count"
            value={(() => {
              const v = effectiveStructuredPackCount(item)
              return v === null ? '—' : String(v)
            })()}
            overridden={hasStructuredOverride(item, 'targetPackCount')}
          />
          <PendingValuePanel
            label="Strain"
            value={effectiveStructured(item, 'targetStrainName') ?? '—'}
            overridden={hasStructuredOverride(item, 'targetStrainName')}
          />
          <PendingValuePanel label="Prevalence" value={item.targetPrevalence ?? '—'} />
          <PendingValuePanel label="Reuse variant" value={item.reuseProductName ?? '—'} />
          <PendingValuePanel label="Reuse product id" value={item.reuseProductId ? String(item.reuseProductId) : '—'} />
        </div>
      </details>
      {(item.marketListings.length > 0 || item.marketNote || item.marketSearchTerm || item.publicSources.length > 0) ? (
        <details className="pending-purchase-market-table-details">
          <summary>Top competitor listings ({item.marketListings.length})</summary>
          <div className="pending-purchase-pricing-support">
            <div className="pricing-metric-grid">
              <PendingValuePanel label="Reviewed price" value={formatCurrency(displayedPrice)} />
              <PendingValuePanel label="Current price" value={formatCurrency(item.currentPrice)} />
              <PendingValuePanel label="Market avg" value={formatCurrency(item.averageCompetitorPostTaxPrice)} />
              <PendingValuePanel label="Market median" value={formatCurrency(item.marketMedianPostTaxPrice)} />
            </div>
            {item.marketNote ? <p className="subtle-copy">{item.marketNote}</p> : null}
            {item.marketSearchTerm ? <p className="subtle-copy">Lit Alerts search: {item.marketSearchTerm}</p> : null}
            {item.marketListings.length > 0 ? (
              <div className="pending-purchase-listings-table-wrap">
                <table className="pending-purchase-listings-table">
                  <thead>
                    <tr>
                      <th scope="col" className="pp-col-image" />
                      <th scope="col">Dispensary / listing</th>
                      <th scope="col" className="pp-col-num">Post-tax</th>
                      <th scope="col" className="pp-col-num">Pre-tax</th>
                      <th scope="col">Distance</th>
                      <th scope="col">Match</th>
                      <th scope="col" className="pp-col-source"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {item.marketListings.map((listing, index) => {
                      const listingImage = listing.imageUrl ?? null
                      const isSelectedImage = listingImage !== null && listingImage === draftImageUrl
                      return (
                        <tr key={buildPendingPurchaseMarketListingKey(listing, index)} className={!listing.eligibleForPricing ? 'pp-listing-row-excluded' : ''}>
                          <td className="pp-col-image">
                            {listingImage ? (
                              <button
                                disabled={editingLocked}
                                onClick={() => setDraftImageUrl(listingImage)}
                                title={isSelectedImage ? 'Selected as primary image' : 'Click to use as primary image'}
                                type="button"
                                className="pp-listing-thumb-button"
                                style={{
                                  border: isSelectedImage ? '2px solid #2563eb' : '1px solid #ddd',
                                  cursor: editingLocked ? 'not-allowed' : isSelectedImage ? 'default' : 'pointer',
                                }}
                              >
                                <HoverZoomImage
                                  alt=""
                                  src={listingImage}
                                  style={{ width: '2.6rem', height: '2.6rem', objectFit: 'cover', borderRadius: '2px', display: 'block' }}
                                />
                              </button>
                            ) : null}
                          </td>
                          <td>
                            <div><strong>{listing.dispensaryName}</strong></div>
                            <div className="subtle-copy">{listing.listingName}</div>
                            {!listing.eligibleForPricing && listing.exclusionReason ? (
                              <div className="subtle-copy">{listing.exclusionReason}</div>
                            ) : null}
                          </td>
                          <td className="pp-col-num">{formatCurrency(listing.postTaxPrice)}</td>
                          <td className="pp-col-num">{formatCurrency(listing.preTaxPrice)}</td>
                          <td>{formatPendingPurchaseDistanceBandLabel(listing.distanceBand, listing.distanceMiles)}</td>
                          <td><span className={`pp-listing-match-tier pp-listing-match-${listing.matchTier}`}>{listing.matchTier}</span> · {listing.source}</td>
                          <td className="pp-col-source">
                            {listing.url ? (
                              <a href={listing.url} rel="noreferrer" target="_blank" title="Open source listing in a new tab">↗</a>
                            ) : null}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
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
      {item.reviewerNotes ? (
        <details className="pending-purchase-source-notes">
          <summary>Source notes</summary>
          <p className="subtle-copy" style={{ marginTop: '0.35rem' }}>{item.reviewerNotes}</p>
        </details>
      ) : null}
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
    </>
  )

  /*
   * All manual overrides live in one collapsed disclosure so the
   * row stays scannable by default. Default-opens when the reviewer
   * already has unsaved draft overrides queued, so they don't lose
   * sight of their work after a re-render. The structured-data
   * sub-details (issue #35) lets reviewers correct mis-parsed
   * brand / variant / pack-size / category / etc. inline; the
   * effective overrides feed the apply pipeline through the same
   * shadow-column path as the other override fields.
   */
  // Issue #35 follow-up: structured-data overrides used to live nested
  // inside the "Overrides" details, which made them feel demoted and
  // hid the most operationally-impactful overrides one click deeper.
  // The two panels are now SIBLINGS in the overrides slot — each with
  // its own Save button so the reviewer can save from whichever panel
  // they're currently working in. `handleSave` PATCHes everything
  // atomically regardless of which button was pressed.
  const overridesSlot = (
    <>
      <details className="pending-purchase-overrides" open={hasDraftOverrides}>
        <summary>Overrides{hasDraftOverrides ? ' · unsaved changes' : ''}</summary>

        <label className="stack-field">
          <span>Override proposed price</span>
          <input
            disabled={editingLocked}
            inputMode="decimal"
            min={0}
            onChange={(event) => setDraftPrice(event.currentTarget.value)}
            step={0.25}
            type="number"
            value={draftPrice}
          />
          <span className="subtle-copy" title={liveGmTitle}>
            Live GM @ {formatCurrency(displayedPrice)}: <strong>{liveGmDisplay}</strong>
            {item.effectiveUnitCost !== null
              ? ` · cost ${formatCurrency(item.effectiveUnitCost)}/unit${item.effectiveUnitCostSource ? ` (${item.effectiveUnitCostSource})` : ''}`
              : ' · no wholesale cost available'}
          </span>
        </label>

        <details className="pending-purchase-override-description">
          <summary>Override proposed description</summary>
          <textarea
            disabled={editingLocked}
            onChange={(event) => setDraftDescription(event.currentTarget.value)}
            rows={5}
            style={{ width: '100%', marginTop: '0.35rem' }}
            value={draftDescription}
          />
        </details>

        <label className="stack-field">
          <span>Override primary image URL</span>
          <input disabled={editingLocked} onChange={(event) => setDraftImageUrl(event.currentTarget.value)} value={draftImageUrl} />
        </label>

        {/*
          Operator notes override removed from the row card — per
          reviewer feedback it was noise here and is only useful on
          the per-row details view. `draftNotes` is still initialised
          and PATCHed (it just defaults to the existing item.notes so
          the round-trip is a no-op), preserving the contract without
          eating row-card real estate.
        */}

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
      </details>

      <details className="pending-purchase-overrides-structured" open={hasDraftStructuredOverrides}>
        <summary>
          Override structured data (brand, variant, pack size…)
          {hasDraftStructuredOverrides ? <Pill tone="warning">unsaved</Pill> : null}
        </summary>
        <p className="subtle-copy">
          Edit any field below and click <strong>Save overrides</strong>. The parser's
          original value stays visible as a placeholder + “parser:” hint so reviewers
          can see what changed. Once saved, overridden values are shown on the row
          card with an amber background and an <strong>edited</strong> pill so they
          stand out at a glance. Clearing a field removes its value at apply time.
          Persistent parser issues should still be fed back via{' '}
          <a href={buildHeliosModulePath('config', 'parsing/pending-purchases')} target="_blank" rel="noopener noreferrer">
            Config → Parsing → Pending purchases
          </a>.
        </p>
        <div className="pending-purchase-hierarchy-grid">
          <StructuredOverrideField
            disabled={editingLocked}
            label="Brand"
            onChange={(value) => setDraftStructured((prev) => ({ ...prev, targetBrand: value }))}
            parsedValue={item.targetBrand}
            value={draftStructured.targetBrand}
          />
          <StructuredOverrideField
            disabled={editingLocked}
            label="Group / line"
            onChange={(value) => setDraftStructured((prev) => ({ ...prev, targetGroupName: value }))}
            parsedValue={item.targetGroupName}
            value={draftStructured.targetGroupName}
          />
          <StructuredOverrideField
            disabled={editingLocked}
            label="Variant"
            onChange={(value) => setDraftStructured((prev) => ({ ...prev, targetVariantName: value }))}
            parsedValue={item.targetVariantName}
            value={draftStructured.targetVariantName}
          />
          <StructuredOverrideField
            disabled={editingLocked}
            label="Variant tab"
            onChange={(value) => setDraftStructured((prev) => ({ ...prev, targetVariantTab: value }))}
            parsedValue={item.targetVariantTab}
            value={draftStructured.targetVariantTab}
          />
          <StructuredOverrideField
            disabled={editingLocked}
            label="Category"
            onChange={(value) => setDraftStructured((prev) => ({ ...prev, expectedCategory: value }))}
            parsedValue={item.expectedCategory}
            value={draftStructured.expectedCategory}
          />
          <StructuredOverrideField
            disabled={editingLocked}
            label="Subcategory"
            onChange={(value) => setDraftStructured((prev) => ({ ...prev, expectedSubcategory: value }))}
            parsedValue={item.expectedSubcategory}
            value={draftStructured.expectedSubcategory}
          />
          <StructuredOverrideField
            disabled={editingLocked}
            label="Size"
            onChange={(value) => setDraftStructured((prev) => ({ ...prev, targetSize: value }))}
            parsedValue={item.targetSize}
            value={draftStructured.targetSize}
          />
          <StructuredOverrideField
            disabled={editingLocked}
            inputMode="numeric"
            label="Pack count"
            onChange={(value) => setDraftStructured((prev) => ({ ...prev, targetPackCount: value }))}
            parsedValue={item.targetPackCount === null ? null : String(item.targetPackCount)}
            value={draftStructured.targetPackCount}
          />
          <StructuredOverrideField
            disabled={editingLocked}
            label="Strain"
            onChange={(value) => setDraftStructured((prev) => ({ ...prev, targetStrainName: value }))}
            parsedValue={item.targetStrain}
            value={draftStructured.targetStrainName}
          />
        </div>
        {/*
          The Save Overrides button used to live here (and in the
          sibling Overrides details). Per reviewer feedback it now
          lives ONCE, in the decisions row next to Approve — that's
          where the reviewer's hand already is when they want to
          save edits and then approve.
        */}
      </details>
    </>
  )

  // Save Overrides lives in the decisions row (adjacent to Approve)
  // per reviewer feedback. We render the decisions slot whenever the
  // reviewer can either edit OR approve so the Save button is reachable
  // for edit-only roles too.
  const decisionsSlot = (canApprove || canEdit) ? (
    <div className="inline-row wrap-row review-actions">
      {canEdit ? (
        <button
          className={hasDraftOverrides ? 'primary-button' : 'ghost-button'}
          disabled={isSaving || editingLocked || !hasDraftOverrides}
          onClick={() => void handleSave()}
          type="button"
          title={hasDraftOverrides ? 'Save edited overrides' : 'No unsaved override changes'}
        >
          {isSaving ? 'Saving…' : 'Save overrides'}
        </button>
      ) : null}
      {canApprove && item.approvalStatus !== 'approved' ? (
        <button className="primary-button" disabled={isApproving || isApplyLocked} onClick={() => void handleApprovalChange('approved')} type="button">
          {isApproving ? 'Updating…' : 'Approve'}
        </button>
      ) : null}
      {canApprove && item.approvalStatus !== 'rejected' ? (
        <button className="ghost-button" disabled={isApproving || isApplyLocked} onClick={() => void handleApprovalChange('rejected')} type="button">
          Reject
        </button>
      ) : null}
      {canApprove && item.approvalStatus !== 'pending' ? (
        <button className="ghost-button" disabled={isApproving || isApplyLocked} onClick={() => void handleApprovalChange('pending')} type="button">
          Mark pending
        </button>
      ) : null}
    </div>
  ) : null

  return (
    <CanonicalProductRow
      className={`review-card${isCollapsed ? ' review-card--collapsed' : ''}`}
      headerClassName="review-card-header"
      title={<strong>{item.distributorProductName}</strong>}
      subtitle={
        <>
          {item.siteLabel} · {item.targetBrand ?? 'No brand'} · {item.targetVariantName ?? item.targetGroupName ?? 'No target variant'}
          {isCollapsed ? ` · ${collapsedSummaryPrice}` : ''}
        </>
      }
      statusPills={statusPills}
      headerActions={headerActions}
      collapsed={isCollapsed}
      comparisonsContent={summaryTiles}
      pricingLadder={pricingLadderSlot}
      bodyExtras={bodyExtras}
      overrides={overridesSlot}
      errorMessage={errorMessage}
      decisions={decisionsSlot}
    />
  )
}

/**
 * Primary "Picture options" panel surfaced at the top of each pending-purchase
 * row card. Renders every LitAlerts competitor listing image as a clickable
 * thumbnail; clicking sets `editedPrimaryImageUrl` (via the parent's
 * `draftImageUrl` state), which then flows through the existing save path.
 *
 * Why this lives above the collapsed "Pricing support details" section:
 *   - Per the catalog AGENTS.md rule, the primary content the reviewer came
 *     here to act on must be visible without scrolling past collapsed prose.
 *     Choosing a primary image from competitor listings is one of the core
 *     reviewer actions on this page, so the picker stays expanded by default.
 *   - Exact-match thumbnails get a thick blue border; brand-family
 *     (`matchTier='fallback'`) thumbnails get a thinner dashed border at 60%
 *     opacity to mirror the 50% opacity treatment on the price ladder; weak
 *     matches are filtered out entirely. Reviewers can still see every
 *     market listing (including weak ones) inside the collapsed details
 *     panel below.
 *   - We cap at 24 thumbnails to keep the row card compact; "show more"
 *     would just shove the rest of the form below the fold.
 */
const PENDING_PURCHASE_PICTURE_OPTIONS_LIMIT = 24

function PendingPurchasePictureOptions({
  currentImageUrl,
  disabled,
  draftImageUrl,
  marketListings,
  onPick,
}: {
  currentImageUrl: string | null
  disabled: boolean
  draftImageUrl: string
  marketListings: PendingPurchaseMarketListing[]
  onPick: (url: string) => void
}): JSX.Element | null {
  const candidates = useMemo(() => {
    // Filter to listings that actually have an image and aren't `weak`
    // (same matchTier policy as the price ladder). Fall back to including
    // weak matches if there are no exact/fallback options with images, so
    // the reviewer always has SOMETHING to pick from when comp data exists.
    const withImage = marketListings.filter((listing) => listing.imageUrl)
    const exactOrFamily = withImage.filter((listing) => listing.matchTier !== 'weak')
    const pool = exactOrFamily.length > 0 ? exactOrFamily : withImage
    // Dedupe identical image URLs (different retailers often share the
    // brand's stock photo). Preserve first occurrence so the picker
    // surfaces the strongest comp tier first.
    const seen = new Set<string>()
    const unique: PendingPurchaseMarketListing[] = []
    for (const listing of pool) {
      const url = listing.imageUrl
      if (!url || seen.has(url)) continue
      seen.add(url)
      unique.push(listing)
      if (unique.length >= PENDING_PURCHASE_PICTURE_OPTIONS_LIMIT) break
    }
    return unique
  }, [marketListings])

  if (candidates.length === 0 && !currentImageUrl) return null

  return (
    <section style={{ marginBottom: '0.85rem' }}>
      <div className="inline-row" style={{ gap: '0.5rem', alignItems: 'baseline', marginBottom: '0.4rem' }}>
        <strong>Picture options</strong>
        <span className="subtle-copy" style={{ fontSize: '0.78rem' }}>
          {candidates.length === 0
            ? 'No competitor images available; the current/edited image is shown below.'
            : `Click a thumbnail to use it as the primary image. ${candidates.length} option${candidates.length === 1 ? '' : 's'} shown.`}
        </span>
      </div>
      <div className="inline-row wrap-row" style={{ gap: '0.4rem' }}>
        {currentImageUrl ? (
          <PendingPurchasePictureOptionThumb
            altLabel="current"
            border="2px solid #16a34a"
            isSelected={currentImageUrl === draftImageUrl}
            label="current"
            onPick={() => onPick(currentImageUrl)}
            opacity={1}
            url={currentImageUrl}
            disabled={disabled}
          />
        ) : null}
        {candidates.map((listing) => {
          const url = listing.imageUrl as string
          const isFallback = listing.matchTier === 'fallback'
          const isSelected = url === draftImageUrl
          const border = isSelected
            ? '2px solid #2563eb'
            : isFallback
              ? '1px dashed #888'
              : '1px solid #ccc'
          const opacity = isFallback ? 0.6 : 1
          const tierLabel = listing.matchTier === 'exact'
            ? 'exact'
            : listing.matchTier === 'fallback'
              ? 'family'
              : listing.matchTier
          return (
            <PendingPurchasePictureOptionThumb
              key={`${listing.dispensaryName}-${url}`}
              altLabel={listing.dispensaryName}
              border={border}
              isSelected={isSelected}
              label={`${tierLabel} · ${listing.dispensaryName}`}
              onPick={() => onPick(url)}
              opacity={opacity}
              url={url}
              disabled={disabled}
            />
          )
        })}
      </div>
    </section>
  )
}

function PendingPurchasePictureOptionThumb({
  altLabel,
  border,
  isSelected,
  label,
  onPick,
  opacity,
  url,
  disabled,
}: {
  altLabel: string
  border: string
  isSelected: boolean
  label: string
  onPick: () => void
  opacity: number
  url: string
  disabled: boolean
}): JSX.Element {
  return (
    <button
      disabled={disabled || isSelected}
      onClick={onPick}
      title={isSelected ? `${label} · selected as primary image` : `${label} · click to use as primary image`}
      type="button"
      style={{
        padding: 0,
        border,
        borderRadius: '4px',
        background: 'transparent',
        cursor: disabled ? 'not-allowed' : isSelected ? 'default' : 'pointer',
        opacity,
        lineHeight: 0,
      }}
    >
      <HoverZoomImage
        alt={altLabel}
        src={url}
        style={{
          width: '4.5rem',
          height: '4.5rem',
          objectFit: 'cover',
          borderRadius: '2px',
          display: 'block',
        }}
      />
    </button>
  )
}

/**
 * <img> wrapper that, after the user hovers for ~5 seconds, pops up a
 * larger version of the image so they can see detail without leaving
 * the page. Used by the listing thumbnails and the "Picture options"
 * panel so the user can pick the best image for a pending purchase.
 *
 * The popup is rendered as a viewport-fixed overlay anchored next to
 * the thumbnail, with edge-detection so it stays on screen near
 * either side of the viewport. Pointer-events are disabled on the
 * popup itself so the user can move the mouse through it without
 * dismissing-then-reshowing the zoom.
 */
function HoverZoomImage({
  alt,
  src,
  style,
  zoomedSize = 360,
  // Short delay so reviewers actually see the zoom on a brief hover
  // (the previous 5s threshold was effectively invisible — the user
  // would move off the thumbnail long before the popup ever showed).
  delayMs = 350,
}: {
  alt: string
  src: string
  style?: CSSProperties
  zoomedSize?: number
  delayMs?: number
}): JSX.Element {
  const ref = useRef<HTMLImageElement | null>(null)
  const timerRef = useRef<number | null>(null)
  const [popup, setPopup] = useState<{ left: number; top: number } | null>(null)

  useEffect(() => () => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }, [])

  const clearTimer = () => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }

  const computePosition = (): { left: number; top: number } => {
    const el = ref.current
    const vw = window.innerWidth
    const vh = window.innerHeight
    const margin = 8
    if (!el) {
      return { left: margin, top: margin }
    }
    const rect = el.getBoundingClientRect()
    // Prefer placing the popup to the right of the thumbnail; fall
    // back to the left if there isn't room.
    let left = rect.right + margin
    if (left + zoomedSize + margin > vw) {
      left = rect.left - margin - zoomedSize
    }
    if (left < margin) {
      left = Math.max(margin, Math.min(vw - zoomedSize - margin, rect.left))
    }
    let top = rect.top
    if (top + zoomedSize + margin > vh) {
      top = vh - zoomedSize - margin
    }
    if (top < margin) {
      top = margin
    }
    return { left, top }
  }

  const handleEnter = () => {
    clearTimer()
    timerRef.current = window.setTimeout(() => {
      setPopup(computePosition())
      timerRef.current = null
    }, delayMs)
  }

  const handleLeave = () => {
    clearTimer()
    setPopup(null)
  }

  return (
    <>
      <img
        alt={alt}
        loading="lazy"
        onMouseEnter={handleEnter}
        onMouseLeave={handleLeave}
        ref={ref}
        src={src}
        style={style}
      />
      {popup ? (
        <div
          style={{
            position: 'fixed',
            left: popup.left,
            top: popup.top,
            width: zoomedSize,
            height: zoomedSize,
            background: '#fff',
            border: '1px solid #ccc',
            borderRadius: '4px',
            boxShadow: '0 8px 24px rgba(0,0,0,0.18)',
            padding: '4px',
            zIndex: 1000,
            pointerEvents: 'none',
          }}
        >
          <img
            alt={alt}
            src={src}
            style={{ width: '100%', height: '100%', objectFit: 'contain', display: 'block' }}
          />
        </div>
      ) : null}
    </>
  )
}

// `StructuredOverrideField`, `StructuredOverrideKey`, the helper
// functions (`readInitialDraftStructured`, `readParsedStructuredValue`,
// `buildStructuredOverridePayload`, `areStructuredOverridesEqual`) and
// the `STRUCTURED_OVERRIDE_KEYS` tuple all live in
// `client/components/canonicalProductRow/structuredOverrides.tsx` as of
// issue #35 slice 4b.2. They're imported above and used by
// `PendingPurchaseRowCard` exactly as before — extraction is a pure
// move with no behavior change. `PendingPurchaseRowCard` now renders
// through the shared `CanonicalProductRow` shell (slice 4b.3 / 4b.4,
// commit 654a17e), so both `/catalog/review` and
// `/catalog/pending-purchases` share the same row layout and override
// editor.

function PendingValuePanel({
  label,
  value,
  highlight,
  overridden,
}: {
  label: string
  value: string
  highlight?: boolean
  // True when this value reflects a reviewer-authored override
  // (issue #35). The amber `value-panel--overridden` background
  // makes it scannable at a glance while leaving the red
  // `value-panel-new-attribute` highlight to dominate when both
  // would apply.
  overridden?: boolean
}) {
  // `highlight` (would-create-new-entity, red) wins when both are
  // true so the apply-side warning isn't masked by the override pill.
  const classes = ['value-panel']
  if (highlight) {
    classes.push('value-panel-new-attribute')
  } else if (overridden) {
    classes.push('value-panel--overridden')
  }
  return (
    <div className={classes.join(' ')}>
      <span>
        {label}
        {highlight ? <Pill tone="danger">NEW</Pill> : null}
        {!highlight && overridden ? <Pill tone="warning">edited</Pill> : null}
      </span>
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

function buildPendingPurchaseMarketListingKey(
  listing: PendingPurchaseMarketListing,
  index: number,
): string {
  return `${listing.dispensaryName}-${listing.listingName}-${listing.source}-${index}`
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

function mapToCompetitorListings(marketListings: PendingPurchaseMarketListing[]): CompetitorListing[] {
  return marketListings.map((listing, index) => ({
    listingId: `${listing.dispensaryName}-${listing.listingName}-${listing.source}-${index}`,
    postTaxPrice: listing.postTaxPrice,
    distanceMiles: listing.distanceMiles,
    dispensaryName: listing.dispensaryName,
    dispensaryAddress: null,
    listingName: listing.listingName,
    url: listing.url,
    eligibleForPricing: listing.eligibleForPricing,
    // Plumb the comp-matcher verdict through so the ladder can drop
    // `weak` and dim `fallback` (brand-family) dots.
    matchTier: listing.matchTier,
  }))
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

function buildPendingPurchaseSidebarNodes(
  hierarchy: PendingPurchaseSiteGroup[],
): TreeNavNode[] | null {
  if (hierarchy.length === 0) return null
  return hierarchy.map((siteGroup) => ({
    kind: 'branch' as const,
    navKey: `catalog.pending-purchases.site.${siteGroup.id}`,
    label: siteGroup.siteLabel,
    targetId: siteGroup.id,
    count: siteGroup.rowCount,
    defaultOpen: true,
    children: siteGroup.categories.map((categoryGroup) => ({
      kind: 'branch' as const,
      navKey: `catalog.pending-purchases.category.${categoryGroup.id}`,
      label: categoryGroup.categoryLabel,
      targetId: categoryGroup.id,
      count: categoryGroup.rowCount,
      defaultOpen: true,
      children: categoryGroup.subcategories.map((subcategoryGroup) => ({
        kind: 'branch' as const,
        navKey: `catalog.pending-purchases.subcategory.${subcategoryGroup.id}`,
        label: subcategoryGroup.subcategoryLabel,
        targetId: subcategoryGroup.id,
        count: subcategoryGroup.rowCount,
        defaultOpen: true,
        children: subcategoryGroup.brands.map((brandGroup) => ({
          kind: 'leaf' as const,
          navKey: `catalog.pending-purchases.brand.${brandGroup.id}`,
          label: brandGroup.brandLabel,
          targetId: brandGroup.id,
          count: brandGroup.rowCount,
        })),
      })),
    })),
  }))
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
