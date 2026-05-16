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
 */
export function useRegisterCatalogSidebarSubtree(): void {
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
      {
        kind: 'leaf',
        navKey: 'catalog.maintenance',
        label: 'Maintenance',
        to: buildHeliosModulePath('catalog', 'maintenance'),
      },
      {
        kind: 'leaf',
        navKey: 'catalog.history',
        label: 'History',
        to: buildHeliosModulePath('catalog', 'history'),
      },
    ],
    [],
  )
  useRegisterSidebarSubtree('catalog', subtree)
}
