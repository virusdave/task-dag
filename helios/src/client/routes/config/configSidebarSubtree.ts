import { useMemo } from 'react'

import {
  CONFIG_BACKGROUND_TASKS,
  buildHeliosModulePath,
} from '../../../shared/contracts/index.js'
import { useRegisterSidebarSubtree } from '../../components/SidebarNavContext.js'
import type { TreeNavNode } from '../../components/TreeNav.js'

/**
 * Pure builder for the Config module sidebar subtree. Used both by the
 * AppShell (so the Config branch is populated on first load) and by
 * per-page hooks below for in-context registration.
 *
 * Renders Workers > Scheduling > {Catalog, Litalerts, Stock} as branch+leaf
 * nodes inside the canonical primary sidebar. Each leaf links to a per-task
 * editor route; Catalog and Litalerts currently render TODO placeholders.
 */
export function buildConfigSidebarSubtree(): TreeNavNode[] {
  return [
    {
      kind: 'branch',
      navKey: 'config.workers',
      label: 'Workers',
      to: buildHeliosModulePath('config', 'workers'),
      children: [
        {
          kind: 'branch',
          navKey: 'config.workers.scheduling',
          label: 'Scheduling',
          to: buildHeliosModulePath('config', 'workers/scheduling'),
          children: CONFIG_BACKGROUND_TASKS.map((task) => ({
            kind: 'leaf' as const,
            navKey: `config.workers.scheduling.${task.slug}`,
            label: task.label,
            to: buildHeliosModulePath('config', `workers/scheduling/${task.slug}`),
          })),
        },
      ],
    },
    {
      kind: 'branch',
      navKey: 'config.parsing',
      label: 'Parsing',
      to: buildHeliosModulePath('config', 'parsing/pending-purchases'),
      children: [
        {
          kind: 'leaf',
          navKey: 'config.parsing.pending-purchases',
          label: 'Purchases',
          to: buildHeliosModulePath('config', 'parsing/pending-purchases'),
        },
        {
          kind: 'leaf',
          navKey: 'config.parsing.litalerts',
          label: 'LitAlerts',
          to: buildHeliosModulePath('config', 'parsing/litalerts'),
        },
      ],
    },
    {
      kind: 'branch',
      navKey: 'config.litalerts',
      label: 'LitAlerts',
      to: buildHeliosModulePath('catalog', 'brand-mapping'),
      children: [
        {
          // Brand-mapping page is physically routed under /catalog/brand-mapping
          // because the data lives in `catalog_litalerts_brand_overrides` and
          // the page was originally introduced under Catalog. We expose it
          // here too so operators discover it where they expect (Config →
          // LitAlerts → Brands), matching the place where other LitAlerts
          // settings live.
          kind: 'leaf',
          navKey: 'config.litalerts.brands',
          label: 'Brands',
          to: buildHeliosModulePath('catalog', 'brand-mapping'),
        },
      ],
    },
    {
      kind: 'leaf',
      navKey: 'config.users',
      label: 'Users',
      to: buildHeliosModulePath('config', 'users'),
    },
    {
      kind: 'leaf',
      navKey: 'config.sweed-auth-log',
      label: 'Sweed auth log',
      to: buildHeliosModulePath('config', 'sweed-auth-log'),
    },
  ]
}

export function useRegisterConfigSidebarSubtree(): void {
  const subtree = useMemo<TreeNavNode[]>(() => buildConfigSidebarSubtree(), [])
  useRegisterSidebarSubtree('config', subtree)
}
