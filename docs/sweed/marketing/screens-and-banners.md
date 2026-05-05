# Sweed Marketing Screens And Banners

Load this when you need to inspect or refresh in-store TV carousel screens and their banners.

## Canonical Operator Surface (2026-05-05)

- All screen-banner development and maintenance now belongs in Helios at `helios/`. Do not extend or revive bespoke standalone banner-touching scripts.
- The "30-second parallel banner/screen bounce" is a first-class Helios operator action. Queue it from the `/screens` page card "Queue 30-second banner/screen bounce" (or `POST /api/screens/banner-refresh` with `{ apply: true, intent: 'bounce', holdSeconds: 30 }`).
- The bounce job (`screens.banner_refresh` with `intent='bounce'`) writes structured `payload.progress` plus a `payload.progressLog` tail at every stage: `starting`, `banners_off`, `hold_started`, `hold_finished`, `reenable`, `finalize`, `completed`. `/screens` shows an inline progress bar; `/jobs/:jobId` shows the full live worker log tail and result summary.
- The bounce handler calls `page-dave` on completion (success or failure) so operators do not have to babysit the run.
- Older one-off banner scripts that predate the Helios takeover (over a week old as of 2026-05-05) have been renamed `DEPRECATED_*.py` with a header comment pointing at Helios. New banner work must not import or extend them.

Source: latest `automation/screens/prime.sweedpos.com_Archive [26-04-17 12-28-15].har` plus live verification on 2026-04-17.

## Dealer Scope

- screen-carousel work in this workspace is site-level, not state-level
- the Freshly Baked state dealer `210248` can be used first to expand the full accessible dealer list, then switch into each site dealer before reading or editing its screens
- on 2026-04-17, switching to state dealer `210248` exposed site dealers `210249` (`Freshly Baked NYC - The Bronx`) and `210705` (`Freshly Baked NYC - Midtown`) for the same session token

## Creative Proposal Rule

- for reviewer-facing or customer-facing banner, promo, or other screen creative, the proposal deliverable must be an actual generated image from an approved image-generating LLM path
- locally composed SVG/HTML/CSS layouts, vector approximations, or rasterized mockups do not count as generated creative and are not acceptable proposal-ready assets
- concept mockups are allowed only when the user explicitly approves a concept-only fallback first; label them as concept-only and do not present them as final or proposal-ready creative
- when the user explicitly authorizes the `painter` tool for this kind of creative, use `painter` as the default approved image-generation path rather than building another ad hoc render flow
- when the user provides specific logos, storefronts, pack shots, or other brand assets for that creative, the final visible proposal image must clearly include those supplied assets instead of treating them as loose inspiration
- if the approved image-generation path is unavailable, stop at concept discussion or escalate the blocker instead of silently shipping SVG-derived stand-ins

## Screen APIs

- `store.screen.carousel.list { page, pageSize }` returns a paged object with `page`, `pageSize`, `totalCount`, and `data[]`
- each screen row in `data[]` included at least `id`, `name`, `defaultDuration`, `totalScreenDuration`, `enabled`, and `readOnly`
- the captured UI request used `enabled: true`, but live reads on 2026-04-17 showed the endpoint also returned the same full set without that filter in this workspace
- `store.screen.carousel.edit { id, enabled }` successfully toggled a screen off and back on, and returned the updated screen object immediately

Observed Midtown example:

```json
{
  "id": 255,
  "name": "TV SE Over Kiosks",
  "defaultDuration": 10,
  "totalScreenDuration": 175,
  "enabled": true,
  "readOnly": false
}
```

## Banner APIs

- `store.screen.carousel.banner.list { screenId }` returned all banners on the screen, including disabled rows, with no paging in the observed responses
- each banner list row included at least `id`, `name`, `screenId`, `type`, `ordering`, `enabled`, `cronExpression`, `fromDate`, `preview`, `totalDuration`, and `usePromoHeader`
- `store.screen.carousel.banner.get { id }` returned the full editable banner detail, including the fields needed to replay an `edit`
- `store.screen.carousel.banner.edit` is the main write path for banner refresh toggles
- `store.screen.carousel.banner.add` is the create path for carousel banners
- `store.screen.carousel.banner.delete { id }` cleanly removed temporary test banners during live verification on 2026-04-18
- `store.screen.carousel.banner.promo.list` is the practical eligibility check for direct promo-backed screen banners; if a promo row's `media` object is empty (`{}`), the promo does not currently expose screen-usable artwork even if `usePromoHeader: true` is set on the banner

Observed minimal banner-edit payload shape from live UI saves:

- common fields: `id`, `enabled`, `typeId`, `fromDate`, `toDate`, `promoActionId`, `usePromoHeader`
- the UI also sent filter-like fields even when empty: `brands`, `categories`, `products`, `productGroups`, `qualityLines`, `sizes`, `subCategories`, `productTypes`, `minWholesaleCost`, `maxWholesaleCost`
- on 2026-04-17, some `store.screen.carousel.banner.get` responses returned those selector fields as arrays of objects like `{ id, name }`, but `store.screen.carousel.banner.edit` expected plain ID arrays such as `categories: [1085, 1086, ...]`
- product-menu banners additionally carried `layoutTypeId`, `productsDisplayed`, `cronExpression`, `fromTime`, and `toTime`
- product-menu banners also use `productsDisplayed` to control how many products appear per page; live edits on 2026-04-23 accepted `productsDisplayed: 3` and immediately changed rendered duration/page count
- image banners did not need `duration`, `name`, `ordering`, or media IDs in the observed toggle-only edits; the server preserved those values when only the toggle payload was submitted

Observed image-banner add shape from live creation on 2026-04-18:

- required fields were at least `screenId`, `name`, `typeId`, `enabled`, `ordering`, and `fromDate`
- `duration` is optional for image banners; if omitted, Sweed defaulted the banner to `totalDuration: 10`
- `mediaId` accepted a blob/media UUID and attached the referenced image to the new banner
- example working payload:

```json
{
  "screenId": 255,
  "name": "Temp Media Test",
  "typeId": 1,
  "enabled": false,
  "ordering": 12,
  "fromDate": "2026-04-18",
  "duration": 3,
  "mediaId": "f08a7230-42dd-45f5-9cbf-48c3a522200a"
}
```

Observed image-banner detail example:

```json
{
  "id": "2079",
  "name": "Now Hiring",
  "screenId": 255,
  "type": {"id": 1, "name": "Image"},
  "duration": 15,
  "enabled": true,
  "fromDate": "2026-04-05T00:00:00Z",
  "totalDuration": 15
}
```

Observed product-menu detail example:

```json
{
  "id": "2086",
  "name": "Spaced Out Sampler - $150 Jetpacks bundle",
  "screenId": 255,
  "type": {"id": 3, "name": "Product menu"},
  "layoutType": {"id": 2, "name": "Card"},
  "productsDisplayed": 3,
  "enabled": true,
  "cronExpression": "0 0 * * * *",
  "fromDate": "2026-04-05T00:00:00Z",
  "promoActionId": "40968",
  "totalDuration": 30
}
```

## Cross-Site Clone Constraint

- on 2026-04-18, Bronx product-menu banners such as `Fresh & INTENSE` and the `Priced to MOVE` set could be read with `store.screen.carousel.banner.get`, but their backing Bronx `promoActionId`s were not reusable from Midtown
- trying to create a Midtown product-menu banner with those Bronx promo IDs failed with `Action does not exist or you do not have permission` / subcode `14002`
- `store.screen.carousel.banner.promo.list` also showed the practical scope split: Midtown returned active promo actions, while Bronx and state-level contexts returned empty promo lists for this screen workflow
- practical implication: cross-site duplication of promo-backed product-menu banners is not currently a straight `banner.add` copy using the original `promoActionId`

## Cross-Site Image Fallback

- when a Bronx banner needs to be duplicated into Midtown but its promo action is not reusable there, the working fallback is to recreate it as a static image banner using the Bronx banner artwork
- for banners that already expose `media.id`, that same `mediaId` can be reused directly in Midtown image-banner creates
- if the source banner only exposes a promo image URL instead of a reusable `media.id`, upload that image first with `store.blob.add { type: "banner" }` plus `PUT /api/blobs/upload/{blobId}`, then use the returned blob UUID as the new banner `mediaId`
- after creating the Midtown image clones, apply the standard screen-level sequence: keep the new banners off, turn the screen off, enable the new banners, leave any zero-duration rows disabled, then turn the screen back on

Observed live Midtown duplication on 2026-04-18:

- the Bronx banners `Fresh & INTENSE`, `Priced to MOVE 5`, `Priced to MOVE 10`, and `Priced to MOVE 15` were duplicated to all four Midtown screens as image banners
- all 16 created Midtown clones came back with positive `totalDuration` (`5`, `5`, `4`, and `3` seconds respectively), so all 16 were enabled
- the local one-off automation for that run is [`automation/screens/clone_bronx_banners_to_midtown.py`](../../../screens/clone_bronx_banners_to_midtown.py), with the execution artifact at [`automation/screens/clone_bronx_banners_to_midtown_results.json`](../../../screens/clone_bronx_banners_to_midtown_results.json)
- that script now also accepts `SWEED_AUTH_TOKEN` from the environment, supports `--apply` versus dry-run planning, and can write a caller-selected `--output` artifact path so Helios can wrap it without putting the token on the process command line
- updated implementation note on 2026-05-04: that clone script no longer hardcodes Bronx source banner IDs or Midtown anchor banner IDs; it now resolves source banners by exact name from the live Bronx screen inventory, resolves the Midtown ordering anchor by exact banner name (`Camino $27.50 each, 2/50 4/80`), and skips `DEAD ...` screens automatically

Observed Midtown promo rebinding on 2026-04-18:

- once Midtown-side `Velocity Boosters` promo actions existed, the Midtown image clones for `Priced to MOVE 5`, `Priced to MOVE 10`, and `Priced to MOVE 15` were replaced with real product-menu banners tied to Midtown promo actions `42260`, `42261`, and `42262`
- the safe replacement sequence was: create the new product-menu banners disabled, drive the old image banners off, turn the screen off, delete the old image banners, turn the new promo-backed banners on, leave any `totalDuration = 0` rows disabled, then turn the screen back on
- all 12 replacement Midtown `Priced to MOVE` banners read back with `totalDuration = 0`, so all 12 were left disabled as intended
- the Midtown `Fresh & INTENSE` clones stayed as static image banners because no corresponding Midtown promo action existed for that campaign
- the local one-off automation for that run is [`automation/screens/tie_midtown_priced_to_move_banners_to_velocity_promos.py`](../../../screens/tie_midtown_priced_to_move_banners_to_velocity_promos.py), with the execution artifact at [`automation/screens/tie_midtown_priced_to_move_banners_to_velocity_promos_results.json`](../../../screens/tie_midtown_priced_to_move_banners_to_velocity_promos_results.json)
- that script now accepts `SWEED_AUTH_TOKEN` from the environment, supports dry-run versus `--apply`, supports caller-selected `--output`, and resolves its target image banners from the newest Bronx-to-Midtown apply clone artifact under Helios `runtime-artifacts/screens/` with repo-file fallback

Observed Midtown `Fresh & INTENSE` rebinding on 2026-04-18:

- Midtown campaign `12749` `New Arrivals` and action `42264` `Fresh & Intense` were created for a real selector-driven version of the banner
- the working Midtown action shape was a single product get-selector over the broad Bronx-style category set, with filter rules `shelf_time_in_days < 15` and `thc > 40`
- unlike the Midtown movers promos, this action immediately resolved products: the action selector read back with `productCount = 30`
- the four Midtown image clones were then replaced with product-menu banners `2375`-`2378` tied to promo action `42264`
- all four replacement Midtown `Fresh & INTENSE` banners came back healthy and enabled with `totalDuration = 25`
- the local one-off automation for that run is [`automation/screens/replace_midtown_fresh_and_intense_image_banners_with_dynamic_promo.py`](../../../screens/replace_midtown_fresh_and_intense_image_banners_with_dynamic_promo.py), with the execution artifact at [`automation/screens/replace_midtown_fresh_and_intense_image_banners_with_dynamic_promo_results.json`](../../../screens/replace_midtown_fresh_and_intense_image_banners_with_dynamic_promo_results.json)
- that script now accepts `SWEED_AUTH_TOKEN` from the environment, supports dry-run versus `--apply`, supports caller-selected `--output`, and resolves its target image banners from the newest Bronx-to-Midtown apply clone artifact under Helios `runtime-artifacts/screens/` with repo-file fallback

## Zero-Duration Refresh Rule

- banner list and detail responses both expose `totalDuration`
- some banners can drift into `totalDuration: 0` when no products are currently associated with the underlying promo/menu content
- changing `productsDisplayed` on a product-menu banner can also change `totalDuration` immediately because Sweed recalculates the page count for that banner layout
- the safe refresh pattern in this workspace is:
- read the full banner detail
- drive every banner on the target screen to `enabled: false`
- toggle the screen itself to `enabled: false`
- if the user requests a longer cool-down, treat it as one shared off window for the whole target batch: turn every targeted banner off, turn every targeted screen off, hold once, then continue with banner re-enable work
- toggle every banner back to `enabled: true` so Sweed rebuilds the banner contents while the screen is still off
- reread each banner and inspect the refreshed `totalDuration`
- if the refreshed `totalDuration` is still `0`, leave that banner disabled
- otherwise restore the banner to its intended final state for that sweep
- after the banner final-state cleanup is done, toggle the screen back to `enabled: true`

Observed live zero-duration rows on 2026-04-17 before refresh:

- Bronx screen `88` (`TV Arthur Left`): banner `807` `Smoakland`, disabled, `totalDuration = 0`
- Bronx screen `88` (`TV Arthur Left`): banner `1164` `Priced to MOVE 15`, disabled, `totalDuration = 0`
- Midtown screen `250` (`TV SW Over Kiosks`): banner `2100` `Bulk That Buzz - 50% off`, disabled, `totalDuration = 0`

## Full Refresh Sweep Playbook

- the practical whole-site sweep in this workspace is:
- switch to the state dealer first so the session can see every site dealer
- iterate each site dealer and list every `store.screen.carousel`
- for each screen, list every `store.screen.carousel.banner`
- for each banner, read the full detail with `store.screen.carousel.banner.get`
- drive every targeted banner in the batch to `enabled: false`
- toggle every targeted screen in the batch off with `store.screen.carousel.edit { id, enabled: false }`
- if the user requested an off-time such as 60 seconds, hold once across the whole batch instead of spending that hold separately on each screen
- toggle every targeted banner back on with `store.screen.carousel.banner.edit { enabled: true, ... }`
- reread each banner while its screen is still off, inspect `totalDuration`, and then move it to the intended final state
- toggle the screens back on with `store.screen.carousel.edit { id, enabled: true }`

This is the safest known refresh pattern because it forces a clean screen-level reset instead of a partial per-banner toggle, makes Sweed rebuild the banner content while the display is offline, preserves the intended final banner state for healthy rows, and leaves genuinely empty banners disabled.

## Product-Menu Layout Normalization

- on 2026-04-23, live edits confirmed that product-menu layout is controlled by both `layoutTypeId` and `productsDisplayed`
- `layoutTypeId: 2` is `Card`
- Bronx banner `1745` `Menu` had been running as `layoutTypeId: 1` / `List` with `productsDisplayed: 4`; a live edit to `layoutTypeId: 2` and `productsDisplayed: 3` succeeded and immediately increased its `totalDuration`
- the same run normalized all known product-menu banners in the current inventory to `Card` plus `productsDisplayed: 3` before the usual screen refresh sweep
- after that normalization, the known product-menu inventory had no remaining noncompliant rows: every current product-menu banner read back as `layoutType.id = 2` and `productsDisplayed = 3`
- on 2026-04-24, a fresh active-screen readback after the 60-second-hold refresh sweep still showed no remaining product-menu drift on screens `88`, `220`, `250`, `251`, `252`, and `276`
- updated implementation rule on 2026-05-05: the generic product-menu edit helpers in `refresh_all_sites_screen_banners.py`, `enable_healthy_screen_banners.py`, `tie_midtown_priced_to_move_banners_to_velocity_promos.py`, and `replace_midtown_fresh_and_intense_image_banners_with_dynamic_promo.py` now force `layoutTypeId = 2` and `productsDisplayed = 3` for every product-menu `banner.edit` request instead of replaying whatever drifted live layout Sweed currently returns
- if a future request asks for a specific product-menu density, update `productsDisplayed` explicitly rather than relying on whatever Sweed currently omits or defaults in `banner.get`

## Hidden Convenience Promo Fallback

- when a requested screen banner needs a disjunctive product pool that the direct banner selectors cannot express safely, the working fallback is a hidden promo action whose only purpose is to feed the screen banner
- the proven Midtown pattern on 2026-04-23 was a zero-loyalty action under the existing Midtown campaign `12800` `260419 - velocity`:
- `applicationStepId = 3` (`Loyalty points accrual`)
- `applicationTypeId = 1` (`Simple`)
- `actionTypeId = 4` (`Loyalty points`)
- `bonusLoyaltyAmount = 0.0`
- `displayInEcommerceProducts = false`
- `ecommerceDiscountMenuActionDisplayTypeId = 1` (`Do not show`)
- `ecommerceHomePageActionDisplayTypeId = 1` (`Do not show`)
- `alwaysDisplayPromotionDeals = false`
- `ecommerceUpsellModalActionDisplay = false` on readback
- create that hidden action disabled first, attach one `store.promo.selector.get.add` selector per desired branch, then enable it and verify each selector reads back with a positive `productCount`
- for the Midtown `Flower Specials` fallback, the hidden action `42712` carried four get-selector branches for `Herb 28g`, `Weedubest 28g`, `Find. 14g`, and `Weedubest 3.5g`
- once the hidden action exists, the banner itself can be an ordinary promo-backed product-menu banner tied to that action's `promoActionId`
- still set `layoutTypeId: 2` and `productsDisplayed: 3` explicitly on that banner create
- the safe rollout remains: create the new banner disabled, run the normal screen refresh, then do a targeted enable pass if the refresh preserved the banner's original disabled state even though `totalDuration > 0`
- if a hidden promo-backed banner family like Midtown `Flower Specials` is retired later, disable the linked banners first and then disable the hidden action so the screens do not keep enabled promo-backed rows pointing at a dead pool
- observed Midtown result on 2026-04-23: banners `2440`-`2443` tied to hidden action `42712` all refreshed cleanly, then were enabled with `totalDuration = 20` on active Midtown screens `276`, `250`, `251`, and `252`
- updated Midtown caveat on 2026-04-30: the same `Flower Specials` banner family `2440`-`2443` now rereads as `totalDuration = 0` on active Midtown screens `276`, `250`, `251`, and `252`, so the safe refresh workflow leaves all four disabled until the underlying promo pool becomes screen-usable again
- updated Midtown caveat on 2026-05-04: the old bundle action `40943` `Elevated Evening` under campaign `12608` `OLD 2026-04 Bundles` now reads back `enabled: false`, so its active-screen banner family must stay disabled on Midtown screens `250`, `251`, `252`, and `276` (`2098`, `2097`, `2092`, and `2427` respectively)
- the sibling old-bundle actions `40946` `The Night In` and `40968` `Spaced Out Sampler` still read back `enabled: true` on the same date, so their active-screen banner families were left live
- updated Midtown caveat later on 2026-05-04 after a 30-second active-screen bounce: the old-bundle banner families for `40946` `The Night In` (`2106`, `2105`, `2104`, `2430`) and `40968` `Spaced Out Sampler` (`2109`, `2108`, `2107`, `2431`) reread as `totalDuration = 0` on Midtown screens `250`, `251`, `252`, and `276`, so the safe workflow now leaves those eight banners disabled too
- the same 2026-05-04 bounce also dropped the Midtown 10mg beverage banner family `2464`-`2467` tied to promo `43072` to `totalDuration = 0`, so those four active-screen banners were also left disabled under the zero-duration rule pending a future positive-duration reread
- focused Midtown beverage recovery probe on 2026-05-04: promo action `43072` still read back enabled with a positive selector pool (`getSelectors[0].productCount = 17`), but a representative 30-second screen-level bounce on screen `250` still left banner `2464` at `totalDuration = 0` and disabled, so that family currently behaves like a true zero-duration screen pool rather than a stale-display-only problem
- Midtown Fernway verification on 2026-05-04: banners `2095`, `2096`, `2094`, and `2426` were explicitly rewritten back to `layoutTypeId = 2` and `productsDisplayed = 3`, then reread healthy and enabled as `Card/3`
- Midtown code audit on 2026-05-04: no current Python screen-automation source file in `automation/screens/` now carries hardcoded banner IDs; the only live source script that still had them (`clone_bronx_banners_to_midtown.py`) was refactored to name-based banner discovery
- all-active-screen bounce on 2026-05-05 after the generic layout-helper fix: active screens `88`, `220`, `250`, `251`, `252`, and `276` all completed the documented screen-level refresh, and Midtown Fernway banners `2095`, `2096`, `2094`, and `2426` still reread healthy plus enabled as `Card/3` afterward

The current local implementation is [`automation/screens/refresh_all_sites_screen_banners.py`](../../../screens/refresh_all_sites_screen_banners.py). It handles:

- extracting a usable auth token from the latest local HAR when one is not passed explicitly
- accepting `SWEED_AUTH_TOKEN` from the environment before falling back to an explicit CLI token or HAR extraction, which is how the Helios worker wrapper now runs the script without putting the token on the process command line
- hopping through the state dealer to expand the full site list
- optionally filtering to specific `--screen-id` values inside the selected dealer scope when a single replacement or recovery screen needs the documented list-based refresh path without bouncing the rest of the site
- skipping replacement rows whose screen name is marked `DEAD ...` unless the caller explicitly targets them by `--screen-id`, so all-screen sweeps do not trip over retired screens like Midtown `255`
- converting selector-object arrays from `banner.get` into the plain ID arrays expected by `banner.edit`
- carrying `productsDisplayed` through product-menu banner edits so refreshes do not silently drift away from the required Card/3 layout
- accepting `--hold-seconds` so a requested cool-down, such as a 60-second screen bounce, is applied once across the whole selected screen batch after all targeted banners and screens are off
- driving the screen-level sequence `banners off -> screen off -> banners on -> screen on`
- applying the zero-duration disable rule during the banner final-state cleanup before the screen comes back on

## Known-ID Fallback When `banner.list` Breaks

- `store.screen.carousel.banner.list` can become session-specific flaky in this workflow and may keep returning `Action does not exist or you do not have permission` / subcode `14002` even after a fresh HAR token is captured
- on 2026-04-18, a newly captured HAR restored normal `store.screen.carousel.list` access but `store.screen.carousel.banner.list` still failed for all tested dealer contexts and with or without an `enabled` filter
- the practical fallback is to drive the same screen-level refresh sequence from a current known banner inventory instead of live `banner.list`
- that fallback inventory can come from the latest successful sweep artifact plus any later create-run artifact, or from a direct known-ID readback artifact built from those sources
- for each site and screen in that inventory:
- read every banner with `store.screen.carousel.banner.get { id }`
- drive all known banners off
- turn the screen off
- drive all known banners on
- reread each banner by id, leave any `totalDuration = 0` rows disabled, then turn the screen back on
- this fallback is safe for refreshing the already-known banner set, but it does not discover brand-new banners that were created after the inventory artifact was generated
- the 2026-04-18 fallback refresh used the known 78-banner inventory from the earlier 62-banner sweep plus the 16 Midtown image clones and completed successfully across both sites and all 6 screens

## Replacement Screen Clone Workflow

- when a site replaces a broken screen with a new one and marks the old row `DEAD`, first identify the pair from `store.screen.carousel.list`; on 2026-04-23 Midtown screen `276` `TV SE Over Kiosks` replaced old screen `255` `DEAD - TV SE Over Kiosks`
- the old screen can keep failing `store.screen.carousel.banner.list` with `14002` while the new replacement screen lists normally in the same session; treat that as screen-specific fallout, not proof that the session is unusable for the replacement
- if the old screen's banners are still readable by direct `store.screen.carousel.banner.get { id }`, those details are enough to seed the replacement screen safely
- same-site replacement clones can reuse the old screen's image `mediaId` values and the same site-scoped `promoActionId` values directly on the new screen
- the safe replacement sequence is:
- turn the new screen off
- add the cloned banners onto the new screen using the known-safe image-banner and promo-backed product-menu payloads
- for product-menu banners, set `layoutTypeId: 2` and `productsDisplayed: 3` explicitly during create, even if the source detail omitted one of them
- then run the normal screen-level refresh on the new screen and leave any `totalDuration = 0` rows disabled before turning the screen back on
- observed Midtown replacement result on 2026-04-23: the new screen `276` was seeded from the old known banner inventory, refreshed cleanly, and ended at `totalScreenDuration = 265` with healthy rows enabled and the same four zero-duration promo rows disabled

## Enable-Healthy-Banners Sweep

- after a refresh pass, it is valid to do a second sweep whose only rule is: if a banner currently has `totalDuration > 0`, it should be enabled
- that follow-up is useful because some banners can repopulate during refresh but remain disabled if they started disabled
- the safe enable rule is simple:
- identify the disabled-but-healthy banners on a screen with `store.screen.carousel.banner.list { screenId }`
- drive that target set fully off first so the screen starts from a clean state
- toggle the screen off
- toggle that target set back on
- toggle the screen on
- verify with a fresh readback that each target banner is now enabled and still has nonzero `totalDuration`

Observed live examples from 2026-04-17 after the full refresh pass:

- Midtown `TV SW Over Kiosks` banner `2056` `Full Menu` was disabled but had `totalDuration = 600`, so it was re-enabled
- Midtown `TV SW Over Kiosks` banner `2100` `Bulk That Buzz - 50% off` repopulated from `0` to `5` seconds during refresh and was then re-enabled by the follow-up enable sweep
- Bronx `TV Arthur Left` banner `692` `Front Page Smoker` was disabled with `totalDuration = 9`, so it was re-enabled

The same verification sweep confirmed that no disabled banners with positive duration remained afterward.

The current local implementation is [`automation/screens/enable_healthy_screen_banners.py`](../../../screens/enable_healthy_screen_banners.py). It handles:

- extracting a usable auth token from the latest local HAR when one is not passed explicitly
- accepting `SWEED_AUTH_TOKEN` from the environment before falling back to an explicit CLI token or HAR extraction so Helios can wrap it without putting the token on the process command line
- optionally scoping the sweep to specific Bronx and/or Midtown site dealers with repeated `--dealer-id` flags
- identifying only the currently disabled banners whose live `totalDuration` is already greater than `0`
- driving the documented safe sequence `targets off -> screen off -> targets on -> screen on`
- re-disabling any target that rereads at `totalDuration = 0` during the enable pass so the sweep still honors the zero-duration safety rule

## Future Consolidated-System Cadence

- once the consolidated system app exists, this banner-health sweep should generally run every `60` minutes or so
- the intended combined hourly job is:
- run the full refresh sweep across all site dealers and all screens
- immediately follow it with the enable-healthy-banners sweep so any banner that now has `totalDuration > 0` is turned on
- leave zero-duration banners disabled until a later hourly run finds them repopulated
- record per-run artifacts with dealer, screen, banner id, pre/post enabled state, and pre/post `totalDuration` so regressions are easy to audit

That hourly cadence is the preferred target for the future system app because the underlying promo/catalog relationships drift often enough that banner duration can go stale during the day, but the sweep is still lightweight enough to be treated as periodic maintenance rather than a constant watcher.

As of 2026-04-19, Helios now has a combined worker adapter for that cadence as `screens.banner_health_maintenance`. It runs the existing refresh script and the existing healthy-banner enable script back-to-back in one typed worker job, records a combined maintenance artifact plus both underlying child artifact paths, and keeps the same shared Sweed-session serialization lane as the other screens workflows. The current Helios surface queues it manually from `/screens`; a future scheduler can enqueue the same job type with `trigger: "scheduled"` instead of creating a second workflow shape.

## Helios Wrapper Status

- As of 2026-04-18, Helios now exposes the banner-refresh sweep as the first live `screens` module workflow at `/screens`
- the Helios route queues `screens.banner_refresh` worker jobs with explicit dry-run vs live-apply mode, optional Bronx/Midtown site scoping, and append-only audit entries for both request and completion
- Helios now also exposes the chained banner-health maintenance cadence as `screens.banner_health_maintenance`, with the same dry-run vs live-apply queue surface, optional Bronx/Midtown site scoping, combined runtime artifact capture, and append-only request/completion audit events
- Helios now also exposes the fixed Bronx-to-Midtown image fallback clone as `screens.bronx_midtown_image_clone`, with the same dry-run vs live-apply queue surface, Midtown dealer scoping, and runtime artifact capture under `runtime-artifacts/screens/`
- Helios now also exposes the follow-up healthy-banner maintenance sweep as `screens.enable_healthy_banners`, with the same dry-run vs live-apply queue surface, optional Bronx/Midtown site scoping, runtime artifact capture, and append-only request/completion audit events
- Helios now also exposes the Midtown `Priced to MOVE` promo rebinding as `screens.midtown_priced_to_move_promo_rebind`, with the same dry-run vs live-apply queue surface, Midtown dealer scoping, runtime artifact capture, and append-only request/completion audit events
- Helios now also exposes the Midtown `Fresh & INTENSE` promo rebinding as `screens.midtown_fresh_and_intense_promo_rebind`, with the same dry-run vs live-apply queue surface, Midtown dealer scoping, runtime artifact capture, and append-only request/completion audit events
- the worker still wraps the existing Python implementation above rather than reimplementing the flow, so the same safe playbook remains the source of truth
- because both catalog and screens jobs share one Sweed automation session token, Helios now serializes all Sweed-backed jobs through one shared queue lane so site-level dealer switching in screens cannot race state-level catalog jobs
