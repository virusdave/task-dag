-- sweed_drawer_shifts + sweed_drawer_shift_sessions
--   + sweed_drawer_shifts_ingest_highwater
--
-- Helios-owned mirror of Sweed's `store.sale.shift.list` envelopes.
--
-- IMPORTANT — schema reflects the *actual* Sweed envelope, NOT the
-- initial guess in the issue's "Schema" sketch. We discovered on the
-- first prod ingest (migration 036, 2026-05-26) that the RPC returns
-- DRAWER / till shifts (per hardware terminal), not per-employee
-- shifts: each drawer-shift carries `openDate` / `closeDate`, a
-- `closeUser` / `confirmUser` block, and a nested `sessions[]` array
-- with one row per cashier user that worked that drawer between
-- open and close. Per-cashier open / close times are NOT exposed.
--
-- For "transactions per cashier-hour" (the metric this table backs,
-- per FreshlyBakedNYC/automation#27) the operator-confirmed
-- approximation is therefore:
--
--   cashier-hours in bucket
--     = sum over drawer-shifts that fall in the bucket of
--         (drawer duration in hours) * (count(sessions[].user.id))
--
-- i.e. every user that touched the drawer is treated as on-the-clock
-- for the full drawer window. This over-estimates hours slightly for
-- mid-shift handoffs but is the right approximation for the
-- "throughput as the business scales" question the metric exists to
-- answer.
--
-- Side-channel note: `sweed_orders.cashier_user_id` (added in
-- migration 036 from the invoice envelope's `createdById`) is
-- intentionally retained — a future-v2 metric can use it to do a
-- per-cashier exact-time join. Today's metric does NOT use it.
--
-- Idempotent: every `create` is `if not exists`.

create table if not exists sweed_drawer_shifts (
  dealer_id          bigint not null,
  sweed_shift_id     text   not null,
  primary key (dealer_id, sweed_shift_id),

  shift_no           int,
  hardware_id        bigint,
  hardware_name      text,

  -- Sweed exposes UTC instants on the drawer envelope. `close_date`
  -- is NULL while the drawer is still open; the forward poll
  -- re-upserts the row to land the close time and final shape.
  open_date          timestamptz not null,
  close_date         timestamptz,

  -- Only materialised when the drawer has closed (Postgres rejects
  -- volatile expressions like `now()` in STORED generated columns,
  -- so we cannot fall back to `coalesce(close_date, now())` here).
  -- For open drawers this is NULL and the metric SQL must compute
  -- `extract(epoch from now() - open_date) / 60` itself if it wants
  -- an instantaneous estimate. Steady-state metrics over closed
  -- windows look at closed drawers only, so this divergence is
  -- benign.
  drawer_minutes     int generated always as (
    extract(epoch from close_date - open_date)::int / 60
  ) stored,

  sales_count        int,

  close_user_id      bigint,
  close_user_name    text,

  ingested_at        timestamptz not null default now(),
  raw_json           jsonb not null
);

create index if not exists sweed_drawer_shifts_dealer_open_idx
  on sweed_drawer_shifts (dealer_id, open_date);
create index if not exists sweed_drawer_shifts_dealer_close_idx
  on sweed_drawer_shifts (dealer_id, close_date)
  where close_date is not null;

-- Per-cashier session rows nested under each drawer-shift.
-- Keyed on (dealer_id, sweed_shift_id, session_id) so the
-- relationship to the parent drawer is explicit and the upsert is
-- safe even if Sweed ever recycles a session id across drawers.
create table if not exists sweed_drawer_shift_sessions (
  dealer_id              bigint not null,
  sweed_shift_id         text   not null,
  session_id             text   not null,
  primary key (dealer_id, sweed_shift_id, session_id),

  user_id                bigint not null,
  user_name              text,
  expected_session_cash  numeric(12, 2),

  ingested_at            timestamptz not null default now(),
  raw_json               jsonb not null
);

create index if not exists sweed_drawer_shift_sessions_dealer_user_idx
  on sweed_drawer_shift_sessions (dealer_id, user_id);
create index if not exists sweed_drawer_shift_sessions_shift_idx
  on sweed_drawer_shift_sessions (dealer_id, sweed_shift_id);

-- Per-dealer highwater + backfill cursor. Same shape as the orders
-- highwater so operators have one mental model. Renamed
-- `highwater_open_date` (vs the v1 `highwater_open_time`) to match
-- the new drawer-shifts column naming.
create table if not exists sweed_drawer_shifts_ingest_highwater (
  dealer_id                bigint primary key,
  highwater_open_date      timestamptz not null,
  min_open_date            timestamptz not null,
  backfill_cursor_day      date,
  last_polled_at           timestamptz not null default now(),
  last_seen_count          int not null default 0,
  last_inserted_count      int not null default 0,
  consecutive_empty_polls  int not null default 0,
  notes                    text
);
