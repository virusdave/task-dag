# Sweed Catalog Creation And Editing

Load this when creating or editing catalog rows, product groups, variants, distributor products, or related dictionary lookups.

Source: `HOW_SWEED_WORKS.md`

## Brand Dictionary APIs

From live state-level reads and writes on 2026-04-11:

- `store.product.brand.list { page, pageSize }` returned the brand dictionary
- `store.product.brand.add { name }` created a missing brand row successfully for `Stash Queens`
- practical implication: when a proposed catalog row introduces a brand that does not already exist in the state catalog, resolve it from `store.product.brand.list` first, then create it with `store.product.brand.add` if needed instead of guessing a brand ID
- live behavior on 2026-05-05 against `prime.sweedpos.com`: `store.product.brand.list` accepts `{ page, pageSize }` but ignores both and always returns the entire brand list (231 rows for FB NY) on every call. Any caller that pages by checking `data.length < pageSize` will infinite-loop. Treat this list as already-complete after the first call (or de-duplicate by `id` and stop when a page introduces no new ids).

## Multi-Unit Variant Naming

From live Freshly Baked NY state-catalog work on 2026-04-13:

- multi-unit variant naming is a state-level catalog rule, not just a pre-roll multipack import convention
- the reliable scope for this cleanup was dealer `210248` (`Freshly Baked NY`), using `store.auth.dealer.set { dealerId: 210248 }` before scans and writes
- the live scan pattern was: page the full state catalog with `store.product.list.short`, filter to rows where `packOfSize > 1`, then compare each row against the canonical derived naming rule
- canonical variant naming rule:
  - `tab = "{packOfSize}x {size.name}"`
  - `name = "{brand.name} {productGroup.name} {tab}"` when a brand exists
  - if no brand exists, `name = "{productGroup.name} {tab}"`
- practical implication: if a multi-unit row shows only the unit size (`0.5g`, `10mg`) or malformed spacing (`2 x 0.5g`, `10x 10 mg`) in `tab` / `name`, fix it with `store.product.edit` on the product variant from the state-level catalog context
- a full live scan on 2026-04-13 found `3151` total variants, `695` multi-unit variants, and `22` real naming mismatches across multiple categories before cleanup; a verified follow-up scan returned `0` remaining mismatches

## Preroll Subcategory Migration

From live Freshly Baked NY state-catalog work on 2026-04-13:

- preroll subcategory reads in `store.product.list.short` tracked the product group's subcategory, not the product variant override alone
- `store.product.group.get { id }` returned the authoritative preroll group subcategory in `subcategory`, while the nested `products[]` rows could still show `subcategory: null`
- `store.product.edit { id, subcategoryId: null }` successfully cleared the variant-level override but did not move the live preroll listing out of `Single` or `Infused Pre-Roll` by itself
- the effective catalog move call was `store.product.group.edit { id, subcategoryId }`
- clearing a preroll group to the plain top-level `Pre-Rolls` bucket worked with `store.product.group.edit { id, subcategoryId: null }`
- moving a preroll group into the new `Pre-Rolls / Infused` bucket worked with `store.product.group.edit { id, subcategoryId: 6528 }`, where `6528` was the live `Infused` subcategory under category `1085` (`Pre-Rolls`)
- immediate verification was most reliable with `store.product.group.get { id }`; `store.product.list.short` also reflected the new subcategory promptly when the request included `reload: true`
- a full live migration script in `categories/2026-04-13/migrate_preroll_subcategories.py` moved `784` preroll groups (`822` products) out of the legacy preroll subcategories and finished with `0` remaining planned preroll moves
- the verified post-migration live preroll product counts were `727` rows with no subcategory and `250` rows in `Infused`, with `0` rows left in `Single`, `Multi-Pack`, `Infused Pre-Roll`, or `Infused Pre-Roll Multi-Pack`

## Flower Subcategory Cleanup

From live Freshly Baked NY state-catalog work on 2026-04-19:

- Flower subcategory cleanup followed the same state-level pattern as preroll lane migration: call `store.auth.dealer.set { dealerId: 210248 }`, resolve the live Flower category shape from `store.product.category.list`, page `store.product.list.short` with `reload: true`, then edit the product group rather than relying on a product-level override
- the live Flower category resolved as `1088` with subcategories `Infused` (`1095`), `Pre-Packaged Flower` (`1120`), `Pre-Ground` (`1904`), and `Infused Pre-Ground` (`1995`)
- clearing the legacy packaged-flower bucket worked with `store.product.group.edit { id, subcategoryId: null }`
- the follow-up verification pattern that held up in this pass was `store.product.group.get { id }` for each touched group plus a fresh Flower-wide `store.product.list.short` scan with `reload: true`
- a full live migration script in `bulk_additions/2026-04-18/migrate_prepackaged_flower_subcategories.py` cleared `792` Flower groups (`846` products) out of `Pre-Packaged Flower`
- the verified post-migration Flower product counts were `847` rows with no subcategory, `23` rows in `Infused`, `6` rows in `Pre-Ground`, and `20` rows in `Infused Pre-Ground`, with `0` rows left in `Pre-Packaged Flower`

## Edibles Subcategory Cleanup

From live Freshly Baked NY state-catalog work on 2026-04-19:

- Edibles subcategory cleanup followed the same state-level group-edit pattern as the preroll and flower cleanup passes: call `store.auth.dealer.set { dealerId: 210248 }`, resolve the live Edibles category shape from `store.product.category.list`, page `store.product.list.short` with `reload: true`, then edit the product group rather than relying on a product-level override
- the live Edibles category resolved as `1086` and the legacy `Chews/Gummies` lane resolved as subcategory `1106`
- clearing the legacy edible lane worked with `store.product.group.edit { id, subcategoryId: null }`
- the follow-up verification pattern that held up in this pass was `store.product.group.get { id }` for each touched group plus a fresh Edibles-wide `store.product.list.short` scan with `reload: true`
- a full live migration script in `bulk_additions/2026-04-18/migrate_chews_gummies_edibles_subcategories.py` cleared `276` Edibles groups (`288` products) out of `Chews/Gummies`
- the verified post-migration Edibles product counts were `289` rows with no subcategory, `34` rows in `Pills / Tablets`, `20` rows in `Chocolate`, `11` rows in `Hard Candy`, `5` rows in `Cooking Ingredients`, `3` rows in `Drinks`, `2` rows in `Baked Goods`, and `1` row in `Freeze Pops`, with `0` rows left in `Chews/Gummies`

## Vape Subcategory Asymmetry: Cartridge Vs All-In-One

The vape `subcategory` (`Cartridge`, `Live Resin Cartridge`, `All In One / Disposable`, etc.) is not just a cosmetic taxonomy field. Customers, drivers, and storefront filters rely on it to decide whether the unit is usable on its own (AIO/disposable, has its own battery) or requires a separate 510 battery.

The error costs are sharply asymmetric:

- Marking an actual AIO/disposable as a 510 cartridge, or leaving the subcategory blank, is recoverable: the customer just sees a less specific lane, and they can still use the unit because it has its own battery.
- Marking an actual 510 cartridge as `All In One / Disposable` is dangerous: a customer who does not own a compatible 510 battery may attempt to use the cart, ruin or destroy the oil, and almost certainly demand a refund of a spoiled product. This is the worst class of catalog miscategorization on vape rows in this workspace.

Practical rules:

- During catalog creation or apply flows, never set `Vapes / All In One / Disposable` from inferred or default values. Require explicit, vendor-confirmed evidence that the unit is a self-contained battery + oil unit (e.g. `disposable`, `AIO`, `Briq`, `puff bar`, `pod with built-in battery`, `USB-C charging`, `battery life`).
- When the device form is unknown or only weakly cued, leave the vape group's `subcategoryId` null. Null is preferred over a wrong AIO label.
- During cleanup of an existing brand whose live catalog rows already carry `All In One / Disposable`, do not trust that label transitively. Confirm the device form from the brand's own product page or vendor docs before keeping it; otherwise clear the subcategory.
- Live confirmation on 2026-05-11: every in-stock House of Sacci vape variant in this workspace was a 510 cartridge, but all 5 in-stock product groups (`Laughing Gas` 319178, `Maui Waui` 319179, `Rose' Runtz` 319181, `Sweet Mint` 319183, `ZPK` 319187) were attached to `All In One / Disposable` (subcategory `1112`). They were cleared to null with `store.product.group.edit { id, subcategoryId: null }` from state context (`Freshly Baked NY` dealer `210248`); see [`automation/individual_catalog_fixes/clear_house_of_sacci_vape_subcategories.py`](../../../individual_catalog_fixes/clear_house_of_sacci_vape_subcategories.py) and the recorded results JSON next to it.
- The same script doubles as a brand-scoped cleanup template: it pages `store.inventory.item.list.grouped { isOnStock: true }` at each site, filters by brand and category, resolves variant -> group via `store.product.get { id }.product.productGroupId`, and then clears subcategory at state context with per-group verification.

## Disabled Subcategories Must Stay Unattached

From live Freshly Baked NY state-catalog work on 2026-04-23:

- `store.product.category.list` exposed multiple legacy subcategories with `enabled: false`, including `Edibles / Chews/Gummies`, `Edibles / Drinks`, `Flower / Pre-Packaged Flower`, and old `Other` accessory buckets like `Batteries` and `Smoking Accessories`
- those disabled lanes can still remain attached to live product groups even after earlier migration passes; on 2026-04-23 a verified cleanup found `24` remaining attached groups across those disabled lanes
- the newly created Cannabals edible groups were all still attached to disabled `Chews/Gummies`, and clearing that disabled subcategory was required so those products could list for sale normally
- the durable remediation pattern is still a product-group edit, not a product-level override: `store.product.group.edit { id, subcategoryId: null }`, followed by verification with `store.product.group.get { id }` and a fresh `store.product.list.short { reload: true }` scan
- a generic cleanup script in `automation/individual_catalog_fixes/cleanup_disabled_catalog_subcategories.py` cleared the remaining `24` groups successfully and finished with `0` live groups still attached to any disabled subcategory, recorded in `automation/individual_catalog_fixes/freshly_baked_disabled_subcategory_cleanup_results.json`
- practical rule for future create/apply flows: when resolving a `subcategoryId`, filter the category's live subcategory list to rows where `enabled` is true; if the only matching legacy lane is disabled, leave the group subcategory null unless a reviewed enabled replacement is explicitly approved

Observed verification nuance from the same live write pass:

- `store.product.edit` successfully updated the public-facing `tab` and `name` fields for the edited multi-unit rows
- on several edited rows, the follow-up `store.product.get` payload returned `shortName` normalized to the full product `name` even when a group-only short name was sent in the edit payload
- practical implication: use `store.product.list.short` as the authoritative full-catalog verification pass for multi-unit naming cleanup, and use `store.product.get` to confirm the touched row landed, but do not assume the returned `shortName` will remain group-only after a live `store.product.edit`

Observed creation-path verification nuance from the 2026-04-16 pending-catalog apply pass:

- immediately after `store.product.add`, `store.product.list.short` could still show the new variant with stale defaults such as `price: 0` and `packOfSize: 0` even when called with `reload: true`
- the same newly created row was already represented correctly inside `store.product.group.get { id } -> products[]`, including the real `tab`, `size`, `packOfSize`, `price`, and ecommerce flags after the follow-up `store.product.edit`
- practical implication: for immediate post-create verification, prefer `store.product.group.get` on the created group over `store.product.list.short`; treat the list endpoint as eventually consistent for new rows instead of the source of truth in the same write transaction

Observed existing-variant verification nuance from the 2026-04-19 edible variant cleanup:

- after `store.product.edit` corrected existing edible variants from malformed single-unit `50mg` rows into multi-unit `10x 10mg` and `10x 5mg` rows, `store.product.list.short` updated the row `name` promptly but continued to serve stale numeric fields such as `packOfSize: 0` and `price: 0` even with `reload: true`
- in the same write block, `store.product.group.get { id } -> products[]` reflected the corrected `tab`, `size`, `packOfSize`, and price immediately, while one follow-up `store.product.get { id }` read briefly returned the pre-edit variant shape before converging on retry
- practical implication: for immediate post-edit verification of an existing variant, treat `store.product.group.get` as the most reliable source of truth, retry `store.product.get` if it still shows the old shape, and do not treat a stale `store.product.list.short` numeric payload by itself as evidence that the write failed

Observed size-dictionary nuance from the 2026-04-19 Flower `3.5g` normalization pass:

- `store.product.size.list` returned size rows with `enabled`, `uomNumber`, and nested `uom` metadata, which was enough to confirm the live Flower `3.5 gram` row `849` was already disabled while the active `3.5g` row `850` remained enabled
- a disabled size row can still remain attached to live sellable variants; in this pass, `391` Flower variants still pointed at disabled size `849` even though their public-facing `name` and `tab` already read `3.5g`
- the safe remediation was a state-level variant edit only: `store.product.edit { id, sizeId: 850 }`, with no accompanying name or tab rewrite when the public text was already correct
- authoritative per-row verification again came from `store.product.group.get { id } -> products[]`, while a final Flower-wide `store.product.list.short` exact-`uomNumber` audit confirmed `0` remaining `849` rows and `603` total `3.5g` Flower rows on size `850`

Observed size-create path from the 2026-04-22 Midtown Cannabals / Kingsroad pending-catalog apply:

- when a proposal required a live size row that did not yet exist in the state dictionary (`6g` for the Cannabals `Chubby Puff` disposables), `store.product.size.add` accepted an ID-based payload shaped like `{ name: "6g", uomId: 1, uomNumber: 6, tagTypeId: 14, enabled: true }`
- the direct create response already contained the created size row, but an immediate follow-up `store.product.size.list` reread could lag briefly, so write flows should trust the direct create response first and use the list reread only as a secondary confirmation
- practical implication: when a controlled standard gram size is missing during a catalog-create pass, it is safe to create it once in verified state context instead of failing the whole apply

## Product Creation Flow

From the product-creation HAR, the sequence for creating a new catalog item was:

1. `store.blob.add`
2. `PUT /api/blobs/upload/<blobId>`
3. `store.product.group.add`
4. `store.product.add`
5. `store.distributor.product.add`
6. `store.distributor.product.price.add`

### 1. Upload image placeholder

Create a blob ID:

```json
{
  "auth": "<token>",
  "name": "store.blob.add",
  "params": {
    "type": "banner"
  },
  "id": "<uuid>"
}
```

This returns a blob GUID such as:

```json
{"result": "1d7a569e-23cf-4277-ad49-aa92757397b6"}
```

Then upload the binary file with:

```text
PUT https://prime.sweedpos.com/api/blobs/upload/<blob-guid>
```

Important: the CSV image URL was not fetched by Sweed in the HAR. The user interface uploaded a local file. For automation, image handling must be done explicitly.

### Product-group image replacement

From live Freshly Baked NY state-catalog work on 2026-04-19:

- replacing an existing group image used the same two-step blob flow as creation: call `store.blob.add { type: "banner" }`, `PUT /api/blobs/upload/<blobId>` with the new binary bytes, then update the group with `store.product.group.edit { id, imagesIds: [blobId] }`
- the reliable scope for this cleanup was again the state dealer `210248` (`Freshly Baked NY`), with `store.auth.dealer.set { dealerId: 210248 }` verified before the read block and again before each live write block
- `store.product.group.get { id }` reflected the new `images[]` payload reliably during verification; polling that endpoint until the first image URL changed from the pre-write value was a workable confirmation pattern
- in this pass, the safe concurrency guard was to re-read the current group image immediately before each write and skip the edit if the live image had changed since the review step, rather than overwriting a newer manual or concurrent update
- product-specific staged vendor photos are acceptable group images even when they use a clean background, show the package beside loose product, or include product-specific label overlays; do not reject those just for looking polished
- the forbidden image class for this workflow is narrower: generic placeholders or marketplace stock assets with visible text such as `stock photo` or `stock image` must never be applied live, even if they otherwise resemble the right format

Practical implication:

- for bulk image cleanup, treat `store.product.group.edit { imagesIds }` as the authoritative live write path for group images, and verify through `store.product.group.get` instead of assuming the upload or edit call alone proves the replacement landed

### 2. Create product group

Example:

```json
{
  "auth": "<token>",
  "name": "store.product.group.add",
  "params": {
    "name": "Durban Poison x Cherry Tart",
    "brandId": 1926,
    "strainId": 10265,
    "imagesIds": ["1d7a569e-23cf-4277-ad49-aa92757397b6"],
    "isFinishedProduct": true,
    "categoryId": 1085,
    "subcategoryId": 1093
  },
  "id": "<uuid>"
}
```

This returns a `productGroupId`, for example `291413`.

## Product And Group Rename Behavior

Observed from the 2026-04-11 approved outstanding-PO write pass:

- `store.product.group.edit { id, name }` updated the group's `name` / `fullName`
- existing product variants under that group did not automatically inherit the new public-facing product name
- `store.product.edit { id, name, shortName }` successfully renamed the variant directly

Practical implication:

- if the approved customer-facing variant name differs from the auto-generated `brand + group + tab` pattern, explicitly rename the product after create or group rename rather than assuming the group edit will cascade

Observed from the 2026-04-14 statewide strain-label cleanup:

- the live state-catalog scan found malformed public-facing name suffixes across multiple categories, including complete parenthetical labels like `(Indica)`, truncated fragments like `(Sativ`, and bar-delimited variants like `| Hybrid`
- the safe cleanup rule was to remove only suffix fragments that still read like strain/prevalence labels, while leaving unrelated open-parenthesis marketing text such as cannabinoid ratios, flavor notes, or assortment descriptions untouched
- the cleanup was applied successfully by scanning the full state catalog with `store.product.list.short`, renaming affected groups with `store.product.group.edit { id, name }`, and verifying the final state with another full-catalog scan
- in this specific cleanup pass, the affected simple variants ended up reflecting the cleaned derived names after the group rename, so the follow-up product step verified as unchanged on the remaining rows

Practical implication:

- for bulk cleanup of malformed strain-label suffixes, use a whole-catalog scan plus verification pass and only strip confirmed strain/prevalence fragments; do not treat every open parenthesis or pipe-delimited suffix as disposable name noise
- do not generalize the apparent variant-name propagation from this pass into a universal rule; verify with `store.product.get` / `store.product.list.short` before deciding a direct `store.product.edit` is unnecessary

### 3. Create variant

Example:

```json
{
  "auth": "<token>",
  "name": "store.product.add",
  "params": {
    "displayInEcommerce": true,
    "isPacked": true,
    "packOfSize": 20,
    "allowedSaleTypeId": 3,
    "sizeId": 1107,
    "tab": "20x 0.35g",
    "productGroupId": 291413,
    "price": 80
  },
  "id": "<uuid>"
}
```

This returns a `productId`, for example `382539`.

Observed ecommerce-visibility control from the 2026-04-25 Delivery Compliance Preroll create:

- in verified Freshly Baked NY state context (`store.auth.dealer.set { dealerId: 210248 }`), `store.product.add` accepted `displayInEcommerce: false` directly on a newly created variant
- a follow-up `store.product.edit { id, displayInEcommerce: false }` also preserved the offline state on that same variant after the name / price / tab cleanup step
- immediate verification succeeded through `store.product.group.get { id } -> products[]`, which showed the created variant with `displayInEcommerce: false`; a follow-up direct `store.product.get { id }` converged to the same value

Practical implication:

- when a catalog row should exist for compliance or operator workflows but stay off the ecommerce menu, set `displayInEcommerce: false` on the product variant during the create/edit flow and verify it from the group payload rather than assuming a separate site-level toggle is required

### 4. Create distributor product

Example:

```json
{
  "auth": "<token>",
  "name": "store.distributor.product.add",
  "params": {
    "name": "Hepworth Durban Poison x Cherry Tart 20x 0.35g",
    "productId": "382539",
    "productQty": 1,
    "distributorId": 3253
  },
  "id": "<uuid>"
}
```

This returns a `distributorProductId`, for example `537388`.

### 5. Add distributor price

Example:

```json
{
  "auth": "<token>",
  "name": "store.distributor.product.price.add",
  "params": {
    "distributorProductId": "537388",
    "fromDate": "2026-04-10",
    "distributorProductPrice": 25
  },
  "id": "<uuid>"
}
```

## Lookup Calls Needed Before Creation

The frontend uses dictionary/list calls to turn human-readable names into IDs.

Confirmed examples:

- `store.product.brand.list`
- `store.product.category.list`
- `store.product.strain.list`
- `store.product.sale.type.list`
- `store.distributor.list`
- `store.product.list.short`
- `store.product.group.list`

Confirmed IDs from the captured account:

- Brand `Hepworth` -> `1926`
- Category `Pre-Rolls` -> `1085`
- Category `Vapes` -> `1087`
- Category `Flower` -> `1088`
- Subcategory `Multi-Pack` -> `1093`
- Subcategory `Cartridge` -> `1111`
- Subcategory `Live Resin Cartridge` -> `1113`
- Subcategory `Pre-Packaged Flower` -> `1120`
- Quality line `Oil for Vaporization` -> `218`
- Quality line `Cannabis Flower Products` -> `217`
- Tag `Oil for Vaporization` -> `199269`
- Tag `Cannabis Flower Products` -> `199267`
- Strain `Durban Poison` -> `10265`
- Sale type `Recreational` -> `3`
- Size `0.5g` in Vapes -> `836`
- Size `1g` in Vapes -> `842`
- Size `3.5 gram` in Flower -> `849` (disabled)
- Size `3.5g` in Flower -> `850`
- Size `0.35g` in Pre-Rolls -> `1107`

These values should not be assumed to be portable across stores without verification.
