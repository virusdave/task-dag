# Market-Data Sweep, Refresh, and Alarm System

Epic plan for moving Helios's Lit Alerts–backed competitor data from
its current passive / on-demand model to an always-fresh, partner-API
–driven background sweep with explicit freshness contracts and loud
alarms when those contracts can't be met.

## Motivation

While preparing the 67.7%-GM repricing review for the brands on the
2026-05-15 midtown 10FF order
([`catalog/repricing/2026-05-16-10ff-brands/`](../../../catalog/repricing/2026-05-16-10ff-brands/))
we hit three concrete problems that this epic exists to fix:

1. The canonical pricing-ladder UI control was painting "no competitor
   diamonds" everywhere because the only live refresh path —
   [`buildPricingMarketContext()`](../../../helios/src/worker/pricing/litAlertsMarket.ts)
   — talks to the legacy brands-console (`public-api.litalerts.com`)
   endpoints, whose Cognito bearer at
   `~/.secret/litalerts/bearer-token` has expired and whose refresh
   token has been revoked. The cached `litalerts_competitor_observations`
   rows are usable but were ~11 days stale by the time we looked.
2. The freshness of cached observations is invisible at the call sites
   that need it (pricing review, canonical ladder, catalog curation
   proposals). When the bearer dies silently, downstream callers
   degrade silently along with it.
3. There is no automatic enqueue from "we are about to propose
   catalog or pricing changes for product X" to "go refresh X's
   competitor data right now." Refresh today is either operator-
   triggered or scheduled at the very low cadence of
   `configWorkersScheduler`.

Out of scope: changing the pricing math itself (`deterministicPricing.ts`,
`familyPricing.ts`). This epic only changes when / how often / with
what backend the market evidence those modules consume is refreshed,
and how its freshness is reported.

## Settled requirements (from operator)

1. **Source-of-proposal enqueue.** Any product entering the
   "propose product catalog curation / modification" flow MUST be
   enqueued for high-priority market refresh as soon as it appears
   in the proposal scope, regardless of cached freshness.
2. **24-hour rolling re-refresh with stagger.** Every product with
   an observation row gets re-refreshed every 24 h ± a randomised
   jitter (target ±2 h spread) so we don't thunder against the
   partner API.
3. **3–4-day hard expiry.** A cached observation that hasn't been
   re-refreshed within 4 days is considered expired and MUST NOT be
   surfaced as evidence in pricing ladders, repricing reviews, or
   curation proposals without an explicit "stale" annotation.
4. **Loud alarms before expiry** for any product that is currently
   *in stock at any state-active site*, *appears in any pending
   purchase*, or *shares a brand with any pending purchase*. The
   alarm MUST be loud enough to be picked up by the operator before
   the data actually expires; cached evidence for these products
   silently aging out is the exact failure mode we are designing
   against.
5. **High-priority parallel refresh on alarm.** When an alarm fires
   for product P, the refresh job for P (and the rest of P's
   eligibility class — same brand, same pending-purchase basket)
   MUST be re-enqueued at the front of the queue and run in
   parallel rather than serialised behind the steady-state
   rolling refresh.
6. **Capture pricing + image + description + competitor URLs**, not
   just price points. Today's observation row stores `matchedListings`
   with `postTaxPrice`, `dispensaryName`, `distanceMiles`, `url`,
   etc. The full sweep MUST additionally pin per-competitor image
   URLs and the competitor-side product description (or its absence)
   so the canonical curation UI has every artefact a human reviewer
   needs without clicking out.
7. **Partner-API first.** New code MUST target
   `https://partnerapi.litalerts.com` using the agenix-delivered
   token at `~/.secret/litalerts/partner-api-token`. The legacy
   `public-api.litalerts.com` flow is kept around only as a thin
   compatibility shim during migration and gets deleted when the
   partner-API path has full coverage. The
   [`litalerts/README.md`](../../../litalerts/README.md) docs that
   imply the partner API can't do menu listings are stale; the
   per-retailer products endpoint (`/v1/retailers/{retailerId}/products`)
   plus `?state=NY` returns rows with `configs[].normalPrice` /
   `salePrice` / `currentStock` / `medicalURL` / `recreationalURL`
   which together are equivalent to (and richer than) the legacy
   `/Products/menulistings` payload once we fan out across NY
   retailers.

## Current state (what we keep, what we throw out)

What we keep:

- `pending_litalerts_refresh_queue` table and the
  `configWorkersLitalertsRefreshVariantJobPayload` job shape — the
  queue / job-pool plumbing already gives us per-product fan-out and
  audit trails.
- [`configWorkersLitalertsRefreshJob.ts`](../../../helios/src/worker/jobs/configWorkersLitalertsRefreshJob.ts)
  as the worker entry point. Its scaffolding (load queue row, find
  catalog group, persist observation, append audit event,
  idempotent skip) is correct; only the underlying `buildPricingMarketContext()`
  call needs to be swapped.
- `litalerts_competitor_observations` as the canonical evidence
  table. It will gain a few columns (see §Data model) but its row
  shape and `evidence_json -> matchedListings` contract are kept so
  every existing reader — including the canonical pricing-ladder UI
  in `helios/src/shared/ui/pricing-ladder/` — works unchanged.

What we throw out:

- The brands-console bearer/refresh-token rotation scripts in
  `litalerts/`, except as an emergency break-glass. The agenix
  partner-API token is the sole supported credential going forward.
- Direct calls in `litAlertsMarket.ts` to `/Manufacturers/real`,
  `/Dispensaries/alllocations`, and `/Products/menulistings`. They
  get replaced by partner-API equivalents (see §Migration).

## Data model changes

Three small, additive migrations on the helios TigerData schema:

1. `pending_litalerts_refresh_queue`:
   - `priority smallint not null default 100`
     (0 = "now", 100 = "steady-state rolling")
   - `next_run_at timestamptz null`
     (for staggered 24 h re-enqueue)
   - `enqueue_reason text not null default 'rolling'`
     (`rolling | proposal-source | pending-purchase | brand-alarm |
     in-stock-alarm | manual`)
   - `alarm_class text null`
     (`in_stock | pending_purchase | brand_match | null`)
2. `litalerts_competitor_observations`:
   - `expires_at timestamptz not null`
     (server-set to `captured_at + 4d`; the canonical authoritative
     freshness contract — readers MUST treat `now() > expires_at`
     as "no evidence" without an explicit override)
   - `next_refresh_at timestamptz null`
     (rolling-refresh hint, populated by the worker)
   - Optional `images_jsonb`, `description_text`,
     `competitor_urls_jsonb` columns to back requirement (6) without
     having to re-fetch each render.
3. New view `vw_pricing_evidence_freshness` that joins
   `catalog_groups → products → litalerts_competitor_observations`
   and exposes per-product `freshness` =
   `fresh | stale | very_stale | absent | expired`, plus the
   alarm-class booleans (`is_in_stock`, `is_in_pending_purchase`,
   `is_brand_of_pending_purchase`). All UI readers move to this
   view so freshness logic lives in one place.

## Architecture

```diagram
╭───────────────────────────────╮          ╭──────────────────────────────╮
│ "Propose curation"            │          │ Rolling-refresh scheduler    │
│   (catalog/repricing,         │──────────│   (configWorkersScheduler)   │
│   pending-purchase packets,   │ enqueue  │   24h ± 2h stagger per row   │
│   bulk_additions, …)          │ pri=10   ╰────────────────┬─────────────╯
╰────────────────┬──────────────╯                           │
                 │ enqueue pri=0                            │ enqueue pri=100
                 ▼                                          ▼
        ╭────────────────────────────────────────────────────────────╮
        │ pending_litalerts_refresh_queue (priority, next_run_at)    │
        ╰─────────────────────────┬──────────────────────────────────╯
                                  │ poll (pri asc, next_run_at asc)
                                  ▼
                ╭───────────────────────────────────────╮
                │ configWorkersLitalertsRefreshJob      │
                │   buildPricingMarketContext() via     │
                │   partner API                         │
                │   ─ /v1/brands/{id}/products          │
                │   ─ /v1/retailers (NY)                │
                │   ─ /v1/retailers/{id}/products       │
                ╰────────────────┬──────────────────────╯
                                 │ upsert observation
                                 ▼
        ╭────────────────────────────────────────────────────────────╮
        │ litalerts_competitor_observations                          │
        │   (matchedListings, images, description, expires_at,       │
        │    next_refresh_at)                                        │
        ╰─────────────────────────┬──────────────────────────────────╯
                                  │ joined via
                                  ▼
        ╭────────────────────────────────────────────────────────────╮
        │ vw_pricing_evidence_freshness                              │
        ╰──────┬─────────────┬───────────────────────────┬───────────╯
               │             │                           │
               ▼             ▼                           ▼
       ╭─────────────╮ ╭──────────────╮      ╭────────────────────────╮
       │ Canonical   │ │ Repricing    │      │ Alarm scanner          │
       │ ladder UI   │ │ review       │      │   in-stock OR pending  │
       │ (diamonds)  │ │ packets      │      │   OR brand-pending     │
       ╰─────────────╯ ╰──────────────╯      │   AND will expire <12h │
                                             │   → pageDave + re-enq  │
                                             │     pri=0              │
                                             ╰────────────────────────╯
```

## Phase / task breakdown

The phases below map 1:1 onto the JSON task-DAG breakdown in
[`task-dag-breakdown.json`](./task-dag-breakdown.json).

### Phase 1 — Partner-API client and migration of `litAlertsMarket.ts`

- Add `helios/src/worker/litalerts/partnerClient.ts`: thin typed
  wrapper around the partner API, reading the token from
  `~/.secret/litalerts/partner-api-token` (or
  `LITALERTS_PARTNER_API_TOKEN`), with a small in-process LRU on
  `/v1/brands`, `/v1/retailers`, and the slowly-changing dictionary
  endpoints.
- Refactor `buildPricingMarketContext()` to call the new client and
  produce a `PricingMarketContext` of the same shape it does today.
  Per-retailer fan-out across NY replaces the cross-retailer
  `/Products/menulistings` bulk endpoint. Distance bands and
  eligibility logic stay where they are.
- Keep `litAlertsMarket.test.ts` green by mocking the new client at
  the same boundary the legacy fetch was mocked at.
- Delete `litalerts/authenticate_with_password.py`,
  `auth_step1_initiate.py`, `auth_step2_complete.py`,
  `refresh_bearer_token.py` once green; leave a short
  `README.md` note pointing rotators at the partner-API
  agenix flow.

### Phase 2 — Freshness contracts in the data model

- Migration: add the `priority` / `next_run_at` / `enqueue_reason` /
  `alarm_class` columns to `pending_litalerts_refresh_queue`,
  defaulting existing rows to `priority=100`,
  `enqueue_reason='rolling'`, `alarm_class=null`.
- Migration: add `expires_at` / `next_refresh_at` / `images_jsonb` /
  `description_text` / `competitor_urls_jsonb` to
  `litalerts_competitor_observations`. Backfill `expires_at` for
  existing rows to `captured_at + 4d`.
- Create `vw_pricing_evidence_freshness` and add unit tests against
  representative seed data.
- Update `configQueries.ts` to expose freshness from the view.

### Phase 3 — Rolling-refresh scheduler with stagger

- Extend `configWorkersScheduler.ts` to enqueue every product with
  `next_refresh_at <= now()` at `priority=100`. New rows pick a
  `next_refresh_at = now() + 24h + Δ` where Δ is uniformly random
  in [-2h, +2h] keyed on `product_id` so a given product's slot
  drifts gently rather than swinging wildly per cycle.
- Worker, on success, recomputes `next_refresh_at`. On terminal
  failure (e.g., brand not in partner API), backs off to 6 h with
  jitter and surfaces the reason in `evidence_json`.

### Phase 4 — Proposal-source enqueue

- Add a small `enqueueMarketRefreshForProducts()` helper alongside
  the queue table.
- Wire it into:
  - The repricing driver
    ([`catalog/repricing/.../reprice.py`](../../../catalog/repricing/2026-05-16-10ff-brands/reprice.py)
    and any successor) so that running the dry run also drops every
    product into the queue at `priority=10`,
    `enqueue_reason='proposal-source'`.
  - The pending-purchase packet generator (`generatePendingPurchasePacketJob`).
  - `bulk_additions/` proposals.
  - Any future "propose product catalog curation" entry point.
- Add an audit event for each enqueue so we can prove the trigger
  fired.

### Phase 5 — Alarm scanner and parallel re-enqueue

- New worker job `configWorkersMarketEvidenceAlarmJob` that runs
  every 15 min and, using `vw_pricing_evidence_freshness`, finds
  every product whose alarm class is non-null AND whose
  `expires_at` is within the next 12 h.
- For each, calls `enqueueMarketRefreshForProducts([productId,
  …same-brand siblings…], { priority: 0, alarm_class })` and
  triggers `pageDave()` with a single batched alarm (per
  alarm class) describing the products and the time-to-expiry.
- Increase the worker pool size for the litalerts refresh job so
  alarm-class enqueues actually run in parallel.

### Phase 6 — Canonical UI surface

- Update `helios/src/shared/ui/pricing-ladder/` (and its React
  wrapper `CanonicalPricingLadder.tsx`) to consume
  `freshness`-tagged evidence and render the freshness chip in the
  ladder head (this is the same `ladder-cache-tag` we already wired
  into the repricing review packet; it's just moving from a
  packet-local helper into the canonical control).
- Update the catalog-curation / repricing review pages to render an
  "evidence freshness" status strip at the top of the page (fresh /
  stale / very-stale / absent / expired counts) and refuse to render
  diamonds for `expired` rows without an `Acknowledge stale` toggle.

### Phase 7 — Cleanup and runbook

- Remove the legacy bearer + refresh-token rotation paths from
  `litalerts/`.
- Add a `docs/helios/market-data-sweep/RUNBOOK.md` covering: how to
  rotate the partner-API token, how to read the freshness view, how
  to manually fire an alarm-class refresh, how to interpret pageDave
  alarms from this system.

## Verification

- Unit tests for the partner client and the migrated
  `litAlertsMarket.ts`.
- Integration test that seeds a `catalog_groups` row plus the
  enqueue, runs the worker against a recorded partner-API response,
  and asserts that the observation row, `expires_at`, and
  `next_refresh_at` are populated correctly.
- A scripted dry-run (under `catalog/repricing/2026-05-16-10ff-brands/`)
  that re-renders the canonical review packet after the new flow
  is live, expecting `fresh` cache tags and full diamond coverage
  for in-scope brands.
- Manual: trigger an alarm by fast-forwarding `expires_at` on a
  known-in-stock product in a non-prod env; confirm pageDave fires
  and a `priority=0` queue row appears.

## Settled follow-ups (operator answers)

1. **Alarm channel**: `pageDave()` for now. No separate channel.
2. **Per-brand expiry override**: yes, but ship with the tight
   4-day default everywhere first; the per-brand override comes as
   a small follow-on once the core flow is healthy.
3. **Expired evidence in curation proposals**: **blocks** without
   explicit operator approval. The canonical UI MUST refuse to let
   a proposal be applied if any in-scope product has
   `freshness='expired'` unless the operator passes an explicit
   `acknowledgeExpiredEvidence: true` per row (or per proposal,
   for bulk overrides). This applies to repricing, catalog
   curation, and any other "propose product catalog modification"
   entry point.

These answers are encoded in the corresponding phases:

- Alarm channel → Phase 5 (`pageDave()` only; no Slack/SMS adapter).
- Per-brand expiry → Phase 2 ships the global 4-day constant; a
  follow-on leaf (`phase2b-per-brand-expiry`) adds a
  `brand_expiry_overrides` table and threads the per-brand TTL
  through the view, scheduler, and alarm scanner.
- Block-on-expired → Phase 6 ships the guard *and* the
  `acknowledgeExpiredEvidence` toggle; Phase 4's
  `enqueueMarketRefreshForProducts()` is the escape hatch the
  operator uses to get back to fresh evidence quickly when a
  proposal is blocked.
