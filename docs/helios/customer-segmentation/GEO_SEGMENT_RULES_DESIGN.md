# Geo / behavioural auto-segmentation rule engine — design / north star

> Goal: let the operator define **"when a customer does X near/within Y,
> with attributes Z, add them to Sweed segment S (and later, fire action
> A)"** rules from a phone, and have Helios apply them automatically —
> on-scan for cheap scan-time facts, and (phase 2) nightly for stateful
> "lapsed / returning / no purchase in N months" facts.
>
> Status: **phase 1 implemented** (composable on-scan predicate engine +
> mobile rule builder). Phases 2–4 are design only. Oracle-reviewed
> (schema/evaluator DB review + UI review — see the Agent Gate Record on
> the landing commit / issue).
>
> Companion docs:
> [`EPIC_PLAN.md`](./EPIC_PLAN.md) (segment **analytics** — the metrics
> side, separate epic) and [`../../sweed/marketing.md`](../../sweed/marketing.md)
> (segment RPCs). Code: `helios/src/worker/sweed/geoSegment.ts`,
> `helios/src/worker/jobs/geoSegmentRuleEvalJob.ts`,
> `helios/src/server/db/migrations/079_…`, `080_…`,
> `helios/src/client/routes/config/GeoSegmentRulesPage.tsx`.

---

## 1. Where we started (phase 0, already live)

The Bronx hyperlocal ask shipped as a **narrow, single-shape rule**:
"first scan (in ≥1yr) OR first non-Sweed-purchase, whose geocoded ID
home address is within 3750ft of the Bronx store, on/after 2026-05-21 →
add to Sweed segment 10282." That landed as:

- `geo_segment_rules` (migration 079) with **fixed columns**
  (center/radius/trigger/since/reactivation) + a
  `geo_segment_rule_applications` idempotency ledger.
- a one-shot backfill CLI (35 Bronx customers added live in Sweed), and
- an on-scan evaluator (`geoSegmentRuleEvalJob`) enqueued per scan when
  it both links to a Sweed customer and its address geocodes.
- a minimal CRUD page at `config/marketing/geo-segment-rules`.

That proved the mechanism but only expressed **one rule shape**. The
operator wants many shapes ("new customers from zips ABC/DEF", "first
scan ≥65", "checkins within Y of Z until date X") and, soon, behavioural
/ recency shapes and **actions on add**.

## 2. The model — a versioned predicate AST + pluggable actions

A rule is: **target** (where the membership lands) + **predicate AST**
(who qualifies) + **action** (what happens on add), evaluated in one of
two **modes**.

```diagram
╭──────────────────────── RULE ────────────────────────╮
│ target:    site · dealer · segment · trigger          │
│ predicate: AND( geofence, zip∈{…}, state∈{…},         │
│                 scan-window, first-scan-in-N-days,     │
│                 age-range, gender∈{…}, … )             │
│ action:    add-to-static-segment  (phase 1)           │
│            └▶ webhook · loyalty-points · … (phase 4)   │
╰───────────────────────────────────────────────────────╯
        │                              │
   scan_event mode               customer_snapshot mode
   (on-scan, cheap)              (nightly, stateful)
```

- **Predicate AST**: a versioned JSON object
  `{ version:1, op:"and", predicates:[ {kind,…}, … ] }` stored in
  `geo_segment_rules.predicate_json`. Phase 1 is a flat AND-list; OR /
  nested groups are a forward-compatible extension (bump `version` or add
  an `op:"or"` node) and deliberately deferred.
- **Source of truth = the AST.** The legacy 079 columns
  (`center_lat/lng`, `radius_feet`, `since`, `reactivation_days`) are
  kept **only** as deprecated mirrors for the existing geofence rules and
  the backfill CLI; new rule semantics live entirely in the AST. The 079
  Bronx rule was backfilled into an equivalent AST in migration 080.
- **Validation**: strict at the API boundary (zod discriminated union);
  shallow in the DB (`predicate_json` is an object, `version=1`,
  `op='and'`, `predicates` is a bounded array, enabled ⇒ non-empty). The
  evaluator re-parses with zod and **fails closed** (skips the rule, logs)
  on any malformed enabled rule rather than crashing a scan job.

### 2.1 Evaluation modes

| Mode | When it runs | Facts it can use | Examples |
|---|---|---|---|
| `scan_event` (**phase 1**) | per scan, on-scan-callback (enqueued, deduped) | geocoded ID home address (lat/lng, zip5, state), DOB→age, gender, scan time, person-key scan history | "new ≥65 within 3750ft of Bronx", "first scan from zips 104xx" |
| `customer_snapshot` (**phase 2**) | nightly + manual, chunked over a bounded customer-facts table | last purchase date, lifetime spend, visit count, loyalty points, borough, recency | "returning Queens customers, no purchase in 6mo", "lifetime spend > $X" |

Phase 1 evaluates **everything in Node** against a single indexed scan
read — SQL loads facts, never interprets the AST, so the AST is
single-sourced and unit-testable. Phase 2 needs precomputed facts
because per-page / per-scan recency math over raw `sweed_orders` would
violate the DB cost budget (canon `rules/DB_PERFORMANCE.md`).

### 2.2 Phase-1 scan-safe predicate kinds (implemented)

| kind | fields | fact source | fail-closed when |
|---|---|---|---|
| `geofence` | centerLat, centerLng, radiusFeet | geocoded `addresses.lat/lng` | no geocode |
| `zip5_in` | zip5[] | `addresses.zip5` ∥ raw scan postal | no zip |
| `us_state_in` | states[] (2-letter) | `addresses.state_code` ∥ raw scan state | no state |
| `scan_time_window` | since?, until? | scan event time | — (needs one bound) |
| `first_scan_in_days` | days | person-key scan history | no person_key |
| `age_range` | minAge?, maxAge? | scan `birth_date` at event time | no DOB |
| `gender_in` | genders[] (M/F/X) | scan `gender` (normalised) | unrecognised gender |

All predicates are **AND**ed; a missing fact makes its predicate false
(never accidentally site-wide). At most one predicate of each kind per
rule (enforced by zod).

## 3. Actions on add — north star (phase 4, design only)

Today the only action is "add once to a static Sweed segment", gated by
the application ledger. The forward model keeps the ledger as the
**at-most-once** spine and hangs actions off a successful first add:

```diagram
 rule matches ─▶ ledger claim (rule,customer) ─▶ Sweed segment.result.add
                          │                               │
                          ▼ (on first transition to applied)
                   actions[] fire once:
                     • webhook POST {customer, rule, segment, ts}
                     • loyalty points credit (needs a verified Sweed RPC — not yet found)
                     • (future) SMS/email enrol, tag, note
```

- Actions are an **ordered list on the rule** (`actions_json`), each
  `{kind, config}`, fired **once per (rule,customer)** keyed off the
  ledger's `pending→applied` transition (a new `…_rule_action_log`
  records per-action delivery + retry, mirroring the application ledger's
  idempotency discipline).
- Start with **webhook** (no external dependency to verify) as the
  reference action; loyalty-points is gated on finding/confirming a Sweed
  loyalty-credit RPC (none surfaced in Helios today — treat as research).
- Keep actions **side-effecting but bounded**: no action may re-enter the
  rule engine; failures are logged + retried with backoff, never block
  the segment add.

## 4. Surfaces & sequencing

### Phase 1 — DONE
- `geo_segment_rules.predicate_json` + migration 080 (backfill, relax
  NOT NULLs, drop the single-enabled-per-segment unique index, add
  shallow checks + non-unique lookup indexes).
- Composable predicate eval lib (`geoSegment.ts`) + unit tests.
- Evaluator reads the AST, loads one prior-scan fact when needed,
  evaluates in Node, tracks an in-memory per-customer segment set so two
  rules targeting the same segment don't double-add.
- **Mobile-first rule builder** on the existing config page: add/remove
  predicate cards, live human-readable rule summary, immutable target
  fields, live application tallies.

### Phase 2 — NEXT (customer_snapshot)
- Bounded `analytics_customer_facts` (last purchase, spend, visits,
  loyalty, borough, recency) refreshed incrementally on ingest — reuse
  the `EPIC_PLAN.md` daily-facts work where possible.
- Nightly + manual chunked evaluator; new predicate kinds: `borough_in`,
  `lapsed_days`, `lifetime_spend`, `visit_count`, `loyalty_points`,
  `is_returning`.
- Same builder, new predicate cards gated to snapshot-mode rules.

### Phase 3 — adjacent visibility (small, mostly independent)
- **Check-ins page**: show segment chips when scan details are expanded,
  from the **cached** `sweed_customer_segments` (migration 059), not live
  Sweed RPC. (Customer detail page already shows membership.)
- **Map page**: filter + highlight by segment, from the same cache.
- **Customer-value / segment metrics**: see `EPIC_PLAN.md` (separate
  epic, partially landed — margin basis already on the customer-value
  tab). Don't duplicate; converge there.

### Phase 4 — actions on add (§3).

## 5. Cost & safety guardrails (canon `rules/DB_PERFORMANCE.md`)

- `scan_event` stays enqueue-driven (no poller): 1 indexed scan read + 1
  tiny rules read + ≤1 prior-scan read; Sweed RPCs only on a real,
  not-yet-ledgered match.
- `geo_segment_rules` is a tiny config table; the dropped unique index is
  replaced by non-unique partial lookup indexes.
- Phase 2 must be chunked, bounded, and ride a precomputed facts table —
  never join raw orders per evaluation.
- The application ledger remains the at-most-once spine; **materially
  retargeting a rule = create a new rule** (old ledger rows suppress
  re-adds for the same rule/customer by design).
