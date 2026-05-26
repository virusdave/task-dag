import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useLoaderData, useNavigate, useSearchParams } from 'react-router-dom'
import { z } from 'zod'

import { buildHeliosModulePath } from '../../../shared/contracts/index.js'
import { loadJson, mutateJson } from '../../app/fetchJson.js'
import { Pill } from '../../components/Pill.js'
import { useRegisterCatalogSidebarSubtree } from './catalogSidebarSubtree.js'

/**
 * Catalog → Market Data review (issue #18 + #20 redesign).
 *
 * Mobile-first card layout. Each catalog group expands inline to a
 * review panel that:
 *   - shows the catalog group's photo, brand, category, subcategory
 *   - groups catalog variants by size family ("1g", "3.5g", "100mg")
 *   - for each size group, renders the variant card (with photo +
 *     sku) next to the ranked candidates from LitAlerts
 *   - hides below-threshold candidates as "auto no-match" so the
 *     reviewer only sees real candidates
 *   - exposes a minScore slider so the operator can re-tune the
 *     suppression threshold on the fly
 *
 * Verdicts are recorded server-side in catalog_market_matches; the
 * client optimistically removes the verdict's candidate from the
 * displayed list and increments live-verdict count instead of
 * reloading the entire bundle, which is what made the page feel
 * sluggish in the prior version.
 */

const ListResponseSchema = z.any() as z.ZodType<ListResponse>
const BundleSchema = z.any() as z.ZodType<GroupReviewBundle>
const VerdictResponseSchema = z.any()

interface GroupSummaryRow {
  catalogGroupId: number
  groupName: string
  brandName: string | null
  categoryName: string | null
  subcategoryName: string | null
  observationCount: number
  liveVerdictCount: number
  parsedFuzzyCount: number
  highQualityFuzzyCount: number
}

interface ListResponse {
  rows: GroupSummaryRow[]
  pagination: { limit: number; offset: number; totalCount: number }
}

interface FilterOptionsResponse {
  brands: string[]
  categories: string[]
  subcategories: string[]
}

interface LoaderData {
  list: ListResponse
  filterOptions: FilterOptionsResponse
}

interface FuzzySku {
  id: number
  sourceKind: string
  sourceListingId: string
  rawInputJsonb: { listingName?: string; url?: string; dispensaryName?: string; brand?: string; category?: string } | null
  brandNorm: string | null
  categoryNorm: string | null
  subcategoryNorm: string | null
  sizeGNorm: number | null
  sizeMgNorm: number | null
  packCountNorm: number | null
  strainNorm: string | null
}

interface Candidate {
  fuzzy: FuzzySku
  rawScore: number
  finalScore: number
  factors: { brand: number; category: number; subcategory: number; size: number; pack: number; strain: number }
  listingUrl: string | null
  dispensaryName: string | null
  imageUrl: string | null
  matchedCatalogProductId: number | null
  matchedSizeKey: string
  matchedSizeLabel: string
}

interface CatalogVariant {
  catalogProductId: number
  name: string | null
  shortName: string | null
  tab: string | null
  sku: string | null
  sizeName: string | null
  sizeGNorm: number | null
  sizeMgNorm: number | null
  packCountNorm: number | null
  imageUrl: string | null
  price: number | null
  sizeKey: string
  sizeLabel: string
}

interface SizeGroup {
  sizeKey: string
  sizeLabel: string
  variants: CatalogVariant[]
  candidates: Candidate[]
  suppressedCandidateCount: number
}

interface GroupReviewBundle {
  catalogGroupId: number
  groupName: string
  brandName: string | null
  categoryName: string | null
  subcategoryName: string | null
  groupImageUrl: string | null
  sizeGroups: SizeGroup[]
  unmatchedCandidates: Candidate[]
  visibleCandidateCount: number
  suppressedCandidateCount: number
  minScore: number
  observationCount: number
  hasParsedAnyObservation: boolean
  liveVerdicts: Array<{
    id: number
    fuzzySkuId: number
    verdict: 'exact' | 'brand_family' | 'no_match'
    verdictSetAt: string
    verdictSetByUserId: string
    confidenceAtVerdict: number | null
    notes: string | null
    listingUrl: string | null
    dispensaryName: string | null
    fuzzy: FuzzySku
  }>
}

const FilterOptionsSchema = z.any() as z.ZodType<FilterOptionsResponse>

export async function catalogMarketDataLoader({ request }: { request: Request }): Promise<LoaderData> {
  const url = new URL(request.url)
  const params = url.searchParams
  if (!params.has('limit')) params.set('limit', '50')
  const [list, filterOptions] = await Promise.all([
    loadJson(`/api/catalog/market-matches?${params.toString()}`, ListResponseSchema),
    loadJson('/api/catalog/market-matches/filter-options', FilterOptionsSchema),
  ])
  return { list, filterOptions }
}

/**
 * Default confidence threshold for the page-level slider. The server
 * still suggests this value via the bundle's `minScore` field for
 * backward compatibility, but it no longer suppresses candidates by
 * score — the SPA gets the top N candidates per size group regardless
 * of threshold, and the slider does a pure client-side visible/hidden
 * split. Sliders live at three scopes:
 *
 *   - GLOBAL  (page header)              applies to every brand/item
 *                                        that hasn't overridden it.
 *   - BRAND   (per-brand section header) overrides global for that
 *                                        brand's items.
 *   - ITEM    (per-expanded-row review)  overrides brand + global for
 *                                        that one row.
 *
 * Effective threshold for an item = item override ?? brand override ??
 * global. Each level shows an "↻ inherit" button that clears its
 * override so the slider follows the layer above it again.
 *
 * The top candidate per size group (rank 0 in the server response) is
 * ALWAYS shown regardless of slider value, so a too-aggressive
 * threshold can never hide the row a reviewer actually needs to see.
 */
const DEFAULT_MIN_SCORE = 0.70

export function CatalogMarketDataPage(): JSX.Element {
  useRegisterCatalogSidebarSubtree()
  const { list: data, filterOptions } = useLoaderData() as LoaderData
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const [brand, setBrand] = useState(params.get('brand') ?? '')
  const [category, setCategory] = useState(params.get('category') ?? '')
  const [subcategory, setSubcategory] = useState(params.get('subcategory') ?? '')
  const [unverdictedOnly, setUnverdictedOnly] = useState(params.get('unverdictedOnly') === 'true')
  const [expanded, setExpanded] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [globalMinScore, setGlobalMinScore] = useState(DEFAULT_MIN_SCORE)
  const [brandOverrides, setBrandOverrides] = useState<Record<string, number>>({})
  const [itemOverrides, setItemOverrides] = useState<Record<number, number>>({})

  const setBrandOverride = useCallback((brandKey: string, score: number | null) => {
    setBrandOverrides((cur) => {
      const next = { ...cur }
      if (score === null) delete next[brandKey]
      else next[brandKey] = score
      return next
    })
  }, [])
  const setItemOverride = useCallback((groupId: number, score: number | null) => {
    setItemOverrides((cur) => {
      const next = { ...cur }
      if (score === null) delete next[groupId]
      else next[groupId] = score
      return next
    })
  }, [])

  const totalPages = Math.max(1, Math.ceil(data.pagination.totalCount / data.pagination.limit))
  const currentPage = Math.floor(data.pagination.offset / data.pagination.limit) + 1

  function applyFilters(overrides?: {
    brand?: string
    category?: string
    subcategory?: string
    unverdictedOnly?: boolean
  }): void {
    const nextBrand = (overrides?.brand ?? brand).trim()
    const nextCategory = (overrides?.category ?? category).trim()
    const nextSubcategory = (overrides?.subcategory ?? subcategory).trim()
    const nextUnverdicted = overrides?.unverdictedOnly ?? unverdictedOnly
    const next = new URLSearchParams(params)
    if (nextBrand) next.set('brand', nextBrand)
    else next.delete('brand')
    if (nextCategory) next.set('category', nextCategory)
    else next.delete('category')
    if (nextSubcategory) next.set('subcategory', nextSubcategory)
    else next.delete('subcategory')
    if (nextUnverdicted) next.set('unverdictedOnly', 'true')
    else next.delete('unverdictedOnly')
    next.delete('offset')
    setParams(next)
    void navigate(`${buildHeliosModulePath('catalog', 'market-data')}?${next.toString()}`)
  }
  function goToOffset(offset: number): void {
    const next = new URLSearchParams(params)
    next.set('offset', String(offset))
    setParams(next)
    void navigate(`${buildHeliosModulePath('catalog', 'market-data')}?${next.toString()}`)
  }

  return (
    <div className="stacked-list">
      <section className="detail-panel">
        <div className="page-header" style={{ marginBottom: '0.5rem' }}>
          <div>
            <p className="eyebrow">Catalog → Market Data</p>
            <h2>{`${data.pagination.totalCount.toLocaleString()} catalog groups with LitAlerts coverage`}</h2>
          </div>
          <Pill tone="muted">{`page ${currentPage}/${totalPages}`}</Pill>
        </div>

        <div className="inline-row wrap-row" style={{ marginBottom: '0.75rem', gap: '0.75rem' }}>
          <TypeaheadFilter
            label="brand"
            listId="catalog-market-brand-options"
            onApply={(v) => applyFilters({ brand: v })}
            onChange={setBrand}
            options={filterOptions.brands}
            value={brand}
          />
          <TypeaheadFilter
            label="category"
            listId="catalog-market-category-options"
            onApply={(v) => applyFilters({ category: v })}
            onChange={setCategory}
            options={filterOptions.categories}
            value={category}
          />
          <TypeaheadFilter
            label="subcategory"
            listId="catalog-market-subcategory-options"
            onApply={(v) => applyFilters({ subcategory: v })}
            onChange={setSubcategory}
            options={filterOptions.subcategories}
            value={subcategory}
          />
          <label className="inline-row">
            <input
              checked={unverdictedOnly}
              onChange={(e) => {
                const v = e.currentTarget.checked
                setUnverdictedOnly(v)
                applyFilters({ unverdictedOnly: v })
              }}
              type="checkbox"
            />
            Only groups with no live verdicts
          </label>
          <button className="ghost-button" onClick={() => applyFilters()} type="button">Apply</button>
          {(brand || category || subcategory || unverdictedOnly) && (
            <button
              className="ghost-button"
              onClick={() => {
                setBrand(''); setCategory(''); setSubcategory(''); setUnverdictedOnly(false)
                applyFilters({ brand: '', category: '', subcategory: '', unverdictedOnly: false })
              }}
              type="button"
            >
              Clear all
            </button>
          )}
          <MinScoreSlider
            label="Confidence (global):"
            onChange={setGlobalMinScore}
            value={globalMinScore}
          />
        </div>

        {error ? <p className="error-banner">{error}</p> : null}

        <BrandGroupedList
          brandOverrides={brandOverrides}
          expandedGroupId={expanded}
          globalMinScore={globalMinScore}
          itemOverrides={itemOverrides}
          onError={setError}
          onSetBrandOverride={setBrandOverride}
          onSetItemOverride={setItemOverride}
          onToggleGroup={(gid) => setExpanded((cur) => (cur === gid ? null : gid))}
          rows={data.rows}
        />

        <div className="inline-row wrap-row" style={{ marginTop: '1rem' }}>
          <button
            className="ghost-button"
            disabled={data.pagination.offset === 0}
            onClick={() => goToOffset(Math.max(0, data.pagination.offset - data.pagination.limit))}
            type="button"
          >
            ← Prev
          </button>
          <span className="subtle-copy">{currentPage} / {totalPages}</span>
          <button
            className="ghost-button"
            disabled={currentPage >= totalPages}
            onClick={() => goToOffset(data.pagination.offset + data.pagination.limit)}
            type="button"
          >
            Next →
          </button>
        </div>

        <details style={{ marginTop: '1.5rem' }}>
          <summary>About this page</summary>
          <div className="subtle-copy" style={{ marginTop: '0.5rem' }}>
            <p>
              Reviews catalog groups against the structured LitAlerts NY product directory. Each catalog group
              expands to per-size-family tables: the catalog variant (with photo + sku) next to its ranked
              LitAlerts candidates. Confidence-threshold sliders work at three scopes — page-global, per-brand
              (in each brand's section header), and per-item (inside an expanded review) — with the more
              specific scope overriding the less specific one. A "↻" button next to a slider clears that
              level's override so it follows the layer above it again. The top candidate per size group is
              always shown regardless of slider value, so an aggressive threshold can never hide the row
              you actually need to act on.
            </p>
            <p>
              Brand resolution honours operator overrides set in <Link to={buildHeliosModulePath('catalog', 'brand-mapping')}>Catalog → Brand Mapping</Link>.
              Structured fuzzies are pre-filtered by brand + category at the SQL level, which is why an
              "Alaskan Thunderfuck (Pre-Rolls)" group never sees "Dank Rolling Papers (Accessories)" as a
              candidate even though both share the same brand string.
            </p>
            <p>
              The legacy observation-derived match path is disabled by default for speed. Append
              <code> ?includeLegacy=true</code> to the bundle URL to re-enable it for a single group.
            </p>
          </div>
        </details>
      </section>
    </div>
  )
}

interface TypeaheadFilterProps {
  label: string
  listId: string
  value: string
  options: string[]
  onChange: (next: string) => void
  onApply: (committed: string) => void
}

/**
 * Free-text input backed by a native <datalist> so the browser
 * provides type-as-you-go autocomplete against the supplied option
 * list (no JS popover required). Auto-commits the filter whenever
 * the typed value exactly matches one of the supplied options (which
 * is what happens when the user clicks a dropdown entry) and when
 * the input is cleared, so the reviewer doesn't have to chase an
 * "Apply" button after each pick. Enter and blur also commit.
 */
function TypeaheadFilter({ label, listId, value, options, onChange, onApply }: TypeaheadFilterProps): JSX.Element {
  const knownSet = useMemo(() => new Set(options), [options])
  return (
    <>
      <input
        list={listId}
        onBlur={(e) => {
          const v = e.currentTarget.value.trim()
          // Only auto-apply on blur if the value is an exact known
          // option (or empty). Avoids surprising filters from typos.
          if (v.length === 0 || knownSet.has(v)) onApply(v)
        }}
        onChange={(e) => {
          const v = e.currentTarget.value
          onChange(v)
          const trimmed = v.trim()
          if (trimmed.length === 0 || knownSet.has(trimmed)) onApply(trimmed)
        }}
        onKeyDown={(e) => { if (e.key === 'Enter') onApply(e.currentTarget.value.trim()) }}
        placeholder={`Filter by ${label}…`}
        style={{ flex: '0 1 14rem' }}
        value={value}
      />
      <datalist id={listId}>
        {options.map((opt) => <option key={opt} value={opt} />)}
      </datalist>
    </>
  )
}

interface BrandGroupedListProps {
  rows: GroupSummaryRow[]
  expandedGroupId: number | null
  onToggleGroup: (groupId: number) => void
  onError: (msg: string | null) => void
  globalMinScore: number
  brandOverrides: Record<string, number>
  itemOverrides: Record<number, number>
  onSetBrandOverride: (brandKey: string, score: number | null) => void
  onSetItemOverride: (groupId: number, score: number | null) => void
}

/**
 * Top-level grouping for the review queue: brand → product family
 * (collapsible card) → variants. Mirrors the Site → Category →
 * Subcategory → Brand → variant pattern from the Pending Purchases
 * page so reviewers can sweep a whole brand's families at once
 * instead of scrolling through a flat list.
 *
 * Brand sections collapse independently. The catalog group / family
 * row inside each brand still expands inline to the per-size-family
 * review panel (CatalogVariantCard + CandidateTable), so the
 * "expand a family to see all its variants and act on the whole
 * batch" workflow lives at the family card layer that already
 * existed.
 */
function BrandGroupedList({
  rows,
  expandedGroupId,
  onToggleGroup,
  onError,
  globalMinScore,
  brandOverrides,
  itemOverrides,
  onSetBrandOverride,
  onSetItemOverride,
}: BrandGroupedListProps): JSX.Element {
  const groupedByBrand = useMemo(() => {
    const map = new Map<string, { brand: string | null; rows: GroupSummaryRow[] }>()
    for (const row of rows) {
      const key = row.brandName ?? '(No brand)'
      const entry = map.get(key) ?? { brand: row.brandName, rows: [] }
      entry.rows.push(row)
      map.set(key, entry)
    }
    return Array.from(map.entries())
      .map(([key, entry]) => ({ key, brand: entry.brand, rows: entry.rows }))
      .sort((a, b) => a.key.localeCompare(b.key))
  }, [rows])

  const [collapsedBrands, setCollapsedBrands] = useState<Set<string>>(new Set())
  function toggleBrand(key: string): void {
    setCollapsedBrands((cur) => {
      const next = new Set(cur)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  if (rows.length === 0) {
    return <p className="subtle-copy" style={{ margin: '0.75rem 0' }}>No catalog groups match the filters.</p>
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
      {groupedByBrand.map(({ key, brand, rows: brandRows }) => {
        const collapsed = collapsedBrands.has(key)
        const verdictedCount = brandRows.filter((r) => r.liveVerdictCount > 0).length
        const brandOverride = brandOverrides[key]
        const brandEffective = brandOverride ?? globalMinScore
        return (
          <section
            key={key}
            style={{
              border: '1px solid var(--border-color, #d0d0d0)',
              borderRadius: '6px',
              background: 'var(--panel-bg, #fff)',
              overflow: 'hidden',
            }}
          >
            <div
              className="inline-row wrap-row"
              style={{
                width: '100%',
                background: 'rgba(0,0,0,0.04)',
                borderBottom: collapsed ? 'none' : '1px solid var(--border-color, #e0e0e0)',
                padding: '0.55rem 0.75rem',
                justifyContent: 'space-between',
                gap: '0.5rem',
                position: 'sticky',
                top: 0,
                zIndex: 1,
              }}
            >
              <button
                aria-expanded={!collapsed}
                onClick={() => toggleBrand(key)}
                style={{
                  background: 'transparent',
                  border: 'none',
                  padding: 0,
                  cursor: 'pointer',
                  textAlign: 'left',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.4rem',
                  fontWeight: 600,
                  flex: '1 1 auto',
                }}
                type="button"
              >
                <span style={{ display: 'inline-block', width: '0.85rem' }}>{collapsed ? '▸' : '▾'}</span>
                {brand ?? '(No brand)'}
              </button>
              <span className="inline-row" style={{ gap: '0.4rem', alignItems: 'center', flexWrap: 'wrap' }}>
                <Pill tone="muted">{`${brandRows.length} ${brandRows.length === 1 ? 'family' : 'families'}`}</Pill>
                <Pill tone={verdictedCount === brandRows.length ? 'success' : 'muted'}>
                  {`${verdictedCount}/${brandRows.length} reviewed`}
                </Pill>
                <MinScoreSlider
                  inherited={brandOverride === undefined}
                  label="brand min:"
                  onChange={(v) => onSetBrandOverride(key, v)}
                  onReset={brandOverride !== undefined ? () => onSetBrandOverride(key, null) : undefined}
                  value={brandEffective}
                />
              </span>
            </div>
            {collapsed ? null : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem', padding: '0.5rem 0.6rem' }}>
                {brandRows.map((row) => {
                  const itemOverride = itemOverrides[row.catalogGroupId]
                  const itemEffective = itemOverride ?? brandEffective
                  return (
                    <GroupCard
                      effectiveMinScore={itemEffective}
                      expanded={expandedGroupId === row.catalogGroupId}
                      isItemOverride={itemOverride !== undefined}
                      key={row.catalogGroupId}
                      onError={onError}
                      onResetItemOverride={() => onSetItemOverride(row.catalogGroupId, null)}
                      onSetItemOverride={(v) => onSetItemOverride(row.catalogGroupId, v)}
                      onToggle={() => onToggleGroup(row.catalogGroupId)}
                      row={row}
                    />
                  )
                })}
              </div>
            )}
          </section>
        )
      })}
    </div>
  )
}

interface MinScoreSliderProps {
  value: number
  onChange: (next: number) => void
  label?: string
  inherited?: boolean
  onReset?: () => void
}

function MinScoreSlider({ value, onChange, label, inherited, onReset }: MinScoreSliderProps): JSX.Element {
  return (
    <span
      className="inline-row"
      style={{ gap: '0.3rem', alignItems: 'center', fontSize: '0.8rem' }}
      title={inherited ? 'Inherited; move to override at this scope' : 'Override active; click ↻ to inherit'}
    >
      {label ? <span className="subtle-copy">{label}</span> : null}
      <input
        max={1}
        min={0}
        onChange={(e) => onChange(Number.parseFloat(e.currentTarget.value))}
        step={0.05}
        style={{ width: '6rem' }}
        type="range"
        value={value}
      />
      <span
        style={{
          fontVariantNumeric: 'tabular-nums',
          minWidth: '2.2rem',
          textAlign: 'right',
          opacity: inherited ? 0.6 : 1,
          fontWeight: inherited ? 400 : 600,
        }}
      >
        {value.toFixed(2)}
      </span>
      {onReset ? (
        <button
          className="ghost-button"
          onClick={onReset}
          style={{ padding: '0.1rem 0.35rem', fontSize: '0.72rem', lineHeight: 1.1 }}
          title="Inherit from parent scope"
          type="button"
        >
          ↻
        </button>
      ) : null}
    </span>
  )
}

interface GroupCardProps {
  row: GroupSummaryRow
  expanded: boolean
  onToggle: () => void
  onError: (msg: string | null) => void
  effectiveMinScore: number
  isItemOverride: boolean
  onSetItemOverride: (score: number) => void
  onResetItemOverride: () => void
}

function GroupCard({
  row,
  expanded,
  onToggle,
  onError,
  effectiveMinScore,
  isItemOverride,
  onSetItemOverride,
  onResetItemOverride,
}: GroupCardProps): JSX.Element {
  return (
    <div
      style={{
        border: '1px solid var(--border-color, #d0d0d0)',
        borderRadius: '6px',
        padding: '0.6rem 0.75rem',
        background: 'var(--panel-bg, #fff)',
      }}
    >
      <div className="inline-row wrap-row" style={{ justifyContent: 'space-between', gap: '0.5rem' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.15rem', flex: '1 1 18rem' }}>
          <Link
            style={{ fontWeight: 600 }}
            to={buildHeliosModulePath('catalog', `groups/${row.catalogGroupId}`)}
          >
            {row.groupName}
          </Link>
          <span className="subtle-copy" style={{ fontSize: '0.8rem' }}>
            {row.brandName ?? '—'} · {row.categoryName ?? '—'}
            {row.subcategoryName ? ` · ${row.subcategoryName}` : ''}
          </span>
        </div>
        <div className="inline-row" style={{ gap: '0.4rem', alignItems: 'center' }}>
          <Pill tone={row.liveVerdictCount > 0 ? 'success' : 'muted'}>{`${row.liveVerdictCount} verdicts`}</Pill>
          <span
            title={`${row.highQualityFuzzyCount} brand+category matches of ${row.parsedFuzzyCount} total LitAlerts rows for this brand`}
          >
            <Pill tone={row.highQualityFuzzyCount > 0 ? 'success' : 'muted'}>
              {`${row.highQualityFuzzyCount}/${row.parsedFuzzyCount} obs`}
            </Pill>
          </span>
          <button className="ghost-button" onClick={onToggle} type="button">
            {expanded ? 'Collapse' : 'Review'}
          </button>
        </div>
      </div>
      {expanded ? (
        <GroupReviewPanel
          catalogGroupId={row.catalogGroupId}
          effectiveMinScore={effectiveMinScore}
          isItemOverride={isItemOverride}
          onError={onError}
          onResetItemOverride={onResetItemOverride}
          onSetItemOverride={onSetItemOverride}
        />
      ) : null}
    </div>
  )
}

interface GroupReviewPanelProps {
  catalogGroupId: number
  onError: (msg: string | null) => void
  effectiveMinScore: number
  isItemOverride: boolean
  onSetItemOverride: (score: number) => void
  onResetItemOverride: () => void
}

function GroupReviewPanel({
  catalogGroupId,
  onError,
  effectiveMinScore,
  isItemOverride,
  onSetItemOverride,
  onResetItemOverride,
}: GroupReviewPanelProps): JSX.Element {
  const [bundle, setBundle] = useState<GroupReviewBundle | null>(null)
  const [loading, setLoading] = useState(false)
  const [pendingFuzzyId, setPendingFuzzyId] = useState<number | null>(null)
  const [activeSizeKey, setActiveSizeKey] = useState<string | null>(null)

  // Fetch once per expanded row — no minScore query param. The server
  // returns the top N candidates per size group regardless of
  // threshold (see catalogMarketMatchQueries.loadGroupReview); the
  // slider below is a pure client-side filter applied during render.
  // Re-fetch-on-slider-move was what made the prior slider feel
  // inoperative — it triggered a 1-2s round-trip + re-render that
  // visibly lagged the slider's animation frame.
  const load = useCallback(async () => {
    setLoading(true)
    onError(null)
    try {
      const next = await loadJson(
        `/api/catalog/market-matches/${catalogGroupId}`,
        BundleSchema,
      )
      setBundle(next)
      // Default active size = first size with any candidates, else
      // first with variants. We check the raw bundle (not the slider-
      // filtered list) so the size with the best candidate is always
      // initially selected.
      const sizeWithCandidates = next.sizeGroups.find((g) => g.candidates.length > 0)
      const firstSize = sizeWithCandidates ?? next.sizeGroups[0]
      setActiveSizeKey(firstSize?.sizeKey ?? null)
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Failed to load review bundle')
      setBundle(null)
    } finally {
      setLoading(false)
    }
  }, [catalogGroupId, onError])

  useEffect(() => { void load() }, [load])

  async function recordVerdict(
    fuzzySkuId: number,
    verdict: 'exact' | 'brand_family' | 'no_match',
    confidenceAtVerdict: number | null,
    catalogProductId: number | null,
  ): Promise<void> {
    if (!bundle || pendingFuzzyId !== null) return
    setPendingFuzzyId(fuzzySkuId)
    onError(null)
    try {
      await mutateJson('/api/catalog/market-matches', VerdictResponseSchema, {
        method: 'POST',
        body: JSON.stringify({
          catalogGroupId: bundle.catalogGroupId,
          catalogProductId,
          fuzzySkuId,
          verdict,
          confidenceAtVerdict,
        }),
      })
      // Optimistic local update: drop the candidate, decrement counts.
      setBundle((cur) => {
        if (!cur) return cur
        const next: GroupReviewBundle = {
          ...cur,
          sizeGroups: cur.sizeGroups.map((g) => ({
            ...g,
            candidates: g.candidates.filter((c) => c.fuzzy.id !== fuzzySkuId),
          })),
          unmatchedCandidates: cur.unmatchedCandidates.filter((c) => c.fuzzy.id !== fuzzySkuId),
        }
        next.visibleCandidateCount = Math.max(0, cur.visibleCandidateCount - 1)
        return next
      })
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Verdict failed')
    } finally {
      setPendingFuzzyId(null)
    }
  }

  if (loading && !bundle) {
    return <p className="subtle-copy" style={{ padding: '0.75rem 0' }}>Loading review bundle…</p>
  }
  if (!bundle) return <p className="subtle-copy">No data.</p>

  // Apply the client-side slider filter to each size group's
  // candidates. The top candidate (the highest-scoring row in the
  // already-rank-sorted list from the server) is preserved no matter
  // how aggressive the slider is, so a "show me only ≥0.99 matches"
  // sweep never hides the one row a reviewer actually wants to act
  // on. Anything dropped from the visible list is counted into
  // `suppressedCount` so the UI can show "+N below threshold".
  const filteredSizeGroups: SizeGroup[] = bundle.sizeGroups.map((g) => {
    const sorted = [...g.candidates].sort((a, b) => b.finalScore - a.finalScore)
    const visible: Candidate[] = []
    let suppressedCount = 0
    sorted.forEach((c, idx) => {
      if (idx === 0 || c.finalScore >= effectiveMinScore) visible.push(c)
      else suppressedCount += 1
    })
    return {
      ...g,
      candidates: visible,
      suppressedCandidateCount: suppressedCount,
    }
  })
  const filteredUnmatched: Candidate[] = (() => {
    const sorted = [...bundle.unmatchedCandidates].sort((a, b) => b.finalScore - a.finalScore)
    return sorted.filter((c, idx) => idx === 0 || c.finalScore >= effectiveMinScore)
  })()
  const visibleTotal =
    filteredSizeGroups.reduce((sum, g) => sum + g.candidates.length, 0) + filteredUnmatched.length
  const suppressedTotal =
    bundle.sizeGroups.reduce((sum, g) => sum + g.candidates.length, 0)
    + bundle.unmatchedCandidates.length
    - visibleTotal

  const activeGroup =
    filteredSizeGroups.find((g) => g.sizeKey === activeSizeKey) ?? filteredSizeGroups[0] ?? null

  return (
    <div style={{ marginTop: '0.75rem', borderTop: '1px solid var(--border-color, #e0e0e0)', paddingTop: '0.75rem' }}>
      <div className="inline-row wrap-row" style={{ gap: '0.6rem', alignItems: 'center', marginBottom: '0.5rem' }}>
        {bundle.groupImageUrl ? (
          <img
            alt=""
            src={bundle.groupImageUrl}
            style={{ width: '3.5rem', height: '3.5rem', objectFit: 'cover', borderRadius: '4px', border: '1px solid #ddd' }}
          />
        ) : null}
        <div style={{ flex: '1 1 12rem' }}>
          <div style={{ fontWeight: 600 }}>{bundle.groupName}</div>
          <div className="subtle-copy" style={{ fontSize: '0.8rem' }}>
            {bundle.brandName ?? '—'} · {bundle.categoryName ?? '—'}
            {bundle.subcategoryName ? ` · ${bundle.subcategoryName}` : ''}
          </div>
          <div className="subtle-copy" style={{ fontSize: '0.78rem', marginTop: '0.2rem' }}>
            {`${visibleTotal} above ${effectiveMinScore.toFixed(2)} · ${suppressedTotal} below (auto no-match; top candidate always shown)`}
            {` · ${bundle.liveVerdicts.length} live verdict${bundle.liveVerdicts.length === 1 ? '' : 's'}`}
          </div>
        </div>
        <MinScoreSlider
          inherited={!isItemOverride}
          label="item min:"
          onChange={onSetItemOverride}
          onReset={isItemOverride ? onResetItemOverride : undefined}
          value={effectiveMinScore}
        />
      </div>

      {filteredSizeGroups.length === 0 ? (
        <p className="subtle-copy">No catalog variants parsed for this group.</p>
      ) : (
        <div className="inline-row wrap-row" style={{ gap: '0.3rem', marginBottom: '0.5rem' }}>
          {filteredSizeGroups.map((g) => {
            const isActive = activeSizeKey === g.sizeKey
            const count = g.candidates.length
            return (
              <button
                className={isActive ? 'primary-button' : 'ghost-button'}
                key={g.sizeKey}
                onClick={() => setActiveSizeKey(g.sizeKey)}
                style={{ padding: '0.25rem 0.6rem', fontSize: '0.85rem' }}
                type="button"
              >
                {g.sizeLabel} {count > 0 ? `(${count})` : ''}
              </button>
            )
          })}
        </div>
      )}

      {activeGroup ? (
        <SizeGroupPanel
          group={activeGroup}
          ourContext={{
            brand: bundle.brandName,
            category: bundle.categoryName,
            subcategory: bundle.subcategoryName,
          }}
          onVerdict={recordVerdict}
          pendingFuzzyId={pendingFuzzyId}
        />
      ) : null}

      {filteredUnmatched.length > 0 ? (
        <details style={{ marginTop: '1rem' }}>
          <summary>{`${filteredUnmatched.length} candidate(s) without a matched catalog variant`}</summary>
          <MarketReviewTable
            candidates={filteredUnmatched}
            ourContext={{
              brand: bundle.brandName,
              category: bundle.categoryName,
              subcategory: bundle.subcategoryName,
            }}
            onVerdict={recordVerdict}
            pendingFuzzyId={pendingFuzzyId}
            productId={null}
          />
        </details>
      ) : null}

      {bundle.liveVerdicts.length > 0 ? (
        <details style={{ marginTop: '1rem' }}>
          <summary>{`Live verdicts (${bundle.liveVerdicts.length})`}</summary>
          <ul style={{ marginTop: '0.4rem', paddingLeft: '1rem' }}>
            {bundle.liveVerdicts.map((v) => (
              <li key={v.id} style={{ marginBottom: '0.2rem' }}>
                <Pill tone={v.verdict === 'exact' ? 'success' : v.verdict === 'brand_family' ? 'muted' : 'warning'}>
                  {v.verdict}
                </Pill>{' '}
                {v.fuzzy.rawInputJsonb?.listingName ?? '—'}
                <span className="subtle-copy" style={{ fontSize: '0.8rem' }}>
                  {' '}· {v.dispensaryName ?? '—'} · {v.verdictSetByUserId}
                </span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  )
}

interface OurContext {
  brand: string | null
  category: string | null
  subcategory: string | null
}

interface SizeGroupPanelProps {
  group: SizeGroup
  ourContext: OurContext
  onVerdict: (fuzzyId: number, verdict: 'exact' | 'brand_family' | 'no_match', conf: number | null, productId: number | null) => void
  pendingFuzzyId: number | null
}

function SizeGroupPanel({ group, ourContext, onVerdict, pendingFuzzyId }: SizeGroupPanelProps): JSX.Element {
  const firstVariantId = group.variants[0]?.catalogProductId ?? null
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
      <div
        className="inline-row wrap-row"
        style={{
          gap: '0.4rem',
          alignItems: 'center',
          padding: '0.3rem 0.5rem',
          background: 'rgba(0,0,0,0.04)',
          borderRadius: '4px',
          fontSize: '0.85rem',
        }}
      >
        <Pill tone="muted">{`Size ${group.sizeLabel}`}</Pill>
        <span className="subtle-copy">
          {`${group.variants.length} catalog variant${group.variants.length === 1 ? '' : 's'} · ${group.candidates.length} candidate${group.candidates.length === 1 ? '' : 's'} above threshold`}
          {group.suppressedCandidateCount > 0
            ? ` · ${group.suppressedCandidateCount} hidden`
            : ''}
        </span>
      </div>
      <MarketReviewTable
        candidates={group.candidates}
        emptyMessage={`No candidates above threshold for ${group.sizeLabel}.${group.suppressedCandidateCount > 0 ? ` ${group.suppressedCandidateCount} hidden as auto no-match.` : ''}`}
        onVerdict={onVerdict}
        ourContext={ourContext}
        ourVariants={group.variants}
        pendingFuzzyId={pendingFuzzyId}
        productId={firstVariantId}
      />
      {group.suppressedCandidateCount > 0 ? (
        <span className="subtle-copy" style={{ fontSize: '0.78rem' }}>
          {`+${group.suppressedCandidateCount} below threshold (auto no-match)`}
        </span>
      ) : null}
    </div>
  )
}

/* ─────────────────────────────────────────────────────────────────────
 * Tabular product-review renderer.
 *
 * The candidates we get from the scorer are *structured*: every field
 * (brand / category / subcategory / size / pack / strain) has its own
 * normalized value AND its own scoring factor in [0, 1]. The original
 * card-per-candidate layout buried this structure inside two lines of
 * prose, so a reviewer couldn't tell at a glance which cell was
 * pulling the score up vs. down — and the most common failure mode
 * (the parser couldn't extract a brand, so factor=0 nukes the whole
 * product) was invisible until you opened the "Score factors" detail.
 *
 * Now: one HTML <table> per size group. The catalog row ("OURS") sits
 * directly beneath the headers so the reviewer can scan-compare
 * column-by-column. Each candidate cell is shaded by its own factor
 * value, so a row with a red Brand cell screams "no brand match" no
 * matter what the final score says.
 * ───────────────────────────────────────────────────────────────── */

const TABLE_TH: React.CSSProperties = {
  padding: '0.35rem 0.45rem',
  fontSize: '0.7rem',
  fontWeight: 600,
  textAlign: 'left',
  background: 'rgba(0,0,0,0.05)',
  borderBottom: '2px solid var(--border-color, #c8c8c8)',
  textTransform: 'uppercase',
  letterSpacing: '0.04em',
  whiteSpace: 'nowrap',
  position: 'sticky',
  top: 0,
  zIndex: 1,
}

const TABLE_TD: React.CSSProperties = {
  padding: '0.35rem 0.45rem',
  fontSize: '0.78rem',
  verticalAlign: 'top',
  borderBottom: '1px solid var(--border-color, #ececec)',
}

/**
 * Background tint per per-field factor value. The contribution shaping
 * is intentionally coarse so it pops at a glance:
 *   - 0       red     (factor zeroed the product; the killer cell)
 *   - <0.5    orange  (significant drag)
 *   - <0.85   yellow  (partial / aliasy / one-sided info)
 *   - <1.0    light-green (close, e.g. gaussian size near miss)
 *   - 1.0     green   (exact)
 */
function factorTone(v: number): React.CSSProperties {
  if (v <= 0) return { background: 'rgba(220, 53, 69, 0.22)' }
  if (v < 0.5) return { background: 'rgba(253, 126, 20, 0.20)' }
  if (v < 0.85) return { background: 'rgba(255, 193, 7, 0.22)' }
  if (v < 1.0) return { background: 'rgba(40, 167, 69, 0.14)' }
  return { background: 'rgba(40, 167, 69, 0.28)' }
}

function scoreTone(score: number): React.CSSProperties {
  if (score >= 0.85) return { background: 'rgba(40, 167, 69, 0.28)' }
  if (score >= 0.70) return { background: 'rgba(40, 167, 69, 0.14)' }
  if (score >= 0.40) return { background: 'rgba(255, 193, 7, 0.22)' }
  if (score > 0) return { background: 'rgba(253, 126, 20, 0.20)' }
  return { background: 'rgba(220, 53, 69, 0.22)' }
}

const OUR_ROW_TINT: React.CSSProperties = { background: 'rgba(0, 123, 255, 0.06)' }

function formatSizeNorm(g: number | null, mg: number | null): string {
  if (typeof g === 'number') return `${g}g`
  if (typeof mg === 'number') return `${mg}mg`
  return '—'
}

interface MarketReviewTableProps {
  candidates: Candidate[]
  ourContext: OurContext
  ourVariants?: CatalogVariant[]
  productId: number | null
  onVerdict: (fuzzyId: number, verdict: 'exact' | 'brand_family' | 'no_match', conf: number | null, productId: number | null) => void
  pendingFuzzyId: number | null
  emptyMessage?: string
}

function MarketReviewTable({
  candidates,
  ourContext,
  ourVariants,
  productId,
  onVerdict,
  pendingFuzzyId,
  emptyMessage,
}: MarketReviewTableProps): JSX.Element {
  const headers = ['Img', 'Listing / Dispensary', 'Brand', 'Category', 'Subcategory', 'Size', 'Pack', 'Strain', 'Score', 'Verdict']
  return (
    <div style={{ overflowX: 'auto', border: '1px solid var(--border-color, #d8d8d8)', borderRadius: '4px' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.78rem' }}>
        <thead>
          <tr>
            {headers.map((h) => (
              <th key={h} style={TABLE_TH}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {(ourVariants ?? []).map((v) => (
            <OurVariantRow ctx={ourContext} key={v.catalogProductId} variant={v} />
          ))}
          {candidates.length === 0 ? (
            <tr>
              <td
                colSpan={headers.length}
                style={{ ...TABLE_TD, fontStyle: 'italic', color: 'var(--subtle-text, #777)' }}
              >
                {emptyMessage ?? 'No candidates above threshold.'}
              </td>
            </tr>
          ) : (
            candidates.map((c) => (
              <CandidateTableRow
                candidate={c}
                key={c.fuzzy.id}
                onVerdict={onVerdict}
                pendingFuzzyId={pendingFuzzyId}
                productId={productId}
              />
            ))
          )}
        </tbody>
      </table>
    </div>
  )
}

function OurVariantRow({ variant, ctx }: { variant: CatalogVariant; ctx: OurContext }): JSX.Element {
  const cell = { ...TABLE_TD, ...OUR_ROW_TINT }
  return (
    <tr style={{ borderTop: '2px solid rgba(0,123,255,0.45)' }}>
      <td style={cell}>
        {variant.imageUrl ? (
          <img
            alt=""
            src={variant.imageUrl}
            style={{ width: '2rem', height: '2rem', objectFit: 'cover', borderRadius: '3px', border: '1px solid #ddd', display: 'block' }}
          />
        ) : (
          <span className="subtle-copy" style={{ fontSize: '0.7rem' }}>no img</span>
        )}
      </td>
      <td style={cell}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', flexWrap: 'wrap' }}>
          <Pill tone="success">OURS</Pill>
          <span style={{ fontWeight: 600 }}>
            {variant.shortName ?? variant.name ?? `Product ${variant.catalogProductId}`}
          </span>
        </div>
        <div className="subtle-copy" style={{ fontSize: '0.7rem', marginTop: '0.1rem' }}>
          {variant.sku ? `SKU ${variant.sku}` : '—'}
          {variant.price != null ? ` · $${variant.price.toFixed(2)}` : ''}
        </div>
      </td>
      <td style={cell}>{ctx.brand ?? '—'}</td>
      <td style={cell}>{ctx.category ?? '—'}</td>
      <td style={cell}>{ctx.subcategory ?? '—'}</td>
      <td style={cell}>{variant.sizeLabel || formatSizeNorm(variant.sizeGNorm, variant.sizeMgNorm)}</td>
      <td style={cell}>{variant.packCountNorm ?? '—'}</td>
      <td style={cell}>—</td>
      <td style={{ ...cell, textAlign: 'center' }}>
        <Pill tone="success">target</Pill>
      </td>
      <td style={cell}>—</td>
    </tr>
  )
}

function CandidateTableRow({
  candidate,
  onVerdict,
  pendingFuzzyId,
  productId,
}: {
  candidate: Candidate
  onVerdict: MarketReviewTableProps['onVerdict']
  pendingFuzzyId: number | null
  productId: number | null
}): JSX.Element {
  const c = candidate
  const isPending = pendingFuzzyId === c.fuzzy.id
  const disabled = isPending || pendingFuzzyId !== null
  const btnStyle: React.CSSProperties = { padding: '0.15rem 0.4rem', fontSize: '0.72rem', lineHeight: 1.2 }
  return (
    <tr>
      <td style={TABLE_TD}>
        {c.imageUrl ? (
          <img
            alt=""
            loading="lazy"
            src={c.imageUrl}
            style={{ width: '2rem', height: '2rem', objectFit: 'cover', borderRadius: '3px', border: '1px solid #ddd', display: 'block' }}
          />
        ) : (
          <span className="subtle-copy" style={{ fontSize: '0.7rem' }}>—</span>
        )}
      </td>
      <td style={TABLE_TD}>
        <div>
          {c.listingUrl ? (
            <a href={c.listingUrl} rel="noreferrer" target="_blank" style={{ fontWeight: 500 }}>
              {c.fuzzy.rawInputJsonb?.listingName ?? '—'}
            </a>
          ) : (
            <span style={{ fontWeight: 500 }}>{c.fuzzy.rawInputJsonb?.listingName ?? '—'}</span>
          )}
        </div>
        <div className="subtle-copy" style={{ fontSize: '0.7rem', marginTop: '0.1rem' }}>
          {c.dispensaryName ?? '—'}
        </div>
      </td>
      <td style={{ ...TABLE_TD, ...factorTone(c.factors.brand) }} title={`brand factor ${c.factors.brand.toFixed(2)}`}>
        {c.fuzzy.brandNorm ?? '—'}
      </td>
      <td style={{ ...TABLE_TD, ...factorTone(c.factors.category) }} title={`category factor ${c.factors.category.toFixed(2)}`}>
        {c.fuzzy.categoryNorm ?? '—'}
      </td>
      <td style={{ ...TABLE_TD, ...factorTone(c.factors.subcategory) }} title={`subcategory factor ${c.factors.subcategory.toFixed(2)}`}>
        {c.fuzzy.subcategoryNorm ?? '—'}
      </td>
      <td style={{ ...TABLE_TD, ...factorTone(c.factors.size) }} title={`size factor ${c.factors.size.toFixed(2)}`}>
        {formatSizeNorm(c.fuzzy.sizeGNorm, c.fuzzy.sizeMgNorm)}
      </td>
      <td style={{ ...TABLE_TD, ...factorTone(c.factors.pack) }} title={`pack factor ${c.factors.pack.toFixed(2)}`}>
        {c.fuzzy.packCountNorm ?? '—'}
      </td>
      <td style={{ ...TABLE_TD, ...factorTone(c.factors.strain) }} title={`strain factor ${c.factors.strain.toFixed(2)}`}>
        {c.fuzzy.strainNorm ?? '—'}
      </td>
      <td style={{ ...TABLE_TD, ...scoreTone(c.finalScore), textAlign: 'center', fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>
        {c.finalScore.toFixed(2)}
      </td>
      <td style={TABLE_TD}>
        <div className="inline-row" style={{ gap: '0.2rem' }}>
          <button
            className="ghost-button"
            disabled={disabled}
            onClick={() => onVerdict(c.fuzzy.id, 'exact', c.finalScore, productId)}
            style={btnStyle}
            title="Exact match"
            type="button"
          >
            ✓
          </button>
          <button
            className="ghost-button"
            disabled={disabled}
            onClick={() => onVerdict(c.fuzzy.id, 'brand_family', c.finalScore, productId)}
            style={btnStyle}
            title="Brand/family match"
            type="button"
          >
            ≈
          </button>
          <button
            className="ghost-button"
            disabled={disabled}
            onClick={() => onVerdict(c.fuzzy.id, 'no_match', c.finalScore, productId)}
            style={btnStyle}
            title="No match"
            type="button"
          >
            ✗
          </button>
        </div>
      </td>
    </tr>
  )
}
