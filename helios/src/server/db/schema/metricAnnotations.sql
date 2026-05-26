-- metric_annotations
--
-- Operator-authored annotations on the Helios `/metrics` page tree.
-- An annotation is a point in time (`t_end` null) or a time range
-- (`t_end` set) attached either to a specific metric
-- (`scope = 'metric:<metric_id>'`) or to every metric on the page
-- (`scope = 'global'`). The Helios SPA renders each annotation as a
-- small event indicator on every chart whose visible window covers
-- the annotation's `[t_start, t_end]` (and on the originating chart
-- for `metric:<id>` scope).
--
-- Soft-delete: an accidental delete is recoverable from the DB; the
-- v1 UI hides soft-deleted rows. We keep the row forever so that
-- annotation IDs referenced by historical screenshots / runbooks
-- never 404.
--
-- This schema is owned by the "Business & Performance Metrics" page
-- tree epic (FreshlyBakedNYC/automation#21, satisfying
-- virusdave/top-level#7) and lives entirely in postgres — there is
-- no Sweed / Slack mirror in v1.
--
-- Idempotent: every `create` is `if not exists`.

create table if not exists metric_annotations (
  id          uuid primary key default gen_random_uuid(),
  author      text not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  t_start     timestamptz not null,
  -- null = point annotation (no duration).
  t_end       timestamptz,
  title       text not null,
  body        text not null default '',
  -- Free-form tag used for the indicator's colour. Conventional
  -- values today: 'incident', 'change', 'launch', 'experiment',
  -- 'sale', 'note'. The UI maps unknown tags to a default colour
  -- and shows the literal tag in the hover tooltip — adding a new
  -- tag therefore requires no code change.
  tag         text,
  -- 'global' | 'metric:<metric_id>'  (see scope check below).
  scope       text not null,
  -- Soft delete. Non-null = hidden by the v1 UI.
  deleted_at  timestamptz,
  -- Range sanity: when t_end is set it must be at or after t_start.
  constraint metric_annotations_range_ok
    check (t_end is null or t_end >= t_start),
  -- Scope sanity: only 'global' or 'metric:<non-empty id>'. We do
  -- not (in v1) enforce that the metric id actually exists in the
  -- in-memory `MetricRegistry` — a metric file can be renamed or
  -- removed without losing the historical annotation, and the UI
  -- simply doesn't surface annotations scoped to an unknown id.
  constraint metric_annotations_scope_ok
    check (scope = 'global' or scope like 'metric:_%')
);

create index if not exists metric_annotations_t_start_idx
  on metric_annotations (t_start);

create index if not exists metric_annotations_scope_idx
  on metric_annotations (scope);

-- Most reads filter by visible-window + scope + non-deleted, so we
-- give those three a compound index biased by scope.
create index if not exists metric_annotations_scope_t_start_idx
  on metric_annotations (scope, t_start)
  where deleted_at is null;
