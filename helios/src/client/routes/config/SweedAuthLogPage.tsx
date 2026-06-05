// Operator-facing view of recent Sweed auth-related JSON-RPC activity:
// every login / logout / dealer-pin / initial-data call the worker
// issued, plus any non-auth RPC that came back with an auth-error
// signature. Lets us answer questions like:
//   - did this job actually log in cleanly?
//   - which token did it use, and did anyone else's logout invalidate it?
//   - what was the FIRST RPC after a fresh login that saw "Auth expired"?
//
// Filterable by job id, auth-token prefix, and outcome (all vs errors
// only). Auto-refreshes every 15s; use the form to narrow.

import { useEffect, useMemo, useState } from 'react'
import { Form, Link, useLoaderData, useSearchParams } from 'react-router-dom'

import {
  SweedAuthEventsResponseSchema,
  type SweedAuthEvent,
  type SweedAuthEventsResponse,
} from '../../../shared/contracts/index.js'
import { loadJson } from '../../app/fetchJson.js'
import { Pill, type PillProps } from '../../components/Pill.js'

const AUTO_REFRESH_INTERVAL_MS = 60_000 // DB-cost epic E1 (was 15s)

export async function sweedAuthLogLoader({ request }: { request: Request }) {
  const url = new URL(request.url)
  return loadJson(`/api/sweed/auth-events${url.search}`, SweedAuthEventsResponseSchema)
}

function outcomeTone(outcome: SweedAuthEvent['outcome']): PillProps['tone'] {
  switch (outcome) {
    case 'ok':
      return 'success'
    case 'retryable':
      return 'warning'
    case 'error':
      return 'danger'
    default:
      return 'muted'
  }
}

function eventKindLabel(kind: SweedAuthEvent['eventKind']): string {
  switch (kind) {
    case 'login':
      return 'Login'
    case 'logout':
      return 'Logout'
    case 'dealer_set':
      return 'Dealer pin'
    case 'initial_data':
      return 'Initial data'
    case 'rpc_auth_error':
      return 'Auth error on RPC'
    case 'rpc_error':
      return 'RPC failure'
    default:
      return kind
  }
}

function formatDuration(durationMs: number): string {
  if (durationMs < 1000) {
    return `${durationMs} ms`
  }
  return `${(durationMs / 1000).toFixed(2)} s`
}

function formatRelative(iso: string): string {
  try {
    const date = new Date(iso)
    return date.toLocaleString(undefined, { hour12: false })
  } catch {
    return iso
  }
}

export function SweedAuthLogPage() {
  const initialData = useLoaderData() as SweedAuthEventsResponse
  const [searchParams, setSearchParams] = useSearchParams()
  const [data, setData] = useState<SweedAuthEventsResponse>(initialData)
  const [fetchedAt, setFetchedAt] = useState<Date>(new Date())
  const [error, setError] = useState<string | null>(null)

  const jobIdFilter = searchParams.get('jobId') ?? ''
  const outcomeFilter = (searchParams.get('outcomeFilter') as 'all' | 'errors' | null) ?? 'all'
  const authTokenPrefixFilter = searchParams.get('authTokenPrefix') ?? ''
  const limitFilter = searchParams.get('limit') ?? '100'

  // Re-fetch on filter changes (in addition to the route loader's
  // initial fetch) so submitting the form doesn't require a hard
  // refresh.
  useEffect(() => {
    let cancelled = false

    async function refresh(): Promise<void> {
      try {
        const response = await loadJson(
          `/api/sweed/auth-events?${searchParams.toString()}`,
          SweedAuthEventsResponseSchema,
        )
        if (!cancelled) {
          setData(response)
          setFetchedAt(new Date())
          setError(null)
        }
      } catch (cause) {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : 'Failed to load auth events.')
        }
      }
    }

    void refresh()
    const handle = window.setInterval(() => void refresh(), AUTO_REFRESH_INTERVAL_MS)
    return () => {
      cancelled = true
      window.clearInterval(handle)
    }
  }, [searchParams])

  const errorCount = useMemo(
    () => data.items.filter((event) => event.outcome !== 'ok').length,
    [data.items],
  )

  return (
    <section>
      <div className="page-header">
        <div>
          <p className="eyebrow">Config / Diagnostics</p>
          <h2>Sweed auth log</h2>
          <p className="subtle-copy">
            Every login / logout / dealer-pin / initial-data RPC the worker issued, plus any non-auth
            RPC whose response looked like an auth failure. Auto-refreshes every {AUTO_REFRESH_INTERVAL_MS / 1000}s.
          </p>
        </div>
        <div className="inline-row wrap-row">
          <Pill tone="muted">{data.items.length} shown</Pill>
          <Pill tone={errorCount > 0 ? 'danger' : 'success'}>{errorCount} errors</Pill>
          {data.truncated ? <Pill tone="warning">truncated — narrow the filter</Pill> : null}
          <span className="subtle-copy">last fetch {fetchedAt.toLocaleTimeString()}</span>
        </div>
      </div>

      <Form className="filter-row" method="get" onSubmit={(event) => {
        // Let react-router handle the navigation; useSearchParams
        // setter would skip the loader.
        event.preventDefault()
        const form = new FormData(event.currentTarget)
        const next = new URLSearchParams()
        for (const [key, value] of form.entries()) {
          if (typeof value === 'string' && value.trim() !== '') {
            next.set(key, value.trim())
          }
        }
        setSearchParams(next)
      }}>
        <input defaultValue={jobIdFilter} name="jobId" placeholder="Job id" type="number" min={1} />
        <input
          defaultValue={authTokenPrefixFilter}
          name="authTokenPrefix"
          placeholder="Auth token prefix (8 chars)"
          maxLength={8}
        />
        <select defaultValue={outcomeFilter} name="outcomeFilter">
          <option value="all">All outcomes</option>
          <option value="errors">Errors only</option>
        </select>
        <select defaultValue={limitFilter} name="limit">
          <option value="50">50</option>
          <option value="100">100</option>
          <option value="250">250</option>
          <option value="500">500</option>
        </select>
        <button className="ghost-button" type="submit">Filter</button>
      </Form>

      {error ? (
        <div className="runtime-status-strip" style={{ marginTop: 12 }}>
          <div className="runtime-status-item">
            <Pill tone="danger">load failed</Pill>
            <span className="subtle-copy">{error}</span>
          </div>
        </div>
      ) : null}

      <div className="stacked-list" style={{ marginTop: 12 }}>
        {data.items.length === 0 ? (
          <article className="history-card">
            <p className="subtle-copy">
              No matching auth events. If the worker has been busy with Sweed jobs and you still see
              nothing here, double-check that migration 011_sweed_auth_events has been applied (the
              all-pages banner will warn you if it hasn't).
            </p>
          </article>
        ) : (
          data.items.map((event) => (
            <article className="history-card" key={event.id}>
              <div className="history-card-topline">
                <div>
                  <strong>{event.rpcName}</strong>
                  <p className="subtle-copy">
                    {formatRelative(event.createdAt)} · {formatDuration(event.durationMs)}
                    {event.jobId !== null ? (
                      <>
                        {' · '}
                        <Link to={`/jobs/${event.jobId}`}>job #{event.jobId}</Link>
                        {event.jobType ? <> ({event.jobType})</> : null}
                      </>
                    ) : (
                      <> · no job context</>
                    )}
                  </p>
                </div>
                <div className="inline-row wrap-row">
                  <Pill tone={outcomeTone(event.outcome)}>{event.outcome}</Pill>
                  <Pill tone="muted">{eventKindLabel(event.eventKind)}</Pill>
                  {event.sessionOrigin ? <Pill tone="muted">{event.sessionOrigin}</Pill> : null}
                  {event.httpStatus !== null ? <Pill tone="muted">HTTP {event.httpStatus}</Pill> : null}
                  {event.dealerId !== null ? <Pill tone="muted">dealer {event.dealerId}</Pill> : null}
                  {event.authTokenPrefix ? (
                    <Pill tone="muted">tok {event.authTokenPrefix}…</Pill>
                  ) : null}
                </div>
              </div>
              {event.errorMessage ? (
                <pre
                  style={{
                    background: 'rgba(255,0,0,0.08)',
                    padding: 8,
                    borderRadius: 4,
                    margin: '8px 0 0',
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                  }}
                >
                  {event.errorMessage}
                </pre>
              ) : null}
              {Object.keys(event.context).length > 0 ? (
                <details style={{ marginTop: 6 }}>
                  <summary className="subtle-copy">context</summary>
                  <pre
                    style={{
                      background: 'rgba(0,0,0,0.04)',
                      padding: 8,
                      borderRadius: 4,
                      margin: '6px 0 0',
                      whiteSpace: 'pre-wrap',
                      wordBreak: 'break-word',
                    }}
                  >
                    {JSON.stringify(event.context, null, 2)}
                  </pre>
                </details>
              ) : null}
            </article>
          ))
        )}
      </div>
    </section>
  )
}
