// Tile-free per-row geo thumbnail for the /admin/visitors/scans list.
//
// FreshlyBakedNYC/automation#31, phase A4. Each row already has either
// a document-address lat/lng or a scan-location lat/lng — the
// server selects one and hands it down as `miniMarker`. We render
// that as a single dot positioned inside a fixed NYC-metro bounding
// box on a small SVG canvas. No OSM tiles, no Leaflet bundle, no
// per-row HTTP requests — important because a 100-row list on a
// phone would otherwise fire 100 map-tile sessions on every page
// load.

import type { VisitorScanMiniMarker } from '../../../shared/contracts/index.js'

// Loose bounding box covering the five boroughs + the close suburbs
// where our two stores draw the bulk of their walk-ins. Out-of-bounds
// dots are clamped to the edge so a Connecticut or PA scan still
// renders something instead of disappearing — the title text shows
// the precise lat/lng on hover for the cases that matter.
const BOUNDS = {
  minLat: 40.35,
  maxLat: 41.05,
  minLng: -74.35,
  maxLng: -73.45,
} as const

interface MiniGeoMarkerProps {
  marker: VisitorScanMiniMarker | null
  className?: string
}

function project(lat: number, lng: number, w: number, h: number): { x: number; y: number } {
  const clampedLat = Math.max(BOUNDS.minLat, Math.min(BOUNDS.maxLat, lat))
  const clampedLng = Math.max(BOUNDS.minLng, Math.min(BOUNDS.maxLng, lng))
  // y is inverted because SVG origin is top-left and latitude grows
  // northward (up).
  const x = ((clampedLng - BOUNDS.minLng) / (BOUNDS.maxLng - BOUNDS.minLng)) * w
  const y = h - ((clampedLat - BOUNDS.minLat) / (BOUNDS.maxLat - BOUNDS.minLat)) * h
  return { x, y }
}

export function MiniGeoMarker({ marker, className }: MiniGeoMarkerProps): JSX.Element {
  const width = 56
  const height = 44
  const classes = ['mini-geo-marker', className].filter(Boolean).join(' ')
  if (marker === null) {
    return (
      <span className={classes} aria-label="No coordinates">
        <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img">
          <rect x={0} y={0} width={width} height={height} className="mini-geo-marker-bg" />
          <text
            x={width / 2}
            y={height / 2 + 4}
            textAnchor="middle"
            className="mini-geo-marker-empty-text"
          >
            —
          </text>
        </svg>
      </span>
    )
  }

  const { x, y } = project(marker.lat, marker.lng, width, height)
  const title = `${marker.lat.toFixed(4)}, ${marker.lng.toFixed(4)} (${marker.source === 'document_address' ? 'document address' : 'scan location'})`

  return (
    <span className={classes} aria-label={title} title={title}>
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img">
        <rect x={0} y={0} width={width} height={height} className="mini-geo-marker-bg" />
        {/* Faint hatch / grid to suggest a map without burning pixels. */}
        <line x1={0} y1={height / 2} x2={width} y2={height / 2} className="mini-geo-marker-grid" />
        <line x1={width / 2} y1={0} x2={width / 2} y2={height} className="mini-geo-marker-grid" />
        <circle
          cx={x}
          cy={y}
          r={5}
          className={
            marker.source === 'document_address'
              ? 'mini-geo-marker-dot is-document'
              : 'mini-geo-marker-dot is-scan'
          }
        />
        <circle cx={x} cy={y} r={1.5} className="mini-geo-marker-dot-core" />
      </svg>
    </span>
  )
}
