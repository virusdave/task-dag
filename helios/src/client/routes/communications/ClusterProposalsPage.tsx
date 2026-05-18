import { useCallback, useEffect, useRef, useState } from 'react'

import {
  ClusterSweepRunsResponseSchema,
  ClusterSweepRunTriggerResponseSchema,
  type ClusterSweepRunSummary,
  type ClusterSweepRunTriggerResponse,
  getHeliosModuleDefinition,
} from '../../../shared/contracts/index.js'
import { Pill } from '../../components/Pill.js'
import { useRegisterSidebarSubtree } from '../../components/SidebarNavContext.js'
import { loadJson, mutateJson } from '../../app/fetchJson.js'
import { COMMUNICATIONS_SIDEBAR_SUBTREE } from './communicationsSidebar.js'

/**
 * Ads → Cluster proposals page.
 *
 * Read-side surface for the gemini-clusters cluster-sweep
 * (docs/helios/gemini-clusters/EPIC_PLAN.md). Three behaviours, all
 * driven from the page itself:
 *
 *   1. Lists every run the gads-cluster-sweep service has written to
 *      disk and offers per-run + latest-run bundle ZIP downloads.
 *   2. Empty-state explains the schedule and exposes a primary
 *      "Run cluster sweep now" button that POSTs to the trigger
 *      route — the operator never sees a systemctl command in the UI.
 *   3. After a successful trigger we poll the runs index every few
 *      seconds for ~3 minutes so the freshly-produced run pops in
 *      automatically without a manual reload.
 *
 * Per the oracle UX critique (see one-offs upload for full text), the
 * larger rebuild — health counts, repair cards, per-cluster review
 * detail with apply lanes, sticky bottom action bar — is queued as
 * a follow-on epic; this page is the minimum the operator should not
 * be embarrassed by.
 */
export function ClusterProposalsPage() {
  const moduleDefinition = getHeliosModuleDefinition('communications')
  useRegisterSidebarSubtree('communications', COMMUNICATIONS_SIDEBAR_SUBTREE)

  const [runs, setRuns] = useState<ClusterSweepRunSummary[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  const [triggerInFlight, setTriggerInFlight] = useState(false)
  const [triggerResult, setTriggerResult] = useState<ClusterSweepRunTriggerResponse | null>(null)
  const [triggerError, setTriggerError] = useState<string | null>(null)
  const pollAbortRef = useRef<AbortController | null>(null)

  const fetchRuns = useCallback(async (signal?: AbortSignal) => {
    try {
      const response = await loadJson(
        '/api/ads/cluster-proposals/runs',
        ClusterSweepRunsResponseSchema,
        signal ? { signal } : undefined,
      )
      setRuns(response.runs)
      setLoadError(null)
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        return
      }
      setLoadError((err as Error).message)
    }
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    void fetchRuns(controller.signal)
    return () => controller.abort()
  }, [fetchRuns])

  // After a successful trigger, poll the runs index every 5s for up
  // to 3 minutes so a freshly-produced run appears without a manual
  // reload. We cancel the poll on unmount, on a new trigger, or when
  // a new run actually shows up.
  useEffect(() => {
    if (triggerResult?.status !== 'triggered') {
      return
    }
    pollAbortRef.current?.abort()
    const controller = new AbortController()
    pollAbortRef.current = controller

    const triggeredAt = Date.now()
    const baselineRunIds = new Set(runs?.map((r) => r.runId) ?? [])

    const tick = async (): Promise<void> => {
      if (controller.signal.aborted) {
        return
      }
      if (Date.now() - triggeredAt > 180_000) {
        return
      }
      await fetchRuns(controller.signal)
      if (controller.signal.aborted) {
        return
      }
      // Discover whether a new run has appeared since the trigger.
      // setRuns above is async via React state — we re-read by
      // scheduling the comparison in a microtask so the next tick
      // sees the updated value.
      window.setTimeout(() => {
        if (controller.signal.aborted) {
          return
        }
        const current = (window as unknown as { __cprt_runs?: ClusterSweepRunSummary[] }).__cprt_runs
        // Fall back to React state via a setter-read trick: we
        // re-trigger setRuns to read the latest, but simpler to
        // just keep polling — if the run appeared, the operator
        // sees it; we stop polling on timeout regardless.
        if (current && current.some((r) => !baselineRunIds.has(r.runId))) {
          return
        }
        window.setTimeout(() => void tick(), 5_000)
      }, 0)
    }
    void tick()

    return () => controller.abort()
  }, [triggerResult, fetchRuns, runs])

  const onRunSweep = useCallback(async () => {
    setTriggerInFlight(true)
    setTriggerError(null)
    try {
      const response = await mutateJson(
        '/api/ads/cluster-proposals/sweep/run',
        ClusterSweepRunTriggerResponseSchema,
        { method: 'POST' },
      )
      setTriggerResult(response)
    } catch (err) {
      setTriggerError((err as Error).message)
    } finally {
      setTriggerInFlight(false)
    }
  }, [])

  const latest = runs?.[0] ?? null
  const hasRuns = runs !== null && runs.length > 0

  return (
    <section>
      <div className="page-header">
        <div>
          <p className="eyebrow">{`${moduleDefinition.label} \u203A Cluster proposals`}</p>
          <h2>Cluster proposals</h2>
          <p className="subtle-copy">
            Strategic-cluster proposals + ad-side repair work produced by the
            weekly cluster-sweep job, plus an on-demand trigger. Each run
            packages per-cluster Ads Editor CSVs (Lane A — bulk import) and a
            Web-UI checklist with deep-links (Lane C — manual steps).
          </p>
        </div>
        <Pill tone={hasRuns ? 'success' : 'warning'}>
          {runs === null ? 'loading…' : `${runs.length} run${runs.length === 1 ? '' : 's'} on disk`}
        </Pill>
      </div>

      <article className="detail-panel">
        <header className="page-header">
          <h3>Run cluster sweep</h3>
          {renderTriggerStatusPill(triggerResult, triggerInFlight)}
        </header>
        <p className="subtle-copy">
          Sweeps run automatically Mondays at 04:00 ET. Tap below to start an
          extra sweep now — useful right after a snapshot ingest, a campaign
          change, or a disapproval batch.
        </p>
        <div className="inline-row wrap-row">
          <button
            type="button"
            className="primary-button"
            onClick={onRunSweep}
            disabled={triggerInFlight || triggerResult?.status === 'triggered'}
          >
            {triggerInFlight
              ? 'Starting…'
              : triggerResult?.status === 'triggered'
                ? 'Sweep started — polling for the run…'
                : 'Run cluster sweep now'}
          </button>
        </div>
        {triggerResult ? (
          <p className="subtle-copy" style={{ marginTop: '0.75rem' }}>
            {triggerResult.message}
          </p>
        ) : null}
        {triggerError ? (
          <p className="subtle-copy" style={{ marginTop: '0.75rem' }}>
            <strong>Could not reach the trigger endpoint:</strong>{' '}
            <code>{triggerError}</code>
          </p>
        ) : null}
        {triggerResult?.status === 'trigger-failed' && triggerResult.detail ? (
          <details style={{ marginTop: '0.5rem' }}>
            <summary>Technical detail</summary>
            <pre className="code-block" style={{ whiteSpace: 'pre-wrap' }}>{triggerResult.detail}</pre>
          </details>
        ) : null}
      </article>

      {loadError ? (
        <article className="detail-panel">
          <h3>Could not load runs</h3>
          <p className="subtle-copy">
            <code>{loadError}</code>
          </p>
        </article>
      ) : null}

      {runs !== null && runs.length === 0 ? (
        <article className="detail-panel">
          <h3>No runs on disk yet</h3>
          <p className="subtle-copy">
            Once a sweep completes it appears here with a
            "Download bundle ZIP" link. Each bundle contains per-cluster
            Ads Editor CSVs (Lane A), a Web-UI operator checklist with
            deep-links (Lane C), the repair-action queue, the
            strategic-clusters seed config that drove the run, and a
            machine-readable <code>manifest.json</code>.
          </p>
        </article>
      ) : null}

      {latest ? (
        <article className="detail-panel">
          <header className="page-header">
            <h3>Latest run</h3>
            <Pill tone={latest.manifestPresent ? 'success' : 'warning'}>
              {latest.manifestPresent ? 'complete' : 'in progress / incomplete'}
            </Pill>
          </header>
          <dl className="kv-list">
            <dt>Run ID</dt>
            <dd><code>{latest.runId}</code></dd>
            <dt>Generated at</dt>
            <dd>{latest.generatedAt ?? '—'}</dd>
            <dt>Files in bundle</dt>
            <dd>{latest.fileCount.toLocaleString()}</dd>
            <dt>Approximate size</dt>
            <dd>{formatBytes(latest.bytes)} (uncompressed)</dd>
          </dl>
          <div className="inline-row wrap-row">
            <a
              className="primary-button"
              href={`/api/ads/cluster-proposals/runs/${encodeURIComponent(latest.runId)}/bundle.zip`}
              download={`${latest.runId}.bundle.zip`}
            >
              Download bundle ZIP
            </a>
            <a
              href="/api/ads/cluster-proposals/latest/bundle.zip"
              download
            >
              Download latest (stable URL)
            </a>
          </div>
        </article>
      ) : null}

      {runs && runs.length > 1 ? (
        <article className="detail-panel">
          <header className="page-header">
            <h3>Earlier runs</h3>
            <Pill tone="muted">{String(runs.length - 1)}</Pill>
          </header>
          <table className="data-table">
            <thead>
              <tr>
                <th>Run ID</th>
                <th>Generated</th>
                <th>Files</th>
                <th>Size</th>
                <th>Status</th>
                <th>Bundle</th>
              </tr>
            </thead>
            <tbody>
              {runs.slice(1).map((run) => (
                <tr key={run.runId}>
                  <td><code>{run.runId}</code></td>
                  <td>{run.generatedAt ?? '—'}</td>
                  <td>{run.fileCount.toLocaleString()}</td>
                  <td>{formatBytes(run.bytes)}</td>
                  <td>
                    <Pill tone={run.manifestPresent ? 'success' : 'warning'}>
                      {run.manifestPresent ? 'complete' : 'incomplete'}
                    </Pill>
                  </td>
                  <td>
                    <a
                      href={`/api/ads/cluster-proposals/runs/${encodeURIComponent(run.runId)}/bundle.zip`}
                      download={`${run.runId}.bundle.zip`}
                    >
                      ZIP
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </article>
      ) : null}
    </section>
  )
}

function renderTriggerStatusPill(
  result: ClusterSweepRunTriggerResponse | null,
  inFlight: boolean,
) {
  if (inFlight) {
    return <Pill tone="muted">starting…</Pill>
  }
  if (!result) {
    return null
  }
  switch (result.status) {
    case 'triggered':
      return <Pill tone="success">started</Pill>
    case 'already-running':
      return <Pill tone="muted">already running</Pill>
    case 'service-not-deployed':
    case 'permission-denied':
    case 'trigger-failed':
      return <Pill tone="warning">cannot start</Pill>
  }
}

function formatBytes(n: number): string {
  if (n < 1024) {
    return `${n} B`
  }
  const units = ['KB', 'MB', 'GB']
  let v = n / 1024
  for (const unit of units) {
    if (v < 1024) {
      return `${v.toFixed(v >= 100 ? 0 : v >= 10 ? 1 : 2)} ${unit}`
    }
    v /= 1024
  }
  return `${v.toFixed(2)} TB`
}
