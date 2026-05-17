import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
            In-stock SKUs whose Sweed group has no image, whose variants don&apos;t each have their own image,
            or whose package barcode is missing or invalid. Tap a card to upload or capture a photo and Helios
            will attach it for you.
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
  const mode: CardMode =
    section.kind === 'missing-catalog-image'
      ? 'group'
      : section.kind === 'missing-variant-image'
        ? 'variants'
        : 'barcode'
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
      onError('Pick or capture a photo first.')
      return
    }
    if (mode === 'variants' && selectedVariantIds.length === 0) {
      onError('Select at least one variant before uploading.')
      return
    }
    onUploadStart()
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
        blobUrl: string | null
        affectedProductIds?: number[]
        reanalysisJobId?: number | null
      }
      setOptimisticImageUrl(payload.blobUrl ?? localPreviewUrl ?? null)
      setOptimisticAffectedProductIds(mode === 'group' ? [] : (payload.affectedProductIds ?? selectedVariantIds))
      setSyncingReanalysis(payload.reanalysisJobId !== null && payload.reanalysisJobId !== undefined)
      setFile(null)
      if (inputRef.current) inputRef.current.value = ''
      const message =
        mode === 'group'
          ? `Group image attached to ${displayGroupName(group)} (${group.siteLabel}).`
          : `Variant image attached to ${selectedVariantIds.length} variant${selectedVariantIds.length === 1 ? '' : 's'} of ${displayGroupName(group)} (${group.siteLabel}).`
      await onComplete(message)
    } catch (error) {
      onError(error instanceof Error ? error.message : 'Upload failed.')
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

  return (
    <article className={`catalog-maintenance-card${disabled ? ' is-disabled' : ''}`}>
      <div className="catalog-maintenance-card-top">
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
    </article>
  )
}

interface VariantRowProps {
  variant: CatalogMaintenanceSiteVariant
  mode: CardMode
  sweedGroupId: number
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
    selected,
    optimisticPreviewUrl,
    syncingReanalysis,
    onToggle,
    onBarcodeUpdated,
    onBarcodeError,
  } = props
  const [editingBarcode, setEditingBarcode] = useState(false)
  const [draftBarcode, setDraftBarcode] = useState<string>(variant.externalBarcode ?? '')
  const [savingBarcode, setSavingBarcode] = useState(false)
  const [scanningBarcode, setScanningBarcode] = useState(false)
  const barcodeFileInputRef = useRef<HTMLInputElement | null>(null)
  const scannerSupported = useMemo(() => typeof window !== 'undefined' && 'BarcodeDetector' in window, [])

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
      if (!scannerSupported) {
        onBarcodeError('This browser cannot decode barcodes from photos. Type the value manually.')
        return
      }
      const Detector = (window as unknown as { BarcodeDetector?: BarcodeDetectorCtor }).BarcodeDetector
      if (!Detector) {
        onBarcodeError('This browser cannot decode barcodes from photos. Type the value manually.')
        return
      }
      const detector = new Detector({
        formats: ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'itf', 'codabar', 'qr_code'],
      })
      const bitmap = await createImageBitmap(file)
      try {
        const detections = await detector.detect(bitmap)
        if (detections.length === 0) {
          onBarcodeError('No barcode detected in that photo. Hold steady and fill the frame.')
          return
        }
        const value = detections[0]?.rawValue?.trim() ?? ''
        if (value.length === 0) {
          onBarcodeError('Decoded barcode was empty.')
          return
        }
        setDraftBarcode(value)
        setEditingBarcode(true)
      } finally {
        bitmap.close?.()
      }
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
        <MetrcTagsLine metrcTags={variant.metrcTags} />
        <BarcodeLine
          editing={editingBarcode}
          draftValue={draftBarcode}
          currentValue={variant.externalBarcode}
          status={variant.barcodeStatus}
          issueReason={variant.barcodeIssueReason}
          saving={savingBarcode}
          scanning={scanningBarcode}
          scannerSupported={scannerSupported}
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

function MetrcTagsLine(props: { metrcTags?: string[] | null }) {
  const metrcTags = Array.isArray(props.metrcTags) ? props.metrcTags : []
  if (metrcTags.length === 0) {
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
  saving: boolean
  scanning: boolean
  scannerSupported: boolean
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
    saving,
    scanning,
    scannerSupported,
    onBeginEdit,
    onCancelEdit,
    onChange,
    onSave,
    onPickPhoto,
  } = props

  if (!editing) {
    return (
      <span className="catalog-maintenance-barcode-line">
        <span className="subtle-copy">Barcode:</span>{' '}
        {currentValue ? (
          <code className="catalog-maintenance-barcode-value">{currentValue}</code>
        ) : (
          <span className="subtle-copy">none on file</span>
        )}{' '}
        {status !== 'ok' ? (
          <Pill tone="warning">{status === 'missing' ? 'missing' : 'invalid'}</Pill>
        ) : null}
        {issueReason ? <span className="subtle-copy"> ({issueReason})</span> : null}{' '}
        <button type="button" className="ghost-button catalog-maintenance-barcode-btn" onClick={onBeginEdit}>
          Edit
        </button>{' '}
        <button
          type="button"
          className="ghost-button catalog-maintenance-barcode-btn"
          onClick={onPickPhoto}
          disabled={scanning}
          title={scannerSupported ? 'Capture a photo of the barcode' : 'Capture / browse a barcode photo (decoding requires Chrome on Android)'}
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

function displayGroupName(group: CatalogMaintenanceSiteGroup): string {
  return group.groupName ?? `Group #${group.groupId}`
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

void displayGroupName

// `displayGroupName` is reused by the upload-completion toast string; keep
// the export-style reference above to satisfy TS's unused-symbol lint
// when the function appears only inside JSX template literals during
// future refactors. Cheap, side-effect-free.
