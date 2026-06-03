import { useCallback, useEffect, useState } from 'react'
import { useLocation } from 'react-router-dom'

import {
  MetricSelectionSchema,
  type MetricSelection,
} from '../../../shared/contracts/index.js'

// ---------------------------------------------------------------------------
// Shared drill-selection hook (v1.4 V4'4).
//
// Click a histogram bucket / scatter dot, copy the URL, get the same
// drilled state back. The selection is JSON-encoded into the
// `?selection=…` query param so:
//
//   * share-link parity holds (`window.history.replaceState` keeps the
//     back-button behaviour sane — every drill is in-place navigation,
//     not a new history entry, so users can keep tabbing without
//     bloating their back stack);
//   * the server route (`/api/metrics/<id>`) accepts the same JSON
//     payload (validated by `MetricSelectionSchema` server-side);
//   * any helios tab that wants to surface a drill UI uses this hook
//     instead of reinventing URL plumbing.
//
// Escape-to-clear is intentionally NOT wired here — it belongs at the
// tab level so a focused input (search box, etc.) can pre-empt the
// Escape handler.
//
// Cross-instance sync (June 2026):
//   - React Router navigations (Link clicks, history.pushState) do NOT
//     fire `popstate`, so the original hook silently kept stale state
//     after the operator clicked a brand-detail link.
//   - When one chart card calls `setSelection`, we replaceState — but
//     other mounted chart cards using the same hook never noticed the
//     URL change. They kept rendering selection rings against the OLD
//     dotId until they themselves were unmounted.
//   - Both gaps are now closed: we re-read on every `useLocation()`
//     change AND on a custom `metric-selection-change` window event
//     dispatched by `updateUrl`.
// ---------------------------------------------------------------------------

const METRIC_SELECTION_CHANGE_EVENT = 'metric-selection-change'

function readFromUrl(): MetricSelection | null {
  if (typeof window === 'undefined') return null
  const raw = new URLSearchParams(window.location.search).get('selection')
  if (raw == null || raw === '') return null
  try {
    const parsed = MetricSelectionSchema.safeParse(JSON.parse(raw))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

export function useMetricSelection(): [
  MetricSelection | null,
  (next: MetricSelection | null) => void,
] {
  // useLocation gives us a re-render on every router navigation —
  // crucial so brand→brand navigations re-read `?selection=` rather
  // than serving the snapshot we cached at first mount.
  const location = useLocation()
  const [selection, setSelection] = useState<MetricSelection | null>(() => readFromUrl())

  // Resync whenever React Router reports a path/search/hash change.
  useEffect(() => {
    setSelection(readFromUrl())
    // location.key changes for every navigation including replace; we
    // depend on it explicitly so even replaceState-only updates from a
    // sibling card re-trigger the read.
  }, [location.pathname, location.search, location.hash, location.key])

  // Browser back/forward AND sibling-card replaceState writes.
  useEffect(() => {
    if (typeof window === 'undefined') return
    const onChange = (): void => setSelection(readFromUrl())
    window.addEventListener('popstate', onChange)
    window.addEventListener(METRIC_SELECTION_CHANGE_EVENT, onChange)
    return () => {
      window.removeEventListener('popstate', onChange)
      window.removeEventListener(METRIC_SELECTION_CHANGE_EVENT, onChange)
    }
  }, [])

  const updateUrl = useCallback((next: MetricSelection | null) => {
    setSelection(next)
    if (typeof window === 'undefined') return
    const params = new URLSearchParams(window.location.search)
    if (next == null) params.delete('selection')
    else params.set('selection', JSON.stringify(next))
    const search = params.toString()
    const newUrl = `${window.location.pathname}${search ? `?${search}` : ''}${window.location.hash}`
    window.history.replaceState(null, '', newUrl)
    // Notify every other mounted instance of this hook so they
    // re-read from the URL and update their local selection state.
    window.dispatchEvent(new Event(METRIC_SELECTION_CHANGE_EVENT))
  }, [])

  return [selection, updateUrl]
}
