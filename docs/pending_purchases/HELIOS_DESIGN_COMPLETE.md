# Helios Pending Purchases - Complete Design Specification

**Tasks**: Design job scheduling, data flow, external integration  
**Issue**: #2  
**Created**: 2026-05-13

This document consolidates the design decisions for migrating Pending Purchases to Helios.

## 1. Job Scheduling Design

### Scheduling Mechanism: Helios Worker Job System

**Decision**: Use existing Helios worker job infrastructure with cron scheduling.

### Job Types

#### 1.1 `generatePendingPurchasePacketJob`
**Purpose**: Generate proposal packets from live Sweed orders

**Trigger Options**:
- **Cron Schedule** (Recommended): Daily at 9 AM ET
  - Catches new overnight orders
  - Gives operators full day for review
  - Low system load time
  
- **On-Demand**: API trigger via `POST /pending-purchases/packets/generate`
  - Manual operator request
  - After known distributor delivery
  - For urgent orders

**Execution Pattern**:
```typescript
{
  jobType: 'generatePendingPurchasePacket',
  schedule: '0 9 * * *',  // Daily 9 AM
  retry: {
    maxAttempts: 3,
    backoffMs: [60000, 300000, 900000]  // 1min, 5min, 15min
  },
  timeout: 1800000,  // 30 minutes
  concurrency: 1  // One at a time
}
```

**Inputs**:
- Site dealer IDs (default: [210705, 210249] - both sites)
- Date range filter (optional, default: all pending)
- Force regenerate flag (supersedes existing)

**Outputs**:
- Packet ID (DB record)
- Row count
- Packet status ('ready')
- Summary stats (products, brands, total value)

**Error Handling**:
- Sweed API failures → retry with backoff
- Lit Alerts failures → retry with backoff
- LLM failures → retry with backoff
- After max retries → page Dave, abort
- No silent failures

#### 1.2 `importPendingPurchasePacketJob`
**Purpose**: Import external packet JSON (e.g., from Python generator during transition)

**Trigger**: API call only (`POST /pending-purchases/packets/import`)

**Execution Pattern**:
```typescript
{
  jobType: 'importPendingPurchasePacket',
  retry: {
    maxAttempts: 2,
    backoffMs: [30000, 120000]
  },
  timeout: 600000,  // 10 minutes
  concurrency: 5  // Multiple imports can run
}
```

**Inputs**:
- Packet JSON (file upload or URL)
- Import source identifier
- Operator who requested import

**Outputs**:
- Packet ID
- Rows imported count
- Validation errors (if any)

**Validation**:
- Schema validation against `PendingPurchasePacketSchema`
- Required fields present
- Cost/price sanity checks
- No Dutchie images

#### 1.3 `applyPendingPurchaseRequestJob`
**Purpose**: Execute approved catalog mutations

**Trigger**: API call after approval (`POST /pending-purchases/packets/:id/apply`)

**Execution Pattern**:
```typescript
{
  jobType: 'applyPendingPurchaseRequest',
  retry: {
    maxAttempts: 1,  // No auto-retry for mutations
    backoffMs: []
  },
  timeout: 3600000,  // 60 minutes for large packets
  concurrency: 1  // Sequential to avoid Sweed API conflicts
}
```

**Inputs**:
- Packet ID
- Apply request ID
- Approved rows (subset or all)
- Operator who approved

**Outputs**:
- Apply request status
- Rows applied count
- Groups/products created IDs
- Errors per row (if any)

**Atomicity**:
- **Not transactional** (Sweed API limitation)
- Progress tracked per row
- Partial success possible
- Rollback via separate job if needed

**Error Handling**:
- Per-row error capture
- Continue on row failure (mark as 'failed')
- Page Dave on >20% failure rate
- Full result log to DB

### Scheduling Configuration

**Location**: `helios/src/worker/config/jobSchedules.ts`

```typescript
export const PENDING_PURCHASE_SCHEDULES = {
  generateDaily: {
    jobType: 'generatePendingPurchasePacket',
    cronSchedule: '0 9 * * *',  // 9 AM ET daily
    timezone: 'America/New_York',
    enabled: true,
    params: {
      dealerIds: [210705, 210249],
      includeAllPending: true
    }
  }
}
```

### Job Execution Monitoring

**Metrics to Track**:
- Job start/completion timestamps
- Duration (target < 5 minutes for generation)
- Success/failure rate
- Rows processed per job
- API call counts (Sweed, Lit Alerts, LLM)
- LLM cost per job

**Alerting**:
- Job failure → page Dave
- Duration > 2x average → warn
- API rate limit hit → page Dave
- LLM quota exceeded → page Dave

### Retry & Backoff Strategy

**Transient Failures** (network, rate limit):
- Exponential backoff: 1min, 5min, 15min
- Max 3 attempts
- Different backoff per API (Sweed, Lit Alerts, LLM)

**Permanent Failures** (auth, validation):
- No retry
- Immediate page Dave
- Require manual intervention

## 2. Data Flow and Model Architecture

### 2.1 Database Schema

#### Table: `pending_purchase_packets`
**Purpose**: Metadata for proposal packets

```sql
CREATE TABLE pending_purchase_packets (
  packet_id SERIAL PRIMARY KEY,
  packet_title TEXT NOT NULL,
  source TEXT NOT NULL,  -- 'generated' | 'import'
  source_path TEXT,      -- File path for imports
  import_file_name TEXT, -- Original filename
  status TEXT NOT NULL,  -- 'ready' | 'superseded'
  state_context JSONB,   -- Generation parameters, filters
  summary JSONB,         -- Stats: rowCount, totalCost, etc.
  site_keys TEXT[],      -- ['midtown', 'bronx']
  site_labels TEXT[],    -- ['Midtown', 'Bronx']
  generated_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by_user TEXT,
  superseded_by_packet_id INTEGER REFERENCES pending_purchase_packets(packet_id)
);

CREATE INDEX idx_pp_packets_status ON pending_purchase_packets(status);
CREATE INDEX idx_pp_packets_generated_at ON pending_purchase_packets(generated_at DESC);
```

#### Table: `pending_purchase_rows`
**Purpose**: Individual line item proposals

```sql
CREATE TABLE pending_purchase_rows (
  row_id SERIAL PRIMARY KEY,
  packet_id INTEGER NOT NULL REFERENCES pending_purchase_packets(packet_id) ON DELETE CASCADE,
  row_index INTEGER NOT NULL,  -- Position in packet
  
  -- Order context
  site_key TEXT NOT NULL,
  site_dealer_id INTEGER NOT NULL,
  order_id TEXT,
  position_id TEXT,
  distributor_product_name TEXT NOT NULL,
  
  -- Parsed taxonomy
  parsed_brand TEXT,
  parsed_category TEXT,
  parsed_subcategory TEXT,
  parsed_variant_name TEXT,
  parsed_strain_name TEXT,
  parsed_pack_size TEXT,
  parsed_pack_count INTEGER,
  
  -- Costing & Pricing
  cost_per_unit NUMERIC(10,2),
  proposed_retail_price NUMERIC(10,2),
  gm_percent NUMERIC(5,2),
  
  -- Market research
  market_avg_price NUMERIC(10,2),
  competitor_listings JSONB,
  evidence_tier TEXT,  -- 'exact' | 'categorical' | 'none'
  
  -- Catalog matching
  matched_product_id INTEGER,
  matched_group_id INTEGER,
  create_product BOOLEAN DEFAULT FALSE,
  create_group BOOLEAN DEFAULT FALSE,
  
  -- Enrichment
  primary_image_url TEXT,
  primary_image_href TEXT,
  metrc_tag TEXT,
  distributor_sku TEXT,
  
  -- Review & approval
  review_flags TEXT[],
  mapping_status TEXT,  -- 'mapped_variant_ready_for_link' | 'needs_catalog_create' | 'needs_review'
  approval_status TEXT DEFAULT 'pending',  -- 'pending' | 'approved' | 'rejected'
  approved_by_user TEXT,
  approved_at TIMESTAMPTZ,
  reviewer_notes TEXT,
  
  -- Apply tracking
  apply_status TEXT DEFAULT 'not_requested',  -- 'not_requested' | 'queued' | 'running' | 'applied' | 'failed' | 'blocked'
  apply_request_id INTEGER REFERENCES pending_purchase_apply_requests(request_id),
  applied_at TIMESTAMPTZ,
  apply_error TEXT,
  
  -- Created entities (after apply)
  created_group_id INTEGER,
  created_product_id INTEGER,
  created_distributor_link_id INTEGER,
  
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_pp_rows_packet ON pending_purchase_rows(packet_id);
CREATE INDEX idx_pp_rows_approval_status ON pending_purchase_rows(approval_status) WHERE approval_status != 'rejected';
CREATE INDEX idx_pp_rows_apply_status ON pending_purchase_rows(apply_status);
CREATE INDEX idx_pp_rows_site ON pending_purchase_rows(site_key);
```

#### Table: `pending_purchase_apply_requests`
**Purpose**: Track apply execution

```sql
CREATE TABLE pending_purchase_apply_requests (
  request_id SERIAL PRIMARY KEY,
  packet_id INTEGER NOT NULL REFERENCES pending_purchase_packets(packet_id),
  job_id INTEGER REFERENCES jobs(job_id),
  
  status TEXT NOT NULL,  -- 'queued' | 'running' | 'succeeded' | 'partially_succeeded' | 'failed' | 'blocked'
  
  requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  requested_by_user TEXT,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  
  -- Summary stats
  total_row_count INTEGER NOT NULL,
  applied_row_count INTEGER DEFAULT 0,
  failed_row_count INTEGER DEFAULT 0,
  blocked_row_count INTEGER DEFAULT 0,
  
  -- Result details
  result_summary JSONB,
  error_message TEXT,
  
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_pp_apply_requests_packet ON pending_purchase_apply_requests(packet_id);
CREATE INDEX idx_pp_apply_requests_status ON pending_purchase_apply_requests(status);
```

### 2.2 Data Flow Stages

#### Stage 1: Collection (Input)
**Source**: Sweed API

**Flow**:
```
Sweed API (both sites)
  → pending_purchase_packets (new record)
  → pending_purchase_rows (bulk insert, status='pending')
```

**API Calls**:
- `store.auth.dealer.set { dealerId }`
- `store.purchase.order.list { orderStatusId: 2 }`
- `store.purchase.order.get { id }`
- `store.distributor.product.suggestion { orderId }`

**Data Captured**:
- Order metadata
- Position details
- Distributor product names
- Current mapping status

#### Stage 2: Parsing (Enrichment)
**Sources**: Manifest files, LLM cache, Bedrock Mantle

**Flow**:
```
pending_purchase_rows (distributor_product_name)
  → Manifest lookup (priority 1)
  → LLM cache lookup (priority 2)
  → Bedrock Mantle API (priority 3)
  → UPDATE pending_purchase_rows (parsed fields)
```

**Outputs Populated**:
- `parsed_brand`, `parsed_category`, `parsed_subcategory`
- `parsed_variant_name`, `parsed_strain_name`
- `parsed_pack_size`, `parsed_pack_count`
- `distributor_sku`

#### Stage 3: Catalog Matching (Enrichment)
**Source**: Sweed catalog API

**Flow**:
```
pending_purchase_rows (parsed taxonomy)
  → Sweed catalog search (dealer 210248)
  → Exact match attempt
  → Categorical match attempt (if exact fails)
  → UPDATE pending_purchase_rows (matched_product_id, evidence_tier)
```

**Decision Logic**:
- Exact match found → `evidence_tier='exact'`, `create_product=false`
- Categorical match found → `evidence_tier='categorical'`, `create_product=true`, use for pricing ref only
- No match → `evidence_tier='none'`, `create_product=true`, `create_group=true`

#### Stage 4: Market Research (Enrichment)
**Source**: Lit Alerts API

**Flow**:
```
pending_purchase_rows (parsed taxonomy)
  → Lit Alerts Products/menulistings
  → Calculate market average
  → UPDATE pending_purchase_rows (market_avg_price, competitor_listings)
```

**Data Captured**:
- Competitor prices (array)
- Market average (calculated)
- Competitor storefront URLs
- Availability by dispensary

#### Stage 5: Pricing Calculation (Enrichment)
**Inputs**: Cost, market data, brand MSO classification

**Flow**:
```
pending_purchase_rows (cost_per_unit, market_avg_price, parsed_brand)
  → Lookup MSO classification (module_annotations)
  → Calculate GM% target (MSO 60-67.5%, non-MSO 55-64.5%)
  → Apply market pressure check (1.13 × market_avg_price)
  → Calculate proposed_retail_price
  → Format to quarter-dollar ending
  → UPDATE pending_purchase_rows (proposed_retail_price, gm_percent)
```

**GM% Formula**:
```
gm_percent = (1 - (1.13 × cost_per_unit / proposed_retail_price)) × 100
```

#### Stage 6: Validation & Flagging (Enrichment)
**Logic**: Business rules validation

**Flow**:
```
pending_purchase_rows (all fields)
  → Validate required fields
  → Check MSO classification exists
  → Verify image sources (no Dutchie)
  → Check GM% within bounds
  → Check price formatting
  → UPDATE pending_purchase_rows (review_flags, mapping_status)
```

**Flags Generated**:
- "No MSO classification available"
- "Evidence tier: categorical (not exact)"
- "GM% below target floor (market pressure)"
- "Image scrubbed (Dutchie source)"
- "Multi-cultivar product"

#### Stage 7: Review & Approval (Manual)
**Interface**: Helios React UI

**Flow**:
```
Operator reviews packet in UI
  → Adjusts prices via sliders
  → Approves/rejects rows
  → UPDATE pending_purchase_rows (approval_status, approved_by_user, proposed_retail_price)
  → INSERT pending_purchase_apply_requests
```

#### Stage 8: Application (Mutation)
**Target**: Sweed catalog API

**Flow**:
```
pending_purchase_apply_requests (new record)
  → UPDATE status='running'
  → For each approved row:
      - Switch to state dealer (210248)
      - Create group (if needed)
      - Create product (if needed)
      - Create distributor link
      - Update purchase order position
      - UPDATE pending_purchase_rows (apply_status, created IDs)
  → UPDATE pending_purchase_apply_requests (status, stats)
```

**API Calls** (per row):
- `store.auth.dealer.set { dealerId: 210248 }`
- `store.product.group.create {...}` (if needed)
- `store.product.create {...}` (if needed)
- `store.distributor.product.create {...}` or `.update`
- `store.purchase.order.position.update {...}`

### 2.3 Caching Strategy

**LLM Parse Cache**:
- File: `cache/llm_parsed.json` (during transition)
- DB: Table `llm_parse_cache` (future)
- TTL: Indefinite (SKU patterns stable)
- Invalidation: Manual only

**Manifest Overrides**:
- File: Per-distributor `manifest_{name}.json`
- DB: Table `distributor_product_manifests` (future)
- Priority: Always highest
- Update: Manual operator edit

**Catalog Match Cache**:
- None (always query live)
- Rationale: Catalog changes frequently

**Market Data Cache**:
- None initially (always fresh)
- Future: 24-hour cache for repricing stability

## 3. External System Integration Points

### 3.1 Sweed POS API Integration

#### API Client Pattern

**Location**: `helios/src/worker/sweed/sweedClient.ts` (existing)

**Features**:
- RPC-style JSON over HTTP POST
- Bearer token auth (from config)
- Dealer context management (`dealer.set`, `dealer.get`)
- Retry logic with exponential backoff
- Error normalization

**Enhancement Needed**:
```typescript
export class SweedClient {
  // Add pending purchase specific methods
  async listPendingOrders(dealerId: number): Promise<PendingOrder[]>
  async getOrderDetails(orderId: string): Promise<OrderWithPositions>
  async getSuggestedProducts(orderId: string): Promise<SuggestedProduct[]>
  async createProductGroup(params: GroupCreateParams): Promise<GroupCreateResult>
  async createProduct(params: ProductCreateParams): Promise<ProductCreateResult>
  async linkDistributorProduct(params: DistributorLinkParams): Promise<DistributorLinkResult>
}
```

#### Error Handling

**Retry Policy**:
- Network errors: Retry 3x with backoff
- Rate limits (429): Retry with longer backoff
- Auth errors (401): Page Dave, no retry
- Validation errors (400): No retry, log details

**Circuit Breaker**:
- Open after 5 consecutive failures
- Half-open retry after 60 seconds
- Close after 2 successful calls

### 3.2 Lit Alerts API Integration

#### API Client Pattern

**Location**: `helios/src/worker/litalerts/litalertsClient.ts` (may exist)

**Auth**: Bearer + Cookie (from config or secrets)

**Methods**:
```typescript
export class LitAlertsClient {
  async searchMenuListings(params: MenuSearchParams): Promise<MenuListing[]>
  async getManufacturers(state: string): Promise<Manufacturer[]>
  async resolveProductIdentity(brand: string, productName: string): Promise<ProductMatches>
}
```

**Caching**:
- Manufacturer list: Cache 7 days
- Product searches: No cache (always fresh)

**Error Handling**:
- Session expiry: Attempt token refresh, else page Dave
- Rate limits: Backoff and retry
- No results: Not an error (return empty)

### 3.3 Bedrock Mantle LLM Integration

#### API Client Pattern

**Location**: `helios/src/worker/llm/mantleClient.ts` (may exist)

**Auth**: Bearer token from secrets

**Methods**:
```typescript
export class MantleClient {
  async parsePendingPurchaseSKU(params: SKUParseParams): Promise<ParsedTaxonomy>
  async advisoryQualityCheck(params: RowQualityParams): Promise<QualityVerdict>
}
```

**Registry Compliance**:
- Check `config/llm_use/registry.yaml` before calls
- Enforce `pending-purchase-taxonomy-classification` scope
- Track usage for cost monitoring

**Fallback**:
- Cache hit: Return cached result
- LLM unavailable: Return partial parse, flag for review
- Never block on LLM failure

### 3.4 Database Connection

**Pattern**: Helios PostgreSQL pool (existing)

**Connection**: Via `helios/src/server/db/pool.ts`

**Transaction Management**:
- Packet generation: Single transaction for packet + all rows
- Apply: NO transaction (Sweed API not transactional)
  - Update row status individually
  - Allow partial success
  - Track progress in DB

### 3.5 Secret Management

**Current State** (to be improved):
- Sweed token: Hardcoded (move to env var)
- Lit Alerts: HAR file (move to secrets)
- Mantle: File-based (`~/.secret/bedrock/mantle-bearer-token`)

**Target State**:
```typescript
// helios/src/server/config/secrets.ts
export const secrets = {
  sweed: {
    authToken: process.env.SWEED_AUTH_TOKEN,
    baseUrl: process.env.SWEED_API_URL
  },
  litAlerts: {
    bearerToken: process.env.LITALERTS_BEARER_TOKEN,
    cookie: process.env.LITALERTS_COOKIE
  },
  mantle: {
    bearerToken: process.env.MANTLE_BEARER_TOKEN,
    endpoint: process.env.MANTLE_ENDPOINT
  }
}
```

**Rotation**:
- Sweed: Manual, infrequent (page Dave on 401)
- Lit Alerts: Automated refresh (detect 401, re-auth, update)
- Mantle: Stable (no expiry observed)

### 3.6 Error Handling Strategy

**No Silent Failures** (per canonical spec):

Every external call must:
1. Log attempt (timestamp, params)
2. Await result or timeout
3. On success: Log success, return data
4. On failure:
   - Determine if transient (network, rate limit)
   - If transient: Retry with backoff
   - If permanent (auth, validation): Page Dave, abort
   - Never bury in logs or notes

**Page Dave Triggers**:
- Auth failure (401, 403)
- Repeated transient failures (> max retries)
- Data quality failure (> 20% rows unparseable)
- Cost overrun (LLM usage exceeds budget)
- Job timeout (> 2x expected duration)

**Structured Logging**:
```typescript
logger.error('Sweed API failure', {
  operation: 'createProductGroup',
  dealerId: 210248,
  params: {...},
  error: err.message,
  statusCode: 500,
  retryAttempt: 2,
  willRetry: true
})
```

## 4. Migration Execution Plan

### Phase 1: Backend Foundation (Week 1-2)
- [ ] Enhance database schema (add missing fields)
- [ ] Implement SweedClient enhancements
- [ ] Implement LitAlertsClient (or enhance existing)
- [ ] Implement SKU parser in `worker/pendingPurchases/skuParser.ts`
- [ ] Implement domain logic in `server/pendingPurchases/`

### Phase 2: Worker Jobs (Week 2-3)
- [ ] Complete `generatePendingPurchasePacketJob.ts`
- [ ] Complete `applyPendingPurchaseRequestJob.ts`
- [ ] Add cron scheduling config
- [ ] Add job monitoring and alerting

### Phase 3: Server Routes (Week 3)
- [ ] Complete API routes in `server/routes/pendingPurchases.ts`
- [ ] Add authentication/authorization
- [ ] Add input validation
- [ ] Add comprehensive error responses

### Phase 4: Client UI (Week 4-5)
- [ ] Create `client/routes/pendingPurchases/` structure
- [ ] Build packet list view
- [ ] Build packet detail/review view
- [ ] Implement price ladder controls
- [ ] Implement tree navigation
- [ ] Add approval workflows

### Phase 5: Testing & Validation (Week 5-6)
- [ ] Unit tests for all core functions
- [ ] Integration tests for jobs
- [ ] API endpoint tests
- [ ] UI component tests
- [ ] End-to-end test (generate → review → apply)

### Phase 6: Parallel Run & Cutover (Week 6-7)
- [ ] Run Helios generation alongside Python
- [ ] Compare outputs for parity
- [ ] Fix discrepancies
- [ ] Switch traffic to Helios
- [ ] Monitor for issues
- [ ] Archive Python scripts

## 5. Success Criteria

Migration is complete and successful when:

- [ ] All 24 leaf tasks marked complete
- [ ] Helios generates packets matching Python output
- [ ] All business rules preserved
- [ ] No silent failures (page Dave on all errors)
- [ ] Site-scoped verification implemented
- [ ] Price ladder, tree nav, click-to-new-tab work in UI
- [ ] Jobs run on schedule without failures
- [ ] Apply success rate > 95%
- [ ] Operator approval of UI/workflow
- [ ] Python scripts archived
- [ ] Documentation complete

## References

- Python generator: `catalog/purchases/2026-05-11/generate_combined_pending_packet.py`
- Existing contracts: `helios/src/shared/contracts/domain/pendingPurchases.ts`
- Existing jobs: `helios/src/worker/jobs/*PendingPurchase*.ts`
- Business rules: `docs/pending_purchases/BUSINESS_RULES.md`
- Data pipeline: `docs/pending_purchases/DATA_PIPELINE.md`
- External dependencies: `docs/pending_purchases/EXTERNAL_DEPENDENCIES.md`
- Module location: `docs/pending_purchases/HELIOS_LOCATION_DESIGN.md`
