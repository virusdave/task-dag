# Sweed Backend API

Based on HAR analysis from product catalog bulk addition workflow captured 2025-09-11.

## API Structure

**Base URL:** `https://prime.sweedpos.com/api/`

**Request Format:** JSON-RPC style POST requests to `/api/` endpoint
```json
{
  "auth": "session-token",
  "name": "store.operation.name",
  "params": {...},
  "id": "request-uuid"
}
```

**Authentication:** Session token in `auth` field
**Request ID:** UUID for request tracking

## Image Upload API

**Separate REST endpoints for image uploads:**
- **Reserve blob:** `POST /api/` with `{"name": "store.blob.add", "params": {"type": "banner"}}`
- **Upload image:** `PUT /api/blobs/upload/{uuid}?_dc={timestamp}` with binary image data
- **Content-Type:** `application/octet-stream`

## Observed Operations

### Brand Operations
- **`store.product.brand.add`** - Create new brand
- **`store.product.brand.list`** - List/search brands (supports `query` parameter)

### Product Group Operations
- **`store.product.group.add`** - Create new product group (master product)
- **`store.product.group.clone`** - Clone existing product group for variants
- **`store.product.group.edit`** - Update product group properties
- **`store.product.group.get`** - Retrieve product group by ID
- **`store.product.group.list`** - List product groups

### Product/Variant Operations
- **`store.product.add`** - Create new product variant
- **`store.product.edit`** - Update product variant
- **`store.product.get`** - Retrieve product by ID

### Distributor Operations
- **`store.distributor.list`** - List distributors
- **`store.distributor.product.add`** - Create distributor product relationship
- **`store.distributor.product.list`** - List distributor products for a product
- **`store.distributor.product.price.add`** - Add pricing for distributor product

### Reference Data Operations
- **`store.product.category.list`** - List product categories
- **`store.product.strain.list`** - List strains (supports `query`, `page`, `pageSize`)
- **`store.product.quality.line.list`** - List quality lines
- **`store.product.tag.list`** - List product tags
- **`store.product.effect.list`** - List effects
- **`store.product.sale.type.list`** - List sale types
- **`store.product.price.preset.list`** - List price presets

### Inventory Operations
- **`store.inventory.product.barcode.list`** - List barcodes for product

### Analytics Operations
- **`store.widgets`** - Dashboard widgets/analytics

## Required Operation Sequences

### 1. Create New Brand with Image
```
1. POST store.blob.add {"type": "banner"} → Get blob UUID
2. PUT /api/blobs/upload/{uuid} → Upload image binary
3. POST store.product.brand.add {"name": "Brand Name", "images": [uuid]}
```

### 2. Create New Product Group with Image
```
1. Search for brand: POST store.product.brand.list {"query": "brand name"}
2. List categories: POST store.product.category.list (includes subcategories and sizes)
3. List strains: POST store.product.strain.list {"query": "strain name"}
4. List quality lines: POST store.product.quality.line.list
5. List tags: POST store.product.tag.list
6. (Optional) Upload image: POST store.blob.add + PUT upload
7. POST store.product.group.add {brandId, categoryId, subcategoryId, strainId, ...}
```

### 3. Create Product Variant
```
1. POST store.product.add {productGroupId, sizeId, price, tab, ...}
```

### 4. Add Distributor Relationship
```
1. List distributors: POST store.distributor.list
2. POST store.distributor.product.add {distributorId, productId, name, productQty}
3. POST store.distributor.product.price.add {distributorProductId, fromDate, distributorProductPrice}
```

<!-- ### 5. Clone Product Group for Variants
```
1. GET existing product group: POST store.product.group.get {id}
2. (Optional) Upload new image: POST store.blob.add + PUT upload
3. POST store.product.group.clone {parentId, name, strainId, imagesIds, ...}
``` -->

## Search Patterns

**Search APIs (partial text matching):**
- `store.product.brand.list` with `query` parameter (`"the gre"` matches "The Green Lady")
- `store.product.strain.list` with `query` parameter (`"lemon"`, `"sat"`, `"ind"`, `"hyb"`)

**List APIs (enumerated lists, exact name matching):**
- `store.product.category.list` (includes nested subcategories and sizes)
- `store.product.quality.line.list`
- `store.product.tag.list`
- `store.distributor.list`
- `store.product.effect.list`

## Pagination
Some list operations support pagination:
- `page`: Integer (1-based)
- `pageSize`: Integer (typical values: 50, 300, 1000000)

## Image Handling Notes

1. **Image upload is two-step process:**
   - Reserve blob UUID via `store.blob.add`
   - Upload binary data via separate PUT endpoint
2. **Image types:** `"banner"` for product/brand images
3. **Binary upload:** Uses `application/octet-stream` content type
4. **Cache busting:** Upload URLs include `_dc` timestamp parameter

## Typical UI Workflow Pattern

The UI heavily relies on real-time API calls rather than cached reference data:
1. **Form population:** Multiple reference data API calls when forms load
2. **Search-as-you-type:** Partial queries to brand/strain search APIs
3. **Validation:** Real-time lookups for related data
4. **Immediate persistence:** Each form field often triggers immediate API calls

## Error Handling
- Standard HTTP status codes
- JSON responses (structure not captured in HAR)

## Rate Limiting
No obvious rate limiting observed in the captured session.
