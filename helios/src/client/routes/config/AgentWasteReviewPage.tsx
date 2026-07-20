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

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { Navigate, useRouteLoaderData } from 'react-router-dom'

import type {
  AgentWasteBacklogResponse,
  AgentWasteCluster,
  AgentWasteClustersResponse,
  AgentWasteObservation,
  SessionEnvelope,
} from '../../../shared/contracts/index.js'
import { Pill } from '../../components/Pill.js'
import { nyLongDateTime, nyShortDateTime } from '../../app/nyTime.js'
import { useRegisterConfigSidebarSubtree } from './configSidebarSubtree.js'
import {
  ADVISORY_CATALOG_DOC_URL,
  ADVISORY_CATALOG_URL,
  buildPromoteRequest,
  compareObservations,
  defaultPromoteFormState,
  deriveViewState,
  describeClusterError,
  evictClusterMember,
  fetchAgentWasteBacklog,
  fetchAgentWasteClusters,
  observationKey,
  promoteTextTokens,
  severityTone,
  submitPromoteAdvisory,
  type PromoteFormState,
  type PromoteSubmitResult,
} from './agentWasteReviewShared.js'
import type {
  AdvisorySeverity,
  PromotableAdvisoryStatus,
} from '../../../shared/contracts/index.js'

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

  // "Cluster similar reports" (issue #68): on-demand, display-only grouping of
  // the pending backlog by an advanced private model. `clusters` is a snapshot
  // taken when the operator pressed the button; `view` toggles the flat list
  // vs. the clustered view once a snapshot exists.
  const [clusters, setClusters] = useState<AgentWasteClustersResponse | null>(null)
  const [clusterError, setClusterError] = useState<{ code: string; message: string } | null>(null)
  const [clustering, setClustering] = useState(false)
  const [viewMode, setViewMode] = useState<'flat' | 'clustered'>('flat')
  const [clusterUndo, setClusterUndo] = useState<{
    before: AgentWasteClustersResponse
    observationId: string
    removalButtonId: string
  } | null>(null)
  const clusterUndoButtonRef = useRef<HTMLButtonElement>(null)
  const restoreClusterFocusRef = useRef<string | null>(null)

  const runClustering = useCallback(async () => {
    setClustering(true)
    setClusterError(null)
    const result = await fetchAgentWasteClusters()
    if (cancelledRef.current) {
      return
    }
    setClustering(false)
    if (result.ok) {
      setClusters(result.response)
      setClusterUndo(null)
      setViewMode('clustered')
    } else {
      setClusterError({ code: result.code, message: result.message })
    }
  }, [])

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

  const removeFromCluster = useCallback(
    (clusterIndex: number, memberIndex: number) => {
      if (!clusters || clustering) {
        return
      }
      const observation = clusters.clusters[clusterIndex]?.members[memberIndex]
      const next = evictClusterMember(clusters, clusterIndex, memberIndex)
      if (!observation || next === clusters) {
        return
      }
      setClusterUndo({
        before: clusters,
        observationId: observation.id,
        removalButtonId: `cluster-remove-${clusterIndex}-${memberIndex}`,
      })
      setClusters(next)
    },
    [clusters, clustering],
  )

  const undoClusterRemoval = useCallback(() => {
    if (!clusterUndo || clustering) {
      return
    }
    restoreClusterFocusRef.current = clusterUndo.removalButtonId
    setClusters(clusterUndo.before)
    setClusterUndo(null)
  }, [clusterUndo, clustering])

  useEffect(() => {
    if (clusterUndo && viewMode === 'clustered') {
      clusterUndoButtonRef.current?.focus()
      return
    }
    const focusId = restoreClusterFocusRef.current
    if (focusId) {
      restoreClusterFocusRef.current = null
      const target = document.getElementById(focusId)
      const disclosure = target?.closest('details')
      if (disclosure) {
        disclosure.open = true
      }
      target?.focus()
    }
  }, [clusterUndo, viewMode])

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
          {view.kind === 'ready' ? (
            <button
              type="button"
              className="ghost-button"
              onClick={() => void runClustering()}
              disabled={clustering}
              title="Group near-duplicate reports by theme with an advanced model (display-only)."
            >
              {clustering ? 'Clustering…' : 'Cluster similar reports'}
            </button>
          ) : null}
          {clusters ? (
            <button
              type="button"
              className="ghost-button"
              onClick={() => setViewMode((m) => (m === 'clustered' ? 'flat' : 'clustered'))}
            >
              {viewMode === 'clustered' ? 'Show flat list' : 'Show clusters'}
            </button>
          ) : null}
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

      {clusterError ? (
        <article className="mini-card" role="alert" style={{ marginBottom: '0.75rem' }}>
          <header>
            <strong>Could not cluster reports</strong>
          </header>
          <p className="subtle-copy" style={{ marginTop: '0.5rem', whiteSpace: 'pre-wrap' }}>
            {describeClusterError(clusterError.code, clusterError.message)}
          </p>
        </article>
      ) : null}

      {clusterUndo && viewMode === 'clustered' ? (
        <div className="agent-waste-cluster-undo" role="status">
          <span>
            Moved <code>{clusterUndo.observationId}</code> to ungrouped.
          </span>
          <button
            ref={clusterUndoButtonRef}
            type="button"
            className="ghost-button"
            disabled={clustering}
            onClick={undoClusterRemoval}
          >
            Undo
          </button>
        </div>
      ) : null}

      {view.kind === 'ready' ? (
        viewMode === 'clustered' && clusters ? (
          <ClusteredView
            clusters={clusters}
            removalDisabled={clustering}
            onRemoveFromCluster={removeFromCluster}
          />
        ) : (
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
        )
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
  onRemoveFromCluster,
  removeFromClusterId,
  removalDisabled,
}: {
  obs: AgentWasteObservation
  /** Omitted when the card is not part of the dismissible flat list. */
  onDismiss?: () => void
  onRemoveFromCluster?: () => void
  removeFromClusterId?: string
  removalDisabled?: boolean
}) {
  const tokens = formatTokens(obs.estimated_wasted_tokens)
  const seconds = formatSeconds(obs.estimated_wasted_seconds)
  const [promoting, setPromoting] = useState(false)
  const promoteFormId = useId()
  return (
    <article className="history-card agent-waste-observation-card">
      <div className="history-card-topline">
        <div>
          <strong>{obs.kind}</strong>
          <p className="subtle-copy">
            <code>{obs.id}</code> · {formatTime(obs.time)}
            {obs.repo ? <> · {obs.repo}</> : null}
          </p>
        </div>
        <div className="inline-row wrap-row agent-waste-observation-actions">
          <Pill tone={severityTone(obs.severity)}>{obs.severity ?? 'unrated'}</Pill>
          <button
            type="button"
            className="ghost-button"
            aria-expanded={promoting}
            aria-controls={promoteFormId}
            onClick={() => setPromoting((v) => !v)}
          >
            {promoting ? 'Cancel promotion' : 'Promote…'}
          </button>
          {onDismiss ? (
            <button type="button" className="ghost-button" onClick={onDismiss}>
              Dismiss
            </button>
          ) : null}
          {onRemoveFromCluster ? (
            <button
              id={removeFromClusterId}
              type="button"
              className="ghost-button"
              disabled={removalDisabled}
              onClick={onRemoveFromCluster}
              aria-label={`Remove ${obs.id} report recorded ${formatTime(obs.time)} from cluster`}
            >
              Remove from cluster
            </button>
          ) : null}
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

      {promoting ? (
        <PromoteForm
          obs={obs}
          formId={promoteFormId}
          onDone={() => setPromoting(false)}
          onDismiss={onDismiss}
        />
      ) : null}
    </article>
  )
}

const STATUS_OPTIONS: PromotableAdvisoryStatus[] = ['active', 'permanent-safety']
const SEVERITY_OPTIONS: AdvisorySeverity[] = ['low', 'medium', 'high', 'safety']

function PromoteForm({
  obs,
  formId,
  onDone,
  onDismiss,
}: {
  obs: AgentWasteObservation
  formId: string
  onDone: () => void
  onDismiss?: () => void
}) {
  const [state, setState] = useState<PromoteFormState>(() => defaultPromoteFormState(obs))
  const [errors, setErrors] = useState<string[]>([])
  const [submitting, setSubmitting] = useState(false)
  const [result, setResult] = useState<PromoteSubmitResult | null>(null)

  const set = <K extends keyof PromoteFormState>(key: K, value: PromoteFormState[K]) =>
    setState((prev) => ({ ...prev, [key]: value }))

  const maxTokens = Number(state.maxTokens)
  const textTokens = promoteTextTokens(state.text)
  const overBudget = Number.isFinite(maxTokens) && textTokens > maxTokens

  const submit = async () => {
    setErrors([])
    setResult(null)
    const built = buildPromoteRequest(state, obs.id)
    if (!built.ok) {
      setErrors(built.errors)
      return
    }
    setSubmitting(true)
    const r = await submitPromoteAdvisory(built.request)
    setSubmitting(false)
    setResult(r)
  }

  // On success, show the outcome + a link to the commit. The row is handled
  // now, so the primary next action is to hide it from the queue; keep the
  // commit link visible and offer a way to leave the row in place.
  if (result && result.ok) {
    return (
      <div className="promote-form promote-form--done" id={formId} role="status" aria-live="polite">
        <p>
          <strong>Promoted.</strong> Added <code>{result.response.id}</code> to the advisory
          catalog. Future agents pick it up within ~1 minute.
        </p>
        <p className="inline-row wrap-row">
          <a href={result.response.commitUrl} target="_blank" rel="noopener noreferrer">
            View commit ↗
          </a>
          {onDismiss ? (
            <button type="button" className="primary-button" onClick={onDismiss}>
              Hide handled row
            </button>
          ) : null}
          <button type="button" className="ghost-button" onClick={onDone}>
            {onDismiss ? 'Keep row visible' : 'Close'}
          </button>
        </p>
      </div>
    )
  }

  return (
    <form
      className="promote-form"
      id={formId}
      onSubmit={(e) => {
        e.preventDefault()
        void submit()
      }}
    >
      <p className="subtle-copy">
        Approve a <strong>reviewed</strong> advisory. Only <code>text</code> is ever injected into
        future agents — type it, or paste an LLM draft and edit it; whatever you commit here is what
        ships. The observation&rsquo;s note is never auto-used. The catalog contract caps size &amp;
        count (see{' '}
        <a href={ADVISORY_CATALOG_DOC_URL} target="_blank" rel="noopener noreferrer">
          contract
        </a>
        ).
      </p>

      <div className="promote-grid">
        <label>
          <span>Advisory id (kebab-case)</span>
          <input
            type="text"
            value={state.id}
            placeholder="e.g. rg-short-r"
            onChange={(e) => set('id', e.target.value)}
          />
        </label>
        <label>
          <span>Status</span>
          <select
            value={state.status}
            onChange={(e) => set('status', e.target.value as PromotableAdvisoryStatus)}
          >
            {STATUS_OPTIONS.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Severity</span>
          <select
            value={state.severity}
            onChange={(e) => set('severity', e.target.value as AdvisorySeverity)}
          >
            {SEVERITY_OPTIONS.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Scope</span>
          <input
            type="text"
            value={state.scope}
            placeholder="global or repo:owner/repo"
            onChange={(e) => set('scope', e.target.value)}
          />
        </label>
        <label>
          <span>Max tokens</span>
          <input
            type="number"
            min={1}
            value={state.maxTokens}
            onChange={(e) => set('maxTokens', e.target.value)}
          />
        </label>
        {state.status === 'active' ? (
          <label>
            <span>Expires after days (optional)</span>
            <input
              type="number"
              min={1}
              value={state.expiresAfterDays}
              placeholder="default 14"
              onChange={(e) => set('expiresAfterDays', e.target.value)}
            />
          </label>
        ) : null}
      </div>

      <label className="promote-block">
        <span>
          Advisory text (injected) —{' '}
          <span className={overBudget ? 'promote-tokens promote-tokens--over' : 'promote-tokens'}>
            ~{textTokens}/{Number.isFinite(maxTokens) ? maxTokens : '?'} tokens
          </span>
        </span>
        <textarea
          rows={2}
          value={state.text}
          placeholder="One self-contained line an agent can act on cold."
          onChange={(e) => set('text', e.target.value)}
        />
      </label>

      <label className="promote-block">
        <span>Trigger observation ids (comma/space separated)</span>
        <input
          type="text"
          value={state.triggerIdsCsv}
          onChange={(e) => set('triggerIdsCsv', e.target.value)}
        />
      </label>

      <label className="promote-block">
        <span>Review notes (human-only, never injected)</span>
        <input type="text" value={state.notes} onChange={(e) => set('notes', e.target.value)} />
      </label>

      {errors.length > 0 ? (
        <ul className="promote-errors" role="alert">
          {errors.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      ) : null}

      {result && !result.ok ? (
        <p className="promote-errors" role="alert">
          {result.code === 'agent_pain_points_unavailable'
            ? 'The advisory write path is not wired up yet on this server, so the promotion could not be committed. ' +
              result.message
            : `Promotion failed (${result.code}): ${result.message}`}
        </p>
      ) : null}

      <div className="inline-row wrap-row" style={{ marginTop: '0.5rem' }}>
        <button type="submit" className="primary-button" disabled={submitting}>
          {submitting ? 'Promoting…' : 'Commit + push advisory'}
        </button>
        <button type="button" className="ghost-button" disabled={submitting} onClick={onDone}>
          Cancel
        </button>
      </div>
    </form>
  )
}

// Clustered view (issue #68): ranked, display-only theme clusters. Each shows
// its representative report with a member-count pill; the remaining members
// are collapsed behind a <details>/<summary> per helios/AGENTS.md so the
// operator sees the answer (the ranked themes) without scrolling past detail.
function ClusteredView({
  clusters,
  removalDisabled,
  onRemoveFromCluster,
}: {
  clusters: AgentWasteClustersResponse
  removalDisabled: boolean
  onRemoveFromCluster: (clusterIndex: number, memberIndex: number) => void
}) {
  return (
    <>
      <p className="subtle-copy" role={clusters.warnings.length > 0 ? 'status' : undefined} style={{ marginBottom: '0.5rem' }}>
        {clusters.warnings.length > 0
          ? <>Partial model refinement · {clusters.coverageComplete ? `all ${clusters.outputCount} reports covered` : `${clusters.outputCount}/${clusters.inputCount} reports covered`} · {clusters.refinementSucceeded}/{clusters.refinementTotal} units refined · </>
          : null}
        {clusters.clusters.length > 0
          ? <>{clusters.clusters.length} cluster{clusters.clusters.length === 1 ? '' : 's'}, most
              aggregate waste first · {clusters.model ? <>model <code>{clusters.model}</code></> : 'deterministic baseline'} (display-only)</>
          : <>No reports are currently grouped. {clusters.model ? <>Model: <code>{clusters.model}</code></> : 'Deterministic baseline'} (display-only)</>}
        {clusters.unclustered.length > 0
          ? ` · ${clusters.unclustered.length} left ungrouped`
          : null}
      </p>
      <div className="stacked-list">
        {clusters.clusters.map((cluster, i) => (
          <ClusterCard
            key={`${observationKey(cluster.primary)}-${i}`}
            cluster={cluster}
            clusterIndex={i}
            removalDisabled={removalDisabled}
            onRemove={(memberIndex) => onRemoveFromCluster(i, memberIndex)}
          />
        ))}
      </div>
      {clusters.unclustered.length > 0 ? (
        <details style={{ marginTop: '1rem' }}>
          <summary className="subtle-copy">
            {clusters.unclustered.length} ungrouped report
            {clusters.unclustered.length === 1 ? '' : 's'}
          </summary>
          <div className="stacked-list" style={{ marginTop: '0.5rem' }}>
            {clusters.unclustered.map((obs, i) => (
              <ObservationCard key={`${observationKey(obs)}-${i}`} obs={obs} />
            ))}
          </div>
        </details>
      ) : null}
    </>
  )
}

function ClusterCard({
  cluster,
  clusterIndex,
  removalDisabled,
  onRemove,
}: {
  cluster: AgentWasteCluster
  clusterIndex: number
  removalDisabled: boolean
  onRemove: (memberIndex: number) => void
}) {
  const primaryIndex = cluster.members.findIndex(
    (member) => observationKey(member) === observationKey(cluster.primary),
  )
  const others = cluster.members
    .map((observation, memberIndex) => ({ observation, memberIndex }))
    .filter(({ memberIndex }) => memberIndex !== primaryIndex)
  const tokens = formatTokens(cluster.aggregateWastedTokens)
  const seconds =
    cluster.aggregateWastedSeconds > 0 ? formatSeconds(cluster.aggregateWastedSeconds) : null
  return (
    <article className="history-card agent-waste-cluster-card">
      <div className="history-card-topline">
        <div>
          <strong>{cluster.label}</strong>
          <p className="subtle-copy">
            aggregate {tokens ?? '0 tok'}
            {seconds ? ` · ${seconds}` : null}
            {` · ${cluster.provenance === 'model_refined' ? 'model refined' : 'deterministic'}`}
          </p>
        </div>
        <Pill tone={cluster.count > 1 ? 'warning' : 'muted'}>
          {`${cluster.count} report${cluster.count === 1 ? '' : 's'}`}
        </Pill>
      </div>
      <div style={{ marginTop: '0.5rem' }}>
        <ObservationCard
          obs={cluster.primary}
          removeFromClusterId={`cluster-remove-${clusterIndex}-${primaryIndex}`}
          removalDisabled={removalDisabled}
          onRemoveFromCluster={() => onRemove(primaryIndex)}
        />
      </div>
      {others.length > 0 ? (
        <details style={{ marginTop: '0.5rem' }}>
          <summary className="subtle-copy">
            Show {others.length} other member{others.length === 1 ? '' : 's'}
          </summary>
          <div className="stacked-list" style={{ marginTop: '0.5rem' }}>
            {others.map(({ observation, memberIndex }) => (
              <ObservationCard
                key={`${observationKey(observation)}-${memberIndex}`}
                obs={observation}
                removeFromClusterId={`cluster-remove-${clusterIndex}-${memberIndex}`}
                removalDisabled={removalDisabled}
                onRemoveFromCluster={() => onRemove(memberIndex)}
              />
            ))}
          </div>
        </details>
      ) : null}
    </article>
  )
}
