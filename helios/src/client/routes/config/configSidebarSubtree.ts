import { useMemo } from 'react'

import {
  CONFIG_BACKGROUND_TASKS,
  buildHeliosModulePath,
} from '../../../shared/contracts/index.js'
import { useRegisterSidebarSubtree } from '../../components/SidebarNavContext.js'
import type { TreeNavNode } from '../../components/TreeNav.js'

/**
 * Config module sidebar subtree.
 *
 * Renders Workers > Scheduling > {Catalog, Litalerts, Stock} as branch+leaf
 * nodes inside the canonical primary sidebar. Each leaf links to a per-task
 * editor route; Catalog and Litalerts currently render TODO placeholders.
 */
export function useRegisterConfigSidebarSubtree(): void {
  const subtree = useMemo<TreeNavNode[]>(
    () => [
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
    ],
    [],
  )
  useRegisterSidebarSubtree('config', subtree)
}
