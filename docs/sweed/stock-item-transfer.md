# Sweed stock-item transfer (move a lot between locations)

> **Source:** captured from Sweed's web UI via the Firefox HAR shared at
> https://drive.google.com/file/d/1xJUOOVDxoGtgbVpDs7sZHFFFK80gf-6F/view
> (2026-05-21, dealer running the "Hold for Dave inspection" workflow).
>
> Everything below is Sweed's `rac-api` style JSON-RPC over POST. We
> always call it through `callSweedRpc(dealerId, name, params)` /
> `callSweedRpcForDealer(...)` inside an active `withSweedSession`
> scope; the surrounding envelope (`auth`, `id`, `version` echo) is
> handled by the transport.

## 1. `store.stock.location.list` — enumerate stock locations

Use this to discover the per-dealer location ids/names for the "FOR
SALE - …" buckets and for the "NOT FOR SALE - Hold for Dave
inspection" bucket that the Images & Barcodes page moves lots into.

Request `params`: `{}` (always empty object).

Response shape (per entry):

```json
{
  "id": 3161,
  "name": "NOT FOR SALE - Hold for Dave inspection",
  "stockType": { "id": 1, "name": "Reception" },
  "parents": [],
  "children": [],
  "enabled": true,
  "integrationLocation": []
}
```

Observed locations on the demo dealer:

| id   | name                                       | stockType.id | stockType.name           |
| ---- | ------------------------------------------ | ------------ | ------------------------ |
| 3161 | `NOT FOR SALE - Hold for Dave inspection`  | 1            | `Reception`              |
| 3162 | `FOR SALE - Sales Floor`                   | 3            | `Primary Finished Goods` |
| 3163 | `NOT FOR SALE - Quarantine`                | 6            | `Write-off`              |
| 3473 | `FOR SALE - Mobile1` (child of 3162)       | 3            | `Primary Finished Goods` |

The `(stockType.id, location.id)` pair is what
`store.inventory.item.transfer` needs as `stockType{From,To}` /
`stockLocation{From,To}`.

## 2. `store.inventory.product.item.list` — list lots for a product

Use this to look up the lot(s) (a.k.a. "packages" — each row has its
own METRC tag) currently in stock for a given product id.

Request `params`:

```json
{
  "productId": "41792",
  "page": 1,
  "pageSize": 50,
  "isOnStock": true
}
```

Response `result` shape:

```json
{
  "header": {
    "product": { "id": "41792", "name": "…" },
    "category": { "id": 1086, "name": "Edibles" },
    "brand":   { "id": 1891, "name": "Camino" },
    "sku":     "…",
    "globalPrice": 32.00,
    "localPrice":  32.00
  },
  "page": 1,
  "pageSize": 50,
  "totalCount": 2,
  "data": [
    {
      "id": "1293866",
      "externalTrackCode": "1A41203000004B7000027372",
      "stockType":     { "id": 3, "name": "Primary Finished Goods" },
      "stockLocation": { "id": 3162, "name": "FOR SALE - Sales Floor" },
      "currentQty": 33.0,
      "availableQty": 33.0,
      "holdQty": 0.0,
      "isTradeSample": false,
      "isAvailableOnline": true,
      …
    },
    …
  ]
}
```

The `data[].id` is the **inventory item id** that
`store.inventory.item.transfer` needs in `items[].id`. Strings are
used throughout (even for numeric ids).

## 3. `store.inventory.item.transfer` — move qty between locations

This is the write call. It moves `items[].qty` of one or more lots
from a single source `(stockType, stockLocation)` to a single target
`(stockType, stockLocation)`. All items in one request must share the
same source bucket.

Request `params`:

```json
{
  "stockTypeFrom":     3,
  "stockLocationFrom": 3162,
  "stockTypeTo":       1,
  "stockLocationTo":   3161,
  "transferReservedItems": false,
  "items": [
    {
      "id": "1293866",
      "qty": 33,
      "externalTrackCode": "1A41203000004B7000027372"
    }
  ]
}
```

Notes:

- `qty` is the amount to move (we send the lot's `availableQty` to
  drain the lot completely).
- `id` is the inventory-item id from
  `store.inventory.product.item.list` (or `store.inventory.item.get`).
- `externalTrackCode` is the METRC tag; Sweed appears to accept the
  call without it but we always send it for clarity.
- `transferReservedItems` is `false` for everything Helios automates
  today — reserved units belong to an in-flight order and should not
  be silently relocated.
- Multiple lots in one call are allowed **only if** they share the
  same `(stockTypeFrom, stockLocationFrom)`. If you need to move lots
  from different source buckets, group by source bucket and issue one
  RPC per group.

Response (success):

```json
{ "result": null }
```

A non-2xx HTTP status or a JSON-RPC error envelope means the move
did not happen — surface the error to the operator instead of
showing a green check.

## Helios usage today

`POST /api/catalog/maintenance/move-package-to-inspection` (Images &
Barcodes page) chains the three RPCs above:

1. `store.stock.location.list` → find the dealer's location whose
   name case-insensitively contains `hold for dave` (the "Held for
   Dave review / Hold for Dave inspection" bin).
2. `store.inventory.product.item.list` → find the lot whose
   `externalTrackCode` matches the package the operator clicked on.
3. `store.inventory.item.transfer` → drain that lot into the
   inspection bin.

If step 2 cannot find the specific package (Sweed has already moved
or consumed it), the route falls back to moving **every** remaining
lot for that product into the inspection bin — the operator's intent
("stop trying to sell this thing") is preserved even when the cache
is one stock-refresh cycle stale.
