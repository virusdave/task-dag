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

- runtime and bootstrap: `runtime identity`, `runtime publish`, `init`, and
  `activation`;
- lifecycle writers: `create`, `claim`, `renew`, `release`, `reap`, `block`,
  `unblock`, `breakdown`, `complete`, `complete-ops`, and `converge`;
- bounded readers: `show`, `blocked`, `deps`, `context`, `frontier`,
  compatibility `current-state`, and local-mirror `current-state-page`;
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

`current-state-page` traverses open task state as a hexadecimal prefix tree in
a bare local mirror. Start with an empty prefix. A `split` result directs the
caller to the sixteen one-nibble child prefixes; a `leaf` contains at most 16
selected tasks plus exact directly related lifecycle proofs. Every invocation
reads and validates only its prefix and direct relation closure, never prior
pages. Callers must hold the mirror stable across a complete traversal and run
`git pack-refs --all --prune` once after refresh; the reader rejects loose task
refs because Git cannot guarantee prefix-bounded iteration over them. The
legacy aggregate `current-state --max-tasks` remains only for cutover
compatibility and must not be used for an unbounded repository index.

Use `task-dag <command> --help` for exact arguments. Immutable dependencies
cannot be edited after task creation: `dep add` and `dep drop` are explicitly
unsupported. `project` and `provider` are also unsupported.

Pass the global `--timings` option to emit live, additive operation timings to
stderr without changing a command's normal stdout. Timings use the standard
folded-stack format accepted by flamegraph tooling:

```text
all-threads; invocation; command.context; remote.fetch 1843200
```

The final number is nanoseconds spent in exactly that active stack since the
previous span transition. Summing records by stack prefix partitions parent
wall time without double-counting nested operations. The option is global, so
`task-dag --timings context ...` and `task-dag context --timings ...` are
equivalent. Without `--timings`, tracing callsites are disabled and do not read
the clock, allocate span state, or write output.

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

## Runtime deployment and rollback

Publish the tested immutable runtime, pin the NixOS system to that exact commit,
quiesce task-dag consumers, and deploy the reviewed system revision:

```sh
task-dag-v2 runtime publish --commit <40-char-task-dag-commit>
self-deploy-helios-system --revision <40-char-nixos-sbc-commit>
```

After the system switch, verify both hosts report the exact runtime identity and
resume consumers. Runtime deployment does not mutate participating repositories
or maintain per-repository authorization. Worker quiesce/resume is an explicit
operator-directed side-agent effect, outside task-dag and autonomous dispatch.
Publishing the runtime tag without switching and verifying the system is
staging, not deployment.

Rollback uses the same system controller with an exact reviewed NixOS revision
that pins the last known-good runtime:

```sh
self-deploy-helios-system --revision <last-known-good-nixos-sbc-commit>
```

Rollback is never a task semantic-ref rewrite or a history edit.

## Historical v1 evidence

The repository retains v1 Git objects and history so audits and the exceptional
importer can prove provenance. `migrate-v1-census` is the read-only census;
`migrate-v1` is the deliberately exceptional, freeze-gated importer. Neither
makes v1 writable again. The historical v1 documents are clearly marked and
remain evidence only.
