-- Communications module: policy-limited Google Ads asset replacement review.
--
-- Mirrors the existing reviewer state schema persisted by
-- ads/google/serve_asset_policy_limited_replacement_review.py to
-- ads/google/policy/asset_policy_limited_replacement_review_state.json.
--
-- Hard rule preserved: this module ONLY persists reviewer decisions and
-- edited replacement text. It does NOT mutate Google Ads. Any apply phase
-- still runs through a narrow post-review Google Ads resolver pass first
-- (validate-only, then live apply, then narrow readback). Only items with
-- decision == 'accepted' flow to the resolver/apply step.

create table communications_policy_replacement_drafts (
  id bigserial primary key,
  packet_id text not null,
  state_version integer not null default 1,
  saved_at timestamptz not null default now(),
  submitted_at timestamptz null,
  items_json jsonb not null default '{}'::jsonb,
  last_saved_by_user_id bigint null references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index communications_policy_replacement_drafts_packet_unique
  on communications_policy_replacement_drafts (packet_id);

create trigger communications_policy_replacement_drafts_set_updated_at
before update on communications_policy_replacement_drafts
for each row execute function set_updated_at();

create table communications_policy_replacement_audit (
  id bigserial primary key,
  packet_id text not null,
  draft_id bigint not null references communications_policy_replacement_drafts(id),
  event_type text not null check (
    event_type in (
      'communications.policy_replacement_review.draft_saved',
      'communications.policy_replacement_review.submitted'
    )
  ),
  actor_user_id bigint null references users(id),
  request_id text null,
  payload_json jsonb not null default '{}'::jsonb,
  audit_event_id bigint null references audit_events(id),
  created_at timestamptz not null default now()
);

create index communications_policy_replacement_audit_packet_created_idx
  on communications_policy_replacement_audit (packet_id, created_at desc);
create index communications_policy_replacement_audit_draft_created_idx
  on communications_policy_replacement_audit (draft_id, created_at desc);
