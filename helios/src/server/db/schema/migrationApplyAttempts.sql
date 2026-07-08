-- migration_apply_attempts
--
-- Lifecycle record for the admin "Apply Now" pending-migrations flow
-- (automation#62; see docs/helios/pending-migrations-admin-apply/DESIGN.md
-- "Data model"). One row per apply attempt. It is *updated through its states*
-- (not strictly append-only): a row is INSERTed `running` before `psql`
-- launches, then transitioned to exactly one terminal state. The immutable
-- event log is `audit_events`; this table carries the structured
-- who/when/how record that canon rules/DB_PERFORMANCE.md step 7 requires for a
-- web-triggered prod schema mutation (who requested it, the Oracle blessing
-- ref, the resolved artifact digest, the redacted psql command, txn mode,
-- advisory-lock acquisition, psql path/version, exit/signal, bounded+redacted
-- output, and the LIVE sentinel state before/after).
--
-- This table is itself bootstrapped via the current manual/canon apply path
-- (migration 099) — the feature cannot apply its own bootstrap — after which
-- the apply engine (leaf 4) reads/writes it.
--
-- Nullability: only `id`, `migration_id`, `state`, and `started_at` are known
-- at INSERT time; every other field is filled in as the attempt progresses, so
-- they are nullable. `job_id` / `requested_by_user_id` are nullable FKs
-- (`on delete set null`) so purging a job / deactivating a user never deletes
-- the audit record.
--
-- Idempotent: every `create` is `if not exists`.

create table if not exists migration_apply_attempts (
  id                     uuid primary key default gen_random_uuid(),

  -- The registered migrationId being applied, e.g. '097_litalerts_parse_feedback'.
  migration_id           text not null,

  -- The urgent job_queue job that carried out (or will carry out) the apply.
  -- Nullable so an eventual job purge doesn't cascade-delete the attempt record.
  job_id                 bigint references job_queue(id) on delete set null,

  -- The admin who clicked "Apply Now" (the "operator go"). Nullable FK so
  -- deactivating a user preserves the attempt provenance.
  requested_by_user_id   bigint references users(id) on delete set null,

  -- The type-to-confirm value the server validated == migration_id.
  confirm_migration_id   text,

  -- Provenance: the Oracle-blessing ref + the artifact-closure digest that was
  -- verified against the registry blessing at eligibility/apply time.
  blessing_ref           text,
  artifact_sha256        text,

  -- The deployed build that ran the apply, when available.
  deployed_build_id      text,

  -- The exact psql binary invoked + its reported version.
  psql_path              text,
  psql_version           text,

  -- The psql invocation with any credentials/URL redacted. NEVER store secrets.
  redacted_command       text,

  -- How the artifact handled transactions, recorded from the blessing.
  transaction_mode       text,

  -- Whether the exclusive apply advisory lock was acquired for this attempt.
  advisory_lock_acquired boolean,

  -- LIVE sentinel state (cache bypassed) before and after the apply. Success is
  -- reported iff sentinel_after is true.
  sentinel_before        boolean,
  sentinel_after         boolean,

  -- psql process outcome.
  psql_exit_code         integer,
  psql_signal            text,

  -- Bounded + redacted tails of psql stdout/stderr (bounding done by the worker).
  stdout_tail            text,
  stderr_tail            text,

  -- Human-readable failure summary, when the attempt did not succeed.
  error_message          text,

  -- Attempt lifecycle state:
  --   running        — inserted before psql launches.
  --   succeeded      — psql ran and the LIVE sentinel verified applied.
  --   failed         — nonzero exit / signal / sentinel mismatch after psql started.
  --   already_applied— live sentinel was already true; psql never ran (no-op success).
  --   blocked_lock   — the exclusive advisory lock was unavailable; psql never ran.
  --   abandoned      — crash / ambiguous process death left the outcome unknown.
  state                  text not null default 'running',

  started_at             timestamptz not null default now(),
  finished_at            timestamptz,

  constraint migration_apply_attempts_state_ok
    check (state in (
      'running',
      'succeeded',
      'failed',
      'already_applied',
      'blocked_lock',
      'abandoned'
    )),

  constraint migration_apply_attempts_transaction_mode_ok
    check (
      transaction_mode is null
      or transaction_mode in ('transactional', 'nontransactional-cic', 'mixed')
    )
);

-- "Last attempt for this migration" (the list API's lastAttempt column).
create index if not exists migration_apply_attempts_migration_id_started_idx
  on migration_apply_attempts (migration_id, started_at desc);

-- Correlate an attempt back to its job_queue row.
create index if not exists migration_apply_attempts_job_id_idx
  on migration_apply_attempts (job_id)
  where job_id is not null;

-- Cheaply find in-flight / stuck-running attempts (dedupe + abandon sweeps).
create index if not exists migration_apply_attempts_running_idx
  on migration_apply_attempts (started_at)
  where state = 'running';
