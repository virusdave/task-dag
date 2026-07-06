import { useMemo, useState } from 'react'
import { useLoaderData } from 'react-router-dom'

import {
  CatalogFamilyExplorerResponseSchema,
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
import { nyLongDateTime } from '../../app/nyTime.js'
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
                <details
                  key={sub.brandKey ?? '\u0000(no brand)'}
                  className="mini-card"
                  style={{ marginBottom: '0.375rem' }}
                >
                  <summary style={{ cursor: 'pointer' }}>
                    <span style={{ fontWeight: 600 }}>{sub.brandName ?? '(no brand)'}</span>{' '}
                    <Pill tone="muted">
                      {sub.memberCount} variant{sub.memberCount === 1 ? '' : 's'}
                    </Pill>
                  </summary>
                  <VariantTable members={sub.members} />
                </details>
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
