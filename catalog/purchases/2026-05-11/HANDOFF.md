# 2026-05-11 Pending-Purchases Packet — Handoff & Assessment

**Source thread:** https://ampcode.com/threads/T-019e1a0f-75c6-71e3-ac6c-5e2133bb48bd
**Predecessor (stuck) thread:** T-019e191b-0112-72a2-9ab7-47374ebb434b
**Author host:** Dave's macbook (nix-darwin). Migrating to **VPS3 amp instance** to continue.

This document is the authoritative state-of-the-world for the Stop 31 LLC (Midtown 210705, order 131845) + N&M Farms (Bronx 210249, order 131642) catalog mutation work. Read this **before** touching any files in `catalog/purchases/2026-05-11/`.

---

## TL;DR

1. We generated, applied, then **disabled** an entire round of bad catalog entries because the LLM-only decode of cryptic Stop 31 SKUs was wrong. The disabled rows are inert; do not re-enable.
2. A scanned PDF manifest from 10FF Distribution (`automation/catalog/10FF Distribution.pdf`) is now the source-of-truth for the Stop 31 / Midtown order. It is parsed into [`manifest_10ff.json`](./manifest_10ff.json).
3. The legacy parse-pipeline has been patched to consult the manifest *first*, then the LLM cache, then the legacy regex parsers (see [`_legacy_patches.py`](./_legacy_patches.py)). Brand normalization and the GM-target override map have been updated for the manifest's canonical brand spellings.
4. **Next action:** regenerate the combined packet with the manifest-aware pipeline, scrub Dutchie images, review, then re-apply *only* the corrected Midtown rows. Bronx side did not need correction; do not re-create those.

---

## What changed since the previous handoff

| Area | Before | Now |
| --- | --- | --- |
| Stop 31 SKU decoding | LLM-only guesses (43 rows; many wrong) | Manifest-first; LLM only as fallback for non-manifest names |
| Brand canonical names | `Moonlit` | `Moonlit Hash Co` (matches manifest) |
| Brands GM-targeted (67.5%) | Herb + 7 siblings | Herb + 8 siblings (added `Preferred Gardens`, renamed `Moonlit` → `Moonlit Hash Co`) |
| Created groups/products | Live in catalog as **Disabled** | Disabled remains; new corrected rows must be created fresh |
| Image policy | Some Dutchie URLs slipped into proposal HTML | Apply step strips Dutchie; generator still emits them — should be filtered earlier |

---

## Critical corrections from the scanned manifest

These are the SKUs whose original LLM decoding was **wrong** and have been overridden by [`manifest_10ff.json`](./manifest_10ff.json). Pricing in `wholesalePerUnit` is from the manifest itself.

| Distributor SKU | Was | Now (manifest) |
| --- | --- | --- |
| `1O-5PR-SB26-BLDR` | Herb Boulder 5x 1g | **Smartbud Blue Dream 5x 0.75g** (3.75g pack total) |
| `1O-5PR-SB26-PNCH` | Herb Punch | **Smartbud Purple Punch 5x 0.75g** |
| `1O-5PR-SB26-SCND` | Herb Sundae Driver | **Smartbud Sour Candy 5x 0.75g** |
| `1O-8F-DL26-BNRD` | Herb Bonkerz | **Doobie Labs Blue Nerdz 3.5g** |
| `1O-8F-P26-OISH` | (unparseable) | **Purps Oishii 3.5g** |
| `1O-8F-P26-RGB` | (unparseable) | **Purps Roy G Biv 3.5g** |
| `1O-8F-R26-TRP` | Tropicana | **Runtz Trump Runtz 3.5g** |
| `1O-PR32-H26-KNGL` | Herb King Louie OG 32x 0.5g | **Herb King Louie OG 32x 1g** (32g total) |
| `1O-PR-PG26-CKD` | Herb Cookie Dough | **Preferred Gardens Cookie Dough 1g** |
| `1O-PR-PG26-ZRZ` | Herb Zourz | **Preferred Gardens Zourz 1g** |
| `STRAIN GANG- Sour Diesel 2.5g 5pk preroll` | 5x 2.5g | **5x 0.5g** (manifest pack-total = 2.5g) |
| `SMARTBUD-applescotti Ground Flower 1/2oz` | Whole flower | **AppleScotti Shake 14g** (ground flower shake) |
| `SMARTBUD-candy-lato Ground Flower 1/2oz` | Whole flower | **CandyLato Shake 14g** (ground flower shake) |
| `MOONLIT-...` rows | brand `Moonlit` | brand **`Moonlit Hash Co`** |

Jungle Girl 5pks remain multi-cultivar assortments (no single strain); just sized as 5x 0.5g.

The HERB Forbidden Fruit Infused 1g row keeps its semantics but **must not** carry the Dutchie stock photo. Image scrubbing in apply confirmed this; generator still needs the same pre-filter so HTML never references it.

---

## Files & their roles

### Authoritative artifacts (trust without re-deriving)

- [`manifest_10ff.json`](./manifest_10ff.json) — canonical decoding for every Stop 31 line item, with METRC tags and per-unit wholesale.
- [`combined_apply_results.json`](./combined_apply_results.json) — record of the bad first-round apply (41 products + 41 groups created, 43 DP links).
- [`disable_just_created_results.json`](./disable_just_created_results.json) — record that the bad rows were disabled cleanly (0 errors).
- [`bronx_apply_results.json`](./bronx_apply_results.json) — Bronx side; **not** disabled, those entries remain valid.
- [`midtown_apply_results.json`](./midtown_apply_results.json) — Midtown subset of the bad apply; superseded by `disable_just_created_results.json`.

### Active code

- [`generate_combined_pending_packet.py`](./generate_combined_pending_packet.py) — combined packet generator. Wires the legacy 2026-04-13 generator with our patches.
- [`_legacy_patches.py`](./_legacy_patches.py) — runtime patches: manifest-first parse, LLM cache fallback, brand GM override, brand normalization. **Updated this thread** to add manifest layer + Preferred Gardens + canonical Moonlit Hash Co.
- [`apply_combined_proposal.py`](./apply_combined_proposal.py) — apply driver. Already strips Dutchie image URLs before catalog writes.
- [`disable_just_created.py`](./disable_just_created.py) — idempotent disable of products (`statusId=3`) and groups (`enabled=false`) listed in `combined_apply_results.json`.

### Historical / reference

- [`combined_pending_purchases_proposal.{html,json}`](./) — pre-manifest-correction packet. Do not re-apply from this; regenerate first.
- [`combined_pending_purchases_proposal_details/`](./combined_pending_purchases_proposal_details) — detail pages from the bad packet.
- [`cache/llm_parsed.json`](./cache/llm_parsed.json) — pre-warmed LLM parses. Now superseded for Stop 31 SKUs by the manifest, but still useful as fallback for unrecognized future names.
- [`apply.log`](./apply.log), [`gen.log`](./gen.log) — chronological build logs.
- [`_apply_packet_midtown.json`](./_apply_packet_midtown.json), [`_apply_packet_bronx.json`](./_apply_packet_bronx.json) — packet payloads handed to apply.

---

## Outstanding work (in order)

1. **Regenerate the combined packet** with the manifest patch active.
   ```
   python catalog/purchases/2026-05-11/generate_combined_pending_packet.py
   ```
   The patch already prints `[patches] manifest overrides: N; LLM cache entries available: M`. Verify N == 32 (number of `lineItems` in manifest_10ff.json).

2. **Pre-filter Dutchie imagery in the generator** (currently only the apply path strips them). Quickest fix: in `generate_combined_pending_packet.py`'s `build_rows_for_site`, after `g.build_row`, if `row["primaryImageUrl"]` matches `dutchie\.com|images\.dutchie\.com`, blank `primaryImageUrl/primaryImageHref` and add review flag `Image scrubbed (Dutchie source forbidden)`. The HERB Forbidden Fruit Infused 1g row is the canonical case to assert against.

3. **Stamp METRC tag onto rows** for reviewer visibility. The manifest entries already flow through `_manifest_to_legacy_shape` carrying `_metrcTag`. After `g.build_row` returns, copy that into a `metrcTag` field on the row so the detail page renderer can show it. (The legacy `parsed` dict is local to `build_row`; the simplest hook is to look the SKU up in `g._manifest_overrides` from the driver and copy `metrcTag` onto the row.)

4. **Review the new packet in Firefox** (do **not** auto-open Chrome). Sanity check:
   - Row count = 36 (Midtown) + 7 (Bronx) = 43.
   - Every Stop 31 row in the manifest has the corrected brand + variant tab.
   - HERB Forbidden Fruit Infused 1g shows no image (or a non-Dutchie image).
   - Stop 31 brands all priced to ~67.5% GM.

5. **Apply Midtown corrections only.** Bronx is already live and correct — do **not** re-run apply for Bronx. Easiest: filter `_apply_packet_midtown.json` from the regenerated proposal and run apply against just that. Disabled bad rows stay disabled; the apply will create fresh correct groups/products.

6. **Image quality pass** (deferred per Dave). After apply, sweep new groups for non-Dutchie quality images; do not regress on the Dutchie ban.

7. **Page Dave on completion.**

---

## Migrating the workflow to VPS3

The macbook is incidental host; nothing in this packet requires nix-darwin. Concrete migration checklist:

### Repo state
- The `automation/` repo carries everything needed. Commit-ready files modified this thread: `_legacy_patches.py`, `manifest_10ff.json`, `HANDOFF.md` (this file), and updates to `catalog/AGENT_TODO.md`.
- The legacy apply script `categories/2026-04-13/apply_pending_order_catalog_proposal.py` was patched in-place to allow blank image URLs. That patch needs to travel with the repo (verify in your commit).

### Secrets & credentials on VPS3
- Sweed RPC: `https://prime.sweedpos.com/api/`. Auth is bearer-token based; check the same `~amp-local/.secret/sweed/` (or whichever directory your local agent sourced) and re-provision an equivalent path on VPS3.
- Mantle/LLM access: only used for the **fallback** parse path. If VPS3 has no Mantle, the manifest covers Stop 31 fully and the LLM cache covers the rest of historical rows already. New unknown SKUs would degrade.
- TigerData / Lit Alerts: this packet does not write to either, but the legacy generator queries Lit Alerts during pricing; VPS3 needs the same Lit Alerts session secret (`~amp-local/.secret/litalerts/` on the macbook).

### Host-specific caveats that do **not** apply on VPS3
- The `HOW_PLAYWRIGHT_WORKS.md` SIGTRAP workaround is nix-darwin specific; VPS3 (Linux) can run Playwright natively. This packet doesn't use Playwright though.
- "Don't auto-open Chrome" was a macbook UX preference, not a constraint; on VPS3 there is no GUI, so packet HTMLs should be served via `python -m http.server` or copied for review.

### Verification on VPS3 before resuming apply
1. `python -c "import json; d=json.load(open('catalog/purchases/2026-05-11/manifest_10ff.json')); print(len(d['lineItems']))"` → expect 32.
2. `python catalog/purchases/2026-05-11/generate_combined_pending_packet.py` runs cleanly and prints `manifest overrides: 32`.
3. The generated `combined_pending_purchases_proposal.json` shows `targetBrand` matches the manifest for every Stop 31 SKU.

---

## Decisions on record (do not relitigate without Dave)

- Stop 31 + co-located brands price to **67.5% GM**; marketing discounts via promos. Codified in `BRAND_GM_TARGET_OVERRIDES` in `_legacy_patches.py`.
- **Dutchie images are forbidden** — must be scrubbed at both generator and apply layers.
- Strains, effects, flavors created during the bad first-round apply remain **active**. Only products and groups were disabled.
- Bronx (N&M Farms) catalog rows were correct; **do not** disable or recreate them.
- Smartbud `Ground Flower 1/2oz` items are explicitly modeled as `<Strain> Shake 14g` to distinguish from whole flower.
- Jungle Girl 5pks are assortments — no single strain.

---

## Risks / open questions

- METRC tag-to-Sweed-product wiring: this packet does not yet upload METRC tags as product attributes. If the ops team needs the tag baked into Sweed (vs. just visible in the reviewer packet), that's a follow-up.
- The 2 SKUs that were "exact-variant reuse" in the bad apply (43 rows → 41 created products) need to be re-evaluated against the manifest. They may now correctly match a different live variant or need a fresh creation.
- The HERB Forbidden Fruit Infused 1g image source is still the canonical proof case for the Dutchie filter; verify the new packet HTML when regenerated.
