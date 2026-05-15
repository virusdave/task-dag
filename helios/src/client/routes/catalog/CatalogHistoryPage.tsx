import type { ReactNode } from 'react'
import { Form, Link, useLoaderData } from 'react-router-dom'

import {
  CatalogHistoryResponseSchema,
  buildHeliosModulePath,
  type CatalogHistoryResponse,
  type ScopeKind,
} from '../../../shared/contracts/index.js'
import { loadJson } from '../../app/fetchJson.js'
import { Pill } from '../../components/Pill.js'
import { useRegisterCatalogSidebarSubtree } from './catalogSidebarSubtree.js'

function buildReviewDetailsPath(scopeKind: ScopeKind, scopeId: string | number): string {
  return buildHeliosModulePath('catalog', `review-details/${scopeKind}/${scopeId}`)
}

export async function catalogHistoryLoader({ request }: { request: Request }) {
  const url = new URL(request.url)
  return loadJson(`/api/catalog/history${url.search}`, CatalogHistoryResponseSchema)
}

export function CatalogHistoryPage() {
  const data = useLoaderData() as CatalogHistoryResponse
  useRegisterCatalogSidebarSubtree()

  return (
    <div className="stacked-list">
      <section className="detail-panel">
        <div className="page-header">
          <div>
            <p className="eyebrow">Catalog History</p>
            <h2>Review catalog proposals, live writes, and pending-purchase runs</h2>
            <p className="subtle-copy">
              This view summarizes the durable catalog records Helios stores for imports, approvals, applies, and purchase-driven work instead of dumping raw audit payload JSON.
            </p>
          </div>
          <Form className="filter-row" method="get">
            <select defaultValue={String(data.filters.sectionLimit)} name="sectionLimit">
              <option value="5">5 per section</option>
              <option value="8">8 per section</option>
              <option value="12">12 per section</option>
              <option value="20">20 per section</option>
            </select>
            <button className="ghost-button" type="submit">Update</button>
          </Form>
        </div>
        <div className="inline-row wrap-row module-card-links">
          <Link to={buildHeliosModulePath('catalog', 'review')}>Review queue</Link>
          <Link to={buildHeliosModulePath('catalog', 'browser')}>Catalog browser</Link>
          <Link to={buildHeliosModulePath('catalog', 'pending-purchases')}>Pending purchases</Link>
          <Link to="/jobs?module=catalog">Catalog jobs</Link>
          <Link to="/history?module=catalog">Raw audit feed</Link>
        </div>
      </section>

      <CatalogHistorySection
        description="Generated and imported proposal batches with the row counts Helios persisted for review."
        emptyState="No proposal batches have been recorded yet."
        title="Proposal Batches"
      >
        {data.proposalBatchItems.map((item) => (
          <article className="mini-card" key={item.batchId}>
            <header>
              <div>
                <strong>{`${capitalize(item.type)} batch #${item.batchId}`}</strong>
                <p className="subtle-copy">
                  Created {formatDateTime(item.createdAt)}
                  {item.createdByUser ? ` · ${item.createdByUser}` : ''}
                  {item.jobId ? ` · job #${item.jobId}` : ''}
                </p>
              </div>
              <div className="inline-row wrap-row">
                <Pill tone={proposalBatchStatusTone(item.status)}>{item.status.replaceAll('_', ' ')}</Pill>
                <Pill tone="muted">{item.source}</Pill>
                <Pill tone="muted">{`${item.rowCount} rows`}</Pill>
                {item.generatedLineItemCount !== null ? <Pill tone="muted">{`${item.generatedLineItemCount} line items`}</Pill> : null}
              </div>
            </header>
            <p>{item.summaryText}</p>
            <p className="subtle-copy">
              {formatProposalBatchMeta(item)}
              {item.jobStatus ? ` · job ${item.jobStatus}` : ''}
            </p>
            {item.importFileName ? <p className="subtle-copy">{item.importFileName}</p> : null}
            {item.sourcePath ? <p className="subtle-copy">{item.sourcePath}</p> : null}
            <div className="inline-row wrap-row module-card-links">
              <Link to={buildReviewDetailsPath('proposal_batch', item.batchId)}>Review details</Link>
            </div>
          </article>
        ))}
      </CatalogHistorySection>

      <CatalogHistorySection
        description="Recent proposal approvals plus pending-purchase review decisions that changed apply eligibility."
        emptyState="No approval decisions have been recorded yet."
        title="Approval Decisions"
      >
        {data.approvalItems.map((item) => (
          <article className="mini-card" key={item.eventId}>
            <header>
              <div>
                <strong>{item.summaryText}</strong>
                <p className="subtle-copy">{item.actorLabel} · {formatDateTime(item.createdAt)}</p>
              </div>
              <div className="inline-row wrap-row">
                <Pill tone={approvalDecisionTone(item.decision)}>{item.decision === 'pending' ? 'pending review' : item.decision}</Pill>
                <Pill tone="muted">{item.kind === 'proposal_line_item' ? 'proposal' : 'pending purchase'}</Pill>
              </div>
            </header>
            <p className="subtle-copy">{formatApprovalMeta(item)}</p>
            <div className="inline-row wrap-row module-card-links">
              {item.rowId
                ? <Link to={buildReviewDetailsPath(item.kind, item.rowId)}>Review details</Link>
                : null}
              {item.kind === 'proposal_line_item' && item.catalogGroupId
                ? <Link to={buildHeliosModulePath('catalog', `groups/${item.catalogGroupId}`)}>Group detail</Link>
                : null}
              {item.kind === 'pending_purchase_row' && item.packetId
                ? <Link to={buildHeliosModulePath('catalog', `pending-purchases?packetId=${item.packetId}`)}>Open packet</Link>
                : null}
            </div>
          </article>
        ))}
      </CatalogHistorySection>

      <CatalogHistorySection
        description="Live write operations queued or completed through the catalog reconcile and undo paths."
        emptyState="No catalog write operations have been recorded yet."
        title="Live Write Operations"
      >
        {data.writeOperationItems.map((item) => (
          <article className="mini-card" key={item.writeOperationId}>
            <header>
              <div>
                <strong>{`${capitalize(item.operationType)} #${item.writeOperationId} · ${item.groupName}`}</strong>
                <p className="subtle-copy">
                  Created {formatDateTime(item.createdAt)}
                  {item.startedAt ? ` · Started ${formatDateTime(item.startedAt)}` : ''}
                  {item.finishedAt ? ` · Finished ${formatDateTime(item.finishedAt)}` : ''}
                </p>
              </div>
              <div className="inline-row wrap-row">
                <Pill tone={writeOperationTone(item.status)}>{item.status.replaceAll('_', ' ')}</Pill>
                <Pill tone="muted">{`attempt ${item.attemptCount + 1}`}</Pill>
              </div>
            </header>
            <p>{item.summaryText}</p>
            <p className="subtle-copy">
              {item.triggerEventType ? `Triggered by ${item.triggerActorLabel ?? 'system'} via ${item.triggerEventType}` : 'No trigger audit event was linked.'}
              {item.jobId ? ` · job #${item.jobId}` : ''}
            </p>
            {item.error ? <p className="error-text">{item.error}</p> : null}
            <div className="inline-row wrap-row module-card-links">
              <Link to={buildReviewDetailsPath('write_operation', item.writeOperationId)}>Review details</Link>
              <Link to={buildHeliosModulePath('catalog', `groups/${item.catalogGroupId}`)}>Group detail</Link>
            </div>
          </article>
        ))}
      </CatalogHistorySection>

      <CatalogHistorySection
        description="Generated and imported pending-purchase packets stored for operator review in Helios."
        emptyState="No pending-purchase packets have been recorded yet."
        title="Pending-Purchase Packets"
      >
        {data.pendingPurchasePacketItems.map((item) => (
          <article className="mini-card" key={item.packetId}>
            <header>
              <div>
                <strong>{`Packet #${item.packetId} · ${item.packetTitle}`}</strong>
                <p className="subtle-copy">
                  Generated {formatDateTime(item.generatedAt)}
                  {item.createdByUser ? ` · ${item.createdByUser}` : ''}
                  {item.jobId ? ` · job #${item.jobId}` : ''}
                </p>
              </div>
              <div className="inline-row wrap-row">
                <Pill tone={item.source === 'generated' ? 'success' : 'warning'}>{item.source}</Pill>
                <Pill tone={item.status === 'ready' ? 'success' : 'muted'}>{item.status}</Pill>
                <Pill tone="muted">{`${item.rowCount} rows`}</Pill>
              </div>
            </header>
            <p>{item.summaryText}</p>
            <p className="subtle-copy">
              {item.siteLabels.length > 0 ? item.siteLabels.join(', ') : 'No site labels recorded'}
              {item.jobStatus ? ` · job ${item.jobStatus}` : ''}
            </p>
            {item.importFileName ? <p className="subtle-copy">{item.importFileName}</p> : null}
            {item.sourcePath ? <p className="subtle-copy">{item.sourcePath}</p> : null}
            <div className="inline-row wrap-row module-card-links">
              <Link to={buildReviewDetailsPath('pending_purchase_packet', item.packetId)}>Review details</Link>
              <Link to={buildHeliosModulePath('catalog', `pending-purchases?packetId=${item.packetId}`)}>Open packet</Link>
            </div>
          </article>
        ))}
      </CatalogHistorySection>

      <CatalogHistorySection
        description="Worker apply runs for approved pending-purchase rows, including recorded result counts and summaries."
        emptyState="No pending-purchase apply runs have been recorded yet."
        title="Pending-Purchase Apply Runs"
      >
        {data.pendingPurchaseApplyItems.map((item) => (
          <article className="mini-card" key={item.requestId}>
            <header>
              <div>
                <strong>{`Apply request #${item.requestId} · ${item.packetTitle}`}</strong>
                <p className="subtle-copy">
                  Requested {formatDateTime(item.requestedAt)}
                  {item.requestedByUser ? ` · ${item.requestedByUser}` : ''}
                  {item.startedAt ? ` · Started ${formatDateTime(item.startedAt)}` : ''}
                  {item.finishedAt ? ` · Finished ${formatDateTime(item.finishedAt)}` : ''}
                </p>
              </div>
              <div className="inline-row wrap-row">
                <Pill tone={pendingPurchaseApplyTone(item.status)}>{item.status.replaceAll('_', ' ')}</Pill>
                <Pill tone="muted">{`${item.appliedRowCount}/${item.selectedRowCount} applied`}</Pill>
                {item.blockedRowCount > 0 ? <Pill tone="warning">{`${item.blockedRowCount} blocked`}</Pill> : null}
                {item.failedRowCount > 0 ? <Pill tone="danger">{`${item.failedRowCount} failed`}</Pill> : null}
              </div>
            </header>
            <p>{item.summaryText}</p>
            <p className="subtle-copy">{formatPendingPurchaseApplyMeta(item)}{item.jobStatus ? ` · job ${item.jobStatus}` : ''}</p>
            <div className="inline-row wrap-row module-card-links">
              <Link to={buildReviewDetailsPath('pending_purchase_packet', item.packetId)}>Review details</Link>
              <Link to={buildHeliosModulePath('catalog', `pending-purchases?packetId=${item.packetId}`)}>Open packet</Link>
            </div>
          </article>
        ))}
      </CatalogHistorySection>
    </div>
  )
}

function CatalogHistorySection(
  {
    children,
    description,
    emptyState,
    title,
  }: {
    children: ReactNode
    description: string
    emptyState: string
    title: string
  },
) {
  const content = Array.isArray(children) ? children : [children]
  const hasItems = content.some(Boolean)

  return (
    <section className="detail-panel">
      <div className="page-header">
        <div>
          <h3 style={{ margin: 0 }}>{title}</h3>
          <p className="subtle-copy">{description}</p>
        </div>
      </div>
      <div className="stacked-list">
        {hasItems ? content : <p className="empty-state">{emptyState}</p>}
      </div>
    </section>
  )
}

function formatProposalBatchMeta(item: CatalogHistoryResponse['proposalBatchItems'][number]): string {
  const parts = [
    item.triggerMode === 'import' ? 'imported batch' : `${item.triggerMode} batch`,
  ]

  if (item.requestedGroupCount !== null) {
    parts.push(`${item.requestedGroupCount} requested groups`)
  }
  if (item.generatedGroupCount !== null) {
    parts.push(`${item.generatedGroupCount} generated groups`)
  }

  return parts.join(' · ')
}

function formatApprovalMeta(item: CatalogHistoryResponse['approvalItems'][number]): string {
  if (item.kind === 'proposal_line_item') {
    return item.fieldPath
      ? `${item.itemLabel} · ${item.fieldPath}`
      : item.itemLabel
  }

  const parts = [item.itemLabel]
  if (item.siteLabel) {
    parts.push(item.siteLabel)
  }
  if (item.packetTitle) {
    parts.push(item.packetTitle)
  }
  return parts.join(' · ')
}

function formatPendingPurchaseApplyMeta(item: CatalogHistoryResponse['pendingPurchaseApplyItems'][number]): string {
  return [
    `${item.selectedRowCount} selected`,
    `${item.appliedRowCount} applied`,
    `${item.blockedRowCount} blocked`,
    `${item.failedRowCount} failed`,
  ].join(' · ')
}

function proposalBatchStatusTone(status: CatalogHistoryResponse['proposalBatchItems'][number]['status']): 'danger' | 'muted' | 'success' | 'warning' {
  switch (status) {
    case 'ready':
      return 'success'
    case 'failed':
      return 'danger'
    case 'draft':
      return 'warning'
    default:
      return 'muted'
  }
}

function approvalDecisionTone(decision: CatalogHistoryResponse['approvalItems'][number]['decision']): 'muted' | 'success' | 'warning' {
  switch (decision) {
    case 'approved':
      return 'success'
    case 'rejected':
      return 'warning'
    default:
      return 'muted'
  }
}

function writeOperationTone(status: CatalogHistoryResponse['writeOperationItems'][number]['status']): 'danger' | 'muted' | 'success' | 'warning' {
  switch (status) {
    case 'succeeded':
      return 'success'
    case 'failed':
    case 'verified_mismatch':
      return 'danger'
    case 'queued':
    case 'running':
      return 'warning'
    default:
      return 'muted'
  }
}

function pendingPurchaseApplyTone(status: CatalogHistoryResponse['pendingPurchaseApplyItems'][number]['status']): 'danger' | 'muted' | 'success' | 'warning' {
  switch (status) {
    case 'succeeded':
      return 'success'
    case 'failed':
      return 'danger'
    case 'partially_succeeded':
    case 'blocked':
    case 'queued':
    case 'running':
      return 'warning'
    default:
      return 'muted'
  }
}

function formatDateTime(value: string): string {
  return new Date(value).toLocaleString()
}

function capitalize(value: string): string {
  return value.length > 0 ? `${value[0].toUpperCase()}${value.slice(1)}` : value
}
