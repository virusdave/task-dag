create table scheduling_runs (
  id bigserial primary key,
  requested_by_user_id bigint null references users(id),
  current_job_id bigint null references job_queue(id),
  title text not null,
  source_text text not null,
  status text not null check (status in ('queued', 'extracting', 'needs_review', 'generating', 'ready', 'failed')),
  extraction_model text null,
  extraction_prompt_version text null,
  extracted_constraints_json jsonb null,
  normalized_input_json jsonb null,
  validation_issues_json jsonb not null default '[]'::jsonb,
  latest_error text null,
  approved_at timestamptz null,
  approved_by_user_id bigint null references users(id),
  selected_candidate_id bigint null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index scheduling_runs_created_idx
  on scheduling_runs (created_at desc);

create index scheduling_runs_status_created_idx
  on scheduling_runs (status, created_at desc);

create index scheduling_runs_requested_by_created_idx
  on scheduling_runs (requested_by_user_id, created_at desc);

create trigger scheduling_runs_set_updated_at
before update on scheduling_runs
for each row execute function set_updated_at();

create table scheduling_candidates (
  id bigserial primary key,
  scheduling_run_id bigint not null references scheduling_runs(id) on delete cascade,
  rank integer not null,
  candidate_code text not null,
  label text not null,
  summary text not null,
  metrics_json jsonb not null,
  schedule_json jsonb not null,
  created_at timestamptz not null default now(),
  unique (scheduling_run_id, rank),
  unique (scheduling_run_id, candidate_code)
);

create index scheduling_candidates_run_rank_idx
  on scheduling_candidates (scheduling_run_id, rank);

alter table scheduling_runs
  add constraint scheduling_runs_selected_candidate_fkey
  foreign key (selected_candidate_id)
  references scheduling_candidates(id)
  on delete set null;
