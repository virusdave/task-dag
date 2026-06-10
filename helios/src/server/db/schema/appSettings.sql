-- app_settings
--
-- Tiny key/value store for GLOBAL (not per-user) application settings
-- that admins edit through the UI and every user then reads. The value
-- is an opaque JSONB blob whose shape is owned by the feature that uses
-- the key — `app_settings` itself imposes no schema on it.
--
-- First consumer: key `metrics_view_defaults` — the page-wide default
-- toolbar configuration for the /metrics pages (per-tab aggregation /
-- stack-mode / y-axis baseline, plus the scatter colour/size/opacity
-- encodings). See `helios/src/shared/contracts/api/metricsDefaults.ts`
-- for that blob's contract and `routes/metricsDefaults.ts` for the API.
--
-- Single row per key (last-write-wins). `updated_by` / `updated_at`
-- give a minimal audit trail so an operator can see who last changed a
-- global default and when.
--
-- Idempotent: every `create` is `if not exists`.

create table if not exists app_settings (
  key        text primary key,
  value      jsonb not null,
  updated_by text not null,
  updated_at timestamptz not null default now()
);
