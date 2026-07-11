-- Immutable per-package physical-count observations for the low-inventory
-- floor-review workflow. A row records exactly what one editor counted and
-- the Sweed mirror values Helios compared it with at capture time. Capturing a
-- row never writes Sweed, moves inventory, or sends a notification.

create table if not exists low_inventory_physical_counts (
  id                        uuid primary key default gen_random_uuid(),
  request_id                uuid not null unique,
  dealer_id                 bigint not null,
  inventory_item_id         text not null,
  product_id                bigint not null,
  product_sku               text,
  product_name              text,
  physical_qty              numeric(12, 3) not null,
  classification            text not null,
  resolution_status         text not null,

  actor_user_id             bigint not null references users(id),
  actor_email               text not null,
  actor_name                text not null,
  captured_at               timestamptz not null default now(),

  sweed_current_qty         numeric(12, 3) not null,
  sweed_hold_qty            numeric(12, 3),
  sweed_available_qty       numeric(12, 3),
  sweed_stock_location      text not null,
  sweed_internal_track_code text,
  sweed_metrc_tag           text,
  sweed_observed_at         timestamptz not null,

  constraint low_inventory_physical_counts_physical_qty_ok
    check (physical_qty >= 0 and physical_qty <= 1000000),
  constraint low_inventory_physical_counts_classification_ok
    check (classification in ('equal', 'short', 'zero', 'zero-held', 'over')),
  constraint low_inventory_physical_counts_resolution_status_ok
    check (resolution_status in ('not-needed', 'pending')),
  constraint low_inventory_physical_counts_resolution_matches_classification
    check (
      (classification = 'equal' and resolution_status = 'not-needed')
      or (classification <> 'equal' and resolution_status = 'pending')
    ),
  constraint low_inventory_physical_counts_classification_matches_snapshot
    check (
      (classification = 'equal' and physical_qty = sweed_current_qty)
      or (
        classification = 'zero-held'
        and physical_qty = 0
        and physical_qty <> sweed_current_qty
        and coalesce(sweed_hold_qty, 0) > 0
      )
      or (
        classification = 'zero'
        and physical_qty = 0
        and physical_qty <> sweed_current_qty
        and coalesce(sweed_hold_qty, 0) <= 0
      )
      or (classification = 'short' and physical_qty > 0 and physical_qty < sweed_current_qty)
      or (classification = 'over' and physical_qty > sweed_current_qty)
    )
);

create index if not exists low_inventory_physical_counts_package_history_idx
  on low_inventory_physical_counts (dealer_id, inventory_item_id, captured_at desc);

create index if not exists low_inventory_physical_counts_pending_idx
  on low_inventory_physical_counts (dealer_id, captured_at desc)
  where resolution_status = 'pending';
