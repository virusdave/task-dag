import { Fragment, useEffect, useMemo, useState, type CSSProperties } from 'react'
import { useLoaderData } from 'react-router-dom'

import {
  BrandFamilyMarketMatchResponseSchema,
  CatalogFamilyExplorerResponseSchema,
  type BrandFamilyMappingSummary,
  type BrandFamilyMarketMatchResponse,
  type BrandFamilyMatchCandidate,
  type CatalogFamilyExplorerResponse,
} from '../../../shared/contracts/index.js'
import {
  groupBrandSubdividedFamilies,
  groupFamilies,
  type BrandSubdividedFamily,
  type BrandSubFamily,
  type FamilyExplorerMode,
  type FamilyGroup,
  type FamilyMember,
} from '../../../shared/domain/familyExplorer.js'
import { loadJson } from '../../app/fetchJson.js'
import { nyLongDateTime, nyShortDateTime } from '../../app/nyTime.js'
import { Pill } from '../../components/Pill.js'
import { useRegisterCatalogSidebarSubtree } from './catalogSidebarSubtree.js'

/**
 * Catalog → Family Explorer (issue #55 T1; brand hierarchy issue #58 T1) —
 * TEMPORARY operator-only audit surface for iterating on categorical-family
 * grouping correctness.
 *
 * Shows, for the WHOLE variant catalog, the resolved categorical families and
 * EXACTLY which variants land in each — the point is auditable membership so
 * the operator can confirm the grouping (and the size-group folding) is right
 * before we build the richer per-family pricing UX in later steps.
 *
 * The operator reprices by BRAND-categorical-family, so "Brand categorical
 * family" mode nests one level deeper: a non-brand categorical family → its
 * per-brand sub-families → variants. The nesting is a pure regrouping of the
 * SAME members as the flat non-brand view (see familyExplorer.ts).
 *
 * Purpose-first (helios/AGENTS.md): the family list is the answer and is at the
 * top; methodology / caveats live in a collapsed About section at the bottom.
 */
export async function catalogFamilyExplorerLoader(): Promise<CatalogFamilyExplorerResponse> {
  return loadJson('/api/catalog/family-explorer/variants', CatalogFamilyExplorerResponseSchema)
}

function displayOrNull(value: string | null): string {
  return value ?? '—'
}

/** Compact one-line family header, e.g. "Flower · Indica · 3.5 g · pack 1". */
function familyHeaderParts(group: FamilyGroup): string[] {
  const parts: string[] = []
  if (group.mode === 'brand') parts.push(group.brandName ?? '(no brand)')
  parts.push(group.categoryName ?? '(no cat)')
  parts.push(group.subcategoryName ?? '(no sub)')
  parts.push(group.sizeGroupLabel)
  parts.push(group.packCount == null ? '(no pack)' : `pack ${group.packCount}`)
  return parts
}

/** Non-brand family header (no brand dimension), e.g. "Flower · Indica · 3.5 g · pack 1". */
function nonBrandHeaderParts(family: BrandSubdividedFamily): string[] {
  return [
    family.categoryName ?? '(no cat)',
    family.subcategoryName ?? '(no sub)',
    family.sizeGroupLabel,
    family.packCount == null ? '(no pack)' : `pack ${family.packCount}`,
  ]
}

function memberMatches(m: FamilyMember, q: string): boolean {
  return (
    (m.name ?? '').toLowerCase().includes(q) ||
    (m.sku ?? '').toLowerCase().includes(q) ||
    (m.brandName ?? '').toLowerCase().includes(q)
  )
}

/** Shared, horizontally-scrollable variant table for one (sub-)family. */
function VariantTable({ members }: { members: readonly FamilyMember[] }) {
  return (
    <div style={{ overflowX: 'auto', marginTop: '0.5rem' }}>
      <table className="data-table">
        <thead>
          <tr>
            <th>Name</th>
            <th>SKU</th>
            <th>Brand</th>
            <th>Category</th>
            <th>Subcategory</th>
            <th>Pack</th>
            <th>Unit size</th>
            <th>Size group</th>
          </tr>
        </thead>
        <tbody>
          {members.map((m) => (
            <tr key={`${m.catalogGroupId}:${m.productId}`}>
              <td>{displayOrNull(m.name)}</td>
              <td>{displayOrNull(m.sku)}</td>
              <td>{displayOrNull(m.brandName)}</td>
              <td>{displayOrNull(m.categoryName)}</td>
              <td>{displayOrNull(m.subcategoryName)}</td>
              <td>{m.packCount == null ? '—' : m.packCount}</td>
              <td>{displayOrNull(m.sizeLabel)}</td>
              <td>
                {m.folded ? '≈ ' : ''}
                {m.sizeGroupLabel}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** 0–1 score to a fixed 2-decimal string. */
function fmtScore(n: number): string {
  return n.toFixed(2)
}

/** Tone for the mapping-state roll-up pill (honest brand mapping surface). */
function mappingTone(summary: BrandFamilyMappingSummary): 'success' | 'warning' | 'danger' | 'muted' {
  switch (summary) {
    case 'mapped':
      return 'success'
    case 'unmapped':
      return 'danger'
    case 'operator-says-none':
    case 'mixed':
      return 'warning'
    case 'no-brand':
      return 'muted'
  }
}

function mappingLabel(summary: BrandFamilyMappingSummary): string {
  switch (summary) {
    case 'mapped':
      return 'brand mapped'
    case 'unmapped':
      return 'brand UNMAPPED (lower(trim) fallback)'
    case 'operator-says-none':
      return 'operator says no brand'
    case 'mixed':
      return 'mixed brand mapping'
    case 'no-brand':
      return 'no brand'
  }
}

/** Sticky first column (Score) so it stays anchored during horizontal scroll. */
const STICKY_SCORE_COL: CSSProperties = {
  position: 'sticky',
  left: 0,
  background: 'var(--panel)',
  zIndex: 1,
  textAlign: 'right',
  fontVariantNumeric: 'tabular-nums',
}

/** Human distance-band label (strip the enum underscore). */
function distanceBandLabel(band: BrandFamilyMatchCandidate['distanceBand']): string {
  return band === 'very_far' ? 'very far' : band
}

/**
 * Compact per-candidate factor breakdown, so the operator sees WHY it matched.
 * The subcategory + pack factors are constant no-data neutrals whenever the
 * partner side is NULL for the family (`subcategoryNotMatchable` /
 * `packNotMatchable`); we KEEP the values (they genuinely multiply into the
 * score) but mute them so the eye skips identical-on-every-row noise.
 */
function FactorCells({
  f,
  subMuted,
  packMuted,
}: {
  f: BrandFamilyMatchCandidate['factors']
  subMuted: boolean
  packMuted: boolean
}) {
  const cells: { label: string; value: number; muted: boolean }[] = [
    { label: 'brand', value: f.brand, muted: false },
    { label: 'cat', value: f.category, muted: false },
    { label: 'sub', value: f.subcategory, muted: subMuted },
    { label: 'size', value: f.size, muted: false },
    { label: 'pack', value: f.pack, muted: packMuted },
    { label: 'strain', value: f.strain, muted: false },
    { label: 'name', value: f.nameOverlap, muted: false },
  ]
  return (
    <>
      {cells.map((cell) => (
        <td
          key={cell.label}
          title={`${cell.label} factor`}
          className={cell.muted ? 'subtle-copy' : undefined}
          style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}
        >
          {fmtScore(cell.value)}
        </td>
      ))}
    </>
  )
}

/** One-line price context, e.g. "$42.00 / $47.46". */
function priceLabel(c: BrandFamilyMatchCandidate): string {
  if (c.preTaxPrice == null) return '—'
  const post = c.postTaxPrice == null ? '' : ` / $${c.postTaxPrice.toFixed(2)}`
  return `$${c.preTaxPrice.toFixed(2)}${post}`
}

/**
 * One per-brand sub-family row: brand header → (on expand) the LitAlerts
 * market-match panel + the variant table. The market-match panel is mounted
 * ONLY while this row is open, so nothing fetches until the operator expands
 * the brand (React renders <details> children even when collapsed, so the
 * conditional mount — not the panel's own laziness — is what keeps the fleet of
 * sub-families from all fetching eagerly).
 */
function SubFamilyRow({ familyKey, sub }: { familyKey: string; sub: BrandSubFamily }) {
  const [open, setOpen] = useState(false)
  return (
    <details
      className="mini-card"
      style={{ marginBottom: '0.375rem' }}
      onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}
    >
      <summary style={{ cursor: 'pointer' }}>
        <span style={{ fontWeight: 600 }}>{sub.brandName ?? '(no brand)'}</span>{' '}
        <Pill tone="muted">
          {sub.memberCount} variant{sub.memberCount === 1 ? '' : 's'}
        </Pill>
      </summary>
      {open ? <MarketMatchPanel familyKey={familyKey} brandKey={sub.brandKey} /> : null}
      <VariantTable members={sub.members} />
    </details>
  )
}

/**
 * Lazy per-family LitAlerts market-match diagnostic (issue #58 T2). Mounted only
 * once its parent brand sub-family is expanded (so nothing fetches eagerly),
 * then it fetches on mount and renders OPEN — the operator sees the candidate
 * scores in two expands (family → sub-family) instead of three. Still
 * collapsible. Surfaces the data caveats (stale snapshot, dup rows, NULL
 * pack/subcategory, brand mapping state, display cap) rather than hiding them.
 */
function MarketMatchPanel({ familyKey, brandKey }: { familyKey: string; brandKey: string | null }) {
  const [status, setStatus] = useState<'idle' | 'loading' | 'loaded' | 'error'>('idle')
  const [data, setData] = useState<BrandFamilyMarketMatchResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Bump to re-trigger the fetch effect on a manual retry after an error.
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let cancelled = false
    setStatus('loading')
    setError(null)
    const qs = new URLSearchParams({ familyKey, brandKey: brandKey ?? '' }).toString()
    loadJson(`/api/catalog/family-explorer/market-match?${qs}`, BrandFamilyMarketMatchResponseSchema)
      .then((res) => {
        if (cancelled) return
        setData(res)
        setStatus('loaded')
      })
      .catch((e: unknown) => {
        if (cancelled) return
        setError(e instanceof Error ? e.message : String(e))
        setStatus('error')
      })
    return () => {
      cancelled = true
    }
  }, [familyKey, brandKey, attempt])

  return (
    <details className="mini-card" style={{ marginTop: '0.375rem' }} open>
      <summary style={{ cursor: 'pointer' }}>
        <span style={{ fontWeight: 600 }}>LitAlerts market match</span>{' '}
        {status === 'loading' ? <Pill tone="muted">loading…</Pill> : null}
        {status === 'error' ? <Pill tone="danger">error</Pill> : null}
        {status === 'loaded' && data ? (
          <>
            <Pill tone={data.aboveThresholdCount > 0 ? 'success' : 'muted'}>
              {data.aboveThresholdCount} ≥ {fmtScore(data.threshold)}
            </Pill>{' '}
            <Pill tone="muted">{data.belowThresholdCount} below</Pill>{' '}
            <Pill tone={mappingTone(data.mappingSummary)}>{mappingLabel(data.mappingSummary)}</Pill>
          </>
        ) : null}
      </summary>

      {status === 'error' ? (
        <p className="subtle-copy" style={{ marginTop: '0.5rem' }}>
          <span style={{ color: 'var(--danger, #b00)' }}>Failed to load market match: {error}</span>{' '}
          <button type="button" className="ghost-button" onClick={() => setAttempt((n) => n + 1)}>
            Retry
          </button>
        </p>
      ) : null}

      {status === 'loaded' && data ? <MarketMatchBody data={data} /> : null}
    </details>
  )
}

function MarketMatchBody({ data }: { data: BrandFamilyMarketMatchResponse }) {
  const capturedRange =
    data.snapshotCapturedAtMin != null
      ? data.snapshotCapturedAtMin === data.snapshotCapturedAtMax
        ? `captured ${nyShortDateTime(new Date(data.snapshotCapturedAtMin).getTime())}`
        : `captured ${nyShortDateTime(new Date(data.snapshotCapturedAtMin).getTime())} – ${nyShortDateTime(
            new Date(data.snapshotCapturedAtMax!).getTime(),
          )}`
      : null
  const displayCapped = data.scoredCandidateCount > data.candidates.length
  // First below-threshold candidate: candidates are score-desc, so this is the
  // single point where we drop a divider row for fast eye-scanning.
  const firstBelowId = data.candidates.find((c) => !c.aboveThreshold)?.fuzzySkuId ?? null

  return (
    <div style={{ marginTop: '0.5rem' }}>
      <div className="inline-row wrap-row" style={{ gap: '0.375rem', marginBottom: '0.5rem' }}>
        <Pill tone="muted">
          {data.rawRowCount.toLocaleString()} raw → {data.dedupedListingCount.toLocaleString()} deduped
        </Pill>
        <Pill tone="muted">{data.scoredCandidateCount.toLocaleString()} scored</Pill>
        {displayCapped ? (
          <Pill
            tone="warning"
            title={`The table shows the top-scoring ${data.candidates.length.toLocaleString()} of ${data.scoredCandidateCount.toLocaleString()} scored candidates; the above/below counts are over the full scored set.`}
          >
            top {data.candidates.length.toLocaleString()} of {data.scoredCandidateCount.toLocaleString()} shown
          </Pill>
        ) : null}
        {data.fetchTruncated ? (
          <Pill
            tone="warning"
            title={`Only the most-recent ${data.fetchLimit.toLocaleString()} of ${data.dedupedListingCount.toLocaleString()} deduped listings were fetched and scored — the "scored" count is capped by this fetch limit, not by the matcher gating.`}
          >
            fetch capped at {data.fetchLimit.toLocaleString()}
          </Pill>
        ) : null}
        {data.effectiveBrandNorms.length > 0 ? (
          <Pill tone="muted" title="Override-aware effective LitAlerts brand norms used as the hard brand filter">
            brand norms: {data.effectiveBrandNorms.join(', ')}
          </Pill>
        ) : null}
        {capturedRange ? (
          <Pill tone="warning" title="LitAlerts is a one-shot snapshot, not a live feed">
            {capturedRange}
          </Pill>
        ) : null}
        {data.packNotMatchable ? (
          <Pill tone="warning" title="partner rows have NULL pack_count_norm — pack>1 can't be matched market-side">
            pack not matchable
          </Pill>
        ) : null}
        {data.subcategoryNotMatchable ? (
          <Pill tone="warning" title="partner rows have NULL subcategory_norm — subcategory can't be matched market-side">
            subcategory not matchable
          </Pill>
        ) : null}
      </div>

      {data.mappingStates.length > 0 ? (
        <div className="inline-row wrap-row" style={{ gap: '0.375rem', marginBottom: '0.5rem' }}>
          {data.mappingStates.map((m) => (
            <Pill
              key={m.rawBrandName}
              tone={m.state === 'mapped' ? 'success' : m.state === 'unmapped' ? 'danger' : 'warning'}
              title={
                m.litalertsBrandId != null ? `LitAlerts brand #${m.litalertsBrandId}` : `${m.rawBrandName}: ${m.state}`
              }
            >
              {m.state === 'mapped' && m.litalertsBrandName != null
                ? `${m.rawBrandName} → ${m.litalertsBrandName}`
                : `${m.rawBrandName}: ${m.state}`}
            </Pill>
          ))}
        </div>
      ) : null}

      {data.candidates.length === 0 ? (
        <p className="subtle-copy">
          No partner listings matched this family
          {data.mappingSummary === 'no-brand'
            ? ' (no brand to match on).'
            : data.effectiveBrandNorms.length === 0
              ? ' (brand resolves to no usable LitAlerts norm).'
              : '.'}
        </p>
      ) : (
        <>
          <p className="subtle-copy" style={{ margin: '0 0 0.375rem' }}>
            Factors (each multiplies into the score): <strong>B</strong> brand · <strong>C</strong> category ·{' '}
            <strong>Sub</strong> subcategory · <strong>Sz</strong> size · <strong>Pk</strong> pack ·{' '}
            <strong>St</strong> strain · <strong>Nm</strong> name overlap. Muted Sub/Pk = neutral no-data constant
            (partner side is NULL).
          </p>
          <div style={{ overflowX: 'auto' }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th style={STICKY_SCORE_COL}>Score</th>
                  <th>Listing</th>
                  <th>Brand (raw / norm)</th>
                  <th>Cat norm</th>
                  <th>Sub norm</th>
                  <th>Parsed size</th>
                  <th>Size group</th>
                  <th>Retailer</th>
                  <th>Dist</th>
                  <th>Price ±tax</th>
                  <th>Stock</th>
                  <th title="brand factor">B</th>
                  <th title="category factor">C</th>
                  <th title="subcategory factor">Sub</th>
                  <th title="size factor">Sz</th>
                  <th title="pack factor">Pk</th>
                  <th title="strain factor">St</th>
                  <th title="name-token overlap factor">Nm</th>
                </tr>
              </thead>
              <tbody>
                {data.candidates.map((c) => (
                  <Fragment key={c.fuzzySkuId}>
                    {c.fuzzySkuId === firstBelowId ? (
                      <tr>
                        <td colSpan={18} className="subtle-copy" style={{ textAlign: 'center' }}>
                          — below threshold {fmtScore(data.threshold)} —
                        </td>
                      </tr>
                    ) : null}
                    <tr>
                      <td style={STICKY_SCORE_COL}>
                        {c.aboveThreshold ? (
                          <Pill tone="success">{fmtScore(c.score)}</Pill>
                        ) : (
                          <Pill tone="muted">{fmtScore(c.score)}</Pill>
                        )}
                      </td>
                      <td>
                        {c.url != null ? (
                          <a href={c.url} target="_blank" rel="noreferrer">
                            {displayOrNull(c.listingName)}
                          </a>
                        ) : (
                          displayOrNull(c.listingName)
                        )}
                      </td>
                      <td>
                        {displayOrNull(c.brandRaw)}
                        {c.brandNorm != null ? <span className="subtle-copy"> / {c.brandNorm}</span> : null}
                      </td>
                      <td>{displayOrNull(c.categoryNorm)}</td>
                      <td>{displayOrNull(c.subcategoryNorm)}</td>
                      <td>{displayOrNull(c.parsedSizeLabel)}</td>
                      <td>{c.matchedSizeGroupLabel}</td>
                      <td>{displayOrNull(c.retailer)}</td>
                      <td title={c.distanceMiles != null ? `${c.distanceMiles.toFixed(1)} mi` : 'unknown'}>
                        {distanceBandLabel(c.distanceBand)}
                      </td>
                      <td style={{ whiteSpace: 'nowrap' }}>{priceLabel(c)}</td>
                      <td style={{ textAlign: 'right' }}>{c.currentStock ?? '—'}</td>
                      <FactorCells
                        f={c.factors}
                        subMuted={data.subcategoryNotMatchable}
                        packMuted={data.packNotMatchable}
                      />
                    </tr>
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  )
}

export function CatalogFamilyExplorerPage() {
  useRegisterCatalogSidebarSubtree()
  const data = useLoaderData() as CatalogFamilyExplorerResponse
  const [mode, setMode] = useState<FamilyExplorerMode>('nonbrand')
  const [filter, setFilter] = useState('')
  const filterLower = filter.trim().toLowerCase()

  // Flat non-brand groups (nonbrand mode).
  const groups = useMemo(
    () => (mode === 'nonbrand' ? groupFamilies(data.variants, 'nonbrand') : []),
    [data.variants, mode],
  )
  const visibleGroups = useMemo(() => {
    if (mode !== 'nonbrand') return []
    if (filterLower.length === 0) return groups
    return groups.filter((group) => {
      if (familyHeaderParts(group).join(' ').toLowerCase().includes(filterLower)) return true
      return group.members.some((m) => memberMatches(m, filterLower))
    })
  }, [mode, groups, filterLower])

  // Brand-subdivided hierarchy (brand mode).
  const brandFamilies = useMemo(
    () => (mode === 'brand' ? groupBrandSubdividedFamilies(data.variants) : []),
    [data.variants, mode],
  )
  const visibleBrandFamilies = useMemo(() => {
    if (mode !== 'brand') return []
    if (filterLower.length === 0) {
      return brandFamilies.map((family) => ({ family, subFamilies: family.subFamilies }))
    }
    const out: { family: BrandSubdividedFamily; subFamilies: readonly BrandSubFamily[] }[] = []
    for (const family of brandFamilies) {
      if (nonBrandHeaderParts(family).join(' ').toLowerCase().includes(filterLower)) {
        out.push({ family, subFamilies: family.subFamilies })
        continue
      }
      const subFamilies = family.subFamilies.filter(
        (sub) =>
          (sub.brandName ?? '(no brand)').toLowerCase().includes(filterLower) ||
          sub.members.some((m) => memberMatches(m, filterLower)),
      )
      if (subFamilies.length > 0) out.push({ family, subFamilies })
    }
    return out
  }, [mode, brandFamilies, filterLower])

  const familyCount = mode === 'brand' ? brandFamilies.length : groups.length
  const brandSubfamilyCount = useMemo(
    () => (mode === 'brand' ? brandFamilies.reduce((n, f) => n + f.brandCount, 0) : 0),
    [mode, brandFamilies],
  )
  const unparsedCount =
    mode === 'brand'
      ? brandFamilies.filter((f) => f.sizeUnparsed).length
      : groups.filter((g) => g.sizeUnparsed).length

  return (
    <section>
      <div className="page-header">
        <div>
          <p className="eyebrow">Catalog Module</p>
          <h2>
            Family Explorer <Pill tone="warning">TEMPORARY</Pill>
          </h2>
          <p className="subtle-copy">
            {familyCount.toLocaleString()} {mode === 'brand' ? 'categorical families' : 'families'}
            {mode === 'brand'
              ? ` · ${brandSubfamilyCount.toLocaleString()} brand sub-families`
              : ''}{' '}
            over {data.variants.length.toLocaleString()} variants (whole catalog).
            {unparsedCount > 0 ? ` ${unparsedCount} have an unparseable size (shown first).` : ''}
          </p>
        </div>
      </div>

      <div className="inline-row wrap-row" style={{ gap: '0.5rem', marginBottom: '0.75rem' }}>
        <div className="inline-row" role="group" aria-label="Grouping mode" style={{ gap: '0.25rem' }}>
          <button
            type="button"
            className={mode === 'nonbrand' ? 'primary-button' : 'ghost-button'}
            aria-pressed={mode === 'nonbrand'}
            onClick={() => setMode('nonbrand')}
          >
            Categorical family
          </button>
          <button
            type="button"
            className={mode === 'brand' ? 'primary-button' : 'ghost-button'}
            aria-pressed={mode === 'brand'}
            onClick={() => setMode('brand')}
          >
            Brand categorical family
          </button>
          <button
            type="button"
            className="ghost-button"
            disabled
            title="Vendor categorical family needs a vendor→brand mapping that does not exist yet — out of scope for this step."
          >
            Vendor family (n/a)
          </button>
        </div>
        <input
          type="search"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter by family / name / SKU / brand"
          aria-label="Filter families"
          style={{ flex: '1 1 14rem', minWidth: '10rem' }}
        />
      </div>

      {mode === 'nonbrand' ? (
        visibleGroups.length === 0 ? (
          <p className="subtle-copy">No families match “{filter}”.</p>
        ) : (
          visibleGroups.map((group) => (
            <details key={group.familyKey} className="mini-card" style={{ marginBottom: '0.5rem' }}>
              <summary style={{ cursor: 'pointer' }}>
                <span style={{ fontWeight: 600 }}>{familyHeaderParts(group).join(' · ')}</span>{' '}
                {group.sizeUnparsed ? <Pill tone="danger">size?</Pill> : null}{' '}
                <Pill tone="muted">
                  {group.memberCount} variant{group.memberCount === 1 ? '' : 's'}
                </Pill>
              </summary>
              <VariantTable members={group.members} />
            </details>
          ))
        )
      ) : visibleBrandFamilies.length === 0 ? (
        <p className="subtle-copy">No families match “{filter}”.</p>
      ) : (
        visibleBrandFamilies.map(({ family, subFamilies }) => (
          // `key` includes the filter so React re-applies the semi-controlled
          // `open` (expand matches when filtering, collapse when cleared).
          <details
            key={`${family.familyKey}:${filterLower}`}
            className="mini-card"
            style={{ marginBottom: '0.5rem' }}
            open={filterLower.length > 0}
          >
            <summary style={{ cursor: 'pointer' }}>
              <span style={{ fontWeight: 600 }}>{nonBrandHeaderParts(family).join(' · ')}</span>{' '}
              {family.sizeUnparsed ? <Pill tone="danger">size?</Pill> : null}{' '}
              <Pill tone="muted">
                {subFamilies.length === family.brandCount
                  ? `${family.brandCount} brand${family.brandCount === 1 ? '' : 's'}`
                  : `${subFamilies.length} of ${family.brandCount} brands`}
              </Pill>{' '}
              <Pill tone="muted">
                {family.memberCount} variant{family.memberCount === 1 ? '' : 's'}
              </Pill>
            </summary>
            <div style={{ marginTop: '0.5rem', paddingLeft: '0.75rem' }}>
              {subFamilies.map((sub) => (
                <SubFamilyRow
                  key={sub.brandKey ?? '\u0000(no brand)'}
                  familyKey={family.familyKey}
                  sub={sub}
                />
              ))}
            </div>
          </details>
        ))
      )}

      <details className="mini-card" style={{ marginTop: '1rem' }}>
        <summary style={{ cursor: 'pointer' }}>About this page</summary>
        <div className="subtle-copy" style={{ marginTop: '0.5rem' }}>
          <p>
            <strong>TEMPORARY iteration surface</strong> (issue #55 step 1, brand hierarchy #58). It
            groups the whole variant catalog into “categorical families” so the grouping and the
            size-group equivalency can be validated in isolation before the richer per-family
            pricing UX is built.
          </p>
          <p>
            A family = category × subcategory × <em>size group</em> × pack count. In{' '}
            <em>Brand categorical family</em> mode each such non-brand family is subdivided into its
            per-brand sub-families (case-insensitive; the no-brand bucket sorts last), matching how
            the operator reprices peers within a brand-category-family. The <em>size group</em>{' '}
            folds “morally equivalent” sizes: pre-rolls roll novelty sizes into standard buckets
            (e.g. 0.6&nbsp;g → 0.5&nbsp;g, shown with “≈”), while every other category keeps its
            natural size. This folding is wired in HERE ONLY; it does not change existing pricing /
            market-match runs.
          </p>
          <p>
            Vendor categorical family is disabled until a vendor→brand mapping exists. Families
            whose size does not parse are badged <em>size?</em> and sorted first — those are the
            grouping bugs to hunt. Retired/DEAD-marked groups are intentionally included (this is a
            whole-catalog audit). Snapshot read {nyLongDateTime(new Date(data.generatedAt).getTime())}{' '}
            (America/New&nbsp;York).
          </p>
        </div>
      </details>
    </section>
  )
}
