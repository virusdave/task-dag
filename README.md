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
- compatibility aliases: `epic-create` is `create`, `epic-compose` is
  `breakdown`, and `dag TASK-ID` is a bounded task view;
- exceptional migration: `migrate-v1-census` and `migrate-v1`.

Use `task-dag <command> --help` for exact arguments. Immutable dependencies
cannot be edited after task creation: `dep add` and `dep drop` are explicitly
unsupported. `comment`, `project`, and `provider` are also unsupported. The
runtime neither calls nor projects to an issue provider.

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

Roll forward by building and distributing one immutable runtime commit,
publishing it with `runtime publish`, then activating it under the exact
activation lease in each repository. Verify authoritative readback before
advancing the fleet. Activation retains the current and candidate runtimes for
the handoff epoch.

Rollback must move both control planes in safe order: first repin and deploy the
immutable Nix package containing the last known-good Rust runtime, verify its
compiled identity and publication, and then perform a lease-fenced activation
that authorizes that runtime across the fleet. Read back package identity and
activation in every repository. Rollback is never a semantic-ref rewrite or a
history edit.

## Historical v1 evidence

The repository retains v1 Git objects and history so audits and the exceptional
importer can prove provenance. `migrate-v1-census` is the read-only census;
`migrate-v1` is the deliberately exceptional, freeze-gated importer. Neither
makes v1 writable again. The historical v1 documents are clearly marked and
remain evidence only.
