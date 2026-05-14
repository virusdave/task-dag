# Issue #5: Unified Catalog Update Engine - Implementation Summary

**Issue**: https://github.com/FreshlyBakedNYC/automation/issues/5  
**Status**: Core Implementation Complete  
**Date**: 2026-05-13  
**Thread**: T-174e543e-925c-4bbd-b735-06faba06aa72

## Overview

Successfully implemented the core architecture for a unified catalog update engine that handles all types of catalog maintenance operations through a single, modular system.

## Problem Solved

Previously, catalog maintenance involved fragmented implementations for each trigger-destination pair:
- Purchases → Pricing updates (one implementation)
- Repricing runs → Pricing updates (different implementation)
- Promos → Promotion creation (another implementation)
- Market data → Various updates (yet another implementation)

This led to duplicated code, inconsistent UIs, and difficulty adding new trigger or destination types.

## Solution Architecture

### Three-Layer Design

1. **Input Adapters** - Transform trigger-specific payloads into unified proposals
2. **Core Engine** - Persists proposals, manages approval workflows (reuses existing `proposal_*` tables)
3. **Output Adapters** - Apply approved changes to domain tables

### Key Innovation: Generic Field Paths

All changes represented through registered field paths:
- `pricing.basePrice`, `pricing.ladder`
- `promo.bogo`, `promo.discount`
- `taxonomy.category`, `taxonomy.subcategory`
- `attributes.thcPercent`, `attributes.description`
- `msoBrand.isMSOBrand`, `msoBrand.isHouseBrand`

This allows the same infrastructure to handle pricing, promos, taxonomy, and attributes without schema changes.

## Implementation Deliverables

### Core Domain Types (3 files)

**`domain/entities.ts`** (63 lines):
- `CatalogEntityType` - Entity taxonomy (catalog_group, brand, site, etc.)
- `CatalogHierarchyRef` - Site → catalog → brand → item hierarchy
- `MSOBrandAnnotation` - MSO brand metadata
- `PricingLadder` - Quantity-based pricing structures

**`domain/changes.ts`** (112 lines):
- `CatalogChangeFieldPath` - Field descriptor interface
- `CATALOG_FIELD_REGISTRY` - Central registry of all supported fields
- `CatalogChangeLineItemDraft` - Proposed changes before persistence
- `CatalogChangeLineItemPersisted` - Changes with approval status

**`domain/proposals.ts`** (51 lines):
- `CatalogUpdateBatchDraft` - Collection of changes from a trigger
- `CatalogProposalRowDraft` - Changes for a single entity
- Trigger and batch type enums

### Core Service (1 file)

**`service/CatalogUpdateEngine.ts`** (385 lines):
- `createBatch()` - Persists batch draft to `proposal_*` tables
- `applyApprovedBatch()` - Coordinates applying approved changes
- Reuses patterns from `reviewPacketImport.ts`
- Batch insert optimization (250 items per query)

### Input Adapters (2 files)

**`input/CatalogUpdateInputAdapter.ts`** (27 lines):
- Interface for all input adapters
- `CatalogUpdateTriggerContext` for common dependencies

**`input/PurchasesInputAdapter.ts`** (108 lines):
- Example implementation for purchase-triggered updates
- Transforms purchase metrics into pricing proposals
- Maps Sweed group IDs to catalog entities

### Output Adapters (2 files)

**`output/CatalogChangeOutputAdapter.ts`** (29 lines):
- Interface for all output adapters
- `ApplyContext` for apply operations

**`output/PricingOutputAdapter.ts`** (99 lines):
- Example implementation for pricing changes
- Applies pricing ladder and base price updates
- Full audit trail per entity

### Infrastructure (1 file)

**`index.ts`** (57 lines):
- Main exports for engine module
- Type-safe public API

### Documentation (1 file)

**`docs/catalog_update_engine/README.md`** (459 lines):
- Complete architecture documentation
- Usage examples
- Migration path
- Extension guide
- Field registry documentation

## Technical Highlights

### Reuses Existing Infrastructure

No new database tables required:
- `proposal_batches` - Batch metadata
- `proposal_rows` - Entity-level proposals
- `proposal_line_items` - Individual field changes
- `catalog_groups` - Catalog entity records
- `catalog_group_snapshots` - Audit snapshots

### Type-Safe Domain Model

All types defined in TypeScript with full type checking:
- Field paths validated against central registry
- Adapter interfaces enforce consistency
- Compile-time safety for field groups

### Pluggable Architecture

Add new triggers or outputs without core changes:
- Implement `CatalogUpdateInputAdapter<TPayload>` for new triggers
- Implement `CatalogChangeOutputAdapter` for new outputs
- Register new fields in `CATALOG_FIELD_REGISTRY`

### Performance Optimized

- Batch inserts (250 items per query) for large datasets
- Chunked processing to avoid memory issues
- Existing indexes on `proposal_batch_id`, `catalog_group_id`

## Files Created

```
helios/src/catalogUpdateEngine/
├── domain/
│   ├── entities.ts                          [NEW] 63 lines
│   ├── changes.ts                           [NEW] 112 lines
│   └── proposals.ts                         [NEW] 51 lines
├── service/
│   └── CatalogUpdateEngine.ts               [NEW] 385 lines
├── input/
│   ├── CatalogUpdateInputAdapter.ts         [NEW] 27 lines
│   └── PurchasesInputAdapter.ts             [NEW] 108 lines
├── output/
│   ├── CatalogChangeOutputAdapter.ts        [NEW] 29 lines
│   └── PricingOutputAdapter.ts              [NEW] 99 lines
└── index.ts                                 [NEW] 57 lines

docs/catalog_update_engine/
└── README.md                                [NEW] 459 lines

TOTAL: 10 files, ~1,390 lines
```

## Design Consultation

Used Oracle (GPT-5 reasoning model) to:
- Review existing implementations (PricingReviewPage, reviewPacketImport)
- Design modular architecture with clear separation of concerns
- Define TypeScript interfaces and module structure
- Establish extension patterns

## Migration Path

### Phase 1: Foundation ✅ COMPLETE
- Core domain types
- CatalogUpdateEngine service
- Sample input adapter (Purchases)
- Sample output adapter (Pricing)
- Documentation

### Phase 2: Adapter Implementation (Next)
- Complete all input adapters (Repricing, Promo, Market, Maintenance)
- Complete all output adapters (Promo, Taxonomy, MSO)
- Integration tests

### Phase 3: UI Framework
- Generic ProposalReviewLayout component
- HierarchyTree navigation
- Specialized editors (PricingLadder, PromoBuilder)
- Bulk operations framework
- MSO brand annotation UI

### Phase 4: Migration
- Migrate existing pricing review
- Migrate pending purchases
- Migrate promo workflows
- Deprecate old implementations

### Phase 5: Advanced Features
- Auto-approval rules
- Real-time streaming
- Cross-site operations
- Enhanced audit trails

## Usage Example

```typescript
import { CatalogUpdateEngine } from './catalogUpdateEngine'
import { PurchasesInputAdapter } from './catalogUpdateEngine/input/PurchasesInputAdapter'
import { getPool } from './server/db/pool'

const db = getPool()
const engine = new CatalogUpdateEngine(db)
const adapter = new PurchasesInputAdapter()

// Prepare batch from purchase data
const batchDraft = await adapter.prepareBatch(
  { db, requestId: 'req-123', dealerId: 456, createdByUserId: 789 },
  {
    purchaseMetrics: [/* purchase data */],
    runDate: '2026-05-13',
    source: 'pending-purchases-v2',
  },
)

// Persist to database
const result = await engine.createBatch(batchDraft, 'req-123')
console.log(`Created batch ${result.proposalBatchId}`)

// After reviewer approves in UI
await engine.applyApprovedBatch(result.proposalBatchId, userId, 'req-456')
```

## Benefits

1. **Unified System** - One architecture for all catalog operations
2. **Consistent UX** - Same review patterns across all triggers
3. **Easy Extension** - Add new triggers/outputs via adapters
4. **Type Safety** - Full TypeScript type checking
5. **Audit Trail** - Complete history via existing audit system
6. **Performance** - Optimized batch processing
7. **Reuse** - Leverages existing proposal_* infrastructure

## Next Steps

1. Complete remaining input adapters (Repricing, Promo, Market)
2. Complete remaining output adapters (Promo, Taxonomy, MSO)
3. Build reusable reviewer UI framework
4. Write integration tests
5. Migrate first existing workflow (likely pending purchases)

## Adherence to Conventions

✅ **Workspace rules** - Followed src/automation/AGENTS.md  
✅ **TypeScript patterns** - Type-safe domain model  
✅ **Database reuse** - Uses existing proposal_* tables  
✅ **Audit compliance** - Full audit event integration  
✅ **Documentation** - Comprehensive README with examples  
✅ **Modular design** - Clear separation of concerns  
✅ **Oracle consultation** - Used for architecture planning

## Related Documentation

- [Oracle Architecture Consultation](#) - Detailed design rationale
- [docs/catalog_update_engine/README.md](./docs/catalog_update_engine/README.md) - Full documentation
- [HOW_HELIOS_WORKS.md](./HOW_HELIOS_WORKS.md) - Helios architecture
- [reviewPacketImport.ts](./helios/src/server/proposals/reviewPacketImport.ts) - Pattern source

---

**Status**: Core implementation complete. Ready for adapter implementation phase and UI framework development.
