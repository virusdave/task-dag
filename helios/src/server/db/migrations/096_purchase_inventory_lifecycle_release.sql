-- Migration 096: Purchase inventory lifecycle — gated RELEASE (L2).
--
-- Parent epic virusdave/top-level#33, Helios child epic
-- FreshlyBakedNYC/automation#54, stage L2. Authoritative design:
--   top-level docs/designs/prospective-pending-purchase-classifier.md
--     ("Post-apply pricing safety: the quarantine → reprice → release
--      lifecycle")
--   top-level docs/epics/prospective-pending-purchase/EPIC_PLAN.md (L2).
--
-- WHAT this builds (L2 — the reverse/release move L1 deliberately left out)
-- ───────────────────────────────────────────────────────────────────────
-- L1 (migration 095) stopped at priced_verified and its state CHECK
-- constraint REJECTS the release states, so a release could not even be
-- recorded. L2 widens that state machine and adds the columns the gated
-- release needs:
--
--   priced_verified
--     → release_in_progress  (claim: a release attempt is running; a live
--                             price + live quarantine preflight is
--                             re-checked immediately before EACH lot move,
--                             then the lot is transferred to the chosen
--                             FOR SALE room)
--     → released             GATE: a live re-read confirms every expected
--                             lot is now in a FOR SALE room AND live price
--                             still equals the approved price (within 1¢)
--     → blocked(reason)      release_preflight_failed (gate failed before
--                             any move) | release_partial_failure (some
--                             lots moved, some did not) | release_price_drift
--                             (price moved after a move began — a safety
--                             incident; rollback is the primary recovery)
--                             | release_rollback_failed
--
-- An execution LEASE (release_attempt_id + release_lease_expires_at) makes
-- the long, non-atomic, outside-the-DB-lock transfer sequence safely
-- recoverable: only one attempt holds a live lease at a time; a crashed
-- attempt's lease expires and "continue release" can take over with a new
-- attempt id, while the dead attempt's finalize is a no-op (its id no
-- longer matches). We never hold a DB transaction open across the slow
-- Sweed RPCs.
--
-- DB-cost note (canon §3)
-- ───────────────────────
-- These are pure ALTER ... ADD COLUMN (nullable, no default backfill →
-- no table rewrite) plus a DROP/ADD of the runs state CHECK. Both
-- lifecycle tables are tiny (one run row per PO, a handful of item rows;
-- 0 rows in production at migration time) and are NOT hot, so the brief
-- ACCESS EXCLUSIVE lock to swap the constraint is sub-millisecond. No new
-- indexes are needed: the release verifiers iterate a single run's items,
-- already covered by the L1 indexes.
--
-- This is an ADDITIVE / EXPAND change: every new column is nullable and
-- the state CHECK only widens (adds values), so old (pre-L2) code keeps
-- working against the new schema during the mirror roll.
--
-- Idempotent: `add column if not exists` and a drop-then-add of the state
-- check. Safe to re-run. Does NOT auto-apply on deploy (canon §3):
-- applied on prod by the agent only after Oracle DB review + explicit
-- operator approval, then verified live via the 096 sentinel.

\set ON_ERROR_STOP on
\timing on

\echo 'Running migration 096: purchase inventory lifecycle release (L2)...'

begin;
set local lock_timeout = '5s';

-- ── Widen the runs state machine to allow the release states ───────────
alter table purchase_inventory_lifecycle_runs
  drop constraint if exists purchase_inventory_lifecycle_runs_state_check;

alter table purchase_inventory_lifecycle_runs
  add constraint purchase_inventory_lifecycle_runs_state_check
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
    'release_in_progress',
    'released',
    'blocked'
  ));

-- ── Release run-level columns ──────────────────────────────────────────
alter table purchase_inventory_lifecycle_runs
  add column if not exists release_target_location_id bigint,
  add column if not exists release_target_location_name text,
  add column if not exists release_target_stock_type_id bigint,
  add column if not exists release_requested_at timestamptz,
  add column if not exists released_at timestamptz,
  -- Execution lease: only the attempt whose id matches may finalize, and
  -- "continue release" may only take over once the lease has expired.
  add column if not exists release_attempt_id uuid,
  add column if not exists release_lease_expires_at timestamptz,
  add column if not exists release_last_error text;

-- ── Release per-lot columns (partial-failure recovery / continue) ──────
-- release_verified_at is set ONLY after a live post-read proves the lot
-- is in a FOR SALE room and sellable — never optimistically on transfer.
alter table purchase_inventory_lifecycle_items
  add column if not exists release_transfer_attempted_at timestamptz,
  add column if not exists release_transferred_at timestamptz,
  add column if not exists release_verified_at timestamptz,
  add column if not exists release_stock_location text,
  add column if not exists release_stock_location_id bigint,
  add column if not exists release_stock_type_id bigint,
  add column if not exists release_current_qty numeric(12, 3),
  add column if not exists release_last_error text;

commit;

\echo 'Migration 096 complete.'
