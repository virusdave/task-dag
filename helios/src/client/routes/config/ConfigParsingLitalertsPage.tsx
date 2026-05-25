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

const ListResponseSchema = z.any() as z.ZodType<ListResponse>
const SampleSchema = z.any() as z.ZodType<CompetitorSampleResponse>
const ChatResponseSchema = z.any() as z.ZodType<ChatResponse>

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
      return
    }
    void loadSample(selectedCompetitor)
  }, [selectedCompetitor, loadSample])

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
                <tr><th>Competitor</th><th style={{ textAlign: 'right' }}>Listings</th></tr>
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
                {error ? <p className="error-banner">{error}</p> : null}
                {loadingSample ? <p className="subtle-copy">Loading sample…</p> : null}
                {sample ? (
                  <SampleTable sample={sample} selectedHashes={selectedHashes} onToggleHash={toggleHash} />
                ) : null}

                <h4 style={{ marginTop: '1.5rem' }}>LLM chat (advisory)</h4>
                <p className="subtle-copy">
                  Describe an inadequacy in how this competitor&rsquo;s listings are parsed. The model
                  (<code>{'google.gemma-3-27b-it'}</code> via Bedrock-mantle) sees the current parser
                  output for the focused rows and replies with a JSONC patch suggestion plus rationale.
                  <strong> Suggestions are not auto-applied</strong> — L5 git commit-and-push is a
                  future epic. For now, copy any useful change into the <code>helios-parser-configs</code>
                  repo by hand.
                </p>
                <textarea
                  onChange={(e) => setChatPrompt(e.currentTarget.value)}
                  placeholder="e.g. Listings like 'AIO - Pink Rozay - 0.5g' are losing the brand 'Ayrloom' because brand is not a separate field. Suggest a rule that extracts the brand from the first capitalized token before the first hyphen."
                  rows={4}
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
                  <div style={{ marginTop: '1rem', padding: '0.75rem', background: 'rgba(0,0,0,0.04)' }}>
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
