-- Migration 073: seo_post_scheduling
--
-- Helios-driven SEO widgets — auto-blog scheduling + social export (parent
-- epic virusdave/top-level#15, child epic FreshlyBakedNYC/automation#44,
-- phase P4 follow-on).
--
-- P4's first slice (migration 072) shipped the auto-blog control plane:
-- author / generate / review / APPROVE blog posts through the IRONCLAD
-- human gate, and a DB→bundle loader that exports *approved* posts. It
-- explicitly scoped OUT scheduling and social export as remaining P4 work.
--
-- This migration adds the SCHEDULING half: a control-plane release time so
-- an operator can approve a post now but have it enter the bundle only at
-- (or after) a chosen moment. `scheduled_publish_at` is NOT public content
-- — it is release timing — so it is deliberately EXCLUDED from the post's
-- content_sha256 (postContent.ts). Rescheduling therefore never invalidates
-- an approval; the DB→bundle loader gates on it
-- (scheduled_publish_at is null or <= now), and a future-scheduled post
-- simply does not appear until a later bundle build after its release time.
--
-- DB-cost note (canon §3): a single nullable column on the small,
-- operator-write-rate seo_posts table; no new index needed (the loader
-- already filters status='approved' first, a tiny set). No
-- recurring/background workload, so the P5 high-risk-DB gate does not apply.
--
-- Idempotent: `add column if not exists`. Safe to re-run.

\echo 'Running migration 073: seo_post_scheduling...'

alter table seo_posts
  add column if not exists scheduled_publish_at timestamptz;
