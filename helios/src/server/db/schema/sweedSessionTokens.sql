-- Operator-pasted Sweed session tokens — an exclusive-use POOL.
--
-- Sweed Prime enforces Google reCAPTCHA v3 on `store.auth.user`, so
-- the helios worker cannot mint its own session — only a real
-- logged-in browser can produce a valid `auth` UUID. We capture
-- those UUIDs from operator browsers (via a paste form OR a
-- one-click bookmarklet that reads the `auth` cookie on
-- prime.sweedpos.com) and store them here.
--
-- Pool semantics:
--   - Operator pastes one or more live tokens; they all sit in the
--     pool concurrently. New paste does NOT supersede older rows.
--   - Each worker job claims one row for the duration of its work
--     and releases it back to the pool when done. Two jobs never
--     share a token concurrently because Sweed keeps server-side
--     dealer context per-token and concurrent callers would clobber
--     each other's `store.auth.dealer.set`.
--   - A row is "available" iff
--       marked_expired_at is null
--       AND (claimed_at is null OR claim_expires_at <= now())
--     The lease (claim_expires_at) lets a crashed worker's claim be
--     reclaimed automatically rather than orphaning the token.
--   - Hitting "Auth expired" mid-use sets marked_expired_at and the
--     row is retired forever (the operator must paste a fresh one).
--
-- Tokens stored in plaintext (Sweed needs them verbatim in every
-- request body). The table lives in the same DB as
-- sweed_auth_events, so audit-trail cross-references resolve via
-- the token_prefix column.

create table if not exists sweed_session_tokens (
  id                  bigserial primary key,
  created_at          timestamptz not null default now(),
  -- Full Sweed auth UUID.
  token               text not null,
  -- First 8 chars of `token`; mirrors sweed_auth_events.auth_token_prefix
  -- so the UI can cross-reference "this token issued these RPCs".
  token_prefix        text not null,
  -- Free-form operator note: which browser / account / dealer this
  -- was captured from, etc.
  label               text,
  -- 'bookmarklet' | 'paste' | 'api' — how the token reached helios.
  source              text not null default 'paste',
  -- User id of the operator who pasted/captured it.
  created_by_user_id  bigint references users(id) on delete set null,
  -- Set when this token has been observed to be invalid (by a
  -- worker hitting "Auth expired") OR when the operator manually
  -- expires it. Once set, the row leaves the pool permanently.
  marked_expired_at   timestamptz,
  expired_reason      text,
  -- Cheap optimization: store the dealer the session was pinned to
  -- when captured, so the first worker RPC can skip the redundant
  -- store.auth.dealer.set when targeting the same dealer.
  initial_dealer_id   bigint,
  -- Pool claim columns (see file header for semantics).
  claimed_at          timestamptz,
  claimed_by          text,
  claim_expires_at    timestamptz,
  -- Highwater mark of the last successful Sweed keep-alive
  -- ("prolongs") for this token. withSweedSession re-issues the
  -- store.auth.dealer.list keep-alive when this is null or >24h old,
  -- then stamps it now(). See migration 045.
  last_prolonged_at   timestamptz
);

create unique index if not exists sweed_session_tokens_prefix_idx
  on sweed_session_tokens (token_prefix);

-- Partial index covering unexpired, unclaimed rows — the hot path for
-- claimAvailableSweedSessionToken. The predicate intentionally omits
-- a `claim_expires_at <= now()` clause because Postgres requires
-- index predicates to be IMMUTABLE and `now()` is not. The claim
-- query itself ORs in the lapsed-lease case at runtime.
create index if not exists sweed_session_tokens_available_idx
  on sweed_session_tokens (created_at)
  where marked_expired_at is null
    and claimed_at is null;

create index if not exists sweed_session_tokens_history_idx
  on sweed_session_tokens (created_at desc);
