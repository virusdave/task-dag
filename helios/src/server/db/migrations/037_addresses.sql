-- 037_addresses.sql
--
-- Reusable address + geocoding persistence layer for the Sweed
-- per-invoice + per-customer enrichment epic
-- (FreshlyBakedNYC/automation#25 / tasks/epic/sweed-address-enrichment).
--
-- This is the schema half of A1; the worker + RPC + geocoder
-- halves (A2..A6) live as separate task DAG entries on the same
-- epic and land in follow-on commits.
--
-- Why a separate `addresses` table rather than denormalised
-- columns on sweed_orders:
--
--   * Each delivery destination is a NATURAL DEDUP KEY. The same
--     household orders dozens of times; we want exactly one
--     geocode call per unique address, ever. A normalised
--     `addresses` row plus a FK from sweed_orders is the cleanest
--     way to enforce that.
--
--   * Customer-of-record addresses (pulled from
--     `store.customer.get`) want the same dedup behaviour AND
--     need a many-to-many join (one customer can have multiple
--     known addresses across time, and one address can serve
--     multiple household members). The
--     sweed_customer_addresses table below is that join.
--
--   * Geocoding is async and rate-limited (Census ≈ 1 RPS). A
--     separate row lets us defer the geocode pass without holding
--     up the per-invoice / per-customer enrichment cadence.
--
-- Privacy + retention: addresses persist indefinitely. We do NOT
-- copy phone, email, or name into this layer; the only PII it
-- holds is the postal address itself. The address row is keyed
-- by a normalised one-line representation (lower-cased,
-- whitespace-collapsed) so that "123 Main St., Apt 4B,
-- Brooklyn, NY 11211" and "123 main st apt 4b brooklyn ny 11211"
-- collapse to one row.
--
-- Idempotent: every `create` is `if not exists`; column adds
-- use `add column if not exists`.

create table if not exists addresses (
  id                bigserial primary key,

  -- Raw inputs as Sweed handed them back. Kept verbatim so we can
  -- (a) re-derive normalisation if the rule changes, and (b) audit
  -- a row's provenance. `raw_*` may be null when Sweed returned an
  -- empty subfield.
  raw_line1         text,
  raw_line2         text,
  raw_city          text,
  raw_state         text,
  raw_zip           text,

  -- The dedup key. Computed by the worker upsert helper:
  --   lower(trim(line1)) || ' ' || lower(trim(line2)) || ' ' ||
  --   lower(trim(city))  || ' ' || lower(trim(state)) || ' ' ||
  --   trim(zip)
  -- with leading/trailing whitespace stripped, internal whitespace
  -- runs collapsed to a single space, and empty-string segments
  -- omitted. The DB-side unique constraint here is what enforces
  -- the dedup; callers must use INSERT ... ON CONFLICT (normalized)
  -- DO UPDATE SET updated_at = now() RETURNING id.
  normalized        text not null,

  -- Census Geocoder output. NULL until the geocode pass runs (or
  -- when geocode_status ends up 'failed' / 'not_us').
  latitude          double precision,
  longitude         double precision,

  -- Hierarchy components, populated alongside lat/lng on a
  -- successful Census geocode. Used by the customer-origin-map
  -- metric to roll up at zip → city → county → state granularity.
  zip5              text,
  city              text,
  county            text,
  state_code        text,

  -- Lifecycle of the geocode attempt for this row:
  --   'pending' — newly inserted, no geocode call has happened yet
  --   'ok'      — geocode returned a usable lat/lng
  --   'failed'  — geocode call ran but returned no match (typo,
  --               brand-new address, etc.); retried periodically
  --   'not_us'  — address was outside the Census Geocoder's
  --               coverage area (international); will not be
  --               retried, treated as 'other' in map aggregations
  geocode_status    text not null default 'pending',
  geocoder_source   text,
  last_geocoded_at  timestamptz,

  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  unique (normalized)
);

-- Geocode-sweep worker picks up rows in either of the retry-eligible
-- states; an "ok" or "not_us" row drops off the index entirely so the
-- index stays small even as the table grows.
create index if not exists addresses_geocode_status_idx
  on addresses (geocode_status)
  where geocode_status in ('pending', 'failed');

create index if not exists addresses_zip5_idx
  on addresses (zip5) where zip5 is not null;
create index if not exists addresses_state_zip5_idx
  on addresses (state_code, zip5) where state_code is not null;

comment on table addresses is
  'Normalised, geocoded postal addresses. One row per unique normalised address, shared between delivery destinations (sweed_orders.delivery_address_id) and customer-of-record addresses (sweed_customer_addresses). See FreshlyBakedNYC/automation#25.';

-- ----------------------------------------------------------------
-- sweed_customer_addresses — many-to-many between
-- (dealer_id, customer_id) and addresses(id), tagged by `kind`.
--
-- `kind`:
--   'primary'         — pulled from store.customer.get for the
--                        customer's CRM-of-record address. At most
--                        one row per (dealer, customer) with this
--                        kind in practice; we DO NOT enforce that
--                        at the schema level so a future "this
--                        person has two confirmed homes" case
--                        won't blow up.
--   'delivery_seen'   — derived: a delivery order for this customer
--                        was sent to this address. Multiple rows
--                        per customer are normal and meaningful
--                        (work address, partner's place, etc.).
--
-- first_seen_at / last_seen_at let us "decay" stale delivery
-- destinations out of customer-origin aggregations without
-- deleting the underlying address row.
-- ----------------------------------------------------------------

create table if not exists sweed_customer_addresses (
  dealer_id      bigint not null,
  customer_id    bigint not null,
  address_id     bigint not null references addresses(id),
  kind           text   not null,
  first_seen_at  timestamptz not null default now(),
  last_seen_at   timestamptz not null default now(),
  primary key (dealer_id, customer_id, address_id, kind),
  -- Constrain to the two known kinds. Drop the constraint if we
  -- add more (e.g. 'shipping_label_seen') in a follow-on.
  constraint sweed_customer_addresses_kind_chk
    check (kind in ('primary', 'delivery_seen'))
);

create index if not exists sweed_customer_addresses_address_idx
  on sweed_customer_addresses (address_id);
create index if not exists sweed_customer_addresses_customer_idx
  on sweed_customer_addresses (dealer_id, customer_id);

comment on table sweed_customer_addresses is
  'Join: which Sweed customer is associated with which address, and how (primary CRM address vs. observed delivery destination). See FreshlyBakedNYC/automation#25.';

-- ----------------------------------------------------------------
-- sweed_orders augmentation: link each order to its delivery
-- address (if any) plus a small status enum the per-invoice
-- enrichment job uses to avoid re-polling rows that already
-- have a known terminal outcome.
-- ----------------------------------------------------------------

alter table sweed_orders
  add column if not exists delivery_address_id bigint references addresses(id);

create index if not exists sweed_orders_delivery_address_idx
  on sweed_orders (delivery_address_id) where delivery_address_id is not null;

-- `invoice_get_status`:
--   NULL          — we have not yet attempted a store.sale.invoice.get
--                   for this row.
--   'ok'          — we fetched the invoice and (if it had a delivery
--                   address) populated delivery_address_id.
--   'no_address'  — we fetched the invoice; it did not have a
--                   deliveryAddress sub-object. Do not re-poll.
--                   (Kiosk / pickup / in-store orders end up here on
--                   the rare occasion the enrichment job picks them
--                   up — it normally filters them out at the SELECT
--                   step.)
--   'failed'      — the Sweed RPC call errored; eligible for retry
--                   on the next tick.
alter table sweed_orders
  add column if not exists invoice_get_status text;
alter table sweed_orders
  add column if not exists invoice_get_polled_at timestamptz;

create index if not exists sweed_orders_enrich_candidates_idx
  on sweed_orders (pay_time desc)
  where delivery_address_id is null
    and (invoice_get_status is null or invoice_get_status = 'failed');
