// Operator-facing view of the visitor_scans table.
//
// virusdave/top-level#9 / FreshlyBakedNYC/automation#31, phase A3.
//
// Paginated newest-first table backed by GET /api/visitors/scans;
// supports site / state / postal-prefix / scan-status / document-type
// / ingest-source / date-range filters. Clicking a row opens a
// drawer with the full normalised row plus a syntax-highlit JSON
// view of `raw_envelope`. "Export CSV" hits
// /api/visitors/scans.csv with the *current* filter — single source
// of truth, no second query.
//
// Per helios AGENTS.md: the table is the answer the page exists to
// show, so the table is visible by default. Methodology / dev notes
// live inside a collapsed <details>.

import { useEffect, useMemo, useState } from 'react'
import { useLoaderData, useSearchParams } from 'react-router-dom'

import {
  VisitorScansResponseSchema,
  type VisitorScanItem,
  type VisitorScansResponse,
} from '../../../shared/contracts/index.js'
import { loadJson } from '../../app/fetchJson.js'
import { Pill } from '../../components/Pill.js'

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

  return (
    <section>
      <div className="page-header">
        <div>
          <h2>Visitor Scans</h2>
          <p className="subtle-copy">
            Customer / visitor ID check-ins captured by VeriScan at the Bronx and Midtown sites.
            Newest first. Click a row to inspect the raw envelope.
          </p>
        </div>
        <div className="inline-row wrap-row">
          <Pill tone="muted">{`${data.items.length} shown`}</Pill>
          {[...counts.bySite.entries()].map(([slug, n]) => (
            <Pill key={`site-${slug}`} tone="muted">{`${slug}: ${n}`}</Pill>
          ))}
          {[...counts.byIngest.entries()].map(([src, n]) => (
            <Pill key={`src-${src}`} tone={src === 'webhook' ? 'success' : 'muted'}>{`${src}: ${n}`}</Pill>
          ))}
          {data.hasMore ? <Pill tone="warning">more rows — narrow filter or page</Pill> : null}
          <a className="ghost-button" href={csvHref}>Export CSV</a>
        </div>
      </div>

      <form className="filter-row" method="get" onSubmit={handleFilterSubmit}>
        <select defaultValue={searchParams.get('siteSlugs') ?? ''} name="siteSlugs">
          <option value="">All sites</option>
          <option value="bx">Bronx (bx)</option>
          <option value="mh">Midtown (mh)</option>
        </select>
        <select defaultValue={searchParams.get('ingestSources') ?? ''} name="ingestSources">
          <option value="">Any source</option>
          <option value="webhook">webhook</option>
          <option value="backfill">backfill</option>
        </select>
        <input
          defaultValue={searchParams.get('states') ?? ''}
          name="states"
          placeholder="State (NY, NJ, …)"
          maxLength={32}
        />
        <input
          defaultValue={searchParams.get('postalPrefix') ?? ''}
          name="postalPrefix"
          placeholder="Postal prefix (100, 112…)"
          maxLength={10}
        />
        <input
          defaultValue={searchParams.get('documentType') ?? ''}
          name="documentType"
          placeholder="Document type"
        />
        <input
          defaultValue={searchParams.get('scanStatus') ?? ''}
          name="scanStatus"
          placeholder="Scan status"
        />
        <input
          defaultValue={searchParams.get('scannedAfter') ?? ''}
          name="scannedAfter"
          placeholder="Scanned after (ISO)"
          type="datetime-local"
        />
        <input
          defaultValue={searchParams.get('scannedBefore') ?? ''}
          name="scannedBefore"
          placeholder="Scanned before (ISO)"
          type="datetime-local"
        />
        <select defaultValue={searchParams.get('limit') ?? '100'} name="limit">
          <option value="50">50</option>
          <option value="100">100</option>
          <option value="250">250</option>
          <option value="500">500</option>
        </select>
        <button className="ghost-button" type="submit">Filter</button>
      </form>

      {error ? (
        <div className="runtime-status-strip" style={{ marginTop: 12 }}>
          <div className="runtime-status-item">
            <Pill tone="danger">load failed</Pill>
            <span className="subtle-copy">{error}</span>
          </div>
        </div>
      ) : null}

      <div style={{ marginTop: 12, overflowX: 'auto' }}>
        <table className="data-table" style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <th>Scanned</th>
              <th>Site</th>
              <th>Source</th>
              <th>Name</th>
              <th>State</th>
              <th>Postal</th>
              <th>City</th>
              <th>Doc type</th>
              <th>Auth</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {data.items.length === 0 ? (
              <tr>
                <td colSpan={10} className="subtle-copy" style={{ padding: 16, textAlign: 'center' }}>
                  No matching visitor scans.
                </td>
              </tr>
            ) : (
              data.items.map((item) => (
                <tr
                  key={item.id}
                  onClick={() => setSelected(item)}
                  style={{ cursor: 'pointer' }}
                >
                  <td>{formatTime(item.scannedAt ?? item.ingestedAt)}</td>
                  <td>{item.siteSlug}</td>
                  <td>{item.ingestSource}</td>
                  <td>{formatName(item)}</td>
                  <td>{item.state ?? '—'}</td>
                  <td>{item.postalCode ?? '—'}</td>
                  <td>{item.city ?? '—'}</td>
                  <td>{item.documentType ?? '—'}</td>
                  <td>{item.authenticationStatus ?? '—'}</td>
                  <td>{item.scanStatus ?? '—'}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <details style={{ marginTop: 24 }}>
        <summary className="subtle-copy">About this page</summary>
        <div className="subtle-copy" style={{ marginTop: 8 }}>
          <p>
            Backed by the <code>visitor_scans</code> table. Live rows arrive via{' '}
            <code>POST /wh/bx/veriscan/checkin</code> and <code>POST /wh/mh/veriscan/checkin</code>{' '}
            (handlers in <code>helios/src/server/routes/visitorScans.ts</code>). Historical rows
            are ingested by the <code>visitor-scans-backfill</code> CLI under{' '}
            <code>helios/scripts/</code>. The unique <code>(provider, hash_id)</code> constraint
            collapses webhook + backfill duplicates to one row.
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
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.4)',
        zIndex: 1000,
        display: 'flex',
        justifyContent: 'flex-end',
      }}
    >
      <aside
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'var(--surface, #fff)',
          width: 'min(800px, 96vw)',
          padding: 24,
          overflowY: 'auto',
          boxShadow: '-4px 0 16px rgba(0,0,0,0.2)',
        }}
      >
        <div className="page-header" style={{ marginBottom: 12 }}>
          <div>
            <h3 style={{ margin: 0 }}>Visitor scan #{item.id}</h3>
            <p className="subtle-copy" style={{ margin: 0 }}>
              {item.siteSlug} · {item.ingestSource} · scanned {formatTime(item.scannedAt)}
            </p>
          </div>
          <button className="ghost-button" type="button" onClick={onClose}>
            Close
          </button>
        </div>

        <dl className="kv-grid" style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '4px 12px' }}>
          <dt>hash_id</dt><dd><code>{item.hashId}</code></dd>
          <dt>name</dt><dd>{formatName(item)}</dd>
          <dt>address</dt><dd>{item.address ?? '—'}</dd>
          <dt>city / state / postal</dt>
          <dd>
            {[item.city, item.state, item.postalCode].filter((p) => p && p.length > 0).join(', ') || '—'}
          </dd>
          <dt>country</dt><dd>{item.country ?? '—'}</dd>
          <dt>document type</dt><dd>{item.documentType ?? '—'}</dd>
          <dt>auth status</dt><dd>{item.authenticationStatus ?? '—'}</dd>
          <dt>scan status</dt><dd>{item.scanStatus ?? '—'}</dd>
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
          <dt>ingested at</dt><dd>{formatTime(item.ingestedAt)}</dd>
          <dt>webhook type</dt><dd>{item.webhookType ?? '—'}</dd>
        </dl>

        <h4 style={{ marginTop: 20 }}>raw_envelope</h4>
        <pre
          style={{
            background: 'rgba(0,0,0,0.04)',
            padding: 12,
            borderRadius: 4,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            fontSize: '12px',
          }}
        >
          {JSON.stringify(item.rawEnvelope, null, 2)}
        </pre>
      </aside>
    </div>
  )
}
