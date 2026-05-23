-- Per-ad attempt history for the Google Ads automation pipeline.
--
-- Each row records ONE L2-proposed action against ONE ad on ONE
-- morning run, plus (eventually) the outcome we observed in a
-- subsequent snapshot. This is the missing feedback loop the Ads
-- automation was running without: every morning's L2 prompt was a
-- fresh hallucination from aggregate statistics with no memory of
-- which fixes were already tried, which worked, and which need to
-- be abandoned. With this table populated, today's prompt can be
-- conditioned on "what we already learned about this exact ad" so
-- the system can hill-climb instead of grinding the same failed
-- mutation into the same disapproved creative for weeks.
--
-- Schema goals:
--   1. Insert one row per proposed `ad_actions[]` entry produced by
--      L2, plus one row per trial control/variant (action_type =
--      'trial_control' / 'trial_variant'). Insert happens after the
--      morning bundle is built and the L2 JSON is on disk; failing
--      to insert MUST NOT block the bundle from shipping (we log
--      and continue — the prior CSVs already work).
--
--   2. After each snapshot ingest the worker walks
--      `outcome_observed_at is null AND ad_id present in new
--      snapshot AND created_at >= now() - 21 days` and fills in
--      outcome columns from the new ad state.
--
--   3. The L2 prompt-prep step queries this table on the way in to
--      produce `policy_experiences` text: per-ad histories,
--      ordered newest-first, with each row's before/after policy
--      states + the proposed change in compact form so the LLM can
--      see what was tried and what stuck.
--
--   4. A watchdog rolled up from this table marks an ad as
--      "do not retry — N consecutive failed re-enable attempts"
--      so the LLM stops proposing yet another variant on the same
--      creative.
--
-- Idempotent (create … if not exists + add column if not exists).

create table if not exists gads_ad_attempts (
  id                     bigserial primary key,
  created_at             timestamptz not null default now(),

  -- Identity of the proposing run and the targeted ad.
  run_id                 text not null,           -- L2 run id, e.g. run-2026-05-23-049a2160
  ad_id                  text not null,           -- numeric Google Ads Ad ID from the snapshot
  account_id             text,
  campaign_name          text,
  ad_group_name          text,
  family_key             jsonb not null default '{}'::jsonb,

  -- What we proposed.
  --   action_type ∈ {repair, replace, pause, monitor,
  --                  trial_control, trial_variant}
  action_type            text not null,
  rationale              text,

  -- Snapshot of the ad just before the proposal (so the LLM can
  -- always compare proposed-vs-original even if the ad later
  -- evolved).
  before_serving_status  text,
  before_policy_status   text,
  before_headlines       jsonb,                   -- string[]
  before_descriptions    jsonb,                   -- string[]
  before_final_url       text,

  -- The proposed change.
  proposed_headlines     jsonb,                   -- string[] (null for pause)
  proposed_descriptions  jsonb,                   -- string[] (null for pause)
  proposed_final_url     text,
  proposed_changes_json  jsonb,                   -- full action.changes blob, for audit

  -- Outcome (filled by the post-ingest evaluator on the NEXT
  -- snapshot that contains this ad_id).
  outcome_observed_at    timestamptz,
  outcome_serving_status text,                    -- post-attempt status
  outcome_policy_status  text,
  -- outcome ∈ {success, partial, no_change, worse, superseded,
  --             ad_disappeared, unobserved}
  --   success         not_eligible|eligible_limited|under_review → eligible
  --   partial         not_eligible → eligible_limited (still bad, but moved)
  --   no_change       status unchanged
  --   worse           eligible_limited → not_eligible, or eligible → either bad state
  --   superseded      a newer attempt against the same ad_id was inserted before
  --                   this one's outcome could be observed
  --   ad_disappeared  ad_id no longer present in the snapshot (operator deleted)
  --   unobserved      placeholder while still pending
  outcome                text,
  outcome_notes          text
);

-- Hot path 1: "give me the recent attempt history for this ad_id"
create index if not exists gads_ad_attempts_ad_id_idx
  on gads_ad_attempts (ad_id, created_at desc);

-- Hot path 2: "give me the open attempts that need outcome evaluation"
create index if not exists gads_ad_attempts_open_idx
  on gads_ad_attempts (ad_id, created_at)
  where outcome_observed_at is null;

-- Hot path 3: "show me everything that came out of one morning run"
create index if not exists gads_ad_attempts_run_idx
  on gads_ad_attempts (run_id);

comment on table  gads_ad_attempts is 'Per-ad L2 attempt history for the Google Ads automation feedback loop.';
comment on column gads_ad_attempts.action_type is 'repair|replace|pause|monitor|trial_control|trial_variant';
comment on column gads_ad_attempts.outcome     is 'success|partial|no_change|worse|superseded|ad_disappeared|unobserved';
