# Helios task-DAG interaction semantics

Issue: [automation#104](https://github.com/FreshlyBakedNYC/automation/issues/104)

This document fixes the presentation contract before the task pages gain more
controls or the task-DAG data model gains history. It describes operator-facing
behavior, not new task-dag authority. Current refs and completion commits are
**current evidence**, not a complete lifecycle history.

## Presentation statuses

Every task has exactly one presentation status. Derive it in this order so the
list, counts, graph, disclosures, and URL filters cannot disagree:

| Presentation status | Current evidence | Operator meaning |
| --- | --- | --- |
| `ready` | `status = pending` and `isReady = true` | Pickable now; known prerequisites are satisfied. |
| `waiting` | `status = pending` and `isReady = false` | Not pickable from the current snapshot. The status disclosure identifies unfinished or unavailable prerequisites when known. |
| `in-progress` | `status = in-progress` | A current claim exists. Show claimant, claim time, and note when available. |
| `blocked` | `status = blocked` | A current block exists. Show kind, reason, and block time when available. |
| `done` | `status = done` | Durable completion evidence exists. Show completion commit(s) and time(s) when available. |

`Ready` is not a stored lifecycle state and must not override in-progress,
blocked, or done evidence. Unknown or unavailable relationship data must never
be presented as satisfied.

## Task-card disclosure contract

The status, prerequisite, and subtask chips are buttons with a minimum 44 by 44
CSS-pixel target. They control one disclosure tray inside their task card:

| Control | Tray outcome |
| --- | --- |
| Status | Explain the current presentation status using the evidence above. Label the evidence coverage explicitly; do not claim to show history. |
| `N prerequisites` | List every resolved prerequisite in status-aware order, followed by explicit unavailable entries. Each resolved item links to task detail. |
| `N subtasks` | List every resolved direct breakdown child in status-aware order, followed by explicit unavailable entries. Each resolved item links to task detail. |

Pressing the active button closes the tray. Pressing another button replaces
the tray content without collapsing the card. `Escape` closes it and restores
focus to the button that opened it. Buttons expose `aria-expanded` and
`aria-controls`; the tray has an accessible heading and status updates use an
appropriate live region. Loading and retry errors appear inline in the tray,
without replacing the card.

Relationship ordering is `blocked`, `in-progress`, `ready`, `waiting`, `done`,
then unavailable; ties use title and canonical identity. This puts items most
likely to require operator attention first.

Polling preserves the open tray by canonical identity
`<repository>:<full task SHA>`. After each refresh the selected task and
relationship are re-derived from the new snapshot. If either disappears, the
tray says that the item is no longer available and offers retry or close; it
must not continue rendering stale evidence as current.

## Epic-plan status controls and URL state

The summary counts are the only status controls. Add `All` and make all six
counts (`all`, `ready`, `in-progress`, `blocked`, `waiting`, `done`) buttons.
Remove the lower decorative status-enum row.

The selected value is persisted as `status=<value>` in the query string.
Missing, empty, and unrecognised values normalize to `all` and are removed from
the canonical URL. Preserve unrelated query parameters. Browser Back/Forward
must restore the selection.

- **List view:** show only tasks with the selected presentation status.
- **Graph view:** retain every node and edge. Selected-status nodes remain at
  full emphasis and all other nodes are visibly dimmed. Do not remove nodes,
  project paths, or invent direct edges.
- Counts always describe the unfiltered non-epic snapshot. A zero count remains
  selectable and produces an explicit empty list or an entirely dimmed graph.

Graph selection is keyed by canonical identity rather than object identity and
is re-derived after polling. The selected-task panel includes a prominent
`View full task details` link. Relationship details must remain available in a
tap- and keyboard-accessible list; a hover tooltip may only supplement it.
Methodology and diagnostics belong below the primary graph in collapsed
sections.

## Sequence-summary membership

A completed-sequence summary accepts an immutable manifest containing an
explicit set of repository-qualified task identities. Membership must never be
inferred from timestamps, a worker/thread identity, issue membership, or a
shared epic.

```json
{
  "schema": 1,
  "capturedAt": "2026-07-26T12:00:00Z",
  "sequence": [
    { "repository": "FreshlyBakedNYC/automation", "sha": "<full-sha>" }
  ]
}
```

At completion time, persist the manifest plus a graph snapshot containing the
sequence nodes and exactly one hop of materially related endpoints for:

- `requires` and `required-by`;
- `satisfies` and `supersedes`;
- delegation; and
- direct breakdown parent/child relationships.

Sequence membership is orthogonal to lifecycle status and does not belong on a
general `TaskNode`. Sequence nodes use a heavier solid border and a visible
`Sequence` label. Related-only nodes use a dashed border and a visible
`Related` label. Lifecycle color/fill remains independent. Selecting a related
node explains the sequence task and relation that included it. Repository plus
full SHA is the canonical node key throughout; short SHAs are display only.

The persisted snapshot is historical evidence and is not recomputed after ref
retirement or later status changes. A future highlighted-only mode may hide
nodes only with explicit elision edges such as `via 3 hidden tasks`; it must
never render a projected path as an ordinary direct relationship.

## Acceptance fixtures

Implementations use these fixtures as minimum shared client/API scenarios:

1. **Status derivation:** pending+ready, pending+not-ready, claimed, blocked,
   and completed nodes produce the five presentation statuses and matching
   counts.
2. **Single tray:** a card with two prerequisites and three subtasks switches
   status → prerequisites → subtasks in one tray; a second press and `Escape`
   close it with correct focus restoration.
3. **Relationship availability:** one resolved and one unavailable prerequisite
   are both visible; unavailable is not counted as met and retry is inline.
4. **Polling:** cloned task objects with the same repository/full SHA preserve
   selection; a missing selected task produces explicit unavailable content.
5. **URL status:** `?status=blocked` restores the control, filters only list
   nodes, dims but retains graph nodes/edges, preserves other parameters, and
   Back/Forward restores prior values. `?status=bogus` normalizes to `all`.
6. **Membership/status orthogonality:** a done sequence node, blocked sequence
   node, and done related-only node retain lifecycle styling while their solid
   or dashed membership treatment and text labels remain distinct.
7. **One-hop boundary:** direct material relations are included once; their
   other neighbors are not. Missing endpoints persist as unavailable rather
   than disappearing silently.
8. **Topology:** status highlighting leaves the original node and edge identity
   sets unchanged. Any later hidden-path fixture requires an explicit elision
   edge and verifies graph reachability against the unfiltered snapshot.
9. **Accessibility/mobile:** every apparent chip is a semantic button with a
   44px target, visible keyboard focus, `aria-expanded`/`aria-controls`, and no
   information available only on hover.
10. **NY time:** every displayed claim, block, completion, and capture timestamp
    uses the existing America/New_York helpers.

## Authority boundary

Helios may expose only evidence its API can distinguish as resolved or
unavailable. Machine-readable edge notes/provenance and append-only lifecycle
events require their own task-dag critical-infrastructure design, Oracle review,
writer implementation, and activation. Until that authority exists, the UI
must use `coverage: current-evidence` and must not infer deleted claim/block
history from reflogs, provider comments, or absence of refs.
