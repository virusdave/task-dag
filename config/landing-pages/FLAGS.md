# Landing-page engine — feature-flag contract (P0)

The migration (parent
[`EPIC_PLAN.md`](https://github.com/virusdave/top-level/blob/master/docs/epics/unified-landing-engine/EPIC_PLAN.md)
§10) is a strangler-fig: at every phase the live pages keep serving and
we can roll back. These flags are the agreed control surface. They are
**read by the mss runtime** (the consumer); Helios (this repo) honours
the same names so dashboards, runbooks, and shadow-compare tooling agree
on one vocabulary.

P0 only **defines** the flags. No flag changes behaviour yet — the
runtime that reads them is built in mss P2+.

| Flag | Type | Default | Meaning |
|------|------|---------|---------|
| `LP_RUNTIME_MODE` | enum `legacy \| shadow \| canary \| v2` | `legacy` | Master mode. `legacy` = today's mss behaviour; `shadow` = evaluate the bundle policy in-memory and log parity but serve legacy; `canary` = serve v2 for a gated slice; `v2` = serve v2 for all lp traffic. |
| `LP_BUNDLE_SOURCE` | path (URI) | _unset_ | The read-only `/cloud` artifact root mss polls for `current.json`. Unset ⇒ loader disabled. |
| `LP_V2_SITE_ALLOWLIST` | csv of site ids | _empty_ | Sites eligible for v2/canary rendering. Empty ⇒ none. |
| `LP_V2_FAMILY_ALLOWLIST` | csv of family ids | _empty_ | Families eligible for v2/canary rendering. Empty ⇒ none. |
| `LP_V2_PERCENT` | integer `0..100` | `0` | Canary ramp percentage of eligible traffic served v2. |
| `LP_V2_KILL_SWITCH` | bool | `false` | Global hard kill: when `true`, immediately fall back to `legacy` regardless of other flags. |

## Interaction rules

- `LP_V2_KILL_SWITCH=true` overrides everything → `legacy`. This is the
  single global escape hatch (parent §10 P7 rollback).
- In `canary` mode a request is served v2 only if **all** hold: its site
  ∈ `LP_V2_SITE_ALLOWLIST`, its family ∈ `LP_V2_FAMILY_ALLOWLIST`, and
  its deterministic bucket falls within `LP_V2_PERCENT`. Otherwise it is
  served `legacy`.
- `shadow` mode never serves v2; it only logs `{legacy_selection,
  policy_selection, matched}` for the parity dashboard (parent §10 P3).
- A fail-closed bundle-validation event does **not** flip a flag; mss
  keeps serving the last-known-good bundle and fires `page-dave -p 4`
  (parent §5 step 6, decision 2). Flag changes are the operator's lever;
  fail-closed is the automatic safety net.

## Phase → flag trajectory (parent §10)

| Phase | Typical flag state |
|-------|--------------------|
| P0 contracts | all defaults (nothing reads them yet) |
| P2 loader | `LP_BUNDLE_SOURCE` set; mode still `legacy` |
| P3 shadow | `LP_RUNTIME_MODE=shadow` |
| P4 preview | `legacy` + per-request `?lp_runtime=v2` for allowlisted QA |
| P6 canary | `LP_RUNTIME_MODE=canary`; ramp `LP_V2_PERCENT` 1→5→25→50→100 over a widening allowlist |
| P7 full | `LP_RUNTIME_MODE=v2`; `legacy` retained behind `LP_V2_KILL_SWITCH` one release window |
| P8 decommission | flags retained for emergency rollback; legacy code removed |
