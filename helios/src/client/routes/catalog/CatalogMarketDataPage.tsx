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

export async function catalogMarketDataLoader({ request }: { request: Request }): Promise<ListResponse> {
  const url = new URL(request.url)
  const params = url.searchParams
  if (!params.has('limit')) params.set('limit', '50')
  return loadJson(`/api/catalog/market-matches?${params.toString()}`, ListResponseSchema)
}

export function CatalogMarketDataPage(): JSX.Element {
  useRegisterCatalogSidebarSubtree()
  const data = useLoaderData() as ListResponse
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const [brand, setBrand] = useState(params.get('brand') ?? '')
  const [unverdictedOnly, setUnverdictedOnly] = useState(params.get('unverdictedOnly') === 'true')
  const [expanded, setExpanded] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)

  const totalPages = Math.max(1, Math.ceil(data.pagination.totalCount / data.pagination.limit))
  const currentPage = Math.floor(data.pagination.offset / data.pagination.limit) + 1

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

        <BrandGroupedList
          expandedGroupId={expanded}
          onError={setError}
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
              expands to per-size-family cards: the catalog variant (with photo + sku) next to its ranked
              LitAlerts candidates. Candidates below the confidence threshold (default 0.70) are hidden and
              counted as auto-no-match; raise/lower the threshold per group to inspect them.
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

interface BrandGroupedListProps {
  rows: GroupSummaryRow[]
  expandedGroupId: number | null
  onToggleGroup: (groupId: number) => void
  onError: (msg: string | null) => void
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
function BrandGroupedList({ rows, expandedGroupId, onToggleGroup, onError }: BrandGroupedListProps): JSX.Element {
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
            <button
              aria-expanded={!collapsed}
              className="inline-row wrap-row"
              onClick={() => toggleBrand(key)}
              style={{
                width: '100%',
                background: 'rgba(0,0,0,0.04)',
                border: 'none',
                borderBottom: collapsed ? 'none' : '1px solid var(--border-color, #e0e0e0)',
                padding: '0.55rem 0.75rem',
                cursor: 'pointer',
                justifyContent: 'space-between',
                gap: '0.5rem',
                textAlign: 'left',
                position: 'sticky',
                top: 0,
                zIndex: 1,
              }}
              type="button"
            >
              <span style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontWeight: 600 }}>
                <span style={{ display: 'inline-block', width: '0.85rem' }}>{collapsed ? '▸' : '▾'}</span>
                {brand ?? '(No brand)'}
              </span>
              <span className="inline-row" style={{ gap: '0.4rem' }}>
                <Pill tone="muted">{`${brandRows.length} ${brandRows.length === 1 ? 'family' : 'families'}`}</Pill>
                <Pill tone={verdictedCount === brandRows.length ? 'success' : 'muted'}>
                  {`${verdictedCount}/${brandRows.length} reviewed`}
                </Pill>
              </span>
            </button>
            {collapsed ? null : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem', padding: '0.5rem 0.6rem' }}>
                {brandRows.map((row) => (
                  <GroupCard
                    expanded={expandedGroupId === row.catalogGroupId}
                    key={row.catalogGroupId}
                    onError={onError}
                    onToggle={() => onToggleGroup(row.catalogGroupId)}
                    row={row}
                  />
                ))}
              </div>
            )}
          </section>
        )
      })}
    </div>
  )
}

interface GroupCardProps {
  row: GroupSummaryRow
  expanded: boolean
  onToggle: () => void
  onError: (msg: string | null) => void
}

function GroupCard({ row, expanded, onToggle, onError }: GroupCardProps): JSX.Element {
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
      {expanded ? <GroupReviewPanel catalogGroupId={row.catalogGroupId} onError={onError} /> : null}
    </div>
  )
}

interface GroupReviewPanelProps {
  catalogGroupId: number
  onError: (msg: string | null) => void
}

function GroupReviewPanel({ catalogGroupId, onError }: GroupReviewPanelProps): JSX.Element {
  const [minScore, setMinScore] = useState(0.70)
  const [bundle, setBundle] = useState<GroupReviewBundle | null>(null)
  const [loading, setLoading] = useState(false)
  const [pendingFuzzyId, setPendingFuzzyId] = useState<number | null>(null)
  const [activeSizeKey, setActiveSizeKey] = useState<string | null>(null)

  const load = useCallback(async (score: number) => {
    setLoading(true)
    onError(null)
    try {
      const next = await loadJson(
        `/api/catalog/market-matches/${catalogGroupId}?minScore=${score}`,
        BundleSchema,
      )
      setBundle(next)
      // Default active size = first size with candidates, else first with variants
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

  useEffect(() => { void load(minScore) }, [load, minScore])

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

  const activeGroup =
    bundle.sizeGroups.find((g) => g.sizeKey === activeSizeKey) ?? bundle.sizeGroups[0] ?? null

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
            {`${bundle.visibleCandidateCount} above ${bundle.minScore.toFixed(2)} · ${bundle.suppressedCandidateCount} below (auto no-match)`}
            {` · ${bundle.liveVerdicts.length} live verdict${bundle.liveVerdicts.length === 1 ? '' : 's'}`}
          </div>
        </div>
        <div className="inline-row" style={{ gap: '0.4rem', alignItems: 'center' }}>
          <label className="subtle-copy" style={{ fontSize: '0.8rem' }}>min:</label>
          <input
            max={1}
            min={0}
            onChange={(e) => setMinScore(Number.parseFloat(e.currentTarget.value))}
            step={0.05}
            style={{ width: '6rem' }}
            type="range"
            value={minScore}
          />
          <span style={{ fontVariantNumeric: 'tabular-nums', fontSize: '0.85rem' }}>{minScore.toFixed(2)}</span>
        </div>
      </div>

      {bundle.sizeGroups.length === 0 ? (
        <p className="subtle-copy">No catalog variants parsed for this group.</p>
      ) : (
        <div className="inline-row wrap-row" style={{ gap: '0.3rem', marginBottom: '0.5rem' }}>
          {bundle.sizeGroups.map((g) => {
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
          onVerdict={recordVerdict}
          pendingFuzzyId={pendingFuzzyId}
        />
      ) : null}

      {bundle.unmatchedCandidates.length > 0 ? (
        <details style={{ marginTop: '1rem' }}>
          <summary>{`${bundle.unmatchedCandidates.length} candidate(s) without a matched catalog variant`}</summary>
          <CandidateTable
            candidates={bundle.unmatchedCandidates}
            onVerdict={(fuzzyId, verdict, conf) => recordVerdict(fuzzyId, verdict, conf, null)}
            pendingFuzzyId={pendingFuzzyId}
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

interface SizeGroupPanelProps {
  group: SizeGroup
  onVerdict: (fuzzyId: number, verdict: 'exact' | 'brand_family' | 'no_match', conf: number | null, productId: number | null) => void
  pendingFuzzyId: number | null
}

function SizeGroupPanel({ group, onVerdict, pendingFuzzyId }: SizeGroupPanelProps): JSX.Element {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
      <div className="inline-row wrap-row" style={{ gap: '0.5rem' }}>
        {group.variants.map((v) => (
          <CatalogVariantCard key={v.catalogProductId} variant={v} />
        ))}
      </div>
      {group.candidates.length === 0 ? (
        <p className="subtle-copy" style={{ margin: '0.5rem 0' }}>
          No candidates above threshold for {group.sizeLabel}.
          {group.suppressedCandidateCount > 0
            ? ` ${group.suppressedCandidateCount} hidden as auto no-match.`
            : ''}
        </p>
      ) : (
        <CandidateTable
          candidates={group.candidates}
          onVerdict={(fuzzyId, verdict, conf) =>
            onVerdict(fuzzyId, verdict, conf, group.variants[0]?.catalogProductId ?? null)
          }
          pendingFuzzyId={pendingFuzzyId}
        />
      )}
      {group.suppressedCandidateCount > 0 ? (
        <span className="subtle-copy" style={{ fontSize: '0.78rem' }}>
          {`+${group.suppressedCandidateCount} below threshold (auto no-match)`}
        </span>
      ) : null}
    </div>
  )
}

function CatalogVariantCard({ variant }: { variant: CatalogVariant }): JSX.Element {
  return (
    <div
      style={{
        display: 'flex',
        gap: '0.5rem',
        padding: '0.4rem 0.5rem',
        border: '1px solid var(--border-color, #d0d0d0)',
        borderRadius: '4px',
        background: 'rgba(0,0,0,0.02)',
        minWidth: '12rem',
        flex: '1 1 14rem',
        maxWidth: '20rem',
      }}
    >
      {variant.imageUrl ? (
        <img
          alt=""
          src={variant.imageUrl}
          style={{ width: '3rem', height: '3rem', objectFit: 'cover', borderRadius: '3px', border: '1px solid #ddd' }}
        />
      ) : (
        <div
          style={{
            width: '3rem',
            height: '3rem',
            background: '#f1f1f1',
            borderRadius: '3px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: '#999',
            fontSize: '0.7rem',
          }}
        >
          no img
        </div>
      )}
      <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        <div style={{ fontWeight: 600, fontSize: '0.85rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {variant.shortName ?? variant.name ?? `Product ${variant.catalogProductId}`}
        </div>
        <div className="subtle-copy" style={{ fontSize: '0.75rem' }}>
          {variant.sizeLabel}
          {variant.sku ? ` · SKU ${variant.sku}` : ''}
          {variant.price != null ? ` · $${variant.price.toFixed(2)}` : ''}
        </div>
      </div>
    </div>
  )
}

interface CandidateTableProps {
  candidates: Candidate[]
  onVerdict: (fuzzyId: number, verdict: 'exact' | 'brand_family' | 'no_match', conf: number | null) => void
  pendingFuzzyId: number | null
}

function CandidateTable({ candidates, onVerdict, pendingFuzzyId }: CandidateTableProps): JSX.Element {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
      {candidates.map((c) => (
        <CandidateRow candidate={c} key={c.fuzzy.id} onVerdict={onVerdict} pendingFuzzyId={pendingFuzzyId} />
      ))}
    </div>
  )
}

function CandidateRow({
  candidate,
  onVerdict,
  pendingFuzzyId,
}: {
  candidate: Candidate
  onVerdict: CandidateTableProps['onVerdict']
  pendingFuzzyId: number | null
}): JSX.Element {
  const c = candidate
  const isPending = pendingFuzzyId === c.fuzzy.id
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: '0.25rem',
        padding: '0.45rem 0.55rem',
        border: '1px solid var(--border-color, #e0e0e0)',
        borderRadius: '4px',
      }}
    >
      <div className="inline-row wrap-row" style={{ justifyContent: 'space-between', gap: '0.5rem' }}>
        <div style={{ flex: '1 1 14rem', minWidth: 0 }}>
          {c.listingUrl ? (
            <a href={c.listingUrl} rel="noreferrer" target="_blank" style={{ fontWeight: 500 }}>
              {c.fuzzy.rawInputJsonb?.listingName ?? '—'}
            </a>
          ) : (
            <span style={{ fontWeight: 500 }}>{c.fuzzy.rawInputJsonb?.listingName ?? '—'}</span>
          )}
          <div className="subtle-copy" style={{ fontSize: '0.78rem' }}>
            {c.dispensaryName ?? '—'} · {c.fuzzy.brandNorm ?? '—'} · {c.fuzzy.categoryNorm ?? '—'}
            {c.fuzzy.sizeGNorm != null ? ` · ${c.fuzzy.sizeGNorm}g` : ''}
            {c.fuzzy.sizeMgNorm != null ? ` · ${c.fuzzy.sizeMgNorm}mg` : ''}
          </div>
        </div>
        <div className="inline-row" style={{ gap: '0.3rem', alignItems: 'center' }}>
          <Pill tone={c.finalScore >= 0.85 ? 'success' : c.finalScore >= 0.70 ? 'muted' : 'warning'}>
            {c.finalScore.toFixed(2)}
          </Pill>
          <button
            className="ghost-button"
            disabled={isPending || pendingFuzzyId !== null}
            onClick={() => onVerdict(c.fuzzy.id, 'exact', c.finalScore)}
            title="Exact match"
            type="button"
          >
            ✓ Exact
          </button>
          <button
            className="ghost-button"
            disabled={isPending || pendingFuzzyId !== null}
            onClick={() => onVerdict(c.fuzzy.id, 'brand_family', c.finalScore)}
            title="Brand/family match"
            type="button"
          >
            ≈ Family
          </button>
          <button
            className="ghost-button"
            disabled={isPending || pendingFuzzyId !== null}
            onClick={() => onVerdict(c.fuzzy.id, 'no_match', c.finalScore)}
            title="No match"
            type="button"
          >
            ✗ No
          </button>
        </div>
      </div>
      <details style={{ fontSize: '0.75rem' }}>
        <summary className="subtle-copy">Score factors</summary>
        <div className="subtle-copy" style={{ marginTop: '0.2rem' }}>
          brand {c.factors.brand.toFixed(2)} · cat {c.factors.category.toFixed(2)} · sub {c.factors.subcategory.toFixed(2)}
          {' '}· size {c.factors.size.toFixed(2)} · pack {c.factors.pack.toFixed(2)} · strain {c.factors.strain.toFixed(2)}
        </div>
      </details>
    </div>
  )
}
