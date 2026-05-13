# Pending Purchases Business Rules

**Task**: Extract and document business rules  
**Issue**: #2  
**Created**: 2026-05-13

## Overview

This document captures the core business rules, scoring algorithms, filtering logic, and decision criteria used in the Pending Purchases Product Proposals system. These rules must be preserved when migrating from Python to Helios TypeScript.

## Product Matching Rules

### Matching Preference Hierarchy

1. **Exact Normalized Product Match** (Tier 1 - Preferred)
   - Same brand
   - Same strain/cultivar/flavor
   - Same variant/form factor
   - Same pack size
   - Example: "Herb Forbidden Fruit Vape 0.5g" → existing "Herb Forbidden Fruit Vape 0.5g"

2. **Brand-Categorical-Variant Equivalent** (Tier 2 - Acceptable)
   - Same brand
   - Same category
   - Same generic variant (e.g., "0.5g preroll 2-pack")
   - Different strain/flavor acceptable
   - Example: "Preferred Gardens Gelato Preroll 2-pack" → "Preferred Gardens OG Kush Preroll 2-pack" (for pricing reference only)
   
3. **NOT Equivalent** (Tier 3 - Reject)
   - Different pack counts (2-pack vs 5-pack)
   - Different brands
   - Different categories
   - Different product types (cartridge vs disposable)

### Matching Evidence Requirements

- **Evidence tier must be labeled** on every row for reviewer visibility
- **Exact match preferred** for cost/pricing basis
- **Categorical equivalents** used only for market pricing reference
- **No silent downgrades** - missing exact match must flag for review

## Filtering Rules

### Unmapped Position Criteria

A purchase order position requires a proposal if:

1. **No suggested product** (`suggestedProduct == null`), OR
2. **Mapped to placeholder product**:
   - "Preroll Samples Samples"
   - Other known placeholder names
   
**Not filtered out** for:
- Missing cost (cost gap is flagged, not excluded)
- Unknown distributor
- Missing METRC wholesale price

### Site-Specific Filtering

- **Include all pending orders** from both sites (Midtown 210705, Bronx 210249)
- **Date range**: Current outstanding orders (no historical cutoff)
- **Order status**: `orderStatusId = 2` (pending only)
- **No quantity filter**: Include positions of any quantity (even 1 unit)

## Pricing Rules

### GM% Target Bands

**MSO (Multi-State Operator) Brands**:
- Target: **60% – 67.5% GM** (post-tax)
- Special case: **Stop 31 LLC + co-located brands → 67.5% GM exactly**
  - Affected brands: Herb, Doobie Labs, Jungle Girl, Moonlit Hash Co, Preferred Gardens, Purps, Runtz, Smartbud, Strain Gang
  - Rationale: Marketing discounts via promos (not base price)

**Non-MSO Brands**:
- Target: **55% – 64.5% GM** (post-tax)
- Default for brands without MSO classification

**MSO Classification Lookup**:
- Source: `module_annotations` table (kind='mso', scope_ref=brandId)
- Default: **Non-MSO** if no annotation exists
- **Flag for review** if classification unknown

### GM% Formula

```
GM% = 1 - (1.13 × cost / price)
```

Where:
- `cost` = wholesale cost per unit
- `price` = proposed retail price
- `1.13` = tax multiplier (NY cannabis tax)

### Competitor Pressure Override

Market-based pricing can override GM floor:

1. Calculate competitor pressure: `1.13 × average_competitor_price`
2. Target a few percent below competitor pressure
3. **Exception**: If achieving target GM is incompatible with competitor pressure:
   - Acceptable to go below 55% GM
   - Only when driven by market competition
   - Not for any other reason

**Example**:
- Cost: $25
- Average competitor price (pre-tax): $45
- Competitor pressure (post-tax): $50.85
- Target below competitor: $48-50
- Calculated GM at $48: 43% (below 55% floor)
- **Decision**: Acceptable due to market pressure

### Price Formatting Rules

**Quarter-Dollar Endings**:
- Allowed: `.00`, `.25`, `.50`, `.75`
- Preferred: `.00` and `.50` over `.25` and `.75`
- Forbidden: Charm pricing (`.99`, `.95`, etc.)

**Examples**:
- Good: $45.00, $45.50
- Acceptable: $45.25, $45.75
- Bad: $45.99, $45.95, $45.37

### Categorical Price Consistency

- **Same brand + same cost + same size → same price**
- Applies to categorically equivalent items
- Example: All "Herb 0.5g Vape Cartridges" with $12 cost should have same price, regardless of strain

### Sample Pricing

- **Do not leave samples unpriced**
- Use best available cost basis (even if nominal)
- Near-100% GM acceptable for samples
- Better to have a price than no price

## Product Proposal Scoring/Ranking

### No Explicit Scoring Algorithm

The current Python system does NOT implement a numeric scoring/ranking algorithm. Instead, it uses:

1. **Hierarchical grouping** for organization:
   - Site → Category → Subcategory → Variant → Brand
   
2. **Alphabetical sorting** within groups:
   - Groups sorted alphabetically by name
   - Rows sorted alphabetically within groups
   
3. **Manual review prioritization** by operator:
   - Reviewer uses tree navigation to find areas
   - Visual indicators: missing images, price flags, evidence tier
   - No auto-prioritization

### Future Scoring Considerations

If implementing auto-prioritization (not currently present), consider:

- **High urgency**: Large quantity orders, high total value
- **Low confidence**: Categorical match only, no images, unknown brand
- **Review flags**: MSO classification unknown, cost basis missing, Dutchie images
- **Complexity**: Multi-cultivar products, assortments, sample packs

## Product Taxonomy Rules

### Brand Name Canonicalization

**Respect manifest canonical names**:
- "Moonlit Hash Co" (NOT "Moonlit")
- "Preferred Gardens" (NOT folded into "Herb")
- "Doobie Labs" (NOT "Doobie")
- Per distributor manifest when available

**Name Cleaning**:
- Trim whitespace
- Normalize case (Title Case for brand display)
- Remove distributor prefixes/codes

### Category Classification

**Standard Categories**:
- Flower (includes shake, ground flower)
- Pre-Rolls
- Vapes (cartridges, disposables, AIO)
- Edibles (gummies, chews, chocolates, beverages)
- Concentrates (wax, shatter, live resin, rosin)
- Topicals
- Accessories

**Subcategory Examples**:
- Flower: Shake, Ground Flower, Smalls, Premium
- Pre-Rolls: Infused, Live Resin, Multi-Cultivar
- Vapes: Cartridge, All In One / Disposable, Live Resin
- Edibles: Chews/Gummies, Chocolates, Beverages

### Variant Naming Rules

**Format**: `{Brand} {Strain/Flavor} {Product Type} {Size} {Pack Count}`

**Examples**:
- "Herb Forbidden Fruit Vape 0.5g"
- "Preferred Gardens Gelato Preroll 2-pack"
- "Smartbud Ice Cream Swirl Shake 14g"
- "Moonlit Hash Co Cherry Pie Infused Preroll 5-pack"

**Pack Count Representation**:
- `2-pack`, `5-pack`, `10-pack` (NOT "2pk" or "x2")
- Singular when count=1: "Vape 0.5g" not "Vape 0.5g 1-pack"

### Size Formatting

**Grams**: `3.5g`, `7g`, `14g`, `28g` (NOT "1/8oz", "1/4oz")

**Milligrams**: `10mg`, `25mg`, `100mg`

**Milliliters**: `0.5ml`, `1ml`

**Special Cases**:
- Half ounce shake: `14g` (NOT "1/2oz")
- Gram equivalent preferred over fractions

### Strain/Cultivar Handling

**Single-Strain Products**:
- Extract strain name from distributor SKU
- Populate `strainName` field
- Link to strain attributes (effects, flavors)

**Multi-Cultivar Products**:
- Example: "Jungle Girl 5-pack" (assorted strains)
- Do NOT force single strain
- Leave `strainName` empty or null
- Flag as multi-cultivar in notes

**Ground Flower Classification**:
- "Ground Flower" = Shake (same category)
- Example: "Smartbud Ground Flower 1/2oz" → "Smartbud Shake 14g"
- NOT whole flower

## Image Sourcing Rules

### Forbidden Sources

**Dutchie-hosted images are forbidden**:
- Do NOT include images from `dutchie.com` domains
- Do NOT include Dutchie stock/placeholder images
- Strip during generation (pre-filter) AND apply phase

**Scrubbing Process**:
1. Check `primaryImageUrl` for "dutchie" substring
2. If match: clear `primaryImageUrl` and `primaryImageHref`
3. Add review flag: "Image scrubbed (Dutchie source forbidden)"

### Acceptable Sources

- Distributor-provided images (from manifest/order data)
- Web search results (vetted for quality)
- Lit Alerts competitor product images (cite source)
- Brand official images (when available)

### Missing Images

- **Do NOT fail generation** if image missing
- Flag row for manual image sourcing
- Acceptable to publish packet without images
- Images can be added during review phase

## Attribute Backfill Rules

### Strains, Effects, Flavors

**Creation Policy**:
- Create missing strains/effects/flavors during apply phase
- Link to products/variants
- **Do NOT disable** strains/effects/flavors created in prior applies
  - Even if parent groups/products were disabled in rollback

**Strain Attributes**:
- Name (canonical)
- Type (Indica, Sativa, Hybrid)
- Effects (Relaxing, Energizing, Uplifting, etc.)
- Flavors (Sweet, Citrus, Earthy, etc.)

**Persistence**:
- Strains/effects/flavors are reusable across products
- Not tied to specific products (can survive product deletion)

## Validation Rules

### Required Fields (Pre-Apply)

Before applying a proposal row, verify:

- [x] `brand` is populated
- [x] `category` is populated
- [x] `variantName` is populated
- [x] `costPerUnit` > 0
- [x] `proposedRetailPrice` > 0
- [x] `proposedRetailPrice` has quarter-dollar ending
- [x] `gmPercent` calculated and within acceptable range
- [x] `evidenceTier` is labeled
- [x] No Dutchie images

### Site-Scoped Verification

Per canonical spec (`docs/sweed/catalog/produce-pending-purchase-proposal.md`):

**Before site-scoped reads**:
```python
sweed_api.call("store.auth.dealer.set", {"dealerId": site_dealer_id})
result = sweed_api.call("store.auth.dealer.get", {})
assert result["currentDealerId"] == site_dealer_id
assert result["currentDealerName"] == expected_dealer_name
```

**Before catalog writes**:
```python
sweed_api.call("store.auth.dealer.set", {"dealerId": 210248})  # State dealer
# Perform catalog mutations
```

### Error Handling Policy

**No Silent Failures**:
- Every Sweed API call checked for `error == null`
- Every Lit Alerts query verified for results
- Every LLM parse verified for valid output
- Every image fetch logged (success or failure)

**On Failure**:
1. Log error details
2. Page Dave immediately
3. Abort current operation
4. Do NOT bury in reviewer notes

## Review Flags

### Automatic Flags

System must flag rows for:

- **Missing MSO classification**: "No MSO classification available"
- **Categorical match only**: "Evidence tier: brand-categorical-variant (not exact match)"
- **Missing images**: "No primary image available"
- **Dutchie scrub**: "Image scrubbed (Dutchie source forbidden)"
- **Cost basis unknown**: "Cost basis unavailable from PO wholesale price"
- **Below GM floor**: "GM% below target floor (market pressure override)"
- **Multi-cultivar product**: "Multi-cultivar assortment - no single strain"

### Human Decision Points

Flags that require operator judgment:

- Ambiguous brand attribution
- Unknown distributor pattern
- Contradictory market data
- Extreme price outliers
- New product categories

## Special Case Rules

### Documented Operator Decisions

Per `catalog/purchases/RESUME_RUNBOOK.md`:

1. **Smartbud Ground Flower 1/2oz**:
   - Model as: `<Strain> Shake 14g`
   - NOT whole flower
   
2. **Jungle Girl 5-packs**:
   - Multi-cultivar assortments
   - No single strain field
   
3. **Stop 31 Brands**:
   - Draft to 67.5% GM (top of MSO band)
   - Marketing adjusts via promo discounts
   
4. **Bronx Order 131642**:
   - Correct in production
   - Do NOT recreate or disable
   
5. **Strains/Effects/Flavors**:
   - From bad first apply remain active
   - Even if parent groups/products disabled

### Distributor-Specific Rules

**10FF Distribution (Stop 31 LLC)**:
- Manifest is authoritative (`manifest_10ff.json`)
- 32 line items with METRC tags
- Brand GM override: 67.5%
- Co-located brands follow same GM target

## Data Quality Rules

### Cost Basis Recovery

**Preferred sources** (in order):
1. Metrc `positions[].orderPositionIntegrationData.wholesalePrice` (divide by quantity for unit)
2. `store.distributor.product.list` → `productRecentPrices[]` (most recent nonzero)
3. `store.distributor.product.list` → `data[].pricesLists[]` (dated fallback)

**NOT reliable**:
- `store.product.list.short` → `distributorProductPrice` (often zero)
- `store.product.list` → `wholesaleCost` (often zero)
- `store.product.group.get` → cost fields (often zero)

**On missing cost**:
- Flag for review
- Include in packet anyway (not a filter criterion)
- Operator can manually enter cost

### Duplicate Detection

**Detect duplicates by**:
- Same distributor product name
- Same order ID
- Same position ID

**On duplicate**:
- Take most recent
- Flag for review if details differ

### Quantity Validation

- Accept any positive quantity (including fractional for samples)
- Flag quantities > 1000 for review (likely data error)
- Flag quantities < 1 for review (unless explicitly fractional sample)

## Workflow Sequencing Rules

### Generation Phase

1. Fetch all pending orders (both sites)
2. Filter for unmapped positions
3. Parse distributor SKUs (manifest → cache → LLM)
4. Search Sweed catalog for matches
5. Query Lit Alerts for market pricing
6. Calculate pricing with GM% targets
7. Group by hierarchy
8. Render packet artifacts
9. Page Dave for review
10. **STOP** - await explicit approval

### Application Phase (Post-Approval Only)

1. Switch to state catalog dealer (210248)
2. Create product groups (if needed)
3. Create products/variants (if needed)
4. Create/update distributor product links
5. Update purchase order positions
6. Create/backfill strains/effects/flavors
7. Log results to apply JSON
8. Page Dave with completion stats

**No auto-apply**: Human must explicitly approve before any writes

## Migration Preservation Requirements

When migrating to Helios TypeScript, **must preserve**:

1. All pricing formulas and GM% targets
2. Matching tier hierarchy (exact → categorical → reject)
3. No silent failures policy
4. Site-scoped verification rules
5. Dutchie image prohibition
6. Quarter-dollar price endings
7. MSO classification lookup
8. Categorical price consistency
9. Review flag generation
10. Operator decision rules

**Can change**:
- Implementation language (Python → TypeScript)
- File vs database storage
- Static HTML → React UI
- HAR-based auth → proper API clients
- Manual execution → scheduled jobs

**UI affordances to preserve**:
- Price ladder with draggable sliders
- Group-level proportional sliders (respect GM bands)
- Tree navigation with Escape toggle
- Click-to-new-tab for competitor links
- Evidence tier labeling
- Review flags visibility
