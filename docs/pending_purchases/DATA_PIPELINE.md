# Pending Purchases Data Pipeline Documentation

**Task**: Document Pending Purchases data pipeline  
**Issue**: #2  
**Created**: 2026-05-13

## Overview

The Pending Purchases system processes outstanding purchase orders from distributors and generates catalog mutation proposals to map distributor products into the Sweed POS system. The pipeline operates in two phases: **Generation** (creating proposals) and **Application** (executing approved changes).

## Pipeline Stages

### Stage 1: Data Collection

**Input Sources**:
- Sweed POS API (live purchase orders)
- Purchase order positions (line items)
- Distributor product suggestions

**API Calls**:
1. `store.auth.dealer.set { dealerId }` - Set dealer context
2. `store.purchase.order.list { orderStatusId: 2 }` - Fetch pending orders
3. `store.purchase.order.get { id }` - Get order details with positions
4. `store.distributor.product.suggestion { orderId }` - Get existing mappings

**Dealer Contexts**:
- Midtown: `210705`
- Bronx: `210249`

**Filter Criteria**:
- Orders with `orderStatusId = 2` (pending status)
- Positions with no `suggestedProduct` OR
- Positions mapped to placeholder products (e.g., "Preroll Samples Samples")

**Data Schema (Order)**:
```json
{
  "id": "order_id",
  "dealerId": "210705",
  "distributorId": "...",
  "orderStatusId": 2,
  "positions": [
    {
      "id": "position_id",
      "distributorProductName": "BS Ice Cream Swirl 14g",
      "quantity": 10,
      "costPerUnit": 25.00,
      "suggestedProduct": null
    }
  ],
  "unresolvedPositionCount": 15
}
```

### Stage 2: SKU Parsing & Product Identification

**Input**: Distributor product names (SKUs)

**Processing Path** (waterfall logic):

1. **Manifest Override Check**
   - Input: `distributorProductName`
   - Source: `catalog/purchases/2026-05-11/manifest_10ff.json`
   - Contains: 32 authoritative mappings for 10FF Distribution
   - If match found → use manifest data (includes METRC tags, brand, variant)
   
2. **LLM Cache Check**
   - Input: `distributorProductName`
   - Source: `catalog/purchases/2026-05-11/cache/llm_parsed.json`
   - Historical LLM parse results
   - If match found → use cached parse
   
3. **LLM Parse (Fallback)**
   - Service: Bedrock Mantle (Claude 3.5 Sonnet)
   - Input: Distributor SKU + sibling line items as context
   - Output: Structured taxonomy classification
   - Cached for future use

**Parsed Output Schema**:
```json
{
  "brand": "Smartbud",
  "category": "Flower",
  "subcategory": "Shake",
  "variant": "Ice Cream Swirl Shake 14g",
  "strain": "Ice Cream Swirl",
  "packSize": "14g",
  "metrcTag": "1A4..."
}
```

**Runtime Patch Layer** (`_legacy_patches.py`):
- Intercepts `parse_product_name()` calls
- Applies manifest overrides first
- Falls through to LLM cache
- Injects brand GM overrides (Stop 31: 67.5%)

### Stage 3: Catalog Matching

**Input**: Parsed product taxonomy

**Operations**:
1. Switch to state catalog dealer (`210248`)
2. Search Sweed catalog for matching products
3. Matching tiers (in preference order):
   - **Exact normalized product match**: Same brand, strain, variant, pack size
   - **Brand-categorical-variant equivalent**: Same brand, category, generic variant (e.g., 0.5g preroll 2-pack)
   - Different pack counts/brands NOT equivalent

**API Calls**:
- Catalog product search (implicit in legacy generator)
- Brand/group/variant lookups

**Output**:
- Matched Sweed product ID (if exists)
- Match evidence tier
- Catalog gaps identified

### Stage 4: Market Research & Pricing

**Input**: Parsed product + catalog match status

**External Data Sources**:

1. **Lit Alerts API**
   - Endpoint: `Products/menulistings`
   - Auth: HAR-based (Bearer + Cookie)
   - Data: Statewide market pricing, competitor listings
   - Geographic: NY dispensaries
   
2. **Competitor Sitemaps** (deferred - not yet implemented)
   - Fetch competitor storefront sitemaps
   - Parse product URLs for evidence links
   - LLM advisory pass to match products

**Pricing Calculation**:

1. **Determine Brand Classification**:
   - Check `module_annotations` (kind='mso') for brand
   - Default: Non-MSO if no annotation
   - Flag reviewer if classification unknown

2. **Calculate GM Target**:
   - MSO brands: 60-67.5% GM
     - Stop 31 + co-located brands: 67.5% (Herb directive)
   - Non-MSO brands: 55-64.5% GM

3. **Market Pressure Check**:
   - Competitor pressure: `1.13 × pre-tax average competitor price`
   - Overrides GM floor if market incompatible

4. **Price Formatting**:
   - Quarter-dollar endings: .00, .25, .50, .75
   - Prefer .00 and .50
   - No charm pricing

**Output Schema (Enriched Row)**:
```json
{
  "distributorProductName": "BS Ice Cream Swirl 14g",
  "parsedBrand": "Smartbud",
  "parsedVariant": "Ice Cream Swirl Shake 14g",
  "category": "Flower",
  "subcategory": "Shake",
  "costPerUnit": 25.00,
  "proposedRetailPrice": 55.00,
  "gmPercent": 54.5,
  "marketAvgPrice": 50.00,
  "competitorListings": [...],
  "evidenceTier": "brand-categorical-variant",
  "matchedProductId": null,
  "createProduct": true,
  "createGroup": true,
  "reviewFlags": ["No MSO classification available"]
}
```

### Stage 5: Aggregation & Grouping

**Hierarchy**:
```
Site (Midtown/Bronx)
  └─ Category (Flower, Pre-Rolls, Vapes, etc.)
      └─ Subcategory (Shake, Infused, Live Resin, etc.)
          └─ Variant (Ice Cream Swirl Shake 14g)
              └─ Brand (Smartbud)
                  └─ Rows (individual line items)
```

**Aggregations**:
- Count of rows per hierarchy level
- Total cost per group
- Total proposed retail per group
- Average GM% per group
- Order count, product count, brand count

**Navigation Tree**:
- Left-side tree-nav control
- Clickable navigation to each level
- Escape key toggle for sidebar
- Row counts at each level

### Stage 6: Reviewer Packet Generation

**Output Artifacts**:

1. **JSON Packet** (`combined_pending_purchases_proposal.json`)
   - Complete structured data
   - All enrichment fields
   - Evidence links
   - Calculation details

2. **HTML Review UI** (`combined_pending_purchases_proposal.html`)
   - Responsive gradient design
   - Category-grouped product cards
   - **Price ladder control** (per row):
     - Hover shows source detail (current/proposed/competitor/market/GM band)
     - Proposed-price marker is **slider-draggable**
     - Updates proposed price live as slider moves
   - **Group sliders**: Drag all contained rows proportionally
     - Respects individual GM bands
     - Honors cost basis (floor/ceiling)
   - **Tree navigation sidebar**:
     - Mirrors full hierarchy
     - Escape toggle for show/hide
   - **Click-to-new-tab**:
     - Row click opens detail page
     - Competitor listing click opens storefront URL (not Lit Alerts)
   - Stats dashboard (products, categories, brands, total cost/revenue)
   - Self-contained (33KB), no Helios UI dependencies

3. **Detail Pages** (`combined_pending_purchases_proposal_details/*.html`)
   - Per-row detailed analysis
   - Competitor pricing tables
   - Evidence tier explanations
   - Image preview (scrubbed of Dutchie sources)
   - METRC tag display (when available from manifest)

**Data Flow for Rendering**:
```
Enriched rows 
  → Group by hierarchy (site/cat/sub/var/brand)
  → Generate navigation tree HTML
  → Render grouped product tables
  → Generate detail pages
  → Inject price ladder controls
  → Write JSON + HTML files
```

### Stage 7: Human Review & Approval

**Manual Step**:
1. `page-dave` notification sent
2. Operator reviews packet in Firefox (NOT Chrome)
3. Operator uses price sliders to adjust proposals
4. Operator approves, rejects, or requests regeneration

**No Auto-Actions**:
- No auto-open in Chrome
- No silent failures
- All blockers page Dave

### Stage 8: Application (Approved Proposals Only)

**Script**: `apply_combined_proposal.py`

**Input**: Approved `combined_pending_purchases_proposal.json` (possibly with manual price adjustments)

**Operations** (via Sweed API):

1. **Switch to State Catalog Dealer** (`210248`)
   - All catalog writes use this dealer context
   
2. **Create Product Groups**:
   - For rows marked `createGroup: true`
   - API: Group creation endpoints
   - Attributes: Name, category, subcategory, brand
   
3. **Create Variant Products**:
   - For rows marked `createProduct: true`
   - API: Product creation endpoints
   - Attributes: Name, group, pack size, pricing, images
   
4. **Create/Update Distributor Product Links**:
   - Link distributor SKUs to Sweed products
   - API: Distributor product mapping endpoints
   - Enables future order auto-mapping
   
5. **Update Purchase Order Positions**:
   - Set `suggestedProduct` on order positions
   - Resolves pending order line items
   
6. **Create Taxonomy Attributes** (strains, effects, flavors):
   - Backfill missing attributes
   - Link to products/variants

**Transactional Behavior**:
- Not truly transactional (Sweed API limitation)
- Partial failures can occur
- Rollback via `disable_just_created.py` if needed

**Error Handling**:
- Every API call checked for success
- Failures page Dave immediately
- No silent failures
- Detailed logging to `combined_apply_results.json`

**Output** (`combined_apply_results.json`):
```json
{
  "timestamp": "2026-05-11T...",
  "packetPath": "...",
  "summary": {
    "rowsProcessed": 37,
    "groupsCreated": 35,
    "productsCreated": 37,
    "distributorLinksCreated": 37,
    "purchaseOrderPositionsUpdated": 37,
    "strainsCreated": 15,
    "effectsCreated": 8,
    "flavorsCreated": 12
  },
  "details": [
    {
      "rowIndex": 0,
      "distributorProductName": "...",
      "groupCreated": { "id": 12345, "name": "..." },
      "productCreated": { "id": 67890, "name": "..." },
      "distributorLinkCreated": { "id": 11111 }
    }
  ],
  "errors": []
}
```

### Stage 9: Database Persistence (Helios Path)

**Script**: `import_po21_packet.ts`, `enrich_po21_packet.ts`

**Table**: `pending_purchase_rows` (TigerData/Timescale)

**Operations**:
1. Import packet JSON into database rows
2. Enrich with catalog search results
3. Enrich with Lit Alerts pricing
4. Calculate GM% pricing
5. Update status fields

**Schema** (simplified):
```sql
CREATE TABLE pending_purchase_rows (
  id SERIAL PRIMARY KEY,
  order_id TEXT,
  position_id TEXT,
  distributor_product_name TEXT,
  parsed_brand TEXT,
  parsed_variant TEXT,
  category TEXT,
  cost_per_unit NUMERIC,
  proposed_retail_price NUMERIC,
  gm_percent NUMERIC,
  catalog_match_id INTEGER,
  evidence_tier TEXT,
  review_status TEXT,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ
);
```

**Helios Integration Points**:
- Routes: `helios/src/server/routes/pendingPurchases.ts`
- Worker jobs:
  - `generatePendingPurchasePacketJob.ts`
  - `importPendingPurchasePacketJob.ts`
  - `applyPendingPurchaseRequestJob.ts`
- DB queries: `helios/src/server/db/queries/pendingPurchaseQueries.ts`
- Contracts: `helios/src/shared/contracts/domain/pendingPurchases.ts`

## Data Formats

### Input Formats

**Sweed API Responses**: JSON-RPC style
```json
{
  "result": { ... },
  "error": null
}
```

**Lit Alerts HAR**: HTTP Archive (JSON)
- Contains full request/response data
- Auth headers extracted from `log.entries[0].request.headers`

**Manifest JSON**:
```json
{
  "distributor": "10FF Distribution",
  "orderId": "131845",
  "lineItems": [
    {
      "sku": "1O-HIFCIV.5",
      "productName": "Herb Forbidden Fruit Infused Vape 0.5g",
      "brand": "Herb",
      "metrcTag": "1A4..."
    }
  ]
}
```

### Output Formats

**Proposal Packet JSON**: Structured proposal data
**Review HTML**: Self-contained static HTML with embedded CSS/JS
**Detail Pages**: Individual HTML pages per row
**Apply Results JSON**: Execution log with created entity IDs

## Performance Characteristics

### Current Performance
- **Not optimized for scale**: Sequential processing
- **API call volume**: O(n) calls per order position
- **LLM calls**: Cached where possible, fallback only
- **Generation time**: ~2-5 minutes for 30-50 line items
- **Apply time**: ~5-10 minutes for 30-50 line items

### Bottlenecks
1. Sequential API calls (no parallelization)
2. LLM parsing for uncached SKUs (~1-2 sec each)
3. Lit Alerts queries (rate-limited by session)
4. Manual review step (human in loop)

### Caching Strategy
- **LLM parses**: File-based cache (`cache/llm_parsed.json`)
- **Manifest overrides**: Priority over cache
- **No API response caching**: Always fetch live data

## Error Handling & Quality Gates

### Per Canonical Spec Requirements

**No Silent Failures**:
- Every Sweed read must succeed or page Dave
- Every Lit Alerts query must succeed or page Dave
- Every image fetch must succeed or page Dave
- Every LLM call must succeed or page Dave
- Nothing buried in logs/notes

**Site-Scoped Verification**:
- Must call `dealer.set` before dealer-specific reads
- Must verify `currentDealerId` matches expected
- Catalog writes always from state dealer 210248

**Quality Flags**:
- Missing MSO classification → flag for reviewer
- Evidence tier < exact match → label clearly
- Missing images → flag with source info
- Dutchie images → scrub and flag
- Ambiguous brand attribution → page Dave

## Migration Path to Helios

### Current Architecture
- Python-based one-off scripts
- HAR file authentication
- File system outputs
- Manual execution

### Target Architecture (Helios)
- TypeScript job system
- Proper API clients
- Database-backed UI
- Scheduled execution
- React UI with same affordances

### Data Pipeline Changes
**Inputs**: Same (Sweed API, Lit Alerts, LLM)
**Processing**: TypeScript instead of Python
**Storage**: Database-first instead of file-first
**UI**: React components instead of static HTML
**Scheduling**: Helios worker jobs instead of manual

### Must Preserve
- Price ladder with draggable sliders
- Group-level proportional sliders
- Tree navigation with Escape toggle
- Click-to-new-tab competitor links
- LLM quality pass
- No silent failures policy
- Site-scoped verification rules

## Monitoring & Observability

### Current State
- Manual `page-dave` notifications only
- No automated monitoring
- Apply results JSON for post-mortem
- No metrics collection

### Future Needs
- Job execution metrics (duration, success rate)
- API call volume/latency tracking
- LLM usage and cost tracking
- Error alerting
- Data freshness monitoring
- Queue depth tracking (pending orders)
- Manual review SLA tracking

## Security Considerations

### Current Vulnerabilities
- Sweed token hardcoded in repo
- Lit Alerts auth in HAR files
- No secrets rotation automation

### Remediation Plan
1. Move Sweed token to agenix
2. Implement Lit Alerts auto-rotation
3. Centralize all secrets in `~/.secret/`
4. Audit trail for all catalog mutations
5. Role-based access controls (future Helios)

## Appendix: File Locations

| Component | Path |
|-----------|------|
| Generator script | `catalog/purchases/2026-05-11/generate_combined_pending_packet.py` |
| Apply script | `catalog/purchases/2026-05-11/apply_combined_proposal.py` |
| Runtime patches | `catalog/purchases/2026-05-11/_legacy_patches.py` |
| LLM parser | `catalog/purchases/2026-05-11/llm_parser.py` |
| Manifest (10FF) | `catalog/purchases/2026-05-11/manifest_10ff.json` |
| LLM cache | `catalog/purchases/2026-05-11/cache/llm_parsed.json` |
| Output packet | `catalog/purchases/2026-05-11/combined_pending_purchases_proposal.{json,html}` |
| Apply results | `catalog/purchases/2026-05-11/combined_apply_results.json` |
| Canonical spec | `docs/sweed/catalog/produce-pending-purchase-proposal.md` |
| Helios contracts | `helios/src/shared/contracts/domain/pendingPurchases.ts` |
| Helios routes | `helios/src/server/routes/pendingPurchases.ts` |
| Helios jobs | `helios/src/worker/jobs/*PendingPurchase*Job.ts` |
