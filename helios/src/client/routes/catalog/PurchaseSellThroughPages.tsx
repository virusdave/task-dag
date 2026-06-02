import { useMemo, useState } from 'react'
import { Form, Link, useLoaderData, useSearchParams } from 'react-router-dom'

import {
  CatalogPurchaseDetailResponseSchema,
  CatalogPurchaseLineDetailResponseSchema,
  CatalogPurchaseListResponseSchema,
  buildHeliosModulePath,
  type CatalogPurchaseDetailResponse,
  type CatalogPurchaseLineDetailResponse,
  type CatalogPurchaseListResponse,
  type CatalogPurchaseListRow,
  type CatalogPurchaseListSort,
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
// The list page is the operator's primary surface. Per the helios
// AGENTS.md reviewer-efficiency rule, the page leads with the answer
// (per-PO cost / cost-of-sold / cost-of-remaining / list-outstanding
// for the filtered set) and tucks methodology into a collapsed
// <details>.
// ---------------------------------------------------------------------------

const PURCHASES_PATH = buildHeliosModulePath('catalog', 'purchases')

// =================================== LIST ====================================

export async function purchaseSellThroughListLoader({ request }: { request: Request }) {
  const url = new URL(request.url)
  return loadJson(`/api/catalog/purchases${url.search}`, CatalogPurchaseListResponseSchema)
}

const SORT_LABELS: Record<CatalogPurchaseListSort, string> = {
  deliveryDate: 'Delivery date',
  paymentDueDate: 'Payment due',
  poTotalDollars: 'PO total',
  distributorName: 'Distributor',
  unitsSold: 'Units sold',
  unitsRemaining: 'Units left',
  unitsAdjusted: 'Units adjusted',
  sellThroughPercent: '% sold',
  realisedCostIfPaidForSoldOnlyDollars: 'Paid-if-sold-only',
  costOfSoldItemsDollars: 'Cost of sold (realised)',
  costOfRemainingItemsDollars: 'Cost in stock',
  costOfAdjustedItemsDollars: 'Cost adjusted',
  currentListPriceOutstandingDollars: 'List in stock',
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

  return (
    <div className="page">
      <div className="page-header" style={{ marginBottom: '0.5rem' }}>
        <h1 style={{ margin: 0 }}>Purchase sell-through</h1>
        <p className="muted" style={{ margin: '0.25rem 0 0' }}>
          Sweed POs joined to sales by Metrc tag. {totalRows} purchases match the current filters.
        </p>
      </div>

      <HeadlineKpiStrip headline={data.headline} />

      <details
        className="mini-card"
        style={{ marginBottom: '0.75rem' }}
      >
        <summary style={{ cursor: 'pointer', fontWeight: 500 }}>Filters</summary>
        <Form method="get" className="filter-row wrap-row" style={{ marginTop: '0.5rem' }}>
          <FilterMultiselect
            name="sites"
            label="Site"
            options={data.facets.sites}
            initial={searchParams.get('sites') ?? ''}
          />
          <FilterMultiselect
            name="distributorNames"
            label="Distributor"
            options={data.facets.distributors}
            initial={searchParams.get('distributorNames') ?? ''}
          />
          <FilterMultiselect
            name="orderStatusNames"
            label="Order status"
            options={data.facets.orderStatuses}
            initial={searchParams.get('orderStatusNames') ?? ''}
          />
          <FilterMultiselect
            name="financialStatusNames"
            label="Financial status"
            options={data.facets.financialStatuses}
            initial={searchParams.get('financialStatusNames') ?? ''}
          />
          <FilterMultiselect
            name="brandNames"
            label="Brand"
            options={data.facets.brands}
            initial={searchParams.get('brandNames') ?? ''}
          />
          <label className="stack-field" style={{ minWidth: '12rem' }}>
            <span>Product search</span>
            <input
              type="search"
              name="productSearch"
              defaultValue={searchParams.get('productSearch') ?? ''}
              placeholder="product / distributor name"
            />
          </label>
          <DateRangeFields
            label="Delivery"
            prefix="delivery"
            initialFrom={searchParams.get('deliveryFrom') ?? ''}
            initialTo={searchParams.get('deliveryTo') ?? ''}
          />
          <DateRangeFields
            label="Payment due"
            prefix="paymentDue"
            initialFrom={searchParams.get('paymentDueFrom') ?? ''}
            initialTo={searchParams.get('paymentDueTo') ?? ''}
          />
          <label className="stack-field" style={{ minWidth: '7rem' }}>
            <span>Total min ($)</span>
            <input type="number" step="0.01" name="totalMin" defaultValue={searchParams.get('totalMin') ?? ''} />
          </label>
          <label className="stack-field" style={{ minWidth: '7rem' }}>
            <span>Total max ($)</span>
            <input type="number" step="0.01" name="totalMax" defaultValue={searchParams.get('totalMax') ?? ''} />
          </label>
          <input type="hidden" name="page" value="1" />
          <input type="hidden" name="sort" value={data.resolved.sort} />
          <input type="hidden" name="dir" value={data.resolved.dir} />
          <input type="hidden" name="pageSize" value={String(pageSize)} />
          <div
            style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-end' }}
          >
            <button type="submit">Apply</button>
            <Link to={PURCHASES_PATH}>Reset</Link>
          </div>
        </Form>
      </details>

      <PurchasesTable
        rows={data.rows}
        sort={data.resolved.sort}
        dir={data.resolved.dir}
        buildHref={buildHref}
      />

      <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', marginTop: '0.75rem' }}>
        <span className="muted">
          Page {page} of {totalPages} · {totalRows} purchases
        </span>
        {hasPrev ? <Link to={buildHref({ page: String(page - 1) })}>← Prev</Link> : null}
        {hasNext ? <Link to={buildHref({ page: String(page + 1) })}>Next →</Link> : null}
      </div>

      <details style={{ marginTop: '1.5rem' }}>
        <summary>How the per-row cost columns are computed</summary>
        <ul style={{ marginTop: '0.5rem' }}>
          <li>
            <strong>PO total</strong> — Sweed's <code>totalPayAmount</code> for the purchase.
          </li>
          <li>
            <strong>Sold / Left / Adj</strong> — units of this PO that have been sold,
            are still on hand in the matched package(s), and are unaccounted for
            (<code>ordered − sold − on-hand</code>, clamped ≥ 0). For matched lines
            these three numbers should add to roughly <em>ordered</em>; any gap is
            the adjustment bucket (shrinkage / breakage / destruction /
            return-to-distributor / samples / Metrc disposal). For unmatched lines
            we report adjustments as 0 because we have no on-hand signal.
          </li>
          <li>
            <strong>Cost sold</strong> — sum over each retail invoice line of
            <code>units × wholesale cost-as-of pay time</code> (falling back to PO unit cost
            when the package snapshot is missing). Closer to true COGS than "PO unit × units sold"
            because mid-PO restocks / cost corrections are honoured.
          </li>
          <li>
            <strong>Cost in stock</strong> — <code>PO unit cost × units still on hand</code>
            for matched packages, or <code>PO unit × (ordered − sold)</code> for unmatched lines.
          </li>
          <li>
            <strong>Cost adjusted</strong> — <code>PO unit cost × units adjusted</code>. The
            dollars paid for product that did not sell and is no longer on hand. Bolded when
            non-zero so write-offs stand out at a glance.
          </li>
          <li>
            <strong>List in stock</strong> — <code>current catalog list price × units still on hand</code>.
            What the remaining stock would ring up if it all sold at today's list price.
          </li>
          <li>
            <strong>Paid-if-sold-only</strong> — <code>PO unit cost × units sold</code>. The
            simpler "if I paid only for what's sold so far, what would I be paying?" framing.
            Cost sold (above) is the same idea using the package's actual cost-as-of pay
            time, which is the better number when distributor costs change mid-PO.
          </li>
          <li>
            Lines are matched to inventory packages via Metrc tag (<code>externalTrackCode</code>);
            the worker ingests this at PO-fetch time so the join is exact.
          </li>
        </ul>
      </details>
    </div>
  )
}

function HeadlineKpiStrip(props: {
  headline: CatalogPurchaseListResponse['headline']
}): JSX.Element {
  const { headline } = props
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
        gap: '0.5rem',
        marginBottom: '0.75rem',
      }}
    >
      <Kpi label="PO total" value={fmtUsd(headline.poTotalDollars)} />
      <Kpi
        label="Cost of sold (realised)"
        value={fmtUsd(headline.costOfSoldItemsDollars)}
        sub={
          headline.poTotalDollars > 0
            ? `${pct(headline.costOfSoldItemsDollars / headline.poTotalDollars)} of PO total`
            : null
        }
      />
      <Kpi
        label="Cost in stock"
        value={fmtUsd(headline.costOfRemainingItemsDollars)}
        sub={
          headline.poTotalDollars > 0
            ? `${pct(headline.costOfRemainingItemsDollars / headline.poTotalDollars)} of PO total`
            : null
        }
      />
      <Kpi
        label="Cost adjusted (non-sold)"
        value={fmtUsd(headline.costOfAdjustedItemsDollars)}
        sub={
          headline.poTotalDollars > 0
            ? `${pct(headline.costOfAdjustedItemsDollars / headline.poTotalDollars)} of PO total`
            : null
        }
      />
      <Kpi label="Sold revenue" value={fmtUsd(headline.soldRevenueDollars)} />
      <Kpi
        label="List in stock"
        value={fmtUsd(headline.currentListPriceOutstandingDollars)}
        sub={
          headline.costOfRemainingItemsDollars > 0
            ? `${(headline.currentListPriceOutstandingDollars / headline.costOfRemainingItemsDollars).toFixed(2)}× cost`
            : null
        }
      />
      <Kpi
        label="Paid-if-sold-only"
        value={fmtUsd(headline.realisedCostIfPaidForSoldOnlyDollars)}
        sub={
          headline.poTotalDollars > 0
            ? `${pct(headline.realisedCostIfPaidForSoldOnlyDollars / headline.poTotalDollars)} of PO total`
            : null
        }
      />
      <Kpi
        label="Units sold / left / adj"
        value={`${fmtInt(headline.unitsSold)} / ${fmtInt(headline.unitsRemaining)} / ${fmtInt(headline.unitsAdjusted)}`}
        sub={
          headline.unitsOrdered > 0
            ? `${pct(headline.unitsSold / headline.unitsOrdered)} of ${fmtInt(headline.unitsOrdered)} ordered`
            : null
        }
      />
      <Kpi label="POs" value={fmtInt(headline.purchaseCount)} sub={`${fmtInt(headline.lineCount)} lines`} />
    </div>
  )
}

function Kpi(props: { label: string; value: string; sub?: string | null }): JSX.Element {
  return (
    <div className="mini-card" style={{ padding: '0.5rem 0.75rem' }}>
      <div className="eyebrow" style={{ fontSize: '0.7rem' }}>
        {props.label}
      </div>
      <div style={{ fontSize: '1.1rem', fontWeight: 600 }}>{props.value}</div>
      {props.sub ? <div className="muted" style={{ fontSize: '0.75rem' }}>{props.sub}</div> : null}
    </div>
  )
}

function FilterMultiselect(props: {
  name: string
  label: string
  options: Array<{ id: string; label: string; count: number }>
  initial: string
}): JSX.Element {
  const initialSet = useMemo(
    () => new Set(props.initial.split(',').map((s) => s.trim()).filter((s) => s.length > 0)),
    [props.initial],
  )
  const [selected, setSelected] = useState<ReadonlySet<string>>(initialSet)
  return (
    <label className="stack-field" style={{ minWidth: '12rem' }}>
      <span>{props.label}</span>
      <select
        multiple
        name={props.name}
        value={[...selected]}
        onChange={(e) => {
          const next = new Set<string>()
          for (const opt of Array.from(e.target.selectedOptions)) next.add(opt.value)
          setSelected(next)
        }}
        size={Math.min(6, Math.max(3, props.options.length))}
        style={{ minHeight: '5rem' }}
      >
        {props.options.map((opt) => (
          <option key={opt.id} value={opt.id}>
            {opt.label} ({opt.count})
          </option>
        ))}
      </select>
      {/* The native multi-select submits one value per <option> selected;
          when the user clears all options the form would omit the param,
          which the server treats as "no filter" — exactly right. */}
    </label>
  )
}

function DateRangeFields(props: {
  label: string
  prefix: 'delivery' | 'paymentDue'
  initialFrom: string
  initialTo: string
}): JSX.Element {
  return (
    <div className="stack-field" style={{ minWidth: '15rem' }}>
      <span>{props.label}</span>
      <div style={{ display: 'flex', gap: '0.25rem' }}>
        <input type="date" name={`${props.prefix}From`} defaultValue={props.initialFrom} />
        <input type="date" name={`${props.prefix}To`} defaultValue={props.initialTo} />
      </div>
    </div>
  )
}

function PurchasesTable(props: {
  rows: CatalogPurchaseListRow[]
  sort: CatalogPurchaseListSort
  dir: 'asc' | 'desc'
  buildHref: (overrides: Record<string, string | null>) => string
}): JSX.Element {
  function sortHeader(col: CatalogPurchaseListSort, label: string): JSX.Element {
    const isActive = props.sort === col
    const nextDir = isActive && props.dir === 'desc' ? 'asc' : 'desc'
    const arrow = isActive ? (props.dir === 'desc' ? ' ↓' : ' ↑') : ''
    return (
      <Link to={props.buildHref({ sort: col, dir: nextDir, page: '1' })}>
        {label}
        {arrow}
      </Link>
    )
  }

  if (props.rows.length === 0) {
    return (
      <p className="muted">
        No purchases match the current filters. (If you expect to see something here, the ingest
        worker may not have caught up yet — check{' '}
        <Link to={buildHeliosModulePath('config', 'workers/scheduling/sweed-purchases-ingest')}>
          Config → Workers → Sweed purchases ingest
        </Link>
        .)
      </p>
    )
  }

  return (
    <div style={{ overflowX: 'auto' }}>
      <table className="data-table" style={{ minWidth: '120ch' }}>
        <thead>
          <tr>
            <th>Site / {sortHeader('deliveryDate', 'Delivery')}</th>
            <th>{sortHeader('distributorName', 'Distributor')} / PO</th>
            <th>{sortHeader('poTotalDollars', 'PO total')}</th>
            <th>
              {sortHeader('unitsSold', 'Sold')} /{' '}
              {sortHeader('unitsRemaining', 'Left')} /{' '}
              {sortHeader('unitsAdjusted', 'Adj')}
            </th>
            <th>{sortHeader('sellThroughPercent', '% sold')}</th>
            <th>{sortHeader('costOfSoldItemsDollars', 'Cost sold')}</th>
            <th>{sortHeader('costOfRemainingItemsDollars', 'Cost in stock')}</th>
            <th>{sortHeader('costOfAdjustedItemsDollars', 'Cost adjusted')}</th>
            <th>{sortHeader('currentListPriceOutstandingDollars', 'List in stock')}</th>
            <th>{sortHeader('realisedCostIfPaidForSoldOnlyDollars', 'Paid-if-sold-only')}</th>
            <th>{sortHeader('paymentDueDate', 'Payment due')}</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {props.rows.map((row) => {
            const href = `${PURCHASES_PATH}/${encodeURIComponent(row.poId)}?dealerId=${row.dealerId}`
            return (
              <tr key={`${row.dealerId}:${row.poId}`}>
                <td>
                  <div style={{ display: 'flex', flexDirection: 'column' }}>
                    <a href={href} target="_blank" rel="noreferrer">
                      {row.deliveryDate ?? '—'}
                    </a>
                    <span className="muted" style={{ fontSize: '0.75rem' }}>
                      {row.siteKey}
                    </span>
                  </div>
                </td>
                <td>
                  <div style={{ display: 'flex', flexDirection: 'column', maxWidth: '24ch' }}>
                    <span>{row.distributorName ?? '—'}</span>
                    <span className="muted" style={{ fontSize: '0.75rem' }}>
                      {row.poName || row.externalOrderId || row.poId}
                    </span>
                    {row.brandNames.length > 0 ? (
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.2rem', marginTop: '0.15rem' }}>
                        {row.brandNames.slice(0, 4).map((b) => (
                          <Pill key={b} tone="muted">{b}</Pill>
                        ))}
                        {row.brandNames.length > 4 ? <span className="muted">+{row.brandNames.length - 4}</span> : null}
                      </div>
                    ) : null}
                  </div>
                </td>
                <td className="num">{fmtUsd(row.poTotalDollars)}</td>
                <td className="num">
                  {fmtInt(row.unitsSold)} / {fmtInt(row.unitsRemaining)} /{' '}
                  {row.unitsAdjusted > 0 ? <strong>{fmtInt(row.unitsAdjusted)}</strong> : fmtInt(row.unitsAdjusted)}
                </td>
                <td className="num">{row.sellThroughPercent !== null ? pct(row.sellThroughPercent / 100) : '—'}</td>
                <td className="num">{fmtUsd(row.costOfSoldItemsDollars)}</td>
                <td className="num">{fmtUsd(row.costOfRemainingItemsDollars)}</td>
                <td className="num">
                  {row.costOfAdjustedItemsDollars > 0 ? (
                    <strong>{fmtUsd(row.costOfAdjustedItemsDollars)}</strong>
                  ) : (
                    fmtUsd(row.costOfAdjustedItemsDollars)
                  )}
                </td>
                <td className="num">{fmtUsd(row.currentListPriceOutstandingDollars)}</td>
                <td className="num">{fmtUsd(row.realisedCostIfPaidForSoldOnlyDollars)}</td>
                <td>{row.paymentDueDate ?? '—'}</td>
                <td>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.1rem' }}>
                    {row.orderStatusName ? <Pill tone="muted">{row.orderStatusName}</Pill> : null}
                    {row.financialStatusName ? <Pill tone="muted">{row.financialStatusName}</Pill> : null}
                    {row.isCashOnDelivery ? <Pill tone="muted">COD</Pill> : null}
                  </div>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
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

  return (
    <div className="page">
      <div className="page-header" style={{ marginBottom: '0.5rem' }}>
        <h1 style={{ margin: 0 }}>
          {purchase.distributorName ?? 'Unknown distributor'} — PO {purchase.externalOrderId ?? purchase.poId}
        </h1>
        <p className="muted" style={{ margin: '0.25rem 0 0' }}>
          {purchase.siteKey} · delivered {purchase.deliveryDate ?? '—'} · due {purchase.paymentDueDate ?? '—'} ·{' '}
          {purchase.orderStatusName ?? '—'} · {purchase.financialStatusName ?? '—'}
          {purchase.isCashOnDelivery ? ' · COD' : ''}
        </p>
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
          gap: '0.5rem',
          marginBottom: '0.75rem',
        }}
      >
        <Kpi label="PO total" value={fmtUsd(summary.poTotalDollars ?? 0)} />
        <Kpi
          label="Cost of sold (realised)"
          value={fmtUsd(summary.costOfSoldItemsDollars)}
          sub={
            summary.poTotalDollars && summary.poTotalDollars > 0
              ? `${pct(summary.costOfSoldItemsDollars / summary.poTotalDollars)} of PO`
              : null
          }
        />
        <Kpi
          label="Cost in stock"
          value={fmtUsd(summary.costOfRemainingItemsDollars)}
          sub={
            summary.poTotalDollars && summary.poTotalDollars > 0
              ? `${pct(summary.costOfRemainingItemsDollars / summary.poTotalDollars)} of PO`
              : null
          }
        />
        <Kpi
          label="Cost adjusted (non-sold)"
          value={fmtUsd(summary.costOfAdjustedItemsDollars)}
          sub={
            summary.poTotalDollars && summary.poTotalDollars > 0
              ? `${pct(summary.costOfAdjustedItemsDollars / summary.poTotalDollars)} of PO`
              : null
          }
        />
        <Kpi label="Sold revenue" value={fmtUsd(summary.soldRevenueDollars)} />
        <Kpi label="List in stock" value={fmtUsd(summary.currentListPriceOutstandingDollars)} />
        <Kpi
          label="Paid-if-sold-only"
          value={fmtUsd(summary.realisedCostIfPaidForSoldOnlyDollars)}
          sub={
            summary.poTotalDollars && summary.poTotalDollars > 0
              ? `${pct(summary.realisedCostIfPaidForSoldOnlyDollars / summary.poTotalDollars)} of PO`
              : null
          }
        />
        <Kpi
          label="Units sold / left / adj"
          value={`${fmtInt(summary.unitsSold)} / ${fmtInt(summary.unitsRemaining)} / ${fmtInt(summary.unitsAdjusted)}`}
          sub={summary.unitsOrdered > 0 ? `${pct(summary.unitsSold / summary.unitsOrdered)} of ${fmtInt(summary.unitsOrdered)} ordered` : null}
        />
        <Kpi
          label="Lines / matched"
          value={`${summary.totalLineCount} / ${summary.matchedLineCount}`}
          sub={matchedFraction !== null ? `${pct(matchedFraction)} package-matched` : null}
        />
      </div>

      <div style={{ overflowX: 'auto' }}>
        <table className="data-table" style={{ minWidth: '120ch' }}>
          <thead>
            <tr>
              <th>#</th>
              <th>Product / brand / size</th>
              <th>Ordered</th>
              <th>Sold</th>
              <th>Left</th>
              <th>Adj</th>
              <th>% sold</th>
              <th>Days since recv'd</th>
              <th>Unit cost</th>
              <th>Sold revenue</th>
              <th>Cost sold</th>
              <th>Cost in stock</th>
              <th>Cost adjusted</th>
              <th>List in stock</th>
              <th>GM%</th>
              <th>Match</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((line) => {
              const itemHref = `${PURCHASES_PATH}/${encodeURIComponent(purchase.poId)}/items/${encodeURIComponent(line.lineId)}?dealerId=${purchase.dealerId}`
              return (
                <tr key={line.lineId}>
                  <td>{line.lineIndex + 1}</td>
                  <td>
                    <div style={{ display: 'flex', flexDirection: 'column', maxWidth: '32ch' }}>
                      <a href={itemHref} target="_blank" rel="noreferrer">
                        {line.productName ?? line.distributorProductName ?? '(unnamed)'}
                      </a>
                      <span className="muted" style={{ fontSize: '0.75rem' }}>
                        {[line.brandName, line.categoryName, line.subcategoryName, line.sizeLabel]
                          .filter((v): v is string => !!v)
                          .join(' · ')}
                      </span>
                    </div>
                  </td>
                  <td className="num">{fmtInt(line.orderedUnits)}</td>
                  <td className="num">{fmtInt(line.unitsSoldToDate)}</td>
                  <td className="num">{fmtInt(line.remainingUnits)}</td>
                  <td className="num">
                    {line.unitsAdjusted > 0 ? <strong>{fmtInt(line.unitsAdjusted)}</strong> : fmtInt(line.unitsAdjusted)}
                  </td>
                  <td className="num">
                    {line.sellThroughPercent !== null ? pct(line.sellThroughPercent / 100) : '—'}
                  </td>
                  <td className="num">{line.daysSinceReceived !== null ? line.daysSinceReceived : '—'}</td>
                  <td className="num">{fmtUsd(line.unitCostDollars ?? 0)}</td>
                  <td className="num">{fmtUsd(line.soldRevenueDollars)}</td>
                  <td className="num">{fmtUsd(line.costOfSoldItemsDollars)}</td>
                  <td className="num">{fmtUsd(line.costOfRemainingItemsDollars)}</td>
                  <td className="num">
                    {line.costOfAdjustedItemsDollars > 0 ? (
                      <strong>{fmtUsd(line.costOfAdjustedItemsDollars)}</strong>
                    ) : (
                      fmtUsd(line.costOfAdjustedItemsDollars)
                    )}
                  </td>
                  <td className="num">{fmtUsd(line.currentListPriceOutstandingDollars)}</td>
                  <td className="num">{line.grossMarginPercent !== null ? line.grossMarginPercent.toFixed(1) + '%' : '—'}</td>
                  <td>
                    <Pill tone={line.packageMatchMethod === 'direct_metrc_tag' ? 'success' : 'warning'}>
                      {line.packageMatchMethod === 'direct_metrc_tag' ? 'matched' : 'unmatched'}
                    </Pill>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      <details style={{ marginTop: '1rem' }}>
        <summary>About this page</summary>
        <ul style={{ marginTop: '0.5rem' }}>
          <li>
            Each line's <strong>units sold</strong> aggregates over every
            <code> sweed_orders.raw_json.items[]</code> entry whose
            <code>inventoryItemId</code> appears in the line's matched-package
            set (joined at ingest via Metrc <code>externalTrackCode</code>).
          </li>
          <li>
            <strong>Cost of sold (realised)</strong> uses the package's
            wholesale cost as of the moment each sale rang up, so mid-PO
            restocks / cost edits are honoured. Falls back to the PO unit
            cost when the snapshot is missing.
          </li>
          <li>
            <strong>Remaining units</strong> for a matched line is the
            current on-hand qty across all matched packages. For an
            unmatched line it's <code>ordered − sold</code> (best effort).
          </li>
          <li>
            <strong>Adjusted units</strong> is <code>ordered − sold − on-hand</code>
            (clamped ≥ 0). This is the bucket that catches inventory adjustments
            that reduced the package's stock without showing up as a retail sale
            — shrinkage, breakage, destruction, returns to distributor, samples,
            Metrc disposals, and any other Sweed inventory adjustment. Bolded
            on the line table when non-zero. Reported as 0 for unmatched lines.
          </li>
          <li>
            Click any line's product name to open a per-item detail page in
            a new tab with sales KPIs and the catalog scatter view
            pre-filtered to this SKU's category.
          </li>
        </ul>
      </details>
    </div>
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
    <div className="page">
      <div className="page-header" style={{ marginBottom: '0.5rem' }}>
        <h1 style={{ margin: 0 }}>{line.productName ?? line.distributorProductName ?? 'Line item'}</h1>
        <p className="muted" style={{ margin: '0.25rem 0 0' }}>
          <Link to={poHref}>
            ← {purchase.distributorName ?? 'PO'} {purchase.externalOrderId ?? purchase.poId}
          </Link>{' '}
          · {[line.brandName, line.categoryName, line.subcategoryName, line.sizeLabel]
            .filter((v): v is string => !!v)
            .join(' · ') || '—'}
        </p>
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
          gap: '0.5rem',
          marginBottom: '0.75rem',
        }}
      >
        <Kpi label="Ordered" value={fmtInt(line.orderedUnits)} />
        <Kpi label="Sold" value={fmtInt(line.unitsSoldToDate)} />
        <Kpi label="Left" value={fmtInt(line.remainingUnits)} />
        <Kpi
          label="Adjusted (non-sold)"
          value={fmtInt(line.unitsAdjusted)}
          sub={
            line.orderedUnits > 0 && line.unitsAdjusted > 0
              ? `${pct(line.unitsAdjusted / line.orderedUnits)} of ordered`
              : null
          }
        />
        <Kpi label="% sold" value={line.sellThroughPercent !== null ? pct(line.sellThroughPercent / 100) : '—'} />
        <Kpi label="Days since recv'd" value={line.daysSinceReceived !== null ? String(line.daysSinceReceived) : '—'} />
        <Kpi label="Velocity (units/day, 30d)" value={kpis.velocityUnitsPerDay30d !== null ? kpis.velocityUnitsPerDay30d.toFixed(2) : '—'} />
        <Kpi label="Revenue (90d)" value={fmtUsd(kpis.revenue90dDollars)} />
        <Kpi label="Avg unit price (90d)" value={fmtUsd(kpis.avgUnitPriceDollars90d ?? 0)} />
        <Kpi label="GM% (90d)" value={kpis.grossMarginPercent90d !== null ? kpis.grossMarginPercent90d.toFixed(1) + '%' : '—'} />
        <Kpi label="Unit cost" value={fmtUsd(line.unitCostDollars ?? 0)} />
        <Kpi label="Current list" value={fmtUsd(kpis.currentListPriceDollars ?? 0)} />
        <Kpi label="On hand" value={kpis.currentQtyOnHand !== null ? fmtInt(kpis.currentQtyOnHand) : '—'} />
        <Kpi label="Cost sold (PO lifetime)" value={fmtUsd(line.costOfSoldItemsDollars)} />
        <Kpi label="Cost in stock" value={fmtUsd(line.costOfRemainingItemsDollars)} />
        <Kpi label="Cost adjusted" value={fmtUsd(line.costOfAdjustedItemsDollars)} />
        <Kpi label="Sold revenue (PO lifetime)" value={fmtUsd(line.soldRevenueDollars)} />
      </div>

      <div className="mini-card" style={{ marginBottom: '0.75rem', padding: '0.5rem 0.75rem' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
          <strong>Catalog analytics — same category as this SKU</strong>
          <a href={analyticsUrl} target="_blank" rel="noreferrer">
            Open full view in new tab ↗
          </a>
        </div>
        <p className="muted" style={{ margin: '0.25rem 0 0', fontSize: '0.85rem' }}>
          Pre-filtered to{' '}
          {[
            embed.sites.length > 0 ? `sites: ${embed.sites.join(', ')}` : null,
            embed.categoryNames.length > 0 ? `category: ${embed.categoryNames.join(', ')}` : null,
            embed.subcategoryNames.length > 0 ? `subcategory: ${embed.subcategoryNames.join(', ')}` : null,
            embed.brandNames.length > 0 ? `brand: ${embed.brandNames.join(', ')}` : null,
          ]
            .filter((v): v is string => !!v)
            .join(' · ') || 'this SKU\'s cohort'}
          ; this SKU is highlighted via free-text query "{embed.highlightQuery}".
        </p>
      </div>

      <iframe
        title="Catalog analytics for this SKU"
        src={analyticsUrl}
        style={{
          width: '100%',
          height: '80vh',
          border: '1px solid var(--border-color, #ccc)',
          borderRadius: '6px',
        }}
      />
    </div>
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
