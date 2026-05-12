# Sweed Docs

Use this index to load only the Sweed knowledge relevant to the task in front of you.

## Read This First

- Always reset dealer context with `store.auth.dealer.set` before a live read or write block and verify `currentDealerId/currentDealerName`.
- Treat UI labels as labels, not payload values. Resolve IDs first.
- Catalog work is usually state-level. Inventory, purchase, and most marketing work here are site-level.

## Task Map

- Live sales, live inventory, BI/Cube analytics, dealer constants, and canonical helper files: [`live-data-and-bi.md`](./live-data-and-bi.md)
- Foundations, auth, dealer scope, ID lookup behavior, and employee user admin: [`foundations.md`](./foundations.md)
- Catalog model and migration constraints: [`catalog/model-and-migration.md`](./catalog/model-and-migration.md)
- Catalog create/edit flows and dictionary lookups: [`catalog/creation-and-editing.md`](./catalog/creation-and-editing.md)
- Catalog review, attribute backfill, and packet-building: [`catalog/review-and-backfill.md`](./catalog/review-and-backfill.md)
- Catalog pricing rules and competitor-led pricing: [`catalog/pricing-rules.md`](./catalog/pricing-rules.md)
- Canonical "produce pending purchase proposal" instruction definition: [`catalog/produce-pending-purchase-proposal.md`](./catalog/produce-pending-purchase-proposal.md)
- Marketing segments, promo campaigns, event-trigger content, and BI performance analytics: [`marketing/segments-and-events.md`](./marketing/segments-and-events.md)
- Marketing screens and in-store TV banners: [`marketing/screens-and-banners.md`](./marketing/screens-and-banners.md)
- Purchase mapping, distributor quirks, and inventory adjustments: [`operations/purchase-and-inventory.md`](./operations/purchase-and-inventory.md)
- E-commerce order state machine, cashier pay flow, and delivery vs pickup payment limits: [`operations/order-payment-state-machine.md`](./operations/order-payment-state-machine.md)
- Public storefront and backend proxy behavior: [`storefront/public-api.md`](./storefront/public-api.md)

## Suggested Reading Order For New Agents

1. For live sales / inventory / BI / promo work: [`live-data-and-bi.md`](./live-data-and-bi.md); otherwise [`foundations.md`](./foundations.md)
2. The one task doc that matches your work
3. A second task doc only if the first one points you there
