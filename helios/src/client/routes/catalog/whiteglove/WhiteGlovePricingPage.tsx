import { useCallback, useEffect, useMemo, useState } from 'react'

import {
  CostBasisRefreshResponseSchema,
  WhitegloveCurrentSnapshotResponseSchema,
  WHITEGLOVE_SIZES,
  WHITEGLOVE_TAX_MULT,
  computeWhitegloveOtd,
  pickWhitegloveEffectiveDecision,
  pickWhitegloveGm,
  type CostBasisRefreshResponse,
  type WhitegloveCurrentSnapshotResponse,
  type WhitegloveDecision,
  type WhitegloveSnapshotEnvelope,
} from '../../../../shared/contracts/index.js'
import { loadJson } from '../../../app/fetchJson.js'
import { useRegisterCatalogSidebarSubtree } from '../catalogSidebarSubtree.js'

type SizeMap = { quarterLb: number; halfLb: number; lb: number }
type BrandGmMap = Record<string, SizeMap>
type DecisionMap = Record<string, WhitegloveDecision>

const DEFAULT_GMS: SizeMap = {
  quarterLb: WHITEGLOVE_SIZES[0].defaultGm,
  halfLb: WHITEGLOVE_SIZES[1].defaultGm,
  lb: WHITEGLOVE_SIZES[2].defaultGm,
}

function rowKey(brand: string, strainShort: string): string {
  return `${brand}||${strainShort}`
}

function fmtPct(v: number): string {
  return `${(v * 100).toFixed(1)}%`
}

function fmt$(v: number | null): string {
  if (v === null || !Number.isFinite(v)) return '—'
  return `$${Math.round(v).toLocaleString()}`
}

function fmt$2(v: number | null): string {
  if (v === null || !Number.isFinite(v)) return '—'
  return `$${v.toFixed(2)}`
}

export function WhiteGlovePricingPage() {
  useRegisterCatalogSidebarSubtree()

  const [snapshot, setSnapshot] = useState<WhitegloveSnapshotEnvelope | null>(null)
  const [costBasis, setCostBasis] = useState<CostBasisRefreshResponse | null>(null)
  const [jointGm, setJointGm] = useState<SizeMap>(DEFAULT_GMS)
  const [brandGm, setBrandGm] = useState<BrandGmMap>({})
  const [rowDec, setRowDec] = useState<DecisionMap>({})
  const [brandDec, setBrandDec] = useState<DecisionMap>({})
  const [note, setNote] = useState<string>('')
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState<null | 'load' | 'refresh' | 'save'>('load')
  const [error, setError] = useState<string | null>(null)
  const [statusMsg, setStatusMsg] = useState<string | null>(null)

  // Load the saved current snapshot on mount.
  useEffect(() => {
    let cancelled = false
    setBusy('load')
    setError(null)
    loadJson('/api/whiteglove/pricing/snapshot/current', WhitegloveCurrentSnapshotResponseSchema)
      .then((resp: WhitegloveCurrentSnapshotResponse) => {
        if (cancelled) return
        if (resp.snapshot) {
          hydrateFromSnapshot(resp.snapshot)
        }
        setBusy(null)
      })
      .catch((e: unknown) => {
        if (cancelled) return
        setError(e instanceof Error ? e.message : String(e))
        setBusy(null)
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function hydrateFromSnapshot(s: WhitegloveSnapshotEnvelope): void {
    setSnapshot(s)
    setCostBasis(s.payload.costBasis)
    setJointGm(s.payload.jointGmBySize)
    setBrandGm(s.payload.brandGmBySize)
    const rd: DecisionMap = {}
    for (const r of s.payload.rowDecisions) rd[rowKey(r.brand, r.strainShort)] = r.decision
    setRowDec(rd)
    const bd: DecisionMap = {}
    for (const b of s.payload.brandDecisions) bd[b.brand] = b.decision
    setBrandDec(bd)
    setNote(s.payload.note ?? '')
    setDirty(false)
  }

  const refresh = useCallback(async () => {
    setBusy('refresh')
    setError(null)
    setStatusMsg('Scanning Midtown + Bronx via Sweed (≈30–60s)…')
    try {
      const response = await fetch('/api/whiteglove/pricing/cost-basis/refresh', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { Accept: 'application/json' },
      })
      if (!response.ok) {
        const body = await response.text()
        throw new Error(`refresh failed: ${response.status} ${body}`)
      }
      const fresh = CostBasisRefreshResponseSchema.parse(await response.json())
      setCostBasis(fresh)
      setDirty(true)
      setStatusMsg(`Cost basis refreshed (${fresh.items.length} rows). Review then click Save.`)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }, [])

  const save = useCallback(async () => {
    if (!costBasis) return
    setBusy('save')
    setError(null)
    setStatusMsg(null)
    try {
      const body = {
        taxMult: WHITEGLOVE_TAX_MULT,
        defaultGmBySize: DEFAULT_GMS,
        jointGmBySize: jointGm,
        brandGmBySize: brandGm,
        rowDecisions: Object.entries(rowDec).map(([k, decision]) => {
          const [brand, strainShort] = k.split('||')
          return { brand, strainShort, decision }
        }),
        brandDecisions: Object.entries(brandDec).map(([brand, decision]) => ({ brand, decision })),
        costBasis,
        note: note.trim() || null,
      }
      const response = await fetch('/api/whiteglove/pricing/snapshot', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!response.ok) {
        const t = await response.text()
        throw new Error(`save failed: ${response.status} ${t}`)
      }
      const parsed = WhitegloveCurrentSnapshotResponseSchema.parse(await response.json())
      if (parsed.snapshot) {
        hydrateFromSnapshot(parsed.snapshot)
        setStatusMsg(`Saved snapshot #${parsed.snapshot.id}. Public page now reflects accepted rows.`)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }, [costBasis, jointGm, brandGm, rowDec, brandDec, note])

  const grouped = useMemo(() => groupByBrand(costBasis), [costBasis])

  return (
    <section className="wl-pricing">
      <style>{INLINE_CSS}</style>
      <div className="page-header">
        <div>
          <p className="eyebrow">Catalog → WhiteGlove</p>
          <h2>Bulk-Flower Pricing</h2>
        </div>
        <div className="wl-controls">
          <button onClick={refresh} disabled={busy !== null}>
            {busy === 'refresh' ? 'Refreshing…' : 'Refresh cost basis (Sweed)'}
          </button>
          <button className="primary" onClick={save} disabled={busy !== null || !costBasis || !dirty}>
            {busy === 'save' ? 'Saving…' : dirty ? 'Save' : 'Saved'}
          </button>
        </div>
      </div>

      {error && <div className="wl-error">⚠ {error}</div>}
      {statusMsg && <div className="wl-status">{statusMsg}</div>}

      {!costBasis && busy === 'load' && <p>Loading current snapshot…</p>}
      {!costBasis && busy !== 'load' && (
        <div className="wl-empty">
          <p>No published snapshot yet. Click <strong>Refresh cost basis</strong> to scan Sweed,
            review, and Save to publish.</p>
        </div>
      )}

      {costBasis && (
        <>
          <table className="wl-table">
            <thead>
              <tr>
                <th style={{ minWidth: '260px' }}>Strain</th>
                <th>$ / g</th>
                <th>Decision</th>
                {WHITEGLOVE_SIZES.map((s) => (
                  <th key={s.key} className="size">
                    {s.label} <span className="dim">({s.grams}g)</span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {/* Joint sliders */}
              <tr className="joint">
                <td colSpan={3}>
                  <strong>All brands (joint)</strong>
                  <div className="dim small">Moves every brand at this size in lockstep.</div>
                </td>
                {WHITEGLOVE_SIZES.map((s) => (
                  <td key={s.key} className="slider-cell">
                    <SliderCell
                      value={jointGm[s.key]}
                      onChange={(v) => {
                        setJointGm({ ...jointGm, [s.key]: v })
                        setDirty(true)
                      }}
                    />
                  </td>
                ))}
              </tr>

              {grouped.map(({ brand, rows }) => {
                const bd = brandDec[brand] ?? 'pending'
                return (
                  <>
                    <tr key={`b-${brand}`} className="brand">
                      <td colSpan={2}>
                        <strong>{brand}</strong>
                        <span className="dim small"> — {rows.length} strain{rows.length === 1 ? '' : 's'}</span>
                      </td>
                      <td>
                        <DecisionPicker
                          value={bd}
                          onChange={(v) => {
                            setBrandDec({ ...brandDec, [brand]: v })
                            setDirty(true)
                          }}
                          compact
                        />
                      </td>
                      {WHITEGLOVE_SIZES.map((s) => {
                        const v = brandGm[brand]?.[s.key]
                        const usingDefault = v === undefined
                        const display = usingDefault ? jointGm[s.key] : v
                        return (
                          <td key={s.key} className="slider-cell">
                            <SliderCell
                              value={display}
                              onChange={(newV) => {
                                setBrandGm({
                                  ...brandGm,
                                  [brand]: {
                                    quarterLb: brandGm[brand]?.quarterLb ?? jointGm.quarterLb,
                                    halfLb: brandGm[brand]?.halfLb ?? jointGm.halfLb,
                                    lb: brandGm[brand]?.lb ?? jointGm.lb,
                                    [s.key]: newV,
                                  } as SizeMap,
                                })
                                setDirty(true)
                              }}
                              hint={usingDefault ? 'override' : undefined}
                            />
                          </td>
                        )
                      })}
                    </tr>
                    {rows.map((item) => {
                      const rkey = rowKey(item.brand, item.strainShort)
                      const rdec = rowDec[rkey]
                      const effective = pickWhitegloveEffectiveDecision(rdec, bd)
                      const perGram = item.perGram
                      return (
                        <tr key={rkey} className={`strain decision-${effective}`}>
                          <td>
                            <div className="strain-name">
                              {item.strainShort}{' '}
                              {item.imputed && (
                                <span className="badge imputed" title={`Imputed from brand average of ${item.imputationSource?.peerCount ?? 0} priceable peer(s).`}>
                                  imputed
                                </span>
                              )}
                              {perGram === null && (
                                <span className="badge no-cost" title="No observed valid cost and no priceable brand peer to impute from. Cannot be auto-priced.">
                                  no cost
                                </span>
                              )}
                            </div>
                            <div className="dim small">{item.sites.join(' + ')}</div>
                            {item.best && (
                              <div className="dim small">
                                basis: {item.best.packLabel} @ {fmt$2(item.best.wholesaleCost)} ({fmt$2(item.best.perGram)}/g) ·{' '}
                                {item.totalLots} lot{item.totalLots === 1 ? '' : 's'} · most recent{' '}
                                {item.best.receivedAt.slice(0, 10)} @ {item.best.site}
                              </div>
                            )}
                            {item.imputed && item.imputationSource && (
                              <div className="dim small">
                                imputed $/g = avg of {item.imputationSource.peerCount} same-brand priceable peer(s)
                              </div>
                            )}
                          </td>
                          <td className="dim numeric">{perGram === null ? '—' : fmt$2(perGram)}</td>
                          <td>
                            <DecisionPicker
                              value={rdec ?? 'pending'}
                              onChange={(v) => {
                                setRowDec({ ...rowDec, [rkey]: v })
                                setDirty(true)
                              }}
                            />
                          </td>
                          {WHITEGLOVE_SIZES.map((s) => {
                            const gm = pickWhitegloveGm(item.brand, s.key, jointGm, brandGm)
                            const cost = perGram === null ? null : perGram * s.grams
                            const otd = cost === null ? null : computeWhitegloveOtd(cost, gm)
                            return (
                              <td key={s.key} className="numeric price-cell">
                                <div className="otd">{fmt$(otd)}</div>
                                {cost !== null && (
                                  <div className="dim small">cost {fmt$(cost)} · GM {fmtPct(gm)}</div>
                                )}
                              </td>
                            )
                          })}
                        </tr>
                      )
                    })}
                  </>
                )
              })}
            </tbody>
          </table>

          <div className="wl-save-row">
            <label>
              <span className="dim">Save note (optional):</span>{' '}
              <input
                value={note}
                onChange={(e) => {
                  setNote(e.target.value)
                  setDirty(true)
                }}
                placeholder="e.g. April 2026 wholesale push"
                size={60}
              />
            </label>
            <button className="primary" onClick={save} disabled={busy !== null || !dirty}>
              {busy === 'save' ? 'Saving…' : dirty ? 'Save' : 'Saved'}
            </button>
          </div>

          <details className="wl-details">
            <summary>About this page (formula, recall, current snapshot)</summary>
            <div className="wl-details-body">
              <p>
                OTD pricing formula: <code>GM = 1 − 1.13 × cost / OTD</code> ⇒{' '}
                <code>OTD = 1.13 × cost / (1 − GM)</code>. Defaults 60% / 54% / 49% at 1/4 / 1/2 / 1 lb.
              </p>
              <p>
                Cost basis: per-gram, taken from the most recent valid wholesale lot at Midtown + Bronx
                for every {'{brand, strain}'} flower SKU with pack size ≥ {costBasis.minPackGrams} g.
                Lots with cost &lt; ${costBasis.minCostUsd.toFixed(2)} are excluded as placeholders /
                trade samples; SKUs whose only lots are placeholders have their $/g imputed from
                same-brand peers (non-recursive). A SKU with no priceable peer is left unresolved.
              </p>
              <p>
                Decision precedence: per-row decision wins when not <em>pending</em>; otherwise the
                per-brand decision applies. The public freshlybaked.nyc/white-glove/bulk-flower page
                shows rows whose effective decision is <em>accept</em> AND that have a priceable cost.
              </p>
              <p>
                Cost basis generated at <strong>{costBasis.generatedAt}</strong>.{' '}
                Current snapshot:{' '}
                {snapshot ? (
                  <>
                    #{snapshot.id} saved {snapshot.createdAt} by {snapshot.createdBy}
                  </>
                ) : (
                  <em>none — never saved</em>
                )}
                .
              </p>
            </div>
          </details>
        </>
      )}
    </section>
  )
}

function groupByBrand(cb: CostBasisRefreshResponse | null): Array<{ brand: string; rows: CostBasisRefreshResponse['items'] }> {
  if (!cb) return []
  const map = new Map<string, CostBasisRefreshResponse['items']>()
  for (const item of cb.items) {
    const arr = map.get(item.brand) ?? []
    arr.push(item)
    map.set(item.brand, arr)
  }
  return Array.from(map.entries())
    .map(([brand, rows]) => ({
      brand,
      rows: rows.slice().sort((a, b) => a.strainShort.localeCompare(b.strainShort)),
    }))
    .sort((a, b) => a.brand.localeCompare(b.brand))
}

function SliderCell({
  value,
  onChange,
  hint,
}: {
  value: number
  onChange: (v: number) => void
  hint?: string
}) {
  return (
    <div className="sliderbar">
      <input
        type="range"
        min="0"
        max="80"
        step="0.5"
        value={(value * 100).toFixed(1)}
        onChange={(e) => onChange(Number(e.target.value) / 100)}
      />
      <span className="gmval">{fmtPct(value)}</span>
      {hint && <span className="hint">{hint}</span>}
    </div>
  )
}

function DecisionPicker({
  value,
  onChange,
  compact = false,
}: {
  value: WhitegloveDecision
  onChange: (v: WhitegloveDecision) => void
  compact?: boolean
}) {
  return (
    <div className={`decision-picker decision-${value}${compact ? ' compact' : ''}`}>
      {(['accept', 'pending', 'reject'] as const).map((opt) => (
        <button
          key={opt}
          type="button"
          className={`dp-btn dp-${opt}${value === opt ? ' selected' : ''}`}
          onClick={() => onChange(opt)}
        >
          {opt[0].toUpperCase() + opt.slice(1)}
        </button>
      ))}
    </div>
  )
}

const INLINE_CSS = `
.wl-pricing { padding: 16px; }
.wl-pricing h2 { margin: 0 0 4px; }
.wl-controls { display: flex; gap: 8px; }
.wl-controls button { font: inherit; padding: 6px 12px; border: 1px solid #ccc; background: white; border-radius: 4px; cursor: pointer; }
.wl-controls button.primary { background: #2a5db0; color: white; border-color: #2a5db0; }
.wl-controls button:disabled { opacity: 0.5; cursor: not-allowed; }
.wl-error { background: #fee; border: 1px solid #faa; padding: 8px 12px; border-radius: 4px; margin: 8px 0; }
.wl-status { background: #efe; border: 1px solid #afa; padding: 8px 12px; border-radius: 4px; margin: 8px 0; }
.wl-empty { padding: 16px; background: #f7f7f9; border-radius: 4px; }
.wl-table { width: 100%; border-collapse: collapse; font-size: 12px; margin-top: 8px; }
.wl-table th, .wl-table td { border: 1px solid #ddd; padding: 5px 8px; vertical-align: top; }
.wl-table th { background: #f7f7f9; font-weight: 600; position: sticky; top: 0; z-index: 1; text-align: left; }
.wl-table th.size { text-align: center; min-width: 130px; }
.wl-table tr.joint td { background: #fff8e1; border-top: 2px solid #d4b94a; }
.wl-table tr.brand td { background: #eef3ff; border-top: 2px solid #2a5db0; }
.wl-table tr.strain.decision-reject td { background: #fff5f5; color: #888; }
.wl-table tr.strain.decision-accept td { background: #f5fff7; }
.dim { color: #888; }
.small { font-size: 11px; }
.numeric { text-align: right; font-variant-numeric: tabular-nums; }
.price-cell .otd { font-weight: 700; font-size: 14px; color: #1d8a3a; }
.strain-name { font-weight: 500; }
.badge { font-size: 10px; padding: 1px 5px; border-radius: 3px; margin-left: 4px; vertical-align: middle; }
.badge.imputed { background: #fff3cd; color: #856404; border: 1px solid #ffe69c; }
.badge.no-cost { background: #f8d7da; color: #721c24; border: 1px solid #f5c2c7; }
.sliderbar { display: flex; align-items: center; gap: 6px; }
.sliderbar input[type=range] { flex: 1; min-width: 80px; }
.sliderbar .gmval { font-variant-numeric: tabular-nums; min-width: 48px; text-align: right; font-weight: 600; color: #2a5db0; font-size: 11px; }
.sliderbar .hint { font-size: 9px; color: #888; text-transform: uppercase; }
.decision-picker { display: inline-flex; gap: 2px; }
.decision-picker .dp-btn { font: inherit; padding: 2px 6px; border: 1px solid #ccc; background: white; border-radius: 3px; cursor: pointer; font-size: 11px; }
.decision-picker .dp-btn.selected.dp-accept { background: #1d8a3a; color: white; border-color: #1d8a3a; }
.decision-picker .dp-btn.selected.dp-pending { background: #888; color: white; border-color: #888; }
.decision-picker .dp-btn.selected.dp-reject { background: #b00; color: white; border-color: #b00; }
.wl-save-row { margin-top: 12px; display: flex; gap: 12px; align-items: center; }
.wl-save-row input { padding: 4px 8px; border: 1px solid #ccc; border-radius: 4px; font: inherit; }
.wl-save-row button.primary { background: #2a5db0; color: white; border: 1px solid #2a5db0; padding: 6px 14px; border-radius: 4px; cursor: pointer; }
.wl-save-row button:disabled { opacity: 0.5; cursor: not-allowed; }
.wl-details { margin-top: 16px; border: 1px solid #ddd; border-radius: 4px; }
.wl-details summary { padding: 6px 10px; background: #f7f7f9; cursor: pointer; user-select: none; font-size: 12px; color: #888; }
.wl-details-body { padding: 8px 12px; font-size: 12px; }
.wl-details-body code { background: #fafafa; padding: 1px 4px; border-radius: 3px; }
`
