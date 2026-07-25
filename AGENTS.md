# Agent instructions for task-dag

**MANDATORY FIRST READ for every session — dispatcher, manual, or one-off.
Re-read agent canon each session; every rule applies unless explicitly scoped
to dispatcher/worker machinery.**

**First check `AGENT_WORKSPACE_MANIFEST`.** If it is set and validates (see
`docs/agent-runtime/PREPARED_WORKSPACE_CONTRACT.md` in top-level), canon is
already on local disk at `canon.canon_core_path` and task-dag at
`task_dag.cli`; **do NOT bootstrap**. Follow an injected runtime capsule as
the startup briefing; otherwise read the Core from `canon.canon_core_path`.
Record `canon.canon_sha`.

**Otherwise** read canon from a fresh ephemeral checkout of
`virusdave/top-level` at `origin/master`:

```sh
ec=/home/amp-local/src/top-level/scripts/ephemeral_checkout
cw=$("$ec" top-level --label "canon-read-$$-$RANDOM")
cat "$cw/docs/canon/AGENTS_CANON.md"  # session end: "$ec" --remove "$cw"
```

That file is authoritative; follow its dispatch table to relevant deep rules.
The final work must include its Agent Gate Record. This file adds only
task-dag-specific instructions and cannot weaken canon. Shared repository
knowledge is indexed at `top-level:docs/agent-kb/repos/index.md`.

## Test resource policy on Helios

- On the production Helios host, do **not** run
  `tests/task-dag/run-all.sh` before publishing while its wall clock is two
  minutes or more. Run the smallest relevant fixture(s), syntax checks, and
  static checks locally; rely on the `cli-tests` GitHub Actions job for the
  heavyweight aggregate gate.
- This exception ends only after the complete aggregate suite is measured on
  Helios at under two minutes. At that point, running it locally before every
  publish becomes required again.
- Never weaken, skip, or remove the CI aggregate gate to make this policy pass.
