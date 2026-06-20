-- Migration 095: Purchase inventory pricing-safety lifecycle (L1).
--
-- Parent epic virusdave/top-level#33, Helios child epic
-- FreshlyBakedNYC/automation#54, stage L1. Authoritative design:
--   top-level docs/designs/prospective-pending-purchase-classifier.md
--     ("Post-apply pricing safety: the quarantine → reprice → release
--      lifecycle")
--   top-level docs/epics/prospective-pending-purchase/EPIC_PLAN.md (L1).
--
-- WHAT this builds (L1 only — NO reverse/release move, that is L2)
-- ───────────────────────────────────────────────────────────────
-- A durable per-PURCHASE lifecycle record, keyed by (dealer_id, po_id),
-- that sequences the money-safety gates a brand-new received SKU must
-- pass before it can sell:
--
--   not_started
--     → awaiting_receive_to_quarantine   (operator receives PO into the
--                                          NOT-FOR-SALE "Dave inspection"
--                                          room in Sweed)
--     → quarantined        GATE: every expected positive-qty lot is in a
--                                NOT-FOR-SALE room (live Sweed re-read)
--     → market_refresh_pending  (enqueue Lit Alerts for the purchase's
--                                live product ids)
--     → market_ready       GATE: each product has a SUCCEEDED competitor
--                                observation captured AFTER the run's
--                                market_requested_at cutoff
--     → pricing_pending    (create an explicit-product-id pricing batch)
--     → awaiting_price_approval → price_apply_pending
--     → priced_verified    GATE: live Sweed price == approved desired
--                                price (within 1¢) for every product
--     → blocked(reason)    partial_receive | quarantine_breach |
--                          market_refresh_failed/timeout | pricing_failed
--                          | price_not_approved | price_apply_failed
--
-- L1 deliberately STOPS at priced_verified. The release_in_progress /
-- released states and the reverse bulk room move are L2; this migration
-- does NOT include them so the "no release route yet" guarantee is
-- enforced at the schema level (the state check rejects those values).
--
-- Quarantine is OPTIONAL (operator decision 5): a run carries a `path`
-- of either 'quarantine' (full lifecycle) or 'reprice_in_place' (skip
-- the quarantine gate, reprice the already-sellable lots). The state
-- machine is entered at the stage matching the chosen path.
--
-- DB-cost note (canon §3)
-- ───────────────────────
-- One run row per PO and a handful of item rows per run; these tables
-- grow at the rate POs are received (tens/day), so they are tiny. The
-- indexes below cover the only read patterns L1 needs (lookup by PO,
-- by state for a future advance job, by pricing batch, by product/lot
-- for the verifiers). No hypertable / CAGG / rollup.
--
-- The Lit Alerts `enqueue_reason` check is WIDENED (not replaced) to add
-- the new 'purchase-lifecycle' value the market-refresh route enqueues
-- under, so the lifecycle's market pull is a distinct dedupe lane from
-- the existing 'pending-purchase' / 'rolling' flows.
--
-- Idempotent: `create table if not exists`, `create index if not
-- exists`, and a drop-then-add of the enqueue_reason constraint (the
-- ADD is NOT VALID + a separate VALIDATE so the ACCESS EXCLUSIVE lock
-- window on the live queue table stays sub-second). Safe to re-run.
-- Does NOT auto-apply on deploy (canon §3): applied on prod by the
-- agent only after Oracle DB review + explicit operator approval, then
-- verified live.
--
-- Lock-window discipline: this migration runs in THREE separate
-- transactions so the live `pending_litalerts_refresh_queue` table is
-- held under ACCESS EXCLUSIVE for only the brief metadata flip in Phase
-- 1 — it is NOT held for the duration of the (slower) lifecycle-table
-- DDL. Phase 1 = drop+add NOT VALID on the queue check; Phase 2 = create
-- the lifecycle tables/indexes (no lock on the live queue table); Phase 3
-- = VALIDATE the new check (SHARE UPDATE EXCLUSIVE only — does not block
-- queue reads/writes).

\set ON_ERROR_STOP on
\timing on

\echo 'Running migration 095: purchase inventory lifecycle (L1)...'

-- ── Phase 1: widen the Lit Alerts enqueue_reason check ─────────────────
-- Its OWN tiny transaction so the ACCESS EXCLUSIVE lock on the live queue
-- table is released immediately (before the lifecycle-table DDL below),
-- keeping the lock window to a sub-second metadata flip. Drop + re-add
-- NOT VALID skips the table scan here; Phase 3 does it lock-lightly.
begin;
set local lock_timeout = '5s';

alter table pending_litalerts_refresh_queue
  drop constraint if exists pending_litalerts_refresh_queue_enqueue_reason_check;

alter table pending_litalerts_refresh_queue
  add constraint pending_litalerts_refresh_queue_enqueue_reason_check
  check (enqueue_reason in (
    'rolling',
    'proposal-source',
    'pending-purchase',
    'brand-alarm',
    'in-stock-alarm',
    'manual',
    'purchase-lifecycle'
  )) not valid;

commit;

-- ── Phase 2: create the lifecycle tables/indexes ───────────────────────
-- Separate transaction; touches only brand-new tables, so it takes no
-- lock on the live queue table no matter how long the DDL runs.
begin;
set local lock_timeout = '5s';

-- ── purchase_inventory_lifecycle_runs: one durable run per PO ──────────
create table if not exists purchase_inventory_lifecycle_runs (
  id bigserial primary key,

  dealer_id bigint not null,
  po_id text not null,
  site_key text not null,

  -- 'quarantine'        = full lifecycle (move-to-quarantine first).
  -- 'reprice_in_place'  = skip the quarantine gate; reprice live lots.
  path text not null,

  state text not null default 'not_started',
  blocked_reason text,

  -- Cutoff for the market-ready gate: stamped immediately BEFORE the
  -- Lit Alerts enqueue so a fast worker cannot capture an observation
  -- before the cutoff and create a false "ready". A succeeded
  -- observation counts only if captured_at > market_requested_at.
  market_requested_at timestamptz,

  -- The proposal_batches row created by the purchase-reprice route.
  pricing_batch_id bigint,

  -- Distinct, sorted product-id gate set (market + pricing verifiers
  -- iterate this). Lines that share a product collapse to one id here.
  expected_product_ids bigint[] not null default '{}',

  -- Optimistic-concurrency guard: every state mutation bumps this and
  -- predicates on the caller's expected version, so a stale tab / the
  -- future advance job cannot silently stomp a concurrent transition.
  version integer not null default 1,

  created_by_user_id bigint,
  notes text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (dealer_id, po_id),
  -- Composite uniqueness so the items table can FK on (run_id, dealer_id,
  -- po_id) and make a corrupt denorm impossible.
  unique (id, dealer_id, po_id),

  constraint purchase_inventory_lifecycle_runs_path_check
    check (path in ('quarantine', 'reprice_in_place')),

  constraint purchase_inventory_lifecycle_runs_state_check
    check (state in (
      'not_started',
      'awaiting_receive_to_quarantine',
      'quarantined',
      'market_refresh_pending',
      'market_ready',
      'pricing_pending',
      'awaiting_price_approval',
      'price_apply_pending',
      'priced_verified',
      'blocked'
    )),

  -- blocked_reason is present iff state = 'blocked'.
  constraint purchase_inventory_lifecycle_runs_blocked_reason_check
    check (
      (state = 'blocked' and blocked_reason is not null)
      or (state <> 'blocked' and blocked_reason is null)
    ),

  foreign key (dealer_id, po_id)
    references sweed_purchases (dealer_id, po_id)
    on delete cascade,

  foreign key (pricing_batch_id)
    references proposal_batches (id)
    on delete set null
);

create index if not exists purchase_inventory_lifecycle_runs_state_idx
  on purchase_inventory_lifecycle_runs (state);
create index if not exists purchase_inventory_lifecycle_runs_pricing_batch_idx
  on purchase_inventory_lifecycle_runs (pricing_batch_id)
  where pricing_batch_id is not null;

-- ── purchase_inventory_lifecycle_items: one row per expected lot ───────
-- Granularity is the physical inventory item (lot), not the product:
-- room moves (L2) are lot-level, the quarantine gate is lot-level, and
-- one product can have many lots / one PO line many lots. Product-level
-- gates are driven from runs.expected_product_ids, not from these rows.
create table if not exists purchase_inventory_lifecycle_items (
  id bigserial primary key,

  run_id bigint not null,
  dealer_id bigint not null,
  po_id text not null,
  line_id text not null,

  inventory_item_id text not null,
  sweed_product_id bigint not null,
  metrc_tag text,
  expected_qty numeric(14, 3),

  -- Quarantine gate evidence (live Sweed re-read).
  quarantine_verified_at timestamptz,
  quarantine_stock_location text,
  quarantine_current_qty numeric(12, 3),

  -- Market gate evidence. We store the observation identity + its
  -- captured_at, but do NOT FK to litalerts_competitor_observations:
  -- after migration 055 that table's PK is (id, captured_at), not id.
  market_observation_id bigint,
  market_observation_captured_at timestamptz,
  market_ready_at timestamptz,

  -- Price-applied gate evidence (live Sweed price vs approved desired).
  price_applied_verified_at timestamptz,
  approved_price_dollars numeric(12, 4),
  live_price_dollars numeric(12, 4),

  notes text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (run_id, inventory_item_id),

  foreign key (run_id, dealer_id, po_id)
    references purchase_inventory_lifecycle_runs (id, dealer_id, po_id)
    on delete cascade,

  foreign key (dealer_id, po_id, line_id)
    references sweed_purchase_line_items (dealer_id, po_id, line_id)
    on delete cascade
);

create index if not exists purchase_inventory_lifecycle_items_run_product_idx
  on purchase_inventory_lifecycle_items (run_id, sweed_product_id);
create index if not exists purchase_inventory_lifecycle_items_inventory_item_idx
  on purchase_inventory_lifecycle_items (dealer_id, inventory_item_id);

commit;

-- ── Phase 3: validate the widened check ────────────────────────────────
-- Its own transaction. VALIDATE CONSTRAINT scans the queue table but takes
-- only SHARE UPDATE EXCLUSIVE, so concurrent reads/writes are NOT blocked.
begin;
set local lock_timeout = '5s';

alter table pending_litalerts_refresh_queue
  validate constraint pending_litalerts_refresh_queue_enqueue_reason_check;

commit;

\echo 'Migration 095 complete.'
