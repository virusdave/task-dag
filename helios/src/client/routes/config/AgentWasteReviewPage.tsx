// Admin review-queue for agent-waste observations (issue #57, ask #1).
//
// Agents record structured "wasted effort" observations (tool footguns,
// repeated startup work, ...) to an append-only store owned by the
// github-worker dispatcher. A human reviews the pending-review backlog here
// and, when a pattern is worth acting on, PROMOTES it into the reviewed
// advisory catalog (advisories.yaml in virusdave/top-level). Promotion is a
// behavior-changing mutation and is deliberately NOT a button here: this v1
// is READ-ONLY (operator decision on issue #57) -- it displays the backlog,
// lets an admin dismiss rows locally, and links toward promotion.
//
// The free-form `note` is human-only: it is rendered as PLAIN TEXT (React
// escapes it; no markdown/HTML) and is NEVER injected into any agent.
//
// ADMIN-GATED at the route level (client guard below); the server route is
// independently admin-gated -- nav-hiding is not access control.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Navigate, useRouteLoaderData } from 'react-router-dom'

import type {
  AgentWasteBacklogResponse,
  AgentWasteObservation,
  SessionEnvelope,
} from '../../../shared/contracts/index.js'
import { Pill } from '../../components/Pill.js'
import { nyLongDateTime, nyShortDateTime } from '../../app/nyTime.js'
import { useRegisterConfigSidebarSubtree } from './configSidebarSubtree.js'
import {
  ADVISORY_CATALOG_DOC_URL,
  ADVISORY_CATALOG_URL,
  compareObservations,
  deriveViewState,
  fetchAgentWasteBacklog,
  observationKey,
  severityTone,
} from './agentWasteReviewShared.js'

const REFRESH_INTERVAL_MS = 60_000

function formatTime(iso: string): string {
  const ms = Date.parse(iso)
  if (Number.isNaN(ms)) {
    return iso
  }
  return nyLongDateTime(ms)
}

function formatTokens(n: number | undefined): string | null {
  if (n == null) {
    return null
  }
  return `${n.toLocaleString('en-US')} tok`
}

function formatSeconds(n: number | undefined): string | null {
  if (n == null) {
    return null
  }
  if (n < 60) {
    return `${Math.round(n)}s`
  }
  return `${Math.round(n / 60)}m`
}

export function AgentWasteReviewPage() {
  useRegisterConfigSidebarSubtree()
  const session = useRouteLoaderData('root') as SessionEnvelope | undefined

  const [data, setData] = useState<AgentWasteBacklogResponse | null>(null)
  const [error, setError] = useState<Error | null>(null)
  const [loading, setLoading] = useState(true)
  const [fetchedAt, setFetchedAt] = useState<Date | null>(null)
  const [dismissed, setDismissed] = useState<Set<string>>(new Set())
  const cancelledRef = useRef(false)

  const refresh = useCallback(async () => {
    try {
      const response = await fetchAgentWasteBacklog()
      if (cancelledRef.current) {
        return
      }
      setData(response)
      setError(null)
      setFetchedAt(new Date())
    } catch (cause) {
      if (cancelledRef.current) {
        return
      }
      setError(cause instanceof Error ? cause : new Error('Failed to load backlog.'))
    } finally {
      if (!cancelledRef.current) {
        setLoading(false)
      }
    }
  }, [])

  useEffect(() => {
    cancelledRef.current = false
    void refresh()
    const handle = window.setInterval(() => void refresh(), REFRESH_INTERVAL_MS)
    return () => {
      cancelledRef.current = true
      window.clearInterval(handle)
    }
  }, [refresh])

  const sorted = useMemo(() => {
    if (!data) {
      return []
    }
    return [...data.observations].sort(compareObservations)
  }, [data])

  const visible = useMemo(
    () => sorted.filter((obs) => !dismissed.has(observationKey(obs))),
    [sorted, dismissed],
  )

  const view = deriveViewState({ loading, data, error, visibleCount: visible.length })

  const dismissObservation = useCallback((obs: AgentWasteObservation) => {
    setDismissed((prev) => {
      const next = new Set(prev)
      next.add(observationKey(obs))
      return next
    })
  }, [])

  const restoreDismissed = useCallback(() => setDismissed(new Set()), [])
  const dismissedCount = sorted.length - visible.length

  // Route-level admin guard (defense-in-depth; the server route is
  // authoritative). Placed after all hooks so hook order stays stable across
  // renders. A non-admin who reaches this URL is redirected to the app root.
  if (session && session.user && !session.permissions.canManageUsers) {
    return <Navigate to="/" replace />
  }

  return (
    <section>
      <div className="page-header">
        <div>
          <p className="eyebrow">Config / Agents</p>
          <h2>Agent-waste review queue</h2>
        </div>
        <div className="inline-row wrap-row">
          {view.kind === 'ready' ? (
            <Pill tone={view.visibleCount > 0 ? 'warning' : 'success'}>
              {`${view.visibleCount} to review`}
            </Pill>
          ) : null}
          <a href={ADVISORY_CATALOG_URL} target="_blank" rel="noopener noreferrer">
            Advisory catalog ↗
          </a>
          <button type="button" className="ghost-button" onClick={() => void refresh()}>
            Refresh
          </button>
          {fetchedAt ? (
            <span className="subtle-copy">last updated {nyShortDateTime(fetchedAt.getTime())}</span>
          ) : null}
        </div>
      </div>

      {view.kind === 'loading' ? <p className="subtle-copy">Loading backlog…</p> : null}

      {view.kind === 'unavailable' ? (
        <article className="mini-card">
          <header>
            <strong>Backlog data unavailable</strong>
          </header>
          <p className="subtle-copy" style={{ marginTop: '0.5rem' }}>
            {view.message}
          </p>
          <p className="subtle-copy" style={{ marginTop: '0.5rem' }}>
            {view.detail}
          </p>
          <div className="inline-row wrap-row" style={{ marginTop: '1rem' }}>
            <button type="button" className="ghost-button" onClick={() => void refresh()}>
              Try again
            </button>
          </div>
        </article>
      ) : null}

      {view.kind === 'error' ? (
        <article className="mini-card">
          <header>
            <strong>Could not load the review queue</strong>
          </header>
          <p className="subtle-copy" style={{ marginTop: '0.5rem', whiteSpace: 'pre-wrap' }}>
            {view.message}
          </p>
          <div className="inline-row wrap-row" style={{ marginTop: '1rem' }}>
            <button type="button" className="ghost-button" onClick={() => void refresh()}>
              Try again
            </button>
          </div>
        </article>
      ) : null}

      {view.kind === 'empty' ? (
        <article className="mini-card">
          <p className="subtle-copy">
            The review queue is empty. Agents have not recorded any observations awaiting review.
          </p>
        </article>
      ) : null}

      {view.kind === 'ready' ? (
        <>
          {visible.length === 0 ? (
            <article className="mini-card">
              <p className="subtle-copy">
                You have dismissed all {dismissedCount} observation
                {dismissedCount === 1 ? '' : 's'} in this session.{' '}
                <button type="button" className="task-link-button" onClick={restoreDismissed}>
                  Show them again
                </button>
              </p>
            </article>
          ) : (
            <>
              {dismissedCount > 0 ? (
                <p className="subtle-copy" style={{ marginBottom: '0.5rem' }}>
                  {dismissedCount} dismissed this session.{' '}
                  <button type="button" className="task-link-button" onClick={restoreDismissed}>
                    Show all
                  </button>
                </p>
              ) : null}
              <div className="stacked-list">
                {visible.map((obs) => (
                  <ObservationCard
                    key={observationKey(obs)}
                    obs={obs}
                    onDismiss={() => dismissObservation(obs)}
                  />
                ))}
              </div>
            </>
          )}
        </>
      ) : null}

      <details style={{ marginTop: '1.5rem' }}>
        <summary className="subtle-copy">About this queue</summary>
        <div className="subtle-copy" style={{ marginTop: '0.5rem', lineHeight: 1.5 }}>
          <p>
            Agents append structured observations of wasted effort (repeated startup work, tool
            footguns, and the like) to a store owned by the github-worker dispatcher. This page shows
            the <strong>pending-review</strong> subset: the unknown / free-form items that need a
            human decision.
          </p>
          <p>
            Reviewing means deciding whether an observation is worth acting on. If it is, you{' '}
            <a href={ADVISORY_CATALOG_URL} target="_blank" rel="noopener noreferrer">
              promote it to <code>advisories.yaml</code>
            </a>{' '}
            in a reviewed commit; that (and only that) can change future agent behavior, within about
            a minute. See the{' '}
            <a href={ADVISORY_CATALOG_DOC_URL} target="_blank" rel="noopener noreferrer">
              advisory catalog contract
            </a>
            . The free-form note on each row is for humans only and is never injected into an agent.
          </p>
          <p>
            <strong>Dismiss</strong> only hides a row in your browser for this session; it does not
            change the store. Server-side review write-back is a deferred follow-up.
          </p>
        </div>
      </details>
    </section>
  )
}

function ObservationCard({
  obs,
  onDismiss,
}: {
  obs: AgentWasteObservation
  onDismiss: () => void
}) {
  const tokens = formatTokens(obs.estimated_wasted_tokens)
  const seconds = formatSeconds(obs.estimated_wasted_seconds)
  return (
    <article className="history-card">
      <div className="history-card-topline">
        <div>
          <strong>{obs.kind}</strong>
          <p className="subtle-copy">
            <code>{obs.id}</code> · {formatTime(obs.time)}
            {obs.repo ? <> · {obs.repo}</> : null}
          </p>
        </div>
        <div className="inline-row wrap-row">
          <Pill tone={severityTone(obs.severity)}>{obs.severity ?? 'unrated'}</Pill>
          <a href={ADVISORY_CATALOG_URL} target="_blank" rel="noopener noreferrer">
            Promote…
          </a>
          <button type="button" className="ghost-button" onClick={onDismiss}>
            Dismiss
          </button>
        </div>
      </div>

      {obs.note ? (
        <p style={{ marginTop: '0.5rem', whiteSpace: 'pre-wrap' }}>{obs.note}</p>
      ) : null}

      {(tokens || seconds || obs.task_sha || obs.host) && (
        <p className="subtle-copy" style={{ marginTop: '0.5rem' }}>
          {[
            tokens ? `wasted ~${tokens}` : null,
            seconds ? `~${seconds}` : null,
            obs.task_sha ? `task ${obs.task_sha.slice(0, 7)}` : null,
            obs.host ? `on ${obs.host}` : null,
          ]
            .filter((part): part is string => part !== null)
            .join(' · ')}
        </p>
      )}
    </article>
  )
}
