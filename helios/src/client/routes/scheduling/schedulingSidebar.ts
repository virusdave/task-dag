import { buildHeliosModulePath } from '../../../shared/contracts/index.js'
import type { TreeNavNode } from '../../components/TreeNav.js'

/**
 * Canonical sidebar subtree for the Scheduling module. Rendered by
 * AppShell directly so the Scheduling branch is populated on first
 * load.
 *
 * The Scheduling branch label itself navigates to /scheduling (the run
 * history). Adding `New run` as a leaf gives operators one-click access
 * to queue a fresh natural-language scheduling run.
 */
export const SCHEDULING_SIDEBAR_SUBTREE: TreeNavNode[] = [
  {
    kind: 'leaf',
    navKey: 'scheduling.new',
    label: 'New run',
    to: buildHeliosModulePath('scheduling', 'new'),
  },
  {
    kind: 'leaf',
    navKey: 'scheduling.runs',
    label: 'Run history',
    to: buildHeliosModulePath('scheduling'),
  },
]
