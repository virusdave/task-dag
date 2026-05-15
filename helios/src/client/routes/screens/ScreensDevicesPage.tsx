import { useEffect, useMemo, useState } from 'react'
import { Link, useLoaderData, useRouteLoaderData } from 'react-router-dom'

import {
  MutationAcceptedResponseSchema,
  QueueScreensImageBannerSyncRequestSchema,
  ScreensInventoryResponseSchema,
  type QueueScreensImageBannerSyncRequest,
  type ScreensInventoryBanner,
  type ScreensInventoryResponse,
  type SessionEnvelope,
} from '../../../shared/contracts/index.js'
import { loadJson, mutateJson } from '../../app/fetchJson.js'
import { Pill } from '../../components/Pill.js'

interface ScreenOption {
  banners: ScreensInventoryBanner[]
  dealerId: number
  dealerName: string
  screenId: number
  screenName: string
}

export async function screensDevicesLoader() {
  return loadJson('/api/screens/inventory', ScreensInventoryResponseSchema)
}

export function ScreensDevicesPage() {
  const data = useLoaderData() as ScreensInventoryResponse
  const session = useRouteLoaderData('root') as SessionEnvelope
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [reason, setReason] = useState('')
  const [sourceScreenKey, setSourceScreenKey] = useState('')
  const [selectedBannerIds, setSelectedBannerIds] = useState<string[]>([])
  const [selectedTargetKeys, setSelectedTargetKeys] = useState<string[]>([])
  const [submittingMode, setSubmittingMode] = useState<'apply' | 'dry_run' | null>(null)

  const screenOptions = useMemo<ScreenOption[]>(() => (
    data.sites.flatMap((site) => site.screens.map((screen) => ({
      banners: screen.banners,
      dealerId: site.dealerId,
      dealerName: site.dealerName,
      screenId: screen.screenId,
      screenName: screen.screenName,
    })))
  ), [data.sites])

  useEffect(() => {
    if (screenOptions.length === 0) {
      setSourceScreenKey('')
      return
    }

    if (screenOptions.some((screen) => toScreenKey(screen.dealerId, screen.screenId) === sourceScreenKey)) {
      return
    }

    const firstScreenWithImages = screenOptions.find((screen) => imageBanners(screen.banners).length > 0) ?? screenOptions[0]
    setSourceScreenKey(toScreenKey(firstScreenWithImages.dealerId, firstScreenWithImages.screenId))
  }, [screenOptions, sourceScreenKey])

  const selectedSourceScreen = useMemo(() => (
    screenOptions.find((screen) => toScreenKey(screen.dealerId, screen.screenId) === sourceScreenKey) ?? null
  ), [screenOptions, sourceScreenKey])

  const sourceImageBanners = useMemo(
    () => imageBanners(selectedSourceScreen?.banners ?? []),
    [selectedSourceScreen],
  )

  useEffect(() => {
    const validIds = new Set(sourceImageBanners.map((banner) => banner.bannerId))
    setSelectedBannerIds((current) => {
      const next = current.filter((bannerId) => validIds.has(bannerId))
      if (next.length > 0 || sourceImageBanners.length === 0) {
        return next
      }
      return [sourceImageBanners[0].bannerId]
    })
  }, [sourceImageBanners])

  const targetScreenOptions = useMemo(
    () => screenOptions.filter((screen) => toScreenKey(screen.dealerId, screen.screenId) !== sourceScreenKey),
    [screenOptions, sourceScreenKey],
  )

  useEffect(() => {
    const validTargetKeys = new Set(targetScreenOptions.map((screen) => toScreenKey(screen.dealerId, screen.screenId)))
    setSelectedTargetKeys((current) => current.filter((targetKey) => validTargetKeys.has(targetKey)))
  }, [targetScreenOptions])

  const canQueueSync = session.permissions.canEditProposals

  async function queueSync(apply: boolean) {
    if (!selectedSourceScreen) {
      return
    }

    setErrorMessage(null)
    setNotice(null)
    setSubmittingMode(apply ? 'apply' : 'dry_run')

    try {
      const payload = QueueScreensImageBannerSyncRequestSchema.parse({
        apply,
        reason: reason.trim() || null,
        sourceBannerIds: selectedBannerIds,
        sourceDealerId: selectedSourceScreen.dealerId,
        sourceScreenId: selectedSourceScreen.screenId,
        targetScreens: selectedTargetKeys.map(parseScreenKey),
      }) satisfies QueueScreensImageBannerSyncRequest

      const response = await mutateJson('/api/screens/image-banner-sync', MutationAcceptedResponseSchema, {
        body: JSON.stringify(payload),
        method: 'POST',
      })

      if (!response.jobId) {
        throw new Error('The image-banner sync was accepted without a queued job id.')
      }

      setNotice(
        apply
          ? `Queued live image-banner sync as job #${response.jobId}.`
          : `Queued dry-run image-banner sync as job #${response.jobId}.`,
      )
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Could not queue the image-banner sync.')
    } finally {
      setSubmittingMode(null)
    }
  }

  return (
    <section>
      <div className="page-header">
        <div>
          <p className="eyebrow">Screens Devices</p>
          <h2>Browse live screen inventory and sync image banners</h2>
          <p className="subtle-copy">
            This first management slice is artifact-backed for browsing and queues worker-driven image-banner syncs across selected devices.
          </p>
        </div>
        <div className="inline-row wrap-row">
          <Link to="/screens">Workflow landing</Link>
          <Link to="/jobs?module=screens">Screens jobs</Link>
          <Link to="/history?module=screens">Screens history</Link>
        </div>
      </div>

      {notice ? <p className="subtle-copy">{notice}</p> : null}
      {errorMessage ? <p className="error-text">{errorMessage}</p> : null}

      <div className="review-grid" style={{ marginBottom: '1rem' }}>
        <article className="mini-card">
          <header>
            <strong>Inventory source</strong>
            <Pill tone={data.inventorySource ? 'muted' : 'warning'}>{data.inventorySource ? 'artifact-backed' : 'missing'}</Pill>
          </header>
          {data.inventorySource ? (
            <>
              <p className="subtle-copy">
                {new Date(data.inventorySource.capturedAt).toLocaleString()} · {data.inventorySource.artifactKind.replaceAll('_', ' ')}
                {data.inventorySource.mode ? ` · ${data.inventorySource.mode.replace('_', ' ')}` : ''}
              </p>
              <p className="subtle-copy">{data.inventorySource.artifactPath}</p>
            </>
          ) : (
            <p className="subtle-copy">
              Queue a screens refresh from <Link to="/screens">the screens landing page</Link> to refresh the device snapshot Helios uses here.
            </p>
          )}
        </article>

        <article className="mini-card">
          <header>
            <strong>Current snapshot</strong>
            <Pill tone="success">{`${data.summary.screenCount} screens`}</Pill>
          </header>
          <p className="subtle-copy">
            {data.summary.bannerCount} banners · {data.summary.imageBannerCount} image banners · {data.summary.zeroDurationBannerCount} zero-duration banners
          </p>
          <p className="subtle-copy">
            Promo-backed product-menu banners still stay on the dedicated `/screens` workflows because Sweed promo actions are site-scoped.
          </p>
        </article>
      </div>

      <article className="mini-card" style={{ marginBottom: '1rem' }}>
        <header>
          <div>
            <strong>Image-banner sync</strong>
            <p className="subtle-copy">Copy static image-banner assignments from one source screen to any selected target device set.</p>
          </div>
          <Pill tone="warning">worker queued</Pill>
        </header>

        {selectedSourceScreen ? (
          <div className="stacked-list">
            <label className="stack-field">
              <span>Source screen</span>
              <select onChange={(event) => setSourceScreenKey(event.currentTarget.value)} value={sourceScreenKey}>
                {screenOptions.map((screen) => (
                  <option key={toScreenKey(screen.dealerId, screen.screenId)} value={toScreenKey(screen.dealerId, screen.screenId)}>
                    {screen.dealerName} · {screen.screenName}
                  </option>
                ))}
              </select>
            </label>

            <div>
              <p><strong>Source image banners</strong></p>
              {sourceImageBanners.length === 0 ? (
                <p className="empty-state">The selected source screen does not have image banners in the current snapshot.</p>
              ) : (
                <div className="stacked-list">
                  {sourceImageBanners.map((banner) => {
                    const checked = selectedBannerIds.includes(banner.bannerId)
                    return (
                      <label className="dealer-toggle" key={banner.bannerId}>
                        <input
                          checked={checked}
                          onChange={() => setSelectedBannerIds((current) => toggleValue(current, banner.bannerId))}
                          type="checkbox"
                        />
                        <span>
                          {banner.bannerName} · {formatDuration(banner.totalDuration)} · {banner.enabled ? 'enabled' : 'disabled'}
                        </span>
                      </label>
                    )
                  })}
                </div>
              )}
            </div>

            <div>
              <p><strong>Target screens</strong></p>
              <div className="review-grid">
                {data.sites.map((site) => (
                  <article className="mini-card" key={site.dealerId}>
                    <header>
                      <strong>{site.dealerName}</strong>
                      <Pill tone="muted">{`${site.screens.length} screens`}</Pill>
                    </header>
                    <div className="stacked-list">
                      {site.screens
                        .filter((screen) => toScreenKey(site.dealerId, screen.screenId) !== sourceScreenKey)
                        .map((screen) => {
                          const targetKey = toScreenKey(site.dealerId, screen.screenId)
                          return (
                            <label className="dealer-toggle" key={targetKey}>
                              <input
                                checked={selectedTargetKeys.includes(targetKey)}
                                onChange={() => setSelectedTargetKeys((current) => toggleValue(current, targetKey))}
                                type="checkbox"
                              />
                              <span>{screen.screenName}</span>
                            </label>
                          )
                        })}
                    </div>
                  </article>
                ))}
              </div>
            </div>

            <label className="stack-field">
              <span>Operator note</span>
              <textarea
                onChange={(event) => setReason(event.currentTarget.value)}
                placeholder="Optional note for why this banner sync is being queued."
                rows={3}
                value={reason}
              />
            </label>

            <div className="inline-row wrap-row">
              <Pill tone="muted">{`${selectedBannerIds.length} source banner(s)`}</Pill>
              <Pill tone="muted">{`${selectedTargetKeys.length} target screen(s)`}</Pill>
            </div>

            <div className="inline-row wrap-row">
              <button
                className="ghost-button"
                disabled={!canSubmitSync(canQueueSync, selectedBannerIds, selectedTargetKeys) || submittingMode !== null}
                onClick={() => void queueSync(false)}
                type="button"
              >
                {submittingMode === 'dry_run' ? 'Queueing dry run…' : 'Queue dry run'}
              </button>
              <button
                className="primary-button"
                disabled={!canSubmitSync(canQueueSync, selectedBannerIds, selectedTargetKeys) || submittingMode !== null}
                onClick={() => void queueSync(true)}
                type="button"
              >
                {submittingMode === 'apply' ? 'Queueing live sync…' : 'Queue live sync'}
              </button>
            </div>
          </div>
        ) : (
          <p className="empty-state">No screens are available in the current snapshot yet.</p>
        )}
      </article>

      {data.sites.length === 0 ? (
        <p className="empty-state">No screens inventory is available yet.</p>
      ) : (
        <div className="stacked-list">
          {data.sites.map((site) => (
            <article className="mini-card" key={site.dealerId}>
              <header>
                <strong>{site.dealerName}</strong>
                <Pill tone="muted">{`${site.screens.length} devices`}</Pill>
              </header>
              <div className="review-grid">
                {site.screens.map((screen) => (
                  <article className="review-card" key={`${site.dealerId}-${screen.screenId}`}>
                    <div className="review-card-header">
                      <div>
                        <strong>{screen.screenName}</strong>
                        <p className="subtle-copy">Screen #{screen.screenId}</p>
                      </div>
                      <div className="inline-row wrap-row">
                        <Pill tone={screen.screenEnabled === false ? 'warning' : 'success'}>
                          {screen.screenEnabled === false ? 'screen off' : 'screen on'}
                        </Pill>
                        <Pill tone="muted">{`${screen.banners.length} banners`}</Pill>
                      </div>
                    </div>

                    <div className="stacked-list">
                      {screen.banners.map((banner) => (
                        <div className="mini-card" key={banner.bannerId}>
                          <header>
                            <strong>{banner.bannerName}</strong>
                            <div className="inline-row wrap-row">
                              <Pill tone={banner.type.toLowerCase() === 'image' ? 'success' : 'muted'}>{banner.type}</Pill>
                              <Pill tone={banner.enabled ? 'success' : 'warning'}>{banner.enabled ? 'enabled' : 'disabled'}</Pill>
                            </div>
                          </header>
                          <p className="subtle-copy">
                            Banner #{banner.bannerId} · {formatDuration(banner.totalDuration)}
                            {banner.promoActionId ? ` · promo ${banner.promoActionId}` : ''}
                          </p>
                        </div>
                      ))}
                    </div>
                  </article>
                ))}
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  )
}

function imageBanners(banners: ScreensInventoryBanner[]): ScreensInventoryBanner[] {
  return banners.filter((banner) => banner.type.toLowerCase() === 'image')
}

function toScreenKey(dealerId: number, screenId: number): string {
  return `${dealerId}:${screenId}`
}

function parseScreenKey(screenKey: string): { dealerId: number; screenId: number } {
  const [dealerIdText, screenIdText] = screenKey.split(':')
  return {
    dealerId: Number(dealerIdText),
    screenId: Number(screenIdText),
  }
}

function toggleValue(values: string[], nextValue: string): string[] {
  return values.includes(nextValue)
    ? values.filter((value) => value !== nextValue)
    : [...values, nextValue]
}

function canSubmitSync(canQueueSync: boolean, selectedBannerIds: string[], selectedTargetKeys: string[]): boolean {
  return canQueueSync && selectedBannerIds.length > 0 && selectedTargetKeys.length > 0
}

function formatDuration(duration: number | null): string {
  if (duration === null) {
    return 'duration unknown'
  }
  return `${duration}s`
}
