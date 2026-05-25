# Canonical product-review row

This document defines the **structural + visual contract** of "a product
being reviewed" in helios. It is the cross-surface contract for the new
`/catalog/review` family-grouped queue (issue #15) and for every future
review surface we expect to share the same row (pending purchases,
repricing runs, market-data matches, promo previews).

If you are building a new reviewer surface that shows "here is a SKU and
the proposed change to it", this is the row you render. If you find
yourself reinventing the visual or the data shape, stop and reuse this
contract instead.

## TL;DR

- Family grouping wraps the rows: each family panel is a brand × category ×
  subcategory × **size** band, rendered as a single bordered card.
- One canonical row per family member (catalog group / product).
- Each row pairs **live state** and **proposed state** side-by-side with
  per-field structured diffs (no opaque JSON blobs in default view).
- Each row carries the canonical **pricing-ladder** control
  (`helios/src/shared/ui/pricing-ladder/`) prepopulated with the latest
  cached LitAlerts market evidence for that product, and exposes a
  proposed-price slider with quarter-dollar snap.
- Inline `approve` / `reject` / `edit` / `note` actions per row; family
  panel header carries a roll-up `approve all` / `reject all`.
- Deeper provenance (audit trail, raw payloads, ML run metadata,
  validation issue details) is collapsed behind a single
  "Details" disclosure per row and per family.

The reviewer is the only audience. We optimize for fast decisions on a
laptop / tablet, not for telling a generic visitor "here is how our
review system works".

## Where the bones already live

- [`helios/src/shared/ui/pricing-ladder/`](../../../helios/src/shared/ui/pricing-ladder/README.md) —
  canonical pricing-ladder UI (visual + optional slider). Treat as
  read-only; consume via its public API.
- [`helios/src/catalogUpdateEngine/`](../../../helios/src/catalogUpdateEngine/) —
  `PricingLadder`, `CatalogProposalRow*`, `MSOBrandAnnotation`,
  `CatalogChangeLineItem*` types. The row contract reuses these for
  cross-surface portability.

## Why "family"

Reviewers consistently triage by **family**, not by line item. A new
brand-launch in 1g vapes is one decision: approve the family, optionally
tweak a single member. The legacy `/catalog/review` page exploded
that decision into one card per (group × field) pair, forcing reviewers
to manually re-aggregate while scrolling.

A **family** is the tuple

```
(brand, category, subcategory, sizeName)
```

where `sizeName` is the normalized variant size string from
`catalog_groups.live_state_json.products[*].sizeName` (same canonical
field already powering the catalog browser size filter).

Within a family, individual rows correspond to catalog groups that
share that family. Within a row, products are summarized; the default
display surfaces the SKU that is actually being reviewed.

## Data contract

The server emits, per family panel:

```ts
interface CanonicalReviewFamily {
  familyKey: {
    brand: string | null
    category: string | null
    subcategory: string | null
    sizeName: string | null
  }
  // Family-level annotation; cached MSO mapping for the brand.
  mso: {
    isMSOBrand: boolean
    msoBrandId: number | null
    isHouseBrand: boolean
  }
  // Ordering hints surfaced for the renderer so the panel can show
  // why it appears where it does (drift count, MSO chip, etc.).
  ordering: {
    driftedRowCount: number
    msoFirst: boolean
    maxPriceSpread: number | null
  }
  rows: CanonicalReviewRow[]
}
```

and per row:

```ts
interface CanonicalReviewRow {
  // Identity
  catalogGroupId: number
  proposalRowId: number
  rowTitle: string                  // "Brand — Product — Size"
  reconcileStatus: string

  // Side-by-side state, structured per field
  comparisons: ReviewFieldComparison[]

  // Proposed approve/reject is the union of line-item approval states.
  // 'mixed' means some line items are approved and others are not.
  approvalRollup: 'pending' | 'approved' | 'rejected' | 'mixed'

  // Canonical pricing ladder input (already in the shape the
  // pricing-ladder package expects).
  pricingLadder: {
    productId: number
    livePrice: number | null
    proposedPrice: number | null     // from edited or suggested
    marketAveragePostTax: number | null
    marketMedianPostTax: number | null
    competitorListings: CompetitorListingInput[]
    evidenceFreshness: 'fresh' | 'stale' | 'very_stale' | 'expired' | 'absent'
    evidenceCapturedAt: string | null
  } | null   // null when the row isn't a pricing change

  // Validation, notes, etc. — for the inline action strip.
  validationIssues: ValidationIssue[]
  operatorNote: string | null

  // Underlying line items (one per field). Render order matches
  // `comparisons`. Each carries its own version + id so the inline
  // approve/edit handlers can target the right row.
  lineItems: ProposalLineItemHandle[]
}

interface ReviewFieldComparison {
  fieldPath: FieldPath              // e.g. 'products.price', 'products.description'
  label: string                     // human label
  liveValueText: string             // preview text
  proposedValueText: string         // edited ?? suggested
  effectiveValueText: string
  changeKind: 'pricing' | 'description' | 'taxonomy' | 'attribute' | 'other'
  lineItemId: number
}

interface ProposalLineItemHandle {
  lineItemId: number
  fieldPath: FieldPath
  version: number
  approvalStatus: 'pending' | 'approved' | 'rejected' | 'superseded'
  editedValue: JsonValue | null
}
```

The `pricingLadder` slot **must** be populated from the most recent
`litalerts_competitor_observations` row for the SKU (joined via
`catalog_groups.live_state_json.products[].productId`), even when the
field being reviewed is a description; reviewers consistently want the
price context next to a description edit. When no evidence exists the
field is `null` and the row degrades gracefully (description-only
display).

## Visual contract

Default view, per family panel:

```diagram
╭─ Family · STIIIZY · Vape · Cartridge · 1g                ⓘ ─╮
│ [MSO]  4 rows · 3 drifted · spread $11.25                   │
│                                            [Approve all]    │
│                                            [Reject all]     │
├─────────────────────────────────────────────────────────────┤
│ ╭─ STIIIZY · Blue Dream · 1g cart                       ─╮  │
│ │ Live → Proposed                                         │  │
│ │   price       $52.00 → $46.75                          │  │
│ │   description "…" → "…"                                │  │
│ │                                                         │  │
│ │ ┌─ pricing ladder (canonical) ───────────────────────┐ │  │
│ │ │  ● ● ● ●  near  $42 …………… median $48 …… $58 statewide │ │  │
│ │ │            ▲ proposed (drag)                        │ │  │
│ │ │            ▼ live                                   │ │  │
│ │ └────────────────────────────────────────────────────┘ │  │
│ │                                                         │  │
│ │ [Approve] [Reject] [Edit] [Note]   ▾ Details            │  │
│ ╰─────────────────────────────────────────────────────────╯  │
│ ╭─ STIIIZY · OG Kush · 1g cart                          ─╮  │
│ │ … (same row shape) …                                    │  │
│ ╰─────────────────────────────────────────────────────────╯  │
╰──────────────────────────────────────────────────────────────╯
```

Rules:

- **Above the fold is the answer.** The family header summarises drift +
  MSO + spread; rows show side-by-side state + ladder. Any other text
  goes inside `▾ Details` per [helios/AGENTS.md](../../../helios/AGENTS.md):
  *"the purpose of the page … should be at the top, large, and
  immediately usable without any scrolling past throat-clearing."*
- **No raw JSON in the default view.** Long descriptions truncate with a
  hover/expand affordance; full payloads live behind the row's
  `▾ Details`.
- **MSO chip** is the only family-level brand annotation surfaced by
  default. Reviewers toggle expanded MSO context (other brand
  aliases, override notes) from the family header's `ⓘ`.
- **Slider snap** rounds to the nearest **$0.25**. The slider is wired
  via `attachPricingLadderSlider` and writes back to the row's
  `proposedPrice`. When the row's proposal type is not pricing, the
  ladder still renders (visual context) but the slider is detached.
- **Approve / reject** at the family header is a fan-out over all
  per-row pending line items, in a single transaction-equivalent
  request that surfaces partial failures as inline row badges rather
  than a global error toast.

## Ordering contract

Within a server response, families are ordered for reviewer efficiency:

1. Families with `driftedRowCount > 0`, descending by `driftedRowCount`.
2. Then `mso.isMSOBrand = true` families, descending by `driftedRowCount`.
3. Then by `ordering.maxPriceSpread` descending (largest spread first).
4. Stable tiebreak by family key (alpha by brand, then category, then
   subcategory, then sizeName).

Rows within a family follow the same intra-family priority (drifted
first, then by spread).

## Surfaces that share this contract

| Surface                            | Where it lives today                            |
|------------------------------------|--------------------------------------------------|
| `/catalog/review` (this issue)     | `helios/src/client/routes/review/`               |
| Pending-purchases review queue     | `helios/src/client/routes/catalog/PendingPurchasesPage.tsx` |
| Repricing run review (planned)     | n/a (will land via this contract)                |
| Market-data match preview (planned)| n/a                                              |
| Promo preview (planned, out-of-scope for v1) | n/a                                  |

When you add a new review surface, render the rows from this contract;
do **not** spin up a parallel "compact card" UI. The contract is what
keeps the price-ladder visual / MSO chip / drift roll-up consistent
across surfaces.

## Out of scope for v1

- Promotional pricing display on the ladder (promo discount overlay).
- Multi-site (per-dealer) price split in the ladder marker.
- Bulk-edit affordances spanning multiple families.

These will be additive once the v1 contract ships.
