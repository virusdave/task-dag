import { useEffect, useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'

import {
  CatalogAnalyticsFiltersResponseSchema,
  type CatalogAnalyticsFiltersResponse,
  type CatalogFilterOption,
} from '../../../shared/contracts/index.js'
import { loadJson } from '../../app/fetchJson.js'

import { CatalogAnalyticsTab } from './CatalogAnalyticsTab.js'
import { MetricsAccessGate } from './MetricsAccessGate.js'

// ---------------------------------------------------------------------------
// Brand / Distributor DETAIL pages.
//
// Routes:
//   /metrics/brands/:brandId
//   /metrics/distributors/:distributorName
//
// These are the canonical drill-downs the operator reaches by clicking a
// row on the corresponding index page. Each detail page renders:
//   * Page header (the entity's label + lifetime item count).
//   * A list of every product category where this entity has nonzero
//     presence on the floor right now, sorted by item-count descending.
//   * One <details>-style accordion per category. Collapsed by default
//     so the page doesn't render ~60 scatter cards × N categories at
//     mount; expanding a category lazy-mounts the existing
//     <CatalogAnalyticsTab /> in embedded mode, pre-scoped to
//     (category=this, brand=this) and with the brand label seeded as
//     the highlight subset across every scatter card.
//
// Why this shape vs. one big mounted catalog tab:
//   * Per-category framing matches how operators reason about
//     merchandising decisions ("how does Cresco's flower sit in our
//     1g flower curve vs. how do their gummies sit in our edibles
//     curve?"). Mixed-category scatters bury that.
//   * Lazy mounting keeps initial paint fast even when an entity is
//     present across 10+ categories. Each accordion expand is a
//     separate /api/catalog-analytics/points fetch scoped to ~hundreds
//     of points instead of thousands.
// ---------------------------------------------------------------------------

type EntityKind = 'brand' | 'distributor'

interface EntityCopy {
  readonly notFound: string
  readonly emptyCategories: string
}

const COPY: Record<EntityKind, EntityCopy> = {
  brand: {
    notFound: 'Unknown brand. The brand may have been removed from sweed_package_current.',
    emptyCategories:
      "This brand isn't currently in any product category on the floor at either store.",
  },
  distributor: {
    notFound:
      'Unknown distributor. The distributor may have been removed from sweed_package_current, or no live packages have it set as the distributor.',
    emptyCategories:
      "This distributor isn't currently supplying any live product category at either store.",
  },
}

// Shared accordion section that lazy-mounts the embedded catalog
// scatter once the operator expands it. We intentionally guard the
// embedded CatalogAnalyticsTab behind `hasOpened` rather than just
// CSS `display:none` so the heavy /api/catalog-analytics/points
// fetch only fires for categories the operator actually inspects.
function CategoryAccordion({
  category,
  embedded,
}: {
  readonly category: CatalogFilterOption
  readonly embedded: {
    readonly categoryIds: ReadonlyArray<string>
    readonly brandIds?: ReadonlyArray<string>
    readonly distributorNames?: ReadonlyArray<string>
    readonly highlight: string
  }
}) {
  const [hasOpened, setHasOpened] = useState(false)
  return (
    <details
      className="page-collapsible"
      style={{ marginTop: 12 }}
      onToggle={(e) => {
        if ((e.currentTarget as HTMLDetailsElement).open) setHasOpened(true)
      }}
    >
      <summary>
        <strong>{category.label}</strong>{' '}
        <span className="subtle-copy">
          ({category.itemCount.toLocaleString()} live item
          {category.itemCount === 1 ? '' : 's'})
        </span>
      </summary>
      <div style={{ marginTop: 8 }}>
        {hasOpened ? (
          <CatalogAnalyticsTab
            embedded={{
              categoryIds: embedded.categoryIds,
              brandIds: embedded.brandIds,
              distributorNames: embedded.distributorNames,
              highlight: embedded.highlight,
              hideFilterBar: true,
              hideTopControls: false,
            }}
          />
        ) : (
          <p className="subtle-copy">Expand to load this category's scatter cards.</p>
        )}
      </div>
    </details>
  )
}

interface EntityResolution {
  readonly entity: CatalogFilterOption | null
  readonly categoriesWithPresence: ReadonlyArray<CatalogFilterOption>
}

function useEntityResolution(
  kind: EntityKind,
  entityKey: string | undefined,
): {
  readonly resolution: EntityResolution | null
  readonly loading: boolean
  readonly error: string | null
} {
  const [resolution, setResolution] = useState<EntityResolution | null>(null)
  const [loading, setLoading] = useState<boolean>(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!entityKey) {
      setLoading(false)
      setResolution(null)
      return
    }
    let cancelled = false
    setLoading(true)
    setError(null)

    // Two parallel calls:
    //   1. Unfiltered filters payload, just to resolve the
    //      brand/distributor label and confirm it exists.
    //   2. Filters payload scoped to this entity, which gives us
    //      the cumulative-narrowing categories[] for "where does
    //      this entity have presence". The server narrows each
    //      dimension by the OTHER dimensions' selections, so
    //      asking with brandIds=X returns categories that have
    //      nonzero co-occurrence with X.
    const unscopedUrl = '/api/catalog-analytics/filters'
    const scopedQs = new URLSearchParams()
    if (kind === 'brand') {
      scopedQs.set('brandIds', entityKey)
    } else {
      scopedQs.append('distributorNames', entityKey)
    }
    const scopedUrl = `/api/catalog-analytics/filters?${scopedQs.toString()}`

    Promise.all([
      loadJson(unscopedUrl, CatalogAnalyticsFiltersResponseSchema),
      loadJson(scopedUrl, CatalogAnalyticsFiltersResponseSchema),
    ])
      .then(([unscoped, scoped]) => {
        if (cancelled) return
        const entity = resolveEntity(kind, unscoped, entityKey)
        if (!entity) {
          setResolution({ entity: null, categoriesWithPresence: [] })
          return
        }
        // Drop categories that returned itemCount=0 — the cumulative
        // narrowing should already exclude them, but defend in depth
        // in case the server ever changes its semantics.
        const cats = scoped.categories
          .filter((c) => c.itemCount > 0)
          .slice()
          .sort((a, b) => {
            if (b.itemCount !== a.itemCount) return b.itemCount - a.itemCount
            return a.label.localeCompare(b.label)
          })
        setResolution({ entity, categoriesWithPresence: cats })
      })
      .catch((e) => {
        if (cancelled) return
        setError((e as Error).message)
        setResolution(null)
      })
      .finally(() => {
        if (cancelled) return
        setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [kind, entityKey])

  return { resolution, loading, error }
}

function resolveEntity(
  kind: EntityKind,
  filters: CatalogAnalyticsFiltersResponse,
  entityKey: string,
): CatalogFilterOption | null {
  if (kind === 'brand') {
    return filters.brands.find((b) => b.id === entityKey) ?? null
  }
  // Distributor "id" is the distributor name itself.
  return filters.distributors.find((d) => d.id === entityKey) ?? null
}

function MetricsEntityDetailPage({ kind }: { readonly kind: EntityKind }) {
  const params = useParams<{ brandId?: string; distributorName?: string }>()
  const entityKey = kind === 'brand' ? params.brandId : params.distributorName
  const { resolution, loading, error } = useEntityResolution(kind, entityKey)
  const indexHref = kind === 'brand' ? '/metrics/brands' : '/metrics/distributors'
  const indexLabel = kind === 'brand' ? 'Brands' : 'Distributors'

  const embeddedBase = useMemo(
    () =>
      kind === 'brand'
        ? { brandIds: entityKey ? [entityKey] : [] }
        : { distributorNames: entityKey ? [entityKey] : [] },
    [kind, entityKey],
  )

  return (
    <section className="metrics-dashboard">
      <header className="page-header metrics-dashboard-header">
        <div>
          <p className="eyebrow">
            <Link to={indexHref}>{indexLabel}</Link> /{' '}
            {kind === 'brand' ? 'Brand' : 'Distributor'} detail
          </p>
          <h2>{resolution?.entity?.label ?? entityKey ?? '—'}</h2>
        </div>
      </header>

      {loading ? (
        <p className="subtle-copy">Loading…</p>
      ) : error ? (
        <p className="error-message">Failed to load: {error}</p>
      ) : !resolution || !resolution.entity ? (
        <article className="history-card" style={{ marginTop: 16 }}>
          <p>{COPY[kind].notFound}</p>
          <p className="subtle-copy">
            <Link to={indexHref}>← Back to {indexLabel}</Link>
          </p>
        </article>
      ) : resolution.categoriesWithPresence.length === 0 ? (
        <article className="history-card" style={{ marginTop: 16 }}>
          <p>{COPY[kind].emptyCategories}</p>
        </article>
      ) : (
        <>
          <p className="subtle-copy" style={{ marginTop: 8 }}>
            {resolution.entity.itemCount.toLocaleString()} total live item
            {resolution.entity.itemCount === 1 ? '' : 's'} across{' '}
            {resolution.categoriesWithPresence.length} categor
            {resolution.categoriesWithPresence.length === 1 ? 'y' : 'ies'}.
            Expand a category to load its scatter cards. The{' '}
            <strong>{resolution.entity.label}</strong> label is seeded as the
            highlight on every card so {kind === 'brand' ? 'this brand' : "this distributor's"}{' '}
            products pop out of each category's distribution.
          </p>

          {resolution.categoriesWithPresence.map((cat) => (
            <CategoryAccordion
              key={cat.id}
              category={cat}
              embedded={{
                categoryIds: [cat.id],
                ...embeddedBase,
                highlight: resolution.entity!.label,
              }}
            />
          ))}
        </>
      )}
    </section>
  )
}

export function BrandDetailPage() {
  return (
    <MetricsAccessGate anyOf={['brands']} surfaceLabel="Brand detail">
      <MetricsEntityDetailPage kind="brand" />
    </MetricsAccessGate>
  )
}

export function DistributorDetailPage() {
  return (
    <MetricsAccessGate anyOf={['distributors']} surfaceLabel="Distributor detail">
      <MetricsEntityDetailPage kind="distributor" />
    </MetricsAccessGate>
  )
}
