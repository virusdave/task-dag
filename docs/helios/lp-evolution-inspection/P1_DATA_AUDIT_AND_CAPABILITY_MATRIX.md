# P1 — LP evolution: data audit + capability matrix (inference substrate)

> **Epic:** [FreshlyBakedNYC/automation#53](https://github.com/FreshlyBakedNYC/automation/issues/53)
> (Helios child of [`virusdave/top-level#25`](https://github.com/virusdave/top-level/issues/25),
> *lp-evolution-inspection*). Parent design doc is authoritative:
> `virusdave/top-level:docs/epics/lp-evolution-inspection/EPIC_PLAN.md`
> (§0.1 attribution-is-inference, §0.2 hill-climbable criteria, §7 LP
> Evolution, §8 LP Iteration).
>
> **Phase:** P1 (data audit + capability matrix).
> **Status:** complete — this doc is the P1 deliverable.
> **Closure criteria (from the child plan):** confirm prod
> population/scoping of `landingpage_ad_outcomes`, `gads_ad_attempts`,
> `gads_lp_rollup`, and L2/L3/morning-bundle artifacts; confirm
> candidate/rejected-candidate presence; **confirm the inference
> substrate** — per-entity policy state + hierarchy level + policy topic,
> **and** the entity→final-URL/LP and entity→family joins the correlation
> engine needs (there is no Google ad-vs-LP source field); produce the
> panel→capability matrix. No per-site page ships until site scoping is
> safe; the engine must have the LP/family join before claiming a suspect.
>
> Audit date: **2026-06-18** (NY). Read-only inspection of the prod
> Tiger Cloud DB (`tsdb`) + source read of the ads pipeline. **No schema
> change and no prod write was performed in P1** (those are P2+, gated on
> Oracle DB review + operator approval).

> **Sibling reuse — do not duplicate #24.** The site-scope policy
> (`site text null` derived via `mapGeoToGadsSite(pickGeoTarget(...))`,
> server-derived predicate, unknown-scope hidden per-site / shown under
> `gads-all` badged) was decided and **already applied in prod** by the
> #24 child epic ([automation#51](https://github.com/FreshlyBakedNYC/automation/issues/51)):
> [`docs/helios/gads-evolver-introspection/P1_DATA_AUDIT_AND_SITE_SCOPE.md`](../gads-evolver-introspection/P1_DATA_AUDIT_AND_SITE_SCOPE.md).
> This audit confirms that policy is live (see §1) and **reuses it
> verbatim**; it does not re-decide scoping. #25 owns the LP +
> joint-decision **inference** questions #24's audit did not cover.

---

## 0. TL;DR — what the LP correlation engine can and cannot stand on

1. **The site-scope substrate is already shipped and live.** Migration
   `093_gads_evolver_site_scope` **has been applied in prod**:
   `gads_ad_attempts.site` and `landingpage_ad_outcomes.site` both exist
   and are populated (counts in §1). Per-site pages are therefore safe to
   ship with the existing server-derived `site = $key` predicate; #25
   adds **no new** scoping mechanism.
2. **The entity→LP join is strong.** `gads_ad_attempts.before_final_url`
   is populated on **540/540** rows and parses cleanly into the Helios LP
   slug + borough (e.g. `/bronx/branding/herb/0`,
   `/midtown/compare/<sku>/0`), with **multiple ads per LP** — exactly the
   contrast the correlation engine needs (e.g. 11 ads on
   `/bronx/branding/herb/0`). **The engine has its LP join.**
3. **Per-entity policy STATE over time is strong (ad-level).**
   `before_policy_status` / `outcome_policy_status` +
   `before_serving_status` capture the disapproved→limited→eligible
   transitions per ad across runs (§1). This is the spine of the
   correlation signal.
4. **The policy TOPIC dimension is NOT in the DB.** `gads_ad_attempts`
   has **no** topic column, and `landingpage_ad_outcomes.policy_topics`
   is **empty (0/63)** in prod. Topics exist only inside the
   helios-owned filesystem snapshots (extracted by `extractPolicyTopics`
   in `buildSnapshotFromCsv.ts`). **V1 must run the correlation on policy
   STATE + LP/family contrast and badge the topic dimension as
   `not wired` (DB) / FS-only**, not pretend a topic field exists.
5. **No Google ad-vs-LP source field exists, as designed.** The contract
   correctly omits any `explicitPolicySource` flag. Note there **is** a
   Helios-internal *landing-page-suspicion* heuristic in L1
   (`landing_page_health` / `landing_page_issue_confidence`,
   URL-blocked-vs-creative-blocked) surfaced into L2 — that is **our own
   prior, not ground truth**; the engine may cross-check against it but
   must not present it as Google's verdict.
6. **Rejected candidates are NOT recorded anywhere.** The L2 output
   persists only the *chosen* creative (`suggested_new_creatives[0]`);
   there is no record of LLM candidates that were rejected. The P5
   slop-vs-signal *chosen-vs-rejected* comparison must render an honest
   "rejected candidates not recorded" empty state.
7. **No LP text snapshot exists** and V1 does not crawl. LP-promise match
   is therefore an **unwired (badged)** panel.
8. **The LP-funnel rollup is empty.** `gads_lp_rollup` = **0 rows**,
   `lp_events` = **0 rows** in prod. The funnel guardrail (parent §7
   panel 8) ships as an **honest empty state**, not a fabricated funnel.
9. **The feed is a static historical window.** No `gads_ad_attempts` row
   inserted since **2026-05-31** (~18 days before audit); all 219
   open attempts are stale-open. (Already flagged by #51; restated here
   because every #25 panel must render honest stale/empty states rather
   than imply a live loop.)

**Net:** the correlation engine **has** the two things it is gated on —
the entity→final-URL/LP join and per-entity policy state — so it may
claim suspects. It must do so **without** a DB policy-topic field, with a
*creative*-family (not page-family) `family_key`, with chosen-only
candidate text, and over a static data window — every one of which
becomes a UI capability badge, never guessed data.

---

## 1. Prod population audit (read-only, 2026-06-18)

| Table | Rows | Site col? | Populated? | Notes |
|---|---|---|---|---|
| `gads_ad_attempts` | **540** (120 ad_ids, 7 runs) | **yes (live)** | yes | static window 2026-05-23 → 2026-05-31 |
| `landingpage_ad_outcomes` | **63** (24 LPs, 24 final_urls, 5 campaigns) | **yes (live)** | yes | single ingest 2026-05-31 12:32Z |
| `gads_lp_rollup` | **0** | n/a | **empty** | owned by #18; `lp_events` also 0 → cross-link only |

**Site distribution (mig 093 applied + backfilled in prod):**

- `gads_ad_attempts`: midtown 291, bronx 187, **null (unknown-scope) 62**
  (the single cross-site `Trials 2026-05-16` campaign — correctly
  excluded from per-site pages, shown only under `gads-all`).
- `landingpage_ad_outcomes`: midtown 43, bronx 16, **null 4**.

**`gads_ad_attempts` policy/serving state (the correlation spine):**

- `before_policy_status`: disapproved **296**, approved_limited **207**,
  approved **37**.
- `outcome_policy_status`: *unobserved/null* **219**, approved_limited
  172, disapproved 128, approved 21.
- `before_serving_status`: not_eligible 296, eligible_limited 207,
  eligible 37.
- `family_key`: non-empty on **540/540** (`{account_id, creative_theme,
  product_tag}`; `account_id` uniformly `'unknown'`).
- `before_final_url`: populated on **540/540**.

**`landingpage_ad_outcomes` content:**

- `signal_type × planned_action × outcome_status`:
  `creative_repair_candidate / edit_disapproved_in_place /
  pending_import` = 43; `policy_suspect_landing_page /
  evolve_landing_page / pending_observation` = 20.
- `policy_status` present on 63/63; **`policy_topics` empty on 63/63**;
  `ad_id` on 43/63; **`campaign_id`/`ad_group_id` NULL on 63/63**
  (only the *names* are present — no hierarchy-level IDs).
- `before_creative` / `after_creative` present on 63/63.

**Filesystem artifacts (morning bundle / L2 / L3):** owned `helios:helios`
mode `700` under `$AUTOMATION_REPO_PATH/ads/google/outputs/` (prod
`AUTOMATION_REPO_PATH=/var/lib/helios/automation`), **not readable by the
audit user** (`amp-local`) — confirmed unreadable again this audit. Their
presence is confirmed **by inference**: the 7 `run_id`s only exist
because the morning bundle + L2 JSON were produced and
[`recordAttemptsFromL2Output`](../../../helios/src/server/ads/adAttemptsTracker.ts)
inserted from them. The P3/P6 endpoints run **as `helios`** and will have
read access; no privilege escalation is needed (matches #51 §1).

---

## 2. Inference substrate — the #25-specific confirmation

The parent (§0.1) is explicit: **Google gives no ad-vs-LP cause field**;
attribution is *inferred* by correlating per-entity policy state over the
shared final-URL/LP and page-family dimensions. P1's job is to confirm
the engine actually has those inputs.

### 2.1 Entity → final-URL / LP join — **CONFIRMED (strong)**

`gads_ad_attempts.before_final_url` (540/540) parses into the canonical
Helios LP slug `(/<borough>/<kind>/<key>/<n>)`. The join gives genuine
*contrast*: many ads share an LP, and an LP's ads can span sites in the
data (e.g. a `/bronx/compare/<sku>/0` URL carried attempts derived as
both bronx and midtown by the campaign-name heuristic — a real
URL-path-vs-campaign-name discrepancy the engine/UI should surface, not
silently reconcile). `landingpage_ad_outcomes` independently carries
`final_url` + `landing_page_key` for 24 LPs. **This is the join the
engine was gated on; it is present.**

### 2.2 Entity → page-family join — **PARTIAL (derivable, badge it)**

There is no first-class *page-family* key on the attempt rows.
`family_key` is a **creative** family (`creative_theme` ∈
{core, general, brand, …} × `product_tag` ∈ {general, flower, …}),
populated 540/540 but `account_id`-blind (`'unknown'`). The **page**
family for an LP must be derived in the engine from either (a) the LP
slug structure (`/branding/<brand>` vs `/compare/<sku>` etc.) or (b) the
strategic-cluster registry
([`ads/google/config/strategic-clusters.yaml`](../../../ads/google/config/strategic-clusters.yaml),
which maps clusters→`proposed_landing_page_slug`). `cluster_slug` exists
as a column on `gads_lp_rollup`, but that table is empty. **V1 should
derive page-family from the LP slug (cheap, in-DB) and badge
`familyMapping` as derived/partial**, with the cluster registry as an
optional FS enrichment.

### 2.3 Per-entity policy STATE over time — **CONFIRMED (ad-level)**

`before_*` / `outcome_*` policy & serving status across the 7 runs is the
spine (counts in §1). **Caveat:** this is **ad-level** only. Google's
"which hierarchy level was limited" (campaign / asset group / ad group /
asset / ad) is **not** separately stored — the attempt row knows the
campaign/ad-group *names* but not which level the limit fired at.
`hierarchyLevel` is therefore **partial**: V1 correlates at ad↔LP grain
and treats level as name-context only.

### 2.4 Policy TOPIC — **NOT WIRED in DB (FS-only)**

The most important gap. Google's *other* signal (the policy topic that
fired) is **absent from the DB**: no column on `gads_ad_attempts`;
`landingpage_ad_outcomes.policy_topics` empty (0/63). Topics are
extracted from the CSV into the **snapshot JSONL** on disk
(`extractPolicyTopics`,
[`buildSnapshotFromCsv.ts`](../../../helios/src/server/ads/buildSnapshotFromCsv.ts))
but never persisted to a table the read path queries. **V1 correlation
runs on policy STATE + LP/family contrast without the topic dimension**,
and badges `policyTopics` as `not wired (DB)`. Wiring topics into the
attempt/outcome write path (or reading them from the helios-owned
snapshots at serve time) is a tracked follow-up, not a P1 blocker.

### 2.5 Candidate copy & rejected candidates — chosen-only

- **Chosen creative: present (partial).** `proposed_headlines` /
  `proposed_descriptions` (+ `before_*`) store the chosen creative, but
  only `suggested_new_creatives[0]`; `repair` actions may instead be a
  before/after substring swap inside `proposed_changes_json`.
  `candidateText` = **partial**.
- **Rejected candidates: absent.** The L2 output records only the chosen
  output ([`schemas.ts` `SuggestedCreative`](../../../ads/google/lib/shared/schemas.ts),
  [`llm-predictor.ts`](../../../ads/google/lib/l2/llm-predictor.ts)); no
  rejected LLM candidate is persisted in the JSON or the DB.
  `rejectedCandidates` = **not wired**. P5's chosen-vs-rejected view ships
  an honest "rejected candidates not recorded" empty state.

### 2.6 LP text snapshot — **NOT WIRED** (no crawl in V1)

No raw LP copy/promise text is captured anywhere; L2 only carries an L1
*landing-page-suspicion* confidence (Helios heuristic, §0.5 above), not
page text. `lpTextSnapshot` = **not wired**; the LP-promise-match lens
(P5) is badged unwired. V1 does **not** crawl live pages.

---

## 3. Panel → capability matrix (parent §7–§8)

Legend: ✅ wired · ◑ partially wired (badge it) · ⛔ not wired yet
(honest empty state). Capability flags map to the P3 `capabilities`
contract.

### LP Evolution overview + `?panel=attribution` / `?panel=slop-signal` (§7)

| # | Panel (parent §7) | Status | Backing data / capability flags | Notes |
|---|---|---|---|---|
| 1 | Scope / freshness / capability strip | ✅ | `site` (live), `refreshed_at`/`max(created_at)`, all flags | static-window + stale badge mandatory |
| 2 | Hero — LP hill-climb heartbeat | ◑ | `gads_ad_attempts` action yield | yield computable; "live loop" must read stale |
| 3 | "What are we fixing?" KPI strip | ✅ | `before_policy_status`, `landingpage_ad_outcomes.signal_type` | disapproved/limited counts solid |
| 4 | Disapproval attribution snapshot | ◑ | `entityLpJoin` ✅, `entityPolicyState` ✅, `familyMapping` ◑, `policyTopics` ⛔ | verdicts from STATE+LP/family contrast; topic dim badged absent |
| 5 | Slop-vs-signal snapshot | ◑ | `candidateText` ◑ | deterministic lens on chosen vs before; no rejected |
| 6 | Planned-action × outcome matrix | ✅ | `action_type` × `outcome` (+`landingpage_ad_outcomes`) | well-populated |
| 7 | Hotspots — wrong-lever / grinding | ✅ | `fetchStuckAdIds`-style rollup over attempts, by site/family/LP | watchdog logic already exists |
| 8 | Guardrail — right clicks/interactions | ⛔ | `lpRollup` (empty) | honest empty state; `gads_lp_rollup`=0 / `lp_events`=0 |
| 9 | Recent decision log | ✅ | recent `gads_ad_attempts` rows | Problem→Attribution→Action→Outcome |
| 7.2 | Attribution detail (centerpiece) | ◑ | `entityLpJoin` ✅ + `entityPolicyState` ✅ gate the verdict; `familyMapping` ◑, `policyTopics` ⛔ | implicated-vs-clean contrast counts + anti-coincidence guard; `undetermined` is a real answer |
| 7.2.1 | Suspect LP / suspect family list | ◑ | same as 7.2 | page-family derived from LP slug; badge derived |
| 7.2.2 | Criteria transparency / hill-climb | ✅ (design) | n/a (engine internal) | criteria = one named versioned set; verdict records version + raw inputs |
| 7.3 | Slop-vs-signal detail | ◑ | `candidateText` ◑, `rejectedCandidates` ⛔, `lpTextSnapshot` ⛔ | deterministic token/generic/hook lens; chosen-vs-rejected + LP-promise badged unwired |

### LP Iteration page (§8)

| Panel (parent §8) | Status | Backing data | Notes |
|---|---|---|---|
| Run timeline (bounded ≤25/90d) | ✅ | `run_id` grouping over `gads_ad_attempts` | candidate-count / rejected-present / outcomes-pending badges |
| Run detail — decision flow | ◑ | per-run attempt rows | Signal→Attribution→Candidate→Action→Outcome; topic step badged |
| Attempt/candidate table | ◑ | attempt rows (+ `landingpage_ad_outcomes`) | chosen copy ✅, rejected ⛔, policy evidence (state ✅ / topic ⛔) |
| Candidate detail drawer | ◑ | `proposed_*`/`before_*`/`proposed_changes_json` | LP snippet ⛔, rejected ⛔ — badged |
| Bounded artifact links | ◑ | FS bundle/L2/CSV/L3 (helios-readable) | DB-only fallback + badge when JSON missing |

---

## 4. Capability-flag verdicts (P3 `capabilities` contract)

| Flag | Verdict | Basis |
|---|---|---|
| `siteScopedAttempts` | ✅ wired | mig 093 applied + backfilled in prod; write path sets `site` |
| `entityPolicyState` | ✅ wired (ad-level) | before/after policy+serving status, 540 rows, 7 runs |
| `policyTopics` | ⛔ not wired (DB) | no column on attempts; `landingpage_ad_outcomes.policy_topics` empty; FS-only |
| `entityLpJoin` | ✅ wired | `before_final_url` 540/540 → LP slug; multi-ad-per-LP contrast |
| `familyMapping` | ◑ partial | `family_key`=creative family; page-family derived from LP slug / cluster registry (FS) |
| `candidateText` | ◑ partial | chosen `suggested_new_creatives[0]` / changes blob only |
| `rejectedCandidates` | ⛔ not wired | L2 output records chosen only |
| `lpTextSnapshot` | ⛔ not wired | no snapshot; no V1 crawl (L1 suspicion heuristic ≠ text) |
| `lpRollup` | ⛔ not wired (empty) | `gads_lp_rollup`=0, `lp_events`=0 |

There is **no** `explicitPolicySource` flag (by design — §0.1).

---

## 5. Carried into P2/P3 (binding for downstream phases)

1. **P2 needs no new scoping migration** — `site` is already live on both
   tables. P2's only *possible* DB work is a tiny artifact/run-index table
   **iff** P3 proves FS run scans are expensive (they are bounded ≤25
   runs; likely not), and cheap indexes only if a plan justifies them on
   these sub-thousand-row tables (it currently does not — see #51 §4). Any
   migration stays gated on Oracle DB review + operator approval; nothing
   auto-applies on deploy.
2. **P3 correlation engine** runs on `entityLpJoin` + `entityPolicyState`
   (both ✅) with `familyMapping` derived from the LP slug. It must:
   emit `lp_related` / `ad_related` / `mixed` / `undetermined` with
   implicated-vs-clean contrast counts + an anti-coincidence guard;
   **never force a verdict** (`undetermined` is real); record the
   **criteria version + raw inputs** per verdict and carry the active
   `attributionCriteriaVersion` in the response (no magic numbers in
   code); and **badge `policyTopics`/`rejectedCandidates`/`lpTextSnapshot`/
   `lpRollup` as unwired** rather than guessing.
3. **IA gap for P3/P4/P6:** `GadsSubPage`
   ([`gadsSites.ts`](../../../helios/src/shared/domain/gadsSites.ts))
   currently defines `evolution`/`iteration` (for #24) but **not**
   `lp-evolution`/`lp-iteration`. Those slugs must be added to the enum +
   `GADS_RESERVED_SUBPAGES` (and the route validator) so they 404 cleanly
   today and render once shipped. Reuse `requiredGadsGrants()` verbatim —
   no new access model.
4. **Honest states everywhere:** static-since-2026-05-31 window,
   empty `gads_lp_rollup`, absent topics/rejected/LP-text are all UI
   **badges**, not fabricated data.

---

## 6. P1 closure

- [x] Confirmed prod population of `landingpage_ad_outcomes` (63),
      `gads_ad_attempts` (540), `gads_lp_rollup` (0/empty), and (by
      inference, helios-owned) the morning-bundle/L2/L3 FS artifacts.
- [x] Confirmed site scoping is **already live** (mig 093 applied) and
      reused verbatim from #51 — no new scoping work for #25.
- [x] Confirmed the **inference substrate**: entity→final-URL/LP join ✅
      and per-entity policy state ✅ (the two gates) are present; page-family
      is derivable (◑); **policy topic is not in the DB (⛔)** and hierarchy
      level is name-only (◑).
- [x] Confirmed **candidate copy is chosen-only (◑)** and **rejected
      candidates are not recorded (⛔)**; **no LP text snapshot (⛔)**.
- [x] Produced the **panel→capability matrix** (§3) and capability-flag
      verdicts (§4) for the P3 contract.
- [x] Restated the static/stale feed and empty-rollup operational notes
      so every panel renders honest states.

**Next:** P2 (confirm no migration needed beyond the live `site` column;
record query plans before any index) → P3 (typed contracts + correlation
engine with versioned criteria + capability flags). No deploy from this
phase; `self-deploy-helios` is gated to a later phase after Oracle UI/DB
review + operator approval.
