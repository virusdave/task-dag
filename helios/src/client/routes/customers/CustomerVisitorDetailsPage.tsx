// Customer / visitor details (the page reached by clicking a row in
// /admin/customers/check-ins).
//
// Phase-2 successor to the prior list-fetch stub. Backed by the
// dedicated endpoint GET /api/admin/customers/visitors/:scanId
// (helios/src/server/routes/visitorScans.ts +
//  helios/src/server/db/queries/customerVisitorDetailsQueries.ts).
//
// Layout, top to bottom:
//
//   1. Header: name, time, status pills (first/returning, linked,
//      purchaser).
//   2. Answer-card KPI strip: local visits, Sweed customer, lifetime
//      spend, prior purchases.
//   3. Full-size MapLibre map showing every known address coordinate:
//      document address (blue), scan location (orange), Sweed primary
//      address (green), Sweed delivery destinations (purple). Same
//      desaturated OSM base style as /admin/customers/map.
//   4. Identity / device / link detail cards (every column we have).
//   5. Prior check-ins table — every other visitor_scans row matching
//      this person (by id_num and/or person_key), with each visit's
//      same-business-day purchase rollup when the anchor is linked.
//   6. Purchase invoices table — full sweed_orders header history for
//      the Sweed customer. Each row is expandable to a product
//      thumbnail grid of its line items (lazily fetched per invoice
//      from the materialised sweed_order_items_flat table).
//   7. Raw envelope, collapsed.

import { Fragment, createContext, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { useLoaderData, useParams } from 'react-router-dom'

import maplibregl from 'maplibre-gl'

import {
  CustomerVisitorDetailsResponseSchema,
  CustomerVisitorInvoiceItemsResponseSchema,
  type CustomerVisitorAddableSegment,
  type CustomerVisitorAnchorScan,
  type CustomerVisitorDetailsResponse,
  type CustomerVisitorLineItem,
  type CustomerVisitorMapPoint,
  type CustomerVisitorPriorVisit,
  type CustomerVisitorPurchaseInvoice,
  type CustomerVisitorSegmentMembership,
} from '../../../shared/contracts/index.js'
import { loadJson, mutateJson } from '../../app/fetchJson.js'
import { buildAppPath } from '../../app/paths.js'
import { Pill } from '../../components/Pill.js'
import { z } from 'zod'

// ---------------------------------------------------------------------
// Map style — same recipe as CustomerMapPage. Kept inline to avoid a
// new shared module just for two callers.
// ---------------------------------------------------------------------

const MAP_STYLE: maplibregl.StyleSpecification = {
  version: 8,
  sources: {
    osm: {
      type: 'raster',
      tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
      tileSize: 256,
      attribution: '&copy; OpenStreetMap contributors',
      maxzoom: 19,
    },
  },
  layers: [
    {
      id: 'osm-tiles',
      type: 'raster',
      source: 'osm',
      paint: {
        'raster-opacity': 0.7,
        'raster-saturation': -0.6,
        'raster-contrast': -0.1,
        'raster-brightness-max': 0.95,
      },
    },
  ],
}

const POINT_COLORS: Record<CustomerVisitorMapPoint['kind'], string> = {
  document_address: '#1f5db8',
  scan_location: '#b95f25',
  sweed_primary_address: '#2f8a4a',
  sweed_delivery_destination: '#7a4ab0',
}

const POINT_LABELS: Record<CustomerVisitorMapPoint['kind'], string> = {
  document_address: 'Document address',
  scan_location: 'Scan device',
  sweed_primary_address: 'Sweed primary address',
  sweed_delivery_destination: 'Sweed delivery destination',
}

// ---------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------

export async function customerVisitorDetailsLoader({
  params,
}: {
  params: { scanId?: string }
}): Promise<CustomerVisitorDetailsResponse | null> {
  const id = Number(params.scanId)
  if (!Number.isFinite(id) || id <= 0) {
    return null
  }
  try {
    return await loadJson(
      `/api/admin/customers/visitors/${id}`,
      CustomerVisitorDetailsResponseSchema,
    )
  } catch (cause) {
    // 404 / 503 / 400 all fall through to the page; we render a
    // friendly error there with the message.
    const message = cause instanceof Error ? cause.message : String(cause)
    // eslint-disable-next-line no-console
    console.warn('[customer-visitor-details] loader failed', message)
    return null
  }
}

// ---------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------

export function CustomerVisitorDetailsPage(): JSX.Element {
  const initialData = useLoaderData() as CustomerVisitorDetailsResponse | null
  const params = useParams<{ scanId: string }>()
  const scanId = Number(params.scanId)
  const [data, setData] = useState<CustomerVisitorDetailsResponse | null>(initialData)
  const [error, setError] = useState<string | null>(initialData === null ? 'load-failed' : null)
  const [reloading, setReloading] = useState(false)
  // Bumped to force a re-fetch (e.g. after enqueuing a segment refresh).
  const [reloadKey, setReloadKey] = useState(0)

  // Manual refresh button (and re-fetch on scanId change, e.g. when an
  // operator clicks a prior-visit link in the table).
  useEffect(() => {
    if (!Number.isFinite(scanId) || scanId <= 0) return
    let cancelled = false
    setReloading(true)
    void (async () => {
      try {
        const next = await loadJson(
          `/api/admin/customers/visitors/${scanId}`,
          CustomerVisitorDetailsResponseSchema,
        )
        if (!cancelled) {
          setData(next)
          setError(null)
        }
      } catch (cause) {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : 'Failed to load')
        }
      } finally {
        if (!cancelled) setReloading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [scanId, reloadKey])

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

  if (data === null) {
    return (
      <section className="customer-details-page">
        <header className="cd-header">
          <h2 className="cd-title">Customer details</h2>
        </header>
        <p className="subtle-copy">
          {error === 'load-failed'
            ? `Scan #${scanId} could not be loaded — it may not exist or the visitor_scans tables are missing.`
            : reloading
              ? 'Loading…'
              : error ?? 'Unknown error'}
        </p>
        <p className="subtle-copy">
          <a href={buildAppPath('/admin/customers/check-ins')}>← Back to check-ins</a>
        </p>
      </section>
    )
  }

  return (
    <CustomerVisitorDetailsView
      data={data}
      reloading={reloading}
      scanId={scanId}
      onRequestReload={() => setReloadKey((k) => k + 1)}
    />
  )
}

// ---------------------------------------------------------------------
// View body (split out so the loading/error branch stays small)
// ---------------------------------------------------------------------

function CustomerVisitorDetailsView({
  data,
  reloading,
  scanId,
  onRequestReload,
}: {
  data: CustomerVisitorDetailsResponse
  reloading: boolean
  scanId: number
  onRequestReload: () => void
}): JSX.Element {
  const { anchorScan, linkedCustomer, priorVisits, purchaseInvoices, purchaseLifetime } = data

  const statusPills = computeStatusPills(data)
  const sweedLink = anchorScan.sweedLink
  const hasLink = sweedLink !== null && sweedLink.status === 'linked' && sweedLink.customerId !== null
  const totalVisits = priorVisits.length + 1

  return (
    <section className="customer-details-page">
      <header className="cd-header">
        <div>
          <h2 className="cd-title">{formatName(anchorScan)}</h2>
          <p className="subtle-copy">
            <a href={buildAppPath('/admin/customers/check-ins')}>← Check-ins</a>
            {' · '}
            {anchorScan.siteSlug} · scan #{anchorScan.id} · scanned{' '}
            {formatTime(anchorScan.scannedAt ?? anchorScan.ingestedAt)}
            {reloading ? ' · refreshing…' : ''}
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
          <KpiCell
            label="Local visits"
            value={String(totalVisits)}
            sub={
              anchorScan.identity.firstLocalScanAt
                ? `first seen ${formatDate(anchorScan.identity.firstLocalScanAt)}`
                : 'first time today'
            }
          />
          <KpiCell
            label="ID-num check-ins"
            value={String(anchorScan.identity.priorIdNumScanCount + 1)}
            sub={
              anchorScan.identity.isFirstScanByIdNum
                ? 'first time this ID has been scanned'
                : 'this ID has been scanned before'
            }
          />
          <KpiCell
            label="Sweed customer"
            value={
              sweedLink?.customerId !== undefined && sweedLink.customerId !== null
                ? `#${sweedLink.customerId}`
                : '—'
            }
            sub={describeLink(sweedLink)}
          />
          <KpiCell
            label="Lifetime spend"
            value={
              hasLink && purchaseLifetime !== null
                ? `$${purchaseLifetime.lifetimeSpendDollars.toFixed(2)}${data.purchaseInvoicesTruncated ? '+' : ''}`
                : '—'
            }
            sub={
              hasLink && purchaseLifetime !== null
                ? `${purchaseLifetime.totalPurchaseCount}${data.purchaseInvoicesTruncated ? '+' : ''} invoices`
                : hasLink
                  ? 'no Sweed orders on file'
                  : 'waiting for CRM link'
            }
          />
          <KpiCell
            label="Prior purchases"
            value={
              hasLink && purchaseLifetime !== null
                ? String(purchaseLifetime.priorPurchaseCount)
                : '—'
            }
            sub={
              hasLink && purchaseLifetime?.firstPurchaseAt
                ? `first ${formatDate(purchaseLifetime.firstPurchaseAt)}`
                : ''
            }
          />
        </div>
      </div>

      <section className="cd-map-card">
        <div className="cd-section-head">
          <h3>Map</h3>
          <MapLegend points={data.mapPoints} />
        </div>
        {data.mapPoints.length === 0 ? (
          <p className="subtle-copy cd-empty">
            No geocoded coordinates on file yet — document address may be
            non-US, scan device may not have shared a location, and the
            Sweed customer (if linked) has no geocoded address.
          </p>
        ) : (
          <CustomerVisitorMap points={data.mapPoints} />
        )}
      </section>

      <section className="cd-grid">
        <Card title="Document identity">
          <DescList
            entries={[
              ['First name', anchorScan.firstName],
              ['Middle name', anchorScan.middleName],
              ['Last name', anchorScan.lastName],
              ['ID #', anchorScan.idNum],
              ['Birth date', anchorScan.birthDate],
              ['Expiry', anchorScan.expDate],
              ['Gender', anchorScan.gender],
              ['Phone', anchorScan.phone],
              ['Email', anchorScan.email],
              ['Document type', anchorScan.documentType],
              [
                'Validity',
                anchorScan.documentIsValid === null
                  ? null
                  : anchorScan.documentIsValid
                    ? 'valid'
                    : 'invalid',
              ],
              ['Authentication', anchorScan.authenticationStatus],
              ['Scan status', anchorScan.scanStatus],
              ['Hash id', anchorScan.hashId],
            ]}
          />
        </Card>
        <Card title="Document address">
          <DescList
            entries={[
              ['Address', anchorScan.address],
              ['City', anchorScan.city],
              ['State', anchorScan.state],
              ['Postal code', anchorScan.postalCode],
              ['Country', anchorScan.country],
              [
                'Lat / Lng',
                anchorScan.latitude !== null && anchorScan.longitude !== null
                  ? `${anchorScan.latitude.toFixed(5)}, ${anchorScan.longitude.toFixed(5)}`
                  : null,
              ],
              ['Jurisdiction', anchorScan.jurisdictionCode],
              ['Country code', anchorScan.countryCode],
            ]}
          />
        </Card>
        <Card title="Scan device">
          <DescList
            entries={[
              ['Site', anchorScan.siteSlug],
              ['Device', anchorScan.deviceName],
              ['Device id', anchorScan.deviceId?.toString() ?? null],
              ['Device login', anchorScan.deviceLogin],
              ['Location', anchorScan.locationName],
              ['Location id', anchorScan.locationId?.toString() ?? null],
              [
                'Scan lat / lng',
                anchorScan.scanLatitude !== null && anchorScan.scanLongitude !== null
                  ? `${anchorScan.scanLatitude.toFixed(5)}, ${anchorScan.scanLongitude.toFixed(5)}`
                  : null,
              ],
              ['Ingest source', anchorScan.ingestSource],
              ['Webhook type', anchorScan.webhookType],
              ['Scanned at', formatTime(anchorScan.scannedAt)],
              ['Ingested at', formatTime(anchorScan.ingestedAt)],
              ['User agent', anchorScan.userAgent],
            ]}
          />
        </Card>
        <Card title="Sweed CRM link">
          {sweedLink === null ? (
            <p className="subtle-copy">CRM lookup not available for this scan.</p>
          ) : (
            <DescList
              entries={[
                ['Status', sweedLink.status],
                ['Dealer', String(sweedLink.dealerId)],
                ['Customer id', sweedLink.customerId?.toString() ?? null],
                ['Method', sweedLink.method],
                [
                  'Confidence',
                  sweedLink.confidence === null
                    ? null
                    : sweedLink.confidence.toFixed(2),
                ],
                ['Linked at', formatTime(sweedLink.linkedAt)],
                ['Display name', linkedCustomer?.displayName ?? null],
                ['Display address', linkedCustomer?.displayAddress ?? null],
                ['Display phone', linkedCustomer?.displayPhone ?? null],
                ['Display email', linkedCustomer?.displayEmail ?? null],
              ]}
            />
          )}
        </Card>
        {anchorScan.comments || anchorScan.profileComments || anchorScan.tags ? (
          <Card title="Comments / tags">
            <DescList
              entries={[
                ['Comments', anchorScan.comments],
                ['Profile comments', anchorScan.profileComments],
                ['Tags', anchorScan.tags],
              ]}
            />
          </Card>
        ) : null}
      </section>

      <section className="cd-table-card">
        <div className="cd-section-head">
          <h3>Prior check-ins ({priorVisits.length})</h3>
          {hasLink ? null : (
            <span className="subtle-copy">
              purchase columns appear once this visitor is linked to a Sweed customer
            </span>
          )}
        </div>
        {priorVisits.length === 0 ? (
          <p className="subtle-copy cd-empty">
            No other check-ins recorded for this person under{' '}
            <code>(provider, id_num)</code> or <code>person_key</code>.
          </p>
        ) : (
          <PriorVisitsTable rows={priorVisits} hasLink={hasLink} />
        )}
      </section>

      <section className="cd-table-card">
        <div className="cd-section-head">
          <h3>Purchase invoices ({purchaseInvoices.length}{data.purchaseInvoicesTruncated ? '+' : ''})</h3>
          {hasLink ? null : (
            <span className="subtle-copy">
              available once the scan is linked to a Sweed customer
            </span>
          )}
        </div>
        {!hasLink ? (
          <p className="subtle-copy cd-empty">
            Purchases load once the CRM link transitions to <code>linked</code>.
          </p>
        ) : purchaseInvoices.length === 0 ? (
          <p className="subtle-copy cd-empty">
            No Sweed orders on file for customer #{sweedLink?.customerId}.
          </p>
        ) : (
          <PurchaseInvoicesTable
            rows={purchaseInvoices}
            truncated={data.purchaseInvoicesTruncated}
            scanId={scanId}
          />
        )}
        {data.limitations.lineItemsNote !== null ? (
          <p className="subtle-copy cd-lineitems-note-text">
            {data.limitations.lineItemsNote}
          </p>
        ) : null}
      </section>

      <SweedSegmentsSection
        data={data}
        scanId={scanId}
        hasLink={hasLink}
        onRequestReload={onRequestReload}
      />

      <details className="cd-debug">
        <summary>Anchor scan raw envelope (JSON)</summary>
        <pre className="cd-debug-pre">{JSON.stringify(anchorScan.rawEnvelope, null, 2)}</pre>
      </details>

      {linkedCustomer?.rawMatch ? (
        <details className="cd-debug">
          <summary>Sweed customer raw match (JSON)</summary>
          <pre className="cd-debug-pre">{JSON.stringify(linkedCustomer.rawMatch, null, 2)}</pre>
        </details>
      ) : null}
    </section>
  )
}

// ---------------------------------------------------------------------
// Sweed marketing segments section (virusdave/top-level#12)
// ---------------------------------------------------------------------

const RefreshSegmentsResponseSchema = z.object({
  enqueued: z.boolean(),
  sweedCustomerId: z.number().int(),
  status: z.string(),
})

const SCOPE_ORDER: Record<'state' | 'site', number> = { state: 0, site: 1 }

function segmentTypeLabel(type: CustomerVisitorSegmentMembership['type']): string {
  if (type === 'static') return 'Static'
  if (type === 'dynamic') return 'Dynamic'
  return 'Unknown'
}

function groupByScope<T extends { scopeLevel: 'state' | 'site'; scopeLabel: string }>(
  items: T[],
): Array<{ scopeLevel: 'state' | 'site'; scopeLabel: string; items: T[] }> {
  const byKey = new Map<string, { scopeLevel: 'state' | 'site'; scopeLabel: string; items: T[] }>()
  for (const item of items) {
    const key = `${item.scopeLevel}:${item.scopeLabel}`
    const existing = byKey.get(key)
    if (existing) existing.items.push(item)
    else byKey.set(key, { scopeLevel: item.scopeLevel, scopeLabel: item.scopeLabel, items: [item] })
  }
  return [...byKey.values()].sort((a, b) => {
    const s = SCOPE_ORDER[a.scopeLevel] - SCOPE_ORDER[b.scopeLevel]
    return s !== 0 ? s : a.scopeLabel.localeCompare(b.scopeLabel)
  })
}

function formatDateShort(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

function SweedSegmentsSection({
  data,
  scanId,
  hasLink,
  onRequestReload,
}: {
  data: CustomerVisitorDetailsResponse
  scanId: number
  hasLink: boolean
  onRequestReload: () => void
}): JSX.Element {
  const { segments, addableStaticSegments, segmentsState } = data
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)

  const membershipGroups = groupByScope(segments)
  const addableGroups = groupByScope(addableStaticSegments)

  async function onRefresh(): Promise<void> {
    setBusy(true)
    setActionError(null)
    try {
      await mutateJson(
        `/api/admin/customers/visitors/${scanId}/refresh-segments`,
        RefreshSegmentsResponseSchema,
        { method: 'POST', body: JSON.stringify({}) },
      )
      // Reflect 'pending' immediately, then re-pull once the urgent
      // Sweed-pool job has had a moment to run.
      onRequestReload()
      setTimeout(onRequestReload, 3500)
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : 'Refresh failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="cd-table-card cd-segments">
      <div className="cd-section-head">
        <h3>Sweed segments ({segments.length})</h3>
        <div className="cd-segments-refresh">
          {segmentsState.refreshedAt ? (
            <span className="subtle-copy">
              cached {formatDateShort(segmentsState.refreshedAt)}
              {segmentsState.status === 'pending' ? ' · refresh queued…' : ''}
              {segmentsState.status === 'failed' ? ' · last refresh failed' : ''}
            </span>
          ) : (
            <span className="subtle-copy">
              {segmentsState.status === 'pending' ? 'refresh queued…' : 'not yet fetched'}
            </span>
          )}
          {hasLink ? (
            <button type="button" className="cd-btn" onClick={() => void onRefresh()} disabled={busy}>
              {busy ? 'Refreshing…' : 'Refresh segments'}
            </button>
          ) : null}
        </div>
      </div>

      {actionError ? <p className="cd-error subtle-copy">{actionError}</p> : null}
      {segmentsState.status === 'failed' && segmentsState.lastError ? (
        <p className="cd-error subtle-copy">Sweed error: {segmentsState.lastError}</p>
      ) : null}

      {!hasLink ? (
        <p className="subtle-copy cd-empty">
          Segments load once the CRM link transitions to <code>linked</code>.
        </p>
      ) : segments.length === 0 ? (
        <p className="subtle-copy cd-empty">
          {segmentsState.status === 'never'
            ? 'No segment data cached yet — click “Refresh segments”.'
            : 'This customer is not in any Sweed marketing segments.'}
        </p>
      ) : (
        <div className="cd-segment-groups">
          {membershipGroups.map((group) => (
            <div className="cd-segment-group" key={`${group.scopeLevel}:${group.scopeLabel}`}>
              <h4 className="cd-segment-scope">
                {group.scopeLevel === 'state' ? 'State-wide' : `Site · ${group.scopeLabel}`}
              </h4>
              <ul className="cd-segment-list">
                {group.items.map((seg) => (
                  <li className="cd-segment-row" key={seg.segmentId}>
                    <span className="cd-segment-name">{seg.name}</span>
                    <Pill tone={seg.type === 'static' ? 'success' : 'muted'}>
                      {segmentTypeLabel(seg.type)}
                    </Pill>
                    {seg.enabled === false ? <Pill tone="warning">disabled</Pill> : null}
                    <span className="subtle-copy cd-segment-since">
                      since {formatDateShort(seg.dateOnEnter)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}

      {/* Add-to-static-segment affordance. Programmatic add is blocked
          by Sweed's API (every member-add RPC returns "Action is not
          available"), so we link the operator into Sweed Prime instead
          of shipping a button that silently fails. */}
      {hasLink ? (
        <div className="cd-segments-add">
          <h4 className="cd-segment-scope">Add to a static segment</h4>
          <p className="subtle-copy cd-segments-add-note">
            Helios can’t write Sweed segment membership yet — Sweed’s API rejects every
            member-add call (<code>Action is not available</code>). Open the segment in Sweed
            Prime and add this customer there.{' '}
            {segmentsState.sweedCustomerId !== null ? (
              <>
                Sweed customer ID: <code>{segmentsState.sweedCustomerId}</code>
              </>
            ) : null}
          </p>
          {addableStaticSegments.length === 0 ? (
            <p className="subtle-copy cd-empty">
              No additional static segments available
              {segmentsState.status === 'never' ? ' (refresh to load the catalog).' : '.'}
            </p>
          ) : (
            <div className="cd-segment-groups">
              {addableGroups.map((group) => (
                <div
                  className="cd-segment-group"
                  key={`add:${group.scopeLevel}:${group.scopeLabel}`}
                >
                  <h5 className="cd-segment-scope">
                    {group.scopeLevel === 'state' ? 'State-wide' : `Site · ${group.scopeLabel}`}
                  </h5>
                  <ul className="cd-segment-list">
                    {group.items.map((seg: CustomerVisitorAddableSegment) => (
                      <li className="cd-segment-row" key={seg.segmentId}>
                        <span className="cd-segment-name">{seg.name}</span>
                        <a
                          className="cd-btn cd-btn-link"
                          href={seg.sweedPrimeUrl}
                          target="_blank"
                          rel="noreferrer noopener"
                        >
                          Open in Sweed Prime ↗
                        </a>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          )}
        </div>
      ) : null}
    </section>
  )
}

// ---------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------

function KpiCell({
  label,
  value,
  sub,
}: {
  label: string
  value: string
  sub: string
}): JSX.Element {
  return (
    <div>
      <span className="cd-answer-label">{label}</span>
      <div className="cd-answer-value">{value}</div>
      {sub ? <div className="subtle-copy">{sub}</div> : null}
    </div>
  )
}

function Card({ title, children }: { title: string; children: React.ReactNode }): JSX.Element {
  return (
    <article className="cd-card">
      <h4 className="cd-card-title">{title}</h4>
      {children}
    </article>
  )
}

function DescList({
  entries,
}: {
  entries: ReadonlyArray<readonly [string, string | null | undefined]>
}): JSX.Element {
  const filtered = entries.filter(
    ([, value]) => value !== null && value !== undefined && value !== '',
  )
  if (filtered.length === 0) {
    return <p className="subtle-copy">No data on file.</p>
  }
  return (
    <dl className="cd-dl">
      {filtered.map(([label, value]) => (
        <div className="cd-dl-row" key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  )
}

function MapLegend({ points }: { points: readonly CustomerVisitorMapPoint[] }): JSX.Element {
  const kinds = Array.from(new Set(points.map((p) => p.kind)))
  if (kinds.length === 0) return <span />
  return (
    <ul className="cd-map-legend">
      {kinds.map((k) => (
        <li key={k}>
          <span className="cd-map-dot" style={{ background: POINT_COLORS[k] }} />
          {POINT_LABELS[k]}
        </li>
      ))}
    </ul>
  )
}

function PriorVisitsTable({
  rows,
  hasLink,
}: {
  rows: readonly CustomerVisitorPriorVisit[]
  hasLink: boolean
}): JSX.Element {
  return (
    <div className="cd-table-scroll">
      <table className="cd-table">
        <thead>
          <tr>
            <th>When</th>
            <th>Site</th>
            <th>Match</th>
            <th>Address</th>
            <th>State / Zip</th>
            <th>Doc</th>
            <th>Status</th>
            {hasLink ? <th>Orders that day</th> : null}
            {hasLink ? <th>$ that day</th> : null}
            <th></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id}>
              <td className="cd-cell-time">{formatTime(row.visitAt)}</td>
              <td>{row.siteSlug}</td>
              <td>
                <Pill tone={row.matchKind === 'person_key' ? 'muted' : 'success'}>
                  {row.matchKind === 'both'
                    ? 'id + name'
                    : row.matchKind === 'id_num'
                      ? 'same ID'
                      : 'same name+DOB'}
                </Pill>
              </td>
              <td className="cd-cell-truncate">{row.address ?? '—'}</td>
              <td>
                {[row.state, row.postalCode].filter((p) => p && p.length > 0).join(' ') || '—'}
              </td>
              <td>{row.documentType ?? '—'}</td>
              <td>{row.scanStatus ?? '—'}</td>
              {hasLink ? (
                <td className="cd-cell-num">{row.purchaseSummary?.orderCount ?? '—'}</td>
              ) : null}
              {hasLink ? (
                <td className="cd-cell-num">
                  {row.purchaseSummary
                    ? `$${row.purchaseSummary.grandTotalDollars.toFixed(2)}`
                    : '—'}
                </td>
              ) : null}
              <td>
                <a
                  className="ghost-button cd-row-open"
                  href={buildAppPath(row.customerUrl)}
                >
                  Open
                </a>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// Number of table columns (the expanded line-item row spans them all).
const PURCHASE_TABLE_COLSPAN = 11

type LineItemsState =
  | { status: 'loading' }
  | { status: 'loaded'; items: readonly CustomerVisitorLineItem[] }
  | { status: 'error'; error: string }

// Hover-zoom preview. Rendered as a viewport-fixed overlay (not a CSS
// transform on the thumbnail) so it can't be clipped by the
// horizontally-scrolling table wrapper. The preview reuses the exact
// same image URL as the thumbnail, which the browser has already
// downloaded, so hovering costs no extra network.
interface ThumbPreview {
  url: string
  x: number
  y: number
}
interface ThumbPreviewApi {
  show: (url: string, x: number, y: number) => void
  move: (x: number, y: number) => void
  hide: () => void
}
const ThumbPreviewContext = createContext<ThumbPreviewApi | null>(null)

// Pointer must be a real mouse (not touch) for hover-zoom to make
// sense; touch devices fall back to tap → open full image.
function pointerCanHover(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(hover: hover) and (pointer: fine)').matches
  )
}

function PurchaseInvoicesTable({
  rows,
  truncated,
  scanId,
}: {
  rows: readonly CustomerVisitorPurchaseInvoice[]
  truncated: boolean
  scanId: number
}): JSX.Element {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set())
  const [itemsByKey, setItemsByKey] = useState<Record<string, LineItemsState>>({})
  const [preview, setPreview] = useState<ThumbPreview | null>(null)

  const previewApi = useMemo<ThumbPreviewApi>(
    () => ({
      show: (url, x, y) => setPreview({ url, x, y }),
      move: (x, y) => setPreview((p) => (p === null ? p : { ...p, x, y })),
      hide: () => setPreview(null),
    }),
    [],
  )

  function loadItems(key: string, invoiceId: string): void {
    setItemsByKey((prev) => ({ ...prev, [key]: { status: 'loading' } }))
    void (async () => {
      try {
        const res = await loadJson(
          `/api/admin/customers/visitors/${scanId}/invoices/${encodeURIComponent(
            invoiceId,
          )}/items`,
          CustomerVisitorInvoiceItemsResponseSchema,
        )
        setItemsByKey((prev) => ({
          ...prev,
          [key]: { status: 'loaded', items: res.lineItems },
        }))
      } catch (cause) {
        setItemsByKey((prev) => ({
          ...prev,
          [key]: {
            status: 'error',
            error: cause instanceof Error ? cause.message : 'Failed to load items',
          },
        }))
      }
    })()
  }

  function toggle(key: string, invoiceId: string, count: number): void {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(key)) {
        next.delete(key)
      } else {
        next.add(key)
        // Lazy-fetch only on first open, and only when there's
        // something to fetch.
        if (count > 0 && itemsByKey[key] === undefined) {
          loadItems(key, invoiceId)
        }
      }
      return next
    })
  }

  return (
    <ThumbPreviewContext.Provider value={previewApi}>
    <div className="cd-table-scroll">
      <table className="cd-table cd-purchase-table">
        <thead>
          <tr>
            <th aria-label="Expand" />
            <th>When</th>
            <th>Invoice</th>
            <th>Items</th>
            <th>Grand total</th>
            <th>Subtotal</th>
            <th>Tax</th>
            <th>Discount</th>
            <th>Fulfillment</th>
            <th>Payment</th>
            <th>Delivery</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const key = `${row.dealerId}:${row.invoiceId}`
            const isOpen = expanded.has(key)
            const hasItems = row.lineItemCount > 0
            const itemsState = itemsByKey[key]
            return (
              <Fragment key={key}>
                <tr className={isOpen ? 'cd-invoice-row is-open' : 'cd-invoice-row'}>
                  <td className="cd-cell-expander">
                    <button
                      type="button"
                      className="cd-expand-btn"
                      aria-expanded={isOpen}
                      aria-label={isOpen ? 'Hide items' : 'Show items'}
                      disabled={!hasItems}
                      onClick={() => toggle(key, row.invoiceId, row.lineItemCount)}
                    >
                      {hasItems ? (isOpen ? '▾' : '▸') : '·'}
                    </button>
                  </td>
                  <td className="cd-cell-time">{formatTime(row.payTime)}</td>
                  <td>
                    <code className="cd-invoice-code">{row.invoiceId}</code>
                  </td>
                  <td className="cd-cell-num">{hasItems ? row.lineItemCount : '—'}</td>
                  <td className="cd-cell-num">${row.grandTotalDollars.toFixed(2)}</td>
                  <td className="cd-cell-num">
                    {row.subtotalDollars !== null
                      ? `$${row.subtotalDollars.toFixed(2)}`
                      : '—'}
                  </td>
                  <td className="cd-cell-num">
                    {row.taxDollars !== null ? `$${row.taxDollars.toFixed(2)}` : '—'}
                  </td>
                  <td className="cd-cell-num">
                    {row.discountDollars !== null
                      ? `$${row.discountDollars.toFixed(2)}`
                      : '—'}
                  </td>
                  <td>{row.fulfillmentType ?? '—'}</td>
                  <td>{row.paymentMethod ?? '—'}</td>
                  <td className="cd-cell-truncate">
                    {row.deliveryZip ??
                      row.deliveryAddress?.line1 ??
                      row.deliveryAddress?.normalized ??
                      '—'}
                  </td>
                </tr>
                {isOpen ? (
                  <tr className="cd-invoice-items-row">
                    <td colSpan={PURCHASE_TABLE_COLSPAN}>
                      <LineItemsPanel state={itemsState} />
                    </td>
                  </tr>
                ) : null}
              </Fragment>
            )
          })}
        </tbody>
      </table>
      {truncated ? (
        <p className="subtle-copy">
          ⚠ Showing the most recent {rows.length} invoices only. Older history is on file but
          truncated to keep the response bounded.
        </p>
      ) : null}
    </div>
      {preview !== null ? <ThumbPreviewOverlay preview={preview} /> : null}
    </ThumbPreviewContext.Provider>
  )
}

function ThumbPreviewOverlay({ preview }: { preview: ThumbPreview }): JSX.Element {
  // Clamp a ~300px preview to the viewport, offset from the cursor.
  const size = 300
  const pad = 12
  const vw = typeof window !== 'undefined' ? window.innerWidth : size + pad
  const vh = typeof window !== 'undefined' ? window.innerHeight : size + pad
  let left = preview.x + 20
  let top = preview.y + 20
  if (left + size + pad > vw) left = preview.x - size - 20
  if (top + size + pad > vh) top = Math.max(pad, vh - size - pad)
  if (left < pad) left = pad
  return (
    <div className="cd-thumb-preview" style={{ left, top, width: size, height: size }}>
      <img src={preview.url} alt="" />
    </div>
  )
}

function LineItemsPanel({ state }: { state: LineItemsState | undefined }): JSX.Element {
  if (state === undefined || state.status === 'loading') {
    return <p className="subtle-copy cd-lineitems-status">Loading items…</p>
  }
  if (state.status === 'error') {
    return (
      <p className="subtle-copy cd-lineitems-status cd-lineitems-error">
        Couldn’t load items: {state.error}
      </p>
    )
  }
  if (state.items.length === 0) {
    return (
      <p className="subtle-copy cd-lineitems-status">
        No itemised products recorded for this invoice.
      </p>
    )
  }
  return (
    <div className="cd-lineitem-grid">
      {state.items.map((item) => (
        <LineItemCard key={item.itemOrdinal} item={item} />
      ))}
    </div>
  )
}

function LineItemCard({ item }: { item: CustomerVisitorLineItem }): JSX.Element {
  const label = item.productName ?? item.shortName ?? item.inventoryItemId ?? 'Unknown product'
  return (
    <article className="cd-lineitem-card">
      <ProductThumb imageUrl={item.imageUrl} label={label} />
      <div className="cd-lineitem-body">
        <strong className="cd-lineitem-name" title={label}>
          {label}
        </strong>
        <div className="cd-lineitem-meta subtle-copy">
          {item.category ?? 'Uncategorised'}
        </div>
        <div className="cd-lineitem-figs">
          <span>Qty {item.qty ?? '—'}</span>
          <span>
            {item.revenueDollars !== null ? `$${item.revenueDollars.toFixed(2)}` : '—'}
          </span>
        </div>
        {item.status !== null && !isDefaultItemStatus(item.status) ? (
          <Pill tone={toneForItemStatus(item.status)}>{item.status}</Pill>
        ) : null}
      </div>
    </article>
  )
}

function ProductThumb({
  imageUrl,
  label,
}: {
  imageUrl: string | null
  label: string
}): JSX.Element {
  const preview = useContext(ThumbPreviewContext)
  if (imageUrl === null) {
    return <div className="cd-lineitem-thumb cd-lineitem-thumb-empty">No image</div>
  }
  return (
    <a
      className="cd-lineitem-thumb-link"
      href={imageUrl}
      target="_blank"
      rel="noreferrer"
      aria-label={`Open full-size image for ${label}`}
      onMouseEnter={(e) => {
        if (preview !== null && pointerCanHover()) preview.show(imageUrl, e.clientX, e.clientY)
      }}
      onMouseMove={(e) => {
        if (preview !== null && pointerCanHover()) preview.move(e.clientX, e.clientY)
      }}
      onMouseLeave={() => {
        if (preview !== null) preview.hide()
      }}
    >
      <img
        className="cd-lineitem-thumb"
        src={imageUrl}
        alt={label}
        loading="lazy"
        decoding="async"
        // @ts-expect-error fetchpriority is valid HTML but not yet in
        // the React DOM typings on this version.
        fetchpriority="low"
        onError={(e) => {
          const el = e.currentTarget
          el.style.display = 'none'
          el.parentElement?.classList.add('is-broken')
        }}
      />
    </a>
  )
}

// "New" / "Paid" are the normal happy-path statuses for a completed
// sale; we don't badge them (it's just noise on every card). Anything
// else (refund / return / canceled / in-process) gets a tone-coded
// pill.
function isDefaultItemStatus(status: string): boolean {
  const s = status.trim().toLowerCase()
  return s === 'paid' || s === 'new'
}

function toneForItemStatus(status: string): 'danger' | 'warning' | 'muted' | 'success' {
  const s = status.trim().toLowerCase()
  if (s.includes('refund') || s.includes('return')) return 'danger'
  if (s.includes('cancel')) return 'muted'
  if (s.includes('exchange') || s.includes('issue') || s.includes('process')) return 'warning'
  return 'muted'
}

// ---------------------------------------------------------------------
// Map component
// ---------------------------------------------------------------------

function CustomerVisitorMap({
  points,
}: {
  points: readonly CustomerVisitorMapPoint[]
}): JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const mapRef = useRef<maplibregl.Map | null>(null)
  const popupRef = useRef<maplibregl.Popup | null>(null)

  // Stable GeoJSON; reduce useEffect churn by serialising via JSON
  // identity (small payload, predictable).
  const featureCollection = useMemo(
    () => ({
      type: 'FeatureCollection' as const,
      features: points.map((p) => ({
        type: 'Feature' as const,
        geometry: { type: 'Point' as const, coordinates: [p.lng, p.lat] as [number, number] },
        properties: {
          id: p.id,
          kind: p.kind,
          label: p.label,
          color: POINT_COLORS[p.kind],
          firstSeenAt: p.firstSeenAt,
          lastSeenAt: p.lastSeenAt,
          orderCount: p.orderCount,
          totalSpendDollars: p.totalSpendDollars,
          addressLine1: p.address?.line1 ?? null,
          addressCity: p.address?.city ?? null,
          addressState: p.address?.state ?? null,
          addressZip: p.address?.zip ?? null,
        },
      })),
    }),
    [points],
  )

  useEffect(() => {
    if (!containerRef.current || mapRef.current !== null) return
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: MAP_STYLE,
      center: [-73.95, 40.78],
      zoom: 10.5,
      attributionControl: { compact: true },
    })
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right')
    // Browser-fullscreen toggle so the reviewer can blow this map
    // up to the full viewport without having to leave the details
    // page. Built-in MapLibre control; standard ⛶ icon.
    map.addControl(new maplibregl.FullscreenControl(), 'top-right')
    mapRef.current = map
    return () => {
      popupRef.current?.remove()
      popupRef.current = null
      map.remove()
      mapRef.current = null
    }
  }, [])

  useEffect(() => {
    const map = mapRef.current
    if (map === null) return

    const apply = () => {
      const src = map.getSource('visitor-details') as maplibregl.GeoJSONSource | undefined
      if (src === undefined) {
        map.addSource('visitor-details', { type: 'geojson', data: featureCollection })
        map.addLayer({
          id: 'visitor-details-halo',
          type: 'circle',
          source: 'visitor-details',
          paint: {
            'circle-radius': 11,
            'circle-color': '#ffffff',
            'circle-opacity': 0.9,
            'circle-stroke-color': ['get', 'color'],
            'circle-stroke-width': 1,
          },
        })
        map.addLayer({
          id: 'visitor-details-dots',
          type: 'circle',
          source: 'visitor-details',
          paint: {
            'circle-radius': 7,
            'circle-color': ['get', 'color'],
            'circle-stroke-color': '#ffffff',
            'circle-stroke-width': 1.5,
          },
        })
        map.on('click', 'visitor-details-dots', (e) => {
          const feat = e.features?.[0]
          if (!feat) return
          const props = feat.properties ?? {}
          if (feat.geometry.type !== 'Point') return
          const coords = feat.geometry.coordinates as [number, number]
          popupRef.current?.remove()
          popupRef.current = new maplibregl.Popup({ closeButton: true, maxWidth: '320px' })
            .setLngLat(coords)
            .setHTML(renderPopup(props))
            .addTo(map)
        })
        map.on('mouseenter', 'visitor-details-dots', () => {
          map.getCanvas().style.cursor = 'pointer'
        })
        map.on('mouseleave', 'visitor-details-dots', () => {
          map.getCanvas().style.cursor = ''
        })
      } else {
        src.setData(featureCollection)
      }

      // Fit to all points (one or many).
      if (featureCollection.features.length > 0) {
        if (featureCollection.features.length === 1) {
          map.flyTo({
            center: featureCollection.features[0].geometry.coordinates,
            zoom: 13,
            duration: 0,
          })
        } else {
          const bounds = new maplibregl.LngLatBounds()
          for (const f of featureCollection.features) {
            bounds.extend(f.geometry.coordinates as [number, number])
          }
          map.fitBounds(bounds, { padding: 60, maxZoom: 14, duration: 0 })
        }
      }
    }

    if (map.isStyleLoaded()) {
      apply()
    } else {
      map.once('load', apply)
    }
  }, [featureCollection])

  return <div ref={containerRef} className="cd-map" />
}

function renderPopup(props: Record<string, unknown>): string {
  const label = String(props.label ?? '')
  const kind = String(props.kind ?? '')
  const lines = [
    `<div class="cd-popup-kind" style="color:${escapeHtml(String(props.color ?? '#333'))}">${escapeHtml(
      POINT_LABELS[kind as CustomerVisitorMapPoint['kind']] ?? kind,
    )}</div>`,
    `<div class="cd-popup-label">${escapeHtml(label)}</div>`,
  ]
  const addrParts = [props.addressLine1, props.addressCity, props.addressState, props.addressZip]
    .filter((v): v is string => typeof v === 'string' && v.length > 0)
    .map((v) => escapeHtml(v))
  if (addrParts.length > 0) {
    lines.push(`<div class="cd-popup-addr">${addrParts.join(', ')}</div>`)
  }
  if (props.orderCount !== null && props.orderCount !== undefined) {
    const n = Number(props.orderCount)
    if (Number.isFinite(n) && n > 0) {
      const dollars =
        typeof props.totalSpendDollars === 'number'
          ? props.totalSpendDollars.toFixed(2)
          : null
      lines.push(
        `<div class="cd-popup-meta">${n} order${n === 1 ? '' : 's'}${
          dollars !== null ? ` · $${escapeHtml(dollars)}` : ''
        }</div>`,
      )
    }
  }
  if (props.lastSeenAt && typeof props.lastSeenAt === 'string') {
    lines.push(
      `<div class="cd-popup-meta subtle-copy">last seen ${escapeHtml(
        // NY-local — see formatTime() below for the rationale (canon
        // rule: always render in America/New_York).
        new Date(props.lastSeenAt).toLocaleString('en-US', {
          hour12: false,
          timeZone: NY_TZ_DISPLAY,
        }),
      )}</div>`,
    )
  }
  return lines.join('')
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

// ---------------------------------------------------------------------
// Small formatting helpers
// ---------------------------------------------------------------------

function formatName(scan: CustomerVisitorAnchorScan): string {
  const parts = [scan.firstName, scan.middleName, scan.lastName].filter(
    (p): p is string => p !== null && p.length > 0,
  )
  return parts.length === 0 ? `Visitor #${scan.id}` : parts.join(' ')
}

// Display formatters below render in **America/New_York** per the
// AGENTS.md canon rule ("Always use NY timezones for aggregate and
// display unless instructed otherwise"). Every customer visit /
// purchase happens at a NYC store, so the operator always expects to
// see times in NY wall-clock regardless of their browser timezone.
const NY_TZ_DISPLAY = 'America/New_York'

function formatTime(iso: string | null | undefined): string {
  if (!iso) return '—'
  try {
    return new Date(iso).toLocaleString('en-US', {
      hour12: false,
      timeZone: NY_TZ_DISPLAY,
    })
  } catch {
    return iso
  }
}

function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—'
  try {
    return new Date(iso).toLocaleDateString('en-US', { timeZone: NY_TZ_DISPLAY })
  } catch {
    return iso
  }
}

function computeStatusPills(
  data: CustomerVisitorDetailsResponse,
): Array<{ label: string; tone: 'success' | 'warning' | 'danger' | 'muted' }> {
  const out: Array<{ label: string; tone: 'success' | 'warning' | 'danger' | 'muted' }> = []
  const anchor = data.anchorScan
  const sweed = anchor.sweedLink
  const lifetime = data.purchaseLifetime
  if (lifetime !== null && lifetime.hasPriorPurchaseBeforeScan) {
    out.push({ label: 'Known purchaser', tone: 'success' })
  } else if (!anchor.identity.isFirstScanByIdNum) {
    out.push({ label: 'Returning visitor', tone: 'success' })
  } else {
    out.push({ label: 'First scan', tone: 'warning' })
  }
  if (sweed === null) {
    out.push({ label: 'CRM lookup unavailable', tone: 'muted' })
  } else if (sweed.status === 'linked' && sweed.customerId !== null) {
    out.push({ label: `Linked #${sweed.customerId}`, tone: 'success' })
  } else if (sweed.status === 'pending') {
    out.push({ label: 'CRM lookup pending', tone: 'muted' })
  } else if (sweed.status === 'ambiguous') {
    out.push({ label: 'CRM needs review', tone: 'warning' })
  } else if (sweed.status === 'no_match') {
    out.push({ label: 'No CRM match', tone: 'muted' })
  } else if (sweed.status === 'insufficient_data') {
    out.push({ label: 'CRM lookup skipped', tone: 'muted' })
  } else if (sweed.status === 'failed') {
    out.push({ label: 'CRM lookup failed', tone: 'danger' })
  } else if (sweed.status === 'rejected') {
    out.push({ label: 'CRM match rejected', tone: 'muted' })
  }
  return out
}

function describeLink(
  link: CustomerVisitorAnchorScan['sweedLink'],
): string {
  if (link === null) return '—'
  if (link.status === 'linked') {
    return link.method !== null ? `linked via ${link.method}` : 'linked'
  }
  if (link.status === 'pending') return 'background worker will probe Sweed'
  if (link.status === 'ambiguous') return 'multiple candidates — needs review'
  if (link.status === 'no_match') return 'no candidate found in Sweed'
  if (link.status === 'insufficient_data') return 'not enough identifying data'
  if (link.status === 'failed') return 'last probe failed'
  if (link.status === 'rejected') return 'previously rejected'
  return link.status
}
