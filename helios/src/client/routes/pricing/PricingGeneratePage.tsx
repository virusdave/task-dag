import { useEffect, useMemo, useState } from 'react'
import { Form, Link, useLoaderData, useNavigate, useNavigation } from 'react-router-dom'

import {
  PricingScopePreviewResponseSchema,
  QueuePricingRunAcceptedResponseSchema,
  QueuePricingRunRequestSchema,
  buildHeliosModulePath,
  type PricingScopePreviewResponse,
} from '../../../shared/contracts/index.js'
import { loadJson, mutateJson } from '../../app/fetchJson.js'
import { Pill } from '../../components/Pill.js'
import { useRegisterCatalogSidebarSubtree } from '../catalog/catalogSidebarSubtree.js'
import { PricingNav } from './PricingNav.js'

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
  const [scopeKind, setScopeKind] = useState<'filtered_catalog' | 'full_catalog'>(preview.filters.scopeKind)
  const [search, setSearch] = useState(preview.filters.search ?? '')
  const [brand, setBrand] = useState(preview.filters.brand ?? '')
  const [category, setCategory] = useState(preview.filters.category ?? '')
  const [subcategory, setSubcategory] = useState(preview.filters.subcategory ?? '')
  const [liveBronxInventory, setLiveBronxInventory] = useState(preview.filters.liveBronxInventory)
  const [liveMidtownInventory, setLiveMidtownInventory] = useState(preview.filters.liveMidtownInventory)
  const [midtownEverReceived, setMidtownEverReceived] = useState(preview.filters.midtownEverReceived)
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
    setBrand(preview.filters.brand ?? '')
    setCategory(preview.filters.category ?? '')
    setSubcategory(preview.filters.subcategory ?? '')
    setLiveBronxInventory(preview.filters.liveBronxInventory)
    setLiveMidtownInventory(preview.filters.liveMidtownInventory)
    setMidtownEverReceived(preview.filters.midtownEverReceived)
  }, [preview])

  const derivedScopeLabel = useMemo(() => {
    if (scopeLabel.trim().length > 0) {
      return scopeLabel.trim()
    }
    if (scopeKind === 'full_catalog') {
      return buildCatalogScopeLabel({ liveBronxInventory, liveMidtownInventory, midtownEverReceived })
    }
    const parts = [brand, category, subcategory, search].filter(Boolean)
    const productScopeLabels = buildProductScopeLabels({ liveBronxInventory, liveMidtownInventory, midtownEverReceived })
    if (productScopeLabels.length > 0) {
      parts.push(...productScopeLabels)
    }
    return parts.join(' · ') || 'Filtered catalog'
  }, [brand, category, liveBronxInventory, liveMidtownInventory, midtownEverReceived, scopeKind, scopeLabel, search, subcategory])

  async function handleQueueRun() {
    setIsQueueing(true)
    setErrorMessage(null)

    try {
      const body = QueuePricingRunRequestSchema.parse({
        brand: brand.trim() || undefined,
        category: category.trim() || undefined,
        forceLiveRefresh,
        liveBronxInventory,
        liveMidtownInventory,
        midtownEverReceived,
        reason: `Queue pricing run for ${derivedScopeLabel}`,
        scopeKind,
        scopeLabel: derivedScopeLabel,
        search: search.trim() || undefined,
        subcategory: subcategory.trim() || undefined,
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

  return (
    <section>
      <div className="page-header">
        <div>
          <p className="eyebrow">New Pricing Run</p>
          <h2>Create a pricing run</h2>
          <p className="subtle-copy">
            Choose which products to include, preview the counts, and create a run for review. Creating a run does not update live prices.
            Approved changes are applied later in the background.
          </p>
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
              <select name="scopeKind" onChange={(event) => setScopeKind(event.currentTarget.value as 'filtered_catalog' | 'full_catalog')} value={scopeKind}>
                <option value="full_catalog">Entire catalog</option>
                <option value="filtered_catalog">Use filters</option>
              </select>
            </label>

            <label className="stack-field">
              <span>Search</span>
              <input
                name="search"
                onChange={(event) => setSearch(event.currentTarget.value)}
                placeholder="Search brand, group, or product"
                value={search}
              />
            </label>

            <label className="stack-field">
              <span>Brand</span>
              <input name="brand" onChange={(event) => setBrand(event.currentTarget.value)} placeholder="Exact brand name" value={brand} />
            </label>

            <label className="stack-field">
              <span>Category</span>
              <input name="category" onChange={(event) => setCategory(event.currentTarget.value)} placeholder="Exact category name" value={category} />
            </label>

            <label className="stack-field">
              <span>Subcategory</span>
              <input name="subcategory" onChange={(event) => setSubcategory(event.currentTarget.value)} placeholder="Exact subcategory name" value={subcategory} />
            </label>

            <div className="stack-field" style={{ marginBottom: '1rem' }}>
              <span>Live inventory and history scope</span>
              <label className="inline-row wrap-row">
                <input
                  checked={liveBronxInventory}
                  name="liveBronxInventory"
                  onChange={(event) => setLiveBronxInventory(event.currentTarget.checked)}
                  type="checkbox"
                  value="true"
                />
                Only include products currently in stock in Bronx
              </label>
              <label className="inline-row wrap-row">
                <input
                  checked={liveMidtownInventory}
                  name="liveMidtownInventory"
                  onChange={(event) => setLiveMidtownInventory(event.currentTarget.checked)}
                  type="checkbox"
                  value="true"
                />
                Only include products currently in stock in Midtown
              </label>
              <label className="inline-row wrap-row">
                <input
                  checked={midtownEverReceived}
                  name="midtownEverReceived"
                  onChange={(event) => setMidtownEverReceived(event.currentTarget.checked)}
                  type="checkbox"
                  value="true"
                />
                Only include products ever received in Midtown purchase history
              </label>
            </div>

            <div className="inline-row wrap-row">
              <button className="ghost-button" type="submit">
                {isPreviewLoading ? 'Updating preview…' : 'Preview matches'}
              </button>
              <Link className="ghost-button like-button" to={buildHeliosModulePath('catalog', 'browser')}>
                Browse catalog
              </Link>
            </div>
            <p className="subtle-copy" style={{ marginTop: '0.75rem' }}>
              Preview refreshes the matched counts and sample groups below. Detailed price proposals are generated only after you create the run.
            </p>
          </Form>
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

          <p className="subtle-copy" style={{ margin: '1rem 0' }}>
            Helios builds this run in the background. You will review the proposed price changes before anything is applied.
          </p>

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

function buildCatalogScopeLabel(filters: {
  liveBronxInventory: boolean
  liveMidtownInventory: boolean
  midtownEverReceived: boolean
}): string {
  const productScopeLabels = buildProductScopeLabels(filters)
  return productScopeLabels.length > 0 ? `${productScopeLabels.join(' · ')} catalog` : 'Full catalog'
}

function buildProductScopeLabels(filters: {
  liveBronxInventory: boolean
  liveMidtownInventory: boolean
  midtownEverReceived: boolean
}): string[] {
  const labels: string[] = []
  if (filters.midtownEverReceived) {
    labels.push('Midtown ever received')
  }
  if (filters.liveBronxInventory && filters.liveMidtownInventory) {
    labels.push('Bronx + Midtown live inventory')
    return labels
  }
  if (filters.liveBronxInventory) {
    labels.push('Bronx live inventory')
  }
  if (filters.liveMidtownInventory) {
    labels.push('Midtown live inventory')
  }
  return labels
}
