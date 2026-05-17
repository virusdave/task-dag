-- Sweed Auth Event Log
--
-- Every auth-touching Sweed JSON-RPC the worker issues (login, logout,
-- dealer-set, initial-data, plus any RPC whose response carried an
-- auth-error signature) appends a row here so an operator can see —
-- after the fact and in the UI — exactly what tokens were minted,
-- which jobs they belonged to, when each call started/ended, and what
-- error came back.
--
-- This table is append-only by the worker. The schema deliberately
-- captures only a *prefix* of the Sweed auth token (first 8 chars) so
-- distinct sessions can be correlated without ever persisting a
-- usable credential.

create table if not exists sweed_auth_events (
  id                bigserial primary key,
  created_at        timestamptz not null default now(),
  -- nullable so callers that run outside a job (verifySweedSession
  -- from a dependency probe, the warmDependencyHealth boot sweep,
  -- ad-hoc server-side scopes, etc.) can still log.
  job_id            bigint references job_queue(id) on delete set null,
  job_type          text,
  -- e.g. 'store.auth.user', 'store.auth.end', 'store.auth.dealer.set',
  -- 'store.auth.initial.data.get', or the name of any other RPC that
  -- surfaced an auth-error in its response.
  rpc_name          text not null,
  -- one of: 'login' | 'logout' | 'dealer_set' | 'initial_data' |
  --         'rpc_auth_error' (failure of a non-auth RPC whose response
  --                            text looks like an auth failure) |
  --         'rpc_error'      (failure of any other RPC: transport error,
  --                            HTTP non-2xx, Sweed `error` envelope,
  --                            missing result payload, JSON parse error)
  event_kind        text not null,
  -- 'fresh' (per-job login) | 'legacy' (shared SWEED_AUTH_TOKEN) |
  -- null when the event happened before a session was opened (i.e. the
  -- login attempt itself).
  session_origin    text,
  -- First 8 chars of the auth token used, for cross-event correlation.
  -- Never store the full token here.
  auth_token_prefix text,
  dealer_id         bigint,
  outcome           text not null check (outcome in ('ok','error','retryable')),
  -- HTTP status, if available; null for client-side / transport
  -- failures (DNS, timeout, abort).
  http_status       int,
  -- Sweed's `error.message` field if present, otherwise the local
  -- exception message. Truncated to 2 KiB to bound row growth.
  error_message     text,
  duration_ms       int not null,
  -- Free-form context bag (param keys passed to the RPC sans values,
  -- retry attempt #, the Sweed JSON-RPC id, etc.). Caller-controlled.
  context_json      jsonb not null default '{}'::jsonb
);

create index if not exists sweed_auth_events_created_at_desc_idx
  on sweed_auth_events (created_at desc);

create index if not exists sweed_auth_events_job_id_idx
  on sweed_auth_events (job_id, created_at desc)
  where job_id is not null;

create index if not exists sweed_auth_events_outcome_idx
  on sweed_auth_events (outcome, created_at desc)
  where outcome <> 'ok';

create index if not exists sweed_auth_events_token_prefix_idx
  on sweed_auth_events (auth_token_prefix, created_at desc)
  where auth_token_prefix is not null;
