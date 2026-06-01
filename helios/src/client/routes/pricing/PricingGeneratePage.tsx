import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Form, Link, useLoaderData, useNavigate, useNavigation } from 'react-router-dom'

import {
  PricingFacetsResponseSchema,
  PricingScopePreviewResponseSchema,
  QueuePricingRunAcceptedResponseSchema,
  QueuePricingRunRequestSchema,
  buildHeliosModulePath,
  type PricingFacetField,
  type PricingFacetOption,
  type PricingNewRunScopeKind,
  type PricingScopePreviewResponse,
  type PricingSiteKey,
} from '../../../shared/contracts/index.js'
import { loadJson, mutateJson } from '../../app/fetchJson.js'
import { Pill } from '../../components/Pill.js'
import { useRegisterCatalogSidebarSubtree } from '../catalog/catalogSidebarSubtree.js'
import { PricingNav } from './PricingNav.js'

const SITE_OPTIONS: { key: PricingSiteKey; label: string }[] = [
  { key: 'bronx', label: 'Bronx' },
  { key: 'midtown', label: 'Midtown' },
]

export async function pricingGenerateLoader({ request }: { request: Request }) {
  const url = new URL(request.url)
  return loadJson(`/api/pricing/scope-preview${url.search}`, PricingScopePreviewResponseSchema)
}

export function PricingGeneratePage() {
  // Pricing pages live under Catalog in the sidebar — register the
  // catalog subtree so the Pricing branch (and its sibling Catalog
  // leaves) stay visible while reviewing/creating runs.
  useRegisterCatalogSidebarSubtree()
  const preview = useLoaderData() as PricingScopePreviewResponse
  const navigate = useNavigate()
  const navigation = useNavigation()
  const [scopeKind, setScopeKind] = useState<PricingNewRunScopeKind>(preview.filters.scopeKind)
  const [search, setSearch] = useState(preview.filters.search ?? '')
  const [brands, setBrands] = useState<string[]>(preview.filters.brands)
  const [categories, setCategories] = useState<string[]>(preview.filters.categories)
  const [subcategories, setSubcategories] = useState<string[]>(preview.filters.subcategories)
  const [unitSizes, setUnitSizes] = useState<string[]>(preview.filters.unitSizes)
  const [packSizes, setPackSizes] = useState<string[]>(preview.filters.packSizes)
  const [sites, setSites] = useState<PricingSiteKey[]>(preview.filters.sites)
  const [stockOnly, setStockOnly] = useState<boolean>(preview.filters.stockOnly)
  const [includePending, setIncludePending] = useState<boolean>(preview.filters.includePending)
  const [strict, setStrict] = useState<boolean>(preview.filters.strict)
  const [scopeLabel, setScopeLabel] = useState('')
  const [forceLiveRefresh, setForceLiveRefresh] = useState(false)
  const [isQueueing, setIsQueueing] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const pricingGeneratePath = buildHeliosModulePath('pricing', 'generate')
  const isPreviewLoading = navigation.state !== 'idle' && navigation.location?.pathname === pricingGeneratePath
  const hiddenPreviewGroupCount = Math.max(0, preview.matchedCatalogGroupCount - preview.previewGroups.length)

  useEffect(() => {
    setScopeKind(preview.filters.scopeKind)
    setSearch(preview.filters.search ?? '')
    setBrands(preview.filters.brands)
    setCategories(preview.filters.categories)
    setSubcategories(preview.filters.subcategories)
    setUnitSizes(preview.filters.unitSizes)
    setPackSizes(preview.filters.packSizes)
    setSites(preview.filters.sites)
    setStockOnly(preview.filters.stockOnly)
    setIncludePending(preview.filters.includePending)
    setStrict(preview.filters.strict)
  }, [preview])

  const derivedScopeLabel = useMemo(() => {
    if (scopeLabel.trim().length > 0) {
      return scopeLabel.trim()
    }
    const parts: string[] = []
    if (scopeKind === 'family_expansion_from_stock_or_pending') {
      parts.push(strict ? 'Stock+pending (strict)' : 'Family expansion')
    } else if (scopeKind === 'full_catalog') {
      parts.push('Full catalog')
    }
    if (brands.length > 0) parts.push(brands.join(', '))
    if (categories.length > 0) parts.push(categories.join(', '))
    if (subcategories.length > 0) parts.push(subcategories.join(', '))
    if (unitSizes.length > 0) parts.push(unitSizes.join(', '))
    if (packSizes.length > 0) parts.push(packSizes.map(formatPackSizeLabel).join(', '))
    if (search.trim().length > 0) parts.push(search.trim())
    const sourceLabels = buildSourceLabels({ sites, stockOnly, includePending })
    if (sourceLabels.length > 0) parts.push(...sourceLabels)
    return parts.length > 0 ? parts.join(' · ') : 'Filtered catalog'
  }, [brands, categories, includePending, packSizes, scopeKind, scopeLabel, search, sites, stockOnly, strict, subcategories, unitSizes])

  async function handleQueueRun() {
    setIsQueueing(true)
    setErrorMessage(null)

    try {
      const body = QueuePricingRunRequestSchema.parse({
        brands,
        categories,
        forceLiveRefresh,
        includePending,
        packSizes,
        reason: `Queue pricing run for ${derivedScopeLabel}`,
        scopeKind,
        scopeLabel: derivedScopeLabel,
        search: search.trim() || undefined,
        sites,
        stockOnly,
        strict,
        subcategories,
        unitSizes,
      })

      const response = await mutateJson('/api/pricing/runs', QueuePricingRunAcceptedResponseSchema, {
        body: JSON.stringify(body),
        method: 'POST',
      })

      await navigate(
        buildHeliosModulePath('pricing', `runs/${response.proposalBatchId}`),
      )
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Could not queue the pricing run.')
    } finally {
      setIsQueueing(false)
    }
  }

  function toggleSite(siteKey: PricingSiteKey): void {
    setSites((current) => (current.includes(siteKey)
      ? current.filter((existing) => existing !== siteKey)
      : [...current, siteKey]))
  }

  return (
    <section>
      <div className="page-header">
        <div>
          <p className="eyebrow">New Pricing Run</p>
          <h2>Create a pricing run</h2>
        </div>
        <Pill tone="warning">approval required</Pill>
      </div>
      <PricingNav />

      {errorMessage ? <p className="error-text">{errorMessage}</p> : null}

      <div className="detail-grid">
        <article className="detail-panel">
          <h3>Choose products</h3>
          <Form method="get">
            <label className="stack-field">
              <span>Scope</span>
              <select name="scopeKind" onChange={(event) => setScopeKind(event.currentTarget.value as PricingNewRunScopeKind)} value={scopeKind}>
                <option value="family_expansion_from_stock_or_pending">Stock + pending (family expanded)</option>
                <option value="filtered_catalog">Filtered catalog</option>
                <option value="full_catalog">Entire catalog</option>
              </select>
            </label>

            <fieldset className="stack-field" style={{ border: '1px solid var(--border, #e3e3e3)', borderRadius: 4, padding: '0.5rem' }}>
              <legend>Sites</legend>
              <div className="inline-row wrap-row">
                {SITE_OPTIONS.map((site) => {
                  const checked = sites.includes(site.key)
                  return (
                    <label
                      key={site.key}
                      className={`inline-row${checked ? ' chip-selected' : ''}`}
                      style={{
                        background: checked ? 'var(--accent-soft, #e6f4ea)' : 'var(--surface, #f7f7f7)',
                        border: '1px solid var(--border, #d6d6d6)',
                        borderRadius: 999,
                        cursor: 'pointer',
                        padding: '0.25rem 0.75rem',
                      }}
                    >
                      <input
                        checked={checked}
                        name="sites"
                        onChange={() => toggleSite(site.key)}
                        type="checkbox"
                        value={site.key}
                      />
                      {site.label}
                    </label>
                  )
                })}
              </div>
            </fieldset>

            <div className="stack-field">
              <span>Source</span>
              <label className="inline-row wrap-row">
                <input
                  checked={stockOnly}
                  name="stockOnly"
                  onChange={(event) => setStockOnly(event.currentTarget.checked)}
                  type="checkbox"
                  value="true"
                />
                Include products in stock at selected sites
              </label>
              <label className="inline-row wrap-row">
                <input
                  checked={includePending}
                  name="includePending"
                  onChange={(event) => setIncludePending(event.currentTarget.checked)}
                  type="checkbox"
                  value="true"
                />
                Include products on non-cancelled pending purchases at selected sites
              </label>
              <label className="inline-row wrap-row">
                <input
                  checked={strict}
                  name="strict"
                  onChange={(event) => setStrict(event.currentTarget.checked)}
                  type="checkbox"
                  value="true"
                />
                Strict (skip family expansion — re-price only the matching products themselves)
              </label>
            </div>

            <FacetMultiSelect
              facet="brand"
              filters={{
                brands, categories, subcategories, sites, scopeKind,
                unitSizes, packSizes,
                stockOnly, includePending, strict, search: search.trim() || undefined,
              }}
              label="Brands"
              onChange={setBrands}
              value={brands}
            />
            <FacetMultiSelect
              facet="category"
              filters={{
                brands, categories, subcategories, sites, scopeKind,
                unitSizes, packSizes,
                stockOnly, includePending, strict, search: search.trim() || undefined,
              }}
              label="Categories"
              onChange={setCategories}
              value={categories}
            />
            <FacetMultiSelect
              facet="subcategory"
              filters={{
                brands, categories, subcategories, sites, scopeKind,
                unitSizes, packSizes,
                stockOnly, includePending, strict, search: search.trim() || undefined,
              }}
              label="Subcategories"
              onChange={setSubcategories}
              value={subcategories}
            />
            <FacetMultiSelect
              facet="unitSize"
              filters={{
                brands, categories, subcategories, sites, scopeKind,
                unitSizes, packSizes,
                stockOnly, includePending, strict, search: search.trim() || undefined,
              }}
              label="Variant sizes"
              onChange={setUnitSizes}
              value={unitSizes}
            />
            <FacetMultiSelect
              facet="packSize"
              filters={{
                brands, categories, subcategories, sites, scopeKind,
                unitSizes, packSizes,
                stockOnly, includePending, strict, search: search.trim() || undefined,
              }}
              label="Pack sizes"
              onChange={setPackSizes}
              value={packSizes}
            />

            <label className="stack-field">
              <span>Search</span>
              <input
                name="search"
                onChange={(event) => setSearch(event.currentTarget.value)}
                placeholder="Search brand, group, or product"
                value={search}
              />
            </label>

            {/* Repeated hidden inputs let the GET-form preview reload the
                same multiselect arrays without JS state-loss. */}
            {brands.map((value) => <input key={`brand-${value}`} name="brands" type="hidden" value={value} />)}
            {categories.map((value) => <input key={`category-${value}`} name="categories" type="hidden" value={value} />)}
            {subcategories.map((value) => <input key={`subcategory-${value}`} name="subcategories" type="hidden" value={value} />)}
            {unitSizes.map((value) => <input key={`unitSize-${value}`} name="unitSizes" type="hidden" value={value} />)}
            {packSizes.map((value) => <input key={`packSize-${value}`} name="packSizes" type="hidden" value={value} />)}

            <div className="inline-row wrap-row">
              <button className="ghost-button" type="submit">
                {isPreviewLoading ? 'Updating preview…' : 'Preview matches'}
              </button>
              <Link className="ghost-button like-button" to={pricingGeneratePath}>
                Reset filters
              </Link>
              <Link className="ghost-button like-button" to={buildHeliosModulePath('catalog', 'browser')}>
                Browse catalog
              </Link>
            </div>
          </Form>

          <details style={{ marginTop: '0.75rem' }}>
            <summary>How this scope works</summary>
            <ul className="subtle-copy" style={{ marginTop: '0.5rem', paddingLeft: '1rem' }}>
              <li><strong>Stock + pending (family expanded):</strong> for every product in stock or on a pending purchase at the selected sites, include every catalog entry that shares its brand × category × subcategory × size.</li>
              <li><strong>Filtered catalog:</strong> include catalog entries matching the chosen taxonomy / search filters, optionally narrowed by the stock + pending source toggles.</li>
              <li><strong>Entire catalog:</strong> all mirrored catalog entries.</li>
              <li><strong>Strict</strong> turns family expansion off and prices only the in-stock / pending products themselves.</li>
            </ul>
          </details>
        </article>

        <article className="detail-panel">
          <h3>Run details</h3>
          <label className="stack-field">
            <span>Run name</span>
            <input onChange={(event) => setScopeLabel(event.currentTarget.value)} placeholder={derivedScopeLabel} value={scopeLabel} />
          </label>

          <label className="inline-row wrap-row" style={{ marginBottom: '1rem' }}>
            <input checked={forceLiveRefresh} onChange={(event) => setForceLiveRefresh(event.currentTarget.checked)} type="checkbox" />
            Refresh live catalog details before creating this run
          </label>

          <div className="pricing-metric-grid">
            <div className="value-panel">
              <span>Matching groups</span>
              <p>{preview.matchedCatalogGroupCount}</p>
            </div>
            <div className="value-panel">
              <span>Matching products</span>
              <p>{preview.matchedProductCount}</p>
            </div>
            <div className="value-panel">
              <span>Run name</span>
              <p>{derivedScopeLabel}</p>
            </div>
          </div>

          {preview.matchedCatalogGroupCount > 0 ? (
            <div style={{ marginBottom: '1rem' }}>
              <h4 style={{ margin: '0 0 0.5rem' }}>Sample matches</h4>
              <p className="subtle-copy" style={{ marginBottom: '0.75rem' }}>
                Showing {preview.previewGroups.length} of {preview.matchedCatalogGroupCount} matching groups.
                {hiddenPreviewGroupCount > 0 ? ` ${hiddenPreviewGroupCount} more group${hiddenPreviewGroupCount === 1 ? '' : 's'} will be included when you create the run.` : ''}
              </p>
              <ul className="timeline-list">
                {preview.previewGroups.map((group) => (
                  <li key={group.catalogGroupId}>
                    <Link to={buildHeliosModulePath('catalog', `groups/${group.catalogGroupId}`)}>
                      <strong>{group.groupName}</strong>
                    </Link>
                    <div className="subtle-copy">
                      {group.brandName ?? 'No brand'} · {group.categoryName ?? 'No category'} · {group.subcategoryName ?? 'No subcategory'}
                    </div>
                    <div className="subtle-copy">
                      {group.matchedProductCount} matching product{group.matchedProductCount === 1 ? '' : 's'}
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          <button
            className="primary-button"
            disabled={isQueueing || preview.matchedCatalogGroupCount === 0}
            onClick={() => void handleQueueRun()}
            type="button"
          >
            {isQueueing ? 'Creating run…' : `Create run for ${preview.matchedCatalogGroupCount} groups`}
          </button>
        </article>
      </div>
    </section>
  )
}

interface FacetMultiSelectProps {
  facet: PricingFacetField
  filters: {
    brands: string[]
    categories: string[]
    subcategories: string[]
    unitSizes: string[]
    packSizes: string[]
    sites: PricingSiteKey[]
    scopeKind: PricingNewRunScopeKind
    stockOnly: boolean
    includePending: boolean
    strict: boolean
    search?: string
  }
  label: string
  onChange: (next: string[]) => void
  value: string[]
}

function FacetMultiSelect({ facet, filters, label, onChange, value }: FacetMultiSelectProps): JSX.Element {
  const [options, setOptions] = useState<PricingFacetOption[]>([])
  const [searchInPicker, setSearchInPicker] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState(value.length > 0)
  const lastFiltersRef = useRef<string>('')

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const params = new URLSearchParams()
      params.set('facet', facet)
      params.set('scopeKind', filters.scopeKind)
      if (filters.search) params.set('search', filters.search)
      if (searchInPicker.trim().length > 0) params.set('facetSearch', searchInPicker.trim())
      params.set('stockOnly', filters.stockOnly ? 'true' : 'false')
      params.set('includePending', filters.includePending ? 'true' : 'false')
      params.set('strict', filters.strict ? 'true' : 'false')
      for (const brand of filters.brands) params.append('brands', brand)
      for (const cat of filters.categories) params.append('categories', cat)
      for (const sub of filters.subcategories) params.append('subcategories', sub)
      for (const unitSize of filters.unitSizes) params.append('unitSizes', unitSize)
      for (const packSize of filters.packSizes) params.append('packSizes', packSize)
      for (const site of filters.sites) params.append('sites', site)
      const data = await loadJson(`/api/pricing/facets?${params.toString()}`, PricingFacetsResponseSchema)
      setOptions(data.options)
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Could not load options.')
    } finally {
      setLoading(false)
    }
  }, [facet, filters.brands, filters.categories, filters.includePending, filters.packSizes, filters.scopeKind, filters.search, filters.sites, filters.stockOnly, filters.strict, filters.subcategories, filters.unitSizes, searchInPicker])

  useEffect(() => {
    if (!expanded) return
    const fingerprint = JSON.stringify({ facet, filters, searchInPicker })
    if (lastFiltersRef.current === fingerprint) return
    lastFiltersRef.current = fingerprint
    void refresh()
  }, [expanded, facet, filters, refresh, searchInPicker])

  function toggle(option: string): void {
    onChange(value.includes(option)
      ? value.filter((existing) => existing !== option)
      : [...value, option])
  }

  return (
    <div className="stack-field">
      <div className="inline-row wrap-row" style={{ justifyContent: 'space-between' }}>
        <span>{label}{value.length > 0 ? ` (${value.length} selected)` : ''}</span>
        <button
          className="ghost-button"
          onClick={() => setExpanded((current) => !current)}
          type="button"
        >
          {expanded ? 'Hide' : 'Pick'}
        </button>
      </div>
      {value.length > 0 ? (
        <div className="inline-row wrap-row" style={{ marginTop: '0.25rem' }}>
          {value.map((selected) => (
            <button
              key={`chip-${selected}`}
              className="ghost-button"
              onClick={() => toggle(selected)}
              style={{ borderRadius: 999, padding: '0.125rem 0.5rem' }}
              type="button"
            >
              {selected} ✕
            </button>
          ))}
        </div>
      ) : null}
      {expanded ? (
        <div style={{ border: '1px solid var(--border, #ddd)', borderRadius: 4, marginTop: '0.5rem', padding: '0.5rem' }}>
          <input
            onChange={(event) => setSearchInPicker(event.currentTarget.value)}
            placeholder={`Quick search ${label.toLowerCase()}`}
            value={searchInPicker}
          />
          {loading ? <p className="subtle-copy" style={{ marginTop: '0.5rem' }}>Loading…</p> : null}
          {error ? <p className="error-text">{error}</p> : null}
          {!loading && !error ? (
            <ul style={{ listStyle: 'none', margin: '0.5rem 0 0', maxHeight: 240, overflowY: 'auto', padding: 0 }}>
              {options.length === 0 ? (
                <li className="subtle-copy">No options match the current filters.</li>
              ) : null}
              {options.map((option) => (
                <li key={option.value}>
                  <label className="inline-row" style={{ padding: '0.125rem 0' }}>
                    <input
                      checked={option.selected || value.includes(option.value)}
                      onChange={() => toggle(option.value)}
                      type="checkbox"
                    />
                    <span style={{ flex: 1 }}>{facet === 'packSize' ? formatPackSizeLabel(option.value) : option.value}</span>
                    <span className="subtle-copy">{option.rowCount}</span>
                  </label>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

function buildSourceLabels(input: { sites: PricingSiteKey[]; stockOnly: boolean; includePending: boolean }): string[] {
  const siteLabels = input.sites.map((siteKey) => (siteKey === 'bronx' ? 'Bronx' : 'Midtown'))
  const siteSummary = siteLabels.length > 0 ? siteLabels.join('+') : null
  const labels: string[] = []
  if (input.stockOnly) labels.push(siteSummary ? `${siteSummary} in stock` : 'In stock')
  if (input.includePending) labels.push(siteSummary ? `${siteSummary} pending purchases` : 'Pending purchases')
  return labels
}

function formatPackSizeLabel(value: string): string {
  const numeric = Number(value)
  if (Number.isInteger(numeric) && numeric > 0) {
    return numeric === 1 ? '1 per pkg' : `${numeric}-pack`
  }
  return value
}
