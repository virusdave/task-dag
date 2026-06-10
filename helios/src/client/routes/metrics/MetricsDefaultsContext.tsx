import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { useRouteLoaderData } from 'react-router-dom'

import {
  MetricsDefaultsGetResponseSchema,
  type MetricsViewDefaults,
  type SessionEnvelope,
} from '../../../shared/contracts/index.js'
import { loadJson, mutateJson } from '../../app/fetchJson.js'

import type { PageScatterEncoding } from './CatalogAnalyticsTab.js'

// ---------------------------------------------------------------------------
// Shared provider for the GLOBAL page-wide /metrics view defaults.
//
// Both the main metrics layout (line-chart tabs + the catalog scatter tab)
// and the standalone brand / distributor detail pages mount this provider
// so that:
//   * every page hydrates its toolbar state from the same persisted blob,
//   * the admin "Update defaults" / "Reset defaults" flow can read the
//     current scatter encodings even when the button lives on a different
//     component than the scatter state, and
//   * a save / reset immediately updates the in-memory `stored` blob so the
//     diff modal compares against the freshly-saved baseline.
//
// `stored` is the raw persisted blob (null = no override; fall back to code
// defaults). Hosts pass the loader/fetched value as `initialStored` so the
// blob is available on first render (no hydrate race).
// ---------------------------------------------------------------------------

/** Snapshot of the live scatter encodings, registered by CatalogAnalyticsTab. */
export type ScatterSnapshot = PageScatterEncoding

export interface MetricsDefaultsContextValue {
  /** Raw persisted blob, or null when no global override is stored. */
  readonly stored: MetricsViewDefaults | null
  readonly updatedBy: string | null
  readonly updatedAt: string | null
  readonly isAdmin: boolean
  /** Persist the full blob (admin). Throws on failure. */
  saveDefaults: (next: MetricsViewDefaults) => Promise<void>
  /** Drop the global override → fall back to code defaults (admin). */
  resetDefaults: () => Promise<void>
  /** CatalogAnalyticsTab publishes its current encodings here. */
  registerScatterSnapshot: (snap: ScatterSnapshot | null) => void
  /** Read the most recent scatter snapshot (null if no scatter mounted). */
  getScatterSnapshot: () => ScatterSnapshot | null
}

const MetricsDefaultsContext = createContext<MetricsDefaultsContextValue | null>(null)

export interface MetricsDefaultsProviderProps {
  readonly initialStored: MetricsViewDefaults | null
  readonly initialUpdatedBy?: string | null
  readonly initialUpdatedAt?: string | null
  readonly isAdmin: boolean
  readonly children: ReactNode
}

export function MetricsDefaultsProvider({
  initialStored,
  initialUpdatedBy = null,
  initialUpdatedAt = null,
  isAdmin,
  children,
}: MetricsDefaultsProviderProps) {
  const [stored, setStored] = useState<MetricsViewDefaults | null>(initialStored)
  const [updatedBy, setUpdatedBy] = useState<string | null>(initialUpdatedBy)
  const [updatedAt, setUpdatedAt] = useState<string | null>(initialUpdatedAt)
  const scatterSnapshotRef = useRef<ScatterSnapshot | null>(null)

  const saveDefaults = useCallback(async (next: MetricsViewDefaults) => {
    const resp = await mutateJson('/api/metrics-defaults', MetricsDefaultsGetResponseSchema, {
      method: 'PUT',
      body: JSON.stringify(next),
    })
    setStored(resp.defaults)
    setUpdatedBy(resp.updatedBy)
    setUpdatedAt(resp.updatedAt)
  }, [])

  const resetDefaults = useCallback(async () => {
    await mutateJson('/api/metrics-defaults', MetricsDefaultsGetResponseSchema.nullable(), {
      method: 'DELETE',
    })
    setStored(null)
    setUpdatedBy(null)
    setUpdatedAt(null)
  }, [])

  const registerScatterSnapshot = useCallback((snap: ScatterSnapshot | null) => {
    scatterSnapshotRef.current = snap
  }, [])
  const getScatterSnapshot = useCallback(() => scatterSnapshotRef.current, [])

  const value = useMemo<MetricsDefaultsContextValue>(
    () => ({
      stored,
      updatedBy,
      updatedAt,
      isAdmin,
      saveDefaults,
      resetDefaults,
      registerScatterSnapshot,
      getScatterSnapshot,
    }),
    [
      stored,
      updatedBy,
      updatedAt,
      isAdmin,
      saveDefaults,
      resetDefaults,
      registerScatterSnapshot,
      getScatterSnapshot,
    ],
  )
  return (
    <MetricsDefaultsContext.Provider value={value}>{children}</MetricsDefaultsContext.Provider>
  )
}

/** Read the metrics-defaults context. Returns null when no provider is mounted. */
export function useMetricsDefaults(): MetricsDefaultsContextValue | null {
  return useContext(MetricsDefaultsContext)
}

/**
 * Self-fetching provider boundary for metrics pages that DON'T have a
 * route loader supplying the defaults (the brand / distributor detail
 * pages). Fetches the persisted defaults once on mount and resolves the
 * admin flag from the root session, then mounts MetricsDefaultsProvider.
 *
 * While the (fast, tolerant) fetch is in flight we render children
 * WITHOUT a provider: embedded scatters fall back to code defaults and
 * the admin controls hide — both fine for the brief loading window,
 * especially since the detail-page scatters are lazy-mounted behind
 * collapsed accordions.
 */
export function MetricsDefaultsBoundary({ children }: { children: ReactNode }) {
  const session = useRouteLoaderData('root') as SessionEnvelope | undefined
  const isAdmin = session?.user?.role === 'admin'
  const [loaded, setLoaded] = useState<{
    defaults: MetricsViewDefaults | null
    updatedBy: string | null
    updatedAt: string | null
  } | null>(null)
  useEffect(() => {
    let cancelled = false
    loadMetricsDefaults().then((r) => {
      if (!cancelled) setLoaded(r)
    })
    return () => {
      cancelled = true
    }
  }, [])
  if (!loaded) return <>{children}</>
  return (
    <MetricsDefaultsProvider
      initialStored={loaded.defaults}
      initialUpdatedBy={loaded.updatedBy}
      initialUpdatedAt={loaded.updatedAt}
      isAdmin={isAdmin}
    >
      {children}
    </MetricsDefaultsProvider>
  )
}

/**
 * Fetch the persisted defaults. Tolerates the migration-missing 503 (and
 * any transient failure) by returning an empty result so the metrics page
 * still renders on code defaults.
 */
export async function loadMetricsDefaults(): Promise<{
  defaults: MetricsViewDefaults | null
  updatedBy: string | null
  updatedAt: string | null
}> {
  try {
    const resp = await loadJson('/api/metrics-defaults', MetricsDefaultsGetResponseSchema)
    return { defaults: resp.defaults, updatedBy: resp.updatedBy, updatedAt: resp.updatedAt }
  } catch {
    return { defaults: null, updatedBy: null, updatedAt: null }
  }
}
