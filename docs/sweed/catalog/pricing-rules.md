# Sweed Catalog Pricing Rules

Load this when you are setting catalog prices, drafting pricing proposals, or building a repricing review packet.

For the longer reviewer-packet pricing UI shape and detail-page workflow, also see [`review-and-backfill.md`](./review-and-backfill.md) and [`../../ui/reviewer-packet-guidelines.md`](../../ui/reviewer-packet-guidelines.md).

## Margin And Price-Endings Rules

- Use the post-tax GM% formula: `GM% = 1 - 1.13 * cost / price`.
- Target roughly 55% to 65% GM for draft catalog pricing.
- Set `global_price` only on even quarter increments: `.00`, `.25`, `.50`, or `.75`.
- Prefer `.00` and `.50` endings over `.25` and `.75` whenever that still satisfies the active pricing constraints.
- Do not use charm pricing such as `x.99` or other non-quarter endings.
- Keep categorically equivalent items by brand with the same cost and size at the same outgoing price.
- For sample rows whose cost is nominal, still emit a price using the best available cost basis even if that yields a near-100% GM. Do not leave samples unpriced.

## Competitor-Led Pricing

- Treat captured `Average Competitor Price` from Lit Alerts as a pre-tax market average.
- Convert it to a post-tax competitor equivalent with `1.13 * average_competitor_price`.
- Aim a few percent below that figure rather than matching it, as long as the result still stays inside the 55% to 65% GM band.
- If current cost and competitor average make those rules incompatible, it is acceptable to propose the below-competitor price even when GM drops below 55%. Do not go below 55% for any other reason.

## Lit Alerts Discovery Rules

- Do not trust the `total` field from `public-api.litalerts.com/Products/menulistings` by itself: it has been observed stuck at `10000` while pagination continued through 13371 rows. Page until you hit an empty page or a short final page.
- For ambiguous identity, resolve the brand ID first with `GET /Manufacturers/real?page=0&pagesize=2000&state=NY`, then query `POST /Products/menulistings` with `brandIDs: [id]`, `filters.Brand: "[id]"`, `dispensaryIDs: null`, `stateID: 265`. In that mode, do not trust `count`; use `listings[]` and `total`.
- For statewide identity, treat `filters.Name` as an exact substring match: pick the rarest contiguous 1-3 word phrase from the actual product text and pair it with the resolved brand ID and category filter. See [`../../litalerts/product-matching.md`](../../litalerts/product-matching.md) for the full identity-then-evidence workflow.

## Helios Pricing Module Status

- Active pricing-module implementation lives in `helios/src/client/routes/pricing/`, `helios/src/server/routes/pricing.ts`, `helios/src/server/db/queries/pricingQueries.ts`, and `helios/src/worker/pricing/`.
- Helios already supports the `midtownEverReceived` historical scope, explicit `keep-price` review rows, and the bounded Lit Alerts search-adaptation fallback for thin-comp repricing.
- In Helios pricing, Lit Alerts and Mantle failures are retry-with-backoff dependencies; if they still fail after bounded retries, page Dave and abort instead of downgrading the outage into reviewer notes.

## Cost-Basis Recovery

- For pricing packets, current `store.product.list.short`, `store.product.list`, and `store.product.group.get` responses no longer reliably expose a usable nonzero `distributorProductPrice` / `wholesaleCost` on returned product rows.
- Recover the actual cost from `store.distributor.product.list { page, pageSize, productId }` against the state dealer context, then select the most recent nonzero row price from `productRecentPrices[]` or the dated `data[].pricesLists[]`.
- For purchase-order costing, prefer the live Metrc `positions[].orderPositionIntegrationData.wholesalePrice` field when present (extended line amount; divide by position quantity for unit cost). If the field is absent, treat PO-side Metrc unit cost as unknown rather than silently forcing `0.00`.
- Missing live PO wholesale is a costing gap, not a scope filter for the combined outstanding-PO packet.
