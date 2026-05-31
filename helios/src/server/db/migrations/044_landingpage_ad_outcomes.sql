-- Migration 044: landingpage_ad_outcomes
--
-- Stores Google Ads -> landing-page observations for consumption by
-- mostly-static-sites landing-page evolution jobs. The table is deliberately
-- source-granular: the current Ads Editor exports often do not contain
-- ad/final-URL-level performance metrics, so observations must carry their
-- evidence scope instead of pretending campaign metrics are ad metrics.

create table if not exists landingpage_ad_outcomes (
  id bigserial primary key,

  source_export_id text not null,
  source_exported_at timestamptz,
  source_file_name text,
  source_ingested_at timestamptz,

  account_id text,
  campaign_id text,
  campaign_name text,
  campaign_type text,
  ad_group_id text,
  ad_group_name text,
  ad_id text,
  ad_type text,
  ad_status text,
  policy_status text,
  policy_topics jsonb not null default '[]'::jsonb,

  final_url text not null,
  landing_page_key text not null,

  signal_type text not null,
  signal_confidence numeric(5,4) not null default 0,
  planned_action text not null default 'observe',
  outcome_status text not null default 'pending_observation',
  outcome_observed_at timestamptz,

  performance_scope text not null default 'none',
  performance_context jsonb not null default '{}'::jsonb,
  evidence jsonb not null default '{}'::jsonb,
  before_creative jsonb,
  after_creative jsonb,
  notes text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint landingpage_ad_outcomes_signal_type_check
    check (signal_type in (
      'policy_suspect_landing_page',
      'creative_repair_candidate',
      'landing_page_underperformance',
      'data_limitation'
    )),

  constraint landingpage_ad_outcomes_performance_scope_check
    check (performance_scope in ('none', 'campaign', 'pmax_campaign', 'ad', 'landing_page')),

  constraint landingpage_ad_outcomes_planned_action_check
    check (planned_action in (
      'observe',
      'edit_disapproved_in_place',
      'evolve_landing_page',
      'skipped_approved',
      'skipped_approved_limited',
      'skipped_non_rsa',
      'failed_validation'
    )),

  constraint landingpage_ad_outcomes_confidence_check
    check (signal_confidence >= 0 and signal_confidence <= 1)
);

create unique index if not exists landingpage_ad_outcomes_export_signal_idx
  on landingpage_ad_outcomes (
    source_export_id,
    signal_type,
    coalesce(ad_id, ''),
    landing_page_key,
    coalesce(ad_group_name, '')
  );

create index if not exists landingpage_ad_outcomes_landing_page_idx
  on landingpage_ad_outcomes (landing_page_key);

create index if not exists landingpage_ad_outcomes_policy_idx
  on landingpage_ad_outcomes (policy_status);

create index if not exists landingpage_ad_outcomes_campaign_idx
  on landingpage_ad_outcomes (campaign_name, ad_group_name);

create index if not exists landingpage_ad_outcomes_signal_idx
  on landingpage_ad_outcomes (signal_type, outcome_status, created_at desc);
