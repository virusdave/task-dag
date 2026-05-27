import { useEffect, useMemo, useRef, useState } from 'react'

import type {
  CatalogAnalyticsFiltersResponse,
  CatalogFilterOption,
  MetricCatalogFilterDimension,
} from '../../../shared/contracts/index.js'

// ---------------------------------------------------------------------------
// Shared compact catalog filter chips.
//
// Originally written for the /metrics/catalog scatter tab. Extracted
// so the /metrics/sales and /metrics/inventory tabs can reuse the
// same compact dropdown-chip UX (see GitHub issue #7).
//
// The component is intentionally dumb: the caller owns the four
// selected-value sets, the available-options response, and the
// toggle callbacks. We only render and manage the local "is the
// dropdown panel open?" / "what's typed in the search box?" state.
// ---------------------------------------------------------------------------

export interface CatalogFilterSelection {
  readonly categoryIds: ReadonlySet<string>
  readonly subcategoryIds: ReadonlySet<string>
  readonly brandIds: ReadonlySet<string>
  readonly sizes: ReadonlySet<string>
}

export interface CatalogFilterCallbacks {
  readonly onCategoryToggle: (id: string) => void
  readonly onSubcategoryToggle: (id: string) => void
  readonly onBrandToggle: (id: string) => void
  readonly onSizeToggle: (id: string) => void
  readonly onClearAll: () => void
}

export interface CatalogFilterBarProps {
  /** May be null while options are loading; bar renders a small loading
   *  hint until the first response lands. */
  readonly filters: CatalogAnalyticsFiltersResponse | null
  readonly loading: boolean
  readonly selection: CatalogFilterSelection
  readonly callbacks: CatalogFilterCallbacks
  /**
   * Optional — which filter dimensions to surface. Defaults to all
   * four. Tabs that mix metrics with different supportedCatalogFilters
   * sets should pass the union of supported dimensions across all
   * visible metrics so we don't show a chip the operator can't
   * meaningfully use.
   */
  readonly dimensions?: ReadonlyArray<MetricCatalogFilterDimension>
}

const DEFAULT_DIMENSIONS: ReadonlyArray<MetricCatalogFilterDimension> = [
  'category',
  'subcategory',
  'brand',
  'size',
]

export function CatalogFilterBar({
  filters,
  loading,
  selection,
  callbacks,
  dimensions = DEFAULT_DIMENSIONS,
}: CatalogFilterBarProps) {
  if (loading && !filters) {
    return <p className="subtle-copy">Loading filter options…</p>
  }
  if (!filters) return null
  const anySelected = selectionSize(selection) > 0
  const showCategory = dimensions.includes('category')
  const showSubcategory = dimensions.includes('subcategory')
  const showBrand = dimensions.includes('brand')
  const showSize = dimensions.includes('size')
  return (
    <div className="catalog-analytics-filterbar metrics-filterbar">
      {showCategory ? (
        <FilterDropdown
          label="Category"
          options={filters.categories}
          selected={selection.categoryIds}
          onToggle={callbacks.onCategoryToggle}
        />
      ) : null}
      {showSubcategory ? (
        <FilterDropdown
          label="Subcategory"
          options={filters.subcategories}
          selected={selection.subcategoryIds}
          onToggle={callbacks.onSubcategoryToggle}
        />
      ) : null}
      {showBrand ? (
        <FilterDropdown
          label="Brand"
          options={filters.brands}
          selected={selection.brandIds}
          onToggle={callbacks.onBrandToggle}
        />
      ) : null}
      {showSize ? (
        <FilterDropdown
          label="Size"
          options={filters.sizes}
          selected={selection.sizes}
          onToggle={callbacks.onSizeToggle}
        />
      ) : null}
      {anySelected ? (
        <button type="button" className="ghost-button" onClick={callbacks.onClearAll}>
          clear all filters
        </button>
      ) : null}
    </div>
  )
}

export interface FilterDropdownProps {
  readonly label: string
  readonly options: ReadonlyArray<CatalogFilterOption>
  readonly selected: ReadonlySet<string>
  readonly onToggle: (id: string) => void
}

export function FilterDropdown({ label, options, selected, onToggle }: FilterDropdownProps) {
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
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return options
    return options.filter((o) => o.label.toLowerCase().includes(q))
  }, [options, search])
  return (
    <div className="catalog-analytics-filterdrop" ref={ref}>
      <button
        type="button"
        className={
          selected.size > 0
            ? 'metrics-site-chip is-active'
            : 'metrics-site-chip'
        }
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        {label}
        {selected.size > 0 ? ` (${selected.size})` : ''} ▾
      </button>
      {open ? (
        <div className="catalog-analytics-filterdrop-panel">
          <input
            type="text"
            placeholder={`Filter ${label.toLowerCase()}…`}
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

export function emptyCatalogFilterSelection(): CatalogFilterSelection {
  return {
    categoryIds: new Set<string>(),
    subcategoryIds: new Set<string>(),
    brandIds: new Set<string>(),
    sizes: new Set<string>(),
  }
}

export function selectionSize(s: CatalogFilterSelection): number {
  return s.categoryIds.size + s.subcategoryIds.size + s.brandIds.size + s.sizes.size
}

/** Build CSV strings for `/api/metrics/<id>?categoryIds=…&…` query
 *  parameters. */
export function selectionToParams(
  s: CatalogFilterSelection,
): {
  readonly categoryIds: string
  readonly subcategoryIds: string
  readonly brandIds: string
  readonly sizes: string
} {
  return {
    categoryIds: Array.from(s.categoryIds).join(','),
    subcategoryIds: Array.from(s.subcategoryIds).join(','),
    brandIds: Array.from(s.brandIds).join(','),
    sizes: Array.from(s.sizes).join(','),
  }
}
