/**
 * Bulk actions bar for proposal review.
 *
 * Provides controls for bulk approve, reject, and edit operations
 * on selected line items.
 */

import { useState } from 'react'

export interface BulkActionsBarProps {
  selectedCount: number
  onBulkApprove: () => void
  onBulkReject: () => void
  onBulkEdit?: (value: unknown) => void
  isSaving: boolean
  enableBulkEdit?: boolean
  bulkEditPlaceholder?: string
}

export function BulkActionsBar({
  selectedCount,
  onBulkApprove,
  onBulkReject,
  onBulkEdit,
  isSaving,
  enableBulkEdit = false,
  bulkEditPlaceholder = 'New value',
}: BulkActionsBarProps) {
  const [bulkEditValue, setBulkEditValue] = useState('')

  const handleBulkEdit = () => {
    if (!onBulkEdit || !bulkEditValue.trim()) {
      return
    }
    onBulkEdit(bulkEditValue)
    setBulkEditValue('')
  }

  return (
    <div className="detail-panel bulk-action-bar">
      <div>
        <strong>{selectedCount} selected</strong>
        <div className="subtle-copy">
          Use bulk actions for straightforward changes. Rejected items will not be applied.
        </div>
      </div>
      <div className="bulk-action-controls">
        {enableBulkEdit && onBulkEdit && (
          <>
            <input
              onChange={(e) => setBulkEditValue(e.currentTarget.value)}
              placeholder={bulkEditPlaceholder}
              value={bulkEditValue}
            />
            <button
              className="ghost-button"
              disabled={isSaving || selectedCount === 0 || !bulkEditValue.trim()}
              onClick={handleBulkEdit}
              type="button"
            >
              Apply to selected
            </button>
          </>
        )}
        <button
          className="primary-button"
          disabled={isSaving || selectedCount === 0}
          onClick={onBulkApprove}
          type="button"
        >
          Approve selected
        </button>
        <button
          className="danger-button"
          disabled={isSaving || selectedCount === 0}
          onClick={onBulkReject}
          type="button"
        >
          Reject selected
        </button>
      </div>
    </div>
  )
}
