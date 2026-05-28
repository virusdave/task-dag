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
        // Basemap-as-ground tuning, halfway between the original
        // (too crisp, dots disappeared into it) and the fully
        // ghosted pass (too washed-out to read borough shapes).
        // Roads and coastlines are still legible; the dots are
        // still unambiguously the figure.
        'raster-opacity': 0.42,
        'raster-saturation': -0.92,
        'raster-contrast': -0.35,
        'raster-brightness-min': 0.28,
        'raster-brightness-max': 0.98,
      },
    },
  ],
}

const DEFAULT_CENTER: [number, number] = [-73.95, 40.78]
const DEFAULT_ZOOM = 10.5
const DEFAULT_MAX_POINTS = 2500

// ---------------------------------------------------------------------
// Replay (C5) defaults
// ---------------------------------------------------------------------
// Per parent design §9 and operator clarification on issue #33:
//
//  * Playback duration default: "5 seconds per 24h in the time range,
//    minimum 5 seconds." A 24h window plays back in 5s; a 7d window
//    plays back in 35s; a 1h window plays back in the 5s floor.
//
//  * Lifetime / fade default: "10% of the time range, max 1 week."
//    A 24h window keeps each dot visible for ~2.4h of virtual time,
//    fading from full opacity to zero across that span. A 30d window
//    caps lifetime at 7d so old dots don't linger forever.
//
//  * Loop on by default — the operator explicitly asked for "optionally
//    in a loop" and the playback is the primary use of the page when
//    open in a live-ops context. We use `tail=clear` (reset both
//    cursor and faded-dot state at loop boundaries) per parent §9.6,
//    with a small visual pause at reset.
//
// The replay state lives entirely client-side. It does not refetch
// from the server — it animates over the points already loaded for
// the current filter window. Rendering uses the existing MapLibre
// circle layer with a data-driven opacity expression keyed off each
// point's `checkedInAtMs` property and the current `cursorMs`, so
// we hit the 30–60fps target via WebGL even on the full 10k-point
// max-points cap (no DOM markers).

const REPLAY_MIN_DURATION_MS = 5_000
const REPLAY_SECONDS_PER_24H = 5
const REPLAY_DEFAULT_LIFETIME_FRACTION = 0.1 // 10% of window
const REPLAY_MAX_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000 // 1 week
const REPLAY_MIN_LIFETIME_MS = 1_000 // never fade in less than 1s
const REPLAY_LOOP_PAUSE_MS = 350 // small black-frame at loop reset

/** Replay playback total duration (real ms) for a given virtual window span. */
function defaultPlaybackDurationMs(windowMs: number): number {
  const scaled = REPLAY_SECONDS_PER_24H * 1000 * (windowMs / (24 * 60 * 60 * 1000))
  return Math.max(REPLAY_MIN_DURATION_MS, Math.round(scaled))
}

/** Per-dot lifetime (virtual ms) — how long each dot stays visible before fully fading. */
function defaultLifetimeMs(windowMs: number): number {
  const scaled = Math.round(windowMs * REPLAY_DEFAULT_LIFETIME_FRACTION)
  return Math.max(REPLAY_MIN_LIFETIME_MS, Math.min(REPLAY_MAX_LIFETIME_MS, scaled))
}

// Base per-dot opacity expression — fill and stroke, keyed off
// coordSource. Document-coord dots are crisp; scan fallbacks are
// faded so the operator can tell which dots reflect "where the
// customer lives" vs "where they scanned".
const BASE_FILL_OPACITY: maplibregl.ExpressionSpecification = [
  'match',
  ['get', 'coordSource'],
  'document', 0.92,
  'scan', 0.55,
  0.92,
]
const BASE_STROKE_OPACITY = 0.9

// Replay opacity expression — modulates the base opacity by a fade
// factor that depends on (cursorMs - checkedInAtMs):
//
//   age <  0           → 0     (point is in the future relative to cursor)
//   age >= lifetimeMs  → 0     (point fully faded out)
//   else               → base * (1 - age / lifetimeMs)
//
// Built fresh each animation frame and pushed via setPaintProperty.
// This is cheap — MapLibre keeps the expression compiled and we
// only mutate two literals (cursor + lifetime).
function replayFillOpacityExpr(
  cursorMs: number,
  lifetimeMs: number,
): maplibregl.ExpressionSpecification {
  const fadeStart = cursorMs - lifetimeMs
  return [
    'case',
    ['>', ['get', 'checkedInAtMs'], cursorMs], 0,
    ['<=', ['get', 'checkedInAtMs'], fadeStart], 0,
    [
      '*',
      BASE_FILL_OPACITY,
      [
        '-',
        1,
        ['/', ['-', cursorMs, ['get', 'checkedInAtMs']], lifetimeMs],
      ],
    ],
  ]
}
function replayStrokeOpacityExpr(
  cursorMs: number,
  lifetimeMs: number,
): maplibregl.ExpressionSpecification {
  const fadeStart = cursorMs - lifetimeMs
  return [
    'case',
    ['>', ['get', 'checkedInAtMs'], cursorMs], 0,
    ['<=', ['get', 'checkedInAtMs'], fadeStart], 0,
    [
      '*',
      BASE_STROKE_OPACITY,
      [
        '-',
        1,
        ['/', ['-', cursorMs, ['get', 'checkedInAtMs']], lifetimeMs],
      ],
    ],
  ]
}

/** Human-readable duration ("5s", "1m 30s", "2h 15m"). */
function formatDurationMs(ms: number): string {
  if (ms < 1_000) return `${ms}ms`
  const totalSec = Math.round(ms / 1000)
  if (totalSec < 60) return `${totalSec}s`
  const totalMin = Math.round(totalSec / 60)
  if (totalMin < 60) {
    const s = totalSec % 60
    return s === 0 ? `${totalMin}m` : `${totalMin}m ${s}s`
  }
  const h = Math.floor(totalMin / 60)
  const m = totalMin % 60
  if (h < 24) return m === 0 ? `${h}h` : `${h}h ${m}m`
  const d = Math.floor(h / 24)
  const hr = h % 24
  return hr === 0 ? `${d}d` : `${d}d ${hr}h`
}

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

// FNV-1a 32-bit hash → unsigned int. Deterministic, branch-free,
// fine for a stable per-scan jitter seed.
function fnv1a(str: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

// ~400 ft jitter, in meters, applied as a uniform offset within a
// disk centered on the geocode. Seeded off the scanId so a given
// scan always lands at the same jittered spot across re-renders.
const JITTER_RADIUS_M = 400 * 0.3048 // ~121.92 m
function jitterCoord(
  lng: number,
  lat: number,
  seed: string | number,
): [number, number] {
  const h = fnv1a(String(seed))
  // Split the 32-bit hash into two 16-bit pseudo-randoms in [0, 1).
  const u1 = (h & 0xffff) / 0x10000
  const u2 = ((h >>> 16) & 0xffff) / 0x10000
  // Uniform sampling within a disk: r = R * sqrt(u), θ = 2π u'.
  const radius = JITTER_RADIUS_M * Math.sqrt(u1)
  const angle = 2 * Math.PI * u2
  const dN = radius * Math.cos(angle) // north (m)
  const dE = radius * Math.sin(angle) // east (m)
  // 1° latitude ≈ 111,320 m; 1° longitude ≈ 111,320·cos(lat) m.
  const dLat = dN / 111_320
  const dLng = dE / (111_320 * Math.cos((lat * Math.PI) / 180))
  return [lng + dLng, lat + dLat]
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
      features: data.points.map((p) => {
        // Jitter the marker up to ~400 ft from the geocode so that
        // coarse geocodes like "New York, NY" don't stack thousands
        // of pins on a single pixel. Seeded off scanId so the same
        // scan always lands at the same jittered spot across
        // re-renders (no flicker, no shuffling on data refresh).
        const [jLng, jLat] = jitterCoord(p.lng, p.lat, p.scanId)
        // checkedInAtMs as a numeric property so MapLibre's
        // data-driven expressions (replay opacity) can compare it
        // arithmetically against the current cursor. Defaults to 0
        // on unparseable timestamps so such points stay hidden
        // throughout replay rather than blinking randomly.
        const tMs = Date.parse(p.checkedInAt)
        return {
          type: 'Feature' as const,
          geometry: { type: 'Point' as const, coordinates: [jLng, jLat] },
          properties: {
            scanId: p.scanId,
            siteSlug: p.siteSlug,
            checkedInAt: p.checkedInAt,
            checkedInAtMs: Number.isFinite(tMs) ? tMs : 0,
            coordSource: p.coordSource,
            displayName: p.displayName ?? 'Unknown visitor',
            city: p.city ?? '',
            state: p.state ?? '',
            postalCode: p.postalCode ?? '',
            customerUrl: p.customerUrl,
          },
        }
      }),
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
      // Browser-fullscreen toggle next to zoom controls. Built-in
      // MapLibre control; standard ⛶ icon. Hooks the browser
      // Fullscreen API on supported browsers and falls back to a
      // CSS-positioned overlay otherwise.
      mapInstance.addControl(new maplibre.FullscreenControl(), 'top-right')
      mapInstance.addControl(
        new maplibre.AttributionControl({ compact: true }),
        'bottom-right',
      )
      mapRef.current = mapInstance

      mapInstance.on('load', () => {
        if (!mapInstance) return

        // Store-location pins go in FIRST so they sit at the BOTTOM
        // of the stack — customer dots always render above them.
        // Kept small + label-anchored so they don't compete with
        // customer data visually.
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

        // Customer scans — one dot per check-in. No clustering, no
        // heatmap (the previous heatmap/cluster pass wasn't what the
        // operator meant by "heatmap"; left as dots, smaller than
        // before so dense neighborhoods stay legible).
        mapInstance.addSource('scans', { type: 'geojson', data: pointsGeoJson })

        mapInstance.addLayer({
          id: 'scans-circles',
          type: 'circle',
          source: 'scans',
          paint: {
            // Small-ish dots — the city-wide view still needs to
            // hold thousands of scans without blobbing into a solid
            // mass, but the previous pass shrank them to the point
            // of disappearing against the basemap. With the basemap
            // now ghosted to a near-white background, these radii
            // pop clearly while still revealing density via the
            // per-scan jitter (~400 ft).
            'circle-radius': [
              'interpolate',
              ['linear'],
              ['zoom'],
              7, 2,
              10, 3,
              13, 4.5,
              16, 6.5,
              19, 9,
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
            // dark halo). When replay (C5) is playing, the page-
            // level animation effect swaps these for a fade
            // expression keyed off cursor + lifetime.
            'circle-opacity': BASE_FILL_OPACITY,
            'circle-stroke-color': [
              'match',
              ['get', 'coordSource'],
              'document', '#ffffff',
              'scan', '#1a0d04',
              '#ffffff',
            ],
            // Thin halo for separation against the ghosted basemap
            // and against other dots in dense areas.
            'circle-stroke-width': 1,
            'circle-stroke-opacity': BASE_STROKE_OPACITY,
          },
        })

        // Store labels last so they sit on top and stay legible
        // over the customer dots.
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

  // Generic "set or clear" URL-param mutator for the simple
  // single-value selects (site, visit type, age, home state, link
  // status, coord source). Empty string clears the param so the
  // server falls back to "no filter on this dimension".
  function setParam(key: string, value: string): void {
    const next = new URLSearchParams(searchParams)
    if (value === '') next.delete(key)
    else next.set(key, value)
    setSearchParams(next, { replace: true })
  }
  function handleSiteChange(siteSlugs: string): void {
    setParam('siteSlugs', siteSlugs)
  }

  // ZIP prefix has the same draft/commit pattern as Max Points —
  // we don't churn the URL on every keystroke, and we only push a
  // value that passes the server's `^[0-9]*$` schema (so a partial
  // "1" doesn't cause a 400 on the way to "104").
  const [postalPrefixDraft, setPostalPrefixDraft] = useState<string>(
    () => searchParams.get('postalPrefix') ?? '',
  )
  useEffect(() => {
    setPostalPrefixDraft(searchParams.get('postalPrefix') ?? '')
  }, [searchParams])
  function commitPostalPrefixDraft(): void {
    const cleaned = postalPrefixDraft.replace(/\D+/g, '').slice(0, 10)
    setPostalPrefixDraft(cleaned)
    setParam('postalPrefix', cleaned)
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

  // -----------------------------------------------------------------
  // Replay (C5) — client-side animation over already-loaded points
  // -----------------------------------------------------------------
  // The map's circle layer renders all points up-front; replay just
  // modulates per-point opacity via a data-driven MapLibre expression
  // that fades each dot in at its checked-in timestamp and out over
  // the configured lifetime. No new server endpoint, no per-frame
  // refetch — the operator drags the window to choose what to replay
  // and the animation works against that bounded set.
  //
  // State:
  //   replayPlaying — true while animating
  //   replayCursorMs — current virtual time (epoch ms) within the
  //     [previewAfter, previewBefore] window
  //   replayDurationMs — total real-time length of the playback
  //   replayLifetimeMs — virtual-time lifetime each dot stays visible
  //   replayLoop — if true, jumps back to start after each pass
  //   `prefers-reduced-motion` → page loads paused (default state).

  const windowAfterMs = previewAfter.getTime()
  const windowBeforeMs = previewBefore.getTime()
  const windowSpanMs = Math.max(1, windowBeforeMs - windowAfterMs)
  const defaultDurMs = defaultPlaybackDurationMs(windowSpanMs)
  const defaultLifeMs = defaultLifetimeMs(windowSpanMs)

  const [replayPlaying, setReplayPlaying] = useState(false)
  const [replayCursorMs, setReplayCursorMs] = useState<number>(windowAfterMs)
  const [replayDurationMs, setReplayDurationMs] = useState<number>(defaultDurMs)
  const [replayLifetimeMs, setReplayLifetimeMs] = useState<number>(defaultLifeMs)
  const [replayLoop, setReplayLoop] = useState<boolean>(true)
  // True while the loop is in its black-frame pause between passes.
  const [replayPausing, setReplayPausing] = useState<boolean>(false)

  // When the window changes (operator dragged the slider, or
  // applied a preset), reset the replay cursor + defaults so we
  // don't try to animate against a stale virtual time.
  useEffect(() => {
    setReplayCursorMs(windowAfterMs)
    setReplayDurationMs(defaultPlaybackDurationMs(windowSpanMs))
    setReplayLifetimeMs(defaultLifetimeMs(windowSpanMs))
    // We deliberately do NOT toggle replayPlaying — if the operator
    // was actively playing and nudged the slider, they probably want
    // to keep playing on the new window.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [windowAfterMs, windowBeforeMs])

  // Animation loop. Runs only while replayPlaying is true.
  const rafRef = useRef<number | null>(null)
  const lastTickRef = useRef<number | null>(null)
  useEffect(() => {
    if (!replayPlaying) {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current)
        rafRef.current = null
      }
      lastTickRef.current = null
      return
    }
    // virtual-ms-per-real-ms ratio: windowSpan virtual ms covers
    // replayDurationMs of real time.
    const ratio = windowSpanMs / Math.max(1, replayDurationMs)
    function tick(now: number): void {
      if (lastTickRef.current === null) lastTickRef.current = now
      const elapsedReal = now - lastTickRef.current
      lastTickRef.current = now
      setReplayCursorMs((prev) => {
        const next = prev + elapsedReal * ratio
        if (next >= windowBeforeMs) {
          if (replayLoop) {
            // Black-frame pause at the loop boundary so the eye
            // can register the reset rather than smearing across it.
            setReplayPausing(true)
            window.setTimeout(() => {
              setReplayPausing(false)
              lastTickRef.current = null
            }, REPLAY_LOOP_PAUSE_MS)
            return windowAfterMs
          }
          // Single-pass: stop at the end.
          setReplayPlaying(false)
          return windowBeforeMs
        }
        return next
      })
      rafRef.current = requestAnimationFrame(tick)
    }
    rafRef.current = requestAnimationFrame(tick)
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
      rafRef.current = null
      lastTickRef.current = null
    }
  }, [
    replayPlaying,
    replayLoop,
    replayDurationMs,
    windowSpanMs,
    windowAfterMs,
    windowBeforeMs,
  ])

  // Push the replay opacity expressions to the live circle layer.
  // When replay is off, restore the static base opacity.
  useEffect(() => {
    const map = mapRef.current
    if (map === null) return
    function apply(): void {
      if (map!.getLayer('scans-circles') === undefined) return
      if (replayPlaying || replayCursorMs !== windowAfterMs) {
        // While pausing at the loop boundary, hide all dots.
        const fill = replayPausing
          ? 0
          : replayFillOpacityExpr(replayCursorMs, replayLifetimeMs)
        const stroke = replayPausing
          ? 0
          : replayStrokeOpacityExpr(replayCursorMs, replayLifetimeMs)
        map!.setPaintProperty('scans-circles', 'circle-opacity', fill)
        map!.setPaintProperty('scans-circles', 'circle-stroke-opacity', stroke)
      } else {
        map!.setPaintProperty('scans-circles', 'circle-opacity', BASE_FILL_OPACITY)
        map!.setPaintProperty(
          'scans-circles',
          'circle-stroke-opacity',
          BASE_STROKE_OPACITY,
        )
      }
    }
    if (map.isStyleLoaded()) {
      apply()
    } else {
      map.once('load', apply)
    }
  }, [replayPlaying, replayPausing, replayCursorMs, replayLifetimeMs, windowAfterMs])

  function handleReplayToggle(): void {
    setReplayPlaying((p) => {
      if (p) return false
      // Resuming from a finished single-pass: rewind to start.
      if (replayCursorMs >= windowBeforeMs) {
        setReplayCursorMs(windowAfterMs)
      }
      return true
    })
  }
  function handleReplayReset(): void {
    setReplayPlaying(false)
    setReplayCursorMs(windowAfterMs)
    setReplayPausing(false)
  }
  function handleReplayScrub(virtMs: number): void {
    setReplayPlaying(false)
    setReplayCursorMs(Math.max(windowAfterMs, Math.min(windowBeforeMs, virtMs)))
  }
  function handleReplayDurationChange(realSec: number): void {
    if (!Number.isFinite(realSec)) return
    setReplayDurationMs(Math.max(REPLAY_MIN_DURATION_MS, Math.round(realSec * 1000)))
  }
  function handleReplayLifetimeChange(virtSec: number): void {
    if (!Number.isFinite(virtSec)) return
    const ms = Math.round(virtSec * 1000)
    setReplayLifetimeMs(Math.max(REPLAY_MIN_LIFETIME_MS, Math.min(REPLAY_MAX_LIFETIME_MS, ms)))
  }

  const replayProgress =
    windowSpanMs > 0 ? (replayCursorMs - windowAfterMs) / windowSpanMs : 0
  const replayCursorLabel = formatTime(new Date(replayCursorMs).toISOString())

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

      {/* Always-visible primary controls: site, dimensional
          filters, date slider, presets. Wrap freely on narrow
          viewports — every label/select is the same height so the
          rows pack neatly when they fold. */}
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
            <span>Visit</span>
            <select
              value={searchParams.get('visitType') ?? ''}
              onChange={(e) => setParam('visitType', e.target.value)}
            >
              <option value="">All</option>
              <option value="first">First-time</option>
              <option value="returning">Returning</option>
              <option value="unknown">Unknown</option>
            </select>
          </label>
          <label className="cm-field cm-field-inline">
            <span>Age</span>
            <select
              value={searchParams.get('ageBand') ?? ''}
              onChange={(e) => setParam('ageBand', e.target.value)}
            >
              <option value="">All</option>
              <option value="21-24">21–24</option>
              <option value="25-34">25–34</option>
              <option value="35-44">35–44</option>
              <option value="45-54">45–54</option>
              <option value="55-plus">55+</option>
              <option value="unknown">Unknown</option>
            </select>
          </label>
          <label className="cm-field cm-field-inline">
            <span>Home state</span>
            <select
              value={searchParams.get('homeState') ?? ''}
              onChange={(e) => setParam('homeState', e.target.value)}
            >
              <option value="">All</option>
              <option value="NY">NY</option>
              <option value="NJ">NJ</option>
              <option value="CT">CT</option>
              <option value="other">Other (non-NY/NJ/CT)</option>
              <option value="missing">Missing</option>
            </select>
          </label>
          <label className="cm-field cm-field-inline">
            <span>ZIP prefix</span>
            <input
              type="text"
              inputMode="numeric"
              pattern="[0-9]*"
              maxLength={10}
              size={6}
              placeholder="e.g. 104"
              value={postalPrefixDraft}
              onChange={(e) => setPostalPrefixDraft(e.target.value)}
              onBlur={commitPostalPrefixDraft}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  commitPostalPrefixDraft()
                }
              }}
            />
          </label>
          <label className="cm-field cm-field-inline">
            <span>Coord</span>
            <select
              value={searchParams.get('coordSource') ?? ''}
              onChange={(e) => setParam('coordSource', e.target.value)}
              title="Dot location: home address (document) vs kiosk fallback (scan)"
            >
              <option value="">All</option>
              <option value="document">Home address</option>
              <option value="scan">Kiosk fallback</option>
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

        <details className="cm-more-filters">
          <summary>More filters</summary>
          <div className="cm-controls-row">
            <label className="cm-field cm-field-inline">
              <span>CRM link</span>
              <select
                value={searchParams.get('linkStatus') ?? ''}
                onChange={(e) => setParam('linkStatus', e.target.value)}
                title="Filter by Sweed CRM link state for the scan"
              >
                <option value="">All</option>
                <option value="linked">Linked</option>
                <option value="ambiguous">Ambiguous (needs review)</option>
                <option value="no_match,rejected,insufficient_data">No match</option>
                <option value="pending,failed">Pending / retrying</option>
              </select>
            </label>
          </div>
        </details>

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

        {/* Replay (C5) controls. Plays the currently-filtered window
            as a time-lapse with dots fading in at their check-in
            time and out over the configured lifetime. Defaults per
            operator: 5s per 24h of window (min 5s), lifetime 10%
            of window (capped at 1 week), loop on. */}
        <div className="cm-replay">
          <div className="cm-replay-row">
            <button
              type="button"
              className="ghost-button cm-replay-play"
              onClick={handleReplayToggle}
              aria-label={replayPlaying ? 'Pause replay' : 'Play replay'}
              title={replayPlaying ? 'Pause replay' : 'Play replay'}
            >
              {replayPlaying ? '❚❚ Pause' : '▶ Play'}
            </button>
            <button
              type="button"
              className="ghost-button cm-replay-reset"
              onClick={handleReplayReset}
              title="Reset replay to start of window"
            >
              ↺ Reset
            </button>
            <label className="cm-replay-loop">
              <input
                type="checkbox"
                checked={replayLoop}
                onChange={(e) => setReplayLoop(e.target.checked)}
              />
              <span>Loop</span>
            </label>
            <span className="cm-replay-cursor subtle-copy">
              {replayCursorLabel}
            </span>
          </div>
          <input
            type="range"
            min={windowAfterMs}
            max={windowBeforeMs}
            step={Math.max(1, Math.round(windowSpanMs / 1000))}
            value={Math.round(replayCursorMs)}
            onChange={(e) => handleReplayScrub(Number(e.target.value))}
            className="cm-replay-scrub"
            aria-label="Replay scrubber"
          />
          <div className="cm-replay-bar">
            <div
              className="cm-replay-fill"
              style={{ width: `${Math.max(0, Math.min(1, replayProgress)) * 100}%` }}
            />
          </div>
          <div className="cm-replay-row cm-replay-row-tight">
            <label className="cm-field cm-field-inline">
              <span title="Total real-world seconds the playback should take">
                Duration
              </span>
              <input
                type="number"
                inputMode="numeric"
                min={REPLAY_MIN_DURATION_MS / 1000}
                step={1}
                value={Math.round(replayDurationMs / 1000)}
                onChange={(e) => handleReplayDurationChange(Number(e.target.value))}
              />
              <span className="cm-replay-unit">s</span>
            </label>
            <label className="cm-field cm-field-inline">
              <span title="How long (in virtual seconds) each dot stays visible before fading out">
                Lifetime
              </span>
              <input
                type="number"
                inputMode="numeric"
                min={REPLAY_MIN_LIFETIME_MS / 1000}
                max={REPLAY_MAX_LIFETIME_MS / 1000}
                step={1}
                value={Math.round(replayLifetimeMs / 1000)}
                onChange={(e) => handleReplayLifetimeChange(Number(e.target.value))}
              />
              <span className="cm-replay-unit">s virt</span>
            </label>
            <span className="subtle-copy cm-replay-meta">
              {`${formatDurationMs(replayDurationMs)} real · ` +
                `${formatDurationMs(replayLifetimeMs)} virtual lifetime · ` +
                `window ${formatDurationMs(windowSpanMs)}`}
            </span>
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
