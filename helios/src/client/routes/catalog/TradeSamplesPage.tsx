import { useState } from 'react'
import { Link } from 'react-router-dom'

import {
  HELIOS_PENDING_PURCHASE_SITE_DEALERS,
  TRADE_SAMPLE_STAGE_CONFIRMATION,
  TradeSampleZeroEnqueueResponseSchema,
  TradeSampleZeroPreviewResponseSchema,
  type TradeSampleZeroPreviewResponse,
} from '../../../shared/contracts/index.js'
import { HttpResponseError, mutateJson } from '../../app/fetchJson.js'
import { useRegisterCatalogSidebarSubtree } from './catalogSidebarSubtree.js'
import { TradeSampleScopeSummary } from './TradeSampleScopeSummary.js'

const CONFIRMATION = TRADE_SAMPLE_STAGE_CONFIRMATION

export function TradeSamplesPage() {
  useRegisterCatalogSidebarSubtree()
  const [siteDealerId, setSiteDealerId] = useState<number>(HELIOS_PENDING_PURCHASE_SITE_DEALERS[0].dealerId)
  const [preview, setPreview] = useState<TradeSampleZeroPreviewResponse | null>(null)
  const [queuedJobId, setQueuedJobId] = useState<number | null>(null)
  const [confirmation, setConfirmation] = useState('')
  const [loading, setLoading] = useState(false)
  const [applying, setApplying] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [queueOutcomeUnknown, setQueueOutcomeUnknown] = useState(false)

  async function handlePreview(): Promise<void> {
    setLoading(true)
    setPreview(null)
    setQueuedJobId(null)
    setConfirmation('')
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
    if (!preview || preview.items.length === 0 || confirmation !== CONFIRMATION) return
    const reviewed = preview
    setApplying(true)
    setPreview(null)
    setConfirmation('')
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
            confirmation: CONFIRMATION,
          }),
        },
      )
      setQueuedJobId(response.jobId)
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
          setSiteDealerId(Number(event.target.value))
          setPreview(null)
          setQueuedJobId(null)
          setConfirmation('')
          setError(null)
          setQueueOutcomeUnknown(false)
        }}
        style={{ display: 'block', margin: '0.5rem 0', minHeight: '2.75rem', width: 'min(100%, 24rem)' }}
      >
        {HELIOS_PENDING_PURCHASE_SITE_DEALERS.map((site) =>
          <option key={site.dealerId} value={site.dealerId}>{site.siteLabel}</option>)}
      </select>
      <button className="primary-button" type="button" disabled={loading || applying} onClick={() => void handlePreview()}>
        {loading ? 'Loading preview…' : 'Preview trade samples'}
      </button>
    </article>

    {error ? <p className="error-copy" role="alert">{error}</p> : null}
    {queueOutcomeUnknown ? <p><Link to="/jobs">Check recent jobs</Link> before taking further action.</p> : null}
    {loading ? <p role="status">Loading packages…</p> : null}
    {applying ? <p role="status">Queueing the reviewed adjustment. The preview is disarmed; do not retry.</p> : null}

    {preview ? <article className="mini-card">
      <header><strong>Reviewed preview</strong></header>
      {preview.items.length === 0 ? <p role="status">No trade sample packages with quantity to reduce at this site.</p> : <>
        <TradeSampleScopeSummary destination={preview.destination} items={preview.items} showSource siteDealerId={preview.siteDealerId} />
        <p>This step only transfers this exact reviewed set for physical inspection. It does not zero inventory.</p>
        <label htmlFor="trade-sample-confirmation">Type <strong>{CONFIRMATION}</strong> to confirm</label>
        <input id="trade-sample-confirmation" value={confirmation} disabled={applying} autoComplete="off"
          onChange={(event) => setConfirmation(event.target.value)}
          style={{ display: 'block', margin: '0.5rem 0', minHeight: '2.75rem', width: 'min(100%, 24rem)' }} />
        <button className="danger-button" type="button"
          disabled={applying || loading || confirmation !== CONFIRMATION}
          onClick={() => void handleApply()}>Queue staging transfer</button>
      </>}
    </article> : null}

    {queuedJobId ? <article className="mini-card" role="status">
      <header><strong><Link to={`/jobs/${queuedJobId}`}>Queued job #{queuedJobId}</Link></strong></header>
      <p>Open the stage job after completion. Zeroing requires a separate inspection and exact approval there.</p>
    </article> : null}
  </section>
}

function requestError(caught: unknown, fallback: string): string {
  return fallback
}
