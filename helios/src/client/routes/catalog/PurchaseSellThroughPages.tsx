import { useMemo, useState } from 'react'
import { Form, Link, redirect, useLoaderData, useRevalidator, useSearchParams } from 'react-router-dom'

import {
  CATALOG_PURCHASE_PAYMENT_TYPES,
  CatalogPurchaseDetailResponseSchema,
  CatalogPurchaseLineDetailResponseSchema,
  CatalogPurchaseListResponseSchema,
  CatalogPurchasePaymentResponseSchema,
  buildHeliosModulePath,
  type CatalogPurchaseDetailResponse,
  type CatalogPurchaseHeader,
  type CatalogPurchaseLineDetailResponse,
  type CatalogPurchaseLineSellThrough,
  type CatalogPurchaseListResponse,
  type CatalogPurchaseListRow,
  type CatalogPurchaseListSort,
  type CatalogPurchasePaymentResponse,
  type CatalogPurchasePaymentTypeId,
  type CatalogPurchaseSellThroughSummary,
} from '../../../shared/contracts/index.js'
import { loadJson, mutateJson } from '../../app/fetchJson.js'
import { Pill } from '../../components/Pill.js'
import { PurchaseInventoryLifecyclePanel } from './PurchaseInventoryLifecyclePanel.js'
import { useRegisterCatalogSidebarSubtree } from './catalogSidebarSubtree.js'

// ---------------------------------------------------------------------------
// Catalog → Purchase Sell-Through page family.
//
// Three pages share this module:
//   * PurchaseSellThroughListPage  — /catalog/purchases
//   * PurchaseSellThroughDetailPage — /catalog/purchases/:poId
//   * PurchaseSellThroughItemPage   — /catalog/purchases/:poId/items/:lineId
//
// Design rule (per helios AGENTS.md): the operator opens these pages to
// answer a single decision question. The dominant top band must answer
// that question; everything else (methodology, secondary KPIs, raw
// columns) lives in <details>. Money values are always grouped into
// either "Retail dollars" (what we charge customers) or
// "Purchase-cost dollars" (what we pay distributors) so the operator
// never has to reverse-engineer a confusing label.
// ---------------------------------------------------------------------------

const PURCHASES_PATH = buildHeliosModulePath('catalog', 'purchases')

// =================================== LIST ====================================

export async function purchaseSellThroughListLoader({ request }: { request: Request }) {
  const url = new URL(request.url)
  // Default the site filter to Midtown only. We redirect (rather than
  // default server-side) so the URL, the active filter chip, and the
  // site facet checkboxes all stay consistent — and the operator can
  // still pick Bronx / both sites from the filter. Absence of any
  // `sites` param (fresh load, or after clearing it) re-applies Midtown.
  if (!url.searchParams.has('sites')) {
    url.searchParams.set('sites', 'midtown')
    throw redirect(`${PURCHASES_PATH}?${url.searchParams.toString()}`)
  }
  return loadJson(`/api/catalog/purchases${url.search}`, CatalogPurchaseListResponseSchema)
}

const SORT_LABELS: Record<CatalogPurchaseListSort, string> = {
  deliveryDate: 'Delivered',
  paymentDueDate: 'Payment due',
  poTotalDollars: 'Invoice face value',
  distributorName: 'Distributor',
  unitsSold: 'Units sold',
  unitsRemaining: 'Units left',
  unitsAdjusted: 'Units adjusted',
  sellThroughPercent: 'Sell-through',
  // The headline negotiation answer (PO unit cost × units sold).
  realisedCostIfPaidForSoldOnlyDollars: 'Sold-through payment',
  // Realised COGS (package as-of cost). Used for margin math, NOT the
  // vendor payment basis — labelled accordingly so the two never read
  // as competing answers.
  costOfSoldItemsDollars: 'COGS of sold',
  costOfRemainingItemsDollars: 'Unsold stock at cost',
  costOfAdjustedItemsDollars: 'Adjusted / shrink',
  currentListPriceOutstandingDollars: 'Retail list left',
}

const ACTIVE_FILTER_LABELS: Record<string, string> = {
  sites: 'Site',
  distributorNames: 'Distributor',
  orderStatusNames: 'Order',
  financialStatusNames: 'Pay',
  brandNames: 'Brand',
  productSearch: 'Search',
  deliveryFrom: 'Delivered ≥',
  deliveryTo: 'Delivered ≤',
  paymentDueFrom: 'Due ≥',
  paymentDueTo: 'Due ≤',
  totalMin: 'PO ≥ $',
  totalMax: 'PO ≤ $',
}

function flagIsOn(searchParams: URLSearchParams, name: string): boolean {
  const v = (searchParams.get(name) ?? '').trim().toLowerCase()
  return v === '1' || v === 'true' || v === 'on' || v === 'yes'
}
function samplesAreIncluded(searchParams: URLSearchParams): boolean {
  return flagIsOn(searchParams, 'includeSamples')
}
function fullyPaidAreIncluded(searchParams: URLSearchParams): boolean {
  return flagIsOn(searchParams, 'includeFullyPaid')
}
// A user-chosen financial-status filter overrides the default "hide
// fully paid" behaviour, so the toggle is only meaningful without one.
function financialStatusFilterIsExplicit(searchParams: URLSearchParams): boolean {
  return searchParams.getAll('financialStatusNames').some((v) => v.trim().length > 0)
}

export function PurchaseSellThroughListPage(): JSX.Element {
  useRegisterCatalogSidebarSubtree()
  const data = useLoaderData() as CatalogPurchaseListResponse
  const [searchParams] = useSearchParams()
  const totalRows = data.resolved.totalRows
  const page = data.resolved.page
  const pageSize = data.resolved.pageSize
  const totalPages = totalRows === 0 ? 1 : Math.ceil(totalRows / pageSize)
  const hasPrev = page > 1
  const hasNext = page < totalPages

  function buildHref(overrides: Record<string, string | null>): string {
    const params = new URLSearchParams(searchParams)
    for (const [k, v] of Object.entries(overrides)) {
      if (v === null || v === '') params.delete(k)
      else params.set(k, v)
    }
    return `${PURCHASES_PATH}?${params.toString()}`
  }

  function chipHref(remove: { name: string; value?: string }): string {
    const params = new URLSearchParams(searchParams)
    if (remove.value === undefined) {
      params.delete(remove.name)
    } else {
      const remaining = params.getAll(remove.name).filter((v) => v !== remove.value)
      params.delete(remove.name)
      for (const v of remaining) params.append(remove.name, v)
    }
    params.set('page', '1')
    return `${PURCHASES_PATH}?${params.toString()}`
  }

  const activeChips = buildActiveChips(searchParams)
  const filtersAreActive = activeChips.length > 0

  return (
    <div className="page purchase-page">
      <header className="purchase-page-header">
        <h1>Purchase sell-through</h1>
        <p className="purchase-muted">
          {totalRows} purchases · {data.headline.lineCount} lines match current filters
        </p>
      </header>

      <ExposureHero headline={data.headline} />

      {samplesAreIncluded(searchParams) ? (
        <p className="purchase-muted purchase-samples-note">
          Including sample drops (POs &lt; $2).{' '}
          <Link to={buildHref({ includeSamples: null, page: '1' })}>Hide samples</Link>
        </p>
      ) : (
        <p className="purchase-muted purchase-samples-note">
          Hiding sample drops (POs &lt; $2).{' '}
          <Link to={buildHref({ includeSamples: '1', page: '1' })}>Include samples</Link>
        </p>
      )}

      {financialStatusFilterIsExplicit(searchParams) ? null : fullyPaidAreIncluded(searchParams) ? (
        <p className="purchase-muted purchase-samples-note">
          Including fully-paid POs.{' '}
          <Link to={buildHref({ includeFullyPaid: null, page: '1' })}>Hide fully paid</Link>
        </p>
      ) : (
        <p className="purchase-muted purchase-samples-note">
          Hiding fully-paid POs.{' '}
          <Link to={buildHref({ includeFullyPaid: '1', page: '1' })}>Include fully paid</Link>
        </p>
      )}

      <ListFilterBar
        data={data}
        searchParams={searchParams}
        activeChips={activeChips}
        chipHref={chipHref}
      />

      <PurchasesView rows={data.rows} sort={data.resolved.sort} dir={data.resolved.dir} buildHref={buildHref} />

      <div className="purchase-pager">
        <span className="purchase-muted">
          Page {page} of {totalPages} · {totalRows} purchases
        </span>
        {hasPrev ? <Link to={buildHref({ page: String(page - 1) })}>← Prev</Link> : null}
        {hasNext ? <Link to={buildHref({ page: String(page + 1) })}>Next →</Link> : null}
      </div>

      {filtersAreActive ? null : (
        <details className="purchase-methodology">
          <summary>How these numbers are computed</summary>
          <MethodologyNotes />
        </details>
      )}
    </div>
  )
}

function buildActiveChips(
  searchParams: URLSearchParams,
): Array<{ name: string; value?: string; label: string }> {
  const chips: Array<{ name: string; value?: string; label: string }> = []
  const multi = ['sites', 'distributorNames', 'orderStatusNames', 'financialStatusNames', 'brandNames']
  for (const name of multi) {
    for (const value of searchParams.getAll(name)) {
      // Some browsers/forms send empty-string values for unselected
      // hidden inputs; skip those so the chip strip doesn't render an
      // empty `Site:` chip the user can't dismiss.
      if (!value) continue
      chips.push({ name, value, label: `${ACTIVE_FILTER_LABELS[name] ?? name}: ${value}` })
    }
  }
  const single = ['productSearch', 'deliveryFrom', 'deliveryTo', 'paymentDueFrom', 'paymentDueTo', 'totalMin', 'totalMax']
  for (const name of single) {
    const value = searchParams.get(name)
    if (value && value.trim().length > 0) {
      chips.push({ name, label: `${ACTIVE_FILTER_LABELS[name] ?? name}${value}` })
    }
  }
  return chips
}

function MethodologyNotes(): JSX.Element {
  return (
    <ul>
      <li>
        <strong>Sold-through payment basis</strong> = PO unit cost × units sold so far.
        Use this as the "if you paid only for what's sold" anchor in vendor
        negotiations. <em>This is not COGS.</em>
      </li>
      <li>
        <strong>Unsold stock at cost</strong> = PO unit cost × units still on hand in
        the package(s) we matched to this line by Metrc tag.
      </li>
      <li>
        <strong>Adjusted / shrink</strong> = PO unit cost × units that disappeared from
        the package without showing up as a retail sale (breakage, destruction,
        return-to-distributor, samples, Metrc disposals). Clamped ≥ 0.
      </li>
      <li>
        <strong>Committed PO</strong> = invoice face value reported by Sweed.
      </li>
      <li>
        <strong>Retail collected</strong> is gross of discount — what the register took
        in for those units.
      </li>
      <li>
        <strong>COGS of sold</strong> (collapsed under "Margin / COGS detail" on
        per-line views) is Σ qty × wholesale cost-as-of pay_time. Use it for margin
        math; <em>do not</em> use it as the vendor payment basis — it diverges from
        the invoice unit cost when distributor cost changed mid-PO.
      </li>
      <li>
        Lines are matched to inventory packages via Metrc tag
        (<code>externalTrackCode</code>) at PO-fetch time, so the join is exact (no
        fuzzy matching at read time).
      </li>
    </ul>
  )
}

// ---------------------------------------------------------------------------
// Hero exposure band — the dominant answer for the list page.
// ---------------------------------------------------------------------------

function ExposureHero(props: { headline: CatalogPurchaseListResponse['headline'] }): JSX.Element {
  const h = props.headline
  const sellThroughPct = h.unitsOrdered > 0 ? h.unitsSold / h.unitsOrdered : null
  const exposureTotal = h.costOfRemainingItemsDollars + h.costOfAdjustedItemsDollars

  return (
    <section className="purchase-hero" aria-label="Vendor payment basis across filtered purchases">
      <div className="purchase-hero-primary">
        <div className="purchase-eyebrow">Sold-through payment basis</div>
        <div className="purchase-answer-value">
          {fmtUsd(h.realisedCostIfPaidForSoldOnlyDollars)}
        </div>
        <div className="purchase-muted purchase-hero-primary-sub">
          What you'd owe across these {fmtInt(h.purchaseCount)} POs if you paid only for the{' '}
          {fmtInt(h.unitsSold)} units that have sold so far
          {sellThroughPct !== null ? ` (${pct(sellThroughPct)} of ${fmtInt(h.unitsOrdered)} ordered)` : ''}
          .
        </div>
      </div>
      <div className="purchase-hero-supporting">
        <HeroMetric
          eyebrow="Remaining exposure"
          value={fmtUsd(exposureTotal)}
          sub={
            h.costOfAdjustedItemsDollars > 0
              ? `${fmtUsd(h.costOfRemainingItemsDollars)} in stock · ${fmtUsd(h.costOfAdjustedItemsDollars)} adjusted`
              : `${fmtUsd(h.costOfRemainingItemsDollars)} in stock`
          }
          tone={h.costOfAdjustedItemsDollars > 0 ? 'danger' : 'cost'}
        />
        <HeroMetric
          eyebrow="Committed PO cost"
          value={fmtUsd(h.poTotalDollars)}
          sub={`invoice face value across ${fmtInt(h.purchaseCount)} POs`}
          tone="cost"
        />
        <HeroMetric
          eyebrow="Retail collected"
          value={fmtUsd(h.soldRevenueDollars)}
          sub={`gross of discount on ${fmtInt(h.unitsSold)} sold units`}
          tone="retail"
        />
        <HeroMetric
          eyebrow="Retail list left"
          value={fmtUsd(h.currentListPriceOutstandingDollars)}
          sub={`${fmtInt(h.unitsRemaining)} units in stock`}
          tone="retail"
        />
      </div>
    </section>
  )
}

function HeroMetric(props: {
  eyebrow: string
  value: string
  sub?: string | null
  tone?: 'retail' | 'cost' | 'danger'
}): JSX.Element {
  const toneClass =
    props.tone === 'retail'
      ? 'purchase-metric-retail'
      : props.tone === 'danger'
        ? 'purchase-metric-danger'
        : 'purchase-metric-cost'
  return (
    <div className={`purchase-metric ${toneClass}`}>
      <div className="purchase-eyebrow">{props.eyebrow}</div>
      <div className="purchase-metric-value">{props.value}</div>
      {props.sub ? <div className="purchase-muted">{props.sub}</div> : null}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Filter bar (always-visible search + active chips; details for everything else).
// ---------------------------------------------------------------------------

function ListFilterBar(props: {
  data: CatalogPurchaseListResponse
  searchParams: URLSearchParams
  activeChips: Array<{ name: string; value?: string; label: string }>
  chipHref: (remove: { name: string; value?: string }) => string
}): JSX.Element {
  const { data, searchParams, activeChips, chipHref } = props
  const activeCount = activeChips.length
  return (
    <div className="purchase-filter-bar">
      <Form method="get" className="purchase-filter-search">
        <input
          type="search"
          name="productSearch"
          defaultValue={searchParams.get('productSearch') ?? ''}
          placeholder="Search PO #, amount, product, brand…"
        />
        {/* Preserve every other current filter so a quick search doesn't
            wipe the user's facet selections. */}
        {preserveHiddenFilters(searchParams, ['productSearch', 'page'])}
        <input type="hidden" name="page" value="1" />
        <button type="submit">Search</button>
      </Form>

      {activeCount > 0 ? (
        <div className="purchase-active-chips" role="list" aria-label="Active filters">
          {activeChips.map((c, idx) => (
            <Link
              key={`${c.name}:${c.value ?? ''}:${idx}`}
              to={chipHref({ name: c.name, value: c.value })}
              className="purchase-chip"
              role="listitem"
              title="Remove this filter"
            >
              {c.label} <span aria-hidden>×</span>
            </Link>
          ))}
          <Link to={PURCHASES_PATH} className="purchase-chip purchase-chip-reset">
            Clear all
          </Link>
        </div>
      ) : null}

      <details className="purchase-filter-details">
        <summary>
          Filters{activeCount > 0 ? ` (${activeCount} active)` : ''}
        </summary>
        <Form method="get" className="purchase-filter-form">
          <FacetChecklist
            name="sites"
            legend="Site"
            options={data.facets.sites}
            selected={new Set(searchParams.getAll('sites'))}
          />
          <FacetChecklist
            name="distributorNames"
            legend="Distributor"
            options={data.facets.distributors}
            selected={new Set(searchParams.getAll('distributorNames'))}
            maxVisible={12}
          />
          <FacetChecklist
            name="orderStatusNames"
            legend="Order status"
            options={data.facets.orderStatuses}
            selected={new Set(searchParams.getAll('orderStatusNames'))}
          />
          <FacetChecklist
            name="financialStatusNames"
            legend="Financial status"
            options={data.facets.financialStatuses}
            selected={new Set(searchParams.getAll('financialStatusNames'))}
          />
          <FacetChecklist
            name="brandNames"
            legend="Brand"
            options={data.facets.brands}
            selected={new Set(searchParams.getAll('brandNames'))}
            maxVisible={16}
          />
          <fieldset className="purchase-range-fieldset">
            <legend>Delivered between</legend>
            <input type="date" name="deliveryFrom" defaultValue={searchParams.get('deliveryFrom') ?? ''} />
            <input type="date" name="deliveryTo" defaultValue={searchParams.get('deliveryTo') ?? ''} />
          </fieldset>
          <fieldset className="purchase-range-fieldset">
            <legend>Payment due between</legend>
            <input type="date" name="paymentDueFrom" defaultValue={searchParams.get('paymentDueFrom') ?? ''} />
            <input type="date" name="paymentDueTo" defaultValue={searchParams.get('paymentDueTo') ?? ''} />
          </fieldset>
          <fieldset className="purchase-range-fieldset">
            <legend>PO total ($)</legend>
            <input
              type="number"
              step="0.01"
              name="totalMin"
              placeholder="min"
              defaultValue={searchParams.get('totalMin') ?? ''}
            />
            <input
              type="number"
              step="0.01"
              name="totalMax"
              placeholder="max"
              defaultValue={searchParams.get('totalMax') ?? ''}
            />
          </fieldset>
          <label className="purchase-stack-field">
            <span>Product search</span>
            <input
              type="search"
              name="productSearch"
              defaultValue={searchParams.get('productSearch') ?? ''}
              placeholder="product / distributor name"
            />
          </label>
          <input type="hidden" name="page" value="1" />
          <input type="hidden" name="sort" value={data.resolved.sort} />
          <input type="hidden" name="dir" value={data.resolved.dir} />
          <input type="hidden" name="pageSize" value={String(data.resolved.pageSize)} />
          <div className="purchase-filter-actions">
            <button type="submit">Apply filters</button>
            <Link to={PURCHASES_PATH}>Reset</Link>
          </div>
        </Form>
      </details>
    </div>
  )
}

function preserveHiddenFilters(
  searchParams: URLSearchParams,
  exclude: string[],
): JSX.Element[] {
  const excludeSet = new Set(exclude)
  const out: JSX.Element[] = []
  let i = 0
  for (const [k, v] of searchParams.entries()) {
    if (excludeSet.has(k)) continue
    out.push(<input key={i++} type="hidden" name={k} value={v} />)
  }
  return out
}

function FacetChecklist(props: {
  name: string
  legend: string
  options: Array<{ id: string; label: string; count: number }>
  selected: Set<string>
  maxVisible?: number
}): JSX.Element {
  const { name, legend, options, selected, maxVisible } = props
  const [showAll, setShowAll] = useState(false)
  const visible = useMemo(() => {
    if (maxVisible === undefined || showAll) return options
    // Always include selected ones in the visible cap so the user
    // sees what's already checked.
    const head = options.slice(0, maxVisible)
    const headIds = new Set(head.map((o) => o.id))
    const extras = options.filter((o) => selected.has(o.id) && !headIds.has(o.id))
    return [...head, ...extras]
  }, [options, maxVisible, showAll, selected])
  if (options.length === 0) return <></>
  return (
    <fieldset className="purchase-facet">
      <legend>{legend}</legend>
      <div className="purchase-facet-list">
        {visible.map((opt) => (
          <label
            key={opt.id}
            className={`purchase-facet-chip${selected.has(opt.id) ? ' purchase-facet-chip-on' : ''}`}
          >
            <input
              type="checkbox"
              name={name}
              value={opt.id}
              defaultChecked={selected.has(opt.id)}
            />
            <span className="purchase-facet-chip-label">{opt.label}</span>
            <small className="purchase-facet-chip-count">{opt.count}</small>
          </label>
        ))}
      </div>
      {maxVisible !== undefined && options.length > visible.length ? (
        <button
          type="button"
          className="purchase-facet-toggle"
          onClick={() => setShowAll(true)}
        >
          Show {options.length - visible.length} more…
        </button>
      ) : null}
      {maxVisible !== undefined && showAll && options.length > maxVisible ? (
        <button
          type="button"
          className="purchase-facet-toggle"
          onClick={() => setShowAll(false)}
        >
          Show fewer
        </button>
      ) : null}
    </fieldset>
  )
}

// ---------------------------------------------------------------------------
// Purchases list (desktop table + mobile cards driven by the same data)
// ---------------------------------------------------------------------------

function PurchasesView(props: {
  rows: CatalogPurchaseListRow[]
  sort: CatalogPurchaseListSort
  dir: 'asc' | 'desc'
  buildHref: (overrides: Record<string, string | null>) => string
}): JSX.Element {
  if (props.rows.length === 0) {
    return (
      <p className="purchase-muted">
        No purchases match the current filters. (If you expect data here, the ingest
        worker may not have caught up yet — check{' '}
        <Link to={buildHeliosModulePath('config', 'workers/scheduling/sweed-purchases-ingest')}>
          Config → Workers → Sweed purchases ingest
        </Link>
        .)
      </p>
    )
  }
  return (
    <>
      <PurchasesDesktopTable {...props} />
      <PurchasesMobileCards rows={props.rows} />
    </>
  )
}

function PurchasesDesktopTable(props: {
  rows: CatalogPurchaseListRow[]
  sort: CatalogPurchaseListSort
  dir: 'asc' | 'desc'
  buildHref: (overrides: Record<string, string | null>) => string
}): JSX.Element {
  function sortHeader(col: CatalogPurchaseListSort, label?: string): JSX.Element {
    const isActive = props.sort === col
    const nextDir = isActive && props.dir === 'desc' ? 'asc' : 'desc'
    const arrow = isActive ? (props.dir === 'desc' ? ' ↓' : ' ↑') : ''
    return (
      <Link to={props.buildHref({ sort: col, dir: nextDir, page: '1' })}>
        {label ?? SORT_LABELS[col]}
        {arrow}
      </Link>
    )
  }
  return (
    <div className="purchase-desktop-only">
      <div className="purchase-table-wrap">
        <table className="data-table purchase-table">
          <thead>
            <tr>
              <th className="num purchase-cell-facevalue">
                {sortHeader('poTotalDollars', 'Invoice face value')}
              </th>
              <th>{sortHeader('deliveryDate', 'Purchase')}</th>
              <th className="num purchase-cell-primary">
                {sortHeader('realisedCostIfPaidForSoldOnlyDollars', 'Sold-through payment')}
              </th>
              <th className="num purchase-cell-cost">
                {sortHeader('costOfRemainingItemsDollars', 'Unsold stock at cost')}
              </th>
              <th className="num purchase-cell-cost">
                {sortHeader('costOfAdjustedItemsDollars', 'Adjusted / shrink')}
              </th>
              <th className="num">{sortHeader('sellThroughPercent', 'Sell-through')}</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {props.rows.map((row) => (
              <PurchaseTableRow key={`${row.dealerId}:${row.poId}`} row={row} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function PurchaseTableRow(props: { row: CatalogPurchaseListRow }): JSX.Element {
  const { row } = props
  const href = `${PURCHASES_PATH}/${encodeURIComponent(row.poId)}?dealerId=${row.dealerId}`
  const productPreview =
    row.productNamesPreview.length > 0 ? row.productNamesPreview.slice(0, 2).join(', ') : null
  const productPreviewMore = Math.max(row.productNamesPreview.length - 2, 0)
  return (
    <tr>
      <td className="num purchase-cell-facevalue">
        <div className="purchase-cell-facevalue-value">{fmtUsd(row.poTotalDollars)}</div>
        <div className="purchase-muted">
          {row.externalOrderId || row.poName || row.poId}
        </div>
      </td>
      <td>
        <div className="purchase-row-purchase">
          <Link to={href} className="purchase-row-distributor" target="_blank" rel="noreferrer">
            {row.distributorName ?? '—'}
          </Link>
          <div className="purchase-muted">
            {row.siteKey} · delivered {row.deliveryDate ?? '—'}
            {row.paymentDueDate ? ` · due ${row.paymentDueDate}` : ''}
          </div>
          <div className="purchase-muted purchase-row-poid">
            {row.poName || row.externalOrderId || row.poId} · {row.lineCount} lines ·{' '}
            {fmtInt(row.unitsOrdered)} units
          </div>
          {row.brandNames.length > 0 ? (
            <div className="purchase-row-brands">
              {row.brandNames.slice(0, 3).map((b) => (
                <Pill key={b} tone="muted">{b}</Pill>
              ))}
              {row.brandNames.length > 3 ? (
                <span className="purchase-muted">+{row.brandNames.length - 3}</span>
              ) : null}
            </div>
          ) : null}
          {productPreview ? (
            <div className="purchase-muted purchase-row-products" title={row.productNamesPreview.join(', ')}>
              {productPreview}
              {productPreviewMore > 0 ? ` +${productPreviewMore}` : ''}
            </div>
          ) : null}
        </div>
      </td>
      <td className="num purchase-cell-primary">
        <div className="purchase-cell-primary-value">
          {fmtUsd(row.realisedCostIfPaidForSoldOnlyDollars)}
        </div>
        <div className="purchase-muted">
          {fmtInt(row.unitsSold)} sold · retail collected {fmtUsd(row.soldRevenueDollars)}
        </div>
      </td>
      <td className="num purchase-cell-cost">
        <strong>{fmtUsd(row.costOfRemainingItemsDollars)}</strong>
        <div className="purchase-muted">
          {fmtInt(row.unitsRemaining)} units · list {fmtUsd(row.currentListPriceOutstandingDollars)}
        </div>
      </td>
      <td className="num purchase-cell-cost">
        {row.costOfAdjustedItemsDollars > 0 ? (
          <strong className="purchase-danger">{fmtUsd(row.costOfAdjustedItemsDollars)}</strong>
        ) : (
          <span className="purchase-muted">$0</span>
        )}
        <div className="purchase-muted">
          {row.unitsAdjusted > 0 ? `${fmtInt(row.unitsAdjusted)} units` : 'none'}
        </div>
      </td>
      <td className="num">
        <div className="purchase-line-movement-value">
          {row.sellThroughPercent !== null ? pct(row.sellThroughPercent / 100) : '—'}
        </div>
        <div className="purchase-muted">
          {fmtInt(row.unitsSold)} / {fmtInt(row.unitsOrdered)} units
        </div>
      </td>
      <td>
        <div className="purchase-status-stack">
          {row.financialStatusName ? <Pill tone="muted">{row.financialStatusName}</Pill> : null}
          {row.orderStatusName ? <Pill tone="muted">{row.orderStatusName}</Pill> : null}
          {row.isCashOnDelivery ? <Pill tone="muted">COD</Pill> : null}
        </div>
      </td>
    </tr>
  )
}

function PurchasesMobileCards(props: { rows: CatalogPurchaseListRow[] }): JSX.Element {
  return (
    <div className="purchase-mobile-only purchase-card-list">
      {props.rows.map((row) => (
        <PurchaseMobileCard key={`${row.dealerId}:${row.poId}`} row={row} />
      ))}
    </div>
  )
}

function PurchaseMobileCard(props: { row: CatalogPurchaseListRow }): JSX.Element {
  const { row } = props
  const href = `${PURCHASES_PATH}/${encodeURIComponent(row.poId)}?dealerId=${row.dealerId}`
  const remainingExposure = row.costOfRemainingItemsDollars + row.costOfAdjustedItemsDollars
  return (
    <article className="purchase-card">
      <header className="purchase-card-head">
        <Link to={href} className="purchase-card-distributor" target="_blank" rel="noreferrer">
          {row.distributorName ?? '—'}
        </Link>
        <div className="purchase-muted">
          {row.siteKey} · delivered {row.deliveryDate ?? '—'}
          {row.paymentDueDate ? ` · due ${row.paymentDueDate}` : ''}
        </div>
        <div className="purchase-muted">
          {row.poName || row.externalOrderId || row.poId} · {row.lineCount} lines ·{' '}
          {fmtInt(row.unitsOrdered)} units
        </div>
      </header>
      <div className="purchase-card-primary purchase-cell-primary">
        <div className="purchase-eyebrow">Sold-through payment basis</div>
        <div className="purchase-cell-primary-value">
          {fmtUsd(row.realisedCostIfPaidForSoldOnlyDollars)}
        </div>
        <div className="purchase-muted">
          {fmtInt(row.unitsSold)} / {fmtInt(row.unitsOrdered)} units sold (
          {row.sellThroughPercent !== null ? pct(row.sellThroughPercent / 100) : '—'})
        </div>
      </div>
      <dl className="purchase-card-buckets">
        <div>
          <dt>Unsold stock at cost</dt>
          <dd>{fmtUsd(row.costOfRemainingItemsDollars)}</dd>
        </div>
        <div>
          <dt>Adjusted / shrink</dt>
          <dd>
            {row.costOfAdjustedItemsDollars > 0 ? (
              <span className="purchase-danger">{fmtUsd(row.costOfAdjustedItemsDollars)}</span>
            ) : (
              <span className="purchase-muted">$0</span>
            )}
          </dd>
        </div>
        <div>
          <dt>Remaining exposure</dt>
          <dd>{fmtUsd(remainingExposure)}</dd>
        </div>
        <div>
          <dt>Retail list left</dt>
          <dd>{fmtUsd(row.currentListPriceOutstandingDollars)}</dd>
        </div>
        <div>
          <dt>Committed PO</dt>
          <dd>{fmtUsd(row.poTotalDollars)}</dd>
        </div>
        <div>
          <dt>Retail collected</dt>
          <dd>{fmtUsd(row.soldRevenueDollars)}</dd>
        </div>
      </dl>
      <footer className="purchase-card-foot">
        {row.brandNames.length > 0 ? (
          <div className="purchase-row-brands">
            {row.brandNames.slice(0, 4).map((b) => (
              <Pill key={b} tone="muted">{b}</Pill>
            ))}
            {row.brandNames.length > 4 ? (
              <span className="purchase-muted">+{row.brandNames.length - 4}</span>
            ) : null}
          </div>
        ) : null}
        <div className="purchase-status-stack">
          {row.financialStatusName ? <Pill tone="muted">{row.financialStatusName}</Pill> : null}
          {row.orderStatusName ? <Pill tone="muted">{row.orderStatusName}</Pill> : null}
          {row.isCashOnDelivery ? <Pill tone="muted">COD</Pill> : null}
        </div>
      </footer>
    </article>
  )
}

// =================================== DETAIL ==================================

export async function purchaseSellThroughDetailLoader({
  params,
  request,
}: {
  params: Record<string, string | undefined>
  request: Request
}) {
  const url = new URL(request.url)
  const dealerId = url.searchParams.get('dealerId')
  if (!dealerId) {
    throw new Response('dealerId query parameter required', { status: 400 })
  }
  const poId = params.poId ?? ''
  return loadJson(
    `/api/catalog/purchases/${encodeURIComponent(poId)}?dealerId=${encodeURIComponent(dealerId)}`,
    CatalogPurchaseDetailResponseSchema,
  )
}

export function PurchaseSellThroughDetailPage(): JSX.Element {
  useRegisterCatalogSidebarSubtree()
  const data = useLoaderData() as CatalogPurchaseDetailResponse
  const { purchase, summary, lines } = data

  const matchedFraction =
    summary.totalLineCount > 0 ? summary.matchedLineCount / summary.totalLineCount : null
  const verdict = computePurchaseVerdict(summary)

  return (
    <div className="page purchase-page">
      <header className="purchase-page-header">
        <p className="purchase-muted">
          <Link to={PURCHASES_PATH}>← All purchases</Link>
        </p>
        <h1>
          {purchase.distributorName ?? 'Unknown distributor'} — PO{' '}
          {purchase.externalOrderId ?? purchase.poId}
        </h1>
        <p className="purchase-muted">
          {purchase.siteKey} · delivered {purchase.deliveryDate ?? '—'} · due{' '}
          {purchase.paymentDueDate ?? '—'}
        </p>
        <div className="purchase-status-stack">
          {purchase.orderStatusName ? <Pill tone="muted">{purchase.orderStatusName}</Pill> : null}
          {purchase.financialStatusName ? <Pill tone="muted">{purchase.financialStatusName}</Pill> : null}
          {purchase.isCashOnDelivery ? <Pill tone="muted">COD</Pill> : null}
        </div>
      </header>

      <PurchaseDetailHero summary={summary} verdict={verdict} matchedFraction={matchedFraction} />

      <PurchasePaymentPanel purchase={purchase} />

      <PurchaseInventoryLifecyclePanel purchase={purchase} />

      <h2 className="purchase-section-title">Line items</h2>
      <PurchaseLinesView lines={lines} purchase={purchase} />

      <details className="purchase-methodology">
        <summary>About this PO &amp; methodology</summary>
        <dl className="purchase-meta-dl">
          {summary.poTotalDollars !== null ? (
            <>
              <dt>Subtotal</dt>
              <dd>{fmtUsd(purchase.poSubtotalDollars)}</dd>
              <dt>Discount</dt>
              <dd>{fmtUsd(purchase.poDiscountAmountDollars)}</dd>
              <dt>Tax</dt>
              <dd>{fmtUsd(purchase.poTaxDollars)}</dd>
              <dt>Owed</dt>
              <dd>{fmtUsd(purchase.poOwedDollars)}</dd>
            </>
          ) : null}
          <dt>Lines matched to packages</dt>
          <dd>
            {summary.matchedLineCount} / {summary.totalLineCount}
            {matchedFraction !== null ? ` (${pct(matchedFraction)})` : ''}
          </dd>
          <dt>Fetched</dt>
          <dd>{purchase.fetchedAt}</dd>
        </dl>
        <MethodologyNotes />
      </details>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Record-payment panel (detail page)
//
// Lets the operator mark a PO partially or fully paid. "Mark fully paid"
// records the amount actually paid, then — if a balance remains — writes
// the remainder into Sweed as a Check tagged "unpayable balance", zeroing
// the PO out. The write goes through POST /api/catalog/purchases/:poId/
// payments, which talks to Sweed and re-mirrors the PO.
// ---------------------------------------------------------------------------

function todayInputValue(): string {
  // <input type="date"> wants YYYY-MM-DD in local terms; en-CA gives that.
  return new Intl.DateTimeFormat('en-CA').format(new Date())
}

function PurchasePaymentPanel(props: { purchase: CatalogPurchaseHeader }): JSX.Element {
  const { purchase } = props
  const revalidator = useRevalidator()

  const owed = purchase.poOwedDollars
  const faceValue = purchase.poTotalDollars
  const alreadyPaid =
    faceValue !== null && owed !== null ? Math.max(faceValue - owed, 0) : null
  const nothingOwed = owed !== null && owed <= 0.005

  const [amount, setAmount] = useState<string>(owed !== null && owed > 0 ? owed.toFixed(2) : '')
  const [methodId, setMethodId] = useState<CatalogPurchasePaymentTypeId>(1)
  const [payTime, setPayTime] = useState<string>(todayInputValue())
  const [busy, setBusy] = useState<null | 'partial' | 'full'>(null)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<CatalogPurchasePaymentResponse['recorded'] | null>(null)

  async function submit(markFullyPaid: boolean): Promise<void> {
    setError(null)
    setResult(null)
    const payAmount = Number(amount)
    if (!Number.isFinite(payAmount) || payAmount < 0) {
      setError('Enter a valid payment amount.')
      return
    }
    if (!markFullyPaid && payAmount <= 0) {
      setError('Enter an amount greater than $0 for a partial payment.')
      return
    }
    if (owed !== null && payAmount > owed + 0.005) {
      setError(`Payment exceeds the $${owed.toFixed(2)} owed.`)
      return
    }
    setBusy(markFullyPaid ? 'full' : 'partial')
    try {
      const resp = await mutateJson(
        `/api/catalog/purchases/${encodeURIComponent(purchase.poId)}/payments`,
        CatalogPurchasePaymentResponseSchema,
        {
          method: 'POST',
          body: JSON.stringify({
            dealerId: purchase.dealerId,
            payAmount,
            orderPaymentTypeId: methodId,
            payTime,
            markFullyPaid,
            expectedOwedDollars: owed ?? undefined,
          }),
        },
      )
      setResult(resp.recorded)
      // Re-run the loader so the header/owed/status reflect the write.
      revalidator.revalidate()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Payment failed.')
    } finally {
      setBusy(null)
    }
  }

  return (
    <section className="purchase-payment-panel" aria-label="Record payment">
      <h2 className="purchase-section-title">Record payment</h2>
      <dl className="purchase-payment-figures">
        <div>
          <dt>Invoice face value</dt>
          <dd>{fmtUsd(faceValue)}</dd>
        </div>
        <div>
          <dt>Already paid</dt>
          <dd>{alreadyPaid !== null ? fmtUsd(alreadyPaid) : '—'}</dd>
        </div>
        <div>
          <dt>Owed</dt>
          <dd className={nothingOwed ? undefined : 'purchase-danger'}>{fmtUsd(owed)}</dd>
        </div>
        <div>
          <dt>Status</dt>
          <dd>{purchase.financialStatusName ?? '—'}</dd>
        </div>
      </dl>

      {nothingOwed ? (
        <p className="purchase-muted">This PO is fully paid — nothing owed.</p>
      ) : (
        <div className="purchase-payment-form">
          <label>
            <span>Amount paid</span>
            <input
              type="number"
              min="0"
              step="0.01"
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              disabled={busy !== null}
            />
          </label>
          <label>
            <span>Method</span>
            <select
              value={methodId}
              onChange={(e) => setMethodId(Number(e.target.value) as CatalogPurchasePaymentTypeId)}
              disabled={busy !== null}
            >
              {CATALOG_PURCHASE_PAYMENT_TYPES.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>Payment date</span>
            <input
              type="date"
              value={payTime}
              onChange={(e) => setPayTime(e.target.value)}
              disabled={busy !== null}
            />
          </label>
          <div className="purchase-payment-actions">
            <button type="button" onClick={() => submit(false)} disabled={busy !== null}>
              {busy === 'partial' ? 'Recording…' : 'Record partial payment'}
            </button>
            <button
              type="button"
              className="purchase-payment-fullpaid"
              onClick={() => submit(true)}
              disabled={busy !== null}
            >
              {busy === 'full' ? 'Recording…' : 'Mark fully paid'}
            </button>
          </div>
          <p className="purchase-muted purchase-payment-hint">
            “Mark fully paid” records the amount above, then books any remaining
            balance as a Check noted “unpayable balance” so the PO zeroes out.
          </p>
        </div>
      )}

      {error ? <p className="purchase-danger purchase-payment-msg">{error}</p> : null}
      {result ? (
        <p className="purchase-payment-msg">
          Recorded {fmtUsd(result.paymentDollars)}
          {result.unpayableBalanceCheckDollars
            ? ` + ${fmtUsd(result.unpayableBalanceCheckDollars)} unpayable-balance Check`
            : ''}
          . PO is now {result.financialStatusName ?? 'updated'} (owed{' '}
          {fmtUsd(result.owedAfterDollars)}).
        </p>
      ) : null}
    </section>
  )
}

type PurchaseVerdict = {
  kind: 'cash' | 'dead-stock' | 'shrinkage' | 'fresh'
  label: string
  detail: string
}

function computePurchaseVerdict(summary: CatalogPurchaseSellThroughSummary): PurchaseVerdict {
  const poCost = summary.poTotalDollars ?? 0
  const shrinkRatio = poCost > 0 ? summary.costOfAdjustedItemsDollars / poCost : 0
  const stockRatio = poCost > 0 ? summary.costOfRemainingItemsDollars / poCost : 0
  const sellThrough = summary.unitsOrdered > 0 ? summary.unitsSold / summary.unitsOrdered : null
  if (shrinkRatio >= 0.05) {
    return {
      kind: 'shrinkage',
      label: 'Shrinkage flag',
      detail: `${pct(shrinkRatio)} of PO cost (${fmtUsd(summary.costOfAdjustedItemsDollars)}) vanished without a sale.`,
    }
  }
  if (stockRatio >= 0.4 && sellThrough !== null && sellThrough < 0.6) {
    return {
      kind: 'dead-stock',
      label: 'Dead-stock risk',
      detail: `${pct(stockRatio)} of PO cost (${fmtUsd(summary.costOfRemainingItemsDollars)}) still in stock at ${pct(sellThrough)} sell-through.`,
    }
  }
  if (sellThrough !== null && sellThrough >= 0.6) {
    return {
      kind: 'cash',
      label: 'Turning into cash',
      detail: `${pct(sellThrough)} sold · ${fmtUsd(summary.soldRevenueDollars)} retail revenue.`,
    }
  }
  return {
    kind: 'fresh',
    label: 'Too fresh to call',
    detail:
      sellThrough !== null
        ? `${pct(sellThrough)} sold · keep watching.`
        : 'No sales tracked yet for this PO.',
  }
}

function PurchaseDetailHero(props: {
  summary: CatalogPurchaseSellThroughSummary
  verdict: PurchaseVerdict
  matchedFraction: number | null
}): JSX.Element {
  const { summary, verdict, matchedFraction } = props
  const sellThroughPct = summary.unitsOrdered > 0 ? summary.unitsSold / summary.unitsOrdered : null
  const remainingExposure = summary.costOfRemainingItemsDollars + summary.costOfAdjustedItemsDollars
  return (
    <section className="purchase-hero" aria-label="PO vendor payment basis and exposure">
      <div className="purchase-hero-primary">
        <div className="purchase-eyebrow">Sold-through payment basis</div>
        <div className="purchase-answer-value">
          {fmtUsd(summary.realisedCostIfPaidForSoldOnlyDollars)}
        </div>
        <div className="purchase-muted purchase-hero-primary-sub">
          What you'd owe on this PO if you paid only for the {fmtInt(summary.unitsSold)} units
          that have sold so far
          {sellThroughPct !== null ? ` (${pct(sellThroughPct)} of ${fmtInt(summary.unitsOrdered)} ordered)` : ''}
          .{' '}
          <span className={`purchase-verdict-${verdict.kind}`} title={verdict.detail}>
            Signal: {verdict.label}.
          </span>
          {matchedFraction !== null && matchedFraction < 1 ? (
            <>
              {' '}
              <span className="purchase-danger">
                Only {summary.matchedLineCount}/{summary.totalLineCount} lines matched to inventory packages —
                unmatched lines contribute $0 to the basis above.
              </span>
            </>
          ) : null}
        </div>
      </div>
      <div className="purchase-hero-supporting">
        <HeroMetric
          eyebrow="Remaining exposure"
          value={fmtUsd(remainingExposure)}
          sub={
            summary.costOfAdjustedItemsDollars > 0
              ? `${fmtUsd(summary.costOfRemainingItemsDollars)} in stock · ${fmtUsd(summary.costOfAdjustedItemsDollars)} adjusted`
              : `${fmtUsd(summary.costOfRemainingItemsDollars)} in stock`
          }
          tone={summary.costOfAdjustedItemsDollars > 0 ? 'danger' : 'cost'}
        />
        <HeroMetric
          eyebrow="Committed PO cost"
          value={fmtUsd(summary.poTotalDollars ?? 0)}
          sub="invoice face value"
          tone="cost"
        />
        <HeroMetric
          eyebrow="Retail collected"
          value={fmtUsd(summary.soldRevenueDollars)}
          sub={`gross of discount on ${fmtInt(summary.unitsSold)} units`}
          tone="retail"
        />
        <HeroMetric
          eyebrow="Retail list left"
          value={fmtUsd(summary.currentListPriceOutstandingDollars)}
          sub={`${fmtInt(summary.unitsRemaining)} units in stock`}
          tone="retail"
        />
      </div>
    </section>
  )
}

function PurchaseLinesView(props: {
  lines: CatalogPurchaseLineSellThrough[]
  purchase: CatalogPurchaseDetailResponse['purchase']
}): JSX.Element {
  if (props.lines.length === 0) {
    return <p className="purchase-muted">No line items recorded for this PO.</p>
  }
  return (
    <>
      <PurchaseLinesTable {...props} />
      <PurchaseLinesCards {...props} />
    </>
  )
}

function PurchaseLinesTable(props: {
  lines: CatalogPurchaseLineSellThrough[]
  purchase: CatalogPurchaseDetailResponse['purchase']
}): JSX.Element {
  return (
    <div className="purchase-desktop-only purchase-table-wrap">
      <table className="data-table purchase-table">
        <thead>
          <tr>
            <th>Item</th>
            <th className="num">Units (sold / ordered / left)</th>
            <th className="num purchase-cell-primary">Sold-through payment</th>
            <th className="num purchase-cell-cost">Unsold stock at cost</th>
            <th className="num purchase-cell-cost">Adjusted / shrink</th>
            <th className="num purchase-cell-retail">Retail $</th>
            <th>Signal</th>
          </tr>
        </thead>
        <tbody>
          {props.lines.map((line) => (
            <PurchaseLineRow key={line.lineId} line={line} purchase={props.purchase} />
          ))}
        </tbody>
      </table>
    </div>
  )
}

function PurchaseLineRow(props: {
  line: CatalogPurchaseLineSellThrough
  purchase: CatalogPurchaseDetailResponse['purchase']
}): JSX.Element {
  const { line, purchase } = props
  const itemHref = `${PURCHASES_PATH}/${encodeURIComponent(purchase.poId)}/items/${encodeURIComponent(line.lineId)}?dealerId=${purchase.dealerId}`
  const lineCommitted = (line.unitCostDollars ?? 0) * line.orderedUnits
  return (
    <tr>
      <td>
        <div className="purchase-line-item">
          <Link
            to={itemHref}
            className="purchase-line-product"
            target="_blank"
            rel="noreferrer"
          >
            {line.productName ?? line.distributorProductName ?? '(unnamed)'}
          </Link>
          <div className="purchase-muted">
            {[line.brandName, line.categoryName, line.subcategoryName, line.sizeLabel]
              .filter((v): v is string => !!v)
              .join(' · ') || '—'}
          </div>
          <div className="purchase-muted purchase-row-poid">
            unit cost {fmtUsd(line.unitCostDollars ?? 0)} · committed {fmtUsd(lineCommitted)}
            {line.daysSinceReceived !== null ? ` · ${line.daysSinceReceived}d on shelf` : ''}
          </div>
        </div>
      </td>
      <td className="num">
        <div className="purchase-line-movement-value">
          {line.sellThroughPercent !== null ? pct(line.sellThroughPercent / 100) : '—'}
        </div>
        <div className="purchase-muted">
          {fmtInt(line.unitsSoldToDate)} / {fmtInt(line.orderedUnits)} sold ·{' '}
          {fmtInt(line.remainingUnits)} left
          {line.unitsAdjusted > 0 ? (
            <>
              {' · '}
              <span className="purchase-danger">{fmtInt(line.unitsAdjusted)} adj</span>
            </>
          ) : null}
        </div>
      </td>
      <td className="num purchase-cell-primary">
        <div className="purchase-cell-primary-value">
          {fmtUsd(line.realisedCostIfPaidForSoldOnlyDollars)}
        </div>
        <div className="purchase-muted">
          {fmtInt(line.unitsSoldToDate)} × {fmtUsd(line.unitCostDollars ?? 0)}
        </div>
      </td>
      <td className="num purchase-cell-cost">
        <strong>{fmtUsd(line.costOfRemainingItemsDollars)}</strong>
        <div className="purchase-muted">
          {fmtInt(line.remainingUnits)} units on hand
        </div>
      </td>
      <td className="num purchase-cell-cost">
        {line.costOfAdjustedItemsDollars > 0 ? (
          <strong className="purchase-danger">{fmtUsd(line.costOfAdjustedItemsDollars)}</strong>
        ) : (
          <span className="purchase-muted">$0</span>
        )}
        <div className="purchase-muted">
          {line.unitsAdjusted > 0 ? `${fmtInt(line.unitsAdjusted)} units` : 'none'}
        </div>
      </td>
      <td className="num purchase-cell-retail">
        <strong>{fmtUsd(line.soldRevenueDollars)}</strong>
        <div className="purchase-muted">collected from sold units</div>
        <div className="purchase-muted">
          list left {fmtUsd(line.currentListPriceOutstandingDollars)}
          {line.grossMarginPercent !== null ? ` · GM ${line.grossMarginPercent.toFixed(1)}%` : ''}
        </div>
      </td>
      <td>
        <div className="purchase-line-signal">
          <Pill tone={line.packageMatchMethod === 'direct_metrc_tag' ? 'success' : 'warning'}>
            {line.packageMatchMethod === 'direct_metrc_tag' ? 'matched' : 'unmatched'}
          </Pill>
        </div>
      </td>
    </tr>
  )
}

function PurchaseLinesCards(props: {
  lines: CatalogPurchaseLineSellThrough[]
  purchase: CatalogPurchaseDetailResponse['purchase']
}): JSX.Element {
  return (
    <div className="purchase-mobile-only purchase-card-list">
      {props.lines.map((line) => (
        <PurchaseLineCard key={line.lineId} line={line} purchase={props.purchase} />
      ))}
    </div>
  )
}

function PurchaseLineCard(props: {
  line: CatalogPurchaseLineSellThrough
  purchase: CatalogPurchaseDetailResponse['purchase']
}): JSX.Element {
  const { line, purchase } = props
  const itemHref = `${PURCHASES_PATH}/${encodeURIComponent(purchase.poId)}/items/${encodeURIComponent(line.lineId)}?dealerId=${purchase.dealerId}`
  const lineCommitted = (line.unitCostDollars ?? 0) * line.orderedUnits
  return (
    <article className="purchase-card">
      <header className="purchase-card-head">
        <Link to={itemHref} className="purchase-card-distributor" target="_blank" rel="noreferrer">
          {line.productName ?? line.distributorProductName ?? '(unnamed)'}
        </Link>
        <div className="purchase-muted">
          {[line.brandName, line.categoryName, line.subcategoryName, line.sizeLabel]
            .filter((v): v is string => !!v)
            .join(' · ') || '—'}
        </div>
        <Pill tone={line.packageMatchMethod === 'direct_metrc_tag' ? 'success' : 'warning'}>
          {line.packageMatchMethod === 'direct_metrc_tag' ? 'matched' : 'unmatched'}
        </Pill>
      </header>

      <div className="purchase-card-primary purchase-cell-primary">
        <div className="purchase-eyebrow">Sold-through payment basis</div>
        <div className="purchase-cell-primary-value">
          {fmtUsd(line.realisedCostIfPaidForSoldOnlyDollars)}
        </div>
        <div className="purchase-muted">
          {fmtInt(line.unitsSoldToDate)} × {fmtUsd(line.unitCostDollars ?? 0)} ·{' '}
          {line.sellThroughPercent !== null ? pct(line.sellThroughPercent / 100) : '—'} of{' '}
          {fmtInt(line.orderedUnits)} sold
        </div>
      </div>

      <dl className="purchase-card-buckets">
        <div>
          <dt>Unsold stock at cost</dt>
          <dd>{fmtUsd(line.costOfRemainingItemsDollars)}</dd>
        </div>
        <div>
          <dt>Adjusted / shrink</dt>
          <dd>
            {line.costOfAdjustedItemsDollars > 0 ? (
              <span className="purchase-danger">{fmtUsd(line.costOfAdjustedItemsDollars)}</span>
            ) : (
              <span className="purchase-muted">$0</span>
            )}
          </dd>
        </div>
        <div>
          <dt>Committed (line)</dt>
          <dd>{fmtUsd(lineCommitted)}</dd>
        </div>
        <div>
          <dt>Retail collected</dt>
          <dd>{fmtUsd(line.soldRevenueDollars)}</dd>
        </div>
        <div>
          <dt>Retail list left</dt>
          <dd>{fmtUsd(line.currentListPriceOutstandingDollars)}</dd>
        </div>
        <div>
          <dt>Units (sold / left / adj)</dt>
          <dd>
            {fmtInt(line.unitsSoldToDate)} / {fmtInt(line.remainingUnits)} /{' '}
            {fmtInt(line.unitsAdjusted)}
          </dd>
        </div>
      </dl>

      <details className="purchase-line-card-details">
        <summary>Margin / COGS &amp; identifiers</summary>
        <dl className="purchase-meta-dl">
          <dt>Unit cost (PO)</dt>
          <dd>{fmtUsd(line.unitCostDollars ?? 0)}</dd>
          <dt>COGS of sold (margin)</dt>
          <dd>{fmtUsd(line.costOfSoldItemsDollars)}</dd>
          <dt>Gross margin (line)</dt>
          <dd>{line.grossMarginPercent !== null ? `${line.grossMarginPercent.toFixed(1)}%` : '—'}</dd>
          <dt>Packs</dt>
          <dd>{line.packCount ?? '—'}</dd>
          <dt>Metrc tag</dt>
          <dd>{line.metrcTag ?? '—'}</dd>
          <dt>Match method</dt>
          <dd>{line.packageMatchMethod}</dd>
          <dt>Days since received</dt>
          <dd>{line.daysSinceReceived ?? '—'}</dd>
        </dl>
      </details>
    </article>
  )
}

// =================================== ITEM ====================================

export async function purchaseSellThroughItemLoader({
  params,
  request,
}: {
  params: Record<string, string | undefined>
  request: Request
}) {
  const url = new URL(request.url)
  const dealerId = url.searchParams.get('dealerId')
  if (!dealerId) {
    throw new Response('dealerId query parameter required', { status: 400 })
  }
  const poId = params.poId ?? ''
  const lineId = params.lineId ?? ''
  return loadJson(
    `/api/catalog/purchases/${encodeURIComponent(poId)}/items/${encodeURIComponent(lineId)}?dealerId=${encodeURIComponent(dealerId)}`,
    CatalogPurchaseLineDetailResponseSchema,
  )
}

export function PurchaseSellThroughItemPage(): JSX.Element {
  useRegisterCatalogSidebarSubtree()
  const data = useLoaderData() as CatalogPurchaseLineDetailResponse
  const { purchase, line, kpis, embed } = data

  // Build a deep-link to /metrics/catalog pre-set to this SKU's
  // category / subcategory / brand / site, with `?highlight=` set
  // so the SKU's dot shows up across every scatter card. (Metrics is
  // mounted at /metrics/* outside the HeliosModuleCode enum.)
  const analyticsPath = '/metrics/catalog'
  const analyticsParams = new URLSearchParams()
  for (const s of embed.sites) analyticsParams.append('sites', s)
  for (const c of embed.categoryNames) analyticsParams.append('categoryIds', c)
  for (const c of embed.subcategoryNames) analyticsParams.append('subcategoryIds', c)
  for (const b of embed.brandNames) analyticsParams.append('brandIds', b)
  for (const s of embed.sizes) analyticsParams.append('sizes', s)
  if (embed.highlightQuery) analyticsParams.set('highlight', embed.highlightQuery)
  const analyticsUrl = `${analyticsPath}?${analyticsParams.toString()}`

  const poHref = `${PURCHASES_PATH}/${encodeURIComponent(purchase.poId)}?dealerId=${purchase.dealerId}`

  return (
    <div className="page purchase-page">
      <header className="purchase-page-header">
        <p className="purchase-muted">
          <Link to={poHref}>
            ← {purchase.distributorName ?? 'PO'} {purchase.externalOrderId ?? purchase.poId}
          </Link>
        </p>
        <h1>{line.productName ?? line.distributorProductName ?? 'Line item'}</h1>
        <p className="purchase-muted">
          {[line.brandName, line.categoryName, line.subcategoryName, line.sizeLabel]
            .filter((v): v is string => !!v)
            .join(' · ') || '—'}
        </p>
      </header>

      <ItemHero line={line} kpis={kpis} />

      <h2 className="purchase-section-title">Sales detail</h2>
      <div className="purchase-line-card-groups">
        <section className="purchase-line-card-group">
          <h3>Movement</h3>
          <dl>
            <div>
              <dt>Sold 7d</dt>
              <dd>{fmtInt(kpis.unitsSold7d)}</dd>
            </div>
            <div>
              <dt>Sold 30d</dt>
              <dd>{fmtInt(kpis.unitsSold30d)}</dd>
            </div>
            <div>
              <dt>Sold 90d</dt>
              <dd>{fmtInt(kpis.unitsSold90d)}</dd>
            </div>
            <div>
              <dt>Days since received</dt>
              <dd>{line.daysSinceReceived ?? '—'}</dd>
            </div>
          </dl>
        </section>
        <section className="purchase-line-card-group purchase-cell-retail">
          <h3>Retail / margin (90d)</h3>
          <dl>
            <div>
              <dt>Retail revenue (90d)</dt>
              <dd>{fmtUsd(kpis.revenue90dDollars)}</dd>
            </div>
            <div>
              <dt>Avg unit price (90d)</dt>
              <dd>{fmtUsd(kpis.avgUnitPriceDollars90d ?? 0)}</dd>
            </div>
            <div>
              <dt>Current list price</dt>
              <dd>{fmtUsd(kpis.currentListPriceDollars ?? 0)}</dd>
            </div>
            <div>
              <dt>Gross margin (90d)</dt>
              <dd>{kpis.grossMarginPercent90d !== null ? kpis.grossMarginPercent90d.toFixed(1) + '%' : '—'}</dd>
            </div>
          </dl>
        </section>
        <section className="purchase-line-card-group purchase-cell-primary">
          <h3>Vendor payment basis (this PO line)</h3>
          <dl>
            <div>
              <dt>Sold-through payment</dt>
              <dd>
                <strong>{fmtUsd(line.realisedCostIfPaidForSoldOnlyDollars)}</strong>
              </dd>
            </div>
            <div>
              <dt>= units sold × unit cost</dt>
              <dd>
                {fmtInt(line.unitsSoldToDate)} × {fmtUsd(line.unitCostDollars ?? 0)}
              </dd>
            </div>
            <div>
              <dt>Unsold stock at cost</dt>
              <dd>{fmtUsd(line.costOfRemainingItemsDollars)}</dd>
            </div>
            <div>
              <dt>Adjusted / shrink</dt>
              <dd>
                {line.costOfAdjustedItemsDollars > 0 ? (
                  <span className="purchase-danger">{fmtUsd(line.costOfAdjustedItemsDollars)}</span>
                ) : (
                  <span className="purchase-muted">$0</span>
                )}
              </dd>
            </div>
            <div>
              <dt>Committed (line)</dt>
              <dd>{fmtUsd((line.unitCostDollars ?? 0) * line.orderedUnits)}</dd>
            </div>
          </dl>
          <details className="purchase-line-card-details">
            <summary>Margin / COGS detail</summary>
            <dl>
              <div>
                <dt>COGS of sold</dt>
                <dd>{fmtUsd(line.costOfSoldItemsDollars)}</dd>
              </div>
              <div>
                <dt className="purchase-muted">Method</dt>
                <dd className="purchase-muted">
                  Σ qty × wholesale cost-as-of pay_time. Use this for margin math —
                  not as the vendor payment basis.
                </dd>
              </div>
            </dl>
          </details>
        </section>
      </div>

      <section className="purchase-analytics-embed">
        <header>
          <h2>Category comparison — this SKU highlighted</h2>
          <a href={analyticsUrl} target="_blank" rel="noreferrer">
            Open full view ↗
          </a>
        </header>
        <iframe
          title="Catalog analytics for this SKU"
          src={analyticsUrl}
          loading="lazy"
        />
      </section>
    </div>
  )
}

function ItemHero(props: {
  line: CatalogPurchaseLineDetailResponse['line']
  kpis: CatalogPurchaseLineDetailResponse['kpis']
}): JSX.Element {
  const { line, kpis } = props
  const velocity30 = kpis.velocityUnitsPerDay30d
  return (
    <section className="purchase-hero" aria-label="SKU velocity and earnings">
      <div className="purchase-hero-primary">
        <div className="purchase-eyebrow">30-day velocity</div>
        <div className="purchase-answer-value">
          {velocity30 !== null ? `${velocity30.toFixed(2)} u/day` : '—'}
        </div>
        <div className="purchase-muted purchase-hero-primary-sub">
          {fmtInt(kpis.unitsSold30d)} units in 30d · {fmtInt(kpis.unitsSold7d)} in 7d ·{' '}
          {fmtInt(kpis.unitsSold90d)} in 90d
        </div>
      </div>
      <div className="purchase-hero-supporting">
        <HeroMetric
          eyebrow="90-day retail revenue"
          value={fmtUsd(kpis.revenue90dDollars)}
          sub={
            kpis.avgUnitPriceDollars90d !== null
              ? `avg ${fmtUsd(kpis.avgUnitPriceDollars90d)} · GM ${kpis.grossMarginPercent90d?.toFixed(1) ?? '—'}%`
              : null
          }
          tone="retail"
        />
        <HeroMetric
          eyebrow="This PO line"
          value={line.sellThroughPercent !== null ? pct(line.sellThroughPercent / 100) : '—'}
          sub={`${fmtInt(line.unitsSoldToDate)}/${fmtInt(line.orderedUnits)} sold · ${fmtInt(line.remainingUnits)} left${line.unitsAdjusted > 0 ? ` · ${fmtInt(line.unitsAdjusted)} adj` : ''}`}
        />
        <HeroMetric
          eyebrow="On hand now"
          value={kpis.currentQtyOnHand !== null ? fmtInt(kpis.currentQtyOnHand) : '—'}
          sub={`list ${fmtUsd(kpis.currentListPriceDollars ?? 0)}`}
          tone="cost"
        />
      </div>
    </section>
  )
}

// =================================== utils ==================================

function fmtUsd(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—'
  return value.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  })
}

function fmtInt(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—'
  return Math.round(value).toLocaleString('en-US')
}

function pct(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—'
  return `${(value * 100).toFixed(1)}%`
}
