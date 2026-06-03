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
  CustomersMapEarliestResponseSchema,
  CustomersMapResponseSchema,
  type CustomersMapPoint,
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
        // Basemap-as-ground tuning. Dialed back toward the
        // original crisper rendering so borough outlines / arteries
        // read at a glance, while still keeping the dots as the
        // clear figure.
        'raster-opacity': 0.5,
        'raster-saturation': -0.88,
        'raster-contrast': -0.22,
        'raster-brightness-min': 0.18,
        'raster-brightness-max': 1,
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

// Wall-clock skip window during replay. The store is closed and no
// scans land between 3am and 7am local time, so we skip the cursor
// straight from 3:00 to 7:00 to avoid dead air. If the cursor falls
// inside `[3am, 7am)` (in the operator's local time), advance it to
// the next 7:00 on the same day. Caller still bounds the result by
// the replay window.
const REPLAY_QUIET_START_HOUR = 3
const REPLAY_QUIET_END_HOUR = 7

function skipReplayQuietHours(virtMs: number): number {
  const d = new Date(virtMs)
  const h = d.getHours()
  if (h >= REPLAY_QUIET_START_HOUR && h < REPLAY_QUIET_END_HOUR) {
    const jumped = new Date(d)
    jumped.setHours(REPLAY_QUIET_END_HOUR, 0, 0, 0)
    return jumped.getTime()
  }
  return virtMs
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

// Per-feature size multiplier (computed client-side by the
// encoding pipeline above and stuffed into each feature's
// `sizeMul` property). Coalesce to 1 so dots with no encoded
// value still render at base size.
const SIZE_MUL_EXPR: maplibregl.ExpressionSpecification = [
  'to-number',
  ['get', 'sizeMul'],
  1,
]

// MapLibre constraint: `['zoom']` may ONLY appear as input to a
// TOP-LEVEL `interpolate` or `step`. Wrapping `interpolate(zoom,...)`
// inside `['*', ...]` silently invalidates the entire paint property
// (the layer renders nothing). So instead of `radius = baseInterp *
// sizeMul * replayMul`, we push every per-feature multiplier INSIDE
// the interpolate's output values. The interpolate stays at the top.
//
// The stops below are the same numbers the previous BASE_RADIUS_EXPR
// used (2/3/4.5/6.5/9 across zooms 7/10/13/16/19). The helpers below
// scale each stop by per-feature `sizeMul` (always) and an optional
// replay grow-then-shrink factor.
const RADIUS_ZOOMS: readonly number[] = [7, 10, 13, 16, 19]
const RADIUS_STOPS: readonly number[] = [2, 3, 4.5, 6.5, 9]

// Static base-radius (no encoding, no replay) — kept for the
// legend reference dots only. The on-map layers use the helpers
// below so the `['zoom']` stays at the top of the expression.
const BASE_RADIUS_EXPR: maplibregl.ExpressionSpecification = [
  'interpolate',
  ['linear'],
  ['zoom'],
  RADIUS_ZOOMS[0]!, RADIUS_STOPS[0]!,
  RADIUS_ZOOMS[1]!, RADIUS_STOPS[1]!,
  RADIUS_ZOOMS[2]!, RADIUS_STOPS[2]!,
  RADIUS_ZOOMS[3]!, RADIUS_STOPS[3]!,
  RADIUS_ZOOMS[4]!, RADIUS_STOPS[4]!,
]

// Builds an `interpolate(['zoom'], ...)` whose per-stop output is
// `RADIUS_STOPS[i] * SIZE_MUL_EXPR * extra`. `extra` is e.g. the
// replay grow factor; pass undefined for plain "sized" radius.
function buildRadiusExpr(
  extra: maplibregl.ExpressionSpecification | null,
): maplibregl.ExpressionSpecification {
  const stops: unknown[] = []
  for (let i = 0; i < RADIUS_ZOOMS.length; i++) {
    stops.push(RADIUS_ZOOMS[i]!)
    const factors: unknown[] = ['*', RADIUS_STOPS[i]!, SIZE_MUL_EXPR]
    if (extra !== null) factors.push(extra)
    stops.push(factors as maplibregl.ExpressionSpecification)
  }
  return [
    'interpolate',
    ['linear'],
    ['zoom'],
    ...stops,
  ] as maplibregl.ExpressionSpecification
}

// Static layer radius: zoom-interp base × per-feature size mul.
// Replay multiplies this by the additional grow-then-shrink factor
// from replayRadiusExpr — also built so `['zoom']` stays top-level.
const SIZED_RADIUS_EXPR: maplibregl.ExpressionSpecification = buildRadiusExpr(null)

// Replay radius expression — same zoom-interpolated base, scaled
// by a per-dot "grow then settle" factor:
//
//   age < 0 (future)            → 0   (point hidden until cursor reaches it)
//   age in [0, lifetimeMs]      → 1.5 → 1.0 (linearly shrinks to base)
//   age > lifetimeMs (fully old) → 1.0 (steady — opacity is 0 anyway)
//
// The brief pop-then-shrink helps the operator catch new dots as
// they appear, particularly when dozens land per second on a busy
// shift; the dot is at 1× by the time it starts fading out.
function replayRadiusExpr(
  cursorMs: number,
  lifetimeMs: number,
): maplibregl.ExpressionSpecification {
  const fadeStart = cursorMs - lifetimeMs
  const multiplier: maplibregl.ExpressionSpecification = [
    'case',
    ['>', ['get', 'checkedInAtMs'], cursorMs], 0,
    ['<=', ['get', 'checkedInAtMs'], fadeStart], 1,
    [
      '+',
      1,
      [
        '*',
        0.5,
        ['-', 1, ['/', ['-', cursorMs, ['get', 'checkedInAtMs']], lifetimeMs]],
      ],
    ],
  ]
  // Per-zoom-stop output = baseStop × sizeMul × replayMultiplier.
  // Built so `['zoom']` stays at the top level of the interpolate;
  // wrapping the interpolate inside an outer `*` makes MapLibre
  // silently invalidate the entire paint property.
  return buildRadiusExpr(multiplier)
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
// Slider helpers — operate over an arbitrary range from the earliest
// scan in `visitor_scans` through "now". Two slider handles map to
// checkedInAfter / checkedInBefore. Tick count scales with the window
// width so per-tick resolution stays at roughly one hour regardless
// of how long the window is. The earliest-scan timestamp is fetched
// asynchronously by the page; until it arrives we use a 30-day
// fallback so the slider has *something* to render.
// ---------------------------------------------------------------------

// Per-tick hour granularity. Slider tick count = windowHours, capped
// at a hard ceiling so DOM-range step counts stay reasonable on
// multi-year windows.
const SLIDER_HOUR_TICK_MS = 60 * 60 * 1000
const SLIDER_MAX_TICKS = 20_000 // generous; 20k hours = ~2.3 years

interface SliderRange {
  /** Start of the slider window — earliest scan or a fallback. */
  windowStart: Date
  /** End of the slider window (= now, fixed at mount). */
  windowEnd: Date
  /** Total tick count for the underlying DOM range inputs. */
  ticks: number
}

function buildSliderRange(earliest: Date | null): SliderRange {
  // End: ceiling to next top-of-hour so a tick maps to a clean
  // wall-clock hour.
  const end = new Date()
  end.setMinutes(0, 0, 0)
  end.setHours(end.getHours() + 1)
  // Start: provided earliest (floored to top-of-hour) OR fall back
  // to "30 days ago" until the meta endpoint resolves.
  let start: Date
  if (earliest !== null) {
    start = new Date(earliest)
    start.setMinutes(0, 0, 0)
  } else {
    start = new Date(end.getTime() - 30 * 24 * 60 * 60 * 1000)
  }
  // Floor — don't ever let start get after end.
  if (start.getTime() >= end.getTime()) {
    start = new Date(end.getTime() - 60 * 60 * 1000)
  }
  const hours = Math.ceil((end.getTime() - start.getTime()) / SLIDER_HOUR_TICK_MS)
  const ticks = Math.max(1, Math.min(SLIDER_MAX_TICKS, hours))
  return { windowStart: start, windowEnd: end, ticks }
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
  return Math.round(Math.max(0, Math.min(1, ratio)) * win.ticks)
}

function tickToDate(tick: number, win: SliderRange): Date {
  const ratio = tick / win.ticks
  return new Date(
    win.windowStart.getTime() + ratio * (win.windowEnd.getTime() - win.windowStart.getTime()),
  )
}

// Display formatters below are pinned to **America/New_York** per
// the AGENTS.md canon rule ("Always use NY timezones for aggregate
// and display unless instructed otherwise"). Operators reason about
// every check-in / order in NY wall-clock; rendering in the
// browser's local timezone produced confusing 1- or 3-hour skews for
// anyone whose laptop wasn't set to ET.
const NY_TZ_LOCAL = 'America/New_York'

function formatTime(iso: string | null): string {
  if (iso === null) return '—'
  try {
    return new Date(iso).toLocaleString('en-US', { hour12: false, timeZone: NY_TZ_LOCAL })
  } catch {
    return iso
  }
}

function formatShortRange(after: Date, before: Date): string {
  // "Same day" must also be computed in NY wall-clock — otherwise a
  // shift that crosses NY midnight but stays on the same UTC day
  // (or vice versa) would render with the wrong layout.
  const fmtDay = (d: Date) =>
    d.toLocaleDateString('en-US', { timeZone: NY_TZ_LOCAL })
  const sameDay = fmtDay(after) === fmtDay(before)
  const dateOpts = { month: 'short', day: 'numeric', timeZone: NY_TZ_LOCAL } as const
  const timeOpts = { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: NY_TZ_LOCAL } as const
  if (sameDay) {
    return `${after.toLocaleDateString('en-US', dateOpts)} ` +
      `${after.toLocaleTimeString('en-US', timeOpts)} – ` +
      `${before.toLocaleTimeString('en-US', timeOpts)}`
  }
  const fullOpts = { ...dateOpts, ...timeOpts }
  return `${after.toLocaleString('en-US', fullOpts)} – ` +
    `${before.toLocaleString('en-US', fullOpts)}`
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
// Encoding axes (color / size) — mirrors the per-card encoding
// selectors on the catalog-analytics scatter plots.
//
// Per operator: stop hard-coding color on `siteSlug` (we typically
// view one site at a time anyway) and instead let the operator pick
// what each per-dot axis means. Opacity stays driven by the replay
// cursor's "check-in age" fade (see replay*OpacityExpr above).
//
// All encoding work is done client-side. We pre-compute `color`
// (hex string) and `sizeMul` (radius multiplier) into each GeoJSON
// feature's properties, and the MapLibre paint expressions just
// `['get', 'color']` / multiply BASE_RADIUS_EXPR by `['get',
// 'sizeMul']`. Much simpler than maintaining one expression tree
// per encoding, and trivial at 2.5–10k points.
//
// Caveats:
//   * lifetimeSpend / lifetimeOrderCount are NULL when the scan is
//     not CRM-linked → those dots fall into a neutral "no data"
//     swatch.
//   * lifetime metrics are "current lifetime as of right now", not
//     "as of scan time"; the legend says so.
// ---------------------------------------------------------------------

type ColorByKey =
  | 'visitType'
  | 'site'
  | 'gender'
  | 'ageYears'
  | 'lifetimeSpend'
  | 'lifetimeVisits'
  | 'lifetimeOrders'

const COLOR_BY_KEYS: readonly ColorByKey[] = [
  'visitType',
  'site',
  'gender',
  'ageYears',
  'lifetimeSpend',
  'lifetimeVisits',
  'lifetimeOrders',
]

function isColorByKey(value: string): value is ColorByKey {
  return (COLOR_BY_KEYS as readonly string[]).includes(value)
}

type SizeByKey =
  | 'uniform'
  | 'lifetimeSpend'
  | 'lifetimeVisits'
  | 'lifetimeOrders'
  | 'ageYears'

const SIZE_BY_KEYS: readonly SizeByKey[] = [
  'uniform',
  'lifetimeSpend',
  'lifetimeVisits',
  'lifetimeOrders',
  'ageYears',
]

function isSizeByKey(value: string): value is SizeByKey {
  return (SIZE_BY_KEYS as readonly string[]).includes(value)
}

interface CategoricalBucket {
  /** Stable string key for the bucket (e.g. 'first', 'M', 'bx'). */
  readonly key: string
  /** Human-readable legend label. */
  readonly label: string
  /** Base color before per-dot saturation modulation. */
  readonly color: string
}

interface CategoricalColorByDef {
  readonly kind: 'categorical'
  readonly id: ColorByKey
  readonly label: string
  readonly buckets: ReadonlyArray<CategoricalBucket>
  /** Returns the bucket key for a given point, or null for "no data". */
  readonly bucketFor: (p: CustomersMapPoint) => string | null
  /** Color for points whose value doesn't match any bucket. */
  readonly nullColor: string
  readonly nullLabel: string
}

interface ContinuousColorByDef {
  readonly kind: 'continuous'
  readonly id: ColorByKey
  readonly label: string
  /** Numeric value or null when missing. */
  readonly value: (p: CustomersMapPoint) => number | null
  /** Formatter for legend min/max labels. */
  readonly format: (n: number) => string
  /** Color for null-value points. */
  readonly nullColor: string
  readonly nullLabel: string
}

type ColorByDef = CategoricalColorByDef | ContinuousColorByDef

// Categorical palettes. Picked for legibility on the ghosted
// basemap; first-time scans land on the brand-orange so the
// saturation boost (see modulateColor below) makes them really pop.
const NULL_COLOR = '#9a9a9a'

const COLOR_BY_DEFS: ReadonlyArray<ColorByDef> = [
  {
    kind: 'categorical',
    id: 'visitType',
    label: 'Visit type (first / returning)',
    buckets: [
      { key: 'first', label: 'First-time', color: '#f25c1c' },
      { key: 'returning', label: 'Returning', color: '#0d47ff' },
      { key: 'unknown', label: 'Unknown (no person key)', color: NULL_COLOR },
    ],
    bucketFor: (p) => p.visitType,
    nullColor: NULL_COLOR,
    nullLabel: 'No data',
  },
  {
    kind: 'categorical',
    id: 'site',
    label: 'Site (Bronx / Midtown)',
    buckets: [
      { key: 'bx', label: 'Bronx (bx)', color: '#0d47ff' },
      { key: 'mh', label: 'Midtown (mh)', color: '#f25c1c' },
    ],
    bucketFor: (p) => p.siteSlug,
    nullColor: NULL_COLOR,
    nullLabel: 'Other',
  },
  {
    kind: 'categorical',
    id: 'gender',
    label: 'Sex (ID-document marker)',
    buckets: [
      { key: 'M', label: 'Male (M)', color: '#1c6ef2' },
      { key: 'F', label: 'Female (F)', color: '#e84a78' },
      { key: 'X', label: 'X / non-binary', color: '#6c5ce7' },
    ],
    bucketFor: (p) => {
      if (p.gender === null) return null
      const g = p.gender.trim().toUpperCase()
      if (g === 'M' || g === 'F' || g === 'X') return g
      return null
    },
    nullColor: NULL_COLOR,
    nullLabel: 'Missing / other',
  },
  {
    kind: 'continuous',
    id: 'ageYears',
    label: 'Age at scan',
    value: (p) => (p.ageYears === null ? null : p.ageYears),
    format: (n) => `${Math.round(n)}y`,
    nullColor: NULL_COLOR,
    nullLabel: 'Unknown age',
  },
  {
    kind: 'continuous',
    id: 'lifetimeSpend',
    label: 'Lifetime spend $ (current, CRM-linked only)',
    value: (p) => p.lifetimeSpendDollars,
    format: (n) =>
      n >= 1000
        ? `$${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k`
        : `$${Math.round(n)}`,
    nullColor: NULL_COLOR,
    nullLabel: 'Not linked',
  },
  {
    kind: 'continuous',
    id: 'lifetimeVisits',
    label: 'Lifetime visits (all-time scans)',
    value: (p) => p.lifetimeVisitCount,
    format: (n) => `${Math.round(n)}`,
    nullColor: NULL_COLOR,
    nullLabel: 'Unknown',
  },
  {
    kind: 'continuous',
    id: 'lifetimeOrders',
    label: 'Lifetime order count (CRM-linked only)',
    value: (p) => p.lifetimeOrderCount,
    format: (n) => `${Math.round(n)}`,
    nullColor: NULL_COLOR,
    nullLabel: 'Not linked',
  },
]

const COLOR_BY_BY_ID = new Map(COLOR_BY_DEFS.map((d) => [d.id, d] as const))

function colorByDef(id: ColorByKey): ColorByDef {
  return COLOR_BY_BY_ID.get(id) ?? COLOR_BY_DEFS[0]!
}

interface SizeByDef {
  readonly id: SizeByKey
  readonly label: string
  /** Numeric value or null when missing. `null` for `uniform`. */
  readonly value: (p: CustomersMapPoint) => number | null
  /** Formatter for legend reference dots. */
  readonly format?: (n: number) => string
}

const SIZE_BY_DEFS: ReadonlyArray<SizeByDef> = [
  { id: 'uniform', label: 'Uniform', value: () => null },
  {
    id: 'lifetimeSpend',
    label: 'Lifetime spend $',
    value: (p) => p.lifetimeSpendDollars,
    format: (n) =>
      n >= 1000
        ? `$${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k`
        : `$${Math.round(n)}`,
  },
  {
    id: 'lifetimeVisits',
    label: 'Lifetime visits',
    value: (p) => p.lifetimeVisitCount,
    format: (n) => `${Math.round(n)}`,
  },
  {
    id: 'lifetimeOrders',
    label: 'Lifetime orders',
    value: (p) => p.lifetimeOrderCount,
    format: (n) => `${Math.round(n)}`,
  },
  {
    id: 'ageYears',
    label: 'Age',
    value: (p) => p.ageYears,
    format: (n) => `${Math.round(n)}y`,
  },
]

const SIZE_BY_BY_ID = new Map(SIZE_BY_DEFS.map((d) => [d.id, d] as const))

function sizeByDef(id: SizeByKey): SizeByDef {
  return SIZE_BY_BY_ID.get(id) ?? SIZE_BY_DEFS[0]!
}

// 5-stop viridis-ish ramp for continuous color scales. Bottom is
// dark purple, top is yellow — accessibility-friendly and reads
// well against the desaturated basemap.
const CONTINUOUS_PALETTE: readonly string[] = [
  '#440154',
  '#3b528b',
  '#21918c',
  '#5ec962',
  '#fde725',
]

function rampColor(t: number): string {
  if (!Number.isFinite(t)) return NULL_COLOR
  const clamped = Math.max(0, Math.min(1, t))
  const last = CONTINUOUS_PALETTE.length - 1
  const idx = clamped * last
  const lo = Math.floor(idx)
  const hi = Math.min(last, lo + 1)
  const f = idx - lo
  return mixHex(CONTINUOUS_PALETTE[lo]!, CONTINUOUS_PALETTE[hi]!, f)
}

// --- color math (hex <-> rgb <-> hsl) ---

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const h = hex.replace('#', '')
  const full =
    h.length === 3
      ? h.split('').map((c) => c + c).join('')
      : h.padEnd(6, '0').slice(0, 6)
  return {
    r: parseInt(full.slice(0, 2), 16),
    g: parseInt(full.slice(2, 4), 16),
    b: parseInt(full.slice(4, 6), 16),
  }
}
function rgbToHex(r: number, g: number, b: number): string {
  const clamp = (n: number): number => Math.max(0, Math.min(255, Math.round(n)))
  const hex = (n: number): string => clamp(n).toString(16).padStart(2, '0')
  return `#${hex(r)}${hex(g)}${hex(b)}`
}
function mixHex(a: string, b: string, t: number): string {
  const ra = hexToRgb(a)
  const rb = hexToRgb(b)
  return rgbToHex(
    ra.r + (rb.r - ra.r) * t,
    ra.g + (rb.g - ra.g) * t,
    ra.b + (rb.b - ra.b) * t,
  )
}

function rgbToHsl(
  r: number,
  g: number,
  b: number,
): { h: number; s: number; l: number } {
  const rN = r / 255, gN = g / 255, bN = b / 255
  const max = Math.max(rN, gN, bN), min = Math.min(rN, gN, bN)
  const l = (max + min) / 2
  let h = 0, s = 0
  if (max !== min) {
    const d = max - min
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
    switch (max) {
      case rN: h = ((gN - bN) / d + (gN < bN ? 6 : 0)); break
      case gN: h = ((bN - rN) / d + 2); break
      case bN: h = ((rN - gN) / d + 4); break
    }
    h /= 6
  }
  return { h, s, l }
}
function hslToRgb(
  h: number,
  s: number,
  l: number,
): { r: number; g: number; b: number } {
  if (s === 0) {
    const v = l * 255
    return { r: v, g: v, b: v }
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s
  const p = 2 * l - q
  const hue2rgb = (t: number): number => {
    if (t < 0) t += 1
    if (t > 1) t -= 1
    if (t < 1 / 6) return p + (q - p) * 6 * t
    if (t < 1 / 2) return q
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6
    return p
  }
  return {
    r: hue2rgb(h + 1 / 3) * 255,
    g: hue2rgb(h) * 255,
    b: hue2rgb(h - 1 / 3) * 255,
  }
}

// First-time scans stay at full saturation; returning visitors
// drop to ~half saturation and shift slightly lighter so they
// recede visually. Unknown sits in the middle. Applied AFTER the
// color encoding pick so every colorBy mode benefits from the
// distinction.
// SAT_FACTOR_FIRST is intentionally documented as 1.0 (full
// saturation, no change) — the function short-circuits before
// referencing it because hex→hsl→hex on the same color is lossy
// at the byte level.
const SAT_FACTOR_RETURNING = 0.5
const SAT_FACTOR_UNKNOWN = 0.75
const LIGHTNESS_BOOST_RETURNING = 0.12

function modulateSaturation(hex: string, visitType: 'first' | 'returning' | 'unknown'): string {
  // First-time scans keep the encoding's full vibrancy so they
  // pop against the muted returning/unknown dots — that visual
  // distinction is the whole point of this modulation.
  if (visitType === 'first') return hex
  const { r, g, b } = hexToRgb(hex)
  const { h, s, l } = rgbToHsl(r, g, b)
  const satFactor = visitType === 'returning' ? SAT_FACTOR_RETURNING : SAT_FACTOR_UNKNOWN
  const lAdd = visitType === 'returning' ? LIGHTNESS_BOOST_RETURNING : 0
  const newS = Math.max(0, Math.min(1, s * satFactor))
  const newL = Math.max(0, Math.min(0.9, l + lAdd))
  const out = hslToRgb(h, newS, newL)
  return rgbToHex(out.r, out.g, out.b)
}

// Size scaling: sqrt-stretch numeric values into a bounded radius
// multiplier range so one whale customer doesn't blow up the map.
// Returns `1` for `uniform` mode and for points where the value is
// null (we treat "no data" as average size, not invisibly small).
const SIZE_MUL_MIN = 0.7
const SIZE_MUL_MAX = 2.6
const SIZE_MUL_NULL = 1.0

function computeSizeMul(
  value: number | null,
  domain: { min: number; max: number } | null,
): number {
  if (value === null || domain === null) return SIZE_MUL_NULL
  if (!Number.isFinite(value)) return SIZE_MUL_NULL
  if (domain.max <= domain.min) return SIZE_MUL_NULL
  const t = Math.max(0, Math.min(1, (value - domain.min) / (domain.max - domain.min)))
  // sqrt to soften the upper end; visual weight is area, not linear.
  const stretched = Math.sqrt(t)
  return SIZE_MUL_MIN + stretched * (SIZE_MUL_MAX - SIZE_MUL_MIN)
}

interface ContinuousDomain {
  min: number
  max: number
  /** 5th / 95th percentile so outliers don't crush the visible range. */
  p05: number
  p95: number
}

function computeDomain(values: ReadonlyArray<number>): ContinuousDomain | null {
  const finite = values.filter((v) => Number.isFinite(v))
  if (finite.length === 0) return null
  const sorted = [...finite].sort((a, b) => a - b)
  const at = (frac: number): number => {
    const idx = Math.max(0, Math.min(sorted.length - 1, Math.floor(frac * (sorted.length - 1))))
    return sorted[idx]!
  }
  return {
    min: sorted[0]!,
    max: sorted[sorted.length - 1]!,
    p05: at(0.05),
    p95: at(0.95),
  }
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
  // The outer wrap is what we hand to MapLibre's FullscreenControl
  // so that absolutely-positioned overlays inside it (the floating
  // replay pill) are part of the fullscreen view. If we let
  // FullscreenControl default to fullscreening just the map's own
  // container, our overlay sits OUTSIDE the fullscreen element and
  // disappears the moment the operator hits ⛶.
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const mapRef = useRef<maplibregl.Map | null>(null)
  const popupRef = useRef<maplibregl.Popup | null>(null)

  // ---------------- Encoding-axis selectors (color / size) ----------
  // URL-driven so a deep-link captures the operator's chosen view.
  const colorByRaw = searchParams.get('colorBy') ?? ''
  const sizeByRaw = searchParams.get('sizeBy') ?? ''
  const colorByKey: ColorByKey = isColorByKey(colorByRaw) ? colorByRaw : 'visitType'
  const sizeByKey: SizeByKey = isSizeByKey(sizeByRaw) ? sizeByRaw : 'uniform'
  const colorDef = colorByDef(colorByKey)
  const sizeDef = sizeByDef(sizeByKey)

  // Continuous color/size domains computed off the current data
  // batch — clipped to 5th/95th percentile so a single outlier
  // doesn't crush the legible range. (Categorical color has no
  // domain to compute.)
  const colorDomain = useMemo<ContinuousDomain | null>(() => {
    if (colorDef.kind !== 'continuous') return null
    const values: number[] = []
    for (const p of data.points) {
      const v = colorDef.value(p)
      if (v !== null && Number.isFinite(v)) values.push(v)
    }
    return computeDomain(values)
  }, [data.points, colorDef])

  const sizeDomain = useMemo<ContinuousDomain | null>(() => {
    if (sizeDef.id === 'uniform') return null
    const values: number[] = []
    for (const p of data.points) {
      const v = sizeDef.value(p)
      if (v !== null && Number.isFinite(v)) values.push(v)
    }
    return computeDomain(values)
  }, [data.points, sizeDef])

  // Per-point color resolver: pick the encoded color, then apply the
  // first-time saturation boost (returning + unknown desaturated).
  const colorForPoint = useCallback(
    (p: CustomersMapPoint): string => {
      let base: string
      if (colorDef.kind === 'categorical') {
        const k = colorDef.bucketFor(p)
        const match = k === null ? null : colorDef.buckets.find((b) => b.key === k)
        base = match?.color ?? colorDef.nullColor
      } else {
        const v = colorDef.value(p)
        if (v === null || colorDomain === null || !Number.isFinite(v)) {
          base = colorDef.nullColor
        } else {
          // Use p05/p95 as the visible range so outliers don't
          // collapse the gradient onto a single color.
          const lo = colorDomain.p05
          const hi = colorDomain.p95
          const span = hi - lo
          const t = span <= 0 ? 0.5 : Math.max(0, Math.min(1, (v - lo) / span))
          base = rampColor(t)
        }
      }
      return modulateSaturation(base, p.visitType)
    },
    [colorDef, colorDomain],
  )

  // Per-point size resolver: read raw value through the chosen
  // size-by def, then sqrt-stretch over the p05/p95 range so whales
  // don't dominate. Uniform mode returns 1.
  const sizeForPoint = useCallback(
    (p: CustomersMapPoint): number => {
      if (sizeDef.id === 'uniform' || sizeDomain === null) return SIZE_MUL_NULL
      const v = sizeDef.value(p)
      return computeSizeMul(v, { min: sizeDomain.p05, max: sizeDomain.p95 })
    },
    [sizeDef, sizeDomain],
  )

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
            visitType: p.visitType,
            ageYears: p.ageYears,
            gender: p.gender,
            lifetimeVisitCount: p.lifetimeVisitCount,
            lifetimeSpendDollars: p.lifetimeSpendDollars,
            lifetimeOrderCount: p.lifetimeOrderCount,
            // Per-feature encoded color (after saturation modulation)
            // and size multiplier. Both read by MapLibre paint
            // expressions via `['get', ...]`.
            color: colorForPoint(p),
            sizeMul: sizeForPoint(p),
          },
        }
      }),
    }),
    [data.points, colorForPoint, sizeForPoint],
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
      // Pass `container: wrapRef.current` so the FullscreenControl
      // fullscreens our wrap div (and therefore includes the floating
      // replay pill overlay), not just the map's own container.
      mapInstance.addControl(
        new maplibre.FullscreenControl({
          container: wrapRef.current ?? undefined,
        }),
        'top-right',
      )
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
          layout: {
            // Newer dots render on top of older ones — both in the
            // static view and during replay, where this guarantees
            // the just-appeared (bigger, brighter) dot sits over
            // the fading older ones.
            'circle-sort-key': ['get', 'checkedInAtMs'],
          },
          paint: {
            // Small-ish dots — the city-wide view still needs to
            // hold thousands of scans without blobbing into a solid
            // mass, but the previous pass shrank them to the point
            // of disappearing against the basemap. With the basemap
            // now ghosted to a near-white background, these radii
            // pop clearly while still revealing density via the
            // per-scan jitter (~400 ft).
            //
            // Radius = zoom-interp base × per-feature size mul (from
            // the encoding pipeline above). Color is also per-feature
            // (computed client-side from the chosen colorBy and then
            // saturation-modulated by visit type so first-timers pop
            // brighter than returning visitors).
            'circle-radius': SIZED_RADIUS_EXPR,
            'circle-color': [
              'coalesce',
              ['get', 'color'],
              '#9a9a9a',
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
          // Encoding-axis values shown in the popup so reviewers can
          // map "this dot" back to the dimension(s) currently colored
          // / sized. Null-safe — empty values just collapse.
          const visitTypeRaw = String(props.visitType ?? '')
          const visitTypeLabel =
            visitTypeRaw === 'first'
              ? 'First-time'
              : visitTypeRaw === 'returning'
                ? 'Returning'
                : visitTypeRaw === 'unknown'
                  ? 'Visit type unknown'
                  : ''
          const ageRaw = props.ageYears
          const ageLabel =
            ageRaw === null || ageRaw === undefined || ageRaw === '' ? '' : `${ageRaw}y`
          const gender = props.gender ?? ''
          const lifetimeVisits = props.lifetimeVisitCount ?? ''
          const lifetimeSpendRaw = props.lifetimeSpendDollars
          const lifetimeOrdersRaw = props.lifetimeOrderCount
          const spendLabel =
            lifetimeSpendRaw === null || lifetimeSpendRaw === undefined || lifetimeSpendRaw === ''
              ? ''
              : `$${Number(lifetimeSpendRaw).toLocaleString(undefined, { maximumFractionDigits: 0 })} lifetime`
          const ordersLabel =
            lifetimeOrdersRaw === null || lifetimeOrdersRaw === undefined || lifetimeOrdersRaw === ''
              ? ''
              : `${lifetimeOrdersRaw} orders`
          const lifetimeCells = [spendLabel, ordersLabel].filter(Boolean).join(' · ')
          const demoCells = [visitTypeLabel, ageLabel, gender ? `sex ${gender}` : '']
            .filter(Boolean)
            .join(' · ')
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
              ${demoCells ? `<div class="cm-popup-demo">${escapeHtml(demoCells)}</div>` : ''}
              ${
                lifetimeCells
                  ? `<div class="cm-popup-lifetime">${escapeHtml(lifetimeCells)} · ${escapeHtml(String(lifetimeVisits))} scans</div>`
                  : `<div class="cm-popup-lifetime">${escapeHtml(String(lifetimeVisits))} scans (not CRM-linked)</div>`
              }
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
  // Earliest-scan timestamp drives the slider's left edge. Fetched
  // once on mount; until it resolves we use a 30-day fallback. The
  // slider window is rebuilt whenever earliest changes so the operator
  // can scroll all the way back to the first record.
  const [earliestCheckedInAt, setEarliestCheckedInAt] = useState<Date | null>(null)
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const meta = await loadJson(
          '/api/admin/customers/map/earliest',
          CustomersMapEarliestResponseSchema,
        )
        if (!cancelled && meta.earliestCheckedInAt !== null) {
          const t = new Date(meta.earliestCheckedInAt)
          if (Number.isFinite(t.getTime())) setEarliestCheckedInAt(t)
        }
      } catch {
        // best-effort; fall back to the 30-day window.
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const sliderWindow = useMemo(
    () => buildSliderRange(earliestCheckedInAt),
    [earliestCheckedInAt],
  )

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
        // Skip 3am–7am (operator's local time) entirely during
        // replay — there's effectively no scan activity in those
        // hours, so dwelling there is just dead air. Jump the cursor
        // forward to the next 7am whenever it lands inside the
        // skip window.
        const skipped = skipReplayQuietHours(prev + elapsedReal * ratio)
        const next = skipped
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
        // During replay the radius is also data-driven so dots
        // appear 50% larger and shrink to base over their lifetime
        // (see replayRadiusExpr for the multiplier shape). Both the
        // replay multiplier and the static fallback honor the
        // per-feature `sizeMul` (the encoding size axis).
        const radius = replayPausing
          ? SIZED_RADIUS_EXPR
          : replayRadiusExpr(replayCursorMs, replayLifetimeMs)
        map!.setPaintProperty('scans-circles', 'circle-opacity', fill)
        map!.setPaintProperty('scans-circles', 'circle-stroke-opacity', stroke)
        map!.setPaintProperty('scans-circles', 'circle-radius', radius)
      } else {
        map!.setPaintProperty('scans-circles', 'circle-opacity', BASE_FILL_OPACITY)
        map!.setPaintProperty(
          'scans-circles',
          'circle-stroke-opacity',
          BASE_STROKE_OPACITY,
        )
        map!.setPaintProperty('scans-circles', 'circle-radius', SIZED_RADIUS_EXPR)
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
            One dot per VeriScan check-in with a geocoded home address.
            Color and size encode whichever dimension you pick below;{' '}
            <strong>first-time scans render at full saturation</strong> so
            new customers stand out from returning ones. Drag the time
            range below to update the map live.
          </p>
        </div>
        <div className="cm-stats">
          <Pill tone="muted">{`${data.points.length.toLocaleString()} shown`}</Pill>
          {data.clipped ? (
            <Pill tone="warning">{`${data.totalMatching.toLocaleString()} total — narrow filter`}</Pill>
          ) : null}
          {data.unknownCount > 0 ? (
            <span
              title="Scans matching the current filter that have no usable home geocode yet — not plotted (we no longer fall back to the store location). The visitor-scan address-enrichment worker will resolve these in the background."
            >
              <Pill tone="muted">
                {`Unknown: ${data.unknownCount.toLocaleString()}`}
              </Pill>
            </span>
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

        {/* Encoding-axis selectors: what does color / size MEAN?
            URL-driven so a deep-link captures the chosen view. */}
        <div className="cm-controls-row cm-encoding-row">
          <label className="cm-field cm-field-inline" title={colorDef.label}>
            <span>Color by</span>
            <select
              value={colorByKey}
              onChange={(e) => setParam('colorBy', e.target.value)}
            >
              {COLOR_BY_DEFS.map((d) => (
                <option key={d.id} value={d.id} title={d.label}>
                  {d.label}
                </option>
              ))}
            </select>
          </label>
          <label className="cm-field cm-field-inline" title={sizeDef.label}>
            <span>Size by</span>
            <select
              value={sizeByKey}
              onChange={(e) => setParam('sizeBy', e.target.value)}
            >
              {SIZE_BY_DEFS.map((d) => (
                <option key={d.id} value={d.id} title={d.label}>
                  {d.label}
                </option>
              ))}
            </select>
          </label>
          <span className="cm-encoding-hint subtle-copy">
            First-time scans are full saturation; returning visitors are
            muted. Opacity fades by check-in age during replay.
          </span>
        </div>

        {/* Legend row — categorical swatches or a continuous gradient
            depending on the chosen color encoding, plus a size-by
            reference dot strip when size encoding is active. */}
        <ColorLegend def={colorDef} domain={colorDomain} />
        {sizeDef.id !== 'uniform' ? (
          <SizeLegend def={sizeDef} domain={sizeDomain} />
        ) : null}

        <div className="cm-range">
          <div className="cm-range-labels">
            <span className="cm-range-label">
              <strong>{rangeLabel}</strong>
            </span>
            <span className="cm-range-sub subtle-copy">
              window: {sliderWindow.windowStart.toLocaleDateString('en-US', { timeZone: NY_TZ_LOCAL })} →{' '}
              {sliderWindow.windowEnd.toLocaleDateString('en-US', { timeZone: NY_TZ_LOCAL })}
            </span>
          </div>
          <div className="cm-range-sliders">
            <input
              type="range"
              min={0}
              max={sliderWindow.ticks}
              step={1}
              value={sliderAfterTick}
              onChange={(e) => handleAfterChange(Number(e.target.value))}
              aria-label="Range start"
              className="cm-range-input cm-range-input-low"
            />
            <input
              type="range"
              min={0}
              max={sliderWindow.ticks}
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
                  left: `${(Math.min(sliderAfterTick, sliderBeforeTick) / sliderWindow.ticks) * 100}%`,
                  width: `${(Math.abs(sliderBeforeTick - sliderAfterTick) / sliderWindow.ticks) * 100}%`,
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

      <div className="cm-map-wrap" ref={wrapRef}>
        <div ref={containerRef} className="cm-map" />
        <ReplayPill
          playing={replayPlaying}
          onToggle={handleReplayToggle}
          cursorMs={replayCursorMs}
          wrapRef={wrapRef}
        />
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

// ---------------------------------------------------------------------
// Encoding legend components — categorical swatches or continuous
// gradient (color) + reference-dot strip (size). Live just under the
// encoding selectors so the operator can ground what the dots mean
// without leaving the map.
// ---------------------------------------------------------------------

interface ColorLegendProps {
  def: ColorByDef
  domain: ContinuousDomain | null
}

function ColorLegend({ def, domain }: ColorLegendProps): JSX.Element | null {
  if (def.kind === 'categorical') {
    const items = [
      ...def.buckets,
      { key: '__null__', label: def.nullLabel, color: def.nullColor },
    ]
    return (
      <div className="cm-legend cm-legend-categorical">
        <span className="cm-legend-title subtle-copy">Color:</span>
        {items.map((b) => (
          <span key={b.key} className="cm-legend-item" title={b.label}>
            <span
              className="cm-legend-swatch"
              style={{ background: b.color }}
              aria-hidden="true"
            />
            <span className="cm-legend-label">{b.label}</span>
          </span>
        ))}
      </div>
    )
  }
  // Continuous: gradient strip + min/max labels.
  if (domain === null) {
    return (
      <div className="cm-legend cm-legend-continuous">
        <span className="cm-legend-title subtle-copy">Color:</span>
        <span className="cm-legend-label">
          {def.label} — no data in current window
        </span>
      </div>
    )
  }
  const gradient = `linear-gradient(to right, ${CONTINUOUS_PALETTE.join(', ')})`
  return (
    <div className="cm-legend cm-legend-continuous">
      <span className="cm-legend-title subtle-copy">Color:</span>
      <span className="cm-legend-label">{def.label}</span>
      <span className="cm-legend-gradient-wrap">
        <span className="cm-legend-tick">{def.format(domain.p05)}</span>
        <span
          className="cm-legend-gradient"
          style={{ background: gradient }}
          aria-hidden="true"
        />
        <span className="cm-legend-tick">{def.format(domain.p95)}</span>
      </span>
      <span className="cm-legend-item" title={def.nullLabel}>
        <span
          className="cm-legend-swatch"
          style={{ background: def.nullColor }}
          aria-hidden="true"
        />
        <span className="cm-legend-label">{def.nullLabel}</span>
      </span>
    </div>
  )
}

interface SizeLegendProps {
  def: SizeByDef
  domain: ContinuousDomain | null
}

function SizeLegend({ def, domain }: SizeLegendProps): JSX.Element | null {
  if (domain === null) {
    return (
      <div className="cm-legend cm-legend-size">
        <span className="cm-legend-title subtle-copy">Size:</span>
        <span className="cm-legend-label">
          {def.label} — no data in current window
        </span>
      </div>
    )
  }
  // Three reference dots at p05 / median / p95 of the visible range.
  const stops: ReadonlyArray<{ value: number; mul: number }> = [
    { value: domain.p05, mul: computeSizeMul(domain.p05, { min: domain.p05, max: domain.p95 }) },
    {
      value: (domain.p05 + domain.p95) / 2,
      mul: computeSizeMul((domain.p05 + domain.p95) / 2, { min: domain.p05, max: domain.p95 }),
    },
    { value: domain.p95, mul: computeSizeMul(domain.p95, { min: domain.p05, max: domain.p95 }) },
  ]
  // Base radius at mid-zoom (≈ z11 → ~3.5px) so the legend dots
  // have a sensible reference size. Scale by sizeMul.
  const baseRadius = 5
  const fmt = def.format ?? ((n: number) => `${Math.round(n)}`)
  return (
    <div className="cm-legend cm-legend-size">
      <span className="cm-legend-title subtle-copy">Size:</span>
      <span className="cm-legend-label">{def.label}</span>
      {stops.map((s, i) => {
        const px = Math.max(4, Math.round(baseRadius * s.mul * 2))
        return (
          <span key={i} className="cm-legend-size-item">
            <span
              className="cm-legend-size-dot"
              style={{ width: `${px}px`, height: `${px}px` }}
              aria-hidden="true"
            />
            <span className="cm-legend-tick">{fmt(s.value)}</span>
          </span>
        )
      })}
    </div>
  )
}

// ---------------------------------------------------------------------
// Floating, draggable always-visible replay control pill.
//
// Lives inside the `.cm-map-wrap` element (which is also what we
// hand to MapLibre's FullscreenControl), so it stays visible AND
// usable when the operator pops the map fullscreen — at which point
// the bottom-of-page replay control row is completely off-screen.
//
// Minimum content: play/pause button + current playback timestamp.
// Drag handle = the pill itself; we save the position as
// percentage-of-wrap so a fullscreen-vs-windowed swap still keeps
// the pill in the right relative spot.
//
// The pill is intentionally NON-essential in the windowed view (the
// full replay control row below the map already covers everything),
// but it makes fullscreen replay actually controllable.
// ---------------------------------------------------------------------

interface ReplayPillProps {
  playing: boolean
  cursorMs: number
  onToggle: () => void
  wrapRef: React.RefObject<HTMLDivElement | null>
}

function ReplayPill({ playing, cursorMs, onToggle, wrapRef }: ReplayPillProps): JSX.Element {
  // Position is percent-of-wrap so the pill stays at the same
  // relative spot when the wrap resizes (fullscreen toggle).
  // Default lower-left so it doesn't fight MapLibre's top-right
  // control stack or the bottom-right attribution.
  const [posPct, setPosPct] = useState<{ leftPct: number; topPct: number }>(
    () => ({ leftPct: 2, topPct: 88 }),
  )
  const dragRef = useRef<{
    startX: number
    startY: number
    startLeftPct: number
    startTopPct: number
    moved: boolean
  } | null>(null)

  function onPointerDown(e: React.PointerEvent<HTMLDivElement>): void {
    // Drag from the pill background, but let the inner play/pause
    // button receive its own click. Buttons stopPropagation below.
    const wrap = wrapRef.current
    if (wrap === null) return
    const wrapRect = wrap.getBoundingClientRect()
    if (wrapRect.width === 0 || wrapRect.height === 0) return
    dragRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      startLeftPct: posPct.leftPct,
      startTopPct: posPct.topPct,
      moved: false,
    }
    ;(e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId)
  }
  function onPointerMove(e: React.PointerEvent<HTMLDivElement>): void {
    const drag = dragRef.current
    const wrap = wrapRef.current
    if (drag === null || wrap === null) return
    const rect = wrap.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) return
    const dxPct = ((e.clientX - drag.startX) / rect.width) * 100
    const dyPct = ((e.clientY - drag.startY) / rect.height) * 100
    if (Math.abs(e.clientX - drag.startX) > 2 || Math.abs(e.clientY - drag.startY) > 2) {
      drag.moved = true
    }
    // Clamp so the pill never escapes the wrap.
    const nextLeft = Math.max(0, Math.min(95, drag.startLeftPct + dxPct))
    const nextTop = Math.max(0, Math.min(95, drag.startTopPct + dyPct))
    setPosPct({ leftPct: nextLeft, topPct: nextTop })
  }
  function onPointerUp(e: React.PointerEvent<HTMLDivElement>): void {
    const drag = dragRef.current
    dragRef.current = null
    ;(e.currentTarget as HTMLDivElement).releasePointerCapture?.(e.pointerId)
    // If the pointer never moved, treat as a tap on the play/pause
    // button so the pill is itself a control even without precise
    // pointer aim on a phone screen.
    if (drag !== null && !drag.moved) {
      onToggle()
    }
  }

  return (
    <div
      className="cm-replay-pill"
      role="group"
      aria-label="Replay quick controls"
      style={{
        left: `${posPct.leftPct}%`,
        top: `${posPct.topPct}%`,
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      <button
        type="button"
        className="cm-replay-pill-btn"
        aria-label={playing ? 'Pause replay' : 'Play replay'}
        title={playing ? 'Pause replay' : 'Play replay'}
        onClick={(e) => {
          // Prevent the pointer-up tap-handler from firing twice.
          e.stopPropagation()
          onToggle()
        }}
        onPointerDown={(e) => e.stopPropagation()}
      >
        {playing ? '❚❚' : '▶'}
      </button>
      <span className="cm-replay-pill-time" aria-live="off">
        {formatTime(new Date(cursorMs).toISOString())}
      </span>
    </div>
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
