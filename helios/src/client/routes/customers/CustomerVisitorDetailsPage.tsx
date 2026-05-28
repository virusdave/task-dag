// Customer details, scan-anchored.
//
// FreshlyBakedNYC/automation#31, phase A4 — design lives in
// docs/customers/customer-details-page-design.md (work in progress).
//
// PHASE-1 STUB. This page exists so the new-tab link from the
// /admin/visitors/scans list resolves to a real route while the
// background-lookup worker + map UI ship in phase 2. We hit the
// already-enriched list endpoint (filtered to a single id) so the
// stub already shows the most useful information: which scan,
// first/returning state, current Sweed link status (pending until
// the worker lands), and the document-address coordinates.

import { useEffect, useState } from 'react'
import { useLoaderData, useParams } from 'react-router-dom'

import {
  VisitorScansResponseSchema,
  type VisitorScanItem,
  type VisitorScansResponse,
} from '../../../shared/contracts/index.js'
import { loadJson } from '../../app/fetchJson.js'
import { Pill } from '../../components/Pill.js'

export async function customerVisitorDetailsLoader({
  params,
}: {
  params: { scanId?: string }
}): Promise<VisitorScansResponse> {
  // Reuse the enriched list endpoint with a single-id filter via the
  // forward-only cursor + limit. Until the dedicated
  // /api/customers/visitors/:scanId endpoint ships (phase 2), this
  // keeps the stub fully data-driven.
  const id = Number(params.scanId)
  if (!Number.isFinite(id) || id <= 0) {
    return { items: [], hasMore: false }
  }
  // We pull a generous page and filter client-side to the exact id.
  // The next phase replaces this with a dedicated endpoint.
  return loadJson(`/api/visitors/scans?limit=500`, VisitorScansResponseSchema)
}

function formatName(item: VisitorScanItem): string {
  const parts = [item.firstName, item.middleName, item.lastName].filter(
    (p): p is string => p !== null && p.length > 0,
  )
  return parts.length === 0 ? 'Unknown visitor' : parts.join(' ')
}

function formatTime(iso: string | null): string {
  if (iso === null) return '—'
  try {
    return new Date(iso).toLocaleString(undefined, { hour12: false })
  } catch {
    return iso
  }
}

export function CustomerVisitorDetailsPage(): JSX.Element {
  const initialData = useLoaderData() as VisitorScansResponse
  const params = useParams<{ scanId: string }>()
  const scanId = Number(params.scanId)
  const [data] = useState<VisitorScansResponse>(initialData)
  const [item, setItem] = useState<VisitorScanItem | null>(
    data.items.find((row) => row.id === scanId) ?? null,
  )

  useEffect(() => {
    setItem(data.items.find((row) => row.id === scanId) ?? null)
  }, [data, scanId])

  if (!Number.isFinite(scanId) || scanId <= 0) {
    return (
      <section className="customer-details-page">
        <header className="cd-header">
          <h2 className="cd-title">Customer details</h2>
        </header>
        <p className="subtle-copy">Missing or invalid scan id.</p>
      </section>
    )
  }

  if (item === null) {
    return (
      <section className="customer-details-page">
        <header className="cd-header">
          <h2 className="cd-title">Customer details</h2>
        </header>
        <p className="subtle-copy">
          Scan #{scanId} was not in the most recent 500 visitor scans. The
          dedicated details endpoint ships in the next deploy; until then,
          open the scan from <a href="/admin/visitors/scans">Visitor Scans</a>.
        </p>
      </section>
    )
  }

  const sweed = item.sweedLink
  const summary = item.sweedPurchaseSummary

  const statusPills: Array<{ label: string; tone: 'success' | 'warning' | 'danger' | 'muted' }> = []
  if (summary !== null && summary.hasPriorPurchaseBeforeScan) {
    statusPills.push({ label: 'Known purchaser', tone: 'success' })
  } else if (!item.identity.isFirstLocalScan) {
    statusPills.push({ label: 'Returning scan', tone: 'success' })
  } else {
    statusPills.push({ label: 'First scan', tone: 'warning' })
  }
  if (sweed === null) {
    statusPills.push({ label: 'CRM lookup unavailable', tone: 'muted' })
  } else if (sweed.status === 'linked' && sweed.customerId !== null) {
    statusPills.push({ label: `Linked #${sweed.customerId}`, tone: 'success' })
  } else if (sweed.status === 'pending') {
    statusPills.push({ label: 'CRM lookup pending', tone: 'muted' })
  } else if (sweed.status === 'ambiguous') {
    statusPills.push({ label: 'CRM needs review', tone: 'warning' })
  } else if (sweed.status === 'no_match') {
    statusPills.push({ label: 'No CRM match', tone: 'muted' })
  } else if (sweed.status === 'insufficient_data') {
    statusPills.push({ label: 'CRM lookup skipped', tone: 'muted' })
  } else if (sweed.status === 'failed') {
    statusPills.push({ label: 'CRM lookup failed', tone: 'danger' })
  }

  return (
    <section className="customer-details-page">
      <header className="cd-header">
        <div>
          <h2 className="cd-title">{formatName(item)}</h2>
          <p className="subtle-copy">
            {item.siteSlug} · scanned {formatTime(item.scannedAt ?? item.ingestedAt)}
          </p>
        </div>
        <div className="cd-pills">
          {statusPills.map((p) => (
            <Pill key={p.label} tone={p.tone}>
              {p.label}
            </Pill>
          ))}
        </div>
      </header>

      <div className="cd-answer-card">
        <div className="cd-answer-row">
          <div>
            <span className="cd-answer-label">Local visits</span>
            <div className="cd-answer-value">{item.identity.priorLocalScanCount + 1}</div>
            <div className="subtle-copy">
              first seen {formatTime(item.identity.firstLocalScanAt ?? item.scannedAt)}
            </div>
          </div>
          <div>
            <span className="cd-answer-label">Sweed customer</span>
            <div className="cd-answer-value">
              {sweed?.customerId ?? <em className="subtle-copy">not linked yet</em>}
            </div>
            <div className="subtle-copy">
              {sweed === null
                ? '—'
                : sweed.status === 'pending'
                  ? 'background worker will probe Sweed by ID number'
                  : sweed.status}
            </div>
          </div>
          <div>
            <span className="cd-answer-label">Prior Sweed purchases</span>
            <div className="cd-answer-value">
              {summary?.priorPurchaseCount ?? '—'}
            </div>
            <div className="subtle-copy">
              {summary === null
                ? 'waiting for CRM link'
                : summary.totalPurchaseCount === 0
                  ? 'no purchases on file'
                  : `lifetime spend $${summary.lifetimeSpendDollars.toFixed(2)}`}
            </div>
          </div>
        </div>
      </div>

      <div className="cd-placeholder">
        <h3>Phase 2 — coming next deploy</h3>
        <ul>
          <li>Background worker that probes Sweed by ID number / name and caches candidates.</li>
          <li>Interactive Leaflet map showing document address, scan location, Sweed primary address, and delivery destinations.</li>
          <li>Combined visits + purchases timeline.</li>
          <li>Operator confirm/reject of ambiguous CRM candidates.</li>
        </ul>
      </div>

      <details className="cd-debug">
        <summary>Anchor scan (raw VeriScan envelope)</summary>
        <pre className="cd-debug-pre">{JSON.stringify(item.rawEnvelope, null, 2)}</pre>
      </details>
    </section>
  )
}
