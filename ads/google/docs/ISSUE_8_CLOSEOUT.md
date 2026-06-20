# Issue #8 — task-dag closeout & traceability

**Issue**: <https://github.com/FreshlyBakedNYC/automation/issues/8>
**Epic task SHA**: `90c06c81` (`tasks/pending/8`)
**Closeout child**: `10855f7` — "Close out issue #8 with design comment and traceability map"
**Closeout date**: 2026-06-20

> Why this file exists: the issue #8 epic root remained `pickable` in
> task-dag long after the work it describes was implemented and deployed.
> This note records that reconciliation so a future agent does not
> re-decompose an already-shipped epic. The original design narrative
> lives in [`GITHUB_ISSUE_SUMMARY.md`](./GITHUB_ISSUE_SUMMARY.md) /
> [`ARCHITECTURE.md`](./ARCHITECTURE.md) (written before implementation —
> read them as the design of record, not as current status); current
> status lives in [`../SYSTEM_STATUS.md`](../SYSTEM_STATUS.md) and
> [`../STATUS.md`](../STATUS.md).

## What #8 asked → where it is satisfied

| Issue #8 requirement | Status | Where |
| --- | --- | --- |
| Migrate the three-layer (L1/L2/L3) agentic hill-climbing system from the MSS repo into `ads/google` for gads **content** | ✅ Implemented & deployed | `ads/google/lib/{l1,l2,l3,shared,html,gads-api,helios}`, `config/`, `docs/ARCHITECTURE.md` |
| Understand the MSS philosophy/strategy with agent + oracle before building | ✅ Done | `docs/ARCHITECTURE.md`, `docs/GITHUB_ISSUE_SUMMARY.md`, `config/l2-prompts.yaml` (North-Star philosophy) |
| Unidirectional data flow gads → helios → this repo → MSS | ✅ Reflected | `docs/HELIOS_EXPORT_SOURCE.md`, `scripts/helios-export-snapshot.ts`, `scripts/export-from-google-ads.ts` |
| First task: ingest current gads state via API + backfill an assumed prior state | ✅ Operational | `gads-snapshot-export.timer` → `scripts/helios-export-snapshot.ts`; snapshots in `ads/google/snapshots/` |
| Hill-climb via aggressive speculative testing; create temporary `*-trial-00N` groups at $1 budgets; probe limitation/disapproval causes in isolation | ✅ Operational | `lib/l2/csv-generator.ts` (numbered CSVs incl. `001-create-trial-*`), `scripts/monitor-trials.ts`, `gads-monitor-trials-{1,4,24,48}hr.timer`, `gads-cleanup-trials.timer`, `scripts/cleanup-trials.ts` |
| First major milestone: HTML "next steps" summary (A repair/replace disapproved/limited assets, B create $1 probe experiments, C remove stale prior trial items), served via mss-one-offs for 24h, paged to dave at P3, with a ZIP-of-sequentially-numbered-CSVs download button at top + bottom | ✅ Delivered under **closed #11** | Issue [#11](https://github.com/FreshlyBakedNYC/automation/issues/11) "Visualization into gads efforts" (CLOSED); `docs/EXPERIMENTS_VIZ_UI_SPEC.md`, `scripts/build-experiments-viz.py`, `scripts/generate-experiment-dashboard.ts`, `scripts/run-turn.sh` (uploads to mss-one-offs + pages operator) |
| Document the design and post a markdown version in the issue comments | ✅ Done by this closeout child | Comment posted on issue #8 (leading `<!-- task-dag:status -->` marker so it is not re-ingested as a task) |
| Surface other significant concerns as issue questions/comments | ✅ Addressed | See closeout comment + "Known caveats" below |

## Follow-on work (tracked separately — NOT residual #8 scope)

- [#47](https://github.com/FreshlyBakedNYC/automation/issues/47) — GAds landing-pages analytics V1 (Helios).
- [#49](https://github.com/FreshlyBakedNYC/automation/issues/49) — Eliminate broken-codebase debt (helios + ads), incl. the `ads/google` typecheck gate.
- [#51](https://github.com/FreshlyBakedNYC/automation/issues/51) — GAds evolver introspection dashboard.

## Known caveats observed at closeout (not remediated under #8)

- `gads-run-analysis.service` was in systemd `failed` state when observed
  on 2026-06-20. This is a live operational issue, not part of the
  stale-epic decomposition; it was intentionally **not** touched here
  (no manual service surgery). It should be triaged as ops/broken-codebase
  work (cf. #49) rather than re-opening #8's migration scope.
