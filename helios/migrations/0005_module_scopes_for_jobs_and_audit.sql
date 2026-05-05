alter table job_queue
  add column module_code text not null default 'catalog',
  add column scope_entity_type text null,
  add column scope_entity_id text null,
  add constraint job_queue_scope_pair_check check (
    (scope_entity_type is null and scope_entity_id is null)
    or (scope_entity_type is not null and scope_entity_id is not null)
  );

update job_queue
set module_code = 'catalog',
    scope_entity_type = case when catalog_group_id is not null then 'catalog_group' else null end,
    scope_entity_id = case when catalog_group_id is not null then catalog_group_id::text else null end;

create index job_queue_module_status_run_at_idx on job_queue (module_code, status, run_at, id);
create index job_queue_scope_status_run_at_idx on job_queue (module_code, scope_entity_type, scope_entity_id, status, run_at, id)
  where scope_entity_type is not null and scope_entity_id is not null;

alter table audit_events
  add column module_code text not null default 'catalog',
  add column scope_entity_type text null,
  add column scope_entity_id text null,
  add constraint audit_events_scope_pair_check check (
    (scope_entity_type is null and scope_entity_id is null)
    or (scope_entity_type is not null and scope_entity_id is not null)
  );

update audit_events
set module_code = 'catalog',
    scope_entity_type = case when catalog_group_id is not null then 'catalog_group' else null end,
    scope_entity_id = case when catalog_group_id is not null then catalog_group_id::text else null end;

create index audit_events_module_created_idx on audit_events (module_code, created_at desc);
create index audit_events_scope_created_idx on audit_events (module_code, scope_entity_type, scope_entity_id, created_at desc)
  where scope_entity_type is not null and scope_entity_id is not null;
