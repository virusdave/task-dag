-- Migration 075: seo_posts_list_index
--
-- Helios-driven SEO widgets — auto-blog MVP (parent epic
-- virusdave/top-level#15, child epic FreshlyBakedNYC/automation#44, P4).
--
-- The /api/seo/posts control-plane list is now lean (no body variants) and
-- PAGINATED, newest-first: `order by updated_at desc, id desc limit … offset …`.
-- This composite index backs that page window so the list query never has
-- to sort the whole table once it grows (Oracle DB-efficiency review
-- follow-up). `updated_at` alone is not unique, so `id desc` is the stable
-- tiebreaker that matches the query's ORDER BY exactly.
--
-- DB-cost note (canon §3): one btree index on a small, operator-write-rate
-- table; negligible write amplification and storage. No recurring/background
-- workload — the high-risk-DB gate does not apply.
--
-- Idempotent: `create index if not exists`. Safe to re-run.

\echo 'Running migration 075: seo_posts_list_index...'

create index if not exists seo_posts_updated_at_id_desc_idx
  on seo_posts (updated_at desc, id desc);
