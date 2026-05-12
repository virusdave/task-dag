# Pending-Purchases Resume Runbook

**Audience:** any Amp agent (esp. on `vps-nixos-3.squaker-court.ts.net`) picking up
the recurring "produce pending purchases proposal" workflow on a host that did
**not** originate the work. Read this end-to-end before doing anything.

**Canonical specification of the workflow itself:**
[`docs/sweed/catalog/produce-pending-purchase-proposal.md`](../../docs/sweed/catalog/produce-pending-purchase-proposal.md).
This file is the **operational** companion: how to actually run it, what
in-flight state already exists, and what NOT to redo.

**Don't reconstruct from scratch.** Several rounds of work are already on
master. Find them first; build on top.

---

## 1. Orient first (5 minutes, no writes)

```sh
cd /path/to/automation
ls catalog/purchases/                  # one dir per packet date
cat catalog/AGENT_TODO.md              # short pointer to the in-flight packet
ls -la catalog/purchases/$(ls catalog/purchases/ | sort -r | head -1)/
```

The newest `catalog/purchases/<YYYY-MM-DD>/` directory is the most recently
generated packet. Inside it you may find:

- `combined_pending_purchases_proposal.{html,json}` — the reviewer packet.
- `combined_pending_purchases_proposal_details/` — per-row detail pages.
- `generate_combined_pending_packet.py` — the generator that produced it.
- `apply_combined_proposal.py` — the live-write driver.
- `_legacy_patches.py` — runtime patches that wedge a per-distributor manifest
  layer + LLM cache + brand GM-target overrides into the legacy
  `categories/2026-04-13/` generator (which is what actually does the heavy
  lifting). These patches are intentionally additive and explicit.
- `combined_apply_results.json` — record of what the apply created/linked.
- `disable_just_created.py` + `disable_just_created_results.json` — present
  when a bad apply round had to be rolled back.
- `manifest_*.json` — authoritative scanned-manifest decoding for any order
  whose distributor SKUs are too cryptic to trust to LLM-only parsing.
- `HANDOFF.md` — narrative state of that specific packet.

**Always read `HANDOFF.md` if it exists.** It captures decisions, rollbacks,
and "do not recreate" lists that the directory layout alone won't tell you.

---

## 2. In-flight state as of 2026-05-12

| Site / Order | Status | Action |
| --- | --- | --- |
| Bronx 131642 (N&M Farms) | **Live and correct.** 6 groups + 6 products + 7 DP links created via the 2026-05-11 apply. | **Do not** disable, recreate, or re-run apply for these. |
| Midtown 131845 (Stop 31 LLC / 10FF Distribution) | **Bad first-round apply rolled back.** 41 products (`statusId=3`) + 41 groups (`enabled=false`) disabled. Strains/effects/flavors created remain active. The scanned manifest at [`catalog/10FF Distribution.pdf`](../10FF%20Distribution.pdf) is now the source of truth, parsed into [`2026-05-11/manifest_10ff.json`](./2026-05-11/manifest_10ff.json). The manifest-first parse layer is wired into [`2026-05-11/_legacy_patches.py`](./2026-05-11/_legacy_patches.py). | **Regenerate the packet, scrub Dutchie images, review in Firefox, then re-apply Midtown only.** Disabled rows stay disabled; new corrected groups/products get created fresh. See section 5 below. |
| Any newer pending orders that have appeared since 2026-05-11 | Discover at runtime per section 4 below. | Roll into the same Midtown re-run if Midtown-side; new packet date if Bronx-side. |

---

## 3. Bootstrap the host (one-time per machine)

The 2026-05-11 packet's `HANDOFF.md` lists the secrets/HARs needed end-to-end;
this is the same checklist:

### 3.1 Sweed RPC

`AUTH_TOKEN` is **hardcoded** at
`bulk_additions/2026-04-10/generate_product_catalog_attribute_analysis.py:18`.
It rides in the repo (known security debt; no agenix path yet).

If the live API returns 401 / "unauthorized", the token has been rotated. To
refresh:

1. Capture a fresh HAR from `prime.sweedpos.com/api/` while authenticated as a
   FBNYC operator.
2. Find the `auth` field in any RPC body.
3. Overwrite the constant in `generate_product_catalog_attribute_analysis.py`
   (or any one of `dealer.set` / `auth.dealer.set` payloads in the HAR will
   show the same token).

### 3.2 LitAlerts

The legacy generator reads a saved request payload from
[`categories/2026-04-13/brands.litalerts.com_Products_menulistings_Archive [26-04-13 22-28-32].har`](../../categories/2026-04-13/brands.litalerts.com_Products_menulistings_Archive%20%5B26-04-13%2022-28-32%5D.har).
Treat the embedded session cookie as long-lived but rotatable: if LitAlerts
returns 401/403 mid-run, capture a fresh menu-listings HAR on the host and
drop it at the same path.

The supplementary HARs at [`catalog/brands.litalerts.com_Users_userhash_Archive [26-05-10 13-47-31].har`](../brands.litalerts.com_Users_userhash_Archive%20%5B26-05-10%2013-47-31%5D.har) and [`catalog/prime.sweedpos.com_api__Archive [26-05-10 13-05-21].har`](../prime.sweedpos.com_api__Archive%20%5B26-05-10%2013-05-21%5D.har) are useful as cross-references.

### 3.3 Mantle LLM (parser fallback only)

Read from `/Users/amp-local/.secret/bedrock/mantle-bearer-token` per
[`catalog/purchases/2026-05-11/llm_parser.py`](./2026-05-11/llm_parser.py#L41-L43).

On VPS3 this **must** exist as either:
- an agenix secret materialized to that exact path, or
- an agenix secret at a different path with `MANTLE_BEARER_PATH` patched in
  [`llm_parser.py`](./2026-05-11/llm_parser.py).

The Mantle path is **only** used for the LLM parser fallback when neither the
manifest nor the LLM cache resolves a distributor SKU. The manifest covers
Stop 31 fully; the cache (`catalog/purchases/2026-05-11/cache/llm_parsed.json`)
covers historical rows. So a missing Mantle bearer **degrades gracefully** but
blocks any *new* unknown-SKU resolution. Provision it before assuming you'll
get a clean run on a fresh queue.

Registry entry: `pending-purchase-taxonomy-classification` at
[`config/llm_use/registry.yaml`](../../config/llm_use/registry.yaml) lines 10-19.
If you broaden LLM use beyond the parser fallback (e.g., add the deferred
row-level LLM verdict from
[`docs/sweed/catalog/produce-pending-purchase-proposal.md`](../../docs/sweed/catalog/produce-pending-purchase-proposal.md)),
update that registry entry first.

### 3.4 Python deps

The legacy generator + apply use the standard library only (`urllib`, `json`,
`re`, `pathlib`). No `pip install` is needed for catalog work itself.

### 3.5 page-dave

`page-dave` is the operator handoff command. If it isn't on PATH on VPS3,
treat its absence as a hard requirement gap and surface it; do not silently
swallow completion notifications.

---

## 4. Discover what's pending right now

Always start by reading the live queue. The legacy generator already does
this; you can either invoke its collector directly or replicate the call:

```python
# python; with sweed_attr in scope from bulk_additions/2026-04-10/
sweed_attr.api_call("store.auth.dealer.set", {"dealerId": 210705})  # Midtown
queue = sweed_attr.api_call("store.purchase.order.list", {
    "orderStatusId": 2,  # pending
    "fromDate": "2026-04-01",
    "toDate":   "2026-12-31",
    "page": 1,
    "pageSize": 50,
})
# repeat for Bronx dealerId 210249
```

For each order, fetch positions and the suggestion stream:

- `store.purchase.order.get { id }`
- `store.distributor.product.suggestion { orderId }`

**Unresolved positions** are those with no `suggestedProduct` *or* mapped to a
known placeholder name (e.g. `Preroll Samples Samples`). These are exactly
what the packet needs to propose creates/links for.

**Cross-reference against the in-flight inventory above** before you generate
anything. If an order ID was already worked (Bronx 131642, Midtown 131845),
do NOT redo it from scratch — pick up where the matching packet directory
left off.

Dealer IDs:
- Midtown: `210705`
- Bronx:   `210249`
- State catalog dealer (used for catalog reads/writes): `210248`

---

## 5. Resume Midtown 131845 (the partially-correct order)

This is the canonical "almost fully but partly incorrectly mapped" case. The
HANDOFF in [`catalog/purchases/2026-05-11/HANDOFF.md`](./2026-05-11/HANDOFF.md)
has the per-SKU correction table. Operationally:

1. Verify manifest count:
   ```sh
   python -c "import json; print(len(json.load(open('catalog/purchases/2026-05-11/manifest_10ff.json'))['lineItems']))"
   # expect: 32
   ```

2. Regenerate the packet:
   ```sh
   python catalog/purchases/2026-05-11/generate_combined_pending_packet.py
   ```
   stdout must include:
   `[patches] manifest overrides: 32; LLM cache entries available: ...; brand GM overrides: [...]`

3. Add a Dutchie URL pre-filter in the generator's `build_rows_for_site` (still
   TODO from the 2026-05-11 round — only the apply path strips Dutchie). The
   canonical proof case is the row "Herb Forbidden Fruit Infused 1g"; the new
   HTML must show no Dutchie image for it. Suggested patch:
   ```python
   if row.get("primaryImageUrl") and "dutchie" in row["primaryImageUrl"]:
       row["primaryImageUrl"] = ""
       row["primaryImageHref"] = ""
       row.setdefault("reviewFlags", []).append(
           "Image scrubbed (Dutchie source forbidden)"
       )
   ```

4. Stamp METRC tags onto rows for reviewer visibility. The manifest entries
   already carry `_metrcTag` through `_manifest_to_legacy_shape`; the simplest
   wire is in `build_rows_for_site` after `g.build_row` returns:
   ```python
   item = g._manifest_overrides.get(group["distributorProductName"])
   if item:
       row["metrcTag"] = item.get("metrcTag")
   ```
   Render it next to the variant name in the detail page.

5. Review in Firefox. Do **not** auto-open Chrome. On VPS3 (no GUI) serve via
   `python -m http.server -d catalog/purchases/2026-05-11` and review from a
   workstation browser.

6. Re-apply **Midtown only.** Filter `_apply_packet_midtown.json` from the
   regenerated proposal and run apply against just that. Do **not** re-run for
   Bronx — those rows are already correct in production.

7. After apply completes, do the deferred image quality pass (no Dutchie).

8. `page-dave` and wait for explicit go-ahead before any further work.

---

## 6. Add new pending orders that appeared after 2026-05-11

If section 4's discovery shows orders not covered by any existing packet:

- If the new orders are **Midtown-side** and you're already regenerating the
  Stop 31 packet, fold them into the same generator run (they'll appear in
  the live queue when `collect_pending_groups()` is called for Midtown).
- If they're **Bronx-side**, copy the
  [`catalog/purchases/2026-05-11/`](./2026-05-11/) structure to a new dated
  directory (`catalog/purchases/<today>/`), edit `generate_combined_pending_packet.py`'s
  `OUTPUT_STEM` and any site-scoped overrides, then run the same way. Bronx
  brands inherit the **non-MSO 55-64.5% GM band** by default (no override).

The 2026-05-11 brand GM-target override at 67.5% is **specific to Stop 31 +
co-located brands** (Herb directive). Do **not** propagate it to other orders
unless Dave repeats the directive.

---

## 7. Decisions on record (do not relitigate)

These are operator decisions captured durably; respect them without asking
again unless Dave reopens them:

- **Pricing:** Stop 31 + co-located brands draft to 67.5% GM. Marketing
  discounts via promos. Affected brands today: Herb, Doobie Labs, Jungle Girl,
  Moonlit Hash Co, Preferred Gardens, Purps, Runtz, Smartbud, Strain Gang.
- **Imagery:** Dutchie-hosted/stock images are forbidden in any catalog write.
  Apply path strips them; generator pre-filter is the in-flight TODO above.
- **Bronx 131642:** correct in production; do NOT recreate or disable.
- **Smartbud `Ground Flower 1/2oz`:** model as `<Strain> Shake 14g` (ground
  flower shake), not whole flower.
- **Jungle Girl 5pks:** multi-cultivar assortments; no single strain field.
- **Brand canonical names:** `Moonlit Hash Co` (not `Moonlit`),
  `Preferred Gardens` (not folded into Herb), per the manifest.
- **Strains/effects/flavors created during the bad first apply remain active**
  even though their parent groups/products were disabled. Don't disable them.

---

## 8. Quality gates (per the canonical spec)

Per [`docs/sweed/catalog/produce-pending-purchase-proposal.md`](../../docs/sweed/catalog/produce-pending-purchase-proposal.md):

- **No silent failures.** Every Sweed read, LitAlerts query, image fetch, and
  LLM call either succeeds or `page-dave`s; nothing gets buried in a note.
- **Exact-product match preferred; brand-categorical-variant equivalence is
  the next acceptable tier.** Different pack counts / different brands are
  NOT equivalent.
- **Site-scoped reads** must `store.auth.dealer.set` and verify
  `currentDealerId` before further reads.
- **Catalog writes always run from state dealer 210248.**
- **Reviewer UI:** tree-nav sidebar, draggable proposed-price marker per row,
  click-to-new-tab to competitor storefront URL (not LitAlerts), Escape
  toggle. The 2026-05-11 generator is the canonical reference implementation.

---

## 9. When to stop and page

Stop and `page-dave` when:

- The packet is generated and ready for review.
- Apply completes (with the result counts).
- A blocker appears that needs operator judgment (e.g., new SKU pattern not in
  manifest/cache, ambiguous brand attribution, Sweed/LitAlerts/Mantle auth
  rotated and you need a fresh capture).
- Anything destructive looms: deleting/disabling rows that weren't created in
  this round, rolling back an apply, force-pushes.

Do NOT auto-open Chrome. Do NOT push commits without explicit instruction
(per `AGENTS.md` workspace rule). Do NOT silently swallow failures.
