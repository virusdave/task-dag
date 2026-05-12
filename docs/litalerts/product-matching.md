# How Lit Alerts Product Matching Works

This document is the long-lived working guide for using Lit Alerts retailer listings to identify ambiguous products.

It is separate from `HOW_LITALERTS_WORKS.md` because this is not just API-shape knowledge. It is the practical matching playbook for finding a product when retailer menu names are messy, incomplete, or inconsistent.

Unless a section says otherwise, treat these notes as observed behavior from the HARs and live replays in this workspace, not a guarantee about every future Lit Alerts tenant or payload revision.

## Core Principle

Lit Alerts product matching should be handled in two phases:

1. Broad identity discovery.
2. Narrow evidence filtering.

The broad discovery phase should be more creative than pricing comparables.

- Use statewide search.
- Anchor hard on normalized brand identity.
- Keep the category filter in place.
- Search with one or two durable family tokens rather than a full literal SKU name.
- Read the returned listing cluster as a whole instead of trusting one retailer listing.

Only after product identity is clear should pricing or review logic fall back to the strict same-brand, same-format evidence rules used elsewhere in this workspace.

## Pricing-Market Search Adaptation Fallback

Helios pricing now uses this matching playbook in two passes when a SKU is being repriced:

1. deterministic discovery using the brand, category, and strongest family token rules in this document
2. a bounded fallback only if the first pass still leaves the SKU below 3 eligible near/mid comps

The bounded fallback is intentionally narrow:

- it stays locked to the resolved Lit Alerts brand/manufacturer ID and category
- it asks Mantle `google.gemma-3-27b-it` for up to 4 additive follow-up search terms only
- it adds those terms to the deterministic search set instead of replacing the original family token
- it still re-applies the normal same-size, same-format, same-brand evidence filter before any listing can influence pricing
- far and very-far listings remain display-only context even after adaptation
- Lit Alerts and Mantle transport failures are retry-with-backoff dependencies in this workflow; if they still fail after bounded retries, the pricing run should page Dave and abort instead of burying the outage inside reviewer-facing packet notes

Practical rule:

- treat adaptation as a recall-lifting step for thin-comp cases, not as permission to do fuzzy cross-brand pricing or to widen into unrelated product families

Operational note:

- when the fallback runs, the pricing packet should record both the added search terms and the rationale in the row-level market note so reviewers can see why the search widened

## What The Newest HAR Proved

The newest matching HAR in this workspace is:

- `bulk_additions/2026-04-10/brands.litalerts.com_Products_menulistings_Archive [26-04-14 00-20-18].har`

It contains a single statewide search request:

```json
{
  "brandIDs": [10237],
  "page": 0,
  "pagesize": 100,
  "sortfields": ["Name"],
  "filters": {
    "Name": "Fatso",
    "Brand": "[10237]",
    "CategoryId": "4",
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

Observed outcome:

- the response returned `67` listings
- `count` was still `0`, so `listings[]` and `total` were the real signal again
- every returned listing was branded `Mfused`
- every returned listing was under Lit Alerts category `Vaporizers`
- `61` of the `67` listings had config weight exactly `2g (2,000mg)`
- `3` had mixed `1g` and `2g` config rows under the same listing name
- `3` had no weight in `configs[]`
- all `67` listing names still contained `Fatso`

Most importantly, the query did **not** search the full long-form product name. It searched only the short family token `Fatso`, while the retailer menus varied widely.

Representative names from that one result cluster:

- `AIO - FIRE JEFE - FATSO - 2 G - 2 PACK`
- `AIO VAPE | Liquid Diamonds | Fire | Fatso (Gas) | Indica | 2g`
- `All-in-One 2g Vape [FIRE] - Fatso`
- `Disposable Super Fog Fire Jefe Plus | Fatso (H) Mfused`
- `Fatso [2000mg]`
- `MFUSED | Fatso | 2pk 1g Fire Jefe AIO Disposable Vape`
- `MFUSED SUPER FOG | FIRE JEFE PLUS | LIQUID DIAMONDS | FATSO - 2 G`
- `Vape | Fire Liquid Diamond | Fatso | 2g`

Practical conclusion:

- retailer menus were not consistent enough for exact-name search to be the primary discovery method
- the durable signal was the repeated family token `Fatso`, not the full product string
- secondary descriptors such as `Fire`, `Jefe`, `Super Fog`, `Liquid Diamonds`, `AIO`, `Disposable`, `2pk`, and even `2g` were inconsistent enough that they should help interpret a cluster, but not necessarily drive the first query

## Stable Vs Unstable Signals

From the `Mfused + Fatso + Vaporizers` statewide cluster, the following signals were relatively stable:

- exact brand identity
- category lane (`Vaporizers`)
- core family token (`Fatso`)
- dominant total weight (`2g (2,000mg)`)

The following signals were noisy and should be treated as supporting evidence rather than mandatory query terms:

- `Fire`
- `Jefe`, `Jefé`, `Jefe Plus`, `Jefe XL`, `Fire Jefe XL`
- `Super Fog`, `Superfog`
- `Liquid Diamonds`, `Live Diamonds`, `Live Resin LQD`, `Diamond+Live Terps`
- `AIO`, `All-in-One`, `Disposable`, `Vape`
- pack notation such as `2 G`, `2g`, `2000mg`, `2pk 1g`, `2 pack`
- suffixes like `(Gas)`, `(H)`, or explicit `Indica`

Practical rule:

- the first statewide search should be driven by the most durable family token, not the fullest description
- the full family of noisy descriptors should be used afterward to interpret the cluster and decide whether it represents the same actual product family

## Search Ladder

When a product is ambiguous, use this search ladder.

### 1. Resolve Brand Identity First

Do not start with free-text product search alone.

- resolve the statewide Lit Alerts manufacturer/brand ID with `GET /Manufacturers/real?page=0&pagesize=2000&state=NY`
- use explicit alias handling when the Sweed/public brand label differs from Lit Alerts naming
- then carry that exact `brandIDs` value into `POST /Products/menulistings`

If brand identity is still unresolved, stop and fix that before trying to interpret product matches.

### 2. Keep The Category Filter

Use the category lane to reduce noise.

Observed examples in this workspace:

- prerolls: `CategoryId: "2"`
- the latest vape example: `CategoryId: "4"`, which returned `Vaporizers`

Practical rule:

- once the category is known, keep it in the statewide search instead of doing a broad all-category brand scrape unless the category itself is the uncertain part

### 3. Search With A Durable Family Token

Do not default to the full product name.

Prefer a short token or very short token pair that is likely to survive retailer naming drift:

- cultivar or strain-family token, like `Fatso`
- product-family token, if the cultivar is not actually stable
- one additional disambiguator only when the first token is too generic

Good first-query characteristics:

- distinctive within the brand
- likely to appear in many retailer names
- a contiguous exact substring from the real product text, because `filters.Name` appears to match exact substrings rather than fuzzy token sets
- not just a size or device word
- not a generic brand-wide subline word by itself

Controlled liberalization rule:

- if the Sweed family text contains bespoke potency or ratio annotations that are likely internal naming noise, derive an earlier search variant with those fragments stripped before trying the literal long-form name
- this is meant for cases like `Black Cherry 1:1 (5mg THC : 5mg CBD) 5mg`, where the durable family token is `Black Cherry` and the structured potency annotation reduces exact-substring recall
- keep that liberalization at the discovery layer only; final pricing evidence still has to pass the normal same-brand, same-format, same-size filters

Bad first-query characteristics:

- the full literal SKU phrase copied from Sweed
- a normalized pseudo-name built by reordering or dropping words so it no longer exists as an exact substring
- large composite strings with many descriptors
- generic tokens like `vape`, `disposable`, `live resin`, `infused`, or `diamond` without a cultivar/family anchor

### 4. Inspect The Returned Cluster, Not Just One Listing

After the search returns results, read the cluster for repeated evidence.

Look for majority agreement on:

- brand
- category lane
- weight or total pack size
- repeated family token
- repeated device family
- repeated extract/process family

Accept that individual retailers may omit or mutate some descriptors.

Do not over-trust one listing's:

- exact string shape
- URL slug
- path taxonomy
- one-off device wording
- one-off weight omission

Observed warning from the newest HAR:

- some returned URLs used slugs containing `cartridge` even while the broader cluster clearly read as an `AIO` / `Disposable` family

Practical rule:

- trust the cluster majority more than an outlier slug or one retailer's naming style

### 5. Use Secondary Tokens As Follow-Up, Not As The First Gate

If the first cluster is too broad, narrow it with a second pass.

Use one of these classes of follow-up token:

- device-family token
- extract/process token
- pack/size token
- secondary subline token

For the `Mfused Fatso` example, possible follow-up narrowing terms would have been:

- `Jefe`
- `Super Fog`
- `Liquid Diamonds`
- `2g`

But the latest HAR shows those were better used to interpret the returned family than to drive the very first discovery query.

### 6. Normalize Equivalent Patterns Before Rejecting A Match

When reading statewide clusters, treat these as equivalent until a stronger contradiction appears:

- `AIO`, `All-in-One`, `Disposable`, `Vape`
- `2g`, `2 G`, `2000mg`, `2pk 1g`, `2 pack`
- `Jefe`, `Jefé`, `Jefe Plus`, `Jefe XL`
- `Super Fog`, `Superfog`
- `Liquid Diamonds`, `Live Diamonds`, `Live Resin LQD`, `Diamond+Live Terps`
- cultivar forms like `Fatso`, `Fatso (Gas)`, `Gas Fatso`, `Fatso (H)`

This does not mean they are all interchangeable for pricing. It means they should not be treated as different products during identity discovery until the broader cluster says otherwise.

### 7. Only Then Collapse Back To Strict Evidence

Once identity is established, switch back to the stricter rules already used in pricing packets:

- same brand only
- same category / device lane only
- same pack structure only
- same meaningful format only
- if reliable evidence still does not exist, hold the current price rather than repricing from unrelated comps

This is the key split:

- product discovery should be flexible and creative
- price evidence should stay strict and narrow

## Recommended Token-Picking Heuristics

When building the statewide `filters.Name` term, strip away anything that is likely to make the search too literal.

Usually remove first:

- the brand name
- exact size text
- separators like `|`, `/`, brackets, or repeated punctuation
- obvious generic device words if the family token is already known

Usually keep first:

- one salient cultivar/family token
- one distinctive subline token only if needed to disambiguate

Heuristic order for candidate tokens:

1. Distinctive cultivar or family token.
2. Distinctive second token from the same family name.
3. Device subline token.
4. Extract/process token.
5. Pack-size token.

If a candidate token is common across the entire brand catalog, it is weak.

If a candidate token shows up in almost every relevant listing for that family, it is strong.

## Practical Matching Rules For Automation

Future automation should treat statewide Lit Alerts matching as a search ladder, not a one-shot exact query.

Recommended implementation behavior:

1. Resolve brand ID exactly.
2. Start with the strongest family token.
3. Query statewide within the known category.
4. If results are too broad, retry with one alternate token or one extra narrowing term.
5. If pricing-specific discovery is still too thin after the deterministic passes, allow the bounded search-adaptation fallback to suggest up to 4 additive follow-up terms while keeping the same brand and category lock.
6. Score matches by cluster consistency, not just literal name equality.
7. Record discovered aliases and stable descriptors for future runs.

Useful scoring dimensions:

- brand exactness
- category exactness
- family token presence
- dominant weight agreement
- pack-structure agreement
- device-family agreement
- extract/process agreement
- repeated retailer coverage across multiple stores

Useful anti-signals:

- the family token only appears in one or two low-signal listings
- returned listings split across incompatible weights with no dominant cluster
- returned listings split across incompatible device families
- results only match generic terms and not the family token

## What Not To Do

Do not:

- trust literal SKU equality as the only valid discovery method
- reject a match because one retailer omitted a descriptor that most others kept
- over-trust `count`; use `listings[]` and `total`
- over-trust one listing URL slug or one retailer's taxonomy
- immediately widen into cross-brand search when same-brand statewide discovery has not been exhausted
- treat the LLM fallback as permission to bypass the brand/category lock or the later same-format pricing filter
- use flexible discovery matches directly as pricing comps without reapplying same-format constraints

## Open Questions

- Are there product families where the cultivar token is less stable than the subline token, making the first query better driven by something other than cultivar?
- Which category IDs beyond prerolls and the observed vape `CategoryId: "4"` should we preserve as canonical in this workspace?
- Should future automation explicitly cluster statewide results by dominant weight and device family before deciding whether a family match is safe?
- Which discovered aliases are durable enough to promote into shared code rather than leaving them as one-off operator judgment?
