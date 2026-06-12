-- Migration 077: seo_recommendations
--
-- Helios-driven SEO widgets — GA4/GSC feedback loop, recommendation engine
-- (parent epic virusdave/top-level#15, child epic
-- FreshlyBakedNYC/automation#44, phase P5).
--
-- The recommendation engine reads the imported GSC/GA4 daily facts
-- (migration 076) and proposes DRAFT actions for an operator: e.g. a
-- high-impression / low-CTR query with a salvageable position becomes a
-- "draft an FAQ answering this" suggestion; a high-impression / low-CTR
-- PAGE becomes a "revise title/meta" suggestion.
--
-- IRONCLAD human gate (canon §1): a recommendation is a SUGGESTION, never
-- published content. Nothing here is ever rendered. "Accepting" a
-- recommendation only CREATES A DRAFT (e.g. a draft FAQ set) which still
-- has to pass the existing human approve→bundle gate before anything ships.
-- The engine therefore cannot auto-publish; it can only fill an operator's
-- review queue.
--
-- Idempotency / write-on-change (canon §3): each recommendation has a
-- DETERMINISTIC id = sha-derived from (site, rec_type, target) so re-running
-- the generator collapses onto the same row. The generator upsert refreshes
-- the rationale/priority of an OPEN recommendation only when a meaningful
-- field changed (… is distinct from …) and NEVER resurrects one the
-- operator already accepted/dismissed (the upsert's WHERE gates on
-- status = 'open'). So a re-run over unchanged metrics writes ZERO rows.
--
-- DB-cost budget (canon §3): a tiny, operator-rate table (a few hundred
-- open recommendations at most). The generator runs only when the operator
-- triggers it (after an import), not on a timer. Reads are bounded by
-- site + status + LIMIT and served by the (site, status, priority desc)
-- index. No background workload, so the high-risk-DB gate's recurring-cost
-- arm does not apply; the import side already carries the Oracle review.
--
-- Idempotent: every `create` is `if not exists`. Safe to re-run.

\echo 'Running migration 077: seo_recommendations...'

create table if not exists seo_recommendations (
  -- sha-derived deterministic id (seorec_<type>_<16 hex>) — stable across
  -- generator runs for the same (site, rec_type, target).
  recommendation_id    text        primary key,
  rec_type             text        not null,   -- faq_gap | low_ctr_title
  site                 text        not null,   -- helios scope (site id or 'all')

  -- target dimensions (which of these is set depends on rec_type)
  target_query         text,
  target_page_url      text,

  title                text        not null,   -- short human summary
  rationale            jsonb       not null,   -- metrics snapshot driving it
  priority             integer     not null default 0, -- sort key (≈ impressions)

  status               text        not null default 'open', -- open|accepted|dismissed
  -- set when accepted → the draft the operator was sent to finish + approve
  linked_content_kind  text,                   -- faq_set | post
  linked_content_id    text,

  decided_by_user_id   bigint,
  decided_at           timestamptz,
  decision_note        text,

  first_seen_at        timestamptz not null default now(),
  updated_at           timestamptz not null default now(),

  constraint seo_recommendations_rec_type_check
    check (rec_type in ('faq_gap', 'low_ctr_title')),
  constraint seo_recommendations_status_check
    check (status in ('open', 'accepted', 'dismissed')),
  constraint seo_recommendations_linked_kind_check
    check (linked_content_kind is null or linked_content_kind in ('faq_set', 'post')),
  -- a decided recommendation must carry who/when decided it
  constraint seo_recommendations_decided_check
    check (status = 'open' or (decided_by_user_id is not null and decided_at is not null)),
  -- an accepted recommendation must be linked to the draft it spawned
  constraint seo_recommendations_accepted_link_check
    check (status <> 'accepted'
           or (linked_content_kind is not null and linked_content_id is not null))
);

-- Operator review queue: open recommendations for a site, highest-impact
-- first. Partial index keeps it tiny (decided rows fall out).
create index if not exists seo_recommendations_site_status_priority_idx
  on seo_recommendations (site, status, priority desc);
