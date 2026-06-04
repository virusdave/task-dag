import { useEffect } from 'react'
import { useLocation } from 'react-router-dom'

import { HELIOS_MODULES } from '../../shared/contracts/index.js'
import { getAppBasePath } from './paths.js'

const BRAND_SUFFIX = 'Helios'

/**
 * Friendly tab-title labels for top-level path segments that are NOT
 * Helios modules (modules drive their label from
 * `HELIOS_MODULES[*].label`). Keep this list short and reflective of
 * the operator-facing sections that show up in the sidebar / router.
 */
const NON_MODULE_SECTION_LABELS: Readonly<Record<string, string>> = {
  dashboard: 'Dashboard',
  jobs: 'Jobs',
  history: 'History',
  tasks: 'Tasks',
  metrics: 'Metrics',
  modules: 'Modules',
  login: 'Sign in',
  // Legacy alias for `communications` — kept so the legacy /ads URL
  // still produces a sensible tab title during the redirect.
  ads: 'Ads',
}

/**
 * Sub-section labels for routes namespaced under `/admin/<group>/...`.
 * Helios groups its customer / visitor surfaces under `admin/*` rather
 * than a top-level module, so the section label has to come from the
 * second path segment.
 */
const ADMIN_GROUP_LABELS: Readonly<Record<string, string>> = {
  customers: 'Customers',
  visitors: 'Check-ins',
}

function stripBasePath(pathname: string): string {
  const base = getAppBasePath()
  if (base === '/' || !pathname.startsWith(base)) {
    return pathname
  }
  const stripped = pathname.slice(base.length)
  return stripped.startsWith('/') ? stripped : `/${stripped}`
}

function capitalize(segment: string): string {
  if (!segment) {
    return segment
  }
  return segment.charAt(0).toUpperCase() + segment.slice(1)
}

/**
 * Resolves a human-readable section label for a router pathname. The
 * label is derived from the first (or, for `/admin/<group>/...`,
 * the second) path segment so that operators with 20 Helios tabs open
 * can tell which section each tab is on without focusing it. Returns
 * `null` if the path is the app root, so the caller falls back to the
 * bare brand title.
 */
export function resolveSectionLabel(pathname: string): string | null {
  const appRelative = stripBasePath(pathname)
  const segments = appRelative.split('/').filter((segment) => segment.length > 0)
  if (segments.length === 0) {
    return NON_MODULE_SECTION_LABELS.dashboard ?? null
  }

  const [first, second] = segments
  if (first === 'admin' && second) {
    return ADMIN_GROUP_LABELS[second] ?? capitalize(second)
  }

  const moduleLabel = HELIOS_MODULES.find((definition) => definition.routePrefix === first)?.label
  if (moduleLabel) {
    return moduleLabel
  }

  return NON_MODULE_SECTION_LABELS[first] ?? capitalize(first)
}

export function buildPageTitle(pathname: string): string {
  const section = resolveSectionLabel(pathname)
  return section ? `${section} - ${BRAND_SUFFIX}` : BRAND_SUFFIX
}

/**
 * Keeps `document.title` in sync with the current route so a bank of
 * Helios tabs is actually navigable from the browser tab strip. Format
 * is `<Section> - Helios` (e.g. `CRM & Segments - Helios`,
 * `Metrics - Helios`, `Check-ins - Helios`). Falls back to the bare
 * brand on routes that can't be resolved.
 */
export function usePageTitle(): void {
  const { pathname } = useLocation()
  useEffect(() => {
    if (typeof document === 'undefined') {
      return
    }
    document.title = buildPageTitle(pathname)
  }, [pathname])
}
