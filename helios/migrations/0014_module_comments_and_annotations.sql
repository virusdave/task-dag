-- Module-aware comments and annotations.
--
-- Both tables are keyed by (module_code, scope_kind, scope_ref jsonb) so a
-- single shared contract can serve every Helios module rather than adding
-- nullable per-module columns to existing tables.
--
-- Append-friendly: edits write a new row; deletions are soft (deleted_at on
-- comments, retracted_at on annotations). This mirrors the append-only
-- audit event style.
--
-- scope_ref is a small jsonb shape like {"id": <number-or-string>} along
-- with whatever extra context the module wants to record (e.g.
-- {"id": 42, "brandId": 17, "itemKey": "abc"}). Lookups in the UI go
-- through the (module_code, scope_kind, scope_ref->>'id') path and
-- through the brandId / itemKey paths for cross-references.

create table module_comments (
  id bigserial primary key,
  module_code text not null,
  scope_kind text not null,
  scope_ref jsonb not null default '{}'::jsonb,
  body text not null,
  author_user_id bigint null references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz null
);

create index module_comments_scope_idx
  on module_comments (module_code, scope_kind, (scope_ref->>'id'))
  where deleted_at is null;

create index module_comments_brand_idx
  on module_comments (module_code, (scope_ref->>'brandId'))
  where deleted_at is null;

create index module_comments_item_key_idx
  on module_comments (module_code, (scope_ref->>'itemKey'))
  where deleted_at is null;

create trigger module_comments_set_updated_at
before update on module_comments
for each row execute function set_updated_at();

create table module_annotations (
  id bigserial primary key,
  module_code text not null,
  scope_kind text not null,
  scope_ref jsonb not null default '{}'::jsonb,
  kind text not null,
  body text not null,
  author_user_id bigint null references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  retracted_at timestamptz null
);

create index module_annotations_scope_idx
  on module_annotations (module_code, scope_kind, (scope_ref->>'id'))
  where retracted_at is null;

create index module_annotations_brand_idx
  on module_annotations (module_code, (scope_ref->>'brandId'))
  where retracted_at is null;

create index module_annotations_item_key_idx
  on module_annotations (module_code, (scope_ref->>'itemKey'))
  where retracted_at is null;

create index module_annotations_kind_idx
  on module_annotations (module_code, scope_kind, kind)
  where retracted_at is null;

create trigger module_annotations_set_updated_at
before update on module_annotations
for each row execute function set_updated_at();
