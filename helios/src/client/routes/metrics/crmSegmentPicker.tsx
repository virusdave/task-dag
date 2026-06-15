import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'

import {
  CrmSegmentListResponseSchema,
  type CrmSegmentListItem,
} from '../../../shared/contracts/index.js'
import { loadJson } from '../../app/fetchJson.js'

// Shared segment picker for the CRM Segments + CRM Segment Analysis tabs.
// Loads the cache-only segment list once, defaults to the largest segment
// with cached members, and groups options by scope for a legible native
// <select> (mobile-friendly; dozens of segments stay scannable).

function fmtInt(n: number): string {
  return n.toLocaleString('en-US', { maximumFractionDigits: 0 })
}

export interface CrmSegmentPickerState {
  readonly segments: ReadonlyArray<CrmSegmentListItem>
  readonly segmentsError: string | null
  readonly selectedSegmentId: number | null
  readonly setSelectedSegmentId: (id: number | null) => void
  readonly selectedSegment: CrmSegmentListItem | null
}

export function useCrmSegmentPicker(): CrmSegmentPickerState {
  const [searchParams] = useSearchParams()
  // Honour a `?segmentId=` deep-link (e.g. the "Compare vs others" CTA) as
  // the initial selection; fall back to the largest cached segment.
  const initialFromUrl = (() => {
    const raw = searchParams.get('segmentId')
    const n = raw ? Number(raw) : NaN
    return Number.isInteger(n) && n > 0 ? n : null
  })()

  const [segments, setSegments] = useState<ReadonlyArray<CrmSegmentListItem>>([])
  const [segmentsError, setSegmentsError] = useState<string | null>(null)
  const [selectedSegmentId, setSelectedSegmentId] = useState<number | null>(initialFromUrl)

  useEffect(() => {
    let cancelled = false
    loadJson('/api/crm/segments', CrmSegmentListResponseSchema)
      .then((r) => {
        if (cancelled) return
        setSegments(r.segments)
        const firstWithMembers = r.segments.find((s) => s.cachedMemberCount > 0) ?? r.segments[0]
        if (firstWithMembers) setSelectedSegmentId((cur) => cur ?? firstWithMembers.segmentId)
      })
      .catch((e: unknown) => {
        if (!cancelled) setSegmentsError(e instanceof Error ? e.message : String(e))
      })
    return () => {
      cancelled = true
    }
  }, [])

  const selectedSegment = useMemo(
    () => segments.find((s) => s.segmentId === selectedSegmentId) ?? null,
    [segments, selectedSegmentId],
  )

  return { segments, segmentsError, selectedSegmentId, setSelectedSegmentId, selectedSegment }
}

export function CrmSegmentPicker({
  segments,
  selectedSegmentId,
  setSelectedSegmentId,
}: Pick<CrmSegmentPickerState, 'segments' | 'selectedSegmentId' | 'setSelectedSegmentId'>) {
  const segmentGroups = useMemo(() => {
    const order: ReadonlyArray<{ key: string; label: string }> = [
      { key: 'state', label: 'All-store / state' },
      { key: 'site', label: 'Site' },
      { key: 'unknown', label: 'Other' },
    ]
    return order
      .map((g) => ({ ...g, items: segments.filter((s) => s.scopeLevel === g.key) }))
      .filter((g) => g.items.length > 0)
  }, [segments])

  return (
    <div className="metrics-control-group">
      <span className="subtle-copy">segment</span>
      <select
        className="crm-seg-picker"
        value={selectedSegmentId ?? ''}
        onChange={(e) => setSelectedSegmentId(e.target.value ? Number(e.target.value) : null)}
      >
        {selectedSegmentId === null ? <option value="">Select a segment…</option> : null}
        {segmentGroups.map((g) => (
          <optgroup key={g.key} label={g.label}>
            {g.items.map((s) => (
              <option key={s.segmentId} value={s.segmentId}>
                {s.name} · {fmtInt(s.cachedMemberCount)} members
                {s.enabled === false ? ' · disabled' : ''}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
    </div>
  )
}
