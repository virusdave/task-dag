import { buildHeliosModulePath } from '../../../shared/contracts/index.js'
import type { TreeNavNode } from '../../components/TreeNav.js'

/**
 * Canonical sidebar subtree for the Screens module. Rendered by AppShell
 * directly so the Screens branch is populated on first load, regardless
 * of which page the operator is currently looking at.
 *
 * The Screens branch label itself navigates to /screens (the module
 * landing: banner-health, fallback clone, promo rebind workflows); the
 * Devices leaf surfaces the per-dealer screens list + immediate image
 * banner sync queue trigger.
 */
export const SCREENS_SIDEBAR_SUBTREE: TreeNavNode[] = [
  {
    kind: 'leaf',
    navKey: 'screens.devices',
    label: 'Devices',
    to: buildHeliosModulePath('screens', 'devices'),
  },
]
