-- Parsekit Reverse-Shadow Event Log
--
-- One row per "interesting" parsekit-vs-legacy disagreement observed
-- by the reverse-shadow harness in
-- `helios/src/worker/jobs/generatePendingPurchasePacketJob.ts`.
--
-- We deliberately do **not** persist the high-volume happy paths
-- (`ok_match`, `ok_no_detect`); the table only records the cases an
-- operator needs to look at:
--
--   regression_unmatched  parsekit dispatched but failed to parse;
--                         legacy succeeded. Hard regression.
--   regression_diff       parsekit parsed but its output differs
--                         from the legacy waterfall. Soft regression
--                         (parsekit's output is still used in prod
--                         because it ran first).
--   legacy_threw          parsekit accepted what the legacy parser
--                         rejected. Probably a parsekit improvement
--                         to verify.
--
-- The table is append-only and read by the Helios UI under
-- `Config -> Parsing -> Purchases` to show recent regressions and
-- top-line counters.

create table if not exists parsekit_reverse_shadow_events (
  id                       bigserial primary key,
  created_at               timestamptz not null default now(),

  -- one of the 'regression_unmatched' | 'regression_diff' | 'legacy_threw' kinds.
  kind                     text not null,

  -- The raw distributor product name fed to the parser.
  input                    text not null,

  -- Which parsekit parser dispatched (may be null when none matched,
  -- but in that case we don't even record a row — fall-through is
  -- silent, see code).
  parser_id                text,
  rule_id                  text,
  snapshot_sha             text,

  -- Set when kind = 'regression_diff'.
  diff_fields              jsonb,

  -- Set when parsekit produced output (kinds: regression_diff, legacy_threw).
  parsekit_output          jsonb,

  -- Set when legacy produced output (kinds: regression_diff, regression_unmatched).
  legacy_output            jsonb,

  -- Set when kind = 'regression_unmatched'.
  parsekit_failure_reason  text,

  -- Set when kind = 'legacy_threw'.
  legacy_error             text
);

create index if not exists ix_parsekit_reverse_shadow_events_created_at
  on parsekit_reverse_shadow_events (created_at desc);

create index if not exists ix_parsekit_reverse_shadow_events_kind_created_at
  on parsekit_reverse_shadow_events (kind, created_at desc);

create index if not exists ix_parsekit_reverse_shadow_events_parser_id
  on parsekit_reverse_shadow_events (parser_id, created_at desc);
