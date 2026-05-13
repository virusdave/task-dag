# Pending Purchases External Dependencies

**Task**: Identify external dependencies  
**Issue**: #2  
**Created**: 2026-05-13

## External Services

### 1. Sweed POS API
**Purpose**: Cannabis dispensary management system - primary data source

**Endpoints Used**:
- `store.auth.dealer.set` - Set dealer context before operations
- `store.purchase.order.list` - Query pending purchase orders
- `store.purchase.order.get` - Get detailed order information
- `store.distributor.product.suggestion` - Get product mapping suggestions
- Product/group creation and linking APIs (catalog writes)

**Authentication**:
- **Type**: Bearer token in RPC request body (`auth` field)
- **Current Location**: Hardcoded in `bulk_additions/2026-04-10/generate_product_catalog_attribute_analysis.py:18`
- **Security Status**: ⚠️ Known security debt - token in repo, no agenix/secrets management
- **Rotation**: Manual - capture from HAR when API returns 401
- **Capture Method**: HAR from `prime.sweedpos.com/api/` while authenticated

**Base URL**: `prime.sweedpos.com/api/`

**Dealer IDs**:
- Midtown: `210705`
- Bronx: `210249`
- State catalog (for reads/writes): `210248`

**API Patterns**:
- Stateful session - must call `dealer.set` before dealer-scoped operations
- RPC-style JSON over HTTP POST
- Response format: `{"result": {...}, "error": null}`

### 2. Lit Alerts (brands.litalerts.com)
**Purpose**: Cannabis market intelligence and competitor pricing data

**Endpoints Used**:
- `Products/menulistings` - Get market pricing for products
- `Products/fullcategoryitems` - Category-level product data
- `Users/userhash` - User/session management

**Authentication**:
- **Type**: Bearer token + Cookie-based session
- **Current Location**: Headers in HAR file `categories/2026-04-13/brands.litalerts.com_Products_menulistings_Archive [26-04-13 22-28-32].har`
- **Rotation**: Periodic (session-based)
- **Last Refreshed**: 2026-05-12
- **Rotation Method**: 
  1. Capture fresh HAR from any Lit Alerts endpoint
  2. Extract `Authorization` and `Cookie` headers from `log.entries[0].request.headers`
  3. Update corresponding headers in menu-listings HAR
  4. Do NOT change URL/body fields - generator depends on menu-listings shape

**Additional HAR Files** (for reference):
- `catalog/brands.litalerts.com_Users_userhash_Archive [26-05-10 13-47-31].har`
- `catalog/prime.sweedpos.com_api__Archive [26-05-10 13-05-21].har`

**Base URL**: `brands.litalerts.com`

**Data Provided**:
- Competitor storefront URLs
- Market pricing by product/category
- Product availability across dispensaries

### 3. Bedrock Mantle LLM
**Purpose**: LLM-based taxonomy classification for distributor SKU parsing

**Model**: Claude 3.5 Sonnet (20241022)

**Use Cases**:
- Fallback parser when manifest + cache don't cover distributor SKU
- Cultivar/strain name extraction
- Product taxonomy classification

**Authentication**:
- **Type**: Bearer token
- **Default Location**: `~/.secret/bedrock/mantle-bearer-token`
- **Override**: Via `MANTLE_BEARER_PATH` environment variable
- **Required On**: VPS3 and other remote hosts (must be provisioned via agenix or manual)

**Configuration**:
- **Registry**: `config/llm_use/registry.yaml` lines 10-19
- **Backend**: bedrock-mantle
- **Model**: claude-3-5-sonnet-20241022
- **Use Case**: `pending-purchase-taxonomy-classification`
- **Status**: limited-trial
- **Scope**: Midtown pending purchase packet generation only

**Graceful Degradation**:
- If token missing, LLM parser fails
- If manifest + cache cover all SKUs, LLM not needed
- Expansion beyond parser fallback requires registry update first

**Integration Point**: `catalog/purchases/2026-05-11/llm_parser.py`

**Cache**: `catalog/purchases/2026-05-11/cache/llm_parsed.json` - historical LLM parse results

## Database Dependencies

### 1. Helios Database (TigerData / Timescale)
**Purpose**: Storage for pending purchase proposals and operational data

**Connection**:
- **Service**: Production Tiger Data / Timescale service
- **Credentials Location**: `~/.secret/tigerdata/`
- **Old Local Container**: Shut down - do NOT use localhost assumptions

**Tables Used**:
- `pending_purchase_rows` - Main table for proposal data
  - Stores parsed purchase order line items
  - Enrichment data (catalog matches, pricing, GM%)
  - Review/approval state

**Migration Status**: TigerData migrations applied and verified

**Access Pattern**:
- TypeScript scripts use Helios DB connection
- Python scripts currently don't access (use Sweed directly)

## File System Dependencies

### 1. Manifest Files
**Purpose**: Authoritative distributor SKU mappings

**Key Files**:
- `catalog/10FF Distribution.pdf` - Scanned source manifest
- `catalog/purchases/2026-05-11/manifest_10ff.json` - Parsed manifest (32 line items)
  - Includes METRC tags
  - SKU to product mappings
  - Authoritative for Stop 31 LLC / 10FF Distribution orders

**Format**:
```json
{
  "distributor": "10FF Distribution",
  "orderId": "...",
  "lineItems": [
    {
      "distributorSKU": "...",
      "productName": "...",
      "metrcTag": "...",
      ...
    }
  ]
}
```

### 2. HAR Archive Files
**Purpose**: Captured HTTP sessions for API authentication

**Files**:
- `categories/2026-04-13/brands.litalerts.com_Products_menulistings_Archive [26-04-13 22-28-32].har`
- `catalog/brands.litalerts.com_Users_userhash_Archive [26-05-10 13-47-31].har`
- `catalog/prime.sweedpos.com_api__Archive [26-05-10 13-05-21].har`

**Contents**:
- Request/response data
- Authentication headers
- API endpoint patterns
- Session cookies

### 3. Cache Files
**Purpose**: Performance optimization and cost reduction

**Files**:
- `catalog/purchases/2026-05-11/cache/llm_parsed.json` - LLM parse results cache
  - Avoids re-parsing known SKUs
  - Reduces LLM API costs
  - Speeds up generation

## Python Package Dependencies

**Status**: None required

**Standard Library Only**:
- `urllib` - HTTP requests
- `json` - JSON parsing
- `re` - Regular expressions
- `pathlib` - File path handling
- `datetime`, `typing`, etc.

**Rationale**: Minimizes deployment complexity, no `pip install` needed

## TypeScript/Node Dependencies

**Managed By**: npm/package.json in `helios/` and root

**Key Dependencies** (from Helios):
- `pg` - PostgreSQL client
- `zod` - Schema validation
- Other Helios stack dependencies

**Build Status**: 
- `npm run typecheck` - clean
- `npm test` - 126/126 passing
- `npm run build` - clean (pre-existing >500 kB chunk warning only)

## System Requirements

### 1. Executables
- **Python 3**: For generator/apply scripts
- **Node.js/npm**: For TypeScript scripts and Helios
- **tsx**: TypeScript execution (via npx)
- **page-dave**: Operator notification command (must be on PATH)

### 2. Network Access
- `prime.sweedpos.com` (Sweed API)
- `brands.litalerts.com` (Lit Alerts)
- Bedrock Mantle endpoint (for LLM)
- TigerData/Timescale database endpoint

### 3. File System Access
- Read: HAR files, manifests, caches
- Write: Generated packets, apply results, logs
- Database credentials in `~/.secret/`

## Security & Secrets Management

### Current State
- **Sweed Token**: ⚠️ Hardcoded in repo - security debt
- **Lit Alerts**: Stored in HAR files - rotates periodically
- **Mantle Token**: External file (`~/.secret/bedrock/mantle-bearer-token`)
- **Database Credentials**: External file (`~/.secret/tigerdata/`)

### Required Improvements
1. Move Sweed token to agenix/secrets management
2. Automate Lit Alerts token rotation
3. Centralize all secrets in agenix
4. Remove hardcoded credentials from repo

## Environment Variables

### Current
- `MANTLE_BEARER_PATH` - Optional override for Mantle token location

### Future (for Helios migration)
- Database connection strings
- API endpoint URLs
- Service credentials
- Feature flags

## Deployment Dependencies

### Host Requirements
- **VPS3** or similar Linux host
- NixOS 25.11 (current deployment platform)
- Tailnet access (for mss-one-offs publishing)

### Services
- **mss-one-offs**: For publishing review packets to tailnet URLs
  - Control socket: `/run/mss-one-offs/control.sock`
  - Incoming dir: `/var/lib/mss-one-offs/incoming/`
  - Currently **not deployed** on VPS3 (blocker for publishing)

### Optional
- **Helios**: Full stack deployment
  - Google OAuth configured
  - Sweed integration
  - Lit Alerts integration  
  - Bedrock configured

## Monitoring & Alerting

### Current
- **page-dave**: Manual operator notifications
- No automated monitoring
- No health checks
- No metrics collection

### Future Needs
- Job execution monitoring
- Failure alerting
- API rate limiting
- Cost tracking (LLM usage)
- Data freshness monitoring

## Rate Limits & Quotas

### Known Limits
- **Lit Alerts**: Session-based, undefined request limits
- **Mantle LLM**: Usage limited by Bedrock quotas
- **Sweed API**: No documented limits (internal system)

### Current Usage Patterns
- Batch processing (not real-time)
- Infrequent execution (manual trigger)
- LLM cache reduces API calls significantly

## Error Handling Requirements

### Per Canonical Spec (`docs/sweed/catalog/produce-pending-purchase-proposal.md`)

**No Silent Failures**:
- Every Sweed read must succeed or page Dave
- Every Lit Alerts query must succeed or page Dave
- Every image fetch must succeed or page Dave
- Every LLM call must succeed or page Dave
- Nothing gets buried in a log or note

**Site-Scoped Operations**:
- Must call `store.auth.dealer.set` before dealer-specific reads
- Must verify `currentDealerId` matches expected
- Catalog writes always from state dealer 210248

## Integration Points Summary

| Service/System | Purpose | Auth Method | Rotation | Critical? |
|---------------|---------|-------------|----------|-----------|
| Sweed API | Primary data source | Hardcoded token | Manual | YES |
| Lit Alerts | Market pricing | HAR headers | Periodic | YES |
| Bedrock Mantle | LLM parsing | Bearer token file | Stable | CONDITIONAL |
| TigerData DB | Data storage | Credential file | Stable | YES (for Helios) |
| mss-one-offs | Publishing | Unix socket | N/A | NO (for review UI) |

## Migration Notes

**Current Architecture**: Python-based one-off scripts

**Target Architecture**: Helios-integrated TypeScript jobs

**Dependencies That Change**:
- Python stdlib → Node.js packages
- HAR-based auth → Proper API clients
- Manual execution → Scheduled jobs
- File-based output → Database-backed UI

**Dependencies That Stay**:
- Sweed API (same endpoints, same data)
- Lit Alerts (same data source)
- TigerData database (same storage)
- Core business logic patterns
