# Pending Purchase Image Sourcing Architecture

**Status**: Designed, ready for implementation  
**Reviewer**: Oracle (approved 2026-05-12)

## Core Concept: brand-variant-family

**NEW FORMAL TERM** - The canonical product identity for pricing-level matching:

```typescript
interface BrandVariantFamily {
  category: string           // "Pre-Rolls", "Flower", "Vapes"
  subcategory: string | null // "Infused" | null
  brand: string              // "SMACK", "Happy Purps"
  size: string               // "1g", "3.5g", "100mg"
  packCount: number          // 1, 5, 10, 32
}

type BrandVariantFamilyKey = string  // "pre-rolls|infused|smack|1g|1"
```

This is the **lowest-level pricing group** identity used across:
- Pending purchases (parsed product names)
- Sweed catalog (NormalizedCatalogGroupLiveState)
- Lit Alerts (market listings)
- Competitor products (scraped from ecom sites)

## Two-Tier Matching Strategy

### Tier 1: Exact SKU Matching (Highest Confidence)
- Match manufacturer SKU/GTIN/UPC/METRC IDs
- Extract from JSON-LD, data attributes, visible SKU strings
- Confidence: 1.0 when system+value match exactly
- Auto-apply with minimal review

### Tier 2: Brand-Variant-Family Matching
- Match when BrandVariantFamilyKey is identical across systems
- Lower confidence than exact SKU
- Requires human approval before auto-apply
- Used when no exact SKU match exists

## LLM-Powered Learning System

Reuses existing `PendingPurchaseLlmTeachingEnvelope` pattern:

1. **Classification** - LLM determines match tier and confidence
2. **Teaching** - LLM proposes reusable parsing rules
3. **Persistence** - Rules stored in existing DB tables:
   - `pending_purchase_brand_profiles`
   - `pending_purchase_brand_aliases`
   - `pending_purchase_parse_rules`
   - `pending_purchase_parse_observations`

4. **Runtime** - System applies learned rules before calling LLM
5. **Safety** - Auto-promote only high-confidence, low-risk rules

## Sitemap Crawling Strategy

```typescript
// Job: competitor.sitemap.crawl
1. Fetch competitor sitemaps (with retry/backoff)
2. Parse XML → collect product URLs
3. Filter by include/exclude patterns
4. Store in competitor_product_page_inventory

// Job: competitor.product.crawl  
1. Fetch product HTML
2. Extract JSON-LD, selectors, attributes
3. Normalize to BrandVariantFamily
4. Validate and download images
5. Store matches in pending_purchase_competitor_matches
```

## Image Validation Pipeline

Reuses existing `imageSafety.ts`:

1. `validatePendingPurchaseImageUrl` - HTTPS, public host only
2. `downloadValidatedImageAsset` - content-type, size, signature validation
3. Redirect handling with safety checks
4. Store validated images with metadata (hash, dimensions)

## Integration Points

### Enrichment Pipeline
```
1. Import PO → Parse names (existing)
2. Build BrandVariantFamily per row
3. NEW: competitor.image_sourcing job
   - Match via Tier 1 (exact SKU) or Tier 2 (family)
   - Call LLM when ambiguous
   - Store top candidates in DB
4. Review UI shows proposed images
5. Apply job downloads approved images
```

### Database Schema (New Tables)

```sql
create table competitor_product_page_inventory (
  id bigserial primary key,
  site_key text not null,
  url text not null,
  last_seen_at timestamptz not null default now(),
  last_crawled_at timestamptz,
  status text not null default 'new',
  error_message text,
  metadata_json jsonb not null default '{}',
  unique (site_key, url)
);

create table competitor_product_images (
  id bigserial primary key,
  site_key text not null,
  url text not null,
  final_url text not null,
  content_type text not null,
  byte_size integer not null,
  width integer,
  height integer,
  hash_sha256 text not null,
  created_at timestamptz not null default now()
);

create table pending_purchase_competitor_matches (
  id bigserial primary key,
  pending_purchase_row_id bigint not null,
  site_key text not null,
  competitor_url text not null,
  image_id bigint references competitor_product_images(id),
  match_tier text not null,  -- 'tier1_sku' | 'tier2_family'
  confidence numeric(3,2) not null,
  rationale text,
  brand_variant_family_key text not null,
  created_at timestamptz not null default now(),
  unique (pending_purchase_row_id, site_key)
);
```

## Configuration Structure

### Static (Git-backed)
`automation/config/competitor_sites/<site>.yaml`:

```yaml
site_key: "leafly"
host: "www.leafly.com"
sitemaps:
  - "https://www.leafly.com/sitemap-products.xml"
url_filters:
  include_patterns: ["^/dispensary-menu/[^/]+/product/.*$"]
product_page:
  title_selector: "h1.product-title"
  brand_selector: ".ProductHeader-brand a"
  category_breadcrumb_selector: "nav.breadcrumbs a"
  image_selectors: ["img.ProductGallery-image"]
  sku_selectors: ["[data-sku]"]
normalization:
  size_patterns:
    - regex: "(\\d+(?:\\.\\d+)?)(g|mg)"
  pack_count_patterns:
    - regex: "(\\d+)[- ]?pack"
llm:
  enabled: true
  max_attempts: 2
  min_confidence_for_autorule: 0.85
```

### Dynamic (DB-backed)
Learned rules via LLM teaching envelopes stored in existing tables.

## Safety Guardrails

1. **LLM Hallucinations**
   - Confidence thresholds + risk flags
   - Auto-persist only narrow, high-confidence rules
   - State machine: draft → provisional → active

2. **Site Changes**
   - Selectors in per-site config (easy updates)
   - Prefer JSON-LD over brittle selectors
   - LLM fallback on raw HTML

3. **Legal/ToS**
   - Respect robots.txt
   - Rate limiting
   - Proper user-agent

4. **Bad Matches**
   - Tier 1/2 separation with explicit UI flags
   - No auto-apply for Tier 2 without human approval
   - Full audit trail

## LLM Registry Entry

Add to `automation/config/llm_use/registry.yaml`:

```yaml
- backend: bedrock-mantle
  model: google.gemma-3-27b-it
  use_case: pending-purchase-competitor-image-sourcing
  scope: Competitor product matching and image sourcing for pending purchases
  status: approved
  approver: dave
  approval_date: 2026-05-12
  notes: Reuses existing teaching envelope pattern from pending purchase parser
```

## Performance Targets

- **Sitemap crawl**: 1000 URLs/minute
- **Product extraction**: 100 products/minute (with LLM fallback)
- **Image validation**: 50 images/minute
- **Match quality**: >95% accuracy for Tier 1, >85% for Tier 2

## Implementation Phases

### Phase 1: Foundation (PO 21 focus)
1. Define `BrandVariantFamily` types and key generation
2. Create DB tables and migrations
3. Implement sitemap crawler for 1-2 competitors
4. Build product extraction with JSON-LD parsing
5. Integrate image safety pipeline

### Phase 2: LLM Learning
1. Extend teaching envelope for competitor context
2. Implement classification + rule generation
3. Add runtime rule application
4. Build confidence scoring

### Phase 3: Integration
1. Add to enrichment pipeline
2. Update review UI to show competitor matches
3. Wire into apply job for image downloads
4. Add monitoring/observability

### Phase 4: Scale
1. Add more competitor sites
2. Optimize caching and batch processing
3. Build regression test suite
4. Consider advanced path (embeddings, etc.) if needed

## References

- Existing patterns: `generatePendingPurchasePacketJob.ts`
- Image safety: `helios/src/worker/pendingPurchases/imageSafety.ts`
- LLM teaching: `PendingPurchaseLlmTeachingEnvelopeSchema`
- Market data: `helios/src/worker/pricing/litAlertsMarket.ts`
