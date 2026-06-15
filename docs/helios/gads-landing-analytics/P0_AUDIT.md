# P0 — Audit + locked semantics: GAds → Landing-pages analytics (V1)

> Child epic [FreshlyBakedNYC/automation#47](https://github.com/FreshlyBakedNYC/automation/issues/47),
> owning child of [virusdave/top-level#18](https://github.com/virusdave/top-level/issues/18).
> Authoritative design: `docs/epics/gads-landing-analytics/EPIC_PLAN.md`
> in `virusdave/top-level`. This note is the **P0 deliverable**: it
> confirms the data audit and **locks** the GAds traffic predicate, the
> reporting timezone, and the metric formulas that P2 (rollup + refresh
> job) and P3 (serving endpoint) must implement verbatim.

**No schema change is made by P0.** The only artifact is this note.

---

## 1. `lp_events` audit (live prod, db-94793 / `tsdb`)

Source of truth in repo:
[`helios/src/server/db/migrations/070_lp_events.sql`](../../../helios/src/server/db/migrations/070_lp_events.sql).
The live table was inspected read-only on 2026-06-15.

### 1.1 Columns — all parent assumptions present

Every column the parent plan assumes exists, with the expected type:

| Parent assumption | Live column | Type | Nullable |
|---|---|---|---|
| `assignment_id` | `assignment_id` | `text` | yes |
| event types | `event_type` | `text` (CHECK: `lp_impression`/`lp_redirect`/`lp_assignment`/`lp_conversion`) | no |
| `site` | `site` | `text` | no |
| `family` | `family` | `text` | yes |
| `cluster_slug` | `cluster_slug` | `text` | yes |
| `experiment_id` | `experiment_id` | `text` | yes |
| `policy_id` | `policy_id` | `text` | no |
| `policy_rule_id` | `policy_rule_id` | `text` | yes |
| `branch_id` | `branch_id` | `text` | yes |
| `served_probability_bps` | `served_probability_bps` | `integer` (0..10000) | yes |
| `assignment_key_type` | `assignment_key_type` | `text` (CHECK: `gclid`/`gbraid`/`wbraid`/`cookie`/`session`/`default`) | yes |
| `gclid_hash` | `gclid_hash` | `text` | yes |
| `traffic_flags` | `traffic_flags` | `jsonb` (array of strings, e.g. `paid_google`, `bot_suspected`) | yes |
| `event_ts` | `event_ts` | `timestamptz` (UTC) | no |

**Note on `traffic_flags`:** it is a JSONB **array**, not an object, so
membership tests use the JSONB `?` operator
(`traffic_flags ? 'paid_google'`), not `->>`.

### 1.2 Indexes present

```
lp_events_pkey            UNIQUE (id)
lp_events_event_id_idx    UNIQUE (event_id)                       -- ingest idempotency
lp_events_type_ts_idx     (event_type, event_ts DESC)
lp_events_assignment_idx  (assignment_id) WHERE assignment_id IS NOT NULL   -- partial
lp_events_bundle_idx      (bundle_id, event_ts DESC)
lp_events_site_family_idx (site, family, event_ts DESC)
```

### 1.3 `assignment_id` presence per stage; `branch_id` granularity

- `assignment_id` is **nullable** and is HMAC-bound to
  `bundle_id|policy_rule_id|slot|variant|bucket` (schema description,
  parent §9). It is the funnel join key. Funnel counts MUST be
  assignment-unique and MUST ignore rows where `assignment_id IS NULL`
  (the partial index `lp_events_assignment_idx` exists precisely for
  this filter). Whether every stage (`lp_impression` in particular)
  carries an `assignment_id` cannot be confirmed empirically yet — the
  table is currently **empty** (§1.4). The rollup therefore treats
  `assignment_id IS NULL` rows as out-of-funnel rather than assuming
  presence.
- `branch_id` is documented as "the chosen NUM/branch embedded in the
  URL" — i.e. a **whole-page** branch identifier, not per-slot.
  Per-slot served variants live in the `selected_variants` JSONB map.
  So `branch_id` is safe to carry in the rollup grain as a page-level
  variant key; per-slot analysis is explicitly out of V1 scope.

### 1.4 Data volume — table is currently EMPTY

`select count(*) from lp_events` → **0 rows** (no min/max `event_ts`).
The mss runtime is not yet posting batches to
`POST /v1/lp-events/batch` in volume. Consequences:

- A realistic-volume `EXPLAIN (ANALYZE, BUFFERS)` is **not meaningful
  today**; the P2 commit must re-run it once real data has accrued
  (canon DB gate is enforced at P2 implementation time, not P0).
- The **partial `lp_events` index decision is deferred to P2**: at
  zero/low volume the planner uses a trivial seq scan (§4), and the
  existing `lp_events_type_ts_idx` + partial `lp_events_assignment_idx`
  already cover the refresh access pattern. P2 should add the one
  candidate partial index (§4) **only if** the EXPLAIN on real volume
  shows the refresh seq-scanning a large table.

---

## 2. LOCKED: the GAds traffic predicate (biggest correctness risk)

A row is **paid GAds traffic** (eligible for the cost/CPA denominator)
iff:

```
assignment_key_type IN ('gclid', 'gbraid', 'wbraid')   -- Google click identifiers
  OR traffic_flags ? 'paid_google'                      -- runtime-tagged paid Google
```

…**and** it is not bot-suspected:

```
AND NOT COALESCE(traffic_flags ? 'bot_suspected', false)
```

### 2.1 Rationale per `assignment_key_type`

| key type | meaning | counts as paid GAds? |
|---|---|---|
| `gclid` | Google Ads click id | **yes** |
| `gbraid` | Google Ads click id (iOS/app, privacy-safe) | **yes** |
| `wbraid` | Google Ads click id (web, privacy-safe) | **yes** |
| `cookie` | fallback: returning-visitor cookie | **no** |
| `session` | fallback: in-session key | **no** |
| `default` | fallback: no identifier at all | **no** |

`cookie` / `session` / `default` are **not** Google-click-attributable.
Including them in the paid denominator would inflate CPA/CPC denominators
and silently understate cost-per-conversion. Per the binding constraint,
they are **excluded from cost / CPA** and the dashboard badges the view
**"GAds-detected traffic only."**

### 2.2 Truth table P2 MUST encode as a unit test

`isPaidGadsTraffic(assignment_key_type, traffic_flags)`:

| `assignment_key_type` | `traffic_flags` | expected |
|---|---|---|
| `gclid` | `null` | **true** |
| `gbraid` | `[]` | **true** |
| `wbraid` | `['paid_google']` | **true** |
| `gclid` | `['bot_suspected']` | **false** (bot exclusion wins) |
| `cookie` | `['paid_google']` | **true** (explicit paid_google tag) |
| `cookie` | `null` | **false** |
| `session` | `[]` | **false** |
| `default` | `null` | **false** |
| `null` | `['paid_google']` | **true** |
| `null` | `null` | **false** |
| `gclid` | `['paid_google','bot_suspected']` | **false** (bot exclusion wins) |

Notes:
- `bot_suspected` is an unconditional exclusion — it overrides both a
  gclid-family key and the `paid_google` flag.
- The `paid_google` flag is honoured even when the key type is a
  fallback, because the runtime may tag traffic it identified as paid
  Google by other signals; this is the only path by which a
  non-gclid-family row enters the paid denominator.

### 2.3 Funnel vs cost scope

- **Observed funnel counts** (impressions/redirects/assignments/
  conversions) are computed over **all** assignment-bearing rows so the
  operator still sees total landing-page behaviour.
- **Cost / CPA** are computed over the **paid-GAds subset only** (§2.1)
  and the view is badged accordingly. Revenue and ROAS render
  **"Unavailable"** (no fake numbers) — `lp_conversion` carries no
  order/revenue today; that is deferred to V2.

---

## 3. LOCKED: reporting timezone

`assignment_day` (and every UI date/hour bucket) is computed in
**`America/New_York`**, the Ads business zone. `lp_events.event_ts` is
stored in UTC; the rollup buckets via:

```sql
(event_ts AT TIME ZONE 'America/New_York')::date  AS assignment_day
```

This matches the repo-wide rule (root `AGENTS.md`: all aggregation AND
display in `America/New_York`) and the parent's "Ads business zone"
decision. The DST-disambiguation carve-out for UTC top-of-hour buckets
in `timeBuckets.ts` does **not** apply here: the GAds rollup is
**day-grain**, so NY-local day bucketing is unambiguous and correct.

---

## 4. EXPLAIN of the candidate refresh query

Run read-only against live (empty) prod on 2026-06-15. The candidate
bounded-90-day refresh aggregate:

```sql
EXPLAIN
WITH paid AS (
  SELECT e.assignment_id, e.site, e.cluster_slug, e.family,
         e.experiment_id, e.branch_id,
         (e.event_ts AT TIME ZONE 'America/New_York')::date AS assignment_day,
         e.event_type, e.event_ts
  FROM lp_events e
  WHERE e.assignment_id IS NOT NULL
    AND ( e.assignment_key_type IN ('gclid','gbraid','wbraid')
          OR e.traffic_flags ? 'paid_google' )
    AND NOT COALESCE(e.traffic_flags ? 'bot_suspected', false)
    AND e.event_ts >= now() - interval '90 days'
)
SELECT assignment_day, site, cluster_slug, family, experiment_id, branch_id,
       count(DISTINCT assignment_id) FILTER (WHERE event_type='lp_assignment')  AS assignments,
       count(DISTINCT assignment_id) FILTER (WHERE event_type='lp_impression')  AS impressions,
       count(DISTINCT assignment_id) FILTER (WHERE event_type='lp_redirect')    AS redirects,
       count(DISTINCT assignment_id) FILTER (WHERE event_type='lp_conversion')  AS conversions
FROM paid
GROUP BY 1,2,3,4,5,6;
```

Plan (empty table, so trivial):

```
GroupAggregate  (cost=13.17..13.22 rows=1 width=196)
  ->  Sort
        ->  Seq Scan on lp_events e  (cost=0.00..13.16 rows=1 width=228)
              Filter: (assignment_id IS NOT NULL)
                AND (NOT COALESCE((traffic_flags ? 'bot_suspected'), false))
                AND ((assignment_key_type = ANY ('{gclid,gbraid,wbraid}'))
                     OR (traffic_flags ? 'paid_google'))
                AND (event_ts >= (now() - '90 days'::interval))
```

The query is valid and the timezone cast / JSONB `?` operators behave.
**Index decision deferred to P2** (§1.4): the candidate index, if the
real-volume EXPLAIN shows a large seq scan, is a partial index covering
the funnel-bearing slice:

```sql
-- candidate, add in P2 ONLY if real-volume EXPLAIN proves it needed:
CREATE INDEX lp_events_gads_refresh_idx
  ON lp_events (event_ts)
  WHERE assignment_id IS NOT NULL;
```

(A `WHERE assignment_id IS NOT NULL` partial keeps it small, and the
`event_ts` leading column serves the 90-day horizon bound. Adding a
covering/expression index on the predicate is overkill at V1 volume.)

---

## 5. LOCKED: metric formulas

All counts are **assignment-level-unique** (`COUNT(DISTINCT
assignment_id) FILTER (...)`), never raw event counts — at-least-once
delivery plus the runtime re-sending interrupted batches means a single
funnel step can produce duplicate event rows even after `event_id`
dedupe across re-renders.

### 5.1 Funnel (per `assignment_day` × grain)

Grain: `(assignment_day, site, cluster_slug, family, experiment_id, branch_id)`.

- `impressions` = distinct assignments with an `lp_impression` event
- `redirects` = distinct assignments with an `lp_redirect` event
- `assignments` = distinct assignments with an `lp_assignment` event
- `conversions` = distinct assignments with an `lp_conversion` event

### 5.2 Conversion windows `conversions_7d / 30d / 90d`

A conversion counts toward window `Nd` for an assignment iff the
`lp_conversion` event_ts is within `N` days **after that assignment's
`assignment_day`** (assignment-time attribution, the V1 default).
Three **separate columns** are stored — a single aggregate cannot serve
multiple windows correctly. Default UI window is **30d**.

### 5.3 Right-censoring (immature cohorts)

An assignment-day cohort younger than the window is **right-censored**:
e.g. for `conversions_30d`, any `assignment_day` within the last 30 days
(NY) has not had its full 30-day window elapse. Such rows are **badged
"still maturing"** in the UI and excluded from rate comparisons; the raw
partial count is still shown but flagged. The rollup stores enough to
let the serving layer compute maturity = `today_ny − assignment_day ≥ N`.

### 5.4 Sample threshold

Variant rows with **< 25 assignments** are hidden behind a low-sample
toggle (parent constraint). The rollup retains them; the UI hides by
default and the endpoint flags them.

### 5.5 Allocated cost basis

V1 has **no per-click cost on `lp_events`**. Cost is **allocated** from
the existing aggregate GAds cost snapshot and **must sum back to the
snapshot total** per `(assignment_day, site, campaign-bucket)`.
Allocation weight = that grain's share of **paid-GAds assignments**
(§2.1) within its `(assignment_day, site, campaign-bucket)` parent.
Cost is always **badged "allocated"**; it is an estimate, not accounting.
Revenue / ROAS / CPA-from-revenue stay **"Unavailable."**

---

## 6. LOCKED: refresh cadence

**Every 60 minutes** (the slower end of the parent's 30–60 min range).
Rationale: V1 is "observed performance, not accounting"; landing-page
funnels move slowly and a 60-minute rollup keeps the refresh job's DB
cost minimal (aligns with the cheap-DB decree / epic #11). Cadence is a
one-line constant in the P2 job and trivially tightened later if the
operator wants fresher numbers.

---

## 7. Summary of decisions handed to P2 / P3

| Decision | Locked value |
|---|---|
| Paid predicate | `key ∈ {gclid,gbraid,wbraid} OR flag paid_google`, minus `bot_suspected` |
| Fallback keys (`cookie`/`session`/`default`) | excluded from cost/CPA; badged "GAds-detected traffic only" |
| Reporting timezone | `America/New_York`, day grain, `event_ts AT TIME ZONE` |
| Funnel counts | assignment-unique `COUNT(DISTINCT assignment_id) FILTER` |
| Conversion windows | 3 columns `conversions_7d/30d/90d`, assignment-time attribution, default 30d |
| Right-censoring | cohorts younger than window badged "still maturing" |
| Sample threshold | hide variant rows < 25 assignments behind a toggle |
| Cost | allocated from aggregate snapshot, sums back to total, badged "allocated" |
| Revenue / ROAS | "Unavailable" (no fake numbers) — deferred to V2 |
| Refresh cadence | 60 min |
| New `lp_events` index | deferred to P2; add candidate partial only if real-volume EXPLAIN proves needed |
| Rollup grain | `(assignment_day, site, cluster_slug, family, experiment_id, branch_id)` |
