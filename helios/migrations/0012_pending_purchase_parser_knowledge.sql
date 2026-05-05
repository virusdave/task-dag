create table pending_purchase_brand_profiles (
  id bigserial primary key,
  source_system text not null,
  normalized_brand_key text not null,
  display_brand_name text not null,
  taxonomy_hints_json jsonb not null default '{}'::jsonb,
  metadata_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (source_system, normalized_brand_key)
);

create index pending_purchase_brand_profiles_source_display_idx
  on pending_purchase_brand_profiles (source_system, display_brand_name);

create trigger pending_purchase_brand_profiles_set_updated_at
before update on pending_purchase_brand_profiles
for each row execute function set_updated_at();

create table pending_purchase_brand_aliases (
  id bigserial primary key,
  brand_profile_id bigint not null references pending_purchase_brand_profiles(id),
  alias_type text not null check (alias_type in ('exact', 'prefix')),
  alias_value text not null,
  normalized_alias_value text not null,
  status text not null check (status in ('draft', 'provisional', 'active', 'rejected', 'retired')),
  confidence numeric(6, 5) null,
  provenance text null,
  metadata_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (brand_profile_id, alias_type, normalized_alias_value)
);

create index pending_purchase_brand_aliases_lookup_idx
  on pending_purchase_brand_aliases (normalized_alias_value, alias_type, status, brand_profile_id);

create trigger pending_purchase_brand_aliases_set_updated_at
before update on pending_purchase_brand_aliases
for each row execute function set_updated_at();

create table pending_purchase_parse_rules (
  id bigserial primary key,
  brand_profile_id bigint not null references pending_purchase_brand_profiles(id),
  rule_kind text not null check (rule_kind in ('exact_name', 'prefix', 'regex', 'template')),
  state text not null check (state in ('draft', 'provisional', 'active', 'rejected', 'retired')),
  source text not null,
  provenance text null,
  confidence numeric(6, 5) null,
  normalized_match_value text null,
  match_payload_json jsonb not null default '{}'::jsonb,
  parsed_output_json jsonb not null,
  validation_json jsonb not null default '{}'::jsonb,
  risk_flags_json jsonb not null default '[]'::jsonb,
  rule_fingerprint text not null unique,
  hit_count integer not null default 0,
  success_count integer not null default 0,
  failure_count integer not null default 0,
  last_matched_at timestamptz null,
  last_feedback_at timestamptz null,
  last_state_changed_at timestamptz null,
  metadata_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index pending_purchase_parse_rules_runtime_idx
  on pending_purchase_parse_rules (brand_profile_id, state, rule_kind, normalized_match_value);

create index pending_purchase_parse_rules_exact_lookup_idx
  on pending_purchase_parse_rules (normalized_match_value, state, rule_kind);

create trigger pending_purchase_parse_rules_set_updated_at
before update on pending_purchase_parse_rules
for each row execute function set_updated_at();

create table pending_purchase_parse_observations (
  id bigserial primary key,
  source_system text not null,
  packet_id bigint null references pending_purchase_packets(id),
  pending_purchase_row_id bigint null references pending_purchase_rows(id),
  brand_profile_id bigint null references pending_purchase_brand_profiles(id),
  parse_rule_id bigint null references pending_purchase_parse_rules(id),
  created_by_user_id bigint null references users(id),
  observation_type text not null check (
    observation_type in (
      'generation_parse',
      'llm_inference',
      'reviewer_edit',
      'reviewer_approval',
      'apply_outcome',
      'rule_state_change'
    )
  ),
  observation_status text not null check (
    observation_status in ('captured', 'accepted', 'rejected', 'succeeded', 'failed', 'blocked', 'informational')
  ),
  row_input_signature text null,
  raw_distributor_product_name text null,
  normalized_distributor_product_name text null,
  raw_row_json jsonb not null default '{}'::jsonb,
  inference_json jsonb not null default '{}'::jsonb,
  notes text null,
  created_at timestamptz not null default now()
);

create index pending_purchase_parse_observations_row_idx
  on pending_purchase_parse_observations (pending_purchase_row_id, created_at desc);

create index pending_purchase_parse_observations_signature_idx
  on pending_purchase_parse_observations (row_input_signature, created_at desc);

create index pending_purchase_parse_observations_rule_idx
  on pending_purchase_parse_observations (parse_rule_id, created_at desc);

create index pending_purchase_parse_observations_brand_idx
  on pending_purchase_parse_observations (brand_profile_id, created_at desc);
