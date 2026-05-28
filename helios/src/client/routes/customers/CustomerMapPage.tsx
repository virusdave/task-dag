// /admin/customers/map — customer-origin map.
//
// FreshlyBakedNYC/automation#33, phase C4 v1.
//
// Renders one MapLibre dot per visitor_scan that carries a
// non-null document-address coordinate, plus a pin for each of our
// two retail sites. Filters (site, check-in date range) shared
// with /admin/customers/check-ins land in C4-v2; v1 reads them
// from the URL search params and immediately re-fetches on change.
//
// MapLibre is loaded lazily inside the effect so it never enters
// the initial SSR/test bundle path, and the marker layer is a
// CircleLayer over a GeoJSON source — NOT thousands of DOM nodes
// — so the page stays smooth even at the 2.5k-point default cap.

import { useEffect, useMemo, useRef, useState } from 'react'
import { useLoaderData, useSearchParams } from 'react-router-dom'

import {
  CustomersMapResponseSchema,
  type CustomersMapResponse,
} from '../../../shared/contracts/index.js'
import { loadJson } from '../../app/fetchJson.js'
import { buildAppPath } from '../../app/paths.js'
import { Pill } from '../../components/Pill.js'

// Free, key-less raster style. CARTO/OSM/Stamen would also work;
// OSM raster tiles are the cheapest immediate option for a low-
// volume operator-only page. If the OSM project ever tightens its
// usage policy, swap this style URL for a hosted vector style.
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
    },
  ],
}

// NYC-centric default viewport — the operator can drag elsewhere
// but the first paint should show our two stores.
const DEFAULT_CENTER: [number, number] = [-73.95, 40.78]
const DEFAULT_ZOOM = 10.5

// Type-only import lets us reference maplibregl namespace types
// without forcing it into the initial bundle. The actual module
// loads dynamically inside the effect.
import type maplibregl from 'maplibre-gl'

export async function customerMapLoader({
  request,
}: {
  request: Request
}): Promise<CustomersMapResponse> {
  const url = new URL(request.url)
  return loadJson(`/api/admin/customers/map${url.search}`, CustomersMapResponseSchema)
}

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString(undefined, { hour12: false })
  } catch {
    return iso
  }
}

export function CustomerMapPage(): JSX.Element {
  const initialData = useLoaderData() as CustomersMapResponse
  const [searchParams, setSearchParams] = useSearchParams()
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

  const containerRef = useRef<HTMLDivElement | null>(null)
  const mapRef = useRef<maplibregl.Map | null>(null)
  const popupRef = useRef<maplibregl.Popup | null>(null)

  // Materialise the GeoJSON the map renders. Memoised so we only
  // rebuild on data change, and so the effect that pushes it into
  // the map source has a stable dep.
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

  // Mount the MapLibre instance once on mount; tear it down on
  // unmount. The data-source updates live in a second effect.
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
        // Disable map rotation — it's confusing on a 2-D origin map.
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
        // Visitor-scan dots.
        mapInstance.addSource('scans', {
          type: 'geojson',
          data: pointsGeoJson,
        })
        mapInstance.addLayer({
          id: 'scans-circles',
          type: 'circle',
          source: 'scans',
          paint: {
            'circle-radius': [
              'interpolate',
              ['linear'],
              ['zoom'],
              8,
              3,
              13,
              6,
              18,
              10,
            ],
            'circle-color': [
              'match',
              ['get', 'siteSlug'],
              'bx',
              '#1f5db8',
              'mh',
              '#b95f25',
              '#555555',
            ],
            'circle-opacity': 0.78,
            'circle-stroke-color': '#fffaf1',
            'circle-stroke-width': 1,
          },
        })

        // Site pins — render as larger, white-filled stars.
        mapInstance.addSource('sites', {
          type: 'geojson',
          data: sitesGeoJson,
        })
        mapInstance.addLayer({
          id: 'sites-outer',
          type: 'circle',
          source: 'sites',
          paint: {
            'circle-radius': 14,
            'circle-color': '#fffaf1',
            'circle-stroke-color': '#3b1f0d',
            'circle-stroke-width': 3,
          },
        })
        mapInstance.addLayer({
          id: 'sites-inner',
          type: 'circle',
          source: 'sites',
          paint: {
            'circle-radius': 5,
            'circle-color': '#3b1f0d',
          },
        })
        mapInstance.addLayer({
          id: 'sites-labels',
          type: 'symbol',
          source: 'sites',
          layout: {
            'text-field': ['get', 'label'],
            'text-size': 12,
            'text-offset': [0, 1.4],
            'text-anchor': 'top',
            'text-allow-overlap': false,
          },
          paint: {
            'text-color': '#3b1f0d',
            'text-halo-color': '#fffaf1',
            'text-halo-width': 1.5,
          },
        })

        mapInstance.on('click', 'scans-circles', (event) => {
          const feature = event.features?.[0]
          if (!feature || feature.geometry.type !== 'Point') return
          const props = feature.properties ?? {}
          const [lng, lat] = feature.geometry.coordinates as [number, number]
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
    // Intentionally empty dep array: we want a single map instance
    // for the life of the page; data-source updates happen in the
    // next effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Push new data into the sources when it arrives.
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

  function handleFilterSubmit(event: React.FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const next = new URLSearchParams()
    for (const [k, v] of form.entries()) {
      if (typeof v === 'string' && v.trim().length > 0) next.set(k, v.trim())
    }
    setSearchParams(next)
  }

  function handleClearFilters(): void {
    setSearchParams(new URLSearchParams())
  }

  const filtersActive =
    (searchParams.get('siteSlugs') ?? '').length > 0 ||
    (searchParams.get('checkedInAfter') ?? '').length > 0 ||
    (searchParams.get('checkedInBefore') ?? '').length > 0

  return (
    <section className="customer-map-page">
      <header className="cm-header">
        <div>
          <h2 className="cm-title">Customer Origin Map</h2>
          <p className="subtle-copy cm-sub">
            One dot per VeriScan check-in with a document address on file. Bronx blue,
            Midtown orange. Click a dot to open the customer details page in a new tab.
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

      <details className="cm-filters" open={filtersActive}>
        <summary>
          <span>Filters</span>
          {filtersActive ? <Pill tone="success">active</Pill> : null}
        </summary>
        <form className="cm-filter-form" method="get" onSubmit={handleFilterSubmit}>
          <label className="cm-field">
            <span>Site</span>
            <select defaultValue={searchParams.get('siteSlugs') ?? ''} name="siteSlugs">
              <option value="">All sites</option>
              <option value="bx">Bronx (bx)</option>
              <option value="mh">Midtown (mh)</option>
            </select>
          </label>
          <label className="cm-field">
            <span>Checked in after</span>
            <input
              defaultValue={searchParams.get('checkedInAfter') ?? ''}
              name="checkedInAfter"
              type="datetime-local"
            />
          </label>
          <label className="cm-field">
            <span>Checked in before</span>
            <input
              defaultValue={searchParams.get('checkedInBefore') ?? ''}
              name="checkedInBefore"
              type="datetime-local"
            />
          </label>
          <label className="cm-field">
            <span>Max points</span>
            <input
              defaultValue={searchParams.get('maxPoints') ?? '2500'}
              name="maxPoints"
              type="number"
              min={1}
              max={10000}
              step={100}
            />
          </label>
          <div className="cm-filter-actions">
            <button className="primary-button cm-action" type="submit">
              Apply
            </button>
            <button
              className="ghost-button cm-action"
              type="button"
              onClick={handleClearFilters}
              disabled={!filtersActive}
            >
              Clear
            </button>
          </div>
        </form>
      </details>

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
            address coordinate (<code>Data.Latitude</code> /{' '}
            <code>Data.Longitude</code>) from one VeriScan check-in — no
            external geocoder is in the loop. Scans without document address
            coords are skipped (visible as a smaller dot in the per-row mini
            map on <code>/admin/customers/check-ins</code>).
          </p>
          <p>
            Phase C4 v1 ships raw points. Grid aggregation, encoding panel,
            and timeline replay (phase C5) ship in follow-on slices. Map
            tiles courtesy of OpenStreetMap.
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
