import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'

import {
  CatalogAnalyticsFiltersResponseSchema,
  type CatalogAnalyticsFiltersResponse,
  type CatalogFilterOption,
} from '../../../shared/contracts/index.js'
import { loadJson } from '../../app/fetchJson.js'

// ---------------------------------------------------------------------------
// Brands / Distributors index pages.
//
// These pages are the IA entry points behind the new Metrics → Brands and
// Metrics → Distributors sidebar leaves. Each one lists every entity that
// currently has at least one item visible on sweed_package_current
// (sourced from `/api/catalog-analytics/filters`), sorted by item count
// descending, and links each row to the catalog analytics scatter
// pre-highlighted on that entity.
//
// Linking strategy:
//   * Each row links to `/metrics/catalog?highlight=<label>`. The
//     catalog tab already supports a free-text "highlight subset"
//     query that visually fades non-matching dots — we just seed it
//     from the URL on mount so the operator lands with the chosen
//     entity already framed across every scatter card.
//   * We intentionally do NOT pre-filter the catalog tab to the
//     selected entity. The product question we're answering is
//     "where does this brand sit in its category's price /
//     velocity / margin distribution?" — that requires the rest
//     of the category to remain on screen as visual context.
//     Operators who want to scope down further can use the
//     dropdown chips inside the catalog tab itself.
//
// Future work tracked separately:
//   * A per-category "show only categories where this brand has a
//     nonzero presence" view. The current catalog tab renders the
//     same scatter card set regardless of selected brand; building
//     a per-category surface requires either a new dashboard layout
//     or new server queries. Out of scope for the navbar refactor.
// ---------------------------------------------------------------------------

export interface MetricsEntityIndexPageProps {
  readonly kind: 'brand' | 'distributor'
}

interface IndexCopy {
  eyebrow: string
  heading: string
  description: string
  emptyMessage: string
}

const COPY: Record<MetricsEntityIndexPageProps['kind'], IndexCopy> = {
  brand: {
    eyebrow: 'Business & Performance Metrics',
    heading: 'Brands',
    description:
      'Every brand currently on the floor at either store. Click a brand to jump into the catalog analytics scatter with that brand visually highlighted across every category card.',
    emptyMessage:
      'No brands found. The catalog analytics filter endpoint returned an empty brand set — usually means sweed_package_current is empty.',
  },
  distributor: {
    eyebrow: 'Business & Performance Metrics',
    heading: 'Distributors',
    description:
      'Every distributor currently supplying live packages at either store. Click a distributor to jump into the catalog analytics scatter with that distributor visually highlighted across every category card.',
    emptyMessage:
      'No distributors found. The catalog analytics filter endpoint returned an empty distributor set — usually means sweed_package_current is empty or no packages have a distributor_name set yet.',
  },
}

function MetricsEntityIndexPage({ kind }: MetricsEntityIndexPageProps) {
  const [filters, setFilters] = useState<CatalogAnalyticsFiltersResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState<boolean>(true)
  const copy = COPY[kind]

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    loadJson('/api/catalog-analytics/filters', CatalogAnalyticsFiltersResponseSchema)
      .then((r) => {
        if (cancelled) return
        setFilters(r)
      })
      .catch((e) => {
        if (cancelled) return
        setError((e as Error).message)
        setFilters(null)
      })
      .finally(() => {
        if (cancelled) return
        setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  // Sort descending by itemCount so the highest-presence entities are
  // at the top. Ties broken by label ascending for stable rendering.
  const rows = useMemo<readonly CatalogFilterOption[]>(() => {
    if (!filters) return []
    const source = kind === 'brand' ? filters.brands : filters.distributors
    return [...source].sort((a, b) => {
      if (b.itemCount !== a.itemCount) return b.itemCount - a.itemCount
      return a.label.localeCompare(b.label)
    })
  }, [filters, kind])

  return (
    <section className="metrics-dashboard">
      <header className="page-header metrics-dashboard-header">
        <div>
          <p className="eyebrow">{copy.eyebrow}</p>
          <h2>{copy.heading}</h2>
        </div>
      </header>

      <p className="subtle-copy" style={{ marginTop: '0.5rem', marginBottom: '1rem' }}>
        {copy.description}
      </p>

      {loading ? (
        <p className="subtle-copy">Loading…</p>
      ) : error ? (
        <p className="error-message">Failed to load: {error}</p>
      ) : rows.length === 0 ? (
        <p className="subtle-copy">{copy.emptyMessage}</p>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table className="data-table" style={{ width: '100%' }}>
            <thead>
              <tr>
                <th style={{ textAlign: 'left' }}>{kind === 'brand' ? 'Brand' : 'Distributor'}</th>
                <th style={{ textAlign: 'right' }}>Live items</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((opt) => (
                <EntityRow key={opt.id} kind={kind} option={opt} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

function EntityRow({
  kind,
  option,
}: {
  readonly kind: MetricsEntityIndexPageProps['kind']
  readonly option: CatalogFilterOption
}) {
  // Use the label as the highlight token. CatalogAnalyticsTab's
  // `buildHighlightMatcher` is case-insensitive AND across
  // whitespace-separated terms, so e.g. "Cresco Labs" requires both
  // "cresco" AND "labs" in the same dot's haystack — which holds
  // for that brand's points. encodeURIComponent keeps quotes / commas
  // / spaces / unicode safe in the URL.
  const href = `/metrics/catalog?highlight=${encodeURIComponent(option.label)}`
  return (
    <tr>
      <td>
        <Link to={href} title={`View ${option.label} on the catalog scatter`}>
          {option.label}
        </Link>
      </td>
      <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
        {option.itemCount.toLocaleString()}
      </td>
      <td style={{ textAlign: 'right' }}>
        <Link to={href} className="ghost-button" title={`View ${option.label}`}>
          View →
        </Link>
      </td>
    </tr>
  )
}

export function BrandsIndexPage() {
  return <MetricsEntityIndexPage kind="brand" />
}

export function DistributorsIndexPage() {
  return <MetricsEntityIndexPage kind="distributor" />
}
