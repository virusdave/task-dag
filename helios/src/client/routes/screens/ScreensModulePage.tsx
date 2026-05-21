import { useEffect, useMemo, useState } from 'react'
import { Link, useLoaderData, useRevalidator, useRouteLoaderData } from 'react-router-dom'

import {
  HELIOS_MODULES,
  HELIOS_SCREENS_BRONX_TO_MIDTOWN_IMAGE_FALLBACK_BANNER_NAMES,
  HELIOS_SCREENS_MIDTOWN_SITE_DEALER_ID,
  HELIOS_SCREENS_PRICED_TO_MOVE_PROMO_ACTIONS,
  HELIOS_SCREENS_SITE_DEALERS,
  HistoryEventsResponseSchema,
  JobsResponseSchema,
  MutationAcceptedResponseSchema,
  SCREENS_BANNER_BOUNCE_DEFAULT_HOLD_SECONDS,
  buildHeliosModulePath,
  getHeliosModuleDefinition,
  type HistoryEventsResponse,
  type JobStatusResponse,
  type JobsResponse,
  type SessionEnvelope,
} from '../../../shared/contracts/index.js'
import { isJobTerminal, loadJobStatus } from '../../app/jobPolling.js'
import { loadJson, mutateJson } from '../../app/fetchJson.js'
import { Pill } from '../../components/Pill.js'

const moduleLabelByCode = new Map(HELIOS_MODULES.map((module) => [module.code, module.label]))
const screensModule = getHeliosModuleDefinition('screens')
const bronxMidtownCloneBannerLabel = HELIOS_SCREENS_BRONX_TO_MIDTOWN_IMAGE_FALLBACK_BANNER_NAMES.join(', ')
const pricedToMovePromoActionLabel = HELIOS_SCREENS_PRICED_TO_MOVE_PROMO_ACTIONS
  .map((action) => `${action.bannerName} -> ${action.actionName}`)
  .join(', ')
const midtownDealerLabel = HELIOS_SCREENS_SITE_DEALERS.find(
  (dealer) => dealer.dealerId === HELIOS_SCREENS_MIDTOWN_SITE_DEALER_ID,
)?.dealerName ?? 'Freshly Baked NYC - Midtown'

type ScreensSubmissionKey =
  | 'banner_apply'
  | 'banner_dry_run'
  | 'bounce_apply'
  | 'bounce_dry_run'
  | 'maintenance_apply'
  | 'maintenance_dry_run'
  | 'healthy_apply'
  | 'healthy_dry_run'
  | 'clone_apply'
  | 'clone_dry_run'
  | 'move_apply'
  | 'move_dry_run'

interface ScreensModuleLoaderData {
  history: HistoryEventsResponse
  jobs: JobsResponse
}

export async function screensModuleLoader(): Promise<ScreensModuleLoaderData> {
  const [jobs, history] = await Promise.all([
    loadJson('/api/jobs?module=screens&pageSize=6', JobsResponseSchema),
    loadJson('/api/history/events?module=screens&pageSize=6', HistoryEventsResponseSchema),
  ])

  return { history, jobs }
}

export function ScreensModulePage() {
  const data = useLoaderData() as ScreensModuleLoaderData
  const session = useRouteLoaderData('root') as SessionEnvelope
  const revalidator = useRevalidator()
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [reason, setReason] = useState('')
  const [selectedDealerIds, setSelectedDealerIds] = useState<number[]>([])
  const [submittingAction, setSubmittingAction] = useState<ScreensSubmissionKey | null>(null)
  const [holdSeconds, setHoldSeconds] = useState<number>(SCREENS_BANNER_BOUNCE_DEFAULT_HOLD_SECONDS)
  const [activeBounceJob, setActiveBounceJob] = useState<JobStatusResponse | null>(null)
  const canQueueScreensWorkflows = session.permissions.canEditProposals

  useEffect(() => {
    if (!activeBounceJob) return
    if (isJobTerminal(activeBounceJob.job.status)) return

    let cancelled = false
    let timeoutId: number | undefined

    const poll = async () => {
      try {
        const next = await loadJobStatus(activeBounceJob.job.jobId)
        if (cancelled) return
        setActiveBounceJob(next)
        if (!isJobTerminal(next.job.status)) {
          timeoutId = window.setTimeout(() => void poll(), 1500)
        } else {
          void revalidator.revalidate()
        }
      } catch {
        if (!cancelled) {
          timeoutId = window.setTimeout(() => void poll(), 3000)
        }
      }
    }

    timeoutId = window.setTimeout(() => void poll(), 1500)
    return () => {
      cancelled = true
      if (timeoutId !== undefined) window.clearTimeout(timeoutId)
    }
  }, [activeBounceJob, revalidator])

  const selectedDealerLabel = useMemo(() => {
    if (selectedDealerIds.length === 0) {
      return 'All configured screens sites'
    }

    return HELIOS_SCREENS_SITE_DEALERS
      .filter((dealer) => selectedDealerIds.includes(dealer.dealerId))
      .map((dealer) => dealer.dealerName)
      .join(', ')
  }, [selectedDealerIds])

  async function queueBannerRefresh(apply: boolean) {
    await queueScreensJob({
      body: {
        apply,
        reason: reason.trim() || null,
        siteDealerIds: selectedDealerIds,
      },
      confirmMessage: apply ? `Queue a live screens banner refresh for ${selectedDealerLabel}?` : null,
      endpoint: '/api/screens/banner-refresh',
      failureMessage: 'Could not queue the screens banner refresh.',
      submittingKey: apply ? 'banner_apply' : 'banner_dry_run',
      successMessage: (jobId) => (
        apply
          ? `Queued live banner refresh as job #${jobId}.`
          : `Queued dry-run banner refresh as job #${jobId}.`
      ),
    })
  }

  async function queueBannerBounce(apply: boolean) {
    const effectiveHold = Math.max(0, Math.min(300, Math.round(holdSeconds)))
    const jobId = await queueScreensJob({
      body: {
        apply,
        holdSeconds: effectiveHold,
        intent: 'bounce',
        reason: reason.trim() || null,
        siteDealerIds: selectedDealerIds,
      },
      confirmMessage: apply
        ? `Queue a live ${effectiveHold}-second banner/screen bounce for ${selectedDealerLabel}? You will be paged when it finishes.`
        : null,
      endpoint: '/api/screens/banner-refresh',
      failureMessage: 'Could not queue the banner/screen bounce.',
      submittingKey: apply ? 'bounce_apply' : 'bounce_dry_run',
      successMessage: (id) => (
        apply
          ? `Queued live ${effectiveHold}-second bounce as job #${id}.`
          : `Queued dry-run bounce as job #${id}.`
      ),
    })

    if (jobId !== null) {
      try {
        const initial = await loadJobStatus(jobId)
        setActiveBounceJob(initial)
      } catch {
        // ignore; the user can still open /jobs/:jobId from the success notice
      }
    }
  }

  async function queueBronxMidtownImageClone(apply: boolean) {
    await queueScreensJob({
      body: {
        apply,
        reason: reason.trim() || null,
      },
      confirmMessage: apply ? `Queue a live Bronx-to-Midtown image fallback clone across all ${midtownDealerLabel} screens?` : null,
      endpoint: '/api/screens/bronx-midtown-image-clone',
      failureMessage: 'Could not queue the Bronx-to-Midtown image fallback clone.',
      submittingKey: apply ? 'clone_apply' : 'clone_dry_run',
      successMessage: (jobId) => (
        apply
          ? `Queued live Bronx-to-Midtown image fallback clone as job #${jobId}.`
          : `Queued dry-run Bronx-to-Midtown image fallback clone as job #${jobId}.`
      ),
    })
  }

  async function queueBannerHealthMaintenance(apply: boolean) {
    await queueScreensJob({
      body: {
        apply,
        reason: reason.trim() || null,
        siteDealerIds: selectedDealerIds,
      },
      confirmMessage: apply ? `Queue a live banner-health maintenance run for ${selectedDealerLabel}?` : null,
      endpoint: '/api/screens/banner-health-maintenance',
      failureMessage: 'Could not queue the banner-health maintenance run.',
      submittingKey: apply ? 'maintenance_apply' : 'maintenance_dry_run',
      successMessage: (jobId) => (
        apply
          ? `Queued live banner-health maintenance as job #${jobId}.`
          : `Queued dry-run banner-health maintenance as job #${jobId}.`
      ),
    })
  }

  async function queueEnableHealthyBanners(apply: boolean) {
    await queueScreensJob({
      body: {
        apply,
        reason: reason.trim() || null,
        siteDealerIds: selectedDealerIds,
      },
      confirmMessage: apply ? `Queue a live healthy-banner enable sweep for ${selectedDealerLabel}?` : null,
      endpoint: '/api/screens/enable-healthy-banners',
      failureMessage: 'Could not queue the healthy-banner enable sweep.',
      submittingKey: apply ? 'healthy_apply' : 'healthy_dry_run',
      successMessage: (jobId) => (
        apply
          ? `Queued live healthy-banner enable sweep as job #${jobId}.`
          : `Queued dry-run healthy-banner enable sweep as job #${jobId}.`
      ),
    })
  }

  async function queueMidtownPricedToMovePromoRebind(apply: boolean) {
    await queueScreensJob({
      body: {
        apply,
        reason: reason.trim() || null,
      },
      confirmMessage: apply ? `Queue a live Midtown Priced to MOVE promo rebind across all ${midtownDealerLabel} screens?` : null,
      endpoint: '/api/screens/midtown-priced-to-move-promo-rebind',
      failureMessage: 'Could not queue the Midtown Priced to MOVE promo rebind.',
      submittingKey: apply ? 'move_apply' : 'move_dry_run',
      successMessage: (jobId) => (
        apply
          ? `Queued live Midtown Priced to MOVE promo rebind as job #${jobId}.`
          : `Queued dry-run Midtown Priced to MOVE promo rebind as job #${jobId}.`
      ),
    })
  }

  async function queueScreensJob({
    body,
    confirmMessage,
    endpoint,
    failureMessage,
    submittingKey,
    successMessage,
  }: {
    body: Record<string, unknown>
    confirmMessage: string | null
    endpoint: string
    failureMessage: string
    submittingKey: ScreensSubmissionKey
    successMessage: (jobId: number) => string
  }): Promise<number | null> {
    if (confirmMessage && !window.confirm(confirmMessage)) {
      return null
    }

    setErrorMessage(null)
    setNotice(null)
    setSubmittingAction(submittingKey)
    try {
      const response = await mutateJson(endpoint, MutationAcceptedResponseSchema, {
        body: JSON.stringify(body),
        method: 'POST',
      })
      if (!response.jobId) {
        throw new Error('The screens workflow was accepted without a queued job id.')
      }
      setNotice(successMessage(response.jobId))
      void revalidator.revalidate()
      return response.jobId
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : failureMessage)
      return null
    } finally {
      setSubmittingAction(null)
    }
  }

  function toggleDealerSelection(dealerId: number) {
    setSelectedDealerIds((current) => (
      current.includes(dealerId)
        ? current.filter((candidate) => candidate !== dealerId)
        : [...current, dealerId].sort((left, right) => left - right)
    ))
  }

  return (
    <section>
      <div className="page-header">
        <div>
          <p className="eyebrow">Screens Module</p>
          <h2>Operate screen workflows without leaving Helios</h2>
          <p className="subtle-copy">{screensModule.summary}</p>
        </div>
        <Pill tone="success">live</Pill>
      </div>

      {notice ? <p className="subtle-copy">{notice}</p> : null}
      {errorMessage ? <p className="error-text">{errorMessage}</p> : null}

      {activeBounceJob ? <BounceProgressCard data={activeBounceJob} onDismiss={() => setActiveBounceJob(null)} /> : null}

      <div className="review-grid" style={{ marginBottom: '1rem' }}>
        <article className="mini-card" style={{ borderLeft: '4px solid #2563eb' }}>
          <header>
            <strong>Queue 30-second banner/screen bounce</strong>
            <Pill tone={canQueueScreensWorkflows ? 'success' : 'muted'}>{canQueueScreensWorkflows ? 'editor' : 'view only'}</Pill>
          </header>
          <p className="subtle-copy">
            Run the safe screen-level bounce in parallel across the targeted batch: turn all banners off, turn the screens off,
            hold for the chosen window, turn banners back on (zero-duration banners stay disabled), then bring screens back up.
            Dave is paged when the bounce finishes.
          </p>
          <div className="stacked-list compact-stack" style={{ marginTop: '0.9rem' }}>
            {HELIOS_SCREENS_SITE_DEALERS.map((dealer) => (
              <label className="dealer-toggle" key={`bounce-${dealer.dealerId}`}>
                <input
                  checked={selectedDealerIds.includes(dealer.dealerId)}
                  disabled={!canQueueScreensWorkflows || submittingAction !== null}
                  onChange={() => toggleDealerSelection(dealer.dealerId)}
                  type="checkbox"
                />
                <span>{dealer.dealerName}</span>
              </label>
            ))}
          </div>
          <div className="stack-field" style={{ marginTop: '0.9rem' }}>
            <span>Shared off-window (seconds)</span>
            <input
              disabled={!canQueueScreensWorkflows || submittingAction !== null}
              max={300}
              min={0}
              onChange={(event) => {
                const next = Number.parseInt(event.target.value, 10)
                setHoldSeconds(Number.isFinite(next) ? next : 0)
              }}
              step={5}
              type="number"
              value={holdSeconds}
            />
          </div>
          <div className="stack-field" style={{ marginTop: '0.9rem' }}>
            <span>Run note</span>
            <textarea
              disabled={!canQueueScreensWorkflows || submittingAction !== null}
              onChange={(event) => setReason(event.target.value)}
              placeholder="Optional operator note for the audit trail"
              rows={3}
              value={reason}
            />
          </div>
          <p className="subtle-copy">Target: {selectedDealerLabel}</p>
          <div className="inline-row wrap-row module-card-links">
            <button
              className="ghost-button"
              disabled={!canQueueScreensWorkflows || submittingAction !== null}
              onClick={() => void queueBannerBounce(false)}
              type="button"
            >
              {submittingAction === 'bounce_dry_run' ? 'Queueing dry-run…' : 'Queue dry-run'}
            </button>
            <button
              className="primary-button"
              disabled={!canQueueScreensWorkflows || submittingAction !== null}
              onClick={() => void queueBannerBounce(true)}
              type="button"
            >
              {submittingAction === 'bounce_apply' ? 'Queueing live bounce…' : 'Queue live bounce'}
            </button>
          </div>
        </article>
      </div>

      <div className="review-grid" style={{ marginBottom: '1rem' }}>
        <article className="mini-card">
          <header>
            <strong>Safe refresh pattern</strong>
            <Pill tone="warning">screen-level</Pill>
          </header>
          <p className="subtle-copy">
            Helios runs the documented screen sequence: banners off, screen off, banners back on, then keeps zero-duration
            rows disabled before bringing the screen back online.
          </p>
          <div className="inline-row wrap-row module-card-links">
            <Link to="/jobs?module=screens">Open screens jobs</Link>
            <Link to="/history?module=screens">Open screens history</Link>
          </div>
        </article>

        <article className="mini-card">
          <header>
            <strong>Current pilot coverage</strong>
            <Pill tone="muted">module one</Pill>
          </header>
          <p className="subtle-copy">
            Banner refresh, the chained banner-health maintenance run, healthy-banner maintenance, the fixed Bronx-to-Midtown
            image fallback clone, both Midtown promo-rebinding playbooks, and the new selected-device image-banner sync now run through Helios jobs.
          </p>
          <div className="stacked-list compact-stack">
            <div className="mini-card-row">
              <div>
                <strong>Workflows</strong>
                <p className="subtle-copy">Cross-site refresh, chained maintenance, healthy-banner enable sweeps, the Midtown image-fallback clone, both promo rebinds, and the new device-level image sync now share one module.</p>
              </div>
              <Pill tone="muted">7 live</Pill>
            </div>
            <div className="mini-card-row">
              <div>
                <strong>Dealer scope</strong>
                <p className="subtle-copy">Refresh, chained maintenance, and healthy-banner sweeps can target Bronx and Midtown; the clone and both promo rebinds are fixed to Midtown screens.</p>
              </div>
              <Pill tone="muted">2 sites</Pill>
            </div>
            <div className="mini-card-row">
              <div>
                <strong>Dependencies</strong>
                <p className="subtle-copy">Both use the shared Sweed dependency gate, worker, queue, and append-only audit stream.</p>
              </div>
              <Pill tone="success">shared</Pill>
            </div>
            <div className="mini-card-row">
              <div>
                <strong>Devices surface</strong>
                <p className="subtle-copy">Browse the latest artifact-backed inventory, pick a source screen, and queue image-banner syncs across any selected target screen set.</p>
              </div>
              <Link to="/screens/devices">Open devices</Link>
            </div>
          </div>
        </article>

        <article className="mini-card">
          <header>
            <strong>Queue banner refresh</strong>
            <Pill tone={canQueueScreensWorkflows ? 'success' : 'muted'}>{canQueueScreensWorkflows ? 'editor' : 'view only'}</Pill>
          </header>
          <p className="subtle-copy">
            Scope the run to one site or leave every box unchecked to refresh both configured screens sites.
          </p>
          <div className="stacked-list compact-stack" style={{ marginTop: '0.9rem' }}>
            {HELIOS_SCREENS_SITE_DEALERS.map((dealer) => (
              <label className="dealer-toggle" key={dealer.dealerId}>
                <input
                  checked={selectedDealerIds.includes(dealer.dealerId)}
                  disabled={!canQueueScreensWorkflows || submittingAction !== null}
                  onChange={() => toggleDealerSelection(dealer.dealerId)}
                  type="checkbox"
                />
                <span>{dealer.dealerName}</span>
              </label>
            ))}
          </div>
          <div className="stack-field" style={{ marginTop: '0.9rem' }}>
            <span>Run note</span>
            <textarea
              disabled={!canQueueScreensWorkflows || submittingAction !== null}
              onChange={(event) => setReason(event.target.value)}
              placeholder="Optional operator note for the audit trail"
              rows={3}
              value={reason}
            />
          </div>
          <p className="subtle-copy">Target: {selectedDealerLabel}</p>
          <div className="inline-row wrap-row module-card-links">
            <button
              className="ghost-button"
              disabled={!canQueueScreensWorkflows || submittingAction !== null}
              onClick={() => void queueBannerRefresh(false)}
              type="button"
            >
              {submittingAction === 'banner_dry_run' ? 'Queueing dry-run…' : 'Queue dry-run'}
            </button>
            <button
              className="primary-button"
              disabled={!canQueueScreensWorkflows || submittingAction !== null}
              onClick={() => void queueBannerRefresh(true)}
              type="button"
            >
              {submittingAction === 'banner_apply' ? 'Queueing live apply…' : 'Queue live apply'}
            </button>
          </div>
        </article>

        <article className="mini-card">
          <header>
            <strong>Queue healthy-banner enable sweep</strong>
            <Pill tone={canQueueScreensWorkflows ? 'success' : 'muted'}>{canQueueScreensWorkflows ? 'editor' : 'view only'}</Pill>
          </header>
          <p className="subtle-copy">
            After a refresh or promo recovery, re-enable any banner that is currently disabled but already reads with a positive
            duration.
          </p>
          <div className="stack-field" style={{ marginTop: '0.9rem' }}>
            <span>Maintenance rule</span>
            <p className="subtle-copy">Only banners with live nonzero duration are targeted, and any row that rereads at zero stays disabled.</p>
          </div>
          <div className="stack-field" style={{ marginTop: '0.9rem' }}>
            <span>Run note</span>
            <textarea
              disabled={!canQueueScreensWorkflows || submittingAction !== null}
              onChange={(event) => setReason(event.target.value)}
              placeholder="Optional operator note for the audit trail"
              rows={3}
              value={reason}
            />
          </div>
          <p className="subtle-copy">Target: {selectedDealerLabel}</p>
          <div className="inline-row wrap-row module-card-links">
            <button
              className="ghost-button"
              disabled={!canQueueScreensWorkflows || submittingAction !== null}
              onClick={() => void queueEnableHealthyBanners(false)}
              type="button"
            >
              {submittingAction === 'healthy_dry_run' ? 'Queueing dry-run…' : 'Queue dry-run'}
            </button>
            <button
              className="primary-button"
              disabled={!canQueueScreensWorkflows || submittingAction !== null}
              onClick={() => void queueEnableHealthyBanners(true)}
              type="button"
            >
              {submittingAction === 'healthy_apply' ? 'Queueing live apply…' : 'Queue live apply'}
            </button>
          </div>
        </article>

        <article className="mini-card">
          <header>
            <strong>Queue banner-health maintenance</strong>
            <Pill tone={canQueueScreensWorkflows ? 'success' : 'muted'}>{canQueueScreensWorkflows ? 'editor' : 'view only'}</Pill>
          </header>
          <p className="subtle-copy">
            Run the documented maintenance cadence in one job: refresh every targeted screen first, then immediately re-enable
            any banner that now reads with a positive duration.
          </p>
          <div className="stack-field" style={{ marginTop: '0.9rem' }}>
            <span>Cadence</span>
            <p className="subtle-copy">This is the scheduler-ready hourly maintenance run, but it can also be queued manually from Helios today.</p>
          </div>
          <div className="stack-field" style={{ marginTop: '0.9rem' }}>
            <span>Run note</span>
            <textarea
              disabled={!canQueueScreensWorkflows || submittingAction !== null}
              onChange={(event) => setReason(event.target.value)}
              placeholder="Optional operator note for the audit trail"
              rows={3}
              value={reason}
            />
          </div>
          <p className="subtle-copy">Target: {selectedDealerLabel}</p>
          <div className="inline-row wrap-row module-card-links">
            <button
              className="ghost-button"
              disabled={!canQueueScreensWorkflows || submittingAction !== null}
              onClick={() => void queueBannerHealthMaintenance(false)}
              type="button"
            >
              {submittingAction === 'maintenance_dry_run' ? 'Queueing dry-run…' : 'Queue dry-run'}
            </button>
            <button
              className="primary-button"
              disabled={!canQueueScreensWorkflows || submittingAction !== null}
              onClick={() => void queueBannerHealthMaintenance(true)}
              type="button"
            >
              {submittingAction === 'maintenance_apply' ? 'Queueing live apply…' : 'Queue live apply'}
            </button>
          </div>
        </article>

        <article className="mini-card">
          <header>
            <strong>Queue image fallback clone</strong>
            <Pill tone={canQueueScreensWorkflows ? 'success' : 'muted'}>{canQueueScreensWorkflows ? 'editor' : 'view only'}</Pill>
          </header>
          <p className="subtle-copy">
            Clone the documented Bronx fallback set into every Midtown screen as image banners when the original promo-backed
            menus cannot be reused cross-site.
          </p>
          <div className="stack-field" style={{ marginTop: '0.9rem' }}>
            <span>Bronx source set</span>
            <p className="subtle-copy">{bronxMidtownCloneBannerLabel}</p>
          </div>
          <div className="stack-field" style={{ marginTop: '0.9rem' }}>
            <span>Run note</span>
            <textarea
              disabled={!canQueueScreensWorkflows || submittingAction !== null}
              onChange={(event) => setReason(event.target.value)}
              placeholder="Optional operator note for the audit trail"
              rows={3}
              value={reason}
            />
          </div>
          <p className="subtle-copy">Target: all {midtownDealerLabel} screens</p>
          <div className="inline-row wrap-row module-card-links">
            <button
              className="ghost-button"
              disabled={!canQueueScreensWorkflows || submittingAction !== null}
              onClick={() => void queueBronxMidtownImageClone(false)}
              type="button"
            >
              {submittingAction === 'clone_dry_run' ? 'Queueing dry-run…' : 'Queue dry-run'}
            </button>
            <button
              className="primary-button"
              disabled={!canQueueScreensWorkflows || submittingAction !== null}
              onClick={() => void queueBronxMidtownImageClone(true)}
              type="button"
            >
              {submittingAction === 'clone_apply' ? 'Queueing live apply…' : 'Queue live apply'}
            </button>
          </div>
        </article>

        <article className="mini-card">
          <header>
            <strong>Queue Priced to MOVE rebind</strong>
            <Pill tone={canQueueScreensWorkflows ? 'success' : 'muted'}>{canQueueScreensWorkflows ? 'editor' : 'view only'}</Pill>
          </header>
          <p className="subtle-copy">
            Replace the latest Midtown image fallback set for Priced to MOVE with the documented Velocity Boosters product-menu
            banners.
          </p>
          <div className="stack-field" style={{ marginTop: '0.9rem' }}>
            <span>Promo actions</span>
            <p className="subtle-copy">{pricedToMovePromoActionLabel}</p>
          </div>
          <div className="stack-field" style={{ marginTop: '0.9rem' }}>
            <span>Run note</span>
            <textarea
              disabled={!canQueueScreensWorkflows || submittingAction !== null}
              onChange={(event) => setReason(event.target.value)}
              placeholder="Optional operator note for the audit trail"
              rows={3}
              value={reason}
            />
          </div>
          <p className="subtle-copy">Target: all {midtownDealerLabel} screens</p>
          <div className="inline-row wrap-row module-card-links">
            <button
              className="ghost-button"
              disabled={!canQueueScreensWorkflows || submittingAction !== null}
              onClick={() => void queueMidtownPricedToMovePromoRebind(false)}
              type="button"
            >
              {submittingAction === 'move_dry_run' ? 'Queueing dry-run…' : 'Queue dry-run'}
            </button>
            <button
              className="primary-button"
              disabled={!canQueueScreensWorkflows || submittingAction !== null}
              onClick={() => void queueMidtownPricedToMovePromoRebind(true)}
              type="button"
            >
              {submittingAction === 'move_apply' ? 'Queueing live apply…' : 'Queue live apply'}
            </button>
          </div>
        </article>

      </div>

      <div className="review-grid">
        <article className="mini-card">
          <header>
            <strong>Recent screens jobs</strong>
            <Link to="/jobs?module=screens">See all</Link>
          </header>
          <div className="stacked-list compact-stack" style={{ marginTop: '0.9rem' }}>
            {data.jobs.items.map((job) => (
              <div className="mini-card-row" key={job.jobId}>
                <div>
                  <strong>{job.jobType}</strong>
                  <p className="subtle-copy">
                    {new Date(job.createdAt).toLocaleString()}
                    {job.scope ? ` · ${job.scope.entityType} ${job.scope.entityId}` : ' · all configured screens sites'}
                  </p>
                </div>
                <div className="inline-row wrap-row">
                  <Pill tone={statusTone(job.status)}>{job.status}</Pill>
                  {job.lastError ? <span className="error-text">failed</span> : null}
                </div>
              </div>
            ))}
            {data.jobs.items.length === 0 ? <p className="empty-state">No screens jobs have been queued yet.</p> : null}
          </div>
        </article>

        <article className="mini-card">
          <header>
            <strong>Recent screens audit events</strong>
            <Link to="/history?module=screens">See all</Link>
          </header>
          <div className="stacked-list compact-stack" style={{ marginTop: '0.9rem' }}>
            {data.history.items.map((event) => (
              <div className="mini-card-row" key={event.eventId}>
                <div>
                  <strong>{event.eventType}</strong>
                  <p className="subtle-copy">{new Date(event.createdAt).toLocaleString()} · {event.actorLabel}</p>
                  <p className="subtle-copy">{readEventSummary(event)}</p>
                  {readArtifactPath(event) ? <code>{readArtifactPath(event)}</code> : null}
                </div>
                <Pill tone="muted">{moduleLabelByCode.get(event.module) ?? event.module}</Pill>
              </div>
            ))}
            {data.history.items.length === 0 ? <p className="empty-state">No screens audit events have been recorded yet.</p> : null}
          </div>
        </article>

        <article className="mini-card">
          <header>
            <strong>Related module paths</strong>
            <Pill tone="muted">shared shell</Pill>
          </header>
          <p className="subtle-copy">
            Screens now lives in the same shell as Catalog and uses the shared queue and append-only audit stream instead of a
            one-off script surface.
          </p>
          <div className="inline-row wrap-row module-card-links">
            <Link to={buildHeliosModulePath('catalog')}>Catalog module</Link>
            <Link to="/jobs">Global jobs</Link>
            <Link to="/history">Global history</Link>
          </div>
        </article>
      </div>
    </section>
  )
}

function statusTone(status: JobsResponse['items'][number]['status']): 'danger' | 'muted' | 'success' | 'warning' {
  switch (status) {
    case 'succeeded':
      return 'success'
    case 'failed':
    case 'dead_letter':
      return 'danger'
    case 'queued':
    case 'running':
      return 'warning'
    default:
      return 'muted'
  }
}

function readEventSummary(event: HistoryEventsResponse['items'][number]): string {
  const payload = event.payload
  if (payload && typeof payload === 'object' && !Array.isArray(payload) && typeof payload.summary === 'string') {
    return payload.summary
  }

  return event.summaryText
}

function readArtifactPath(event: HistoryEventsResponse['items'][number]): string | null {
  const payload = event.payload
  if (payload && typeof payload === 'object' && !Array.isArray(payload) && typeof payload.artifactPath === 'string') {
    return payload.artifactPath
  }

  return null
}

function computeBouncePercent(data: JobStatusResponse): number {
  if (data.job.status === 'succeeded') return 100
  if (data.job.status === 'failed' || data.job.status === 'dead_letter') return 100
  if (!data.progress) return data.job.status === 'queued' ? 8 : 25
  const phaseCount = data.progress.phaseCount ?? 5
  const phaseIndex = data.progress.phaseIndex ?? 1
  const base = ((phaseIndex - 1) / phaseCount) * 100
  return Math.max(5, Math.min(99, Math.round(base + 100 / phaseCount / 2)))
}

function BounceProgressCard({ data, onDismiss }: { data: JobStatusResponse; onDismiss: () => void }) {
  const percent = computeBouncePercent(data)
  const terminal = isJobTerminal(data.job.status)
  const startedAt = data.job.startedAt ? new Date(data.job.startedAt).getTime() : null
  const finishedAt = data.job.finishedAt ? new Date(data.job.finishedAt).getTime() : null
  const elapsedSeconds = startedAt ? Math.round(((finishedAt ?? Date.now()) - startedAt) / 1000) : null

  const tone: 'success' | 'warning' | 'danger' | 'muted' =
    data.job.status === 'succeeded'
      ? 'success'
      : data.job.status === 'failed' || data.job.status === 'dead_letter'
        ? 'danger'
        : data.job.status === 'queued' || data.job.status === 'running'
          ? 'warning'
          : 'muted'
  const failed = data.job.status === 'failed' || data.job.status === 'dead_letter'

  return (
    <article className="detail-panel" style={{ marginBottom: '1rem', borderLeft: '4px solid #2563eb' }}>
      <div className="page-header" style={{ marginBottom: '0.5rem' }}>
        <div>
          <strong>Bounce job #{data.job.jobId}</strong>
          <p className="subtle-copy">{data.progress?.message ?? data.job.status}</p>
        </div>
        <div className="inline-row wrap-row">
          <Pill tone={tone}>{data.job.status.replaceAll('_', ' ')}</Pill>
          <Link className="ghost-button like-button" to={`/jobs/${data.job.jobId}`}>Open full job details</Link>
          {terminal ? (
            <button className="ghost-button" onClick={onDismiss} type="button">Dismiss</button>
          ) : null}
        </div>
      </div>
      <div className="job-progress-track" aria-hidden="true">
        <div
          className={`job-progress-fill${failed ? ' failed' : ''}`}
          style={{ width: `${percent}%` }}
        />
      </div>
      <div className="pricing-metric-grid" style={{ marginTop: '0.75rem' }}>
        <div className="value-panel">
          <span>Phase</span>
          <p>{data.progress ? `${data.progress.phase} (${data.progress.phaseIndex}/${data.progress.phaseCount})` : '—'}</p>
        </div>
        <div className="value-panel">
          <span>Elapsed</span>
          <p>{elapsedSeconds !== null ? `${elapsedSeconds}s` : '—'}</p>
        </div>
        <div className="value-panel">
          <span>Status</span>
          <p>{data.job.status.replaceAll('_', ' ')}</p>
        </div>
      </div>
      {data.job.lastError ? <p className="error-text">{data.job.lastError}</p> : null}
    </article>
  )
}
