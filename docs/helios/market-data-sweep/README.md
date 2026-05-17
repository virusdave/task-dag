# Market-Data Sweep — design + task-DAG breakdown

This directory holds the design and the planned task-DAG breakdown
for the "always-fresh competitor data with loud alarms" epic.

- [`EPIC_PLAN.md`](./EPIC_PLAN.md) — design doc: motivation,
  settled operator requirements, data model, architecture, phase
  breakdown, open questions.
- [`task-dag-breakdown.json`](./task-dag-breakdown.json) —
  10-leaf breakdown for `task-dag breakdown <epic-sha>
  --spec-file=docs/helios/market-data-sweep/task-dag-breakdown.json`.

## How to apply the breakdown

The task-DAG `breakdown` subcommand wants real SHAs in `dependencies`,
not the human-readable labels (`<phase1-partner-client>` etc.) used in
[`task-dag-breakdown.json`](./task-dag-breakdown.json). Recommended
workflow:

1. File the epic as a GitHub issue. The `issue-comment-sync` workflow
   on `FreshlyBakedNYC/automation` will auto-create the epic task
   commit; `task-dag frontier` will show the epic SHA.
2. Apply the breakdown in dependency order, one leaf at a time —
   create the upstream leaves first, capture each returned SHA, then
   substitute those SHAs for the labelled dependencies in later
   leaves before passing them to `task-dag breakdown <epic-sha>
   --stdin-json`.

The labels are intentionally human-readable so the dependency graph
can be read at a glance:

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
