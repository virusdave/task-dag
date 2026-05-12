# Lit Alerts Brand And Product Lookups

Load this when resolving manufacturer identity, doing statewide listing queries, or pulling competitor product rows.

Source: `HOW_LITALERTS_WORKS.md`

## Manufacturer Directory Lookup

From `customers/segmentation/2026-04-11/brands.litalerts.com_Manufacturers_real_Archive [26-04-13 14-55-55].har`:

- endpoint: `GET https://public-api.litalerts.com/Manufacturers/real?page=0&pagesize=2000&state=NY`
- observed query params:
  - `page=0`
  - `pagesize=2000`
  - `state=NY`
- response top-level fields observed: `totalCount`, `manufacturers`
- manufacturer fields observed: `id`, `name`, `url`, `rawManufacturers`, `manufacturerUsers`, `states`, `createdAt`, `editedAt`
- `states[]` rows observed: `id`, `name`, `abbreviation`, `createdAt`, `editedAt`

Observed New York example:

- manufacturer `#Juan Roll` resolved to Lit Alerts manufacturer ID `22054`

Practical implication:

- when a product name is ambiguous, do not guess the Lit Alerts brand/manufacturer ID from free text alone
- use `Manufacturers/real` first to resolve the exact manufacturer ID for the current state, then feed that ID into downstream menu-listing queries
- this is a better identity-resolution step than broad menu-name searching because it starts from the normalized Lit Alerts brand directory

## Statewide Brand Product Lookup

From `customers/segmentation/2026-04-11/brands.litalerts.com_Products_menulistings_Archive [26-04-13 14-56-14].har`:

- endpoint: `POST https://public-api.litalerts.com/Products/menulistings`
- request body shape used for statewide brand lookup:

```json
{
  "brandIDs": [22054],
  "page": 0,
  "pagesize": 100,
  "sortfields": ["Name"],
  "filters": {
    "Brand": "[22054]",
    "Availability": "All",
    "Image": "All",
    "MedRec": "All",
    "ShowStaleItems": "False",
    "ShowHiddenDisps": "false",
    "StateID": "265"
  },
  "dispensaryIDs": null,
  "stateID": 265
}
```

Observed response shape in that capture:

- top-level fields: `listings`, `count`, `total`
- `listings[]` fields matched the usual product-search payload: `id`, `url`, `name`, `category`, `brand`, `configs`, `imageUrl`, `medAvailable`, `recAvailable`, `availability`, `daysOffMenu`, `dispensaryName`
- `configs[]` fields observed: `price`, `salePrice`, `quantity`, `weight`, `dayChange`, `daysOnMenu`, `medical`, `recreational`

Observed behavior from the `#Juan Roll` replay:

- the request returned `27` listings for brand ID `22054`
- the response reported `total: 27`
- the same response reported `count: 0`, even though `listings[]` was populated

Practical implication:

- for this statewide brand-catalog mode, do not trust `count` as the row count; use `listings[]` and `total`
- setting `dispensaryIDs` to `null` allows Lit Alerts to return the brand's statewide menu footprint instead of a nearby-retailer subset
- this is useful when we are trying to determine what a product actually is, not just what nearby competitors charge for it
- the statewide listing set gives repeated evidence for naming, pack structure, weights, category lane, images, and menu URLs across many stores
- when a local SKU is unclear, the reliable fallback is:
  1. resolve the brand ID with `Manufacturers/real`
  2. query `Products/menulistings` statewide with that `brandIDs` value and `filters.Brand`
  3. inspect repeated listing names, `configs[].weight`, images, and menu URLs to infer whether the item is a single preroll, multipack, infused lane, blunt, or another format
  4. if needed, add a `filters.Name` term on top of the brand filter to narrow to a specific cultivar or product family after the brand ID is confirmed

Observed stricter statewide exact-search shape from `categories/2026-04-13/brands.litalerts.com_Products_menulistings_Archive [26-04-13 22-28-32].har`:

- the captured request added `filters.Name`, `filters.Brand`, and `filters.CategoryId: "2"` together for a statewide preroll lookup
- the request still used `dispensaryIDs: null` and `stateID: 265`
- the captured example for `#Juan Roll` `Velour` was:

```json
{
  "brandIDs": [22054],
  "page": 0,
  "pagesize": 100,
  "sortfields": ["Name"],
  "filters": {
    "Name": "Velour",
    "Brand": "[22054]",
    "CategoryId": "2",
    "Availability": "All",
    "Image": "All",
    "MedRec": "All",
    "ShowStaleItems": "False",
    "ShowHiddenDisps": "false",
    "StateID": "265"
  },
  "dispensaryIDs": null,
  "stateID": 265
}
```

Practical implication:

- when curating statewide preroll evidence, preserve the `CategoryId` preroll filter from the newer HAR instead of broadening the query unnecessarily
- this tighter request shape is especially useful when you are already filtering by a resolved manufacturer ID and a cultivar term

Observed manufacturer-alias nuance from live pending-order proposal work on 2026-04-13:

- some Lit Alerts manufacturer names do not exactly match the Sweed/public-facing brand label
- confirmed examples in New York included:
  - `Grassroots (Curaleaf)` for `Grass Roots`
  - `Anthem (Curaleaf)` for `Anthem`
  - `Select (Curaleaf)` for `Select`
- on 2026-04-16, pending catalog proposal work for `YEM TC Drops` showed that the public brand `YEM` resolved live statewide under manufacturer label `YEM (Your Everyday Medicine)` even though the short strict normalized alias match returned no direct manufacturer ID
- on 2026-04-29, live Bronx + Midtown pricing regeneration confirmed additional safe exact alias branches in New York:
  - `Camino (Kiva)` for `Camino`
  - `JAMS (Curaleaf)` for `JAMS`
  - `Airo Brands` for `Airo`
  - `American Hash Makers` for `American Hash Maker`
  - `CRU Cannabis` for `CRU`
  - `Dank. by definition.` for exact brand `Dank`
- the same 2026-04-29 pass used a bounded private-Mantle trial plus Oracle review only for ambiguous manufacturer-branch decisions, and promoted only exact alias-or-none outcomes into code; branch guesses like `Moony's -> Moony's Zooties` and `Cornucopia Growers -> Cornucopia` were intentionally left unresolved
- overly-loose substring matching was unsafe because it could spuriously match unrelated short manufacturer names such as `Hi`

Practical implication:

- manufacturer resolution should prefer explicit alias maps or exact normalized equality, not raw substring containment
- if a brand fails to resolve, inspect `Manufacturers/real` for a suffix/prefix variant such as `(Curaleaf)` before falling back to broad term search
- when strict alias resolution fails but there are a few plausible nearby manufacturer branches, it is reasonable in this workspace to send the target product name plus those branch options to the LLM and let it choose the matching manufacturer branch before statewide product lookup

Observed category-label nuance from live pending-order proposal work on 2026-04-13:

- Lit Alerts menu listings for vape products were returned under category label `Vaporizers`, even when the local catalog lane was being treated as `Vapes`

Practical implication:

- statewide evidence filters should treat `Vaporizers` as the vape lane instead of dropping those rows as a category mismatch

Observed broader product-matching nuance from `bulk_additions/2026-04-10/brands.litalerts.com_Products_menulistings_Archive [26-04-14 00-20-18].har`:

- a statewide `Mfused` vape lookup filtered only by brand ID, `CategoryId: "4"`, and a short `filters.Name: "Fatso"` family token returned `67` same-brand `Vaporizers` listings even though retailer naming varied wildly
- the listing cluster spanned names like `AIO - FIRE JEFE - FATSO - 2 G - 2 PACK`, `Fatso [2000mg]`, `Disposable Super Fog Fire Jefe Plus | Fatso (H)`, and `MFUSED SUPER FOG | FIRE JEFE PLUS | LIQUID DIAMONDS | FATSO - 2 G`

Practical implication:

- product discovery should be broader and more creative than pricing comparables
- for ambiguous items, use the statewide brand lookup flow with a short durable family token and category filter first, then interpret the returned listing cluster as a whole instead of expecting exact menu-name equality
- `filters.Name` appears to behave like an exact substring search, so the best discovery term is usually the rarest contiguous 1-3 word phrase from the real product text rather than a normalized bag of tokens
- after identity is established, collapse back to the stricter same-brand, same-format evidence rules already used for pricing

Observed multipack-weight nuance from live pending-order proposal work on 2026-04-13:

- for multipacks, `configs[].weight` was not consistently the per-unit weight
- confirmed live examples expressed the total pack weight instead, such as `4g (4,000mg)` for `4x 1g`, `2.5g (2,500mg)` for `5x 0.5g`, and `1g (1,000mg)` for `2x 0.5g`
- listings could also alternate between name-based cues like `4pk`, `4-pack`, `5pk`, `4 x 1g`, or only the total pack weight in the config block

Practical implication:

- do not reject a multipack match just because the config weight equals the total pack weight instead of the per-unit size
- match multipacks by combining pack-count cues from the listing name with either the expected per-unit grams or the expected total-pack grams

## Product Menu Listings

From `brands.litalerts.com_Products_menulistings_Archive [26-04-12 13-22-41].har` and matching live replays:

- endpoint: `POST https://public-api.litalerts.com/Products/menulistings`
- request body shape:

```json
{
  "brandIDs": [],
  "page": 0,
  "pagesize": 100,
  "sortfields": ["Name"],
  "filters": {
    "Dispensary": "[27370,15586,24859,45286,16777,28688,23215,23312,18589,40539,44065,35453,36607]",
    "Availability": "All",
    "Image": "All",
    "MedRec": "Rec",
    "ShowStaleItems": "False",
    "ShowHiddenDisps": "false",
    "StateID": "265"
  },
  "dispensaryIDs": [27370,15586,24859,45286,16777,28688,23215,23312,18589,40539,44065,35453,36607],
  "stateID": 265
}
```

- response top-level fields observed: `listings`, `count`, `total`
- listing fields observed: `id`, `url`, `name`, `category`, `brand`, `configs`, `imageUrl`, `medAvailable`, `recAvailable`, `availability`, `daysOffMenu`, `dispensaryName`
- config fields observed inside `configs[]`: `price`, `salePrice`, `quantity`, `weight`, `dayChange`, `daysOnMenu`, `medical`, `recreational`

Observed price-format nuance from the 2026-04-12 14g flower replay:

- some `configs[].price` or `configs[].salePrice` values arrived as formatted strings with commas, for example `"1,548.68"`
- automation should strip commas and currency symbols before numeric parsing instead of assuming the field is already a plain JSON number

Observed menu-listing response-shape nuance from live Bronx + Midtown pricing regeneration on 2026-04-29:

- some `listings[].availability` values arrived as numeric codes instead of strings such as `"Rec"` or `"All"`
- the rest of the listing payload remained usable for pricing evidence after accepting that field as opaque metadata

Practical implication:

- parsers for `Products/menulistings` should accept `availability` as either string or number and normalize it only for display/debug use instead of treating a numeric value as a fatal schema mismatch

Observed pagination nuance:

- the provider response `total` field was not a reliable stop condition in this session
- with `pagesize: 1000`, the backend continued returning full pages through page `12` and a short page `13`
- that yielded `13371` raw rows while `total` still reported `10000`

Practical rule:

- paginate until the backend returns an empty page or a page shorter than the requested `pagesize`
- do not stop solely because `page * pagesize >= total`

Observed current Midtown retailer universe from that HAR:

- the selected `dispensaryIDs` array was `[27370,15586,24859,45286,16777,28688,23215,23312,18589,40539,44065,35453,36607]`
- that exact same 13-retailer set later appeared in the saved-filter example captured by `filters/new`

Practical implication:

- the menu listings request and the saved filter request are both operating over the same retailer-selection concept
- a saved retailer filter can likely be replayed into `Products/menulistings` by reusing the same retailer ID set in both `filters.Dispensary` and `dispensaryIDs`

## Nearby Competitor Filtering

For the 28g flower pricing work in this workspace, useful local filtering of `Products/menulistings` results was:

- keep rows where `category == "Flower"`
- keep ounce-size rows by scanning `configs[].weight` or the listing name for cues such as `28g`, `28 g`, `1 oz`, `1 ounce`, or `one ounce`

Observed naming nuance:

- retailer product naming is not uniform across menus
- normalized brand plus approximate cultivar cues from the listing name were more reliable than exact string equality

Practical implication:

- when matching competitor listings to our own catalog, treat brand as a strong anchor and use fuzzy cultivar normalization on top of it
- exact string equality alone misses too many nearby listings
