-- 079_geo_segment_rules.sql
--
-- Geographic (scan-location-based) marketing-segment assignment rules
-- + their per-customer application ledger. Phase 2 of the Bronx geo-
-- segment work (phase 1 = the one-shot backfill CLI + verified
-- store.marketing.segment.result.add RPC, already landed).
--
-- A rule says: "customers whose GEOCODED ID home address is within
-- `radius_feet` of (center_lat, center_lng), who satisfy `trigger`
-- on/after `since`, get added to Sweed `segment_id` under `dealer_id`."
--
-- The live engine (config.workers.geo_segment_rule_eval) evaluates the
-- `first_scan` trigger on-scan: it is enqueued when a scan both links
-- to a Sweed customer AND its home address geocodes, then applies any
-- matching enabled rule. The `first_purchase` trigger is supported by
-- the schema (and by the one-shot backfill) but is NOT yet evaluated
-- live — purchase events are not scans; a follow-on slice can hook the
-- orders-ingest path. See helios/src/worker/jobs/geoSegmentRuleEvalJob.ts.
--
-- DB COST BUDGET (canon §3 — high-risk recurring background workload):
--   * Trigger model is ENQUEUE-DRIVEN, not polling. One eval job is
--     enqueued per scan when it links (link worker) and again when its
--     address geocodes (visitor-scan enrich worker), deduped per scan.
--     At ~hundreds of scans/day that is a few hundred job_queue rows/day
--     — negligible WAL/vacuum load, no always-on poller.
--   * Each eval = 1 indexed scan/link/address load + 1 tiny rules load
--     (`geo_segment_rules` is single-/double-digit rows, partial-indexed)
--     + 1 indexed first-scan EXISTS per matching rule. Sweed RPCs
--     (segment.list + result.add) fire ONLY on a real match, gated by
--     the application ledger so a customer is added at most once per rule.
--   * Write-on-change: the ledger row is claimed once (INSERT ON
--     CONFLICT DO NOTHING) and updated only on real status transitions
--     (pending -> applied/already_member/failed). No per-eval "touch".
--
-- Idempotent: every create uses `if not exists`; the seed is guarded.

\echo 'Running migration 079: geo_segment_rules...'

create table if not exists geo_segment_rules (
  id                bigserial primary key,
  -- visitor_scans.site_slug of the qualifying scan ('bx' | 'mh' | …).
  site_slug         text   not null,
  -- Sweed dealer that OWNS the target segment (RPC context).
  dealer_id         bigint not null,
  -- Target static Sweed marketing segment id.
  segment_id        bigint not null,
  -- Geofence centre + radius. Distance is equirectangular, matching
  -- helios/src/worker/sweed/geoSegment.ts#approxMeters.
  center_lat        double precision not null,
  center_lng        double precision not null,
  radius_feet       double precision not null,
  -- Which qualifying event this rule fires on.
  trigger           text   not null,
  -- For first_scan: "first scan in >= N days" reactivation window.
  reactivation_days integer not null default 365,
  -- Optional inclusive lower bound on the qualifying event instant.
  since             timestamptz,
  enabled           boolean not null default true,
  note              text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  constraint geo_segment_rules_trigger_chk
    check (trigger in ('first_scan', 'first_purchase')),
  constraint geo_segment_rules_radius_chk      check (radius_feet > 0),
  constraint geo_segment_rules_lat_chk         check (center_lat between -90 and 90),
  constraint geo_segment_rules_lng_chk         check (center_lng between -180 and 180),
  constraint geo_segment_rules_reactivation_chk check (reactivation_days > 0)
);

-- Lookup index for the eval job: active rules for a site + trigger.
create index if not exists geo_segment_rules_active_idx
  on geo_segment_rules (site_slug, trigger)
  where enabled;

-- At most one ENABLED rule per (site, trigger, segment) so an operator
-- can't accidentally double-register the same live assignment.
create unique index if not exists geo_segment_rules_one_enabled_idx
  on geo_segment_rules (site_slug, trigger, segment_id)
  where enabled;

-- Per-(rule, customer) application ledger. Doubles as the idempotency
-- key (a customer is applied to a rule's segment at most once) and the
-- recoverable status record so a transient Sweed failure does NOT
-- permanently suppress a future retry.
create table if not exists geo_segment_rule_applications (
  rule_id            bigint not null references geo_segment_rules(id) on delete cascade,
  sweed_customer_id  bigint not null,
  -- The scan that first matched the rule for this customer (provenance).
  scan_id            bigint,
  -- 'pending'        : claimed, Sweed write not yet confirmed
  -- 'applied'        : result.add succeeded
  -- 'already_member' : customer was already in the segment (no-op add)
  -- 'failed'         : last apply attempt errored (last_error set); retryable
  status             text   not null default 'pending',
  last_error         text,
  applied_at         timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  primary key (rule_id, sweed_customer_id),
  constraint geo_segment_rule_applications_status_chk
    check (status in ('pending', 'applied', 'already_member', 'failed')),
  -- A resolved (applied/already_member) row must record when it landed.
  constraint geo_segment_rule_applications_applied_at_chk
    check (status not in ('applied', 'already_member') or applied_at is not null),
  -- A failed row must record why (so the operator can see the cause).
  constraint geo_segment_rule_applications_failed_err_chk
    check (status <> 'failed' or last_error is not null)
);

-- Seed the Bronx first-scan rule so the live engine continues the
-- one-shot backfill going forward. Store centre = SITE_PINS['bx']
-- (helios/src/server/db/queries/customersMapQueries.ts). 3750 ft,
-- on/after 2026-05-21 ET. Guarded so re-running the migration is a
-- no-op.
insert into geo_segment_rules
  (site_slug, dealer_id, segment_id, center_lat, center_lng, radius_feet,
   trigger, reactivation_days, since, enabled, note)
select
  'bx', 210249, 10282, 40.855074, -73.888066, 3750,
  'first_scan', 365, timestamptz '2026-05-21 00:00:00-04:00', true,
  'Bronx hyperlocal automation: adds qualifying first-scan customers whose geocoded ID home address is within 3,750 ft of the Bronx store to Sweed segment 10282. Starts 2026-05-21; ignores customers scanned within the prior 365 days.'
where not exists (
  select 1 from geo_segment_rules
  where site_slug = 'bx' and trigger = 'first_scan' and segment_id = 10282
);

\echo 'Migration 079 complete.'
