# Promo-aware pricing page — Helios UX + implementation design input

Operator-authored design input recorded from the 1Off Bronx repricing
session (thread `T-019e3c3a-e3bf-7738-b898-3dc60dc6adbe`). The
"interactive OTD scratchpad" at
`catalog/repricing/2026-05-18-1off-bronx-otd/page.html` is a
deliberately throw-away prototype; it is **not** the Helios pricing
UI. This document captures the operator-stated requirements that the
real Helios pricing pages should adopt over time.

The scratchpad lives at
`catalog/repricing/2026-05-18-1off-bronx-otd/` and is regenerated
with `gather_data.mjs` + `build_page.mjs`.

## Why a doc, not just code

The scratchpad is a 30-day artifact. The requirements below are
long-lived and should be reflected in the canonical Helios pricing
pages and their shared UI controls (chiefly
`helios/src/shared/ui/pricing-ladder/`, plus the pricing review
routes under `helios/src/client/routes/pricing/`). This doc is the
hand-off so they don't get lost when the scratchpad is purged.

## Requirements

### 1. Show repricing impact without changing anything

The pricing page must let the operator try **both** kinds of price
move without committing them:

- **Global (chain / state) price changes** — affect every site.
- **Per-site local price overrides** — Bronx-only in this thread,
  Midtown-only on the other side. The page already needs to know
  which site context it's reasoning about (and which is "the rest").

For every row, both move types should:

- Be editable inline.
- Recompute the row's GM% in real time (formula from `reprice.py`:
  `GM = 1 − (1.13 × cost) / price`).
- Reposition the corresponding "our price" diamond on the price
  ladder.

### 2. Promo % is a first-class input

The page must surface **three "our price" diamonds** per row, all in
post-tax (OTD) dollars:

| Diamond           | Source                                                     |
|-------------------|------------------------------------------------------------|
| Current price     | Live chain price OR live site local override, whichever applies right now. Read-only. |
| Proposed price    | Whatever the operator typed (chain or local). Recomputes GM% as it moves. |
| Promo-discounted  | Proposed × (1 − applicable promo %) × 1.13. Visible only when a promo % is in effect for that row. Recomputes its own GM% as it moves. |

The promo % is itself overridable at three levels, cascading from
broadest to narrowest:

1. **Page-level "target discount %"** — defaults to whatever the
   campaign's action currently has.
2. **Group-level override** — overrides the page default for every
   row in that catalog group. Group-level label on the promo
   marker must reflect the *effective* % for that group (not the
   page default).
3. **Row-level override** — overrides the group level for one
   product.

Until the litalerts matching project is done (`virusdave/top-level#4`)
the operator handles any final promo-percent change out-of-band — the
apply engine **must not** attempt to write promo edits. It generates a
note instead.

### 3. Price-ladder rendering must match the canonical control

The canonical control lives at
`helios/src/shared/ui/pricing-ladder/` and already encodes the
operator's standards. The scratchpad and any new pricing-page work
should adopt it directly (or, when interactive markers are needed,
mimic its `bands.ts` constants exactly):

- Competitor dot **color** comes from
  `helios/src/shared/ui/pricing-ladder/bands.ts` — 5 tiers (`very-near`,
  `near`, `mid`, `far`, `statewide`), each with a brand-canonical hex.
- Competitor dot **vertical position** is by band as well; within a
  band, dots micro-adjust upward by proximity (closer to the band's
  lower-mile edge = higher within band, per `topPxForListing()`).
- Within-band color saturation also tracks proximity
  (`colorForListing()`).

### 4. Match-type shapes (depends on litalerts matching project)

Once `virusdave/top-level#4` lands and observations are tagged with
their match type, every competitor marker must communicate the match
quality through shape:

- **Exact-SKU match** → triangle.
- **Family / inferred match** → circle.

The three "our price" markers (current, proposed, promo-discounted)
are always **diamonds** — never repurposed for any other meaning.

### 5. Approval workflow

Every row must carry one of three review states: `unreviewed`,
`approved`, `rejected`. The UI also needs rollup approval at every
hierarchy level the user navigates (group, brand, page-level "approve
all" / "reject all"):

- A group-level approve flips every still-`unreviewed` row in that
  group to `approved`. Already-rejected rows are left alone unless
  the operator explicitly re-approves.
- A group-level state of "mixed" is rendered when the group's rows
  disagree.
- The apply engine refuses to commit changes for rejected or
  unreviewed rows (it batches only `approved` rows).

### 6. Apply engine: differentiate global vs local pricing

When the operator hits Apply, the engine must:

- Compare each approved row's proposed catalog price to its current
  chain price. If different, emit a **global** edit:
  `store.product.edit { id, price }` at the state dealer.
- Compare each approved row's proposed local price to its current
  site override. If different, emit a **local** edit at the site
  dealer (`store.product.edit { id, price }` for create/update, or
  `store.product.price.local.reset { productIds: [...] }` to delete
  an override).
- Promo % changes (page/group/row) **do not** generate edits in this
  iteration. The engine prints a "promo plan" summary the operator
  uses to make the promo edits out-of-band.

The engine output should mirror the dry-run/apply pattern already
established by `bulk_additions/2026-04-10/apply_product_catalog_attribute_updates.py`
and `catalog/repricing/2026-05-16-10ff-brands/reprice.py`: write a
plan JSON, allow `--dry-run` vs `--apply`, and emit a results JSON
with what actually happened.

### 7. GM% per diamond

For each row, three GM% readouts must update live whenever the
corresponding price moves:

- GM% at current price (mostly informational; tells you what the
  current row earns today before any promo).
- GM% at proposed price (no promo).
- GM% at promo-discounted price (uses the effective promo % after
  any per-row/per-group override).

### 8. Group-level promo label

When a group has an effective promo % that differs from the page
default, the group's price-ladder promo marker label must read e.g.
`promo OTD $X (group override 25%)`, not the page default's percent.
Same for row-level overrides.

## Status at time of writing

| Requirement                                                       | Scratchpad now | Helios proper |
|-------------------------------------------------------------------|----------------|---------------|
| Show repricing impact without committing                          | ✓ (Bronx only) | ✗             |
| Edit per-row local price live                                     | ✓              | ✗             |
| Edit per-row chain price live                                     | ✗              | ✗             |
| Three "our price" diamonds (current / proposed / promo-discounted)| ✓              | partial       |
| Promo % overridable per page / group / row                        | ✓              | ✗             |
| Group promo marker label reflects override                        | ✓              | ✗             |
| Approve / reject / unreviewed per row + group                     | ✓              | partial       |
| Apply engine: split global vs local edits                         | ✓ (script)     | ✗             |
| Apply engine: emit promo plan, do not write promo                 | ✓ (script)     | n/a           |
| Canonical 5-tier band coloring + vertical positioning             | ✓              | ✓             |
| Competitor marker shape by match-type                             | ✗ (blocked on #4) | ✗ (blocked on #4) |

The scratchpad does *not* attempt to be a production pricing page —
it skips audit logging, multi-site reasoning, persistence, RBAC,
session state, etc. Those are intentionally out of scope; the
scratchpad's value is as a fast forcing-function for the
UX requirements above.

## Reference artifacts

- Live URL (24h TTL): regenerated each run via `scripts/upload-to-mss`.
- Source: `catalog/repricing/2026-05-18-1off-bronx-otd/`.
- Canonical pricing-ladder control:
  `helios/src/shared/ui/pricing-ladder/`.
- Band constants the scratchpad mirrors:
  `helios/src/shared/ui/pricing-ladder/bands.ts`.
- Cost-based reprice driver (reference for the apply engine pattern):
  `catalog/repricing/2026-05-16-10ff-brands/reprice.py`.
- Litalerts matching project (blocker for triangle/circle shapes):
  https://github.com/virusdave/top-level/issues/4
