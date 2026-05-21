import type { TreeNavNode } from '../../components/TreeNav.js'

/**
 * Shared sidebar subtree for the Utilities module. Any page under
 * /utilities/* registers this via
 * `useRegisterSidebarSubtree('utilities', UTILITIES_SIDEBAR_SUBTREE)`
 * so the same leaves stay visible across the module.
 */
export const UTILITIES_SIDEBAR_SUBTREE: TreeNavNode[] = [
  {
    kind: 'leaf',
    navKey: 'utilities.staff',
    label: 'Staff',
    to: '/utilities/staff',
  },
]
