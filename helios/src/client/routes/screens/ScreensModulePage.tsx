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
  QueueScreensBannerBulkToggleRequestSchema,
  QueueScreensBannerDuplicateRequestSchema,
  SCREENS_BANNER_BOUNCE_DEFAULT_HOLD_SECONDS,
  ScreensInventoryResponseSchema,
  buildHeliosModulePath,
  getHeliosModuleDefinition,
  type HistoryEventsResponse,
  type JobStatusResponse,
  type JobsResponse,
  type ScreensInventoryBanner,
  type ScreensInventoryResponse,
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

type SiteOperation = 'bounce' | 'refresh' | 'enable_healthy' | 'maintenance'
type DrawerKind = 'bounce_selected' | 'enable' | 'disable' | 'copy' | null

interface FlatScreen {
  banners: ScreensInventoryBanner[]
  dealerId: number
  dealerName: string
  screenEnabled: boolean | null
  screenId: number
  screenName: string
}

interface ScreensModuleLoaderData {
  history: HistoryEventsResponse
  inventory: ScreensInventoryResponse
  jobs: JobsResponse
}

export async function screensModuleLoader(): Promise<ScreensModuleLoaderData> {
  const [jobs, history, inventory] = await Promise.all([
    loadJson('/api/jobs?module=screens&pageSize=8', JobsResponseSchema),
    loadJson('/api/history/events?module=screens&pageSize=8', HistoryEventsResponseSchema),
    loadJson('/api/screens/inventory', ScreensInventoryResponseSchema),
  ])

  return { history, inventory, jobs }
}

export function ScreensModulePage() {
  const data = useLoaderData() as ScreensModuleLoaderData
  const session = useRouteLoaderData('root') as SessionEnvelope
  const revalidator = useRevalidator()
  const canEdit = session.permissions.canEditProposals

  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [activeBounceJob, setActiveBounceJob] = useState<JobStatusResponse | null>(null)

  // Inventory selection + filtering.
  const [selectedScreens, setSelectedScreens] = useState<Set<string>>(() => new Set())
  const [selectedBanners, setSelectedBanners] = useState<Set<string>>(() => new Set())
  const [expandedScreens, setExpandedScreens] = useState<Set<string>>(() => new Set())
  const [search, setSearch] = useState('')
  const [siteFilter, setSiteFilter] = useState<number | 'all'>('all')
  const [chipImage, setChipImage] = useState(false)
  const [chipPromo, setChipPromo] = useState(false)
  const [chipDisabled, setChipDisabled] = useState(false)
  const [chipZero, setChipZero] = useState(false)

  // Drawer + shared note.
  const [drawer, setDrawer] = useState<DrawerKind>(null)
  const [reason, setReason] = useState('')
  const [holdSeconds, setHoldSeconds] = useState(SCREENS_BANNER_BOUNCE_DEFAULT_HOLD_SECONDS)
  const [copyTargetKeys, setCopyTargetKeys] = useState<string[]>([])

  const allScreens = useMemo<FlatScreen[]>(() => (
    data.inventory.sites.flatMap((site) => site.screens.map((screen) => ({
      banners: screen.banners,
      dealerId: site.dealerId,
      dealerName: site.dealerName,
      screenEnabled: screen.screenEnabled,
      screenId: screen.screenId,
      screenName: screen.screenName,
    })))
  ), [data.inventory.sites])

  const screenByKey = useMemo(() => new Map(allScreens.map((screen) => [screenKey(screen.dealerId, screen.screenId), screen])), [allScreens])

  // Poll the active bounce job to completion.
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
        if (!cancelled) timeoutId = window.setTimeout(() => void poll(), 3000)
      }
    }
    timeoutId = window.setTimeout(() => void poll(), 1500)
    return () => {
      cancelled = true
      if (timeoutId !== undefined) window.clearTimeout(timeoutId)
    }
  }, [activeBounceJob, revalidator])

  const filteredSites = useMemo(() => {
    const term = search.trim().toLowerCase()
    return data.inventory.sites
      .filter((site) => siteFilter === 'all' || site.dealerId === siteFilter)
      .map((site) => {
        const screens = site.screens
          .map((screen) => {
            const screenMatchesSearch = !term || screen.screenName.toLowerCase().includes(term)
            const visibleBanners = screen.banners.filter((banner) => {
              if (chipImage && banner.type.toLowerCase() !== 'image') return false
              if (chipPromo && banner.promoActionId === null) return false
              if (chipDisabled && banner.enabled) return false
              if (chipZero && (banner.totalDuration ?? 0) !== 0) return false
              if (term && !screenMatchesSearch && !banner.bannerName.toLowerCase().includes(term)) return false
              return true
            })
            return { screen, visibleBanners, screenMatchesSearch }
          })
          .filter(({ visibleBanners, screenMatchesSearch }) => {
            const anyChipActive = chipImage || chipPromo || chipDisabled || chipZero
            if (anyChipActive) return visibleBanners.length > 0
            if (term) return screenMatchesSearch || visibleBanners.length > 0
            return true
          })
        return { dealerId: site.dealerId, dealerName: site.dealerName, screens }
      })
      .filter((site) => site.screens.length > 0)
  }, [data.inventory.sites, siteFilter, search, chipImage, chipPromo, chipDisabled, chipZero])

  const selectedBannerRefs = useMemo(() => [...selectedBanners].map(parseBannerKey), [selectedBanners])
  const selectedScreenRefs = useMemo(() => [...selectedScreens].map(parseScreenKey), [selectedScreens])

  // For "copy" we need the selected banners to all be image banners on a single source screen.
  const copySource = useMemo(() => deriveCopySource(selectedBannerRefs, screenByKey), [selectedBannerRefs, screenByKey])
  const zeroDurationInSelection = useMemo(
    () => selectedBannerRefs.filter((ref) => (lookupBanner(screenByKey, ref)?.totalDuration ?? 0) === 0).length,
    [selectedBannerRefs, screenByKey],
  )

  function clearSelection() {
    setSelectedScreens(new Set())
    setSelectedBanners(new Set())
  }

  function openDrawer(kind: Exclude<DrawerKind, null>) {
    setErrorMessage(null)
    setNotice(null)
    if (kind === 'copy') {
      setCopyTargetKeys([...selectedScreens].filter((key) => {
        if (!copySource) return false
        if (key === screenKey(copySource.dealerId, copySource.screenId)) return false
        // promoActionId is dealer-scoped: promo banners can only target the source site.
        if (copySource.hasPromo && parseScreenKey(key).dealerId !== copySource.dealerId) return false
        return true
      }))
    }
    setDrawer(kind)
  }

  async function submit(path: string, body: Record<string, unknown>, successLabel: string, opts?: { trackBounce?: boolean }): Promise<void> {
    setErrorMessage(null)
    setNotice(null)
    setSubmitting(true)
    try {
      const response = await mutateJson(path, MutationAcceptedResponseSchema, { body: JSON.stringify(body), method: 'POST' })
      if (!response.jobId) throw new Error('The workflow was accepted without a queued job id.')
      setNotice(`${successLabel} (job #${response.jobId}).`)
      setDrawer(null)
      if (opts?.trackBounce) {
        try {
          setActiveBounceJob(await loadJobStatus(response.jobId))
        } catch {
          // success notice still links to the job
        }
      }
      void revalidator.revalidate()
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Could not queue the workflow.')
    } finally {
      setSubmitting(false)
    }
  }

  const summary = data.inventory.summary
  const inventorySource = data.inventory.inventorySource

  return (
    <section className="screens-control-room">
      <div className="page-header">
        <div>
          <p className="eyebrow">Screens Module</p>
          <h2>Screens control room</h2>
          <p className="subtle-copy">{screensModule.summary}</p>
        </div>
        <Pill tone={canEdit ? 'success' : 'muted'}>{canEdit ? 'editor' : 'view only'}</Pill>
      </div>

      <div className="screens-snapshot">
        <span><strong>{summary.siteCount}</strong> sites</span>
        <span><strong>{summary.screenCount}</strong> screens</span>
        <span><strong>{summary.bannerCount}</strong> banners</span>
        <span><strong>{summary.imageBannerCount}</strong> image</span>
        <span className={summary.zeroDurationBannerCount > 0 ? 'screens-snapshot-warn' : undefined}>
          <strong>{summary.zeroDurationBannerCount}</strong> zero-duration
        </span>
        <span className="screens-snapshot-age">
          {inventorySource
            ? `snapshot ${new Date(inventorySource.capturedAt).toLocaleString()}`
            : 'no snapshot yet — run a refresh/bounce'}
        </span>
      </div>

      {notice ? <p className="subtle-copy">{notice}</p> : null}
      {errorMessage ? <p className="error-text">{errorMessage}</p> : null}

      {activeBounceJob ? <BounceProgressCard data={activeBounceJob} onDismiss={() => setActiveBounceJob(null)} /> : null}

      {/* Primary content: inventory explorer with first-class selection. */}
      <article className="mini-card screens-explorer">
        <header>
          <strong>Inventory &amp; selection</strong>
          <Pill tone={inventorySource ? 'muted' : 'warning'}>{inventorySource ? 'artifact-backed' : 'missing'}</Pill>
        </header>

        <div className="screens-filter-row">
          <input
            className="screens-search"
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search screen or banner name…"
            type="search"
            value={search}
          />
          <select onChange={(event) => setSiteFilter(event.target.value === 'all' ? 'all' : Number(event.target.value))} value={String(siteFilter)}>
            <option value="all">All sites</option>
            {data.inventory.sites.map((site) => (
              <option key={site.dealerId} value={String(site.dealerId)}>{site.dealerName}</option>
            ))}
          </select>
          <div className="screens-chip-row">
            <FilterChip active={chipImage} label="Image" onToggle={() => setChipImage((value) => !value)} />
            <FilterChip active={chipPromo} label="Promo" onToggle={() => setChipPromo((value) => !value)} />
            <FilterChip active={chipDisabled} label="Disabled" onToggle={() => setChipDisabled((value) => !value)} />
            <FilterChip active={chipZero} label="Zero-duration" onToggle={() => setChipZero((value) => !value)} />
          </div>
        </div>

        {filteredSites.length === 0 ? (
          <p className="empty-state">
            {data.inventory.sites.length === 0
              ? 'No screens inventory yet. Queue a refresh or bounce to capture a snapshot.'
              : 'No screens or banners match the current filters.'}
          </p>
        ) : (
          <div className="screens-site-list">
            {filteredSites.map((site) => {
              const eligibleVisible = site.screens.filter(({ screen }) => isScreenEligible(screen.screenEnabled, screen.screenName))
              const allSiteSelected = eligibleVisible.length > 0 && eligibleVisible.every(({ screen }) => selectedScreens.has(screenKey(site.dealerId, screen.screenId)))
              return (
                <div className="screens-site" key={site.dealerId}>
                  <div className="screens-site-head">
                    <strong>{site.dealerName}</strong>
                    <button
                      className="link-button"
                      disabled={!canEdit || eligibleVisible.length === 0}
                      onClick={() => toggleScreenSet(setSelectedScreens, eligibleVisible.map(({ screen }) => screenKey(site.dealerId, screen.screenId)), !allSiteSelected)}
                      type="button"
                    >
                      {allSiteSelected ? 'Deselect all' : 'Select all eligible'}
                    </button>
                  </div>
                  {site.screens.map(({ screen, visibleBanners }) => {
                    const sKey = screenKey(site.dealerId, screen.screenId)
                    const eligible = isScreenEligible(screen.screenEnabled, screen.screenName)
                    const expanded = expandedScreens.has(sKey)
                    const selectedCount = visibleBanners.filter((banner) => selectedBanners.has(bannerKey(site.dealerId, screen.screenId, banner.bannerId))).length
                    return (
                      <div className={`screens-screen${eligible ? '' : ' is-ineligible'}`} key={sKey}>
                        <div className="screens-screen-head">
                          <label className="screens-check">
                            <input
                              checked={selectedScreens.has(sKey)}
                              disabled={!canEdit || !eligible}
                              onChange={() => toggleInSet(setSelectedScreens, sKey)}
                              type="checkbox"
                            />
                          </label>
                          <button className="screens-screen-title" onClick={() => toggleInSet(setExpandedScreens, sKey)} type="button">
                            <span>{expanded ? '▾' : '▸'} {screen.screenName}</span>
                            <span className="screens-screen-meta">
                              {screen.banners.length} banners
                              {selectedCount > 0 ? ` · ${selectedCount} selected` : ''}
                            </span>
                          </button>
                          <Pill tone={eligible ? 'success' : 'warning'}>{eligible ? 'on' : 'off/dead'}</Pill>
                        </div>
                        {expanded ? (
                          <div className="screens-banner-list">
                            {visibleBanners.length === 0 ? (
                              <p className="empty-state">No banners match the filters on this screen.</p>
                            ) : (
                              <>
                                <button
                                  className="link-button"
                                  disabled={!canEdit}
                                  onClick={() => toggleScreenSet(
                                    setSelectedBanners,
                                    visibleBanners.map((banner) => bannerKey(site.dealerId, screen.screenId, banner.bannerId)),
                                    selectedCount !== visibleBanners.length,
                                  )}
                                  type="button"
                                >
                                  {selectedCount === visibleBanners.length ? 'Deselect banners' : 'Select all banners'}
                                </button>
                                {visibleBanners.map((banner) => {
                                  const bKey = bannerKey(site.dealerId, screen.screenId, banner.bannerId)
                                  return (
                                    <label className={`screens-banner${banner.enabled ? '' : ' is-off'}`} key={bKey}>
                                      <input
                                        checked={selectedBanners.has(bKey)}
                                        disabled={!canEdit}
                                        onChange={() => toggleInSet(setSelectedBanners, bKey)}
                                        type="checkbox"
                                      />
                                      <span className="screens-banner-name">{banner.bannerName}</span>
                                      <span className="screens-banner-tags">
                                        <Pill tone={banner.type.toLowerCase() === 'image' ? 'success' : 'muted'}>{banner.type}</Pill>
                                        <Pill tone={banner.enabled ? 'success' : 'warning'}>{banner.enabled ? 'enabled' : 'disabled'}</Pill>
                                        <Pill tone={(banner.totalDuration ?? 0) === 0 ? 'danger' : 'muted'}>{formatDuration(banner.totalDuration)}</Pill>
                                      </span>
                                    </label>
                                  )
                                })}
                              </>
                            )}
                          </div>
                        ) : null}
                      </div>
                    )
                  })}
                </div>
              )
            })}
          </div>
        )}
      </article>

      {/* Bulk rules — predicate-driven mass enable/disable across the selected scope. */}
      <BulkRulesCard canEdit={canEdit} submitting={submitting} reason={reason} onSubmit={submit} />

      {/* Site-wide operations — bounce/refresh/healthy/maintenance, one consolidated form. */}
      <SiteOperationsCard
        canEdit={canEdit}
        submitting={submitting}
        reason={reason}
        setReason={setReason}
        holdSeconds={holdSeconds}
        setHoldSeconds={setHoldSeconds}
        onSubmit={submit}
      />

      <details className="screens-details">
        <summary>Saved playbooks (site-specific one-offs)</summary>
        <div className="review-grid" style={{ marginTop: '0.75rem' }}>
          <article className="mini-card">
            <header><strong>Bronx → Midtown image fallback clone</strong></header>
            <p className="subtle-copy">Clone the documented Bronx fallback set into every Midtown screen as image banners.</p>
            <p className="subtle-copy">Source set: {bronxMidtownCloneBannerLabel}</p>
            <p className="subtle-copy">Target: all {midtownDealerLabel} screens</p>
            <div className="inline-row wrap-row">
              <button className="ghost-button" disabled={!canEdit || submitting} onClick={() => void submit('/api/screens/bronx-midtown-image-clone', { apply: false, reason: reason.trim() || null }, 'Queued dry-run image fallback clone')} type="button">Dry-run</button>
              <button className="primary-button" disabled={!canEdit || submitting} onClick={() => void submit('/api/screens/bronx-midtown-image-clone', { apply: true, reason: reason.trim() || null }, 'Queued live image fallback clone')} type="button">Live apply</button>
            </div>
          </article>
          <article className="mini-card">
            <header><strong>Priced to MOVE promo rebind</strong></header>
            <p className="subtle-copy">Replace the Midtown image fallback set with the Velocity Boosters product-menu banners.</p>
            <p className="subtle-copy">Actions: {pricedToMovePromoActionLabel}</p>
            <p className="subtle-copy">Target: all {midtownDealerLabel} screens</p>
            <div className="inline-row wrap-row">
              <button className="ghost-button" disabled={!canEdit || submitting} onClick={() => void submit('/api/screens/midtown-priced-to-move-promo-rebind', { apply: false, reason: reason.trim() || null }, 'Queued dry-run promo rebind')} type="button">Dry-run</button>
              <button className="primary-button" disabled={!canEdit || submitting} onClick={() => void submit('/api/screens/midtown-priced-to-move-promo-rebind', { apply: true, reason: reason.trim() || null }, 'Queued live promo rebind')} type="button">Live apply</button>
            </div>
          </article>
        </div>
      </details>

      <details className="screens-details">
        <summary>Recent screens jobs &amp; audit</summary>
        <div className="review-grid" style={{ marginTop: '0.75rem' }}>
          <article className="mini-card">
            <header><strong>Recent jobs</strong><Link to="/jobs?module=screens">See all</Link></header>
            <div className="stacked-list compact-stack" style={{ marginTop: '0.6rem' }}>
              {data.jobs.items.map((job) => (
                <div className="mini-card-row" key={job.jobId}>
                  <div>
                    <strong>{job.jobType}</strong>
                    <p className="subtle-copy">{new Date(job.createdAt).toLocaleString()}{job.scope ? ` · ${job.scope.entityType} ${job.scope.entityId}` : ''}</p>
                  </div>
                  <Pill tone={statusTone(job.status)}>{job.status}</Pill>
                </div>
              ))}
              {data.jobs.items.length === 0 ? <p className="empty-state">No screens jobs queued yet.</p> : null}
            </div>
          </article>
          <article className="mini-card">
            <header><strong>Recent audit events</strong><Link to="/history?module=screens">See all</Link></header>
            <div className="stacked-list compact-stack" style={{ marginTop: '0.6rem' }}>
              {data.history.items.map((event) => (
                <div className="mini-card-row" key={event.eventId}>
                  <div>
                    <strong>{event.eventType}</strong>
                    <p className="subtle-copy">{new Date(event.createdAt).toLocaleString()} · {event.actorLabel}</p>
                    <p className="subtle-copy">{readEventSummary(event)}</p>
                  </div>
                  <Pill tone="muted">{moduleLabelByCode.get(event.module) ?? event.module}</Pill>
                </div>
              ))}
              {data.history.items.length === 0 ? <p className="empty-state">No screens audit events yet.</p> : null}
            </div>
          </article>
        </div>
        <div className="inline-row wrap-row" style={{ marginTop: '0.5rem' }}>
          <Link to={buildHeliosModulePath('catalog')}>Catalog module</Link>
          <Link to="/screens/devices">Legacy devices view</Link>
          <Link to="/jobs">Global jobs</Link>
          <Link to="/history">Global history</Link>
        </div>
      </details>

      {/* Sticky action bar — appears whenever something is selected. */}
      {(selectedScreens.size > 0 || selectedBanners.size > 0) ? (
        <div className="screens-action-bar">
          <div className="screens-action-counts">
            {selectedScreens.size > 0 ? <span>{selectedScreens.size} screen(s)</span> : null}
            {selectedBanners.size > 0 ? <span>{selectedBanners.size} banner(s)</span> : null}
          </div>
          <div className="screens-action-buttons">
            {selectedBanners.size > 0 ? (
              <>
                <button className="ghost-button" disabled={!canEdit} onClick={() => openDrawer('enable')} type="button">Enable</button>
                <button className="ghost-button" disabled={!canEdit} onClick={() => openDrawer('disable')} type="button">Disable</button>
                <button className="ghost-button" disabled={!canEdit || !copySource} onClick={() => openDrawer('copy')} type="button">Duplicate</button>
              </>
            ) : null}
            {selectedScreens.size > 0 ? (
              <button className="primary-button" disabled={!canEdit} onClick={() => openDrawer('bounce_selected')} type="button">Bounce</button>
            ) : null}
            <button className="link-button" onClick={clearSelection} type="button">Clear</button>
          </div>
        </div>
      ) : null}

      {/* Operation drawer. */}
      {drawer ? (
        <OperationDrawer
          drawer={drawer}
          onClose={() => setDrawer(null)}
          submitting={submitting}
          reason={reason}
          setReason={setReason}
          holdSeconds={holdSeconds}
          setHoldSeconds={setHoldSeconds}
          selectedBannerCount={selectedBanners.size}
          selectedScreenCount={selectedScreens.size}
          zeroDurationInSelection={zeroDurationInSelection}
          copySource={copySource}
          copyTargetKeys={copyTargetKeys}
          setCopyTargetKeys={setCopyTargetKeys}
          allScreens={allScreens}
          onEnableDisable={(desiredEnabled) => void submit(
            '/api/screens/banner-bulk-toggle',
            QueueScreensBannerBulkToggleRequestSchema.parse({
              apply: true,
              desiredEnabled,
              reason: reason.trim() || null,
              target: { kind: 'explicit_banners', banners: selectedBannerRefs },
            }),
            `Queued live bulk ${desiredEnabled ? 'enable' : 'disable'}`,
          )}
          onEnableDisableDry={(desiredEnabled) => void submit(
            '/api/screens/banner-bulk-toggle',
            QueueScreensBannerBulkToggleRequestSchema.parse({
              apply: false,
              desiredEnabled,
              reason: reason.trim() || null,
              target: { kind: 'explicit_banners', banners: selectedBannerRefs },
            }),
            `Queued dry-run bulk ${desiredEnabled ? 'enable' : 'disable'}`,
          )}
          onBounce={(apply) => void submit(
            '/api/screens/banner-refresh',
            {
              apply,
              holdSeconds: Math.max(0, Math.min(300, Math.round(holdSeconds))),
              intent: 'bounce',
              reason: reason.trim() || null,
              targetScreens: selectedScreenRefs,
            },
            apply ? 'Queued live bounce' : 'Queued dry-run bounce',
            { trackBounce: apply },
          )}
          onCopy={(apply) => {
            if (!copySource) return
            void submit(
              '/api/screens/banner-duplicate',
              QueueScreensBannerDuplicateRequestSchema.parse({
                apply,
                reason: reason.trim() || null,
                sourceBannerIds: copySource.bannerIds,
                sourceDealerId: copySource.dealerId,
                sourceScreenId: copySource.screenId,
                targetScreens: copyTargetKeys.map(parseScreenKey),
              }),
              apply ? 'Queued live banner duplicate' : 'Queued dry-run banner duplicate',
            )
          }}
        />
      ) : null}
    </section>
  )
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function FilterChip({ active, label, onToggle }: { active: boolean; label: string; onToggle: () => void }) {
  return (
    <button className={`filter-chip${active ? ' is-active' : ''}`} onClick={onToggle} type="button">{label}</button>
  )
}

function BulkRulesCard({
  canEdit,
  submitting,
  reason,
  onSubmit,
}: {
  canEdit: boolean
  submitting: boolean
  reason: string
  onSubmit: (path: string, body: Record<string, unknown>, successLabel: string) => Promise<void>
}) {
  const [dealerIds, setDealerIds] = useState<number[]>([])
  const [nameContains, setNameContains] = useState('')

  function predicate(extra: Record<string, unknown>): Record<string, unknown> {
    return QueueScreensBannerBulkToggleRequestSchema.parse({
      apply: false,
      desiredEnabled: false,
      reason: reason.trim() || null,
      target: { kind: 'predicate', predicate: { siteDealerIds: dealerIds, ...extra } },
    }).target
  }

  function run(apply: boolean, desiredEnabled: boolean, extra: Record<string, unknown>, label: string) {
    void onSubmit(
      '/api/screens/banner-bulk-toggle',
      {
        apply,
        desiredEnabled,
        reason: reason.trim() || null,
        target: predicate(extra),
      },
      `${apply ? 'Queued live' : 'Queued dry-run'} ${label}`,
    )
  }

  return (
    <article className="mini-card">
      <header>
        <strong>Bulk rules</strong>
        <Pill tone={canEdit ? 'success' : 'muted'}>{canEdit ? 'editor' : 'view only'}</Pill>
      </header>
      <p className="subtle-copy">Mass enable/disable banners across a whole scope by rule, without hand-picking each one.</p>
      <div className="screens-chip-row" style={{ marginTop: '0.5rem' }}>
        {HELIOS_SCREENS_SITE_DEALERS.map((dealer) => (
          <FilterChip
            key={dealer.dealerId}
            active={dealerIds.includes(dealer.dealerId)}
            label={dealer.dealerName}
            onToggle={() => setDealerIds((current) => current.includes(dealer.dealerId) ? current.filter((id) => id !== dealer.dealerId) : [...current, dealer.dealerId])}
          />
        ))}
        <span className="subtle-copy">{dealerIds.length === 0 ? '(all sites)' : ''}</span>
      </div>

      <div className="screens-rule-row">
        <span>Disable every zero-duration banner</span>
        <div className="inline-row wrap-row">
          <button className="ghost-button" disabled={!canEdit || submitting} onClick={() => run(false, false, { durationState: 'zero' }, 'disable zero-duration')} type="button">Dry-run</button>
          <button className="primary-button" disabled={!canEdit || submitting} onClick={() => run(true, false, { durationState: 'zero' }, 'disable zero-duration')} type="button">Apply</button>
        </div>
      </div>
      <div className="screens-rule-row">
        <span>Re-enable healthy disabled banners</span>
        <div className="inline-row wrap-row">
          <button className="ghost-button" disabled={!canEdit || submitting} onClick={() => run(false, true, { currentEnabled: false, durationState: 'positive' }, 'enable healthy banners')} type="button">Dry-run</button>
          <button className="primary-button" disabled={!canEdit || submitting} onClick={() => run(true, true, { currentEnabled: false, durationState: 'positive' }, 'enable healthy banners')} type="button">Apply</button>
        </div>
      </div>
      <div className="screens-rule-row">
        <input
          className="screens-search"
          onChange={(event) => setNameContains(event.target.value)}
          placeholder="Banner name contains…"
          value={nameContains}
        />
        <div className="inline-row wrap-row">
          <button className="ghost-button" disabled={!canEdit || submitting || !nameContains.trim()} onClick={() => run(true, true, { nameContains: nameContains.trim() }, `enable "${nameContains.trim()}"`)} type="button">Enable matches</button>
          <button className="ghost-button" disabled={!canEdit || submitting || !nameContains.trim()} onClick={() => run(true, false, { nameContains: nameContains.trim() }, `disable "${nameContains.trim()}"`)} type="button">Disable matches</button>
        </div>
      </div>
    </article>
  )
}

function SiteOperationsCard({
  canEdit,
  submitting,
  reason,
  setReason,
  holdSeconds,
  setHoldSeconds,
  onSubmit,
}: {
  canEdit: boolean
  submitting: boolean
  reason: string
  setReason: (value: string) => void
  holdSeconds: number
  setHoldSeconds: (value: number) => void
  onSubmit: (path: string, body: Record<string, unknown>, successLabel: string, opts?: { trackBounce?: boolean }) => Promise<void>
}) {
  const [operation, setOperation] = useState<SiteOperation>('bounce')
  const [dealerIds, setDealerIds] = useState<number[]>([])

  const endpointByOp: Record<SiteOperation, string> = {
    bounce: '/api/screens/banner-refresh',
    refresh: '/api/screens/banner-refresh',
    enable_healthy: '/api/screens/enable-healthy-banners',
    maintenance: '/api/screens/banner-health-maintenance',
  }
  const labelByOp: Record<SiteOperation, string> = {
    bounce: 'banner/screen bounce',
    refresh: 'banner refresh',
    enable_healthy: 'healthy-banner enable sweep',
    maintenance: 'banner-health maintenance',
  }

  function run(apply: boolean) {
    const body: Record<string, unknown> = { apply, reason: reason.trim() || null, siteDealerIds: dealerIds }
    if (operation === 'bounce') {
      body.intent = 'bounce'
      body.holdSeconds = Math.max(0, Math.min(300, Math.round(holdSeconds)))
    } else if (operation === 'refresh') {
      body.intent = 'refresh'
    }
    void onSubmit(
      endpointByOp[operation],
      body,
      `${apply ? 'Queued live' : 'Queued dry-run'} ${labelByOp[operation]}`,
      operation === 'bounce' ? { trackBounce: apply } : undefined,
    )
  }

  return (
    <article className="mini-card">
      <header>
        <strong>Site-wide operations</strong>
        <Pill tone={canEdit ? 'success' : 'muted'}>{canEdit ? 'editor' : 'view only'}</Pill>
      </header>
      <div className="screens-op-grid">
        <label className="stack-field">
          <span>Operation</span>
          <select onChange={(event) => setOperation(event.target.value as SiteOperation)} value={operation}>
            <option value="bounce">Bounce (off → hold → on)</option>
            <option value="refresh">Refresh banners</option>
            <option value="enable_healthy">Enable healthy banners</option>
            <option value="maintenance">Banner-health maintenance</option>
          </select>
        </label>
        {operation === 'bounce' ? (
          <label className="stack-field">
            <span>Hold window (seconds)</span>
            <input max={300} min={0} onChange={(event) => setHoldSeconds(Number.parseInt(event.target.value, 10) || 0)} step={5} type="number" value={holdSeconds} />
          </label>
        ) : null}
      </div>
      <div className="screens-chip-row" style={{ marginTop: '0.5rem' }}>
        {HELIOS_SCREENS_SITE_DEALERS.map((dealer) => (
          <FilterChip
            key={dealer.dealerId}
            active={dealerIds.includes(dealer.dealerId)}
            label={dealer.dealerName}
            onToggle={() => setDealerIds((current) => current.includes(dealer.dealerId) ? current.filter((id) => id !== dealer.dealerId) : [...current, dealer.dealerId])}
          />
        ))}
        <span className="subtle-copy">{dealerIds.length === 0 ? '(all sites)' : ''}</span>
      </div>
      <label className="stack-field" style={{ marginTop: '0.5rem' }}>
        <span>Run note (shared)</span>
        <textarea onChange={(event) => setReason(event.target.value)} placeholder="Optional operator note for the audit trail" rows={2} value={reason} />
      </label>
      <div className="inline-row wrap-row">
        <button className="ghost-button" disabled={!canEdit || submitting} onClick={() => run(false)} type="button">Dry-run</button>
        <button className="primary-button" disabled={!canEdit || submitting} onClick={() => run(true)} type="button">Live apply</button>
      </div>
    </article>
  )
}

interface CopySource { bannerIds: string[]; dealerId: number; hasPromo: boolean; screenId: number; screenName: string }

function OperationDrawer({
  drawer,
  onClose,
  submitting,
  reason,
  setReason,
  holdSeconds,
  setHoldSeconds,
  selectedBannerCount,
  selectedScreenCount,
  zeroDurationInSelection,
  copySource,
  copyTargetKeys,
  setCopyTargetKeys,
  allScreens,
  onEnableDisable,
  onEnableDisableDry,
  onBounce,
  onCopy,
}: {
  drawer: Exclude<DrawerKind, null>
  onClose: () => void
  submitting: boolean
  reason: string
  setReason: (value: string) => void
  holdSeconds: number
  setHoldSeconds: (value: number) => void
  selectedBannerCount: number
  selectedScreenCount: number
  zeroDurationInSelection: number
  copySource: CopySource | null
  copyTargetKeys: string[]
  setCopyTargetKeys: (value: string[]) => void
  allScreens: FlatScreen[]
  onEnableDisable: (desiredEnabled: boolean) => void
  onEnableDisableDry: (desiredEnabled: boolean) => void
  onBounce: (apply: boolean) => void
  onCopy: (apply: boolean) => void
}) {
  const title = drawer === 'bounce_selected'
    ? `Bounce ${selectedScreenCount} screen(s)`
    : drawer === 'enable'
      ? `Enable ${selectedBannerCount} banner(s)`
      : drawer === 'disable'
        ? `Disable ${selectedBannerCount} banner(s)`
        : 'Duplicate banners'

  return (
    <div className="screens-drawer-backdrop" onClick={onClose} role="presentation">
      <div className="screens-drawer" onClick={(event) => event.stopPropagation()} role="dialog">
        <div className="page-header" style={{ marginBottom: '0.5rem' }}>
          <strong>{title}</strong>
          <button className="ghost-button" onClick={onClose} type="button">Close</button>
        </div>

        {drawer === 'enable' && zeroDurationInSelection > 0 ? (
          <p className="subtle-copy">{zeroDurationInSelection} zero-duration banner(s) in the selection will be left disabled (zero-duration banners cannot be enabled).</p>
        ) : null}

        {drawer === 'bounce_selected' ? (
          <label className="stack-field">
            <span>Hold window (seconds)</span>
            <input max={300} min={0} onChange={(event) => setHoldSeconds(Number.parseInt(event.target.value, 10) || 0)} step={5} type="number" value={holdSeconds} />
          </label>
        ) : null}

        {drawer === 'copy' ? (
          copySource ? (
            <div>
              <p className="subtle-copy">Source: <strong>{copySource.screenName}</strong> · {copySource.bannerIds.length} banner(s).</p>
              {copySource.hasPromo ? (
                <p className="subtle-copy">A product-menu/promo banner is selected, so only screens at the source site can be targeted (promo actions are dealer-scoped).</p>
              ) : null}
              <p><strong>Target screens</strong></p>
              <div className="screens-drawer-targets">
                {allScreens
                  .filter((screen) => !(screen.dealerId === copySource.dealerId && screen.screenId === copySource.screenId))
                  .filter((screen) => !copySource.hasPromo || screen.dealerId === copySource.dealerId)
                  .filter((screen) => isScreenEligible(screen.screenEnabled, screen.screenName))
                  .map((screen) => {
                    const key = screenKey(screen.dealerId, screen.screenId)
                    return (
                      <label className="screens-banner" key={key}>
                        <input
                          checked={copyTargetKeys.includes(key)}
                          onChange={() => setCopyTargetKeys(copyTargetKeys.includes(key) ? copyTargetKeys.filter((value) => value !== key) : [...copyTargetKeys, key])}
                          type="checkbox"
                        />
                        <span className="screens-banner-name">{screen.dealerName} · {screen.screenName}</span>
                      </label>
                    )
                  })}
              </div>
            </div>
          ) : (
            <p className="error-text">Select image or product-menu/promo banners from a single source screen to duplicate.</p>
          )
        ) : null}

        <label className="stack-field" style={{ marginTop: '0.5rem' }}>
          <span>Run note</span>
          <textarea onChange={(event) => setReason(event.target.value)} placeholder="Optional operator note for the audit trail" rows={2} value={reason} />
        </label>

        <div className="inline-row wrap-row">
          {drawer === 'bounce_selected' ? (
            <>
              <button className="ghost-button" disabled={submitting} onClick={() => onBounce(false)} type="button">Dry-run</button>
              <button className="primary-button" disabled={submitting} onClick={() => onBounce(true)} type="button">Live bounce</button>
            </>
          ) : null}
          {drawer === 'enable' || drawer === 'disable' ? (
            <>
              <button className="ghost-button" disabled={submitting} onClick={() => onEnableDisableDry(drawer === 'enable')} type="button">Dry-run</button>
              <button className="primary-button" disabled={submitting} onClick={() => onEnableDisable(drawer === 'enable')} type="button">Live {drawer === 'enable' ? 'enable' : 'disable'}</button>
            </>
          ) : null}
          {drawer === 'copy' ? (
            <>
              <button className="ghost-button" disabled={submitting || !copySource || copyTargetKeys.length === 0} onClick={() => onCopy(false)} type="button">Dry-run</button>
              <button className="primary-button" disabled={submitting || !copySource || copyTargetKeys.length === 0} onClick={() => onCopy(true)} type="button">Live copy</button>
            </>
          ) : null}
        </div>
      </div>
    </div>
  )
}

function computeBouncePercent(data: JobStatusResponse): number {
  if (data.job.status === 'succeeded' || data.job.status === 'failed' || data.job.status === 'dead_letter') return 100
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
  const failed = data.job.status === 'failed' || data.job.status === 'dead_letter'
  const tone: 'success' | 'warning' | 'danger' | 'muted' =
    data.job.status === 'succeeded' ? 'success' : failed ? 'danger' : data.job.status === 'queued' || data.job.status === 'running' ? 'warning' : 'muted'

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
          {terminal ? <button className="ghost-button" onClick={onDismiss} type="button">Dismiss</button> : null}
        </div>
      </div>
      <div className="job-progress-track" aria-hidden="true">
        <div className={`job-progress-fill${failed ? ' failed' : ''}`} style={{ width: `${percent}%` }} />
      </div>
      <div className="pricing-metric-grid" style={{ marginTop: '0.75rem' }}>
        <div className="value-panel"><span>Phase</span><p>{data.progress ? `${data.progress.phase} (${data.progress.phaseIndex}/${data.progress.phaseCount})` : '—'}</p></div>
        <div className="value-panel"><span>Elapsed</span><p>{elapsedSeconds !== null ? `${elapsedSeconds}s` : '—'}</p></div>
        <div className="value-panel"><span>Status</span><p>{data.job.status.replaceAll('_', ' ')}</p></div>
      </div>
      {data.job.lastError ? <p className="error-text">{data.job.lastError}</p> : null}
    </article>
  )
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function screenKey(dealerId: number, screenId: number): string {
  return `${dealerId}:${screenId}`
}

function bannerKey(dealerId: number, screenId: number, bannerId: string): string {
  return `${dealerId}:${screenId}:${bannerId}`
}

function parseScreenKey(key: string): { dealerId: number; screenId: number } {
  const [dealerId, screenId] = key.split(':')
  return { dealerId: Number(dealerId), screenId: Number(screenId) }
}

function parseBannerKey(key: string): { bannerId: string; dealerId: number; screenId: number } {
  const [dealerId, screenId, ...bannerParts] = key.split(':')
  return { bannerId: bannerParts.join(':'), dealerId: Number(dealerId), screenId: Number(screenId) }
}

function toggleInSet(setter: (updater: (current: Set<string>) => Set<string>) => void, value: string): void {
  setter((current) => {
    const next = new Set(current)
    if (next.has(value)) next.delete(value)
    else next.add(value)
    return next
  })
}

function toggleScreenSet(setter: (updater: (current: Set<string>) => Set<string>) => void, keys: string[], select: boolean): void {
  setter((current) => {
    const next = new Set(current)
    for (const key of keys) {
      if (select) next.add(key)
      else next.delete(key)
    }
    return next
  })
}

function isRetiredScreenName(name: string): boolean {
  return /^(?:dead\s*-|dead-|deleted|retired)/i.test(name.trim())
}

function isScreenEligible(screenEnabled: boolean | null, screenName: string): boolean {
  return screenEnabled !== false && !isRetiredScreenName(screenName)
}

function lookupBanner(screenByKey: Map<string, FlatScreen>, ref: { bannerId: string; dealerId: number; screenId: number }): ScreensInventoryBanner | null {
  const screen = screenByKey.get(screenKey(ref.dealerId, ref.screenId))
  return screen?.banners.find((banner) => banner.bannerId === ref.bannerId) ?? null
}

function deriveCopySource(
  refs: Array<{ bannerId: string; dealerId: number; screenId: number }>,
  screenByKey: Map<string, FlatScreen>,
): CopySource | null {
  if (refs.length === 0) return null
  const first = refs[0]
  const sameScreen = refs.every((ref) => ref.dealerId === first.dealerId && ref.screenId === first.screenId)
  if (!sameScreen) return null
  const screen = screenByKey.get(screenKey(first.dealerId, first.screenId))
  if (!screen) return null
  // A banner can be duplicated when it is an image banner (reusable media) or a
  // product-menu/promo banner (carries a promoActionId). Anything else is not
  // supported by the duplicate worker.
  const allDuplicatable = refs.every((ref) => {
    const banner = lookupBanner(screenByKey, ref)
    return banner !== null && (banner.type.toLowerCase() === 'image' || banner.promoActionId !== null)
  })
  if (!allDuplicatable) return null
  const hasPromo = refs.some((ref) => lookupBanner(screenByKey, ref)?.promoActionId != null)
  return { bannerIds: refs.map((ref) => ref.bannerId), dealerId: first.dealerId, hasPromo, screenId: first.screenId, screenName: screen.screenName }
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

function formatDuration(duration: number | null): string {
  if (duration === null) return 'n/a'
  return `${duration}s`
}
