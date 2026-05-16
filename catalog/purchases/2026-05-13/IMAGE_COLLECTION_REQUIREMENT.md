# SKU Image Collection - Core Helios Requirement

## Problem
Products in pending purchase packets show "no image" even when product images are readily available via web search + ecommerce sitemaps.

## Example: Dr Jekyll and Mr High Apple Jax 3.5g

**Search Query:** `Dr Jekyll and Mr High Apple Jax 3.5g`  
**DDG Result:** https://root9dispensary.com/stores/root9-dispensary-wappingers/product/dr-jekyll-mr-high-apple-jax-whole-flower  
**Sitemap:** https://root9dispensary.com/stores/root9-dispensary-wappingers/sitemap.xml  
**Product Image:** https://images.dutchie.com/806584881f88ed23c4b68ccdafb2ef17

## Required Capability

Helios SKU research should:

1. **Search for product** using variant name or distributor product name
2. **Extract top 3-5 ecommerce results** (prioritize NY dispensaries)
3. **Infer sitemap URLs** from ecommerce domain patterns
4. **Parse sitemaps** to find product page entries
5. **Extract image URLs** from sitemap entries
6. **Filter out stock Dutchie images** (generic placeholders)
7. **Return 1-3 candidate images** per product

## Geographic Scope
Unlike pricing (which is geographically restricted), **SKU images are NOT geographically restricted**. Any relevant product image found online is acceptable.

## Filtering Rules
- ❌ NO stock Dutchie placeholder images
- ✅ Actual product photography from any dispensary
- ✅ Brand-provided product images
- ✅ Out-of-state ecommerce sites are fine for images

## Integration Points

### Phase A (Pending Purchase Collection)
- When building proposal rows, attempt image collection for each SKU
- Store candidate images with confidence scores
- Embed best candidate in review packet

### Phase D (Market Research)
- Image collection runs alongside competitor pricing research
- Images stored in market research data structure keyed by distributorProductId
- Resilient to Phase B corrections (images stay valid even if brand/variant changes)

## Implementation Notes

This should be a **reusable Helios worker module**, not a per-packet Python script:

```typescript
// helios/src/worker/skuResearch/imageCollector.ts
export async function collectProductImages(params: {
  searchTerm: string;
  maxResults?: number;  // default 3-5
}): Promise<Array<{
  imageUrl: string;
  sourceUrl: string;
  confidence: 'high' | 'medium' | 'low';
  retailer: string;
}>>
```

## Priority
This is blocking better review packets. Every "no image" row forces reviewers to manually search or trust parsing without visual verification.
