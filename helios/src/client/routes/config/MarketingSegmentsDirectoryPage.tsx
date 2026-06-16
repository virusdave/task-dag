// Helios marketing-segment directory (/config/marketing/segments).
//
// Lists every cached Sweed marketing segment so the operator can open a
// detail page (in a new tab) and retire/un-retire segments. "Retiring" a
// segment semi-permanently hides it from every other Helios surface
// (pickers, lenses, check-in chips, customer membership lists) without
// touching Sweed; segments disabled in Sweed are treated as retired too.
//
// Reuse note (canon reuse gate): reuses the canonical config-page
// primitives already used by MarketingSegmentDetailsPage / GeoSegmentRulesPage
// (page-header, history-card, inline-row/wrap-row, Pill, ghost-button,
// loadJson/mutateJson, the NY time helpers). No new shared component is
// introduced; the row layout is a small local list, mobile-first.

import { useMemo, useState } from 'react'
import { useLoaderData, useRevalidator, useRouteLoaderData } from 'react-router-dom'

import {
  MarketingSegmentDirectoryResponseSchema,
  SegmentRetirementResponseSchema,
  type MarketingSegmentDirectoryResponse,
  type MarketingSegmentDirectoryRow,
  type SessionEnvelope,
} from '../../../shared/contracts/index.js'
import { loadJson, mutateJson } from '../../app/fetchJson.js'
import { nyLongDateTime } from '../../app/nyTime.js'
import { Pill } from '../../components/Pill.js'
import { useRegisterConfigSidebarSubtree } from './configSidebarSubtree.js'

export async function marketingSegmentsDirectoryLoader(): Promise<MarketingSegmentDirectoryResponse> {
  return loadJson('/api/config/marketing/segments', MarketingSegmentDirectoryResponseSchema)
}

const SCOPE_LABEL: Record<MarketingSegmentDirectoryRow['scopeLevel'], string> = {
  site: 'Site',
  state: 'State / multi-store',
  unknown: 'Scope unknown',
}

function fmtInt(n: number): string {
  return n.toLocaleString('en-US')
}

function fmtDateTime(iso: string | null): string {
  return iso ? `${nyLongDateTime(Date.parse(iso))} NY` : 'unknown time'
}

function SegmentRow({
  row,
  canEdit,
  busy,
  onRetire,
  onUnretire,
}: {
  row: MarketingSegmentDirectoryRow
  canEdit: boolean
  busy: boolean
  onRetire: (id: number) => void
  onUnretire: (id: number) => void
}) {
  return (
    <div className="history-card" style={{ margin: 0, padding: '12px 14px' }}>
      <div className="history-card-topline wrap-row" style={{ alignItems: 'flex-start', gap: 10 }}>
        <div style={{ minWidth: 0, flex: '1 1 240px' }}>
          <a
            href={`/config/marketing/segments/${row.segmentId}`}
            target="_blank"
            rel="noreferrer"
            style={{ fontWeight: 600, overflowWrap: 'anywhere' }}
          >
            {row.name}
          </a>
          <div className="inline-row wrap-row" style={{ marginTop: 6, gap: 6 }}>
            <Pill tone="muted">{`#${row.segmentId}`}</Pill>
            <Pill tone="muted">{row.type}</Pill>
            <Pill tone="muted">{SCOPE_LABEL[row.scopeLevel]}</Pill>
            {row.disabledImpliedRetired ? <Pill tone="danger">disabled in Sweed</Pill> : null}
            {row.explicitlyRetired ? <Pill tone="warning">retired in Helios</Pill> : null}
            {!row.isRetired ? <Pill tone="success">active</Pill> : null}
          </div>
          {row.explicitlyRetired ? (
            <p className="subtle-copy" style={{ marginTop: 6, fontSize: '0.8em' }}>
              Retired {fmtDateTime(row.retiredAt)}
              {row.retiredBy ? ` by ${row.retiredBy}` : ''}
              {row.retirementNote ? `; ${row.retirementNote}` : ''}
            </p>
          ) : null}
        </div>
        <div style={{ flex: '0 0 auto', textAlign: 'right' }}>
          <div style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>
            {fmtInt(row.cachedMemberCount)}
          </div>
          <div className="subtle-copy" style={{ fontSize: '0.8em' }}>
            members cached
            {row.sweedTotalCustomers !== null ? ` · ${fmtInt(row.sweedTotalCustomers)} in Sweed` : ''}
          </div>
        </div>
        {canEdit ? (
          <div className="inline-row" style={{ flex: '0 0 auto' }}>
            {row.explicitlyRetired ? (
              <button
                type="button"
                className="ghost-button"
                disabled={busy}
                onClick={() => onUnretire(row.segmentId)}
                title="Un-retire: show this segment across Helios again."
              >
                {busy ? '…' : 'Un-retire'}
              </button>
            ) : row.disabledImpliedRetired ? (
              <span className="subtle-copy" style={{ fontSize: '0.8em' }}>
                hidden (disabled in Sweed)
              </span>
            ) : (
              <button
                type="button"
                className="ghost-button"
                disabled={busy}
                onClick={() => onRetire(row.segmentId)}
                title="Retire: hide this segment from every Helios page except this directory and its detail page."
              >
                {busy ? '…' : 'Retire'}
              </button>
            )}
          </div>
        ) : null}
      </div>
    </div>
  )
}

export function MarketingSegmentsDirectoryPage() {
  useRegisterConfigSidebarSubtree()
  const data = useLoaderData() as MarketingSegmentDirectoryResponse
  const session = useRouteLoaderData('root') as SessionEnvelope | undefined
  const revalidator = useRevalidator()

  const canEdit = useMemo(() => {
    const role = session?.user?.role
    return role === 'editor' || role === 'approver' || role === 'admin'
  }, [session])

  const [query, setQuery] = useState('')
  const [busyId, setBusyId] = useState<number | null>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  const needle = query.trim().toLowerCase()
  const matches = (row: MarketingSegmentDirectoryRow) =>
    needle === '' ||
    row.name.toLowerCase().includes(needle) ||
    String(row.segmentId).includes(needle)

  const active = data.segments.filter((s) => !s.isRetired && matches(s))
  const retired = data.segments.filter((s) => s.isRetired && matches(s))

  async function mutate(id: number, action: 'retire' | 'unretire'): Promise<void> {
    setBusyId(id)
    setErrorMessage(null)
    try {
      await mutateJson(
        `/api/config/marketing/segments/${id}/${action}`,
        SegmentRetirementResponseSchema,
        { method: 'POST' },
      )
      revalidator.revalidate()
    } catch (cause) {
      setErrorMessage(cause instanceof Error ? cause.message : `Failed to ${action} segment.`)
    } finally {
      setBusyId(null)
    }
  }

  return (
    <section>
      <div className="page-header wrap-row" style={{ alignItems: 'flex-start' }}>
        <div style={{ minWidth: 0, flex: '1 1 260px' }}>
          <p className="eyebrow">Config / Marketing</p>
          <h2>Segments</h2>
          <p className="subtle-copy">
            Every Sweed marketing segment Helios has cached. Open a segment to see its membership and
            history, or retire test and junk segments to hide them from the rest of Helios. Catalog
            cached {fmtDateTime(data.catalogRefreshedAt)}.
          </p>
        </div>
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter by name or id"
          aria-label="Filter segments"
          style={{ flex: '1 1 220px', maxWidth: 320 }}
        />
      </div>

      {errorMessage ? (
        <div className="runtime-status-strip" style={{ marginTop: 12 }}>
          <div className="runtime-status-item">
            <Pill tone="danger">error</Pill>
            <span className="subtle-copy">{errorMessage}</span>
          </div>
        </div>
      ) : null}

      <p className="subtle-copy" style={{ marginTop: 16 }}>
        {fmtInt(active.length)} active {active.length === 1 ? 'segment' : 'segments'}
      </p>
      <div className="stacked-list" style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 10 }}>
        {active.length === 0 ? (
          <p className="subtle-copy">No active segments match.</p>
        ) : (
          active.map((row) => (
            <SegmentRow
              key={row.segmentId}
              row={row}
              canEdit={canEdit}
              busy={busyId === row.segmentId}
              onRetire={(id) => void mutate(id, 'retire')}
              onUnretire={(id) => void mutate(id, 'unretire')}
            />
          ))
        )}
      </div>

      <details style={{ marginTop: 20 }}>
        <summary style={{ cursor: 'pointer', fontWeight: 600 }}>
          Retired segments ({fmtInt(retired.length)})
        </summary>
        <p className="subtle-copy" style={{ marginTop: 6 }}>
          Hidden from every other Helios page. Segments disabled in Sweed stay hidden until they are
          re-enabled in Sweed; segments retired in Helios can be un-retired here.
        </p>
        <div
          className="stacked-list"
          style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 10 }}
        >
          {retired.length === 0 ? (
            <p className="subtle-copy">No retired segments{needle ? ' match' : ''}.</p>
          ) : (
            retired.map((row) => (
              <SegmentRow
                key={row.segmentId}
                row={row}
                canEdit={canEdit}
                busy={busyId === row.segmentId}
                onRetire={(id) => void mutate(id, 'retire')}
                onUnretire={(id) => void mutate(id, 'unretire')}
              />
            ))
          )}
        </div>
      </details>
    </section>
  )
}
