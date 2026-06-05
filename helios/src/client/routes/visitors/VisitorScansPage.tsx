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
 *
 * Count semantics: INCLUDES this scan (matches the per-scan
 * details page which has always done `priorIdNumScanCount + 1`).
 * A first-time visitor therefore has total = 1 and shows
 * "First scan"; subsequent visits show `${total}× scanned`.
 * Operator 2026-06-03: "the number displayed should INCLUDE
 * this scan, so we shouldn't ever see '1x scans' (that would
 * mean 'first time scanned')" — i.e. when total === 1 we keep
 * the friendlier "First scan" label and only flip to a numeric
 * "Nx" once we're genuinely on visit 2+.
 */
function firstScanBadge(item: VisitorScanItem): { label: string; tone: PillTone } {
  const total = item.identity.priorIdNumScanCount + 1
  if (total === 1) {
    return { label: 'First scan', tone: 'muted' }
  }
  return { label: `${total}× scanned`, tone: 'muted' }
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

function formatCurrency(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—'
  return `$${value.toFixed(2)}`
}

function formatCount(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—'
  return value.toLocaleString()
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

  // Live updates via Server-Sent Events instead of a fixed poll
  // (DB-cost epic phase E1 — virusdave/top-level#11). This is the one
  // operator surface the epic forbids throttling, so rather than slow
  // the old 20 s poll we swap the mechanism: the server pushes a
  // `scan` event over /api/visitors/scans/stream whenever a scan (or
  // its CRM enrichment) lands, and we refetch the CURRENT filtered
  // view in response. Net effect: new door scans still appear in ≤2 s
  // (faster than the old 20 s worst case) at a fraction of the DB
  // cost — zero queries while the floor is quiet.
  //
  // Reconciliation backstops, so a missed/dropped event can never
  // leave the page silently stale:
  //   * refetch on (re)connect (`open`) and on server `resync`;
  //   * refetch when the tab becomes visible again;
  //   * a slow 120 s safety refetch.
  // A single-flight guard coalesces event bursts into at most one
  // in-flight request plus one trailing refetch.
  const queryString = searchParams.toString()
  useEffect(() => {
    let cancelled = false
    let debounceTimer: number | null = null
    let inFlight = false
    let rerun = false

    async function refresh(): Promise<void> {
      if (inFlight) {
        rerun = true
        return
      }
      inFlight = true
      try {
        const next = await loadJson(
          `/api/visitors/scans?${queryString}`,
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
      } finally {
        inFlight = false
        if (rerun && !cancelled) {
          rerun = false
          scheduleRefresh(0)
        }
      }
    }

    function scheduleRefresh(delayMs = 400): void {
      if (debounceTimer !== null) window.clearTimeout(debounceTimer)
      debounceTimer = window.setTimeout(() => {
        debounceTimer = null
        void refresh()
      }, delayMs)
    }

    // Initial load for this filter set.
    void refresh()

    const es = new EventSource(buildAppPath('/api/visitors/scans/stream'))
    es.addEventListener('open', () => {
      // Reconcile anything that landed before the stream was up.
      void refresh()
    })
    es.addEventListener('scan', () => {
      scheduleRefresh(400)
    })
    es.addEventListener('resync', () => {
      void refresh()
    })
    // On error EventSource auto-reconnects; don't wipe the table just
    // because the stream is momentarily reconnecting.

    const safety = window.setInterval(() => {
      void refresh()
    }, 120_000)

    const onVisible = (): void => {
      if (document.visibilityState === 'visible') void refresh()
    }
    document.addEventListener('visibilitychange', onVisible)

    return () => {
      cancelled = true
      if (debounceTimer !== null) window.clearTimeout(debounceTimer)
      window.clearInterval(safety)
      document.removeEventListener('visibilitychange', onVisible)
      es.close()
    }
  }, [queryString])

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
          {/* exempt: not a metrics-range-custom panel — this is an
              admin-filter form (submit-driven, no preset chips) so it
              does not consume RangeNudgeRow. Issue #38 / task A7
              audit. */}
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
                  {/* Scans column — moved here (immediately after
                      Site) per operator request 2026-06-03 so the
                      visit count is the first thing a cashier sees
                      next to the site pill, before the wider PII
                      columns. */}
                  <col className="vs-col-status" />
                  {showMaps ? <col className="vs-col-mini" /> : null}
                  <col className="vs-col-visitor" />
                  <col className="vs-col-status" />
                  {/* D2 Sweed-summary columns
                      (virusdave/top-level#12). Always rendered
                      regardless of the Expanded toggle — these are
                      sales-history metrics, not address PII. */}
                  <col className="vs-col-sweed" />
                  <col className="vs-col-sweed" />
                  <col className="vs-col-sweed" />
                  <col className="vs-col-sweed" />
                  <col className="vs-col-sweed" />
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
                    <th>Scans</th>
                    {showMaps ? <th>Map</th> : null}
                    <th>Visitor</th>
                    <th>Customer</th>
                    <th title="Lifetime purchase count at this dealer (Sweed CRM)">
                      # Purchases
                    </th>
                    <th title="Average purchase amount (lifetime spend / purchase count)">
                      Avg $
                    </th>
                    <th title="Lifetime spend at this dealer (Sweed CRM)">Total $</th>
                    <th title="Most-purchased category, qualified by ≥3 distinct invoices">
                      Favorite category
                    </th>
                    <th title="Most-purchased product, qualified by ≥3 distinct invoices">
                      Favorite product
                    </th>
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
                        {/* Scans count — moved here (immediately
                            after Site) per operator 2026-06-03; cell
                            content is unchanged. */}
                        <td>
                          <span className="vs-first-badge">{firstBadge.label}</span>
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
                        {(() => {
                          const summary = item.sweedPurchaseSummary
                          return (
                            <>
                              <td className="vs-cell-numeric">
                                {formatCount(summary?.totalPurchaseCount ?? null)}
                              </td>
                              <td className="vs-cell-numeric">
                                {formatCurrency(summary?.averagePurchaseDollars ?? null)}
                              </td>
                              <td className="vs-cell-numeric">
                                {formatCurrency(summary?.lifetimeSpendDollars ?? null)}
                              </td>
                              <td className="vs-cell-truncate">
                                {summary?.favoriteCategoryName ?? '—'}
                              </td>
                              <td className="vs-cell-truncate">
                                {summary?.favoriteProductName ?? '—'}
                              </td>
                            </>
                          )
                        })()}
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
                          {item.sweedPurchaseSummary !== null ? (
                            <>
                              <dt># Purchases</dt>
                              <dd>{formatCount(item.sweedPurchaseSummary.totalPurchaseCount)}</dd>
                              <dt>Avg $</dt>
                              <dd>{formatCurrency(item.sweedPurchaseSummary.averagePurchaseDollars)}</dd>
                              <dt>Total $</dt>
                              <dd>{formatCurrency(item.sweedPurchaseSummary.lifetimeSpendDollars)}</dd>
                              {item.sweedPurchaseSummary.favoriteCategoryName !== null ? (
                                <>
                                  <dt>Favorite category</dt>
                                  <dd>{item.sweedPurchaseSummary.favoriteCategoryName}</dd>
                                </>
                              ) : null}
                              {item.sweedPurchaseSummary.favoriteProductName !== null ? (
                                <>
                                  <dt>Favorite product</dt>
                                  <dd>{item.sweedPurchaseSummary.favoriteProductName}</dd>
                                </>
                              ) : null}
                            </>
                          ) : null}
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
