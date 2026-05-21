import { useMemo } from 'react'

import {
  buildHeliosModulePath,
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
}

export function useRegisterCatalogSidebarSubtree(options?: {
  imagesAndBarcodes?: ImagesAndBarcodesSidebarOptions
}): void {
  const imagesAndBarcodes = options?.imagesAndBarcodes
  const subtree = useMemo<TreeNavNode[]>(
    () => [
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
        navKey: 'catalog.pending-purchases',
        label: 'Pending purchases',
        to: buildHeliosModulePath('catalog', 'pending-purchases'),
      },
      buildImagesAndBarcodesNode(imagesAndBarcodes),
      {
        kind: 'leaf',
        navKey: 'catalog.new-entry',
        label: 'New entry',
        to: buildHeliosModulePath('catalog', 'new-entry'),
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
        navKey: 'catalog.whitelabel',
        label: 'WhiteLabel',
        to: buildHeliosModulePath('catalog', 'whitelabel/pricing'),
        defaultOpen: false,
        children: [
          {
            kind: 'leaf',
            navKey: 'catalog.whitelabel.pricing',
            label: 'Pricing',
            to: buildHeliosModulePath('catalog', 'whitelabel/pricing'),
          },
        ],
      },
      // Note: "Price comparison review" (FB-US Midtown/Bronx competitor
      // match review) now lives under Ads → Price comparison review
      // (see communicationsSidebar.ts). It's competitor pricing intel
      // for the ads / merchandising surface, not a catalog-mirroring
      // workflow.
    ],
    [imagesAndBarcodes],
  )
  useRegisterSidebarSubtree('catalog', subtree)
}

function buildImagesAndBarcodesNode(options: ImagesAndBarcodesSidebarOptions | undefined): TreeNavNode {
  if (!options) {
    return {
      kind: 'leaf',
      navKey: 'catalog.images-and-barcodes',
      label: 'Images & Barcodes',
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
    .filter((site) => site.totalIssueCount > 0)
    .map((site) => ({
      kind: 'leaf' as const,
      navKey: `catalog.images-and-barcodes.site.${site.siteKey}`,
      label: site.siteLabel,
      to: site.sitePath,
      count: site.totalIssueCount,
    }))
  return {
    kind: 'branch',
    navKey: 'catalog.images-and-barcodes',
    label: 'Images & Barcodes',
    to: options.indexPath,
    defaultOpen: true,
    children: siteLeaves,
  }
}
