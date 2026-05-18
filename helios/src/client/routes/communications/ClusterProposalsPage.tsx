import { useEffect, useState } from 'react'

import {
  ClusterSweepRunsResponseSchema,
  type ClusterSweepRunSummary,
  getHeliosModuleDefinition,
} from '../../../shared/contracts/index.js'
import { Pill } from '../../components/Pill.js'
import { useRegisterSidebarSubtree } from '../../components/SidebarNavContext.js'
import { loadJson } from '../../app/fetchJson.js'
import { COMMUNICATIONS_SIDEBAR_SUBTREE } from './communicationsSidebar.js'

/**
 * Ads → Cluster proposals page.
 *
 * Read-only surface for the gemini-clusters cluster-sweep
 * (docs/helios/gemini-clusters/EPIC_PLAN.md): lists every run the
 * gads-cluster-sweep service has written to disk under
 * ads/google/outputs/cluster-sweep/, with a "Download bundle ZIP"
 * button for each. When no runs are present (the common case until
 * the first scheduled sweep completes), the page tells the operator
 * when the next sweep is scheduled and how to trigger one manually
 * on vps-nixos-3.
 *
 * The richer per-cluster card UI (verdicts, per-lane action
 * breakdown, Apply modal with Lane A CSV download + Lane C checklist)
 * is delivered by P3b of the gemini-clusters epic and will replace
 * this page's body once available. The download path on this page
 * (/api/ads/cluster-proposals/...) is the same one P3b consumes, so
 * downloads keep working across the swap.
 */
export function ClusterProposalsPage() {
  const moduleDefinition = getHeliosModuleDefinition('communications')
  useRegisterSidebarSubtree('communications', COMMUNICATIONS_SIDEBAR_SUBTREE)

  const [runs, setRuns] = useState<ClusterSweepRunSummary[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    void (async () => {
      try {
        const response = await loadJson(
          '/api/ads/cluster-proposals/runs',
          ClusterSweepRunsResponseSchema,
        )
        if (active) {
          setRuns(response.runs)
        }
      } catch (err) {
        if (active) {
          setError((err as Error).message)
        }
      }
    })()
    return () => {
      active = false
    }
  }, [])

  const latest = runs?.[0] ?? null

  return (
    <section>
      <div className="page-header">
        <div>
          <p className="eyebrow">{`${moduleDefinition.label} \u203A Cluster proposals`}</p>
          <h2>Cluster proposals</h2>
          <p className="subtle-copy">
            Strategic-cluster proposals + ad-side repair work, produced by the
            weekly <code>gads-cluster-sweep.service</code> on vps-nixos-3 and
            its on-demand trigger. Each run writes a bundle ZIP you can hand
            to the operator workflow (Lane A — Ads Editor CSVs, Lane C — Web
            UI checklist with deep-links). Tracked by the
            {' '}
            <a
              href="https://github.com/virusdave/top-level/blob/master/docs/epics/gemini-clusters/EPIC_PLAN.md"
              target="_blank"
              rel="noreferrer noopener"
            >
              gemini-clusters epic
            </a>.
          </p>
        </div>
        <Pill tone={runs && runs.length > 0 ? 'success' : 'warning'}>
          {runs === null ? 'loading…' : `${runs.length} run${runs.length === 1 ? '' : 's'} on disk`}
        </Pill>
      </div>

      {error ? (
        <article className="detail-panel">
          <h3>Could not load runs</h3>
          <p className="subtle-copy">
            <code>{error}</code>
          </p>
        </article>
      ) : null}

      {runs !== null && runs.length === 0 ? (
        <article className="detail-panel">
          <h3>No cluster-sweep runs yet</h3>
          <p className="subtle-copy">
            The first scheduled sweep runs Mondays at 04:00 ET on vps-nixos-3
            (<code>gads-cluster-sweep.timer</code>). To trigger one on demand,
            ssh in and run:
          </p>
          <pre className="code-block">
{`systemctl start gads-cluster-sweep.service
journalctl -u gads-cluster-sweep.service -f`}
          </pre>
          <p className="subtle-copy">
            Once a run completes it appears here with a
            "Download bundle ZIP" link. The bundle contains per-cluster CSV
            batches (Lane A — Ads Editor import-ready), a Lane C operator
            checklist, the repair-action queue, the strategic-clusters seed
            config that drove the run, and a machine-readable
            <code> manifest.json</code>.
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
