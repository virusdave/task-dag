import type { TreeNavNode } from '../../components/TreeNav.js'

/**
 * Canonical sidebar subtree for the Tasks (Git-DAG epic + frontier)
 * surfaces. Tasks is not a `HELIOS_MODULES` entry — it's a top-level
 * operator nav peer of Jobs / Audit history — so the AppShell wires it
 * in directly rather than via the per-module subtree map.
 *
 * The Tasks branch label itself navigates to /tasks (the epic list);
 * the Frontier leaf surfaces the cross-epic frontier of leaf tasks
 * ready to be picked up.
 */
export const TASKS_SIDEBAR_SUBTREE: TreeNavNode[] = [
  {
    kind: 'leaf',
    navKey: 'tasks.frontier',
    label: 'Frontier',
    to: '/tasks/frontier',
  },
]
