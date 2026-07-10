import { useMemo } from 'react'

import {
  buildHeliosModulePath,
  HELIOS_PENDING_PURCHASE_SITE_DEALERS,
  type CatalogMaintenanceSurveyResponse,
} from '../../../shared/contracts/index.js'
import { useRegisterSidebarSubtree } from '../../components/SidebarNavContext.js'
import type { TreeNavNode } from '../../components/TreeNav.js'

/**
 * Canonical paths for the Images & Barcodes pages.
 *
 *   /catalog/maintenance                — site index (landing).
 *   /catalog/maintenance/site/:siteKey  — per-site card list (+ optional
 *                                          ?brand= query for in-site brand
 *                                          filter).
 *
 * Brands live UNDER sites (never as top-level peers) because an operator
 * physically standing in site A cannot photograph stock that is only
 * present in site B.
 */
export function buildMaintenanceIndexPath(): string {
  return buildHeliosModulePath('catalog', 'maintenance')
}

export function buildMaintenanceSitePath(siteKey: string): string {
  return `${buildMaintenanceIndexPath()}/site/${encodeURIComponent(siteKey)}`
}

export function buildLowInventorySitePath(siteKey: string): string {
  return `${buildHeliosModulePath('catalog', 'inventory/low')}/${encodeURIComponent(siteKey)}`
}

/**
 * Derive per-site brand quick-filter entries from a survey response.
 * Brand counts are scoped to groups in that site, not the cross-site
 * total. Used by both the sidebar (for nav) and the site page (for the
 * in-page brand chip filter).
 */
export function computePerSiteBrandFilters(
  survey: CatalogMaintenanceSurveyResponse,
): ImagesAndBarcodesSiteEntry[] {
  return survey.sites.map((site) => {
    const brandCounts = new Map<string, number>()
    for (const section of site.sections) {
      for (const group of section.groups) {
        const name = (group.brandName ?? '').trim()
        if (name.length === 0) continue
        brandCounts.set(name, (brandCounts.get(name) ?? 0) + 1)
      }
    }
    const brands: ImagesAndBarcodesSiteBrandFilter[] = Array.from(brandCounts.entries())
      .map(([brandName, issueCount]) => ({ brandName, issueCount }))
      .sort((a, b) => {
        if (b.issueCount !== a.issueCount) return b.issueCount - a.issueCount
        return a.brandName.localeCompare(b.brandName)
      })
    return {
      siteKey: site.siteKey,
      siteLabel: site.siteLabel,
      totalIssueCount: site.totalIssueCount,
      pendingImportCount: site.pendingImportCount,
      brands,
      sitePath: buildMaintenanceSitePath(site.siteKey),
    }
  })
}

/**
 * Catalog module sidebar subtree.
 *
 * Helios uses one canonical primary tree-nav (the AppShell sidebar). Per
 * the standing rule that catalog must not render its own bespoke
 * subsystem-specific nav, every catalog route page calls this hook to
 * register the catalog subtree under the Catalog module branch in the
 * shared sidebar instead of rendering an in-page nav strip.
 *
 * The Images & Barcodes pages pass dynamic children so the sidebar
 * surfaces a sites→brands subtree scoped to each store. Brands are
 * always nested under the site they exist in (an operator standing in
 * Midtown should never see Bronx-only brands as an option — they
 * physically cannot photograph a Bronx-only product).
 */
export interface ImagesAndBarcodesSiteBrandFilter {
  brandName: string
  /** Issue count WITHIN this site only (not the cross-site total). */
  issueCount: number
}

export interface ImagesAndBarcodesSiteEntry {
  siteKey: string
  siteLabel: string
  /** Total candidates within this site. */
  totalIssueCount: number
  /** Just-received items at this site still being imported (not yet
   * workable as photo/barcode cards). */
  pendingImportCount: number
  /** Brands present in this site's candidate set, sorted by site-local
   * issue count desc then alpha. */
  brands: ImagesAndBarcodesSiteBrandFilter[]
  /** Router path for the site page (e.g. /catalog/maintenance/site/midtown). */
  sitePath: string
}

export interface ImagesAndBarcodesSidebarOptions {
  /** Path to the index page (e.g. /catalog/maintenance). */
  indexPath: string
  sites: ImagesAndBarcodesSiteEntry[]
  /** When set, marks which site branch should be open by default. */
  activeSiteKey: string | null
  /** When set, marks which brand link should be highlighted (within the
   * active site). */
  activeBrand: string | null
  /** True when the live barcode pull failed and barcode work was
   * suppressed server-side. Sites whose only work is hidden barcode
   * tasks must still appear in the tree (otherwise the operator can't
   * reach them to reload), so the issue-count filter is relaxed. */
  barcodeCheckUnavailable?: boolean
}

export interface PendingPurchasesSidebarOptions {
  /**
   * Optional packet hierarchy children rendered nested under the
   * "Pending purchases" branch. Pass `null` (or omit the option) when
   * no packet is loaded so the entry collapses back to a plain leaf.
   * When present, each leaf's `targetId` is an in-page anchor id
   * matching the rendered `<details id="...">` group in
   * PendingPurchasesPage.
   */
  packetHierarchy: TreeNavNode[] | null
}

export interface CatalogSidebarOptions {
  imagesAndBarcodes?: ImagesAndBarcodesSidebarOptions
  pendingPurchases?: PendingPurchasesSidebarOptions
}

/**
 * Pure builder for the catalog module sidebar subtree. Used statically
 * by the AppShell so every operator sees the full Catalog tree on first
 * load — and used by per-page hooks below to augment it with contextual
 * children (per-site brand filters, packet hierarchy, etc.).
 */
export function buildCatalogSidebarSubtree(options?: CatalogSidebarOptions): TreeNavNode[] {
  const imagesAndBarcodes = options?.imagesAndBarcodes
  const pendingPurchases = options?.pendingPurchases
  return [
    {
      kind: 'leaf',
      navKey: 'catalog.browser',
      label: 'Browser',
      to: buildHeliosModulePath('catalog', 'browser'),
    },
    {
      kind: 'leaf',
      navKey: 'catalog.review',
      label: 'Review queue',
      to: buildHeliosModulePath('catalog', 'review'),
    },
    {
      kind: 'leaf',
      navKey: 'catalog.market-data',
      label: 'Market data',
      to: buildHeliosModulePath('catalog', 'market-data'),
    },
    {
      kind: 'leaf',
      navKey: 'catalog.brand-mapping',
      label: 'Brand mapping',
      to: buildHeliosModulePath('catalog', 'brand-mapping'),
    },
    buildPendingPurchasesNode(pendingPurchases),
    {
      kind: 'leaf',
      navKey: 'catalog.purchases',
      label: 'Purchase sell-through',
      to: buildHeliosModulePath('catalog', 'purchases'),
    },
    buildImagesAndBarcodesNode(imagesAndBarcodes),
    ...HELIOS_PENDING_PURCHASE_SITE_DEALERS.map((site) => ({
      kind: 'leaf' as const,
      navKey: `catalog.low-inventory.${site.siteKey}`,
      label: `Low inventory · ${site.siteLabel}`,
      to: buildLowInventorySitePath(site.siteKey),
    })),
    {
      // Canonical home for "refresh current inventory stock for a site"
      // (virusdave/top-level#14). Previously this could only be triggered
      // as a side effect of the Images & Barcodes "Fix cache" button or
      // the Config → Workers → Scheduling → Stock "Run now" control;
      // neither was the obvious place to look. The page reuses the same
      // existing enqueue job (workers.scheduling.stock run-now) — no new
      // backend service.
      kind: 'leaf',
      navKey: 'catalog.stock-refresh',
      label: 'Stock refresh',
      to: '/catalog/inventory/stock-refresh',
    },
    {
      kind: 'leaf',
      // Edible THC clamp lives in the same catalog-maintenance vein as
      // Images & Barcodes — both are floor-operator-driven catalog fixups
      // that shouldn't live under config/workers/scheduling alongside the
      // background-task editor pages. The page itself just triggers the
      // shared `config.workers.edible_thc_clamp` job (which also runs on
      // a 15-minute scheduler) so daily-purchase-limit miscalcs from
      // name-derived totals over 100mg/package get corrected even if no
      // operator is watching.
      navKey: 'catalog.edible-thc-clamp',
      label: 'Edible THC clamp',
      to: buildHeliosModulePath('catalog', 'edible-thc-clamp'),
    },
    {
      // Warehouse Locations — floor-operator packing workflow that stamps
      // a physical shelf location onto each package's Sweed
      // internalTrackCode. Lives next to the other catalog-maintenance
      // floor tools (Images & Barcodes, Edible THC clamp).
      kind: 'leaf',
      navKey: 'catalog.warehouse-locations',
      label: 'Warehouse Locations',
      to: buildHeliosModulePath('catalog', 'warehouse-locations'),
    },
    {
      kind: 'leaf',
      navKey: 'catalog.new-entry',
      label: 'New entry',
      to: buildHeliosModulePath('catalog', 'new-entry'),
    },
    {
      // TEMPORARY (issue #55 step 1): operator-only audit surface to
      // iterate on categorical-family grouping correctness before the
      // richer per-family pricing UX is built in later steps.
      kind: 'leaf',
      navKey: 'catalog.family-explorer',
      label: 'Family Explorer (temp)',
      to: buildHeliosModulePath('catalog', 'family-explorer'),
    },
    // Pricing was previously its own top-level module branch but is
    // now scoped under Catalog: pricing runs are a catalog reviewer
    // workflow, not a separate operator surface. The /pricing/* routes
    // are unchanged; this just gives them a discoverable home in the
    // sidebar tree.
    {
      kind: 'branch',
      navKey: 'catalog.pricing',
      label: 'Pricing',
      to: buildHeliosModulePath('pricing', 'generate'),
      defaultOpen: false,
      children: [
        {
          kind: 'leaf',
          navKey: 'catalog.pricing.generate',
          label: 'New run',
          to: buildHeliosModulePath('pricing', 'generate'),
        },
        {
          kind: 'leaf',
          navKey: 'catalog.pricing.runs',
          label: 'Run history',
          to: buildHeliosModulePath('pricing', 'runs'),
        },
        {
          kind: 'leaf',
          navKey: 'catalog.pricing.review',
          label: 'Review queue',
          to: buildHeliosModulePath('pricing', 'review'),
        },
      ],
    },
    {
      kind: 'leaf',
      navKey: 'catalog.history',
      label: 'History',
      to: buildHeliosModulePath('catalog', 'history'),
    },
    {
      kind: 'branch',
      navKey: 'catalog.whiteglove',
      label: 'WhiteGlove',
      to: buildHeliosModulePath('catalog', 'whiteglove/pricing'),
      defaultOpen: false,
      children: [
        {
          kind: 'leaf',
          navKey: 'catalog.whiteglove.pricing',
          label: 'Pricing',
          to: buildHeliosModulePath('catalog', 'whiteglove/pricing'),
        },
      ],
    },
    // Note: "Price comparison review" (FB-US Midtown/Bronx competitor
    // match review) now lives under Ads → Price comparison review
    // (see communicationsSidebar.ts). It's competitor pricing intel
    // for the ads / merchandising surface, not a catalog-mirroring
    // workflow.
  ]
}

export function useRegisterCatalogSidebarSubtree(options?: CatalogSidebarOptions): void {
  const imagesAndBarcodes = options?.imagesAndBarcodes
  const pendingPurchases = options?.pendingPurchases
  const subtree = useMemo<TreeNavNode[]>(
    () => buildCatalogSidebarSubtree({ imagesAndBarcodes, pendingPurchases }),
    [imagesAndBarcodes, pendingPurchases],
  )
  useRegisterSidebarSubtree('catalog', subtree)
}

function buildPendingPurchasesNode(options: PendingPurchasesSidebarOptions | undefined): TreeNavNode {
  const to = buildHeliosModulePath('catalog', 'pending-purchases')
  const children = options?.packetHierarchy ?? null
  if (!children || children.length === 0) {
    return {
      kind: 'leaf',
      navKey: 'catalog.pending-purchases',
      label: 'Pending purchases',
      to,
    }
  }
  return {
    kind: 'branch',
    navKey: 'catalog.pending-purchases',
    label: 'Pending purchases',
    to,
    defaultOpen: true,
    children,
  }
}

function buildImagesAndBarcodesNode(options: ImagesAndBarcodesSidebarOptions | undefined): TreeNavNode {
  if (!options) {
    return {
      kind: 'leaf',
      navKey: 'catalog.images-and-barcodes',
      label: 'Photos & Barcodes',
      to: buildHeliosModulePath('catalog', 'maintenance'),
    }
  }
  // Sites are LEAVES (not branches) in the sidebar — one tap navigates
  // straight to the per-site page. We deliberately do NOT nest brands
  // underneath each site here:
  //   * On phones, a 1rem +/- box is impossible to tap reliably, and
  //     tapping the row navigates instead of expanding. Operators were
  //     left with "Midtown" and "Bronx" rows that wouldn't expand.
  //   * Brand drill-down lives in the in-page SiteBrandFilterStrip
  //     (which works the same on phone and desktop), so we'd just be
  //     duplicating it with a much worse touch target.
  // Reference: the per-task UX critique in
  // T-019e437d-85c8-7588-ad92-cc80f25eded0 explicitly recommended
  // site-only nav for the mobile-collapsed case.
  const siteLeaves: TreeNavNode[] = options.sites
    .filter(
      (site) =>
        site.totalIssueCount > 0 ||
        site.pendingImportCount > 0 ||
        options.barcodeCheckUnavailable === true,
    )
    .map((site) => ({
      kind: 'leaf' as const,
      navKey: `catalog.images-and-barcodes.site.${site.siteKey}`,
      label: site.siteLabel,
      to: site.sitePath,
      // Surface the count of tasks to fix; a site that only has items still
      // importing (no current tasks) still shows in the tree so the operator
      // can open it and tap "Check for new or updated stock".
      count: site.totalIssueCount,
    }))
  return {
    kind: 'branch',
    navKey: 'catalog.images-and-barcodes',
    label: 'Photos & Barcodes',
    to: options.indexPath,
    defaultOpen: true,
    children: siteLeaves,
  }
}
