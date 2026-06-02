// Shared structured-highlight infra for every scatter page that exposes
// a "highlight subset" UI (catalog scatter, budtender advanced scatter,
// customer-value scatter, brand-detail / distributor-detail embedded
// scatters, …). See GitHub issue #38, task A2.
//
// The component is deliberately dumb: callers own `state` / `freeText`
// (their useState pair) and the `filteredPoints` array used to populate
// each dimension's chip options. The matcher helper below is a pure
// function so it can be unit-tested without React.
//
// Semantics (per operator decision 2026-06-02):
//   - Options in each highlight dimension dropdown are populated from
//     the FILTERED point set. If filters narrow the page to "Edibles",
//     the Brand highlight chip list only shows brands that have at
//     least one Edibles point on screen.
//   - A point is "highlighted" iff:
//       * for every dimension that has ≥1 chip selected, the point
//         matches at least one of that dimension's chips
//         (OR within a dimension), AND
//       * the free-text query (if non-empty) matches the point's
//         haystack (substring, multi-term ANDed), AND
//       * the two checks combine with AND across dimensions
//         (e.g. Brand=Cresco AND Size=1g highlights Cresco 1g
//         specifically).
//   - If no chips are picked AND free-text is empty → buildStructured-
//     HighlightMatcher returns null and the caller treats highlight as
//     inactive (matches the legacy free-text-only behaviour).
import { useEffect, useMemo, useRef, useState } from 'react'

// ---------------------------------------------------------------------------
// Types

/** One highlight dimension (e.g. Brand, Category, Size). */
export interface HighlightDimensionSpec<P> {
  /** Stable id used as the key in the selection-state map. */
  readonly id: string
  /** Human-readable label shown on the dropdown chip. */
  readonly label: string
  /**
   * Compute the option list shown in the dropdown FROM THE FILTERED
   * point set. Each option is `{ id, label, itemCount }`. Implementors
   * typically group the points by some field, count, and sort by label.
   */
  readonly getOptions: (
    filteredPoints: ReadonlyArray<P>,
  ) => ReadonlyArray<{ readonly id: string; readonly label: string; readonly itemCount: number }>
  /**
   * Return the set of option-ids the point belongs to for this
   * dimension. Used both for structured matching ("does the selected
   * Brand=Cresco chip match this point?") and for the default free-text
   * haystack (we join every dim's pointKey strings to substring-match
   * against). Most dims return exactly one id; some (e.g. tags) may
   * return several or none.
   */
  readonly pointKey: (p: P) => ReadonlyArray<string>
}

/** Per-dimension selection: dim.id → set of selected option-ids. */
export type HighlightSelectionState = ReadonlyMap<string, ReadonlySet<string>>

// ---------------------------------------------------------------------------
// Selection-state helpers (kept small so adoption sites don't reimplement)

export function emptyHighlightSelection(): HighlightSelectionState {
  return new Map()
}

export function highlightSelectionSize(state: HighlightSelectionState): number {
  let n = 0
  for (const set of state.values()) n += set.size
  return n
}

/**
 * Return a NEW state with `optionId` toggled inside `dimId`. Removes
 * the dimension entry entirely when its set becomes empty so callers
 * can rely on `state.has(dimId)` meaning "≥1 chip picked".
 */
export function toggleHighlightSelection(
  state: HighlightSelectionState,
  dimId: string,
  optionId: string,
): HighlightSelectionState {
  const next = new Map(state)
  const current = next.get(dimId)
  const nextSet = new Set(current ?? [])
  if (nextSet.has(optionId)) nextSet.delete(optionId)
  else nextSet.add(optionId)
  if (nextSet.size === 0) next.delete(dimId)
  else next.set(dimId, nextSet)
  return next
}

/** Drop every chip and (optionally) reset the free-text input. */
export function clearHighlightSelection(): HighlightSelectionState {
  return new Map()
}

// ---------------------------------------------------------------------------
// Pure matcher

/**
 * Build a combined (structured AND free-text) highlight matcher.
 * Returns `null` when no highlight is active — the caller should treat
 * highlight as off in that case (preserves legacy "no dimming" UX).
 *
 * Free-text matching uses the union of every dimension's `pointKey(p)`
 * as the haystack, joined by space, lowercased; whitespace-separated
 * terms are ALL-required (AND). Adoption sites that need to make
 * additional fields searchable (e.g. product name / sku) should fold
 * those into one of the dim `pointKey` returns.
 */
export function buildStructuredHighlightMatcher<P>(
  dims: ReadonlyArray<HighlightDimensionSpec<P>>,
  state: HighlightSelectionState,
  freeText: string,
): ((p: P) => boolean) | null {
  // Normalize free-text query → list of lowercase terms.
  const q = freeText.trim().toLowerCase()
  const terms = q.length === 0 ? [] : q.split(/\s+/).filter((t) => t.length > 0)

  // Collect (dim, selectedSet) pairs that actually constrain. A dim
  // with no chips picked is a no-op for structured matching.
  const activeDims: ReadonlyArray<{
    readonly dim: HighlightDimensionSpec<P>
    readonly selected: ReadonlySet<string>
  }> = dims
    .map((dim) => ({ dim, selected: state.get(dim.id) }))
    .filter(
      (e): e is { dim: HighlightDimensionSpec<P>; selected: ReadonlySet<string> } =>
        e.selected !== undefined && e.selected.size > 0,
    )

  if (activeDims.length === 0 && terms.length === 0) return null

  return (p: P) => {
    // Structured: AND across dims, OR within a dim.
    for (const { dim, selected } of activeDims) {
      const keys = dim.pointKey(p)
      let any = false
      for (const k of keys) {
        if (selected.has(k)) {
          any = true
          break
        }
      }
      if (!any) return false
    }
    // Free-text: AND of every term against the joined-pointKey
    // haystack.
    if (terms.length > 0) {
      const parts: string[] = []
      for (const dim of dims) {
        for (const k of dim.pointKey(p)) parts.push(k)
      }
      const haystack = parts.join(' ').toLowerCase()
      for (const t of terms) {
        if (!haystack.includes(t)) return false
      }
    }
    return true
  }
}

// ---------------------------------------------------------------------------
// Component

export interface HighlightControlsProps<P> {
  readonly dims: ReadonlyArray<HighlightDimensionSpec<P>>
  readonly state: HighlightSelectionState
  readonly setState: (next: HighlightSelectionState) => void
  /**
   * The same filtered point set the scatter renders. Drives the
   * `getOptions` calls and the "n=X/total" count next to the free-text
   * input.
   */
  readonly filteredPoints: ReadonlyArray<P>
  readonly freeText: string
  readonly setFreeText: (next: string) => void
  /** Placeholder for the free-text input. */
  readonly freeTextPlaceholder?: string
}

export function HighlightControls<P>({
  dims,
  state,
  setState,
  filteredPoints,
  freeText,
  setFreeText,
  freeTextPlaceholder,
}: HighlightControlsProps<P>) {
  const matcher = useMemo(
    () => buildStructuredHighlightMatcher(dims, state, freeText),
    [dims, state, freeText],
  )
  const matchCount = useMemo(() => {
    if (!matcher) return 0
    let n = 0
    for (const p of filteredPoints) if (matcher(p)) n += 1
    return n
  }, [matcher, filteredPoints])
  const anySelection = highlightSelectionSize(state) > 0 || freeText.trim().length > 0
  // Filter out dims whose `getOptions(filteredPoints)` returns empty —
  // we don't want a useless chip dropdown for a dim with nothing to
  // pick. This includes dims a caller deliberately defined with an
  // empty getOptions() purely so its `pointKey` participates in the
  // free-text haystack join (e.g. cashier identity, product SKU).
  const renderableDims = useMemo(
    () => dims.filter((d) => d.getOptions(filteredPoints).length > 0),
    [dims, filteredPoints],
  )
  return (
    <div className="metrics-highlight-controls">
      {renderableDims.map((dim) => (
        <HighlightDropdown
          key={dim.id}
          dim={dim}
          selected={state.get(dim.id) ?? EMPTY_SET}
          filteredPoints={filteredPoints}
          onToggle={(optionId) => setState(toggleHighlightSelection(state, dim.id, optionId))}
        />
      ))}
      <label className="metrics-highlight-freetext-label">
        text{' '}
        <input
          type="search"
          value={freeText}
          placeholder={freeTextPlaceholder ?? 'substring…'}
          onChange={(e) => setFreeText(e.target.value)}
          className="metrics-highlight-freetext-input"
        />
      </label>
      {matcher ? (
        <span className="subtle-copy metrics-highlight-count">
          {matchCount}/{filteredPoints.length}
        </span>
      ) : null}
      {anySelection ? (
        <button
          type="button"
          className="ghost-button"
          onClick={() => {
            setState(clearHighlightSelection())
            setFreeText('')
          }}
        >
          clear highlight
        </button>
      ) : null}
    </div>
  )
}

const EMPTY_SET: ReadonlySet<string> = new Set<string>()

// ---------------------------------------------------------------------------
// Internal: per-dimension chip dropdown.
//
// Mirrors the visual / interaction shape of `<FilterDropdown>` in
// `CatalogFilterBar.tsx` so the Filters section and Highlight section
// feel like siblings. Kept private to this file because the Highlight
// section is the only consumer; nothing else should reach in and reuse
// a chip dropdown whose options come from the filtered point set.

interface HighlightDropdownProps<P> {
  readonly dim: HighlightDimensionSpec<P>
  readonly selected: ReadonlySet<string>
  readonly filteredPoints: ReadonlyArray<P>
  readonly onToggle: (optionId: string) => void
}

function HighlightDropdown<P>({
  dim,
  selected,
  filteredPoints,
  onToggle,
}: HighlightDropdownProps<P>) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const ref = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!open) return
    const onClick = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [open])
  const options = useMemo(() => dim.getOptions(filteredPoints), [dim, filteredPoints])
  const filtered = useMemo(() => {
    const s = search.trim().toLowerCase()
    if (!s) return options
    return options.filter((o) => o.label.toLowerCase().includes(s))
  }, [options, search])
  return (
    <div className="catalog-analytics-filterdrop metrics-highlight-drop" ref={ref}>
      <button
        type="button"
        className={selected.size > 0 ? 'metrics-site-chip is-active' : 'metrics-site-chip'}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        {dim.label}
        {selected.size > 0 ? ` (${selected.size})` : ''} ▾
      </button>
      {open ? (
        <div className="catalog-analytics-filterdrop-panel">
          <input
            type="text"
            placeholder={`Highlight ${dim.label.toLowerCase()}…`}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="catalog-analytics-filterdrop-search"
            autoFocus
          />
          <ul className="catalog-analytics-filterdrop-list">
            {filtered.length === 0 ? (
              <li className="subtle-copy" style={{ padding: '0.4em 0.6em' }}>
                no matches
              </li>
            ) : (
              filtered.slice(0, 200).map((o) => {
                const active = selected.has(o.id)
                return (
                  <li key={o.id}>
                    <label className="catalog-analytics-filterdrop-item">
                      <input
                        type="checkbox"
                        checked={active}
                        onChange={() => onToggle(o.id)}
                      />{' '}
                      {o.label}{' '}
                      <span className="subtle-copy">(n={o.itemCount})</span>
                    </label>
                  </li>
                )
              })
            )}
          </ul>
        </div>
      ) : null}
    </div>
  )
}
