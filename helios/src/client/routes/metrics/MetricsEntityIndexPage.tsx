import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'

import {
  MetricsEntityRankingsResponseSchema,
  type MetricsEntityKind,
  type MetricsEntityRankingRow,
  type MetricsEntityRankingsResponse,
} from '../../../shared/contracts/index.js'
import { loadJson } from '../../app/fetchJson.js'
import { MetricsAccessGate } from './MetricsAccessGate.js'

// ---------------------------------------------------------------------------
// Brands / Distributors index pages.
//
// These pages are the IA entry points behind the Metrics → Brands and
// Metrics → Distributors sidebar leaves. Each one lists every entity
// that currently has at least one item on sweed_package_current at the
// selected sites, with three columns / three orderings the operator
// can toggle between:
//
//   * "In-stock products"  — distinct product_id where the package
//                            is currently in stock. Operator-default;
//                            this is the column the user cares about
//                            when they ask "which brands are
//                            actually shelved right now".
//   * "Last order"         — most recent pay_time of any sweed_orders
//                            line for one of this entity's packages
//                            (lookback bounded to ~1y to keep the
//                            join cheap). Useful for spotting brands
//                            we're carrying that nobody has bought
//                            in months.
//   * "Live items"         — legacy count of distinct
//                            inventory_item_id (lots / batches). The
//                            previous default; deliberately demoted
//                            because lot count tracks how often we
//                            re-receive a SKU, not how many SKUs the
//                            brand actually sells.
//
// Linking strategy:
//   * Each row links to the canonical detail page
//     (`/metrics/brands/<id>` or `/metrics/distributors/<id>`),
//     which embeds the catalog scatter per category with the
//     structured Highlight chip pre-selected for that entity (see
//     MetricsEntityDetailPage / issue #38 task A4). The legacy
//     `/metrics/catalog?highlight=<label>` free-text fallback still
//     works for shared/bookmarked links and is hydrated inside
//     CatalogAnalyticsTab; new index links do NOT use it.
//   * We intentionally do NOT pre-filter the catalog tab to the
//     selected entity. The product question we're answering is
//     "where does this brand sit in its category's price /
//     velocity / margin distribution?" — that requires the rest
//     of the category to remain on screen as visual context.
//
// Future work tracked separately:
//   * A per-category "show only categories where this brand has a
//     nonzero presence" view. The current catalog tab renders the
//     same scatter card set regardless of selected brand; building
//     a per-category surface requires either a new dashboard layout
//     or new server queries. Out of scope for the navbar refactor.
// ---------------------------------------------------------------------------

export interface MetricsEntityIndexPageProps {
  readonly kind: MetricsEntityKind
}

interface IndexCopy {
  eyebrow: string
  heading: string
  description: string
  emptyMessage: string
  entityColumnLabel: string
}

const COPY: Record<MetricsEntityKind, IndexCopy> = {
  brand: {
    eyebrow: 'Business & Performance Metrics',
    heading: 'Brands',
    description:
      'Every brand currently on the floor at either store. Click a brand to jump into the catalog analytics scatter with that brand visually highlighted across every category card.',
    emptyMessage:
      'No brands found. The catalog analytics endpoint returned an empty brand set — usually means sweed_package_current is empty.',
    entityColumnLabel: 'Brand',
  },
  distributor: {
    eyebrow: 'Business & Performance Metrics',
    heading: 'Distributors',
    description:
      'Every distributor currently supplying live packages at either store. Click a distributor to jump into the catalog analytics scatter with that distributor visually highlighted across every category card.',
    emptyMessage:
      'No distributors found. The catalog analytics endpoint returned an empty distributor set — usually means sweed_package_current is empty or no packages have a distributor_name set yet.',
    entityColumnLabel: 'Distributor',
  },
}

// The three sortable columns. `inStockProducts` is the default because
// it's the operator-meaningful "how many unique SKUs is this entity
// actually shelving right now" measure (see module header). Switching
// to `lastOrder` ranks the entity by recency of any sweed_orders line
// touching it; switching to `liveItems` recovers the legacy ordering
// (distinct lots / batches) for parity with the previous page.
type EntitySort = 'inStockProducts' | 'lastOrder' | 'liveItems'

const SORT_LABELS: Record<EntitySort, string> = {
  inStockProducts: 'In-stock products',
  lastOrder: 'Last order',
  liveItems: 'Live items (lots)',
}

const DEFAULT_SORT: EntitySort = 'inStockProducts'

function MetricsEntityIndexPage({ kind }: MetricsEntityIndexPageProps) {
  const [response, setResponse] = useState<MetricsEntityRankingsResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState<boolean>(true)
  const [sortBy, setSortBy] = useState<EntitySort>(DEFAULT_SORT)
  const copy = COPY[kind]

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    // The page is read-only and stable per (kind, sites). Sites are
    // unfiltered here (the index always shows the cross-site union);
    // future per-site narrowing can flow through as `sites=`.
    loadJson(
      `/api/catalog-analytics/entity-rankings?kind=${kind}`,
      MetricsEntityRankingsResponseSchema,
    )
      .then((r) => {
        if (cancelled) return
        setResponse(r)
      })
      .catch((e) => {
        if (cancelled) return
        setError((e as Error).message)
        setResponse(null)
      })
      .finally(() => {
        if (cancelled) return
        setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [kind])

  const sortedRows = useMemo<readonly MetricsEntityRankingRow[]>(() => {
    if (!response) return []
    // Sort client-side. Stable tiebreak by label asc so the page
    // doesn't reshuffle on re-sort for ties.
    const rows = [...response.rows]
    if (sortBy === 'inStockProducts') {
      rows.sort((a, b) => {
        if (b.inStockProductCount !== a.inStockProductCount) {
          return b.inStockProductCount - a.inStockProductCount
        }
        return a.label.localeCompare(b.label)
      })
    } else if (sortBy === 'lastOrder') {
      rows.sort((a, b) => {
        // Most recent first. Rows with no order in the lookback
        // window sink to the bottom (NULL is treated as -Infinity).
        const aT = a.lastOrderAt ? Date.parse(a.lastOrderAt) : Number.NEGATIVE_INFINITY
        const bT = b.lastOrderAt ? Date.parse(b.lastOrderAt) : Number.NEGATIVE_INFINITY
        if (bT !== aT) return bT - aT
        return a.label.localeCompare(b.label)
      })
    } else {
      rows.sort((a, b) => {
        if (b.liveItemCount !== a.liveItemCount) {
          return b.liveItemCount - a.liveItemCount
        }
        return a.label.localeCompare(b.label)
      })
    }
    return rows
  }, [response, sortBy])

  const lookbackSinceLabel = useMemo(() => {
    if (!response) return null
    const d = new Date(response.lastOrderLookbackSince)
    if (!Number.isFinite(d.getTime())) return null
    return d.toLocaleDateString()
  }, [response])

  return (
    <section className="metrics-dashboard">
      <header className="page-header metrics-dashboard-header">
        <div>
          <p className="eyebrow">{copy.eyebrow}</p>
          <h2>{copy.heading}</h2>
        </div>
      </header>

      <p className="subtle-copy" style={{ marginTop: '0.5rem', marginBottom: '0.75rem' }}>
        {copy.description}
      </p>

      <div
        className="metrics-control-group"
        style={{ marginBottom: '0.75rem', display: 'flex', flexWrap: 'wrap', gap: '0.5rem', alignItems: 'center' }}
      >
        <span className="subtle-copy">sort by</span>
        {(Object.keys(SORT_LABELS) as EntitySort[]).map((key) => (
          <button
            key={key}
            type="button"
            className={sortBy === key ? 'metrics-site-chip is-active' : 'metrics-site-chip'}
            aria-pressed={sortBy === key}
            onClick={() => setSortBy(key)}
          >
            {SORT_LABELS[key]}
          </button>
        ))}
      </div>

      {loading ? (
        <p className="subtle-copy">Loading…</p>
      ) : error ? (
        <p className="error-message">Failed to load: {error}</p>
      ) : sortedRows.length === 0 ? (
        <p className="subtle-copy">{copy.emptyMessage}</p>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table className="data-table" style={{ width: '100%' }}>
            <thead>
              <tr>
                <th style={{ textAlign: 'left' }}>{copy.entityColumnLabel}</th>
                <th style={{ textAlign: 'right' }}>In-stock products</th>
                <th style={{ textAlign: 'right' }}>Last order</th>
                <th style={{ textAlign: 'right' }}>Live items</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {sortedRows.map((row) => (
                <EntityRow key={row.id} kind={kind} row={row} />
              ))}
            </tbody>
          </table>
        </div>
      )}

      <details className="page-collapsible" style={{ marginTop: '1rem' }}>
        <summary>About this page</summary>
        <div className="subtle-copy" style={{ marginTop: '0.5rem' }}>
          <p>
            <strong>In-stock products</strong> counts distinct{' '}
            <code>product_id</code>s for which at least one package is
            currently in stock (<code>is_on_stock</code> AND
            non-zero available qty). This is the column the page
            sorts by out of the box and is what we mean when we ask
            "how many products is this {kind} actually carrying right
            now".
          </p>
          <p>
            <strong>Last order</strong> is the most recent{' '}
            <code>sweed_orders.pay_time</code> for any order line whose{' '}
            <code>inventoryItemId</code> belongs to one of this {kind}'s
            packages, bounded to the last 365 days
            {lookbackSinceLabel ? ` (since ${lookbackSinceLabel})` : ''}.
            Brands / distributors with no orders inside that window
            show "—". Use this sort to find {kind}s we're carrying
            that nobody is buying.
          </p>
          <p>
            <strong>Live items</strong> is the legacy column — distinct{' '}
            <code>inventory_item_id</code> (i.e. lot / batch) count. It
            tracks how often we re-receive an entity's SKUs, not how
            many SKUs the entity offers, which is why it's no longer
            the default sort.
          </p>
        </div>
      </details>
    </section>
  )
}

function EntityRow({
  kind,
  row,
}: {
  readonly kind: MetricsEntityKind
  readonly row: MetricsEntityRankingRow
}) {
  // Canonical detail route per entity. The detail page renders
  // per-category accordions with the scatter scoped to this entity,
  // not a query-param landing on the global scatter tab. The path
  // segment uses the underlying id (brand label or distributor
  // name); encodeURIComponent keeps quotes / commas / spaces /
  // unicode safe in the URL.
  const href =
    kind === 'brand'
      ? `/metrics/brands/${encodeURIComponent(row.id)}`
      : `/metrics/distributors/${encodeURIComponent(row.id)}`
  return (
    <tr>
      <td>
        <Link to={href} title={`Open ${row.label}`}>
          {row.label}
        </Link>
      </td>
      <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
        {row.inStockProductCount.toLocaleString()}
      </td>
      <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
        {formatLastOrder(row.lastOrderAt)}
      </td>
      <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
        {row.liveItemCount.toLocaleString()}
      </td>
      <td style={{ textAlign: 'right' }}>
        <Link to={href} className="ghost-button" title={`Open ${row.label}`}>
          Open →
        </Link>
      </td>
    </tr>
  )
}

// Human-friendly "how long ago" string for the Last order column.
//   * < 1 day  → "today"
//   * 1 day    → "yesterday"
//   * 2..6 d   → "Nd ago"
//   * 7..89 d  → "Nw ago"
//   * >= 90 d  → "YYYY-MM-DD"
//   * null     → "—" (no orders in the lookback window)
// Keeps the column scannable without losing the absolute date for
// stale rows.
function formatLastOrder(iso: string | null): string {
  if (!iso) return '—'
  const ts = Date.parse(iso)
  if (!Number.isFinite(ts)) return '—'
  const ageMs = Date.now() - ts
  const dayMs = 86_400_000
  if (ageMs < dayMs) return 'today'
  const days = Math.floor(ageMs / dayMs)
  if (days === 1) return 'yesterday'
  if (days < 7) return `${days}d ago`
  if (days < 90) return `${Math.floor(days / 7)}w ago`
  const d = new Date(ts)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

export function BrandsIndexPage() {
  return (
    <MetricsAccessGate anyOf={['brands']} surfaceLabel="Brands">
      <MetricsEntityIndexPage kind="brand" />
    </MetricsAccessGate>
  )
}

export function DistributorsIndexPage() {
  return (
    <MetricsAccessGate anyOf={['distributors']} surfaceLabel="Distributors">
      <MetricsEntityIndexPage kind="distributor" />
    </MetricsAccessGate>
  )
}
