-- Track the Sweed session keep-alive ("prolongs") highwater mark.
--
-- Sweed sessions stay valid indefinitely as long as we exercise them
-- at least once a day. Per Sweed's own guidance, the canonical
-- keep-alive is a `store.auth.dealer.list` RPC issued with the
-- session's auth token; calling it daily prolongs the session
-- server-side so the operator-pasted UUID does not silently lapse.
--
-- We record the timestamp of the most recent successful prolong on
-- each pool row. This is a HIGHWATER MARK: it only ever moves forward
-- (set to now() after a successful keep-alive). withSweedSession reads
-- it when it claims a row and re-issues the keep-alive only when the
-- last prolong is older than 24h (or has never happened), so the cost
-- is at most one extra RPC per token per day, piggy-backed on the
-- first job that claims the row that day.
--
-- NULL means "never prolonged by helios" — the first claim of such a
-- row will issue the keep-alive and stamp this column.

alter table sweed_session_tokens
  add column if not exists last_prolonged_at timestamptz;
