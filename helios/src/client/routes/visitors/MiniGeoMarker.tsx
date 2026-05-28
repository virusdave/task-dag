// Tile-free per-row geo thumbnail for the /admin/visitors/scans list.
//
// FreshlyBakedNYC/automation#31, phase A4. Each row already has either
// a document-address lat/lng or a scan-location lat/lng — the server
// hands us the chosen one as `marker`. We render that as a single dot
// positioned inside a fixed NYC-metro bounding box on a small SVG
// canvas. No OSM tiles, no Leaflet bundle, no per-row HTTP requests
// — important because a 100-row list on a phone would otherwise fire
// 100 map-tile sessions on every page load.
//
// Wrapped in an `<a>` so a tap opens the customer details page in a
// new tab, where the full interactive Leaflet map ships in phase 2.

import type { VisitorScanMiniMarker } from '../../../shared/contracts/index.js'

// Loose bounding box covering the five boroughs + close suburbs where
// our two stores draw the bulk of their walk-ins. Out-of-bounds dots
// clamp to the edge (still visible) and the hover title carries the
// precise lat/lng for the few rows that matter.
const BOUNDS = {
  minLat: 40.35,
  maxLat: 41.05,
  minLng: -74.35,
  maxLng: -73.45,
} as const

const WIDTH = 64
const HEIGHT = 44

interface MiniGeoMarkerProps {
  marker: VisitorScanMiniMarker | null
  /** href the wrapping <a> points at; defaults to nothing (renders a span). */
  href?: string
  /** Prefix for the aria-label / title — typically the visitor name. */
  ariaLabelPrefix?: string
  className?: string
}

function project(lat: number, lng: number): { x: number; y: number; clamped: boolean } {
  const clampedLat = Math.max(BOUNDS.minLat, Math.min(BOUNDS.maxLat, lat))
  const clampedLng = Math.max(BOUNDS.minLng, Math.min(BOUNDS.maxLng, lng))
  const x =
    ((clampedLng - BOUNDS.minLng) / (BOUNDS.maxLng - BOUNDS.minLng)) * WIDTH
  // SVG origin is top-left; latitude grows northward (up), so invert.
  const y =
    HEIGHT - ((clampedLat - BOUNDS.minLat) / (BOUNDS.maxLat - BOUNDS.minLat)) * HEIGHT
  return { x, y, clamped: clampedLat !== lat || clampedLng !== lng }
}

function MarkerSvg({
  marker,
  ariaLabel,
}: {
  marker: VisitorScanMiniMarker | null
  ariaLabel: string
}): JSX.Element {
  return (
    <svg
      width={WIDTH}
      height={HEIGHT}
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      role="img"
      aria-label={ariaLabel}
      className="mini-geo-marker-svg"
    >
      {/* Background panel: more visible than a tile-faint hint. */}
      <rect
        x={0.5}
        y={0.5}
        width={WIDTH - 1}
        height={HEIGHT - 1}
        rx={4}
        ry={4}
        className="mini-geo-marker-bg"
      />
      {/* Crosshair to suggest a map without burning pixels on tiles. */}
      <line
        x1={0}
        y1={HEIGHT / 2}
        x2={WIDTH}
        y2={HEIGHT / 2}
        className="mini-geo-marker-grid"
      />
      <line
        x1={WIDTH / 2}
        y1={0}
        x2={WIDTH / 2}
        y2={HEIGHT}
        className="mini-geo-marker-grid"
      />
      {marker === null ? (
        <text
          x={WIDTH / 2}
          y={HEIGHT / 2 + 4}
          textAnchor="middle"
          className="mini-geo-marker-empty-text"
        >
          —
        </text>
      ) : (
        (() => {
          const { x, y, clamped } = project(marker.lat, marker.lng)
          const dotClass =
            marker.source === 'document_address'
              ? 'mini-geo-marker-dot is-document'
              : 'mini-geo-marker-dot is-scan'
          return (
            <>
              {/* Outer halo for visibility against any background. */}
              <circle cx={x} cy={y} r={7} className="mini-geo-marker-halo" />
              <circle cx={x} cy={y} r={5} className={dotClass} />
              <circle cx={x} cy={y} r={1.6} className="mini-geo-marker-dot-core" />
              {clamped ? (
                <text
                  x={WIDTH - 3}
                  y={HEIGHT - 3}
                  textAnchor="end"
                  className="mini-geo-marker-flag"
                >
                  ↗
                </text>
              ) : null}
            </>
          )
        })()
      )}
    </svg>
  )
}

export function MiniGeoMarker({
  marker,
  href,
  ariaLabelPrefix,
  className,
}: MiniGeoMarkerProps): JSX.Element {
  const classes = ['mini-geo-marker', className].filter(Boolean).join(' ')
  const subject = ariaLabelPrefix ?? 'visitor'
  const titleText =
    marker === null
      ? `${subject} — no coordinates on file`
      : `${subject} at ${marker.lat.toFixed(4)}, ${marker.lng.toFixed(4)} (${
          marker.source === 'document_address' ? 'document address' : 'scan location'
        }) — tap for full map`
  if (href !== undefined) {
    return (
      <a
        className={classes}
        href={href}
        target="_blank"
        rel="noreferrer"
        title={titleText}
        aria-label={titleText}
        onClick={(e) => e.stopPropagation()}
      >
        <MarkerSvg marker={marker} ariaLabel={titleText} />
      </a>
    )
  }
  return (
    <span className={classes} title={titleText} aria-label={titleText}>
      <MarkerSvg marker={marker} ariaLabel={titleText} />
    </span>
  )
}
