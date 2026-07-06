import { useMemo, useState } from 'react'
import { useLoaderData } from 'react-router-dom'

import {
  CatalogFamilyExplorerResponseSchema,
  type CatalogFamilyExplorerResponse,
} from '../../../shared/contracts/index.js'
import {
  groupFamilies,
  type FamilyExplorerMode,
  type FamilyGroup,
} from '../../../shared/domain/familyExplorer.js'
import { loadJson } from '../../app/fetchJson.js'
import { nyLongDateTime } from '../../app/nyTime.js'
import { Pill } from '../../components/Pill.js'
import { useRegisterCatalogSidebarSubtree } from './catalogSidebarSubtree.js'

/**
 * Catalog → Family Explorer (issue #55, task T1) — TEMPORARY operator-only
 * audit surface for iterating on categorical-family grouping correctness.
 *
 * Shows, for the WHOLE variant catalog, the resolved categorical families and
 * EXACTLY which variants land in each — the point is auditable membership so
 * the operator can confirm the grouping (and the T2 size-group folding) is
 * right before we build the richer per-family pricing UX in later steps.
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

export function CatalogFamilyExplorerPage() {
  useRegisterCatalogSidebarSubtree()
  const data = useLoaderData() as CatalogFamilyExplorerResponse
  const [mode, setMode] = useState<FamilyExplorerMode>('nonbrand')
  const [filter, setFilter] = useState('')

  const groups = useMemo(() => groupFamilies(data.variants, mode), [data.variants, mode])

  const filterLower = filter.trim().toLowerCase()
  const visibleGroups = useMemo(() => {
    if (filterLower.length === 0) return groups
    return groups.filter((group) => {
      if (familyHeaderParts(group).join(' ').toLowerCase().includes(filterLower)) return true
      return group.members.some(
        (m) =>
          (m.name ?? '').toLowerCase().includes(filterLower) ||
          (m.sku ?? '').toLowerCase().includes(filterLower) ||
          (m.brandName ?? '').toLowerCase().includes(filterLower),
      )
    })
  }, [groups, filterLower])

  const unparsedCount = groups.filter((g) => g.sizeUnparsed).length

  return (
    <section>
      <div className="page-header">
        <div>
          <p className="eyebrow">Catalog Module</p>
          <h2>
            Family Explorer <Pill tone="warning">TEMPORARY</Pill>
          </h2>
          <p className="subtle-copy">
            {groups.length.toLocaleString()} families over{' '}
            {data.variants.length.toLocaleString()} variants (whole catalog).
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

      {visibleGroups.length === 0 ? (
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
                  {group.members.map((m) => (
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
          </details>
        ))
      )}

      <details className="mini-card" style={{ marginTop: '1rem' }}>
        <summary style={{ cursor: 'pointer' }}>About this page</summary>
        <div className="subtle-copy" style={{ marginTop: '0.5rem' }}>
          <p>
            <strong>TEMPORARY iteration surface</strong> (issue #55 step 1). It groups the whole
            variant catalog into “categorical families” so the grouping and the size-group
            equivalency can be validated in isolation before the richer per-family pricing UX is
            built.
          </p>
          <p>
            A family = category × subcategory × <em>size group</em> × pack count (plus brand in
            brand mode). The <em>size group</em> folds “morally equivalent” sizes: pre-rolls roll
            novelty sizes into standard buckets (e.g. 0.6&nbsp;g → 0.5&nbsp;g, shown with “≈”),
            while every other category keeps its natural size. This folding is wired in HERE ONLY;
            it does not change existing pricing / market-match runs.
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
