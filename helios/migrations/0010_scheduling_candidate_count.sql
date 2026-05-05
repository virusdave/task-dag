alter table scheduling_runs
  add column requested_candidate_count integer not null default 5;

alter table scheduling_runs
  add constraint scheduling_runs_requested_candidate_count_check
  check (requested_candidate_count between 1 and 12);
