# Produce Pending Purchase Proposal

Canonical meaning of the recurring user instruction `produce [pending] purchase[s] proposal`,
recorded 2026-05-11 from the standing-meaning declaration in thread
`T-019e191b-0112-72a2-9ab7-47374ebb434b`.

When the user issues this phrase (with optional hint text), the agent must:

1. Read the **current** set of outstanding pending purchases in Sweed across every
   site context (currently Midtown `210705` and Bronx `210249`), enumerating each
   purchase's positions and isolating the line items whose Sweed catalog mapping is
   missing or wrong (`suggestedProduct` null **or** mapped to a known placeholder
   product such as `Preroll Samples Samples`).
2. Produce one or more catalog batch mutation proposals (variant create, group
   create, distributor-product create / re-link, attribute backfill) sufficient to
   resolve every unmapped line item end-to-end. The output is a reviewer-facing
   review packet, not a live write.

## Required Reviewer-Facing UI

- Modern shared price-ladder control for every priced row.
  - Hoverover on every ladder marker must show the underlying source detail
    (current / proposed / competitor listing / market average / GM band).
  - The proposed-price marker must be **slider-draggable** and the row's
    proposed price field must update live as the slider moves.
  - At each grouping level (`Site`, `Category`, `Subcategory`, `Variant`,
    `Brand`) a group-level slider must be able to drag every contained row
    in proportion together. Group drags must respect each row's GM band and
    individual cost basis (no row goes below floor or above ceiling silently).
- Modern click-to-new-tab detail behavior for each row. Clicking a row outside
  existing controls opens that row's detail page in a new tab. Within the
  detail page, every competitor listing dot/marker/row must click-to-new-tab
  into the **source competitor listing page on the competitor's storefront**,
  not the LitAlerts entry. The competitor's ecom URL is the canonical link.
- Required left-side packet tree-navbar that mirrors the full
  `Site → Category → Subcategory → Variant → Brand` hierarchy and exposes a
  global `Escape` keypress toggle that hides/shows the entire sidebar.
  Reuse `ui/controls/tree-nav/` rather than reinventing the control.

## Required Sourcing And Quality Gates

- **No silent failures.** Every step (Sweed read, catalog inspection, LitAlerts
  search, competitor sitemap fetch, LLM call, image fetch, brand MSO lookup) must
  either succeed or be retried with creative variations until the operator's
  intent is achieved. If a step ultimately cannot succeed, surface that loudly
  in the packet metadata and (for unattended runs) call `page-dave` rather than
  swallowing the failure into reviewer notes.
- **Market research must include LitAlerts** (statewide for the brand + closer
  geographic dispensary listings where useful) per
  [`pricing-rules.md`](./pricing-rules.md) and
  [`../../litalerts/product-matching.md`](../../litalerts/product-matching.md).
- **Source-of-truth competitor ecom assessment.** For each competitor whose
  listing is being used as evidence, fetch and parse that competitor's
  storefront sitemap, use an LLM advisory pass to make sense of the competitor's
  bespoke product naming / category organization, then locate the matching
  product page. Competitors **want** their catalog to be indexable; exploit
  the sitemap rather than scraping blind. Capture the canonical product URL
  for click-to-new-tab linking from the packet detail page.
- **LLM quality pass on the final results.** After the packet is assembled,
  run an LLM advisory review of each row (matching quality, pricing rationale,
  evidence sufficiency, image relevance) and surface the LLM's verdict + any
  flagged risks inline. Consult
  [`../../private-llm/access-paths-and-secrets.md`](../../private-llm/access-paths-and-secrets.md)
  and respect [`../../config/llm_use/registry.yaml`](../../../config/llm_use/registry.yaml).

## Pricing Standards

- Outside competitor pressure, target post-tax GM bands by brand classification:
  - **MSO brands** (Multi-State Operator): target **60% – 67.5%** GM.
  - **Non-MSO brands**: target **55% – 64.5%** GM.
- The MSO classification is **per-brand** and is looked up against our database
  (`module_annotations` with `kind = 'mso'`, scope_ref carrying the Sweed
  brand id). If a brand has no MSO annotation, default to non-MSO and surface
  the gap as a reviewer flag rather than guessing silently.
- Competitor pressure (`1.13 × pre-tax average competitor price`) still
  overrides the GM floor when matching market is incompatible with the floor;
  see [`pricing-rules.md`](./pricing-rules.md) for the existing rule.
- Quarter-dollar price endings (`.00`, `.25`, `.50`, `.75`), prefer `.00` and
  `.50`. No charm pricing.

## Product Matching Standard

- Prefer **exact normalized product** match.
- When exact match is unavailable, the next acceptable evidence tier is
  **brand-categorical-variant equivalent**: same brand, same category, same
  generic "thing" (e.g. two `0.5g preroll two-packs` from the same brand but
  different cultivars/flavors form an acceptable family). A two-pack vs a
  single, vs a five-pack, vs a different brand is **not** equivalent.
- Label the evidence tier on every row so the reviewer can see whether they
  are looking at a true product match or a brand-categorical-variant equivalent.

## Forward-Thinking Standard

- This packet is the **canonical example** of how pending-purchase catalog
  mutation proposals should look in this workspace, including the eventual
  Helios replacement of the catalog operator surface
  ([`../../helios/migration-and-ownership.md`](../../helios/migration-and-ownership.md)).
  When Helios subsumes this workflow, the React surface should mirror the
  same UI affordances (price ladder, group slider, tree-nav with Escape,
  click-to-new-tab competitor source links, LLM quality verdict) without
  regressing from the static-packet capabilities documented here.

## Site-Scoped Verification Rules

- Per [`foundations.md`](./foundations.md): each per-site read block must
  begin with `store.auth.dealer.set { dealerId }` and verify
  `currentDealerId` / `currentDealerName` before any further reads.
- Catalog inspection / mutations always run from the `Freshly Baked NY` state
  dealer `210248`.

## Page Before Opening

- After producing the packet artifact, the agent must `page-dave` and **wait
  for explicit go-ahead before opening the packet in Firefox** (the reviewer's
  preferred browser for these packets). The legacy generator's auto-open in
  Chrome is not appropriate for this canonical flow.
