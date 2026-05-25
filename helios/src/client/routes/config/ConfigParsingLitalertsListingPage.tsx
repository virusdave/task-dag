/**
 * Per-listing detail / dry-run page for /config/parsing/litalerts.
 *
 * Opened in a new tab when the operator clicks the background of a
 * sample row on the main /config/parsing/litalerts page. Shows the
 * full LitAlerts evidence object, how the *current* parser config
 * parsed this listing, and lets the operator paste a *pending*
 * JSONC config to see how the same listing *would* parse without
 * having to commit/push first.
 *
 * The "pending" textarea is auto-seeded from sessionStorage key
 * `litalerts-draft-<tenantId>`, which the main page writes whenever
 * the operator types into the editor or accepts an LLM suggestion.
 * This means the operator can preview their in-flight edit on a
 * real row in one click.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useLoaderData, useParams } from 'react-router-dom'
import { z } from 'zod'

import { loadJson, mutateJson } from '../../app/fetchJson.js'
import { Pill } from '../../components/Pill.js'

interface ParsedFuzzy {
  brandNorm: string | null
  categoryNorm: string | null
  subcategoryNorm: string | null
  sizeGNorm: number | null
  sizeMgNorm: number | null
  packCountNorm: number | null
  strainNorm: string | null
}

interface ListingDetail {
  observationId: number
  observedAt: string
  searchTerm: string | null
  fuzzyHash: string
  raw: {
    url: string | null
    listingName: string | null
    category: string | null
    brand: string | null
    dispensaryName: string | null
    subcategory: string | null
  }
  rawFull: Record<string, unknown>
  parsed: ParsedFuzzy
  parserSource: 'parsekit' | 'placeholder'
  parserId: string | null
  snapshotSha: string | null
  placeholderReason?: 'no_registry' | 'no_tenant_config' | 'parse_failed'
  placeholderDetail?: string
}

interface ListingDetailResponse {
  competitorName: string
  tenantId: string
  listing: ListingDetail
}

interface DryRunResponse {
  ok: true
  attempt: {
    parsed: ParsedFuzzy | null
    parserId: string | null
    snapshotSha: string | null
    reason: 'no_registry' | 'no_tenant_config' | 'parse_failed' | null
    failureDetail?: string
  }
}

const ListingDetailSchema = z.any() as z.ZodType<ListingDetailResponse>
const DryRunSchema = z.any() as z.ZodType<DryRunResponse>

export async function configParsingLitalertsListingLoader({
  params,
}: {
  params: { competitor?: string; fuzzyHash?: string }
}): Promise<ListingDetailResponse> {
  const competitor = params.competitor ?? ''
  const fuzzyHash = params.fuzzyHash ?? ''
  return loadJson(
    `/api/config/parsing/litalerts/${encodeURIComponent(competitor)}/listing/${encodeURIComponent(fuzzyHash)}`,
    ListingDetailSchema,
  )
}

export function ConfigParsingLitalertsListingPage(): JSX.Element {
  const data = useLoaderData() as ListingDetailResponse
  const params = useParams()
  const competitorParam = params.competitor ?? data.competitorName
  const fuzzyHashParam = params.fuzzyHash ?? data.listing.fuzzyHash

  const draftKey = `litalerts-draft-${data.tenantId}`
  const [draftJsonc, setDraftJsonc] = useState<string>('')
  const [dryRunLoading, setDryRunLoading] = useState(false)
  const [dryRunError, setDryRunError] = useState<string | null>(null)
  const [dryRun, setDryRun] = useState<DryRunResponse['attempt'] | null>(null)

  // Seed pending-config textarea from sessionStorage (main page writes
  // here as the operator edits / accepts LLM suggestions).
  useEffect(() => {
    try {
      const seed = window.sessionStorage.getItem(draftKey)
      if (seed && seed.trim().length > 0) setDraftJsonc(seed)
    } catch {
      /* sessionStorage may be unavailable in some embedded contexts */
    }
  }, [draftKey])

  const runDryRun = useCallback(async () => {
    if (!draftJsonc.trim()) return
    setDryRunLoading(true)
    setDryRunError(null)
    setDryRun(null)
    try {
      const result = await mutateJson(
        `/api/config/parsing/litalerts/${encodeURIComponent(competitorParam)}/listing/${encodeURIComponent(fuzzyHashParam)}/dry-run`,
        DryRunSchema,
        {
          method: 'POST',
          body: JSON.stringify({
            jsonc: draftJsonc,
            listingName: data.listing.raw.listingName ?? '',
          }),
        },
      )
      setDryRun(result.attempt)
    } catch (e) {
      setDryRunError(e instanceof Error ? e.message : 'Dry-run failed')
    } finally {
      setDryRunLoading(false)
    }
  }, [competitorParam, fuzzyHashParam, draftJsonc, data.listing.raw.listingName])

  const rawJson = useMemo(() => JSON.stringify(data.listing.rawFull, null, 2), [data.listing.rawFull])

  return (
    <div className="stacked-list">
      <section className="detail-panel">
        <div className="page-header" style={{ marginBottom: '0.5rem' }}>
          <div>
            <p className="eyebrow">
              Config → LitAlerts → Parsing →{' '}
              <a href={`/config/parsing/litalerts`} target="_blank" rel="noreferrer">{data.competitorName}</a>
            </p>
            <h2 style={{ margin: 0 }}>{data.listing.raw.listingName ?? '(no listingName)'}</h2>
            <p className="subtle-copy" style={{ marginTop: '0.25rem' }}>
              tenant <code>{data.tenantId}</code> · observation <code>#{data.listing.observationId}</code> · captured{' '}
              <code>{data.listing.observedAt}</code>
              {data.listing.searchTerm ? <> · search <code>{data.listing.searchTerm}</code></> : null}
            </p>
          </div>
          {data.listing.raw.url ? (
            <a className="ghost-button" href={data.listing.raw.url} target="_blank" rel="noreferrer">
              Open on competitor site ↗
            </a>
          ) : null}
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
          <section style={{ padding: '0.75rem', border: '1px solid rgba(0,0,0,0.08)', borderRadius: '4px' }}>
            <h3 style={{ marginTop: 0 }}>Current parse</h3>
            <p className="subtle-copy" style={{ marginTop: 0 }}>
              From the parser config currently live on master of{' '}
              <code>helios-parser-configs</code>.
            </p>
            <SourceBadge
              source={data.listing.parserSource}
              parserId={data.listing.parserId}
              snapshotSha={data.listing.snapshotSha}
              placeholderReason={data.listing.placeholderReason}
              placeholderDetail={data.listing.placeholderDetail}
            />
            <ParsedTable parsed={data.listing.parsed} />
          </section>

          <section style={{ padding: '0.75rem', border: '1px solid rgba(0,0,0,0.08)', borderRadius: '4px' }}>
            <h3 style={{ marginTop: 0 }}>Proposed parse (dry-run)</h3>
            <p className="subtle-copy" style={{ marginTop: 0 }}>
              Paste a candidate JSONC config below to preview how it would parse this listing.
              Validated + compiled in-process — nothing is written. Auto-seeded from your
              in-flight edit on the main page when available.
            </p>
            <textarea
              onChange={(e) => setDraftJsonc(e.currentTarget.value)}
              placeholder="// JSONC config to dry-run against this listing"
              rows={10}
              spellCheck={false}
              style={{ width: '100%', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '0.78rem' }}
              value={draftJsonc}
            />
            <div className="inline-row wrap-row" style={{ marginTop: '0.5rem' }}>
              <button
                className="primary-button"
                disabled={dryRunLoading || !draftJsonc.trim()}
                onClick={runDryRun}
                type="button"
              >
                {dryRunLoading ? 'Parsing…' : 'Dry-run on this listing'}
              </button>
              <span className="subtle-copy">
                Input: <code>{data.listing.raw.listingName ?? '(empty)'}</code>
              </span>
            </div>
            {dryRunError ? <p className="error-banner" style={{ marginTop: '0.5rem', whiteSpace: 'pre-wrap' }}>{dryRunError}</p> : null}
            {dryRun ? (
              <div style={{ marginTop: '0.75rem' }}>
                {dryRun.parsed ? (
                  <>
                    <Pill tone="success">parsed</Pill>{' '}
                    <span className="subtle-copy">parserId: <code>{dryRun.parserId ?? '?'}</code></span>
                    <ParsedTable parsed={dryRun.parsed} />
                  </>
                ) : (
                  <>
                    <Pill tone="warning">no match</Pill>{' '}
                    <span className="subtle-copy">
                      {dryRun.reason ?? 'unknown'}{dryRun.failureDetail ? `: ${dryRun.failureDetail}` : ''}
                    </span>
                  </>
                )}
              </div>
            ) : null}
          </section>
        </div>

        <section style={{ marginTop: '1rem', padding: '0.75rem', border: '1px solid rgba(0,0,0,0.08)', borderRadius: '4px' }}>
          <h3 style={{ marginTop: 0 }}>Raw LitAlerts evidence</h3>
          <pre style={{ whiteSpace: 'pre-wrap', overflowX: 'auto', margin: 0, fontSize: '0.78rem' }}>{rawJson}</pre>
        </section>
      </section>
    </div>
  )
}

function ParsedTable({ parsed }: { parsed: ParsedFuzzy }): JSX.Element {
  return (
    <table className="data-table" style={{ marginTop: '0.5rem', fontSize: '0.85rem' }}>
      <tbody>
        <FuzzyRow label="brandNorm" value={parsed.brandNorm} />
        <FuzzyRow label="categoryNorm" value={parsed.categoryNorm} />
        <FuzzyRow label="subcategoryNorm" value={parsed.subcategoryNorm} />
        <FuzzyRow label="sizeGNorm" value={parsed.sizeGNorm != null ? `${parsed.sizeGNorm}g` : null} />
        <FuzzyRow label="sizeMgNorm" value={parsed.sizeMgNorm != null ? `${parsed.sizeMgNorm}mg` : null} />
        <FuzzyRow label="packCountNorm" value={parsed.packCountNorm} />
        <FuzzyRow label="strainNorm" value={parsed.strainNorm} />
      </tbody>
    </table>
  )
}

function FuzzyRow({ label, value }: { label: string; value: string | number | null }): JSX.Element {
  return (
    <tr>
      <td style={{ fontFamily: 'ui-monospace, monospace', color: '#666', width: '12rem' }}>{label}</td>
      <td>{value == null || value === '' ? <em style={{ color: '#999' }}>none</em> : String(value)}</td>
    </tr>
  )
}

function SourceBadge(props: {
  source: 'parsekit' | 'placeholder'
  parserId: string | null
  snapshotSha: string | null
  placeholderReason?: 'no_registry' | 'no_tenant_config' | 'parse_failed'
  placeholderDetail?: string
}): JSX.Element {
  if (props.source === 'parsekit') {
    const title = `${props.parserId ?? 'parsekit'} @ ${props.snapshotSha?.slice(0, 7) ?? '?'}`
    return <span title={title}><Pill tone="success">parsekit</Pill></span>
  }
  const reason = props.placeholderReason
  const label =
    reason === 'no_tenant_config' ? 'no config'
    : reason === 'no_registry' ? 'no registry'
    : reason === 'parse_failed' ? 'parse failed'
    : 'placeholder'
  const tone = reason === 'parse_failed' ? 'warning' : 'muted'
  return <span title={props.placeholderDetail ?? reason ?? ''}><Pill tone={tone}>{label}</Pill></span>
}
