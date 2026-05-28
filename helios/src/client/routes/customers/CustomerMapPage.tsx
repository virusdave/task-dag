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
  const end = new Date()
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
        mapInstance.addSource('scans', { type: 'geojson', data: pointsGeoJson })
        mapInstance.addLayer({
          id: 'scans-circles',
          type: 'circle',
          source: 'scans',
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

        mapInstance.addSource('sites', { type: 'geojson', data: sitesGeoJson })
        mapInstance.addLayer({
          id: 'sites-outer',
          type: 'circle',
          source: 'sites',
          paint: {
            'circle-radius': 16,
            'circle-color': '#ffffff',
            'circle-stroke-color': '#1a0d04',
            'circle-stroke-width': 3,
          },
        })
        mapInstance.addLayer({
          id: 'sites-inner',
          type: 'circle',
          source: 'sites',
          paint: {
            'circle-radius': 6,
            'circle-color': '#1a0d04',
          },
        })
        mapInstance.addLayer({
          id: 'sites-labels',
          type: 'symbol',
          source: 'sites',
          layout: {
            'text-field': ['get', 'label'],
            'text-size': 13,
            'text-offset': [0, 1.6],
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

  // -----------------------------------------------------------------
  // Other filter controls
  // -----------------------------------------------------------------
  function handleSiteChange(siteSlugs: string): void {
    const next = new URLSearchParams(searchParams)
    if (siteSlugs === '') next.delete('siteSlugs')
    else next.set('siteSlugs', siteSlugs)
    setSearchParams(next, { replace: true })
  }
  function handleMaxPointsChange(maxPoints: string): void {
    const next = new URLSearchParams(searchParams)
    if (maxPoints === '') next.delete('maxPoints')
    else next.set('maxPoints', maxPoints)
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
              min={1}
              max={10_000}
              step={100}
              value={searchParams.get('maxPoints') ?? String(DEFAULT_MAX_POINTS)}
              onChange={(e) => handleMaxPointsChange(e.target.value)}
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
              <strong>{formatShortRange(previewAfter, previewBefore)}</strong>
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
