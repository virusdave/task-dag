import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'

import type {
  LowInventoryAuditResult,
  LowInventoryClassification,
  LowInventoryCountRequest,
  LowInventoryPackage,
  LowInventoryResponse,
  LowInventoryTransferConfigBody,
  LowInventoryTransferConfigResponse,
} from '../../../shared/contracts/index.js'
import { nyLongDateTime } from '../../app/nyTime.js'
import { Pill } from '../../components/Pill.js'
import { HoverZoomImage } from '../../components/HoverZoomImage.js'
import { LiveBarcodeScanner } from './LiveBarcodeScanner.js'

export type LowInventoryViewState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; response: LowInventoryResponse }

const quantityFormatter = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 })

function displayQuantity(quantity: number | null): string {
  return quantity === null ? 'N/A' : quantityFormatter.format(quantity)
}

function packageIdentity(pkg: Pick<LowInventoryPackage, 'inventoryItemId' | 'metrcTag'>): string {
  const metrcTag = pkg.metrcTag?.trim()
  return metrcTag ? metrcTag : pkg.inventoryItemId
}

function classifyCount(pkg: LowInventoryPackage, physicalCount: number): LowInventoryClassification | null {
  if (pkg.currentQty === null) return null
  if (physicalCount === 0 && (pkg.holdQty ?? 0) > 0) return 'held'
  if (physicalCount === 0) return 'zero'
  if (physicalCount < pkg.currentQty) return 'short'
  if (physicalCount === pkg.currentQty) return 'equal'
  return 'over'
}

function classificationLabel(classification: LowInventoryClassification): string {
  switch (classification) {
    case 'equal': return 'Count matches Sweed'
    case 'short': return 'Short count; transfer pending'
    case 'zero': return 'Zero count; transfer pending'
    case 'over': return 'Count is over Sweed'
    case 'held': return 'Zero counted, but units are held'
  }
}

export function LowInventoryView(props: {
  audits?: readonly LowInventoryAuditResult[]
  busy?: boolean
  canEdit?: boolean
  isAdmin?: boolean
  mutationMessage?: string | null
  onRetry?: () => void
  onRecordCount?: (body: LowInventoryCountRequest) => Promise<void>
  onSaveTransferConfig?: (body: LowInventoryTransferConfigBody) => Promise<void>
  onTransfer?: (auditId: number, config: LowInventoryTransferConfigResponse) => Promise<void>
  siteLabel: string
  state: LowInventoryViewState
  transferConfig?: LowInventoryTransferConfigResponse | null
}) {
  const {
    audits = [], busy = false, canEdit = false, isAdmin = false, mutationMessage,
    onRecordCount, onRetry, onSaveTransferConfig, onTransfer, siteLabel, state,
    transferConfig = null,
  } = props
  const response = state.kind === 'ready' ? state.response : null
  const [cannabisOnly, setCannabisOnly] = useState(true)
  const [counts, setCounts] = useState<Record<string, string>>({})
  const [manualScan, setManualScan] = useState('')
  const [scanMessage, setScanMessage] = useState<string | null>(null)
  const [scannerOpen, setScannerOpen] = useState(false)
  const [selectedPackageId, setSelectedPackageId] = useState<string | null>(null)
  const [showCompleted, setShowCompleted] = useState(false)
  const [transferReview, setTransferReview] = useState<LowInventoryAuditResult | null>(null)
  const transferDialogRef = useRef<HTMLElement>(null)
  const transferTriggerRef = useRef<HTMLButtonElement | null>(null)

  useEffect(() => {
    if (transferReview === null) return
    transferDialogRef.current?.querySelector<HTMLButtonElement>('button')?.focus()
    return () => transferTriggerRef.current?.focus()
  }, [transferReview])

  function handleDialogKeyDown(event: KeyboardEvent<HTMLElement>): void {
    if (event.key === 'Escape') {
      event.preventDefault()
      setTransferReview(null)
      return
    }
    if (event.key !== 'Tab' || transferDialogRef.current === null) return
    const controls = [...transferDialogRef.current.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled)')]
    const first = controls[0]
    const last = controls[controls.length - 1]
    if (first === undefined || last === undefined) return
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
  }

  const latestAuditByPackage = useMemo(() => {
    const byPackage = new Map<string, LowInventoryAuditResult>()
    for (const audit of audits) {
      if (!byPackage.has(audit.inventoryItemId)) byPackage.set(audit.inventoryItemId, audit)
    }
    return byPackage
  }, [audits])
  const visibleGroups = useMemo(() => response?.data.locationGroups
    .map((group) => ({
      ...group,
      skus: group.skus
        .filter((sku) => !cannabisOnly || sku.isCannabis)
        .map((sku) => ({
          ...sku,
          packages: sku.packages.filter((pkg) => {
            if (showCompleted) return true
            const audit = latestAuditByPackage.get(pkg.inventoryItemId)
            return audit === undefined || (audit.classification !== 'equal' && audit.transferStatus !== 'resolved')
          }),
        }))
        .filter((sku) => sku.packages.length > 0),
    }))
    .filter((group) => group.skus.length > 0) ?? [], [cannabisOnly, latestAuditByPackage, response, showCompleted])
  const visibleSkus = visibleGroups.flatMap((group) => group.skus)
  const visiblePackages = visibleSkus.flatMap((sku) => sku.packages)

  function selectScan(rawCode: string): void {
    const code = rawCode.trim().toLowerCase()
    const matches = visiblePackages.filter((pkg) =>
      pkg.inventoryItemId.toLowerCase() === code ||
      pkg.inventoryBarcode?.trim().toLowerCase() === code ||
      pkg.metrcTag?.trim().toLowerCase() === code,
    )
    if (matches.length !== 1) {
      setScanMessage(matches.length === 0
        ? 'No visible package matches that barcode or METRC tag. Check the site and cannabis filter.'
        : 'That scan matches more than one package. Use the package row to choose one.')
      return
    }
    const match = matches[0]
    setSelectedPackageId(match.inventoryItemId)
    setScanMessage(`Matched ${packageIdentity(match)}. Enter the physical count on the highlighted row.`)
    setScannerOpen(false)
    window.setTimeout(() => document.getElementById(`low-inventory-package-${match.inventoryItemId}`)?.focus(), 0)
  }

  const skuCount = new Set(visibleSkus.map((sku) => sku.productSku ?? `product-ids:${sku.productIds.join(',')}`)).size
  const packageCount = visiblePackages.length

  return (
    <section className="low-inventory-page" aria-labelledby="low-inventory-title">
      <header className="low-inventory-header">
        <div>
          <p className="eyebrow">Catalog &amp; Inventory / {siteLabel}</p>
          <h2 id="low-inventory-title">Low inventory audit</h2>
        </div>
        <Pill tone={canEdit ? 'warning' : 'muted'}>{canEdit ? 'Audit mode' : 'Read only'}</Pill>
      </header>

      <div className="low-inventory-status" aria-live="polite">
        {state.kind === 'loading' ? <div className="low-inventory-state-card" role="status"><strong>Loading {siteLabel} inventory…</strong><span>Checking the latest stock snapshot.</span></div> : null}
        {state.kind === 'error' ? <div className="low-inventory-state-card low-inventory-state-card-error" role="alert"><strong>Inventory could not be loaded</strong><span>{state.message}</span>{onRetry ? <button type="button" className="ghost-button" onClick={onRetry}>Try again</button> : null}</div> : null}
        {response?.freshness.isStale ? <div className="low-inventory-state-card low-inventory-state-card-stale" role="status"><strong>Stock snapshot is stale</strong><span>{response.data.snapshotObservedAt === null ? 'No stock snapshot is available. Do not use this list for a floor check.' : `Last observed ${nyLongDateTime(new Date(response.data.snapshotObservedAt).getTime())} New York time. Do not use this list for a floor check; reload before recording counts.`}</span></div> : null}
        {mutationMessage ? <div className="low-inventory-state-card" role="status"><strong>{mutationMessage}</strong></div> : null}
      </div>

      {response ? <>
        <div className="low-inventory-toolbar">
          <label><input type="checkbox" checked={cannabisOnly} onChange={(event) => setCannabisOnly(event.target.checked)} /> Cannabis products only</label>
          <label><input type="checkbox" checked={showCompleted} onChange={(event) => setShowCompleted(event.target.checked)} /> Show completed checks</label>
          {canEdit ? <>
            <button type="button" className="ghost-button" disabled={busy} onClick={() => setScannerOpen(true)}>Scan package</button>
            <form onSubmit={(event) => { event.preventDefault(); selectScan(manualScan) }}>
              <input aria-label="Barcode or METRC tag" type="text" inputMode="text" autoComplete="off" placeholder="Type or hardware-scan" value={manualScan} onChange={(event) => setManualScan(event.target.value)} />
              <button type="submit" className="ghost-button" disabled={manualScan.trim().length === 0}>Find</button>
            </form>
          </> : null}
        </div>
        {scanMessage ? <div className="low-inventory-scan-message" aria-live="polite">{scanMessage}</div> : null}

        <div className="low-inventory-summary" aria-label="Queue summary"><strong>{skuCount} {skuCount === 1 ? 'SKU' : 'SKUs'}</strong><span>{packageCount} {packageCount === 1 ? 'package' : 'packages'}</span><span>At or below {displayQuantity(response.data.threshold)} available</span></div>

        {visibleGroups.length === 0 ? <div className="low-inventory-state-card low-inventory-empty" role="status"><strong>{response.data.locationGroups.length === 0 ? 'No low-inventory items' : 'No matching low-inventory items'}</strong><span>{response.data.locationGroups.length === 0 ? `${response.site.siteLabel} has no for-sale SKUs between 1 and ${displayQuantity(response.data.threshold)} available.` : 'Turn off “Cannabis products only” to include accessories and other products.'}</span></div> :
          <div className="low-inventory-locations">{visibleGroups.map((group, groupIndex) => {
            const headingId = `low-inventory-location-${groupIndex}`
            return <section className="low-inventory-location" aria-labelledby={headingId} key={`${group.location.kind}:${group.location.label}`}>
              <header className="low-inventory-location-header"><div><span>{group.location.kind === 'shelf' ? 'Shelf' : 'Stock room'}</span><h3 id={headingId}>{group.location.label}</h3></div><Pill tone="muted">{group.skus.length} {group.skus.length === 1 ? 'SKU' : 'SKUs'}</Pill></header>
              <div className="low-inventory-skus">{group.skus.map((sku, skuIndex) => <article className="low-inventory-sku" key={`${sku.productSku ?? 'no-sku'}:${sku.productIds.join(',')}:${skuIndex}`}>
                <header>{sku.imageUrl ? <HoverZoomImage alt={sku.productName ?? 'Product'} src={sku.imageUrl} expandOnClick zoomedSize={320} style={{ width: 52, height: 52, borderRadius: 6, objectFit: 'cover' }} /> : null}<div className="low-inventory-product"><h4>{sku.productName ?? 'Unnamed product'}</h4><span>{[sku.categoryName, sku.subcategoryName].filter(Boolean).join(' / ') || 'Category not reported'}</span><span>{sku.productSku ? `SKU ${sku.productSku}` : 'SKU not reported'}</span></div><div className="low-inventory-total"><strong>{displayQuantity(sku.packages.reduce((total, pkg) => total + pkg.availableQty, 0))}</strong><span>at this location</span><small>{displayQuantity(sku.combinedAvailableQty)} site-wide</small></div></header>
                <ul className="low-inventory-packages" aria-label="Packages">{sku.packages.map((pkg) => {
                  const latestAudit = latestAuditByPackage.get(pkg.inventoryItemId)
                  const countText = counts[pkg.inventoryItemId] ?? ''
                  const physicalCount = countText === '' ? null : Number(countText)
                  const classification = physicalCount !== null && Number.isFinite(physicalCount) ? classifyCount(pkg, physicalCount) : null
                  return <li id={`low-inventory-package-${pkg.inventoryItemId}`} tabIndex={-1} className={selectedPackageId === pkg.inventoryItemId ? 'is-selected' : undefined} key={pkg.inventoryItemId}>
                    <div><strong>{packageIdentity(pkg)}</strong><span>{pkg.stockLocation}</span></div>
                    <dl><div><dt>Available</dt><dd>{displayQuantity(pkg.availableQty)}</dd></div><div><dt>Current</dt><dd>{displayQuantity(pkg.currentQty)}</dd></div><div><dt>Held</dt><dd>{displayQuantity(pkg.holdQty)}</dd></div></dl>
                    {canEdit && pkg.currentQty !== null ? <form className="low-inventory-count" onSubmit={(event: FormEvent) => {
                      event.preventDefault()
                      if (!classification || physicalCount === null || !onRecordCount) return
                      void onRecordCount({ dealerId: response.site.dealerId, productId: pkg.productId, inventoryItemId: pkg.inventoryItemId, snapshotObservedAt: pkg.observedAt, physicalCount }).catch(() => undefined)
                    }}><label>Physical count<input type="number" min="0" step="0.01" inputMode="decimal" value={countText} onChange={(event) => setCounts((current) => ({ ...current, [pkg.inventoryItemId]: event.target.value }))} /></label><button type="submit" className="primary-button" disabled={busy || classification === null || response.freshness.isStale}>Record count</button>{classification ? <span className={`low-inventory-classification is-${classification}`}>{classificationLabel(classification)}</span> : null}</form> : null}
                    {latestAudit ? <div className="low-inventory-audit-result"><strong>{classificationLabel(latestAudit.classification)}</strong><span>Counted {displayQuantity(latestAudit.physicalCount)} by {latestAudit.actorLabel} · {nyLongDateTime(new Date(latestAudit.createdAt).getTime())} NY</span>{latestAudit.transferStatus === 'pending' ? <button ref={(element) => { if (transferReview?.auditId === latestAudit.auditId) transferTriggerRef.current = element }} type="button" className="danger-button" disabled={busy || !transferConfig?.transferEnabled} onClick={(event) => { transferTriggerRef.current = event.currentTarget; setTransferReview(latestAudit) }}>Review location move</button> : null}{latestAudit.transferStatus === 'resolved' ? <span>Package moved out of the for-sale room.</span> : null}</div> : null}
                  </li>
                })}</ul>
              </article>)}</div>
            </section>
          })}</div>}

        <details className="low-inventory-history"><summary>Recent audit results ({audits.length})</summary>{audits.length === 0 ? <p>No counts have been recorded for this site.</p> : <ul>{audits.map((audit) => <li key={audit.auditId}><strong>{packageIdentity(audit)}</strong><span>{classificationLabel(audit.classification)} · physical {displayQuantity(audit.physicalCount)} / Sweed {displayQuantity(audit.snapshotCurrentQty)} · {audit.transferStatus.replace('_', ' ')}</span></li>)}</ul>}</details>

        {isAdmin && transferConfig && onSaveTransferConfig ? <details className="low-inventory-config"><summary>Transfer settings</summary><form onSubmit={(event) => { event.preventDefault(); const data = new FormData(event.currentTarget); void onSaveTransferConfig({ dealerId: transferConfig.dealerId, destinationName: String(data.get('destinationName') ?? ''), transferEnabled: data.get('transferEnabled') === 'on' }).catch(() => undefined) }}><label>NOT FOR SALE destination<input name="destinationName" defaultValue={transferConfig.destinationName} maxLength={200} required /></label><label><input name="transferEnabled" type="checkbox" defaultChecked={transferConfig.transferEnabled} /> Enable confirmed package transfers for this site</label><button className="primary-button" type="submit" disabled={busy}>Save transfer settings</button></form></details> : null}

        <details className="low-inventory-about"><summary>About this workflow</summary><p>Shows for-sale SKUs with a combined available quantity from 1 through {displayQuantity(response.data.threshold)}. Counts create an audit record. A short or zero result stays pending until an operator separately confirms moving that exact package to the configured NOT FOR SALE room.</p><p>Snapshot time: {response.data.snapshotObservedAt === null ? 'not available' : `${nyLongDateTime(new Date(response.data.snapshotObservedAt).getTime())} New York time`}.</p></details>
      </> : null}

      <LiveBarcodeScanner open={scannerOpen} onDetected={selectScan} onCancel={() => setScannerOpen(false)} />
      {transferReview && transferConfig ? <div className="low-inventory-transfer-scrim" role="presentation"><section ref={transferDialogRef} className="low-inventory-transfer-dialog" role="dialog" aria-modal="true" aria-labelledby="low-inventory-transfer-title" onKeyDown={handleDialogKeyDown}><h3 id="low-inventory-transfer-title">Move this package out of FOR SALE?</h3><dl><div><dt>Site</dt><dd>{siteLabel}</dd></div><div><dt>Package</dt><dd>{transferReview.metrcTag ?? transferReview.inventoryItemId}</dd></div><div><dt>Sweed / physical</dt><dd>{displayQuantity(transferReview.snapshotCurrentQty)} / {displayQuantity(transferReview.physicalCount)}</dd></div><div><dt>From</dt><dd>{transferReview.sourceLocation}</dd></div><div><dt>To</dt><dd>{transferConfig.destinationName}</dd></div></dl><p>The whole package leaves the customer menu. No quantity is changed.</p><div><button type="button" className="ghost-button" onClick={() => setTransferReview(null)}>Cancel</button><button type="button" className="danger-button" disabled={busy} onClick={() => { if (onTransfer) void onTransfer(transferReview.auditId, transferConfig).then(() => setTransferReview(null)).catch(() => undefined) }}>Confirm package move</button></div></section></div> : null}
    </section>
  )
}
