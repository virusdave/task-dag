# Live Work Cheatsheet

Read this after `AGENTS.md` when a task touches live Sweed data, Helios integration, reviewer packets, or Mantle-backed ranking/generation.

Goal: one short orientation read that tells you what exists, then one targeted doc, then code.

## Common bootstrap

| Need | Value / canonical path |
| --- | --- |
| Sweed API | `https://prime.sweedpos.com/api/` |
| Dealer ids | `210705` = Midtown · `210249` = Bronx · `210248` = Freshly Baked NY state holder |
| Sweed auth token | `~/.secret/sweed/auth-token` or `/Users/amp-local/.secret/sweed/auth-token` |
| Mantle bearer token | `~/.secret/bedrock/mantle-bearer-token` or `/Users/amp-local/.secret/bedrock/mantle-bearer-token` |
| LitAlerts bearer (24h Cognito access token) | `/Users/amp-local/.secret/litalerts/bearer-token` |
| LitAlerts refresh token (long-lived) | `/Users/amp-local/.secret/litalerts/refresh-token` |
| LitAlerts auto-refresh script | `python3 automation/litalerts/refresh_bearer_token.py` (uses `GetTokensFromRefreshToken`; verifies before persisting) |
| Cube endpoints | `GET /cube/v1/meta`, `GET /cube/v1/load` on `prime.sweedpos.com` |
| Required setup before any live Sweed read/write | `store.auth.dealer.set { dealerId }`, then verify returned `currentDealerId/currentDealerName` |

## Live data catalog

| Need | Surface | Useful fields / note | Canonical helper / example |
| --- | --- | --- | --- |
| Switch dealer | `store.auth.dealer.set` | required before every site/state block | `communications/midtown-delivery/communications_ops/src/server/sweed/rpc.ts`, `helios/src/server/catalog/liveRecentSales.ts` |
| Recent sales velocity (per-product, last 7 day pace + 30 day $ + on hand) | `store.reports.reorder { page, pageSize }` | `table[].id`, `lastWeekSellingPerDay`, `onHand`, `last30DaysGlossSales`, `reportDate` | `helios/src/server/catalog/liveRecentSales.ts` |
| Live grouped inventory (product, brand, category, qty, price, lots) | `store.inventory.item.list.grouped { isOnStock, page, pageSize }` | top-level: `product.{id,name}`, `productBrand.{id,name}`, `category.{id,name}`, `subcategory.{id,name}`, `currentQty`, `availableQty`, `localPrice`, `globalPrice`; per-lot: `items[].{dateTimeReceived,wholesaleCost,availableQty,stockLocation.name,isAvailableOnline,isNotForSale,isTradeSample}` | `promotions/promo_ops/scripts/slow-mover-promo/lib/data.ts`, `helios/src/server/pricing/liveInventoryScope.ts`, `helios/src/worker/jobs/configWorkersStockRefreshJob.ts` |
| BI auth | `store.bi.auth.jwt` | call with **no `params`**; raw JWT goes in `Authorization` header (not `Bearer`) | `communications/midtown-delivery/communications_ops/src/server/data/livePerformance.ts` |
| Discover cubes | `GET /cube/v1/meta` | lists cubes, dimensions, and measures | use before new cube work |
| Query cubes | `GET /cube/v1/load?queryType=multi&query=...` | `PromotionEffectiveness` is the best first stop for promo / sales analysis | `communications/midtown-delivery/communications_ops/src/server/data/livePerformance.ts`, `promotions/promo_ops/scripts/slow-mover-promo/lib/data.ts` |
| Totals row | `store.bi.cube.totals` | needs normalized query plus the JWT; see code | `communications/midtown-delivery/communications_ops/src/server/data/livePerformance.ts` |

## Observed cubes worth checking first

| Cube | Start here when | Common members already observed |
| --- | --- | --- |
| `PromotionEffectiveness` | promo / category / brand / SKU sales analysis | dims: `productCategory`, `productBrand`, `productID`, `productName`, `dealerID`, `invoiceDatetime`; measures: `netSales`, `quantity`, `grossMargin`, `promoDiscount` |
| `SaleReport` | cross-check totals | use as sanity check against `PromotionEffectiveness` |
| `Inventory` | BI-side inventory reporting | confirm exact members with `/cube/v1/meta` |
| `MarketingStat` | event / channel performance | see `docs/sweed/marketing/segments-and-events.md` |
| `OrderHistoryV2` | historical order reporting | confirm exact members with `/cube/v1/meta` |

## Mantle quick facts

- Backend: `bedrock.mantle.openai-compatible` (OpenAI-compatible `/v1/chat/completions`)
- Endpoint: `https://bedrock-mantle.us-east-2.api.aws/v1`
- Common model for structured JSON / text in this workspace: `google.gemma-3-27b-it`
- Guardrail: Mantle may rank/explain reviewer options; deterministic code computes metrics, picks ladders, and nothing auto-applies.
- Policy source of truth: `config/llm_use/registry.yaml`. Add a new use case there before introducing one.

## Minimal request shapes

```json
{ "name": "store.reports.reorder", "params": { "page": 1, "pageSize": 200 } }
{ "name": "store.inventory.item.list.grouped", "params": { "page": 1, "pageSize": 200, "isOnStock": true } }
{ "name": "store.bi.auth.jwt" }
```

```json
{
  "dimensions": [
    "PromotionEffectiveness.productCategory",
    "PromotionEffectiveness.productBrand"
  ],
  "filters": [
    { "member": "PromotionEffectiveness.dealerID", "operator": "equals", "values": ["210705"] }
  ],
  "measures": [
    "PromotionEffectiveness.netSales",
    "PromotionEffectiveness.quantity",
    "PromotionEffectiveness.grossMargin",
    "PromotionEffectiveness.promoDiscount"
  ],
  "timeDimensions": [
    { "dimension": "PromotionEffectiveness.invoiceDatetime", "dateRange": ["2026-04-26", "2026-05-09"] }
  ],
  "timezone": "America/New_York"
}
```

## Read exactly one next doc

- Live sales / inventory / BI / promo sourcing: [`docs/sweed/live-data-and-bi.md`](./docs/sweed/live-data-and-bi.md)
- Helios ownership / where operator UI belongs: [`docs/helios/migration-and-ownership.md`](./docs/helios/migration-and-ownership.md)
- Mantle secrets / endpoint / model IDs: [`docs/private-llm/access-paths-and-secrets.md`](./docs/private-llm/access-paths-and-secrets.md)
- Reviewer packet HTML rules: [`docs/ui/reviewer-packet-guidelines.md`](./docs/ui/reviewer-packet-guidelines.md)

## End-to-end example

- Slow-mover promo packet: `promotions/promo_ops/scripts/slow-mover-promo/README.md`
- Data pull implementation: `promotions/promo_ops/scripts/slow-mover-promo/lib/data.ts`
