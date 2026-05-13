# Helios Service/Module Location Design

**Task**: Determine Helios service/module location  
**Issue**: #2  
**Created**: 2026-05-13

## Decision Summary

**The Pending Purchases functionality will live in the existing `pendingPurchases` module across Helios layers.**

Infrastructure already exists - this is an **enhancement and completion** task, not greenfield development.

## Directory Structure

### Existing Structure (Partial Implementation)

```
helios/
├── src/
│   ├── client/              # React UI components
│   │   └── routes/
│   │       └── pendingPurchases/   # UI for pending purchases (TO BE CREATED)
│   │
│   ├── server/              # HTTP server, API routes, domain logic
│   │   ├── pendingPurchases/
│   │   │   └── pendingPurchasePacketImport.ts  # ✅ Exists: Packet import logic
│   │   ├── routes/
│   │   │   └── pendingPurchases.ts  # ✅ Exists: API routes
│   │   └── db/
│   │       └── queries/
│   │           └── pendingPurchaseQueries.ts  # ✅ Exists: DB queries
│   │
│   ├── worker/              # Background jobs, async processing
│   │   ├── pendingPurchases/
│   │   │   ├── imageSafety.ts  # ✅ Exists: Image validation
│   │   │   └── imageSafety.test.ts
│   │   └── jobs/
│   │       ├── generatePendingPurchasePacketJob.ts  # ✅ Exists: Packet generation job
│   │       ├── importPendingPurchasePacketJob.ts  # ✅ Exists: Packet import job
│   │       ├── applyPendingPurchaseRequestJob.ts  # ✅ Exists: Apply job
│   │       └── pendingPurchaseParser.test.ts  # ✅ Exists: Parser tests
│   │
│   └── shared/              # Shared contracts, types, utilities
│       └── contracts/
│           └── domain/
│               └── pendingPurchases.ts  # ✅ Exists: TypeScript contracts
```

## Existing Infrastructure

### 1. Shared Contracts (`shared/contracts/domain/pendingPurchases.ts`)

**Already Defined**:
- `PendingPurchasePacketSource` - 'import' | 'generated'
- `PendingPurchasePacketStatus` - 'ready' | 'superseded'
- `PendingPurchaseMappingStatus` - mapping states
- `PendingPurchaseApprovalStatus` - 'pending' | 'approved' | 'rejected'
- `PendingPurchaseRowApplyStatus` - apply lifecycle states
- `PendingPurchaseApplyRequestStatus` - request-level states
- `PendingPurchasePacketSummary` - packet metadata
- `HeliosPendingPurchaseSiteDealer` - site dealer configuration
- Site dealer constants: Bronx (210249), Midtown (210705)

### 2. Server Routes (`server/routes/pendingPurchases.ts`)

**Exists**: API endpoints for pending purchases (need to verify completeness)

Likely routes:
- `GET /pending-purchases/packets` - List packets
- `POST /pending-purchases/packets/generate` - Trigger generation
- `POST /pending-purchases/packets/import` - Import packet
- `GET /pending-purchases/packets/:id` - Get packet details
- `POST /pending-purchases/packets/:id/approve` - Approve packet
- `POST /pending-purchases/packets/:id/apply` - Apply packet
- `GET /pending-purchases/apply-requests/:id` - Get apply status

### 3. Worker Jobs

**Existing Jobs**:

- **`generatePendingPurchasePacketJob.ts`**
  - Generates proposal packets from live Sweed orders
  - Implements the 9-stage pipeline
  - Stores results in database
  
- **`importPendingPurchasePacketJob.ts`**
  - Imports external packet JSON
  - Validates and persists to `pending_purchase_rows`
  
- **`applyPendingPurchaseRequestJob.ts`**
  - Executes approved catalog mutations
  - Creates groups, products, distributor links
  - Updates purchase order positions

- **`pendingPurchaseParser.test.ts`**
  - Tests for SKU parsing logic

### 4. Server Domain Logic

**`server/pendingPurchases/pendingPurchasePacketImport.ts`**:
- Import functions for packet data
- Validation logic
- Database persistence

### 5. Worker Utilities

**`worker/pendingPurchases/imageSafety.ts`**:
- Image validation and safety checks
- Dutchie image detection/filtering
- Image URL verification

## Integration Points with Existing Helios Systems

### Catalog Module
**Location**: `server/catalog/`, `worker/catalog/`

**Integration**:
- Pending Purchases creates catalog entities (groups, products)
- Shares catalog search/matching logic
- Reuses catalog persistence patterns

**Shared Code**:
- Product/group creation utilities (`worker/jobs/catalogGroupPersistence.ts`)
- Catalog review patterns (`server/routes/catalogReview.ts`)

### Pricing Module
**Location**: `server/pricing/`, `worker/pricing/`

**Integration**:
- Reuses GM% calculation logic
- Shares Lit Alerts integration
- Applies same pricing rules and constraints

**Shared Code**:
- Pricing calculation utilities
- Market research queries
- Price formatting/validation

### LLM Module
**Location**: `worker/llm/`

**Integration**:
- SKU parsing via LLM
- Product taxonomy classification
- Advisory quality checks

**Shared Code**:
- LLM client wrappers
- Registry compliance checks
- Result caching patterns

### Jobs Module
**Location**: `worker/jobs/`, `server/jobs.ts`

**Integration**:
- All pending purchase jobs registered in job system
- Scheduled execution framework
- Job status tracking and reporting

**Shared Patterns**:
- Job execution lifecycle
- Error handling and retry logic
- Progress reporting

### Audit Module
**Location**: `server/audit/`

**Integration**:
- All catalog mutations audited
- Apply request tracking
- Change history for rollback

## Module Responsibilities

### `server/pendingPurchases/` - Domain Logic

**Purpose**: Business logic and orchestration

**Contents** (to be enhanced):
- Packet generation orchestration
- SKU parsing coordination (manifest → cache → LLM)
- Catalog matching logic
- Pricing calculation
- Packet validation
- Apply request coordination

**Pattern**: Service layer, called by routes and jobs

### `server/routes/pendingPurchases.ts` - API Endpoints

**Purpose**: HTTP API for pending purchases

**Responsibilities**:
- Packet CRUD operations
- Trigger packet generation
- Import external packets
- Review and approval workflows
- Apply request submission
- Status queries

**Pattern**: Express routes returning JSON, uses domain logic from `server/pendingPurchases/`

### `server/db/queries/pendingPurchaseQueries.ts` - Database

**Purpose**: All database operations for pending purchases

**Tables** (likely):
- `pending_purchase_packets` - Packet metadata
- `pending_purchase_rows` - Line item proposals
- `pending_purchase_apply_requests` - Apply execution tracking
- `pending_purchase_row_apply_results` - Per-row apply outcomes

**Responsibilities**:
- CRUD for packets and rows
- Status transitions
- Result persistence
- Query optimization

### `worker/pendingPurchases/` - Worker Utilities

**Purpose**: Shared logic for worker jobs

**Contents** (to be enhanced):
- SKU parser implementation
- Image safety checks
- External API clients (Sweed, Lit Alerts)
- Data enrichment utilities
- Validation logic

**Pattern**: Pure functions and utilities, no job lifecycle concerns

### `worker/jobs/*PendingPurchase*.ts` - Background Jobs

**Purpose**: Asynchronous execution of long-running tasks

**Jobs**:
1. **Generate** - Create proposals from live orders
2. **Import** - Load external packet JSON
3. **Apply** - Execute approved mutations

**Pattern**: Job entry point → domain orchestration → worker utilities → DB persistence

### `client/routes/pendingPurchases/` - React UI (TO BE CREATED)

**Purpose**: Operator-facing UI for review and approval

**Components** (to be created):
- Packet list view
- Packet detail view with proposal rows
- Price ladder controls (draggable sliders)
- Tree navigation sidebar
- Detail modal/page
- Approval workflow UI
- Apply request monitoring

**Pattern**: React components using Helios UI patterns, calls server routes

### `shared/contracts/domain/pendingPurchases.ts` - TypeScript Types

**Purpose**: Shared type definitions for all layers

**Already contains**: Status enums, packet schemas, site dealer config

**To be enhanced**: Add schemas for:
- Proposal row structure
- Enrichment data
- Market research results
- Apply request details

## Directory Structure Decision

### ✅ Use Existing Module (Recommended)

**Pros**:
- Infrastructure already exists
- Contracts already defined
- Jobs already registered
- Consistent with Helios patterns
- Database tables likely exist
- Routes already configured

**Cons**:
- None significant

**Decision**: Enhance existing `pendingPurchases` module across all layers

### ❌ Create New Module (Not Recommended)

Creating `purchaseProposals/` or `catalogMutationProposals/` would:
- Duplicate existing infrastructure
- Require contract migration
- Break existing job registrations
- Confuse module boundaries

## Integration with Helios Patterns

### Authentication & Authorization
- Use existing Helios auth patterns
- Google OAuth for user identity
- Role-based access for approval workflows

### Database Connection
- Use Helios PostgreSQL connection pool
- TigerData/Timescale for time-series data
- Transaction management for apply operations

### Error Handling
- Follow Helios error handling patterns
- Structured logging to Helios logger
- Error codes and user-friendly messages
- `page-dave` for critical failures

### API Response Format
- Consistent with other Helios routes
- JSON responses with standard structure
- Pagination for list endpoints
- Status/progress for long-running operations

### Job Scheduling
- Use Helios worker job system
- Cron scheduling for recurring generation
- On-demand triggers via API
- Job status tracking

### Configuration
- Environment variables via Helios config
- Secrets via agenix integration (when available)
- Feature flags for gradual rollout

## File Naming Conventions

Follow existing Helios patterns:

- **Routes**: `pendingPurchases.ts` (singular module, plural entity where needed)
- **Jobs**: `{action}PendingPurchase{Noun}Job.ts` (e.g., `generatePendingPurchasePacketJob.ts`)
- **Tests**: `{filename}.test.ts` (co-located with source)
- **Utilities**: Descriptive names (e.g., `imageSafety.ts`, `skuParser.ts`)
- **Contracts**: Domain name (e.g., `pendingPurchases.ts` in `contracts/domain/`)

## Migration Strategy

### Phase 1: Server & Worker (Backend First)
1. Enhance `server/pendingPurchases/` domain logic
2. Implement missing worker utilities
3. Complete job implementations
4. Verify database schemas
5. Test with existing TypeScript import scripts

### Phase 2: Client (UI)
1. Create `client/routes/pendingPurchases/` directory
2. Build packet list view
3. Build packet detail/review view
4. Implement price ladder controls
5. Add tree navigation
6. Wire approval workflows

### Phase 3: Python Retirement
1. Run Helios and Python in parallel
2. Compare outputs for parity
3. Switch traffic to Helios
4. Archive Python scripts
5. Update documentation

## Success Criteria

Migration is complete when:

- [x] Module structure matches existing Helios patterns
- [ ] All worker jobs implemented and tested
- [ ] Server routes handle all required operations
- [ ] Database queries support full workflow
- [ ] Client UI provides all Python packet features
- [ ] Price ladder, tree nav, click-to-new-tab preserved
- [ ] No silent failures policy enforced
- [ ] Site-scoped verification implemented
- [ ] Business rules from Python preserved
- [ ] Tests cover critical paths
- [ ] Documentation updated

## References

- Existing contracts: `helios/src/shared/contracts/domain/pendingPurchases.ts`
- Existing routes: `helios/src/server/routes/pendingPurchases.ts`
- Existing jobs: `helios/src/worker/jobs/*PendingPurchase*.ts`
- Python generator: `catalog/purchases/2026-05-11/generate_combined_pending_packet.py`
- Business rules: `docs/pending_purchases/BUSINESS_RULES.md`
- Data pipeline: `docs/pending_purchases/DATA_PIPELINE.md`
