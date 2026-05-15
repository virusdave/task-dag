/**
 * MSO Brand annotation panel.
 *
 * Displays and allows editing of MSO brand metadata (MSO status, house brand, etc.)
 * with confirmation for toggling MSO status.
 */

import { useState } from 'react'
import type { MSOBrandAnnotation } from '../../../shared/contracts/ui/proposalReview.js'
import { Pill } from '../Pill.js'

export interface MSOBrandAnnotationPanelProps {
  annotation: MSOBrandAnnotation | null | undefined
  brandName: string
  onUpdate: (annotation: MSOBrandAnnotation) => void
  isSaving: boolean
  editable?: boolean
}

export function MSOBrandAnnotationPanel({
  annotation,
  brandName,
  onUpdate,
  isSaving,
  editable = true,
}: MSOBrandAnnotationPanelProps) {
  const [showConfirm, setShowConfirm] = useState(false)
  const [pendingToggle, setPendingToggle] = useState<'mso' | 'house' | null>(null)

  const isMSOBrand = annotation?.isMSOBrand ?? false
  const isHouseBrand = annotation?.isHouseBrand ?? false

  const handleToggle = (type: 'mso' | 'house') => {
    if (!editable || isSaving) {
      return
    }

    setPendingToggle(type)
    setShowConfirm(true)
  }

  const handleConfirm = () => {
    if (!pendingToggle) {
      return
    }

    const updated: MSOBrandAnnotation = {
      ...annotation,
      isMSOBrand: pendingToggle === 'mso' ? !isMSOBrand : isMSOBrand,
      isHouseBrand: pendingToggle === 'house' ? !isHouseBrand : isHouseBrand,
    }

    onUpdate(updated)
    setShowConfirm(false)
    setPendingToggle(null)
  }

  const handleCancel = () => {
    setShowConfirm(false)
    setPendingToggle(null)
  }

  return (
    <div className="mso-brand-annotation-panel detail-panel">
      <h4>Brand Annotations</h4>

      <div className="annotation-row">
        <div>
          <strong>{brandName}</strong>
          <div className="subtle-copy">MSO and house brand status</div>
        </div>
        <div className="annotation-badges">
          {isMSOBrand && <Pill tone="warning">MSO Brand</Pill>}
          {isHouseBrand && <Pill tone="success">House Brand</Pill>}
          {!isMSOBrand && !isHouseBrand && <Pill tone="muted">Standard Brand</Pill>}
        </div>
      </div>

      {editable && (
        <div className="annotation-controls">
          <button
            className={isMSOBrand ? 'ghost-button' : 'primary-button'}
            disabled={isSaving}
            onClick={() => handleToggle('mso')}
            type="button"
          >
            {isMSOBrand ? 'Remove MSO status' : 'Mark as MSO'}
          </button>
          <button
            className={isHouseBrand ? 'ghost-button' : 'primary-button'}
            disabled={isSaving}
            onClick={() => handleToggle('house')}
            type="button"
          >
            {isHouseBrand ? 'Remove house status' : 'Mark as house brand'}
          </button>
        </div>
      )}

      {showConfirm && (
        <div className="confirmation-dialog">
          <div className="confirmation-content">
            <h5>Confirm brand annotation change</h5>
            <p>
              Are you sure you want to {pendingToggle === 'mso' ? (isMSOBrand ? 'remove MSO status from' : 'mark as MSO') : (isHouseBrand ? 'remove house brand status from' : 'mark as house brand')}{' '}
              <strong>{brandName}</strong>?
            </p>
            {pendingToggle === 'mso' && (
              <p className="subtle-copy">
                MSO brands have special pricing policies and margin requirements.
              </p>
            )}
            <div className="confirmation-actions">
              <button className="ghost-button" onClick={handleCancel} type="button">
                Cancel
              </button>
              <button className="primary-button" onClick={handleConfirm} type="button">
                Confirm
              </button>
            </div>
          </div>
        </div>
      )}

      {annotation?.notes && (
        <div className="annotation-notes">
          <h5>Notes</h5>
          <p className="subtle-copy">{annotation.notes}</p>
        </div>
      )}
    </div>
  )
}
