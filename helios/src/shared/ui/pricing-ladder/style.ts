/**
 * Canonical CSS for the pricing-ladder control. Self-contained: no
 * external CSS variables required (all colors inline). Drop into a static
 * <style> block or import via your bundler.
 *
 * Class taxonomy:
 *
 *   .canonical-pricing-ladder              -- shell
 *     .canonical-pricing-ladder-head       -- caption row above ladder
 *     .canonical-pricing-ladder-track      -- the 140px positioned track
 *       .canonical-ladder-bands            -- horizontal-stripe gradient zones (one per band)
 *       .canonical-ladder-iqr              -- IQR rectangle
 *       .canonical-ladder-median           -- median tick
 *       .canonical-ladder-baseline         -- bottom price baseline
 *       .canonical-ladder-competitor       -- one per listing
 *         &.band-very-near / .band-near / .band-mid / .band-far / .band-statewide
 *         &[data-eligible="false"]         -- dimmed display-only listings
 *       .canonical-ladder-marker           -- one per anchor
 *         &.live / .proposed / .market-average / .market-median
 *         &.proposed[data-canonical-ladder-slider="active"] -- slider-attached
 *           &.is-dragging                  -- during a drag interaction
 *       .canonical-ladder-axis             -- domain min/max labels
 *     .canonical-pricing-ladder-meta       -- below-ladder summary line
 *     .canonical-pricing-ladder-legend     -- band swatch legend
 */

export const PRICING_LADDER_STYLE = `
.canonical-pricing-ladder {
  --cpl-band-very-near: #22c55e;
  --cpl-band-near: #1d7a4f;
  --cpl-band-mid: #caa53a;
  --cpl-band-far: #c87132;
  --cpl-band-statewide: #7d7569;
  --cpl-marker-live: #6d665b;
  --cpl-marker-proposed: #8d2f52;
  --cpl-marker-average: #27417e;
  --cpl-marker-median: #1f1b17;
  --cpl-card: #fffaf1;
  --cpl-ink: #1f1b17;
  --cpl-muted: #6d665b;
  --cpl-line: #d9ceb7;
  margin: 6px 0 12px;
  font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Helvetica, Arial, sans-serif;
  font-size: 13px;
  color: var(--cpl-ink);
}
.canonical-pricing-ladder-head {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 16px;
  align-items: baseline;
  margin-bottom: 10px;
  font-size: 13px;
}
.canonical-pricing-ladder-head .metric { font-weight: 700; }
.canonical-pricing-ladder-head .metric-detail { font-weight: 400; color: var(--cpl-muted); }
.canonical-pricing-ladder-head .muted { color: var(--cpl-muted); }
.canonical-pricing-ladder-track {
  position: relative;
  height: 140px;
  margin: 6px 0 22px;
  padding: 6px 0 0;
  border-bottom: 1px dashed #c8bca3;
  border-radius: 6px;
  background: linear-gradient(
    to bottom,
    rgba(34, 197, 94, 0.06) 0px,
    rgba(34, 197, 94, 0.06) 28px,
    rgba(29, 122, 79, 0.06) 28px,
    rgba(29, 122, 79, 0.06) 50px,
    rgba(202, 165, 58, 0.06) 50px,
    rgba(202, 165, 58, 0.06) 70px,
    rgba(200, 113, 50, 0.06) 70px,
    rgba(200, 113, 50, 0.06) 90px,
    rgba(125, 117, 105, 0.06) 90px
  );
}
.canonical-ladder-baseline {
  position: absolute;
  left: 0;
  right: 0;
  top: 114px;
  height: 1px;
  background: #c8bca3;
}
.canonical-ladder-iqr {
  position: absolute;
  top: 108px;
  height: 14px;
  background: rgba(125, 117, 105, 0.18);
  border-radius: 6px;
}
.canonical-ladder-median {
  position: absolute;
  top: 104px;
  width: 2px;
  height: 22px;
  background: var(--cpl-marker-median);
}
.canonical-ladder-competitor {
  position: absolute;
  width: 11px;
  height: 11px;
  border-radius: 50%;
  transform: translate(-50%, -50%);
  border: 1.5px solid #fff;
  box-shadow: 0 0 0 1px rgba(31, 27, 23, 0.18);
  cursor: pointer;
  text-decoration: none;
  transition: transform 0.12s ease;
  background: var(--cpl-band-statewide);
}
.canonical-ladder-competitor:hover {
  transform: translate(-50%, -50%) scale(1.45);
  z-index: 3;
}
.canonical-ladder-competitor[data-eligible="false"] { opacity: 0.42; }
.canonical-ladder-competitor.band-very-near { background: var(--cpl-band-very-near); }
.canonical-ladder-competitor.band-near      { background: var(--cpl-band-near); }
.canonical-ladder-competitor.band-mid       { background: var(--cpl-band-mid); }
.canonical-ladder-competitor.band-far       { background: var(--cpl-band-far); }
.canonical-ladder-competitor.band-statewide { background: var(--cpl-band-statewide); }
.canonical-ladder-marker {
  position: absolute;
  transform: translateX(-50%);
  font-size: 11px;
  pointer-events: auto;
}
.canonical-ladder-marker .pin { display: block; width: 2px; background: currentColor; }
.canonical-ladder-marker .pip { display: block; width: 12px; height: 12px; border-radius: 2px; transform: rotate(45deg); margin: 0 auto -6px; background: var(--cpl-card); border: 2px solid currentColor; }
.canonical-ladder-marker span.label { display: inline-block; padding: 2px 8px; border-radius: 6px; background: rgba(255, 255, 255, 0.92); border: 1px solid currentColor; color: currentColor; font-weight: 700; white-space: nowrap; transform: translateX(-50%); position: absolute; left: 50%; }
.canonical-ladder-marker.live          { color: var(--cpl-marker-live);     top: 0; }
.canonical-ladder-marker.proposed      { color: var(--cpl-marker-proposed); top: 0; }
.canonical-ladder-marker.market-average { color: var(--cpl-marker-average); top: 122px; }
.canonical-ladder-marker.market-median  { color: var(--cpl-marker-median);  top: 122px; }
.canonical-ladder-marker.live      .pin,
.canonical-ladder-marker.proposed  .pin { height: 130px; margin-top: 6px; }
.canonical-ladder-marker.market-average .pin,
.canonical-ladder-marker.market-median  .pin { height: 12px; margin-top: 0; }
.canonical-ladder-marker.live          span.label { top: -6px; }
.canonical-ladder-marker.proposed      span.label { top: -6px; background: var(--cpl-marker-proposed); color: #fff; border-color: var(--cpl-marker-proposed); }
.canonical-ladder-marker.market-average span.label,
.canonical-ladder-marker.market-median  span.label { top: 14px; }
/* slider affordances when explicitly attached at runtime */
.canonical-ladder-marker.proposed[data-canonical-ladder-slider="active"]      { cursor: grab; touch-action: none; }
.canonical-ladder-marker.proposed[data-canonical-ladder-slider="active"].is-dragging { cursor: grabbing; }
.canonical-ladder-marker.proposed[data-canonical-ladder-slider="active"] .pip { box-shadow: 0 0 0 4px rgba(141, 47, 82, 0.18); }
.canonical-ladder-axis {
  position: absolute;
  bottom: -20px;
  font-size: 11px;
  color: var(--cpl-muted);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
.canonical-ladder-axis.axis-min { left: 0; }
.canonical-ladder-axis.axis-max { right: 0; }
.canonical-pricing-ladder-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 16px;
  font-size: 12px;
  color: var(--cpl-muted);
  margin-top: 8px;
}
.canonical-pricing-ladder-legend {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin: 6px 0 4px;
  font-size: 11px;
}
.canonical-pricing-ladder-legend .legend-pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 2px 10px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.6);
  border: 1px solid var(--cpl-line);
}
.canonical-pricing-ladder-legend .legend-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  display: inline-block;
}
.ladder-freshness-chip {
  display: inline-block;
  padding: 1px 8px;
  border-radius: 6px;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.02em;
  text-transform: uppercase;
  border: 1px solid transparent;
  line-height: 1.5;
}
.ladder-freshness-chip.is-fresh      { background: #dfeae2; color: #1f5d42; border-color: #c2d8c8; }
.ladder-freshness-chip.is-stale      { background: #f0e1c2; color: #8b5e11; border-color: #e0cf9d; }
.ladder-freshness-chip.is-very-stale { background: #f3dde4; color: #8d2f52; border-color: #e6c3cf; }
.ladder-freshness-chip.is-expired    { background: #f3dde4; color: #8d2f52; border-color: #e0a3ba; }
.ladder-freshness-chip.is-absent     { background: #eee;    color: #777;    border-color: #d9d9d9; }
.canonical-pricing-ladder[data-freshness-locked="true"] .canonical-pricing-ladder-track {
  background: repeating-linear-gradient(
    135deg,
    rgba(141, 47, 82, 0.05) 0px,
    rgba(141, 47, 82, 0.05) 10px,
    rgba(141, 47, 82, 0.10) 10px,
    rgba(141, 47, 82, 0.10) 20px
  );
}
.canonical-pricing-ladder-expired-lock {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  padding: 4px 12px;
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.92);
  border: 1px solid #e0a3ba;
  color: #8d2f52;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.02em;
  text-transform: uppercase;
  z-index: 5;
  pointer-events: none;
}
`
