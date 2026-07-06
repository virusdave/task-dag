# Canary record — 4 agent-waste review-queue child epics materialised under `top-level#34`

**Task-dag epic:** [virusdave/task-dag#6](https://github.com/virusdave/task-dag/issues/6)
— "make cross-repo child-epic materialisation a reusable, fleet-wide
capability", scope **G** (the canary / live beneficiary).

**Assigned leaf SHA:** `b47b91d996daaef2072c0fbb8c5495bae1d39256`
(`tasks/frontier/b47b91d`).

## What was done

Scope G is explicitly **not** blocked on the reusable-workflow migration
(scopes A–F): parent epic [virusdave/top-level#34](https://github.com/virusdave/top-level/issues/34)
lives in `top-level`, which already has a working `materialise-child-epic`
workflow. The four agent-waste review-queue follow-up child epics (source:
[`FreshlyBakedNYC/automation` → `docs/helios/agent-waste-review/RESOLVED_DESIGN.md`](https://github.com/FreshlyBakedNYC/automation/blob/master/docs/helios/agent-waste-review/RESOLVED_DESIGN.md)
"Remaining work"; all operator decisions closed) were therefore materialised
via `top-level`'s existing path.

The trailer commit (four `Materialise-Child-Epic:` groups, one distinct
`Child-Epic-Slug:` each so the two `FreshlyBakedNYC/automation` children do
not collide on the single `(parent, peer repo)` slot) landed on `top-level`
`master` as `7b91a4eff6057ec1cd32e66321c12f100ffcbd51`; the standalone
`materialise-child-epic.yml` workflow (run `28783663258`, success) created the
peer issues and ran `task-dag delegate` for each.

## Result (all four OPEN, delegated, marker-ref'd)

| # | Peer issue | Slug | Marker ref | Delegation ref |
|---|---|---|---|---|
| 1 | [virusdave/top-level#39](https://github.com/virusdave/top-level/issues/39) | `agent-waste-backlog-file` | `gh/child-epic-slots/34/virusdave/top-level/agent-waste-backlog-file` | `tasks/delegated/34/virusdave/top-level/39` |
| 2 | [Nicponskis/github-worker#4](https://github.com/Nicponskis/github-worker/issues/4) | `agent-waste-backlog-exporter` | `gh/child-epic-slots/34/Nicponskis/github-worker/agent-waste-backlog-exporter` | `tasks/delegated/34/Nicponskis/github-worker/4` |
| 3 | [FreshlyBakedNYC/automation#60](https://github.com/FreshlyBakedNYC/automation/issues/60) | `agent-waste-backlog-reader` | `gh/child-epic-slots/34/FreshlyBakedNYC/automation/agent-waste-backlog-reader` | `tasks/delegated/34/FreshlyBakedNYC/automation/60` |
| 4 | [FreshlyBakedNYC/automation#61](https://github.com/FreshlyBakedNYC/automation/issues/61) | `agent-waste-promote-button` | `gh/child-epic-slots/34/FreshlyBakedNYC/automation/agent-waste-promote-button` | `tasks/delegated/34/FreshlyBakedNYC/automation/61` |

Child-epic plans (issue bodies) live in `top-level` under
`docs/epics/amp-cost-reduction/child-epics/{top-level,github-worker,automation}/…/EPIC_PLAN.md`;
see the STATUS record
`docs/epics/amp-cost-reduction/STATUS_2026-07-06_agent-waste-review-child-epics-materialised.md`.

## Notes / verification

- The two pre-existing `#34` `github-worker` slots (`agent-waste`,
  `base-prompt-capsule`) are unrelated cost-reduction phases P4/P2; the new
  exporter deliberately uses a distinct slug (`agent-waste-backlog-exporter`)
  and did **not** collide.
- This confirms the slug-aware slot namespace (`gh/child-epic-slots/…`) works
  for a self-peer materialisation (`top-level#39`) as well as cross-repo.
- Idempotent: each per-slug marker ref makes a re-push a no-op.
- Satisfies the operator ask on
  [FreshlyBakedNYC/automation#57](https://github.com/FreshlyBakedNYC/automation/issues/57).
