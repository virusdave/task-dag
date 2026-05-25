import { useCallback, useEffect, useState } from 'react'
import { Link, useLoaderData, useNavigate, useSearchParams } from 'react-router-dom'
import { z } from 'zod'

import { buildHeliosModulePath } from '../../../shared/contracts/index.js'
import { loadJson, mutateJson } from '../../app/fetchJson.js'
import { Pill } from '../../components/Pill.js'
import { useRegisterCatalogSidebarSubtree } from './catalogSidebarSubtree.js'

// Loose passthrough schemas — we trust the server contract for now
// and avoid duplicating the full shape in shared/contracts since the
// review surface is the only consumer of these payloads.
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
}

interface ListResponse {
  rows: GroupSummaryRow[]
  pagination: { limit: number; offset: number; totalCount: number }
}

interface GroupReviewBundle {
  catalogGroupId: number
  groupName: string
  brandName: string | null
  categoryName: string | null
  subcategoryName: string | null
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
  candidates: Array<{
    fuzzy: FuzzySku
    rawScore: number
    finalScore: number
    factors: { brand: number; category: number; subcategory: number; size: number; pack: number; strain: number }
    listingUrl: string | null
    dispensaryName: string | null
  }>
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

export async function catalogMarketDataLoader({ request }: { request: Request }): Promise<ListResponse> {
  const url = new URL(request.url)
  const params = url.searchParams
  if (!params.has('limit')) params.set('limit', '50')
  return loadJson(
    `/api/catalog/market-matches?${params.toString()}`,
    ListResponseSchema,
  )
}

export function CatalogMarketDataPage(): JSX.Element {
  useRegisterCatalogSidebarSubtree()
  const data = useLoaderData() as ListResponse
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const [brand, setBrand] = useState(params.get('brand') ?? '')
  const [unverdictedOnly, setUnverdictedOnly] = useState(params.get('unverdictedOnly') === 'true')
  const [expanded, setExpanded] = useState<number | null>(null)
  const [bundle, setBundle] = useState<GroupReviewBundle | null>(null)
  const [bundleLoading, setBundleLoading] = useState(false)
  const [pendingVerdict, setPendingVerdict] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)

  const loadBundle = useCallback(async (gid: number) => {
    setBundleLoading(true)
    setError(null)
    try {
      const next = await loadJson(
        `/api/catalog/market-matches/${gid}`,
        BundleSchema,
      )
      setBundle(next)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load review bundle')
      setBundle(null)
    } finally {
      setBundleLoading(false)
    }
  }, [])

  useEffect(() => {
    if (expanded === null) {
      setBundle(null)
      return
    }
    void loadBundle(expanded)
  }, [expanded, loadBundle])

  async function recordVerdict(
    fuzzySkuId: number,
    verdict: 'exact' | 'brand_family' | 'no_match',
    confidenceAtVerdict: number | null,
  ): Promise<void> {
    if (!bundle || pendingVerdict !== null) return
    setPendingVerdict(fuzzySkuId)
    setError(null)
    try {
      await mutateJson(
        '/api/catalog/market-matches',
        VerdictResponseSchema,
        {
          method: 'POST',
          body: JSON.stringify({
            catalogGroupId: bundle.catalogGroupId,
            fuzzySkuId,
            verdict,
            confidenceAtVerdict,
          }),
        },
      )
      await loadBundle(bundle.catalogGroupId)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Verdict failed')
    } finally {
      setPendingVerdict(null)
    }
  }

  function applyFilters(): void {
    const next = new URLSearchParams(params)
    if (brand.trim()) next.set('brand', brand.trim())
    else next.delete('brand')
    if (unverdictedOnly) next.set('unverdictedOnly', 'true')
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

  const totalPages = Math.max(1, Math.ceil(data.pagination.totalCount / data.pagination.limit))
  const currentPage = Math.floor(data.pagination.offset / data.pagination.limit) + 1

  return (
    <div className="stacked-list">
      <section className="detail-panel">
        <div className="page-header" style={{ marginBottom: '0.5rem' }}>
          <div>
            <p className="eyebrow">Catalog → Market Data</p>
            <h2>{data.pagination.totalCount.toLocaleString()} catalog groups with LitAlerts observations</h2>
          </div>
          <Pill tone="muted">{`page ${currentPage}/${totalPages}`}</Pill>
        </div>

        <div className="inline-row wrap-row" style={{ marginBottom: '0.75rem' }}>
          <input
            onChange={(e) => setBrand(e.currentTarget.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') applyFilters() }}
            placeholder="Filter by brand…"
            style={{ flex: '0 1 16rem' }}
            value={brand}
          />
          <label className="inline-row">
            <input checked={unverdictedOnly} onChange={(e) => setUnverdictedOnly(e.currentTarget.checked)} type="checkbox" />
            Only groups with no live verdicts
          </label>
          <button className="ghost-button" onClick={applyFilters} type="button">Apply</button>
        </div>

        {error ? <p className="error-banner">{error}</p> : null}

        <table className="data-table">
          <thead>
            <tr>
              <th>Catalog group</th>
              <th>Brand</th>
              <th>Category</th>
              <th style={{ textAlign: 'right' }}>Obs</th>
              <th style={{ textAlign: 'right' }}>Live verdicts</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {data.rows.map((row) => (
              <>
                <tr key={`row-${row.catalogGroupId}`}>
                  <td>
                    <Link to={buildHeliosModulePath('catalog', `groups/${row.catalogGroupId}`)}>{row.groupName}</Link>
                  </td>
                  <td>{row.brandName ?? '—'}</td>
                  <td>{row.categoryName ?? '—'}</td>
                  <td style={{ textAlign: 'right' }}>{row.observationCount}</td>
                  <td style={{ textAlign: 'right' }}>{row.liveVerdictCount}</td>
                  <td>
                    <button
                      className="ghost-button"
                      onClick={() => setExpanded(expanded === row.catalogGroupId ? null : row.catalogGroupId)}
                      type="button"
                    >
                      {expanded === row.catalogGroupId ? 'Collapse' : 'Review'}
                    </button>
                  </td>
                </tr>
                {expanded === row.catalogGroupId ? (
                  <tr key={`expanded-${row.catalogGroupId}`}>
                    <td colSpan={6} style={{ background: 'rgba(0,0,0,0.02)' }}>
                      {bundleLoading ? <p className="subtle-copy">Loading…</p> : null}
                      {bundle && bundle.catalogGroupId === row.catalogGroupId ? (
                        <GroupReviewPanel
                          bundle={bundle}
                          onVerdict={recordVerdict}
                          pendingVerdict={pendingVerdict}
                        />
                      ) : null}
                    </td>
                  </tr>
                ) : null}
              </>
            ))}
          </tbody>
        </table>

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
              Lists catalog groups that have at least one LitAlerts competitor observation. Expanding a row lazily parses
              the observation&rsquo;s matched listings into FuzzySku rows (persisted to <code>fuzzy_skus</code>) and ranks
              them via the deterministic confidence scorer at
              <code> helios/src/shared/marketMatch/confidence.ts</code>. Recording a verdict
              (exact/brand_family/no_match) inserts a row in <code>catalog_market_matches</code> and supersedes any
              prior live verdict for the same (group, fuzzy) pair. See
              <code> docs/helios/catalog-market-data/EPIC_PLAN.md</code> for the full design.
            </p>
            <p>
              <strong>v1 caveat:</strong> the inline LitAlerts listing parser is a tactical placeholder pending
              the runtime-adjustable parser-config system (issue #19). Many listings will score 0 because their
              brand wasn&rsquo;t extractable from the bare listing-name string &mdash; that ranking will improve
              dramatically once the real <code>litalerts-v1</code> parser dialect lands.
            </p>
          </div>
        </details>
      </section>
    </div>
  )
}

interface GroupReviewPanelProps {
  bundle: GroupReviewBundle
  onVerdict: (fuzzySkuId: number, verdict: 'exact' | 'brand_family' | 'no_match', confidenceAtVerdict: number | null) => void
  pendingVerdict: number | null
}

function GroupReviewPanel({ bundle, onVerdict, pendingVerdict }: GroupReviewPanelProps): JSX.Element {
  const top = bundle.candidates.slice(0, 25)
  const rest = bundle.candidates.slice(25)
  return (
    <div className="stack-field">
      <h4 style={{ margin: '0.5rem 0' }}>{bundle.groupName}</h4>
      <p className="subtle-copy" style={{ margin: 0 }}>
        Brand: <strong>{bundle.brandName ?? '—'}</strong> &middot; Category: <strong>{bundle.categoryName ?? '—'}</strong>
        {bundle.subcategoryName ? <> &middot; Subcategory: <strong>{bundle.subcategoryName}</strong></> : null}
        {' '}&middot; {bundle.observationCount} observation(s), {bundle.candidates.length} un-verdicted candidate(s), {bundle.liveVerdicts.length} live verdict(s)
      </p>

      {bundle.liveVerdicts.length > 0 ? (
        <details open style={{ marginTop: '0.75rem' }}>
          <summary>Live verdicts ({bundle.liveVerdicts.length})</summary>
          <table className="data-table" style={{ marginTop: '0.5rem' }}>
            <thead>
              <tr>
                <th>Listing</th>
                <th>Dispensary</th>
                <th>Verdict</th>
                <th>Set at</th>
                <th>By</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {bundle.liveVerdicts.map((row) => (
                <tr key={row.id}>
                  <td>{row.fuzzy.rawInputJsonb?.listingName ?? '—'}</td>
                  <td>{row.dispensaryName ?? '—'}</td>
                  <td><Pill tone={verdictTone(row.verdict)}>{row.verdict}</Pill></td>
                  <td>{new Date(row.verdictSetAt).toLocaleString()}</td>
                  <td>{row.verdictSetByUserId}</td>
                  <td>
                    <button
                      className="ghost-button"
                      disabled={pendingVerdict !== null}
                      onClick={() => onVerdict(row.fuzzySkuId, 'no_match', row.confidenceAtVerdict)}
                      type="button"
                    >
                      Flip to no_match
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      ) : null}

      <h5 style={{ margin: '1rem 0 0.5rem' }}>Top un-verdicted candidates</h5>
      <CandidateTable
        candidates={top}
        onVerdict={onVerdict}
        pendingVerdict={pendingVerdict}
      />

      {rest.length > 0 ? (
        <details style={{ marginTop: '1rem' }}>
          <summary>Show {rest.length} more candidates</summary>
          <CandidateTable
            candidates={rest}
            onVerdict={onVerdict}
            pendingVerdict={pendingVerdict}
          />
        </details>
      ) : null}
    </div>
  )
}

function CandidateTable({
  candidates,
  onVerdict,
  pendingVerdict,
}: {
  candidates: GroupReviewBundle['candidates']
  onVerdict: GroupReviewPanelProps['onVerdict']
  pendingVerdict: number | null
}): JSX.Element {
  return (
    <table className="data-table">
      <thead>
        <tr>
          <th>Listing</th>
          <th>Dispensary</th>
          <th>Brand</th>
          <th>Cat</th>
          <th>Size</th>
          <th style={{ textAlign: 'right' }}>Score</th>
          <th>Actions</th>
        </tr>
      </thead>
      <tbody>
        {candidates.map((c) => (
          <tr key={c.fuzzy.id}>
            <td>
              {c.listingUrl ? (
                <a href={c.listingUrl} rel="noreferrer" target="_blank">{c.fuzzy.rawInputJsonb?.listingName ?? '—'}</a>
              ) : (c.fuzzy.rawInputJsonb?.listingName ?? '—')}
            </td>
            <td>{c.dispensaryName ?? '—'}</td>
            <td>{c.fuzzy.brandNorm ?? '—'}</td>
            <td>{c.fuzzy.categoryNorm ?? '—'}</td>
            <td>{c.fuzzy.sizeGNorm != null ? `${c.fuzzy.sizeGNorm}g` : c.fuzzy.sizeMgNorm != null ? `${c.fuzzy.sizeMgNorm}mg` : '—'}</td>
            <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{c.finalScore.toFixed(2)}</td>
            <td>
              <div className="inline-row" style={{ gap: '0.25rem' }}>
                <button
                  className="ghost-button"
                  disabled={pendingVerdict !== null}
                  onClick={() => onVerdict(c.fuzzy.id, 'exact', c.finalScore)}
                  title="Mark exact match (e)"
                  type="button"
                >
                  Exact
                </button>
                <button
                  className="ghost-button"
                  disabled={pendingVerdict !== null}
                  onClick={() => onVerdict(c.fuzzy.id, 'brand_family', c.finalScore)}
                  title="Mark brand/family match (b)"
                  type="button"
                >
                  Brand/family
                </button>
                <button
                  className="ghost-button"
                  disabled={pendingVerdict !== null}
                  onClick={() => onVerdict(c.fuzzy.id, 'no_match', c.finalScore)}
                  title="Mark no match (n)"
                  type="button"
                >
                  No match
                </button>
              </div>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function verdictTone(verdict: 'exact' | 'brand_family' | 'no_match'): 'success' | 'warning' | 'muted' {
  if (verdict === 'exact') return 'success'
  if (verdict === 'brand_family') return 'muted'
  return 'warning'
}
