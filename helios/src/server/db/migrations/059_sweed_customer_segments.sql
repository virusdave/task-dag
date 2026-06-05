-- Sweed marketing-segment caches for the customer / check-in details
-- page segment surface.
--
-- virusdave/top-level#12 / FreshlyBakedNYC/automation#40.
--
-- Goal: the customer-visitor details page shows which Sweed marketing
-- segments a linked customer belongs to (grouped by site / state
-- scope), and offers an "add to a static segment" affordance.
--
-- Why a cache (DB-cost hard requirement, docs/canon/AGENTS_CANON.md):
-- the only way to read a customer's segment membership is the live
-- Sweed RPC `store.customer.segment.list { id }`, which consumes a
-- pooled session token and adds Sweed round-trip latency. We must NOT
-- call it on every details-page load. Instead the per-scan link
-- worker (linkVisitorScanToSweedJob) refreshes membership once when it
-- links a customer, an explicit operator "Refresh segments" button can
-- re-pull on demand, and the details endpoint reads ONLY from these
-- cache tables (a single indexed lookup, no Sweed call).
--
-- `store.customer.segment.list` was verified (live probe) to return
-- the customer's FULL membership regardless of which dealer context is
-- pinned, with each row carrying the segment's owning `dealer.id`
-- (210248 = state / all stores, 210705 = Midtown, 210249 = Bronx).
-- That lets us safely snapshot-replace the whole membership per
-- refresh.

\echo 'Running migration 059: sweed_customer_segments...'

-- ── Per-customer segment membership cache ────────────────────────────
-- One row per (customer, segment). `scope_dealer_id` is the segment's
-- owning dealer (its site/state scope) as reported by Sweed.
create table if not exists sweed_customer_segments (
  sweed_customer_id    bigint  not null,
  segment_id           bigint  not null,
  segment_name         text    not null,
  segment_description  text,
  segment_type_id      integer,
  segment_type_name    text,
  scope_dealer_id      bigint  not null,
  scope_dealer_name    text,
  enabled              boolean,
  date_on_enter        timestamptz,
  refreshed_at         timestamptz not null default now(),
  primary key (sweed_customer_id, scope_dealer_id, segment_id)
);

-- ── Per-customer refresh highwater ───────────────────────────────────
-- Lets the UI distinguish "never fetched" from "fetched, zero
-- segments", and drives the manual-refresh cooldown + dedup.
create table if not exists sweed_customer_segments_refresh (
  sweed_customer_id  bigint  primary key,
  status             text    not null
                       check (status in ('pending', 'ok', 'failed')),
  requested_at       timestamptz,
  refreshed_at       timestamptz,
  segment_count      integer not null default 0,
  last_error         text,
  updated_at         timestamptz not null default now()
);

-- ── Marketing-segment catalog cache ──────────────────────────────────
-- The full list of segments (across all stores) from
-- `store.marketing.segment.list`, refreshed at most once every few
-- hours (global highwater below). Backs the "add to a static segment"
-- picker: we list the Static segments the customer is NOT already in,
-- grouped by scope, each with a deep link into Sweed Prime.
-- NOTE: `store.marketing.segment.list` is dealer-context SCOPED — the
-- static segments (delivery zones, imports, etc.) only appear when you
-- call it pinned to the SITE dealer that owns them; the state dealer
-- returns the org-wide dynamic segments. So the catalog is refreshed by
-- fanning the call out across the state + both site dealers, and each
-- row records the `scope_dealer_id` it was seen under (210248 = state /
-- all stores, 210705 = Midtown, 210249 = Bronx) — the same scope axis
-- the per-customer membership cache uses.
create table if not exists sweed_marketing_segments (
  segment_id          bigint  primary key,
  segment_name        text    not null,
  segment_type_id     integer,
  segment_type_name   text,
  enabled             boolean,
  total_customers     integer,
  scope_dealer_id     bigint,
  -- Store name(s) the segment targets, as reported by segment.list.
  target_store_names  text[]  not null default '{}',
  refreshed_at        timestamptz not null default now()
);

-- Single-row global highwater for the catalog refresh cadence.
create table if not exists sweed_marketing_segments_refresh (
  id            integer primary key default 1,
  status        text    not null
                  check (status in ('pending', 'ok', 'failed')),
  refreshed_at  timestamptz,
  segment_count integer not null default 0,
  last_error    text,
  updated_at    timestamptz not null default now(),
  constraint sweed_marketing_segments_refresh_singleton check (id = 1)
);

\echo 'Migration 059 complete.'
