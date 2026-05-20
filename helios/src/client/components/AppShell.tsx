import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Outlet, useLoaderData, useLocation, useNavigate } from 'react-router-dom'

import {
  HELIOS_MODULES,
  buildHeliosModulePath,
  type HeliosModuleCode,
  type SessionEnvelope,
} from '../../shared/contracts/index.js'
import { buildAppPath } from '../app/paths.js'
import { Pill } from './Pill.js'
import { SidebarNavProvider, useSidebarNav } from './SidebarNavContext.js'
import { TreeNav, type TreeNavNode } from './TreeNav.js'

const SIDEBAR_COLLAPSED_STORAGE_KEY = 'helios.sidebar.collapsed'
const SIDEBAR_TREE_STORAGE_KEY = 'helios.sidebar.tree'
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

function buildPrimarySidebarNodes(
  subtreesByModule: Partial<Record<HeliosModuleCode, TreeNavNode[]>>,
): TreeNavNode[] {
  // Windows-Explorer-style: one root, expanded by default; every immediate
  // child collapsed. Branch labels themselves are the navigation targets,
  // so there are no separate "Overview" pseudo-leaves.
  //
  // Config is intentionally rendered last (bottom of the nav pane), below
  // the operational leaves (Jobs, Audit history), because it owns
  // meta-settings like recurring background-worker schedules rather than a
  // workflow surface.
  // `pricing` is intentionally NOT rendered as a top-level branch — its
  // routes are reached through the Catalog branch's subtree
  // (catalogSidebarSubtree.ts). `config` is rendered separately below
  // the operational leaves.
  const moduleBranches: TreeNavNode[] = HELIOS_MODULES.filter(
    (module) => module.code !== 'config' && module.code !== 'pricing',
  ).map((module) => ({
    kind: 'branch',
    navKey: `module.${module.code}`,
    label: module.label,
    to: buildHeliosModulePath(module.code),
    children: subtreesByModule[module.code] ?? [],
  }))

  const configModule = HELIOS_MODULES.find((module) => module.code === 'config')
  const configBranch: TreeNavNode | null = configModule
    ? {
        kind: 'branch',
        navKey: `module.${configModule.code}`,
        label: configModule.label,
        to: buildHeliosModulePath(configModule.code),
        children: subtreesByModule[configModule.code] ?? [],
      }
    : null

  return [
    {
      kind: 'branch',
      navKey: 'helios',
      label: 'Helios',
      to: '/',
      // Only the single root is expanded by default; everything below
      // starts collapsed (+) until the user expands it.
      defaultOpen: true,
      children: [
        ...moduleBranches,
        { kind: 'leaf', navKey: 'operations.jobs', label: 'Jobs', to: '/jobs' },
        { kind: 'leaf', navKey: 'operations.history', label: 'Audit history', to: '/history' },
        ...(configBranch ? [configBranch] : []),
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
    return window.localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY) === 'true'
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
