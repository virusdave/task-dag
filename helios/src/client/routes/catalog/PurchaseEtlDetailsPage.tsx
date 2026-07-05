import { Link, useLoaderData } from 'react-router-dom'

import {
  buildHeliosModulePath,
  PendingPurchaseEtlDetailsResponseSchema,
  type PendingPurchaseEtlDetailRow,
  type PendingPurchaseEtlDetailsResponse,
  type PendingPurchaseParsedName,
  type PendingPurchaseThreeWayComparison,
} from '../../../shared/contracts/index.js'
import { loadJson } from '../../app/fetchJson.js'
import { nyLongDateTime } from '../../app/nyTime.js'
import { Pill } from '../../components/Pill.js'
import { useRegisterCatalogSidebarSubtree } from './catalogSidebarSubtree.js'

// Canonical path to the per-packet "Purchase ETL Details" page (C8b, child epic
// FreshlyBakedNYC/automation#54). Shared so the pending-purchases archive /
// review views link here consistently.
export function buildPendingPurchaseEtlDetailsPath(packetId: number): string {
  return buildHeliosModulePath('catalog', `pending-purchases/${packetId}/etl-details`)
}

export async function purchaseEtlDetailsLoader({
  params,
}: {
  params: Record<string, string | undefined>
}) {
  const packetId = params.packetId ?? ''
  return loadJson(
    `/api/catalog/pending-purchases/${encodeURIComponent(packetId)}/etl-details`,
    PendingPurchaseEtlDetailsResponseSchema,
  )
}

// The scalar (string | number | null) target keys on the LLM leg that line up
// with a parsed field. Excludes the array-valued keys (reviewFlags etc.), which
// are surfaced in the LLM panel, not the per-field grid.
type LlmScalarTargetKey =
  | 'targetBrand'
  | 'targetCategory'
  | 'targetSubcategory'
  | 'targetGroupName'
  | 'targetVariantName'
  | 'targetVariantTab'
  | 'targetStrainName'
  | 'targetSize'
  | 'targetPackCount'

// Fields whose parsed value the three legs can be compared on. `llm` is the key
// on the LLM leg's normalized targets; `parsed` is the key on the parsekit /
// legacy `ParsedProductName`. When `llm` is null the LLM classifier has no
// counterpart for that field (e.g. the parser-only `searchTerm`), so its cell
// renders as a muted "n/a" and never counts toward divergence.
const COMPARISON_FIELDS: ReadonlyArray<{
  label: string
  llm: LlmScalarTargetKey | null
  parsed: keyof PendingPurchaseParsedName
}> = [
  { label: 'Brand', llm: 'targetBrand', parsed: 'brand' },
  { label: 'Category', llm: 'targetCategory', parsed: 'category' },
  { label: 'Subcategory', llm: 'targetSubcategory', parsed: 'subcategory' },
  { label: 'Group', llm: 'targetGroupName', parsed: 'groupName' },
  { label: 'Variant', llm: 'targetVariantName', parsed: 'variantName' },
  { label: 'Variant tab', llm: 'targetVariantTab', parsed: 'variantTab' },
  { label: 'Strain', llm: 'targetStrainName', parsed: 'strainName' },
  { label: 'Size', llm: 'targetSize', parsed: 'size' },
  { label: 'Pack count', llm: 'targetPackCount', parsed: 'packCount' },
  { label: 'Prevalence', llm: null, parsed: 'prevalence' },
  { label: 'Search term', llm: null, parsed: 'searchTerm' },
]

export function PurchaseEtlDetailsPage(): JSX.Element {
  useRegisterCatalogSidebarSubtree()
  const data = useLoaderData() as PendingPurchaseEtlDetailsResponse
  const { packet, rows } = data
  const packetReviewHref = buildHeliosModulePath('catalog', `pending-purchases?packetId=${packet.packetId}`)
  const allPacketsHref = buildHeliosModulePath('catalog', 'pending-purchases')

  return (
    <div className="pp-etl-page">
      <div className="pp-breadcrumb inline-row wrap-row">
        <Link className="ghost-button" to={packetReviewHref}>← Back to packet review</Link>
        <Link className="ghost-button" to={allPacketsHref}>All packets</Link>
      </div>

      <header className="pp-etl-header">
        <h1 className="pp-title">Purchase ETL Details</h1>
        <p className="subtle-copy">
          {packet.packetTitle} · Packet #{packet.packetId} · generated {nyLongDateTime(new Date(packet.generatedAt).getTime())}
        </p>
        <div className="inline-row wrap-row" style={{ gap: '0.3rem' }}>
          <Pill tone="muted">{`source: ${packet.source}`}</Pill>
          {packet.siteLabels.map((label) => <Pill key={label} tone="muted">{label}</Pill>)}
          <Pill tone="muted">{`${rows.length} row${rows.length === 1 ? '' : 's'} compared`}</Pill>
        </div>
      </header>

      <details className="pp-admin-details">
        <summary>About this page</summary>
        <div className="pp-admin-body">
          <p className="subtle-copy" style={{ margin: 0 }}>
            Each row shows how the prospective LLM classifier (the path that now
            drives catalog generation) resolved a distributor product name, next
            to what the parsekit parser and the legacy hardcoded heuristics would
            have produced for the same name. parsekit and the legacy rules keep
            running alongside the LLM so we can watch them agree (or diverge) and
            build confidence before retiring them. Cells that disagree across the
            legs are highlighted. This view is read only.
          </p>
          <ul className="subtle-copy" style={{ margin: 0, paddingLeft: '1.1rem' }}>
            <li><strong>LLM</strong>: the reconciled classifier result, snapshotted before any operator link pin.</li>
            <li><strong>parsekit</strong>: the live rules-registry parser being tuned; may report fail / no match / no registry.</li>
            <li><strong>legacy</strong>: the original hardcoded waterfall parser; may error on names it cannot handle.</li>
          </ul>
        </div>
      </details>

      {rows.length === 0 ? (
        <p className="empty-state">This packet has no LLM comparison records.</p>
      ) : (
        <div className="pp-etl-rows stacked-list">
          {rows.map((row) => <EtlRowCard key={row.rowId} row={row} />)}
        </div>
      )}
    </div>
  )
}

function approvalTone(status: PendingPurchaseEtlDetailRow['approvalStatus']): 'danger' | 'muted' | 'success' | 'warning' {
  switch (status) {
    case 'approved':
      return 'success'
    case 'pending':
      return 'warning'
    case 'rejected':
      return 'danger'
  }
}

function EtlRowCard({ row }: { row: PendingPurchaseEtlDetailRow }): JSX.Element {
  return (
    <article className="pp-etl-card">
      <header className="pp-etl-card-header">
        <div className="pp-etl-card-title">
          <strong>{row.distributorProductName}</strong>
          <span className="subtle-copy">Row #{row.rowId}</span>
        </div>
        <div className="inline-row wrap-row" style={{ gap: '0.3rem' }}>
          <Pill tone="muted">{row.siteLabel}</Pill>
          <Pill tone={approvalTone(row.approvalStatus)}>{row.approvalStatus}</Pill>
          <Pill tone="muted">{`resolved: ${row.actionType}`}</Pill>
        </div>
      </header>

      {'status' in row.comparison
        ? <EtlInvalidPanel comparison={row.comparison} />
        : <EtlComparisonBody comparison={row.comparison} resolvedActionType={row.actionType} />}
    </article>
  )
}

function EtlInvalidPanel({ comparison }: { comparison: Extract<PendingPurchaseEtlDetailRow['comparison'], { status: 'invalid' }> }): JSX.Element {
  return (
    <div className="pp-etl-invalid">
      <Pill tone="danger">malformed comparison record</Pill>
      <p className="subtle-copy" style={{ margin: '0.35rem 0 0' }}>
        This row has a comparison blob the page could not read (a pipeline bug).
        {comparison.schemaVersion != null ? ` schemaVersion=${comparison.schemaVersion}.` : ''} {comparison.error}
      </p>
    </div>
  )
}

function EtlComparisonBody({
  comparison,
  resolvedActionType,
}: {
  comparison: PendingPurchaseThreeWayComparison
  resolvedActionType: string
}): JSX.Element {
  const { llm, parsekit, legacy } = comparison
  const pinOverrode = llm.actionType !== resolvedActionType
  const parsekitOk = parsekit.status === 'ok' ? parsekit.output : null
  const legacyOk = legacy.status === 'ok' ? legacy.output : null

  return (
    <>
      <div className="pp-etl-llm">
        <div className="inline-row wrap-row" style={{ gap: '0.3rem', alignItems: 'center' }}>
          <Pill tone="muted">{`LLM confidence ${(llm.confidence * 100).toFixed(0)}%`}</Pill>
          <Pill tone="muted">{`LLM action: ${llm.actionType}`}</Pill>
          {pinOverrode ? (
            <Pill tone="warning" title="The reconciled row action differs from the model's proposal (operator link pin or reconciler override).">
              {`operator pin overrode LLM → ${resolvedActionType}`}
            </Pill>
          ) : null}
          {llm.reuseProductId != null ? (
            <Pill tone="muted">{`proposes reuse #${llm.reuseProductId}${llm.reuseProductName ? ` (${llm.reuseProductName})` : ''}`}</Pill>
          ) : null}
          {llm.reviewFlags.map((flag) => <Pill key={`rf-${flag}`} tone="warning">{flag}</Pill>)}
          {llm.warningFlags.map((flag) => <Pill key={`wf-${flag}`} tone="warning">{flag}</Pill>)}
        </div>
        {llm.rationale ? <p className="subtle-copy pp-etl-rationale">{llm.rationale}</p> : null}
        {llm.citedHintIds.length > 0 ? (
          <p className="subtle-copy" style={{ margin: '0.25rem 0 0' }}>Cited hints: {llm.citedHintIds.join(', ')}</p>
        ) : null}
      </div>

      <div className="pp-etl-grid" role="table" aria-label="Parsed field comparison">
        <div className="pp-etl-grid-row pp-etl-grid-head" role="row">
          <span role="columnheader">Field</span>
          <span role="columnheader">LLM</span>
          <span role="columnheader">parsekit</span>
          <span role="columnheader">legacy</span>
        </div>
        {COMPARISON_FIELDS.map((field) => {
          const llmValue = field.llm === null ? null : formatValue(llm[field.llm])
          const parsekitValue = parsekitOk === null ? null : formatValue(parsekitOk[field.parsed])
          const legacyValue = legacyOk === null ? null : formatValue(legacyOk[field.parsed])
          const diverged = fieldDiverged([
            field.llm === null ? undefined : llm[field.llm],
            parsekitOk === null ? undefined : parsekitOk[field.parsed],
            legacyOk === null ? undefined : legacyOk[field.parsed],
          ])
          return (
            <div className={`pp-etl-grid-row${diverged ? ' pp-etl-grid-row-diff' : ''}`} role="row" key={field.label}>
              <span className="pp-etl-grid-field" role="cell">{field.label}</span>
              <EtlCell leg="LLM" value={llmValue} present={field.llm !== null} />
              <EtlCell leg="parsekit" value={parsekitValue} present={parsekitOk !== null} />
              <EtlCell leg="legacy" value={legacyValue} present={legacyOk !== null} />
            </div>
          )
        })}
      </div>

      <details className="pp-etl-provenance">
        <summary className="subtle-copy">Parser status &amp; provenance</summary>
        <div className="pp-etl-provenance-body subtle-copy">
          <p style={{ margin: 0 }}>
            <strong>parsekit</strong>: {describeParsekit(parsekit)}
          </p>
          <p style={{ margin: '0.2rem 0 0' }}>
            <strong>legacy</strong>: {legacy.status === 'ok' ? 'ok' : `error: ${legacy.error}`}
          </p>
        </div>
      </details>
    </>
  )
}

function EtlCell({ leg, value, present }: { leg: string; value: string | null; present: boolean }): JSX.Element {
  if (!present) {
    return <span className="pp-etl-grid-cell pp-etl-cell-na" role="cell" data-leg={leg} title="This leg has no counterpart for this field">n/a</span>
  }
  if (value === null || value.length === 0) {
    return <span className="pp-etl-grid-cell pp-etl-cell-empty" role="cell" data-leg={leg}>(empty)</span>
  }
  return <span className="pp-etl-grid-cell" role="cell" data-leg={leg}>{value}</span>
}

function formatValue(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'number') return String(value)
  return value
}

// A field diverges when the legs that actually supply it disagree on a
// non-empty, normalized value. Legs that omit the field (undefined) or supply
// null / empty are ignored, so highlighting flags genuine disagreement rather
// than "one leg did not produce this field".
function fieldDiverged(values: ReadonlyArray<string | number | null | undefined>): boolean {
  const normalized = new Set<string>()
  for (const value of values) {
    if (value === null || value === undefined) continue
    const asString = typeof value === 'number' ? String(value) : value.trim().toLowerCase()
    if (asString.length === 0) continue
    normalized.add(asString)
  }
  return normalized.size > 1
}

function describeParsekit(parsekit: PendingPurchaseThreeWayComparison['parsekit']): string {
  switch (parsekit.status) {
    case 'ok':
      return `ok · parser ${parsekit.parserId} · rule ${parsekit.ruleId} · snapshot ${parsekit.snapshotSha}`
    case 'fail':
      return `fail: ${parsekit.reason} · parser ${parsekit.parserId} · snapshot ${parsekit.snapshotSha}`
    case 'no_detect_match':
      return `no detect match · snapshot ${parsekit.snapshotSha}`
    case 'no_registry':
      return 'no registry loaded'
  }
}
