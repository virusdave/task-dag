# How Sweed Works

This document is the long-lived working knowledge base for Sweed in this workspace.

It is meant to accumulate agent learnings over time so we do not have to rediscover the same behavior, APIs, workflows, naming quirks, and operational constraints in future sessions.

The entries below are the first confirmed findings we have captured so far from local HAR files while reverse-engineering how to programmatically manage products in Sweed.

Unless a section says otherwise, treat these notes as observed behavior from this store and these sessions, not universal guarantees across all Sweed environments.

## How To Use This Document

- Add confirmed findings, not guesses.
- Prefer concrete examples from HARs, scripts, or successful API calls.
- Record ambiguities and gaps explicitly so future agents know what still needs to be captured.
- Preserve useful IDs, call names, and workflow details when they help future automation work.

## API Shape

Sweed uses an RPC-style API over `POST https://prime.sweedpos.com/api/`.

The HAR shows URLs such as:

```text
https://prime.sweedpos.com/api/#type=rac-api&name=store.product.add&id=...
```

The `#type=...&name=...` part is only a URL fragment used by the frontend for debugging. It is not sent to the server.

The real request body is JSON in this shape:

```json
{
  "auth": "<session token>",
  "name": "store.product.add",
  "params": {
    "...": "..."
  },
  "id": "<client-generated uuid>"
}
```

Response shape is usually:

```json
{
  "result": {"...": "..."},
  "id": "<same request id>",
  "version": "prime-..."
}
```

## Authentication

- Requests include an `auth` token in the JSON body.
- The token appears to be session-bound and should be treated as ephemeral.
- Browser cookies are also present in the HAR, so a working script will likely need a live authenticated browser session or a fresh token/cookie set captured from one.
- Do not assume an `auth` token from an old HAR will remain usable.

## Core Objects

The objects we have identified so far are:

- `product group`: the catalog-level product family, such as `Durban Poison x Cherry Tart`
- `product`: the sellable variant, such as `20x 0.35g`
- `distributor product`: the distributor-facing record that links a distributor's item to a Sweed product
- `distributor product price`: dated wholesale pricing for a distributor product
- `purchase order position`: a line item on an incoming purchase order
- `suggested product`: Sweed's best guess at which existing catalog product should map to an unmapped purchase position

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

Confirmed IDs from the captured account:

- Brand `Hepworth` -> `1926`
- Category `Pre-Rolls` -> `1085`
- Subcategory `Multi-Pack` -> `1093`
- Strain `Durban Poison` -> `10265`
- Sale type `Recreational` -> `3`
- Size `0.35g` in Pre-Rolls -> `1107`

These values should not be assumed to be portable across stores without verification.

## Duplicate Distributor Names

Distributor display name is not a stable unique key.

We found two distributors with the same name:

- `HR BOTANICAL DISTRIBUTION LLC` -> `3253` with license `OCM-DIST-24-000114-DX2`
- `HR BOTANICAL DISTRIBUTION LLC` -> `4242` with license `OCM-DIST-24-000114-DX1`

Implications:

- A script should not key distributors by name alone.
- Prefer Sweed distributor ID or license number in source data.
- If source data only contains a name, automation must either create entries for all exact matches or fail loudly on ambiguity.

## Purchase Orders And Missing Product Mapping

The second HAR shows the purchase order detail page, not a creation workflow.

The key calls were:

- `store.purchase.order.get`
- `store.settings.btb.get`
- `store.distributor.product.suggestion`

`store.purchase.order.get` returns purchase positions. Each position may include:

- `distributorProduct`: the incoming distributor item on the PO
- `suggestedProduct`: an existing Sweed catalog product, if Sweed can match one

When `suggestedProduct` is `null`, the purchase line is effectively unmapped and may require creating:

1. a new product group
2. a new variant
3. a distributor product entry for the purchase distributor

Then that newly created product should become eligible for suggestion on the purchase.

## Confirmed Purchase Mapping Example

On purchase order `107719`:

- PO line `660164` had distributor product `Hepworth 0.35g 20pk [7g] PreRoll - Durban Poison x Cherry Tart`
- Sweed suggested product `382539`
- Product `382539` is the variant created earlier: `Hepworth Durban Poison x Cherry Tart 20x 0.35g`

This is strong evidence that creating the product, variant, and distributor product is enough for Sweed's suggestion engine to recognize the incoming purchase item.

By contrast:

- PO line `660161` had distributor product `Hepworth 0.35g 20pk [7g] PreRoll - Mango Dog x White Runtz`
- `store.distributor.product.suggestion` returned no products for that position

This shows the missing catalog entry remains unresolved.

## Observed Purchase-Side Target State

For the purchase workflow, the target is not just creating catalog data in isolation. The target is:

1. the missing purchase line gets a valid suggestion from `store.distributor.product.suggestion`, or
2. there exists some follow-up API to explicitly assign the created product to the purchase line

We have confirmed the first half of this state transition, but we have not yet captured the API that finalizes selection of a suggestion onto a purchase position.

## Practical Rules For Automation

- Treat `POST /api/` plus JSON RPC body as the main API.
- Generate a fresh request `id` UUID for each call.
- Use a fresh live `auth` token.
- Resolve human labels like brand, category, strain, size, and distributor to IDs before creation.
- Do not assume distributor names are unique.
- Handle image upload separately from catalog creation.
- For purchase remediation, use `store.purchase.order.get` to enumerate unmapped lines and `store.distributor.product.suggestion` to validate whether creation solved the mapping problem.

## Known Gaps

These parts are not yet documented because they were not present in the HARs we have examined:

- The API to explicitly assign a suggested product to a purchase order position
- The API to create new strains, brands, categories, or sizes if a lookup misses
- Whether there is a bulk endpoint for product creation
- Whether distributor product price must be created for every distributor product to make it selectable on purchases
- The exact minimal field set for non-pre-roll categories such as vape carts or concentrates
