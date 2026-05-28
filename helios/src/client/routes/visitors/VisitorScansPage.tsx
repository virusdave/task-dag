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

/** Primary "have we seen them" + "are they a paying customer" pill.  */
function firstTimePill(item: VisitorScanItem): { label: string; tone: PillTone } {
  if (item.sweedPurchaseSummary?.hasPriorPurchaseBeforeScan === true) {
    return { label: 'Known purchaser', tone: 'success' }
  }
  if (!item.identity.isFirstLocalScan) {
    return { label: 'Returning', tone: 'success' }
  }
  return { label: 'First scan', tone: 'warning' }
}

/** CRM lookup status pill — secondary, only shown when meaningful. */
function crmPill(item: VisitorScanItem): { label: string; tone: PillTone } | null {
  const sweed = item.sweedLink
  if (sweed === null) return null
  if (sweed.status === 'linked' && sweed.customerId !== null) {
    return { label: `Linked #${sweed.customerId}`, tone: 'success' }
  }
  if (sweed.status === 'ambiguous') {
    return { label: `Review (${sweed.candidateCount})`, tone: 'warning' }
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

export function VisitorScansPage() {
  const initialData = useLoaderData() as VisitorScansResponse
  const [searchParams, setSearchParams] = useSearchParams()
  const [data, setData] = useState<VisitorScansResponse>(initialData)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<VisitorScanItem | null>(null)

  // Re-fetch whenever the filter changes.
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
    return () => {
      cancelled = true
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
            {/* Wide-viewport: dense table. */}
            <div className="vs-table-wrap">
              <table className="data-table vs-table">
                <thead>
                  <tr>
                    <th>Scanned</th>
                    <th>Site</th>
                    <th>Visitor</th>
                    <th>First?</th>
                    <th>CRM</th>
                    <th>Origin</th>
                    <th>State</th>
                    <th>Postal</th>
                    <th>City</th>
                    <th>Doc type</th>
                    <th>Status</th>
                    <th>Raw</th>
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((item) => {
                    const ft = firstTimePill(item)
                    const crm = crmPill(item)
                    return (
                      <tr key={item.id}>
                        <td>{formatTime(item.scannedAt ?? item.ingestedAt)}</td>
                        <td>{item.siteSlug}</td>
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
                          <Pill tone={ft.tone}>{ft.label}</Pill>
                        </td>
                        <td>
                          {crm === null ? '—' : <Pill tone={crm.tone}>{crm.label}</Pill>}
                        </td>
                        <td>
                          <MiniGeoMarker marker={item.miniMarker} />
                        </td>
                        <td>{item.state ?? '—'}</td>
                        <td>{item.postalCode ?? '—'}</td>
                        <td>{item.city ?? '—'}</td>
                        <td>{item.documentType ?? '—'}</td>
                        <td>{item.scanStatus ?? '—'}</td>
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
            <ul className="vs-cards">
              {data.items.map((item) => {
                const ft = firstTimePill(item)
                const crm = crmPill(item)
                return (
                  <li key={`card-${item.id}`}>
                    <article className="vs-card">
                      <header className="vs-card-top">
                        <a
                          className="vs-card-name vs-visitor-link"
                          href={buildAppPath(item.customerUrl)}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {formatName(item)}
                        </a>
                        <MiniGeoMarker marker={item.miniMarker} className="vs-card-mini" />
                      </header>
                      <div className="vs-card-pills">
                        <Pill tone={ft.tone}>{ft.label}</Pill>
                        {crm !== null ? <Pill tone={crm.tone}>{crm.label}</Pill> : null}
                        <Pill tone="muted">{item.siteSlug}</Pill>
                      </div>
                      <div className="vs-card-time">
                        {formatTime(item.scannedAt ?? item.ingestedAt)}
                      </div>
                      <dl className="vs-card-grid">
                        <dt>State</dt>
                        <dd>{item.state ?? '—'}</dd>
                        <dt>Postal</dt>
                        <dd>{item.postalCode ?? '—'}</dd>
                        <dt>City</dt>
                        <dd>{item.city ?? '—'}</dd>
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
