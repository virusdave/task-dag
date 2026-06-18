# P1 — Data audit + per-attempt site-scope semantics

> **Epic:** [FreshlyBakedNYC/automation#51](https://github.com/FreshlyBakedNYC/automation/issues/51)
> (Helios child of [`virusdave/top-level#24`](https://github.com/virusdave/top-level/issues/24),
> *gads-evolver-introspection*). Parent design doc is authoritative:
> `virusdave/top-level:docs/epics/gads-evolver-introspection/EPIC_PLAN.md`.
>
> **Phase:** P1 (data audit + scoping semantics).
> **Status:** complete — this doc is the P1 deliverable.
> **Closure criteria (from the plan):** confirm which tables/files are
> populated in prod; **decide the per-attempt site-scope policy**. No
> per-site page ships until scoping is safe.
>
> Audit date: **2026-06-18** (NY). Read-only inspection of the prod
> Tiger Cloud DB (`tsdb`) + source read of the ads pipeline. No schema
> change and no prod write was performed in P1 (those are P2+, and are
> gated on Oracle DB review + operator approval).

---

## 0. TL;DR — the decision

1. **The data sources exist and are populated** (`gads_ad_attempts`,
   `landingpage_ad_outcomes`, `gads_lp_rollup`; morning-bundle/L2/L3
   artifacts are produced on disk under the helios-owned
   `$AUTOMATION_REPO_PATH/ads/google/outputs/`).
2. **`gads_ad_attempts` has no `site` column, and `account_id` is
   useless for scoping** (uniformly `'unknown'` in prod — see §2). The
   **only reliable site signal already present is the campaign / ad-group
   name**, exactly the signal the existing snapshot builder already uses.
3. **Site-scope policy (decided, matches the plan's preferred option):**
   - **P2** adds `site text null` to `gads_ad_attempts` (and the same
     treatment is applied to the `landingpage_ad_outcomes` surface).
   - **Derive `site` by reusing the existing canonical heuristic**
     `pickGeoTarget(lower(campaign_name + ' ' + ad_group_name))` from
     [`helios/src/server/ads/buildSnapshotFromCsv.ts`](../../../helios/src/server/ads/buildSnapshotFromCsv.ts)
     — do **not** invent a second campaign-name parser.
   - Map **only `bronx` / `midtown`** to grant-scoped per-site values
     (those are the only `GADS_SITES`). Any other geo
     (`brooklyn`/`queens`/`manhattan`) **or** no match → `site = null`
     (**unknown-scope**).
   - **Backfill best-effort** over the existing rows with the same
     heuristic.
   - **Per-site pages use a server-derived predicate `site = $key`**
     (never a client-supplied widening param). **Unknown-scope rows
     (`site is null`) are hidden from per-site views** and surfaced
     **only under `gads-all`, badged** "site unknown".
   - `gads-all` (its own superset grant, never synthesised) shows all
     rows including unknown-scope.
4. **Scoping is therefore safe to ship per-site:** ~88.5% of attempts
   map cleanly to bronx/midtown; the ~11.5% unknown-scope tail is a
   single cross-site "Trials" campaign that is correctly *excluded* from
   per-site pages rather than mis-attributed.

---

## 1. Prod population audit

Counts as of the audit (prod `tsdb`, `public` schema):

| Table | Approx rows | Total size | Populated? |
|---|---|---|---|
| `gads_ad_attempts` | 540 | ~1.0 MB | **yes** |
| `landingpage_ad_outcomes` | 63 | ~0.5 MB | **yes** |
| `gads_lp_rollup` | (small) | ~24 kB | yes (owned by #18, cross-link only) |

### `gads_ad_attempts`

- **540 rows**, **120 distinct `ad_id`**, **7 distinct `run_id`**.
- Date range **2026-05-23 → 2026-05-31**.
- Outcome distribution: `no_change` 169, `superseded` 146,
  `worse` 5, `success` 1, **open/unobserved 219**.
- Action-type distribution: `monitor` 328, `repair` 98, `pause` 66,
  `trial_control` 24, `trial_variant` 24.

Per-run cadence (insert health):

| run_id | attempts | ads | date | observed |
|---|---|---|---|---|
| run-2026-05-23-73158b71 | 22 | 18 | 2026-05-23 | 3 |
| run-2026-05-24-56a09ca4 | 20 | 18 | 2026-05-24 | 3 |
| run-2026-05-24-0d48e257 | 27 | 26 | 2026-05-24 | 0 |
| run-2026-05-25-a22028a2 | 84 | 76 | 2026-05-25 | 81 |
| run-2026-05-25-07d275bb | 129 | 71 | 2026-05-25 | 129 |
| run-2026-05-31-da854e09 | 112 | 67 | 2026-05-31 | 43 |
| run-2026-05-31-51e72f12 | 146 | 71 | 2026-05-31 | 62 |

> **⚠️ Operational note (informational, not P1-blocking):** no attempt
> rows have been inserted since **2026-05-31** (~18 days before the
> audit), and **all 219 open attempts are stale-open (>7d with no
> observed outcome)**. This is exactly the "loop-health / stale-open"
> red flag the Evolution page (P4) is meant to surface, and the data is
> currently a **static historical window**, not a live feed. It does not
> change the scoping decision, but P3/P4 must render honest empty/stale
> states rather than imply the loop is currently running, and the P7
> runbook should tell the operator how to check why the morning/L2 path
> stopped writing. (Flagged to the operator on the issue.)

### `landingpage_ad_outcomes`

- **63 rows**, all `created_at = 2026-05-31 12:32:42Z` (a single
  ingest/backfill, not an ongoing feed).
- `signal_type` × `planned_action` × `outcome_status`:
  - `creative_repair_candidate` / `edit_disapproved_in_place` /
    `pending_import` — 43
  - `policy_suspect_landing_page` / `evolve_landing_page` /
    `pending_observation` — 20
- Has `campaign_name` but **no `site` column** (same gap as attempts).
- P6 treats this as the "LP-evolver reaction" panel with an honest
  "no LP outcome actions recorded yet / single historical ingest" state
  until the write path is confirmed ongoing.

### Filesystem artifacts (morning bundle / L2 / L3)

- Produced under `$AUTOMATION_REPO_PATH/ads/google/outputs/` —
  on prod `AUTOMATION_REPO_PATH=/var/lib/helios/automation`, resolved by
  [`getAutomationRepoRoot()`](../../../helios/src/server/ads/automationRepoRoot.ts);
  bundles live under `.../outputs/prod/bundle/run-<date>-<shortid>.zip`
  ([`morningBundleRuns.ts`](../../../helios/src/server/ads/morningBundleRuns.ts)).
- That tree is owned `helios:helios` mode `700`, so the audit user
  cannot enumerate it directly. **Presence is confirmed by inference:**
  the 7 `run_id`s above only exist because the morning bundle + L2 JSON
  were generated and the post-bundle insert
  ([`adAttemptsTracker.recordAttemptsFromL2Output`](../../../helios/src/server/ads/adAttemptsTracker.ts))
  ran for each. The P5/P6 endpoints run **as `helios`** and therefore
  will have read access; no privilege escalation is needed or was done
  in P1.

---

## 2. Why `account_id` cannot scope, and what can

`gads_ad_attempts.account_id` is **uniformly `'unknown'`** across all 540
rows (and `family_key.account_id` is likewise `'unknown'`). Root cause:
Google Ads Editor exports usually leave the Customer/ID column empty
unless a "Get Recent Changes" sync was done right before export, so
[`buildSnapshotFromCsv.ts`](../../../helios/src/server/ads/buildSnapshotFromCsv.ts)
falls back to `'unknown'`, and the attempt insert copies that straight
from the matched snapshot ad. **`account_id` is therefore not a usable
scoping key and must not be used for site derivation.**

The morning bundle runs over **one global snapshot containing all
accounts at once** (`runMorningBundle.ts`), so there is also no
per-run/per-account site context to attach at insert time.

The **only** reliable site signal already in the data is the
campaign / ad-group **name**, which the snapshot builder already parses
via `pickGeoTarget()`:

```ts
function pickGeoTarget(name: string): string | null {
  if (name.includes('midtown'))   return 'midtown'
  if (name.includes('bronx'))     return 'bronx'
  if (name.includes('brooklyn'))  return 'brooklyn'
  if (name.includes('queens'))    return 'queens'
  if (name.includes('manhattan')) return 'manhattan'
  return null
}
```

Applied to `lower(campaign_name + ' ' + ad_group_name)`, this is the
canonical, already-shipped derivation. **Reuse it; do not write a second
parser.** Note `GADS_SITES`
([`helios/src/shared/domain/gadsSites.ts`](../../../helios/src/shared/domain/gadsSites.ts))
only defines `bronx` and `midtown`, so any other geo collapses to
unknown-scope for the per-site grant model.

### Derivation coverage (the safety check)

Classifying the 540 rows with the `pickGeoTarget` logic
(`campaign + ad_group`, substring, case-insensitive):

| Derived site | Attempts | Distinct ads | Note |
|---|---|---|---|
| `midtown` | 291 | 75 | grant-scoped |
| `bronx` | 187 | 38 | grant-scoped |
| **unknown (null)** | **62** | **11** | all from one campaign |

The entire unknown tail is the single cross-site campaign
**`Trials 2026-05-16`** (ad groups like `Smoking Scholars-trial-002`,
`NYC Bud-trial-001`, `brand-flower-trial-001`, …). The ad-group name
does not rescue it (no bronx/midtown token), which is *correct*: a
cross-site trials campaign genuinely has no single site, so it belongs
under `gads-all` (badged), never silently attributed to one borough.

For `landingpage_ad_outcomes` the same heuristic yields 43 midtown,
16 bronx, 4 unknown (again the `Trials 2026-05-16` campaign) — so the
identical policy applies to that surface.

---

## 3. Decided site-scope policy (binding for P2/P3)

1. **Schema (P2):** add `site text null` to `gads_ad_attempts`. `null`
   means "unknown-scope" (no enum/`not null` — we must represent
   genuinely cross-site/unmappable rows). Apply the same column +
   derivation to the `landingpage_ad_outcomes`-backed surface.
2. **Write path (P2):** at insert in
   [`adAttemptsTracker`](../../../helios/src/server/ads/adAttemptsTracker.ts),
   set `site = mapGeoToGadsSite(pickGeoTarget(campaign + ' ' + adGroup))`
   where `mapGeoToGadsSite` returns `'bronx' | 'midtown'` or `null` (any
   other geo / no match). Reuse the existing `pickGeoTarget`; expose a
   tiny shared mapper rather than duplicating the substring list.
3. **Backfill (P2):** best-effort `UPDATE` of existing rows using the
   same derivation (deterministic from `campaign_name` + `ad_group_name`
   already stored). Idempotent; safe to re-run.
4. **Read path (P3):** the endpoints derive the predicate **server-side
   from the validated route scope**, never from a client param:
   - scope `bronx` → `WHERE site = 'bronx'`
   - scope `midtown` → `WHERE site = 'midtown'`
   - scope `all` → no `site` filter (returns every row, incl.
     `site is null`), gated behind the `gads-all` grant only.
   **Per-site queries must exclude `site is null`** (a `= 'bronx'`
   predicate already does this, since `null = 'bronx'` is not true) — so
   unknown-scope rows can never leak into a per-site page.
5. **UI (P4/P5):** under `gads-all`, unknown-scope rows render with a
   **"site unknown" badge**; per-site pages simply never show them.
6. **Grants:** reuse `requiredGadsGrants()` verbatim
   ([`gadsSites.ts`](../../../helios/src/shared/domain/gadsSites.ts)) —
   `gads-bronx`/`gads-midtown` see only their site (plus `gads-all` as
   superset); `gads-all` is its own grant, never synthesised from
   per-site grants.

### Access-safety invariants P3 tests must assert

- A Bronx-only user (`gads-bronx`) cannot read Midtown or all rows.
- `gads-all` is required for the cross-site scope and is explicit.
- Unknown-scope (`site is null`) rows are hidden from every per-site
  response and appear only under `gads-all`.
- The site predicate is server-derived; a client-supplied site/widening
  param is ignored.
- Payloads are bounded (aggregates / capped row counts), per the
  "cheapest defensible DB use" constraint — no per-event fact table, no
  rollup/hypertable/CAGG/HLL in V1.

---

## 4. Cost / DB notes carried into P2+

- All audit queries were bounded aggregates over a ~540-row /
  ~63-row table; trivial cost. The production tables are small and
  purpose-built — the V1 plan's "read them directly with bounded
  aggregate queries" stance holds; no rollup infra is justified.
- The only index relevant to the new `site` predicate is a possible
  `(site, created_at desc)` partial/btree, **deferred to P2** and only
  if a query plan justifies it on a table this small (likely it does
  not at 540 rows — record the plan before adding any index).
- No migration auto-applies on deploy: P2's `site` column + backfill is
  applied on prod by the agent **only after Oracle DB review + explicit
  operator approval**, then verified live (canon §3).

---

## 5. P1 closure

- [x] Confirmed prod population of `gads_ad_attempts`,
      `landingpage_ad_outcomes`, `gads_lp_rollup`, and (by inference)
      the morning-bundle/L2/L3 filesystem artifacts.
- [x] Established that `account_id` cannot scope and the
      campaign/ad-group name (via existing `pickGeoTarget`) can.
- [x] Decided the per-attempt site-scope policy (add `site text null`,
      derive+backfill via the existing heuristic, hide unknown-scope
      per-site, show under `gads-all` badged, server-derived predicate).
- [x] Flagged the stale/stopped insert feed to the operator as an
      informational note (does not block scoping).

**Next:** P2 implements the `site` column + derivation + best-effort
backfill (Oracle DB review + operator approval before applying on prod).
