-- sweed_shifts + sweed_shifts_ingest_highwater
--
-- Helios-owned mirror of historical Sweed cashier / employee shifts,
-- pulled from `store.sale.shift.list` every ~15 minutes per dealer
-- and backfilled day-by-day from each dealer's store-opening date.
-- Backs the `cashier.transactions_per_hour` real metric (formerly a
-- stub) and any future per-cashier throughput / efficiency surface.
--
-- See FreshlyBakedNYC/automation#27 (the shifts ingest follow-on
-- under #22's umbrella; remaining blocker for the cashier-throughput
-- stub in #21's P5).
--
-- v1 design notes:
--   * Per-shift HEADER row: (dealer, shift_id) unique. We keep the
--     raw RPC envelope in `raw_json` so we can re-derive any field
--     we forgot to normalise (break minutes, tips, drawer counts,
--     etc.) without re-fetching from Sweed.
--   * `shift_close` is NULL while the shift is still open; the
--     forward-poll re-upserts on the same (dealer_id, shift_id)
--     and lands the close time + final shape via the `on conflict
--     (...) do update` branch.
--   * `is_cashier` / `is_manager` are generated from `role` so the
--     metric SQL can `where is_cashier = true` without restating
--     the role taxonomy.
--   * Operator confirmation (2026-05-26): RPC is
--     `store.sale.shift.list` with `{ fromDate, toDate, page,
--     pageSize }` — NOT `store.shift.list`.
--
-- This file ALSO adds `cashier_user_id` to `sweed_orders` so the
-- cashier-throughput metric can join orders to the shift that was
-- in progress when each invoice closed. The column is nullable
-- (pre-existing rows have no `createdById` mapped yet; a manual
-- backfill from `raw_json->>createdById` can populate it).
--
-- Idempotent: every `create` is `if not exists`, the column add
-- uses `if not exists`.

create table if not exists sweed_shifts (
  dealer_id      bigint not null,
  shift_id       text not null,
  primary key (dealer_id, shift_id),

  -- Employee denormalised onto the shift so the metric SQL does
  -- not need a separate employees table.
  employee_id    bigint not null,
  employee_name  text,

  -- Free string today because Sweed's role taxonomy is operator-
  -- editable. Known values seen in the wild: "Cashier", "Manager",
  -- "Floor Manager", "Pharmacist", "Driver". The generated
  -- `is_cashier` / `is_manager` columns below normalise the two
  -- buckets the throughput metric cares about; everything else is
  -- ignored at metric time but kept here for auditability.
  role           text not null,
  is_cashier     boolean generated always as (role = 'Cashier') stored,
  is_manager     boolean generated always as (role ilike 'manager%' or role ilike '%manager%') stored,

  -- `shift_open` is the canonical clock-in moment; null `shift_close`
  -- = currently open. `shift_minutes` collapses to whole minutes so
  -- the SQL is sum-friendly without a divide-by-60 at metric time.
  --
  -- The generated expression deliberately does NOT coalesce
  -- `shift_close` to `now()` — Postgres only allows immutable
  -- expressions in STORED generated columns, and `now()` is
  -- volatile. For open shifts this column is therefore NULL; the
  -- metric SQL coalesces to `extract(epoch from now() - shift_open)
  -- / 60` at query time on its own. Throughput aggregates over
  -- past windows look at closed shifts only, so this divergence is
  -- benign in practice.
  shift_open     timestamptz not null,
  shift_close    timestamptz,
  shift_minutes  int generated always as (
    extract(epoch from shift_close - shift_open)::int / 60
  ) stored,

  ingested_at    timestamptz not null default now(),
  raw_json       jsonb not null
);

create index if not exists sweed_shifts_dealer_open_idx
  on sweed_shifts (dealer_id, shift_open);
create index if not exists sweed_shifts_employee_open_idx
  on sweed_shifts (employee_id, shift_open);
create index if not exists sweed_shifts_dealer_cashier_open_idx
  on sweed_shifts (dealer_id, is_cashier, shift_open)
  where is_cashier;

-- Per-dealer highwater + backfill cursor.
--
-- Mirrors the `sweed_orders_ingest_highwater` shape exactly so
-- operators have one mental model to reason about across the two
-- ingest workers. `highwater_open_time` = largest `shift_open` we
-- have ever inserted for this dealer; the next forward poll asks
-- Sweed for shifts with `fromDate = highwater - overlap` so we
-- never miss rows even when the worker crashes between fetch and
-- commit. The redundant rows are no-ops via `on conflict do
-- update` (which also lets us land the eventual close time).
create table if not exists sweed_shifts_ingest_highwater (
  dealer_id                bigint primary key,
  highwater_open_time      timestamptz not null,
  min_open_time            timestamptz not null,
  backfill_cursor_day      date,
  last_polled_at           timestamptz not null default now(),
  last_seen_count          int not null default 0,
  last_inserted_count      int not null default 0,
  consecutive_empty_polls  int not null default 0,
  notes                    text
);

-- `cashier_user_id`: which Sweed user (the `createdById` field on
-- the invoice envelope) rang up each invoice. Needed so the
-- transactions-per-cashier-hour metric can join orders to the
-- shift that was in progress when each invoice closed.
--
-- Nullable: pre-existing rows have it unset until a separate
-- backfill walks `raw_json` and populates the column. The ingest
-- worker fills it for every new row.
alter table sweed_orders
  add column if not exists cashier_user_id bigint;

create index if not exists sweed_orders_cashier_pay_time_idx
  on sweed_orders (cashier_user_id, pay_time)
  where cashier_user_id is not null;
