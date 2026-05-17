-- Turn sweed_session_tokens into an exclusive-use session POOL.
--
-- Migration 014 modeled the table as "the active token" (singleton).
-- The new flow lets the operator paste several live Sweed `auth`
-- UUIDs at once; each helios worker job claims one for the duration
-- of its work and returns it to the pool when done so a future
-- worker can reuse it. Two jobs never share a token concurrently
-- (Sweed keeps server-side dealer context per-token and concurrent
-- callers would clobber each other's `store.auth.dealer.set`).
--
-- Claim columns:
--   claimed_at        when a worker took exclusive ownership
--   claimed_by        opaque worker/job tag ("worker:<pid>:job:<id>")
--   claim_expires_at  lease deadline — if a worker crashes / loses
--                     the DB connection mid-session, another worker
--                     can reclaim the row after the lease lapses
--
-- "Available" semantics (used by claimAvailableSweedSessionToken):
--   marked_expired_at is null
--   AND (claimed_at is null OR claim_expires_at <= now())
--
-- Releasing a session just clears the claim columns (the row stays
-- in the pool). Hitting "Auth expired" during use sets
-- marked_expired_at instead, permanently retiring it.

alter table sweed_session_tokens
  add column if not exists claimed_at       timestamptz,
  add column if not exists claimed_by       text,
  add column if not exists claim_expires_at timestamptz;

-- Partial index covering unexpired, unclaimed rows — the hot path for
-- claimAvailableSweedSessionToken. The predicate intentionally omits
-- a `claim_expires_at <= now()` clause because Postgres requires
-- index predicates to be IMMUTABLE and `now()` is not. The claim
-- query itself ORs in the lapsed-lease case at runtime; rows with a
-- lapsed lease are uncommon in steady state so a sequential scan of
-- those is cheap.
create index if not exists sweed_session_tokens_available_idx
  on sweed_session_tokens (created_at)
  where marked_expired_at is null
    and claimed_at is null;
