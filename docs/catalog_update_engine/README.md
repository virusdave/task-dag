# Unified Catalog Update Engine

**Issue**: #5  
**Status**: Implementation Started  
**Created**: 2026-05-13

## Overview

The Unified Catalog Update Engine provides a single, modular system for handling all types of catalog maintenance operations. It replaces fragmented, trigger-specific implementations with a coherent architecture that separates:

1. **Input adapters** - Transform trigger-specific data into unified proposals
2. **Core engine** - Persists proposals, manages approval workflows
3. **Reviewer UI** - Reusable interface for hierarchical review and approval
4. **Output adapters** - Apply approved changes to domain tables

## Problem Statement

Currently, catalog maintenance involves many different triggers and implementations:

**Triggers** (what causes changes):
- New purchases/deliveries
- Repricing runs
- Promotional campaigns
- Market dynamics changes
- Time-based maintenance
- Error corrections

**Destinations** (what gets changed):
- Catalog entries (new products, variants, strains, effects, flavors)
- Categories and subcategories
- Pricing (global, local, promo levels)
- Promotions (BOGO, mix-and-match, discounts)
- MSO brand annotations

Each trigger-destination pair had its own implementation, leading to:
- Duplicated UI patterns
- Inconsistent review workflows
- Hard-to-maintain code
- Difficulty adding new trigger or destination types

## Solution Architecture

### High-Level Flow

```
┌──────────────┐
│   Trigger    │
│  (Purchase,  │
│  Repricing,  │
│   Promo...)  │
└──────┬───────┘
       │
       ▼
┌──────────────────┐       ┌──────────────────┐
│  Input Adapter   │──────▶│  Core Engine     │
│  (Transform to   │       │  (Persist to     │
│   BatchDraft)    │       │   proposal_*)    │
└──────────────────┘       └────────┬─────────┘
                                    │
                           ┌────────┴─────────┐
                           │                  │
                           ▼                  ▼
                    ┌──────────────┐   ┌──────────────┐
                    │  Reviewer UI │   │   Approval   │
                    │  (Hierarchy, │   │   Workflow   │
                    │  Bulk Ops)   │   │              │
                    └──────┬───────┘   └──────┬───────┘
                           │                  │
                           └────────┬─────────┘
                                    │
                                    ▼
                           ┌──────────────────┐
                           │ Output Adapters  │
                           │  (Apply pricing, │
                           │   promos, etc.)  │
                           └──────────────────┘
```

### Core Domain Model

All triggers emit `CatalogUpdateBatchDraft` objects containing:

- **Batch metadata**: Type, trigger, source, config
- **Rows**: One per catalog entity (site → catalog → brand → item)
- **Line items**: Individual field changes (pricing, promos, taxonomy, attributes)

This maps directly to existing database tables:
- `proposal_batches`
- `proposal_rows`  
- `proposal_line_items`
- `catalog_groups`
- `catalog_group_snapshots`

### Key Design Principles

1. **Reuse existing infrastructure** - No new tables needed, extends proposal_* tables
2. **Generic field paths** - `pricing.ladder`, `promo.bogo`, `taxonomy.category` etc.
3. **Type-safe domain** - TypeScript interfaces enforce structure
4. **Pluggable adapters** - Add new triggers/outputs without core changes
5. **Unified UI** - One reviewer framework configured per batch type

## Module Structure

```
helios/src/catalogUpdateEngine/
├── domain/
│   ├── entities.ts         # Entity types, hierarchy, MSO annotations
│   ├── changes.ts          # Field paths, line items, field registry
│   └── proposals.ts        # Batch and row drafts
├── service/
│   └── CatalogUpdateEngine.ts  # Core persistence and apply logic
├── input/
│   ├── CatalogUpdateInputAdapter.ts     # Interface
│   ├── PurchasesInputAdapter.ts         # Purchase triggers
│   ├── RepricingInputAdapter.ts         # Repricing triggers
│   └── PromoInputAdapter.ts             # Promo triggers
└── output/
    ├── CatalogChangeOutputAdapter.ts    # Interface
    ├── PricingOutputAdapter.ts          # Apply pricing changes
    ├── PromoOutputAdapter.ts            # Apply promo changes
    ├── TaxonomyOutputAdapter.ts         # Apply category changes
    └── MSOBrandOutputAdapter.ts         # Apply MSO annotations
```

## Field Path Registry

All supported change types are registered in `CATALOG_FIELD_REGISTRY`:

**Pricing**:
- `pricing.basePrice` - Single retail price
- `pricing.ladder` - Full pricing ladder with quantity breaks

**Promos**:
- `promo.bogo` - Buy-one-get-one promotions
- `promo.discount` - Percentage/dollar-off discounts

**Taxonomy**:
- `taxonomy.category` - Product category
- `taxonomy.subcategory` - Subcategory
- `taxonomy.strain` - Strain name

**Attributes**:
- `attributes.thcPercent` - THC percentage
- `attributes.cbdPercent` - CBD percentage
- `attributes.description` - Product description

**MSO Brand**:
- `msoBrand.msoBrandId` - MSO brand identifier
- `msoBrand.isMSOBrand` - MSO brand flag
- `msoBrand.isHouseBrand` - House brand flag

## Usage

### Creating a Batch from Input

```typescript
import { CatalogUpdateEngine } from './service/CatalogUpdateEngine.js'
import { PurchasesInputAdapter } from './input/PurchasesInputAdapter.ts'
import { getPool } from '../server/db/pool.js'

const db = getPool()
const engine = new CatalogUpdateEngine(db)
const adapter = new PurchasesInputAdapter()

// Prepare batch from trigger
const batchDraft = await adapter.prepareBatch(
  {
    db,
    requestId: 'req-123',
    dealerId: 456,
    createdByUserId: 789,
  },
  {
    purchaseMetrics: [/* ... */],
    runDate: '2026-05-13',
    source: 'pending-purchases-v2',
  },
)

// Persist to database
const result = await engine.createBatch(batchDraft, 'req-123')
console.log(`Created batch ${result.proposalBatchId}`)
```

### Applying Approved Changes

```typescript
// After reviewer approves changes in UI
await engine.applyApprovedBatch(
  proposalBatchId,
  appliedByUserId,
  'req-456',
)
```

## Migration Path

### Phase 1: Foundation (Current)
✅ Core domain types  
✅ CatalogUpdateEngine service  
✅ Sample input adapter (Purchases)  
✅ Sample output adapter (Pricing)  
✅ Documentation

### Phase 2: Adapter Implementation
- [ ] Complete all input adapters (Repricing, Promo, Market, Maintenance)
- [ ] Complete all output adapters (Promo, Taxonomy, MSO)
- [ ] Integration tests for adapter chains

### Phase 3: UI Framework
- [ ] Generic ProposalReviewLayout component
- [ ] HierarchyTree navigation (site → catalog → brand → item)
- [ ] Specialized editors (PricingLadder, PromoBuilder, AttributeEditor)
- [ ] Bulk operations framework
- [ ] MSO brand annotation UI

### Phase 4: Migration
- [ ] Migrate existing pricing review to use engine
- [ ] Migrate pending purchases to use engine
- [ ] Migrate promo workflows to use engine
- [ ] Deprecate old implementations

### Phase 5: Advanced Features
- [ ] Auto-approval rules for low-risk changes
- [ ] Real-time streaming approvals
- [ ] Cross-site batch operations
- [ ] Enhanced audit trail visualization

## Key Features

### Hierarchical Organization
Proposals organized by:
- **Site** - Which dispensary location
- **Catalog** - Product catalog/group
- **Brand** - Product brand (with MSO annotations)
- **Item** - Individual SKU/variant

### Approval Workflow
- **Pending** - Awaiting review
- **Approved** - Ready to apply
- **Rejected** - Excluded from apply

### Bulk Operations
- Approve all items for selected brands
- Bulk price adjustments
- Mass MSO brand annotations
- Filter by hierarchy level

### Pricing Ladders
Visual editor showing:
- Current vs. proposed pricing
- Market comparisons
- Margin percentages
- Quantity breaks

### Audit Trail
Full history of:
- Batch creation events
- Approval decisions
- Applied changes
- Snapshots before/after

## Technical Details

### Database Schema Reuse

The engine reuses existing tables:

**`proposal_batches`**: Stores batch metadata
- `type`: 'pricing' | 'promo' | 'taxonomy' | 'attributes' | 'mixed'
- `trigger_mode`: 'auto' | 'manual' | 'import'
- `config_json`: Trigger-specific configuration

**`proposal_rows`**: One per catalog entity
- `target_entity_type`: 'catalog_group' | 'brand' | 'site' | etc.
- `merchandising_context_json`: Display metadata
- `evidence_json`: Supporting data

**`proposal_line_items`**: Individual field changes
- `field_path`: From CATALOG_FIELD_REGISTRY
- `baseline_value_json`: Current value
- `suggested_value_json`: Proposed value
- `effective_value_json`: Final value (suggested or edited)
- `approval_status`: 'pending' | 'approved' | 'rejected'

### Performance Considerations

- Batch inserts (250 items per query) for large batches
- Chunked processing to avoid memory issues
- Indexes on `proposal_batch_id`, `catalog_group_id`, `field_path`
- Snapshots for audit without bloating line items

### Validation

- Field path validation against registry
- Type checking in TypeScript domain
- Validation issues stored per line item
- Frontend and backend validation

## Extension Guide

### Adding a New Trigger Type

1. Define payload interface
2. Create input adapter implementing `CatalogUpdateInputAdapter<TPayload>`
3. Map trigger data to `CatalogUpdateBatchDraft`
4. Register new field paths in `CATALOG_FIELD_REGISTRY` if needed

### Adding a New Output Type

1. Create output adapter implementing `CatalogChangeOutputAdapter`
2. Implement `supportsField()` for relevant field groups
3. Implement `applyApprovedChanges()` to update domain tables
4. Add audit events

### Adding a New Field

1. Add to `CATALOG_FIELD_REGISTRY` with path, group, label, valueType
2. Create specialized editor component if needed (for UI)
3. Update relevant output adapter to handle new field
4. Add validation rules

## Testing Strategy

- **Unit tests**: Domain types, field registry, validation
- **Integration tests**: Full adapter chains (input → engine → output)
- **UI tests**: Review workflows, bulk operations
- **E2E tests**: Complete trigger-to-apply flows

## Related Documentation

- [HOW_HELIOS_WORKS.md](../HOW_HELIOS_WORKS.md) - Helios architecture overview
- [review-packet-import.md](../proposals/review-packet-import.md) - Existing proposal import pattern
- [pricing-ladder.md](../ui/pricing-ladder.md) - Pricing ladder UI component

## Future Enhancements

- Event-sourced change log for real-time streaming
- Rule engine for auto-approvals
- Per-MSO policy enforcement
- Cross-region catalog replication
- Machine learning for price optimization
- Automated market monitoring triggers

---

**Status**: Core implementation complete, awaiting UI framework and full adapter set.
