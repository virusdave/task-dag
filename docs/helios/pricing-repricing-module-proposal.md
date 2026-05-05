# Helios Pricing Repricing Module Proposal

This doc captures the current planning proposal for a full-featured Helios repricing workflow alongside the foundations already implemented in Helios. Treat the implementation notes here as the durable baseline and the remaining sections as the forward-looking shape for the dedicated pricing module.

Source context:

- current Helios pricing generation and review code in `helios/`
- legacy reviewer-first pricing packet scripts and HTML detail pages in `bulk_additions/2026-04-10/` and `bulk_additions/2026-04-18/`
- Oracle architecture review from the repricing planning pass in thread `T-019dd467-40c8-717a-bb03-61a46cde11d6`

## Current Implemented Foundations

The following repricing foundations are already live in Helios as of 2026-04-29:

- pricing contracts, API routes, and the generate page now expose a real `midtownEverReceived` scope flag so Midtown repricing can target every mirrored catalog product ever received on a Midtown purchase order with a received-like status
- `src/worker/pricing/productScope.ts` now provides a reusable Midtown received-history helper that pages purchase orders, aggregates unique product IDs with order and position counts plus latest received date, and caches the result briefly for repeat runs
- deterministic pricing no longer drops in-band products from review; it now emits explicit `keep-price` review rows so full-scope runs preserve coverage visibility instead of silently skipping already-correct prices
- the Bronx + Midtown packet generator remains the current reviewer surface and now consumes the Midtown historical scope, shows keep-price rows, and updates the packet hero copy and badges to describe Midtown received history rather than only live inventory
- Lit Alerts pricing research now has a bounded Mantle fallback for thin-comp cases: if a SKU ends with fewer than 3 near/mid comps after deterministic discovery, Helios can ask `google.gemma-3-27b-it` for up to 4 additive follow-up search terms, rerun those searches, merge the results, and record the adaptation in the market note
- pricing dependency health checks now require both Lit Alerts and Bedrock availability before starting a pricing batch so the run cannot begin in a degraded state that would silently skip the thin-comp fallback
- market-research transport failures now retry with exponential backoff for both Lit Alerts and Mantle; if the dependency still fails after the bounded retries, the run pages Dave and aborts instead of surfacing a reviewer-facing `availability: error` note
- deterministic family discovery is now more tolerant of internal potency annotations during Lit Alerts search-term derivation, so same-brand families like annotated Ayrloom gummies can still discover the right statewide listing cluster without relaxing the final evidence filter

## Goals

- Add a dedicated Helios pricing module that is optimized for reviewer throughput rather than generic managed-field editing.
- Support full-catalog repricing, filtered subset repricing, single-product repricing, and bulk manual repricing from one shared workflow.
- Preserve the locked operating model:
  - Sweed is the live source of truth.
  - Helios stores desired approved pricing state.
  - the UI never writes prices to Sweed synchronously.
  - generation, approval-triggered reconcile, and live verification stay on the worker side.
- Preserve the current pricing strategy unless the user revises it before the first live Helios repricing run.
- Recover the strongest reviewer affordances from the older packet workflow: grouped packet summaries, compact pricing ladders, evidence-rich detail pages, and fast drill-in for exceptions.

## Current Baseline

Helios pricing already supports:

- deterministic pricing proposal generation through `proposal.generate.pricing_batch`
- historical Midtown received-history repricing through the `midtownEverReceived` scope flag
- the workspace pricing rules already locked in TypeScript:
  - GM formula `1 - 1.13 * cost / price`
  - target GM band `55%` to `65%`
  - no-comparables fallback target `64.5%`
  - quarter-dollar snapping with `.00` and `.50` preferred
  - below-market targeting when Lit Alerts evidence exists
- optional Lit Alerts enrichment with nearby-first and statewide fallback evidence
- bounded Mantle search-term adaptation when deterministic Lit Alerts discovery leaves a SKU below 3 near/mid comps
- generic proposal line items on `products.price`
- generic review editing, approval, rejection, history, and reconcile/apply plumbing

Helios pricing is still missing the operator-facing surface needed for serious repricing work:

- current generation still lacks a full operator workbench even though it now supports the specific `midtownEverReceived` historical scope in addition to page-local generation
- current pricing review lives inside the generic compact review queue
- current group detail is a technical debug page, not a pricing workspace
- current history is broad catalog history, not run-centric repricing history
- current UI still does not expose the broader full-catalog scope builder, saved repricing modes, in-stock prioritization controls, or packet-style run summaries as first-class Helios pages

## Recommended Information Architecture

Create a real `pricing` Helios module and treat pricing proposal batches as first-class repricing runs.

Recommended routes:

- `/pricing`
  - landing redirect to `/pricing/review`
- `/pricing/review`
  - pricing-specific review queue and approval workbench
- `/pricing/generate`
  - repricing scope builder and run launcher
- `/pricing/runs`
  - repricing run history index
- `/pricing/runs/:proposalBatchId`
  - packet-style run summary page
- `/pricing/groups/:catalogGroupId`
  - pricing-focused group summary page
- `/pricing/groups/:catalogGroupId/products/:productId`
  - pricing-focused product detail page

Keep `/catalog/groups/:catalogGroupId` as the lower-level technical catalog debug page. The pricing module should link to it, not replace it.

## Core Operator Flow

The intended day-to-day flow is:

1. generate a repricing run for a chosen scope
2. review the packet-style run summary
3. work through the pricing review queue in priority order
4. drill into the product detail page only for rows that need evidence inspection or manual edits
5. approve or reject proposals and let the worker reconcile asynchronously

This keeps the fast path dense and decision-oriented while reserving the heavier detail page for exceptions.

## Run Model

Do not invent a second orchestration system initially. Reuse `proposal_batches(type = 'pricing')` as the canonical repricing run record and enrich its config and summary payloads.

Recommended run metadata additions inside `config_json` and `summary_json`:

- `scopeKind`
  - `full_catalog`
  - `filtered_catalog`
  - `explicit_selection`
  - `single_product`
  - `saved_profile`
- `scopeLabel`
- `selectionFilters`
  - search
  - brand ids or names
  - category ids
  - subcategory ids
  - product tab or lane filters
  - site filter
  - in-stock mode
- `resolvedCatalogGroupIds`
- `resolvedProductIds` or `resolvedProductCount`
- `priorityPolicy`
- `triggerSource`
  - `manual`
  - `scheduled`
  - `rerun`
- `forceLiveRefresh`
- coverage metrics in the final summary:
  - requested groups
  - requested products
  - actionable products
  - skipped products
  - products missing usable cost
  - products with market evidence
  - products prioritized by in-stock scope

## Scope Modes

The generation workspace should support these modes from day one:

- Full catalog repricing
  - all managed catalog products currently mirrored into Helios
- Historical received-history repricing
  - all mirrored catalog products ever received by a selected site, starting with Midtown via the implemented `midtownEverReceived` scope
- Filtered subset repricing
  - category, subcategory, brand, search, and lane-driven scopes
- Site-prioritized repricing
  - use a site filter plus in-stock mode to define or prioritize scope
- Explicit selection repricing
  - selected groups or selected products from browser or detail surfaces
- Single-product repricing
  - queue a repricing run from an individual product detail page

Important rule:

- site and in-stock filters are selection or prioritization controls, not a site-specific pricing write mode
- if approved prices still write to the state catalog globally, label that clearly in the UI

Current implemented note:

- the first historical received-history scope is Midtown-only and is intentionally purchase-history-based rather than inventory-based so reviewers can sweep the full Midtown catalog footprint instead of only the currently out-of-band live set

Recommended in-stock options:

- `ignore`
  - site inventory is not considered
- `prioritize`
  - include all targeted products, but sort in-stock rows first in run summaries and the review queue
- `only`
  - restrict run scope to products currently in stock at the selected site

## Generate Page

`/pricing/generate` should be a real scope builder, not a single button.

Recommended layout:

- Scope panel
  - full catalog
  - filtered subset
  - explicit selection
  - single product
- Filters panel
  - search
  - brand
  - category
  - subcategory
  - size tab or lane
  - site
  - in-stock mode
  - optional filters for common pricing-only triage such as missing price, below GM floor, above GM ceiling, missing cost, or no market evidence
- Generation options panel
  - force live refresh
  - run note or reason
  - run priority label
- Scope summary panel
  - targeted groups
  - targeted products
  - in-stock-at-site count
  - estimated blockers such as missing cost
- Launch actions
  - queue repricing run
  - save as automatic profile later if scheduled repricing is added

This page should feel like an operator workbench for defining intent, not a review surface.

## Review Queue

`/pricing/review` should be the primary daily work surface.

Use a dense table with a side drawer instead of the current card-per-line-item layout.

Recommended default sort order:

1. in-stock rows for the selected priority site
2. manual runs before automatic runs
3. latest unsuperseded runs first
4. largest meaningful pricing delta or strongest evidence rows near the top

Recommended filter bar:

- run
- run source: manual or automatic
- approval status
- site
- in-stock only
- action type: raise, lower, set, keep if represented
- evidence quality: nearby, statewide, none
- brand
- category
- subcategory
- edited-only
- has validation issues
- show superseded rows toggle

Recommended table columns:

- select checkbox
- priority badge
- action chip
- product name
- group name
- brand
- category or lane
- site stock indicator
- current price
- proposed price
- delta dollars
- delta percent
- current GM
- proposed GM
- cost
- market average
- evidence badge
- reason snippet
- run link
- last updated timestamp

Recommended side drawer sections:

- Pricing context
  - current, proposed, effective price
  - GM movement
  - cost
  - market average, median, IQR, range
  - compact ladder
- Evidence
  - row-level evidence list
  - family-level evidence list
  - nearby versus statewide source
  - exact, family, cultivar-equivalent, or generic match labels when available from the data
- Reasoning
  - explicit deterministic reason text
  - why the proposal does or does not use market evidence
  - why the proposal does or does not preserve the current price
- Review controls
  - edit price
  - note
  - approve
  - reject
  - approve selected
  - reject selected

High-value throughput features:

- keyboard shortcuts
- sticky filters
- remembered table density and column visibility
- approve-and-next behavior
- quick open into full product detail without losing queue context

## Run Summary Page

`/pricing/runs/:proposalBatchId` should intentionally recover the older packet review experience.

Recommended top-level sections:

- Run summary cards
  - scope label
  - requested groups and products
  - actionable rows
  - skipped or no-change coverage
  - in-stock priority coverage
  - evidence coverage
  - failures or warnings
- Actionable rows
  - grouped packet view with compact ladders
- Skipped or no-change coverage
  - products kept because they are already in band
  - missing-cost products
  - no-safe-market-evidence products
- Failures and warnings
  - refresh errors
  - validation issues
  - data gaps
- Run metadata
  - who launched it
  - when
  - config filters
  - force-refresh flag

Recommended grouping hierarchy:

- category
- subcategory or lane
- variant or size lane when useful
- brand

Each actionable row should expose:

- product and group identity
- current and proposed price
- compact ladder
- evidence coverage summary
- reason snippet
- quick review link
- full detail link

The run page should show both what changed and what was covered but left unchanged. That coverage view was a major trust feature of the old packets and should not be dropped.

## Product Detail Page

`/pricing/groups/:catalogGroupId/products/:productId` should be a pricing-first detail page for exception handling.

Recommended sections:

- Hero summary
  - product, group, brand, distributor, action chips
- Large pricing ladder
  - current, proposed, market-average markers
  - nearby competitor points
  - median, IQR, range metadata
- Pricing context
  - current price and GM
  - proposed price and GM
  - cost
  - price reason
  - fallback or market-evidence explanation
- Market evidence
  - enumerated matched listings
  - nearby versus statewide grouping
  - match labels
  - outbound listing links
- Family evidence
  - same-brand or same-lane related products when the strategy borrows family alignment
- Proposal history
  - prior pricing runs
  - prior edits
  - approval history
  - reconcile or apply outcomes
- Debug link
  - link back to `/catalog/groups/:catalogGroupId` for full live snapshot and worker diagnostics

This page should be opinionated and reviewer-facing, not just a JSON dump of live and desired state.

## Manual And Automatic Repricing

All repricing modes should share one run model, one queue, and one approval path.

Manual single-product repricing:

- queue from product detail or group pricing page
- creates a normal pricing run with a tiny scope

Manual bulk repricing:

- queue from the generate page or future multi-select browser flow
- produces a normal pricing run with filter-based or explicit selection scope

Automatic proposal generation:

- should eventually run through saved repricing profiles
- should create the same pricing run shape with `triggerSource = scheduled`
- should never bypass approval in V1

Do not add a separate automatic apply permission path. Keep approval as the gate to live reconcile in V1.

## Reuse Versus Replace

Reuse directly:

- `proposal_batches`, `proposal_rows`, and `proposal_line_items`
- existing async job queueing and polling patterns
- pricing generation worker logic and Lit Alerts enrichment
- existing approval, edit, note, and history plumbing
- existing worker-side reconcile and verification behavior

Replace or strongly augment as the main pricing UX:

- the current card-based generic `ReviewPage`
- the current `CatalogPage` pricing generation card as the primary pricing entrypoint
- the current `GroupDetailPage` as the primary reviewer detail surface

Retain current generic catalog views for debugging and cross-domain review, but do not force repricing operators to live in them.

## Smallest Safe Migration Path

Phase 1:

- create the `pricing` module routes
- promote pricing proposal batches into first-class repricing runs
- add richer scope metadata to pricing batch config and summary payloads
- build `/pricing/runs` and `/pricing/runs/:proposalBatchId`

Phase 2:

- build the pricing-specific review queue as a dense table plus drawer
- keep the same underlying approve, reject, edit, and note APIs where possible
- add pricing-specific filters and run-aware navigation

Phase 3:

- build `/pricing/generate` as a real scope builder
- support full-catalog, filtered, explicit-selection, site-prioritized, and single-product runs
- add site and in-stock prioritization semantics to the UI and run metadata

Phase 4:

- add pricing-specific group and product detail pages
- add better superseded or stale run presentation
- add automatic saved-profile scheduling only after manual workflow is solid

This path keeps the architectural change small while delivering the biggest reviewer-value improvements early.

## Risks And Guardrails

- Site-scoped wording can mislead reviewers into thinking prices are site-local. The UI must state clearly when site filters are only scope or priority controls.
- Repeated reruns can flood the queue with stale proposals. Default pricing views should hide superseded rows and prefer the latest unsuperseded pricing run.
- The run page must show skipped and unchanged coverage, not only actionable rows, or reviewers will lose trust in the sweep.
- Evidence labels must stay honest. Only show exact, family, cultivar-equivalent, or similar labels when the worker actually has durable data for them.
- Full-catalog scopes may eventually need dedicated target tables if config payloads grow too large, but the first implementation should not assume that complexity prematurely.

## Current Recommendation

The best next implementation path is not a new backend subsystem. It is:

- keep the current async pricing generation and approval architecture
- treat pricing proposal batches as first-class repricing runs
- build a dedicated `pricing` module with generation, run summary, review queue, and drill-in detail pages
- reuse the current worker logic while recovering the reviewer-first packet affordances from the older HTML workflow

That is the smallest safe change that matches the locked operating model and gives operators the full-featured repricing workflow they asked for.
