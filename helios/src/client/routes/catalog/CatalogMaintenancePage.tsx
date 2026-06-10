import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'

import {
  CatalogMaintenanceMovePackageResponseSchema,
  CatalogMaintenanceSurveyResponseSchema,
  HELIOS_PENDING_PURCHASE_SITE_DEALERS,
  type CatalogMaintenanceCacheRepairResponse,
  type CatalogMaintenanceFatalBanner,
  type CatalogMaintenanceMovePackageResponse,
  type CatalogMaintenancePackageLot,
  type CatalogMaintenanceSectionKind,
  type CatalogMaintenanceSiteGroup,
  type CatalogMaintenanceSiteVariant,
  type CatalogMaintenanceSurveyResponse,
} from '../../../shared/contracts/index.js'
import { buildAppPath } from '../../app/paths.js'
import { importChunkOrReload } from '../../app/dynamicImport.js'
import { Pill } from '../../components/Pill.js'
import {
  buildMaintenanceIndexPath,
  computePerSiteBrandFilters,
  useRegisterCatalogSidebarSubtree,
  type ImagesAndBarcodesSiteEntry,
} from './catalogSidebarSubtree.js'
import { LiveBarcodeScanner } from './LiveBarcodeScanner.js'
import {
  LocationPicker,
  postAssign,
  useLocationPickerState,
  type AssignOutcome,
} from './warehouseLocationPicker.js'

type CardMode = 'group' | 'variants' | 'barcode'

interface SurveyState {
  loading: boolean
  refreshing: boolean
  survey: CatalogMaintenanceSurveyResponse | null
  error: string | null
}

const INITIAL_STATE: SurveyState = {
  loading: true,
  refreshing: false,
  survey: null,
  error: null,
}

/**
 * Shared survey-loading + cache-repair state used by both the
 * Images & Barcodes index page and the per-site page.
 *
 * Exported (not a private hook inside this file) so the index page can
 * pull from the same code path and we don't accidentally diverge fetch
 * logic between the two routes.
 */
export interface UseMaintenanceSurveyResult {
  state: SurveyState
  feedback: { kind: 'ok' | 'err'; message: string } | null
  setFeedback: (feedback: { kind: 'ok' | 'err'; message: string } | null) => void
  fetchSurvey: (forceRefresh: boolean) => Promise<void>
  repairBusy: boolean
  handleRepairCache: () => Promise<void>
}

export function useMaintenanceSurvey(): UseMaintenanceSurveyResult {
  const navigate = useNavigate()
  const [state, setState] = useState<SurveyState>(INITIAL_STATE)
  const [feedback, setFeedback] = useState<{ kind: 'ok' | 'err'; message: string } | null>(null)
  const [repairBusy, setRepairBusy] = useState(false)

  const fetchSurvey = useCallback(
    async (forceRefresh: boolean) => {
      setState((prev) => ({ ...prev, refreshing: true, error: null }))
      try {
        const search = forceRefresh ? '?refresh=1' : ''
        const response = await fetch(buildAppPath(`/api/catalog/maintenance/survey${search}`), {
          credentials: 'same-origin',
          headers: { Accept: 'application/json' },
        })
        if (response.status === 401) {
          navigate('/login')
          return
        }
        if (!response.ok) {
          const errorPayload = await maybeReadErrorPayload(response)
          throw new Error(errorPayload ?? `${response.status} ${response.statusText}`)
        }
        const payload = await response.json()
        const survey = CatalogMaintenanceSurveyResponseSchema.parse(payload)
        setState({ loading: false, refreshing: false, survey, error: null })
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to load Images & Barcodes survey.'
        setState((prev) => ({ ...prev, loading: false, refreshing: false, error: message }))
      }
    },
    [navigate],
  )

  useEffect(() => {
    void fetchSurvey(false)
  }, [fetchSurvey])

  const handleRepairCache = useCallback(async () => {
    setRepairBusy(true)
    try {
      const response = await fetch(buildAppPath('/api/catalog/maintenance/cache-repair'), {
        credentials: 'same-origin',
        headers: { Accept: 'application/json' },
        method: 'POST',
      })
      if (response.status === 401) {
        navigate('/login')
        return
      }
      if (!response.ok) {
        const errorPayload = await maybeReadErrorPayload(response)
        throw new Error(errorPayload ?? `${response.status} ${response.statusText}`)
      }
      const payload = (await response.json()) as CatalogMaintenanceCacheRepairResponse
      const jobIds = [payload.fullSummaryJobId, payload.stockRefreshJobId, payload.discoverOrphanGroupsJobId]
        .filter((v): v is number => v !== null)
        .join(', ')
      setFeedback({
        kind: 'ok',
        message: `Fix-cache jobs enqueued (ids: ${jobIds}). The page will look correct once workers finish.`,
      })
    } catch (error) {
      setFeedback({ kind: 'err', message: error instanceof Error ? error.message : 'Fix cache failed.' })
    } finally {
      setRepairBusy(false)
    }
  }, [navigate])

  return { state, feedback, setFeedback, fetchSurvey, repairBusy, handleRepairCache }
}

/**
 * Per-site Images & Barcodes page.
 *
 * Mounted at `/catalog/maintenance/site/:siteKey`. Renders ONLY the
 * candidates for that single store (never all sites together), so a
 * mobile browser standing in Midtown isn't paying for Bronx's DOM.
 *
 * The optional `?brand=` query narrows to a single brand WITHIN that
 * site. Brand options are scoped to brands actually present in this
 * site's candidate set — an operator in site A is never offered a
 * brand that's only stocked at site B.
 */
export function CatalogMaintenancePage() {
  const { siteKey: rawSiteKey } = useParams<{ siteKey?: string }>()
  const siteKey = rawSiteKey ?? null
  const [searchParams, setSearchParams] = useSearchParams()
  const activeBrand = searchParams.get('brand')
  const navigate = useNavigate()
  const { state, feedback, setFeedback, fetchSurvey, repairBusy, handleRepairCache } = useMaintenanceSurvey()

  // If we somehow land here without a siteKey in the URL (legacy link
  // or a typo), bounce to the site index so the operator can pick one.
  useEffect(() => {
    if (siteKey === null) {
      navigate(buildMaintenanceIndexPath(), { replace: true })
    }
  }, [siteKey, navigate])

  // Per-site brand quick filters for the sidebar. Brands live UNDER
  // the active site in the sidebar — see comments in
  // catalogSidebarSubtree.ts.
  const perSiteBrands: ImagesAndBarcodesSiteEntry[] = useMemo(
    () => (state.survey ? computePerSiteBrandFilters(state.survey) : []),
    [state.survey],
  )

  useRegisterCatalogSidebarSubtree({
    imagesAndBarcodes: {
      indexPath: buildMaintenanceIndexPath(),
      sites: perSiteBrands,
      activeSiteKey: siteKey,
      activeBrand,
    },
  })

  const handleUploadComplete = useCallback(
    async (message: string) => {
      setFeedback({ kind: 'ok', message })
      await fetchSurvey(true)
    },
    [fetchSurvey, setFeedback],
  )

  const handleUploadError = useCallback(
    (message: string) => {
      setFeedback({ kind: 'err', message })
    },
    [setFeedback],
  )

  const handleBrandFilter = (brand: string | null) => {
    if (brand === null) {
      searchParams.delete('brand')
    } else {
      searchParams.set('brand', brand)
    }
    setSearchParams(searchParams, { replace: true })
  }

  // Filter survey to just this one site, then (optionally) just this
  // one brand inside that site.
  const filteredSurvey = useMemo(
    () => filterSurveyToSiteAndBrand(state.survey, siteKey, activeBrand),
    [state.survey, siteKey, activeBrand],
  )

  // The site row in the original (unfiltered) survey, used for the
  // header label + brand chip count even when the brand filter empties
  // the visible cards.
  const siteRow = useMemo(() => {
    if (!state.survey || siteKey === null) return null
    return state.survey.sites.find((s) => s.siteKey === siteKey) ?? null
  }, [state.survey, siteKey])

  const siteBrands = useMemo(
    () => perSiteBrands.find((s) => s.siteKey === siteKey)?.brands ?? [],
    [perSiteBrands, siteKey],
  )

  if (siteKey === null) {
    return null
  }

  return (
    <section className="catalog-maintenance-page">
      <div className="page-header">
        <div>
          <p className="eyebrow">
            Catalog Module ·{' '}
            <Link to={buildMaintenanceIndexPath()}>Images &amp; Barcodes</Link>
          </p>
          <h2>
            {siteRow?.siteLabel ?? siteKey}{' '}
            {siteRow ? (
              <Pill tone={siteRow.totalIssueCount === 0 ? 'muted' : 'warning'}>
                {siteRow.totalIssueCount} issue{siteRow.totalIssueCount === 1 ? '' : 's'}
              </Pill>
            ) : null}
          </h2>
          <p className="subtle-copy">
            In-stock SKUs at {siteRow?.siteLabel ?? 'this site'} whose Sweed product group has no image,
            or whose package barcode is missing. Tap a card to upload or capture a photo and Helios will
            attach it to the group for you.
          </p>
        </div>
        <div className="inline-row wrap-row catalog-maintenance-meta">
          {state.survey?.meta.generatedAt ? (
            <Pill tone="muted">scanned {formatRelativeTime(state.survey.meta.generatedAt)}</Pill>
          ) : null}
          {activeBrand ? (
            <Pill tone="warning">
              brand: {activeBrand}{' '}
              <button
                type="button"
                className="ghost-button"
                onClick={() => handleBrandFilter(null)}
                style={{ marginLeft: '0.25rem' }}
              >
                clear
              </button>
            </Pill>
          ) : null}
          <button
            type="button"
            className="ghost-button"
            disabled={state.refreshing}
            onClick={() => void fetchSurvey(true)}
          >
            {state.refreshing ? 'Refreshing…' : 'Refresh survey'}
          </button>
        </div>
      </div>

      {siteBrands.length > 0 ? (
        <SiteBrandFilterStrip
          brands={siteBrands}
          activeBrand={activeBrand}
          onSelect={handleBrandFilter}
        />
      ) : null}

      {feedback ? (
        <div className={`catalog-maintenance-toast catalog-maintenance-toast-${feedback.kind}`}>
          <span>{feedback.message}</span>
          <button type="button" className="ghost-button" onClick={() => setFeedback(null)}>
            Dismiss
          </button>
        </div>
      ) : null}

      {state.error ? (
        <div className="catalog-maintenance-toast catalog-maintenance-toast-err">{state.error}</div>
      ) : null}

      {filteredSurvey?.fatal ? (
        <FatalBanner banner={filteredSurvey.fatal} busy={repairBusy} onRepair={() => void handleRepairCache()} />
      ) : null}

      {state.loading && !state.survey ? <p className="subtle-copy">Loading…</p> : null}

      {filteredSurvey
        ? filteredSurvey.sites.map((site) => (
            <SiteSection
              key={site.siteKey}
              site={site}
              onComplete={handleUploadComplete}
              onError={handleUploadError}
            />
          ))
        : null}

      {filteredSurvey && filteredSurvey.sites.length === 0 && state.survey ? (
        <p className="subtle-copy">
          No site matches <code>{siteKey}</code> in the latest survey.{' '}
          <Link to={buildMaintenanceIndexPath()}>Back to sites</Link>.
        </p>
      ) : null}

      {filteredSurvey && filteredSurvey.sites.every((s) => s.totalIssueCount === 0) ? (
        <p className="subtle-copy">No issues to address for the active filter.</p>
      ) : null}
    </section>
  )
}

interface SiteBrandFilterStripProps {
  brands: Array<{ brandName: string; issueCount: number }>
  activeBrand: string | null
  onSelect: (brand: string | null) => void
}

/**
 * One-tap brand filter strip rendered above the card list on the
 * per-site page. Mirrors the brand subtree in the sidebar, but is
 * present even when the sidebar is collapsed (the common case on
 * mobile).
 */
function SiteBrandFilterStrip({ brands, activeBrand, onSelect }: SiteBrandFilterStripProps) {
  return (
    <div className="inline-row wrap-row" style={{ gap: '0.35rem', marginBottom: '0.75rem' }}>
      <button
        type="button"
        className={`ghost-button${activeBrand === null ? ' is-active' : ''}`}
        onClick={() => onSelect(null)}
      >
        All brands
      </button>
      {brands.map((brand) => (
        <button
          key={brand.brandName}
          type="button"
          className={`ghost-button${activeBrand === brand.brandName ? ' is-active' : ''}`}
          onClick={() => onSelect(brand.brandName)}
        >
          {brand.brandName} ({brand.issueCount})
        </button>
      ))}
    </div>
  )
}

/**
 * Narrow a survey to a single site (and optional brand within that
 * site). Returns null only when the source survey is null; otherwise
 * always returns a survey shape, possibly with zero sites if siteKey
 * doesn't match anything in the survey.
 */
export function filterSurveyToSiteAndBrand(
  survey: CatalogMaintenanceSurveyResponse | null,
  siteKey: string | null,
  activeBrand: string | null,
): CatalogMaintenanceSurveyResponse | null {
  if (!survey) return null
  const sites = (siteKey === null ? survey.sites : survey.sites.filter((s) => s.siteKey === siteKey)).map(
    (site) => {
      if (!activeBrand) return site
      const sections = site.sections.map((section) => {
        const groups = section.groups.filter((g) => g.brandName === activeBrand)
        return { ...section, groups, issueCount: groups.length }
      })
      const totalIssueCount = sections.reduce((acc, s) => acc + s.issueCount, 0)
      return { ...site, sections, totalIssueCount }
    },
  )
  return { ...survey, sites }
}

interface FatalBannerProps {
  banner: CatalogMaintenanceFatalBanner
  busy: boolean
  onRepair: () => void
}

function FatalBanner({ banner, busy, onRepair }: FatalBannerProps) {
  return (
    <div className="catalog-maintenance-fatal-banner catalog-maintenance-toast catalog-maintenance-toast-err">
      <div>
        <strong>⚠ {banner.title}</strong>
        <p style={{ margin: '0.25rem 0' }}>{banner.message}</p>
        <ul style={{ margin: '0 0 0.5rem 1.25rem' }}>
          {banner.reasons.map((reason) => (
            <li key={reason.code}>
              <strong>{reason.count}</strong> · {reason.message}
              {reason.sampleIds.length > 0 ? (
                <span className="subtle-copy"> (sample: {reason.sampleIds.join(', ')})</span>
              ) : null}
            </li>
          ))}
        </ul>
        {banner.canRepair ? (
          <button type="button" className="primary-button" onClick={onRepair} disabled={busy}>
            {busy ? 'Enqueuing fix-cache jobs…' : '🛠 Fix cache (enqueue high-priority workers)'}
          </button>
        ) : null}
      </div>
    </div>
  )
}

interface SiteSectionProps {
  site: CatalogMaintenanceSurveyResponse['sites'][number]
  onComplete: (message: string) => Promise<void>
  onError: (message: string) => void
}

function SiteSection({ site, onComplete, onError }: SiteSectionProps) {
  return (
    <section className="catalog-maintenance-site" id={site.targetId} style={{ scrollMarginTop: '1rem' }}>
      <header className="page-header" style={{ marginTop: '2rem' }}>
        <h3>
          {site.siteLabel}{' '}
          <Pill tone={site.totalIssueCount === 0 ? 'muted' : 'warning'}>
            {site.totalIssueCount} issue{site.totalIssueCount === 1 ? '' : 's'}
          </Pill>
        </h3>
      </header>
      {site.sections.map((section) => (
        <SectionBlock
          key={section.kind}
          section={section}
          onComplete={onComplete}
          onError={onError}
        />
      ))}
    </section>
  )
}

interface SectionBlockProps {
  section: CatalogMaintenanceSurveyResponse['sites'][number]['sections'][number]
  onComplete: (message: string) => Promise<void>
  onError: (message: string) => void
}

function SectionBlock({ section, onComplete, onError }: SectionBlockProps) {
  // Today the server only emits `missing-catalog-image` and
  // `missing-or-invalid-barcode` sections. The `missing-variant-image`
  // kind is left in the contract enum for forward-compat but never
  // populated. Treat anything that isn't a barcode section as a group
  // image card.
  const mode: CardMode = section.kind === 'missing-or-invalid-barcode' ? 'barcode' : 'group'
  return (
    <section className="catalog-maintenance-section" id={section.targetId} style={{ scrollMarginTop: '1rem' }}>
      <header className="catalog-maintenance-section-head">
        <h4>{section.label}</h4>
        <Pill tone={section.issueCount === 0 ? 'muted' : 'warning'}>
          {section.issueCount} candidate{section.issueCount === 1 ? '' : 's'}
        </Pill>
      </header>
      {section.groups.length === 0 ? (
        <p className="subtle-copy">Nothing to fix here.</p>
      ) : (
        <ul className="catalog-maintenance-list">
          {section.groups.map((group) => {
            const key = `${section.kind}:${group.siteKey}:${group.groupId}`
            return (
              <li key={key}>
                <MaintenanceCard
                  cardKey={key}
                  mode={mode}
                  group={group}
                  onComplete={onComplete}
                  onError={onError}
                />
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}

interface CardProps {
  cardKey: string
  mode: CardMode
  group: CatalogMaintenanceSiteGroup
  onComplete: (message: string) => Promise<void>
  onError: (message: string) => void
}

function MaintenanceCard(props: CardProps) {
  const { mode, group, onComplete, onError } = props
  const [file, setFile] = useState<File | null>(null)
  const [localPreviewUrl, setLocalPreviewUrl] = useState<string | null>(null)
  const [selectedVariantIds, setSelectedVariantIds] = useState<number[]>(() =>
    group.variants.map((variant) => variant.productId),
  )
  const [optimisticImageUrl, setOptimisticImageUrl] = useState<string | null>(null)
  const [optimisticAffectedProductIds, setOptimisticAffectedProductIds] = useState<readonly number[]>([])
  const [syncingReanalysis, setSyncingReanalysis] = useState(false)
  // `isStaging` covers the synchronous HTTP POST that ships the bytes to
  // the server's icebox. It's purely a per-card gate now — sibling
  // cards are never disabled by THIS card's upload so the operator can
  // walk a shelf and rip through every missing-image SKU in parallel,
  // exactly as the user asked.
  const [isStaging, setIsStaging] = useState(false)
  // `isPolling` tracks the background worker-job poll AFTER the
  // enqueue POST has returned. Only gates THIS card's submit/retry
  // buttons; sibling cards keep working.
  const [isPolling, setIsPolling] = useState(false)
  // Per-card status banner — distinct from the global toast at the top of
  // the page (which scrolls off-screen on mobile). Stays visible inside the
  // card so the operator can SEE what happened without scrolling.
  const [cardStatus, setCardStatus] = useState<{ kind: 'ok' | 'err' | 'busy'; message: string } | null>(null)
  // When the worker job fails, we keep the stagedRef around so the
  // operator can click Retry without re-selecting the file. Cleared
  // on successful upload, on a fresh upload, or when the operator
  // picks a new file.
  const [failedStagedRef, setFailedStagedRef] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    if (!file) {
      setLocalPreviewUrl(null)
      return
    }
    const url = URL.createObjectURL(file)
    setLocalPreviewUrl(url)
    return () => URL.revokeObjectURL(url)
  }, [file])

  useEffect(() => {
    setSelectedVariantIds(group.variants.map((variant) => variant.productId))
  }, [group])

  const summaryLine = useMemo(() => buildSummaryLine(group, mode), [group, mode])

  const toggleVariant = (productId: number) => {
    setSelectedVariantIds((prev) =>
      prev.includes(productId) ? prev.filter((id) => id !== productId) : [...prev, productId].sort((a, b) => a - b),
    )
  }

  const handleSubmit = async () => {
    if (mode === 'barcode') return
    // These two checks are the ONLY upload errors the operator can
    // actually act on (pick a photo / select a variant). Everything
    // else below is server / network / worker plumbing that gets a
    // friendly "we paged Dave" treatment instead of raw stack text.
    if (!file) {
      const msg = 'Pick or capture a photo first.'
      setCardStatus({ kind: 'err', message: msg })
      onError(msg)
      return
    }
    if (mode === 'variants' && selectedVariantIds.length === 0) {
      const msg = 'Select at least one variant before uploading.'
      setCardStatus({ kind: 'err', message: msg })
      onError(msg)
      return
    }
    setIsStaging(true)
    setFailedStagedRef(null)
    setCardStatus({ kind: 'busy', message: 'Uploading photo…' })
    let enqueued = false
    try {
      const formData = new FormData()
      formData.append('targetType', mode === 'group' ? 'group' : 'variants')
      formData.append('groupId', String(group.groupId))
      if (mode === 'variants') {
        formData.append('productIds', JSON.stringify(selectedVariantIds))
      }
      formData.append('file', file)

      const response = await fetch(buildAppPath('/api/catalog/maintenance/images'), {
        body: formData,
        credentials: 'same-origin',
        method: 'POST',
      })
      if (!response.ok) {
        const errorPayload = await maybeReadErrorPayload(response)
        throw new Error(errorPayload ?? `${response.status} ${response.statusText}`)
      }
      const payload = (await response.json()) as {
        status: 'queued'
        jobId: number
        stagedRef: string
        sweedGroupId: number
        targetType: 'group'
      }
      setOptimisticImageUrl(localPreviewUrl ?? null)
      setOptimisticAffectedProductIds([])
      setSyncingReanalysis(true)
      setFile(null)
      if (inputRef.current) inputRef.current.value = ''

      // Bytes safe on the server. Drop the staging gate immediately so
      // THIS card's buttons re-enable for the next photo (sibling
      // cards were never blocked).
      enqueued = true
      setIsPolling(true)
      setCardStatus({ kind: 'busy', message: 'Saving to Sweed…' })
      setIsStaging(false)

      pollUploadJob({
        cardKey: props.cardKey,
        jobId: payload.jobId,
        stagedRef: payload.stagedRef,
        group,
        onPhase: (_message) => {
          // Operator doesn't need step-by-step worker plumbing on a
          // 4-inch screen; "Saving to Sweed…" already tells them
          // what's happening.
          setCardStatus({ kind: 'busy', message: 'Saving to Sweed…' })
        },
        onSuccess: async () => {
          const message = `✓ Photo saved to ${displayGroupName(group)} (${group.siteLabel}).`
          setCardStatus({ kind: 'ok', message })
          await onComplete(message)
        },
        onFailure: (errorMessage, stagedRef) => {
          setFailedStagedRef(stagedRef)
          surfaceUnactionableUploadError({
            context: 'catalog.maintenance.upload.worker-job',
            rawMessage: errorMessage,
            group,
            jobId: payload.jobId,
            stagedRef,
            setCardStatus,
            onError,
          })
        },
      })
        .catch((pollErr) => {
          // pollUploadJob handles known failures via onFailure; this
          // path is for unexpected throws (JSON parse, etc.).
          surfaceUnactionableUploadError({
            context: 'catalog.maintenance.upload.poll-unexpected',
            rawMessage: pollErr instanceof Error ? pollErr.message : String(pollErr),
            group,
            jobId: payload.jobId,
            stagedRef: payload.stagedRef,
            setCardStatus,
            onError,
          })
        })
        .finally(() => setIsPolling(false))
    } catch (error) {
      surfaceUnactionableUploadError({
        context: 'catalog.maintenance.upload.stage',
        rawMessage: error instanceof Error ? error.message : String(error),
        group,
        jobId: null,
        stagedRef: null,
        setCardStatus,
        onError,
      })
    } finally {
      if (!enqueued) {
        setIsStaging(false)
      }
    }
  }

  const handleRetry = async () => {
    if (mode === 'barcode' || failedStagedRef === null) return
    const stagedRef = failedStagedRef
    setIsStaging(true)
    setFailedStagedRef(null)
    setCardStatus({ kind: 'busy', message: 'Re-trying upload…' })
    let enqueued = false
    try {
      const response = await fetch(
        buildAppPath(`/api/catalog/maintenance/images/${encodeURIComponent(stagedRef)}/retry`),
        {
          body: '{}',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          method: 'POST',
        },
      )
      if (!response.ok) {
        const errorPayload = await maybeReadErrorPayload(response)
        throw new Error(errorPayload ?? `${response.status} ${response.statusText}`)
      }
      const payload = (await response.json()) as {
        status: 'queued'
        jobId: number
        stagedRef: string
      }
      enqueued = true
      setIsPolling(true)
      setCardStatus({ kind: 'busy', message: 'Saving to Sweed…' })
      setIsStaging(false)

      pollUploadJob({
        cardKey: props.cardKey,
        jobId: payload.jobId,
        stagedRef: payload.stagedRef,
        group,
        onPhase: () => setCardStatus({ kind: 'busy', message: 'Saving to Sweed…' }),
        onSuccess: async () => {
          const message = `✓ Photo saved to ${displayGroupName(group)} (${group.siteLabel}).`
          setCardStatus({ kind: 'ok', message })
          await onComplete(message)
        },
        onFailure: (errorMessage, failedRef) => {
          setFailedStagedRef(failedRef)
          surfaceUnactionableUploadError({
            context: 'catalog.maintenance.upload.retry-worker-job',
            rawMessage: errorMessage,
            group,
            jobId: payload.jobId,
            stagedRef: failedRef,
            setCardStatus,
            onError,
          })
        },
      })
        .catch((pollErr) => {
          surfaceUnactionableUploadError({
            context: 'catalog.maintenance.upload.retry-poll-unexpected',
            rawMessage: pollErr instanceof Error ? pollErr.message : String(pollErr),
            group,
            jobId: payload.jobId,
            stagedRef: payload.stagedRef,
            setCardStatus,
            onError,
          })
        })
        .finally(() => setIsPolling(false))
    } catch (error) {
      surfaceUnactionableUploadError({
        context: 'catalog.maintenance.upload.retry-stage',
        rawMessage: error instanceof Error ? error.message : String(error),
        group,
        jobId: null,
        stagedRef,
        setCardStatus,
        onError,
      })
    } finally {
      if (!enqueued) {
        setIsStaging(false)
      }
    }
  }

  const fileLabel = file ? `${file.name} (${formatBytes(file.size)})` : 'No photo selected'
  // `cardBusy` gates THIS card's own buttons only. There is no global
  // / cross-card lock — each card runs its own staging + poll lifecycle
  // independently so the operator can fire off multiple uploads in
  // parallel.
  const cardBusy = isStaging || isPolling
  const ctaLabel = cardBusy
    ? mode === 'group'
      ? 'Uploading group photo…'
      : 'Uploading variant photo…'
    : mode === 'group'
      ? 'Upload group photo'
      : `Upload variant photo (${selectedVariantIds.length}/${group.variants.length})`

  const cardPreviewSrc =
    (mode === 'group' ? optimisticImageUrl : null) ?? localPreviewUrl ?? group.groupPreviewImageUrl

  const storefrontTarget = buildStorefrontGroupUrl(group)
  const cardTopClickable = storefrontTarget !== null
  const cardTopAriaLabel = cardTopClickable
    ? `Open ${displayGroupName(group)} on the ${group.siteLabel} storefront in a new tab`
    : undefined

  return (
    <article className="catalog-maintenance-card">
      <div
        className={`catalog-maintenance-card-top${cardTopClickable ? ' catalog-maintenance-card-top--clickable' : ''}`}
        {...(cardTopClickable
          ? {
              role: 'button',
              tabIndex: 0,
              'aria-label': cardTopAriaLabel,
              title: 'Open on storefront',
              onClick: () => offerOpenStorefront(group),
              onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  offerOpenStorefront(group)
                }
              },
            }
          : {})}
      >
        <div className="catalog-maintenance-card-preview">
          {cardPreviewSrc ? (
            <img src={cardPreviewSrc} alt={`${displayGroupName(group)} preview`} loading="lazy" />
          ) : (
            <div className="catalog-maintenance-card-preview-empty">No image</div>
          )}
        </div>
        <div className="catalog-maintenance-card-meta">
          <div className="catalog-maintenance-card-title">
            <strong>{displayGroupName(group)}</strong>
            {group.brandName ? <span className="subtle-copy">{group.brandName}</span> : null}
            <Pill tone="muted">{group.siteLabel}</Pill>
            {(group.needsReanalysis || syncingReanalysis) ? <Pill tone="muted">syncing…</Pill> : null}
          </div>
          <div className="catalog-maintenance-card-tags">
            {group.categoryName ? <Pill tone="muted">{group.categoryName}</Pill> : null}
            {group.subcategoryName ? <Pill tone="muted">{group.subcategoryName}</Pill> : null}
          </div>
          <p className="subtle-copy">{summaryLine}</p>
        </div>
      </div>

      {group.variants.length > 0 ? (
        <div className="catalog-maintenance-variants">
          {mode === 'variants' ? (
            <div className="catalog-maintenance-variants-head">
              <span className="subtle-copy">Attach photo to:</span>
              <button
                type="button"
                className="ghost-button"
                onClick={() => {
                  if (selectedVariantIds.length === group.variants.length) {
                    setSelectedVariantIds([])
                  } else {
                    setSelectedVariantIds(group.variants.map((variant) => variant.productId))
                  }
                }}
              >
                {selectedVariantIds.length === group.variants.length ? 'None' : 'All'}
              </button>
            </div>
          ) : (
            <div className="catalog-maintenance-variants-head">
              <span className="subtle-copy">{mode === 'barcode' ? 'Affected variants:' : 'In-stock variants:'}</span>
            </div>
          )}
          <ul className="catalog-maintenance-variant-list">
            {group.variants.map((variant) => (
              <li key={variant.productId}>
                <VariantRow
                  variant={variant}
                  mode={mode}
                  sweedGroupId={group.groupId}
                  siteKey={group.siteKey}
                  categoryName={group.categoryName}
                  selected={selectedVariantIds.includes(variant.productId)}
                  optimisticPreviewUrl={
                    optimisticAffectedProductIds.includes(variant.productId) ? optimisticImageUrl : null
                  }
                  syncingReanalysis={
                    syncingReanalysis && optimisticAffectedProductIds.includes(variant.productId)
                  }
                  onToggle={() => toggleVariant(variant.productId)}
                  onBarcodeUpdated={(_productId, externalBarcode) => {
                    void onComplete(`Barcode saved for ${variantLabel(variant)}: ${externalBarcode}`)
                  }}
                  onBarcodeError={onError}
                  onPackageMoved={onComplete}
                />
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {mode !== 'barcode' ? (
        <div className="catalog-maintenance-card-actions">
          <input
            ref={inputRef}
            type="file"
            accept="image/*"
            capture="environment"
            className="catalog-maintenance-file-input"
            onChange={(event) => setFile(event.target.files?.[0] ?? null)}
          />
          <button
            type="button"
            className="ghost-button catalog-maintenance-pick"
            onClick={() => inputRef.current?.click()}
            disabled={cardBusy}
          >
            {file ? 'Replace photo' : 'Pick / take a photo'}
          </button>
          <button
            type="button"
            className="primary-button catalog-maintenance-upload"
            onClick={() => void handleSubmit()}
            disabled={cardBusy || !file}
          >
            {ctaLabel}
          </button>
          <p className="subtle-copy catalog-maintenance-file-label">{fileLabel}</p>
        </div>
      ) : null}
      {cardStatus ? (
        <div
          role={cardStatus.kind === 'err' ? 'alert' : 'status'}
          className={`catalog-maintenance-card-status catalog-maintenance-card-status--${cardStatus.kind}`}
          style={{
            border: '1px solid',
            borderRadius: 6,
            padding: '0.5rem 0.75rem',
            marginTop: '0.5rem',
            display: 'flex',
            alignItems: 'flex-start',
            justifyContent: 'space-between',
            gap: '0.5rem',
            background:
              cardStatus.kind === 'ok'
                ? 'rgba(20, 130, 70, 0.12)'
                : cardStatus.kind === 'err'
                  ? 'rgba(180, 30, 30, 0.12)'
                  : 'rgba(100, 100, 100, 0.08)',
            borderColor:
              cardStatus.kind === 'ok'
                ? 'rgb(20, 130, 70)'
                : cardStatus.kind === 'err'
                  ? 'rgb(180, 30, 30)'
                  : 'rgb(150, 150, 150)',
          }}
        >
          <span style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{cardStatus.message}</span>
          <span style={{ flexShrink: 0, display: 'flex', gap: '0.5rem' }}>
            {cardStatus.kind === 'err' && failedStagedRef !== null ? (
              <button
                type="button"
                className="primary-button"
                onClick={() => void handleRetry()}
                disabled={cardBusy}
              >
                Retry
              </button>
            ) : null}
            {cardStatus.kind !== 'busy' ? (
              <button
                type="button"
                className="ghost-button"
                onClick={() => {
                  setCardStatus(null)
                  setFailedStagedRef(null)
                }}
              >
                Dismiss
              </button>
            ) : null}
          </span>
        </div>
      ) : null}
    </article>
  )
}

interface VariantRowProps {
  variant: CatalogMaintenanceSiteVariant
  mode: CardMode
  sweedGroupId: number
  /**
   * Site key from the parent group, used to resolve the Sweed dealer id
   * for the move-package-to-inspection RPC. Without it the per-package
   * action buttons render disabled with a tooltip.
   */
  siteKey: string
  /**
   * Category of the variant's catalog group. Used to suppress the missing-
   * METRC and missing/invalid-barcode warnings for non-cannabis categories
   * (Accessories / Other), where those signals are not error or warning
   * conditions.
   */
  categoryName: string | null
  selected: boolean
  optimisticPreviewUrl: string | null
  syncingReanalysis: boolean
  onToggle: () => void
  onBarcodeUpdated: (productId: number, externalBarcode: string) => void
  onBarcodeError: (message: string) => void
  onPackageMoved: (message: string) => Promise<void>
}

function VariantRow(props: VariantRowProps) {
  const {
    variant,
    mode,
    sweedGroupId,
    siteKey,
    categoryName,
    selected,
    optimisticPreviewUrl,
    syncingReanalysis,
    onToggle,
    onBarcodeUpdated,
    onBarcodeError,
    onPackageMoved,
  } = props
  const cannabisCategory = isCannabisCategory(categoryName)
  const [editingBarcode, setEditingBarcode] = useState(false)
  const [draftBarcode, setDraftBarcode] = useState<string>(variant.externalBarcode ?? '')
  const [savingBarcode, setSavingBarcode] = useState(false)
  const [scanningBarcode, setScanningBarcode] = useState(false)
  const [liveScannerOpen, setLiveScannerOpen] = useState(false)
  const barcodeFileInputRef = useRef<HTMLInputElement | null>(null)

  // Stable callbacks: passing inline lambdas here would change identity
  // on every parent render and re-fire LiveBarcodeScanner's effect,
  // tearing down the camera mid-stream. See LiveBarcodeScanner.tsx
  // for the longer story.
  const handleLiveScannerDetected = useCallback((value: string) => {
    setLiveScannerOpen(false)
    setDraftBarcode(value)
    setEditingBarcode(true)
  }, [])
  const handleLiveScannerCancel = useCallback(() => {
    setLiveScannerOpen(false)
  }, [])

  useEffect(() => {
    setDraftBarcode(variant.externalBarcode ?? '')
  }, [variant.externalBarcode, variant.productId])

  const saveBarcode = async (next: string) => {
    const trimmed = next.trim()
    if (trimmed.length === 0) {
      onBarcodeError('Barcode cannot be empty.')
      return
    }
    if (trimmed === (variant.externalBarcode ?? '')) {
      setEditingBarcode(false)
      return
    }
    setSavingBarcode(true)
    try {
      const response = await fetch(buildAppPath('/api/catalog/maintenance/barcode'), {
        body: JSON.stringify({
          externalBarcode: trimmed,
          productId: variant.productId,
          sweedGroupId,
        }),
        credentials: 'same-origin',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        method: 'POST',
      })
      if (!response.ok) {
        const errorPayload = await maybeReadErrorPayload(response)
        throw new Error(errorPayload ?? `${response.status} ${response.statusText}`)
      }
      const payload = (await response.json()) as { productId: number; externalBarcode: string }
      onBarcodeUpdated(payload.productId, payload.externalBarcode)
      setEditingBarcode(false)
    } catch (error) {
      const raw = error instanceof Error ? error.message : String(error)
      // eslint-disable-next-line no-console
      console.warn('[catalog.maintenance.barcode-save] unexpected', raw)
      reportClientError({
        context: 'catalog.maintenance.barcode-save',
        message: raw,
        detail: { productId: variant.productId, sweedGroupId },
      })
      onBarcodeError('Couldn’t save the barcode right now. Dave has been paged — try again in a moment.')
    } finally {
      setSavingBarcode(false)
    }
  }

  const handleScannedFile = async (file: File) => {
    setScanningBarcode(true)
    try {
      const value = await decodeBarcodeFromImageFile(file)
      if (value === null || value.length === 0) {
        // Actionable: operator can re-aim and retake the photo.
        onBarcodeError('No barcode detected — hold steady, fill the frame, and try again.')
        return
      }
      setDraftBarcode(value)
      setEditingBarcode(true)
    } catch (error) {
      // Unexpected — the decoder helpers normally swallow zxing /
      // BarcodeDetector errors as misses, so anything that reaches
      // here is something the operator can't act on. Page Dave; show
      // a friendly message.
      const raw = error instanceof Error ? error.message : String(error)
      // eslint-disable-next-line no-console
      console.warn('[catalog.maintenance.barcode-scan] unexpected', raw)
      reportClientError({
        context: 'catalog.maintenance.barcode-scan',
        message: raw,
        detail: { productId: variant.productId, sweedGroupId },
      })
      onBarcodeError('Couldn’t read the barcode right now. Dave has been paged — try again in a moment.')
    } finally {
      setScanningBarcode(false)
      if (barcodeFileInputRef.current) barcodeFileInputRef.current.value = ''
    }
  }

  return (
    <div className="catalog-maintenance-variant-row">
      <div className="catalog-maintenance-variant-row-top">
        {mode === 'variants' ? (
          <label className="catalog-maintenance-variant-check">
            <input type="checkbox" checked={selected} onChange={onToggle} />
            <span className="sr-only">Attach photo to {variantLabel(variant)}</span>
          </label>
        ) : null}
        <span className="catalog-maintenance-variant-thumb">
          {optimisticPreviewUrl ? (
            <img src={optimisticPreviewUrl} alt={`${variantLabel(variant)} just-uploaded image`} loading="lazy" />
          ) : variant.previewImageUrl ? (
            <img src={variant.previewImageUrl} alt={`${variantLabel(variant)} variant image`} loading="lazy" />
          ) : (
            <span className="catalog-maintenance-variant-thumb-empty">—</span>
          )}
        </span>
        <span className="catalog-maintenance-variant-text">
          <strong>{variantLabel(variant)}</strong>
          <span className="subtle-copy">
            {optimisticPreviewUrl
              ? 'image just uploaded'
              : variant.variantSpecificImageCount > 0
                ? `${variant.variantSpecificImageCount} own image${variant.variantSpecificImageCount === 1 ? '' : 's'}`
                : 'no variant-specific image'}
            {variant.quantity !== null ? ` · qty ${formatQty(variant.quantity)}` : null}
          </span>
          {syncingReanalysis ? <span className="subtle-copy">· syncing…</span> : null}
        </span>
      </div>

      <div className="catalog-maintenance-variant-row-meta">
        <MetrcTagsLine metrcTags={variant.metrcTags} cannabisCategory={cannabisCategory} />
        <BarcodeLine
          editing={editingBarcode}
          draftValue={draftBarcode}
          currentValue={variant.externalBarcode}
          status={variant.barcodeStatus}
          issueReason={variant.barcodeIssueReason}
          cannabisCategory={cannabisCategory}
          saving={savingBarcode}
          scanning={scanningBarcode}
          onBeginEdit={() => {
            setDraftBarcode(variant.externalBarcode ?? '')
            setEditingBarcode(true)
          }}
          onCancelEdit={() => {
            setEditingBarcode(false)
            setDraftBarcode(variant.externalBarcode ?? '')
          }}
          onChange={setDraftBarcode}
          onSave={() => void saveBarcode(draftBarcode)}
          onPickPhoto={() => barcodeFileInputRef.current?.click()}
          onLiveScan={() => setLiveScannerOpen(true)}
        />
        <input
          ref={barcodeFileInputRef}
          type="file"
          accept="image/*"
          capture="environment"
          className="catalog-maintenance-file-input"
          onChange={(event) => {
            const file = event.target.files?.[0]
            if (file) void handleScannedFile(file)
          }}
        />
        <LiveBarcodeScanner
          open={liveScannerOpen}
          onDetected={handleLiveScannerDetected}
          onCancel={handleLiveScannerCancel}
        />
        <PackagesPanel
          variant={variant}
          siteKey={siteKey}
          onError={onBarcodeError}
          onMoved={onPackageMoved}
        />
      </div>
    </div>
  )
}

/**
 * Per-package list shown under each variant row. Each lot row carries
 * a "Move to Inspection" button that, after a typed confirmation,
 * POSTs to `/api/catalog/maintenance/move-package-to-inspection`. The
 * page-level `onPackageMoved` callback re-fetches the survey on
 * success so the moved lots disappear from the FOR-SALE filter.
 */
function PackagesPanel(props: {
  variant: CatalogMaintenanceSiteVariant
  siteKey: string
  onError: (message: string) => void
  onMoved: (message: string) => Promise<void>
}) {
  const { variant, siteKey, onError, onMoved } = props
  const dealer = HELIOS_PENDING_PURCHASE_SITE_DEALERS.find((s) => s.siteKey === siteKey) ?? null
  const lots = variant.lots ?? []
  const [pendingLot, setPendingLot] = useState<CatalogMaintenancePackageLot | null>(null)
  const [busy, setBusy] = useState(false)
  // Optimistic shelf overrides keyed by inventory-item id. The "Set shelf"
  // flow assigns exactly one package and (unlike Move to Inspection) does NOT
  // re-fetch the whole survey, so we patch the displayed shelf locally for
  // instant feedback.
  const [shelfByItemId, setShelfByItemId] = useState<Record<string, string>>({})
  // Drop the optimistic overrides whenever a fresh survey arrives (new `lots`
  // reference): server data is now authoritative, so we must not keep masking
  // it with a possibly-stale local value (e.g. another operator re-shelved it).
  useEffect(() => {
    setShelfByItemId({})
  }, [variant.lots])
  // Shelf assignment is Midtown-only: the assign route pins the Midtown dealer
  // server-side, so offering it on Bronx lots would silently write the wrong
  // store. Restrict to FOR-SALE, non-trade-sample Midtown lots.
  const canSetShelf = (lot: CatalogMaintenancePackageLot): boolean =>
    siteKey === 'midtown' && lot.isForSale && !lot.isTradeSample

  const handleConfirm = useCallback(async () => {
    if (!pendingLot || !dealer) return
    setBusy(true)
    try {
      const response = await fetch(buildAppPath('/api/catalog/maintenance/move-package-to-inspection'), {
        body: JSON.stringify({
          siteDealerId: dealer.dealerId,
          productId: variant.productId,
          externalTrackCode: pendingLot.externalTrackCode ?? '',
          expectedItemId: pendingLot.itemId,
          expectedLocationName: pendingLot.stockLocationName,
        }),
        credentials: 'same-origin',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        method: 'POST',
      })
      if (!response.ok) {
        const errorPayload = await maybeReadErrorPayload(response)
        throw new Error(errorPayload ?? `${response.status} ${response.statusText}`)
      }
      const parsed = CatalogMaintenanceMovePackageResponseSchema.parse(await response.json())
      setPendingLot(null)
      await onMoved(describeMoveOutcome(parsed, variant, pendingLot))
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }, [dealer, onError, onMoved, pendingLot, variant])

  if (lots.length === 0) {
    // Live verify hadn't returned per-lot detail (or the server failed open).
    // Hide the panel entirely — the operator can still re-trigger Sweed via the
    // existing "Fix cache" button. (Early return AFTER all hooks so hook order
    // stays stable even if a survey refresh flips lots from empty to non-empty.)
    return null
  }

  return (
    <div className="catalog-maintenance-packages">
      <span className="subtle-copy">Packages:</span>
      <ul className="catalog-maintenance-package-list">
        {lots.map((lot) => (
          <li key={lot.itemId} className="catalog-maintenance-package-row">
            <code className="catalog-maintenance-metrc-tag" title={lot.externalTrackCode ?? '(no METRC tag)'}>
              {lot.externalTrackCode ? renderMetrcTagSuffix(lot.externalTrackCode) : '—'}
            </code>
            <span className="subtle-copy">
              {lot.stockLocationName ?? `loc #${lot.stockLocationId ?? '?'}`}
              {lot.availableQty !== null ? ` · qty ${formatQty(lot.availableQty)}` : ''}
              {lot.isTradeSample ? ' · trade sample' : ''}
              {!lot.isForSale ? ' · NOT FOR SALE' : ''}
            </span>
            {canSetShelf(lot) ? (
              <ShelfControl
                itemId={lot.itemId}
                currentShelf={shelfByItemId[lot.itemId] ?? lot.warehouseLocationCode}
                onAssigned={(code) =>
                  setShelfByItemId((prev) => ({ ...prev, [lot.itemId]: code }))
                }
                onError={onError}
              />
            ) : null}
            <button
              type="button"
              className="catalog-maintenance-package-move-btn"
              disabled={busy || !dealer}
              title={
                dealer
                  ? `Move this package into "Hold for Dave inspection" at ${dealer.siteLabel}.`
                  : `Unknown site '${siteKey}' — cannot resolve dealer id.`
              }
              onClick={() => setPendingLot(lot)}
            >
              Move to Inspection
            </button>
          </li>
        ))}
      </ul>
      {pendingLot ? (
        <ConfirmMoveToInspectionModal
          dealerLabel={dealer?.siteLabel ?? siteKey}
          variant={variant}
          lot={pendingLot}
          busy={busy}
          onCancel={() => (busy ? null : setPendingLot(null))}
          onConfirm={handleConfirm}
        />
      ) : null}
    </div>
  )
}

function describeMoveOutcome(
  response: CatalogMaintenanceMovePackageResponse,
  variant: CatalogMaintenanceSiteVariant,
  lot: CatalogMaintenancePackageLot,
): string {
  const label = `${variantLabel(variant)} · ${lot.externalTrackCode ?? lot.itemId}`
  const target = response.targetLocationName
  const movedCount = response.movedLots.length
  if (response.outcome === 'moved-target-lot') {
    return `Moved ${label} → ${target} (${movedCount} lot${movedCount === 1 ? '' : 's'}).`
  }
  if (response.outcome === 'moved-fallback-all-lots') {
    return `Specific package not found in Sweed; moved ALL remaining lots of ${variantLabel(
      variant,
    )} → ${target} (${movedCount} lot${movedCount === 1 ? '' : 's'}).`
  }
  return `Nothing to move for ${label} — Sweed already shows zero stock. Refreshed cache.`
}

/**
 * Per-package "Set shelf" / "Change shelf" control shown under a lot row on
 * the Images & Barcodes page (Midtown FOR-SALE lots only). Reuses the exact
 * warehouse-page shelf picker + assign route so the two never drift.
 *
 * Flow: tap "Set/Change shelf" → inline picker → Save → POST the shared
 * /api/warehouse-locations/assign with this one `inventoryItemId`. On success
 * the shelf line updates optimistically (no full survey re-fetch). If the
 * package is already at a DIFFERENT valid shelf, the server reports a conflict
 * (it does NOT silently overwrite) and we show a plain two-choice modal;
 * "Update" re-submits with `allowReassign`. Real write failures page Dave
 * server-side (see registerWarehouseLocationsRoutes); the operator just sees a
 * friendly error.
 */
function ShelfControl(props: {
  itemId: string
  currentShelf: string | null
  onAssigned: (code: string) => void
  onError: (message: string) => void
}) {
  const { itemId, currentShelf, onAssigned, onError } = props
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [conflict, setConflict] = useState<{ existing: string; target: string } | null>(null)
  // Closes the double-tap / Enter race the `disabled`-on-busy buttons can't
  // fully close (React state lags the event).
  const inFlight = useRef(false)

  const submit = useCallback(
    async (code: string, allowReassign: boolean) => {
      if (inFlight.current) return
      inFlight.current = true
      setBusy(true)
      let outcome: AssignOutcome
      try {
        outcome = await postAssign({
          locationCode: code,
          source: 'images-page',
          inventoryItemId: itemId,
          allowReassign,
        })
      } catch (error) {
        // postAssign catches its own transport/parse errors and returns
        // { ok: false }, so reaching here is a genuinely unexpected client
        // fault — report it (which pages Dave server-side) and surface a
        // friendly, actionable message.
        const raw = error instanceof Error ? error.message : String(error)
        reportClientError({
          context: 'catalog.maintenance.shelf-set',
          message: raw,
          detail: { itemId, code },
        })
        onError('Couldn’t set the shelf right now. Dave has been paged — try again in a moment.')
        return
      } finally {
        inFlight.current = false
        setBusy(false)
      }
      if (!outcome.ok) {
        if (outcome.status === undefined) {
          // No HTTP status → the request never reached the server (network /
          // parse). Dave wasn't paged server-side, so report it (which pages
          // Dave) and show a friendly, actionable message.
          reportClientError({
            context: 'catalog.maintenance.shelf-set',
            message: outcome.error,
            detail: { itemId, code },
          })
          onError('Couldn’t set the shelf right now. Dave has been paged — try again in a moment.')
        } else if (outcome.status >= 500) {
          // Real write failure — already paged Dave server-side; spare the
          // operator the raw Sweed error.
          onError('Couldn’t set the shelf right now. Dave has been paged — try again in a moment.')
        } else {
          // User-correctable 4xx (bad code, package no longer FOR-SALE): show
          // the server's specific, actionable message as-is.
          onError(outcome.error)
        }
        return
      }
      const { packages, conflicts, failures } = outcome.data
      if (conflicts.length > 0) {
        // We target exactly one package, so at most one conflict. The server
        // only raises a conflict for a package already at a DIFFERENT *valid*
        // shelf, so `currentInternalTrackCode` is always present; guard anyway
        // rather than show the operator a fake "(unknown)" shelf.
        const existing = conflicts[0]!.currentInternalTrackCode
        if (!existing) {
          onError('Couldn’t set the shelf — the package’s current shelf is unclear. Please retry.')
          return
        }
        setConflict({ existing, target: code })
        return
      }
      if (packages.length === 0) {
        // Defensive: the single-item path returns a 404 (→ !ok) when nothing
        // matches, so an empty success shouldn't happen — never crash on it.
        onError(failures[0]?.reason ?? 'Couldn’t set the shelf — no package was updated.')
        return
      }
      setConflict(null)
      setOpen(false)
      onAssigned(code)
    },
    [itemId, onAssigned, onError],
  )

  return (
    <div className="catalog-maintenance-shelf">
      <span className="catalog-maintenance-shelf-status subtle-copy">
        Shelf: {currentShelf ? <code>{currentShelf}</code> : 'not set'}
      </span>
      <button
        type="button"
        className="catalog-maintenance-shelf-btn"
        disabled={busy}
        onClick={() => setOpen((value) => !value)}
      >
        {open ? 'Close' : currentShelf ? 'Change shelf' : 'Set shelf'}
      </button>
      {open ? (
        <ShelfEditor
          // Remount when the saved shelf changes so the picker re-seeds from
          // the latest value (useLocationPickerState reads initialCode once).
          key={currentShelf ?? '__none__'}
          currentShelf={currentShelf}
          busy={busy}
          onCancel={() => setOpen(false)}
          onSave={(code) => void submit(code, false)}
        />
      ) : null}
      {conflict ? (
        <ShelfConflictModal
          existing={conflict.existing}
          target={conflict.target}
          busy={busy}
          onKeep={() => {
            // Reflect the package's real (server-reported) shelf so the row
            // stops saying "not set" after the operator declines the move.
            onAssigned(conflict.existing)
            setConflict(null)
            setOpen(false)
          }}
          onUpdate={() => void submit(conflict.target, true)}
        />
      ) : null}
    </div>
  )
}

/** Inline shelf picker (the warehouse picker + a Save/Cancel row). Mounted only
 *  while the editor is open; seeds from the package's current shelf. */
function ShelfEditor(props: {
  currentShelf: string | null
  busy: boolean
  onCancel: () => void
  onSave: (code: string) => void
}) {
  const { currentShelf, busy, onCancel, onSave } = props
  const { prefix, column, row, split, code, setPrefix, changeColumn, changeRow, setSplit } =
    useLocationPickerState(currentShelf)
  return (
    <div className="catalog-maintenance-shelf-editor">
      <LocationPicker
        prefix={prefix}
        column={column}
        row={row}
        split={split}
        onPrefix={setPrefix}
        onColumn={changeColumn}
        onRow={changeRow}
        onSplit={setSplit}
      />
      <div className="wh-current" aria-live="polite">
        <span className="wh-current-label">New shelf</span>
        <span className="wh-current-code">{code ?? '—'}</span>
      </div>
      <div className="catalog-maintenance-shelf-actions">
        <button type="button" className="ghost-button" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button
          type="button"
          className="primary-button"
          disabled={!code || busy}
          onClick={() => code && onSave(code)}
        >
          {busy ? 'Saving…' : 'Save shelf'}
        </button>
      </div>
    </div>
  )
}

/** Plain two-choice conflict modal (no typed confirmation — moving a shelf is
 *  cheap and reversible). Wording is written for nontechnical floor staff. */
function ShelfConflictModal(props: {
  existing: string
  target: string
  busy: boolean
  onKeep: () => void
  onUpdate: () => void
}) {
  const { existing, target, busy, onKeep, onUpdate } = props
  return (
    <div className="wh-modal-overlay" role="dialog" aria-modal="true">
      <div className="wh-modal">
        <h3>This package already has a shelf</h3>
        <p>
          This package is already listed at shelf <code>{existing}</code>. If you’re holding it and
          want to change where it lives, move it to <code>{target}</code>. Otherwise keep it at{' '}
          <code>{existing}</code>.
        </p>
        <div className="wh-modal-actions">
          <button type="button" className="ghost-button" onClick={onKeep} disabled={busy}>
            Keep at {existing}
          </button>
          <button type="button" className="primary-button" onClick={onUpdate} disabled={busy}>
            {busy ? 'Moving…' : `Move to ${target}`}
          </button>
        </div>
      </div>
    </div>
  )
}

/**
 * Typed-confirmation modal. The operator must type the word
 * `INSPECTION` exactly before the destructive "Move" button enables,
 * matching the convention used elsewhere on the site for destructive
 * Sweed writes.
 */
function ConfirmMoveToInspectionModal(props: {
  dealerLabel: string
  variant: CatalogMaintenanceSiteVariant
  lot: CatalogMaintenancePackageLot
  busy: boolean
  onCancel: () => void
  onConfirm: () => void
}) {
  const { dealerLabel, variant, lot, busy, onCancel, onConfirm } = props
  const [typed, setTyped] = useState('')
  const armed = typed.trim().toUpperCase() === 'INSPECTION'
  return (
    <div className="catalog-maintenance-modal-overlay" role="dialog" aria-modal="true">
      <div className="catalog-maintenance-modal">
        <h3>Move package to NOT FOR SALE — Hold for Dave inspection?</h3>
        <p>
          This will use Sweed's <code>store.inventory.item.transfer</code> to drain{' '}
          <strong>{lot.availableQty !== null ? formatQty(lot.availableQty) : 'all qty'}</strong> of{' '}
          <strong>{variantLabel(variant)}</strong> (package{' '}
          <code title={lot.externalTrackCode ?? lot.itemId}>
            {lot.externalTrackCode ?? lot.itemId}
          </code>
          ) out of <strong>{lot.stockLocationName ?? `loc #${lot.stockLocationId ?? '?'}`}</strong>{' '}
          at <strong>{dealerLabel}</strong> and into the dealer's
          "NOT FOR SALE - Hold for Dave inspection" location.
        </p>
        <p>
          If Sweed has already moved or consumed this package, every remaining lot of the
          variant will be drained into Inspection instead so the variant stops appearing
          on the store.
        </p>
        <p>
          Type <code>INSPECTION</code> to confirm:
        </p>
        <input
          type="text"
          autoFocus
          autoComplete="off"
          spellCheck={false}
          value={typed}
          disabled={busy}
          onChange={(event) => setTyped(event.target.value)}
        />
        <div className="catalog-maintenance-modal-actions">
          <button type="button" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className="catalog-maintenance-package-move-btn"
            onClick={onConfirm}
            disabled={!armed || busy}
          >
            {busy ? 'Moving…' : 'Move to Inspection'}
          </button>
        </div>
      </div>
    </div>
  )
}

function MetrcTagsLine(props: { metrcTags?: string[] | null; cannabisCategory: boolean }) {
  const metrcTags = Array.isArray(props.metrcTags) ? props.metrcTags : []
  if (metrcTags.length === 0) {
    // For non-cannabis categories (Accessories / Other) a missing METRC tag
    // is expected — don't surface it as an error or even a warning.
    if (!props.cannabisCategory) {
      return null
    }
    return (
      <span
        className="catalog-maintenance-metrc-line catalog-maintenance-metrc-line--fatal"
        title="No METRC packages are cached for this variant. Use the page-level 'Fix cache' button to enqueue a high-priority refresh from the store-level stock items RPC."
      >
        ⚠ METRC: missing — fix cache to repopulate
      </span>
    )
  }
  return (
    <span className="catalog-maintenance-metrc-line subtle-copy">
      METRC{metrcTags.length > 1 ? ` (${metrcTags.length})` : ''}:{' '}
      {metrcTags.map((tag, index) => (
        <span key={`${tag}:${index}`}>
          {renderMetrcTagSuffix(tag)}
          {index < metrcTags.length - 1 ? ', ' : null}
        </span>
      ))}
    </span>
  )
}

function renderMetrcTagSuffix(tag: string) {
  const cleaned = tag.replace(/\s+/g, '')
  if (cleaned.length === 0) {
    return <code className="catalog-maintenance-metrc-tag">—</code>
  }
  const last5 = cleaned.slice(-5)
  const headLength = Math.max(0, last5.length - 3)
  const head = last5.slice(0, headLength)
  const tail = last5.slice(headLength)
  return (
    <code className="catalog-maintenance-metrc-tag" title={tag}>
      {head}
      <strong>{tail}</strong>
    </code>
  )
}

interface BarcodeLineProps {
  editing: boolean
  draftValue: string
  currentValue: string | null
  status: 'ok' | 'missing' | 'invalid'
  issueReason: string | null
  /**
   * For non-cannabis categories (Accessories / Other) we still let the user
   * see / edit the barcode value, but we never surface "missing" or "invalid"
   * as a warning — those are only error conditions for cannabis categories.
   */
  cannabisCategory: boolean
  saving: boolean
  scanning: boolean
  onBeginEdit: () => void
  onCancelEdit: () => void
  onChange: (next: string) => void
  onSave: () => void
  /** Open the live-camera scanner (preferred path). */
  onLiveScan: () => void
  /** Fall back to picking a still photo (used when camera access is unavailable). */
  onPickPhoto: () => void
}

function BarcodeLine(props: BarcodeLineProps) {
  const {
    editing,
    draftValue,
    currentValue,
    status,
    issueReason,
    cannabisCategory,
    saving,
    scanning,
    onBeginEdit,
    onCancelEdit,
    onChange,
    onSave,
    onLiveScan,
    onPickPhoto,
  } = props
  const showIssueSignal = cannabisCategory && status !== 'ok'

  if (!editing) {
    return (
      <span className="catalog-maintenance-barcode-line">
        <span className="subtle-copy">Barcode:</span>{' '}
        {currentValue ? (
          <code className="catalog-maintenance-barcode-value">{currentValue}</code>
        ) : (
          <span className="subtle-copy">none on file</span>
        )}{' '}
        {showIssueSignal ? (
          <Pill tone="warning">{status === 'missing' ? 'missing' : 'invalid'}</Pill>
        ) : null}
        {showIssueSignal && issueReason ? <span className="subtle-copy"> ({issueReason})</span> : null}{' '}
        <button type="button" className="ghost-button catalog-maintenance-barcode-btn" onClick={onBeginEdit}>
          Edit
        </button>{' '}
        <button
          type="button"
          className="primary-button catalog-maintenance-barcode-btn"
          onClick={onLiveScan}
          disabled={scanning}
          title="Open live camera and auto-grab the barcode"
        >
          📷 Scan barcode
        </button>{' '}
        <button
          type="button"
          className="ghost-button catalog-maintenance-barcode-btn"
          onClick={onPickPhoto}
          disabled={scanning}
          title="Fallback: pick a still photo"
        >
          {scanning ? 'Scanning…' : 'From photo'}
        </button>
      </span>
    )
  }

  return (
    <span className="catalog-maintenance-barcode-line">
      <input
        type="text"
        inputMode="numeric"
        autoComplete="off"
        value={draftValue}
        onChange={(event) => onChange(event.target.value)}
        className="catalog-maintenance-barcode-input"
        placeholder="e.g. 767461887525"
        disabled={saving}
      />
      <button
        type="button"
        className="primary-button catalog-maintenance-barcode-btn"
        onClick={onSave}
        disabled={saving || draftValue.trim().length === 0}
      >
        {saving ? 'Saving…' : 'Save barcode'}
      </button>
      <button
        type="button"
        className="ghost-button catalog-maintenance-barcode-btn"
        onClick={onCancelEdit}
        disabled={saving}
      >
        Cancel
      </button>
      <button
        type="button"
        className="ghost-button catalog-maintenance-barcode-btn"
        onClick={onLiveScan}
        disabled={saving || scanning}
        title="Open live camera and auto-grab the barcode"
      >
        📷 Scan
      </button>
      <button
        type="button"
        className="ghost-button catalog-maintenance-barcode-btn"
        onClick={onPickPhoto}
        disabled={saving || scanning}
        title="Fallback: pick a still photo"
      >
        {scanning ? 'Scanning…' : 'From photo'}
      </button>
    </span>
  )
}

interface BarcodeDetectionResult {
  rawValue?: string
  format?: string
}

interface BarcodeDetectorCtor {
  new (options?: { formats?: string[] }): {
    detect: (source: CanvasImageSource | ImageBitmap | Blob | ImageData) => Promise<BarcodeDetectionResult[]>
  }
}

/**
 * Decode a barcode value from an image file taken/picked by the user.
 *
 * Tries the native `BarcodeDetector` API first (fast, zero-bundle on
 * Chrome / Android). If that misses OR throws, falls back to a
 * lazily-imported `@zxing/browser` decoder which is slower but
 * dramatically more tolerant of motion blur, off-axis angles, glare,
 * and tight crops — the exact conditions an operator hits standing in
 * a store aisle one-handing their phone at a package.
 *
 * This double-tap was previously either/or based on API availability,
 * which made scanning brittle on Chrome / Android (the common case):
 * any single BarcodeDetector miss surfaced as a hard "no barcode
 * detected" toast even when zxing would have happily decoded the
 * exact same image. Now both decoders get a shot before we give up.
 *
 * Returns the decoded string on success, or `null` if BOTH decoders
 * came up empty. Never throws for routine misses or decoder hiccups —
 * the caller treats `null` as "ask the operator to retake the photo".
 */
async function decodeBarcodeFromImageFile(file: File): Promise<string | null> {
  const native = await tryNativeBarcodeDetector(file)
  if (native !== null && native.length > 0) return native
  const zxing = await tryZxingDecode(file)
  if (zxing !== null && zxing.length > 0) return zxing
  return null
}

async function tryNativeBarcodeDetector(file: File): Promise<string | null> {
  const Detector = (window as unknown as { BarcodeDetector?: BarcodeDetectorCtor }).BarcodeDetector
  if (!Detector) return null
  let bitmap: ImageBitmap | null = null
  try {
    const detector = new Detector({
      formats: ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'itf', 'codabar', 'qr_code'],
    })
    bitmap = await createImageBitmap(file)
    const detections = await detector.detect(bitmap)
    if (detections.length === 0) return null
    return detections[0]?.rawValue?.trim() ?? null
  } catch (error) {
    // Some Android Chrome builds advertise BarcodeDetector but throw
    // NotSupportedError or hit codec issues on certain JPEG profiles.
    // Treat any failure as a miss and let zxing have a go.
    // eslint-disable-next-line no-console
    console.warn('[barcode-scan] native BarcodeDetector threw, falling back to zxing', error)
    return null
  } finally {
    bitmap?.close?.()
  }
}

async function tryZxingDecode(file: File): Promise<string | null> {
  // Dynamic-import keeps the ~200 KB zxing bundle out of the main
  // chunk; it's only paid for when a scan actually happens.
  // importChunkOrReload defends against stale-bundle scenarios:
  // an open tab whose old chunk hash has been deleted by a redeploy
  // would otherwise blow up with "Importing a module script failed"
  // here; we instead force a clean cache-busted reload.
  const { BrowserMultiFormatReader } = await importChunkOrReload(
    () => import('@zxing/browser'),
    '@zxing/browser (tryZxingDecode)',
  )
  const objectUrl = URL.createObjectURL(file)
  const img = new Image()
  try {
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve()
      img.onerror = () => reject(new Error('Failed to load image for barcode decode.'))
      img.src = objectUrl
    })
    const reader = new BrowserMultiFormatReader()
    try {
      const result = await reader.decodeFromImageElement(img)
      return result.getText().trim()
    } catch (error) {
      // NotFoundException is a clean miss.
      const name = (error as { name?: string } | null)?.name ?? ''
      if (name === 'NotFoundException' || name === 'NotFoundException2') return null
      // Unexpected throw: log and treat as miss. Showing the operator
      // a stack-y zxing message is worse than telling them to retake.
      // eslint-disable-next-line no-console
      console.warn('[barcode-scan] zxing decoder threw', error)
      return null
    }
  } finally {
    URL.revokeObjectURL(objectUrl)
  }
}

/**
 * Category names for which missing METRC tags and missing/invalid barcodes
 * are NOT error or warning conditions. Must stay in sync with the server-side
 * NON_CANNABIS_CATEGORY_NAMES set in src/server/catalog/maintenance.ts.
 */
const NON_CANNABIS_CATEGORY_NAMES = new Set<string>(['Accessories', 'Other'])

function isCannabisCategory(categoryName: string | null): boolean {
  if (categoryName === null) return true
  return !NON_CANNABIS_CATEGORY_NAMES.has(categoryName.trim())
}

function displayGroupName(group: CatalogMaintenanceSiteGroup): string {
  return group.groupName ?? `Group #${group.groupId}`
}

/**
 * Build the public-facing Freshly Baked storefront URL we want to open
 * for a group. Preference order, picking the most exact-content link
 * we have enough metadata to build:
 *
 *   1. Brand + category filter — when both `brandId` and `categoryId`
 *      are known, link to the category page with the brand filter
 *      applied (Sweed: `/menu/<slug>-<categoryId>?filters={"brand":[brandId]}`).
 *      Same brand within the same category: a small, stable, known-
 *      content set the operator can scan visually.
 *
 *   2. Brand-only filter — when only `brandId` is known, link to the
 *      menu page with the brand filter applied (Sweed:
 *      `/menu?filters={"brand":[brandId]}`). Stable, brand-scoped.
 *
 *   3. PDP fallback — when neither id is known (older catalog_groups
 *      rows that haven't been re-synced yet), fall back to a specific
 *      product PDP URL built from the group's first variant. The
 *      trailing `-<productId>` is what the Sweed router resolves on;
 *      slugs are decorative.
 *
 * Returns `null` only for sites whose storefront slug we don't know.
 */
function buildStorefrontGroupUrl(group: CatalogMaintenanceSiteGroup): {
  url: string
  kind: 'brand+category' | 'brand' | 'pdp'
} | null {
  const storeSlug = resolveStorefrontSlug(group.siteKey)
  if (storeSlug === null) return null

  if (group.brandId !== null) {
    const filterParam = encodeURIComponent(JSON.stringify({ brand: [group.brandId] }))
    if (group.categoryId !== null) {
      const categorySlug = toUrlSlug(group.categoryName ?? '') || 'category'
      return {
        kind: 'brand+category',
        url: `https://freshlybaked.nyc/stores/${storeSlug}/shop/menu/${categorySlug}-${group.categoryId}?filters=${filterParam}`,
      }
    }
    return {
      kind: 'brand',
      url: `https://freshlybaked.nyc/stores/${storeSlug}/shop/menu?filters=${filterParam}`,
    }
  }

  // No brand id available — fall back to a per-variant PDP deep-link
  // so we at least open something contextual (rather than the menu home).
  const firstVariant = group.variants[0]
  if (!firstVariant) return null
  const categorySlug = toUrlSlug(group.categoryName ?? '') || '_'
  const baseSlug = toUrlSlug(firstVariant.shortName ?? firstVariant.name ?? group.groupName ?? '') || 'p'
  return {
    kind: 'pdp',
    url: `https://freshlybaked.nyc/stores/${storeSlug}/shop/menu/${categorySlug}/${baseSlug}-${firstVariant.productId}`,
  }
}

function resolveStorefrontSlug(siteKey: string): string | null {
  const normalized = siteKey.trim().toLowerCase()
  if (normalized === 'midtown' || normalized.includes('midtown')) return 'midtown'
  if (normalized === 'bronx' || normalized.includes('bronx')) return 'bronx'
  return null
}

function toUrlSlug(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/**
 * Click handler for the product card top region. Offers (does not silently
 * navigate) to open the Sweed storefront in a new tab. Uses
 * `window.confirm` for a reliable, mobile-friendly prompt that doesn't
 * require adding any extra UI state.
 */
function offerOpenStorefront(group: CatalogMaintenanceSiteGroup): void {
  const target = buildStorefrontGroupUrl(group)
  if (!target) return
  const groupLabel = displayGroupName(group)
  const brandLabel = group.brandName ?? 'this brand'
  const categoryLabel = group.categoryName ?? 'this category'
  const message =
    target.kind === 'brand+category'
      ? `Open ${brandLabel} in ${categoryLabel} on the ${group.siteLabel} storefront in a new tab?`
      : target.kind === 'brand'
        ? `Open all ${brandLabel} products on the ${group.siteLabel} storefront in a new tab?`
        : `Open ${groupLabel} on the ${group.siteLabel} storefront in a new tab?`
  const confirmed = window.confirm(message)
  if (!confirmed) return
  window.open(target.url, '_blank', 'noopener,noreferrer')
}

function variantLabel(variant: CatalogMaintenanceSiteVariant): string {
  const parts: string[] = []
  if (variant.shortName) {
    parts.push(variant.shortName)
  } else if (variant.name) {
    parts.push(variant.name)
  } else {
    parts.push(`#${variant.productId}`)
  }
  if (variant.sizeName) parts.push(variant.sizeName)
  if (variant.packOfSize && variant.packOfSize > 1) parts.push(`pack of ${variant.packOfSize}`)
  if (variant.tab) parts.push(`tab: ${variant.tab}`)
  return parts.join(' · ')
}

function buildSummaryLine(group: CatalogMaintenanceSiteGroup, mode: CardMode): string {
  const parts: string[] = []
  parts.push(`${group.variants.length} variant${group.variants.length === 1 ? '' : 's'} in stock at ${group.siteLabel}`)
  parts.push(`${group.groupImageCount} group image${group.groupImageCount === 1 ? '' : 's'}`)
  if (mode !== 'barcode') {
    const variantsWithImages = group.variants.filter((variant) => variant.variantSpecificImageCount > 0).length
    parts.push(`${variantsWithImages}/${group.variants.length} variants have own image`)
  }
  const totalQty = group.variants.reduce((acc, v) => acc + (v.quantity ?? 0), 0)
  if (totalQty > 0) {
    parts.push(`total qty ${formatQty(totalQty)}`)
  }
  return parts.join(' · ')
}

function formatQty(value: number): string {
  if (!Number.isFinite(value)) return '?'
  return Number.isInteger(value) ? String(value) : value.toFixed(2)
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
}

function formatRelativeTime(iso: string): string {
  const generated = Date.parse(iso)
  if (!Number.isFinite(generated)) return iso
  const seconds = Math.max(0, Math.floor((Date.now() - generated) / 1000))
  if (seconds < 60) return `${seconds}s ago`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`
  return `${Math.floor(seconds / 86_400)}d ago`
}

async function maybeReadErrorPayload(response: Response): Promise<string | null> {
  try {
    const payload = (await response.json()) as { error?: string }
    return typeof payload.error === 'string' ? payload.error : null
  } catch {
    return null
  }
}

/**
 * Fire-and-forget POST to /api/client-errors. The server logs the
 * report and (rate-limited) pages Dave. We never block the UI on this
 * or surface the response — the whole point of paging Dave is that
 * the operator is freed from caring about plumbing failures they
 * can't fix.
 */
function reportClientError(input: {
  context: string
  message: string
  detail?: Record<string, string | number | boolean | null>
}): void {
  try {
    void fetch(buildAppPath('/api/client-errors'), {
      body: JSON.stringify({
        context: input.context,
        message: input.message.slice(0, 4000),
        detail: input.detail,
      }),
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      keepalive: true,
      method: 'POST',
    }).catch(() => {
      // Intentionally swallow — see jsdoc above. We still log to the
      // console so a developer with devtools open can see what was
      // intended to be reported.
      // eslint-disable-next-line no-console
      console.warn('[reportClientError] failed to deliver', input)
    })
  } catch {
    // window.fetch isn't available (extremely unlikely in our
    // supported browsers); silently no-op.
  }
}

/**
 * Friendly, action-oriented status text + Dave-paging for upload
 * errors the operator can't actually fix from the phone (network blip,
 * Sweed token died mid-PUT, worker job dead-lettered, etc.). The raw
 * `rawMessage` is sent to the server (and logged to the browser
 * console) so engineers can debug; the operator just sees "Couldn't
 * save this photo right now — Dave has been paged. Tap Retry to try
 * again."
 */
function surfaceUnactionableUploadError(input: {
  context: string
  rawMessage: string
  group: CatalogMaintenanceSiteGroup
  jobId: number | null
  stagedRef: string | null
  setCardStatus: (status: { kind: 'ok' | 'err' | 'busy'; message: string }) => void
  onError: (message: string) => void
}): void {
  // Console log gives a developer with devtools open the full raw
  // detail without polluting the visible UI.
  // eslint-disable-next-line no-console
  console.warn(`[${input.context}] ${input.rawMessage}`, {
    groupId: input.group.groupId,
    siteKey: input.group.siteKey,
    jobId: input.jobId,
    stagedRef: input.stagedRef,
  })

  reportClientError({
    context: input.context,
    message: input.rawMessage,
    detail: {
      groupId: input.group.groupId,
      siteKey: input.group.siteKey,
      jobId: input.jobId,
      stagedRef: input.stagedRef,
    },
  })

  const friendly =
    input.stagedRef !== null
      ? 'Couldn’t save this photo right now. Dave has been paged. Tap Retry to try again.'
      : 'Couldn’t upload this photo right now. Dave has been paged. Try again in a moment.'
  input.setCardStatus({ kind: 'err', message: friendly })
  input.onError(friendly)
}

/**
 * Poll /api/jobs/:jobId for the catalog.maintenance.upload_group_image
 * job until it reaches a terminal state. Reports per-phase progress via
 * `onPhase`. Resolves silently on success/failure (callers handle the
 * banner state via the provided callbacks).
 */
const UPLOAD_JOB_POLL_INTERVAL_MS = 1500
const UPLOAD_JOB_POLL_TIMEOUT_MS = 5 * 60 * 1000

async function pollUploadJob(input: {
  cardKey: string
  jobId: number
  stagedRef: string
  group: CatalogMaintenanceSiteGroup
  onPhase: (message: string) => void
  onSuccess: () => Promise<void> | void
  onFailure: (errorMessage: string, stagedRef: string) => void
}): Promise<void> {
  const startedAt = Date.now()
  let lastPhaseMessage = ''
  // Reference cardKey + group to keep them in the closure for future
  // debug-logging hooks without tripping unused-locals lint.
  void input.cardKey
  void input.group
  while (true) {
    if (Date.now() - startedAt > UPLOAD_JOB_POLL_TIMEOUT_MS) {
      input.onFailure(
        `Upload job #${input.jobId} did not finish within ${Math.round(UPLOAD_JOB_POLL_TIMEOUT_MS / 1000)}s.`,
        input.stagedRef,
      )
      return
    }
    let response: Response
    try {
      response = await fetch(buildAppPath(`/api/jobs/${input.jobId}`), {
        credentials: 'same-origin',
        headers: { Accept: 'application/json' },
      })
    } catch (err) {
      // Transient network blip — wait and retry.
      await delay(UPLOAD_JOB_POLL_INTERVAL_MS)
      void err
      continue
    }
    if (!response.ok) {
      const errorPayload = await maybeReadErrorPayload(response)
      input.onFailure(
        errorPayload ?? `Failed to poll job #${input.jobId}: HTTP ${response.status}.`,
        input.stagedRef,
      )
      return
    }
    const payload = (await response.json()) as {
      job: {
        status: 'queued' | 'running' | 'succeeded' | 'failed' | 'dead_letter'
        lastError: string | null
      }
      progress: {
        phase?: string | null
        phaseIndex?: number | null
        phaseCount?: number | null
        message?: string | null
      } | null
    }
    const phaseMessage = formatUploadJobPhase(payload.job.status, payload.progress, input.jobId)
    if (phaseMessage !== lastPhaseMessage) {
      input.onPhase(phaseMessage)
      lastPhaseMessage = phaseMessage
    }
    if (payload.job.status === 'succeeded') {
      await input.onSuccess()
      return
    }
    if (payload.job.status === 'failed' || payload.job.status === 'dead_letter') {
      input.onFailure(
        payload.job.lastError ?? `Job #${input.jobId} ${payload.job.status} without an error message.`,
        input.stagedRef,
      )
      return
    }
    await delay(UPLOAD_JOB_POLL_INTERVAL_MS)
  }
}

function formatUploadJobPhase(
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'dead_letter',
  progress:
    | { phase?: string | null; phaseIndex?: number | null; phaseCount?: number | null; message?: string | null }
    | null,
  jobId: number,
): string {
  if (status === 'queued') {
    return `Queued (job #${jobId}) — waiting for a Sweed session pool token…`
  }
  if (status === 'running' && progress) {
    const stepFragment =
      progress.phaseIndex != null && progress.phaseCount != null
        ? `Step ${progress.phaseIndex}/${progress.phaseCount}: `
        : ''
    const messageFragment = progress.message ?? progress.phase ?? 'running'
    return `${stepFragment}${messageFragment}`
  }
  if (status === 'running') {
    return `Running (job #${jobId})…`
  }
  return `Job #${jobId} ${status}.`
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

void displayGroupName

// `displayGroupName` is reused by the upload-completion toast string; keep
// the export-style reference above to satisfy TS's unused-symbol lint
// when the function appears only inside JSX template literals during
// future refactors. Cheap, side-effect-free.
