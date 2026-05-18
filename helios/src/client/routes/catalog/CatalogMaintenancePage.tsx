import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'

import {
  CatalogMaintenanceSurveyResponseSchema,
  type CatalogMaintenanceCacheRepairResponse,
  type CatalogMaintenanceFatalBanner,
  type CatalogMaintenanceSectionKind,
  type CatalogMaintenanceSiteGroup,
  type CatalogMaintenanceSiteVariant,
  type CatalogMaintenanceSurveyResponse,
} from '../../../shared/contracts/index.js'
import { buildAppPath } from '../../app/paths.js'
import { buildHeliosModulePath } from '../../../shared/contracts/index.js'
import { Pill } from '../../components/Pill.js'
import { useRegisterCatalogSidebarSubtree } from './catalogSidebarSubtree.js'

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

const PAGE_PATH = buildHeliosModulePath('catalog', 'maintenance')

export function CatalogMaintenancePage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const activeBrand = searchParams.get('brand')
  const navigate = useNavigate()
  const [state, setState] = useState<SurveyState>(INITIAL_STATE)
  const [busyGroupKey, setBusyGroupKey] = useState<string | null>(null)
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

  // Compute sidebar metadata once we have the survey.
  const sidebarOptions = useMemo(() => {
    const survey = state.survey
    if (!survey) return undefined
    const siteAnchors = survey.sites
      .filter((site) => site.totalIssueCount > 0)
      .map((site) => ({
        siteKey: site.siteKey,
        siteLabel: site.siteLabel,
        targetId: site.targetId,
        count: site.totalIssueCount,
      }))
    return {
      siteAnchors,
      brandQuickFilters: survey.quickFilters.brands,
      activeBrand,
      imagesAndBarcodesPath: PAGE_PATH,
    }
  }, [state.survey, activeBrand])

  useRegisterCatalogSidebarSubtree({ imagesAndBarcodes: sidebarOptions })

  const handleUploadComplete = useCallback(
    async (message: string) => {
      setFeedback({ kind: 'ok', message })
      await fetchSurvey(true)
    },
    [fetchSurvey],
  )

  const handleUploadError = useCallback((message: string) => {
    setFeedback({ kind: 'err', message })
  }, [])

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

  const handleBrandFilter = (brand: string | null) => {
    if (brand === null) {
      searchParams.delete('brand')
    } else {
      searchParams.set('brand', brand)
    }
    setSearchParams(searchParams, { replace: true })
  }

  const filteredSurvey = useMemo(() => filterSurveyByBrand(state.survey, activeBrand), [state.survey, activeBrand])

  return (
    <section className="catalog-maintenance-page">
      <div className="page-header">
        <div>
          <p className="eyebrow">Catalog Module</p>
          <h2>Images &amp; Barcodes</h2>
          <p className="subtle-copy">
            In-stock SKUs whose Sweed product group has no image, or whose package barcode is missing.
            Tap a card to upload or capture a photo and Helios will attach it to the group for you.
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
              busyGroupKey={busyGroupKey}
              setBusyGroupKey={setBusyGroupKey}
              onComplete={handleUploadComplete}
              onError={handleUploadError}
            />
          ))
        : null}

      {filteredSurvey && filteredSurvey.sites.every((s) => s.totalIssueCount === 0) ? (
        <p className="subtle-copy">No issues to address for the active filter.</p>
      ) : null}
    </section>
  )
}

function filterSurveyByBrand(
  survey: CatalogMaintenanceSurveyResponse | null,
  activeBrand: string | null,
): CatalogMaintenanceSurveyResponse | null {
  if (!survey) return null
  if (!activeBrand) return survey
  return {
    ...survey,
    sites: survey.sites.map((site) => ({
      ...site,
      sections: site.sections.map((section) => {
        const groups = section.groups.filter((g) => g.brandName === activeBrand)
        return { ...section, groups, issueCount: groups.length }
      }),
      totalIssueCount: site.sections.reduce(
        (acc, s) => acc + s.groups.filter((g) => g.brandName === activeBrand).length,
        0,
      ),
    })),
  }
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
  busyGroupKey: string | null
  setBusyGroupKey: (key: string | null) => void
  onComplete: (message: string) => Promise<void>
  onError: (message: string) => void
}

function SiteSection({ site, busyGroupKey, setBusyGroupKey, onComplete, onError }: SiteSectionProps) {
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
          busyGroupKey={busyGroupKey}
          setBusyGroupKey={setBusyGroupKey}
          onComplete={onComplete}
          onError={onError}
        />
      ))}
    </section>
  )
}

interface SectionBlockProps {
  section: CatalogMaintenanceSurveyResponse['sites'][number]['sections'][number]
  busyGroupKey: string | null
  setBusyGroupKey: (key: string | null) => void
  onComplete: (message: string) => Promise<void>
  onError: (message: string) => void
}

function SectionBlock({ section, busyGroupKey, setBusyGroupKey, onComplete, onError }: SectionBlockProps) {
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
                  busy={busyGroupKey === key}
                  disabled={busyGroupKey !== null && busyGroupKey !== key}
                  onUploadStart={() => setBusyGroupKey(key)}
                  onUploadEnd={() => setBusyGroupKey(null)}
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
  busy: boolean
  disabled: boolean
  onUploadStart: () => void
  onUploadEnd: () => void
  onComplete: (message: string) => Promise<void>
  onError: (message: string) => void
}

function MaintenanceCard(props: CardProps) {
  const { mode, group, busy, disabled, onUploadStart, onUploadEnd, onComplete, onError } = props
  const [file, setFile] = useState<File | null>(null)
  const [localPreviewUrl, setLocalPreviewUrl] = useState<string | null>(null)
  const [selectedVariantIds, setSelectedVariantIds] = useState<number[]>(() =>
    group.variants.map((variant) => variant.productId),
  )
  const [optimisticImageUrl, setOptimisticImageUrl] = useState<string | null>(null)
  const [optimisticAffectedProductIds, setOptimisticAffectedProductIds] = useState<readonly number[]>([])
  const [syncingReanalysis, setSyncingReanalysis] = useState(false)
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
    onUploadStart()
    setFailedStagedRef(null)
    setCardStatus({ kind: 'busy', message: 'Staging bytes on the server…' })
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

      await pollUploadJob({
        cardKey: props.cardKey,
        jobId: payload.jobId,
        stagedRef: payload.stagedRef,
        group,
        onPhase: (message) => setCardStatus({ kind: 'busy', message }),
        onSuccess: async () => {
          const message = `✓ Group image attached to ${displayGroupName(group)} (${group.siteLabel}). Sweed confirmed the blob is on the group.`
          setCardStatus({ kind: 'ok', message })
          await onComplete(message)
        },
        onFailure: (errorMessage, stagedRef) => {
          setFailedStagedRef(stagedRef)
          setCardStatus({
            kind: 'err',
            message: `✗ ${errorMessage} — bytes are still staged; click Retry to re-enqueue.`,
          })
          onError(errorMessage)
        },
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Upload failed.'
      setCardStatus({ kind: 'err', message: `✗ ${message}` })
      onError(message)
    } finally {
      onUploadEnd()
    }
  }

  const handleRetry = async () => {
    if (mode === 'barcode' || failedStagedRef === null) return
    const stagedRef = failedStagedRef
    onUploadStart()
    setFailedStagedRef(null)
    setCardStatus({ kind: 'busy', message: `Re-enqueuing upload from staged bytes ${stagedRef}…` })
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
      await pollUploadJob({
        cardKey: props.cardKey,
        jobId: payload.jobId,
        stagedRef: payload.stagedRef,
        group,
        onPhase: (message) => setCardStatus({ kind: 'busy', message }),
        onSuccess: async () => {
          const message = `✓ Group image attached to ${displayGroupName(group)} (${group.siteLabel}). Sweed confirmed the blob is on the group.`
          setCardStatus({ kind: 'ok', message })
          await onComplete(message)
        },
        onFailure: (errorMessage, failedRef) => {
          setFailedStagedRef(failedRef)
          setCardStatus({
            kind: 'err',
            message: `✗ ${errorMessage} — bytes are still staged; click Retry to re-enqueue.`,
          })
          onError(errorMessage)
        },
      })
    } catch (error) {
      // 404 here usually means the staged bytes were GC'd. Re-prompt
      // for a file pick.
      const message = error instanceof Error ? error.message : 'Retry failed.'
      setCardStatus({ kind: 'err', message: `✗ Retry failed: ${message}` })
      onError(message)
    } finally {
      onUploadEnd()
    }
  }

  const fileLabel = file ? `${file.name} (${formatBytes(file.size)})` : 'No photo selected'
  const ctaLabel = busy
    ? mode === 'group'
      ? 'Uploading group photo…'
      : 'Uploading variant photo…'
    : mode === 'group'
      ? 'Upload group photo'
      : `Upload variant photo (${selectedVariantIds.length}/${group.variants.length})`

  const cardPreviewSrc =
    (mode === 'group' ? optimisticImageUrl : null) ?? localPreviewUrl ?? group.groupPreviewImageUrl

  const storefrontUrl = buildStorefrontGroupUrl(group.siteKey, group)
  const cardTopClickable = storefrontUrl !== null
  const cardTopAriaLabel = cardTopClickable
    ? `Open ${displayGroupName(group)} on the ${group.siteLabel} storefront in a new tab`
    : undefined

  return (
    <article className={`catalog-maintenance-card${disabled ? ' is-disabled' : ''}`}>
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
            disabled={busy || disabled}
          >
            {file ? 'Replace photo' : 'Pick / take a photo'}
          </button>
          <button
            type="button"
            className="primary-button catalog-maintenance-upload"
            onClick={() => void handleSubmit()}
            disabled={busy || disabled || !file}
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
                disabled={busy || disabled}
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
}

function VariantRow(props: VariantRowProps) {
  const {
    variant,
    mode,
    sweedGroupId,
    categoryName,
    selected,
    optimisticPreviewUrl,
    syncingReanalysis,
    onToggle,
    onBarcodeUpdated,
    onBarcodeError,
  } = props
  const cannabisCategory = isCannabisCategory(categoryName)
  const [editingBarcode, setEditingBarcode] = useState(false)
  const [draftBarcode, setDraftBarcode] = useState<string>(variant.externalBarcode ?? '')
  const [savingBarcode, setSavingBarcode] = useState(false)
  const [scanningBarcode, setScanningBarcode] = useState(false)
  const barcodeFileInputRef = useRef<HTMLInputElement | null>(null)

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
      const message = error instanceof Error ? error.message : 'Failed to save barcode.'
      onBarcodeError(message)
    } finally {
      setSavingBarcode(false)
    }
  }

  const handleScannedFile = async (file: File) => {
    setScanningBarcode(true)
    try {
      const value = await decodeBarcodeFromImageFile(file)
      if (value === null) {
        onBarcodeError('No barcode detected in that photo. Hold steady and fill the frame.')
        return
      }
      if (value.length === 0) {
        onBarcodeError('Decoded barcode was empty.')
        return
      }
      setDraftBarcode(value)
      setEditingBarcode(true)
    } catch (error) {
      onBarcodeError(error instanceof Error ? error.message : 'Failed to read barcode photo.')
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
          className="ghost-button catalog-maintenance-barcode-btn"
          onClick={onPickPhoto}
          disabled={scanning}
          title="Capture a photo of the barcode"
        >
          {scanning ? 'Scanning…' : '📷 Scan barcode'}
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
        onClick={onPickPhoto}
        disabled={saving || scanning}
      >
        {scanning ? 'Scanning…' : '📷 Scan'}
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
 * Prefers the native `BarcodeDetector` API (Chrome on Android / desktop Chrome)
 * because it's fast and zero-bundle. On browsers that don't ship it — most
 * notably iOS Safari — falls back to a lazily-imported `@zxing/browser`
 * decoder so iPhone users get the same one-tap scan flow.
 *
 * Returns the decoded string on success, `null` if no barcode was found,
 * or throws if decoding blew up unexpectedly.
 */
async function decodeBarcodeFromImageFile(file: File): Promise<string | null> {
  const Detector = (window as unknown as { BarcodeDetector?: BarcodeDetectorCtor }).BarcodeDetector
  if (Detector) {
    const detector = new Detector({
      formats: ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'itf', 'codabar', 'qr_code'],
    })
    const bitmap = await createImageBitmap(file)
    try {
      const detections = await detector.detect(bitmap)
      if (detections.length === 0) return null
      const value = detections[0]?.rawValue?.trim() ?? ''
      return value
    } finally {
      bitmap.close?.()
    }
  }

  // Fallback path: dynamic-import keeps the ~200 KB zxing bundle out of the
  // main chunk; it's only fetched on devices that actually need it (iOS).
  const { BrowserMultiFormatReader } = await import('@zxing/browser')
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
      // zxing throws NotFoundException when nothing decoded — treat as miss.
      const name = (error as { name?: string } | null)?.name ?? ''
      if (name === 'NotFoundException' || name === 'NotFoundException2') return null
      throw error
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
 * Build the public-facing Freshly Baked storefront URL for a group. The
 * Sweed storefront only routes to a product page via slug+id URLs (e.g.
 * `/edibles-1086/indica-chill-wild-berry-20x-5mg-41788`); a productId-only
 * deep-link silently lands on the menu (or a "not found" SPA state) for
 * many ids — including any product that isn't currently in that site's
 * inventory snapshot. We don't have the slug or category id client-side,
 * so instead we send the operator to the menu search filtered by the
 * group's name, which always resolves to a usable storefront page.
 *
 * Returns `null` for sites whose storefront slug we don't know or for
 * groups without a usable search term.
 */
function buildStorefrontGroupUrl(siteKey: string, group: CatalogMaintenanceSiteGroup): string | null {
  const normalized = siteKey.trim().toLowerCase()
  let storeSlug: string | null = null
  if (normalized === 'midtown' || normalized.includes('midtown')) storeSlug = 'midtown'
  else if (normalized === 'bronx' || normalized.includes('bronx')) storeSlug = 'bronx'
  if (storeSlug === null) return null
  const searchTerm = (group.groupName ?? '').trim()
  if (searchTerm.length === 0) return null
  const params = new URLSearchParams({ searchTerm })
  return `https://freshlybaked.nyc/stores/${storeSlug}/shop/menu/search?${params.toString()}`
}

/**
 * Click handler for the product card top region. Offers (does not silently
 * navigate) to open the Sweed storefront search for this group in a new
 * tab. Uses `window.confirm` for a reliable, mobile-friendly prompt that
 * doesn't require adding any extra UI state.
 */
function offerOpenStorefront(group: CatalogMaintenanceSiteGroup): void {
  const url = buildStorefrontGroupUrl(group.siteKey, group)
  if (!url) return
  const confirmed = window.confirm(
    `Find "${displayGroupName(group)}" on the ${group.siteLabel} storefront in a new tab?`,
  )
  if (!confirmed) return
  window.open(url, '_blank', 'noopener,noreferrer')
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
