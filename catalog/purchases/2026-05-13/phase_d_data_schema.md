# Phase (D) Market Research Data Schema

## Design Goals

1. **Resilient to Phase (B) corrections**: Data keyed by `distributorProductId` so partial corrections don't invalidate all research
2. **Separate storage**: Market research data stored independently from catalog proposals
3. **Reusable**: Can merge with updated Phase (B) data after corrections

## Schema

```json
{
  "collectedAt": "2026-05-14T19:30:00Z",
  "packetSource": "pending_purchases_2026_05_13.json",
  "products": {
    "<distributorProductId>": {
      "distributorProductId": "624877",
      "distributorProductName": "1O-5PR-SB26-BLDR",
      "site": "Midtown",
      "parsedBrand": "Smartbud",
      "parsedVariant": "Smartbud Blue Dream 5x 0.75g",
      "litAlerts": {
        "collectedAt": "2026-05-14T19:30:00Z",
        "matchCount": 12,
        "averagePrice": 42.50,
        "minPrice": 38.00,
        "maxPrice": 48.00,
        "medianPrice": 42.00,
        "matches": [
          {
            "retailer": "Wicked Reserve",
            "listingName": "...",
            "price": 42.00,
            "effectiveDate": "2026-05-10"
          }
        ]
      },
      "competitorPricing": {
        "collectedAt": "2026-05-14T19:30:00Z",
        "sources": ["litAlerts", "manualSnapshot"],
        "postTaxPrices": [38.14, 42.37, 45.76],
        "averagePostTax": 42.09,
        "minPostTax": 38.14,
        "maxPostTax": 45.76
      }
    }
  }
}
```

## File Structure

```
catalog/purchases/2026-05-13/
  pending_purchases_2026_05_13.json     # Phase B catalog proposal
  phase_d_market_research.json          # Market research data
  phase_d_collection_log.txt            # Collection progress log
  PHASE_B_APPROVAL.md                   # Approval status
```

## Usage After Phase (B) Corrections

When brand corrections are made (e.g., DP 630132):
1. Regenerate Phase (B) packet with corrected parsing
2. Market research data remains valid - just update the `parsedBrand`/`parsedVariant` fields
3. Re-merge for Phase (D) review without re-collecting market data

## Collection Strategy

- Collect for all 55 distributorProductIds in approved packet
- Log failures but continue (partial data is valuable)
- Store raw LitAlerts responses for audit trail
