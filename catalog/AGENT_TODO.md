Handoff Updated: 2026-05-12 (manifest-corrected re-apply pending; migrating to VPS3 amp instance)

Source thread: https://ampcode.com/threads/T-019e1a0f-75c6-71e3-ac6c-5e2133bb48bd
Predecessor (stuck) thread: T-019e191b-0112-72a2-9ab7-47374ebb434b

## Status

The 2026-05-11 combined pending-purchases packet had its first-round apply rolled back (bad LLM decoding of Stop 31 SKUs). A scanned 10FF Distribution manifest is now the source of truth for that order, parsed into [`purchases/2026-05-11/manifest_10ff.json`](./purchases/2026-05-11/manifest_10ff.json) and wired into the generator via [`purchases/2026-05-11/_legacy_patches.py`](./purchases/2026-05-11/_legacy_patches.py).

**Full assessment, file inventory, decisions on record, and VPS3 migration checklist** live in [`purchases/2026-05-11/HANDOFF.md`](./purchases/2026-05-11/HANDOFF.md). Read that before doing anything else in this directory.

## Snapshot of corrected state

- Bronx (N&M Farms, order 131642) catalog entries are live and correct — do **not** touch.
- Midtown / Stop 31 (order 131845) bad entries are disabled (41 products + 41 groups; see [`purchases/2026-05-11/disable_just_created_results.json`](./purchases/2026-05-11/disable_just_created_results.json)). Strains/effects/flavors created remain active per Dave.
- Manifest layer overrides 32 distributor SKUs with corrected brand/group/variant/pack-size; brand normalization updated for `Moonlit Hash Co` and `Preferred Gardens`.
- GM target override (67.5%) covers Herb + 8 sibling brands co-located on the Stop 31 order.
- Dutchie imagery is forbidden in any catalog write — apply path strips them; generator pre-filter still TODO.

## Immediate next steps (resumable on VPS3)

1. Regenerate packet: `python catalog/purchases/2026-05-11/generate_combined_pending_packet.py` (verify `manifest overrides: 32` in stdout).
2. Add Dutchie URL pre-filter in `build_rows_for_site` (generator side) and stamp `metrcTag` from `g._manifest_overrides` onto each row.
3. Review HTML in Firefox — confirm Stop 31 brands/variants match manifest, HERB Forbidden Fruit Infused 1g has no Dutchie image.
4. Apply Midtown corrections only (do not re-touch Bronx). Bad disabled rows stay disabled; new corrected groups/products get created.
5. Image quality pass (deferred). Page Dave on completion.

## VPS3 migration notes

Nothing in this packet is macbook-specific. Caveats:
- Playwright SIGTRAP workaround in `HOW_PLAYWRIGHT_WORKS.md` is nix-darwin-only; ignore on Linux.
- Re-provision Sweed bearer + Lit Alerts session secrets on VPS3.
- Mantle/LLM is only a parse fallback; manifest covers Stop 31 fully and the LLM cache covers other historical rows.

See [`purchases/2026-05-11/HANDOFF.md`](./purchases/2026-05-11/HANDOFF.md) for the full migration checklist.
