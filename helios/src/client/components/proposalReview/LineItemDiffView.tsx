/**
 * Line item diff view component.
 *
 * Shows baseline vs suggested vs edited values for a proposal line item,
 * grouped by field group with appropriate editors.
 */

import type { UiLineItem } from '../../../shared/contracts/ui/proposalReview.js'
import { Pill } from '../Pill.js'

export interface LineItemDiffViewProps {
  lineItems: UiLineItem[]
  onEditValue: (lineItemId: number, value: unknown) => void
  onSaveEdit: (lineItemId: number) => void
  onApprove: (lineItemId: number) => void
  onReject: (lineItemId: number) => void
  isSaving: boolean
}

export function LineItemDiffView({
  lineItems,
  onEditValue,
  onSaveEdit,
  onApprove,
  onReject,
  isSaving,
}: LineItemDiffViewProps) {
  // Group line items by field group
  const groupedItems = lineItems.reduce<Record<string, UiLineItem[]>>((groups, item) => {
    const group = item.field.group
    if (!groups[group]) {
      groups[group] = []
    }
    groups[group].push(item)
    return groups
  }, {})

  return (
    <div className="line-item-diff-view">
      {Object.entries(groupedItems).map(([group, items]) => (
        <div key={group} className="field-group-section">
          <h4 className="field-group-title">{formatGroupLabel(group)}</h4>
          {items.map((item) => (
            <LineItemRow
              key={item.id}
              item={item}
              onEditValue={onEditValue}
              onSaveEdit={onSaveEdit}
              onApprove={onApprove}
              onReject={onReject}
              isSaving={isSaving}
            />
          ))}
        </div>
      ))}
    </div>
  )
}

interface LineItemRowProps {
  item: UiLineItem
  onEditValue: (lineItemId: number, value: unknown) => void
  onSaveEdit: (lineItemId: number) => void
  onApprove: (lineItemId: number) => void
  onReject: (lineItemId: number) => void
  isSaving: boolean
}

function LineItemRow({
  item,
  onEditValue,
  onSaveEdit,
  onApprove,
  onReject,
  isSaving,
}: LineItemRowProps) {
  const hasEdits = item.editedValue !== undefined && item.editedValue !== item.suggestedValue

  return (
    <div className="line-item-row">
      <div className="line-item-header">
        <div>
          <strong>{item.field.label}</strong>
          <span className="subtle-copy"> · {item.field.path}</span>
        </div>
        <Pill tone={getApprovalTone(item.approvalStatus)}>
          {formatApprovalStatus(item.approvalStatus)}
        </Pill>
      </div>

      <div className="value-comparison">
        <div className="value-column">
          <span className="value-label">Baseline</span>
          <div className="value-display">{formatValue(item.baselineValue, item.field.valueType)}</div>
        </div>
        <div className="value-column">
          <span className="value-label">Suggested</span>
          <div className="value-display">{formatValue(item.suggestedValue, item.field.valueType)}</div>
        </div>
        <div className="value-column">
          <span className="value-label">{hasEdits ? 'Edited' : 'Effective'}</span>
          <div className="value-display highlight">
            {formatValue(item.effectiveValue, item.field.valueType)}
          </div>
        </div>
      </div>

      {item.field.editable && item.approvalStatus !== 'approved' && (
        <div className="line-item-editor">
          {renderEditor(item, onEditValue)}
        </div>
      )}

      {item.validationIssues && item.validationIssues.length > 0 && (
        <div className="validation-issues">
          {item.validationIssues.map((issue: any, idx) => (
            <p key={idx} className="error-text">
              {issue.detail ?? String(issue)}
            </p>
          ))}
        </div>
      )}

      {item.notes && (
        <div className="line-item-notes">
          <p className="subtle-copy">{item.notes}</p>
        </div>
      )}

      <div className="line-item-actions">
        {hasEdits && (
          <button
            className="ghost-button"
            disabled={isSaving}
            onClick={() => onSaveEdit(item.id)}
            type="button"
          >
            Save edit
          </button>
        )}
        {item.approvalStatus !== 'approved' && (
          <button
            className="primary-button"
            disabled={isSaving}
            onClick={() => onApprove(item.id)}
            type="button"
          >
            Approve
          </button>
        )}
        {item.approvalStatus !== 'rejected' && (
          <button
            className="danger-button"
            disabled={isSaving}
            onClick={() => onReject(item.id)}
            type="button"
          >
            Reject
          </button>
        )}
      </div>
    </div>
  )
}

function renderEditor(item: UiLineItem, onEditValue: (id: number, value: unknown) => void) {
  switch (item.field.editorComponent) {
    case 'number':
    case 'price':
      return (
        <input
          defaultValue={String(item.effectiveValue ?? '')}
          inputMode="decimal"
          onChange={(e) => onEditValue(item.id, Number(e.target.value))}
          step="0.01"
          type="number"
        />
      )
    case 'text':
      return (
        <input
          defaultValue={String(item.effectiveValue ?? '')}
          onChange={(e) => onEditValue(item.id, e.target.value)}
          type="text"
        />
      )
    case 'textArea':
      return (
        <textarea
          defaultValue={String(item.effectiveValue ?? '')}
          onChange={(e) => onEditValue(item.id, e.target.value)}
          rows={3}
        />
      )
    case 'boolean':
      return (
        <label className="inline-row">
          <input
            defaultChecked={Boolean(item.effectiveValue)}
            onChange={(e) => onEditValue(item.id, e.target.checked)}
            type="checkbox"
          />
          <span>{item.field.label}</span>
        </label>
      )
    case 'pricingLadder':
      return <div className="placeholder-editor">Pricing ladder editor (TODO)</div>
    case 'promoBuilder':
      return <div className="placeholder-editor">Promo builder (TODO)</div>
    case 'attributeEditor':
      return <div className="placeholder-editor">Attribute editor (TODO)</div>
    default:
      return <div className="placeholder-editor">No editor for {item.field.editorComponent}</div>
  }
}

function formatValue(value: unknown, valueType: string): string {
  if (value === null || value === undefined) {
    return '—'
  }

  switch (valueType) {
    case 'price':
      return typeof value === 'number' ? `$${value.toFixed(2)}` : String(value)
    case 'number':
      return typeof value === 'number' ? value.toFixed(2) : String(value)
    case 'boolean':
      return value ? 'Yes' : 'No'
    case 'json':
    case 'pricingLadder':
      return JSON.stringify(value, null, 2)
    default:
      return String(value)
  }
}

function formatGroupLabel(group: string): string {
  return group
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
}

function formatApprovalStatus(status: string): string {
  switch (status) {
    case 'approved':
      return 'Approved'
    case 'rejected':
      return 'Rejected'
    case 'pending':
      return 'Pending'
    default:
      return status
  }
}

function getApprovalTone(status: string): 'success' | 'danger' | 'warning' | 'muted' {
  switch (status) {
    case 'approved':
      return 'success'
    case 'rejected':
      return 'danger'
    case 'pending':
      return 'warning'
    default:
      return 'muted'
  }
}
