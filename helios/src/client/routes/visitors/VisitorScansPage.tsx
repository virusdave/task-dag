// Operator-facing view of the visitor_scans table.
//
// virusdave/top-level#9 / FreshlyBakedNYC/automation#31, phase A3.
//
// Paginated newest-first table backed by GET /api/visitors/scans;
// supports site / state / postal-prefix / scan-status / document-type
// / ingest-source / date-range filters. Clicking a row opens a
// drawer with the full normalised row plus a JSON view of
// `raw_envelope`. "Export CSV" hits /api/visitors/scans.csv with
// the *current* filter — single source of truth, no second query.
//
// Per helios AGENTS.md the table IS the answer, so:
//   * the table is first/visible by default;
//   * filters, methodology, and stats are inside collapsed
//     <details> so they don't shove the table off-screen,
//     especially on mobile;
//   * on narrow viewports (≤720px) the table reflows to a
//     stacked card-list so it stays usable on a phone instead
//     of forcing a horizontal scroll across 10 columns.

import { useEffect, useMemo, useState } from 'react'
import { useLoaderData, useSearchParams } from 'react-router-dom'

import {
  VisitorScansResponseSchema,
  type VisitorScanItem,
  type VisitorScansResponse,
} from '../../../shared/contracts/index.js'
import { loadJson } from '../../app/fetchJson.js'
import { buildAppPath } from '../../app/paths.js'
import { Pill } from '../../components/Pill.js'
import { MiniGeoMarker } from './MiniGeoMarker.js'

type PillTone = 'success' | 'warning' | 'danger' | 'muted'

/**
 * COLOR-CODED primary indicator. We can only answer the actionable
 * question — "is this a brand-new paying customer or a returning
 * one?" — once the Sweed CRM link is resolved.
 *
 *   'New'        — Sweed-linked + no prior purchases. Warning tone:
 *                  this is the on-floor moment to capture them.
 *   'Returning'  — Sweed-linked + ≥1 prior purchase. Success tone.
 *   null         — link not yet resolved; the CRM-status pill carries
 *                  the explanation. We don't fake a 'New' label when
 *                  we don't actually know.
 */
function newOrReturningPill(
  item: VisitorScanItem,
): { label: string; tone: PillTone } | null {
  const sweed = item.sweedLink
  const summary = item.sweedPurchaseSummary
  if (sweed === null || sweed.status !== 'linked' || sweed.customerId === null) {
    return null
  }
  if (summary !== null && summary.hasPriorPurchaseBeforeScan) {
    return { label: 'Returning', tone: 'success' }
  }
  return { label: 'New', tone: 'warning' }
}

/**
 * Independent of CRM matching — strict NOT EXISTS check over
 * `visitor_scans` rows with the same `(provider, id_num)`. Just a
 * neutral count badge; not color-coded by design.
 */
function firstScanBadge(item: VisitorScanItem): { label: string; tone: PillTone } {
  if (item.identity.priorIdNumScanCount === 0) {
    return { label: 'First scan', tone: 'muted' }
  }
  return { label: `${item.identity.priorIdNumScanCount}× scanned`, tone: 'muted' }
}

/** CRM lookup status. Always present once a link row exists. */
function crmPill(item: VisitorScanItem): { label: string; tone: PillTone } | null {
  const sweed = item.sweedLink
  if (sweed === null) return null
  if (sweed.status === 'linked' && sweed.customerId !== null) {
    return { label: `#${sweed.customerId}`, tone: 'success' }
  }
  if (sweed.status === 'ambiguous') {
    return { label: `Review ${sweed.candidateCount}`, tone: 'warning' }
  }
  if (sweed.status === 'pending') return { label: 'CRM pending', tone: 'muted' }
  if (sweed.status === 'no_match') return { label: 'No CRM', tone: 'muted' }
  if (sweed.status === 'insufficient_data') return { label: 'CRM skipped', tone: 'muted' }
  if (sweed.status === 'failed') return { label: 'CRM failed', tone: 'danger' }
  if (sweed.status === 'rejected') return { label: 'CRM rejected', tone: 'muted' }
  return null
}

export async function visitorScansLoader({ request }: { request: Request }) {
  const url = new URL(request.url)
  return loadJson(`/api/visitors/scans${url.search}`, VisitorScansResponseSchema)
}

function formatTime(iso: string | null): string {
  if (iso === null) return '—'
  try {
    return new Date(iso).toLocaleString(undefined, { hour12: false })
  } catch {
    return iso
  }
}

function formatName(item: VisitorScanItem): string {
  const parts = [item.firstName, item.middleName, item.lastName].filter(
    (p): p is string => p !== null && p.length > 0,
  )
  return parts.length === 0 ? '—' : parts.join(' ')
}

const FILTER_KEYS = [
  'siteSlugs',
  'ingestSources',
  'states',
  'postalPrefix',
  'documentType',
  'scanStatus',
  'scannedAfter',
  'scannedBefore',
  'limit',
] as const

function hasActiveFilter(params: URLSearchParams): boolean {
  for (const key of FILTER_KEYS) {
    const v = params.get(key)
    if (v !== null && v.trim().length > 0 && !(key === 'limit' && v === '100')) {
      return true
    }
  }
  return false
}

// localStorage key for the show-maps preference. Persisted so the
// operator's choice survives reloads/navigation; rendered as a small
// toggle in the page header.
const SHOW_MAPS_STORAGE_KEY = 'visitorScans.showMaps'

function readShowMapsPref(): boolean {
  if (typeof window === 'undefined') return true
  try {
    const v = window.localStorage.getItem(SHOW_MAPS_STORAGE_KEY)
    if (v === null) return true
    return v !== '0' && v !== 'false'
  } catch {
    return true
  }
}

function writeShowMapsPref(showMaps: boolean): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(SHOW_MAPS_STORAGE_KEY, showMaps ? '1' : '0')
  } catch {
    // Quota / disabled-storage / private mode — ignore; the in-memory
    // toggle still works for this session.
  }
}

export function VisitorScansPage() {
  const initialData = useLoaderData() as VisitorScansResponse
  const [searchParams, setSearchParams] = useSearchParams()
  const [data, setData] = useState<VisitorScansResponse>(initialData)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<VisitorScanItem | null>(null)
  // Maps-visible toggle (per-row mini-map column + mobile-card map).
  // Defaults ON; remembered across reloads in localStorage so a power
  // user who prefers a denser table doesn't have to re-hide them on
  // every visit.
  const [showMaps, setShowMaps] = useState<boolean>(() => readShowMapsPref())
  function handleToggleMaps(): void {
    setShowMaps((prev) => {
      const next = !prev
      writeShowMapsPref(next)
      return next
    })
  }

  // Re-fetch whenever the filter changes, AND on a 20-second tick
  // so the page stays effectively-live for the operator behind the
  // counter (FreshlyBakedNYC/automation#33 phase C1). The interval
  // tears down on filter change so we never stack multiple
  // overlapping timers.
  useEffect(() => {
    let cancelled = false
    async function refresh(): Promise<void> {
      try {
        const next = await loadJson(
          `/api/visitors/scans?${searchParams.toString()}`,
          VisitorScansResponseSchema,
        )
        if (!cancelled) {
          setData(next)
          setError(null)
        }
      } catch (cause) {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : 'Failed to load visitor scans.')
        }
      }
    }
    void refresh()
    const id = window.setInterval(() => {
      void refresh()
    }, 20_000)
    return () => {
      cancelled = true
      window.clearInterval(id)
    }
  }, [searchParams])

  const counts = useMemo(() => {
    const bySite = new Map<string, number>()
    const byIngest = new Map<string, number>()
    for (const item of data.items) {
      bySite.set(item.siteSlug, (bySite.get(item.siteSlug) ?? 0) + 1)
      byIngest.set(item.ingestSource, (byIngest.get(item.ingestSource) ?? 0) + 1)
    }
    return { bySite, byIngest }
  }, [data.items])

  const csvHref = `api/visitors/scans.csv?${searchParams.toString()}`
  const filtersActive = hasActiveFilter(searchParams)

  function handleFilterSubmit(event: React.FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const next = new URLSearchParams()
    for (const [key, value] of form.entries()) {
      if (typeof value === 'string' && value.trim().length > 0) {
        next.set(key, value.trim())
      }
    }
    setSearchParams(next)
  }

  function handleClearFilters(): void {
    setSearchParams(new URLSearchParams())
  }

  return (
    <section className="visitor-scans-page">
      <header className="vs-header">
        <h2 className="vs-title">Visitor Scans</h2>
        <div className="vs-actions">
          <button
            type="button"
            className="ghost-button vs-action vs-maps-toggle"
            onClick={handleToggleMaps}
            aria-pressed={showMaps}
            title={
              showMaps
                ? 'Hide per-row map thumbnails and sensitive location fields (state, zip, city)'
                : 'Show per-row map thumbnails and sensitive location fields (state, zip, city)'
            }
          >
            {showMaps ? 'Expanded: on' : 'Expanded: off'}
          </button>
          <a className="ghost-button vs-action" href={csvHref}>
            Export CSV
          </a>
        </div>
      </header>

      <div className="vs-stats">
        <Pill tone="muted">{`${data.items.length} shown`}</Pill>
        {[...counts.bySite.entries()].map(([slug, n]) => (
          <Pill key={`site-${slug}`} tone="muted">{`${slug}: ${n}`}</Pill>
        ))}
        {[...counts.byIngest.entries()].map(([src, n]) => (
          <Pill
            key={`src-${src}`}
            tone={src === 'webhook' ? 'success' : 'muted'}
          >{`${src}: ${n}`}</Pill>
        ))}
        {data.hasMore ? <Pill tone="warning">more rows — narrow filter</Pill> : null}
      </div>

      <details className="vs-filters" open={filtersActive}>
        <summary>
          <span>Filters</span>
          {filtersActive ? <Pill tone="success">active</Pill> : null}
        </summary>
        <form className="vs-filter-form" method="get" onSubmit={handleFilterSubmit}>
          <label className="vs-field">
            <span>Site</span>
            <select defaultValue={searchParams.get('siteSlugs') ?? ''} name="siteSlugs">
              <option value="">All sites</option>
              <option value="bx">Bronx (bx)</option>
              <option value="mh">Midtown (mh)</option>
            </select>
          </label>
          <label className="vs-field">
            <span>Source</span>
            <select
              defaultValue={searchParams.get('ingestSources') ?? ''}
              name="ingestSources"
            >
              <option value="">Any source</option>
              <option value="webhook">webhook</option>
              <option value="backfill">backfill</option>
            </select>
          </label>
          <label className="vs-field">
            <span>State</span>
            <input
              defaultValue={searchParams.get('states') ?? ''}
              name="states"
              placeholder="NY, NJ, …"
              maxLength={32}
              inputMode="text"
              autoCapitalize="characters"
            />
          </label>
          <label className="vs-field">
            <span>Postal prefix</span>
            <input
              defaultValue={searchParams.get('postalPrefix') ?? ''}
              name="postalPrefix"
              placeholder="100, 112…"
              maxLength={10}
              inputMode="numeric"
            />
          </label>
          <label className="vs-field">
            <span>Document type</span>
            <input
              defaultValue={searchParams.get('documentType') ?? ''}
              name="documentType"
              placeholder="any"
            />
          </label>
          <label className="vs-field">
            <span>Scan status</span>
            <input
              defaultValue={searchParams.get('scanStatus') ?? ''}
              name="scanStatus"
              placeholder="any"
            />
          </label>
          <label className="vs-field">
            <span>Scanned after</span>
            <input
              defaultValue={searchParams.get('scannedAfter') ?? ''}
              name="scannedAfter"
              type="datetime-local"
            />
          </label>
          <label className="vs-field">
            <span>Scanned before</span>
            <input
              defaultValue={searchParams.get('scannedBefore') ?? ''}
              name="scannedBefore"
              type="datetime-local"
            />
          </label>
          <label className="vs-field">
            <span>Page size</span>
            <select defaultValue={searchParams.get('limit') ?? '100'} name="limit">
              <option value="50">50</option>
              <option value="100">100</option>
              <option value="250">250</option>
              <option value="500">500</option>
            </select>
          </label>
          <div className="vs-filter-actions">
            <button className="primary-button vs-action" type="submit">
              Apply filters
            </button>
            <button
              className="ghost-button vs-action"
              type="button"
              onClick={handleClearFilters}
              disabled={!filtersActive}
            >
              Clear
            </button>
          </div>
        </form>
      </details>

      {error ? (
        <div className="runtime-status-strip vs-error">
          <div className="runtime-status-item">
            <Pill tone="danger">load failed</Pill>
            <span className="subtle-copy">{error}</span>
          </div>
        </div>
      ) : null}

      <div className="vs-list">
        {data.items.length === 0 ? (
          <div className="vs-empty subtle-copy">No matching visitor scans.</div>
        ) : (
          <>
            {/* Wide-viewport: dense, tabular-numeric table. */}
            <div className="vs-table-wrap">
              <table className="data-table vs-table">
                <colgroup>
                  <col className="vs-col-time" />
                  <col className="vs-col-site" />
                  {showMaps ? <col className="vs-col-mini" /> : null}
                  <col className="vs-col-visitor" />
                  <col className="vs-col-status" />
                  <col className="vs-col-status" />
                  {showMaps ? <col className="vs-col-state" /> : null}
                  {showMaps ? <col className="vs-col-postal" /> : null}
                  {showMaps ? <col className="vs-col-city" /> : null}
                  <col className="vs-col-doc" />
                  <col className="vs-col-scan" />
                  <col className="vs-col-raw" />
                </colgroup>
                <thead>
                  <tr>
                    <th>Scanned</th>
                    <th>Site</th>
                    {showMaps ? <th>Map</th> : null}
                    <th>Visitor</th>
                    <th>Customer</th>
                    <th>Scans</th>
                    {showMaps ? <th>St</th> : null}
                    {showMaps ? <th>Zip</th> : null}
                    {showMaps ? <th>City</th> : null}
                    <th>Doc</th>
                    <th>Status</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((item) => {
                    const newPill = newOrReturningPill(item)
                    const firstBadge = firstScanBadge(item)
                    const crm = crmPill(item)
                    return (
                      <tr key={item.id}>
                        <td className="vs-cell-time">
                          {formatTime(item.scannedAt ?? item.ingestedAt)}
                        </td>
                        <td>
                          <Pill tone={item.siteSlug === 'bx' ? 'success' : 'warning'}>
                            {item.siteSlug}
                          </Pill>
                        </td>
                        {showMaps ? (
                          <td>
                            <MiniGeoMarker
                              marker={item.miniMarker}
                              siteSlug={item.siteSlug}
                              href={buildAppPath(item.customerUrl)}
                              ariaLabelPrefix={formatName(item)}
                            />
                          </td>
                        ) : null}
                        <td>
                          <a
                            className="vs-visitor-link"
                            href={buildAppPath(item.customerUrl)}
                            target="_blank"
                            rel="noreferrer"
                          >
                            {formatName(item)}
                          </a>
                        </td>
                        <td>
                          {newPill !== null ? (
                            <Pill tone={newPill.tone}>{newPill.label}</Pill>
                          ) : crm !== null ? (
                            <Pill tone={crm.tone}>{crm.label}</Pill>
                          ) : (
                            <span className="subtle-copy">—</span>
                          )}
                        </td>
                        <td>
                          <span className="vs-first-badge">{firstBadge.label}</span>
                        </td>
                        {showMaps ? <td>{item.state ?? '—'}</td> : null}
                        {showMaps ? <td>{item.postalCode ?? '—'}</td> : null}
                        {showMaps ? (
                          <td className="vs-cell-truncate">{item.city ?? '—'}</td>
                        ) : null}
                        <td className="vs-cell-truncate">{item.documentType ?? '—'}</td>
                        <td className="vs-cell-truncate">{item.scanStatus ?? '—'}</td>
                        <td>
                          <button
                            type="button"
                            className="ghost-button vs-row-raw"
                            onClick={() => setSelected(item)}
                          >
                            Raw
                          </button>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>

            {/* Narrow-viewport: card list. Same data, no horizontal scroll. */}
            <ul className={`vs-cards${showMaps ? '' : ' vs-cards-no-maps'}`}>
              {data.items.map((item) => {
                const newPill = newOrReturningPill(item)
                const firstBadge = firstScanBadge(item)
                const crm = crmPill(item)
                return (
                  <li key={`card-${item.id}`}>
                    <article className="vs-card">
                      <div className="vs-card-body">
                        <a
                          className="vs-card-name vs-visitor-link"
                          href={buildAppPath(item.customerUrl)}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {formatName(item)}
                        </a>
                        <div className="vs-card-pills">
                          {newPill !== null ? (
                            <Pill tone={newPill.tone}>{newPill.label}</Pill>
                          ) : null}
                          {crm !== null ? <Pill tone={crm.tone}>{crm.label}</Pill> : null}
                          <span className="vs-first-badge">{firstBadge.label}</span>
                          <Pill tone={item.siteSlug === 'bx' ? 'success' : 'warning'}>
                            {item.siteSlug}
                          </Pill>
                        </div>
                        <div className="vs-card-time">
                          {formatTime(item.scannedAt ?? item.ingestedAt)}
                        </div>
                        <dl className="vs-card-grid">
                          {showMaps ? (
                            <>
                              <dt>State</dt>
                              <dd>{item.state ?? '—'}</dd>
                              <dt>Postal</dt>
                              <dd>{item.postalCode ?? '—'}</dd>
                              <dt>City</dt>
                              <dd>{item.city ?? '—'}</dd>
                            </>
                          ) : null}
                          <dt>Doc</dt>
                          <dd>{item.documentType ?? '—'}</dd>
                          <dt>Status</dt>
                          <dd>{item.scanStatus ?? '—'}</dd>
                        </dl>
                        <div className="vs-card-actions">
                          <a
                            className="primary-button vs-action"
                            href={buildAppPath(item.customerUrl)}
                            target="_blank"
                            rel="noreferrer"
                          >
                            Open customer
                          </a>
                          <button
                            type="button"
                            className="ghost-button vs-action"
                            onClick={() => setSelected(item)}
                          >
                            Raw
                          </button>
                        </div>
                      </div>
                      {/* Bigger map on the right side fills the
                          previously-wasted whitespace next to the
                          short tabular values. Same component as the
                          desktop thumbnail — scales because the SVG
                          uses preserveAspectRatio="none" and the
                          marker projection re-derives from the bbox
                          on every render. Hidden when the operator
                          flips the page-level Maps toggle off. */}
                      {showMaps ? (
                        <MiniGeoMarker
                          marker={item.miniMarker}
                          siteSlug={item.siteSlug}
                          href={buildAppPath(item.customerUrl)}
                          ariaLabelPrefix={formatName(item)}
                          className="vs-card-mini"
                        />
                      ) : null}
                    </article>
                  </li>
                )
              })}
            </ul>
          </>
        )}
      </div>

      <details className="vs-about">
        <summary className="subtle-copy">About this page</summary>
        <div className="subtle-copy vs-about-body">
          <p>
            Backed by the <code>visitor_scans</code> table. Live rows arrive via{' '}
            <code>POST /wh/bx/veriscan/checkin</code> and{' '}
            <code>POST /wh/mh/veriscan/checkin</code> (handlers in{' '}
            <code>helios/src/server/routes/visitorScans.ts</code>). Historical rows are
            ingested by the <code>visitor-scans-backfill</code> CLI under{' '}
            <code>helios/scripts/</code>. The unique{' '}
            <code>(provider, hash_id)</code> constraint collapses webhook + backfill
            duplicates to one row.
          </p>
          <p>
            Coordinates in this table are <em>not</em> reverse-geocoded — the v1 epic
            (FreshlyBakedNYC/automation#31) is ingest-only. The Customers UX epic
            (FreshlyBakedNYC/automation#33) layers map / segmentation / replay on top.
          </p>
        </div>
      </details>

      {selected !== null ? (
        <VisitorScanDrawer item={selected} onClose={() => setSelected(null)} />
      ) : null}
    </section>
  )
}

interface DrawerProps {
  item: VisitorScanItem
  onClose: () => void
}

function VisitorScanDrawer({ item, onClose }: DrawerProps): JSX.Element {
  return (
    <div className="vs-drawer-scrim" onClick={onClose} role="presentation">
      <aside
        className="vs-drawer"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label={`Visitor scan ${item.id}`}
      >
        <div className="vs-drawer-header">
          <div>
            <h3 className="vs-drawer-title">Visitor scan #{item.id}</h3>
            <p className="subtle-copy vs-drawer-sub">
              {item.siteSlug} · {item.ingestSource} · scanned{' '}
              {formatTime(item.scannedAt)}
            </p>
          </div>
          <button className="ghost-button vs-action" type="button" onClick={onClose}>
            Close
          </button>
        </div>

        <dl className="vs-drawer-grid">
          <dt>hash_id</dt>
          <dd>
            <code>{item.hashId}</code>
          </dd>
          <dt>name</dt>
          <dd>{formatName(item)}</dd>
          <dt>address</dt>
          <dd>{item.address ?? '—'}</dd>
          <dt>city / state / postal</dt>
          <dd>
            {[item.city, item.state, item.postalCode]
              .filter((p) => p && p.length > 0)
              .join(', ') || '—'}
          </dd>
          <dt>country</dt>
          <dd>{item.country ?? '—'}</dd>
          <dt>document type</dt>
          <dd>{item.documentType ?? '—'}</dd>
          <dt>auth status</dt>
          <dd>{item.authenticationStatus ?? '—'}</dd>
          <dt>scan status</dt>
          <dd>{item.scanStatus ?? '—'}</dd>
          <dt>document lat/lon</dt>
          <dd>
            {item.latitude !== null && item.longitude !== null
              ? `${item.latitude}, ${item.longitude}`
              : '—'}
          </dd>
          <dt>scan lat/lon</dt>
          <dd>
            {item.scanLatitude !== null && item.scanLongitude !== null
              ? `${item.scanLatitude}, ${item.scanLongitude}`
              : '—'}
          </dd>
          <dt>ingested at</dt>
          <dd>{formatTime(item.ingestedAt)}</dd>
          <dt>webhook type</dt>
          <dd>{item.webhookType ?? '—'}</dd>
        </dl>

        <details className="vs-envelope">
          <summary>raw_envelope (JSON)</summary>
          <pre className="vs-envelope-pre">
            {JSON.stringify(item.rawEnvelope, null, 2)}
          </pre>
        </details>
      </aside>
    </div>
  )
}
