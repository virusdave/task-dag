# Helios agent-waste review queue — resolved design

**Issue:** [FreshlyBakedNYC/automation#57](https://github.com/FreshlyBakedNYC/automation/issues/57)
**Status:** design **fully** resolved by operator (incl. the §Security
write-key decision — see "Security decision (RESOLVED)"); implementation
pending. No operator *decision* remains open; what is left is routine
cross-repo implementation + agenix key provisioning (see "Remaining work").

This doc records the design **after** the operator resolved the two open
questions that had blocked the epic. It supersedes the earlier
same-host-NDJSON transport sketch (Options A/B) that lived in the note of
task-dag leaf `0d07aed`.

## What "agent-waste" is

The github-worker dispatcher (runs as OS user `amp-local` on
`vps-nixos-3`) records an **agent-waste observation** on every guardrail
hit — e.g. an agent that tried a rejected `rg -r`. Producer + schema:
[`Nicponskis/github-worker` → `docs/AGENT_WASTE.md`](https://github.com/Nicponskis/github-worker/blob/master/docs/AGENT_WASTE.md)
(`agent-waste backlog --format json`).

There are **two** distinct data streams; conflating them is what made the
first transport sketch the wrong shape:

1. **Raw observation store** — the chatty append-only NDJSON the
   dispatcher writes on every hit. Feeds advisory **ranking** with ≤1-min
   latency. Per the cost-reduction design it is deliberately a *local*
   flocked file under the dispatcher's state dir
   ([`virusdave/top-level` → `docs/designs/amp-cost-reduction.md` §5.1](https://github.com/virusdave/top-level/blob/master/docs/designs/amp-cost-reduction.md)).
   **Helios never reads this.**
2. **Pending-review backlog** — only the unknown / free-form-`id` items
   that need a human eye. Genuinely **tiny and rare**. *This* is what
   Helios displays.

## Operator decisions (issue #57)

Resolved in comments
[#4888973661](https://github.com/FreshlyBakedNYC/automation/issues/57#issuecomment-4888973661)
and
[#4889080428](https://github.com/FreshlyBakedNYC/automation/issues/57#issuecomment-4889080428):

- **D1 — Storage: git-backed in `top-level`.** The producer
  (github-worker, already has push creds to `top-level`) exports the
  pending-review backlog to a small git file **co-located with**
  [`docs/agent-runtime/advisories.yaml`](https://github.com/virusdave/top-level/blob/master/docs/agent-runtime/advisories.yaml)
  in `virusdave/top-level`. Operator's rationale: *"top-level seems fine.
  Workers will already have that checked out in their
  ephemeral-workspace."* This replaces both same-host-NDJSON options
  (group-readable file / read-only HTTP bridge) and the Helios-DB-table
  alternative — git keeps the producer decoupled from Helios's prod DB
  and reuses code already running in prod.
- **D2 — Helios reads it read-only via a git mirror.** Same proven
  pattern as [`helios/src/server/taskDagMirror.ts`](../../../helios/src/server/taskDagMirror.ts)
  (bare `--mirror` clone, 60s refresh, deploy key, loud-but-non-fatal: a
  fetch failure keeps the last-good copy and reports "stale", never
  500s). Needs a **new read-only deploy key for `top-level`** (Helios
  currently only mirrors `automation`).
- **D3 — Promote is an in-Helios admin button, not a manual git edit.**
  Operator: *"i'll want a 'promote' action or button or toggle I can use
  within helios as an admin to make this change. I do not want to modify
  files in git manually. Helios already has the ability to commit changes
  to some repos... parser library configs."* This **overrides** the
  earlier agreed "v1 = display + link-to-promote; promote is intentionally
  not a Helios button." Promote now edits `advisories.yaml` in `top-level`
  via a **server-side git commit+push**, reusing the parser-config apply
  pattern in
  [`helios/src/server/parsekit/applyConfig.ts`](../../../helios/src/server/parsekit/applyConfig.ts).

## The three operations (do not conflate; they have different blast radii)

Governed by the [advisory catalog contract](https://github.com/virusdave/top-level/blob/master/docs/agent-runtime/ADVISORY_CATALOG.md):

1. **Promote to advisory** — edits `advisories.yaml`. **Mutating and
   behavior-changing:** it adds new allowlisted `text` the dispatcher can
   inject into future agents (~1-min latency). The human review action is
   the safety gate. This is the Helios button (D3).
2. **Structured observation counts** — influence agents only by
   **re-ranking already-human-approved advisories** (recurrence/recency
   are ranking inputs). No agent-authored text is ever injected; the
   allowlist is the invariant.
3. **Backlog triage marks** ("mark reviewed / dismiss") — **not** a
   ranking input; pure bookkeeping ("has a human looked at this yet").
   Changes agent behavior in **no** way. **Deferred** past v1 unless the
   queue gets noisy.

## Architecture

```diagram
╭──────────────────────╮   export backlog    ╭──────────────────────────╮
│ github-worker         │  (git commit+push)  │ top-level repo            │
│ dispatcher (amp-local)│───────────────────▶ │  docs/agent-runtime/      │
│  raw NDJSON stays     │                     │   ├─ advisories.yaml       │
│  LOCAL (not shown)    │                     │   └─ agent-waste-backlog.* │
╰──────────────────────╯                     ╰───────────┬──────────────╯
                                                          │ read-only mirror
                        promote (commit+push)             │ (60s, read key)
                        edits advisories.yaml             ▼
                     ╭──────────────────────────────────────────────╮
                     │ Helios (user `helios`, vps-nixos-3)           │
                     │  • 2nd read-only mirror of top-level          │
                     │  • setBacklogReader() → reads backlog file    │
                     │  • GET /api/agent-waste/backlog (admin)       │
                     │  • POST promote → git commit to advisories    │
                     ╰──────────────────────────────────────────────╯
```

### Reuse (already merged — issue #57 task 1)

- `GET /api/agent-waste/backlog` (admin-only), 503-degrades when transport
  unwired: [`helios/src/server/routes/agentWaste.ts`](../../../helios/src/server/routes/agentWaste.ts).
- Pluggable `BacklogReader` (`status()`/`readBacklog()`), default
  `unavailableBacklogReader`, `setBacklogReader()` install hook, and a
  hardened `parseBacklogNdjson()`:
  [`helios/src/server/agentWasteRepo.ts`](../../../helios/src/server/agentWasteRepo.ts).
- Zod contract, incl. the **`note` field is display-only and MUST NEVER be
  injected into agents**:
  [`helios/src/shared/contracts/api/agentWaste.ts`](../../../helios/src/shared/contracts/api/agentWaste.ts).

### Invariants the implementing worker must carry forward

- **`note` never becomes advisory `text`.** The promote flow must record
  exactly which backlog-item fields map to an advisory entry's `id` /
  `text` / `severity`; `note` is display-only and cannot leak into the
  injected allowlist.
- **Promote must validate against the advisory-catalog contract**
  server-side before committing (schema, budget caps, `id` rules) — mirror
  the parser-config apply pattern's "validate → write → `git add` →
  reject no-op → commit → push → reset local commit on push failure",
  with a subprocess timeout.
- **Concurrency:** producer-appends and human promote-commits touch
  adjacent files in the same repo. The producer side uses
  pull-rebase-retry (operator-blessed, low volume). The promote path
  inherits the applyConfig no-op rejection + reset-on-push-failure so a
  rejected push never piles up local commits; refetch/rebase and retry.
- **Read path is loud-but-non-fatal** (taskDagMirror semantics): a
  top-level fetch failure shows a stale/unavailable status, never a 500.

## Security: the write deploy key is the load-bearing decision

D3 requires Helios to **push to `top-level`** — the repo that hosts the
canon and the advisory allowlist injected into every future agent.
**GitHub deploy keys are repo-wide, not path-scoped:** an internet-facing
web server holding a `top-level` write key means a Helios compromise
becomes a fleet-wide prompt-injection / canon-tamper vector. This is a
strictly bigger trust grant than the (read-only) mirror key in D2, and
bigger than the existing `helios-parser-configs` write key (whose blast
radius is only parser configs).

Note: `top-level` is a **private** repo and GitHub branch protection is
unavailable on the current plan (same limitation documented in this repo's
`AGENTS.md`), so a "protected `master`" cannot be relied on to stop a
stray/compromised push. That materially changes each option:

Options as posted for the operator decision:

- **(a) Dedicated advisories repo.** Move `advisories.yaml` + the pending
  backlog into a small standalone repo; the write key's blast radius is
  then only advisories. **The only option that truly bounds a compromise.**
  Cost: loses the "workers already have top-level checked out" ergonomics
  the operator cited for D1.
- **(b) PR / non-master branch.** Helios pushes the promotion to a branch
  / opens a PR the operator merges. Adds a human review step on the honest
  path, but Helios still holds a repo-wide `top-level` write key, and with
  no branch protection a compromised server could still push to `master` —
  so it does **not** bound the compromise blast radius.
- **(c) Direct push to master** with admin-auth on the route + audit log +
  server-side advisory-catalog validation (the applyConfig shape). Most
  convenient; largest standing credential; same repo-wide key as (b).

### Security decision (RESOLVED)

**Operator adopted (c)** — direct, admin-gated, server-validated push to
`top-level master`. (a) and (b) are declined. Resolved in operator comment
[#4889206463](https://github.com/FreshlyBakedNYC/automation/issues/57#issuecomment-4889206463):

> "At the moment, the helios machine can push to any repo if the group,
> including top level. All workers can; it's necessary for them to be and
> to update canon instructions. These pushes should be strictly less
> risky, I'd imagine."

Rationale the operator accepted: the fleet already grants push access to
every group repo (including `top-level`, needed so agents can update
canon), so a **scoped, contract-validated, admin-gated** promote push is a
*narrower* action than access already in the trust model — not a new trust
grant. The residual repo-wide-deploy-key risk called out above is
therefore **explicitly accepted**, not mitigated by (a)/(b).

**Consequence for D2/D3 key provisioning — reclassified, not eliminated.**
The operator's comment is about the *host/machine* credentials (owned by
OS user `amp-local`); Helios's mirror + promote paths run as the **`helios`
service user**, which authenticates via its own per-repo agenix deploy key
(the automation mirror already does this —
[`taskDagMirror.ts`](../../../helios/src/server/taskDagMirror.ts) reads
`/run/agenix/helios-github-automation-deploy-key`). So a `top-level`
**read** key (D2) and, under (c), a `top-level` **write** key (D3) still
have to be provisioned for the `helios` user — but this is now **routine
agenix infra** (same shape as the existing automation read key and the
`helios-parser-configs` write key), **not a pending operator decision**.
It belongs in the follow-up `top-level` task (see "Remaining work" #1).

## Remaining work (proposed follow-up tasks — NOT created by this leaf)

This comment was handled by a single frontier-leaf worker, which may not
`breakdown` the epic (canon: `rules/WORKFLOW.md`). The decomposition below
is for the operator / an epic-root dispatch to create, and lives in the
owning repos. **All operator decisions are now closed** (D1/D2/D3 + the
§Security write-key choice); every item below is implementation +
routine infra provisioning, needing **no further operator input**:

1. **`top-level`** (infra): define the `agent-waste-backlog` file format
   next to `advisories.yaml`; provision a **read-only** agenix deploy key
   for the `helios` user (D2); and provision a scoped **write** deploy key
   for promotions (D3) — per the resolved §Security decision (option (c),
   direct validated push). Both keys are routine agenix provisioning, not
   an operator decision.
2. **`github-worker`**: exporter that writes the pending-review backlog to
   the top-level file (pull-rebase-retry on push).
3. **`automation`/Helios (re-scope of leaf `0d07aed`)**: add a second
   read-only mirror of `top-level` and wire `setBacklogReader()` to read
   the backlog file. Depends on #1 (file format + read key) — downstream,
   not operator-blocked.
4. **`automation`/Helios**: the promote-to-advisory button — server-side
   git commit to `top-level` `advisories.yaml`, admin-gated, contract-
   validated, applyConfig-pattern. Depends on #1 (write key) — downstream,
   not operator-blocked.

> **Task-creation gap — RESOLVED via a task-dag tooling epic
> ([virusdave/task-dag#6](https://github.com/virusdave/task-dag/issues/6)).**
> The operator's directive on
> [#57 (comment #4891259111)](https://github.com/FreshlyBakedNYC/automation/issues/57#issuecomment-4891259111)
> was: if the tooling can't launch a child work-stream epic in another repo
> and have it auto-picked-up, that's a tooling design miss to fix
> **canonically in the tooling**, and to file a new epic in the `task-dag`
> repo for it. Investigation confirmed the gap is real but narrow:
> cross-repo child-epic materialisation (the `Materialise-Child-Epic:`
> commit-trailer flow) works, but **only for `virusdave/top-level`-originated
> epics** — `top-level` has a working self-hosted `materialise-child-epic.yml`
> workflow, whereas `task-dag` ships the engine script *unwired* (no reusable
> workflow) and no peer caller has a `materialise` job. So a **peer**-repo
> epic (like `#57`) cannot spawn child epics. Canon `WORKFLOW.md`'s "Cross-repo
> child epics are fully automated" is thus overbroad. Epic
> [task-dag#6](https://github.com/virusdave/task-dag/issues/6) makes
> materialisation a reusable fleet-wide capability and, as its canary, creates
> these four child epics under parent `top-level#34`.
>
> Note: because the parent epic `top-level#34` lives in `top-level` (which
> already has a working materialise workflow), the four child epics are **not**
> blocked on that migration — they can be materialised today from a `top-level`
> `master` commit carrying the trailers. Until they exist, leaf `0d07aed`
> stays parked `--downstream` (not operator-blocked) awaiting #1/#2 above.
