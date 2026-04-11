#!/usr/bin/env nix-shell
#!nix-shell -i python3 -p python3 python3Packages.requests

"""
Sweed Bulk Catalog Import Script

Usage: python3 bulk_catalog_import.py <csv_file>

Environment variables:
- SWEED_AUTH_TOKEN: Authentication token for Sweed API
- SWEED_BASE_URL: Base URL (default: https://prime.sweedpos.com)
- DEBUG: Set to 1 or true for verbose debug output

CSV Format: See product_import_example.csv for structure
"""

import sys
import os
import csv
import json
import uuid
import requests
import argparse
from typing import Dict, List, Optional, Any
from urllib.parse import urljoin

class SweedAPI:
    def __init__(self, base_url: str, auth_token: str, debug: bool = False):
        self.base_url = base_url.rstrip('/')
        self.auth_token = auth_token
        self.debug = debug
        self.session = requests.Session()

    def _debug(self, message: str):
        if self.debug:
            print(f"DEBUG: {message}", file=sys.stderr)

    def _api_call(self, operation: str, params: Dict = None) -> Dict:
        """Make JSON-RPC style API call"""
        if params is None:
            params = {}

        payload = {
            "auth": self.auth_token,
            "name": operation,
            "params": params,
            "id": str(uuid.uuid4())
        }

        self._debug(f"API Call: {operation} with params: {json.dumps(params, indent=2)}")

        response = self.session.post(
            f"{self.base_url}/api/",
            json=payload,
            headers={"Content-Type": "application/json"}
        )

        if response.status_code != 200:
            raise Exception(f"API call failed: HTTP {response.status_code} - {response.text}")

        result = response.json()
        self._debug(f"API Response: {json.dumps(result, indent=2)}")

        if "error" in result:
            raise Exception(f"API error: {result['error']}")

        return result.get("result", {})

    def upload_image(self, image_url: str) -> str:
        """Upload image from URL and return blob UUID"""
        if not image_url:
            return None

        self._debug(f"Uploading image from URL: {image_url}")

        # Step 1: Reserve blob UUID
        blob_result = self._api_call("store.blob.add", {"type": "banner"})
        self._debug(f"Blob add result type: {type(blob_result)}, value: {blob_result}")
        
        # The API returns the UUID directly as a string in the result field
        blob_uuid = blob_result

        if not blob_uuid:
            raise Exception(f"Failed to reserve blob UUID for image: {image_url}. Full response: {blob_result}")

        self._debug(f"Reserved blob UUID: {blob_uuid}")

        # Step 2: Download image (handle data URLs and HTTP URLs)
        if image_url.startswith('data:'):
            # Handle base64 data URLs
            import base64
            header, data = image_url.split(',', 1)
            image_data = base64.b64decode(data)
            self._debug(f"Decoded data URL, got {len(image_data)} bytes")
        else:
            # Handle HTTP URLs
            img_response = requests.get(image_url)
            if img_response.status_code != 200:
                raise Exception(f"Failed to download image from {image_url}: HTTP {img_response.status_code}")
            image_data = img_response.content

        # Step 3: Upload binary data
        upload_url = f"{self.base_url}/api/blobs/upload/{blob_uuid}"
        upload_response = self.session.put(
            upload_url,
            data=image_data,
            headers={"Content-Type": "application/octet-stream"}
        )

        if upload_response.status_code not in [200, 201]:
            raise Exception(f"Failed to upload image binary: HTTP {upload_response.status_code}")

        self._debug(f"Successfully uploaded image, blob UUID: {blob_uuid}")
        return blob_uuid

class CatalogImporter:
    def __init__(self, api: SweedAPI):
        self.api = api
        self._cache = {}

    def _get_cached_data(self, operation: str, params: Dict = None) -> Any:
        """Get and cache reference data"""
        cache_key = f"{operation}:{json.dumps(params or {}, sort_keys=True)}"

        if cache_key not in self._cache:
            self.api._debug(f"Fetching reference data: {operation}")
            result = self.api._api_call(operation, params)
            self._cache[cache_key] = result

        return self._cache[cache_key]

    def find_brand_id(self, brand_name: str) -> Optional[int]:
        """Find brand by name, return ID or None"""
        brands_result = self._get_cached_data("store.product.brand.list", {"query": brand_name.lower()})
        brands = brands_result if isinstance(brands_result, list) else brands_result
        for brand in brands:
            if brand.get("name", "").lower() == brand_name.lower():
                return brand.get("id")
        return None

    def create_brand(self, brand_name: str, image_url: str = None) -> int:
        """Create brand and return ID"""
        self.api._debug(f"Creating brand: {brand_name}")

        params = {"name": brand_name}

        if image_url:
            image_uuid = self.api.upload_image(image_url)
            if image_uuid:
                params["images"] = [image_uuid]

        result = self.api._api_call("store.product.brand.add", params)
        brand_id = result.get("id")

        if not brand_id:
            raise Exception(f"Failed to create brand: {brand_name}")

        self.api._debug(f"Created brand {brand_name} with ID: {brand_id}")
        return brand_id

    def find_by_name(self, items: List[Dict], name: str, field_name: str = "name") -> Optional[Dict]:
        """Find item in list by exact name match"""
        for item in items:
            if item.get(field_name, "").lower() == name.lower():
                return item
        return None

    def get_category_data(self) -> List[Dict]:
        """Get category data with nested subcategories and sizes"""
        return self._get_cached_data("store.product.category.list")

    def find_category_id(self, category_name: str) -> int:
        """Find category ID by name"""
        categories = self.get_category_data()
        category = self.find_by_name(categories, category_name)

        if not category:
            raise Exception(f"Category not found: '{category_name}'. Available categories: {[c.get('name') for c in categories]}")

        return category["id"]

    def find_subcategory_id(self, category_name: str, subcategory_name: str) -> int:
        """Find subcategory ID within category"""
        categories = self.get_category_data()
        category = self.find_by_name(categories, category_name)

        if not category:
            raise Exception(f"Category not found: '{category_name}'")

        subcategories = category.get("subcategories", [])
        subcategory = self.find_by_name(subcategories, subcategory_name)

        if not subcategory:
            available = [sc.get('name') for sc in subcategories]
            raise Exception(f"Subcategory '{subcategory_name}' not found in category '{category_name}'. Available: {available}")

        return subcategory["id"]

    def find_size_id(self, category_name: str, size_name: str) -> int:
        """Find size ID within category"""
        categories = self.get_category_data()
        category = self.find_by_name(categories, category_name)

        if not category:
            raise Exception(f"Category not found: '{category_name}'")

        sizes = category.get("sizes", [])
        size = self.find_by_name(sizes, size_name)

        if not size:
            available = [s.get('name') for s in sizes]
            raise Exception(f"Size '{size_name}' not found in category '{category_name}'. Available: {available}")

        return size["id"]

    def find_strain_id(self, strain_search: str) -> Optional[int]:
        """Find strain ID by search term"""
        if not strain_search:
            return None

        strain_result = self._get_cached_data("store.product.strain.list", {
            "query": strain_search.lower(),
            "page": 1,
            "pageSize": 300
        })
        
        # Handle paginated response structure - strain API returns {page, data, totalCount}
        if isinstance(strain_result, dict) and "data" in strain_result:
            strains = strain_result["data"]
        elif isinstance(strain_result, list):
            strains = strain_result
        else:
            strains = []
            
        self.api._debug(f"Extracted strains: type={type(strains)}, count={len(strains) if strains else 0}")
        
        if not strains:
            raise Exception(f"No strains found for search term: '{strain_search}'. strain_result was: {strain_result}")

        # Find all matching strains and pick the shortest one
        matches = []
        for strain in strains:
            strain_name = strain.get("name", "")
            if strain_search.lower() in strain_name.lower():
                matches.append((strain_name, strain["id"]))
        
        if not matches:
            available = [s.get("name") for s in strains]
            raise Exception(f"No matching strains for '{strain_search}'. Available: {available}")
        
        # Sort by length and pick shortest match
        shortest_match = min(matches, key=lambda x: len(x[0]))
        self.api._debug(f"Strain match: '{strain_search}' -> '{shortest_match[0]}' (ID: {shortest_match[1]})")
        
        return shortest_match[1]

    def find_quality_line_id(self, quality_line_name: str) -> int:
        """Find quality line ID by name"""
        quality_lines_result = self._get_cached_data("store.product.quality.line.list")
        quality_lines = quality_lines_result if isinstance(quality_lines_result, list) else quality_lines_result
        quality_line = self.find_by_name(quality_lines, quality_line_name)

        if not quality_line:
            available = [ql.get('name') for ql in quality_lines]
            raise Exception(f"Quality line not found: '{quality_line_name}'. Available: {available}")

        return quality_line["id"]

    def find_tag_id(self, tag_name: str) -> str:
        """Find tag ID by name"""
        tags_result = self._get_cached_data("store.product.tag.list")
        tags = tags_result if isinstance(tags_result, list) else tags_result
        tag = self.find_by_name(tags, tag_name)

        if not tag:
            available = [t.get('name') for t in tags]
            raise Exception(f"Tag not found: '{tag_name}'. Available: {available}")

        return tag["id"]

    def find_distributor_id(self, distributor_name: str) -> int:
        """Find distributor ID by name"""
        distributors = self._get_cached_data("store.distributor.list")
        distributor = self.find_by_name(distributors, distributor_name)

        if not distributor:
            available = [d.get('name') for d in distributors]
            raise Exception(f"Distributor not found: '{distributor_name}'. Available: {available}")

        return distributor["id"]

    def create_product_group(self, row_data: Dict[str, str]) -> int:
        """Create product group and return ID"""
        self.api._debug(f"Creating product group: {row_data['product_name']}")

        params = {
            "name": row_data["product_name"],
            "description": row_data["product_description"],
            "isFinishedProduct": row_data["is_finished_product"].lower() == "true",
            "brandId": self.find_brand_id(row_data["brand_name"]) or self.create_brand(
                row_data["brand_name"],
                row_data.get("brand_image_url")
            ),
            "categoryId": self.find_category_id(row_data["category_name"]),
            "subcategoryId": self.find_subcategory_id(row_data["category_name"], row_data["subcategory_name"]),
            "qualityLineId": self.find_quality_line_id(row_data["quality_line_name"]),
            "tagIds": [self.find_tag_id(row_data["tag_name"])]
        }

        # Optional strain
        if row_data.get("strain_search"):
            strain_id = self.find_strain_id(row_data["strain_search"])
            if strain_id:
                params["strainId"] = strain_id

        # Optional product image
        if row_data.get("product_image_url"):
            image_uuid = self.api.upload_image(row_data["product_image_url"])
            if image_uuid:
                params["imagesIds"] = [image_uuid]

        # Optional product type (typeId)
        if row_data.get("product_type_name"):
            # Note: We don't have product type lookup implemented yet
            self.api._debug(f"WARNING: product_type_name '{row_data['product_type_name']}' specified but not implemented")

        result = self.api._api_call("store.product.group.add", params)
        group_id = result.get("id")

        if not group_id:
            raise Exception(f"Failed to create product group: {row_data['product_name']}")

        self.api._debug(f"Created product group '{row_data['product_name']}' with ID: {group_id}")
        return group_id

    def create_product_variant(self, row_data: Dict[str, str], product_group_id: int) -> str:
        """Create product variant and return product ID"""
        self.api._debug(f"Creating product variant for group ID: {product_group_id}")

        # Convert string data to appropriate types with error handling
        try:
            price = float(row_data["variant_price"]) if row_data.get("variant_price") else 0.0
            pack_size = int(row_data["variant_pack_size"]) if row_data.get("variant_pack_size") else 1
            display_ecommerce = row_data.get("variant_display_ecommerce", "").lower() in ["true", "1", "yes"]
            is_packed = row_data.get("variant_is_packed", "").lower() in ["true", "1", "yes"]
        except (ValueError, TypeError) as e:
            raise Exception(f"Type conversion error in variant data: {e}. Row data: {row_data}")
        
        params = {
            "productGroupId": product_group_id,
            "sizeId": self.find_size_id(row_data["category_name"], row_data["variant_size_name"]),
            "price": price,
            "tab": row_data["variant_display_name"],
            "displayInEcommerce": display_ecommerce,
            "isPacked": is_packed,
            "packOfSize": pack_size
        }

        result = self.api._api_call("store.product.add", params)
        product_id = result.get("id")

        if not product_id:
            raise Exception(f"Failed to create product variant for group ID: {product_group_id}")

        self.api._debug(f"Created product variant with ID: {product_id}")
        return str(product_id)

    def create_distributor_product(self, row_data: Dict[str, str], product_id: str) -> str:
        """Create distributor product and return distributor product ID"""
        self.api._debug(f"Creating distributor product for product ID: {product_id}")

        params = {
            "distributorId": self.find_distributor_id(row_data["distributor_name"]),
            "productId": product_id,
            "name": row_data["distributor_product_name"],
            "productQty": int(row_data["distributor_qty"])
        }

        result = self.api._api_call("store.distributor.product.add", params)
        dist_product_id = result.get("id")

        if not dist_product_id:
            raise Exception(f"Failed to create distributor product for product ID: {product_id}")

        self.api._debug(f"Created distributor product with ID: {dist_product_id}")
        return str(dist_product_id)

    def create_distributor_pricing(self, row_data: Dict[str, str], distributor_product_id: str):
        """Create distributor product pricing"""
        if not row_data.get("wholesale_price"):
            self.api._debug("No wholesale price specified, skipping pricing creation")
            return

        self.api._debug(f"Creating pricing for distributor product ID: {distributor_product_id}")

        params = {
            "distributorProductId": distributor_product_id,
            "fromDate": "2025-09-11",  # TODO: Make this configurable
            "distributorProductPrice": float(row_data["wholesale_price"])
        }

        result = self.api._api_call("store.distributor.product.price.add", params)
        self.api._debug(f"Created distributor pricing: {row_data['wholesale_price']}")

    def validate_required_fields(self, row_data: Dict[str, str]):
        """Validate that all required fields are present and can be resolved"""
        required_fields = [
            "brand_name", "product_name", "product_description",
            "category_name", "subcategory_name", "quality_line_name",
            "tag_name", "variant_size_name", "variant_price",
            "variant_display_name", "distributor_name", "distributor_product_name",
            "distributor_qty", "is_finished_product", "variant_display_ecommerce",
            "variant_is_packed", "variant_pack_size"
        ]

        missing_fields = [field for field in required_fields if not row_data.get(field)]
        if missing_fields:
            raise Exception(f"Missing required fields: {missing_fields}")

    def process_row(self, row_data: Dict[str, str]):
        """Process a single CSV row"""
        try:
            self.api._debug(f"Processing product: {row_data.get('product_name', 'UNKNOWN')}")

            # Validate required fields
            self.validate_required_fields(row_data)

            # Create product group
            product_group_id = self.create_product_group(row_data)

            # Create product variant
            product_id = self.create_product_variant(row_data, product_group_id)

            # Create distributor product
            distributor_product_id = self.create_distributor_product(row_data, product_id)

            # Create distributor pricing (if wholesale price provided)
            self.create_distributor_pricing(row_data, distributor_product_id)

            print(f"✓ Successfully created product: {row_data['product_name']} (Product ID: {product_id})")

        except Exception as e:
            print(f"✗ Error processing {row_data.get('product_name', 'UNKNOWN')}: {e}")
            raise

def main():
    parser = argparse.ArgumentParser(description='Sweed Bulk Catalog Import')
    parser.add_argument('csv_file', help='CSV file containing product data')
    parser.add_argument('--debug', action='store_true', help='Enable debug output')
    args = parser.parse_args()

    # Check for debug flag in environment or command line
    debug = args.debug or os.getenv('DEBUG', '').lower() in ['1', 'true', 'yes']

    # Get credentials
    auth_token = os.getenv('SWEED_AUTH_TOKEN')
    if not auth_token:
        print("ERROR: SWEED_AUTH_TOKEN environment variable required", file=sys.stderr)
        sys.exit(1)

    # base_url = os.getenv('SWEED_BASE_URL', 'https://prime.sweedpos.com')
    base_url = os.getenv('SWEED_BASE_URL', 'https://demo.sweedpos.com')

    # Initialize API client
    api = SweedAPI(base_url, auth_token, debug)
    importer = CatalogImporter(api)

    # Process CSV file
    try:
        with open(args.csv_file, 'r', newline='', encoding='utf-8') as csvfile:
            reader = csv.reader(csvfile)

            # Parse header to create column mapping
            headers = next(reader)
            col_map = {name.strip(): idx for idx, name in enumerate(headers)}

            if debug:
                print(f"DEBUG: Found columns: {list(col_map.keys())}", file=sys.stderr)

            row_count = 0
            success_count = 0

            for row_num, row in enumerate(reader, start=2):
                try:
                    # Create row data dictionary using column names
                    row_data = {}
                    for col_name, col_idx in col_map.items():
                        value = row[col_idx].strip() if col_idx < len(row) else ""
                        # Strip surrounding quotes if present
                        if value.startswith('"') and value.endswith('"'):
                            value = value[1:-1]
                        row_data[col_name] = value

                    if debug:
                        print(f"DEBUG: Processing row {row_num}: {row_data.get('product_name', 'UNKNOWN')}", file=sys.stderr)

                    # Skip empty rows
                    if not any(row_data.values()):
                        continue

                    importer.process_row(row_data)
                    success_count += 1
                    row_count += 1

                except Exception as e:
                    print(f"ERROR on row {row_num}: {e}")
                    if debug:
                        import traceback
                        traceback.print_exc()
                    sys.exit(1)

            print(f"\n✓ Successfully processed {success_count}/{row_count} products")

    except FileNotFoundError:
        print(f"ERROR: CSV file not found: {args.csv_file}", file=sys.stderr)
        sys.exit(1)
    except Exception as e:
        print(f"ERROR: {e}", file=sys.stderr)
        if debug:
            import traceback
            traceback.print_exc()
        sys.exit(1)

if __name__ == "__main__":
    main()
