-- Migration 105: immutable, capture-time inferred transaction attribution.
-- Additive and metadata-only for historical rows (default not_attempted); no
-- backfill or later recomputation guesses attribution.

\set ON_ERROR_STOP on
\timing on

begin;
set local lock_timeout = '5s';

\ir ../schema/customerReviews.sql

commit;
