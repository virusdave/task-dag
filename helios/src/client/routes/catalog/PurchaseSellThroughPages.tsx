import { useMemo, useState } from 'react'
import { Form, Link, useLoaderData, useSearchParams } from 'react-router-dom'

import {
  CatalogPurchaseDetailResponseSchema,
  CatalogPurchaseLineDetailResponseSchema,
  CatalogPurchaseListResponseSchema,
  buildHeliosModulePath,
  type CatalogPurchaseDetailResponse,
  type CatalogPurchaseLineDetailResponse,
  type CatalogPurchaseLineSellThrough,
  type CatalogPurchaseListResponse,
  type CatalogPurchaseListRow,
  type CatalogPurchaseListSort,
  type CatalogPurchaseSellThroughSummary,
} from '../../../shared/contracts/index.js'
import { loadJson } from '../../app/fetchJson.js'
import { Pill } from '../../components/Pill.js'
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
  return loadJson(`/api/catalog/purchases${url.search}`, CatalogPurchaseListResponseSchema)
}

const SORT_LABELS: Record<CatalogPurchaseListSort, string> = {
  deliveryDate: 'Delivered',
  paymentDueDate: 'Payment due',
  poTotalDollars: 'PO cost',
  distributorName: 'Distributor',
  unitsSold: 'Units sold',
  unitsRemaining: 'Units left',
  unitsAdjusted: 'Units vanished',
  sellThroughPercent: '% sold',
  realisedCostIfPaidForSoldOnlyDollars: 'Cost × sold (PO unit)',
  costOfSoldItemsDollars: 'Wholesale cost of sold',
  costOfRemainingItemsDollars: 'Inventory cost left',
  costOfAdjustedItemsDollars: 'Shrink / adjusted cost',
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

function samplesAreIncluded(searchParams: URLSearchParams): boolean {
  const v = (searchParams.get('includeSamples') ?? '').trim().toLowerCase()
  return v === '1' || v === 'true' || v === 'on' || v === 'yes'
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
        <strong>Inventory cost left</strong> = PO unit cost × units still on hand in the
        package(s) we matched to this line by Metrc tag.
      </li>
      <li>
        <strong>Shrink / adjusted cost</strong> = PO unit cost × units that disappeared
        from the package without showing up as a retail sale (breakage, destruction,
        return-to-distributor, samples, Metrc disposals). Clamped ≥ 0.
      </li>
      <li>
        <strong>Wholesale cost of sold units</strong> sums each retail invoice line as
        <code>qty × wholesale cost-as-of the moment it rang up</code>, falling back to
        PO unit cost when the snapshot is missing. This is closer to true COGS than
        "PO unit × units sold" when distributor costs change mid-PO.
      </li>
      <li>
        <strong>Retail revenue from sold units</strong> is gross of discount — what
        the register collected for those units.
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
  const stillExposed = h.costOfRemainingItemsDollars + h.costOfAdjustedItemsDollars
  const sellThroughPct = h.unitsOrdered > 0 ? h.unitsSold / h.unitsOrdered : null

  return (
    <section className="purchase-hero" aria-label="Cash exposure across filtered purchases">
      <div className="purchase-hero-primary">
        <div className="purchase-eyebrow">Still exposed at purchase cost</div>
        <div className="purchase-answer-value">{fmtUsd(stillExposed)}</div>
        <div className="purchase-muted purchase-hero-primary-sub">
          {fmtUsd(h.costOfRemainingItemsDollars)} in stock
          {h.costOfAdjustedItemsDollars > 0 ? (
            <>
              {' · '}
              <span className="purchase-danger">{fmtUsd(h.costOfAdjustedItemsDollars)} vanished</span>
            </>
          ) : null}
          {' · '}
          {fmtInt(h.unitsRemaining)} units left
          {h.unitsAdjusted > 0 ? ` · ${fmtInt(h.unitsAdjusted)} adjusted` : ''}
        </div>
      </div>
      <div className="purchase-hero-supporting">
        <HeroMetric
          eyebrow="Committed PO cost"
          value={fmtUsd(h.poTotalDollars)}
          sub={`across ${fmtInt(h.purchaseCount)} POs`}
          tone="cost"
        />
        <HeroMetric
          eyebrow="Retail revenue from sold units"
          value={fmtUsd(h.soldRevenueDollars)}
          sub={
            sellThroughPct !== null
              ? `${fmtInt(h.unitsSold)}/${fmtInt(h.unitsOrdered)} units · ${pct(sellThroughPct)} sold`
              : `${fmtInt(h.unitsSold)} units`
          }
          tone="retail"
        />
        <HeroMetric
          eyebrow="Inventory cost left"
          value={fmtUsd(h.costOfRemainingItemsDollars)}
          sub={`Retail list left ${fmtUsd(h.currentListPriceOutstandingDollars)}`}
          tone="cost"
        />
        <HeroMetric
          eyebrow="Shrink / adjusted cost"
          value={fmtUsd(h.costOfAdjustedItemsDollars)}
          sub={h.unitsAdjusted > 0 ? `${fmtInt(h.unitsAdjusted)} adjusted units` : 'none flagged'}
          tone={h.costOfAdjustedItemsDollars > 0 ? 'danger' : 'cost'}
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
          placeholder="Search product, distributor, brand…"
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
              <th>Purchase</th>
              <th className="num">{sortHeader('poTotalDollars', 'Committed')}</th>
              <th className="num">{sortHeader('costOfSoldItemsDollars', 'Retail recovered')}</th>
              <th className="num">{sortHeader('costOfRemainingItemsDollars', 'Still in stock')}</th>
              <th className="num">{sortHeader('costOfAdjustedItemsDollars', 'Vanished')}</th>
              <th className="num">{sortHeader('sellThroughPercent', 'Flow')}</th>
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
  return (
    <tr>
      <td>
        <div className="purchase-row-purchase">
          <Link to={href} className="purchase-row-distributor">
            {row.distributorName ?? '—'}
          </Link>
          <div className="purchase-muted">
            {row.siteKey} · delivered {row.deliveryDate ?? '—'}
            {row.paymentDueDate ? ` · due ${row.paymentDueDate}` : ''}
          </div>
          <div className="purchase-muted purchase-row-poid">
            {row.poName || row.externalOrderId || row.poId} · {row.lineCount} lines
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
        </div>
      </td>
      <td className="num purchase-cell-cost">
        <strong>{fmtUsd(row.poTotalDollars)}</strong>
      </td>
      <td className="num purchase-cell-retail">
        <strong>{fmtUsd(row.soldRevenueDollars)}</strong>
        <div className="purchase-muted">
          {row.sellThroughPercent !== null ? pct(row.sellThroughPercent / 100) : '—'} sold
        </div>
      </td>
      <td className="num purchase-cell-cost">
        <strong>{fmtUsd(row.costOfRemainingItemsDollars)}</strong>
        <div className="purchase-muted">
          retail list {fmtUsd(row.currentListPriceOutstandingDollars)}
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
        <div>{fmtInt(row.unitsSold)} / {fmtInt(row.unitsOrdered)}</div>
        <div className="purchase-muted">{fmtInt(row.unitsRemaining)} left</div>
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
  const stillExposed = row.costOfRemainingItemsDollars + row.costOfAdjustedItemsDollars
  return (
    <article className="purchase-card">
      <header className="purchase-card-head">
        <Link to={href} className="purchase-card-distributor">
          {row.distributorName ?? '—'}
        </Link>
        <div className="purchase-muted">
          {row.siteKey} · delivered {row.deliveryDate ?? '—'}
          {row.paymentDueDate ? ` · due ${row.paymentDueDate}` : ''}
        </div>
        <div className="purchase-muted">
          {row.poName || row.externalOrderId || row.poId} · {row.lineCount} lines
        </div>
      </header>
      <div className="purchase-card-headline">
        <div className="purchase-card-headline-cell">
          <div className="purchase-eyebrow">Still exposed at cost</div>
          <div className="purchase-metric-value">{fmtUsd(stillExposed)}</div>
        </div>
        <div className="purchase-card-headline-cell">
          <div className="purchase-eyebrow">Retail recovered</div>
          <div className="purchase-metric-value purchase-metric-retail">
            {fmtUsd(row.soldRevenueDollars)}
          </div>
        </div>
      </div>
      <dl className="purchase-card-buckets">
        <div>
          <dt>Committed PO cost</dt>
          <dd>{fmtUsd(row.poTotalDollars)}</dd>
        </div>
        <div>
          <dt>Inventory cost left</dt>
          <dd>{fmtUsd(row.costOfRemainingItemsDollars)}</dd>
        </div>
        <div>
          <dt>Shrink / adjusted</dt>
          <dd>
            {row.costOfAdjustedItemsDollars > 0 ? (
              <span className="purchase-danger">{fmtUsd(row.costOfAdjustedItemsDollars)}</span>
            ) : (
              <span className="purchase-muted">$0</span>
            )}
          </dd>
        </div>
        <div>
          <dt>Retail list left</dt>
          <dd>{fmtUsd(row.currentListPriceOutstandingDollars)}</dd>
        </div>
      </dl>
      <footer className="purchase-card-foot">
        <span className="purchase-muted">
          {fmtInt(row.unitsSold)} / {fmtInt(row.unitsOrdered)} sold · {fmtInt(row.unitsRemaining)} left
          {row.unitsAdjusted > 0 ? ` · ${fmtInt(row.unitsAdjusted)} adjusted` : ''}
        </span>
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
  return (
    <section className="purchase-hero" aria-label="PO sell-through verdict">
      <div className={`purchase-hero-primary purchase-verdict-${verdict.kind}`}>
        <div className="purchase-eyebrow">Verdict</div>
        <div className="purchase-answer-value">{verdict.label}</div>
        <div className="purchase-muted purchase-hero-primary-sub">{verdict.detail}</div>
      </div>
      <div className="purchase-hero-supporting">
        <HeroMetric
          eyebrow="Retail revenue from sold units"
          value={fmtUsd(summary.soldRevenueDollars)}
          sub={`${fmtInt(summary.unitsSold)}/${fmtInt(summary.unitsOrdered)} units sold`}
          tone="retail"
        />
        <HeroMetric
          eyebrow="Inventory cost left"
          value={fmtUsd(summary.costOfRemainingItemsDollars)}
          sub={`Retail list left ${fmtUsd(summary.currentListPriceOutstandingDollars)}`}
          tone="cost"
        />
        <HeroMetric
          eyebrow="Shrink / adjusted cost"
          value={fmtUsd(summary.costOfAdjustedItemsDollars)}
          sub={summary.unitsAdjusted > 0 ? `${fmtInt(summary.unitsAdjusted)} adjusted units` : 'none flagged'}
          tone={summary.costOfAdjustedItemsDollars > 0 ? 'danger' : 'cost'}
        />
        <HeroMetric
          eyebrow="Committed PO cost"
          value={fmtUsd(summary.poTotalDollars ?? 0)}
          sub={
            matchedFraction !== null
              ? `${summary.matchedLineCount}/${summary.totalLineCount} lines matched`
              : null
          }
          tone="cost"
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
            <th className="num">Movement</th>
            <th className="num purchase-cell-retail">Retail dollars</th>
            <th className="num purchase-cell-cost">Purchase-cost dollars</th>
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
  return (
    <tr>
      <td>
        <div className="purchase-line-item">
          <Link to={itemHref} className="purchase-line-product">
            {line.productName ?? line.distributorProductName ?? '(unnamed)'}
          </Link>
          <div className="purchase-muted">
            {[line.brandName, line.categoryName, line.subcategoryName, line.sizeLabel]
              .filter((v): v is string => !!v)
              .join(' · ')}
          </div>
        </div>
      </td>
      <td className="num">
        <div className="purchase-line-movement-value">
          {line.sellThroughPercent !== null ? pct(line.sellThroughPercent / 100) : '—'}
        </div>
        <div className="purchase-muted">
          {fmtInt(line.unitsSoldToDate)}/{fmtInt(line.orderedUnits)} sold ·{' '}
          {fmtInt(line.remainingUnits)} left
          {line.unitsAdjusted > 0 ? (
            <>
              {' '}·{' '}
              <span className="purchase-danger">{fmtInt(line.unitsAdjusted)} adj</span>
            </>
          ) : null}
        </div>
      </td>
      <td className="num purchase-cell-retail">
        <strong>{fmtUsd(line.soldRevenueDollars)}</strong>
        <div className="purchase-muted">retail revenue from sold units</div>
        <div className="purchase-muted">
          list left {fmtUsd(line.currentListPriceOutstandingDollars)}
          {line.grossMarginPercent !== null ? ` · GM ${line.grossMarginPercent.toFixed(1)}%` : ''}
        </div>
      </td>
      <td className="num purchase-cell-cost">
        <strong>{fmtUsd(line.costOfRemainingItemsDollars)}</strong>
        <div className="purchase-muted">inventory cost left</div>
        {line.costOfAdjustedItemsDollars > 0 ? (
          <div className="purchase-danger">
            shrink {fmtUsd(line.costOfAdjustedItemsDollars)}
          </div>
        ) : null}
        <div className="purchase-muted">
          wholesale cost of sold {fmtUsd(line.costOfSoldItemsDollars)}
        </div>
        <div className="purchase-muted">unit cost {fmtUsd(line.unitCostDollars ?? 0)}</div>
      </td>
      <td>
        <div className="purchase-line-signal">
          <Pill tone={line.packageMatchMethod === 'direct_metrc_tag' ? 'success' : 'warning'}>
            {line.packageMatchMethod === 'direct_metrc_tag' ? 'matched' : 'unmatched'}
          </Pill>
          {line.daysSinceReceived !== null ? (
            <span className="purchase-muted">{line.daysSinceReceived}d since recv'd</span>
          ) : null}
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
  return (
    <article className="purchase-card">
      <header className="purchase-card-head">
        <Link to={itemHref} className="purchase-card-distributor">
          {line.productName ?? line.distributorProductName ?? '(unnamed)'}
        </Link>
        <div className="purchase-muted">
          {[line.brandName, line.categoryName, line.subcategoryName, line.sizeLabel]
            .filter((v): v is string => !!v)
            .join(' · ')}
        </div>
        <Pill tone={line.packageMatchMethod === 'direct_metrc_tag' ? 'success' : 'warning'}>
          {line.packageMatchMethod === 'direct_metrc_tag' ? 'matched' : 'unmatched'}
        </Pill>
      </header>
      <div className="purchase-card-headline">
        <div className="purchase-card-headline-cell">
          <div className="purchase-eyebrow">% sold</div>
          <div className="purchase-metric-value">
            {line.sellThroughPercent !== null ? pct(line.sellThroughPercent / 100) : '—'}
          </div>
          <div className="purchase-muted">
            {fmtInt(line.unitsSoldToDate)}/{fmtInt(line.orderedUnits)} sold · {fmtInt(line.remainingUnits)} left
          </div>
        </div>
      </div>
      <div className="purchase-line-card-groups">
        <section className="purchase-line-card-group purchase-cell-retail">
          <h3>Retail dollars</h3>
          <dl>
            <div>
              <dt>Retail revenue (sold)</dt>
              <dd>{fmtUsd(line.soldRevenueDollars)}</dd>
            </div>
            <div>
              <dt>Retail list value left</dt>
              <dd>{fmtUsd(line.currentListPriceOutstandingDollars)}</dd>
            </div>
            {line.grossMarginPercent !== null ? (
              <div>
                <dt>Gross margin</dt>
                <dd>{line.grossMarginPercent.toFixed(1)}%</dd>
              </div>
            ) : null}
          </dl>
        </section>
        <section className="purchase-line-card-group purchase-cell-cost">
          <h3>Purchase-cost dollars</h3>
          <dl>
            <div>
              <dt>Inventory cost left</dt>
              <dd>{fmtUsd(line.costOfRemainingItemsDollars)}</dd>
            </div>
            <div>
              <dt>Shrink / adjusted cost</dt>
              <dd>
                {line.costOfAdjustedItemsDollars > 0 ? (
                  <span className="purchase-danger">{fmtUsd(line.costOfAdjustedItemsDollars)}</span>
                ) : (
                  <span className="purchase-muted">$0</span>
                )}
              </dd>
            </div>
            <div>
              <dt>Wholesale cost of sold units</dt>
              <dd>{fmtUsd(line.costOfSoldItemsDollars)}</dd>
            </div>
            <div>
              <dt>Unit cost</dt>
              <dd>{fmtUsd(line.unitCostDollars ?? 0)}</dd>
            </div>
          </dl>
        </section>
      </div>
      <details className="purchase-line-card-details">
        <summary>Details</summary>
        <dl className="purchase-meta-dl">
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
        <section className="purchase-line-card-group purchase-cell-cost">
          <h3>Purchase-cost dollars (this PO)</h3>
          <dl>
            <div>
              <dt>Unit cost</dt>
              <dd>{fmtUsd(line.unitCostDollars ?? 0)}</dd>
            </div>
            <div>
              <dt>Wholesale cost of sold</dt>
              <dd>{fmtUsd(line.costOfSoldItemsDollars)}</dd>
            </div>
            <div>
              <dt>Inventory cost left</dt>
              <dd>{fmtUsd(line.costOfRemainingItemsDollars)}</dd>
            </div>
            <div>
              <dt>Shrink / adjusted cost</dt>
              <dd>
                {line.costOfAdjustedItemsDollars > 0 ? (
                  <span className="purchase-danger">{fmtUsd(line.costOfAdjustedItemsDollars)}</span>
                ) : (
                  <span className="purchase-muted">$0</span>
                )}
              </dd>
            </div>
          </dl>
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
