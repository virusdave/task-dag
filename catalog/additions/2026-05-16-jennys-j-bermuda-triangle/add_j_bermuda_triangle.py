#!/usr/bin/env python3
"""Create a new catalog entry for Jenny's J Bermuda Triangle 1g pre-roll.

Background:
  Incoming purchase line "Jenny's J 1G Bermuda Triangle Pre-Roll" has no
  existing or suggested catalog match. Jenny's already has the
  same-format "J <Strain>" 1g preroll entries (e.g. J Acapulco Gold
  group 317809 variant 413055, J Biscotti group 317810 variant 413056),
  both priced at $13.50. Mirror that.

Verified ids:
  - Jenny's brand id = 1941
  - Pre-Rolls category id = 1085
  - Bermuda Triangle strain id = 10213
  - 1g size id = 842

Description is clean customer-facing copy. Does NOT include any
distributor name, PO number, or other internal business detail (the
older Jenny's J entries inadvertently mention "Midtown Jenny's pending
purchase" / "received and mapped"; that pattern is not repeated here).

Run:
  python3 catalog/additions/2026-05-16-jennys-j-bermuda-triangle/add_j_bermuda_triangle.py            # dry run
  python3 catalog/additions/2026-05-16-jennys-j-bermuda-triangle/add_j_bermuda_triangle.py --apply    # write to Sweed
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

WORKDIR = Path(__file__).resolve().parent
AUTOMATION_DIR = WORKDIR.parents[2]
BULK_ADDITIONS_DIR = AUTOMATION_DIR / "bulk_additions" / "2026-04-10"
if str(BULK_ADDITIONS_DIR) not in sys.path:
    sys.path.insert(0, str(BULK_ADDITIONS_DIR))

import apply_product_catalog_attribute_updates as sweed

JENNYS_BRAND_ID = 1941
PREROLLS_CATEGORY_ID = 1085
BERMUDA_TRIANGLE_STRAIN_ID = 10213
ONE_GRAM_SIZE_ID = 842

GROUP_NAME = "J Bermuda Triangle"
VARIANT_TAB = "1g"
VARIANT_PRICE = 13.5
VARIANT_PACK_OF_SIZE = 1
VARIANT_IS_PACKED = True
VARIANT_DISPLAY_IN_ECOMMERCE = True

DESCRIPTION = (
    "Jenny's J Bermuda Triangle is a 1g pre-roll featuring the Bermuda "
    "Triangle strain in Jenny's signature ready-to-light single J format. "
    "Bermuda Triangle is an OG-leaning hybrid known for a layered aroma of "
    "bright citrus peel, earthy diesel and a hint of spicy pine, with a "
    "flavor that opens on sweet lime and finishes with smooth diesel "
    "warmth. The hand-rolled 1g format makes it easy to spark up and "
    "enjoy without any prep.\n\n"
    "Bermuda Triangle is often reported to bring on a clear, uplifting "
    "head lift that gradually settles into a deep, relaxed body feel. "
    "Many people reach for it to feel Relaxed, Happy and Calm at the end "
    "of a long day, and its terpene profile - led by limonene, "
    "caryophyllene and myrcene - delivers a balanced experience that "
    "leans toward unwinding. Each Jenny's J pre-roll offers a "
    "straightforward way to enjoy the qualities of this distinctive "
    "strain in a single-session size.\n\n"
    "Looking for the Bermuda Triangle experience in an easy 1g pre-roll? "
    "You'll find Jenny's J Bermuda Triangle at Freshly Baked NYC, your "
    "trusted local weed shop. We're a licensed cannabis dispensary "
    "committed to a convenient, accessible shopping experience, with "
    "fast delivery that brings Jenny's pre-rolls right to your door. "
    "Visit us today and discover why Freshly Baked NYC is the go-to "
    "destination for cannabis in the city."
)


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
    parser.add_argument("--apply", action="store_true", help="Actually write to Sweed.")
    args = parser.parse_args()

    sweed.switch_to_state_context()

    new_group_params = {
        "name": GROUP_NAME,
        "brandId": JENNYS_BRAND_ID,
        "categoryId": PREROLLS_CATEGORY_ID,
        "strainId": BERMUDA_TRIANGLE_STRAIN_ID,
        "description": DESCRIPTION,
        "imagesIds": [],
    }
    new_variant_params_template = {
        "sizeId": ONE_GRAM_SIZE_ID,
        "price": VARIANT_PRICE,
        "tab": VARIANT_TAB,
        "displayInEcommerce": VARIANT_DISPLAY_IN_ECOMMERCE,
        "isPacked": VARIANT_IS_PACKED,
        "packOfSize": VARIANT_PACK_OF_SIZE,
    }

    print("PLAN:")
    print("  1. store.product.group.add:")
    print(json.dumps(new_group_params, indent=4))
    print("  2. store.product.add (productGroupId resolved at apply):")
    print(json.dumps(new_variant_params_template, indent=4))

    if not args.apply:
        print("\nDry run - pass --apply to write to Sweed.")
        return 0

    print("\nApplying step 1 (create J Bermuda Triangle group)...")
    new_group_result = sweed.api_call("store.product.group.add", new_group_params)
    new_group_id = new_group_result.get("id") if isinstance(new_group_result, dict) else new_group_result
    if isinstance(new_group_id, dict):
        new_group_id = new_group_id.get("id")
    if not new_group_id:
        print("  ! store.product.group.add did not return an id", file=sys.stderr)
        return 1
    print(f"  -> created group id {new_group_id}")

    new_variant_params = {**new_variant_params_template, "productGroupId": new_group_id}
    print("Applying step 2 (create 1g variant at $13.50)...")
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
                "newGroup": summarize_group(new_group_after),
                "newVariant": summarize_product(new_variant_after),
                "newGroupParams": new_group_params,
                "newVariantParams": new_variant_params,
                "retailPrice": VARIANT_PRICE,
                "priceMatchedFrom": [
                    {"groupId": 317809, "variantId": 413055, "name": "Jenny's J Acapulco Gold 1g", "price": 13.5},
                    {"groupId": 317810, "variantId": 413056, "name": "Jenny's J Biscotti 1g", "price": 13.5},
                ],
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
