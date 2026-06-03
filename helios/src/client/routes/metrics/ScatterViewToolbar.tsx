import type { ScatterInteractionMode, ScatterZoomTool } from './scatterZoom.js'

// ---------------------------------------------------------------------------
// Shared "view" toolbar for scatter charts.
//
// One control surface for the two related but orthogonal axes of a
// scatter chart's viewport:
//
//   1. Interaction mode: inspect (hover/drill, page-scrolls past the
//      chart) vs zoom (box-zoom drag, wheel zoom without Ctrl, pan
//      submode). The toggle is the primary affordance — without it,
//      operators have no idea pan/zoom is available.
//
//   2. Fit base: compact (outlier-resistant ~p5/p95 window) vs all
//      data (full padded extent). Independent of interaction mode;
//      both modes respect the current fit base.
//
// Plus a "reset" button that snaps the view back to the current fit
// base. The button only renders when the view is actually zoomed
// (otherwise it would be a confusing no-op).
//
// The toolbar deliberately lives inside the chart area, NOT in the
// crowded card header that already houses 5 axis/encoding selects.
// Operator-grade UX: text-labelled chips, generous tap targets,
// visible pressed states.
// ---------------------------------------------------------------------------

export interface ScatterViewToolbarProps {
  readonly mode: ScatterInteractionMode
  readonly setMode: (next: ScatterInteractionMode) => void
  readonly tool: ScatterZoomTool
  readonly setTool: (next: ScatterZoomTool) => void
  readonly isZoomed: boolean
  readonly resetView: () => void
  /**
   * Optional fit-mode toggle. When provided, an extra "Compact /
   * All data" segmented control is rendered. When the caller's
   * chart doesn't have a compact/full distinction (e.g. histograms),
   * leave both fields undefined.
   */
  readonly fitMode?: 'compact' | 'full'
  readonly setFitMode?: (next: 'compact' | 'full') => void
  /** How many points the compact view hides; informs the "All data (N)" label. */
  readonly hiddenOutlierCount?: number
}

export function ScatterViewToolbar(p: ScatterViewToolbarProps): JSX.Element {
  const inZoom = p.mode === 'zoom'
  const fitToggleEnabled = p.fitMode != null && p.setFitMode != null
  return (
    <div className="scatter-view-toolbar" role="toolbar" aria-label="Chart view controls">
      <button
        type="button"
        className={inZoom ? 'scatter-view-toggle is-active' : 'scatter-view-toggle'}
        aria-pressed={inZoom}
        onClick={() => p.setMode(inZoom ? 'inspect' : 'zoom')}
        title={
          inZoom
            ? 'Turn off pan/zoom — return to hover & drill'
            : 'Turn on pan/zoom — drag a box to zoom in, wheel zooms, drag to pan'
        }
      >
        {inZoom ? '✓ Pan/zoom' : '🔍 Pan/zoom'}
      </button>
      {inZoom ? (
        <div className="scatter-view-tool-group" role="group" aria-label="Drag tool">
          <button
            type="button"
            className={
              p.tool === 'box'
                ? 'scatter-view-tool-chip is-active'
                : 'scatter-view-tool-chip'
            }
            aria-pressed={p.tool === 'box'}
            onClick={() => p.setTool('box')}
            title="Drag a rectangle to zoom into it"
          >
            Box
          </button>
          <button
            type="button"
            className={
              p.tool === 'pan'
                ? 'scatter-view-tool-chip is-active'
                : 'scatter-view-tool-chip'
            }
            aria-pressed={p.tool === 'pan'}
            onClick={() => p.setTool('pan')}
            title="Drag to pan the current view"
          >
            Pan
          </button>
        </div>
      ) : null}
      {fitToggleEnabled ? (
        <div
          className="scatter-view-fit-group"
          role="group"
          aria-label="Default zoom fit"
        >
          <button
            type="button"
            className={
              p.fitMode === 'compact'
                ? 'scatter-view-tool-chip is-active'
                : 'scatter-view-tool-chip'
            }
            aria-pressed={p.fitMode === 'compact'}
            onClick={() => p.setFitMode!('compact')}
            title="Fit to the densest ~90% of points (hides outliers from default view)"
          >
            Compact
          </button>
          <button
            type="button"
            className={
              p.fitMode === 'full'
                ? 'scatter-view-tool-chip is-active'
                : 'scatter-view-tool-chip'
            }
            aria-pressed={p.fitMode === 'full'}
            onClick={() => p.setFitMode!('full')}
            title="Fit to all points, including outliers"
          >
            All
            {p.hiddenOutlierCount != null && p.hiddenOutlierCount > 0
              ? ` (+${p.hiddenOutlierCount})`
              : ''}
          </button>
        </div>
      ) : null}
      {p.isZoomed ? (
        <button
          type="button"
          className="scatter-view-reset"
          onClick={p.resetView}
          title="Reset view (or double-click the chart)"
        >
          Reset
        </button>
      ) : null}
    </div>
  )
}
