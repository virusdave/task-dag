-- Migration 098: litalerts_parse_feedback promotion provenance (issue #59, T5)
--
-- Adds the promotion-provenance columns + coupling CHECK to the INERT operator
-- parse-correction feedback inbox introduced by migration 097. These record
-- which parsekit parser / rule / `helios-parser-configs` release-sha a piece of
-- DB feedback was promoted into, once an agent/reviewer realizes it in the
-- parser-configs repo. This is NOT a web-side git write and NOT a live parser —
-- it is provenance only. See
-- helios/src/server/db/schema/litalertsParseFeedback.sql for full rationale and
-- docs/helios/catalog-market-data/PARSE_FEEDBACK_PROMOTION.md for the path.
--
-- Cost/plan: three nullable text columns + one CHECK on an EMPTY (or near-empty,
-- human-driven) table. No data rewrite, no new hot index (promotion export uses
-- the existing retailer/status partial indexes from 097). Additive + idempotent
-- (`add column if not exists`; the constraint is added only when absent).
--
-- Forward-only, additive, idempotent — safe to re-run. This is the ALTER path
-- for any environment that already applied 097 before these columns existed; a
-- fresh 097 apply already includes them via the schema file.

\set ON_ERROR_STOP on

\echo 'Running migration 098: litalerts_parse_feedback promotion provenance...'

begin;

alter table litalerts_parse_feedback
  add column if not exists promoted_parser_id  text,
  add column if not exists promoted_rule_id    text,
  add column if not exists promoted_config_sha text;

-- ADD CONSTRAINT has no IF NOT EXISTS; add it only when it's missing so the
-- migration is safe to re-run.
do $$
begin
  if not exists (
    select 1
      from pg_constraint c
      join pg_class t on t.oid = c.conrelid
      join pg_namespace n on n.oid = t.relnamespace
     where n.nspname = 'public'
       and t.relname = 'litalerts_parse_feedback'
       and c.conname = 'litalerts_parse_feedback_promotion_meta_ok'
  ) then
    alter table litalerts_parse_feedback
      add constraint litalerts_parse_feedback_promotion_meta_ok
        check (
          (
            case
              when status = 'promoted'
                then promoted_parser_id is not null and promoted_config_sha is not null
              when status in ('draft', 'promotion_requested', 'rejected')
                then promoted_parser_id is null
                  and promoted_rule_id is null
                  and promoted_config_sha is null
              else true
            end
          )
          and (promoted_parser_id is null) = (promoted_config_sha is null)
          and (promoted_rule_id is null or promoted_parser_id is not null)
        );
  end if;
end
$$;

commit;

\echo 'Migration 098 complete.'
