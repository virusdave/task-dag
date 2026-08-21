# Agent instructions for task-dag

**MANDATORY FIRST READ for every session — dispatcher, manual, or one-off.
Re-read agent canon each session; every rule applies unless explicitly scoped
to dispatcher/worker machinery.**

**First check `AGENT_WORKSPACE_MANIFEST`.** If it is set **and validates**
(see `docs/agent-runtime/PREPARED_WORKSPACE_CONTRACT.md` in top-level), the
workspace is prepared. **Do NOT bootstrap.** Record `canon.canon_sha`; follow
an injected runtime capsule, or read Core from `canon.canon_core_path` when
there is no capsule. Use the manifest's claim and repo data, but invoke
task-dag through `/run/current-system/sw/bin/task-dag`.

**Otherwise** (no/invalid manifest) bootstrap a fresh canon read at
`origin/master` — the cold path:

```sh
unset AGENT_WORKSPACE_MANIFEST  # required when a present manifest failed validation
ec=/home/amp-local/src/top-level/scripts/ephemeral_checkout
cw=$("$ec" top-level --label "canon-read-$$-$RANDOM")  # unique label; no shared paths
cat "$cw/docs/canon/AGENTS_CANON.md" "$cw/docs/agent-kb/tools.md"
# session end: "$ec" --remove "$cw"
```

Read **Canon Core**, then its compact tool router and every matched authority.
Never bulk-load unrelated documentation or skip documentation specifically
relevant to the task, tool, or context. Canon wins across all repos; final work
requires its **Agent Gate Record**.

<!-- agents-md:always-read:end -->

Shared repository knowledge is indexed at
`top-level:docs/agent-kb/repos/index.md`.

## Threat model for task-dag design and review

The current task-dag design does **not defend against deliberate malicious
mutation by an actor who already has write access to a participating
repository**. That adversary is out of scope unless the operator explicitly
expands the threat model for a specific task. Within this boundary, optimize
for simplicity, correctness, orthogonality, and composability.

Natural failures and correctness hazards remain in scope, including races,
crashes, stale or concurrent writers, malformed state, and external API
failure or uncertainty. This boundary is not permission to weaken ordinary
safety, validation, fail-closed behavior, recovery, or least privilege.

Every Oracle prompt that reviews a task-dag design or architecture, including
a post-implementation change review, MUST state this boundary explicitly; a
link to this section alone is insufficient.

## Rust CLI safety requirements

- Every Rust CLI command and subcommand, as well as a bare CLI invocation,
  MUST support a no-op `--help` invocation. If `--help` is present, the process
  MUST make no state change to task-dag or any other development or production
  system.
- Rust must use canonical safe coding practices and preserve the guarantees of
  the type system. Do not bypass validated types with unchecked `unwrap`,
  `expect`, unchecked indexing, raw pointers, or equivalent assumptions when
  processing external, persisted, remote, or otherwise fallible data.
- Treat likely panic paths and unsafe hygiene in Rust CLI code as errors. Keep
  a lightweight static lint gate enabled to reject such patterns where a
  practical lint exists; any narrow exception requires explicit justification.

## Test resource policy on Helios

- Use `scripts/run-rust-tests.sh` for the canonical pinned Rust test suite.
- Run focused Rust filters while iterating. The Rust-only `cli-tests` workflow
  runs the complete wrapper; no retired Bash aggregate is a release gate.

## Runtime deployment uses a quiesced system cutover

Publish the immutable runtime, pin the reviewed NixOS revision to that exact
commit, quiesce runtime consumers, and use the installed mirrored system
controller:

```sh
task-dag-v2 runtime publish --commit <40-char-task-dag-commit>
self-deploy-helios-system --revision <40-char-nixos-sbc-commit>
```

Deployment is complete only after both hosts report the exact runtime identity
and consumers resume. Do not add per-repository runtime authorization,
dual-runtime activation, deployment journals, or rolling compatibility
machinery. Quiesce/resume is an operator-directed side-agent effect outside
task-dag and autonomous dispatch.
