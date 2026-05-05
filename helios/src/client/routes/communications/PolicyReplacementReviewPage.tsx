import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLoaderData, useParams } from 'react-router-dom'
import { useVirtualizer } from '@tanstack/react-virtual'

import {
  POLICY_REPLACEMENT_CATEGORIES,
  PolicyReplacementDraftEmptyResponseSchema,
  PolicyReplacementDraftResponseSchema,
  PolicyReplacementPacketDetailSchema,
  PolicyReplacementPacketSummarySchema,
  type CopyEntryDetail,
  type PolicyReplacementCategory,
  type PolicyReplacementDecision,
  type PolicyReplacementDraftResponse,
  type PolicyReplacementItemFields,
  type PolicyReplacementItemId,
  type PolicyReplacementItemState,
  type PolicyReplacementPacketDetail,
  type PolicyReplacementPacketSummary,
  type TemplateFamilyDetail,
  type TextReplacementMappingDetail,
  type VisualReplacementPlanDetail,
} from '../../../shared/contracts/index.js'
import { loadJson, mutateJson } from '../../app/fetchJson.js'
import { useRegisterSidebarSubtree } from '../../components/SidebarNavContext.js'
import type { TreeNavNode } from '../../components/TreeNav.js'

interface LoaderData {
  packetId: string
  summary: PolicyReplacementPacketSummary
  detail: PolicyReplacementPacketDetail
  initialDraft: PolicyReplacementDraftResponse | null
}

export async function policyReplacementReviewLoader({
  params,
}: {
  params: Record<string, string | undefined>
}): Promise<LoaderData> {
  const packetId = params.packetId
  if (!packetId) {
    throw new Error('Missing packetId in URL.')
  }
  const [summary, detail] = await Promise.all([
    loadJson(
      `/api/communications/policy-replacements/${packetId}/summary`,
      PolicyReplacementPacketSummarySchema,
    ),
    loadJson(
      `/api/communications/policy-replacements/${packetId}/detail`,
      PolicyReplacementPacketDetailSchema,
    ),
  ])
  let initialDraft: PolicyReplacementDraftResponse | null = null
  try {
    initialDraft = await loadJson(
      `/api/communications/policy-replacements/${packetId}/draft`,
      PolicyReplacementDraftResponseSchema,
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : ''
    const empty = PolicyReplacementDraftEmptyResponseSchema.safeParse(safeParseJson(message))
    if (!empty.success) {
      throw error
    }
  }
  return { packetId, summary, detail, initialDraft }
}

function safeParseJson(value: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

interface CategorySection {
  prefix: string
  /** Single-word TYPE label for the breadcrumb tail. */
  typeLabel: string
  /** Human-friendly label for the heading and tree leaf. */
  longLabel: string
  count: number
}

function buildCategorySections(summary: PolicyReplacementPacketSummary): CategorySection[] {
  return [
    {
      prefix: 'visual',
      typeLabel: 'Visuals',
      longLabel: 'Limited logo / image replacements',
      count: summary.categories.visualReplacementPlans,
    },
    { prefix: 'headline', typeLabel: 'Headlines', longLabel: 'Replacement headline bank', count: summary.categories.headlines },
    {
      prefix: 'long-headline',
      typeLabel: 'Long headlines',
      longLabel: 'Long headline bank',
      count: summary.categories.longHeadlines,
    },
    {
      prefix: 'description',
      typeLabel: 'Descriptions',
      longLabel: 'Description bank',
      count: summary.categories.descriptions,
    },
    {
      prefix: 'template-family',
      typeLabel: 'Template families',
      longLabel: 'Reusable template families',
      count: summary.categories.templateFamilies,
    },
    {
      prefix: 'text-map',
      typeLabel: 'Text replacement mappings',
      longLabel: 'Text replacement mapping',
      count: summary.categories.textReplacementMappings,
    },
  ]
}

function buildItemId(prefix: string, index: number): PolicyReplacementItemId {
  return `${prefix}-${index}` as PolicyReplacementItemId
}

function sectionAnchorId(prefix: string): string {
  return `section-${prefix}`
}

/**
 * Resolve the current text for a source item id like `template-family-12`
 * or `description-4`. Returns the reviewer's edited text first, then falls
 * back to the source content from the loaded packet detail. Returns null
 * when the source cannot be resolved.
 */
function resolveSourceText(
  sourceId: string,
  detail: PolicyReplacementPacketDetail,
  items: Record<string, PolicyReplacementItemState>,
): string | null {
  const editedFromItems = items[sourceId]?.fields.text
  if (typeof editedFromItems === 'string' && editedFromItems.length > 0) {
    return editedFromItems
  }
  const match = sourceId.match(/^(visual|headline|long-headline|description|template-family|text-map)-(\d+)$/)
  if (!match) {
    return null
  }
  const [, prefix, indexStr] = match
  const idx = Number(indexStr) - 1
  if (idx < 0) {
    return null
  }
  if (prefix === 'headline') {
    return detail.headlines[idx]?.text ?? null
  }
  if (prefix === 'long-headline') {
    return detail.longHeadlines[idx]?.text ?? null
  }
  if (prefix === 'description') {
    return detail.descriptions[idx]?.text ?? null
  }
  if (prefix === 'template-family') {
    return detail.templateFamilies[idx]?.template ?? null
  }
  return null
}

const EMPTY_STATE: PolicyReplacementItemState = { decision: 'unreviewed', fields: {} }

function formatNumber(value: number | undefined | null): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return '0'
  }
  return value.toLocaleString('en-US')
}

function formatRecordEntries(record: Record<string, number> | undefined): string {
  if (!record) {
    return ''
  }
  const entries = Object.entries(record)
  if (entries.length === 0) {
    return ''
  }
  return entries.map(([key, value]) => `${key}: ${formatNumber(value)}`).join(' · ')
}

/**
 * Reviewer pill button row (Accept / Reject / Hold). Mirrors the
 * pre-Helios standalone packet: pill-shaped buttons that recolor to
 * good/bad/warn when active, not radios.
 */
interface DecisionRowProps {
  decision: PolicyReplacementDecision
  onChange: (next: PolicyReplacementDecision) => void
  acceptLabel?: string
  rejectLabel?: string
  holdLabel?: string
}

function DecisionRow({
  decision,
  onChange,
  acceptLabel = 'Accept',
  rejectLabel = 'Reject',
  holdLabel = 'Hold',
}: DecisionRowProps) {
  const labels: Record<Exclude<PolicyReplacementDecision, 'unreviewed'>, string> = {
    accepted: acceptLabel,
    rejected: rejectLabel,
    hold: holdLabel,
  }
  const order: Array<Exclude<PolicyReplacementDecision, 'unreviewed'>> = ['accepted', 'rejected', 'hold']
  return (
    <div className="decision-row" role="group" aria-label="Review decision">
      {order.map((option) => (
        <button
          key={option}
          type="button"
          className={`decision-button${decision === option ? ' is-active' : ''}`}
          data-decision={option}
          onClick={() => onChange(option)}
        >
          {labels[option]}
        </button>
      ))}
    </div>
  )
}

interface VisualCardProps {
  itemId: string
  index: number
  plan: VisualReplacementPlanDetail | undefined
  state: PolicyReplacementItemState
  setDecision: (itemId: string, decision: PolicyReplacementDecision) => void
  setField: (itemId: string, key: keyof PolicyReplacementItemFields, value: string) => void
}

const VisualCard = memo(function VisualCard({ itemId, index, plan, state, setDecision, setField }: VisualCardProps) {
  const onDecision = useCallback(
    (decision: PolicyReplacementDecision) => setDecision(itemId, decision),
    [itemId, setDecision],
  )
  const onField = useCallback(
    (key: keyof PolicyReplacementItemFields, value: string) => setField(itemId, key, value),
    [itemId, setField],
  )
  if (!plan) {
    return (
      <article className="review-card review-card-missing">
        <p>Visual {index + 1} ({itemId}) is missing from the packet detail payload.</p>
      </article>
    )
  }
  const associationCount = plan.associationCount ?? 0
  return (
    <article className={`review-card visual is-${state.decision}`} id={`item-${itemId}`}>
      <div className="card-head">
        <span className="eyebrow">{plan.assetType ?? 'Visual'}</span>
        <span className={`pill ${associationCount > 0 ? 'warning' : 'neutral'}`}>
          {`${formatNumber(associationCount)} associations`}
        </span>
      </div>
      {plan.currentAsset ? (
        <p>
          <strong>Current limited asset:</strong>{' '}
          <code>{plan.currentAsset}</code>{' '}
          <a href={plan.currentAsset} target="_blank" rel="noreferrer">
            open current limited creative
          </a>
        </p>
      ) : null}
      {plan.replacementAssetNamePattern ? (
        <p>
          <strong>Replacement source:</strong> <code>{plan.replacementAssetNamePattern}</code>
        </p>
      ) : null}
      {plan.plannedReplacementFieldType ? (
        <p>
          <strong>Attach as:</strong> <code>{plan.plannedReplacementFieldType}</code>
        </p>
      ) : null}
      {plan.applyInstruction ? <p className="muted">{plan.applyInstruction}</p> : null}
      {(plan.impressions !== undefined || plan.statusReasons || plan.levels) ? (
        <p className="muted">
          {plan.impressions !== undefined ? `Impressions: ${formatNumber(plan.impressions)}` : null}
          {plan.statusReasons ? ` · ${formatRecordEntries(plan.statusReasons)}` : null}
          {plan.levels ? ` · Levels — ${formatRecordEntries(plan.levels)}` : null}
        </p>
      ) : null}
      <DecisionRow decision={state.decision} onChange={onDecision} />
      <textarea
        rows={2}
        value={state.fields.note ?? ''}
        placeholder="Reviewer note for this visual replacement"
        onChange={(event) => onField('note', event.currentTarget.value)}
      />
    </article>
  )
})

interface CopyCardProps {
  itemId: string
  label: string
  index: number
  entry: CopyEntryDetail | undefined
  state: PolicyReplacementItemState
  setDecision: (itemId: string, decision: PolicyReplacementDecision) => void
  setField: (itemId: string, key: keyof PolicyReplacementItemFields, value: string) => void
}

const CopyCard = memo(function CopyCard({ itemId, label, index, entry, state, setDecision, setField }: CopyCardProps) {
  const onDecision = useCallback(
    (decision: PolicyReplacementDecision) => setDecision(itemId, decision),
    [itemId, setDecision],
  )
  const onField = useCallback(
    (key: keyof PolicyReplacementItemFields, value: string) => setField(itemId, key, value),
    [itemId, setField],
  )
  if (!entry) {
    return (
      <article className="review-card review-card-missing">
        <p>{label} {index + 1} ({itemId}) is missing from the packet detail payload.</p>
      </article>
    )
  }
  const sourceText = entry.text ?? ''
  const editedText = state.fields.text ?? sourceText
  return (
    <article className={`review-card is-${state.decision}`} id={`item-${itemId}`}>
      <div className="card-head">
        <span className="eyebrow">{`${label} ${index + 1}`}</span>
        <span className="char-count">{editedText.length}</span>
      </div>
      <textarea
        rows={2}
        value={editedText}
        onChange={(event) => onField('text', event.currentTarget.value)}
      />
      <DecisionRow decision={state.decision} onChange={onDecision} />
      {(entry.use || entry.whySafer || entry.source) ? (
        <details>
          <summary>Why / intended use</summary>
          {entry.whySafer ? <p>{entry.whySafer}</p> : null}
          {(entry.use || entry.source) ? (
            <p className="muted">
              {entry.use ?? ''}
              {entry.use && entry.source ? ' · ' : ''}
              {entry.source ?? ''}
            </p>
          ) : null}
        </details>
      ) : null}
      <textarea
        className="reviewer-note"
        rows={1}
        value={state.fields.note ?? ''}
        placeholder="Reviewer note"
        onChange={(event) => onField('note', event.currentTarget.value)}
      />
    </article>
  )
})

interface TemplateFamilyCardProps {
  itemId: string
  index: number
  entry: TemplateFamilyDetail | undefined
  state: PolicyReplacementItemState
  setDecision: (itemId: string, decision: PolicyReplacementDecision) => void
  setField: (itemId: string, key: keyof PolicyReplacementItemFields, value: string) => void
}

const TemplateFamilyCard = memo(function TemplateFamilyCard({ itemId, index, entry, state, setDecision, setField }: TemplateFamilyCardProps) {
  const onDecision = useCallback(
    (decision: PolicyReplacementDecision) => setDecision(itemId, decision),
    [itemId, setDecision],
  )
  const onField = useCallback(
    (key: keyof PolicyReplacementItemFields, value: string) => setField(itemId, key, value),
    [itemId, setField],
  )
  if (!entry) {
    return (
      <article className="review-card review-card-missing">
        <p>Template family {index + 1} ({itemId}) is missing from the packet detail payload.</p>
      </article>
    )
  }
  const sourceText = entry.template ?? ''
  const editedText = state.fields.text ?? sourceText
  const fieldType = entry.fieldType ?? 'Template'
  return (
    <article className={`review-card family-card is-${state.decision}`} id={`item-${itemId}`}>
      <div className="card-head">
        <span className="eyebrow">{`${fieldType} template ${index + 1}`}</span>
        <span className="pill neutral">template</span>
      </div>
      <textarea
        rows={2}
        value={editedText}
        onChange={(event) => onField('text', event.currentTarget.value)}
      />
      <DecisionRow decision={state.decision} onChange={onDecision} />
      {(entry.use || entry.whySafer || entry.source) ? (
        <details>
          <summary>Use and safety note</summary>
          {entry.whySafer ? <p>{entry.whySafer}</p> : null}
          {(entry.use || entry.source) ? (
            <p className="muted">
              {entry.use ?? ''}
              {entry.use && entry.source ? ' · ' : ''}
              {entry.source ?? ''}
            </p>
          ) : null}
        </details>
      ) : null}
      <textarea
        className="reviewer-note"
        rows={1}
        value={state.fields.note ?? ''}
        placeholder="Reviewer note"
        onChange={(event) => onField('note', event.currentTarget.value)}
      />
    </article>
  )
})

/**
 * Resolve the decision of the source item bound to this mapping (if any).
 * Drives the row-tinting and column-1 inset shadow indicator just like the
 * standalone packet does.
 */
function resolveSourceDecision(
  sourceId: string | undefined,
  items: Record<string, PolicyReplacementItemState>,
): PolicyReplacementDecision | null {
  if (!sourceId) {
    return null
  }
  return items[sourceId]?.decision ?? null
}

interface MappingRowProps {
  mapping: TextReplacementMappingDetail
  categoryLabels: Record<string, string>
  state: PolicyReplacementItemState
  items: Record<string, PolicyReplacementItemState>
  detail: PolicyReplacementPacketDetail
  onDecision: (decision: PolicyReplacementDecision) => void
  onField: (key: keyof PolicyReplacementItemFields, value: string) => void
  onPickCategory: (category: PolicyReplacementCategory | '', sourceId: string | null) => void
  /** Virtualizer ref for measureElement. Optional so the row can also be rendered outside a virtualizer. */
  rowRef?: (node: HTMLTableRowElement | null) => void
  /** Required by `useVirtualizer.measureElement` to know which virtual row this DOM node represents. */
  virtualIndex?: number
}

function MappingRow({
  mapping,
  categoryLabels,
  state,
  items,
  detail,
  onDecision,
  onField,
  onPickCategory,
  rowRef,
  virtualIndex,
}: MappingRowProps) {
  const itemId = mapping.mappingId
  const proposedReplacement = mapping.proposedReplacement ?? ''
  const defaultCategoryRaw: string = (mapping.defaultReplacementCategory ?? '') as string
  const selectedCategory: string = state.fields.replacementCategory ?? defaultCategoryRaw
  const selectedSourceId = state.fields.sourceId ?? ''
  const sourceDecision = resolveSourceDecision(selectedSourceId, items)
  // Live source -> mapping cascade: when a source is bound, the fallback for
  // editedText is the *current* source text resolved through the items map.
  // This way an edit to e.g. template-family-3 propagates immediately into
  // every mapping whose sourceId points at template-family-3, without
  // overwriting any reviewer-edited mapping text (state.fields.text wins).
  // When no source is bound, the baked proposedReplacement remains the
  // fallback. resolveSourceText can return null if the id is malformed or
  // not found in the packet detail; fall back to proposedReplacement then.
  const sourceFallbackText = selectedSourceId
    ? resolveSourceText(selectedSourceId, detail, items) ?? proposedReplacement
    : proposedReplacement
  const editedText = state.fields.text ?? sourceFallbackText
  const rowSourceClass = sourceDecision ? `is-source-${sourceDecision}` : ''
  const mappingClass = `is-mapping-${state.decision}`
  // Resolve a status note for the bound source's review state.
  const sourceStatusText = (() => {
    if (!selectedSourceId) {
      return 'No source selected.'
    }
    const sourceText = resolveSourceText(selectedSourceId, detail, items)
    const decisionLabel = sourceDecision ?? 'unreviewed'
    const preview = sourceText ? ` — ${sourceText.length > 80 ? `${sourceText.slice(0, 80)}…` : sourceText}` : ''
    return `Selected source ${selectedSourceId} (${decisionLabel})${preview}`
  })()
  const options = mapping.replacementOptions
  return (
    <tr
      id={`item-${itemId}`}
      className={`${rowSourceClass} ${mappingClass}`.trim()}
      data-review-item={itemId}
      data-index={virtualIndex}
      ref={rowRef}
    >
      <td>
        <span className="eyebrow">{mapping.assetType ?? 'Mapping'}</span>
      </td>
      <td>{formatNumber(mapping.associationCount ?? 0)}</td>
      <td>{mapping.impressions !== undefined ? formatNumber(mapping.impressions) : ''}</td>
      <td className="muted">
        {mapping.levels ? formatRecordEntries(mapping.levels) : ''}
      </td>
      <td>
        <code>{mapping.currentText ?? ''}</code>
        {mapping.statusReasons ? (
          <p className="muted">{formatRecordEntries(mapping.statusReasons)}</p>
        ) : null}
      </td>
      <td>
        {options.length > 0 ? (
          <div className="category-options">
            <label className="category-option">
              <input
                type="radio"
                name={`category-${itemId}`}
                checked={!selectedCategory}
                onChange={() => onPickCategory('', null)}
              />
              <span>None</span>
            </label>
            {options.map((option) => (
              <label key={option.category} className="category-option" title={`Sourced from ${option.sourceId}`}>
                <input
                  type="radio"
                  name={`category-${itemId}`}
                  checked={selectedCategory === option.category}
                  onChange={() => onPickCategory(option.category, option.sourceId)}
                />
                <span>{categoryLabels[option.category] ?? option.label}</span>
              </label>
            ))}
          </div>
        ) : (
          <div className="category-options">
            <label className="category-option">
              <input
                type="radio"
                name={`category-${itemId}`}
                checked={!selectedCategory}
                onChange={() => onPickCategory('', null)}
              />
              <span>None</span>
            </label>
            {POLICY_REPLACEMENT_CATEGORIES.map((category) => (
              <label key={category} className="category-option">
                <input
                  type="radio"
                  name={`category-${itemId}`}
                  checked={selectedCategory === category}
                  onChange={() => onPickCategory(category, null)}
                />
                <span>{categoryLabels[category] ?? category}</span>
              </label>
            ))}
          </div>
        )}
        <textarea
          rows={2}
          value={editedText}
          onChange={(event) => onField('text', event.currentTarget.value)}
        />
        {mapping.whySafer ? <p className="muted"><em>{mapping.whySafer}</em></p> : null}
        <p className="muted source-status">{sourceStatusText}</p>
      </td>
      <td>
        <DecisionRow
          decision={state.decision}
          onChange={onDecision}
          acceptLabel="Accept mapping"
          rejectLabel="Reject mapping"
          holdLabel="Hold mapping"
        />
        <textarea
          className="reviewer-note"
          rows={1}
          value={state.fields.note ?? ''}
          placeholder="note"
          onChange={(event) => onField('note', event.currentTarget.value)}
        />
      </td>
      <td className="muted">{mapping.replacementSource ?? ''}</td>
    </tr>
  )
}

interface MappingTableProps {
  textMapCount: number
  mappings: TextReplacementMappingDetail[]
  categoryLabels: Record<string, string>
  items: Record<string, PolicyReplacementItemState>
  detail: PolicyReplacementPacketDetail
  setDecision: (itemId: string, decision: PolicyReplacementDecision) => void
  setField: (itemId: string, key: keyof PolicyReplacementItemFields, value: string) => void
  pickMappingCategory: (
    itemId: string,
    category: PolicyReplacementCategory | '',
    sourceId: string | null,
  ) => void
}

/**
 * Virtualized body for the text-replacement mapping table. The mapping ledger
 * is the largest list in the page (~152 rows of radios + textareas + a
 * reviewer-note textarea + DecisionRow), so we render only the rows that fall
 * inside the visible scroll window. The table is wrapped in a fixed-height
 * scroll container (`.table-wrap` already sets `max-height: 640px`); rows
 * outside the window are represented by two padding `<tr>`s above and below.
 *
 * Rows have variable height (whySafer, statusReasons, multiline source
 * status), so we use `measureElement` to record observed heights instead of a
 * fixed estimate. The estimate is only used for the initial render.
 */
function MappingTable({
  textMapCount,
  mappings,
  categoryLabels,
  items,
  detail,
  setDecision,
  setField,
  pickMappingCategory,
}: MappingTableProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null)
  // Pre-resolve mapping lookup once per render so each row doesn't re-scan the
  // mappings array. The find() in the original tbody was O(n) per row -> O(n^2)
  // overall on every keystroke; with the lookup we get O(n) per render.
  const mappingsById = useMemo(() => {
    const byId = new Map<string, TextReplacementMappingDetail>()
    for (const mapping of mappings) {
      byId.set(mapping.mappingId, mapping)
    }
    return byId
  }, [mappings])
  const virtualizer = useVirtualizer({
    count: textMapCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 260,
    overscan: 6,
    measureElement: (element) => element.getBoundingClientRect().height,
  })
  const virtualRows = virtualizer.getVirtualItems()
  const totalSize = virtualizer.getTotalSize()
  const paddingTop = virtualRows.length > 0 ? virtualRows[0].start : 0
  const paddingBottom =
    virtualRows.length > 0 ? totalSize - virtualRows[virtualRows.length - 1].end : 0
  return (
    <div className="table-wrap" ref={scrollRef}>
      <table>
        <thead>
          <tr>
            <th>Type</th>
            <th>Assoc.</th>
            <th>Impr.</th>
            <th>Levels</th>
            <th>Current limited text</th>
            <th>Proposed replacement + category</th>
            <th>Mapping review</th>
            <th>Source</th>
          </tr>
        </thead>
        <tbody>
          {paddingTop > 0 ? (
            <tr aria-hidden style={{ height: paddingTop }}>
              <td colSpan={8} style={{ padding: 0, border: 0 }} />
            </tr>
          ) : null}
          {virtualRows.map((vRow) => {
            const itemId = buildItemId('text-map', vRow.index + 1)
            const mapping = mappingsById.get(itemId)
            if (!mapping) {
              return (
                <tr key={itemId} ref={virtualizer.measureElement} data-index={vRow.index}>
                  <td colSpan={8} className="error-text">
                    Mapping {itemId} is missing from the packet detail payload.
                  </td>
                </tr>
              )
            }
            const state = items[itemId] ?? EMPTY_STATE
            return (
              <MappingRow
                key={itemId}
                mapping={mapping}
                categoryLabels={categoryLabels}
                state={state}
                items={items}
                detail={detail}
                onDecision={(decision) => setDecision(itemId, decision)}
                onField={(key, value) => setField(itemId, key, value)}
                onPickCategory={(category, sourceId) =>
                  pickMappingCategory(itemId, category, sourceId)
                }
                rowRef={virtualizer.measureElement}
                virtualIndex={vRow.index}
              />
            )
          })}
          {paddingBottom > 0 ? (
            <tr aria-hidden style={{ height: paddingBottom }}>
              <td colSpan={8} style={{ padding: 0, border: 0 }} />
            </tr>
          ) : null}
        </tbody>
      </table>
    </div>
  )
}

interface VirtualizedCardListProps {
  count: number
  /** Initial estimate; rows are remeasured via `measureElement` after mount. */
  estimateSize?: number
  /** Max-height of the inner scroll container (px). */
  maxHeight?: number
  renderItem: (index: number) => React.ReactNode
  /** Stable key for each index. */
  getKey: (index: number) => string
}

/**
 * Single-column virtualized scroll container for card sections (headlines,
 * descriptions, template families). Each section gets its own fixed-height
 * scroll viewport so only ~6–8 cards are mounted at a time instead of the
 * full 47/33/12 list. Item heights vary (textareas, optional details, char
 * counts, reviewer notes), so we use `measureElement` and let the virtualizer
 * remeasure after mount.
 *
 * Cards are positioned absolutely inside a relatively-positioned spacer div
 * sized to the virtualizer's `getTotalSize()`, so the scrollbar always
 * reflects the full content height.
 */
function VirtualizedCardList({
  count,
  estimateSize = 240,
  maxHeight = 720,
  renderItem,
  getKey,
}: VirtualizedCardListProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const virtualizer = useVirtualizer({
    count,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => estimateSize,
    overscan: 4,
    measureElement: (element) => element.getBoundingClientRect().height,
  })
  const virtualItems = virtualizer.getVirtualItems()
  return (
    <div className="virtual-card-list" ref={scrollRef} style={{ maxHeight }}>
      <div
        className="virtual-card-list-inner"
        style={{ height: virtualizer.getTotalSize(), position: 'relative', width: '100%' }}
      >
        {virtualItems.map((vItem) => (
          <div
            key={getKey(vItem.index)}
            data-index={vItem.index}
            ref={virtualizer.measureElement}
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              right: 0,
              transform: `translateY(${vItem.start}px)`,
              padding: '7px 0',
            }}
          >
            {renderItem(vItem.index)}
          </div>
        ))}
      </div>
    </div>
  )
}

export function PolicyReplacementReviewPage() {
  const { packetId: paramPacketId } = useParams<{ packetId: string }>()
  const { packetId, summary, detail, initialDraft } = useLoaderData() as LoaderData
  const [items, setItems] = useState<Record<string, PolicyReplacementItemState>>(initialDraft?.items ?? {})
  const [savedAt, setSavedAt] = useState<string | null>(initialDraft?.savedAt ?? null)
  const [submittedAt, setSubmittedAt] = useState<string | null>(initialDraft?.submittedAt ?? null)
  const [statusMessage, setStatusMessage] = useState<string>('')
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [copyStatus, setCopyStatus] = useState<string>('Nothing copied yet')
  const [isSaving, setIsSaving] = useState(false)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const sections = useMemo(() => buildCategorySections(summary), [summary])
  // Register the Review > Assets > <TYPE> subtree under the Ads
  // (communications) module branch in the primary AppShell sidebar. There
  // is no per-page rail; the primary sidebar is the only navigation.
  // Sidebar leaves use anchor-style targetId so the browser scrolls to the
  // matching section on this page when clicked.
  const sidebarSubtree = useMemo<TreeNavNode[]>(
    () => [
      {
        kind: 'branch',
        navKey: `communications.policy-replacements.${packetId}.review`,
        label: 'Review',
        defaultOpen: false,
        children: [
          {
            kind: 'leaf' as const,
            navKey: `communications.policy-replacements.${packetId}.review.overview`,
            label: 'Overview',
            targetId: 'section-overview',
          },
          {
            kind: 'leaf' as const,
            navKey: `communications.policy-replacements.${packetId}.review.submit`,
            label: 'Submit review',
            targetId: 'section-submit',
          },
          {
            kind: 'leaf' as const,
            navKey: `communications.policy-replacements.${packetId}.review.apply-gates`,
            label: 'Apply gates',
            targetId: 'section-apply-gates',
          },
          {
            kind: 'leaf' as const,
            navKey: `communications.policy-replacements.${packetId}.review.llm-patterns`,
            label: 'LLM patterns',
            targetId: 'section-llm-patterns',
          },
          {
            kind: 'branch',
            navKey: `communications.policy-replacements.${packetId}.review.assets`,
            label: 'Assets',
            defaultOpen: false,
            children: sections.map((section) => ({
              kind: 'leaf' as const,
              navKey: `communications.policy-replacements.${packetId}.review.assets.${section.prefix}`,
              label: section.longLabel,
              targetId: sectionAnchorId(section.prefix),
              count: section.count,
            })),
          },
          {
            kind: 'leaf' as const,
            navKey: `communications.policy-replacements.${packetId}.review.anchors`,
            label: 'LLM anchors',
            targetId: 'section-anchors',
          },
        ],
      },
    ],
    [packetId, sections],
  )
  useRegisterSidebarSubtree('communications', sidebarSubtree)
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const itemsRef = useRef(items)
  itemsRef.current = items

  const performSave = useCallback(
    async (markSubmitted: boolean) => {
      try {
        if (markSubmitted) {
          setIsSubmitting(true)
        } else {
          setIsSaving(true)
        }
        setErrorMessage(null)
        const payload = {
          packetId,
          items: itemsRef.current,
          submit: markSubmitted ? true : undefined,
        }
        const response = await mutateJson(
          `/api/communications/policy-replacements/${packetId}/draft`,
          PolicyReplacementDraftResponseSchema,
          {
            body: JSON.stringify(payload),
            method: 'POST',
          },
        )
        setItems(response.items as Record<string, PolicyReplacementItemState>)
        setSavedAt(response.savedAt)
        setSubmittedAt(response.submittedAt)
        setStatusMessage(markSubmitted ? 'Submitted.' : `Saved at ${response.savedAt ?? 'now'}.`)
      } catch (error) {
        setErrorMessage(error instanceof Error ? error.message : 'Could not save the review draft.')
      } finally {
        setIsSaving(false)
        setIsSubmitting(false)
      }
    },
    [packetId],
  )

  const scheduleDebouncedSave = useCallback(() => {
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current)
    }
    debounceTimerRef.current = setTimeout(() => {
      void performSave(false)
    }, 800)
  }, [performSave])

  useEffect(
    () => () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current)
      }
    },
    [],
  )

  const updateItem = useCallback(
    (itemId: string, updater: (prev: PolicyReplacementItemState) => PolicyReplacementItemState) => {
      setItems((prev) => {
        const current = prev[itemId] ?? EMPTY_STATE
        const next = updater(current)
        return { ...prev, [itemId]: next }
      })
      scheduleDebouncedSave()
    },
    [scheduleDebouncedSave],
  )

  const setDecision = useCallback(
    (itemId: string, decision: PolicyReplacementDecision) => {
      updateItem(itemId, (prev) => ({ ...prev, decision }))
    },
    [updateItem],
  )

  const setField = useCallback(
    (itemId: string, key: keyof PolicyReplacementItemFields, value: string) => {
      updateItem(itemId, (prev) => {
        const nextFields: PolicyReplacementItemFields = { ...prev.fields }
        if (value === '' && key !== 'replacementCategory') {
          delete nextFields[key]
        } else if (key === 'replacementCategory') {
          nextFields.replacementCategory = value as PolicyReplacementCategory | ''
        } else {
          nextFields[key] = value
        }
        return { ...prev, fields: nextFields }
      })
    },
    [updateItem],
  )

  /**
   * Mapping category radios drive both the chosen category and the
   * resolved replacement text, mirroring the standalone packet's
   * source-id-driven rebind. Picking `'none'` clears category, sourceId,
   * and any user-edited text override so the mapping reverts to its
   * baked proposed replacement.
   */
  const pickMappingCategory = useCallback(
    (itemId: string, category: PolicyReplacementCategory | '', sourceId: string | null) => {
      updateItem(itemId, (prev) => {
        const nextFields: PolicyReplacementItemFields = { ...prev.fields }
        nextFields.replacementCategory = category
        if (category === '' || sourceId === null) {
          delete nextFields.sourceId
          delete nextFields.text
          return { ...prev, fields: nextFields }
        }
        nextFields.sourceId = sourceId
        const resolvedText = resolveSourceText(sourceId, detail, itemsRef.current)
        if (typeof resolvedText === 'string') {
          nextFields.text = resolvedText
        }
        return { ...prev, fields: nextFields }
      })
    },
    [detail, updateItem],
  )

  /**
   * On first load, hydrate `defaultReplacementCategory` + matching source
   * id and resolved text into local state for any mapping the reviewer
   * has not already touched. Mirrors the standalone packet behavior so
   * an accepted-but-untouched mapping still submits with provenance.
   */
  const hydratedDefaultsRef = useRef(false)
  useEffect(() => {
    if (hydratedDefaultsRef.current) {
      return
    }
    hydratedDefaultsRef.current = true
    if (detail.textReplacementMappings.length === 0) {
      return
    }
    setItems((prev) => {
      let changed = false
      const next: Record<string, PolicyReplacementItemState> = { ...prev }
      for (const mapping of detail.textReplacementMappings) {
        const existing = next[mapping.mappingId]
        if (existing && existing.fields.replacementCategory !== undefined) {
          continue
        }
        const defaultCategoryRaw: string = (mapping.defaultReplacementCategory ?? '') as string
        if (defaultCategoryRaw === '') {
          continue
        }
        const defaultCategory = defaultCategoryRaw as PolicyReplacementCategory
        const matchingOption = mapping.replacementOptions.find((option) => option.category === defaultCategory)
        const sourceId = matchingOption?.sourceId ?? null
        const fields: PolicyReplacementItemFields = { ...(existing?.fields ?? {}) }
        fields.replacementCategory = defaultCategory
        if (sourceId) {
          fields.sourceId = sourceId
          const resolvedText = resolveSourceText(sourceId, detail, prev)
          if (typeof resolvedText === 'string' && fields.text === undefined) {
            fields.text = resolvedText
          }
        }
        next[mapping.mappingId] = {
          decision: existing?.decision ?? 'unreviewed',
          fields,
        }
        changed = true
      }
      if (!changed) {
        return prev
      }
      return next
    })
  }, [detail])

  const decisionCounts = useMemo(() => {
    const counts: Record<PolicyReplacementDecision, number> = {
      unreviewed: 0,
      accepted: 0,
      rejected: 0,
      hold: 0,
    }
    for (const value of Object.values(items)) {
      counts[value.decision] = (counts[value.decision] ?? 0) + 1
    }
    counts.unreviewed = summary.itemIdCount - (counts.accepted + counts.rejected + counts.hold)
    return counts
  }, [items, summary.itemIdCount])

  /**
   * Bulk decision applied to every reviewable item id in the packet.
   * Used by the "Accept all visible" / "Hold all visible" controls in
   * the top hero bar — matching the pre-Helios packet behavior.
   */
  const applyBulkDecision = useCallback(
    (decision: PolicyReplacementDecision) => {
      setItems((prev) => {
        const next: Record<string, PolicyReplacementItemState> = { ...prev }
        for (const section of sections) {
          for (let i = 1; i <= section.count; i += 1) {
            const itemId = buildItemId(section.prefix, i)
            const existing = next[itemId] ?? EMPTY_STATE
            next[itemId] = { ...existing, decision }
          }
        }
        return next
      })
      scheduleDebouncedSave()
    },
    [sections, scheduleDebouncedSave],
  )

  const exportStateJson = useCallback(() => {
    const payload = {
      packetId,
      savedAt,
      submittedAt,
      items,
    }
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `${packetId}-review-state.json`
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
    URL.revokeObjectURL(url)
  }, [items, packetId, savedAt, submittedAt])

  const copyStateForAmp = useCallback(() => {
    const payload = JSON.stringify({ packetId, items }, null, 2)
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
      navigator.clipboard
        .writeText(payload)
        .then(() => setCopyStatus(`Copied ${Object.keys(items).length} items at ${new Date().toLocaleTimeString()}`))
        .catch(() => setCopyStatus('Could not copy to clipboard'))
    } else {
      setCopyStatus('Clipboard not available in this browser')
    }
  }, [items, packetId])

  if (paramPacketId !== packetId) {
    return <p className="error-text">Packet id mismatch in URL ({paramPacketId} vs {packetId}).</p>
  }

  const categoryLabels = detail.replacementCategoryLabels ?? {}
  const visualSection = sections.find((s) => s.prefix === 'visual')
  const headlineSection = sections.find((s) => s.prefix === 'headline')
  const longHeadlineSection = sections.find((s) => s.prefix === 'long-headline')
  const descriptionSection = sections.find((s) => s.prefix === 'description')
  const templateSection = sections.find((s) => s.prefix === 'template-family')
  const textMapSection = sections.find((s) => s.prefix === 'text-map')

  return (
    <div className="policy-replacement-review">
      <header className="hero">
        <p className="eyebrow">
          Report-driven review packet · packet id <code>{packetId}</code>
        </p>
        <h1>Policy-limited asset replacement plan</h1>
        <p className="hero-lede">
          Server-persisted reviewer draft. Helios does not mutate Google Ads from this surface; only items with
          decision <code>accepted</code> flow into the narrow post-review Google Ads resolver pass.
        </p>
        <div className="controls-bar">
          <button type="button" onClick={() => applyBulkDecision('accepted')}>Accept all visible</button>
          <button type="button" onClick={() => applyBulkDecision('hold')}>Hold all visible</button>
          <button type="button" onClick={exportStateJson}>Export review state JSON</button>
          <span className="muted">
            {`${decisionCounts.accepted} accepted · ${decisionCounts.rejected} rejected · ${decisionCounts.hold} hold · ${decisionCounts.unreviewed} unreviewed of ${summary.itemIdCount}`}
          </span>
        </div>
      </header>

      <main className="review-main">
        <section id="section-submit" className="panel">
          <h2>How to submit your review state</h2>
          <p className="muted">
            Edits autosave to the local Helios service every couple of seconds. Click <strong>Submit review</strong>{' '}
            to mark the current state as the submitted draft. The post-review apply step only acts on items
            whose decision is <code>accepted</code>.
          </p>
          <div className="controls-bar">
            <button
              type="button"
              disabled={isSubmitting}
              onClick={() => {
                void performSave(true)
              }}
            >
              {isSubmitting ? 'Submitting…' : 'Submit review'}
            </button>
            <button type="button" onClick={copyStateForAmp}>Copy review state for Amp</button>
            <span className={`pill ${submittedAt ? 'good' : 'warning'}`}>
              {submittedAt ? 'submitted' : 'in review'}
            </span>
            <span className="muted">
              {isSaving
                ? 'Saving…'
                : statusMessage || (savedAt ? `Saved at ${savedAt}` : 'No saved draft yet.')}
              {submittedAt ? ` · Submitted at ${submittedAt}` : ''}
            </span>
            <span className="muted">{copyStatus}</span>
          </div>
          {errorMessage ? <p className="error-text">{errorMessage}</p> : null}
        </section>

        {detail.summary ? (
          <section id="section-overview" className="panel">
            <h2>Overview</h2>
            <div className="grid summary-grid">
              {typeof detail.summary.reportRows === 'number' ? (
                <div className="metric"><strong>{formatNumber(detail.summary.reportRows)}</strong><span>report rows parsed</span></div>
              ) : null}
              {typeof detail.summary.limitedAssociations === 'number' ? (
                <div className="metric"><strong>{formatNumber(detail.summary.limitedAssociations)}</strong><span>limited associations</span></div>
              ) : null}
              {typeof detail.summary.limitedVisualAssociations === 'number' ? (
                <div className="metric"><strong>{formatNumber(detail.summary.limitedVisualAssociations)}</strong><span>limited logo/image associations</span></div>
              ) : null}
              {typeof detail.summary.uniqueLimitedVisualAssets === 'number' ? (
                <div className="metric"><strong>{formatNumber(detail.summary.uniqueLimitedVisualAssets)}</strong><span>unique limited visual assets</span></div>
              ) : null}
              {typeof detail.summary.limitedTextAssociations === 'number' ? (
                <div className="metric"><strong>{formatNumber(detail.summary.limitedTextAssociations)}</strong><span>limited text associations</span></div>
              ) : null}
              {typeof detail.summary.uniqueLimitedTexts === 'number' ? (
                <div className="metric"><strong>{formatNumber(detail.summary.uniqueLimitedTexts)}</strong><span>unique limited texts</span></div>
              ) : null}
            </div>
            {detail.summary.visualAssociationsByType ? (
              <p className="muted">
                <strong>Visuals by type:</strong> {formatRecordEntries(detail.summary.visualAssociationsByType)}
              </p>
            ) : null}
            {detail.summary.limitedTextAssociationsByType ? (
              <p className="muted">
                <strong>Limited text by type:</strong>{' '}
                {formatRecordEntries(detail.summary.limitedTextAssociationsByType)}
              </p>
            ) : null}
          </section>
        ) : null}

        {detail.applyPlan.length > 0 ? (
          <section id="section-apply-gates" className="panel">
            <h2>Apply gates after review</h2>
            <ol>
              {detail.applyPlan.map((step, index) => (
                <li key={index}>{step}</li>
              ))}
            </ol>
          </section>
        ) : null}

        {(detail.llmSafePatterns.length > 0 || detail.llmRiskPatterns.length > 0) ? (
          <section id="section-llm-patterns" className="panel">
            <h2>LLM pattern read</h2>
            <div className="grid two">
              {detail.llmSafePatterns.length > 0 ? (
                <div>
                  <h3>Safer patterns</h3>
                  <ul>
                    {detail.llmSafePatterns.map((pattern, index) => (
                      <li key={index}>{pattern}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {detail.llmRiskPatterns.length > 0 ? (
                <div>
                  <h3>Risk patterns to avoid</h3>
                  <ul>
                    {detail.llmRiskPatterns.map((pattern, index) => (
                      <li key={index}>{pattern}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>
          </section>
        ) : null}

        {visualSection ? (
          <section id={sectionAnchorId('visual')} className="panel">
            <h2>{visualSection.longLabel} <span className="muted">({visualSection.count})</span></h2>
            <p className="muted">Every limited Logo or Image asset in the uploaded report is covered here.</p>
            {visualSection.count === 0 ? (
              <p className="muted">No items in this category.</p>
            ) : (
              <div className="grid copy-grid">
                {Array.from({ length: visualSection.count }, (_v, index) => {
                  const itemId = buildItemId('visual', index + 1)
                  const state = items[itemId] ?? EMPTY_STATE
                  return (
                    <VisualCard
                      key={itemId}
                      itemId={itemId}
                      index={index}
                      plan={detail.visualReplacementPlans[index]}
                      state={state}
                      setDecision={setDecision}
                      setField={setField}
                    />
                  )
                })}
              </div>
            )}
          </section>
        ) : null}

        {([
          { section: headlineSection, prefix: 'headline', label: 'Headline', list: detail.headlines },
          { section: longHeadlineSection, prefix: 'long-headline', label: 'Long headline', list: detail.longHeadlines },
          { section: descriptionSection, prefix: 'description', label: 'Description', list: detail.descriptions },
        ] as const).map(({ section, prefix, label, list }) =>
          section ? (
            <section key={prefix} id={sectionAnchorId(prefix)} className="panel">
              <h2>{section.longLabel} <span className="muted">({section.count})</span></h2>
              {section.count === 0 ? (
                <p className="muted">No items in this category.</p>
              ) : (
                <VirtualizedCardList
                  count={section.count}
                  getKey={(index) => buildItemId(prefix, index + 1)}
                  renderItem={(index) => {
                    const itemId = buildItemId(prefix, index + 1)
                    const state = items[itemId] ?? EMPTY_STATE
                    return (
                      <CopyCard
                        itemId={itemId}
                        label={label}
                        index={index}
                        entry={list[index]}
                        state={state}
                        setDecision={setDecision}
                        setField={setField}
                      />
                    )
                  }}
                />
              )}
            </section>
          ) : null,
        )}

        {templateSection ? (
          <section id={sectionAnchorId('template-family')} className="panel">
            <h2>{templateSection.longLabel} <span className="muted">({templateSection.count})</span></h2>
            <p className="muted">
              These are reviewable source templates. If a mapping selects a category backed by one of these
              templates, edits and Accept / Reject / Hold status cascade into the mapping table.
            </p>
            {templateSection.count === 0 ? (
              <p className="muted">No items in this category.</p>
            ) : (
              <VirtualizedCardList
                count={templateSection.count}
                getKey={(index) => buildItemId('template-family', index + 1)}
                renderItem={(index) => {
                  const itemId = buildItemId('template-family', index + 1)
                  const state = items[itemId] ?? EMPTY_STATE
                  return (
                    <TemplateFamilyCard
                      itemId={itemId}
                      index={index}
                      entry={detail.templateFamilies[index]}
                      state={state}
                      setDecision={setDecision}
                      setField={setField}
                    />
                  )
                }}
              />
            )}
          </section>
        ) : null}

        {textMapSection ? (
          <section id={sectionAnchorId('text-map')} className="panel">
            <h2>{textMapSection.longLabel} <span className="muted">({textMapSection.count})</span></h2>
            <p className="muted">
              This is the full current-limited-text to proposed-replacement mapping for every unique limited text
              asset in the uploaded report. Pick one of the replacement categories per row. The proposed
              replacement textarea is sourced from the selected category's reviewable asset/template; rows tint
              light green / red / yellow when the selected source is accepted / rejected / held, and the column-1
              indicator reflects the mapping's own decision.
            </p>
            {textMapSection.count === 0 ? (
              <p className="muted">No items in this category.</p>
            ) : (
              <MappingTable
                textMapCount={textMapSection.count}
                mappings={detail.textReplacementMappings}
                categoryLabels={categoryLabels}
                items={items}
                detail={detail}
                setDecision={setDecision}
                setField={setField}
                pickMappingCategory={pickMappingCategory}
              />
            )}
          </section>
        ) : null}

        {(detail.anchorExamples.eligible.length > 0 || detail.anchorExamples.limited.length > 0) ? (
          <section id="section-anchors" className="panel">
            <h2>LLM anchors</h2>
            <p className="muted">
              Reference examples that anchored the LLM-assisted copy generation. These items are not
              individually reviewable — they are shown for context only.
            </p>
            {detail.anchorExamples.eligible.length > 0 ? (
              <details>
                <summary>{`Eligible examples (${detail.anchorExamples.eligible.length})`}</summary>
                <ul className="anchor-list">
                  {detail.anchorExamples.eligible.map((entry, index) => (
                    <li key={`elig-${index}`}>
                      <span className="mini">{entry.assetType ?? 'Asset'}</span> {entry.text ?? ''}{' '}
                      <span className="muted">
                        ({entry.level ?? 'unknown'}
                        {typeof entry.impressions === 'number' ? `, ${formatNumber(entry.impressions)} impressions` : ''})
                      </span>
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}
            {detail.anchorExamples.limited.length > 0 ? (
              <details>
                <summary>{`Limited examples (${detail.anchorExamples.limited.length})`}</summary>
                <ul className="anchor-list">
                  {detail.anchorExamples.limited.map((entry, index) => (
                    <li key={`lim-${index}`}>
                      <span className="mini">{entry.assetType ?? 'Asset'}</span> {entry.text ?? ''}{' '}
                      <span className="muted">
                        ({entry.level ?? 'unknown'}
                        {typeof entry.impressions === 'number' ? `, ${formatNumber(entry.impressions)} impressions` : ''})
                      </span>
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}
          </section>
        ) : null}
      </main>
    </div>
  )
}
