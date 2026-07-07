import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react'
import { useLoaderData, useRouteLoaderData } from 'react-router-dom'

import {
  BrandFamilyMarketMatchResponseSchema,
  CatalogFamilyExplorerResponseSchema,
  CreateParseFeedbackResponseSchema,
  PARSE_FEEDBACK_ID_QUERY_LIMIT,
  ParseFeedbackListResponseSchema,
  type BrandFamilyMappingSummary,
  type BrandFamilyMarketMatchResponse,
  type BrandFamilyMatchCandidate,
  type BrandFamilyPriceOutlier,
  type BrandFamilyPriceOutlierSummary,
  type CatalogFamilyExplorerResponse,
  type ConventionPatternChip,
  type ParseFeedbackIssueType,
  type ParseFeedbackRecord,
  type SessionEnvelope,
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
import { loadJson, mutateJson } from '../../app/fetchJson.js'
import { nyLongDateTime, nyShortDateTime } from '../../app/nyTime.js'
import { Pill } from '../../components/Pill.js'
import { useRegisterCatalogSidebarSubtree } from './catalogSidebarSubtree.js'
import {
  buildCreateBody,
  buildListingCorrectionDetails,
  canSave,
  conventionScopeOptions,
  emptyConventionDraft,
  emptyCorrectionDraft,
  feedbackFetchIds,
  type ConventionDraft,
  type CorrectionDraft,
} from './parseCorrectionDraft.js'

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

// ---------------------------------------------------------------------------
// Price-outlier review UX (issue #59 T2). Surfaces T1's review signals in this
// existing panel: a summary pill, a compact "Needs review" strip above the
// table, and sticky score-cell affordances (badge + ✎ Fix). Outliers are a
// REVIEW SIGNAL ONLY — never removed, reordered, or down-ranked. The Fix action
// is an honest local seam: it selects a listing and shows a placeholder; the
// real parse-correction drawer + feedback save ship in T4.
// ---------------------------------------------------------------------------

/** USD, or an em dash when null. e.g. "$42.00" / "—". */
function formatUsd(n: number | null): string {
  return n == null ? '—' : `$${n.toFixed(2)}`
}

/** Signed USD delta, e.g. "+$3.00" / "−$5.00" (minus sign is U+2212). */
function formatUsdDelta(n: number): string {
  const sign = n < 0 ? '\u2212' : '+'
  return `${sign}$${Math.abs(n).toFixed(2)}`
}

/** Family pack label, e.g. "pack 1" / "(no pack)". */
function packLabel(n: number | null): string {
  return n == null ? '(no pack)' : `pack ${n}`
}

/** Direction glyph for the outlier (below = ↓$, above = ↑$). */
function outlierDirectionGlyph(kind: BrandFamilyPriceOutlier['kind']): string {
  return kind === 'low' ? '\u2193$' : '\u2191$'
}

/** Accessible phrasing for the outlier direction. */
function outlierDirectionLabel(kind: BrandFamilyPriceOutlier['kind']): string {
  return kind === 'low' ? 'below-market price outlier' : 'above-market price outlier'
}

/** Hover title for a single candidate's outlier badge. */
function outlierBadgeTitle(o: BrandFamilyPriceOutlier): string {
  return `${outlierDirectionLabel(o.kind)}: ${formatUsdDelta(o.delta)} vs median ${formatUsd(
    o.median,
  )} (fence ${formatUsd(o.fence)}; basis ${o.basis})`
}

/** Hover title for the family-level price-review summary pill. */
function priceOutlierSummaryTitle(s: BrandFamilyPriceOutlierSummary): string {
  return (
    `Price review: method ${s.method}; basis ${s.basis} pre-tax price${s.basis === 1 ? '' : 's'}; ` +
    `median ${formatUsd(s.median)}; low fence ${formatUsd(s.lowFence)}; high fence ${formatUsd(
      s.highFence,
    )}; ${s.lowCount} low / ${s.highCount} high.`
  )
}

/** Compact "parsed X · matched Y · family Z pack N" size context line. */
function sizeContextLabel(c: BrandFamilyMatchCandidate, data: BrandFamilyMarketMatchResponse): string {
  return `parsed ${c.parsedSizeLabel ?? '—'} · matched ${c.matchedSizeGroupLabel} · family ${
    data.sizeGroupLabel
  } ${packLabel(data.packCount)}`
}

/** Left-border accent shared by outlier rows / cards / the fix placeholder. */
const REVIEW_ACCENT = '3px solid var(--warning)'
const REVIEW_TINT = 'rgba(214, 161, 74, 0.10)'

/**
 * Compact "Needs review" strip above the table. Renders `reviewCandidates` (the
 * full-set, severity-sorted outliers T1 computes BEFORE the display cap, so an
 * outlier can never be invisible for falling outside the top-N table slice).
 * Mobile-first stacked cards that wrap on wide screens; first 3 by default with
 * a "show all returned" toggle. `Fix parse` selects the listing (seam for T4).
 */
function PriceReviewStrip({
  data,
  showAll,
  onToggleShowAll,
  onFix,
  feedbackByFuzzySkuId,
}: {
  data: BrandFamilyMarketMatchResponse
  showAll: boolean
  onToggleShowAll: () => void
  onFix: (c: BrandFamilyMatchCandidate) => void
  feedbackByFuzzySkuId: Map<number, ParseFeedbackRecord[]>
}) {
  const all = data.reviewCandidates
  const shown = showAll ? all : all.slice(0, 3)
  const hiddenBeyondCap = Math.max(0, data.priceOutlierSummary.flaggedCount - all.length)
  return (
    <div style={{ marginBottom: '0.5rem' }}>
      <div
        className="inline-row wrap-row"
        style={{ gap: '0.375rem', alignItems: 'center', justifyContent: 'flex-start', marginBottom: '0.375rem' }}
      >
        <Pill tone="warning" title={priceOutlierSummaryTitle(data.priceOutlierSummary)}>
          Needs review
        </Pill>
        <span className="subtle-copy">
          {data.priceOutlierSummary.flaggedCount} price outlier
          {data.priceOutlierSummary.flaggedCount === 1 ? '' : 's'} to scrutinize
        </span>
        {all.length > 3 ? (
          <button type="button" className="ghost-button" onClick={onToggleShowAll}>
            {showAll ? 'show fewer' : `show all ${all.length}`}
          </button>
        ) : null}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.375rem' }}>
        {shown.map((c) => (
          <div
            key={c.fuzzySkuId}
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              alignItems: 'center',
              gap: '0.5rem',
              flex: '1 1 22rem',
              minWidth: 0,
              border: '1px solid var(--panel-border)',
              borderLeft: REVIEW_ACCENT,
              borderRadius: '0.5rem',
              padding: '0.375rem 0.5rem',
              background: REVIEW_TINT,
            }}
          >
            <Pill tone="warning" title={outlierBadgeTitle(c.priceOutlier)}>
              {outlierDirectionGlyph(c.priceOutlier.kind)} {formatUsdDelta(c.priceOutlier.delta)}
            </Pill>
            {c.url != null ? (
              <a href={c.url} target="_blank" rel="noreferrer">
                {displayOrNull(c.listingName)}
              </a>
            ) : (
              <span>{displayOrNull(c.listingName)}</span>
            )}
            <span className="subtle-copy">{displayOrNull(c.retailer)}</span>
            <span style={{ fontWeight: 600, whiteSpace: 'nowrap' }}>{priceLabel(c)}</span>
            <span className="subtle-copy">{sizeContextLabel(c, data)}</span>
            {(feedbackByFuzzySkuId.get(c.fuzzySkuId)?.length ?? 0) > 0 ? (
              <FeedbackSavedPill count={feedbackByFuzzySkuId.get(c.fuzzySkuId)!.length} />
            ) : null}
            <button
              type="button"
              className="ghost-button"
              style={{ marginLeft: 'auto' }}
              onClick={() => onFix(c)}
            >
              Fix parse
            </button>
          </div>
        ))}
      </div>
      {hiddenBeyondCap > 0 ? (
        <p className="subtle-copy" style={{ margin: '0.375rem 0 0' }}>
          Review list includes {all.length} of {data.priceOutlierSummary.flaggedCount} flagged; {hiddenBeyondCap} more
          beyond the review cap ({data.reviewCandidatesLimit}).
        </p>
      ) : null}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Parse-correction drawer / mobile bottom sheet (issue #59 T4).
//
// Opened from the `Fix parse` / ✎ affordances. Lets the operator correct a
// mis-parsed listing's structured fields and OPTIONALLY record the retailer's
// naming convention, then save to the INERT T3 feedback store. Nothing here
// changes production scoring/matching, fuzzy_skus, aggregates, or IQR — saved
// feedback only improves the operator workflow (saved badges, prefill) until a
// later agent/reviewer promotes it into parsekit (T5). The payload is built
// purely (parseCorrectionDraft.ts): only fields the operator selected + filled
// are sent; provenance is derived server-side from the fuzzy_sku, never here.
// ---------------------------------------------------------------------------

/** Whether the session role may write feedback (POST requires `editor`). */
function canEditFeedback(session: SessionEnvelope | undefined): boolean {
  const role = session?.user?.role
  return role === 'editor' || role === 'approver' || role === 'admin'
}

/** Human labels for the "What's wrong?" issue chips. */
const ISSUE_LABELS: Record<ParseFeedbackIssueType, string> = {
  size: 'Size',
  pack_qty: 'Pack qty',
  category_subcategory: 'Category / subcategory',
  brand: 'Brand',
  name_tokens_strain: 'Name tokens / strain',
  price_genuine: 'Price is genuine',
  no_match: 'Not the same product / no match',
}
const ISSUE_ORDER: readonly ParseFeedbackIssueType[] = [
  'size',
  'pack_qty',
  'category_subcategory',
  'brand',
  'name_tokens_strain',
  'price_genuine',
  'no_match',
]

/** Human labels for the optional convention pattern chips. */
const PATTERN_LABELS: Record<ConventionPatternChip, string> = {
  brand_first: 'Brand first',
  size_at_end: 'Size at end',
  pack_before_size: 'Pack before size',
  total_size_shown: 'Total size shown',
  unit_size_shown: 'Unit size shown',
}
const PATTERN_ORDER: readonly ConventionPatternChip[] = [
  'brand_first',
  'size_at_end',
  'pack_before_size',
  'total_size_shown',
  'unit_size_shown',
]

/** Family-expectation prefill (suggestions only surfaced once a chip is toggled on). */
function prefillCorrectionDraft(data: BrandFamilyMarketMatchResponse): CorrectionDraft {
  return {
    ...emptyCorrectionDraft(),
    packCount: data.packCount != null ? String(data.packCount) : '',
    category: data.categoryName ?? '',
    subcategory: data.subcategoryName ?? '',
    brand: data.brandName ?? '',
  }
}

function toggleArray<T>(arr: readonly T[], value: T): T[] {
  return arr.includes(value) ? arr.filter((v) => v !== value) : [...arr, value]
}

/** A small labelled current-vs-expected comparison row. */
function CompareRow({ label, current, expected }: { label: string; current: string; expected: string }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{current}</dd>
      <dd>{expected}</dd>
    </>
  )
}

/**
 * The parse-correction drawer. Mobile bottom-sheet, desktop right-side drawer
 * (see .pf-drawer CSS). Modal semantics: focus is trapped, Escape / scrim close
 * (unless a save is in flight), background scroll is locked, and focus returns
 * to the invoking control on close.
 */
function ParseCorrectionDrawer({
  candidate,
  data,
  existing,
  canEdit,
  onClose,
  onSaved,
}: {
  candidate: BrandFamilyMatchCandidate
  data: BrandFamilyMarketMatchResponse
  /** Existing feedback for this listing, or null when the fetch is unknown (loading/error). */
  existing: readonly ParseFeedbackRecord[] | null
  canEdit: boolean
  onClose: () => void
  onSaved: (records: readonly ParseFeedbackRecord[]) => void
}) {
  const [draft, setDraft] = useState<CorrectionDraft>(() => prefillCorrectionDraft(data))
  const [convention, setConvention] = useState<ConventionDraft>(() => emptyConventionDraft(candidate.retailerId))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const asideRef = useRef<HTMLElement | null>(null)
  const titleId = `pf-drawer-title-${candidate.fuzzySkuId}`
  const savingRef = useRef(saving)
  savingRef.current = saving

  // Modal chrome: capture opener, lock scroll, move focus in, restore on close.
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    // Focus the first focusable control (the close button) so keyboard/AT land inside.
    const focusables = asideRef.current?.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    )
    focusables?.[0]?.focus()
    return () => {
      document.body.style.overflow = prevOverflow
      opener?.focus()
    }
  }, [])

  const onKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLElement>) => {
      if (e.key === 'Escape') {
        if (!savingRef.current) onClose()
        return
      }
      if (e.key !== 'Tab') return
      const focusables = asideRef.current?.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      )
      if (!focusables || focusables.length === 0) return
      const first = focusables[0]
      const last = focusables[focusables.length - 1]
      const active = document.activeElement
      if (e.shiftKey && active === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && active === last) {
        e.preventDefault()
        first.focus()
      }
    },
    [onClose],
  )

  const selected = new Set(draft.issueTypes)
  const scopeOptions = conventionScopeOptions(candidate.retailerId)
  const preview = buildListingCorrectionDetails(draft)
  const saveReady = canEdit && !saving && canSave(draft, convention)

  async function handleSave() {
    if (!saveReady) return
    setSaving(true)
    setError(null)
    try {
      const body = buildCreateBody(candidate, data, draft, convention)
      const res = await mutateJson(
        '/api/catalog/family-explorer/parse-feedback',
        CreateParseFeedbackResponseSchema,
        { method: 'POST', body: JSON.stringify(body) },
      )
      const saved: ParseFeedbackRecord[] = [res.listingCorrection]
      if (res.conventionProposal != null) saved.push(res.conventionProposal)
      onSaved(saved)
      onClose()
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e))
      setSaving(false)
    }
  }

  const capturedAt =
    candidate.sourceCapturedAt != null ? nyShortDateTime(new Date(candidate.sourceCapturedAt).getTime()) : '—'
  const retailerLabel =
    candidate.retailerId != null
      ? `${displayOrNull(candidate.retailer)} (#${candidate.retailerId})`
      : `${displayOrNull(candidate.retailer)} (no stable retailer id)`

  const existingCount = existing?.length ?? 0

  return (
    <div className="pf-drawer-scrim" role="presentation" onClick={() => (!saving ? onClose() : undefined)}>
      <aside
        ref={asideRef}
        className="pf-drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <div className="pf-drawer-header">
          <div>
            <h3 id={titleId} className="pf-drawer-title">
              Fix parse
            </h3>
            <p className="subtle-copy" style={{ margin: '0.15rem 0 0' }}>
              Correct this listing’s extracted fields · saved feedback is inert (no effect on scoring until promoted).
            </p>
          </div>
          <button type="button" className="ghost-button" onClick={onClose} disabled={saving}>
            Close
          </button>
        </div>

        {/* Section 1 — listing context */}
        <section className="pf-section">
          <dl className="pf-context-grid">
            <dt>Listing</dt>
            <dd>
              {candidate.url != null ? (
                <a href={candidate.url} target="_blank" rel="noreferrer">
                  {displayOrNull(candidate.listingName)}
                </a>
              ) : (
                displayOrNull(candidate.listingName)
              )}
            </dd>
            <dt>Retailer</dt>
            <dd>{retailerLabel}</dd>
            <dt>Price ±tax</dt>
            <dd>
              {priceLabel(candidate)}
              {candidate.priceOutlier != null ? (
                <>
                  {' '}
                  <Pill tone="warning" title={outlierBadgeTitle(candidate.priceOutlier)}>
                    {outlierDirectionGlyph(candidate.priceOutlier.kind)}{' '}
                    {formatUsdDelta(candidate.priceOutlier.delta)}
                  </Pill>
                </>
              ) : null}
            </dd>
            <dt>Distance</dt>
            <dd>
              {distanceBandLabel(candidate.distanceBand)}
              {candidate.distanceMiles != null ? ` · ${candidate.distanceMiles.toFixed(1)} mi` : ''}
            </dd>
            <dt>Snapshot</dt>
            <dd>{capturedAt}</dd>
            <dt>Score</dt>
            <dd>{fmtScore(candidate.score)}</dd>
          </dl>
        </section>

        {/* Section 2 — current parse vs family expectation */}
        <section className="pf-section">
          <h4 className="pf-section-title">Current parse vs family expectation</h4>
          <dl className="pf-compare-grid">
            <dt className="subtle-copy">field</dt>
            <dd className="subtle-copy">current (listing)</dd>
            <dd className="subtle-copy">expected (family)</dd>
            <CompareRow
              label="Brand"
              current={
                displayOrNull(candidate.brandRaw) +
                (candidate.brandNorm != null ? ` / ${candidate.brandNorm}` : '')
              }
              expected={displayOrNull(data.brandName)}
            />
            <CompareRow
              label="Category"
              current={displayOrNull(candidate.categoryNorm)}
              expected={displayOrNull(data.categoryName)}
            />
            <CompareRow
              label="Subcategory"
              current={displayOrNull(candidate.subcategoryNorm)}
              expected={displayOrNull(data.subcategoryName)}
            />
            <CompareRow
              label="Size"
              current={displayOrNull(candidate.parsedSizeLabel)}
              expected={data.sizeGroupLabel}
            />
            <CompareRow label="Pack" current="— (not parsed)" expected={packLabel(data.packCount)} />
          </dl>
        </section>

        {/* Existing feedback for this listing (duplicate-awareness) */}
        {existing == null ? (
          <p className="subtle-copy pf-section">Could not load existing feedback for this listing.</p>
        ) : existingCount > 0 ? (
          <p className="subtle-copy pf-section">
            This listing already has {existingCount} saved feedback record{existingCount === 1 ? '' : 's'}. Saving
            creates <strong>another</strong> draft — it does not edit or replace the prior one(s).
          </p>
        ) : null}

        {!canEdit ? (
          <p className="subtle-copy pf-section">
            Editing parse feedback needs the <strong>editor</strong> role. This is a read-only view.
          </p>
        ) : (
          <>
            {/* Section 3 — "what's wrong?" chips */}
            <section className="pf-section">
              <h4 className="pf-section-title">What’s wrong?</h4>
              <div className="pf-chip-row">
                {ISSUE_ORDER.map((issue) => {
                  const on = selected.has(issue)
                  return (
                    <button
                      key={issue}
                      type="button"
                      className={on ? 'primary-button' : 'ghost-button'}
                      aria-pressed={on}
                      onClick={() => setDraft((d) => ({ ...d, issueTypes: toggleArray(d.issueTypes, issue) }))}
                    >
                      {ISSUE_LABELS[issue]}
                    </button>
                  )
                })}
              </div>
            </section>

            {/* Section 4 — correction fields (revealed per selected chip) */}
            {selected.has('size') ? (
              <section className="pf-section">
                <h4 className="pf-section-title">Corrected size</h4>
                <div className="pf-field-grid">
                  <label>
                    Unit size value
                    <input
                      type="number"
                      inputMode="decimal"
                      step="any"
                      min="0"
                      value={draft.unitSizeValue}
                      onChange={(e) => setDraft((d) => ({ ...d, unitSizeValue: e.target.value }))}
                    />
                  </label>
                  <label>
                    Unit size unit
                    <input
                      type="text"
                      placeholder="g / mg / ml"
                      value={draft.unitSizeUnit}
                      onChange={(e) => setDraft((d) => ({ ...d, unitSizeUnit: e.target.value }))}
                    />
                  </label>
                  <label>
                    Total size value
                    <input
                      type="number"
                      inputMode="decimal"
                      step="any"
                      min="0"
                      value={draft.totalSizeValue}
                      onChange={(e) => setDraft((d) => ({ ...d, totalSizeValue: e.target.value }))}
                    />
                  </label>
                  <label>
                    Total size unit
                    <input
                      type="text"
                      placeholder="g / mg / ml"
                      value={draft.totalSizeUnit}
                      onChange={(e) => setDraft((d) => ({ ...d, totalSizeUnit: e.target.value }))}
                    />
                  </label>
                </div>
                <p className="subtle-copy" style={{ margin: '0.25rem 0 0' }}>
                  Enter a value AND its unit for either the unit size or the total size (or both).
                </p>
              </section>
            ) : null}

            {selected.has('pack_qty') ? (
              <section className="pf-section">
                <h4 className="pf-section-title">Corrected pack count</h4>
                <div className="pf-field-grid">
                  <label>
                    Pack count
                    <input
                      type="number"
                      inputMode="numeric"
                      step="1"
                      min="1"
                      value={draft.packCount}
                      onChange={(e) => setDraft((d) => ({ ...d, packCount: e.target.value }))}
                    />
                  </label>
                </div>
              </section>
            ) : null}

            {selected.has('category_subcategory') ? (
              <section className="pf-section">
                <h4 className="pf-section-title">Corrected category / subcategory</h4>
                <div className="pf-field-grid">
                  <label>
                    Category
                    <input
                      type="text"
                      value={draft.category}
                      onChange={(e) => setDraft((d) => ({ ...d, category: e.target.value }))}
                    />
                  </label>
                  <label>
                    Subcategory
                    <input
                      type="text"
                      value={draft.subcategory}
                      onChange={(e) => setDraft((d) => ({ ...d, subcategory: e.target.value }))}
                    />
                  </label>
                </div>
              </section>
            ) : null}

            {selected.has('brand') ? (
              <section className="pf-section">
                <h4 className="pf-section-title">Corrected brand</h4>
                <div className="pf-field-grid">
                  <label>
                    Brand
                    <input
                      type="text"
                      value={draft.brand}
                      onChange={(e) => setDraft((d) => ({ ...d, brand: e.target.value }))}
                    />
                  </label>
                </div>
                <p className="subtle-copy" style={{ margin: '0.25rem 0 0' }}>
                  This records the correct brand for this listing’s parse — it does not change brand→family mapping.
                </p>
              </section>
            ) : null}

            {selected.has('name_tokens_strain') ? (
              <section className="pf-section">
                <h4 className="pf-section-title">Corrected name tokens / strain</h4>
                <div className="pf-field-grid">
                  <label>
                    Strain
                    <input
                      type="text"
                      value={draft.strain}
                      onChange={(e) => setDraft((d) => ({ ...d, strain: e.target.value }))}
                    />
                  </label>
                  <label>
                    Name tokens
                    <input
                      type="text"
                      value={draft.nameTokens}
                      onChange={(e) => setDraft((d) => ({ ...d, nameTokens: e.target.value }))}
                    />
                  </label>
                </div>
              </section>
            ) : null}

            <section className="pf-section">
              <label>
                Note (optional)
                <textarea
                  rows={2}
                  value={draft.note}
                  onChange={(e) => setDraft((d) => ({ ...d, note: e.target.value }))}
                  placeholder="Anything a reviewer should know about this correction"
                />
              </label>
            </section>

            {/* Section 5 — optional convention capture */}
            <section className="pf-section">
              <label className="pf-checkbox">
                <input
                  type="checkbox"
                  checked={convention.enabled}
                  onChange={(e) => setConvention((c) => ({ ...c, enabled: e.target.checked }))}
                />
                Also record this retailer’s naming convention
              </label>
              {convention.enabled ? (
                <div style={{ marginTop: '0.5rem' }}>
                  <div className="pf-field-grid">
                    <label>
                      Scope
                      <select
                        value={convention.scope}
                        onChange={(e) =>
                          setConvention((c) => ({ ...c, scope: e.target.value as ConventionDraft['scope'] }))
                        }
                      >
                        {scopeOptions.map((o) => (
                          <option key={o.value} value={o.value} disabled={o.disabled}>
                            {o.label}
                            {o.disabled ? ' (needs retailer id)' : ''}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                  <label style={{ marginTop: '0.5rem', display: 'block' }}>
                    Convention note
                    <textarea
                      rows={2}
                      value={convention.note}
                      onChange={(e) => setConvention((c) => ({ ...c, note: e.target.value }))}
                      placeholder="e.g. brand first, size at end, pack shown before size"
                    />
                  </label>
                  <div style={{ marginTop: '0.5rem' }}>
                    <span className="subtle-copy">Pattern hints</span>
                    <div className="pf-chip-row" style={{ marginTop: '0.25rem' }}>
                      {PATTERN_ORDER.map((chip) => {
                        const on = convention.patternChips.includes(chip)
                        return (
                          <button
                            key={chip}
                            type="button"
                            className={on ? 'primary-button' : 'ghost-button'}
                            aria-pressed={on}
                            onClick={() =>
                              setConvention((c) => ({ ...c, patternChips: toggleArray(c.patternChips, chip) }))
                            }
                          >
                            {PATTERN_LABELS[chip]}
                          </button>
                        )
                      })}
                    </div>
                  </div>
                  <p className="subtle-copy" style={{ margin: '0.4rem 0 0' }}>
                    Auto example from this listing: <em>{displayOrNull(candidate.listingName)}</em>. Add a note or at
                    least one pattern hint. You never write parser rules — this is a hint for a later reviewer.
                  </p>
                </div>
              ) : null}
            </section>

            {/* "This will be saved as" echo (no score/production effect) */}
            <section className="pf-section">
              <details>
                <summary className="subtle-copy" style={{ cursor: 'pointer' }}>
                  This will be saved as…
                </summary>
                <pre className="pf-preview">{JSON.stringify(preview, null, 2)}</pre>
              </details>
            </section>

            {error != null ? (
              <p className="pf-section" style={{ color: 'var(--danger)' }}>
                Save failed: {error}
              </p>
            ) : null}

            <div className="pf-drawer-actions">
              <button type="button" className="ghost-button" onClick={onClose} disabled={saving}>
                Cancel
              </button>
              <button type="button" className="primary-button" onClick={handleSave} disabled={!saveReady}>
                {saving ? 'Saving…' : 'Save correction'}
              </button>
            </div>
          </>
        )}
      </aside>
    </div>
  )
}

/** Small "feedback saved" marker for rows/cards that already have ≥1 record. */
function FeedbackSavedPill({ count }: { count: number }) {
  return (
    <Pill tone="success" title={`${count} saved parse-feedback record${count === 1 ? '' : 's'} for this listing`}>
      ✓ feedback{count > 1 ? ` ×${count}` : ''}
    </Pill>
  )
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
            {data.priceOutlierSummary.flaggedCount > 0 ? (
              <>
                {' '}
                <Pill tone="warning" title={priceOutlierSummaryTitle(data.priceOutlierSummary)}>
                  {data.priceOutlierSummary.flaggedCount} price review
                </Pill>
              </>
            ) : null}
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
  const session = useRouteLoaderData('root') as SessionEnvelope | undefined
  const canEdit = canEditFeedback(session)
  const [showAllReview, setShowAllReview] = useState(false)
  const [fixTarget, setFixTarget] = useState<BrandFamilyMatchCandidate | null>(null)

  // Existing feedback for the visible listings (badge + duplicate-awareness).
  // status distinguishes "unknown" (loading/error) from a confirmed "none" so
  // the drawer never mislabels an unknown state as "no prior feedback". This is
  // purely an operator-workflow read — it NEVER feeds the scorer / ordering /
  // outlier stats (the feedback store is inert).
  const [feedbackStatus, setFeedbackStatus] = useState<'loading' | 'loaded' | 'error'>('loading')
  const [feedbackByFuzzySkuId, setFeedbackByFuzzySkuId] = useState<Map<number, ParseFeedbackRecord[]>>(
    () => new Map(),
  )

  useEffect(() => {
    let cancelled = false
    const ids = feedbackFetchIds(data, PARSE_FEEDBACK_ID_QUERY_LIMIT)
    if (ids.length === 0) {
      setFeedbackStatus('loaded')
      setFeedbackByFuzzySkuId(new Map())
      return
    }
    setFeedbackStatus('loading')
    const qs = new URLSearchParams({ fuzzySkuIds: ids.join(',') }).toString()
    loadJson(`/api/catalog/family-explorer/parse-feedback?${qs}`, ParseFeedbackListResponseSchema)
      .then((res) => {
        if (cancelled) return
        const map = new Map<number, ParseFeedbackRecord[]>()
        for (const rec of res.feedback) {
          if (rec.fuzzySkuId == null) continue
          const list = map.get(rec.fuzzySkuId)
          if (list) list.push(rec)
          else map.set(rec.fuzzySkuId, [rec])
        }
        setFeedbackByFuzzySkuId(map)
        setFeedbackStatus('loaded')
      })
      .catch(() => {
        // Non-fatal: badges are a convenience, not the point of the panel.
        if (cancelled) return
        setFeedbackStatus('error')
      })
    return () => {
      cancelled = true
    }
  }, [data])

  const onSaved = useCallback((records: readonly ParseFeedbackRecord[]) => {
    setFeedbackByFuzzySkuId((prev) => {
      const next = new Map(prev)
      for (const rec of records) {
        if (rec.fuzzySkuId == null) continue
        const list = next.get(rec.fuzzySkuId)
        next.set(rec.fuzzySkuId, list ? [...list, rec] : [rec])
      }
      return next
    })
  }, [])

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

      {data.reviewCandidates.length > 0 ? (
        <PriceReviewStrip
          data={data}
          showAll={showAllReview}
          onToggleShowAll={() => setShowAllReview((v) => !v)}
          onFix={setFixTarget}
          feedbackByFuzzySkuId={feedbackByFuzzySkuId}
        />
      ) : null}

      {fixTarget != null ? (
        <ParseCorrectionDrawer
          candidate={fixTarget}
          data={data}
          existing={feedbackStatus === 'loaded' ? feedbackByFuzzySkuId.get(fixTarget.fuzzySkuId) ?? [] : null}
          canEdit={canEdit}
          onClose={() => setFixTarget(null)}
          onSaved={onSaved}
        />
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
                {data.candidates.map((c) => {
                  const outlier = c.priceOutlier
                  return (
                  <Fragment key={c.fuzzySkuId}>
                    {c.fuzzySkuId === firstBelowId ? (
                      <tr>
                        <td colSpan={18} className="subtle-copy" style={{ textAlign: 'center' }}>
                          — below threshold {fmtScore(data.threshold)} —
                        </td>
                      </tr>
                    ) : null}
                    <tr style={outlier != null ? { background: REVIEW_TINT } : undefined}>
                      <td
                        style={
                          outlier != null
                            ? { ...STICKY_SCORE_COL, background: '#faf1d9', borderLeft: REVIEW_ACCENT }
                            : STICKY_SCORE_COL
                        }
                      >
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.25rem', justifyContent: 'flex-end' }}>
                          {outlier != null ? (
                            <span
                              aria-label={outlierDirectionLabel(outlier.kind)}
                              title={outlierBadgeTitle(outlier)}
                              style={{ color: 'var(--warning)', fontWeight: 700, fontSize: '0.72rem' }}
                            >
                              {outlierDirectionGlyph(outlier.kind)}
                            </span>
                          ) : null}
                          {c.aboveThreshold ? (
                            <Pill tone="success">{fmtScore(c.score)}</Pill>
                          ) : (
                            <Pill tone="muted">{fmtScore(c.score)}</Pill>
                          )}
                          <button
                            type="button"
                            className="ghost-button"
                            onClick={() => setFixTarget(c)}
                            aria-label={`Fix parse for ${c.listingName ?? `listing ${c.fuzzySkuId}`}`}
                            title="Fix parse"
                            style={{ padding: '0 0.3rem', minWidth: 0, lineHeight: 1.2, fontSize: '0.85rem' }}
                          >
                            ✎
                          </button>
                        </span>
                      </td>
                      <td>
                        {c.url != null ? (
                          <a href={c.url} target="_blank" rel="noreferrer">
                            {displayOrNull(c.listingName)}
                          </a>
                        ) : (
                          displayOrNull(c.listingName)
                        )}
                        {(feedbackByFuzzySkuId.get(c.fuzzySkuId)?.length ?? 0) > 0 ? (
                          <>
                            {' '}
                            <FeedbackSavedPill count={feedbackByFuzzySkuId.get(c.fuzzySkuId)!.length} />
                          </>
                        ) : null}
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
                      <td style={{ whiteSpace: 'nowrap', ...(outlier != null ? { fontWeight: 600 } : {}) }}>
                        {priceLabel(c)}
                      </td>
                      <td style={{ textAlign: 'right' }}>{c.currentStock ?? '—'}</td>
                      <FactorCells
                        f={c.factors}
                        subMuted={data.subcategoryNotMatchable}
                        packMuted={data.packNotMatchable}
                      />
                    </tr>
                  </Fragment>
                  )
                })}
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
