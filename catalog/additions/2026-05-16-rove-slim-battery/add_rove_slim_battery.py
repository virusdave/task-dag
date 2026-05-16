#!/usr/bin/env python3
"""Create a new catalog entry for the Rove Slim Battery (510-thread
vape battery, 350mAh, 3 voltage settings).

Background:
  Brand is adding a Rove Slim Battery accessory to our catalog.
  Source: https://rovebrand.com/collections/batteries/products/rove-slim-battery
  - Vendor MSRP listed: $22.00
  - Manufacturer offers two color editions (Gun Metal, Gold) but we
    are listing a single SKU and using the primary Gun Metal product
    image.

Pricing:
  - User asked for $20.00 OTD ("out the door", tax-inclusive).
  - This is a non-cannabis accessory (Accessories / Batteries,
    productClass Non-cannabis), so it is subject only to NYS+NYC
    combined sales tax of 8.875%, not the 13% combined cannabis
    excise.
  - List price = round(20.00 / 1.08875, 2) = $18.37
  - Sanity check: 18.37 * 1.08875 = $20.00 (within $0.005).

Verified ids:
  - Rove brand id = 1981
  - Accessories category id = 1084
  - Batteries subcategory id = 1096
  - 'Each' size id = 813

Description is clean customer-facing copy; no distributor or
internal info.

Run:
  python3 catalog/additions/2026-05-16-rove-slim-battery/add_rove_slim_battery.py            # dry run
  python3 catalog/additions/2026-05-16-rove-slim-battery/add_rove_slim_battery.py --apply    # write to Sweed
"""
from __future__ import annotations

import argparse
import json
import sys
import urllib.request
from pathlib import Path

WORKDIR = Path(__file__).resolve().parent
AUTOMATION_DIR = WORKDIR.parents[2]
BULK_ADDITIONS_DIR = AUTOMATION_DIR / "bulk_additions" / "2026-04-10"
if str(BULK_ADDITIONS_DIR) not in sys.path:
    sys.path.insert(0, str(BULK_ADDITIONS_DIR))

import apply_product_catalog_attribute_updates as sweed

ROVE_BRAND_ID = 1981
ACCESSORIES_CATEGORY_ID = 1084
BATTERIES_SUBCATEGORY_ID = 1096
EACH_SIZE_ID = 813

GROUP_NAME = "Slim Battery"
VARIANT_TAB = "Each"
VARIANT_LIST_PRICE = 18.37  # $20.00 OTD at 8.875% combined NYS+NYC sales tax
VARIANT_PACK_OF_SIZE = 1
VARIANT_IS_PACKED = True
VARIANT_DISPLAY_IN_ECOMMERCE = True

# Primary product shot from rovebrand.com (Gun Metal edition, default
# color). Direct CDN URL pulled from the product page listing.
PRODUCT_IMAGE_URL = "https://rovebrand.com/cdn/shop/products/gunbattery2.jpg?v=1674583607"

DESCRIPTION = (
    "The Rove Slim Battery is a sleek 510-thread vape battery designed to "
    "pair with Rove cartridges and other standard 510 carts. It features a "
    "350mAh capacity with three adjustable voltage settings so you can dial "
    "in the size of each draw, and it recharges quickly from any standard "
    "USB power source. The slim form factor slips easily into a pocket or "
    "bag, making it a discreet daily-carry option.\n\n"
    "Built for simplicity and consistency, the Slim Battery delivers steady "
    "power across its three preset voltages, so your favorite cartridge "
    "tastes the way it should from first hit to last. The button-activated "
    "draw and click-through voltage selector keep operation straightforward, "
    "and the rechargeable design means you can keep it topped up between "
    "sessions instead of replacing single-use hardware.\n\n"
    "Need a reliable 510 battery to power your favorite cartridge? You'll "
    "find the Rove Slim Battery at Freshly Baked NYC, your trusted local "
    "weed shop. We're a licensed cannabis dispensary committed to a "
    "convenient, accessible shopping experience, with fast delivery that "
    "brings your accessories right to your door. Visit us today and "
    "discover why Freshly Baked NYC is the go-to destination for cannabis "
    "in the city."
)


def download_bytes(url: str) -> bytes:
    request = urllib.request.Request(url, headers={"user-agent": "Mozilla/5.0"})
    with urllib.request.urlopen(request, timeout=60) as response:
        return response.read()


def upload_image(url: str) -> str:
    blob_id = sweed.api_call("store.blob.add", {"type": "banner"})
    upload_request = urllib.request.Request(
        f"https://prime.sweedpos.com/api/blobs/upload/{blob_id}",
        data=download_bytes(url),
        method="PUT",
        headers={
            "content-type": "application/octet-stream",
            "user-agent": "Mozilla/5.0",
        },
    )
    with urllib.request.urlopen(upload_request, timeout=60) as response:
        response.read()
    return blob_id


def summarize_group(group: dict) -> dict:
    return {
        "id": group["id"],
        "name": group.get("name"),
        "brand": (group.get("brand") or {}).get("name"),
        "category": (group.get("category") or {}).get("name"),
        "categoryId": (group.get("category") or {}).get("id"),
        "subcategory": (group.get("subcategory") or {}).get("name"),
        "subcategoryId": (group.get("subcategory") or {}).get("id"),
        "strain": (group.get("strain") or {}).get("name"),
        "description": (group.get("description") or "")[:200],
        "images": [{"id": x.get("id"), "url": x.get("url")} for x in (group.get("images") or [])],
    }


def summarize_product(product: dict) -> dict:
    return {
        "id": product["id"],
        "name": product.get("name") or product.get("tab"),
        "tab": product.get("tab"),
        "groupId": product.get("productGroupId"),
        "size": (product.get("size") or {}).get("name"),
        "packOfSize": product.get("packOfSize"),
        "isPacked": product.get("isPacked"),
        "price": product.get("price"),
        "displayInEcommerce": product.get("displayInEcommerce"),
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--apply", action="store_true", help="Actually upload image and write to Sweed.")
    args = parser.parse_args()

    sweed.switch_to_state_context()

    print("PLAN:")
    print(f"  1. upload_image({PRODUCT_IMAGE_URL!r}) -> new blob id")
    print("  2. store.product.group.add (placeholder blob id):")
    placeholder_group_params = {
        "name": GROUP_NAME,
        "brandId": ROVE_BRAND_ID,
        "categoryId": ACCESSORIES_CATEGORY_ID,
        "subcategoryId": BATTERIES_SUBCATEGORY_ID,
        "description": DESCRIPTION,
        "imagesIds": ["<blob-id-from-step-1>"],
    }
    print(json.dumps(placeholder_group_params, indent=4))
    new_variant_params_template = {
        "sizeId": EACH_SIZE_ID,
        "price": VARIANT_LIST_PRICE,
        "tab": VARIANT_TAB,
        "displayInEcommerce": VARIANT_DISPLAY_IN_ECOMMERCE,
        "isPacked": VARIANT_IS_PACKED,
        "packOfSize": VARIANT_PACK_OF_SIZE,
    }
    print("  3. store.product.add (productGroupId resolved at apply):")
    print(json.dumps(new_variant_params_template, indent=4))
    otd = round(VARIANT_LIST_PRICE * 1.08875, 2)
    print(f"\n  (List price ${VARIANT_LIST_PRICE} * 1.08875 sales tax = ${otd} OTD)")

    if not args.apply:
        print("\nDry run - pass --apply to upload image and write to Sweed.")
        return 0

    print(f"\nApplying step 1 (upload product image)...")
    blob_id = upload_image(PRODUCT_IMAGE_URL)
    print(f"  -> blob id {blob_id}")

    new_group_params = {
        **placeholder_group_params,
        "imagesIds": [blob_id],
    }
    print("Applying step 2 (create Slim Battery group)...")
    new_group_result = sweed.api_call("store.product.group.add", new_group_params)
    new_group_id = new_group_result.get("id") if isinstance(new_group_result, dict) else new_group_result
    if isinstance(new_group_id, dict):
        new_group_id = new_group_id.get("id")
    if not new_group_id:
        print("  ! store.product.group.add did not return an id", file=sys.stderr)
        return 1
    print(f"  -> created group id {new_group_id}")

    new_variant_params = {**new_variant_params_template, "productGroupId": new_group_id}
    print(f"Applying step 3 (create Each variant at ${VARIANT_LIST_PRICE} list / ${otd} OTD)...")
    new_variant_result = sweed.api_call("store.product.add", new_variant_params)
    new_variant_id = new_variant_result.get("id") if isinstance(new_variant_result, dict) else new_variant_result
    if isinstance(new_variant_id, dict):
        new_variant_id = new_variant_id.get("id")
    if not new_variant_id:
        print("  ! store.product.add did not return an id", file=sys.stderr)
        return 1
    print(f"  -> created variant id {new_variant_id}")

    new_group_after = sweed.api_call("store.product.group.get", {"id": int(new_group_id)})
    new_variant_after = sweed.api_call("store.product.get", {"id": int(new_variant_id)})["product"]
    print("\nAFTER new group:")
    print(json.dumps(summarize_group(new_group_after), indent=2))
    print("\nAFTER new variant:")
    print(json.dumps(summarize_product(new_variant_after), indent=2))

    results_path = WORKDIR / "add_results.json"
    results_path.write_text(
        json.dumps(
            {
                "sourceUrl": "https://rovebrand.com/collections/batteries/products/rove-slim-battery",
                "imageSourceUrl": PRODUCT_IMAGE_URL,
                "imageBlobId": blob_id,
                "vendorMsrp": 22.00,
                "listPrice": VARIANT_LIST_PRICE,
                "otdPrice": otd,
                "salesTaxRate": 0.08875,
                "newGroup": summarize_group(new_group_after),
                "newVariant": summarize_product(new_variant_after),
                "newGroupParams": new_group_params,
                "newVariantParams": new_variant_params,
            },
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    print(f"\nWrote {results_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
