# AGENT TODO

## Multi-Unit Variant Naming Cleanup

- Status: complete
- Larger goal: ensure every multi-unit Sweed variant in the `Freshly Baked NY` state catalog uses the canonical variant naming pattern `QTYx UNITSIZE`.

## Completed Work

- Read `../AGENTS_MUST_KNOW.md` and `../HOW_SWEED_WORKS.md` before continuing.
- Added [`fix_multiunit_variant_names.py`](file:///Users/dave/tmp/scratch/fbnyc/sweed/automation/multipack_naming/fix_multiunit_variant_names.py), a state-aware live fixer that:
- extracts auth from the current HAR,
- switches into dealer `210248` (`Freshly Baked NY`),
- pages the full state catalog with `store.product.list.short`,
- targets only the known live multi-unit mismatches,
- writes `tab`, `shortName`, and `name` through `store.product.edit`,
- verifies touched rows with `store.product.get`,
- polls the final full-catalog rescan until `store.product.list.short` catches up.
- Ran the live fix from the Freshly Baked NY state context.
- Refreshed the full live catalog snapshot in `all_products_live.json`.
- Wrote run details to `multiunit_variant_naming_fix_results.json`.

## Final Verification

- Final live state-catalog rescan returned:
- `3151` total variants
- `695` multi-unit variants (`packOfSize > 1`)
- `0` remaining naming mismatches against the canonical `QTYx UNITSIZE` rule
- The original live target set of 22 mismatches is now clean.

## Important Findings

- The old local files in this directory (`products.json`, `misnamed_data.jsonl`) were stale and should not be trusted for live catalog work; the fix used fresh live reads only.
- The broader naming rule is state-level and applies to all multi-unit product variants, not just pre-roll multipacks.
- On live writes, `store.product.edit` updated `tab` and `name` as intended, but some follow-up `store.product.get` payloads returned `shortName` normalized to the full product name even when a group-only short name was sent. The authoritative zero-mismatch verification for this task came from the full `store.product.list.short` rescan.

## Follow-Up

- Update complete.
- Page Dave that the task is done and verified.
