import { useCallback, useEffect, useState } from 'react'
import { useLoaderData } from 'react-router-dom'
import { z } from 'zod'

import { loadJson, mutateJson } from '../../app/fetchJson.js'
import { Pill } from '../../components/Pill.js'

interface CompetitorSummary {
  competitorName: string
  observationCount: number
  matchedListingCount: number
  uniqueCategories: number
  uniqueBrands: number
  minDistanceMiles: number | null
  nearestStoreKey: string | null
}

interface ListResponse {
  competitors: CompetitorSummary[]
}

interface ParsedFuzzy {
  brandNorm: string | null
  categoryNorm: string | null
  subcategoryNorm: string | null
  sizeGNorm: number | null
  sizeMgNorm: number | null
  packCountNorm: number | null
  strainNorm: string | null
}

interface SampleListing {
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
  parsed: ParsedFuzzy
  parserSource?: 'parsekit' | 'placeholder'
  parserId?: string | null
  snapshotSha?: string | null
  placeholderReason?: 'no_registry' | 'no_tenant_config' | 'parse_failed'
  placeholderDetail?: string
}

interface CompetitorSampleResponse {
  competitorName: string
  sample: SampleListing[]
}

interface ChatResponse {
  modelRef: string
  ok: boolean
  rationale: string
  patch: string
  newGoldensSuggested: Array<{ listingName?: string; expected?: unknown }>
}

interface ConfigFetchResponse {
  competitorName: string
  tenantId: string
  relPath: string
  exists: boolean
  jsonc: string | null
}

interface ApplyConfigResponse {
  ok: boolean
  tenantId: string
  relPath: string
  commitSha: string
  pushed: boolean
}

const ListResponseSchema = z.any() as z.ZodType<ListResponse>
const SampleSchema = z.any() as z.ZodType<CompetitorSampleResponse>
const ChatResponseSchema = z.any() as z.ZodType<ChatResponse>
const ConfigFetchResponseSchema = z.any() as z.ZodType<ConfigFetchResponse>
const ApplyConfigResponseSchema = z.any() as z.ZodType<ApplyConfigResponse>

export async function configParsingLitalertsLoader(): Promise<ListResponse> {
  return loadJson('/api/config/parsing/litalerts', ListResponseSchema)
}

export function ConfigParsingLitalertsPage(): JSX.Element {
  const data = useLoaderData() as ListResponse
  const [selectedCompetitor, setSelectedCompetitor] = useState<string | null>(null)
  const [sample, setSample] = useState<CompetitorSampleResponse | null>(null)
  const [loadingSample, setLoadingSample] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selectedHashes, setSelectedHashes] = useState<Set<string>>(new Set())

  const [chatPrompt, setChatPrompt] = useState('')
  const [chatLoading, setChatLoading] = useState(false)
  const [chatResponse, setChatResponse] = useState<ChatResponse | null>(null)
  const [chatError, setChatError] = useState<string | null>(null)

  const [configFetch, setConfigFetch] = useState<ConfigFetchResponse | null>(null)
  const [draftJsonc, setDraftJsonc] = useState<string>('')
  const [applyNote, setApplyNote] = useState<string>('')
  const [applyLoading, setApplyLoading] = useState(false)
  const [applyError, setApplyError] = useState<string | null>(null)
  const [applyResult, setApplyResult] = useState<ApplyConfigResponse | null>(null)

  const loadSample = useCallback(async (name: string) => {
    setLoadingSample(true)
    setError(null)
    try {
      const next = await loadJson(`/api/config/parsing/litalerts/${encodeURIComponent(name)}?limit=50`, SampleSchema)
      setSample(next)
      setSelectedHashes(new Set())
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load sample')
      setSample(null)
    } finally {
      setLoadingSample(false)
    }
  }, [])

  useEffect(() => {
    if (selectedCompetitor === null) {
      setSample(null)
      setConfigFetch(null)
      setDraftJsonc('')
      setApplyResult(null)
      setApplyError(null)
      return
    }
    void loadSample(selectedCompetitor)
    void (async () => {
      try {
        const next = await loadJson(
          `/api/config/parsing/litalerts/${encodeURIComponent(selectedCompetitor)}/config`,
          ConfigFetchResponseSchema,
        )
        setConfigFetch(next)
        setDraftJsonc(next.jsonc ?? buildEmptyConfigStub(next.tenantId))
        setApplyResult(null)
        setApplyError(null)
      } catch (e) {
        setConfigFetch(null)
        setApplyError(e instanceof Error ? e.message : 'Failed to load current config')
      }
    })()
  }, [selectedCompetitor, loadSample])

  async function applyConfig(): Promise<void> {
    if (!selectedCompetitor || applyLoading || !draftJsonc.trim()) return
    setApplyLoading(true)
    setApplyError(null)
    setApplyResult(null)
    try {
      const next = await mutateJson(
        `/api/config/parsing/litalerts/${encodeURIComponent(selectedCompetitor)}/apply-config`,
        ApplyConfigResponseSchema,
        {
          method: 'POST',
          body: JSON.stringify({ jsonc: draftJsonc, note: applyNote }),
        },
      )
      setApplyResult(next)
      // Refresh the on-disk view so the textarea matches what landed.
      try {
        const refreshed = await loadJson(
          `/api/config/parsing/litalerts/${encodeURIComponent(selectedCompetitor)}/config`,
          ConfigFetchResponseSchema,
        )
        setConfigFetch(refreshed)
        if (refreshed.jsonc) setDraftJsonc(refreshed.jsonc)
      } catch {
        /* non-fatal */
      }
    } catch (e) {
      setApplyError(e instanceof Error ? e.message : 'Apply failed')
    } finally {
      setApplyLoading(false)
    }
  }

  async function askLlm(): Promise<void> {
    if (!selectedCompetitor || !chatPrompt.trim() || chatLoading) return
    setChatLoading(true)
    setChatError(null)
    setChatResponse(null)
    try {
      const next = await mutateJson(
        `/api/config/parsing/litalerts/${encodeURIComponent(selectedCompetitor)}/chat`,
        ChatResponseSchema,
        {
          method: 'POST',
          body: JSON.stringify({
            prompt: chatPrompt,
            selectedListingHashes: [...selectedHashes],
          }),
        },
      )
      setChatResponse(next)
    } catch (e) {
      setChatError(e instanceof Error ? e.message : 'Chat request failed')
    } finally {
      setChatLoading(false)
    }
  }

  function toggleHash(hash: string): void {
    setSelectedHashes((prev) => {
      const next = new Set(prev)
      if (next.has(hash)) next.delete(hash)
      else next.add(hash)
      return next
    })
  }

  return (
    <div className="stacked-list">
      <section className="detail-panel">
        <div className="page-header" style={{ marginBottom: '0.5rem' }}>
          <div>
            <p className="eyebrow">Config → LitAlerts → Parsing</p>
            <h2>{data.competitors.length.toLocaleString()} competitors with recent matched listings</h2>
          </div>
          <Pill tone="warning">L3 review · L5 chat is advisory only</Pill>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '20rem 1fr', gap: '1rem' }}>
          <aside style={{ maxHeight: '70vh', overflowY: 'auto', borderRight: '1px solid rgba(0,0,0,0.1)', paddingRight: '0.5rem' }}>
            <table className="data-table" style={{ fontSize: '0.85rem' }}>
              <thead>
                <tr>
                  <th>Competitor</th>
                  <th style={{ textAlign: 'right' }} title="Min distance (miles) to one of our stores">mi</th>
                  <th style={{ textAlign: 'right' }}>Listings</th>
                </tr>
              </thead>
              <tbody>
                {data.competitors.map((row) => (
                  <tr
                    key={row.competitorName}
                    onClick={() => setSelectedCompetitor(row.competitorName)}
                    style={{
                      background: selectedCompetitor === row.competitorName ? 'rgba(0,80,160,0.06)' : undefined,
                      cursor: 'pointer',
                    }}
                  >
                    <td>{row.competitorName}</td>
                    <td
                      style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: row.minDistanceMiles === null ? 'rgba(0,0,0,0.4)' : undefined }}
                      title={row.nearestStoreKey ? `nearest: ${row.nearestStoreKey}` : 'no geocoded address'}
                    >
                      {row.minDistanceMiles === null ? '—' : row.minDistanceMiles < 10 ? row.minDistanceMiles.toFixed(1) : Math.round(row.minDistanceMiles)}
                    </td>
                    <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{row.matchedListingCount}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </aside>

          <div>
            {selectedCompetitor === null ? (
              <p className="subtle-copy">Select a competitor on the left to review its parser output.</p>
            ) : (
              <>
                <h3 style={{ marginTop: 0 }}>{selectedCompetitor}</h3>

                <section style={{ marginBottom: '1rem', padding: '0.75rem', border: '1px solid rgba(0,0,0,0.08)', borderRadius: '4px', background: 'rgba(0,0,0,0.02)' }}>
                  <h4 style={{ marginTop: 0, marginBottom: '0.25rem' }}>LLM chat</h4>
                  <p className="subtle-copy" style={{ marginTop: 0 }}>
                    Describe an inadequacy in how this competitor&rsquo;s listings are parsed. The model sees the focused rows
                    (selected below, or the top 12 if none) plus the live parser output, then proposes a JSONC patch and
                    optional new goldens against <code>helios-parser-configs</code>.
                  </p>
                  <textarea
                    onChange={(e) => setChatPrompt(e.currentTarget.value)}
                    placeholder="e.g. Listings like 'AIO - Pink Rozay - 0.5g' are losing the brand 'Ayrloom' because brand is not a separate field. Suggest a rule that extracts the brand from the first capitalized token before the first hyphen."
                    rows={3}
                    style={{ width: '100%', fontFamily: 'inherit' }}
                    value={chatPrompt}
                  />
                  <div className="inline-row wrap-row" style={{ marginTop: '0.5rem' }}>
                    <button
                      className="ghost-button"
                      disabled={chatLoading || !chatPrompt.trim()}
                      onClick={askLlm}
                      type="button"
                    >
                      {chatLoading ? 'Asking…' : 'Ask LLM'}
                    </button>
                    <span className="subtle-copy">
                      {selectedHashes.size > 0
                        ? `${selectedHashes.size} row(s) selected as focus`
                        : 'No rows selected — model sees the top 12 most-recent rows'}
                    </span>
                  </div>
                  {chatError ? <p className="error-banner" style={{ marginTop: '0.5rem' }}>{chatError}</p> : null}
                  {chatResponse ? (
                    <div style={{ marginTop: '0.75rem', padding: '0.75rem', background: 'rgba(0,0,0,0.04)' }}>
                      <p style={{ margin: 0 }}><strong>Rationale</strong></p>
                      <p style={{ whiteSpace: 'pre-wrap', margin: '0.25rem 0 0.75rem' }}>{chatResponse.rationale}</p>
                      <p style={{ margin: 0 }}><strong>Suggested patch</strong></p>
                      <pre style={{ whiteSpace: 'pre-wrap', overflowX: 'auto', margin: '0.25rem 0' }}>{chatResponse.patch}</pre>
                      {chatResponse.newGoldensSuggested.length > 0 ? (
                        <details style={{ marginTop: '0.5rem' }}>
                          <summary>{chatResponse.newGoldensSuggested.length} new golden(s) suggested</summary>
                          <pre style={{ whiteSpace: 'pre-wrap' }}>{JSON.stringify(chatResponse.newGoldensSuggested, null, 2)}</pre>
                        </details>
                      ) : null}
                      <p className="subtle-copy" style={{ marginTop: '0.5rem' }}>
                        model: <code>{chatResponse.modelRef}</code>
                      </p>
                    </div>
                  ) : null}
                </section>

                <section style={{ marginBottom: '1rem', padding: '0.75rem', border: '1px solid rgba(0,0,0,0.08)', borderRadius: '4px' }}>
                  <h4 style={{ marginTop: 0, marginBottom: '0.25rem' }}>Apply &amp; push parser config</h4>
                  <p className="subtle-copy" style={{ marginTop: 0 }}>
                    Edits below are committed straight to <code>master</code> of
                    <code> helios-parser-configs</code>. The server validates against the
                    parsekit contract / dialect / goldens before pushing — any failure
                    surfaces in red without touching the repo.
                    {configFetch ? (
                      <> Target file: <code>{configFetch.relPath}</code> {configFetch.exists ? null : <em>(new file — will be created)</em>}</>
                    ) : null}
                  </p>
                  <textarea
                    onChange={(e) => setDraftJsonc(e.currentTarget.value)}
                    rows={14}
                    spellCheck={false}
                    style={{ width: '100%', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '0.78rem' }}
                    value={draftJsonc}
                  />
                  <textarea
                    onChange={(e) => setApplyNote(e.currentTarget.value)}
                    placeholder="Commit note (optional) — what changed and why."
                    rows={2}
                    style={{ width: '100%', fontFamily: 'inherit', marginTop: '0.5rem' }}
                    value={applyNote}
                  />
                  <div className="inline-row wrap-row" style={{ marginTop: '0.5rem' }}>
                    <button
                      className="primary-button"
                      disabled={applyLoading || !draftJsonc.trim()}
                      onClick={applyConfig}
                      type="button"
                    >
                      {applyLoading ? 'Applying…' : 'Apply & push'}
                    </button>
                    <span className="subtle-copy">
                      {configFetch?.exists
                        ? 'Validates → writes → commits → pushes to origin/master.'
                        : 'No existing config; the panel is seeded with a minimal stub for editing.'}
                    </span>
                  </div>
                  {applyError ? <p className="error-banner" style={{ marginTop: '0.5rem', whiteSpace: 'pre-wrap' }}>{applyError}</p> : null}
                  {applyResult ? (
                    <p className="subtle-copy" style={{ marginTop: '0.5rem' }}>
                      ✓ Pushed commit <code>{applyResult.commitSha.slice(0, 7)}</code> to <code>{applyResult.relPath}</code>
                      {applyResult.pushed ? '' : ' (remote already at HEAD)'}. Registry will pick it up on the next refresh tick (≤ 60s).
                    </p>
                  ) : null}
                </section>

                {error ? <p className="error-banner">{error}</p> : null}
                {loadingSample ? <p className="subtle-copy">Loading sample…</p> : null}
                {sample ? (
                  <SampleTable sample={sample} selectedHashes={selectedHashes} onToggleHash={toggleHash} />
                ) : null}
              </>
            )}
          </div>
        </div>

        <details style={{ marginTop: '1.5rem' }}>
          <summary>About this page</summary>
          <div className="subtle-copy" style={{ marginTop: '0.5rem' }}>
            <p>
              v1 review surface for LitAlerts parsing. Today the parser is the inline placeholder at
              <code> helios/src/shared/marketMatch/listingParse.ts</code> (lifted from
              <code> worker/pricing/litAlertsMarket.ts</code>); the <code>helios-parser-configs</code>
              repo does <em>not</em> yet have a <code>use-cases/litalerts/</code> tree, so the
              suggested JSONC patches the LLM emits cannot yet round-trip into the runtime loader.
              Full design at <code>docs/helios/litalerts-parsing/EPIC_PLAN.md</code>.
            </p>
            <p>
              The chat panel sends focused rows (or the most recent 12 if none selected), the
              FuzzySku schema and a strict JSON-mode response contract to the Bedrock-mantle
              gateway. The model replies with <code>{`{rationale, patch, newGoldensSuggested}`}</code>.
              Suggestions are advisory only; no git commit/push yet.
            </p>
          </div>
        </details>
      </section>
    </div>
  )
}

function SampleTable({
  sample,
  selectedHashes,
  onToggleHash,
}: {
  sample: CompetitorSampleResponse
  selectedHashes: Set<string>
  onToggleHash: (hash: string) => void
}): JSX.Element {
  return (
    <table className="data-table">
      <thead>
        <tr>
          <th />
          <th>Listing</th>
          <th>Source</th>
          <th>Raw category</th>
          <th>Parsed brand</th>
          <th>Parsed size</th>
          <th>Pack</th>
          <th>Strain</th>
        </tr>
      </thead>
      <tbody>
        {sample.sample.map((row) => (
          <tr key={row.fuzzyHash}>
            <td>
              <input
                checked={selectedHashes.has(row.fuzzyHash)}
                onChange={() => onToggleHash(row.fuzzyHash)}
                type="checkbox"
              />
            </td>
            <td>
              {row.raw.url ? (
                <a href={row.raw.url} rel="noreferrer" target="_blank">{row.raw.listingName ?? '—'}</a>
              ) : (row.raw.listingName ?? '—')}
            </td>
            <td>
              <SourceBadge row={row} />
            </td>
            <td>{row.raw.category ?? '—'}</td>
            <td>{row.parsed.brandNorm ?? <em>none</em>}</td>
            <td>
              {row.parsed.sizeGNorm != null
                ? `${row.parsed.sizeGNorm}g`
                : row.parsed.sizeMgNorm != null
                  ? `${row.parsed.sizeMgNorm}mg`
                  : <em>none</em>}
            </td>
            <td>{row.parsed.packCountNorm ?? '—'}</td>
            <td>{row.parsed.strainNorm ?? '—'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function buildEmptyConfigStub(tenantId: string): string {
  const stub = {
    configVersion: 1,
    parserId: `litalerts.${tenantId}`,
    scope: { tenantId, useCase: 'litalerts' },
    dialectRef: { id: 'litalerts-v1', version: 1 },
    detect: {},
    rules: [
      {
        id: `${tenantId}.example`,
        priority: 100,
        parser: { kind: 'seq', items: [] },
        project: {},
        transforms: [],
        goldens: [],
      },
    ],
  }
  return (
    '// New tenant config — fill in parser, project, and goldens, then\n' +
    '// click "Apply & push" to validate against parsekit and commit.\n' +
    JSON.stringify(stub, null, 2)
  )
}

function SourceBadge({ row }: { row: SampleListing }): JSX.Element {
  if (row.parserSource === 'parsekit') {
    const title = `${row.parserId ?? 'parsekit'} @ ${row.snapshotSha?.slice(0, 7) ?? '?'}`
    return (
      <span title={title}>
        <Pill tone="success">parsekit</Pill>
      </span>
    )
  }
  const detail = row.placeholderDetail
  const reason = row.placeholderReason
  const title = detail
    ? `${reason ?? 'placeholder'}: ${detail}`
    : (reason ?? 'placeholder (legacy listingParse.ts)')
  const tone = reason === 'parse_failed' ? 'warning' : 'muted'
  const label =
    reason === 'no_tenant_config'
      ? 'no config'
      : reason === 'no_registry'
        ? 'no registry'
        : reason === 'parse_failed'
          ? 'parse failed'
          : 'placeholder'
  return (
    <span title={title}>
      <Pill tone={tone}>{label}</Pill>
    </span>
  )
}
