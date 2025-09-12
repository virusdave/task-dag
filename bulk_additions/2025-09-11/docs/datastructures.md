# Sweed API Data Structures

Based on analysis of HAR file from product catalog additions workflow.

## Core Entities

### Brand
**API Endpoint:** `store.product.brand.add`
**ID Type:** Integer (e.g., 4424)
**Attributes:**
- `name`: String - Brand name ("The Green Lady")
- `images`: Array[String] - Array of image blob UUIDs

**Search API:** `store.product.brand.list` with optional `query` parameter

### ProductGroup (Master Product Definition)
**API Endpoint:** `store.product.group.add`, `store.product.group.clone`
**ID Type:** Integer (e.g., 78741, 78748, 78755)
**Attributes:**
- `name`: String - Product name ("Lemon Meringue", "Painkiller")
- `description`: String - Full product description
- `brandId`: Integer FK → Brand.id (4424)
- `categoryId`: Integer FK → Category.id (1087=Vaporizers, 1086=Edibles)
- `subcategoryId`: Integer FK → Subcategory.id (1111, 2021, 1106)
- `strainId`: Integer FK → Strain.id (10401, 10314) | null for non-strain products
- `qualityLineId`: Integer FK → QualityLine.id (218, 222)
- `typeId`: Integer FK → ProductType.id | null
- `isFinishedProduct`: Boolean (true for pre-packaged items)
- `imagesIds`: Array[String] - Array of image blob UUIDs
- `tagIds`: Array[String] - Array of tag IDs (["199269", "199268"])
- `effectIds`: Array[Integer] - Effect IDs (from clone operation)
- `flavoringIds`: Array[Integer] - Flavoring IDs (from clone operation)
- `scentIds`: Array[Integer] - Scent IDs (from clone operation)
- `parentId`: Integer FK → ProductGroup.id (for cloned products)
- `defaultSizeForNonPackedProducts`: Object with {id, name} (from clone operation)

**Search APIs:** `store.product.group.list`

### Product (Variant/SKU)
**API Endpoint:** `store.product.add`
**ID Type:** String (e.g., "90794", "90802", "90810")
**Attributes:**
- `productGroupId`: Integer FK → ProductGroup.id (78741, 78748)
- `sizeId`: Integer FK → Size.id (842=1g, 817=10ct)
- `price`: Decimal - Retail price (100)
- `tab`: String - Display name for variant ("1g", "10x 10mg")
- `displayInEcommerce`: Boolean (true)
- `isPacked`: Boolean (true for pre-packaged)
- `packOfSize`: Integer - Number of units in package (1, 10)

**Search APIs:** `store.product.get`, `store.product.edit`

### DistributorProduct
**API Endpoint:** `store.distributor.product.add`
**ID Type:** String auto-generated (e.g., "97131", "97132")
**Attributes:**
- `distributorId`: Integer FK → Distributor.id (644)
- `productId`: String FK → Product.id ("90794")
- `name`: String - Full distributor product name
- `productQty`: Integer - Quantity (typically 1)

**Search APIs:** `store.distributor.product.list`

### DistributorProductPrice
**API Endpoint:** `store.distributor.product.price.add`
**Attributes:**
- `distributorProductId`: String FK → DistributorProduct.id ("97131")
- `fromDate`: String Date - Effective date ("2025-09-11")
- `distributorProductPrice`: Decimal - Wholesale cost (22.94, 11.47, 13.77)

## Reference Data Entities

### Category
**Search API:** `store.product.category.list`
**ID Type:** Integer (1087, 1086)
**Examples:** 1087="Vapes", 1086="Edibles"
**Structure:** Each category includes `sizes[]` and `subcategories[]` arrays with {id, name, enabled} objects

### Subcategory
**ID Type:** Integer (1111, 2021, 1106)
**Examples:** 1111="Cartridge", 2021="All-In-One", 1106="Chews/Gummies"
**Note:** Available subcategories are nested within category responses from `store.product.category.list`

### Strain
**Search API:** `store.product.strain.list` with `query` parameter
**ID Type:** Integer (10401, 10314, 10312)
**Search Examples:** "lemon", "sat", "ind", "hyb"

### QualityLine
**List API:** `store.product.quality.line.list` (enumerated list, exact name matching)
**ID Type:** Integer (218, 222)
**Examples:** 218="Oil for Vaporization", 222="Gel-based foods"

### Size
**ID Type:** Integer (842, 817)
**Examples:** 842="1g", 817="10mg"
**Note:** Available sizes are nested within category responses from `store.product.category.list`

### Tag
**List API:** `store.product.tag.list` (enumerated list, exact name matching)
**ID Type:** String ("199269", "199268")

### Distributor
**List API:** `store.distributor.list` (enumerated list, exact name matching)
**ID Type:** Integer (644)

### Effect
**List API:** `store.product.effect.list` (enumerated list, exact name matching)
**ID Type:** Integer

### Blob (Images)
**API Endpoint:** `store.blob.add`
**ID Type:** String UUID (e.g., "c2b2e0f3-f051-49c1-bfbf-5a7eb5df174a")
**Attributes:**
- `type`: String ("banner" for product images)

## Data Type Patterns

**Integer IDs:** Brand, Category, Subcategory, Strain, QualityLine, Size, Distributor, ProductGroup, ProductType, Effect, Flavoring, Scent
**String IDs:** Product, DistributorProduct, Tag, Blob (UUIDs)
**Naming Convention:** Foreign keys use pattern `{entityName}Id`

## Workflow Dependencies

1. **Brand** must exist before ProductGroup creation
2. **Category, Subcategory, Strain, QualityLine** must exist before ProductGroup creation  
3. **ProductGroup** must exist before Product creation
4. **Size** must exist before Product creation
5. **Product** must exist before DistributorProduct creation
6. **DistributorProduct** must exist before DistributorProductPrice creation
7. **Images** must be uploaded as Blobs before referencing in ProductGroup or Brand
