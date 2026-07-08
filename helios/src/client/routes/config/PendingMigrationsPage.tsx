// Admin-only page listing every LIVE-pending Helios migration with a
// worker-driven "Apply Now" per row (automation#62, leaf 7). See
// docs/helios/pending-migrations-admin-apply/DESIGN.md "SPA page".
//
// This page NEVER runs SQL itself. "Apply Now" POSTs to
// /api/admin/pending-migrations/:id/apply, which enqueues an URGENT
// db.migration.apply job; the worker does the real (gated, verified,
// audited) apply. The page then polls GET /api/jobs/:jobId for live
// progress → success (the sentinel now reports applied; the row drops on
// the next refresh) / failure (error surfaced, safe to retry after review).
//
// ADMIN-GATED at the route level (client guard below); both the list and
// enqueue APIs are independently admin-gated server-side — nav/route hiding
// is discoverability, not access control.

import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, Navigate, useRouteLoaderData } from 'react-router-dom'

import {
  AdminPendingMigrationApplyResponseSchema,
  AdminPendingMigrationsResponseSchema,
  buildHeliosModulePath,
  type AdminPendingMigrationRow,
  type AdminPendingMigrationsResponse,
  type SessionEnvelope,
} from '../../../shared/contracts/index.js'
import { loadJson, mutateJson } from '../../app/fetchJson.js'
import { isJobTerminal, loadJobStatus } from '../../app/jobPolling.js'
import { nyShortDateTime } from '../../app/nyTime.js'
import { Pill } from '../../components/Pill.js'
import { useRegisterConfigSidebarSubtree } from './configSidebarSubtree.js'
import {
  applyButtonView,
  applyStatusLine,
  attemptStateLabel,
  attemptStateTone,
  eligibilityLabel,
  eligibilityTone,
  initialRowApplyState,
  resumableJobId,
  type RowApplyState,
} from './pendingMigrationsAdminShared.js'

const LIST_PATH = '/api/admin/pending-migrations'
const POLL_INTERVAL_MS = 1500

async function loadPendingMigrations(): Promise<AdminPendingMigrationsResponse> {
  return loadJson(LIST_PATH, AdminPendingMigrationsResponseSchema)
}

function formatTimestamp(iso: string | null): string {
  if (iso === null) {
    return '—'
  }
  const ms = Date.parse(iso)
  return Number.isNaN(ms) ? iso : nyShortDateTime(ms)
}

export function PendingMigrationsPage() {
  useRegisterConfigSidebarSubtree()
  const session = useRouteLoaderData('root') as SessionEnvelope | undefined

  const [data, setData] = useState<AdminPendingMigrationsResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [fetchedAt, setFetchedAt] = useState<Date | null>(null)

  // Per-row apply lifecycle + the type-to-confirm input value, keyed by id.
  const [applyStates, setApplyStates] = useState<Record<string, RowApplyState>>({})
  const [confirmText, setConfirmText] = useState<Record<string, string>>({})

  // Mounted flag so in-flight polls/fetches don't setState after unmount.
  const mountedRef = useRef(true)
  // Set of migration ids we are already polling, so we never double-poll one.
  const pollingRef = useRef<Set<string>>(new Set())

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const setRowApply = useCallback((migrationId: string, next: RowApplyState) => {
    setApplyStates((prev) => ({ ...prev, [migrationId]: next }))
  }, [])

  const refresh = useCallback(async () => {
    try {
      const response = await loadPendingMigrations()
      if (!mountedRef.current) {
        return
      }
      setData(response)
      setFetchedAt(new Date())
      setError(null)
    } catch (cause) {
      if (!mountedRef.current) {
        return
      }
      setError(cause instanceof Error ? cause.message : 'Failed to load pending migrations.')
    } finally {
      if (mountedRef.current) {
        setLoading(false)
      }
    }
  }, [])

  // Poll a single apply job to completion, then refresh the list so a
  // now-applied migration drops off. Guarded against double-polling.
  const pollApplyJob = useCallback(
    (migrationId: string, jobId: number) => {
      if (pollingRef.current.has(migrationId)) {
        return
      }
      pollingRef.current.add(migrationId)

      const step = async () => {
        if (!mountedRef.current) {
          pollingRef.current.delete(migrationId)
          return
        }
        try {
          const status = await loadJobStatus(jobId)
          if (!mountedRef.current) {
            return
          }
          if (isJobTerminal(status.job.status)) {
            pollingRef.current.delete(migrationId)
            const succeeded = status.job.status === 'succeeded'
            setRowApply(migrationId, {
              phase: succeeded ? 'done' : 'error',
              jobId,
              jobStatus: status,
              error: succeeded ? null : status.job.lastError,
            })
            // A successful apply flips the live sentinel; refresh so the row
            // drops. A failure leaves it pending (safe to retry).
            await refresh()
            return
          }
          setRowApply(migrationId, { phase: 'polling', jobId, jobStatus: status, error: null })
          window.setTimeout(() => void step(), POLL_INTERVAL_MS)
        } catch (cause) {
          if (!mountedRef.current) {
            return
          }
          pollingRef.current.delete(migrationId)
          setRowApply(migrationId, {
            phase: 'error',
            jobId,
            jobStatus: null,
            error: cause instanceof Error ? cause.message : 'Failed to poll the apply job.',
          })
        }
      }

      void step()
    },
    [refresh, setRowApply],
  )

  useEffect(() => {
    void refresh()
  }, [refresh])

  // Resume polling for any row whose server-side last attempt is still
  // running (e.g. an admin reloaded the page mid-apply).
  useEffect(() => {
    if (data === null) {
      return
    }
    for (const row of data.migrations) {
      const jobId = resumableJobId(row)
      if (jobId !== null && !pollingRef.current.has(row.migrationId)) {
        setRowApply(row.migrationId, {
          phase: 'polling',
          jobId,
          jobStatus: null,
          error: null,
        })
        pollApplyJob(row.migrationId, jobId)
      }
    }
  }, [data, pollApplyJob, setRowApply])

  const handleApply = useCallback(
    async (row: AdminPendingMigrationRow) => {
      const typed = confirmText[row.migrationId] ?? ''
      if (typed !== row.migrationId) {
        return
      }
      setRowApply(row.migrationId, { phase: 'submitting', jobId: null, jobStatus: null, error: null })
      try {
        const response = await mutateJson(
          `${LIST_PATH}/${encodeURIComponent(row.migrationId)}/apply`,
          AdminPendingMigrationApplyResponseSchema,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ confirmMigrationId: typed }),
          },
        )
        if (!mountedRef.current) {
          return
        }
        setConfirmText((prev) => ({ ...prev, [row.migrationId]: '' }))
        setRowApply(row.migrationId, {
          phase: 'polling',
          jobId: response.jobId,
          jobStatus: null,
          error: null,
        })
        pollApplyJob(row.migrationId, response.jobId)
      } catch (cause) {
        if (!mountedRef.current) {
          return
        }
        setRowApply(row.migrationId, {
          phase: 'error',
          jobId: null,
          jobStatus: null,
          error: cause instanceof Error ? cause.message : 'Failed to enqueue the apply job.',
        })
      }
    },
    [confirmText, pollApplyJob, setRowApply],
  )

  // Route-level admin guard (defense-in-depth; the server APIs are
  // authoritative). Placed after all hooks so hook order stays stable.
  if (session && session.user && !session.permissions.canManageUsers) {
    return <Navigate to="/" replace />
  }

  const migrations = data?.migrations ?? []

  return (
    <section>
      <div className="page-header">
        <div>
          <p className="eyebrow">Config / Database</p>
          <h2>Pending migrations</h2>
          <p className="subtle-copy">
            Live-pending Helios SQL migrations. <strong>Apply Now</strong> enqueues a worker-driven,
            gated, audited apply (no hand-run <code>psql</code>) and verifies the sentinel before
            reporting success.
          </p>
        </div>
        <div className="inline-row wrap-row">
          <Pill tone={migrations.length > 0 ? 'warning' : 'success'}>
            {`${migrations.length} pending`}
          </Pill>
          <button className="ghost-button" type="button" onClick={() => void refresh()}>
            Refresh
          </button>
          {fetchedAt ? (
            <span className="subtle-copy">last fetch {nyShortDateTime(fetchedAt.getTime())}</span>
          ) : null}
        </div>
      </div>

      {error ? (
        <div className="runtime-status-strip" style={{ marginTop: 8 }}>
          <div className="runtime-status-item">
            <Pill tone="danger">error</Pill>
            <span className="subtle-copy" style={{ whiteSpace: 'pre-wrap' }}>
              {error}
            </span>
          </div>
        </div>
      ) : null}

      <div className="stacked-list" style={{ marginTop: 12 }}>
        {loading && data === null ? (
          <article className="history-card">
            <p className="subtle-copy">Loading pending migrations…</p>
          </article>
        ) : migrations.length === 0 ? (
          <article className="history-card">
            <p className="subtle-copy">
              No pending migrations — the deployed schema matches the shipped code. 🎉
            </p>
          </article>
        ) : (
          migrations.map((row) => {
            const apply = applyStates[row.migrationId] ?? initialRowApplyState()
            const typed = confirmText[row.migrationId] ?? ''
            const button = applyButtonView(row, apply)
            const confirmed = typed === row.migrationId
            const buttonEnabled = button.enabled && confirmed
            const disabledReason = !button.enabled
              ? button.disabledReason
              : confirmed
                ? null
                : 'Type the migration id to confirm.'
            const statusLine = applyStatusLine(row, apply)

            return (
              <article className="history-card" key={row.migrationId}>
                <div className="history-card-topline">
                  <div>
                    <strong>{row.migrationId}</strong>
                    <p className="subtle-copy">{row.label}</p>
                  </div>
                  <div className="inline-row wrap-row">
                    <Pill tone="warning">pending</Pill>
                    <Pill
                      tone={eligibilityTone(row)}
                      title={row.eligible ? undefined : row.ineligibleReason ?? undefined}
                    >
                      {eligibilityLabel(row)}
                    </Pill>
                    {row.blessing ? (
                      <Pill tone="muted">{`txn: ${row.blessing.transactionMode}`}</Pill>
                    ) : null}
                    {row.lastAttempt ? (
                      <Pill tone={attemptStateTone(row.lastAttempt.state)}>
                        {`last: ${attemptStateLabel(row.lastAttempt.state)}`}
                      </Pill>
                    ) : null}
                  </div>
                </div>

                {row.blessing ? (
                  <p className="subtle-copy" style={{ marginTop: 6 }}>
                    Oracle blessing <code>{row.blessing.ref}</code>
                    {row.blessing.note ? <> · {row.blessing.note}</> : null}
                  </p>
                ) : (
                  <p className="subtle-copy" style={{ marginTop: 6 }}>
                    No Oracle blessing recorded in the registry — apply is disabled until one lands.
                  </p>
                )}

                {row.lastAttempt ? (
                  <p className="subtle-copy" style={{ marginTop: 4 }}>
                    last attempt {formatTimestamp(row.lastAttempt.startedAt)}
                    {row.lastAttempt.finishedAt ? (
                      <> → {formatTimestamp(row.lastAttempt.finishedAt)}</>
                    ) : null}
                    {row.lastAttempt.jobId !== null ? (
                      <>
                        {' · '}
                        <Link to={`/jobs/${row.lastAttempt.jobId}`}>job #{row.lastAttempt.jobId}</Link>
                      </>
                    ) : null}
                    {row.lastAttempt.requestedBy !== null ? (
                      <> · by user #{row.lastAttempt.requestedBy}</>
                    ) : null}
                  </p>
                ) : null}

                <div className="filter-row" style={{ marginTop: 10, flexWrap: 'wrap' }}>
                  <input
                    value={typed}
                    onChange={(event) =>
                      setConfirmText((prev) => ({ ...prev, [row.migrationId]: event.target.value }))
                    }
                    placeholder={`Type "${row.migrationId}" to confirm`}
                    style={{ minWidth: 320, flex: '1 1 320px' }}
                    autoComplete="off"
                    spellCheck={false}
                    disabled={!button.enabled}
                  />
                  <button
                    className="primary-button"
                    type="button"
                    disabled={!buttonEnabled}
                    title={disabledReason ?? undefined}
                    onClick={() => void handleApply(row)}
                  >
                    {button.label}
                  </button>
                  {apply.jobId !== null ? (
                    <Link className="ghost-button like-button" to={`/jobs/${apply.jobId}`}>
                      View job #{apply.jobId}
                    </Link>
                  ) : null}
                </div>

                {statusLine ? (
                  <div className="runtime-status-strip" style={{ marginTop: 8 }}>
                    <div className="runtime-status-item">
                      <Pill
                        tone={
                          apply.phase === 'done'
                            ? 'success'
                            : apply.phase === 'error'
                              ? 'danger'
                              : 'warning'
                        }
                      >
                        {apply.phase === 'done'
                          ? 'applied'
                          : apply.phase === 'error'
                            ? 'failed'
                            : 'applying'}
                      </Pill>
                      <span className="subtle-copy" style={{ whiteSpace: 'pre-wrap' }}>
                        {statusLine}
                      </span>
                    </div>
                  </div>
                ) : null}
              </article>
            )
          })
        )}
      </div>

      <details style={{ marginTop: 16 }}>
        <summary className="subtle-copy">About this page / safety model</summary>
        <div className="subtle-copy" style={{ marginTop: 8, lineHeight: 1.5 }}>
          <p>
            Each row is a Helios SQL migration whose live sentinel reports it as{' '}
            <strong>not yet applied</strong> against the production database. Applying is{' '}
            <strong>admin-only</strong> and requires the migration to carry an Oracle blessing in the
            committed registry whose recorded artifact digest still matches the deployed{' '}
            <code>.sql</code> closure (both APIs re-check this live and fail closed).
          </p>
          <p>
            <strong>Apply Now</strong> does not run SQL in the browser or the web tier. It enqueues an
            urgent <code>db.migration.apply</code> job; a worker takes an advisory lock, runs the exact
            reviewed artifact via <code>psql -f</code>, re-checks the live sentinel, and records the
            full lifecycle (blessing ref, artifact digest, redacted command, transaction mode, sentinel
            before/after) to <code>migration_apply_attempts</code> + <code>audit_events</code>. A
            failure after SQL starts is terminal and requires a fresh, reviewed click; forward SQL is
            authored idempotent so retrying is safe.
          </p>
          <p>
            The type-to-confirm box + your admin click is the operator "go". Blessing is a separate
            prerequisite, not the approval.
          </p>
        </div>
      </details>
    </section>
  )
}
