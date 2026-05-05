import { Link, useParams, useSearchParams } from 'react-router-dom'

import {
  ScopeKindSchema,
  buildHeliosModulePath,
  type ScopeKind,
  type ScopeRef,
} from '../../../shared/contracts/index.js'
import { useRegisterCatalogSidebarSubtree } from './catalogSidebarSubtree.js'
import { ReviewDetailsPanel } from './ReviewDetailsPanel.js'

export function ReviewDetailsPage() {
  useRegisterCatalogSidebarSubtree()
  const params = useParams<{ scopeKind?: string; scopeId?: string }>()
  const [searchParams] = useSearchParams()

  const scopeKindParse = ScopeKindSchema.safeParse(params.scopeKind)
  const scopeId = (params.scopeId ?? '').trim()
  const brandId = searchParams.get('brandId')
  const itemKey = searchParams.get('itemKey')

  if (!scopeKindParse.success || !scopeId) {
    return (
      <section>
        <div className="page-header">
          <div>
            <p className="eyebrow">Catalog review details</p>
            <h2>Unknown scope</h2>
            <p className="subtle-copy">
              Expected URL of the form /catalog/review-details/&lt;scopeKind&gt;/&lt;scopeId&gt;.
            </p>
          </div>
        </div>
        <div className="inline-row wrap-row">
          <Link to={buildHeliosModulePath('catalog', 'history')}>Back to history</Link>
        </div>
      </section>
    )
  }

  const scopeKind: ScopeKind = scopeKindParse.data
  const scopeRef: ScopeRef = {
    id: /^\d+$/.test(scopeId) ? Number(scopeId) : scopeId,
    ...(brandId ? { brandId: /^\d+$/.test(brandId) ? Number(brandId) : brandId } : {}),
    ...(itemKey ? { itemKey } : {}),
  }
  const brandScopeRef: ScopeRef | null =
    brandId && scopeKind !== 'catalog_brand'
      ? { id: /^\d+$/.test(brandId) ? Number(brandId) : brandId }
      : null

  return (
    <section>
      <div className="page-header">
        <div>
          <p className="eyebrow">Catalog review details</p>
          <h2>
            {scopeKind} #{scopeId}
          </h2>
          <p className="subtle-copy">
            Re-run, fail, comment on, and annotate this row. All actions write to the shared audit and worker queue surfaces.
          </p>
        </div>
      </div>
      <div className="inline-row wrap-row">
        <Link to={buildHeliosModulePath('catalog', 'history')}>Back to history</Link>
        <Link to={buildHeliosModulePath('catalog', 'review')}>Review queue</Link>
        <Link to={buildHeliosModulePath('catalog', 'pending-purchases')}>Pending purchases</Link>
      </div>
      <ReviewDetailsPanel
        module="catalog"
        scopeKind={scopeKind}
        scopeRef={scopeRef}
        brandScopeRef={brandScopeRef}
      />
    </section>
  )
}
