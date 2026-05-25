# Catalog → Market Data: persisted FuzzySku records + catalog ↔ LitAlerts match review

Epic plan for issue
[#18](https://github.com/FreshlyBakedNYC/automation/issues/18).

## Motivation

We pull market evidence from LitAlerts (raw competitor listings) into
`litalerts_competitor_observations`. But we never persist the
parsed-and-matched form of those listings. Every pricing run
re-derives, from string heuristics, "this LitAlerts row should be
considered the same SKU as my catalog group G". Today that derivation
lives inline in
[`helios/src/worker/pricing/litAlertsMarket.ts`](../../../helios/src/worker/pricing/litAlertsMarket.ts):

- `brandMatchCache` + `listBrandsForState()` — string-normalize each
  candidate brand and try to align it with a LitAlerts brand id.
- `BRAND_MANUFACTURER_ALIASES` — hand-curated alias map.
- `GENERIC_SEARCH_WORDS` — stopword list that drops "vape", "flower",
  "preroll", etc. from comparison.
- `ProductComparableProfile`, `ParsedSizeProfile`,
  `PRICING_SEARCH_ADAPTATION_*` — per-product LLM-assisted search
  term adaptation each time pricing runs.
- `MIN_PRICING_ELIGIBLE_COMP_COUNT = 3` — silently drops products
  whose fuzzy match yielded too few competitor rows.

This is:

1. **Expensive** — every pricing run re-pays the parsing +
   LLM-adaptation + fuzzy-match cost for every product.
2. **Opaque** — when a product silently falls below
   `MIN_PRICING_ELIGIBLE_COMP_COUNT`, the operator has no surface to
   see why or to correct the underlying mapping.
3. **Not curatable** — there is no "no, that LitAlerts row is NOT my
   product, stop proposing it" verdict an operator can record. The
   next run re-proposes the same junk match.
4. **Not auditable** — there is no history of what the mapping
   *was* at the time of a given pricing decision.

The fix is to persist the parsed form of each LitAlerts row
(`fuzzy_skus`) and the human-curated verdict that links it to a
catalog entry (`catalog_market_matches`), then read those tables in
the pricing pipeline.

## Settled requirements (from the issue body)

1. Persisted, timestamped `fuzzy_skus` rows — one per LitAlerts
   listing-revision, carrying the raw input, the parser that
   produced it, the parsed/normalised brand/category/subcategory/size
   fields.
2. Persisted `catalog_market_matches` rows linking a catalog entry
   to a fuzzy SKU with a verdict in `{exact, brand_family, no_match}`
   plus actor + timestamp.
3. A deterministic scorer that, given a catalog entry, finds all
   `verdict ∈ {exact, brand_family}` matches and emits a confidence
   in `[0, 1]`. The same scorer ranks **unverdicted** candidates
   for human triage.
4. A reviewer UI under the existing Catalog area (working name
   "Catalog → Market Data") where a reviewer triages proposed
   matches and records verdicts.
5. Pricing runs read this table instead of re-fuzzying:
   - `exact` and `brand_family` rows feed the canonical pricing
     ladder.
   - `no_match` rows are blacklisted; the scorer must not re-propose
     them.

## Non-goals

- **Parser-config UX for LitAlerts is epic E**, not this one. This
  epic assumes parsers exist and can be referenced by id; the
  configuration surface for them is built elsewhere. We will
  hard-code a single default-parser id for v1 if epic E hasn't
  landed yet (see Open Questions §1).
- **Refreshing raw observations** is the prior
  [`market-data-sweep`](../market-data-sweep/) epic's job. This
  epic does not change refresh cadence, alarms, freshness chips, or
  the partner-API client. It consumes already-fresh
  `litalerts_competitor_observations`.
- **Rewriting the pricing math itself**
  ([`deterministicPricing.ts`](../../../helios/src/worker/pricing/deterministicPricing.ts),
  [`familyPricing.ts`](../../../helios/src/worker/pricing/familyPricing.ts))
  is out of scope. The pipeline still chooses the same lane / band /
  multiplier; we only change how it gets the *set of competitor rows
  to consider*.

## Data model

Two new tables, conventional `bigint generated always as identity`
primary keys, append-mostly write pattern.

### `fuzzy_skus`

One row per `(source_kind, source_listing_id, parser_id,
parser_rule_id, raw_input_hash)` tuple. Re-parsing the same listing
with a different parser produces a new row, never an in-place
update — we need the audit trail to know which parsing produced a
given verdict.

```sql
create table fuzzy_skus (
  id                bigint generated always as identity primary key,
  created_at        timestamptz not null default now(),

  -- provenance: where did the raw input come from?
  source_kind       text not null
                      check (source_kind in (
                        'litalerts_partner_product',     -- /v1/brands/{id}/products row
                        'litalerts_partner_retailer',    -- /v1/retailers/{id}/products row
                        'litalerts_competitor_observation', -- legacy on-the-fly observation
                        'manual'                         -- operator-entered, no source feed
                      )),
  source_listing_id text not null,            -- LitAlerts product id, observation id, etc.
  source_captured_at timestamptz,             -- when the upstream row was captured

  -- raw + parsed
  raw_input_jsonb   jsonb not null,            -- the upstream row, verbatim
  raw_input_hash    text not null,             -- sha256(canonicalize(raw_input_jsonb))
  parser_id         text not null,             -- references epic-E parser registry id
  parser_rule_id    text,                      -- optional sub-rule id within parser
  parser_version    text not null,             -- semver of the parser; new version = new row
  parsed_jsonb      jsonb not null,            -- full parsed output for debugging

  -- normalised fields (extracted out of parsed_jsonb for indexing/joining)
  brand_norm        text,
  category_norm     text,
  subcategory_norm  text,
  size_g_norm       numeric(10,4),             -- canonical grams, null if not weight-based
  size_mg_norm      numeric(10,2),             -- canonical mg active, null if not edibles/etc
  pack_count_norm   smallint,
  strain_norm       text,
  cannabinoid_jsonb jsonb,                     -- {"thc_mg": 5, "cbd_mg": 5, "ratio": "1:1"}

  unique (source_kind, source_listing_id, parser_id, parser_version, raw_input_hash)
);

create index fuzzy_skus_brand_idx        on fuzzy_skus (brand_norm);
create index fuzzy_skus_source_idx       on fuzzy_skus (source_kind, source_listing_id);
create index fuzzy_skus_brand_size_idx
  on fuzzy_skus (brand_norm, category_norm, size_g_norm)
  where brand_norm is not null and category_norm is not null;
```

Notes:

- We store `raw_input_jsonb` verbatim so that a later parser-version
  bump can re-parse historical input without re-fetching from
  LitAlerts.
- `raw_input_hash` lets us cheaply de-dupe identical raw rows that
  arrive from multiple feeds.
- `parser_version` is part of the uniqueness key so re-parsing with
  a new parser version produces a new row (and therefore can be
  individually verdicted in `catalog_market_matches`).
- The denormalised `brand_norm`/`size_*_norm` columns exist so the
  scorer doesn't have to crack `parsed_jsonb` on every comparison.
  They are populated by the parser and considered authoritative;
  changing them retroactively requires a parser-version bump.

### `catalog_market_matches`

One row per `(catalog_group_id, fuzzy_sku_id)` link. The catalog
side is keyed at the group level (where pricing decisions are made);
optional `catalog_product_id` records which underlying Sweed product
the reviewer was looking at when they recorded the verdict (useful
for audit / explanation, but the scorer treats it as group-level).

```sql
create table catalog_market_matches (
  id                       bigint generated always as identity primary key,
  catalog_group_id         bigint not null references catalog_groups(id),
  catalog_product_id       bigint,                   -- optional, for audit only
  fuzzy_sku_id             bigint not null references fuzzy_skus(id),

  verdict                  text not null
                            check (verdict in ('exact', 'brand_family', 'no_match')),
  verdict_set_at           timestamptz not null default now(),
  verdict_set_by_user_id   text not null,            -- helios actor id ('system' for scorer auto-promote)
  verdict_set_via          text not null
                            check (verdict_set_via in ('manual', 'bulk', 'imported', 'system_inferred')),

  -- confidence at the moment the verdict was recorded; lets us spot
  -- "the operator marked this exact when the scorer also thought it
  -- was 0.94 exact" vs "operator overrode the scorer at 0.10".
  confidence_at_verdict    numeric(4,3),             -- in [0, 1]

  notes                    text,
  superseded_by_id         bigint references catalog_market_matches(id),
  superseded_at            timestamptz,

  unique (catalog_group_id, fuzzy_sku_id) where superseded_by_id is null
);

create index catalog_market_matches_group_idx
  on catalog_market_matches (catalog_group_id)
  where superseded_by_id is null;

create index catalog_market_matches_fuzzy_idx
  on catalog_market_matches (fuzzy_sku_id)
  where superseded_by_id is null;

create index catalog_market_matches_verdict_idx
  on catalog_market_matches (catalog_group_id, verdict)
  where superseded_by_id is null;
```

Notes:

- Verdict edits are **not** in-place updates. A new row is inserted
  and the prior row's `superseded_by_id` / `superseded_at` are set,
  so we have a full history of who changed what verdict when.
- The partial-unique `(catalog_group_id, fuzzy_sku_id) where
  superseded_by_id is null` guarantees at most one *live* verdict per
  pair.
- `verdict_set_by_user_id = 'system'` + `verdict_set_via =
  'system_inferred'` lets the scorer auto-promote very-high-confidence
  matches without a human in the loop, while keeping them
  distinguishable in audits.

### Migration filename

`helios/src/server/db/migrations/026_catalog_market_matches.sql` —
forward-only, additive. Wire it into
[`helios/src/server/db/pendingMigrations.ts`](../../../helios/src/server/db/pendingMigrations.ts)
so an unmigrated prod env surfaces the banner instead of erroring at
first read.

## Deterministic confidence scorer

Given a catalog entry `C` and a fuzzy SKU `F`, the scorer emits a
confidence `s(C, F) ∈ [0, 1]`. Same formula for ranking unverdicted
triage candidates and for emitting per-evidence weights into the
pricing pipeline.

### Inputs

For each comparison the scorer uses, on the catalog side: brand,
category, subcategory, size_g, pack_count, strain (best-effort,
nullable), and any parsed cannabinoid profile. These come from the
existing catalog group/product fields plus
[`catalogMaintenance`](../../../helios/src/server/db/schema/catalogMaintenance.sql)
caches.

On the fuzzy-SKU side: the matching `*_norm` columns above.

### Formula (v1, deterministic)

```
s(C, F) = product of per-field factors, then floored at 0:

  brand_factor      = 1.00 if brand_norm == brand(C)
                    = 0.85 if brand alias-equivalent (BRAND_MANUFACTURER_ALIASES extracted into a table)
                    = 0.00 otherwise   →  zero score; brand mismatch is fatal

  category_factor   = 1.00 if category_norm == category(C)
                    = 0.70 if compatible (e.g. "edible" ↔ "gummy" via a small alias table)
                    = 0.00 otherwise   →  zero score; category mismatch is fatal

  subcat_factor     = 1.00 if subcategory match
                    = 0.90 if catalog subcategory null OR fuzzy subcategory null
                    = 0.70 if both present and different

  size_factor       = exp(-((Δ_size_g / max_size_g) ** 2) * 4)
                      where Δ_size_g = abs(size_g(C) - size_g_norm(F)),
                            max_size_g = max(size_g(C), size_g_norm(F)).
                      → 1.0 at exact match, ~0.6 at 25% deviation,
                        ~0.2 at 50% deviation, ~0 at 75%+.
                      mg-only items use the same formula on size_mg_norm.
                      If exactly one side has a size and the other doesn't:
                        size_factor = 0.50 (significant uncertainty penalty)

  pack_factor       = 1.00 if pack_count match
                    = 0.85 if catalog pack_count null
                    = 0.30 if both present and different (mostly fatal but
                            we leave it visible to the reviewer)

  strain_factor     = 1.00 if strain match
                    = 0.95 if either side null  (strain is most-often null)
                    = 0.70 if both present and different (informational)
```

Then we apply a verdict-shaped post-filter:

```
known = look up live (non-superseded) catalog_market_matches for (C, F)
if known.verdict == 'no_match':    return 0.0   (blacklisted, never re-propose)
if known.verdict == 'exact':       return max(s, 0.99)
if known.verdict == 'brand_family':return max(min(s, 0.85), 0.50)
                                   (clamp into the "useful but not a perfect SKU match" band)
otherwise (no verdict yet):        return s
```

This guarantees property (5) from the issue: `no_match` rows never
return to the reviewer queue, `exact` rows feed the canonical
pricing ladder with full weight, `brand_family` rows feed it at the
weight the lane expects.

The scorer is implemented once in
`helios/src/shared/marketMatch/confidence.ts` and consumed by:

- the triage page (rank unverdicted candidates),
- `enqueueMarketRefreshForProducts` (Phase 5 — pricing reads),
- background re-rank cron (Phase 6 — auto-promote runaways).

Pure-function design + property tests for monotonicity (better
agreement on any single field can never reduce the score) and for
the verdict post-filter.

## Reviewer UI: Catalog → Market Data

A new page under the existing Catalog area. Per
[`helios/AGENTS.md`](../../../helios/AGENTS.md), the page must put
the reviewer's primary action at the top and collapse all
methodology/explanation chrome behind `<details>` by default.

Default-visible chrome (tight):

- Sticky title bar with: brand filter, "has no exact match yet"
  filter, "has un-verdicted candidates above 0.7" filter, count of
  remaining catalog groups for the current filter.
- Primary table: one row per catalog group, ranked by "most
  promising un-verdicted candidate score, descending".

Per-row expanded view (toggled in-line, batch-keyboardable):

- Top of expanded panel: the catalog group's canonical name +
  size/pack chips.
- Three columns:
  - **Existing verdicts** — live (non-superseded)
    `catalog_market_matches` rows. Edit-in-place to flip a verdict
    (creates a new row, supersedes prior). Each row shows the
    fuzzy SKU's source URL, parser id/version, and the confidence
    at verdict-time.
  - **Un-verdicted candidates** — ranked by scorer; reviewer
    keyboard-shortcuts `e` (exact), `b` (brand_family), `n`
    (no_match), `s` (skip / leave un-verdicted). Each verdict
    POSTs to `/api/catalog/market-matches` and the row
    disappears from this column.
  - **Notes / debug** — collapsed by default. Shows the parsed
    JSON, parser id, why-this-was-proposed breakdown of the
    scorer factors.

Collapsed-by-default sections (one `<details>` each):

- About this page / scorer formula link.
- "Hidden by `no_match`" list (so a reviewer can un-blacklist
  something).
- "Same brand, different catalog groups" cross-reference (helps
  with brand-family decisions).

Routes & queries:

- `GET /catalog/market-matches` — server-rendered shell + initial
  JSON payload of the first page.
- `GET /api/catalog/market-matches?group=:id` — per-group panel
  hydration.
- `POST /api/catalog/market-matches` — record a verdict; body
  `{ catalog_group_id, fuzzy_sku_id, verdict, notes? }`. Inserts a
  new `catalog_market_matches` row and supersedes any prior live
  row for the pair. Returns the new row.
- `GET /api/catalog/market-matches/candidates?group=:id&limit=:n` —
  scored list of un-verdicted `fuzzy_skus` for the group.

## Pricing-run cutover

Phased cutover with a feature flag so we don't regress pricing
silently:

1. **Phase 5a — read-also.** `buildPricingMarketContext()` reads
   the new tables in parallel with the existing on-the-fly fuzzy
   match. For each catalog group, log a diff: which competitor rows
   are added vs removed vs reweighted by the persisted-verdict path.
   Pricing decisions still use the old path. Run for 2 weeks; surface
   the diffs on a `/diagnostics/pricing-match-diff` dashboard.
2. **Phase 5b — read-only (flagged).** Add `USE_PERSISTED_MARKET_MATCHES`
   per-tenant flag, default off. When on, pricing uses the persisted
   verdicts and ignores the on-the-fly heuristic entirely.
3. **Phase 5c — default on.** Flip the default, leave the override
   for emergency rollback.
4. **Phase 5d — delete legacy.** Remove `brandMatchCache`,
   `GENERIC_SEARCH_WORDS`, `BRAND_MANUFACTURER_ALIASES`,
   `ProductComparableProfile` and `PRICING_SEARCH_ADAPTATION_*` from
   [`litAlertsMarket.ts`](../../../helios/src/worker/pricing/litAlertsMarket.ts)
   once Phase 5c has been stable for a week.

## Phase plan (mirrored by `task-dag-breakdown.json`)

| Phase | Title | Depends on |
|-------|-------|------------|
| 1 | Schema migration: `fuzzy_skus` + `catalog_market_matches` (026_...) | — |
| 2 | Pure scorer + property tests (`shared/marketMatch/confidence.ts`) | 1 |
| 3 | Backfill worker: parse existing `litalerts_competitor_observations` into `fuzzy_skus` | 1 |
| 4 | Reviewer UI page + REST surface (`GET/POST /api/catalog/market-matches`) | 1, 2 |
| 5a | Pricing cutover Phase 5a — read-also + match-diff dashboard | 1, 2, 3 |
| 5b/c/d | Pricing cutover Phase 5b → 5d — flag, flip, delete legacy | 5a |
| 6 | Background re-rank cron: auto-promote ≥0.99 system-inferred 'exact' | 4 |
| 7 | Runbook + operator docs (`RUNBOOK.md` in this dir) | 4, 5b |

Phases 3 and 4 can run in parallel. Phase 5a *must* land before any
verdict is trusted in production pricing.

## Open questions

1. **Parser registry shape.** Epic E (LitAlerts parser-config UX) is
   the source of truth for `parser_id` / `parser_rule_id` /
   `parser_version`. If epic E hasn't landed when Phase 1 ships,
   we hard-code `parser_id = 'litalerts.partner.v1'` and
   `parser_version = '1.0.0'` (matching the existing inline parser
   in [`partnerClient.ts`](../../../helios/src/worker/litalerts/partnerClient.ts)
   today) and add a TODO referencing epic E.
2. **Brand/category alias tables.** The current
   `BRAND_MANUFACTURER_ALIASES` map is ~10 entries hand-edited in
   source. Migrating to a `brand_aliases` reference table is in
   scope of Phase 2 (the scorer needs to read it). Operator UX for
   adding new aliases is a Phase 4 follow-up; until then ops add
   rows by hand.
3. **Confidence-at-verdict back-compat.** We do not have historic
   confidence scores for any pre-existing manual matches. Phase 3's
   backfill recomputes the scorer against the parsed fuzzy SKU and
   stores that as `confidence_at_verdict` for imported rows;
   imported rows are stamped `verdict_set_via = 'imported'`.
4. **Catalog group identity drift.** `catalog_groups.id` is stable
   today, but if a future reconcile job ever merges two groups, the
   downstream `catalog_market_matches.catalog_group_id` references
   need to follow. We do *not* add `on update cascade` (Postgres
   doesn't reissue identity columns); instead the reconcile job
   gets an explicit step to remap `catalog_market_matches`. Captured
   as a Phase 7 runbook entry.
5. **Tenant scoping.** Verdicts are per-tenant (a verdict for tenant
   A's catalog group means nothing for tenant B's group). The schema
   above relies on `catalog_groups.id` already being tenant-scoped,
   which it is today via `catalog_groups.tenant_id`. We do **not**
   add a redundant `tenant_id` to `catalog_market_matches`; the join
   via `catalog_groups` is authoritative. Confirm with operator
   before Phase 4 implementation.

## What this epic does NOT change

- Raw observation refresh cadence, alarms, freshness chips,
  partner-API client — all owned by the prior `market-data-sweep`
  epic.
- The pricing math itself (lane / band / multiplier selection,
  `PRICING_POST_TAX_MULTIPLIER`, `PRICING_*_DISTANCE_*`).
- LitAlerts parser configuration UX — epic E.
- Anything Sweed-side (promo actions, screen carousels, etc.).
