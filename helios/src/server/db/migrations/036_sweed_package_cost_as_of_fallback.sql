-- Migration 035: sweed_package_cost_as_of — fall back to earliest snapshot
--
-- Issue #24 follow-up: the original `sweed_package_cost_as_of(dealer,
-- inventory_item_id, ts)` function returned the wholesale cost from
-- the most-recent snapshot whose `observed_at_min <= ts` — pure
-- as-of semantics. That's the right answer in steady state, but it
-- means every order placed BEFORE the snapshot worker started has
-- no cost coverage at all (the worker only began running on
-- 2026-05-26, so any pre-cutover sweed_orders row returns NULL and
-- the COGS / margin metrics on /metrics see < 1% coverage on the
-- trailing-30-day window).
--
-- Fix: when no observed-before-ts row exists, fall back to the
-- earliest known snapshot for the same (dealer, inventory_item_id).
-- That's the operator's best approximation for historical orders —
-- the package's wholesale cost typically doesn't change dramatically
-- restock-to-restock, and the alternative ("NULL until we accrue 30
-- days of history") would force every operator-facing margin chart
-- to read zero for weeks.
--
-- Idempotent: `create or replace function`.

\echo 'Running migration 035: sweed_package_cost_as_of — earliest-snapshot fallback...'

create or replace function sweed_package_cost_as_of(
  p_dealer bigint,
  p_inventory_item_id text,
  p_ts timestamptz
)
returns numeric language sql stable as $$
  select wholesale_cost_dollars
  from sweed_package_snapshots
  where dealer_id = p_dealer
    and inventory_item_id = p_inventory_item_id
    and observed_at_min <= p_ts
  order by observed_at_min desc
  limit 1
$$;

-- The earliest-snapshot fallback variant. Returns the
-- wholesale cost from the earliest known snapshot if no
-- snapshot exists with observed_at_min <= p_ts. Used for
-- COGS / margin metrics where we'd rather show an
-- approximation than leave the chart at zero.
create or replace function sweed_package_cost_as_of_or_earliest(
  p_dealer bigint,
  p_inventory_item_id text,
  p_ts timestamptz
)
returns numeric language sql stable as $$
  select coalesce(
    (select wholesale_cost_dollars
       from sweed_package_snapshots
      where dealer_id = p_dealer
        and inventory_item_id = p_inventory_item_id
        and observed_at_min <= p_ts
      order by observed_at_min desc
      limit 1),
    (select wholesale_cost_dollars
       from sweed_package_snapshots
      where dealer_id = p_dealer
        and inventory_item_id = p_inventory_item_id
      order by observed_at_min asc
      limit 1)
  )
$$;

\echo 'Migration 035 complete.'
