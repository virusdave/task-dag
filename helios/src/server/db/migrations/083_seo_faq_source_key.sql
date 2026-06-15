-- FBUS FAQ source-key persistence (child FreshlyBakedNYC/automation#46, P1,
-- CI gate 2). Satisfies: virusdave/top-level#17.
--
-- Adds the STABLE, logical source identity of an FAQ set's source as a
-- first-class, server-side column. The source key (shape `<host-ns>-
-- <family>-faq`, e.g. `fbus-global-faq`) survives regeneration/re-import,
-- and its host namespace tells the control plane whether a set is FBUS
-- (`freshlybaked.us`) sanitized-mode — i.e. whether the IRONCLAD approval
-- gate must hold the set to the STRICTER FBUS denylist (`findFbusLeaks`)
-- rather than the host-agnostic raw-only check.
--
-- The column is nullable: existing/manual sets have no source key and keep
-- the host-agnostic approval behavior. The check constraint mirrors the
-- pure source-key grammar in src/server/seo/faqSourceKey.ts so a junk key
-- can never be persisted. We deliberately do NOT fold source_key into the
-- content fingerprint (it is source identity, not approvable content).

\echo 'Running migration 083: add seo_faq_sets.source_key...'

alter table seo_faq_sets
  add column if not exists source_key text;

alter table seo_faq_sets
  drop constraint if exists seo_faq_sets_source_key_check;

alter table seo_faq_sets
  add constraint seo_faq_sets_source_key_check
  check (
    source_key is null
    or source_key ~ '^fbus-[a-z0-9]+(-[a-z0-9]+)*-faq$'
  );

\echo 'Migration 083 complete.'
