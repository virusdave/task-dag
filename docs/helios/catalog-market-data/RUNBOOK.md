# Catalog → Market Data runbook

Operator-facing runbook for the issue #18 substrate
(`docs/helios/catalog-market-data/EPIC_PLAN.md`). Covers the
phases that are live today (1–4) plus the rollback / observation
steps you'll need when phases 5–6 start touching pricing reads.

## Quick links

- Reviewer UI: <https://helios.freshlybaked.us/catalog/market-data>
- Schema substrate:
  [`helios/src/server/db/schema/catalogMarketMatches.sql`](../../../helios/src/server/db/schema/catalogMarketMatches.sql)
- Migration:
  [`helios/src/server/db/migrations/026_catalog_market_matches.sql`](../../../helios/src/server/db/migrations/026_catalog_market_matches.sql)
- Scorer (pure fn):
  [`helios/src/shared/marketMatch/confidence.ts`](../../../helios/src/shared/marketMatch/confidence.ts)
- Queries:
  [`helios/src/server/db/queries/catalogMarketMatchQueries.ts`](../../../helios/src/server/db/queries/catalogMarketMatchQueries.ts)
- REST surface:
  [`helios/src/server/routes/catalogMarketMatches.ts`](../../../helios/src/server/routes/catalogMarketMatches.ts)
- Reviewer page:
  [`helios/src/client/routes/catalog/CatalogMarketDataPage.tsx`](../../../helios/src/client/routes/catalog/CatalogMarketDataPage.tsx)

## Applying migration 026 (already applied in prod)

If a fresh environment surfaces the pendingMigrations banner for
`026_catalog_market_matches`, apply it manually:

```sh
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
  -f helios/src/server/db/migrations/026_catalog_market_matches.sql
```

The migration uses `\i ../schema/catalogMarketMatches.sql`, so run
it from inside the `migrations/` directory or pre-flatten the
include. Both tables are `create … if not exists`; re-running is a
no-op.

Verify:

```sql
\dt fuzzy_skus catalog_market_matches
```

The sentinel in
[`pendingMigrations.ts`](../../../helios/src/server/db/pendingMigrations.ts)
checks `tableExists(db, 'fuzzy_skus') && tableExists(db, 'catalog_market_matches')`.
Once both exist, the all-pages banner clears within `CACHE_TTL_MS`
(30 s).

## Reading verdicts in production

```sql
-- Live (non-superseded) verdicts for a group:
select v.id, v.verdict, v.verdict_set_at, v.verdict_set_by_user_id,
       v.confidence_at_verdict, f.brand_norm, f.category_norm,
       f.raw_input_jsonb->>'listingName' as listing_name
  from catalog_market_matches v
  join fuzzy_skus f on f.id = v.fuzzy_sku_id
 where v.catalog_group_id = $1
   and v.superseded_by_id is null
 order by v.verdict_set_at desc;

-- Full history for a (group, fuzzy) pair:
select v.id, v.verdict, v.verdict_set_at, v.verdict_set_by_user_id,
       v.superseded_by_id, v.superseded_at, v.notes
  from catalog_market_matches v
 where v.catalog_group_id = $1
   and v.fuzzy_sku_id = $2
 order by v.id asc;

-- Verdict counts per verdict:
select verdict, count(*)::int
  from catalog_market_matches
 where superseded_by_id is null
 group by verdict
 order by count(*) desc;
```

## How lazy backfill works (today)

The full 40K-row backfill from
`litalerts_competitor_observations.evidence_json.matchedListings`
into `fuzzy_skus` is **not** run upfront. Instead,
[`loadGroupReview()`](../../../helios/src/server/db/queries/catalogMarketMatchQueries.ts)
calls
[`upsertFuzzySkusForObservation()`](../../../helios/src/server/db/queries/catalogMarketMatchQueries.ts)
the first time a reviewer expands a catalog group. The upsert is
idempotent via the `fuzzy_skus_source_kind_source_listing_id_parser_id_parser_v_key`
unique constraint, so multiple concurrent expansions race safely.

To pre-warm a known-hot group:

```sql
-- Trigger lazy parse by hitting the API once as a viewer:
curl -sSI -b "session=..." https://helios.freshlybaked.us/api/catalog/market-matches/<gid>
```

Or, when phase 6 lands, the rescore cron will pre-populate all
groups regardless.

## v1 caveat: brand-extraction quality

The inline listing-name parser
([`helios/src/shared/marketMatch/listingParse.ts`](../../../helios/src/shared/marketMatch/listingParse.ts))
is a tactical placeholder pending the issue-#19 runtime-adjustable
parser-config system. Brand extraction is weak:
`listing.brand` from the upstream payload is usually `null`, and
the listing-name parser doesn't yet have a brand-token rule.

To keep candidates from scoring 0 on brand mismatch alone,
[`loadGroupReview()`](../../../helios/src/server/db/queries/catalogMarketMatchQueries.ts)
applies a **heuristic brand-alias rescue**: when the fuzzy side has
no brand AND the catalog brand appears as a substring of the
listing name, it passes `brandAliasMatch: true` into
`scoreCatalogFuzzyFactors()`, granting the alias 0.85 brand factor
instead of 0.

Expect a step-change improvement in ranking quality the moment the
issue-#19 `litalerts-v1` dialect lands and the upstream listings get
parsed against per-competitor configs that actually extract brand.

## Recording / flipping a verdict via curl

```sh
# Insert a new live verdict (supersedes any prior live row for the pair):
curl -X POST https://helios.freshlybaked.us/api/catalog/market-matches \
     -H "Content-Type: application/json" \
     -b "session=..." \
     -d '{"catalogGroupId": 1234, "fuzzySkuId": 56789, "verdict": "exact", "confidenceAtVerdict": 0.91}'
```

A verdict POST is **always** an insert + supersede. Editing a
verdict is just another POST with a different `verdict` value for
the same `(catalogGroupId, fuzzySkuId)` pair.

## Per-tenant `USE_PERSISTED_MARKET_MATCHES` flag (phase 5b — not shipped yet)

Once phase 5b lands, you'll be able to flip the per-tenant boolean
`USE_PERSISTED_MARKET_MATCHES` (default off) to swap pricing reads
from the inline fuzzy-match path to the persisted
`catalog_market_matches` verdicts. Procedure (placeholder, will be
fleshed out when 5b ships):

1. Confirm `/diagnostics/pricing-match-diff` (phase 5a) shows zero
   un-explained disagreements between inline and persisted paths
   for the candidate tenant over the past 7 days.
2. Flip the flag in the tenant feature-flag surface.
3. Watch the next pricing run for that tenant. Compare proposed
   prices against the most recent inline-path run.
4. If unexpected: flip the flag back, file a follow-up against
   issue #18 phase 5 with the offending catalog group(s).

## Per-tenant rollback after phase 5c default-on flip (not shipped yet)

When phase 5c flips the default to on, the per-tenant override
still works as a kill switch:

```sql
-- Pseudo-code; real syntax depends on the feature-flag table
-- shape that lands in 5b:
update tenant_feature_flags
   set use_persisted_market_matches = false
 where tenant_id = '<tenant>';
```

…then page the on-call so phase-5 owner can root-cause before
re-enabling.

## Catalog-group reconcile interaction (open question 4)

When the catalog-group reconcile job merges or renames a group,
its `catalog_groups.id` may move. `catalog_market_matches.catalog_group_id`
is a hard FK with no ON UPDATE clause; the reconcile job MUST
remap matching rows in the same transaction as the merge.

This is currently un-implemented. Until phase 5+ wiring lands, the
risk is low because `catalog_market_matches` is read-only via the
reviewer UI and the inline pricing path doesn't touch it. The
moment phase 5b starts using the persisted verdicts for pricing,
the reconcile job needs to grow the remap step or pricing will
read stale verdicts.

## Page Dave when

- A migration banner appears for `026_catalog_market_matches` in
  prod and you can't reach the DB to apply it.
- Verdict POSTs start 500-ing (unique-constraint races usually
  recover; persistent 500s mean the partial-unique index is broken).
- Phase 5a `/diagnostics/pricing-match-diff` shows un-explained
  disagreements above a threshold to be set in 5b.
