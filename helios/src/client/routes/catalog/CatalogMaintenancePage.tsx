import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'

import {
  CatalogMaintenanceListResponseSchema,
  type CatalogMaintenanceGroup,
  type CatalogMaintenanceListResponse,
  type CatalogMaintenanceVariant,
} from '../../../shared/contracts/index.js'
import { buildAppPath } from '../../app/paths.js'
import { Pill } from '../../components/Pill.js'
import { useRegisterCatalogSidebarSubtree } from './catalogSidebarSubtree.js'

type Mode = 'group' | 'variants'

interface ListsState {
  loading: boolean
  refreshing: boolean
  missingGroup: CatalogMaintenanceListResponse | null
  missingVariant: CatalogMaintenanceListResponse | null
  error: string | null
}

const INITIAL_STATE: ListsState = {
  loading: true,
  refreshing: false,
  missingGroup: null,
  missingVariant: null,
  error: null,
}

export function CatalogMaintenancePage() {
  useRegisterCatalogSidebarSubtree()
  const navigate = useNavigate()
  const [state, setState] = useState<ListsState>(INITIAL_STATE)
  const [busyGroupId, setBusyGroupId] = useState<number | null>(null)
  const [feedback, setFeedback] = useState<{ kind: 'ok' | 'err'; message: string } | null>(null)

  const fetchLists = useCallback(
    async (forceRefresh: boolean) => {
      setState((prev) => ({ ...prev, refreshing: true, error: null }))
      try {
        const search = forceRefresh ? '?refresh=1' : ''
        const [missingGroup, missingVariant] = await Promise.all([
          fetchMaintenanceList(`/api/catalog/maintenance/missing-group-images${search}`),
          fetchMaintenanceList(`/api/catalog/maintenance/missing-variant-images${search}`),
        ])
        setState({ loading: false, refreshing: false, missingGroup, missingVariant, error: null })
      } catch (error) {
        if (error instanceof AuthRequiredError) {
          navigate('/login')
          return
        }
        const message = error instanceof Error ? error.message : 'Failed to load catalog maintenance survey.'
        setState((prev) => ({ ...prev, loading: false, refreshing: false, error: message }))
      }
    },
    [navigate],
  )

  useEffect(() => {
    void fetchLists(false)
  }, [fetchLists])

  const handleUploadComplete = useCallback(
    async (message: string) => {
      setFeedback({ kind: 'ok', message })
      await fetchLists(true)
    },
    [fetchLists],
  )

  const handleUploadError = useCallback((message: string) => {
    setFeedback({ kind: 'err', message })
  }, [])

  const lastScannedAt = state.missingGroup?.meta.generatedAt ?? state.missingVariant?.meta.generatedAt ?? null

  return (
    <section className="catalog-maintenance-page">
      <div className="page-header">
        <div>
          <p className="eyebrow">Catalog Module</p>
          <h2>Image maintenance</h2>
          <p className="subtle-copy">
            In-stock SKUs whose Sweed group has no image, and in-stock SKUs whose variants don&apos;t each have
            their own image. Tap a card to upload or capture a photo and Helios will attach it for you.
          </p>
        </div>
        <div className="inline-row wrap-row catalog-maintenance-meta">
          {lastScannedAt ? (
            <Pill tone="muted">scanned {formatRelativeTime(lastScannedAt)}</Pill>
          ) : null}
          <button
            type="button"
            className="ghost-button"
            disabled={state.refreshing}
            onClick={() => {
              void fetchLists(true)
            }}
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

      {state.error ? <div className="catalog-maintenance-toast catalog-maintenance-toast-err">{state.error}</div> : null}

      <CatalogMaintenanceSection
        title="Missing product image"
        emptyHint="Every in-stock product has a group image."
        mode="group"
        loading={state.loading}
        list={state.missingGroup}
        busyGroupId={busyGroupId}
        setBusyGroupId={setBusyGroupId}
        onComplete={handleUploadComplete}
        onError={handleUploadError}
      />

      <CatalogMaintenanceSection
        title="Variants lacking exhaustive images"
        emptyHint="Every in-stock multi-variant product has per-variant images."
        mode="variants"
        loading={state.loading}
        list={state.missingVariant}
        busyGroupId={busyGroupId}
        setBusyGroupId={setBusyGroupId}
        onComplete={handleUploadComplete}
        onError={handleUploadError}
      />
    </section>
  )
}

interface SectionProps {
  title: string
  emptyHint: string
  mode: Mode
  loading: boolean
  list: CatalogMaintenanceListResponse | null
  busyGroupId: number | null
  setBusyGroupId: (id: number | null) => void
  onComplete: (message: string) => Promise<void>
  onError: (message: string) => void
}

function CatalogMaintenanceSection(props: SectionProps) {
  const { title, emptyHint, mode, loading, list, busyGroupId, setBusyGroupId, onComplete, onError } = props
  const groups = list?.groups ?? []
  const warnings = list?.meta.warnings ?? []

  return (
    <section className="catalog-maintenance-section">
      <header className="catalog-maintenance-section-head">
        <h3>{title}</h3>
        <Pill tone={groups.length === 0 ? 'muted' : 'warning'}>{groups.length} candidate{groups.length === 1 ? '' : 's'}</Pill>
      </header>
      {warnings.length > 0 ? (
        <details className="catalog-maintenance-warnings">
          <summary>{warnings.length} warning{warnings.length === 1 ? '' : 's'} during scan</summary>
          <ul>
            {warnings.map((warning, index) => (
              <li key={index}>{warning}</li>
            ))}
          </ul>
        </details>
      ) : null}
      {loading && !list ? <p className="subtle-copy">Loading…</p> : null}
      {!loading && groups.length === 0 ? <p className="subtle-copy">{emptyHint}</p> : null}
      <ul className="catalog-maintenance-list">
        {groups.map((group) => (
          <li key={`${mode}:${group.groupId}`}>
            <MaintenanceCard
              mode={mode}
              group={group}
              busy={busyGroupId === group.groupId}
              disabled={busyGroupId !== null && busyGroupId !== group.groupId}
              onUploadStart={() => setBusyGroupId(group.groupId)}
              onUploadEnd={() => setBusyGroupId(null)}
              onComplete={onComplete}
              onError={onError}
            />
          </li>
        ))}
      </ul>
    </section>
  )
}

interface CardProps {
  mode: Mode
  group: CatalogMaintenanceGroup
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
  const [selectedVariantIds, setSelectedVariantIds] = useState<number[]>(() => defaultSelectedVariantIds(group))
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
    setSelectedVariantIds(defaultSelectedVariantIds(group))
  }, [group])

  const summaryLine = useMemo(() => buildSummaryLine(group), [group])

  const toggleVariant = (productId: number) => {
    setSelectedVariantIds((prev) =>
      prev.includes(productId) ? prev.filter((id) => id !== productId) : [...prev, productId].sort((a, b) => a - b),
    )
  }

  const handleFile = (selectedFile: File | null) => {
    setFile(selectedFile)
  }

  const handleSubmit = async () => {
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
      setFile(null)
      if (inputRef.current) {
        inputRef.current.value = ''
      }
      const message =
        mode === 'group'
          ? `Group image attached to ${displayGroupName(group)}.`
          : `Variant image attached to ${selectedVariantIds.length} variant${selectedVariantIds.length === 1 ? '' : 's'} of ${displayGroupName(group)}.`
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

  return (
    <article className={`catalog-maintenance-card${disabled ? ' is-disabled' : ''}`}>
      <div className="catalog-maintenance-card-top">
        <div className="catalog-maintenance-card-preview">
          {localPreviewUrl ? (
            <img src={localPreviewUrl} alt="Pending upload preview" loading="lazy" />
          ) : group.groupPreviewImageUrl ? (
            <img src={group.groupPreviewImageUrl} alt={`${displayGroupName(group)} group image`} loading="lazy" />
          ) : (
            <div className="catalog-maintenance-card-preview-empty">No image</div>
          )}
        </div>
        <div className="catalog-maintenance-card-meta">
          <div className="catalog-maintenance-card-title">
            <strong>{displayGroupName(group)}</strong>
            {group.brandName ? <span className="subtle-copy">{group.brandName}</span> : null}
          </div>
          <div className="catalog-maintenance-card-tags">
            {group.inStockSites.map((site) => (
              <Pill key={site} tone="muted">{site}</Pill>
            ))}
            {group.categoryName ? <Pill tone="muted">{group.categoryName}</Pill> : null}
            {group.subcategoryName ? <Pill tone="muted">{group.subcategoryName}</Pill> : null}
          </div>
          <p className="subtle-copy">{summaryLine}</p>
        </div>
      </div>

      {mode === 'variants' && group.variants.length > 0 ? (
        <div className="catalog-maintenance-variants">
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
          <ul className="catalog-maintenance-variant-list">
            {group.variants.map((variant) => (
              <li key={variant.productId}>
                <label className="catalog-maintenance-variant-row">
                  <input
                    type="checkbox"
                    checked={selectedVariantIds.includes(variant.productId)}
                    onChange={() => toggleVariant(variant.productId)}
                  />
                  <span className="catalog-maintenance-variant-thumb">
                    {variant.previewImageUrl ? (
                      <img src={variant.previewImageUrl} alt={`${variantLabel(variant)} variant image`} loading="lazy" />
                    ) : (
                      <span className="catalog-maintenance-variant-thumb-empty">—</span>
                    )}
                  </span>
                  <span className="catalog-maintenance-variant-text">
                    <strong>{variantLabel(variant)}</strong>
                    <span className="subtle-copy">
                      {variant.variantSpecificImageCount > 0
                        ? `${variant.variantSpecificImageCount} own image${variant.variantSpecificImageCount === 1 ? '' : 's'}`
                        : 'no variant-specific image'}
                    </span>
                  </span>
                </label>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="catalog-maintenance-card-actions">
        <input
          ref={inputRef}
          type="file"
          accept="image/*"
          capture="environment"
          className="catalog-maintenance-file-input"
          onChange={(event) => {
            const next = event.target.files?.[0] ?? null
            handleFile(next)
          }}
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
    </article>
  )
}

function defaultSelectedVariantIds(group: CatalogMaintenanceGroup): number[] {
  const missing = group.variants.filter((variant) => variant.variantSpecificImageCount === 0).map((v) => v.productId)
  if (missing.length > 0) {
    return missing
  }
  return group.variants.map((variant) => variant.productId)
}

function displayGroupName(group: CatalogMaintenanceGroup): string {
  return group.groupName ?? `Group #${group.groupId}`
}

function variantLabel(variant: CatalogMaintenanceVariant): string {
  const parts: string[] = []
  if (variant.shortName) {
    parts.push(variant.shortName)
  } else if (variant.name) {
    parts.push(variant.name)
  } else {
    parts.push(`#${variant.productId}`)
  }
  if (variant.sizeName) {
    parts.push(variant.sizeName)
  }
  if (variant.packOfSize && variant.packOfSize > 1) {
    parts.push(`pack of ${variant.packOfSize}`)
  }
  if (variant.tab) {
    parts.push(`tab: ${variant.tab}`)
  }
  return parts.join(' · ')
}

function buildSummaryLine(group: CatalogMaintenanceGroup): string {
  const parts: string[] = []
  parts.push(`${group.inStockVariantCount}/${group.totalVariantCount} variant${group.totalVariantCount === 1 ? '' : 's'} in stock`)
  parts.push(`${group.groupImageCount} group image${group.groupImageCount === 1 ? '' : 's'}`)
  const variantsWithImages = group.variants.filter((variant) => variant.variantSpecificImageCount > 0).length
  parts.push(`${variantsWithImages}/${group.variants.length} variants have own image`)
  return parts.join(' · ')
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`
  }
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
}

function formatRelativeTime(iso: string): string {
  const generated = Date.parse(iso)
  if (!Number.isFinite(generated)) {
    return iso
  }
  const seconds = Math.max(0, Math.floor((Date.now() - generated) / 1000))
  if (seconds < 60) {
    return `${seconds}s ago`
  }
  if (seconds < 3600) {
    return `${Math.floor(seconds / 60)}m ago`
  }
  if (seconds < 86_400) {
    return `${Math.floor(seconds / 3600)}h ago`
  }
  return `${Math.floor(seconds / 86_400)}d ago`
}

class AuthRequiredError extends Error {
  constructor() {
    super('Authentication required.')
    this.name = 'AuthRequiredError'
  }
}

async function fetchMaintenanceList(path: string): Promise<CatalogMaintenanceListResponse> {
  const response = await fetch(buildAppPath(path), {
    credentials: 'same-origin',
    headers: { Accept: 'application/json' },
  })
  if (response.status === 401) {
    throw new AuthRequiredError()
  }
  if (!response.ok) {
    const errorPayload = await maybeReadErrorPayload(response)
    throw new Error(errorPayload ?? `${response.status} ${response.statusText}`)
  }
  const payload = await response.json()
  return CatalogMaintenanceListResponseSchema.parse(payload)
}

async function maybeReadErrorPayload(response: Response): Promise<string | null> {
  try {
    const payload = (await response.json()) as { error?: string }
    return typeof payload.error === 'string' ? payload.error : null
  } catch {
    return null
  }
}
