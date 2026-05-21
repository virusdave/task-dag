// Helios → Utilities → Staff
//
// Lets an operator pick which Sweed state-level employees show up on
// the public freshlybaked.nyc /about-us "Meet The Team" surface.
//
// On first sight of a staff member from Sweed:
//   * with a non-empty photoUrl    → default 'unapproved' (needs decision)
//   * without a photoUrl           → default 'rejected'    (can't appear on the public surface anyway)
//
// Operator can flip any row to 'approved' / 'rejected' / 'unapproved'
// at any time. The public projection (/api/staff/public/team) returns
// only 'approved' rows with a real photoUrl.

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useLoaderData } from 'react-router-dom'

import {
  StaffListResponseSchema,
  StaffRefreshResponseSchema,
  StaffRowSchema,
  STAFF_INCLUSION_STATUSES,
  type StaffInclusionStatus,
  type StaffListResponse,
  type StaffRow,
} from '../../../shared/contracts/index.js'
import { loadJson, mutateJson } from '../../app/fetchJson.js'
import { Pill, type PillProps } from '../../components/Pill.js'
import { useRegisterSidebarSubtree } from '../../components/SidebarNavContext.js'
import { UTILITIES_SIDEBAR_SUBTREE } from './utilitiesSidebar.js'

type StatusFilter = 'all' | StaffInclusionStatus | 'no-photo'

const STATUS_FILTERS: ReadonlyArray<{ value: StatusFilter; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'unapproved', label: 'Unapproved' },
  { value: 'approved', label: 'Approved' },
  { value: 'rejected', label: 'Rejected' },
  { value: 'no-photo', label: 'No photo' },
]

function statusTone(status: StaffInclusionStatus): PillProps['tone'] {
  switch (status) {
    case 'approved':
      return 'success'
    case 'rejected':
      return 'danger'
    case 'unapproved':
    default:
      return 'warning'
  }
}

function statusLabel(status: StaffInclusionStatus): string {
  switch (status) {
    case 'approved':
      return 'Approved'
    case 'rejected':
      return 'Rejected'
    case 'unapproved':
    default:
      return 'Unapproved'
  }
}

export async function utilitiesStaffLoader(): Promise<StaffListResponse> {
  return loadJson('/api/staff', StaffListResponseSchema)
}

export function UtilitiesStaffPage() {
  useRegisterSidebarSubtree('utilities', UTILITIES_SIDEBAR_SUBTREE)

  const initial = useLoaderData() as StaffListResponse
  const [data, setData] = useState<StaffListResponse>(initial)
  const [error, setError] = useState<string | null>(null)
  const [busyStaffId, setBusyStaffId] = useState<string | null>(null)
  const [refreshBusy, setRefreshBusy] = useState(false)
  const [refreshNote, setRefreshNote] = useState<string | null>(null)
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')

  const filtered = useMemo<StaffRow[]>(() => {
    return data.items.filter((row) => {
      switch (statusFilter) {
        case 'all':
          return true
        case 'no-photo':
          return !row.photoUrl
        default:
          return row.inclusionStatus === statusFilter
      }
    })
  }, [data.items, statusFilter])

  const counts = useMemo(() => {
    let unapproved = 0
    let approved = 0
    let rejected = 0
    let withPhoto = 0
    for (const row of data.items) {
      if (row.photoUrl) withPhoto += 1
      if (row.inclusionStatus === 'unapproved') unapproved += 1
      else if (row.inclusionStatus === 'approved') approved += 1
      else if (row.inclusionStatus === 'rejected') rejected += 1
    }
    return { unapproved, approved, rejected, withPhoto, total: data.items.length }
  }, [data.items])

  const handleStatusChange = useCallback(async (row: StaffRow, next: StaffInclusionStatus) => {
    if (row.inclusionStatus === next) return
    setBusyStaffId(row.staffId)
    setError(null)
    try {
      const updated = await mutateJson(`/api/staff/${encodeURIComponent(row.staffId)}`, StaffRowSchema, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status: next }),
      })
      setData((prev) => ({
        ...prev,
        items: prev.items.map((item) => (item.staffId === updated.staffId ? updated : item)),
        approvedCount:
          prev.approvedCount +
          (updated.inclusionStatus === 'approved' && row.inclusionStatus !== 'approved' ? 1 : 0) -
          (row.inclusionStatus === 'approved' && updated.inclusionStatus !== 'approved' ? 1 : 0),
      }))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Failed to update status.')
    } finally {
      setBusyStaffId(null)
    }
  }, [])

  const handleRefresh = useCallback(async () => {
    setRefreshBusy(true)
    setRefreshNote(null)
    setError(null)
    try {
      const response = await mutateJson('/api/staff/refresh', StaffRefreshResponseSchema, {
        method: 'POST',
      })
      setData({
        items: response.items,
        fetchedAt: response.fetchedAt,
        totalCount: response.totalCount,
        withPhotoCount: response.withPhotoCount,
        approvedCount: response.approvedCount,
      })
      setRefreshNote(`Refreshed: ${response.upstreamCount} employees pulled from Sweed.`)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Refresh failed.')
    } finally {
      setRefreshBusy(false)
    }
  }, [])

  const fetchedAtLabel = useMemo(() => {
    if (!data.fetchedAt) return 'never'
    try {
      return new Date(data.fetchedAt).toLocaleString(undefined, { hour12: false })
    } catch {
      return data.fetchedAt
    }
  }, [data.fetchedAt])

  return (
    <section>
      <div className="page-header">
        <div>
          <p className="eyebrow">Utilities &rsaquo; Staff</p>
          <h2>State-level staff (Sweed) &rarr; public Meet The Team gate</h2>
          <p className="subtle-copy">
            Approve the staff members whose first name + headshot should appear on the public
            freshlybaked.nyc /about-us &quot;Meet The Team&quot; surface. New employees with a photo
            arrive as <strong>unapproved</strong>; new employees without a photo arrive as
            <strong> rejected</strong>. Existing decisions survive across refreshes.
          </p>
        </div>
        <div className="inline-row wrap-row">
          <Pill tone="muted">{`${counts.total} total`}</Pill>
          <Pill tone="muted">{`${counts.withPhoto} with photo`}</Pill>
          <Pill tone="warning">{`${counts.unapproved} unapproved`}</Pill>
          <Pill tone="success">{`${counts.approved} approved`}</Pill>
          <Pill tone="danger">{`${counts.rejected} rejected`}</Pill>
          <span className="subtle-copy">Sweed snapshot: {fetchedAtLabel}</span>
        </div>
      </div>

      <div className="inline-row wrap-row" style={{ marginBottom: '0.75rem', gap: '0.5rem' }}>
        <button type="button" onClick={() => void handleRefresh()} disabled={refreshBusy}>
          {refreshBusy ? 'Refreshing from Sweed…' : 'Refresh from Sweed'}
        </button>
        <label className="inline-row" style={{ gap: '0.4rem' }}>
          <span className="subtle-copy">Filter:</span>
          <select
            value={statusFilter}
            onChange={(event) => setStatusFilter(event.currentTarget.value as StatusFilter)}
          >
            {STATUS_FILTERS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        {refreshNote ? <span className="subtle-copy">{refreshNote}</span> : null}
        {error ? <Pill tone="danger">{error}</Pill> : null}
      </div>

      {data.items.length === 0 ? (
        <article className="detail-panel">
          <p className="subtle-copy">
            No staff records cached yet. Click <strong>Refresh from Sweed</strong> to pull the
            current state-dealer employee list.
          </p>
        </article>
      ) : (
        <div className="staff-grid">
          {filtered.map((row) => (
            <StaffCard
              key={row.staffId}
              row={row}
              onChange={handleStatusChange}
              busy={busyStaffId === row.staffId}
            />
          ))}
          {filtered.length === 0 ? (
            <p className="subtle-copy">No staff match the current filter.</p>
          ) : null}
        </div>
      )}
    </section>
  )
}

interface StaffCardProps {
  row: StaffRow
  busy: boolean
  onChange: (row: StaffRow, next: StaffInclusionStatus) => void | Promise<void>
}

function StaffCard({ row, busy, onChange }: StaffCardProps) {
  const sitesLabel = row.dealers
    .map((d) => d.dealerName)
    .filter((name) => name && !/^Freshly Baked NY$/i.test(name))
    .join(', ')

  return (
    <article className={`staff-card${row.photoUrl ? '' : ' staff-card--no-photo'}`}>
      <div className="staff-card__photo">
        {row.photoUrl ? (
          <img
            src={row.photoUrl}
            alt={`Headshot of ${row.fullName}`}
            loading="lazy"
            referrerPolicy="no-referrer"
          />
        ) : (
          <div className="staff-card__photo-placeholder" aria-hidden="true">
            No photo
          </div>
        )}
      </div>
      <div className="staff-card__body">
        <div className="staff-card__header">
          <strong>{row.fullName}</strong>
          <Pill tone={statusTone(row.inclusionStatus)}>{statusLabel(row.inclusionStatus)}</Pill>
        </div>
        <p className="subtle-copy staff-card__meta">
          <span>First name on public site: <strong>{row.firstName}</strong></span>
          {row.email ? <span> &middot; {row.email}</span> : null}
          {sitesLabel ? <span> &middot; {sitesLabel}</span> : null}
          {row.blocked ? <Pill tone="danger">blocked</Pill> : null}
        </p>
        <fieldset className="staff-card__radios" disabled={busy}>
          <legend className="sr-only">Public inclusion status for {row.fullName}</legend>
          {STAFF_INCLUSION_STATUSES.map((status) => (
            <label key={status} className="staff-card__radio">
              <input
                type="radio"
                name={`staff-status-${row.staffId}`}
                value={status}
                checked={row.inclusionStatus === status}
                onChange={() => void onChange(row, status)}
                disabled={busy || (status === 'approved' && !row.photoUrl)}
              />
              <span>{statusLabel(status)}</span>
            </label>
          ))}
        </fieldset>
        {row.inclusionDecidedBy ? (
          <p className="subtle-copy staff-card__decided">
            Last decision by <code>{row.inclusionDecidedBy}</code>
            {row.inclusionDecidedAt
              ? ` on ${new Date(row.inclusionDecidedAt).toLocaleString(undefined, { hour12: false })}`
              : null}
          </p>
        ) : null}
      </div>
    </article>
  )
}
