/**
 * Generic proposal review layout component.
 *
 * Provides the standard review interface with:
 * - Filter bar
 * - Hierarchy navigation
 * - Row table with selection
 * - Detail panel
 * - Bulk actions bar
 */

import { type ReactNode, useState } from 'react'
import type { ProposalReviewResponse, UiProposalRow, ProposalReviewFilters } from '../../../shared/contracts/ui/proposalReview.js'

export interface ProposalReviewLayoutConfig {
  title: string
  description: string
  batchTypeLabel: string
  enableHierarchyNav?: boolean
  enableBulkActions?: boolean
  customFilters?: ReactNode
}

export interface ProposalReviewLayoutProps {
  config: ProposalReviewLayoutConfig
  data: ProposalReviewResponse
  filters: ProposalReviewFilters
  onFiltersChange: (filters: ProposalReviewFilters) => void
  selectedRowIds: number[]
  onSelectionChange: (rowIds: number[]) => void
  activeRowId: number | null
  onActiveRowChange: (rowId: number | null) => void
  children: {
    rowTable: ReactNode
    detailPanel: ReactNode
    bulkActionsBar?: ReactNode
    hierarchyNav?: ReactNode
  }
}

export function ProposalReviewLayout({
  config,
  data,
  filters,
  onFiltersChange,
  selectedRowIds,
  onSelectionChange,
  activeRowId,
  onActiveRowChange,
  children,
}: ProposalReviewLayoutProps) {
  const [showHierarchy, setShowHierarchy] = useState(config.enableHierarchyNav ?? false)

  const handleToggleSelectAll = () => {
    if (selectedRowIds.length === data.rows.length) {
      onSelectionChange([])
    } else {
      onSelectionChange(data.rows.map((row) => row.id))
    }
  }

  const allSelected = data.rows.length > 0 && selectedRowIds.length === data.rows.length

  return (
    <section className="proposal-review-container">
      <div className="page-header">
        <div>
          <p className="eyebrow">{config.batchTypeLabel}</p>
          <h2>{config.title}</h2>
          <p className="subtle-copy">{config.description}</p>
        </div>
        <div className="page-header-stats">
          <div className="stat-card">
            <span className="stat-label">Total</span>
            <span className="stat-value">{data.summary.totalLineItems}</span>
          </div>
          <div className="stat-card">
            <span className="stat-label">Pending</span>
            <span className="stat-value">{data.summary.pendingCount}</span>
          </div>
          <div className="stat-card">
            <span className="stat-label">Approved</span>
            <span className="stat-value success-text">{data.summary.approvedCount}</span>
          </div>
          {data.summary.rejectedCount > 0 && (
            <div className="stat-card">
              <span className="stat-label">Rejected</span>
              <span className="stat-value danger-text">{data.summary.rejectedCount}</span>
            </div>
          )}
        </div>
      </div>

      <div className="filter-bar">
        <input
          defaultValue={filters.search ?? ''}
          name="search"
          placeholder="Search..."
          onChange={(e) => onFiltersChange({ ...filters, search: e.target.value })}
        />
        <select
          defaultValue={filters.approvalStatus ?? ''}
          name="approvalStatus"
          onChange={(e) => onFiltersChange({ ...filters, approvalStatus: e.target.value as ProposalReviewFilters['approvalStatus'] })}
        >
          <option value="">All statuses</option>
          <option value="pending">Pending</option>
          <option value="approved">Approved</option>
          <option value="rejected">Rejected</option>
        </select>
        {config.customFilters}
        {config.enableHierarchyNav && (
          <button
            className="ghost-button"
            onClick={() => setShowHierarchy(!showHierarchy)}
            type="button"
          >
            {showHierarchy ? 'Hide' : 'Show'} hierarchy
          </button>
        )}
      </div>

      {config.enableBulkActions && children.bulkActionsBar}

      <div className={`proposal-review-layout ${showHierarchy ? 'with-hierarchy' : ''}`}>
        {showHierarchy && config.enableHierarchyNav && children.hierarchyNav && (
          <aside className="hierarchy-nav-panel detail-panel">
            {children.hierarchyNav}
          </aside>
        )}

        <div className="proposal-review-main">
          <div className="detail-panel">
            <div className="selection-bar">
              <label className="inline-row">
                <input
                  checked={allSelected}
                  onChange={handleToggleSelectAll}
                  type="checkbox"
                />
                <span>{selectedRowIds.length} selected</span>
              </label>
            </div>
            {children.rowTable}
          </div>

          <aside className="detail-panel proposal-detail-panel">
            {children.detailPanel}
          </aside>
        </div>
      </div>
    </section>
  )
}
