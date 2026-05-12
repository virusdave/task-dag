# Sweed Catalog Model And Migration Constraints

Load this when the task is about understanding the catalog model, deciding where data belongs, or planning family/variant migrations.

Source: `HOW_SWEED_WORKS.md`

## Help-Center Catalog Model Versus RPC Model

From the local help-center evidence captured on 2026-04-13 and 2026-04-14:

- `categories/2026-04-13/Product Catalog _ Sweed Help Center.pdf`
- `categories/2026-04-13/help.sweedpos.com_Archive [26-04-13 18-56-50].har`, which contains the full `https://help.sweedpos.com/en/articles/4797685-product-catalog` article HTML
- `categories/2026-04-13/help.sweedpos.com_Archive [26-04-14 08-51-22].har`, which confirms the article still sits under the `Getting Started on Sweed` help collection even though that newer capture only loaded the collection landing page

The help-center article uses UI-facing terminology that is close to, but not identical with, the RPC model we have been using.

Documented help-center definitions:

- a help-center `product` is the family-level item that can contain multiple sizes and types
- a help-center `variant` is one specific size or type of that item
- example given by Sweed: a flower product such as `Sour Diesel Premium` can have variants `1g`, `3.5g`, `7g`, `14g`, and `28g`

Best current translation into the observed RPC model:

- help-center `product` maps most closely to our API `product group` plus its shared family attributes
- help-center `variant` maps most closely to the sellable API `product` row created by `store.product.add`
- help-center `variant costs` map most closely to one or more `distributor product` rows plus their dated wholesale prices attached to that sellable variant

This translation matches the live write flow already captured elsewhere in this document:

1. create a family with `store.product.group.add`
2. create one or more sellable variants with `store.product.add { productGroupId, sizeId, packOfSize?, ... }`
3. attach distributor-specific supply rows with `store.distributor.product.add`
4. attach wholesale history with `store.distributor.product.price.add`

Practical implication:

- for migration design, treat the Dutchie-import problem first as a family-versus-variant normalization problem, not just a naming cleanup problem
- a distributor SKU is not the same thing as a catalog family, and a catalog family is not the same thing as a site purchase row

## Documented Catalog Structure And Constraints

The help-center article and the PDF's `Product Map` diagram add several important model constraints that line up with our live API findings.

### Family-level identity

The documented product-map fields included:

- quality line
- strain prevalence
- category
- brand
- product name
- product type
- variants
- strain
- terpenes
- flavors
- effects
- description

Taken together with our live RPC captures, the current best model is:

- family-level identity lives on the product group side: brand, base name, category, subcategory, type, strain/effects/flavorings/scents, descriptions, images, and other shared merchandising metadata
- variant-level identity lives on the sellable product side: unit size, package count, public variant tab/name, price, and ecommerce sellability flags
- supply-side history lives on distributor-product rows: distributor linkage, distributor-facing item name, and wholesale price history

This is consistent with the live evidence that:

- `store.product.group.get` carries `strain`, `effects`, `flavorings`, `scents`, descriptions, images, and category capability flags
- `store.product.add` requires variant fields such as `sizeId`, `packOfSize`, `allowedSaleTypeId`, and `price`
- `store.distributor.product.add` attaches a distributor-facing row to one existing sellable product variant, not to the whole family

### Product naming is assembled from parts

The help-center article explicitly says product names are dynamically generated from attributes and that the exact concatenation changes by surface.

Documented naming behavior:

- Store Portal product list: `Brand + Quality Line + Name + Product Type`
- Discount engine, cashier cards, pre-receipts, and customer receipts: `Brand + Quality Line + Name + Product Type + Variant`
- E-commerce menu and cart: `Name + Product Type`, or just `Name` when no product type is selected

Important implications for migration work:

- product type is a customer-visible differentiator and should not be treated as a purely internal taxonomy field
- subcategory is not the primary customer-facing differentiator; the article explicitly contrasts it with product type and says product type is what users and staff see in several selection/reporting surfaces
- do not stuff size, distributor, or other supply-side noise into the family name just to mimic a Dutchie import label, because Sweed already assembles display names from structured parts

### Category is a rules container, not just a label

The help-center article says each category defines:

- limit type
- class
- legal age
- allowed sizes
- allowed product types
- allowed subcategories

This matches our live lookup-heavy workflow and is a durable migration constraint:

- category membership controls which size IDs, type IDs, and subcategory IDs are even valid for a family/variant
- category cleanup is therefore structural, not cosmetic; moving a family between categories can change the allowable size/type lattice and purchase-limit behavior
- a migration plan should validate category fit before any bulk family consolidation, especially where Dutchie-shaped imports may have overloaded names instead of using Sweed's typed fields

### Product type and subcategory serve different purposes

The help-center article makes two distinctions that matter a lot for catalog redesign:

- a product type can be reused across multiple categories, while a subcategory belongs to one category only
- product type is included in customer-visible naming, while subcategory is not

The article's example is exactly the kind of hybrid-catalog problem we need to unwind:

- `buds`, `littles`, and `shake` should be product types so customers see `Gorilla Glue Buds` and `Gorilla Glue Shake`
- those differences should not be hidden as subcategories when the real goal is to distinguish otherwise similar sellable families

Practical implication:

- if our imported Dutchie catalog encoded visible merchandising differences in family names or one-off subcategories, the Sweed-native target shape should usually move those differences into shared product-type dictionaries where possible

### Brand and distributor are intentionally separated

The help-center article states that:

- each product has a brand
- each variant has a list of distributors
- the brand is the producer
- the distributor is the licensed business that sold the item to the retailer
- those are not always the same entity

This lines up with our live RPC observations:

- brand is resolved while building the family/product-group record
- distributor-product rows attach later, per sellable variant
- multiple distributor-product rows can safely coexist for the same sellable variant when the supply side differs but the customer-facing variant is the same

Migration implication:

- do not preserve a one-distributor-one-product catalog shape just because the imported source behaved that way
- the more Sweed-native shape is many distributor-product rows converging onto a reusable state-level variant whenever the underlying customer-facing item is the same

### Variant cost is supply-side and state-wide

The help-center article's `Most Recent Cost` section adds several durable constraints:

- the most recent cost is computed from distributor-product history across any store in the state
- if several costs exist in one purchase, the highest is used
- if there are no purchases, Sweed falls back to the most recently created distributor product
- trade-sample costs are excluded
- these costs apply only to non-integrational purchases and do not affect purchases made through integrations

This is a strong sign that Sweed keeps supply history partly separate from catalog identity:

- a variant can outlive individual distributor-product rows and still accumulate a state-wide cost story
- integrated purchase behavior can remain partially detached from the manual distributor-product state we create or edit
- catalog normalization alone does not guarantee purchase-side remapping, which matches the live suggestion-endpoint caveats already captured in this document

## Migration Principles For The Current Hybrid Catalog

These are the current best migration-design principles supported by both the help-center model and our live RPC evidence.

- Normalize around one product-group family per real consumer-facing item, then add multiple sellable variants under that family for size and pack-count differences.
- Use product types for customer-visible distinctions such as `buds`, `littles`, `shake`, or similar format/finish differences when Sweed intends those to appear in assembled names.
- Use subcategories for within-category taxonomy and workflow/reporting structure, not as the main substitute for visible naming.
- Keep brand, family metadata, strain/effects/flavorings/scents, descriptions, and images on the family/product-group side.
- Keep size, pack count, saleability, public variant tab, and retail price on the sellable variant/product side.
- Keep distributor-specific names and cost history on distributor-product rows instead of cloning the same catalog family once per distributor.
- Treat purchase-order positions and inventory items as site-level operational records that may lag behind or stay partially detached from a cleaned-up state catalog.
- When undoing Dutchie-shaped imports, prefer removing supply-side noise from catalog identity rather than copying raw external item strings deeper into the family name.

## Live Catalog Migration Baseline (2026-04-14)

From the read-only state-catalog scan generated by:

- `categories/2026-04-13/generate_live_catalog_migration_report.py`
- `categories/2026-04-13/live_catalog_migration_analysis.json`
- `categories/2026-04-13/live_catalog_migration_analysis.md`

Observed live snapshot in dealer `210248` (`Freshly Baked NY`):

- `2977` enabled product groups
- `3193` variants
- `2770` single-variant groups (`93.0%` of all groups)
- only `201` multi-variant groups
- `236` repeated family clusters where the same `brand + category + group name` exists under multiple group IDs
- within those repeated-family clusters:
  - `116` were clean size-split families, meaning multiple single-variant groups looked mergeable into one Sweed-native family with tabs such as `3.5g`, `14g`, and `28g`
  - `96` had repeated tabs across groups, so they require duplicate-variant reconciliation rather than a simple merge
  - `48` were mixed states where one family was already partly consolidated but still had extra split groups
- `12` groups already contained duplicate same-tab variants inside one family
- `1457` groups still carried generic strain labels such as `Hybrid`, `Indica`, or `Sativa`
- `1007` groups had null subcategory, heavily concentrated in `Pre-Rolls` (`689`) and `Vapes` (`266`)

Practical implication:

- the current live catalog is still structurally closer to a Dutchie-style one-row-per-size import than to Sweed's intended family-plus-variant model
- the best first migration pass is not metadata enrichment; it is structural family consolidation, lane classification, and duplicate cleanup

### Family consolidation needs metadata arbitration

The same live scan also showed that duplicate groups are not always exact copies at the family-metadata layer.

Observed examples from `store.product.group.get` spot checks:

- `Grass Roots / Flower / Alien OG` existed as separate `3.5g` and `7g` groups; one group had `strain: null` and no description, while the other had `strain: Indica` plus richer copy
- `Heavy Hitters / Vapes / Acapulco Gold` existed as two separate `1g` groups plus one `0.5g` group; one row carried exact strain `Acapulco Gold`, while the others carried generic `Sativa`
- `Ayrloom / Vapes / Apple Fritter` already had one richer consolidated family with tabs `0.3g`, `0.5g`, and `1g`, but an extra single-variant `1g` group still existed alongside it

Practical implication:

- do not auto-merge same-name groups by ID alone
- a migration run needs a canonical-family choice that explicitly keeps the richest strain/description/image payload before moving or deduplicating variants

### Null subcategory is a migration blocker in form-sensitive lanes

The live counts make subcategory cleanup a precondition for safe consolidation in some categories:

- `Pre-Rolls` had `689 / 948` groups with null subcategory
- `Vapes` had `266 / 608` groups with null subcategory
- `59` of the clean size-split clusters included at least one group with null subcategory

Practical implication:

- classify pre-roll and vape families into explicit lanes before bulk merges
- otherwise a same-name family can collapse distinct sellable forms such as infused vs non-infused pre-rolls or cartridge vs disposable vapes

### Null-subcategory lane packet baseline (2026-04-19)

From the read-only lane packet generated by:

- `categories/2026-04-13/generate_null_subcategory_lane_classification_packet.py`
- `categories/2026-04-13/null_subcategory_lane_classification_packet.json`
- `categories/2026-04-13/null_subcategory_lane_classification_packet.csv`
- `categories/2026-04-13/null_subcategory_lane_classification_packet.html`

Observed live null-subcategory scope in dealer `210248` (`Freshly Baked NY`):

- `955` target groups total
- `689` null-subcategory `Pre-Rolls`
- `266` null-subcategory `Vapes`

Preroll lane packet results:

- `73` groups were isolated as likely `Infused`
- `53` of those infused calls were high-confidence `auto` rows
- `20` more were provisional infused calls driven by cues in the opening description window
- the remaining `616` preroll groups stayed provisional plain / `<none>` because no infused cue appeared in the family name, variant names, or opening description text
- same-name preroll clusters touching null-subcategory groups broke down into `168` already same-lane clusters, `510` single-group rows, and `11` mixed-lane clusters

Important heuristic finding from that pass:

- full preroll descriptions are too noisy for unrestricted infused detection, because merchandising copy can mention sibling infused formats even when the current group itself is a plain pre-roll
- safer preroll lane inference should stay anchored to family names, variant names, and only the opening description text rather than scanning the full description body

Vape lane packet results:

- `126` null-subcategory vape groups classified to `Cartridge`
- `122` classified to `All In One / Disposable`
- `9` classified to `Pod`
- only `9` remained manual-review rows after device-cue, same-name-sibling, and brand-single-lane heuristics
- same-name vape clusters touching null-subcategory groups broke down into `37` same-lane clusters, `184` single-group rows, `43` mixed-lane clusters, and `2` clusters still needing manual lane review

Observed same-name mixed-lane vape examples from the packet:

- `Animal / Apple Pop` split between cartridge and all-in-one families
- `Ayrloom / Apple Fritter` split between cartridge and all-in-one families
- `Heavy Hitters / Acapulco Gold` split between cartridge and all-in-one families

Durable heuristic from that pass:

- vape lane inference can safely use same-name sibling device lanes first, then explicit device cues such as `cartridge`, `pod`, `AIO`, `Briq`, `USB-C`, or `battery life`
- after that, a brand can provide a provisional default only when the current live catalog already shows one explicit device lane across at least two classified groups for that brand; thin one-example brands should stay manual

Practical implication:

- the manual vape queue is now small enough for targeted family review instead of a repo-wide blind scan
- the preroll packet is best treated as a positive-evidence infused isolate plus a larger provisional plain queue, not as proof that every `<none>` preroll is safe for automatic consolidation
- same-name clusters that still show mixed lanes after packet generation should stay outside any automatic family-merge queue

### Product-type concepts exist, but sampled live rows still embed them in names

Observed from the same scan:

- `store.product.type.list` returned enabled type dictionary rows in this account, so the product-type concept exists in the live system
- sampled naming-cue rows such as `Slurricane Smalls`, `Blue Dream Blunt`, `Hash Hole Dream Queen`, `AIO Alien OG`, and `Live Resin Cart Biscotti` all still read back with `type: null` on `store.product.group.get`

Practical implication:

- if the business wants Sweed-native customer-visible differentiation, some repeated form cues currently embedded in names should eventually move into product-type or tighter subcategory structure instead of remaining name-only conventions
