# Gemini-Clusters (automation child epic)

Child epic of `virusdave/top-level#<parent>`. Implements the automation-side
of the strategic-cluster work: gads L2 cluster-sweep run, strategic-clusters
config, helios `/ads/cluster-proposals` page + bundle endpoint, and the
operator runbook.

Parent epic plan:
`virusdave/top-level:docs/epics/gemini-clusters/EPIC_PLAN.md`

All commits landing on master that satisfy work in this child epic MUST
carry `Satisfies: virusdave/top-level#<parent>` as a commit trailer
(per the cross-repo-task-dag-driver design).

## Scope

| Phase | Deliverable | Files |
|-------|-------------|-------|
| P0 | Strategic-clusters YAML schema + Gemini seed | `ads/google/config/strategic-clusters.yaml`, `ads/google/lib/shared/strategicClustersSchema.ts` |
| P1 | gads L2 cluster-sweep prompt + driver + CSV generator | `ads/google/lib/l2/cluster-sweep/`, `ads/google/config/l2-cluster-sweep-prompts.yaml`, `ads/google/scripts/run-cluster-sweep.ts` |
| P3a | helios `/ads/cluster-proposals` server route | `helios/src/server/routes/adsClusterProposals.ts`, `helios/src/shared/contracts/api/adsClusterProposals.ts` |
| P3b | helios `/ads/cluster-proposals` client page | `helios/src/client/routes/ads/AdsClusterProposalsPage.tsx`, per-cluster card subcomponent, Apply modal w/ Lane A & C |
| P3c | Bundle ZIP generator | `helios/src/server/ads/clusterBundle.ts` — assembles README + per-cluster dirs + repairs + strategic-context + manifest |
| P5 | Wire-up: integration test + operator runbook | `ads/google/scripts/test-cluster-sweep.sh`, `docs/helios/gemini-clusters/RUNBOOK.md` |

Phase P2 (landing-pages L2) lives in `mostly-static-sites` child epic.
Phase P4 (systemd unit/timer) lives in `nixos-sbc` child epic. This
child epic depends on both being merged before the helios surface
shows complete output.

## Key design choices

### Hybrid pipeline (option c from intake)

The existing daily `gads-run-analysis.service` is **NOT** changed. A
new `gads-cluster-sweep.service` runs weekly + on-demand and consumes
the most recent daily L2 output as input. This guarantees the cluster
sweep's repair-related actions are consistent with whatever the daily
L2 has already queued; the cluster sweep is read-only with respect to
repair actions and adds cluster-level proposals on top.

### Reconciliation against existing campaigns

Each L2-emitted cluster carries one of four verdicts vs. existing
campaign structure:

- `extend-existing` — current campaign covers the cluster but is
  under-built; emit additive ad-group / keyword / ad CSV edits
- `merge-into-existing` — current campaign mostly covers it; rename
  + reshape rather than create new
- `create-new` — no existing coverage; emit new-campaign CSV with all
  the supporting structure
- `pause-and-replace` — current campaign covers it badly (e.g.
  unfocused, high CPA, policy churn); pause old + create new

Each verdict ships with referenced existing-campaign-ids and a
plain-language rationale that surfaces in the helios card.

### Three lanes per action

Each action gets a `lane: A | B | C` field. v1 emits A and C only.
Lane B placeholders may appear in `manifest.json` with status
`deferred` if the L2 thinks an API mutate would be the right vehicle
once Lane B infra exists, but the helios UI never offers a Run button
for them in v1.

### Bundle ZIP layout

```
README.md
clusters/
  strain-brand-power/
    verdict.md
    campaign.csv
    landing-pages/
      strain-library.html
      strain-library.diff
    copy.md
  delivery-revamped/
    ...
  ...
repairs/
  disapprovals.csv
  underperformers.csv
  creative-refresh.csv
  budget-adjustments.csv
strategic-context.yaml   # the input that drove the run
manifest.json            # machine-readable index
```

The bundle endpoint serves both per-cluster ZIPs
(`/api/ads/cluster-proposals/<runId>/clusters/<slug>/bundle.zip`) and
a top-level "everything" ZIP
(`/api/ads/cluster-proposals/<runId>/bundle.zip`). Both stream from
in-memory rather than caching to disk.

## Acceptance criteria

The child epic closes when:

1. `gads-cluster-sweep` runs end-to-end against the live snapshot on
   vps-nixos-3 (the systemd unit from the `nixos-sbc` child epic must
   be deployed first).
2. Helios `/ads/cluster-proposals` renders the run with per-cluster
   verdicts.
3. Top-level bundle ZIP downloads and contains all eight seeded
   clusters' subdirectories (or fewer if the L2 chose to pause /
   merge some — but the count + per-cluster verdict are visible).
4. The Lane C checklist renders deep-links into the Ads web UI that
   open the correct screens (verified by clicking at least one).
5. A landing master commit on this repo carries
   `Satisfies: virusdave/top-level#<parent>` and the closing comment
   on the parent epic includes the public helios URL + ZIP URL.

## Out of scope (deferred follow-on epics)

- Lane B auto-mutate from the helios page
- Embeddings-based unsupervised cluster discovery beyond Gemini seed
- Cluster-aware L3 prompts and per-cluster lift attribution
