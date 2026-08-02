# task-dag v2

The Rust `task-dag` binary (installed fleet-wide as `task-dag-v2`) is the sole
canonical task-dag runtime. It is provider-free: task identity, lifecycle,
claims, dependencies, delegation, and completion are represented by native Git
objects and refs rather than GitHub Issues, Actions, or a Bash runtime.

The authoritative design is
[`docs/designs/ref-native-minimal-task-dag.md`](docs/designs/ref-native-minimal-task-dag.md).
Legacy v1 objects remain readable historical evidence. They are not a runtime
or a writable authority.

## Build and test

Do not install Rust tooling imperatively. The flake pins the Rust toolchain,
dependencies, and Nix inputs:

```sh
nix develop
nix build
nix run -- --help
scripts/run-rust-tests.sh
scripts/run-rust-tests.sh TEST_FILTER
nix flake check
```

## Commands

The current surface is defined by `src/cli.rs`:

- runtime and bootstrap: `runtime identity`, `runtime publish`, `init`,
  `activate-runtime`, `activation`;
- lifecycle writers: `create`, `claim`, `renew`, `release`, `reap`, `block`,
  `unblock`, `breakdown`, `complete`, `complete-ops`, and `converge`;
- bounded readers: `show`, `blocked`, `deps`, `context`, `frontier`, and
  `current-state`;
- provider-free delegation: `delegate create`, `delegate admit`,
  `delegate export`, `delegate accept`, and `delegate status`;
- GitHub comment projection: `comment post TASK-ID --kind status|operator-decision
  --body-file PATH --operation-id ID`, plus explicit bounded recovery with
  `comment reconcile --max N --older-than DURATION`; canonical issue bindings
  use `comment associate`, while exceptional unbound targets use the explicit
  `comment force-request`, `comment force-decide`, and `comment force-send`
  authorization sequence;
- compatibility aliases: `epic-create` is `create`, `epic-compose` is
  `breakdown`, and `dag TASK-ID` is a bounded task view;
- exceptional migration: `migrate-v1-census` and `migrate-v1`.

Native-v2 commands read activation authority plus the bounded lifecycle,
receipt, provider, and cross-repository refs that are semantically relevant to
the operation. Required ref updates use appropriate Git concurrency primitives
and locking in a semantically correct fashion. Multi-ref transitions use exact
per-ref leases and atomic push; sequential CAS transitions are also valid when
their intermediate states are intentional, valid, and recoverable. Historical
`tasks/system/transitions` refs are inert data and are neither read nor updated.

Use `task-dag <command> --help` for exact arguments. Immutable dependencies
cannot be edited after task creation: `dep add` and `dep drop` are explicitly
unsupported. `project` and `provider` are also unsupported.

`comment post` resolves the nearest structural-ancestor GitHub issue binding,
records an immutable intent before calling authenticated `gh api`, and records
a receipt only after exact authenticated readback. Delivery is bounded to six
rounds over five minutes, with at least ten seconds between production rounds;
every possible POST is preceded by a complete paginated marker search.
Operation IDs replay only when their exact semantics agree. Failed or uncertain
delivery leaves the intent pending. Reconciliation is never implicit: the
operator selects at most 100 pending intents older than a duration such as
`10m`, `2h`, or `1d`; selection is oldest-first and bounded by hard ref and byte
limits.

`comment associate` authenticates and verifies the canonical GitHub repository
and issue paths and records both stable-ID binding aliases atomically. Forced
requests publish only the canonical authorization request: they do not mutate
GitHub or publish the returned, fully rendered
`task-dag-forced-comment-target-v1` decision packet. The packet includes a
one-time token whose plaintext is never stored. An `associate` decision directs
the caller back to association and normal posting. A `force` decision authorizes
only the exact request body, kind, and target; `force-send` uses the normal
stable-ID-verified, reconcilable delivery engine and appends a tooling-owned
forced-target warning.

## Claim safety

`.githooks/commit-msg` and `.githooks/pre-push` are thin launchers for native
CLI guards. Enable them with `git config core.hooksPath .githooks`. They do not
implement task semantics; set `TASK_DAG_BIN` when the system binary is not on
`PATH`.

`scripts/task-dag` is likewise only a compatibility launcher for prepared
workspaces and older package layouts that still resolve that path. It executes
the system-installed `task-dag-v2` binary and fails loudly when that binary is
unavailable; it contains no task semantics.

## Fleet activation and rollback

Deploy an immutable runtime commit only through the fleet-installed
coordinator:

```sh
deploy-task-dag-runtime deploy <40-char-task-dag-commit>
```

The coordinator stages and verifies the candidate, activates it fleet-wide
while the old stable runtime remains authorized, promotes the exact NixOS
revision, and performs authoritative final readback. It does not promote stable
until every canonical repository authorizes the candidate and the candidate can
read every repository.

Building or distributing a package, or publishing its runtime object without
activation, is **staging**, not deployment. `runtime publish`,
`activate-runtime`, package installation, and hand-built activation loops are
low-level primitives for the coordinator or exceptional recovery; they are not
the normal release workflow. A system-installed stable runtime rejected by
activation fencing or minimum-version requirements is a production-critical
incident requiring immediate repair and an operator page.

Rollback uses the same coordinator after staging an exact reviewed NixOS
revision that pins the last known-good runtime:

```sh
deploy-task-dag-runtime deploy <last-known-good-40-char-commit>
```

Do not manually install or repin the system runtime first, and do not hand-loop
over `activate-runtime`. If the installed stable runtime is already fenced and
the coordinator cannot proceed, stop and page the operator; low-level commands
are incident-recovery primitives only. Rollback is never a semantic-ref rewrite
or a history edit.

## Historical v1 evidence

The repository retains v1 Git objects and history so audits and the exceptional
importer can prove provenance. `migrate-v1-census` is the read-only census;
`migrate-v1` is the deliberately exceptional, freeze-gated importer. Neither
makes v1 writable again. The historical v1 documents are clearly marked and
remain evidence only.
