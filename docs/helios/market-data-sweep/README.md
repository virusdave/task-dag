# Market-Data Sweep — design + task-DAG breakdown

This directory holds the design and the planned task-DAG breakdown
for the "always-fresh competitor data with loud alarms" epic.

- [`EPIC_PLAN.md`](./EPIC_PLAN.md) — design doc: motivation,
  settled operator requirements, data model, architecture, phase
  breakdown, open questions.
- [`task-dag-breakdown.json`](./task-dag-breakdown.json) —
  11-leaf breakdown for `task-dag breakdown <epic-sha>
  --spec-file=docs/helios/market-data-sweep/task-dag-breakdown.json`.
  Includes a `phase2b-per-brand-expiry` follow-on leaf that is
  intentionally sequenced after the alarm scanner: the global 4-day
  expiry ships first and is hardened in prod before we add the
  per-brand override.

## How to apply the breakdown

`scripts/task-dag breakdown <epic-sha> --spec-file=…` materialises the
whole spec in one pass: it creates one empty-tree task commit per leaf
(first parent = the epic, extra parents = its dependency tasks) and
publishes each as a `tasks/frontier/<short>` ref so other workers can
`claim` it. Workflow:

1. File the epic as a GitHub issue. The `issue-to-task` workflow on
   `FreshlyBakedNYC/automation` auto-creates the epic task commit on
   `tasks/pending/<issueN>`; `git ls-remote origin 'refs/heads/tasks/pending/*'`
   (or `task-dag show`) gives the epic SHA.
2. Make inter-leaf `dependencies` resolve automatically: give every
   *producing* entry a `key` equal to the angle-bracket label its
   dependents already use, minus the `<>`. A dependency token then
   resolves to either (a) the `key` of an EARLIER entry in the same
   spec (`<phase1-partner-client>` ↔ `"key": "phase1-partner-client"`),
   or (b) a real task SHA. List entries in dependency order — a
   forward/unknown reference is a hard error.
3. Dry-run first (`--dry-run`) to preview the plan without creating
   anything; the command also refuses to double-apply an epic that
   already has children (override with `--force`). The dependency gate
   itself is enforced at `complete` time, which refuses while any
   dependency is still open.

The labels/keys are intentionally human-readable so the dependency
graph can be read at a glance:

```diagram
                ╭───────────────────────────────╮
                │ phase1-partner-client         │
                ╰───────────────┬───────────────╯
                                ▼
                ╭───────────────────────────────╮
                │ phase1-migrate-build-context  │
                ╰───────────────┬───────────────╯
                                │
   ╭────────────────────────────┴─────────────┬───────────────╮
   ▼                                          │               │
╭──────────────────────────╮                  │               │
│ phase2-schema-migration  │                  │               │
╰────────────┬─────────────╯                  │               │
             │                                │               │
             ▼                                │               │
╭──────────────────────────╮                  │               │
│ phase3-view              │◀─────────────────┘               │
╰────────────┬─────────────╯                                  │
             │                                                │
             ├──▶ phase3-scheduler ◀──────────────────────────┘
             │
             ├──▶ phase4-enqueue-helper
             │
             ├──▶ phase6-ui ─────────┐
             │                       │
             └─▶ phase5-alarm ◀──────┤
                          │          │
                          ▼          ▼
                  phase7-regen-review-packet
                          │
                          ▼
                  phase8-runbook-and-cleanup
```
