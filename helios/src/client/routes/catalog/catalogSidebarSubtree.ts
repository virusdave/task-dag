import { useMemo } from 'react'

import { buildHeliosModulePath } from '../../../shared/contracts/index.js'
import { useRegisterSidebarSubtree } from '../../components/SidebarNavContext.js'
import type { TreeNavNode } from '../../components/TreeNav.js'

/**
 * Catalog module sidebar subtree.
 *
 * Helios uses one canonical primary tree-nav (the AppShell sidebar). Per
 * the standing rule that catalog must not render its own bespoke
 * subsystem-specific nav, every catalog route page calls this hook to
 * register the catalog subtree under the Catalog module branch in the
 * shared sidebar instead of rendering an in-page nav strip.
 *
 * The Images & Barcodes page passes dynamic children so the sidebar
 * surfaces in-page anchors for each non-empty site and quick-filter
 * brand links scoped to that page.
 */
export interface ImagesAndBarcodesSidebarOptions {
  siteAnchors: Array<{ siteKey: string; siteLabel: string; targetId: string; count: number }>
  brandQuickFilters: Array<{ brandName: string; count: number }>
  activeBrand: string | null
  imagesAndBarcodesPath: string
}

export function useRegisterCatalogSidebarSubtree(options?: { imagesAndBarcodes?: ImagesAndBarcodesSidebarOptions }): void {
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
        navKey: 'catalog.history',
        label: 'History',
        to: buildHeliosModulePath('catalog', 'history'),
      },
      // TODO(market-data-review): The FB-US "competitor price match review"
      // pages currently live in the mostly-static-sites Next.js app
      // (apps/freshlybakedus-site/app/internal/{midtown,bronx}-conquest/...)
      // and are reached here via external links into the OAuth-gated
      // /internal/ subtree on freshlybaked.us. The longer-term plan is to
      // migrate the matching UI (category/subcategory/variant/brand filters,
      // in-stock vs in-stock-related toggle, mobile-friendly review) into
      // Helios itself underneath the Catalog module, at which point these
      // two external leaves should be replaced with a Helios-native route.
      {
        kind: 'branch',
        navKey: 'catalog.market-data-review',
        label: 'Market data review',
        defaultOpen: false,
        children: [
          {
            kind: 'leaf',
            navKey: 'catalog.market-data-review.midtown',
            label: 'FB-US Midtown competitor matches (MSS)',
            externalHref:
              'https://freshlybaked.us/internal/midtown-conquest/conquest-index.html',
          },
          {
            kind: 'leaf',
            navKey: 'catalog.market-data-review.bronx',
            label: 'FB-US Bronx competitor matches (MSS)',
            externalHref:
              'https://freshlybaked.us/internal/bronx-conquest/conquest-index.html',
          },
        ],
      },
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
  const children: TreeNavNode[] = []
  if (options.siteAnchors.length > 0) {
    children.push({
      kind: 'branch',
      navKey: 'catalog.images-and-barcodes.sites',
      label: 'Sites',
      defaultOpen: true,
      children: options.siteAnchors.map((site) => ({
        kind: 'leaf' as const,
        navKey: `catalog.images-and-barcodes.site.${site.siteKey}`,
        label: site.siteLabel,
        targetId: site.targetId,
        count: site.count,
      })),
    })
  }
  if (options.brandQuickFilters.length > 0) {
    children.push({
      kind: 'branch',
      navKey: 'catalog.images-and-barcodes.brands',
      label: 'Brands',
      defaultOpen: false,
      children: [
        {
          kind: 'leaf' as const,
          navKey: 'catalog.images-and-barcodes.brand.__all__',
          label: options.activeBrand === null ? 'All brands' : `Clear: ${options.activeBrand}`,
          to: options.imagesAndBarcodesPath,
        },
        ...options.brandQuickFilters.map((brand) => ({
          kind: 'leaf' as const,
          navKey: `catalog.images-and-barcodes.brand.${brand.brandName}`,
          label: brand.brandName,
          to: `${options.imagesAndBarcodesPath}?brand=${encodeURIComponent(brand.brandName)}`,
          count: brand.count,
        })),
      ],
    })
  }
  return {
    kind: 'branch',
    navKey: 'catalog.images-and-barcodes',
    label: 'Images & Barcodes',
    to: options.imagesAndBarcodesPath,
    defaultOpen: true,
    children,
  }
}
