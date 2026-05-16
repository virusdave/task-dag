#!/usr/bin/env python3
"""Create a brand new catalog entry for Camino Chews - Boysenberry
(Soothing Sleep) 10ct / 100mg total.

Background:
  Sweed auto-suggested mapping this incoming SKU onto the existing
  Camino Sleep Boysenberry gummy group (300208 / variant 392754), but
  the package physically present is the new Camino *Chews* line - a
  taffy-style, individually wrapped sweet fruit chew, not the
  gummy. Camino's Chews are a separate product line; we are the first
  in our local market to carry them, so a new catalog group + variant
  is required before Receive can be completed.

Per-chew formulation per vendor packaging / dispensary listings:
  10mg THC + 5mg CBN + 5mg CBG  (2:1:1 THC:CBN:CBG), Soothing Sleep
  blend with chamomile and lavender extracts; 10 chews per pack /
  100mg total THC.

Pricing decision:
  - Distributor cost per pack: $15.00
  - Observed retail across NY dispensary listings: $27-$33.90, with
    $30.00 the modal market price (4+ stores).
  - Our existing Camino 10x 10mg / 100mg gummy line (e.g. group
    300208) is priced $33.00 at retail.
  - Setting price to $33.00 keeps the Chews aligned with our existing
    100mg Camino line and sits at the high end of the observed
    market range. Gross margin at cost $15.00 = 54.5%.

Customer-facing description deliberately omits any distributor name,
PO number, or other internal business detail.

Run:
  python3 catalog/additions/2026-05-16-camino-chews-boysenberry/add_camino_chews_boysenberry.py            # dry run
  python3 catalog/additions/2026-05-16-camino-chews-boysenberry/add_camino_chews_boysenberry.py --apply    # write to Sweed
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

CAMINO_BRAND_ID = 1891
EDIBLES_CATEGORY_ID = 1086
INDICA_STRAIN_ID = 10314
TEN_MG_SIZE_ID = 817

GROUP_NAME = "Chews Sleep Boysenberry 2:1:1 (THC:CBN:CBG)"
VARIANT_TAB = "10x 10mg"
VARIANT_PRICE = 33.0
VARIANT_PACK_OF_SIZE = 10
VARIANT_IS_PACKED = True
VARIANT_DISPLAY_IN_ECOMMERCE = True

DESCRIPTION = (
    "Wind down with Camino Chews Boysenberry, a soft, taffy-like fruit chew "
    "crafted for soothing sleep. Each individually wrapped chew is bursting "
    "with bright, jammy boysenberry flavor and a calming 2:1:1 blend of 10mg "
    "THC, 5mg CBN and 5mg CBG, enhanced with chamomile and lavender extracts "
    "plus indica-leaning terpenes. A 10-pack delivers 100mg of total THC in a "
    "portable, sweet format that's easy to dose one chew at a time.\n\n"
    "Boysenberry Sleep Chews are designed for nights when you need to let the "
    "day go. Many people reach for this blend to feel Relaxed, Calm and "
    "Sleepy as bedtime approaches. THC sets a mellow baseline; CBN, paired "
    "with THC, is often appreciated for its tranquil character; CBG offers "
    "additional supportive notes. Chamomile and lavender round out the chew "
    "with classic, time-tested wind-down flavors. The fruit chew texture is "
    "soft and chewy, similar in feel to a sweet boysenberry taffy.\n\n"
    "Looking for a new way to unwind at night? Camino Chews Boysenberry are "
    "available at Freshly Baked NYC, your trusted local weed shop. We're a "
    "licensed cannabis dispensary committed to a convenient, accessible "
    "shopping experience, with fast delivery that brings Camino Chews right "
    "to your door. Visit us today and discover why Freshly Baked NYC is the "
    "go-to destination for cannabis in the city."
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
        "brandId": CAMINO_BRAND_ID,
        "categoryId": EDIBLES_CATEGORY_ID,
        "strainId": INDICA_STRAIN_ID,
        "description": DESCRIPTION,
        "imagesIds": [],
    }
    new_variant_params_template = {
        "sizeId": TEN_MG_SIZE_ID,
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

    print("\nApplying step 1 (create new Camino Chews Boysenberry group)...")
    new_group_result = sweed.api_call("store.product.group.add", new_group_params)
    new_group_id = new_group_result.get("id") if isinstance(new_group_result, dict) else new_group_result
    if isinstance(new_group_id, dict):
        new_group_id = new_group_id.get("id")
    if not new_group_id:
        print("  ! store.product.group.add did not return an id", file=sys.stderr)
        return 1
    print(f"  -> created group id {new_group_id}")

    new_variant_params = {**new_variant_params_template, "productGroupId": new_group_id}
    print("Applying step 2 (create 10x 10mg variant at $33.00)...")
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
                "distributorCostPerPack": 15.0,
                "retailPrice": VARIANT_PRICE,
                "grossMarginPct": round((VARIANT_PRICE - 15.0) / VARIANT_PRICE * 100, 2),
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
