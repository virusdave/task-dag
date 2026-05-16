#!/usr/bin/env python3
"""Revert the earlier 'fix' on group 286942 / product 376985 and split off
the actual vape into its own brand-new group + variant.

Background:
  - product 376985 / group 286942 was a 1g Sour Diesel pre-roll priced
    at $12.50.
  - The 2026-05-13 purchase apply re-priced that variant to $52.50 to
    fit a vape that was mistakenly mapped onto it.
  - catalog/fixes/2026-05-16-product-286942/fix.py then re-categorised
    the group from Pre-Rolls to Vapes / All In One / Disposable,
    rewrote the description, and replaced the (empty) image set with
    a vape product shot.

That whole vape migration was wrong. The variant is still really a
preroll; the vape is a separate SKU. This script:

  1. Reverts group 286942 back to a Pre-Rolls group with its original
     name, original (pre-fix) description, and empty image set.
  2. Reverts product 376985's price back to $12.50.
  3. Creates a brand-new product group 'Sour Diesel' under
     Vapes / All In One / Disposable, Herb brand, Sour Diesel strain,
     with the vape description and the vape product image (reusing the
     blob that was already uploaded by the earlier fix:
     8dd131a6-e669-42b0-a6b3-f4b4b4a35514).
  4. Creates a 1g variant on that new vape group at $52.50, displayed
     in ecommerce, packOfSize 1.
  5. Pages Dave so the operator can pick up where they left off.

The original preroll description and category were recovered from the
first commit of fix_results.json (0d20eb3).

Run:
  python3 catalog/fixes/2026-05-16-product-286942-revert-and-split/revert_and_split.py            # dry run
  python3 catalog/fixes/2026-05-16-product-286942-revert-and-split/revert_and_split.py --apply    # write to Sweed + page Dave
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

WORKDIR = Path(__file__).resolve().parent
AUTOMATION_DIR = WORKDIR.parents[2]
BULK_ADDITIONS_DIR = AUTOMATION_DIR / "bulk_additions" / "2026-04-10"
if str(BULK_ADDITIONS_DIR) not in sys.path:
    sys.path.insert(0, str(BULK_ADDITIONS_DIR))

import apply_product_catalog_attribute_updates as sweed

PREROLL_GROUP_ID = 286942
PREROLL_PRODUCT_ID = "376985"
PREROLL_ORIGINAL_PRICE = 12.5
PREROLL_CATEGORY_ID = 1085  # Pre-Rolls
PREROLL_SUBCATEGORY_ID = None  # original 'before' captured subcategory as null

# Verbatim from the first commit of fix_results.json (0d20eb3) - this was
# the live description on group 286942 before any of the vape edits.
PREROLL_DESCRIPTION = (
    "Enjoy the classic Sour Diesel experience with Herb Sour Diesel 1g "
    "Pre-Rolls. These convenient Pre-Rolls offer a straightforward way to "
    "experience this well-known strain. Each 1g pre-roll is ready to go, "
    "providing a simple and accessible option for any occasion. Herb "
    "delivers a consistent experience, making it easy to enjoy the "
    "qualities of Sour Diesel whenever you choose.\n\n"
    "The Herb Sour Diesel 1g Pre-Roll delivers the classic experience of "
    "this renowned strain. Known for its distinct effects, Sour Diesel is "
    "reported to leave users feeling Energetic, Uplifted, and Talkative. "
    "This sativa-leaning strain is a favorite for those seeking a boost in "
    "creativity and a positive mindset. Each pre-roll offers a convenient "
    "way to enjoy the qualities associated with Sour Diesel, providing a "
    "consistent experience in a ready-to-use format. These 1g pre-rolls "
    "are designed for straightforward enjoyment of this well-known and "
    "sought-after strain.\n\n"
    "Looking for the classic Sour Diesel experience? You'll find Herb Sour "
    "Diesel 1g Pre-Rolls at Freshly Baked NYC, your trusted local weed "
    "shop. We're a licensed cannabis dispensary dedicated to providing a "
    "convenient and accessible shopping experience. Enjoy the qualities of "
    "this well-known strain with ease, and take advantage of our fast "
    "delivery to get your Herb Sour Diesel Pre-Rolls delivered right to "
    "your door. Visit us today and discover why Freshly Baked NYC is the "
    "go-to destination for cannabis in the city."
)

# New vape group/variant configuration
VAPE_GROUP_NAME = "Sour Diesel"
HERB_BRAND_ID = 11912
SOUR_DIESEL_STRAIN_ID = 10409
VAPE_CATEGORY_ID = 1087           # Vapes
VAPE_SUBCATEGORY_ID = 1112        # All In One / Disposable
ONE_GRAM_SIZE_ID = 842            # 1g (Gram, weight-based, uomNumber 1.0)
VAPE_VARIANT_TAB = "1g"
VAPE_VARIANT_PRICE = 52.5
VAPE_VARIANT_PACK_OF_SIZE = 1
VAPE_VARIANT_IS_PACKED = True
VAPE_VARIANT_DISPLAY_IN_ECOMMERCE = True
# Already-uploaded vape product shot blob id (from the prior fix's apply).
VAPE_IMAGE_BLOB_ID = "8dd131a6-e669-42b0-a6b3-f4b4b4a35514"
VAPE_DESCRIPTION = (
    "Enjoy the classic Sour Diesel experience with the Herb Sour Diesel 1g "
    "All-In-One Vape. This 1g disposable vape is ready to use straight out of "
    "the box \u2014 no batteries, pods, or chargers needed. It delivers a "
    "simple, self-contained way to experience this well-known strain wherever "
    "you go. Herb keeps the format straightforward, making it easy to enjoy "
    "the qualities of Sour Diesel whenever you choose.\n\n"
    "The Herb Sour Diesel 1g All-In-One Vape captures the character of this "
    "renowned strain in a convenient disposable form factor. Known for its "
    "distinct effects, Sour Diesel is reported to leave users feeling "
    "Energetic, Uplifted, and Talkative. This sativa-leaning strain is a "
    "favorite for those seeking a boost in creativity and a positive mindset. "
    "Each 1g all-in-one vape offers a contained and portable way to enjoy the "
    "qualities associated with Sour Diesel, providing a consistent experience "
    "in a ready-to-use format.\n\n"
    "Looking for the classic Sour Diesel experience in a disposable vape? "
    "You'll find the Herb Sour Diesel 1g All-In-One Vape at Freshly Baked "
    "NYC, your trusted local weed shop. We're a licensed cannabis dispensary "
    "dedicated to providing a convenient and accessible shopping experience. "
    "Enjoy the qualities of this well-known strain with ease, and take "
    "advantage of our fast delivery to get your Herb Sour Diesel 1g "
    "All-In-One Vape delivered right to your door. Visit us today and "
    "discover why Freshly Baked NYC is the go-to destination for cannabis in "
    "the city."
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
    parser.add_argument("--apply", action="store_true", help="Actually write to Sweed and page Dave.")
    args = parser.parse_args()

    sweed.switch_to_state_context()

    before_group = sweed.api_call("store.product.group.get", {"id": PREROLL_GROUP_ID})
    before_product = sweed.api_call("store.product.get", {"id": PREROLL_PRODUCT_ID})["product"]
    print("BEFORE preroll group:")
    print(json.dumps(summarize_group(before_group), indent=2))
    print("\nBEFORE preroll variant:")
    print(json.dumps(summarize_product(before_product), indent=2))

    revert_group_params = {
        "id": PREROLL_GROUP_ID,
        "categoryId": PREROLL_CATEGORY_ID,
        "subcategoryId": PREROLL_SUBCATEGORY_ID,
        "description": PREROLL_DESCRIPTION,
        "imagesIds": [],
    }
    revert_product_params = {"id": PREROLL_PRODUCT_ID, "price": PREROLL_ORIGINAL_PRICE}

    new_group_params = {
        "name": VAPE_GROUP_NAME,
        "brandId": HERB_BRAND_ID,
        "categoryId": VAPE_CATEGORY_ID,
        "subcategoryId": VAPE_SUBCATEGORY_ID,
        "strainId": SOUR_DIESEL_STRAIN_ID,
        "description": VAPE_DESCRIPTION,
        "imagesIds": [VAPE_IMAGE_BLOB_ID],
    }

    new_variant_params_template = {
        # productGroupId is filled in after the group is created
        "sizeId": ONE_GRAM_SIZE_ID,
        "price": VAPE_VARIANT_PRICE,
        "tab": VAPE_VARIANT_TAB,
        "displayInEcommerce": VAPE_VARIANT_DISPLAY_IN_ECOMMERCE,
        "isPacked": VAPE_VARIANT_IS_PACKED,
        "packOfSize": VAPE_VARIANT_PACK_OF_SIZE,
    }

    print("\nPLAN:")
    print("  1. group.edit revert:")
    print(json.dumps(revert_group_params, indent=4))
    print("  2. product.edit revert price:")
    print(json.dumps(revert_product_params, indent=4))
    print("  3. group.add new vape group:")
    print(json.dumps(new_group_params, indent=4))
    print("  4. product.add new vape variant (productGroupId resolved at apply):")
    print(json.dumps(new_variant_params_template, indent=4))

    if not args.apply:
        print("\nDry run - pass --apply to write to Sweed.")
        return 0

    print("\nApplying step 1 (revert group 286942 to Pre-Rolls)...")
    sweed.api_call("store.product.group.edit", revert_group_params)
    print("Applying step 2 (revert variant 376985 price to $12.50)...")
    sweed.api_call("store.product.edit", revert_product_params)

    print("Applying step 3 (create new vape group)...")
    new_group_result = sweed.api_call("store.product.group.add", new_group_params)
    new_group_id = new_group_result.get("id") or new_group_result
    if isinstance(new_group_id, dict):
        new_group_id = new_group_id.get("id")
    if not new_group_id:
        print("  ! store.product.group.add did not return an id", file=sys.stderr)
        return 1
    print(f"  -> created vape group id {new_group_id}")

    new_variant_params = {**new_variant_params_template, "productGroupId": new_group_id}
    print("Applying step 4 (create new vape variant)...")
    new_variant_result = sweed.api_call("store.product.add", new_variant_params)
    new_variant_id = new_variant_result.get("id") or new_variant_result
    if isinstance(new_variant_id, dict):
        new_variant_id = new_variant_id.get("id")
    if not new_variant_id:
        print("  ! store.product.add did not return an id", file=sys.stderr)
        return 1
    print(f"  -> created vape variant id {new_variant_id}")

    after_group = sweed.api_call("store.product.group.get", {"id": PREROLL_GROUP_ID})
    after_product = sweed.api_call("store.product.get", {"id": PREROLL_PRODUCT_ID})["product"]
    new_group_after = sweed.api_call("store.product.group.get", {"id": int(new_group_id)})
    new_variant_after = sweed.api_call("store.product.get", {"id": str(new_variant_id)})["product"]

    print("\nAFTER preroll group (reverted):")
    print(json.dumps(summarize_group(after_group), indent=2))
    print("\nAFTER preroll variant (price reverted):")
    print(json.dumps(summarize_product(after_product), indent=2))
    print("\nAFTER new vape group:")
    print(json.dumps(summarize_group(new_group_after), indent=2))
    print("\nAFTER new vape variant:")
    print(json.dumps(summarize_product(new_variant_after), indent=2))

    results_path = WORKDIR / "revert_and_split_results.json"
    results_path.write_text(
        json.dumps(
            {
                "revertedGroup": summarize_group(after_group),
                "revertedVariant": summarize_product(after_product),
                "newVapeGroup": summarize_group(new_group_after),
                "newVapeVariant": summarize_product(new_variant_after),
                "revertGroupParams": revert_group_params,
                "revertVariantParams": revert_product_params,
                "newGroupParams": new_group_params,
                "newVariantParams": new_variant_params,
            },
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    print(f"\nWrote {results_path}")

    page_msg = (
        f"Catalog revert+split done: group 286942 reverted to Pre-Rolls "
        f"(variant 376985 back to ${PREROLL_ORIGINAL_PRICE:.2f}); new vape group "
        f"{new_group_id} + variant {new_variant_id} at ${VAPE_VARIANT_PRICE:.2f}. "
        f"Ready for your Midtown receive-remap."
    )
    try:
        subprocess.run(["page-dave", page_msg], check=True)
        print("Paged Dave.")
    except (FileNotFoundError, subprocess.CalledProcessError) as exc:
        print(f"  ! page-dave failed: {exc}", file=sys.stderr)
        return 1

    return 0


if __name__ == "__main__":
    sys.exit(main())
