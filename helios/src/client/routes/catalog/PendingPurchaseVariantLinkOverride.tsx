// Reviewer-facing picker for the `targetReuseProductId` override on a
// pending-purchase row. Lets the operator either:
//
//   - INHERIT the generator's reuse pick (the default — nothing
//     persisted to `edited_structured_fields.targetReuseProductId`).
//   - FORCE a different existing Sweed product id by searching the
//     live Sweed catalog and picking a hit.
//   - CLEAR the generator's reuse pick entirely (forces the row down
//     the catalog-create branch on apply).
//
// The picker debounces the search box, aborts stale requests, and
// shows enough metadata per hit (image, group, brand, strain, size,
// price) that the reviewer can confidently confirm the right pick.
// When the operator chooses a hit, the parent's onChange receives
// the desired override state; persistence and merging into
// `editedStructuredFields` happens up in PendingPurchasesPage.
//
// Lives in routes/catalog/ rather than canonicalProductRow/ because
// the response shape, endpoint, and siteDealerId routing are all
// pending-purchases-specific. Promote to a shared component when a
// second page actually needs the same picker.

import { useEffect, useMemo, useRef, useState, type JSX } from 'react'

import { Pill } from '../../components/Pill.js'
import {
  SweedVariantSearchResponseSchema,
  type SweedVariantSearchHit,
} from '../../../shared/contracts/index.js'

/**
 * One of three states the reviewer can leave the override in.
 * Mirrors the key-presence semantics in
 * `EditedStructuredFieldsSchema.targetReuseProductId` (api contract):
 *   - 'inherit': key absent  → parser/generator value wins.
 *   - 'forced' : positive int → reviewer-chosen Sweed product id wins.
 *   - 'cleared': explicit null → reviewer cleared the parser pick;
 *                                apply will take the catalog-create
 *                                branch instead of reusing.
 */
export type VariantLinkOverrideMode = 'cleared' | 'forced' | 'inherit'

export interface VariantLinkOverrideState {
  mode: VariantLinkOverrideMode
  /**
   * Only set when `mode === 'forced'`. The Sweed product id the
   * reviewer picked. Kept alongside lightweight display metadata so
   * we can render a confirmation card without re-fetching from Sweed.
   */
  forcedProductId: number | null
  forcedDisplay: VariantLinkOverrideDisplay | null
}

export interface VariantLinkOverrideDisplay {
  productName: string
  groupName: string | null
  brandName: string | null
  strainName: string | null
  imageUrl: string | null
}

export function readInitialLinkOverrideState(args: {
  parserReuseProductId: number | null
  parserReuseProductName: string | null
  overrideKeyPresent: boolean
  overrideValue: number | null
}): VariantLinkOverrideState {
  if (!args.overrideKeyPresent) {
    return { mode: 'inherit', forcedProductId: null, forcedDisplay: null }
  }
  if (args.overrideValue === null) {
    return { mode: 'cleared', forcedProductId: null, forcedDisplay: null }
  }
  // Override forces a product id. We don't have the rich display
  // metadata (image/group/brand) on the row, but we DO know the
  // product id and — if the row's reuseProductName matches that id —
  // the name. (The row loader sets reuseProductName from the
  // generator's lookup; if the operator's override id matches the
  // parser id, this gives a free name.) Otherwise the picker shows
  // just the id and lets the reviewer re-confirm by searching.
  const matchesParserId = args.parserReuseProductId === args.overrideValue
  const forcedDisplay: VariantLinkOverrideDisplay | null = matchesParserId && args.parserReuseProductName
    ? {
      productName: args.parserReuseProductName,
      groupName: null,
      brandName: null,
      strainName: null,
      imageUrl: null,
    }
    : null
  return {
    mode: 'forced',
    forcedProductId: args.overrideValue,
    forcedDisplay,
  }
}

/**
 * Map this picker's state to the `targetReuseProductId` key on the
 * edited_structured_fields payload. Returns `undefined` when the key
 * should be omitted (= "inherit"), and an object otherwise. The caller
 * merges this into the rest of the structured-overrides payload.
 */
export function buildLinkOverridePayloadKey(
  state: VariantLinkOverrideState,
): { targetReuseProductId: number | null } | undefined {
  switch (state.mode) {
    case 'inherit':
      return undefined
    case 'cleared':
      return { targetReuseProductId: null }
    case 'forced':
      return state.forcedProductId !== null
        ? { targetReuseProductId: state.forcedProductId }
        : undefined
  }
}

export function PendingPurchaseVariantLinkOverride({
  disabled,
  onChange,
  parserReuseProductId,
  parserReuseProductName,
  siteDealerId,
  state,
}: {
  disabled: boolean
  onChange: (next: VariantLinkOverrideState) => void
  parserReuseProductId: number | null
  parserReuseProductName: string | null
  siteDealerId: number | null
  state: VariantLinkOverrideState
}): JSX.Element {
  const isOverridden = state.mode !== 'inherit'
  const parserPickLabel = parserReuseProductId
    ? `#${parserReuseProductId}${parserReuseProductName ? ` — ${parserReuseProductName}` : ''}`
    : '(no generator-proposed reuse)'

  return (
    <section className="variant-link-override">
      <header className="inline-row" style={{ gap: '0.4rem', alignItems: 'baseline', flexWrap: 'wrap' }}>
        <strong>Existing Sweed variant link</strong>
        {isOverridden ? <Pill tone="warning">override</Pill> : null}
      </header>
      <p className="subtle-copy" style={{ marginTop: '0.3rem' }}>
        Generator picked: <code>{parserPickLabel}</code>
        {' · '}
        Use this when the row should attach to a specific existing Sweed
        variant the generator didn't (or couldn't) match correctly.
      </p>
      <div className="inline-row wrap-row" style={{ gap: '0.4rem', marginTop: '0.5rem' }} role="radiogroup" aria-label="Link override mode">
        <ModeButton
          active={state.mode === 'inherit'}
          disabled={disabled}
          label="Use generator pick"
          onClick={() => onChange({ mode: 'inherit', forcedProductId: null, forcedDisplay: null })}
        />
        <ModeButton
          active={state.mode === 'forced'}
          disabled={disabled}
          label="Link to a specific variant…"
          onClick={() => onChange({ mode: 'forced', forcedProductId: state.forcedProductId, forcedDisplay: state.forcedDisplay })}
        />
        <ModeButton
          active={state.mode === 'cleared'}
          disabled={disabled}
          label="Force catalog-create (no reuse)"
          onClick={() => onChange({ mode: 'cleared', forcedProductId: null, forcedDisplay: null })}
        />
      </div>

      {state.mode === 'forced' ? (
        <VariantSearchPanel
          disabled={disabled}
          forcedDisplay={state.forcedDisplay}
          forcedProductId={state.forcedProductId}
          onPick={(hit) => onChange({
            mode: 'forced',
            forcedProductId: hit.productId,
            forcedDisplay: {
              productName: hit.productName,
              groupName: hit.groupName,
              brandName: hit.brandName,
              strainName: hit.strainName,
              imageUrl: hit.imageUrl,
            },
          })}
          siteDealerId={siteDealerId}
        />
      ) : null}

      {state.mode === 'forced' && state.forcedProductId !== null ? (
        <p className="subtle-copy" style={{ marginTop: '0.5rem' }}>
          On apply, this row will be linked to product <code>#{state.forcedProductId}</code> and
          Sweed&apos;s existing name / group / strain / size / tab / pack values for that product
          will be <strong>preserved</strong>. Parser-derived structured-override text on this
          row is ignored when a link is forced — only the price, ecommerce visibility, and
          distributor link are updated.
        </p>
      ) : null}
    </section>
  )
}

function ModeButton({
  active,
  disabled,
  label,
  onClick,
}: {
  active: boolean
  disabled: boolean
  label: string
  onClick: () => void
}): JSX.Element {
  return (
    <button
      aria-pressed={active}
      className={active ? 'primary-button' : 'ghost-button'}
      disabled={disabled}
      onClick={onClick}
      type="button"
    >
      {label}
    </button>
  )
}

function VariantSearchPanel({
  disabled,
  forcedDisplay,
  forcedProductId,
  onPick,
  siteDealerId,
}: {
  disabled: boolean
  forcedDisplay: VariantLinkOverrideDisplay | null
  forcedProductId: number | null
  onPick: (hit: SweedVariantSearchHit) => void
  siteDealerId: number | null
}): JSX.Element {
  const [query, setQuery] = useState('')
  const [debounced, setDebounced] = useState('')
  const [hits, setHits] = useState<SweedVariantSearchHit[]>([])
  const [totalCount, setTotalCount] = useState<number | null>(null)
  const [isSearching, setIsSearching] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  // Debounce the query so we don't fire a Sweed RPC on every keystroke.
  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(query.trim()), 250)
    return () => window.clearTimeout(t)
  }, [query])

  useEffect(() => {
    if (siteDealerId === null) {
      setHits([])
      setTotalCount(null)
      setErrorMessage('This row has no site dealer id; cannot search Sweed.')
      return
    }
    if (debounced.length < 2 && !/^\d+$/.test(debounced)) {
      // Don't fire on 1-char prefixes; minimum 2 chars OR an exact
      // numeric product id paste. Avoids hammering Sweed during typing.
      setHits([])
      setTotalCount(null)
      setErrorMessage(null)
      return
    }
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    setIsSearching(true)
    setErrorMessage(null)

    void (async () => {
      try {
        const params = new URLSearchParams({
          siteDealerId: String(siteDealerId),
          q: debounced,
        })
        const response = await fetch(
          `/api/catalog/pending-purchases/sweed-variant-search?${params.toString()}`,
          { signal: controller.signal },
        )
        if (!response.ok) {
          const text = await response.text()
          throw new Error(`Sweed variant search failed (${response.status}): ${text.slice(0, 200)}`)
        }
        const json = SweedVariantSearchResponseSchema.parse(await response.json())
        if (!controller.signal.aborted) {
          setHits(json.hits)
          setTotalCount(json.totalCount)
        }
      } catch (err) {
        if (controller.signal.aborted) return
        setErrorMessage(err instanceof Error ? err.message : 'Sweed variant search failed.')
        setHits([])
        setTotalCount(null)
      } finally {
        if (!controller.signal.aborted) {
          setIsSearching(false)
        }
      }
    })()

    return () => controller.abort()
  }, [debounced, siteDealerId])

  const summary = useMemo(() => {
    if (errorMessage) return errorMessage
    if (isSearching) return 'Searching Sweed…'
    if (debounced.length < 2 && !/^\d+$/.test(debounced)) return 'Type at least 2 characters or paste a numeric Sweed product id.'
    if (hits.length === 0) return `No matches for "${debounced}".`
    return `${hits.length}${totalCount !== null && totalCount > hits.length ? ` of ${totalCount}` : ''} matches — click one to link this row to it.`
  }, [debounced, errorMessage, hits.length, isSearching, totalCount])

  return (
    <div className="variant-link-search" style={{ marginTop: '0.5rem' }}>
      {forcedProductId !== null ? (
        <article
          className="mini-card"
          style={{ marginBottom: '0.5rem', borderColor: 'var(--color-warning, #d99500)' }}
        >
          <header>
            <strong>Currently linked</strong>
            <Pill tone="success">{`#${forcedProductId}`}</Pill>
          </header>
          {forcedDisplay ? (
            <p className="subtle-copy">
              {forcedDisplay.productName}
              {forcedDisplay.groupName ? ` · group: ${forcedDisplay.groupName}` : ''}
              {forcedDisplay.brandName ? ` · brand: ${forcedDisplay.brandName}` : ''}
              {forcedDisplay.strainName ? ` · strain: ${forcedDisplay.strainName}` : ''}
            </p>
          ) : (
            <p className="subtle-copy">
              Saved Sweed product id. Pick a hit below to update, or click <em>Use generator pick</em>
              above to drop this override.
            </p>
          )}
        </article>
      ) : null}
      <label className="stack-field">
        <span>Search Sweed catalog</span>
        <input
          autoComplete="off"
          disabled={disabled}
          onChange={(event) => setQuery(event.currentTarget.value)}
          placeholder="e.g. anthem indica pre-roll  —  or paste a product id like 338655"
          spellCheck={false}
          type="search"
          value={query}
        />
      </label>
      <p className="subtle-copy" style={{ marginTop: '0.25rem' }}>{summary}</p>
      {hits.length > 0 ? (
        <ul className="variant-link-hits stacked-list" style={{ listStyle: 'none', padding: 0, marginTop: '0.4rem' }}>
          {hits.map((hit) => (
            <li
              key={hit.productId}
              style={{
                borderTop: '1px solid var(--color-border, #d5d5d5)',
                padding: '0.4rem 0',
                opacity: hit.isDisabled ? 0.55 : 1,
              }}
            >
              <button
                className="ghost-button"
                disabled={disabled || hit.isDisabled}
                onClick={() => onPick(hit)}
                style={{
                  textAlign: 'left',
                  width: '100%',
                  display: 'flex',
                  gap: '0.6rem',
                  alignItems: 'flex-start',
                  background: forcedProductId === hit.productId ? 'rgba(255, 204, 0, 0.12)' : undefined,
                }}
                title={hit.isDisabled
                  ? `Sweed product ${hit.productId} is disabled and cannot be selected.`
                  : `Link this row to Sweed product ${hit.productId}`}
                type="button"
              >
                {hit.imageUrl ? (
                  <img
                    alt=""
                    loading="lazy"
                    src={hit.imageUrl}
                    style={{ width: '3rem', height: '3rem', objectFit: 'cover', borderRadius: '0.25rem' }}
                  />
                ) : (
                  <div
                    aria-hidden
                    style={{
                      width: '3rem',
                      height: '3rem',
                      background: 'var(--color-surface-alt, #efefef)',
                      borderRadius: '0.25rem',
                      flex: '0 0 3rem',
                    }}
                  />
                )}
                <div style={{ flex: 1 }}>
                  <div className="inline-row" style={{ gap: '0.4rem', flexWrap: 'wrap', alignItems: 'baseline' }}>
                    <strong>{hit.productName || '(unnamed)'}</strong>
                    <code style={{ fontSize: '0.75rem' }}>#{hit.productId}</code>
                    {hit.isDisabled ? <Pill tone="warning">disabled</Pill> : null}
                    {forcedProductId === hit.productId ? <Pill tone="success">linked</Pill> : null}
                  </div>
                  <div className="subtle-copy" style={{ fontSize: '0.8rem' }}>
                    {[
                      hit.brandName ? `brand: ${hit.brandName}` : null,
                      hit.groupName ? `group: ${hit.groupName}` : null,
                      hit.categoryName ? `cat: ${hit.categoryName}` : null,
                      hit.subcategoryName ? `subcat: ${hit.subcategoryName}` : null,
                      hit.strainName ? `strain: ${hit.strainName}` : null,
                      hit.tab ? `tab: ${hit.tab}` : null,
                      hit.sizeName ? `size: ${hit.sizeName}` : null,
                      hit.packOfSize ? `pack: ${hit.packOfSize}` : null,
                      typeof hit.price === 'number' ? `$${hit.price.toFixed(2)}` : null,
                    ].filter((s): s is string => s !== null).join(' · ')}
                  </div>
                </div>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}
