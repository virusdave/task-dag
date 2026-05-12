# Sweed Catalog Review, Pricing, And Backfill

Load this when the task is a review packet, pricing proposal, attribute backfill, in-stock audit, or category-specific migration pass.

Source: `HOW_SWEED_WORKS.md`

## Draft Pricing Versus Competitor Average

Confirmed workspace pricing rule from 2026-04-11, tightened again on 2026-04-19:

- keep draft catalog pricing inside the 55% to 67.5% post-tax GM band when possible
- treat the captured average competitor price as a pre-tax average and convert it to a post-tax competitor equivalent with `1.13 * average_competitor_price`
- when that post-tax competitor equivalent is available, do not try to match it or sit right on top of it
- instead, target a few percent below that post-tax competitor equivalent first, then keep the result inside the preferred GM band when that is actually feasible
- example guidance from the user: if the average competitor pre-tax price is `$18.09`, the post-tax competitor equivalent is about `$20.45`, so a reasonable target is around `$19.50` or `$19.75`
- if the observed cost and competitor average cannot satisfy both rules at once, keep the below-competitor target and allow GM to fall below 55% rather than pricing above the market; do not go below 55% when competitor pressure is absent
- for same-brand, same-size equivalent rows with the same cost basis, align the outgoing draft price across the family once the market-backed rows establish a usable shared price
- if a row is a true sample with only a nominal cost and no paid companion cost to inherit, still emit a draft price from that nominal cost instead of leaving the row unpriced; an extremely high GM is acceptable in that case because the packet still needs a usable proposed price

## Nearby Competitor Provider Shape

From the 2026-04-12 HAR `brands.litalerts.com_Products_menulistings_Archive [26-04-12 13-22-41].har` and matching live replays:

- nearby competitor menu pricing can be retrieved from `POST https://public-api.litalerts.com/Products/menulistings`
- the request used a bearer token from the `brands.litalerts.com` session plus JSON fields such as `page`, `pagesize`, `stateID`, `dispensaryIDs`, and a `filters` object containing at least `Dispensary`, `Availability`, `Image`, `MedRec`, `ShowStaleItems`, `ShowHiddenDisps`, and `StateID`
- the captured competitor set used New York state `265` and a fixed set of nearby dispensary IDs
- each response row in `listings[]` exposed `id`, `url`, `name`, `category`, `brand`, `imageUrl`, `dispensaryName`, and `configs[]`
- each `configs[]` entry exposed `price`, `salePrice`, `quantity`, `weight`, `daysOnMenu`, and med/rec flags
- for nearby flower pricing, the useful filter was local post-processing rather than a server-side category filter in the captured request: keep rows with `category == "Flower"` and an ounce cue such as `28g`, `28 g`, `1 oz`, `1 ounce`, or `one ounce` in `configs[].weight` or the listing name
- retailer naming is not uniform, so exact string equality is not enough; normalized brand plus approximate cultivar cues from the listing `name` were needed to match our catalog rows reliably

Observed pagination nuance:

- the live provider response `total` field was not a trustworthy stopping condition in this session
- with `pagesize: 1000`, the provider kept returning full pages through page `12` and then a short page `13`, for `13371` raw rows total, while `total` still reported `10000`
- practical rule: paginate until the provider returns an empty page or a page shorter than the requested `pagesize`

## Site-Level Inventory Availability Audit Shape

From the 2026-04-11 Midtown inventory HAR and a matching live replay in the same site context:

- `store.auth.dealer.set { dealerId: 210705 }` switched the session into the Midtown site inventory scope.
- `store.inventory.item.list.grouped { page, pageSize, isOnStock: true }` returned the current in-stock report.
- The grouped row itself carried summary fields such as `product`, `productBrand`, `category`, `subcategory`, `currentQty`, `holdQty`, `availableQty`, `localPrice`, and `globalPrice`.
- The nested `items[]` entries carried the fields needed for online-availability audits, including `productId`, `currentQty`, `holdQty`, `availableQty`, `stockLocation`, `isTradeSample`, and `isAvailableOnline`.

Practical implication:

- If the question is "which in-stock items are not online" or any variant that depends on room/location or trade-sample status, filter the nested `items[]` records rather than relying only on grouped row totals.

Related observation from the same HAR:

- `store.inventory.portalsearch.enabled` returned a bare boolean result in this environment. On 2026-04-11 it returned `false`, so treat it as an environment capability/config check rather than a per-product availability list.

## Approved In-Stock Packet Apply Pattern

Observed on the 2026-04-23 approved Freshly Baked in-stock metadata pass from `automation/individual_catalog_fixes/`:

- the approved apply step should consume the locked review packet JSON directly, not re-derive targets from the older analysis report
- use `apply_in_stock_catalog_attribute_review_packet.py` against `freshly_baked_in_stock_catalog_attribute_review_packet.json` so the write scope stays aligned with the reviewer-approved packet rows and field plans
- only apply fields whose packet plan status is already `actionable`; leave `needs-review` fields untouched even when the same group has other approved fields
- partial group writes are allowed and expected in this lane: for example, apply approved `effects` and `flavorings` while leaving `strain` blank if the packet did not approve a safe strain action
- the packet's Bronx and Midtown inventory reads define scope only; every live metadata read/write still belongs on the state dealer `210248` with a fresh `store.auth.dealer.set` verification before each operation block
- the 2026-04-23 live run processed `161` approved groups, left `151` review-only groups untouched, created `10` new effect dictionary rows, created `22` new flavoring rows, and did not need any new strain rows because the `3` approved strain actions all reused existing dictionary entries

## Durable Janitorial Rules

The Freshly Baked NY janitorial lane should use named maintenance rules and reviewer-facing hit counts, not raw scan totals or one-off cleanup scripts.

Janitorial scope in this lane is cannabis products only. Exclude non-cannabis merch categories such as `Accessories` and `Other` from live janitorial scans, packet counts, and reviewer wording unless the user explicitly asks for a separate merch cleanup pass.

Canonical rule registry and packet entrypoint:

- `individual_catalog_fixes/catalog_janitorial_rules.json` is the durable machine-readable rule list for this lane
- `individual_catalog_fixes/generate_catalog_janitorial_review_packet.py` is the consolidated review-packet generator for the current rule set

Current durable janitorial rules:

- Multi-unit packs must follow the state-level canonical variant label pattern `${QTY}x ${UNITSIZE}` such as `10x 0.35g` or `2x 1.5g`. Emit review rows at the variant level and, after approval, apply through `store.product.edit` from the state dealer context.
- Edibles should not surface prevalence-style potency percentages. Treat bogus storefront labels such as `THC: 100%` or `THC: 0.15 - 100%` as a dedicated janitorial lane, using `individual_catalog_fixes/generate_edible_thc_prevalence_review_packet.py` and its locked review packet instead of silently preserving or adding that data.
- Root-cause note for the Freshly Baked edible-potency lane from the 2026-04-30 live investigation: the affected no-subcategory `Edibles` and `Beverages` categories are configured with `limitType: Concentrate`, while their dose sizes are stored as gram-based weights like `5mg -> 0.005g` and `10mg -> 0.01g`. On the broken Camino/Lost Farm/Kiva rows, the public storefront appears to format those dose fields as potency percentages, so a correct edible dose such as `thcContentPerUnit: 5mg` on a `5mg` size turns into a bogus `THC: 100%` display instead of preserving the reviewer-visible amount label like `20x 5mg` or `10x 10mg`.
- The same 2026-04-30 investigation disproved the package-total-THC theory for the current bug. Example: Camino `20x 5mg` rows carry `thcContentPerUnit: 5` and `thcContentPerProduct: 100`, yet still render `THC: 100%`, so the broken denominator is not the package-total `100mg`; it behaves like the per-piece size field instead.
- Disabled subcategories are invalid for cannabis janitorial create/apply work. If a live cannabis group is still attached to one, the default janitorial proposal is `store.product.group.edit { id, subcategoryId: null }` unless a reviewed enabled replacement has already been approved.
- Missing images belong in the cannabis janitorial packet as review hits, but image replacement still routes through the established image-review workflow. Do not auto-invent or auto-apply a replacement image.
- When the cannabis janitorial missing-image lane needs concrete replacement proposals, do not stop at the bare gap list. Generate a focused reviewer bundle for those groups, source candidate competitor images from live Lit Alerts statewide brand listings first, then run the established image-review classifier so obvious stock/default placeholders and wrong-format candidates are filtered before review.
- If no exact product image can be found for a missing-image janitorial row, the same reviewer-first lane may add clearly labeled same-brand placeholder-grade imagery as a temporary fallback. Keep that fallback separate from exact-product proposals in the packet metadata, do not auto-apply it live, and make it obvious to reviewers that it is placeholder-grade brand imagery until real product photography exists.
- For the Freshly Baked NY missing-image janitorial packet, the reviewer surface may be a local form-backed HTML service rather than a static report only, but it must still stay packet-driven: render directly from the current results ledger, default every row to review-only, keep exact-product and placeholder-grade choices visibly separate, persist reviewer picks back into the ledger immediately, and treat every live `store.blob.add` / `store.product.group.edit` block as dealer-verified state-level work.
- That local reviewer service may enqueue a background apply session instead of holding the form POST open. In that pattern, the POST should return quickly to a session status page, the browser should poll a JSON session endpoint for progress, the worker should persist results-ledger updates after each completed row so progress is resumable and visible, and the final execution log should be appended only when the session finishes.
- If the preferred missing-image session log path is not writable from the current agent or service context, fall back to a local writable JSONL path in the same workflow directory and surface that actual log destination plus the warning in the session status/output.
- Variant prices for in-scope cannabis products must land on quarter-dollar increments only. Janitorial metrics should count only the actual variant hits whose live price is missing or off-quarter, not the total scanned catalog size.
- Fake `25000...` inventory barcodes are an alarm lane, not a quiet cleanup lane. Use the site-level fake-barcode audit packet as a loud escalation surface so new cannabis inventory gets real barcodes ASAP.
- Temporary janitorial suppressions belong in the rule registry, not in ad hoc command flags or one-off packet edits. If a site is already being fixed in parallel, record a site-scoped `suppressUntil` window on the rule and keep the packet metrics free of those suppressed hits until the window expires.

Reviewer-facing metrics rule:

- For janitorial packets, summary cards and counts should reflect actual proposed fixes or alarm hits by rule, not raw scanned groups, products, or inventory rows.
- If a supporting janitorial lane already has a reviewed packet or audit artifact, fold that artifact into the consolidated reviewer surface instead of rescanning a different way.

## Catalog Attribute Backfill From Leafly

This section is specifically about backfilling catalog attributes such as strain, effects, flavors, and related nomenclature from an external source like Leafly.

Evidence sources for this section:

- the 2026-04-10 HAR at `bulk_additions/2026-04-10/prime.sweedpos.com_Archive [26-04-10 17-44-47].har` for live `store.product.strain.list` and `store.product.group.get` request and response bodies
- the 2025-09-11 HAR at `bulk_additions/2025-09-11/data/catalog_addition_and_interaction.har` for observed `store.product.effect.list`, `store.product.group.edit`, and `store.product.group.clone` request ordering and payload fields
- the frontend bundle `app.4.774.1.0ba021c94e5e5b079bba.js` loaded by the 2026-04-11 nomenclature route, used only to recover request schemas that the older HAR did not preserve in response bodies

Treat the bundle-derived pieces below as strong schema evidence, but still distinguish them from directly captured live requests.

### Where These Attributes Live

Observed split between nomenclature objects and product-group fields:

- strain metadata is its own dictionary object, managed through `store.product.strain.*`
- strain records carry `name`, optional `lineage`, a `prevalence`, and arrays of `flavors` and `terpenes`
- product groups, not variants, carry the selected `strain`, `effects`, `flavorings`, and `scents`
- variants returned inside `store.product.group.get` did not include those fields in the captured 2026 response

Practical rule:

- if you are backfilling strain or effect metadata onto a catalog product, operate on the product group with `store.product.group.get` and `store.product.group.edit`
- do not look for a separate variant-level "attach effect" or variant-level "attach strain" API; the current evidence points to group-level fields instead

### Nomenclature Routes Seen In The Frontend

The 4.774.1 frontend bundle exposes dedicated nomenclature pages for the relevant dictionaries:

- `/store_setup/nomenclature/strains`
- `/store_setup/nomenclature/strain/:id`
- `/store_setup/nomenclature/strain_flavors`
- `/store_setup/nomenclature/strain_flavor/:id`
- `/store_setup/nomenclature/effects`
- `/store_setup/nomenclature/effect/:id`
- `/store_setup/nomenclature/flavorings`
- `/store_setup/nomenclature/flavoring/:id`
- `/store_setup/nomenclature/scents`
- `/store_setup/nomenclature/scent/:id`

No terpene-specific nomenclature route was found in the loaded 4.774.1 bundle.

### HAR-Confirmed Reads And Product-Group Fields

Confirmed `store.product.strain.list` request shape from the 2026-04-10 HAR:

```json
{
  "auth": "<token>",
  "name": "store.product.strain.list",
  "params": {
    "page": 1,
    "pageSize": 1000000,
    "query": "durb"
  },
  "id": "<uuid>"
}
```

Confirmed response fields on each returned strain row included:

- `id`
- `name`
- `enabled`
- `prevalence` as an object such as `{ "id": 6, "name": "Sativa" }`
- `flavors`
- `terpenes`

Observed example from the same HAR:

- querying `durb` returned `Durban Poison` as `id: 10265`
- querying `cherr` returned eight matches such as `Banana Cherry Gelato`, `Cherry Pie`, and `Lemon Cherry Gelato`

Confirmed `store.product.group.get` request shape from the 2026-04-10 HAR:

```json
{
  "auth": "<token>",
  "name": "store.product.group.get",
  "params": {
    "id": 291413
  },
  "id": "<uuid>"
}
```

Confirmed response fields on the returned product group included:

- `strain`
- `effects`
- `flavorings`
- `scents`
- `products`
- category flags such as `isProductStrainEnabled`, `isProductScentEnabled`, and `isProductFlavoringEnabled`

Observed example from group `291413` (`Durban Poison x Cherry Tart`):

- `strain` was `{ "id": 10265, "name": "Durban Poison" }`
- `effects`, `flavorings`, and `scents` were empty arrays
- the category reported `isProductStrainEnabled: true`, `isProductScentEnabled: false`, and `isProductFlavoringEnabled: false`

That is the clearest captured evidence that the product group is the catalog object that actually holds these attributes.

Observed audit nuance from the 2026-04-20 Freshly Baked NY full-catalog completeness scan:

- a reusable reporting pattern for missing group-held attributes is: switch to state dealer `210248`, page active variants with `store.product.list.short { reload: true, advancedSearch: true }`, hydrate each unique `productGroup.id` with `store.product.group.get`, then aggregate missing `strain`, `effects`, and `flavorings` back onto the variant rows by category/subcategory bucket
- in that same live payload shape, groups with no strain attached could omit the `strain` key entirely rather than returning an explicit `null`; missing-strain audits need to treat an absent `strain` key the same as no attached strain

### Bundle-Declared Nomenclature APIs

The 4.774.1 frontend bundle declares the following nomenclature methods and request schemas.

Strain dictionary methods:

- `store.product.strain.list { page, pageSize, query?, enabled? }`
- `store.product.strain.add { name, lineage?, prevalenceId, flavorIds?, terpeneIds? }`
- `store.product.strain.edit { id, name?, lineage?, prevalenceId?, flavorIds?, terpeneIds?, enabled? }`

Observed live validation on 2026-04-13 during the approved 3.5g flower apply:

- `store.product.strain.add` rejected a name-only create with `Parameters validation error`
- the returned validation details explicitly said `Required properties ["prevalenceId"] are not present`
- practical implication: a locked packet can leave an exact strain's prevalence unresolved for review purposes, but the apply step still needs an explicit prevalence choice before creating that strain live
- in the approved 3.5g packet, the safe fallback for 23 unresolved exact-strain creates was an execution-only conservative `Hybrid` prevalence override, recorded in the apply results artifact, because no stronger reviewed Leafly-backed prevalence had been frozen into the packet
- `store.product.strain.prevalence.list { reload? }`
- `store.product.strain.flavor.list { query?, enabled? }`
- `store.product.strain.flavor.add { name }`
- `store.product.strain.flavor.edit { id, name?, enabled? }`
- `store.product.strain.terpene.list { query?, enabled? }`

Effect dictionary methods:

- `store.product.effect.list { query?, enabled?, categoryId? }`
- `store.product.effect.category.list { reload? }`
- `store.product.effect.add { name, categoryId, imageGuid? }`
- `store.product.effect.edit { id, categoryId?, name?, enabled?, imageGuid? }`
- `store.product.effect.images.enabled null -> boolean`

Observed live effect-category state on 2026-04-11:

- `store.product.effect.category.list {}` returned exactly two categories: `Positive` (`id: 1`) and `Negative` (`id: 2`)
- at the start of the in-stock attribute write pass, `store.product.effect.list {}` contained only `Euphoric`, `Relaxed`, and `Tingly`, all in the `Positive` category
- every missing Leafly-derived effect created during that pass (`Aroused`, `Creative`, `Energetic`, `Focused`, `Giggly`, `Happy`, `Hungry`, `Sleepy`, `Talkative`, `Uplifted`) was added successfully under `Positive`

Observed live prevalence dictionary nuance on 2026-04-12:

- `store.product.strain.prevalence.list {}` returned `CBD`, `Hybrid`, `Indica Dominant`, `Indica`, `Sativa Dominant`, `Sativa`, `CBG`, and `CBN`
- the live dictionary did not include a row named `Indica Hybrid`
- practical implication: review/prep labels sometimes need aliasing before live writes. In the 108275 Dumbo pass, `Indica Hybrid` had to be mapped to `Indica Dominant` for `Garlic Budder`

Other product-group attribute dictionaries exposed by the bundle:

- `store.product.flavoring.list { query?, enabled? }`
- `store.product.flavoring.add { name }`
- `store.product.flavoring.edit { id, name?, enabled? }`
- `store.product.scent.list { query?, enabled? }`
- `store.product.scent.add { name }`
- `store.product.scent.edit { id, name?, enabled? }`

Important current gap:

- in the loaded 4.774.1 bundle, I found `store.product.strain.terpene.list` but did not find any terpene add or edit method names
- that means terpene lookup is evidenced, but terpene creation is still unconfirmed in this workspace
- do not assume a terpene create endpoint name until it is captured from a HAR or a broader bundle search

### Product-Group Write APIs For Attaching Attributes

The same 4.774.1 bundle declares that product-group writes accept these fields:

- `strainId`
- `effectIds`
- `flavoringIds`
- `scentIds`
- `tagIds`
- plus the usual `brandId`, `categoryId`, `subcategoryId`, `qualityLineId`, and `typeId`

Observed request schemas:

```json
{
  "name": "store.product.group.edit",
  "params": {
    "id": 291413,
    "strainId": 10265,
    "effectIds": [123, 456],
    "flavoringIds": [789],
    "scentIds": [1011]
  }
}
```

```json
{
  "name": "store.product.group.add",
  "params": {
    "name": "Example Product Group",
    "brandId": 1926,
    "categoryId": 1088,
    "subcategoryId": 1120,
    "strainId": 10265,
    "effectIds": [123],
    "flavoringIds": [],
    "scentIds": []
  }
}
```

The 2025 HAR also captured a real `store.product.group.clone` request that included:

- `strainId`
- `effectIds: []`
- `flavoringIds: []`
- `scentIds: []`

That means new groups can be created or cloned with those arrays already attached; you do not have to wait for a second edit call if you are creating a fresh group. For existing catalog groups, `store.product.group.edit` is the relevant write.

Another important nuance from the HAR:

- `store.product.group.edit` accepts sparse updates in practice
- captured edits changed only `subcategoryId` or only `imagesIds`
- so an attribute backfill can likely send just `id` plus the fields being updated instead of resubmitting every product-group field

Observed live full-catalog description apply on 2026-04-15:

- `bulk_additions/2026-04-10/apply_catalog_description_mass_update.py` applied approved description rewrites from the review JSON back to the Freshly Baked NY state catalog
- sparse `store.product.group.edit { id, description }` writes succeeded for `2973` product groups without resubmitting unrelated group fields
- immediate follow-up `store.product.group.get { id }` reads reflected the new description text reliably enough to use as the per-row verification step and resumable ledger snapshot
- the same run intentionally left `4` approved rows untouched because their frozen copy still contained clear medical phrasing such as `targeted relief`, `pain relief`, or `therapeutic`; the postfacto report recorded those rows as blocked rather than silently applying them
- after those four rows were manually rewritten in the approved review JSON, rerunning the same apply script with target-aware resumability picked up only the changed rows and brought the final live total to `2977` updated groups with `0` remaining blocked rows

Observed Bedrock runtime convention for the catalog-description rewrite pipeline on 2026-04-16:

- keep the private Bedrock Mantle bearer token out of the repo and out of generated artifacts
- store the runtime token locally at `~/.secret/bedrock/mantle-bearer-token`
- keep the local export helper at `~/.secret/bedrock/mantle-bearer-token.env`
- that helper currently exports both `BEDROCK_MANTLE_BEARER_TOKEN` and `OPENAI_BASE_URL` for the OpenAI-compatible `https://bedrock-mantle.us-east-2.api.aws/v1` endpoint
- source that helper before running generator or prompt-lab workflows that call `https://bedrock-mantle.us-east-2.api.aws/v1`
- an older recovered token in local Amp history had already expired and produced `401 Unauthorized`, so the safe operating assumption is still that Bedrock credentials may rotate even when stored locally
- on 2026-04-16, the local secret was refreshed from a newer user-provided token intended to remain valid long-term; if the endpoint starts returning `401 Unauthorized` again, refresh the local secret file from the latest user-provided token instead of assuming the prompt code is broken

Observed pending-order proposal copy shape on 2026-04-19:

- for the pending-order proposal workflow, generated descriptions now use exactly two paragraphs rather than three
- paragraph 1 should be shopper-useful and product-first
- paragraph 2 should carry the SEO / store-context language and stay below the main product explanation

Observed pending-order proposal parser families on 2026-04-22:

- the current Midtown pending-purchase queue introduced new `Cannabals` families that were not covered by the older HR Botanical parser and had to be mapped explicitly in the local pending-purchase generator
- `Cannabals - Chubby Puff Vape - <strain> - 6g` should be treated as `Vapes / All In One / Disposable` with a `6g` tab and the named strain carried into the proposal strain field
- `Cannabals - Gummy - <flavor> - 100mg THC - 10ct` and `Cannabals - Gummy Brick - <flavor> - 100mg THC` both represent `10x 10mg` edible families (`100mg` total) and should carry flavor annotations from the named flavor
- `Cannabals - Cones - <flavor> - 100mg THC - 10ct` is a `Chocolate` edible lane rather than a generic gummy lane, still `10x 10mg` / `100mg` total
- `Cannabals - MS Gummy - Blueberry Dreams - 100mg THC - 20ct` maps to the sleep-gummy lane: `20x 5mg` with `Blueberry` flavoring and a reviewer-friendly effect annotation such as `Sleepy` / `Relaxed`
- the same queue introduced `Kingsroad` families that also needed explicit parser coverage
- `Kingsroad - LR Concentrate Puck - <strain> - 3.5g` should be treated as a `Concentrates` row with a `3.5g` tab and the named cultivar carried as the target strain
- `Kingsroad - Pre Rolls - <strain> - .5g - 14ct` should be treated as `Pre-Rolls / Infused` with a `14x 0.5g` tab; the public menu evidence used in this workspace described the current queued families as live-resin infused hybrid packs

Observed live quality-line removal on 2026-04-11:

- `store.product.group.edit { id, qualityLineId: null }` successfully cleared the product group's quality line without requiring any other fields
- the group's existing `tagIds` were not automatically removed by that edit
- Sweed recomputed `fullName` after the edit, dropping the quality-line text segment from names such as `Rove Oil for Vaporization Waui` to `Rove Waui`

### Inferred Leafly Backfill Flow

This is the current best reconstruction of the flow for backfilling Leafly-derived attributes onto an existing catalog product group.

1. Switch to the state-level catalog context before any writes.
2. Read the product group with `store.product.group.get { id }`.
3. Inspect the category flags on that response.
4. If `isProductStrainEnabled` is true, resolve the strain side first.
5. Search existing strains with `store.product.strain.list`.
6. If the strain does not exist, resolve `prevalenceId` via `store.product.strain.prevalence.list`.
7. Resolve or create strain flavors with `store.product.strain.flavor.list` and `store.product.strain.flavor.add` as needed.
8. Resolve terpenes with `store.product.strain.terpene.list`.
9. If every needed terpene already exists, create the strain with `store.product.strain.add { name, lineage?, prevalenceId, flavorIds?, terpeneIds? }`.
10. If a needed terpene does not already exist, stop and capture better evidence before guessing a terpene-create API name.
11. Resolve effects with `store.product.effect.list`.
12. If an effect is missing, resolve its category with `store.product.effect.category.list` and create it with `store.product.effect.add`.
13. If the category supports flavorings or scents and the source data calls for them, resolve those dictionaries with `store.product.flavoring.*` and `store.product.scent.*`.
14. Attach the chosen IDs to the product group with `store.product.group.edit { id, strainId, effectIds, flavoringIds, scentIds }`.
15. Re-read the group with `store.product.group.get` to verify the attachment landed.

Practical caveats:

- there is no captured dedicated "attach effect to product" API; the current evidence says the attachment happens by writing `effectIds` on the product group
- Leafly lineage appears to map most naturally to the optional `lineage` field on the strain record, not the product group
- the 2026 strain-list response schema includes `flavors` and `terpenes` on strain records, while product-group responses separately expose `flavorings` and `scents`; these are not the same field family and should not be conflated
- effect image support is feature-gated by `store.product.effect.images.enabled`; if that flag is false, omit `imageGuid`
- category flags are useful hints, but they were not sufficient as the sole prune rule in the 2026-04-11 in-stock analysis. At least one edible row (`Fruit Chews - Apple`) still carried a specific current group strain (`Apple Pop`) and therefore still had cultivar-review value despite the broader temptation to treat edibles as automatic no-action rows.
- treat that as a dataset-specific operational lesson, not a universal claim that every edible category should receive strain backfill. The confirmed point is narrower: category names and capability flags alone were too lossy for deciding whether a row still deserved strain review in this workspace.

### In-Stock Review Packet Evidence Upgrades

Observed on 2026-04-22 while revising the in-stock missing-attribute review packet under `individual_catalog_fixes/generate_in_stock_catalog_attribute_review_packet.py`:

- the most practical way to improve reviewer trust without inventing a second workflow was to keep the existing packet machinery and add a cached field-level evidence lane only for product-group `effects` and `flavorings`
- live Leafly strain pages are fetchable in this workspace with a normal browser-style `User-Agent`, and the needed data lives in the page `__NEXT_DATA__` payload at `props.pageProps.strain`
- for effect/flavor extraction, Leafly `effects` and `flavors` currently arrive as keyed objects with `name`, `score`, and vote metadata rather than as already ranked arrays; the reliable packet rule is to sort the positive-score entries descending and keep the top few rows
- official brand pages can be materially stronger than strain-only evidence for edibles, beverages, and other branded SKUs whose public pages already expose mood or flavor labels:
  - Ayrloom product pages from the Shopify sitemap expose flavor cues in page copy / ingredients plus effect labels such as `balance` and `calming balance`
  - Camino / Kiva flavor pages from the public sitemap expose a product-level `Effect` label and explicit ingredient flavor phrases such as `Watermelon Flavor` / `Lemon Flavor`
  - Off Hours gummies can be resolved from the public gummies collection into product pages whose meta descriptions already expose both the effect lane (`Focus`, `Energy`, `Calm`, `Sleep`) and the flavor family (`Cherry Limeade`, `Orange Punch`, `Grape Punch`, `Paradise Cooler`)
- for image-review packets, retailer product pages can also expose usable exact-product package photos directly in HTML metadata such as `og:image`, `twitter:image`, or schema `Product.image`; inspect those raw fields before giving up on a row just because a higher-level page reader or storefront scrape did not surface an obvious image URL
- Weedmaps discovery is still not reliable enough for generic automation in this workspace, so the safe packet rule remains: use Weedmaps only when an exact product URL is already known and freeze that URL directly into the evidence layer instead of blocking on open-web search discovery
- reviewer-facing detail pages are much easier to approve when every proposed effect or flavoring shows three things together: the cited source URL, the raw source phrase(s), and the standardized proposed value(s) derived from that source

### AllBud Strain Evidence For Strain-Catalog Audits

Observed on 2026-04-27 while generating the Freshly Baked NY strain-dictionary review packet under `individual_catalog_fixes/generate_strain_catalog_review_packet.py`:

- the current public entrypoint for broad strain discovery is `https://www.allbud.com/sitemap-strains.xml`, not the top-level sitemap index alone; the strain sitemap exposes canonical public page URLs whose path segment already encodes the visible prevalence lane such as `sativa-dominant-hybrid` or `indica`
- exact and punctuation-normalized slug matching against that sitemap was good enough to safely cover a large actionable subset of the live Sweed strain dictionary without inventing open-web search logic
- the useful AllBud page payload lives in JSON-LD blocks, not in brittle visual selectors:
  - `FAQPage` answers carry reusable taste tags and the explicit `Is <strain> Indica or Sativa or Hybrid?` prevalence sentence
  - `Product.description` carries the long-form cultivar summary where parentage phrases such as `cross between Blueberry X Haze` or `created through crossing Oreoz X Devil Driver` can be extracted
- for strain-catalog review packets, AllBud-backed flavor proposals are safest as additive changes on the strain record: preserve current Sweed flavors, then add only the recovered AllBud taste tags that are still missing
- when comparing current Sweed lineage against AllBud parentage, normalize connector wording such as `with`, `&`, and `and`, and compare parent sets rather than treating order alone as a conflict; this avoided false review-only conflicts like `Fortune Cookies & GMO` versus `GMO x Fortune Cookies`
- before live strain-lineage writes, sanitize any extracted AllBud parentage string that obviously runs past the cultivar cross and into narrative copy. In the 2026-04-27 Freshly Baked apply pass, rows like `Fire OG`, `Blueberry Cheesecake`, and `Chernobyl` showed that `Product.description` extraction can overrun into follow-on sentences such as `This...`, `It...`, or a trailing `. The`; safe remediation was to clip those sentence tails and keep only the parentage expression before calling `store.product.strain.edit`.
- the approved strain-dictionary apply pattern for this lane is packet-driven and strain-level: consume the locked review JSON directly, create any missing dictionary rows with `store.product.strain.flavor.add`, then apply only the approved `prevalenceId`, `lineage`, and additive `flavorIds` changes through `store.product.strain.edit` from verified state dealer `210248` / `Freshly Baked NY`, recording a resumable results ledger as you go.

### Preparing A Full Update Pass For All In-Stock Catalog Entries

The 2026-04-11 in-stock analysis established a workable handoff point from read-only review into a catalog update pass.

Observed snapshot from `bulk_additions/2026-04-10/product_catalog_attribute_analysis.json`:

- 166 in-stock variant rows
- 159 distinct product groups
- 3746 total available units at the Midtown site snapshot
- status buckets: `reviewed-group` 12, `verified-proxy` 42, `verified-equivalent` 5, `inferred-candidate` 31, `generic-or-missing` 76

The important operational distinction is that the report is variant-level for review convenience, but the write model is still product-group-centric.

Practical rule for the write pass:

- use the site-level inventory read only to define the current in-stock scope
- collapse the variant rows to unique `groupId` actions before writing anything
- treat duplicate variants under the same product group as one catalog update target unless a captured request proves otherwise

Recommended sequencing for a full in-stock update pass:

1. Regenerate the in-stock analysis from the site-level Midtown context with `store.auth.dealer.set { dealerId: 210705 }` followed by `store.inventory.item.list.grouped { page, pageSize, isOnStock: true }` so the scope is fresh.
2. Collapse the JSON export to unique product-group actions keyed by `groupId`.
3. Filter that action set to rows already strong enough for automated writes: `reviewed-group`, `verified-proxy`, and `verified-equivalent`.
4. Exclude rows whose recommendation is effectively accessory/no-action, plus rows still labeled `inferred-candidate` or `generic-or-missing` unless they receive further review first.
5. Switch to the state-level catalog holder before any write calls. In this workspace, the confirmed state catalog holder used for successful group edits was `store.auth.dealer.set { dealerId: 210248 }` for `Freshly Baked NY`.
6. Preload and cache the reusable dictionaries needed for the whole run: strains, prevalences, effects, effect categories, strain flavors, strain terpenes, product flavorings, and product scents.
7. For each target product group, resolve the exact target strain. Reuse an existing strain record when present; otherwise create it only after confirming the required prevalence and every required terpene/flavor ID.
8. Resolve or create missing effects, strain flavors, product flavorings, and scents through their dictionary APIs before editing the group.
9. Apply the catalog change with sparse `store.product.group.edit { id, strainId, effectIds, flavoringIds, scentIds }` payloads rather than rewriting unrelated group fields.
10. Re-read each touched group with `store.product.group.get { id }` and record the post-write state so the run can be resumed safely if interrupted.

Recommended safety gates for that write pass:

- do not try to write directly from category heuristics; keep using the reviewed JSON as the source of truth for whether a row is actionable
- do not create duplicate dictionary records; list/search first and reuse strain, effect, flavor, scent, and terpene records whenever they already exist
- if a needed terpene is missing from the live dictionary, stop that row and capture better evidence instead of guessing a terpene-create API name
- if a row only has an inferred cultivar slug or a generic current strain such as `Hybrid`, leave it unchanged until it receives better review

Observed blocker status for the current vetted in-stock set:

- the exact-target resolver bug that had been suppressing verified cultivars like `Zonuts` was fixed before this preparation note was added
- the post-fix rerun promoted `Zonuts`, `Blue Lobster`, `Novarine`, and `Fire OG` into explicit exact create/attach recommendations
- in that same rerun, the recommended terpene sets for the currently vetted actionable rows were already present in the live terpene dictionary, so the still-unconfirmed terpene-create path did not block those rows

Observed live execution of that write pass on 2026-04-11:

- the batch was executed from `bulk_additions/2026-04-10/apply_product_catalog_attribute_updates.py`
- it regenerated the site-level report, collapsed the JSON to 56 unique actionable product groups, switched to `store.auth.dealer.set { dealerId: 210248 }`, and completed all 56 state-level group updates with no skips and no failures
- the persisted artifacts were `bulk_additions/2026-04-10/product_catalog_attribute_write_plan.json` and `bulk_additions/2026-04-10/product_catalog_attribute_write_results.json`
- the run created 10 new effect dictionary rows, 30 new strain-flavor rows, and 13 new strain dictionary rows, and it edited 44 existing strain records to add the reviewed prevalence/flavor/terpene metadata
- the newly created strain records in that run were `Blue Lobster`, `Blue Nerds`, `Candyland`, `Durban Poison x Cherry Tart`, `Fatso Jealousy`, `Fire OG`, `Headband`, `Mango Dog x White Runtz`, `Novarine`, `SFV OG`, `Sour Apple x Lemon Cherry Gelato`, `The Original Z`, and `Zonuts`
- sparse `store.product.group.edit` payloads that only sent `id`, optional `strainId`, and `effectIds` left existing group `flavorings` and `scents` untouched when those fields were omitted

## Catalog Enumeration And Duplicate Checking

Two read-only endpoints were useful for checking whether a candidate catalog row already existed before creating anything new:

- `store.product.list.short` for variant-level enumeration
- `store.product.group.list` for product-group summaries

Observed `store.product.list.short` request shape:

```json
{
  "auth": "<token>",
  "name": "store.product.list.short",
  "params": {
    "page": 1,
    "pageSize": 500,
    "reload": false,
    "advancedSearch": true
  },
  "id": "<uuid>"
}
```

Observed response fields on each variant included:

- product `id`
- full variant `name`
- `productGroup.id` and `productGroup.name`
- `brand`, `category`, `subcategory`, `strain`, and `size`
- `tab`
- `price`
- `distributorProductPrice`
- `distributors`

Observed advanced-filter usage from the 2026-04-12 pre-packaged flower review HAR:

- `store.product.list.short` also accepted an advanced filter payload with `sortingColumns`, `categoryIds`, `subcategoryIds`, `packageTotalSize`, and `distributorProductPrice`
- one working request used:

```json
{
  "sortingColumns": [{"order": 10, "column": "price", "direction": "ascending"}],
  "packageTotalSize": {"uomId": 1, "from": 28},
  "distributorProductPrice": {"from": 1},
  "page": 1,
  "pageSize": 50,
  "reload": false,
  "advancedSearch": true,
  "categoryIds": [1088],
  "subcategoryIds": [1120]
}
```

Observed pricing-cost fallback nuance from the 2026-04-29 Bronx + Midtown full-catalog repricing packet run:

- current live `store.product.list.short`, `store.product.list`, and `store.product.group.get` responses in this workspace no longer reliably expose the old nonzero `distributorProductPrice` / `wholesaleCost` cost basis directly on the returned product rows
- in that run, mirrored `catalog_groups.live_state_json.products[].wholesaleCost` was `0` across the scoped packet rows even though live state-level distributor pricing still existed
- the reliable cost recovery path for pricing packets was `store.distributor.product.list { page, pageSize, productId }` from the state dealer context, then selecting the most recent nonzero row price from `productRecentPrices[]` or the dated `data[].pricesLists[]`
- practical rule: treat `store.product.list.short`'s `distributorProductPrice` filter as a useful scope guard when it still works, but do not assume the same response will carry the usable cost value; for current draft pricing, verify or recover the actual cost through `store.distributor.product.list` before concluding a row is truly missing cost

Observed packet-review submit/apply workflow from the same 2026-04-29 Bronx + Midtown repricing lane:

- the generated packet `index.html` can act as the approval surface itself when each row exposes a prefilled editable price field instead of forcing a separate prose-feedback pass
- serve that packet through a local HTTP review/apply service instead of opening the files directly with `file://`, so the HTML can submit the reviewed prices back to a sibling local endpoint on the same origin
- if the packet HTML is rerendered later from a locked `packet.json` snapshot, the local review/apply service also needs to read the current `packet.json` at request time instead of caching packet ids or counts only at process startup; otherwise the browser can serve the refreshed `index.html` while the POST endpoint still validates against an older in-memory packet id
- the same snapshot rerender can also remove the packet's `submissions/` directory, so the local review/apply service should recreate that ledger directory at write time instead of assuming the startup-time `mkdir` is still valid when the next submission arrives
- the local apply service should treat the submitted reviewed price as the operator-approved target, apply only rows whose reviewed price actually differs from the current live price, and leave same-price rows as explicit no-ops
- even in that simple one-off service, every live read or write block still needs a fresh verified `store.auth.dealer.set` against the state dealer before `store.product.edit` / `store.product.get` settlement polling
- on 2026-04-30, the live post-edit verification path for the Bronx + Midtown packet proved that current `store.product.get` responses can arrive wrapped as `{ product: { id, price, priceInfo, ... } }` rather than exposing `id` / `price` / `priceInfo` at the top level; settlement polling and any `store.product.get` verifier in this lane must unwrap that `product` object before parsing numeric ids or prices
- the apply service should keep an incremental JSON results ledger under the packet output directory so partial progress, live-before/live-after prices, and row-level failures are preserved if the browser is closed or the process stops mid-run
- on 2026-05-04, the legacy packet sidebar was brought in line with the Google-Ads review-tree pattern: each nav `details` node now carries a stable `data-nav-key`, sidebar visibility and tree open/closed state persist under packet-specific local-storage keys separate from review-state storage, and direct hash loads expand the matching ancestors plus highlight the active nav leaf
- on 2026-05-04, that sidebar tree was then extracted into the shared control family under `ui/controls/tree-nav/`; the packet still owns its review-state draft storage and review/apply flow, while the shared control now owns only reusable tree-nav rendering plus sidebar and tree-state behavior
- the same 2026-05-04 pass confirmed that the legacy packet's existing per-brand metadata controls are the canonical MSO edit point: use the `Brand metadata` toolbar inside a brand block or the mirrored panel on a detail page, and treat an unchecked MSO box as the default "not MSO" state; draft persistence should store only explicit `isMso: true` or brand-note entries rather than inventing all-brand defaults

Observed newer exact-unit-size filter shape from the latest 2026-04-12 HAR:

- `store.product.list.short` also accepted `uomNumber` for exact size-in-grams filtering
- a captured working request used:

```json
{
  "uomNumber": {"uomId": 1, "from": 14, "to": 14},
  "page": 1,
  "pageSize": 50,
  "reload": false,
  "advancedSearch": true,
  "categoryIds": [1088]
}
```

Additional practical implications:

- use `uomNumber` when the subset needs an exact package size such as `14g`, rather than a lower-bound filter like `packageTotalSize { from: 28 }`
- the same live request shape also worked with decimal gram sizes. On 2026-04-12, replaying `store.product.list.short` with `uomNumber { uomId: 1, from: 3.5, to: 3.5 }` plus the usual `Flower -> Pre-Packaged Flower -> distributorProductPrice { from: 1 }` guards returned the live 3.5g flower subset successfully.
- in this workspace, liters are represented through the same grams-style numeric filter model, so treat the field as Sweed's generic exact unit-size bucket rather than flower-only weight logic

Practical implication:

- this is enough to isolate a paid product subset such as `Flower -> Pre-Packaged Flower -> 28g+` for pricing or catalog review without needing a separate export flow
- the `store.product.list.short` filtered response does not include product-group images or descriptions, so if the review artifact needs the current catalog picture or storefront-copy presence, follow it with state-level `store.product.group.get { id }` reads for each unique group

## Filtered-Catalog Review Packet UI Notes

Observed reviewer preferences from the 2026-04-12 3.5g flower packet iteration:

- the dedicated reviewer-facing packet UI rules now live in `automation/UI_GUIDELINES.md`; update that file when these presentation patterns change in a durable way

- keep the top-of-page summary block collapsed behind a toggle by default rather than expanding all packet metadata immediately
- keep the main packet `<h1>` compact at no larger than `18px`
- the pricing column should prefer a compact post-tax price ladder over paragraph-heavy pricing text
- ladder UI should include explicit markers for our current, proposed, and market-average post-tax prices
- show the proposed GM inline in non-bolded parenthesis immediately after the proposed price headline above the ladder
- competitor dots should show detail on hover and use concise distance labels such as `0.22mi`
- for reviewer-facing packet UI in this workspace, competitor pricing should be presented post-tax rather than pre-tax
- for product-list packets, group rows in the precedence order `Category -> Subcategory -> Variant name -> Brand`, and make each layer independently collapsible behind its own labeled toggle
- clicking a packet row outside existing anchors should open a product detail page in a new tab
- when the packet row also carries inline review controls, make the product-title block itself an explicit link to that same detail page so reviewers can drill in without risking checkbox or price-input interaction
- when duplicate market prices make the compact ladder hard to read, the detail page should show a larger ladder plus an enumerated market-price list for that product, including explicit competitor product names and match-vs-equivalent cues
- treat that detail-page table as the full retained competitor listing set for the SKU, including display-only farther or statewide rows that stayed out of the near/mid pricing average

Observed approved 3.5g flower apply on 2026-04-13:

- live apply script: `bulk_additions/2026-04-10/apply_prepackaged_flower_3_5g_approved_packet.py`
- verification artifact: `bulk_additions/2026-04-10/prepackaged_flower_3_5g_approved_apply_results.json`
- the approved run completed all `266` locked packet rows in verified `Freshly Baked NY` state context with `0` failures
- the run applied price edits on `192` rows, updated `229` product groups, edited `198` strain records, created `148` exact strain rows, and created `7` missing strain-flavor dictionary rows
- the locked packet included two nonstandard packet-only image statuses (`needs-image-review` and `reuse-smalls-reference-image`), but the live apply safely ignored `imageAction` because it does not perform any image mutation in this workflow
- reviewer override spot-checks after the run confirmed live prices for `Canna Cure` `$45.00`, `Hepworth` `$29.00`, `Platinum Reserve` `$49.00`, `Herb` `$27.00`, `Jetpacks` `$66.50`, and `Real Life Botanicals Lemon Cherry Gelato 3.5g` `$35.00`

Observed `store.product.group.list` request shape:

```json
{
  "auth": "<token>",
  "name": "store.product.group.list",
  "params": {
    "enabled": true,
    "page": 1,
    "pageSize": 500,
    "reload": false
  },
  "id": "<uuid>"
}
```

Important duplicate-checking rule from the live catalog:

- `store.product.group.list` is not a safe uniqueness key
- the same normalized brand + full product-group name can appear under multiple group IDs
- for Hepworth flower, `Durban Poison x Cherry Tart` appeared as two separate product groups: `97118` with tab `28g` and `97121` with tab `3.5g`
- duplicate checks should therefore happen at the variant level with `store.product.list.short`, then drill into `store.distributor.product.list` for any existing distributor links

Practical matching rule that worked here:

- compare brand + normalized product-group name + category + unit size first
- treat subcategory as supportive context, not a sole key, because some older rows had `subcategory: null`
- use strain only as supporting evidence, not as the canonical duplicate key, because strain labels were sometimes legacy, approximate, or absent
- if the exact variant already exists, do not create a new group or variant; add only the missing distributor product for the correct distributor
- if the exact group already exists but the requested unit size does not, add only the missing variant to that group

Observed refinement from purchase order `108225` on 2026-04-11:

- query-driven `store.product.list.short` checks were enough to prove or disprove exact variant-name matches, but follow-up `store.product.group.get` reads were needed to confirm category and subcategory when a nearby same-name row existed
- an existing product-group name does not imply an exact strain dictionary row exists
- the state-level catalog already had Puff group `185666` / product `240432` named `Puff Lemon Lime Twist 1g`, but that row was `Vapes / Cartridge` and its group strain was generic `Hybrid`
- a direct `store.product.strain.list { query: "Lemon Lime Twist" }` check still returned no exact strain row

Practical implications:

- treat same-name hits in the wrong category as collision evidence, not reuse evidence
- check the strain dictionary separately instead of inferring exact strain-row availability from an existing group or product name

Confirmed duplicate-check example from the live catalog:

- draft candidate `Hepworth / Durban Poison x Cherry Tart / Flower / Pre-Packaged Flower / 3.5g`
- exact existing variant already present as product `108378`
- that product belonged to group `97121`
- it already had a distributor-product link, but only to disabled distributor `633` (`HR Botanical Distributor LLC`)
- it did not yet have a distributor-product link to the newer `HR BOTANICAL DISTRIBUTION LLC` records used elsewhere in this workspace

This means some “missing product” situations are actually “existing variant but missing current distributor-product mapping” situations.

Confirmed reuse examples from the live catalog:

- `SFV OG` already existed as Hepworth vape group `37363` with a `1g` variant, so the correct action for the new `0.5g` row was to add a variant under that existing group rather than create another `SFV OG` group
- after creating Hepworth `GG4` `0.5g` vape group `291516`, the correct action for the `1g` row was to add another variant under group `291516`, not create a second `GG4` vape group

## Category Pattern Notes For Current Hepworth Backfill

Observed pattern for current Hepworth vape entries:

- standard 510 carts used category `Vapes` + subcategory `Cartridge`
- live resin carts still used quality line `Oil for Vaporization` and tag `Oil for Vaporization`
- the distinguishing field for live resin vape carts was subcategory `Live Resin Cartridge`

Observed pattern for current Hepworth flower eighths:

- category `Flower`
- subcategory `Pre-Packaged Flower`
- quality line `Cannabis Flower Products`
- tag `Cannabis Flower Products`

## Beverage Category Migration

Observed live catalog migration on 2026-04-11:

- the catalog had 42 beverage product groups under category `Edibles` (`1086`) with subcategory `Beverages` (`1104`)
- the store also had a newer top-level category `Beverages` (`6521`)
- category `6521` had no subcategories and reported `isProductQualityLineEnabled: false`
- the migrated groups still read back with quality line `Beverages` (`227`) after the move

Confirmed working move flow:

1. switch the session to the state catalog holder with `store.auth.dealer.set { dealerId: 210248 }` for `Freshly Baked NY`
2. enumerate the old beverage groups with `store.product.group.list { enabled: true, page: 1, pageSize: 1000, reload: false, categoryIds: [1086], subcategoryIds: [1104] }`
3. move each group with `store.product.group.edit { id, categoryId: 6521, subcategoryId: null }`
4. verify with `store.product.group.get { id }` or a reloaded list query

Important notes from that migration:

- omitting `subcategoryId` was not tested; the confirmed safe payload explicitly sent `subcategoryId: null`
- the first aggregate list read immediately after the batch returned stale counts until the follow-up query used `reload: true`
- once reloaded, the old `Edibles -> Beverages` bucket was empty and all 42 groups appeared under category `Beverages` (`6521`)
- by later on 2026-04-11, category `Beverages` (`6521`) had gained subcategory `Tinctures` (`6522`)
- moving `Edibles -> Tinctures` groups into the new structure worked with `store.product.group.edit { id, categoryId: 6521, subcategoryId: 6522 }`
- that tincture move preserved the existing `Oral Liquids` quality line on the affected groups

## Import CSV Authoring Heuristics

When preparing product-creation CSVs from distributor or purchase-order names, the source item name usually needs to be split into Sweed's component parts rather than copied literally.

Working rule:

- the incoming distributor product name is usually not the final catalog display name
- the final display name is programmatically constructed from brand, product group name, and variant attributes
- the CSV should therefore capture the pieces Sweed needs, not just the raw incoming string
- for variant naming, default to Sweed's unit-size-based label unless there is a reason to override it
- `NameIfSet` is mainly for cases where the operator wants a custom variant label instead of the default unit size
- the confirmed current convention for pre-roll multipacks is `${QTY}x ${SIZE}`, for example `20x 0.35g`
- for non-multipack items such as single carts or flower eighths, leave `NameIfSet` blank and let Sweed use the unit size as the variant name

Observed example for pre-roll multipacks:

- incoming distributor name: `Hepworth 0.35g 20pk [7g] PreRoll - Durban Poison x Cherry Tart`
- likely product group name: `Durban Poison x Cherry Tart`
- likely category: `Pre-Rolls`
- likely subcategory: `Multi-Pack`
- likely variant label: `20x 0.35g`
- likely `NameIfSet`: `20x 0.35g`
- likely pack count: `20`
- likely unit size: `0.35g`

Observed example for carts:

- incoming distributor name: `Hepworth 1.00g 510 Vape Cart - GG4`
- likely product group name: `GG4`
- likely category: `Vapes`
- likely subcategory: `Cartridge`
- likely `NameIfSet`: blank
- likely unit size: `1g`

Observed example for flower:

- incoming distributor name: `Hepworth 3.5g Bagged Flower - Blue Nerds`
- likely product group name: `Blue Nerds`
- likely category: `Flower`
- likely subcategory: `Pre-Packaged Flower`
- likely `NameIfSet`: blank
- likely unit size: `3.5g`

This decomposition is a critical part of producing clean imports that will create the intended catalog structure.

## Draft Pricing Heuristic For Catalog Backfill

When backfilling missing products from purchases, a working pricing heuristic used in this session was:

```text
margin = 1 - 1.13 * cost / price
```

This assumes out-the-door pricing and bakes tax into the margin target.

Working target:

- aim for roughly 55% to 67.5% margin
- keep categorically equivalent items by brand with the same cost and size at the same outgoing price
- whole-quarter-dollar pricing is acceptable
- prefer `.00` and `.50` endings over `.25` and `.75` when the price can still satisfy the competitor and GM rules that way
- whole-dollar pricing is mildly preferred when it still lands in the target band
- when a competitor average exists, prioritize landing a few percent below the post-tax competitor equivalent `1.13 * average_competitor_price`; allow GM to fall below the usual floor only when that competitor-led target is lower than the GM-floor minimum

Examples used in this session:

- cost `6` -> price `18` for `0.5g` Hepworth carts
- cost `13` -> price `35` for `1g` Hepworth carts and `3.5g` flower
- cost `20` -> price `55` for `1g` live resin vape products

This is a drafting heuristic, not a confirmed Sweed rule.

## Nearest-Match Strain Strategy

The exact marketed strain name on distributor packaging does not always appear to exist as a strain entry in the captured Sweed dictionary.

When that happens, one practical strategy is to choose the nearest existing strain label rather than blocking the import immediately.

Draft examples from this session:

- `GG4` -> `Gorilla Glue #4`
- `Original Z` -> `Zkittles`
- `Blue Nerds` -> `Blue Dream`
- `Sour Apple x Lemon Cherry Gelato` -> `Lemon Cherry Gelato`
- `SFV OG` -> `OG Kush`

This should be treated as a temporary operating heuristic only.

It is useful when trying to predict how an experienced operator might keep work moving, but it is not a substitute for learning how to create new strain entries when needed.

## Duplicate Distributor Names

Distributor display name is not a stable unique key.

We found multiple distributor rows for what appears to be the same business:

- `HR BOTANICAL DISTRIBUTION LLC` -> `3253` with license `OCM-DIST-24-000114-DX2`
- `HR BOTANICAL DISTRIBUTION LLC` -> `4242` with license `OCM-DIST-24-000114-DX1`
- `HR Botanical Distributor LLC` -> `633` with license `OCM-DIST-24-000114` and `enabled: false`

Implications:

- A script should not key distributors by name alone.
- Prefer Sweed distributor ID or license number in source data.
- If source data only contains a name, automation must either create entries for all exact matches or fail loudly on ambiguity.
- When reusing an existing catalog variant, inspect `store.distributor.product.list` before creating a new product. The variant may already exist but only be linked to an older or disabled distributor record.
