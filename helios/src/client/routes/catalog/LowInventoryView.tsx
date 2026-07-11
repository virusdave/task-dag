import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'

import {
  LowInventoryCountCaptureResponseSchema,
  isCannabisCategory,
  type LowInventoryCountCaptureResponse,
  type LowInventoryPackage,
  type LowInventoryResponse,
} from '../../../shared/contracts/index.js'
import { mutateJson } from '../../app/fetchJson.js'
import { nyLongDateTime } from '../../app/nyTime.js'
import { Pill } from '../../components/Pill.js'
import { decodeBarcodeFromImageFile, LiveBarcodeScanner } from './LiveBarcodeScanner.js'

export type LowInventoryViewState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; response: LowInventoryResponse }

const quantityFormatter = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 })

function displayQuantity(quantity: number | null): string {
  return quantity === null ? 'N/A' : quantityFormatter.format(quantity)
}

function packageIdentity(pkg: LowInventoryPackage): string {
  const metrcTag = pkg.metrcTag?.trim()
  return metrcTag ? metrcTag : pkg.inventoryItemId
}

function taxonomyLabel(categoryName: string | null, subcategoryName: string | null): string {
  const parts = [categoryName, subcategoryName].filter((part): part is string => part !== null)
  return parts.length === 0 ? 'Category not reported' : parts.join(' · ')
}

function focusPhysicalCountInput(inventoryItemId: string): void {
  window.requestAnimationFrame(() => {
    const input = document.querySelector<HTMLInputElement>(
      `[data-physical-count-input="${CSS.escape(inventoryItemId)}"]`,
    )
    input?.focus()
    input?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  })
}

export function findLowInventoryPackagesForScan(
  packages: readonly LowInventoryPackage[],
  scannedCode: string,
): LowInventoryPackage[] {
  const normalized = scannedCode.trim().toUpperCase()
  if (normalized.length === 0) return []
  return packages.filter((pkg) =>
    [pkg.metrcTag, pkg.inventoryBarcode]
      .some((candidate) => candidate?.trim().toUpperCase() === normalized),
  )
}

export function isLowInventoryPackageCountable(pkg: LowInventoryPackage): boolean {
  return pkg.currentQty !== null
}

export function LowInventoryView(props: {
  cannabisOnly: boolean
  onCannabisOnlyChange: (cannabisOnly: boolean) => void
  siteLabel: string
  state: LowInventoryViewState
  canCaptureCounts?: boolean
  countMigrationPending?: boolean
  onRetry?: () => void
}) {
  const {
    cannabisOnly,
    canCaptureCounts = false,
    countMigrationPending = false,
    onCannabisOnlyChange,
    onRetry,
    siteLabel,
    state,
  } = props
  const response = state.kind === 'ready' ? state.response : null
  const visibleLocationGroups = response?.data.locationGroups
    .map((group) => ({
      ...group,
      skus: cannabisOnly
        ? group.skus.filter((sku) => isCannabisCategory(sku.categoryName))
        : group.skus,
    }))
    .filter((group) => group.skus.length > 0) ?? []
  const packages = visibleLocationGroups.flatMap((group) =>
    group.skus.flatMap((sku) => sku.packages),
  )
  const [activePackageId, setActivePackageId] = useState<string | null>(null)
  const [scannerOpen, setScannerOpen] = useState(false)
  const [scanCode, setScanCode] = useState('')
  const [scanStatus, setScanStatus] = useState<{ message: string; event: number } | null>(null)
  const [ambiguousMatches, setAmbiguousMatches] = useState<LowInventoryPackage[]>([])
  const [photoBusy, setPhotoBusy] = useState(false)
  const [captureInFlight, setCaptureInFlight] = useState(false)
  const [locallyStale, setLocallyStale] = useState(response?.freshness.isStale ?? true)
  const photoInputRef = useRef<HTMLInputElement | null>(null)
  const scanStatusRef = useRef<HTMLDivElement | null>(null)
  const statusEventRef = useRef(0)
  const captureInFlightRef = useRef(false)
  const previousResponseRef = useRef(response)
  const captureEnabled = canCaptureCounts && response !== null && !response.freshness.isStale && !locallyStale
  const interactionBusy = captureInFlight || photoBusy

  const reportScanStatus = useCallback((message: string) => {
    statusEventRef.current += 1
    setScanStatus({ message, event: statusEventRef.current })
  }, [])

  useEffect(() => {
    captureInFlightRef.current = captureInFlight
  }, [captureInFlight])

  useEffect(() => {
    if (response === previousResponseRef.current) return
    previousResponseRef.current = response
    if (captureInFlightRef.current) return
    setActivePackageId(null)
    setAmbiguousMatches([])
    setScanStatus(null)
  }, [response])

  useEffect(() => {
    if (response === null || response.freshness.isStale || response.data.snapshotObservedAt === null) {
      setLocallyStale(true)
      return
    }
    const staleAt = new Date(response.data.snapshotObservedAt).getTime()
      + response.freshness.staleAfterMinutes * 60_000
    const delay = staleAt - Date.now()
    if (delay <= 0) {
      setLocallyStale(true)
      return
    }
    setLocallyStale(false)
    const timeout = window.setTimeout(() => {
      setLocallyStale(true)
      setAmbiguousMatches([])
      if (!captureInFlightRef.current) setActivePackageId(null)
      reportScanStatus('This stock snapshot became stale. Reload inventory before recording a count.')
    }, delay)
    return () => window.clearTimeout(timeout)
  }, [reportScanStatus, response])

  const activateScannedPackage = useCallback((value: string) => {
    if (captureInFlightRef.current) return
    const matches = findLowInventoryPackagesForScan(packages, value)
    setScannerOpen(false)
    setActivePackageId(null)
    setAmbiguousMatches([])
    if (matches.length === 0) {
      reportScanStatus(`No package in this ${siteLabel} queue matches that barcode or METRC tag.`)
      return
    }
    if (matches.length > 1) {
      setAmbiguousMatches(matches)
      const countableMatches = matches.filter(isLowInventoryPackageCountable)
      reportScanStatus(countableMatches.length === 0
        ? `${matches.length} packages match that code, but none has a current Sweed quantity. Reload the queue or try another package.`
        : `${matches.length} packages match that code. Choose the package you are holding.`)
      return
    }
    if (!isLowInventoryPackageCountable(matches[0]!)) {
      reportScanStatus('That package has no current Sweed quantity. Reload the queue or choose another package.')
      return
    }
    setActivePackageId(matches[0]!.inventoryItemId)
    setScanCode('')
    reportScanStatus(`Ready to count ${packageIdentity(matches[0]!)}.`)
    focusPhysicalCountInput(matches[0]!.inventoryItemId)
  }, [packages, reportScanStatus, siteLabel])

  useEffect(() => {
    if (scanStatus !== null && activePackageId === null) {
      scanStatusRef.current?.focus()
      scanStatusRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    }
  }, [activePackageId, scanStatus])

  const closeCountForm = useCallback((inventoryItemId: string) => {
    setActivePackageId(null)
    window.requestAnimationFrame(() => {
      document.querySelector<HTMLElement>(
        `[data-count-trigger="${CSS.escape(inventoryItemId)}"]`,
      )?.focus()
    })
  }, [])
  const skuCount = response === null
    ? 0
    : new Set(visibleLocationGroups.flatMap((group) => group.skus.map((sku) =>
      sku.productSku ?? `product-ids:${sku.productIds.join(',')}`,
    ))).size
  const packageCount = visibleLocationGroups.reduce(
    (total, group) => total + group.skus.reduce((groupTotal, sku) => groupTotal + sku.packages.length, 0),
    0,
  )

  return (
    <section className="low-inventory-page" aria-labelledby="low-inventory-title">
      <header className="low-inventory-header">
        <div>
          <p className="eyebrow">Catalog &amp; Inventory / {siteLabel}</p>
          <h2 id="low-inventory-title">Low inventory</h2>
        </div>
        <Pill tone="muted">
          {canCaptureCounts && (response?.freshness.isStale || locallyStale) ? 'Stale' : canCaptureCounts ? 'Count only' : 'Read only'}
        </Pill>
      </header>

      <div className="low-inventory-status" aria-live="polite">
        {state.kind === 'loading' ? (
          <div className="low-inventory-state-card" role="status">
            <strong>Loading {siteLabel} inventory…</strong>
            <span>Checking the latest stock snapshot.</span>
          </div>
        ) : null}

        {state.kind === 'error' ? (
          <div className="low-inventory-state-card low-inventory-state-card-error" role="alert">
            <strong>Inventory could not be loaded</strong>
            <span>{state.message}</span>
            {onRetry ? (
              <button type="button" className="ghost-button" onClick={onRetry} disabled={captureInFlight}>Try again</button>
            ) : null}
          </div>
        ) : null}

        {response && (response.freshness.isStale || locallyStale) ? (
          <div className="low-inventory-state-card low-inventory-state-card-stale" role="status">
            <strong>Stock snapshot is stale</strong>
            <span>
              {response.data.snapshotObservedAt === null
                ? 'No stock snapshot is available. Do not use this list for a floor check.'
                : `Last observed ${nyLongDateTime(new Date(response.data.snapshotObservedAt).getTime())} New York time. Do not use this list for a floor check.`}
            </span>
            {onRetry ? (
              <button type="button" className="ghost-button" onClick={onRetry} disabled={captureInFlight}>Reload inventory</button>
            ) : null}
          </div>
        ) : null}
      </div>

      {response ? (
        <>
          <div className="low-inventory-toolbar">
            <label className="low-inventory-cannabis-filter">
              <input
                checked={cannabisOnly}
                disabled={interactionBusy}
                onChange={(event) => {
                  setActivePackageId(null)
                  setAmbiguousMatches([])
                  setScanStatus(null)
                  onCannabisOnlyChange(event.currentTarget.checked)
                }}
                type="checkbox"
              />
              <span>
                <strong>Cannabis only</strong>
                <small>Items without a reported category stay visible.</small>
              </span>
            </label>
            <div className="low-inventory-summary" aria-atomic="true" aria-label="Queue summary" aria-live="polite">
              <strong>{skuCount} {skuCount === 1 ? 'SKU' : 'SKUs'}</strong>
              <span>{packageCount} {packageCount === 1 ? 'package' : 'packages'}</span>
              <span>At or below {displayQuantity(response.data.threshold)} available</span>
            </div>
          </div>

          {captureEnabled ? (
            <section className="low-inventory-scan" aria-labelledby="low-inventory-scan-title">
              <div>
                <strong id="low-inventory-scan-title">Find a package</strong>
                <span>Scan first, then record its physical count.</span>
              </div>
              <div className="low-inventory-scan-actions">
                <button
                  type="button"
                  className="primary-button"
                  onClick={() => {
                    setActivePackageId(null)
                    setAmbiguousMatches([])
                    setScanStatus(null)
                    setScannerOpen(true)
                  }}
                  disabled={interactionBusy}
                >
                  Scan package
                </button>
                <button
                  type="button"
                  className="ghost-button"
                  onClick={() => {
                    setActivePackageId(null)
                    setAmbiguousMatches([])
                    photoInputRef.current?.click()
                  }}
                  disabled={interactionBusy}
                >
                  {photoBusy ? 'Reading photo…' : 'From photo'}
                </button>
              </div>
              <form
                className="low-inventory-manual-scan"
                onSubmit={(event) => {
                  event.preventDefault()
                  activateScannedPackage(scanCode)
                }}
              >
                <label htmlFor="low-inventory-scan-code">Barcode or METRC tag</label>
                <div>
                  <input
                    id="low-inventory-scan-code"
                    type="text"
                    autoComplete="off"
                    spellCheck={false}
                    value={scanCode}
                    onChange={(event) => setScanCode(event.target.value)}
                    disabled={interactionBusy}
                  />
                  <button type="submit" className="ghost-button" disabled={interactionBusy || scanCode.trim().length === 0}>Find</button>
                </div>
              </form>
              <input
                ref={photoInputRef}
                type="file"
                accept="image/*"
                capture="environment"
                className="catalog-maintenance-file-input"
                aria-label="Choose a package barcode photo"
                onChange={(event) => {
                  const file = event.target.files?.[0]
                  if (!file) return
                  setPhotoBusy(true)
                  void decodeBarcodeFromImageFile(file).then(
                    (value) => {
                      if (captureInFlightRef.current) return
                      if (value === null) reportScanStatus('No barcode was found in that photo. Retake it or enter the code.')
                      else activateScannedPackage(value)
                    },
                    () => {
                      if (!captureInFlightRef.current) reportScanStatus('That photo could not be read. Retake it or enter the code.')
                    },
                  ).finally(() => {
                    setPhotoBusy(false)
                    event.target.value = ''
                  })
                }}
              />
              {scanStatus ? (
                <div
                  ref={scanStatusRef}
                  className="low-inventory-scan-status"
                  role="status"
                  tabIndex={-1}
                >
                  <p>{scanStatus.message}</p>
                  {ambiguousMatches.length > 0 ? (
                    <div className="low-inventory-scan-candidates" aria-label="Matching packages">
                      {ambiguousMatches.map((pkg) => (
                        <button
                          type="button"
                          className="ghost-button"
                          disabled={interactionBusy || !isLowInventoryPackageCountable(pkg)}
                          key={pkg.inventoryItemId}
                          onClick={() => {
                            setActivePackageId(pkg.inventoryItemId)
                            setAmbiguousMatches([])
                            reportScanStatus(`Ready to count ${packageIdentity(pkg)}.`)
                            focusPhysicalCountInput(pkg.inventoryItemId)
                          }}
                        >
                          {packageIdentity(pkg)} · {pkg.stockLocation}
                          {isLowInventoryPackageCountable(pkg) ? '' : ' · Current quantity unavailable'}
                        </button>
                      ))}
                    </div>
                  ) : null}
                </div>
              ) : null}
              <LiveBarcodeScanner
                open={scannerOpen}
                onDetected={activateScannedPackage}
                onCancel={() => setScannerOpen(false)}
                onPickPhoto={() => {
                  setScannerOpen(false)
                  photoInputRef.current?.click()
                }}
              />
            </section>
          ) : countMigrationPending ? (
            <div className="low-inventory-state-card" role="status">
              <strong>Physical counts are not available yet</strong>
              <span>The reviewed count-storage migration must be applied before this page can record counts.</span>
            </div>
          ) : null}

          {response.data.locationGroups.length === 0 ? (
            <div className="low-inventory-state-card low-inventory-empty" role="status">
              <strong>No low-inventory items</strong>
              <span>{response.site.siteLabel} has no for-sale SKUs between 1 and {displayQuantity(response.data.threshold)} available.</span>
            </div>
          ) : visibleLocationGroups.length === 0 ? (
            <div className="low-inventory-state-card low-inventory-empty" role="status">
              <strong>No cannabis low-inventory items</strong>
              <span>Turn off Cannabis only to show Accessories and Other.</span>
            </div>
          ) : (
            <div className="low-inventory-locations">
              {visibleLocationGroups.map((group, groupIndex) => {
                const headingId = `low-inventory-location-${groupIndex}`
                return (
                  <section className="low-inventory-location" aria-labelledby={headingId} key={`${group.location.kind}:${group.location.label}`}>
                    <header className="low-inventory-location-header">
                      <div>
                        <span>{group.location.kind === 'shelf' ? 'Shelf' : 'Stock room'}</span>
                        <h3 id={headingId}>{group.location.label}</h3>
                      </div>
                      <Pill tone="muted">{group.skus.length} {group.skus.length === 1 ? 'SKU' : 'SKUs'}</Pill>
                    </header>
                    <div className="low-inventory-skus">
                      {group.skus.map((sku, skuIndex) => (
                        <article className="low-inventory-sku" key={`${sku.productSku ?? 'no-sku'}:${sku.productIds.join(',')}:${skuIndex}`}>
                          <header>
                            <div className="low-inventory-product">
                              <h4>{sku.productName ?? 'Unnamed product'}</h4>
                              <span className="low-inventory-taxonomy">
                                {taxonomyLabel(sku.categoryName, sku.subcategoryName)}
                              </span>
                              <span>{sku.productSku ? `SKU ${sku.productSku}` : 'SKU not reported'}</span>
                            </div>
                            <div className="low-inventory-total" aria-label={`${displayQuantity(sku.packages.reduce((total, pkg) => total + pkg.availableQty, 0))} available at this location; ${displayQuantity(sku.combinedAvailableQty)} site-wide`}>
                              <strong>{displayQuantity(sku.packages.reduce((total, pkg) => total + pkg.availableQty, 0))}</strong>
                              <span>at this location</span>
                              <small>{displayQuantity(sku.combinedAvailableQty)} site-wide</small>
                            </div>
                          </header>
                          <ul className="low-inventory-packages" aria-label="Packages">
                            {sku.packages.map((pkg) => (
                              <li key={pkg.inventoryItemId}>
                                <div>
                                  <strong>{packageIdentity(pkg)}</strong>
                                  <span>{pkg.stockLocation}</span>
                                </div>
                                <dl>
                                  <div><dt>Available</dt><dd>{displayQuantity(pkg.availableQty)}</dd></div>
                                  <div><dt>Current</dt><dd>{displayQuantity(pkg.currentQty)}</dd></div>
                                  <div><dt>Held</dt><dd>{displayQuantity(pkg.holdQty)}</dd></div>
                                </dl>
                                {activePackageId === pkg.inventoryItemId && isLowInventoryPackageCountable(pkg) ? (
                                    <PhysicalCountForm
                                      canSubmit={captureEnabled || captureInFlight}
                                      dealerId={response.data.dealerId}
                                      pkg={pkg}
                                      onClose={() => closeCountForm(pkg.inventoryItemId)}
                                      onBusyChange={(busy) => {
                                        captureInFlightRef.current = busy
                                        setCaptureInFlight(busy)
                                      }}
                                    />
                                ) : captureEnabled ? (
                                    <button
                                      type="button"
                                      className="ghost-button low-inventory-count-button"
                                      data-count-trigger={pkg.inventoryItemId}
                                      disabled={interactionBusy || !isLowInventoryPackageCountable(pkg)}
                                      onClick={() => {
                                        setActivePackageId(pkg.inventoryItemId)
                                        setScanStatus(null)
                                      }}
                                    >
                                      {pkg.currentQty === null ? 'Current quantity unavailable' : 'Record physical count'}
                                    </button>
                                ) : null}
                              </li>
                            ))}
                          </ul>
                        </article>
                      ))}
                    </div>
                  </section>
                )
              })}
            </div>
          )}

          <details className="low-inventory-about">
            <summary>About this list</summary>
            <p>
              Shows for-sale SKUs with a combined available quantity from 1 through {displayQuantity(response.data.threshold)}.
              Quantities are a read-only stock snapshot and this page cannot change inventory.
            </p>
            <p>
              Snapshot time: {response.data.snapshotObservedAt === null
                ? 'not available'
                : `${nyLongDateTime(new Date(response.data.snapshotObservedAt).getTime())} New York time`}.
              Data is considered stale after {response.freshness.staleAfterMinutes} minutes.
            </p>
          </details>
        </>
      ) : null}
    </section>
  )
}

const classificationLabels: Record<LowInventoryCountCaptureResponse['count']['classification'], string> = {
  equal: 'Matches Sweed',
  short: 'Short count',
  zero: 'Counted zero',
  'zero-held': 'Counted zero, held stock remains',
  over: 'Over count',
}

function PhysicalCountForm(props: {
  canSubmit: boolean
  dealerId: number
  pkg: LowInventoryPackage
  onClose: () => void
  onBusyChange: (busy: boolean) => void
}) {
  const { canSubmit, dealerId, onBusyChange, onClose, pkg } = props
  const [physicalQty, setPhysicalQty] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<LowInventoryCountCaptureResponse | null>(null)
  const [requestId] = useState(() => globalThis.crypto.randomUUID())
  const inFlightRef = useRef(false)
  const inputId = `physical-count-${pkg.inventoryItemId.replace(/[^a-zA-Z0-9_-]/g, '-')}`

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    if (inFlightRef.current || !canSubmit) return
    const parsedQty = Number(physicalQty)
    if (!Number.isFinite(parsedQty) || parsedQty < 0) {
      setError('Enter a physical count of zero or more.')
      return
    }
    inFlightRef.current = true
    setBusy(true)
    onBusyChange(true)
    setError(null)
    try {
      const response = await mutateJson(
        '/api/low-inventory/counts',
        LowInventoryCountCaptureResponseSchema,
        {
          method: 'POST',
          body: JSON.stringify({
            dealerId,
            inventoryItemId: pkg.inventoryItemId,
            physicalQty: parsedQty,
            requestId,
          }),
        },
      )
      setResult(response)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The physical count could not be recorded.')
    } finally {
      inFlightRef.current = false
      setBusy(false)
      onBusyChange(false)
    }
  }

  if (result !== null) {
    const pending = result.count.resolutionStatus === 'pending'
    return (
      <div className={`low-inventory-count-result${pending ? ' is-pending' : ' is-equal'}`} role="status">
        <strong>{classificationLabels[result.count.classification]}</strong>
        <span>
          {pending
            ? 'Count recorded. Package still for sale. Transfer pending.'
            : 'Count recorded. No discrepancy.'}
        </span>
        <small>No Sweed inventory changed and no notification was sent.</small>
        <button type="button" className="ghost-button" onClick={onClose}>Done</button>
      </div>
    )
  }

  return (
    <form className="low-inventory-count-form" onSubmit={(event) => void submit(event)}>
      <div>
        <label htmlFor={inputId}>Physical count for {packageIdentity(pkg)}</label>
        <span>Sweed current: {displayQuantity(pkg.currentQty)}</span>
      </div>
      <input
        id={inputId}
        data-physical-count-input={pkg.inventoryItemId}
        type="number"
        inputMode="decimal"
        min="0"
        max="1000000"
        step="0.001"
        required
        autoFocus
        value={physicalQty}
        onChange={(event) => setPhysicalQty(event.target.value)}
        disabled={busy || !canSubmit}
      />
      {error ? <span className="low-inventory-count-error" role="alert">{error}</span> : null}
      <div className="low-inventory-count-actions">
        <button type="submit" className="primary-button" disabled={busy || !canSubmit || physicalQty.length === 0}>
          {busy ? 'Recording…' : 'Record count'}
        </button>
        <button type="button" className="ghost-button" onClick={onClose} disabled={busy}>Cancel</button>
      </div>
      {!canSubmit ? <span className="low-inventory-count-error" role="status">Reload fresh inventory before retrying this count.</span> : null}
      <small>Records an audit entry only. It does not change Sweed or notify anyone.</small>
    </form>
  )
}
