alter table proposal_batches
  add constraint proposal_batches_job_id_fkey
  foreign key (job_id) references job_queue(id);

alter table proposal_rows
  add constraint proposal_rows_source_llm_run_id_fkey
  foreign key (source_llm_run_id) references llm_runs(id);

alter table write_operations
  add constraint write_operations_trigger_event_id_fkey
  foreign key (trigger_event_id) references audit_events(id);

alter table undo_events
  add constraint undo_events_original_event_id_fkey
  foreign key (original_event_id) references audit_events(id);

alter table undo_events
  add constraint undo_events_undo_audit_event_id_fkey
  foreign key (undo_audit_event_id) references audit_events(id);
