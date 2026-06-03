import { useEffect, useState } from 'react'
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
//     <CatalogAnalyticsTab /> in embedded mode, scoped ONLY to the
//     accordion's category, with this entity's brand / distributor
//     label seeded into the structured Highlight section across every
//     scatter card.
//
// HIGHLIGHT, NOT FILTER (operator decision, 2026-06-02, after this
// page shipped with the brand/distributor pre-applied as a *filter*
// instead of a highlight):
//   * We MUST NOT pre-filter the embedded scatter to the entity's
//     brand / distributor. Pre-filtering hides the contextual cloud
//     of competing products and defeats the entire purpose of the
//     detail page, which is to ask "how does this brand sit IN the
//     rest of its category".
//   * We MUST NOT hide the page-wide filter bar. A filtered view
//     with no visible / engageable filter chips is a forbidden
//     antipattern (per operator). The category filter the detail
//     page itself sets up is visible in the chip strip exactly like
//     any other filter and can be cleared/broadened.
//   * The brand / distributor goes in via the structured Highlight
//     section only (highlightBrandNames / highlightDistributorNames),
//     which visually dims non-matching dots without removing them
//     from the scatter.
//
// Why this shape vs. one big mounted catalog tab:
//   * Per-category framing matches how operators reason about
//     merchandising decisions ("how does Cresco's flower sit in our
//     1g flower curve vs. how do their gummies sit in our edibles
//     curve?"). Mixed-category scatters bury that.
//   * Lazy mounting keeps initial paint fast even when an entity is
//     present across 10+ categories. Each accordion expand is a
//     separate /api/catalog-analytics/points fetch scoped to ~hundreds
//     to a couple thousand points (the full category, NOT just this
//     entity) instead of the unscoped tens-of-thousands cloud.
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
    /**
     * Per-accordion category scope. This IS a real filter (we
     * intentionally scope the embedded scatter to ONE category at a
     * time so the per-category framing the page promises actually
     * holds). It's still exposed as a chip in the visible filter bar
     * so the operator can broaden out of the category if they want.
     */
    readonly categoryIds: ReadonlyArray<string>
    /**
     * Pre-seeds the structured Highlight section's Brand chip.
     * Set by BrandDetailPage; undefined for DistributorDetailPage.
     * NOTE: this is HIGHLIGHT, not FILTER — the embedded scatter
     * still loads every product in the category so this brand's
     * dots can be seen in context.
     */
    readonly highlightBrandNames?: ReadonlyArray<string>
    /**
     * Pre-seeds the structured Highlight section's Distributor chip.
     * Set by DistributorDetailPage; undefined for BrandDetailPage.
     * Same HIGHLIGHT, not FILTER semantics as highlightBrandNames.
     */
    readonly highlightDistributorNames?: ReadonlyArray<string>
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
            // FORCE-REMOUNT when the embedded scope changes (category /
            // entity / highlight seed). Without this, navigating from
            // one brand detail page to another (e.g. Revert →
            // Quality Control) leaves the previously-mounted accordion
            // and its nested `CatalogAnalyticsTab` reused — but the
            // tab's `embeddedRef.current` and derived state
            // (highlightState, selectedCategoryIds, etc.) are
            // initialised once and only once at mount. The chart
            // header and URL update to "Quality Control" while the
            // embedded scatter still highlights the previous brand's
            // products. June 2026 bug: on /metrics/brands/Quality
            // Control → Edibles, the visible highlighted dot was a
            // Revert product, because the accordion had been mounted
            // earlier on the Revert brand page. Re-keying forces a
            // clean mount whenever any embedded prop changes.
            key={[
              embedded.categoryIds.join('\u001f'),
              (embedded.highlightBrandNames ?? []).join('\u001f'),
              (embedded.highlightDistributorNames ?? []).join('\u001f'),
            ].join('\u001e')}
            embedded={{
              categoryIds: embedded.categoryIds,
              // INTENTIONALLY NOT passing brandIds /
              // distributorNames here. The detail page's purpose is
              // to HIGHLIGHT this entity in the full category cloud,
              // not to FILTER the cloud down to just this entity —
              // see "HIGHLIGHT, NOT FILTER" in the module header.
              // Operator decision 2026-06-02.
              //
              // The structured Highlight chip is pre-seeded below.
              // It uses the human-visible brand / distributor NAME
              // (matching CATALOG_HIGHLIGHT_DIMS pointKey), so e.g.
              // "Cresco" as a chip only matches products whose
              // brand_name === "Cresco" — not strain names that
              // happen to contain "Cresco".
              highlightBrandNames: embedded.highlightBrandNames,
              highlightDistributorNames: embedded.highlightDistributorNames,
              // hideFilterBar: false (omitted). Hiding the filter
              // bar while pre-applying any filter is a forbidden
              // antipattern. The operator must always be able to
              // see / engage with the filter chips, including the
              // category chip the detail page pre-selects.
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

  // NOTE: previously this page built an `embeddedBase` with
  // { brandIds: [entityKey] } / { distributorNames: [entityKey] }
  // and spread it into the per-category embedded prop. That made
  // the embedded scatter pre-FILTER to just this entity, hiding
  // the contextual cloud and silently dropping the filter chips
  // (because hideFilterBar=true was also being passed). Both are
  // forbidden antipatterns — see module header. The only thing
  // the parent page needs to push down is the per-category id
  // (set inside the accordion loop) and the highlight chip seed.

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
            structured Highlight chip on every card so{' '}
            {kind === 'brand' ? 'this brand' : "this distributor's"} products
            pop out of each category's full distribution — the embedded
            scatter is NOT filtered to {kind === 'brand' ? 'this brand' : 'this distributor'}{' '}
            (the entire category cloud loads as context), and the filter
            chips remain visible so you can broaden out of the category
            or narrow further as you like.
          </p>

          {resolution.categoriesWithPresence.map((cat) => (
            <CategoryAccordion
              // Key by entity + category so React unmounts/remounts
              // the accordion (and its embedded scatter) when the
              // operator navigates from one brand/distributor detail
              // page to another. Without this, React's keyed-list
              // reconciliation reuses the same accordion DOM/state
              // across navigations and the embedded scatter ends up
              // showing stale highlight chips (see bug note below).
              key={`${kind}:${resolution.entity!.id}:${cat.id}`}
              category={cat}
              embedded={{
                categoryIds: [cat.id],
                // Pre-seed the structured Highlight chip with the
                // entity's NAME (matches the chip id used by
                // CATALOG_HIGHLIGHT_DIMS, which keys on the
                // human-visible name). Only set the chip for the
                // dimension we're actually highlighting on.
                ...(kind === 'brand'
                  ? { highlightBrandNames: [resolution.entity!.label] }
                  : { highlightDistributorNames: [resolution.entity!.label] }),
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
