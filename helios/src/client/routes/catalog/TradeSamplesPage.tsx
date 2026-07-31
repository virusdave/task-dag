import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'

import {
  HELIOS_PENDING_PURCHASE_SITE_DEALERS,
  type JobStatusResponse,
  TradeSampleRecentStageJobResponseSchema,
  TradeSampleZeroEnqueueResponseSchema,
  TradeSampleZeroPreviewResponseSchema,
  type TradeSampleZeroPreviewResponse,
} from '../../../shared/contracts/index.js'
import { HttpResponseError, loadJson, mutateJson } from '../../app/fetchJson.js'
import { isJobTerminal, loadJobStatus } from '../../app/jobPolling.js'
import { nyLongDateTime } from '../../app/nyTime.js'
import { Pill } from '../../components/Pill.js'
import { useRegisterCatalogSidebarSubtree } from './catalogSidebarSubtree.js'
import { TradeSampleScopeSummary } from './TradeSampleScopeSummary.js'

const JOB_POLL_MS = 1_500

type RecentStageJobState =
  | { kind: 'loading' }
  | { kind: 'load_error' }
  | { kind: 'none' }
  | { kind: 'known'; jobId: number; status: JobStatusResponse | null; statusUnavailable: boolean }

export function TradeSamplesPage() {
  useRegisterCatalogSidebarSubtree()
  const [siteDealerId, setSiteDealerId] = useState<number>(HELIOS_PENDING_PURCHASE_SITE_DEALERS[0].dealerId)
  const [preview, setPreview] = useState<TradeSampleZeroPreviewResponse | null>(null)
  const [recentStageJob, setRecentStageJob] = useState<RecentStageJobState>({ kind: 'loading' })
  const [recentReload, setRecentReload] = useState(0)
  const [confirmed, setConfirmed] = useState(false)
  const [loading, setLoading] = useState(false)
  const [applying, setApplying] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [queueOutcomeUnknown, setQueueOutcomeUnknown] = useState(false)
  const jobRequestGeneration = useRef(0)

  useEffect(() => {
    const generation = ++jobRequestGeneration.current
    let cancelled = false
    setRecentStageJob({ kind: 'loading' })
    void loadJson(
      `/api/catalog/inventory/trade-samples/recent-stage-job?siteDealerId=${siteDealerId}`,
      TradeSampleRecentStageJobResponseSchema,
    ).then((response) => {
      if (cancelled || generation !== jobRequestGeneration.current) return
      setRecentStageJob(response.stageJob
        ? { kind: 'known', jobId: response.stageJob.job.jobId, status: response.stageJob, statusUnavailable: false }
        : { kind: 'none' })
    }).catch(() => {
      if (!cancelled && generation === jobRequestGeneration.current) setRecentStageJob({ kind: 'load_error' })
    })
    return () => {
      cancelled = true
    }
  }, [recentReload, siteDealerId])

  useEffect(() => {
    if (
      recentStageJob.kind !== 'known'
      || (recentStageJob.status && isJobTerminal(recentStageJob.status.job.status))
    ) return
    const generation = jobRequestGeneration.current
    const jobId = recentStageJob.jobId
    let cancelled = false
    const timeoutId = window.setTimeout(() => {
      void loadJobStatus(jobId).then((status) => {
        if (cancelled || generation !== jobRequestGeneration.current) return
        setRecentStageJob((current) => current.kind === 'known' && current.jobId === jobId
          ? { ...current, status, statusUnavailable: false }
          : current)
      }).catch(() => {
        if (cancelled || generation !== jobRequestGeneration.current) return
        setRecentStageJob((current) => current.kind === 'known' && current.jobId === jobId
          ? { ...current, statusUnavailable: true }
          : current)
      })
    }, JOB_POLL_MS)
    return () => {
      cancelled = true
      window.clearTimeout(timeoutId)
    }
  }, [recentStageJob])

  async function handlePreview(): Promise<void> {
    setLoading(true)
    setPreview(null)
    setConfirmed(false)
    setError(null)
    setQueueOutcomeUnknown(false)
    try {
      const response = await mutateJson(
        '/api/catalog/inventory/trade-samples/preview-zero',
        TradeSampleZeroPreviewResponseSchema,
        { method: 'POST', body: JSON.stringify({ siteDealerId }) },
      )
      if (response.siteDealerId !== siteDealerId) {
        setError('The preview was for a different site. Preview again before continuing.')
        return
      }
      setPreview(response)
    } catch (caught) {
      setError(requestError(caught, 'Could not load the trade sample preview.'))
    } finally {
      setLoading(false)
    }
  }

  async function handleApply(): Promise<void> {
    if (!preview || preview.items.length === 0 || !confirmed) return
    const reviewed = preview
    setApplying(true)
    setPreview(null)
    setConfirmed(false)
    setError(null)
    setQueueOutcomeUnknown(false)
    try {
      const response = await mutateJson(
        '/api/catalog/inventory/trade-samples/apply-zero',
        TradeSampleZeroEnqueueResponseSchema,
        {
          method: 'POST',
          body: JSON.stringify({
            siteDealerId: reviewed.siteDealerId,
            digest: reviewed.digest,
            previewId: reviewed.previewId,
            previewToken: reviewed.previewToken,
            items: reviewed.items,
            destination: reviewed.destination,
            confirmed: true,
          }),
        },
      )
      jobRequestGeneration.current += 1
      setRecentStageJob({ kind: 'known', jobId: response.jobId, status: null, statusUnavailable: false })
    } catch (caught) {
      const knownRejected = caught instanceof HttpResponseError && caught.status === 409
      setQueueOutcomeUnknown(!knownRejected)
      setError(knownRejected
        ? 'This preview is stale or was already used with different data. Nothing was retried. Create a fresh preview before applying.'
        : 'The queue request outcome is unknown. Do not retry this preview; check recent jobs before creating a fresh preview.')
    } finally {
      setApplying(false)
    }
  }

  const previewBlockedByJobState = recentStageJob.kind === 'loading'
    || recentStageJob.kind === 'load_error'
    || (recentStageJob.kind === 'known'
      && (!recentStageJob.status || !isJobTerminal(recentStageJob.status.job.status)))
  const terminalFailure = recentStageJob.kind === 'known'
    && recentStageJob.status !== null
    && (recentStageJob.status.job.status === 'failed' || recentStageJob.status.job.status === 'dead_letter')

  return <section>
    <div className="page-header">
      <div>
        <p className="eyebrow">Catalog &amp; Inventory / Inventory</p>
        <h2>Trade samples</h2>
      </div>
    </div>

    <article className="mini-card">
      <label htmlFor="trade-sample-site"><strong>Site</strong></label>
      <select
        id="trade-sample-site"
        value={siteDealerId}
        disabled={loading || applying}
        onChange={(event) => {
          jobRequestGeneration.current += 1
          setSiteDealerId(Number(event.target.value))
          setRecentStageJob({ kind: 'loading' })
          setPreview(null)
          setConfirmed(false)
          setError(null)
          setQueueOutcomeUnknown(false)
        }}
        style={{ display: 'block', margin: '0.5rem 0', minHeight: '2.75rem', width: 'min(100%, 24rem)' }}
      >
        {HELIOS_PENDING_PURCHASE_SITE_DEALERS.map((site) =>
          <option key={site.dealerId} value={site.dealerId}>{site.siteLabel}</option>)}
      </select>
      <RecentStageJobCard
        state={recentStageJob}
        onRetry={() => setRecentReload((value) => value + 1)}
      />
      <button className="primary-button" type="button" disabled={loading || applying || previewBlockedByJobState} onClick={() => void handlePreview()}>
        {loading ? 'Loading preview…' : terminalFailure ? 'Create fresh preview' : 'Preview trade samples'}
      </button>
    </article>

    {error ? <p className="error-copy" role="alert">{error}</p> : null}
    {queueOutcomeUnknown ? <p><Link to="/jobs">Check recent jobs</Link> before taking further action.</p> : null}
    {loading ? <p role="status">Loading packages…</p> : null}
    {applying ? <p role="status">Queueing the reviewed adjustment. The preview is disarmed; do not retry.</p> : null}

    {preview ? <article className="mini-card">
      <header><strong>Reviewed preview</strong></header>
      {preview.items.length === 0 ? <p role="status">No trade sample packages with quantity to reduce at this site.</p> : <>
        <TradeSampleScopeSummary destination={preview.destination} itemKind="reviewed source rows" items={preview.items} showSource siteDealerId={preview.siteDealerId} />
        <p>This step only transfers this exact reviewed set for physical inspection. It does not zero inventory.</p>
        <label className="trade-sample-confirmation" htmlFor="trade-sample-confirmation">
          <input id="trade-sample-confirmation" type="checkbox" checked={confirmed} disabled={applying}
            onChange={(event) => setConfirmed(event.target.checked)} />
          <span>I confirm this is the exact reviewed product, Metrc-tag, and quantity set to move for physical inspection.</span>
        </label>
        <button className="danger-button" type="button"
          disabled={applying || loading || !confirmed}
          onClick={() => void handleApply()}>Queue staging transfer</button>
      </>}
    </article> : null}

  </section>
}

function RecentStageJobCard({ state, onRetry }: { state: RecentStageJobState; onRetry: () => void }) {
  if (state.kind === 'loading') return <p role="status">Checking the latest staging job…</p>
  if (state.kind === 'load_error') return <div className="mini-card" role="alert">
    <p>Latest staging status could not be loaded. Preview is paused until job status is known.</p>
    <div className="inline-row wrap-row">
      <button className="ghost-button" type="button" onClick={onRetry}>Retry status</button>
      <Link className="ghost-button like-button" to="/jobs?jobType=catalog.inventory.stage_trade_samples">Open staging jobs</Link>
    </div>
  </div>
  if (state.kind === 'none') return <p className="subtle-copy">
    No staging job is tracked for this site yet.{' '}
    <Link to="/jobs?jobType=catalog.inventory.stage_trade_samples">Open older staging jobs</Link>
  </p>

  const status = state.status?.job.status
  const terminal = status ? isJobTerminal(status) : false
  const linkLabel = status === 'succeeded'
    ? `Inspect staged packages in job #${state.jobId}`
    : `Open staging job #${state.jobId}`
  return <div className="mini-card" role="status">
    <div className="inline-row wrap-row" style={{ justifyContent: 'space-between' }}>
      <div>
        <strong>Latest staging job</strong>
        {state.status ? <div className="subtle-copy">
          {terminal && state.status.job.finishedAt
            ? `Finished ${nyLongDateTime(Date.parse(state.status.job.finishedAt))}`
            : `Queued ${nyLongDateTime(Date.parse(state.status.job.createdAt))}`}
        </div> : null}
      </div>
      <Pill tone={jobTone(status)}>{status?.replaceAll('_', ' ') ?? 'status loading'}</Pill>
      <Link className="ghost-button like-button" to={`/jobs/${state.jobId}`}>{linkLabel}</Link>
    </div>
    {state.statusUnavailable ? <p className="subtle-copy">Status unavailable; retrying automatically.</p> : null}
    {state.status?.job.lastError ? <p className="error-copy" style={{ overflowWrap: 'anywhere' }}>{state.status.job.lastError}</p> : null}
    {status === 'succeeded' ? <p>Inspect the staged packages before approving any permanent zeroing in the job.</p> : null}
  </div>
}

function jobTone(status: JobStatusResponse['job']['status'] | undefined): 'danger' | 'muted' | 'success' | 'warning' {
  if (status === 'succeeded') return 'success'
  if (status === 'failed' || status === 'dead_letter') return 'danger'
  if (status === 'running') return 'warning'
  return 'muted'
}

function requestError(caught: unknown, fallback: string): string {
  return fallback
}
