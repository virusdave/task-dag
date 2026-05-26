import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLoaderData } from 'react-router-dom'
import { z } from 'zod'

import { loadJson, mutateJson } from '../../app/fetchJson.js'
import { Pill } from '../../components/Pill.js'
import { useRegisterCatalogSidebarSubtree } from './catalogSidebarSubtree.js'

/**
 * Catalog → Brand Mapping page (issue #20 follow-on).
 *
 * One row per catalog brand. Operator-confirmed override lives in
 * `catalog_litalerts_brand_overrides`; the heuristic candidate
 * (exact / case-insensitive / normalized / token-overlap) is shown
 * for context. The combobox is populated with ALL LitAlerts NY brands
 * and filters as the operator types. A single submit button per row
 * upserts via PUT /api/catalog/brand-mapping/:brandName.
 *
 * Reviewer ergonomics: by default the table surfaces only rows that
 * still need attention (no override OR a low-confidence heuristic).
 * The "Show all" toggle expands to every catalog brand, including the
 * ones the heuristic already nailed.
 */

interface LitalertsBrandSummary {
  brandId: number
  name: string
  statesCsv: string | null
  productCount: number
  configCount: number
}

interface CatalogBrandMappingRow {
  catalogBrandName: string
  catalogGroupCount: number
  override: {
    litalertsBrandId: number | null
    litalertsBrandName: string | null
    setByUserId: string | null
    setAt: string
    notes: string | null
  } | null
  heuristic: {
    brandId: number
    name: string
    productCount: number
    configCount: number
    confidence: 'exact' | 'case-insensitive' | 'normalized' | 'token-overlap'
  } | null
  effective: {
    litalertsBrandId: number | null
    litalertsBrandName: string | null
    confidence: 'override' | 'exact' | 'case-insensitive' | 'normalized' | 'token-overlap' | 'none'
  }
}

interface BrandMappingListResponse {
  rows: CatalogBrandMappingRow[]
  litalertsBrands: LitalertsBrandSummary[]
  totals: {
    catalogBrandCount: number
    overrideCount: number
    explicitNoMatchCount: number
    heuristicOnlyCount: number
    unmappedCount: number
  }
}

const ListResponseSchema = z.any() as z.ZodType<BrandMappingListResponse>
const RowResponseSchema = z.any() as z.ZodType<{ row: CatalogBrandMappingRow }>

export async function catalogBrandMappingLoader(): Promise<BrandMappingListResponse> {
  return loadJson('/api/catalog/brand-mapping', ListResponseSchema)
}

export function CatalogBrandMappingPage(): JSX.Element {
  useRegisterCatalogSidebarSubtree()
  const initial = useLoaderData() as BrandMappingListResponse
  const [rows, setRows] = useState<CatalogBrandMappingRow[]>(initial.rows)
  const [litalertsBrands] = useState<LitalertsBrandSummary[]>(initial.litalertsBrands)
  const [totals, setTotals] = useState(initial.totals)
  const [showAll, setShowAll] = useState(false)
  const [filterText, setFilterText] = useState('')
  const [error, setError] = useState<string | null>(null)

  function recomputeTotals(next: CatalogBrandMappingRow[]): BrandMappingListResponse['totals'] {
    return {
      catalogBrandCount: next.length,
      overrideCount: next.filter((r) => r.override != null && r.override.litalertsBrandId != null).length,
      explicitNoMatchCount: next.filter((r) => r.override != null && r.override.litalertsBrandId == null).length,
      heuristicOnlyCount: next.filter((r) => r.override == null && r.heuristic != null).length,
      unmappedCount: next.filter((r) => r.override == null && r.heuristic == null).length,
    }
  }

  const handleRowUpdated = useCallback((updated: CatalogBrandMappingRow) => {
    setRows((prev) => {
      const next = prev.map((r) => (r.catalogBrandName === updated.catalogBrandName ? updated : r))
      setTotals(recomputeTotals(next))
      return next
    })
  }, [])

  const visibleRows = useMemo(() => {
    const f = filterText.trim().toLowerCase()
    return rows.filter((r) => {
      if (f.length > 0) {
        const hay = `${r.catalogBrandName} ${r.heuristic?.name ?? ''} ${r.override?.litalertsBrandName ?? ''}`
        if (!hay.toLowerCase().includes(f)) return false
      }
      if (!showAll) {
        // Default: rows that still need operator attention
        const needsAttention =
          r.override == null && (r.heuristic == null || r.heuristic.confidence === 'token-overlap')
        if (!needsAttention) return false
      }
      return true
    })
  }, [rows, filterText, showAll])

  return (
    <div className="stacked-list">
      <section className="detail-panel">
        <div className="page-header" style={{ marginBottom: '0.5rem' }}>
          <div>
            <p className="eyebrow">Catalog → Brand Mapping</p>
            <h2>{totals.catalogBrandCount} catalog brands · {totals.overrideCount} confirmed · {totals.unmappedCount} unmapped</h2>
          </div>
          <div className="inline-row" style={{ gap: '0.5rem' }}>
            <Pill tone={totals.unmappedCount === 0 ? 'success' : 'warning'}>
              {`${totals.unmappedCount} unmapped`}
            </Pill>
            <Pill tone="muted">{`${totals.heuristicOnlyCount} heuristic only`}</Pill>
            <Pill tone="muted">{`${totals.explicitNoMatchCount} explicit no-match`}</Pill>
          </div>
        </div>

        <div className="inline-row wrap-row" style={{ marginBottom: '0.75rem' }}>
          <input
            onChange={(e) => setFilterText(e.currentTarget.value)}
            placeholder="Filter visible rows…"
            style={{ flex: '0 1 18rem' }}
            value={filterText}
          />
          <label className="inline-row">
            <input checked={showAll} onChange={(e) => setShowAll(e.currentTarget.checked)} type="checkbox" />
            Show all (incl. confidently-matched)
          </label>
          <Pill tone="muted">{`${visibleRows.length} visible`}</Pill>
        </div>

        {error ? <p className="error-banner">{error}</p> : null}

        <table className="data-table">
          <thead>
            <tr>
              <th>Catalog brand</th>
              <th style={{ textAlign: 'right' }}>Groups</th>
              <th>System guess</th>
              <th>LitAlerts mapping</th>
              <th style={{ width: '1%' }} />
            </tr>
          </thead>
          <tbody>
            {visibleRows.map((row) => (
              <BrandMappingRow
                key={row.catalogBrandName}
                litalertsBrands={litalertsBrands}
                onError={setError}
                onUpdated={handleRowUpdated}
                row={row}
              />
            ))}
          </tbody>
        </table>

        <details style={{ marginTop: '1.5rem' }}>
          <summary>About this page</summary>
          <div className="subtle-copy" style={{ marginTop: '0.5rem' }}>
            <p>
              Maps each catalog brand to its LitAlerts NY equivalent. The combobox is populated with all
              {' '}{litalertsBrands.length} LitAlerts NY brands and filters as you type. Select one and press
              {' '}<em>Save</em> to persist into <code>catalog_litalerts_brand_overrides</code>. Pressing
              {' '}<em>No match</em> records an explicit "this catalog brand has no LitAlerts equivalent"
              verdict (still satisfying "reviewed"). Pressing <em>Clear</em> deletes the override and falls
              back to the heuristic.
            </p>
            <p>
              The heuristic shown in <strong>System guess</strong> is the same one used by
              {' '}<code>scripts/litalerts-brand-mapping-sanity.mts</code>: exact → case-insensitive →
              normalized → token-overlap (Jaccard ≥ 0.5). Overrides always win over the heuristic when
              Catalog → Market Data, pricing comps, etc. resolve a catalog brand to LitAlerts data.
            </p>
            <p>
              By default the table hides rows the heuristic is confident about (exact / case-insensitive /
              normalized matches) so the operator only sees the rows that need attention. Toggle
              {' '}<em>Show all</em> to audit them too.
            </p>
          </div>
        </details>
      </section>
    </div>
  )
}

interface BrandMappingRowProps {
  row: CatalogBrandMappingRow
  litalertsBrands: LitalertsBrandSummary[]
  onUpdated: (row: CatalogBrandMappingRow) => void
  onError: (msg: string | null) => void
}

function BrandMappingRow({ row, litalertsBrands, onUpdated, onError }: BrandMappingRowProps): JSX.Element {
  // Start the combobox showing the currently effective mapping so an
  // unaware operator presses "Save" and just confirms the heuristic
  // rather than accidentally clearing it.
  const initialSelectedId = row.override?.litalertsBrandId ?? row.heuristic?.brandId ?? null
  const initialSelectedName = row.override?.litalertsBrandName ?? row.heuristic?.name ?? ''
  const [selectedId, setSelectedId] = useState<number | null>(initialSelectedId)
  const [query, setQuery] = useState<string>(initialSelectedName)
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState<'save' | 'no-match' | 'clear' | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  // Filter the dropdown list as the operator types. We sort suggestions
  // so exact prefix matches float to the top and high-volume brands win
  // tiebreaks (more data == more likely the real mapping).
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    const scored = litalertsBrands
      .map((lb) => {
        const lower = lb.name.toLowerCase()
        let score = 0
        if (q.length > 0) {
          if (lower === q) score = 1000
          else if (lower.startsWith(q)) score = 500
          else if (lower.includes(q)) score = 100
          else return null
        }
        return { lb, score: score + Math.log1p(lb.productCount) }
      })
      .filter((s): s is { lb: LitalertsBrandSummary; score: number } => s !== null)
      .sort((a, b) => b.score - a.score)
      .slice(0, 50)
    return scored.map((s) => s.lb)
  }, [litalertsBrands, query])

  useEffect(() => {
    function handleClickOutside(e: MouseEvent): void {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  function pick(lb: LitalertsBrandSummary): void {
    setSelectedId(lb.brandId)
    setQuery(lb.name)
    setOpen(false)
  }

  async function save(litalertsBrandId: number | null): Promise<void> {
    setPending(litalertsBrandId == null ? 'no-match' : 'save')
    onError(null)
    try {
      const resp = await mutateJson(
        `/api/catalog/brand-mapping/${encodeURIComponent(row.catalogBrandName)}`,
        RowResponseSchema,
        {
          method: 'PUT',
          body: JSON.stringify({ litalertsBrandId }),
        },
      )
      onUpdated(resp.row)
    } catch (e) {
      onError(e instanceof Error ? e.message : 'save failed')
    } finally {
      setPending(null)
    }
  }

  async function clear(): Promise<void> {
    setPending('clear')
    onError(null)
    try {
      await mutateJson(
        `/api/catalog/brand-mapping/${encodeURIComponent(row.catalogBrandName)}`,
        z.any(),
        { method: 'DELETE' },
      )
      // Re-fetch the row by hitting the list again is overkill; just
      // synthesize the cleared shape locally.
      onUpdated({
        ...row,
        override: null,
        effective: row.heuristic
          ? {
              litalertsBrandId: row.heuristic.brandId,
              litalertsBrandName: row.heuristic.name,
              confidence: row.heuristic.confidence,
            }
          : { litalertsBrandId: null, litalertsBrandName: null, confidence: 'none' },
      })
      setSelectedId(row.heuristic?.brandId ?? null)
      setQuery(row.heuristic?.name ?? '')
    } catch (e) {
      onError(e instanceof Error ? e.message : 'clear failed')
    } finally {
      setPending(null)
    }
  }

  const effectiveBadge = (() => {
    const c = row.effective.confidence
    if (c === 'override') return <Pill tone="success">override</Pill>
    if (c === 'exact') return <Pill tone="success">exact</Pill>
    if (c === 'case-insensitive') return <Pill tone="muted">case</Pill>
    if (c === 'normalized') return <Pill tone="muted">norm</Pill>
    if (c === 'token-overlap') return <Pill tone="warning">token</Pill>
    return <Pill tone="warning">unmapped</Pill>
  })()

  return (
    <tr>
      <td>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.15rem' }}>
          <strong>{row.catalogBrandName}</strong>
          {row.override?.setByUserId ? (
            <span className="subtle-copy" style={{ fontSize: '0.8rem' }}>
              set by {row.override.setByUserId} {new Date(row.override.setAt).toLocaleString()}
            </span>
          ) : null}
        </div>
      </td>
      <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{row.catalogGroupCount}</td>
      <td>
        {row.heuristic ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.15rem' }}>
            <span>{row.heuristic.name}</span>
            <span className="subtle-copy" style={{ fontSize: '0.8rem' }}>
              <Pill tone={row.heuristic.confidence === 'token-overlap' ? 'warning' : 'muted'}>
                {row.heuristic.confidence}
              </Pill>{' '}
              {row.heuristic.productCount} products / {row.heuristic.configCount} configs
            </span>
          </div>
        ) : (
          <span className="subtle-copy">— no heuristic candidate —</span>
        )}
      </td>
      <td>
        <div ref={containerRef} style={{ position: 'relative' }}>
          <div className="inline-row" style={{ gap: '0.25rem', alignItems: 'center' }}>
            {effectiveBadge}
            <input
              onChange={(e) => {
                setQuery(e.currentTarget.value)
                setSelectedId(null)
                setOpen(true)
              }}
              onFocus={() => setOpen(true)}
              placeholder="Type to search LitAlerts brands…"
              style={{ flex: '1 1 18rem' }}
              value={query}
            />
          </div>
          {open ? (
            <div
              style={{
                position: 'absolute',
                top: '100%',
                left: 0,
                right: 0,
                zIndex: 20,
                background: 'var(--panel-bg, #fff)',
                border: '1px solid var(--border-color, #ccc)',
                borderRadius: '4px',
                marginTop: '2px',
                maxHeight: '20rem',
                overflowY: 'auto',
                boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
              }}
            >
              {filtered.length === 0 ? (
                <div className="subtle-copy" style={{ padding: '0.5rem' }}>
                  No LitAlerts brands match "{query}"
                </div>
              ) : (
                filtered.map((lb) => (
                  <button
                    key={lb.brandId}
                    onClick={() => pick(lb)}
                    style={{
                      display: 'block',
                      width: '100%',
                      textAlign: 'left',
                      padding: '0.4rem 0.6rem',
                      border: 'none',
                      background: lb.brandId === selectedId ? 'rgba(0,120,200,0.1)' : 'transparent',
                      cursor: 'pointer',
                    }}
                    type="button"
                  >
                    <div>{lb.name}</div>
                    <div className="subtle-copy" style={{ fontSize: '0.78rem' }}>
                      id={lb.brandId} · {lb.productCount} products / {lb.configCount} configs
                    </div>
                  </button>
                ))
              )}
            </div>
          ) : null}
        </div>
      </td>
      <td>
        <div className="inline-row" style={{ gap: '0.25rem', flexWrap: 'wrap' }}>
          <button
            className="ghost-button"
            disabled={pending !== null || selectedId == null}
            onClick={() => save(selectedId)}
            type="button"
          >
            {pending === 'save' ? 'Saving…' : 'Save'}
          </button>
          <button
            className="ghost-button"
            disabled={pending !== null}
            onClick={() => save(null)}
            title="Record explicit 'no LitAlerts equivalent'"
            type="button"
          >
            {pending === 'no-match' ? '…' : 'No match'}
          </button>
          {row.override ? (
            <button
              className="ghost-button"
              disabled={pending !== null}
              onClick={() => clear()}
              title="Delete override; fall back to heuristic"
              type="button"
            >
              {pending === 'clear' ? '…' : 'Clear'}
            </button>
          ) : null}
        </div>
      </td>
    </tr>
  )
}
