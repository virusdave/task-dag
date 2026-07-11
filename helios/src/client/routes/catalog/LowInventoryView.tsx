import {
  isCannabisCategory,
  type LowInventoryPackage,
  type LowInventoryResponse,
} from '../../../shared/contracts/index.js'
import { nyLongDateTime } from '../../app/nyTime.js'
import { Pill } from '../../components/Pill.js'

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

export function LowInventoryView(props: {
  cannabisOnly: boolean
  onCannabisOnlyChange: (cannabisOnly: boolean) => void
  siteLabel: string
  state: LowInventoryViewState
  onRetry?: () => void
}) {
  const { cannabisOnly, onCannabisOnlyChange, onRetry, siteLabel, state } = props
  const response = state.kind === 'ready' ? state.response : null
  const visibleLocationGroups = response?.data.locationGroups
    .map((group) => ({
      ...group,
      skus: cannabisOnly
        ? group.skus.filter((sku) => isCannabisCategory(sku.categoryName))
        : group.skus,
    }))
    .filter((group) => group.skus.length > 0) ?? []
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
        <Pill tone="muted">Read only</Pill>
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
              <button type="button" className="ghost-button" onClick={onRetry}>Try again</button>
            ) : null}
          </div>
        ) : null}

        {response?.freshness.isStale ? (
          <div className="low-inventory-state-card low-inventory-state-card-stale" role="status">
            <strong>Stock snapshot is stale</strong>
            <span>
              {response.data.snapshotObservedAt === null
                ? 'No stock snapshot is available. Do not use this list for a floor check.'
                : `Last observed ${nyLongDateTime(new Date(response.data.snapshotObservedAt).getTime())} New York time. Do not use this list for a floor check.`}
            </span>
          </div>
        ) : null}
      </div>

      {response ? (
        <>
          <div className="low-inventory-toolbar">
            <label className="low-inventory-cannabis-filter">
              <input
                checked={cannabisOnly}
                onChange={(event) => onCannabisOnlyChange(event.currentTarget.checked)}
                type="checkbox"
              />
              <span>
                <strong>Cannabis only</strong>
                <small>Items without a reported category stay visible.</small>
              </span>
            </label>
            <div
              className="low-inventory-summary"
              aria-atomic="true"
              aria-label="Queue summary"
              aria-live="polite"
            >
              <strong>{skuCount} {skuCount === 1 ? 'SKU' : 'SKUs'}</strong>
              <span>{packageCount} {packageCount === 1 ? 'package' : 'packages'}</span>
              <span>At or below {displayQuantity(response.data.threshold)} available</span>
            </div>
          </div>

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
