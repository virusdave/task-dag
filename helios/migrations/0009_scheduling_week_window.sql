alter table scheduling_runs
  add column schedule_week_start_date date null,
  add column schedule_week_end_date date null;

create index scheduling_runs_schedule_week_idx
  on scheduling_runs (schedule_week_start_date, schedule_week_end_date, created_at desc);
