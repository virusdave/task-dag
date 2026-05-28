import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Outlet, useLoaderData, useLocation, useNavigate } from 'react-router-dom'

import {
  buildHeliosModulePath,
  getHeliosModuleDefinition,
  type HeliosModuleCode,
  type SessionEnvelope,
} from '../../shared/contracts/index.js'
import { buildAppPath } from '../app/paths.js'
import { buildCatalogSidebarSubtree } from '../routes/catalog/catalogSidebarSubtree.js'
import { buildCommunicationsSidebarSubtree } from '../routes/communications/communicationsSidebar.js'
import { buildConfigSidebarSubtree } from '../routes/config/configSidebarSubtree.js'
import { REVIEWS_SIDEBAR_SUBTREE } from '../routes/customerReviews/customerReviewsSidebar.js'
import { SCHEDULING_SIDEBAR_SUBTREE } from '../routes/scheduling/schedulingSidebar.js'
import { SCREENS_SIDEBAR_SUBTREE } from '../routes/screens/screensSidebar.js'
import { TASKS_SIDEBAR_SUBTREE } from '../routes/tasks/tasksSidebar.js'
import { UTILITIES_SIDEBAR_SUBTREE } from '../routes/utilities/utilitiesSidebar.js'
import { Pill } from './Pill.js'
import { SidebarNavProvider, useSidebarNav } from './SidebarNavContext.js'
import { TreeNav, type TreeNavNode } from './TreeNav.js'

const SIDEBAR_COLLAPSED_STORAGE_KEY = 'helios.sidebar.collapsed'
// Bumped to .v3 when primary sidebar branches started collapsed by default
// except for branches needed to reveal the current page, so existing
// operators do not keep stale open state from the old default.
const SIDEBAR_TREE_STORAGE_KEY = 'helios.sidebar.tree.v3'
const MOBILE_BREAKPOINT_QUERY = '(max-width: 960px)'

function isAnyModalOpen(): boolean {
  if (typeof document === 'undefined') {
    return false
  }
  const candidates = document.querySelectorAll<HTMLElement>('[role="dialog"], [aria-modal="true"]')
  for (const element of candidates) {
    if (element.getAttribute('aria-hidden') === 'true') {
      continue
    }
    // Visible if it has any layout box (offsetParent !== null OR width/height > 0).
    const isVisible =
      element.offsetParent !== null || element.getClientRects().length > 0
    if (isVisible) {
      return true
    }
  }
  return false
}

/**
 * Canonical static subtrees per module. Rendered by the AppShell on
 * first load so every operator sees the FULL Helios IA from the start —
 * not just the bare module labels of whichever route they haven't
 * mounted yet. Individual pages may still override their module's
 * subtree via `useRegisterSidebarSubtree(...)` (see
 * SidebarNavContext.tsx); overrides go through `subtreesByModule` and
 * win over the static default.
 *
 * `crm` is intentionally absent: it's marked rolloutStatus='planned' in
 * HELIOS_MODULES and has no real subroutes yet, so it renders as a leaf
 * (see `buildPrimarySidebarNodes` below) instead of a branch with no
 * children.
 *
 * `pricing` is intentionally absent: its routes are surfaced under the
 * Catalog branch's Pricing sub-branch (see catalogSidebarSubtree.ts),
 * not as a top-level module.
 */
const STATIC_MODULE_SUBTREES: Partial<Record<HeliosModuleCode, TreeNavNode[]>> = {
  communications: buildCommunicationsSidebarSubtree(),
  catalog: buildCatalogSidebarSubtree(),
  screens: SCREENS_SIDEBAR_SUBTREE,
  scheduling: SCHEDULING_SIDEBAR_SUBTREE,
  reviews: REVIEWS_SIDEBAR_SUBTREE,
  utilities: UTILITIES_SIDEBAR_SUBTREE,
  config: buildConfigSidebarSubtree(),
}

/**
 * Explicit primary-sidebar IA. We deliberately do NOT derive this from
 * `HELIOS_MODULES` order — that array is domain metadata and can't
 * represent Dashboard / Tasks / Jobs / Audit history, nor the
 * intentional ordering (workflow-first, ops next, meta last).
 *
 * Order:
 *   1. Dashboard           — the index page; gives reviewers an at-a-glance home.
 *   2. Ads (communications)— daily ads workflow (Drive ingest, cluster proposals, packet review).
 *   3. Catalog             — primary catalog mirroring + reviewer queue (includes Pricing as sub-branch).
 *   4. Screens             — banner refresh / fallback clone / promo rebind jobs.
 *   5. Scheduling          — employee scheduling runs.
 *   6. Reviews             — customer-sentiment capture (issue #13).
 *   7. Utilities           — cross-cutting one-offs (Staff editorial, etc.).
 *   8. Jobs                — cross-module job queue.
 *   9. Audit history       — cross-module audit timeline.
 *  10. Tasks               — Git-DAG epic / frontier surfaces.
 *  11. Config              — meta settings (worker schedules, users, Sweed auth log).
 *  12. CRM                 — planned; leaf only.
 */
function buildPrimarySidebarNodes(
  subtreesByModule: Partial<Record<HeliosModuleCode, TreeNavNode[]>>,
): TreeNavNode[] {
  function subtreeFor(code: HeliosModuleCode): TreeNavNode[] {
    // Page-supplied dynamic override wins over the static default. If a
    // page registers an empty array we treat that as "no override" so
    // the canonical subtree stays visible.
    const override = subtreesByModule[code]
    if (override && override.length > 0) {
      return override
    }
    return STATIC_MODULE_SUBTREES[code] ?? []
  }

  function moduleBranch(code: HeliosModuleCode): TreeNavNode {
    const definition = getHeliosModuleDefinition(code)
    return {
      kind: 'branch',
      navKey: `module.${code}`,
      label: definition.label,
      to: buildHeliosModulePath(code),
      // Module branches stay highlighted while the operator is on any
      // descendant page (e.g. /catalog/groups/42 keeps Catalog active).
      end: false,
      defaultOpen: false,
      children: subtreeFor(code),
    }
  }

  return [
    {
      kind: 'leaf',
      navKey: 'dashboard',
      label: 'Dashboard',
      to: '/dashboard',
    },
    moduleBranch('communications'),
    moduleBranch('catalog'),
    moduleBranch('screens'),
    moduleBranch('scheduling'),
    moduleBranch('reviews'),
    moduleBranch('utilities'),
    { kind: 'leaf', navKey: 'operations.jobs', label: 'Jobs', to: '/jobs', end: false },
    { kind: 'leaf', navKey: 'operations.history', label: 'Audit history', to: '/history', end: false },
    { kind: 'leaf', navKey: 'operations.metrics', label: 'Metrics', to: '/metrics', end: false },
    {
      kind: 'branch',
      navKey: 'tasks',
      label: 'Tasks',
      to: '/tasks',
      end: false,
      defaultOpen: false,
      children: TASKS_SIDEBAR_SUBTREE,
    },
    moduleBranch('config'),
    // Customers branch — collapsed by default. TreeNav auto-expands
    // the ancestor chain to whatever leaf the operator is on, so
    // visiting any /admin/customers/* page opens this branch
    // automatically without leaving every other branch flapping
    // open.
    //
    // FreshlyBakedNYC/automation#33 (Customers UX epic):
    //   - C1 Check-ins  → /admin/customers/check-ins (alias of the
    //                     ingestion epic's /admin/visitors/scans;
    //                     both URLs remain valid).
    //   - C4 Map        → /admin/customers/map.
    //   - CRM / Segments stay on the existing module URL until the
    //     C3 IA-relocation slice lands.
    {
      kind: 'branch',
      navKey: 'customers',
      label: 'Customers',
      defaultOpen: false,
      end: false,
      children: [
        {
          kind: 'leaf',
          navKey: 'admin.customers.checkins',
          label: 'Check-ins',
          to: '/admin/customers/check-ins',
        },
        {
          kind: 'leaf',
          navKey: 'admin.customers.map',
          label: 'Origin Map',
          to: '/admin/customers/map',
        },
        {
          kind: 'leaf',
          navKey: 'module.crm',
          label: 'CRM & Segments',
          to: buildHeliosModulePath('crm'),
        },
      ],
    },
  ]
}

function PrimarySidebar() {
  const { subtreesByModule } = useSidebarNav()
  const location = useLocation()
  const nodes = useMemo(() => buildPrimarySidebarNodes(subtreesByModule), [subtreesByModule])
  return (
    <nav className="sidebar" aria-label="Primary navigation">
      <TreeNav storageKey={SIDEBAR_TREE_STORAGE_KEY} nodes={nodes} activeTargetId={location.pathname} />
    </nav>
  )
}

function AppShellInner() {
  const session = useLoaderData() as SessionEnvelope
  const navigate = useNavigate()
  const location = useLocation()
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState<boolean>(() => {
    if (typeof window === 'undefined') {
      return false
    }
    // On mobile, default to *collapsed* regardless of the desktop
    // preference — otherwise an operator who set the sidebar to
    // expanded on desktop lands on their phone and sees a giant
    // nav drawer hiding the content. They can still tap "Show
    // nav" to re-open it; we just don't impose the desktop default.
    const stored = window.localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY)
    if (window.matchMedia(MOBILE_BREAKPOINT_QUERY).matches) {
      return true
    }
    return stored === 'true'
  })
  const runtimeWarnings = session.runtimeDependencies.filter((dependency) => dependency.status !== 'configured')

  useEffect(() => {
    window.localStorage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, isSidebarCollapsed ? 'true' : 'false')
  }, [isSidebarCollapsed])

  // On mobile, hide the sidebar whenever the user navigates (e.g. taps a
  // link inside the sidebar). On desktop, the sidebar stays put. Without
  // this, tapping a sidebar item on a phone navigates "past" the nav with
  // no obvious way to get back to it.
  const prevLocationKeyRef = useRef(`${location.pathname}${location.search}`)
  useEffect(() => {
    const key = `${location.pathname}${location.search}`
    if (key === prevLocationKeyRef.current) {
      return
    }
    prevLocationKeyRef.current = key
    if (typeof window === 'undefined') {
      return
    }
    const isMobile = window.matchMedia(MOBILE_BREAKPOINT_QUERY).matches
    if (isMobile) {
      setIsSidebarCollapsed(true)
    }
  }, [location.pathname, location.search])

  const toggleSidebar = useCallback(() => {
    setIsSidebarCollapsed((current) => !current)
  }, [])

  // Escape toggles the sidebar collapse, but only when no modal is visible.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Escape' || event.defaultPrevented) {
        return
      }
      if (isAnyModalOpen()) {
        return
      }
      event.preventDefault()
      toggleSidebar()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [toggleSidebar])

  async function handleLogout() {
    await fetch(buildAppPath('/api/session/logout'), {
      credentials: 'same-origin',
      method: 'POST',
    })
    await navigate('/login')
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">Freshly Baked NYC</p>
          <h1>Helios</h1>
        </div>
        <div className="topbar-meta">
          <button
            className="ghost-button"
            onClick={toggleSidebar}
            type="button"
            title="Toggle nav (Esc)"
          >
            {isSidebarCollapsed ? 'Show nav' : 'Hide nav'}
          </button>
          {session.user ? (
            <>
              <div className="user-chip">
                <span>{session.user.name}</span>
                <strong>{session.user.role}</strong>
              </div>
              <button className="ghost-button" onClick={() => void handleLogout()} type="button">
                Sign out
              </button>
            </>
          ) : null}
        </div>
      </header>
      {runtimeWarnings.length > 0 ? (
        <section className="runtime-status-strip">
          {runtimeWarnings.map((dependency) => (
            <div className="runtime-status-item" key={dependency.code}>
              <Pill tone={dependency.status === 'optional_missing' ? 'warning' : 'danger'}>{dependency.label}</Pill>
              <span className="subtle-copy">{dependency.summary}</span>
            </div>
          ))}
        </section>
      ) : null}
      <div className={`layout-grid${isSidebarCollapsed ? ' sidebar-collapsed' : ''}`}>
        {isSidebarCollapsed ? null : <PrimarySidebar />}
        <main className="content-panel">
          <Outlet />
        </main>
      </div>
      {isSidebarCollapsed ? (
        <button
          type="button"
          className="sidebar-reopen-chip"
          onClick={toggleSidebar}
          title="Show nav (Esc)"
          aria-label="Show nav"
        >
          ☰ Nav
        </button>
      ) : null}
    </div>
  )
}

export function AppShell() {
  return (
    <SidebarNavProvider>
      <AppShellInner />
    </SidebarNavProvider>
  )
}
