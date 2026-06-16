// Helios "segment details" page (/config/marketing/segments/:segmentId,
// virusdave/top-level#12).
//
// A read-only, internal view of one Sweed marketing segment that the
// operator reaches from the geo-segment-rules page (and, eventually,
// customer chips). It answers "what is this segment, how big is it, how
// fresh is our copy, and what do I do next?" entirely from local caches
// — the GET never calls Sweed. The single write action is the deduped
// "Refresh membership cache" button, which enqueues a background bulk
// pull and then lets the operator watch the highwater flip pending -> ok.
//
// Reuse note (canon reuse gate): this page reuses the canonical config
// page primitives already used by GeoSegmentRulesPage (page-header,
// history-card, runtime-status-strip, Pill, the NY time helpers, and
// loadJson/mutateJson). Helios has no shared lightweight bar/histogram
// component (the metrics SVG charts are heavyweight scatter/line widgets
// bound to the metrics data pipeline), so the two small freshness charts
// here are tiny inline CSS-bar rows, kept local on purpose.

import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useLoaderData, useRevalidator, useRouteLoaderData } from 'react-router-dom'

import {
  SegmentDetailsResponseSchema,
  SegmentMembershipRefreshResponseSchema,
  SegmentRetirementResponseSchema,
  type SegmentDetailsResponse,
  type SegmentRefreshStatus,
  type SessionEnvelope,
} from '../../../shared/contracts/index.js'
import { loadJson, mutateJson } from '../../app/fetchJson.js'
import { nyIsoDate, nyLongDateTime } from '../../app/nyTime.js'
import { Pill } from '../../components/Pill.js'
import { useRegisterConfigSidebarSubtree } from './configSidebarSubtree.js'

export async function marketingSegmentDetailsLoader({
  params,
}: {
  params: Record<string, string | undefined>
}): Promise<SegmentDetailsResponse> {
  return loadJson(
    `/api/config/marketing/segments/${params.segmentId}`,
    SegmentDetailsResponseSchema,
  )
}

const REFRESH_TONE: Record<SegmentRefreshStatus, 'success' | 'warning' | 'muted' | 'danger'> = {
  ok: 'success',
  pending: 'warning',
  failed: 'danger',
  untracked: 'muted',
  never: 'muted',
}

const REFRESH_LABEL: Record<SegmentRefreshStatus, string> = {
  ok: 'cache fresh',
  pending: 'refreshing…',
  failed: 'last refresh failed',
  untracked: 'cached (pre-tracking)',
  never: 'never refreshed',
}

const SCOPE_LABEL: Record<SegmentDetailsResponse['segment']['scopeLevel'], string> = {
  site: 'Site',
  state: 'State / multi-store',
  unknown: 'Scope unknown',
}

function fmtInt(n: number): string {
  return n.toLocaleString('en-US')
}

function fmtDateTime(iso: string | null): string {
  return iso ? `${nyLongDateTime(Date.parse(iso))} NY` : 'Not refreshed yet'
}

function fmtDate(iso: string | null): string {
  return iso ? nyIsoDate(Date.parse(iso)) : 'No date'
}

// Tiny mobile-friendly horizontal bar row. Local on purpose (see header).
function MiniBars({
  rows,
  emptyLabel,
}: {
  rows: Array<{ key: string; label: string; value: number; sub?: string }>
  emptyLabel: string
}) {
  if (rows.length === 0) {
    return <p className="subtle-copy">{emptyLabel}</p>
  }
  const max = Math.max(1, ...rows.map((r) => r.value))
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {rows.map((r) => (
        <div key={r.key} style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
          <span
            className="subtle-copy"
            style={{
              flex: '0 0 92px',
              fontSize: '0.8em',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
            title={r.label}
          >
            {r.label}
          </span>
          <div
            style={{
              flex: '1 1 auto',
              minWidth: 0,
              height: 14,
              borderRadius: 4,
              background: 'var(--control-border, #e4e4e4)',
              overflow: 'hidden',
            }}
          >
            <div
              style={{
                width: `${Math.round((r.value / max) * 100)}%`,
                height: '100%',
                borderRadius: 4,
                background: 'var(--accent, #4b7bec)',
              }}
            />
          </div>
          <span
            style={{ flex: '0 0 auto', fontVariantNumeric: 'tabular-nums', fontSize: '0.85em' }}
          >
            {fmtInt(r.value)}
            {r.sub ? <span className="subtle-copy"> {r.sub}</span> : null}
          </span>
        </div>
      ))}
    </div>
  )
}

function StatTile({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div
      className="history-card"
      style={{ flex: '1 1 150px', minWidth: 0, margin: 0, padding: '12px 14px' }}
    >
      <div style={{ fontSize: '1.5em', fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>
        {value}
      </div>
      <div className="subtle-copy" style={{ marginTop: 2 }}>
        {label}
      </div>
      {hint ? (
        <div className="subtle-copy" style={{ marginTop: 2, fontSize: '0.8em' }}>
          {hint}
        </div>
      ) : null}
    </div>
  )
}

export function MarketingSegmentDetailsPage() {
  useRegisterConfigSidebarSubtree()
  const data = useLoaderData() as SegmentDetailsResponse
  const session = useRouteLoaderData('root') as SessionEnvelope | undefined
  const revalidator = useRevalidator()

  const canEdit = useMemo(() => {
    const role = session?.user?.role
    return role === 'editor' || role === 'approver' || role === 'admin'
  }, [session])

  const [refreshing, setRefreshing] = useState(false)
  const [retiring, setRetiring] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const { segment, membership, refreshState } = data
  const pending = refreshState.status === 'pending'

  // While a refresh is pending, poll (revalidate) so the highwater line
  // flips to ok/failed without the operator hitting reload. Cheap: the
  // GET is cache-only. Stops as soon as the status leaves pending.
  const revalidate = revalidator.revalidate
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  useEffect(() => {
    if (!pending) {
      if (pollRef.current) {
        clearInterval(pollRef.current)
        pollRef.current = null
      }
      return
    }
    pollRef.current = setInterval(() => revalidate(), 4000)
    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current)
        pollRef.current = null
      }
    }
  }, [pending, revalidate])

  // Drop the transient "refresh queued" notice on the pending -> settled
  // transition, so it can't linger next to a "cache fresh"/"failed" pill.
  // Keyed off the previous pending value so it never clears the notice in
  // the brief window before the highwater flips to pending.
  const wasPending = useRef(false)
  useEffect(() => {
    if (wasPending.current && !pending) setNotice(null)
    wasPending.current = pending
  }, [pending])

  async function handleRefresh(): Promise<void> {
    setRefreshing(true)
    setErrorMessage(null)
    setNotice(null)
    try {
      await mutateJson(
        `/api/config/marketing/segments/${segment.segmentId}/refresh-membership`,
        SegmentMembershipRefreshResponseSchema,
        { method: 'POST' },
      )
      setNotice('Membership refresh queued. This page will update when it finishes.')
      revalidator.revalidate()
    } catch (cause) {
      setErrorMessage(cause instanceof Error ? cause.message : 'Failed to queue refresh.')
    } finally {
      setRefreshing(false)
    }
  }

  async function handleRetire(action: 'retire' | 'unretire'): Promise<void> {
    setRetiring(true)
    setErrorMessage(null)
    setNotice(null)
    try {
      await mutateJson(
        `/api/config/marketing/segments/${segment.segmentId}/${action}`,
        SegmentRetirementResponseSchema,
        { method: 'POST' },
      )
      setNotice(
        action === 'retire'
          ? 'Segment retired. It is now hidden from the rest of Helios.'
          : 'Segment un-retired. It is visible across Helios again.',
      )
      revalidator.revalidate()
    } catch (cause) {
      setErrorMessage(cause instanceof Error ? cause.message : `Failed to ${action} segment.`)
    } finally {
      setRetiring(false)
    }
  }

  const entryRows = data.entryHistogram.map((b) => ({
    key: b.weekStart,
    label: nyIsoDate(Date.parse(`${b.weekStart}T12:00:00Z`)),
    value: b.count,
  }))
  const scopeRows = data.scopeBreakdown.map((r) => ({
    key: `${r.scopeLevel}:${r.scopeLabel}`,
    label: r.scopeLabel,
    value: r.memberCount,
  }))

  return (
    <section>
      <div className="page-header wrap-row" style={{ alignItems: 'flex-start' }}>
        <div style={{ minWidth: 0, flex: '1 1 260px' }}>
          <p className="eyebrow">
            <Link to="/config/marketing/segments">Config / Marketing / Segments</Link>
          </p>
          <h2 style={{ overflowWrap: 'anywhere' }}>{segment.name}</h2>
          <p className="subtle-copy">
            Segment #{segment.segmentId}. Helios snapshot of this Sweed marketing segment, built
            entirely from our local cache. Use Refresh membership cache to pull the latest member
            list from Sweed.
          </p>
        </div>
        <div className="inline-row wrap-row">
          <Pill tone={REFRESH_TONE[refreshState.status]}>{REFRESH_LABEL[refreshState.status]}</Pill>
          <Pill tone={segment.enabled === false ? 'muted' : 'success'}>
            {segment.enabled === false ? 'disabled' : 'enabled'}
          </Pill>
          {segment.isRetired ? <Pill tone="warning">retired</Pill> : null}
          <Pill tone="muted">{segment.type}</Pill>
          <Pill tone="muted">{SCOPE_LABEL[segment.scopeLevel]}</Pill>
        </div>
      </div>

      {errorMessage ? (
        <div className="runtime-status-strip" style={{ marginTop: 12 }}>
          <div className="runtime-status-item">
            <Pill tone="danger">error</Pill>
            <span className="subtle-copy">{errorMessage}</span>
          </div>
        </div>
      ) : null}

      {notice ? (
        <div className="runtime-status-strip" style={{ marginTop: 12 }}>
          <div className="runtime-status-item">
            <Pill tone="success">queued</Pill>
            <span className="subtle-copy">{notice}</span>
          </div>
        </div>
      ) : null}

      {/* Retirement: hide/show this segment across the rest of Helios. */}
      <article className="history-card" style={{ marginTop: 16 }}>
        <div className="history-card-topline wrap-row" style={{ alignItems: 'flex-start' }}>
          <div style={{ minWidth: 0 }}>
            <strong>Helios visibility</strong>
            {segment.isRetired ? (
              <>
                <p className="subtle-copy" style={{ marginTop: 2 }}>
                  Retired: hidden from every Helios page except this one and the segment directory.
                </p>
                {segment.disabledImpliedRetired ? (
                  <p className="subtle-copy" style={{ marginTop: 2, fontSize: '0.8em' }}>
                    This segment is disabled in Sweed, so it stays hidden until it is re-enabled in
                    Sweed (Helios cannot re-enable it).
                  </p>
                ) : null}
                {segment.explicitlyRetired ? (
                  <p className="subtle-copy" style={{ marginTop: 2, fontSize: '0.8em' }}>
                    Retired in Helios{' '}
                    {segment.retiredAt ? `${nyLongDateTime(Date.parse(segment.retiredAt))} NY` : ''}
                    {segment.retiredBy ? ` by ${segment.retiredBy}` : ''}
                    {segment.retirementNote ? `; ${segment.retirementNote}` : ''}.
                  </p>
                ) : null}
              </>
            ) : (
              <p className="subtle-copy" style={{ marginTop: 2 }}>
                Active: visible across Helios. Retire it to hide this segment everywhere except this
                page and the segment directory (useful for test and junk segments).
              </p>
            )}
          </div>
          {canEdit ? (
            <div className="inline-row wrap-row">
              {segment.explicitlyRetired ? (
                <button
                  type="button"
                  className="ghost-button"
                  disabled={retiring}
                  onClick={() => void handleRetire('unretire')}
                  title="Show this segment across Helios again."
                >
                  {retiring ? 'Working…' : 'Un-retire'}
                </button>
              ) : !segment.disabledImpliedRetired ? (
                <button
                  type="button"
                  className="ghost-button"
                  disabled={retiring}
                  onClick={() => void handleRetire('retire')}
                  title="Hide this segment from every Helios page except this one and the directory."
                >
                  {retiring ? 'Working…' : 'Retire segment'}
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      </article>

      {/* Membership freshness + the primary next action. */}
      <article className="history-card" style={{ marginTop: 16 }}>
        <div className="history-card-topline wrap-row" style={{ alignItems: 'flex-start' }}>
          <div style={{ minWidth: 0 }}>
            <strong>Membership cache</strong>
            <p className="subtle-copy" style={{ marginTop: 2 }}>
              {fmtInt(membership.cachedMemberCount)} members cached in Helios
              {segment.sweedTotalCustomers !== null
                ? ` · Sweed reports ${fmtInt(segment.sweedTotalCustomers)}`
                : ''}
              .
            </p>
            <p className="subtle-copy" style={{ marginTop: 2 }}>
              Last refreshed: {fmtDateTime(refreshState.refreshedAt)}
              {refreshState.requestedAt && refreshState.status === 'pending'
                ? ` · requested ${fmtDateTime(refreshState.requestedAt)}`
                : ''}
            </p>
            {refreshState.status === 'failed' && refreshState.lastError ? (
              <p className="subtle-copy" style={{ marginTop: 2, color: 'var(--danger, #c0392b)' }}>
                {refreshState.lastError}
              </p>
            ) : null}
            {refreshState.status === 'untracked' ? (
              <p className="subtle-copy" style={{ marginTop: 2, fontSize: '0.8em' }}>
                These rows were cached before per-segment refresh tracking existed. Refresh to record
                an authoritative timestamp.
              </p>
            ) : null}
          </div>
          <div className="inline-row wrap-row">
            {canEdit ? (
              <button
                type="button"
                className="ghost-button"
                disabled={refreshing || pending}
                onClick={() => void handleRefresh()}
                title="Pull the full member list from Sweed and update the Helios cache."
              >
                {pending ? 'Refreshing…' : refreshing ? 'Queuing…' : 'Refresh membership cache'}
              </button>
            ) : null}
            <a href={segment.sweedPrimeUrl} target="_blank" rel="noreferrer" className="ghost-button">
              Open in Sweed
            </a>
          </div>
        </div>

        <div className="filter-row wrap-row" style={{ marginTop: 12, gap: 10 }}>
          <StatTile label="Members cached" value={fmtInt(membership.cachedMemberCount)} />
          <StatTile label="First entered" value={fmtDate(membership.firstEnteredAt)} />
          <StatTile label="Most recent entry" value={fmtDate(membership.lastEnteredAt)} />
          {membership.unknownEnterCount > 0 ? (
            <StatTile
              label="No entry date"
              value={fmtInt(membership.unknownEnterCount)}
              hint="Sweed gave no enter date"
            />
          ) : null}
        </div>
      </article>

      {/* Cheap cached charts. */}
      <article className="history-card" style={{ marginTop: 16 }}>
        <header>
          <strong>Members entering by week</strong>
        </header>
        <p className="subtle-copy" style={{ marginTop: 4 }}>
          New members per NY week over the last 52 weeks
          {membership.olderEnterCount > 0
            ? ` (${fmtInt(membership.olderEnterCount)} entered before this window)`
            : ''}
          .
        </p>
        <div style={{ marginTop: 10 }}>
          <MiniBars rows={entryRows} emptyLabel="No dated entries in the last 52 weeks." />
        </div>
      </article>

      <article className="history-card" style={{ marginTop: 16 }}>
        <header>
          <strong>Members by scope</strong>
        </header>
        <p className="subtle-copy" style={{ marginTop: 4 }}>
          Which store / state owns each cached member row.
        </p>
        <div style={{ marginTop: 10 }}>
          <MiniBars rows={scopeRows} emptyLabel="No cached members yet." />
        </div>
      </article>

      {/* Geo automation linkage, only when this segment is geo-driven. */}
      {data.geoRules.length > 0 ? (
        <article className="history-card" style={{ marginTop: 16 }}>
          <header>
            <strong>Geo automation</strong>
          </header>
          <p className="subtle-copy" style={{ marginTop: 4 }}>
            This segment is populated by{' '}
            {data.geoRules.length === 1 ? 'a geo rule' : `${data.geoRules.length} geo rules`}.{' '}
            <Link to="/config/marketing/geo-segment-rules">Manage geo segment rules</Link>.
          </p>
          <div className="stacked-list" style={{ marginTop: 10 }}>
            {data.geoRules.map((r) => (
              <div key={r.id} style={{ minWidth: 0 }}>
                <div className="inline-row wrap-row" style={{ gap: 8 }}>
                  <strong>
                    {r.siteLabel ?? r.siteSlug} ({r.siteSlug}) · {r.trigger}
                  </strong>
                  <Pill tone={r.enabled ? 'success' : 'muted'}>
                    {r.enabled ? 'enabled' : 'disabled'}
                  </Pill>
                  <Pill tone={r.triggerLive ? 'success' : 'warning'}>
                    {r.triggerLive ? 'live on-scan' : 'backfill only'}
                  </Pill>
                </div>
                <div className="inline-row wrap-row" style={{ marginTop: 6, gap: 8 }}>
                  <Pill tone="success">{`${fmtInt(r.applied)} added`}</Pill>
                  <Pill tone="muted">{`${fmtInt(r.alreadyMember)} already member`}</Pill>
                  {r.pending > 0 ? <Pill tone="warning">{`${fmtInt(r.pending)} pending`}</Pill> : null}
                  {r.failed > 0 ? <Pill tone="danger">{`${fmtInt(r.failed)} failed`}</Pill> : null}
                </div>
              </div>
            ))}
          </div>
          {data.recentGeoFailures.length > 0 ? (
            <div style={{ marginTop: 12 }}>
              <p className="subtle-copy">Recent geo-add failures:</p>
              <ul
                className="subtle-copy"
                style={{ marginTop: 4, fontSize: '0.85em', overflowWrap: 'anywhere' }}
              >
                {data.recentGeoFailures.map((f) => (
                  <li key={`${f.ruleId}:${f.sweedCustomerId}`}>
                    rule #{f.ruleId} · customer {f.sweedCustomerId} ·{' '}
                    {nyLongDateTime(Date.parse(f.updatedAt))} NY · {f.lastError ?? 'unknown error'}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </article>
      ) : null}

      {/* Related metrics. Clearly NOT segment-filtered yet. */}
      <article className="history-card" style={{ marginTop: 16 }}>
        <header>
          <strong>Related metrics</strong>
        </header>
        <p className="subtle-copy" style={{ marginTop: 4 }}>
          These dashboards are not yet filtered to this segment; they show the whole population.
          Segment-versus-population reporting is planned.
        </p>
        <div className="inline-row wrap-row" style={{ marginTop: 10, gap: 8 }}>
          <Link to="/metrics/customer-value" className="ghost-button">
            Customer value (all customers)
          </Link>
          <Link to="/metrics/sales" className="ghost-button">
            Sales (all customers)
          </Link>
        </div>
      </article>

      {segment.targetStoreNames.length > 0 ? (
        <p className="subtle-copy" style={{ marginTop: 16 }}>
          Target stores: {segment.targetStoreNames.join(', ')}.
        </p>
      ) : null}
    </section>
  )
}
