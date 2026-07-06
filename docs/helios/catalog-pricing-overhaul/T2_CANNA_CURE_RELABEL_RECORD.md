# Record — Canna Cure mg-labeled preroll relabel at the Sweed catalog source

> Parent umbrella:
> [virusdave/top-level#35](https://github.com/virusdave/top-level/issues/35)
> (catalog-pricing overhaul).
> Child epic:
> [FreshlyBakedNYC/automation#55](https://github.com/FreshlyBakedNYC/automation/issues/55),
> task **T2 — category-aware unit-size "group" equivalency normalizer**
> (`automation` task-dag SHA `2a9b5c5`).
>
> This is the durable in-repo record of the operator's T2 item-4 gate
> resolution and its verified execution. It exists so the T2 implementer
> (and any future reader) knows the two awkward mg-labeled prerolls were
> fixed **at the source** and that the normalizer therefore needs no
> special mg handling for them.

## The decision (operator)

The last open T2 gate question was whether Canna Cure's `583.3mg` /
`416.7mg` prerolls should be folded by the mg→g normalizer or relabeled at
the catalog source. The operator answered on the umbrella
([#35 comment 4887790509](https://github.com/virusdave/top-level/issues/35#issuecomment-4887790509)),
relayed into #55 as the operator-decision comment:

> No, we should fix the catalog, especially if no sites have these in stock.

**Interpretation:** relabel at the Sweed source; do **not** rely on the
normalizer for these two SKUs.

## Stock check (read-only, prod)

At the time of the decision, a read-only query against
`sweed_package_current` (Bronx dealer `210249`, Midtown dealer `210705`)
found **no current inventory packages for either SKU at either site** —
0 packages, 0 available_qty. They were out of stock everywhere, so
relabeling was low-risk (no live listing to disturb). The operator's
out-of-stock condition was therefore satisfied.

## What was relabeled (operator, by hand in Sweed) and verified

The operator edited both variants' size **attribute** to a canonical
close gram weight and updated the variant names to the approximate-grams
convention. Verified live via read-only `store.product.group.get`:

| SKU | Sweed group | old `sizeName` | new `sizeName` (sizeId) | new variant name |
|---|---|---|---|---|
| `43729159` | `36300` Canna Cure GG4 | `583.3mg` | **`0.6g`** (`839`) | `Canna Cure GG4 6x 0.58g` |
| `33085965` | `35898` Canna Cure Blueberry Runtz | `416.7mg` | **`0.4g`** (`1106`) | `Canna Cure Blueberry Runtz 6 x 0.42g` |

For prerolls, `sizeName` is the **per-joint** size (not the pack total),
so these are per-joint gram sizes on a 6-pack (≈3.5 g / ≈2.5 g total —
the operator noted the names are approximate).

## Consequence for T2

Both are now plain gram sizes and fold cleanly under the confirmed T2
bucket table with **no mg special-casing**:

- `0.6g` ∈ [0.45, 0.65) → **0.5 g** bucket
- `0.4g` ∈ [0.30, 0.45) → **0.35 g** bucket

This is the same bucket result the gate analysis predicted for the old
mg labels (0.5833→0.5, 0.4167→0.35), so nothing about the confirmed
table changes. The confirmed bucket table and all four gate items
(buckets / boundaries / tiny-size fold / mg-labels) are now settled; the
full table lives in the umbrella STATUS doc
[`STATUS_2026-07-05_T2-gate-operator-answers-and-mg-catalog-finding.md`](https://github.com/virusdave/top-level/blob/master/docs/epics/catalog-pricing-overhaul/STATUS_2026-07-05_T2-gate-operator-answers-and-mg-catalog-finding.md).

**T2 (`2a9b5c5`) has been unblocked** and is now a pickable frontier leaf.

## Helios catalog cache note (self-healing)

At verification time Helios's cached copy in `catalog_groups.live_state_json`
still showed the old mg labels (last synced 2026-07-01, before the edit).
This is expected: the scheduled catalog sync re-reads `store.product.group.get`,
detects the `live_state_hash` drift, and updates the stored copy on its
next run. No manual sync is required. The T2 explorer grouping reads
whatever is in the catalog at read time, so it will reflect the new gram
sizes once the sync lands.
