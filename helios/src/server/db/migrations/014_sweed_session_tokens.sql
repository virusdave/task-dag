-- Operator-pasted Sweed session tokens.
--
-- Sweed Prime enforces Google reCAPTCHA v3 on `store.auth.user`, so
-- the helios worker cannot mint its own session — only a real
-- logged-in browser can produce a valid `auth` UUID. We capture
-- those UUIDs from operator browsers (via a paste form OR a
-- one-click bookmarklet that reads the `auth` cookie on
-- prime.sweedpos.com) and store them here. Workers read the latest
-- unexpired token via getActiveSweedSessionToken() instead of the
-- legacy SWEED_AUTH_TOKEN env var.
--
-- "Active" semantics: at most one row is the active token at a
-- time — defined as `marked_expired_at is null` ordered by
-- created_at desc. Pasting a new token implicitly expires every
-- older row (see queries/sweedSessionTokensQueries.ts). Workers
-- never share two tokens concurrently.
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
  -- worker hitting "Auth expired"), OR when a newer token is
  -- pasted, OR when the operator manually expires it.
  marked_expired_at   timestamptz,
  expired_reason      text,
  -- Cheap optimization: store the dealer the session was pinned to
  -- when captured, so the first worker RPC can skip the redundant
  -- store.auth.dealer.set when targeting the same dealer.
  initial_dealer_id   bigint
);

-- Partial index: O(1) lookup of "the active token" (latest unexpired).
create unique index if not exists sweed_session_tokens_prefix_idx
  on sweed_session_tokens (token_prefix);

create index if not exists sweed_session_tokens_active_idx
  on sweed_session_tokens (created_at desc)
  where marked_expired_at is null;

create index if not exists sweed_session_tokens_history_idx
  on sweed_session_tokens (created_at desc);
