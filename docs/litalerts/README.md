# Lit Alerts Docs

Use this index to load only the Lit Alerts knowledge relevant to the task in front of you.

## Read This First

- Resolve brand identity first with `Manufacturers/real` before doing product interpretation work.
- Use statewide listing search for product identity, then narrower nearby-retailer search for pricing or local comparison.
- Do not trust `count` by itself in `Products/menulistings`; inspect `listings[]`, `total`, and actual pagination behavior.
- For pricing runs, deterministic same-brand matching stays primary; the bounded Mantle search-adaptation fallback is only for thin-comp cases and does not relax same-format pricing filters.

## Task Map

- API shape, auth, core request conventions, and Cognito refresh behavior: [`foundations.md`](./foundations.md)
- Manufacturer resolution and statewide product-listing reads: [`brand-and-product-lookups.md`](./brand-and-product-lookups.md)
- Nearby retailers, radius sets, and retailer analytics: [`retailers-and-analytics.md`](./retailers-and-analytics.md)
- Competitor review packet system design for nearby-site comparison: [`competitor-review-packets.md`](./competitor-review-packets.md)
- Saved filters and Midtown radius-set workflow: [`saved-filters.md`](./saved-filters.md)
- Product identity interpretation playbook, including the bounded pricing-market search-adaptation fallback: [`product-matching.md`](./product-matching.md)
- Shortcut alias for that workflow: [`../../HOW_LITALERTS_PRODUCT_MATCHING_WORKS.md`](../../HOW_LITALERTS_PRODUCT_MATCHING_WORKS.md)

## Shortcut Note

- [`../../HOW_LITALERTS_PRODUCT_MATCHING_WORKS.md`](../../HOW_LITALERTS_PRODUCT_MATCHING_WORKS.md) is a task shortcut for agents that start from a product-matching request. The canonical domain path still runs through this index.


## Suggested Reading Order For New Agents

1. [`foundations.md`](./foundations.md)
2. The one task doc that matches your work
3. [`product-matching.md`](./product-matching.md) if product identity is ambiguous
