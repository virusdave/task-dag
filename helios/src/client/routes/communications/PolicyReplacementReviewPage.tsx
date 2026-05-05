import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLoaderData, useParams } from 'react-router-dom'

import {
  POLICY_REPLACEMENT_CATEGORIES,
  POLICY_REPLACEMENT_DECISIONS,
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
import { Pill } from '../../components/Pill.js'
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
      longLabel: 'Visual replacement plans',
      count: summary.categories.visualReplacementPlans,
    },
    { prefix: 'headline', typeLabel: 'Headlines', longLabel: 'Headlines', count: summary.categories.headlines },
    {
      prefix: 'long-headline',
      typeLabel: 'Long headlines',
      longLabel: 'Long headlines',
      count: summary.categories.longHeadlines,
    },
    {
      prefix: 'description',
      typeLabel: 'Descriptions',
      longLabel: 'Descriptions',
      count: summary.categories.descriptions,
    },
    {
      prefix: 'template-family',
      typeLabel: 'Template families',
      longLabel: 'Template families',
      count: summary.categories.templateFamilies,
    },
    {
      prefix: 'text-map',
      typeLabel: 'Text replacement mappings',
      longLabel: 'Text replacement mappings',
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

const DECISION_TONE: Record<PolicyReplacementDecision, 'success' | 'danger' | 'warning' | 'muted'> = {
  accepted: 'success',
  rejected: 'danger',
  hold: 'warning',
  unreviewed: 'muted',
}

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

interface DecisionRowProps {
  itemId: string
  decision: PolicyReplacementDecision
  onChange: (next: PolicyReplacementDecision) => void
}

function DecisionRow({ itemId, decision, onChange }: DecisionRowProps) {
  return (
    <div className="inline-row wrap-row" role="group" aria-label="Review decision">
      {POLICY_REPLACEMENT_DECISIONS.map((option) => (
        <label key={option} className="inline-row">
          <input
            type="radio"
            name={`decision-${itemId}`}
            checked={decision === option}
            onChange={() => onChange(option)}
          />
          <span>{option}</span>
        </label>
      ))}
      <Pill tone={DECISION_TONE[decision]}>{decision}</Pill>
    </div>
  )
}

interface NoteFieldProps {
  itemId: string
  value: string
  placeholder?: string
  onChange: (value: string) => void
}

function NoteField({ itemId, value, placeholder, onChange }: NoteFieldProps) {
  return (
    <label className="stack-field" htmlFor={`note-${itemId}`}>
      <span>Reviewer note</span>
      <textarea
        id={`note-${itemId}`}
        rows={2}
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.currentTarget.value)}
      />
    </label>
  )
}

interface VisualCardProps {
  itemId: string
  index: number
  plan: VisualReplacementPlanDetail | undefined
  state: PolicyReplacementItemState
  onDecision: (decision: PolicyReplacementDecision) => void
  onField: (key: keyof PolicyReplacementItemFields, value: string) => void
}

function VisualCard({ itemId, index, plan, state, onDecision, onField }: VisualCardProps) {
  if (!plan) {
    return (
      <div className="detail-panel" style={{ marginTop: '0.5rem' }}>
        <p className="error-text">Visual {index + 1} ({itemId}) is missing from the packet detail payload.</p>
      </div>
    )
  }
  const associationCount = plan.associationCount ?? 0
  return (
    <div className="detail-panel" style={{ marginTop: '0.5rem' }} id={`item-${itemId}`}>
      <header className="page-header">
        <div>
          <p className="eyebrow">{plan.assetType ?? 'Visual'}</p>
          <strong>{itemId}</strong>
        </div>
        <Pill tone={associationCount > 0 ? 'warning' : 'muted'}>
          {`${formatNumber(associationCount)} associations`}
        </Pill>
      </header>
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
      {plan.applyInstruction ? <p className="subtle-copy">{plan.applyInstruction}</p> : null}
      <p className="subtle-copy">
        {plan.impressions !== undefined ? `Impressions: ${formatNumber(plan.impressions)}` : null}
        {plan.statusReasons ? ` · ${formatRecordEntries(plan.statusReasons)}` : null}
        {plan.levels ? ` · Levels — ${formatRecordEntries(plan.levels)}` : null}
      </p>
      <DecisionRow itemId={itemId} decision={state.decision} onChange={onDecision} />
      <NoteField
        itemId={itemId}
        value={state.fields.note ?? ''}
        placeholder="Reviewer note for this visual replacement"
        onChange={(value) => onField('note', value)}
      />
    </div>
  )
}

interface CopyCardProps {
  itemId: string
  label: string
  index: number
  entry: CopyEntryDetail | undefined
  state: PolicyReplacementItemState
  onDecision: (decision: PolicyReplacementDecision) => void
  onField: (key: keyof PolicyReplacementItemFields, value: string) => void
}

function CopyCard({ itemId, label, index, entry, state, onDecision, onField }: CopyCardProps) {
  if (!entry) {
    return (
      <div className="detail-panel" style={{ marginTop: '0.5rem' }}>
        <p className="error-text">{label} {index + 1} ({itemId}) is missing from the packet detail payload.</p>
      </div>
    )
  }
  // Edited replacement text is what flows into the resolver/apply step.
  // Default to the packet's source text if the reviewer has not edited it.
  const sourceText = entry.text ?? ''
  const editedText = state.fields.text ?? sourceText
  return (
    <div className="detail-panel" style={{ marginTop: '0.5rem' }} id={`item-${itemId}`}>
      <header className="page-header">
        <div>
          <p className="eyebrow">{`${label} ${index + 1}`}</p>
          <strong>{itemId}</strong>
        </div>
        <span className="subtle-copy">{`${editedText.length} chars`}</span>
      </header>
      <label className="stack-field" htmlFor={`text-${itemId}`}>
        <span>Replacement text</span>
        <textarea
          id={`text-${itemId}`}
          rows={2}
          value={editedText}
          onChange={(event) => onField('text', event.currentTarget.value)}
        />
      </label>
      <p className="subtle-copy">
        {entry.use ? <strong>Use:</strong> : null} {entry.use ?? null}
        {entry.use && entry.whySafer ? ' · ' : ''}
        {entry.whySafer ? <em>{entry.whySafer}</em> : null}
        {entry.source ? ` · ${entry.source}` : null}
      </p>
      <DecisionRow itemId={itemId} decision={state.decision} onChange={onDecision} />
      <NoteField
        itemId={itemId}
        value={state.fields.note ?? ''}
        onChange={(value) => onField('note', value)}
      />
    </div>
  )
}

interface TemplateFamilyCardProps {
  itemId: string
  index: number
  entry: TemplateFamilyDetail | undefined
  state: PolicyReplacementItemState
  onDecision: (decision: PolicyReplacementDecision) => void
  onField: (key: keyof PolicyReplacementItemFields, value: string) => void
}

function TemplateFamilyCard({ itemId, index, entry, state, onDecision, onField }: TemplateFamilyCardProps) {
  if (!entry) {
    return (
      <div className="detail-panel" style={{ marginTop: '0.5rem' }}>
        <p className="error-text">Template family {index + 1} ({itemId}) is missing from the packet detail payload.</p>
      </div>
    )
  }
  const sourceText = entry.template ?? ''
  const editedText = state.fields.text ?? sourceText
  return (
    <div className="detail-panel" style={{ marginTop: '0.5rem' }} id={`item-${itemId}`}>
      <header className="page-header">
        <div>
          <p className="eyebrow">{`Template family ${index + 1}${entry.fieldType ? ` · ${entry.fieldType}` : ''}`}</p>
          <strong>{itemId}</strong>
        </div>
        <span className="subtle-copy">{`${editedText.length} chars`}</span>
      </header>
      <label className="stack-field" htmlFor={`text-${itemId}`}>
        <span>Template (use placeholders like {'{location}'})</span>
        <textarea
          id={`text-${itemId}`}
          rows={2}
          value={editedText}
          onChange={(event) => onField('text', event.currentTarget.value)}
        />
      </label>
      <p className="subtle-copy">
        {entry.use ? <strong>Use:</strong> : null} {entry.use ?? null}
        {entry.use && entry.whySafer ? ' · ' : ''}
        {entry.whySafer ? <em>{entry.whySafer}</em> : null}
        {entry.source ? ` · ${entry.source}` : null}
      </p>
      <DecisionRow itemId={itemId} decision={state.decision} onChange={onDecision} />
      <NoteField
        itemId={itemId}
        value={state.fields.note ?? ''}
        onChange={(value) => onField('note', value)}
      />
    </div>
  )
}

interface TextMapCardProps {
  itemId: string
  mapping: TextReplacementMappingDetail | undefined
  categoryLabels: Record<string, string>
  state: PolicyReplacementItemState
  onDecision: (decision: PolicyReplacementDecision) => void
  onField: (key: keyof PolicyReplacementItemFields, value: string) => void
  onPickCategory: (category: PolicyReplacementCategory | '', sourceId: string | null) => void
}

function TextMapCard({
  itemId,
  mapping,
  categoryLabels,
  state,
  onDecision,
  onField,
  onPickCategory,
}: TextMapCardProps) {
  if (!mapping) {
    return (
      <div className="detail-panel" style={{ marginTop: '0.5rem' }}>
        <p className="error-text">Mapping {itemId} is missing from the packet detail payload.</p>
      </div>
    )
  }
  const proposedReplacement = mapping.proposedReplacement ?? ''
  const editedText = state.fields.text ?? proposedReplacement
  const defaultCategoryRaw: string = (mapping.defaultReplacementCategory ?? '') as string
  const selectedCategory: string = state.fields.replacementCategory ?? defaultCategoryRaw
  const selectedSourceId = state.fields.sourceId ?? ''
  return (
    <div className="detail-panel" style={{ marginTop: '0.5rem' }} id={`item-${itemId}`}>
      <header className="page-header">
        <div>
          <p className="eyebrow">{mapping.assetType ?? 'Mapping'}</p>
          <strong>{itemId}</strong>
        </div>
        <Pill tone="muted">{`${formatNumber(mapping.associationCount ?? 0)} associations`}</Pill>
      </header>
      {mapping.currentText ? (
        <p>
          <strong>Current limited text:</strong> <code>{mapping.currentText}</code>
        </p>
      ) : null}
      <p className="subtle-copy">
        {mapping.impressions !== undefined ? `Impressions: ${formatNumber(mapping.impressions)}` : null}
        {mapping.statusReasons ? ` · ${formatRecordEntries(mapping.statusReasons)}` : null}
        {mapping.levels ? ` · Levels — ${formatRecordEntries(mapping.levels)}` : null}
        {mapping.replacementSource ? ` · Source: ${mapping.replacementSource}` : null}
        {selectedSourceId ? ` · Selected source id: ${selectedSourceId}` : null}
      </p>
      <label className="stack-field" htmlFor={`text-${itemId}`}>
        <span>Proposed replacement text</span>
        <textarea
          id={`text-${itemId}`}
          rows={2}
          value={editedText}
          onChange={(event) => onField('text', event.currentTarget.value)}
        />
      </label>
      {mapping.whySafer ? <p className="subtle-copy"><em>{mapping.whySafer}</em></p> : null}
      {mapping.replacementOptions.length > 0 ? (
        <div className="inline-row wrap-row">
          <span className="subtle-copy">Replacement category</span>
          <label className="inline-row">
            <input
              type="radio"
              name={`cat-${itemId}`}
              checked={!selectedCategory}
              onChange={() => onPickCategory('', null)}
            />
            <span>none</span>
          </label>
          {mapping.replacementOptions.map((option) => (
            <label key={option.category} className="inline-row" title={`Sourced from ${option.sourceId}`}>
              <input
                type="radio"
                name={`cat-${itemId}`}
                checked={selectedCategory === option.category}
                onChange={() => onPickCategory(option.category, option.sourceId)}
              />
              <span>{categoryLabels[option.category] ?? option.label}</span>
            </label>
          ))}
        </div>
      ) : (
        <div className="inline-row wrap-row">
          <span className="subtle-copy">Replacement category</span>
          <label className="inline-row">
            <input
              type="radio"
              name={`cat-${itemId}`}
              checked={!selectedCategory}
              onChange={() => onPickCategory('', null)}
            />
            <span>none</span>
          </label>
          {POLICY_REPLACEMENT_CATEGORIES.map((category) => (
            <label key={category} className="inline-row">
              <input
                type="radio"
                name={`cat-${itemId}`}
                checked={selectedCategory === category}
                onChange={() => onPickCategory(category, null)}
              />
              <span>{categoryLabels[category] ?? category}</span>
            </label>
          ))}
        </div>
      )}
      <label className="stack-field" htmlFor={`source-${itemId}`}>
        <span>Source asset id (optional override)</span>
        <input
          id={`source-${itemId}`}
          type="text"
          value={state.fields.sourceId ?? ''}
          onChange={(event) => onField('sourceId', event.currentTarget.value)}
        />
      </label>
      <DecisionRow itemId={itemId} decision={state.decision} onChange={onDecision} />
      <NoteField
        itemId={itemId}
        value={state.fields.note ?? ''}
        onChange={(value) => onField('note', value)}
      />
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

  const initialActiveType = sections[0]?.typeLabel ?? 'Assets'
  const [activeType, setActiveType] = useState<string>(initialActiveType)

  // Scroll-spy: track the section nearest the viewport top so the page
  // header breadcrumb can update its `<TYPE>` tail as the reviewer scrolls.
  useEffect(() => {
    function onScroll() {
      let bestPrefix: string | null = null
      let bestDelta = Number.POSITIVE_INFINITY
      for (const section of sections) {
        const element = document.getElementById(sectionAnchorId(section.prefix))
        if (!element) {
          continue
        }
        const rect = element.getBoundingClientRect()
        const distance = Math.abs(rect.top - 80)
        if (rect.top - 80 <= 0 && distance < bestDelta) {
          bestDelta = distance
          bestPrefix = section.prefix
        }
      }
      if (!bestPrefix && sections[0]) {
        bestPrefix = sections[0].prefix
      }
      if (bestPrefix) {
        const matched = sections.find((s) => s.prefix === bestPrefix)
        if (matched) {
          setActiveType(matched.typeLabel)
        }
      }
    }
    window.addEventListener('scroll', onScroll, { passive: true })
    onScroll()
    return () => window.removeEventListener('scroll', onScroll)
  }, [sections])

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

  if (paramPacketId !== packetId) {
    return <p className="error-text">Packet id mismatch in URL ({paramPacketId} vs {packetId}).</p>
  }

  const breadcrumbCrumbs = ['Ads', 'Review', 'Assets', activeType]
  const categoryLabels = detail.replacementCategoryLabels ?? {}

  return (
    <section>
      <div className="page-header">
        <div>
          <p className="eyebrow">{breadcrumbCrumbs.join(' \u203A ')}</p>
          <h2>{packetId}</h2>
          <p className="subtle-copy">
            Server-persisted reviewer draft. Helios does not mutate Google Ads from this surface; only items with
            decision <code>accepted</code> flow into the narrow post-review Google Ads resolver pass.
          </p>
        </div>
        <Pill tone={submittedAt ? 'success' : 'warning'}>{submittedAt ? 'submitted' : 'in review'}</Pill>
      </div>

      <div className="inline-row wrap-row">
        <Pill tone="muted">{`${summary.itemIdCount} items`}</Pill>
        <Pill tone="success">{`accepted ${decisionCounts.accepted}`}</Pill>
        <Pill tone="danger">{`rejected ${decisionCounts.rejected}`}</Pill>
        <Pill tone="warning">{`hold ${decisionCounts.hold}`}</Pill>
        <Pill tone="muted">{`unreviewed ${decisionCounts.unreviewed}`}</Pill>
      </div>

      <div className="inline-row wrap-row" style={{ marginTop: '0.75rem' }}>
        <button
          type="button"
          disabled={isSubmitting}
          onClick={() => {
            void performSave(true)
          }}
        >
          {isSubmitting ? 'Submitting…' : 'Submit review'}
        </button>
        <span className="subtle-copy">
          {isSaving ? 'Saving…' : statusMessage || (savedAt ? `Saved at ${savedAt}` : 'No saved draft yet.')}
          {submittedAt ? ` · Submitted at ${submittedAt}` : ''}
        </span>
      </div>

      {errorMessage ? <p className="error-text">{errorMessage}</p> : null}

      {detail.summary ? (
        <article className="detail-panel" style={{ marginTop: '0.75rem' }} id="section-overview">
          <h3>Overview</h3>
          <div className="inline-row wrap-row">
            {typeof detail.summary.reportRows === 'number' ? (
              <Pill tone="muted">{`${formatNumber(detail.summary.reportRows)} report rows`}</Pill>
            ) : null}
            {typeof detail.summary.limitedAssociations === 'number' ? (
              <Pill tone="warning">{`${formatNumber(detail.summary.limitedAssociations)} limited associations`}</Pill>
            ) : null}
            {typeof detail.summary.limitedVisualAssociations === 'number' ? (
              <Pill tone="muted">{`${formatNumber(detail.summary.limitedVisualAssociations)} limited visual associations`}</Pill>
            ) : null}
            {typeof detail.summary.uniqueLimitedVisualAssets === 'number' ? (
              <Pill tone="muted">{`${formatNumber(detail.summary.uniqueLimitedVisualAssets)} unique limited visual assets`}</Pill>
            ) : null}
            {typeof detail.summary.limitedTextAssociations === 'number' ? (
              <Pill tone="muted">{`${formatNumber(detail.summary.limitedTextAssociations)} limited text associations`}</Pill>
            ) : null}
            {typeof detail.summary.uniqueLimitedTexts === 'number' ? (
              <Pill tone="muted">{`${formatNumber(detail.summary.uniqueLimitedTexts)} unique limited texts`}</Pill>
            ) : null}
          </div>
          {detail.summary.visualAssociationsByType ? (
            <p className="subtle-copy">
              <strong>Visuals by type:</strong> {formatRecordEntries(detail.summary.visualAssociationsByType)}
            </p>
          ) : null}
          {detail.summary.limitedTextAssociationsByType ? (
            <p className="subtle-copy">
              <strong>Limited text by type:</strong>{' '}
              {formatRecordEntries(detail.summary.limitedTextAssociationsByType)}
            </p>
          ) : null}
        </article>
      ) : null}

      {detail.applyPlan.length > 0 ? (
        <article className="detail-panel" style={{ marginTop: '0.75rem' }} id="section-apply-gates">
          <h3>Apply gates after review</h3>
          <ol>
            {detail.applyPlan.map((step, index) => (
              <li key={index}>{step}</li>
            ))}
          </ol>
        </article>
      ) : null}

      {detail.llmSafePatterns.length > 0 || detail.llmRiskPatterns.length > 0 ? (
        <article className="detail-panel" style={{ marginTop: '0.75rem' }} id="section-llm-patterns">
          <h3>LLM pattern read</h3>
          <div className="inline-row wrap-row" style={{ alignItems: 'flex-start', gap: '1.5rem' }}>
            {detail.llmSafePatterns.length > 0 ? (
              <div>
                <strong>Safer patterns</strong>
                <ul>
                  {detail.llmSafePatterns.map((pattern, index) => (
                    <li key={index}>{pattern}</li>
                  ))}
                </ul>
              </div>
            ) : null}
            {detail.llmRiskPatterns.length > 0 ? (
              <div>
                <strong>Risk patterns to avoid</strong>
                <ul>
                  {detail.llmRiskPatterns.map((pattern, index) => (
                    <li key={index}>{pattern}</li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        </article>
      ) : null}

      <div style={{ marginTop: '1rem' }}>
        <div className="review-content">
          {sections.map((section) => (
            <article
              key={section.prefix}
              id={sectionAnchorId(section.prefix)}
              className="detail-panel"
              style={{ marginTop: '0.5rem' }}
            >
              <header className="page-header">
                <h3>
                  {section.longLabel} <span className="subtle-copy">({section.count})</span>
                </h3>
              </header>
              {section.count === 0 ? (
                <p className="subtle-copy">No items in this category.</p>
              ) : null}
              {Array.from({ length: section.count }, (_value, index) => {
                const itemId = buildItemId(section.prefix, index + 1)
                const state = items[itemId] ?? EMPTY_STATE
                const onDecision = (decision: PolicyReplacementDecision) => setDecision(itemId, decision)
                const onField = (key: keyof PolicyReplacementItemFields, value: string) => setField(itemId, key, value)
                if (section.prefix === 'visual') {
                  return (
                    <VisualCard
                      key={itemId}
                      itemId={itemId}
                      index={index}
                      plan={detail.visualReplacementPlans[index]}
                      state={state}
                      onDecision={onDecision}
                      onField={onField}
                    />
                  )
                }
                if (section.prefix === 'headline') {
                  return (
                    <CopyCard
                      key={itemId}
                      itemId={itemId}
                      label="Headline"
                      index={index}
                      entry={detail.headlines[index]}
                      state={state}
                      onDecision={onDecision}
                      onField={onField}
                    />
                  )
                }
                if (section.prefix === 'long-headline') {
                  return (
                    <CopyCard
                      key={itemId}
                      itemId={itemId}
                      label="Long headline"
                      index={index}
                      entry={detail.longHeadlines[index]}
                      state={state}
                      onDecision={onDecision}
                      onField={onField}
                    />
                  )
                }
                if (section.prefix === 'description') {
                  return (
                    <CopyCard
                      key={itemId}
                      itemId={itemId}
                      label="Description"
                      index={index}
                      entry={detail.descriptions[index]}
                      state={state}
                      onDecision={onDecision}
                      onField={onField}
                    />
                  )
                }
                if (section.prefix === 'template-family') {
                  return (
                    <TemplateFamilyCard
                      key={itemId}
                      itemId={itemId}
                      index={index}
                      entry={detail.templateFamilies[index]}
                      state={state}
                      onDecision={onDecision}
                      onField={onField}
                    />
                  )
                }
                // section.prefix === 'text-map'
                const mapping = detail.textReplacementMappings.find((entry) => entry.mappingId === itemId)
                return (
                  <TextMapCard
                    key={itemId}
                    itemId={itemId}
                    mapping={mapping}
                    categoryLabels={categoryLabels}
                    state={state}
                    onDecision={onDecision}
                    onField={onField}
                    onPickCategory={(category, sourceId) => pickMappingCategory(itemId, category, sourceId)}
                  />
                )
              })}
            </article>
          ))}
        </div>
      </div>

      {(detail.anchorExamples.eligible.length > 0 || detail.anchorExamples.limited.length > 0) ? (
        <article className="detail-panel" style={{ marginTop: '0.75rem' }} id="section-anchors">
          <h3>LLM anchors</h3>
          <p className="subtle-copy">
            Reference examples that anchored the LLM-assisted copy generation. These items are not
            individually reviewable — they are shown for context only.
          </p>
          {detail.anchorExamples.eligible.length > 0 ? (
            <details>
              <summary>{`Eligible examples (${detail.anchorExamples.eligible.length})`}</summary>
              <ul>
                {detail.anchorExamples.eligible.map((entry, index) => (
                  <li key={`elig-${index}`}>
                    <code>{entry.assetType ?? 'Asset'}</code> — {entry.text ?? ''}{' '}
                    <span className="subtle-copy">
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
              <ul>
                {detail.anchorExamples.limited.map((entry, index) => (
                  <li key={`lim-${index}`}>
                    <code>{entry.assetType ?? 'Asset'}</code> — {entry.text ?? ''}{' '}
                    <span className="subtle-copy">
                      ({entry.level ?? 'unknown'}
                      {typeof entry.impressions === 'number' ? `, ${formatNumber(entry.impressions)} impressions` : ''})
                    </span>
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </article>
      ) : null}
    </section>
  )
}
