// Per-row geo thumbnail for the /admin/customers/check-ins list.
//
// FreshlyBakedNYC/automation#31 phase A4 +  follow-on: per-site
// neighborhood basemaps.
//
// Each row already has either a document-address lat/lng or a
// scan-location lat/lng — the server hands us the chosen one as
// `marker`. We render that as a single dot positioned inside the
// fixed ~2-mile-radius bbox of the SCANNER SITE that produced the
// row, on top of a single shared, fingerprinted PNG basemap for
// that site (`assets/nyc-{bx,mh}-mini-map.png`).
//
// One basemap per site means a phone loading 100 rows fetches at
// most TWO basemap files (one per site appearing in the list) —
// the per-row request storm is still off the table. Both PNG URLs
// are resolved once at module load.
//
// The basemap shows the store's neighborhood (the BX shop in the
// Bronx; the MH shop in midtown Manhattan). Markers that fall
// inside that ~2-mile bbox land on the right street — markers that
// fall outside (most cases, since customers come from across the
// metro area) clamp to the nearest edge and get a small `↗`
// directional flag so the operator can still tell "they're not
// local" vs. "this person lives around the corner".
//
// Wrapped in an `<a>` so a tap opens the customer details page,
// which renders the same data on a full-size MapLibre canvas.
//
// Regenerate the PNG assets with helios/scripts/make-mini-map.py
// (lists the bbox metadata it bakes in — keep the BOUNDS map below
// in lock-step with that script's RADIUS_MI + center coordinates).

import type { VisitorScanMiniMarker } from '../../../shared/contracts/index.js'

// ---------------------------------------------------------------------
// Per-site bbox + basemap. Numeric bbox values are the output of
// helios/scripts/make-mini-map.py (RADIUS_MI=2.25, centers from
// customersMapQueries.ts). Keep both files in sync.
// ---------------------------------------------------------------------

interface SiteBasemap {
  /** PNG URL (Vite-fingerprinted, cached after first row). */
  url: string
  /** Bbox the PNG was rendered to — same projection used to place dots. */
  bounds: {
    minLat: number
    maxLat: number
    minLng: number
    maxLng: number
  }
}

const SITE_BASEMAPS: Record<string, SiteBasemap> = {
  bx: {
    url: new URL('../../assets/nyc-bx-mini-map.png', import.meta.url).href,
    bounds: {
      minLat: 40.832412,
      maxLat: 40.897468,
      minLng: -73.927892,
      maxLng: -73.841868,
    },
  },
  mh: {
    url: new URL('../../assets/nyc-mh-mini-map.png', import.meta.url).href,
    bounds: {
      minLat: 40.729792,
      maxLat: 40.794848,
      minLng: -74.019556,
      maxLng: -73.933664,
    },
  },
}

// Fallback for any unknown future site — uses the larger of the two
// neighborhood basemaps' union (so the dot at least lands within a
// recognisable shape) and the bx asset for graphical content. Future
// sites should ship their own asset via make-mini-map.py.
const FALLBACK_BASEMAP: SiteBasemap = SITE_BASEMAPS.bx

// The SVG viewBox is square because both the underlying geographic
// bbox (~2-mile-radius around each site center) and the basemap PNG
// asset (480×480) are square. A square viewBox means the linear
// lat/lng → pixel projection produces undistorted positions, and
// `preserveAspectRatio="none"` only stretches uniformly when the
// rendered container is also square — which the CSS for the
// desktop thumbnail and the mobile card both enforce.
const WIDTH = 64
const HEIGHT = 64

interface MiniGeoMarkerProps {
  marker: VisitorScanMiniMarker | null
  /** Site slug that produced the scan (`bx` / `mh`). Drives basemap
   *  selection + the lat/lng→pixel projection. */
  siteSlug: string
  /** href the wrapping <a> points at; defaults to nothing (renders a span). */
  href?: string
  /** Prefix for the aria-label / title — typically the visitor name. */
  ariaLabelPrefix?: string
  className?: string
}

function project(
  lat: number,
  lng: number,
  bounds: SiteBasemap['bounds'],
): { x: number; y: number; clamped: boolean } {
  const clampedLat = Math.max(bounds.minLat, Math.min(bounds.maxLat, lat))
  const clampedLng = Math.max(bounds.minLng, Math.min(bounds.maxLng, lng))
  const x = ((clampedLng - bounds.minLng) / (bounds.maxLng - bounds.minLng)) * WIDTH
  // SVG origin is top-left; latitude grows northward (up), so invert.
  const y =
    HEIGHT - ((clampedLat - bounds.minLat) / (bounds.maxLat - bounds.minLat)) * HEIGHT
  return { x, y, clamped: clampedLat !== lat || clampedLng !== lng }
}

function MarkerSvg({
  marker,
  basemap,
  ariaLabel,
}: {
  marker: VisitorScanMiniMarker | null
  basemap: SiteBasemap
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
      preserveAspectRatio="none"
    >
      {/* Per-site basemap. preserveAspectRatio="none" on both the
          <svg> and <image> means the asset is stretched to fill the
          SVG canvas; the linear lat/lng → pixel projection used for
          the dot below uses the SAME bbox the asset was rendered to,
          so the dot lands in the right relative position regardless
          of any aspect-ratio squish from the canvas size. */}
      <image
        href={basemap.url}
        x={0}
        y={0}
        width={WIDTH}
        height={HEIGHT}
        preserveAspectRatio="none"
        className="mini-geo-marker-base"
      />
      <rect
        x={0.5}
        y={0.5}
        width={WIDTH - 1}
        height={HEIGHT - 1}
        rx={4}
        ry={4}
        className="mini-geo-marker-frame"
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
          const { x, y, clamped } = project(marker.lat, marker.lng, basemap.bounds)
          const dotClass =
            marker.source === 'document_address'
              ? 'mini-geo-marker-dot is-document'
              : 'mini-geo-marker-dot is-scan'
          return (
            <>
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
  siteSlug,
  href,
  ariaLabelPrefix,
  className,
}: MiniGeoMarkerProps): JSX.Element {
  const basemap = SITE_BASEMAPS[siteSlug] ?? FALLBACK_BASEMAP
  const classes = ['mini-geo-marker', `is-${siteSlug}`, className].filter(Boolean).join(' ')
  const subject = ariaLabelPrefix ?? 'visitor'
  const siteLabel = siteSlug === 'bx' ? 'Bronx' : siteSlug === 'mh' ? 'Midtown' : siteSlug
  const titleText =
    marker === null
      ? `${subject} (${siteLabel}) — no coordinates on file`
      : `${subject} (${siteLabel}) at ${marker.lat.toFixed(4)}, ${marker.lng.toFixed(4)} (${
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
        <MarkerSvg marker={marker} basemap={basemap} ariaLabel={titleText} />
      </a>
    )
  }
  return (
    <span className={classes} title={titleText} aria-label={titleText}>
      <MarkerSvg marker={marker} basemap={basemap} ariaLabel={titleText} />
    </span>
  )
}
