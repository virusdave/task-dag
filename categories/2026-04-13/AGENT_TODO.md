# AGENT TODO

## Goal

- Design a migration from the current Dutchie-import hybrid catalog into a structure that better fits Sweed's native family/variant/distributor-product model.
- Ground the migration plan in live state-catalog evidence, current Sweed help-center model documentation, and the durable workspace rules in `automation/AGENTS_MUST_KNOW.md` and `automation/HOW_SWEED_WORKS.md`.
- Keep catalog work state-level and preserve the standing rule that each operation block must explicitly call `store.auth.dealer.set` before reads or writes.

## Current State

- The latest task was analysis-first, not a live catalog mutation. No live catalog writes were made in this pass.
- A new read-only state-catalog scan script now exists in the current directory:
- `categories/2026-04-13/generate_live_catalog_migration_report.py`
- The script reuses the verified Sweed RPC helper from `bulk_additions/2026-04-10/apply_product_catalog_attribute_updates.py`, switches into dealer `210248` (`Freshly Baked NY`), pages the live state catalog, and emits source-regenerated JSON and Markdown artifacts.
- Fresh generated migration artifacts now exist:
- `categories/2026-04-13/live_catalog_migration_analysis.json`
- `categories/2026-04-13/live_catalog_migration_analysis.md`
- Latest successful generation timestamp: `2026-04-14T20:40:26Z`.
- Live scan summary from those artifacts:
- `2977` enabled product groups
- `3193` variants
- `2770` single-variant groups (`93.0%`)
- `201` multi-variant groups
- `236` repeated family clusters sharing the same `brand + category + group name`
- `116` clean size-split clusters
- `96` repeated-tab duplicate-family clusters
- `48` mixed partially consolidated clusters
- `12` groups already containing duplicate same-tab variants inside one family
- `1457` groups still carrying generic strain labels
- `1007` groups with null subcategory, concentrated in `Pre-Rolls` (`689`) and `Vapes` (`266`)
- The generated report also captures category-level structure, cluster summaries, detailed sampled cluster reads, and a phased migration path.
- The strongest migration finding is structural: the live catalog is still much closer to a one-group-per-size Dutchie import shape than to Sweed's intended one-family/many-variants shape.
- The highest-yield safe migration opportunity is the `116` clean size-split clusters.
- The biggest blocker to aggressive bulk merges is lane ambiguity in `Pre-Rolls` and `Vapes` because of the large null-subcategory population.
- Spot-check evidence recorded during the scan showed that same-name families are not metadata-identical. Examples already captured in the durable notes:
- `Grass Roots / Flower / Alien OG` split across `3.5g` and `7g` groups with different strain/description completeness
- `Heavy Hitters / Vapes / Acapulco Gold` split across separate `1g` groups plus `0.5g`, with exact strain on one row and generic strain on others
- `Ayrloom / Vapes / Apple Fritter` already partly consolidated in one richer family, but still has an extra single-variant duplicate group beside it
- Product-type signals exist in the live account (`store.product.type.list` returned enabled rows), but the sampled naming-cue rows still came back with `type: null` on `store.product.group.get`; visible form cues like `Smalls`, `Blunt`, `Hash Hole`, `AIO`, and `Cart` are still often encoded only in names.
- Durable docs were updated to preserve the migration findings:
- `automation/HOW_SWEED_WORKS.md` now includes a `Live Catalog Migration Baseline (2026-04-14)` section with the structural scan metrics and migration implications.
- `automation/AGENTS_MUST_KNOW.md` now warns not to auto-merge same-name families before classifying the lane and to choose canonical groups deliberately because duplicate groups can carry different family metadata.
- A second read-only generator now exists for the null-subcategory lane packet:
- `categories/2026-04-13/generate_null_subcategory_lane_classification_packet.py`
- Fresh generated lane-classification artifacts now exist:
- `categories/2026-04-13/null_subcategory_lane_classification_packet.json`
- `categories/2026-04-13/null_subcategory_lane_classification_packet.csv`
- `categories/2026-04-13/null_subcategory_lane_classification_packet.html`
- `categories/2026-04-13/null_subcategory_lane_classification_packet_details/`
- Latest successful lane-packet generation timestamp: `2026-04-19T01:24:03Z`.
- Lane-packet summary from those artifacts:
- `955` target null-subcategory groups total
- `689` in `Pre-Rolls`
- `266` in `Vapes`
- Prerolls: `73` likely `Infused` (`53` auto/high-confidence, `20` provisional from opening-description cues), `616` provisional plain / `<none>`
- Vapes: `126` classified `Cartridge`, `122` classified `All In One / Disposable`, `9` classified `Pod`, `9` left manual
- Same-name cluster status inside the packet:
- Prerolls: `168` same-lane clusters, `510` single-group rows, `11` mixed-lane clusters
- Vapes: `37` same-lane clusters, `184` single-group rows, `43` mixed-lane clusters, `2` clusters still needing manual lane review
- The packet also preserved durable heuristics that matter for future work:
- full preroll descriptions are too noisy for unrestricted infused detection because copy can mention sibling infused formats; safer preroll lane inference should stay anchored to names plus the opening description text
- vape device inference can use same-name sibling lanes first, then explicit device cues (`cartridge`, `pod`, `AIO`, `Briq`, `USB-C`, `battery life`), and only then a provisional brand-single-lane default when the brand already has at least two explicit device-lane groups in the live catalog

## Important Remaining Issues

- The current scan/report is analysis only. There is not yet a machine-generated write plan for which specific groups should survive, which should donate variants, and which are too risky for automatic consolidation.
- The null-subcategory problem is still large enough that a naive same-name merge in `Pre-Rolls` or `Vapes` would be dangerous, even after the lane packet.
- Repeated-tab clusters and same-group duplicate-tab variants need a different remediation path from clean size-split clusters.
- The preroll packet is mostly a positive-evidence infused isolate plus a very large provisional plain queue; it is not proof that every `<none>` preroll is safe for automatic consolidation.
- The lane packet reduced the vape ambiguity sharply, but `9` vape groups still need manual device review (`Animal Durban Poison`, `Holiday Vapes` Airplane Mode / Golden Hour / Leisure / Nightcap, `Jetty Maui Wowie`, `Eureka Lemonatti`, and the two `Florist Farms Northern Lights` rows).
- Mixed-lane same-name families remain an explicit blocker for auto-merges. Important packet examples include `Animal / Apple Pop`, `Ayrloom / Apple Fritter`, and `Heavy Hitters / Acapulco Gold`, where the same family name still spans cartridge and all-in-one lanes.
- Family consolidation and distributor/purchase reassignment are still separate problems. Even after catalog cleanup, purchase-side and distributor-product rows may remain partially detached.
- The generated packet is sufficient to start the canonical-family selection queue, but it is still not a live write plan.

## Recommended Next Steps

- Review and resolve the `9` manual vape rows in the lane packet so the remaining `needs-manual-review` / `needs-manual-lane-check` families stop blocking family-level consolidation.
- Use the new lane packet to seed the canonical-family selection queue for the `116` clean size-split clusters, starting with same-name clusters that are now lane-aligned (`same-lane`) instead of mixed-lane.
- Build a separate exclusion or review queue for the `43` mixed-lane vape clusters and `11` mixed-lane preroll clusters so they stay outside any auto-merge or auto-survivor selection pass.
- Build a separate duplicate-variant reconciliation queue for the `96` repeated-tab clusters and the `12` groups that already contain duplicate same-tab variants inside one family.
- After the structural family queue exists, design a second-pass metadata normalization plan for the surviving canonical groups: exact strain, description/image preservation, and any product-type/subcategory cleanup for visible form cues.
- Keep distributor-product and purchase-position remapping as a later operational phase after catalog-family consolidation is defined.

## Useful References

- New live scan generator:
- `categories/2026-04-13/generate_live_catalog_migration_report.py`
- Generated migration artifacts:
- `categories/2026-04-13/live_catalog_migration_analysis.json`
- `categories/2026-04-13/live_catalog_migration_analysis.md`
- Lane-packet generator and artifacts:
- `categories/2026-04-13/generate_null_subcategory_lane_classification_packet.py`
- `categories/2026-04-13/null_subcategory_lane_classification_packet.json`
- `categories/2026-04-13/null_subcategory_lane_classification_packet.csv`
- `categories/2026-04-13/null_subcategory_lane_classification_packet.html`
- `categories/2026-04-13/null_subcategory_lane_classification_packet_details/`
- Durable knowledge base updates:
- `automation/HOW_SWEED_WORKS.md`
- `automation/AGENTS_MUST_KNOW.md`
- `automation/docs/sweed/catalog/model-and-migration.md`
- Help-center evidence used for the underlying Sweed model translation:
- `categories/2026-04-13/Product Catalog _ Sweed Help Center.pdf`
- `categories/2026-04-13/help.sweedpos.com_Archive [26-04-13 18-56-50].har`
- Verified live RPC helper/auth path reused by the scan:
- `bulk_additions/2026-04-10/apply_product_catalog_attribute_updates.py`

## Larger Goal

- Move from ad hoc imported catalog cleanup to a disciplined Sweed-native migration workflow: classify family lanes, consolidate true families into one product group with multiple variants, deduplicate repeated tabs, preserve the best shared metadata on canonical groups, and only then address distributor-product and purchase-side remapping.
