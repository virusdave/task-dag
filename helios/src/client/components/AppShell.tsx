import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Outlet, useLoaderData, useLocation, useNavigate, useRouteLoaderData } from 'react-router-dom'

import {
  buildHeliosModulePath,
  type HeliosModuleCode,
  type MetricGrantKey,
  type SessionEnvelope,
} from '../../shared/contracts/index.js'
import { userHasMetricGrant } from '../../shared/domain/metricGrants.js'
import { buildAppPath } from '../app/paths.js'
import { usePageTitle } from '../app/usePageTitle.js'
import { buildCatalogSidebarSubtree } from '../routes/catalog/catalogSidebarSubtree.js'
import { buildCommunicationsSidebarSubtree } from '../routes/communications/communicationsSidebar.js'
import { buildConfigSidebarSubtree } from '../routes/config/configSidebarSubtree.js'
import { REVIEWS_SIDEBAR_SUBTREE } from '../routes/customerReviews/customerReviewsSidebar.js'
import { SCHEDULING_SIDEBAR_SUBTREE } from '../routes/scheduling/schedulingSidebar.js'
import { SCREENS_SIDEBAR_SUBTREE } from '../routes/screens/screensSidebar.js'
import { TASKS_SIDEBAR_SUBTREE } from '../routes/tasks/tasksSidebar.js'
import { Pill } from './Pill.js'
import { SidebarNavProvider, useSidebarNav } from './SidebarNavContext.js'
import { TreeNav, type TreeNavNode } from './TreeNav.js'

const SIDEBAR_COLLAPSED_STORAGE_KEY = 'helios.sidebar.collapsed'
// Bumped to .v4 for the 7-category nav redesign (virusdave/top-level#14):
// the top-level IA changed shape entirely (Operations / Catalog & Inventory
// / Marketing & Competitors / Customers & Feedback / Reports & Audit /
// Admin & Config / Trash), so existing operators must not inherit stale
// expanded/collapsed branch state keyed by the old node navKeys.
const SIDEBAR_TREE_STORAGE_KEY = 'helios.sidebar.tree.v4'
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
 * HELIOS_MODULES and has no real subroutes yet. Post-redesign
 * (virusdave/top-level#14) it is quarantined under the Trash category as
 * a single leaf (/trash/crm), not rendered as a module branch.
 *
 * `pricing` is intentionally absent: its routes are surfaced under the
 * Catalog branch's Pricing sub-branch (see catalogSidebarSubtree.ts),
 * not as a top-level module.
 *
 * `utilities` is intentionally absent: the vague "Utilities" bucket was
 * dissolved in the redesign — Staff now lives under Admin & Config →
 * People and Promo Names under Marketing & Competitors. The legacy
 * `useRegisterSidebarSubtree('utilities', …)` calls on those pages are
 * harmless no-ops (there is no top-level utilities branch to fill).
 */
const STATIC_MODULE_SUBTREES: Partial<Record<HeliosModuleCode, TreeNavNode[]>> = {
  communications: buildCommunicationsSidebarSubtree(),
  catalog: buildCatalogSidebarSubtree(),
  screens: SCREENS_SIDEBAR_SUBTREE,
  scheduling: SCHEDULING_SIDEBAR_SUBTREE,
  reviews: REVIEWS_SIDEBAR_SUBTREE,
  config: buildConfigSidebarSubtree(),
}

/**
 * Explicit primary-sidebar IA — 7 consistent top-level *category*
 * branches (Helios nav-bar redesign, virusdave/top-level#14). The
 * authoritative design lives in
 * virusdave/top-level:docs/epics/helios-nav-bar/EPIC_PLAN.md.
 *
 * We deliberately do NOT derive this from `HELIOS_MODULES` order — that
 * array is domain metadata and can't represent the cross-cutting
 * surfaces (Tasks, Jobs, Audit history, Metrics) nor the workflow-first
 * ordering. Every top-level entry is now a category *branch* (no mix of
 * one-off leaves and deep module branches), ordered:
 *
 *   1. Operations            — what's running / needs attention now:
 *                              Tasks, Jobs, Scheduling, Screens.
 *   2. Catalog & Inventory   — core product / stock / pricing / maintenance.
 *   3. Marketing & Competitors — Ads (Drive ingest, clusters, competitor
 *                              price comparison) + Promo Names.
 *   4. Customers & Feedback  — customer admin (check-ins, origin map) +
 *                              review submissions.
 *   5. Reports & Audit       — read-only: Metrics, Audit history.
 *   6. Admin & Config        — People, Workers, Parsing, Integrations.
 *   7. Trash                 — quarantine for low-value / placeholder
 *                              pages (Dashboard, planned CRM).
 *
 * Existing per-module subtrees are composed into these groups via
 * `subtreeFor(code)` so page-supplied dynamic overrides keep working and
 * no route is re-authored. Each route appears in exactly ONE canonical
 * place; the legacy URLs that no longer have a nav entry (e.g.
 * /dashboard, /crm) are handled as router redirects (see router.tsx),
 * never duplicate nav pointers.
 */
function buildPrimarySidebarNodes(
  subtreesByModule: Partial<Record<HeliosModuleCode, TreeNavNode[]>>,
  session: SessionEnvelope | null | undefined,
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

  // Metrics children are filtered by per-user grant. Admins implicitly
  // hold every grant (handled inside userHasMetricGrant). When a
  // non-admin user has zero grants the Metrics branch is omitted from
  // Reports & Audit (the category itself still shows Audit history).
  //
  // Sub-routes (each gated independently by MetricGrantKey):
  //   * Explore      → /metrics              (existing dashboard, all tabs)
  //   * Brands       → /metrics/brands       (index → per-brand drill-down)
  //   * Distributors → /metrics/distributors (index → per-distributor drill-down)
  //   * Staff        → /metrics/staff        (alias for the budtenders tab)
  //   * Reordering   → /metrics/reordering   (alias for the inventory tab)
  const metricsChildren: TreeNavNode[] = []
  type MetricsLeaf = { key: MetricGrantKey; navKey: string; label: string; to: string }
  const metricsLeaves: ReadonlyArray<MetricsLeaf> = [
    { key: 'explore', navKey: 'reports.metrics.explore', label: 'Explore', to: '/metrics' },
    { key: 'brands', navKey: 'reports.metrics.brands', label: 'Brands', to: '/metrics/brands' },
    { key: 'distributors', navKey: 'reports.metrics.distributors', label: 'Distributors', to: '/metrics/distributors' },
    { key: 'staff', navKey: 'reports.metrics.staff', label: 'Staff', to: '/metrics/staff' },
    { key: 'reordering', navKey: 'reports.metrics.reordering', label: 'Reordering', to: '/metrics/reordering' },
  ]
  for (const leaf of metricsLeaves) {
    if (userHasMetricGrant(session?.user, leaf.key)) {
      metricsChildren.push({ kind: 'leaf', navKey: leaf.navKey, label: leaf.label, to: leaf.to })
    }
  }

  // ---- 1. Operations ----
  const operations: TreeNavNode = {
    kind: 'branch',
    navKey: 'ops',
    label: 'Operations',
    to: '/tasks/frontier',
    end: false,
    defaultOpen: false,
    children: [
      {
        kind: 'branch',
        navKey: 'ops.tasks',
        label: 'Tasks',
        to: '/tasks',
        end: false,
        defaultOpen: false,
        children: TASKS_SIDEBAR_SUBTREE,
      },
      { kind: 'leaf', navKey: 'ops.jobs', label: 'Jobs', to: '/jobs', end: false },
      {
        kind: 'branch',
        navKey: 'ops.scheduling',
        label: 'Scheduling',
        to: buildHeliosModulePath('scheduling'),
        end: false,
        defaultOpen: false,
        children: subtreeFor('scheduling'),
      },
      {
        kind: 'branch',
        navKey: 'ops.screens',
        label: 'Screens',
        to: buildHeliosModulePath('screens'),
        end: false,
        defaultOpen: false,
        children: subtreeFor('screens'),
      },
    ],
  }

  // ---- 2. Catalog & Inventory ----
  const catalogInventory: TreeNavNode = {
    kind: 'branch',
    navKey: 'catalog-inventory',
    label: 'Catalog & Inventory',
    to: buildHeliosModulePath('catalog', 'browser'),
    end: false,
    defaultOpen: false,
    children: subtreeFor('catalog'),
  }

  // ---- 3. Marketing & Competitors ----
  const marketing: TreeNavNode = {
    kind: 'branch',
    navKey: 'marketing',
    label: 'Marketing & Competitors',
    to: '/communications/drive-ingest',
    end: false,
    defaultOpen: false,
    children: [
      ...subtreeFor('communications'),
      {
        // Promo Names moved out of the dissolved Utilities bucket — it's
        // a marketing-copy workflow. Route /utilities/promo-names is
        // unchanged.
        kind: 'leaf',
        navKey: 'marketing.promo-names',
        label: 'Promo Names',
        to: '/utilities/promo-names',
      },
      {
        // SEO control plane (Helios-driven SEO widgets epic, top-level#15).
        // P3 ships the FAQ generator/editor/approval surface.
        kind: 'leaf',
        navKey: 'marketing.seo-faq',
        label: 'SEO · FAQ sets',
        to: '/seo/faq',
        end: false,
      },
    ],
  }

  // ---- 4. Customers & Feedback ----
  // C1 Check-ins → /admin/customers/check-ins (alias of the ingestion
  // epic's /admin/visitors/scans; both URLs remain valid). C4 Map →
  // /admin/customers/map. Review submissions live here too.
  const customers: TreeNavNode = {
    kind: 'branch',
    navKey: 'customers',
    label: 'Customers & Feedback',
    to: '/admin/customers/check-ins',
    end: false,
    defaultOpen: false,
    children: [
      {
        kind: 'leaf',
        navKey: 'customers.checkins',
        label: 'Check-ins',
        to: '/admin/customers/check-ins',
      },
      {
        kind: 'leaf',
        navKey: 'customers.map',
        label: 'Origin Map',
        to: '/admin/customers/map',
      },
      {
        kind: 'branch',
        navKey: 'customers.reviews',
        label: 'Reviews',
        to: '/reviews',
        end: false,
        defaultOpen: false,
        children: subtreeFor('reviews'),
      },
    ],
  }

  // ---- 5. Reports & Audit ----
  const reportsChildren: TreeNavNode[] = []
  if (metricsChildren.length > 0) {
    reportsChildren.push({
      kind: 'branch',
      navKey: 'reports.metrics',
      label: 'Metrics',
      to: metricsChildren[0]!.to,
      end: false,
      defaultOpen: false,
      children: metricsChildren,
    })
  }
  reportsChildren.push({
    kind: 'leaf',
    navKey: 'reports.history',
    label: 'Audit history',
    to: '/history',
    end: false,
  })
  const reports: TreeNavNode = {
    kind: 'branch',
    navKey: 'reports',
    label: 'Reports & Audit',
    to: '/metrics',
    end: false,
    defaultOpen: false,
    children: reportsChildren,
  }

  // ---- 6. Admin & Config ----
  const adminConfig: TreeNavNode = {
    kind: 'branch',
    navKey: 'admin-config',
    label: 'Admin & Config',
    to: buildHeliosModulePath('config'),
    end: false,
    defaultOpen: false,
    children: subtreeFor('config'),
  }

  // ---- 7. Trash ----
  // Quarantine for low-value / placeholder pages (reversible — the
  // operator can change their mind). /dashboard and /crm redirect here
  // (see router.tsx).
  const trash: TreeNavNode = {
    kind: 'branch',
    navKey: 'trash',
    label: 'Trash',
    to: '/trash/dashboard',
    end: false,
    defaultOpen: false,
    children: [
      {
        kind: 'leaf',
        navKey: 'trash.dashboard',
        label: 'Dashboard',
        to: '/trash/dashboard',
      },
      {
        kind: 'leaf',
        navKey: 'trash.crm',
        label: 'CRM & Segments',
        to: '/trash/crm',
      },
    ],
  }

  return [operations, catalogInventory, marketing, customers, reports, adminConfig, trash]
}

function PrimarySidebar() {
  const { subtreesByModule } = useSidebarNav()
  const location = useLocation()
  // The root route's loader returns the SessionEnvelope; we use it
  // for per-user grant filtering on the Metrics branch. May be
  // undefined while the loader is in flight on the initial render —
  // buildPrimarySidebarNodes handles the null branch.
  const session = useRouteLoaderData('root') as SessionEnvelope | undefined
  const nodes = useMemo(
    () => buildPrimarySidebarNodes(subtreesByModule, session ?? null),
    [subtreesByModule, session],
  )
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
  usePageTitle()
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

  // Mobile-only "Top" pill: shown once the page has been scrolled at
  // least one full viewport down, regardless of whether the nav is
  // currently expanded or collapsed. The threshold uses hysteresis
  // (show ≥1vh, hide <0.5vh) so the chip doesn't flicker on/off when
  // the user is scrolling right around the boundary.
  const [showScrollTopChip, setShowScrollTopChip] = useState<boolean>(false)
  useEffect(() => {
    if (typeof window === 'undefined') {
      return
    }
    let ticking = false
    function evaluate() {
      const vh = window.innerHeight || 1
      const y = window.scrollY
      // Snapshot the current visibility off the DOM rather than off
      // state to avoid stale-closure problems with the rAF callback.
      setShowScrollTopChip((current) => {
        if (current) {
          // Already visible — only hide once scrolled back above the
          // lower hysteresis threshold.
          return y >= vh * 0.5
        }
        // Not yet visible — wait for a full viewport of scroll.
        return y >= vh
      })
      ticking = false
    }
    function onScroll() {
      if (ticking) return
      ticking = true
      window.requestAnimationFrame(evaluate)
    }
    window.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('resize', evaluate)
    // Initial evaluation in case the route already loaded scrolled.
    evaluate()
    return () => {
      window.removeEventListener('scroll', onScroll)
      window.removeEventListener('resize', evaluate)
    }
  }, [])

  const handleScrollToTop = useCallback(() => {
    if (typeof window !== 'undefined') {
      window.scrollTo({ top: 0, behavior: 'smooth' })
    }
    // If the nav is currently hidden, surface it as part of "going
    // back home" so the reviewer doesn't need a second tap to expand
    // the sidebar after returning to the top.
    setIsSidebarCollapsed((current) => (current ? false : current))
  }, [])

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
      {/*
        Mobile-only floating chip. Used to be a 'Show nav' shortcut
        that appeared only when the sidebar was collapsed; it has
        been repurposed as a 'Top' shortcut that appears whenever the
        page has scrolled at least one viewport down, regardless of
        whether the nav is currently expanded. Pressing it scrolls
        smoothly to the top AND expands the nav (so the reviewer
        returning to the page-top from deep in a long list lands on
        a familiar fully-expanded shell).
      */}
      {showScrollTopChip ? (
        <button
          type="button"
          className="scroll-top-chip"
          onClick={handleScrollToTop}
          title="Scroll to top"
          aria-label="Scroll to top"
        >
          ↑ Top
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
