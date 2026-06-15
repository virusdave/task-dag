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
      // People — operator accounts and public-facing staff editorial.
      // Staff is physically routed under /utilities/staff but belongs in
      // the People group post-redesign (virusdave/top-level#14); the
      // route is unchanged.
      kind: 'branch',
      navKey: 'config.people',
      label: 'People',
      children: [
        {
          kind: 'leaf',
          navKey: 'config.users',
          label: 'Users',
          to: buildHeliosModulePath('config', 'users'),
        },
        {
          kind: 'leaf',
          navKey: 'config.staff',
          label: 'Staff',
          to: '/utilities/staff',
        },
      ],
    },
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
      // Marketing — segment automation (geofenced scan-location-based
      // assignment rules; route /config/marketing/geo-segment-rules).
      kind: 'branch',
      navKey: 'config.marketing',
      label: 'Marketing',
      children: [
        {
          kind: 'leaf',
          navKey: 'config.marketing.geo-segment-rules',
          label: 'Geo segment rules',
          to: buildHeliosModulePath('config', 'marketing/geo-segment-rules'),
        },
      ],
    },
    {
      // Integrations — external-system plumbing (Sweed session pool +
      // auth log).
      //
      // The former Config → LitAlerts → Brands pointer was removed in the
      // redesign: it duplicated the canonical Brand mapping entry under
      // Catalog & Inventory (route /catalog/brand-mapping is unchanged),
      // and a route appearing in two nav locations makes active-state
      // highlighting ambiguous.
      kind: 'branch',
      navKey: 'config.integrations',
      label: 'Integrations',
      children: [
        {
          kind: 'leaf',
          navKey: 'config.sweed-sessions',
          label: 'Sweed session pool',
          to: buildHeliosModulePath('config', 'sweed/sessions'),
        },
        {
          kind: 'leaf',
          navKey: 'config.sweed-auth-log',
          label: 'Sweed auth log',
          to: buildHeliosModulePath('config', 'sweed-auth-log'),
        },
      ],
    },
  ]
}

export function useRegisterConfigSidebarSubtree(): void {
  const subtree = useMemo<TreeNavNode[]>(() => buildConfigSidebarSubtree(), [])
  useRegisterSidebarSubtree('config', subtree)
}
