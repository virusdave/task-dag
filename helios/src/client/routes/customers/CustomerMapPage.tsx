// /admin/customers/map — customer-origin map.
//
// FreshlyBakedNYC/automation#33, phase C4.
//
// Renders one MapLibre circle per visitor_scan with a non-null
// document-address coordinate, plus a pin for each retail site.
// The base map is heavily desaturated and faded — it exists to
// provide geographic framing, not road navigation.
//
// Filters:
//   * site (bx / mh / all)
//   * checkedInAfter / checkedInBefore — driven by a dual-handle
//     range slider over a rolling 30-day window. The slider is the
//     primary control and writes directly to URL params (debounced
//     ~200ms) so the map refetches as the operator drags.
//   * maxPoints — cap on the result set; default 2,500.
//
// Default window when the page is loaded with no explicit filter
// state: "yesterday 6am → today 3am" in the operator's local time
// zone (i.e. the prior business overnight). This matches the
// operator's mental model of "today's customers".

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLoaderData, useSearchParams } from 'react-router-dom'

import {
  CustomersMapResponseSchema,
  type CustomersMapResponse,
} from '../../../shared/contracts/index.js'
import { loadJson } from '../../app/fetchJson.js'
import { buildAppPath } from '../../app/paths.js'
import { Pill } from '../../components/Pill.js'

import type maplibregl from 'maplibre-gl'

// ---------------------------------------------------------------------
// Map style
// ---------------------------------------------------------------------

const MAP_STYLE: maplibregl.StyleSpecification = {
  version: 8,
  sources: {
    osm: {
      type: 'raster',
      tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
      tileSize: 256,
      attribution: '&copy; OpenStreetMap contributors',
      maxzoom: 19,
    },
  },
  layers: [
    {
      id: 'osm-tiles',
      type: 'raster',
      source: 'osm',
      paint: {
        // Heavy desaturation + a tinge of opacity so the base map
        // recedes behind the points. The operator scans for
        // geographic framing (boroughs, the rivers), not for street
        // names.
        'raster-opacity': 0.55,
        'raster-saturation': -0.85,
        'raster-contrast': -0.15,
        'raster-brightness-max': 0.95,
      },
    },
  ],
}

const DEFAULT_CENTER: [number, number] = [-73.95, 40.78]
const DEFAULT_ZOOM = 10.5
const DEFAULT_MAX_POINTS = 2500

// ---------------------------------------------------------------------
// Default-window helpers
// ---------------------------------------------------------------------

/** "Yesterday 6am" in the operator's local timezone, as ISO. */
function defaultCheckedInAfter(now: Date = new Date()): string {
  const d = new Date(now)
  d.setDate(d.getDate() - 1)
  d.setHours(6, 0, 0, 0)
  return d.toISOString()
}

/** "Today 3am" in the operator's local timezone, as ISO. */
function defaultCheckedInBefore(now: Date = new Date()): string {
  const d = new Date(now)
  d.setHours(3, 0, 0, 0)
  return d.toISOString()
}

// ---------------------------------------------------------------------
// Slider helpers — operate over a fixed 30-day rolling window ending
// "now". Two slider handles map to checkedInAfter / checkedInBefore.
// ---------------------------------------------------------------------

const SLIDER_WINDOW_MS = 30 * 24 * 60 * 60 * 1000
const SLIDER_STEPS = 720 // 30 days * 24h = 720 — one tick per hour

interface SliderRange {
  /** Start of the rolling window. */
  windowStart: Date
  /** End of the rolling window (= now, fixed at mount). */
  windowEnd: Date
}

function buildSliderRange(): SliderRange {
  // Snap the window edges to the top of the hour so each slider
  // tick maps to a clean wall-clock hour. Without this, dragging the
  // slider produces times like "06:27" that just reflect whatever
  // minute/sec it happened to be when the page mounted, which is
  // exactly the "weird minutes" complaint from the operator.
  const now = new Date()
  const end = new Date(now)
  end.setMinutes(0, 0, 0)
  end.setHours(end.getHours() + 1) // ceil to next top-of-hour
  const start = new Date(end.getTime() - SLIDER_WINDOW_MS)
  return { windowStart: start, windowEnd: end }
}

function clampDateToWindow(iso: string | null, win: SliderRange, fallback: Date): Date {
  if (iso === null) return fallback
  const t = new Date(iso).getTime()
  if (!Number.isFinite(t)) return fallback
  if (t < win.windowStart.getTime()) return win.windowStart
  if (t > win.windowEnd.getTime()) return win.windowEnd
  return new Date(t)
}

function dateToTick(date: Date, win: SliderRange): number {
  const ratio =
    (date.getTime() - win.windowStart.getTime()) /
    (win.windowEnd.getTime() - win.windowStart.getTime())
  return Math.round(Math.max(0, Math.min(1, ratio)) * SLIDER_STEPS)
}

function tickToDate(tick: number, win: SliderRange): Date {
  const ratio = tick / SLIDER_STEPS
  return new Date(
    win.windowStart.getTime() + ratio * (win.windowEnd.getTime() - win.windowStart.getTime()),
  )
}

function formatTime(iso: string | null): string {
  if (iso === null) return '—'
  try {
    return new Date(iso).toLocaleString(undefined, { hour12: false })
  } catch {
    return iso
  }
}

function formatShortRange(after: Date, before: Date): string {
  const sameDay =
    after.toDateString() === before.toDateString()
  if (sameDay) {
    return `${after.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} ` +
      `${after.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false })} – ` +
      `${before.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false })}`
  }
  return `${after.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })} – ` +
    `${before.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })}`
}

/**
 * Convenience preset: returns the canonical "yesterday 6am → today 3am"
 * range anchored to `now`. Uses 0-second/minute precision so it matches
 * `defaultCheckedIn{After,Before}` exactly.
 */
function yesterdayShiftRange(now: Date = new Date()): { after: Date; before: Date } {
  const after = new Date(now)
  after.setDate(after.getDate() - 1)
  after.setHours(6, 0, 0, 0)
  const before = new Date(now)
  before.setHours(3, 0, 0, 0)
  return { after, before }
}

/** True when `a` and `b` are within `tolMs` of each other. */
function nearMs(a: Date, b: Date, tolMs = 60 * 60 * 1000): boolean {
  return Math.abs(a.getTime() - b.getTime()) <= tolMs
}

// ---------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------

export async function customerMapLoader({
  request,
}: {
  request: Request
}): Promise<CustomersMapResponse> {
  const url = new URL(request.url)
  // If the loader is hit with no filter params, apply the default
  // window so the very first paint isn't an empty map.
  if (!url.searchParams.has('checkedInAfter') && !url.searchParams.has('checkedInBefore')) {
    url.searchParams.set('checkedInAfter', defaultCheckedInAfter())
    url.searchParams.set('checkedInBefore', defaultCheckedInBefore())
  }
  if (!url.searchParams.has('maxPoints')) {
    url.searchParams.set('maxPoints', String(DEFAULT_MAX_POINTS))
  }
  return loadJson(`/api/admin/customers/map${url.search}`, CustomersMapResponseSchema)
}

// ---------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------

export function CustomerMapPage(): JSX.Element {
  const initialData = useLoaderData() as CustomersMapResponse
  const [searchParams, setSearchParams] = useSearchParams()

  // First-visit defaulting: if the page mounts without any
  // checkedInAfter/Before, set the canonical window. We let React-
  // Router pick this up and re-fetch via the slider effect below.
  useEffect(() => {
    if (
      !searchParams.has('checkedInAfter') &&
      !searchParams.has('checkedInBefore')
    ) {
      const next = new URLSearchParams(searchParams)
      next.set('checkedInAfter', defaultCheckedInAfter())
      next.set('checkedInBefore', defaultCheckedInBefore())
      if (!next.has('maxPoints')) next.set('maxPoints', String(DEFAULT_MAX_POINTS))
      setSearchParams(next, { replace: true })
    }
    // run once on mount only
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const [data, setData] = useState<CustomersMapResponse>(initialData)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  // Re-fetch on filter change.
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    void (async () => {
      try {
        const next = await loadJson(
          `/api/admin/customers/map?${searchParams.toString()}`,
          CustomersMapResponseSchema,
        )
        if (!cancelled) {
          setData(next)
          setError(null)
        }
      } catch (cause) {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : 'Failed to load map data.')
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [searchParams])

  // -----------------------------------------------------------------
  // Map instance lifecycle.
  // -----------------------------------------------------------------
  const containerRef = useRef<HTMLDivElement | null>(null)
  const mapRef = useRef<maplibregl.Map | null>(null)
  const popupRef = useRef<maplibregl.Popup | null>(null)

  const pointsGeoJson = useMemo(
    () => ({
      type: 'FeatureCollection' as const,
      features: data.points.map((p) => ({
        type: 'Feature' as const,
        geometry: { type: 'Point' as const, coordinates: [p.lng, p.lat] },
        properties: {
          scanId: p.scanId,
          siteSlug: p.siteSlug,
          checkedInAt: p.checkedInAt,
          coordSource: p.coordSource,
          displayName: p.displayName ?? 'Unknown visitor',
          city: p.city ?? '',
          state: p.state ?? '',
          postalCode: p.postalCode ?? '',
          customerUrl: p.customerUrl,
        },
      })),
    }),
    [data.points],
  )

  const sitesGeoJson = useMemo(
    () => ({
      type: 'FeatureCollection' as const,
      features: data.sitePins.map((s) => ({
        type: 'Feature' as const,
        geometry: { type: 'Point' as const, coordinates: [s.lng, s.lat] },
        properties: {
          siteSlug: s.siteSlug,
          label: s.label,
        },
      })),
    }),
    [data.sitePins],
  )

  useEffect(() => {
    const container = containerRef.current
    if (container === null) return
    let alive = true
    let mapInstance: maplibregl.Map | null = null

    void (async () => {
      const maplibre = await import('maplibre-gl')
      await import('maplibre-gl/dist/maplibre-gl.css')
      if (!alive || containerRef.current === null) return
      mapInstance = new maplibre.Map({
        container: containerRef.current,
        style: MAP_STYLE,
        center: DEFAULT_CENTER,
        zoom: DEFAULT_ZOOM,
        dragRotate: false,
        pitchWithRotate: false,
        touchPitch: false,
      })
      mapInstance.addControl(new maplibre.NavigationControl({ showCompass: false }), 'top-right')
      mapInstance.addControl(
        new maplibre.AttributionControl({ compact: true }),
        'bottom-right',
      )
      mapRef.current = mapInstance

      mapInstance.on('load', () => {
        if (!mapInstance) return

        // Store-location pins go in FIRST so they sit at the BOTTOM
        // of the stack — customer pins / clusters / heatmap always
        // render above them. They're also much smaller than before
        // so they don't compete with customer data visually; the
        // text label keeps them identifiable.
        mapInstance.addSource('sites', { type: 'geojson', data: sitesGeoJson })
        mapInstance.addLayer({
          id: 'sites-outer',
          type: 'circle',
          source: 'sites',
          paint: {
            'circle-radius': 5,
            'circle-color': '#ffffff',
            'circle-stroke-color': '#1a0d04',
            'circle-stroke-width': 1.5,
          },
        })
        mapInstance.addLayer({
          id: 'sites-inner',
          type: 'circle',
          source: 'sites',
          paint: {
            'circle-radius': 2,
            'circle-color': '#1a0d04',
          },
        })

        // Customer scans — clustered. When zoomed out enough that
        // several pins overlap, nearby points collapse into a
        // numbered cluster pin. The same source feeds a heatmap
        // layer (weighted by cluster size, so a cluster of N
        // contributes as N points to local density).
        mapInstance.addSource('scans', {
          type: 'geojson',
          data: pointsGeoJson,
          cluster: true,
          clusterRadius: 40,
          // Need at least 4 nearby points before we collapse — fewer
          // than that is "a small number of overlapping pins" which
          // the user wants to see individually.
          clusterMinPoints: 4,
          clusterMaxZoom: 15,
        })

        mapInstance.addLayer({
          id: 'scans-heat',
          type: 'heatmap',
          source: 'scans',
          paint: {
            // Each cluster feature counts for its full member count
            // so density reflects the true number of *hidden* pins.
            'heatmap-weight': [
              'case',
              ['has', 'point_count'],
              ['get', 'point_count'],
              1,
            ],
            'heatmap-intensity': [
              'interpolate', ['linear'], ['zoom'],
              7, 0.7,
              12, 1.0,
              16, 1.4,
            ],
            // Transparent at zero density → progressively greener
            // as the number of overlapping pins increases.
            'heatmap-color': [
              'interpolate', ['linear'], ['heatmap-density'],
              0,    'rgba(0, 0, 0, 0)',
              0.1,  'rgba(199, 233, 180, 0.35)',
              0.3,  'rgba(120, 198, 121, 0.55)',
              0.6,  'rgba(49,  163,  84, 0.75)',
              1.0,  'rgba(0,   104,  55, 0.90)',
            ],
            'heatmap-radius': [
              'interpolate', ['linear'], ['zoom'],
              7,  14,
              12, 24,
              16, 36,
            ],
            // Fade the heatmap out as we zoom in past the cluster
            // break-apart zoom — by then individual dots take over.
            'heatmap-opacity': [
              'interpolate', ['linear'], ['zoom'],
              9,  1.0,
              14, 0.7,
              16, 0.0,
            ],
          },
        })

        mapInstance.addLayer({
          id: 'scans-clusters',
          type: 'circle',
          source: 'scans',
          filter: ['has', 'point_count'],
          paint: {
            'circle-color': [
              'step', ['get', 'point_count'],
              '#a5d8a5',  10,
              '#52b552',  50,
              '#1a8a3a', 200,
              '#0e5c25',
            ],
            'circle-radius': [
              'step', ['get', 'point_count'],
              14,  10,
              18,  50,
              22, 200,
              28,
            ],
            'circle-stroke-color': '#ffffff',
            'circle-stroke-width': 2,
            'circle-opacity': 0.9,
          },
        })

        mapInstance.addLayer({
          id: 'scans-cluster-count',
          type: 'symbol',
          source: 'scans',
          filter: ['has', 'point_count'],
          layout: {
            'text-field': ['get', 'point_count_abbreviated'],
            'text-font': ['Open Sans Regular'],
            'text-size': 12,
            'text-allow-overlap': true,
          },
          paint: {
            'text-color': '#0d2e15',
            'text-halo-color': '#ffffff',
            'text-halo-width': 1.2,
          },
        })

        mapInstance.addLayer({
          id: 'scans-circles',
          type: 'circle',
          source: 'scans',
          filter: ['!', ['has', 'point_count']],
          paint: {
            // BIG, BRIGHT, halo-stroked so they pop against the
            // faded base. Zoom-interpolated so dots stay legible
            // even at the citywide default zoom.
            'circle-radius': [
              'interpolate',
              ['linear'],
              ['zoom'],
              7, 6,
              10, 9,
              13, 13,
              16, 18,
              19, 24,
            ],
            'circle-color': [
              'match',
              ['get', 'siteSlug'],
              'bx', '#0d47ff',
              'mh', '#f25c1c',
              '#444444',
            ],
            // Slightly faded + dashed-feeling for scan-coord
            // fallbacks so reviewers can tell at a glance whether
            // a dot reflects "where the customer lives" (filled,
            // opaque) or "where they scanned" (lower opacity,
            // dark halo).
            'circle-opacity': [
              'match',
              ['get', 'coordSource'],
              'document', 0.92,
              'scan', 0.55,
              0.92,
            ],
            'circle-stroke-color': [
              'match',
              ['get', 'coordSource'],
              'document', '#ffffff',
              'scan', '#1a0d04',
              '#ffffff',
            ],
            'circle-stroke-width': 2,
            'circle-stroke-opacity': 0.95,
          },
        })

        // Store labels last so they sit on top and stay legible
        // over both customer dots and clusters.
        mapInstance.addLayer({
          id: 'sites-labels',
          type: 'symbol',
          source: 'sites',
          layout: {
            'text-field': ['get', 'label'],
            'text-size': 12,
            'text-offset': [0, 1.0],
            'text-anchor': 'top',
            'text-allow-overlap': false,
            'text-font': ['Open Sans Regular'],
          },
          paint: {
            'text-color': '#1a0d04',
            'text-halo-color': '#fffaf1',
            'text-halo-width': 2,
          },
        })

        // Click a cluster → zoom in until it breaks apart.
        mapInstance.on('click', 'scans-clusters', (event) => {
          const feature = event.features?.[0]
          if (!feature || feature.geometry.type !== 'Point') return
          const clusterId = feature.properties?.cluster_id as number | undefined
          if (clusterId === undefined) return
          const source = mapInstance!.getSource('scans') as maplibregl.GeoJSONSource
          const [lng, lat] = feature.geometry.coordinates as [number, number]
          void source
            .getClusterExpansionZoom(clusterId)
            .then((zoom) => {
              mapInstance!.easeTo({ center: [lng, lat], zoom })
            })
            .catch(() => {
              // If expansion zoom isn't available for some reason
              // (e.g. source not yet ready), just nudge in by one.
              mapInstance!.easeTo({ center: [lng, lat], zoom: mapInstance!.getZoom() + 1 })
            })
        })
        mapInstance.on('mouseenter', 'scans-clusters', () => {
          mapInstance!.getCanvas().style.cursor = 'pointer'
        })
        mapInstance.on('mouseleave', 'scans-clusters', () => {
          mapInstance!.getCanvas().style.cursor = ''
        })

        mapInstance.on('click', 'scans-circles', (event) => {
          const feature = event.features?.[0]
          if (!feature || feature.geometry.type !== 'Point') return
          const props = feature.properties ?? {}
          const [lng, lat] = feature.geometry.coordinates as [number, number]
          const sourceLabel =
            String(props.coordSource ?? '') === 'scan'
              ? 'scan location (no address coords)'
              : 'home address'
          const html = `
            <div class="cm-popup">
              <div class="cm-popup-name">${escapeHtml(String(props.displayName ?? 'Unknown'))}</div>
              <div class="cm-popup-meta">
                ${escapeHtml(String(props.siteSlug ?? ''))} ·
                ${escapeHtml(formatTime(String(props.checkedInAt ?? '')))}
              </div>
              <div class="cm-popup-addr">
                ${escapeHtml([props.city, props.state, props.postalCode].filter(Boolean).join(', '))}
              </div>
              <div class="cm-popup-source">${escapeHtml(sourceLabel)}</div>
              <a
                class="cm-popup-link"
                href="${buildAppPath(String(props.customerUrl ?? ''))}"
                target="_blank" rel="noreferrer"
              >Open customer details ↗</a>
            </div>
          `
          popupRef.current?.remove()
          popupRef.current = new maplibre.Popup({ closeButton: true, closeOnClick: true })
            .setLngLat([lng, lat])
            .setHTML(html)
            .addTo(mapInstance!)
        })

        mapInstance.on('mouseenter', 'scans-circles', () => {
          mapInstance!.getCanvas().style.cursor = 'pointer'
        })
        mapInstance.on('mouseleave', 'scans-circles', () => {
          mapInstance!.getCanvas().style.cursor = ''
        })
      })
    })()

    return () => {
      alive = false
      popupRef.current?.remove()
      popupRef.current = null
      mapRef.current?.remove()
      mapRef.current = null
    }
    // single instance for the page lifetime; data pushes happen in
    // the next effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const map = mapRef.current
    if (map === null) return
    function push(): void {
      const scansSource = map!.getSource('scans')
      if (scansSource && 'setData' in scansSource) {
        ;(scansSource as maplibregl.GeoJSONSource).setData(pointsGeoJson)
      }
      const sitesSource = map!.getSource('sites')
      if (sitesSource && 'setData' in sitesSource) {
        ;(sitesSource as maplibregl.GeoJSONSource).setData(sitesGeoJson)
      }
    }
    if (map.isStyleLoaded()) {
      push()
    } else {
      map.once('load', push)
    }
  }, [pointsGeoJson, sitesGeoJson])

  // -----------------------------------------------------------------
  // Live date-range slider state
  // -----------------------------------------------------------------
  // We hold a stable window range for the page lifetime so dragging
  // doesn't shift the slider geometry mid-interaction.
  const sliderWindow = useMemo(() => buildSliderRange(), [])

  const currentAfter = clampDateToWindow(
    searchParams.get('checkedInAfter'),
    sliderWindow,
    sliderWindow.windowStart,
  )
  const currentBefore = clampDateToWindow(
    searchParams.get('checkedInBefore'),
    sliderWindow,
    sliderWindow.windowEnd,
  )

  // Local slider state so the handles render smoothly while we
  // debounce the URL write.
  const [sliderAfterTick, setSliderAfterTick] = useState(() =>
    dateToTick(currentAfter, sliderWindow),
  )
  const [sliderBeforeTick, setSliderBeforeTick] = useState(() =>
    dateToTick(currentBefore, sliderWindow),
  )

  // Keep the local handles in sync if the URL changes from outside
  // (browser back/forward, preset button, etc.).
  useEffect(() => {
    setSliderAfterTick(dateToTick(currentAfter, sliderWindow))
    setSliderBeforeTick(dateToTick(currentBefore, sliderWindow))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams])

  const writeRangeTimer = useRef<number | null>(null)
  const commitRangeToUrl = useCallback(
    (afterTick: number, beforeTick: number): void => {
      const lo = Math.min(afterTick, beforeTick)
      const hi = Math.max(afterTick, beforeTick)
      if (writeRangeTimer.current !== null) {
        window.clearTimeout(writeRangeTimer.current)
      }
      writeRangeTimer.current = window.setTimeout(() => {
        const next = new URLSearchParams(searchParams)
        next.set('checkedInAfter', tickToDate(lo, sliderWindow).toISOString())
        next.set('checkedInBefore', tickToDate(hi, sliderWindow).toISOString())
        setSearchParams(next, { replace: true })
      }, 220)
    },
    [searchParams, setSearchParams, sliderWindow],
  )

  function handleAfterChange(value: number): void {
    const v = Math.min(value, sliderBeforeTick)
    setSliderAfterTick(v)
    commitRangeToUrl(v, sliderBeforeTick)
  }
  function handleBeforeChange(value: number): void {
    const v = Math.max(value, sliderAfterTick)
    setSliderBeforeTick(v)
    commitRangeToUrl(sliderAfterTick, v)
  }

  // Quick presets — set both handles + URL at once.
  function applyPreset(after: Date, before: Date): void {
    const a = dateToTick(after, sliderWindow)
    const b = dateToTick(before, sliderWindow)
    setSliderAfterTick(a)
    setSliderBeforeTick(b)
    const next = new URLSearchParams(searchParams)
    next.set('checkedInAfter', after.toISOString())
    next.set('checkedInBefore', before.toISOString())
    setSearchParams(next, { replace: true })
  }

  const previewAfter = tickToDate(Math.min(sliderAfterTick, sliderBeforeTick), sliderWindow)
  const previewBefore = tickToDate(Math.max(sliderAfterTick, sliderBeforeTick), sliderWindow)

  // Friendly label: when the current window matches the canonical
  // "yesterday 6am → today 3am" preset (within an hour, since slider
  // ticks are 1h apart), show "Yesterday" instead of digits. Otherwise
  // fall through to formatShortRange.
  const yesterdayPreset = yesterdayShiftRange(sliderWindow.windowEnd)
  const isYesterdayPreset =
    nearMs(previewAfter, yesterdayPreset.after) &&
    nearMs(previewBefore, yesterdayPreset.before)
  const rangeLabel = isYesterdayPreset
    ? 'Yesterday'
    : formatShortRange(previewAfter, previewBefore)

  // -----------------------------------------------------------------
  // Other filter controls
  // -----------------------------------------------------------------
  function handleSiteChange(siteSlugs: string): void {
    const next = new URLSearchParams(searchParams)
    if (siteSlugs === '') next.delete('siteSlugs')
    else next.set('siteSlugs', siteSlugs)
    setSearchParams(next, { replace: true })
  }
  // Local-state mirror for the max-points input so intermediate typing
  // ("", "2", "25", "250", "2500") doesn't churn the URL — and so we
  // never push a value that would fail the server schema (min=1,
  // max=10_000). We commit on blur or Enter, clamping to the legal
  // band. Empty / non-numeric → restore the default 2,500.
  const [maxPointsDraft, setMaxPointsDraft] = useState<string>(
    () => searchParams.get('maxPoints') ?? String(DEFAULT_MAX_POINTS),
  )
  useEffect(() => {
    setMaxPointsDraft(searchParams.get('maxPoints') ?? String(DEFAULT_MAX_POINTS))
  }, [searchParams])
  function commitMaxPointsDraft(): void {
    const raw = maxPointsDraft.trim()
    const next = new URLSearchParams(searchParams)
    if (raw === '') {
      next.delete('maxPoints')
      setSearchParams(next, { replace: true })
      return
    }
    const parsed = Number(raw)
    if (!Number.isFinite(parsed)) {
      // garbage; revert draft and keep URL.
      setMaxPointsDraft(searchParams.get('maxPoints') ?? String(DEFAULT_MAX_POINTS))
      return
    }
    const clamped = Math.max(1, Math.min(10_000, Math.round(parsed)))
    next.set('maxPoints', String(clamped))
    setMaxPointsDraft(String(clamped))
    setSearchParams(next, { replace: true })
  }

  function handleResetFilters(): void {
    const next = new URLSearchParams()
    next.set('checkedInAfter', defaultCheckedInAfter())
    next.set('checkedInBefore', defaultCheckedInBefore())
    next.set('maxPoints', String(DEFAULT_MAX_POINTS))
    setSearchParams(next, { replace: true })
  }

  const now = sliderWindow.windowEnd
  const sixAmYesterday = new Date(now)
  sixAmYesterday.setDate(sixAmYesterday.getDate() - 1)
  sixAmYesterday.setHours(6, 0, 0, 0)
  const threeAmToday = new Date(now)
  threeAmToday.setHours(3, 0, 0, 0)

  return (
    <section className="customer-map-page">
      <header className="cm-header">
        <div>
          <h2 className="cm-title">Customer Origin Map</h2>
          <p className="subtle-copy cm-sub">
            One dot per VeriScan check-in with a document address on file.
            <strong> Bronx blue, Midtown orange.</strong> Drag the time range
            below to update the map live.
          </p>
        </div>
        <div className="cm-stats">
          <Pill tone="muted">{`${data.points.length.toLocaleString()} shown`}</Pill>
          {data.clipped ? (
            <Pill tone="warning">{`${data.totalMatching.toLocaleString()} total — narrow filter`}</Pill>
          ) : null}
          {loading ? <Pill tone="muted">refreshing…</Pill> : null}
        </div>
      </header>

      {/* Always-visible primary controls: site, date slider, presets. */}
      <div className="cm-controls">
        <div className="cm-controls-row">
          <label className="cm-field cm-field-inline">
            <span>Site</span>
            <select
              value={searchParams.get('siteSlugs') ?? ''}
              onChange={(e) => handleSiteChange(e.target.value)}
            >
              <option value="">All</option>
              <option value="bx">Bronx (bx)</option>
              <option value="mh">Midtown (mh)</option>
            </select>
          </label>
          <label className="cm-field cm-field-inline">
            <span>Max points</span>
            <input
              type="number"
              inputMode="numeric"
              min={1}
              max={10_000}
              step={100}
              value={maxPointsDraft}
              onChange={(e) => setMaxPointsDraft(e.target.value)}
              onBlur={commitMaxPointsDraft}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  commitMaxPointsDraft()
                }
              }}
            />
          </label>
          <button
            type="button"
            className="ghost-button cm-action cm-reset-action"
            onClick={handleResetFilters}
          >
            Reset to last shift
          </button>
        </div>

        <div className="cm-range">
          <div className="cm-range-labels">
            <span className="cm-range-label">
              <strong>{rangeLabel}</strong>
            </span>
            <span className="cm-range-sub subtle-copy">
              window: {sliderWindow.windowStart.toLocaleDateString()} →{' '}
              {sliderWindow.windowEnd.toLocaleDateString()}
            </span>
          </div>
          <div className="cm-range-sliders">
            <input
              type="range"
              min={0}
              max={SLIDER_STEPS}
              step={1}
              value={sliderAfterTick}
              onChange={(e) => handleAfterChange(Number(e.target.value))}
              aria-label="Range start"
              className="cm-range-input cm-range-input-low"
            />
            <input
              type="range"
              min={0}
              max={SLIDER_STEPS}
              step={1}
              value={sliderBeforeTick}
              onChange={(e) => handleBeforeChange(Number(e.target.value))}
              aria-label="Range end"
              className="cm-range-input cm-range-input-high"
            />
            <div className="cm-range-track">
              <div
                className="cm-range-fill"
                style={{
                  left: `${(Math.min(sliderAfterTick, sliderBeforeTick) / SLIDER_STEPS) * 100}%`,
                  width: `${(Math.abs(sliderBeforeTick - sliderAfterTick) / SLIDER_STEPS) * 100}%`,
                }}
              />
            </div>
          </div>
          <div className="cm-presets">
            <button
              type="button"
              className="ghost-button cm-preset-btn"
              onClick={() =>
                applyPreset(new Date(now.getTime() - 60 * 60 * 1000), now)
              }
            >
              Last 1h
            </button>
            <button
              type="button"
              className="ghost-button cm-preset-btn"
              onClick={() =>
                applyPreset(new Date(now.getTime() - 4 * 60 * 60 * 1000), now)
              }
            >
              Last 4h
            </button>
            <button
              type="button"
              className="ghost-button cm-preset-btn"
              onClick={() => applyPreset(sixAmYesterday, threeAmToday)}
            >
              Yesterday 6a–3a
            </button>
            <button
              type="button"
              className="ghost-button cm-preset-btn"
              onClick={() =>
                applyPreset(new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000), now)
              }
            >
              Last 7d
            </button>
            <button
              type="button"
              className="ghost-button cm-preset-btn"
              onClick={() =>
                applyPreset(new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000), now)
              }
            >
              Last 30d
            </button>
          </div>
        </div>
      </div>

      {error ? (
        <div className="runtime-status-strip cm-error">
          <div className="runtime-status-item">
            <Pill tone="danger">load failed</Pill>
            <span className="subtle-copy">{error}</span>
          </div>
        </div>
      ) : null}

      <div className="cm-map-wrap">
        <div ref={containerRef} className="cm-map" />
      </div>

      <details className="cm-about">
        <summary className="subtle-copy">About this page</summary>
        <div className="subtle-copy cm-about-body">
          <p>
            Data source: <code>visitor_scans</code>. Each dot is the printed
            address coordinate from one VeriScan check-in — no geocoder is in
            the loop. Scans without document address coords are not shown.
          </p>
          <p>
            Default window is <strong>yesterday 6am → today 3am</strong> in
            your local time so the page opens to "today's traffic". Drag the
            handles to widen / narrow the window; the map updates live.
          </p>
        </div>
      </details>
    </section>
  )
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}
