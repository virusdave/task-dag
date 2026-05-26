-- addresses + sweed_customer_addresses
--
-- Reusable address + geocoding persistence layer for the Sweed
-- per-invoice + per-customer enrichment epic
-- (FreshlyBakedNYC/automation#25).
--
-- This file is the canonical documented schema. Migration 035
-- creates it; the worker code in helios/src/worker/jobs/
-- enrichDeliveryAddressJob.ts and enrichCustomerAddressJob.ts
-- (A4 + A5 of the epic) plus the geocoder helpers under
-- helios/src/worker/geocoder/ (A3) are the only writers.
--
-- Design notes:
--   * `addresses` is keyed by a normalised one-line representation
--     of the postal address (lower-cased, whitespace-collapsed) so
--     that the same household ordering twice does not produce two
--     rows. The dedup is enforced by the `unique (normalized)`
--     constraint; the worker upsert helper uses
--     INSERT ... ON CONFLICT (normalized) DO UPDATE.
--   * Geocoding is async: a fresh insert lands with
--     `geocode_status = 'pending'`. A separate sweep
--     (helios/src/worker/jobs/enrichDeliveryAddressJob.ts +
--     companion) calls the free US Census Geocoder and updates
--     the row to 'ok' / 'failed' / 'not_us'.
--   * Privacy: this layer holds postal addresses only. We do NOT
--     copy customer name, phone, or email into `addresses` or
--     `sweed_customer_addresses`; the customer-side join uses the
--     Sweed `customer_id` (a bigint we already store on
--     sweed_orders).
--
-- Idempotent: every `create` is `if not exists`.

create table if not exists addresses (
  id                bigserial primary key,

  -- Raw inputs as Sweed handed them back.
  raw_line1         text,
  raw_line2         text,
  raw_city          text,
  raw_state         text,
  raw_zip           text,

  -- Dedup key — see file comment.
  normalized        text not null,

  -- Census Geocoder output, NULL until the geocode pass runs.
  latitude          double precision,
  longitude         double precision,

  -- Hierarchy components for "zip → city → county → state" rollup
  -- in the customer-origin map metric.
  zip5              text,
  city              text,
  county            text,
  state_code        text,

  -- 'pending' | 'ok' | 'failed' | 'not_us'
  geocode_status    text not null default 'pending',
  geocoder_source   text,
  last_geocoded_at  timestamptz,

  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  unique (normalized)
);

create index if not exists addresses_geocode_status_idx
  on addresses (geocode_status)
  where geocode_status in ('pending', 'failed');
create index if not exists addresses_zip5_idx
  on addresses (zip5) where zip5 is not null;
create index if not exists addresses_state_zip5_idx
  on addresses (state_code, zip5) where state_code is not null;

create table if not exists sweed_customer_addresses (
  dealer_id      bigint not null,
  customer_id    bigint not null,
  address_id     bigint not null references addresses(id),
  -- 'primary' (from store.customer.get) or 'delivery_seen'
  -- (derived from an enriched sweed_orders row).
  kind           text   not null,
  first_seen_at  timestamptz not null default now(),
  last_seen_at   timestamptz not null default now(),
  primary key (dealer_id, customer_id, address_id, kind),
  constraint sweed_customer_addresses_kind_chk
    check (kind in ('primary', 'delivery_seen'))
);

create index if not exists sweed_customer_addresses_address_idx
  on sweed_customer_addresses (address_id);
create index if not exists sweed_customer_addresses_customer_idx
  on sweed_customer_addresses (dealer_id, customer_id);
