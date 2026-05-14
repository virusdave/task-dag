# Catalog Update Engine - UI Framework

**Status**: Implemented  
**Date**: 2026-05-13

## Overview

Reusable React components for reviewing catalog update proposals. Works with any batch type (pricing, promos, taxonomy, attributes, MSO annotations).

## Components

### ProposalReviewLayout

Main layout component providing the standard review interface.

**Features**:
- Filter bar with search and status filtering
- Optional hierarchy navigation
- Row selection with bulk actions
- Detail panel for active row
- Summary statistics

**Usage**:
```tsx
import { ProposalReviewLayout } from '@/components/proposalReview'

<ProposalReviewLayout
  config={{
    title: 'Review Pricing Changes',
    description: 'Approve or reject proposed prices',
    batchTypeLabel: 'Pricing Review',
    enableHierarchyNav: true,
    enableBulkActions: true,
  }}
  data={proposalData}
  filters={filters}
  onFiltersChange={setFilters}
  selectedRowIds={selectedRowIds}
  onSelectionChange={setSelectedRowIds}
  activeRowId={activeRowId}
  onActiveRowChange={setActiveRowId}
>
  {{
    rowTable: <RowTableComponent />,
    detailPanel: <DetailPanelComponent />,
    bulkActionsBar: <BulkActionsBar />,
    hierarchyNav: <HierarchyTree />,
  }}
</ProposalReviewLayout>
```

### HierarchyTree

Hierarchical navigation tree (site → catalog → brand → item).

**Features**:
- Expandable/collapsible nodes
- Item counts per node
- Selection state
- Filter by hierarchy level

**Usage**:
```tsx
import { HierarchyTree } from '@/components/proposalReview'

<HierarchyTree
  root={hierarchyNodes}
  onNodeSelect={(nodeId, nodeType) => {
    // Filter proposals by selected node
    setFilters({ ...filters, [nodeType + 'Id']: extractId(nodeId) })
  }}
  selectedNodeId={selectedNodeId}
/>
```

**Node Structure**:
```typescript
interface HierarchyNode {
  id: string           // e.g., "site:123" or "brand:456"
  type: 'site' | 'catalog' | 'brand' | 'item'
  label: string        // Display name
  itemCount: number    // Number of proposals at this level
  children: HierarchyNode[]
  isExpanded: boolean
}
```

### LineItemDiffView

Shows baseline vs suggested vs edited values with inline editing.

**Features**:
- Grouped by field type (pricing, promo, taxonomy, etc.)
- Side-by-side value comparison
- Inline editors based on field type
- Validation issue display
- Per-item approve/reject

**Usage**:
```tsx
import { LineItemDiffView } from '@/components/proposalReview'

<LineItemDiffView
  lineItems={selectedRow.lineItems}
  onEditValue={(lineItemId, value) => {
    // Update draft value
  }}
  onSaveEdit={handleSaveEdit}
  onApprove={handleApprove}
  onReject={handleReject}
  isSaving={isSaving}
/>
```

**Supported Editors**:
- `text` - Text input
- `number` - Numeric input
- `price` - Currency input
- `boolean` - Checkbox
- `textArea` - Multi-line text
- `pricingLadder` - Pricing ladder editor (TODO)
- `promoBuilder` - Promo builder (TODO)
- `attributeEditor` - Attribute editor (TODO)

### BulkActionsBar

Controls for bulk operations on selected items.

**Features**:
- Bulk approve/reject
- Optional bulk edit with value input
- Selection count display
- Disabled state when no selection

**Usage**:
```tsx
import { BulkActionsBar } from '@/components/proposalReview'

<BulkActionsBar
  selectedCount={selectedRowIds.length}
  onBulkApprove={handleBulkApprove}
  onBulkReject={handleBulkReject}
  onBulkEdit={handleBulkEdit}
  isSaving={isSaving}
  enableBulkEdit={true}
  bulkEditPlaceholder="New price"
/>
```

### MSOBrandAnnotationPanel

MSO brand metadata display and editing with confirmation.

**Features**:
- MSO status badge
- House brand badge
- Toggle with confirmation dialog
- Policy reminders

**Usage**:
```tsx
import { MSOBrandAnnotationPanel } from '@/components/proposalReview'

<MSOBrandAnnotationPanel
  annotation={row.msoAnnotation}
  brandName={row.brandName}
  onUpdate={(annotation) => {
    // Save MSO annotation
  }}
  isSaving={isSaving}
  editable={true}
/>
```

## UI Contracts

### ProposalReviewResponse

Main data structure from backend:

```typescript
interface ProposalReviewResponse {
  batchId: number
  batchType: string
  batchSource: string
  batchStatus: 'draft' | 'ready' | 'applied' | 'cancelled'
  filters: ProposalReviewFilters
  rows: UiProposalRow[]
  totalRowCount: number
  summary: {
    pendingCount: number
    approvedCount: number
    rejectedCount: number
    totalLineItems: number
  }
}
```

### UiProposalRow

Individual proposal row:

```typescript
interface UiProposalRow {
  id: number
  rowTitle: string
  siteName?: string
  catalogName?: string
  brandName?: string | null
  itemName?: string | null
  msoAnnotation?: MSOBrandAnnotation
  merchContext: Record<string, unknown>
  evidence: Record<string, unknown>
  lineItems: UiLineItem[]
  // Hierarchy IDs for filtering
  siteId?: number
  catalogId?: number
  brandId?: number | null
  itemId?: number | null
}
```

### UiLineItem

Individual field change:

```typescript
interface UiLineItem {
  id: number
  field: UiFieldDescriptor
  baselineValue: unknown
  suggestedValue: unknown
  editedValue?: unknown
  effectiveValue: unknown
  approvalStatus: 'pending' | 'approved' | 'rejected'
  validationIssues: unknown[]
  notes?: string | null
  version: number
}
```

### UiFieldDescriptor

Field metadata:

```typescript
interface UiFieldDescriptor {
  path: string  // e.g., "pricing.ladder"
  group: 'pricing' | 'promo' | 'taxonomy' | 'attributes' | 'mso_brand' | 'description'
  label: string
  valueType: 'string' | 'number' | 'boolean' | 'price' | 'json' | 'pricingLadder' | 'text'
  editable: boolean
  editorComponent: 'text' | 'number' | 'price' | 'boolean' | 'textArea' | 'pricingLadder' | 'promoBuilder' | 'attributeEditor' | 'select'
}
```

## Complete Example

Example pricing review page using the framework:

```tsx
import { ProposalReviewLayout, HierarchyTree, LineItemDiffView, BulkActionsBar } from '@/components/proposalReview'
import { useLoaderData } from 'react-router-dom'
import { useState } from 'react'

export function PricingReviewPage() {
  const data = useLoaderData() as ProposalReviewResponse
  const [filters, setFilters] = useState(data.filters)
  const [selectedRowIds, setSelectedRowIds] = useState<number[]>([])
  const [activeRowId, setActiveRowId] = useState<number | null>(data.rows[0]?.id ?? null)
  
  const activeRow = data.rows.find(r => r.id === activeRowId)
  
  return (
    <ProposalReviewLayout
      config={{
        title: 'Review Pricing Changes',
        description: 'Approve or reject proposed price changes',
        batchTypeLabel: 'Pricing Review',
        enableHierarchyNav: true,
        enableBulkActions: true,
      }}
      data={data}
      filters={filters}
      onFiltersChange={setFilters}
      selectedRowIds={selectedRowIds}
      onSelectionChange={setSelectedRowIds}
      activeRowId={activeRowId}
      onActiveRowChange={setActiveRowId}
    >
      {{
        hierarchyNav: (
          <HierarchyTree
            root={buildHierarchy(data.rows)}
            onNodeSelect={handleNodeSelect}
            selectedNodeId={null}
          />
        ),
        bulkActionsBar: (
          <BulkActionsBar
            selectedCount={selectedRowIds.length}
            onBulkApprove={handleBulkApprove}
            onBulkReject={handleBulkReject}
            onBulkEdit={handleBulkPriceEdit}
            isSaving={false}
            enableBulkEdit={true}
            bulkEditPlaceholder="New price"
          />
        ),
        rowTable: (
          <RowTable
            rows={data.rows}
            selectedRowIds={selectedRowIds}
            onSelectionChange={setSelectedRowIds}
            activeRowId={activeRowId}
            onActiveRowChange={setActiveRowId}
          />
        ),
        detailPanel: activeRow ? (
          <>
            <h3>{activeRow.rowTitle}</h3>
            <LineItemDiffView
              lineItems={activeRow.lineItems}
              onEditValue={handleEditValue}
              onSaveEdit={handleSaveEdit}
              onApprove={handleApprove}
              onReject={handleReject}
              isSaving={false}
            />
            {activeRow.msoAnnotation && (
              <MSOBrandAnnotationPanel
                annotation={activeRow.msoAnnotation}
                brandName={activeRow.brandName ?? 'Unknown'}
                onUpdate={handleUpdateMSO}
                isSaving={false}
              />
            )}
          </>
        ) : (
          <p>No row selected</p>
        ),
      }}
    </ProposalReviewLayout>
  )
}
```

## Styling

The components use existing Helios class names:
- `.detail-panel` - Panel containers
- `.page-header` - Page headers with stats
- `.filter-bar` - Filter controls
- `.bulk-action-bar` - Bulk action controls
- `.proposal-review-layout` - Main layout grid
- `.hierarchy-tree` - Tree navigation
- `.line-item-row` - Line item containers
- `.value-comparison` - Side-by-side values
- `.inline-row` - Inline flex layouts

Add custom styles as needed to `src/client/styles/`.

## Extension

### Adding a Custom Editor

1. Add to `UiFieldDescriptor.editorComponent` enum
2. Implement renderer in `LineItemDiffView.renderEditor()`
3. Handle value changes appropriately

Example:
```tsx
case 'myCustomEditor':
  return (
    <MyCustomEditor
      value={item.effectiveValue}
      onChange={(value) => onEditValue(item.id, value)}
    />
  )
```

### Adding Custom Filters

Pass custom filters via `config.customFilters`:

```tsx
<ProposalReviewLayout
  config={{
    customFilters: (
      <>
        <select name="siteId" onChange={handleSiteFilter}>
          <option value="">All sites</option>
          {sites.map(site => <option key={site.id} value={site.id}>{site.name}</option>)}
        </select>
      </>
    ),
  }}
  // ...
/>
```

## Files

```
helios/src/
├── shared/contracts/ui/
│   └── proposalReview.ts                    # Zod schemas and types
└── client/components/proposalReview/
    ├── index.ts                             # Exports
    ├── ProposalReviewLayout.tsx             # Main layout
    ├── HierarchyTree.tsx                    # Tree navigation
    ├── LineItemDiffView.tsx                 # Value comparison & editing
    ├── BulkActionsBar.tsx                   # Bulk operations
    └── MSOBrandAnnotationPanel.tsx          # MSO brand metadata
```

## Related Documentation

- [README.md](./README.md) - Overall architecture
- [PricingReviewPage.tsx](../../helios/src/client/routes/pricing/PricingReviewPage.tsx) - Example usage
- [Pill.tsx](../../helios/src/client/components/Pill.tsx) - Status badges

---

**Status**: Core components implemented. Specialized editors (PricingLadder, PromoBuilder) to be added as needed.
