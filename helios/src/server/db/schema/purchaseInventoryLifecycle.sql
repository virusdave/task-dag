-- Purchase inventory pricing-safety lifecycle (L1) — current-state schema
-- reference. The applied artifact is migration
-- src/server/db/migrations/095_purchase_inventory_lifecycle.sql; this
-- file mirrors the fresh-install desired state of the two lifecycle
-- tables (the enqueue_reason constraint widening lives on the existing
-- pending_litalerts_refresh_queue table, see marketDataSweep.sql).
--
-- See migration 095's header (and the top-level design referenced there)
-- for the full state machine, gate semantics, and the "no release route
-- yet" L1 boundary.

create table if not exists purchase_inventory_lifecycle_runs (
  id bigserial primary key,

  dealer_id bigint not null,
  po_id text not null,
  site_key text not null,

  path text not null,                  -- 'quarantine' | 'reprice_in_place'

  state text not null default 'not_started',
  blocked_reason text,

  market_requested_at timestamptz,     -- market-ready gate cutoff
  pricing_batch_id bigint,             -- proposal_batches.id we created
  expected_product_ids bigint[] not null default '{}',

  version integer not null default 1,  -- optimistic-concurrency guard

  created_by_user_id bigint,
  notes text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (dealer_id, po_id),
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

  quarantine_verified_at timestamptz,
  quarantine_stock_location text,
  quarantine_current_qty numeric(12, 3),

  market_observation_id bigint,
  market_observation_captured_at timestamptz,
  market_ready_at timestamptz,

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
