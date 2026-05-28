// Issue #35 (slice 4b.1) — canonical product-review row, model-agnostic.
//
// This component is a *layout shell* for the family of reviewer
// surfaces that render a "before → after" canonical product row
// (currently `/catalog/review` and `/catalog/pending-purchases`, with
// repricing, market-data and promos to follow). It deliberately takes
// model-agnostic, primitive props (title, comparison cells, slots for
// pricing ladder / overrides / decisions / bespoke extras) rather than
// a fixed row schema, so each calling surface can adapt its own row
// type at the boundary instead of forcing a single union shape.
//
// Each caller is responsible for:
//   - Loading and editing its own row model (ReviewRow,
//     PendingPurchaseRow, …) and persisting changes.
//   - Building primitive `comparisons` cells.
//   - Providing surface-specific extras (picture options, hierarchy
//     details, market-listings tables, …) via the `bodyExtras` slot.
//   - Wiring up the decision bar in the `decisions` slot.
//
// The shell owns ONLY the shared layout: article wrapper + header
// (title / subtitle / status pills / header actions), the comparison
// grid, the pricing-ladder cradle, the validation-pill row, error
// text and the decisions / footer ordering. That's enough to keep
// all reviewer surfaces visually consistent without forcing them
// through a single data model.
import type { ReactNode } from 'react'

import { Pill } from '../Pill.js'

import { truncateForTooltip, truncatePreview } from './formatters.js'

/**
 * One live → proposed comparison cell.
 *
 * `changeKind` controls layout: `'description'` (or any value with
 * very long text) renders in a full-row long-form cell with the
 * before/after available in a `<details>` summary; everything else
 * renders inline in a small three-column-style cell.
 *
 * Callers should pass plain strings (already rendered for human
 * consumption, including '—' for empty values). The shell does not
 * format values.
 */
export interface CanonicalProductRowComparisonCell {
  key: string | number
  label: string
  liveText: string
  proposedText: string
  changeKind: 'pricing' | 'description' | 'taxonomy' | 'attribute' | 'other'
}

export interface CanonicalProductRowValidationIssue {
  key: string
  code: string
  severity: 'error' | 'warning' | 'info'
}

export interface CanonicalProductRowProps {
  /**
   * Outer-card CSS class. Defaults to `'review-row-card'`. Pages that
   * want a different visual treatment (e.g., the `review-card` class
   * used by `/catalog/pending-purchases` with its collapse-on-decision
   * `review-card--collapsed` modifier) can override it.
   */
  className?: string
  /**
   * Header CSS class. Defaults to `'review-row-header'`. PendingPurchase
   * passes `'review-card-header'` to keep its existing flex layout
   * (title on the left, status pills + actions on the right).
   */
  headerClassName?: string
  /** Primary title rendered in the header (typically a Link). */
  title: ReactNode
  /** Optional secondary line under the title. */
  subtitle?: ReactNode
  /** Status pills rendered on the right side of the header. */
  statusPills?: ReactNode
  /** Extra buttons / actions rendered alongside the status pills. */
  headerActions?: ReactNode
  /**
   * When true, only the header is rendered. The body (comparisons,
   * ladder, extras, overrides, decisions, footer) is hidden until the
   * caller toggles it back on. The header pills + actions stay
   * visible so the reviewer can still see the decision and re-open
   * the row with a single click.
   */
  collapsed?: boolean
  /** Live → proposed comparison cells. */
  comparisons?: readonly CanonicalProductRowComparisonCell[]
  /**
   * Custom content rendered inside the comparison-grid container,
   * as an alternative to mapping `comparisons`. Useful for surfaces
   * (like `/catalog/pending-purchases`) whose top summary band is a
   * row of single-value tiles rather than live → proposed cells.
   * Takes precedence over `comparisons` when both are provided.
   */
  comparisonsContent?: ReactNode
  /** Shown when neither `comparisons` nor `comparisonsContent` is provided. */
  comparisonsEmptyLabel?: ReactNode
  /** Slot for whichever pricing-ladder variant the caller wants. */
  pricingLadder?: ReactNode
  /**
   * Surface-specific content rendered between the pricing ladder and
   * the overrides slot (e.g., picture-options grid, hierarchy details,
   * market listings table).
   */
  bodyExtras?: ReactNode
  /**
   * Slot for the overrides panel (price / description / image / notes
   * / structured-data overrides + their save button).
   */
  overrides?: ReactNode
  /** Optional inline error text rendered above the decisions slot. */
  errorMessage?: string | null
  /** Optional validation-issue pills. */
  validationIssues?: readonly CanonicalProductRowValidationIssue[]
  /** Slot for the decision buttons (Approve / Reject / …). */
  decisions?: ReactNode
  /** Slot for any final content after the decisions row. */
  footer?: ReactNode
}

export function CanonicalProductRow(props: CanonicalProductRowProps): JSX.Element {
  const {
    className = 'review-row-card',
    headerClassName = 'review-row-header',
    title,
    subtitle,
    statusPills,
    headerActions,
    collapsed = false,
    comparisons,
    comparisonsContent,
    comparisonsEmptyLabel,
    pricingLadder,
    bodyExtras,
    overrides,
    errorMessage,
    validationIssues,
    decisions,
    footer,
  } = props

  const hasComparisons = comparisons !== undefined && comparisons.length > 0
  const hasValidationIssues = validationIssues !== undefined && validationIssues.length > 0

  return (
    <article className={className}>
      <header className={headerClassName}>
        <div>
          {title}
          {subtitle ? <p className="subtle-copy">{subtitle}</p> : null}
        </div>
        {statusPills !== undefined || headerActions !== undefined ? (
          <div className="inline-row wrap-row" style={{ gap: '0.4rem', alignItems: 'center' }}>
            {statusPills}
            {headerActions}
          </div>
        ) : null}
      </header>

      {collapsed ? null : (
        <>
          {comparisonsContent !== undefined ? (
            <div className="comparison-grid">{comparisonsContent}</div>
          ) : hasComparisons ? (
            <div className="comparison-grid">
              {comparisons!.map((cell) => (
                <ComparisonPanel cell={cell} key={cell.key} />
              ))}
            </div>
          ) : comparisonsEmptyLabel !== undefined ? (
            <p className="subtle-copy">{comparisonsEmptyLabel}</p>
          ) : null}

          {pricingLadder}

          {bodyExtras}

          {hasValidationIssues ? (
            <div className="inline-row wrap-row">
              {validationIssues!.map((issue) => (
                <Pill key={issue.key} tone={issue.severity === 'error' ? 'danger' : 'warning'}>
                  {issue.code}
                </Pill>
              ))}
            </div>
          ) : null}

          {overrides}

          {errorMessage ? <p className="error-text">{errorMessage}</p> : null}

          {decisions}

          {footer}
        </>
      )}
    </article>
  )
}

/**
 * Renders one live → proposed comparison cell.
 *
 * Short text values (price, taxonomy, attribute strings) render inline in a
 * three-column grid cell.
 *
 * Long-form text values (currently `changeKind === 'description'`, or any
 * very long text) span the full grid row width on desktop, collapse into a
 * `<details>` summary on mobile, and keep the full before/after available
 * inside the open detail body so the reviewer can scan rows without
 * scrolling past 500-word descriptions.
 *
 * The browser `title` tooltip is set to a useful "Live: … → Proposed: …"
 * preview so hovering a row gives a quick before/after even when collapsed.
 */
function ComparisonPanel({ cell }: { cell: CanonicalProductRowComparisonCell }): JSX.Element {
  const liveText = cell.liveText || '—'
  const proposedText = cell.proposedText || '—'

  const isLongForm =
    cell.changeKind === 'description' ||
    liveText.length > 220 ||
    proposedText.length > 220

  const tooltip = `${cell.label}\n\nLive:\n${truncateForTooltip(liveText)}\n\nProposed:\n${truncateForTooltip(proposedText)}`

  if (!isLongForm) {
    return (
      <div className="value-panel" title={tooltip}>
        <span>{cell.label} · live → proposed</span>
        <p>
          <span className="subtle-copy">{liveText}</span>{' '}
          →{' '}
          <strong>{proposedText}</strong>
        </p>
      </div>
    )
  }

  return (
    <details className="value-panel value-panel--full-row value-panel--long-form" title={tooltip}>
      <summary>
        <span className="value-panel__label">{cell.label} · live → proposed</span>
        <span className="value-panel__preview">
          <span className="subtle-copy">{truncatePreview(liveText)}</span>{' '}
          →{' '}
          <strong>{truncatePreview(proposedText)}</strong>
        </span>
      </summary>
      <div className="value-panel__long-body">
        <div className="value-panel__column">
          <h4>Live</h4>
          <p className="long-form-text">{liveText}</p>
        </div>
        <div className="value-panel__column">
          <h4>Proposed</h4>
          <p className="long-form-text">{proposedText}</p>
        </div>
      </div>
    </details>
  )
}
