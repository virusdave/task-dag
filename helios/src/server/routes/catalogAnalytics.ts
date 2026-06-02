import type { FastifyInstance } from 'fastify'

import {
  CatalogAnalyticsFiltersRequestSchema,
  CatalogAnalyticsFiltersResponseSchema,
  CatalogAnalyticsPointsRequestSchema,
  CatalogAnalyticsPointsResponseSchema,
} from '../../shared/contracts/index.js'
import { requireMetricsGrant } from '../auth/requireSession.js'
import {
  CATALOG_ANALYTICS_DEFAULT_WINDOW_DAYS,
  getCatalogAnalyticsFilters,
  getCatalogAnalyticsPoints,
} from '../catalogAnalytics/catalogAnalyticsQueries.js'

const DAY_MS = 86_400_000

export async function registerCatalogAnalyticsRoutes(
  server: FastifyInstance,
): Promise<void> {
  // GET /api/catalog-analytics/filters?sites=&categoryIds=&subcategoryIds=&brandIds=&sizes=
  // Returns the available dropdown options (categories / subcategories /
  // brands / sizes) for the filter bar on the /metrics → Catalog
  // analytics tab. Restricted to packages currently visible on
  // sweed_package_current.
  //
  // Cumulative semantics: passing any non-empty dimension list narrows
  // the OTHER dimensions' option sets / counts to items matching those
  // selections. A dimension's own selection is intentionally not
  // applied to itself (so the user always sees the full peer set in
  // its own dropdown).
  server.get('/api/catalog-analytics/filters', async (request, reply) => {
    // The catalog analytics filters payload powers three nav children:
    // Explore's Catalog tab, the Brands index/detail surface, and
    // the Distributors index/detail surface. Any of the three grants
    // is enough; admins always pass.
    const user = await requireMetricsGrant(
      request,
      reply,
      'explore',
      'brands',
      'distributors',
    )
    if (!user) return
    const parsed = CatalogAnalyticsFiltersRequestSchema.parse(request.query ?? {})
    const result = await getCatalogAnalyticsFilters({
      sites: parsed.sites,
      categoryIds: parsed.categoryIds,
      subcategoryIds: parsed.subcategoryIds,
      brandIds: parsed.brandIds,
      distributorNames: parsed.distributorNames,
      sizes: parsed.sizes,
      packCounts: parsed.packCounts,
    })
    return reply.send(CatalogAnalyticsFiltersResponseSchema.parse(result))
  })

  // GET /api/catalog-analytics/points?from&to&sites&categoryIds&…
  // Returns one point per inventory_item_id over the requested window
  // with all per-variant scatter metrics computed.
  server.get('/api/catalog-analytics/points', async (request, reply) => {
    // Same multi-surface gate as /filters above.
    const user = await requireMetricsGrant(
      request,
      reply,
      'explore',
      'brands',
      'distributors',
    )
    if (!user) return
    const parsed = CatalogAnalyticsPointsRequestSchema.parse(request.query ?? {})

    const to = parsed.to ? new Date(parsed.to) : new Date()
    const from = parsed.from
      ? new Date(parsed.from)
      : new Date(to.getTime() - CATALOG_ANALYTICS_DEFAULT_WINDOW_DAYS * DAY_MS)

    const result = await getCatalogAnalyticsPoints({
      from,
      to,
      sites: parsed.sites,
      categoryIds: parsed.categoryIds,
      subcategoryIds: parsed.subcategoryIds,
      brandIds: parsed.brandIds,
      distributorNames: parsed.distributorNames,
      sizes: parsed.sizes,
      packCounts: parsed.packCounts,
    })
    return reply.send(CatalogAnalyticsPointsResponseSchema.parse(result))
  })
}
