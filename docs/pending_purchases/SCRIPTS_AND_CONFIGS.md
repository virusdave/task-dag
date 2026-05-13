# Pending Purchases Python Scripts and Configuration - Analysis

**Task**: Locate Pending Purchases Python scripts and configs  
**Issue**: #2  
**Created**: 2026-05-13

## Core Scripts

### 1. Generator Scripts
Primary location: `catalog/purchases/2026-05-11/`

- **`generate_combined_pending_packet.py`** - Main packet generator
  - Pulls live pending purchases from Midtown (210705) and Bronx (210249)
  - Generates `combined_pending_purchases_proposal.{json,html}`
  - Output includes detailed proposal cards and reviewer UI
  - Uses legacy generator with runtime patches

- **`_legacy_patches.py`** - Runtime patch layer
  - Wedges per-distributor manifest layer into legacy generator
  - Provides LLM cache integration
  - Implements brand GM-target overrides
  - Additive patches to `categories/2026-04-13/` generator

### 2. Application Scripts

- **`apply_combined_proposal.py`** - Live-write driver
  - Applies approved proposals to Sweed catalog
  - Creates products, groups, and distributor links
  - Generates `combined_apply_results.json`

- **`disable_just_created.py`** - Rollback utility
  - Disables incorrectly created products/groups
  - Used for error recovery

### 3. LLM Parser

- **`llm_parser.py`** - LLM-based taxonomy parser
  - Fallback for unhandled cultivar text
  - Integrates with Mantle Bedrock LLM
  - Uses cached results from `cache/llm_parsed.json`
  - Required for distributor SKU resolution

- **`prewarm_llm_parses.py`** - Parser validation
  - Validates LLM parses across pending purchase queues
  - Runs across both sites (Midtown + Bronx)

### 4. Legacy Foundation Scripts

Location: `categories/2026-04-13/`

- **`generate_pending_order_catalog_proposal.py`** - Original generator (2803+ lines)
  - Core business logic for proposal generation
  - Sweed API integration
  - Product matching and scoring
  - Line 2803: `"store.purchase.order.list"` call
  - Line 2817: `store.purchase.order.get` call

- **`apply_pending_order_catalog_proposal.py`** - Original apply script
  - Catalog mutation logic
  - Creates groups, products, distributor links

### 5. Helios Integration Scripts (TypeScript)

Location: Root directory

- **`import_po21_packet.ts`** - PO 21 packet import to Helios
  - Imports packets into Helios database
  - Uses `helios/src/server/pendingPurchases/pendingPurchasePacketImport.js`
  - Target: `pending_purchases_po21_packet.json`

- **`generate_review_packet.ts`** - Modern review UI generator
  - Generates responsive HTML review interface
  - Reads from `pending_purchase_rows` table
  - 33KB self-contained HTML output
  - No Helios UI dependencies

- **`enrich_po21_packet.ts`** - Packet enrichment
  - Enriches with catalog search results
  - Adds Lit Alerts market pricing
  - Calculates GM% pricing
  - Updates `pending_purchase_rows` table

- **`verify_po21_import.ts`** - Import verification
  - Validates packet import success

### 6. Supporting Scripts

- **`catalog/purchases/2026-05-11/fix_and_serve.ts`** - Local dev server
- **`catalog/purchases/2026-05-11/strip_dutchie.ts`** - Dutchie image removal

## Configuration Files

### 1. LLM Configuration
**Location**: `config/llm_use/registry.yaml`

```yaml
# Pending Purchase Taxonomy Classification (Limited Trial)
- backend: bedrock-mantle
  model: claude-3-5-sonnet-20241022
  use_case: pending-purchase-taxonomy-classification
  status: limited-trial
  scope: Midtown pending purchase packet generation only
```

### 2. Manifest Files

**Location**: `catalog/purchases/2026-05-11/`

- **`manifest_10ff.json`** - 10FF Distribution manifest
  - 32 line items
  - Authoritative for Stop 31 LLC orders
  - Includes METRC tags, SKU mappings

**Location**: `catalog/`
- **`10FF Distribution.pdf`** - Scanned source manifest

### 3. Data Files

**Packet Files**:
- `pending_purchases_po21_packet.json` - PO 21 packet (35 products, $21,532.50)
- `pending_purchases_manifest.{pdf,txt}` - Invoice manifest
- `pending_orders_analysis.json` - Analysis data

**Generated Outputs**:
- `combined_pending_purchases_proposal.json` - Proposal packet
- `combined_pending_purchases_proposal.html` - Review UI
- `combined_apply_results.json` - Application results
- `combined_pending_purchases_proposal_details/*.html` - Per-row detail pages

**Cache Files**:
- `catalog/purchases/2026-05-11/cache/llm_parsed.json` - LLM parse cache

## External Dependencies & Authentication

### 1. Sweed RPC
**Token location**: Hardcoded in `bulk_additions/2026-04-10/generate_product_catalog_attribute_analysis.py:18`
- Security debt: Token in repo (no agenix path yet)
- Must be refreshed on 401 errors
- Used for all Sweed API calls

### 2. Lit Alerts
**HAR location**: `categories/2026-04-13/brands.litalerts.com_Products_menulistings_Archive [26-04-13 22-28-32].har`
- Bearer token + Cookie headers rotated periodically
- Last refreshed: 2026-05-12
- Endpoint: `Products/menulistings`

**Additional HARs**:
- `catalog/brands.litalerts.com_Users_userhash_Archive [26-05-10 13-47-31].har`
- `catalog/prime.sweedpos.com_api__Archive [26-05-10 13-05-21].har`

### 3. Mantle LLM
**Token location**: `~/.secret/bedrock/mantle-bearer-token` (or via `MANTLE_BEARER_PATH`)
- Only used for LLM parser fallback
- Degrades gracefully if missing (when manifest + cache cover all SKUs)

## Execution Context

### Cron/Scheduling
- **Current**: Manual execution only
- **Future**: Should be integrated into Helios job scheduling

### Database
- **Helios DB**: `pending_purchase_rows` table
  - TigerData / Timescale service
  - Credentials in `~/.secret/tigerdata/`

### Dealer IDs
- **Midtown**: 210705
- **Bronx**: 210249
- **State catalog** (reads/writes): 210248

## Sweed API Calls Used

1. `store.auth.dealer.set` - Set dealer context
2. `store.purchase.order.list` - List pending orders (orderStatusId: 2)
3. `store.purchase.order.get` - Get order details
4. `store.distributor.product.suggestion` - Get product suggestions
5. Product/group creation and linking APIs (in apply scripts)

## Environment Variables

- `MANTLE_BEARER_PATH` - Optional override for Mantle token location
- Standard database connection vars (via Helios)

## Output Artifacts

### Generated Packets
- JSON format with full proposal data
- HTML reviewer UI with:
  - Responsive gradient design
  - Category-grouped product cards
  - Pricing display with GM% badges
  - Stats dashboard
  - Detail page per product

### Apply Results
- JSON record of created entities:
  - Products created
  - Groups created  
  - Distributor product links
  - Purchase order positions updated

## Key Locations Summary

| Component | Path |
|-----------|------|
| Current packet generator | `catalog/purchases/2026-05-11/generate_combined_pending_packet.py` |
| Legacy generator | `categories/2026-04-13/generate_pending_order_catalog_proposal.py` |
| Helios contracts | `helios/src/shared/contracts/domain/pendingPurchases.ts` |
| Helios routes | `helios/src/server/routes/pendingPurchases.ts` |
| Helios worker jobs | `helios/src/worker/jobs/generatePendingPurchasePacketJob.ts`, `importPendingPurchasePacketJob.ts`, `applyPendingPurchaseRequestJob.ts` |
| Helios DB queries | `helios/src/server/db/queries/pendingPurchaseQueries.ts` |
| Canonical spec | `docs/sweed/catalog/produce-pending-purchase-proposal.md` |
| Resume runbook | `catalog/purchases/RESUME_RUNBOOK.md` |

## Notes

- No standard Python package dependencies (uses stdlib: `urllib`, `json`, `re`, `pathlib`)
- All scripts currently one-off execution (not automated/scheduled)
- Helios integration partially complete (contracts, routes, jobs exist but not fully operational)
- Main workflow still Python-based, needs migration to Helios TypeScript codebase
