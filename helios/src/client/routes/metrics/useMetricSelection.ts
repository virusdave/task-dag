import { useCallback, useEffect, useState } from 'react'

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
// ---------------------------------------------------------------------------

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
  const [selection, setSelection] = useState<MetricSelection | null>(() => readFromUrl())

  useEffect(() => {
    if (typeof window === 'undefined') return
    const onPopState = (): void => setSelection(readFromUrl())
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
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
  }, [])

  return [selection, updateUrl]
}
