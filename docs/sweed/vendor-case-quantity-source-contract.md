# Vendor case quantity source contract

Status: source inventory complete; schema and inference not yet implemented

Evidence captured: 2026-07-23

Applies to: `store.purchase.order.list/get` mirrored in `sweed_purchases` and
`sweed_purchase_line_items`

This contract defines which observed Sweed purchase fields may become inputs
to case-quantity inference. It deliberately does not interpret migration 104
comments as policy, infer across vendors, or make inference effective.

## Evidence and limits

The inventory used bounded, read-only production queries inside a
`BEGIN READ ONLY` transaction with a 5-10 second statement timeout. Queries
projected only named JSON paths, key names, and aggregate counts; no raw order,
product, or operator-note payload left the production host.

The mirror contained 384 purchases from 2025-07-17 through 2026-07-23. The
365-day evidence window contained 361 purchases and 3,292 lines. A recursive
key-name scan covered all 361 purchase responses. Quantity and receipt checks
covered all 3,292 lines in the window.

Observed order statuses in that window:

| ID | Name | Purchases | Eligibility |
| --- | --- | ---: | --- |
| 4 | `Received` | 324 | Allowlisted only when every line gate below also passes |
| 7 | `Canceled` | 20 | Excluded: `canceled_status` |
| 1 | `Draft` | 16 | Excluded: `draft_status` |
| 5 | `Partially received` | 1 | Excluded: `partially_received_status` |

Status 2 is the pending status used by `store.purchase.order.list` and is
already filtered before detail mirroring. It was not present in the detail
mirror evidence window and remains excluded as `pending_status`. Any other
status, a missing status, an ID/name mismatch, or a status whose meaning is
not explicitly inventoried is `unknown_status` and fails closed.

Financial states (`Not paid`, `Partly paid`, and `Fully paid`) describe payment,
not whether the goods were received. They are audit context only and cannot
make a purchase eligible or ineligible by themselves.

## Typed eligibility contract

An inference source line is eligible only when all of these predicates hold:

1. The header has exactly `orderStatus.id = 4` and
   `orderStatus.name = "Received"`.
2. `deliveryDate` parses to a New York business date. Missing or invalid dates
   are `missing_delivery_date`.
3. `receiptPosition` is present, `receiptPosition.isVerified = true`, and the
   receipt has at least one group. Missing or unverified receipt evidence is
   `unverified_receipt`.
4. Every receipt group has null `rejectReason` and a blank/null
   `rejectReasonNote`. A populated rejection is `rejected_receipt_group` and
   preserves the typed reason ID/name for audit; free-text notes are never
   policy.
5. Neither `isTradeSample` nor `isTestingSample` is true at the position level,
   and no receipt group has `isTradeSample = true`. Otherwise the exclusion is
   `sample`.
6. The ordered-unit value passes the quantity contract below.
7. A canonical vendor is resolved explicitly. A Sweed distributor is not a
   vendor identity and cannot be used to merge otherwise unresolved vendors.

The mirror had no missing delivery date or status ID among all 384 purchases.
That is evidence about the current rows, not permission to omit the fail-closed
branches.

### Rejection, return, credit, and reversal signals

`receiptPosition.groups[].rejectReason` is an observed object with typed
`{id, name}` fields. Six groups in the evidence window had rejection reasons:
five on canceled purchases (`Incorrect Quantity`) and one on the partially
received purchase (`Incorrect Item (Transfer)`). The associated free-text
`rejectReasonNote` was present in all six cases but must remain audit-only.

No key matching `cancel`, `void`, `return`, `credit`, `revers`, `refund`, or
`delet` appeared anywhere in the recursively scanned 361 detail responses.
Cancellation is nevertheless identified by order status 7. No source signal
for a post-receipt return, credit, refund, deletion, or reversal has been
identified, so downstream code **must not claim that those states are
excluded**. A later source inventory may add a typed signal; until then it must
be represented as an explicit source limitation, not guessed from amounts,
notes, or chronology.

## Ordered-unit source contract

Persist the selected source independently from the value. The initial strict
enum is:

- `position_product_qty`: eligible source;
- `order_position_qty`: observed but not an eligible fallback;
- `distributor_product_qty`: observed but not an eligible fallback;
- `unresolved`: no demonstrated unit source.

`positionProductQty` is the only demonstrated ordered-unit source. All 3,292
lines had all three quantity fields, but 37 lines had at least one disagreement:
25 had `positionProductQty = distributorProductQty != orderPositionQty`, and 12
had `orderPositionQty = distributorProductQty != positionProductQty`. The
ratios vary with receipt packing and prove that “first non-null” does not encode
stable semantics.

Receipt evidence resolves the strict path. Of 3,201 lines on received orders:

- 3,177 had a verified `receiptPosition`; 24 lacked one and must abstain;
- for all 3,177 verified lines, top-level `positionProductQty` equaled
  `receiptPosition.positionProductQty`;
- for all 3,177, the sum of `receiptPosition.groups[].productQty` equaled that
  value; and
- for all 3,177, the sum of
  `receiptPosition.groups[].receiptProducts[].productQty` also equaled it.

Therefore a line may select `position_product_qty` only when those available
receipt totals agree. The value must be finite, positive, and integral.
Missing, zero/negative, fractional, or receipt-conflicting values are
`unresolved_quantity`. `orderPositionQty` and `distributorProductQty` remain
audit columns; neither is a fallback. Split lines may be summed into one
observation only when every contributing line selected the same source and the
same family dimensions.

Observed received lines had no non-positive or fractional selected values.
Again, this does not remove those fail-closed branches.

## Identity and family source paths

Use stable IDs where the source provides them:

| Meaning | Source path | Rule |
| --- | --- | --- |
| Purchase | header `id` | Dealer-scoped; observation key includes `dealer_id` |
| Site | ingest dealer/site registry | Required for chronology and first-order evidence |
| Exact product | `suggestedProduct.id`, else `distributorProduct.product.id` | Required; names never form identity |
| Product SKU | `receiptPosition.productSku` | Audit/display only |
| Category | `receiptPosition.category.{id,name}` | ID required for family inference |
| Subcategory | `receiptPosition.subcategory.{id,name}` | ID required for family inference |
| Unit size | `catalogProductSize.{id,name,uomNumber,uom}` / `productSize` | Normalize with the canonical catalog size semantics |
| Retail pack count | top-level `packOfSize` | Keep separate from case quantity |
| Direct case token | strict token in the eligible product/position name | `Ncpk` is case evidence and never changes retail pack count |

Within received orders, 3,177 of 3,201 lines had receipt category IDs and
product SKUs, while only 1,209 had subcategory IDs. Missing subcategory makes
family inference unavailable; it must not broaden to category-only or
vendor-wide inference.

The production mirror's typed `brand_*`, `category_*`, `subcategory_*`, and
`product_sku` denorms were null on all 3,201 received lines even though the raw
receipt paths above were populated. Schema/backfill design must source and
validate these typed values rather than assuming the current denorms are
complete.

Canonical vendor resolution is separate from distributor identity. Exact
case-insensitive `sweed_purchases.distributor_name = vendors.name` resolved
only 127 of 324 received purchases (30 of 81 distinct distributor names).
Unmatched names abstain unless the product's canonical brand association
resolves exactly one vendor. A shared distributor must never collapse two
vendors into one inference scope.

## Required exclusion reason codes

The typed eligibility layer must preserve every applicable reason, rather than
only a boolean:

- `unknown_status`, `pending_status`, `draft_status`,
  `partially_received_status`, `canceled_status`;
- `missing_delivery_date`, `unverified_receipt`, `rejected_receipt_group`;
- `sample`, `unresolved_quantity`, `unresolved_vendor`;
- `missing_product_identity`, `missing_family_dimension`;
- `conflicting_split_line_source`, `conflicting_split_line_family`.

Future identified return/credit/refund/reversal/deletion signals get distinct
reason codes; they must not be collapsed into `unknown_status` or inferred
from prose.

## Sanitized deterministic fixtures

These synthetic fixtures preserve only observed shapes and semantics. IDs,
names, and dates are invented; no production payload is copied.

```json
[
  {
    "name": "eligible_received_line",
    "header": {
      "id": "po-a",
      "deliveryDate": "2026-01-15T00:00:00Z",
      "orderStatus": { "id": 4, "name": "Received" }
    },
    "position": {
      "id": "line-a",
      "positionProductQty": 25,
      "orderPositionQty": 1,
      "distributorProductQty": 25,
      "packOfSize": 1,
      "isTradeSample": false,
      "isTestingSample": false,
      "suggestedProduct": { "id": 1001, "name": "Example 25cpk" },
      "catalogProductSize": { "id": 10, "name": "1g" },
      "receiptPosition": {
        "isVerified": true,
        "positionProductQty": 25,
        "productSku": "SYNTHETIC-1",
        "category": { "id": 20, "name": "Pre-Rolls" },
        "subcategory": { "id": 21, "name": "Single" },
        "groups": [
          {
            "productQty": 25,
            "rejectReason": null,
            "rejectReasonNote": null,
            "isTradeSample": false,
            "receiptProducts": [{ "productQty": 25 }]
          }
        ]
      }
    },
    "expectedSource": "position_product_qty",
    "expectedOrderedUnits": 25,
    "expectedExclusions": []
  },
  {
    "name": "partially_received_rejection",
    "header": {
      "id": "po-b",
      "deliveryDate": "2026-01-16T00:00:00Z",
      "orderStatus": { "id": 5, "name": "Partially received" }
    },
    "position": {
      "id": "line-b",
      "positionProductQty": 12,
      "receiptPosition": {
        "isVerified": true,
        "positionProductQty": 12,
        "groups": [
          {
            "productQty": 12,
            "rejectReason": { "id": 999, "name": "Synthetic rejection" },
            "rejectReasonNote": "synthetic note",
            "receiptProducts": [{ "productQty": 12 }]
          }
        ]
      }
    },
    "expectedSource": "position_product_qty",
    "expectedExclusions": [
      "partially_received_status",
      "rejected_receipt_group"
    ]
  },
  {
    "name": "received_without_receipt_evidence",
    "header": {
      "id": "po-c",
      "deliveryDate": "2026-01-17T00:00:00Z",
      "orderStatus": { "id": 4, "name": "Received" }
    },
    "position": {
      "id": "line-c",
      "positionProductQty": 24,
      "orderPositionQty": 2,
      "distributorProductQty": 24,
      "receiptPosition": null
    },
    "expectedSource": "unresolved",
    "expectedExclusions": ["unverified_receipt", "unresolved_quantity"]
  }
]
```

Additional tests derived from this contract must cover unknown/mismatched
status pairs, absent delivery dates, sample flags at both levels, zero and
fractional quantities, disagreement between position and receipt totals,
missing product IDs, unresolved vendors, and missing/conflicting family
dimensions.

## Downstream design constraints

- Persist narrow typed fields and exclusion reasons; inference queries must not
  repeatedly expand `raw_json`.
- Backfill from a consistent watermark and keep rows unavailable until a
  complete pass succeeds. Never silently sample overflow.
- Treat the absent return/credit signal and current taxonomy-denorm gap as
  explicit design inputs for the required schema/backfill/rollback review.
- Migration 104 comments remain review evidence only. Nothing in this source
  inventory turns `25 and 50`, COD examples, or other prose into a term.
